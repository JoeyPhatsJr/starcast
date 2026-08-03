// sw.js — Starcast service worker.
//
// Goals: instant loads on repeat visits, and a working app in the field
// with no signal — the shell is precached and the last successful forecast
// response is served when the network is gone.
//
// NOTE FOR DEPLOYS: bump VERSION whenever app files change, so clients
// drop the old precache on their next visit.

const VERSION = 'starcast-v12';
const DATA_CACHE = `${VERSION}-data`;

const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/ui.js',
  './js/weather.js',
  './js/astro.js',
  './js/score.js',
  './js/lightpollution.js',
  './js/tonight.js',
  './js/logic.js',
  './js/skymap.js',
  './js/wmm.js',
  './js/wmmcof.js',
  './js/armath.js',
  './data/sky.json',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== VERSION && k !== DATA_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    // App shell: stale-while-revalidate — serve cached instantly, refresh
    // the cache in the background so the next load picks up deploys.
    event.respondWith(
      caches.match(req, { ignoreSearch: true }).then((cached) => {
        const fresh = fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => cached);
        return cached || fresh;
      })
    );
    return;
  }

  if (url.hostname === 'api.open-meteo.com'
      || url.hostname === 'geocoding-api.open-meteo.com'
      || url.hostname === 'air-quality-api.open-meteo.com') {
    // Forecast data: network-first, falling back to the last good response
    // so the app still renders offline. Fallbacks get a marker header so
    // the UI can disclose that it's showing saved data.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(DATA_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if (!cached) return Response.error();
          const headers = new Headers(cached.headers);
          headers.set('X-Starcast-Cache', '1');
          return new Response(await cached.blob(), { status: cached.status, headers });
        })
    );
    return;
  }

  if (url.hostname === 'djlorenz.github.io') {
    // Atlas tiles are effectively immutable: cache-first.
    event.respondWith(
      caches.match(req).then((cached) =>
        cached || fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(DATA_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
      )
    );
  }
  // Everything else (7Timer, unpkg-free world): straight to network.
});
