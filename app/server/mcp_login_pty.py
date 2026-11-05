#!/usr/bin/env python3
"""Drive `claude mcp login <name>` under a pty so a connector can be authorized from the app.

The CLI refuses to run without a terminal. It starts a small server on localhost and opens the
authorization link with $BROWSER; a helper records that link instead, and the page opens it. After
"Allow" the phone's browser is sent to http://localhost:<port>/callback, the CLI's own server,
which is reachable because the chroot shares the phone's network.

Usage: mcp_login_pty.py <server-name>, with CLAUDE_CLI_SPEC = {"cmd": [...], "env": {...}}.
Line protocol on stdout:
    URL <authorization-url>
    DONE ok | DONE fail <reason>
"""
import json
import os
import re
import select
import sys
import tempfile
import time

from login_pty import _kill, _reap, clean, make_browser_helper, spawn_with_args, tail_reason

LINK_DEADLINE = 90    # a cold start of the CLI on a phone, plus discovering the server's OAuth endpoints
AUTH_DEADLINE = 600   # the owner signing in, in the browser
URL_RE = re.compile(r"https://[^\s\"'<>\x00-\x1f\x7f]+")


def emit(line):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def first_link(url_file, raw):
    try:
        with open(url_file) as f:
            for line in f:
                if line.startswith("https://"):
                    return line.strip()
    except OSError:
        pass
    # Printed as "visit:" when the browser helper wasn't used. Only an authorize link counts:
    # the CLI prints other addresses too, and the whole link has to be out (state= comes late).
    for m in URL_RE.finditer(clean(raw)):
        if "response_type=code" in m.group(0) and "state=" in m.group(0):
            return m.group(0)
    return None


def main():
    name = sys.argv[1]
    spec = json.loads(os.environ["CLAUDE_CLI_SPEC"])
    work = tempfile.mkdtemp(prefix="droidagent-mcp-login-")
    url_file = os.path.join(work, "auth-url")
    env = {"BROWSER": make_browser_helper(work), "DROIDAGENT_AUTH_URL_FILE": url_file}
    pid, fd = spawn_with_args(spec, ["mcp", "login", name], env)
    raw = ""
    sent = False
    started = time.time()
    timed_out = False
    try:
        while True:
            deadline = (AUTH_DEADLINE if sent else LINK_DEADLINE) - (time.time() - started)
            if deadline <= 0:
                timed_out = True
                break
            ready, _, _ = select.select([fd], [], [], min(deadline, 0.5))
            if ready:
                try:
                    data = os.read(fd, 4096)
                except OSError:
                    break
                if not data:
                    break
                raw += data.decode(errors="replace")
            if not sent:
                link = first_link(url_file, raw)
                if link:
                    emit("URL " + link)
                    sent = True
                    started = time.time()
    finally:
        if timed_out:
            _kill(pid)
        status = None if timed_out else _reap(pid)
        for f in os.listdir(work):
            try:
                os.unlink(os.path.join(work, f))
            except OSError:
                pass
        try:
            os.rmdir(work)
        except OSError:
            pass
    if timed_out:
        emit("DONE fail " + ("10 分钟内没有完成授权" if sent else "没有拿到授权链接，请检查网络或代理"))
    elif status is not None and os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0:
        emit("DONE ok")
    else:
        emit("DONE fail " + (tail_reason(raw) or "授权没有完成"))


if __name__ == "__main__":
    main()
