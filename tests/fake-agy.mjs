#!/usr/bin/env node
// Stands in for the Antigravity CLI in tests: `--version`, `models`, `plugin list|install`,
// `-p /usage`, `-p … --output-format json` (one-off questions), and `acp`, an Agent Client
// Protocol server (JSON-RPC 2.0, one message per line) as the app drives conversations.
//
// In `acp`, what a prompt does is decided by its last line:
//   "shell: <cmd>"         a command step: asks permission, then runs it here and reports the output
//   "write: <path>=<text>" a file write: asks permission, then writes it
//   "think: <topic>"       a thought, a read step, another thought, then the answer
//   "plan"                 a plan update
//   "fail: <message>"      the prompt request fails with that message
//   "hang"                 starts answering, then waits to be cancelled
//   anything else          echoed back in two chunks: "echo(<model>/<level>): <text>"
// Signed out (no token file, or FAKE_AGY_LOGGED_OUT): session requests fail with -32000.
// FAKE_AGY_LOG: one JSON line per prompt (and per one-off run) for the tests to read.
import { exec } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const note = (o) => { if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(o) + '\n'); };
const signedIn = () => !process.env.FAKE_AGY_LOGGED_OUT && existsSync(join(process.env.HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'));

if (argv[0] === '--version') { console.log('agy version 1.5.9-fake'); process.exit(0); }
if (argv[0] === 'models') {
	if (!signedIn()) { console.error('Error: Please sign in'); process.exit(1); }
	process.stdout.write('gemini-4-carbon-high\tGemini 4 Carbon (High)\ngemini-4-carbon-low\tGemini 4 Carbon (Low)\ngemini-3.8-flash      Gemini 3.8 Flash\nclaude-sonnet-5-5     Claude Sonnet 5.5 (Thinking)\n');
	process.exit(0);
}
if (argv[0] === 'plugin' && argv[1] === 'list') { console.log(JSON.stringify([{ name: 'demo-plugin', version: '1.0.0', description: 'a plugin' }])); process.exit(0); }
if (argv[0] === 'plugin' && argv[1] === 'install') { console.log(`installed ${argv[2]}`); process.exit(argv[2] === 'broken' ? 1 : 0); }
if (argv.includes('-p')) {
	const prompt = flag('-p');
	note({ oneShot: true, argv, prompt });
	if (prompt === '/usage') {
		console.log(JSON.stringify({ event: 'command_result', command: { name: 'usage', data: { groups: [
			{ name: 'Gemini', description: 'Gemini quota bucket', buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: 0.75, reset_time: '2030-01-01T00:00:00Z' }, { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.4 }] },
			{ name: 'Claude and GPT', buckets: [{ id: '3p-5h', window: '5h', remaining_fraction: 0.1 }] },
		] } } }));
		process.exit(0);
	}
	console.log(JSON.stringify({ conversation_id: 'one-shot', status: 'SUCCESS', response: String(prompt).includes('起一个标题') ? '「查看电池状态」\n' : `echo: ${prompt}` }));
	process.exit(0);
}
if (argv[0] !== 'acp') { console.error(`fake agy: no such command ${argv.join(' ')}`); process.exit(2); }

// ---------------------------------------------------------------- acp
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let nextId = 1000;
const waiting = new Map(); // our requests to the client: id -> resolve
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });
const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
const skip = argv.includes('--dangerously-skip-permissions');
const MODELS = ['gemini-4-carbon-high', 'gemini-4-carbon-low', 'gemini-3.8-flash', 'claude-sonnet-5-5'];
const LEVELS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['extra', 'Extra'], ['max', 'Max']];
const sessions = new Map(); // id -> { model, level, cancelled, running }
let seq = 0;
const options = (s) => [
	{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: s.model, options: [{ group: 'gemini', name: 'Gemini', options: MODELS.slice(0, 3).map((m) => ({ value: m, name: m })) }, { group: 'third', name: 'Other', options: [{ value: MODELS[3], name: 'Claude Sonnet 5.5 (Thinking)' }] }] },
	{ id: 'thinking', name: 'Thinking level', category: 'thought_level', type: 'select', currentValue: s.level, options: LEVELS.map(([value, name]) => ({ value, name })) },
];
const noAuth = { code: -32000, message: 'Authentication required' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = async (sid, parts, messageId = `m${seq++}`) => { for (const t of parts) { update(sid, { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: t } }); await sleep(3); } };

async function permission(sid, toolCall) {
	if (skip) return true;
	const r = await ask('session/request_permission', { sessionId: sid, toolCall, options: [
		{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'always', name: 'Always allow', kind: 'allow_always' }, { optionId: 'no', name: 'Deny', kind: 'reject_once' },
	] });
	return r?.outcome?.outcome === 'selected' && (r.outcome.optionId === 'yes' || r.outcome.optionId === 'always');
}

async function prompt(id, p) {
	const s = sessions.get(p.sessionId);
	if (!s) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'no such session' } });
	if (!signedIn()) return send({ jsonrpc: '2.0', id, error: noAuth });
	const text = (p.prompt || []).map((b) => b.text || '').join('');
	const last = text.trim().split('\n').pop().trim();
	note({ acp: true, sessionId: p.sessionId, prompt: text, model: s.model, level: s.level, argv, cwd: process.cwd() });
	s.cancelled = false;
	const done = (stopReason) => send({ jsonrpc: '2.0', id, result: { stopReason: s.cancelled ? 'cancelled' : stopReason } });
	const sid = p.sessionId;
	if (last.startsWith('fail: ')) return send({ jsonrpc: '2.0', id, error: { code: -32603, message: last.slice(6) } });
	if (last === 'hang') {
		await say(sid, ['working', ' on it']);
		if (s.cancelled) return done('cancelled'); // cancelled while it was still writing
		s.onCancel = () => done('cancelled');
		return;
	}
	if (last === 'plan') {
		update(sid, { sessionUpdate: 'plan', entries: [{ content: 'look', priority: 'high', status: 'completed' }, { content: 'fix', priority: 'medium', status: 'in_progress' }] });
		await say(sid, ['planned']);
		return done('end_turn');
	}
	if (last.startsWith('think: ')) {
		update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `first thought about ${last.slice(7)}` } });
		update(sid, { sessionUpdate: 'tool_call', toolCallId: `t${seq++}`, title: 'List /sdcard', kind: 'read', status: 'completed', locations: [{ path: '/sdcard' }], rawInput: { DirectoryPath: '/sdcard' }, name: 'list_dir', content: [{ type: 'content', content: { type: 'text', text: 'a\nb' } }] });
		update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'I should' } });
		update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: ' look at the files' } });
		await say(sid, ['two', ' files']);
		return done('end_turn');
	}
	if (last.startsWith('shell: ')) {
		const cmd = last.slice(7);
		const tc = { toolCallId: `t${seq++}`, title: `Run ${cmd}`, kind: 'execute', status: 'pending', rawInput: { CommandLine: cmd }, name: 'run_command' };
		await say(sid, ['Let me run that.']);
		update(sid, { sessionUpdate: 'tool_call', ...tc });
		if (!(await permission(sid, tc)) || s.cancelled) {
			update(sid, { sessionUpdate: 'tool_call_update', toolCallId: tc.toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'denied by the user' } }] });
			await say(sid, ['Not allowed.']);
			return done('end_turn');
		}
		update(sid, { sessionUpdate: 'tool_call_update', toolCallId: tc.toolCallId, status: 'in_progress' });
		const out = await new Promise((resolve) => {
			const c = exec(cmd, { cwd: process.cwd(), shell: '/bin/bash' }, (err, so, se) => resolve({ ok: !err, text: `${so}${se}`.replace(/\s+$/, '') }));
			s.onCancel = () => { c.kill('SIGKILL'); };
		});
		s.onCancel = null;
		if (s.cancelled) return done('cancelled');
		update(sid, { sessionUpdate: 'tool_call_update', toolCallId: tc.toolCallId, status: out.ok ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: out.text } }] });
		await say(sid, ['It said: ', out.text]);
		return done('end_turn');
	}
	if (last.startsWith('write: ')) {
		const [path, ...rest] = last.slice(7).split('=');
		const tc = { toolCallId: `t${seq++}`, title: `Write ${path}`, kind: 'edit', status: 'pending', locations: [{ path }], rawInput: { TargetFile: path, CodeContent: rest.join('=') }, name: 'write_to_file' };
		update(sid, { sessionUpdate: 'tool_call', ...tc });
		if (!(await permission(sid, tc))) {
			update(sid, { sessionUpdate: 'tool_call_update', toolCallId: tc.toolCallId, status: 'failed' });
			return done('end_turn');
		}
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, rest.join('='));
		update(sid, { sessionUpdate: 'tool_call_update', toolCallId: tc.toolCallId, status: 'completed', content: [{ type: 'diff', path, newText: rest.join('=') }] });
		await say(sid, ['written']);
		return done('end_turn');
	}
	await say(sid, [`echo(${s.model}/${s.level}): `, last]);
	done('end_turn');
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
	let m;
	try { m = JSON.parse(line); } catch { return; }
	if (m.id != null && waiting.has(m.id) && !m.method) { const r = waiting.get(m.id); waiting.delete(m.id); r(m.result); return; }
	const p = m.params || {};
	const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
	switch (m.method) {
		case 'initialize':
			return ok({ protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server (fake)' }, agentCapabilities: { loadSession: true, promptCapabilities: {}, mcpCapabilities: { http: false }, sessionCapabilities: { resume: {} } },
				authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }] });
		case 'session/new': {
			if (!signedIn()) return send({ jsonrpc: '2.0', id: m.id, error: noAuth });
			const sessionId = `sess-${process.pid}-${seq++}`;
			const s = { model: 'gemini-3.8-flash', level: 'high' };
			sessions.set(sessionId, s);
			note({ acp: true, newSession: sessionId, cwd: p.cwd, argv });
			ok({ sessionId, configOptions: options(s) });
			setTimeout(() => update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compress', description: 'Shorten the conversation' }, { name: 'plan', description: 'Plan first', input: { hint: 'task' } }] }), 5);
			return;
		}
		case 'session/resume': {
			if (!signedIn()) return send({ jsonrpc: '2.0', id: m.id, error: noAuth });
			const s = { model: 'gemini-3.8-flash', level: 'high' };
			sessions.set(p.sessionId, s);
			note({ acp: true, resumed: p.sessionId, argv });
			return ok({ configOptions: options(s) });
		}
		case 'session/set_config_option': {
			const s = sessions.get(p.sessionId);
			if (!s) return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'no such session' } });
			if (p.configId === 'model') s.model = p.value;
			if (p.configId === 'thinking') s.level = p.value;
			return ok({ configOptions: options(s) });
		}
		case 'session/prompt': return void prompt(m.id, p).catch((e) => send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: String(e) } }));
		case 'session/cancel': {
			const s = sessions.get(p.sessionId);
			if (s) { s.cancelled = true; const f = s.onCancel; s.onCancel = null; f?.(); }
			return;
		}
		default:
			if (m.id != null) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `no method ${m.method}` } });
	}
});
rl.on('close', () => process.exit(0));
