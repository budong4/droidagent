// Run: node --test tests/shared.test.mjs
// The plugin store both agents share.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	claudeServerToConnector, agyServerToClaude, enabledClaudePlugins, claudePluginsForAgy, agyPluginsForClaude, syncSkillLinks, skillsIn,
} from '../app/server/backends/shared_plugins.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'droidagent-shared-'));
const skill = (dir, name) => { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n`); };

// ---------------------------------------------------------------- plugins, both ways
test('MCP server entries convert between the two formats', () => {
	assert.deepEqual(claudeServerToConnector({ command: '${CLAUDE_PLUGIN_ROOT}/bin/srv', args: ['--dir', '${CLAUDE_PLUGIN_ROOT}/data'], env: { A: '${CLAUDE_PLUGIN_ROOT}' } }, '/p'),
		{ type: 'stdio', command: '/p/bin/srv', args: ['--dir', '/p/data'], env: { A: '/p' } });
	assert.deepEqual(claudeServerToConnector({ type: 'http', url: 'https://m.example/mcp', headers: { X: 'y' } }, '/p'), { type: 'http', url: 'https://m.example/mcp', headers: { X: 'y' } });
	assert.deepEqual(claudeServerToConnector({ url: 'https://m.example/sse', type: 'sse' }, '/p'), { type: 'sse', url: 'https://m.example/sse' });
	assert.equal(claudeServerToConnector({}, '/p'), null);
	assert.deepEqual(agyServerToClaude({ command: 'npx', args: ['x'], env: { K: 'v' } }), { command: 'npx', args: ['x'], env: { K: 'v' } });
	assert.deepEqual(agyServerToClaude({ serverUrl: 'https://m.example/mcp', headers: { A: 'b' } }), { type: 'http', url: 'https://m.example/mcp', headers: { A: 'b' } });
	assert.equal(agyServerToClaude({ command: 'x', disabled: true }), null);
});

test("Claude plugins that are switched on: their skills and connectors, ready for Antigravity", async () => {
	const home = tmp();
	try {
		const claudeDir = join(home, '.claude');
		const root = join(claudeDir, 'plugins', 'cache', 'mkt', 'phone-tools', '1.0.0');
		skill(join(root, 'skills'), 'battery');
		mkdirSync(join(root, 'skills', 'not-a-skill'), { recursive: true });
		mkdirSync(join(root, '.claude-plugin'), { recursive: true });
		writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'phone-tools', mcpServers: { remote: { type: 'http', url: 'https://r.example/mcp' } } }));
		writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: '${CLAUDE_PLUGIN_ROOT}/srv' } } }));
		const offRoot = join(claudeDir, 'plugins', 'cache', 'mkt', 'off-plugin', '1.0.0');
		skill(join(offRoot, 'skills'), 'nope');
		writeFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
			'phone-tools@mkt': [{ scope: 'user', installPath: root }], 'off-plugin@mkt': [{ scope: 'user', installPath: offRoot }], 'gone@mkt': [{ installPath: join(home, 'nowhere') }],
		} }));
		writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'phone-tools@mkt': true, 'off-plugin@mkt': false, 'gone@mkt': true } }));
		const on = await enabledClaudePlugins(claudeDir);
		assert.deepEqual(on, [{ id: 'phone-tools@mkt', root, name: 'phone-tools' }]);
		// What `claude plugin list --json` says wins when the app has it.
		assert.deepEqual((await enabledClaudePlugins(claudeDir, [{ id: 'off-plugin@mkt', enabled: true, installPath: offRoot }])).map((p) => p.name), ['off-plugin']);
		const shared = await claudePluginsForAgy(on);
		assert.deepEqual(shared.skills, [{ name: 'phone-tools-battery', dir: join(root, 'skills', 'battery') }]);
		assert.deepEqual(shared.connectors, {
			'phone-tools-local': { type: 'stdio', command: `${root}/srv`, args: [], env: {} },
			'phone-tools-remote': { type: 'http', url: 'https://r.example/mcp' },
		});
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test('Antigravity plugins become local Claude plugins, kept in step with what is installed', async () => {
	const home = tmp();
	try {
		const gemini = join(home, '.gemini');
		const out = join(home, '.droidagent', 'agy-plugins');
		const p1 = join(gemini, 'config', 'plugins', 'Web Tools');
		skill(join(p1, 'skills'), 'scrape');
		writeFileSync(join(p1, 'mcp_config.json'), JSON.stringify({ mcpServers: { fetch: { command: 'uvx', args: ['mcp-fetch'] }, cloud: { serverUrl: 'https://c.example/mcp' }, off: { command: 'x', disabled: true } } }));
		mkdirSync(join(gemini, 'config', 'plugins', 'rules-only', 'rules'), { recursive: true });
		const list = await agyPluginsForClaude(gemini, out);
		const dir = join(out, 'agy-web-tools');
		assert.deepEqual(list, [{ type: 'local', path: dir }]);
		assert.equal(JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'agy-web-tools');
		assert.deepEqual(JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')).mcpServers, { fetch: { command: 'uvx', args: ['mcp-fetch'] }, cloud: { type: 'http', url: 'https://c.example/mcp' } });
		assert.equal(readlinkSync(join(dir, 'skills', 'scrape')), join(p1, 'skills', 'scrape'));
		assert.deepEqual((await skillsIn(join(dir, 'skills'))).map((s) => s.name), ['scrape']);
		assert.ok(!existsSync(join(out, 'agy-rules-only')), 'nothing that carries over: no wrapper');
		// Unchanged: left as it is. Uninstalled: removed.
		const mark = readFileSync(join(dir, '.droidagent-sync'), 'utf8');
		await agyPluginsForClaude(gemini, out);
		assert.equal(readFileSync(join(dir, '.droidagent-sync'), 'utf8'), mark);
		rmSync(p1, { recursive: true });
		assert.deepEqual(await agyPluginsForClaude(gemini, out), []);
		assert.ok(!existsSync(dir));
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test('skill links in ~/.gemini/skills: ours follow what is wanted, the owner\'s stay', async () => {
	const home = tmp();
	try {
		const target = join(home, '.gemini', 'skills');
		const app = join(home, 'app-skills');
		skill(app, 'a');
		skill(app, 'b');
		const elsewhere = join(home, 'their-skills');
		skill(elsewhere, 'theirs');
		mkdirSync(join(target, 'real-folder'), { recursive: true });
		symlinkSync(join(elsewhere, 'theirs'), join(target, 'theirs'));
		const ours = (t) => t.startsWith(app + '/');
		await syncSkillLinks(target, await skillsIn(app), ours);
		assert.equal(readlinkSync(join(target, 'a')), join(app, 'a'));
		assert.equal(readlinkSync(join(target, 'b')), join(app, 'b'));
		await syncSkillLinks(target, [{ name: 'a', dir: join(app, 'a') }], ours);
		assert.ok(!existsSync(join(target, 'b')));
		assert.ok(lstatSync(join(target, 'real-folder')).isDirectory());
		assert.equal(readlinkSync(join(target, 'theirs')), join(elsewhere, 'theirs'));
		// A name taken by the owner is not ours to replace.
		await syncSkillLinks(target, [{ name: 'theirs', dir: join(app, 'a') }], ours);
		assert.equal(readlinkSync(join(target, 'theirs')), join(elsewhere, 'theirs'));
	} finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- sources
import { sourcesOf, mergeSources, queryOf } from '../app/server/sources.mjs';
test("a search's links, a fetched page, links in other tools' text", () => {
	const t = 'Web search results for query: "pixel 9 battery [2026]"\n\nLinks: [{"title":"Pixel [9] review","url":"https://www.gsmarena.com/x"},{"title":"Battery","url":"https://support.google.com/y?a=1"}]\n\nSummary https://ignored.example';
	assert.equal(queryOf(t), 'pixel 9 battery [2026]');
	assert.deepEqual(sourcesOf('WebSearch', {}, t), [{ title: 'Pixel [9] review', url: 'https://www.gsmarena.com/x' }, { title: 'Battery', url: 'https://support.google.com/y?a=1' }]);
	assert.deepEqual(sourcesOf('WebSearch', {}, 'results: https://a.example/1 and https://b.example/2.'), [{ title: 'a.example', url: 'https://a.example/1' }, { title: 'b.example', url: 'https://b.example/2' }]);
	assert.deepEqual(sourcesOf('WebFetch', { url: 'https://a.b/c' }, 'x'), [{ title: 'a.b', url: 'https://a.b/c' }]);
	assert.deepEqual(sourcesOf('mcp__droidagent__browser_open', { url: 'https://a.b/c' }, '标题：A page\n...'), [{ title: 'A page', url: 'https://a.b/c' }]);
	assert.deepEqual(sourcesOf('mcp__x__search', {}, 'see [Doc](https://d.e/f), and https://g.h/i.'), [{ title: 'Doc', url: 'https://d.e/f' }, { title: 'g.h', url: 'https://g.h/i' }]);
	assert.deepEqual(sourcesOf('Bash', {}, 'https://x.y'), [], 'a command printing a link is not a source');
	assert.deepEqual(mergeSources([{ url: 'https://a.b/c' }], [{ url: 'https://a.b/c' }, { url: 'ftp://x' }, { url: 'javascript:alert(1)' }]), [{ title: 'a.b', url: 'https://a.b/c' }]);
});
