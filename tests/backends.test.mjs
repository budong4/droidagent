// Run: node --test tests/backends.test.mjs
// The two agents behind a conversation, without a phone, an account or the real CLIs: the event
// mapping of each, and the Antigravity backend driving tests/fake-agy.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { channel, backendOf, agySlug } from '../app/server/backends/common.mjs';
import { createClaudeMapper, getSdkModel, thinkingFor } from '../app/server/backends/claude.mjs';
import {
	agyPlatform, parseAgyModels, normalizeAgyTool, agyErrorText, parseAgyUsage, usageGroupFor,
	toAgyMcp, mergeAgyMcp, mergeAgyAllow, agyAllowRules, createAgyBackend,
} from '../app/server/backends/antigravity.mjs';
import { configOption, flatOptions, pickModelValue, pickLevelValue, levelsOf, contentText, toolOf } from '../app/server/backends/agy_acp.mjs';
import * as oauth from '../app/server/backends/agy_oauth.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, 'fake-agy.mjs');
const line = (o) => JSON.stringify(o);
// The command list arrives whenever agy sends it; it is not part of what a turn shows.
const types = (evs) => evs.map((e) => e.type).filter((x) => x !== 'commands_changed');

test('a model id names its agent', () => {
	assert.equal(backendOf('sonnet'), 'claude');
	assert.equal(backendOf('opus-4.8'), 'claude');
	assert.equal(backendOf(undefined), 'claude');
	assert.equal(backendOf('agy:gemini-4-carbon-high'), 'agy');
	assert.equal(agySlug('agy:gemini-4-carbon-high'), 'gemini-4-carbon-high');
	assert.equal(agySlug('agy:'), '');
	assert.equal(agySlug('sonnet'), '');
});

test('the channel hands over what was pushed, in order, then ends', async () => {
	const ch = channel();
	ch.push(1);
	setTimeout(() => { ch.push(2); ch.end(); ch.push(3); }, 5);
	const got = [];
	for await (const v of ch) got.push(v);
	assert.deepEqual(got, [1, 2]);
});

// ---------------------------------------------------------------- Claude
test('Claude model names and thinking', () => {
	assert.equal(getSdkModel('Opus 5.5'), 'opus');
	assert.equal(getSdkModel(''), 'sonnet');
	assert.equal(getSdkModel('opus-4.8'), 'claude-opus-4-8', 'an older model runs as itself, not as the newest of its family');
	assert.equal(getSdkModel('haiku-4.5'), 'claude-haiku-4-5');
	assert.equal(getSdkModel('sonnet'), 'sonnet');
	assert.equal(thinkingFor('sonnet').type, 'adaptive');
	assert.equal(thinkingFor('haiku-4.5').type, 'enabled');
});

test('a streamed Claude turn becomes turn events, the whole message not shown twice', () => {
	const map = createClaudeMapper();
	const all = (m) => [...map(m)];
	assert.deepEqual(all({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-5-5' }), [{ type: 'init', ref: 's1', model: 'claude-sonnet-5-5' }]);
	const delta = (d) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: d } });
	assert.deepEqual(types(all({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } })), ['thinking_start']);
	assert.deepEqual(all(delta({ type: 'thinking_delta', thinking: 'hm' })), [{ type: 'thinking_delta', text: 'hm' }]);
	assert.deepEqual(types(all({ type: 'stream_event', event: { type: 'content_block_stop' } })), ['thinking_end']);
	assert.deepEqual(all({ type: 'stream_event', event: { type: 'content_block_stop' } }), [], 'a text block ending is not the end of thinking');
	assert.deepEqual(all(delta({ type: 'text_delta', text: 'Hi' })), [{ type: 'text_delta', text: 'Hi' }]);
	assert.deepEqual(types(all({ type: 'stream_event', event: { type: 'message_stop' } })), ['text_end']);
	const whole = { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Hi' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } };
	assert.deepEqual(all(whole), [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]);
	assert.deepEqual(all({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'no' }, { type: 'text', text: 'pe' }] }] } }),
		[{ type: 'tool_result', id: 't1', ok: false, text: 'nope' }]);
	// The next message was not streamed (a plain request): it arrives whole and is shown.
	assert.deepEqual(types(all(whole)), ['thinking', 'text', 'tool_use']);
	assert.deepEqual(all({ type: 'result', is_error: false, result: 'Hi', total_cost_usd: 0.01, duration_ms: 12, subtype: 'success' }),
		[{ type: 'result', ok: true, text: 'Hi', costUsd: 0.01, durationMs: 12, subtype: 'success', errors: undefined }]);
});

test('what Claude Code says about itself', () => {
	const map = createClaudeMapper();
	assert.deepEqual([...map({ type: 'system', subtype: 'local_command_output', content: ' ctx 12% \n' })], [{ type: 'command_output', text: 'ctx 12%' }]);
	assert.deepEqual([...map({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 120000, post_tokens: 8000 } })], [{ type: 'notice', text: '对话已压缩（120k → 8k tokens）' }]);
	assert.deepEqual([...map({ type: 'system', subtype: 'commands_changed' })], [{ type: 'commands_changed' }]);
	assert.deepEqual([...map({ type: 'system', subtype: 'something_else' })], []);
});

// ---------------------------------------------------------------- Antigravity: pure pieces
test('which build to download', () => {
	assert.equal(agyPlatform('arm64', false), 'linux_arm64');
	assert.equal(agyPlatform('x64', false), 'linux_amd64');
	assert.equal(agyPlatform('arm64', true), 'linux_arm64_musl');
	assert.equal(agyPlatform('ia32', false), null);
});

test('the model list, as a table or as JSON', () => {
	assert.deepEqual(parseAgyModels('gemini-4-carbon-high\tGemini 4 Carbon (High)\ngemini-3.8-flash      Gemini 3.8 Flash\n'),
		[{ slug: 'gemini-4-carbon-high', label: 'Gemini 4 Carbon (High)' }, { slug: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }]);
	assert.deepEqual(parseAgyModels('Fetching models...\nError: Please sign in\n'), []);
	assert.deepEqual(parseAgyModels(JSON.stringify([{ id: 'a', display_name: 'A' }, { id: 'a', display_name: 'again' }, 'b'])), [{ slug: 'a', label: 'A' }, { slug: 'b', label: 'b' }]);
	assert.deepEqual(parseAgyModels(''), []);
});

test("agy's tools, reshaped into the ones the cards and the policy know", () => {
	assert.deepEqual(normalizeAgyTool('run_command', { CommandLine: 'ls -la' }), { name: 'Bash', input: { command: 'ls -la', description: undefined } });
	assert.deepEqual(normalizeAgyTool('view_file', { AbsolutePath: '/a/b.txt' }), { name: 'Read', input: { file_path: '/a/b.txt' } });
	assert.deepEqual(normalizeAgyTool('write_to_file', { TargetFile: '/a/c' }), { name: 'Write', input: { file_path: '/a/c' } });
	assert.deepEqual(normalizeAgyTool('replace_file_content', { target_file: '/a/c' }), { name: 'Edit', input: { file_path: '/a/c' } });
	assert.deepEqual(normalizeAgyTool('list_dir', { DirectoryPath: '/sdcard' }), { name: 'LS', input: { path: '/sdcard' } });
	assert.deepEqual(normalizeAgyTool('grep_search', { Query: 'x', SearchPath: '/a' }), { name: 'Grep', input: { pattern: 'x', path: '/a' } });
	assert.deepEqual(normalizeAgyTool('search_web', { query: 'weather' }), { name: 'WebSearch', input: { query: 'weather' } });
	assert.deepEqual(normalizeAgyTool('read_url_content', { Url: 'https://example.com' }), { name: 'WebFetch', input: { url: 'https://example.com' } });
	assert.deepEqual(normalizeAgyTool('call_mcp_tool', { ServerName: 'playwright', ToolName: 'browser_navigate', Arguments: '{"url":"https://example.com"}' }),
		{ name: 'mcp__playwright__browser_navigate', input: { url: 'https://example.com' } });
	// Our own tools show as what they do.
	assert.deepEqual(normalizeAgyTool('something_new', { A: 1 }), { name: 'something_new', input: { A: 1 } });
	assert.deepEqual(normalizeAgyTool(undefined, undefined), { name: 'tool', input: {} });
});

test('errors, said plainly', () => {
	assert.equal(agyErrorText('You are not logged into Antigravity.').code, 'auth');
	assert.equal(agyErrorText('RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h').code, 'quota');
	assert.equal(agyErrorText('FAILED_PRECONDITION (code 400): User location is not supported for the API use.').code, 'region');
	assert.equal(agyErrorText('invalid model selection (--model "x" --effort ""): model x is not recognized as a known model').code, 'model');
	// "Eligibility check failed" around a transport error is the network, not the region.
	assert.equal(agyErrorText('Eligibility check failed: failed to get profile picture: net/http: TLS handshake timeout').code, 'network');
	// So is "not logged in" when the token could not be checked.
	assert.equal(agyErrorText('You are not logged into Antigravity.', 'token validation failed due to network error: Post "https://oauth2.googleapis.com/token": EOF').code, 'network');
	assert.deepEqual(agyErrorText('upstream request failed'), { code: 'error', text: 'upstream request failed' });
	assert.equal(agyErrorText('', 'a\nboom: crashed\n').text, 'boom: crashed');
});

test('usage, as /usage reports it', () => {
	const groups = parseAgyUsage(line({ event: 'command_result', command: { name: 'usage', data: { groups: [
		{ name: 'Gemini', buckets: [{ id: 'g5', window: '5h', remaining_fraction: 0.75, reset_time: '2030-01-01T00:00:00Z' }, { id: 'gw', window: 'weekly', remaining_fraction: 0.4 }] },
		{ name: 'Gemini 4 Argon', description: 'Separate from the Gemini quota bucket', buckets: [{ id: 'argon-weekly', window: 'weekly', remaining_fraction: 1 }] },
		{ name: 'Claude and GPT', buckets: [{ id: 'x', window: '5h', remaining_fraction: 0.1 }] },
	] } } }));
	assert.equal(groups.length, 3);
	assert.deepEqual(groups[0].buckets, [{ window: '5h', utilization: 25, resets_at: '2030-01-01T00:00:00Z' }, { window: 'week', utilization: 60, resets_at: null }]);
	assert.equal(usageGroupFor(groups, 'gemini-4-carbon-high').name, 'Gemini');
	assert.equal(usageGroupFor(groups, 'gemini-4-argon').name, 'Gemini 4 Argon');
	assert.equal(usageGroupFor(groups, 'claude-sonnet-5-5').name, 'Claude and GPT');
	assert.equal(usageGroupFor(groups, '').name, 'Gemini');
	assert.equal(usageGroupFor([], 'x'), null);
	assert.deepEqual(parseAgyUsage('Gemini\t5-hour limit\t80%\t2030-01-01T00:00:00Z\nGemini\tWeekly limit\t50%\n'), [{ name: 'Gemini', description: '', buckets: [{ window: '5h', utilization: 20, resets_at: '2030-01-01T00:00:00Z' }, { window: 'week', utilization: 50, resets_at: null }] }]);
	assert.deepEqual(parseAgyUsage('nothing useful'), []);
});

test("agy's MCP list follows the app's connectors and leaves the owner's entries alone", () => {
	assert.deepEqual(toAgyMcp({ type: 'stdio', command: 'npx', args: ['x'], env: {} }), { command: 'npx', args: ['x'] });
	assert.deepEqual(toAgyMcp({ type: 'http', url: 'https://m.example/mcp', headers: { Authorization: 'Bearer t' } }), { serverUrl: 'https://m.example/mcp', headers: { Authorization: 'Bearer t' } });
	assert.equal(toAgyMcp({ type: 'sse', url: 'https://m.example/sse' }), null, 'agy does not speak the old SSE transport');
	const current = { mcpServers: { theirs: { command: 'their-server' }, playwright: { command: 'their-own-playwright' }, gone: { command: 'old' } }, other: 1 };
	const next = mergeAgyMcp(current, { droidagent: { command: 'node' }, playwright: { command: 'npx' }, fetch: { command: 'uvx' } }, ['gone', 'fetch']);
	assert.deepEqual(next.config, { mcpServers: { theirs: { command: 'their-server' }, playwright: { command: 'their-own-playwright' }, droidagent: { command: 'node' }, fetch: { command: 'uvx' } }, other: 1 });
	assert.deepEqual(next.managed, ['droidagent', 'fetch']);
	assert.deepEqual(mergeAgyMcp({}, {}, ['droidagent']).config, { mcpServers: {} });
});

test('no approvals of ours are granted up front any more; those an earlier version added are taken out, never the owner\'s', () => {
	assert.deepEqual(agyAllowRules('acceptEdits'), []);
	const before = { model: 'x', permissions: { allow: ['command(git)', 'mcp(droidagent/*)', 'mcp(*)'], deny: ['command(rm)'] } };
	const r = mergeAgyAllow(before, agyAllowRules('auto'), ['mcp(droidagent/*)', 'mcp(*)']);
	assert.deepEqual(r.settings.permissions, { allow: ['command(git)'], deny: ['command(rm)'] });
	assert.deepEqual(r.managed, []);
	assert.equal(r.settings.model, 'x');
});

// ---------------------------------------------------------------- Antigravity: the backend, driving the fake CLI
function setup() {
	const home = mkdtempSync(join(tmpdir(), 'agy-test-'));
	const logFile = join(home, 'agy-runs.jsonl');
	const saved = { AGENT_AGY_BIN: process.env.AGENT_AGY_BIN, FAKE_AGY_LOG: process.env.FAKE_AGY_LOG, HOME: process.env.HOME };
	Object.assign(process.env, { AGENT_AGY_BIN: FAKE, FAKE_AGY_LOG: logFile, HOME: home });
	const logs = [];
	const agy = createAgyBackend({ log: (...a) => logs.push(a.join(' ')), home, serverDir: join(HERE, '..', 'app', 'server'), fetchUrl: async () => { throw new Error('no network in tests'); }, stateDir: join(home, '.droidagent'), cacheDir: join(home, '.cache') });
	const runs = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
	const handles = [];
	const done = () => { for (const h of handles) h.close(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } rmSync(home, { recursive: true, force: true }); };
	return { home, agy, runs, logs, done, handles };
}
// The events of one turn: everything up to and including its result.
async function turn(it) {
	const got = [];
	for (;;) {
		const { value, done } = await Promise.race([it.next(), new Promise((_, reject) => setTimeout(() => reject(new Error(`turn did not end; so far: ${got.map((e) => e.type).join(", ")}`)), 8000).unref())]);
		if (done) break;
		got.push(value);
		if (value.type === 'result') break;
	}
	return got;
}

test('the fake CLI is found, versioned and listed', async () => {
	const t = setup();
	try {
		assert.equal(t.agy.find(), FAKE);
		assert.equal(await t.agy.version(), '1.5.9-fake');
		assert.equal(t.agy.loggedIn(), false);
		mkdirSync(dirname(t.agy.paths.TOKEN_FILE), { recursive: true });
		writeFileSync(t.agy.paths.TOKEN_FILE, JSON.stringify({ token: { access_token: 'a', refresh_token: 'r' }, auth_method: 'consumer' }));
		assert.equal(t.agy.loggedIn(), true);
		assert.deepEqual((await t.agy.models()).models.map((m) => m.slug), ['gemini-4-carbon-high', 'gemini-4-carbon-low', 'gemini-3.8-flash', 'claude-sonnet-5-5']);
		assert.deepEqual(await t.agy.status(), { installed: true, path: FAKE, version: '1.5.9-fake', loggedIn: true, installing: false });
		const u = await t.agy.usage();
		assert.equal(u.ok, true);
		assert.equal(u.groups[0].buckets[0].utilization, 25);
		assert.deepEqual((await t.agy.plugins()).plugins, [{ name: 'demo-plugin', version: '1.0.0', description: 'a plugin', source: '' }]);
		assert.equal((await t.agy.installPlugin('some-plugin')).ok, true);
		assert.equal((await t.agy.installPlugin('https://github.com/a/b')).ok, true);
		assert.equal((await t.agy.installPlugin('broken')).ok, false);
		for (const bad of ['--help', '-x', 'a b; rm -rf /', 'http://github.com/a/b', 'https://evil.example/a/b', '']) assert.equal((await t.agy.installPlugin(bad)).ok, false, bad);
		await t.agy.logout();
		assert.equal(t.agy.loggedIn(), false);
	} finally { t.done(); }
});

// ---------------------------------------------------------------- ACP: the pieces
test("agy's config options: the model and the thinking level, found and matched", () => {
	const opts = [
		{ id: 'mdl', name: 'Model', category: 'model', currentValue: 'gemini-3.8-flash', options: [{ group: 'g', name: 'G', options: [{ value: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon (High)' }, { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }] }, { value: 'claude-opus-5-5-thinking', name: 'Claude Opus 5.5 (Thinking)' }] },
		{ id: 'think', name: 'Thinking level', category: 'thought_level', currentValue: 'High', options: ['Low', 'Medium', 'High', 'Extra', 'Max'].map((v) => ({ value: v, name: v })) },
	];
	assert.equal(configOption(opts, 'model').id, 'mdl');
	assert.equal(configOption(opts, 'thought_level').id, 'think');
	assert.equal(configOption([{ id: 'reasoning_effort', name: 'Reasoning', options: [] }], 'thought_level').id, 'reasoning_effort', 'found by its name when there is no category');
	assert.equal(configOption([], 'model'), null);
	assert.equal(flatOptions(opts[0]).length, 3);
	assert.equal(pickModelValue(opts[0], 'gemini-4-carbon-high', ''), 'gemini-4-carbon-high');
	assert.equal(pickModelValue(opts[0], 'claude-opus-5-5', 'Claude Opus 5.5 (Thinking)'), 'claude-opus-5-5-thinking');
	assert.equal(pickModelValue(opts[0], 'nothing-like-it', 'Nothing'), null);
	assert.equal(pickLevelValue(opts[1], 'xhigh'), 'Extra');
	assert.equal(pickLevelValue(opts[1], 'low'), 'Low');
	assert.equal(pickLevelValue({ options: [{ value: 'mid', name: 'Medium' }] }, 'medium'), 'mid');
	assert.deepEqual(levelsOf(opts[1]), ['low', 'medium', 'high', 'xhigh', 'max']);
	assert.deepEqual(levelsOf({ options: [{ value: 'a', name: 'Low' }, { value: 'b', name: 'High' }] }), ['low', 'high']);
});

test('ACP steps, as the cards and the policy know steps', () => {
	assert.deepEqual(toolOf({ kind: 'execute', title: 'Run ls', rawInput: { CommandLine: 'ls -la' }, name: 'run_command' }, normalizeAgyTool), { name: 'Bash', input: { command: 'ls -la', description: undefined } });
	assert.deepEqual(toolOf({ kind: 'execute', title: 'Run x', rawInput: { CommandLine: 'pm list packages' } }, normalizeAgyTool).input.command, 'pm list packages');
	assert.deepEqual(toolOf({ kind: 'edit', locations: [{ path: '/sdcard/a.txt' }], rawInput: { CodeContent: 'x' } }, normalizeAgyTool), { name: 'Write', input: { file_path: '/sdcard/a.txt' } });
	assert.deepEqual(toolOf({ kind: 'edit', locations: [{ path: '/etc/x' }], rawInput: {} }, normalizeAgyTool), { name: 'Edit', input: { file_path: '/etc/x' } });
	// Deleting and moving ask as the commands that do them would.
	assert.deepEqual(toolOf({ kind: 'delete', title: 'Delete', locations: [{ path: '/sdcard/DCIM' }] }, normalizeAgyTool).input.command, 'rm -rf /sdcard/DCIM');
	assert.equal(toolOf({ kind: 'read', locations: [{ path: '/proc/meminfo' }] }, normalizeAgyTool).name, 'Read');
	assert.deepEqual(toolOf({ kind: 'fetch', rawInput: { Url: 'https://example.com' } }, normalizeAgyTool), { name: 'WebFetch', input: { url: 'https://example.com' } });
	assert.equal(toolOf({ kind: 'switch_mode', rawInput: { plan: 'do it' } }, normalizeAgyTool).name, 'ExitPlanMode');
	assert.equal(toolOf({ kind: 'other', rawInput: { ServerName: 'playwright', ToolName: 'browser_navigate', Arguments: { url: 'x' } } }, normalizeAgyTool).name, 'mcp__playwright__browser_navigate');
	assert.equal(toolOf({}, normalizeAgyTool).name, 'tool');
	assert.equal(contentText([{ type: 'content', content: { type: 'text', text: 'a' } }, { type: 'diff', path: '/x', newText: 'b' }]), 'a\n/x\nb');
	assert.equal(agyErrorText('Authentication required', '', -32000).code, 'auth');
});

// ---------------------------------------------------------------- ACP: a conversation, driving the fake CLI
const conversation = (t, settings, extra = {}) => {
	const cards = [];
	const handle = t.agy.open({
		tag: 't', cwd: t.home, settings, preamble: () => 'APP RULES', prepareTurn: async () => {},
		canUseTool: async (name, input) => { cards.push([name, input]); return extra.answer ? extra.answer(name, input) : { behavior: 'allow' }; },
		...extra.open,
	});
	t.handles.push(handle);
	return { handle, it: handle.events[Symbol.asyncIterator](), cards };
};
const signIn = (t) => { mkdirSync(dirname(t.agy.paths.TOKEN_FILE), { recursive: true }); writeFileSync(t.agy.paths.TOKEN_FILE, JSON.stringify({ token: { refresh_token: 'r' } })); };

test('a conversation: the lead-in once, the model and thinking level set, the same session on the next turn', async () => {
	const t = setup();
	try {
		signIn(t);
		const settings = { mode: 'acceptEdits', model: 'agy:gemini-4-carbon-high', modelName: 'Gemini 4 Carbon', effort: 'xhigh' };
		const { handle, it } = conversation(t, settings);
		handle.send('hello');
		const first = await turn(it);
		assert.deepEqual(types(first), ['init', 'text_delta', 'text_delta', 'text_end', 'result']);
		assert.equal(first[0].fresh, true);
		assert.equal(first.filter((e) => e.type === 'text_delta').map((e) => e.text).join(''), 'echo(gemini-4-carbon-high/extra): hello');
		assert.deepEqual({ ok: first.at(-1).ok, subtype: first.at(-1).subtype }, { ok: true, subtype: 'success' });
		// Changed between turns: applied before the next one, in the same session.
		settings.model = 'agy:claude-sonnet-5-5';
		settings.modelName = 'Claude Sonnet 5.5 (Thinking)';
		settings.effort = 'low';
		handle.send('again');
		const second = await turn(it);
		assert.equal(second.filter((e) => e.type === 'text_delta').map((e) => e.text).join(''), 'echo(claude-sonnet-5-5/low): again');
		const prompts = t.runs().filter((r) => r.prompt);
		assert.match(prompts[0].prompt, /^APP RULES\n\n---\n\n【用户的消息】\nhello$/);
		assert.equal(prompts[1].prompt, 'again');
		assert.equal(prompts[0].sessionId, prompts[1].sessionId);
		assert.equal(t.runs().filter((r) => r.newSession).length, 1, 'one process, one session, for both turns');
		assert.deepEqual(t.runs().find((r) => r.newSession).argv, ['acp'], 'below Full access, agy asks');
		assert.deepEqual((await handle.control.supportedCommands()).map((c) => c.name), ['compress', 'plan']);
		assert.equal(configOption(handle.control.options(), 'thought_level').currentValue, 'low');
		handle.close();
	} finally { t.done(); }
});

test("each step agy asks about goes to the app's policy; its answer is agy's", async () => {
	const t = setup();
	try {
		signIn(t);
		const target = join(t.home, 'made.txt');
		const { handle, it, cards } = conversation(t, { mode: 'default', model: 'agy:gemini-3.8-flash', effort: 'high' }, {
			answer: (name, input) => (input.command?.includes('rm ') ? { behavior: 'deny', message: 'no' } : { behavior: 'allow' }),
		});
		handle.send('shell: echo hi && touch made.txt');
		const ok = await turn(it);
		assert.deepEqual(cards[0], ['Bash', { command: 'echo hi && touch made.txt', description: undefined }]);
		assert.deepEqual(types(ok).filter((x) => x !== 'text_delta' && x !== 'text_end'), ['init', 'tool_use', 'tool_result', 'result']);
		assert.deepEqual(ok.find((e) => e.type === 'tool_result'), { type: 'tool_result', id: ok.find((e) => e.type === 'tool_use').id, ok: true, text: 'hi' });
		assert.ok(existsSync(target));
		handle.send('shell: rm made.txt');
		const no = await turn(it);
		assert.equal(no.find((e) => e.type === 'tool_result').ok, false);
		assert.ok(existsSync(target), 'refused: not run');
		handle.send('write: ' + join(t.home, 'w', 'a.txt') + '=x=y');
		const w = await turn(it);
		assert.deepEqual(cards.at(-1), ['Write', { file_path: join(t.home, 'w', 'a.txt') }]);
		assert.equal(readFileSync(join(t.home, 'w', 'a.txt'), 'utf8'), 'x=y');
		assert.equal(w.at(-1).ok, true);
		handle.close();
	} finally { t.done(); }
});

test("thoughts stream as thoughts, a plan as the checklist, a stop as a stop", async () => {
	const t = setup();
	try {
		signIn(t);
		const { handle, it } = conversation(t, { mode: 'auto', model: 'agy:gemini-3.8-flash', effort: 'high' });
		handle.send('think: battery');
		const th = await turn(it);
		assert.deepEqual(types(th), ['init', 'thinking_start', 'thinking_delta', 'thinking_end', 'tool_use', 'tool_result', 'thinking_start', 'thinking_delta', 'thinking_delta', 'thinking_end', 'text_delta', 'text_delta', 'text_end', 'result']);
		assert.deepEqual(th.filter((e) => e.type === 'thinking_delta').map((e) => e.text), ['first thought about battery', 'I should', ' look at the files']);
		assert.deepEqual(th.find((e) => e.type === 'tool_use'), { type: 'tool_use', id: th.find((e) => e.type === 'tool_use').id, name: 'LS', input: { path: '/sdcard' } });
		handle.send('plan');
		const pl = await turn(it);
		const todo = pl.find((e) => e.type === 'tool_use');
		assert.deepEqual({ name: todo.name, todos: todo.input.todos.map((x) => [x.content, x.status]) }, { name: 'TodoWrite', todos: [['look', 'completed'], ['fix', 'in_progress']] });
		handle.send('hang');
		for (;;) { const { value } = await it.next(); if (value.type === 'text_delta' && value.text === ' on it') break; }
		handle.control.interrupt();
		const stopped = await turn(it);
		assert.deepEqual({ ok: stopped.at(-1).ok, subtype: stopped.at(-1).subtype }, { ok: false, subtype: 'interrupted' });
		handle.send('still there?');
		assert.equal((await turn(it)).at(-1).ok, true);
		handle.send('fail: RESOURCE_EXHAUSTED (code 429): Individual quota reached.');
		assert.equal((await turn(it)).at(-1).code, 'quota');
		handle.close();
	} finally { t.done(); }
});

test('resuming a session after a restart, not signed in, Full access, no CLI', async () => {
	const t = setup();
	try {
		signIn(t);
		const a = conversation(t, { mode: 'acceptEdits', model: 'agy:gemini-3.8-flash', effort: 'high' }, { open: { conversation: 'sess-old' } });
		a.handle.send('back again');
		const r = await turn(a.it);
		assert.equal(r[0].fresh, false);
		assert.ok(t.runs().some((x) => x.resumed === 'sess-old'));
		assert.equal(t.runs().find((x) => x.prompt).prompt, 'back again', 'a resumed session gets no lead-in');
		a.handle.close();

		const full = conversation(t, { mode: 'bypassPermissions', model: 'agy:', effort: 'high' });
		full.handle.send('shell: echo free');
		const f = await turn(full.it);
		assert.equal(full.cards.length, 0, 'Full access: agy is told not to ask');
		assert.equal(f.find((e) => e.type === 'tool_result').text, 'free');
		full.handle.close();

		rmSync(t.agy.paths.TOKEN_FILE);
		const out = conversation(t, { mode: 'auto', model: 'agy:', effort: 'high' });
		out.handle.send('hi');
		const o = (await turn(out.it)).at(-1);
		assert.deepEqual({ ok: o.ok, code: o.code }, { ok: false, code: 'auth' });
		out.handle.close();

		process.env.AGENT_AGY_BIN = join(t.home, 'not-there');
		const savedPath = process.env.PATH;
		process.env.PATH = t.home;
		try {
			const none = conversation(t, { mode: 'auto', model: 'agy:' });
			none.handle.send('hi');
			assert.equal((await turn(none.it)).at(-1).code, 'missing');
			none.handle.close();
		} finally { process.env.PATH = savedPath; }
	} finally { t.done(); }
});

test("before a turn: the app's connectors and skills are in agy's files; nothing of ours is left from before", async () => {
	const t = setup();
	try {
		const skills = join(t.home, '.claude', 'skills');
		mkdirSync(join(skills, 'phone-health'), { recursive: true });
		writeFileSync(join(skills, 'phone-health', 'SKILL.md'), '---\nname: phone-health\ndescription: x\n---\n');
		mkdirSync(join(t.agy.paths.SKILLS_DIR, 'their-own'), { recursive: true });
		mkdirSync(dirname(t.agy.paths.MCP_CONFIG), { recursive: true });
		// What 1.8.0 left: its tool server and its approval rules.
		writeFileSync(t.agy.paths.MCP_CONFIG, JSON.stringify({ mcpServers: { theirs: { command: 'x' }, droidagent: { command: 'node' } } }));
		mkdirSync(dirname(t.agy.paths.SETTINGS_FILE), { recursive: true });
		writeFileSync(t.agy.paths.SETTINGS_FILE, JSON.stringify({ permissions: { allow: ['command(git)', 'mcp(droidagent/*)', 'mcp(*)'] } }));
		mkdirSync(join(t.home, '.droidagent'), { recursive: true });
		writeFileSync(join(t.home, '.droidagent', 'agy-managed.json'), JSON.stringify({ mcp: ['droidagent'], allow: ['mcp(droidagent/*)', 'mcp(*)'] }));
		const connectors = { playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp'], env: {} }, old: { type: 'sse', url: 'https://x/sse' } };
		await t.agy.prepare({ mode: 'acceptEdits', connectors, skillsDir: skills });
		assert.deepEqual(Object.keys(JSON.parse(readFileSync(t.agy.paths.MCP_CONFIG, 'utf8')).mcpServers), ['theirs', 'playwright']);
		assert.deepEqual(JSON.parse(readFileSync(t.agy.paths.SETTINGS_FILE, 'utf8')).permissions.allow, ['command(git)']);
		assert.ok(lstatSync(join(t.agy.paths.SKILLS_DIR, 'phone-health')).isSymbolicLink());
		assert.ok(lstatSync(join(t.agy.paths.SKILLS_DIR, 'their-own')).isDirectory());
		writeFileSync(t.agy.paths.SETTINGS_FILE, '{ not json');
		await t.agy.prepare({ mode: 'auto', connectors: {}, skillsDir: skills });
		assert.equal(readFileSync(t.agy.paths.SETTINGS_FILE, 'utf8'), '{ not json', "a file that isn't JSON is the owner's to fix");
	} finally { t.done(); }
});

// ---------------------------------------------------------------- signing in (agy_oauth.mjs)
test('the sign-in link: PKCE, the loopback address, the scopes, no openid', () => {
	const { verifier, challenge } = oauth.pkce();
	assert.ok(verifier.length >= 43);
	const u = new URL(oauth.authorizeUrl(challenge, 'st'));
	assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
	assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:51121/oauth-callback');
	assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
	assert.equal(u.searchParams.get('access_type'), 'offline');
	assert.ok(u.searchParams.get('client_id').endsWith('.apps.googleusercontent.com'));
	assert.ok(!u.searchParams.get('scope').split(' ').includes('openid'));
	assert.deepEqual(oauth.pastedCode('http://localhost:51121/oauth-callback?code=4%2Fabc123def&state=st'), { code: '4/abc123def', state: 'st' });
	assert.deepEqual(oauth.pastedCode('4/0AbCdEfGhIjK'), { code: '4/0AbCdEfGhIjK', state: null });
	assert.deepEqual(oauth.pastedCode('http://localhost:51121/oauth-callback?error=access_denied'), { error: 'access_denied' });
	assert.equal(oauth.pastedCode('hello'), null);
	const doc = JSON.parse(oauth.credentialDoc({ access_token: 'a', refresh_token: 'r', expiryMs: Date.UTC(2030, 0, 1) }));
	assert.equal(doc.auth_method, 'consumer');
	assert.deepEqual(Object.keys(doc.token), ['access_token', 'token_type', 'refresh_token', 'expiry']);
	assert.match(doc.token.expiry, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/);
});

// A stand-in for Google's token and userinfo endpoints.
async function fakeGoogle() {
	const { createServer } = await import('node:http');
	const seen = [];
	const srv = createServer((req, res) => {
		let body = '';
		req.on('data', (d) => { body += d; });
		req.on('end', () => {
			seen.push({ path: req.url, body: Object.fromEntries(new URLSearchParams(body)) });
			if (req.url === '/token') {
				const f = Object.fromEntries(new URLSearchParams(body));
				res.writeHead(f.code === 'good' ? 200 : 400, { 'content-type': 'application/json' });
				return res.end(JSON.stringify(f.code === 'good' ? { access_token: 'ya29.x', refresh_token: '1//r', expires_in: 3600, token_type: 'Bearer' } : { error: 'invalid_grant', error_description: 'Bad Request' }));
			}
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ email: 'owner@example.com' }));
		});
	});
	await new Promise((r) => srv.listen(0, '127.0.0.1', r));
	return { base: `http://127.0.0.1:${srv.address().port}`, seen, close: () => srv.close() };
}
async function withOAuth(fn) {
	const g = await fakeGoogle();
	const home = mkdtempSync(join(tmpdir(), 'agy-oauth-'));
	const port = 52000 + Math.floor(Math.random() * 2000);
	const saved = { AGY_OAUTH_TOKEN_URL: process.env.AGY_OAUTH_TOKEN_URL, AGY_OAUTH_USERINFO_URL: process.env.AGY_OAUTH_USERINFO_URL, AGY_OAUTH_PORT: process.env.AGY_OAUTH_PORT };
	Object.assign(process.env, { AGY_OAUTH_TOKEN_URL: `${g.base}/token`, AGY_OAUTH_USERINFO_URL: `${g.base}/userinfo`, AGY_OAUTH_PORT: String(port) });
	// The module reads these once: a fresh copy for each test.
	const m = await import(`../app/server/backends/agy_oauth.mjs?t=${Date.now()}${Math.random()}`);
	try { await fn({ m, g, home, port, file: join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token') }); } finally {
		for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
		g.close();
		rmSync(home, { recursive: true, force: true });
	}
}

test('signing in: the browser comes back to this phone, the code is exchanged, agy is signed in', async () => {
	await withOAuth(async ({ m, g, port, file }) => {
		let session;
		const done = new Promise((resolve) => { session = m.startSignIn({ tokenFile: file, onDone: (err, r) => resolve({ err, r }) }); });
		const state = new URL(session.url).searchParams.get('state');
		await new Promise((r) => setTimeout(r, 50));
		const page = await fetch(`http://127.0.0.1:${port}/oauth-callback?code=good&state=${state}`);
		assert.match(await page.text(), /授权成功/);
		const { err, r } = await done;
		assert.equal(err, null);
		assert.equal(r.email, 'owner@example.com');
		const tok = JSON.parse(readFileSync(file, 'utf8'));
		assert.deepEqual({ a: tok.token.access_token, r: tok.token.refresh_token, m: tok.auth_method }, { a: 'ya29.x', r: '1//r', m: 'consumer' });
		const sent = g.seen.find((x) => x.path === '/token').body;
		assert.equal(sent.grant_type, 'authorization_code');
		assert.equal(sent.redirect_uri, `http://localhost:${port}/oauth-callback`);
		assert.ok(sent.code_verifier && sent.client_secret && sent.client_id);
		// The listener is gone once it is done.
		await assert.rejects(fetch(`http://127.0.0.1:${port}/oauth-callback?code=x`));
	});
});

test('signing in by pasting the address; a code from another attempt, a bad code, cancelling', async () => {
	await withOAuth(async ({ m, port, file }) => {
		let s;
		let done = new Promise((resolve) => { s = m.startSignIn({ tokenFile: file, onDone: (err, r) => resolve({ err, r }), onStatus: () => {} }); });
		const state = new URL(s.url).searchParams.get('state');
		assert.equal(s.submit('not a code'), false);
		assert.equal(s.submit(`http://localhost:${port}/oauth-callback?code=good&state=someone-else`), true);
		assert.equal(s.submit(`http://localhost:${port}/oauth-callback?code=good&state=${state}`), true);
		assert.equal((await done).err, null);
		assert.ok(existsSync(file));

		done = new Promise((resolve) => { s = m.startSignIn({ tokenFile: join(file + '-2'), onDone: (err) => resolve(err) }); });
		s.submit('4/bad-code-0123');
		assert.match((await done).message, /授权码无效/);
		assert.ok(!existsSync(file + '-2'));

		let called = false;
		s = m.startSignIn({ tokenFile: file, onDone: () => { called = true; } });
		s.cancel();
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(called, false);
	});
});
