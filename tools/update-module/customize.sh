# DroidAgent in-place update, flashed from the root manager (KernelSU / Magisk / APatch).
#
# Updates what lives inside the already-unpacked Linux system — the chat app (server + web) and
# the launcher — without reinstalling the APK, so nothing is lost: the Linux system, the login
# and the conversations all stay. The APK's own parts (icon, startup screen) still need the APK.
#
# Nothing stays installed as a module: it removes itself on the next reboot.
SKIPUNZIP=1

PKG=com.droidagent.app
APKDIR=${DROIDAGENT_APK_DIR:-/data/user_de/0/$PKG}
ROOT=$APKDIR/rootfs
APP=$ROOT/usr/local/share/agent-app
WORK=${TMPDIR:-/dev/tmp}/droidagent-update

ui_print "- DroidAgent 更新包"
[ -x "$ROOT/usr/bin/bash" ] || abort "! 没找到 DroidAgent 的 Linux 系统（$ROOT）。请先安装并打开过一次 DroidAgent。"
[ -d "$APP/server" ] || abort "! 没找到聊天程序目录（$APP）。"

rm -rf "$WORK"
mkdir -p "$WORK/app" || abort "! 无法创建临时目录 $WORK"
unzip -o "$ZIPFILE" 'payload/*' module.prop -d "$WORK" >&2 || abort "! 解压更新包失败"
tar -xf "$WORK/payload/agent-app.tar" -C "$WORK/app" || abort "! 更新包里的聊天程序已损坏"
[ -f "$WORK/app/server/server.mjs" ] && [ -f "$WORK/app/web/index.html" ] || abort "! 更新包内容不完整"
cp "$WORK/module.prop" "$MODPATH/module.prop"

# Keep the version being replaced, so it can be put back by hand if needed.
BAK=$APP.bak-$(date +%Y%m%d-%H%M%S)
mkdir -p "$BAK/server" || abort "! 无法备份旧版本"
cp -R "$APP/web" "$BAK/" 2>/dev/null
for f in "$APP"/server/*; do
	[ "${f##*/}" = node_modules ] || cp -R "$f" "$BAK/server/"
done
ui_print "- 旧版本已备份到 ${BAK#$ROOT}"

# server/: overwrite files, keep node_modules. web/: replace as a whole.
ui_print "- 正在更新聊天程序"
cp -R "$WORK/app/server/." "$APP/server/" || abort "! 更新后台程序失败（旧版本在 $BAK）"
rm -rf "$APP/web.new"
cp -R "$WORK/app/web" "$APP/web.new" || abort "! 更新界面文件失败"
rm -rf "$APP/web" && mv "$APP/web.new" "$APP/web" || abort "! 更新界面文件失败（旧版本在 $BAK）"

if [ -d "$APKDIR/bin" ]; then
	ui_print "- 正在更新启动器"
	cp "$WORK/payload/debian" "$APKDIR/bin/debian.new" && chmod 755 "$APKDIR/bin/debian.new" &&
		mv -f "$APKDIR/bin/debian.new" "$APKDIR/bin/debian" || ui_print "! 启动器没有更新（不影响聊天程序）"
fi
sync

ui_print "- 正在重启助手服务"
if sh "$APKDIR/bin/debian" app restart >"$WORK/restart.log" 2>&1; then
	ui_print "- 服务已重启"
else
	ui_print "! 服务没能自动重启："
	tail -n 5 "$WORK/restart.log" | while read -r line; do ui_print "  $line"; done
	ui_print "  重启手机后打开 DroidAgent，点「一键启动后台服务」即可"
fi

touch "$MODPATH/remove" "$MODPATH/skip_mount"
rm -rf "$WORK"
ui_print "- 完成。回到 DroidAgent，点「刷新重试」或重新打开 App"
