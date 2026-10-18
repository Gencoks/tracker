// Schickt fällige Erinnerungen als Push-Nachricht – läuft alle 10 Minuten über GitHub Actions.
// Braucht das Repository-Secret FIREBASE_SERVICE_ACCOUNT (Inhalt der Dienstkonto-JSON-Datei aus Firebase).
import admin from "firebase-admin";

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
if (!sa.project_id) { console.error("Secret FIREBASE_SERVICE_ACCOUNT fehlt oder ist ungültig."); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const messaging = admin.messaging();

const WINDOW = 60;   // Erinnerungen höchstens so viele Minuten nach der Uhrzeit nachholen

// Aktuelles Datum, Uhrzeit und Wochentag in der Zeitzone des Nutzers
function localNow(tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
  return { date: `${parts.year}-${parts.month}-${parts.day}`, min: +parts.hour * 60 + +parts.minute, wd };
}
const toMin = t => +t.slice(0, 2) * 60 + +t.slice(3);

async function handleUser(userDoc) {
  const u = userDoc.data(), cfg = u.push?.cfg, tokens = u.push?.tokens || [];
  if (!cfg || !tokens.length) return;
  const now = localNow(cfg.tz || "Europe/Berlin");
  const ref = userDoc.ref;

  // Heutige Aufgaben aus der Konfiguration der App
  const tasks = (cfg.tasks || [])
    .filter(t => !t.days || t.days.includes(now.wd))
    .filter(t => !t.training || !(cfg.restDays || []).includes(now.wd))
    .map(t => t.training ? { ...t, t: `Training: ${cfg.weekNames?.[now.wd] || ""}`.trim() } : t);
  const day = (await ref.collection("days").doc(now.date).get()).data() || {};
  const done = day.done || {};
  const openTasks = tasks.filter(t => !done[t.key])
    .map(t => ({ id: "task-" + t.key, key: t.key, t: t.t, kind: t.kind === "weight" ? "weight" : "task" }));
  const todoSnap = await ref.collection("todos").where("done", "==", false).get();
  const openTodos = todoSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(t => !t.due || t.due <= now.date)
    .map(t => ({ id: "todo-" + t.id, todoId: t.id, t: t.text, kind: "todo" }));

  // Was wurde heute schon geschickt?
  const stateRef = ref.collection("meta").doc("push");
  const st = (await stateRef.get()).data() || {};
  const fired = st.date === now.date ? (st.fired || []) : [];
  const recent = t => toMin(t) <= now.min && now.min - toMin(t) <= WINDOW;

  const items = [], seen = new Set();
  const add = arr => arr.forEach(it => { if (!seen.has(it.id)) { seen.add(it.id); items.push(it); } });
  const general = cfg.general || [];
  const gen = general.filter(recent).filter(t => !fired.includes("g" + t)).pop();
  if (gen) add([...openTasks, ...openTodos]);
  general.filter(t => toMin(t) <= now.min).forEach(t => fired.includes("g" + t) || fired.push("g" + t));
  for (const t of tasks.filter(t => t.remind)) {
    const id = "t" + t.key + t.remind;
    if (fired.includes(id) || toMin(t.remind) > now.min) continue;
    if (!done[t.key] && recent(t.remind)) add(openTasks.filter(o => o.key === t.key));
    fired.push(id);
  }
  await stateRef.set({ date: now.date, fired });
  if (!items.length) return;

  const payload = JSON.stringify({ date: now.date, total: tasks.length, items });
  const bad = [];
  for (const token of tokens) {
    try {
      await messaging.send({ token, data: { payload }, webpush: { headers: { Urgency: "high", TTL: "1800" } } });
    } catch (e) {
      console.log("Senden fehlgeschlagen:", e.code);
      if (["messaging/registration-token-not-registered", "messaging/invalid-registration-token", "messaging/invalid-argument"].includes(e.code)) bad.push(token);
    }
  }
  if (bad.length) await ref.set({ push: { tokens: tokens.filter(t => !bad.includes(t)) } }, { merge: true });
  console.log(`${userDoc.id}: ${items.length} Erinnerung(en) geschickt`);
}

const users = await db.collection("users").where("push.enabled", "==", true).get();
for (const d of users.docs) {
  try { await handleUser(d); } catch (e) { console.error(d.id, e); }
}
console.log(`Fertig – ${users.size} Nutzer geprüft.`);
