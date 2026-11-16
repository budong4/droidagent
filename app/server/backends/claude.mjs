// The Claude backend: official Claude Code, driven through the Agent SDK. See common.mjs for
// what a backend hands the server.
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export function getSdkModel(m) {
	if (!m) return 'sonnet';
	const lower = String(m).toLowerCase();
	if (lower.startsWith('opus')) return 'opus';
	if (lower.startsWith('sonnet')) return 'sonnet';
	if (lower.startsWith('haiku')) return 'haiku';
	if (lower.startsWith('fable')) return 'fable';
	return lower;
}

// Older models take a fixed budget instead of adaptive thinking.
export function thinkingFor(model) {
	const m = String(model || '');
	if (/haiku-4|sonnet-4\.5|opus-4\.[015]\b/.test(m)) return { type: 'enabled', budgetTokens: 8000, display: 'summarized' };
	return { type: 'adaptive', display: 'summarized' };
}

// SDK messages -> turn events. One mapper per conversation: it remembers whether the reply and
// the thinking of the message in progress were streamed, so the whole message that follows a
// stream is not shown twice.
export function createClaudeMapper() {
	let sawDelta = false;
	let sawThinkDelta = false;
	let thinking = false;
	return function* map(m) {
		if (m.type === 'system' && m.subtype === 'init') {
			yield { type: 'init', ref: m.session_id, model: m.model };
		} else if (m.type === 'system' && m.subtype === 'commands_changed') {
			yield { type: 'commands_changed' }; // Claude Code noticed new skills by itself (new runtime only)
		} else if (m.type === 'system' && m.subtype === 'local_command_output') {
			// What a slash command such as /context or /cost printed.
			const text = String(m.content || '').trim();
			if (text) yield { type: 'command_output', text };
		} else if (m.type === 'system' && m.subtype === 'compact_boundary') {
			const md = m.compact_metadata || {};
			yield { type: 'notice', text: `对话已压缩${md.pre_tokens ? `（${Math.round(md.pre_tokens / 1000)}k${md.post_tokens ? ` → ${Math.round(md.post_tokens / 1000)}k` : ''} tokens）` : ''}` };
		} else if (m.type === 'stream_event') {
			const ev = m.event;
			if (ev?.type === 'content_block_start' && ev.content_block?.type === 'thinking') {
				thinking = true;
				yield { type: 'thinking_start' };
			} else if (ev?.type === 'content_block_stop' && thinking) {
				thinking = false;
				yield { type: 'thinking_end' };
			} else if (ev?.type === 'content_block_delta') {
				if (ev.delta?.type === 'text_delta' && ev.delta.text) {
					sawDelta = true;
					yield { type: 'text_delta', text: ev.delta.text };
				} else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
					sawThinkDelta = true;
					yield { type: 'thinking_delta', text: ev.delta.thinking };
				}
			} else if (ev?.type === 'message_stop') {
				yield { type: 'text_end' };
			}
		} else if (m.type === 'assistant') {
			for (const block of m.message?.content || []) {
				if (block.type === 'tool_use') yield { type: 'tool_use', id: block.id, name: block.name, input: block.input };
				else if (block.type === 'text' && !sawDelta && block.text) yield { type: 'text', text: block.text };
				// Not streamed (Claude Code falling back to a plain request): it arrives whole.
				else if (block.type === 'thinking' && block.thinking && !sawThinkDelta) yield { type: 'thinking', text: block.thinking };
			}
			sawDelta = false;
			sawThinkDelta = false;
		} else if (m.type === 'user') {
			for (const block of m.message?.content || []) {
				if (block.type !== 'tool_result') continue;
				const text = Array.isArray(block.content) ? block.content.map((c) => c.text || '').join('') : String(block.content ?? '');
				yield { type: 'tool_result', id: block.tool_use_id, ok: !block.is_error, text };
			}
		} else if (m.type === 'result') {
			thinking = false; // stopped mid-thought: no block_stop will come
			yield { type: 'result', ok: !m.is_error, text: m.result || '', costUsd: m.total_cost_usd || 0, durationMs: m.duration_ms || 0, subtype: m.subtype, errors: m.errors };
		}
	};
}

// ---------------------------------------------------------------- Claude Code runtime
// Current Claude Code releases are Bun-compiled native binaries (the global `claude`, and the one
// inside the Agent SDK). On some Android kernels Bun's JavaScript engine aborts while starting up
// (SIGABRT in JSC::VM::tryCreate), before Claude Code itself runs. So nothing is assumed: each
// option is started once with --version and the first that works is used, for chat and for
// `claude auth …` alike:
//   1. the native binaries as they are;
//   2. the same with JavaScriptCoreUseJIT=0, which makes JavaScriptCore skip reserving JIT memory;
//   3. Claude Code 2.1.112 on Node.js — the last release shipped as plain JavaScript — from Agent
//      SDK 0.2.112 in server/legacy-sdk (installed by the update package). Node runs fine on
//      these phones: this server is Node.
const NO_JIT = { JavaScriptCoreUseJIT: '0' };
const SDK_CLI_PKGS = {
	arm64: ['claude-agent-sdk-linux-arm64', 'claude-agent-sdk-linux-arm64-musl'],
	x64: ['claude-agent-sdk-linux-x64', 'claude-agent-sdk-linux-x64-musl'],
};
// The legacy CLI's own aliases point at the models it knew in April 2026; ask for current ones by id.
const LEGACY_MODEL_IDS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1' };

// `serverDir` is where server.mjs lives: its node_modules holds the SDK, legacy-sdk the Node one.
export function createClaudeBackend({ log, serverDir }) {
	const LEGACY_SDK = join(serverDir, 'legacy-sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');

	function nativeCandidates() {
		const out = [];
		const seen = new Set();
		const add = (label, kind, path) => {
			if (seen.has(path) || !existsSync(path)) return;
			seen.add(path);
			out.push({ label, kind, path });
		};
		for (const dir of String(process.env.PATH || '').split(':')) if (dir) add(`全局 claude（${join(dir, 'claude')}）`, 'global', join(dir, 'claude'));
		add('全局 claude（~/.local/bin）', 'global', join(homedir(), '.local', 'bin', 'claude'));
		for (const pkg of SDK_CLI_PKGS[process.arch] || []) add('SDK 内置 claude', 'sdk', join(serverDir, 'node_modules', '@anthropic-ai', pkg, 'claude'));
		return out;
	}
	function legacySpec() {
		const cli = join(LEGACY_SDK, 'cli.js');
		return existsSync(cli) ? { label: 'Node 版 claude', kind: 'legacy', cmd: [process.execPath, cli], env: {} } : null;
	}
	function run(spec, args, opts = {}) {
		return spawn(spec.cmd[0], [...spec.cmd.slice(1), ...args], { ...opts, env: { ...process.env, ANTHROPIC_API_KEY: '', ...spec.env } });
	}
	function probe(spec) {
		return new Promise((resolve) => {
			execFile(spec.cmd[0], [...spec.cmd.slice(1), '--version'], { timeout: 45000, env: { ...process.env, ANTHROPIC_API_KEY: '', ...spec.env } },
				(err, stdout, stderr) => {
					const version = String(stdout || '').trim().split('\n')[0];
					if (!err && /\d+\.\d+\.\d+/.test(version)) return resolve({ ok: true, version });
					const why = err?.signal ? `被信号 ${err.signal} 终止` : err?.killed ? '超时' : (String(stderr || '').trim().split('\n').pop() || err?.message || '无输出');
					resolve({ ok: false, error: /bun\.report|Bun has crashed/.test(String(stderr) + String(stdout)) ? `Bun 崩溃（${why}）` : why.slice(0, 160) });
				});
		});
	}

	let runtimeCache = null;
	let runtimeProbe = null;
	async function runtime() {
		if (runtimeCache) return runtimeCache;
		if (runtimeProbe) return runtimeProbe;
		runtimeProbe = (async () => {
			const tried = [];
			const working = [];
			for (const c of nativeCandidates()) {
				for (const env of [{}, NO_JIT]) {
					const spec = { label: c.label + (env === NO_JIT ? ' + 关闭 JIT' : ''), kind: c.kind, cmd: [c.path], env };
					const r = await probe(spec);
					tried.push({ label: spec.label, ok: r.ok, detail: r.ok ? r.version : r.error });
					if (r.ok) { working.push({ ...spec, version: r.version }); break; }
				}
			}
			const legacy = legacySpec();
			if (legacy) {
				const r = await probe(legacy);
				tried.push({ label: legacy.label, ok: r.ok, detail: r.ok ? r.version : r.error });
				if (r.ok) working.push({ ...legacy, version: r.version });
			}
			const chatSpec = working.find((w) => w.kind === 'sdk') || working.find((w) => w.kind === 'legacy') || working.find((w) => w.kind === 'global') || null;
			const result = {
				chat: chatSpec,
				// Log in with the same program chat uses; the credentials land in the same ~/.claude.
				auth: chatSpec,
				working,
				tried,
				allSpecs: [...nativeCandidates().map((c) => ({ label: c.label, kind: c.kind, cmd: [c.path], env: {} })), ...(legacy ? [legacy] : [])],
			};
			log('[runtime]', tried.map((t) => `${t.label}: ${t.ok ? t.detail : '✗ ' + t.detail}`).join(' | ') || 'no candidates');
			log('[runtime] chat via', chatSpec ? `${chatSpec.label}（${chatSpec.version}）` : 'NOTHING');
			if (chatSpec) runtimeCache = result; // with nothing working, look again next time
			return result;
		})();
		try { return await runtimeProbe; } finally { runtimeProbe = null; }
	}
	function noRuntimeMessage(rt) {
		const lines = (rt?.tried || []).map((t) => `${t.label}：${t.detail}`).join('；');
		return `这台手机上启动不了 Claude Code${lines ? '（' + lines + '）' : ''}。请刷入最新的 DroidAgent 更新包，它带有 Node 版运行时。`;
	}
	const sdkModules = {};
	async function loadSdk(spec) {
		if (spec.kind === 'legacy') return (sdkModules.legacy ||= await import(pathToFileURL(join(LEGACY_SDK, 'sdk.mjs')).href));
		return (sdkModules.current ||= await import('@anthropic-ai/claude-agent-sdk'));
	}
	function modelFor(spec, m) {
		const alias = getSdkModel(m);
		return spec?.kind === 'legacy' ? (LEGACY_MODEL_IDS[alias] || alias) : alias;
	}
	// How the SDK should start Claude Code for this runtime.
	function queryRuntimeOptions(spec) {
		const o = {};
		if (Object.keys(spec.env).length) o.env = { ...process.env, ...spec.env };
		if (spec.kind === 'legacy') { o.pathToClaudeCodeExecutable = spec.cmd[1]; o.executable = 'node'; }
		else o.pathToClaudeCodeExecutable = spec.cmd[0];
		return o;
	}

	// One live `query()` for one conversation. `settings` is read once, at the start: what can
	// change later goes through control (setModel, setPermissionMode), and the rest restarts it.
	// `plugins`: local plugins to load besides the installed ones (the Antigravity plugins, see shared_plugins.mjs).
	async function open({ tag, cwd, settings, resume, canUseTool, systemAppend, mcpServers, plugins }) {
		const rt = await runtime();
		if (!rt.chat) throw new Error(noRuntimeMessage(rt));
		const spec = rt.chat;
		const { query } = await loadSdk(spec);

		const queue = [];
		let wake = null;
		let ended = false;
		async function* input() {
			while (!ended) {
				if (queue.length) { yield queue.shift(); continue; }
				await new Promise((r) => { wake = r; });
			}
		}
		const send = (text) => {
			queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
			if (wake) { wake(); wake = null; }
		};
		const close = () => { ended = true; if (wake) { wake(); wake = null; } };

		const options = {
			cwd,
			model: modelFor(spec, settings.model),
			effort: settings.effort || 'xhigh',
			// Ask for the thinking text itself (summarized), not just its token count, so the app can
			// show what Claude is weighing.
			thinking: thinkingFor(settings.model),
			fastMode: !!settings.fastMode,
			permissionMode: settings.mode === 'plan' ? 'plan' : 'default',
			includePartialMessages: true,
			settingSources: ['user', 'project', 'local'],
			systemPrompt: systemAppend ? { type: 'preset', preset: 'claude_code', append: systemAppend } : { type: 'preset', preset: 'claude_code' },
			canUseTool,
			stderr: (d) => log('[claude]', `[${tag}]`, String(d).trim().slice(0, 300)),
		};
		if (mcpServers && Object.keys(mcpServers).length) options.mcpServers = mcpServers;
		if (plugins?.length) options.plugins = plugins;
		if (resume) options.resume = resume;
		Object.assign(options, queryRuntimeOptions(spec));

		const q = query({ prompt: input(), options });
		const map = createClaudeMapper();
		async function* events() {
			for await (const m of q) yield* map(m);
		}
		return { events: events(), send, close, control: q, spec };
	}

	// One question, one answer, no tools: what names a conversation.
	async function oneShot({ prompt, system, cwd, model = 'haiku', timeoutMs = 60000 }) {
		const rt = await runtime();
		if (!rt.chat) return '';
		const { query } = await loadSdk(rt.chat);
		const q = query({
			prompt,
			options: {
				cwd, model: modelFor(rt.chat, model), maxTurns: 1, tools: [], settingSources: [],
				systemPrompt: system, thinking: { type: 'disabled' },
				...queryRuntimeOptions(rt.chat),
			},
		});
		const timer = setTimeout(() => { try { Promise.resolve(q.interrupt?.()).catch(() => {}); } catch { /* gone */ } }, timeoutMs);
		let out = '';
		try { for await (const m of q) if (m.type === 'result') out = m.result || ''; } finally { clearTimeout(timer); }
		return out;
	}

	return { runtime, noRuntimeMessage, run, modelFor, open, oneShot, version: () => runtimeCache?.chat?.version || '' };
}
