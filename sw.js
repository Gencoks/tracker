// Service Worker: macht die App installierbar, offline nutzbar und kümmert sich um die Erinnerung
const CACHE = "tracker-v1";
const SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== CACHE && k !== "tracker-state").map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});

// Eigene Dateien: erst Netz (damit Updates sofort ankommen), sonst Cache
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
  );
});

// Erinnerung im Hintergrund (Android/Chrome, wenn als App installiert)
const pad = n => String(n).padStart(2, "0");
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

self.addEventListener("periodicsync", e => {
  if (e.tag === "tracker-reminder") e.waitUntil(backgroundReminder());
});
async function backgroundReminder() {
  const c = await caches.open("tracker-state");
  const r = await c.match("state");
  const st = r ? await r.json() : {};
  const at = st.at || { h: 19, m: 30 };
  const now = new Date();
  if (now.getHours() * 60 + now.getMinutes() < at.h * 60 + at.m) return;
  const k = todayKey();
  if (st.notified === k) return;
  let title, body;
  if (st.date === k) {
    if (!st.open || !st.open.length) return;
    title = `Noch ${st.open.length} Aufgabe${st.open.length > 1 ? "n" : ""} offen`;
    body = st.open.join(", ");
  } else {
    title = "Tracker";
    body = "Du hast heute noch nichts abgehakt.";
  }
  await self.registration.showNotification(title, { body, icon: "./icon-192.png", badge: "./icon-192.png", tag: "tracker-reminder" });
  await c.put("state", new Response(JSON.stringify({ ...st, notified: k })));
}

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const w of list) if ("focus" in w) return w.focus();
    return self.clients.openWindow("./");
  }));
});
