package com.droidagent.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
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
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Floating status bubble. Stays on top of other apps so you can see what the agent
 * is doing while it drives the screen. Tap to expand a live panel (overlay.html over SSE).
 *
 * The bubble only polls a tiny plain-text endpoint, so this class needs no JSON parser;
 * everything rich lives in the WebView panel.
 *
 * Toolchain constraint: the d8 build here crashes on javac's synthetic access classes, so
 * every nested class is static with an explicit service reference and nothing it touches
 * on the outer class is private.
 */
public class OverlayService extends Service {
    public static final String ACTION_STOP = "com.droidagent.app.STOP_OVERLAY";
    /** Single-process app, so a static flag is enough for the UI to show the right toggle state. */
    public static boolean isRunning = false;

    static final String CHANNEL_ID = "overlay";
    static final int NOTIF_ID = 42;
    static final String STATUS_URL = "http://127.0.0.1:8787/api/overlay-status";
    static final String PANEL_URL = "http://127.0.0.1:8787/overlay.html";
    static final String LOCAL_PREFIX = "http://127.0.0.1:8787";
    static final long POLL_MS = 2500;
    /** Keep the bubble around briefly after a task ends so the result is still reachable. */
    static final long GRACE_MS = 25000;

    /** Set while the service is alive, so the activity can nudge it on lifecycle changes. */
    public static OverlayService instance;

    static final int COLOR_IDLE = 0xFF4E5F57;
    static final int COLOR_RUN = 0xFF5FD3A6;
    static final int COLOR_WAIT = 0xFFE2B33C;

    WindowManager wm;
    FrameLayout bubble;
    ImageView bubbleIcon;
    GradientDrawable bubbleBg;
    WindowManager.LayoutParams bubbleParams;

    View panel;
    WindowManager.LayoutParams panelParams;
    WebView panelWeb;
    boolean panelOpen = false;

    Handler handler;
    Runnable poller;
    int screenW, screenH, bubbleSize;
    String lastState = "";
    boolean bubbleShown = false;
    long lastBusyAt = 0;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        handler = new Handler(Looper.getMainLooper());
        wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);

        DisplayMetrics dm = getResources().getDisplayMetrics();
        screenW = dm.widthPixels;
        screenH = dm.heightPixels;
        bubbleSize = dp(52);

        startForegroundNotification();
        buildBubble();
        startPolling();
        isRunning = true;
        instance = this;
    }

    /** Called by the activity when the chat comes to the front or leaves it. */
    public static void refresh() {
        OverlayService s = instance;
        if (s != null && s.handler != null) s.handler.post(new Refresh(s));
    }

    public static class Refresh implements Runnable {
        final OverlayService s;

        Refresh(OverlayService s) { this.s = s; }

        @Override
        public void run() { s.applyVisibility(); }
    }

    /**
     * The bubble is for when you can't see the conversation: it appears only while a task is
     * running (or waiting on you) and the chat is off screen, and goes away once you're back.
     */
    void applyVisibility() {
        boolean busy = "RUNNING".equals(lastState) || "WAITING".equals(lastState);
        if (busy) lastBusyAt = System.currentTimeMillis();
        boolean recentlyBusy = System.currentTimeMillis() - lastBusyAt < GRACE_MS;
        boolean want = !MainActivity.chatVisible && (busy || recentlyBusy);

        if (want && !bubbleShown) {
            wm.addView(bubble, bubbleParams);
            bubbleShown = true;
        } else if (!want && bubbleShown) {
            closePanel();
            try { wm.removeView(bubble); } catch (Exception ignored) { }
            bubbleShown = false;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    // ---- notification ----

    void startForegroundNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "悬浮窗", NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        ch.setDescription("显示助手当前动作的悬浮窗");
        nm.createNotificationChannel(ch);

        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(this, 0, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent stopIntent = new Intent(this, OverlayService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification n = new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("助手悬浮窗")
                .setContentText("任务跑到别的应用时会自动浮出进度")
                .setSmallIcon(R.drawable.ic_stat_mark)
                .setContentIntent(openPi)
                .addAction(new Notification.Action.Builder(null, "关闭悬浮窗", stopPi).build())
                .setOngoing(true)
                .build();

        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }

    // ---- bubble ----

    void buildBubble() {
        bubble = new FrameLayout(this);
        bubbleBg = new GradientDrawable();
        bubbleBg.setShape(GradientDrawable.OVAL);
        bubbleBg.setColor(0xF20F3B2D);
        bubbleBg.setStroke(dp(2), COLOR_IDLE);
        bubble.setBackground(bubbleBg);

        bubbleIcon = new ImageView(this);
        bubbleIcon.setImageResource(R.drawable.ic_bubble_mark);
        bubble.addView(bubbleIcon, new FrameLayout.LayoutParams(dp(28), dp(28), Gravity.CENTER));

        bubbleParams = new WindowManager.LayoutParams(
                bubbleSize, bubbleSize,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                PixelFormat.TRANSLUCENT);
        bubbleParams.gravity = Gravity.TOP | Gravity.START;
        bubbleParams.x = screenW - bubbleSize - dp(8);
        bubbleParams.y = screenH / 3;

        bubble.setOnTouchListener(new BubbleTouch(this));
        // Not added to the window manager here — applyVisibility() decides when it belongs on screen.
    }

    /** Drag to move, tap to toggle the panel, release snaps to the nearest edge. */
    public static class BubbleTouch implements View.OnTouchListener {
        final OverlayService s;
        int startX, startY;
        float touchX, touchY;
        long downTime;
        boolean moved;

        BubbleTouch(OverlayService s) { this.s = s; }

        @Override
        public boolean onTouch(View v, MotionEvent e) {
            switch (e.getAction()) {
                case MotionEvent.ACTION_DOWN:
                    startX = s.bubbleParams.x;
                    startY = s.bubbleParams.y;
                    touchX = e.getRawX();
                    touchY = e.getRawY();
                    downTime = System.currentTimeMillis();
                    moved = false;
                    return true;
                case MotionEvent.ACTION_MOVE: {
                    int dx = (int) (e.getRawX() - touchX);
                    int dy = (int) (e.getRawY() - touchY);
                    if (Math.abs(dx) > s.dp(6) || Math.abs(dy) > s.dp(6)) moved = true;
                    if (moved) {
                        s.bubbleParams.x = Math.max(0, Math.min(s.screenW - s.bubbleSize, startX + dx));
                        s.bubbleParams.y = Math.max(0, Math.min(s.screenH - s.bubbleSize, startY + dy));
                        s.wm.updateViewLayout(s.bubble, s.bubbleParams);
                        s.positionPanel();
                    }
                    return true;
                }
                case MotionEvent.ACTION_UP:
                    if (!moved && System.currentTimeMillis() - downTime < 400) {
                        s.togglePanel();
                    } else {
                        s.bubbleParams.x = (s.bubbleParams.x + s.bubbleSize / 2 < s.screenW / 2)
                                ? s.dp(8) : s.screenW - s.bubbleSize - s.dp(8);
                        s.wm.updateViewLayout(s.bubble, s.bubbleParams);
                        s.positionPanel();
                    }
                    return true;
            }
            return false;
        }
    }

    // ---- panel ----

    void togglePanel() {
        if (panelOpen) closePanel();
        else openPanel();
    }

    void openPanel() {
        if (panelOpen) return;

        panelWeb = new WebView(this);
        WebSettings s = panelWeb.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        panelWeb.setBackgroundColor(Color.TRANSPARENT);
        panelWeb.setWebViewClient(new PanelWebViewClient(this));

        GradientDrawable frame = new GradientDrawable();
        frame.setColor(0xFA111A16);
        frame.setCornerRadius(dp(16));
        frame.setStroke(dp(1), 0xFF26332D);

        FrameLayout wrap = new FrameLayout(this);
        wrap.setBackground(frame);
        wrap.setClipToOutline(true);
        wrap.addView(panelWeb, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        panel = wrap;

        panelParams = new WindowManager.LayoutParams(
                Math.min(screenW - dp(24), dp(330)),
                (int) (screenH * 0.52f),
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                PixelFormat.TRANSLUCENT);
        panelParams.gravity = Gravity.TOP | Gravity.START;

        wm.addView(panel, panelParams);
        panelOpen = true;
        positionPanel();
        panelWeb.loadUrl(PANEL_URL);
    }

    /** Keep the panel beside the bubble and fully on screen. */
    void positionPanel() {
        if (!panelOpen || panel == null) return;
        int margin = dp(12);
        panelParams.x = Math.max(margin, Math.min(screenW - panelParams.width - margin,
                bubbleParams.x + bubbleSize / 2 - panelParams.width / 2));
        panelParams.y = Math.max(margin, Math.min(screenH - panelParams.height - margin,
                bubbleParams.y + bubbleSize + dp(8)));
        wm.updateViewLayout(panel, panelParams);
    }

    void closePanel() {
        if (!panelOpen) return;
        panelOpen = false;
        try { wm.removeView(panel); } catch (Exception ignored) { }
        if (panelWeb != null) {
            panelWeb.loadUrl("about:blank");
            panelWeb.destroy();
            panelWeb = null;
        }
        panel = null;
    }

    /** The chat deep-link opens the app; anything off the local server is refused. */
    public static class PanelWebViewClient extends WebViewClient {
        final OverlayService s;

        PanelWebViewClient(OverlayService s) { this.s = s; }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handle(request.getUrl().toString());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handle(url);
        }

        boolean handle(String url) {
            // The page's "打开对话" button asks the host app to come to the front.
            if (url.startsWith("k70u://open-chat")) {
                s.closePanel();
                Intent i = new Intent(s, MainActivity.class);
                i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                s.startActivity(i);
                return true;
            }
            return !url.startsWith(LOCAL_PREFIX);
        }
    }

    // ---- status polling ----

    void startPolling() {
        poller = new Poller(this);
        handler.post(poller);
    }

    public static class Poller implements Runnable {
        final OverlayService s;

        Poller(OverlayService s) { this.s = s; }

        @Override
        public void run() {
            new Thread(new StatusFetch(s)).start();
            s.handler.postDelayed(this, POLL_MS);
        }
    }

    public static class StatusFetch implements Runnable {
        final OverlayService s;

        StatusFetch(OverlayService s) { this.s = s; }

        @Override
        public void run() {
            String line;
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(STATUS_URL).openConnection();
                c.setConnectTimeout(2000);
                c.setReadTimeout(2000);
                BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
                line = r.readLine();
                r.close();
            } catch (Exception e) {
                line = null;
            } finally {
                if (c != null) c.disconnect();
            }
            String state = (line == null) ? "DOWN" : line.split("\t", -1)[0];
            s.handler.post(new ApplyState(s, state));
        }
    }

    public static class ApplyState implements Runnable {
        final OverlayService s;
        final String state;

        ApplyState(OverlayService s, String state) {
            this.s = s;
            this.state = state;
        }

        @Override
        public void run() { s.applyState(state); }
    }

    void applyState(String state) {
        if (!state.equals(lastState)) {
            lastState = state;
            int color = "RUNNING".equals(state) ? COLOR_RUN : "WAITING".equals(state) ? COLOR_WAIT : COLOR_IDLE;
            bubbleBg.setStroke(dp(2), color);
            bubbleIcon.setAlpha("DOWN".equals(state) ? 0.4f : 1f);
        }
        applyVisibility();
    }

    @Override
    public void onDestroy() {
        isRunning = false;
        instance = null;
        if (handler != null && poller != null) handler.removeCallbacks(poller);
        closePanel();
        if (bubble != null) {
            if (bubbleShown) {
                try { wm.removeView(bubble); } catch (Exception ignored) { }
                bubbleShown = false;
            }
            bubble = null;
        }
        super.onDestroy();
    }

    /** Whether the user has granted "draw over other apps". */
    public static boolean canDraw(Context ctx) {
        return Settings.canDrawOverlays(ctx);
    }

    public static Intent permissionIntent(Context ctx) {
        return new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + ctx.getPackageName()));
    }
}
