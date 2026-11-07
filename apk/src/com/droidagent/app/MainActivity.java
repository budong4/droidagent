package com.droidagent.app;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.res.AssetFileDescriptor;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.StatFs;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayDeque;
import java.util.concurrent.TimeUnit;

/**
 * Hosts the chat app (served by the Node backend inside the Debian chroot) in a WebView, and gets
 * that backend running first.
 *
 * Every launch goes through {@link BootRunnable}: if the backend already answers and nothing in
 * the APK changed since it was last synced, the chat loads straight away. Otherwise a local setup
 * page (assets/setup/index.html) is shown while root is requested, the Linux system carried in
 * the APK is unpacked (first run only, with byte-accurate progress), the launcher and chat app
 * are synced from the APK, and the backend is started. The setup page polls {@link #setup} through
 * the AgentHost bridge, so there is no ordering problem between the page loading and the work.
 */
public class MainActivity extends Activity {
    static final String APP_URL = "http://127.0.0.1:8787/";
    static final String PING_URL = "http://127.0.0.1:8787/manifest.webmanifest";
    static final String SETUP_URL = "file:///android_asset/setup/index.html";
    private static final int FILE_CHOOSER_REQUEST = 1001;

    /** The Linux system lives in this app's own device-encrypted storage. Paths are derived
     *  from the package at runtime (set in onCreate), so nothing hard-codes the package name. */
    static String APK_DIR;   // /data/user_de/0/<pkg>
    static String ROOTFS;    // APK_DIR + "/rootfs"

    static final String PREFS = "droidagent";
    static final String KEY_OVERLAY = "overlay_enabled";
    static final String KEY_ASKED = "overlay_permission_asked";
    /** Build of the APK whose launcher + chat app were last synced into the chroot. */
    static final String KEY_SYNCED = "synced_build";

    /** True while the conversation is actually on screen; the bubble stays away when it is. */
    public static volatile boolean chatVisible = false;

    WebView webView;
    ValueCallback<Uri[]> filePathCallback;
    Handler mainHandler;
    final SetupState setup = new SetupState();
    /** Set once the chat app itself has loaded; the overlay permission is asked only after that,
     *  so a first run isn't interrupted by a settings screen in the middle of unpacking. */
    volatile boolean appShown = false;
    private boolean booting = false;
    /** Consecutive times the chat failed to load right after a boot said it was up. */
    int loadFailures = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        APK_DIR = createDeviceProtectedStorageContext().getDataDir().getAbsolutePath();
        ROOTFS = APK_DIR + "/rootfs";

        mainHandler = new Handler(Looper.getMainLooper());
        webView = (WebView) findViewById(R.id.webview);
        initWebView();
        webView.loadUrl(SETUP_URL);
        startBoot();
    }

    @Override
    protected void onStart() {
        super.onStart();
        chatVisible = true;
        OverlayService.refresh();
    }

    @Override
    protected void onStop() {
        super.onStop();
        chatVisible = false;
        OverlayService.refresh();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // The bubble is meant to just be there, so set it up on its own rather than
        // waiting for the user to find a switch. Permission is asked for once.
        if (appShown) ensureOverlay();
    }

    void ensureOverlay() {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (!prefs.getBoolean(KEY_OVERLAY, true)) return;

        if (!OverlayService.canDraw(this) || !notificationsAllowed()) {
            // This app has root: grant itself both permissions instead of sending the owner to
            // settings. Only if that fails does it ask, once.
            if (!granting) {
                granting = true;
                new Thread(new GrantTask(this), "grant").start();
            }
            return;
        }
        if (!OverlayService.isRunning) {
            startForegroundService(new Intent(this, OverlayService.class));
        }
    }

    boolean granting = false;

    boolean notificationsAllowed() {
        return Build.VERSION.SDK_INT < 33 || checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    /** After the root grant: start the bubble, or fall back to asking. */
    void afterGrant() {
        granting = false;
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (!OverlayService.canDraw(this)) {
            if (!prefs.getBoolean(KEY_ASKED, false)) {
                prefs.edit().putBoolean(KEY_ASKED, true).apply();
                Toast.makeText(this, "请允许「显示在其他应用上层」，这样助手跳到别的应用时你也能看到进度",
                        Toast.LENGTH_LONG).show();
                startActivity(OverlayService.permissionIntent(this));
            }
            return;
        }
        if (!notificationsAllowed()) {
            requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 1002);
        }
        if (!OverlayService.isRunning) {
            startForegroundService(new Intent(this, OverlayService.class));
        }
    }

    public static class GrantTask implements Runnable {
        final MainActivity a;
        GrantTask(MainActivity a) { this.a = a; }
        @Override
        public void run() {
            String pkg = a.getPackageName();
            Su.run("appops set " + pkg + " SYSTEM_ALERT_WINDOW allow; "
                    + "pm grant " + pkg + " android.permission.POST_NOTIFICATIONS 2>/dev/null; true", 20);
            a.runOnUiThread(new UiTask(a, UiTask.AFTER_GRANT));
        }
    }

    @SuppressWarnings("deprecation")
    private void initWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        // The pages theme themselves (via AgentHost.isNight); never let WebView repaint them.
        if (Build.VERSION.SDK_INT >= 29) s.setForceDark(WebSettings.FORCE_DARK_OFF);

        WebView.setWebContentsDebuggingEnabled(true);

        webView.setWebViewClient(new AgentWebViewClient(this));
        webView.setWebChromeClient(new AgentWebChromeClient(this));
        // Only ever loads our own setup page and http://127.0.0.1:8787 (other URLs are handed to
        // an external browser), so this bridge is reachable only from our own local pages.
        webView.addJavascriptInterface(new HostBridge(this), "AgentHost");
    }

    // ------------------------------------------------------------------ boot

    synchronized void startBoot() {
        if (booting) return;
        booting = true;
        new Thread(new BootRunnable(this), "boot").start();
    }

    synchronized void bootFinished() { booting = false; }

    /** Identifies this exact APK build; a change means the launcher + chat app need re-syncing. */
    @SuppressWarnings("deprecation")
    String buildStamp() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            // versionCode, not getLongVersionCode(): that one needs API 28 and minSdk is 26.
            return pi.versionName + "/" + pi.versionCode + "/" + pi.lastUpdateTime;
        } catch (Exception e) {
            return "unknown";
        }
    }

    String deFilesDir() {
        return createDeviceProtectedStorageContext().getFilesDir().getAbsolutePath();
    }

    /** Copies an asset to the device-encrypted files dir (readable by root, survives reboots). */
    String extractAsset(String name, String outName) throws IOException {
        File out = new File(deFilesDir(), outName);
        File tmp = new File(deFilesDir(), outName + ".tmp");
        InputStream in = getAssets().open(name);
        try {
            FileOutputStream o = new FileOutputStream(tmp);
            try {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
                o.getFD().sync();
            } finally {
                o.close();
            }
        } finally {
            in.close();
        }
        if (!tmp.renameTo(out)) throw new IOException("cannot write " + out);
        return out.getAbsolutePath();
    }

    /** Name of the Linux payload carried in assets/, or null for an APK built without one. */
    String findPayload() {
        try {
            String[] names = getAssets().list("");
            if (names == null) return null;
            for (String n : names) {
                if (n.startsWith("rootfs.tar")) return n;
            }
        } catch (IOException ignored) {
        }
        return null;
    }

    boolean hasAsset(String name) {
        try {
            getAssets().open(name).close();
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    static boolean ping(int timeoutMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(PING_URL).openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setUseCaches(false);
            return c.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    void openApp() {
        mainHandler.post(new UiTask(this, UiTask.OPEN_APP));
    }

    void showSetupPage() {
        mainHandler.post(new UiTask(this, UiTask.SHOW_SETUP));
    }

    void keepScreenOn(boolean on) {
        mainHandler.post(new UiTask(this, on ? UiTask.SCREEN_ON : UiTask.SCREEN_OFF));
    }

    /** The whole launch sequence, on a background thread. */
    public static class BootRunnable implements Runnable {
        private final MainActivity a;

        BootRunnable(MainActivity a) { this.a = a; }

        @Override
        public void run() {
            try {
                boot();
            } catch (Throwable t) {
                a.setup.fail("start", "启动时出错", String.valueOf(t.getMessage()), android.util.Log.getStackTraceString(t));
            } finally {
                a.keepScreenOn(false);
                a.bootFinished();
            }
        }

        private void boot() throws Exception {
            SetupState st = a.setup;
            String build = a.buildStamp();
            SharedPreferences prefs = a.getSharedPreferences(PREFS, MODE_PRIVATE);
            boolean synced = build.equals(prefs.getString(KEY_SYNCED, ""));

            st.begin();
            // Fast path: already running and nothing new in the APK to sync.
            if (synced && ping(800)) {
                st.phase("done");
                a.openApp();
                return;
            }

            // 1. root
            st.step("root", "active", "正在获取 Root 权限", "如果弹出授权窗口，请点「允许」。");
            int root = Su.check();
            if (root != 0) {
                if (root == 2) {
                    st.fail("root", "没有检测到 Root",
                            "DroidAgent 需要已 Root 的手机（KernelSU、Magisk 或 APatch）。", "");
                } else {
                    st.fail("root", "Root 授权被拒绝",
                            "请在 Root 管理器里允许 DroidAgent，然后点「重试」。", "");
                }
                return;
            }
            st.step("root", "done", null, null);

            String bootstrap = a.extractAsset("debian", "debian");

            // 2. unpack (first run only)
            boolean installed = new File(ROOTFS + "/usr/bin/bash").exists()
                    || Su.run("test -x '" + ROOTFS + "/usr/bin/bash'", 20).code == 0;
            if (!installed) {
                st.setFirstRun(true);
                if (!unpack(bootstrap)) return;
            } else {
                st.step("unpack", "skip", null, null);
            }

            // 3. sync launcher + chat app from the APK, start the backend
            st.step("start", "active", "正在启动助手服务", "第一次启动需要十几秒。");
            String bundle = a.hasAsset("agent-app.tar") ? a.extractAsset("agent-app.tar", "agent-app.tar") : "";
            // Claude Code on Node.js, for phones where the native builds abort at startup.
            String runtime = a.hasAsset("legacy-runtime.tar.xz")
                    ? a.extractAsset("legacy-runtime.tar.xz", "legacy-runtime.tar.xz") : "";
            Su.Result r = Su.run("sh '" + bootstrap + "' boot '" + bundle + "' '" + runtime + "'", 180);
            if (r.code != 0) {
                st.fail("start", "助手服务没能启动", explain(r.tail), r.tail);
                return;
            }
            prefs.edit().putString(KEY_SYNCED, build).apply();

            // 4. wait until it answers
            long deadline = System.currentTimeMillis() + 60000;
            while (System.currentTimeMillis() < deadline) {
                if (ping(1500)) {
                    st.step("start", "done", null, null);
                    st.phase("done");
                    a.openApp();
                    return;
                }
                Thread.sleep(500);
            }
            Su.Result log = Su.run("tail -n 30 '" + ROOTFS + "/var/log/agent-app.log'", 20);
            st.fail("start", "服务已启动，但一直连不上",
                    "后台服务没有在 127.0.0.1:8787 上响应。可以点「重试」，或查看下面的日志。", log.tail);
        }

        /** Streams the payload out of the APK into `debian selfinstall -`, counting bytes. */
        private boolean unpack(String bootstrap) throws Exception {
            SetupState st = a.setup;
            String payload = a.findPayload();
            if (payload == null) {
                st.fail("unpack", "安装包里没有 Linux 系统",
                        "这个安装包是不带系统的精简版。请安装完整版 DroidAgent.apk（约 1.3 GB）。", "");
                return false;
            }
            AssetFileDescriptor afd;
            try {
                afd = a.getAssets().openFd(payload);
            } catch (IOException e) {
                st.fail("unpack", "读不到安装包里的 Linux 系统", "安装包可能已损坏，请重新安装。", String.valueOf(e));
                return false;
            }
            long total = afd.getLength();
            long free = new StatFs(APK_DIR).getAvailableBytes();
            // Unpacked it is several times the compressed size; below twice that it cannot fit.
            if (free < total * 2 + (300L << 20)) {
                afd.close();
                st.fail("unpack", "存储空间不足",
                        "解压需要至少 " + gb(total * 3) + " 可用空间，现在只剩 " + gb(free) + "。清理一些空间后点「重试」。", "");
                return false;
            }
            String fmt = payload.endsWith(".xz") ? "xz" : payload.endsWith(".gz") ? "gz" : "tar";

            st.step("unpack", "active", "正在解压 Linux 系统", "系统已打包在安装包里，在本机解压一次即可，不需要联网。");
            st.progress(0, total);
            a.keepScreenOn(true);

            Process p = new ProcessBuilder("su", "-c", "sh '" + bootstrap + "' selfinstall - " + fmt)
                    .redirectErrorStream(true).start();
            Tail tail = new Tail(40);
            Thread reader = new Thread(new StreamTail(p.getInputStream(), tail), "unpack-log");
            reader.start();

            InputStream in = afd.createInputStream();
            OutputStream out = p.getOutputStream();
            String pipeError = null;
            long done = 0;
            try {
                byte[] buf = new byte[1 << 18];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    done += n;
                    st.progress(done, total);
                }
                out.flush();
            } catch (IOException e) {
                // The unpacker exited early (bad archive, disk full …); its own output says why.
                pipeError = String.valueOf(e.getMessage());
            } finally {
                try { out.close(); } catch (IOException ignored) { }
                try { in.close(); } catch (IOException ignored) { }
                try { afd.close(); } catch (IOException ignored) { }
            }
            int code = p.waitFor();
            reader.join(3000);
            a.keepScreenOn(false);

            boolean ok = code == 0 && Su.run("test -x '" + ROOTFS + "/usr/bin/bash'", 20).code == 0;
            if (!ok) {
                String log = tail.text();
                if (pipeError != null) log = log + "\n(" + pipeError + ")";
                st.fail("unpack", "解压没有完成", explain(log), log);
                return false;
            }
            st.step("unpack", "done", null, null);
            return true;
        }

        static String gb(long bytes) {
            return String.format(java.util.Locale.ROOT, "%.1f GB", bytes / 1073741824.0);
        }

        /** Turns the launcher's last words into a sentence a person can act on. */
        static String explain(String log) {
            String l = log == null ? "" : log;
            if (l.contains("No space left")) return "存储空间不足。清理一些空间后点「重试」。";
            if (l.contains("busybox not found"))
                return "没找到 busybox。请确认 Root 管理器（KernelSU / Magisk / APatch）安装完整。";
            if (l.contains("app deps missing"))
                return "聊天服务的依赖没有装好。可在终端里执行 debian appdeps（需要联网）。";
            if (l.contains("app not installed")) return "Linux 系统里缺少聊天服务的文件。请重新安装最新的 DroidAgent.apk。";
            if (l.contains("timed out")) return "命令执行超时。可以点「重试」。";
            return "可以点「重试」。如果一直失败，请把下面的日志发给开发者。";
        }
    }

    // ------------------------------------------------------------------ setup state (polled by the page)

    /** Everything the setup page shows. Written by the boot thread, read through the bridge. */
    public static class SetupState {
        private String phase = "checking";
        private boolean firstRun = false;
        private final JSONObject steps = new JSONObject();
        private String title = "正在启动";
        private String message = "";
        private String detail = "";
        private String failedStep = "";
        private long done = 0, total = 0, startedAt = 0;

        synchronized void begin() {
            phase = "checking";
            firstRun = false;
            title = "正在启动";
            message = "";
            detail = "";
            failedStep = "";
            done = 0;
            total = 0;
            try {
                steps.put("root", "pending");
                steps.put("unpack", "pending");
                steps.put("start", "pending");
            } catch (Exception ignored) {
            }
        }

        synchronized void setFirstRun(boolean v) { firstRun = v; }

        synchronized void phase(String p) { phase = p; }

        synchronized void step(String name, String status, String newTitle, String newMessage) {
            try {
                steps.put(name, status);
            } catch (Exception ignored) {
            }
            if ("active".equals(status)) phase = name;
            if (newTitle != null) title = newTitle;
            if (newMessage != null) message = newMessage;
        }

        synchronized void progress(long d, long t) {
            if (d == 0) startedAt = System.currentTimeMillis();
            done = d;
            total = t;
        }

        synchronized void fail(String step, String newTitle, String newMessage, String newDetail) {
            try {
                steps.put(step, "error");
            } catch (Exception ignored) {
            }
            phase = "error";
            failedStep = step;
            title = newTitle;
            message = newMessage;
            detail = newDetail == null ? "" : newDetail;
        }

        synchronized String toJson() {
            try {
                JSONObject o = new JSONObject();
                o.put("phase", phase);
                o.put("firstRun", firstRun);
                o.put("steps", new JSONObject(steps.toString()));
                o.put("title", title);
                o.put("message", message);
                o.put("detail", detail);
                o.put("failedStep", failedStep);
                JSONObject pr = new JSONObject();
                pr.put("done", done);
                pr.put("total", total);
                pr.put("elapsedMs", startedAt == 0 ? 0 : System.currentTimeMillis() - startedAt);
                o.put("progress", pr);
                return o.toString();
            } catch (Exception e) {
                return "{\"phase\":\"checking\"}";
            }
        }
    }

    // ------------------------------------------------------------------ su helpers

    public static class Su {
        public static class Result {
            int code;
            String tail;
        }

        /** 0 = root granted, 1 = denied, 2 = no su binary. Running su pops the grant dialog. */
        static int check() {
            try {
                Process p = Runtime.getRuntime().exec(new String[]{"su", "-c", "id -u"});
                BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()));
                StringBuilder out = new StringBuilder();
                String line;
                while ((line = r.readLine()) != null) out.append(line);
                r.close();
                p.waitFor();
                return (p.exitValue() == 0 && out.toString().trim().equals("0")) ? 0 : 1;
            } catch (Exception e) {
                return 2;
            }
        }

        static Result run(String cmd, int timeoutSec) {
            Result res = new Result();
            Tail tail = new Tail(60);
            try {
                Process p = new ProcessBuilder("su", "-c", cmd).redirectErrorStream(true).start();
                p.getOutputStream().close();
                Thread reader = new Thread(new StreamTail(p.getInputStream(), tail), "su-log");
                reader.start();
                if (!p.waitFor(timeoutSec, TimeUnit.SECONDS)) {
                    p.destroy();
                    tail.add("(timed out after " + timeoutSec + "s)");
                    res.code = 124;
                } else {
                    res.code = p.exitValue();
                }
                reader.join(2000);
            } catch (Exception e) {
                tail.add(String.valueOf(e.getMessage()));
                res.code = 127;
            }
            res.tail = tail.text();
            return res;
        }
    }

    /** Keeps the last N lines of a process's output. */
    public static class Tail {
        private final int max;
        private final ArrayDeque<String> lines = new ArrayDeque<String>();

        Tail(int max) { this.max = max; }

        synchronized void add(String line) {
            lines.addLast(line);
            while (lines.size() > max) lines.removeFirst();
        }

        synchronized String text() {
            StringBuilder b = new StringBuilder();
            for (String l : lines) {
                if (b.length() > 0) b.append('\n');
                b.append(l);
            }
            return b.toString();
        }
    }

    public static class StreamTail implements Runnable {
        private final InputStream in;
        private final Tail tail;

        StreamTail(InputStream in, Tail tail) {
            this.in = in;
            this.tail = tail;
        }

        @Override
        public void run() {
            try {
                BufferedReader r = new BufferedReader(new InputStreamReader(in));
                String line;
                while ((line = r.readLine()) != null) tail.add(line);
                r.close();
            } catch (IOException ignored) {
            }
        }
    }

    // ------------------------------------------------------------------ JS bridge

    /**
     * What our own pages can ask of the app: the setup page's state and retry, the system's
     * night mode (WebView's prefers-color-scheme doesn't follow it reliably), and the floating
     * bubble's switch for the settings page.
     * Bridge methods arrive on the JavaBridge thread, so UI work goes through runOnUiThread.
     */
    public static class HostBridge {
        private final MainActivity activity;

        HostBridge(MainActivity activity) { this.activity = activity; }

        @JavascriptInterface
        public String state() { return activity.setup.toJson(); }

        @JavascriptInterface
        public void retry() {
            activity.loadFailures = 0;
            activity.startBoot();
        }

        @JavascriptInterface
        public boolean isNight() {
            int mode = activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
            return mode == Configuration.UI_MODE_NIGHT_YES;
        }

        @JavascriptInterface
        public String version() {
            try {
                return activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public boolean granted() { return OverlayService.canDraw(activity); }

        /** Master switch; on by default, so the bubble works without anyone turning it on. */
        @JavascriptInterface
        public boolean enabled() {
            return activity.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_OVERLAY, true);
        }

        @JavascriptInterface
        public void setEnabled(boolean on) {
            activity.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_OVERLAY, on).apply();
            activity.runOnUiThread(new UiTask(activity, on ? UiTask.ENABLE : UiTask.DISABLE));
        }
    }

    // d8 in this toolchain crashes on anonymous inner classes, so every callback is a named class.
    public static class UiTask implements Runnable {
        static final int ENABLE = 1;
        static final int DISABLE = 2;
        static final int OPEN_APP = 3;
        static final int SHOW_SETUP = 4;
        static final int SCREEN_ON = 5;
        static final int SCREEN_OFF = 6;
        static final int AFTER_GRANT = 7;

        private final MainActivity activity;
        private final int what;

        UiTask(MainActivity activity, int what) {
            this.activity = activity;
            this.what = what;
        }

        @Override
        public void run() {
            MainActivity a = activity;
            switch (what) {
                case ENABLE:
                    // Re-asks for permission if it was refused earlier.
                    a.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_ASKED, false).apply();
                    a.ensureOverlay();
                    break;
                case DISABLE:
                    a.stopService(new Intent(a, OverlayService.class));
                    break;
                case OPEN_APP:
                    a.webView.loadUrl(APP_URL);
                    break;
                case SHOW_SETUP:
                    a.webView.loadUrl(SETUP_URL);
                    break;
                case SCREEN_ON:
                    a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    break;
                case SCREEN_OFF:
                    a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    break;
                case AFTER_GRANT:
                    a.afterGrant();
                    break;
                default:
                    break;
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            if (filePathCallback != null) {
                Uri[] results = null;
                if (resultCode == Activity.RESULT_OK && data != null) {
                    String dataString = data.getDataString();
                    if (dataString != null) {
                        results = new Uri[]{Uri.parse(dataString)};
                    }
                }
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
        } else {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            moveTaskToBack(true);
        }
    }

    public static class AgentWebViewClient extends WebViewClient {
        private final MainActivity activity;

        public AgentWebViewClient(MainActivity activity) {
            this.activity = activity;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleUrl(request.getUrl().toString());
        }

        private boolean handleUrl(String url) {
            if (url.startsWith("http://127.0.0.1:8787") || url.startsWith("http://localhost:8787")
                    || url.startsWith("file:///android_asset/")) {
                return false;
            }
            try {
                activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception e) {
                Toast.makeText(activity, "无法打开链接: " + e.getMessage(), Toast.LENGTH_SHORT).show();
            }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (url != null && url.startsWith(APP_URL)) activity.appShown = true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (url != null && url.startsWith(APP_URL)) {
                activity.loadFailures = 0;
                // Back from the chat must leave the app, not return to the setup page.
                view.clearHistory();
                activity.ensureOverlay();
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request == null || !request.isForMainFrame()) return;
            String url = request.getUrl().toString();
            if (!url.startsWith("http://127.0.0.1:8787") && !url.startsWith("http://localhost:8787")) return;
            // The backend went away (killed, phone rebooted …): show the setup page and bring it
            // back. Twice in a row without the chat ever loading means booting isn't helping.
            activity.appShown = false;
            activity.showSetupPage();
            if (++activity.loadFailures <= 2) {
                activity.startBoot();
            } else {
                activity.setup.fail("start", "连不上助手服务",
                        "页面加载失败：" + error.getDescription() + "。点「重试」再试一次。", "");
            }
        }
    }

    public static class AgentWebChromeClient extends WebChromeClient {
        private final MainActivity activity;

        public AgentWebChromeClient(MainActivity activity) {
            this.activity = activity;
        }

        @Override
        public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (activity.filePathCallback != null) {
                activity.filePathCallback.onReceiveValue(null);
            }
            activity.filePathCallback = callback;
            try {
                Intent intent = params.createIntent();
                activity.startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                return true;
            } catch (Exception e) {
                activity.filePathCallback = null;
                return false;
            }
        }
    }
}
