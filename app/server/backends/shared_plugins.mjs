// One plugin store for both agents. Claude Code plugins and Antigravity plugins are different
// formats, but the two things that carry over are the same in both: skills (a folder with a
// SKILL.md) and MCP servers. So:
//   Claude plugin  -> Antigravity: its skills are linked into ~/.gemini/skills, its MCP servers
//                     added to agy's mcp_config.json (with the rest of the app's connectors).
//   agy plugin     -> Claude: a small local Claude plugin is generated for it under
//                     ~/.droidagent/agy-plugins/<name> (its skills linked in, its MCP servers in
//                     .mcp.json) and handed to the Agent SDK's `plugins` option.
// What does not carry over is left where it is: Claude's hooks, commands and subagents; agy's
// rules. Nothing here changes either agent's own plugin files.
import { readFile, readdir, mkdir, writeFile, rm, symlink, lstat, readlink, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const readJson = async (file) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };
const safeName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
const dirs = async (dir) => { try { return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name).sort(); } catch { return []; } };

// Skill folders (each with a SKILL.md) directly under `dir`: [{ name, dir }].
export async function skillsIn(dir) {
	const out = [];
	for (const name of await dirs(dir)) if (existsSync(join(dir, name, 'SKILL.md'))) out.push({ name, dir: join(dir, name) });
	return out;
}

// ---------------------------------------------------------------- MCP server entries, either way

// An MCP server as Claude Code writes it (.mcp.json) -> the app's connector shape (what
// toAgyMcp in antigravity.mjs takes). ${CLAUDE_PLUGIN_ROOT} is the plugin's own folder.
export function claudeServerToConnector(s, root) {
	if (!s || typeof s !== 'object') return null;
	const sub = (v) => (typeof v === 'string' ? v.split('${CLAUDE_PLUGIN_ROOT}').join(root) : v);
	if (s.type === 'http' || s.type === 'sse' || (!s.command && s.url)) {
		return s.url ? { type: s.type === 'sse' ? 'sse' : 'http', url: sub(s.url), ...(s.headers ? { headers: Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k, sub(v)])) } : {}) } : null;
	}
	if (!s.command) return null;
	return { type: 'stdio', command: sub(s.command), args: (s.args || []).map(sub), env: Object.fromEntries(Object.entries(s.env || {}).map(([k, v]) => [k, sub(v)])) };
}
// An MCP server as agy writes it (mcp_config.json) -> Claude Code's .mcp.json shape.
export function agyServerToClaude(s) {
	if (!s || typeof s !== 'object' || s.disabled) return null;
	const url = s.serverUrl || s.url;
	if (url) return { type: 'http', url, ...(s.headers ? { headers: s.headers } : {}) };
	if (!s.command) return null;
	return { command: s.command, args: s.args || [], ...(s.env ? { env: s.env } : {}) };
}
const serversOf = (j) => (j && typeof j === 'object' ? (j.mcpServers && typeof j.mcpServers === 'object' ? j.mcpServers : j) : {});

// ---------------------------------------------------------------- Claude plugins

// The Claude Code plugins that are installed and switched on, read from Claude Code's own files:
// [{ id, name, root }]. `installed` is `claude plugin list --json` when the app has it.
export async function enabledClaudePlugins(claudeDir, installed = null) {
	const list = [];
	if (Array.isArray(installed) && installed.length) {
		for (const p of installed) if (p?.enabled && p.installPath) list.push({ id: p.id, root: p.installPath });
	} else {
		const reg = await readJson(join(claudeDir, 'plugins', 'installed_plugins.json'));
		const settings = await readJson(join(claudeDir, 'settings.json'));
		const on = settings?.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : {};
		for (const [id, v] of Object.entries(reg?.plugins || {})) {
			if (on[id] !== true) continue;
			const entry = Array.isArray(v) ? v.find((x) => x?.installPath) : v;
			if (entry?.installPath) list.push({ id, root: entry.installPath });
		}
	}
	return list.filter((p) => existsSync(p.root)).map((p) => ({ ...p, name: safeName(String(p.id).split('@')[0]) || safeName(basename(p.root)) }));
}

// What of the Claude plugins Antigravity can use: { skills: [{ name, dir }], connectors: { name: connector } }.
export async function claudePluginsForAgy(plugins) {
	const skills = [];
	const connectors = {};
	for (const p of plugins) {
		for (const s of await skillsIn(join(p.root, 'skills'))) skills.push({ name: `${p.name}-${s.name}`, dir: s.dir });
		const manifest = await readJson(join(p.root, '.claude-plugin', 'plugin.json'));
		const servers = { ...serversOf(await readJson(join(p.root, '.mcp.json'))), ...(manifest?.mcpServers && typeof manifest.mcpServers === 'object' ? manifest.mcpServers : {}) };
		for (const [name, s] of Object.entries(servers)) {
			const c = claudeServerToConnector(s, p.root);
			if (c) connectors[`${p.name}-${safeName(name)}`] = c;
		}
	}
	return { skills, connectors };
}

// ---------------------------------------------------------------- agy plugins

// Antigravity's installed plugins: [{ name, root }].
export async function agyPluginDirs(geminiDir) {
	const base = join(geminiDir, 'config', 'plugins');
	return (await dirs(base)).filter((n) => !n.startsWith('.')).map((n) => ({ name: safeName(n), root: join(base, n) }));
}

// For each agy plugin with skills or MCP servers, a local Claude plugin that offers the same:
// returns the SDK's `plugins` option ([{ type: 'local', path }]). Wrappers of plugins that are
// gone are removed.
export async function agyPluginsForClaude(geminiDir, outDir) {
	const out = [];
	const keep = new Set();
	for (const p of await agyPluginDirs(geminiDir)) {
		const skills = await skillsIn(join(p.root, 'skills'));
		const servers = {};
		for (const [name, s] of Object.entries(serversOf(await readJson(join(p.root, 'mcp_config.json'))))) {
			const c = agyServerToClaude(s);
			if (c) servers[safeName(name)] = c;
		}
		if (!skills.length && !Object.keys(servers).length) continue;
		const name = `agy-${p.name}`;
		const dir = join(outDir, name);
		keep.add(name);
		const manifest = { name, version: '0.0.0', description: `Antigravity 插件 ${p.name}（由 DroidAgent 同步）` };
		const want = JSON.stringify({ manifest, servers, skills: skills.map((s) => s.dir) });
		if ((await readFile(join(dir, '.droidagent-sync'), 'utf8').catch(() => '')) !== want) {
			// Built aside and swapped in, so a conversation starting meanwhile sees the old or the new.
			const tmp = `${dir}.${process.pid}.tmp`;
			await rm(tmp, { recursive: true, force: true });
			await mkdir(join(tmp, '.claude-plugin'), { recursive: true });
			await writeFile(join(tmp, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2));
			if (Object.keys(servers).length) await writeFile(join(tmp, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
			if (skills.length) {
				await mkdir(join(tmp, 'skills'));
				for (const s of skills) await symlink(s.dir, join(tmp, 'skills', s.name));
			}
			await writeFile(join(tmp, '.droidagent-sync'), want);
			await rm(dir, { recursive: true, force: true });
			await rename(tmp, dir);
		}
		out.push({ type: 'local', path: dir });
	}
	for (const name of await dirs(outDir)) if (name.startsWith('agy-') && !keep.has(name) && !name.endsWith('.tmp')) await rm(join(outDir, name), { recursive: true, force: true });
	return out;
}

// ---------------------------------------------------------------- links in ~/.gemini/skills

// Makes `skillsDir` hold a link for each wanted skill ([{ name, dir }]); a link of ours that is no
// longer wanted, or points elsewhere now, goes. `ours(target)` says which links this app made;
// a real folder, or a link someone else made, is never touched.
export async function syncSkillLinks(skillsDir, wanted, ours) {
	await mkdir(skillsDir, { recursive: true });
	const want = new Map();
	for (const s of wanted) if (!want.has(s.name)) want.set(s.name, s.dir);
	for (const name of await dirs(skillsDir)) {
		const link = join(skillsDir, name);
		const st = await lstat(link).catch(() => null);
		if (!st?.isSymbolicLink()) continue;
		const target = await readlink(link).catch(() => '');
		if (!ours(target)) continue;
		if (want.get(name) !== target) await rm(link, { force: true });
	}
	for (const [name, dir] of want) {
		const link = join(skillsDir, name);
		if (await lstat(link).catch(() => null)) continue;
		await symlink(dir, link).catch(() => {});
	}
}
