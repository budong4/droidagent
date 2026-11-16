#!/usr/bin/env python3
"""Drive the Antigravity CLI's own sign-in under a pty, so the chat app can log in without a terminal.

This is agy's official flow and nothing else: the CLI prints a Google sign-in link, the owner
signs in, and the code Google shows goes back into the CLI, which stores its own token
(~/.gemini/antigravity-cli/antigravity-oauth-token when there is no desktop keyring, as in the
chroot). This script never sees that token; it only checks that the file appeared.

What is run (in order, the next one only if the one before gave no link):
    agy acp --login     "sign in by pasting a code, then exit" — made for machines with no browser
    agy                 the interactive CLI, which asks to sign in when it has no session

Both are started with SSH_CONNECTION set and $BROWSER pointing at a helper that only records the
link: agy takes its print-a-link-and-ask-for-a-code path when it believes the browser is
elsewhere, and if it tries to open one anyway the link is still caught.

Two ways the code gets back, depending on the link:
    manual   Google shows a code; the owner pastes it and it is typed into the CLI
    auto     the link returns to http://localhost:<port> — the CLI's own listener, reachable from
             the phone's browser because the chroot shares its network — and the login finishes
             by itself. If the browser cannot get there, the pasted address is forwarded from here.

Environment (set by the server): AGY_BIN, AGY_TOKEN_FILE, AGY_ENV (JSON, extra variables).
Line protocol on stdout, the same as login_pty.py:
    MODE auto|manual / URL <link> / NEED_CODE / STATUS <text> / DONE ok | DONE fail <reason>
stdin: one line = what the owner pasted.

Everything the CLI printed is kept in ~/.claude/agent-agy-login.log, codes removed.
"""
import fcntl
import http.client
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import tempfile
import termios
import threading
import time
import urllib.parse

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)|[\x00-\x08\x0e-\x1f]")
URL_RE = re.compile(r"https://accounts\.google\.com/[^\s\"'<>\\\x00-\x1f\x7f]+")
NET_ERR_RE = re.compile(
    r"(TLS handshake|i/o timeout|connection (refused|reset)|no such host|network is unreachable|"
    r"dial tcp|context deadline exceeded|proxyconnect|timed? ?out|EOF\b)", re.I)

URL_DEADLINE = int(os.environ.get("LOGIN_URL_TIMEOUT", "90"))
CODE_DEADLINE = 600
EXCHANGE_DEADLINE = int(os.environ.get("LOGIN_EXCHANGE_TIMEOUT", "90"))

HOME = os.path.expanduser("~")
LOG_PATH = os.path.join(HOME, ".claude", "agent-agy-login.log")
TOKEN_FILE = os.environ.get("AGY_TOKEN_FILE") or os.path.join(HOME, ".gemini", "antigravity-cli", "antigravity-oauth-token")
BACKUP = TOKEN_FILE + ".before-login"

BROWSER_HELPER = """#!/bin/sh
# Stands in for a browser: records the sign-in link agy wants opened (see agy_login_pty.py).
printf '%s\\n' "$1" >> "$DROIDAGENT_AUTH_URL_FILE"
"""


def emit(line):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def clean(text):
    return ANSI.sub("", text)


def redact(text):
    text = re.sub(r"((?:code|state|code_challenge)=)[^&\s]+", r"\1…", text)
    return re.sub(r"\b4/[\w-]{6,}", "4/…", text)


def log_transcript(what, raw, note):
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')}  {what}  ({note})\n")
            f.write(redact(clean(raw))[-20000:])
            f.write("\n")
    except OSError:
        pass


def tail_reason(raw, limit=200):
    """The last meaningful thing the CLI printed, as one short line for the page."""
    lines = []
    for line in clean(raw).replace("\r", "\n").splitlines():
        line = re.sub(r"\s+", " ", line).strip(" │╭╮╰╯─*>·")
        if line and not re.fullmatch(r"[\W_]+", line) and "accounts.google.com" not in line:
            lines.append(line)
    out = ""
    for line in reversed(list(dict.fromkeys(lines))):
        cand = line if not out else f"{line} / {out}"
        if len(cand) > limit:
            if not out:
                out = line[:limit]
            break
        out = cand
    return redact(out)


def token_ok():
    try:
        with open(TOKEN_FILE, encoding="utf-8") as f:
            token = json.load(f).get("token") or {}
        return bool(token.get("refresh_token") or token.get("access_token"))
    except (OSError, ValueError, AttributeError):
        return False


def link_target(url):
    """('auto', port, path) when the link returns to this phone, else ('manual', None, None)."""
    try:
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        back = urllib.parse.urlsplit((q.get("redirect_uri") or [""])[0])
    except ValueError:
        return "manual", None, None
    if back.scheme == "http" and back.hostname in ("localhost", "127.0.0.1") and back.port:
        return "auto", back.port, back.path or "/"
    return "manual", None, None


def pasted_code(text):
    """The code from what was pasted: a bare code, or an address that carries one."""
    c = text.strip().strip("'\"")
    m = re.search(r"[?&#]code=([^&#\s]+)", c)
    state = re.search(r"[?&#]state=([^&#\s]+)", c)
    code = urllib.parse.unquote(m.group(1)) if m else c
    return code, (urllib.parse.unquote(state.group(1)) if state else None)


def forward_callback(port, path, code, state, out):
    """Hand the code to the CLI's own localhost listener, as the browser would have."""
    try:
        conn = http.client.HTTPConnection("localhost", port, timeout=EXCHANGE_DEADLINE + 30)
        query = {"code": code}
        if state:
            query["state"] = state
        conn.request("GET", path + "?" + urllib.parse.urlencode(query))
        out["status"] = conn.getresponse().status
        conn.close()
    except Exception as e:  # noqa: BLE001
        out["error"] = str(e)


def spawn(agy, args, extra_env):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(extra_env)
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLUMNS"] = "2000"
        os.environ["LINES"] = "40"
        try:
            os.execvp(agy, [agy] + list(args))
        except OSError as e:
            os.write(1, f"cannot run {agy}: {e.strerror or e}\r\n".encode())
        os._exit(127)
    try:  # very wide, so the link is never wrapped
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 2000, 0, 0))
    except OSError:
        pass
    return pid, fd


class Attempt:
    """One run of the CLI. Result: 'ok', 'fail' (with reason) or 'no_url'."""

    def __init__(self, agy, args, base_env):
        self.agy = agy
        self.args = args
        self.base_env = base_env
        self.raw = ""
        self.url = None
        self.url_seen_at = None
        self.url_sent = False
        self.url_at = None
        self.mode = "manual"
        self.port = None
        self.path = None
        self.state = None
        self.code_sent = False
        self.sent_code = "\0"
        self.status = ""
        self.status_mark = 0
        self.reason = ""
        self.timed_out = False
        self.forward = {}

    def run(self):
        work = tempfile.mkdtemp(prefix="droidagent-agy-login-")
        url_file = os.path.join(work, "auth-url")
        helper = os.path.join(work, "open-url")
        with open(helper, "w") as f:
            f.write(BROWSER_HELPER)
        os.chmod(helper, 0o755)
        env = dict(self.base_env)
        env.update({
            "BROWSER": helper, "DROIDAGENT_AUTH_URL_FILE": url_file,
            # Not on a desk: the browser is on the other side of this terminal.
            "SSH_CONNECTION": "127.0.0.1 0 127.0.0.1 22", "SSH_CLIENT": "127.0.0.1 0 22", "SSH_TTY": "/dev/pts/0",
        })
        pid, fd = spawn(self.agy, self.args, env)
        stdin_fd = sys.stdin.fileno()
        stdin_open = True
        started = time.time()
        code_at = None
        exited = False
        try:
            while True:
                if not self.url_sent:
                    self._find_link(url_file)
                # Signed in: by the browser coming back on its own, or by the code just typed.
                if self.url_sent and token_ok():
                    _kill(pid)
                    return "ok"
                if not self.url_sent:
                    left = URL_DEADLINE - (time.time() - started)
                elif not self.code_sent:
                    left = CODE_DEADLINE - (time.time() - self.url_at)
                else:
                    left = EXCHANGE_DEADLINE - (time.time() - code_at)
                if left <= 0:
                    self.timed_out = True
                    break
                watch = [fd]
                if self.url_sent and not self.code_sent and stdin_open:
                    watch.append(stdin_fd)
                ready, _, _ = select.select(watch, [], [], min(left, 0.5))
                if stdin_fd in ready:
                    line = sys.stdin.readline()
                    if not line:
                        stdin_open = False
                    elif line.strip():
                        self._submit(fd, line)
                        self.code_sent = True
                        code_at = time.time()
                if fd in ready:
                    try:
                        data = os.read(fd, 4096)
                    except OSError:
                        data = b""
                    if not data:
                        exited = True
                        break
                    self.raw += data.decode(errors="replace")
                    self._on_output()
        except Exception as e:  # noqa: BLE001
            self.reason = str(e)[:160]
            _kill(pid)
            return "fail"
        finally:
            for name in os.listdir(work) if os.path.isdir(work) else ():
                try:
                    os.unlink(os.path.join(work, name))
                except OSError:
                    pass
            try:
                os.rmdir(work)
            except OSError:
                pass
        status = _reap(pid) if exited else (_kill(pid) or None)
        return self._verdict(status, time.time() - started)

    def _find_link(self, url_file):
        """A link the CLI printed, or one it asked the "browser" to open. A printed link is only
        taken once the output has moved past it, so half a link is never handed out."""
        if not self.url:
            try:
                with open(url_file) as f:
                    opened = [line.strip() for line in f if "accounts.google.com" in line]
            except OSError:
                opened = []
            printed = None
            text = clean(self.raw)
            m = URL_RE.search(text)
            if m and (m.end() < len(text) or time.time() - (self.url_seen_at or time.time()) > 1.5):
                printed = m.group(0)
            elif m and self.url_seen_at is None:
                self.url_seen_at = time.time()
            self.url = (opened[-1] if opened else None) or printed
        if self.url:
            self.mode, self.port, self.path = link_target(self.url)
            m = re.search(r"[?&]state=([^&\s]+)", self.url)
            self.state = urllib.parse.unquote(m.group(1)) if m else None
            emit("MODE " + self.mode)
            emit("URL " + self.url)
            emit("NEED_CODE")
            self.url_sent = True
            self.url_at = time.time()
            self.status_mark = len(self.raw)

    def _submit(self, fd, line):
        code, state = pasted_code(line)
        self.sent_code = code or "\0"
        if self.mode == "auto" and self.port:
            threading.Thread(target=forward_callback, args=(self.port, self.path, code, state or self.state, self.forward),
                             daemon=True).start()
        else:
            os.write(fd, code.encode())
            time.sleep(0.15)
            os.write(fd, b"\r")

    def _on_output(self):
        if not self.url_sent:
            return
        after = self.raw[self.status_mark:].replace(self.sent_code, "")
        line = tail_reason(after, 120).split(" / ")[-1]
        if line and line != self.status:
            self.status = line
            emit("STATUS " + line)

    def _verdict(self, status, elapsed):
        exit_ok = status is not None and os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0
        if token_ok() and (self.url_sent or exit_ok):
            return "ok"
        if not self.url_sent:
            code = ""
            if status is not None and os.WIFEXITED(status):
                code = f"退出码 {os.WEXITSTATUS(status)}"
            elif status is not None and os.WIFSIGNALED(status):
                code = f"被信号 {os.WTERMSIG(status)} 终止"
            if elapsed >= URL_DEADLINE - 1:
                code = f"{URL_DEADLINE} 秒内没有给出登录链接"
            self.reason = "；".join(x for x in (tail_reason(self.raw), code) if x) or "命令没有任何输出"
            return "no_url"
        after = clean(self.raw[self.status_mark:])
        if self.timed_out and not self.code_sent:
            self.reason = "登录超时（10 分钟内没有完成授权），请重新开始登录"
        elif NET_ERR_RE.search(after):
            self.reason = "连不上 Google 的服务器，没能换到登录凭据。请检查网络，或在下方填写代理后重试"
        elif self.timed_out:
            self.reason = (f"{EXCHANGE_DEADLINE} 秒内没有收到 Google 服务器的回应。手机里的 Linux 环境多半没有走 VPN："
                           "请在下方「网络代理」填写代理软件的本地端口，然后重新登录。")
        elif self.forward.get("error"):
            self.reason = "没能把授权码交给 agy：" + self.forward["error"][:120]
        else:
            self.reason = tail_reason(after, 160) or "登录未完成，请重试"
        return "fail"


def _kill(pid):
    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError):
        pass


def _reap(pid):
    for _ in range(20):
        try:
            done, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return None
        if done:
            return status
        time.sleep(0.1)
    _kill(pid)
    return None


def main():
    agy = os.environ.get("AGY_BIN") or ""
    if not agy or not os.path.exists(agy):
        emit("DONE fail 找不到 Antigravity CLI（agy）")
        return
    try:
        base_env = {k: str(v) for k, v in json.loads(os.environ.get("AGY_ENV") or "{}").items()}
    except (ValueError, AttributeError):
        base_env = {}

    # Signing in again, perhaps as someone else: the old login steps aside, and comes back if
    # this one does not go through.
    had_login = False
    try:
        os.replace(TOKEN_FILE, BACKUP)
        had_login = True
    except OSError:
        pass

    result, attempt, reasons = "no_url", None, []
    for args in (["acp", "--login"], []):
        attempt = Attempt(agy, args, base_env)
        result = attempt.run()
        # Without what the owner typed, however the terminal echoed it.
        log_transcript("agy " + " ".join(args), attempt.raw.replace(attempt.sent_code, "…"), result)
        if result != "no_url" or attempt.url_sent:
            break
        reasons.append(f"agy {' '.join(args) or '（交互模式）'}：{attempt.reason}")

    if result == "ok":
        try:
            os.unlink(BACKUP)
        except OSError:
            pass
        emit("DONE ok")
        return
    if had_login and not token_ok():
        try:
            os.replace(BACKUP, TOKEN_FILE)
        except OSError:
            pass
    if result == "no_url":
        emit("DONE fail agy 没有给出登录链接。" + " | ".join(reasons)[:400] + "（完整输出见 ~/.claude/agent-agy-login.log）")
    else:
        emit("DONE fail " + (attempt.reason or "登录未完成，请重试"))


if __name__ == "__main__":
    main()
