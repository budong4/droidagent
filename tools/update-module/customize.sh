# DroidAgent in-place update, flashed from the root manager (KernelSU / Magisk / APatch).
#
# Updates what lives inside the already-unpacked Linux system — the chat app (server + web), the
# Node runtime for Claude Code, and the launcher — without reinstalling the APK, so nothing is
# lost: the Linux system, the login and the conversations all stay. The APK's own parts (icon,
# startup screen) still need the APK.
#
# Nothing stays installed as a module: it removes itself on the next reboot.
SKIPUNZIP=1

PKG=com.droidagent.app
APKDIR=${DROIDAGENT_APK_DIR:-/data/user_de/0/$PKG}
ROOT=$APKDIR/rootfs
APP=$ROOT/usr/local/share/agent-app
WORK=${TMPDIR:-/dev/tmp}/droidagent-update
LAUNCHER=$APKDIR/bin/debian
# Tell the launcher which app it serves instead of having it infer that from its own path.
export AGENT_APK_DIR="$APKDIR"

ui_print "- DroidAgent 更新包"
[ -x "$ROOT/usr/bin/bash" ] || abort "! 没找到 DroidAgent 的 Linux 系统（$ROOT）。请先安装并打开过一次 DroidAgent。"
[ -d "$APP/server" ] || abort "! 没找到聊天程序目录（$APP）。"

rm -rf "$WORK"
mkdir -p "$WORK" || abort "! 无法创建临时目录 $WORK"
unzip -o "$ZIPFILE" 'payload/*' module.prop -d "$WORK" >&2 || abort "! 解压更新包失败"
cp "$WORK/module.prop" "$MODPATH/module.prop"

# Keep the version being replaced, so it can be put back by hand if needed.
BAK=$APP.bak-$(date +%Y%m%d-%H%M%S)
mkdir -p "$BAK/server" || abort "! 无法备份旧版本"
cp -R "$APP/web" "$BAK/" 2>/dev/null
for f in "$APP"/server/*; do
	case ${f##*/} in node_modules | legacy-sdk) ;; *) cp -R "$f" "$BAK/server/" ;; esac
done
ui_print "- 旧版本已备份到 ${BAK#$ROOT}"

ui_print "- 正在更新启动器"
mkdir -p "$APKDIR/bin"
cp "$WORK/payload/debian" "$LAUNCHER.new" && chmod 755 "$LAUNCHER.new" && mv -f "$LAUNCHER.new" "$LAUNCHER" ||
	abort "! 启动器更新失败"

# The launcher's own sync: same code the app runs on launch, so both paths install alike.
ui_print "- 正在更新聊天程序和 Node 运行时"
RUNTIME=$WORK/payload/legacy-runtime.tar.xz
[ -f "$RUNTIME" ] || RUNTIME=
if ! sh "$LAUNCHER" sync "$WORK/payload/agent-app.tar" "$RUNTIME" >"$WORK/sync.log" 2>&1; then
	tail -n 5 "$WORK/sync.log" | while read -r line; do ui_print "  $line"; done
	abort "! 更新失败（旧版本在 ${BAK#$ROOT}）"
fi

ui_print "- 正在重启助手服务"
LOG=$ROOT/var/log/agent-app.log
if sh "$LAUNCHER" app restart >"$WORK/restart.log" 2>&1; then
	# The server tries each way of running Claude Code on startup; report what it settled on.
	n=0
	while [ "$n" -lt 90 ] && ! grep -q '\[runtime\] chat via' "$LOG" 2>/dev/null; do sleep 1; n=$((n + 1)); done
	choice=$(grep '\[runtime\] chat via' "$LOG" 2>/dev/null | tail -n 1 | sed 's/.*chat via //')
	case $choice in
		"") ui_print "- 服务已重启（还在检测运行方式，稍后打开 App 即可）" ;;
		NOTHING*)
			ui_print "! 服务已重启，但这台手机上没有能运行的 Claude Code："
			grep '\[runtime\] ' "$LOG" | tail -n 2 | head -n 1 | sed 's/.*\[runtime\] //' | tr '|' '\n' |
				while read -r line; do ui_print "  $line"; done
			;;
		*) ui_print "- 服务已重启，Claude Code 运行方式：$choice" ;;
	esac
else
	ui_print "! 服务没能自动重启："
	tail -n 5 "$WORK/restart.log" | while read -r line; do ui_print "  $line"; done
	ui_print "  重启手机后打开 DroidAgent，点「一键启动后台服务」即可"
fi

# A little about this phone, for diagnosing startup crashes of the native claude.
ui_print "- 设备信息：内核 $(uname -r)，页大小 $(getconf PAGESIZE 2>/dev/null || echo ?)，栈地址 $(grep -m1 '\[stack\]' /proc/self/maps | cut -d' ' -f1)"

touch "$MODPATH/remove" "$MODPATH/skip_mount"
rm -rf "$WORK"
ui_print "- 完成。回到 DroidAgent，点「刷新重试」或重新打开 App"
