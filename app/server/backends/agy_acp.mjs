// An Antigravity conversation, run through the official CLI's Agent Client Protocol server
// (`agy acp`: JSON-RPC 2.0, one message per line on stdin/stdout, ACP version 1). One process per
// conversation, kept between turns like Claude Code's.
//
// Unlike headless `agy -p`, ACP streams the model's thoughts (agent_thought_chunk) and asks before
// a step that needs approval (session/request_permission), so the app's own policy and
// confirmation cards decide every step, the same as for Claude.
//
// Protocol: https://agentclientprotocol.com. What agy itself fills in (which config options, which
// permission options) is read from its answers, never assumed.
import { spawn } from 'node:child_process';
import { channel } from './common.mjs';

export const ACP_VERSION = 1;

// The app's thinking levels, as agy names its own (documented: Low, Medium, High, Extra, Max).
const LEVEL_WORDS = { low: ['low'], medium: ['medium', 'med'], high: ['high'], xhigh: ['extra', 'xhigh', 'extra high', 'extra-high'], max: ['max', 'maximum'] };

// The options of a select config option, flat, whether agy groups them or not.
export const flatOptions = (opt) => (Array.isArray(opt?.options) ? opt.options.flatMap((o) => (Array.isArray(o?.options) ? o.options : [o])) : []).filter((o) => o && o.value != null);

// The config option of a category ('model', 'thought_level', 'mode'), by category or else by its id.
export function configOption(options, category) {
	const list = Array.isArray(options) ? options : [];
	return list.find((o) => o?.category === category) || list.find((o) => String(o?.id || '').toLowerCase().replace(/[^a-z]/g, '').includes(category.replace(/_/g, '')))
		|| (category === 'thought_level' ? list.find((o) => /think|effort|reason/i.test(`${o?.id} ${o?.name}`)) : null) || null;
}
// Which value of the model option is the model the owner picked: the same id, else the same
// name, else one whose id or name contains the other (agy's ids may carry a suffix).
export function pickModelValue(opt, slug, name) {
	const all = flatOptions(opt);
	const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9.]+/g, '');
	const want = norm(slug);
	const wantName = norm(name);
	return (all.find((o) => norm(o.value) === want) || all.find((o) => wantName && norm(o.name) === wantName)
		|| all.find((o) => want && (norm(o.value).includes(want) || want.includes(norm(o.value))))
		|| all.find((o) => wantName && norm(o.name).includes(wantName)))?.value ?? null;
}
export function pickLevelValue(opt, effort) {
	const words = LEVEL_WORDS[effort] || [];
	const all = flatOptions(opt);
	const norm = (s) => String(s || '').toLowerCase().trim();
	return (all.find((o) => words.includes(norm(o.value))) || all.find((o) => words.includes(norm(o.name)))
		|| all.find((o) => words.some((w) => norm(o.name).startsWith(w))))?.value ?? null;
}
// agy's thinking levels for a model, as the app's names: what the picker shows.
export function levelsOf(opt) {
	const out = [];
	for (const o of flatOptions(opt)) {
		const v = `${o.value} ${o.name}`.toLowerCase();
		const id = Object.keys(LEVEL_WORDS).find((k) => LEVEL_WORDS[k].some((w) => new RegExp(`(^|\\W)${w}(\\W|$)`).test(v)));
		if (id && !out.includes(id)) out.push(id);
	}
	return out;
}

// The text in a content block (or a list of them, as tool results carry).
export function contentText(c) {
	if (c == null) return '';
	if (typeof c === 'string') return c;
	if (Array.isArray(c)) return c.map(contentText).filter(Boolean).join('\n');
	if (c.type === 'text') return String(c.text ?? '');
	if (c.type === 'content') return contentText(c.content);
	if (c.type === 'diff') return `${c.path || ''}\n${c.newText ?? ''}`.trim();
	if (c.type === 'resource') return String(c.resource?.text ?? '');
	if (c.type === 'resource_link') return String(c.uri ?? '');
	return '';
}
const PLAN_STATUS = { pending: 'pending', in_progress: 'in_progress', completed: 'completed' };

// A step as the cards and the policy know steps: Claude Code's tool names and arguments.
// `normalize(name, rawInput)` is agy's own tool-name mapping (antigravity.mjs).
export function toolOf(tc, normalize) {
	const raw = tc?.rawInput && typeof tc.rawInput === 'object' ? tc.rawInput : {};
	const path = tc?.locations?.[0]?.path || '';
	if (tc?.name) {
		const t = normalize(tc.name, raw);
		if (t.name !== tc.name) return withPath(t, path);
	}
	const t = normalize(guessName(tc?.kind, raw), raw);
	if (t.name !== 'tool' && t.name !== guessName(tc?.kind, raw)) return withPath(t, path);
	switch (tc?.kind) {
		case 'execute': return { name: 'Bash', input: { command: String(raw.CommandLine ?? raw.command ?? raw.cmd ?? tc.title ?? ''), description: raw.Description } };
		case 'edit': return { name: 'Edit', input: { file_path: path || String(raw.TargetFile ?? raw.path ?? '') } };
		// Deleting asks as a command that deletes would.
		case 'delete': return { name: 'Bash', input: { command: `rm -rf ${path || raw.path || ''}`.trim(), description: tc.title } };
		case 'move': return { name: 'Bash', input: { command: `mv ${raw.from ?? raw.source ?? path} ${raw.to ?? raw.destination ?? ''}`.trim(), description: tc.title } };
		case 'read': return { name: 'Read', input: { file_path: path || String(raw.AbsolutePath ?? raw.path ?? '') } };
		case 'search': return { name: 'Grep', input: { pattern: String(raw.Query ?? raw.Pattern ?? raw.query ?? tc.title ?? ''), path } };
		case 'fetch': return { name: 'WebFetch', input: { url: String(raw.Url ?? raw.url ?? tc.title ?? '') } };
		case 'switch_mode': return { name: 'ExitPlanMode', input: { plan: String(raw.plan ?? raw.Plan ?? tc.title ?? '') } };
		default: return { name: tc?.name || 'tool', input: { ...raw, ...(tc?.title ? { title: tc.title } : {}) } };
	}
}
const guessName = (kind, raw) => (raw.CommandLine ? 'run_command' : raw.ServerName && raw.ToolName ? 'call_mcp_tool' : kind === 'edit' && raw.CodeContent != null ? 'write_to_file' : kind || 'tool');
const withPath = (t, path) => (path && t.input && 'file_path' in t.input && !t.input.file_path ? { ...t, input: { ...t.input, file_path: path } } : t);

// ---------------------------------------------------------------- one conversation

// `spawnSpec`: { bin, args, env }. `settings` is the live object (model, effort, mode), read at
// every turn. `canUseTool(name, input)` is the app's policy and cards, as for Claude:
// resolves { behavior: 'allow' | 'deny', interrupt? }.
export function openAcp({ spawnSpec, cwd, tag, log, settings, conversation = null, systemPrompt, prepareTurn, canUseTool, normalize, modelSlug, errorText }) {
	const ch = channel();
	let child = null;
	let buf = '';
	let nextId = 1;
	const calls = new Map(); // our requests in flight: id -> { resolve, reject, method }
	let sessionId = conversation;
	let caps = {};
	let configOptions = [];
	let commands = [];
	let ready = null; // the process started, initialized, and the session open
	let closed = false;
	let turn = null; // { started, stopping, sawThought, textOpen, thinkingOpen, messageId, tools: Map }
	let tail = Promise.resolve();
	let stderr = '';
	let leadSent = false;

	const write = (msg) => { try { child?.stdin.write(JSON.stringify(msg) + '\n'); } catch { /* gone */ } };
	const request = (method, params) => new Promise((resolve, reject) => {
		const id = nextId++;
		calls.set(id, { resolve, reject, method });
		write({ jsonrpc: '2.0', id, method, params });
	});
	const notify = (method, params) => write({ jsonrpc: '2.0', method, params });
	const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
	const replyError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

	// ---- what agy says during a turn
	const closeThinking = () => { if (turn?.thinkingOpen) { turn.thinkingOpen = false; ch.push({ type: 'thinking_end' }); } };
	const closeText = () => { if (turn?.textOpen) { turn.textOpen = false; ch.push({ type: 'text_end' }); } };
	function onUpdate(u) {
		if (!u || typeof u !== 'object') return;
		const kind = u.sessionUpdate;
		if (kind === 'available_commands_update') {
			commands = Array.isArray(u.availableCommands) ? u.availableCommands.filter((c) => c?.name).map((c) => ({ name: String(c.name), description: String(c.description || ''), argumentHint: String(c.input?.hint || '') })) : [];
			ch.push({ type: 'commands_changed' });
			return;
		}
		if (kind === 'config_option_update') { if (Array.isArray(u.configOptions)) configOptions = u.configOptions; return; }
		if (!turn) return; // a replayed history, or something between turns: nothing to show
		if (kind === 'agent_thought_chunk') {
			const t = contentText(u.content);
			if (!t) return;
			closeText();
			if (!turn.thinkingOpen) { turn.thinkingOpen = true; turn.sawThought = true; ch.push({ type: 'thinking_start' }); }
			ch.push({ type: 'thinking_delta', text: t });
		} else if (kind === 'agent_message_chunk') {
			const t = contentText(u.content);
			if (!t) return;
			closeThinking();
			// A new message id is a new message.
			if (turn.textOpen && u.messageId && turn.messageId && u.messageId !== turn.messageId) closeText();
			turn.messageId = u.messageId || turn.messageId;
			turn.textOpen = true;
			turn.text += t;
			ch.push({ type: 'text_delta', text: t });
		} else if (kind === 'tool_call' || kind === 'tool_call_update') {
			onTool(u);
		} else if (kind === 'plan') {
			// agy's plan as the app's checklist.
			closeThinking(); closeText();
			const todos = (Array.isArray(u.entries) ? u.entries : []).map((e) => ({ content: String(e?.content || ''), activeForm: String(e?.content || ''), status: PLAN_STATUS[e?.status] || 'pending' }));
			const id = `plan-${turn.key}-${++turn.plans}`;
			ch.push({ type: 'tool_use', id, name: 'TodoWrite', input: { todos } });
			ch.push({ type: 'tool_result', id, ok: true, text: '' });
		} else if (kind === 'usage_update') {
			turn.usage = { used: u.used, size: u.size };
		}
	}
	function onTool(u) {
		const id = String(u.toolCallId || '');
		if (!id) return;
		let t = turn.tools.get(id);
		if (!t) {
			if (u.kind === 'think') return; // a thought, not a step
			closeThinking(); closeText();
			const tool = toolOf(u, normalize);
			t = { done: false, title: u.title, tool };
			turn.tools.set(id, t);
			ch.push({ type: 'tool_use', id, name: tool.name, input: tool.input });
		}
		const status = u.status;
		if (!t.done && (status === 'completed' || status === 'failed')) {
			t.done = true;
			const out = contentText(u.content) || (u.rawOutput == null ? '' : typeof u.rawOutput === 'string' ? u.rawOutput : JSON.stringify(u.rawOutput));
			ch.push({ type: 'tool_result', id, ok: status === 'completed', text: out || (status === 'failed' ? '这一步失败了' : '') });
		}
	}

	// ---- agy asking: permission, and anything else (we offer no files or terminals of our own)
	async function onRequest(msg) {
		if (msg.method === 'session/request_permission') {
			const p = msg.params || {};
			const options = Array.isArray(p.options) ? p.options : [];
			const pick = (...kinds) => options.find((o) => kinds.includes(o?.kind))?.optionId;
			if (!turn || turn.stopping) return reply(msg.id, { outcome: { outcome: 'cancelled' } });
			// What it wants to do, as a card: the same policy as every other step.
			const known = turn.tools.get(String(p.toolCall?.toolCallId || ''));
			const tool = known?.tool || toolOf(p.toolCall || {}, normalize);
			if (!known && p.toolCall?.toolCallId) onTool({ ...p.toolCall, status: undefined });
			let d;
			try { d = await canUseTool(tool.name, tool.input); } catch (e) { d = { behavior: 'deny', message: String(e?.message || e) }; }
			if (!turn || turn.stopping) return reply(msg.id, { outcome: { outcome: 'cancelled' } });
			if (d.behavior === 'allow') {
				const optionId = pick('allow_once') || pick('allow_always');
				return reply(msg.id, optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } });
			}
			if (d.interrupt) interrupt();
			const optionId = pick('reject_once') || pick('reject_always');
			return reply(msg.id, optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } });
		}
		replyError(msg.id, -32601, `DroidAgent does not offer ${msg.method}`);
	}

	function onLine(line) {
		let msg;
		try { msg = JSON.parse(line); } catch { return; }
		if (!msg || typeof msg !== 'object') return;
		if (msg.id != null && (msg.result !== undefined || msg.error !== undefined) && calls.has(msg.id)) {
			const c = calls.get(msg.id);
			calls.delete(msg.id);
			if (msg.error) { const e = new Error(String(msg.error.message || 'error')); e.code = msg.error.code; e.data = msg.error.data; c.reject(e); } else c.resolve(msg.result);
		} else if (msg.method === 'session/update') {
			onUpdate(msg.params?.update);
		} else if (msg.method && msg.id != null) {
			onRequest(msg).catch((e) => replyError(msg.id, -32603, String(e?.message || e)));
		}
	}

	function start() {
		if (ready) return ready;
		ready = (async () => {
			child = spawn(spawnSpec.bin, spawnSpec.args, { cwd, env: spawnSpec.env, stdio: ['pipe', 'pipe', 'pipe'] });
			const me = child;
			me.stdin.on('error', () => {});
			me.stdout.on('data', (d) => {
				buf += d.toString('utf8');
				let i;
				while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) onLine(l); }
			});
			me.stderr.on('data', (d) => {
				const s = d.toString('utf8');
				stderr = (stderr + s).slice(-4096);
				for (const l of s.split('\n')) if (l.trim()) log('[agy]', `[${tag}]`, l.trim().slice(0, 300));
			});
			const gone = new Promise((_, reject) => {
				me.on('error', (e) => reject(Object.assign(new Error(`启动不了 Antigravity CLI：${e.message}`), { code: 'spawn' })));
				me.on('close', (code, signal) => {
					const e = Object.assign(new Error(`Antigravity CLI 退出了（${signal || code}）`), { code: 'exit', stderr });
					for (const [, c] of calls) c.reject(e);
					calls.clear();
					if (child === me) child = null;
					reject(e);
					if (!closed) { ready = null; } // the next message starts it again
				});
			});
			gone.catch(() => {});
			const init = await Promise.race([request('initialize', {
				protocolVersion: ACP_VERSION,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
				clientInfo: { name: 'droidagent', title: 'DroidAgent', version: '1' },
			}), gone]);
			caps = init?.agentCapabilities || {};
			const sysCap = !!caps.sessionCapabilities?.systemPrompt;
			const sys = sysCap && systemPrompt ? { systemPrompt: systemPrompt() } : {};
			let opened = null;
			if (sessionId && caps.sessionCapabilities?.resume) {
				opened = await Promise.race([request('session/resume', { sessionId, cwd, mcpServers: [], ...sys }), gone]).catch((e) => { log('[agy]', `[${tag}]`, 'resume failed:', e.message); return null; });
			} else if (sessionId && caps.loadSession) {
				// Load replays the whole history as updates; with no turn under way they are not shown.
				opened = await Promise.race([request('session/load', { sessionId, cwd, mcpServers: [], ...sys }), gone]).catch((e) => { log('[agy]', `[${tag}]`, 'load failed:', e.message); return null; });
			}
			let fresh = false;
			if (!opened) {
				if (sessionId) ch.push({ type: 'notice', text: 'Antigravity 没能接上之前的这段对话，接下来它会从头开始。上面的记录都还在。' });
				opened = await Promise.race([request('session/new', { cwd, mcpServers: [], ...sys }), gone]);
				sessionId = opened?.sessionId;
				fresh = true;
				leadSent = false; // a new session knows nothing yet
				if (!sessionId) throw new Error('Antigravity 没有给出会话编号');
			}
			if (Array.isArray(opened.configOptions)) configOptions = opened.configOptions;
			ch.push({ type: 'init', ref: sessionId, model: null, fresh, systemPromptTaken: sysCap });
			return { gone, fresh, sysCap };
		})();
		ready.catch(() => { ready = null; });
		return ready;
	}

	// The model and thinking level of the moment, set before each turn (cheap when unchanged).
	async function applySettings() {
		const model = configOption(configOptions, 'model');
		const slug = modelSlug(settings.model);
		if (model && slug) {
			const v = pickModelValue(model, slug, settings.modelName);
			if (v != null && v !== model.currentValue) {
				const r = await request('session/set_config_option', { sessionId, configId: model.id, value: v }).catch((e) => { log('[agy]', `[${tag}]`, 'model:', e.message); return null; });
				if (Array.isArray(r?.configOptions)) configOptions = r.configOptions;
			} else if (v == null) log('[agy]', `[${tag}]`, `model ${slug} is not among agy's choices:`, flatOptions(model).map((o) => o.value).join(', '));
		}
		const level = configOption(configOptions, 'thought_level');
		if (level && settings.effort) {
			const v = pickLevelValue(level, settings.effort);
			if (v != null && v !== level.currentValue) {
				const r = await request('session/set_config_option', { sessionId, configId: level.id, value: v }).catch((e) => { log('[agy]', `[${tag}]`, 'thinking level:', e.message); return null; });
				if (Array.isArray(r?.configOptions)) configOptions = r.configOptions;
			}
		}
	}

	function runTurn(text) {
		return (async () => {
			const t = { key: Math.random().toString(36).slice(2, 8), started: Date.now(), stopping: false, sawThought: false, textOpen: false, thinkingOpen: false, messageId: null, tools: new Map(), plans: 0, text: '' };
			turn = t;
			let stopReason = null;
			let failure = null;
			try {
				await prepareTurn?.().catch((e) => log('[agy]', `[${tag}]`, 'prepare:', e?.message));
				const { gone, fresh, sysCap } = await start();
				await applySettings();
				if (t.stopping) throw Object.assign(new Error('stopped'), { code: 'stopped' });
				// The lead-in goes with the first message of a new session only.
				const lead = fresh && !leadSent && !sysCap && systemPrompt ? `${systemPrompt()}\n\n---\n\n【用户的消息】\n` : '';
				leadSent = true;
				log('[agy]', `[${tag}]`, 'turn', fresh ? '(new session)' : `(session ${String(sessionId).slice(0, 8)})`, `model=${modelSlug(settings.model) || 'default'}`, `effort=${settings.effort}`);
				const r = await Promise.race([request('session/prompt', { sessionId, prompt: [{ type: 'text', text: lead + text }] }), gone]);
				stopReason = r?.stopReason || 'end_turn';
			} catch (e) {
				failure = e;
			}
			closeThinking(); closeText();
			// Steps it never finished: closed here, so no card spins for ever.
			for (const [id, s] of t.tools) if (!s.done) { s.done = true; ch.push({ type: 'tool_result', id, ok: false, text: t.stopping ? '已停止' : '没有完成' }); }
			const durationMs = Date.now() - t.started;
			turn = null;
			if (t.stopping || stopReason === 'cancelled' || failure?.code === 'stopped') {
				ch.push({ type: 'result', ok: false, text: '', subtype: 'interrupted', errors: [], costUsd: 0, durationMs });
			} else if (failure) {
				const err = errorText(failure.message, `${failure.stderr || stderr}\n${failure.data ? JSON.stringify(failure.data) : ''}`, failure.code);
				ch.push({ type: 'result', ok: false, text: '', subtype: 'error', errors: [err.text], code: err.code, costUsd: 0, durationMs });
			} else {
				const ok = stopReason === 'end_turn';
				const why = { max_tokens: '回答太长，被截断了', max_turn_requests: '这一轮的步骤太多，停下了', refusal: '模型拒绝回答这个请求' }[stopReason];
				ch.push({ type: 'result', ok, text: t.text, subtype: ok ? 'success' : 'error', errors: why ? [why] : [], costUsd: 0, durationMs });
			}
		})().catch((e) => {
			log('[agy]', `[${tag}]`, 'turn failed:', e?.stack || e);
			turn = null;
			ch.push({ type: 'result', ok: false, text: '', subtype: 'error', errors: [String(e?.message || e)], costUsd: 0, durationMs: 0 });
		});
	}

	function interrupt() {
		if (!turn) return;
		turn.stopping = true;
		if (sessionId && child) notify('session/cancel', { sessionId });
	}

	return {
		events: ch,
		send(text) { tail = tail.then(() => (closed ? null : runTurn(text))); },
		close() {
			closed = true;
			ch.end();
			interrupt();
			const c = child;
			if (c) {
				try { c.stdin.end(); } catch { /* gone */ }
				setTimeout(() => { try { c.kill('SIGTERM'); } catch { /* gone */ } }, 1500).unref?.();
				setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, 5000).unref?.();
			}
		},
		control: {
			interrupt,
			supportedCommands: async () => commands,
			// What agy offers this session: its models and each one's thinking levels, for the picker.
			options: () => configOptions,
		},
		spec: { label: 'Antigravity CLI（ACP）', kind: 'agy', cmd: [spawnSpec.bin, ...spawnSpec.args], env: {} },
	};
}
