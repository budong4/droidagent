"""Compiles the APK's resources and Java the way apk/build.py does, without packaging or signing,
and refuses classes this build's d8 can't take. Leaves classes.dex and test.jar in the work dir.
Usage: python -I compile_check.py <apk dir> <work dir>"""
import os
import shutil
import subprocess
import sys
import zipfile

apk_dir, work = sys.argv[1], sys.argv[2]
sdk = os.path.expanduser("~/AppData/Local/Android/Sdk")
bt = os.path.join(sdk, "build-tools", "34.0.0")
jar = os.path.join(sdk, "platforms", "android-34", "android.jar")
exe = ".exe" if os.name == "nt" else ""
bat = ".bat" if os.name == "nt" else ""
shutil.rmtree(work, ignore_errors=True)
for d in ("gen", "obj", "dex"):
    os.makedirs(os.path.join(work, d))


def run(args, what):
    r = subprocess.run(args, cwd=apk_dir, capture_output=True, text=True)
    out = (r.stdout + r.stderr).strip()
    print(f"== {what}: exit {r.returncode}")
    if r.returncode and out:
        print(out[-4000:])
    if r.returncode:
        sys.exit(1)


run([os.path.join(bt, "aapt2" + exe), "compile", "--dir", "res", "-o", os.path.join(work, "res.zip")], "aapt2 compile")
run([os.path.join(bt, "aapt2" + exe), "link", "-o", os.path.join(work, "base.apk"), "-I", jar, "--manifest", "AndroidManifest.xml",
     "--java", os.path.join(work, "gen"), "--auto-add-overlay", os.path.join(work, "res.zip")], "aapt2 link")
java = [os.path.join(r, f) for base in (os.path.join(apk_dir, "src"), os.path.join(work, "gen")) for r, _, fs in os.walk(base) for f in fs if f.endswith(".java")]
run(["javac", "-Xlint:-options", "-source", "8", "-target", "8", "-d", os.path.join(work, "obj"), "-cp", jar, *java], "javac")
classes = [os.path.join(r, f) for r, _, fs in os.walk(os.path.join(work, "obj")) for f in fs if f.endswith(".class")]
synthetic = [c for c in classes if "$$" in os.path.basename(c) or "-$" in os.path.basename(c)]
print("classes:", len(classes), "synthetic:", synthetic)
if synthetic:
    sys.exit("synthetic classes: d8 here can't take them (no lambdas, anonymous classes or generic interfaces)")
run([os.path.join(bt, "d8" + bat), "--output", os.path.join(work, "dex"), "--min-api", "26", "--lib", jar, *classes], "d8")
dex = os.path.join(work, "dex", "classes.dex")
with zipfile.ZipFile(os.path.join(work, "test.jar"), "w") as z:
    z.write(dex, "classes.dex")
print("dex:", os.path.getsize(dex), "bytes; test.jar written")
