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
	agyPlatform, parseAgyModels, agyArgs, agyStdinLine, normalizeAgyTool, agyErrorText, createAgyMapper, parseAgyUsage, usageGroupFor,
	withPreamble, toAgyMcp, mergeAgyMcp, mergeAgyAllow, agyAllowRules, createAgyBackend,
} from '../app/server/backends/antigravity.mjs';
import { handle as bridgeHandle, TOOLS } from '../app/server/agy_bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, 'fake-agy.mjs');
const line = (o) => JSON.stringify(o);
const types = (evs) => evs.map((e) => e.type);

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
	assert.equal(getSdkModel('opus-4.8'), 'opus');
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

test('how a turn is started in each execution mode', () => {
	const base = { model: 'gemini-3.8-flash', prompt: 'hi' };
	assert.deepEqual(agyArgs({ ...base, mode: 'acceptEdits' }), ['--output-format', 'stream-json', '--mode', 'accept-edits', '--model', 'gemini-3.8-flash', '-p', 'hi']);
	assert.ok(agyArgs({ ...base, mode: 'plan' }).join(' ').includes('--mode plan'));
	assert.ok(agyArgs({ ...base, mode: 'default' }).join(' ').includes('--mode default'));
	// Only Full access lets agy's own tools run unasked; nothing else passes that flag.
	for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'nonsense', undefined]) assert.ok(!agyArgs({ ...base, mode }).includes('--dangerously-skip-permissions'), String(mode));
	assert.ok(agyArgs({ ...base, mode: 'bypassPermissions' }).includes('--dangerously-skip-permissions'));
	assert.ok(!agyArgs({ ...base, mode: 'bypassPermissions' }).includes('--mode'));
	const resumed = agyArgs({ mode: 'auto', model: '', conversation: 'c1', prompt: '-h' });
	assert.ok(!resumed.includes('--model'), 'no slug: agy picks its default');
	assert.deepEqual(resumed.slice(-4), ['--conversation', 'c1', '-p', '-h']);
	const long = agyArgs({ ...base, mode: 'auto', viaStdin: true });
	assert.ok(!long.includes('-p') && long.join(' ').endsWith('--input-format stream-json'));
	assert.deepEqual(JSON.parse(agyStdinLine('你好')), { event: 'user', message: { role: 'user', content: '你好' } });
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
	assert.deepEqual(normalizeAgyTool('call_mcp_tool', { ServerName: 'droidagent', ToolName: 'shell', Arguments: { command: 'id', description: '看看身份' } }), { name: 'Bash', input: { command: 'id', description: '看看身份' } });
	assert.deepEqual(normalizeAgyTool('call_mcp_tool', { ServerName: 'droidagent', ToolName: 'write_file', Arguments: { path: '/x', content: 'y' } }), { name: 'Write', input: { file_path: '/x' } });
	assert.equal(normalizeAgyTool('call_mcp_tool', { ServerName: 'droidagent', ToolName: 'remember', Arguments: { note: 'n' } }).name, 'mcp__droidagent__remember');
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

test('a headless agy turn, as recorded, becomes turn events', () => {
	const m = createAgyMapper('k');
	const su = (o) => line({ event: 'step_update', step_update: { conversation_id: 'c1', ...o } });
	assert.deepEqual(m.feed(line({ event: 'init', conversation_id: 'c1', init: { model: 'gemini-3-7-flash', cwd: '/tmp' } })), [{ type: 'init', ref: 'c1', model: 'gemini-3-7-flash' }]);
	assert.deepEqual(m.feed('⚠ fetching model catalog'), []);
	assert.deepEqual(m.feed('{broken json'), []);
	assert.deepEqual(m.feed(su({ step_index: 0, state: 'DONE', step_type: 'user_input' })), []);
	assert.deepEqual(m.feed(su({ step_index: 1, state: 'DONE', step_type: 'checkpoint' })), []);
	// A thinking-only step: nothing to show.
	assert.deepEqual(m.feed(su({ step_index: 2, state: 'DONE', step_type: 'agent_response', usage: { thinking_tokens: 80 } })), []);
	assert.deepEqual(m.feed(su({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Let me look. ' })), [{ type: 'text_delta', text: 'Let me look. ' }]);
	// A step starts while text is open: the text is a message of its own, then the step.
	const info = { name: 'run_command', parameters: { CommandLine: 'ls' } };
	assert.deepEqual(m.feed(su({ step_index: 4, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: info })),
		[{ type: 'text_end' }, { type: 'tool_use', id: 'agy-k-4', name: 'Bash', input: { command: 'ls', description: undefined } }]);
	assert.equal(m.state.activeTools, 1);
	assert.deepEqual(m.feed(su({ step_index: 4, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: info })), [], 'a repeated update is not a second card');
	assert.deepEqual(m.feed(su({ step_index: 4, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { ...info, output: 'a.txt\n' } })), [{ type: 'tool_result', id: 'agy-k-4', ok: true, text: 'a.txt\n' }]);
	assert.equal(m.state.activeTools, 0);
	// A step that only ever reports its end still gets its card and its result.
	assert.deepEqual(types(m.feed(su({ step_index: 5, state: 'ERROR', step_type: 'tool', tool_name: 'find_by_name', tool_info: { name: 'find_by_name', parameters: { Pattern: '*.txt' }, error: { type: 'TOOL_ERROR', message: 'Find command timed out.' } } }))), ['tool_use', 'tool_result']);
	assert.equal(m.state.denied, false);
	assert.deepEqual(m.feed(su({ step_index: 6, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'There are ' })), [{ type: 'text_delta', text: 'There are ' }]);
	assert.deepEqual(m.feed(su({ step_index: 6, state: 'DONE', step_type: 'agent_response', text_delta: '2 files.' })), [{ type: 'text_delta', text: '2 files.' }, { type: 'text_end' }]);
	const end = m.feed(line({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'There are 2 files.\n', duration_seconds: 5 } }));
	assert.deepEqual(types(end), ['result'], 'the answer was streamed: not shown again');
	assert.deepEqual({ ok: end[0].ok, subtype: end[0].subtype, durationMs: end[0].durationMs, text: end[0].text }, { ok: true, subtype: 'success', durationMs: 5000, text: 'There are 2 files.' });
	assert.equal(m.state.sawResult, true);
});

test('an answer that was never streamed, a failure, a refusal', () => {
	let m = createAgyMapper();
	assert.deepEqual(types(m.feed(line({ event: 'result', result: { conversation_id: 'c', status: 'DONE', response: 'only here' } }))), ['text', 'result']);
	m = createAgyMapper();
	const failed = m.feed(line({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: 'You are not logged into Antigravity.' } }));
	assert.equal(failed[0].ok, false);
	assert.equal(failed[0].code, 'auth');
	assert.equal(failed[0].subtype, 'error');
	assert.match(failed[0].errors[0], /重新登录/);
	m = createAgyMapper();
	m.feed(line({ event: 'step_update', step_update: { step_index: 1, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'rm x' }, error: { message: 'Permission denied automatically in headless mode' } } } }));
	assert.equal(m.state.denied, true);
	// Builds that send the whole text each time.
	m = createAgyMapper();
	assert.deepEqual(m.feed(line({ event: 'step_update', idx: 3, step_type: 'text', text: 'Hello' })), [{ type: 'text_delta', text: 'Hello' }]);
	assert.deepEqual(m.feed(line({ event: 'step_update', idx: 3, step_type: 'text', text: 'Hello there' })), [{ type: 'text_delta', text: ' there' }]);
	// What a slash command answered.
	assert.deepEqual(createAgyMapper().feed(line({ event: 'command_result', command: { name: 'skills', output: 'reloaded' } })), [{ type: 'command_output', text: '/skills\nreloaded' }]);
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

test("the first message carries the app's instructions; later ones are the owner's words alone", () => {
	assert.equal(withPreamble('', 'hi'), 'hi');
	const p = withPreamble('rules', 'hi');
	assert.ok(p.startsWith('rules') && p.endsWith('hi'));
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

test('the approvals a mode grants replace those of the mode before, never the owner\'s own', () => {
	assert.deepEqual(agyAllowRules('default'), ['mcp(droidagent/*)']);
	assert.deepEqual(agyAllowRules('plan'), ['mcp(droidagent/*)']);
	assert.deepEqual(agyAllowRules('acceptEdits'), ['mcp(droidagent/*)', 'mcp(*)']);
	const settings = { model: 'x', permissions: { allow: ['command(git)'], deny: ['command(rm)'] } };
	const a = mergeAgyAllow(settings, agyAllowRules('auto'), []);
	assert.deepEqual(a.settings.permissions, { allow: ['command(git)', 'mcp(droidagent/*)', 'mcp(*)'], deny: ['command(rm)'] });
	assert.equal(a.settings.model, 'x');
	const b = mergeAgyAllow(a.settings, agyAllowRules('default'), a.managed);
	assert.deepEqual(b.settings.permissions.allow, ['command(git)', 'mcp(droidagent/*)']);
	assert.deepEqual(b.managed, ['mcp(droidagent/*)']);
	// A rule the owner wrote themselves is theirs even when it equals one of ours.
	const c = mergeAgyAllow({ permissions: { allow: ['mcp(*)'] } }, agyAllowRules('default'), []);
	assert.deepEqual(c.settings.permissions.allow, ['mcp(*)', 'mcp(droidagent/*)']);
	assert.deepEqual(mergeAgyAllow(c.settings, [], c.managed).settings.permissions.allow, ['mcp(*)']);
});

// ---------------------------------------------------------------- the bridge (MCP over stdio)
test('our MCP server answers the handshake and hands calls on', async () => {
	const init = await bridgeHandle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
	assert.equal(init.result.protocolVersion, '2025-03-26');
	assert.equal(await bridgeHandle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
	const list = await bridgeHandle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
	assert.deepEqual(list.result.tools.map((t) => t.name), ['shell', 'write_file', 'remember']);
	assert.equal(TOOLS.every((t) => t.inputSchema.type === 'object' && t.description), true);
	const calls = [];
	const call = async (tool, args) => { calls.push([tool, args]); return tool === 'shell' ? { ok: true, text: 'out' } : { ok: false, text: '用户拒绝了这个操作' }; };
	assert.deepEqual((await bridgeHandle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'shell', arguments: { command: 'id' } } }, call)).result, { content: [{ type: 'text', text: 'out' }], isError: false });
	assert.deepEqual((await bridgeHandle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'write_file', arguments: {} } }, call)).result, { content: [{ type: 'text', text: '用户拒绝了这个操作' }], isError: true });
	assert.deepEqual(calls, [['shell', { command: 'id' }], ['write_file', {}]]);
	assert.equal((await bridgeHandle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'rm_rf' } }, call)).error.code, -32602);
	assert.equal((await bridgeHandle({ jsonrpc: '2.0', id: 6, method: 'nope' })).error.code, -32601);
	assert.equal(calls.length, 2, 'an unknown tool never reaches the server');
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
	const done = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } rmSync(home, { recursive: true, force: true }); };
	return { home, agy, runs, logs, done };
}
// The events of one turn: everything up to and including its result.
async function turn(it) {
	const got = [];
	for (;;) {
		const { value, done } = await it.next();
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
		assert.deepEqual((await t.agy.models()).models.map((m) => m.slug), ['gemini-4-carbon-high', 'gemini-3.8-flash', 'claude-sonnet-5-5']);
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

test('two turns of one conversation: the lead-in once, the thread carried by its id', async () => {
	const t = setup();
	try {
		const settings = { mode: 'acceptEdits', model: 'agy:gemini-3.8-flash' };
		const h = t.agy.open({ tag: 't', cwd: t.home, settings, preamble: () => 'APP RULES', turnEnv: () => ({ DROIDAGENT_SESSION: 'sess-1' }) });
		const it = h.events[Symbol.asyncIterator]();
		h.send('hello');
		const first = await turn(it);
		assert.deepEqual(types(first), ['init', 'text_delta', 'text_delta', 'text_end', 'result']);
		assert.equal(first[0].model, 'gemini-3.8-flash');
		assert.equal(first.filter((e) => e.type === 'text_delta').map((e) => e.text).join(''), 'echo(gemini-3.8-flash): hello');
		assert.equal(first.at(-1).ok, true);
		// The model and the mode are whatever they are when the next message goes out.
		settings.model = 'agy:claude-sonnet-5-5';
		settings.mode = 'bypassPermissions';
		h.send('again');
		const second = await turn(it);
		assert.deepEqual(types(second), ['text_delta', 'text_delta', 'text_end', 'result'], 'the same conversation does not announce itself again');
		const [r1, r2] = t.runs();
		assert.match(r1.prompt, /^APP RULES\n\n---\n\n【用户的消息】\nhello$/);
		assert.equal(r2.prompt, 'again');
		assert.ok(!r1.argv.includes('--conversation'));
		assert.equal(r2.argv[r2.argv.indexOf('--conversation') + 1], first[0].ref);
		assert.ok(r1.argv.join(' ').includes('--mode accept-edits --model gemini-3.8-flash'));
		assert.ok(r2.argv.includes('--dangerously-skip-permissions') && r2.argv.includes('claude-sonnet-5-5'));
		assert.equal(r1.cwd, t.home);
		assert.deepEqual(r1.env, { session: 'sess-1', dbus: `unix:path=${join(t.home, '.gemini', '.no-session-bus')}`, noUpdate: 'true' });
		h.close();
		assert.equal((await it.next()).done, true);
	} finally { t.done(); }
});

test('a resumed conversation, a very long message, an error, a stop', async () => {
	const t = setup();
	try {
		const settings = { mode: 'default', model: 'agy:' };
		const h = t.agy.open({ tag: 't', cwd: t.home, settings, conversation: 'conv-old', preamble: () => 'APP RULES' });
		const it = h.events[Symbol.asyncIterator]();
		const big = 'x'.repeat(150000);
		h.send(big);
		const long = await turn(it);
		assert.equal(long.at(-1).ok, true);
		assert.deepEqual(types(long).slice(0, 1), ['text_delta'], 'its id is already known: nothing new to announce');
		const run = t.runs()[0];
		assert.ok(run.argv.includes('--input-format') && !run.argv.includes('-p') && !run.argv.includes('--model'));
		assert.equal(run.prompt, big, 'resumed: no lead-in');

		h.send('fail: RESOURCE_EXHAUSTED (code 429): Individual quota reached.');
		const failed = (await turn(it)).at(-1);
		assert.deepEqual({ ok: failed.ok, subtype: failed.subtype, code: failed.code }, { ok: false, subtype: 'error', code: 'quota' });

		h.send('native: rm -rf /sdcard/x');
		const refused = await turn(it);
		assert.deepEqual(types(refused), ['tool_use', 'tool_result', 'notice', 'result']);
		assert.equal(refused[1].ok, false);
		assert.match(refused[2].text, /Full access/);

		h.send('hang');
		const partial = [];
		for (;;) { const { value } = await it.next(); partial.push(value); if (value.type === 'text_delta' && value.text === ' on it') break; }
		h.control.interrupt();
		const stopped = await turn(it);
		assert.deepEqual({ ok: stopped.at(-1).ok, subtype: stopped.at(-1).subtype }, { ok: false, subtype: 'interrupted' });
		// And it still answers afterwards.
		h.send('still there?');
		assert.equal((await turn(it)).at(-1).ok, true);
		h.close();
	} finally { t.done(); }
});

test('not signed in reads as that, and a missing CLI as that', async () => {
	const t = setup();
	try {
		process.env.FAKE_AGY_LOGGED_OUT = '1';
		const h = t.agy.open({ tag: 't', cwd: t.home, settings: { mode: 'auto', model: 'agy:' } });
		const it = h.events[Symbol.asyncIterator]();
		h.send('hi');
		const r = (await turn(it)).at(-1);
		assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: 'auth' });
		assert.match((await t.agy.models()).error, /登录/);
		process.env.AGENT_AGY_BIN = join(t.home, 'not-there');
		const savedPath = process.env.PATH;
		process.env.PATH = t.home;
		try {
			h.send('hi');
			const missing = (await turn(it)).at(-1);
			assert.equal(missing.code, 'missing');
			assert.equal(t.agy.find(), null);
		} finally { process.env.PATH = savedPath; }
		h.close();
	} finally { delete process.env.FAKE_AGY_LOGGED_OUT; t.done(); }
});

test("before a turn: our tools, the app's connectors, this mode's approvals and the app's skills are in agy's files", async () => {
	const t = setup();
	try {
		const skills = join(t.home, '.claude', 'skills');
		mkdirSync(join(skills, 'phone-health'), { recursive: true });
		writeFileSync(join(skills, 'phone-health', 'SKILL.md'), '---\nname: phone-health\ndescription: x\n---\n');
		mkdirSync(join(skills, 'not-a-skill'), { recursive: true });
		mkdirSync(join(t.agy.paths.SKILLS_DIR, 'their-own'), { recursive: true });
		mkdirSync(dirname(t.agy.paths.MCP_CONFIG), { recursive: true });
		writeFileSync(t.agy.paths.MCP_CONFIG, JSON.stringify({ mcpServers: { theirs: { command: 'x' } } }));
		const connectors = { playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp'], env: {} }, old: { type: 'sse', url: 'https://x/sse' } };
		const bridge = { url: 'http://127.0.0.1:8787', token: 'tok' };
		await t.agy.prepare({ mode: 'acceptEdits', connectors, skillsDir: skills, bridge });
		const mcp = JSON.parse(readFileSync(t.agy.paths.MCP_CONFIG, 'utf8')).mcpServers;
		assert.deepEqual(Object.keys(mcp), ['theirs', 'droidagent', 'playwright']);
		assert.equal(mcp.droidagent.command, process.execPath);
		assert.ok(mcp.droidagent.args[0].endsWith('agy_bridge.mjs') && existsSync(mcp.droidagent.args[0]));
		assert.deepEqual(mcp.droidagent.env, { DROIDAGENT_BRIDGE_URL: 'http://127.0.0.1:8787', DROIDAGENT_BRIDGE_TOKEN: 'tok' });
		assert.deepEqual(JSON.parse(readFileSync(t.agy.paths.SETTINGS_FILE, 'utf8')).permissions.allow, ['mcp(droidagent/*)', 'mcp(*)']);
		assert.ok(lstatSync(join(t.agy.paths.SKILLS_DIR, 'phone-health')).isSymbolicLink());
		assert.ok(!existsSync(join(t.agy.paths.SKILLS_DIR, 'not-a-skill')));

		// A connector switched off, a skill switched off, a stricter mode: ours follow, theirs stay.
		rmSync(join(skills, 'phone-health'), { recursive: true });
		await t.agy.prepare({ mode: 'default', connectors: {}, skillsDir: skills, bridge });
		assert.deepEqual(Object.keys(JSON.parse(readFileSync(t.agy.paths.MCP_CONFIG, 'utf8')).mcpServers), ['theirs', 'droidagent']);
		assert.deepEqual(JSON.parse(readFileSync(t.agy.paths.SETTINGS_FILE, 'utf8')).permissions.allow, ['mcp(droidagent/*)']);
		assert.ok(!existsSync(join(t.agy.paths.SKILLS_DIR, 'phone-health')));
		assert.ok(lstatSync(join(t.agy.paths.SKILLS_DIR, 'their-own')).isDirectory());
		// Full access needs no approvals of ours at all.
		await t.agy.prepare({ mode: 'bypassPermissions', connectors: {}, skillsDir: skills, bridge });
		assert.deepEqual(JSON.parse(readFileSync(t.agy.paths.SETTINGS_FILE, 'utf8')).permissions.allow, []);
		// A settings file that is not JSON is the owner's to fix: never overwritten.
		writeFileSync(t.agy.paths.SETTINGS_FILE, '{ not json');
		await t.agy.prepare({ mode: 'auto', connectors: {}, skillsDir: skills, bridge });
		assert.equal(readFileSync(t.agy.paths.SETTINGS_FILE, 'utf8'), '{ not json');
	} finally { t.done(); }
});

// ---------------------------------------------------------------- signing in (agy_login_pty.py, driving the fake CLI under a pty)
// Runs the script as the server does and plays the owner: `answer(link)` gives what they paste.
function login(home, { answer, env = {} } = {}) {
	return new Promise((resolve) => {
		const child = spawn('python3', [join(HERE, '..', 'app', 'server', 'agy_login_pty.py')], {
			env: { ...process.env, HOME: home, AGY_BIN: FAKE, AGY_TOKEN_FILE: join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), AGY_ENV: '{}', LOGIN_URL_TIMEOUT: '20', LOGIN_EXCHANGE_TIMEOUT: '20', ...env },
			stdio: ['pipe', 'pipe', 'inherit'],
		});
		const lines = [];
		let buf = '';
		child.stdout.on('data', (d) => {
			buf += d;
			let i;
			while ((i = buf.indexOf('\n')) >= 0) {
				const l = buf.slice(0, i); buf = buf.slice(i + 1);
				lines.push(l);
				if (l === 'NEED_CODE' && answer) { const a = answer(lines.find((x) => x.startsWith('URL ')).slice(4)); if (a != null) child.stdin.write(a + '\n'); }
			}
		});
		child.on('close', () => resolve(lines));
	});
}
const tokenOf = (home) => { try { return JSON.parse(readFileSync(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'utf8')).token; } catch { return null; } };

test('signing in: the link is handed out whole, the pasted code typed in, the login it leaves checked', async () => {
	const home = mkdtempSync(join(tmpdir(), 'agy-login-'));
	try {
		const lines = await login(home, { answer: () => '4/good-code' });
		assert.equal(lines[0], 'MODE manual');
		assert.equal(lines[1], 'URL https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=https%3A%2F%2Fantigravity.google%2Fcode&state=st1&scope=a%20b');
		assert.equal(lines[2], 'NEED_CODE');
		assert.equal(lines.at(-1), 'DONE ok');
		assert.equal(tokenOf(home).refresh_token, 'new-r');
		const log = readFileSync(join(home, '.claude', 'agent-agy-login.log'), 'utf8');
		assert.ok(log.includes('Sign in with Google') && !log.includes('good-code') && !log.includes('st1'), 'the transcript is kept, without the code or the state');
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test('signing in again with a wrong code keeps the login that was there', async () => {
	const home = mkdtempSync(join(tmpdir(), 'agy-login-'));
	try {
		mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
		writeFileSync(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), JSON.stringify({ token: { refresh_token: 'old-r' } }));
		const lines = await login(home, { answer: () => 'https://antigravity.google/code?code=4%2Fwrong&state=st1' });
		assert.match(lines.at(-1), /^DONE fail .*invalid authorization code/);
		assert.equal(tokenOf(home).refresh_token, 'old-r');
		assert.ok(!existsSync(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token.before-login')));
		// And a good one replaces it.
		const again = await login(home, { answer: () => 'https://antigravity.google/code?code=4%2Fgood-code&state=st1' });
		assert.equal(again.at(-1), 'DONE ok');
		assert.equal(tokenOf(home).refresh_token, 'new-r');
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test('signing in on a build without `acp --login`, and through a link that comes back to this phone', async () => {
	const home = mkdtempSync(join(tmpdir(), 'agy-login-'));
	try {
		const old = await login(home, { answer: () => '4/good-code', env: { FAKE_AGY_LOGIN: 'old' } });
		assert.equal(old.at(-1), 'DONE ok', old.join(' | '));
		rmSync(join(home, '.gemini'), { recursive: true });
		// The browser cannot reach the listener: the pasted address is forwarded to it.
		const back = await login(home, { answer: (url) => `${new URL(url).searchParams.get('redirect_uri')}?code=good-code&state=st1`, env: { FAKE_AGY_LOGIN: 'callback' } });
		assert.equal(back[0], 'MODE auto');
		assert.equal(back.at(-1), 'DONE ok', back.join(' | '));
		rmSync(join(home, '.gemini'), { recursive: true });
		// The browser gets there by itself: nothing is pasted at all.
		const auto = await login(home, { answer: (url) => { fetch(`${new URL(url).searchParams.get('redirect_uri')}?code=good-code&state=st1`).catch(() => {}); return null; }, env: { FAKE_AGY_LOGIN: 'callback' } });
		assert.equal(auto.at(-1), 'DONE ok', auto.join(' | '));
		assert.equal(tokenOf(home).refresh_token, 'new-r');
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test('a CLI that is not there says so', async () => {
	const home = mkdtempSync(join(tmpdir(), 'agy-login-'));
	try { assert.match((await login(home, { env: { AGY_BIN: join(home, 'nope') } })).at(-1), /^DONE fail 找不到 Antigravity CLI/); } finally { rmSync(home, { recursive: true, force: true }); }
});
