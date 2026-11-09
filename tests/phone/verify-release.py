"""Checks a published release: the APK, the update package and the update channel.
Usage (Windows, from the repository): python -I tests/phone/verify-release.py <version> <empty download dir>
Needs gh signed in, and the Android SDK's build-tools 34 for aapt2 and apksigner."""
import hashlib
import io
import json
import os
import subprocess
import sys
import tarfile
import zipfile

VER, OUT = sys.argv[1], sys.argv[2]
GH = r'C:\Program Files\GitHub CLI\gh.exe'
REPO_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BT = os.path.expanduser(r'~\AppData\Local\Android\Sdk\build-tools\34.0.0')
CERT = 'b9aeb82c05b52451875d9956d25eb6a51b924de807c8683f3ac55890215e111c'
WEB_CACHE = 'droidagent-v20'
ok = True


def check(name, cond, detail=''):
    global ok
    ok &= bool(cond)
    print(('PASS ' if cond else 'FAIL ') + name + (f'  <- {detail}' if detail and not cond else ''))


os.makedirs(OUT, exist_ok=True)
assert not os.listdir(OUT), 'download dir must be empty'
subprocess.run([GH, 'release', 'download', f'v{VER}', '-D', OUT], cwd=REPO_DIR, check=True)
subprocess.run([GH, 'release', 'download', 'update-channel', '-p', 'latest.json', '-D', OUT], cwd=REPO_DIR, check=True)
apk = os.path.join(OUT, f'DroidAgent-{VER}.apk')
upd = os.path.join(OUT, f'DroidAgent-update-{VER}.zip')
print('files:', sorted(os.listdir(OUT)))

# --- APK
badge = subprocess.run([os.path.join(BT, 'aapt2.exe'), 'dump', 'badging', apk], capture_output=True, text=True).stdout
check('APK version', f"versionName='{VER}'" in badge, badge[:200])
certs = subprocess.run([os.path.join(BT, 'apksigner.bat'), 'verify', '--print-certs', apk], capture_output=True, text=True, shell=True)
check('APK signature verifies', certs.returncode == 0, certs.stderr[:300])
check('signed with the usual key', CERT in certs.stdout.replace(':', '').lower(), certs.stdout[:300])

z = zipfile.ZipFile(apk)
dex = z.read('classes.dex')
check('overlay hides on request', b'com.droidagent.app.OVERLAY_HIDE' in dex)
check('overlay skips screenshots', b'setSkipScreenshot' in dex)
check('overlay polls less when idle', b'pollDelay' in dex)
check('background screen helper', b'droidagent-bgscreen' in dex and b'getAllRootTaskInfosOnDisplay' in dex)
check('typing without a keyboard', all(m in dex for m in (b'typeText', b'pressKeys', b'pasteKey', b'typeBlind', b'setDisplayId')))
check('apps by name', b'listApps' in dex and b'firstInstallTime' in dex)
check('no synthetic classes', b'-$$Lambda' not in dex and b'$$ExternalSynthetic' not in dex)
tar_name = next((n for n in z.namelist() if n.endswith('agent-app.tar')), None)
check('app bundle inside', tar_name)


def tar_checks(raw, where):
    t = tarfile.open(fileobj=io.BytesIO(raw))
    members = t.getnames()
    top = sorted({m.split('/')[0] for m in members if m and m != '.'})
    check(f'{where}: top level', top == ['server', 'skills', 'tools', 'web'], top)
    read = lambda p: t.extractfile(p).read().decode('utf-8', 'replace')
    srv, mk, sw, idx = read('server/server.mjs'), read('server/market.mjs'), read('web/sw.js'), read('web/index.html')
    check(f'{where}: web cache bumped', WEB_CACHE in sw)
    check(f'{where}: compatible plugin catalog', 'writeCompatMarket' in srv and "'droidagent-plugins'" in mk)
    check(f'{where}: background screen', '/api/bgscreen/frame' in srv and 'BG_IDLE_MS' in srv and 'btn-show' in read('web/overlay.html'))
    check(f'{where}: notes across conversations', '/api/memory' in srv and 'loadMemory()' in srv and 'page-memory' in idx)
    check(f'{where}: finished conversations let go', 'reapIdle' in srv and 'IDLE_KEEP' in srv)
    check(f'{where}: apps by name', 'BgScreen apps' in srv)
    droid = read('tools/bin/droid')
    check(f'{where}: droid', all(s in droid for s in ('droidagent-bgscreen', 'last_tap', '--id', 'resolve_app', 'OVERLAY_HIDE'))
          and t.getmember('tools/bin/droid').mode == 0o755)
    check(f'{where}: skill', '后台屏幕' in read('skills/screen-automation/SKILL.md') and 'droid app 应用名' in read('skills/screen-automation/SKILL.md'))
    bad = [m for m in members if m.endswith('agent-system-prompt.md') or '/synced/' in m or m.endswith('agent-settings.json') or m.endswith('memory.md')]
    check(f'{where}: nothing private bundled', not bad, bad)


tar_checks(z.read(tar_name), 'APK')
u = zipfile.ZipFile(upd)
inner = next((n for n in u.namelist() if n.endswith('agent-app.tar')), None)
check('update package has the app', inner)
if inner:
    tar_checks(u.read(inner), 'update')

# --- update channel
lj = json.load(open(os.path.join(OUT, 'latest.json'), encoding='utf-8'))
data = open(apk, 'rb').read()
check('channel: version', lj.get('version') == VER, lj)
check('channel: size and hash match the APK', lj.get('size') == len(data) and lj.get('sha256') == hashlib.sha256(data).hexdigest())
check('channel: points at this release', lj.get('apk', '').endswith(f'/v{VER}/DroidAgent-{VER}.apk'), lj.get('apk'))
print('ALL OK' if ok else 'SOMETHING FAILED')
