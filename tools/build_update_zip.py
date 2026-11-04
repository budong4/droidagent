#!/usr/bin/env python3
"""Build DroidAgent-update.zip: a root-manager (KernelSU / Magisk / APatch) package that updates
the chat app and launcher inside an existing install, from the phone alone — no PC, no APK
reinstall, nothing lost.

    python tools/build_update_zip.py [output.zip]
"""
import os
import re
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "apk"))
from app_bundle import build_app_bundle, write_lf  # noqa: E402


def manifest_version():
    with open(os.path.join(REPO, "apk", "AndroidManifest.xml"), encoding="utf-8") as f:
        text = f.read()
    name = re.search(r'android:versionName="([^"]+)"', text).group(1)
    code = re.search(r'android:versionCode="(\d+)"', text).group(1)
    return name, code


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, "DroidAgent-update.zip")
    name, code = manifest_version()
    mod = os.path.join(HERE, "update-module")
    with tempfile.TemporaryDirectory() as tmp:
        bundle = build_app_bundle(os.path.join(tmp, "agent-app.tar"), REPO)
        launcher = write_lf(os.path.join(REPO, "phone", "debian"), os.path.join(tmp, "debian"))
        prop = (f"id=droidagent_update\nname=DroidAgent 更新 {name}\nversion={name}\nversionCode={code}\n"
                f"author=DroidAgent\ndescription=把 DroidAgent 的聊天程序和启动器更新到 {name}。"
                f"装完即生效，重启后自动移除，不会留下模块。\n")
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for rel in ("META-INF/com/google/android/update-binary",
                        "META-INF/com/google/android/updater-script", "customize.sh"):
                src = write_lf(os.path.join(mod, rel), os.path.join(tmp, os.path.basename(rel)))
                z.write(src, rel)
            z.writestr("module.prop", prop)
            z.write(bundle, "payload/agent-app.tar")
            z.write(launcher, "payload/debian")
    print(f"[+] {out} ({os.path.getsize(out) / 1024:.0f} KB, version {name})")


if __name__ == "__main__":
    main()
