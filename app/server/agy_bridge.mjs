#!/usr/bin/env node
// DroidAgent's tools, offered to the Antigravity CLI over MCP (stdio, one JSON-RPC message per
// line). agy starts this as a child; every call is handed to the app's own server, which puts
// it through the same policy and confirmation cards as a step taken by Claude — the one way a
// headless agy run can ask the owner before it acts.
//
// Environment: DROIDAGENT_BRIDGE_URL and DROIDAGENT_BRIDGE_TOKEN (from agy's mcp_config.json,
// written by the server), DROIDAGENT_SESSION (the conversation, inherited from the agy process).
// Nothing here runs a command itself.
import { request } from 'node:http';
import { createInterface } from 'node:readline';

const URL_BASE = process.env.DROIDAGENT_BRIDGE_URL || 'http://127.0.0.1:8787';
const TOKEN = process.env.DROIDAGENT_BRIDGE_TOKEN || '';
const SESSION = process.env.DROIDAGENT_SESSION || '';

export const TOOLS = [
	{
		name: 'shell',
		description: '在手机的 Linux 环境（真 root）里执行一条 shell 命令并返回输出。执行命令、操作手机（ashell、droid、pdata 等）都用它：它会按用户选择的执行模式自动放行或先请用户确认。',
		inputSchema: {
			type: 'object',
			properties: {
				command: { type: 'string', description: '要执行的命令（bash）' },
				description: { type: 'string', description: '用简体中文写一句十个字左右的话，说明这一步在做什么，例如「查看电池温度」' },
				timeout_ms: { type: 'number', description: '最长运行多久，毫秒。默认 120000，最大 1800000' },
			},
			required: ['command'],
		},
	},
	{
		name: 'write_file',
		description: '把内容写进一个文件（新建或整个覆盖）。写手机上的文件用它：它会按用户选择的执行模式自动放行或先请用户确认。',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: '文件的绝对路径' },
				content: { type: 'string', description: '文件的完整内容' },
			},
			required: ['path', 'content'],
		},
	},
	{
		name: 'remember',
		description: '往跨对话保留的经验笔记里加一条（不需要用户确认）。查过或试过才弄清的用法、报错的原因和解决办法、这台手机的特殊之处、用户说过的偏好，都记一条。',
		inputSchema: {
			type: 'object',
			properties: { note: { type: 'string', description: '一句话，写清什么情况下怎么做' } },
			required: ['note'],
		},
	},
];

function callServer(tool, args) {
	return new Promise((resolve) => {
		const body = JSON.stringify({ token: TOKEN, sessionId: SESSION, tool, arguments: args || {} });
		const u = new URL('/api/agy-bridge/call', URL_BASE);
		const req = request({
			host: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST',
			headers: { host: u.host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
		}, (res) => {
			let text = '';
			res.setEncoding('utf8');
			res.on('data', (d) => { text += d; });
			res.on('end', () => {
				try { resolve(JSON.parse(text)); } catch { resolve({ ok: false, text: `DroidAgent 的回应无法解析（HTTP ${res.statusCode}）` }); }
			});
			res.on('error', (e) => resolve({ ok: false, text: `和 DroidAgent 的连接断了：${e.message}` }));
		});
		req.on('error', (e) => resolve({ ok: false, text: `连不上 DroidAgent：${e.message}` }));
		req.end(body);
	});
}

// One JSON-RPC message in, at most one out.
export async function handle(msg, call = callServer) {
	const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
	const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
	if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return msg && msg.id != null ? fail(-32600, 'invalid request') : null;
	if (msg.id == null) return null; // a notification: nothing to say
	switch (msg.method) {
		case 'initialize':
			return reply({
				protocolVersion: msg.params?.protocolVersion || '2024-11-05',
				capabilities: { tools: {} },
				serverInfo: { name: 'droidagent', version: '1' },
			});
		case 'ping': return reply({});
		case 'tools/list': return reply({ tools: TOOLS });
		case 'tools/call': {
			const name = msg.params?.name;
			if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `unknown tool: ${name}`);
			const r = await call(name, msg.params?.arguments || {});
			return reply({ content: [{ type: 'text', text: String(r?.text ?? '') || (r?.ok ? '（没有输出）' : '失败') }], isError: !r?.ok });
		}
		case 'resources/list': return reply({ resources: [] });
		case 'prompts/list': return reply({ prompts: [] });
		default: return fail(-32601, `method not found: ${msg.method}`);
	}
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
	const out = (o) => { if (o) process.stdout.write(JSON.stringify(o) + '\n'); };
	let open = 0;
	let closing = false;
	rl.on('line', (line) => {
		const s = line.trim();
		if (!s) return;
		let msg;
		try { msg = JSON.parse(s); } catch { return out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
		open++;
		handle(msg).then(out, (e) => out({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: String(e?.message || e) } }))
			.finally(() => { open--; if (closing && !open) process.exit(0); });
	});
	// agy closing the pipe ends us, once what is under way has been answered.
	rl.on('close', () => { closing = true; if (!open) process.exit(0); });
}
