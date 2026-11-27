// Thinking into Chinese, through Google's free web translation endpoint (the one its own
// browser extension used; no key). Asked through the app's proxy when one is set, and directly
// when that fails. Code and commands are kept as written: they go out as ⟦n⟧ markers, which the
// translation leaves alone, and are put back afterwards.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';

// Two of Google's keyless endpoints: the web one, and the one Chrome's dictionary extension uses
// (with limits of its own, so it stands in when the first says no). AGENT_TRANSLATE_URL: tests.
const ENDPOINTS = process.env.AGENT_TRANSLATE_URL
	? [{ url: process.env.AGENT_TRANSLATE_URL, kind: 'gtx' }]
	: [
		{ url: 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&dj=1&ie=UTF-8&oe=UTF-8', kind: 'gtx' },
		{ url: 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=zh-CN', kind: 'dict' },
	];
const CHUNK = 4000; // characters per request; the endpoint takes about 5000

// Mostly Chinese already: nothing to do.
export const mostlyChinese = (t) => {
	const s = String(t || '').replace(/\s+/g, '');
	const han = (s.match(/[一-鿿]/g) || []).length;
	return s.length > 0 && han / s.length > 0.25;
};

// One request: POST a form body, through an HTTP proxy's CONNECT tunnel when given.
function post(url, form, proxy, timeout = 12000) {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const body = Buffer.from(form);
		const headers = { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'content-length': body.length, 'user-agent': 'Mozilla/5.0' };
		const done = (res) => {
			let data = '';
			res.setEncoding('utf8');
			res.on('data', (d) => { data += d; });
			res.on('error', reject);
			res.on('end', () => resolve({ status: res.statusCode, body: data }));
		};
		const go = (socket) => {
			const lib = u.protocol === 'http:' ? httpRequest : httpsRequest;
			const req = lib({ host: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'POST', headers: { host: u.host, ...headers }, timeout,
				...(socket ? { createConnection: () => socket } : { agent: false }) }, done);
			req.on('timeout', () => req.destroy(new Error('超时')));
			req.on('error', reject);
			req.end(body);
		};
		if (!proxy || u.protocol === 'http:') return go(null);
		let p;
		try { p = new URL(proxy); } catch { return reject(new Error('代理地址无效')); }
		const port = u.port || 443;
		const c = httpRequest({ host: p.hostname, port: Number(p.port) || 80, method: 'CONNECT', path: `${u.hostname}:${port}`, headers: { host: `${u.hostname}:${port}` }, timeout });
		c.on('connect', (res, sock) => {
			if (res.statusCode !== 200) { sock.destroy(); return reject(new Error(`代理拒绝（${res.statusCode}）`)); }
			go(tlsConnect({ socket: sock, servername: u.hostname }));
		});
		c.on('timeout', () => c.destroy(new Error('超时')));
		c.on('error', reject);
		c.end();
	});
}

// Code spans and blocks out, markers in; and back.
export function protect(text) {
	const kept = [];
	const out = String(text).replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => { kept.push(m); return `⟦${kept.length - 1}⟧`; });
	return { out, kept };
}
export const restore = (text, kept) => String(text).replace(/⟦\s*(\d+)\s*⟧/g, (m, i) => (kept[+i] != null ? kept[+i] : m));

// Pieces of at most `max` characters, cut at paragraph breaks, else at sentence ends.
export function pieces(text, max = CHUNK) {
	const out = [];
	let rest = String(text);
	while (rest.length > max) {
		const head = rest.slice(0, max);
		// Where to end this piece: after a paragraph break, else after a sentence or a line.
		const at = (i, len) => (i < 0 ? -1 : i + len);
		let end = at(head.lastIndexOf('\n\n'), 2);
		if (end < max / 3) end = Math.max(at(head.lastIndexOf('. '), 2), at(head.lastIndexOf('。'), 1), at(head.lastIndexOf('\n'), 1));
		if (end < max / 3) end = max;
		out.push(rest.slice(0, end));
		rest = rest.slice(end);
	}
	if (rest) out.push(rest);
	return out;
}

async function once(ep, piece, proxy) {
	const url = ep.kind === 'gtx' && process.env.AGENT_TRANSLATE_URL ? `${ep.url}?client=gtx&sl=auto&tl=zh-CN&dt=t&dj=1` : ep.url;
	const r = await post(url, `q=${encodeURIComponent(piece)}`, proxy);
	if (r.status === 429 || r.status === 503) { const e = new Error('翻译服务暂时不让用了（请求太多），过一会再试'); e.busy = true; throw e; }
	if (r.status !== 200) throw new Error(`翻译服务返回 ${r.status}`);
	let d;
	try { d = JSON.parse(r.body); } catch { throw new Error('翻译服务的回答看不懂'); }
	if (ep.kind === 'gtx') return { text: (d.sentences || []).map((x) => x.trans || '').join(''), src: String(d.src || '') };
	// dict: [["译文","en"]] (or, from older builds, ["译文"])
	const first = Array.isArray(d) ? d[0] : null;
	if (Array.isArray(first)) return { text: String(first[0] ?? ''), src: String(first[1] ?? '') };
	if (typeof first === 'string') return { text: first, src: '' };
	throw new Error('翻译服务的回答看不懂');
}

let preferred = 0; // the route-and-endpoint pair that last worked goes first

// { text, same } — same: it was Chinese already. Throws with a reason the owner can act on.
// `proxies`: routes to try in order ('' is a direct connection).
export async function translateToChinese(text, proxies = ['']) {
	const src = String(text || '');
	if (!src.trim()) return { text: '', same: false };
	if (mostlyChinese(src)) return { text: src, same: true };
	const { out, kept } = protect(src);
	const tries = [];
	for (const proxy of [...new Set(proxies)]) for (const ep of ENDPOINTS) tries.push({ proxy, ep });
	const order = [tries[preferred % tries.length], ...tries.filter((_, i) => i !== preferred % tries.length)].filter(Boolean);
	let lastErr = null;
	for (const t of order) {
		try {
			const parts = [];
			let lang = '';
			for (const piece of pieces(out)) {
				const r = await once(t.ep, piece, t.proxy);
				lang ||= r.src;
				parts.push(r.text);
			}
			preferred = tries.indexOf(t);
			if (/^zh/i.test(lang)) return { text: src, same: true };
			return { text: restore(parts.join(''), kept), same: false };
		} catch (e) {
			lastErr = e;
		}
	}
	const why = String(lastErr?.message || lastErr || '');
	if (lastErr?.busy) throw new Error(why);
	throw new Error(/超时|ECONN|ENOTFOUND|EAI_AGAIN|socket|代理|TLS|certificate|hang up/i.test(why)
		? `连不上翻译服务（Google 翻译）：${why}。检查网络，或在「设置 → 联网搜索」里设置代理`
		: why || '翻译失败');
}
