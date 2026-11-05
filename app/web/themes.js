'use strict';
/* DroidAgent looks: themes, fonts and the chat background.
   Loaded in <head>, before the page paints, so a saved look applies without a flash.
   Colours live in style.css as [data-theme] token sets; this file holds what the picker shows
   and the illustrations, which are original vector drawings (nothing copied from any show). */
(function () {
	const THEMES = [
		{ id: 'default', name: '电路板', group: 'solid', scheme: 'auto', note: '跟随系统深浅色' },
		{ id: 'paper', name: '纸白', group: 'solid', scheme: 'light' },
		{ id: 'mist', name: '雾蓝', group: 'solid', scheme: 'light' },
		{ id: 'matcha', name: '抹茶', group: 'solid', scheme: 'light' },
		{ id: 'graphite', name: '石墨', group: 'solid', scheme: 'dark' },
		{ id: 'dusk', name: '暮紫', group: 'solid', scheme: 'dark' },
		{ id: 'sakura', name: '樱花', group: 'art', scheme: 'light' },
		{ id: 'summer', name: '盛夏', group: 'art', scheme: 'light' },
		{ id: 'wafu', name: '和风', group: 'art', scheme: 'light' },
		{ id: 'starry', name: '星夜', group: 'art', scheme: 'dark' },
		{ id: 'neon', name: '霓虹', group: 'art', scheme: 'dark' },
	];
	const THEME_BAR = { // status-bar colour, matched to each theme's background
		paper: '#FCFCFD', mist: '#EEF2F5', matcha: '#F2F4EC', graphite: '#161718', dusk: '#16131D',
		sakura: '#FBF6F7', summer: '#F3F8FB', wafu: '#F4EFE4', starry: '#0E1426', neon: '#110F18',
	};

	// Chat backgrounds that ship with the app. Original drawings, or public domain / CC0 (see
	// tools/background_photos.py for where each came from).
	const PRESETS = [
		{ id: 'anime-summer', name: '夏空', group: '动漫风', file: 'anime-summer.svg' },
		{ id: 'anime-dusk', name: '黄昏电车', group: '动漫风', file: 'anime-dusk.svg' },
		{ id: 'anime-stars', name: '星降之丘', group: '动漫风', file: 'anime-stars.svg' },
		{ id: 'ukiyoe-plum', name: '蒲田梅园', group: '浮世绘', file: 'ukiyoe-plum.jpg' },
		{ id: 'ukiyoe-shower', name: '大桥骤雨', group: '浮世绘', file: 'ukiyoe-shower.jpg' },
		{ id: 'ukiyoe-fireworks', name: '两国烟火', group: '浮世绘', file: 'ukiyoe-fireworks.jpg' },
		{ id: 'ukiyoe-maples', name: '真间红叶', group: '浮世绘', file: 'ukiyoe-maples.jpg' },
		{ id: 'ukiyoe-snow', name: '浅草雪景', group: '浮世绘', file: 'ukiyoe-snow.jpg' },
		{ id: 'vangogh-cypresses', name: '柏树', group: '风景与名画', file: 'vangogh-cypresses.jpg' },
		{ id: 'vangogh-wheat', name: '麦田与柏树', group: '风景与名画', file: 'vangogh-wheat.jpg' },
		{ id: 'aurora-red', name: '极光', group: '风景与名画', file: 'aurora-red.jpg' },
		{ id: 'aurora-city', name: '极光与灯火', group: '风景与名画', file: 'aurora-city.jpg' },
		{ id: 'mesh-peach', name: '蜜桃', group: '渐变', file: 'mesh-peach.svg' },
		{ id: 'mesh-aurora', name: '极夜', group: '渐变', file: 'mesh-aurora.svg' },
	];
	const presetThumb = (p) => 'backgrounds/' + (p.file.endsWith('.svg') ? p.file : 'thumbs/' + p.file);

	// Open-source fonts (SIL OFL / MIT). The server fetches each one slice by slice on first use.
	const FONTS = [
		{ id: 'system', name: '系统默认', family: '' },
		{ id: 'lxgw-wenkai', name: '霞鹜文楷', family: 'LXGW WenKai Screen', css: 'lxgwwenkaigbscreen.css', note: '温和的楷体，长文好读' },
		{ id: 'noto-serif', name: '思源宋体', family: 'Noto Serif SC', css: '400.css', note: '端正的宋体' },
		{ id: 'zcool-xiaowei', name: '站酷小薇', family: 'ZCOOL XiaoWei', css: 'index.css', note: '清秀的标题宋' },
		{ id: 'zcool-kuaile', name: '站酷快乐体', family: 'ZCOOL KuaiLe', css: 'index.css', note: '圆润活泼' },
		{ id: 'qingke', name: '庆科黄油体', family: 'ZCOOL QingKe HuangYou', css: 'index.css', note: '方正有力的美术字' },
		{ id: 'ma-shan-zheng', name: '马善政楷书', family: 'Ma Shan Zheng', css: 'index.css', note: '毛笔书法' },
	];
	const SYSTEM_STACK = 'system-ui, -apple-system, "MiSans", "HarmonyOS Sans SC", "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif';

	/* ---------------- illustrations ---------------- */
	// Each returns markup for an .art-layer; `u` keeps SVG ids unique when a theme is drawn twice
	// (the live background and its preview card).
	function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

	function sakura(u) {
		const petal = 'M0 0C-7-5-9-14-4.5-20L0-16.5 4.5-20C9-14 7-5 0 0Z';
		const flower = (x, y, s, r, tone) => `<g transform="translate(${x} ${y}) rotate(${r}) scale(${s})"><use href="#skf${tone}-${u}"/></g>`;
		const def = (tone, fill, edge) => `<symbol id="skf${tone}-${u}" overflow="visible">${[0, 72, 144, 216, 288].map((a) => `<path d="${petal}" transform="rotate(${a})" fill="${fill}" stroke="${edge}" stroke-width=".7"/>`).join('')}<circle r="3.4" fill="#E59AAE"/>${[0, 60, 120, 180, 240, 300].map((a) => `<circle cx="${(6.2 * Math.cos(a * Math.PI / 180)).toFixed(1)}" cy="${(6.2 * Math.sin(a * Math.PI / 180)).toFixed(1)}" r="1" fill="#D27F97"/>`).join('')}</symbol>`;
		const bud = (x, y, r) => `<ellipse cx="${x}" cy="${y}" rx="3.2" ry="5" transform="rotate(${r} ${x} ${y})" fill="#EFB3C3"/>`;
		return `<svg class="art-tr art-sakura" viewBox="0 0 320 240" aria-hidden="true"><defs>${def('a', '#F8D9E0', '#EDB9C6')}${def('b', '#F3C9D3', '#E6A9B9')}</defs>
<g fill="none" stroke="#8E6E72" stroke-linecap="round"><path d="M335 6C290 24 250 40 215 64" stroke-width="7"/><path d="M215 64C180 88 150 116 112 138" stroke-width="5"/><path d="M112 138C92 150 74 160 52 166" stroke-width="3"/><path d="M240 48C236 70 238 92 248 110" stroke-width="3"/><path d="M170 98C160 80 150 70 132 64" stroke-width="2.4"/><path d="M120 134C118 152 124 170 134 184" stroke-width="2"/></g>
${bud(60, 160, 60)}${bud(292, 22, -30)}${bud(146, 70, -60)}${bud(230, 58, 20)}
${flower(250, 112, 1.1, 10, 'a')}${flower(206, 72, .9, 40, 'b')}${flower(132, 62, .8, 0, 'a')}${flower(138, 188, .85, 25, 'b')}${flower(52, 168, .7, 50, 'a')}${flower(284, 34, .95, 15, 'b')}${flower(176, 106, .72, 60, 'a')}${flower(95, 148, .6, 30, 'b')}</svg>`;
	}

	function starry(u) {
		const r = rng(7);
		let stars = '';
		for (let i = 0; i < 120; i++) {
			const x = (r() * 400).toFixed(1), y = (Math.pow(r(), 1.5) * 760).toFixed(1);
			const rad = (0.35 + r() * 0.95).toFixed(2), o = (0.25 + r() * 0.65).toFixed(2);
			stars += `<circle cx="${x}" cy="${y}" r="${rad}" opacity="${o}"${i % 9 === 0 ? ` class="tw" style="animation-delay:${(r() * 5).toFixed(1)}s"` : ''}/>`;
		}
		const spark = (x, y, s) => `<path transform="translate(${x} ${y}) scale(${s})" d="M0-6C.6-1.2 1.2-.6 6 0 1.2.6.6 1.2 0 6-.6 1.2-1.2.6-6 0-1.2-.6-.6-1.2 0-6Z" fill="#F4ECD2"/>`;
		return `<svg class="art-full" viewBox="0 0 400 860" preserveAspectRatio="xMidYMin slice" aria-hidden="true"><defs>
<linearGradient id="sky-${u}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1C2750"/><stop offset=".5" stop-color="#0E1426" stop-opacity="0"/></linearGradient>
<radialGradient id="glow-${u}"><stop offset="0" stop-color="#F2C46D" stop-opacity=".22"/><stop offset="1" stop-color="#F2C46D" stop-opacity="0"/></radialGradient>
<mask id="moon-${u}"><rect width="400" height="860" fill="#fff"/><circle cx="331" cy="108" r="21" fill="#000"/></mask>
<filter id="blur-${u}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="16"/></filter>
<linearGradient id="meteor-${u}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".9"/></linearGradient></defs>
<rect width="400" height="860" fill="url(#sky-${u})"/>
<ellipse cx="190" cy="280" rx="260" ry="40" transform="rotate(-28 190 280)" fill="#93A6DD" opacity=".09" filter="url(#blur-${u})"/>
<g fill="#E9EEFF">${stars}</g>${spark(70, 126, 1)}${spark(286, 312, .8)}${spark(152, 46, .7)}
<circle cx="318" cy="118" r="70" fill="url(#glow-${u})"/><circle cx="318" cy="118" r="24" fill="#F3E6C4" opacity=".8" mask="url(#moon-${u})"/>
<path class="meteor" d="M80 200L150 166" stroke="url(#meteor-${u})" stroke-width="1.4" stroke-linecap="round"/></svg>
<svg class="art-bottom" viewBox="0 0 400 150" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><path d="M0 92L40 70 78 84 120 52 168 80 214 60 262 86 300 66 344 82 400 58V150H0Z" fill="#17203E"/><path d="M0 118L52 98 96 112 150 90 196 110 250 96 300 116 352 100 400 112V150H0Z" fill="#0A0F1E"/><circle cx="270" cy="104" r="1.6" fill="#F2C46D" opacity=".85"/></svg>`;
	}

	function summer(u) {
		const cloud = (cs, fill) => cs.map(([x, y, rr]) => `<circle cx="${x}" cy="${y}" r="${rr}" fill="${fill}"/>`).join('');
		const c1 = [[40, 214, 40], [88, 184, 54], [146, 204, 44], [108, 230, 40], [58, 240, 30], [176, 228, 30]];
		const c2 = [[292, 92, 20], [322, 76, 28], [354, 94, 22]];
		const shade = (cs) => cs.map(([x, y, rr]) => [x + 5, y + 7, rr]);
		return `<svg class="art-top" viewBox="0 0 400 380" preserveAspectRatio="xMidYMin slice" aria-hidden="true"><defs>
<linearGradient id="sum-${u}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#B9DDF1"/><stop offset="1" stop-color="#F3F8FB" stop-opacity="0"/></linearGradient>
<radialGradient id="sun-${u}" cx=".12" cy=".08" r=".5"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
<rect width="400" height="380" fill="url(#sum-${u})"/><rect width="400" height="380" fill="url(#sun-${u})"/>
${cloud(shade(c1), '#D5E7F2')}${cloud(c1, '#FFFFFF')}${cloud(shade(c2), '#D5E7F2')}${cloud(c2, '#FFFFFF')}
<g stroke="#7F96A6" fill="none" opacity=".55"><path d="M330 74Q200 132-10 104" stroke-width="1"/><path d="M382 74Q260 150-10 140" stroke-width="1"/><path d="M334 98Q210 156-10 170" stroke-width=".9"/></g>
<g fill="#7F96A6" opacity=".6"><rect x="352" y="36" width="6" height="360"/><rect x="326" y="70" width="58" height="4" rx="1.5"/><rect x="332" y="94" width="46" height="3.5" rx="1.5"/><circle cx="330" cy="68" r="2.4"/><circle cx="382" cy="68" r="2.4"/><circle cx="334" cy="92" r="2.2"/></g>
<g fill="none" stroke="#6E8696" stroke-width="1.3" stroke-linecap="round" opacity=".55"><path d="M220 54l5 4 5-4"/><path d="M240 70l4 3 4-3"/></g></svg>`;
	}

	function wafu(u) {
		const p = `sei-${u}`;
		const ring = (cx, cy) => [19, 14.5, 10, 5.5].map((rr, i) => `<circle cx="${cx}" cy="${cy}" r="${rr}" fill="${i % 2 ? '#F4EFE4' : '#EEE6D5'}" stroke="#2E4A6B" stroke-opacity=".28" stroke-width=".9"/>`).join('');
		return `<svg class="art-tr art-wafu" viewBox="0 0 220 190" aria-hidden="true"><circle cx="142" cy="78" r="50" fill="#C8553D" opacity=".82"/>
<g fill="#E8DEC8"><rect x="30" y="96" width="210" height="13" rx="6.5"/><rect x="92" y="122" width="150" height="11" rx="5.5"/><rect x="60" y="40" width="96" height="9" rx="4.5"/></g></svg>
<svg class="art-bottom" viewBox="0 0 400 130" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><defs>
<pattern id="${p}" width="40" height="20" patternUnits="userSpaceOnUse">${ring(0, 0)}${ring(40, 0)}${ring(20, 10)}${ring(0, 20)}${ring(40, 20)}</pattern>
<linearGradient id="fade-${u}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".7" stop-color="#fff"/></linearGradient>
<mask id="m-${u}"><rect width="400" height="130" fill="url(#fade-${u})"/></mask></defs>
<rect width="400" height="130" fill="url(#${p})" mask="url(#m-${u})"/></svg>`;
	}

	function neon(u) {
		const r = rng(3);
		let city = '', win = '';
		let x = 0;
		while (x < 400) {
			const w = 18 + Math.floor(r() * 26), h = 30 + Math.floor(r() * 70);
			city += `<rect x="${x}" y="${232 - h}" width="${w}" height="${h}"/>`;
			for (let wy = 232 - h + 6; wy < 226; wy += 8) for (let wx = x + 4; wx < x + w - 4; wx += 6) if (r() < 0.16) win += `<rect x="${wx}" y="${wy}" width="2.4" height="3" fill="${r() < 0.5 ? '#7FCFD9' : '#E08FC8'}"/>`;
			x += w + 2;
		}
		let grid = '';
		for (let i = 0; i < 8; i++) { const y = 232 + Math.pow(i / 7, 1.8) * 68; grid += `<path d="M0 ${y.toFixed(1)}H400"/>`; }
		for (let i = -10; i <= 10; i++) grid += `<path d="M200 232L${200 + i * 60} 300"/>`;
		return `<svg class="art-bottom art-neon" viewBox="0 0 400 300" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><defs>
<linearGradient id="ns-${u}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F2B5A0"/><stop offset="1" stop-color="#E08FC8"/></linearGradient>
<mask id="nm-${u}"><rect width="400" height="300" fill="#fff"/>${[0, 1, 2, 3, 4].map((i) => `<rect x="0" y="${168 + i * 13}" width="400" height="${2 + i * 1.6}" fill="#000"/>`).join('')}</mask></defs>
<circle cx="200" cy="170" r="74" fill="url(#ns-${u})" opacity=".38" mask="url(#nm-${u})"/>
<g fill="#1C1829">${city}</g><g opacity=".7">${win}</g>
<g stroke="#E08FC8" stroke-opacity=".2" stroke-width="1" fill="none">${grid}</g><path d="M0 232H400" stroke="#E08FC8" stroke-opacity=".55"/></svg>`;
	}

	const ART = { sakura, starry, summer, wafu, neon };
	let artSeq = 0;
	function renderArt(container, themeId, { mini = false } = {}) {
		const f = ART[themeId];
		container.innerHTML = f ? f(`${themeId}${++artSeq}`) : '';
		if (!mini && themeId === 'sakura' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
			// A few petals drifting down behind the conversation.
			const r = rng(11);
			for (let i = 0; i < 7; i++) {
				const p = document.createElement('i');
				p.className = 'petal';
				p.style.left = (r() * 100).toFixed(1) + '%';
				p.style.setProperty('--dx', ((r() - 0.3) * 120).toFixed(0) + 'px');
				p.style.animationDuration = (11 + r() * 9).toFixed(1) + 's';
				p.style.animationDelay = (-r() * 18).toFixed(1) + 's';
				p.style.transform = `scale(${(0.7 + r() * 0.6).toFixed(2)})`;
				container.appendChild(p);
			}
		}
	}

	/* ---------------- applying a look ---------------- */
	// wall: '' = the theme's own art, 'custom' = the owner's picture (version in bg), else a preset id
	const DEFAULT_LOOK = { theme: 'default', font: 'system', wall: '', bg: 0, dim: 60 };
	function load() {
		let l = {};
		try { l = JSON.parse(localStorage.getItem('look') || '{}') || {}; } catch (e) { /* private mode */ }
		if (!('wall' in l) && l.bg) l.wall = 'custom'; // saved before presets existed
		const look = Object.assign({}, DEFAULT_LOOK, l);
		if (look.wall && look.wall !== 'custom' && !PRESETS.some((p) => p.id === look.wall)) look.wall = '';
		if (look.wall === 'custom' && !look.bg) look.wall = '';
		if (!THEMES.some((t) => t.id === look.theme)) look.theme = 'default';
		if (!FONTS.some((f) => f.id === look.font)) look.font = 'system';
		return look;
	}
	function save(look) { try { localStorage.setItem('look', JSON.stringify(look)); } catch (e) { /* */ } }
	function systemDark() {
		try { if (window.AgentHost && typeof AgentHost.isNight === 'function') return !!AgentHost.isNight(); } catch (e) { /* bridge gone */ }
		return matchMedia('(prefers-color-scheme: dark)').matches;
	}
	function schemeOf(themeId) {
		const t = THEMES.find((x) => x.id === themeId) || THEMES[0];
		return t.scheme === 'auto' ? (systemDark() ? 'dark' : 'light') : t.scheme;
	}
	function fontLink(f) {
		if (!f.css) return;
		const href = `/fonts/${f.id}/${f.css}`;
		if (document.querySelector(`link[data-font="${f.id}"]`)) return;
		const l = document.createElement('link');
		l.rel = 'stylesheet'; l.href = href; l.dataset.font = f.id;
		document.head.appendChild(l);
	}
	function apply(look) {
		const d = document.documentElement;
		const scheme = schemeOf(look.theme);
		d.setAttribute('data-theme', look.theme);
		d.setAttribute('data-scheme', scheme);
		d.classList.toggle('has-bg', !!look.wall);
		d.style.setProperty('--bg-dim', (look.dim ?? 55) + '%');
		const f = FONTS.find((x) => x.id === look.font) || FONTS[0];
		fontLink(f);
		d.style.setProperty('--font-ui', f.family ? `"${f.family}", ${SYSTEM_STACK}` : SYSTEM_STACK);
		const meta = document.querySelector('meta[name="theme-color"]');
		if (meta) meta.setAttribute('content', THEME_BAR[look.theme] || (scheme === 'dark' ? '#0D1411' : '#F5F6F2'));
	}

	// The picture behind the conversation for a look, or '' for the theme's own art.
	function wallUrl(look) {
		if (look.wall === 'custom') return look.bg ? `/api/background?v=${look.bg}` : '';
		const p = PRESETS.find((x) => x.id === look.wall);
		return p ? 'backgrounds/' + p.file : '';
	}

	window.DA_LOOK = { THEMES, FONTS, PRESETS, SYSTEM_STACK, load, save, apply, renderArt, schemeOf, fontLink, wallUrl, presetThumb };
	apply(load());
})();
