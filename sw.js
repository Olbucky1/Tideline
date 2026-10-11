/* Tideline service worker: keeps the app, charts you've viewed, and the last forecast available offline. */
const APP = 'tl-app-v81';
const TILES = 'tl-tiles';
const DATA = 'tl-data';
const SHELL = [
  './', 'index.html', 'app.css', 'app.js', 'rules.js', 'manifest.webmanifest',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
const TILE_HOSTS = ['gis.charttools.noaa.gov', 'server.arcgisonline.com', 'basemap.nationalmap.gov', 'tile.openstreetmap.org', 'tiles.openseamap.org'];
const DATA_HOSTS = ['api.open-meteo.com', 'marine-api.open-meteo.com', 'api.tidesandcurrents.noaa.gov', 'overpass-api.de', 'nominatim.openstreetmap.org', 'encdirect.noaa.gov', 'api.inaturalist.org', 'api.weather.gov', 'en.wikipedia.org', 'commons.wikimedia.org'];
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
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
  return res;
}
async function networkFirst(req, cacheName, fresh) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(fresh ? new Request(req, { cache: 'no-cache' }) : req); // the app's own files skip the browser cache so updates show on reload
    if (res && res.ok) cache.put(req, res.clone());
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

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (TILE_HOSTS.includes(url.hostname)) { e.respondWith(cacheFirst(req, TILES)); return; }
  if (FONT_HOSTS.includes(url.hostname)) { e.respondWith(cacheFirst(req, APP)); return; }
  if (DATA_HOSTS.includes(url.hostname)) { e.respondWith(networkFirst(req, DATA)); return; }
  // the app itself: always try the network first so a new version shows on the next reload; the saved copy is only for offline
  if (url.origin === self.location.origin) { e.respondWith(networkFirst(req, APP, true).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || new Response('Offline', { status: 503 })))); }
});
