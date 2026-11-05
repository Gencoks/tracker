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
    .map(t => ({ id: "task-" + t.key, key: t.key, t: t.t, kind: t.kind === "weight" ? "weight" : t.kind === "steps" ? "steps" : "task" }));
  const todoSnap = await ref.collection("todos").where("done", "==", false).get();
  const dueTodos = todoSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(t => !t.due || t.due <= now.date);
  const openTodos = dueTodos.map(t => ({ id: "todo-" + t.id, todoId: t.id, t: t.text, kind: "todo" }));

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
  for (const t of tasks) {
    const times = Array.isArray(t.reminds) && t.reminds.length ? t.reminds : t.remind ? [t.remind] : [];   // mehrere Uhrzeiten pro Aufgabe
    for (const time of times) {
      const id = "t" + t.key + time;
      if (fired.includes(id) || toMin(time) > now.min) continue;
      if (!done[t.key] && recent(time)) add(openTasks.filter(o => o.key === t.key));
      fired.push(id);
    }
  }
  // To-Dos mit eigener Erinnerungs-Uhrzeit
  for (const t of dueTodos) {
    if (!t.remind) continue;
    const id = "d" + t.id + t.remind;
    if (fired.includes(id) || toMin(t.remind) > now.min) continue;
    if (recent(t.remind)) add(openTodos.filter(o => o.todoId === t.id));
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

// ---------- Support: neue Wünsche per E-Mail + Push an alle Admins ----------
// Secrets (optional für die E-Mail): GMAIL_USER, GMAIL_APP_PASSWORD, FEEDBACK_TO (Empfänger, sonst GMAIL_USER)
async function handleFeedback() {
  const snap = await db.collection("feedback").where("mailed", "==", false).limit(20).get();
  if (snap.empty) return;
  let mailer = null;
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    try { const nm = (await import("nodemailer")).default; mailer = nm.createTransport({ service: "gmail", auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } }); }
    catch (e) { console.log("nodemailer nicht verfügbar:", e.message); }
  }
  const admins = await db.collection("admins").get(), tokens = [];
  for (const a of admins.docs) { const u = (await db.collection("users").doc(a.id).get()).data(); (u?.push?.tokens || []).forEach(t => tokens.push(t)); }
  const CAT = { design: "Design", idee: "Neue Funktion", fehler: "Fehler", sonst: "Sonstiges" };
  for (const d of snap.docs) {
    const f = d.data(), cat = CAT[f.cat] || "Sonstiges", who = f.name || "Jemand";
    let mailed = !mailer;   // ohne E-Mail-Zugang nur Push, damit nichts doppelt kommt
    if (mailer) {
      try {
        await mailer.sendMail({ from: `"Tracker-App" <${process.env.GMAIL_USER}>`, to: process.env.FEEDBACK_TO || process.env.GMAIL_USER,
          subject: `💡 Neuer Wunsch (${cat}) von ${who}`,
          text: `${who} hat über die Tracker-App geschrieben:\n\nKategorie: ${cat}\n\n${f.text}\n\n—\nGesendet: ${new Date(f.at || Date.now()).toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}\nAlle Nachrichten: App → Einstellungen → Support → Postfach` });
        mailed = true;
      } catch (e) { console.log("E-Mail fehlgeschlagen:", e.message); }
    }
    const payload = JSON.stringify({ msg: { title: `💡 Neuer Wunsch von ${who}`, body: `${cat}: ${String(f.text || "").slice(0, 140)}`, tag: "fb-" + d.id, open: "inbox" } });
    if (!f.pushed) for (const token of tokens) { try { await messaging.send({ token, data: { payload }, webpush: { headers: { Urgency: "high", TTL: "86400" } } }); } catch (e) { console.log("Push an Admin fehlgeschlagen:", e.code); } }
    await d.ref.update({ pushed: true, ...(mailed ? { mailed: true } : {}) });
  }
  console.log(`Support: ${snap.size} neue Nachricht(en) weitergeleitet`);
}
try { await handleFeedback(); } catch (e) { console.error("Support:", e); }

const users = await db.collection("users").where("push.enabled", "==", true).get();
for (const d of users.docs) {
  try { await handleUser(d); } catch (e) { console.error(d.id, e); }
}
console.log(`Fertig – ${users.size} Nutzer geprüft.`);
