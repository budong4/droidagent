package com.droidagent.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.JavascriptInterface;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity implements View.OnClickListener {
    private static final String APP_URL = "http://127.0.0.1:8787/";
    private static final int FILE_CHOOSER_REQUEST = 1001;
    /** The Linux system lives in this app's own device-encrypted storage. Paths are derived
     *  from the package at runtime (set in onCreate), so nothing hard-codes the package name. */
    static String APK_DIR;   // /data/user_de/0/<pkg>
    static String ROOTFS;    // APK_DIR + "/rootfs"
    static String LAUNCHER;  // APK_DIR + "/bin/debian"
    private static final String PREFS = "droidagent";
    private static final String KEY_OVERLAY = "overlay_enabled";
    private static final String KEY_ASKED = "overlay_permission_asked";

    /** True while the conversation is actually on screen; the bubble stays away when it is. */
    public static volatile boolean chatVisible = false;

    WebView webView;
    LinearLayout errorLayout;
    TextView errorText;
    Button btnStartService;
    Button btnRetry;
    ValueCallback<Uri[]> filePathCallback;
    Handler mainHandler;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        // Derive the app's device-encrypted data dir (/data/user_de/0/<pkg>) at runtime.
        APK_DIR = createDeviceProtectedStorageContext().getDataDir().getAbsolutePath();
        ROOTFS = APK_DIR + "/rootfs";
        LAUNCHER = APK_DIR + "/bin/debian";

        mainHandler = new Handler(Looper.getMainLooper());
        webView = (WebView) findViewById(R.id.webview);
        errorLayout = (LinearLayout) findViewById(R.id.error_layout);
        errorText = (TextView) findViewById(R.id.error_text);
        btnStartService = (Button) findViewById(R.id.btn_start_service);
        btnRetry = (Button) findViewById(R.id.btn_retry);

        btnRetry.setOnClickListener(this);
        btnStartService.setOnClickListener(this);

        initWebView();
        loadAgent();
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
        ensureOverlay();
    }

    void ensureOverlay() {
        if (!getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_OVERLAY, true)) return;

        if (!OverlayService.canDraw(this)) {
            if (!getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_ASKED, false)) {
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_ASKED, true).apply();
                Toast.makeText(this, "请允许「显示在其他应用上层」，这样助手跳到别的应用时你也能看到进度",
                        Toast.LENGTH_LONG).show();
                startActivity(OverlayService.permissionIntent(this));
            }
            return;
        }
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 1002);
        }
        if (!OverlayService.isRunning) {
            startForegroundService(new Intent(this, OverlayService.class));
        }
    }

    @Override
    public void onClick(View v) {
        int id = v.getId();
        if (id == R.id.btn_retry) {
            loadAgent();
        } else if (id == R.id.btn_start_service) {
            startDebianService();
        }
    }

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

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        webView.setWebViewClient(new AgentWebViewClient(this));
        webView.setWebChromeClient(new AgentWebChromeClient(this));
        // Only ever loads http://127.0.0.1:8787 (other URLs are handed to an external browser),
        // so this bridge is reachable only from our own local page.
        webView.addJavascriptInterface(new OverlayBridge(this), "AgentHost");
    }

    /**
     * Lets the in-app settings page drive the floating status bubble.
     * Bridge methods arrive on the JavaBridge thread, so each hop goes through runOnUiThread.
     */
    public static class OverlayBridge {
        private final MainActivity activity;

        OverlayBridge(MainActivity activity) { this.activity = activity; }

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

        private final MainActivity activity;
        private final int what;

        UiTask(MainActivity activity, int what) {
            this.activity = activity;
            this.what = what;
        }

        @Override
        public void run() {
            if (what == ENABLE) {
                // Re-asks for permission if it was refused earlier.
                activity.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_ASKED, false).apply();
                activity.ensureOverlay();
            } else {
                activity.stopService(new Intent(activity, OverlayService.class));
            }
        }
    }

    public void loadAgent() {
        // A fresh install carries the Linux system inside the APK but has not unpacked it yet.
        if (!new File(ROOTFS + "/usr/bin/bash").exists()) {
            showSetup();
            return;
        }
        errorLayout.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl(APP_URL);
    }

    void showSetup() {
        webView.setVisibility(View.GONE);
        errorLayout.setVisibility(View.VISIBLE);
        errorText.setText("首次使用需要先把内置的 Linux 系统解包到本机，大约需要几分钟。");
        btnStartService.setText("安装 Linux 系统");
        btnStartService.setEnabled(true);
        btnRetry.setVisibility(View.GONE);
    }

    void setProgress(String line) {
        errorText.setText(line);
    }

    /** Unpacks the payload carried in the APK; see `debian selfinstall`. */
    public static class InstallRunnable implements Runnable {
        private final MainActivity activity;

        InstallRunnable(MainActivity activity) { this.activity = activity; }

        @Override
        public void run() {
            String bootstrap = activity.deFilesDir() + "/debian";
            try {
                // The launcher has to exist before it can unpack anything, so it rides along
                // as an asset and is written out first; selfinstall then installs it properly.
                InputStream in = activity.getAssets().open("debian");
                FileOutputStream out = new FileOutputStream(bootstrap);
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                out.close();
                in.close();
            } catch (Exception e) {
                activity.mainHandler.post(new InstallDone(activity, false, "无法释放启动器：" + e.getMessage()));
                return;
            }

            boolean ok = false;
            String last = "";
            try {
                ProcessBuilder pb = new ProcessBuilder("su", "-c", "sh " + bootstrap + " selfinstall");
                pb.redirectErrorStream(true);
                Process p = pb.start();
                BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()));
                String line;
                while ((line = r.readLine()) != null) {
                    last = line;
                    activity.mainHandler.post(new ProgressPoster(activity, line));
                }
                r.close();
                p.waitFor();
                ok = p.exitValue() == 0 && new File(ROOTFS + "/usr/bin/bash").exists();
            } catch (Exception e) {
                last = String.valueOf(e.getMessage());
            }
            activity.mainHandler.post(new InstallDone(activity, ok, last));
        }
    }

    public static class ProgressPoster implements Runnable {
        private final MainActivity activity;
        private final String line;

        ProgressPoster(MainActivity activity, String line) {
            this.activity = activity;
            this.line = line;
        }

        @Override
        public void run() { activity.setProgress(line); }
    }

    public static class InstallDone implements Runnable {
        private final MainActivity activity;
        private final boolean ok;
        private final String message;

        InstallDone(MainActivity activity, boolean ok, String message) {
            this.activity = activity;
            this.ok = ok;
            this.message = message;
        }

        @Override
        public void run() {
            activity.btnStartService.setEnabled(true);
            activity.btnRetry.setVisibility(View.VISIBLE);
            if (ok) {
                Toast.makeText(activity, "Linux 系统已就绪", Toast.LENGTH_SHORT).show();
                // Root was already granted for the install, so start directly without re-prompting.
                activity.onRootGranted();
            } else {
                activity.btnStartService.setText("重新安装");
                activity.setProgress("安装失败：" + message);
            }
        }
    }

    String deFilesDir() {
        return createDeviceProtectedStorageContext().getFilesDir().getAbsolutePath();
    }

    public void showError(String msg) {
        webView.setVisibility(View.GONE);
        errorLayout.setVisibility(View.VISIBLE);
        if (msg != null && !msg.isEmpty()) {
            errorText.setText(msg);
        }
    }

    void startDebianService() {
        // Request root first. Running `su` pops the root manager's grant dialog on its own, and
        // this gives a clear message when root is missing or denied instead of failing silently.
        btnStartService.setEnabled(false);
        btnRetry.setVisibility(View.GONE);
        setProgress("正在请求 Root 权限…（若弹出授权窗口请点允许）");
        new Thread(new RootGateRunnable(this)).start();
    }

    /** Called on the main thread once root has been granted. */
    void onRootGranted() {
        if (!new File(ROOTFS + "/usr/bin/bash").exists()) {
            btnStartService.setText("正在安装…");
            setProgress("正在解包，请不要关闭应用…");
            new Thread(new InstallRunnable(this)).start();
            return;
        }
        btnStartService.setText("正在通过 Root 启动…");
        new Thread(new StartServiceRunnable(this)).start();
    }

    /** Called on the main thread when root is unavailable: denied by the user, or no su at all. */
    void onRootUnavailable(boolean denied) {
        btnStartService.setEnabled(true);
        btnStartService.setText("重试");
        btnRetry.setVisibility(View.GONE);
        if (denied) {
            setProgress("Root 授权被拒绝。请在你的 Root 管理器（KernelSU / Magisk / APatch）里允许本应用，然后点「重试」。");
        } else {
            setProgress("未检测到 Root 权限。本应用需要已 Root 的设备（KernelSU / Magisk / APatch）。");
        }
    }

    /** Runs `su -c id -u`, which triggers the root manager's grant prompt, and classifies the result. */
    public static class RootGateRunnable implements Runnable {
        private final MainActivity activity;

        RootGateRunnable(MainActivity activity) { this.activity = activity; }

        @Override
        public void run() {
            int state; // 0 = granted, 1 = denied, 2 = no su binary
            try {
                Process p = Runtime.getRuntime().exec(new String[]{"su", "-c", "id -u"});
                BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()));
                StringBuilder out = new StringBuilder();
                String line;
                while ((line = r.readLine()) != null) out.append(line);
                r.close();
                p.waitFor();
                state = (p.exitValue() == 0 && out.toString().trim().equals("0")) ? 0 : 1;
            } catch (Exception e) {
                state = 2;
            }
            activity.mainHandler.post(new RootResult(activity, state));
        }
    }

    public static class RootResult implements Runnable {
        private final MainActivity activity;
        private final int state;

        RootResult(MainActivity activity, int state) {
            this.activity = activity;
            this.state = state;
        }

        @Override
        public void run() {
            if (state == 0) activity.onRootGranted();
            else activity.onRootUnavailable(state == 1);
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

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleUrl(url);
        }

        private boolean handleUrl(String url) {
            if (url.startsWith("http://127.0.0.1:8787") || url.startsWith("http://localhost:8787")) {
                return false;
            }
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                activity.startActivity(intent);
            } catch (Exception e) {
                Toast.makeText(activity, "无法打开链接: " + e.getMessage(), Toast.LENGTH_SHORT).show();
            }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (url != null && url.contains("127.0.0.1:8787")) {
                activity.errorLayout.setVisibility(View.GONE);
                activity.webView.setVisibility(View.VISIBLE);
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request != null && request.isForMainFrame()) {
                activity.showError("连接失败: 无法访问本地服务");
            }
        }

        @Override
        public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
            activity.showError("连接失败: " + description);
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

    public static class StartServiceRunnable implements Runnable {
        private final MainActivity activity;

        public StartServiceRunnable(MainActivity activity) {
            this.activity = activity;
        }

        @Override
        public void run() {
            boolean success = false;
            try {
                Process p = Runtime.getRuntime().exec(new String[]{"su", "-c", LAUNCHER + " app start"});
                p.waitFor();
                success = (p.exitValue() == 0);
            } catch (Exception e) {
                success = false;
            }

            activity.mainHandler.postDelayed(new ServiceResultPoster(activity, success), 1500);
        }
    }

    public static class ServiceResultPoster implements Runnable {
        private final MainActivity activity;
        private final boolean ok;

        public ServiceResultPoster(MainActivity activity, boolean ok) {
            this.activity = activity;
            this.ok = ok;
        }

        @Override
        public void run() {
            activity.btnStartService.setEnabled(true);
            activity.btnStartService.setText("一键启动后台服务");
            if (ok) {
                Toast.makeText(activity, "服务已启动，正在连接…", Toast.LENGTH_SHORT).show();
            } else {
                Toast.makeText(activity, "启动命令已发送，正在尝试连接…", Toast.LENGTH_SHORT).show();
            }
            activity.loadAgent();
        }
    }
}
