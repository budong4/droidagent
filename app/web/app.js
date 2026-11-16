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
let openSheetId = null;
function openSheet(id) {
	const s = $('#' + id), scrim = $('#sheet-scrim');
	show(scrim); show(s);
	openSheetId = id;
	openLayer('sheet', () => { hide(s); hide(scrim); if (openSheetId === id) openSheetId = null; });
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
function showDialog({ title, msg = '', html = false, input: withInput = false, value = '', placeholder = '', ok = '确定', cancel = '取消', danger = false, onOk }) {
	$('#dialog-title').textContent = title;
	const m = $('#dialog-msg');
	if (html) m.innerHTML = msg; else m.textContent = msg;
	const inp = $('#dialog-input');
	inp.classList.toggle('hidden', !withInput);
	inp.value = value;
	inp.placeholder = placeholder || '';
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
	if ($('#val-theme-dot')) $('#val-theme-dot').style.background = t?.color || '';
	$('#val-font').textContent = f ? f.name : '';
	const preset = LOOK.PRESETS.find((x) => x.id === look.wall);
	$('#val-bg').textContent = look.wall === 'custom' ? '我的图片' : preset ? preset.name : (t && t.group === 'art' ? '主题插画' : '跟随主题');
	$$('.theme-card').forEach((c) => c.classList.toggle('sel', c.dataset.id === look.theme));
	$$('.font-row').forEach((r) => r.classList.toggle('sel', r.dataset.id === look.font));
	$$('#font-size-seg button').forEach((b) => b.classList.toggle('sel', b.dataset.size === (look.fontSize || 'normal')));
	if ($('#t-collapse-process')) $('#t-collapse-process').checked = look.collapseProcess !== false;
}
$$('#font-size-seg button').forEach((b) => b.addEventListener('click', () => {
	if (look.fontSize !== b.dataset.size) setLook({ fontSize: b.dataset.size });
}));
$('#t-collapse-process')?.addEventListener('change', (e) => {
	setLook({ collapseProcess: e.target.checked });
	if (typeof syncProcessGroups === 'function') syncProcessGroups();
});
renderMainArt();
// The default theme follows the system's dark mode.
const refollow = () => { if (look.theme === 'default') LOOK.apply(look); };
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refollow);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refollow(); if (activity.on) renderActivity(); } });

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
let account = null;
let loggedIn = false;
let accounts = { claude: false, agy: false }; // which of the two is signed in; either is enough to chat
let agyState = null; // /api/agy/status: the CLI, its login, its models
const SETTINGS = { model: 'sonnet', modelName: 'Sonnet 5.5', effort: 'xhigh', fastMode: false, mode: 'acceptEdits', autoUpdate: true };
const MODES = [
	{ id: 'default', label: 'Ask', zh: '每次询问', desc: '只读操作直接做，其他每一步都先问你' },
	{ id: 'acceptEdits', label: 'Accept edits', zh: '自动编辑', desc: '自动改文件、跑常规命令，有风险的操作先问你' },
	{ id: 'plan', label: 'Plan', zh: '仅计划', desc: '只读分析，先拿出计划，你同意后再动手' },
	{ id: 'auto', label: 'Auto', zh: '自动执行', desc: '全部自动执行，只有刷机、重启、格式化这类高危操作才问你' },
	{ id: 'bypassPermissions', label: 'Full access', zh: '完全权限', desc: '完全放开，任何操作都不再询问' },
];
const MODELS = [
	{ id: 'opus', name: 'Opus 5.5', desc: '能力最强，适合复杂架构与复杂推理' },
	{ id: 'sonnet', name: 'Sonnet 5.5', desc: '日常首选，速度与深度思考兼顾' },
	{ id: 'fable', name: 'Fable 5.1', desc: '擅长长文本推演，会消耗额外用量' },
	{ id: 'haiku', name: 'Haiku 5.5', desc: '响应最快，适合轻量与高频任务' },
];
const MORE_MODELS = [['haiku-4.5', 'Haiku 4.5'], ['sonnet-5', 'Sonnet 5'], ['opus-5', 'Opus 5'], ['fable-5', 'Fable 5'], ['opus-4.8', 'Opus 4.8'], ['opus-4.7', 'Opus 4.7'], ['opus-4.6', 'Opus 4.6'], ['sonnet-4.6', 'Sonnet 4.6']];
const EFFORTS = [['low', '低'], ['medium', '中'], ['high', '高'], ['xhigh', '超高'], ['max', '最大']];
const EFFORT_LABEL = Object.fromEntries(EFFORTS);
const EFFORT_LEVEL_RE = /(?:[-_: ](minimal|low|medium|high|xhigh|max|thinking))$/i;
const LABEL_EFFORT_RE = /\s*\((minimal|low|medium|high|xhigh|max|thinking)\)\s*$/i;

const isAgyModel = (m = SETTINGS.model) => String(m || '').startsWith('agy:');
function normEffort(e) {
	const v = String(e || '').toLowerCase();
	if (v === 'minimal') return 'low';
	if (v === 'thinking') return 'high';
	return EFFORT_LABEL[v] ? v : '';
}
function parseAgyModelMeta(m) {
	const rawId = String(m?.id || '');
	const slug = rawId.replace(/^agy:/, '');
	const em = EFFORT_LEVEL_RE.exec(slug);
	const lm = LABEL_EFFORT_RE.exec(String(m?.name || ''));
	const rawEffort = (em?.[1] || lm?.[1] || '').toLowerCase();
	const effort = normEffort(rawEffort);
	const baseSlug = em ? slug.slice(0, em.index) : slug;
	const baseName = String(m?.name || slug).replace(LABEL_EFFORT_RE, '').trim() || baseSlug;
	return { id: rawId, slug, name: m?.name || slug, baseSlug, baseName, rawEffort, effort };
}
function groupAgyModels(models = []) {
	const families = new Map();
	for (const m of models) {
		const meta = parseAgyModelMeta(m);
		let fam = families.get(meta.baseSlug);
		if (!fam) {
			fam = { key: meta.baseSlug, name: meta.baseName, items: [], variants: {} };
			families.set(meta.baseSlug, fam);
		}
		fam.items.push(meta);
		if (meta.effort && !fam.variants[meta.effort]) fam.variants[meta.effort] = meta;
	}
	return [...families.values()].map((fam) => {
		const def = fam.variants.high || fam.variants.medium || fam.variants.xhigh || fam.variants.low || fam.items[0];
		return { ...fam, defaultId: def.id, hasVariants: Object.keys(fam.variants).length > 1 };
	});
}
function pickAgyVariant(fam, targetEffort) {
	if (!fam) return null;
	if (fam.variants[targetEffort]) return fam.variants[targetEffort];
	const order = ['low', 'medium', 'high', 'xhigh', 'max'];
	const idx = Math.max(0, order.indexOf(targetEffort));
	let best = null, bestDist = 99;
	for (const [k, v] of Object.entries(fam.variants)) {
		const ki = order.indexOf(k);
		const d = Math.abs(ki - idx);
		if (ki >= 0 && d < bestDist) { best = v; bestDist = d; }
	}
	return best || fam.items[0];
}
function displayModelSummary() {
	const base = String(SETTINGS.modelName || 'Sonnet 5.5').replace(LABEL_EFFORT_RE, '').trim();
	let eff = SETTINGS.effort;
	if (isAgyModel()) {
		const m = EFFORT_LEVEL_RE.exec(String(SETTINGS.model).replace(/^agy:/, ''));
		if (m) eff = normEffort(m[1]) || eff;
	}
	const effText = EFFORT_LABEL[eff] || eff;
	return effText ? `${base} · ${effText}` : base;
}
function updateSettingsBadges() {
	if ($('#val-model')) $('#val-model').textContent = displayModelSummary();
	const m = MODES.find((x) => x.id === SETTINGS.mode) || MODES[1];
	if ($('#val-mode')) {
		$('#val-mode').textContent = m.zh || m.label;
		$('#val-mode').classList.toggle('val-warn', m.id === 'auto' || m.id === 'bypassPermissions');
	}
	if ($('#val-phone')) $('#val-phone').textContent = typeof bgOn === 'function' && bgOn() ? '后台运行中' : '已开启';
}

function applySettings(s) {
	const prevMode = SETTINGS.mode;
	const prevAgy = isAgyModel();
	Object.assign(SETTINGS, s || {});
	if (prevAgy !== isAgyModel()) { usageData = null; renderUsageRing(); loadUsage(true); loadSlashCommands(); } // another account's numbers and commands
	const m = MODES.find((x) => x.id === SETTINGS.mode) || MODES[1];
	const chip = $('#btn-mode');
	chip.dataset.mode = m.id;
	$('#mode-icon').setAttribute('href', '#m-' + m.id);
	$('#mode-label').textContent = m.label;
	if (prevMode !== SETTINGS.mode) { chip.classList.remove('flash'); void chip.offsetWidth; chip.classList.add('flash'); }
	$('#model-label').textContent = displayModelSummary();
	$('#t-autoupdate').checked = SETTINGS.autoUpdate !== false;
	$('#t-fast').checked = !!SETTINGS.fastMode;
	updateSettingsBadges();
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
		b.innerHTML = `${ic('m-' + m.id)}<span class="mr-text"><span>${esc(m.zh || m.label)} (${esc(m.label)})</span><small>${esc(m.desc)}</small></span>${ic('i-check', 'check')}`;
		b.addEventListener('click', () => chooseMode(m.id));
		list.appendChild(b);
	}
	$('#mode-agy-note').classList.toggle('hidden', !isAgyModel());
}
function chooseMode(id) {
	closeMenu();
	if (id === SETTINGS.mode) return;
	if (id === 'bypassPermissions') {
		showDialog({
			title: '开启 Full access？',
			msg: '开启后助手做任何事都不会再问你，包括刷机、重启、删除系统文件和读取个人数据。只在你清楚它要做什么的时候使用。',
			ok: '开启', danger: true,
			onOk: () => { pushSettings({ mode: id }); toast('已切换到 完全权限'); },
		});
		return;
	}
	pushSettings({ mode: id });
	const m = MODES.find((x) => x.id === id);
	toast('已切换到 ' + (m?.zh || m?.label || id));
}
$('#btn-mode').addEventListener('click', (e) => { renderModeMenu(); openMenu('menu-mode', e.currentTarget); });

/* ---------------- model sheet: pick a model, then that model's own thinking levels ---------------- */
// The levels each Claude model takes (my reading of what each accepts; anything unlisted gets
// low/medium/high). Antigravity's come from the variants its CLI lists for that model.
const CLAUDE_EFFORTS = {
	opus: ['low', 'medium', 'high', 'xhigh', 'max'], sonnet: ['low', 'medium', 'high', 'xhigh', 'max'], fable: ['low', 'medium', 'high', 'xhigh', 'max'],
	haiku: ['low', 'medium', 'high'], 'opus-5': ['low', 'medium', 'high', 'max'], 'sonnet-5': ['low', 'medium', 'high', 'max'], 'fable-5': ['low', 'medium', 'high', 'max'],
	'opus-4.8': ['low', 'medium', 'high', 'max'], 'opus-4.7': ['low', 'medium', 'high', 'max'], 'opus-4.6': ['low', 'medium', 'high', 'max'], 'sonnet-4.6': ['low', 'medium', 'high'],
	'haiku-4.5': [],
};
const claudeEfforts = (id) => CLAUDE_EFFORTS[id] ?? ['low', 'medium', 'high'];
let modelSheetProvider = 'claude';
let showMoreClaudeModels = false;
// One model: its name and what it is for; once chosen, the thinking levels it takes, right under it.
function modelCard({ name, desc = '', sel = false, efforts = [], effort = '', onSelect, onEffort }) {
	const card = el('div', 'model-card' + (sel ? ' sel' : ''));
	card.setAttribute('role', 'button');
	card.tabIndex = 0;
	card.innerHTML = `<div class="mc-main"><div class="mc-title"><span>${esc(name)}</span></div>${desc ? `<div class="mc-sub">${esc(desc)}</div>` : ''}</div>${ic('i-check', 'mc-check')}`;
	card.addEventListener('click', (e) => { if (!e.target.closest('.mc-efforts')) onSelect(); });
	if (sel && efforts.length > 1) {
		const row = el('div', 'mc-efforts');
		row.innerHTML = '<span class="mc-eff-label">思考</span>';
		const seg = el('div', 'seg mc-seg');
		for (const id of efforts) {
			const b = el('button', id === effort ? 'sel' : '', esc(EFFORT_LABEL[id] || id));
			b.addEventListener('click', () => onEffort(id));
			seg.appendChild(b);
		}
		row.appendChild(seg);
		card.appendChild(row);
	} else if (sel && efforts.length === 1) {
		card.querySelector('.mc-main').insertAdjacentHTML('beforeend', `<div class="mc-sub">思考：${esc(EFFORT_LABEL[efforts[0]] || efforts[0])}（固定）</div>`);
	}
	return card;
}
function signInModelCard(label, desc, provider) {
	const b = el('button', 'model-card');
	b.innerHTML = `<div class="mc-main"><div class="mc-title"><span>${esc(label)}</span></div><div class="mc-sub">${esc(desc)}</div></div>${ic('i-chev', 'chev')}`;
	b.addEventListener('click', () => { closeLayer('sheet'); showLogin(provider, true); });
	return b;
}
// A level this model takes, as close as possible to the one asked for.
function nearestEffort(levels, want) {
	if (!levels.length) return want;
	if (levels.includes(want)) return want;
	const order = ['low', 'medium', 'high', 'xhigh', 'max'];
	const at = Math.max(0, order.indexOf(want));
	return levels.reduce((best, l) => (Math.abs(order.indexOf(l) - at) < Math.abs(order.indexOf(best) - at) ? l : best), levels[0]);
}
function claudeCard(id, name, desc) {
	const sel = !isAgyModel() && (SETTINGS.model === id || SETTINGS.modelName === name);
	const efforts = claudeEfforts(id);
	return modelCard({
		name, desc, sel, efforts, effort: nearestEffort(efforts, SETTINGS.effort),
		onSelect: () => { if (!sel) pushSettings({ model: id, modelName: name, effort: nearestEffort(efforts, SETTINGS.effort) }); renderModelSheet(); },
		onEffort: (e) => { pushSettings({ effort: e }); renderModelSheet(); },
	});
}
function renderModelSheet() {
	$$('#model-provider-seg button').forEach((b) => b.classList.toggle('sel', b.dataset.provider === modelSheetProvider));
	const list = $('#model-list');
	const more = $('#more-model-list');
	const moreToggle = $('#more-models-toggle');
	list.innerHTML = '';
	more.innerHTML = '';
	const claudeTab = modelSheetProvider === 'claude';
	$('#claude-fast-card').classList.toggle('hidden', !claudeTab || !accounts.claude);
	if (claudeTab) {
		if (accounts.claude) {
			MODELS.forEach((m) => list.appendChild(claudeCard(m.id, m.name, m.desc)));
			MORE_MODELS.forEach(([id, name]) => more.appendChild(claudeCard(id, name, '')));
			if (!isAgyModel() && MORE_MODELS.some(([id]) => id === SETTINGS.model)) showMoreClaudeModels = true;
			moreToggle.classList.remove('hidden');
			more.classList.toggle('hidden', !showMoreClaudeModels);
			moreToggle.classList.toggle('expanded', showMoreClaudeModels);
		} else {
			moreToggle.classList.add('hidden');
			more.classList.add('hidden');
			list.appendChild(signInModelCard('登录 Claude 账号', '用 Claude Pro / Max 订阅使用 Opus、Sonnet 与 Haiku', 'claude'));
		}
		return;
	}
	moreToggle.classList.add('hidden');
	more.classList.add('hidden');
	if (!accounts.agy) {
		list.appendChild(signInModelCard('用 Google 账号登录 Antigravity', '登录后可以使用 Gemini 等 Google 提供的模型', 'agy'));
		return;
	}
	if (!agyState?.models?.length) {
		list.innerHTML = `<div class="empty-state">${agyState ? esc(agyState.modelsError || '没有读到模型列表') : '<span class="spin"></span>'}</div>`;
		return;
	}
	const curSlug = isAgyModel() ? String(SETTINGS.model).replace(/^agy:/, '') : '';
	for (const fam of groupAgyModels(agyState.models)) {
		const cur = fam.items.find((it) => it.slug === curSlug);
		const levels = ['low', 'medium', 'high', 'xhigh', 'max'].filter((k) => fam.variants[k]);
		list.appendChild(modelCard({
			name: fam.name, sel: !!cur, efforts: levels, effort: cur?.effort || '',
			desc: levels.length > 1 ? `${levels.length} 档思考` : '',
			onSelect: () => {
				if (cur) return;
				const chosen = pickAgyVariant(fam, SETTINGS.effort);
				pushSettings({ model: chosen.id, modelName: fam.name, effort: chosen.effort || SETTINGS.effort });
				renderModelSheet();
			},
			onEffort: (e) => {
				const v = fam.variants[e];
				if (v) pushSettings({ model: v.id, modelName: fam.name, effort: e });
				renderModelSheet();
			},
		}));
	}
}
function openModelSheet() {
	modelSheetProvider = isAgyModel() ? 'agy' : 'claude';
	showMoreClaudeModels = false;
	renderModelSheet();
	openSheet('sheet-model');
	if (accounts.agy) loadAgy().then(() => { if (openSheetId === 'sheet-model') renderModelSheet(); });
}
$$('#model-provider-seg button').forEach((b) => b.addEventListener('click', () => {
	modelSheetProvider = b.dataset.provider === 'agy' ? 'agy' : 'claude';
	renderModelSheet();
	if (modelSheetProvider === 'agy' && accounts.agy && !agyState?.models?.length) {
		loadAgy().then(() => { if (openSheetId === 'sheet-model') renderModelSheet(); });
	}
}));
$('#more-models-toggle').addEventListener('click', () => {
	showMoreClaudeModels = !showMoreClaudeModels;
	$('#more-model-list').classList.toggle('hidden', !showMoreClaudeModels);
	$('#more-models-toggle').classList.toggle('expanded', showMoreClaudeModels);
});
$('#t-fast').addEventListener('change', (e) => pushSettings({ fastMode: e.target.checked }));
$('#btn-model').addEventListener('click', openModelSheet);

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
	if (usageData.groups) {
		// The quota the model in use draws from; the other families' only on request.
		const mine = usageData.groups.find((g) => g.name === usageData.current) || usageData.groups[0];
		const others = usageData.groups.filter((g) => g !== mine);
		const block = (g) => `<div class="usage-group">${esc(g.name)}</div>${usageBar('5 小时', g.five_hour)}${usageBar('本周', g.seven_day)}`;
		let html = mine ? block(mine) : '';
		if (others.length) html += `<details class="usage-more"><summary>其他模型的额度</summary>${others.map(block).join('')}</details>`;
		body.innerHTML = html || '<div class="empty-state">暂无数据</div>';
		return;
	}
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
// For text that keeps growing. Whether the reader is following is decided before it grows: asked
// afterwards, one big piece (or a slow phone) looks like they scrolled away, and following stops.
function growing(change) {
	const follow = atBottom();
	change();
	if (follow) thread.scrollTop = thread.scrollHeight;
}
function killWelcome() { const w = $('#welcome'); if (w) w.remove(); }

function addUser(text) {
	killWelcome();
	endAssistant();
	const e = el('div', 'msg user');
	const b = el('div', 'bubble'); b.textContent = text;
	e.appendChild(b);
	thread.appendChild(e);
	scroll(true);
	return e;
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
function appendAssistant(text) { const a = ensureAssistant(); a.raw += text; growing(() => { a.el.innerHTML = md(a.raw); }); }
function setAssistant(text) { const a = ensureAssistant(); a.raw = text; growing(() => { a.el.innerHTML = md(a.raw); }); }
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
	if (t.card.classList.contains('open')) growing(() => { t.body.textContent += text; });
	else t.body.textContent += text;
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
		groupProcessBlocks({ staticMode: true });
	}
	for (const c of thread.children) c.classList.add('static'); // history appears at once, only new messages animate in
	// Opened midway: what is already written.
	if (sess?.liveThinking) addThinkDelta(sess.liveThinking);
	if (sess?.liveText) appendAssistant(sess.liveText);
	renderQueue(sess?.queue, sess?.queueHeld);
	thread.scrollTop = thread.scrollHeight;
}

function isProcessStep(node) {
	if (!node || node.nodeType !== 1) return false;
	if (node.classList.contains('think')) return !node.classList.contains('live');
	if (node.classList.contains('tool')) return !$('.tool-state .spin', node);
	if (node.classList.contains('cmd-out')) return true;
	return false;
}
function updateProcessGroupHead(grp) {
	const inner = $('.process-inner', grp);
	if (!inner) return;
	const tools = [...inner.querySelectorAll('.tool')];
	const thinks = [...inner.querySelectorAll('.think')];
	const cmdOuts = [...inner.querySelectorAll('.cmd-out')];
	const errCount = tools.filter((t) => t.classList.contains('failed')).length;
	const total = tools.length + cmdOuts.length + thinks.length;
	let title = '执行过程';
	if (tools.length && errCount) title = `执行了 ${tools.length} 步（${errCount} 步出错）`;
	else if (tools.length) title = `已完成 ${tools.length} 步操作`;
	else if (cmdOuts.length) title = `命令输出（${cmdOuts.length}）`;
	$('.process-title', grp).textContent = title;
	$('.process-count', grp).textContent = `${tools.length || total} 步`;
	grp.classList.toggle('has-err', errCount > 0);
}
function syncProcessGroups() {
	const openByDefault = !look.collapseProcess;
	$$('.process-group', thread).forEach((grp) => {
		const hasErr = grp.classList.contains('has-err');
		grp.classList.toggle('open', openByDefault || hasErr);
	});
}
function groupProcessBlocks({ staticMode = false } = {}) {
	const kids = [...thread.children];
	let i = 0;
	while (i < kids.length) {
		if (!isProcessStep(kids[i])) { i++; continue; }
		let j = i;
		while (j < kids.length && isProcessStep(kids[j])) j++;
		const run = kids.slice(i, j);
		const hasToolOrCmd = run.some((x) => x.classList.contains('tool') || x.classList.contains('cmd-out'));
		if (hasToolOrCmd || run.length >= 2) {
			const grp = el('div', 'process-group');
			if (staticMode) grp.classList.add('static');
			grp.innerHTML = `<button class="process-head" type="button">${ic('i-spark')}<span class="process-title">执行过程</span><span class="process-count"></span>${ic('i-chev', 'chev')}</button><div class="process-body"><div class="process-inner"></div></div>`;
			const inner = $('.process-inner', grp);
			thread.insertBefore(grp, run[0]);
			run.forEach((node) => inner.appendChild(node));
			updateProcessGroupHead(grp);
			const hasErr = grp.classList.contains('has-err');
			if (!look.collapseProcess || hasErr) grp.classList.add('open');
			$('.process-head', grp).addEventListener('click', () => grp.classList.toggle('open'));
		}
		i = j;
	}
}

/* ---------------- the background screen ---------------- */
// The assistant opens apps on a screen nobody sees, so the owner keeps the phone. While an app is
// open there, a row above the input shows it; tapping it shows it live, and the owner can put the
// app on their own screen or close the background one.
let bgScreen = { active: false };
let bgSheetOpen = false;
let bgFrameTimer = null;
let bgFraming = false;
const bgOn = () => !!(bgScreen.active && bgScreen.pkg);
function renderBgScreen(st) {
	bgScreen = st || { active: false };
	$('#bg-row').classList.toggle('hidden', !bgOn());
	if (bgOn()) {
		$('#bg-app').textContent = bgScreen.app || bgScreen.pkg;
		$('#bg-sheet-title').textContent = bgScreen.app || '后台屏幕';
	} else if (bgSheetOpen) closeLayer('sheet');
	bgFrames();
	if (typeof updateSettingsBadges === 'function') updateSettingsBadges();
}
async function bgFrames() {
	clearTimeout(bgFrameTimer);
	bgFrameTimer = null;
	if (!bgOn() || document.hidden || bgFraming) return;
	bgFraming = true;
	const big = bgSheetOpen;
	try {
		const r = await fetch(`/api/bgscreen/frame?w=${big ? 540 : 80}`, { cache: 'no-store' });
		if (r.ok) {
			const img = $(big ? '#bg-live' : '#bg-thumb');
			const old = img.src;
			img.src = URL.createObjectURL(await r.blob());
			if (old.startsWith('blob:')) URL.revokeObjectURL(old);
		}
	} catch { /* next time */ }
	bgFraming = false;
	if (bgOn() && !document.hidden) bgFrameTimer = setTimeout(bgFrames, bgSheetOpen ? 800 : 3000);
}
$('#bg-row').addEventListener('click', () => {
	const s = $('#sheet-bgscreen'), scrim = $('#sheet-scrim');
	show(scrim); show(s);
	bgSheetOpen = true;
	openLayer('sheet', () => { hide(s); hide(scrim); bgSheetOpen = false; });
	bgFrames();
});
$('#bg-show').addEventListener('click', async () => {
	const r = await api('/api/bgscreen/show', {});
	if (!r.ok) { toast(r.error || '没能放到前台'); return; }
	closeLayer('sheet');
});
$('#bg-stop').addEventListener('click', async () => {
	await api('/api/bgscreen/stop', {});
	closeLayer('sheet');
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) bgFrames(); });

/* ---------------- messages waiting for the turn in progress ---------------- */
function renderQueue(list = [], held = false) {
	const box = $('#queue-box');
	box.innerHTML = '';
	box.classList.toggle('hidden', !list.length);
	for (const item of list) {
		const row = el('div', 'queue-row', `<div class="queue-text"><span class="queue-tag">${held ? '已暂停，等你发送' : '排队中'}</span><span class="queue-msg"></span></div><div class="queue-acts"><button class="pill-btn accent queue-now">立即发送</button><button class="pill-btn queue-undo">撤回</button></div>`);
		$('.queue-msg', row).textContent = typedText(item.text);
		$('.queue-now', row).addEventListener('click', async (e) => {
			e.currentTarget.disabled = true;
			if (running && curSession) stoppedIds.add(curSession.id); // the turn it ends was ended on purpose
			const r = await api('/api/queue/send-now', { sessionId: curSession?.id, id: item.id });
			if (!r.ok) toast(r.error || '发送失败');
		});
		$('.queue-undo', row).addEventListener('click', async () => {
			const r = await api('/api/queue/remove', { sessionId: curSession?.id, id: item.id });
			if (!r.ok) { toast(r.error || '撤回失败'); return; }
			if (input.value.trim()) { toast('已撤回'); return; } // never over what is being typed
			input.value = typedText(r.text);
			attachedScopes = r.scopes || [];
			renderScopes();
			autosize();
			updateSendState();
			input.focus();
		});
		box.appendChild(row);
	}
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
	if (document.hidden) return; // drawn again when the page comes back
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
const SCOPE_ICON = { app: 'i-app', folder: 'i-folder', file: 'i-file', image: 'i-image', github: 'i-github' };
function addScope(scope) {
	if (!attachedScopes.some((s) => s.type === scope.type && s.path === scope.path && s.package === scope.package && s.repo === scope.repo && s.branch === scope.branch)) {
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
		const text = s.type === 'app' ? (s.name || s.package)
			: s.type === 'file' ? (s.name || s.path.split('/').pop())
			: s.type === 'image' ? (s.name || '图片')
			: s.type === 'github' ? `${s.repo}${s.branch ? '@' + s.branch : ''}`
			: s.path;
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
			app: `- 手机应用: ${s.name} (${s.package})`,
			folder: `- 目标文件夹: ${s.path}`,
			file: `- 目标文件: ${s.path}`,
			image: `- 附件图片: ${s.path}`,
			github: `- GitHub 项目: ${s.repo}${s.branch ? ` (分支: ${s.branch})` : ''}${s.path ? ` (路径: ${s.path})` : ''} — ${s.url || `https://github.com/${s.repo}`}（可通过 GitHub MCP 工具或 git/gh CLI 操作该仓库）`,
		}[s.type] || '')).filter(Boolean).join('\n');
		fullPrompt = `【指定操作范围与上下文】\n${lines}\n\n【用户指令】\n${rawText || '请根据上述指定的上下文进行分析或处理。'}`;
	}
	// A turn in progress: the server puts it in line and the queue above the input shows it; it joins
	// the thread when it goes out. The server decides, so the two guesses below get put right.
	const shown = rawText || fullPrompt;
	let bubble = running ? null : addUser(shown);
	input.value = '';
	autosize();
	hideSlash();
	const sid = curSession?.id;
	const scopes = attachedScopes.map(({ dataUrl, ...s }) => s); // the picture is already on the phone
	attachedScopes = [];
	renderScopes();
	const wasRunning = running;
	runningIds.add(sid);
	setRunning(true);
	if (!activity.on) setActivity('正在思考');
	const r = await api('/api/send', { text: fullPrompt, scopes, sessionId: sid });
	if (!r.ok) {
		if (!wasRunning) { runningIds.delete(sid); if (curSession?.id === sid) setRunning(false); }
		sysline('发送失败：' + (r.error || '连不上助手服务'));
	} else if (r.queued && bubble) {
		bubble.remove(); bubble = null;
	} else if (!r.queued && !bubble && curSession?.id === sid) {
		bubble = addUser(shown);
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
	{ name: 'memory', desc: '查看和编辑助手的经验笔记', run: () => openPage('page-memory') },
	{ name: 'config', aliases: ['settings'], desc: '打开设置', run: () => openPage('page-settings') },
	{ name: 'theme', desc: '更换主题', run: () => openPage('page-theme') },
	{ name: 'release-notes', aliases: ['version', 'changelog'], desc: '版本与更新记录', run: () => openPage('page-version') },
	{ name: 'login', desc: '登录或切换账号（Claude 或 Antigravity）', run: () => showLogin(isAgyModel() ? 'agy' : 'claude', true) },
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
	// The app's own commands happen here and now. Anything going to Claude waits in the input box:
	// a skill usually needs a sentence saying what to do with it, and sending is the owner's call.
	if (app && !app.hint) { clearInput(); app.run(''); return; }
	input.value = `/${name} `;
	autosize();
	updateSendState();
	input.focus();
}
// A tap on the menu keeps the input focused, or the keyboard would drop and come back.
$('#slash-menu').addEventListener('mousedown', (e) => e.preventDefault());
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
	else if (act === 'app') openAppsSheet();
	else if (act === 'files') openFsSheet();
	else if (act === 'github') openGithubSheet();
}));
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
		const fresh = !a.system && a.installed && Date.now() - a.installed < 7 * 24 * 3600 * 1000;
		row.innerHTML = `<div class="pick-ic">${esc((a.name || a.package || '?').trim()[0] || '?')}</div><div class="pick-main"><div class="pick-name">${esc(a.name)}</div><div class="pick-sub">${fresh ? '新安装 · ' : ''}${esc(a.package)}</div></div>`;
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
// One place for both: tap a file to pick it, tap a folder to go in, and the button uses the folder
// you are in. A path pasted into the search box goes straight there.
let curFsPath = '/sdcard';
let parentFsPath = '/';
let fsSeq = 0;
const FS_ICON = { 图片: 'i-image', APK: 'i-box', 文本: 'i-doc', 代码: 'i-terminal' };
function openFsSheet() {
	$('#fs-search').value = '';
	openSheet('sheet-fs');
	loadFsPath('/sdcard');
}
async function loadFsPath(p, q) {
	const list = $('#fs-list');
	list.innerHTML = '<div class="empty-state"><span class="spin"></span></div>';
	let u = `/api/fs?path=${encodeURIComponent(p)}`;
	if (q) u += `&q=${encodeURIComponent(q)}`;
	const seq = ++fsSeq;
	const r = await getJSON(u);
	if (seq !== fsSeq) return; // typed on meanwhile
	if (!r.ok) { list.innerHTML = `<div class="empty-state">打不开这个文件夹：${esc(r.error || '')}</div>`; return; }
	if (!q) { curFsPath = r.currentPath; parentFsPath = r.parentPath; $('#fs-path').textContent = curFsPath; }
	const items = r.items || [];
	list.innerHTML = '';
	if (!items.length) { list.innerHTML = `<div class="empty-state">${q || r.filtered ? '没有匹配的文件' : '这个文件夹是空的'}</div>`; return; }
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
	fsSearchTimer = setTimeout(() => (q.startsWith('/') ? loadFsPath(q) : loadFsPath(curFsPath, q || undefined)), 350);
});

/* ---------------- github project picker & MCP ---------------- */
let ghStatusData = null;
let ghReposCache = [];
let ghReposError = '';
let ghSearchTimer = null;
let ghSearchSeq = 0;
let ghTokenOpen = false;
function renderGithubStatus(st) {
	ghStatusData = st || { configured: false, enabled: false, recent: [] };
	const badge = $('#gh-mcp-badge');
	const on = !!(ghStatusData.configured && ghStatusData.enabled);
	const offDisabled = !!(ghStatusData.configured && !ghStatusData.enabled);
	badge.className = 'badge' + (on ? ' connected' : offDisabled ? ' needs-auth' : '');
	badge.textContent = on ? 'MCP 已连接' : offDisabled ? '已禁用' : '未连接';
	$('#gh-status-title').textContent = ghStatusData.login ? `GitHub · @${ghStatusData.login}` : 'GitHub MCP';
	$('#gh-status-sub').textContent = ghStatusData.configured
		? `令牌 ${ghStatusData.token || ''} 已配置，助手可通过 GitHub MCP 与 git/gh 直接读写仓库、分支、Issue 与 PR`
		: '绑定个人访问令牌后，助手可通过 MCP 直接读写仓库代码、分支、Issue 与 PR';
	$('#gh-token-toggle').textContent = ghTokenOpen ? '收起' : (ghStatusData.configured ? '更换' : '配置');
	$('#gh-token-disconnect').classList.toggle('hidden', !ghStatusData.configured);
	$('#gh-token-box').classList.toggle('hidden', !ghTokenOpen);
}
function makeGithubRepoRow(item, { removable = false } = {}) {
	const row = el('div', 'pick-row');
	const tags = [];
	if (item.private) tags.push('<span class="gh-tag">私有</span>');
	if (item.branch) tags.push(`<span class="gh-tag">${ic('i-branch', 'sm')} ${esc(item.branch)}</span>`);
	if (item.language) tags.push(`<span class="gh-tag">${esc(item.language)}</span>`);
	const descHtml = item.description ? `<span>${esc(item.description)}</span>` : '';
	row.innerHTML = `<div class="pick-ic">${ic('i-github')}</div><div class="pick-main"><div class="pick-name">${esc(item.repo)}</div><div class="gh-meta">${tags.join('')}${descHtml}</div></div>${removable ? `<button class="gh-del" type="button" aria-label="移除记录">${ic('i-x')}</button>` : ic('i-chev', 'chev')}`;
	if (removable) {
		$('.gh-del', row).addEventListener('click', async (e) => {
			e.stopPropagation();
			const r = await api('/api/github/forget', { repo: item.repo });
			if (r.ok) {
				renderGithubStatus(r);
				renderGithubList({ query: $('#gh-repo-input').value.trim() });
			}
		});
	}
	row.addEventListener('click', () => attachGithubRepo(item));
	return row;
}
function renderGithubList({ loading = false, query = '' } = {}) {
	const list = $('#gh-list');
	list.innerHTML = '';
	const q = query.trim().toLowerCase();
	const recentAll = ghStatusData?.recent || [];
	const recent = q ? recentAll.filter((x) => x.repo.toLowerCase().includes(q) || (x.description || '').toLowerCase().includes(q)) : recentAll;
	const recentSet = new Set(recent.map((x) => x.repo));
	const repos = ghReposCache.filter((x) => !recentSet.has(x.repo) && (!q || x.repo.toLowerCase().includes(q) || (x.description || '').toLowerCase().includes(q)));

	const frag = document.createDocumentFragment();
	if (recent.length) {
		frag.appendChild(el('div', 'gh-sec-h', '最近关联'));
		recent.forEach((item) => frag.appendChild(makeGithubRepoRow(item, { removable: true })));
	}
	if (ghStatusData?.configured) {
		frag.appendChild(el('div', 'gh-sec-h', q ? '搜索到的仓库' : '我的仓库'));
		if (loading) {
			const sp = el('div', 'empty-state', '<span class="spin"></span>');
			frag.appendChild(sp);
		} else if (ghReposError) {
			frag.appendChild(el('div', 'empty-state', esc(ghReposError)));
		} else if (repos.length) {
			repos.forEach((item) => frag.appendChild(makeGithubRepoRow(item)));
		} else if (!recent.length) {
			frag.appendChild(el('div', 'empty-state', q ? '没有匹配的仓库，可直接点右侧「关联」' : '暂无仓库，可在上方输入 owner/repo'));
		}
	} else if (!recent.length) {
		frag.appendChild(el('div', 'empty-state', '在上方输入 owner/repo 或 GitHub 仓库链接直接关联；绑定 Token 后可浏览全部私有/公开仓库并启用 GitHub MCP'));
	}
	list.appendChild(frag);
}
async function loadGithubRepos(q = '') {
	if (!ghStatusData?.configured) {
		ghReposCache = [];
		ghReposError = '';
		renderGithubList({ query: q });
		return;
	}
	const seq = ++ghSearchSeq;
	if (!ghReposCache.length || q) renderGithubList({ loading: true, query: q });
	const r = await getJSON('/api/github/repos' + (q ? `?q=${encodeURIComponent(q)}` : ''));
	if (seq !== ghSearchSeq) return;
	if (r.ok) {
		ghReposCache = r.repos || [];
		ghReposError = '';
	} else {
		ghReposCache = [];
		ghReposError = r.error || '读取仓库失败';
	}
	renderGithubList({ query: q });
}
async function refreshGithubSheet() {
	$('#gh-list').innerHTML = '<div class="empty-state"><span class="spin"></span></div>';
	const st = await getJSON('/api/github/status');
	if (st.ok) renderGithubStatus(st);
	else renderGithubStatus(null);
	await loadGithubRepos($('#gh-repo-input').value.trim());
}
function openGithubSheet() {
	$('#gh-repo-input').value = '';
	$('#gh-token-input').value = '';
	ghTokenOpen = false;
	ghReposError = '';
	openSheet('sheet-github');
	refreshGithubSheet();
}
async function attachGithubRepo(target) {
	const raw = typeof target === 'string' ? target.trim() : target?.repo;
	if (!raw) { $('#gh-repo-input').focus(); return; }
	const meta = typeof target === 'object' && target ? target : {};
	const r = await api('/api/github/link', {
		repo: raw,
		description: meta.description || '',
		private: !!meta.private,
	});
	if (!r.ok) { toast(r.error || '请输入有效的 owner/repo 或 GitHub 链接'); return; }
	addScope({
		type: 'github',
		repo: r.repo,
		url: r.url || meta.url || `https://github.com/${r.repo}`,
		branch: r.branch || meta.branch || '',
		path: r.path || '',
	});
	closeLayer('sheet');
	toast(r.mcp ? `已关联 ${r.repo}（GitHub MCP 已就绪）` : `已关联 ${r.repo}`);
	if (!$('#page-settings').classList.contains('hidden')) refreshExtraSettingsStatus();
}
$('#gh-token-toggle').addEventListener('click', () => {
	ghTokenOpen = !ghTokenOpen;
	renderGithubStatus(ghStatusData);
	if (ghTokenOpen) setTimeout(() => $('#gh-token-input').focus(), 80);
});
async function submitGithubToken() {
	const token = $('#gh-token-input').value.trim();
	if (!token) { $('#gh-token-input').focus(); toast('请先粘贴 GitHub Token'); return; }
	const btn = $('#gh-token-save');
	btn.disabled = true;
	btn.innerHTML = '<span class="spin sm"></span>连接中';
	const r = await api('/api/github/connect', { token });
	btn.disabled = false;
	btn.textContent = '连接';
	if (!r.ok) { toast(r.error || '连接失败'); return; }
	$('#gh-token-input').value = '';
	ghTokenOpen = false;
	renderGithubStatus(r);
	toast(`已连接 @${r.login || 'GitHub'}（MCP 已启用）`);
	loadGithubRepos($('#gh-repo-input').value.trim());
	refreshExtraSettingsStatus();
}
$('#gh-token-save').addEventListener('click', submitGithubToken);
$('#gh-token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitGithubToken(); } });
$('#gh-token-disconnect').addEventListener('click', () => {
	showDialog({
		title: '断开 GitHub 连接？',
		msg: '这会移除已保存的 GitHub Token 并停用 GitHub MCP 连接器。',
		ok: '断开',
		danger: true,
		onOk: async () => {
			const r = await api('/api/github/disconnect');
			ghReposCache = [];
			ghReposError = '';
			ghTokenOpen = false;
			if (r.ok) renderGithubStatus(r);
			renderGithubList({ query: $('#gh-repo-input').value.trim() });
			refreshExtraSettingsStatus();
			toast('已断开 GitHub 连接');
		},
	});
});
$('#gh-repo-attach').addEventListener('click', () => attachGithubRepo($('#gh-repo-input').value));
$('#gh-repo-input').addEventListener('keydown', (e) => {
	if (e.key === 'Enter') { e.preventDefault(); attachGithubRepo($('#gh-repo-input').value); }
});
$('#gh-repo-input').addEventListener('input', (e) => {
	clearTimeout(ghSearchTimer);
	const q = e.target.value.trim();
	if (/^https?:\/\//i.test(q) || /^[\w.-]+\/[\w.-]+/.test(q)) {
		renderGithubList({ query: q });
		return;
	}
	ghSearchTimer = setTimeout(() => loadGithubRepos(q), 350);
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
async function refreshAccount() {
	const r = await getJSON('/api/account');
	account = r.ok && r.account ? r.account : null;
	const email = account?.email || '';
	const initial = email ? email.trim()[0].toUpperCase() : accounts.agy ? 'G' : '·';
	const plan = account ? (SUBSCRIPTION_LABEL[account.subscriptionType] ? `Claude ${SUBSCRIPTION_LABEL[account.subscriptionType]}` : (account.orgName || '已登录')) : '';
	// With only Antigravity signed in, the drawer says so rather than "not signed in".
	const who = email || (accounts.agy ? 'Antigravity' : '');
	$('#drawer-avatar').textContent = initial;
	$('#drawer-avatar').classList.toggle('out', !who);
	$('#drawer-email').textContent = who || '未登录';
	$('#drawer-plan').textContent = email ? plan : accounts.agy ? '已用 Google 账号登录' : '点此登录';
	// Settings: each engine's card says only what is true of that engine.
	if ($('#set-avatar-badge')) $('#set-avatar-badge').innerHTML = email ? esc(email.trim()[0].toUpperCase()) : ic('i-key');
	$('#set-email').textContent = email || '未登录';
	$('#set-plan').textContent = email ? plan : '登录 Claude 账号';
	renderAgyCard();
	updateSettingsBadges();
}
async function loadAgy(fresh) {
	const r = await getJSON('/api/agy/status' + (fresh ? '?fresh=1' : ''));
	if (r.ok) agyState = r;
	renderAgyCard();
	return agyState;
}
// The Antigravity card in Settings: its account above, its program below, like Claude's.
function renderAgyCard() {
	if (!$('#set-agy-who')) return;
	const st = agyState;
	$('#set-agy-who').textContent = accounts.agy ? 'Google 账号' : '未登录';
	$('#set-agy-plan').textContent = accounts.agy ? (st?.models?.length ? `已登录 · ${st.models.length} 个模型可用` : '已登录') : '用 Google 账号登录';
	$('#set-agy-badge').innerHTML = accounts.agy ? 'G' : ic('i-spark');
	const dot = $('#agy-engine-dot');
	const line = $('#agy-engine-line');
	if (!st) { dot.className = 'engine-dot off'; line.textContent = 'agy · 正在检测'; return; }
	if (!st.installed) { dot.className = 'engine-dot off'; line.textContent = st.installing ? 'agy · 正在安装' : 'agy · 未安装，登录时自动下载'; return; }
	dot.className = 'engine-dot ' + (st.version ? 'ok' : 'err');
	line.textContent = st.version ? `本机引擎 · ${st.version} (agy)` : 'agy · 已安装，但启动不了';
}
$('#set-agy-account').addEventListener('click', () => { if (accounts.agy) openPage('page-agy'); else { closeAll(); showLogin('agy', true); } });
$('#set-agy-engine').addEventListener('click', () => openPage('page-agy'));

/* ---------------- Antigravity: the CLI, its account, its plugins ---------------- */
let agyInstallLine = '';
function renderAgyPage() {
	const body = $('#agy-body');
	const st = agyState;
	if (!st) { body.innerHTML = '<div class="empty-state"><span class="spin"></span></div>'; return; }
	const busy = st.installing || (agyInstallLine && !agyInstallLine.done);
	let html = `<p class="hint">Antigravity 是 Google 的编程助手。这里运行的是它官方的命令行程序（agy）：用 Google 账号登录后，就能在模型菜单里选它的模型（Gemini 等，取决于你的 Google AI 套餐）。</p>
		<div class="list kv">${kv('命令行程序', st.installed ? `已安装 ${st.version || ''}` : '还没有安装')}${kv('账号', st.loggedIn ? '已登录' : '未登录')}${st.loggedIn ? kv('可用模型', st.modelsError ? st.modelsError : `${st.models.length} 个`) : ''}</div>`;
	if (agyInstallLine) html += `<p class="login-msg ${agyInstallLine.done ? (agyInstallLine.ok ? 'ok' : 'err') : 'wait'}">${esc(agyInstallLine.text)}</p>`;
	html += '<div class="agy-acts">';
	html += `<button class="pill-btn accent" id="agy-login">${st.loggedIn ? '换一个账号登录' : st.installed ? '登录' : '安装并登录'}</button>`;
	if (st.installed) html += `<button class="pill-btn" id="agy-update" ${busy ? 'disabled' : ''}>检查更新</button>`;
	if (st.loggedIn) html += '<button class="pill-btn danger" id="agy-logout">退出登录</button>';
	html += '</div>';
	if (st.installed && st.loggedIn) {
		html += `<div class="list"><button class="row" id="agy-to-market"><span class="badge-ic ic-orange"><svg class="ic"><use href="#i-puzzle"/></svg></span><span class="row-text">插件、技能和连接器<small>和 Claude 共用，在「扩展与插件」里管理</small></span><svg class="ic chev"><use href="#i-chev"/></svg></button></div>`;
	}
	html += `<h2 class="group-label">它和 Claude 的不同</h2><p class="hint">Antigravity 的对话由 agy 自己完成，和 Claude Code 是两套程序：同一段对话换了模型所属的账号，接手的一方看不到另一方做过的事。执行命令、写文件、技能、连接器、插件里的技能和连接器、经验笔记两边都有；/compact 这类 Claude Code 自己的命令只在 Claude 的对话里。</p>`;
	body.innerHTML = html;
	$('#agy-login').addEventListener('click', () => showLogin('agy', true));
	$('#agy-update')?.addEventListener('click', () => { agyInstallLine = { text: '正在检查…' }; renderAgyPage(); api('/api/agy/install', {}); });
	$('#agy-logout')?.addEventListener('click', () => showDialog({
		title: '退出 Antigravity？', msg: '退出后它的模型不能再用，直到重新登录。Claude 账号不受影响。', ok: '退出登录', danger: true,
		onOk: async () => { await api('/api/agy/logout'); await loadAgy(); renderAgyPage(); },
	}));
	$('#agy-to-market')?.addEventListener('click', () => openMarket('plugins', 'installed'));
}
PAGE_OPEN['page-agy'] = async () => { renderAgyPage(); await loadAgy(true); renderAgyPage(); };
$('#set-account').addEventListener('click', () => {
	if (!account) { closeAll(); showLogin('claude', true); return; }
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

async function refreshExtraSettingsStatus() {
	const [px, gh, rt, sp, mem] = await Promise.all([
		getJSON('/api/proxy'),
		getJSON('/api/github/status'),
		getJSON('/api/runtime'),
		getJSON('/api/systemprompt'),
		getJSON('/api/memory'),
	]);
	if (px.ok && $('#val-net')) $('#val-net').textContent = px.proxy ? `代理 ${px.proxy}` : '直连';
	if (gh.ok && $('#val-github')) {
		$('#val-github').textContent = gh.configured
			? (gh.enabled ? (gh.login ? `@${gh.login}` : 'MCP 已连') : '已禁用')
			: '未连接';
	}
	if ($('#engine-dot') && $('#engine-line')) {
		$('#engine-dot').className = 'engine-dot ' + (rt.ok ? 'ok' : 'err');
		$('#engine-line').textContent = rt.ok
			? `本机引擎 · ${rt.chat?.version || '运行中'}`
			: '本机引擎 · 未检测到 Claude Code';
	}
	const promptSet = !!(sp.ok && sp.text && sp.text.trim());
	const memCount = mem.ok ? noteCount(mem.text) : 0;
	if ($('#val-prompt')) $('#val-prompt').textContent = promptSet ? '已设置' : '未设置';
	if ($('#val-memory')) $('#val-memory').textContent = memCount ? `${memCount} 条` : '';
	if ($('#val-persona')) {
		$('#val-persona').textContent = promptSet && memCount
			? `提示词 · ${memCount} 条笔记`
			: promptSet ? '已设提示词'
			: memCount ? `${memCount} 条笔记`
			: '未设置';
	}
}
function filterSettings(raw) {
	const q = String(raw || '').trim().toLowerCase();
	let visible = 0;
	const top = $('#set-top-card');
	if (top) {
		const topMatch = !q || top.textContent.toLowerCase().includes(q) || '账号 引擎 本机 claude antigravity'.includes(q);
		top.classList.toggle('hidden', !topMatch);
		if (topMatch) visible++;
	}
	$$('#page-settings .set-group:not(.engines)').forEach((grp) => {
		let hits = 0;
		grp.querySelectorAll('.row, .row-col').forEach((row) => {
			const hay = `${row.dataset.search || ''} ${row.textContent || ''}`.toLowerCase();
			const match = !q || hay.includes(q);
			row.classList.toggle('hidden', !match);
			if (match) hits++;
		});
		grp.classList.toggle('hidden', !hits);
		visible += hits;
	});
	$('#settings-empty').classList.toggle('hidden', visible > 0);
}
$('#settings-search').addEventListener('input', (e) => filterSettings(e.target.value));
$('#set-model-row').addEventListener('click', openModelSheet);
$('#set-mode-row').addEventListener('click', (e) => { renderModeMenu(); openMenu('menu-mode', e.currentTarget); });
$('#set-phone-row').addEventListener('click', () => {
	if (bgOn()) { $('#bg-row').click(); return; }
	showDialog({
		title: '手机操控已开启',
		msg: '助手会在后台虚拟屏幕中操作手机应用，不占用你当前的屏幕。后台任务运行期间，点击输入栏上方或这里的入口即可实时查看与接管画面。',
		cancel: '',
		ok: '知道了',
	});
});
$('#set-net-row').addEventListener('click', async () => {
	const px = await getJSON('/api/proxy');
	showDialog({
		title: '网络代理',
		msg: '留空表示直连；如果手机上开着代理软件，可填写本地 HTTP 代理地址。',
		input: true,
		value: px.ok ? (px.proxy || '') : '',
		placeholder: 'http://127.0.0.1:7890',
		ok: '保存并测试',
		onOk: async (v) => {
			const r = await api('/api/proxy', { proxy: String(v || '').trim() });
			if (!r.ok) { toast(r.error || '保存失败'); return; }
			refreshExtraSettingsStatus();
			const where = r.proxy ? `代理 ${r.proxy}` : '直连';
			toast(r.reachable ? `已保存，${where}可正常连接` : `已保存，但${where}暂时连不上（${r.summary || ''}）`);
		},
	});
});
$('#set-github-row').addEventListener('click', openGithubSheet);
$('#set-engine').addEventListener('click', async () => {
	const rt = await getJSON('/api/runtime');
	if (rt.ok && rt.chat) {
		showDialog({
			title: '本机引擎运行中',
			msg: `引擎：${rt.chat.label}（${rt.chat.version}）\n工作目录：${rt.cwd || '—'}\nNode.js：${rt.node || '—'}`,
			cancel: '',
			ok: '知道了',
		});
	} else {
		const tried = (rt.tried || []).map((t) => `${t.ok ? '✓' : '✗'} ${t.label}：${t.detail}`).join('\n');
		showDialog({
			title: '未检测到 Claude Code',
			msg: tried || '请检查 Claude Code 运行环境或使用 /doctor 命令排查。',
			cancel: '',
			ok: '知道了',
		});
	}
});

PAGE_OPEN['page-settings'] = async () => {
	$('#settings-search').value = '';
	filterSettings('');
	updateLookValues();
	refreshAccount();
	loadUpdate();
	refreshExtraSettingsStatus();
	loadAgy();
};
PAGE_OPEN['page-persona'] = () => refreshExtraSettingsStatus();
$('#t-autoupdate').addEventListener('change', (e) => pushSettings({ autoUpdate: e.target.checked }));

/* ---------------- the assistant's notes ---------------- */
const noteCount = (t) => String(t || '').split('\n').filter((l) => /^\s*[-*]\s+\S/.test(l)).length;
async function refreshMemoryRow() {
	const r = await getJSON('/api/memory');
	const n = r.ok ? noteCount(r.text) : 0;
	$('#val-memory').textContent = n ? `${n} 条` : '';
	refreshExtraSettingsStatus();
}
PAGE_OPEN['page-memory'] = async () => {
	$('#memory-text').value = '';
	const r = await getJSON('/api/memory');
	$('#memory-text').value = r.ok ? (r.text || '') : '';
};
$('#memory-save').addEventListener('click', async () => {
	const text = $('#memory-text').value;
	const r = await api('/api/memory', { text });
	if (r.ok === false) { toast('保存失败'); return; }
	refreshMemoryRow();
	closePage('page-memory');
	toast('已保存，从新对话开始生效');
});

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
	refreshExtraSettingsStatus();
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
// One sign-in card for the two accounts. `loginProvider` is the one being signed in to.
let loginProvider = 'claude';
const LOGIN_WHO = {
	claude: { title: '登录 Claude 账号', lede: '使用你的 Claude 订阅（Pro 或 Max），不需要 API Key。', cli: 'claude', server: 'Claude' },
	agy: { title: '登录 Antigravity', lede: '用 Google 账号登录 Google 的 Antigravity，使用它提供的模型（Gemini 等）。第一次会先下载它的命令行程序，约 100 MB。', cli: 'agy', server: 'Google' },
};
function setLoginProvider(p) {
	loginProvider = p === 'agy' ? 'agy' : 'claude';
	$$('#login-provider button').forEach((b) => b.classList.toggle('sel', b.dataset.provider === loginProvider));
	$('#login-title').textContent = LOGIN_WHO[loginProvider].title;
	$('#login-lede').textContent = LOGIN_WHO[loginProvider].lede;
}
// `closable`: opened by choice while the other account already works, so it can be put away.
function showLogin(provider, closable) {
	closeAll();
	api('/api/login/cancel');
	backToStart('开始登录');
	setLoginMsg('', '');
	setLoginProvider(provider || (accounts.claude && !accounts.agy ? 'agy' : 'claude'));
	$('#login-close').classList.toggle('hidden', !(closable || loggedIn));
	$('#login').classList.remove('hidden');
	loadProxy();
}
function hideLogin() { $('#login').classList.add('hidden'); }
function setLoginMsg(kind, text) { const m = $('#login-msg'); m.className = 'login-msg' + (kind ? ' ' + kind : ''); m.textContent = text || ''; }
function showNetBox() { $('#login-net').classList.remove('hidden'); }
function loginWaiting(on) { $('#login-start').classList.toggle('hidden', on); $('#login-wait').classList.toggle('hidden', !on); }
let verifyTimer = null, verifyStart = 0, verifyLine = '';
function verifyText() {
	const secs = Math.round((Date.now() - verifyStart) / 1000);
	const who = LOGIN_WHO[loginProvider];
	let t = `正在验证授权码（${secs} 秒）`;
	if (verifyLine) t += `\n${who.cli}：${verifyLine}`;
	if (secs >= 20) t += `\n超过 20 秒还没结果，多半是连不上 ${who.server}。可以点「取消，重新开始」，填好代理端口后再登录。`;
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
$('#login-close').addEventListener('click', () => { api('/api/login/cancel'); hideLogin(); });
$$('#login-provider button').forEach((b) => b.addEventListener('click', () => {
	if (b.dataset.provider === loginProvider) return;
	api('/api/login/cancel');
	backToStart('开始登录');
	setLoginMsg('', '');
	setLoginProvider(b.dataset.provider);
}));
function loginStatus(m) {
	if (m.provider && m.provider !== loginProvider) return; // left over from the other account's attempt
	if (m.proxy) $('#login-proxy').value = m.proxy;
	if (m.kind === 'cli') { verifyLine = m.text; setLoginMsg('wait', verifyTimer ? verifyText() : `${LOGIN_WHO[loginProvider].cli}：${m.text}`); return; }
	if (m.kind === 'warn') showNetBox();
	setLoginMsg(m.kind === 'warn' ? 'err' : m.kind === 'ok' ? 'ok' : 'wait', m.text);
}
$('#login-start').addEventListener('click', () => { setLoginMsg('', ''); loginWaiting(true); api('/api/login/start', { provider: loginProvider }); });
// 'auto': after "Authorize" the browser goes straight back to the CLI on this phone
// (http://localhost:…) and the login finishes by itself; pasting is only a fallback.
const LOGIN_TEXT = {
	claude: {
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
	},
	agy: {
		auto: {
			step1: '用你的 Google 账号登录并同意授权。授权后浏览器会跳回本机，登录自动完成，回到这里就行。',
			title: '没有自动完成？',
			step2: '如果浏览器最后停在一个打不开的 localhost 页面，复制它地址栏里的完整网址，粘贴到这里。',
			placeholder: '粘贴 http://localhost:… 网址', submit: '提交',
			waiting: '等你在浏览器里完成 Google 授权，授权后这里会自动完成。',
		},
		manual: {
			step1: '用你的 Google 账号登录并同意授权。',
			title: '粘贴授权码',
			step2: '授权后页面会显示一串授权码，复制后粘贴到这里。',
			placeholder: '粘贴授权码', submit: '完成登录', waiting: '',
		},
	},
};
function loginUrl(url, mode, provider) {
	if (provider && provider !== loginProvider) return;
	const t = LOGIN_TEXT[loginProvider][mode] || LOGIN_TEXT[loginProvider].manual;
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
function loginDone(ok, message, provider) {
	if (provider && provider !== loginProvider) return;
	stopVerify();
	loginWaiting(false);
	$('#login-submit').disabled = false;
	if (ok) {
		setLoginMsg('ok', '登录成功');
		setTimeout(hideLogin, 700);
		refreshAccount(); loadUsage(true);
		loadAgy(true).then(() => { if (!$('#page-agy').classList.contains('hidden')) renderAgyPage(); });
		return;
	}
	backToStart();
	setLoginMsg('err', '登录失败：' + (message || '请重试'));
	if (/连接|连不上|网络|代理|回应|ETIMEDOUT|ECONN|ENOTFOUND|fetch failed/i.test(message || '')) showNetBox();
}
async function loadProxy() {
	const r = await getJSON('/api/proxy');
	if (r.ok) $('#login-proxy').value = r.proxy || '';
}
$('#login-proxy-save').addEventListener('click', async () => {
	const who = LOGIN_WHO[loginProvider].server;
	setLoginMsg('wait', `正在保存并测试能否连上 ${who}`);
	const r = await api('/api/proxy', { proxy: $('#login-proxy').value.trim(), provider: loginProvider });
	if (!r.ok) return setLoginMsg('err', r.error || '保存失败');
	const where = r.proxy ? `代理 ${r.proxy}` : '直连';
	if (r.reachable) setLoginMsg('ok', `已保存，${where}能连上 ${who}，现在可以登录了。`);
	else setLoginMsg('err', `已保存，但${where}连不上 ${who}（${r.summary}）。请检查端口是否正确、代理软件是否在运行。`);
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
				getJSON('/api/bgscreen').then((r) => renderBgScreen(r.ok ? r : null));
				if (m.activeSession) { curSession = m.activeSession; renderTranscript(curSession); }
				showUpdateNotice(m.lastUpdate); // after the redraw, which would wipe it
				fetchSessions();
				loadSlashCommands();
				break;
			case 'auth':
				loggedIn = !!m.loggedIn;
				accounts = { claude: !!m.accounts?.claude, agy: !!m.accounts?.agy };
				// Signed in to neither: the card comes up. Signed in to one: it is only up if the owner opened it.
				if (!m.loggedIn) { if ($('#login').classList.contains('hidden')) showLogin(); } else { if ($('#login-step2').classList.contains('hidden') && $('#login-wait').classList.contains('hidden')) hideLogin(); loadUsage(); }
				refreshAccount();
				if (accounts.agy) loadAgy();
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
				if (mine && m.fromQueue) addUser(typedText(m.text)); // its turn came: it joins the thread now
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
					groupProcessBlocks();
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
			case 'bgscreen': renderBgScreen(m); break;
			case 'queue': if (mine) renderQueue(m.queue, m.held); break;
			case 'skills_updated': loadSlashCommands(); break;
			case 'mcp_updated':
				if (!$('#sheet-github').classList.contains('hidden')) refreshGithubSheet();
				if (!$('#page-settings').classList.contains('hidden')) refreshExtraSettingsStatus();
				break;
			case 'plugins_updated': case 'plugin_job': case 'skill_draft': case 'mcp_login_url': case 'mcp_login_done':
				marketEvent(m);
				break;
			case 'error':
				if (m.sessionId) runningIds.delete(m.sessionId);
				if (mine) { endAssistant(); groupProcessBlocks(); setRunning(false); sysline('出错了：' + m.message); } else renderSidebar();
				break;
			case 'login_url': loginUrl(m.url, m.mode, m.provider); break;
			case 'login_status': loginStatus(m); break;
			case 'login_done': loginDone(m.ok, m.message, m.provider); break;
			case 'agy_install':
				agyInstallLine = m;
				if (!$('#page-agy').classList.contains('hidden')) renderAgyPage();
				break;
			case 'agy_updated':
				loadAgy(true).then(() => { if (!$('#page-agy').classList.contains('hidden')) renderAgyPage(); });
				break;
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
