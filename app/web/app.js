'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const api = (path, bodyObj) =>
	fetch(path, bodyObj ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodyObj) } : { method: 'POST' })
		.then((r) => r.json())
		.catch(() => ({ ok: false }));

const thread = $('#thread');
const statusEl = $('#status');
const statusText = $('#status-text');
const chatTitle = $('#chat-title');

let running = false;
let curAssistant = null; // { el, raw } current streaming assistant bubble
let curThink = null;
const toolEls = new Map(); // tool_use id -> element

const SETTINGS = {
	model: 'sonnet',
	modelName: 'Sonnet 5.5',
	effort: 'xhigh',
	fastMode: false,
	mode: 'autoEdit',
	readonly: false,
	screen: true,
	web: true,
	thinking: true,
	personalData: false,
};

let curSession = null;
let sessionsList = [];
let searchQuery = '';
let attachedScopes = []; // Array of { type: 'app'|'folder'|'file'|'path'|'image', name, path, package, dataUrl }
// Every conversation runs independently on the server; these track which ones (by id) currently
// have a turn in flight or an unanswered confirmation card, so the sidebar can show a live dot
// for conversations other than the one on screen right now.
let runningIds = new Set();
let pendingIds = new Set();
let slashCommands = [];
let curTodoEl = null; // the live-updating ☐/☑ checklist block for the session currently on screen, if any

/* ---------------- markdown (small, safe) ---------------- */
function esc(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function md(src) {
	const blocks = [];
	let s = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
		blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
		return `\u0000${blocks.length - 1}\u0000`;
	});
	s = esc(s);
	s = s.replace(/(^\|.+\|\n\|[ :|-]+\|\n(?:\|.*\|\n?)*)/gm, (t) => {
		const rows = t.trim().split('\n').filter((r) => r.trim());
		const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
		let html = '<table>';
		html += '<tr>' + cells(rows[0]).map((c) => `<th>${c}</th>`).join('') + '</tr>';
		for (let i = 2; i < rows.length; i++) html += '<tr>' + cells(rows[i]).map((c) => `<td>${c}</td>`).join('') + '</tr>';
		return html + '</table>';
	});
	s = s.replace(/^###### (.*)$/gm, '<h6>$1</h6>').replace(/^##### (.*)$/gm, '<h5>$1</h5>')
		.replace(/^#### (.*)$/gm, '<h4>$1</h4>').replace(/^### (.*)$/gm, '<h3>$1</h3>')
		.replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>');
	s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
	s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
	s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
	s = s.replace(/(?:^(?:[-*+]|\d+\.) .*(?:\n|$))+/gm, (blk) => {
		const ol = /^\s*\d+\./.test(blk);
		const items = blk.trim().split('\n').map((l) => l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')).map((t) => `<li>${t}</li>`).join('');
		return `<${ol ? 'ol' : 'ul'}>${items}</${ol ? 'ol' : 'ul'}>`;
	});
	s = s.split(/\n{2,}/).map((p) => (/^\s*<(h\d|ul|ol|pre|table|blockquote)/.test(p) ? p : p.trim() ? `<p>${p.replace(/\n/g, '<br>')}</p>` : '')).join('');
	s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
	return s;
}

/* ---------------- dom helpers ---------------- */
function atBottom() { return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120; }
function scroll(force) { if (force || atBottom()) requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; }); }
/* ---------------- theme (auto / light / dark) ---------------- */
// Display preference, so it lives on the device rather than in the shared server settings.
// "auto" follows the system. Inside the app the host reports night mode: WebView's own
// prefers-color-scheme doesn't track the system reliably on every Android version.
function systemDark() {
	try { if (window.AgentHost && typeof window.AgentHost.isNight === 'function') return !!window.AgentHost.isNight(); } catch { /* bridge gone */ }
	return matchMedia('(prefers-color-scheme: dark)').matches;
}
function applyTheme(t) {
	const dark = t === 'dark' || (t !== 'light' && systemDark());
	document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) meta.setAttribute('content', dark ? '#0D1411' : '#F5F6F2');
}
function currentTheme() {
	try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; }
}
function setTheme(t) {
	try { localStorage.setItem('theme', t); } catch { /* private mode */ }
	applyTheme(t);
	document.querySelectorAll('#theme-seg button').forEach((b) => b.classList.toggle('sel', b.dataset.v === t));
}
applyTheme(currentTheme());
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(currentTheme()));

function killWelcome() { const w = $('#welcome'); if (w) w.remove(); }
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

function addUser(text) {
	killWelcome();
	const e = el('div', 'msg user'); e.textContent = text; thread.appendChild(e); scroll(true);
	endAssistant();
}
function ensureAssistant() {
	if (curAssistant) return curAssistant;
	killWelcome();
	const wrap = el('div', 'msg assistant'); const b = el('div', 'bubble-a cursor');
	wrap.appendChild(b); thread.appendChild(wrap);
	curAssistant = { el: b, raw: '' }; scroll(true); return curAssistant;
}
function appendAssistant(text) { const a = ensureAssistant(); a.raw += text; a.el.innerHTML = md(a.raw); scroll(); }
function setAssistant(text) { const a = ensureAssistant(); a.raw = text; a.el.innerHTML = md(a.raw); scroll(); }
function endAssistant() { if (curAssistant) { curAssistant.el.classList.remove('cursor'); curAssistant = null; } curThink = null; }

// Line icons (stroked paths, drawn in currentColor) rather than emoji — emoji were the main
// thing making this look like a demo rather than an app.
const ICON_PATHS = {
	phone: '<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M11 18h2"/>',
	tap: '<path d="M9 11V6a2 2 0 114 0v6"/><path d="M13 12V9a2 2 0 114 0v6a5 5 0 01-5 5h-1a5 5 0 01-5-5v-3l-1.5 1"/>',
	terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
	pencil: '<path d="M4 20h4l10-10a2.8 2.8 0 10-4-4L4 16v4z"/>',
	file: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/>',
	search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
	globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 010 18a15 15 0 010-18"/>',
	layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 14l9 5 9-5"/>',
	list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
	spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18"/>',
	dot: '<circle cx="12" cy="12" r="3"/>',
	battery: '<rect x="2.5" y="7" width="17" height="10" rx="2.5"/><path d="M22 11v2M6 10.5v3M9.5 10.5v3"/>',
	disk: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
	restart: '<path d="M4 12a8 8 0 108-8 8.4 8.4 0 00-5.8 2.4L4 8.5"/><path d="M4 4v4.5h4.5"/>',
	chev: '<path d="M9 6l6 6-6 6"/>',
	check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
};
// The app's mark: the root prompt "#" and a block cursor.
const MARK_SVG = '<svg class="mark" viewBox="0 0 108 108" aria-hidden="true"><rect width="108" height="108" rx="24" fill="#0F3B2D"/><path d="M43.6 36.4 L39.2 71.6 M56.8 36.4 L52.4 71.6 M32 46.9 H64 M29.8 61.2 H61.8" fill="none" stroke="#F3F5EF" stroke-width="6.8" stroke-linecap="round"/><rect x="68.3" y="40.8" width="12.1" height="30.8" rx="1.8" fill="#E2B33C"/></svg>';
const icon = (k, size = 17) =>
	`<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[k] || ICON_PATHS.dot}</svg>`;

const TOOL_ICON = (name, detail) => {
	const d = detail || '';
	if (name === 'Bash') {
		if (/droid (shot|ui|top)|screencap|uiautomator/.test(d)) return icon('phone');
		if (/droid (tap|swipe|text|key|app)/.test(d)) return icon('tap');
		return icon('terminal');
	}
	if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) return icon('pencil');
	if (name === 'Read' || name === 'NotebookRead') return icon('file');
	if (/Glob|Grep|LS/.test(name)) return icon('search');
	if (name === 'WebSearch' || name === 'WebFetch') return icon('globe');
	if (name === 'Task') return icon('layers');
	if (name === 'TodoWrite') return icon('list');
	return icon('dot');
};

function addTool(id, name, title, detail, replay) {
	// Open while it runs so you can watch it; finishTool collapses it again once it succeeds.
	// On history replay everything starts collapsed, otherwise old conversations are a wall of text.
	// Shell commands get the root prompt in the gutter and are shown as the command itself.
	const bash = name === 'Bash' && !/droid (shot|ui|top|tap|swipe|text|key|app)|screencap|uiautomator/.test(detail || '');
	const card = el('div', (replay ? 'tool' : 'tool open') + (bash ? ' bash' : ''));
	const gutter = bash ? '<span class="tool-prompt">#</span>' : TOOL_ICON(name, detail || '');
	card.innerHTML = `<div class="tool-head"><div class="tool-ic">${gutter}</div><div class="tool-title"></div><div class="tool-state" title="运行中"><span class="spin"></span></div><svg class="chev" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg></div><div class="tool-body"><pre></pre></div>`;
	card.querySelector('.tool-title').textContent = title || name;
	if (detail) card.querySelector('.tool-body pre').textContent = detail;
	card.querySelector('.tool-head').onclick = () => card.classList.toggle('open');
	thread.appendChild(card); if (id) toolEls.set(id, card); scroll(); endAssistant(); return card;
}
function finishTool(id, ok, summary) {
	const card = toolEls.get(id); if (!card) return;
	const st = card.querySelector('.tool-state');
	if (ok) { st.innerHTML = icon('check', 15); st.title = '完成'; } else { st.textContent = '出错'; st.title = ''; }
	st.className = 'tool-state ' + (ok ? 'ok' : 'err');
	if (summary && summary.trim()) {
		const pre = card.querySelector('.tool-body pre');
		pre.textContent = (pre.textContent ? pre.textContent + '\n— — —\n' : '') + summary.trim();
	}
	// Errors stay open — that's the one case you always want to read.
	card.classList.toggle('open', !ok);
	scroll();
}
function addThinkDelta(text) {
	if (!curThink) {
		const card = el('div', 'think open');
		card.innerHTML = `<div class="think-head">${icon('spark', 15)}<span>思考过程</span><svg class="chev" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg></div><div class="think-body"></div>`;
		card.querySelector('.think-head').onclick = () => card.classList.toggle('open');
		thread.appendChild(card);
		curThink = card.querySelector('.think-body');
	}
	curThink.textContent += text;
	scroll();
}
function sysline(t) { const e = el('div', 'sysline'); e.textContent = t; thread.appendChild(e); scroll(); }

/* ---------------- live todo checklist (TodoWrite) ---------------- */
// Mirrors the terminal's own behaviour: one checklist block per conversation that gets replaced
// in place on every TodoWrite call, rather than piling up a new card each time.
const TODO_ICON = { pending: '', in_progress: '', completed: '' }; // drawn by CSS
function renderTodoList(todos) {
	return (todos || []).map((t) => {
		const label = t.status === 'in_progress' ? (t.activeForm || t.content) : t.content;
		return `<div class="todo-row todo-${esc(t.status || 'pending')}"><span class="todo-ic">${TODO_ICON[t.status] || ''}</span><span class="todo-label">${esc(label || '')}</span></div>`;
	}).join('');
}
function upsertTodo(todos) {
	if (!curTodoEl) { curTodoEl = el('div', 'todo-block'); thread.appendChild(curTodoEl); }
	curTodoEl.innerHTML = renderTodoList(todos);
	endAssistant();
	scroll();
}

function addPermission(p) {
	endAssistant();
	const cat = p.reason === '高危操作';
	const card = el('div', 'perm' + (cat ? ' catastrophic' : ''));
	card.innerHTML = `<div class="ptop"><span class="tag">${cat ? '高危操作' : '需要你确认'}</span><span class="pt"></span></div>${p.detail ? '<pre></pre>' : ''}<div class="pbtns"><button class="yes">允许</button><button class="no">拒绝</button><button class="no stop">停止</button></div><div class="verdict hidden"></div>`;
	card.querySelector('.pt').textContent = p.title || p.name;
	if (p.detail) card.querySelector('pre').textContent = p.detail;
	const sid = p.sessionId || curSession?.id;
	const decide = (d, label) => { api('/api/permission', { id: p.id, decision: d, sessionId: sid }); card.classList.add('done'); const v = card.querySelector('.verdict'); v.classList.remove('hidden'); v.textContent = label; };
	card.querySelector('.yes').onclick = () => decide('allow', '✓ 已允许');
	card.querySelector('.no:not(.stop)').onclick = () => decide('deny', '✕ 已拒绝');
	card.querySelector('.stop').onclick = () => decide('stop', '■ 已停止');
	if (p.verdict) {
		card.classList.add('done');
		const v = card.querySelector('.verdict');
		v.classList.remove('hidden');
		v.textContent = p.verdict === 'allow' ? '✓ 已允许' : p.verdict === 'stop' ? '■ 已停止' : '✕ 已拒绝';
	}
	thread.appendChild(card); scroll(true);
}

/* ---------------- session transcript rendering ---------------- */
function renderTranscript(sess) {
	thread.innerHTML = '';
	toolEls.clear();
	curAssistant = null;
	curThink = null;
	curTodoEl = null;

	if (sess && sess.title) {
		chatTitle.textContent = sess.title;
	} else {
		chatTitle.textContent = '新对话';
	}

	if (!sess || !sess.messages || sess.messages.length === 0) {
		buildWelcome();
		return;
	}

	for (const m of sess.messages) {
		if (m.role === 'user') {
			addUser(m.text);
		} else if (m.role === 'assistant') {
			endAssistant();
			const wrap = el('div', 'msg assistant');
			const b = el('div', 'bubble-a');
			b.innerHTML = md(m.text || '');
			wrap.appendChild(b);
			thread.appendChild(wrap);
		} else if (m.role === 'tool') {
			if (m.kind === 'todo') {
				upsertTodo(m.todos || []);
				continue;
			}
			addTool(m.id, m.name, m.title, m.detail, true);
			if (m.state && m.state !== 'running') {
				finishTool(m.id, m.ok !== false, m.summary);
			}
		} else if (m.role === 'perm') {
			addPermission({ ...m, sessionId: sess.id });
		} else if (m.role === 'sys') {
			sysline(m.text);
		}
	}
	scroll(true);
}

/* ---------------- running state ---------------- */
function setRunning(v) {
	running = v;
	$('#btn-send').classList.toggle('hidden', v);
	$('#btn-stop').classList.toggle('hidden', !v);
	statusEl.className = 'status ' + (v ? 'busy' : 'on');
	statusText.textContent = v ? '处理中…' : '就绪';
}

/* ---------------- format date ---------------- */
function fmtTime(ts) {
	if (!ts) return '';
	const d = new Date(ts);
	const now = new Date();
	const diff = now - d;
	if (diff < 60000) return '刚刚';
	if (d.toDateString() === now.toDateString()) {
		return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
	}
	const yest = new Date(now); yest.setDate(yest.getDate() - 1);
	if (d.toDateString() === yest.toDateString()) return '昨天';
	return (d.getMonth() + 1) + '-' + d.getDate();
}

/* ---------------- sidebar & history ---------------- */
function openSidebar() {
	$('#sidebar').classList.remove('hidden');
	$('#sidebar-backdrop').classList.remove('hidden');
	fetchSessions();
}
function closeSidebar() {
	$('#sidebar').classList.add('hidden');
	$('#sidebar-backdrop').classList.add('hidden');
}

$('#btn-sidebar').onclick = openSidebar;
$('#btn-sidebar-close').onclick = closeSidebar;
$('#sidebar-backdrop').onclick = closeSidebar;

async function fetchSessions() {
	const r = await fetch('/api/sessions').then((res) => res.json()).catch(() => null);
	if (r && r.ok) {
		sessionsList = r.sessions || [];
		runningIds = new Set(r.runningIds || []);
		pendingIds = new Set(r.pendingIds || []);
		if (r.activeSession) {
			curSession = r.activeSession;
			chatTitle.textContent = curSession.title || '新对话';
		}
		renderSidebar();
	}
}

function renderSidebar() {
	const pinnedGroup = $('#pinned-group');
	const pinnedList = $('#pinned-list');
	const recentList = $('#recent-list');
	const emptyEl = $('#empty-search');
	const countEl = $('#session-count');

	pinnedList.innerHTML = '';
	recentList.innerHTML = '';

	const q = searchQuery.trim().toLowerCase();
	const filtered = sessionsList.filter((s) => {
		if (!q) return true;
		const t = (s.title || '').toLowerCase();
		const p = (s.preview || '').toLowerCase();
		return t.includes(q) || p.includes(q);
	});

	countEl.textContent = `${sessionsList.length} 个对话`;

	if (filtered.length === 0) {
		emptyEl.classList.remove('hidden');
		pinnedGroup.classList.add('hidden');
		$('#recent-group').classList.add('hidden');
		return;
	}

	emptyEl.classList.add('hidden');
	$('#recent-group').classList.remove('hidden');

	const pinned = filtered.filter((s) => s.pinned);
	const recent = filtered.filter((s) => !s.pinned);

	pinnedGroup.classList.toggle('hidden', pinned.length === 0);

	const createItem = (s) => {
		const item = el('div', 'session-item' + (curSession && curSession.id === s.id ? ' active' : ''));
		item.dataset.id = s.id;

		const main = el('div', 'session-item-main');
		const titleRow = el('div', 'session-title-row');
		const title = el('span', 'session-title', esc(s.title || '新对话'));
		titleRow.appendChild(title);
		// A still-running or awaiting-confirmation conversation gets a dot even while you're looking
		// at a different one — this is the whole point of letting conversations run independently.
		if (pendingIds.has(s.id)) titleRow.appendChild(el('span', 'live-dot pending'));
		else if (runningIds.has(s.id)) titleRow.appendChild(el('span', 'live-dot running'));
		const meta = el('div', 'session-meta');
		const time = el('span', 'session-time', fmtTime(s.updatedAt));
		const prev = el('span', 'session-preview', esc(s.preview ? ' · ' + s.preview : ''));
		meta.appendChild(time);
		if (s.preview) meta.appendChild(prev);
		main.appendChild(titleRow);
		main.appendChild(meta);

		main.onclick = () => {
			if (curSession && curSession.id === s.id) {
				closeSidebar();
				return;
			}
			switchSession(s.id);
		};

		const acts = el('div', 'session-item-actions');
		// Pin btn
		const pinBtn = el('button', 'action-btn pin-btn' + (s.pinned ? ' pinned' : ''));
		pinBtn.title = s.pinned ? '取消置顶' : '置顶';
		pinBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M16 4a1 1 0 0 1 1 1v3.2a1 1 0 0 0 .29.7l2.42 2.43a1 1 0 0 1 .29.71V13a1 1 0 0 1-1 1h-5v7a1 1 0 0 1-2 0v-7H7a1 1 0 0 1-1-1v-.96a1 1 0 0 1 .29-.7l2.42-2.43a1 1 0 0 0 .29-.71V5a1 1 0 0 1 1-1h6z"/></svg>`;
		pinBtn.onclick = (e) => { e.stopPropagation(); togglePin(s.id, !s.pinned); };

		// Rename btn
		const renameBtn = el('button', 'action-btn rename-btn');
		renameBtn.title = '重命名';
		renameBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`;
		renameBtn.onclick = (e) => { e.stopPropagation(); promptRename(s); };

		// Delete btn
		const delBtn = el('button', 'action-btn delete-btn');
		delBtn.title = '删除';
		delBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
		delBtn.onclick = (e) => { e.stopPropagation(); confirmDelete(s); };

		acts.appendChild(pinBtn);
		acts.appendChild(renameBtn);
		acts.appendChild(delBtn);

		item.appendChild(main);
		item.appendChild(acts);
		return item;
	};

	pinned.forEach((s) => pinnedList.appendChild(createItem(s)));
	recent.forEach((s) => recentList.appendChild(createItem(s)));
}

/* ---------------- search in sidebar ---------------- */
const searchInput = $('#search-input');
const searchClear = $('#search-clear');
searchInput.oninput = () => {
	searchQuery = searchInput.value;
	searchClear.classList.toggle('hidden', !searchQuery);
	renderSidebar();
};
searchClear.onclick = () => {
	searchInput.value = '';
	searchQuery = '';
	searchClear.classList.add('hidden');
	renderSidebar();
};

/* ---------------- session actions ---------------- */
// Switching which conversation is on screen is just a view change — it never stops whatever that
// conversation (or any other) is doing in the background. The composer reflects whichever
// conversation is now showing: setRunning() picks up its live state from runningIds/pendingIds.
async function switchSession(id) {
	const r = await api('/api/sessions/switch', { id });
	if (r && r.ok && r.session) {
		curSession = r.session;
		renderTranscript(curSession);
		setRunning(runningIds.has(id));
		closeSidebar();
		renderSidebar();
		loadSlashCommands();
	}
}

async function createNewChat() {
	const r = await api('/api/sessions/new');
	if (r && r.ok && r.session) {
		curSession = r.session;
		renderTranscript(curSession);
		setRunning(false);
		closeSidebar();
		fetchSessions();
		loadSlashCommands();
	}
}
$('#sidebar-new-btn').onclick = createNewChat;
$('#btn-new').onclick = createNewChat;

async function togglePin(id, pinned) {
	const r = await api('/api/sessions/pin', { id, pinned });
	if (r && r.ok) {
		const target = sessionsList.find((s) => s.id === id);
		if (target) target.pinned = pinned;
		if (curSession && curSession.id === id) curSession.pinned = pinned;
		renderSidebar();
	}
}

function promptRename(s) {
	showModal({
		title: '重命名对话',
		msg: '为这个对话输入新的标题：',
		inputVal: s.title || '',
		showInput: true,
		confirmText: '保存',
		onConfirm: async (val) => {
			if (!val || !val.trim()) return;
			const r = await api('/api/sessions/rename', { id: s.id, title: val.trim() });
			if (r && r.ok) {
				s.title = val.trim();
				if (curSession && curSession.id === s.id) {
					curSession.title = s.title;
					chatTitle.textContent = s.title;
				}
				renderSidebar();
			}
		},
	});
}

function confirmDelete(s) {
	showModal({
		title: '删除对话',
		msg: `确定要删除「${esc(s.title || '此对话')}」吗？此操作无法撤销。`,
		showInput: false,
		confirmText: '删除',
		onConfirm: async () => {
			const r = await api('/api/sessions/delete', { id: s.id });
			if (r && r.ok) {
				sessionsList = sessionsList.filter((x) => x.id !== s.id);
				if (r.activeSession) {
					curSession = r.activeSession;
					renderTranscript(curSession);
				}
				renderSidebar();
			}
		},
	});
}

$('#btn-clear-all').onclick = () => {
	showModal({
		title: '清空全部对话',
		msg: '确定要清空所有历史对话吗？所有保存的记录都将被删除，此操作无法撤销。',
		showInput: false,
		confirmText: '全部清空',
		onConfirm: async () => {
			const r = await api('/api/sessions/clear');
			if (r && r.ok) {
				sessionsList = [];
				curSession = r.session;
				renderTranscript(curSession);
				renderSidebar();
				closeSidebar();
			}
		},
	});
};

/* ---------------- modal dialog ---------------- */
let modalCallback = null;
function showModal({ title, msg, inputVal, showInput, confirmText, onConfirm, showPresets }) {
	$('#modal-title').textContent = title;
	$('#modal-msg').innerHTML = msg;
	const inp = $('#modal-input');
	const presets = $('#modal-presets');
	if (showInput) {
		inp.classList.remove('hidden');
		inp.value = inputVal || '';
		setTimeout(() => inp.focus(), 100);
	} else {
		inp.classList.add('hidden');
	}
	presets.classList.toggle('hidden', !showPresets);
	$('#modal-btn-confirm').textContent = confirmText || '确定';
	modalCallback = onConfirm;
	$('#modal').classList.remove('hidden');
	$('#modal-backdrop').classList.remove('hidden');
}
function hideModal() {
	$('#modal').classList.add('hidden');
	$('#modal-backdrop').classList.add('hidden');
	modalCallback = null;
}
$('#modal-btn-cancel').onclick = hideModal;
$('#modal-backdrop').onclick = hideModal;
$('#modal-btn-confirm').onclick = () => {
	if (modalCallback) {
		const val = $('#modal-input').value;
		modalCallback(val);
	}
	hideModal();
};
$$('#modal-presets button').forEach((b) => {
	b.onclick = () => { $('#modal-input').value = b.dataset.v; $('#modal-input').focus(); };
});

/* ---------------- Scope Badges Management ---------------- */
const scopeContainer = $('#scope-container');

function addScope(scope) {
	// Deduplicate
	const exists = attachedScopes.some((s) => s.type === scope.type && (s.path === scope.path || s.package === scope.package));
	if (!exists) {
		attachedScopes.push(scope);
		renderScopes();
	}
}

function removeScope(index) {
	attachedScopes.splice(index, 1);
	renderScopes();
}

function renderScopes() {
	scopeContainer.innerHTML = '';
	if (attachedScopes.length === 0) {
		scopeContainer.classList.add('hidden');
		return;
	}
	scopeContainer.classList.remove('hidden');

	attachedScopes.forEach((s, idx) => {
		const badge = el('div', `scope-badge ${s.type}`);
		let icon = '•';
		let text = s.name || s.path || s.package;

		if (s.type === 'app') {
			icon = '📱';
			text = `${s.name || s.package}`;
		} else if (s.type === 'folder') {
			icon = '📁';
			text = s.path;
		} else if (s.type === 'file') {
			icon = '📄';
			text = s.name || s.path.split('/').pop();
		} else if (s.type === 'path') {
			icon = '🎯';
			text = s.path;
		} else if (s.type === 'image') {
			if (s.dataUrl) {
				const img = el('img', 'scope-thumb');
				img.src = s.dataUrl;
				badge.appendChild(img);
			} else {
				icon = '📸';
			}
			text = s.name || '图片';
		}

		if (icon !== '•' && s.type !== 'image') {
			badge.appendChild(el('span', 'scope-ic', icon));
		}
		const txtSpan = el('span', 'scope-text', esc(text));
		badge.appendChild(txtSpan);

		const del = el('button', 'scope-del', '×');
		del.onclick = (e) => { e.stopPropagation(); removeScope(idx); };
		badge.appendChild(del);

		scopeContainer.appendChild(badge);
	});
}

/* ---------------- Attach Menu ([+]) ---------------- */
const btnAttach = $('#btn-attach');
const attachMenu = $('#attach-menu');
const attachBackdrop = $('#attach-backdrop');
const imgChoiceMenu = $('#image-choice-menu');
const filePickerImage = $('#file-picker-image');

function openAttachMenu() {
	attachMenu.classList.remove('hidden');
	attachBackdrop.classList.remove('hidden');
	imgChoiceMenu.classList.add('hidden');
}
function closeAttachMenu() {
	attachMenu.classList.add('hidden');
	imgChoiceMenu.classList.add('hidden');
	attachBackdrop.classList.add('hidden');
}

btnAttach.onclick = () => {
	if (attachMenu.classList.contains('hidden') && imgChoiceMenu.classList.contains('hidden')) openAttachMenu();
	else closeAttachMenu();
};
attachBackdrop.onclick = closeAttachMenu;

// Option 1: Image & Screenshot
$('#opt-image').onclick = () => {
	attachMenu.classList.add('hidden');
	imgChoiceMenu.classList.remove('hidden');
};
$('#btn-pick-album').onclick = () => {
	closeAttachMenu();
	filePickerImage.click();
};
$('#btn-take-shot').onclick = async () => {
	closeAttachMenu();
	sysline('正在截取当前手机屏幕…');
	const r = await api('/api/screenshot');
	if (r && r.ok) {
		addScope({ type: 'image', name: '当前屏幕截图', path: r.path });
		sysline('屏幕已截取并添加至上下文');
	} else {
		sysline('截图失败：' + (r?.error || ''));
	}
};
filePickerImage.onchange = () => {
	const f = filePickerImage.files[0];
	if (!f) return;
	const reader = new FileReader();
	reader.onload = async () => {
		const dataUrl = reader.result;
		const r = await api('/api/upload', { dataUrl, filename: f.name });
		if (r && r.ok) {
			addScope({ type: 'image', name: f.name, path: r.path, dataUrl });
		} else {
			sysline('图片上传失败：' + (r?.error || ''));
		}
	};
	reader.readAsDataURL(f);
	filePickerImage.value = '';
};

// Option 2: Select App
$('#opt-app').onclick = () => {
	closeAttachMenu();
	openAppsSheet();
};

// Option 3: Select Folder
$('#opt-folder').onclick = () => {
	closeAttachMenu();
	openFsSheet(true);
};

// Option 4: Select File
$('#opt-file').onclick = () => {
	closeAttachMenu();
	openFsSheet(false);
};

// Option 5: Custom Path
$('#opt-path').onclick = () => {
	closeAttachMenu();
	showModal({
		title: '指定目标路径',
		msg: '输入手机或系统内的绝对路径：',
		inputVal: '/sdcard/',
		showInput: true,
		showPresets: true,
		confirmText: '添加路径',
		onConfirm: (val) => {
			if (!val || !val.trim()) return;
			addScope({ type: 'path', path: val.trim() });
		},
	});
};

/* ---------------- Apps Sheet ---------------- */
let allApps = [];
const sheetApps = $('#sheet-apps');
const sheetAppsBackdrop = $('#sheet-apps-backdrop');
const appsList = $('#apps-list');
const inputSearchApp = $('#input-search-app');

async function openAppsSheet() {
	sheetApps.classList.remove('hidden');
	sheetAppsBackdrop.classList.remove('hidden');
	inputSearchApp.value = '';
	appsList.innerHTML = '<div class="empty-state">正在读取已安装应用…</div>';
	const r = await fetch('/api/apps').then((res) => res.json()).catch(() => null);
	if (r && r.ok) {
		allApps = r.apps || [];
		renderAppsList(allApps);
	} else {
		appsList.innerHTML = '<div class="empty-state">读取应用列表失败</div>';
	}
}
function closeAppsSheet() {
	sheetApps.classList.add('hidden');
	sheetAppsBackdrop.classList.add('hidden');
}
$('#btn-close-apps').onclick = closeAppsSheet;
$('#sheet-apps-backdrop').onclick = closeAppsSheet;

inputSearchApp.oninput = () => {
	const q = inputSearchApp.value.trim().toLowerCase();
	const filtered = allApps.filter((a) => (a.name || '').toLowerCase().includes(q) || (a.package || '').toLowerCase().includes(q));
	renderAppsList(filtered);
};

function renderAppsList(apps) {
	appsList.innerHTML = '';
	if (apps.length === 0) {
		appsList.innerHTML = '<div class="empty-state">未找到匹配的应用</div>';
		return;
	}
	apps.forEach((a) => {
		const item = el('div', 'app-item');
		item.innerHTML = `
			<div class="app-item-ic">📱</div>
			<div class="app-item-info">
				<span class="app-item-name">${esc(a.name)}</span>
				<span class="app-item-pkg">${esc(a.package)}</span>
			</div>
		`;
		item.onclick = () => {
			addScope({ type: 'app', name: a.name, package: a.package });
			closeAppsSheet();
		};
		appsList.appendChild(item);
	});
}

/* ---------------- Filesystem Sheet ---------------- */
const sheetFs = $('#sheet-fs');
const sheetFsBackdrop = $('#sheet-fs-backdrop');
const fsList = $('#fs-list');
const fsTitle = $('#fs-title');
const fsCurrentPath = $('#fs-current-path');
const fsBtnSelectDir = $('#fs-btn-select-dir');
let fsFolderMode = true;
let curFsPath = '/sdcard';
let parentFsPath = '/';

function openFsSheet(isFolderMode) {
	fsFolderMode = isFolderMode;
	fsTitle.textContent = isFolderMode ? '选择文件夹' : '选择文件';
	fsBtnSelectDir.textContent = isFolderMode ? '选择当前目录' : '选择当前目录作为范围';
	sheetFs.classList.remove('hidden');
	sheetFsBackdrop.classList.remove('hidden');
	if (fsSearchInput) { fsSearchInput.value = ''; toggleFsSearchClear(); }
	loadFsPath('/sdcard');
}
function closeFsSheet() {
	sheetFs.classList.add('hidden');
	sheetFsBackdrop.classList.add('hidden');
}
$('#btn-close-fs').onclick = closeFsSheet;
$('#sheet-fs-backdrop').onclick = closeFsSheet;

$$('.fs-preset-pill').forEach((b) => {
	b.onclick = () => loadFsPath(b.dataset.path);
});
$('#fs-btn-up').onclick = () => {
	if (parentFsPath && parentFsPath !== curFsPath) {
		loadFsPath(parentFsPath);
	}
};
fsBtnSelectDir.onclick = () => {
	addScope({ type: 'folder', name: curFsPath.split('/').pop() || curFsPath, path: curFsPath });
	closeFsSheet();
};

async function loadFsPath(p, q) {
	fsList.innerHTML = `<div class="empty-state">${q ? '正在搜索…' : '正在读取目录…'}</div>`;
	let u = `/api/fs?path=${encodeURIComponent(p)}`;
	if (q) u += `&q=${encodeURIComponent(q)}`;
	const r = await fetch(u).then((res) => res.json()).catch(() => null);
	if (r && r.ok) {
		if (!q) { curFsPath = r.currentPath; parentFsPath = r.parentPath; fsCurrentPath.textContent = curFsPath; }
		renderFsList(r.items || [], !!q);
	} else {
		fsList.innerHTML = `<div class="empty-state">无法访问目录: ${esc(r?.error || '')}</div>`;
	}
}

const FS_ICON = (item) => {
	if (item.isDir) return '📁';
	const k = item.kind;
	if (k === '图片') return '🖼'; if (k === 'APK') return '📦'; if (k === '视频') return '🎬';
	if (k === '音频') return '🎵'; if (k === 'PDF') return '📕'; if (k === '压缩包') return '🗜';
	if (k === '文本') return '📝'; if (k === '代码') return '💻'; if (k === '数据库') return '🗃'; if (k === '二进制') return '⚙️';
	return '📄';
};
function renderFsList(items, searched) {
	fsList.innerHTML = '';
	if (items.length === 0) {
		fsList.innerHTML = `<div class="empty-state">${searched ? '没有匹配的文件' : '此目录为空'}</div>`;
		return;
	}
	items.forEach((item) => {
		const row = el('div', 'fs-item');
		const meta = [item.kind, item.sizeText].filter(Boolean).join(' · ');
		// When searched, show the full path as sub-text so results from subfolders are clear.
		const sub = searched ? esc(item.path) : esc(meta);
		row.innerHTML = `
			<div class="fs-item-ic">${FS_ICON(item)}</div>
			<div class="fs-item-main">
				<div class="fs-item-name">${esc(item.name)}</div>
				<div class="fs-item-meta">${searched && meta ? esc(meta) + ' · ' : ''}${sub}</div>
			</div>
			${item.isDir ? '<svg class="fs-item-chev" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>' : ''}
		`;
		row.onclick = () => {
			if (item.isDir) { if (fsSearchInput) fsSearchInput.value = ''; toggleFsSearchClear(); loadFsPath(item.path); }
			else { addScope({ type: 'file', name: item.name, path: item.path }); closeFsSheet(); }
		};
		fsList.appendChild(row);
	});
}

// fs in-folder search
const fsSearchInput = $('#fs-search');
const fsSearchClear = $('#fs-search-clear');
function toggleFsSearchClear() { if (fsSearchClear) fsSearchClear.classList.toggle('hidden', !fsSearchInput || !fsSearchInput.value); }
let fsSearchTimer = null;
if (fsSearchInput) {
	fsSearchInput.addEventListener('input', () => {
		toggleFsSearchClear();
		clearTimeout(fsSearchTimer);
		const q = fsSearchInput.value.trim();
		fsSearchTimer = setTimeout(() => { if (q) loadFsPath(curFsPath, q); else loadFsPath(curFsPath); }, 350);
	});
}
if (fsSearchClear) fsSearchClear.onclick = () => { fsSearchInput.value = ''; toggleFsSearchClear(); loadFsPath(curFsPath); };

/* ---------------- Model Popover Menu (Matching User Screenshot) ---------------- */
const modelPopover = $('#model-popover');
const modelBackdrop = $('#model-backdrop');
const menuViewMain = $('#menu-view-main');
const menuViewEffort = $('#menu-view-effort');
const menuViewMore = $('#menu-view-more');

const EFFORT_LABELS = {
	low: '低',
	medium: '中',
	high: '高',
	xhigh: '超高',
	max: '最大',
};

function openModelPopover() {
	updateModelMenuUI();
	menuViewMain.classList.remove('hidden');
	menuViewEffort.classList.add('hidden');
	menuViewMore.classList.add('hidden');
	modelPopover.classList.remove('hidden');
	modelBackdrop.classList.remove('hidden');
}
function closeModelPopover() {
	modelPopover.classList.add('hidden');
	modelBackdrop.classList.add('hidden');
}

$('#btn-model-pill').onclick = () => {
	if (modelPopover.classList.contains('hidden')) openModelPopover();
	else closeModelPopover();
};
modelBackdrop.onclick = closeModelPopover;

// Navigation in Popover
$('#btn-open-effort').onclick = () => {
	menuViewMain.classList.add('hidden');
	menuViewEffort.classList.remove('hidden');
};
$('#btn-back-effort').onclick = () => {
	menuViewEffort.classList.add('hidden');
	menuViewMain.classList.remove('hidden');
};
$('#btn-open-more').onclick = () => {
	menuViewMain.classList.add('hidden');
	menuViewMore.classList.remove('hidden');
};
$('#btn-back-more').onclick = () => {
	menuViewMore.classList.add('hidden');
	menuViewMain.classList.remove('hidden');
};

function updateModelMenuUI() {
	$('#model-name-label').textContent = SETTINGS.modelName || 'Sonnet 5.5';
	const effStr = EFFORT_LABELS[SETTINGS.effort] || '超高';
	$('#effort-label').textContent = effStr;
	$('#popover-effort-val').textContent = effStr;

	// Checkmarks for primary and more models
	$$('.menu-item[data-model]').forEach((item) => {
		const m = item.dataset.model;
		const name = item.dataset.name;
		const isSel = (SETTINGS.model === m) || (SETTINGS.modelName === name);
		item.classList.toggle('selected', isSel);
	});

	// Checkmarks for effort
	$$('.effort-item[data-effort]').forEach((item) => {
		const eff = item.dataset.effort;
		item.classList.toggle('selected', SETTINGS.effort === eff);
	});

	// Fast mode toggle
	$('#t-fastmode').checked = !!SETTINGS.fastMode;
}

// Select Model from Main or More
$$('.menu-item[data-model]').forEach((item) => {
	item.onclick = () => {
		const m = item.dataset.model;
		const name = item.dataset.name;
		pushSettings({ model: m, modelName: name });
		closeModelPopover();
	};
});

// Select Effort
$$('.effort-item[data-effort]').forEach((item) => {
	item.onclick = () => {
		const eff = item.dataset.effort;
		pushSettings({ effort: eff });
		closeModelPopover();
	};
});

// Fast mode change
$('#t-fastmode').onchange = (e) => {
	pushSettings({ fastMode: e.target.checked });
};

/* ---------------- SSE ---------------- */
let es;
function connect() {
	es = new EventSource('/api/events');
	es.onopen = () => { statusEl.className = 'status on'; statusText.textContent = '就绪'; };
	es.onerror = () => { statusEl.className = 'status off'; statusText.textContent = '已断开'; };
	es.onmessage = (e) => {
		let m; try { m = JSON.parse(e.data); } catch { return; }
		// Every open conversation broadcasts on the same stream. Events that belong to some other
		// conversation than the one on screen must never touch the visible thread — they only
		// update the sidebar's live dot (via runningIds/pendingIds) so you can see it's still going.
		const mine = !m.sessionId || m.sessionId === curSession?.id;
		switch (m.type) {
			case 'hello':
				applySettings(m.settings);
				if (m.activeSession) {
					curSession = m.activeSession;
					renderTranscript(curSession);
				}
				fetchSessions();
				loadSlashCommands();
				break;
			case 'auth': if (!m.loggedIn) showLogin(); else hideLogin(); refreshAccountBadge(); break;
			case 'session': break;
			case 'session_switched':
				curSession = m.session;
				renderTranscript(curSession);
				setRunning(runningIds.has(m.session?.id));
				fetchSessions();
				loadSlashCommands();
				break;
			case 'sessions_updated':
				sessionsList = m.sessions || [];
				renderSidebar();
				break;
			case 'user_echo':
				if (m.sessionId) runningIds.add(m.sessionId);
				if (mine) fetchSessions();
				else renderSidebar();
				break;
			case 'assistant_delta': if (mine) appendAssistant(m.text); break;
			case 'assistant_text': if (mine) setAssistant(m.text); break;
			case 'assistant_end': if (mine) endAssistant(); break;
			case 'thinking_delta': if (mine && SETTINGS.thinking) addThinkDelta(m.text); break;
			case 'tool_use':
				if (m.kind === 'todo') { if (mine) upsertTodo(m.todos); }
				else if (mine) addTool(m.id, m.name, m.title, m.detail);
				break;
			case 'tool_result': if (mine) finishTool(m.id, m.ok, m.summary); break;
			case 'tool_denied': if (mine) sysline(`已拒绝：${m.title}（${m.reason}）`); break;
			case 'permission':
				if (m.sessionId) pendingIds.add(m.sessionId);
				if (mine) addPermission(m); else renderSidebar();
				break;
			case 'permission_resolved':
				if (m.sessionId) pendingIds.delete(m.sessionId);
				if (!mine) renderSidebar();
				break;
			case 'result':
				if (m.sessionId) runningIds.delete(m.sessionId);
				if (mine) {
					endAssistant();
					setRunning(false);
					if (m.subtype && m.subtype !== 'success') sysline(`结束：${m.subtype}`);
					fetchSessions();
				} else renderSidebar();
				break;
			case 'cleared':
				thread.innerHTML = ''; buildWelcome(); setRunning(false); curTodoEl = null;
				runningIds.clear(); pendingIds.clear();
				break;
			case 'settings': applySettings(m.settings); break;
			case 'skills_updated':
				if (!$('#sheet-skills').classList.contains('hidden')) loadSkills();
				loadSlashCommands();
				break;
			case 'mcp_updated': if (!$('#sheet-mcp').classList.contains('hidden')) loadMcp(); break;
			case 'systemprompt_saved': break;
			case 'error':
				if (m.sessionId) runningIds.delete(m.sessionId);
				if (mine) { endAssistant(); setRunning(false); sysline('错误：' + m.message); } else renderSidebar();
				break;
			case 'login_url': loginUrl(m.url); break;
			case 'login_need_code': break;
			case 'login_status': loginStatus(m); break;
			case 'login_done': loginDone(m.ok, m.message); break;
		}
	};
}

/* ---------------- slash commands ---------------- */
const slashMenu = $('#slash-menu');
async function loadSlashCommands() {
	const r = await fetch(`/api/commands?sessionId=${encodeURIComponent(curSession?.id || '')}`).then((x) => x.json()).catch(() => null);
	if (r && r.ok) slashCommands = r.commands || [];
}
function matchingCommands(query) {
	const q = query.toLowerCase();
	return slashCommands.filter((c) => c.name.toLowerCase().startsWith(q) || (c.aliases || []).some((a) => a.toLowerCase().startsWith(q))).slice(0, 6);
}
function renderSlashMenu(matches) {
	if (!matches.length) { slashMenu.classList.add('hidden'); slashMenu.innerHTML = ''; return; }
	slashMenu.innerHTML = matches.map((c, i) => `<button class="slash-item" data-i="${i}"><span class="slash-name">/${esc(c.name)}${c.argumentHint ? ' <span class=\"slash-hint\">' + esc(c.argumentHint) + '</span>' : ''}</span><span class="slash-desc">${esc(c.description || '')}</span></button>`).join('');
	slashMenu.classList.remove('hidden');
	slashMenu.querySelectorAll('.slash-item').forEach((btn, i) => { btn.onclick = () => chooseSlashCommand(matches[i]); });
}
function chooseSlashCommand(cmd) {
	slashMenu.classList.add('hidden');
	if (cmd.name === 'model') { input.value = ''; autsize(); openModelPopover(); return; }
	if (cmd.name === 'clear') { input.value = ''; autsize(); createNewChat(); return; }
	// Everything else: fill it in and let the user add arguments / hit send themselves, same as
	// picking a command from the terminal's own "/" menu — it's sent through as a normal message
	// and the underlying `claude` process (the same binary the terminal drives) handles it.
	input.value = '/' + cmd.name + ' ';
	autsize();
	input.focus();
}
function checkSlashInput() {
	const v = input.value;
	const m = v.match(/^\/(\S*)$/);
	if (!m) { slashMenu.classList.add('hidden'); return; }
	renderSlashMenu(matchingCommands(m[1]));
}

/* ---------------- composer & prompt assembling ---------------- */
const input = $('#input');
function autsize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.35) + 'px'; }
input.addEventListener('input', () => { autsize(); checkSlashInput(); });
input.addEventListener('keydown', (e) => {
	if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); slashMenu.classList.add('hidden'); send(); }
	else if (e.key === 'Escape' && !slashMenu.classList.contains('hidden')) { slashMenu.classList.add('hidden'); }
});

async function send() {
	const rawText = input.value.trim();
	if (!rawText && attachedScopes.length === 0) return;
	// Deliberately allowed even while already running: the backend queues it onto this
	// conversation's existing turn, same as typing ahead in the terminal while Claude is still working.

	let fullPrompt = rawText;
	if (attachedScopes.length > 0) {
		const scopeLines = attachedScopes.map((s) => {
			if (s.type === 'app') return `- 手机应用: ${s.name} (${s.package})`;
			if (s.type === 'folder') return `- 目标文件夹: ${s.path}`;
			if (s.type === 'file') return `- 目标文件: ${s.path}`;
			if (s.type === 'path') return `- 自定义路径: ${s.path}`;
			if (s.type === 'image') return `- 附件图片: ${s.path}`;
			return '';
		}).filter(Boolean).join('\n');

		fullPrompt = `【指定操作范围与上下文】\n${scopeLines}\n\n【用户指令】\n${rawText || '请根据上述指定的上下文进行分析或处理。'}`;
	}

	addUser(rawText || fullPrompt);
	input.value = '';
	autsize();
	const sid = curSession?.id;
	setRunning(true);
	runningIds.add(sid);

	const scopesToSend = [...attachedScopes];
	attachedScopes = [];
	renderScopes();

	const r = await api('/api/send', { text: fullPrompt, scopes: scopesToSend, sessionId: sid });
	if (!r.ok) {
		runningIds.delete(sid);
		if (curSession?.id === sid) setRunning(false);
		sysline('发送失败：' + (r.error || ''));
	}
	fetchSessions();
}

$('#btn-send').onclick = send;
// Stops only this one conversation's current turn (like Esc in the terminal) — the conversation
// itself, and anything else running in the background, is untouched.
$('#btn-stop').onclick = () => {
	api('/api/stop', { sessionId: curSession?.id });
	setRunning(false);
	if (curSession) runningIds.delete(curSession.id);
};

/* ---------------- welcome suggestions ---------------- */
const SUGGESTIONS = [
	['phone', '看看现在屏幕上是什么'],
	['disk', '哪些应用最占空间？'],
	['battery', '查电池温度和健康度'],
	['restart', '最近一次重启是什么原因'],
	['file', '列出内部存储里最大的文件'],
];
function buildWelcome() {
	const w = el('div', 'welcome', `${MARK_SVG}<h1>想让手机做什么？</h1><p>我在这台手机的 Linux 环境里，有 root 权限：能管理文件、应用和进程，也能看屏幕、替你点按。</p><div class="suggest"></div>`);
	w.id = 'welcome'; const sg = w.querySelector('.suggest');
	SUGGESTIONS.forEach(([ic, t]) => {
		const b = el('button', null, `${icon(ic, 18)}<span></span><span class="go">${icon('chev', 16)}</span>`);
		b.querySelector('span').textContent = t;
		b.onclick = () => { input.value = t; send(); };
		sg.appendChild(b);
	});
	thread.appendChild(w);
}

/* ---------------- general settings ---------------- */
function applySettings(s) {
	Object.assign(SETTINGS, s);
	updateModelMenuUI();
	document.querySelectorAll('#seg-mode button').forEach((b) => b.classList.toggle('sel', b.dataset.v === SETTINGS.mode));
	$('#t-readonly').checked = SETTINGS.readonly;
	$('#t-screen').checked = SETTINGS.screen;
	$('#t-web').checked = SETTINGS.web;
	$('#t-thinking').checked = SETTINGS.thinking;
	$('#t-personal').checked = !!SETTINGS.personalData;
}
function pushSettings(patch) {
	Object.assign(SETTINGS, patch);
	updateModelMenuUI();
	api('/api/settings', patch);
}

document.querySelectorAll('#seg-mode button').forEach((b) => b.onclick = () => { pushSettings({ mode: b.dataset.v }); applySettings(SETTINGS); });
$('#t-readonly').onchange = (e) => pushSettings({ readonly: e.target.checked });
$('#t-screen').onchange = (e) => pushSettings({ screen: e.target.checked });
$('#t-web').onchange = (e) => pushSettings({ web: e.target.checked });
$('#t-thinking').onchange = (e) => pushSettings({ thinking: e.target.checked });
$('#t-personal').onchange = (e) => pushSettings({ personalData: e.target.checked });

function openSheet() { $('#sheet').classList.remove('hidden'); $('#sheet-backdrop').classList.remove('hidden'); }
function closeSheet() { $('#sheet').classList.add('hidden'); $('#sheet-backdrop').classList.add('hidden'); }
$('#btn-settings').onclick = () => { openSheet(); syncOverlayToggle(); setTheme(currentTheme()); };
$('#theme-seg').onclick = (e) => { const b = e.target.closest('button'); if (b) setTheme(b.dataset.v); };
$('#sheet-close').onclick = closeSheet;
$('#sheet-backdrop').onclick = closeSheet;

/* ---------------- advanced managers (usage / system prompt / skills / MCP) ---------------- */
function openModal(id) { $('#' + id).classList.remove('hidden'); $('#' + id + '-backdrop').classList.remove('hidden'); }
function closeModal(id) { $('#' + id).classList.add('hidden'); $('#' + id + '-backdrop').classList.add('hidden'); }

// ---- Account (everything `claude auth status` knows) ----
const SUBSCRIPTION_LABEL = { pro: 'Pro 订阅', max: 'Max 订阅', max5x: 'Max 5x 订阅', max20x: 'Max 20x 订阅', team: '团队版', enterprise: '企业版' };
const AUTH_METHOD_LABEL = { 'claude.ai': 'Claude 账号网页登录' };
const API_PROVIDER_LABEL = { firstParty: 'Anthropic 官方', bedrock: 'AWS Bedrock', vertex: 'Google Vertex', foundry: 'Azure Foundry', gateway: '企业网关' };
function accountRow(label, value) {
	if (value == null || value === '') return '';
	return `<div class="acct-row"><span class="acct-label">${esc(label)}</span><span class="acct-value">${esc(String(value))}</span></div>`;
}
async function refreshAccountBadge() {
	const r = await fetch('/api/account').then((x) => x.json()).catch(() => ({ ok: false }));
	const el = $('#avatar-initial');
	if (!el) return;
	const email = r.ok && r.account ? r.account.email : '';
	el.textContent = email ? email.trim()[0].toUpperCase() : '·';
	$('#btn-account').classList.toggle('logged-out', !email);
}
async function loadAccount() {
	const body = $('#account-body');
	body.innerHTML = '<div class="empty-state">正在读取…</div>';
	const r = await fetch('/api/account').then((x) => x.json()).catch(() => ({ ok: false }));
	if (!r.ok || !r.account) {
		body.innerHTML = `<div class="acct-empty"><div class="acct-avatar big">·</div><div class="acct-empty-title">尚未登录</div><div class="acct-empty-sub">用 Claude 订阅账号登录后，这里会显示邮箱、组织和订阅信息。</div></div><button class="primary" id="account-login">去登录</button>`;
		$('#account-login').onclick = () => { closeModal('sheet-account'); showLogin(); };
		return;
	}
	const a = r.account;
	const initial = (a.email || '?').trim()[0]?.toUpperCase() || '?';
	let html = `<div class="acct-head"><div class="acct-avatar">${esc(initial)}</div><div class="acct-id"><div class="acct-email">${esc(a.email || '未知邮箱')}</div><div class="acct-org">${esc(a.orgName || a.organization || '')}</div></div></div>`;
	html += '<div class="acct-list">';
	html += accountRow('订阅类型', SUBSCRIPTION_LABEL[a.subscriptionType] || a.subscriptionType);
	html += accountRow('登录方式', AUTH_METHOD_LABEL[a.authMethod] || a.authMethod);
	html += accountRow('服务提供方', API_PROVIDER_LABEL[a.apiProvider] || a.apiProvider);
	html += accountRow('组织 ID', a.orgId);
	html += accountRow('使用数据采集', a.analyticsDisabled ? '已关闭' : '已开启');
	html += accountRow('配置目录', a.configDirectory);
	html += accountRow('项目目录', a.projectsDirectory);
	html += '</div>';
	html += `<button class="ghost small danger" id="account-logout">退出登录</button>`;
	body.innerHTML = html;
	$('#account-logout').onclick = () => {
		showModal({
			title: '退出登录', msg: '退出后需要重新走一遍登录流程才能继续对话，确定退出吗？', showInput: false, confirmText: '退出登录',
			onConfirm: async () => { await api('/api/account/logout'); closeModal('sheet-account'); closeSheet(); refreshAccountBadge(); },
		});
	};
}
// ---- Floating bubble (only exists inside the native app shell) ----
function syncOverlayToggle() {
	if (!window.AgentHost) return;              // plain browser — row stays hidden
	$('#row-overlay').classList.remove('hidden');
	$('#t-overlay').checked = !!window.AgentHost.enabled();
}
if (window.AgentHost) {
	$('#t-overlay').onchange = (e) => { window.AgentHost.setEnabled(e.target.checked); };
}

$('#btn-account').onclick = () => { openModal('sheet-account'); loadAccount(); };
$('#entry-account').onclick = () => { closeSheet(); openModal('sheet-account'); loadAccount(); };
$('#btn-close-account').onclick = () => closeModal('sheet-account');
$('#sheet-account-backdrop').onclick = () => closeModal('sheet-account');

// ---- Usage ----
function fmtReset(iso) {
	if (!iso) return '';
	const t = new Date(iso).getTime(); if (isNaN(t)) return '';
	const diff = t - Date.now();
	if (diff <= 0) return '即将重置';
	const h = Math.floor(diff / 3600000), m = Math.floor((diff % 3600000) / 60000);
	return h > 0 ? `${h} 小时 ${m} 分后重置` : `${m} 分后重置`;
}
function usageBar(label, win) {
	if (!win) return '';
	const u = win.utilization == null ? null : Math.round(win.utilization);
	const pct = u == null ? 0 : Math.min(100, u);
	const cls = pct >= 90 ? 'high' : pct >= 60 ? 'mid' : 'low';
	return `<div class="usage-row"><div class="usage-top"><span>${label}</span><span class="usage-pct">${u == null ? '—' : u + '%'}</span></div>
		<div class="usage-track"><div class="usage-fill ${cls}" style="width:${pct}%"></div></div>
		<div class="usage-reset">${esc(fmtReset(win.resets_at))}</div></div>`;
}
async function loadUsage() {
	const body = $('#usage-body');
	body.innerHTML = '<div class="empty-state">正在读取…</div>';
	const r = await fetch('/api/usage').then((x) => x.json()).catch(() => ({ ok: false }));
	if (!r.ok) { body.innerHTML = `<div class="empty-state">读取失败：${esc(r.error || '')}</div>`; return; }
	if (!r.rate_limits_available || !r.rate_limits) { body.innerHTML = '<div class="empty-state">当前账号没有额度窗口（可能用的是 API key 或组织账号）。</div>'; return; }
	const rl = r.rate_limits;
	let html = '';
	html += usageBar('5 小时窗口', rl.five_hour);
	html += usageBar('每周窗口', rl.seven_day);
	html += usageBar('每周 · Opus', rl.seven_day_opus);
	html += usageBar('每周 · Sonnet', rl.seven_day_sonnet);
	if (r.cost != null) html += `<div class="usage-cost">本会话花费 ≈ $${Number(r.cost).toFixed(4)}</div>`;
	body.innerHTML = html || '<div class="empty-state">暂无数据</div>';
}
$('#entry-usage').onclick = () => { closeSheet(); openModal('sheet-usage'); loadUsage(); };
$('#btn-close-usage').onclick = () => closeModal('sheet-usage');
$('#sheet-usage-backdrop').onclick = () => closeModal('sheet-usage');
$('#usage-refresh').onclick = () => { fetch('/api/usage?fresh=1').then(() => loadUsage()); };

// ---- System prompt ----
$('#entry-sysprompt').onclick = async () => {
	closeSheet();
	const r = await fetch('/api/systemprompt').then((x) => x.json()).catch(() => ({ ok: false }));
	$('#sysprompt-text').value = (r && r.ok) ? (r.text || '') : '';
	openModal('sheet-sysprompt');
};
$('#btn-close-sysprompt').onclick = () => closeModal('sheet-sysprompt');
$('#sheet-sysprompt-backdrop').onclick = () => closeModal('sheet-sysprompt');
$('#sysprompt-cancel').onclick = () => closeModal('sheet-sysprompt');
$('#sysprompt-save').onclick = async () => {
	await api('/api/systemprompt', { text: $('#sysprompt-text').value });
	closeModal('sheet-sysprompt');
	sysline('系统提示词已保存，下一条消息起生效。');
};

// ---- Skills ----
async function loadSkills() {
	const list = $('#skills-list');
	list.innerHTML = '<div class="empty-state">正在读取…</div>';
	const r = await fetch('/api/skills').then((x) => x.json()).catch(() => ({ ok: false }));
	if (!r.ok) { list.innerHTML = '<div class="empty-state">读取失败</div>'; return; }
	if (!r.skills.length) { list.innerHTML = '<div class="empty-state">还没有安装任何 Skill。用上方输入框从 GitHub 安装。</div>'; return; }
	list.innerHTML = '';
	r.skills.forEach((s) => {
		const row = el('div', 'manage-item');
		row.innerHTML = `<div class="manage-info"><div class="manage-name">${esc(s.name)}</div><div class="manage-desc">${esc(s.description || s.id)}</div></div>
			<label class="sw"><input type="checkbox" ${s.enabled ? 'checked' : ''}><i></i></label>
			<button class="manage-del" aria-label="删除">🗑</button>`;
		row.querySelector('input').onchange = (e) => api('/api/skills/toggle', { id: s.id, enabled: e.target.checked });
		row.querySelector('.manage-del').onclick = () => {
			showModal({ title: '删除 Skill', msg: `确定删除「${esc(s.name)}」吗？`, confirmText: '删除', onConfirm: async () => { await api('/api/skills/delete', { id: s.id }); loadSkills(); } });
		};
		list.appendChild(row);
	});
}
$('#entry-skills').onclick = () => { closeSheet(); openModal('sheet-skills'); $('#skill-msg').textContent = ''; loadSkills(); };
$('#btn-close-skills').onclick = () => closeModal('sheet-skills');
$('#sheet-skills-backdrop').onclick = () => closeModal('sheet-skills');
$('#skill-install').onclick = async () => {
	const src = $('#skill-src').value.trim(); if (!src) return;
	const msg = $('#skill-msg'); msg.className = 'sheet-msg wait'; msg.textContent = '正在安装…';
	const r = await api('/api/skills/install', { source: src });
	if (r.ok) { msg.className = 'sheet-msg ok'; msg.textContent = '安装成功'; $('#skill-src').value = ''; loadSkills(); }
	else { msg.className = 'sheet-msg err'; msg.textContent = '失败：' + (r.error || ''); }
};

// ---- MCP ----
let mcpType = 'http';
function renderMcpType() {
	$$('#mcp-type-seg button').forEach((b) => b.classList.toggle('sel', b.dataset.v === mcpType));
	const net = mcpType === 'http' || mcpType === 'sse';
	$('#mcp-url').classList.toggle('hidden', !net);
	$('#mcp-bearer').classList.toggle('hidden', !net);
	$('#mcp-command').classList.toggle('hidden', net);
	$('#mcp-args').classList.toggle('hidden', net);
}
$$('#mcp-type-seg button').forEach((b) => b.onclick = () => { mcpType = b.dataset.v; renderMcpType(); });
const MCP_STATUS_LABEL = { connected: '已连接', failed: '失败', 'needs-auth': '待授权', pending: '连接中', disabled: '已停用' };
async function loadMcp() {
	const list = $('#mcp-list');
	list.innerHTML = '<div class="empty-state">正在读取…</div>';
	const r = await fetch('/api/mcp').then((x) => x.json()).catch(() => ({ ok: false }));
	if (!r.ok) { list.innerHTML = '<div class="empty-state">读取失败</div>'; return; }
	const names = Object.keys(r.servers || {});
	if (!names.length) { list.innerHTML = '<div class="empty-state">还没有 MCP 服务器。下方添加一个。</div>'; return; }
	const statusByName = {};
	(r.status || []).forEach((s) => { statusByName[s.name] = s; });
	list.innerHTML = '';
	names.forEach((name) => {
		const cfg = r.servers[name];
		const st = statusByName[name];
		const statusKey = cfg.disabled ? 'disabled' : (st ? st.status : 'pending');
		const toolCount = st && st.tools ? st.tools.length : null;
		const row = el('div', 'manage-item');
		row.innerHTML = `<div class="manage-info"><div class="manage-name">${esc(name)} <span class="mcp-badge ${statusKey}">${MCP_STATUS_LABEL[statusKey] || statusKey}</span></div>
			<div class="manage-desc">${esc(cfg.type)}${cfg.url ? ' · ' + esc(cfg.url) : cfg.command ? ' · ' + esc(cfg.command) : ''}${toolCount != null ? ' · ' + toolCount + ' 个工具' : ''}</div></div>
			<label class="sw"><input type="checkbox" ${cfg.disabled ? '' : 'checked'}><i></i></label>
			<button class="manage-del" aria-label="删除">🗑</button>`;
		row.querySelector('input').onchange = (e) => api('/api/mcp/toggle', { name, enabled: e.target.checked }).then(() => setTimeout(loadMcp, 800));
		row.querySelector('.manage-del').onclick = () => {
			showModal({ title: '删除 MCP', msg: `确定删除「${esc(name)}」吗？`, confirmText: '删除', onConfirm: async () => { await api('/api/mcp/remove', { name }); loadMcp(); } });
		};
		list.appendChild(row);
	});
}
$('#entry-mcp').onclick = () => { closeSheet(); openModal('sheet-mcp'); $('#mcp-msg').textContent = ''; renderMcpType(); loadMcp(); };
$('#btn-close-mcp').onclick = () => closeModal('sheet-mcp');
$('#sheet-mcp-backdrop').onclick = () => closeModal('sheet-mcp');
$('#mcp-add').onclick = async () => {
	const name = $('#mcp-name').value.trim();
	const payload = { name, type: mcpType };
	if (mcpType === 'stdio') {
		payload.command = $('#mcp-command').value.trim();
		payload.args = $('#mcp-args').value.trim() ? $('#mcp-args').value.trim().split(/\s+/) : [];
	} else {
		payload.url = $('#mcp-url').value.trim();
		if ($('#mcp-bearer').value.trim()) payload.bearer = $('#mcp-bearer').value.trim();
	}
	const msg = $('#mcp-msg'); msg.className = 'sheet-msg wait'; msg.textContent = '正在添加…';
	const r = await api('/api/mcp/add', payload);
	if (r.ok) { msg.className = 'sheet-msg ok'; msg.textContent = '已添加'; $('#mcp-name').value = ''; $('#mcp-url').value = ''; $('#mcp-bearer').value = ''; $('#mcp-command').value = ''; $('#mcp-args').value = ''; setTimeout(loadMcp, 1000); }
	else { msg.className = 'sheet-msg err'; msg.textContent = '失败：' + (r.error || ''); }
};

/* ---------------- login ---------------- */
function showLogin() { $('#login').classList.remove('hidden'); loadProxy(); }
function hideLogin() { $('#login').classList.add('hidden'); }
function setLoginMsg(kind, text) { const m = $('#login-msg'); m.className = 'login-msg' + (kind ? ' ' + kind : ''); m.textContent = text || ''; }
function loginWaiting(on) {
	$('#login-start').classList.toggle('hidden', on);
	$('#login-wait').classList.toggle('hidden', !on);
}
// While the code is being verified: seconds so far and what claude last printed, so a slow
// exchange visibly moves instead of looking frozen. A way out appears after 20 s.
let verifyTimer = null;
let verifyStart = 0;
let verifyLine = '';
function verifyText() {
	const secs = Math.round((Date.now() - verifyStart) / 1000);
	let t = `正在验证授权码…（${secs} 秒）`;
	if (verifyLine) t += `\nclaude：${verifyLine}`;
	if (secs >= 20) t += '\n超过半分钟还没结果，多半是手机里的 Linux 环境连不上 Claude。可以点「取消」，在下方「网络代理」填好端口后重新登录。';
	return t;
}
function startVerify() {
	stopVerify();
	verifyStart = Date.now();
	verifyLine = '';
	setLoginMsg('wait', verifyText());
	verifyTimer = setInterval(() => {
		setLoginMsg('wait', verifyText());
		if (Date.now() - verifyStart >= 20000) $('#login-cancel').classList.remove('hidden');
	}, 1000);
}
function stopVerify() {
	if (verifyTimer) clearInterval(verifyTimer);
	verifyTimer = null;
	$('#login-cancel').classList.add('hidden');
}
function backToStart(label) {
	stopVerify();
	loginWaiting(false);
	$('#login-submit').disabled = false;
	$('#login-step2').classList.add('hidden');
	$('#login-step1').classList.remove('hidden');
	$('#login-start').textContent = label || '重新开始登录';
}
$('#login-cancel').onclick = () => {
	api('/api/login/cancel');
	backToStart();
	setLoginMsg('', '');
	$('#login-net').open = true;
};
function loginStatus(m) {
	if (m.proxy) {
		$('#login-proxy').value = m.proxy;
		$('#entry-proxy-sub').textContent = m.proxy;
	}
	if (m.kind === 'cli') {
		if (!verifyTimer) return;
		verifyLine = m.text;
		setLoginMsg('wait', verifyText());
		return;
	}
	if (m.kind === 'warn') $('#login-net').open = true;
	setLoginMsg(m.kind === 'warn' ? 'err' : m.kind === 'ok' ? 'ok' : 'wait', m.text);
}
$('#login-start').onclick = () => {
	setLoginMsg('', '');
	loginWaiting(true);
	api('/api/login/start');
};
function loginUrl(url) {
	loginWaiting(false);
	$('#login-step1').classList.add('hidden');
	$('#login-step2').classList.remove('hidden');
	const a = $('#login-url'); a.href = url; a.dataset.url = url;
	$('#login-code').value = '';
	$('#login-submit').disabled = false;
	// Keep what the network check concluded (proxy switched / unreachable); drop "checking…".
	if ($('#login-msg').classList.contains('wait')) setLoginMsg('', '');
}
$('#login-copy').onclick = () => {
	const url = $('#login-url').dataset.url || '';
	const done = () => setLoginMsg('ok', '链接已复制，可以粘贴到任意浏览器里打开');
	if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => setLoginMsg('err', '复制失败，请长按「打开登录页」复制'));
	else setLoginMsg('err', '复制失败，请长按「打开登录页」复制');
};
$('#login-submit').onclick = async () => {
	const code = $('#login-code').value.trim();
	if (!code) { setLoginMsg('err', '先把授权码粘贴到上面的输入框'); $('#login-code').focus(); return; }
	$('#login-submit').disabled = true;
	startVerify();
	const r = await api('/api/login/code', { code });
	if (!r.ok) {
		backToStart();
		setLoginMsg('err', r.error || '登录会话已超时，请重新开始登录');
	}
};
function loginDone(ok, message) {
	stopVerify();
	loginWaiting(false);
	$('#login-submit').disabled = false;
	if (ok) { setLoginMsg('ok', '登录成功'); setTimeout(hideLogin, 800); return; }
	backToStart();
	setLoginMsg('err', '登录失败：' + (message || '请重试'));
	// Can't reach Anthropic from here: point at the proxy setting right away.
	if (/连接|连不上|网络|代理|回应|ETIMEDOUT|ECONN|ENOTFOUND|fetch failed/i.test(message || '')) $('#login-net').open = true;
}

/* ---------------- network proxy ---------------- */
async function loadProxy() {
	const r = await fetch('/api/proxy').then((x) => x.json()).catch(() => null);
	if (!r || !r.ok) return '';
	$('#login-proxy').value = r.proxy || '';
	if (r.proxy) $('#login-net').open = true;
	$('#entry-proxy-sub').textContent = r.proxy || '直连';
	return r.proxy || '';
}
async function saveProxy(value) {
	const r = await api('/api/proxy', { proxy: String(value || '').trim() });
	if (r.ok) $('#entry-proxy-sub').textContent = r.proxy || '直连';
	return r;
}
$('#login-proxy-save').onclick = async () => {
	setLoginMsg('wait', '正在保存并测试能否连上 Claude…');
	const r = await saveProxy($('#login-proxy').value);
	if (!r.ok) return setLoginMsg('err', r.error || '保存失败');
	const where = r.proxy ? `代理 ${r.proxy}` : '直连';
	if (r.reachable) setLoginMsg('ok', `已保存。${where}可以连上 Claude，现在可以登录了。`);
	else setLoginMsg('err', `已保存，但${where}连不上 Claude（${r.summary}）。请检查端口是否正确、代理软件是否在运行。`);
};
$('#entry-proxy').onclick = async () => {
	const cur = await loadProxy();
	showModal({
		title: '网络代理',
		msg: '当前网络连不上 Claude 时，填写代理软件的本地 HTTP 端口，例如 <code>http://127.0.0.1:7890</code>。留空就是直连。',
		showInput: true,
		inputVal: cur,
		confirmText: '保存',
		onConfirm: async (v) => {
			const r = await saveProxy(v);
			if (!r.ok) showModal({ title: '没有保存', msg: esc(r.error || '格式不对'), confirmText: '知道了' });
			else if (!r.reachable) showModal({ title: '已保存，但连不上 Claude', msg: esc(`${r.proxy ? '代理 ' + r.proxy : '直连'}：${r.summary}`), confirmText: '知道了' });
		},
	});
};
loadProxy();

buildWelcome();
connect();
fetchSessions();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
