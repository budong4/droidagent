#!/usr/bin/env python3
"""Drive `claude auth login --claudeai` under a pty so the chat app can log in without a terminal.

Uses the full interactive login flow (not `claude setup-token`): it requests the same OAuth
scopes the desktop/terminal CLI gets (profile, sessions, mcp_servers, plugins, ...), not just
`user:inference` — `setup-token`'s narrower scope is why things like the usage/rate-limit panel
can't read anything. `claude auth login` saves credentials straight into ~/.claude's own native
store; it doesn't print a separate long-lived token the way `setup-token` does, but the token
handling below is kept as a harmless no-op fallback in case a future CLI version ever does.

Usage: login_pty.py [claude-binary ...]
    Each argument is a Claude Code binary to try, in order (the server passes the global
    `claude` first and the one bundled with the Agent SDK after it). If one exits or stalls
    without ever printing a sign-in link, the next one is tried. With no arguments, `claude`
    is looked up on PATH.

Line protocol, this script's stdout -> Node server (one per line):
    URL <authorize-url>      link the user opens to sign in
    NEED_CODE                waiting for the code shown after signing in
    TOKEN <token>            long-lived token, if setup-token printed one (never shown in the UI)
    DONE ok | DONE fail <reason>
stdin, Node server -> this script: one line = the code the user pasted.

Everything the CLI printed is also written to ~/.claude/agent-login.log, so a failure on a phone
can be diagnosed afterwards instead of collapsing into a one-line message.
"""
import fcntl
import os
import pty
import re
import select
import shutil
import signal
import struct
import sys
import termios
import time

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)|[\x00-\x08\x0e-\x1f]")
TOKEN_RE = re.compile(r"sk-ant-oat01-[A-Za-z0-9_-]+")
NET_ERR_RE = re.compile(
    r"(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|"
    r"socket hang up|fetch failed|Unable to connect|network error|timed? ?out)", re.I)

# How long one CLI may take to print the sign-in link. Cold start of a ~300 MB binary on a phone
# is a few seconds; a minute and a half without a link means it is stuck, not slow.
URL_DEADLINE = int(os.environ.get("LOGIN_URL_TIMEOUT", "90"))
CODE_DEADLINE = 600   # the user signing in in the browser
EXCHANGE_DEADLINE = 180  # after the code is sent: token exchange with Anthropic

LOG_PATH = os.path.join(os.path.expanduser("~"), ".claude", "agent-login.log")


def emit(line):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def clean(text):
    return ANSI.sub("", text)


def log_transcript(cli, raw, note):
    """Keep what the CLI printed, so 'login failed' on a phone can be looked into afterwards."""
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        text = clean(raw)
        # Codes and states are one-shot, but there is no reason to keep them around either.
        text = re.sub(r"((?:code|state|code_challenge)=)[A-Za-z0-9_-]+", r"\1…", text)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')}  {cli}  ({note})\n")
            f.write(text[-20000:])
            f.write("\n")
    except OSError:
        pass


def tail_reason(raw, limit=220):
    """The last meaningful thing the CLI printed, as one short line for the UI.

    Built from the end backwards: the newest line is the one that says what went wrong, and the
    banner/link lines before it are only added while there is room left.
    """
    lines = []
    for l in clean(raw).replace("\r", "\n").splitlines():
        l = re.sub(r"\s+", " ", l).strip(" │╭╮╰╯─*>·")
        l = re.sub(r"^Paste code here if prompted\s*>?\s*", "", l)
        if l and not re.fullmatch(r"[\W_]+", l) and "oauth/authorize" not in l:
            lines.append(l)
    out = ""
    for l in reversed(list(dict.fromkeys(lines))):
        cand = l if not out else f"{l} / {out}"
        if len(cand) > limit:
            if not out:
                out = l[:limit]
            break
        out = cand
    return out


def extract_url(text):
    # 1. OSC 8 hyperlink target: \x1b]8;id=...;<URL>\x07
    m = re.search(r"\x1b\]8;[^;]*;(https://[^\x07\x1b\s]+authorize[^\x07\x1b\s]*)(?:\x07|\x1b\\)", text)
    if m:
        return m.group(1).rstrip("\\")
    # 2. URL in the text (stops at control chars, quotes, spaces)
    m = re.search(r"(https://[^\s\"'\\<>\x00-\x1f\x7f]*authorize[^\s\"'\\<>\x00-\x1f\x7f]*)", text)
    if m:
        cand = m.group(1).rstrip("\\")
        # Only once the whole link is out (state= is last), or the prompt for the code is shown.
        if "state=" in cand or ("prompted" in text or "Paste" in text):
            return cand
    return None


def normalize_code(raw_code, state):
    c = raw_code.strip().strip("'\"")
    # Case 1: full callback URL or query string, e.g.
    # https://platform.claude.com/oauth/code/callback?code=xxx&state=yyy   or   #code=xxx&state=yyy
    if "code=" in c:
        m_c = re.search(r"(?:[?&#]|^)code=([A-Za-z0-9_-]+)", c)
        m_s = re.search(r"(?:[?&#]|^)state=([A-Za-z0-9_-]+)", c)
        code_val = m_c.group(1) if m_c else None
        state_val = m_s.group(1) if m_s else state
        if code_val and state_val:
            return f"{code_val}#{state_val}"
        if code_val:
            return f"{code_val}#{state}" if state else code_val

    # Case 2: already code#state
    if "#" in c:
        parts = c.split("#", 1)
        code_val = parts[0].strip()
        state_val = parts[1].strip() or state
        if code_val and state_val:
            return f"{code_val}#{state_val}"

    # Case 3: only the code, without #state
    if state and c and "#" not in c:
        return f"{c}#{state}"

    return c


def spawn(cli):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLUMNS"] = "2000"
        os.environ["LINES"] = "40"
        os.environ.pop("ANTHROPIC_API_KEY", None)  # subscription only, never an API key
        try:
            os.execvp(cli, [cli, "auth", "login", "--claudeai"])
        except OSError as e:
            # Lands in the pty, so the parent can report it instead of "no link".
            os.write(1, f"cannot run {cli}: {e.strerror or e}\r\n".encode())
        os._exit(127)

    # Very wide pty window so URLs are never soft-wrapped at 80 cols.
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 2000, 0, 0))
    except OSError:
        pass
    return pid, fd


class Attempt:
    """One run of `<cli> auth login`. Result: 'ok', 'fail' (with reason) or 'no_url'."""

    def __init__(self, cli):
        self.cli = cli
        self.raw = ""
        self.url_sent = False
        self.code_sent = False
        self.token_sent = False
        self.state = ""
        self.reason = ""

    def run(self):
        pid, fd = spawn(self.cli)
        stdin_fd = sys.stdin.fileno()
        stdin_open = True
        started = time.time()
        code_at = None
        try:
            while True:
                if not self.url_sent:
                    timeout = URL_DEADLINE - (time.time() - started)
                elif not self.code_sent:
                    timeout = CODE_DEADLINE
                else:
                    timeout = EXCHANGE_DEADLINE - (time.time() - code_at)
                if timeout <= 0:
                    break
                watch = [fd]
                if self.url_sent and not self.code_sent and stdin_open:
                    watch.append(stdin_fd)
                r, _, _ = select.select(watch, [], [], timeout)
                if not r:
                    break
                if stdin_fd in r:
                    line = sys.stdin.readline()
                    if not line:
                        stdin_open = False  # server went away; nothing more will come
                        continue
                    os.write(fd, normalize_code(line, self.state).encode())
                    time.sleep(0.15)
                    os.write(fd, b"\r")
                    self.code_sent = True
                    code_at = time.time()
                if fd in r:
                    try:
                        data = os.read(fd, 4096)
                    except OSError:
                        break
                    if not data:
                        break
                    self.raw += data.decode(errors="replace")
                    if self._on_output():
                        _kill(pid)
                        return "fail"
        except Exception as e:  # noqa: BLE001
            self.reason = str(e)[:160]
            _kill(pid)
            return "fail"

        status = _reap(pid)
        return self._verdict(status, time.time() - started)

    def _on_output(self):
        """Scan new output. True means the attempt is over (failed) and the child should go."""
        if not self.url_sent:
            url = extract_url(self.raw)
            if url:
                m_state = re.search(r"[?&]state=([A-Za-z0-9_-]+)", url)
                if m_state:
                    self.state = m_state.group(1)
                emit("URL " + url)
                emit("NEED_CODE")
                self.url_sent = True
        if not self.token_sent:
            t = TOKEN_RE.search(self.raw)
            if t:
                emit("TOKEN " + t.group(0))
                self.token_sent = True
        # Fast exit on a rejected code instead of hanging until the timeout.
        if self.code_sent and re.search(
                r"(OAuth error|Invalid code|OAuth\s+failed|Login failed|Request failed with status code)",
                self.raw, re.I):
            if re.search(r"(status code 400|Invalid code|wasn't accepted|not accepted|expired)", self.raw, re.I):
                self.reason = "授权码无效或已过期，请重新点「开始登录」获取新的授权码"
            elif NET_ERR_RE.search(clean(self.raw)):
                self.reason = "无法连接 Anthropic 服务器换取登录凭据。请检查网络，或在下方填写代理后重试"
            else:
                self.reason = tail_reason(self.raw, 160) or "授权验证失败，请重试"
            return True
        return False

    def _verdict(self, status, elapsed):
        exit_ok = status is not None and os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0
        text = clean(self.raw)
        if self.token_sent or (self.code_sent and exit_ok) or (
                self.code_sent and re.search(r"(login successful|logged in|token saved|saved token)", text, re.I)):
            return "ok"
        if not self.url_sent:
            code = ""
            if status is not None and os.WIFEXITED(status):
                code = f"退出码 {os.WEXITSTATUS(status)}"
            elif status is not None and os.WIFSIGNALED(status):
                code = f"被信号 {os.WTERMSIG(status)} 终止"
            what = tail_reason(self.raw)
            if elapsed >= URL_DEADLINE - 1:
                code = f"{URL_DEADLINE} 秒内没有给出登录链接"
            self.reason = "；".join(x for x in (what, code) if x) or "命令没有任何输出"
            return "no_url"
        if not self.code_sent:
            self.reason = "登录超时（10 分钟内没有提交授权码），请重新点「开始登录」"
            return "fail"
        if NET_ERR_RE.search(text):
            self.reason = "无法连接 Anthropic 服务器换取登录凭据。请检查网络，或在下方填写代理后重试"
        else:
            self.reason = tail_reason(self.raw, 160) or "登录未完成，请重试"
        return "fail"


def cli_label(cli):
    return "SDK 内置 claude" if "claude-agent-sdk" in cli else cli


def candidates():
    found = [a for a in sys.argv[1:] if a]
    if not found:
        p = shutil.which("claude")
        if p:
            found.append(p)
    return found


def main():
    clis = candidates()
    if not clis:
        emit("DONE fail 找不到 Claude Code 命令行（claude）。请在 Debian 里执行 "
             "`npm i -g @anthropic-ai/claude-code`，或运行 `debian appdeps` 重装依赖")
        return

    reasons = []
    for cli in clis:
        a = Attempt(cli)
        result = a.run()
        log_transcript(cli, a.raw, result)
        if result == "ok":
            emit("DONE ok")
            return
        if result == "fail" or a.url_sent:
            emit("DONE fail " + (a.reason or "登录未完成，请重试"))
            return
        # No link at all: this binary can't do it here; try the next one, if any.
        reasons.append(f"{cli_label(cli)}：{a.reason}")

    emit("DONE fail 无法启动登录，claude 没有给出登录链接。" + " | ".join(reasons)[:400]
         + "（完整输出见 ~/.claude/agent-login.log）")


def _kill(pid):
    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError):
        pass


def _reap(pid):
    # The loop breaks on pty EOF or a timeout; wait briefly for the child, then force it down.
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


if __name__ == "__main__":
    main()
