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
