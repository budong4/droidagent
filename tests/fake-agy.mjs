#!/usr/bin/env node
// Stands in for the Antigravity CLI in tests. It prints what the real one prints in headless
// mode (event shapes as recorded from agy 1.1–1.5), and, like the real one, starts the MCP
// servers in ~/.gemini/config/mcp_config.json when a prompt asks for one of their tools.
//
// What a prompt does (its last line decides, so a lead-in ahead of it does not matter):
//   "shell: <cmd>"        call the droidagent MCP tool `shell` with that command
//   "write: <path>=<txt>" call the droidagent MCP tool `write_file`
//   "native: <cmd>"       agy's own run_command — refused unless --dangerously-skip-permissions
//   "fail: <message>"     end with status ERROR
//   "hang"                never answer (until killed)
//   "/usage"              answer as the /usage command does
//   anything else         echo it back in two pieces
// FAKE_AGY_LOG: a file that gets one JSON line per run (argv, cwd, env of interest, stdin).
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (argv[0] === '--version') { console.log('agy version 1.5.9-fake'); process.exit(0); }
if (argv[0] === 'models') {
	if (process.env.FAKE_AGY_LOGGED_OUT) { console.error('Error: Please sign in'); process.exit(1); }
	process.stdout.write('gemini-4-carbon-high\tGemini 4 Carbon (High)\ngemini-3.8-flash      Gemini 3.8 Flash\nclaude-sonnet-5-5     Claude Sonnet 5.5 (Thinking)\n');
	process.exit(0);
}
if (argv[0] === 'plugin' && argv[1] === 'list') { console.log(JSON.stringify([{ name: 'demo-plugin', version: '1.0.0', description: 'a plugin' }])); process.exit(0); }
if (argv[0] === 'plugin' && argv[1] === 'install') { console.log(`installed ${argv[2]}`); process.exit(argv[2] === 'broken' ? 1 : 0); }

// Signing in the way a machine without a browser does: a link, then the code Google showed.
// FAKE_AGY_LOGIN: "old" (this build has no `acp --login`), "callback" (the link comes back to a
// listener on this machine instead of showing a code).
if (argv[0] === 'acp' || (argv.length === 0 && process.env.FAKE_AGY_LOGIN === 'old')) {
	if (argv[0] === 'acp' && process.env.FAKE_AGY_LOGIN === 'old') { console.error('Error: unknown flag: --login'); process.exit(1); }
	const { mkdirSync, writeFileSync } = await import('node:fs');
	const save = () => {
		const dir = join(process.env.HOME, '.gemini', 'antigravity-cli');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'antigravity-oauth-token'), JSON.stringify({ token: { access_token: 'new', refresh_token: 'new-r' }, auth_method: 'consumer' }));
	};
	if (process.env.FAKE_AGY_LOGIN === 'callback') {
		const { createServer } = await import('node:http');
		const srv = createServer((req, res) => {
			const u = new URL(req.url, 'http://localhost');
			if (u.searchParams.get('code') === 'good-code' && u.searchParams.get('state') === 'st1') { save(); res.end('ok'); console.log('Signed in.'); setTimeout(() => process.exit(0), 50); } else { res.statusCode = 400; res.end('bad'); }
		});
		await new Promise((r) => srv.listen(0, '127.0.0.1', r));
		console.log(`Open this link to sign in:\n\n  https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=${encodeURIComponent(`http://localhost:${srv.address().port}/oauth-callback`)}&state=st1\n\nWaiting for the browser...`);
		await new Promise(() => {});
	}
	console.log('\x1b[1mSign in with Google\x1b[0m\nOpen this link in a browser:\n\n  https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=https%3A%2F%2Fantigravity.google%2Fcode&state=st1&scope=a%20b\n');
	process.stdout.write('Paste the authorization code: ');
	const rl = createInterface({ input: process.stdin });
	const code = await new Promise((r) => rl.once('line', r));
	if (code.trim() !== '4/good-code') { console.log('\nError: invalid authorization code'); process.exit(1); }
	console.log('\nExchanging code...');
	save();
	console.log('Signed in as owner@example.com');
	process.exit(0);
}

let stdin = '';
if (argv.includes('--input-format')) {
	for await (const chunk of process.stdin) stdin += chunk;
}
const prompt = argv.includes('-p') ? flag('-p') : (() => { try { return JSON.parse(stdin.split('\n')[0]).message.content; } catch { return ''; } })();
if (process.env.FAKE_AGY_LOG) {
	appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({
		argv, cwd: process.cwd(), prompt, stdin: stdin.length,
		env: { session: process.env.DROIDAGENT_SESSION, dbus: process.env.DBUS_SESSION_BUS_ADDRESS, noUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE },
	}) + '\n');
}

const last = String(prompt || '').trim().split('\n').pop().trim();
if (last === '/usage') {
	emit({ event: 'command_result', command: { name: 'usage', data: { groups: [
		{ name: 'Gemini', description: 'Gemini quota bucket', buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: 0.75, reset_time: '2030-01-01T00:00:00Z' }, { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.4 }] },
		{ name: 'Claude and GPT', buckets: [{ id: '3p-5h', window: '5h', remaining_fraction: 0.1 }] },
	] } } });
	process.exit(0);
}
if (process.env.FAKE_AGY_LOGGED_OUT) {
	process.stderr.write('Print mode: silent auth failed\n');
	emit({ event: 'result', result: { conversation_id: '', status: 'ERROR', error: 'You are not logged into Antigravity.' } });
	process.exit(1);
}

// --output-format json: one envelope, nothing streamed.
if (flag('--output-format') === 'json') {
	console.log(JSON.stringify({ conversation_id: 'conv-json', status: 'SUCCESS', response: String(prompt).includes('起一个标题') ? '「查看电池状态」\n' : `echo: ${last}`, duration_seconds: 0.1, num_turns: 1 }));
	process.exit(0);
}

const conv = flag('--conversation') || 'conv-' + Math.abs(String(prompt).length * 2654435761 % 100000);
const model = flag('--model') || 'gemini-default';
const skip = argv.includes('--dangerously-skip-permissions');
emit({ event: 'init', conversation_id: conv, init: { model, cwd: process.cwd(), tools: ['run_command'], permission_mode: skip ? 'always-proceed' : 'request-review' } });
emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 0, state: 'DONE', step_type: 'user_input' } });
process.stdout.write('some noise that is not JSON\n');

// One call to an MCP server from mcp_config.json, the way agy makes it.
function mcpCall(server, tool, args) {
	return new Promise((resolve, reject) => {
		const cfg = JSON.parse(readFileSync(join(process.env.HOME, '.gemini', 'config', 'mcp_config.json'), 'utf8')).mcpServers[server];
		const child = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'inherit'] });
		const rl = createInterface({ input: child.stdout });
		const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
		rl.on('line', (line) => {
			const m = JSON.parse(line);
			if (m.id === 1) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }); }
			if (m.id === 2) { child.stdin.end(); resolve(m.result || { isError: true, content: [{ text: m.error?.message }] }); }
		});
		child.on('error', reject);
		send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fake-agy', version: '0' } } });
	});
}
async function mcpStep(index, tool, args) {
	const info = { name: 'call_mcp_tool', parameters: { ServerName: 'droidagent', ToolName: tool, Arguments: args } };
	emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: index, state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: info } });
	const r = await mcpCall('droidagent', tool, args);
	const text = r.content?.[0]?.text || '';
	emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: index, state: r.isError ? 'ERROR' : 'DONE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { ...info, ...(r.isError ? { error: { type: 'TOOL_ERROR', message: text } } : { output: text }) } } });
	return text;
}
const say = async (index, parts) => {
	for (let i = 0; i < parts.length; i++) {
		emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: index, state: i === parts.length - 1 ? 'DONE' : 'ACTIVE', step_type: 'agent_response', text_delta: parts[i] } });
		await sleep(5);
	}
};
// Leave only once everything written has gone down the pipe.
const leave = (code) => new Promise(() => process.stdout.write('', () => process.exit(code)));
const finish = async (response, extra = {}) => {
	emit({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS', response, duration_seconds: 0.1, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 }, ...extra } });
	await leave(0);
};

if (last === 'hang') {
	await say(1, ['working', ' on it']);
	process.on('SIGTERM', () => process.exit(143));
	await new Promise(() => {});
} else if (last.startsWith('fail: ')) {
	emit({ event: 'result', result: { conversation_id: conv, status: 'ERROR', response: '', error: last.slice(6), duration_seconds: 0.1 } });
	await leave(1);
} else if (last.startsWith('shell: ')) {
	await say(1, ['Let me run that.']);
	const out = await mcpStep(2, 'shell', { command: last.slice(7), description: '运行测试命令' });
	await say(3, ['It said: ', out]);
	await finish(`It said: ${out}`);
} else if (last.startsWith('write: ')) {
	const [path, ...rest] = last.slice(7).split('=');
	const out = await mcpStep(1, 'write_file', { path, content: rest.join('=') });
	await say(2, [out]);
	await finish(out);
} else if (last.startsWith('native: ')) {
	const info = { name: 'run_command', parameters: { CommandLine: last.slice(8) } };
	emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: info } });
	if (skip) {
		emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { ...info, output: 'ran natively' } } });
		await say(2, ['done']);
		await finish('done');
	}
	emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { ...info, error: { type: 'TOOL_ERROR', message: 'Permission denied automatically in headless mode: run_command' } } } });
	await finish(''); // agy reports SUCCESS with no text when its only step was refused
} else {
	await say(1, [`echo(${model}): `, last]);
	await finish(`echo(${model}): ${last}`);
}
