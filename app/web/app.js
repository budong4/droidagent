'use strict';
/* DroidAgent chat page. Plain DOM, no framework: the server streams events over SSE and this
   file turns them into the thread; everything else is menus, pages and settings around it. */

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => root.querySelectorAll(s);
const api = (path, bodyObj) =>
	fetch(path, bodyObj ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodyObj) } : { method: 'POST' })
		.then((r) => r.json())
		.catch(() => ({ ok: false }));
const getJSON = (path) => fetch(path).then((r) => r.json()).catch(() => ({ ok: false }));
const LOOK = window.DA_LOOK;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
const ic = (id, cls = '') => `<svg class="ic ${cls}"><use href="#${id}"/></svg>`;

const thread = $('#thread');
const input = $('#input');
const chatTitle = $('#chat-title');

/* ================================================================ motion & layers */
// Things that open (menus, sheets, pages, the drawer, dialogs) animate in with an .open class
// and leave the DOM flow (.hidden) once they have animated out.
function show(e) {
	e.classList.remove('hidden');
	void e.offsetWidth; // start the transition from the closed state
	e.classList.add('open');
}
function hide(e) {
	e.classList.remove('open');
	const done = () => { if (!e.classList.contains('open')) e.classList.add('hidden'); };
	if (REDUCED) done(); else setTimeout(done, 320);
}

// The phone's back button closes whatever is on top. One history entry stands in for all open
// layers: back pops the top one and re-arms the entry while anything else is still open.
const layers = [];
let armed = false;
let ignorePop = 0;
let syncQueued = false;
function syncHistory() {
	if (syncQueued) return;
	syncQueued = true;
	setTimeout(() => {
		syncQueued = false;
		const want = layers.length > 0;
		if (want && !armed) { history.pushState({ da: 1 }, ''); armed = true; }
		else if (!want && armed) { armed = false; ignorePop++; history.back(); }
	}, 0);
}
function openLayer(name, close) { layers.push({ name, close }); syncHistory(); }
function closeLayer(name) {
	const i = layers.map((l) => l.name).lastIndexOf(name);
	if (i < 0) return false;
	const [l] = layers.splice(i, 1);
	l.close();
	syncHistory();
	return true;
}
function closeTop() { const l = layers.pop(); if (l) { l.close(); syncHistory(); } }
function closeAll() { while (layers.length) layers.pop().close(); syncHistory(); }
addEventListener('popstate', () => {
	if (ignorePop > 0) { ignorePop--; return; }
	armed = false;
	const l = layers.pop();
	if (l) l.close();
	syncHistory();
});
addEventListener('keydown', (e) => { if (e.key === 'Escape' && layers.length) { e.preventDefault(); closeTop(); } });

/* ---------------- popover menus ---------------- */
let openMenuId = null;
function openMenu(id, anchor, onClose) {
	if (openMenuId) closeLayer('menu');
	const m = $('#' + id);
	const scrim = $('#menu-scrim');
	m.classList.remove('hidden', 'open');
	m.style.left = '0px'; m.style.top = '0px'; m.style.bottom = 'auto';
	const r = anchor.getBoundingClientRect();
	const vw = innerWidth, vh = innerHeight;
	const mw = Math.min(m.offsetWidth, vw - 24);
	// Line the menu up with the button's near edge, kept on screen.
	const wanted = r.left + r.width / 2 < vw / 2 ? r.left - 4 : r.right - mw + 4;
	const left = Math.max(12, Math.min(wanted, vw - mw - 12));
	const above = r.top > vh / 2;
	m.style.left = left + 'px';
	if (above) { m.style.top = 'auto'; m.style.bottom = (vh - r.top + 8) + 'px'; m.style.maxHeight = (r.top - 20) + 'px'; }
	else { m.style.top = (r.bottom + 8) + 'px'; m.style.maxHeight = (vh - r.bottom - 20) + 'px'; }
	m.style.setProperty('--origin', `${Math.round(r.left + r.width / 2 - left)}px ${above ? '100%' : '0'}`);
	scrim.classList.remove('hidden');
	show(m);
	openMenuId = id;
	openLayer('menu', () => {
		hide(m);
		scrim.classList.add('hidden');
		openMenuId = null;
		if (onClose) onClose();
	});
}
$('#menu-scrim').addEventListener('click', () => closeLayer('menu'));
function closeMenu() { closeLayer('menu'); }

/* ---------------- bottom sheets ---------------- */
function openSheet(id) {
	const s = $('#' + id), scrim = $('#sheet-scrim');
	show(scrim); show(s);
	openLayer('sheet', () => { hide(s); hide(scrim); });
}
$('#sheet-scrim').addEventListener('click', () => closeLayer('sheet'));
$$('.sheet-close').forEach((b) => b.addEventListener('click', () => closeLayer('sheet')));

/* ---------------- full-screen pages ---------------- */
const pageStack = [];
const PAGE_OPEN = {};   // id -> fn run each time the page opens
function underOf(depth) { return depth > 0 ? $('#' + pageStack[depth - 1]) : $('#app'); }
function openPage(id) {
	if (pageStack.includes(id)) return;
	const p = $('#' + id);
	underOf(pageStack.length).classList.add('pushed');
	pageStack.push(id);
	const body = $('.page-body', p);
	if (body) body.scrollTop = 0;
	show(p);
	openLayer('page:' + id, () => {
		const i = pageStack.lastIndexOf(id);
		if (i < 0) return;
		pageStack.splice(i, 1);
		hide(p);
		underOf(i).classList.remove('pushed');
	});
	if (PAGE_OPEN[id]) PAGE_OPEN[id]();
}
function closePage(id) { closeLayer('page:' + id); }
$$('.page').forEach((p) => $('.page-back', p).addEventListener('click', () => closePage(p.id)));
$$('[data-page]').forEach((b) => b.addEventListener('click', () => openPage(b.dataset.page)));

/* ---------------- dialog ---------------- */
let dialogOk = null;
function showDialog({ title, msg = '', html = false, input: withInput = false, value = '', presets = false, ok = '确定', cancel = '取消', danger = false, onOk }) {
	$('#dialog-title').textContent = title;
	const m = $('#dialog-msg');
	if (html) m.innerHTML = msg; else m.textContent = msg;
	const inp = $('#dialog-input');
	inp.classList.toggle('hidden', !withInput);
	inp.value = value;
	$('#dialog-presets').classList.toggle('hidden', !presets);
	$('#dialog-ok').textContent = ok;
	$('#dialog-ok').classList.toggle('danger', danger);
	$('#dialog-cancel').textContent = cancel;
	$('#dialog-cancel').classList.toggle('hidden', !cancel);
	dialogOk = onOk || null;
	const d = $('#dialog'), scrim = $('#dialog-scrim');
	show(scrim); show(d);
	openLayer('dialog', () => { hide(d); hide(scrim); });
	if (withInput) setTimeout(() => { inp.focus(); inp.select(); }, 120);
}
$('#dialog-cancel').addEventListener('click', () => closeLayer('dialog'));
$('#dialog-scrim').addEventListener('click', () => closeLayer('dialog'));
$('#dialog-ok').addEventListener('click', () => {
	const fn = dialogOk, v = $('#dialog-input').value;
	closeLayer('dialog');
	if (fn) fn(v);
});
$('#dialog-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#dialog-ok').click(); } });
$$('#dialog-presets button').forEach((b) => b.addEventListener('click', () => { $('#dialog-input').value = b.dataset.v; $('#dialog-input').focus(); }));

/* ---------------- toast ---------------- */
let toastTimer = null;
function toast(text) {
	const t = $('#toast');
	t.textContent = text;
	show(t);
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => hide(t), 1900);
}
function copyText(text, done = '已复制') {
	const ok = () => toast(done);
	if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(ok, () => legacyCopy(text) && ok());
	if (legacyCopy(text)) ok(); else toast('复制失败，请长按文字手动复制');
}
function legacyCopy(text) {
	const ta = el('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
	document.body.appendChild(ta); ta.select();
	let ok = false; try { ok = document.execCommand('copy'); } catch { /* */ }
	ta.remove();
	return ok;
}

/* ================================================================ look: theme, font, background */
let look = LOOK.load();
// The picture (a preset or the owner's own) under a veil of the theme's background colour, or
// else the theme's own illustration.
function paintWall(layer, mini) {
	const url = LOOK.wallUrl(look);
	if (url) layer.innerHTML = `<div class="art-img" style="background-image:url('${url}')"></div>`;
	else LOOK.renderArt(layer, look.theme, { mini });
}
function renderMainArt() { paintWall($('#art'), false); }
function setLook(patch, { transition = false } = {}) {
	Object.assign(look, patch);
	LOOK.save(look);
	const run = () => { LOOK.apply(look); renderMainArt(); };
	if (transition && document.startViewTransition && !REDUCED) document.startViewTransition(run);
	else run();
	updateLookValues();
}
function updateLookValues() {
	const t = LOOK.THEMES.find((x) => x.id === look.theme);
	const f = LOOK.FONTS.find((x) => x.id === look.font);
	$('#val-theme').textContent = t ? t.name : '';
	$('#val-font').textContent = f ? f.name : '';
	const preset = LOOK.PRESETS.find((x) => x.id === look.wall);
	$('#val-bg').textContent = look.wall === 'custom' ? '我的图片' : preset ? preset.name : (t && t.group === 'art' ? '主题插画' : '跟随主题');
	$$('.theme-card').forEach((c) => c.classList.toggle('sel', c.dataset.id === look.theme));
	$$('.font-row').forEach((r) => r.classList.toggle('sel', r.dataset.id === look.font));
}
renderMainArt();
// The default theme follows the system's dark mode.
const refollow = () => { if (look.theme === 'default') LOOK.apply(look); };
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refollow);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refollow(); });

function miniPreview(themeId) {
	const scheme = LOOK.schemeOf(themeId);
	const m = el('div', 'theme-mini');
	m.dataset.theme = themeId;
	m.dataset.scheme = scheme;
	const art = el('div', 'art-layer');
	LOOK.renderArt(art, themeId, { mini: true });
	m.appendChild(art);
	m.insertAdjacentHTML('beforeend', `<span class="tm-line" style="top:22%;width:46%"></span><span class="tm-line" style="top:29%;width:30%"></span><span class="tm-bubble"></span><span class="tm-line" style="top:62%;width:52%"></span><span class="tm-line" style="top:69%;width:38%"></span><span class="tm-comp"><span class="tm-chip"></span><span class="tm-send"></span></span><span class="tm-check">${ic('i-check')}</span>`);
	return m;
}
function buildThemePage() {
	const solid = $('#themes-solid'), art = $('#themes-art');
	solid.innerHTML = ''; art.innerHTML = '';
	for (const t of LOOK.THEMES) {
		const card = el('button', 'theme-card');
		card.dataset.id = t.id;
		card.appendChild(miniPreview(t.id));
		card.insertAdjacentHTML('beforeend', `<span class="theme-name">${esc(t.name)}<small>${esc(t.note || (t.scheme === 'dark' ? '深色' : '浅色'))}</small></span>`);
		card.addEventListener('click', () => { if (look.theme !== t.id) setLook({ theme: t.id }, { transition: true }); });
		(t.group === 'art' ? art : solid).appendChild(card);
	}
	updateLookValues();
}
PAGE_OPEN['page-theme'] = buildThemePage;

function buildFontPage() {
	const list = $('#font-list');
	list.innerHTML = '';
	for (const f of LOOK.FONTS) {
		LOOK.fontLink(f); // so each name can show in its own face
		const row = el('button', 'row font-row');
		row.dataset.id = f.id;
		const fam = f.family ? `font-family:'${f.family}',${LOOK.SYSTEM_STACK}` : `font-family:${LOOK.SYSTEM_STACK}`;
		row.innerHTML = `<span class="row-text"><span class="sample" style="${esc(fam)}">${esc(f.name)}</span><small>${esc(f.note || '手机自带的字体')}</small></span>${ic('i-check', 'check')}`;
		row.addEventListener('click', () => { setLook({ font: f.id }); toast(f.id === 'system' ? '已改回系统字体' : `已换成${f.name}`); });
		list.appendChild(row);
	}
	updateLookValues();
}
PAGE_OPEN['page-font'] = buildFontPage;

function buildBgPage() {
	// live preview: the current choice with a few mock messages over it
	const pv = $('#bg-preview');
	pv.dataset.theme = look.theme;
	pv.dataset.scheme = LOOK.schemeOf(look.theme);
	pv.innerHTML = '';
	const layer = el('div', 'art-layer');
	paintWall(layer, true);
	pv.appendChild(layer);
	pv.insertAdjacentHTML('beforeend', '<span class="tm-line" style="top:16%;width:50%"></span><span class="tm-line" style="top:23%;width:34%"></span><span class="tm-bubble"></span><span class="tm-line" style="top:62%;width:60%"></span><span class="tm-line" style="top:69%;width:44%"></span><span class="tm-line" style="top:76%;width:28%"></span>');
	pv.style.setProperty('--bg-dim', look.dim + '%');
	$('#bg-dim').value = look.dim;
	$('#bg-dim-val').textContent = look.dim + '%';
	$('#bg-dim-group').classList.toggle('hidden', !look.wall);
	buildWallGrid();
}
function wallCard(id, name, paint) {
	const card = el('button', 'wall-card' + (look.wall === id ? ' sel' : ''));
	card.dataset.id = id;
	const pic = el('span', 'wall-pic');
	paint(pic);
	pic.insertAdjacentHTML('beforeend', `<span class="tm-check">${ic('i-check')}</span>`);
	card.appendChild(pic);
	card.appendChild(el('span', 'wall-name', esc(name)));
	return card;
}
function buildWallGrid() {
	const box = $('#wall-groups');
	box.innerHTML = '';
	const group = (label) => {
		box.insertAdjacentHTML('beforeend', `<h2 class="group-label">${esc(label)}</h2>`);
		const g = el('div', 'wall-grid'); box.appendChild(g); return g;
	};
	const mine = group('基础');
	const themeCard = wallCard('', '跟随主题', (pic) => {
		pic.dataset.theme = look.theme; pic.dataset.scheme = LOOK.schemeOf(look.theme);
		const l = el('div', 'art-layer'); LOOK.renderArt(l, look.theme, { mini: true }); pic.appendChild(l);
		pic.insertAdjacentHTML('beforeend', '<span class="tm-line" style="top:30%;width:50%"></span><span class="tm-line" style="top:36%;width:32%"></span><span class="tm-bubble" style="top:50%;height:14px"></span><span class="tm-line" style="top:64%;width:56%"></span>');
	});
	themeCard.addEventListener('click', () => chooseWall(''));
	mine.appendChild(themeCard);
	if (look.bg) {
		const c = wallCard('custom', '我的图片', (pic) => { pic.style.backgroundImage = `url('/api/background?v=${look.bg}')`; });
		c.addEventListener('click', () => chooseWall('custom'));
		mine.appendChild(c);
	}
	const pick = el('button', 'wall-card add');
	pick.innerHTML = `<span class="wall-pic">${ic('i-image')}<span>${look.bg ? '换一张' : '从相册选'}</span></span><span class="wall-name">我的图片</span>`;
	pick.addEventListener('click', () => $('#file-bg').click());
	mine.appendChild(pick);
	let cur = null, grid = null;
	for (const p of LOOK.PRESETS) {
		if (p.group !== cur) { cur = p.group; grid = group(cur); }
		const c = wallCard(p.id, p.name, (pic) => { pic.style.backgroundImage = `url('${LOOK.presetThumb(p)}')`; });
		c.addEventListener('click', () => chooseWall(p.id));
		grid.appendChild(c);
	}
}
function chooseWall(id) {
	if (look.wall === id) return;
	setLook({ wall: id }, { transition: true });
	buildBgPage();
}
PAGE_OPEN['page-bg'] = buildBgPage;
$('#bg-dim').addEventListener('input', (e) => {
	const v = Number(e.target.value);
	$('#bg-dim-val').textContent = v + '%';
	$('#bg-preview').style.setProperty('--bg-dim', v + '%');
	setLook({ dim: v });
});
// Pictures from the camera are 10+ MB; scale to the screen before uploading.
function shrinkImage(file, maxSide = 2000) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => {
			const s = Math.min(1, maxSide / Math.max(img.width, img.height));
			const c = document.createElement('canvas');
			c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
			c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
			URL.revokeObjectURL(img.src);
			resolve(c.toDataURL('image/jpeg', 0.88));
		};
		img.onerror = () => reject(new Error('读不了这张图片'));
		img.src = URL.createObjectURL(file);
	});
}
$('#file-bg').addEventListener('change', async (e) => {
	const f = e.target.files[0];
	e.target.value = '';
	if (!f) return;
	toast('正在设置背景…');
	try {
		const dataUrl = await shrinkImage(f);
		const r = await api('/api/background', { dataUrl });
		if (!r.ok) throw new Error(r.error || '上传失败');
		setLook({ bg: r.v, wall: 'custom' });
		buildBgPage();
		toast('背景已更换');
	} catch (err) { toast('没能设置背景：' + err.message); }
});

/* ================================================================ settings state */
const SETTINGS = { model: 'sonnet', modelName: 'Sonnet 5.5', effort: 'xhigh', fastMode: false, mode: 'acceptEdits', autoUpdate: true };
const MODES = [
	{ id: 'default', label: 'Ask', desc: '只读操作直接做，其他每一步都先问你' },
	{ id: 'acceptEdits', label: 'Accept edits', desc: '自动改文件、跑常规命令，有风险的操作先问你' },
	{ id: 'plan', label: 'Plan', desc: '只读分析，先拿出计划，你同意后再动手' },
	{ id: 'auto', label: 'Auto', desc: '全部自动执行，只有刷机、重启、格式化这类高危操作才问你' },
	{ id: 'bypassPermissions', label: 'Full access', desc: '完全放开，任何操作都不再询问' },
];
const MODELS = [
	{ id: 'opus', name: 'Opus 5.5', desc: '能力最强，适合复杂任务' },
	{ id: 'sonnet', name: 'Sonnet 5.5', desc: '日常首选，速度和能力兼顾' },
	{ id: 'fable', name: 'Fable 5.1', desc: '会消耗额外用量' },
	{ id: 'haiku', name: 'Haiku 5.5', desc: '最快，适合简单任务' },
];
const MORE_MODELS = [['haiku-4.5', 'Haiku 4.5'], ['sonnet-5', 'Sonnet 5'], ['opus-5', 'Opus 5'], ['fable-5', 'Fable 5'], ['opus-4.8', 'Opus 4.8'], ['opus-4.7', 'Opus 4.7'], ['opus-4.6', 'Opus 4.6'], ['sonnet-4.6', 'Sonnet 4.6']];
const EFFORTS = [['low', '低'], ['medium', '中'], ['high', '高'], ['xhigh', '超高'], ['max', '最大']];

function applySettings(s) {
	const prevMode = SETTINGS.mode;
	Object.assign(SETTINGS, s || {});
	const m = MODES.find((x) => x.id === SETTINGS.mode) || MODES[1];
	const chip = $('#btn-mode');
	chip.dataset.mode = m.id;
	$('#mode-icon').setAttribute('href', '#m-' + m.id);
	$('#mode-label').textContent = m.label;
	if (prevMode !== SETTINGS.mode) { chip.classList.remove('flash'); void chip.offsetWidth; chip.classList.add('flash'); }
	$('#model-label').textContent = SETTINGS.modelName || 'Sonnet 5.5';
	$('#t-autoupdate').checked = SETTINGS.autoUpdate !== false;
	$('#t-fast').checked = !!SETTINGS.fastMode;
}
function pushSettings(patch) {
	applySettings(patch);
	api('/api/settings', patch);
}

/* ---------------- mode menu ---------------- */
function renderModeMenu() {
	const list = $('#mode-list');
	list.innerHTML = '';
	for (const m of MODES) {
		const b = el('button', 'menu-row' + (m.id === SETTINGS.mode ? ' sel' : ''));
		b.dataset.mode = m.id;
		b.innerHTML = `${ic('m-' + m.id)}<span class="mr-text"><span>${esc(m.label)}</span><small>${esc(m.desc)}</small></span>${ic('i-check', 'check')}`;
		b.addEventListener('click', () => chooseMode(m.id));
		list.appendChild(b);
	}
}
function chooseMode(id) {
	closeMenu();
	if (id === SETTINGS.mode) return;
	if (id === 'bypassPermissions') {
		showDialog({
			title: '开启 Full access？',
			msg: '开启后助手做任何事都不会再问你，包括刷机、重启、删除系统文件和读取个人数据。只在你清楚它要做什么的时候使用。',
			ok: '开启', danger: true,
			onOk: () => { pushSettings({ mode: id }); toast('已切换到 Full access'); },
		});
		return;
	}
	pushSettings({ mode: id });
	toast('已切换到 ' + (MODES.find((m) => m.id === id)?.label || id));
}
$('#btn-mode').addEventListener('click', (e) => { renderModeMenu(); openMenu('menu-mode', e.currentTarget); });

/* ---------------- model menu ---------------- */
function modelRow(id, name, desc) {
	const sel = SETTINGS.model === id || SETTINGS.modelName === name;
	const b = el('button', 'menu-row' + (sel ? ' sel' : ''));
	b.innerHTML = `<span class="mr-text"><span>${esc(name)}</span>${desc ? `<small>${esc(desc)}</small>` : ''}</span>${ic('i-check', 'check')}`;
	b.addEventListener('click', () => { pushSettings({ model: id, modelName: name }); closeMenu(); });
	return b;
}
function renderModelMenu() {
	const list = $('#model-list'), more = $('#more-model-list');
	list.innerHTML = ''; more.innerHTML = '';
	MODELS.forEach((m) => list.appendChild(modelRow(m.id, m.name, m.desc)));
	MORE_MODELS.forEach(([id, name]) => more.appendChild(modelRow(id, name)));
	const inMore = MORE_MODELS.some(([id]) => id === SETTINGS.model);
	more.classList.toggle('hidden', !inMore);
	$('#more-models-toggle').classList.toggle('expanded', inMore);
	const seg = $('#effort-seg');
	seg.innerHTML = '';
	EFFORTS.forEach(([id, label]) => {
		const b = el('button', id === SETTINGS.effort ? 'sel' : '', esc(label));
		b.addEventListener('click', () => { pushSettings({ effort: id }); $$('#effort-seg button').forEach((x) => x.classList.toggle('sel', x === b)); });
		seg.appendChild(b);
	});
}
$('#more-models-toggle').addEventListener('click', (e) => {
	const more = $('#more-model-list');
	more.classList.toggle('hidden');
	e.currentTarget.classList.toggle('expanded', !more.classList.contains('hidden'));
});
$('#t-fast').addEventListener('change', (e) => pushSettings({ fastMode: e.target.checked }));
$('#btn-model').addEventListener('click', (e) => { renderModelMenu(); openMenu('menu-model', e.currentTarget); });

/* ---------------- usage ring ---------------- */
let usageData = null;
let usageAt = 0;
function fmtReset(iso) {
	if (!iso) return '';
	const t = new Date(iso).getTime(); if (isNaN(t)) return '';
	const diff = t - Date.now();
	if (diff <= 0) return '即将重置';
	const d = Math.floor(diff / 86400000), h = Math.floor((diff % 86400000) / 3600000), m = Math.floor((diff % 3600000) / 60000);
	if (d > 0) return `${d} 天 ${h} 小时后重置`;
	return h > 0 ? `${h} 小时 ${m} 分钟后重置` : `${m} 分钟后重置`;
}
const level = (pct) => (pct >= 90 ? 'high' : pct >= 60 ? 'mid' : 'low');
function renderUsageRing() {
	const ring = $('#btn-usage');
	const win = usageData?.rate_limits?.five_hour;
	if (!win || win.utilization == null) {
		ring.className = 'usage-ring none';
		$('#usage-pct').textContent = '–';
		$('#usage-arc').setAttribute('stroke-dasharray', '0 100');
		return;
	}
	const pct = Math.max(0, Math.min(100, Math.round(win.utilization)));
	ring.className = 'usage-ring ' + level(pct);
	$('#usage-pct').textContent = pct;
	$('#usage-arc').setAttribute('stroke-dasharray', `${Math.max(pct, 2)} 100`);
	ring.setAttribute('aria-label', `5 小时用量 ${pct}%`);
}
function usageBar(label, win) {
	if (!win) return '';
	const u = win.utilization == null ? null : Math.round(win.utilization);
	const pct = u == null ? 0 : Math.min(100, u);
	return `<div class="usage-row"><div class="usage-top"><span>${label}</span><span class="usage-pct">${u == null ? '—' : u + '%'}</span></div>
		<div class="usage-track"><div class="usage-fill ${level(pct)}" style="width:${pct}%"></div></div>
		<div class="usage-reset">${esc(fmtReset(win.resets_at))}</div></div>`;
}
function renderUsageBody(err) {
	const body = $('#usage-body');
	if (err) { body.innerHTML = `<div class="empty-state">${esc(err)}</div>`; return; }
	if (!usageData) { body.innerHTML = '<div class="empty-state"><span class="spin"></span></div>'; return; }
	if (!usageData.rate_limits_available || !usageData.rate_limits) { body.innerHTML = '<div class="empty-state">这个账号没有用量窗口（可能用的是 API Key 或组织账号）。</div>'; return; }
	const rl = usageData.rate_limits;
	let html = usageBar('5 小时', rl.five_hour) + usageBar('本周', rl.seven_day) + usageBar('本周 Opus', rl.seven_day_opus) + usageBar('本周 Sonnet', rl.seven_day_sonnet);
	if (usageData.cost != null) html += `<div class="usage-cost">当前对话约花费 $${Number(usageData.cost).toFixed(4)}</div>`;
	body.innerHTML = html || '<div class="empty-state">暂无数据</div>';
}
let usageLoading = null;
function loadUsage(fresh) {
	if (usageLoading) return usageLoading;
	usageLoading = getJSON('/api/usage' + (fresh ? '?fresh=1' : '')).then((r) => {
		usageLoading = null;
		if (r.ok) { usageData = r; usageAt = Date.now(); renderUsageRing(); if (openMenuId === 'menu-usage') renderUsageBody(); }
		else if (openMenuId === 'menu-usage') renderUsageBody(r.error || '读取用量失败');
		return r;
	});
	return usageLoading;
}
$('#btn-usage').addEventListener('click', (e) => {
	renderUsageBody();
	openMenu('menu-usage', e.currentTarget);
	if (Date.now() - usageAt > 30000) loadUsage();
});
$('#usage-refresh').addEventListener('click', () => { usageData = null; renderUsageBody(); loadUsage(true); });
setInterval(() => { if (!document.hidden && loggedIn) loadUsage(); }, 180000);
let usageAfterTurn = null;
function usageSoon() { clearTimeout(usageAfterTurn); usageAfterTurn = setTimeout(() => loadUsage(true), 2500); }

/* ================================================================ thread rendering */
function md(src) {
	const blocks = [];
	const code = (lang, body) => {
		blocks.push(`<div class="code"><div class="code-head"><span>${esc(lang || '代码')}</span><button class="code-copy">${ic('i-copy')}复制</button></div><pre><code>${esc(body.replace(/\n$/, ''))}</code></pre></div>`);
		return `\u0000${blocks.length - 1}\u0000`;
	};
	let s = String(src || '').replace(/```([\w+-]*)[^\n]*\n?([\s\S]*?)```/g, (_, lang, body) => code(lang, body));
	s = s.replace(/```([\w+-]*)[^\n]*\n?([\s\S]*)$/, (_, lang, body) => code(lang, body)); // still streaming
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
	s = s.replace(/^(?:-{3,}|\*{3,})$/gm, '<hr>');
	s = s.replace(/(?:^&gt; ?.*(?:\n|$))+/gm, (blk) => `<blockquote>${blk.trim().split('\n').map((l) => l.replace(/^&gt; ?/, '')).join('<br>')}</blockquote>`);
	s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
	s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
	s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
	s = s.replace(/(?:^(?:[-*+]|\d+\.) .*(?:\n|$))+/gm, (blk) => {
		const ol = /^\s*\d+\./.test(blk);
		const items = blk.trim().split('\n').map((l) => l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')).map((t) => `<li>${t}</li>`).join('');
		return `<${ol ? 'ol' : 'ul'}>${items}</${ol ? 'ol' : 'ul'}>`;
	});
	s = s.split(/\n{2,}/).map((p) => {
		const t = p.trim();
		if (!t) return '';
		if (/^<(h\d|ul|ol|table|blockquote|hr)/.test(t) || /^\u0000\d+\u0000$/.test(t)) return t;
		return `<p>${t.replace(/\n/g, '<br>')}</p>`;
	}).join('');
	return s.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
}

let running = false;
let curAssistant = null; // { wrap, el, raw }
let curThink = null;     // { card, body }
let curTodoEl = null;
const toolEls = new Map();

function atBottom() { return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140; }
function scroll(force) { if (force || atBottom()) requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; }); }
function killWelcome() { const w = $('#welcome'); if (w) w.remove(); }

function addUser(text) {
	killWelcome();
	endAssistant();
	const e = el('div', 'msg user');
	const b = el('div', 'bubble'); b.textContent = text;
	e.appendChild(b);
	thread.appendChild(e);
	scroll(true);
}
function ensureAssistant() {
	if (curAssistant) return curAssistant;
	killWelcome();
	endThink();
	const wrap = el('div', 'msg assistant streaming');
	const body = el('div', 'md');
	wrap.appendChild(body);
	thread.appendChild(wrap);
	curAssistant = { wrap, el: body, raw: '' };
	scroll(true);
	return curAssistant;
}
function appendAssistant(text) { const a = ensureAssistant(); a.raw += text; a.el.innerHTML = md(a.raw); scroll(); }
function setAssistant(text) { const a = ensureAssistant(); a.raw = text; a.el.innerHTML = md(a.raw); scroll(); }
// "12 秒", "1 分 05 秒"
function fmtSecs(ms) {
	const t = Math.max(0, Math.round((ms || 0) / 1000));
	return t < 60 ? `${t} 秒` : `${Math.floor(t / 60)} 分 ${String(t % 60).padStart(2, '0')} 秒`;
}
function addMsgActions(wrap, raw, tookMs) {
	if (!raw || !raw.trim()) return;
	const acts = el('div', 'msg-acts');
	const copy = el('button', 'msg-act', `${ic('i-copy')}<span>复制</span>`);
	copy.addEventListener('click', () => copyText(raw));
	acts.appendChild(copy);
	if (tookMs) acts.appendChild(el('span', 'msg-meta', `用时 ${fmtSecs(tookMs)}`));
	wrap.appendChild(acts);
}
function endAssistant() {
	if (curAssistant) {
		curAssistant.wrap.classList.remove('streaming');
		addMsgActions(curAssistant.wrap, curAssistant.raw);
		curAssistant = null;
	}
	endThink();
}
function addAssistantStatic(text, tookMs) {
	const wrap = el('div', 'msg assistant');
	const body = el('div', 'md');
	body.innerHTML = md(text || '');
	wrap.appendChild(body);
	addMsgActions(wrap, text, tookMs);
	thread.appendChild(wrap);
}
// The turn's total time goes under its last reply.
function markTurnTime(ms) {
	if (!ms) return;
	const kids = [...thread.children];
	for (let i = kids.length - 1; i >= 0 && !kids[i].classList.contains('user'); i--) {
		if (kids[i].classList.contains('assistant')) {
			const acts = $('.msg-acts', kids[i]);
			if (acts && !$('.msg-meta', acts)) acts.appendChild(el('span', 'msg-meta', `用时 ${fmtSecs(ms)}`));
			return;
		}
	}
}

/* ---------------- tool steps ---------------- */
// Each step reads as what it does ("查看电池状态"); the command and its output are one tap away.
function toolCategory(name) {
	if (/^(Bash|BashOutput|KillShell)$/.test(name)) return '命令';
	if (/^(Read|NotebookRead|LS)$/.test(name)) return '读取';
	if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) return '修改文件';
	if (/^(Glob|Grep)$/.test(name)) return '查找';
	if (/^(WebSearch|WebFetch)$/.test(name)) return '联网';
	if (name === 'Skill') return '技能';
	if (name === 'Task' || name === 'Agent') return '子任务';
	if (String(name).startsWith('mcp__')) return 'MCP';
	return '工具';
}
const CATEGORY_ICON = { 命令: 'i-terminal', 读取: 'i-file', 修改文件: 'i-pen', 查找: 'i-search', 联网: 'i-globe', 技能: 'i-layers', 子任务: 'i-layers', MCP: 'i-plug' };
function toolIcon(name, detail, category) {
	const d = detail || '';
	if (name === 'Bash' && /droid (shot|ui|top)|screencap|uiautomator/.test(d)) return ic('i-shot');
	if (name === 'Bash' && /droid (tap|swipe|text|key|app)/.test(d)) return ic('i-tap');
	if (name === 'TodoWrite') return ic('i-list');
	return ic(CATEGORY_ICON[category] || 'i-spark');
}
const DETAIL_LABEL = (name) => (name === 'Bash' ? '命令' : /^(Read|Write|Edit|MultiEdit|NotebookEdit|NotebookRead)$/.test(name) ? '文件' : '内容');
function addTool(id, name, title, detail, replay, category) {
	if (!replay) endAssistant();
	killWelcome();
	const cat = category || toolCategory(name);
	const card = el('div', 'tool');
	card.innerHTML = `<div class="tool-head"><div class="tool-ic">${toolIcon(name, detail, cat)}</div><div class="tool-title"></div><span class="tool-cat">${esc(cat)}</span><div class="tool-state"><span class="spin"></span></div>${ic('i-chev', 'chev')}</div>`
		+ `<div class="tool-body"><div class="tool-inner"><div class="tool-sec${detail ? '' : ' hidden'}"><div class="tool-sec-h">${DETAIL_LABEL(name)}</div><pre class="tool-detail"></pre></div><div class="tool-sec res hidden"><div class="tool-sec-h">结果</div><pre class="tool-result"></pre></div></div></div>`;
	$('.tool-title', card).textContent = title || name;
	if (detail) $('.tool-detail', card).textContent = detail;
	$('.tool-head', card).addEventListener('click', () => card.classList.toggle('open'));
	thread.appendChild(card);
	if (id) toolEls.set(id, card);
	scroll();
	return card;
}
function finishTool(id, ok, summary) {
	const card = toolEls.get(id); if (!card) return;
	const st = $('.tool-state', card);
	st.innerHTML = ok ? ic('i-check') : '出错';
	st.className = 'tool-state ' + (ok ? 'ok' : 'err');
	card.classList.toggle('failed', !ok);
	if (summary && summary.trim()) {
		$('.tool-result', card).textContent = summary.trim();
		$('.tool-sec.res', card).classList.remove('hidden');
	}
	scroll();
}

/* ---------------- thinking ---------------- */
// Open while Claude is thinking, so the reasoning can be followed as it comes; folds into
// "思考了 N 秒" afterwards (tap to read it again).
function startThink() {
	if (curThink) return curThink;
	killWelcome();
	const card = el('div', 'think live open');
	card.innerHTML = `<div class="think-head">${ic('i-spark')}<span class="think-label">正在思考</span><span class="think-time">0 秒</span>${ic('i-chev', 'chev')}</div><div class="think-body"><div></div></div>`;
	$('.think-head', card).addEventListener('click', () => card.classList.toggle('open'));
	thread.appendChild(card);
	curThink = { card, body: $('.think-body > div', card), start: Date.now() };
	scroll();
	return curThink;
}
function addThinkDelta(text) {
	const t = startThink();
	t.body.textContent += text;
	t.body.scrollTop = t.body.scrollHeight;
	if (t.card.classList.contains('open')) scroll();
}
function closeThinkCard(card, ms, hasText) {
	card.classList.remove('live', 'open');
	$('.think-label', card).textContent = '思考了';
	$('.think-time', card).textContent = fmtSecs(Math.max(ms, 1000));
	card.classList.toggle('empty', !hasText);
}
function endThink(ms) {
	if (!curThink) return;
	const t = curThink; curThink = null;
	closeThinkCard(t.card, ms ?? Date.now() - t.start, !!t.body.textContent.trim());
}
function addThinkStatic(text, ms) {
	const t = startThink();
	t.body.textContent = text || '';
	curThink = null;
	closeThinkCard(t.card, ms || 0, !!(text || '').trim());
}
function sysline(t) { const e = el('div', 'sysline'); e.textContent = t; thread.appendChild(e); scroll(); }
// What a Claude Code command such as /context printed.
function addCmdOut(text) {
	killWelcome();
	const c = el('div', 'cmd-out');
	c.innerHTML = `<div class="cmd-out-h">${ic('i-terminal')}<span>命令输出</span></div><pre></pre>`;
	$('pre', c).textContent = text;
	thread.appendChild(c);
	scroll(true);
}
// App-side command results (/status, /usage, /doctor, /help): shown here, not saved.
function infoCard(title, icon, html) {
	killWelcome();
	const c = el('div', 'info-card');
	c.innerHTML = `<div class="info-h">${ic(icon)}<span>${esc(title)}</span></div><div class="info-b">${html}</div>`;
	thread.appendChild(c);
	scroll(true);
	return c;
}
const kvRow = (k, v) => (v == null || v === '' ? '' : `<div class="kv-row"><span>${esc(k)}</span><span>${esc(String(v))}</span></div>`);

function upsertTodo(todos) {
	if (!curTodoEl) { curTodoEl = el('div', 'todo-block'); thread.appendChild(curTodoEl); }
	curTodoEl.innerHTML = (todos || []).map((t) => {
		const label = t.status === 'in_progress' ? (t.activeForm || t.content) : t.content;
		return `<div class="todo-row todo-${esc(t.status || 'pending')}"><span class="todo-ic"></span><span class="todo-label">${esc(label || '')}</span></div>`;
	}).join('');
	scroll();
}

const VERDICT = { allow: '已允许', deny: '已拒绝', stop: '已停止', expired: '已失效（服务重启过，需要的话重新发一次）' };
const permMarks = new Map(); // id -> closes that card, whoever answered it
function addPermission(p) {
	endAssistant();
	killWelcome();
	const cat = p.reason === '高危操作';
	const plan = p.reason === '计划已就绪';
	const card = el('div', 'perm' + (cat ? ' catastrophic' : ''));
	const yes = plan ? '按计划执行' : '允许';
	const no = plan ? '继续修改计划' : '拒绝';
	card.innerHTML = `<div class="ptop"><span class="tag">${esc(plan ? '计划' : cat ? '高危操作' : (p.reason && p.reason !== '需要确认' ? p.reason : '需要你确认'))}</span><span class="pt"></span></div>${p.detail ? (plan ? '<div class="plan md"></div>' : '<pre></pre>') : ''}<div class="pbtns"><button class="yes">${yes}</button><button class="no">${no}</button><button class="stop">停止</button></div><div class="verdict hidden"></div>`;
	$('.pt', card).textContent = p.title || p.name;
	if (p.detail) { if (plan) $('.plan', card).innerHTML = md(p.detail); else $('pre', card).textContent = p.detail; }
	const sid = p.sessionId || curSession?.id;
	const mark = (d) => {
		card.classList.add('done');
		const v = $('.verdict', card);
		v.classList.remove('hidden');
		v.textContent = plan && d === 'allow' ? '已同意计划，开始执行' : plan && d === 'deny' ? '已退回，可以接着说要改什么' : (VERDICT[d] || d);
	};
	const decide = (d) => {
		if (d === 'stop') stoppedIds.add(sid);
		api('/api/permission', { id: p.id, decision: d, sessionId: sid });
		mark(d);
	};
	$('.yes', card).addEventListener('click', () => decide('allow'));
	$('.no', card).addEventListener('click', () => decide('deny'));
	$('.stop', card).addEventListener('click', () => decide('stop'));
	if (p.verdict) mark(p.verdict);
	else permMarks.set(p.id, mark);
	thread.appendChild(card);
	scroll(true);
}

// Copy buttons on code blocks (rendered as markup, so handled here once).
thread.addEventListener('click', (e) => {
	const b = e.target.closest('.code-copy');
	if (b) copyText($('code', b.closest('.code')).textContent);
});

/* ---------------- empty state ---------------- */
const SUGGESTIONS = [
	['i-pulse', '给手机做个体检', '电池、存储、温度和内存', '给这台手机做个体检：电池健康和温度、存储空间、内存占用，有问题的地方告诉我怎么处理。'],
	['i-sweep', '清理存储空间', '找出大文件和能删的缓存', '帮我看看存储空间都被什么占了，列出能安全清理的大文件和缓存，先别删，等我确认。'],
	['i-shot', '看看屏幕上是什么', '截屏并说明当前界面', '截个屏，告诉我现在屏幕上是什么。'],
	['i-battery', '电池为什么掉得快', '找出后台耗电的应用', '最近电池掉得快，帮我找出耗电最多的应用和原因。'],
];
function greeting() {
	const h = new Date().getHours();
	return h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好';
}
function buildWelcome() {
	const w = el('section', 'welcome');
	w.id = 'welcome';
	w.innerHTML = `<h1><span class="greet">${greeting()}</span>想让手机做点什么？</h1><p>我在这台手机的 Linux 环境里，有 root 权限，能管理文件、应用和进程，也能看屏幕、替你点按。</p><div class="suggest"></div>`;
	const sg = $('.suggest', w);
	SUGGESTIONS.forEach(([icon, t, sub, prompt]) => {
		const b = el('button', null, `${ic(icon)}<span>${esc(t)}<small>${esc(sub)}</small></span>`);
		b.addEventListener('click', () => { input.value = prompt; send(); });
		sg.appendChild(b);
	});
	thread.appendChild(w);
}

/* ---------------- transcript ---------------- */
let curSession = null;
// What the owner typed: send() wraps attachments in a block of their own for Claude.
const typedText = (t) => String(t || '').replace(/^【指定操作范围与上下文】[\s\S]*?【用户指令】\n?/, '');
function renderTranscript(sess) {
	stopActivity(); // whichever conversation is now on screen reports its own (fetchSessions)
	thread.innerHTML = '';
	toolEls.clear();
	permMarks.clear();
	curAssistant = null; curThink = null; curTodoEl = null;
	chatTitle.textContent = sess?.title || '新对话';
	if (!sess || !sess.messages || !sess.messages.length) buildWelcome();
	else {
		for (const m of sess.messages) {
			if (m.role === 'user') addUser(typedText(m.text));
			else if (m.role === 'assistant') { endAssistant(); addAssistantStatic(m.text, m.tookMs); }
			else if (m.role === 'tool') {
				if (m.kind === 'todo') { upsertTodo(m.todos || []); continue; }
				addTool(m.id, m.name, m.title, m.detail, true, m.category);
				if (m.state && m.state !== 'running') finishTool(m.id, m.ok !== false, m.summary);
			} else if (m.role === 'think') addThinkStatic(m.text, m.ms);
			else if (m.role === 'cmdout') addCmdOut(m.text);
			else if (m.role === 'perm') addPermission({ ...m, sessionId: sess.id });
			else if (m.role === 'sys') sysline(m.text);
		}
	}
	for (const c of thread.children) c.classList.add('static'); // history appears at once, only new messages animate in
	if (sess?.liveText) appendAssistant(sess.liveText); // opened mid-reply: what is already written
	thread.scrollTop = thread.scrollHeight;
}

/* ---------------- running state & composer ---------------- */
function setRunning(v) {
	running = v;
	if (!v) stopActivity();
	updateSendState();
}

// What the conversation on screen is doing right now and for how long, just above the input:
// "正在思考 · 8 秒", "正在查看电池状态 · 15 秒", "等你确认 · 20 秒".
const activity = { on: false, since: 0, label: '' };
function setActivity(label, since) {
	if (!activity.on) { activity.on = true; activity.since = since || Date.now(); }
	else if (since) activity.since = since;
	if (label) activity.label = label;
	renderActivity();
}
function stopActivity() { activity.on = false; renderActivity(); }
function renderActivity() {
	const box = $('#activity');
	box.classList.toggle('hidden', !activity.on);
	if (!activity.on) return;
	$('#act-label').textContent = activity.label || '正在思考';
	$('#act-time').textContent = fmtSecs(Date.now() - activity.since);
	box.classList.toggle('waiting', activity.label === '等你确认');
}
const doing = (title) => (/^(正在|等你)/.test(title) ? title : '正在' + title);
setInterval(() => {
	if (activity.on) renderActivity();
	if (curThink) $('.think-time', curThink.card).textContent = fmtSecs(Date.now() - curThink.start);
}, 1000);
function updateSendState() {
	const has = !!input.value.trim() || attachedScopes.length > 0;
	const showStop = running && !has;
	$('#btn-stop').classList.toggle('hidden', !showStop);
	$('#btn-send').classList.toggle('hidden', showStop);
	$('#btn-send').disabled = !has;
}
// The composer floats over the thread; the thread keeps that much room at its end. Pinned to
// the newest message when the composer grows (a longer draft, attachments).
const composerEl = $('#composer');
new ResizeObserver(() => {
	const stick = atBottom();
	$('#app').style.setProperty('--composer-h', composerEl.offsetHeight + 'px');
	if (stick) thread.scrollTop = thread.scrollHeight;
}).observe(composerEl);
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, innerHeight * 0.35) + 'px'; }
input.addEventListener('input', () => {
	autosize(); updateSendState(); checkSlashInput();
	if (input.value === '/') loadSlashCommands(true); // the list changes behind the page's back
});
input.addEventListener('keydown', (e) => {
	// On the phone Enter makes a new line (the send button is right there); on a keyboard it sends.
	if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) { e.preventDefault(); hideSlash(); send(); }
	else if (e.key === 'Escape' && !$('#slash-menu').classList.contains('hidden')) hideSlash();
});

let attachedScopes = [];
const SCOPE_ICON = { app: 'i-app', folder: 'i-folder', file: 'i-file', path: 'i-path', image: 'i-image' };
function addScope(scope) {
	if (!attachedScopes.some((s) => s.type === scope.type && (s.path === scope.path && s.package === scope.package))) {
		attachedScopes.push(scope);
		renderScopes();
	}
}
function renderScopes() {
	const box = $('#scope-container');
	box.innerHTML = '';
	box.classList.toggle('hidden', !attachedScopes.length);
	attachedScopes.forEach((s, idx) => {
		const badge = el('div', 'scope-badge');
		if (s.type === 'image' && s.dataUrl) { const img = el('img', 'scope-thumb'); img.src = s.dataUrl; img.alt = ''; badge.appendChild(img); }
		else badge.insertAdjacentHTML('beforeend', ic(SCOPE_ICON[s.type] || 'i-file'));
		const text = s.type === 'app' ? (s.name || s.package) : s.type === 'file' ? (s.name || s.path.split('/').pop()) : s.type === 'image' ? (s.name || '图片') : s.path;
		badge.appendChild(el('span', 'scope-text', esc(text)));
		const del = el('button', 'scope-del', ic('i-x'));
		del.setAttribute('aria-label', '移除');
		del.addEventListener('click', () => { attachedScopes.splice(idx, 1); renderScopes(); });
		badge.appendChild(del);
		box.appendChild(badge);
	});
	updateSendState();
}

const runningIds = new Set();
const pendingIds = new Set();
const stoppedIds = new Set(); // the owner pressed Stop, so a turn ending early is no news
async function send() {
	const rawText = input.value.trim();
	if (!rawText && !attachedScopes.length) return;
	if (!attachedScopes.length && runAppCommand(rawText)) return;
	// Allowed while a turn is running: the server queues it, like typing ahead in the terminal.
	let fullPrompt = rawText;
	if (attachedScopes.length) {
		const lines = attachedScopes.map((s) => ({
			app: `- 手机应用: ${s.name} (${s.package})`, folder: `- 目标文件夹: ${s.path}`, file: `- 目标文件: ${s.path}`,
			path: `- 自定义路径: ${s.path}`, image: `- 附件图片: ${s.path}`,
		}[s.type] || '')).filter(Boolean).join('\n');
		fullPrompt = `【指定操作范围与上下文】\n${lines}\n\n【用户指令】\n${rawText || '请根据上述指定的上下文进行分析或处理。'}`;
	}
	addUser(rawText || fullPrompt);
	input.value = '';
	autosize();
	hideSlash();
	const sid = curSession?.id;
	const scopes = attachedScopes.map(({ dataUrl, ...s }) => s); // the picture is already on the phone
	attachedScopes = [];
	renderScopes();
	runningIds.add(sid);
	setRunning(true);
	if (!activity.on) setActivity('正在思考');
	const r = await api('/api/send', { text: fullPrompt, scopes, sessionId: sid });
	if (!r.ok) {
		runningIds.delete(sid);
		if (curSession?.id === sid) setRunning(false);
		sysline('发送失败：' + (r.error || '连不上助手服务'));
	}
	fetchSessions();
}
$('#btn-send').addEventListener('click', send);
// Stops only this conversation's current turn (like Esc in the terminal).
$('#btn-stop').addEventListener('click', () => {
	api('/api/stop', { sessionId: curSession?.id });
	if (curSession) { runningIds.delete(curSession.id); stoppedIds.add(curSession.id); }
	setRunning(false);
});

/* ---------------- slash commands ---------------- */
// Two kinds: the app's own (what Claude Code's terminal shows in its own interface, such as
// /status, has no headless equivalent, so the app answers those itself), and everything Claude
// Code itself supports here (/compact, /context, custom commands, skills), sent through as is.
const APP_COMMANDS = [
	{ name: 'status', desc: '查看版本、模型、账号、MCP 等运行状态', run: () => cmdStatus() },
	{ name: 'usage', desc: '查看用量与额度', run: () => cmdUsage() },
	{ name: 'model', desc: '切换模型和思考强度', run: () => $('#btn-model').click() },
	{ name: 'mode', aliases: ['permissions'], desc: '切换执行模式（Ask / Accept edits / Plan / Auto / Full access）', run: () => $('#btn-mode').click() },
	{ name: 'clear', aliases: ['new', 'reset'], desc: '开始一个新对话', run: () => createNewChat() },
	{ name: 'rename', hint: '<新标题>', desc: '重命名当前对话', run: (a) => renameCurrent(a) },
	{ name: 'resume', desc: '打开对话列表', run: () => openDrawer() },
	{ name: 'export', desc: '把整段对话复制成 Markdown', run: () => cmdExport() },
	{ name: 'doctor', desc: '检查 Claude Code 运行方式、网络和登录', run: () => cmdDoctor() },
	{ name: 'market', aliases: ['plugin', 'plugins'], desc: '打开扩展市场：技能、连接器和插件', run: () => openMarket('skills') },
	{ name: 'mcp', desc: '管理连接器（MCP）', run: () => openMarket('connectors', 'installed') },
	{ name: 'skills', desc: '管理技能', run: () => openMarket('skills', 'installed') },
	{ name: 'memory', desc: '编辑系统提示词', run: () => openPage('page-prompt') },
	{ name: 'config', aliases: ['settings'], desc: '打开设置', run: () => openPage('page-settings') },
	{ name: 'theme', desc: '更换主题', run: () => openPage('page-theme') },
	{ name: 'release-notes', aliases: ['version', 'changelog'], desc: '版本与更新记录', run: () => openPage('page-version') },
	{ name: 'login', desc: '登录或切换 Claude 账号', run: () => showLogin() },
	{ name: 'logout', desc: '退出登录', run: () => confirmLogout() },
	{ name: 'help', desc: '列出所有命令', run: () => cmdHelp() },
];
// Chinese descriptions for Claude Code's own commands (it reports them in English).
const CC_DESC = {
	compact: '压缩对话，释放上下文空间', context: '查看上下文占用了多少', cost: '查看这次对话的花费和用时', init: '为当前目录生成 CLAUDE.md',
	review: '审查代码改动', 'security-review': '对当前改动做安全审查', 'pr-comments': '查看 Pull Request 的评论', todos: '查看待办清单',
	'release-notes': 'Claude Code 的更新说明', insights: '分析你的使用习惯', 'extra-usage': '额外用量设置', heapdump: '导出内存快照（排查问题用）',
};
const appCommand = (name) => APP_COMMANDS.find((c) => c.name === name || (c.aliases || []).includes(name));
let slashCommands = [];
async function loadSlashCommands(probe) {
	const r = await getJSON(`/api/commands?sessionId=${encodeURIComponent(curSession?.id || '')}${probe ? '&probe=1' : ''}`);
	if (r.ok) slashCommands = (r.commands || []).filter((c) => !appCommand(c.name) && !c.name.startsWith('__')); // __: Claude Code's internals
	if (/^\/\S*$/.test(input.value)) checkSlashInput(); // the menu is open: show the new list in it
}
function hideSlash() { $('#slash-menu').classList.add('hidden'); }
function checkSlashInput() {
	const m = input.value.match(/^\/(\S*)$/);
	if (!m) return hideSlash();
	const q = m[1].toLowerCase();
	const named = (name, aliases) => !q || name.toLowerCase().startsWith(q) || (aliases || []).some((a) => a.toLowerCase().startsWith(q));
	// Descriptions are searched only when no command is called that: "/pd" means /pdf, not every
	// command that mentions a "pd" somewhere.
	const anyNamed = [...APP_COMMANDS, ...slashCommands].some((c) => named(c.name, c.aliases));
	const hit = (name, aliases, desc) => named(name, aliases) || (!anyNamed && q.length > 1 && String(desc || '').toLowerCase().includes(q));
	const app = APP_COMMANDS.filter((c) => hit(c.name, c.aliases, c.desc)).map((c) => ({ kind: 'app', name: c.name, hint: c.hint || '', desc: c.desc }));
	const found = slashCommands.filter((c) => hit(c.name, c.aliases, c.description));
	const ccRow = (c) => ({ kind: 'cc', name: c.name, hint: c.argumentHint || '', desc: CC_DESC[c.name] || c.description || '' });
	const skills = found.filter((c) => c.kind === 'skill').map(ccRow);
	const cc = found.filter((c) => c.kind !== 'skill').map(ccRow);
	const menu = $('#slash-menu');
	if (!app.length && !skills.length && !cc.length) return hideSlash();
	const row = (c) => `<button class="slash-item" data-kind="${c.kind}" data-name="${esc(c.name)}"><span class="slash-name">/${esc(c.name)}${c.hint ? ` <span class="slash-hint">${esc(c.hint)}</span>` : ''}</span><span class="slash-desc">${esc(c.desc)}</span></button>`;
	const group = (title, rows) => (rows.length ? `<div class="slash-group">${title}</div>${rows.map(row).join('')}` : '');
	// Skills first: on a phone, whatever sits below twenty App commands may as well not exist.
	menu.innerHTML = group('技能', skills) + group('App', app) + group('Claude Code', cc);
	menu.classList.remove('hidden');
	menu.scrollTop = 0;
	$$('.slash-item', menu).forEach((b) => b.addEventListener('click', () => chooseSlash(b.dataset.kind, b.dataset.name)));
}
function clearInput() { input.value = ''; autosize(); updateSendState(); }
function chooseSlash(kind, name) {
	hideSlash();
	const app = kind === 'app' && appCommand(name);
	const cc = kind === 'cc' && slashCommands.find((c) => c.name === name);
	if ((app && app.hint) || (cc && cc.argumentHint)) { input.value = `/${name} `; autosize(); updateSendState(); input.focus(); return; }
	if (app) { clearInput(); app.run(''); return; }
	input.value = '/' + name; // a Claude Code command: send it as it is
	send();
}
// A typed "/status" (etc.) is handled here instead of being sent; true when it was.
function runAppCommand(text) {
	const m = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text);
	const cmd = m && appCommand(m[1]);
	if (!cmd) return false;
	clearInput();
	hideSlash();
	cmd.run((m[2] || '').trim());
	return true;
}

async function cmdStatus() {
	const card = infoCard('状态', 'i-info', '<div class="empty-state"><span class="spin"></span></div>');
	const [rt, acct, upd, mcp, sk, px] = await Promise.all(['/api/runtime', '/api/account', '/api/update', '/api/mcp', '/api/skills', '/api/proxy'].map(getJSON));
	const a = acct.ok && acct.account;
	const mcpNames = Object.keys(mcp.servers || {});
	const mcpOn = (mcp.status || []).filter((x) => x.status === 'connected').length;
	const mode = MODES.find((x) => x.id === SETTINGS.mode);
	const effort = (EFFORTS.find(([id]) => id === SETTINGS.effort) || [])[1];
	$('.info-b', card).innerHTML = kvRow('DroidAgent', upd.ok && upd.update.current ? `版本 ${upd.update.current}` : '')
		+ kvRow('Claude Code', rt.chat ? `${rt.chat.version}（${rt.chat.label}）` : '没有能运行的 Claude Code')
		+ kvRow('模型', `${SETTINGS.modelName || SETTINGS.model}，思考强度 ${effort || SETTINGS.effort}${SETTINGS.fastMode ? '，快速模式' : ''}`)
		+ kvRow('执行模式', mode ? mode.label : SETTINGS.mode)
		+ kvRow('账号', a ? `${a.email || ''}${SUBSCRIPTION_LABEL[a.subscriptionType] ? `（Claude ${SUBSCRIPTION_LABEL[a.subscriptionType]}）` : ''}` : '未登录')
		+ kvRow('工作目录', rt.cwd)
		+ kvRow('MCP 服务器', mcpNames.length ? `${mcpNames.length} 个，已连接 ${mcpOn} 个` : '没有')
		+ kvRow('技能', sk.ok ? `已启用 ${sk.skills.filter((x) => x.enabled && x.loadable).length} 个` : '')
		+ kvRow('网络代理', px.ok ? (px.proxy || '直连') : '')
		+ kvRow('对话', curSession?.claudeSessionId ? `Claude 会话 ${curSession.claudeSessionId.slice(0, 8)}` : '还没开始');
}
async function cmdUsage() {
	const card = infoCard('用量与额度', 'i-pulse', '<div class="empty-state"><span class="spin"></span></div>');
	const r = await loadUsage(true);
	const b = $('.info-b', card);
	if (!r.ok) { b.innerHTML = `<div class="empty-state">${esc(r.error || '读取用量失败')}</div>`; return; }
	const rl = r.rate_limits || {};
	b.innerHTML = (usageBar('5 小时', rl.five_hour) + usageBar('本周', rl.seven_day) + usageBar('本周 Opus', rl.seven_day_opus) + usageBar('本周 Sonnet', rl.seven_day_sonnet)) || '<div class="empty-state">这个账号没有用量窗口</div>';
}
async function cmdDoctor() {
	const card = infoCard('环境检查', 'i-pulse', '<div class="empty-state"><span class="spin"></span>正在检查</div>');
	const [rt, net, acct, upd] = await Promise.all(['/api/runtime', '/api/netcheck', '/api/account', '/api/update'].map(getJSON));
	const tried = (rt.tried || []).map((t) => `${t.ok ? '✓' : '✗'} ${t.label}：${t.detail}`).join('\n');
	$('.info-b', card).innerHTML = kvRow('Claude Code', rt.chat ? `用 ${rt.chat.label}（${rt.chat.version}）` : '没有能运行的')
		+ (tried ? `<pre class="info-pre">${esc(tried)}</pre>` : '')
		+ kvRow('连接 Claude', net.ok ? `正常${net.proxy ? `（经代理 ${net.proxy}）` : '（直连）'}` : `连不上：${net.summary || ''}`)
		+ kvRow('登录', acct.ok && acct.account ? `已登录 ${acct.account.email || ''}` : '未登录')
		+ kvRow('自动更新', upd.ok ? (upd.update.error || (upd.update.available ? `有新版本 ${upd.update.latest}` : `已是最新 ${upd.update.current || ''}`)) : '')
		+ kvRow('Node.js', rt.node);
}
function cmdHelp() {
	const row = (n, h, d) => `<div class="help-row"><code>/${esc(n)}${h ? ' ' + esc(h) : ''}</code><span>${esc(d)}</span></div>`;
	const group = (title, list) => (list.length ? `<div class="help-group">${title}</div>${list.map((c) => row(c.name, c.argumentHint, CC_DESC[c.name] || c.description || '')).join('')}` : '');
	infoCard('命令', 'i-terminal', group('技能', slashCommands.filter((c) => c.kind === 'skill'))
		+ `<div class="help-group">App</div>${APP_COMMANDS.map((c) => row(c.name, c.hint, c.desc + ((c.aliases || []).length ? `（也可以用 /${c.aliases.join('、/')}）` : ''))).join('')}`
		+ group('Claude Code', slashCommands.filter((c) => c.kind !== 'skill')));
}
async function cmdExport() {
	const r = await getJSON('/api/sessions');
	const sess = r.activeSession && r.activeSession.id === curSession?.id ? r.activeSession : curSession;
	if (!sess || !(sess.messages || []).length) { toast('这个对话还是空的'); return; }
	const out = [`# ${sess.title || '对话'}`, ''];
	for (const m of sess.messages) {
		if (m.role === 'user') out.push('## 我', '', m.text, '');
		else if (m.role === 'assistant') out.push('## Claude', '', m.text, '');
		else if (m.role === 'tool' && m.kind !== 'todo') out.push(`- ${m.state === 'err' ? '✗' : '✓'} ${m.title}`, '');
	}
	copyText(out.join('\n').replace(/\n{3,}/g, '\n\n'), '已复制整段对话');
}
async function renameCurrent(title) {
	if (!curSession) return;
	if (!title) { promptRename(curSession); return; }
	const r = await api('/api/sessions/rename', { id: curSession.id, title });
	if (r.ok) { curSession.title = title; chatTitle.textContent = title; fetchSessions(); toast('已重命名'); }
}
function confirmLogout() {
	showDialog({
		title: '退出登录？', msg: '退出后要重新登录才能继续对话。', ok: '退出登录', danger: true,
		onOk: async () => { await api('/api/account/logout'); closeAll(); refreshAccount(); },
	});
}

/* ---------------- attach menu ---------------- */
$('#btn-attach').addEventListener('click', (e) => openMenu('menu-attach', e.currentTarget));
$$('#menu-attach .tile').forEach((t) => t.addEventListener('click', () => {
	const act = t.dataset.act;
	closeMenu();
	if (act === 'album') $('#file-image').click();
	else if (act === 'shot') takeShot();
	else if (act === 'app') openAppsSheet();
	else if (act === 'folder') openFsSheet(true);
	else if (act === 'file') openFsSheet(false);
	else if (act === 'path') {
		showDialog({
			title: '添加路径', msg: '输入手机里的绝对路径：', input: true, value: '/sdcard/', presets: true, ok: '添加',
			onOk: (v) => { if (v && v.trim()) addScope({ type: 'path', path: v.trim() }); },
		});
	}
}));
async function takeShot() {
	toast('正在截屏…');
	const r = await api('/api/screenshot');
	if (r.ok) { addScope({ type: 'image', name: '屏幕截图', path: r.path }); toast('截图已添加'); }
	else toast('截屏失败：' + (r.error || ''));
}
$('#file-image').addEventListener('change', (e) => {
	const f = e.target.files[0];
	e.target.value = '';
	if (!f) return;
	if (f.size > 14e6) { toast('图片太大了，请选择 14 MB 以内的图片'); return; } // base64 of it must fit the server's 20 MB limit
	const reader = new FileReader();
	reader.onload = async () => {
		const dataUrl = reader.result;
		const r = await api('/api/upload', { dataUrl, filename: f.name });
		if (r.ok) addScope({ type: 'image', name: f.name, path: r.path, dataUrl });
		else toast('图片上传失败：' + (r.error || ''));
	};
	reader.readAsDataURL(f);
});

/* ---------------- app picker ---------------- */
let allApps = [];
function renderApps(apps) {
	const list = $('#apps-list');
	list.innerHTML = '';
	if (!apps.length) { list.innerHTML = '<div class="empty-state">没有匹配的应用</div>'; return; }
	const frag = document.createDocumentFragment();
	apps.forEach((a) => {
		const row = el('div', 'pick-row');
		row.innerHTML = `<div class="pick-ic">${esc((a.name || a.package || '?').trim()[0] || '?')}</div><div class="pick-main"><div class="pick-name">${esc(a.name)}</div><div class="pick-sub">${esc(a.package)}</div></div>`;
		row.addEventListener('click', () => { addScope({ type: 'app', name: a.name, package: a.package }); closeLayer('sheet'); });
		frag.appendChild(row);
	});
	list.appendChild(frag);
}
async function openAppsSheet() {
	$('#apps-search').value = '';
	$('#apps-list').innerHTML = '<div class="empty-state"><span class="spin"></span></div>';
	openSheet('sheet-apps');
	const r = await getJSON('/api/apps');
	if (r.ok) { allApps = r.apps || []; renderApps(allApps); }
	else $('#apps-list').innerHTML = '<div class="empty-state">读取应用列表失败</div>';
}
$('#apps-search').addEventListener('input', (e) => {
	const q = e.target.value.trim().toLowerCase();
	renderApps(allApps.filter((a) => (a.name || '').toLowerCase().includes(q) || (a.package || '').toLowerCase().includes(q)));
});

/* ---------------- file picker ---------------- */
let fsFolderMode = true;
let curFsPath = '/sdcard';
let parentFsPath = '/';
const FS_ICON = { 图片: 'i-image', APK: 'i-box', 文本: 'i-doc', 代码: 'i-terminal' };
function openFsSheet(folderMode) {
	fsFolderMode = folderMode;
	$('#fs-title').textContent = folderMode ? '选择文件夹' : '选择文件';
	$('#fs-select-dir').textContent = folderMode ? '选择这个文件夹' : '把这个文件夹作为范围';
	$('#fs-search').value = '';
	openSheet('sheet-fs');
	loadFsPath('/sdcard');
}
async function loadFsPath(p, q) {
	const list = $('#fs-list');
	list.innerHTML = '<div class="empty-state"><span class="spin"></span></div>';
	let u = `/api/fs?path=${encodeURIComponent(p)}`;
	if (q) u += `&q=${encodeURIComponent(q)}`;
	const r = await getJSON(u);
	if (!r.ok) { list.innerHTML = `<div class="empty-state">打不开这个文件夹：${esc(r.error || '')}</div>`; return; }
	if (!q) { curFsPath = r.currentPath; parentFsPath = r.parentPath; $('#fs-path').textContent = curFsPath; }
	const items = r.items || [];
	list.innerHTML = '';
	if (!items.length) { list.innerHTML = `<div class="empty-state">${q ? '没有匹配的文件' : '这个文件夹是空的'}</div>`; return; }
	const frag = document.createDocumentFragment();
	items.forEach((item) => {
		const row = el('div', 'pick-row');
		const meta = [item.kind, item.sizeText].filter(Boolean).join('，');
		row.innerHTML = `<div class="pick-ic${item.isDir ? ' dir' : ''}">${ic(item.isDir ? 'i-folder' : FS_ICON[item.kind] || 'i-file')}</div><div class="pick-main"><div class="pick-name">${esc(item.name)}</div><div class="pick-sub">${esc(q ? item.path : meta)}</div></div>${item.isDir ? ic('i-chev', 'chev') : ''}`;
		row.addEventListener('click', () => {
			if (item.isDir) { $('#fs-search').value = ''; loadFsPath(item.path); }
			else { addScope({ type: 'file', name: item.name, path: item.path }); closeLayer('sheet'); }
		});
		frag.appendChild(row);
	});
	list.appendChild(frag);
}
$$('.fs-presets button').forEach((b) => b.addEventListener('click', () => { $('#fs-search').value = ''; loadFsPath(b.dataset.path); }));
$('#fs-up').addEventListener('click', () => { if (parentFsPath && parentFsPath !== curFsPath) loadFsPath(parentFsPath); });
$('#fs-select-dir').addEventListener('click', () => { addScope({ type: 'folder', name: curFsPath.split('/').pop() || curFsPath, path: curFsPath }); closeLayer('sheet'); });
let fsSearchTimer = null;
$('#fs-search').addEventListener('input', (e) => {
	clearTimeout(fsSearchTimer);
	const q = e.target.value.trim();
	fsSearchTimer = setTimeout(() => loadFsPath(curFsPath, q || undefined), 350);
});

/* ================================================================ conversations drawer */
let sessionsList = [];
let searchQuery = '';
function openDrawer() {
	fetchSessions();
	const d = $('#drawer'), scrim = $('#drawer-scrim');
	show(scrim); show(d);
	$('#app').classList.add('dimmed');
	openLayer('drawer', () => { hide(d); hide(scrim); $('#app').classList.remove('dimmed'); });
}
const closeDrawer = () => closeLayer('drawer');
$('#btn-menu').addEventListener('click', openDrawer);
$('#drawer-scrim').addEventListener('click', closeDrawer);
$('#drawer-settings').addEventListener('click', () => { closeDrawer(); openPage('page-settings'); });
$('#drawer-account').addEventListener('click', () => { closeDrawer(); openPage('page-settings'); });

async function fetchSessions() {
	const r = await getJSON('/api/sessions');
	if (!r.ok) return;
	sessionsList = r.sessions || [];
	runningIds.clear(); (r.runningIds || []).forEach((x) => runningIds.add(x));
	pendingIds.clear(); (r.pendingIds || []).forEach((x) => pendingIds.add(x));
	if (r.activeSession && (!curSession || curSession.id === r.activeSession.id)) {
		curSession = r.activeSession;
		chatTitle.textContent = curSession.title || '新对话';
	}
	// Opened while this conversation is mid-turn: offer Stop. (Never clears it here: right after
	// sending, the server may not list the turn yet; the turn's own result event clears it.)
	if (curSession && runningIds.has(curSession.id) && !running) setRunning(true);
	const act = curSession && r.activity && r.activity[curSession.id];
	if (act && runningIds.has(curSession.id)) setActivity(act.label || '正在思考', act.since || undefined);
	renderSidebar();
}
function groupOf(ts) {
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const day = 864e5;
	if (ts >= today) return '今天';
	if (ts >= today - day) return '昨天';
	if (ts >= today - 6 * day) return '近 7 天';
	if (ts >= today - 29 * day) return '近 30 天';
	return '更早';
}
function renderSidebar() {
	const box = $('#session-groups');
	box.innerHTML = '';
	const q = searchQuery.trim().toLowerCase();
	// A conversation nothing has been said in yet is not listed (it shows up with its first message).
	const blank = (s) => s.msgCount === 0 && !s.pinned && (s.title || '新对话') === '新对话';
	const list = sessionsList.filter((s) => !blank(s) && (!q || (s.title || '').toLowerCase().includes(q) || (s.preview || '').toLowerCase().includes(q)));
	if (!list.length) { box.innerHTML = `<div class="drawer-empty">${q ? '没有找到相关对话' : '还没有对话'}</div>`; return; }
	const groups = new Map();
	for (const s of list) {
		const g = s.pinned ? '置顶' : groupOf(s.updatedAt || 0);
		if (!groups.has(g)) groups.set(g, []);
		groups.get(g).push(s);
	}
	const order = ['置顶', '今天', '昨天', '近 7 天', '近 30 天', '更早'];
	for (const g of order) {
		if (!groups.has(g)) continue;
		box.appendChild(el('div', 'group-title', g));
		for (const s of groups.get(g)) box.appendChild(sessionRow(s));
	}
}
function sessionRow(s) {
	const row = el('div', 'session-row' + (curSession && curSession.id === s.id ? ' active' : ''));
	row.innerHTML = `<span class="s-title"></span>${pendingIds.has(s.id) ? '<span class="live-dot pending"></span>' : runningIds.has(s.id) ? '<span class="live-dot running"></span>' : ''}<button class="s-more" aria-label="更多操作">${ic('i-more', 'sm')}</button>`;
	$('.s-title', row).textContent = s.title || '新对话';
	const more = $('.s-more', row);
	more.addEventListener('click', (e) => { e.stopPropagation(); openRowMenu(s, more); });
	let pressTimer = null, pressed = false;
	row.addEventListener('pointerdown', () => { pressed = false; pressTimer = setTimeout(() => { pressed = true; navigator.vibrate?.(12); openRowMenu(s, more); }, 480); });
	['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => row.addEventListener(ev, () => clearTimeout(pressTimer)));
	row.addEventListener('contextmenu', (e) => e.preventDefault());
	row.addEventListener('click', () => {
		if (pressed) return;
		if (curSession && curSession.id === s.id) { closeDrawer(); return; }
		switchSession(s.id);
	});
	return row;
}
let rowTarget = null;
function openRowMenu(s, anchor) {
	rowTarget = s;
	$('#row-pin-label').textContent = s.pinned ? '取消置顶' : '置顶';
	openMenu('menu-row', anchor);
}
$$('#menu-row .menu-row').forEach((b) => b.addEventListener('click', () => {
	const s = rowTarget, act = b.dataset.act;
	closeMenu();
	if (!s) return;
	if (act === 'pin') togglePin(s.id, !s.pinned);
	else if (act === 'rename') promptRename(s);
	else if (act === 'delete') confirmDelete(s);
}));
$('#search-input').addEventListener('input', (e) => { searchQuery = e.target.value; renderSidebar(); });

async function switchSession(id) {
	const r = await api('/api/sessions/switch', { id });
	if (r.ok && r.session) {
		curSession = r.session;
		renderTranscript(curSession);
		setRunning(runningIds.has(id));
		closeDrawer();
		fetchSessions();
		loadSlashCommands();
	}
}
async function createNewChat() {
	// Already on an empty conversation: that is the new one.
	if ($('#welcome') && !running) { closeDrawer(); input.focus(); return; }
	const r = await api('/api/sessions/new');
	if (r.ok && r.session) {
		curSession = r.session;
		renderTranscript(curSession);
		setRunning(false);
		closeDrawer();
		fetchSessions();
		loadSlashCommands();
		input.focus();
	}
}
$('#btn-new').addEventListener('click', createNewChat);
$('#drawer-new').addEventListener('click', createNewChat);
async function togglePin(id, pinned) {
	const r = await api('/api/sessions/pin', { id, pinned });
	if (r.ok) {
		const t = sessionsList.find((s) => s.id === id); if (t) t.pinned = pinned;
		renderSidebar();
		toast(pinned ? '已置顶' : '已取消置顶');
	}
}
function promptRename(s) {
	showDialog({
		title: '重命名对话', input: true, value: s.title || '', ok: '保存',
		onOk: async (v) => {
			const title = (v || '').trim();
			if (!title) return;
			const r = await api('/api/sessions/rename', { id: s.id, title });
			if (r.ok) {
				s.title = title;
				if (curSession && curSession.id === s.id) { curSession.title = title; chatTitle.textContent = title; }
				renderSidebar();
			}
		},
	});
}
function confirmDelete(s) {
	showDialog({
		title: '删除对话？', msg: `「${s.title || '新对话'}」会被永久删除。`, ok: '删除', danger: true,
		onOk: async () => {
			const r = await api('/api/sessions/delete', { id: s.id });
			if (r.ok) {
				sessionsList = sessionsList.filter((x) => x.id !== s.id);
				if (r.activeSession) { curSession = r.activeSession; renderTranscript(curSession); setRunning(runningIds.has(curSession.id)); }
				renderSidebar();
				toast('已删除');
			}
		},
	});
}
$('#row-clear').addEventListener('click', () => {
	showDialog({
		title: '清空全部对话？', msg: '所有对话记录都会被删除，无法恢复。', ok: '全部清空', danger: true,
		onOk: async () => {
			const r = await api('/api/sessions/clear');
			if (r.ok) { sessionsList = []; curSession = r.session; renderTranscript(curSession); setRunning(false); renderSidebar(); toast('已清空'); }
		},
	});
});

/* ================================================================ settings pages */
const SUBSCRIPTION_LABEL = { pro: 'Pro', max: 'Max', max5x: 'Max 5x', max20x: 'Max 20x', team: 'Team', enterprise: 'Enterprise' };
const AUTH_METHOD_LABEL = { 'claude.ai': 'Claude 账号' };
const API_PROVIDER_LABEL = { firstParty: 'Anthropic', bedrock: 'AWS Bedrock', vertex: 'Google Vertex', foundry: 'Azure Foundry', gateway: '企业网关' };
let account = null;
let loggedIn = false;
async function refreshAccount() {
	const r = await getJSON('/api/account');
	account = r.ok && r.account ? r.account : null;
	const email = account?.email || '';
	const initial = email ? email.trim()[0].toUpperCase() : '·';
	const plan = account ? (SUBSCRIPTION_LABEL[account.subscriptionType] ? `Claude ${SUBSCRIPTION_LABEL[account.subscriptionType]}` : (account.orgName || '已登录')) : '';
	for (const [av, em, pl, out] of [['#drawer-avatar', '#drawer-email', '#drawer-plan', '点此登录'], ['#set-avatar', '#set-email', '#set-plan', '登录 Claude 账号']]) {
		$(av).textContent = initial;
		$(av).classList.toggle('out', !email);
		$(em).textContent = email || '未登录';
		$(pl).textContent = email ? plan : out;
	}
}
$('#set-account').addEventListener('click', () => {
	if (!account) { closeAll(); showLogin(); return; }
	openPage('page-account');
});
const kv = (label, value) => (value == null || value === '' ? '' : `<div class="row"><span class="row-text">${esc(label)}</span><span class="row-val">${esc(String(value))}</span></div>`);
PAGE_OPEN['page-account'] = () => {
	const body = $('#account-body');
	const a = account;
	if (!a) { body.innerHTML = '<div class="empty-state">尚未登录</div>'; return; }
	const initial = (a.email || '?').trim()[0]?.toUpperCase() || '?';
	let scopes = '';
	if (Array.isArray(a.scopes)) {
		const full = ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload', 'user:plugins'];
		const missing = full.filter((x) => !a.scopes.includes(x));
		scopes = missing.length ? `缺少 ${missing.join('、')}，重新登录可补全` : `完整（${a.scopes.length} 项）`;
	}
	body.innerHTML = `<div class="acct-head"><span class="avatar">${esc(initial)}</span><div class="acct-email">${esc(a.email || '未知邮箱')}</div><div class="acct-org">${esc(a.orgName || a.organization || '')}</div>${SUBSCRIPTION_LABEL[a.subscriptionType] ? `<span class="acct-plan">Claude ${esc(SUBSCRIPTION_LABEL[a.subscriptionType])}</span>` : ''}</div>
		<h2 class="group-label">详细信息</h2><div class="list kv">${kv('登录方式', AUTH_METHOD_LABEL[a.authMethod] || a.authMethod)}${kv('服务提供方', API_PROVIDER_LABEL[a.apiProvider] || a.apiProvider)}${kv('授权范围', scopes)}${kv('组织 ID', a.orgId)}${kv('配置目录', a.configDirectory)}</div>
		<button class="pill-btn danger logout" id="account-logout">退出登录</button>`;
	$('#account-logout').addEventListener('click', () => showDialog({
		title: '退出登录？', msg: '退出后要重新登录才能继续对话。', ok: '退出登录', danger: true,
		onOk: async () => { await api('/api/account/logout'); closeAll(); refreshAccount(); },
	}));
};

PAGE_OPEN['page-settings'] = async () => {
	updateLookValues();
	refreshAccount();
	loadUpdate();
	const sp = await getJSON('/api/systemprompt');
	$('#val-prompt').textContent = sp.ok && sp.text && sp.text.trim() ? '已设置' : '未设置';
};
$('#t-autoupdate').addEventListener('change', (e) => pushSettings({ autoUpdate: e.target.checked }));

/* ---------------- system prompt ---------------- */
PAGE_OPEN['page-prompt'] = async () => {
	$('#prompt-text').value = '';
	const r = await getJSON('/api/systemprompt');
	$('#prompt-text').value = r.ok ? (r.text || '') : '';
};
$('#prompt-save').addEventListener('click', async () => {
	const text = $('#prompt-text').value;
	const r = await api('/api/systemprompt', { text });
	if (r.ok === false) { toast('保存失败'); return; }
	$('#val-prompt').textContent = text.trim() ? '已设置' : '未设置';
	closePage('page-prompt');
	toast('已保存，从新对话开始生效');
});

/* ---------------- self-update ---------------- */
function fmtAgo(ts) {
	if (!ts) return '';
	const m = Math.round((Date.now() - ts) / 60000);
	return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : `${Math.round(m / 60)} 小时前`;
}
let announcedInstall = '';
function renderUpdate(u) {
	if (!u) return;
	$('#update-line').textContent = u.current || '';
	$('#val-version').textContent = u.current || '';
	if (u.current) installedVersion = u.current;
	let sub;
	if (u.installing) sub = `正在安装 ${u.latest}，App 会自动重新打开`;
	else if (u.checking) sub = '正在检查';
	else if (u.error) sub = u.error;
	else if (u.available) sub = u.autoUpdate ? `发现 ${u.latest}，当前对话结束后自动安装` : `有新版本 ${u.latest}`;
	else if (u.lastCheck) sub = `已是最新，${fmtAgo(u.lastCheck)}检查过`;
	else sub = '还没有检查过';
	$('#update-sub').textContent = sub;
	$('#update-sub-row').textContent = u.available && !u.installing ? `有新版本 ${u.latest}` : sub;
	const btn = $('#btn-check-update');
	btn.textContent = u.available && !u.installing ? '立即更新' : '检查更新';
	btn.classList.toggle('accent', !!(u.available && !u.installing));
	btn.disabled = !!(u.checking || u.installing);
	if (u.installing && announcedInstall !== u.latest) { announcedInstall = u.latest; sysline(`正在安装 DroidAgent ${u.latest}，完成后 App 会自动重新打开`); }
}
async function loadUpdate() { const r = await getJSON('/api/update'); if (r.ok) renderUpdate(r.update); }

// Every release's notes, newest first (the same text as the GitHub release pages).
let installedVersion = '';
async function loadChangelog() {
	const box = $('#changelog');
	const r = await getJSON('/api/changelog');
	if (!r.ok) { box.innerHTML = `<div class="empty-state">${esc(r.error || '读取失败')}</div>`; return; }
	const parts = String(r.text).split(/^## +/m).slice(1);
	if (!parts.length) { box.innerHTML = '<div class="empty-state">暂无更新记录</div>'; return; }
	box.innerHTML = '';
	for (const part of parts) {
		const nl = part.indexOf('\n');
		const ver = (nl < 0 ? part : part.slice(0, nl)).trim();
		const body = nl < 0 ? '' : part.slice(nl + 1).trim();
		const item = el('article', 'cl-item' + (ver === installedVersion ? ' current' : ''));
		item.innerHTML = `<div class="cl-head"><span class="cl-ver">${esc(ver)}</span>${ver === installedVersion ? '<span class="badge builtin">当前版本</span>' : ''}</div><div class="cl-body md">${md(body)}</div>`;
		box.appendChild(item);
	}
}
PAGE_OPEN['page-version'] = async () => { await loadUpdate(); loadChangelog(); };
$('#btn-check-update').addEventListener('click', async () => {
	$('#btn-check-update').disabled = true;
	$('#update-sub').textContent = '正在检查';
	const r = await api('/api/update/check', { install: true });
	if (r.update) renderUpdate(r.update);
	else { $('#update-sub').textContent = r.error || '检查失败'; $('#btn-check-update').disabled = false; }
});
// After an update, say once what changed.
function showUpdateNotice(u) {
	if (!u || !u.to || Date.now() - (u.at || 0) > 3 * 86400e3) return;
	let seen = '';
	try { seen = localStorage.getItem('seenUpdate') || ''; } catch { /* */ }
	if (seen === u.to) return;
	try { localStorage.setItem('seenUpdate', u.to); } catch { /* */ }
	const notes = String(u.notes || '').split('\n').map((l) => l.trim().replace(/^[-*]\s*/, '')).filter((l) => l && !/^#|^---/.test(l)).slice(0, 6).join('；');
	sysline(`DroidAgent 已更新到 ${u.to}${notes ? '：' + notes : ''}`);
}

/* ================================================================ login */
function showLogin() { closeAll(); $('#login').classList.remove('hidden'); loadProxy(); }
function hideLogin() { $('#login').classList.add('hidden'); }
function setLoginMsg(kind, text) { const m = $('#login-msg'); m.className = 'login-msg' + (kind ? ' ' + kind : ''); m.textContent = text || ''; }
function showNetBox() { $('#login-net').classList.remove('hidden'); }
function loginWaiting(on) { $('#login-start').classList.toggle('hidden', on); $('#login-wait').classList.toggle('hidden', !on); }
let verifyTimer = null, verifyStart = 0, verifyLine = '';
function verifyText() {
	const secs = Math.round((Date.now() - verifyStart) / 1000);
	let t = `正在验证授权码（${secs} 秒）`;
	if (verifyLine) t += `\nclaude：${verifyLine}`;
	if (secs >= 20) t += '\n超过 20 秒还没结果，多半是连不上 Claude。可以点「取消，重新开始」，填好代理端口后再登录。';
	return t;
}
function startVerify() {
	stopVerify();
	verifyStart = Date.now(); verifyLine = '';
	setLoginMsg('wait', verifyText());
	verifyTimer = setInterval(() => {
		setLoginMsg('wait', verifyText());
		if (Date.now() - verifyStart >= 20000) $('#login-cancel').classList.remove('hidden');
	}, 1000);
}
function stopVerify() { if (verifyTimer) clearInterval(verifyTimer); verifyTimer = null; $('#login-cancel').classList.add('hidden'); }
function backToStart(label) {
	stopVerify();
	loginWaiting(false);
	$('#login-submit').disabled = false;
	$('#login-step2').classList.add('hidden');
	$('#login-step1').classList.remove('hidden');
	$('#login-start').textContent = label || '重新开始登录';
}
$('#login-cancel').addEventListener('click', () => { api('/api/login/cancel'); backToStart(); setLoginMsg('', ''); showNetBox(); });
function loginStatus(m) {
	if (m.proxy) $('#login-proxy').value = m.proxy;
	if (m.kind === 'cli') { verifyLine = m.text; setLoginMsg('wait', verifyTimer ? verifyText() : `claude：${m.text}`); return; }
	if (m.kind === 'warn') showNetBox();
	setLoginMsg(m.kind === 'warn' ? 'err' : m.kind === 'ok' ? 'ok' : 'wait', m.text);
}
$('#login-start').addEventListener('click', () => { setLoginMsg('', ''); loginWaiting(true); api('/api/login/start'); });
// 'auto': after "Authorize" the browser goes straight back to claude on this phone
// (http://localhost:…/callback) and the login finishes by itself; pasting is only a fallback.
const LOGIN_TEXT = {
	auto: {
		step1: '用你的 Claude 账号登录，然后点「Authorize」。授权后浏览器会跳回本机，登录自动完成，回到这里就行。',
		title: '没有自动完成？',
		step2: '如果浏览器最后停在一个打不开的 localhost 页面，复制它地址栏里的完整网址，粘贴到这里。',
		placeholder: '粘贴 http://localhost:… 网址', submit: '提交',
		waiting: '等你在浏览器里点「Authorize」，授权后这里会自动完成。',
	},
	manual: {
		step1: '用你的 Claude 账号登录，然后点「Authorize」。',
		title: '粘贴授权码',
		step2: '授权后页面会显示一串授权码，点「Copy code」再粘贴到这里。整条回调网址也可以直接粘贴。',
		placeholder: '粘贴授权码', submit: '完成登录', waiting: '',
	},
};
function loginUrl(url, mode) {
	const t = LOGIN_TEXT[mode] || LOGIN_TEXT.manual;
	loginWaiting(false);
	$('#login-step1').classList.add('hidden');
	$('#login-step2').classList.remove('hidden');
	const a = $('#login-url'); a.href = url; a.dataset.url = url;
	$('#login-step1-hint').textContent = t.step1;
	$('#login-step2-title').textContent = t.title;
	$('#login-step2-hint').textContent = t.step2;
	$('#login-code').placeholder = t.placeholder;
	$('#login-submit').textContent = t.submit;
	$('#login-code').value = '';
	$('#login-submit').disabled = false;
	if (!$('#login-msg').textContent || $('#login-msg').classList.contains('wait')) setLoginMsg(t.waiting ? 'wait' : '', t.waiting);
}
$('#login-copy').addEventListener('click', () => copyText($('#login-url').dataset.url || '', '链接已复制，可以粘贴到任意浏览器里打开'));
$('#login-submit').addEventListener('click', async () => {
	const code = $('#login-code').value.trim();
	if (!code) { setLoginMsg('err', '先把授权码或网址粘贴到上面的输入框'); $('#login-code').focus(); return; }
	$('#login-submit').disabled = true;
	startVerify();
	const r = await api('/api/login/code', { code });
	if (!r.ok) { backToStart(); setLoginMsg('err', r.error || '登录会话已超时，请重新开始登录'); }
});
function loginDone(ok, message) {
	stopVerify();
	loginWaiting(false);
	$('#login-submit').disabled = false;
	if (ok) { setLoginMsg('ok', '登录成功'); setTimeout(hideLogin, 700); refreshAccount(); loadUsage(true); return; }
	backToStart();
	setLoginMsg('err', '登录失败：' + (message || '请重试'));
	if (/连接|连不上|网络|代理|回应|ETIMEDOUT|ECONN|ENOTFOUND|fetch failed/i.test(message || '')) showNetBox();
}
async function loadProxy() {
	const r = await getJSON('/api/proxy');
	if (r.ok) $('#login-proxy').value = r.proxy || '';
}
$('#login-proxy-save').addEventListener('click', async () => {
	setLoginMsg('wait', '正在保存并测试能否连上 Claude');
	const r = await api('/api/proxy', { proxy: $('#login-proxy').value.trim() });
	if (!r.ok) return setLoginMsg('err', r.error || '保存失败');
	const where = r.proxy ? `代理 ${r.proxy}` : '直连';
	if (r.reachable) setLoginMsg('ok', `已保存，${where}能连上 Claude，现在可以登录了。`);
	else setLoginMsg('err', `已保存，但${where}连不上 Claude（${r.summary}）。请检查端口是否正确、代理软件是否在运行。`);
});

/* ================================================================ live events */
function setConn(state) {
	const st = $('#status');
	st.className = 'status ' + state;
	$('#status-text').textContent = state === 'off' ? '已断开，正在重连' : state === 'connecting' ? '正在连接' : '';
}
function connect() {
	const es = new EventSource('/api/events?main=1'); // main=1: the chat page, not the bubble's panel
	es.onopen = () => setConn('on');
	es.onerror = () => setConn('off');
	es.onmessage = (e) => {
		let m; try { m = JSON.parse(e.data); } catch { return; }
		// Every conversation streams on the same connection; events for one that is not on
		// screen only update the drawer's live dots.
		const mine = !m.sessionId || m.sessionId === curSession?.id;
		switch (m.type) {
			case 'hello':
				// A fresh connection: forget what the last one said was running (after a restart
				// those turns are gone); the session list right below says what still is.
				runningIds.clear(); pendingIds.clear(); setRunning(false);
				applySettings(m.settings);
				if (m.activeSession) { curSession = m.activeSession; renderTranscript(curSession); }
				showUpdateNotice(m.lastUpdate); // after the redraw, which would wipe it
				fetchSessions();
				loadSlashCommands();
				break;
			case 'auth':
				loggedIn = !!m.loggedIn;
				if (!m.loggedIn) showLogin(); else { hideLogin(); loadUsage(); }
				refreshAccount();
				break;
			case 'session_switched':
				curSession = m.session;
				renderTranscript(curSession);
				setRunning(runningIds.has(m.session?.id));
				fetchSessions();
				loadSlashCommands();
				break;
			case 'sessions_updated': sessionsList = m.sessions || []; renderSidebar(); break;
			case 'user_echo':
				if (m.sessionId) runningIds.add(m.sessionId);
				if (mine) { setRunning(true); if (!activity.on) setActivity('正在思考'); fetchSessions(); } else renderSidebar();
				break;
			case 'assistant_delta': if (mine) { appendAssistant(m.text); setActivity('正在回复'); } break;
			case 'assistant_text': if (mine) setAssistant(m.text); break;
			case 'assistant_end': if (mine) endAssistant(); break;
			case 'thinking_start': if (mine) { startThink(); setActivity('正在思考'); } break;
			case 'thinking_delta': if (mine) { addThinkDelta(m.text); setActivity('正在思考'); } break;
			case 'thinking_end': if (mine) endThink(m.ms); break;
			case 'tool_use':
				if (!mine) break;
				if (m.kind === 'todo') { endAssistant(); upsertTodo(m.todos); setActivity('正在更新待办清单'); }
				else { addTool(m.id, m.name, m.title, m.detail, false, m.category); setActivity(doing(m.title || '执行操作')); }
				break;
			case 'tool_result': if (mine) { finishTool(m.id, m.ok, m.summary); setActivity('正在思考'); } break;
			case 'command_output': if (mine) addCmdOut(m.text); break;
			case 'notice': if (mine) sysline(m.text); break;
			case 'title':
				if (curSession && m.sessionId === curSession.id) { curSession.title = m.title; chatTitle.textContent = m.title; }
				break;
			case 'tool_denied': if (mine) sysline(`已拒绝：${m.title}（${m.reason}）`); break;
			case 'permission':
				if (m.sessionId) pendingIds.add(m.sessionId);
				if (mine) { addPermission(m); setActivity('等你确认'); } else renderSidebar();
				break;
			case 'permission_resolved':
				if (m.sessionId) pendingIds.delete(m.sessionId);
				if (permMarks.has(m.id)) { permMarks.get(m.id)(m.decision); permMarks.delete(m.id); } // answered elsewhere, or stopped
				if (mine) { if (running) setActivity('正在思考'); } else renderSidebar();
				break;
			case 'result':
				if (m.sessionId) runningIds.delete(m.sessionId);
				if (mine) {
					endAssistant();
					setRunning(false);
					markTurnTime(m.durationMs);
					if (m.subtype && m.subtype !== 'success') sysline(stoppedIds.has(m.sessionId) ? '已停止' : `这一轮没有做完${m.errors?.[0] ? `：${m.errors[0]}` : '，可以再发一次试试'}`);
					fetchSessions();
				} else renderSidebar();
				stoppedIds.delete(m.sessionId);
				usageSoon();
				break;
			case 'cleared':
				thread.innerHTML = ''; buildWelcome(); setRunning(false); curTodoEl = null;
				runningIds.clear(); pendingIds.clear();
				break;
			case 'settings': applySettings(m.settings); break;
			case 'skills_updated': loadSlashCommands(); break;
			case 'mcp_updated': break;
			case 'plugins_updated': case 'plugin_job': case 'skill_draft': case 'mcp_login_url': case 'mcp_login_done':
				marketEvent(m);
				break;
			case 'error':
				if (m.sessionId) runningIds.delete(m.sessionId);
				if (mine) { endAssistant(); setRunning(false); sysline('出错了：' + m.message); } else renderSidebar();
				break;
			case 'login_url': loginUrl(m.url, m.mode); break;
			case 'login_status': loginStatus(m); break;
			case 'login_done': loginDone(m.ok, m.message); break;
			case 'update_status': renderUpdate(m.update); break;
		}
	};
}

/* ================================================================ start */
// The floating bubble is simply on (it used to have a switch); turn it back on for anyone who
// had switched it off.
try { if (window.AgentHost && typeof AgentHost.enabled === 'function' && !AgentHost.enabled()) AgentHost.setEnabled(true); } catch { /* bridge gone */ }
updateLookValues();
buildWelcome();
updateSendState();
connect();
fetchSessions();
refreshAccount();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
