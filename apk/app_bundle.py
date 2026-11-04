"""Packaging shared by build.py (the APK) and tools/build_update_zip.py (the root-manager update).

Kept free of Android SDK lookups so it can be imported on a machine that has no SDK.
"""
import os
import tarfile

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def build_app_bundle(out_path, repo_dir=REPO_DIR):
    """Pack app/ (server + web) into a tar, leaving out node_modules and junk.

    Entries are sorted and their mtimes fixed, so an unchanged app gives a byte-identical tar and
    the launcher's checksum check skips the sync (and the server restart) on the phone.
    """
    app_dir = os.path.join(repo_dir, "app")
    skip_dirs = {"node_modules", "__pycache__", ".git"}
    entries = []
    for root, dirs, files in os.walk(app_dir):
        dirs[:] = sorted(d for d in dirs if d not in skip_dirs)
        for name in sorted(files):
            if name in (".DS_Store", "Thumbs.db") or name.endswith((".pyc", ".log")):
                continue
            full = os.path.join(root, name)
            entries.append((full, os.path.relpath(full, app_dir).replace("\\", "/")))
    with tarfile.open(out_path, "w", format=tarfile.USTAR_FORMAT) as tf:
        for full, arc in entries:
            ti = tf.gettarinfo(full, arc)
            ti.mtime = 0
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = "root"
            ti.mode = 0o755 if arc.endswith((".py", ".sh")) else 0o644
            with open(full, "rb") as f:
                tf.addfile(ti, f)
    return out_path


def write_lf(src, dst):
    """Copy a shell script with LF line endings, even when the checkout on Windows has CRLF."""
    with open(src, "rb") as f:
        data = f.read().replace(b"\r\n", b"\n")
    with open(dst, "wb") as f:
        f.write(data)
    return dst


# Agent SDK whose bundled Claude Code (2.1.112) is the last release shipped as plain JavaScript.
# Newer ones are Bun-compiled native binaries, which abort at startup on some Android kernels;
# this one runs on the Node.js already in the chroot. See "Claude Code runtime" in server.mjs.
LEGACY_SDK_VERSION = "0.2.112"


def build_legacy_runtime(out_path, arch="arm64"):
    """npm-install that SDK, keep only the linux-<arch> native helpers, and pack node_modules/
    as a tar.xz. Returns None when npm isn't available (the runtime is then simply not shipped)."""
    import json
    import shutil
    import subprocess
    import tempfile

    npm = shutil.which("npm") or shutil.which("npm.cmd")
    if not npm:
        return None
    with tempfile.TemporaryDirectory() as tmp:
        with open(os.path.join(tmp, "package.json"), "w") as f:
            json.dump({"name": "droidagent-legacy-runtime", "private": True,
                       "dependencies": {"@anthropic-ai/claude-agent-sdk": LEGACY_SDK_VERSION}}, f)
        subprocess.run([npm, "install", "--omit=optional", "--omit=dev", "--no-audit", "--no-fund",
                        "--ignore-scripts", "--loglevel=error"], cwd=tmp, check=True)
        vendor = os.path.join(tmp, "node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor")
        keep = f"{arch}-linux"
        for sub in ("ripgrep", "audio-capture"):
            d = os.path.join(vendor, sub)
            if os.path.isdir(d):
                for name in os.listdir(d):
                    p = os.path.join(d, name)
                    if os.path.isdir(p) and name != keep:
                        shutil.rmtree(p)
        # GNU format: deep node_modules paths need long names, and the phone's busybox tar
        # already handles GNU long names (the rootfs payload uses them).
        with tarfile.open(out_path, "w:xz", format=tarfile.GNU_FORMAT, preset=6) as tf:
            def norm(ti):
                ti.mtime = 0
                ti.uid = ti.gid = 0
                ti.uname = ti.gname = "root"
                # Windows has no exec bit: give it back to directories and to the native helpers
                # (ripgrep, audio capture) explicitly, or Claude Code's search tool can't run them.
                if ti.isdir() or "/vendor/ripgrep/" in ti.name or "/vendor/audio-capture/" in ti.name:
                    ti.mode = 0o755
                else:
                    ti.mode = 0o755 if ti.mode & 0o111 else 0o644
                return ti
            tf.add(os.path.join(tmp, "node_modules"), "node_modules", filter=norm)
    return out_path
