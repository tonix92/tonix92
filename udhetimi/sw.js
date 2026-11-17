// Vianto service worker: e bën aplikacionin të instalueshëm dhe të hapet edhe me internet të dobët.
const CACHE = "vianto-v1";
const CORE = ["./", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];
const CDN = ["fonts.googleapis.com", "fonts.gstatic.com", "unpkg.com", "cdn.jsdelivr.net"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;

  // Faqja: gjithmonë versioni më i ri nga rrjeti, kopja e ruajtur vetëm kur s'ka internet
  if (req.mode === "navigate" && same) {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put("./", copy));
        return res;
      }).catch(() => caches.match("./"))
    );
    return;
  }

  // Ikonat, fontet dhe libraritë: nga kopja, rifreskohen në sfond
  if (same || CDN.includes(url.hostname)) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(res => { if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
  // Gjithçka tjetër (API, Supabase, harta) shkon direkt në rrjet
});
