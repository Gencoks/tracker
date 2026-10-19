// Service Worker: macht die App installierbar, offline nutzbar und kümmert sich um Benachrichtigungen
const CACHE = "tracker-v9";
const SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];
const PROJECT = "fir-8213f";

// Firebase-Anmeldung auch im Hintergrund nutzen (für „✓ Erledigt“ direkt aus der Benachrichtigung)
let auth = null;
try {
  importScripts(
    "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js",
    "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js"
  );
  firebase.initializeApp({
    apiKey: "AIzaSyAl3xIGQSwkXTr3LlgOuPdg9hfM4He8Jcg",
    authDomain: "fir-8213f.firebaseapp.com",
    projectId: PROJECT,
    appId: "1:354733643310:web:c87d3676b0e49f9740f1bf",
  });
  auth = firebase.auth();
} catch (e) { auth = null; }

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
    // cache: "no-cache" fragt GitHub jedes Mal nach der neuesten Version (sonst hält der Browser Dateien bis zu 10 Min. fest)
    fetch(e.request.url, { cache: "no-cache" }).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
  );
});

// ---------- Hilfen ----------
const pad = n => String(n).padStart(2, "0");
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const toMin = t => +t.slice(0, 2) * 60 + +t.slice(3);
async function readState() {
  const c = await caches.open("tracker-state");
  const r = await c.match("state");
  return { c, st: r ? await r.json() : {} };
}

// ---------- Benachrichtigungen anzeigen: jeder offene Punkt einzeln, mit „✓ Erledigt“ ----------
async function showItems(p) {
  const items = (p.items || []).slice(0, 8);
  for (const it of items) {
    const weight = it.kind === "weight";
    await self.registration.showNotification(it.t, {
      body: it.kind === "todo" ? "To-Do – noch offen" : weight ? "Noch nicht eingetragen" : "Noch offen",
      tag: it.id, renotify: true, icon: "./icon-192.png", badge: "./icon-192.png",
      data: { ...it, date: p.date, total: p.total },
      actions: weight ? [{ action: "open", title: "Eintragen" }] : [{ action: "done", title: "✓ Erledigt" }],
    });
  }
  const rest = (p.items || []).length - items.length;
  if (rest > 0) await self.registration.showNotification(`… und ${rest} weitere offen`, { tag: "more", icon: "./icon-192.png", badge: "./icon-192.png", data: {} });
}

// Push vom Server (kommt auch, wenn die App geschlossen ist)
self.addEventListener("push", e => {
  let p = {};
  try {
    const j = e.data ? e.data.json() : {};
    const raw = j.data?.payload ?? j.payload ?? null;
    p = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : j;
  } catch (err) { p = {}; }
  e.waitUntil((p.items && p.items.length) ? showItems(p)
    : self.registration.showNotification("Tracker", { body: "Schau mal in deine Aufgaben.", icon: "./icon-192.png", badge: "./icon-192.png", tag: "tracker" }));
});

// Lokale Erinnerung aus der geöffneten App
self.addEventListener("message", e => {
  if (e.data?.type === "show") e.waitUntil(showItems(e.data.payload));
});

// ---------- Tippen auf eine Benachrichtigung ----------
self.addEventListener("notificationclick", e => {
  const d = e.notification.data || {};
  e.notification.close();
  if (e.action === "done") { e.waitUntil(markDone(d)); return; }
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const w of list) if ("focus" in w) return w.focus();
    return self.clients.openWindow("./");
  }));
});

// „✓ Erledigt“: direkt in Firebase speichern; klappt das nicht, beim nächsten Öffnen der App nachholen
async function markDone(d) {
  try {
    if (!auth) throw new Error("no auth");
    const user = auth.currentUser || await new Promise(res => { const off = auth.onAuthStateChanged(u => { off(); res(u); }); });
    if (!user) throw new Error("not signed in");
    const token = await user.getIdToken();
    const base = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/users/${user.uid}`;
    const H = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    if (d.kind === "todo") {
      const r = await fetch(`${base}/todos/${d.todoId}?updateMask.fieldPaths=done&updateMask.fieldPaths=doneDay`, {
        method: "PATCH", headers: H, body: JSON.stringify({ fields: { done: { booleanValue: true }, doneDay: { stringValue: todayKey() } } }) });
      if (!r.ok) throw new Error("todo " + r.status);
    } else {
      const date = d.date || todayKey();
      const g = await fetch(`${base}/days/${date}`, { headers: H });
      let fields = {};
      if (g.ok) fields = (await g.json()).fields || {};
      else if (g.status !== 404) throw new Error("get " + g.status);
      const doneMap = fields.done?.mapValue?.fields || {};
      if (doneMap[d.key]?.booleanValue) return;
      const count = Object.values(doneMap).filter(v => v.booleanValue).length + 1;
      const total = +(fields.total?.integerValue || d.total || count);
      const mask = ["done.`" + d.key + "`", "count", "total", "complete", "date"].map(f => "updateMask.fieldPaths=" + encodeURIComponent(f)).join("&");
      const r = await fetch(`${base}/days/${date}?${mask}`, {
        method: "PATCH", headers: H,
        body: JSON.stringify({ fields: {
          done: { mapValue: { fields: { [d.key]: { booleanValue: true } } } },
          count: { integerValue: String(count) }, total: { integerValue: String(total) },
          complete: { booleanValue: count >= total }, date: { stringValue: date },
        } }) });
      if (!r.ok) throw new Error("patch " + r.status);
    }
  } catch (err) {
    const { c, st } = await readState();
    const pending = [...(st.pending || []), { kind: d.kind, key: d.key, todoId: d.todoId, date: d.date || todayKey() }];
    await c.put("state", new Response(JSON.stringify({ ...st, pending })));
  }
  const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  list.forEach(w => w.postMessage({ type: "refresh" }));
}

// ---------- Lokale Erinnerung im Hintergrund (nur ohne Push; Android entscheidet über den Zeitpunkt) ----------
self.addEventListener("periodicsync", e => {
  if (e.tag === "tracker-reminder") e.waitUntil(backgroundReminder());
});
async function backgroundReminder() {
  const { c, st } = await readState();
  const plan = st.plan; if (!plan || plan.pushOn) return;
  const k = todayKey(), now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  if (plan.date !== k) return;
  const fired = st.firedDate === k ? (st.fired || []) : [];
  const recent = t => toMin(t) <= nowMin && nowMin - toMin(t) <= 90;
  const items = [], seen = new Set();
  const add = arr => arr.forEach(it => { if (!seen.has(it.id)) { seen.add(it.id); items.push(it); } });
  const gen = (plan.general || []).filter(recent).filter(t => !fired.includes("g" + t)).pop();
  if (gen) add(plan.items || []);
  (plan.general || []).filter(t => toMin(t) <= nowMin).forEach(t => fired.includes("g" + t) || fired.push("g" + t));
  for (const t of plan.tasks || []) {
    const id = "t" + t.key + t.time;
    if (fired.includes(id) || toMin(t.time) > nowMin) continue;
    if (!t.done && recent(t.time)) add([t]);
    fired.push(id);
  }
  if (items.length) await showItems({ date: plan.date, total: plan.total, items });
  await c.put("state", new Response(JSON.stringify({ ...st, firedDate: k, fired })));
}
