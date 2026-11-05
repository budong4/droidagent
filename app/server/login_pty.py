#!/usr/bin/env python3
"""Drive `claude auth login --claudeai` under a pty so the chat app can log in without a terminal.

Uses the full interactive login flow (not `claude setup-token`): it requests the same OAuth
scopes the desktop/terminal CLI gets (profile, sessions, mcp_servers, plugins, ...), not just
`user:inference` — `setup-token`'s narrower scope is why things like the usage/rate-limit panel
can't read anything. `claude auth login` saves credentials straight into ~/.claude's own native
store; it doesn't print a separate long-lived token the way `setup-token` does, but the token
handling below is kept as a harmless no-op fallback in case a future CLI version ever does.

Usage: login_pty.py [claude-binary ...]
    What to run comes from CLAUDE_CLI_SPECS, a JSON list of {"label", "cmd", "env"} set by the
    server — e.g. a native binary with JavaScriptCoreUseJIT=0, or ["node", ".../cli.js"]. Each
    is tried in order; if one exits or stalls without ever printing a sign-in link, the next one
    is. Without CLAUDE_CLI_SPECS, each argument is a binary to try; with neither, `claude` on PATH.

Two ways the code gets back to the CLI:
    automatic  `claude` runs a small HTTP server on localhost and opens the sign-in link with
               $BROWSER. This script sets BROWSER to a helper that only records that link, and
               hands it to the user instead: after "Authorize" the phone's browser is sent to
               http://localhost:<port>/callback — the CLI's own server, reachable because the
               chroot shares the phone's network — and the login completes by itself. If the
               browser can't get there, the user pastes that callback address (or the code) and
               it is forwarded to the CLI's server from here.
    manual     the printed link (redirect to platform.claude.com, which shows a code) with the code
               typed into the CLI. Only used when no automatic link shows up. Claude Code 2.1.112
               (the Node build) has no paste prompt in `auth login` at all, which is why typing the
               code used to hang forever there.

Line protocol, this script's stdout -> Node server (one per line):
    MODE auto|manual         which of the two the link below is for
    URL <authorize-url>      link the user opens to sign in
    NEED_CODE                waiting for the code shown after signing in
    TOKEN <token>            long-lived token, if setup-token printed one (never shown in the UI)
    STATUS <text>            after the code is sent: the latest thing the CLI printed, so a slow
                             token exchange shows what it is doing instead of a frozen spinner
    DONE ok | DONE fail <reason>
stdin, Node server -> this script: one line = the code the user pasted.

Everything the CLI printed is also written to ~/.claude/agent-login.log, so a failure on a phone
can be diagnosed afterwards instead of collapsing into a one-line message.
"""
import fcntl
import http.client
import json
import os
import tempfile
import threading
import urllib.parse
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
# After the code is sent: the token exchange (15 s timeout in the CLI) and then account lookups
# that have no timeout at all — on a network that drops packets those hang for minutes.
EXCHANGE_DEADLINE = int(os.environ.get("LOGIN_EXCHANGE_TIMEOUT", "75"))
NO_ANSWER = ("{secs} 秒内没有收到 Anthropic 服务器的回应。手机里的 Linux 环境多半没有走 VPN：请在下方「网络代理」"
             "填写代理软件的本地端口（例如 Clash 的 http://127.0.0.1:7890），然后重新登录。")

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


BROWSER_HELPER = """#!/bin/sh
# Stands in for a browser: records the sign-in link `claude` wants opened (see login_pty.py).
printf '%s\\n' "$1" >> "$DROIDAGENT_AUTH_URL_FILE"
"""


# What the newest Claude Code asks for at login. Older builds ask for less (2.1.112 has no
# user:plugins), so the link is widened to this set: the login is then as capable as one made by
# the newest CLI, whichever build runs here. Scopes are only ever added, never dropped.
FULL_SCOPES = ["org:create_api_key", "user:profile", "user:inference", "user:sessions:claude_code",
               "user:mcp_servers", "user:file_upload", "user:plugins"]


def widen_scopes(url):
    parts = urllib.parse.urlsplit(url)
    query = []
    for k, v in urllib.parse.parse_qsl(parts.query, keep_blank_values=True):
        if k == "scope":
            have = v.split()
            v = " ".join(have + [sc for sc in FULL_SCOPES if sc not in have])
        query.append((k, v))
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


def make_browser_helper(workdir):
    path = os.path.join(workdir, "open-url")
    with open(path, "w") as f:
        f.write(BROWSER_HELPER)
    os.chmod(path, 0o755)
    return path


def parse_callback(text, state):
    """Code and state from a pasted callback address, `code#state`, or a bare code."""
    c = text.strip().strip("'\"")
    code = st = None
    m = re.search(r"[?&#]code=([^&#\s]+)", c)
    if m:
        code = urllib.parse.unquote(m.group(1))
    m = re.search(r"[?&#]state=([^&#\s]+)", c)
    if m:
        st = urllib.parse.unquote(m.group(1))
    if not code:
        code, _, st2 = c.partition("#")
        st = st or st2 or None
    return code.strip(), (st or state)


def forward_callback(port, code, state, out):
    """Deliver the code to the CLI's own localhost callback server, as the browser would have."""
    try:
        conn = http.client.HTTPConnection("localhost", port, timeout=EXCHANGE_DEADLINE + 30)
        conn.request("GET", "/callback?" + urllib.parse.urlencode({"code": code, "state": state}))
        out["status"] = conn.getresponse().status
        conn.close()
    except Exception as e:  # noqa: BLE001
        out["error"] = str(e)


def spawn(spec, extra_env=None):
    return spawn_with_args(spec, ["auth", "login", "--claudeai"], extra_env)


def spawn_with_args(spec, args, extra_env=None):
    cmd = list(spec["cmd"])
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update({k: str(v) for k, v in (spec.get("env") or {}).items()})
        os.environ.update(extra_env or {})
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLUMNS"] = "2000"
        os.environ["LINES"] = "40"
        os.environ.pop("ANTHROPIC_API_KEY", None)  # subscription only, never an API key
        try:
            os.execvp(cmd[0], cmd + list(args))
        except OSError as e:
            # Lands in the pty, so the parent can report it instead of "no link".
            os.write(1, f"cannot run {cmd[0]}: {e.strerror or e}\r\n".encode())
        os._exit(127)

    # Very wide pty window so URLs are never soft-wrapped at 80 cols.
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 2000, 0, 0))
    except OSError:
        pass
    return pid, fd


class Attempt:
    """One run of `<cli> auth login`. Result: 'ok', 'fail' (with reason) or 'no_url'."""

    def __init__(self, spec):
        self.spec = spec
        self.cli = spec["cmd"][-1]
        self.raw = ""
        self.url_sent = False
        self.manual_url = None
        self.manual_seen_at = None
        self.auto_url = None
        self.port = None
        self.code_sent = False
        self.token_sent = False
        self.state = ""
        self.reason = ""
        self.status = ""
        self.timed_out = False
        self.code_mark = 0
        self.sent_code = "\0"
        self.forward = {}

    def run(self):
        work = tempfile.mkdtemp(prefix="droidagent-login-")
        url_file = os.path.join(work, "auth-url")
        env = {"BROWSER": make_browser_helper(work), "DROIDAGENT_AUTH_URL_FILE": url_file}
        pid, fd = spawn(self.spec, env)
        stdin_fd = sys.stdin.fileno()
        stdin_open = True
        started = time.time()
        code_at = None
        try:
            while True:
                if self.manual_url and not self.url_sent:
                    self._pick_link(url_file)
                if not self.url_sent:
                    timeout = URL_DEADLINE - (time.time() - started)
                    if self.manual_url:
                        timeout = min(timeout, 0.2)  # waiting a moment for the automatic link
                elif not self.code_sent:
                    timeout = CODE_DEADLINE - (time.time() - self.url_at)
                else:
                    timeout = EXCHANGE_DEADLINE - (time.time() - code_at)
                if timeout <= 0:
                    self.timed_out = True
                    break
                watch = [fd]
                if self.url_sent and not self.code_sent and stdin_open:
                    watch.append(stdin_fd)
                r, _, _ = select.select(watch, [], [], timeout)
                if not r:
                    if self.manual_url and not self.url_sent:
                        continue
                    self.timed_out = True
                    break
                if stdin_fd in r:
                    line = sys.stdin.readline()
                    if not line:
                        stdin_open = False  # server went away; nothing more will come
                        continue
                    if not line.strip():
                        continue
                    self._submit(fd, line)
                    self.code_sent = True
                    self.code_mark = len(self.raw)
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

        status = _reap(pid)
        return self._verdict(status, time.time() - started)

    def _pick_link(self, url_file):
        """Prefer the automatic link (the CLI asks $BROWSER to open it right after printing the
        manual one); fall back to the manual link if none shows up within a few seconds."""
        try:
            with open(url_file) as f:
                links = [l.strip() for l in f if "oauth/authorize" in l]
        except OSError:
            links = []
        auto = next((l for l in links if "redirect_uri=http%3A%2F%2Flocalhost" in l), None)
        if auto:
            m = re.search(r"redirect_uri=http%3A%2F%2Flocalhost%3A(\d+)", auto)
            self.port = int(m.group(1)) if m else None
        if auto and self.port:
            self.auto_url = auto
            self._send_url("auto", auto)
        elif time.time() - self.manual_seen_at > 4:
            self._send_url("manual", self.manual_url)

    def _send_url(self, mode, url):
        url = widen_scopes(url)
        m_state = re.search(r"[?&]state=([A-Za-z0-9_-]+)", url)
        if m_state:
            self.state = m_state.group(1)
        emit("MODE " + mode)
        emit("URL " + url)
        emit("NEED_CODE")
        self.url_sent = True
        self.url_at = time.time()
        self.status_mark = len(self.raw)

    def _submit(self, fd, line):
        if self.port:
            code, state = parse_callback(line, self.state)
            self.sent_code = code or "\0"
            threading.Thread(target=forward_callback, args=(self.port, code, state, self.forward), daemon=True).start()
        else:
            self.sent_code = normalize_code(line, self.state)
            os.write(fd, self.sent_code.encode())
            time.sleep(0.15)
            os.write(fd, b"\r")

    def _on_output(self):
        """Scan new output. True means the attempt is over (failed) and the child should go."""
        if not self.manual_url:
            url = extract_url(self.raw)
            if url:
                self.manual_url = url
                self.manual_seen_at = time.time()
        if not self.token_sent:
            t = TOKEN_RE.search(self.raw)
            if t:
                emit("TOKEN " + t.group(0))
                self.token_sent = True
        if not self.url_sent:
            return False
        # What the CLI says after the link went out, minus any echo of a typed code.
        after = self.raw[self.status_mark:].replace(self.sent_code, "")
        line = tail_reason(after, 120).split(" / ")[-1]
        if line and line != self.status:
            self.status = line
            emit("STATUS " + line)
        # Fast exit on a rejected code instead of hanging until the timeout.
        if re.search(r"(OAuth error|Invalid code|OAuth\s+failed|Login failed|Request failed with status code)", after, re.I):
            if re.search(r"(status code 400|Invalid code|wasn't accepted|not accepted|expired|invalid_grant)", after, re.I):
                self.reason = "授权码无效或已过期，请重新点「开始登录」再授权一次"
            elif NET_ERR_RE.search(clean(after)):
                self.reason = "无法连接 Anthropic 服务器换取登录凭据。请检查网络，或在下方填写代理后重试"
            else:
                self.reason = tail_reason(after, 160) or "授权验证失败，请重试"
            return True
        return False

    def _verdict(self, status, elapsed):
        exit_ok = status is not None and os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0
        text = clean(self.raw)
        if self.token_sent or re.search(r"(login successful|token saved|saved token)", text, re.I) or (
                self.code_sent and exit_ok):
            return "ok"
        if not self.url_sent:
            code = ""
            if status is not None and os.WIFEXITED(status):
                code = f"退出码 {os.WEXITSTATUS(status)}"
            elif status is not None and os.WIFSIGNALED(status):
                code = f"被信号 {os.WTERMSIG(status)} 终止"
            what = tail_reason(self.raw)
            if re.search(r"bun\.report|Bun has crashed|oh no: Bun", self.raw):
                what = "运行时启动即崩溃（Bun）"
            if elapsed >= URL_DEADLINE - 1:
                code = f"{URL_DEADLINE} 秒内没有给出登录链接"
            self.reason = "；".join(x for x in (what, code) if x) or "命令没有任何输出"
            return "no_url"
        after = clean(self.raw[self.status_mark:])
        if self.timed_out and not self.code_sent:
            self.reason = "登录超时（10 分钟内没有完成授权），请重新点「开始登录」"
        elif NET_ERR_RE.search(after):
            self.reason = "无法连接 Anthropic 服务器换取登录凭据。请检查网络，或在下方填写代理后重试"
        elif self.timed_out:
            self.reason = NO_ANSWER.format(secs=EXCHANGE_DEADLINE)
        elif self.forward.get("error"):
            self.reason = "没能把授权码交给 claude：" + self.forward["error"][:120]
        else:
            self.reason = tail_reason(after, 160) or "登录未完成，请重试"
        return "fail"


def candidates():
    raw = os.environ.get("CLAUDE_CLI_SPECS")
    if raw:
        try:
            specs = [s for s in json.loads(raw) if s.get("cmd")]
            if specs:
                return specs
        except (ValueError, AttributeError):
            pass
    paths = [a for a in sys.argv[1:] if a]
    if not paths:
        p = shutil.which("claude")
        if p:
            paths.append(p)
    return [{"label": "SDK 内置 claude" if "claude-agent-sdk" in p else p, "cmd": [p], "env": {}} for p in paths]


def main():
    clis = candidates()
    if not clis:
        emit("DONE fail 找不到 Claude Code 命令行（claude）。请在 Debian 里执行 "
             "`npm i -g @anthropic-ai/claude-code`，或运行 `debian appdeps` 重装依赖")
        return

    reasons = []
    for spec in clis:
        a = Attempt(spec)
        result = a.run()
        log_transcript(" ".join(spec["cmd"]) + "".join(f" [{k}={v}]" for k, v in (spec.get("env") or {}).items()),
                       a.raw, result)
        if result == "ok":
            emit("DONE ok")
            return
        if result == "fail" or a.url_sent:
            emit("DONE fail " + (a.reason or "登录未完成，请重试"))
            return
        # No link at all: this binary can't do it here; try the next one, if any.
        reasons.append(f"{spec.get('label') or spec['cmd'][-1]}：{a.reason}")

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
