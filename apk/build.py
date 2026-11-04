import os
import shutil
import subprocess
import sys
import zipfile
import struct

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
BUILD_DIR = os.path.join(PROJECT_DIR, "build")

# ---- toolchain configuration (environment first, then auto-detection) -------------------
# Override any of these with env vars: ANDROID_HOME / ANDROID_SDK_ROOT, BUILD_TOOLS_VERSION,
# ANDROID_PLATFORM, JAVA_HOME. On Windows the SDK ships .exe/.bat wrappers; elsewhere plain names.
IS_WIN = os.name == "nt"
EXE = ".exe" if IS_WIN else ""
BAT = ".bat" if IS_WIN else ""


def _first_dir(paths):
    for p in paths:
        if p and os.path.isdir(p):
            return p
    return None


SDK_DIR = (os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
           or _first_dir([
               os.path.expanduser("~/AppData/Local/Android/Sdk"),   # Windows
               os.path.expanduser("~/Library/Android/sdk"),         # macOS
               os.path.expanduser("~/Android/Sdk"),                 # Linux
           ]))
if not SDK_DIR or not os.path.isdir(SDK_DIR):
    sys.exit("[!] Android SDK not found. Set ANDROID_HOME to your SDK path.")

BT_VERSION = os.environ.get("BUILD_TOOLS_VERSION")
if not BT_VERSION:
    bt_root = os.path.join(SDK_DIR, "build-tools")
    vers = sorted(os.listdir(bt_root)) if os.path.isdir(bt_root) else []
    BT_VERSION = vers[-1] if vers else "34.0.0"
BUILD_TOOLS_DIR = os.path.join(SDK_DIR, "build-tools", BT_VERSION)

ANDROID_PLATFORM = os.environ.get("ANDROID_PLATFORM", "android-34")
PLATFORMS_DIR = os.path.join(SDK_DIR, "platforms", ANDROID_PLATFORM)

AAPT2 = os.path.join(BUILD_TOOLS_DIR, "aapt2" + EXE)
D8 = os.path.join(BUILD_TOOLS_DIR, "d8" + BAT)
ZIPALIGN = os.path.join(BUILD_TOOLS_DIR, "zipalign" + EXE)
APKSIGNER = os.path.join(BUILD_TOOLS_DIR, "apksigner" + BAT)
ANDROID_JAR = os.path.join(PLATFORMS_DIR, "android.jar")

_JAVA_BIN = os.path.join(os.environ["JAVA_HOME"], "bin") if os.environ.get("JAVA_HOME") else ""
JAVAC = os.path.join(_JAVA_BIN, "javac" + EXE) if _JAVA_BIN else "javac"
KEYTOOL = os.path.join(_JAVA_BIN, "keytool" + EXE) if _JAVA_BIN else "keytool"

APP_NAME = os.environ.get("APP_NAME", "DroidAgent")

def align_apk(src, dst, alignment=4):
    """
    Rewrite `src` so every STORED entry's data starts on an `alignment` boundary.

    build-tools 34's zipalign pads with raw zero bytes, which is not a valid ZIP extra
    field (those are 2-byte id + 2-byte length + data, so 4 bytes minimum). Android 16's
    stricter zip parser ignores that malformed field, computes a different data offset and
    then rejects the APK with "resources.arsc ... must be stored uncompressed and aligned".
    Padding with a real 0xd935 Android-alignment record keeps both parsers happy.
    """
    ALIGN_ID = 0xd935
    src_f = open(src, "rb")

    entries = []
    with zipfile.ZipFile(src) as z:
        for zi in z.infolist():
            src_f.seek(zi.header_offset)
            sig, _, flags, method, mtime, mdate, crc, csize, usize, nlen, elen = struct.unpack(
                "<IHHHHHIIIHH", src_f.read(30))
            assert sig == 0x04034b50, "bad local header for " + zi.filename
            entries.append({
                "name": zi.filename.encode("utf-8"), "flags": flags, "method": method,
                "mtime": mtime, "mdate": mdate, "crc": crc, "csize": csize, "usize": usize,
                # The payload asset runs to gigabytes, so bodies are copied in chunks rather
                # than held in memory.
                "data_at": zi.header_offset + 30 + nlen + elen,
            })

    # resources.arsc goes first: as the first entry its data starts at 30 + len("resources.arsc")
    # = 44, already 4-byte aligned, so it needs no padding extra field at all. Android 16 rejected
    # every variant that relied on one, and a reader cannot disagree about an offset with no
    # padding in it. Entry order is free — lookups go through the central directory.
    entries.sort(key=lambda e: e["name"] != b"resources.arsc")

    out = open(dst, "wb")
    pos = 0
    for e in entries:
        extra = b""
        if e["method"] == 0 and e["name"] != b"resources.arsc":
            head = pos + 30 + len(e["name"])
            pad = -head % alignment
            if pad:
                # A 4-byte record is the smallest legal one, so grow the padding to fit.
                while pad < 4:
                    pad += alignment
                extra = struct.pack("<HH", ALIGN_ID, pad - 4) + b"\x00" * (pad - 4)
        e["offset"] = pos
        e["extra"] = extra
        head = struct.pack("<IHHHHHIIIHH", 0x04034b50, 20, e["flags"], e["method"],
                           e["mtime"], e["mdate"], e["crc"], e["csize"], e["usize"],
                           len(e["name"]), len(extra)) + e["name"] + extra
        out.write(head)
        pos += len(head)

        src_f.seek(e["data_at"])
        left = e["csize"]
        while left:
            chunk = src_f.read(min(left, 4 << 20))
            if not chunk:
                raise IOError("truncated entry " + e["name"].decode())
            out.write(chunk)
            left -= len(chunk)
        pos += e["csize"]

    cd_start = pos
    for e in entries:
        # Same extra field in both records: a reader that derives the data offset from the
        # central directory then agrees with one that reads the local header.
        rec = struct.pack("<IHHHHHHIIIHHHHHII", 0x02014b50, 20, 20, e["flags"], e["method"],
                          e["mtime"], e["mdate"], e["crc"], e["csize"], e["usize"],
                          len(e["name"]), len(e["extra"]), 0, 0, 0, 0, e["offset"]) \
              + e["name"] + e["extra"]
        out.write(rec)
        pos += len(rec)
    out.write(struct.pack("<IHHHHIIH", 0x06054b50, 0, 0, len(entries), len(entries),
                          pos - cd_start, cd_start, 0))
    out.close()
    src_f.close()

    with open(dst, "rb") as f, zipfile.ZipFile(dst) as z:
        zi = z.getinfo("resources.arsc")
        f.seek(zi.header_offset)
        h = struct.unpack("<IHHHHHIIIHH", f.read(30))
        off = zi.header_offset + 30 + h[9] + h[10]
        assert h[3] == 0 and off % alignment == 0, "resources.arsc still misaligned"
    print(f"    resources.arsc stored and {alignment}-byte aligned")


def run_cmd(args, desc):
    print(f"[*] {desc}...")
    res = subprocess.run(args, capture_output=True, text=True, cwd=PROJECT_DIR)
    if res.returncode != 0:
        print(f"[!] Error during {desc}:")
        print("STDOUT:", res.stdout)
        print("STDERR:", res.stderr)
        sys.exit(1)
    if res.stdout.strip():
        print("   ", res.stdout.strip().replace("\n", "\n    "))

def main():
    if os.path.exists(BUILD_DIR):
        shutil.rmtree(BUILD_DIR)
    os.makedirs(BUILD_DIR)
    
    gen_dir = os.path.join(BUILD_DIR, "gen")
    obj_dir = os.path.join(BUILD_DIR, "obj")
    dex_dir = os.path.join(BUILD_DIR, "dex")
    os.makedirs(gen_dir)
    os.makedirs(obj_dir)
    os.makedirs(dex_dir)

    res_zip = os.path.join(BUILD_DIR, "compiled_res.zip")
    base_apk = os.path.join(BUILD_DIR, "base.apk")
    aligned_apk = os.path.join(BUILD_DIR, "aligned.apk")
    final_apk = os.path.join(PROJECT_DIR, APP_NAME + ".apk")
    keystore = os.path.join(PROJECT_DIR, "debug.keystore")

    # 1. Compile resources
    run_cmd([AAPT2, "compile", "--dir", "res", "-o", res_zip], "Compiling resources with aapt2")

    # 2. Link resources
    run_cmd([
        AAPT2, "link",
        "-o", base_apk,
        "-I", ANDROID_JAR,
        "--manifest", "AndroidManifest.xml",
        "--java", gen_dir,
        "--auto-add-overlay",
        res_zip
    ], "Linking resources with aapt2")

    # 3. Find java files
    java_files = []
    for root, _, files in os.walk(os.path.join(PROJECT_DIR, "src")):
        for f in files:
            if f.endswith(".java"):
                java_files.append(os.path.join(root, f))
    for root, _, files in os.walk(gen_dir):
        for f in files:
            if f.endswith(".java"):
                java_files.append(os.path.join(root, f))

    # 4. Compile Java
    run_cmd([
        JAVAC,
        "-source", "8",
        "-target", "8",
        "-d", obj_dir,
        "-cp", ANDROID_JAR,
        *java_files
    ], "Compiling Java sources")

    # 5. Class files to DEX with d8
    class_files = []
    for root, _, files in os.walk(obj_dir):
        for f in files:
            if f.endswith(".class"):
                class_files.append(os.path.join(root, f))

    run_cmd([
        D8,
        "--output", dex_dir,
        "--min-api", "26",
        "--lib", ANDROID_JAR,
        *class_files
    ], "Generating DEX bytecode with d8")

    # 6. Add assets (the Linux payload and the launcher) uncompressed, so the launcher can
    #    stream them straight out of the APK with busybox unzip instead of going through Java.
    assets_dir = os.path.join(PROJECT_DIR, "assets")
    if os.path.isdir(assets_dir):
        with zipfile.ZipFile(base_apk, "a", zipfile.ZIP_STORED, allowZip64=True) as zf:
            for root, _, files in os.walk(assets_dir):
                for name in sorted(files):
                    full = os.path.join(root, name)
                    arc = "assets/" + os.path.relpath(full, assets_dir).replace("\\", "/")
                    mb = os.path.getsize(full) / (1024 * 1024)
                    print(f"[*] Adding {arc} ({mb:.1f} MB, stored)...")
                    zf.write(full, arc, compress_type=zipfile.ZIP_STORED)

    # 7. Add classes.dex into base.apk
    print("[*] Packaging classes.dex into APK...")
    classes_dex = os.path.join(dex_dir, "classes.dex")
    with zipfile.ZipFile(base_apk, "a") as zf:
        zf.write(classes_dex, "classes.dex")

    # 7. Align (own implementation: build-tools 34 zipalign writes an invalid extra field)
    print("[*] Aligning APK entries...")
    align_apk(base_apk, aligned_apk)

    # 8. Create debug keystore if needed
    if not os.path.exists(keystore):
        run_cmd([
            KEYTOOL, "-genkeypair", "-v",
            "-keystore", keystore,
            "-alias", "droidagent",
            "-keyalg", "RSA",
            "-keysize", "2048",
            "-validity", "10000",
            "-storepass", "android",
            "-keypass", "android",
            "-dname", "CN=DroidAgent, OU=Agent, O=Local, L=NA, S=NA, C=NA"
        ], "Generating signing keystore")

    # 9. Sign APK
    run_cmd([
        APKSIGNER, "sign",
        "--ks", keystore,
        "--ks-pass", "pass:android",
        "--ks-key-alias", "droidagent",
        "--key-pass", "pass:android",
        "--out", final_apk,
        aligned_apk
    ], "Signing APK with apksigner")

    # 10. Verify signature
    run_cmd([APKSIGNER, "verify", final_apk], "Verifying APK signature")

    size_kb = os.path.getsize(final_apk) / 1024
    print(f"\n[+] SUCCESS! Output APK: {final_apk} ({size_kb:.1f} KB)")

if __name__ == "__main__":
    main()
