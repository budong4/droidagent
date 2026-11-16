// Run: node --test tests/shared.test.mjs
// Antigravity's thoughts read back from its own record, and the plugin store both agents share.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { thoughtOf, readThoughts, lastStepIndex, conversationDb } from '../app/server/backends/agy_thoughts.mjs';
import {
	claudeServerToConnector, agyServerToClaude, enabledClaudePlugins, claudePluginsForAgy, agyPluginsForClaude, syncSkillLinks, skillsIn,
} from '../app/server/backends/shared_plugins.mjs';

const varint = (n) => { const out = []; while (n > 127) { out.push((n & 127) | 128); n >>>= 7; } out.push(n); return Buffer.from(out); };
const field = (num, bytes) => Buffer.concat([varint((num << 3) | 2), varint(bytes.length), Buffer.from(bytes)]);
const tmp = () => mkdtempSync(join(tmpdir(), 'droidagent-shared-'));
const skill = (dir, name) => { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n`); };

// ---------------------------------------------------------------- thoughts
test("a step's thought is field 20 -> 3; the reply (20 -> 1) and things that only look like prose are not", () => {
	assert.equal(thoughtOf(Buffer.concat([field(2, 'x'), field(20, Buffer.concat([field(1, 'the answer'), field(3, 'let me think')]))])), 'let me think');
	assert.equal(thoughtOf(field(20, field(1, 'only an answer'))), '');
	// Nested a level down, as tool steps carry it.
	assert.equal(thoughtOf(field(5, field(20, field(3, 'deeper')))), 'deeper');
	for (const notOne of ['SYSTEM ROLE: you are', '{"toolAction":"x"}', '/plan do it', '3f2a1b4c-0000-4000-8000-000000000000', 'call_abc']) {
		assert.equal(thoughtOf(field(20, field(3, notOne))), '', notOne);
	}
	assert.equal(thoughtOf(Buffer.from([0xff, 0xff, 0xff])), '', 'garbage is no thought and no error');
	assert.equal(thoughtOf(Buffer.alloc(0)), '');
});

test('thoughts are read from the conversation record, from a given step on', async () => {
	const home = tmp();
	try {
		assert.deepEqual([...await readThoughts(home, 'conv1')], [], 'no record yet');
		assert.equal(await lastStepIndex(home, 'conv1'), -1);
		assert.equal(conversationDb(home, '../etc/passwd'), null, 'an id is never a path');
		const file = conversationDb(home, 'conv1');
		mkdirSync(join(home, '.gemini', 'antigravity-cli', 'conversations'), { recursive: true });
		const db = new DatabaseSync(file);
		db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');
		const add = db.prepare('INSERT INTO steps VALUES (?, ?, ?)');
		add.run(0, 1, field(1, 'the user typed something long enough'));
		add.run(1, 15, field(20, field(3, 'thinking one')));
		add.run(2, 21, Buffer.concat([field(2, 'list_dir'), field(20, field(3, 'thinking two'))]));
		add.run(3, 15, field(20, field(1, 'the answer, which is not a thought')));
		add.run(4, 99, field(20, field(3, 'a step type that is not read')));
		db.close();
		assert.deepEqual([...await readThoughts(home, 'conv1')], [[1, 'thinking one'], [2, 'thinking two']]);
		assert.deepEqual([...await readThoughts(home, 'conv1', 2)], [[2, 'thinking two']]);
		assert.equal(await lastStepIndex(home, 'conv1'), 4);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

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
