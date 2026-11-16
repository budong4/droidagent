// The Antigravity backend: Google's official `agy` CLI, unmodified, run headless — one short
// process per turn (`agy -p … --output-format stream-json`), with `--conversation` carrying the
// thread from one turn to the next. See common.mjs for what a backend hands the server.
//
// Signing in is agy's own flow (agy_login_pty.py); this file never reads the token it stores,
// only whether one is there. Everything asked of Google goes through the binary.
//
// What headless agy cannot do is ask: a step that needs approval is refused on the spot. So the
// phone-facing work (shell commands, writing files) is offered to it as tools of our own over
// MCP (agy_bridge.mjs), which come back to this server and through the same policy and
// confirmation cards as Claude's.
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync, createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, rm, chmod, readdir, lstat, readlink, symlink, unlink, copyFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { channel, agySlug } from './common.mjs';
import { readThoughts, lastStepIndex } from './agy_thoughts.mjs';
import { skillsIn, syncSkillLinks, agyPluginDirs } from './shared_plugins.mjs';

// Where the official installer (antigravity.google/cli/install.sh) gets its releases.
const RELEASES = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app';
export const BRIDGE_SERVER = 'droidagent'; // our tools' name in agy's MCP list

// ---------------------------------------------------------------- pure pieces (tested without agy)

export function agyPlatform(arch = process.arch, musl = existsSync('/lib/ld-musl-aarch64.so.1') || existsSync('/lib/ld-musl-x86_64.so.1')) {
	const a = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'amd64' : null;
	return a ? `linux_${a}${musl ? '_musl' : ''}` : null;
}

// `agy models`: a JSON list on some builds, a two-column table (slug, name) on others.
export function parseAgyModels(stdout) {
	const text = String(stdout || '').trim();
	const out = [];
	const seen = new Set();
	const add = (slug, label) => {
		slug = String(slug || '').trim();
		if (!slug || seen.has(slug)) return;
		seen.add(slug);
		out.push({ slug, label: String(label || '').trim() || slug });
	};
	try {
		const j = JSON.parse(text);
		const list = Array.isArray(j) ? j : Array.isArray(j?.models) ? j.models : null;
		if (list) {
			for (const m of list) {
				if (typeof m === 'string') add(m, m);
				else if (m && typeof m === 'object') add(m.id ?? m.slug ?? m.name, m.display_name ?? m.displayName ?? m.label ?? m.name);
			}
			return out;
		}
	} catch { /* a table */ }
	for (const line of text.split('\n')) {
		const t = line.trim();
		if (!t || /^(fetching|error|failed|warning|please sign in|tip:|usage:)/i.test(t)) continue;
		const m = t.match(/^(\S+)(?:\t+|\s{2,})(.+)$/);
		if (m) add(m[1], m[2]);
		else if (/^[a-z0-9][\w.:-]*$/i.test(t)) add(t, t);
	}
	return out;
}

// The app's execution modes, as far as a run that cannot ask goes. Only Full access lets agy's
// own tools do everything; below it, what needs approval goes through our tools instead.
const MODE_ARGS = {
	plan: ['--mode', 'plan'],
	default: ['--mode', 'default'],
	acceptEdits: ['--mode', 'accept-edits'],
	auto: ['--mode', 'accept-edits'],
	bypassPermissions: ['--dangerously-skip-permissions'],
};
export function agyArgs({ mode, model, conversation, prompt, viaStdin = false }) {
	const args = ['--output-format', 'stream-json', ...(MODE_ARGS[mode] || MODE_ARGS.default)];
	if (model) args.push('--model', model);
	if (conversation) args.push('--conversation', conversation);
	// A long message goes in on stdin: one argument holds 128 KB at most.
	if (viaStdin) args.push('--input-format', 'stream-json');
	else args.push('-p', prompt);
	return args;
}
export const agyStdinLine = (prompt) => JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } }) + '\n';

// agy names its tools and their arguments its own way (run_command{CommandLine}, view_file{AbsolutePath}, …).
// Reshaped into Claude Code's, the same cards, titles and policy serve both.
const pick = (o, ...keys) => {
	if (!o || typeof o !== 'object') return undefined;
	for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
	const lower = Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase().replace(/_/g, ''), v]));
	for (const k of keys) { const v = lower[k.toLowerCase().replace(/_/g, '')]; if (v !== undefined && v !== null && v !== '') return v; }
	return undefined;
};
const asObject = (v) => {
	if (v && typeof v === 'object') return v;
	if (typeof v === 'string') { try { const j = JSON.parse(v); if (j && typeof j === 'object') return j; } catch { /* not JSON */ } }
	return {};
};
export function normalizeAgyTool(name, params) {
	const p = asObject(params);
	const n = String(name || '');
	const path = pick(p, 'AbsolutePath', 'TargetFile', 'Path', 'File', 'file_path');
	if (n === 'run_command' || n === 'command') return { name: 'Bash', input: { command: String(pick(p, 'CommandLine', 'Command', 'Cmd') ?? ''), description: pick(p, 'Description') } };
	if (n === 'view_file' || n === 'read_file' || n === 'view_file_outline' || n === 'view_code_item') return { name: 'Read', input: { file_path: path || '' } };
	if (n === 'write_to_file' || n === 'write_file') return { name: 'Write', input: { file_path: path || '' } };
	if (n === 'replace_file_content' || n === 'multi_replace_file_content' || n === 'edit_file') return { name: 'Edit', input: { file_path: path || '' } };
	if (n === 'list_dir') return { name: 'LS', input: { path: pick(p, 'DirectoryPath', 'Path', 'AbsolutePath') || '' } };
	if (n === 'find_by_name') return { name: 'Glob', input: { pattern: pick(p, 'Pattern') || '', path: pick(p, 'SearchDirectory', 'SearchPath') } };
	if (n === 'grep_search' || n === 'codebase_search') return { name: 'Grep', input: { pattern: pick(p, 'Query', 'QueryString', 'Pattern', 'Regex') || '', path: pick(p, 'SearchPath', 'SearchDirectory') } };
	if (n === 'search_web') return { name: 'WebSearch', input: { query: pick(p, 'Query', 'QueryString') || '' } };
	if (n === 'read_url_content') return { name: 'WebFetch', input: { url: pick(p, 'Url', 'URL') || '' } };
	if (n === 'call_mcp_tool' || n === 'mcp_tool') {
		const server = String(pick(p, 'ServerName', 'Server') ?? '');
		const tool = String(pick(p, 'ToolName', 'Tool', 'Name') ?? '');
		const args = asObject(pick(p, 'Arguments', 'Args', 'Input'));
		// Our own tools show as what they are: a command, a file written.
		if (server === BRIDGE_SERVER && tool === 'shell') return { name: 'Bash', input: { command: String(args.command ?? ''), description: args.description } };
		if (server === BRIDGE_SERVER && tool === 'write_file') return { name: 'Write', input: { file_path: String(args.path ?? '') } };
		return { name: `mcp__${server || 'mcp'}__${tool || 'tool'}`, input: args };
	}
	if (n === 'browser_subagent' || /subagent/.test(n)) return { name: 'Task', input: { description: pick(p, 'TaskName', 'Task', 'Description') } };
	return { name: n || 'tool', input: p };
}

// What agy says when things go wrong, in the owner's words.
const NETWORK = /(TLS handshake|i\/o timeout|connection (refused|reset)|no such host|EOF\b|network (error|is unreachable)|dial tcp|context deadline exceeded|proxyconnect)/i;
export function agyErrorText(error, stderr = '') {
	const e = String(error || '').trim();
	const all = `${e}\n${stderr}`;
	if (/location is not supported|not (currently )?available in your location|not eligible/i.test(all) && !NETWORK.test(all)) {
		return { code: 'region', text: `Google 不在当前网络所在的地区提供 Antigravity。需要让手机里的 Linux 环境走支持地区的代理（设置里的网络代理）。${e ? `原始提示：${e.slice(0, 200)}` : ''}` };
	}
	if (NETWORK.test(all)) return { code: 'network', text: `连不上 Google 的服务器（${(e || stderr.trim().split('\n').pop() || '').slice(0, 160)}）。请检查网络代理。` };
	if (/not logged in|authentication (required|failed|timed out)|please sign in|UNAUTHENTICATED|invalid_grant/i.test(all)) {
		return { code: 'auth', text: 'Antigravity 还没有登录，或者登录已经失效。请在「设置 → Antigravity」里重新登录。' };
	}
	if (/RESOURCE_EXHAUSTED|quota (reached|exceeded)|rate limit/i.test(all)) return { code: 'quota', text: `Antigravity 的额度用完了：${e.slice(0, 240)}` };
	if (/invalid model selection|not recognized as a known model/i.test(all)) return { code: 'model', text: `这个模型当前用不了，换一个试试：${e.slice(0, 240)}` };
	return { code: 'error', text: (e || stderr.trim().split('\n').filter(Boolean).pop() || 'Antigravity 没有给出原因').slice(0, 400) };
}
export const isNetworkTrouble = (text) => NETWORK.test(String(text || ''));
const DENIED = /permission denied|denied automatically|user denied|requires? approval|not (allowed|permitted)|was (denied|rejected)/i;

// One turn's stdout, a line at a time -> turn events. `key` makes this turn's step ids unique.
export function createAgyMapper(key = randomUUID().slice(0, 8)) {
	const tools = new Map(); // step index -> { id, done }
	const texts = new Map(); // step index -> what has been shown of it (builds that send the whole text each time)
	const state = { sawResult: false, sawText: false, denied: false, activeTools: 0, conversation: null, textOpen: false };
	const closeText = () => { if (!state.textOpen) return []; state.textOpen = false; return [{ type: 'text_end' }]; };

	const seenSteps = new Set();
	function step(su) {
		const out = [];
		const type = String(su.step_type || '');
		const stateName = String(su.state ?? su.status ?? '').toUpperCase();
		const idx = su.step_index ?? su.idx ?? su.step_id ?? 0;
		const over = stateName === 'DONE' || stateName === 'ERROR';
		state.lastStep = { type, isNew: !seenSteps.has(idx), over };
		seenSteps.add(idx);
		if (su.conversation_id) state.conversation = su.conversation_id;

		if (type === 'agent_response' || type === 'text') {
			let delta = typeof su.text_delta === 'string' ? su.text_delta : '';
			if (!delta && typeof su.text === 'string') {
				const shown = texts.get(idx) || '';
				delta = su.text.startsWith(shown) ? su.text.slice(shown.length) : su.text;
				texts.set(idx, su.text);
			}
			if (delta) { state.sawText = true; state.textOpen = true; out.push({ type: 'text_delta', text: delta }); }
			if (over) out.push(...closeText());
		} else if (type === 'tool') {
			const info = su.tool_info && typeof su.tool_info === 'object' ? su.tool_info : {};
			let t = tools.get(idx);
			if (!t) {
				out.push(...closeText()); // what it said before this step is a message of its own
				const tool = normalizeAgyTool(info.name || su.tool_name, info.parameters);
				t = { id: `agy-${key}-${idx}`, done: false };
				tools.set(idx, t);
				state.activeTools++;
				out.push({ type: 'tool_use', id: t.id, name: tool.name, input: tool.input });
			}
			const failed = stateName === 'ERROR' || !!info.error;
			if (!t.done && (over || failed || info.output !== undefined)) {
				t.done = true;
				state.activeTools--;
				const message = info.error ? String(info.error.message ?? info.error.type ?? info.error) : '';
				if (failed && DENIED.test(message)) state.denied = true;
				const output = typeof info.output === 'string' ? info.output : info.output === undefined ? '' : JSON.stringify(info.output);
				out.push({ type: 'tool_result', id: t.id, ok: !failed, text: failed ? (message || output || '这一步失败了') : output });
			}
		}
		return out;
	}

	function feed(line) {
		const s = String(line || '').trim();
		if (!s.startsWith('{')) return [];
		let ev;
		try { ev = JSON.parse(s); } catch { return []; }
		if (!ev || typeof ev !== 'object') return [];
		state.lastStep = null;
		if (ev.event === 'init') {
			state.conversation = ev.conversation_id || state.conversation;
			return [{ type: 'init', ref: state.conversation, model: ev.init?.model ?? ev.model ?? null }];
		}
		// What a slash command answered (/usage and the like): shown as it is.
		if (ev.event === 'command_result') {
			const c = ev.command && typeof ev.command === 'object' ? ev.command : {};
			const said = typeof c.output === 'string' ? c.output : typeof c.text === 'string' ? c.text : c.data !== undefined ? JSON.stringify(c.data, null, 2) : '';
			return said.trim() ? [{ type: 'command_output', text: `/${c.name || ''}\n${said.trim()}` }] : [];
		}
		if (ev.event === 'step_update') return step(ev.step_update && typeof ev.step_update === 'object' ? ev.step_update : ev);
		if (ev.event === 'result') {
			const r = ev.result && typeof ev.result === 'object' ? ev.result : ev;
			if (r.conversation_id) state.conversation = r.conversation_id;
			state.sawResult = true;
			const out = closeText();
			const response = String(r.response || '').trim();
			// A turn whose answer was never streamed still has one.
			if (response && !state.sawText) out.push({ type: 'text', text: response });
			const failed = !!r.error || /^(ERROR|INVALID|CANCELED|INTERRUPTED)$/i.test(String(r.status || ''));
			const err = failed ? agyErrorText(r.error || `Antigravity 结束时的状态是 ${r.status}`) : null;
			out.push({
				type: 'result', ok: !failed, text: response, subtype: failed ? 'error' : 'success', errors: err ? [err.text] : [], code: err?.code,
				costUsd: 0, durationMs: Math.round((Number(r.duration_seconds) || 0) * 1000), usage: r.usage || null,
			});
			return out;
		}
		return [];
	}
	return { feed, state };
}

// `agy -p /usage --output-format stream-json`: the same numbers agy's own /usage shows. Either a
// command_result line, or a tab-separated table (group, window, percent left, reset time).
export function parseAgyUsage(stdout) {
	const groups = [];
	const bucket = (b) => {
		const left = Number(b.remaining_fraction ?? b.remainingFraction);
		const window = String(b.window || b.id || '').toLowerCase();
		return {
			window: /week/.test(window) ? 'week' : '5h',
			utilization: Number.isFinite(left) ? Math.round((1 - Math.min(1, Math.max(0, left))) * 1000) / 10 : null,
			resets_at: b.reset_time ?? b.resetTime ?? null,
		};
	};
	for (const line of String(stdout || '').split('\n')) {
		const t = line.trim();
		if (!t.startsWith('{')) continue;
		let j;
		try { j = JSON.parse(t); } catch { continue; }
		if (j?.event !== 'command_result' || j.command?.name !== 'usage' || !Array.isArray(j.command?.data?.groups)) continue;
		for (const g of j.command.data.groups) {
			if (!g?.name) continue;
			groups.push({ name: String(g.name), description: g.description ? String(g.description) : '', buckets: (Array.isArray(g.buckets) ? g.buckets : []).filter((b) => b && typeof b === 'object').map(bucket) });
		}
		if (groups.length) return groups;
	}
	const byName = new Map();
	for (const line of String(stdout || '').split('\n')) {
		const cells = line.split('\t').map((c) => c.trim());
		if (cells.length < 3) continue;
		const pct = parseFloat(cells[2].replace('%', ''));
		if (!Number.isFinite(pct)) continue;
		if (!byName.has(cells[0])) byName.set(cells[0], { name: cells[0], description: '', buckets: [] });
		byName.get(cells[0]).buckets.push(bucket({ window: /week/i.test(cells[1]) ? 'weekly' : '5h', remaining_fraction: pct / 100, reset_time: cells[3] || null }));
	}
	return [...byName.values()];
}
// Which group a model draws from: Argon has its own, Claude and GPT share one, the rest is Gemini's.
// (The Argon group's description mentions Gemini too, so Argon is settled first.)
const usageKind = (text) => (/argon/.test(text) ? 'argon' : /claude|gpt|opus|sonnet/.test(text) ? 'other' : /gemini/.test(text) ? 'gemini' : '');
export function usageGroupFor(groups, slug) {
	const want = usageKind(String(slug || '').toLowerCase()) || 'gemini';
	const kindOf = (g) => usageKind(String(g.name).toLowerCase()) || usageKind(String(g.description).toLowerCase());
	return groups.find((g) => kindOf(g) === want) || groups[0] || null;
}

// What the first message of a conversation carries ahead of the owner's words: agy has no flag
// for a system prompt, so the phone's instructions and the notes go in here.
export function withPreamble(preamble, text) {
	const p = String(preamble || '').trim();
	return p ? `${p}\n\n---\n\n【用户的消息】\n${text}` : text;
}

// ---------------------------------------------------------------- agy's own files, kept in step with the app

// Reads a JSON file agy also writes; a broken or missing one counts as empty rather than being
// replaced blindly (the caller only writes when it has something to change).
async function readJson(file) {
	try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { return e?.code === 'ENOENT' ? {} : null; }
}
async function writeJson(file, value, mode) {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: mode || 0o600 });
	await rename(tmp, file);
}
// An app connector, as agy's mcp_config.json wants it. agy speaks stdio and streamable HTTP only.
export function toAgyMcp(c) {
	if (!c || typeof c !== 'object') return null;
	if (c.type === 'sse') return null;
	if (c.type === 'http') return c.url ? { serverUrl: c.url, ...(c.headers && Object.keys(c.headers).length ? { headers: c.headers } : {}) } : null;
	if (!c.command) return null;
	return { command: c.command, args: c.args || [], ...(c.env && Object.keys(c.env).length ? { env: c.env } : {}) };
}
// The next mcp_config.json: ours added or refreshed, ours that are gone removed, the owner's own
// entries (anything we did not put there) left exactly as they are.
export function mergeAgyMcp(current, mine, managedBefore = []) {
	const servers = { ...(current?.mcpServers && typeof current.mcpServers === 'object' ? current.mcpServers : {}) };
	const managed = [];
	for (const name of managedBefore) if (!(name in mine)) delete servers[name];
	for (const [name, entry] of Object.entries(mine)) {
		if (name in servers && !managedBefore.includes(name)) continue; // the owner's: not ours to replace
		servers[name] = entry;
		managed.push(name);
	}
	return { config: { ...(current || {}), mcpServers: servers }, managed };
}
// The next permission allow-list in agy's settings.json: our rules for this mode in, our rules
// from another mode out, the owner's untouched.
export function mergeAgyAllow(current, mine, managedBefore = []) {
	const perms = current?.permissions && typeof current.permissions === 'object' ? current.permissions : {};
	const allow = (Array.isArray(perms.allow) ? perms.allow : []).filter((r) => !managedBefore.includes(r) || mine.includes(r));
	const managed = [];
	for (const r of mine) {
		if (allow.includes(r)) { if (managedBefore.includes(r)) managed.push(r); continue; }
		allow.push(r);
		managed.push(r);
	}
	return { settings: { ...(current || {}), permissions: { ...perms, allow } }, managed };
}
// Which of agy's own approvals each mode grants up front. Our tools always: they ask for
// themselves. Other connectors where the app's policy lets Claude use them without asking.
export function agyAllowRules(mode) {
	const rules = [`mcp(${BRIDGE_SERVER}/*)`];
	if (mode === 'acceptEdits' || mode === 'auto') rules.push('mcp(*)');
	return rules;
}

// ---------------------------------------------------------------- the backend

export function createAgyBackend({ log, home, serverDir, fetchUrl, stateDir, cacheDir }) {
	const GEMINI = join(home, '.gemini');
	const TOKEN_FILE = join(GEMINI, 'antigravity-cli', 'antigravity-oauth-token');
	const SETTINGS_FILE = join(GEMINI, 'antigravity-cli', 'settings.json');
	const MCP_CONFIG = join(GEMINI, 'config', 'mcp_config.json');
	const SKILLS_DIR = join(GEMINI, 'skills');
	const MANAGED_FILE = join(stateDir, 'agy-managed.json');
	const INSTALL_PATH = join(home, '.local', 'bin', 'agy');
	const IDLE_MS = Number(process.env.AGENT_AGY_IDLE_MS) || 10 * 60 * 1000;

	// There is no desktop keyring in the chroot. Pointing D-Bus at nothing makes agy skip its
	// ten-second wait for one and keep the login in its own file, the same on every run. It does
	// not update itself between turns either: the app does that, when asked.
	function env(extra = {}) {
		return {
			...process.env,
			DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(GEMINI, '.no-session-bus')}`,
			AGY_CLI_DISABLE_AUTO_UPDATE: process.env.AGY_CLI_DISABLE_AUTO_UPDATE || 'true',
			...extra,
		};
	}

	function find() {
		const candidates = [process.env.AGENT_AGY_BIN, ...String(process.env.PATH || '').split(':').filter(Boolean).map((d) => join(d, 'agy')), INSTALL_PATH];
		return candidates.find((p) => p && existsSync(p)) || null;
	}
	// One run to completion, stdin closed at once: agy waits for ever on an open pipe.
	function run(args, { timeout = 60000, cwd } = {}) {
		return new Promise((resolve) => {
			const bin = find();
			if (!bin) return resolve({ code: 127, stdout: '', stderr: '没有安装 Antigravity CLI' });
			execFile(bin, args, { timeout, cwd, env: env(), maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
				resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), timedOut: !!err?.killed });
			}).stdin?.end();
		});
	}

	let versionCache = { key: '', version: '' };
	async function version() {
		const bin = find();
		if (!bin) return '';
		let key = bin;
		try { const s = statSync(bin); key = `${bin}:${s.size}:${s.mtimeMs}`; } catch { /* gone */ }
		if (versionCache.key === key) return versionCache.version;
		const r = await run(['--version'], { timeout: 45000 });
		const v = (r.stdout.match(/\d+\.\d+\.\d+[\w.-]*/) || [''])[0];
		if (v) versionCache = { key, version: v };
		else log('[agy] --version failed:', (r.stderr || r.stdout).trim().split('\n').pop()?.slice(0, 200) || `exit ${r.code}`);
		return v;
	}

	function loggedIn() {
		try {
			const t = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'))?.token;
			return !!(t && (t.refresh_token || t.access_token));
		} catch { return false; }
	}
	async function logout() {
		await rm(TOKEN_FILE, { force: true });
		modelCache = { t: 0, models: [] };
		usageCache = { t: 0, groups: null };
	}

	// ---- installing / updating the binary (what install.sh does, checksum included)
	let installing = null;
	function install({ onStatus = () => {}, force = false } = {}) {
		if (installing) return installing;
		installing = (async () => {
			const platform = agyPlatform();
			if (!platform) throw new Error(`Antigravity CLI 没有 ${process.arch} 架构的版本`);
			onStatus('正在查询 Antigravity CLI 的最新版本…');
			const manifest = JSON.parse((await fetchUrl(`${RELEASES}/manifests/${platform}.json`, { timeout: 30000 })).body);
			if (!/^https:\/\//.test(manifest.url || '') || !/^[0-9a-f]{128}$/i.test(manifest.sha512 || '')) throw new Error('发布信息不完整');
			if (!force && find() && (await version()) === manifest.version) return { version: manifest.version, updated: false };
			await mkdir(cacheDir, { recursive: true });
			const archive = join(cacheDir, 'agy-download');
			await rm(archive, { force: true });
			const size = () => { try { return statSync(archive).size; } catch { return 0; } };
			const tick = setInterval(() => onStatus(`正在下载 Antigravity CLI ${manifest.version}（已下载 ${(size() / 1048576).toFixed(0)} MB，共约 100 MB）`), 1500);
			try { await fetchUrl(manifest.url, { file: archive, timeout: 60000 }); } finally { clearInterval(tick); }
			onStatus('正在核对下载的文件…');
			const digest = await new Promise((resolve, reject) => {
				const h = createHash('sha512');
				createReadStream(archive).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
			});
			if (digest !== manifest.sha512.toLowerCase()) { await rm(archive, { force: true }); throw new Error('下载的文件校验不通过，可能没有下完整，请重试'); }
			const staged = join(cacheDir, 'antigravity');
			await rm(staged, { force: true });
			if (/\.tar\.gz(\?|$)/.test(manifest.url)) {
				await new Promise((resolve, reject) => execFile('tar', ['-xzf', archive, '-C', cacheDir, 'antigravity'], (e, _o, se) => (e ? reject(new Error(`解压失败：${String(se || e.message).trim().slice(0, 200)}`)) : resolve())));
			} else {
				await rename(archive, staged);
			}
			await chmod(staged, 0o755);
			await mkdir(dirname(INSTALL_PATH), { recursive: true });
			// Onto the same filesystem first, then renamed: a turn starting now gets the old or the new, never half.
			await copyFile(staged, `${INSTALL_PATH}.new`);
			await chmod(`${INSTALL_PATH}.new`, 0o755);
			await rename(`${INSTALL_PATH}.new`, INSTALL_PATH);
			await rm(staged, { force: true });
			await rm(archive, { force: true });
			versionCache = { key: '', version: '' };
			const v = await version();
			if (!v) throw new Error('装好的 Antigravity CLI 在这台手机上启动不了（agy --version 没有回应）。日志里有它的报错。');
			log('[agy] installed', v, 'at', INSTALL_PATH);
			return { version: v, updated: true };
		})().finally(() => { installing = null; });
		return installing;
	}

	// ---- models
	let modelCache = { t: 0, models: [] };
	let modelLoad = null;
	async function models({ fresh = false } = {}) {
		if (!fresh && modelCache.models.length && Date.now() - modelCache.t < 10 * 60 * 1000) return { models: modelCache.models };
		if (modelLoad) return modelLoad;
		modelLoad = (async () => {
			const r = await run(['models'], { timeout: 60000 });
			const list = r.code === 0 ? parseAgyModels(r.stdout) : [];
			if (list.length) { modelCache = { t: Date.now(), models: list }; return { models: list }; }
			const err = agyErrorText('', `${r.stdout}\n${r.stderr}`);
			log('[agy] models failed:', err.text);
			return { models: modelCache.models, error: r.timedOut ? '读取模型列表超时' : err.text };
		})().finally(() => { modelLoad = null; });
		return modelLoad;
	}

	// ---- usage, as agy's own /usage reports it
	let usageCache = { t: 0, groups: null };
	let usageUnsupported = ''; // the version that answered /usage with a model turn: not asked again
	async function usage({ fresh = false } = {}) {
		if (usageCache.groups && Date.now() - usageCache.t < (fresh ? 15000 : 180000)) return { ok: true, groups: usageCache.groups };
		const v = await version();
		if (usageUnsupported && usageUnsupported === v) return { ok: false, error: '这个版本的 Antigravity CLI 不提供用量数据' };
		const r = await run(['-p', '/usage', '--output-format', 'stream-json'], { timeout: 30000 });
		const groups = parseAgyUsage(r.stdout);
		if (!groups.length) {
			const err = agyErrorText('', `${r.stdout}\n${r.stderr}`);
			if (/"event"\s*:\s*"step_update"/.test(r.stdout)) { usageUnsupported = v; return { ok: false, error: '这个版本的 Antigravity CLI 不提供用量数据' }; }
			return { ok: false, error: r.timedOut ? '读取用量超时' : err.code === 'error' ? '没有读到用量数据' : err.text };
		}
		usageCache = { t: Date.now(), groups };
		return { ok: true, groups };
	}

	// ---- plugins: agy's own `plugin` command
	async function plugins() {
		const r = await run(['plugin', 'list', '--json'], { timeout: 60000 });
		if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim().split('\n').pop()?.slice(0, 240) || '读取插件列表失败', plugins: [] };
		let list = [];
		try { const j = JSON.parse(r.stdout.slice(r.stdout.search(/[[{]/))); list = Array.isArray(j) ? j : Array.isArray(j?.plugins) ? j.plugins : []; } catch { /* none */ }
		return {
			ok: true,
			plugins: list.filter((p) => p && typeof p === 'object').map((p) => ({
				name: String(p.name ?? p.id ?? ''), version: String(p.version ?? ''), description: String(p.description ?? ''), source: String(p.source ?? p.url ?? p.path ?? ''),
			})).filter((p) => p.name),
		};
	}
	// A name from agy's catalog, a GitHub address, or a folder on the phone. Never an option.
	const PLUGIN_SOURCE = /^(?:[A-Za-z0-9@][\w.@-]{0,99}|https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/?|\/[\w./ @-]{1,300})$/;
	async function installPlugin(source) {
		const src = String(source || '').trim();
		if (!PLUGIN_SOURCE.test(src)) return { ok: false, error: '写插件的名字、GitHub 地址（https://github.com/作者/仓库）或手机上的文件夹路径' };
		const r = await run(['plugin', 'install', src], { timeout: 300000 });
		const said = (r.stderr || r.stdout).trim().split('\n').filter(Boolean).pop()?.slice(0, 300) || '';
		return r.code === 0 ? { ok: true, message: said } : { ok: false, error: said || `安装失败（${r.code}）` };
	}

	// ---- agy's files, kept in step: our tools and the app's connectors in its MCP list, the
	// approvals this mode grants, and the app's skills where agy looks for skills.
	async function readManaged() { return (await readJson(MANAGED_FILE)) || {}; }
	// `pluginSkills`: skills from Claude plugins ([{ name, dir }]), linked in next to the app's own.
	async function prepare({ mode, connectors = {}, skillsDir, bridge, pluginSkills = [], pluginRoots = [] }) {
		const managed = await readManaged();
		let changed = false;
		try {
			const mine = {};
			if (bridge) {
				mine[BRIDGE_SERVER] = {
					command: process.execPath, args: [join(serverDir, 'agy_bridge.mjs')],
					env: { DROIDAGENT_BRIDGE_URL: bridge.url, DROIDAGENT_BRIDGE_TOKEN: bridge.token },
					timeoutSeconds: 3600, // a command may run long, and may wait for the owner's answer first
				};
			}
			for (const [name, c] of Object.entries(connectors)) {
				const entry = toAgyMcp(c);
				if (entry && name !== BRIDGE_SERVER) mine[name] = entry;
			}
			const current = await readJson(MCP_CONFIG);
			if (current) {
				const next = mergeAgyMcp(current, mine, managed.mcp || []);
				if (JSON.stringify(next.config) !== JSON.stringify(current)) await writeJson(MCP_CONFIG, next.config);
				if (JSON.stringify(next.managed) !== JSON.stringify(managed.mcp || [])) { managed.mcp = next.managed; changed = true; }
			} else log('[agy] mcp_config.json is not valid JSON, leaving it alone');
		} catch (e) { log('[agy] connectors not synced:', e?.message); }
		try {
			const current = await readJson(SETTINGS_FILE);
			if (current) {
				const next = mergeAgyAllow(current, mode === 'bypassPermissions' ? [] : agyAllowRules(mode), managed.allow || []);
				if (JSON.stringify(next.settings) !== JSON.stringify(current)) await writeJson(SETTINGS_FILE, next.settings);
				if (JSON.stringify(next.managed) !== JSON.stringify(managed.allow || [])) { managed.allow = next.managed; changed = true; }
			} else log('[agy] settings.json is not valid JSON, leaving it alone');
		} catch (e) { log('[agy] approvals not synced:', e?.message); }
		// The app's enabled skills and the skills of enabled Claude plugins, as links in ~/.gemini/skills.
		// Ours are the links into the app's skills folder or into a Claude plugin; a real folder the
		// owner put there, or a link of theirs, is never touched.
		if (skillsDir) {
			const ours = (target) => dirname(target) === skillsDir || pluginRoots.some((r) => target.startsWith(r + '/')) || /\/\.claude\/plugins\//.test(target);
			await syncSkillLinks(SKILLS_DIR, [...await skillsIn(skillsDir), ...pluginSkills], ours).catch((e) => log('[agy] skills not linked:', e?.message));
		}
		if (changed) await writeJson(MANAGED_FILE, managed).catch((e) => log('[agy] state not saved:', e?.message));
	}

	function killTree(child) {
		if (!child?.pid) return;
		try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
		// A run stuck retrying a dead network ignores SIGTERM.
		const hard = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
		hard.unref?.();
		child.once('exit', () => clearTimeout(hard));
	}

	// One conversation. Nothing runs between turns: each message starts agy, which picks the
	// thread up by its id. `settings` is the live object, read afresh at every turn.
	// `prepareTurn()` is awaited before each start; `preamble()` gives the first message's lead-in.
	function open({ tag, cwd, settings, conversation = null, preamble, prepareTurn, turnEnv, showThoughts }) {
		const ch = channel();
		let conv = conversation;
		let child = null;
		let stopping = false;
		let tail = Promise.resolve();

		function turn(text) {
			return new Promise((done) => {
				(async () => {
					stopping = false;
					const bin = find();
					if (!bin) { ch.push({ type: 'result', ok: false, text: '', subtype: 'error', errors: ['还没有安装 Antigravity CLI。请在「设置 → Antigravity」里安装并登录。'], code: 'missing', costUsd: 0, durationMs: 0 }); return done(); }
					await prepareTurn?.().catch((e) => log('[agy]', `[${tag}]`, 'prepare:', e?.message));
					if (ch.ended || stopping) {
						if (!ch.ended) ch.push({ type: 'result', ok: false, text: '', subtype: 'interrupted', errors: [], costUsd: 0, durationMs: 0 });
						return done();
					}
					const prompt = (conv ? text : withPreamble(preamble?.(), text)).split('\u0000').join('');
					const thoughts = showThoughts?.() !== false;
					const beforeTurn = conv && thoughts ? await lastStepIndex(home, conv).catch(() => -1) : -1;
					const viaStdin = Buffer.byteLength(prompt) > 100000;
					const args = agyArgs({ mode: settings.mode, model: agySlug(settings.model), conversation: conv, prompt, viaStdin });
					const mapper = createAgyMapper();
					const started = Date.now();
					let stderr = '';
					let pending = '';
					let finished = false;
					let idle = null;
					let idleKilled = false;
					const armIdle = () => {
						clearTimeout(idle);
						idle = setTimeout(() => {
							if (mapper.state.activeTools > 0) return armIdle(); // a long command is not a hang
							idleKilled = true;
							killTree(child);
						}, IDLE_MS);
						idle.unref?.();
					};
					let over = false;
					const emit = (events) => {
						for (const ev of events) {
							if (ev.type === 'init') {
								if (!ev.ref || ev.ref === conv) continue; // every turn announces itself; once is news
								conv = ev.ref;
							}
							if (ev.type === 'result') {
								if (finished) continue;
								finished = true;
								// "Not logged in" is also what agy says when it could not reach Google to check.
								if (ev.code === 'auth' && isNetworkTrouble(stderr)) Object.assign(ev, { code: 'network', errors: [agyErrorText('', stderr).text] });
								if (mapper.state.denied && settings.mode !== 'bypassPermissions') {
									ch.push({ type: 'notice', text: 'Antigravity 自带的工具不能逐步确认，需要确认的那一步被它自己拒绝了。命令和写文件它可以改用 DroidAgent 的工具（会弹确认卡片）；想让它不受限制，把执行模式切到 Full access。' });
								}
								// The time the owner waited, not only what agy counted.
								ev.durationMs = Date.now() - started;
								// The answer is in; a process that lingers afterwards must not hold the next turn up.
								const lingering = child;
								setTimeout(() => { if (!over) killTree(lingering); }, 5000).unref?.();
							}
							ch.push(ev);
						}
					};
					// Thoughts: read from agy's record of the conversation (agy_thoughts.mjs) when a step
					// starts or ends, never in the middle of a reply being written, and all that remain
					// before the turn's result. Lines are handled one at a time, in order, for that.
					let baseline = null; // the last step of the conversation before this turn
					const shown = new Set();
					const flushThoughts = async () => {
						if (!conv || !thoughts) return;
						if (baseline === null) baseline = beforeTurn ?? -1;
						const found = await readThoughts(home, conv, baseline + 1).catch(() => new Map());
						for (const [idx, text] of found) {
							if (shown.has(idx)) continue;
							shown.add(idx);
							ch.push({ type: 'thinking', text });
						}
					};
					let lines = Promise.resolve();
					const handle = async (line) => {
						const peek = line.includes('"result"') && /"event"\s*:\s*"result"/.test(line);
						if (peek && !mapper.state.textOpen) await flushThoughts();
						const events = mapper.feed(line);
						const st = mapper.state.lastStep;
						// A new step: what led to it comes first.
						if (st?.isNew && !mapper.state.textOpen && !peek) await flushThoughts();
						emit(events);
						if (st?.over && !mapper.state.textOpen) await flushThoughts();
					};
					const onLine = (line) => { if (line.trim()) lines = lines.then(() => handle(line)).catch((e) => log('[agy]', `[${tag}]`, 'line:', e?.message)); };

					log('[agy]', `[${tag}]`, 'turn', conv ? `(conversation ${String(conv).slice(0, 8)})` : '(new conversation)', `mode=${settings.mode}`, `model=${agySlug(settings.model) || 'default'}`);
					try {
						child = spawn(bin, args, { cwd, env: env(turnEnv?.() || {}), detached: true, stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
					} catch (e) {
						ch.push({ type: 'result', ok: false, text: '', subtype: 'error', errors: [`启动不了 Antigravity CLI：${e?.message || e}`], costUsd: 0, durationMs: 0 });
						return done();
					}
					const me = child;
					if (viaStdin) { me.stdin.on('error', () => {}); me.stdin.end(agyStdinLine(prompt)); }
					armIdle();
					me.stdout.on('data', (d) => {
						armIdle();
						pending += d.toString('utf8');
						let i;
						while ((i = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, i); pending = pending.slice(i + 1); onLine(line); }
					});
					me.stderr.on('data', (d) => {
						const s = d.toString('utf8');
						stderr = (stderr + s).slice(-4096);
						for (const l of s.split('\n')) if (l.trim()) log('[agy]', `[${tag}]`, l.trim().slice(0, 300));
					});
					const end = async (code, signal, spawnError) => {
						if (over) return;
						over = true;
						clearTimeout(idle);
						if (pending.trim()) { onLine(pending); pending = ''; }
						if (child === me) child = null;
						await lines;
						if (!finished) {
							let ev;
							if (stopping) ev = { type: 'result', ok: false, text: '', subtype: 'interrupted', errors: [] };
							else if (idleKilled) ev = { type: 'result', ok: false, text: '', subtype: 'error', errors: [`Antigravity ${Math.round(IDLE_MS / 60000)} 分钟没有任何回应，已经停下。多半是网络断了，请检查代理后再发一次。`], code: 'network' };
							else {
								const err = spawnError ? { code: 'error', text: `启动不了 Antigravity CLI：${spawnError.message}` } : agyErrorText('', stderr || `agy 退出了（${signal || code}），没有给出结果`);
								ev = { type: 'result', ok: false, text: '', subtype: 'error', errors: [err.text], code: err.code };
							}
							emit([{ costUsd: 0, durationMs: 0, ...ev }]);
						}
						done();
					};
					me.on('error', (e) => end(null, null, e));
					me.on('close', (code, signal) => end(code, signal));
				})().catch((e) => {
					log('[agy]', `[${tag}]`, 'turn failed:', e?.stack || e);
					ch.push({ type: 'result', ok: false, text: '', subtype: 'error', errors: [String(e?.message || e)], costUsd: 0, durationMs: 0 });
					done();
				});
			});
		}

		return {
			events: ch,
			send(text) { tail = tail.then(() => (ch.ended ? null : turn(text))); },
			close() { ch.end(); stopping = true; killTree(child); },
			control: { interrupt() { stopping = true; killTree(child); } },
			spec: { label: 'Antigravity CLI', kind: 'agy', cmd: [find() || 'agy'], env: {} },
		};
	}

	// One question, one answer: what names a conversation. A Flash model when there is one.
	async function oneShot({ prompt, cwd, model, timeoutMs = 60000 }) {
		const cheap = modelCache.models.find((m) => /flash/i.test(m.slug) && !/high|xhigh|max/i.test(m.slug))?.slug || model || '';
		const r = await run(['--output-format', 'json', ...(cheap ? ['--model', cheap] : []), '-p', prompt], { timeout: timeoutMs, cwd });
		try { return String(JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))).response || ''); } catch { return ''; }
	}

	async function status() {
		const bin = find();
		return { installed: !!bin, path: bin, version: bin ? await version() : '', loggedIn: loggedIn(), installing: !!installing };
	}

	return { find, env, run, version, status, loggedIn, logout, install, models, usage, plugins, installPlugin, prepare, open, oneShot, paths: { TOKEN_FILE, SETTINGS_FILE, MCP_CONFIG, SKILLS_DIR, INSTALL_PATH } };
}
