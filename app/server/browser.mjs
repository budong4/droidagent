// The built-in browser: a real Chromium in the phone's Linux environment, driven over the
// DevTools protocol. The agents use it through the browser_* tools (agent_tools.mjs); the owner
// watches it live in the app (an MJPEG stream of its screen) and can tap, type and navigate.
//
// One browser for the whole app, started when first needed and stopped after a while unused.
// It looks like a phone: a narrow viewport, touch, a mobile user agent, so pages lay out the way
// the owner would see them.
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';

export const VIEW = { width: 412, height: 860, scale: 2 };
const UA = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

// What a page holds, as the agent reads it: title, address, text, and numbered things to act on.
// Runs in the page; numbers are kept on the elements (data-da-ref) for click and type.
export const READ_SCRIPT = `(() => {
	const MAX = window.__daFull ? 20000 : 6000;
	const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'; };
	document.querySelectorAll('[data-da-ref]').forEach((e) => e.removeAttribute('data-da-ref'));
	const items = [];
	let n = 0;
	for (const e of document.querySelectorAll('a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [contenteditable=true], summary')) {
		if (!vis(e) || n >= 150) continue;
		n++;
		e.setAttribute('data-da-ref', String(n));
		const tag = e.tagName.toLowerCase();
		const kind = tag === 'a' || e.getAttribute('role') === 'link' ? '链接' : tag === 'input' || tag === 'textarea' || e.isContentEditable ? '输入框' : tag === 'select' ? '下拉框' : '按钮';
		const label = (e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('title') || e.getAttribute('name') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
		const extra = tag === 'a' && e.href ? ' → ' + e.href.slice(0, 120) : tag === 'input' ? ' (' + (e.type || 'text') + (e.value ? ', 已填: ' + String(e.value).slice(0, 30) : '') + ')' : '';
		items.push('[' + n + '] ' + kind + ' ' + (label || '(无文字)') + extra);
	}
	const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
	return JSON.stringify({ title: document.title, url: location.href, text: text.slice(0, MAX), more: text.length > MAX, items });
})()`;

// The element a click or type means: a number from the last read, or else visible text.
const FIND_SCRIPT = (ref, text) => `(() => {
	let e = ${ref != null ? `document.querySelector('[data-da-ref="${Number(ref)}"]')` : 'null'};
	const want = ${JSON.stringify(String(text || '').trim().toLowerCase())};
	if (!e && want) {
		const all = [...document.querySelectorAll('a, button, input, textarea, select, [role=button], [role=link], [role=tab], summary, label, [onclick]')];
		const label = (x) => (x.innerText || x.value || x.getAttribute('aria-label') || x.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().toLowerCase();
		e = all.find((x) => label(x) === want) || all.find((x) => label(x).includes(want));
	}
	if (!e) return JSON.stringify({ found: false });
	e.scrollIntoView({ block: 'center', inline: 'center' });
	const r = e.getBoundingClientRect();
	return JSON.stringify({ found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, tag: e.tagName.toLowerCase(), label: (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().slice(0, 60) });
})()`;

const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createBrowser({ log, profileDir, onState = () => {}, findChromium, install }) {
	let proc = null;
	let ws = null;
	let nextId = 1;
	const calls = new Map();
	const waiters = new Set(); // (method, params) => boolean: true when it was what they waited for
	let starting = null;
	let state = { running: false, url: '', title: '', loading: false };
	let lastUse = 0;
	const viewers = new Set(); // MJPEG responses
	let lastFrame = null;
	let casting = false;

	const setState = (patch) => { state = { ...state, ...patch }; onState(state); };
	function send(method, params = {}) {
		return new Promise((resolve, reject) => {
			if (!ws || ws.readyState !== 1) return reject(new Error('浏览器没有在运行'));
			const id = nextId++;
			const t = setTimeout(() => { calls.delete(id); reject(new Error(`浏览器没有回应（${method}）`)); }, 30000);
			calls.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
			ws.send(JSON.stringify({ id, method, params }));
		});
	}
	const waitFor = (match, ms) => new Promise((resolve) => {
		const w = (method, params) => { if (match(method, params)) { waiters.delete(w); clearTimeout(t); resolve(true); return true; } return false; };
		const t = setTimeout(() => { waiters.delete(w); resolve(false); }, ms);
		waiters.add(w);
	});
	function onMessage(raw) {
		let m;
		try { m = JSON.parse(raw); } catch { return; }
		if (m.id && calls.has(m.id)) {
			const c = calls.get(m.id);
			calls.delete(m.id);
			if (m.error) c.reject(new Error(m.error.message || 'CDP error')); else c.resolve(m.result);
			return;
		}
		if (!m.method) return;
		for (const w of [...waiters]) w(m.method, m.params);
		if (m.method === 'Page.screencastFrame') {
			send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
			lastFrame = Buffer.from(m.params.data, 'base64');
			for (const res of viewers) writeFrame(res, lastFrame);
		} else if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) {
			setState({ url: m.params.frame.url });
			refreshTitle();
		} else if (m.method === 'Page.frameStartedLoading') setState({ loading: true });
		else if (m.method === 'Page.frameStoppedLoading' || m.method === 'Page.loadEventFired') { setState({ loading: false }); refreshTitle(); }
	}
	async function refreshTitle() {
		try { const r = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }); setState({ title: String(r.result.value || '') }); } catch { /* navigating */ }
	}

	async function start() {
		if (ws && ws.readyState === 1) return;
		if (starting) return starting;
		starting = (async () => {
			let bin = findChromium();
			if (!bin) {
				setState({ installing: true });
				try { await install(); } finally { setState({ installing: false }); }
				bin = findChromium();
				if (!bin) throw new Error('没能装上 Chromium，内置浏览器用不了');
			}
			await mkdir(profileDir, { recursive: true });
			// A browser left by a server that died holds this profile's lock: it goes first.
			await new Promise((r) => execFile('pkill', ['-f', `--user-data-dir=${profileDir}`], () => r()));
			await rm(join(profileDir, 'SingletonLock'), { force: true }).catch(() => {});
			const port = await freePort();
			proc = spawn(bin, [
				'--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
				'--mute-audio', '--hide-scrollbars', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
				`--user-data-dir=${profileDir}`, `--window-size=${VIEW.width},${VIEW.height}`, `--user-agent=${UA}`, '--lang=zh-CN', 'about:blank',
			], { stdio: ['ignore', 'ignore', 'pipe'] });
			let err = '';
			proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
			const me = proc;
			proc.on('exit', (code) => {
				if (proc === me) { proc = null; ws = null; casting = false; setState({ running: false, loading: false }); log('[browser] exited', code); }
			});
			// Its page's debugging address, once it answers.
			let target = null;
			for (let i = 0; i < 100 && !target; i++) {
				await sleep(150);
				if (!proc) throw new Error(`浏览器启动失败：${err.trim().split('\n').pop() || '没有输出'}`);
				try {
					const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
					target = list.find((t) => t.type === 'page');
				} catch { /* not yet */ }
			}
			if (!target) throw new Error('浏览器启动后没有回应');
			ws = new WebSocket(target.webSocketDebuggerUrl);
			await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('连不上浏览器')); });
			ws.onmessage = (e) => onMessage(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString());
			ws.onclose = () => { ws = null; casting = false; };
			await send('Page.enable');
			await send('Runtime.enable');
			await send('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: VIEW.scale, mobile: true });
			await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }).catch(() => {});
			setState({ running: true });
			log('[browser] started', bin);
			if (viewers.size) await startCast();
		})().finally(() => { starting = null; });
		return starting;
	}
	function stop() {
		try { proc?.kill('SIGTERM'); } catch { /* gone */ }
		proc = null; ws = null; casting = false;
		setState({ running: false, loading: false });
	}
	// Let go of it after a while with nothing done and nobody watching.
	const IDLE = Number(process.env.AGENT_BROWSER_IDLE_MS) || 15 * 60 * 1000;
	setInterval(() => { if (proc && !viewers.size && Date.now() - lastUse > IDLE) { log('[browser] idle, stopping'); stop(); } }, 60000).unref();

	async function startCast() {
		if (casting || !ws) return;
		casting = true;
		await send('Page.startScreencast', { format: 'jpeg', quality: 62, maxWidth: VIEW.width * VIEW.scale, maxHeight: VIEW.height * VIEW.scale, everyNthFrame: 1 }).catch(() => { casting = false; });
	}
	async function stopCast() {
		if (!casting || !ws) return;
		casting = false;
		await send('Page.stopScreencast').catch(() => {});
	}
	function writeFrame(res, buf) {
		try { res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`); res.write(buf); res.write('\r\n'); } catch { /* gone */ }
	}

	const evaluate = async (expression) => {
		const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || '页面脚本出错');
		return r.result.value;
	};
	const settle = async (ms = 1200) => { await waitFor((m) => m === 'Page.loadEventFired', ms); await sleep(250); };
	async function readPage(full = false) {
		const v = JSON.parse(await evaluate(`window.__daFull = ${full ? 'true' : 'false'}; ${READ_SCRIPT}`));
		setState({ url: v.url, title: v.title });
		return v;
	}
	const pageText = (v, full) => `标题：${v.title || '（无标题）'}\n网址：${v.url}\n\n${v.text || '（页面没有文字）'}${v.more ? `\n…（还有更多文字${full ? '' : '，可以用 browser_read 并设 full 读取更多'}）` : ''}${v.items.length ? `\n\n可操作的元素：\n${v.items.join('\n')}` : ''}`;
	async function tap(x, y) {
		for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
	}

	// ---- the agents' tools: { ok, text, image? }
	async function tool(name, a = {}) {
		lastUse = Date.now();
		await start();
		switch (name) {
			case 'browser_open': {
				let url = String(a.url || '').trim();
				if (!url) return { ok: false, text: '没有给出网址' };
				if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
				if (!/^https?:/i.test(url)) return { ok: false, text: '只能打开 http 或 https 网址' };
				const loaded = waitFor((m) => m === 'Page.loadEventFired', 25000);
				const r = await send('Page.navigate', { url });
				if (r.errorText) return { ok: false, text: `打不开这个网址：${r.errorText}` };
				await loaded;
				await sleep(400);
				const v = await readPage();
				return { ok: true, text: pageText({ ...v, items: v.items.slice(0, 40) }) };
			}
			case 'browser_read': {
				const v = await readPage(!!a.full);
				return { ok: true, text: pageText(v, !!a.full) };
			}
			case 'browser_click': {
				const f = JSON.parse(await evaluate(FIND_SCRIPT(a.ref ?? null, a.text)));
				if (!f.found) return { ok: false, text: '找不到这个元素，先用 browser_read 看看页面上有什么' };
				await sleep(150);
				await tap(f.x, f.y);
				await settle();
				const v = await readPage();
				return { ok: true, text: `已点击${f.label ? `「${f.label}」` : ''}。\n\n${pageText({ ...v, items: v.items.slice(0, 40) })}` };
			}
			case 'browser_type': {
				const f = a.ref != null ? JSON.parse(await evaluate(FIND_SCRIPT(a.ref, null))) : { found: true };
				if (!f.found) return { ok: false, text: '找不到这个输入框，先用 browser_read 看看页面上有什么' };
				if (a.ref != null) { await tap(f.x, f.y); await evaluate(`(() => { const e = document.querySelector('[data-da-ref="${Number(a.ref)}"]'); if (e) { e.focus(); if (e.select) e.select(); } })()`); }
				await send('Input.insertText', { text: String(a.text ?? '') });
				if (a.submit) {
					for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : undefined });
					await settle(4000);
				}
				return { ok: true, text: `已输入${a.submit ? '并提交' : ''}。当前页面：${state.title || state.url}` };
			}
			case 'browser_scroll': {
				await evaluate(`window.scrollBy(0, ${a.direction === 'up' ? -1 : 1} * window.innerHeight * 0.8)`);
				await sleep(300);
				const v = await readPage();
				return { ok: true, text: `已滚动。\n\n${pageText({ ...v, items: v.items.slice(0, 40) })}` };
			}
			case 'browser_back': {
				await evaluate('history.back()');
				await settle(5000);
				return { ok: true, text: `已返回：${state.title || state.url}` };
			}
			case 'browser_screenshot': {
				const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
				return { ok: true, text: `当前页面：${state.title || state.url}`, image: r.data, mimeType: 'image/jpeg' };
			}
			default: return { ok: false, text: `没有这个浏览器操作：${name}` };
		}
	}

	// ---- the owner, from the browser page in the app
	async function input(a = {}) {
		lastUse = Date.now();
		await start();
		if (a.type === 'tap') return tap(Math.round(Number(a.x) * VIEW.width), Math.round(Number(a.y) * VIEW.height));
		if (a.type === 'text') return send('Input.insertText', { text: String(a.text || '') });
		if (a.type === 'key') {
			const keys = { Enter: [13, '\r'], Backspace: [8, ''], Tab: [9, ''] };
			const k = keys[a.key];
			if (!k) return;
			for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: a.key, code: a.key, windowsVirtualKeyCode: k[0], ...(type === 'keyDown' && k[1] ? { text: k[1] } : {}) });
			return;
		}
		if (a.type === 'scroll') return evaluate(`window.scrollBy(0, ${Number(a.dy) || 0})`);
		if (a.type === 'navigate') return tool('browser_open', { url: a.url });
		if (a.type === 'back') return evaluate('history.back()');
		if (a.type === 'forward') return evaluate('history.forward()');
		if (a.type === 'reload') return send('Page.reload');
	}

	// MJPEG to the app: the latest frame at once, then each new one.
	async function watch(res) {
		res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame', 'cache-control': 'no-store', connection: 'close' });
		viewers.add(res);
		res.on('close', () => { viewers.delete(res); if (!viewers.size) stopCast(); });
		if (lastFrame) writeFrame(res, lastFrame);
		if (ws) await startCast();
	}

	return { start, stop, tool, input, watch, state: () => state, findChromium };
}

// Where Chromium is, if it is installed.
export function chromiumPath() {
	const c = [process.env.AGENT_CHROMIUM, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/lib/chromium/chromium', '/usr/bin/google-chrome'];
	return c.find((p) => p && existsSync(p)) || null;
}
// Debian's Chromium, installed on first use (it is not in the base system).
export function aptInstallChromium(log) {
	return new Promise((resolve, reject) => {
		log('[browser] installing chromium');
		const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
		execFile('bash', ['-lc', 'apt-get update -qq && apt-get install -y -qq --no-install-recommends chromium fonts-noto-cjk'], { env, timeout: 20 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) => {
			if (err) return reject(new Error(`安装 Chromium 失败：${String(errOut || err.message).trim().split('\n').pop()}`));
			resolve();
		});
	});
}
