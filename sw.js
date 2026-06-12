// ── GDSF CHECK-IN: SERVICE WORKER ────────────────────────────────────────────
// Macht die App offline-startfähig. Bei Code-Änderungen CACHE_VERSION erhöhen,
// damit alle Geräte die neue Version laden!
const CACHE_VERSION = 'gdsf-v1';

const APP_SHELL = [
  './',
  './index.html',
  './gdsf-config.js',
  './gdsf-app.js',
  './manifest.json',
  './assets/logo.webp',
  './assets/icon-192.png',
  './assets/icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
];

// Installation: App-Shell vorab cachen
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Aktivierung: alte Caches aufräumen
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch-Strategie:
// - Supabase-API: immer Netzwerk (nie cachen – Live-Daten!)
// - App-Shell (HTML/JS/Bilder): Network-first mit Cache-Fallback
//   → online immer aktuellster Code, offline startet die App trotzdem
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Nur GET-Requests behandeln
  if (event.request.method !== 'GET') return;

  // Supabase & andere APIs nie cachen
  if (url.hostname.includes('supabase.co') || url.hostname.includes('googleapis.com') || url.hostname.includes('script.google.com')) {
    return; // Browser-Default (Netzwerk)
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Erfolgreiche Antwort in den Cache legen
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() =>
        // Offline: aus dem Cache bedienen
        caches.match(event.request).then((cached) => {
          if (cached) return cached;
          // Navigation offline → index.html als Fallback
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('', { status: 503, statusText: 'Offline' });
        })
      )
  );
});
