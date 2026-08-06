// Minimal service worker to satisfy PWA installability requirements.
// Does not aggressively cache — the app depends on live Supabase/Stripe
// connections, so full offline support is not a goal for this version.

const CACHE_NAME = 'captionscroll-v1';
const STATIC_ASSETS = [
  '/',
  '/favicon.png',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Network-first strategy: always try the network, fall back to cache
  // only if offline. Keeps the live app (auth, payments, recording) working
  // normally while satisfying the "has a service worker" PWA requirement.
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
