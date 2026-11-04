#!/usr/bin/env python3
"""Drive `claude auth login --claudeai` under a pty so the chat app can log in without a terminal.

Uses the full interactive login flow (not `claude setup-token`): it requests the same OAuth
scopes the desktop/terminal CLI gets (profile, sessions, mcp_servers, plugins, ...), not just
`user:inference` — `setup-token`'s narrower scope is why things like the usage/rate-limit panel
can't read anything. `claude auth login` saves credentials straight into ~/.claude's own native
store; it doesn't print a separate long-lived token the way `setup-token` does, but the token
handling below is kept as a harmless no-op fallback in case a future CLI version ever does.

Line protocol, this script's stdout -> Node server (one per line):
    URL <authorize-url>      link the user opens to sign in
    NEED_CODE                waiting for the code shown after signing in
    TOKEN <token>            long-lived token, if setup-token printed one (never shown in the UI)
    DONE ok | DONE fail <reason>
stdin, Node server -> this script: one line = the code the user pasted.
"""
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)|[\x00-\x08\x0e-\x1f]")
TOKEN_RE = re.compile(r"sk-ant-oat01-[A-Za-z0-9_-]+")


def emit(line):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def clean(text):
    return ANSI.sub("", text)


def extract_url(text):
    # 1. Match OSC 8 hyperlink target: \x1b]8;id=...;<URL>\x07
    m = re.search(r"\x1b\]8;[^;]*;(https://[^\x07\x1b\s]+authorize[^\x07\x1b\s]*)\x07", text)
    if m:
        return m.group(1).rstrip("\\")
    # 2. Match URL in text (stops at control chars, quotes, spaces)
    m = re.search(r"(https://[^\s\"'\\<>\x00-\x1f\x7f]*authorize[^\s\"'\\<>\x00-\x1f\x7f]*)", text)
    if m:
        cand = m.group(1).rstrip("\\")
        # Ensure it has all query parameters (like state= or code_challenge=) or prompt is reached
        if "state=" in cand or ("prompted" in text or "Paste" in text):
            return cand
    return None


def normalize_code(raw_code, state):
    c = raw_code.strip().strip("'\"")
    # Case 1: Full callback URL or query string, e.g.:
    # https://platform.claude.com/oauth/code/callback?code=xxx&state=yyy
    # or #code=xxx&state=yyy
    if "code=" in c:
        m_c = re.search(r"(?:[?&#]|^)code=([A-Za-z0-9_-]+)", c)
        m_s = re.search(r"(?:[?&#]|^)state=([A-Za-z0-9_-]+)", c)
        code_val = m_c.group(1) if m_c else None
        state_val = m_s.group(1) if m_s else state
        if code_val and state_val:
            return f"{code_val}#{state_val}"
        if code_val:
            return f"{code_val}#{state}" if state else code_val

    # Case 2: Already contains # (code#state)
    if "#" in c:
        parts = c.split("#", 1)
        code_val = parts[0].strip()
        state_val = parts[1].strip() or state
        if code_val and state_val:
            return f"{code_val}#{state_val}"

    # Case 3: User only pasted the authorization code without #state
    if state and c and "#" not in c:
        return f"{c}#{state}"

    return c


def main():
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLUMNS"] = "2000"
        os.environ["LINES"] = "40"
        os.environ.pop("ANTHROPIC_API_KEY", None)  # subscription only, never an API key
        try:
            os.execvp("claude", ["claude", "auth", "login", "--claudeai"])
        finally:
            os._exit(127)

    # Set very wide pty window so URLs are never soft-wrapped at 80 cols
    winsize = struct.pack("HHHH", 40, 2000, 0, 0)
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except OSError:
        pass

    raw = ""
    url_sent = False
    token_sent = False
    code_sent = False
    known_state = ""
    stdin_fd = sys.stdin.fileno()

    try:
        while True:
            watch = [fd] if code_sent else [fd, stdin_fd]
            # Wait up to 10 minutes for user to sign in and submit code; 60s after code sent.
            # Wait up to 10 minutes for user to sign in; 3 minutes after code sent.
            timeout = 180 if code_sent else 600
            r, _, _ = select.select(watch, [], [], timeout)
            if not r:
                break
            if stdin_fd in r and not code_sent:
                line = sys.stdin.readline()
                if line:
                    final_code = normalize_code(line, known_state)
                    os.write(fd, final_code.encode())
                    time.sleep(0.15)
                    os.write(fd, b"\r")
                    code_sent = True
            if fd in r:
                try:
                    data = os.read(fd, 4096)
                except OSError:
                    break
                if not data:
                    break
                chunk = data.decode(errors="replace")
                raw += chunk
                if not url_sent:
                    url = extract_url(raw)
                    if url:
                        # Extract state parameter to assist normalizing pasted codes
                        m_state = re.search(r"[?&]state=([A-Za-z0-9_-]+)", url)
                        if m_state:
                            known_state = m_state.group(1)
                        emit("URL " + url)
                        url_sent = True
                        emit("NEED_CODE")
                if not token_sent:
                    t = TOKEN_RE.search(raw)
                    if t:
                        emit("TOKEN " + t.group(0))
                        token_sent = True

                # Fast exit on code errors instead of hanging until timeout
                if code_sent:
                    if re.search(r"(OAuth error|Invalid code|OAuth\s+failed|Request failed with status code)", raw, re.I):
                        if re.search(r"(status code 400|Invalid code)", raw, re.I):
                            emit("DONE fail 授权码无效或已过期，请重新登录获取最新授权码")
                        else:
                            clean_lines = [l for l in clean(raw).splitlines() if "OAuth error" in l]
                            emit("DONE fail " + (clean_lines[-1][:120] if clean_lines else "授权验证失败，请重试"))
                        _kill(pid)
                        return

    except Exception as e:  # noqa: BLE001
        emit("DONE fail " + str(e)[:120])
        _kill(pid)
        return

    status = _reap(pid)
    exit_ok = status is not None and os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0
    clean_raw = clean(raw)
    success = token_sent or (code_sent and exit_ok) or bool(re.search(r"(success|logged in|token saved|saved token)", clean_raw, re.I))
    if success:
        emit("DONE ok")
    elif not url_sent:
        emit("DONE fail 无法启动登录（没拿到链接）")
    elif not code_sent:
        emit("DONE fail 登录超时（超过10分钟未输入授权码），请重新点击开始登录")
    else:
        last = [l for l in clean_raw.strip().splitlines() if l.strip() and not l.strip().startswith("*")]
        emit("DONE fail " + (last[-1][:120] if last else "登录未完成，请重试"))


def _kill(pid):
    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError):
        pass


def _reap(pid):
    # The loop breaks on pty EOF, so the child is exiting; wait briefly, then force it down.
    for _ in range(20):
        try:
            done, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return 0
        if done:
            return status
        time.sleep(0.1)
    _kill(pid)
    return None


if __name__ == "__main__":
    main()
