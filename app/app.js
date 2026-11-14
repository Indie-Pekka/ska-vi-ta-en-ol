// ======================================================
// Ska vi ta en öl? – webbappen
//
// All data går via Supabase. Databasens regler avgör vad
// var och en får se (se supabase/migrations). Appen
// läser bara egna listor och vänner; vänners signaler
// kommer från funktionen get_feed, som aldrig skickar
// med vilka listor som valts.
// ======================================================

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.1/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

const INVITE_KEY = "ol-invite";
const BASE_URL = location.origin + location.pathname.replace(/index\.html$/, "");

const S = {
  screen: "loading",          // loading | auth | app | newpassword
  authMode: "login",          // login | register | forgot
  authMessage: "",
  authError: "",
  first: false,               // ?forsta – första kontot, utan inbjudan
  inviteCode: "",
  inviteName: "",
  inviteStatus: "",           // checking | ok | invalid
  inviteDismissed: false,
  session: null,
  tab: "hem",
  me: null,
  lists: [],
  friends: [],
  code: "",
  signal: null,
  feed: [],
  responses: [],
  setupOpen: false,
  editing: false,
  draft: { day: "", place: "", lists: [], time: "", ish: false, timeOpen: false },
  confirm: "",                // nyckel för en bekräftelse på plats
  renameList: "",
  newListOpen: false,
  renameMe: false,
  busy: false,
  howtoOpen: null,            // Så funkar det på Hem (null = standard)
  listsHelpOpen: null,        // Så funkar listorna under Vänner
  fbKind: "forslag",          // feedback: forslag | fel
  fbText: "",
  isAdmin: false,
  feedbackList: [],
  stats: null
};

// ======================================================
// DAGAR (appens dag byter kl. 02 svensk tid)
// ======================================================

const WEEKDAYS = ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"];

function appToday() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(Date.now() - 2 * 3600 * 1000));
}
function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function offsetOf(iso) {
  return Math.round((new Date(iso + "T12:00:00Z") - new Date(appToday() + "T12:00:00Z")) / 86400000);
}
function weekday(iso) { return WEEKDAYS[new Date(iso + "T12:00:00Z").getUTCDay()]; }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function dayText(iso) {
  const off = offsetOf(iso);
  if (off === 0) return "i kväll";
  if (off === 1) return "i morgon";
  return weekday(iso);
}
function dayLabel(iso) { return cap(dayText(iso)); }
// "19:00" → "kl. 19", "19:30" + ish → "19.30 ish"
function timeText(t, ish) {
  if (!t) return "";
  const [h, m] = String(t).split(":");
  const base = String(parseInt(h, 10)) + (m && m !== "00" ? "." + m : "");
  return ish ? base + " ish" : "kl. " + base;
}
function whenText(day, t, ish) { return dayLabel(day) + (t ? " " + timeText(t, ish) : ""); }
function draftFromSignal(sig) {
  const time = sig.start_time ? String(sig.start_time).slice(0, 5) : "";
  return { day: sig.day, place: sig.place || "", lists: [...(sig.lists || [])], time, ish: !!sig.time_ish, timeOpen: !!time };
}
function expiryText(iso) { return "natten mot " + weekday(addDays(iso, 1)) + " kl. 02"; }

// ======================================================
// SMÅTT
// ======================================================

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function initial(name) { return esc((String(name || "?").trim()[0] || "?").toUpperCase()); }

function toast(msg, action, ms) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = action.label;
    b.addEventListener("click", ev => {
      ev.stopPropagation();
      t.hidden = true;
      clearTimeout(toast.timer);
      action.run();
    });
    t.append(" ", b);
  }
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms || (action ? 10000 : 3200));
}

function storeGet(key) { try { return localStorage.getItem(key) || ""; } catch (_) { return ""; } }
function storeSet(key, value) { try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch (_) { /* tomt */ } }

// Begripliga felmeddelanden
function errorText(error) {
  const msg = String(error?.message || error || "");
  if (/invalid login credentials/i.test(msg)) return "Fel e-post eller lösenord.";
  if (/already registered|already exists/i.test(msg)) return "Det finns redan ett konto med den e-posten. Logga in i stället.";
  if (/database error saving new user/i.test(msg)) return "Inbjudan gäller inte längre. Be om en ny länk.";
  if (/password should be at least/i.test(msg)) return "Lösenordet måste vara minst 6 tecken.";
  if (/email not confirmed/i.test(msg)) return "Bekräfta din e-post först, kolla din inkorg.";
  if (/rate limit|too many/i.test(msg)) return "För många försök just nu. Vänta en stund och försök igen.";
  if (/invalid email|unable to validate email/i.test(msg)) return "E-postadressen ser inte rätt ut.";
  if (/failed to fetch|network/i.test(msg)) return "Ingen kontakt med servern. Kolla uppkopplingen.";
  if (/[åäö]/i.test(msg)) return msg; // våra egna svenska meddelanden
  return msg || "Något gick fel. Försök igen.";
}

async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args || {});
  if (error) throw error;
  return data;
}

// ======================================================
// HÄMTA DATA
// ======================================================

async function loadAll() {
  const uid = S.session.user.id;
  const [me, lists, friends, invite, signal, feed, responses] = await Promise.all([
    sb.from("profiles").select("id, name").eq("id", uid).maybeSingle(),
    sb.from("lists").select("id, name, always, sort_order, created_at").order("always", { ascending: false }).order("sort_order").order("created_at"),
    sb.from("friends").select("friend, list_id, hidden, created_at"),
    sb.from("invites").select("code").maybeSingle(),
    sb.from("signals").select("id, day, place, lists, start_time, time_ish, expires_at").maybeSingle(),
    sb.rpc("get_feed"),
    sb.rpc("get_my_responses")
  ]);
  for (const r of [me, lists, friends, invite, signal, feed, responses]) {
    if (r.error) throw r.error;
  }

  S.me = me.data;
  S.lists = lists.data || [];
  S.code = invite.data?.code || "";
  S.signal = signal.data && new Date(signal.data.expires_at) > new Date() ? signal.data : null;
  S.feed = feed.data || [];
  S.responses = responses.data || [];

  const rows = friends.data || [];
  let names = new Map();
  if (rows.length) {
    const p = await sb.from("profiles").select("id, name").in("id", rows.map(r => r.friend));
    if (p.error) throw p.error;
    names = new Map((p.data || []).map(x => [x.id, x.name]));
  }
  S.friends = rows
    .map(r => ({ id: r.friend, name: names.get(r.friend) || "Okänd", list_id: r.list_id, hidden: !!r.hidden }))
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));

  // Feedbacklistan (bara admin)
  const admin = await sb.rpc("is_admin");
  S.isAdmin = !admin.error && admin.data === true;
  if (S.isAdmin) {
    const [fb, st] = await Promise.all([sb.rpc("get_feedback"), sb.rpc("get_stats")]);
    S.feedbackList = fb.error ? [] : (fb.data || []);
    S.stats = st.error ? null : st.data;
  }
}

// ======================================================
// FIRANDE
// ======================================================

const CHEER_KEY = "ol-cheered";
const cheeredMemory = new Set();

function cheeredSet() {
  const set = new Set(cheeredMemory);
  try { JSON.parse(localStorage.getItem(CHEER_KEY) || "[]").forEach(k => set.add(k)); } catch (_) { /* bara minnet */ }
  return set;
}
function saveCheered(set) {
  set.forEach(k => cheeredMemory.add(k));
  try { localStorage.setItem(CHEER_KEY, JSON.stringify([...set].slice(-300))); } catch (_) { /* bara minnet */ }
}
function namesText(names) {
  if (names.length <= 1) return names[0] || "";
  return names.slice(0, -1).join(", ") + " och " + names[names.length - 1];
}
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Nya svar på min signal firas en gång
function checkCheers() {
  if (S.screen !== "app" || !S.signal || !S.responses.length) return;
  const seen = cheeredSet();
  const fresh = S.responses.filter(r => !seen.has(S.signal.id + ":" + r.responder_id));
  if (!fresh.length) return;
  fresh.forEach(r => seen.add(S.signal.id + ":" + r.responder_id));
  saveCheered(seen);
  celebrate(fresh.map(r => r.responder_name));
}

function celebrate(names) {
  document.getElementById("cheer")?.remove();
  const sig = S.signal;
  const when = sig ? whenText(sig.day, sig.start_time, sig.time_ish) + (sig.place ? " · " + sig.place : "") : "";
  const wrap = document.createElement("div");
  wrap.id = "cheer";
  wrap.className = "cheer";
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-label", namesText(names) + " är på");
  let bubbles = "";
  if (!reducedMotion()) {
    for (let i = 0; i < 46; i++) {
      const size = 8 + Math.random() * 26;
      bubbles += `<span class="bubble" style="left:${(Math.random() * 100).toFixed(1)}%;width:${size.toFixed(0)}px;height:${size.toFixed(0)}px;animation-delay:${(Math.random() * 1.6).toFixed(2)}s;animation-duration:${(2.6 + Math.random() * 2.4).toFixed(2)}s"></span>`;
    }
  }
  wrap.innerHTML = `${bubbles}
    <div class="cheer-card">
      <div class="cheer-glasses" aria-hidden="true">🍻</div>
      <h2>${esc(namesText(names))} är på!</h2>
      ${when ? `<p>${esc(when)}</p>` : ""}
      <button type="button" class="btn btn-main" id="cheerClose">Skål!</button>
    </div>`;
  document.body.appendChild(wrap);
  try { navigator.vibrate?.([40, 60, 40]); } catch (_) { /* inte alla kan */ }
  const close = () => wrap.remove();
  wrap.addEventListener("click", ev => { if (ev.target === wrap || ev.target.id === "cheerClose") close(); });
  document.getElementById("cheerClose")?.focus({ preventScroll: true });
}

// Skum som sprutar ur knappen när man själv svarar
function burstAt(rect) {
  if (!rect || reducedMotion()) return;
  const layer = document.createElement("div");
  layer.className = "burst";
  layer.style.left = (rect.left + rect.width / 2) + "px";
  layer.style.top = (rect.top + rect.height / 2) + "px";
  for (let i = 0; i < 16; i++) {
    const a = (Math.PI * 2 * i) / 16 + Math.random() * 0.3;
    const d = 40 + Math.random() * 40;
    const dot = document.createElement("span");
    dot.style.setProperty("--dx", (Math.cos(a) * d).toFixed(0) + "px");
    dot.style.setProperty("--dy", (Math.sin(a) * d - 20).toFixed(0) + "px");
    dot.style.width = dot.style.height = (6 + Math.random() * 10).toFixed(0) + "px";
    layer.appendChild(dot);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 900);
}

// Vänner som är sugna samma dag som jag och ser min signal
function matchCards() {
  const matches = S.feed.filter(f => f.both_keen && !f.answered);
  if (!matches.length) return "";
  return matches.map(f => {
    const answeredMe = S.responses.some(r => r.responder_id === f.owner_id);
    return `<section class="match-card">
      <h2>Du och ${esc(f.owner_name)} är båda sugna ${esc(dayText(f.day))}!</h2>
      <p>${esc(f.owner_name)}: ${esc(whenText(f.day, f.start_time, f.time_ish))}${f.place ? " · " + esc(f.place) : ""}</p>
      ${answeredMe ? `<p><b>${esc(f.owner_name)} har redan svarat att hen är på din signal.</b></p>` : ""}
      <div class="btn-row"><button type="button" class="btn btn-main" data-answer="${f.signal_id}">Jag är på!</button></div>
    </section>`;
  }).join("");
}

async function refresh(quiet) {
  if (S.screen !== "app") return;
  try {
    await loadAll();
    const typing = document.activeElement && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (!typing) render();
    checkCheers();
  } catch (e) {
    if (!quiet) toast(errorText(e));
  }
}

async function checkInvite() {
  if (!S.inviteCode) return;
  S.inviteStatus = "checking";
  try {
    const rows = await rpc("invite_info", { invite_code: S.inviteCode });
    if (rows && rows.length) {
      S.inviteStatus = "ok";
      S.inviteName = rows[0].inviter_name;
    } else {
      S.inviteStatus = "invalid";
    }
  } catch (_) {
    S.inviteStatus = "invalid";
  }
}

// ======================================================
// SKÄRMAR
// ======================================================

function render() {
  const app = document.getElementById("app");
  const tabs = document.getElementById("tabs");
  const showTabs = S.screen === "app";
  tabs.hidden = !showTabs;
  app.classList.toggle("no-tabs", !showTabs);

  if (S.screen === "loading") { app.innerHTML = `<div class="loading">Hämtar…</div>`; return; }
  if (S.screen === "auth") { app.innerHTML = renderAuth(); return; }
  if (S.screen === "newpassword") { app.innerHTML = renderNewPassword(); return; }

  ["hem", "vanner", "konto"].forEach(t => {
    const b = document.getElementById("tab-" + t);
    if (S.tab === t) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  app.innerHTML = S.tab === "hem" ? renderHome() : S.tab === "vanner" ? renderFriends() : renderAccount();
}

// ---------- Inloggning och registrering ----------

const PROTOTYPE_NOTE = `<div class="notice">
  <b>Det här är en prototyp.</b>
  <span>Appen byggs och testas av Hugo Lindmark. Som ägare av databasen kan Hugo tekniskt se vilka som är vänner och vilka listor folk lägger varandra i. Det är inte syftet och han tittar inte i onödan, men du ska veta att det går. Ingen annan kan se dina listor.</span>
</div>`;

function pitchHtml() {
  const invited = S.inviteStatus === "ok"
    ? `<span class="eyebrow">${esc(S.inviteName)} bjuder in dig</span>` : "";
  return `<header class="pitch-head">${invited}
      <h1>Ska vi ta en öl?</h1>
      <p class="lead">Säg att du är sugen på sällskap, utan att fråga någon rakt ut.</p>
    </header>
    <div class="hero" aria-hidden="true"><div class="glass on small"><span class="shape"></span><span class="inner"><span class="beer"></span></span></div></div>
    <section class="pitch" aria-label="Så funkar det">${pitchBody()}</section>`;
}

// Idén i korthet (startsidan, Hem och Konto)
function pitchBody() {
  return `<p>Ibland är man sugen på en öl med någon, men vet inte vem som är ledig. Att skriva det öppet på sociala medier känns som att ropa ut att man saknar vänner, och fel person kan svara. Att fråga en i taget tar tid, och ofta blir det ingenting.</p>
      <ol class="steps">
        <li><span><b class="inline">Tryck på glaset</b> och välj om det är i kväll eller någon annan dag i veckan som du är sugen, gärna med ett förslag om plats.</span></li>
        <li><span><b>Välj vilka som ser det.</b> De som är <b class="inline">Alltid inbjudna</b> ser det alltid. Andra listor bockar du i när du vill.</span></li>
        <li><span><b>Ingen blir bortvald.</b> Den som inte får se din signal ser ingenting, inte heller vilken lista hen ligger på.</span></li>
        <li><span><b>Den som är sugen svarar ”Jag är på!”</b> Svaret går bara till dig. Sedan ses ni.</span></li>
      </ol>
      <p class="hint">Signalen slocknar av sig själv klockan 02 natten efter den dag du valt.</p>`;
}

function howtoHtml(open) {
  return `<details class="howto" id="howto" ${open ? "open" : ""}>
      <summary>Så funkar det</summary>
      <div class="pitch">${pitchBody()}</div>
    </details>`;
}

function renderAuth() {
  const head = S.authMode === "forgot"
    ? `<header><h1>Ska vi ta en öl?</h1></header>`
    : pitchHtml();
  const msg = S.authMessage ? `<div class="notice">${esc(S.authMessage)}</div>` : "";
  const err = S.authError ? `<p class="error" role="alert">${esc(S.authError)}</p>` : "";

  const inviteBox = S.inviteStatus === "invalid"
    ? `<div class="notice"><b>Inbjudan gäller inte längre.</b><span>Be vännen som skickade länken om en ny.</span></div>`
    : "";

  const canRegister = S.inviteStatus === "ok" || S.first;

  if (S.authMode === "register" && canRegister) {
    return `${head}${inviteBox}${PROTOTYPE_NOTE}${msg}
    <form class="card" data-form="register" novalidate>
      <h2>Skapa konto</h2>
      <div class="field"><label class="label" for="reg-name">Ditt namn (det vännerna ser)</label>
        <input type="text" id="reg-name" autocomplete="given-name" maxlength="40" required></div>
      <div class="field"><label class="label" for="reg-email">E-post</label>
        <input type="email" id="reg-email" autocomplete="email" required></div>
      <div class="field"><label class="label" for="reg-pass">Lösenord (minst 6 tecken)</label>
        <input type="password" id="reg-pass" autocomplete="new-password" minlength="6" required></div>
      ${err}
      <button type="submit" class="btn btn-main" ${S.busy ? "disabled" : ""}>${S.busy ? "Skapar konto…" : "Skapa konto"}</button>
      <p class="hint">Har du redan ett konto? <button type="button" class="linkbtn" data-auth="login">Logga in</button></p>
    </form>`;
  }

  if (S.authMode === "forgot") {
    return `${head}${msg}
    <form class="card" data-form="forgot" novalidate>
      <h2>Glömt lösenordet</h2>
      <p class="hint">Du får ett mejl med en länk där du väljer ett nytt lösenord.</p>
      <div class="field"><label class="label" for="forgot-email">E-post</label>
        <input type="email" id="forgot-email" autocomplete="email" required></div>
      ${err}
      <button type="submit" class="btn btn-main" ${S.busy ? "disabled" : ""}>Skicka länk</button>
      <p class="hint"><button type="button" class="linkbtn" data-auth="login">Tillbaka till inloggningen</button></p>
    </form>`;
  }

  return `${head}${inviteBox}${msg}
    <form class="card" data-form="login" novalidate>
      <h2>Logga in</h2>
      <div class="field"><label class="label" for="login-email">E-post</label>
        <input type="email" id="login-email" autocomplete="email" required></div>
      <div class="field"><label class="label" for="login-pass">Lösenord</label>
        <input type="password" id="login-pass" autocomplete="current-password" required></div>
      ${err}
      <button type="submit" class="btn btn-main" ${S.busy ? "disabled" : ""}>${S.busy ? "Loggar in…" : "Logga in"}</button>
      <p class="hint"><button type="button" class="linkbtn" data-auth="forgot">Glömt lösenordet?</button></p>
      ${canRegister
        ? `<p class="hint">Ny här? <button type="button" class="linkbtn" data-auth="register">Skapa konto</button></p>`
        : `<p class="hint">Appen är bara för inbjudna. Be en vän som redan är med om en länk.</p>`}
    </form>`;
}

function renderNewPassword() {
  const err = S.authError ? `<p class="error" role="alert">${esc(S.authError)}</p>` : "";
  return `<header><h1>Nytt lösenord</h1></header>
    <form class="card" data-form="newpassword" novalidate>
      <div class="field"><label class="label" for="new-pass">Nytt lösenord (minst 6 tecken)</label>
        <input type="password" id="new-pass" autocomplete="new-password" minlength="6" required></div>
      ${err}
      <button type="submit" class="btn btn-main" ${S.busy ? "disabled" : ""}>Spara lösenordet</button>
    </form>`;
}

// ---------- Hem ----------

function glassHtml(on) {
  return `<button type="button" class="glass ${on ? "on" : ""}" id="glass" aria-label="${on ? "Du är sugen på en öl" : "Bli sugen på en öl"}">
    <span class="shape"></span><span class="inner"><span class="beer"></span><span class="q">?</span></span></button>`;
}

function alwaysIds() { return new Set(S.lists.filter(l => l.always).map(l => l.id)); }
function audience(listIds) {
  const always = alwaysIds();
  return S.friends.filter(f => f.list_id && (always.has(f.list_id) || listIds.includes(f.list_id))).length;
}
function isUnsorted(f) { return !f.list_id && !f.hidden; }
function friendsWord(n) { return n === 1 ? "1 vän" : n + " vänner"; }

// Varning när ingen kommer att se signalen
function noAudienceWarning(listIds) {
  if (audience(listIds) > 0) return "";
  if (!S.friends.length) {
    return `<div class="notice" role="alert">
      <b>Ingen kan se din signal än</b>
      <span>Du har inga vänner i appen. Bjud in någon, först när ni är vänner kan de se när du är sugen.</span>
      <div><button type="button" class="small-btn" data-tab="vanner">Bjud in vänner</button></div>
    </div>`;
  }
  const always = alwaysIds();
  const unsorted = S.friends.filter(isUnsorted).length;
  const unticked = S.friends.filter(f => f.list_id && !always.has(f.list_id) && !listIds.includes(f.list_id)).length;
  const parts = [];
  if (unsorted) parts.push(`${friendsWord(unsorted)} ${unsorted === 1 ? "är inte sorterad" : "är inte sorterade"} i någon lista än.`);
  if (unticked) parts.push(`${friendsWord(unticked)} ${unticked === 1 ? "ligger i en lista" : "ligger i listor"} som du inte bockat i här.`);
  return `<div class="notice" role="alert">
    <b>Ingen kommer att se din signal</b>
    <span>Vännerna ser bara signalen om de ligger i en lista som får se den: <b>Alltid inbjudna</b> ser den alltid, andra listor bara när du bockar i dem.</span>
    ${parts.length ? `<span>${parts.join(" ")}</span>` : ""}
    ${unsorted ? `<div><button type="button" class="small-btn" data-tab="vanner">Sortera vänner</button></div>` : ""}
  </div>`;
}

function setupHtml() {
  const d = S.draft;
  const today = appToday();
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i)).map(iso =>
    `<button type="button" class="chip" data-day="${iso}" aria-pressed="${d.day === iso}">${dayLabel(iso)}</button>`).join("");
  const lists = S.lists.map(l => l.always
    ? `<span class="chip locked">${esc(l.name)} · ser alltid</span>`
    : `<button type="button" class="chip" data-list="${l.id}" aria-pressed="${d.lists.includes(l.id)}">${esc(l.name)}</button>`).join("");
  const n = audience(d.lists);
  const unsorted = S.friends.filter(isUnsorted).length;
  return `<section class="card" aria-label="Tänd signalen">
    <div class="field"><span class="label">När</span><div class="chips">${days}</div></div>
    ${d.timeOpen
      ? `<div class="field"><label class="label" for="time">Tid</label>
          <div class="time-row">
            <input type="time" id="time" value="${esc(d.time)}" step="900">
            <label class="check" for="ish"><input type="checkbox" id="ish" ${d.ish ? "checked" : ""}> ish</label>
            <button type="button" class="linkbtn" id="removeTime">Ingen tid</button>
          </div>
          <p class="hint" id="timePreview">${d.time ? "Visas som: " + esc(whenText(d.day, d.time, d.ish)) : "Välj en tid."}</p></div>`
      : `<div><button type="button" class="linkbtn" id="addTime">Lägga till en tid?</button></div>`}
    <div class="field"><label class="label" for="place">Var (valfritt)</label>
      <input type="text" id="place" placeholder="T.ex. Södermalm" value="${esc(d.place)}" maxlength="60"></div>
    <div class="field"><div class="listhead"><span class="label">Vilka får se den här gången</span><button type="button" class="linkbtn small" id="explainLists">Hur funkar listorna?</button></div><div class="chips">${lists}</div>
      ${n === 0 ? noAudienceWarning(d.lists) : `<p class="hint" id="audience">${friendsWord(n)} ser signalen. Ingen av dem får veta vilken lista de ligger på.</p>
      ${unsorted ? `<p class="hint">${friendsWord(unsorted)} ${unsorted === 1 ? "är inte sorterad" : "är inte sorterade"} och ser ingenting. <button type="button" class="linkbtn" data-tab="vanner">Sortera</button></p>` : ""}`}
    </div>
    <div class="btn-row">
      <button type="button" class="btn btn-quiet" id="cancelSetup">Avbryt</button>
      <button type="button" class="btn btn-main" id="light" ${S.busy ? "disabled" : ""}>${S.editing ? (n === 0 ? "Spara ändå" : "Spara") : (n === 0 ? "Tänd ändå" : "Tänd signalen")}</button>
    </div>
    <p class="hint">Signalen slocknar av sig själv ${expiryText(d.day)}.</p>
  </section>`;
}

function statusHtml() {
  const s = S.signal;
  const names = S.lists.filter(l => l.always || (s.lists || []).includes(l.id)).map(l => esc(l.name)).join(", ");
  const replies = S.responses.length
    ? S.responses.map(r => `<div class="row"><span class="avatar lit">${initial(r.responder_name)}</span>
        <div class="who"><b>${esc(r.responder_name)}</b><span class="reply">Är på!</span></div></div>`).join("")
    : `<p class="empty">Inga svar än. Titta in igen om en stund.</p>`;
  return `<section class="card status" aria-label="Din signal">
    ${noAudienceWarning(s.lists || [])}
    <dl>
      <dt>När</dt><dd>${esc(whenText(s.day, s.start_time, s.time_ish))}</dd>
      ${s.place ? `<dt>Var</dt><dd>${esc(s.place)}</dd>` : ""}
      <dt>Syns för</dt><dd>${names} (${friendsWord(audience(s.lists || []))})</dd>
      <dt>Slocknar</dt><dd>${expiryText(s.day)}</dd>
    </dl>
    <div class="btn-row">
      <button type="button" class="btn btn-quiet" id="edit">Ändra</button>
      <button type="button" class="btn btn-quiet" id="off" ${S.busy ? "disabled" : ""}>Släck</button>
    </div>
  </section>
  <section class="section"><h2>Svar</h2><p class="hint">Bara du ser vem som svarat.</p><div class="list">${replies}</div></section>`;
}

function feedRow(f) {
  return `<div class="row"><span class="avatar lit">${initial(f.owner_name)}</span>
    <div class="who"><b>${esc(f.owner_name)}</b><span>${esc(whenText(f.day, f.start_time, f.time_ish))}${f.place ? " · " + esc(f.place) : ""}</span>
      ${f.both_keen ? `<span class="match">Ni är båda sugna ${dayText(f.day)}</span>` : ""}</div>
    ${f.answered
      ? `<button type="button" class="small-btn done" data-unanswer="${f.signal_id}" aria-label="Ångra svaret till ${esc(f.owner_name)}">Svarat ✓</button>`
      : `<button type="button" class="small-btn" data-answer="${f.signal_id}">Jag är på!</button>`}
  </div>`;
}

function inviteBanner() {
  if (!S.inviteCode || S.inviteDismissed || S.inviteStatus === "checking") return "";
  if (S.inviteStatus === "invalid") {
    return `<div class="banner"><b>Inbjudan gäller inte längre.</b><span class="hint">Be vännen om en ny länk.</span>
      <div class="btn-row"><button type="button" class="btn btn-quiet" id="dismissInvite">OK</button></div></div>`;
  }
  if (S.code && S.inviteCode === S.code) return "";
  return `<div class="banner"><b>${esc(S.inviteName)} vill bli vän med dig</b>
    <span class="hint">Ni hamnar i varandras vänlista som osorterade. Ingen av er ser den andras signal förrän ni lagt varandra i en lista.</span>
    <div class="btn-row">
      <button type="button" class="btn btn-quiet" id="dismissInvite">Inte nu</button>
      <button type="button" class="btn btn-main" id="acceptInvite" ${S.busy ? "disabled" : ""}>Bli vänner</button>
    </div></div>`;
}

function renderHome() {
  const on = !!S.signal;
  const showSetup = S.setupOpen || S.editing;
  const firstTime = !S.friends.length;
  return `${inviteBanner()}
    <header><h1>Ska vi ta en öl?</h1><p class="lead">Hej ${esc(S.me?.name || "")}! Säg att du är sugen utan att fråga någon rakt ut.</p></header>
    ${matchCards()}
    ${howtoHtml(S.howtoOpen ?? firstTime)}
    <div class="hero">${glassHtml(on)}
      <div class="hero-text">${on ? "Du är sugen på en öl" : "Sugen på en öl?"}</div>
      <div class="hero-sub">${on ? esc(whenText(S.signal.day, S.signal.start_time, S.signal.time_ish)) + (S.signal.place ? " · " + esc(S.signal.place) : "") : "Tryck på glaset"}</div>
    </div>
    ${firstTime ? `<div class="notice"><b>Du har inga vänner i appen än.</b><span>Bjud in någon under Vänner, då kan ni se varandras signaler.</span></div>` : ""}
    ${showSetup ? setupHtml() : on ? statusHtml() : ""}
    <section class="section"><h2>Sugna vänner</h2>
      <div class="list">${S.feed.length ? S.feed.map(feedRow).join("") : `<p class="empty">Ingen av dina vänner har tänt sin signal för dig.</p>`}</div>
    </section>
    <div class="btn-row">
      <button type="button" class="btn btn-quiet" id="openFeedback">Tyck till om appen</button>
      ${S.isAdmin ? (() => { const n = S.feedbackList.filter(f => f.status !== "klar").length;
        return `<button type="button" class="btn ${n ? "btn-main" : "btn-quiet"}" id="openFeedbackAdmin">Feedback${n ? ` (${n} ny${n === 1 ? "" : "a"})` : ""}</button>`; })() : ""}
    </div>`;
}

// ---------- Vänner ----------

function friendRow(f) {
  const opts = S.lists.map(l => `<option value="${l.id}" ${l.id === f.list_id ? "selected" : ""}>${esc(l.name)}</option>`).join("");
  const confirmKey = "friend:" + f.id;
  if (S.confirm === confirmKey) {
    return `<div class="row"><span class="avatar">${initial(f.name)}</span>
      <div class="who"><b>Ta bort ${esc(f.name)} som vän?</b><span>Ni slutar se varandras signaler. ${esc(f.name)} får inte veta det. Vill du bara att ${esc(f.name)} inte ska se dina signaler? Välj <strong>Ser aldrig</strong> i listan i stället.</span></div></div>
      <div class="confirm"><button type="button" class="small-btn" data-cancel>Avbryt</button>
      <button type="button" class="small-btn" data-remove="${f.id}">Ta bort</button></div>`;
  }
  return `<div class="row"><span class="avatar">${initial(f.name)}</span>
    <div class="who"><b>${esc(f.name)}</b></div>
    <label for="mv-${f.id}" hidden>Lista för ${esc(f.name)}</label>
    <select id="mv-${f.id}" data-move="${f.id}">
      ${isUnsorted(f) ? `<option value="" selected>Välj lista…</option>` : ""}${opts}
      <option value="__never" ${f.hidden ? "selected" : ""}>Ser aldrig</option></select>
    <button type="button" class="icon-btn" data-confirm="${confirmKey}" aria-label="Ta bort ${esc(f.name)}">✕</button>
  </div>`;
}

function listSection(l) {
  const fs = S.friends.filter(f => f.list_id === l.id);
  const rows = fs.length ? fs.map(friendRow).join("") : `<p class="empty">Ingen här än.</p>`;
  let head;
  if (S.renameList === l.id) {
    head = `<form class="field" data-form="renameList" data-id="${l.id}">
      <label class="label" for="rename-${l.id}">Nytt namn</label>
      <input type="text" id="rename-${l.id}" value="${esc(l.name)}" maxlength="30">
      <div class="btn-row"><button type="button" class="btn btn-quiet" data-cancel>Avbryt</button><button type="submit" class="btn btn-main">Spara</button></div></form>`;
  } else {
    head = `<div class="listhead"><h2>${esc(l.name)}</h2>
      <div class="tools"><span class="tag">${l.always ? "Ser alltid" : "Ser när du väljer"}</span>
      <button type="button" class="linkbtn" data-rename="${l.id}">Byt namn</button>
      ${l.always ? "" : `<button type="button" class="linkbtn" data-confirm="list:${l.id}">Ta bort</button>`}</div></div>`;
  }
  const confirm = S.confirm === "list:" + l.id
    ? `<div class="confirm"><span>Ta bort listan? ${fs.length ? friendsWord(fs.length) + " blir osorterade." : ""}</span>
        <button type="button" class="small-btn" data-cancel>Avbryt</button>
        <button type="button" class="small-btn" data-deletelist="${l.id}">Ta bort listan</button></div>`
    : "";
  return `<section class="section">${head}${confirm}<div class="list">${rows}</div></section>`;
}

function listsHelpHtml() {
  const startOpen = S.lists.length <= 1 || S.friends.some(isUnsorted);
  const open = S.listsHelpOpen ?? startOpen;
  return `<details class="howto" id="listsHelp" ${open ? "open" : ""}>
      <summary>Så funkar listorna</summary>
      <div class="pitch">
        <p>Du kan lägga dina vänner i olika listor. Har du några vänner som du alltid vill ska se när du är sugen på en öl, lägger du dem i <b>Alltid inbjudna</b>.</p>
        <p>Sedan kanske du har jobbkompisar, gamla gymnasiekompisar, folk från kören eller några ytligt bekanta, som du inte alltid är sugen att träffa, bara ibland. Dem lägger du i en ny lista.</p>
        <p>Du kan sortera dem efter sammanhang, som ”Kören”, ”Jobbet” eller ”Familjen”. Eller efter hur ofta du vill träffa dem, som ”Ibland”, ”Nästan aldrig” eller ”I undantagsfall”.</p>
        <p>När du tänder signalen väljer du vilken eller vilka listor som ska se den. Alltid inbjudna ser den alltid.</p>
        <p><b>Vännerna ser inte vilken lista du har lagt dem i.</b> De ser bara om din signal är tänd eller släckt.</p>
        <p class="hint">Vill du att någon aldrig ska se din signal, välj <b>Ser aldrig</b> i stället för en lista. Hen är kvar som vän men får inte veta något.</p>
      </div>
    </details>`;
}

function renderFriends() {
  const link = S.code ? BASE_URL + "?inbjudan=" + S.code : "";
  const unsorted = S.friends.filter(isUnsorted);
  const never = S.friends.filter(f => f.hidden);
  const canShare = typeof navigator.share === "function";
  return `<header><h1>Vänner</h1><p class="lead">Listorna syns bara för dig. En vän ser antingen din signal eller ingenting.</p></header>
    ${listsHelpHtml()}
    <section class="card">
      <span class="label">Din inbjudningslänk</span>
      <div class="invite"><code id="inviteLink">${esc(link)}</code></div>
      <div class="btn-row">
        ${canShare ? `<button type="button" class="btn btn-main" id="shareInvite">Dela länken</button>` : ""}
        <button type="button" class="btn ${canShare ? "btn-quiet" : "btn-main"}" id="copyInvite">Kopiera</button>
      </div>
      <p class="hint">Skicka länken till en vän. Hen skapar ett konto (eller loggar in) och ni blir vänner direkt. Sedan väljer du vilken lista hen hamnar i.</p>
      ${S.confirm === "newcode"
        ? `<div class="confirm"><span>Den gamla länken slutar fungera.</span><button type="button" class="small-btn" data-cancel>Avbryt</button><button type="button" class="small-btn" id="newCode">Skapa ny länk</button></div>`
        : `<p class="hint"><button type="button" class="linkbtn" data-confirm="newcode">Skapa en ny länk</button> om den gamla spridits för långt.</p>`}
    </section>
    ${unsorted.length ? `<section class="section"><div class="listhead"><h2>Inte sorterade</h2><span class="tag">Ser ingenting</span></div>
      <p class="hint">Välj en lista, annars ser de aldrig din signal.</p>
      <div class="list">${unsorted.map(friendRow).join("")}</div></section>` : ""}
    ${S.lists.map(listSection).join("")}
    ${never.length ? `<section class="section"><div class="listhead"><h2>Ser aldrig</h2><span class="tag">Kvar som vän</span></div>
      <p class="hint">De här vännerna ser aldrig din signal, och de får inte veta det. Du ser fortfarande deras signaler om de vill.</p>
      <div class="list">${never.map(friendRow).join("")}</div></section>` : ""}
    ${S.newListOpen
      ? `<form class="card" data-form="newList"><label class="label" for="listName">Namn på listan</label>
          <input type="text" id="listName" placeholder="T.ex. Kören, Jobbet eller Ibland" maxlength="30">
          <div class="btn-row"><button type="button" class="btn btn-quiet" data-cancel>Avbryt</button><button type="submit" class="btn btn-main">Skapa lista</button></div></form>`
      : `<div class="btn-row"><button type="button" class="btn btn-quiet" id="addList">Ny lista</button></div>`}`;
}

// ---------- Konto ----------

function shortDevice(ua) {
  if (/iphone|ipad/i.test(ua)) return "Iphone";
  if (/android/i.test(ua)) return "Android";
  return ua ? "Dator" : "";
}
function shortDate(ts) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    .format(new Date(ts)).replace(":", ".");
}
function feedbackItem(f) {
  const done = f.status === "klar";
  return `<div class="fb-item">
      <div class="fb-meta"><span class="fb-kind ${f.kind === "fel" ? "is-bug" : ""}">${f.kind === "fel" ? "Funkar inte" : "Förslag"}</span>
        <b>${esc(f.author_name || "Okänd")}</b><span>${esc(shortDate(f.created_at))}${f.device ? " · " + esc(shortDevice(f.device)) : ""}</span></div>
      <p class="fb-text">${esc(f.message)}</p>
      <div><button type="button" class="small-btn" data-fbstatus="${f.id}" data-to="${done ? "ny" : "klar"}">${done ? "Öppna igen" : "Markera klar"}</button></div>
    </div>`;
}
function statsHtml() {
  if (!S.isAdmin || !S.stats) return "";
  const s = S.stats;
  const tile = (n, label, sub) => `<div class="stat"><b>${n ?? 0}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const since = s.since ? new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "long" }).format(new Date(s.since)) : "";
  return `<section class="card" id="statsAdmin">
      <div class="listhead"><h2>Statistik</h2><span class="tag">Bara du ser den här</span></div>
      <div class="stats">
        ${tile(s.users_total, "användare", s.users_new_7d ? `${s.users_new_7d} nya senaste veckan` : "")}
        ${tile(s.active_1d, "öppnat appen senaste dygnet", `${s.active_7d ?? 0} senaste veckan`)}
        ${tile(s.signals_7d, "signaler tända senaste veckan", `av ${s.signal_users_7d ?? 0} personer · ${s.signals_now ?? 0} tända nu`)}
        ${tile(s.answers_7d, "”Jag är på!” senaste veckan", "")}
        ${tile(s.friendships, "vänskaper", `${s.with_friends ?? 0} personer har minst en vän`)}
        ${tile((s.sorted_share ?? 0) + " %", "av vännerna är sorterade i en lista", "")}
      </div>
      <p class="hint">Bara siffror, inte vem. Signaler och svar räknas från ${esc(since || "i dag")}, öppnat appen från i dag.</p>
    </section>`;
}

function feedbackAdminHtml() {
  if (!S.isAdmin) return "";
  const open = S.feedbackList.filter(f => f.status !== "klar");
  const done = S.feedbackList.filter(f => f.status === "klar");
  return `<section class="card" id="feedbackAdmin">
      <div class="listhead"><h2>Feedback från testarna</h2><span class="tag">Bara du ser den här</span></div>
      ${open.length ? open.map(feedbackItem).join("") : `<p class="empty">Ingen ny feedback.</p>`}
      ${done.length ? `<details class="fb-done"><summary>Klara (${done.length})</summary>${done.map(feedbackItem).join("")}</details>` : ""}
    </section>`;
}

function feedbackHtml() {
  const kinds = [["forslag", "Förslag"], ["fel", "Något funkar inte"]].map(([k, label]) =>
    `<button type="button" class="chip" data-fbkind="${k}" aria-pressed="${S.fbKind === k}">${label}</button>`).join("");
  return `<form class="card" data-form="feedback" id="feedback" novalidate>
      <h2>Tyck till om appen</h2>
      <p class="hint">Idéer på ändringar och nya funktioner, eller något som inte fungerar. Hugo läser allt och ser vem som skrivit.</p>
      <div class="chips">${kinds}</div>
      <label class="label" for="fbText">${S.fbKind === "fel" ? "Vad hände, och vad försökte du göra?" : "Ditt förslag"}</label>
      <textarea id="fbText" rows="5" maxlength="2000">${esc(S.fbText)}</textarea>
      <button type="submit" class="btn btn-main" ${S.busy ? "disabled" : ""}>Skicka</button>
    </form>`;
}

function renderAccount() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return `<header><h1>Konto</h1><p class="lead">Inloggad som ${esc(S.session?.user?.email || "")}</p></header>
    <section class="card">
      ${S.renameMe
        ? `<form class="field" data-form="renameMe"><label class="label" for="myName">Ditt namn (det vännerna ser)</label>
            <input type="text" id="myName" value="${esc(S.me?.name || "")}" maxlength="40">
            <div class="btn-row"><button type="button" class="btn btn-quiet" data-cancel>Avbryt</button><button type="submit" class="btn btn-main">Spara</button></div></form>`
        : `<div class="listhead"><div><span class="label">Ditt namn</span><p><b>${esc(S.me?.name || "")}</b></p></div>
            <button type="button" class="linkbtn" id="renameMe">Ändra</button></div>`}
    </section>
    ${standalone ? "" : `<section class="card"><h2>Lägg appen på hemskärmen</h2>
      <p>${ios
        ? "Tryck på Dela-knappen i Safari och välj <b>Lägg till på hemskärmen</b>. Då öppnas appen som en vanlig app."
        : "Öppna webbläsarens meny och välj <b>Installera app</b> eller <b>Lägg till på startskärmen</b>."}</p></section>`}
    ${statsHtml()}
    ${feedbackAdminHtml()}
    ${feedbackHtml()}
    ${PROTOTYPE_NOTE}
    <section class="card"><h2>Så funkar det</h2><div class="pitch">${pitchBody()}</div></section>
    <div class="btn-row"><button type="button" class="btn btn-danger" id="logout">Logga ut</button></div>`;
}

// ======================================================
// HÄNDELSER
// ======================================================

function openSetup() {
  S.draft = { day: appToday(), place: "", lists: [], time: "", ish: false, timeOpen: false };
  S.setupOpen = true;
  S.editing = false;
  render();
  document.getElementById("place")?.focus({ preventScroll: true });
}

async function act(fn, okMessage) {
  if (S.busy) return;
  S.busy = true;
  render();
  try {
    await fn();
    if (okMessage) toast(okMessage);
  } catch (e) {
    toast(errorText(e));
  } finally {
    S.busy = false;
    render();
  }
}

document.addEventListener("click", async e => {
  const t = e.target.closest("button");
  if (!t) return;

  // Inloggningsskärmen
  if (t.dataset.auth) { S.authMode = t.dataset.auth; S.authError = ""; S.authMessage = ""; render(); return; }

  if (t.dataset.tab) { S.tab = t.dataset.tab; S.confirm = ""; render(); window.scrollTo(0, 0); return; }
  if (t.hasAttribute("data-cancel")) {
    S.confirm = ""; S.renameList = ""; S.newListOpen = false; S.renameMe = false; render(); return;
  }
  if (t.dataset.confirm) { S.confirm = t.dataset.confirm; render(); return; }

  // Hem
  if (t.id === "glass") {
    if (S.signal) { S.draft = draftFromSignal(S.signal); S.editing = true; render(); }
    else if (S.setupOpen) { S.setupOpen = false; render(); }
    else openSetup();
    return;
  }
  if (t.dataset.day) { S.draft.day = t.dataset.day; render(); return; }
  if (t.dataset.list) {
    const id = t.dataset.list;
    S.draft.lists = S.draft.lists.includes(id) ? S.draft.lists.filter(x => x !== id) : S.draft.lists.concat(id);
    render();
    return;
  }
  if (t.id === "openFeedback") {
    S.tab = "konto"; S.confirm = ""; render();
    const form = document.getElementById("feedback");
    form?.scrollIntoView({ block: "start" });
    document.getElementById("fbText")?.focus({ preventScroll: true });
    return;
  }
  if (t.id === "explainLists") {
    S.tab = "vanner"; S.listsHelpOpen = true; S.confirm = ""; render();
    window.scrollTo(0, 0);
    return;
  }
  if (t.id === "openFeedbackAdmin") {
    S.tab = "konto"; S.confirm = ""; render();
    document.getElementById("feedbackAdmin")?.scrollIntoView({ block: "start" });
    return;
  }
  if (t.dataset.fbstatus) {
    const id = t.dataset.fbstatus, to = t.dataset.to;
    await act(async () => {
      await rpc("set_feedback_status", { target: id, new_status: to });
      const item = S.feedbackList.find(f => f.id === id);
      if (item) item.status = to;
    }, to === "klar" ? "Markerad som klar" : "Öppnad igen");
    return;
  }
  if (t.dataset.fbkind) { S.fbKind = t.dataset.fbkind; render(); document.getElementById("fbText")?.focus({ preventScroll: true }); return; }
  if (t.id === "addTime") {
    S.draft.timeOpen = true;
    if (!S.draft.time) S.draft.time = "19:00";
    render();
    document.getElementById("time")?.focus({ preventScroll: true });
    return;
  }
  if (t.id === "removeTime") { S.draft.timeOpen = false; S.draft.time = ""; S.draft.ish = false; render(); return; }
  if (t.id === "cancelSetup") { S.setupOpen = false; S.editing = false; render(); return; }
  if (t.id === "light") {
    const wasOn = !!S.signal;
    await act(async () => {
      const time = S.draft.timeOpen && S.draft.time ? S.draft.time : null;
      await rpc("set_signal", {
        signal_day: S.draft.day, signal_place: S.draft.place.trim(), signal_lists: S.draft.lists,
        signal_time: time, signal_ish: !!(time && S.draft.ish)
      });
      S.setupOpen = false; S.editing = false;
      await loadAll();
    }, wasOn ? "Sparat" : "Signalen är tänd");
    return;
  }
  if (t.id === "edit") { S.draft = draftFromSignal(S.signal); S.editing = true; render(); return; }
  if (t.id === "off") {
    await act(async () => { await rpc("clear_signal"); await loadAll(); }, "Signalen är släckt");
    return;
  }
  if (t.dataset.answer) {
    const rect = t.getBoundingClientRect();
    const friend = S.feed.find(f => f.signal_id === t.dataset.answer);
    let ok = false;
    await act(async () => { await rpc("answer_signal", { target: t.dataset.answer }); ok = true; await loadAll(); });
    if (ok) {
      burstAt(rect);
      toast(`Skål! ${friend ? friend.owner_name + " får veta att du är på." : "Svaret går bara till den som tänt signalen."}`);
    }
    return;
  }
  if (t.dataset.unanswer) {
    await act(async () => { await rpc("unanswer_signal", { target: t.dataset.unanswer }); await loadAll(); }, "Svaret är borttaget");
    return;
  }
  if (t.id === "dismissInvite") { S.inviteDismissed = true; storeSet(INVITE_KEY, ""); render(); return; }
  if (t.id === "acceptInvite") {
    await act(async () => {
      const rows = await rpc("accept_invite", { invite_code: S.inviteCode });
      const r = rows && rows[0];
      S.inviteDismissed = true;
      storeSet(INVITE_KEY, "");
      await loadAll();
      toast(r?.already_friends ? `Ni är redan vänner` : `Du och ${r?.inviter_name || "din vän"} är nu vänner`);
    });
    return;
  }

  // Vänner
  if (t.id === "copyInvite") {
    const text = document.getElementById("inviteLink")?.textContent || "";
    try { await navigator.clipboard.writeText(text); toast("Länken är kopierad"); }
    catch (_) { toast("Markera länken och kopiera den"); }
    return;
  }
  if (t.id === "shareInvite") {
    const url = BASE_URL + "?inbjudan=" + S.code;
    try { await navigator.share({ title: "Ska vi ta en öl?", text: "Häng med i Ska vi ta en öl?", url }); }
    catch (_) { /* avbrutet */ }
    return;
  }
  if (t.id === "newCode") {
    await act(async () => { S.code = await rpc("new_invite_code"); S.confirm = ""; }, "Ny länk skapad. Den gamla fungerar inte längre.");
    return;
  }
  if (t.dataset.remove) {
    const f = S.friends.find(x => x.id === t.dataset.remove);
    const friendId = t.dataset.remove;
    await act(async () => { await rpc("remove_friend", { friend_id: friendId }); S.confirm = ""; await loadAll(); });
    if (!S.friends.some(x => x.id === friendId)) {
      toast(`${f?.name || "Vännen"} är borttagen`, {
        label: "Ångra",
        run: () => act(async () => { await rpc("restore_friend", { friend_id: friendId }); await loadAll(); }, `${f?.name || "Vännen"} är tillbaka`)
      });
    }
    return;
  }
  if (t.dataset.rename) { S.renameList = t.dataset.rename; render(); document.getElementById("rename-" + t.dataset.rename)?.focus(); return; }
  if (t.dataset.deletelist) {
    await act(async () => {
      const { error } = await sb.from("lists").delete().eq("id", t.dataset.deletelist);
      if (error) throw error;
      S.confirm = "";
      await loadAll();
    }, "Listan är borttagen");
    return;
  }
  if (t.id === "addList") { S.newListOpen = true; render(); document.getElementById("listName")?.focus(); return; }

  // Konto
  if (t.id === "renameMe") { S.renameMe = true; render(); document.getElementById("myName")?.focus(); return; }
  if (t.id === "logout") { await sb.auth.signOut(); return; }
});

// "toggle" bubblar inte, därför capture
document.addEventListener("toggle", e => {
  if (e.target.id === "howto") S.howtoOpen = e.target.open;
  if (e.target.id === "listsHelp") S.listsHelpOpen = e.target.open;
}, true);

document.addEventListener("input", e => {
  if (e.target.id === "place") S.draft.place = e.target.value;
  if (e.target.id === "fbText") S.fbText = e.target.value;
  if (e.target.id === "time" || e.target.id === "ish") {
    if (e.target.id === "time") S.draft.time = e.target.value;
    else S.draft.ish = e.target.checked;
    const pv = document.getElementById("timePreview");
    if (pv) pv.textContent = S.draft.time ? "Visas som: " + whenText(S.draft.day, S.draft.time, S.draft.ish) : "Välj en tid.";
  }
});

document.addEventListener("change", async e => {
  const sel = e.target.closest("select[data-move]");
  if (!sel) return;
  const id = sel.dataset.move;
  const never = sel.value === "__never";
  const listId = never ? null : (sel.value || null);
  if (!never && !listId) return;
  const f = S.friends.find(x => x.id === id);
  await act(async () => {
    const { error } = await sb.from("friends").update({ list_id: listId, hidden: never }).eq("friend", id);
    if (error) throw error;
    if (f) { f.list_id = listId; f.hidden = never; }
  }, f ? (never ? `${f.name} ser aldrig din signal nu` : `${f.name} ligger nu i ${S.lists.find(l => l.id === listId)?.name || "listan"}`) : "");
});

document.addEventListener("submit", async e => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  const val = id => (document.getElementById(id)?.value || "").trim();

  if (kind === "login") {
    const email = val("login-email"), password = document.getElementById("login-pass").value;
    if (!email || !password) { S.authError = "Fyll i e-post och lösenord."; render(); return; }
    S.busy = true; S.authError = ""; render();
    const { error } = await sb.auth.signInWithPassword({ email, password });
    S.busy = false;
    if (error) { S.authError = errorText(error); render(); }
    return;
  }

  if (kind === "register") {
    const name = val("reg-name"), email = val("reg-email"), password = document.getElementById("reg-pass").value;
    if (!name || !email || !password) { S.authError = "Fyll i namn, e-post och lösenord."; render(); keepValues(form, { name, email }); return; }
    if (password.length < 6) { S.authError = "Lösenordet måste vara minst 6 tecken."; render(); keepValues(form, { name, email }); return; }
    S.busy = true; S.authError = ""; render();
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: { data: { name, invite: S.inviteCode }, emailRedirectTo: BASE_URL }
    });
    S.busy = false;
    if (error) { S.authError = errorText(error); render(); keepValues(form, { name, email }); return; }
    // Vänskapen skapades med kontot
    storeSet(INVITE_KEY, "");
    S.inviteDismissed = true;
    if (!data.session) {
      S.authMode = "login";
      S.authMessage = "Kontot är skapat. Kolla din mejl och bekräfta adressen, logga sedan in här.";
      render();
    }
    return;
  }

  if (kind === "forgot") {
    const email = val("forgot-email");
    if (!email) { S.authError = "Fyll i din e-post."; render(); return; }
    S.busy = true; S.authError = ""; render();
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: BASE_URL });
    S.busy = false;
    if (error) S.authError = errorText(error);
    else { S.authMessage = "Om det finns ett konto med den adressen har ett mejl skickats. Det kan ta några minuter."; S.authMode = "login"; }
    render();
    return;
  }

  if (kind === "newpassword") {
    const password = document.getElementById("new-pass").value;
    if (password.length < 6) { S.authError = "Lösenordet måste vara minst 6 tecken."; render(); return; }
    S.busy = true; S.authError = ""; render();
    const { error } = await sb.auth.updateUser({ password });
    S.busy = false;
    if (error) { S.authError = errorText(error); render(); return; }
    toast("Lösenordet är sparat");
    await enterApp();
    return;
  }

  if (kind === "newList") {
    const name = val("listName");
    if (!name) { toast("Skriv ett namn på listan"); return; }
    await act(async () => {
      const sort = Math.max(0, ...S.lists.map(l => l.sort_order || 0)) + 1;
      const { error } = await sb.from("lists").insert({ name, sort_order: sort });
      if (error) throw error;
      S.newListOpen = false;
      await loadAll();
    }, `Listan ${name} är skapad`);
    return;
  }

  if (kind === "renameList") {
    const id = form.dataset.id;
    const name = val("rename-" + id);
    if (!name) { toast("Skriv ett namn"); return; }
    await act(async () => {
      const { error } = await sb.from("lists").update({ name }).eq("id", id);
      if (error) throw error;
      S.renameList = "";
      await loadAll();
    }, "Namnet är ändrat");
    return;
  }

  if (kind === "feedback") {
    const message = S.fbText.trim();
    if (!message) { toast("Skriv något först"); return; }
    await act(async () => {
      const { error } = await sb.from("feedback").insert({
        kind: S.fbKind, message, device: navigator.userAgent.slice(0, 300)
      });
      if (error) throw error;
      S.fbText = "";
      S.fbKind = "forslag";
    }, "Tack! Hugo får det du skrev.");
    return;
  }

  if (kind === "renameMe") {
    const name = val("myName");
    if (!name) { toast("Skriv ditt namn"); return; }
    await act(async () => {
      const { error } = await sb.from("profiles").update({ name }).eq("id", S.session.user.id);
      if (error) throw error;
      S.renameMe = false;
      await loadAll();
    }, "Namnet är ändrat");
  }
});

// Behåll ifyllda fält när formuläret ritas om efter ett fel
function keepValues(form, values) {
  if (values.name !== undefined) { const el = document.getElementById("reg-name"); if (el) el.value = values.name; }
  if (values.email !== undefined) { const el = document.getElementById("reg-email"); if (el) el.value = values.email; }
}

// ======================================================
// START
// ======================================================

function touchSeen() {
  try {
    const last = Number(localStorage.getItem("ol-seen") || 0);
    if (Date.now() - last < 15 * 60000) return;
    localStorage.setItem("ol-seen", String(Date.now()));
  } catch (_) { /* räkna ändå */ }
  sb.rpc("touch_seen").then(() => {}, () => {});
}

async function enterApp() {
  S.screen = "loading";
  render();
  try {
    await loadAll();
    if (S.inviteCode && !S.inviteDismissed) await checkInvite();
    if (S.inviteCode && S.code && S.inviteCode === S.code) { S.inviteDismissed = true; storeSet(INVITE_KEY, ""); }
    S.screen = "app";
    touchSeen();
  } catch (e) {
    S.screen = "app";
    toast(errorText(e));
  }
  render();
  checkCheers();
}

async function enterAuth() {
  S.screen = "auth";
  S.me = null;
  if (S.inviteCode && !S.inviteStatus) await checkInvite();
  S.authMode = (S.inviteStatus === "ok" || S.first) && S.authMode !== "forgot" ? "register" : "login";
  render();
}

async function start() {
  const params = new URLSearchParams(location.search);
  const code = (params.get("inbjudan") || "").trim().toLowerCase();
  S.first = params.has("forsta");
  if (code) storeSet(INVITE_KEY, code);
  S.inviteCode = code || storeGet(INVITE_KEY);

  // Städa adressen (koden ligger kvar i telefonen tills den använts)
  if (code || S.first) history.replaceState(null, "", location.pathname + (S.first ? "?forsta" : ""));

  sb.auth.onAuthStateChange((event, session) => {
    // Kör utanför Supabase-anropet (rekommenderat)
    setTimeout(() => {
      S.session = session;
      if (event === "PASSWORD_RECOVERY") { S.screen = "newpassword"; render(); return; }
      if (event === "SIGNED_IN" && S.screen === "auth") { enterApp(); return; }
      if (event === "SIGNED_OUT") { S.inviteStatus = ""; S.tab = "hem"; enterAuth(); }
    }, 0);
  });

  const { data } = await sb.auth.getSession();
  S.session = data.session;
  if (S.screen === "loading") {
    if (S.session) await enterApp(); else await enterAuth();
  }

  // Håll listan över sugna vänner aktuell
  setInterval(() => { if (document.visibilityState === "visible") refresh(true); }, 60000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { refresh(true); if (S.screen === "app") touchSeen(); }
  });
}

// ======================================================
// NYA VERSIONER
// version.txt skrivs vid varje publicering. Ändras den
// medan appen är öppen erbjuds en omladdning.
// ======================================================

let loadedVersion = "";
let versionOffered = false;

async function fetchVersion() {
  try {
    const res = await fetch("version.txt?t=" + Date.now(), { cache: "no-store" });
    return res.ok ? (await res.text()).trim() : "";
  } catch (_) {
    return "";
  }
}

async function checkForUpdate() {
  if (versionOffered) return;
  const v = await fetchVersion();
  if (!v) return;
  if (!loadedVersion) { loadedVersion = v; return; }
  if (v !== loadedVersion) {
    versionOffered = true;
    toast("Det finns en ny version av appen", { label: "Ladda om", run: () => location.reload() }, 60000);
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
    .then(reg => document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") reg.update().catch(() => {});
    }))
    .catch(() => { /* appen fungerar ändå */ });
}

checkForUpdate();
setInterval(() => { if (document.visibilityState === "visible") checkForUpdate(); }, 5 * 60000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(); });

start();
