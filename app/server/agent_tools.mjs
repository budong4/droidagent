#!/usr/bin/env node
// DroidAgent's own tools for the agents, as an MCP server on stdio (one JSON-RPC message per line).
// Each conversation's agent starts one; every call is handed to the app's server, which owns the
// state (the question sheet, the built-in browser) and the owner's screen.
//
//   ask_user      the assistant asks the owner something, with choices (Antigravity; Claude has
//                 its own AskUserQuestion)
//   browser_*     the built-in browser, which the owner can watch and take over in the app
//
// Environment, set by the server: DROIDAGENT_TOOLS_URL, DROIDAGENT_TOOLS_TOKEN,
// DROIDAGENT_SESSION (the conversation), DROIDAGENT_TOOLS (which tools: "ask,browser").
import { request } from 'node:http';
import { createInterface } from 'node:readline';

const URL_BASE = process.env.DROIDAGENT_TOOLS_URL || 'http://127.0.0.1:8787';
const TOKEN = process.env.DROIDAGENT_TOOLS_TOKEN || '';
const SESSION = process.env.DROIDAGENT_SESSION || '';
const WANT = new Set(String(process.env.DROIDAGENT_TOOLS || 'ask,browser').split(',').map((s) => s.trim()));

const ASK = [{
	name: 'ask_user',
	description: '向用户提问并给出选项，等用户在 App 里选择后返回答案。需要用户做决定、信息不够、或者有几种做法要用户挑时用它，不要在回复里列选项让用户打字。每个问题 2–4 个选项，用户也可以自己填写别的答案。',
	inputSchema: {
		type: 'object',
		properties: {
			questions: {
				type: 'array', minItems: 1, maxItems: 4,
				items: {
					type: 'object',
					properties: {
						question: { type: 'string', description: '完整的问题，以问号结尾' },
						header: { type: 'string', description: '很短的标签（12 字以内），例如「清理范围」' },
						options: {
							type: 'array', minItems: 2, maxItems: 4,
							items: { type: 'object', properties: { label: { type: 'string', description: '选项，1–5 个词' }, description: { type: 'string', description: '这个选项意味着什么' } }, required: ['label'] },
						},
						multiSelect: { type: 'boolean', description: '可以多选时为 true' },
					},
					required: ['question', 'options'],
				},
			},
		},
		required: ['questions'],
	},
}];

export const BROWSER = [
	{ name: 'browser_open', description: '在内置浏览器里打开网址（用户能在 App 里实时看到这个浏览器）。返回页面标题和可读文本摘要。', inputSchema: { type: 'object', properties: { url: { type: 'string', description: '完整网址，含 https://' } }, required: ['url'] } },
	{ name: 'browser_read', description: '读取内置浏览器当前页面：标题、网址、正文文本，以及带编号的可点击元素和输入框（编号用于 browser_click / browser_type）。', inputSchema: { type: 'object', properties: { full: { type: 'boolean', description: '为 true 时返回更长的正文' } } } },
	{ name: 'browser_click', description: '点击当前页面上的一个元素：用 browser_read 给出的编号 ref，或者元素上的文字 text。', inputSchema: { type: 'object', properties: { ref: { type: 'number' }, text: { type: 'string' } } } },
	{ name: 'browser_type', description: '在输入框里填写文字：用 browser_read 给出的编号 ref。submit 为 true 时填完按回车。', inputSchema: { type: 'object', properties: { ref: { type: 'number' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['text'] } },
	{ name: 'browser_scroll', description: '上下滚动当前页面。', inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['down', 'up'] } } } },
	{ name: 'browser_back', description: '返回上一页。', inputSchema: { type: 'object', properties: {} } },
	{ name: 'browser_screenshot', description: '截取内置浏览器当前画面，返回图片。看排版、图片或读不出文字的内容时用。', inputSchema: { type: 'object', properties: {} } },
];

export const TOOLS = [...(WANT.has('ask') ? ASK : []), ...(WANT.has('browser') ? BROWSER : [])];

function callServer(tool, args) {
	return new Promise((resolve) => {
		const body = JSON.stringify({ token: TOKEN, sessionId: SESSION, tool, arguments: args || {} });
		const u = new URL('/api/agent-tools/call', URL_BASE);
		const req = request({
			host: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST',
			headers: { host: u.host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
		}, (res) => {
			let text = '';
			res.setEncoding('utf8');
			res.on('data', (d) => { text += d; });
			res.on('end', () => { try { resolve(JSON.parse(text)); } catch { resolve({ ok: false, text: `DroidAgent 的回应无法解析（HTTP ${res.statusCode}）` }); } });
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
	if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return msg && msg.id != null ? fail(-32600, 'invalid request') : null;
	if (msg.id == null) return null;
	switch (msg.method) {
		case 'initialize':
			return reply({ protocolVersion: msg.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'droidagent', version: '2' } });
		case 'ping': return reply({});
		case 'tools/list': return reply({ tools: TOOLS });
		case 'tools/call': {
			const name = msg.params?.name;
			if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `unknown tool: ${name}`);
			const r = await call(name, msg.params?.arguments || {});
			const content = [{ type: 'text', text: String(r?.text ?? '') || (r?.ok ? '（完成）' : '失败') }];
			if (r?.image) content.push({ type: 'image', data: r.image, mimeType: r.mimeType || 'image/jpeg' });
			return reply({ content, isError: !r?.ok });
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
	rl.on('close', () => { closing = true; if (!open) process.exit(0); });
}
