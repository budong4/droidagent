// Run: node --test tests/server-agy.test.mjs
// The real server, with a throwaway home and tests/fake-agy.mjs standing in for the Antigravity
// CLI (its ACP server): an Antigravity conversation from the page's side — messages, tool cards,
// agy's own permission requests answered by the confirmation cards, thoughts, stopping, usage,
// plugins, signing out.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
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

let google, oauthPort;
before(async () => {
	// A stand-in for Google's token and userinfo endpoints, for signing in to Antigravity.
	const { createServer: httpServer } = await import('node:http');
	const g = httpServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { const f = Object.fromEntries(new URLSearchParams(b)); res.writeHead(req.url === '/token' && f.code !== 'good' ? 400 : 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(req.url === '/token' ? (f.code === 'good' ? { access_token: 'ya29.x', refresh_token: '1//r', expires_in: 3600 } : { error: 'invalid_grant' }) : { email: 'owner@example.com' })); }); });
	await new Promise((r) => g.listen(0, '127.0.0.1', r));
	google = { base: `http://127.0.0.1:${g.address().port}`, close: () => g.close() };
	oauthPort = await freePort();
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
			AGENT_CHROMIUM: process.env.AGENT_CHROMIUM || '/usr/bin/google-chrome', AGENT_BROWSER_IDLE_MS: '600000',
			AGY_OAUTH_TOKEN_URL: `${google.base}/token`, AGY_OAUTH_USERINFO_URL: `${google.base}/userinfo`, AGY_OAUTH_PORT: String(oauthPort),
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
after(async () => {
	await api('/api/browser/stop', {}).catch(() => {});
	server?.kill('SIGKILL');
	google?.close();
	// Chromium can still be flushing its profile for a moment after the server is gone.
	try { execFileSync('pkill', ['-KILL', '-f', `--user-data-dir=${join(home, '.droidagent', 'browser-profile')}`]); } catch { /* none left */ }
	for (let i = 0; ; i++) {
		try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); break; } catch (e) { if (i > 10) throw e; await new Promise((r) => setTimeout(r, 300)); }
	}
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

test('a conversation: streamed reply, kept on disk, one session across messages', async () => {
	const id = await newSession();
	const first = await say(id, '你好');
	assert.equal(first.result.ok, true);
	assert.equal(first.result.subtype, 'success');
	assert.equal(first.events.filter((e) => e.type === 'assistant_delta').map((e) => e.text).join(''), 'echo(gemini-3.8-flash/extra): 你好');
	const ses = first.events.find((e) => e.type === 'session');
	assert.deepEqual({ claudeSessionId: ses.claudeSessionId, backend: ses.backend }, { claudeSessionId: null, backend: 'agy' });
	await say(id, '第二句');
	const sess = await storedWhen(id, (x) => x.messages.filter((m) => m.role === 'assistant').length === 2);
	assert.equal(sess.backend, 'agy');
	assert.ok(sess.agyConversationId);
	assert.equal(sess.claudeSessionId ?? null, null);
	assert.deepEqual(sess.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => [m.role, m.text]),
		[['user', '你好'], ['assistant', 'echo(gemini-3.8-flash/extra): 你好'], ['user', '第二句'], ['assistant', 'echo(gemini-3.8-flash/extra): 第二句']]);
	const mine = runs().filter((r) => r.acp && r.sessionId === sess.agyConversationId && r.prompt);
	assert.equal(mine.length, 2);
	// The first message carries the app's instructions and the notes; the second is the owner's words.
	assert.match(mine[0].prompt, /你在 DroidAgent 里工作/);
	assert.match(mine[0].prompt, /你的经验笔记/);
	assert.ok(mine[0].prompt.endsWith('【用户的消息】\n你好'));
	assert.equal(mine[1].prompt, '第二句');
	assert.equal(mine[0].cwd, work);
	// Below Full access, agy asks; nothing of the old MCP workaround is left in its configuration.
	assert.deepEqual(runs().find((r) => r.newSession === sess.agyConversationId).argv, ['acp']);
	assert.ok(!('droidagent' in (JSON.parse(readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8')).mcpServers || {})));
	assert.ok(existsSync(join(home, '.gemini', 'skills', 'phone-health', 'SKILL.md')), "the app's skills are where agy looks");
});

test('a command: allowed by the mode, shown as a command card', async () => {
	const id = await newSession();
	const t = await say(id, 'shell: echo hi-from-the-phone && pwd');
	const use = t.events.find((e) => e.type === 'tool_use');
	assert.deepEqual({ name: use.name, detail: use.detail, category: use.category }, { name: 'Bash', detail: 'echo hi-from-the-phone && pwd', category: '命令' });
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
	assert.equal(failed.summary, 'oops');
});

test('Ask mode: agy asks, a card goes to the owner, and agy waits for the answer', async () => {
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
	assert.deepEqual({ ok: refused.ok, summary: refused.summary }, { ok: false, summary: 'denied by the user' });
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

test('a catastrophic command is asked about even in Auto; Full access lets agy go without asking', async () => {
	await api('/api/settings', { mode: 'auto' });
	const id = await newSession();
	const from = events.length;
	await api('/api/send', { text: 'shell: echo would-reboot; : reboot', sessionId: id });
	const card = await waitFor((e) => e.type === 'permission' && e.sessionId === id, { from });
	assert.equal(card.reason, '高危操作');
	await api('/api/permission', { id: card.id, decision: 'deny', sessionId: id });
	await waitFor((e) => e.type === 'result' && e.sessionId === id, { from });
	assert.ok(!runs().some((r) => r.newSession && r.argv.includes('--dangerously-skip-permissions')), 'no mode below Full access passes that flag');
	// Full access: a new conversation's agy is told not to ask, by the owner's explicit choice.
	await api('/api/settings', { mode: 'bypassPermissions' });
	const id2 = await newSession();
	const free = await say(id2, 'shell: echo free');
	assert.ok(!free.events.some((e) => e.type === 'permission'));
	assert.equal(free.events.find((e) => e.type === 'tool_result').summary, 'free');
	assert.ok(runs().filter((r) => r.newSession).at(-1).argv.includes('--dangerously-skip-permissions'));
	await api('/api/settings', { mode: 'acceptEdits' });
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
	assert.ok(runs().some((r) => r.oneShot && r.argv.includes('json') && /起一个标题/.test(r.prompt)), 'named by a one-off question, outside the conversation');
});

test("Antigravity's thoughts are shown as they stream, before the step they led to", async () => {
	const id = await newSession();
	const kinds = (t) => t.events.filter((e) => ['thinking_start', 'thinking_delta', 'tool_use', 'assistant_delta'].includes(e.type)).map((e) => (e.type === 'thinking_delta' ? `think:${e.text}` : e.type));
	const first = await say(id, 'think: the battery');
	assert.deepEqual(kinds(first), ['thinking_start', 'think:first thought about the battery', 'tool_use', 'thinking_start', 'think:I should', 'think: look at the files', 'assistant_delta', 'assistant_delta']);
	const saved = await storedWhen(id, (x) => x.messages.filter((m) => m.role === 'think').length === 2);
	assert.deepEqual(saved.messages.filter((m) => m.role === 'think').map((m) => m.text), ['first thought about the battery', 'I should look at the files']);
});

test("a Claude plugin's skills and connectors reach Antigravity too", async () => {
	const root = join(home, '.claude', 'plugins', 'cache', 'mkt', 'phone-tools', '1.0.0');
	mkdirSync(join(root, 'skills', 'battery'), { recursive: true });
	writeFileSync(join(root, 'skills', 'battery', 'SKILL.md'), '---\nname: battery\ndescription: x\n---\n');
	writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: '${CLAUDE_PLUGIN_ROOT}/srv' } } }));
	mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
	writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'phone-tools@mkt': [{ installPath: root }] } }));
	const settingsFile = join(home, '.claude', 'settings.json');
	const before = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
	writeFileSync(settingsFile, JSON.stringify({ ...before, enabledPlugins: { 'phone-tools@mkt': true } }));
	await say(await newSession(), 'hello');
	assert.ok(existsSync(join(home, '.gemini', 'skills', 'phone-tools-battery', 'SKILL.md')));
	const mcp = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8')).mcpServers;
	assert.deepEqual(mcp['phone-tools-local'], { command: `${root}/srv`, args: [] });
	// Switched off: it goes from Antigravity as well.
	writeFileSync(settingsFile, JSON.stringify({ ...before, enabledPlugins: { 'phone-tools@mkt': false } }));
	await say(await newSession(), 'hello again');
	assert.ok(!existsSync(join(home, '.gemini', 'skills', 'phone-tools-battery')));
	assert.ok(!('phone-tools-local' in JSON.parse(readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8')).mcpServers));
});

test('signing out of Antigravity', async () => {
	const from = events.length;
	assert.deepEqual(await api('/api/agy/logout', {}), { ok: true });
	const auth = await waitFor((e) => e.type === 'auth', { from });
	assert.deepEqual(auth.accounts, { claude: false, agy: false });
	assert.ok(!existsSync(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')));
});

test('signing in to Antigravity: the link, the browser coming back to the phone, the account shown', async () => {
	const from = events.length;
	await api('/api/login/start', { provider: 'agy' });
	const link = await waitFor((e) => e.type === 'login_url' && e.provider === 'agy', { from });
	assert.equal(link.mode, 'auto');
	const u = new URL(link.url);
	assert.equal(u.searchParams.get('redirect_uri'), `http://localhost:${oauthPort}/oauth-callback`);
	// What the phone's browser does after "Allow".
	await fetch(`http://127.0.0.1:${oauthPort}/oauth-callback?code=good&state=${u.searchParams.get('state')}`);
	const done = await waitFor((e) => e.type === 'login_done' && e.provider === 'agy', { from });
	assert.equal(done.ok, true);
	await waitFor((e) => e.type === 'auth' && e.accounts?.agy, { from });
	const tok = JSON.parse(readFileSync(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'utf8'));
	assert.equal(tok.token.refresh_token, '1//r');
	assert.equal((await api('/api/agy/status')).email, 'owner@example.com');
	// And a pasted address from a stale attempt is told apart; a cancel stops listening.
	await api('/api/login/start', { provider: 'agy' });
	await api('/api/login/cancel', {});
	await assert.rejects(fetch(`http://127.0.0.1:${oauthPort}/oauth-callback?code=x`));
});

test('Antigravity asks the owner a question: a sheet with choices, the answer goes back to it', async () => {
	await api('/api/settings', { model: 'agy:gemini-3.8-flash', modelName: 'Gemini 3.8 Flash', mode: 'default' });
	const id = await newSession();
	const from = events.length;
	await api('/api/send', { text: 'ask: 清理哪些文件？|只清缓存|缓存和下载', sessionId: id });
	const q = await waitFor((e) => e.type === 'question' && e.sessionId === id, { from });
	assert.deepEqual(q.questions, [{ question: '清理哪些文件？', header: '选择', multiSelect: false, options: [{ label: '只清缓存', description: '' }, { label: '缓存和下载', description: '' }] }]);
	assert.ok(!events.slice(from).some((e) => e.type === 'permission'), 'asking is not a step that needs approval, even in Ask mode');
	assert.deepEqual(await api('/api/answer', { id: q.id, sessionId: id, answers: { '清理哪些文件？': '只清缓存' } }), { ok: true });
	const done = await waitFor((e) => e.type === 'result' && e.sessionId === id, { from });
	assert.equal(done.ok, true);
	const reply = events.slice(from).filter((e) => e.type === 'assistant_delta' && e.sessionId === id).map((e) => e.text).join('');
	assert.match(reply, /清理哪些文件？\n→ 只清缓存/);
	assert.ok(!events.slice(from).some((e) => e.type === 'tool_use' && e.sessionId === id && e.name !== 'mcp__droidagent__ask_user'));
	const saved = await storedWhen(id, (x) => x.messages.some((m) => m.role === 'ask' && m.verdict));
	assert.deepEqual(saved.messages.find((m) => m.role === 'ask').answers, { '清理哪些文件？': '只清缓存' });
	// Skipped: the assistant hears so.
	const from2 = events.length;
	await api('/api/send', { text: 'ask: 继续吗？|继续|算了', sessionId: id });
	const q2 = await waitFor((e) => e.type === 'question' && e.sessionId === id, { from: from2 });
	await api('/api/answer', { id: q2.id, sessionId: id });
	await waitFor((e) => e.type === 'result' && e.sessionId === id, { from: from2 });
	assert.match(events.slice(from2).filter((e) => e.type === 'assistant_delta').map((e) => e.text).join(''), /跳过/);
	// The tool server refuses a caller without the token.
	const r = await api('/api/agent-tools/call', { token: 'nope', sessionId: id, tool: 'ask_user', arguments: {} });
	assert.deepEqual(r, { ok: false, text: '这次调用没有通过验证' });
	await api('/api/settings', { mode: 'acceptEdits' });
});

test('thinking translated into Chinese by the model in use, once, and not when it already is', async () => {
	const id = await newSession();
	await say(id, 'hello');
	const en = 'Let me check the battery temperature first.';
	const r = await api('/api/translate', { text: en, sessionId: id });
	assert.equal(r.ok, true);
	assert.match(r.text, /^echo: 你是翻译。[\s\S]*Let me check the battery temperature first\.$/, 'the one-off question carries the instruction and the text');
	const before = runs().filter((x) => x.oneShot).length;
	assert.deepEqual(await api('/api/translate', { text: en, sessionId: id }), r, 'the same text again: from the kept translations');
	assert.equal(runs().filter((x) => x.oneShot).length, before);
	assert.deepEqual(await api('/api/translate', { text: '先看一下电池温度，然后再决定。', sessionId: id }), { ok: true, text: '先看一下电池温度，然后再决定。', same: true });
});

const hasChromium = existsSync(process.env.AGENT_CHROMIUM || '/usr/bin/google-chrome');
test('the built-in browser: the agent opens, reads, clicks and types; the owner watches it live', { skip: !hasChromium && 'no Chromium here' }, async () => {
	const { createServer: httpServer } = await import('node:http');
	const site = httpServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>Shop</title><h1>Welcome</h1><input placeholder="Search"><button onclick="document.title=\'pressed\'">Buy now</button>'); });
	await new Promise((r) => site.listen(0, '127.0.0.1', r));
	const url = `http://127.0.0.1:${site.address().port}/`;
	try {
		const id = await newSession();
		let from = events.length;
		const opened = await say(id, `tool: browser_open ${JSON.stringify({ url })}`);
		const use = opened.events.find((e) => e.type === 'tool_use');
		assert.deepEqual({ name: use.name, title: use.title, category: use.category }, { name: 'mcp__droidagent__browser_open', title: `打开 127.0.0.1`, category: '浏览器' });
		assert.ok(!opened.events.some((e) => e.type === 'permission'), "the app's own tools are not asked about");
		const text = opened.events.filter((e) => e.type === 'assistant_delta').map((e) => e.text).join('');
		assert.match(text, /标题：Shop[\s\S]*Welcome[\s\S]*\[1\] 输入框 Search[\s\S]*\[2\] 按钮 Buy now/);
		assert.deepEqual(opened.result.sources, [{ title: 'Shop', url }]);
		assert.ok(events.slice(from).some((e) => e.type === 'browser' && e.running && e.url === url), 'the page hears where the browser is');
		const clicked = await say(id, 'tool: browser_click {"text":"buy now"}');
		assert.match(clicked.events.filter((e) => e.type === 'assistant_delta').map((e) => e.text).join(''), /已点击「Buy now」[\s\S]*标题：pressed/);
		const shot = await say(id, 'tool: browser_screenshot {}');
		assert.match(shot.events.filter((e) => e.type === 'assistant_delta').map((e) => e.text).join(''), /\[1 image\]/);
		// The owner's view: a multipart stream of JPEG frames.
		const ctl = new AbortController();
		const res = await fetch(base + '/api/browser/stream', { signal: ctl.signal });
		assert.match(res.headers.get('content-type'), /multipart\/x-mixed-replace/);
		const reader = res.body.getReader();
		let got = Buffer.alloc(0);
		while (got.indexOf(Buffer.from([0xff, 0xd8])) < 0) { const { value } = await reader.read(); got = Buffer.concat([got, Buffer.from(value)]); }
		ctl.abort();
		// And the owner's taps and typing reach it.
		assert.deepEqual(await api('/api/browser/input', { type: 'navigate', url: url + '?q=1' }), { ok: true });
		assert.equal((await api('/api/browser')).url, url + '?q=1');
		from = events.length;
	} finally {
		await api('/api/browser/stop', {});
		site.close();
	}
});
