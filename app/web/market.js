/* The extension market: skills, connectors and plugins, plus creating a skill with Claude.
   Runs after app.js and shares its helpers. Everything shown from a catalog, the MCP registry or a
   plugin is third-party text: it goes through esc() before reaching innerHTML. */
const mk = { tab: 'skills', q: '', offset: 0, seq: 0, timer: null, busy: new Set() };

const fmtCount = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万次安装` : n ? `${n} 次安装` : '');

function marketRow({ title, badges = [], sub = '', meta = '', action = '' }) {
	const row = el('div', 'row market-row');
	const bs = badges.map(([cls, text]) => `<span class="badge ${esc(cls)}">${esc(text)}</span>`).join('');
	row.innerHTML = `<span class="row-text"><span>${esc(title)}${bs}</span>`
		+ (sub ? `<span class="item-sub">${esc(sub)}</span>` : '')
		+ (meta ? `<span class="market-meta">${esc(meta)}</span>` : '')
		+ `</span>${action}`;
	return row;
}
const actionBtn = (label, disabled = false, accent = true) => `<button class="pill-btn${accent ? ' accent' : ''} market-act"${disabled ? ' disabled' : ''}>${esc(label)}</button>`;
function emptyMsg(text) { return el('div', 'empty-state', esc(text)); }
function spinner(text) { return el('div', 'empty-state', `<span class="spin"></span>${text ? `<div class="market-wait">${esc(text)}</div>` : ''}`); }
function listOf(rows) { const l = el('div', 'list items'); rows.forEach((r) => l.appendChild(r)); return l; }
function groupLabel(text) { return el('h2', 'group-label', esc(text)); }

/* ---------------- tabs and search ---------------- */
function setMarketTab(tab) {
	mk.tab = tab;
	mk.q = '';
	$('#market-search').value = '';
	$$('#market-seg button').forEach((b) => b.classList.toggle('sel', b.dataset.v === tab));
	$('#market-search').placeholder = { skills: '搜索技能', connectors: '搜索连接器，也会查 MCP 官方注册表', plugins: '搜索插件' }[tab];
	loadMarket();
}
$$('#market-seg button').forEach((b) => b.addEventListener('click', () => setMarketTab(b.dataset.v)));
$('#market-search').addEventListener('input', (e) => {
	clearTimeout(mk.timer);
	mk.timer = setTimeout(() => { mk.q = e.target.value.trim(); loadMarket(); }, 350);
});
$('#market-more').addEventListener('click', () => loadPlugins(true));
PAGE_OPEN['page-market'] = () => setMarketTab(mk.tab);
$$('[data-market-tab]').forEach((b) => b.addEventListener('click', () => {
	mk.tab = b.dataset.marketTab;
	if (pageStack.includes('page-market')) setMarketTab(mk.tab); else openPage('page-market');
}));

function loadMarket() {
	$('#market-more').classList.add('hidden');
	$('#market-intro').innerHTML = '';
	$('#market-foot').innerHTML = '';
	({ skills: loadMarketSkills, connectors: loadConnectors, plugins: loadPlugins }[mk.tab])();
}

/* ---------------- skills ---------------- */
async function loadMarketSkills() {
	const seq = ++mk.seq;
	const box = $('#market-results');
	const intro = $('#market-intro');
	const create = el('div', 'market-card', `<div class="market-card-text"><b>做一个自己的技能</b><span>把反复要做的事告诉 Claude，一起写成技能。</span></div>${actionBtn('开始')}`);
	$('.market-act', create).addEventListener('click', startCreateSkill);
	intro.appendChild(create);
	box.innerHTML = '';
	box.appendChild(spinner());
	const r = await getJSON('/api/market/skills');
	if (seq !== mk.seq) return;
	box.innerHTML = '';
	if (!r.ok) { box.appendChild(emptyMsg('读取失败')); return; }
	const needle = mk.q.toLowerCase();
	const items = r.items.filter((s) => !needle || `${s.id} ${s.name} ${s.description}`.toLowerCase().includes(needle));
	if (!items.length) box.appendChild(emptyMsg('没有符合的技能'));
	else {
		box.appendChild(groupLabel('Anthropic 官方技能'));
		box.appendChild(listOf(items.map((s) => {
			const row = marketRow({
				title: s.name, sub: s.description, meta: s.needs || '',
				badges: s.installed ? [['connected', s.enabled ? '已安装' : '已停用']] : [],
				action: actionBtn(s.installed ? '已安装' : '安装', s.installed, !s.installed),
			});
			if (!s.installed) $('.market-act', row).addEventListener('click', (e) => installMarketSkill(s.source, e.currentTarget));
			return row;
		})));
	}
	const foot = $('#market-foot');
	foot.appendChild(groupLabel('从其他地方安装'));
	const form = el('div', 'inline-form', '<input id="market-skill-src" type="text" placeholder="GitHub 仓库或子目录地址" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="pill-btn accent">安装</button>');
	$('button', form).addEventListener('click', (e) => {
		const src = $('#market-skill-src').value.trim();
		if (!src) return;
		showDialog({
			title: '安装这个技能？', msg: `来源：${src}\n\n技能里的说明会影响助手的行为，也可能带脚本。助手在 root 环境运行，请只安装你信任的来源。`, ok: '安装',
			onOk: () => installMarketSkill(src, e.target),
		});
	});
	foot.appendChild(form);
	foot.appendChild(el('p', 'foot-note', '官方技能在安装时从 github.com/anthropics/skills 下载，使用受各自的许可约束。'));
}

async function installMarketSkill(source, btn) {
	const label = btn.textContent;
	btn.disabled = true;
	btn.textContent = '下载中';
	const r = await api('/api/skills/install', { source });
	if (r.ok) {
		toast(`已安装：${(r.installed || []).join('、')}`);
		if (mk.tab === 'skills' && pageStack.includes('page-market')) loadMarket();
	} else {
		btn.disabled = false;
		btn.textContent = label;
		showDialog({ title: '安装失败', msg: r.error || '请检查网络后重试', ok: '知道了', cancel: '' });
	}
}

/* ---------------- creating a skill with Claude ---------------- */
const CREATE_SKILL_PROMPT = '我想创建一个新技能，请用 create-skill 技能一步步带我做。';
async function startCreateSkill() {
	closeAll();
	await createNewChat();
	input.value = CREATE_SKILL_PROMPT;
	send();
}
$('#skill-create').addEventListener('click', startCreateSkill);

async function loadSkillDrafts() {
	const r = await getJSON('/api/skills/drafts');
	const drafts = r.ok ? r.drafts : [];
	$('#skill-drafts-group').classList.toggle('hidden', !drafts.length);
	const list = $('#skill-drafts');
	list.innerHTML = '';
	drafts.forEach((d) => {
		const row = marketRow({
			title: d.name, sub: d.description,
			badges: d.errors.length ? [['failed', '需要修改']] : [],
			action: `${actionBtn('预览')}<button class="item-del" aria-label="丢弃">${ic('i-trash')}</button>`,
		});
		$('.market-act', row).addEventListener('click', () => previewDraft(d));
		$('.item-del', row).addEventListener('click', () => showDialog({
			title: '丢弃这份草稿？', msg: `「${d.name}」会被删除。`, ok: '丢弃', danger: true,
			onOk: async () => { await api('/api/skills/drafts/discard', { id: d.id }); loadSkillDrafts(); },
		}));
		list.appendChild(row);
	});
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
	if (r.ok) { toast('已保存并启用，新对话里就能用了'); loadSkillDrafts(); if (pageStack.includes('page-skills')) loadSkills(); return; }
	if (r.exists) {
		showDialog({ title: '覆盖同名技能？', msg: r.error, ok: '覆盖', danger: true, onOk: () => publishDraft(id, true) });
		return;
	}
	showDialog({ title: '保存失败', msg: r.error || '请重试', ok: '知道了', cancel: '' });
}

/* ---------------- connectors ---------------- */
const AUTH_BADGE = { none: ['connected', '免登录'], oauth: ['needs-auth', '需要授权'], token: ['needs-auth', '需要令牌'] };

function connectorRow(c) {
	const badges = [];
	if (c.source === 'curated' && AUTH_BADGE[c.auth]) badges.push(AUTH_BADGE[c.auth]);
	if (c.type === 'stdio') badges.push(['failed', '本地命令']);
	if (c.added) badges.push(['connected', '已添加']);
	const target = c.type === 'stdio' ? [c.command, ...(c.args || [])].join(' ') : c.url;
	const row = marketRow({ title: c.title, sub: c.description, meta: target, badges, action: actionBtn(c.added ? '已添加' : '添加', c.added, !c.added) });
	if (!c.added) $('.market-act', row).addEventListener('click', () => confirmConnector(c));
	return row;
}

async function loadConnectors() {
	const seq = ++mk.seq;
	const box = $('#market-results');
	box.innerHTML = '';
	box.appendChild(spinner(mk.q ? '正在搜索 MCP 注册表' : ''));
	const r = await getJSON('/api/market/connectors' + (mk.q ? `?q=${encodeURIComponent(mk.q)}` : ''));
	if (seq !== mk.seq) return;
	box.innerHTML = '';
	if (!r.ok) { box.appendChild(emptyMsg('读取失败')); return; }
	if (r.curated.length) {
		box.appendChild(groupLabel('精选'));
		box.appendChild(listOf(r.curated.map(connectorRow)));
	}
	if (mk.q) {
		box.appendChild(groupLabel('MCP 官方注册表'));
		box.appendChild(el('p', 'hint', '由开发者自行发布，被收录不代表安全。'));
		if (r.registryError) box.appendChild(emptyMsg(`搜索失败：${r.registryError}。请检查网络或代理。`));
		else if (r.registry.length) box.appendChild(listOf(r.registry.map(connectorRow)));
		else box.appendChild(emptyMsg('没有找到可以在手机上使用的结果'));
	}
	const foot = $('#market-foot');
	const manage = el('div', 'market-actions', '<button class="pill-btn">管理已添加的连接器，或手动添加</button>');
	$('button', manage).addEventListener('click', () => openPage('page-mcp'));
	foot.appendChild(manage);
	if (!mk.q) foot.appendChild(el('p', 'foot-note', '搜索时还会查询 MCP 官方注册表。你在 Claude 账号里连接的服务会自动出现在「连接器（MCP）」页面。'));
}

function confirmConnector(c) {
	const fields = (c.inputs || []).map((inp) => `<label class="market-field"><span>${esc(inp.label || inp.key)}${inp.required ? '' : '（可选）'}</span><input data-key="${esc(inp.key)}" type="${inp.secret ? 'password' : 'text'}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>`).join('');
	let warn = '';
	if (c.type === 'stdio') {
		warn = `<p class="market-warn">这是一个本地命令，会从网上下载代码并以 root 身份在手机上运行，能访问手机上的所有数据。只添加你信任的作者发布的连接器。</p><pre class="market-pre">${esc([c.command, ...(c.args || [])].join(' '))}</pre>`;
	} else if (c.source !== 'curated') {
		warn = `<p class="market-warn">对话内容里和它相关的数据会发送到这个地址。</p><pre class="market-pre">${esc(c.url)}</pre>`;
	}
	const isPlain = !fields && !warn;
	if (isPlain) { addConnector(c, {}, false); return; }
	showDialog({
		title: `添加「${c.title}」？`, html: true, msg: `${warn}${fields}`, ok: c.type === 'stdio' ? '我了解，添加' : '添加', danger: c.type === 'stdio',
		onOk: () => {
			const values = {};
			$$('#dialog-msg input[data-key]').forEach((i) => { values[i.dataset.key] = i.value; });
			addConnector(c, values, false);
		},
	});
}

async function addConnector(c, values, overwrite) {
	const r = await api('/api/market/connectors/add', { id: c.id, source: c.source, values, confirmed: true, overwrite });
	if (r.exists) {
		showDialog({ title: '替换同名连接器？', msg: r.error, ok: '替换', danger: true, onOk: () => addConnector(c, values, true) });
		return;
	}
	if (!r.ok) { showDialog({ title: '添加失败', msg: r.error || '请重试', ok: '知道了', cancel: '' }); return; }
	if (mk.tab === 'connectors' && pageStack.includes('page-market')) loadConnectors();
	if (c.auth === 'oauth') {
		showDialog({ title: `已添加「${c.title}」`, msg: '它需要你登录对应的账号才能使用。', ok: '现在授权', cancel: '以后再说', onOk: () => authorizeConnector(r.name) });
	} else {
		toast(c.type === 'stdio' ? '已添加，首次使用时会下载' : '已添加');
	}
}

async function authorizeConnector(name) {
	toast('正在准备授权');
	const r = await api('/api/mcp/login', { name });
	if (!r.ok) { showDialog({ title: '授权失败', msg: r.error || '请重试', ok: '知道了', cancel: '' }); return; }
	if (r.fallback === 'chat') {
		// Claude Code 2.1.112 has no `mcp login`; the server exposes an authenticate tool instead.
		closeAll();
		await createNewChat();
		input.value = `请调用 mcp__${name}__authenticate 工具，把授权链接发给我。`;
		send();
	}
}

/* ---------------- plugins ---------------- */
async function loadPlugins(more = false) {
	const seq = ++mk.seq;
	const box = $('#market-results');
	const btn = $('#market-more');
	if (more === true) {
		mk.offset += 40;
		btn.disabled = true;
	} else {
		mk.offset = 0;
		box.innerHTML = '';
		box.appendChild(spinner('第一次打开要下载官方目录，大约需要半分钟'));
		loadMarketplaces();
	}
	const params = new URLSearchParams({ offset: String(mk.offset) });
	if (mk.q) params.set('q', mk.q);
	const r = await getJSON(`/api/market/plugins?${params}`);
	if (seq !== mk.seq) return;
	btn.disabled = false;
	if (more !== true) box.innerHTML = '';
	if (!r.ok) {
		box.appendChild(emptyMsg(`${r.error || '读取失败'}。请检查网络或代理后重试。`));
		return;
	}
	if (!r.items.length && !mk.offset) box.appendChild(emptyMsg('没有符合的插件'));
	else {
		if (!mk.offset) box.appendChild(groupLabel(`共 ${r.total} 个插件`));
		box.appendChild(listOf(r.items.map(pluginRow)));
	}
	btn.classList.toggle('hidden', mk.offset + r.items.length >= r.total);
}

function pluginRow(p) {
	const badges = [p.official ? ['', '官方目录'] : ['needs-auth', '第三方市场']];
	if (p.installed) badges.push(p.enabled ? ['connected', '已启用'] : ['disabled', '未启用']);
	const meta = [p.marketplace, fmtCount(p.installCount)].filter(Boolean).join(' · ');
	const row = marketRow({
		title: p.name, sub: p.description, meta, badges,
		action: p.installed ? actionBtn('管理', false, false) : actionBtn(mk.busy.has(p.id) ? '下载中' : '安装', mk.busy.has(p.id)),
	});
	$('.market-act', row).addEventListener('click', (e) => (p.installed ? managePlugin(p) : confirmPlugin(p, e.currentTarget)));
	return row;
}

function confirmPlugin(p, btn) {
	if (p.official) { downloadPlugin(p, btn); return; }
	showDialog({
		title: '安装第三方插件？',
		msg: `「${p.name}」来自市场 ${p.marketplace}，不在 Anthropic 官方目录里。下载后会先列出它的内容，由你决定是否启用。`,
		ok: '下载并查看', onOk: () => downloadPlugin(p, btn),
	});
}

async function downloadPlugin(p, btn) {
	mk.busy.add(p.id);
	btn.disabled = true;
	btn.textContent = '下载中';
	const r = await api('/api/market/plugins/download', { id: p.id });
	mk.busy.delete(p.id);
	if (!r.ok) {
		btn.disabled = false;
		btn.textContent = '安装';
		showDialog({ title: '下载失败', msg: r.error || '请检查网络后重试', ok: '知道了', cancel: '' });
		return;
	}
	if (mk.tab === 'plugins' && pageStack.includes('page-market')) loadPlugins();
	reviewPlugin(p, r);
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
		html += `<p${c.mcp.some((m) => m.local) ? ' class="market-warn"' : ''}><b>连接器：</b>${c.mcp.some((m) => m.local) ? '其中的本地命令会以 root 身份运行。' : ''}</p>`;
		html += `<pre class="market-pre">${esc(c.mcp.map((m) => `${m.name}: ${m.target}`).join('\n'))}</pre>`;
	}
	if (c.otherCode) html += '<p class="market-warn">它还带有其他可执行内容（命令行工具、语言服务或监视器）。</p>';
	if (c.unreadable) html += '<p class="market-warn">它的部分配置没能读懂，无法确认会运行什么。</p>';
	return html || '<p>没有发现技能、命令或脚本。</p>';
}

function reviewPlugin(p, r) {
	const risky = !r.contents || r.contents.runsCode;
	showDialog({
		title: `启用「${p.name}」？`, html: true, msg: contentsHtml(r.contents),
		ok: risky ? '我了解，启用' : '启用', cancel: '先不启用', danger: risky,
		onOk: () => setPluginEnabled(p, true),
	});
}

async function setPluginEnabled(p, on) {
	const r = await api(`/api/market/plugins/${on ? 'enable' : 'disable'}`, { id: p.id });
	if (!r.ok) { showDialog({ title: '操作失败', msg: r.error || '请重试', ok: '知道了', cancel: '' }); return; }
	toast(on ? '已启用' : '已停用');
	if (mk.tab === 'plugins' && pageStack.includes('page-market')) loadPlugins();
}

async function managePlugin(p) {
	const r = await getJSON(`/api/market/plugins/inspect?id=${encodeURIComponent(p.id)}`);
	if (!r.ok) { showDialog({ title: '读取失败', msg: r.error || '请重试', ok: '知道了', cancel: '' }); return; }
	const uninstall = `<button id="plugin-uninstall" class="pill-btn danger market-uninstall">卸载这个插件</button>`;
	const risky = !r.contents || r.contents.runsCode;
	showDialog({
		title: p.name, html: true, msg: contentsHtml(r.contents) + uninstall,
		ok: r.enabled ? '停用' : (risky ? '我了解，启用' : '启用'), danger: !r.enabled && risky,
		onOk: () => setPluginEnabled(p, !r.enabled),
	});
	$('#plugin-uninstall').addEventListener('click', () => {
		closeLayer('dialog');
		showDialog({
			title: '卸载插件？', msg: `「${p.name}」会被移除。`, ok: '卸载', danger: true,
			onOk: async () => {
				const u = await api('/api/market/plugins/uninstall', { id: p.id });
				if (!u.ok) { showDialog({ title: '卸载失败', msg: u.error || '请重试', ok: '知道了', cancel: '' }); return; }
				toast('已卸载');
				if (mk.tab === 'plugins' && pageStack.includes('page-market')) loadPlugins();
			},
		});
	});
}

async function loadMarketplaces() {
	const foot = $('#market-foot');
	foot.innerHTML = '';
	foot.appendChild(groupLabel('添加其他插件市场'));
	const form = el('div', 'inline-form', '<input id="market-source" type="text" placeholder="https 地址，或 GitHub 的 owner/repo" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="pill-btn accent">添加</button>');
	$('button', form).addEventListener('click', async (e) => {
		const source = $('#market-source').value.trim();
		if (!source) return;
		e.target.disabled = true;
		const r = await api('/api/market/marketplaces/add', { source });
		e.target.disabled = false;
		if (!r.ok) { showDialog({ title: '添加失败', msg: r.error || '请重试', ok: '知道了', cancel: '' }); return; }
		$('#market-source').value = '';
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
		const row = marketRow({ title: m.name, sub: m.url, action: `<button class="item-del" aria-label="移除">${ic('i-trash')}</button>` });
		$('.item-del', row).addEventListener('click', () => showDialog({
			title: '移除这个市场？', msg: `「${m.name}」和从它安装的插件都会被移除。`, ok: '移除', danger: true,
			onOk: async () => {
				const x = await api('/api/market/marketplaces/remove', { name: m.name });
				if (!x.ok) { showDialog({ title: '移除失败', msg: x.error || '请重试', ok: '知道了', cancel: '' }); return; }
				if (mk.tab === 'plugins') loadMarket();
			},
		}));
		return row;
	})));
}

/* ---------------- events from the server ---------------- */
function marketEvent(m) {
	if (m.type === 'plugins_updated') {
		loadSlashCommands();
	} else if (m.type === 'skill_draft') {
		if (pageStack.includes('page-skills')) loadSkillDrafts();
		showDialog({
			title: '技能草稿写好了', msg: `「${m.name}」已经写好，预览后可以保存并启用。`, ok: '查看', cancel: '稍后',
			onOk: () => openPage('page-skills'),
		});
	} else if (m.type === 'mcp_login_url') {
		if (!/^https:\/\//.test(m.url || '')) return;
		showDialog({
			title: `授权「${m.name}」`, html: true,
			msg: `<p>打开下面的页面并允许访问，完成后回到这里。</p><p><a class="pill-btn accent market-link" href="${esc(m.url)}" target="_blank" rel="noopener">打开授权页面</a></p>`,
			ok: '关闭', cancel: '',
		});
	} else if (m.type === 'mcp_login_done') {
		if (m.ok) toast(`「${m.name}」授权成功`);
		else showDialog({ title: '授权没有完成', msg: m.message || '请重试', ok: '知道了', cancel: '' });
	}
}
