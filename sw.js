/* Tideline service worker: keeps the app, charts you've viewed, and the last forecast available offline. */
const APP = 'tl-app-v164';
const TILES = 'tl-tiles';
const DATA = 'tl-data';
const SHELL = [
  './', 'index.html', 'app.css', 'app.js', 'rules.js', 'manifest.webmanifest',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/leaflet-rotate/leaflet-rotate.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'kb/trim.json', 'kb/race.json', 'kb/fish.json', 'kb/tour.json',
];
const TILE_HOSTS = ['gis.charttools.noaa.gov', 'server.arcgisonline.com', 'basemap.nationalmap.gov', 'tile.openstreetmap.org', 'tiles.openseamap.org'];
const DATA_HOSTS = ['api.open-meteo.com', 'marine-api.open-meteo.com', 'api.tidesandcurrents.noaa.gov', 'overpass-api.de', 'nominatim.openstreetmap.org', 'encdirect.noaa.gov', 'api.inaturalist.org', 'api.weather.gov', 'en.wikipedia.org', 'commons.wikimedia.org', 'www.federalregister.gov'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('tl-app-') && k !== APP).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
  return res;
}
// chart tiles: the saved tile shows at once; with signal, a tile older than two weeks is quietly fetched again, so chart corrections arrive
const TILE_DATES = 'tl-tile-dates', TILE_MAX_AGE = 14 * 864e5;
async function tileFirst(req) {
  const cache = await caches.open(TILES), hit = await cache.match(req);
  const stamp = () => caches.open(TILE_DATES).then((d) => d.put(req.url, new Response(String(Date.now())))).catch(() => {});
  const refresh = () => fetch(req).then((res) => { if (res && (res.ok || res.type === 'opaque')) { cache.put(req, res.clone()).catch(() => {}); stamp(); } return res; });
  if (hit && hit.type === 'opaque' && req.mode === 'cors') { try { const r = await refresh(); if (r && r.ok) return r; } catch (e) { /* offline: the page falls back to a plain image */ } return Response.error(); }
  if (hit) {
    caches.open(TILE_DATES).then((d) => d.match(req.url)).then((r) => (r ? r.text() : '0')).then((t) => { if (Date.now() - Number(t) > TILE_MAX_AGE) refresh().catch(() => {}); }).catch(() => {});
    return hit;
  }
  return refresh();
}
// forecasts and lookups: keep the newest 400 answers
async function trimData() { try { const c = await caches.open(DATA), k = await c.keys(); if (k.length > 400) await Promise.all(k.slice(0, k.length - 400).map((r) => c.delete(r))); } catch (e) { /* */ } }
async function networkFirst(req, cacheName, fresh) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(fresh ? new Request(req, { cache: 'no-cache' }) : req); // the app's own files skip the browser cache so updates show on reload
    if (res && res.ok) { cache.put(req, res.clone()).catch(() => {}); if (cacheName === DATA && Math.random() < 0.05) trimData(); }
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}
async function staleWhileRevalidate(req) {
  const cache = await caches.open(APP);
  const hit = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await net) || new Response('Offline', { status: 503 });
}

// the app's own files: the network first so updates show, but on a weak signal the saved copy is used after 3.5 s instead of waiting
async function appFile(req) {
  const saved = () => caches.match(req, { ignoreSearch: true });
  const net = networkFirst(req, APP, true);
  const slow = new Promise((ok) => setTimeout(() => saved().then((r) => ok(r || null)), 3500));
  try { const r = await Promise.race([net, slow]); if (r) return r; return await net; } catch (e) { return (await saved()) || new Response('Offline', { status: 503 }); }
}
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (TILE_HOSTS.includes(url.hostname)) { e.respondWith(tileFirst(req)); return; }
  if (FONT_HOSTS.includes(url.hostname)) { e.respondWith(cacheFirst(req, APP)); return; }
  if (DATA_HOSTS.includes(url.hostname)) { e.respondWith(networkFirst(req, DATA)); return; }
  // the app itself: always try the network first so a new version shows on the next reload; the saved copy is only for offline
  if (url.origin === self.location.origin && url.searchParams.has('probe')) { e.respondWith(fetch(req)); return; } // "is there a connection?" must ask the network, never the saved copy
  if (url.origin === self.location.origin) { e.respondWith(appFile(req)); }
});
