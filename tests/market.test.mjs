// Run: node --test tests/market.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	safeId, parseSkillSource, normalizeMarketplaceSource, isPluginId, parseFrontmatter, validateSkillText,
	findSkillRoots, findEscapingSymlinks, mergePlugins, normalizeRegistry, buildMcpEntry, inspectPluginDir,
	resolveInside, inspectSkillDir, mergeSlashCommands, compatibleMarketplace, COMPAT_MARKETPLACE,
} from '../app/server/market.mjs';

async function tmp() { return mkdtemp(join(tmpdir(), 'market-test-')); }
async function skill(dir, name = 'x') {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
}

test('safeId rejects anything that could leave its parent directory', () => {
	for (const bad of ['..', '.', '', '../x', 'a/b', 'a\\b', '-rf', '.hidden', 'a b', 'a\n', 'x'.repeat(65), null, undefined, 3]) {
		assert.equal(safeId(bad), false, String(bad));
	}
	for (const ok of ['pdf', 'skill-creator', 'a.b_c-1', 'A1']) assert.equal(safeId(ok), true, ok);
	assert.equal(safeId('a..b'), false, 'no dot-dot anywhere');
});

test('resolveInside only returns paths under the base', () => {
	assert.equal(resolveInside('/base', 'a/b'), '/base/a/b');
	assert.equal(resolveInside('/base', '../x'), null);
	assert.equal(resolveInside('/base', 'a/../../x'), null);
	assert.equal(resolveInside('/base', '/etc/passwd'), null);
});

test('parseSkillSource understands repo, subdirectory, shorthand and local paths', () => {
	assert.deepEqual(parseSkillSource('https://github.com/anthropics/skills'), { kind: 'git', cloneUrl: 'https://github.com/anthropics/skills.git', ref: null, subdir: null, repo: 'skills' });
	assert.deepEqual(parseSkillSource('https://github.com/anthropics/skills.git'), { kind: 'git', cloneUrl: 'https://github.com/anthropics/skills.git', ref: null, subdir: null, repo: 'skills' });
	assert.deepEqual(parseSkillSource('https://github.com/anthropics/skills/tree/main/skills/pdf/'), { kind: 'git', cloneUrl: 'https://github.com/anthropics/skills.git', ref: 'main', subdir: 'skills/pdf', repo: 'skills' });
	assert.deepEqual(parseSkillSource('anthropics/skills'), { kind: 'git', cloneUrl: 'https://github.com/anthropics/skills.git', ref: null, subdir: null, repo: 'skills' });
	assert.deepEqual(parseSkillSource('/sdcard/x.zip'), { kind: 'path', path: '/sdcard/x.zip' });
});

test('parseSkillSource refuses option injection and traversal', () => {
	for (const bad of ['--upload-pack=x', 'https://github.com/a/b/tree/main/../../etc', 'https://github.com/a/b/tree/-x/y', 'http://github.com/a/b', 'git@github.com:a/b.git', 'https://evil.example/a/b', 'https://github.com/a', '', 'a/b c', 'https://github.com/-a/b', 'https://github.com/a/..']) {
		assert.equal(parseSkillSource(bad), null, bad);
	}
});

test('normalizeMarketplaceSource forces https, since owner/repo would use SSH', () => {
	assert.equal(normalizeMarketplaceSource('anthropics/skills'), 'https://github.com/anthropics/skills.git');
	assert.equal(normalizeMarketplaceSource('https://github.com/a/b'), 'https://github.com/a/b');
	assert.equal(normalizeMarketplaceSource('https://gitlab.example.com/a/b.git'), 'https://gitlab.example.com/a/b.git');
	for (const bad of ['--x', 'git@github.com:a/b.git', 'ssh://x/y', 'http://x/y', 'file:///etc', '/root/x', 'a b/c', '', 'https://x/y z', 'https://user:pw@x/y']) {
		assert.equal(normalizeMarketplaceSource(bad), null, bad);
	}
});

test('isPluginId requires name@marketplace with safe characters', () => {
	assert.equal(isPluginId('commit-commands@claude-plugins-official'), true);
	assert.equal(isPluginId('wordpress.com@x'), true);
	for (const bad of ['x', '@x', 'x@', '-x@y', 'x@-y', 'a@b@c', 'a b@c', 'a/b@c', '', null]) assert.equal(isPluginId(bad), false, String(bad));
});

test('parseFrontmatter handles quotes, block scalars and CRLF', () => {
	assert.deepEqual(parseFrontmatter('---\nname: a\ndescription: "b: c"\n---\nx'), { name: 'a', description: 'b: c' });
	assert.deepEqual(parseFrontmatter('---\r\nname: a\r\ndescription: b\r\n---\r\nx'), { name: 'a', description: 'b' });
	assert.deepEqual(parseFrontmatter('---\nname: a\ndescription: >\n  one\n  two\nlicense: x\n---\n'), { name: 'a', description: 'one two', license: 'x' });
	assert.deepEqual(parseFrontmatter('---\nname: a\ndescription: |\n  one\n  two\n---\n'), { name: 'a', description: 'one\ntwo' });
	assert.equal(parseFrontmatter('no frontmatter'), null);
	assert.equal(parseFrontmatter('---\nname: a\n'), null);
});

test('validateSkillText enforces what Claude Code needs to load a skill', () => {
	const good = '---\nname: my-skill\ndescription: 做某事\n---\n# x\n';
	assert.deepEqual(validateSkillText(good, 'my-skill'), []);
	assert.ok(validateSkillText('# x', 'a').length, 'no frontmatter');
	assert.ok(validateSkillText('---\nname: a\n---\nx', 'a').some((e) => e.includes('description')), 'no description');
	assert.ok(validateSkillText('---\nname: b\ndescription: d\n---\nx', 'a').some((e) => e.includes('目录')), 'name differs from dir');
	assert.ok(validateSkillText('---\nname: A_B\ndescription: d\n---\nx', 'A_B').length, 'bad name');
	assert.ok(validateSkillText(`---\nname: a\ndescription: ${'x'.repeat(1025)}\n---\nx`, 'a').length, 'description too long');
	assert.ok(validateSkillText('---\nname: a\ndescription: d\n---\n', 'a').some((e) => e.includes('正文')), 'empty body');
});

test('findSkillRoots finds root, one level, and skills/* but not template or symlinks', async () => {
	const d = await tmp();
	try {
		await skill(join(d, 'single'));
		assert.deepEqual((await findSkillRoots(join(d, 'single'))).map((r) => r.id), [null]);

		await skill(join(d, 'flat', 'a'));
		await skill(join(d, 'flat', 'b'));
		assert.deepEqual((await findSkillRoots(join(d, 'flat'))).map((r) => r.id).sort(), ['a', 'b']);

		await skill(join(d, 'nested', 'skills', 'pdf'));
		await skill(join(d, 'nested', 'template'));
		assert.deepEqual((await findSkillRoots(join(d, 'nested'))).map((r) => r.id), ['pdf']);

		await mkdir(join(d, 'links'));
		await skill(join(d, 'real'));
		try {
			await symlink(join(d, 'real'), join(d, 'links', 'evil'), 'dir');
			assert.deepEqual(await findSkillRoots(join(d, 'links')), []);
		} catch (e) { if (e.code !== 'EPERM') throw e; }

		await mkdir(join(d, 'none'));
		assert.deepEqual(await findSkillRoots(join(d, 'none')), []);
	} finally { await rm(d, { recursive: true, force: true }); }
});

test('findEscapingSymlinks flags links leaving the skill, not ones staying inside', async () => {
	const d = await tmp();
	try {
		await skill(join(d, 's'));
		await writeFile(join(d, 's', 'a.txt'), 'x');
		assert.deepEqual(await findEscapingSymlinks(join(d, 's')), []);
		try {
			await symlink('a.txt', join(d, 's', 'ok'));
			await symlink('../outside', join(d, 's', 'up'));
			await symlink('/etc/passwd', join(d, 's', 'abs'));
		} catch (e) { if (e.code === 'EPERM') return; throw e; }
		assert.deepEqual((await findEscapingSymlinks(join(d, 's'))).sort(), ['abs', 'up']);
	} finally { await rm(d, { recursive: true, force: true }); }
});

test('mergePlugins: search, ranking, installed state, official flag, paging', () => {
	const available = [
		{ pluginId: 'b@claude-plugins-official', name: 'b', description: 'beta', marketplaceName: 'claude-plugins-official', installCount: 5 },
		{ pluginId: 'a@other', name: 'a', description: 'alpha', marketplaceName: 'other', installCount: 500 },
		{ pluginId: 'c@claude-plugins-official', name: 'c', description: 'gamma', marketplaceName: 'claude-plugins-official', installCount: 50 },
		{ pluginId: 'b@claude-plugins-official', name: 'b', description: 'dup', marketplaceName: 'claude-plugins-official', installCount: 5 },
	];
	const installed = [{ id: 'z@other', version: '1', enabled: false, installPath: '/p' }];
	const all = mergePlugins(available, installed);
	assert.equal(all.total, 4);
	assert.deepEqual(all.items.map((p) => p.id), ['z@other', 'c@claude-plugins-official', 'b@claude-plugins-official', 'a@other']);
	assert.equal(all.items[0].installed, true);
	assert.equal(all.items[0].enabled, false);
	assert.equal(all.items[1].official, true);
	assert.equal(all.items[3].official, false);

	assert.deepEqual(mergePlugins(available, installed, { q: 'ALPHA' }).items.map((p) => p.id), ['a@other']);
	const page = mergePlugins(available, [], { limit: 1, offset: 1 });
	assert.equal(page.total, 3);
	assert.deepEqual(page.items.map((p) => p.id), ['b@claude-plugins-official']);
});

test('mergePlugins can list installed and not-installed separately', () => {
	const available = [{ pluginId: 'a@m', name: 'a', description: 'x' }, { pluginId: 'b@m', name: 'b', description: 'y' }];
	const installed = [{ id: 'b@m', enabled: true }];
	assert.deepEqual(mergePlugins(available, installed, { view: 'installed' }).items.map((p) => p.id), ['b@m']);
	const d = mergePlugins(available, installed, { view: 'discover' });
	assert.deepEqual(d.items.map((p) => p.id), ['a@m']);
	assert.equal(d.total, 1);
});

// The launcher installs only these from the bundle (see "sync" in phone/debian): anything else
// under app/ ships in the package and then silently never reaches the phone.
test('app/ holds only the directories the launcher installs', async () => {
	const dirs = (await readdir(new URL('../app/', import.meta.url), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
	assert.deepEqual(dirs, ['server', 'skills', 'web']);
	const launcher = await readFile(new URL('../phone/debian', import.meta.url), 'utf8');
	for (const d of dirs) assert.ok(launcher.includes(`$tmp/${d}`), `launcher does not install ${d}`);
});

test('the catalogs the server reads are valid and inside server/', async () => {
	for (const [file, n] of [['skills.json', 15], ['connectors.json', 10]]) {
		const list = JSON.parse(await readFile(new URL(`../app/server/catalog/${file}`, import.meta.url), 'utf8'));
		assert.equal(list.length, n);
		assert.equal(new Set(list.map((x) => x.id)).size, n);
		if (file === 'skills.json') for (const s of list) assert.ok(parseSkillSource(s.source), s.id);
		else for (const c of list) assert.doesNotThrow(() => buildMcpEntry(c, Object.fromEntries((c.inputs || []).map((i) => [i.key, 'v']))), c.id);
	}
});

test('normalizeRegistry keeps the latest active version and usable transports', () => {
	const r = normalizeRegistry({ servers: [
		{ server: { name: 'io.x/remote', title: 'Remote', description: 'd', version: '2', remotes: [{ type: 'streamable-http', url: 'https://x/mcp', headers: [{ name: 'Authorization', value: 'Bearer {key}', isRequired: true, isSecret: true, description: 'k' }] }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } } },
		{ server: { name: 'io.x/remote', version: '1', remotes: [{ type: 'sse', url: 'https://old' }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: false } } },
		{ server: { name: 'io.x/gone', version: '1', remotes: [{ type: 'sse', url: 'https://g' }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deleted', isLatest: true } } },
		{ server: { name: 'io.x/npm', version: '3', packages: [{ registryType: 'npm', identifier: '@x/mcp', version: '3', environmentVariables: [{ name: 'API_KEY', isRequired: true, isSecret: true }] }] } },
		{ server: { name: 'io.x/py', version: '1', packages: [{ registryType: 'pypi', identifier: 'x-mcp', version: '1' }] } },
		{ server: { name: 'io.x/oci', version: '1', packages: [{ registryType: 'oci', identifier: 'x' }] } },
		{ server: { name: 'io.x/tpl', version: '1', remotes: [{ type: 'streamable-http', url: 'https://{tenant}.x/mcp' }] } },
	] });
	const by = Object.fromEntries(r.map((c) => [c.id, c]));
	assert.deepEqual(Object.keys(by).sort(), ['io.x/npm', 'io.x/py', 'io.x/remote']);
	assert.equal(by['io.x/remote'].type, 'http');
	assert.equal(by['io.x/remote'].url, 'https://x/mcp');
	assert.deepEqual(by['io.x/remote'].inputs, [{ key: 'Authorization', kind: 'header', label: 'k', secret: true, required: true, template: 'Bearer {key}' }]);
	assert.equal(by['io.x/npm'].type, 'stdio');
	assert.equal(by['io.x/npm'].command, 'npx');
	assert.deepEqual(by['io.x/npm'].args, ['-y', '@x/mcp@3']);
	assert.equal(by['io.x/npm'].inputs[0].kind, 'env');
	assert.equal(by['io.x/py'].command, 'uvx');
	assert.deepEqual(by['io.x/py'].args, ['x-mcp==1']);
});

test('buildMcpEntry fills inputs and refuses bad ones', () => {
	const remote = { type: 'http', url: 'https://x/mcp', inputs: [{ key: 'Authorization', kind: 'header', secret: true, required: true, template: 'Bearer {key}' }] };
	assert.deepEqual(buildMcpEntry(remote, { Authorization: 'abc' }), { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer abc' }, disabled: false });
	assert.throws(() => buildMcpEntry(remote, {}), /Authorization/);
	assert.throws(() => buildMcpEntry(remote, { Authorization: 'a\r\nX-Evil: 1' }), /换行/);
	const local = { type: 'stdio', command: 'npx', args: ['-y', 'p@1'], inputs: [{ key: 'API_KEY', kind: 'env', required: false }] };
	assert.deepEqual(buildMcpEntry(local, {}), { type: 'stdio', command: 'npx', args: ['-y', 'p@1'], env: {}, disabled: false });
	assert.deepEqual(buildMcpEntry(local, { API_KEY: 'k', OTHER: 'ignored' }).env, { API_KEY: 'k' });
	assert.throws(() => buildMcpEntry({ type: 'http', url: 'ftp://x' }, {}), /地址/);
	assert.throws(() => buildMcpEntry({ type: 'stdio', command: 'sh', args: [] }, {}), /命令/);
});

test('inspectPluginDir reports the parts that can run things', async () => {
	const d = await tmp();
	try {
		await mkdir(join(d, '.claude-plugin'));
		await writeFile(join(d, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p', version: '1', description: 'desc', author: { name: 'Me' } }));
		await skill(join(d, 'skills', 'one'));
		await mkdir(join(d, 'commands'));
		await writeFile(join(d, 'commands', 'go.md'), 'x');
		await mkdir(join(d, 'agents'));
		await writeFile(join(d, 'agents', 'rev.md'), 'x');
		await mkdir(join(d, 'hooks'));
		await writeFile(join(d, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sh ${CLAUDE_PLUGIN_ROOT}/x.sh' }] }] } }));
		await writeFile(join(d, '.mcp.json'), JSON.stringify({ mcpServers: { remote: { type: 'http', url: 'https://r' }, local: { command: 'npx', args: ['-y', 'q'] } } }));
		const r = await inspectPluginDir(d);
		assert.equal(r.description, 'desc');
		assert.equal(r.author, 'Me');
		assert.deepEqual(r.skills, ['one']);
		assert.deepEqual(r.commands, ['go']);
		assert.deepEqual(r.agents, ['rev']);
		assert.deepEqual(r.hooks, [{ event: 'PreToolUse', command: 'sh ${CLAUDE_PLUGIN_ROOT}/x.sh' }]);
		assert.deepEqual(r.mcp, [{ name: 'remote', target: 'https://r', local: false }, { name: 'local', target: 'npx -y q', local: true }]);
		assert.equal(r.runsCode, true);

		const plain = await tmp();
		await skill(join(plain, 'skills', 'one'));
		const p = await inspectPluginDir(plain);
		assert.equal(p.runsCode, false);
		assert.deepEqual(p.hooks, []);
		await rm(plain, { recursive: true, force: true });

		const broken = await tmp();
		await mkdir(join(broken, 'hooks'));
		await writeFile(join(broken, 'hooks', 'hooks.json'), '{not json');
		const b = await inspectPluginDir(broken);
		assert.equal(b.runsCode, true, 'an unreadable hooks file must not look harmless');
		await rm(broken, { recursive: true, force: true });
	} finally { await rm(d, { recursive: true, force: true }); }
});

test('inspectSkillDir says what Claude Code will make of a directory', async () => {
	const d = await tmp();
	try {
		await mkdir(join(d, 'plain'));
		await writeFile(join(d, 'plain', 'SKILL.md'), '---\nname: shown\ndescription: d\nargument-hint: <file>\n---\nb\n');
		const plain = await inspectSkillDir(join(d, 'plain'), 'plain');
		assert.equal(plain.loadable, true);
		assert.equal(plain.name, 'shown');
		assert.equal(plain.description, 'd');
		assert.equal(plain.argumentHint, '<file>');
		assert.equal(plain.userInvocable, true);
		assert.equal(plain.modelInvocable, true);

		await mkdir(join(d, 'flags'));
		await writeFile(join(d, 'flags', 'SKILL.md'), '---\nname: flags\ndescription: d\nuser-invocable: false\ndisable-model-invocation: true\n---\nb\n');
		const flags = await inspectSkillDir(join(d, 'flags'), 'flags');
		assert.equal(flags.userInvocable, false);
		assert.equal(flags.modelInvocable, false);

		await mkdir(join(d, 'bare'));
		await writeFile(join(d, 'bare', 'SKILL.md'), 'no frontmatter at all\n');
		const bare = await inspectSkillDir(join(d, 'bare'), 'bare');
		assert.equal(bare.loadable, true, 'Claude Code loads it under its directory name');
		assert.equal(bare.name, 'bare');

		// A repository cloned in whole: the folder is there, but Claude Code never reads this deep.
		await skill(join(d, 'repo', 'skills', 'inner'), 'inner');
		const repo = await inspectSkillDir(join(d, 'repo'), 'repo');
		assert.equal(repo.loadable, false);
		assert.deepEqual(repo.nested, ['inner']);

		await mkdir(join(d, 'empty'));
		const empty = await inspectSkillDir(join(d, 'empty'), 'empty');
		assert.equal(empty.loadable, false);
		assert.deepEqual(empty.nested, []);
	} finally { await rm(d, { recursive: true, force: true }); }
});

test('mergeSlashCommands puts what is on disk over a stale or missing list', () => {
	const on = (id, extra = {}) => ({ id, name: id, description: `${id} desc`, argumentHint: '', enabled: true, loadable: true, userInvocable: true, modelInvocable: true, nested: [], ...extra });
	const names = (l) => l.map((c) => c.name);

	// No conversation running: the fallback list still gets every working skill.
	const fresh = mergeSlashCommands([{ name: 'compact', description: 'c' }], [on('mine')]);
	assert.deepEqual(names(fresh), ['compact', 'mine']);
	assert.equal(fresh[1].kind, 'skill');
	assert.equal(fresh[1].description, 'mine desc');
	assert.equal(fresh[0].kind, undefined, 'a built-in command is not a skill');

	// Installed by hand after the conversation began: Claude Code's list doesn't have it yet.
	const live = [{ name: 'context', description: 'x' }, { name: 'old', description: 'from claude', argumentHint: '<a>' }];
	const merged = mergeSlashCommands(live, [on('old'), on('new')]);
	assert.deepEqual(names(merged), ['context', 'old', 'new']);
	assert.equal(merged[1].kind, 'skill');
	assert.equal(merged[1].argumentHint, '<a>', 'what Claude Code reports wins');
	assert.equal(merged[1].description, 'old desc', 'but not its description, which has " (user)" stuck on');

	// Deleted by hand: Claude Code 2.1.112's list never changes, so remember what used to be a skill.
	assert.deepEqual(names(mergeSlashCommands(live, [], new Set(['old']))), ['context']);
	// Turned off since the conversation began: gone at once.
	assert.deepEqual(names(mergeSlashCommands(live, [on('old', { enabled: false })])), ['context']);
	// ...unless another skill that is on answers to the same name.
	assert.deepEqual(names(mergeSlashCommands(live, [on('old', { enabled: false }), on('b', { name: 'old' })])), ['context', 'old']);

	// Would only fail if chosen.
	assert.deepEqual(names(mergeSlashCommands([], [on('broken', { loadable: false }), on('hidden', { userInvocable: false })])), []);

	// Called by its frontmatter name, findable by its directory name too.
	const renamed = mergeSlashCommands([], [on('dir', { name: 'shown' })]);
	assert.deepEqual(names(renamed), ['shown']);
	assert.deepEqual(renamed[0].aliases, ['dir']);

	// Plugin skills arrive namespaced from Claude Code.
	assert.equal(mergeSlashCommands([{ name: 'pdemo:pone', description: 'p' }], [])[0].kind, 'skill');
});

test('compatibleMarketplace keeps only what Claude Code 2.1.112 can read, under its own name', () => {
	const official = {
		name: 'claude-plugins-official', owner: { name: 'Anthropic' },
		plugins: [
			{ name: 'local', source: './plugins/local' },
			{ name: 'gh', source: { source: 'github', repo: 'a/b' } },
			{ name: 'sub', source: { source: 'git-subdir', url: 'https://x/y.git', path: 'p' } },
			{ name: 'xcode', source: { source: 'command', command: 'xcrun agent plugin path' } },
			{ name: 'nosource' },
		],
	};
	const { json, dropped } = compatibleMarketplace(official);
	assert.equal(json.name, COMPAT_MARKETPLACE);
	assert.ok(!/official|anthropic|claude/i.test(COMPAT_MARKETPLACE));
	assert.deepEqual(json.plugins.map((p) => p.name), ['local', 'gh', 'sub']);
	assert.deepEqual(dropped, ['xcode', 'nosource']);
	assert.deepEqual(json.owner, official.owner);
	assert.equal(official.plugins.length, 5); // the input is left alone
	assert.deepEqual(compatibleMarketplace(null).json.plugins, []);
});
