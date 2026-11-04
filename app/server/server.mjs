// K70U agent app backend: serves the chat UI and drives official Claude Code via the Agent SDK.
// Supports multi-session history, apps/files/folders scope selection, screenshot capture, and rich model & effort controls.
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { request as httpsRequest } from 'node:https';
import { spawn, exec, execFile } from 'node:child_process';
import { readFile, writeFile, stat, lstat, mkdir, readdir, unlink, realpath, rm, rename, open, cp } from 'node:fs/promises';
import { readFileSync, existsSync, createReadStream, createWriteStream } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, normalize, extname, resolve, basename } from 'node:path';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', 'web');
const HOST = process.env.AGENT_HOST || '127.0.0.1';
const PORT = parseInt(process.env.AGENT_PORT || '8787', 10);
const CWD = process.env.AGENT_CWD || '/root';

// Never let an API key leak in — this app runs on the subscription login only.
delete process.env.ANTHROPIC_API_KEY;

// Login is done via `claude auth login` (see login_pty.py), which saves credentials into
// claude's own native store under this same $HOME — nothing to read or inject here. Do NOT set
// CLAUDE_CODE_OAUTH_TOKEN: that env var, if present, overrides the native store and would force
// use of a narrower-scoped token instead of whatever auth login actually negotiated.
const LEGACY_TOKEN_FILE = join(homedir(), '.claude', 'agent-oauth-token'); // from the old setup-token flow
unlink(LEGACY_TOKEN_FILE).catch(() => {}); // narrower-scoped and unused now; fine if it was never there


const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- settings & persistence
const SETTINGS_FILE = join(homedir(), '.claude', 'agent-settings.json');
const settings = {
	model: 'sonnet',          // opus | sonnet | haiku | fable | etc.
	modelName: 'Sonnet 5.5',  // Display name
	effort: 'xhigh',          // low | medium | high | xhigh | max
	fastMode: false,          // fast mode toggle
	mode: 'acceptEdits',      // Claude Code's permission modes: default | acceptEdits | plan | auto | bypassPermissions
	autoUpdate: true,         // install new releases by itself (off: only report them)
};
// The modes, as Claude Code names them. Older builds stored their own names.
const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
const MODE_MIGRATE = { ask: 'default', autoEdit: 'acceptEdits' };
// What the client may change through /api/settings. Screen automation, web access, personal
// data and showing thinking used to be switches; they are simply on now (the mode decides what
// needs a confirmation), and "read-only" is what Plan mode is for.
const SETTING_KEYS = ['model', 'modelName', 'effort', 'fastMode', 'mode', 'autoUpdate'];

// Config files for the Eta-parity features.
const SYSTEM_PROMPT_FILE = join(homedir(), '.claude', 'agent-system-prompt.md');
const SKILLS_DIR = join(homedir(), '.claude', 'skills');
const SKILLS_STATE_FILE = join(homedir(), '.claude', 'agent-skills.json');
const MCP_FILE = join(homedir(), '.claude', 'agent-mcp.json');

try {
	if (existsSync(SETTINGS_FILE)) {
		const saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
		for (const k of SETTING_KEYS) if (k in saved) settings[k] = saved[k];
		settings.mode = MODE_MIGRATE[settings.mode] || settings.mode;
		if (saved.readonly) settings.mode = 'plan'; // the old read-only switch
		if (!MODES.includes(settings.mode)) settings.mode = 'acceptEdits';
	}
} catch (e) {
	log('settings load failed', e?.message);
}

async function persistSettings() {
	try {
		await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
	} catch (e) {
		log('settings save failed', e?.message);
	}
}

// ---------------------------------------------------------------- session storage
const SESSIONS_DIR = join(homedir(), '.claude', 'agent-sessions');
const SESSIONS_INDEX = join(SESSIONS_DIR, 'index.json');

// Multi-session: every open conversation gets its own independent Claude Code process/runtime.
// `sessionCache` is the authoritative in-memory copy of each conversation's persisted data
// (messages, claudeSessionId); `activeSessionId` only tracks which one the (single) phone screen
// is currently looking at — it never gates whether another conversation's runtime keeps running.
const sessionCache = new Map(); // id -> session object
let activeSessionId = null;

async function getOrLoadSessionObj(id) {
	if (sessionCache.has(id)) return sessionCache.get(id);
	const loaded = await loadSession(id);
	if (loaded) sessionCache.set(id, loaded);
	return loaded;
}

async function ensureSessionsDir() {
	await mkdir(SESSIONS_DIR, { recursive: true });
}

// A truncated write (reboot mid-save) used to leave unparseable JSON behind, so write to a
// sibling temp file and rename — rename is atomic within a filesystem, so a reader sees either
// the old file or the new one, never a half-written one.
// This phone has come back from reboots with recently-written files full of NULs — the size
// was recorded but the blocks were never flushed. rename() alone only guarantees that readers
// see one version or the other, so the data is forced to disk before the rename.
async function writeJsonAtomic(path, value) {
	const tmp = `${path}.tmp`;
	const fh = await open(tmp, 'w');
	try {
		await fh.writeFile(JSON.stringify(value, null, 2), 'utf8');
		await fh.sync();
	} finally {
		await fh.close();
	}
	await rename(tmp, path);
}

function sessionMeta(sess) {
	const lastMsg = sess.messages?.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-1)[0];
	return {
		id: sess.id,
		title: sess.title || '新对话',
		pinned: !!sess.pinned,
		createdAt: sess.createdAt,
		updatedAt: sess.updatedAt,
		claudeSessionId: sess.claudeSessionId || null,
		msgCount: sess.messages?.length || 0,
		preview: lastMsg?.text ? lastMsg.text.replace(/\n+/g, ' ').slice(0, 60) : '',
	};
}

async function sessionFileIds() {
	try {
		const files = await readdir(SESSIONS_DIR);
		return files.filter((f) => f.endsWith('.json') && f !== 'index.json').map((f) => f.slice(0, -5));
	} catch {
		return [];
	}
}

// The conversation files on disk are the source of truth; index.json is only a cache of them.
async function rebuildSessionsIndex() {
	const metas = [];
	for (const id of await sessionFileIds()) {
		const sess = await loadSession(id);
		if (sess && sess.id) metas.push(sessionMeta(sess));
	}
	metas.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
	if (metas.length) {
		log(`rebuilt session index from disk (${metas.length} conversations)`);
		await writeJsonAtomic(SESSIONS_INDEX, metas).catch(() => {});
	}
	return metas;
}

async function loadSessionsIndex() {
	await ensureSessionsDir();
	let list = null;
	try {
		list = JSON.parse(await readFile(SESSIONS_INDEX, 'utf8'));
	} catch { /* missing or corrupt — fall through to the rebuild below */ }
	if (!Array.isArray(list)) return rebuildSessionsIndex();
	// A conversation present on disk but missing from the index means the index lost entries
	// (the old failure mode); recover them instead of quietly dropping the history.
	const onDisk = await sessionFileIds();
	if (onDisk.some((id) => !list.some((m) => m && m.id === id))) return rebuildSessionsIndex();
	return list;
}

async function saveSessionsIndex(idx) {
	await ensureSessionsDir();
	await writeJsonAtomic(SESSIONS_INDEX, idx);
}

async function loadSession(id) {
	try {
		const p = join(SESSIONS_DIR, `${id}.json`);
		const data = await readFile(p, 'utf8');
		return JSON.parse(data);
	} catch {
		return null;
	}
}

async function saveSession(sess) {
	if (!sess || !sess.id) return;
	await ensureSessionsDir();
	sess.updatedAt = Date.now();
	await writeJsonAtomic(join(SESSIONS_DIR, `${sess.id}.json`), sess);

	const idx = await loadSessionsIndex();
	const existing = idx.findIndex((s) => s.id === sess.id);
	const meta = sessionMeta(sess);
	if (existing >= 0) {
		idx[existing] = meta;
	} else {
		idx.unshift(meta);
	}
	await saveSessionsIndex(idx);
}

async function createNewSession(title = '新对话') {
	const now = Date.now();
	const sess = {
		id: randomUUID(),
		title,
		pinned: false,
		createdAt: now,
		updatedAt: now,
		claudeSessionId: null,
		messages: [],
	};
	await saveSession(sess);
	sessionCache.set(sess.id, sess);
	return sess;
}

async function initSessions() {
	await ensureSessionsDir();
	const idx = await loadSessionsIndex();
	if (idx.length > 0) {
		const sorted = [...idx].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
		const sess = await getOrLoadSessionObj(sorted[0].id);
		if (sess) {
			activeSessionId = sess.id;
			return;
		}
	}
	const sess = await createNewSession('新对话');
	activeSessionId = sess.id;
}

// ---------------------------------------------------------------- SSE bus
const clients = new Set();
function broadcast(obj) {
	const line = `data: ${JSON.stringify(obj)}\n\n`;
	for (const res of clients) { try { res.write(line); } catch { /* client gone */ } }
}

// ---------------------------------------------------------------- permission policy
const DANGER = /(^|[\s;|&])(rm\s+-\w*[rf]|rmdir|shred|mkfs\b|dd\b|:\(\)\s*\{|chown\s+-\w*R|chmod\s+-\w*R|mount\b|umount\b|setprop\b|resetprop\b|svc\s|ksud\b|magisk\b|kpatch\b|truncate\b)/i;
const DANGER_ANDROID = /\b(pm\s+(uninstall|clear|disable(-user)?)|cmd\s+package\s+(uninstall|clear)|settings\s+put\s+(global|secure)|content\s+(delete|insert|update)|am\s+(force-stop|kill|kill-all)|cmd\s+activity\s+(force-stop|kill|kill-all)|pkill|killall)\b|(^|[\s;|&])kill\s/i;
const CATASTROPHIC = /\b(reboot|poweroff|fastboot|recovery|flash\b|wipe\b)\b|\bdd\b[^\n]*\bof=\/dev\/block|\/dev\/block\/(sd|dm|mmcblk)|\b(lk|vbmeta|seccfg|tee|userdata|boot|init_boot)_?[ab]?\b/i;
const PIPE_TO_SHELL = /\b(curl|wget)\b[^\n]*\|\s*(sh|bash)\b/i;
const SENSITIVE_PATH = /^\/(system|vendor|product|apex|proc|sys|dev)(\/|$)|\/data\/adb(\/|$)|\/dev\/block\//;
const READ_ONLY_BASH = /^(\s*(ls|cat|head|tail|less|grep|rg|fd|find|stat|file|wc|echo|pwd|df|du|free|ps|top|htop|id|whoami|uname|date|getprop|dumpsys|logcat|pm\s+(list|path|dump)|cmd\s+\w+\s+(list|get|dump)|settings\s+get|input\s+keyevent\s+KEYCODE_(POWER|WAKEUP)|droid\s+(ui|shot|top|apps)|screencap|uiautomator\s+dump|sqlite3\s+\S+\s+["']?select|tree|which|env|node\s+-|python3?\s+-c)\b)/i;
const SCREEN_ACTION = /\bdroid\s+(tap|tap-id|tap-text|swipe|longpress|text|key|app|wake)\b|\binput\s+(tap|swipe|text|keyevent|draganddrop)\b/i;
// Reads of personal data (contacts/SMS/call log/calendar/media/notifications) go through the `pdata` helper.
const PERSONAL_DATA = /(^|[\s;|&])pdata(\s|$)/i;
// Starting a resident root service / a proxy that intercepts traffic always asks.
const START_SERVICE = /(^|[\s;|&])(frida-server\s+start|mitmproxy|mitmweb|mitmdump)\b/i;

function readPath(input) {
	return input?.file_path || input?.path || input?.notebook_path || '';
}

// Tool cards are the main thing you watch during a run, so titles are always written here in
// Chinese from the arguments — never from the model's own `description`, which comes back in English.
const TOOL_CN = {
	Bash: '运行命令', BashOutput: '查看命令输出', KillShell: '结束命令',
	Read: '读取文件', Write: '写入文件', Edit: '修改文件', MultiEdit: '批量修改',
	NotebookRead: '读取笔记本', NotebookEdit: '编辑笔记本',
	Glob: '查找文件', Grep: '搜索内容', LS: '列出目录',
	WebSearch: '联网搜索', WebFetch: '抓取网页',
	Task: '子任务', TodoWrite: '更新待办', ExitPlanMode: '结束计划',
	AskUserQuestion: '向你提问',
};

/** A short, human label for what a Bash command actually does. */
function bashTitle(cmd) {
	const c = String(cmd || '').trim();
	if (!c) return '运行命令';
	if (/^droid\s+(shot|screencap)/.test(c)) return '截取手机屏幕';
	if (/^droid\s+ui/.test(c)) return '读取屏幕控件';
	if (/^droid\s+tap/.test(c)) return '点击屏幕';
	if (/^droid\s+(swipe|scroll)/.test(c)) return '滑动屏幕';
	if (/^droid\s+(text|key)/.test(c)) return '输入文字';
	if (/^droid\s+app/.test(c)) return '打开应用';
	if (/^pdata\b/.test(c)) return '读取个人数据';
	if (/^clip\b/.test(c)) return '读写剪贴板';
	if (/^ashell\b/.test(c)) return '执行安卓命令';
	return `运行 ${firstWords(c, 6)}`;
}

function toolTitle(name, input) {
	if (name === 'Bash') return bashTitle(input?.command);
	if (/^(Write|Edit|MultiEdit)$/.test(name)) return `${name === 'Write' ? '写入' : '修改'} ${base(readPath(input))}`;
	if (name === 'Read') return `读取 ${base(readPath(input))}`;
	if (name === 'Glob') return `查找 ${input?.pattern || '文件'}`;
	if (name === 'Grep') return `搜索 ${input?.pattern || ''}`;
	if (name === 'WebSearch') return `搜索 ${input?.query || ''}`;
	if (name === 'WebFetch') return `抓取 ${input?.url || ''}`;
	if (name === 'TodoWrite') return '更新待办清单';
	if (name === 'Task') return `子任务${input?.subagent_type ? ` · ${input.subagent_type}` : ''}`;
	if (String(name).startsWith('mcp__')) return `MCP · ${String(name).split('__').slice(1).join(' · ')}`;
	return TOOL_CN[name] || name;
}
function toolDetail(name, input) {
	if (name === 'Bash') return input?.command || '';
	if (/^(Write|Edit|MultiEdit|Read|NotebookEdit)$/.test(name)) return readPath(input);
	try { return JSON.stringify(input); } catch { return ''; }
}
const base = (p) => (p ? String(p).split('/').pop() : '');
const firstWords = (s, n) => (s ? String(s).split(/\s+/).slice(0, n).join(' ') : '');

const allow = (title, detail) => ({ decision: 'allow', title, detail });
const deny = (reason, title, detail) => ({ decision: 'deny', reason, title, detail });
const ask = (reason, title, detail) => ({ decision: 'ask', reason, title, detail });

function policy(toolName, input) {
	const name = toolName || '';
	const isWrite = /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name);
	const isRead = /^(Read|Glob|Grep|LS|NotebookRead|TodoWrite|Task|WebSearch|WebFetch)$/.test(name);
	const cmd = name === 'Bash' ? String(input?.command || '') : '';
	const target = readPath(input);
	const mode = settings.mode;

	const title = toolTitle(name, input);
	const detail = toolDetail(name, input);

	// Full access: nothing is asked, by the owner's explicit choice of that mode.
	if (mode === 'bypassPermissions') return allow(title, detail);

	// Leaving Plan mode means "go ahead with this plan" — always the owner's call.
	if (name === 'ExitPlanMode') return ask('计划已就绪', '按这个计划开始执行？', String(input?.plan || ''));

	const personal = name === 'Bash' && PERSONAL_DATA.test(cmd);
	const readOnlyCmd = name === 'Bash' && READ_ONLY_BASH.test(cmd) && !DANGER.test(cmd) && !DANGER_ANDROID.test(cmd) && !CATASTROPHIC.test(cmd);
	const catastrophic = name === 'Bash' && (CATASTROPHIC.test(cmd) || PIPE_TO_SHELL.test(cmd));
	const dangerous =
		(name === 'Bash' && (DANGER.test(cmd) || DANGER_ANDROID.test(cmd))) ||
		(isWrite && SENSITIVE_PATH.test(normalize(target || '/')));

	// Plan: look, don't touch.
	if (mode === 'plan') return isRead || readOnlyCmd ? allow(title, detail) : ask('Plan 模式', title, detail);
	// Bricking-class operations always ask, in every mode below Full access.
	if (catastrophic) return ask('高危操作', title, detail);
	if (mode === 'auto') return allow(title, detail);
	// Personal data (contacts, SMS, call log, photos …) and resident services ask per use.
	if (personal) return ask('个人数据', title, detail);
	if (name === 'Bash' && START_SERVICE.test(cmd)) return ask('启动服务', title, detail);
	if (mode === 'acceptEdits') return dangerous ? ask('需要确认', title, detail) : allow(title, detail);
	// default (Ask): anything with side effects asks.
	return isRead || readOnlyCmd ? allow(title, detail) : ask('需要确认', title, detail);
}

// ---------------------------------------------------------------- session & Claude SDK
// One live Claude Code `query()` per open conversation — NOT a single global. Viewing a
// different conversation, or changing app-wide settings/skills/MCP, must never tear this down;
// only explicitly deleting/clearing that conversation (or the idle reaper below) does.
const runtimes = new Map(); // id -> { pushUser, end, q, pending:Map, running, assistantText, lastActive }

function teardownRuntime(id) {
	const rt = runtimes.get(id);
	if (!rt) return;
	try { rt.end(); } catch { /* already done */ }
	try { rt.q?.interrupt?.(); } catch { /* ignore */ }
	for (const [, p] of rt.pending) p.resolve({ behavior: 'deny', message: '会话已重置', interrupt: false });
	runtimes.delete(id);
}

// Free the underlying `claude` process for conversations nobody has touched in a while — their
// history and `claudeSessionId` stay on disk, so the next message just resumes it transparently.
// Not a hard cap: a 16GB phone can hold many of these; this is a safety net against unbounded growth.
const IDLE_REAP_MS = 20 * 60 * 1000;
setInterval(() => {
	const now = Date.now();
	for (const [id, rt] of runtimes) {
		if (!rt.running && rt.pending.size === 0 && now - rt.lastActive > IDLE_REAP_MS) {
			log('idle-reap', id);
			teardownRuntime(id);
		}
	}
}, 5 * 60 * 1000);

function getSdkModel(m) {
	if (!m) return 'sonnet';
	const lower = String(m).toLowerCase();
	if (lower.startsWith('opus')) return 'opus';
	if (lower.startsWith('sonnet')) return 'sonnet';
	if (lower.startsWith('haiku')) return 'haiku';
	if (lower.startsWith('fable')) return 'fable';
	return lower;
}

// ---- Eta-parity config loaders (system prompt / skills / MCP) ----
function loadSystemPromptAppend() {
	try {
		const t = readFileSync(SYSTEM_PROMPT_FILE, 'utf8').trim();
		return t || '';
	} catch { return ''; }
}

async function readSkillsState() {
	try { return JSON.parse(await readFile(SKILLS_STATE_FILE, 'utf8')); } catch { return { enabled: [] }; }
}

// List installed skills (dirs under SKILLS_DIR with a SKILL.md), with name/description from frontmatter.
async function listSkills() {
	const state = await readSkillsState();
	let dirs = [];
	try { dirs = (await readdir(SKILLS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* none */ }
	const out = [];
	for (const id of dirs) {
		let name = id, description = '';
		try {
			const md = await readFile(join(SKILLS_DIR, id, 'SKILL.md'), 'utf8');
			const fm = md.match(/^---\n([\s\S]*?)\n---/);
			if (fm) {
				const nm = fm[1].match(/^name:\s*(.+)$/m); if (nm) name = nm[1].trim().replace(/^["']|["']$/g, '');
				const ds = fm[1].match(/^description:\s*(.+)$/m); if (ds) description = ds[1].trim().replace(/^["']|["']$/g, '');
			}
		} catch { /* no SKILL.md */ }
		const builtin = existsSync(join(SKILLS_DIR, id, '.builtin'));
		out.push({ id, name, description, enabled: state.enabled.includes(id), builtin });
	}
	return out;
}

async function enabledSkillIds() {
	const state = await readSkillsState();
	const all = await listSkills();
	return all.filter((s) => state.enabled.includes(s.id)).map((s) => s.id);
}

async function loadMcpServers() {
	try {
		const cfg = JSON.parse(await readFile(MCP_FILE, 'utf8'));
		const servers = {};
		for (const [name, s] of Object.entries(cfg.servers || {})) {
			if (s.disabled) continue;
			servers[name] = toMcpConfig(s);
		}
		return servers;
	} catch { return {}; }
}

function toMcpConfig(s) {
	if (s.type === 'http') { const c = { type: 'http', url: s.url }; if (s.bearer) c.headers = { Authorization: `Bearer ${s.bearer}` }; return c; }
	if (s.type === 'sse') { const c = { type: 'sse', url: s.url }; if (s.bearer) c.headers = { Authorization: `Bearer ${s.bearer}` }; return c; }
	return { type: 'stdio', command: s.command, args: s.args || [], env: s.env || {} };
}

async function readMcpFile() { try { return JSON.parse(await readFile(MCP_FILE, 'utf8')); } catch { return { servers: {} }; } }
async function writeMcpFile(cfg) { await mkdir(dirname(MCP_FILE), { recursive: true }); await writeFile(MCP_FILE, JSON.stringify(cfg, null, 2), 'utf8'); }
async function writeSkillsState(state) { await mkdir(dirname(SKILLS_STATE_FILE), { recursive: true }); await writeFile(SKILLS_STATE_FILE, JSON.stringify(state, null, 2), 'utf8'); }

// Push the current enabled MCP set to every open conversation (hot reload); harmless if none are live.
async function applyMcpToAllRuntimes() {
	const servers = await loadMcpServers();
	for (const rt of runtimes.values()) {
		if (!rt.q?.setMcpServers) continue;
		try { await rt.q.setMcpServers(servers); } catch (e) { log('setMcpServers failed', e?.message); }
	}
}

// An existing runtime to borrow for account-level queries (MCP status, usage) that aren't tied
// to one specific conversation — prefer whichever one the screen is currently showing.
function anyRuntime() {
	return (activeSessionId && runtimes.get(activeSessionId)) || runtimes.values().next().value || null;
}

let usageCache = { t: 0, data: null };

async function ensureRuntime(id) {
	let rt = runtimes.get(id);
	if (rt) return rt;
	const sess = await getOrLoadSessionObj(id);
	if (!sess) throw new Error('session not found: ' + id);
	const runtime = await claudeRuntime();
	if (!runtime.chat) throw new Error(noRuntimeMessage(runtime));
	const chatSpec = runtime.chat;
	const { query } = await loadSdkFor(chatSpec);

	const queue = [];
	let wake = null;
	let ended = false;
	async function* input() {
		while (!ended) {
			if (queue.length) { yield queue.shift(); continue; }
			await new Promise((r) => { wake = r; });
		}
	}
	const pushUser = (text) => {
		queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
		if (wake) { wake(); wake = null; }
	};
	const end = () => { ended = true; if (wake) { wake(); wake = null; } };

	const pending = new Map();
	const canUseTool = async (toolName, toolInput) => {
		const p = policy(toolName, toolInput);
		if (p.decision === 'allow') {
			broadcast({ type: 'tool_note', sessionId: id, name: toolName, title: p.title, auto: true });
			return { behavior: 'allow', updatedInput: toolInput };
		}
		if (p.decision === 'deny') {
			broadcast({ type: 'tool_denied', sessionId: id, name: toolName, title: p.title, reason: p.reason });
			return { behavior: 'deny', message: p.reason + '（用户的设置不允许）', interrupt: false };
		}
		const permId = randomUUID();
		broadcast({ type: 'permission', sessionId: id, id: permId, name: toolName, title: p.title, detail: p.detail, reason: p.reason });
		sess.messages.push({ role: 'perm', id: permId, name: toolName, title: p.title, detail: p.detail, reason: p.reason, verdict: null, time: Date.now() });
		saveSession(sess);
		return await new Promise((resolve) => {
			pending.set(permId, {
				resolve: (r) => { pending.delete(permId); resolve(r); },
				input: toolInput,
				toolName,
			});
		});
	};

	const append = loadSystemPromptAppend();
	const skillIds = await enabledSkillIds();
	const mcpServers = await loadMcpServers();
	const queryOpts = {
		cwd: CWD,
		model: modelFor(chatSpec, settings.model),
		effort: settings.effort || 'xhigh',
		fastMode: !!settings.fastMode,
		permissionMode: settings.mode === 'plan' ? 'plan' : 'default',
		includePartialMessages: true,
		settingSources: ['user', 'project', 'local'],
		systemPrompt: append ? { type: 'preset', preset: 'claude_code', append } : { type: 'preset', preset: 'claude_code' },
		canUseTool,
		stderr: (d) => log('[claude]', `[${id.slice(0, 8)}]`, String(d).trim().slice(0, 300)),
	};
	if (skillIds.length) queryOpts.skills = skillIds;
	if (Object.keys(mcpServers).length) queryOpts.mcpServers = mcpServers;
	if (sess.claudeSessionId) queryOpts.resume = sess.claudeSessionId;
	Object.assign(queryOpts, queryRuntimeOptions(chatSpec));

	const q = query({
		prompt: input(),
		options: queryOpts,
	});

	rt = { pushUser, end, q, pending, running: false, assistantText: '', lastActive: Date.now(), chatSpec };
	runtimes.set(id, rt);
	consume(id, q, rt).catch((e) => {
		log('session error', id, e?.message || e);
		broadcast({ type: 'error', sessionId: id, message: String(e?.message || e) });
		teardownRuntime(id);
	});
	return rt;
}

async function consume(id, q, rt) {
	let sawDelta = false;
	for await (const m of q) {
		rt.lastActive = Date.now();
		const sess = sessionCache.get(id);
		if (m.type === 'system' && m.subtype === 'init') {
			if (sess && m.session_id) {
				sess.claudeSessionId = m.session_id;
				saveSession(sess);
			}
			broadcast({ type: 'session', sessionId: id, claudeSessionId: m.session_id, model: m.model });
		} else if (m.type === 'stream_event') {
			const ev = m.event;
			if (ev?.type === 'content_block_delta') {
				if (ev.delta?.type === 'text_delta' && ev.delta.text) {
					sawDelta = true;
					rt.assistantText += ev.delta.text;
					rt.label = '正在回复';
					broadcast({ type: 'assistant_delta', sessionId: id, text: ev.delta.text });
				} else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
					rt.label = '思考中';
					broadcast({ type: 'thinking_delta', sessionId: id, text: ev.delta.thinking });
				}
			} else if (ev?.type === 'message_stop') {
				if (rt.assistantText && sess) {
					sess.messages.push({ role: 'assistant', text: rt.assistantText, time: Date.now() });
					rt.assistantText = '';
					saveSession(sess);
				}
				broadcast({ type: 'assistant_end', sessionId: id });
			}
		} else if (m.type === 'assistant') {
			for (const block of m.message?.content || []) {
				if (block.type === 'tool_use') {
					const title = toolTitle(block.name, block.input);
					const detail = toolDetail(block.name, block.input);
					// TodoWrite gets a live checklist render in the UI instead of a generic tool card.
					const isTodo = block.name === 'TodoWrite';
					const todos = isTodo ? (block.input?.todos || []) : undefined;
					if (sess) {
						sess.messages.push({ role: 'tool', id: block.id, name: block.name, title, detail, state: 'running', time: Date.now(), ...(isTodo ? { kind: 'todo', todos } : {}) });
						saveSession(sess);
					}
					rt.label = title;
					broadcast({ type: 'tool_use', sessionId: id, id: block.id, name: block.name, title, detail, ...(isTodo ? { kind: 'todo', todos } : {}) });
				} else if (block.type === 'text' && !sawDelta && block.text) {
					if (sess) {
						sess.messages.push({ role: 'assistant', text: block.text, time: Date.now() });
						saveSession(sess);
					}
					broadcast({ type: 'assistant_text', sessionId: id, text: block.text });
				}
			}
			sawDelta = false;
		} else if (m.type === 'user') {
			for (const block of m.message?.content || []) {
				if (block.type === 'tool_result') {
					const txt = Array.isArray(block.content) ? block.content.map((c) => c.text || '').join('') : String(block.content ?? '');
					if (sess) {
						const tm = sess.messages.find((x) => x.role === 'tool' && x.id === block.tool_use_id);
						if (tm) {
							tm.state = block.is_error ? 'err' : 'ok';
							tm.ok = !block.is_error;
							tm.summary = txt.slice(0, 4000);
							saveSession(sess);
						}
					}
					broadcast({ type: 'tool_result', sessionId: id, id: block.tool_use_id, ok: !block.is_error, summary: txt.slice(0, 4000) });
				}
			}
		} else if (m.type === 'result') {
			rt.running = false;
			rt.label = '';
			if (rt.assistantText && sess) {
				sess.messages.push({ role: 'assistant', text: rt.assistantText, time: Date.now() });
				rt.assistantText = '';
				saveSession(sess);
			}
			broadcast({ type: 'result', sessionId: id, ok: !m.is_error, text: m.result || '', costUsd: m.total_cost_usd || 0, durationMs: m.duration_ms || 0, subtype: m.subtype });
		}
	}
}

// ---------------------------------------------------------------- apps & filesystem helpers
// Fallback for the "/" command autocomplete before any conversation's runtime exists yet to ask
// supportedCommands() — a conversation that has sent a message gets the real, live-queried list.
const STATIC_SLASH_COMMANDS = [
	{ name: 'clear', description: '开始一个新对话', argumentHint: '' },
	{ name: 'compact', description: '压缩当前对话，释放上下文空间', argumentHint: '' },
	{ name: 'model', description: '切换模型', argumentHint: '' },
	{ name: 'usage', description: '查看用量和额度', argumentHint: '', aliases: ['cost', 'stats'] },
	{ name: 'help', description: '查看帮助', argumentHint: '' },
];

const KNOWN_APPS = {
	'com.tencent.mm': '微信',
	'com.tencent.mobileqq': 'QQ',
	'com.eg.android.AlipayGphone': '支付宝',
	'com.taobao.taobao': '淘宝',
	'com.jingdong.app.mall': '京东',
	'com.sdu.didi.psnger': '滴滴出行',
	'me.ele': '饿了么',
	'com.sankuai.meituan': '美团',
	'com.ss.android.ugc.aweme': '抖音',
	'com.bilibili.app.in': '哔哩哔哩',
	'com.xingin.xhs': '小红书',
	'com.sina.weibo': '微博',
	'com.zhihu.android': '知乎',
	'com.autonavi.minimap': '高德地图',
	'com.baidu.BaiduMap': '百度地图',
	'com.netease.cloudmusic': '网易云音乐',
	'com.tencent.qqmusic': 'QQ音乐',
	'com.moonshot.kimichat': 'Kimi 智能助手',
	'ai.perplexity.app.android': 'Perplexity AI',
	'ai.x.grok': 'Grok',
	'com.reddit.frontpage': 'Reddit',
	'com.github.android': 'GitHub',
	'com.termux': 'Termux',
	'com.android.chrome': 'Chrome 浏览器',
	'com.miui.calculator': '计算器',
	'com.miui.notes': '小米便签',
	'com.miui.gallery': '相册',
	'com.android.settings': '系统设置',
	'com.android.deskclock': '时钟',
	'com.android.camera': '相机',
	'com.android.fileexplorer': '文件管理',
	'com.droidagent.app': 'DroidAgent',
};

let cachedApps = null;
let cachedAppsTime = 0;

function getInstalledApps() {
	return new Promise((resolve) => {
		const now = Date.now();
		if (cachedApps && now - cachedAppsTime < 60000) return resolve(cachedApps);
		exec('ashell pm list packages -3', { timeout: 4000 }, (err, stdout) => {
			let lines = [];
			if (!err && stdout) {
				lines = stdout.split('\n').map((l) => l.trim().replace(/^package:/, '')).filter(Boolean);
			}
			if (lines.length === 0) {
				lines = Object.keys(KNOWN_APPS);
			}
			const apps = lines.map((pkg) => {
				const friendly = KNOWN_APPS[pkg] || pkg.split('.').pop();
				return { package: pkg, name: friendly };
			});
			// Sort known/common apps first
			apps.sort((a, b) => {
				const aKnown = KNOWN_APPS[a.package] ? 1 : 0;
				const bKnown = KNOWN_APPS[b.package] ? 1 : 0;
				if (aKnown !== bKnown) return bKnown - aKnown;
				return a.name.localeCompare(b.name, 'zh-CN');
			});
			cachedApps = apps;
			cachedAppsTime = now;
			resolve(apps);
		});
	});
}

// ---------------------------------------------------------------- filesystem item helpers
function humanSize(n) {
	if (n == null) return '';
	const u = ['B', 'KB', 'MB', 'GB', 'TB'];
	let i = 0, v = n;
	while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
	return (i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)) + ' ' + u[i];
}
const KIND_MAP = [
	[/\.(jpg|jpeg|png|webp|gif|bmp|heic|heif)$/i, '图片'],
	[/\.(mp4|mkv|mov|avi|webm|3gp)$/i, '视频'],
	[/\.(mp3|flac|wav|m4a|ogg|aac)$/i, '音频'],
	[/\.(apk|apks|xapk)$/i, 'APK'],
	[/\.(zip|tar|gz|xz|7z|rar|bz2|zst)$/i, '压缩包'],
	[/\.(pdf)$/i, 'PDF'],
	[/\.(txt|md|log|json|xml|csv|ini|conf|yaml|yml)$/i, '文本'],
	[/\.(sh|py|js|ts|c|cpp|java|kt|rs|go|smali|html|css)$/i, '代码'],
	[/\.(db|sqlite|sqlite3)$/i, '数据库'],
	[/\.(dex|so|jar|odex|vdex)$/i, '二进制'],
];
function kindOf(name, isDir) {
	if (isDir) return '文件夹';
	for (const [re, label] of KIND_MAP) if (re.test(name)) return label;
	return '文件';
}
async function fsItem(full, name) {
	let isDir = false, size = null;
	try {
		const ls = await lstat(full);
		if (ls.isSymbolicLink()) {
			try { const t = await stat(full); isDir = t.isDirectory(); size = isDir ? null : t.size; }
			catch { isDir = false; }
		} else { isDir = ls.isDirectory(); size = isDir ? null : ls.size; }
	} catch { /* unreadable; leave defaults */ }
	return { name, path: full, isDir, ext: extname(name).toLowerCase(), size, sizeText: isDir ? '' : humanSize(size), kind: kindOf(name, isDir) };
}
// Recursive name search under a directory, capped and time-limited via `find`.
function fsSearch(dir, q) {
	return new Promise((resolve) => {
		// -L: /sdcard (and other preset paths) are symlinks, and plain `find` never descends into
		// a symlinked start path — without -L this silently returns zero results for them.
		execFile('find', ['-L', dir, '-maxdepth', '4', '-iname', `*${q.replace(/[*?[]/g, '')}*`], { timeout: 6000, maxBuffer: 4e6 }, async (_err, stdout) => {
			const lines = String(stdout || '').split('\n').map((l) => l.trim()).filter((l) => l && l !== dir).slice(0, 300);
			const out = [];
			for (const full of lines) out.push(await fsItem(full, full.split('/').pop()));
			resolve(out);
		});
	});
}

// ---------------------------------------------------------------- skill install
function run(cmd, args, opts = {}) {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { timeout: 120000, maxBuffer: 1e7, ...opts }, (err, stdout, stderr) => {
			if (err) reject(new Error((stderr || err.message || '').toString().slice(0, 300)));
			else resolve(String(stdout || ''));
		});
	});
}
const sanitizeId = (s) => s.replace(/[^\w.-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'skill';

// Install one or more skills from a GitHub repo, a local directory, or a local .zip.
// A skill is any directory that contains a SKILL.md; the repo may hold one at its root or several in subdirs.
async function installSkill(src) {
	const tmp = join(homedir(), '.claude', `.skill-tmp-${randomUUID()}`);
	await mkdir(tmp, { recursive: true });
	try {
		if (src.startsWith('/')) {
			if (src.toLowerCase().endsWith('.zip')) await run('unzip', ['-q', '-o', src, '-d', tmp]);
			else await run('cp', ['-a', src + '/.', tmp]);
		} else {
			await run('git', ['clone', '--depth', '1', src, tmp]);
			await rm(join(tmp, '.git'), { recursive: true, force: true });
		}
		// Gather skill directories.
		const roots = [];
		if (existsSync(join(tmp, 'SKILL.md'))) {
			roots.push({ dir: tmp, id: sanitizeId(src.replace(/\.git$/, '').split('/').pop()) });
		} else {
			for (const d of await readdir(tmp, { withFileTypes: true })) {
				if (d.isDirectory() && existsSync(join(tmp, d.name, 'SKILL.md'))) roots.push({ dir: join(tmp, d.name), id: sanitizeId(d.name) });
			}
		}
		if (roots.length === 0) throw new Error('没找到 SKILL.md（不是有效的 skill 仓库）');
		for (const r of roots) {
			const dest = join(SKILLS_DIR, r.id);
			await rm(dest, { recursive: true, force: true });
			await run('cp', ['-a', r.dir, dest]);
		}
		// Newly installed skills start enabled.
		const state = await readSkillsState();
		for (const r of roots) if (!state.enabled.includes(r.id)) state.enabled.push(r.id);
		await writeSkillsState(state);
	} finally {
		await rm(tmp, { recursive: true, force: true }).catch(() => {});
	}
}

// ---------------------------------------------------------------- network proxy
// The chroot shares Android's network, so where Anthropic is unreachable directly, login (token
// exchange) and every chat turn need a proxy — typically a proxy app's local port such as
// http://127.0.0.1:7890. It lives in /etc/agent/proxy.env (also read by login shells), and is
// applied to this process's env so every claude it spawns from now on inherits it.
const PROXY_FILE = process.env.AGENT_PROXY_FILE || '/etc/agent/proxy.env';
const PROXY_VARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'];
const NO_PROXY = 'localhost,127.0.0.1,::1,mirrors.tuna.tsinghua.edu.cn';
function readProxySetting() {
	try {
		const m = readFileSync(PROXY_FILE, 'utf8').match(/^\s*PROXY=["']?([^"'\s#]*)/m);
		return m ? m[1] : '';
	} catch { return ''; }
}
function applyProxy(url) {
	if (url) {
		for (const k of PROXY_VARS) process.env[k] = url;
		process.env.NO_PROXY = process.env.no_proxy = NO_PROXY;
	} else {
		for (const k of [...PROXY_VARS, 'NO_PROXY', 'no_proxy']) delete process.env[k];
	}
}
function validProxy(url) {
	return url === '' || /^https?:\/\/[A-Za-z0-9.\-\[\]:]+(:\d{1,5})?\/?$/.test(url);
}
async function saveProxySetting(url) {
	let text = '';
	try { text = readFileSync(PROXY_FILE, 'utf8'); } catch { /* first time */ }
	const line = url ? `PROXY=${url}` : '#PROXY=http://127.0.0.1:7890';
	if (/^\s*#?\s*PROXY=.*$/m.test(text)) text = text.replace(/^\s*#?\s*PROXY=.*$/m, line);
	else text = (text ? text.replace(/\n?$/, '\n') : '') + line + '\n';
	await mkdir(dirname(PROXY_FILE), { recursive: true });
	await writeFile(PROXY_FILE, text, 'utf8');
	applyProxy(url);
}
applyProxy(readProxySetting());

// ---------------------------------------------------------------- reaching Anthropic
// Login (token exchange, then account lookups) and every chat turn need platform.claude.com and
// api.anthropic.com. On a phone the VPN often doesn't carry traffic from root processes in the
// chroot (per-app VPN modes leave them out), so the browser can open the sign-in page while
// `claude` itself hangs. So check first, and when the current route fails, look for the proxy
// app's local port (they almost all expose one next to their VPN) and use it.
const ANTHROPIC_HOSTS = ['platform.claude.com', 'api.anthropic.com'];
// Clash / Clash Meta / mihomo (7890, 7897 Verge, 7891), NekoBox / sing-box (2080), v2rayNG HTTP
// (10809), and a few generic ones.
const LOCAL_PROXY_PORTS = [7890, 7897, 7891, 7893, 2080, 10809, 1080, 8080, 8888, 20171];

// One HTTPS request (HEAD /), directly or through an HTTP proxy via CONNECT, without any
// dependency on curl or on how a library reads proxy variables. Resolves { ok, status } or { ok:false, error }.
function httpsHead(host, proxy, timeout = 7000) {
	return new Promise((resolve) => {
		let settled = false;
		const sockets = [];
		const finish = (r) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			for (const sk of sockets) { try { sk.destroy(); } catch { /* */ } }
			resolve(r);
		};
		const timer = setTimeout(() => finish({ ok: false, error: '超时' }), timeout);
		const fail = (e) => finish({ ok: false, error: e?.code || e?.message || String(e) });
		const overTls = (opts) => {
			const t = tlsConnect({ servername: host, ...opts }, () => {
				t.write(`HEAD / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: DroidAgent-netcheck\r\nConnection: close\r\n\r\n`);
			});
			sockets.push(t);
			let head = '';
			t.on('data', (d) => {
				head += d.toString('latin1');
				const m = head.match(/^HTTP\/1\.[01] (\d{3})/);
				if (m) finish({ ok: true, status: Number(m[1]) });
			});
			t.on('error', fail);
			t.on('end', () => finish({ ok: false, error: '连接被关闭' }));
		};
		if (!proxy) return overTls({ host, port: 443 });
		let u;
		try { u = new URL(proxy); } catch { return finish({ ok: false, error: '代理地址无效' }); }
		const req = httpRequest({ host: u.hostname, port: Number(u.port) || 80, method: 'CONNECT', path: `${host}:443`, headers: { host: `${host}:443` } });
		req.on('connect', (res, socket) => {
			sockets.push(socket);
			if (res.statusCode !== 200) return finish({ ok: false, error: `代理拒绝（${res.statusCode}）` });
			overTls({ socket });
		});
		req.on('error', fail);
		req.end();
	});
}
// Reachable means an HTTP answer that isn't Anthropic's region block (403).
async function checkAnthropic(proxy) {
	const results = await Promise.all(ANTHROPIC_HOSTS.map((h) => httpsHead(h, proxy)));
	const bad = results.map((r, i) => ({ host: ANTHROPIC_HOSTS[i], ...r })).filter((r) => !r.ok || r.status === 403);
	return { ok: bad.length === 0, summary: bad.map((b) => `${b.host} ${b.ok ? '地区受限（403）' : b.error}`).join('，') };
}
function portOpen(port, timeout = 700) {
	return new Promise((resolve) => {
		const sk = netConnect({ host: '127.0.0.1', port });
		const done = (v) => { clearTimeout(t); sk.destroy(); resolve(v); };
		const t = setTimeout(() => done(false), timeout);
		sk.on('connect', () => done(true));
		sk.on('error', () => done(false));
	});
}
async function findLocalProxy(skip) {
	for (const port of LOCAL_PROXY_PORTS) {
		const proxy = `http://127.0.0.1:${port}`;
		if (proxy === skip || !(await portOpen(port))) continue;
		if ((await checkAnthropic(proxy)).ok) return proxy;
	}
	return null;
}
// Make sure claude will be able to reach Anthropic; switch to a working local proxy if needed.
async function ensureNetwork(report) {
	const current = readProxySetting();
	const c = await checkAnthropic(current || null);
	if (c.ok) return { ok: true, proxy: current };
	report(`${current ? `代理 ${current} ` : '直连'}连不上 Claude（${c.summary}），正在查找本机代理端口…`);
	const found = await findLocalProxy(current);
	if (found) {
		await saveProxySetting(found);
		log('[net] switched to local proxy', found, 'after', c.summary);
		return { ok: true, proxy: found, changed: true };
	}
	log('[net] Anthropic unreachable:', c.summary);
	return { ok: false, proxy: current, summary: c.summary };
}

// ---------------------------------------------------------------- plan usage
// The claude.ai usage endpoint that Claude Code's own /usage reads, called directly with the
// stored login. That way usage works on either runtime (Agent SDK 0.2.112, behind the Node
// runtime, has no usage call) and before any conversation has started.
const CREDENTIALS_FILE = join(homedir(), '.claude', '.credentials.json');
function readOauth() {
	try { return JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8')).claudeAiOauth || null; } catch { return null; }
}
// GET over HTTPS, directly or through the configured HTTP proxy (CONNECT tunnel).
function httpsGet(host, path, headers, proxy, timeout = 12000) {
	return new Promise((resolve, reject) => {
		const go = (socket) => {
			// A one-off connection, not one kept alive in the global pool. Through a proxy the tunnel
			// is handed over with createConnection, which Node only honours when no agent is given.
			const req = httpsRequest({ host, path, method: 'GET', headers: { host, ...headers }, timeout, ...(socket ? { createConnection: () => socket } : { agent: false }) }, (res) => {
				let body = '';
				res.setEncoding('utf8');
				res.on('data', (d) => { body += d; });
				res.on('end', () => resolve({ status: res.statusCode, body }));
			});
			req.on('timeout', () => req.destroy(new Error('超时')));
			req.on('error', reject);
			req.end();
		};
		if (!proxy) return go(null);
		let u;
		try { u = new URL(proxy); } catch { return reject(new Error('代理地址无效')); }
		const c = httpRequest({ host: u.hostname, port: Number(u.port) || 80, method: 'CONNECT', path: `${host}:443`, headers: { host: `${host}:443` }, timeout });
		c.on('connect', (res, sock) => {
			if (res.statusCode !== 200) { sock.destroy(); return reject(new Error(`代理拒绝（${res.statusCode}）`)); }
			go(tlsConnect({ socket: sock, servername: host }));
		});
		c.on('timeout', () => c.destroy(new Error('超时')));
		c.on('error', reject);
		c.end();
	});
}
async function fetchPlanUsage() {
	const o = readOauth();
	if (!o?.accessToken) return { ok: false, error: '还没有登录 Claude 账号' };
	if (o.expiresAt && o.expiresAt < Date.now()) return { ok: false, error: '登录凭据已过期。发一条消息（claude 会自动刷新），再回来看用量' };
	const version = String(runtimeCache?.chat?.version || '').match(/\d+\.\d+\.\d+/)?.[0] || '2.1.112';
	const r = await httpsGet('api.anthropic.com', '/api/oauth/usage', {
		Authorization: `Bearer ${o.accessToken}`,
		'anthropic-beta': 'oauth-2025-04-20',
		'Content-Type': 'application/json',
		'User-Agent': `claude-code/${version}`,
	}, readProxySetting() || null);
	if (r.status === 401) return { ok: false, error: '登录凭据已失效。发一条消息让 claude 刷新，或者重新登录' };
	if (r.status === 403) return { ok: false, error: '这个登录没有读取用量的权限（缺少 user:profile），请重新登录' };
	if (r.status !== 200) return { ok: false, error: `用量接口返回 ${r.status}` };
	const d = JSON.parse(r.body);
	const pick = (k) => d[k] ?? null;
	return {
		ok: true,
		rate_limits_available: true,
		rate_limits: {
			five_hour: pick('five_hour'), seven_day: pick('seven_day'), seven_day_opus: pick('seven_day_opus'),
			seven_day_sonnet: pick('seven_day_sonnet'), seven_day_oauth_apps: pick('seven_day_oauth_apps'), extra_usage: pick('extra_usage'),
		},
		subscription_type: o.subscriptionType ?? null,
	};
}

// ---------------------------------------------------------------- fonts
// Open-source Chinese fonts (OFL / MIT), offered in Appearance. They are split by the font
// projects into many small woff2 slices by character range; the page only asks for the slices
// of characters actually on screen, and this server fetches each once from an npm mirror and
// keeps it, so a font costs a few hundred KB of real use rather than a 10–80 MB package.
const FONTS = {
	'lxgw-wenkai': { pkg: 'lxgw-wenkai-screen-webfont', ver: '1.7.0', css: 'lxgwwenkaigbscreen.css' },
	'noto-serif': { pkg: '@fontsource/noto-serif-sc', ver: '5.3.1', css: '400.css' },
	'zcool-xiaowei': { pkg: '@fontsource/zcool-xiaowei', ver: '5.3.0', css: 'index.css' },
	'zcool-kuaile': { pkg: '@fontsource/zcool-kuaile', ver: '5.3.0', css: 'index.css' },
	'qingke': { pkg: '@fontsource/zcool-qingke-huangyou', ver: '5.3.0', css: 'index.css' },
	'ma-shan-zheng': { pkg: '@fontsource/ma-shan-zheng', ver: '5.3.1', css: 'index.css' },
};
const FONTS_DIR = join(homedir(), '.claude', 'fonts');
const fontFetches = new Map();
function fontMirrors(f, rel) {
	return [
		`https://registry.npmmirror.com/${f.pkg}/${f.ver}/files/${rel}`, // fast in mainland China
		`https://cdn.jsdelivr.net/npm/${f.pkg}@${f.ver}/${rel}`,
	];
}
async function fontFile(id, rel) {
	const f = FONTS[id];
	if (!f || !/^[A-Za-z0-9._/-]+$/.test(rel) || rel.includes('..')) return null;
	const local = join(FONTS_DIR, id, rel);
	if (existsSync(local)) return local;
	if (!fontFetches.has(local)) {
		fontFetches.set(local, (async () => {
			await mkdir(dirname(local), { recursive: true });
			const tmp = `${local}.part`;
			let lastErr;
			for (const url of fontMirrors(f, rel)) {
				try {
					await fetchUrl(url, { file: tmp, timeout: 30000 });
					await rename(tmp, local);
					return local;
				} catch (e) { lastErr = e; }
			}
			await rm(tmp, { force: true }).catch(() => {});
			throw lastErr || new Error('download failed');
		})().finally(() => fontFetches.delete(local)));
	}
	return fontFetches.get(local);
}

// ---------------------------------------------------------------- chat background
// A wallpaper the owner picks (any image of their own), shown behind the conversation.
const BG_FILE = join(homedir(), '.claude', 'agent-background');

// ---------------------------------------------------------------- built-in skills
// Android skills that ship with the app (app/skills/<id>/SKILL.md). Each is installed once and
// enabled once; after that the owner's choices stand: a disabled one stays disabled, and one the
// owner edited is never overwritten (the .builtin marker records the hash we last wrote).
const BUILTIN_SKILLS_DIR = join(HERE, '..', 'skills');
async function seedBuiltinSkills() {
	let ids = [];
	try { ids = (await readdir(BUILTIN_SKILLS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return; }
	const state = await readSkillsState();
	state.enabled ||= [];
	state.seeded ||= [];
	const hash = (t) => createHash('sha256').update(t).digest('hex');
	for (const id of ids) {
		const src = join(BUILTIN_SKILLS_DIR, id);
		const dst = join(SKILLS_DIR, id);
		let srcText;
		try { srcText = await readFile(join(src, 'SKILL.md'), 'utf8'); } catch { continue; }
		let write = !existsSync(dst);
		if (!write) {
			try {
				const marker = (await readFile(join(dst, '.builtin'), 'utf8')).trim();
				const cur = await readFile(join(dst, 'SKILL.md'), 'utf8');
				write = marker === hash(cur) && marker !== hash(srcText); // untouched by the owner, and we have a newer one
			} catch { /* no marker: the owner's own copy */ }
		}
		if (write) {
			await mkdir(dst, { recursive: true });
			await cp(src, dst, { recursive: true, force: true });
			await writeFile(join(dst, '.builtin'), hash(srcText));
			log('[skills] installed built-in', id);
		}
		if (!state.seeded.includes(id)) {
			state.seeded.push(id);
			if (!state.enabled.includes(id)) state.enabled.push(id);
		}
	}
	await writeSkillsState(state);
}

// ---------------------------------------------------------------- self-update
// Every push to main is built by GitHub Actions and published as a release carrying
// DroidAgent-<version>.apk. This server (root, always running, app open or not) looks for a newer
// one shortly after it starts and every hour, and installs it on its own — the owner's
// choice; settings.autoUpdate=false turns that into "report it". The order is deliberate:
// download → match the digest GitHub published → `pm install` (Android refuses anything not
// signed like the installed app) → only then sync the new launcher / chat app / runtime into the
// chroot and restart, so a failed install never leaves new server code on an old APK.
const UPDATE_REPO = process.env.DROIDAGENT_UPDATE_REPO || 'budong4/droidagent';
const APP_PKG = 'com.droidagent.app';
const APP_DATA = `/data/user_de/0/${APP_PKG}`;
const ASHELL = process.env.AGENT_ASHELL || '/usr/local/bin/ashell';
// Extracted from the new APK for the sync. Inside the chroot, so the app's own private files are
// never touched by root; the launcher (Android side) reaches it at ${APP_DATA}/rootfs/<same path>.
const UPDATE_DIR = '/var/lib/droidagent-update';
const UPDATE_STATE_FILE = join(homedir(), '.claude', 'agent-update.json');
const UPDATE_EVERY = 3600e3;
// A small file the build publishes with every release: version, APK link, size, sha256, notes.
// It is a plain download, not the REST API — anonymous API calls are capped at 60 an hour per IP,
// and a VPN exit or a carrier NAT address shared with many others runs out of them.
const UPDATE_CHANNEL = `https://github.com/${UPDATE_REPO}/releases/download/update-channel/latest.json`;
const update = { checking: false, installing: false, lastCheck: 0, installed: null, latest: null, available: false, error: '' };

function semverCmp(a, b) {
	const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
	const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
	return 0;
}
// Run something in the real Android environment (see /usr/local/bin/ashell).
function ashell(args, { input = null, timeout = 120000 } = {}) {
	return new Promise((resolve) => {
		const c = spawn(ASHELL, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* */ } }, timeout);
		c.stdout.on('data', (d) => { out += d; });
		c.stderr.on('data', (d) => { err += d; });
		c.on('error', (e) => { clearTimeout(t); resolve({ code: 127, out, err: String(e?.message || e) }); });
		c.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
		if (input) { input.on('error', () => {}); c.stdin.on('error', () => {}); input.pipe(c.stdin); }
	});
}
async function installedVersion() {
	const r = await ashell(['-c', `dumpsys package ${APP_PKG} | grep -m1 versionName`], { timeout: 30000 });
	return r.out.match(/versionName=([0-9][0-9.]*)/)?.[1] || null;
}
// GET over HTTPS following redirects, directly or through the configured proxy. Resolves the
// body as text, or streams it into `file`.
function fetchUrl(url, { headers = {}, file = null, timeout = 30000, redirects = 5 } = {}) {
	const proxy = readProxySetting() || null;
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const go = (socket) => {
			const req = httpsRequest({
				host: u.hostname, port: Number(u.port) || 443, path: u.pathname + u.search, method: 'GET', timeout,
				headers: { host: u.hostname, 'User-Agent': 'DroidAgent-updater', ...headers },
				// createConnection is ignored whenever an agent is set, so only go agent-less directly.
				...(socket ? { createConnection: () => socket } : { agent: false }),
			}, (res) => {
				if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
					res.resume();
					return fetchUrl(new URL(res.headers.location, url).href, { file, timeout, redirects: redirects - 1 }).then(resolve, reject);
				}
				if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
				if (file) {
					const ws = createWriteStream(file);
					res.on('error', reject);
					ws.on('error', reject);
					ws.on('finish', () => resolve({ status: 200 }));
					return res.pipe(ws);
				}
				let body = '';
				res.setEncoding('utf8');
				res.on('data', (d) => { body += d; });
				res.on('end', () => resolve({ status: 200, body }));
			});
			req.on('timeout', () => req.destroy(new Error('超时')));
			req.on('error', reject);
			req.end();
		};
		if (!proxy) return go(null);
		let pu;
		try { pu = new URL(proxy); } catch { return reject(new Error('代理地址无效')); }
		const target = `${u.hostname}:${Number(u.port) || 443}`;
		const c = httpRequest({ host: pu.hostname, port: Number(pu.port) || 80, method: 'CONNECT', path: target, headers: { host: target }, timeout });
		c.on('connect', (res, sock) => {
			if (res.statusCode !== 200) { sock.destroy(); return reject(new Error(`代理拒绝（${res.statusCode}）`)); }
			go(tlsConnect({ socket: sock, servername: u.hostname }));
		});
		c.on('timeout', () => c.destroy(new Error('超时')));
		c.on('error', reject);
		c.end();
	});
}
// The newest DroidAgent-<x.y.z>.apk across the repository's releases (the update builds are
// marked pre-release, so /releases/latest would not see them).
async function latestRelease() {
	try {
		const j = JSON.parse((await fetchUrl(UPDATE_CHANNEL, { timeout: 20000 })).body);
		if (/^\d+\.\d+\.\d+$/.test(j.version || '') && j.apk) {
			return { version: j.version, url: j.apk, size: j.size, digest: j.sha256 ? `sha256:${j.sha256}` : null, notes: j.notes || '', tag: `v${j.version}` };
		}
	} catch (e) {
		log('[update] update channel unavailable:', e?.message, '— asking the GitHub API');
	}
	const r = await fetchUrl(`https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=20`, { headers: { Accept: 'application/vnd.github+json' }, timeout: 20000 });
	let best = null;
	for (const rel of JSON.parse(r.body)) {
		if (rel.draft) continue;
		for (const a of rel.assets || []) {
			const m = /^DroidAgent-(\d+\.\d+\.\d+)\.apk$/.exec(a.name || '');
			if (m && (!best || semverCmp(m[1], best.version) > 0)) {
				best = { version: m[1], url: a.browser_download_url, size: a.size, digest: a.digest || null, notes: rel.body || '', tag: rel.tag_name };
			}
		}
	}
	return best;
}
function sha256File(path) {
	return new Promise((resolve, reject) => {
		const h = createHash('sha256');
		createReadStream(path).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
	});
}
function extractApkAssets(apk, dir) {
	const py = [
		'import os, shutil, sys, zipfile',
		'apk, out = sys.argv[1], sys.argv[2]',
		'os.makedirs(out, exist_ok=True)',
		'with zipfile.ZipFile(apk) as z:',
		'    names = set(z.namelist())',
		"    for n in ('debian', 'agent-app.tar', 'legacy-runtime.tar.xz'):",
		"        if 'assets/' + n in names:",
		"            tmp = os.path.join(out, n + '.new')",
		"            with z.open('assets/' + n) as src, open(tmp, 'wb') as dst:",
		'                shutil.copyfileobj(src, dst)',
		'            os.replace(tmp, os.path.join(out, n))',
	].join('\n');
	return new Promise((resolve, reject) => {
		execFile('python3', ['-c', py, apk, dir], { timeout: 120000 }, (err, _o, e) => (err ? reject(new Error(`解开新版本失败：${String(e || err.message).trim().slice(-160)}`)) : resolve()));
	});
}
function lastUpdateInfo() {
	try { return JSON.parse(readFileSync(UPDATE_STATE_FILE, 'utf8')); } catch { return null; }
}
function updateInfo() {
	return {
		current: update.installed, latest: update.latest?.version || null, available: update.available,
		autoUpdate: settings.autoUpdate !== false, checking: update.checking, installing: update.installing,
		lastCheck: update.lastCheck, error: update.error, lastUpdate: lastUpdateInfo(), repo: UPDATE_REPO,
	};
}
function mainClientOpen() {
	for (const res of clients) if (res.isMain) return true;
	return false;
}

async function installUpdate(rel) {
	update.installing = true;
	update.error = '';
	broadcast({ type: 'update_status', update: updateInfo() });
	const apk = `/tmp/DroidAgent-${rel.version}.apk`;
	try {
		log('[update] downloading', rel.version);
		await fetchUrl(rel.url, { file: apk, timeout: 60000 });
		const size = (await stat(apk)).size;
		if (rel.size && size !== rel.size) throw new Error(`下载不完整（${size}/${rel.size} 字节）`);
		if (rel.digest?.startsWith('sha256:') && (await sha256File(apk)) !== rel.digest.slice(7)) throw new Error('下载的文件校验值不符');
		await extractApkAssets(apk, UPDATE_DIR);
		// Streamed through stdin, the way `adb install` does it: system_server reads a pipe, so
		// where the file sits and how it is labelled doesn't matter.
		const r = await ashell(['pm', 'install', '-r', '-S', String(size)], { input: createReadStream(apk), timeout: 300000 });
		if (!/Success/.test(r.out)) throw new Error(`安装失败：${(r.out + ' ' + r.err).trim().slice(-200) || `退出码 ${r.code}`}`);
		await writeFile(UPDATE_STATE_FILE, JSON.stringify({ from: update.installed, to: rel.version, at: Date.now(), notes: String(rel.notes).slice(0, 3000) }));
		log('[update] installed', rel.version, '— syncing and restarting');
		update.installed = rel.version;
		update.available = false;
		broadcast({ type: 'update_status', update: { ...updateInfo(), restarting: true } });
		// Installing replaced the app, which closes it; bring it back if it was on screen. The
		// launcher then stops this server and starts the new one, so it runs detached.
		const files = `${APP_DATA}/rootfs${UPDATE_DIR}`;
		let script = `env AGENT_APK_DIR=${APP_DATA} sh ${files}/debian boot ${files}/agent-app.tar ${files}/legacy-runtime.tar.xz > /data/local/tmp/droidagent-update.log 2>&1`;
		if (mainClientOpen()) script += `; am start -n ${APP_PKG}/.MainActivity > /dev/null 2>&1`;
		const child = spawn(ASHELL, ['-c', script], { detached: true, stdio: 'ignore' });
		child.unref();
	} catch (e) {
		update.error = String(e?.message || e);
		log('[update] failed:', update.error);
	} finally {
		update.installing = false;
		rm(apk, { force: true }).catch(() => {});
		broadcast({ type: 'update_status', update: updateInfo() });
	}
}
// Returns true when it should look again soon (an update is waiting for a quiet moment).
async function checkUpdate({ install = settings.autoUpdate !== false, now = false } = {}) {
	if (update.checking || update.installing) return false;
	update.checking = true;
	update.error = '';
	let retrySoon = false;
	try {
		update.installed = await installedVersion();
		update.latest = await latestRelease();
		update.lastCheck = Date.now();
		update.available = !!(update.latest && update.installed && semverCmp(update.latest.version, update.installed) > 0);
		if (update.available) log('[update] available', update.installed, '->', update.latest.version);
		if (update.available && install) {
			if (!now && [...runtimes.values()].some((rt) => rt.running)) {
				log('[update] waiting: a conversation is running');
				retrySoon = true;
			} else {
				update.checking = false;
				await installUpdate(update.latest);
			}
		}
	} catch (e) {
		const msg = String(e?.message || e);
		update.error = /HTTP 404/.test(msg) ? `找不到 ${UPDATE_REPO} 的发布（仓库需要是公开的）`
			: /HTTP 403/.test(msg) ? 'GitHub 暂时限制了查询（同一网络请求太多），稍后会自动重试'
				: `检查更新失败：${msg}`;
		log('[update]', update.error);
	} finally {
		update.checking = false;
		broadcast({ type: 'update_status', update: updateInfo() });
	}
	return retrySoon;
}
let updateTimer = null;
function scheduleUpdateCheck(ms) {
	clearTimeout(updateTimer);
	updateTimer = setTimeout(async () => {
		const soon = await checkUpdate().catch(() => false);
		scheduleUpdateCheck(soon ? 10 * 60e3 : UPDATE_EVERY);
	}, ms);
}

// ---------------------------------------------------------------- Claude Code runtime
// Current Claude Code releases are Bun-compiled native binaries (the global `claude`, and the one
// inside the Agent SDK). On some Android kernels Bun's JavaScript engine aborts while starting up
// (SIGABRT in JSC::VM::tryCreate), before Claude Code itself runs. So nothing is assumed: each
// option is started once with --version and the first that works is used, for chat and for
// `claude auth …` alike:
//   1. the native binaries as they are;
//   2. the same with JavaScriptCoreUseJIT=0, which makes JavaScriptCore skip reserving JIT memory;
//   3. Claude Code 2.1.112 on Node.js — the last release shipped as plain JavaScript — from Agent
//      SDK 0.2.112 in server/legacy-sdk (installed by the update package). Node runs fine on
//      these phones: this server is Node.
const NO_JIT = { JavaScriptCoreUseJIT: '0' };
const LEGACY_SDK = join(HERE, 'legacy-sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
const SDK_CLI_PKGS = {
	arm64: ['claude-agent-sdk-linux-arm64', 'claude-agent-sdk-linux-arm64-musl'],
	x64: ['claude-agent-sdk-linux-x64', 'claude-agent-sdk-linux-x64-musl'],
};
// The legacy CLI's own aliases point at the models it knew in April 2026; ask for current ones by id.
const LEGACY_MODEL_IDS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1' };

function nativeCandidates() {
	const out = [];
	const seen = new Set();
	const add = (label, kind, path) => {
		if (seen.has(path) || !existsSync(path)) return;
		seen.add(path);
		out.push({ label, kind, path });
	};
	for (const dir of String(process.env.PATH || '').split(':')) if (dir) add(`全局 claude（${join(dir, 'claude')}）`, 'global', join(dir, 'claude'));
	add('全局 claude（~/.local/bin）', 'global', join(homedir(), '.local', 'bin', 'claude'));
	for (const pkg of SDK_CLI_PKGS[process.arch] || []) add('SDK 内置 claude', 'sdk', join(HERE, 'node_modules', '@anthropic-ai', pkg, 'claude'));
	return out;
}
function legacySpec() {
	const cli = join(LEGACY_SDK, 'cli.js');
	return existsSync(cli) ? { label: 'Node 版 claude', kind: 'legacy', cmd: [process.execPath, cli], env: {} } : null;
}
function runClaude(spec, args, opts = {}) {
	return spawn(spec.cmd[0], [...spec.cmd.slice(1), ...args], { ...opts, env: { ...process.env, ANTHROPIC_API_KEY: '', ...spec.env } });
}
function probe(spec) {
	return new Promise((resolve) => {
		execFile(spec.cmd[0], [...spec.cmd.slice(1), '--version'], { timeout: 45000, env: { ...process.env, ANTHROPIC_API_KEY: '', ...spec.env } },
			(err, stdout, stderr) => {
				const version = String(stdout || '').trim().split('\n')[0];
				if (!err && /\d+\.\d+\.\d+/.test(version)) return resolve({ ok: true, version });
				const why = err?.signal ? `被信号 ${err.signal} 终止` : err?.killed ? '超时' : (String(stderr || '').trim().split('\n').pop() || err?.message || '无输出');
				resolve({ ok: false, error: /bun\.report|Bun has crashed/.test(String(stderr) + String(stdout)) ? `Bun 崩溃（${why}）` : why.slice(0, 160) });
			});
	});
}

let runtimeCache = null;
let runtimeProbe = null;
async function claudeRuntime() {
	if (runtimeCache) return runtimeCache;
	if (runtimeProbe) return runtimeProbe;
	runtimeProbe = (async () => {
		const tried = [];
		const working = [];
		for (const c of nativeCandidates()) {
			for (const env of [{}, NO_JIT]) {
				const spec = { label: c.label + (env === NO_JIT ? ' + 关闭 JIT' : ''), kind: c.kind, cmd: [c.path], env };
				const r = await probe(spec);
				tried.push({ label: spec.label, ok: r.ok, detail: r.ok ? r.version : r.error });
				if (r.ok) { working.push({ ...spec, version: r.version }); break; }
			}
		}
		const legacy = legacySpec();
		if (legacy) {
			const r = await probe(legacy);
			tried.push({ label: legacy.label, ok: r.ok, detail: r.ok ? r.version : r.error });
			if (r.ok) working.push({ ...legacy, version: r.version });
		}
		const chatSpec = working.find((w) => w.kind === 'sdk') || working.find((w) => w.kind === 'legacy') || working.find((w) => w.kind === 'global') || null;
		const result = {
			chat: chatSpec,
			// Log in with the same program chat uses; the credentials land in the same ~/.claude.
			auth: chatSpec,
			working,
			tried,
			allSpecs: [...nativeCandidates().map((c) => ({ label: c.label, kind: c.kind, cmd: [c.path], env: {} })), ...(legacy ? [legacy] : [])],
		};
		log('[runtime]', tried.map((t) => `${t.label}: ${t.ok ? t.detail : '✗ ' + t.detail}`).join(' | ') || 'no candidates');
		log('[runtime] chat via', chatSpec ? `${chatSpec.label}（${chatSpec.version}）` : 'NOTHING');
		if (chatSpec) runtimeCache = result; // with nothing working, look again next time
		return result;
	})();
	try { return await runtimeProbe; } finally { runtimeProbe = null; }
}
function noRuntimeMessage(rt) {
	const lines = (rt?.tried || []).map((t) => `${t.label}：${t.detail}`).join('；');
	return `这台手机上启动不了 Claude Code${lines ? '（' + lines + '）' : ''}。请刷入最新的 DroidAgent 更新包，它带有 Node 版运行时。`;
}
const sdkModules = {};
async function loadSdkFor(spec) {
	if (spec.kind === 'legacy') return (sdkModules.legacy ||= await import(pathToFileURL(join(LEGACY_SDK, 'sdk.mjs')).href));
	return (sdkModules.current ||= await import('@anthropic-ai/claude-agent-sdk'));
}
function modelFor(spec, m) {
	const alias = getSdkModel(m);
	return spec?.kind === 'legacy' ? (LEGACY_MODEL_IDS[alias] || alias) : alias;
}
// How the SDK should start Claude Code for this runtime.
function queryRuntimeOptions(spec) {
	const o = {};
	if (Object.keys(spec.env).length) o.env = { ...process.env, ...spec.env };
	if (spec.kind === 'legacy') { o.pathToClaudeCodeExecutable = spec.cmd[1]; o.executable = 'node'; }
	else o.pathToClaudeCodeExecutable = spec.cmd[0];
	return o;
}

// ---------------------------------------------------------------- login (pty)
let login = null;
let loginRequest = 0;
async function startLogin() {
	cancelLogin();
	const request = ++loginRequest;
	const status = (text, extra = {}) => { if (request === loginRequest) broadcast({ type: 'login_status', text, ...extra }); };
	// The CLI inherits the proxy when it starts, so the route has to be right before it does.
	status('正在检查能否连上 Claude…');
	const route = await ensureNetwork((text) => status(text));
	if (request !== loginRequest) return;
	if (route.changed) status(`已自动改用本机代理 ${route.proxy}`, { proxy: route.proxy, kind: 'ok' });
	else if (!route.ok) status(`连不上 Claude 的服务器（${route.summary}），也没找到可用的本机代理端口。可以继续，但最后一步多半会卡住；建议先在下方填写代理软件的 HTTP 端口。`, { kind: 'warn' });
	const rt = await claudeRuntime();
	if (request !== loginRequest) return; // a newer tap on "start" took over while we were probing
	// The program chat uses first, then anything else that starts. With nothing that passed
	// --version, still let the script try every candidate: its output says why none can start.
	const specs = rt.working.length ? [rt.auth, ...rt.working.filter((w) => w !== rt.auth)] : rt.allSpecs;
	const child = spawn('python3', [join(HERE, 'login_pty.py')], {
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, CLAUDE_CLI_SPECS: JSON.stringify(specs.map(({ label, cmd, env }) => ({ label, cmd, env }))) },
	});
	login = child;
	let buf = '';
	let done = false;
	let gotDone = false;
	let loginMode = 'manual'; // 'auto': the link sends the browser straight back to claude on localhost
	const finish = (ok, message) => {
		if (done || child.cancelled) return;
		done = true;
		broadcast({ type: 'login_done', ok, message });
		if (login === child) login = null;
		if (ok) isLoggedIn().then((li) => broadcast({ type: 'auth', loggedIn: li }));
	};
	child.stdout.on('data', (d) => {
		buf += d.toString();
		let i;
		while ((i = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, i); buf = buf.slice(i + 1);
			log('[login-pty]', line.startsWith('URL ') ? line.slice(0, 50) + '...' : line);
			if (line.startsWith('MODE ')) loginMode = line.slice(5).trim();
			else if (line.startsWith('URL ')) broadcast({ type: 'login_url', url: line.slice(4).trim(), mode: loginMode });
			else if (line === 'NEED_CODE') broadcast({ type: 'login_need_code' });
			else if (line.startsWith('TOKEN ')) {
				// `claude auth login` doesn't normally print this (login_pty.py keeps the pattern
				// as a harmless fallback) — intentionally not acted on: see the note at LEGACY_TOKEN_FILE.
				log('[login-pty] unexpected TOKEN line from auth login, ignoring');
			} else if (line.startsWith('STATUS ')) {
				broadcast({ type: 'login_status', text: line.slice(7), kind: 'cli' });
			} else if (line.startsWith('DONE ')) {
				gotDone = true;
				const ok = line.slice(5).startsWith('ok');
				const message = ok ? '' : line.slice(5).replace(/^fail\s*/, '');
				// A run that stalled after the tokens were already saved still logged in.
				if (ok) finish(true, '');
				else isLoggedIn().then((li) => finish(li, li ? '' : message), () => finish(false, message));
			}
		}
	});
	child.stderr.on('data', (d) => log('[login-err]', String(d).trim().slice(0, 300)));
	child.on('error', (e) => { log('[login-spawn]', e?.message); finish(false, `无法运行登录脚本（python3）：${e?.message || e}`); });
	// 'close', not 'exit': stdout may still hold the DONE line when the process itself has exited.
	child.on('close', (c, s) => {
		log('[login-exit]', c, s);
		if (!gotDone) finish(false, `登录进程意外退出（${s || c}）`);
	});
}
// Replacing or cancelling a login on purpose must not surface as "login failed" in the UI.
function cancelLogin() {
	if (!login) return;
	login.cancelled = true;
	try { login.kill('SIGKILL'); } catch { /* */ }
	login = null;
}
function sendLoginCode(code) {
	if (login && login.stdin.writable) { login.stdin.write(String(code).trim() + '\n'); return true; }
	return false;
}

// The full `claude auth status` object — email, org, subscription type, auth method, etc.
// Null if the command fails or doesn't return valid JSON (treated as "not logged in").
async function getAuthStatus() {
	const spec = (await claudeRuntime()).auth;
	if (!spec) return null;
	return await new Promise((resolve) => {
		const c = runClaude(spec, ['auth', 'status']);
		let out = '';
		const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* */ } resolve(null); }, 15000);
		c.stdout.on('data', (d) => { out += d; });
		c.on('exit', () => {
			clearTimeout(t);
			try { resolve(JSON.parse(out)); } catch { resolve(null); }
		});
		c.on('error', () => { clearTimeout(t); resolve(null); });
	});
}

async function isLoggedIn() {
	const s = await getAuthStatus();
	return !!s?.loggedIn;
}

// ---------------------------------------------------------------- HTTP
const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.webmanifest': 'application/manifest+json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
	'.woff': 'font/woff',
};

function body(req) {
	return new Promise((resolve) => {
		let b = ''; req.on('data', (c) => { b += c; if (b.length > 2e7) req.destroy(); }); // up to 20MB for images
		req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
	});
}
const json = (res, obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

async function serveStatic(req, res) {
	let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
	if (p === '/') p = '/index.html';
	const file = normalize(join(WEB, p));
	if (!file.startsWith(WEB)) { res.writeHead(403); return res.end('no'); }
	try {
		const s = await stat(file);
		if (s.isDirectory()) { res.writeHead(403); return res.end('no'); }
		const data = await readFile(file);
		res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
		res.end(data);
	} catch { res.writeHead(404); res.end('not found'); }
}


// ---------------------------------------------------------------- request guard (no password, so lock down who can talk to us)
// Without a password the only thing between this root-capable agent and the rest of the phone's
// browser is the browser's own same-origin rules. Those do not cover "simple" cross-site POSTs
// (text/plain, no preflight) or DNS rebinding, so check Host, Origin and Content-Type ourselves.
// Non-browser clients (curl, other local apps) send no Origin and are not stopped by this.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`,
	...String(process.env.AGENT_EXTRA_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));

function guardRequest(req, res) {
	const refuse = (code, why) => {
		log('[guard] refused', code, why, req.method, (req.url || '').slice(0, 60), 'host=' + req.headers.host, 'origin=' + req.headers.origin);
		res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
		res.end(why);
		return false;
	};
	if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'HEAD') return refuse(405, 'method not allowed');
	if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) return refuse(403, 'bad host');
	const origin = req.headers.origin;
	if (origin !== undefined && !ALLOWED_ORIGINS.has(String(origin).toLowerCase())) return refuse(403, 'bad origin');
	if (req.method === 'POST') {
		const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
		if (ct && ct !== 'application/json') return refuse(415, 'content-type must be application/json');
	}
	return true;
}

const server = createServer(async (req, res) => {
	if (!guardRequest(req, res)) return;
	const url = new URL(req.url, 'http://x');
	const path = url.pathname;
	try {
		if (path === '/api/events') {
			res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
			res.write(': connected\n\n');
			res.isMain = url.searchParams.get('main') === '1'; // the chat page (vs. the bubble's panel)
			clients.add(res);
			res.write(`data: ${JSON.stringify({ type: 'hello', settings, activeSessionId, activeSession: activeSessionId ? sessionCache.get(activeSessionId) : null, lastUpdate: lastUpdateInfo() })}\n\n`);
			isLoggedIn().then((li) => { try { res.write(`data: ${JSON.stringify({ type: 'auth', loggedIn: li })}\n\n`); } catch { /* */ } });
			const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* */ } }, 20000);
			req.on('close', () => { clearInterval(ka); clients.delete(res); });
			return;
		}

		// Send chat message — queues onto that conversation's own runtime, creating it if needed.
		// Sending to one conversation never touches any other conversation's in-flight runtime.
		if (req.method === 'POST' && path === '/api/send') {
			const { text, scopes, sessionId } = await body(req);
			if (!text || !String(text).trim()) return json(res, { ok: false, error: 'empty' }, 400);
			const str = String(text);
			const id = sessionId || activeSessionId;
			if (!id) return json(res, { ok: false, error: 'no session' }, 400);
			const sess = await getOrLoadSessionObj(id);
			if (!sess) return json(res, { ok: false, error: 'session not found' }, 404);

			// Format title from first message
			if (sess.messages.length === 0 || sess.title === '新对话') {
				let cleanTitle = str.replace(/【.*?】/g, '').trim().slice(0, 24).replace(/\n/g, ' ') || '新对话';
				sess.title = cleanTitle;
			}

			sess.messages.push({ role: 'user', text: str, scopes: scopes || [], time: Date.now() });
			await saveSession(sess);

			const rt = await ensureRuntime(id);
			rt.running = true;
			rt.lastActive = Date.now();
			broadcast({ type: 'user_echo', sessionId: id, text: str, session: sess });
			rt.pushUser(str); // queues even if this conversation is still mid-turn — multiple messages in flight is fine
			return json(res, { ok: true });
		}

		// Tool permission decision — routed to the specific conversation's own pending map.
		if (req.method === 'POST' && path === '/api/permission') {
			const { id: permId, decision, sessionId } = await body(req);
			const sid = sessionId || activeSessionId;
			const rt = sid && runtimes.get(sid);
			const p = rt?.pending.get(permId);
			if (!p) return json(res, { ok: false, error: 'gone' }, 404);
			const sess = sid && sessionCache.get(sid);
			if (sess) {
				const pm = sess.messages.find((x) => x.role === 'perm' && x.id === permId);
				if (pm) {
					pm.verdict = decision;
					saveSession(sess);
				}
			}
			if (decision === 'allow') p.resolve({ behavior: 'allow', updatedInput: p.input });
			else p.resolve({ behavior: 'deny', message: '用户拒绝了这个操作', interrupt: decision === 'stop' });
			broadcast({ type: 'permission_resolved', sessionId: sid, id: permId, decision });
			// An approved plan means "do it": leave Plan mode the way Claude Code does, into Accept edits.
			if (decision === 'allow' && p.toolName === 'ExitPlanMode' && settings.mode === 'plan') {
				settings.mode = 'acceptEdits';
				await persistSettings();
				for (const r of runtimes.values()) { try { r.q.setPermissionMode?.('default'); } catch { /* */ } }
				broadcast({ type: 'settings', settings });
			}
			return json(res, { ok: true });
		}

		// Stop current run — interrupts only this one conversation's current turn (same granularity
		// as Esc in the terminal); the conversation and its process stay alive, ready for the next message.
		if (req.method === 'POST' && path === '/api/stop') {
			const { sessionId } = await body(req);
			const sid = sessionId || activeSessionId;
			const rt = sid && runtimes.get(sid);
			try { rt?.q?.interrupt?.(); } catch { /* */ }
			for (const [, p] of rt?.pending || []) p.resolve({ behavior: 'deny', message: '用户已停止', interrupt: true });
			return json(res, { ok: true });
		}

		// Tiny plain-text status line for the floating bubble, so the Java side needs no JSON parser.
		// Format: STATE \t label \t runningCount   (STATE: WAITING | RUNNING | IDLE)
		if (path === '/api/overlay-status' && req.method === 'GET') {
			const live = [...runtimes.values()];
			const running = live.filter((rt) => rt.running);
			const waiting = live.filter((rt) => rt.pending.size > 0);
			const state = waiting.length ? 'WAITING' : running.length ? 'RUNNING' : 'IDLE';
			const label = waiting.length ? '等待你确认' : (running.find((rt) => rt.label)?.label || (running.length ? '处理中' : ''));
			res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
			return res.end(`${state}\t${String(label).replace(/\s+/g, ' ').slice(0, 40)}\t${running.length}`);
		}

		// Sessions API
		if (path === '/api/sessions' && req.method === 'GET') {
			const idx = await loadSessionsIndex();
			const runningIds = [...runtimes.entries()].filter(([, rt]) => rt.running).map(([sid]) => sid);
			const pendingIds = [...runtimes.entries()].filter(([, rt]) => rt.pending.size > 0).map(([sid]) => sid);
			return json(res, {
				ok: true,
				sessions: idx,
				activeId: activeSessionId,
				activeSession: activeSessionId ? sessionCache.get(activeSessionId) : null,
				runningIds,   // conversations with a turn in flight right now — sidebar shows a live dot
				pendingIds,   // conversations with an unanswered permission card waiting
			});
		}

		// New conversation — never touches any other conversation's runtime.
		if (path === '/api/sessions/new' && req.method === 'POST') {
			const newSess = await createNewSession('新对话');
			activeSessionId = newSess.id;
			broadcast({ type: 'session_switched', session: newSess });
			const idx = await loadSessionsIndex();
			broadcast({ type: 'sessions_updated', sessions: idx });
			return json(res, { ok: true, session: newSess });
		}

		// Switch which conversation the screen is showing — a pure view change, no teardown.
		// Whatever else is running in the background keeps running.
		if (path === '/api/sessions/switch' && req.method === 'POST') {
			const { id } = await body(req);
			if (!id) return json(res, { ok: false, error: 'no id' }, 400);
			const s = await getOrLoadSessionObj(id);
			if (!s) return json(res, { ok: false, error: 'not found' }, 404);
			activeSessionId = id;
			broadcast({ type: 'session_switched', session: s });
			return json(res, { ok: true, session: s });
		}

		if (path === '/api/sessions/pin' && req.method === 'POST') {
			const { id, pinned } = await body(req);
			const s = await getOrLoadSessionObj(id);
			if (!s) return json(res, { ok: false, error: 'not found' }, 404);
			s.pinned = !!pinned;
			await saveSession(s);
			const idx = await loadSessionsIndex();
			broadcast({ type: 'sessions_updated', sessions: idx });
			return json(res, { ok: true, pinned: s.pinned });
		}

		if (path === '/api/sessions/rename' && req.method === 'POST') {
			const { id, title } = await body(req);
			if (!title || !title.trim()) return json(res, { ok: false, error: 'empty title' }, 400);
			const s = await getOrLoadSessionObj(id);
			if (!s) return json(res, { ok: false, error: 'not found' }, 404);
			s.title = title.trim();
			await saveSession(s);
			const idx = await loadSessionsIndex();
			broadcast({ type: 'sessions_updated', sessions: idx });
			return json(res, { ok: true, title: s.title });
		}

		// Delete one conversation — only THIS one's runtime (if any) is torn down.
		if (path === '/api/sessions/delete' && req.method === 'POST') {
			const { id } = await body(req);
			if (!id) return json(res, { ok: false, error: 'no id' }, 400);
			teardownRuntime(id);
			sessionCache.delete(id);
			try {
				await unlink(join(SESSIONS_DIR, `${id}.json`));
			} catch {}
			const idx = await loadSessionsIndex();
			const nextIdx = idx.filter((s) => s.id !== id);
			await saveSessionsIndex(nextIdx);

			let switched = null;
			if (activeSessionId === id) {
				if (nextIdx.length > 0) {
					switched = await getOrLoadSessionObj(nextIdx[0].id);
					activeSessionId = switched ? switched.id : null;
				}
				if (!switched) {
					switched = await createNewSession('新对话');
					activeSessionId = switched.id;
				}
				broadcast({ type: 'session_switched', session: switched });
			}
			broadcast({ type: 'sessions_updated', sessions: nextIdx });
			return json(res, { ok: true, activeSession: switched || (activeSessionId ? sessionCache.get(activeSessionId) : null) });
		}

		// Clear ALL history — this is the one case that legitimately ends every open conversation.
		if (path === '/api/sessions/clear' && req.method === 'POST') {
			for (const id of [...runtimes.keys()]) teardownRuntime(id);
			sessionCache.clear();
			const files = await readdir(SESSIONS_DIR).catch(() => []);
			for (const f of files) {
				try { await unlink(join(SESSIONS_DIR, f)); } catch {}
			}
			const newSess = await createNewSession('新对话');
			activeSessionId = newSess.id;
			broadcast({ type: 'session_switched', session: newSess });
			broadcast({ type: 'sessions_updated', sessions: [newSess] });
			return json(res, { ok: true, session: newSess });
		}

		// Apps List API
		if (path === '/api/apps' && req.method === 'GET') {
			const apps = await getInstalledApps();
			return json(res, { ok: true, apps });
		}

		// Filesystem Browser API (with size, kind, and optional in-folder search)
		if (path === '/api/fs' && req.method === 'GET') {
			const targetPath = url.searchParams.get('path') || '/sdcard';
			const q = (url.searchParams.get('q') || '').trim();
			try {
				const resolved = resolve(targetPath);
				const st = await stat(resolved);
				if (!st.isDirectory()) return json(res, { ok: false, error: 'not a directory' }, 400);

				let items;
				if (q) {
					items = await fsSearch(resolved, q);
				} else {
					const entries = await readdir(resolved, { withFileTypes: true });
					items = [];
					for (const ent of entries) {
						if (ent.name.startsWith('.')) continue;
						items.push(await fsItem(join(resolved, ent.name), ent.name));
					}
				}
				items.sort((a, b) => {
					if (a.isDir !== b.isDir) return b.isDir ? 1 : -1;
					return a.name.localeCompare(b.name, 'zh-CN');
				});
				return json(res, {
					ok: true,
					currentPath: resolved,
					parentPath: dirname(resolved),
					searched: !!q,
					items: items.slice(0, 300),
				});
			} catch (e) {
				return json(res, { ok: false, error: e?.message || 'cannot read directory' }, 500);
			}
		}

		// Image Upload API
		if (path === '/api/upload' && req.method === 'POST') {
			const { dataUrl, filename } = await body(req);
			if (!dataUrl) return json(res, { ok: false, error: 'no data' }, 400);
			const matches = dataUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
			if (!matches || matches.length !== 3) return json(res, { ok: false, error: 'invalid data url' }, 400);
			const ext = (filename && extname(filename)) ? extname(filename) : '.png';
			const uploadPath = `/tmp/agent-upload-${randomUUID()}${ext}`;
			const buffer = Buffer.from(matches[2], 'base64');
			await writeFile(uploadPath, buffer);
			return json(res, { ok: true, path: uploadPath, filename: filename || basename(uploadPath) });
		}

		// Screenshot Capture API
		if (path === '/api/screenshot' && req.method === 'POST') {
			const shotPath = `/tmp/agent-screen-${randomUUID()}.png`;
			exec(`droid shot -o ${shotPath}`, { timeout: 8000 }, async (err) => {
				if (err) {
					// Fallback to screencap
					exec(`ashell screencap -p ${shotPath}`, { timeout: 6000 }, (e2) => {
						if (e2) return json(res, { ok: false, error: 'screenshot failed' }, 500);
						return json(res, { ok: true, path: shotPath, filename: '当前屏幕截图.png' });
					});
				} else {
					return json(res, { ok: true, path: shotPath, filename: '当前屏幕截图.png' });
				}
			});
			return;
		}

		// Settings API — these are app-wide, so push live changes to every open conversation, not just one.
		if (req.method === 'POST' && path === '/api/settings') {
			const next = await body(req);
			if ('mode' in next && !MODES.includes(next.mode)) delete next.mode; // unknown mode: keep the current one
			for (const k of SETTING_KEYS) if (k in next) settings[k] = next[k];
			await persistSettings();
			for (const rt of runtimes.values()) {
				try { if (settings.mode === 'plan') rt.q.setPermissionMode?.('plan'); else rt.q.setPermissionMode?.('default'); } catch { /* */ }
				try { rt.q.setModel?.(modelFor(rt.chatSpec, settings.model)); } catch { /* */ }
			}
			broadcast({ type: 'settings', settings });
			return json(res, { ok: true, settings });
		}

		// ---- System prompt (AgentMD) ----
		if (path === '/api/systemprompt' && req.method === 'GET') {
			let text = '';
			try { text = await readFile(SYSTEM_PROMPT_FILE, 'utf8'); } catch { /* none */ }
			return json(res, { ok: true, text });
		}
		if (path === '/api/systemprompt' && req.method === 'POST') {
			const { text } = await body(req);
			await mkdir(dirname(SYSTEM_PROMPT_FILE), { recursive: true });
			await writeFile(SYSTEM_PROMPT_FILE, String(text || ''), 'utf8');
			// The SDK builds systemPrompt once at query() creation, so this can't be hot-pushed into
			// conversations already running — it applies to new conversations, or ones reopened after
			// their runtime idles out. Deliberately NOT tearing anything down to make it "apply sooner".
			broadcast({ type: 'systemprompt_saved' });
			return json(res, { ok: true });
		}

		// ---- Skills ----
		if (path === '/api/skills' && req.method === 'GET') {
			return json(res, { ok: true, skills: await listSkills() });
		}
		if (path === '/api/skills/install' && req.method === 'POST') {
			const { source } = await body(req);
			const src = String(source || '').trim();
			if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.test(src) && !src.startsWith('/')) {
				return json(res, { ok: false, error: '只支持 https://github.com/… 仓库或本机绝对路径（ZIP/目录）' }, 400);
			}
			await mkdir(SKILLS_DIR, { recursive: true });
			try {
				await installSkill(src);
				for (const rt of runtimes.values()) { if (rt.q?.reloadSkills) { try { await rt.q.reloadSkills(); } catch { /* */ } } }
				broadcast({ type: 'skills_updated' });
				return json(res, { ok: true, skills: await listSkills() });
			} catch (e) {
				return json(res, { ok: false, error: e?.message || '安装失败' }, 500);
			}
		}
		if (path === '/api/skills/toggle' && req.method === 'POST') {
			const { id, enabled } = await body(req);
			const state = await readSkillsState();
			state.enabled = (state.enabled || []).filter((x) => x !== id);
			if (enabled) state.enabled.push(id);
			await writeSkillsState(state);
			for (const rt of runtimes.values()) { if (rt.q?.reloadSkills) { try { await rt.q.reloadSkills(); } catch { /* */ } } }
			broadcast({ type: 'skills_updated' });
			return json(res, { ok: true, skills: await listSkills() });
		}
		if (path === '/api/skills/delete' && req.method === 'POST') {
			const { id } = await body(req);
			if (!id || /[/\\]/.test(id)) return json(res, { ok: false, error: 'bad id' }, 400);
			try { await rm(join(SKILLS_DIR, id), { recursive: true, force: true }); } catch { /* */ }
			const state = await readSkillsState();
			state.enabled = (state.enabled || []).filter((x) => x !== id);
			await writeSkillsState(state);
			for (const rt of runtimes.values()) { if (rt.q?.reloadSkills) { try { await rt.q.reloadSkills(); } catch { /* */ } } }
			broadcast({ type: 'skills_updated' });
			return json(res, { ok: true, skills: await listSkills() });
		}

		// ---- MCP ----
		// Each conversation's query() is its own process with its own MCP connections, so "status"
		// is inherently per-conversation — show whichever one the screen is currently on.
		if (path === '/api/mcp' && req.method === 'GET') {
			const cfg = await readMcpFile();
			let status = [];
			const rt = anyRuntime();
			if (rt?.q?.mcpServerStatus) { try { status = await rt.q.mcpServerStatus(); } catch (e) { log('mcpServerStatus failed', e?.message); } }
			return json(res, { ok: true, servers: cfg.servers || {}, status });
		}
		if (path === '/api/mcp/add' && req.method === 'POST') {
			const s = await body(req);
			const name = String(s.name || '').trim();
			if (!name || /[^\w.-]/.test(name)) return json(res, { ok: false, error: '名称只能用字母数字 . _ -' }, 400);
			if (!['http', 'sse', 'stdio'].includes(s.type)) return json(res, { ok: false, error: '类型须为 http/sse/stdio' }, 400);
			if ((s.type === 'http' || s.type === 'sse') && !/^https?:\/\//.test(s.url || '')) return json(res, { ok: false, error: '需要有效 URL' }, 400);
			if (s.type === 'stdio' && !s.command) return json(res, { ok: false, error: '需要命令' }, 400);
			const cfg = await readMcpFile();
			cfg.servers = cfg.servers || {};
			cfg.servers[name] = { type: s.type, url: s.url, bearer: s.bearer, command: s.command, args: s.args, env: s.env, disabled: false };
			await writeMcpFile(cfg);
			await applyMcpToAllRuntimes();
			broadcast({ type: 'mcp_updated' });
			return json(res, { ok: true });
		}
		if (path === '/api/mcp/toggle' && req.method === 'POST') {
			const { name, enabled } = await body(req);
			const cfg = await readMcpFile();
			if (!cfg.servers?.[name]) return json(res, { ok: false, error: 'not found' }, 404);
			cfg.servers[name].disabled = !enabled;
			await writeMcpFile(cfg);
			await applyMcpToAllRuntimes();
			broadcast({ type: 'mcp_updated' });
			return json(res, { ok: true });
		}
		if (path === '/api/mcp/remove' && req.method === 'POST') {
			const { name } = await body(req);
			const cfg = await readMcpFile();
			if (cfg.servers) delete cfg.servers[name];
			await writeMcpFile(cfg);
			await applyMcpToAllRuntimes();
			broadcast({ type: 'mcp_updated' });
			return json(res, { ok: true });
		}
		if (path === '/api/mcp/reconnect' && req.method === 'POST') {
			const { name } = await body(req);
			const rt = anyRuntime();
			if (!rt?.q?.reconnectMcpServer) return json(res, { ok: false, error: '还没有进行中的对话，先发一条消息再重连' }, 400);
			try { await rt.q.reconnectMcpServer(name); return json(res, { ok: true }); }
			catch (e) { return json(res, { ok: false, error: e?.message }, 500); }
		}

		// ---- Slash commands (for the composer's "/" autocomplete) ----
		// Keyed by sessionId because skills (which can add commands) are reloaded per-runtime; falls
		// back to any live runtime, or a conversation that hasn't sent a message yet gets the static list.
		if (path === '/api/commands' && req.method === 'GET') {
			const sid = url.searchParams.get('sessionId') || activeSessionId;
			const rt = (sid && runtimes.get(sid)) || anyRuntime();
			if (!rt?.q?.supportedCommands) return json(res, { ok: true, commands: STATIC_SLASH_COMMANDS });
			try { return json(res, { ok: true, commands: await rt.q.supportedCommands() }); }
			catch (e) { return json(res, { ok: true, commands: STATIC_SLASH_COMMANDS, error: e?.message }); }
		}

		// ---- Usage / quota (experimental SDK API) ----
		// Borrows an already-running conversation's process rather than spinning up a hidden one
		// just to check a number — if nothing is running yet, say so instead of starting a ghost chat.
		if (path === '/api/usage' && req.method === 'GET') {
			const fresh = url.searchParams.get('fresh') === '1';
			if (!fresh && usageCache.data && Date.now() - usageCache.t < 60000) return json(res, { ok: true, ...usageCache.data });
			let plan;
			try { plan = await fetchPlanUsage(); } catch (e) { plan = { ok: false, error: `读取用量失败：${e?.message || e}` }; }
			// The SDK's own call (newer SDKs only) adds this conversation's cost, and stands in for
			// the direct call if that failed.
			const rt = anyRuntime();
			const fn = rt?.q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
			let sdkUsage = null;
			if (typeof fn === 'function') { try { sdkUsage = await fn.call(rt.q, { skipBehaviors: true }); } catch { /* */ } }
			const cost = sdkUsage?.session?.total_cost_usd ?? sdkUsage?.total_cost_usd ?? null;
			let data;
			if (plan.ok) data = { rate_limits_available: true, rate_limits: plan.rate_limits, subscription_type: plan.subscription_type, cost };
			else if (sdkUsage) data = { rate_limits_available: sdkUsage.rate_limits_available, rate_limits: sdkUsage.rate_limits || null, cost };
			else return json(res, { ok: false, error: plan.error });
			usageCache = { t: Date.now(), data };
			return json(res, { ok: true, ...data });
		}

		// Legacy new chat endpoint
		if (req.method === 'POST' && path === '/api/new') {
			const newSess = await createNewSession('新对话');
			activeSessionId = newSess.id;
			broadcast({ type: 'session_switched', session: newSess });
			const idx = await loadSessionsIndex();
			broadcast({ type: 'sessions_updated', sessions: idx });
			return json(res, { ok: true, session: newSess });
		}

		if (path === '/api/status') {
			return json(res, { settings, loggedIn: await isLoggedIn(), running: [...runtimes.values()].some((rt) => rt.running) });
		}

		// Login flow
		if (req.method === 'POST' && path === '/api/login/start') { startLogin().catch((e) => log('[login]', e?.message)); return json(res, { ok: true }); }
		if (req.method === 'POST' && path === '/api/login/code') {
			const { code } = await body(req);
			const ok = sendLoginCode(code);
			log('[login-code-received]', ok ? 'sent to pty' : 'login session expired', (code || '').slice(0, 15) + '...');
			return json(res, { ok, error: ok ? '' : '登录会话已超时失效，请重新点击「开始登录」' });
		}
		if (req.method === 'POST' && path === '/api/login/cancel') { cancelLogin(); return json(res, { ok: true }); }

		// ---- Self-update ----
		if (path === '/api/update' && req.method === 'GET') return json(res, { ok: true, update: updateInfo() });
		if (path === '/api/update/check' && req.method === 'POST') {
			const { install } = await body(req);
			await checkUpdate({ install: !!install, now: true });
			return json(res, { ok: !update.error, update: updateInfo(), error: update.error });
		}

		// ---- Which program runs Claude Code here (diagnostics) ----
		if (path === '/api/runtime' && req.method === 'GET') {
			const r = await claudeRuntime();
			return json(res, { ok: !!r.chat, chat: r.chat ? { label: r.chat.label, version: r.chat.version, env: r.chat.env } : null, tried: r.tried });
		}

		// ---- Network proxy ----
		if (path === '/api/netcheck' && req.method === 'GET') {
			const proxy = readProxySetting();
			const c = await checkAnthropic(proxy || null);
			return json(res, { ok: c.ok, proxy, summary: c.summary, localProxy: c.ok ? null : await findLocalProxy(proxy) });
		}
		if (path === '/api/proxy' && req.method === 'GET') return json(res, { ok: true, proxy: readProxySetting() });
		if (path === '/api/proxy' && req.method === 'POST') {
			const proxy = String((await body(req)).proxy || '').trim();
			if (!validProxy(proxy)) return json(res, { ok: false, error: '格式应为 http://主机:端口，例如 http://127.0.0.1:7890' }, 400);
			await saveProxySetting(proxy);
			log('[proxy]', proxy || '(none)');
			const check = await checkAnthropic(proxy || null);
			return json(res, { ok: true, proxy, reachable: check.ok, summary: check.summary });
		}

		// ---- Account (everything `claude auth status` knows) ----
		if (path === '/api/account' && req.method === 'GET') {
			const s = await getAuthStatus();
			if (!s?.loggedIn) return json(res, { ok: false, error: '未登录' });
			// What this login is allowed to do, straight from the stored credentials.
			const o = readOauth();
			return json(res, { ok: true, account: { ...s, scopes: o?.scopes || null, subscriptionType: s.subscriptionType ?? o?.subscriptionType ?? null } });
		}
		if (path === '/api/account/logout' && req.method === 'POST') {
			const spec = (await claudeRuntime()).auth;
			if (spec) await new Promise((resolve) => {
				const c = runClaude(spec, ['auth', 'logout']);
				const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* */ } resolve(); }, 15000);
				c.on('exit', () => { clearTimeout(t); resolve(); });
				c.on('error', () => { clearTimeout(t); resolve(); });
			});
			broadcast({ type: 'auth', loggedIn: false });
			return json(res, { ok: true });
		}

		// ---- Fonts (fetched slice by slice on first use, then served from disk) ----
		const fm = path.match(/^\/fonts\/([a-z0-9-]+)\/(.+)$/);
		if (fm && req.method === 'GET') {
			try {
				const file = await fontFile(fm[1], decodeURIComponent(fm[2]));
				if (!file) { res.writeHead(404); return res.end(); }
				res.writeHead(200, { 'content-type': MIME[extname(file)] || (file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream'), 'cache-control': 'public, max-age=31536000, immutable' });
				return res.end(await readFile(file));
			} catch (e) {
				log('[fonts]', fm[1], fm[2], e?.message);
				res.writeHead(502); return res.end();
			}
		}

		// ---- Chat background ----
		if (path === '/api/background' && req.method === 'GET') {
			try {
				const data = await readFile(BG_FILE);
				const type = data[0] === 0x89 ? 'image/png' : data[0] === 0x52 ? 'image/webp' : data[0] === 0x47 ? 'image/gif' : 'image/jpeg';
				res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
				return res.end(data);
			} catch { res.writeHead(404); return res.end(); }
		}
		if (path === '/api/background' && req.method === 'POST') {
			const { dataUrl } = await body(req);
			const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/.exec(String(dataUrl || ''));
			if (!m) return json(res, { ok: false, error: '只支持 PNG / JPG / WebP / GIF 图片' }, 400);
			const buf = Buffer.from(m[2], 'base64');
			if (buf.length > 12e6) return json(res, { ok: false, error: '图片太大（超过 12 MB）' }, 400);
			await mkdir(dirname(BG_FILE), { recursive: true });
			await writeFile(BG_FILE, buf);
			return json(res, { ok: true, v: Date.now() });
		}
		if (path === '/api/background/clear' && req.method === 'POST') {
			await rm(BG_FILE, { force: true });
			return json(res, { ok: true });
		}

		return serveStatic(req, res);
	} catch (e) {
		log('http error', e?.message || e);
		if (!res.headersSent) json(res, { ok: false, error: String(e?.message || e) }, 500);
	}
});

await initSessions();
await seedBuiltinSkills().catch((e) => log('[skills] seeding failed', e?.message));
server.listen(PORT, HOST, () => {
	log(`agent app on http://${HOST}:${PORT}  cwd=${CWD}`);
	claudeRuntime().catch((e) => log('[runtime] probe failed', e?.message)); // find a working claude before anyone asks
	if (!process.env.DROIDAGENT_NO_UPDATE) scheduleUpdateCheck(2 * 60e3); // let startup settle first
});
