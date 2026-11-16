// What Antigravity was thinking. Headless agy streams its replies and steps but not its thoughts;
// it does keep them, in the conversation's own SQLite file
// (~/.gemini/antigravity-cli/conversations/<id>.db, table `steps`, one protobuf blob per step).
// The thought prose of a step is field 20, sub-field 3 of that blob (sub-field 1 is the reply
// itself, never shown as a thought). Layout as found by dsh-agy-link (MIT), src/runtime/agy/db.
//
// Read only, never written; a file that is missing, locked or laid out differently gives no
// thoughts rather than an error.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
// agent_response (14, 15) and tool steps: a step that calls a tool can carry the thought behind it.
const STEP_TYPES = [5, 7, 8, 9, 14, 15, 17, 21, 33, 101, 132, 138, 139];

export const conversationDb = (home, id) => (SAFE_ID.test(String(id || '')) ? join(home, '.gemini', 'antigravity-cli', 'conversations', `${id}.db`) : null);

function varint(b, pos) {
	let val = 0;
	let mul = 1;
	while (pos < b.length) {
		const byte = b[pos++];
		val += (byte & 0x7f) * mul;
		if (!(byte & 0x80)) return [val, pos];
		mul *= 128;
		if (mul > 2 ** 49) return null;
	}
	return null;
}
// Calls back with each length-delimited field: (number, bytes). Stops quietly at anything odd.
function fields(buf, cb) {
	let pos = 0;
	while (pos < buf.length) {
		const t = varint(buf, pos);
		if (!t) return;
		pos = t[1];
		const wire = t[0] % 8;
		const num = Math.floor(t[0] / 8);
		if (wire === 2) {
			const l = varint(buf, pos);
			if (!l || l[1] + l[0] > buf.length) return;
			cb(num, buf.subarray(l[1], l[1] + l[0]));
			pos = l[1] + l[0];
		} else if (wire === 0) {
			const v = varint(buf, pos);
			if (!v) return;
			pos = v[1];
		} else if (wire === 1) pos += 8;
		else if (wire === 5) pos += 4;
		else return;
	}
}
const notThought = (t) => /^SYSTEM ROLE/i.test(t) || t.startsWith('/plan ') || t.includes('<PLAN>') || t.startsWith('{') || t.startsWith('[')
	|| /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t) || /^(bot-|call_)/.test(t);

// The thought prose in one step's blob, or ''.
export function thoughtOf(payload) {
	const found = [];
	const walk = (buf, depth) => {
		if (depth > 3) return;
		fields(buf, (num, slice) => {
			if (num === 20) {
				fields(slice, (sub, s) => {
					if (sub !== 3) return;
					const t = Buffer.from(s).toString('utf8').trim();
					if (t && !notThought(t) && !found.includes(t)) found.push(t);
				});
			}
			if (slice.length >= 8 && slice.length < 200000) walk(slice, depth + 1);
		});
	};
	walk(Buffer.from(payload), 0);
	return found.join('\n').trim();
}

let sqlite; // node:sqlite (Node 22.13+), or null where there is none
async function query(db, sql) {
	if (sqlite === undefined) {
		try { sqlite = (await import('node:sqlite')).DatabaseSync || null; } catch { sqlite = null; }
	}
	if (sqlite) {
		let d;
		try { d = new sqlite(db, { readOnly: true }); } catch { d = null; }
		if (d) {
			try {
				try { d.exec('PRAGMA busy_timeout = 2000'); } catch { /* old build */ }
				return d.prepare(sql).all().map((r) => [Number(r.idx), String(r.hex || '')]);
			} finally { d.close(); }
		}
	}
	// The sqlite3 program, where Node has no SQLite of its own.
	return new Promise((resolve) => {
		execFile('sqlite3', ['-readonly', '-cmd', '.timeout 2000', db, sql], { timeout: 5000, maxBuffer: 32 * 1024 * 1024 }, (err, out) => {
			if (err) return resolve([]);
			resolve(String(out).split('\n').map((l) => { const i = l.indexOf('|'); return i > 0 ? [Number(l.slice(0, i)), l.slice(i + 1).trim()] : null; }).filter(Boolean));
		});
	});
}

// Thoughts of the conversation's steps from index `from` on: Map(step index -> text).
export async function readThoughts(home, conversationId, from = 0) {
	const db = conversationDb(home, conversationId);
	const out = new Map();
	if (!db || !existsSync(db)) return out;
	const sql = `SELECT idx, hex(step_payload) AS hex FROM steps WHERE step_type IN (${STEP_TYPES.join(',')}) AND idx >= ${Math.max(0, Math.floor(Number(from) || 0))} AND length(step_payload) > 4 ORDER BY idx`;
	let rows;
	try { rows = await query(db, sql); } catch { return out; }
	for (const [idx, hex] of rows) {
		if (!Number.isFinite(idx) || !hex || hex === 'NULL') continue;
		const t = thoughtOf(Buffer.from(hex, 'hex'));
		if (t) out.set(idx, t);
	}
	return out;
}

// The highest step index already in the conversation's record, or -1.
export async function lastStepIndex(home, conversationId) {
	const db = conversationDb(home, conversationId);
	if (!db || !existsSync(db)) return -1;
	try {
		const rows = await query(db, 'SELECT max(idx) AS idx, \'\' AS hex FROM steps');
		const n = Number(rows[0]?.[0]);
		return Number.isFinite(n) ? n : -1;
	} catch { return -1; }
}
