// App-shell cache so the UI installs and opens instantly. API calls never touch the cache.
const CACHE = 'droidagent-v13';
const SHELL = ['.', 'index.html', 'style.css', 'themes.js', 'app.js', 'market.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png'];

self.addEventListener('install', (e) => {
	e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
	e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
	const url = new URL(e.request.url);
	if (url.pathname.startsWith('/api/') || e.request.method !== 'GET') return; // live data, never cache
	e.respondWith(
		fetch(e.request).then((r) => {
			const copy = r.clone();
			caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
			return r;
		}).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
	);
});
