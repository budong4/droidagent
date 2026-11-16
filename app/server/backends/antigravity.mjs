// The Antigravity backend: Google's official `agy` CLI, unmodified. A conversation runs through
// its Agent Client Protocol server (`agy acp`, see agy_acp.mjs): one process per conversation,
// streaming replies, thoughts and steps, and asking before a step that needs approval, which the
// app's own policy and confirmation cards answer. See common.mjs for what a backend hands the server.
//
// Signing in: agy_oauth.mjs. Short one-off questions (the model list, usage, a title) still use
// the CLI's own commands.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync, createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, rm, chmod, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { agySlug } from './common.mjs';
import { openAcp } from './agy_acp.mjs';
import { skillsIn, syncSkillLinks } from './shared_plugins.mjs';

// Where the official installer (antigravity.google/cli/install.sh) gets its releases.
const RELEASES = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app';

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
		return { name: `mcp__${server || 'mcp'}__${tool || 'tool'}`, input: args };
	}
	if (n === 'browser_subagent' || /subagent/.test(n)) return { name: 'Task', input: { description: pick(p, 'TaskName', 'Task', 'Description') } };
	return { name: n || 'tool', input: p };
}

// What agy says when things go wrong, in the owner's words.
const NETWORK = /(TLS handshake|i\/o timeout|connection (refused|reset)|no such host|EOF\b|network (error|is unreachable)|dial tcp|context deadline exceeded|proxyconnect)/i;
export function agyErrorText(error, stderr = '', code) {
	const e = String(error || '').trim();
	if (code === -32000) return { code: 'auth', text: 'Antigravity 还没有登录，或者登录已经失效。请在「设置 → Antigravity」里重新登录。' };
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
// agy asks before each step and the app answers, so no approvals are granted up front any more.
// Rules an earlier version added are taken out again by prepare().
export const agyAllowRules = () => [];

// ---------------------------------------------------------------- the backend

export function createAgyBackend({ log, home, serverDir, fetchUrl, stateDir, cacheDir }) {
	const GEMINI = join(home, '.gemini');
	const TOKEN_FILE = join(GEMINI, 'antigravity-cli', 'antigravity-oauth-token');
	const SETTINGS_FILE = join(GEMINI, 'antigravity-cli', 'settings.json');
	const MCP_CONFIG = join(GEMINI, 'config', 'mcp_config.json');
	const SKILLS_DIR = join(GEMINI, 'skills');
	const MANAGED_FILE = join(stateDir, 'agy-managed.json');
	const INSTALL_PATH = join(home, '.local', 'bin', 'agy');

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
	async function prepare({ mode, connectors = {}, skillsDir, pluginSkills = [], pluginRoots = [] }) {
		const managed = await readManaged();
		let changed = false;
		try {
			const mine = {};
			for (const [name, c] of Object.entries(connectors)) {
				const entry = toAgyMcp(c);
				if (entry) mine[name] = entry;
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
				const next = mergeAgyAllow(current, agyAllowRules(mode), managed.allow || []);
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

	// One conversation, through `agy acp`. `settings` is the live object (model, effort, mode).
	// Full access is the one mode where agy is told not to ask at all.
	function open({ tag, cwd, settings, conversation = null, preamble, prepareTurn, canUseTool, mcpServers = [] }) {
		const bin = find();
		if (!bin) {
			// Nothing to start: every message says how to get it.
			const missing = { type: 'result', ok: false, text: '', subtype: 'error', errors: ['还没有安装 Antigravity CLI。请在设置里的 Antigravity 卡片上安装并登录。'], code: 'missing', costUsd: 0, durationMs: 0 };
			const items = [];
			let wake = null;
			let ended = false;
			return {
				events: { async *[Symbol.asyncIterator]() { for (;;) { if (items.length) { yield items.shift(); continue; } if (ended) return; await new Promise((r) => { wake = r; }); } } },
				send() { items.push(missing); wake?.(); },
				close() { ended = true; wake?.(); },
				control: { interrupt() {}, supportedCommands: async () => [], options: () => [] },
				spec: { label: 'Antigravity CLI', kind: 'agy', cmd: ['agy'], env: {} },
			};
		}
		const args = ['acp', ...(settings.mode === 'bypassPermissions' ? ['--dangerously-skip-permissions'] : [])];
		return openAcp({
			spawnSpec: { bin, args, env: env() }, cwd, tag, log, settings, conversation,
			systemPrompt: preamble, prepareTurn, canUseTool, mcpServers,
			normalize: normalizeAgyTool, modelSlug: agySlug, errorText: agyErrorText,
		});
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
