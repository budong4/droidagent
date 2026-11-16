// Run: node --test tests/server-claude.test.mjs
// The real server on its Claude side, with a stand-in for the Agent SDK and for the `claude`
// program: that a Claude conversation still runs as it did before the two agents were split
// apart (streaming, tool cards, confirmation cards, resuming, settings pushed to a live
// process), and what happens to a conversation when the model moves to the other agent.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync, cpSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'droidagent-claude-'));
const work = join(home, 'work');
const sdkLog = join(home, 'sdk.jsonl');
let server, port, base;
const events = [];
const waiters = new Set();

// What the SDK's query() does, as far as the server can tell: an init, then for each message a
// streamed reply; "tool: <cmd>" asks canUseTool first and reports a Bash step.
const FAKE_SDK = `
import { appendFileSync } from 'node:fs';
const note = (o) => appendFileSync(process.env.FAKE_SDK_LOG, JSON.stringify(o) + '\\n');
export function query({ prompt, options }) {
	const session = options.resume || 'claude-session-1';
	note({ start: { model: options.model, effort: options.effort, permissionMode: options.permissionMode, resume: options.resume || null, cwd: options.cwd,
		append: options.systemPrompt?.append || '', mcp: Object.keys(options.mcpServers || {}), exe: options.pathToClaudeCodeExecutable, thinking: options.thinking } });
	const delta = (d) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: d } });
	async function* run() {
		yield { type: 'system', subtype: 'init', session_id: session, model: 'claude-' + options.model };
		let n = 0;
		for await (const m of prompt) {
			const text = m.message.content;
			n++;
			if (text.startsWith('tool: ')) {
				const input = { command: text.slice(6), description: '运行测试命令' };
				const id = 'toolu_' + n;
				yield { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input }] } };
				const d = await options.canUseTool('Bash', input);
				yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: d.behavior !== 'allow', content: d.behavior === 'allow' ? 'ran: ' + input.command : d.message }] } };
			}
			yield { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } };
			yield delta({ type: 'thinking_delta', thinking: 'thinking about it' });
			yield { type: 'stream_event', event: { type: 'content_block_stop' } };
			yield delta({ type: 'text_delta', text: 'claude says: ' });
			yield delta({ type: 'text_delta', text });
			yield { type: 'stream_event', event: { type: 'message_stop' } };
			yield { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'thinking about it' }, { type: 'text', text: 'claude says: ' + text }] } };
			yield { type: 'result', is_error: false, result: 'claude says: ' + text, total_cost_usd: 0.002, duration_ms: 5, subtype: 'success' };
		}
	}
	const it = run();
	return Object.assign(it, {
		interrupt: async () => note({ interrupt: session }),
		setModel: async (model) => note({ setModel: model }),
		setPermissionMode: async (mode) => note({ setPermissionMode: mode }),
		supportedCommands: async () => [{ name: 'compact', description: 'compact', argumentHint: '' }],
	});
}
`;
const FAKE_CLAUDE = `#!/bin/sh
case "$1" in
	--version) echo "2.1.999 (Claude Code)" ;;
	auth) [ "$2" = status ] && echo '{"loggedIn":true,"email":"owner@example.com","authMethod":"claude.ai","subscriptionType":"max"}' ;;
esac
`;

const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const api = async (path, body) => (await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
function waitFor(match, { from = 0, timeout = 20000 } = {}) {
	return new Promise((resolve, reject) => {
		const check = () => {
			const i = events.findIndex((e, n) => n >= from && match(e));
			if (i < 0) return false;
			clearTimeout(timer); waiters.delete(check); resolve(events[i]);
			return true;
		};
		const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`no such event within ${timeout} ms; saw: ${events.slice(from).map((e) => e.type).join(', ')}\n${server.log()}`)); }, timeout);
		if (!check()) waiters.add(check);
	});
}
async function say(sessionId, text) {
	const from = events.length;
	assert.deepEqual(await api('/api/send', { text, sessionId }), { ok: true, queued: false });
	const result = await waitFor((e) => e.type === 'result' && e.sessionId === sessionId, { from });
	return { result, events: events.slice(from, events.indexOf(result) + 1).filter((e) => e.sessionId === sessionId) };
}
const newSession = async () => (await api('/api/new', {})).session.id;
const stored = (id) => JSON.parse(readFileSync(join(home, '.claude', 'agent-sessions', `${id}.json`), 'utf8'));
// Saves are queued behind the events that announce them: wait for the file to catch up.
async function storedWhen(id, ready) {
	for (let i = 0; i < 50; i++) { const s = stored(id); if (ready(s)) return s; await new Promise((r) => setTimeout(r, 50)); }
	return stored(id);
}
// The conversations the SDK was started for (naming one is a start too, with no instructions added).
const chatStarts = () => sdk().filter((l) => l.start?.append);
const sdk = () => (existsSync(sdkLog) ? readFileSync(sdkLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

before(async () => {
	// A copy of the server with the stand-in SDK beside it, as node_modules would hold the real one.
	const app = join(home, 'app');
	cpSync(join(HERE, '..', 'app', 'server'), join(app, 'server'), { recursive: true, filter: (src) => !src.includes('node_modules') && !src.includes('legacy-sdk') });
	const pkg = join(app, 'server', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.0.0', type: 'module', main: 'index.mjs', exports: './index.mjs' }));
	writeFileSync(join(pkg, 'index.mjs'), FAKE_SDK);
	const bin = join(home, 'bin');
	mkdirSync(bin, { recursive: true });
	mkdirSync(work, { recursive: true });
	symlinkSync(process.execPath, join(bin, 'node'));
	writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
	chmodSync(join(bin, 'claude'), 0o755);
	// The transcript Claude Code would have written, so a resumed conversation is found.
	mkdirSync(join(home, '.claude', 'projects', 'p'), { recursive: true });
	writeFileSync(join(home, '.claude', 'projects', 'p', 'claude-session-1.jsonl'), '');
	port = await freePort();
	base = `http://127.0.0.1:${port}`;
	server = spawn(process.execPath, [join(app, 'server', 'server.mjs')], {
		env: {
			HOME: home, PATH: `${bin}:/usr/bin:/bin`, AGENT_PORT: String(port), AGENT_CWD: work, AGENT_PROXY_FILE: join(home, 'proxy.env'),
			DROIDAGENT_NO_UPDATE: '1', AGENT_AGY_BIN: join(HERE, 'fake-agy.mjs'), FAKE_SDK_LOG: sdkLog, AGENT_BG_DIR: join(home, 'bg'),
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let log = '';
	server.stdout.on('data', (d) => { log += d; });
	server.stderr.on('data', (d) => { log += d; });
	server.log = () => log;
	for (let i = 0; i < 100; i++) {
		try { await fetch(base + '/api/update'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
		if (i === 99) throw new Error('server did not start:\n' + log);
	}
	const res = await fetch(base + '/api/events');
	(async () => {
		let buf = '';
		const dec = new TextDecoder();
		for await (const chunk of res.body) {
			buf += dec.decode(chunk, { stream: true });
			let i;
			while ((i = buf.indexOf('\n\n')) >= 0) {
				const block = buf.slice(0, i); buf = buf.slice(i + 2);
				if (!block.startsWith('data: ')) continue;
				events.push(JSON.parse(block.slice(6)));
				for (const w of [...waiters]) w();
			}
		}
	})().catch(() => {});
	await waitFor((e) => e.type === 'auth');
});
after(() => {
	server?.kill('SIGKILL');
	rmSync(home, { recursive: true, force: true });
});

test('signed in to Claude only', async () => {
	assert.deepEqual(events.find((e) => e.type === 'auth'), { type: 'auth', loggedIn: true, accounts: { claude: true, agy: false } });
	const rt = await api('/api/runtime');
	assert.equal(rt.ok, true);
	assert.match(rt.chat.version, /2\.1\.999/);
	assert.equal((await api('/api/account')).account.email, 'owner@example.com');
});

test('a Claude conversation: thinking, streamed reply, cost, kept on disk — each shown once', async () => {
	const id = await newSession();
	const t = await say(id, '你好');
	assert.deepEqual(t.events.map((e) => e.type).filter((x) => x !== 'title'),
		['user_echo', 'session', 'thinking_start', 'thinking_delta', 'thinking_end', 'assistant_delta', 'assistant_delta', 'assistant_end', 'result']);
	assert.deepEqual(t.events.find((e) => e.type === 'session'), { type: 'session', sessionId: id, claudeSessionId: 'claude-session-1', backend: 'claude', model: 'claude-sonnet' });
	assert.deepEqual({ ok: t.result.ok, text: t.result.text, costUsd: t.result.costUsd, subtype: t.result.subtype }, { ok: true, text: 'claude says: 你好', costUsd: 0.002, subtype: 'success' });
	const sess = await storedWhen(id, (x) => x.messages.length === 3 && x.claudeSessionId);
	assert.equal(sess.claudeSessionId, 'claude-session-1');
	assert.equal(sess.backend, 'claude');
	assert.deepEqual(sess.messages.map((m) => [m.role, m.text]), [['user', '你好'], ['think', 'thinking about it'], ['assistant', 'claude says: 你好']]);
	const start = chatStarts()[0].start;
	assert.deepEqual({ model: start.model, effort: start.effort, permissionMode: start.permissionMode, resume: start.resume, cwd: start.cwd, thinking: start.thinking },
		{ model: 'sonnet', effort: 'xhigh', permissionMode: 'default', resume: null, cwd: work, thinking: { type: 'adaptive', display: 'summarized' } });
	assert.match(start.append, /在 DroidAgent App 里工作/);
	assert.match(start.append, /用 Edit 或 Write 工具往笔记里加一条/);
	assert.match(start.append, /你的经验笔记/);
	assert.ok(start.exe.endsWith('/bin/claude'));
});

test('tool steps: allowed by the mode, or put to the owner; settings reach the live process', async () => {
	const id = await newSession();
	const ok = await say(id, 'tool: ls /sdcard');
	const use = ok.events.find((e) => e.type === 'tool_use');
	assert.deepEqual({ name: use.name, title: use.title, detail: use.detail, category: use.category }, { name: 'Bash', title: '运行测试命令', detail: 'ls /sdcard', category: '命令' });
	assert.deepEqual(ok.events.find((e) => e.type === 'tool_result').summary, 'ran: ls /sdcard');
	assert.ok(!ok.events.some((e) => e.type === 'permission'));

	// A risky command asks, and "no" reaches Claude as a refusal.
	const from = events.length;
	await api('/api/send', { text: 'tool: rm -rf /sdcard/Download', sessionId: id });
	const card = await waitFor((e) => e.type === 'permission' && e.sessionId === id, { from });
	assert.equal(card.reason, '需要确认');
	await api('/api/permission', { id: card.id, decision: 'deny', sessionId: id });
	await waitFor((e) => e.type === 'result' && e.sessionId === id, { from });
	const refused = events.slice(from).find((e) => e.type === 'tool_result');
	assert.deepEqual({ ok: refused.ok, summary: refused.summary }, { ok: false, summary: '用户拒绝了这个操作' });

	// Mode and model changes are pushed to the process that is already running.
	await api('/api/settings', { mode: 'plan', model: 'opus', modelName: 'Opus 5.5' });
	await new Promise((r) => setTimeout(r, 100));
	assert.ok(sdk().some((l) => l.setPermissionMode === 'plan'));
	assert.ok(sdk().some((l) => l.setModel === 'opus'));
	await api('/api/settings', { mode: 'acceptEdits', model: 'sonnet', modelName: 'Sonnet 5.5' });
	const names = (await api(`/api/commands?sessionId=${id}`)).commands.map((c) => c.name);
	assert.ok(names.includes('compact'), 'the live conversation\'s own command list');
});

test('moving a conversation to the other agent and back: each resumes its own thread, and the owner is told', async () => {
	mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
	writeFileSync(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), JSON.stringify({ token: { refresh_token: 'r' } }));
	const id = await newSession();
	await say(id, 'first, with Claude');
	const startsBefore = chatStarts().length;

	await api('/api/settings', { model: 'agy:gemini-3.8-flash', modelName: 'Gemini 3.8 Flash' });
	await new Promise((r) => setTimeout(r, 100));
	assert.ok(!sdk().some((l) => String(l.setModel).startsWith('agy:')), "an Antigravity model is never pushed to Claude's process");
	const viaAgy = await say(id, 'second, with Antigravity');
	assert.match(viaAgy.events.find((e) => e.type === 'notice').text, /从这里开始由 Antigravity 回答。它看不到前面由 Claude 完成的内容/);
	assert.equal(viaAgy.events.filter((e) => e.type === 'assistant_delta').map((e) => e.text).join(''), 'echo(gemini-3.8-flash/extra): second, with Antigravity');
	let sess = await storedWhen(id, (x) => x.agyConversationId && x.messages.at(-1)?.role === 'assistant');
	assert.equal(sess.backend, 'agy');
	assert.equal(sess.claudeSessionId, 'claude-session-1', "Claude's thread is kept for when it comes back");
	assert.ok(sess.agyConversationId);

	await api('/api/settings', { model: 'sonnet', modelName: 'Sonnet 5.5' });
	const back = await say(id, 'third, with Claude again');
	assert.match(back.events.find((e) => e.type === 'notice').text, /从这里开始由 Claude 回答。它只记得自己之前参与的部分/);
	assert.equal(back.result.text, 'claude says: third, with Claude again');
	const starts = chatStarts();
	assert.equal(starts.length, startsBefore + 1);
	assert.equal(starts.at(-1).start.resume, 'claude-session-1');
	sess = await storedWhen(id, (x) => x.messages.at(-1)?.text === 'claude says: third, with Claude again');
	assert.equal(sess.backend, 'claude');
	assert.deepEqual(sess.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => m.text), [
		'first, with Claude', 'claude says: first, with Claude',
		'second, with Antigravity', 'echo(gemini-3.8-flash/extra): second, with Antigravity',
		'third, with Claude again', 'claude says: third, with Claude again',
	]);
});

test('signing out of Claude while Antigravity is signed in moves to a model that can answer', async () => {
	const from = events.length;
	// The stand-in `claude` always says "signed in"; take it away, as a real sign-out would its login.
	rmSync(join(home, 'bin', 'claude'));
	writeFileSync(join(home, 'bin', 'claude'), '#!/bin/sh\ncase "$1" in --version) echo "2.1.999 (Claude Code)";; auth) echo \'{"loggedIn":false}\';; esac\n');
	chmodSync(join(home, 'bin', 'claude'), 0o755);
	await api('/api/account/logout', {});
	const auth = await waitFor((e) => e.type === 'auth', { from });
	assert.deepEqual(auth, { type: 'auth', loggedIn: true, accounts: { claude: false, agy: true } });
	const s = (await api('/api/status')).settings;
	assert.deepEqual({ model: s.model, modelName: s.modelName }, { model: 'agy:gemini-4-carbon-high', modelName: 'Gemini 4 Carbon (High)' });
});
