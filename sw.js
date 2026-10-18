// Service Worker: macht die App installierbar, offline nutzbar und kümmert sich um Erinnerungen
const CACHE = "tracker-v4";
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

// ---------- Erinnerungen im Hintergrund (Android/Chrome, wenn installiert) ----------
const pad = n => String(n).padStart(2, "0");
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const toMin = t => +t.slice(0, 2) * 60 + +t.slice(3);

self.addEventListener("periodicsync", e => {
  if (e.tag === "tracker-reminder") e.waitUntil(backgroundReminder());
});
async function backgroundReminder() {
  const c = await caches.open("tracker-state");
  const r = await c.match("state");
  const st = r ? await r.json() : {};
  const plan = st.plan; if (!plan) return;
  const k = todayKey(), now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  const fresh = plan.date === k;   // App heute schon geöffnet? Sonst ist noch nichts erledigt
  const fired = st.firedDate === k ? (st.fired || []) : [];
  const recent = t => toMin(t) <= nowMin && nowMin - toMin(t) <= 90;
  const show = (id, title, body) => self.registration.showNotification(title, { body, icon: "./icon-192.png", badge: "./icon-192.png", tag: id });

  const gen = (plan.general || []).filter(recent).filter(t => !fired.includes("g" + t)).pop();
  if (gen) {
    if (!fresh) await show("g" + gen, "Tracker", "Du hast heute noch nichts abgehakt.");
    else if (plan.open.length) await show("g" + gen, `Noch ${plan.open.length} offen`, plan.open.join(", "));
    (plan.general || []).filter(t => toMin(t) <= nowMin).forEach(t => fired.includes("g" + t) || fired.push("g" + t));
  }
  for (const t of plan.tasks || []) {
    const id = "t" + t.key + t.time;
    if (fired.includes(id) || toMin(t.time) > nowMin) continue;
    if ((!fresh || !t.done) && recent(t.time)) await show(id, t.t, "Noch nicht erledigt – jetzt abhaken?");
    fired.push(id);
  }
  await c.put("state", new Response(JSON.stringify({ ...st, firedDate: k, fired })));
}

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const w of list) if ("focus" in w) return w.focus();
    return self.clients.openWindow("./");
  }));
});
