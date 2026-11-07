package com.droidagent.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.SurfaceControl;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.lang.reflect.Method;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * The floating assistant: a small face that shows up while a task runs and the chat isn't on
 * screen, so you can follow the work in other apps. Tap it for a panel with what it is doing
 * (overlay.html, kept alive between openings); tap outside the panel, or its ×, to fold it.
 * Drag it onto the × at the bottom to put it away until the task ends.
 *
 * It keeps out of the agent's way: droid (in the chroot, as root) broadcasts ACTION_HIDE around
 * its screenshots and taps, and reads where the windows are from overlay.state. Each window also
 * asks the system to leave it out of screenshots, which works where the platform allows it.
 *
 * Toolchain constraint: the d8 build here crashes on javac's synthetic access classes, so every
 * nested class is static with an explicit service reference, there are no lambdas or anonymous
 * classes, and nothing they touch on the outer class is private.
 */
public class OverlayService extends Service {
    public static final String ACTION_DISMISS = "com.droidagent.app.DISMISS_OVERLAY";
    /** From droid, as root: hide (extra "hide", default true) for at most extra "ms" milliseconds. */
    public static final String ACTION_HIDE = "com.droidagent.app.OVERLAY_HIDE";
    /** Single-process app, so a static flag is enough for the activity to know. */
    public static boolean isRunning = false;
    /** Set while the service is alive, so the activity can nudge it on lifecycle changes. */
    public static OverlayService instance;

    static final String CHANNEL_ID = "overlay";
    static final int NOTIF_ID = 42;
    static final String BASE = "http://127.0.0.1:8787";
    static final String STATUS_URL = BASE + "/api/overlay-status";
    static final String PANEL_URL = BASE + "/overlay.html";
    static final String PREFS = "droidagent";
    static final long POLL_MS = 1500;
    /** After a task ends the face says "done" for this long, then goes. */
    static final long DONE_MS = 6000;
    static final long BLINK_EVERY_MS = 3600;

    static final int RING_IDLE = 0x804E5F57;
    static final int RING_RUN = 0xFF5FD3A6;
    static final int RING_WAIT = 0xFFE9B949;
    static final int RING_DONE = 0xE6F4F1E8;

    WindowManager wm;
    Handler handler;
    SharedPreferences prefs;
    File stateFile;
    int screenW, screenH, bubbleSize, pad;

    // the face
    FrameLayout bubble;
    ImageView face;
    GradientDrawable disc;
    WindowManager.LayoutParams bubbleParams;
    boolean bubbleShown = false;

    // the panel
    PanelFrame panel;
    WebView panelWeb;
    WindowManager.LayoutParams panelParams;
    boolean panelOpen = false;
    boolean panelAttached = false;
    boolean panelNeedsReload = false;
    long panelClosedAt = 0;

    // the drop target that puts the face away
    FrameLayout target;
    GradientDrawable targetBg;
    WindowManager.LayoutParams targetParams;
    boolean targetShown = false;
    boolean overTarget = false;

    String status = "";
    boolean busy = false;
    long lastBusyAt = 0;
    /** Put away by the owner: stays away until the next task starts. */
    boolean dismissed = false;
    /** Hidden around one of the agent's screenshots or taps. */
    boolean capturing = false;
    String skipResult = "not tried";

    Runnable poller, blinker, restorer;
    BroadcastReceiver receiver;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        handler = new Handler(Looper.getMainLooper());
        wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        stateFile = new File(createDeviceProtectedStorageContext().getDataDir(), "overlay.state");
        measure();
        bubbleSize = dp(54);
        pad = dp(10);

        startForegroundNotification();
        buildBubble();
        buildTarget();

        receiver = new Receiver(this);
        IntentFilter f = new IntentFilter(ACTION_HIDE);
        // Only senders holding DUMP (shell, root, system) may hide the face.
        registerReceiver(receiver, f, "android.permission.DUMP", null);

        poller = new Poller(this);
        handler.post(poller);
        blinker = new Blink(this, false);
        handler.postDelayed(blinker, BLINK_EVERY_MS);
        restorer = new Restore(this);

        isRunning = true;
        instance = this;
        writeState();
    }

    @SuppressWarnings("deprecation")
    void measure() {
        DisplayMetrics dm = new DisplayMetrics();
        wm.getDefaultDisplay().getRealMetrics(dm);
        screenW = dm.widthPixels;
        screenH = dm.heightPixels;
    }

    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        measure();
        if (bubbleParams != null) {
            clampBubble();
            if (bubbleShown) wm.updateViewLayout(bubble, bubbleParams);
        }
        if (panelOpen) positionPanel();
        writeState();
    }

    /** Called by the activity when the chat comes to the front or leaves it. */
    public static void refresh() {
        OverlayService s = instance;
        if (s != null && s.handler != null) s.handler.post(new Refresh(s));
    }

    public static class Refresh implements Runnable {
        final OverlayService s;
        Refresh(OverlayService s) { this.s = s; }
        @Override public void run() { s.applyVisibility(); }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_DISMISS.equals(intent.getAction())) dismissForTask();
        return START_STICKY;
    }

    int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    // ------------------------------------------------------------------ when it is on screen

    /**
     * There while a task runs or waits on you and the conversation isn't on screen; for a few
     * seconds after it ends, to say so; and as long as the panel is open. Never otherwise.
     */
    void applyVisibility() {
        long now = System.currentTimeMillis();
        boolean justDone = !busy && lastBusyAt > 0 && now - lastBusyAt < DONE_MS;
        boolean want = !MainActivity.chatVisible && !dismissed && (busy || justDone || panelOpen);
        if (want && !bubbleShown) showBubble();
        else if (!want && bubbleShown) hideBubble(false);
        paint();
    }

    void applyStatus(String st) {
        boolean was = busy;
        busy = "RUNNING".equals(st) || "WAITING".equals(st);
        if (busy) lastBusyAt = System.currentTimeMillis();
        if (busy && !was) dismissed = false; // a new task: the face may come back
        status = st;
        applyVisibility();
    }

    /** The ring says what is going on: green working, amber waiting on you, light when just done. */
    void paint() {
        if (disc == null) return;
        boolean justDone = !busy && lastBusyAt > 0 && System.currentTimeMillis() - lastBusyAt < DONE_MS;
        int ring = "WAITING".equals(status) ? RING_WAIT : busy ? RING_RUN : justDone ? RING_DONE : RING_IDLE;
        disc.setStroke(dp(3), ring);
        face.setAlpha("DOWN".equals(status) ? 0.45f : 1f);
    }

    // ------------------------------------------------------------------ the face

    void buildBubble() {
        bubble = new FrameLayout(this);
        View body = new View(this);
        disc = new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[]{0xFF1F6B51, 0xFF0D3527});
        disc.setShape(GradientDrawable.OVAL);
        disc.setStroke(dp(3), RING_IDLE);
        body.setBackground(disc);
        body.setElevation(dp(5));
        bubble.addView(body, new FrameLayout.LayoutParams(bubbleSize, bubbleSize, Gravity.CENTER));
        face = new ImageView(this);
        face.setImageResource(R.drawable.ic_bubble_mark);
        face.setElevation(dp(5));
        bubble.addView(face, new FrameLayout.LayoutParams(dp(34), dp(34), Gravity.CENTER));

        int win = bubbleSize + 2 * pad; // room for the shadow
        bubbleParams = new WindowManager.LayoutParams(win, win,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                PixelFormat.TRANSLUCENT);
        bubbleParams.gravity = Gravity.TOP | Gravity.START;
        boolean left = prefs.getBoolean("bubble_left", false);
        bubbleParams.x = left ? dp(4) - pad : screenW - bubbleSize - dp(4) - pad;
        bubbleParams.y = (int) (screenH * prefs.getFloat("bubble_y", 0.32f));
        clampBubble();
        bubble.setOnTouchListener(new BubbleTouch(this));
    }

    void clampBubble() {
        bubbleParams.x = Math.max(-pad, Math.min(screenW - bubbleSize - pad, bubbleParams.x));
        bubbleParams.y = Math.max(dp(24) - pad, Math.min(screenH - bubbleSize - dp(24) - pad, bubbleParams.y));
    }

    void showBubble() {
        bubble.animate().cancel();
        if (bubble.isAttachedToWindow()) { // still fading out: just come back
            bubbleShown = true;
            bubble.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(150).start();
            writeState();
            return;
        }
        try {
            bubble.setAlpha(0f);
            bubble.setScaleX(0.6f);
            bubble.setScaleY(0.6f);
            bubble.setVisibility(capturing ? View.INVISIBLE : View.VISIBLE);
            setTouchable(bubbleParams, !capturing);
            wm.addView(bubble, bubbleParams);
            bubbleShown = true;
            bubble.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(180).start();
            leaveOutOfScreenshots(bubble);
        } catch (Exception e) {
            bubbleShown = false;
        }
        writeState();
    }

    void hideBubble(boolean animated) {
        closePanel(false);
        if (!bubbleShown) return;
        bubbleShown = false;
        if (animated) {
            bubble.animate().alpha(0f).scaleX(0.4f).scaleY(0.4f).setDuration(160).withEndAction(new Detach(this, bubble)).start();
        } else {
            try { wm.removeView(bubble); } catch (Exception ignored) { }
        }
        writeState();
    }

    public static class Detach implements Runnable {
        final OverlayService s;
        final View v;
        Detach(OverlayService s, View v) { this.s = s; this.v = v; }
        @Override public void run() {
            if (v == s.bubble && s.bubbleShown) return; // shown again meanwhile
            if (v == s.panel && s.panelOpen) return;
            try { s.wm.removeView(v); } catch (Exception ignored) { }
            if (v == s.panel) s.panelAttached = false;
        }
    }

    /** The face blinks now and then while it works. */
    public static class Blink implements Runnable {
        final OverlayService s;
        final boolean open;
        Blink(OverlayService s, boolean open) { this.s = s; this.open = open; }
        @Override public void run() {
            if (open) {
                s.face.setImageResource(R.drawable.ic_bubble_mark);
                return;
            }
            if (s.bubbleShown && s.busy) {
                s.face.setImageResource(R.drawable.ic_bubble_blink);
                s.handler.postDelayed(new Blink(s, true), 140);
            }
            s.handler.postDelayed(this, BLINK_EVERY_MS + (long) (Math.random() * 1600));
        }
    }

    /** Drag to move, tap for the panel, let go to settle on the nearer edge or onto the ×. */
    public static class BubbleTouch implements View.OnTouchListener {
        final OverlayService s;
        int startX, startY;
        float touchX, touchY;
        long downAt;
        boolean moved;

        BubbleTouch(OverlayService s) { this.s = s; }

        @Override
        public boolean onTouch(View v, MotionEvent e) {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    startX = s.bubbleParams.x;
                    startY = s.bubbleParams.y;
                    touchX = e.getRawX();
                    touchY = e.getRawY();
                    downAt = System.currentTimeMillis();
                    moved = false;
                    s.bubble.animate().scaleX(0.92f).scaleY(0.92f).setDuration(90).start();
                    return true;
                case MotionEvent.ACTION_MOVE: {
                    int dx = (int) (e.getRawX() - touchX);
                    int dy = (int) (e.getRawY() - touchY);
                    if (!moved && (Math.abs(dx) > s.dp(8) || Math.abs(dy) > s.dp(8))) {
                        moved = true;
                        s.closePanel(true);
                        s.showTarget();
                    }
                    if (moved) {
                        s.bubbleParams.x = startX + dx;
                        s.bubbleParams.y = startY + dy;
                        s.clampBubble();
                        s.wm.updateViewLayout(s.bubble, s.bubbleParams);
                        s.trackTarget();
                    }
                    return true;
                }
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    s.bubble.animate().scaleX(1f).scaleY(1f).setDuration(90).start();
                    if (!moved) {
                        if (e.getActionMasked() == MotionEvent.ACTION_UP
                                && System.currentTimeMillis() - downAt < 450) s.onBubbleTap();
                        return true;
                    }
                    boolean drop = s.overTarget;
                    s.hideTarget();
                    if (drop) s.dismissForTask();
                    else s.settle();
                    return true;
            }
            return false;
        }
    }

    void onBubbleTap() {
        // The same tap that just folded the panel by landing outside it must not open it again.
        if (System.currentTimeMillis() - panelClosedAt < 400) return;
        if (panelOpen) foldPanel();
        else openPanel();
    }

    /** Glide to the nearer side and remember where it was put. */
    void settle() {
        int center = bubbleParams.x + pad + bubbleSize / 2;
        boolean left = center < screenW / 2;
        int to = left ? dp(4) - pad : screenW - bubbleSize - dp(4) - pad;
        new Glide(this, bubbleParams.x, to).start();
        prefs.edit().putBoolean("bubble_left", left).putFloat("bubble_y", bubbleParams.y / (float) screenH).apply();
    }

    public static class Glide implements Runnable {
        final OverlayService s;
        final int from, to;
        final long start;
        Glide(OverlayService s, int from, int to) { this.s = s; this.from = from; this.to = to; this.start = System.currentTimeMillis(); }
        void start() { s.handler.post(this); }
        @Override public void run() {
            if (!s.bubbleShown) return;
            float t = Math.min(1f, (System.currentTimeMillis() - start) / 220f);
            float ease = 1f - (1f - t) * (1f - t) * (1f - t);
            s.bubbleParams.x = (int) (from + (to - from) * ease);
            try { s.wm.updateViewLayout(s.bubble, s.bubbleParams); } catch (Exception ignored) { return; }
            if (t < 1f) s.handler.postDelayed(this, 16);
            else s.writeState();
        }
    }

    /** Put away until the next task, by dragging it onto the × or from the notification. */
    void dismissForTask() {
        if (dismissed) return;
        dismissed = true;
        hideBubble(true);
        Toast.makeText(this, "这次任务结束前不再显示悬浮窗", Toast.LENGTH_SHORT).show();
    }

    // ------------------------------------------------------------------ the × drop target

    void buildTarget() {
        target = new FrameLayout(this);
        View ring = new View(this);
        targetBg = new GradientDrawable();
        targetBg.setShape(GradientDrawable.OVAL);
        targetBg.setColor(0xCC1A1F1C);
        targetBg.setStroke(dp(2), 0x55FFFFFF);
        ring.setBackground(targetBg);
        target.addView(ring, new FrameLayout.LayoutParams(dp(60), dp(60), Gravity.CENTER));
        ImageView x = new ImageView(this);
        x.setImageResource(R.drawable.ic_overlay_close);
        target.addView(x, new FrameLayout.LayoutParams(dp(26), dp(26), Gravity.CENTER));
        targetParams = new WindowManager.LayoutParams(dp(84), dp(84),
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        targetParams.gravity = Gravity.TOP | Gravity.START;
    }

    void showTarget() {
        if (targetShown) return;
        targetParams.x = (screenW - targetParams.width) / 2;
        targetParams.y = screenH - targetParams.height - dp(56);
        try {
            target.setAlpha(0f);
            wm.addView(target, targetParams);
            targetShown = true;
            target.animate().alpha(1f).setDuration(150).start();
            leaveOutOfScreenshots(target);
        } catch (Exception ignored) { }
        overTarget = false;
    }

    void trackTarget() {
        if (!targetShown) return;
        float bx = bubbleParams.x + pad + bubbleSize / 2f, by = bubbleParams.y + pad + bubbleSize / 2f;
        float tx = targetParams.x + targetParams.width / 2f, ty = targetParams.y + targetParams.height / 2f;
        boolean over = Math.hypot(bx - tx, by - ty) < dp(70);
        if (over != overTarget) {
            overTarget = over;
            target.animate().scaleX(over ? 1.22f : 1f).scaleY(over ? 1.22f : 1f).setDuration(120).start();
            targetBg.setColor(over ? 0xEEB84A40 : 0xCC1A1F1C);
            if (over) bubble.performHapticFeedback(android.view.HapticFeedbackConstants.VIRTUAL_KEY);
        }
    }

    void hideTarget() {
        if (!targetShown) return;
        targetShown = false;
        try { wm.removeView(target); } catch (Exception ignored) { }
        target.setScaleX(1f);
        target.setScaleY(1f);
        targetBg.setColor(0xCC1A1F1C);
    }

    // ------------------------------------------------------------------ the panel

    /** Folds itself when you touch anywhere outside it. */
    public static class PanelFrame extends FrameLayout {
        final OverlayService s;
        PanelFrame(OverlayService s) { super(s); this.s = s; }
        @Override
        public boolean dispatchTouchEvent(MotionEvent e) {
            if (e.getActionMasked() == MotionEvent.ACTION_OUTSIDE) {
                s.foldPanel();
                return true;
            }
            return super.dispatchTouchEvent(e);
        }
    }

    /** Made once and kept: reopening shows the same page at once, history and all. */
    void buildPanel() {
        panelWeb = new WebView(this);
        WebSettings ws = panelWeb.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        panelWeb.setBackgroundColor(Color.TRANSPARENT);
        panelWeb.setWebViewClient(new PanelClient(this));
        panelWeb.loadUrl(PANEL_URL);

        GradientDrawable frame = new GradientDrawable();
        frame.setColor(0xFA101815);
        frame.setCornerRadius(dp(20));
        frame.setStroke(dp(1), 0xFF26332D);
        panel = new PanelFrame(this);
        panel.setBackground(frame);
        panel.setClipToOutline(true);
        panel.addView(panelWeb, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        panelParams = new WindowManager.LayoutParams(10, 10,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
                        | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                PixelFormat.TRANSLUCENT);
        panelParams.gravity = Gravity.TOP | Gravity.START;
    }

    void openPanel() {
        if (panelOpen || !bubbleShown) return;
        if (panel == null) buildPanel();
        else if (panelNeedsReload) { panelNeedsReload = false; panelWeb.loadUrl(PANEL_URL); }
        else panelWeb.evaluateJavascript("window.panelShown && window.panelShown()", null);
        panelOpen = true;
        positionPanel();
        try {
            if (!panelAttached) {
                setTouchable(panelParams, !capturing);
                panel.setVisibility(capturing ? View.INVISIBLE : View.VISIBLE);
                wm.addView(panel, panelParams);
                panelAttached = true;
                leaveOutOfScreenshots(panel);
            } else {
                wm.updateViewLayout(panel, panelParams);
            }
        } catch (Exception e) {
            panelOpen = false;
            return;
        }
        panel.animate().cancel();
        panel.setAlpha(0f);
        panel.setScaleX(0.94f);
        panel.setScaleY(0.94f);
        panel.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(170).start();
        writeState();
    }

    /** Beside the face, on its side of the screen, below it if there's room and above if not. */
    void positionPanel() {
        int margin = dp(12);
        panelParams.width = Math.min(screenW - 2 * margin, dp(348));
        panelParams.height = Math.min((int) (screenH * 0.62f), dp(560));
        int bx = bubbleParams.x + pad, by = bubbleParams.y + pad;
        boolean onLeft = bx + bubbleSize / 2 < screenW / 2;
        panelParams.x = onLeft ? margin : screenW - panelParams.width - margin;
        int below = by + bubbleSize + dp(8);
        int above = by - panelParams.height - dp(8);
        panelParams.y = below + panelParams.height <= screenH - margin ? below : Math.max(margin, above);
        if (panel != null) {
            panel.setPivotX(onLeft ? 0 : panelParams.width);
            panel.setPivotY(panelParams.y >= by ? 0 : panelParams.height);
            if (panelAttached) try { wm.updateViewLayout(panel, panelParams); } catch (Exception ignored) { }
        }
    }

    void closePanel(boolean animated) {
        if (!panelOpen) return;
        panelOpen = false;
        panelClosedAt = System.currentTimeMillis();
        if (animated) {
            panel.animate().cancel();
            panel.animate().alpha(0f).scaleX(0.94f).scaleY(0.94f).setDuration(140).withEndAction(new Detach(this, panel)).start();
        } else {
            try { wm.removeView(panel); } catch (Exception ignored) { }
            panelAttached = false;
        }
        writeState();
    }

    /** Folded by the owner: if the task ended while they read, the face goes too. */
    void foldPanel() {
        closePanel(true);
        applyVisibility();
    }

    /** The page's buttons ask for these; nothing beyond the local server is loaded. */
    public static class PanelClient extends WebViewClient {
        final OverlayService s;
        PanelClient(OverlayService s) { this.s = s; }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handle(request.getUrl().toString());
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) { return handle(url); }

        boolean handle(String url) {
            if (url.startsWith("k70u://close-panel")) {
                s.foldPanel();
                return true;
            }
            if (url.startsWith("k70u://open-chat")) {
                s.closePanel(false);
                Intent i = new Intent(s, MainActivity.class);
                i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
                s.startActivity(i);
                return true;
            }
            return !url.startsWith(BASE);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request != null && request.isForMainFrame()) s.panelNeedsReload = true; // server was down: try again next time
        }
    }

    // ------------------------------------------------------------------ out of the agent's way

    public static class Receiver extends BroadcastReceiver {
        final OverlayService s;
        Receiver(OverlayService s) { this.s = s; }
        @Override
        public void onReceive(Context c, Intent i) {
            s.setCapturing(i.getBooleanExtra("hide", true), i.getLongExtra("ms", 4000));
        }
    }

    /** Hidden and untouchable while the agent takes a screenshot or taps where the face is. */
    void setCapturing(boolean hide, long ms) {
        handler.removeCallbacks(restorer);
        capturing = hide;
        int vis = hide ? View.INVISIBLE : View.VISIBLE;
        if (bubbleShown) { bubble.setVisibility(vis); setTouchable(bubbleParams, !hide); update(bubble, bubbleParams); }
        if (panelAttached) { panel.setVisibility(vis); setTouchable(panelParams, !hide); update(panel, panelParams); }
        if (targetShown && hide) hideTarget();
        if (hide) handler.postDelayed(restorer, Math.max(500, Math.min(ms, 15000))); // never stuck hidden
        writeState();
    }

    public static class Restore implements Runnable {
        final OverlayService s;
        Restore(OverlayService s) { this.s = s; }
        @Override public void run() { s.setCapturing(false, 0); }
    }

    void update(View v, WindowManager.LayoutParams p) {
        try { wm.updateViewLayout(v, p); } catch (Exception ignored) { }
    }

    static void setTouchable(WindowManager.LayoutParams p, boolean on) {
        if (on) p.flags &= ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        else p.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
    }

    /**
     * Ask the system to leave a window out of screenshots, as it does for its own floating windows.
     * There is no public API for this: it goes through hidden methods, which a phone may refuse.
     * Whatever happens is recorded in overlay.state; droid hides the windows around its own
     * screenshots either way.
     */
    void leaveOutOfScreenshots(View v) {
        if (Build.VERSION.SDK_INT < 31) { skipResult = "needs Android 12"; return; }
        handler.postDelayed(new SkipScreenshot(this, v), 250); // its surface exists after the first layout
    }

    public static class SkipScreenshot implements Runnable {
        final OverlayService s;
        final View v;
        SkipScreenshot(OverlayService s, View v) { this.s = s; this.v = v; }

        @Override
        public void run() {
            try {
                apply(v);
                s.skipResult = "ok";
            } catch (Throwable first) {
                try {
                    exemptHiddenApis();
                    apply(v);
                    s.skipResult = "ok after exemption";
                } catch (Throwable e) {
                    Throwable c = e.getCause() != null ? e.getCause() : e;
                    s.skipResult = c.getClass().getSimpleName() + ": " + c.getMessage();
                }
            }
            s.writeState();
        }

        static void apply(View v) throws Exception {
            Object root = v.getRootSurfaceControl();
            if (root == null) throw new IllegalStateException("not attached");
            Method get = root.getClass().getMethod("getSurfaceControl");
            SurfaceControl sc = (SurfaceControl) get.invoke(root);
            if (sc == null || !sc.isValid()) throw new IllegalStateException("no surface yet");
            SurfaceControl.Transaction t = new SurfaceControl.Transaction();
            Method skip = SurfaceControl.Transaction.class.getMethod("setSkipScreenshot", SurfaceControl.class, boolean.class);
            skip.invoke(t, sc, true);
            t.apply();
        }

        /** The usual way past the hidden-API list: VMRuntime reached through reflection itself. */
        static void exemptHiddenApis() throws Exception {
            Method forName = Class.class.getDeclaredMethod("forName", String.class);
            Method getDeclared = Class.class.getDeclaredMethod("getDeclaredMethod", String.class, Class[].class);
            Class<?> vm = (Class<?>) forName.invoke(null, "dalvik.system.VMRuntime");
            Method getRuntime = (Method) getDeclared.invoke(vm, "getRuntime", null);
            Method exempt = (Method) getDeclared.invoke(vm, "setHiddenApiExemptions", new Object[]{new Class[]{String[].class}});
            exempt.invoke(getRuntime.invoke(null), new Object[]{new String[]{"L"}});
        }
    }

    /**
     * Where the windows are, for droid: it hides them around a screenshot, or a tap that would
     * land on them. In the app's own data directory, which the chroot sees under /data.
     */
    void writeState() {
        StringBuilder b = new StringBuilder();
        int bx = bubbleParams == null ? 0 : bubbleParams.x + pad, by = bubbleParams == null ? 0 : bubbleParams.y + pad;
        b.append("bubble ").append(bubbleShown && !capturing ? 1 : 0).append(' ')
                .append(bx).append(' ').append(by).append(' ').append(bubbleSize).append(' ').append(bubbleSize).append('\n');
        if (panelParams != null) {
            b.append("panel ").append(panelOpen && !capturing ? 1 : 0).append(' ')
                    .append(panelParams.x).append(' ').append(panelParams.y).append(' ')
                    .append(panelParams.width).append(' ').append(panelParams.height).append('\n');
        } else {
            b.append("panel 0 0 0 0 0\n");
        }
        b.append("skip ").append(skipResult.replace('\n', ' ')).append('\n');
        try {
            FileOutputStream o = new FileOutputStream(stateFile);
            o.write(b.toString().getBytes("UTF-8"));
            o.close();
        } catch (Exception ignored) { }
    }

    // ------------------------------------------------------------------ notification

    void startForegroundNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "悬浮窗", NotificationManager.IMPORTANCE_MIN);
        ch.setShowBadge(false);
        ch.setDescription("助手在其他应用里工作时显示进度");
        nm.createNotificationChannel(ch);

        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(this, 0, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent dismissIntent = new Intent(this, OverlayService.class).setAction(ACTION_DISMISS);
        PendingIntent dismissPi = PendingIntent.getService(this, 1, dismissIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification n = new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("DroidAgent 悬浮窗")
                .setContentText("助手跳到其他应用工作时，会在屏幕边上显示进度")
                .setSmallIcon(R.drawable.ic_stat_mark)
                .setContentIntent(openPi)
                .addAction(new Notification.Action.Builder(null, "这次任务不显示", dismissPi).build())
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTIF_ID, n);
    }

    // ------------------------------------------------------------------ status polling

    public static class Poller implements Runnable {
        final OverlayService s;
        Poller(OverlayService s) { this.s = s; }
        @Override public void run() {
            new Thread(new StatusFetch(s)).start();
            s.handler.postDelayed(this, POLL_MS);
        }
    }

    public static class StatusFetch implements Runnable {
        final OverlayService s;
        StatusFetch(OverlayService s) { this.s = s; }
        @Override public void run() {
            String line;
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(STATUS_URL).openConnection();
                c.setConnectTimeout(1500);
                c.setReadTimeout(1500);
                BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
                line = r.readLine();
                r.close();
            } catch (Exception e) {
                line = null;
            } finally {
                if (c != null) c.disconnect();
            }
            String st = line == null ? "DOWN" : line.split("\t", -1)[0];
            s.handler.post(new ApplyStatus(s, st));
        }
    }

    public static class ApplyStatus implements Runnable {
        final OverlayService s;
        final String st;
        ApplyStatus(OverlayService s, String st) { this.s = s; this.st = st; }
        @Override public void run() { s.applyStatus(st); }
    }

    @Override
    public void onDestroy() {
        isRunning = false;
        instance = null;
        handler.removeCallbacksAndMessages(null);
        try { unregisterReceiver(receiver); } catch (Exception ignored) { }
        hideTarget();
        closePanel(false);
        if (bubbleShown) {
            bubbleShown = false;
            try { wm.removeView(bubble); } catch (Exception ignored) { }
        }
        if (panelWeb != null) {
            panelWeb.destroy();
            panelWeb = null;
        }
        writeState();
        super.onDestroy();
    }

    /** Whether the user has granted "draw over other apps". */
    public static boolean canDraw(Context ctx) {
        return Settings.canDrawOverlays(ctx);
    }

    public static Intent permissionIntent(Context ctx) {
        return new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + ctx.getPackageName()));
    }
}
