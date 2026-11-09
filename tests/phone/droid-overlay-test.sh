#!/bin/bash
# droid on the owner's screen: hiding the floating windows around screenshots and taps, with a fake
# ashell that only records what it was asked to run. Run in WSL: bash droid-overlay-test.sh
# Pillow goes into a throwaway folder (droid's screenshot needs it; the phone has it).
set -u
export HTTPS_PROXY=${HTTPS_PROXY:-http://127.0.0.1:7890} HTTP_PROXY=${HTTP_PROXY:-http://127.0.0.1:7890}
LIB=/tmp/droid-test-pil
[ -d "$LIB/PIL" ] || python3 -m pip install -q --break-system-packages --target "$LIB" pillow 2>&1 | grep -v WARNING | tail -1
export PYTHONPATH="$LIB"
T=$(mktemp -d)
DROID="$(cd "$(dirname "$0")/../.." && pwd)/phone/overlay/usr/local/bin/droid"
mkdir -p "$T/bin" "$T/data" "$T/home"
export HOME="$T/home"
cat > "$T/bin/ashell" <<EOF
#!/bin/bash
echo "\$*" >> "$T/calls.log"
if [ "\$1" = screencap ]; then python3 -c "from PIL import Image; import sys; Image.new('RGB',(40,80)).save(sys.stdout.buffer,'PNG')"; fi
exit 0
EOF
chmod +x "$T/bin/ashell"
sed -e "s#/data/user_de/0/{APP_PKG}/overlay.state#$T/data/overlay.state#" -e "s#^STATE = .*#STATE = \"$T/state\"#" "$DROID" > "$T/droid"
export PATH="$T/bin:$PATH"
# What droid ran, minus the restore it sends without waiting (checked on its own below).
run() { : > "$T/calls.log"; python3 "$T/droid" "$@" > /dev/null; sleep 0.4; grep -v 'hide false' "$T/calls.log" | sed 's/ --el ms 8000//' | tr '\n' ';'; echo; }
restored() { grep -q 'hide false' "$T/calls.log"; }
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1"; echo "   got:  $2"; echo "   want: $3"; fi; }
HIDE='am broadcast -a com.droidagent.app.OVERLAY_HIDE -p com.droidagent.app --ez hide true'

python3 -c "import ast; ast.parse(open('$DROID').read())" && echo "PASS droid parses"
rm -f "$T/data/overlay.state"
check 'no state file: screenshot as before' "$(run shot)" "screencap -p;"
printf 'bubble 0 1000 600 140 140\npanel 0 0 0 0 0\nskip ok\n' > "$T/data/overlay.state"
check 'face not shown: screenshot as before' "$(run shot)" "screencap -p;"
check 'face not shown: tap as before' "$(run tap 1050 650)" "input tap 1050 650;"
printf 'bubble 1 1000 600 140 140\npanel 0 0 0 0 0\nskip ok\n' > "$T/data/overlay.state"
check 'screenshot hides the face first' "$(run shot)" "$HIDE;screencap -p;"
restored && echo 'PASS and brings it back after' || echo 'FAIL never brought back'
check 'a tap elsewhere leaves it alone' "$(run tap 200 300)" "input tap 200 300;"
restored && echo 'FAIL restored something it never hid' || echo 'PASS nothing to bring back'
check 'a tap on it hides it first' "$(run tap 1070 670)" "$HIDE;input tap 1070 670;"
restored && echo 'PASS and brings it back after' || echo 'FAIL never brought back'
check 'a swipe ending on it too' "$(run swipe 100 100 1060 660)" "$HIDE;input swipe 100 100 1060 660 300;"
check 'a long press elsewhere does not' "$(run longpress 10 10)" "input swipe 10 10 10 10 800;"
printf 'bubble 0 0 0 140 140\npanel 1 30 200 900 1400\nskip x\n' > "$T/data/overlay.state"
check 'the open panel counts too' "$(run tap 500 900)" "$HIDE;input tap 500 900;"
printf 'garbage\nbubble 1 x y\n' > "$T/data/overlay.state"
check 'a broken state file is ignored' "$(run tap 1 1)" "input tap 1 1;"
rm -rf "$T"
