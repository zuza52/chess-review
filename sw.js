/* Chess Review — офлайн-кэш приложения */
const VERSION = 'cr-v2';

const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'css/pieces.css',
  'js/app.js',
  'js/engine.js',
  'js/book.js',
  'js/review.js',
  'js/board.js',
  'js/chart.js',
  'vendor/chess.js',
  'data/openings.json',
  'engine/stockfish-19-lite-single.js',
  'engine/stockfish-19-lite-single.wasm',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'assets/icon-maskable-192.png',
  'assets/icon-maskable-512.png',
  'assets/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      await Promise.all(
        ASSETS.map((url) => cache.add(url).catch(() => null))
      );
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch {
          return (
            (await caches.match('index.html')) ||
            (await caches.match('./')) ||
            new Response('Нет соединения', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
          );
        }
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok && res.type === 'basic') {
          const cache = await caches.open(VERSION);
          cache.put(req, res.clone());
        }
        return res;
      } catch {
        return new Response('Нет соединения', { status: 503 });
      }
    })()
  );
});
