// DroidAgent's backend: serves the chat UI and runs each conversation on one of two agents —
// official Claude Code (via the Agent SDK) or Google's Antigravity CLI (`agy`). What differs
// between them lives in backends/; everything here (sessions, queues, confirmation cards, the
// permission policy, settings, the extension market) is the same for both.
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { request as httpsRequest } from 'node:https';
import { spawn, exec, execFile } from 'node:child_process';
import { readFile, writeFile, stat, lstat, mkdir, readdir, unlink, realpath, rm, rename, open, cp } from 'node:fs/promises';
import { readFileSync, existsSync, createReadStream, createWriteStream } from 'node:fs';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import {
	OFFICIAL_MARKETPLACES, safeId, parseSkillSource, normalizeMarketplaceSource, isPluginId, parseFrontmatter, validateSkillText,
	findSkillRoots, findEscapingSymlinks, mergePlugins, normalizeRegistry, connectorName, buildMcpEntry, parseGithubRepo, inspectPluginDir,
	inspectSkillDir, mergeSlashCommands, OFFICIAL_NAMES, COMPAT_MARKETPLACE, COMPAT_OF, compatibleMarketplace,
} from './market.mjs';
import { isReadOnlyBash } from './policy.mjs';
import { AGY_PREFIX, BACKEND_NAMES, backendOf, agySlug } from './backends/common.mjs';
import { createClaudeBackend, thinkingFor } from './backends/claude.mjs';
import { createAgyBackend, usageGroupFor, BRIDGE_SERVER } from './backends/antigravity.mjs';
import { enabledClaudePlugins, claudePluginsForAgy, agyPluginsForClaude } from './backends/shared_plugins.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', 'web');
const HOST = process.env.AGENT_HOST || '127.0.0.1';
const PORT = parseInt(process.env.AGENT_PORT || '8787', 10);
const CWD = process.env.AGENT_CWD || '/root';

// Never let an API key leak in — this app runs on the subscription login only.
delete process.env.ANTHROPIC_API_KEY;
// A private repository must fail, not sit waiting for a password nobody can type.
process.env.GIT_TERMINAL_PROMPT = '0';

// Login is done via `claude auth login` (see login_pty.py), which saves credentials into
// claude's own native store under this same $HOME — nothing to read or inject here. Do NOT set
// CLAUDE_CODE_OAUTH_TOKEN: that env var, if present, overrides the native store and would force
// use of a narrower-scoped token instead of whatever auth login actually negotiated.
const LEGACY_TOKEN_FILE = join(homedir(), '.claude', 'agent-oauth-token'); // from the old setup-token flow
unlink(LEGACY_TOKEN_FILE).catch(() => {}); // narrower-scoped and unused now; fine if it was never there


const log = (...a) => console.log(new Date().toISOString(), ...a);

// One stray error (a promise nobody awaited, a socket error with no listener) must not take
// down every conversation on the phone. Record it with its stack and keep serving; the launcher
// still restarts the service if it ever does exit.
process.on('unhandledRejection', (e) => log('[bug] unhandled rejection:', e?.stack || e));
process.on('uncaughtException', (e) => log('[bug] uncaught exception:', e?.stack || e));

// ---------------------------------------------------------------- settings & persistence
const SETTINGS_FILE = join(homedir(), '.claude', 'agent-settings.json');
const settings = {
	model: 'sonnet',          // opus | sonnet | haiku | fable | etc.; "agy:<slug>" is one of Antigravity's
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
// A disabled skill is moved here, where Claude Code doesn't look. The SDK's `skills` filter can't
// do this job: Claude Code 2.1.112 has no such option, and it would also hide plugin skills.
const SKILLS_OFF_DIR = join(homedir(), '.claude', 'skills-disabled');
const SKILL_DRAFTS_DIR = join(homedir(), '.claude', 'skill-drafts');
const SKILLS_STATE_FILE = join(homedir(), '.claude', 'agent-skills.json');
const MCP_FILE = join(homedir(), '.claude', 'agent-mcp.json');
// The assistant's own notes, kept across conversations: how tools turned out to work, what an error
// meant, what this phone does differently. Outside ~/.claude so writing it needs no confirmation
// from Claude Code itself; the policy below lets it through in every mode.
const MEMORY_FILE = join(homedir(), '.droidagent', 'memory.md');
const MEMORY_MAX = 16000;

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
	if (sessionCache.has(id)) {
		const s = sessionCache.get(id);
		Object.defineProperty(s, 'lastUsed', { value: Date.now(), writable: true, enumerable: false, configurable: true });
		return s;
	}
	const loaded = await loadSession(id);
	if (loaded) {
		markInterrupted(loaded);
		Object.defineProperty(loaded, 'lastUsed', { value: Date.now(), writable: true, enumerable: false, configurable: true });
		sessionCache.set(id, loaded);
	}
	return loaded;
}

// A conversation read from disk has no live turn (a running one is always in the cache), so a
// step still marked running, or a confirmation never answered, was cut off when the service
// stopped. Say so instead of leaving a spinner that never ends.
function markInterrupted(sess) {
	let changed = false;
	for (const m of sess.messages || []) {
		if (m.role === 'tool' && m.state === 'running' && m.kind !== 'todo') {
			m.state = 'err'; m.ok = false; m.summary = (m.summary ? m.summary + '\n' : '') + '（服务中途重启，这一步没有完成）'; changed = true;
		} else if (m.role === 'perm' && !m.verdict) { m.verdict = 'expired'; changed = true; }
	}
	if (changed) saveSession(sess);
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
//
// Writes of one file run one at a time. A turn saves its conversation on every event, often
// several in the same instant (parallel tool calls, an answered confirmation): two writes
// sharing the temp file made the second rename fail with ENOENT, and as nobody awaited those
// saves, the rejection took the whole service down mid-conversation.
const fileLocks = new Map(); // key -> tail of its queue
function withLock(key, fn) {
	const prev = fileLocks.get(key) || Promise.resolve();
	const run = prev.catch(() => {}).then(fn);
	const tail = run.catch(() => {});
	fileLocks.set(key, tail);
	tail.then(() => { if (fileLocks.get(key) === tail) fileLocks.delete(key); });
	return run;
}
let tmpSeq = 0;
function writeJsonAtomic(path, value) {
	return withLock(path, async () => {
		const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`;
		const fh = await open(tmp, 'w');
		try {
			await fh.writeFile(JSON.stringify(value, null, 2), 'utf8'); // serialized now, so the newest state
			await fh.sync();
		} finally {
			await fh.close();
		}
		try { await rename(tmp, path); } catch (e) { await rm(tmp, { force: true }).catch(() => {}); throw e; }
	});
}

// What the owner typed: attachments go to Claude wrapped in a block of their own.
const typedText = (t) => String(t || '').replace(/^【指定操作范围与上下文】[\s\S]*?【用户指令】\n?/, '');

function sessionMeta(sess) {
	const lastMsg = sess.messages?.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-1)[0];
	return {
		id: sess.id,
		title: sess.title || '新对话',
		pinned: !!sess.pinned,
		createdAt: sess.createdAt,
		updatedAt: sess.updatedAt,
		claudeSessionId: sess.claudeSessionId || null,
		backend: sess.backend || 'claude',
		msgCount: sess.messages?.length || 0,
		preview: lastMsg?.text ? typedText(lastMsg.text).replace(/\n+/g, ' ').slice(0, 60) : '',
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

async function loadSessionsIndex({ verify = true } = {}) {
	await ensureSessionsDir();
	let list = null;
	try {
		list = JSON.parse(await readFile(SESSIONS_INDEX, 'utf8'));
	} catch { /* missing or corrupt — fall through to the rebuild below */ }
	if (!Array.isArray(list)) return rebuildSessionsIndex();
	if (!verify) return list;
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

// Called fire-and-forget from the turn loop, so it must never reject: a failed save is logged,
// the conversation keeps going (it is still in memory, and the next event saves it again).
async function saveSession(sess) {
	if (!sess || !sess.id) return;
	try {
		await ensureSessionsDir();
		sess.updatedAt = Date.now();
		await writeJsonAtomic(join(SESSIONS_DIR, `${sess.id}.json`), sess);
		// Read-modify-write of the shared index: one at a time, or two conversations saving
		// together would each write back an index missing the other's change.
		await withLock('sessions-index', async () => {
			// A new conversation's file is on disk by now and about to join the index: checking the
			// two against each other here would read every conversation back for each new one.
			const idx = await loadSessionsIndex({ verify: false });
			const existing = idx.findIndex((s) => s.id === sess.id);
			const meta = sessionMeta(sess);
			if (existing >= 0) idx[existing] = meta;
			else idx.unshift(meta);
			await saveSessionsIndex(idx);
		});
	} catch (e) {
		log('[sessions] save failed', sess.id, e?.message || e);
	}
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

// A conversation nothing was ever said in (nor pinned or renamed) is just a fresh page.
const isBlank = (s) => !!s && !(s.messages || []).length && !s.pinned && (s.title || '新对话') === '新对话';
const blankMeta = (m) => m && m.msgCount === 0 && !m.pinned && (m.title || '新对话') === '新对话';

// "New conversation" while already looking at a blank one, or with a blank one left over, reuses
// it instead of piling up empty conversations.
async function freshSession() {
	const cur = activeSessionId ? await getOrLoadSessionObj(activeSessionId) : null;
	if (isBlank(cur)) return cur;
	for (const m of await loadSessionsIndex()) {
		if (!blankMeta(m) || runtimes.get(m.id)?.running) continue;
		const s = await getOrLoadSessionObj(m.id);
		if (isBlank(s)) return s;
	}
	return createNewSession('新对话');
}

async function initSessions() {
	await ensureSessionsDir();
	const idx = await loadSessionsIndex();
	if (idx.length > 0) {
		const sorted = [...idx].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
		const sess = await getOrLoadSessionObj(sorted[0].id);
		if (sess) {
			activeSessionId = sess.id;
			await pruneBlankSessions();
			return;
		}
	}
	const sess = await createNewSession('新对话');
	activeSessionId = sess.id;
}

// Earlier versions made a new empty conversation on every tap of "new"; drop those (all but the
// one on screen), they hold nothing.
async function pruneBlankSessions() {
	const idx = await loadSessionsIndex();
	const drop = [];
	for (const m of idx) {
		if (m.id === activeSessionId || !blankMeta(m)) continue;
		if (isBlank(await loadSession(m.id))) drop.push(m.id);
	}
	if (!drop.length) return;
	for (const id of drop) { sessionCache.delete(id); await unlink(join(SESSIONS_DIR, `${id}.json`)).catch(() => {}); }
	await withLock('sessions-index', async () => saveSessionsIndex((await loadSessionsIndex()).filter((m) => !drop.includes(m.id))));
	log(`[sessions] removed ${drop.length} empty conversations`);
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
	WebSearch: '联网搜索', WebFetch: '打开网页',
	Task: '子任务', Agent: '子任务', TodoWrite: '更新待办', ExitPlanMode: '提交计划', Skill: '使用技能',
	AskUserQuestion: '向你提问',
};
// What kind of step it is, shown small next to the plain-language title.
function toolCategory(name) {
	if (name === 'Bash' || name === 'BashOutput' || name === 'KillShell') return '命令';
	if (/^(Read|NotebookRead|LS)$/.test(name)) return '读取';
	if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) return '修改文件';
	if (/^(Glob|Grep)$/.test(name)) return '查找';
	if (/^(WebSearch|WebFetch)$/.test(name)) return '联网';
	if (name === 'Skill') return '技能';
	if (name === 'Task' || name === 'Agent') return '子任务';
	if (String(name).startsWith('mcp__')) return 'MCP';
	return '工具';
}

// Plain-language names for the commands this agent runs most; the model's own description of a
// command (asked for in Chinese, see APP_PROMPT) comes first.
const BASH_WORDS = [
	[/^droid\s+(shot|screencap)/, '截取手机屏幕'], [/^droid\s+ui/, '读取屏幕上的控件'], [/^droid\s+tap/, '点击屏幕'],
	[/^droid\s+(swipe|scroll)/, '滑动屏幕'], [/^droid\s+(text|key)/, '输入文字'], [/^droid\s+app/, '打开应用'], [/^droid\b/, '操作屏幕'],
	[/^pdata\s+sms/, '读取短信'], [/^pdata\s+(contacts?|people)/, '读取通讯录'], [/^pdata\s+(calls?|calllog)/, '读取通话记录'],
	[/^pdata\s+(photos?|media|images?)/, '读取相册'], [/^pdata\b/, '读取个人数据'], [/^clip\b/, '读写剪贴板'],
	[/^dumpsys\s+battery/, '查看电池状态'], [/^dumpsys\s+(batterystats|power)/, '查看耗电情况'], [/^dumpsys\s+(meminfo|procstats)/, '查看内存占用'],
	[/^dumpsys\s+(wifi|connectivity|netstats)/, '查看网络状态'], [/^dumpsys\s+package/, '查看应用信息'], [/^dumpsys\b/, '读取系统服务信息'],
	[/\/sys\/class\/(thermal|power_supply)|thermal_zone/, '读取温度'], [/\/proc\/meminfo|\bfree\b/, '查看内存'], [/\/proc\/cpuinfo|\/sys\/devices\/system\/cpu/, '查看 CPU 信息'],
	[/^df\b/, '查看存储空间'], [/^du\b/, '统计文件夹大小'], [/^(ls|tree)\b/, '列出文件'], [/^(cat|head|tail|less|more)\b/, '查看文件内容'],
	[/^(grep|rg|egrep)\b/, '搜索文本'], [/^find\b/, '查找文件'], [/^pm\s+list\s+packages/, '列出已安装的应用'], [/^pm\s+(uninstall|disable)/, '卸载或停用应用'],
	[/^pm\s+(clear)/, '清除应用数据'], [/^pm\b|^cmd\s+package/, '管理应用'], [/^am\s+(start|broadcast)/, '打开应用页面'], [/^am\s+(force-stop|kill)/, '停止应用'],
	[/^getprop\b/, '读取系统属性'], [/^settings\s+get/, '读取系统设置'], [/^settings\s+put/, '修改系统设置'], [/^logcat\b/, '读取系统日志'],
	[/^(ps|top|pgrep)\b/, '查看运行中的进程'], [/^(kill|pkill|killall)\b/, '结束进程'], [/^ping\b/, '测试网络连通'], [/^(curl|wget)\b/, '访问网址'],
	[/^(ip|ifconfig|netstat|ss)\b/, '查看网络连接'], [/^(nslookup|dig|host)\b/, '查询域名'], [/^rm\b/, '删除文件'], [/^mv\b/, '移动文件'], [/^cp\b/, '复制文件'],
	[/^mkdir\b/, '新建文件夹'], [/^(tar|unzip|zip|gzip|7z)\b/, '打包或解压'], [/^(python3?|node|bash|sh)\b/, '运行脚本'], [/^(apt|apt-get|pip3?|npm)\b/, '安装软件'],
	[/^(aapt2?|apktool|jadx|unzip\s.*\.apk)\b/, '分析安装包'], [/^(stat|file|md5sum|sha256sum)\b/, '查看文件信息'], [/^(uptime|uname|date)\b/, '查看系统信息'],
	[/^(for|while)\b/, '批量执行'], [/^(echo|printf)\b/, '输出信息'], [/^(reboot|svc\s+power)/, '重启手机'],
];
function bashTitle(cmd, description) {
	const d = String(description || '').trim();
	if (d) return d.length > 40 ? d.slice(0, 39) + '…' : d;
	let c = String(cmd || '').trim();
	if (!c) return '运行命令';
	c = c.replace(/^(cd\s+\S+\s*(&&|;)\s*)+/, '').replace(/^(sudo|su\s+-c|env(\s+\w+=\S+)*)\s+/, '').replace(/^ashell\s+(-c\s+)?["']?/, '');
	for (const [re, label] of BASH_WORDS) if (re.test(c)) return label;
	return '执行命令';
}

// Installed skills by id -> their readable name ("手机体检"), for "使用技能「…」" step titles.
const skillNames = new Map();
async function refreshSkillNames() {
	try {
		for (const sk of await listSkills()) {
			const m = /^([^。.]{2,10})[。.]/.exec(sk.description || '');
			skillNames.set(sk.id, m ? m[1] : sk.name);
			skillNames.set(sk.name, m ? m[1] : sk.name); // Claude calls a skill by this one
		}
	} catch { /* keep the old names */ }
}

function toolTitle(name, input) {
	if (name === 'Bash') return bashTitle(input?.command, input?.description);
	if (name === 'Write') return `新建或覆盖 ${base(readPath(input))}`;
	if (/^(Edit|MultiEdit|NotebookEdit)$/.test(name)) return `修改 ${base(readPath(input))}`;
	if (name === 'Read' || name === 'NotebookRead') return `查看 ${base(readPath(input))}`;
	if (name === 'LS') return `列出 ${base(readPath(input)) || '目录'} 里的文件`;
	if (name === 'Glob') return `查找文件 ${input?.pattern || ''}`.trim();
	if (name === 'Grep') return `在文件里搜索「${String(input?.pattern || '').slice(0, 24)}」`;
	if (name === 'WebSearch') return `上网搜索「${String(input?.query || '').slice(0, 30)}」`;
	if (name === 'WebFetch') { try { return `打开网页 ${new URL(input?.url).hostname}`; } catch { return '打开网页'; } }
	if (name === 'TodoWrite') return '更新待办清单';
	if (name === `mcp__${BRIDGE_SERVER}__remember`) return '记一条经验笔记';
	if (name === 'Skill') {
		const id = String(input?.skill || input?.command || input?.name || '').replace(/^\//, '');
		return `使用技能「${skillNames.get(id) || id || '技能'}」`;
	}
	if (name === 'Task' || name === 'Agent') return input?.description ? `子任务：${input.description}` : '派出子任务';
	if (String(name).startsWith('mcp__')) { const [, srv, tool] = String(name).split('__'); return `调用 ${srv} 的 ${tool || '工具'}`; }
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
	// Its own notes: written in every mode, Plan included, so a lesson is never lost to a prompt.
	if (isWrite && target && normalize(target) === MEMORY_FILE) return allow(title, detail);

	// Leaving Plan mode means "go ahead with this plan" — always the owner's call.
	if (name === 'ExitPlanMode') return ask('计划已就绪', '按这个计划开始执行？', String(input?.plan || ''));

	const personal = name === 'Bash' && PERSONAL_DATA.test(cmd);
	const readOnlyCmd = name === 'Bash' && isReadOnlyBash(cmd) && !DANGER.test(cmd) && !DANGER_ANDROID.test(cmd) && !CATASTROPHIC.test(cmd);
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

// A control message to a conversation that may already be on its way out: no reply is an answer too.
function tell(fn) {
	try { Promise.resolve(fn()).catch((e) => log('[runtime] control message:', e?.message)); } catch { /* gone */ }
}

function teardownRuntime(id) {
	const rt = runtimes.get(id);
	if (!rt) return;
	try { rt.end(); } catch { /* already done */ }
	tell(() => rt.q?.interrupt?.());
	killBridgeJobs(rt);
	for (const [, p] of rt.pending) p.resolve({ behavior: 'deny', message: '会话已重置', interrupt: false });
	runtimes.delete(id);
}

// A setting a running process can't take in: it applies from the next message, which starts a new
// process that resumes the same conversation (invisible to the owner). A busy one finishes first.
function restartRuntimesWhenIdle() {
	for (const rt of runtimes.values()) rt.restartWhenIdle = true;
}

// Messages sent during a turn wait here, in the owner's sight, until it ends. They join the
// conversation only when they go out, so it reads in the order things happened. Kept in memory: an
// update waits for quiet, so only a crash of this server can lose them.
const queues = new Map(); // conversation id -> [{ id, text, scopes }]
const heldQueues = new Set(); // Stop was pressed: what waits doesn't start by itself
const delivering = new Set(); // a message on its way out, its runtime possibly still starting

function broadcastQueue(id) {
	broadcast({ type: 'queue', sessionId: id, queue: queues.get(id) || [], held: heldQueues.has(id) });
}
function forgetQueue(id) {
	queues.delete(id);
	heldQueues.delete(id);
}

// One user message into its conversation and on to Claude Code.
let lastWorkedId = null; // what the floating panel shows once nothing runs any more
async function deliverMessage(id, { text, scopes = [] }, { fromQueue = false } = {}) {
	delivering.add(id);
	lastWorkedId = id;
	try {
		const sess = await getOrLoadSessionObj(id);
		if (!sess) throw new Error('session not found: ' + id);
		// Format title from first message
		if (sess.messages.length === 0 || sess.title === '新对话') sess.title = autoTitleOf(text);
		sess.messages.push({ role: 'user', text, scopes, time: Date.now() });
		await saveSession(sess);
		const rt = await ensureRuntime(id);
		rt.since = Date.now();
		rt.label = '正在思考';
		rt.running = true;
		rt.lastActive = Date.now();
		broadcast({ type: 'user_echo', sessionId: id, text, session: sess, ...(fromQueue ? { fromQueue: true } : {}) });
		rt.pushUser(text);
	} finally {
		delivering.delete(id);
	}
}

// The turn is over: the next in line goes out.
function drainQueue(id) {
	const q = queues.get(id);
	if (!q?.length || heldQueues.has(id) || delivering.has(id) || runtimes.get(id)?.running) return;
	const item = q.shift();
	if (!q.length) queues.delete(id);
	broadcastQueue(id);
	deliverMessage(id, item, { fromQueue: true }).catch((e) => {
		// Back in line, and it stays there: retrying by itself could go on for ever.
		log('[queue] could not send', id.slice(0, 8), e?.message);
		queues.set(id, [item, ...(queues.get(id) || [])]);
		heldQueues.add(id);
		broadcastQueue(id);
		broadcast({ type: 'error', sessionId: id, message: `排队的消息没能发出：${e?.message || e}` });
	});
}

// Ends the turn in progress and any confirmation it is waiting on.
function interruptTurn(id) {
	const rt = runtimes.get(id);
	tell(() => rt?.q?.interrupt?.());
	killBridgeJobs(rt);
	for (const [permId, p] of rt?.pending || []) {
		p.resolve({ behavior: 'deny', message: '用户已停止', interrupt: true });
		closePermission(id, permId, 'stop');
	}
}

// A conversation as the page needs it, with what `messages` doesn't hold yet: the reply or thinking
// still being written (without it a page opened midway loses everything so far), and what waits.
function forPage(sess) {
	if (!sess) return sess;
	const rt = runtimes.get(sess.id);
	const extra = {};
	if (rt?.assistantText) extra.liveText = rt.assistantText;
	if (rt?.thinking?.text) extra.liveThinking = rt.thinking.text;
	if (queues.get(sess.id)?.length) { extra.queue = queues.get(sess.id); extra.queueHeld = heldQueues.has(sess.id); }
	return Object.keys(extra).length ? { ...sess, ...extra } : sess;
}

// Closes a confirmation card, here and in the saved conversation, whoever answered it.
function closePermission(sessionId, permId, decision) {
	const sess = sessionId && sessionCache.get(sessionId);
	const pm = sess?.messages.find((x) => x.role === 'perm' && x.id === permId);
	if (pm) {
		pm.verdict = decision;
		saveSession(sess);
	}
	broadcast({ type: 'permission_resolved', sessionId, id: permId, decision });
}

// Claude Code deletes its transcripts after 30 days, while the App keeps the conversation. Asking it
// to resume one that is gone ends every message with an error, so that conversation could never
// be used again.
async function transcriptExists(claudeSessionId) {
	const root = join(homedir(), '.claude', 'projects');
	for (const dir of await dirNames(root)) if (existsSync(join(root, dir, `${claudeSessionId}.jsonl`))) return true;
	return false;
}

// A finished conversation's `claude` process (and the connectors it started) is let go once it has
// sat idle a while: its history and `claudeSessionId` stay on disk, and the next message resumes it
// in a new process, a few seconds' start. The one on screen is kept longer, as the owner is likely
// to go on with it; others go soon; and only a couple of idle ones are ever kept at all.
const IDLE_ON_SCREEN_MS = Number(process.env.AGENT_IDLE_ON_SCREEN_MS) || 10 * 60 * 1000;
const IDLE_OTHER_MS = Number(process.env.AGENT_IDLE_OTHER_MS) || 3 * 60 * 1000;
const IDLE_KEEP = 2;
const isIdle = (id, rt) => !rt.running && rt.pending.size === 0 && !delivering.has(id) && !queues.get(id)?.length;
function reapIdle() {
	const now = Date.now();
	const idle = [...runtimes.entries()].filter(([id, rt]) => isIdle(id, rt)).sort(([, a], [, b]) => b.lastActive - a.lastActive);
	idle.forEach(([id, rt], i) => {
		const limit = id === activeSessionId ? IDLE_ON_SCREEN_MS : IDLE_OTHER_MS;
		if (i >= IDLE_KEEP || now - rt.lastActive > limit) {
			log('idle-reap', id.slice(0, 8), i >= IDLE_KEEP ? '(too many idle)' : `(idle ${Math.round((now - rt.lastActive) / 1000)}s)`);
			teardownRuntime(id);
		}
	});
	// A conversation nobody has open or running needn't stay in memory: it is all on disk.
	for (const [id, sess] of sessionCache) {
		if (id === activeSessionId || runtimes.has(id) || delivering.has(id) || queues.has(id) || titling.has(id)) continue;
		if (now - (sess.lastUsed || 0) > 10 * 60 * 1000) sessionCache.delete(id);
	}
}
setInterval(reapIdle, Math.min(30000, IDLE_OTHER_MS / 2)).unref();

// ---- Eta-parity config loaders (system prompt / skills / MCP) ----
// Always appended: the person watching reads the steps, mostly not command lines.
const APP_PROMPT = `## 在 DroidAgent App 里工作
- 用户在手机 App 里看着你的每一步，大多数人看不懂命令行。调用 Bash 工具时，description 参数一律用简体中文写一句短话（十个字左右），说清这一步在做什么，例如「查看电池温度」「统计下载文件夹大小」「打开微信」，不要把命令本身写进去。
- 用户用什么语言提问，就用什么语言回答。
- 安装技能时，SKILL.md 必须直接位于 \`~/.claude/skills/<技能名>/SKILL.md\`，放得更深就不会生效。不要把整个仓库克隆进这个目录：只放需要的那个技能目录，装好后删掉仓库。`;
// The notes, for either agent. `how` names the tool that adds one.
const notesPrompt = (how) => `## 经验笔记
你有一份跨对话保留的经验笔记：\`${MEMORY_FILE}\`。它现在的内容附在下面「你的经验笔记」里。
- 动手前先看笔记。有现成的做法就直接照做，不要再去查用法或重新试错。
- 遇到这些情况，当场${how}，不用问用户：查过或试过才弄清的工具、命令用法；报错的原因和解决办法；这台手机、系统或某个应用的特殊之处；用户明确说过的偏好。
- 一条一行，以「- 」开头，写清什么情况下怎么做，例如「- 查电池温度：dumpsys battery 的 temperature 要除以 10」。
- 不记一次性的内容（这次任务的具体数据、临时文件名）。旧条目过时或写错了就改掉或删掉，不要重复记同一件事。
- 笔记保持在 150 条以内，接近时把相近的条目合并。`;
const NOTES_PROMPT = notesPrompt('用 Edit 或 Write 工具往笔记里加一条');

// Antigravity has no flag for a system prompt: this goes ahead of the first message of each of
// its conversations, with the phone's own instructions (written for Claude Code) and the notes.
const AGY_PROMPT = `# 你在 DroidAgent 里工作
你通过 Antigravity CLI 运行在一台已 Root 的 Android 手机上的 Debian 环境里，身份是真 root。用户在手机上的聊天 App「DroidAgent」里和你对话，看着你的每一步；大多数人看不懂命令行。
- 用户用什么语言提问，就用什么语言回答。
- 执行命令、操作手机，一律用 MCP 服务 \`${BRIDGE_SERVER}\` 的 \`shell\` 工具；写文件用它的 \`write_file\` 工具。它们会按用户选的执行模式自动放行，或者先在 App 里请用户确认。
- 你自带的命令和写文件工具在这里没法请用户确认，需要确认时会被直接拒绝。被拒绝后不要重复尝试，改用上面两个工具。
- 调用 \`shell\` 时，description 一律用简体中文写一句短话（十个字左右），说清这一步在做什么，例如「查看电池温度」「打开微信」，不要把命令本身写进去。
- 读文件优先用你自带的读取工具；读不了（比如文件不在工作目录里）就用 \`shell\` 执行 cat。
- 下面的「手机环境说明」原本是写给 Claude Code 的：里面说的 Bash 工具就是这里的 \`shell\`，Read 就是你自带的读取工具，形如 mcp__名字__工具 的是对应 MCP 服务的工具。
- 安装技能时，SKILL.md 放在 \`~/.claude/skills/<技能名>/SKILL.md\`，App 会把它同步给你。`;
const PHONE_GUIDE_FILE = join(homedir(), '.claude', 'CLAUDE.md');
function agyPreamble() {
	let guide = '';
	try { guide = readFileSync(PHONE_GUIDE_FILE, 'utf8').trim(); } catch { /* none on this phone */ }
	return [
		AGY_PROMPT,
		guide && `# 手机环境说明\n${guide}`,
		notesPrompt(`用 \`${BRIDGE_SERVER}\` 的 \`remember\` 工具往笔记里加一条（改写或删除旧条目用 \`write_file\` 重写整份笔记）`),
		loadMemory(),
		loadSystemPromptAppend(),
	].filter(Boolean).join('\n\n');
}
mkdir(dirname(MEMORY_FILE), { recursive: true }).catch(() => {});
function loadMemory() {
	let t = '';
	try { t = readFileSync(MEMORY_FILE, 'utf8').trim(); } catch { /* none yet */ }
	if (t.length > MEMORY_MAX) t = `${t.slice(0, MEMORY_MAX)}\n…（笔记太长，后面的没有附上：请合并条目，把它缩短）`;
	return `## 你的经验笔记\n${t || '（还是空的）'}`;
}

function loadSystemPromptAppend() {
	try {
		const t = readFileSync(SYSTEM_PROMPT_FILE, 'utf8').trim();
		return t || '';
	} catch { return ''; }
}

async function readSkillsState() {
	try { return JSON.parse(await readFile(SKILLS_STATE_FILE, 'utf8')); } catch { return { enabled: [] }; }
}

const dirNames = async (dir) => {
	try { return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
};

// List installed skills, with name/description from frontmatter. Where a skill sits says whether it is on.
async function listSkills() {
	const out = [];
	for (const [dir, enabled] of [[SKILLS_DIR, true], [SKILLS_OFF_DIR, false]]) {
		for (const id of await dirNames(dir)) {
			out.push({ ...(await inspectSkillDir(join(dir, id), id)), enabled, builtin: existsSync(join(dir, id, '.builtin')) });
		}
	}
	return out;
}

// Turn a skill on or off by moving its directory. A rename, so nothing is copied or deleted.
async function setSkillEnabled(id, enabled) {
	if (!safeId(id)) throw new Error('技能名称无效');
	const [from, to] = enabled ? [SKILLS_OFF_DIR, SKILLS_DIR] : [SKILLS_DIR, SKILLS_OFF_DIR];
	if (!existsSync(join(from, id))) return;
	if (existsSync(join(to, id))) throw new Error('已经有一个同名技能');
	await mkdir(to, { recursive: true });
	await rename(join(from, id), join(to, id));
}

// Once, on the first start of a version that moves directories: what the old enabled list had off
// goes to the disabled directory. An empty list meant no filter at all, so everything stays on.
async function migrateSkillState() {
	const state = await readSkillsState();
	if (state.dirsMigrated) return;
	if (state.enabled?.length) {
		for (const id of await dirNames(SKILLS_DIR)) {
			if (!state.enabled.includes(id) && safeId(id) && existsSync(join(SKILLS_DIR, id, 'SKILL.md'))) {
				await setSkillEnabled(id, false).catch((e) => log('[skills] migrate', id, e?.message));
			}
		}
	}
	state.dirsMigrated = true;
	await writeSkillsState(state);
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
	if (s.type === 'http' || s.type === 'sse') {
		const c = { type: s.type, url: s.url };
		const headers = { ...(s.headers || {}), ...(s.bearer ? { Authorization: `Bearer ${s.bearer}` } : {}) };
		if (Object.keys(headers).length) c.headers = headers;
		return c;
	}
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

const CLAUDE_CONNECTORS_URL = 'https://claude.ai/customize/connectors';
function withTimeout(promise, ms, message) {
	let timer;
	return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}
async function liveMcpStatus(rt) {
	if (!rt?.q?.mcpServerStatus) return [];
	try { return await withTimeout(rt.q.mcpServerStatus(), 20000, 'timeout'); }
	catch (e) { log('mcpServerStatus failed', e?.message); return []; }
}

// An existing runtime to borrow for account-level queries (MCP status, usage) that aren't tied
// to one specific conversation — prefer whichever one the screen is currently showing.
function anyRuntime() {
	return (activeSessionId && runtimes.get(activeSessionId)) || runtimes.values().next().value || null;
}

let usageCache = { t: 0, data: null };

// One start at a time per conversation: typing "/" and sending can both start one, and the slower
// start would replace the other in `runtimes` and leave its process running with nobody to reap it.
const runtimeStarts = new Map();
function ensureRuntime(id) {
	let start = runtimeStarts.get(id);
	if (!start) {
		start = startRuntime(id).finally(() => runtimeStarts.delete(id));
		runtimeStarts.set(id, start);
	}
	return start;
}

// What each agent calls a conversation, kept so the next process can pick it up again.
const REF_KEY = { claude: 'claudeSessionId', agy: 'agyConversationId' };

// A conversation goes on with whichever agent the chosen model belongs to. The two keep their
// own memory of it, so the one taking over is told nothing of what the other did: say so.
function noteBackendSwitch(sess, backend) {
	const prev = sess.backend || 'claude';
	if (prev !== backend && sess.messages.some((m) => m.role === 'assistant')) {
		const text = `从这里开始由 ${BACKEND_NAMES[backend]} 回答。${sess[REF_KEY[backend]] ? '它只记得自己之前参与的部分' : `它看不到前面由 ${BACKEND_NAMES[prev]} 完成的内容`}，上面的记录都还在，需要的话把要点再告诉它。`;
		sess.messages.push({ role: 'sys', text, time: Date.now() });
		broadcast({ type: 'notice', sessionId: sess.id, text });
	}
	if (sess.backend !== backend) { sess.backend = backend; saveSession(sess); }
}

async function startRuntime(id) {
	let rt = runtimes.get(id);
	const backend = backendOf(settings.model);
	// An idle process that cannot take a changed setting in, or that belongs to the other agent, is replaced.
	if (rt && !rt.running && rt.pending.size === 0 && (rt.restartWhenIdle || rt.backend !== backend)) { teardownRuntime(id); rt = null; }
	if (rt) return rt;
	await pluginGate; // a plugin being downloaded is enabled for a moment; don't start a session in that window
	const sess = await getOrLoadSessionObj(id);
	if (!sess) throw new Error('session not found: ' + id);
	noteBackendSwitch(sess, backend);
	if (backend === 'claude' && sess.claudeSessionId && !(await transcriptExists(sess.claudeSessionId))) {
		log('[sessions] transcript gone, starting over', id.slice(0, 8));
		sess.claudeSessionId = null;
		const text = '这段对话时间太久，Claude 已经不记得之前的内容了。上面的记录还在，接下来它会从头开始。';
		sess.messages.push({ role: 'sys', text, time: Date.now() });
		saveSession(sess);
		broadcast({ type: 'notice', sessionId: id, text });
	}

	// One decision per step, for either agent: allowed by the mode, refused by it, or put to the
	// owner as a card and held until answered.
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
		if (rt) rt.label = '等你确认';
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

	const tag = id.slice(0, 8);
	const handle = backend === 'agy'
		? agy.open({
			tag, cwd: CWD, settings, conversation: sess.agyConversationId || null,
			preamble: agyPreamble, prepareTurn: prepareAgy, turnEnv: () => ({ DROIDAGENT_SESSION: id }),
		})
		: await claude.open({
			tag, cwd: CWD, settings, resume: sess.claudeSessionId || null, canUseTool,
			systemAppend: [APP_PROMPT, NOTES_PROMPT, loadMemory(), loadSystemPromptAppend()].filter(Boolean).join('\n\n'),
			mcpServers: await loadMcpServers(),
			plugins: await agyPluginsForClaudeNow(),
		});

	rt = {
		pushUser: handle.send, end: handle.close, q: handle.control, pending, running: false, assistantText: '', lastActive: Date.now(),
		chatSpec: handle.spec, backend, canUseTool, jobs: new Set(),
	};
	runtimes.set(id, rt);
	const started = rt;
	consume(id, handle.events, started).then(() => {
		// Ended by itself, not by us: nothing would answer the next message sent to it.
		if (runtimes.get(id) !== started) return;
		if (started.running) broadcast({ type: 'error', sessionId: id, message: `${backend === 'agy' ? 'Antigravity' : 'Claude Code'} 意外退出了，再发一次就能继续` });
		teardownRuntime(id);
		drainQueue(id);
	}, (e) => {
		log('session error', id, e?.message || e);
		// A process stopped on purpose can fail on its way out, after the next one has taken over.
		// That is no news to anyone, and the new one must not go down with it.
		if (runtimes.get(id) !== started) return;
		broadcast({ type: 'error', sessionId: id, message: String(e?.message || e) });
		teardownRuntime(id);
		drainQueue(id);
	});
	return rt;
}

// A turn as it happens, whichever agent runs it (see backends/common.mjs for the events): kept
// in the conversation's file and sent to the page.
async function consume(id, events, rt) {
	const endThinking = (sess) => {
		const t = rt.thinking;
		rt.thinking = null;
		const ms = Date.now() - t.start;
		if (sess && t.text.trim()) { sess.messages.push({ role: 'think', text: t.text, ms, time: Date.now() }); saveSession(sess); }
		broadcast({ type: 'thinking_end', sessionId: id, ms });
	};
	for await (const ev of events) {
		rt.lastActive = Date.now();
		const sess = sessionCache.get(id);
		if (ev.type === 'init') {
			if (sess && ev.ref) {
				sess[REF_KEY[rt.backend]] = ev.ref;
				saveSession(sess);
			}
			broadcast({ type: 'session', sessionId: id, claudeSessionId: rt.backend === 'claude' ? ev.ref : null, backend: rt.backend, model: ev.model });
			broadcast({ type: 'skills_updated' }); // the "/" menu can now show this conversation's full list
		} else if (ev.type === 'commands_changed') {
			broadcast({ type: 'skills_updated' });
		} else if (ev.type === 'command_output') {
			if (sess) { sess.messages.push({ role: 'cmdout', text: ev.text, time: Date.now() }); saveSession(sess); }
			broadcast({ type: 'command_output', sessionId: id, text: ev.text });
		} else if (ev.type === 'notice') {
			if (sess) { sess.messages.push({ role: 'sys', text: ev.text, time: Date.now() }); saveSession(sess); }
			broadcast({ type: 'notice', sessionId: id, text: ev.text });
		} else if (ev.type === 'thinking_start') {
			rt.thinking = { text: '', start: Date.now() };
			rt.label = '正在思考';
			broadcast({ type: 'thinking_start', sessionId: id });
		} else if (ev.type === 'thinking_end') {
			if (rt.thinking) endThinking(sess);
		} else if (ev.type === 'thinking_delta') {
			rt.label = '正在思考';
			if (rt.thinking) rt.thinking.text += ev.text;
			broadcast({ type: 'thinking_delta', sessionId: id, text: ev.text });
		} else if (ev.type === 'thinking') {
			if (sess) { sess.messages.push({ role: 'think', text: ev.text, ms: 0, time: Date.now() }); saveSession(sess); }
			broadcast({ type: 'thinking_start', sessionId: id });
			broadcast({ type: 'thinking_delta', sessionId: id, text: ev.text });
			broadcast({ type: 'thinking_end', sessionId: id, ms: 0 });
		} else if (ev.type === 'text_delta') {
			rt.assistantText += ev.text;
			rt.label = '正在回复';
			broadcast({ type: 'assistant_delta', sessionId: id, text: ev.text });
		} else if (ev.type === 'text_end') {
			if (rt.assistantText && sess) {
				sess.messages.push({ role: 'assistant', text: rt.assistantText, time: Date.now() });
				rt.assistantText = '';
				saveSession(sess);
			}
			broadcast({ type: 'assistant_end', sessionId: id });
		} else if (ev.type === 'text') {
			if (sess) {
				sess.messages.push({ role: 'assistant', text: ev.text, time: Date.now() });
				saveSession(sess);
			}
			broadcast({ type: 'assistant_text', sessionId: id, text: ev.text });
		} else if (ev.type === 'tool_use') {
			const title = toolTitle(ev.name, ev.input);
			const detail = toolDetail(ev.name, ev.input);
			// TodoWrite gets a live checklist render in the UI instead of a generic tool card.
			const isTodo = ev.name === 'TodoWrite';
			const todos = isTodo ? (ev.input?.todos || []) : undefined;
			if (sess) {
				sess.messages.push({ role: 'tool', id: ev.id, name: ev.name, title, detail, category: toolCategory(ev.name), state: 'running', time: Date.now(), ...(isTodo ? { kind: 'todo', todos } : {}) });
				saveSession(sess);
			}
			rt.label = title;
			broadcast({ type: 'tool_use', sessionId: id, id: ev.id, name: ev.name, title, detail, category: toolCategory(ev.name), ...(isTodo ? { kind: 'todo', todos } : {}) });
		} else if (ev.type === 'tool_result') {
			const summary = String(ev.text ?? '').slice(0, 4000);
			if (sess) {
				const tm = sess.messages.find((x) => x.role === 'tool' && x.id === ev.id);
				if (tm) {
					tm.state = ev.ok ? 'ok' : 'err';
					tm.ok = !!ev.ok;
					tm.summary = summary;
					saveSession(sess);
				}
			}
			broadcast({ type: 'tool_result', sessionId: id, id: ev.id, ok: !!ev.ok, summary });
			rt.label = '正在思考';
		} else if (ev.type === 'result') {
			rt.running = false;
			rt.label = '';
			const tookMs = rt.since ? Date.now() - rt.since : (ev.durationMs || 0);
			rt.since = 0;
			if (rt.thinking) endThinking(sess); // stopped mid-thought: no block_stop will come
			if (rt.assistantText && sess) {
				sess.messages.push({ role: 'assistant', text: rt.assistantText, time: Date.now() });
				rt.assistantText = '';
			}
			if (sess) {
				// How long this turn took, shown under its last reply.
				for (let i = sess.messages.length - 1; i >= 0 && sess.messages[i].role !== 'user'; i--) {
					if (sess.messages[i].role === 'assistant') { sess.messages[i].tookMs = tookMs; break; }
				}
				saveSession(sess);
				maybeTitle(id); // name the conversation once it has its first answer
			}
			broadcast({ type: 'result', sessionId: id, ok: !!ev.ok, text: ev.text || '', costUsd: ev.costUsd || 0, durationMs: tookMs, subtype: ev.subtype, errors: ev.errors });
			if (ev.code === 'auth') broadcastAuth(); // the login it ran on is gone
			announceSkillDrafts(id).catch((e) => log('[skills] draft scan', e?.message));
			noticeSkillChanges().catch((e) => log('[skills] change scan', e?.message));
			drainQueue(id);
		}
	}
}

// ---------------------------------------------------------------- conversation titles
// The first message gives a stand-in title; once the conversation has its first answer, a quick
// one-off call names it (Haiku, or a Flash model for an Antigravity conversation). A title the
// owner typed is never replaced.
const autoTitleOf = (text) => typedText(text).trim().slice(0, 24).replace(/\n/g, ' ') || '新对话';
const TITLE_DIR = join(homedir(), '.claude', 'agent-titles');
const titling = new Set();
const cleanTitle = (t) => (String(t || '').split('\n').map((l) => l.trim()).find(Boolean) || '')
	.replace(/^标题[:：]\s*/, '').replace(/[「」"“”'‘’《》#*`]/g, '').replace(/[。.!！?？,，、；;:：\s]+$/, '').slice(0, 20);
async function generateTitle(userText, replyText, backend = 'claude') {
	await mkdir(TITLE_DIR, { recursive: true });
	const clip = (t, n) => typedText(t).trim().slice(0, n);
	const system = '你只负责给对话起简短的中文标题。';
	const prompt = `给下面这段对话起一个标题：不超过 12 个汉字，概括用户想做的事；不要标点、引号、表情和解释，只输出标题本身。\n\n用户：${clip(userText, 800)}\n\n助手：${clip(replyText, 800)}`;
	// By the agent that answered: the owner may be signed in to only one of the two.
	const out = backend === 'agy'
		? await agy.oneShot({ prompt: `${system}\n\n${prompt}`, cwd: TITLE_DIR, model: agySlug(settings.model) })
		: await claude.oneShot({ prompt, system, cwd: TITLE_DIR, model: 'haiku' });
	return cleanTitle(out);
}
async function maybeTitle(id) {
	const sess = sessionCache.get(id);
	if (!sess || sess.titleSource || titling.has(id)) return;
	const firstUser = sess.messages.find((m) => m.role === 'user');
	const firstReply = sess.messages.find((m) => m.role === 'assistant');
	if (!firstUser || !firstReply) return;
	if (sess.title !== autoTitleOf(firstUser.text)) { sess.titleSource = 'user'; return; } // renamed by hand before
	titling.add(id);
	try {
		const title = await generateTitle(firstUser.text, firstReply.text, sess.backend || 'claude');
		if (!title || sess.titleSource) return; // nothing usable, or renamed meanwhile
		if (sessionCache.get(id) !== sess) return; // deleted meanwhile: saving would bring it back
		sess.title = title;
		sess.titleSource = 'ai';
		await saveSession(sess);
		broadcast({ type: 'title', sessionId: id, title });
		broadcast({ type: 'sessions_updated', sessions: await loadSessionsIndex() });
	} catch (e) {
		log('[title]', id.slice(0, 8), e?.message || e);
	} finally {
		titling.delete(id);
	}
}

// ---------------------------------------------------------------- the background screen
// droid opens apps on a screen nobody sees (BgScreen in the APK, run as root), so the owner keeps
// the phone while the assistant works. It answers on an abstract socket, to root only; this
// server is root in the same network namespace. The page and the floating panel show that screen
// live, and can move its app over to the owner's screen.
const BG_SOCKET = '\0droidagent-bgscreen';
const BG_DIR = process.env.AGENT_BG_DIR || '/data/local/tmp/droid-bg'; // where BgScreen may write
function bgCall(line, timeout = 15000) {
	return new Promise((resolve) => {
		let buf = '';
		let finished = false;
		const s = netConnect({ path: BG_SOCKET });
		const done = (v) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			s.destroy();
			resolve(v);
		};
		const timer = setTimeout(() => done(null), timeout);
		s.setEncoding('utf8');
		s.on('connect', () => s.write(`${line}\n`));
		s.on('data', (d) => { buf += d; if (buf.includes('\n')) done(buf.trim()); });
		s.on('error', () => done(null));
		s.on('close', () => done(buf.trim() || null));
	});
}
async function bgState() {
	const r = await bgCall('info', 3000);
	if (!r?.startsWith('ok ')) return { active: false };
	try {
		const j = JSON.parse(r.slice(3));
		return {
			active: true, pkg: j.top || null, app: j.label || j.top || null,
			takenOver: j.takenOverLabel || j.takenOver || null, w: j.w, h: j.h,
		};
	} catch { return { active: false }; }
}
// Pages hear about it opening, changing app and closing. Asked while a conversation works, or
// while it is open; `info` doesn't keep it open.
let bgLast = JSON.stringify({ active: false });
async function watchBgScreen() {
	const st = await bgState();
	const key = JSON.stringify(st);
	if (key !== bgLast) {
		bgLast = key;
		broadcast({ type: 'bgscreen', ...st });
	}
	return st;
}
// The app left open there keeps running unseen, so the screen closes once nothing has worked for
// a while and nobody is watching it.
const BG_IDLE_MS = Number(process.env.AGENT_BG_IDLE_MS) || 5 * 60 * 1000;
let lastWorkAt = Date.now();
let lastWatchedAt = 0;
setInterval(() => {
	const busy = [...runtimes.values()].some((rt) => rt.running || rt.pending.size > 0);
	if (busy) lastWorkAt = Date.now();
	const open = bgLast.includes('"active":true');
	if (open && !busy && Date.now() - Math.max(lastWorkAt, lastWatchedAt) > BG_IDLE_MS) {
		log('[bgscreen] closing it: nothing has run there for a while');
		lastWorkAt = Date.now();
		bgCall('quit').then(() => watchBgScreen()).catch(() => {});
		return;
	}
	if (busy || open) watchBgScreen().catch(() => {});
}, 2000).unref();

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
// For an Antigravity conversation: the app's own, and what a headless agy run takes (its skills
// are slash commands too, and join this list like Claude's).
const AGY_SLASH_COMMANDS = [
	{ name: 'clear', description: '开始一个新对话', argumentHint: '' },
	{ name: 'model', description: '切换模型', argumentHint: '' },
	{ name: 'usage', description: '查看用量和额度', argumentHint: '' },
	{ name: 'plan', description: '先调查并给出计划，不动手', argumentHint: '[要做的事]' },
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

// The phone's apps by the names the owner sees: every app with a launcher icon, system ones too,
// asked of the package manager through BgScreen (`pm list packages` has no names and can be too
// slow on a busy phone). Asked again when the list is more than a few seconds old, so a new
// install shows up; the newest installs come first.
let appsLoading = null;
const RECENT_INSTALL_MS = 7 * 24 * 3600 * 1000;
async function getInstalledApps() {
	if (cachedApps && Date.now() - cachedAppsTime < 15000) return cachedApps;
	appsLoading ||= (async () => {
		let apps = null;
		try {
			const out = await run('ashell', ['sh', '-c', 'p=$(pm path com.droidagent.app | head -n 1); CLASSPATH="${p#package:}" exec app_process /system/bin com.droidagent.app.BgScreen apps'], { timeout: 30000 });
			const line = out.split('\n').find((l) => l.startsWith('['));
			apps = JSON.parse(line).map((a) => ({ package: a.package, name: a.name || a.package, system: !!a.system, installed: a.installed || 0 }));
		} catch (e) { log('[apps] by name:', e?.message); }
		if (!apps?.length) {
			try {
				const out = await run('ashell', ['pm', 'list', 'packages', '-3'], { timeout: 20000 });
				apps = out.split('\n').map((l) => l.trim().replace(/^package:/, '')).filter(Boolean)
					.map((pkg) => ({ package: pkg, name: KNOWN_APPS[pkg] || pkg.split('.').pop(), system: false, installed: 0 }));
			} catch (e) { log('[apps] packages:', e?.message); }
		}
		if (!apps?.length) return cachedApps || Object.keys(KNOWN_APPS).map((pkg) => ({ package: pkg, name: KNOWN_APPS[pkg], system: false, installed: 0 }));
		const now = Date.now();
		const recent = (a) => (!a.system && now - a.installed < RECENT_INSTALL_MS ? 1 : 0);
		apps.sort((a, b) => (recent(b) - recent(a)) || (a.system - b.system) || a.name.localeCompare(b.name, 'zh-CN'));
		cachedApps = apps;
		cachedAppsTime = Date.now();
		return apps;
	})().finally(() => { appsLoading = null; });
	return appsLoading;
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

// Put a checked skill directory in place as `id`, enabled. `overwrite` replaces an earlier copy of
// the owner's; a built-in skill of that name is never replaced.
async function placeSkill(srcDir, id, { move = false, overwrite = true } = {}) {
	if (!safeId(id)) throw new Error(`技能名称无效：${id}`);
	const escaping = await findEscapingSymlinks(srcDir);
	if (escaping.length) throw new Error(`技能里有指向外部的符号链接（${escaping[0]}），已拒绝`);
	const dest = join(SKILLS_DIR, id);
	const off = join(SKILLS_OFF_DIR, id);
	for (const p of [dest, off]) {
		if (!existsSync(p)) continue;
		if (existsSync(join(p, '.builtin'))) throw new Error(`「${id}」是内置技能，不能覆盖`);
		if (!overwrite) throw new Error(`已经有一个叫「${id}」的技能`);
	}
	// Stage next to the destination, so a failed copy never costs the working copy.
	await mkdir(SKILLS_DIR, { recursive: true });
	const stage = join(homedir(), '.claude', `.skill-stage-${randomUUID()}`);
	try {
		if (move) await rename(srcDir, stage);
		else await run('cp', ['-a', '--', srcDir, stage]);
		await rm(join(stage, '.git'), { recursive: true, force: true });
		for (const p of [dest, off]) await rm(p, { recursive: true, force: true });
		await rename(stage, dest);
	} finally {
		await rm(stage, { recursive: true, force: true }).catch(() => {});
	}
}

// Install one or more skills from a GitHub repo (or one directory in it), a local directory, or a
// local .zip. Returns the ids installed. Only the skill directories themselves are ever copied.
async function installSkill(input) {
	const src = parseSkillSource(input);
	if (!src) throw new Error('只支持 GitHub 仓库地址（可以指向子目录）或手机里的绝对路径');
	const tmp = join(homedir(), '.claude', `.skill-tmp-${randomUUID()}`);
	await mkdir(tmp, { recursive: true });
	try {
		let base;
		let fallbackId;
		if (src.kind === 'path') {
			if (src.path.toLowerCase().endsWith('.zip')) {
				await run('unzip', ['-q', '-o', src.path, '-d', tmp]);
				base = tmp;
			} else {
				base = src.path;
			}
			fallbackId = basename(src.path).replace(/\.zip$/i, '');
		} else {
			await run('git', ['clone', '--depth', '1', ...(src.ref ? ['--branch', src.ref] : []), '--', src.cloneUrl, tmp], { timeout: 300000 });
			base = src.subdir ? join(tmp, ...src.subdir.split('/')) : tmp;
			fallbackId = src.subdir ? src.subdir.split('/').pop() : src.repo;
		}
		const roots = await findSkillRoots(base);
		if (roots.length === 0) throw new Error('没找到 SKILL.md（不是有效的技能）');
		const ids = [];
		for (const r of roots) {
			const id = r.id || fallbackId;
			await placeSkill(r.dir, id);
			ids.push(id);
		}
		return ids;
	} finally {
		await rm(tmp, { recursive: true, force: true }).catch(() => {});
	}
}

// Live conversations pick up changed skills and plugins with Claude Code's own reload. On 2.1.112 it
// answers with the previous state: fine for skills, which are usable right after it, while for
// plugins those conversations restart too, which is invisible: the next message resumes the same
// conversation. A busy one waits until idle. Skills must not restart on 2.1.112, as a resumed
// conversation isn't told about new ones again, so the model would never hear of them.
async function refreshRuntimes({ restartOld = true } = {}) {
	const seen = await changeMarks();
	skillsSeen = seen.skills;
	pluginsSeen = seen.plugins;
	// A copy: a conversation started while this waits on a reload has already seen the change.
	for (const [id, rt] of [...runtimes]) {
		if (runtimes.get(id) !== rt) continue;
		let reloaded = false;
		const old = rt.chatSpec?.kind === 'legacy';
		if (rt.q?.reloadPlugins && !(old && restartOld)) { // about to restart: nothing to gain from reloading first
			try {
				await withTimeout(rt.q.reloadPlugins(), 20000, 'timeout');
				if (rt.q.reloadSkills) await withTimeout(rt.q.reloadSkills(), 20000, 'timeout');
				reloaded = !old;
			} catch (e) { log('[market] reload failed', id.slice(0, 8), e?.message); }
		}
		if (reloaded || !restartOld) continue;
		if (!rt.running && rt.pending.size === 0) teardownRuntime(id);
		else rt.restartWhenIdle = true;
	}
}

async function afterSkillChange() {
	await refreshRuntimes({ restartOld: false });
	broadcast({ type: 'skills_updated' });
	refreshSkillNames();
}

// The App isn't the only one who changes skills: the assistant can install one with its own tools
// (it runs as root), and then nothing above runs. So the skills directory and the plugin registry
// are compared with what was last seen whenever it matters: after a turn and when "/" is typed.
const PLUGIN_REGISTRY = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
let skillsSeen = '';
let pluginsSeen = '';
async function changeMarks() {
	const parts = [];
	for (const id of (await dirNames(SKILLS_DIR)).sort()) {
		const st = await stat(join(SKILLS_DIR, id, 'SKILL.md')).catch(() => null);
		parts.push(`${id}:${st ? st.mtimeMs : 0}`);
	}
	const reg = await stat(PLUGIN_REGISTRY).catch(() => null);
	return { skills: parts.join('|'), plugins: String(reg ? reg.mtimeMs : 0) };
}
async function noticeSkillChanges() {
	const now = await changeMarks();
	if (now.plugins !== pluginsSeen) {
		log('[plugins] changed on disk');
		pluginsSeen = now.plugins;
		skillsSeen = now.skills;
		await pluginTask(refreshInstalledPlugins).catch((e) => log('[plugins] list', e?.message));
		pluginsChanged();
	} else if (now.skills !== skillsSeen) {
		log('[skills] changed on disk');
		skillsSeen = now.skills;
		await afterSkillChange();
	}
}
// Names that have been skills since the server started: see mergeSlashCommands.
const formerSkillNames = new Set();
async function slashCommandsWith(base) {
	const skills = await listSkills();
	for (const s of skills) if (s.loadable) formerSkillNames.add(s.name);
	return mergeSlashCommands(base, skills, formerSkillNames);
}

// A repository cloned whole into the skills directory: lift the skills it holds up to where Claude
// Code looks, then drop the rest of the clone. Everything is checked before anything moves.
async function repairSkill(id) {
	const dir = [SKILLS_DIR, SKILLS_OFF_DIR].map((d) => join(d, id)).find((p) => existsSync(p));
	if (!dir) throw new Error('找不到这个技能');
	const roots = await findSkillRoots(dir);
	if (!roots.length || roots.some((r) => !r.id)) throw new Error(roots.length ? '这个技能本来就是好的' : '里面没有找到技能文件，只能删除后重新安装');
	for (const { id: inner } of roots) {
		if (!safeId(inner)) throw new Error(`技能名称无效：${inner}`);
		if (inner !== id && (existsSync(join(SKILLS_DIR, inner)) || existsSync(join(SKILLS_OFF_DIR, inner)))) throw new Error(`已经有一个叫「${inner}」的技能`);
	}
	// One named like the clone goes last: placing it replaces the clone, with the others still inside.
	for (const r of roots.sort((a, b) => (a.id === id) - (b.id === id))) await placeSkill(r.dir, r.id);
	if (!roots.some((r) => r.id === id)) await rm(dir, { recursive: true, force: true });
	return roots.map((r) => r.id);
}

// ---------------------------------------------------------------- skill drafts
// What "create a skill with Claude" writes. It only becomes a skill when the owner saves it here.
async function listSkillDrafts() {
	const out = [];
	for (const id of await dirNames(SKILL_DRAFTS_DIR)) {
		if (!safeId(id)) continue;
		const file = join(SKILL_DRAFTS_DIR, id, 'SKILL.md');
		try {
			const st = await lstat(file);
			if (!st.isFile() || st.size > 256 * 1024) continue;
			const text = await readFile(file, 'utf8');
			const fm = parseFrontmatter(text);
			out.push({ id, name: fm?.name || id, description: fm?.description || '', text, errors: validateSkillText(text, id), mtime: st.mtimeMs });
		} catch { /* not a draft */ }
	}
	return out;
}

const draftsSeen = new Map();
async function announceSkillDrafts(sessionId) {
	for (const d of await listSkillDrafts()) {
		if (draftsSeen.get(d.id) === d.mtime) continue;
		draftsSeen.set(d.id, d.mtime);
		broadcast({ type: 'skill_draft', sessionId, id: d.id, name: d.name, ok: !d.errors.length });
	}
}

// ---------------------------------------------------------------- plugins (official CLI)
async function claudeCli(args, { timeout = 120000, raw = false } = {}) {
	const rt = await claudeRuntime();
	if (!rt.chat) throw new Error(noRuntimeMessage(rt));
	// Output goes through a file, not a pipe: Claude Code 2.1.112 exits before a pipe has drained,
	// which cuts long JSON short at an arbitrary point. stdin is closed or it would wait on it.
	const outPath = join(homedir(), '.claude', `.cli-out-${randomUUID()}`);
	const outFile = await open(outPath, 'w');
	try {
		const { code, err, timedOut } = await new Promise((resolve, reject) => {
			const c = runClaude(rt.chat, args, { stdio: ['ignore', outFile.fd, 'pipe'], cwd: homedir() });
			let err = '';
			let timedOut = false;
			const timer = setTimeout(() => { timedOut = true; try { c.kill('SIGKILL'); } catch { /* */ } }, timeout);
			c.stderr.on('data', (d) => { if (err.length < 1e5) err += d; });
			c.on('error', (e) => { clearTimeout(timer); reject(e); });
			c.on('close', (exit) => { clearTimeout(timer); resolve({ code: exit, err, timedOut }); });
		});
		if (timedOut) throw new Error('超时，请检查网络或代理后重试');
		const out = await readFile(outPath, 'utf8');
		if (raw) return { code, out, err };
		if (code === 0) return out;
		const lines = `${err}\n${out}`.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
		const why = lines.find((l) => /^[✘✖]|Failed|Error:/.test(l)) || lines.at(-1) || `退出码 ${code}`;
		throw new Error(why.replace(/^[✘✖]\s*/, '').slice(0, 300));
	} finally {
		await outFile.close().catch(() => {});
		await unlink(outPath).catch(() => {});
	}
}
const cliJson = async (args, opts) => JSON.parse(await claudeCli(args, opts));

let pluginGate = Promise.resolve();
let officialMarkets = null;
function ensureOfficialMarkets() {
	officialMarkets ||= (async () => {
		const have = await cliJson(['plugin', 'marketplace', 'list', '--json']);
		const has = (name) => have.some((x) => x.name === name);
		for (const m of OFFICIAL_MARKETPLACES) {
			if (has(m.name) || (m.name === COMPAT_OF && has(COMPAT_MARKETPLACE))) continue;
			try {
				await claudeCli(['plugin', 'marketplace', 'add', m.url], { timeout: 300000 });
			} catch (e) {
				if (m.name !== COMPAT_OF || !/invalid (input|schema)|plugins\.\d+\.source/i.test(e?.message || '')) throw e;
				log('[market] this Claude Code refuses the official catalog, using a compatible copy:', e.message);
				await writeCompatMarket();
				await claudeCli(['plugin', 'marketplace', 'add', COMPAT_DIR], { timeout: 300000 });
			}
		}
	})().catch((e) => { officialMarkets = null; throw e; });
	return officialMarkets;
}

// The official catalog as Claude Code 2.1.112 can read it (see COMPAT_MARKETPLACE), fetched again
// whole and swapped in, so a failed fetch leaves the last good copy.
const COMPAT_DIR = join(homedir(), '.claude', 'plugin-catalog-compat');
async function writeCompatMarket() {
	const src = OFFICIAL_MARKETPLACES.find((m) => m.name === COMPAT_OF);
	const tmp = `${COMPAT_DIR}.new-${randomUUID().slice(0, 8)}`;
	try {
		await run('git', ['clone', '--depth', '1', '--', src.url, tmp], { timeout: 300000 });
		const file = join(tmp, '.claude-plugin', 'marketplace.json');
		const { json, dropped } = compatibleMarketplace(JSON.parse(await readFile(file, 'utf8')));
		await writeFile(file, JSON.stringify(json, null, '\t'));
		log('[market] compatible catalog leaves out:', dropped.join(', ') || 'nothing');
		await rm(COMPAT_DIR, { recursive: true, force: true });
		await rename(tmp, COMPAT_DIR);
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}
async function refreshCompatMarket() {
	const st = await stat(join(COMPAT_DIR, '.claude-plugin', 'marketplace.json')).catch(() => null);
	if (!st || Date.now() - st.mtimeMs < 24 * 3600 * 1000) return;
	try {
		await writeCompatMarket();
		await claudeCli(['plugin', 'marketplace', 'update', COMPAT_MARKETPLACE], { timeout: 300000 });
	} catch (e) { log('[market] refreshing the compatible catalog', e?.message); }
}

// One plugin operation at a time. They all rewrite the same settings file, and each runs a CLI that
// takes seconds on a phone. `installed` is only ever replaced inside the queue, so a slow catalog
// load can never put back a state from before an enable or disable that finished while it ran.
const plugins = { known: new Map(), installed: [], loadedAt: 0, loading: null, jobs: new Map(), descriptions: new Map() };
let pluginQueue = Promise.resolve();
function pluginTask(fn) {
	const run = pluginQueue.then(fn, fn);
	pluginQueue = run.catch(() => {});
	return run;
}
const refreshInstalledPlugins = async () => { plugins.installed = await cliJson(['plugin', 'list', '--json']); };

const CATALOG_TTL = 30 * 60 * 1000;
function loadPluginCatalog({ force = false } = {}) {
	if (plugins.loading) return plugins.loading;
	if (!force && Date.now() - plugins.loadedAt < CATALOG_TTL) return Promise.resolve();
	plugins.loading = pluginTask(async () => {
		await ensureOfficialMarkets();
		await refreshCompatMarket();
		const j = await cliJson(['plugin', 'list', '--available', '--json'], { timeout: 180000 });
		// The CLI leaves installed plugins out of `available`, so an entry seen once is kept:
		// uninstalling a plugin must bring it back to the list without another slow load.
		for (const p of j.available || []) if (p?.pluginId) plugins.known.set(p.pluginId, p);
		plugins.installed = j.installed || [];
		plugins.loadedAt = Date.now();
	}).finally(() => { plugins.loading = null; });
	return plugins.loading;
}

async function pluginDescription(p) {
	const key = `${p.id}@${p.version}`;
	if (!plugins.descriptions.has(key)) {
		const c = p.installPath ? await inspectPluginDir(p.installPath).catch(() => null) : null;
		plugins.descriptions.set(key, c?.description || '');
	}
	return plugins.descriptions.get(key);
}
async function inspectInstalled(id) {
	const p = plugins.installed.find((x) => x.id === id);
	if (!p) throw new Error('这个插件没有安装');
	return { id, enabled: !!p.enabled, version: p.version || '', contents: p.installPath ? await inspectPluginDir(p.installPath) : null };
}
function pluginsChanged() {
	broadcast({ type: 'plugins_updated', installed: plugins.installed.length });
	// Not awaited: the page shouldn't wait for every open conversation before showing the new state.
	refreshRuntimes().catch((e) => log('[market] refresh', e?.message)).finally(() => {
		broadcast({ type: 'skills_updated' });
		broadcast({ type: 'mcp_updated' });
	});
}

// Downloading runs in the background and reports its stage, so the list stays usable and the page
// can be left. The result is installed but not enabled: its hooks and servers run as root, so the
// owner reads what it holds first. The gate holds back new conversations between `install` (which
// enables) and `disable`.
function startPluginDownload(id) {
	if (plugins.jobs.has(id)) return;
	const job = { id, stage: 'queued', startedAt: Date.now() };
	plugins.jobs.set(id, job);
	const report = (stage, extra = {}) => { job.stage = stage; broadcast({ type: 'plugin_job', ...job, ...extra }); };
	report('queued');
	pluginTask(async () => {
		await refreshInstalledPlugins();
		if (plugins.installed.some((p) => p.id === id)) throw new Error('这个插件已经装好了');
		report('downloading');
		const work = (async () => {
			await claudeCli(['plugin', 'install', id], { timeout: 300000 });
			report('checking');
			try {
				await claudeCli(['plugin', 'disable', id]);
			} catch (e) {
				await claudeCli(['plugin', 'uninstall', id]).catch(() => {});
				throw e;
			}
		})();
		pluginGate = work.catch(() => {});
		await work;
		await refreshInstalledPlugins();
		return inspectInstalled(id);
	}).then((r) => {
		plugins.jobs.delete(id);
		report('ready', { contents: r.contents });
		broadcast({ type: 'plugins_updated', installed: plugins.installed.length });
	}, (e) => {
		plugins.jobs.delete(id);
		report('error', { error: e?.message || '下载失败' });
	});
}

// Sets the state rather than flipping it, so a repeated or stale request changes nothing.
function setPluginEnabled(id, enabled) {
	return pluginTask(async () => {
		await refreshInstalledPlugins();
		const cur = plugins.installed.find((p) => p.id === id);
		if (!cur) throw new Error('这个插件没有安装');
		if (!!cur.enabled !== enabled) {
			await claudeCli(['plugin', enabled ? 'enable' : 'disable', id]);
			await refreshInstalledPlugins();
		}
		return !!plugins.installed.find((p) => p.id === id)?.enabled;
	});
}

// ---------------------------------------------------------------- connector catalog
const readCatalog = async (file) => JSON.parse(await readFile(join(HERE, 'catalog', file), 'utf8'));
// Results of recent registry searches. Adding one uses this copy, not whatever the page sends back.
const registrySeen = new Map();
async function searchRegistry(q) {
	const params = new URLSearchParams({ limit: '30', version: 'latest', search: q });
	const r = await fetchUrl(`https://registry.modelcontextprotocol.io/v0.1/servers?${params}`, { timeout: 20000 });
	const found = normalizeRegistry(JSON.parse(r.body));
	for (const c of found) registrySeen.set(c.id, c);
	return found;
}

// ---------------------------------------------------------------- GitHub projects
// The "+" menu's GitHub tile: one personal access token makes the GitHub MCP connector (the
// curated `github` entry, so the market shows it as added) and is also handed to the commands the
// agents run (GH_TOKEN / GITHUB_TOKEN), so `gh` and `git` over https work on the owner's repos too.
// Repositories linked recently are remembered for the picker.
const GITHUB_FILE = join(homedir(), '.claude', 'agent-github.json');
const GITHUB_MCP = 'github';
async function readGithubFile() { try { return JSON.parse(await readFile(GITHUB_FILE, 'utf8')); } catch { return { recent: [] }; } }
async function writeGithubFile(g) { await mkdir(dirname(GITHUB_FILE), { recursive: true }); await writeFile(GITHUB_FILE, JSON.stringify(g, null, 2), { encoding: 'utf8', mode: 0o600 }); }
function githubTokenOf(entry) {
	if (!entry) return '';
	if (entry.bearer) return String(entry.bearer);
	const h = entry.headers?.Authorization || entry.headers?.authorization || '';
	return String(h).replace(/^(Bearer|token)\s+/i, '').trim();
}
async function githubToken() {
	const { servers = {} } = await readMcpFile();
	return githubTokenOf(servers[GITHUB_MCP]);
}
function applyGithubEnv(token) {
	for (const k of ['GH_TOKEN', 'GITHUB_TOKEN']) {
		if (token) process.env[k] = token;
		else if (process.env[`DROIDAGENT_SET_${k}`]) delete process.env[k];
		if (token) process.env[`DROIDAGENT_SET_${k}`] = '1'; else delete process.env[`DROIDAGENT_SET_${k}`];
	}
}
githubToken().then((t) => { if (t) applyGithubEnv(t); }).catch(() => {});
const githubApi = async (path, token) => JSON.parse((await fetchUrl(`https://api.github.com${path}`, {
	headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
	timeout: 20000,
})).body);
const maskToken = (t) => (t ? `${t.slice(0, 4)}…${t.slice(-4)}` : '');
async function githubStatus() {
	const { servers = {} } = await readMcpFile();
	const entry = servers[GITHUB_MCP];
	const token = githubTokenOf(entry);
	const g = await readGithubFile();
	return { ok: true, configured: !!token, enabled: !!entry && !entry.disabled, token: maskToken(token), login: g.login || '', recent: (g.recent || []).slice(0, 12) };
}
async function rememberGithubRepo(r) {
	const g = await readGithubFile();
	g.recent = [{ repo: r.repo, url: r.url, branch: r.branch || '', private: !!r.private, description: String(r.description || '').slice(0, 200), at: Date.now() },
		...(g.recent || []).filter((x) => x.repo !== r.repo)].slice(0, 20);
	await writeGithubFile(g);
}

// ---------------------------------------------------------------- connector sign-in (pty)
let mcpLogin = null;
function cancelMcpLogin() {
	if (!mcpLogin) return;
	mcpLogin.cancelled = true;
	try { mcpLogin.kill('SIGKILL'); } catch { /* */ }
	mcpLogin = null;
}
// `claude mcp login` only knows servers in its own config, so a connector of ours is registered
// there too. One from a plugin (no entry here) is already known to it.
async function startMcpLogin(name, entry) {
	cancelMcpLogin();
	const rt = await claudeRuntime();
	if (!rt.chat) throw new Error(noRuntimeMessage(rt));
	if (entry) {
		await claudeCli(['mcp', 'remove', '--scope', 'user', name]).catch(() => {});
		await claudeCli(['mcp', 'add-json', '--scope', 'user', name, JSON.stringify(toMcpConfig(entry))]);
	}
	const child = spawn('python3', [join(HERE, 'mcp_login_pty.py'), name], {
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, CLAUDE_CLI_SPEC: JSON.stringify({ cmd: rt.chat.cmd, env: rt.chat.env }) },
	});
	mcpLogin = child;
	let buf = '';
	let done = false;
	const finish = async (ok, message) => {
		if (done || child.cancelled) return;
		done = true;
		if (mcpLogin === child) mcpLogin = null;
		if (ok) for (const r of runtimes.values()) { try { await r.q.reconnectMcpServer?.(name); } catch { /* picked up by the next conversation */ } }
		broadcast({ type: 'mcp_login_done', name, ok, message });
		broadcast({ type: 'mcp_updated' });
	};
	child.stdout.on('data', (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, i); buf = buf.slice(i + 1);
			if (line.startsWith('URL ')) broadcast({ type: 'mcp_login_url', name, url: line.slice(4).trim() });
			else if (line.startsWith('DONE ')) finish(line.startsWith('DONE ok'), line.replace(/^DONE (ok|fail)\s*/, ''));
		}
	});
	child.stderr.on('data', (d) => log('[mcp-login]', String(d).trim().slice(0, 300)));
	child.on('error', (e) => finish(false, `无法运行授权脚本（python3）：${e?.message || e}`));
	child.on('close', (c, s) => finish(false, `授权进程意外退出（${s || c}）`));
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
	// A running claude keeps the proxy it started with, and a wrong one is usually why this changed.
	restartRuntimesWhenIdle();
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
// What signing in to Antigravity and its turns need. Google's own region limits only show once
// agy asks for a model, so here an answer of any kind counts.
const GOOGLE_HOSTS = ['accounts.google.com', 'oauth2.googleapis.com'];
const NET = { claude: { hosts: ANTHROPIC_HOSTS, name: 'Claude' }, agy: { hosts: GOOGLE_HOSTS, name: 'Google' } };
// Reachable means an HTTP answer that isn't Anthropic's region block (403).
async function checkHosts(hosts, proxy) {
	const results = await Promise.all(hosts.map((h) => httpsHead(h, proxy)));
	const bad = results.map((r, i) => ({ host: hosts[i], ...r })).filter((r) => !r.ok || (r.status === 403 && hosts === ANTHROPIC_HOSTS));
	return { ok: bad.length === 0, summary: bad.map((b) => `${b.host} ${b.ok ? '地区受限（403）' : b.error}`).join('，') };
}
const checkAnthropic = (proxy) => checkHosts(ANTHROPIC_HOSTS, proxy);
function portOpen(port, timeout = 700) {
	return new Promise((resolve) => {
		const sk = netConnect({ host: '127.0.0.1', port });
		const done = (v) => { clearTimeout(t); sk.destroy(); resolve(v); };
		const t = setTimeout(() => done(false), timeout);
		sk.on('connect', () => done(true));
		sk.on('error', () => done(false));
	});
}
async function findLocalProxy(skip, hosts = ANTHROPIC_HOSTS) {
	for (const port of LOCAL_PROXY_PORTS) {
		const proxy = `http://127.0.0.1:${port}`;
		if (proxy === skip || !(await portOpen(port))) continue;
		if ((await checkHosts(hosts, proxy)).ok) return proxy;
	}
	return null;
}
// Make sure the agent will be able to reach its servers; switch to a working local proxy if needed.
async function ensureNetwork(report, { hosts, name } = NET.claude) {
	const current = readProxySetting();
	const c = await checkHosts(hosts, current || null);
	if (c.ok) return { ok: true, proxy: current };
	report(`${current ? `代理 ${current} ` : '直连'}连不上 ${name}（${c.summary}），正在查找本机代理端口…`);
	const found = await findLocalProxy(current, hosts);
	if (found) {
		await saveProxySetting(found);
		log('[net] switched to local proxy', found, 'after', c.summary);
		return { ok: true, proxy: found, changed: true };
	}
	log(`[net] ${name} unreachable:`, c.summary);
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
				res.on('error', reject); // dropped halfway: see fetchUrl
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
	const version = String(claude.version() || '').match(/\d+\.\d+\.\d+/)?.[0] || '2.1.112';
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
	state.seeded ||= [];
	const hash = (t) => createHash('sha256').update(t).digest('hex');
	for (const id of ids) {
		const src = join(BUILTIN_SKILLS_DIR, id);
		// A built-in the owner turned off gets its updates where it sits, and stays off.
		const dst = existsSync(join(SKILLS_OFF_DIR, id)) ? join(SKILLS_OFF_DIR, id) : join(SKILLS_DIR, id);
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
		if (!state.seeded.includes(id)) state.seeded.push(id);
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
				// A connection dropped halfway ends with neither 'end' nor a req error: without this
				// the update check would wait forever and never run again.
				res.on('error', reject);
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

// ---------------------------------------------------------------- the two agents
// How each is found, started and spoken to is in backends/. `claudeRuntime()` says which
// Claude Code program works on this phone (see backends/claude.mjs for why that is a question).
const claude = createClaudeBackend({ log, serverDir: HERE });
const claudeRuntime = () => claude.runtime();
const runClaude = (spec, args, opts) => claude.run(spec, args, opts);
const noRuntimeMessage = (rt) => claude.noRuntimeMessage(rt);
const agy = createAgyBackend({
	log, home: homedir(), serverDir: HERE, fetchUrl,
	stateDir: dirname(MEMORY_FILE), cacheDir: join(homedir(), '.cache', 'droidagent'),
});

// ---------------------------------------------------------------- our tools, for Antigravity
// A headless agy run cannot ask before it acts. So commands and file writes are offered to it
// as MCP tools of ours (agy_bridge.mjs, started by agy): each call comes back here and goes
// through the conversation's own policy and confirmation cards, exactly as Claude's steps do.
// The token is new on every start and reaches the bridge through agy's MCP configuration.
const BRIDGE_TOKEN = randomBytes(24).toString('hex');
const BRIDGE_URL = `http://127.0.0.1:${PORT}`;
const tokenMatches = (t) => {
	const a = Buffer.from(String(t || ''));
	const b = Buffer.from(BRIDGE_TOKEN);
	return a.length === b.length && timingSafeEqual(a, b);
};
// Before every Antigravity turn: its MCP list, approvals and skills follow the app's.
// One plugin store for both (backends/shared_plugins.mjs): Claude plugins' skills and connectors
// are offered to Antigravity too, and Antigravity plugins' to Claude.
async function prepareAgy() {
	const claudePlugins = await enabledClaudePlugins(join(homedir(), '.claude'), plugins.installed).catch(() => []);
	const fromPlugins = await claudePluginsForAgy(claudePlugins).catch(() => ({ skills: [], connectors: {} }));
	await agy.prepare({
		mode: settings.mode, connectors: { ...fromPlugins.connectors, ...await loadMcpServers() }, skillsDir: SKILLS_DIR,
		bridge: { url: BRIDGE_URL, token: BRIDGE_TOKEN }, pluginSkills: fromPlugins.skills, pluginRoots: claudePlugins.map((p) => p.root),
	});
}
const AGY_PLUGIN_WRAPPERS = join(dirname(MEMORY_FILE), 'agy-plugins');
const agyPluginsForClaudeNow = () => agyPluginsForClaude(join(homedir(), '.gemini'), AGY_PLUGIN_WRAPPERS).catch((e) => { log('[plugins] agy plugins for Claude:', e?.message); return []; });
function killGroup(child) {
	try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
	setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref();
}
function killBridgeJobs(rt) {
	for (const c of rt?.jobs || []) killGroup(c);
}
const BRIDGE_OUTPUT_MAX = 60000;
function bridgeShell(rt, command, timeoutMs) {
	return new Promise((resolve) => {
		const limit = Math.min(Math.max(Number(timeoutMs) || 120000, 1000), 30 * 60 * 1000);
		let out = '';
		let cut = 0;
		let timedOut = false;
		const child = spawn('bash', ['-c', command], { cwd: CWD, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
		rt.jobs.add(child);
		const add = (d) => {
			out += d.toString('utf8');
			// The start and the end both matter; the middle of a flood does not.
			if (out.length > BRIDGE_OUTPUT_MAX * 2) { cut += out.length - BRIDGE_OUTPUT_MAX * 1.5; out = out.slice(0, BRIDGE_OUTPUT_MAX / 2) + out.slice(-BRIDGE_OUTPUT_MAX); }
		};
		child.stdout.on('data', add);
		child.stderr.on('data', add);
		const timer = setTimeout(() => { timedOut = true; killGroup(child); }, limit);
		const done = (code, signal, error) => {
			clearTimeout(timer);
			rt.jobs.delete(child);
			let text = out.length > BRIDGE_OUTPUT_MAX ? `${out.slice(0, BRIDGE_OUTPUT_MAX / 2)}\n…（中间省略了一部分输出）…\n${out.slice(-BRIDGE_OUTPUT_MAX / 2)}` : out;
			if (cut && out.length <= BRIDGE_OUTPUT_MAX) text += '\n…（输出太长，中间省略了一部分）';
			text = text.replace(/\s+$/, '');
			if (error) text += `\n无法执行：${error.message}`;
			else if (timedOut) text += `\n（超过 ${Math.round(limit / 1000)} 秒，已终止）`;
			else if (signal) text += `\n（被信号 ${signal} 终止）`;
			else if (code) text += `\n（退出码 ${code}）`;
			resolve({ ok: !error && !timedOut && !signal && code === 0, text: text.trim() });
		};
		child.on('error', (e) => done(null, null, e));
		child.on('close', (code, signal) => done(code, signal));
	});
}
async function bridgeCall({ token, sessionId, tool, arguments: args }) {
	if (!tokenMatches(token)) return { ok: false, text: '这次调用没有通过验证' };
	let id = String(sessionId || '');
	let rt = runtimes.get(id);
	if (!rt || rt.backend !== 'agy') {
		// The conversation's id did not come through: the one Antigravity turn in progress, if it is the only one.
		const live = [...runtimes.entries()].filter(([, r]) => r.backend === 'agy' && r.running);
		if (live.length !== 1) return { ok: false, text: '找不到这次调用属于哪个对话' };
		[id, rt] = live[0];
	}
	if (!rt.running) return { ok: false, text: '这个对话现在没有在进行的任务' };
	const a = args && typeof args === 'object' ? args : {};
	const decide = async (name, input) => {
		const d = await rt.canUseTool(name, input);
		if (d.behavior === 'allow') return null;
		if (d.interrupt) interruptTurn(id); // "stop" on the card ends the turn, as it does for Claude
		return { ok: false, text: d.message || '用户拒绝了这个操作' };
	};
	if (tool === 'shell') {
		const command = String(a.command || '');
		if (!command.trim()) return { ok: false, text: '没有给出要执行的命令' };
		const refused = await decide('Bash', { command, description: a.description ? String(a.description) : undefined });
		if (refused) return refused;
		if (runtimes.get(id) !== rt || !rt.running) return { ok: false, text: '任务已经停止' };
		return bridgeShell(rt, command, a.timeout_ms);
	}
	if (tool === 'write_file') {
		const file = String(a.path || '');
		if (!file.startsWith('/')) return { ok: false, text: '请给出文件的绝对路径' };
		const content = String(a.content ?? '');
		const refused = await decide('Write', { file_path: file, content });
		if (refused) return refused;
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, content, 'utf8');
		return { ok: true, text: `已写入 ${file}（${Buffer.byteLength(content)} 字节）` };
	}
	if (tool === 'remember') {
		// The assistant's own notes: written in every mode, as for Claude.
		const note = String(a.note || '').replace(/\s*\n\s*/g, ' ').trim().replace(/^-\s*/, '');
		if (!note) return { ok: false, text: '没有给出要记的内容' };
		let text = '';
		try { text = await readFile(MEMORY_FILE, 'utf8'); } catch { /* the first one */ }
		await mkdir(dirname(MEMORY_FILE), { recursive: true });
		await writeFile(MEMORY_FILE, `${text.replace(/\n*$/, text ? '\n' : '')}- ${note}\n`, 'utf8');
		broadcast({ type: 'tool_note', sessionId: id, name: 'remember', title: '记一条经验笔记', auto: true });
		return { ok: true, text: '已记下' };
	}
	return { ok: false, text: `没有这个工具：${tool}` };
}

// Who is signed in, for the page: either account is enough to chat.
async function authState() {
	const [c, a] = [await isLoggedIn(), agy.loggedIn()];
	return { type: 'auth', loggedIn: c || a, accounts: { claude: c, agy: a } };
}
function broadcastAuth() {
	authState().then(broadcast, (e) => log('[auth]', e?.message));
}
// The model in use belongs to an account that is not signed in, and the other one is: move to
// a model that can answer, so the next message does not simply fail.
async function settleModel() {
	const { accounts } = await authState();
	const mine = backendOf(settings.model);
	if (accounts[mine] || !accounts[mine === 'agy' ? 'claude' : 'agy']) return;
	if (mine === 'claude') {
		const first = (await agy.models()).models[0];
		Object.assign(settings, first ? { model: AGY_PREFIX + first.slug, modelName: first.label } : { model: AGY_PREFIX, modelName: 'Antigravity 默认模型' });
	} else Object.assign(settings, { model: 'sonnet', modelName: 'Sonnet 5.5' });
	await persistSettings();
	broadcast({ type: 'settings', settings });
}

// ---------------------------------------------------------------- login (pty)
let login = null;
let loginRequest = 0;
// `provider`: 'claude' (`claude auth login`, login_pty.py) or 'agy' (agy's own sign-in, agy_login_pty.py).
// Both scripts speak the same lines, so the page shows one flow for the two.
async function startLogin(provider = 'claude') {
	cancelLogin();
	const request = ++loginRequest;
	const net = NET[provider] || NET.claude;
	const status = (text, extra = {}) => { if (request === loginRequest) broadcast({ type: 'login_status', text, provider, ...extra }); };
	const fail = (message) => { if (request === loginRequest) broadcast({ type: 'login_done', ok: false, message, provider }); };
	if (provider === 'agy' && !agy.find()) {
		// Not on the phone yet: the same download and checksum as Google's install script.
		try { await agy.install({ onStatus: (t) => status(t) }); } catch (e) { log('[agy] install failed:', e?.message); return fail(`没能装上 Antigravity CLI：${e?.message || e}`); }
		if (request !== loginRequest) return;
	}
	// The CLI inherits the proxy when it starts, so the route has to be right before it does.
	status(`正在检查能否连上 ${net.name}…`);
	const route = await ensureNetwork((text) => status(text), net);
	if (request !== loginRequest) return;
	if (route.changed) status(`已自动改用本机代理 ${route.proxy}`, { proxy: route.proxy, kind: 'ok' });
	else if (!route.ok) status(`连不上 ${net.name} 的服务器（${route.summary}），也没找到可用的本机代理端口。可以继续，但最后一步多半会卡住；建议先在下方填写代理软件的 HTTP 端口。`, { kind: 'warn' });
	let child;
	if (provider === 'agy') {
		const e = agy.env();
		child = spawn('python3', [join(HERE, 'agy_login_pty.py')], {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: {
				...process.env, AGY_BIN: agy.find() || '', AGY_TOKEN_FILE: agy.paths.TOKEN_FILE,
				AGY_ENV: JSON.stringify({ DBUS_SESSION_BUS_ADDRESS: e.DBUS_SESSION_BUS_ADDRESS, AGY_CLI_DISABLE_AUTO_UPDATE: e.AGY_CLI_DISABLE_AUTO_UPDATE }),
			},
		});
	} else {
		const rt = await claudeRuntime();
		if (request !== loginRequest) return; // a newer tap on "start" took over while we were probing
		// The program chat uses first, then anything else that starts. With nothing that passed
		// --version, still let the script try every candidate: its output says why none can start.
		const specs = rt.working.length ? [rt.auth, ...rt.working.filter((w) => w !== rt.auth)] : rt.allSpecs;
		child = spawn('python3', [join(HERE, 'login_pty.py')], {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env, CLAUDE_CLI_SPECS: JSON.stringify(specs.map(({ label, cmd, env }) => ({ label, cmd, env }))) },
		});
	}
	const signedIn = () => (provider === 'agy' ? Promise.resolve(agy.loggedIn()) : isLoggedIn());
	login = child;
	let buf = '';
	let done = false;
	let gotDone = false;
	let loginMode = 'manual'; // 'auto': the link sends the browser straight back to the CLI on localhost
	const finish = (ok, message) => {
		if (done || child.cancelled) return;
		done = true;
		broadcast({ type: 'login_done', ok, message, provider });
		if (login === child) login = null;
		if (ok) {
			// Possibly another account: conversations keep the login they started with otherwise.
			restartRuntimesWhenIdle();
			usageCache = { t: 0, data: null };
			settleModel().catch((e) => log('[login] model:', e?.message)).then(broadcastAuth);
			if (provider === 'agy') agy.models({ fresh: true }).then(() => broadcast({ type: 'agy_updated' }));
		}
	};
	child.stdout.on('data', (d) => {
		buf += d.toString();
		let i;
		while ((i = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, i); buf = buf.slice(i + 1);
			log('[login-pty]', line.startsWith('URL ') ? line.slice(0, 50) + '...' : line);
			if (line.startsWith('MODE ')) loginMode = line.slice(5).trim();
			else if (line.startsWith('URL ')) broadcast({ type: 'login_url', url: line.slice(4).trim(), mode: loginMode, provider });
			else if (line === 'NEED_CODE') broadcast({ type: 'login_need_code' });
			else if (line.startsWith('TOKEN ')) {
				// `claude auth login` doesn't normally print this (login_pty.py keeps the pattern
				// as a harmless fallback) — intentionally not acted on: see the note at LEGACY_TOKEN_FILE.
				log('[login-pty] unexpected TOKEN line from auth login, ignoring');
			} else if (line.startsWith('STATUS ')) {
				broadcast({ type: 'login_status', text: line.slice(7), kind: 'cli', provider });
			} else if (line.startsWith('DONE ')) {
				gotDone = true;
				const ok = line.slice(5).startsWith('ok');
				const message = ok ? '' : line.slice(5).replace(/^fail\s*/, '');
				// A run that stalled after the tokens were already saved still logged in.
				if (ok) finish(true, '');
				else signedIn().then((li) => finish(li, li ? '' : message), () => finish(false, message));
			}
		}
	});
	child.stderr.on('data', (d) => log('[login-err]', String(d).trim().slice(0, 300)));
	child.on('error', (e) => { log('[login-spawn]', e?.message); finish(false, `无法运行登录脚本（python3）：${e?.message || e}`); });
	// 'close', not 'exit': stdout may still hold the DONE line when the process itself has exited.
	child.on('close', (c, sg) => {
		log('[login-exit]', c, sg);
		if (!gotDone) finish(false, `登录进程意外退出（${sg || c}）`);
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
		const c = runClaude(spec, ['auth', 'status'], { stdio: ['ignore', 'pipe', 'ignore'] });
		let out = '';
		const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* */ } resolve(null); }, 15000);
		c.stdout.on('data', (d) => { out += d; });
		// 'close', not 'exit': the output may still be on its way when the process has exited, and
		// reading it too early would look like being logged out.
		c.on('close', () => {
			clearTimeout(t);
			try { resolve(JSON.parse(out)); } catch { resolve(null); }
		});
		c.on('error', () => { clearTimeout(t); resolve(null); });
	});
}

async function isLoggedIn() {
	const s = await getAuthStatus();
	// No answer at all (a busy phone, a slow start) says nothing about the login: go by the stored
	// credentials rather than throwing the login page at someone who is signed in.
	return s ? !!s.loggedIn : !!readOauth()?.accessToken;
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
			res.write(`data: ${JSON.stringify({ type: 'hello', settings, activeSessionId, activeSession: activeSessionId ? forPage(sessionCache.get(activeSessionId)) : null, lastUpdate: lastUpdateInfo() })}\n\n`);
			authState().then((a) => { try { res.write(`data: ${JSON.stringify(a)}\n\n`); } catch { /* */ } });
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

			// Not the picture itself: the conversation's file is rewritten on every event of every turn.
			const kept = (Array.isArray(scopes) ? scopes : []).map(({ dataUrl, ...s }) => s);
			if (runtimes.get(id)?.running || delivering.has(id)) {
				const q = queues.get(id) || [];
				q.push({ id: randomUUID(), text: str, scopes: kept });
				queues.set(id, q);
				broadcastQueue(id);
				return json(res, { ok: true, queued: true });
			}
			heldQueues.delete(id); // the owner is back: what waits follows this one
			await deliverMessage(id, { text: str, scopes: kept });
			return json(res, { ok: true, queued: false });
		}

		// A message in line goes now: ahead of the others, stopping the turn in progress if there is one.
		if (req.method === 'POST' && path === '/api/queue/send-now') {
			const { sessionId, id: itemId } = await body(req);
			const sid = sessionId || activeSessionId;
			const q = queues.get(sid);
			const at = q ? q.findIndex((x) => x.id === itemId) : -1;
			if (at < 0) return json(res, { ok: false, error: '这条消息已经不在队列里了' }, 404);
			q.unshift(...q.splice(at, 1));
			heldQueues.delete(sid);
			broadcastQueue(sid);
			if (runtimes.get(sid)?.running) interruptTurn(sid); // its result sends the next in line
			else drainQueue(sid);
			return json(res, { ok: true });
		}
		// Taken back before it went out. The page puts it in the input box again.
		if (req.method === 'POST' && path === '/api/queue/remove') {
			const { sessionId, id: itemId } = await body(req);
			const sid = sessionId || activeSessionId;
			const q = queues.get(sid);
			const at = q ? q.findIndex((x) => x.id === itemId) : -1;
			if (at < 0) return json(res, { ok: false, error: '这条消息已经发出去了' }, 404);
			const [item] = q.splice(at, 1);
			if (!q.length) forgetQueue(sid);
			broadcastQueue(sid);
			return json(res, { ok: true, text: item.text, scopes: item.scopes });
		}

		// Tool permission decision — routed to the specific conversation's own pending map.
		if (req.method === 'POST' && path === '/api/permission') {
			const { id: permId, decision, sessionId } = await body(req);
			const sid = sessionId || activeSessionId;
			const rt = sid && runtimes.get(sid);
			const p = rt?.pending.get(permId);
			if (!p) return json(res, { ok: false, error: 'gone' }, 404);
			if (decision === 'stop' && queues.get(sid)?.length) { heldQueues.add(sid); broadcastQueue(sid); }
			if (decision === 'allow') p.resolve({ behavior: 'allow', updatedInput: p.input });
			else p.resolve({ behavior: 'deny', message: '用户拒绝了这个操作', interrupt: decision === 'stop' });
			closePermission(sid, permId, decision);
			// An approved plan means "do it": leave Plan mode the way Claude Code does, into Accept edits.
			if (decision === 'allow' && p.toolName === 'ExitPlanMode' && settings.mode === 'plan') {
				settings.mode = 'acceptEdits';
				await persistSettings();
				for (const r of runtimes.values()) tell(() => r.q.setPermissionMode?.('default'));
				broadcast({ type: 'settings', settings });
			}
			return json(res, { ok: true });
		}

		// Stop current run — interrupts only this one conversation's current turn (same granularity
		// as Esc in the terminal); the conversation and its process stay alive, ready for the next message.
		if (req.method === 'POST' && path === '/api/stop') {
			const { sessionId } = await body(req);
			const sid = sessionId || activeSessionId;
			// Stop means stop: what waits in line stays there until the owner says otherwise.
			if (queues.get(sid)?.length) { heldQueues.add(sid); broadcastQueue(sid); }
			if (sid) interruptTurn(sid);
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

		// What the floating panel shows: the conversation at work (the one waiting on the owner first,
		// then the busiest), or the one that worked last, with its recent steps and what it waits on.
		if (path === '/api/overlay/state' && req.method === 'GET') {
			const live = [...runtimes.entries()].filter(([, rt]) => rt.running || rt.pending.size);
			live.sort(([, a], [, b]) => (b.pending.size - a.pending.size) || (b.lastActive - a.lastActive));
			const id = live[0]?.[0] || lastWorkedId || activeSessionId;
			const sess = id ? await getOrLoadSessionObj(id) : null;
			if (!sess) return json(res, { ok: true, id: null, steps: [] });
			const rt = runtimes.get(id);
			const clip = (t, n) => { const s = String(t || ''); return s.length > n ? `${s.slice(0, n)}…` : s; };
			const steps = [];
			for (const m of sess.messages.slice(-40)) {
				if (m.role === 'user') steps.push({ k: 'user', text: clip(typedText(m.text), 400) });
				else if (m.role === 'assistant') steps.push({ k: 'reply', text: clip(m.text, 3000) });
				else if (m.role === 'think') steps.push({ k: 'think', text: clip(m.text, 3000), ms: m.ms || 0 });
				else if (m.role === 'tool' && m.kind !== 'todo') steps.push({ k: 'tool', title: m.title || m.name, state: m.state || 'ok', category: m.category || '' });
				else if (m.role === 'perm') steps.push({ k: 'perm', id: m.id, title: m.title || m.name, detail: clip(m.detail, 600), reason: m.reason || '', verdict: m.verdict || (rt?.pending.has(m.id) ? null : 'expired') });
				else if (m.role === 'sys' || m.role === 'cmdout') steps.push({ k: 'note', text: clip(m.text, 300) });
			}
			return json(res, {
				ok: true, id, title: sess.title || '新对话',
				running: !!rt?.running, waiting: (rt?.pending.size || 0) > 0,
				label: rt?.label || '', since: rt?.since || 0, others: Math.max(0, live.length - 1),
				steps, liveText: rt?.assistantText || '', liveThinking: rt?.thinking?.text || '',
				queue: (queues.get(id) || []).map((q) => clip(typedText(q.text), 200)),
				bg: await bgState(),
			});
		}

		if (path === '/api/bgscreen' && req.method === 'GET') {
			return json(res, { ok: true, ...(await watchBgScreen()) });
		}
		// What is on it now, small, for watching it live.
		if (path === '/api/bgscreen/frame' && req.method === 'GET') {
			const w = Math.max(120, Math.min(720, parseInt(url.searchParams.get('w'), 10) || 360));
			lastWatchedAt = Date.now();
			const file = `${BG_DIR}/frame-${randomUUID().slice(0, 8)}.jpg`;
			const r = await bgCall(`frame ${file} ${w}`, 8000);
			if (!r?.startsWith('ok')) return json(res, { ok: false, error: r ? r.replace(/^err /, '') : '后台屏幕没有打开' }, 404);
			try {
				const img = await readFile(file);
				res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'content-length': img.length });
				return res.end(img);
			} finally {
				await unlink(file).catch(() => {});
			}
		}
		// The owner takes the app: it moves to their screen, where they can see and use it.
		if (path === '/api/bgscreen/show' && req.method === 'POST') {
			const r = await bgCall('takeover');
			watchBgScreen().catch(() => {});
			if (!r?.startsWith('ok')) return json(res, { ok: false, error: r ? r.replace(/^err /, '') : '后台屏幕没有打开' }, 409);
			return json(res, { ok: true, pkg: r.slice(3) });
		}
		if (path === '/api/bgscreen/stop' && req.method === 'POST') {
			await bgCall('quit');
			return json(res, { ok: true, ...(await watchBgScreen()) });
		}

		// Sessions API
		if (path === '/api/sessions' && req.method === 'GET') {
			const idx = await loadSessionsIndex();
			const runningIds = [...runtimes.entries()].filter(([, rt]) => rt.running).map(([sid]) => sid);
			const pendingIds = [...runtimes.entries()].filter(([, rt]) => rt.pending.size > 0).map(([sid]) => sid);
			// What each running conversation is doing and since when, so a reopened page can show it.
			const activity = Object.fromEntries([...runtimes.entries()].filter(([, rt]) => rt.running).map(([sid, rt]) => [sid, { since: rt.since || 0, label: rt.label || '' }]));
			return json(res, {
				activity,
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
			const newSess = await freshSession();
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
			broadcast({ type: 'session_switched', session: forPage(s) });
			return json(res, { ok: true, session: forPage(s) });
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
			s.titleSource = 'user'; // never replaced by a generated one
			await saveSession(s);
			const idx = await loadSessionsIndex();
			broadcast({ type: 'sessions_updated', sessions: idx });
			return json(res, { ok: true, title: s.title });
		}

		// Delete one conversation — only THIS one's runtime (if any) is torn down.
		if (path === '/api/sessions/delete' && req.method === 'POST') {
			const { id } = await body(req);
			if (!id) return json(res, { ok: false, error: 'no id' }, 400);
			forgetQueue(id); // first: tearing the runtime down must not send what waits
			teardownRuntime(id);
			sessionCache.delete(id);
			try {
				await unlink(join(SESSIONS_DIR, `${id}.json`));
			} catch {}
			const nextIdx = await withLock('sessions-index', async () => {
				const list = (await loadSessionsIndex()).filter((s) => s.id !== id);
				await saveSessionsIndex(list);
				return list;
			});

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
				broadcast({ type: 'session_switched', session: forPage(switched) });
			}
			broadcast({ type: 'sessions_updated', sessions: nextIdx });
			return json(res, { ok: true, activeSession: forPage(switched || (activeSessionId ? sessionCache.get(activeSessionId) : null)) });
		}

		// Clear ALL history — this is the one case that legitimately ends every open conversation.
		if (path === '/api/sessions/clear' && req.method === 'POST') {
			queues.clear();
			heldQueues.clear();
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
				let resolved = resolve(targetPath);
				let st = await stat(resolved).catch(() => null);
				// A path typed or pasted into the search box: a file shows itself in its folder, and a
				// name still being typed shows what it could become.
				let startsWith = null;
				if (!st?.isDirectory()) {
					startsWith = basename(resolved).toLowerCase();
					resolved = dirname(resolved);
					st = await stat(resolved).catch(() => null);
					if (!st?.isDirectory()) return json(res, { ok: false, error: '没有这个路径' }, 400);
				}

				let items;
				if (q) {
					items = await fsSearch(resolved, q);
				} else {
					const entries = await readdir(resolved, { withFileTypes: true });
					items = [];
					for (const ent of entries) {
						if (startsWith !== null ? !ent.name.toLowerCase().startsWith(startsWith) : ent.name.startsWith('.')) continue;
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
					filtered: startsWith !== null,
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
			const matches = dataUrl.match(/^data:([\w.+\/-]+);base64,(.+)$/);
			if (!matches || matches.length !== 3) return json(res, { ok: false, error: 'invalid data url' }, 400);
			const ext = (filename && extname(filename)) ? extname(filename) : '.png';
			const uploadPath = `/tmp/agent-upload-${randomUUID()}${ext}`;
			const buffer = Buffer.from(matches[2], 'base64');
			await writeFile(uploadPath, buffer);
			return json(res, { ok: true, path: uploadPath, filename: filename || basename(uploadPath) });
		}

		// Settings API — these are app-wide, so push live changes to every open conversation, not just one.
		if (req.method === 'POST' && path === '/api/settings') {
			const next = await body(req);
			if ('mode' in next && !MODES.includes(next.mode)) delete next.mode; // unknown mode: keep the current one
			// Fixed when a process starts: effort, fast mode and how thinking is asked for.
			const fixedAtStart = () => JSON.stringify([settings.effort, settings.fastMode, thinkingFor(settings.model)]);
			const before = fixedAtStart();
			for (const k of SETTING_KEYS) if (k in next) settings[k] = next[k];
			await persistSettings();
			if (fixedAtStart() !== before) restartRuntimesWhenIdle();
			for (const rt of runtimes.values()) {
				tell(() => rt.q.setPermissionMode?.(settings.mode === 'plan' ? 'plan' : 'default'));
				// A model of the other agent is not this process's to switch to: the next message replaces it.
				if (rt.backend === 'claude' && backendOf(settings.model) === 'claude') tell(() => rt.q.setModel?.(claude.modelFor(rt.chatSpec, settings.model)));
			}
			broadcast({ type: 'settings', settings });
			return json(res, { ok: true, settings });
		}

		// ---- The assistant's notes ----
		if (path === '/api/memory' && req.method === 'GET') {
			let text = '';
			try { text = await readFile(MEMORY_FILE, 'utf8'); } catch { /* none */ }
			return json(res, { ok: true, text, path: MEMORY_FILE });
		}
		if (path === '/api/memory' && req.method === 'POST') {
			const { text } = await body(req);
			await mkdir(dirname(MEMORY_FILE), { recursive: true });
			await writeFile(MEMORY_FILE, String(text || ''), 'utf8');
			return json(res, { ok: true });
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
			// Applies to new conversations only: the SDK builds systemPrompt once at query() creation, and
			// the current Claude Code keeps a conversation's original prompt even when it is resumed.
			broadcast({ type: 'systemprompt_saved' });
			return json(res, { ok: true });
		}

		// ---- Skills ----
		if (path === '/api/skills' && req.method === 'GET') {
			return json(res, { ok: true, skills: await listSkills() });
		}
		if (path === '/api/skills/install' && req.method === 'POST') {
			const { source } = await body(req);
			try {
				const installed = await installSkill(String(source || '').trim());
				await afterSkillChange();
				return json(res, { ok: true, installed, skills: await listSkills() });
			} catch (e) {
				return json(res, { ok: false, error: e?.message || '安装失败' }, 500);
			}
		}
		if (path === '/api/skills/toggle' && req.method === 'POST') {
			const { id, enabled } = await body(req);
			try { await setSkillEnabled(id, !!enabled); }
			catch (e) { return json(res, { ok: false, error: e?.message }, 400); }
			await afterSkillChange();
			return json(res, { ok: true, skills: await listSkills() });
		}
		if (path === '/api/skills/delete' && req.method === 'POST') {
			const { id } = await body(req);
			if (!safeId(id)) return json(res, { ok: false, error: '技能名称无效' }, 400);
			for (const dir of [SKILLS_DIR, SKILLS_OFF_DIR]) {
				try { await rm(join(dir, id), { recursive: true, force: true }); } catch { /* */ }
			}
			await afterSkillChange();
			return json(res, { ok: true, skills: await listSkills() });
		}
		if (path === '/api/skills/repair' && req.method === 'POST') {
			const { id } = await body(req);
			if (!safeId(id)) return json(res, { ok: false, error: '技能名称无效' }, 400);
			try {
				const installed = await repairSkill(id);
				await afterSkillChange();
				return json(res, { ok: true, installed, skills: await listSkills() });
			} catch (e) {
				return json(res, { ok: false, error: e?.message || '修复失败' }, 400);
			}
		}
		if (path === '/api/skills/drafts' && req.method === 'GET') {
			return json(res, { ok: true, drafts: await listSkillDrafts() });
		}
		if (path === '/api/skills/drafts/publish' && req.method === 'POST') {
			const { id, overwrite } = await body(req);
			if (!safeId(id)) return json(res, { ok: false, error: '草稿名称无效' }, 400);
			const draft = (await listSkillDrafts()).find((d) => d.id === id);
			if (!draft) return json(res, { ok: false, error: '草稿不存在' }, 404);
			if (draft.errors.length) return json(res, { ok: false, error: draft.errors.join('；') }, 400);
			try {
				await placeSkill(join(SKILL_DRAFTS_DIR, id), id, { move: true, overwrite: !!overwrite });
			} catch (e) {
				return json(res, { ok: false, error: e?.message, exists: /已经有一个/.test(e?.message || '') }, 400);
			}
			draftsSeen.delete(id);
			await afterSkillChange();
			return json(res, { ok: true, skills: await listSkills() });
		}
		if (path === '/api/skills/drafts/discard' && req.method === 'POST') {
			const { id } = await body(req);
			if (!safeId(id)) return json(res, { ok: false, error: '草稿名称无效' }, 400);
			await rm(join(SKILL_DRAFTS_DIR, id), { recursive: true, force: true });
			draftsSeen.delete(id);
			broadcast({ type: 'skills_updated' });
			return json(res, { ok: true });
		}

		// ---- Extension market ----
		if (path === '/api/market/skills' && req.method === 'GET') {
			const skills = await listSkills();
			const items = (await readCatalog('skills.json')).map((c) => {
				const have = skills.find((s) => s.id === c.id);
				return { ...c, installed: !!have, enabled: !!have?.enabled };
			});
			return json(res, { ok: true, items });
		}
		if (path === '/api/market/connectors' && req.method === 'GET') {
			const q = String(url.searchParams.get('q') || '').trim().slice(0, 80);
			const { servers = {} } = await readMcpFile();
			const mark = (c, source) => {
				const name = connectorName(c.id);
				return { ...c, name, source, added: !!servers[name] };
			};
			const needle = q.toLowerCase();
			const curated = (await readCatalog('connectors.json'))
				.filter((c) => !needle || `${c.id} ${c.title} ${c.description}`.toLowerCase().includes(needle))
				.map((c) => mark(c, 'curated'));
			let registry = [];
			let registryError = '';
			if (q) {
				try { registry = (await searchRegistry(q)).map((c) => mark(c, 'registry')); }
				catch (e) { registryError = e?.message || '搜索失败'; }
			}
			return json(res, { ok: true, curated, registry, registryError });
		}
		if (path === '/api/market/connectors/add' && req.method === 'POST') {
			const { id, source, values, confirmed, overwrite } = await body(req);
			const known = source === 'curated' ? (await readCatalog('connectors.json')).find((c) => c.id === id) : registrySeen.get(id);
			if (!known) return json(res, { ok: false, error: '找不到这个连接器，请重新搜索' }, 404);
			const name = connectorName(known.id);
			if (!name) return json(res, { ok: false, error: '连接器名称无效' }, 400);
			if (known.type === 'stdio' && !confirmed) return json(res, { ok: false, error: '本地命令需要确认' }, 400);
			let entry;
			try { entry = buildMcpEntry(known, values || {}); }
			catch (e) { return json(res, { ok: false, error: e?.message }, 400); }
			const cfg = await readMcpFile();
			cfg.servers ||= {};
			if (cfg.servers[name] && !overwrite) return json(res, { ok: false, error: `已经有一个叫「${name}」的连接器`, exists: true }, 400);
			cfg.servers[name] = { ...entry, ...(known.auth ? { auth: known.auth } : {}), origin: source };
			await writeMcpFile(cfg);
			await applyMcpToAllRuntimes();
			broadcast({ type: 'mcp_updated' });
			return json(res, { ok: true, name });
		}
		if (path === '/api/market/plugins' && req.method === 'GET') {
			try {
				// Only the first load waits. After that the list answers at once and refreshes behind it.
				if (!plugins.loadedAt) await loadPluginCatalog();
				else loadPluginCatalog().catch((e) => log('[market] catalog refresh', e?.message));
				const q = url.searchParams.get('q') || '';
				const known = [...plugins.known.values()];
				const installed = mergePlugins(known, plugins.installed, { q, view: 'installed', limit: 1000 });
				for (const p of installed.items) {
					if (!p.description) p.description = await pluginDescription(p);
					delete p.installPath;
				}
				const discover = mergePlugins(known, plugins.installed, { q, view: 'discover', limit: 40, offset: Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0) });
				return json(res, { ok: true, installed: installed.items, installedCount: plugins.installed.length, items: discover.items, total: discover.total, jobs: [...plugins.jobs.values()] });
			} catch (e) {
				return json(res, { ok: false, error: e?.message || '读取插件目录失败' }, 502);
			}
		}
		if (path === '/api/market/plugins/inspect' && req.method === 'GET') {
			const id = url.searchParams.get('id');
			if (!isPluginId(id)) return json(res, { ok: false, error: '插件名称无效' }, 400);
			try { return json(res, { ok: true, ...(await inspectInstalled(id)) }); }
			catch (e) { return json(res, { ok: false, error: e?.message }, 500); }
		}
		if (path === '/api/market/plugins/download' && req.method === 'POST') {
			const { id } = await body(req);
			if (!isPluginId(id)) return json(res, { ok: false, error: '插件名称无效' }, 400);
			startPluginDownload(id);
			return json(res, { ok: true });
		}
		if (path === '/api/market/plugins/set' && req.method === 'POST') {
			const { id, enabled } = await body(req);
			if (!isPluginId(id)) return json(res, { ok: false, error: '插件名称无效' }, 400);
			try {
				const now = await setPluginEnabled(id, !!enabled);
				pluginsChanged();
				return json(res, { ok: true, enabled: now });
			} catch (e) { return json(res, { ok: false, error: e?.message }, 500); }
		}
		if (path === '/api/market/plugins/uninstall' && req.method === 'POST') {
			const { id } = await body(req);
			if (!isPluginId(id)) return json(res, { ok: false, error: '插件名称无效' }, 400);
			try {
				await pluginTask(async () => { await claudeCli(['plugin', 'uninstall', id]); await refreshInstalledPlugins(); });
				pluginsChanged();
				return json(res, { ok: true });
			} catch (e) { return json(res, { ok: false, error: e?.message }, 500); }
		}
		if (path === '/api/market/marketplaces' && req.method === 'GET') {
			try {
				const list = await cliJson(['plugin', 'marketplace', 'list', '--json']);
				return json(res, { ok: true, marketplaces: list.map((m) => ({ name: m.name, url: m.url || m.repo || '', official: OFFICIAL_NAMES.has(m.name) })) });
			} catch (e) { return json(res, { ok: false, error: e?.message }, 500); }
		}
		if (path === '/api/market/marketplaces/add' && req.method === 'POST') {
			const { source } = await body(req);
			const src = normalizeMarketplaceSource(source);
			if (!src) return json(res, { ok: false, error: '只支持 https 地址或 GitHub 的 owner/repo' }, 400);
			try {
				await pluginTask(() => claudeCli(['plugin', 'marketplace', 'add', src], { timeout: 300000 }));
				await loadPluginCatalog({ force: true });
				return json(res, { ok: true });
			} catch (e) { return json(res, { ok: false, error: e?.message }, 500); }
		}
		if (path === '/api/market/marketplaces/remove' && req.method === 'POST') {
			const { name } = await body(req);
			if (!safeId(name)) return json(res, { ok: false, error: '名称无效' }, 400);
			if (OFFICIAL_NAMES.has(name)) return json(res, { ok: false, error: '官方市场不能移除' }, 400);
			try {
				await pluginTask(() => claudeCli(['plugin', 'marketplace', 'remove', name]));
				plugins.known.clear();
				await loadPluginCatalog({ force: true });
				pluginsChanged();
				return json(res, { ok: true });
			} catch (e) { return json(res, { ok: false, error: e?.message }, 500); }
		}

		// ---- GitHub projects ----
		if (path === '/api/github/status' && req.method === 'GET') {
			return json(res, await githubStatus());
		}
		// Saves the token as the GitHub MCP connector (on for both agents), after GitHub accepts it.
		if (path === '/api/github/connect' && req.method === 'POST') {
			const { token } = await body(req);
			const t = String(token || '').trim();
			if (!/^[\w-]{20,255}$/.test(t)) return json(res, { ok: false, error: '令牌格式不对：应是 ghp_ / github_pat_ 开头的一串字符' }, 400);
			let user;
			try { user = await githubApi('/user', t); } catch (e) {
				return json(res, { ok: false, error: /HTTP 401/.test(e?.message || '') ? 'GitHub 不认这个令牌，请检查是否复制完整、是否过期' : `连不上 GitHub：${e?.message || e}` }, 400);
			}
			const known = (await readCatalog('connectors.json')).find((c) => c.id === GITHUB_MCP);
			const cfg = await readMcpFile();
			cfg.servers ||= {};
			cfg.servers[GITHUB_MCP] = { ...buildMcpEntry(known, { Authorization: t }), auth: known.auth, origin: 'curated' };
			await writeMcpFile(cfg);
			const g = await readGithubFile();
			g.login = user?.login || '';
			await writeGithubFile(g);
			applyGithubEnv(t);
			restartRuntimesWhenIdle(); // the commands an agent runs take GH_TOKEN from its process
			await applyMcpToAllRuntimes();
			broadcast({ type: 'mcp_updated' });
			return json(res, { ...(await githubStatus()), login: g.login });
		}
		if (path === '/api/github/disconnect' && req.method === 'POST') {
			const cfg = await readMcpFile();
			if (cfg.servers?.[GITHUB_MCP]) {
				delete cfg.servers[GITHUB_MCP];
				await writeMcpFile(cfg);
			}
			const g = await readGithubFile();
			delete g.login;
			await writeGithubFile(g);
			applyGithubEnv('');
			restartRuntimesWhenIdle();
			await applyMcpToAllRuntimes();
			broadcast({ type: 'mcp_updated' });
			return json(res, await githubStatus());
		}
		if (path === '/api/github/repos' && req.method === 'GET') {
			const token = await githubToken();
			if (!token) return json(res, { ok: false, error: '还没有连接 GitHub', needToken: true }, 400);
			const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
			try {
				let list;
				if (q) {
					const g = await readGithubFile();
					const who = g.login ? ` user:${g.login}` : '';
					list = (await githubApi(`/search/repositories?per_page=30&q=${encodeURIComponent(q + who)}`, token)).items || [];
				} else {
					list = await githubApi('/user/repos?sort=updated&per_page=60&affiliation=owner,collaborator,organization_member', token);
				}
				const repos = (Array.isArray(list) ? list : []).map((r) => ({
					repo: r.full_name, url: r.html_url, private: !!r.private, description: r.description || '', branch: r.default_branch || '',
					language: r.language || '', stars: r.stargazers_count || 0, updated: r.pushed_at || r.updated_at || '', fork: !!r.fork,
				}));
				return json(res, { ok: true, repos });
			} catch (e) {
				return json(res, { ok: false, error: /HTTP 401/.test(e?.message || '') ? '令牌已失效，请重新连接 GitHub' : `读取仓库失败：${e?.message || e}` }, 502);
			}
		}
		// A repository put on the conversation: checked, normalized and remembered.
		if (path === '/api/github/link' && req.method === 'POST') {
			const { repo, description, private: priv } = await body(req);
			const r = parseGithubRepo(repo);
			if (!r) return json(res, { ok: false, error: '请输入 owner/repo 或 GitHub 仓库链接' }, 400);
			await rememberGithubRepo({ ...r, description, private: priv });
			return json(res, { ok: true, ...r, mcp: (await githubStatus()).enabled });
		}
		if (path === '/api/github/forget' && req.method === 'POST') {
			const { repo } = await body(req);
			const g = await readGithubFile();
			g.recent = (g.recent || []).filter((x) => x.repo !== repo);
			await writeGithubFile(g);
			return json(res, await githubStatus());
		}

		// ---- MCP ----
		// Each conversation's query() is its own process with its own MCP connections, so "status"
		// is inherently per-conversation — show whichever one the screen is currently on.
		if (path === '/api/mcp' && req.method === 'GET') {
			const cfg = await readMcpFile();
			// Connectors from the account and plugins exist only in a running Claude Code. With none
			// running, start the visible conversation's: it connects its servers but sends nothing to
			// the model, and the idle reaper frees it again.
			let rt = anyRuntime();
			// The page says which: after a restart the server has no current conversation of its own.
			const probe = url.searchParams.get('probe');
			const probeId = probe === '1' ? activeSessionId : probe;
			if (!rt && probeId) {
				try { rt = await ensureRuntime(probeId); } catch (e) { log('[mcp] probe', e?.message); }
			}
			return json(res, { ok: true, servers: cfg.servers || {}, status: await liveMcpStatus(rt), live: !!rt });
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
			// A copy registered for sign-in would otherwise keep it connected while switched off.
			if (!enabled && cfg.servers[name].loginRegistered) await claudeCli(['mcp', 'remove', '--scope', 'user', name]).catch(() => {});
			await applyMcpToAllRuntimes();
			broadcast({ type: 'mcp_updated' });
			return json(res, { ok: true });
		}
		if (path === '/api/mcp/remove' && req.method === 'POST') {
			const { name } = await body(req);
			const cfg = await readMcpFile();
			const was = cfg.servers?.[name];
			if (cfg.servers) delete cfg.servers[name];
			await writeMcpFile(cfg);
			if (was?.loginRegistered) await claudeCli(['mcp', 'remove', '--scope', 'user', name]).catch(() => {});
			await applyMcpToAllRuntimes();
			broadcast({ type: 'mcp_updated' });
			return json(res, { ok: true });
		}
		// Sign in to a connector that uses OAuth. Claude Code 2.1.112 has no `mcp login`: there the
		// page falls back to asking Claude to call the server's own authenticate tool in a chat.
		if (path === '/api/mcp/login' && req.method === 'POST') {
			const { name } = await body(req);
			const cfg = await readMcpFile();
			const entry = cfg.servers?.[name];
			// Not ours: only a name Claude Code itself reports goes on to its command line.
			if (!entry && !(await liveMcpStatus(anyRuntime())).some((s) => s.name === name)) return json(res, { ok: false, error: '找不到这个连接器' }, 404);
			if (typeof name !== 'string' || name.startsWith('-')) return json(res, { ok: false, error: '连接器名称无效' }, 400);
			if (entry?.type === 'stdio') return json(res, { ok: false, error: '本地命令型连接器不需要授权' }, 400);
			const account = !entry && name.startsWith('claude.ai ');
			let hasLogin;
			try {
				// `mcp login --help` succeeds even without that command, so read the command list.
				hasLogin = /^\s*login\b/m.test(await claudeCli(['mcp', '--help'], { timeout: 45000 }));
			} catch (e) { return json(res, { ok: false, error: e?.message }, 500); }
			if (account) {
				// Authorized on claude.ai itself: the command only prints the link, and exits.
				let link = '';
				if (hasLogin) {
					const r = await claudeCli(['mcp', 'login', name, '--no-browser'], { timeout: 60000, raw: true }).catch(() => null);
					link = `${r?.out || ''}\n${r?.err || ''}`.match(/https:\/\/[^\s"'<>]+/)?.[0] || '';
				}
				return json(res, { ok: true, url: link || CLAUDE_CONNECTORS_URL });
			}
			if (!hasLogin) return json(res, { ok: true, fallback: 'chat' });
			try {
				await startMcpLogin(name, entry || null);
				if (entry) { entry.loginRegistered = true; await writeMcpFile(cfg); }
				return json(res, { ok: true });
			} catch (e) { return json(res, { ok: false, error: e?.message }, 500); }
		}
		if (path === '/api/mcp/login/cancel' && req.method === 'POST') { cancelMcpLogin(); return json(res, { ok: true }); }
		if (path === '/api/mcp/reconnect' && req.method === 'POST') {
			const { name } = await body(req);
			const live = [...runtimes.values()].filter((rt) => rt.q?.reconnectMcpServer);
			if (!live.length) return json(res, { ok: false, error: '还没有进行中的对话，先发一条消息再重试' }, 400);
			// Each conversation holds its own connection.
			const results = await Promise.allSettled(live.map((rt) => withTimeout(rt.q.reconnectMcpServer(name), 45000, '连接超时')));
			const bad = results.find((r) => r.status === 'rejected');
			broadcast({ type: 'mcp_updated' });
			return bad ? json(res, { ok: false, error: bad.reason?.message || '连接失败' }, 500) : json(res, { ok: true });
		}
		// Connectors that aren't ours (account, plugins): Claude Code keeps the on/off itself.
		if (path === '/api/mcp/external-toggle' && req.method === 'POST') {
			const { name, enabled } = await body(req);
			const live = [...runtimes.values()].filter((rt) => rt.q?.toggleMcpServer);
			if (!live.length) return json(res, { ok: false, error: '还没有进行中的对话，先发一条消息再操作' }, 400);
			const results = await Promise.allSettled(live.map((rt) => withTimeout(rt.q.toggleMcpServer(name, !!enabled), 45000, '操作超时')));
			const bad = results.find((r) => r.status === 'rejected');
			broadcast({ type: 'mcp_updated' });
			return bad ? json(res, { ok: false, error: bad.reason?.message || '操作失败' }, 500) : json(res, { ok: true });
		}

		// ---- Slash commands (for the composer's "/" autocomplete) ----
		// The base is a running conversation's own list, or the static one when none runs. Skills on
		// disk always go in, so the answer never waits on a process. `probe` (the "/" was just typed)
		// starts the visible conversation for the rest of the list, such as plugin skills: that sends
		// nothing to the model, and the page hears when it is ready.
		if (path === '/api/commands' && req.method === 'GET') {
			const sid = url.searchParams.get('sessionId') || activeSessionId;
			noticeSkillChanges().catch((e) => log('[skills] change scan', e?.message));
			if (backendOf(settings.model) === 'agy') return json(res, { ok: true, commands: await slashCommandsWith(AGY_SLASH_COMMANDS) });
			const rt = (sid && runtimes.get(sid)) || anyRuntime();
			if (!rt && sid && url.searchParams.get('probe')) {
				ensureRuntime(sid)
					.then((started) => (started.q.supportedCommands ? withTimeout(started.q.supportedCommands(), 60000, 'timeout') : null))
					.then(() => broadcast({ type: 'skills_updated' }))
					.catch((e) => log('[commands] probe', e?.message));
			}
			let live = null;
			if (rt?.q?.supportedCommands) {
				try { live = await withTimeout(rt.q.supportedCommands(), 3000, 'timeout'); } catch (e) { log('[commands]', e?.message); }
			}
			return json(res, { ok: true, commands: await slashCommandsWith(live || STATIC_SLASH_COMMANDS) });
		}

		// ---- Usage / quota (experimental SDK API) ----
		// Borrows an already-running conversation's process rather than spinning up a hidden one
		// just to check a number — if nothing is running yet, say so instead of starting a ghost chat.
		if (path === '/api/usage' && req.method === 'GET') {
			const fresh = url.searchParams.get('fresh') === '1';
			if (backendOf(settings.model) === 'agy') {
				// agy's own /usage: one group per family of models, the ring shows the one in use.
				const u = await agy.usage({ fresh });
				if (!u.ok) return json(res, { ok: false, error: u.error });
				const win = (g, w) => { const b = g?.buckets.find((x) => x.window === w); return b ? { utilization: b.utilization, resets_at: b.resets_at } : null; };
				const mine = usageGroupFor(u.groups, agySlug(settings.model));
				return json(res, {
					ok: true, provider: 'agy', rate_limits_available: true, cost: null, current: mine?.name || null,
					rate_limits: { five_hour: win(mine, '5h'), seven_day: win(mine, 'week') },
					groups: u.groups.map((g) => ({ name: g.name, five_hour: win(g, '5h'), seven_day: win(g, 'week') })),
				});
			}
			if (!fresh && usageCache.data && Date.now() - usageCache.t < 60000) return json(res, { ok: true, ...usageCache.data });
			let plan;
			try { plan = await fetchPlanUsage(); } catch (e) { plan = { ok: false, error: `读取用量失败：${e?.message || e}` }; }
			// The SDK's own call (newer SDKs only) adds this conversation's cost, and stands in for
			// the direct call if that failed.
			const rt = anyRuntime();
			const fn = rt?.q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
			let sdkUsage = null;
			if (typeof fn === 'function') { try { sdkUsage = await withTimeout(fn.call(rt.q, { skipBehaviors: true }), 8000, 'timeout'); } catch { /* */ } }
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
			const newSess = await freshSession();
			activeSessionId = newSess.id;
			broadcast({ type: 'session_switched', session: newSess });
			const idx = await loadSessionsIndex();
			broadcast({ type: 'sessions_updated', sessions: idx });
			return json(res, { ok: true, session: newSess });
		}

		if (path === '/api/status') {
			const auth = await authState();
			return json(res, { settings, loggedIn: auth.loggedIn, accounts: auth.accounts, running: [...runtimes.values()].some((rt) => rt.running) });
		}

		// Login flow
		if (req.method === 'POST' && path === '/api/login/start') {
			const { provider } = await body(req);
			startLogin(provider === 'agy' ? 'agy' : 'claude').catch((e) => log('[login]', e?.message));
			return json(res, { ok: true });
		}
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
			return json(res, { ok: !!r.chat, chat: r.chat ? { label: r.chat.label, version: r.chat.version, env: r.chat.env } : null, tried: r.tried, cwd: CWD, node: process.version });
		}

		// ---- Network proxy ----
		if (path === '/api/netcheck' && req.method === 'GET') {
			const proxy = readProxySetting();
			const c = await checkAnthropic(proxy || null);
			return json(res, { ok: c.ok, proxy, summary: c.summary, localProxy: c.ok ? null : await findLocalProxy(proxy) });
		}
		if (path === '/api/proxy' && req.method === 'GET') return json(res, { ok: true, proxy: readProxySetting() });
		if (path === '/api/proxy' && req.method === 'POST') {
			const b = await body(req);
			const proxy = String(b.proxy || '').trim();
			if (!validProxy(proxy)) return json(res, { ok: false, error: '格式应为 http://主机:端口，例如 http://127.0.0.1:7890' }, 400);
			await saveProxySetting(proxy);
			log('[proxy]', proxy || '(none)');
			const net = NET[b.provider] || NET.claude; // tested against whichever account is being signed in to
			const check = await checkHosts(net.hosts, proxy || null);
			return json(res, { ok: true, proxy, reachable: check.ok, summary: check.summary, name: net.name });
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
			// A running conversation holds the token in memory and would carry on as the old account.
			for (const id of [...queues.keys()]) { forgetQueue(id); broadcastQueue(id); }
			for (const id of [...runtimes.keys()]) teardownRuntime(id);
			usageCache = { t: 0, data: null };
			await settleModel().catch(() => {});
			broadcastAuth();
			return json(res, { ok: true });
		}

		// ---- Antigravity: the CLI itself, its account, models, plugins
		if (path === '/api/agy/status' && req.method === 'GET') {
			const st = await agy.status();
			const m = st.installed && st.loggedIn ? await agy.models({ fresh: url.searchParams.get('fresh') === '1' }) : { models: [] };
			return json(res, { ok: true, ...st, models: m.models.map((x) => ({ id: AGY_PREFIX + x.slug, name: x.label })), modelsError: m.error || null });
		}
		if (path === '/api/agy/install' && req.method === 'POST') {
			const { force } = await body(req);
			const say = (text, extra = {}) => broadcast({ type: 'agy_install', text, ...extra });
			agy.install({ onStatus: (t) => say(t), force: !!force }).then(
				(r) => say(r.updated ? `已安装 Antigravity CLI ${r.version}` : `已经是最新版本（${r.version}）`, { done: true, ok: true }),
				(e) => { log('[agy] install failed:', e?.message); say(`没能装上：${e?.message || e}`, { done: true, ok: false }); },
			).then(() => broadcast({ type: 'agy_updated' }));
			return json(res, { ok: true });
		}
		if (path === '/api/agy/logout' && req.method === 'POST') {
			await agy.logout();
			// A turn in progress would carry on with the login it started with.
			for (const [id, rt] of [...runtimes]) if (rt.backend === 'agy') { forgetQueue(id); broadcastQueue(id); teardownRuntime(id); }
			await settleModel().catch(() => {});
			broadcastAuth();
			broadcast({ type: 'agy_updated' });
			return json(res, { ok: true });
		}
		if (path === '/api/agy/plugins' && req.method === 'GET') return json(res, await agy.plugins());
		if (path === '/api/agy/plugins/install' && req.method === 'POST') {
			const r = await agy.installPlugin((await body(req)).source);
			if (r.ok) restartRuntimesWhenIdle();
			return json(res, r);
		}
		// A tool call from agy_bridge.mjs. It may wait a long time: for the owner's answer, then for the command.
		if (path === '/api/agy-bridge/call' && req.method === 'POST') {
			const b = await body(req);
			req.setTimeout(0); res.setTimeout(0);
			let r;
			try { r = await bridgeCall(b); } catch (e) { log('[bridge]', e?.stack || e); r = { ok: false, text: `出错了：${e?.message || e}` }; }
			return json(res, { ok: !!r.ok, text: String(r.text ?? '') });
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

		// ---- Release notes: shipped as web/changelog.md; the repository's own copy when run from a checkout ----
		if (path === '/api/changelog' && req.method === 'GET') {
			for (const f of [join(WEB, 'changelog.md'), join(HERE, '..', '..', 'CHANGELOG.md')]) {
				try { return json(res, { ok: true, text: await readFile(f, 'utf8') }); } catch { /* next */ }
			}
			return json(res, { ok: false, error: '没有找到更新记录' });
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
await migrateSkillState().catch((e) => log('[skills] migration failed', e?.message));
await seedBuiltinSkills().catch((e) => log('[skills] seeding failed', e?.message));
for (const d of await listSkillDrafts().catch(() => [])) draftsSeen.set(d.id, d.mtime); // only announce new ones
await refreshSkillNames();
await slashCommandsWith([]).catch(() => {}); // what counts as a skill from the start
({ skills: skillsSeen, plugins: pluginsSeen } = await changeMarks().catch(() => ({ skills: '', plugins: '' })));
server.listen(PORT, HOST, () => {
	log(`agent app on http://${HOST}:${PORT}  cwd=${CWD}`);
	claudeRuntime().catch((e) => log('[runtime] probe failed', e?.message)); // find a working claude before anyone asks
	if (!process.env.DROIDAGENT_NO_UPDATE) scheduleUpdateCheck(2 * 60e3); // let startup settle first
});
