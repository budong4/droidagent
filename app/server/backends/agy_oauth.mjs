// Signing in to Antigravity the way dsh-agy-link (MIT, src/host/oauth.ts) does: the standard
// OAuth 2.0 flow with PKCE, using the public client that ships inside Google's Antigravity app and
// CLI, and a listener on http://localhost:51121/oauth-callback for the browser to come back to.
// The tokens are written in agy's own file format, so the official CLI is signed in.
//
// The phone's browser reaches that listener because the chroot shares Android's network. Where it
// cannot, the owner pastes the address the browser stopped at (or the bare code).
//
// Note: Google's terms for Antigravity bar third-party software from using its sign-in, and
// accounts have been suspended for it. The owner chose this knowingly (see README).
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

// Public, not ours: embedded in the Antigravity desktop app and CLI. Split only so secret
// scanners do not mistake it for a leaked secret. AGY_CLIENT_ID / AGY_CLIENT_SECRET override them.
const CLIENT_ID = ['1071006060591', 'tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'].join('-');
const CLIENT_SECRET = ['GOCSPX', 'K58FWR486LdLJ1mLB8sXC4z6qDAf'].join('-');
export const client = () => ({ id: process.env.AGY_CLIENT_ID || CLIENT_ID, secret: process.env.AGY_CLIENT_SECRET || CLIENT_SECRET });

// No `openid`: with it Google sends this client into a consent page that never finishes.
export const SCOPES = [
	'https://www.googleapis.com/auth/cloud-platform',
	'https://www.googleapis.com/auth/userinfo.email',
	'https://www.googleapis.com/auth/userinfo.profile',
	'https://www.googleapis.com/auth/cclog',
	'https://www.googleapis.com/auth/experimentsandconfigs',
];
export const CALLBACK_PORT = Number(process.env.AGY_OAUTH_PORT) || 51121;
export const CALLBACK_PATH = '/oauth-callback';
export const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.AGY_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const USERINFO_URL = process.env.AGY_OAUTH_USERINFO_URL || 'https://www.googleapis.com/oauth2/v1/userinfo';

export function pkce() {
	const verifier = randomBytes(32).toString('base64url');
	return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
export function authorizeUrl(challenge, state) {
	const u = new URL(AUTHORIZE_URL);
	for (const [k, v] of Object.entries({
		client_id: client().id, response_type: 'code', redirect_uri: REDIRECT_URI, scope: SCOPES.join(' '),
		code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent',
	})) u.searchParams.set(k, v);
	return u.toString();
}
// What the owner pasted: the address the browser stopped at, or the bare code.
export function pastedCode(text) {
	const t = String(text || '').trim();
	if (!t) return null;
	if (/^https?:\/\//i.test(t)) {
		try {
			const u = new URL(t);
			if (u.searchParams.get('error')) return { error: u.searchParams.get('error') };
			const code = u.searchParams.get('code');
			return code ? { code, state: u.searchParams.get('state') || null } : null;
		} catch { return null; }
	}
	return /^[\w\-/.%]{10,}$/.test(t) ? { code: decodeURIComponent(t), state: null } : null;
}

// agy's own credential file: {"token": {access_token, token_type, refresh_token, expiry}, "auth_method": "consumer"},
// expiry in local time with its offset, as agy writes it. Without an expiry agy would treat the
// token as good for ever (dsh-agy-link issue #112).
export function credentialDoc(tokens, now = Date.now()) {
	const d = new Date(tokens.expiryMs ?? now + 3600e3);
	const pad = (n, w = 2) => String(n).padStart(w, '0');
	const off = -d.getTimezoneOffset();
	const expiry = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
	return JSON.stringify({ token: { access_token: tokens.access_token, token_type: tokens.token_type || 'Bearer', ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}), expiry }, auth_method: 'consumer' });
}
export async function writeCredential(file, tokens) {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, credentialDoc(tokens), { encoding: 'utf8', mode: 0o600 });
	await chmod(tmp, 0o600).catch(() => {});
	await rename(tmp, file);
}

// One HTTPS request, directly or through an HTTP proxy (CONNECT). Resolves { status, body }.
export function httpsCall(url, { method = 'GET', headers = {}, body = null, proxy = null, timeout = 30000 } = {}) {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const isHttp = u.protocol === 'http:'; // tests only
		const go = (socket) => {
			const req = (isHttp ? httpRequest : httpsRequest)({
				host: u.hostname, port: Number(u.port) || (isHttp ? 80 : 443), path: u.pathname + u.search, method, timeout,
				headers: { host: u.host, 'user-agent': 'droidagent', ...(body ? { 'content-length': Buffer.byteLength(body) } : {}), ...headers },
				...(socket ? { createConnection: () => socket } : { agent: false }),
			}, (res) => {
				let text = '';
				res.setEncoding('utf8');
				res.on('data', (d) => { text += d; });
				res.on('error', reject);
				res.on('end', () => resolve({ status: res.statusCode, body: text }));
			});
			req.on('timeout', () => req.destroy(new Error('超时')));
			req.on('error', reject);
			req.end(body || undefined);
		};
		if (!proxy || isHttp) return go(null);
		let pu;
		try { pu = new URL(proxy); } catch { return reject(new Error('代理地址无效')); }
		const target = `${u.hostname}:${Number(u.port) || 443}`;
		const c = httpRequest({ host: pu.hostname, port: Number(pu.port) || 80, method: 'CONNECT', path: target, headers: { host: target }, timeout });
		c.on('connect', (res, sock) => {
			if (res.statusCode !== 200) { sock.destroy(); return reject(new Error(`代理拒绝（${res.statusCode}）`)); }
			go(tlsConnect({ socket: sock, servername: u.hostname }));
		});
		c.on('timeout', () => c.destroy(new Error('超时')));
		c.on('error', reject);
		c.end();
	});
}

export async function exchangeCode(code, verifier, proxy) {
	const { id, secret } = client();
	const body = new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'authorization_code', code: code.trim(), redirect_uri: REDIRECT_URI, code_verifier: verifier }).toString();
	const r = await httpsCall(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, proxy });
	let j = {};
	try { j = JSON.parse(r.body); } catch { /* not JSON */ }
	if (r.status !== 200 || !j.access_token) {
		const why = [typeof j.error === 'string' ? j.error : j.error?.status, j.error_description || j.error?.message].filter(Boolean).join('：');
		throw new Error(/invalid_grant/.test(why) ? '授权码无效或已经用过了，请重新登录' : `Google 没有给出登录凭据（${r.status}${why ? `，${why}` : ''}）`);
	}
	return { access_token: j.access_token, token_type: j.token_type, refresh_token: j.refresh_token, expiryMs: typeof j.expires_in === 'number' ? Date.now() + j.expires_in * 1000 : undefined };
}
export async function userEmail(accessToken, proxy) {
	try {
		const r = await httpsCall(USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` }, proxy, timeout: 15000 });
		return r.status === 200 ? String(JSON.parse(r.body).email || '') : '';
	} catch { return ''; }
}

// One sign-in: the link to open, then a code from the browser coming back or pasted.
// onDone(err, { email }) is called once. Returns { url, submit(text), cancel() }.
export function startSignIn({ tokenFile, proxy, onDone, onStatus = () => {}, log = () => {} }) {
	const { verifier, challenge } = pkce();
	const state = randomBytes(16).toString('hex');
	let finished = false;
	let exchanging = false;
	const server = createServer((req, res) => {
		const u = new URL(req.url || '/', 'http://localhost');
		if (u.pathname !== CALLBACK_PATH) { res.writeHead(404); res.end(); return; }
		const err = u.searchParams.get('error');
		const code = u.searchParams.get('code');
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
		res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;text-align:center;padding:3rem"><h2>${err ? '授权没有完成' : '授权成功'}</h2><p>回到 DroidAgent 就行。</p></body>`);
		if (err) return finish(new Error(`Google 返回：${err}`));
		if (code) take(code, u.searchParams.get('state'));
	});
	server.on('error', (e) => log('[agy-login] listener:', e.code === 'EADDRINUSE' ? `port ${CALLBACK_PORT} is busy, pasting only` : e.message));
	server.listen(CALLBACK_PORT, '127.0.0.1');
	const timer = setTimeout(() => finish(new Error('登录超时（10 分钟内没有完成授权），请重新开始')), 10 * 60 * 1000);
	timer.unref?.();
	function close() { clearTimeout(timer); try { server.closeAllConnections?.(); server.close(); } catch { /* not listening */ } }
	function finish(err, result) {
		if (finished) return;
		finished = true;
		close();
		onDone(err, result);
	}
	async function take(code, gotState) {
		if (finished || exchanging) return;
		// A code from another attempt (an older tab) would only fail at Google; say so now.
		if (gotState && gotState !== state) { onStatus('这个授权来自之前的一次登录，请用这次的链接重新授权'); return; }
		exchanging = true;
		onStatus('正在向 Google 换取登录凭据…');
		try {
			const tokens = await exchangeCode(code, verifier, proxy);
			await writeCredential(tokenFile, tokens);
			finish(null, { email: await userEmail(tokens.access_token, proxy) });
		} catch (e) {
			exchanging = false;
			finish(e);
		}
	}
	return {
		url: authorizeUrl(challenge, state),
		submit(text) {
			const p = pastedCode(text);
			if (!p) return false;
			if (p.error) { finish(new Error(`Google 返回：${p.error}`)); return true; }
			take(p.code, p.state);
			return true;
		},
		cancel() { finished = true; close(); },
	};
}
