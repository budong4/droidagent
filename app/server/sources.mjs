// Where an answer's information came from: the pages a web search returned or a fetch read,
// as [{ title, url }]. Shown under the search step, and as the answer's sources.
//
// Claude Code's WebSearch result reads "Web search results for query: …" followed by
// "Links: [{"title":…,"url":…}, …]"; WebFetch names its page in its input. Other tools (agy's
// search, the built-in browser) are read for plain links.

const URL_RE = /https?:\/\/[^\s"'<>()\[\]{}`]+[^\s"'<>()\[\]{}`.,;:!?。，；：！？）】」]/g;

export function hostOf(url) {
	try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
const clean = (list, max) => {
	const seen = new Set();
	const out = [];
	for (const s of list) {
		const url = String(s?.url || '').trim();
		if (!/^https?:\/\//.test(url) || seen.has(url) || !hostOf(url)) continue;
		seen.add(url);
		out.push({ title: String(s.title || '').trim().slice(0, 140) || hostOf(url), url: url.slice(0, 600) });
		if (out.length >= max) break;
	}
	return out;
};

// The "Links: [...]" array in a WebSearch result, read bracket by bracket (titles may hold brackets).
function linksArray(text) {
	const at = text.indexOf('Links: [');
	if (at < 0) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	const start = at + 'Links: '.length;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (esc) { esc = false; continue; }
		if (c === '\\') { esc = true; continue; }
		if (c === '"') { inStr = !inStr; continue; }
		if (inStr) continue;
		if (c === '[' || c === '{') depth++;
		else if (c === ']' || c === '}') {
			depth--;
			if (depth === 0) {
				try { const j = JSON.parse(text.slice(start, i + 1)); return Array.isArray(j) ? j : null; } catch { return null; }
			}
		}
	}
	return null;
}

export function queryOf(text) {
	const m = /Web search results for query:\s*"([^"\n]+)"/.exec(String(text || ''));
	return m ? m[1] : '';
}

// Sources from one step: its name (as the cards know it), its input and its result text.
export function sourcesOf(name, input, text, max = 12) {
	const t = String(text || '');
	if (name === 'WebFetch' || name === 'mcp__droidagent__browser_open') {
		const url = input?.url;
		const title = /^(?:标题|Title)[:：]\s*(.+)$/m.exec(t)?.[1];
		return url ? clean([{ url, title }], 1) : [];
	}
	if (name === 'WebSearch') {
		const links = linksArray(t);
		if (links) return clean(links, max);
		return clean([...t.matchAll(URL_RE)].map((m) => ({ url: m[0] })), max);
	}
	if (/search/i.test(name) || String(name).startsWith('mcp__')) {
		// Markdown links first ([title](url)), then bare ones.
		const md = [...t.matchAll(/\[([^\]\n]{1,140})\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => ({ title: m[1], url: m[2] }));
		return clean([...md, ...[...t.matchAll(URL_RE)].map((m) => ({ url: m[0] }))], max);
	}
	return [];
}

// The sources of a turn, merged: first come first, no repeats.
export function mergeSources(a, b, max = 16) {
	return clean([...(a || []), ...(b || [])], max);
}
