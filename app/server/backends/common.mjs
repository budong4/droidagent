// What a conversation needs from whatever answers it. Two backends exist: Claude Code (driven
// through the Agent SDK) and Google's Antigravity CLI (`agy`, one headless run per turn). Both
// hand the server the same thing, so sessions, queues, confirmation cards and the page never
// have to know which one is talking.
//
// A backend's open() resolves to a handle:
//   events    async iterable of turn events (below); it ends when the conversation is let go
//   send(t)   one user message
//   close()   let go of the process (the conversation itself stays on disk, to be resumed)
//   control   what the server may ask of a live conversation. Always has interrupt(); Claude's
//             is the SDK query itself, with setModel(), mcpServerStatus() and the rest.
//   spec      which program runs it (diagnostics)
//
// Turn events, in the order things happen:
//   { type: 'init', ref, model }              the backend's own id for this conversation, to resume it
//   { type: 'commands_changed' }              its list of slash commands changed
//   { type: 'command_output', text }          what a slash command printed
//   { type: 'notice', text }                  a line for the owner, not from the model
//   { type: 'thinking_start' } / { type: 'thinking_delta', text } / { type: 'thinking_end' }
//   { type: 'thinking', text }                thinking that arrived whole
//   { type: 'text_delta', text } / { type: 'text_end' }   a reply as it is written; _end closes one message
//   { type: 'text', text }                    a reply that arrived whole
//   { type: 'tool_use', id, name, input }     named and shaped like Claude Code's tools (Bash, Read, …)
//   { type: 'tool_result', id, ok, text }
//   { type: 'result', ok, text, subtype, errors, costUsd, durationMs, code }   the turn is over

export const AGY_PREFIX = 'agy:';
export const BACKEND_NAMES = { claude: 'Claude', agy: 'Antigravity' };

// A model id names its backend: Antigravity's are stored as "agy:<slug>".
export const backendOf = (model) => (String(model || '').startsWith(AGY_PREFIX) ? 'agy' : 'claude');
export const agySlug = (model) => (backendOf(model) === 'agy' ? String(model).slice(AGY_PREFIX.length) : '');

// An async queue: push() from callbacks, read with for-await. end() lets the reader finish
// what is already queued and then stop.
export function channel() {
	const items = [];
	let wake = null;
	let ended = false;
	const poke = () => { if (wake) { const w = wake; wake = null; w(); } };
	return {
		push(v) { if (!ended) { items.push(v); poke(); } },
		end() { ended = true; poke(); },
		get ended() { return ended; },
		async *[Symbol.asyncIterator]() {
			for (;;) {
				if (items.length) { yield items.shift(); continue; }
				if (ended) return;
				await new Promise((r) => { wake = r; });
			}
		},
	};
}
