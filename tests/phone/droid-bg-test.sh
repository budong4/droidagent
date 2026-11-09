#!/bin/bash
# droid with the background screen and apps by name, in WSL: a fake ashell that records what it was
# asked to run, and a fake BgScreen on the same abstract socket. Checks which screen each command
# goes to. Run in WSL: bash droid-bg-test.sh   (only one at a time: the socket name is fixed)
set -u
export HTTPS_PROXY=${HTTPS_PROXY:-http://127.0.0.1:7890} HTTP_PROXY=${HTTP_PROXY:-http://127.0.0.1:7890}
LIB=/tmp/droid-test-pil
[ -d "$LIB/PIL" ] || python3 -m pip install -q --break-system-packages --target "$LIB" pillow 2>&1 | grep -v WARNING | tail -1
export PYTHONPATH="$LIB"
T=$(mktemp -d)
DROID="$(cd "$(dirname "$0")/../.." && pwd)/phone/overlay/usr/local/bin/droid"
mkdir -p "$T/bin" "$T/data" "$T/bgdir" "$T/home/.claude"
export HOME="$T/home"

# The fake BgScreen: answers like the real one and writes what it was asked to $T/bg.log.
cat > "$T/fakebg.py" <<'PY'
import base64, json, os, socket, sys
T = sys.argv[1]
state = {"tasks": 0, "top": None, "takenOver": None}
def setpath(p, data):
    with open(p, "wb") as f: f.write(data)
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind("\0droidagent-bgscreen"); s.listen(5)
while True:
    c, _ = s.accept()
    line = c.makefile().readline().strip()
    with open(f"{T}/bg.log", "a") as f: f.write(line + "\n")
    a = line.split(" ")
    owner = open(f"{T}/owner_top").read().strip() if os.path.exists(f"{T}/owner_top") else "com.miui.home"
    if a[0] == "info":
        r = "ok " + json.dumps({"display": 7, "w": 1220, "h": 2712, "dpi": 520, "tasks": state["tasks"],
                                "top": state["top"], "activity": state["top"] and state["top"] + "/.Main",
                                "takenOver": state["takenOver"]})
    elif a[0] == "top":
        r = "ok " + (owner if a[1] == "0" else (state["top"] or "-"))
    elif a[0] == "shot":
        from PIL import Image
        Image.new("RGB", (1220, 2712), "navy").save(a[1]); r = "ok 1220 2712"
    elif a[0] == "ui":
        setpath(a[1], b'<?xml version="1.0"?><hierarchy><node text="OK" class="android.widget.Button" package="com.x" clickable="true" bounds="[100,200][300,400]"/></hierarchy>')
        r = "ok 1"
    elif a[0] == "type":
        r = "ok set"
        with open(f"{T}/typed", "w") as f: f.write(a[1] + " " + a[2] + " " + base64.b64decode(a[3]).decode())
    elif a[0] == "takeover":
        state["takenOver"], state["top"], state["tasks"] = state["top"], None, 0; r = "ok " + str(state["takenOver"])
    elif a[0] == "quit":
        c.sendall(b"ok\n"); c.close(); sys.exit(0)
    elif a[0] == "opened":   # the test's way of saying `am start --display` worked
        state["tasks"], state["top"] = 1, a[1]; r = "ok"
    else:
        r = "err unknown"
    c.sendall((r + "\n").encode()); c.close()
PY

# The phone's apps, as BgScreen's `apps` prints them.
cat > "$T/apps.json" <<'JSON'
[{"package":"com.x","name":"Xapp","activity":"com.x/.Main","system":false,"installed":1},
 {"package":"com.y","name":"Yapp","activity":"com.y/.Main","system":false,"installed":1},
 {"package":"com.z","name":"Zapp","activity":"com.z/.Main","system":false,"installed":1},
 {"package":"com.tencent.mm","name":"微信","activity":"com.tencent.mm/.ui.LauncherUI","system":false,"installed":1},
 {"package":"com.android.settings","name":"设置","activity":"com.android.settings/.Settings","system":true,"installed":1}]
JSON

cat > "$T/bin/ashell" <<EOF
#!/bin/bash
echo "\$*" >> "$T/calls.log"
case "\$1 \$2" in
  "pm path") [ "\$3" = com.droidagent.app ] && echo "package:/data/app/~~x/com.droidagent.app-y/base.apk"; exit 0 ;;
  "wm size") echo "Physical size: 1220x2712"; exit 0 ;;
  "wm density") echo "Physical density: 520"; exit 0 ;;
esac
if [ "\$1" = sh ] && [[ "\$3" == *" apps" ]]; then tr -d '\n' < "$T/apps.json"; echo; exit 0; fi
if [ "\$1" = sh ] && [[ "\$3" == *" serve "* ]]; then
  if [ -f "$T/broken" ]; then echo 'java.lang.SecurityException: not allowed' > "$T/bgdir/helper.log"; exit 0; fi
  python3 "$T/fakebg.py" "$T" >/dev/null 2>>"$T/fakebg.err" &
  exit 0
fi
if [ "\$1" = sh ] && [[ "\$3" == *" type "* ]]; then echo "ok set"; exit 0; fi
if [ "\$1" = am ] && [ "\$2" = start ] && [ "\$3" = --display ]; then
  python3 - "\$6" <<'PY2'
import socket, sys
s = socket.socket(socket.AF_UNIX); s.connect("\0droidagent-bgscreen"); s.sendall(("opened " + sys.argv[1].split("/")[0] + "\n").encode()); s.recv(100)
PY2
fi
if [ "\$1" = screencap ]; then python3 -c "from PIL import Image; import sys; Image.new('RGB',(40,80)).save(sys.stdout.buffer,'PNG')"; fi
exit 0
EOF
chmod +x "$T/bin/ashell"
sed -e "s#/data/user_de/0/{APP_PKG}/overlay.state#$T/data/overlay.state#" -e "s#^BG_DIR = .*#BG_DIR = \"$T/bgdir\"#" \
    -e "s#^STATE = .*#STATE = \"$T/state\"#" "$DROID" > "$T/droid"
export PATH="$T/bin:$PATH"
SERVE="sh -c CLASSPATH=\"\$0\" exec app_process /system/bin com.droidagent.app.BgScreen serve 1220 2712 520 > $T/bgdir/helper.log 2>&1 /data/app/~~x/com.droidagent.app-y/base.apk"
calls() { : > "$T/calls.log"; python3 "$T/droid" "$@" > "$T/out.txt" 2>&1; echo $? > "$T/code"; sleep 0.3
  grep -v '^pm path com.droidagent.app$\|^wm size$\|^wm density$\|BgScreen apps ' "$T/calls.log" | tr '\n' ';'; echo; }
said() { grep -q -- "$1" "$T/out.txt"; }
failed() { [ "$(cat "$T/code")" != 0 ]; }
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1"; echo "   got:  $2"; echo "   want: $3"; sed 's/^/   out: /' "$T/out.txt" | head -5; fi; }
ok() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; sed 's/^/   out: /' "$T/out.txt" | head -5; fi; }
stopbg() { python3 -c "
import socket
try:
    s = socket.socket(socket.AF_UNIX); s.connect('\0droidagent-bgscreen'); s.sendall(b'quit\n'); s.recv(10)
except OSError: pass"; sleep 0.3; }

python3 -c "import ast; ast.parse(open('$DROID').read())" && echo "PASS droid parses"
stopbg

echo '=== apps by name'
calls apps >/dev/null
ok 'apps lists names and packages' "said \$'微信\tcom.tencent.mm' && said \$'设置\tcom.android.settings\t(system)'"
calls apps 微 >/dev/null
ok 'apps WORD searches names' "said 'com.tencent.mm' && ! said 'com.x'"
calls apps tencent >/dev/null
ok 'and packages' "said '微信'"
calls app nothing-like-this >/dev/null
ok 'an unknown name says so' "failed && said 'no app called'"
calls app app >/dev/null
ok 'an unclear name lists the choices' "failed && said 'could be any of these' && said 'Xapp  com.x'"

echo '=== it cannot start'
touch "$T/broken"
check 'falls back to the owner screen' "$(calls app Xapp)" "$SERVE;am start -n com.x/.Main;"
ok 'and says why' "said 'no background screen (java.lang.SecurityException: not allowed)'"
rm "$T/broken"

echo '=== on by default'
check 'app by name opens on the background screen' "$(calls app 微信)" "$SERVE;am start --display 7 -n com.tencent.mm/.ui.LauncherUI;"
ok 'and says the owner keeps their screen' "said 'on the background screen'"
check 'by package too' "$(calls app com.z)" "am start --display 7 -n com.z/.Main;"
echo com.y > "$T/owner_top"
check 'an app the owner is using is not taken' "$(calls app Yapp)" ""
ok 'and that is an error that says to ask' "failed && said 'Ask them first'"
rm "$T/owner_top"
printf 'bubble 1 1000 600 140 140\npanel 0 0 0 0 0\nskip ok\n' > "$T/data/overlay.state"
check 'tap goes there, without hiding the face' "$(calls tap 1050 650)" "input -d 7 tap 1050 650;"
check 'swipe too' "$(calls swipe 1 2 3 4)" "input -d 7 swipe 1 2 3 4 300;"
check 'long press too' "$(calls longpress 9 9)" "input -d 7 swipe 9 9 9 9 800;"
calls tap 300 400 >/dev/null
check 'English text into the field, no keys' "$(calls text 'ab c')" ""
ok 'with where it last tapped' "[ \"\$(cat $T/typed)\" = '300 400 ab c' ] && said 'typed 4 chars (set)'"
check 'other text too' "$(calls text '你好 ok')" ""
ok 'and it arrived' "[ \"\$(cat $T/typed)\" = '300 400 你好 ok' ]"
check 'back goes there' "$(calls key back)" "input -d 7 keyevent KEYCODE_BACK;"
check 'enter goes there' "$(calls key enter)" "input -d 7 keyevent KEYCODE_ENTER;"
check 'power is the phone' "$(calls key power)" "input keyevent KEYCODE_POWER;"
check 'home is refused' "$(calls key home)" ""
ok 'with a way out' "failed && said 'droid bg stop'"
check 'screenshot from BgScreen, no screencap' "$(calls shot)" ""
ok 'marked as the background screen' "said 'device 1220x2712' && said 'background screen'"
check 'controls from BgScreen' "$(calls ui)" ""
ok 'listed' "said '# background screen  app=com.x' && said '\[0\] Button \"OK\" @(200,300)'"
ok 'ui says no keyboard is normal' "said 'no keyboard ever shows here'"
check 'tap-id taps there' "$(calls tap-id 0)" "input -d 7 tap 200 300;"
check 'text --id taps the field, then types into it' "$(calls text 'hi' --id 0)" "input -d 7 tap 200 300;"
ok 'aimed at that field' "[ \"\$(cat $T/typed)\" = '200 300 hi' ]"
check 'text --at too' "$(calls text 'yo' --at 50 60)" "input -d 7 tap 50 60;"
ok 'aimed there' "[ \"\$(cat $T/typed)\" = '50 60 yo' ]"
ok 'top shows both screens' "calls top >/dev/null; said 'background screen: com.z/.Main' && said \"owner's screen: com.miui.home\""

echo '=== the owner takes it'
calls show >/dev/null
ok 'show moves it' "said 'moved com.z to the owner' && grep -q '^takeover$' $T/bg.log"
check 'commands still go to the empty screen, not the owner' "$(calls tap 1 1)" "input -d 7 tap 1 1;"
calls ui >/dev/null
ok 'and every look says what happened' "said 'the owner moved com.z to their own screen'"
calls app Xapp --front >/dev/null
ok '--front closes it and opens on the owner screen' "said 'closed the background screen' && grep -q '^am start -n com.x/.Main$' $T/calls.log"
check 'then commands go to the owner screen' "$(calls tap 3 3)" "input tap 3 3;"
calls app Xapp >/dev/null; calls ui >/dev/null; calls bg stop >/dev/null
ok 'bg stop closes it' "said 'closed the background screen'"
ok 'a control list of the other screen is not used' "calls tap-id 0 >/dev/null; failed && said 'other screen'"
calls bg >/dev/null
ok 'bg says it is not open' "said 'not open'"

echo '=== typing on the owner screen without ADBKeyboard'
check 'goes through BgScreen once, on display 0' "$(calls text '中文')" "sh -c CLASSPATH=\"\$0\" exec app_process /system/bin com.droidagent.app.BgScreen type 0 3 3 \"\$1\" /data/app/~~x/com.droidagent.app-y/base.apk 5Lit5paH;"
stopbg; cat "$T/fakebg.err" 2>/dev/null | tail -5
rm -rf "$T"
