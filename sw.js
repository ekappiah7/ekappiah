// Cache the shell so the app opens with no network. Data never goes through
// here — it lives in IndexedDB and syncs over the Firestore API, which this
// worker deliberately does not touch.

const CACHE = 'family-ledger-v1';
const SHELL = [
  './', './index.html', './app.css', './manifest.webmanifest',
  './js/app.js', './js/db.js', './js/store.js', './js/money.js',
  './js/charts.js', './js/cloud.js', './js/importers.js',
  './vendor/fonts/fonts.css',
  './vendor/fonts/Inter-latin.woff2',
  './vendor/fonts/PlayfairDisplay-latin.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;   // Firebase and the CDN go straight to the network

  // Network-first so a deploy is picked up, cache as the offline fallback.
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then(hit => hit || caches.match('./index.html')))
  );
});
