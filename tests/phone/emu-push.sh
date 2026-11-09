#!/bin/bash
# Compile the app's Java, push it to a running emulator as /data/local/tmp/da.jar (as root), so
# BgScreen can be tried there:  CLASSPATH=/data/local/tmp/da.jar app_process /system/bin com.droidagent.app.BgScreen ...
# Run from Git Bash on the PC. Needs JDK 21 and the Android SDK (build-tools 34, platform 34).
set -u
D="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$D/../.." && pwd)"
SDK=/c/Users/28937/AppData/Local/Android/Sdk
A="$SDK/platform-tools/adb.exe"
W="${TMP:-/tmp}/da-apkbuild"
export PATH="/d/Java/jdk-21/bin:$PATH" MSYS_NO_PATHCONV=1
python -I "$(cygpath -w "$D/compile_check.py")" "$(cygpath -w "$REPO/apk")" "$(cygpath -w "$W")" || exit 1
"$A" root >/dev/null; sleep 2
"$A" push "$(cygpath -w "$W/test.jar")" /data/local/tmp/da.jar >/dev/null && echo "pushed to /data/local/tmp/da.jar"
