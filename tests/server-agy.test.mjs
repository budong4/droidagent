// Run: node --test tests/server-agy.test.mjs
// The real server, with a throwaway home and tests/fake-agy.mjs standing in for the Antigravity
// CLI: an Antigravity conversation from the page's side — messages, tool cards, confirmation
// cards answered through our MCP tools, stopping, usage, plugins, signing out.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'droidagent-server-'));
const work = join(home, 'work');
const agyLog = join(home, 'agy-runs.jsonl');
let server, port, base;
const events = [];
const waiters = new Set();

const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const api = async (path, body) => (await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
// The next event (from `from` on) that matches.
function waitFor(match, { from = 0, timeout = 20000 } = {}) {
	return new Promise((resolve, reject) => {
		const check = () => {
			const i = events.findIndex((e, n) => n >= from && match(e));
			if (i < 0) return false;
			clearTimeout(timer); waiters.delete(check); resolve(events[i]);
			return true;
		};
		const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`no such event within ${timeout} ms; saw: ${events.slice(from).map((e) => e.type).join(', ')}`)); }, timeout);
		if (!check()) waiters.add(check);
	});
}
const runs = () => (existsSync(agyLog) ? readFileSync(agyLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
// One message and everything it caused, up to the end of its turn.
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

before(async () => {
	// A PATH with node and the system tools but no `claude`: this server has Antigravity only.
	const bin = join(home, 'bin');
	mkdirSync(bin, { recursive: true });
	mkdirSync(work, { recursive: true });
	symlinkSync(process.execPath, join(bin, 'node'));
	port = await freePort();
	base = `http://127.0.0.1:${port}`;
	server = spawn(process.execPath, [join(HERE, '..', 'app', 'server', 'server.mjs')], {
		env: {
			HOME: home, PATH: `${bin}:/usr/bin:/bin`, AGENT_PORT: String(port), AGENT_CWD: work, AGENT_PROXY_FILE: join(home, 'proxy.env'),
			DROIDAGENT_NO_UPDATE: '1', AGENT_AGY_BIN: join(HERE, 'fake-agy.mjs'), FAKE_AGY_LOG: agyLog, AGENT_BG_DIR: join(home, 'bg'),
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

test('nobody is signed in; then an Antigravity login appears', async () => {
	assert.deepEqual(events.find((e) => e.type === 'auth'), { type: 'auth', loggedIn: false, accounts: { claude: false, agy: false } });
	let st = await api('/api/agy/status');
	assert.deepEqual({ installed: st.installed, version: st.version, loggedIn: st.loggedIn, models: st.models }, { installed: true, version: '1.5.9-fake', loggedIn: false, models: [] });
	// What agy's own sign-in leaves behind.
	mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
	writeFileSync(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), JSON.stringify({ token: { access_token: 'a', refresh_token: 'r' }, auth_method: 'consumer' }));
	st = await api('/api/agy/status');
	assert.equal(st.loggedIn, true);
	assert.deepEqual(st.models[0], { id: 'agy:gemini-4-carbon-high', name: 'Gemini 4 Carbon (High)' });
	assert.deepEqual((await api('/api/status')).accounts, { claude: false, agy: true });
	const r = await api('/api/settings', { model: 'agy:gemini-3.8-flash', modelName: 'Gemini 3.8 Flash', mode: 'acceptEdits' });
	assert.equal(r.settings.model, 'agy:gemini-3.8-flash');
});

test('a conversation: streamed reply, kept on disk, resumed by its id on the next message', async () => {
	const id = await newSession();
	const first = await say(id, '你好');
	assert.equal(first.result.ok, true);
	assert.equal(first.result.subtype, 'success');
	assert.equal(first.events.filter((e) => e.type === 'assistant_delta').map((e) => e.text).join(''), 'echo(gemini-3.8-flash): 你好');
	assert.deepEqual(first.events.find((e) => e.type === 'session'), { type: 'session', sessionId: id, claudeSessionId: null, backend: 'agy', model: 'gemini-3.8-flash' });
	await say(id, '第二句');
	const sess = await storedWhen(id, (x) => x.messages.filter((m) => m.role === 'assistant').length === 2);
	assert.equal(sess.backend, 'agy');
	assert.ok(sess.agyConversationId);
	assert.equal(sess.claudeSessionId ?? null, null);
	assert.deepEqual(sess.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => [m.role, m.text]),
		[['user', '你好'], ['assistant', 'echo(gemini-3.8-flash): 你好'], ['user', '第二句'], ['assistant', 'echo(gemini-3.8-flash): 第二句']]);
	const mine = runs().filter((r) => r.env.session === id);
	assert.equal(mine.length, 2);
	// The first message carries the app's instructions and the notes; the second is the owner's words.
	assert.match(mine[0].prompt, /你在 DroidAgent 里工作/);
	assert.match(mine[0].prompt, /droidagent/);
	assert.match(mine[0].prompt, /你的经验笔记/);
	assert.ok(mine[0].prompt.endsWith('【用户的消息】\n你好'));
	assert.equal(mine[1].prompt, '第二句');
	assert.equal(mine[1].argv[mine[1].argv.indexOf('--conversation') + 1], sess.agyConversationId);
	assert.equal(mine[0].cwd, work);
	// Before the turn, agy was given our tools and this mode's approvals.
	const mcp = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8')).mcpServers;
	assert.equal(mcp.droidagent.env.DROIDAGENT_BRIDGE_URL, base);
	assert.deepEqual(JSON.parse(readFileSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')).permissions.allow, ['mcp(droidagent/*)', 'mcp(*)']);
	assert.ok(existsSync(join(home, '.gemini', 'skills', 'phone-health', 'SKILL.md')), "the app's skills are where agy looks");
});

test('a command through our tool: allowed by the mode, shown as a command card', async () => {
	const id = await newSession();
	const t = await say(id, 'shell: echo hi-from-the-phone && pwd');
	const use = t.events.find((e) => e.type === 'tool_use');
	assert.deepEqual({ name: use.name, title: use.title, detail: use.detail, category: use.category }, { name: 'Bash', title: '运行测试命令', detail: 'echo hi-from-the-phone && pwd', category: '命令' });
	const res = t.events.find((e) => e.type === 'tool_result');
	assert.equal(res.ok, true);
	assert.equal(res.summary, `hi-from-the-phone\n${work}`);
	assert.ok(!t.events.some((e) => e.type === 'permission'), 'Accept edits: an ordinary command is not asked about');
	assert.equal(t.result.ok, true);
	const tool = (await storedWhen(id, (x) => x.messages.find((m) => m.role === 'tool')?.state === 'ok')).messages.find((m) => m.role === 'tool');
	assert.deepEqual({ state: tool.state, ok: tool.ok }, { state: 'ok', ok: true });
	// A failing command comes back as a failed step, with what it printed.
	const bad = await say(id, 'shell: echo oops >&2; exit 3');
	const failed = bad.events.find((e) => e.type === 'tool_result');
	assert.equal(failed.ok, false);
	assert.equal(failed.summary, 'oops\n（退出码 3）');
});

test('Ask mode: the same tool puts a card to the owner and waits for the answer', async () => {
	await api('/api/settings', { mode: 'default' });
	const id = await newSession();
	const target = join(work, 'made-by-agy.txt');

	// Refused: nothing happens, and agy is told so.
	let from = events.length;
	await api('/api/send', { text: `shell: touch ${target}`, sessionId: id });
	let card = await waitFor((e) => e.type === 'permission' && e.sessionId === id, { from });
	assert.deepEqual({ name: card.name, detail: card.detail, reason: card.reason }, { name: 'Bash', detail: `touch ${target}`, reason: '需要确认' });
	assert.ok(!existsSync(target), 'nothing ran while the card was open');
	assert.deepEqual(await api('/api/permission', { id: card.id, decision: 'deny', sessionId: id }), { ok: true });
	let result = await waitFor((e) => e.type === 'result' && e.sessionId === id, { from });
	assert.ok(!existsSync(target));
	const refused = events.slice(from).find((e) => e.type === 'tool_result' && e.sessionId === id);
	assert.deepEqual({ ok: refused.ok, summary: refused.summary }, { ok: false, summary: '用户拒绝了这个操作' });
	assert.equal(result.ok, true);

	// Allowed: it runs.
	from = events.length;
	await api('/api/send', { text: `shell: touch ${target}`, sessionId: id });
	card = await waitFor((e) => e.type === 'permission' && e.sessionId === id, { from });
	await api('/api/permission', { id: card.id, decision: 'allow', sessionId: id });
	result = await waitFor((e) => e.type === 'result' && e.sessionId === id, { from });
	assert.ok(existsSync(target));
	assert.deepEqual((await storedWhen(id, (x) => x.messages.filter((m) => m.role === 'perm' && m.verdict).length === 2)).messages.filter((m) => m.role === 'perm').map((m) => m.verdict), ['deny', 'allow']);

	// Looking is not asked about, even here.
	const look = await say(id, `shell: ls ${work}`);
	assert.ok(!look.events.some((e) => e.type === 'permission'));
	assert.match(look.events.find((e) => e.type === 'tool_result').summary, /made-by-agy\.txt/);

	// A file written through our tool is asked about in Ask mode, and written once allowed.
	const file = join(work, 'notes', 'a.txt');
	from = events.length;
	await api('/api/send', { text: `write: ${file}=hello=world`, sessionId: id });
	card = await waitFor((e) => e.type === 'permission' && e.sessionId === id, { from });
	assert.equal(card.name, 'Write');
	await api('/api/permission', { id: card.id, decision: 'allow', sessionId: id });
	await waitFor((e) => e.type === 'result' && e.sessionId === id, { from });
	assert.equal(readFileSync(file, 'utf8'), 'hello=world');
	const use = events.slice(from).find((e) => e.type === 'tool_use' && e.sessionId === id);
	assert.deepEqual({ name: use.name, title: use.title }, { name: 'Write', title: '新建或覆盖 a.txt' });
});

test("a catastrophic command is asked about even in Auto, and agy's own tools cannot get round the card", async () => {
	await api('/api/settings', { mode: 'auto' });
	const id = await newSession();
	let from = events.length;
	await api('/api/send', { text: 'shell: echo would-reboot; : reboot', sessionId: id });
	const card = await waitFor((e) => e.type === 'permission' && e.sessionId === id, { from });
	assert.equal(card.reason, '高危操作');
	await api('/api/permission', { id: card.id, decision: 'deny', sessionId: id });
	await waitFor((e) => e.type === 'result' && e.sessionId === id, { from });
	// Its own run_command is refused by agy itself below Full access; the owner is told why.
	const native = await say(id, 'native: rm -rf /sdcard/x');
	assert.equal(native.events.find((e) => e.type === 'tool_result').ok, false);
	assert.match(native.events.find((e) => e.type === 'notice').text, /Full access/);
	assert.ok(!runs().some((r) => r.argv.includes('--dangerously-skip-permissions')), 'no mode below Full access passes that flag');
	// Full access: agy runs its own tools, by the owner's explicit choice.
	await api('/api/settings', { mode: 'bypassPermissions' });
	const free = await say(id, 'native: ls');
	assert.equal(free.events.find((e) => e.type === 'tool_result').summary, 'ran natively');
	assert.ok(runs().at(-1).argv.includes('--dangerously-skip-permissions'));
	await api('/api/settings', { mode: 'acceptEdits' });
});

test('a tool call that is not ours to answer is turned away', async () => {
	const call = (b) => api('/api/agy-bridge/call', b);
	assert.deepEqual(await call({ token: 'wrong', sessionId: 'x', tool: 'shell', arguments: { command: `touch ${join(work, 'pwned')}` } }), { ok: false, text: '这次调用没有通过验证' });
	const token = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8')).mcpServers.droidagent.env.DROIDAGENT_BRIDGE_TOKEN;
	// The right token, but no turn in progress to act for.
	assert.equal((await call({ token, sessionId: 'no-such-conversation', tool: 'shell', arguments: { command: `touch ${join(work, 'pwned')}` } })).ok, false);
	assert.ok(!existsSync(join(work, 'pwned')));
	// A page in a browser cannot call it: wrong origin, like every other endpoint.
	const res = await fetch(base + '/api/agy-bridge/call', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
	assert.equal(res.status, 403);
});

test('Stop ends the turn and the command it was running', async () => {
	const id = await newSession();
	const marker = join(work, 'still-running');
	const from = events.length;
	await api('/api/send', { text: `shell: sleep 1; sleep 1; sleep 1; sleep 1; touch ${marker}`, sessionId: id });
	await waitFor((e) => e.type === 'tool_use' && e.sessionId === id, { from });
	await new Promise((r) => setTimeout(r, 300));
	await api('/api/stop', { sessionId: id });
	const result = await waitFor((e) => e.type === 'result' && e.sessionId === id, { from });
	assert.equal(result.ok, false);
	await new Promise((r) => setTimeout(r, 4500));
	assert.ok(!existsSync(marker), 'the command was stopped with the turn');
	// The conversation goes on afterwards.
	assert.equal((await say(id, 'still there?')).result.ok, true);
});

test('messages sent during a turn wait their turn', async () => {
	const id = await newSession();
	const from = events.length;
	await api('/api/send', { text: 'shell: sleep 0.5; echo first', sessionId: id });
	assert.deepEqual(await api('/api/send', { text: 'second', sessionId: id }), { ok: true, queued: true });
	await waitFor((e) => e.type === 'result' && e.sessionId === id, { from });
	await waitFor((e) => e.type === 'user_echo' && e.sessionId === id && e.fromQueue, { from });
	const results = [];
	await waitFor((e) => e.type === 'result' && e.sessionId === id && results.push(e) === 2, { from });
	assert.deepEqual((await storedWhen(id, (x) => x.messages.filter((m) => m.role === 'user').length === 2)).messages.filter((m) => m.role === 'user').map((m) => m.text), ['shell: sleep 0.5; echo first', 'second']);
});

test('usage, slash commands and plugins come from agy itself', async () => {
	const u = await api('/api/usage?fresh=1');
	assert.equal(u.provider, 'agy');
	assert.deepEqual(u.rate_limits.five_hour, { utilization: 25, resets_at: '2030-01-01T00:00:00Z' });
	assert.deepEqual(u.rate_limits.seven_day, { utilization: 60, resets_at: null });
	assert.deepEqual(u.groups.map((g) => g.name), ['Gemini', 'Claude and GPT']);
	// The ring follows the model in use: a Claude model on Antigravity draws from the other group.
	await api('/api/settings', { model: 'agy:claude-sonnet-5-5', modelName: 'Claude Sonnet 5.5 (Thinking)' });
	assert.equal((await api('/api/usage')).rate_limits.five_hour.utilization, 90);
	await api('/api/settings', { model: 'agy:gemini-3.8-flash', modelName: 'Gemini 3.8 Flash' });
	const names = (await api('/api/commands')).commands.map((c) => c.name);
	assert.ok(names.includes('plan') && names.includes('usage') && !names.includes('compact'), names.join(','));
	assert.ok(names.includes('phone-health'), 'skills are slash commands for agy too');
	assert.deepEqual((await api('/api/agy/plugins')).plugins.map((p) => p.name), ['demo-plugin']);
	assert.equal((await api('/api/agy/plugins/install', { source: 'https://github.com/someone/plugin' })).ok, true);
	assert.equal((await api('/api/agy/plugins/install', { source: '--dangerous-flag' })).ok, false);
});

test('the title of an Antigravity conversation is made by Antigravity', async () => {
	const id = await newSession();
	const from = events.length;
	await say(id, '帮我看看电池');
	const title = await waitFor((e) => e.type === 'title' && e.sessionId === id, { from });
	assert.equal(title.title, "查看电池状态");
	assert.ok(runs().some((r) => r.argv.includes('json') && /起一个标题/.test(r.prompt) && !r.env.session));
});

test('signing out of Antigravity', async () => {
	const from = events.length;
	assert.deepEqual(await api('/api/agy/logout', {}), { ok: true });
	const auth = await waitFor((e) => e.type === 'auth', { from });
	assert.deepEqual(auth.accounts, { claude: false, agy: false });
	assert.ok(!existsSync(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')));
});
