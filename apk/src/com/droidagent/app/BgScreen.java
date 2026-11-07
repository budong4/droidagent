package com.droidagent.app;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.content.ComponentName;
import android.content.Context;
import android.content.ContextWrapper;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.net.Credentials;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.system.Os;
import android.util.Base64;
import android.util.SparseArray;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.TimeoutException;

/**
 * A screen nobody sees, for the assistant to use apps on while the owner keeps using the phone.
 * Not part of the app's own process: droid starts it as root through app_process,
 *
 *   CLASSPATH=<this APK> app_process /system/bin com.droidagent.app.BgScreen serve W H DPI
 *
 * and it holds a virtual display for as long as it runs. Apps are started on it with
 * `am start --display`, and touches and keys go there with `input -d`. Everything that needs the
 * display's own content is answered here, on the abstract socket "droidagent-bgscreen", to root
 * callers only, one command per connection, one line each way:
 *
 *   info                     ok {"display":..,"w":..,"top":..,"tasks":..,"takenOver":..}
 *   top DISPLAY              ok PACKAGE|-        the app in front on that display
 *   shot PATH                ok W H [empty]      PNG of what is on it
 *   frame PATH MAXW          ok W H [empty]      a smaller JPEG, for watching it live
 *   ui PATH                  ok COUNT            its controls, in uiautomator's XML format
 *   type X Y BASE64          ok HOW | err WHY    put text into the field (focused, or at X Y)
 *   takeover                 ok PACKAGE          move its app to the owner's screen
 *   quit                     ok                  close it, and the apps on it
 *
 * It closes by itself after IDLE_MS without a command. `type DISPLAY X Y BASE64` as arguments
 * instead of `serve` does that one job on any display (0 is the owner's screen) and exits.
 *
 * No lambdas, anonymous classes or generic interfaces implemented here: the build's d8 can't
 * take the synthetic classes and bridge methods those produce.
 */
public final class BgScreen {
    static final String SOCKET = "droidagent-bgscreen";
    static final String DIR = "/data/local/tmp/droid-bg/";
    static final long IDLE_MS = 15 * 60 * 1000L;

    // VirtualDisplay flags; most are hidden, so by value.
    static final int PUBLIC = 1, PRESENTATION = 1 << 1, OWN_CONTENT_ONLY = 1 << 3, SUPPORTS_TOUCH = 1 << 6,
            ROTATES_WITH_CONTENT = 1 << 7, DESTROY_CONTENT_ON_REMOVAL = 1 << 8, TRUSTED = 1 << 10,
            OWN_DISPLAY_GROUP = 1 << 11, ALWAYS_UNLOCKED = 1 << 12, TOUCH_FEEDBACK_DISABLED = 1 << 13,
            OWN_FOCUS = 1 << 14, STEAL_TOP_FOCUS_DISABLED = 1 << 16;
    static final int IME_POLICY_HIDE = 2;

    static Context ctx;
    static VirtualDisplay display;
    static int displayId = -1, width, height, dpi;
    static final Frames frames = new Frames();
    static volatile long lastUse = System.currentTimeMillis();
    static volatile String takenOver;
    static String user = "root";
    static String ime = "";

    public static void main(String[] args) {
        try {
            if (args.length >= 2 && args[0].equals("call")) { // for testing from adb: one command
                System.out.println(call(join(args, 1)));
                System.exit(0);
            }
            if (args.length == 5 && args[0].equals("type")) {
                setup();
                System.out.println(typeText(Integer.parseInt(args[1]), Integer.parseInt(args[2]), Integer.parseInt(args[3]), decode(args[4])));
                System.exit(0);
            }
            if (args.length != 4 || !args[0].equals("serve")) {
                System.err.println("usage: BgScreen serve W H DPI | type DISPLAY X Y TEXT_BASE64");
                System.exit(2);
            }
            width = Integer.parseInt(args[1]);
            height = Integer.parseInt(args[2]);
            dpi = Integer.parseInt(args[3]);
            LocalServerSocket server;
            try {
                server = new LocalServerSocket(SOCKET);
            } catch (IOException e) {
                System.out.println("busy: another one is running");
                System.exit(3);
                return;
            }
            setup();
            createDisplay();
            System.out.println("ready display " + displayId + " as " + user + ", keyboard " + ime);
            Thread w = new Thread(new Watchdog(), "idle");
            w.setDaemon(true);
            w.start();
            serve(server);
        } catch (Throwable t) {
            t.printStackTrace();
            System.exit(1);
        }
    }

    // ------------------------------------------------------------------ setting up

    /** A system context, the way command-line tools reach one: there is no app around this. */
    static void setup() throws Exception {
        try { OverlayService.SkipScreenshot.exemptHiddenApis(); } catch (Throwable ignored) { /* not enforced here */ }
        try {
            Method argv0 = android.os.Process.class.getMethod("setArgV0", String.class);
            argv0.invoke(null, "droidagent-bgscreen");
        } catch (Throwable ignored) { /* only the name in ps */ }
        if (Looper.getMainLooper() == null) Looper.prepareMainLooper();
        Class<?> at = Class.forName("android.app.ActivityThread");
        Constructor<?> k = at.getDeclaredConstructor();
        k.setAccessible(true);
        Object thread = k.newInstance();
        java.lang.reflect.Field cur = at.getDeclaredField("sCurrentActivityThread");
        cur.setAccessible(true);
        cur.set(null, thread);
        java.lang.reflect.Field sys = at.getDeclaredField("mSystemThread");
        sys.setAccessible(true);
        sys.setBoolean(thread, true);
        Method gsc = at.getDeclaredMethod("getSystemContext");
        gsc.setAccessible(true);
        ctx = new ShellContext((Context) gsc.invoke(thread));
    }

    static void createDisplay() throws Exception {
        HandlerThread ht = new HandlerThread("frames");
        ht.start();
        ImageReader reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 3);
        reader.setOnImageAvailableListener(frames, new Handler(ht.getLooper()));
        int flags = PUBLIC | PRESENTATION | OWN_CONTENT_ONLY | SUPPORTS_TOUCH | ROTATES_WITH_CONTENT | DESTROY_CONTENT_ON_REMOVAL;
        // Its own focus, and a tap there never makes it the display keys go to, so working there
        // doesn't take the owner's typing away; its own power group and no keyguard, so it doesn't
        // follow the owner's screen.
        if (Build.VERSION.SDK_INT >= 33) flags |= TRUSTED | OWN_DISPLAY_GROUP | ALWAYS_UNLOCKED | TOUCH_FEEDBACK_DISABLED;
        if (Build.VERSION.SDK_INT >= 34) flags |= OWN_FOCUS | STEAL_TOP_FOCUS_DISABLED;
        Constructor<DisplayManager> k = DisplayManager.class.getDeclaredConstructor(Context.class);
        k.setAccessible(true);
        DisplayManager dm = k.newInstance(ctx);
        try {
            display = dm.createVirtualDisplay("DroidAgent", width, height, dpi, reader.getSurface(), flags);
        } catch (SecurityException e) {
            // Some builds want the package to belong to the caller, and root owns none. adb's
            // shell user does own one, and may make such a display.
            System.out.println("as root: " + e.getMessage() + "; trying as shell");
            Os.setgid(2000);
            Os.setuid(2000);
            user = "shell";
            display = dm.createVirtualDisplay("DroidAgent", width, height, dpi, reader.getSurface(), flags);
        }
        if (display == null || display.getDisplay() == null) throw new IllegalStateException("no display was made");
        displayId = display.getDisplay().getDisplayId();
        // Without this the keyboard for a field there would come up on the owner's screen.
        try {
            Object wm = Class.forName("android.view.WindowManagerGlobal").getMethod("getWindowManagerService").invoke(null);
            wm.getClass().getMethod("setDisplayImePolicy", int.class, int.class).invoke(wm, displayId, IME_POLICY_HIDE);
            ime = "hidden";
        } catch (Throwable t) {
            ime = "not hidden (" + why(t) + ")";
        }
    }

    // ------------------------------------------------------------------ answering

    static void serve(LocalServerSocket server) throws IOException {
        while (true) {
            LocalSocket s = server.accept();
            String line = null;
            try {
                Credentials c = s.getPeerCredentials();
                if (c == null || c.getUid() != 0) continue;
                BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
                line = in.readLine();
                String reply;
                try {
                    reply = handle(line == null ? "" : line.trim());
                } catch (Throwable t) {
                    reply = "err " + why(t);
                }
                OutputStream o = s.getOutputStream();
                o.write((reply.replace('\n', ' ') + "\n").getBytes(StandardCharsets.UTF_8));
                o.flush();
            } catch (IOException ignored) {
                // the caller went away
            } finally {
                try { s.close(); } catch (IOException ignored) { /* */ }
            }
            if ("quit".equals(line)) finish();
        }
    }

    static String handle(String line) throws Exception {
        String[] a = line.split(" ", 3);
        // The app asks for `info` every few seconds to show what is going on; that isn't use.
        if (!a[0].equals("info")) lastUse = System.currentTimeMillis();
        switch (a[0]) {
            case "info": return "ok " + info();
            case "top": return "ok " + topPackage(Integer.parseInt(a[1]));
            case "shot": return picture(path(a[1]), 0);
            case "frame": return picture(path(a[1]), Integer.parseInt(a[2]));
            case "ui": return dumpUi(displayId, path(a[1]));
            case "type": { // type X Y BASE64
                String[] t = line.split(" ", 4);
                return typeText(displayId, Integer.parseInt(t[1]), Integer.parseInt(t[2]), decode(t[3]));
            }
            case "typewith": { // typewith set|paste|keys X Y BASE64, for tests
                String[] t = line.split(" ", 5);
                return typeText(displayId, Integer.parseInt(t[2]), Integer.parseInt(t[3]), decode(t[4]), t[1]);
            }
            case "takeover": return takeover();
            case "quit": return "ok";
            default: return "err unknown command: " + a[0];
        }
    }

    static String info() throws Exception {
        JSONObject j = new JSONObject();
        j.put("display", displayId).put("w", width).put("h", height).put("dpi", dpi);
        j.put("user", user).put("keyboard", ime).put("frames", frames.count);
        List<?> tasks = rootTasks(displayId);
        j.put("tasks", tasks.size());
        ComponentName top = tasks.isEmpty() ? null : topActivity(tasks.get(0));
        j.put("top", top == null ? JSONObject.NULL : top.getPackageName());
        j.put("label", top == null ? JSONObject.NULL : label(top.getPackageName()));
        j.put("activity", top == null ? JSONObject.NULL : top.flattenToShortString());
        j.put("takenOver", takenOver == null ? JSONObject.NULL : takenOver);
        j.put("takenOverLabel", takenOver == null ? JSONObject.NULL : label(takenOver));
        j.put("idleMs", System.currentTimeMillis() - lastUse);
        return j.toString();
    }

    /** The app's name as the launcher shows it, or its package when that can't be read. */
    static String label(String pkg) {
        try {
            android.content.pm.PackageManager pm = ctx.getPackageManager();
            CharSequence l = pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0));
            return l == null || l.length() == 0 ? pkg : l.toString();
        } catch (Throwable t) {
            return pkg;
        }
    }

    static String path(String p) {
        if (p == null || !p.startsWith(DIR) || p.contains("..")) throw new IllegalArgumentException("files go in " + DIR);
        return p;
    }

    static String picture(String path, int maxWidth) throws IOException {
        Bitmap b = frames.bitmap();
        boolean empty = b == null;
        if (empty) {
            b = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
            b.eraseColor(Color.BLACK);
        }
        if (maxWidth > 0 && b.getWidth() > maxWidth) {
            b = Bitmap.createScaledBitmap(b, maxWidth, Math.round(b.getHeight() * (maxWidth / (float) b.getWidth())), true);
        }
        File tmp = new File(path + ".part");
        FileOutputStream out = new FileOutputStream(tmp);
        try {
            b.compress(maxWidth > 0 ? Bitmap.CompressFormat.JPEG : Bitmap.CompressFormat.PNG, 72, out);
        } finally {
            out.close();
        }
        if (!tmp.renameTo(new File(path))) throw new IOException("could not write " + path);
        return "ok " + b.getWidth() + " " + b.getHeight() + (empty ? " empty" : "");
    }

    static void finish() {
        try { if (display != null) display.release(); } catch (Throwable ignored) { /* exiting anyway */ }
        System.exit(0);
    }

    // ------------------------------------------------------------------ tasks

    static Object taskManager() throws Exception {
        return Class.forName("android.app.ActivityTaskManager").getMethod("getService").invoke(null);
    }

    /** The task stacks on a display, front first. */
    static List<?> rootTasks(int d) throws Exception {
        Object atm = taskManager();
        Object l = atm.getClass().getMethod("getAllRootTaskInfosOnDisplay", int.class).invoke(atm, d);
        return l == null ? Collections.emptyList() : (List<?>) l;
    }

    static ComponentName topActivity(Object task) throws Exception {
        return (ComponentName) task.getClass().getField("topActivity").get(task);
    }

    static boolean visible(Object task) {
        try { return task.getClass().getField("visible").getBoolean(task); } catch (Throwable t) { return true; }
    }

    static String topPackage(int d) throws Exception {
        for (Object t : rootTasks(d)) {
            if (!visible(t)) continue;
            ComponentName c = topActivity(t);
            if (c != null) return c.getPackageName();
        }
        return "-";
    }

    static String takeover() throws Exception {
        List<?> tasks = rootTasks(displayId);
        if (tasks.isEmpty()) return "err there is no app on the background screen";
        Object t = tasks.get(0);
        int id = t.getClass().getField("taskId").getInt(t);
        ComponentName c = topActivity(t);
        Object atm = taskManager();
        atm.getClass().getMethod("moveRootTaskToDisplay", int.class, int.class).invoke(atm, id, 0);
        takenOver = c == null ? "?" : c.getPackageName();
        return "ok " + takenOver;
    }

    // ------------------------------------------------------------------ controls

    static String dumpUi(int d, String path) throws Exception {
        Ua u = Ua.open();
        try {
            StringBuilder x = new StringBuilder("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">");
            int[] count = {0};
            for (AccessibilityWindowInfo w : u.windows(d)) {
                AccessibilityNodeInfo r = w.getRoot();
                if (r != null) dumpNode(r, 0, x, count);
            }
            x.append("</hierarchy>");
            File tmp = new File(path + ".part");
            FileOutputStream out = new FileOutputStream(tmp);
            try {
                out.write(x.toString().getBytes(StandardCharsets.UTF_8));
            } finally {
                out.close();
            }
            if (!tmp.renameTo(new File(path))) throw new IOException("could not write " + path);
            return "ok " + count[0];
        } finally {
            u.close();
        }
    }

    static void dumpNode(AccessibilityNodeInfo n, int index, StringBuilder x, int[] count) {
        Rect r = new Rect();
        n.getBoundsInScreen(r);
        x.append("<node index=\"").append(index)
                .append("\" text=\"").append(esc(n.getText()))
                .append("\" resource-id=\"").append(esc(n.getViewIdResourceName()))
                .append("\" class=\"").append(esc(n.getClassName()))
                .append("\" package=\"").append(esc(n.getPackageName()))
                .append("\" content-desc=\"").append(esc(n.getContentDescription()))
                .append("\" checkable=\"").append(n.isCheckable())
                .append("\" checked=\"").append(n.isChecked())
                .append("\" clickable=\"").append(n.isClickable())
                .append("\" enabled=\"").append(n.isEnabled())
                .append("\" focusable=\"").append(n.isFocusable())
                .append("\" focused=\"").append(n.isFocused())
                .append("\" scrollable=\"").append(n.isScrollable())
                .append("\" long-clickable=\"").append(n.isLongClickable())
                .append("\" password=\"").append(n.isPassword())
                .append("\" selected=\"").append(n.isSelected())
                .append("\" bounds=\"[").append(r.left).append(',').append(r.top).append("][")
                .append(r.right).append(',').append(r.bottom).append("]\">");
        count[0]++;
        for (int i = 0; i < n.getChildCount() && count[0] < 5000; i++) {
            AccessibilityNodeInfo c = n.getChild(i);
            if (c != null && c.isVisibleToUser()) dumpNode(c, i, x, count);
        }
        x.append("</node>");
    }

    static String esc(CharSequence s) {
        if (s == null) return "";
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '&') b.append("&amp;");
            else if (c == '<') b.append("&lt;");
            else if (c == '>') b.append("&gt;");
            else if (c == '"') b.append("&quot;");
            else if (c == '\n' || c == '\r' || c == '\t') b.append(' ');
            else if (c >= 0x20 && c != 0xFFFE && c != 0xFFFF) b.append(c);
        }
        return b.toString();
    }

    /**
     * Text into a field on display d, at its cursor, without any keyboard: the owner's own keyboard
     * is never involved. The field is the one with focus, else the editable one at (x, y), where
     * droid last tapped. Three ways, each checked by reading the field back: accessibility sets the
     * text; else it pastes it; else, for plain ASCII only, key presses addressed to display d.
     * Says which way worked, or why each one didn't.
     */
    static String typeText(int d, int x, int y, String s) throws Exception {
        return typeText(d, x, y, s, "all");
    }

    /** `only` (set, paste or keys) tries that way alone: for testing the other two. */
    static String typeText(int d, int x, int y, String s, String only) throws Exception {
        boolean all = only.equals("all");
        Ua u = Ua.open();
        try {
            AccessibilityNodeInfo f = findField(u.windows(d), x, y);
            if (f == null) {
                return "err no text field: nothing has focus" + (x >= 0 ? " and nothing editable is at " + x + "," + y : "")
                        + ". Tap the field first (droid ui lists it with [edit])";
            }
            if (!f.isFocused()) f.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            String before = textOf(f);
            StringBuilder why = new StringBuilder();

            String next = insertAt(f, before, s);
            Bundle args = new Bundle();
            args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, next);
            if (!all && !only.equals("set")) {
                why.append("set: skipped; ");
            } else if (f.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
                if (changed(f, before)) {
                    cursorTo(f, next.length() - (before.length() - selEnd(f, before)));
                    return done("ok set", s);
                }
                why.append("set: the field kept its text; ");
            } else {
                why.append("set: refused; ");
            }

            String clip = all || only.equals("paste") ? paste(f, s) : "skipped";
            if (clip == null && changed(f, before)) return done("ok paste", s);
            why.append("paste: ").append(clip == null ? "the field kept its text" : clip).append("; ");

            if (!all && !only.equals("keys")) {
                why.append("keys: skipped");
            } else if (isAscii(s)) {
                String keys = pressKeys(d, s);
                if (keys == null && changed(f, before)) return done("ok keys", s);
                why.append("keys: ").append(keys == null ? "the field kept its text" : keys);
            } else {
                why.append("keys: only for plain ASCII");
            }
            return done("err the field did not take the text (" + why + ")", s);
        } finally {
            u.close();
        }
    }

    static String done(String result, String s) {
        System.out.println("type " + s.length() + " chars: " + result);
        return result;
    }

    /** The focused input field, or the smallest editable one under (x, y), or the only one there is. */
    static AccessibilityNodeInfo findField(List<AccessibilityWindowInfo> wins, int x, int y) {
        List<AccessibilityNodeInfo> editable = new ArrayList<AccessibilityNodeInfo>();
        for (AccessibilityWindowInfo w : wins) {
            AccessibilityNodeInfo r = w.getRoot();
            if (r == null) continue;
            AccessibilityNodeInfo f = r.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (f != null && f.isEditable()) return f;
            collectEditable(r, editable, 0);
        }
        AccessibilityNodeInfo best = null;
        long bestArea = Long.MAX_VALUE;
        Rect b = new Rect();
        for (AccessibilityNodeInfo n : editable) {
            n.getBoundsInScreen(b);
            if (x >= 0 && b.contains(x, y) && (long) b.width() * b.height() < bestArea) {
                best = n;
                bestArea = (long) b.width() * b.height();
            }
        }
        if (best == null && editable.size() == 1) best = editable.get(0);
        return best;
    }

    static void collectEditable(AccessibilityNodeInfo n, List<AccessibilityNodeInfo> out, int depth) {
        if (n.isEditable() && n.isVisibleToUser()) out.add(n);
        for (int i = 0; i < n.getChildCount() && depth < 60 && out.size() < 50; i++) {
            AccessibilityNodeInfo c = n.getChild(i);
            if (c != null) collectEditable(c, out, depth + 1);
        }
    }

    static String textOf(AccessibilityNodeInfo f) {
        boolean hint = Build.VERSION.SDK_INT >= 26 && f.isShowingHintText();
        return f.getText() == null || hint ? "" : f.getText().toString();
    }

    static int selEnd(AccessibilityNodeInfo f, String cur) {
        int b = f.getTextSelectionEnd();
        return b < 0 || b > cur.length() ? cur.length() : b;
    }

    /** cur with s at the cursor, replacing any selection; a password field's text can't be read, so s alone. */
    static String insertAt(AccessibilityNodeInfo f, String cur, String s) {
        if (f.isPassword()) return s;
        int a = f.getTextSelectionStart(), b = selEnd(f, cur);
        if (a < 0 || a > cur.length()) a = cur.length();
        if (b < a) b = a;
        return cur.substring(0, a) + s + cur.substring(b);
    }

    static boolean changed(AccessibilityNodeInfo f, String before) {
        SystemClockSleep.ms(120);
        f.refresh();
        return !textOf(f).equals(before);
    }

    static void cursorTo(AccessibilityNodeInfo f, int at) {
        Bundle sel = new Bundle();
        sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, at);
        sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, at);
        f.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel);
    }

    static boolean isAscii(String s) {
        for (int i = 0; i < s.length(); i++) if (s.charAt(i) > 126 || s.charAt(i) < 32 && s.charAt(i) != '\n') return false;
        return true;
    }

    /** Through the clipboard, put back as it was afterwards. Null when pasted, else why not. */
    static String paste(AccessibilityNodeInfo f, String s) {
        android.content.ClipboardManager cm;
        try {
            Constructor<android.content.ClipboardManager> k =
                    android.content.ClipboardManager.class.getDeclaredConstructor(Context.class, Handler.class);
            k.setAccessible(true);
            cm = k.newInstance(ctx, new Handler(Looper.getMainLooper()));
        } catch (Throwable t) {
            return "no clipboard (" + why(t) + ")";
        }
        android.content.ClipData old = null;
        try { old = cm.getPrimaryClip(); } catch (Throwable ignored) { /* can't keep it then */ }
        try {
            cm.setPrimaryClip(android.content.ClipData.newPlainText("DroidAgent", s));
            if (!f.performAction(AccessibilityNodeInfo.ACTION_PASTE)) return "refused";
            return null;
        } catch (Throwable t) {
            return why(t);
        } finally {
            SystemClockSleep.ms(150);
            try {
                if (old != null) cm.setPrimaryClip(old);
                else if (Build.VERSION.SDK_INT >= 28) cm.clearPrimaryClip();
            } catch (Throwable ignored) { /* left as it is */ }
        }
    }

    /** Key presses addressed to display d only. Null when sent, else why not. */
    static String pressKeys(int d, String s) {
        try {
            android.view.KeyEvent[] evs = android.view.KeyCharacterMap.load(android.view.KeyCharacterMap.VIRTUAL_KEYBOARD)
                    .getEvents(s.toCharArray());
            if (evs == null) return "no keys for these characters";
            Object im;
            try {
                im = Class.forName("android.hardware.input.InputManagerGlobal").getMethod("getInstance").invoke(null);
            } catch (Throwable t) {
                im = Class.forName("android.hardware.input.InputManager").getMethod("getInstance").invoke(null);
            }
            Method inject = im.getClass().getMethod("injectInputEvent", android.view.InputEvent.class, int.class);
            Method setDisplay = android.view.KeyEvent.class.getMethod("setDisplayId", int.class);
            for (android.view.KeyEvent e : evs) {
                android.view.KeyEvent k = android.view.KeyEvent.changeTimeRepeat(e, android.os.SystemClock.uptimeMillis(), 0);
                setDisplay.invoke(k, d);
                inject.invoke(im, k, 2); // wait until it has been handled
            }
            return null;
        } catch (Throwable t) {
            return why(t);
        }
    }

    static String call(String line) throws IOException {
        LocalSocket s = new LocalSocket();
        try {
            s.connect(new android.net.LocalSocketAddress(SOCKET));
            s.getOutputStream().write((line + "\n").getBytes(StandardCharsets.UTF_8));
            return new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8)).readLine();
        } finally {
            s.close();
        }
    }

    static String join(String[] a, int from) {
        StringBuilder b = new StringBuilder();
        for (int i = from; i < a.length; i++) b.append(i > from ? " " : "").append(a[i]);
        return b.toString();
    }

    static String decode(String b64) {
        return new String(Base64.decode(b64, Base64.DEFAULT), StandardCharsets.UTF_8);
    }

    static String why(Throwable t) {
        Throwable c = t;
        while ((c instanceof InvocationTargetException || c.getCause() != null && c.getMessage() == null) && c.getCause() != null) c = c.getCause();
        return c.getClass().getSimpleName() + ": " + c.getMessage();
    }

    // ------------------------------------------------------------------ helpers

    /** Calls go out as the shell package, which root or the shell user may speak for. */
    public static final class ShellContext extends ContextWrapper {
        ShellContext(Context base) { super(base); }
        @Override public String getPackageName() { return "com.android.shell"; }
        @Override public String getOpPackageName() { return "com.android.shell"; }
        @Override public Context getApplicationContext() { return this; }
    }

    /** For UiAutomation builds that take a context: its callbacks must land on a looper that runs. */
    public static final class LooperContext extends ContextWrapper {
        final Looper looper;
        LooperContext(Context base, Looper looper) { super(base); this.looper = looper; }
        @Override public Looper getMainLooper() { return looper; }
    }

    /** Keeps the newest frame the display drew. */
    public static final class Frames implements ImageReader.OnImageAvailableListener {
        Image latest;
        volatile long count;

        @Override
        public void onImageAvailable(ImageReader r) {
            Image im;
            try {
                im = r.acquireLatestImage();
            } catch (IllegalStateException e) {
                return;
            }
            if (im == null) return;
            synchronized (this) {
                if (latest != null) latest.close();
                latest = im;
                count++;
            }
        }

        synchronized Bitmap bitmap() {
            if (latest == null) return null;
            Image.Plane p = latest.getPlanes()[0];
            int ps = p.getPixelStride(), rs = p.getRowStride(), w = latest.getWidth(), h = latest.getHeight();
            // The last row may be cut short of the stride; copy into a buffer of the full size.
            ByteBuffer src = p.getBuffer();
            src.rewind();
            byte[] all = new byte[rs * h];
            src.get(all, 0, Math.min(src.remaining(), all.length));
            Bitmap b = Bitmap.createBitmap(rs / ps, h, Bitmap.Config.ARGB_8888);
            b.copyPixelsFromBuffer(ByteBuffer.wrap(all));
            return rs / ps == w ? b : Bitmap.createBitmap(b, 0, 0, w, h);
        }
    }

    /** One accessibility connection, open only while it is needed: there can be one at a time. */
    public static final class Ua {
        HandlerThread thread;
        UiAutomation ua;

        static Ua open() throws Exception {
            Ua u = new Ua();
            u.thread = new HandlerThread("ui");
            u.thread.start();
            Class<?> ic = Class.forName("android.app.IUiAutomationConnection");
            Object conn = Class.forName("android.app.UiAutomationConnection").getDeclaredConstructor().newInstance();
            Constructor<UiAutomation> k;
            try {
                k = UiAutomation.class.getDeclaredConstructor(Looper.class, ic);
                k.setAccessible(true);
                u.ua = k.newInstance(u.thread.getLooper(), conn);
            } catch (NoSuchMethodException e) {
                k = UiAutomation.class.getDeclaredConstructor(Context.class, ic);
                k.setAccessible(true);
                u.ua = k.newInstance(new LooperContext(ctx, u.thread.getLooper()), conn);
            }
            Method connect = UiAutomation.class.getDeclaredMethod("connect", int.class);
            connect.setAccessible(true);
            // 1 = FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES: the owner's own services keep running.
            for (int i = 0; ; i++) {
                try {
                    connect.invoke(u.ua, 1);
                    break;
                } catch (InvocationTargetException e) {
                    // Someone else holds the one connection (uiautomator dump, say): wait for it.
                    if (!(e.getCause() instanceof IllegalStateException) || i >= 15) {
                        u.thread.quitSafely();
                        throw e;
                    }
                    Thread.sleep(300);
                }
            }
            AccessibilityServiceInfo info = u.ua.getServiceInfo();
            if (info != null) {
                info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
                        | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
                        | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
                u.ua.setServiceInfo(info);
            }
            return u;
        }

        /** The windows on a display from the front, down to and including the active one. */
        List<AccessibilityWindowInfo> windows(int d) {
            try { ua.waitForIdle(150, 2000); } catch (TimeoutException ignored) { /* animating: take it as it is */ }
            List<AccessibilityWindowInfo> found = null;
            for (int i = 0; i < 10 && (found == null || found.isEmpty()); i++) {
                SparseArray<List<AccessibilityWindowInfo>> all = ua.getWindowsOnAllDisplays();
                found = all == null ? null : all.get(d);
                if (found == null || found.isEmpty()) SystemClockSleep.ms(150);
            }
            List<AccessibilityWindowInfo> wins = found == null ? new ArrayList<AccessibilityWindowInfo>() : new ArrayList<AccessibilityWindowInfo>(found);
            // Front first. By hand: a Comparator gets a bridge method, which this build's d8 can't take.
            for (int i = 1; i < wins.size(); i++) {
                for (int j = i; j > 0 && wins.get(j).getLayer() > wins.get(j - 1).getLayer(); j--) {
                    wins.set(j - 1, wins.set(j, wins.get(j - 1)));
                }
            }
            List<AccessibilityWindowInfo> out = new ArrayList<AccessibilityWindowInfo>();
            for (AccessibilityWindowInfo w : wins) {
                int t = w.getType();
                if (t == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY || t == 6 /* magnification */) continue;
                out.add(w);
                if (t == AccessibilityWindowInfo.TYPE_APPLICATION && (w.isActive() || w.isFocused())) break;
            }
            return out;
        }

        void close() {
            try {
                Method d = UiAutomation.class.getDeclaredMethod("disconnect");
                d.setAccessible(true);
                d.invoke(ua);
            } catch (Throwable ignored) { /* the process may exit anyway */ }
            thread.quitSafely();
        }
    }

    public static final class SystemClockSleep {
        static void ms(long ms) {
            try { Thread.sleep(ms); } catch (InterruptedException ignored) { /* */ }
        }
    }

    /** Closes the screen when nobody has used it for a while: a forgotten app shouldn't run on unseen. */
    public static final class Watchdog implements Runnable {
        @Override
        public void run() {
            while (true) {
                SystemClockSleep.ms(30000);
                if (System.currentTimeMillis() - lastUse > IDLE_MS) finish();
            }
        }
    }
}
