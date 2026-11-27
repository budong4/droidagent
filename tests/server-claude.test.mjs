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
const agyLog = join(home, 'agy.jsonl');
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
			if (text === 'edit and shoot') {
				const ed = { file_path: '/sdcard/a.txt', old_string: 'one\\ntwo\\nthree', new_string: 'one\\nTWO\\nthree' };
				yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ed_' + n, name: 'Edit', input: ed }] } };
				await options.canUseTool('Edit', ed);
				yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ed_' + n, content: 'ok' }] } };
				const rd = { file_path: '/tmp/droid/shot.png' };
				yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'rd_' + n, name: 'Read', input: rd }] } };
				const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
				yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'rd_' + n, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] }] } };
			}
			if (text.startsWith('search: ')) {
				const input = { query: text.slice(8) };
				yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ws_' + n, name: 'WebSearch', input }] } };
				const d = await options.canUseTool('WebSearch', input);
				const links = [{ title: 'First', url: 'https://one.example/a' }, { title: 'Second', url: 'https://two.example/b' }];
				yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ws_' + n, is_error: d.behavior !== 'allow', content: 'Web search results for query: "' + input.query + '"\\n\\nLinks: ' + JSON.stringify(links) + '\\n\\nsummary' }] } };
			}
			if (text.startsWith('ask: ')) {
				const [question, ...labels] = text.slice(5).split('|');
				const input = { questions: [{ question, header: 'Pick', multiSelect: false, options: labels.map((label) => ({ label, description: 'd' })) }] };
				yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ask_' + n, name: 'AskUserQuestion', input }] } };
				const d = await options.canUseTool('AskUserQuestion', input);
				note({ asked: d });
				yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ask_' + n, is_error: d.behavior !== 'allow', content: d.behavior === 'allow' ? JSON.stringify(d.updatedInput.answers) : d.message }] } };
			}
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
const agyRuns = () => (existsSync(agyLog) ? readFileSync(agyLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

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
			DROIDAGENT_NO_UPDATE: '1', AGENT_AGY_BIN: join(HERE, 'fake-agy.mjs'), FAKE_SDK_LOG: sdkLog, FAKE_AGY_LOG: agyLog, AGENT_BG_DIR: join(home, 'bg'),
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
	await api('/api/settings', { mode: 'plan', model: 'opus', modelName: 'Opus 5.5', sessionId: id });
	await new Promise((r) => setTimeout(r, 100));
	assert.ok(sdk().some((l) => l.setPermissionMode === 'plan'));
	assert.ok(sdk().some((l) => l.setModel === 'opus'));
	await api('/api/settings', { mode: 'acceptEdits', model: 'sonnet', modelName: 'Sonnet 5.5', sessionId: id });
	const names = (await api(`/api/commands?sessionId=${id}`)).commands.map((c) => c.name);
	assert.ok(names.includes('compact'), 'the live conversation\'s own command list');
});

test('moving a conversation to the other agent and back: each resumes its own thread, and the owner is told', async () => {
	mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
	writeFileSync(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), JSON.stringify({ token: { refresh_token: 'r' } }));
	const id = await newSession();
	await say(id, 'first, with Claude');
	const startsBefore = chatStarts().length;

	await api('/api/settings', { model: 'agy:gemini-3.8-flash', modelName: 'Gemini 3.8 Flash', sessionId: id });
	await new Promise((r) => setTimeout(r, 100));
	assert.ok(!sdk().some((l) => String(l.setModel).startsWith('agy:')), "an Antigravity model is never pushed to Claude's process");
	const viaAgy = await say(id, 'second, with Antigravity');
	assert.match(viaAgy.events.find((e) => e.type === 'notice').text, /从这里开始由 Antigravity 回答，前面 Claude 那部分对话会一起交给它/);
	// What it did not see goes with the message, as a record ahead of it.
	const agyPrompt = agyRuns().filter((r) => r.acp && r.prompt).at(-1).prompt;
	assert.match(agyPrompt, /【前情】[\s\S]*用户：first, with Claude\nClaude：claude says: first, with Claude\n【前情完】\n\nsecond, with Antigravity$/);
	assert.equal(viaAgy.events.filter((e) => e.type === 'assistant_delta').map((e) => e.text).join(''), 'echo(gemini-3.8-flash/extra): second, with Antigravity');
	let sess = await storedWhen(id, (x) => x.agyConversationId && x.messages.at(-1)?.role === 'assistant');
	assert.equal(sess.backend, 'agy');
	assert.equal(sess.claudeSessionId, 'claude-session-1', "Claude's thread is kept for when it comes back");
	assert.ok(sess.agyConversationId);

	await api('/api/settings', { model: 'sonnet', modelName: 'Sonnet 5.5', sessionId: id });
	const back = await say(id, 'third, with Claude again');
	assert.match(back.events.find((e) => e.type === 'notice').text, /从这里开始由 Claude 回答，前面 Antigravity 那部分对话会一起交给它/);
	// Claude remembers its own part; only Antigravity's goes with the message.
	assert.match(back.result.text, /^claude says: 【前情】[\s\S]*用户：second, with Antigravity\nAntigravity：echo\(gemini-3\.8-flash\/extra\): second, with Antigravity\n【前情完】\n\nthird, with Claude again$/);
	assert.ok(!back.result.text.includes('first, with Claude'), 'what Claude already had is not sent again');
	const starts = chatStarts();
	assert.equal(starts.length, startsBefore + 1);
	assert.equal(starts.at(-1).start.resume, 'claude-session-1');
	sess = await storedWhen(id, (x) => x.messages.at(-1)?.role === 'assistant' && /third, with Claude again$/.test(x.messages.at(-1).text));
	assert.equal(sess.backend, 'claude');
	assert.deepEqual(sess.messages.filter((m) => m.role === 'user').map((m) => m.text), ['first, with Claude', 'second, with Antigravity', 'third, with Claude again'], 'the record is not saved into the conversation');
	assert.deepEqual(sess.messages.filter((m) => m.role === 'assistant').map((m) => m.by), ['claude', 'agy', 'claude']);
	assert.deepEqual({ model: sess.model, others: (await api('/api/status')).settings.model }, { model: 'sonnet', others: 'sonnet' }, 'kept on the conversation, and what new ones start with');
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

test("Claude's AskUserQuestion: a sheet, the answer as Claude Code expects it", async () => {
	// Back to Claude with a working login for this one.
	writeFileSync(join(home, 'bin', 'claude'), FAKE_CLAUDE);
	chmodSync(join(home, 'bin', 'claude'), 0o755);
	await api('/api/settings', { model: 'sonnet', modelName: 'Sonnet 5.5', mode: 'bypassPermissions' });
	const id = await newSession();
	const from = events.length;
	await api('/api/send', { text: 'ask: Which one?|A|B', sessionId: id });
	const q = await waitFor((e) => e.type === 'question' && e.sessionId === id, { from });
	assert.equal(q.questions[0].options[1].label, 'B');
	assert.ok(!events.slice(from).some((e) => e.type === 'tool_use' && e.name === 'AskUserQuestion' && false));
	await api('/api/answer', { id: q.id, sessionId: id, answers: { 'Which one?': 'B, and something else' } });
	await waitFor((e) => e.type === 'result' && e.sessionId === id, { from });
	const asked = sdk().filter((l) => l.asked).at(-1).asked;
	assert.deepEqual(asked, { behavior: 'allow', updatedInput: { questions: asked.updatedInput.questions, answers: { 'Which one?': 'B, and something else' } } });
	await api('/api/settings', { mode: 'acceptEdits' });
});

test('a web search: its query and results on the step, its sources under the answer, kept', async () => {
	const id = await newSession();
	const t = await say(id, 'search: 电池 健康');
	const res = t.events.find((e) => e.type === 'tool_result');
	assert.equal(res.query, '电池 健康');
	assert.deepEqual(res.sources.map((x) => x.url), ['https://one.example/a', 'https://two.example/b']);
	assert.deepEqual(t.result.sources, res.sources);
	const sess = await storedWhen(id, (x) => x.messages.some((m) => m.role === 'assistant' && m.sources));
	assert.deepEqual(sess.messages.find((m) => m.role === 'assistant').sources, res.sources);
	assert.equal(sess.messages.find((m) => m.role === 'tool').query, '电池 健康');
	// The next answer starts with no sources of its own.
	assert.deepEqual((await say(id, 'plain')).result.sources, []);
});

test("a file change shows what changed; a picture a step returned is kept and shown", async () => {
	const id = await newSession();
	const t = await say(id, 'edit and shoot');
	const edit = t.events.find((e) => e.type === 'tool_use' && e.name === 'Edit');
	assert.deepEqual(edit.diff, { path: '/sdcard/a.txt', old: 'one\ntwo\nthree', new: 'one\nTWO\nthree' });
	const shot = t.events.find((e) => e.type === 'tool_result' && e.images);
	assert.match(shot.images[0], /^\/api\/media\/[0-9a-f]{24}\.png$/);
	const img = await fetch(base + shot.images[0]);
	assert.equal(img.headers.get('content-type'), 'image/png');
	assert.equal(Buffer.from(await img.arrayBuffer()).subarray(1, 4).toString(), 'PNG');
	assert.equal((await fetch(base + '/api/media/../../etc/passwd')).status, 404);
	const sess = await storedWhen(id, (x) => x.messages.some((m) => m.images));
	assert.deepEqual(sess.messages.find((m) => m.images).images, shot.images);
	assert.ok(sess.messages.find((m) => m.name === 'Edit').diff);
});

test('each conversation keeps its own model and level; a new one starts with the last picked', async () => {
	const a = await newSession();
	await say(a, 'on opus');
	await api('/api/settings', { model: 'opus', modelName: 'Opus 5.5', effort: 'medium', sessionId: a });
	const b = await newSession();
	await api('/api/settings', { model: 'haiku-4.5', modelName: 'Haiku 4.5', effort: 'high', sessionId: b });
	await say(b, 'on haiku');
	// Haiku 4.5 has no thinking levels: no effort is asked for at all.
	const hb = sdk().filter((l) => l.start?.model === 'claude-haiku-4-5').at(-1);
	assert.ok(hb && !('effort' in hb.start), JSON.stringify(hb));
	// Back in the first conversation: still Opus at medium, whatever was picked since.
	await say(a, 'still opus?');
	const sa = await storedWhen(a, (x) => x.messages.filter((m) => m.role === 'user').length === 2);
	assert.deepEqual({ model: sa.model, effort: sa.effort }, { model: 'opus', effort: 'medium' });
	assert.equal(chatStarts().at(-1).start.effort, 'medium', 'its process was started again with its own level');
	// A new conversation starts with what was picked last.
	const c = await newSession();
	await say(c, 'new one');
	assert.equal(stored(c).model, 'haiku-4.5');
	await api('/api/settings', { model: 'sonnet', modelName: 'Sonnet 5.5', effort: 'xhigh' });
});

test('typing while the assistant waits on the owner: the answer to its question, or what to do instead of the step', async () => {
	const id = await newSession();
	let from = events.length;
	await api('/api/send', { text: 'ask: Which one?|A|B', sessionId: id });
	const q = await waitFor((e) => e.type === 'question' && e.sessionId === id, { from });
	assert.deepEqual(await api('/api/send', { text: 'neither, wait', sessionId: id }), { ok: true, answered: 'question' });
	await waitFor((e) => e.type === 'result' && e.sessionId === id, { from });
	assert.deepEqual(sdk().filter((l) => l.asked).at(-1).asked.updatedInput.answers, { 'Which one?': 'neither, wait' });
	assert.equal((await storedWhen(id, (x) => x.messages.find((m) => m.id === q.id)?.verdict)).messages.find((m) => m.id === q.id).verdict, 'answered');

	await api('/api/settings', { mode: 'default' });
	from = events.length;
	await api('/api/send', { text: 'tool: rm -rf /sdcard/Download', sessionId: id });
	await waitFor((e) => e.type === 'permission' && e.sessionId === id, { from });
	assert.deepEqual(await api('/api/send', { text: 'move it to the bin instead', sessionId: id }), { ok: true, answered: 'permission' });
	await waitFor((e) => e.type === 'result' && e.sessionId === id, { from });
	const refused = events.slice(from).find((e) => e.type === 'tool_result');
	assert.match(refused.summary, /move it to the bin instead/, 'Claude is told what the owner said instead');
	const sess = await storedWhen(id, (x) => x.messages.some((m) => m.text === 'move it to the bin instead'));
	assert.equal(sess.messages.filter((m) => m.role === 'perm').at(-1).verdict, 'deny');
	await api('/api/settings', { mode: 'acceptEdits' });
});

test('going back to an earlier message: it and what followed are taken out, and the agent starts afresh with the rest as a record', async () => {
	const id = await newSession();
	await say(id, 'one: look at the battery');
	await say(id, 'two: clear the cache');
	await say(id, 'three: restart');
	const r = await api('/api/sessions/rewind', { id, index: 1, text: 'two: clear the cache' });
	assert.equal(r.ok, true);
	assert.equal(r.text, 'two: clear the cache', 'the message comes back to be changed');
	assert.deepEqual(r.session.messages.filter((m) => m.role === 'user').map((m) => m.text), ['one: look at the battery']);
	const kept = await storedWhen(id, (x) => x.messages.filter((m) => m.role === 'user').length === 1);
	assert.equal(kept.claudeSessionId, null, "Claude's thread, which holds what was taken out, is not resumed");
	const starts = chatStarts().length;
	const t = await say(id, 'two, changed: clear downloads only');
	assert.equal(chatStarts().length, starts + 1);
	assert.equal(chatStarts().at(-1).start.resume, null, 'a fresh thread');
	assert.match(t.result.text, /【前情】[\s\S]*用户：one: look at the battery\n[\s\S]*【前情完】\n\ntwo, changed: clear downloads only$/);
	assert.ok(!t.result.text.includes('three'), 'nothing of what was taken out');
	// The list shows each conversation's model.
	const listed = (await api('/api/sessions')).sessions.find((s) => s.id === id);
	assert.equal(listed.model, 'sonnet');
	// Not while a turn runs.
	const from = events.length;
	await api('/api/settings', { mode: 'default' });
	await api('/api/send', { text: 'tool: rm -rf /sdcard/Download', sessionId: id });
	const card = await waitFor((e) => e.type === 'permission' && e.sessionId === id, { from });
	const busy = await fetch(base + '/api/sessions/rewind', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, index: 0 }) });
	assert.equal(busy.status, 409);
	await api('/api/permission', { id: card.id, decision: 'deny', sessionId: id });
	await waitFor((e) => e.type === 'result' && e.sessionId === id, { from });
	await api('/api/settings', { mode: 'acceptEdits' });
});
