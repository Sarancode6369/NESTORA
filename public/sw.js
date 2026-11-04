// App-shell cache so the gate tablet and resident app still open when the network drops.
// API calls are never cached: the gate view queues visitor entries on the device itself.
const V = 'nestora-v2';
const SHELL = ['/', '/styles.css', '/logo.png', '/js/app.js', '/js/ui.js', '/js/i18n.js', '/js/charts.js', '/js/landing.js', '/js/township3d.js', '/js/journey.js', '/logo-light.png', '/frames/f001.jpg', '/js/views-resident.js', '/js/views-staff.js', '/js/views-gate.js', '/shared/csv.js', '/manifest.webmanifest'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(caches.open(V).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
