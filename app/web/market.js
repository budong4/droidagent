/* The extension market: the one place for skills, connectors and plugins, split into what is
   installed and what can be added. Runs after app.js and shares its helpers. Everything shown from
   a catalog, the MCP registry or a plugin is third-party text: it goes through esc() before reaching
   innerHTML. The server owns plugin state; a row shows what the server last said, never a guess. */
const mk = { tab: 'skills', view: { skills: 'discover', connectors: 'discover', plugins: 'discover' }, q: '', offset: 0, seq: 0, timer: null, jobs: new Map() };
const MCP_STATUS = { connected: '已连接', failed: '连接失败', 'needs-auth': '待授权', pending: '连接中', disabled: '已停用', idle: '发消息后连接' };

const fmtCount = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万次安装` : n ? `${n} 次安装` : '');
const curView = () => mk.view[mk.tab];
const onMarket = () => pageStack.includes('page-market');
const failed = (title, msg) => showDialog({ title, msg: msg || '请重试', ok: '知道了', cancel: '' });

function marketRow({ title, badges = [], sub = '', meta = '', metaWarn = false, action = '' }) {
	const row = el('div', 'row market-row');
	const bs = badges.map(([cls, text]) => `<span class="badge ${esc(cls)}">${esc(text)}</span>`).join('');
	row.innerHTML = `<span class="row-text"><span>${esc(title)}${bs}</span>`
		+ (sub ? `<span class="item-sub">${esc(sub)}</span>` : '')
		+ (meta ? `<span class="market-meta${metaWarn ? ' warn' : ''}">${esc(meta)}</span>` : '')
		+ `</span>${action}`;
	return row;
}
const actionBtn = (label, cls = 'accent') => `<button class="pill-btn ${cls} market-act">${esc(label)}</button>`;
const toggleHtml = (on) => `<label class="sw"><input type="checkbox" ${on ? 'checked' : ''} aria-label="启用"><i></i></label>`;
const delHtml = (label) => `<button class="item-del" aria-label="${esc(label)}">${ic('i-trash')}</button>`;
const emptyMsg = (text) => el('div', 'empty-state', esc(text));
const spinner = (text) => el('div', 'empty-state', `<span class="spin"></span>${text ? `<div class="market-wait">${esc(text)}</div>` : ''}`);
const listOf = (rows) => { const l = el('div', 'list items'); rows.forEach((r) => l.appendChild(r)); return l; };
const groupLabel = (text) => el('h2', 'group-label', esc(text));
function removeRow(row) {
	const list = row.parentElement;
	row.remove();
	if (list && !list.children.length) { list.previousElementSibling?.remove(); list.remove(); }
}
function busyButton(btn, label) {
	const old = btn.textContent;
	btn.disabled = true;
	btn.innerHTML = `<span class="spin sm"></span>${esc(label)}`;
	return () => { btn.disabled = false; btn.textContent = old; };
}
function setInstalledCount(n) {
	const word = mk.tab === 'connectors' ? '已添加' : '已安装';
	$('#market-view-installed').textContent = n ? `${word} ${n}` : word;
}

/* ---------------- navigation ---------------- */
function openMarket(tab, view) {
	mk.tab = tab;
	if (view) mk.view[tab] = view;
	if (onMarket()) syncMarket(); else openPage('page-market');
}
function syncMarket() {
	$$('#market-seg button').forEach((b) => b.classList.toggle('sel', b.dataset.v === mk.tab));
	$$('#market-view button').forEach((b) => b.classList.toggle('sel', b.dataset.v === curView()));
	setInstalledCount(0);
	mk.q = '';
	$('#market-search').value = '';
	loadMarket();
}
$$('#market-seg button').forEach((b) => b.addEventListener('click', () => { mk.tab = b.dataset.v; syncMarket(); }));
$$('#market-view button').forEach((b) => b.addEventListener('click', () => { mk.view[mk.tab] = b.dataset.v; syncMarket(); }));
$('#market-search').addEventListener('input', (e) => {
	clearTimeout(mk.timer);
	mk.timer = setTimeout(() => { mk.q = e.target.value.trim(); loadMarket(); }, 350);
});
$('#market-more').addEventListener('click', () => loadPlugins(true));
PAGE_OPEN['page-market'] = syncMarket;

function loadMarket() {
	$('#market-more').classList.add('hidden');
	$('#market-intro').innerHTML = '';
	$('#market-foot').innerHTML = '';
	$('#market-search').placeholder = {
		skills: '搜索技能',
		connectors: curView() === 'discover' ? '搜索，也会查 MCP 官方注册表' : '搜索已添加的连接器',
		plugins: '搜索插件',
	}[mk.tab];
	({ skills: loadSkillsTab, connectors: loadConnectorsTab, plugins: loadPlugins }[mk.tab])();
}
function start(text) {
	const box = $('#market-results');
	box.innerHTML = '';
	box.appendChild(spinner(text));
	return { seq: ++mk.seq, box };
}

/* ---------------- skills ---------------- */
function createCard() {
	const card = el('div', 'market-card', `<div class="market-card-text"><b>做一个自己的技能</b><span>把反复要做的事告诉 Claude，一起写成技能。</span></div>${actionBtn('开始')}`);
	$('.market-act', card).addEventListener('click', startCreateSkill);
	return card;
}

async function loadSkillsTab() {
	$('#market-intro').appendChild(createCard());
	const { seq, box } = start();
	const needDrafts = curView() === 'installed';
	const [mine, catalog, drafts] = await Promise.all([getJSON('/api/skills'), getJSON('/api/market/skills'), needDrafts ? getJSON('/api/skills/drafts') : { ok: true, drafts: [] }]);
	if (seq !== mk.seq) return;
	box.innerHTML = '';
	if (!mine.ok || !catalog.ok) { box.appendChild(emptyMsg('读取失败，请稍后重试')); return; }
	setInstalledCount(mine.skills.length);
	const needle = mk.q.toLowerCase();
	const hit = (...parts) => !needle || parts.join(' ').toLowerCase().includes(needle);
	if (curView() === 'installed') {
		if (drafts.ok && drafts.drafts.length) {
			box.appendChild(groupLabel('等你确认的草稿'));
			box.appendChild(listOf(drafts.drafts.map(draftRow)));
		}
		const rows = mine.skills.filter((s) => hit(s.id, s.name, s.description))
			.sort((a, b) => (a.loadable - b.loadable) || (b.enabled - a.enabled) || (a.builtin - b.builtin) || a.name.localeCompare(b.name)).map(skillRow);
		if (rows.length) box.appendChild(listOf(rows));
		else if (!box.children.length) box.appendChild(emptyMsg(mk.q ? '没有符合的技能' : '还没有技能'));
		return;
	}
	const items = catalog.items.filter((s) => !s.installed && hit(s.id, s.name, s.description));
	if (items.length) {
		box.appendChild(groupLabel('Anthropic 官方技能'));
		box.appendChild(listOf(items.map((s) => {
			const row = marketRow({ title: s.name, sub: s.description, meta: s.needs || '', action: actionBtn('安装') });
			$('.market-act', row).addEventListener('click', (e) => installSkill(s.source, e.currentTarget, row));
			return row;
		})));
	} else box.appendChild(emptyMsg(mk.q ? '没有符合的技能' : '官方技能都已经装好了'));
	const foot = $('#market-foot');
	foot.appendChild(groupLabel('从其他地方安装'));
	const form = el('div', 'inline-form', '<input id="market-skill-src" type="text" placeholder="GitHub 地址或手机里的文件夹路径" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="pill-btn accent">安装</button>');
	$('button', form).addEventListener('click', (e) => {
		const src = $('#market-skill-src').value.trim();
		if (!src) return;
		showDialog({
			title: '安装这个技能？', msg: `来源：${src}\n\n技能里的说明会影响助手的行为，也可能带脚本。助手在 root 环境运行，请只安装你信任的来源。`, ok: '安装',
			onOk: () => installSkill(src, e.target, null),
		});
	});
	foot.appendChild(form);
	foot.appendChild(el('p', 'foot-note', '官方技能在安装时从 github.com/anthropics/skills 下载，使用受各自的许可约束。'));
}

// How a skill gets used, in the owner's words: this is the one place that tells them.
function skillNote(s) {
	if (!s.loadable) return s.nested.length ? `没有生效：技能文件放得太深，Claude 读不到。点「修复」可以放好（找到 ${s.nested.length} 个技能）` : '没有生效：这个文件夹里没有技能文件（SKILL.md），Claude 读不到';
	if (!s.enabled) return '';
	if (!s.userInvocable) return 'Claude 会在需要时自己使用，斜杠菜单里没有';
	if (!s.modelInvocable) return `输入 /${s.name} 使用，Claude 不会自己使用`;
	return `输入 /${s.name} 使用，或者直接说出你的需求`;
}

// Installed skills show a readable title: a description opening with a short phrase ("手机体检。…") gives it.
function skillRow(s) {
	const dm = /^([^。.]{2,10})[。.]\s*(.+)$/s.exec(s.description || '');
	const fixable = !s.loadable && s.nested.length > 0;
	const row = marketRow({
		title: dm ? dm[1] : s.name, sub: dm ? dm[2] : (s.description || s.id),
		badges: s.builtin ? [['builtin', '内置']] : [],
		meta: skillNote(s), metaWarn: !s.loadable,
		// A switch on something that can't load would only claim it works.
		action: (fixable ? actionBtn('修复') : s.loadable ? toggleHtml(s.enabled) : '') + (s.builtin ? '' : delHtml('删除')),
	});
	$('input', row)?.addEventListener('change', async (e) => {
		e.target.disabled = true;
		const r = await api('/api/skills/toggle', { id: s.id, enabled: e.target.checked });
		e.target.disabled = false;
		if (!r.ok) { e.target.checked = !e.target.checked; toast(r.error || '操作失败'); }
		else loadMarket(); // its note changes with the switch
	});
	$('.market-act', row)?.addEventListener('click', async (e) => {
		const reset = busyButton(e.currentTarget, '修复中');
		const r = await api('/api/skills/repair', { id: s.id });
		if (!r.ok) { reset(); failed('修复失败', r.error); return; }
		toast(`已修复：${r.installed.join('、')}`);
		loadMarket();
	});
	const del = $('.item-del', row);
	if (del) del.addEventListener('click', () => showDialog({
		title: '删除技能？', msg: `「${s.name}」会被删除。`, ok: '删除', danger: true,
		onOk: async () => { const r = await api('/api/skills/delete', { id: s.id }); if (r.ok) loadMarket(); else failed('删除失败', r.error); },
	}));
	return row;
}

async function installSkill(source, btn, row) {
	const reset = busyButton(btn, '下载中');
	const r = await api('/api/skills/install', { source });
	if (!r.ok) { reset(); failed('安装失败', r.error || '请检查网络后重试'); return; }
	if (row) removeRow(row); else reset();
	const input2 = $('#market-skill-src');
	if (!row && input2) input2.value = '';
	toast(`已安装：${(r.installed || []).join('、')}`);
	if (mk.tab === 'skills') setInstalledCount(r.skills.length);
}

/* ---------------- creating a skill with Claude ---------------- */
const CREATE_SKILL_PROMPT = '我想创建一个新技能，请用 create-skill 技能一步步带我做。';
async function startCreateSkill() {
	closeAll();
	await createNewChat();
	input.value = CREATE_SKILL_PROMPT;
	send();
}

function draftRow(d) {
	const row = marketRow({
		title: d.name, sub: d.description,
		badges: d.errors.length ? [['failed', '需要修改']] : [],
		action: actionBtn('预览') + delHtml('丢弃'),
	});
	$('.market-act', row).addEventListener('click', () => previewDraft(d));
	$('.item-del', row).addEventListener('click', () => showDialog({
		title: '丢弃这份草稿？', msg: `「${d.name}」会被删除。`, ok: '丢弃', danger: true,
		onOk: async () => { await api('/api/skills/drafts/discard', { id: d.id }); loadMarket(); },
	}));
	return row;
}

function previewDraft(d) {
	const problems = d.errors.length ? `<p class="market-warn">还不能保存：${esc(d.errors.join('；'))}。可以回到对话里让 Claude 修改。</p>` : '';
	showDialog({
		title: `预览「${d.name}」`, html: true, msg: `${problems}<pre class="market-pre">${esc(d.text)}</pre>`,
		ok: d.errors.length ? '知道了' : '保存并启用', cancel: d.errors.length ? '' : '先不保存',
		onOk: d.errors.length ? null : () => publishDraft(d.id, false),
	});
}

async function publishDraft(id, overwrite) {
	const r = await api('/api/skills/drafts/publish', { id, overwrite });
	if (r.ok) { toast('已保存并启用，输入 / 就能找到它'); if (onMarket()) loadMarket(); return; }
	if (r.exists) { showDialog({ title: '覆盖同名技能？', msg: r.error, ok: '覆盖', danger: true, onOk: () => publishDraft(id, true) }); return; }
	failed('保存失败', r.error);
}

/* ---------------- connectors ---------------- */
const AUTH_BADGE = { none: ['connected', '免登录'], oauth: ['needs-auth', '需要授权'], token: ['needs-auth', '需要令牌'] };

async function loadConnectorsTab() {
	const installedView = curView() === 'installed';
	const { seq, box } = start(!installedView && mk.q ? '正在搜索 MCP 注册表' : '');
	const [mine, cat] = await Promise.all([getJSON(installedView ? `/api/mcp?probe=${encodeURIComponent(curSession?.id || '1')}` : '/api/mcp'), installedView ? null : getJSON('/api/market/connectors' + (mk.q ? `?q=${encodeURIComponent(mk.q)}` : ''))]);
	if (seq !== mk.seq) return;
	box.innerHTML = '';
	if (!mine.ok || (cat && !cat.ok)) { box.appendChild(emptyMsg('读取失败，请稍后重试')); return; }
	setInstalledCount(Object.keys(mine.servers || {}).length);
	if (installedView) {
		renderMyConnectors(box, mine);
		$('#market-foot').appendChild(manualConnectorForm());
		watchConnectors(mine, seq);
		return;
	}
	const curated = cat.curated.filter((c) => !c.added);
	if (curated.length) {
		box.appendChild(groupLabel('精选'));
		box.appendChild(listOf(curated.map(connectorRow)));
	}
	if (mk.q) {
		box.appendChild(groupLabel('MCP 官方注册表'));
		box.appendChild(el('p', 'hint', '由开发者自行发布，被收录不代表安全。'));
		const reg = cat.registry.filter((c) => !c.added);
		if (cat.registryError) box.appendChild(emptyMsg(`搜索失败：${cat.registryError}。请检查网络或代理。`));
		else if (reg.length) box.appendChild(listOf(reg.map(connectorRow)));
		else box.appendChild(emptyMsg('没有找到可以在手机上使用的结果'));
	} else {
		$('#market-foot').appendChild(el('p', 'foot-note', '想找其他服务，在上面搜索就会查询 MCP 官方注册表。'));
	}
}

function renderMyConnectors(box, r) {
	const needle = mk.q.toLowerCase();
	const status = Object.fromEntries((r.status || []).map((s) => [s.name, s]));
	const names = Object.keys(r.servers || {}).filter((n) => !needle || n.toLowerCase().includes(needle));
	if (names.length) box.appendChild(listOf(names.map((n) => myConnectorRow(n, r.servers[n], status[n]))));
	else box.appendChild(emptyMsg(mk.q ? '没有符合的连接器' : '还没有添加连接器'));
	// Connectors from the Claude account and from plugins show up in the live status only.
	const others = (r.status || []).filter((s) => !r.servers?.[s.name] && (!needle || s.name.toLowerCase().includes(needle)));
	for (const [label, match] of EXTERNAL_GROUPS) {
		const rows = others.filter(match);
		if (rows.length) {
			box.appendChild(groupLabel(label));
			box.appendChild(listOf(rows.map(externalConnectorRow)));
		}
	}
	if (!r.live && !needle) box.appendChild(el('p', 'foot-note', '来自 Claude 账号和插件的连接器，要开始一段对话后才会显示。'));
}

const isAccountConnector = (s) => s.name.startsWith('claude.ai ') || s.scope === 'claudeai';
const isPluginConnector = (s) => s.name.startsWith('plugin:') || s.source === 'plugin';
const EXTERNAL_GROUPS = [
	['来自 Claude 账号', isAccountConnector],
	['来自插件', (s) => !isAccountConnector(s) && isPluginConnector(s)],
	['其他配置', (s) => !isAccountConnector(s) && !isPluginConnector(s)],
];
function externalTitle(s) {
	if (s.name.startsWith('claude.ai ')) return s.name.slice('claude.ai '.length);
	const p = s.name.split(':');
	return p[0] === 'plugin' && p.length >= 3 ? (p[1] === p[2] ? p[2] : `${p[2]}（${p[1]}）`) : s.name;
}
function addErrorLine(row, error) {
	if (error) $('.row-text', row).appendChild(el('span', 'market-error', esc(error)));
}

function externalConnectorRow(s) {
	const needsAuth = s.status === 'needs-auth';
	const broken = s.status === 'failed';
	const row = marketRow({
		title: externalTitle(s), badges: [[s.status, MCP_STATUS[s.status] || s.status]],
		sub: s.tools?.length ? `${s.tools.length} 个工具` : '',
		action: (needsAuth ? actionBtn('授权') : broken ? actionBtn('重试', '') : '') + toggleHtml(s.status !== 'disabled'),
	});
	addErrorLine(row, s.error);
	const act = $('.market-act', row);
	if (act) act.addEventListener('click', (e) => (needsAuth ? authorizeConnector(s.name) : reconnectConnector(s.name, e.currentTarget)));
	$('input', row).addEventListener('change', async (e) => {
		const sw = e.target;
		const on = sw.checked;
		sw.disabled = true;
		const r = await api('/api/mcp/external-toggle', { name: s.name, enabled: on });
		sw.disabled = false;
		// Turning on a server that then can't connect reports an error, yet it is on now: only the
		// refreshed list says which state it ended in.
		if (!r.ok) failed(on ? '没能连接' : '操作失败', r.error);
		else toast(on ? '已开启' : '已关闭');
		refreshConnectors();
	});
	return row;
}

async function reconnectConnector(name, btn) {
	const reset = btn ? busyButton(btn, '连接中') : null;
	const r = await api('/api/mcp/reconnect', { name });
	reset?.();
	if (!r.ok) failed('连接失败', r.error);
	else toast('已重新连接');
	refreshConnectors();
}

// The list again in place, leaving a half-filled manual form below it alone.
async function refreshConnectors() {
	if (!onMarket() || mk.tab !== 'connectors' || curView() !== 'installed') return null;
	const seq = mk.seq;
	const r = await getJSON('/api/mcp');
	if (seq !== mk.seq || !r.ok) return null;
	const box = $('#market-results');
	box.innerHTML = '';
	setInstalledCount(Object.keys(r.servers || {}).length);
	renderMyConnectors(box, r);
	return r;
}
// Servers take a few seconds to connect after the page opens; show them arriving.
async function watchConnectors(r, seq) {
	for (let i = 0; i < 6 && seq === mk.seq && (!r || !r.live || (r.status || []).some((s) => s.status === 'pending')); i++) {
		await new Promise((done) => { setTimeout(done, 3000); });
		if (seq !== mk.seq) return;
		r = await refreshConnectors();
	}
}

function myConnectorRow(name, cfg, st) {
	const key = cfg.disabled ? 'disabled' : (st ? st.status : 'idle');
	// Before any conversation has run there is no live status, so go by what the catalog says.
	const needsAuth = !cfg.disabled && cfg.type !== 'stdio' && (key === 'needs-auth' || (!st && cfg.auth === 'oauth'));
	const broken = !cfg.disabled && key === 'failed';
	const row = marketRow({
		title: name, badges: [[key, MCP_STATUS[key] || key]],
		sub: `${cfg.url || [cfg.command, ...(cfg.args || [])].join(' ') || cfg.type}${st?.tools ? `，${st.tools.length} 个工具` : ''}`,
		action: (needsAuth ? actionBtn('授权') : broken ? actionBtn('重试', '') : '') + toggleHtml(!cfg.disabled) + delHtml('删除'),
	});
	if (needsAuth) $('.market-act', row).addEventListener('click', () => authorizeConnector(name));
	if (broken) $('.market-act', row).addEventListener('click', (e) => reconnectConnector(name, e.currentTarget));
	addErrorLine(row, st?.error);
	$('input', row).addEventListener('change', async (e) => {
		e.target.disabled = true;
		const r = await api('/api/mcp/toggle', { name, enabled: e.target.checked });
		e.target.disabled = false;
		if (!r.ok) { e.target.checked = !e.target.checked; toast(r.error || '操作失败'); return; }
		refreshConnectors();
	});
	$('.item-del', row).addEventListener('click', () => showDialog({
		title: '删除连接器？', msg: `「${name}」会被移除。`, ok: '删除', danger: true,
		onOk: async () => { await api('/api/mcp/remove', { name }); loadMarket(); },
	}));
	return row;
}

function manualConnectorForm() {
	const d = el('details', 'market-manual', `<summary>手动添加</summary>
		<div class="form-card">
			<input id="mcp-name" type="text" placeholder="名称（字母、数字、. _ -）" autocomplete="off" autocapitalize="off" spellcheck="false">
			<div class="seg" id="mcp-type-seg"><button data-v="http" class="sel">HTTP</button><button data-v="sse">SSE</button><button data-v="stdio">本地命令</button></div>
			<input id="mcp-url" type="text" placeholder="地址，例如 https://example.com/mcp" autocomplete="off" autocapitalize="off" spellcheck="false">
			<input id="mcp-bearer" type="text" placeholder="Bearer Token（可选）" autocomplete="off" autocapitalize="off" spellcheck="false">
			<input id="mcp-command" type="text" placeholder="命令，例如 npx" autocomplete="off" autocapitalize="off" spellcheck="false" class="hidden">
			<input id="mcp-args" type="text" placeholder="参数，用空格分隔" autocomplete="off" autocapitalize="off" spellcheck="false" class="hidden">
			<p id="mcp-msg" class="form-msg"></p>
			<button id="mcp-add" class="primary">添加</button>
		</div>`);
	let type = 'http';
	$$('#mcp-type-seg button', d).forEach((b) => b.addEventListener('click', () => {
		type = b.dataset.v;
		$$('#mcp-type-seg button', d).forEach((x) => x.classList.toggle('sel', x === b));
		['#mcp-url', '#mcp-bearer'].forEach((s) => $(s, d).classList.toggle('hidden', type === 'stdio'));
		['#mcp-command', '#mcp-args'].forEach((s) => $(s, d).classList.toggle('hidden', type !== 'stdio'));
	}));
	$('#mcp-add', d).addEventListener('click', async () => {
		const payload = { name: $('#mcp-name', d).value.trim(), type };
		if (type === 'stdio') {
			payload.command = $('#mcp-command', d).value.trim();
			const args = $('#mcp-args', d).value.trim();
			payload.args = args ? args.split(/\s+/) : [];
		} else {
			payload.url = $('#mcp-url', d).value.trim();
			if ($('#mcp-bearer', d).value.trim()) payload.bearer = $('#mcp-bearer', d).value.trim();
		}
		const msg = $('#mcp-msg', d);
		msg.className = 'form-msg'; msg.textContent = '正在添加…';
		const r = await api('/api/mcp/add', payload);
		if (r.ok) { toast('已添加'); loadMarket(); } else { msg.className = 'form-msg err'; msg.textContent = '添加失败：' + (r.error || ''); }
	});
	return d;
}

function connectorRow(c) {
	const badges = [];
	if (c.source === 'curated' && AUTH_BADGE[c.auth]) badges.push(AUTH_BADGE[c.auth]);
	if (c.type === 'stdio') badges.push(['failed', '本地命令']);
	const target = c.type === 'stdio' ? [c.command, ...(c.args || [])].join(' ') : c.url;
	const row = marketRow({ title: c.title, sub: c.description, meta: target, badges, action: actionBtn('添加') });
	$('.market-act', row).addEventListener('click', (e) => confirmConnector(c, row, e.currentTarget));
	return row;
}

function confirmConnector(c, row, btn) {
	const fields = (c.inputs || []).map((inp) => `<label class="market-field"><span>${esc(inp.label || inp.key)}${inp.required ? '' : '（可选）'}</span><input data-key="${esc(inp.key)}" type="${inp.secret ? 'password' : 'text'}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>`).join('');
	let warn = '';
	if (c.type === 'stdio') {
		warn = `<p class="market-warn">这是一个本地命令，会从网上下载代码并以 root 身份在手机上运行，能访问手机上的所有数据。只添加你信任的作者发布的连接器。</p><pre class="market-pre">${esc([c.command, ...(c.args || [])].join(' '))}</pre>`;
	} else if (c.source !== 'curated') {
		warn = `<p class="market-warn">对话内容里和它相关的数据会发送到这个地址。</p><pre class="market-pre">${esc(c.url)}</pre>`;
	}
	if (!fields && !warn) { addConnector(c, {}, false, row, btn); return; }
	showDialog({
		title: `添加「${c.title}」？`, html: true, msg: `${warn}${fields}`, ok: c.type === 'stdio' ? '我了解，添加' : '添加', danger: c.type === 'stdio',
		onOk: () => {
			const values = {};
			$$('#dialog-msg input[data-key]').forEach((i) => { values[i.dataset.key] = i.value; });
			addConnector(c, values, false, row, btn);
		},
	});
}

async function addConnector(c, values, overwrite, row, btn) {
	const reset = busyButton(btn, '添加中');
	const r = await api('/api/market/connectors/add', { id: c.id, source: c.source, values, confirmed: true, overwrite });
	if (r.exists) {
		reset();
		showDialog({ title: '替换同名连接器？', msg: r.error, ok: '替换', danger: true, onOk: () => addConnector(c, values, true, row, btn) });
		return;
	}
	if (!r.ok) { reset(); failed('添加失败', r.error); return; }
	removeRow(row);
	getJSON('/api/mcp').then((m) => { if (m.ok && mk.tab === 'connectors') setInstalledCount(Object.keys(m.servers || {}).length); });
	if (c.auth === 'oauth') {
		showDialog({ title: `已添加「${c.title}」`, msg: '它需要你登录对应的账号才能使用。', ok: '现在授权', cancel: '以后再说', onOk: () => authorizeConnector(r.name) });
	} else {
		toast(c.type === 'stdio' ? '已添加，首次使用时会下载' : '已添加');
	}
}

async function authorizeConnector(name) {
	toast('正在准备授权');
	const r = await api('/api/mcp/login', { name });
	if (!r.ok) { failed('授权失败', r.error); return; }
	if (r.url) {
		// An account connector is authorized on claude.ai; this device's connection then needs renewing.
		if (!/^https:\/\//.test(r.url)) return;
		showDialog({
			title: `授权「${externalTitle({ name })}」`, html: true,
			msg: `<p>在 claude.ai 上完成授权，然后回到这里。</p><p><a class="pill-btn accent market-link" href="${esc(r.url)}" target="_blank" rel="noopener">打开授权页面</a></p>`,
			ok: '我已完成', cancel: '稍后', onOk: () => reconnectConnector(name, null),
		});
		return;
	}
	if (r.fallback === 'chat') {
		// Claude Code 2.1.112 has no `mcp login`; the server exposes an authenticate tool instead.
		closeAll();
		await createNewChat();
		input.value = `请帮我授权 MCP 连接器「${name}」：调用它的 authenticate 工具，把授权链接发给我。`;
		send();
	}
}

/* ---------------- plugins ---------------- */
const JOB_TEXT = { queued: '排队中', downloading: '正在下载', checking: '正在检查内容' };

async function loadPlugins(more = false) {
	const box = $('#market-results');
	const btn = $('#market-more');
	const paging = more === true;
	let seq;
	if (paging) {
		seq = ++mk.seq;
		mk.offset += 40;
		btn.disabled = true;
	} else {
		mk.offset = 0;
		({ seq } = start(mk.pluginsLoaded ? '' : '第一次打开要下载官方目录，可能需要一两分钟'));
	}
	const params = new URLSearchParams({ offset: String(mk.offset) });
	if (mk.q) params.set('q', mk.q);
	const r = await getJSON(`/api/market/plugins?${params}`);
	if (seq !== mk.seq) return;
	btn.disabled = false;
	if (!paging) box.innerHTML = '';
	if (!r.ok) {
		const err = emptyMsg(`${r.error || '读取失败'}。请检查网络或代理。`);
		const again = el('button', 'pill-btn market-retry', '重试');
		again.addEventListener('click', () => loadPlugins());
		err.appendChild(again);
		box.appendChild(err);
		return;
	}
	mk.pluginsLoaded = true;
	setInstalledCount(r.installedCount);
	// What the server is doing now: a job that ended while the page was away must not linger.
	mk.jobs = new Map((r.jobs || []).map((j) => [j.id, j]));
	if (curView() === 'installed') {
		if (r.installed.length) box.appendChild(listOf(r.installed.map(installedPluginRow)));
		else box.appendChild(emptyMsg(mk.q ? '没有符合的插件' : '还没有安装插件'));
		return;
	}
	if (!r.items.length && !mk.offset) box.appendChild(emptyMsg('没有符合的插件'));
	else {
		if (!mk.offset) box.appendChild(groupLabel(`可安装 ${r.total} 个`));
		box.appendChild(listOf(r.items.map(pluginRow)));
	}
	btn.classList.toggle('hidden', mk.offset + r.items.length >= r.total);
	if (!paging) loadMarketplaces();
	tickJobs();
}

const originBadge = (p) => (p.official ? ['', '官方目录'] : ['needs-auth', '第三方市场']);

function pluginRow(p) {
	const row = marketRow({
		title: p.name, sub: p.description, badges: [originBadge(p)],
		meta: [p.marketplace, fmtCount(p.installCount)].filter(Boolean).join(' · '),
		action: actionBtn('安装'),
	});
	row.dataset.plugin = p.id;
	row.pluginInfo = p;
	$('.market-act', row).addEventListener('click', () => confirmPlugin(p));
	renderJob(row);
	return row;
}

function confirmPlugin(p) {
	if (p.official) { downloadPlugin(p); return; }
	showDialog({
		title: '安装第三方插件？',
		msg: `「${p.name}」来自市场 ${p.marketplace}，不在 Anthropic 官方目录里。下载后会先列出它的内容，由你决定是否启用。`,
		ok: '下载并查看', onOk: () => downloadPlugin(p),
	});
}

async function downloadPlugin(p) {
	mk.jobs.set(p.id, { id: p.id, stage: 'queued', startedAt: Date.now() });
	refreshJobRow(p.id);
	tickJobs();
	const r = await api('/api/market/plugins/download', { id: p.id });
	if (!r.ok) { mk.jobs.delete(p.id); refreshJobRow(p.id); failed('下载失败', r.error); }
}

const pluginRowEl = (id) => [...$$('#market-results [data-plugin]')].find((x) => x.dataset.plugin === id);
function refreshJobRow(id) { const row = pluginRowEl(id); if (row) renderJob(row); }

// The CLI reports no percentage, so the row shows the stage, a moving bar and the time so far.
function renderJob(row) {
	const job = mk.jobs.get(row.dataset.plugin);
	let box = $('.job', row);
	const btn = $('.market-act', row);
	if (!job) { box?.remove(); btn.classList.remove('hidden'); return; }
	btn.classList.add('hidden');
	if (!box) {
		box = el('div', 'job', '<span class="job-text"></span><span class="job-time"></span><i class="job-bar"></i>');
		$('.row-text', row).appendChild(box);
	}
	$('.job-text', box).textContent = JOB_TEXT[job.stage] || '处理中';
	$('.job-time', box).textContent = `${Math.max(0, Math.round((Date.now() - job.startedAt) / 1000))} 秒`;
}
function tickJobs() {
	if (mk.jobTimer || !mk.jobs.size) return;
	mk.jobTimer = setInterval(() => {
		if (!mk.jobs.size) { clearInterval(mk.jobTimer); mk.jobTimer = null; return; }
		for (const id of mk.jobs.keys()) refreshJobRow(id);
	}, 1000);
}

function onPluginJob(m) {
	if (m.stage === 'ready' || m.stage === 'error') {
		mk.jobs.delete(m.id);
		const row = pluginRowEl(m.id);
		const name = row?.pluginInfo?.name || m.id.split('@')[0];
		if (m.stage === 'error') {
			refreshJobRow(m.id);
			if (onMarket()) failed(`「${name}」下载失败`, m.error); else toast(`「${name}」下载失败`);
			return;
		}
		if (row) removeRow(row);
		// Interrupting whatever the owner is reading would be worse than waiting in 已安装.
		if (onMarket() && $('#dialog').classList.contains('hidden')) reviewPlugin(m.id, name, m.contents, null);
		else toast(`「${name}」下载好了，到「已安装」里启用`);
		return;
	}
	mk.jobs.set(m.id, m);
	refreshJobRow(m.id);
	tickJobs();
}

function installedPluginRow(p) {
	const row = marketRow({
		title: p.name, sub: p.description, badges: p.official ? [] : [originBadge(p)],
		meta: [p.marketplace, p.version].filter(Boolean).join(' · '),
		action: toggleHtml(p.enabled) + delHtml('卸载'),
	});
	const sw = $('input', row);
	const text = $('.row-text', row);
	text.classList.add('market-tap');
	text.addEventListener('click', async () => {
		const r = await getJSON(`/api/market/plugins/inspect?id=${encodeURIComponent(p.id)}`);
		if (!r.ok) { failed('读取失败', r.error); return; }
		showDialog({ title: p.name, html: true, msg: contentsHtml(r.contents), ok: '关闭', cancel: '' });
	});
	sw.addEventListener('change', async (e) => {
		const on = e.target.checked;
		if (!on) { applyPlugin(p.id, false, sw); return; }
		// Stays off until confirmed: closing the dialog any way leaves the switch telling the truth.
		sw.checked = false;
		sw.disabled = true;
		const r = await getJSON(`/api/market/plugins/inspect?id=${encodeURIComponent(p.id)}`);
		sw.disabled = false;
		if (!r.ok) { failed('读取失败', r.error); return; }
		if (r.enabled) { sw.checked = true; return; }
		if (!r.contents || r.contents.runsCode) reviewPlugin(p.id, p.name, r.contents, sw);
		else applyPlugin(p.id, true, sw);
	});
	$('.item-del', row).addEventListener('click', () => showDialog({
		title: '卸载插件？', msg: `「${p.name}」会被移除。`, ok: '卸载', danger: true,
		onOk: async () => {
			row.classList.add('market-busy');
			const r = await api('/api/market/plugins/uninstall', { id: p.id });
			row.classList.remove('market-busy');
			if (!r.ok) { failed('卸载失败', r.error); return; }
			toast('已卸载');
			if (onMarket() && mk.tab === 'plugins') loadPlugins();
		},
	}));
	return row;
}

// The switch only ever shows what the server answered.
async function applyPlugin(id, on, sw) {
	if (sw) { sw.disabled = true; sw.checked = on; }
	const r = await api('/api/market/plugins/set', { id, enabled: on });
	if (sw) { sw.disabled = false; if (r.ok) sw.checked = r.enabled; else sw.checked = !on; }
	if (!r.ok) { failed('操作失败', r.error); return; }
	toast(r.enabled ? '已启用' : '已停用');
}

function reviewPlugin(id, name, contents, sw) {
	const risky = !contents || contents.runsCode;
	showDialog({
		title: `启用「${name}」？`, html: true, msg: contentsHtml(contents),
		ok: risky ? '我了解，启用' : '启用', cancel: '先不启用', danger: risky,
		onOk: () => applyPlugin(id, true, sw),
	});
}

function contentsHtml(c) {
	if (!c) return '<p class="market-warn">没能读取它的内容。</p>';
	const line = (label, items) => (items.length ? `<p><b>${esc(label)}：</b>${esc(items.join('、'))}</p>` : '');
	let html = c.author ? `<p><b>作者：</b>${esc(c.author)}</p>` : '';
	html += c.description ? `<p>${esc(c.description)}</p>` : '';
	html += line('技能', c.skills) + line('命令', c.commands.map((x) => `/${x}`)) + line('子代理', c.agents);
	if (c.hooks.length) {
		html += '<p class="market-warn">自动脚本（hooks）：会在助手工作时自动运行，以 root 身份执行，并且不会逐次询问你。</p>';
		html += `<pre class="market-pre">${esc(c.hooks.map((h) => `${h.event}: ${h.command}`).join('\n'))}</pre>`;
	}
	if (c.mcp.length) {
		const local = c.mcp.some((m) => m.local);
		html += local ? '<p class="market-warn"><b>连接器：</b>其中的本地命令会以 root 身份运行。</p>' : '<p><b>连接器：</b></p>';
		html += `<pre class="market-pre">${esc(c.mcp.map((m) => `${m.name}: ${m.target}`).join('\n'))}</pre>`;
	}
	if (c.otherCode) html += '<p class="market-warn">它还带有其他可执行内容（命令行工具、语言服务或监视器）。</p>';
	if (c.unreadable) html += '<p class="market-warn">它的部分配置没能读懂，无法确认会运行什么。</p>';
	return html || '<p>没有发现技能、命令或脚本。</p>';
}

async function loadMarketplaces() {
	const foot = $('#market-foot');
	foot.innerHTML = '';
	foot.appendChild(groupLabel('添加其他插件市场'));
	const form = el('div', 'inline-form', '<input id="market-source" type="text" placeholder="https 地址，或 GitHub 的 owner/repo" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="pill-btn accent">添加</button>');
	$('button', form).addEventListener('click', async (e) => {
		const source = $('#market-source').value.trim();
		if (!source) return;
		const reset = busyButton(e.target, '添加中');
		const r = await api('/api/market/marketplaces/add', { source });
		reset();
		if (!r.ok) { failed('添加失败', r.error); return; }
		toast('已添加');
		if (mk.tab === 'plugins') loadMarket();
	});
	foot.appendChild(form);
	const custom = el('div');
	foot.appendChild(custom);
	const r = await getJSON('/api/market/marketplaces');
	if (!r.ok) return;
	const others = r.marketplaces.filter((m) => !m.official);
	if (!others.length) return;
	custom.appendChild(listOf(others.map((m) => {
		const row = marketRow({ title: m.name, sub: m.url, action: delHtml('移除') });
		$('.item-del', row).addEventListener('click', () => showDialog({
			title: '移除这个市场？', msg: `「${m.name}」和从它安装的插件都会被移除。`, ok: '移除', danger: true,
			onOk: async () => {
				const x = await api('/api/market/marketplaces/remove', { name: m.name });
				if (!x.ok) { failed('移除失败', x.error); return; }
				if (mk.tab === 'plugins') loadMarket();
			},
		}));
		return row;
	})));
}

/* ---------------- events from the server ---------------- */
// Only re-render a list that is on screen and would actually change, so a switch being flipped or
// a form being typed in isn't wiped out by the event its own action caused.
function marketEvent(m) {
	if (m.type === 'plugin_job') {
		onPluginJob(m);
	} else if (m.type === 'plugins_updated') {
		loadSlashCommands();
		if (onMarket() && mk.tab === 'plugins') setInstalledCount(m.installed);
	} else if (m.type === 'skill_draft') {
		showDialog({
			title: '技能草稿写好了', msg: `「${m.name}」已经写好，预览后可以保存并启用。`, ok: '查看', cancel: '稍后',
			onOk: () => openMarket('skills', 'installed'),
		});
	} else if (m.type === 'mcp_login_url') {
		if (!/^https:\/\//.test(m.url || '')) return;
		showDialog({
			title: `授权「${externalTitle(m)}」`, html: true,
			msg: `<p>打开下面的页面并允许访问，完成后回到这里。</p><p><a class="pill-btn accent market-link" href="${esc(m.url)}" target="_blank" rel="noopener">打开授权页面</a></p>`,
			ok: '关闭', cancel: '',
		});
	} else if (m.type === 'mcp_login_done') {
		if (m.ok) toast(`「${externalTitle(m)}」授权成功`);
		else failed('授权没有完成', m.message);
		refreshConnectors();
	}
}
