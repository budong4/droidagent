// Parsing and checking for the extension market. No side effects beyond reading the directory it
// is given, so it can be tested without a phone. These functions are the safety boundary between
// text from the internet and the commands run as root in server.mjs: anything they accept ends up
// as a git argument, a directory name or a hook shown to the owner.
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

// The official marketplaces. HTTPS on purpose: `owner/repo` makes Claude Code clone over SSH, and
// a phone has no SSH key.
export const OFFICIAL_MARKETPLACES = [
	{ name: 'claude-plugins-official', url: 'https://github.com/anthropics/claude-plugins-official.git' },
	{ name: 'anthropic-agent-skills', url: 'https://github.com/anthropics/skills.git' },
];
// Claude Code 2.1.112 refuses a whole marketplace when one entry uses a kind of source it doesn't
// know, and the official one now has such an entry. That runtime gets a copy of the official
// catalog without those entries, under a name of its own: the official name is reserved for
// GitHub sources from anthropics, and a name that looks official is refused as well.
export const COMPAT_MARKETPLACE = 'droidagent-plugins';
export const COMPAT_OF = 'claude-plugins-official';
const LEGACY_SOURCE_KINDS = new Set(['github', 'url', 'git', 'git-subdir', 'npm', 'pip', 'directory', 'file']);
export function compatibleMarketplace(j) {
	const all = Array.isArray(j?.plugins) ? j.plugins : [];
	const keep = all.filter((p) => typeof p?.source === 'string' || LEGACY_SOURCE_KINDS.has(p?.source?.source));
	return { json: { ...j, name: COMPAT_MARKETPLACE, plugins: keep }, dropped: all.filter((p) => !keep.includes(p)).map((p) => p?.name) };
}
// Listed by Anthropic. Plugin authors can still be third parties, so the UI says "官方目录", never "safe".
export const OFFICIAL_NAMES = new Set(['claude-plugins-official', 'anthropic-agent-skills', 'anthropic-plugin-directory', COMPAT_MARKETPLACE]);

const SEGMENT = /^[A-Za-z0-9_][\w.-]*$/;

// A single directory name that cannot leave its parent or read as a command-line option.
export function safeId(s) {
	return typeof s === 'string' && /^[A-Za-z0-9][\w.-]{0,63}$/.test(s) && !s.includes('..');
}

// base + rel, or null when rel would end up outside base.
export function resolveInside(base, rel) {
	if (typeof rel !== 'string' || !rel || rel.startsWith('/') || rel.includes('\0')) return null;
	const full = posix.normalize(posix.join(base, rel));
	return full.startsWith(base.replace(/\/+$/, '') + '/') ? full : null;
}

const cleanSegments = (path) => path.split('/').every((p) => p && p !== '.' && p !== '..' && SEGMENT.test(p));

// What the owner typed or a catalog entry says -> how to fetch it. Null means refuse.
export function parseSkillSource(input) {
	const src = String(input ?? '').trim();
	if (src.startsWith('/')) return src.includes('\0') ? null : { kind: 'path', path: src };
	const short = src.match(/^([A-Za-z0-9_][\w.-]*)\/([A-Za-z0-9_][\w.-]*?)(?:\.git)?$/);
	const m = short ? [null, short[1], short[2]] : src.match(/^https:\/\/github\.com\/([A-Za-z0-9_][\w.-]*)\/([A-Za-z0-9_][\w.-]*?)(?:\.git)?(?:\/tree\/([^/]+)\/(.+?))?\/?$/);
	if (!m) return null;
	const [, owner, repo, ref = null, subdir = null] = m;
	if (owner.includes('..') || repo.includes('..')) return null;
	if (ref !== null && (!SEGMENT.test(ref) || !cleanSegments(subdir))) return null;
	return { kind: 'git', cloneUrl: `https://github.com/${owner}/${repo}.git`, ref, subdir, repo };
}

export function normalizeMarketplaceSource(input) {
	const src = String(input ?? '').trim();
	if (/^[A-Za-z0-9_][\w.-]*\/[A-Za-z0-9_][\w.-]*$/.test(src)) return `https://github.com/${src.replace(/\.git$/, '')}.git`;
	let u;
	try { u = new URL(src); } catch { return null; }
	if (u.protocol !== 'https:' || u.username || u.password || /\s/.test(src)) return null;
	return src;
}

export function isPluginId(s) {
	return typeof s === 'string' && /^[A-Za-z0-9][\w.-]*@[A-Za-z0-9][\w.-]*$/.test(s);
}

// Just enough YAML for skill frontmatter: top-level scalars and block scalars.
export function parseFrontmatter(text) {
	const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
	if (lines[0].trim() !== '---') return null;
	const end = lines.indexOf('---', 1);
	if (end < 0) return null;
	const out = {};
	for (let i = 1; i < end; i++) {
		const m = lines[i].match(/^([\w-]+):\s*(.*)$/);
		if (!m) continue;
		const [, key, raw] = m;
		const block = raw.match(/^([>|])[+-]?\s*$/);
		if (block) {
			const body = [];
			while (i + 1 < end && (/^\s+/.test(lines[i + 1]) || !lines[i + 1].trim())) body.push(lines[++i].trim());
			out[key] = body.join(block[1] === '>' ? ' ' : '\n').trim();
		} else if (raw) {
			out[key] = raw.trim().replace(/^(["'])(.*)\1$/, '$2');
		}
	}
	return out;
}

// Reasons a draft would not load as a skill called `id`. Empty means fine.
export function validateSkillText(text, id) {
	const fm = parseFrontmatter(text);
	if (!fm) return ['SKILL.md 开头缺少 --- 包裹的 frontmatter'];
	const errors = [];
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(fm.name || '')) errors.push('name 只能用小写字母、数字和连字符');
	if (fm.name !== id) errors.push(`name（${fm.name || '空'}）必须和目录名（${id}）相同`);
	if (!fm.description) errors.push('缺少 description');
	else if (fm.description.length > 1024) errors.push('description 不能超过 1024 个字符');
	const body = String(text).replace(/\r\n/g, '\n').split('\n---').slice(1).join('\n---').replace(/^[^\n]*\n?/, '');
	if (!body.trim()) errors.push('正文是空的');
	return errors;
}

const isRealDir = async (p) => { try { return (await lstat(p)).isDirectory(); } catch { return false; } };
const isRealFile = async (p) => { try { return (await lstat(p)).isFile(); } catch { return false; } };

const NOT_SKILLS = new Set(['template', 'templates', 'spec', 'node_modules', '.git', '.github']);

// Directories holding a SKILL.md: the root itself, its children, or the conventional skills/*.
// Symlinks are never followed, so a repository cannot point this at the rest of the phone.
export async function findSkillRoots(dir) {
	if (await isRealFile(join(dir, 'SKILL.md'))) return [{ dir, id: null }];
	const roots = [];
	for (const base of [dir, join(dir, 'skills'), join(dir, '.claude', 'skills')]) {
		if (!(await isRealDir(base))) continue;
		for (const d of await readdir(base, { withFileTypes: true })) {
			if (!d.isDirectory() || NOT_SKILLS.has(d.name)) continue;
			const full = join(base, d.name);
			if (await isRealFile(join(full, 'SKILL.md'))) roots.push({ dir: full, id: d.name });
		}
	}
	return roots;
}

// What Claude Code will make of one directory under ~/.claude/skills. It reads a SKILL.md directly
// inside and nowhere deeper, so a repository cloned in whole looks installed but never loads.
export async function inspectSkillDir(dir, id) {
	const out = { id, name: id, description: '', argumentHint: '', loadable: false, nested: [], userInvocable: true, modelInvocable: true };
	let text;
	try { text = await readFile(join(dir, 'SKILL.md'), 'utf8'); }
	catch {
		out.nested = (await findSkillRoots(dir).catch(() => [])).map((r) => r.id).filter(Boolean);
		return out;
	}
	out.loadable = true;
	const fm = parseFrontmatter(text) || {};
	if (fm.name) out.name = fm.name;
	if (fm.description) out.description = fm.description;
	if (fm['argument-hint']) out.argumentHint = fm['argument-hint'];
	out.userInvocable = fm['user-invocable'] !== 'false';
	out.modelInvocable = fm['disable-model-invocation'] !== 'true';
	return out;
}

// The "/" menu. Claude Code's own list is a snapshot, and there is none at all before a conversation
// starts, so the skills directory decides which skills are in it. Listing a skill that hasn't loaded
// yet is safe: both runtimes look for it again when the command is sent. `formerly` holds names that
// were skills at some point: on disk no more, they must not stay listed from an old snapshot.
export function mergeSlashCommands(base, skills, formerly = new Set()) {
	const on = new Map();
	const off = new Set(formerly);
	for (const s of skills) {
		if (!s.loadable) continue;
		if (s.enabled) on.set(s.name, s);
		else off.add(s.name);
	}
	const aliasesOf = (s) => (s.id !== s.name ? { aliases: [s.id] } : {});
	const out = [];
	for (const c of base) {
		const s = on.get(c.name);
		// The description from the file: Claude Code's copy has " (user)" stuck on the end.
		if (s) out.push({ ...c, description: s.description || c.description, kind: 'skill', ...aliasesOf(s) });
		else if (off.has(c.name)) continue;
		else out.push(c.name.includes(':') ? { ...c, kind: 'skill' } : c);
	}
	for (const s of on.values()) {
		if (!s.userInvocable || out.some((c) => c.name === s.name)) continue;
		out.push({ name: s.name, description: s.description, argumentHint: s.argumentHint, kind: 'skill', ...aliasesOf(s) });
	}
	return out;
}

// Relative paths of symlinks whose target is outside `root`.
export async function findEscapingSymlinks(root) {
	const bad = [];
	const top = resolve(root);
	async function walk(d) {
		for (const e of await readdir(d, { withFileTypes: true })) {
			const full = join(d, e.name);
			if (e.isSymbolicLink()) {
				const target = await readlink(full);
				const landed = resolve(dirname(full), target);
				if (target.startsWith('/') || isAbsolute(target) || (landed !== top && !landed.startsWith(top + sep))) {
					bad.push(relative(top, full).split(sep).join('/'));
				}
			} else if (e.isDirectory()) {
				await walk(full);
			}
		}
	}
	await walk(top);
	return bad;
}

// Catalog + what is installed -> one searchable, paged list. Installed first, then official, then
// by popularity, so the first screen is the useful part of thousands of entries.
export function mergePlugins(available, installed, { q = '', limit = 50, offset = 0, view = 'all' } = {}) {
	const byId = new Map();
	for (const p of available || []) {
		if (!p?.pluginId || byId.has(p.pluginId)) continue;
		byId.set(p.pluginId, {
			id: p.pluginId, name: p.name || p.pluginId.split('@')[0], description: p.description || '',
			marketplace: p.marketplaceName || p.pluginId.split('@')[1], version: p.version || '',
			installCount: p.installCount || 0, installed: false, enabled: false,
		});
	}
	for (const p of installed || []) {
		if (!p?.id) continue;
		const cur = byId.get(p.id) || {
			id: p.id, name: p.id.split('@')[0], description: '', marketplace: p.id.split('@')[1], installCount: 0,
		};
		byId.set(p.id, { ...cur, version: p.version || cur.version || '', installed: true, enabled: !!p.enabled, installPath: p.installPath });
	}
	const needle = String(q).trim().toLowerCase();
	const all = [...byId.values()]
		.map((p) => ({ ...p, official: OFFICIAL_NAMES.has(p.marketplace) }))
		.filter((p) => view === 'all' || (view === 'installed') === p.installed)
		.filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.description.toLowerCase().includes(needle))
		.sort((a, b) => (b.installed - a.installed) || (b.official - a.official) || (b.installCount - a.installCount) || a.name.localeCompare(b.name));
	return { total: all.length, items: all.slice(offset, offset + limit) };
}

const TRANSPORT = { 'streamable-http': 'http', http: 'http', sse: 'sse' };

function headerInputs(headers) {
	const inputs = [];
	const fixed = {};
	for (const h of headers || []) {
		if (!h?.name) continue;
		if (h.value && !h.value.includes('{')) { fixed[h.name] = h.value; continue; }
		inputs.push({ key: h.name, kind: 'header', label: h.description || h.name, secret: !!h.isSecret, required: !!h.isRequired, template: h.value || '{value}' });
	}
	return { inputs, fixed };
}

// MCP registry response -> connectors this app can actually run.
export function normalizeRegistry(json) {
	const out = new Map();
	for (const row of json?.servers || []) {
		const s = row?.server;
		const meta = row?._meta?.['io.modelcontextprotocol.registry/official'];
		if (!s?.name || (meta?.status && meta.status !== 'active')) continue;
		const base = { id: s.name, title: s.title || s.name.split('/').pop(), description: s.description || '', version: s.version || '', website: s.websiteUrl || s.repository?.url || '' };
		let conn = null;
		const remote = (s.remotes || []).find((r) => TRANSPORT[r?.type] && /^https:\/\//.test(r.url || '') && !r.url.includes('{'));
		if (remote) {
			const { inputs, fixed } = headerInputs(remote.headers);
			conn = { ...base, type: TRANSPORT[remote.type], url: remote.url, inputs, ...(Object.keys(fixed).length ? { fixedHeaders: fixed } : {}) };
		} else {
			for (const p of s.packages || []) {
				if (!p?.identifier || (p.packageArguments || []).some((a) => a.isRequired && !a.value)) continue;
				const version = p.version || s.version;
				let run = null;
				if (p.registryType === 'npm') run = { command: 'npx', args: ['-y', version ? `${p.identifier}@${version}` : p.identifier] };
				else if (p.registryType === 'pypi') run = { command: 'uvx', args: [version ? `${p.identifier}==${version}` : p.identifier] };
				if (!run) continue;
				const inputs = (p.environmentVariables || []).filter((e) => e?.name).map((e) => ({ key: e.name, kind: 'env', label: e.description || e.name, secret: !!e.isSecret, required: !!e.isRequired }));
				conn = { ...base, type: 'stdio', ...run, inputs };
				break;
			}
		}
		if (!conn) continue;
		// Each version is its own row; without version=latest the first one seen could be old.
		if (!out.has(s.name) || meta?.isLatest) out.set(s.name, conn);
	}
	return [...out.values()];
}

export function connectorName(id) {
	const last = String(id ?? '').split('/').pop().replace(/[^\w.-]/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 48);
	return safeId(last) ? last : '';
}

// A connector plus what the owner typed -> the entry saved in agent-mcp.json. Only commands the
// catalog and registry produce are accepted here; any other command goes through the manual form,
// where the owner types it themselves.
export function buildMcpEntry(c, values = {}) {
	const filled = {};
	for (const inp of c.inputs || []) {
		const v = String(values[inp.key] ?? '').trim();
		if (/[\r\n]/.test(v)) throw new Error(`${inp.key} 不能包含换行`);
		if (!v) { if (inp.required) throw new Error(`请填写 ${inp.key}`); continue; }
		filled[inp.key] = inp.template ? inp.template.replace(/\{[^}]*\}/g, () => v) : v;
	}
	const pick = (kind) => Object.fromEntries((c.inputs || []).filter((i) => i.kind === kind && filled[i.key] !== undefined).map((i) => [i.key, filled[i.key]]));
	if (c.type === 'http' || c.type === 'sse') {
		if (!/^https:\/\//.test(c.url || '')) throw new Error('连接器地址无效');
		const headers = { ...(c.fixedHeaders || {}), ...pick('header') };
		return { type: c.type, url: c.url, ...(Object.keys(headers).length ? { headers } : {}), disabled: false };
	}
	if (c.type === 'stdio') {
		if (!['npx', 'uvx'].includes(c.command) || !Array.isArray(c.args)) throw new Error('不支持这个启动命令');
		return { type: 'stdio', command: c.command, args: c.args.map(String), env: pick('env'), disabled: false };
	}
	throw new Error('不支持这种连接器类型');
}

async function readJson(p) {
	return JSON.parse(await readFile(p, 'utf8'));
}

const namesOf = async (dir, ext) => {
	if (!(await isRealDir(dir))) return [];
	return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith(ext)).map((e) => e.name.slice(0, -ext.length)).sort();
};

function hooksFrom(obj) {
	const out = [];
	for (const [event, groups] of Object.entries(obj?.hooks || obj || {})) {
		if (!Array.isArray(groups)) continue;
		for (const g of groups) for (const h of g?.hooks || []) out.push({ event, command: String(h?.command || h?.url || h?.prompt || h?.type || '') });
	}
	return out;
}

function mcpFrom(obj) {
	return Object.entries(obj?.mcpServers || obj || {}).filter(([, v]) => v && typeof v === 'object').map(([name, v]) => (
		v.url ? { name, target: String(v.url), local: false } : { name, target: [v.command, ...(v.args || [])].filter(Boolean).join(' '), local: true }
	));
}

// What a downloaded plugin contains, for the owner to read before it is enabled. Anything that
// cannot be read counts as running code: an unparsable hooks file must not look harmless.
export async function inspectPluginDir(root) {
	let manifest = {};
	let unreadable = false;
	const manifestPath = join(root, '.claude-plugin', 'plugin.json');
	if (await isRealFile(manifestPath)) {
		try { manifest = await readJson(manifestPath); } catch { unreadable = true; }
	}
	const skillsDir = join(root, 'skills');
	const skills = [];
	if (await isRealDir(skillsDir)) {
		for (const d of await readdir(skillsDir, { withFileTypes: true })) {
			if (d.isDirectory() && await isRealFile(join(skillsDir, d.name, 'SKILL.md'))) skills.push(d.name);
		}
	}
	let hooks = [];
	const hooksPath = join(root, 'hooks', 'hooks.json');
	if (await isRealFile(hooksPath)) {
		try { hooks = hooksFrom(await readJson(hooksPath)); } catch { unreadable = true; }
	}
	if (manifest.hooks && typeof manifest.hooks === 'object') hooks = hooks.concat(hooksFrom(manifest.hooks));
	else if (manifest.hooks) unreadable = true; // a path somewhere else: don't claim to know what it runs
	let mcp = [];
	const mcpPath = join(root, '.mcp.json');
	if (await isRealFile(mcpPath)) {
		try { mcp = mcpFrom(await readJson(mcpPath)); } catch { unreadable = true; }
	}
	if (manifest.mcpServers && typeof manifest.mcpServers === 'object') mcp = mcp.concat(mcpFrom(manifest.mcpServers));
	else if (manifest.mcpServers) unreadable = true;
	const otherCode = (await isRealDir(join(root, 'bin'))) || (await isRealDir(join(root, 'monitors'))) || (await isRealFile(join(root, '.lsp.json'))) || !!manifest.lspServers;
	const author = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name || '';
	return {
		description: manifest.description || '', author, version: manifest.version || '',
		skills: skills.sort(), commands: await namesOf(join(root, 'commands'), '.md'), agents: await namesOf(join(root, 'agents'), '.md'),
		hooks, mcp, unreadable, otherCode,
		runsCode: unreadable || otherCode || hooks.length > 0 || mcp.some((m) => m.local),
	};
}
