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
  draft: { day: "", place: "", lists: [] },
  confirm: "",                // nyckel för en bekräftelse på plats
  renameList: "",
  newListOpen: false,
  renameMe: false,
  busy: false
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
function expiryText(iso) { return "natten mot " + weekday(addDays(iso, 1)) + " kl. 02"; }

// ======================================================
// SMÅTT
// ======================================================

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function initial(name) { return esc((String(name || "?").trim()[0] || "?").toUpperCase()); }

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
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
  if (/email not confirmed/i.test(msg)) return "Bekräfta din e-post först – kolla din inkorg.";
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
    sb.from("friends").select("friend, list_id, created_at"),
    sb.from("invites").select("code").maybeSingle(),
    sb.from("signals").select("id, day, place, lists, expires_at").maybeSingle(),
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
    .map(r => ({ id: r.friend, name: names.get(r.friend) || "Okänd", list_id: r.list_id }))
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));
}

async function refresh(quiet) {
  if (S.screen !== "app") return;
  try {
    await loadAll();
    const typing = document.activeElement && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (!typing) render();
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

function renderAuth() {
  const head = `<header><h1>Ska vi ta en öl?</h1>
    <p class="lead">Säg att du är sugen på sällskap utan att fråga någon rakt ut.</p></header>`;
  const msg = S.authMessage ? `<div class="notice">${esc(S.authMessage)}</div>` : "";
  const err = S.authError ? `<p class="error" role="alert">${esc(S.authError)}</p>` : "";

  let inviteBox = "";
  if (S.inviteStatus === "ok") {
    inviteBox = `<section class="card">
      <h2>${esc(S.inviteName)} bjuder in dig</h2>
      <p>Tryck på glaset när du är sugen på en öl. Dina vänner ser det – men bara de du väljer. De du inte valt ser ingenting, inte ens att de valts bort.</p>
    </section>`;
  } else if (S.inviteStatus === "invalid") {
    inviteBox = `<div class="notice"><b>Inbjudan gäller inte längre.</b><span>Be vännen som skickade länken om en ny.</span></div>`;
  }

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
function friendsWord(n) { return n === 1 ? "1 vän" : n + " vänner"; }

function setupHtml() {
  const d = S.draft;
  const today = appToday();
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i)).map(iso =>
    `<button type="button" class="chip" data-day="${iso}" aria-pressed="${d.day === iso}">${dayLabel(iso)}</button>`).join("");
  const lists = S.lists.map(l => l.always
    ? `<span class="chip locked">${esc(l.name)} · ser alltid</span>`
    : `<button type="button" class="chip" data-list="${l.id}" aria-pressed="${d.lists.includes(l.id)}">${esc(l.name)}</button>`).join("");
  const n = audience(d.lists);
  const unsorted = S.friends.filter(f => !f.list_id).length;
  return `<section class="card" aria-label="Tänd signalen">
    <div class="field"><span class="label">När</span><div class="chips">${days}</div></div>
    <div class="field"><label class="label" for="place">Var (valfritt)</label>
      <input type="text" id="place" placeholder="T.ex. Södermalm, efter 19" value="${esc(d.place)}" maxlength="60"></div>
    <div class="field"><span class="label">Vilka får se den här gången</span><div class="chips">${lists}</div>
      <p class="hint" id="audience">${friendsWord(n)} ser signalen. Ingen av dem får veta vilken lista de ligger på.</p>
      ${unsorted ? `<p class="hint">${friendsWord(unsorted)} ${unsorted === 1 ? "är inte sorterad" : "är inte sorterade"} och ser ingenting. <button type="button" class="linkbtn" data-tab="vanner">Sortera</button></p>` : ""}
    </div>
    <div class="btn-row">
      <button type="button" class="btn btn-quiet" id="cancelSetup">Avbryt</button>
      <button type="button" class="btn btn-main" id="light" ${S.busy ? "disabled" : ""}>${S.editing ? "Spara" : "Tänd signalen"}</button>
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
    <dl>
      <dt>När</dt><dd>${dayLabel(s.day)}</dd>
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
    <div class="who"><b>${esc(f.owner_name)}</b><span>${dayLabel(f.day)}${f.place ? " · " + esc(f.place) : ""}</span>
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
    <div class="hero">${glassHtml(on)}
      <div class="hero-text">${on ? "Du är sugen på en öl" : "Sugen på en öl?"}</div>
      <div class="hero-sub">${on ? dayLabel(S.signal.day) + (S.signal.place ? " · " + esc(S.signal.place) : "") : "Tryck på glaset"}</div>
    </div>
    ${firstTime ? `<div class="notice"><b>Du har inga vänner i appen än.</b><span>Bjud in någon under Vänner – då kan ni se varandras signaler.</span></div>` : ""}
    ${showSetup ? setupHtml() : on ? statusHtml() : ""}
    <section class="section"><h2>Sugna vänner</h2>
      <div class="list">${S.feed.length ? S.feed.map(feedRow).join("") : `<p class="empty">Ingen av dina vänner har tänt sin signal för dig.</p>`}</div>
    </section>`;
}

// ---------- Vänner ----------

function friendRow(f) {
  const opts = S.lists.map(l => `<option value="${l.id}" ${l.id === f.list_id ? "selected" : ""}>${esc(l.name)}</option>`).join("");
  const confirmKey = "friend:" + f.id;
  if (S.confirm === confirmKey) {
    return `<div class="row"><span class="avatar">${initial(f.name)}</span>
      <div class="who"><b>Ta bort ${esc(f.name)} som vän?</b><span>Ni slutar se varandras signaler. ${esc(f.name)} får inte veta det.</span></div></div>
      <div class="confirm"><button type="button" class="small-btn" data-cancel>Avbryt</button>
      <button type="button" class="small-btn" data-remove="${f.id}">Ta bort</button></div>`;
  }
  return `<div class="row"><span class="avatar">${initial(f.name)}</span>
    <div class="who"><b>${esc(f.name)}</b></div>
    <label for="mv-${f.id}" hidden>Lista för ${esc(f.name)}</label>
    <select id="mv-${f.id}" data-move="${f.id}">
      <option value="" ${f.list_id ? "" : "selected"}>Inte sorterad</option>${opts}</select>
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

function renderFriends() {
  const link = S.code ? BASE_URL + "?inbjudan=" + S.code : "";
  const unsorted = S.friends.filter(f => !f.list_id);
  const canShare = typeof navigator.share === "function";
  return `<header><h1>Vänner</h1><p class="lead">Listorna syns bara för dig. En vän ser antingen din signal eller ingenting.</p></header>
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
    ${S.newListOpen
      ? `<form class="card" data-form="newList"><label class="label" for="listName">Namn på listan</label>
          <input type="text" id="listName" placeholder="T.ex. Jobbet" maxlength="30">
          <div class="btn-row"><button type="button" class="btn btn-quiet" data-cancel>Avbryt</button><button type="submit" class="btn btn-main">Skapa lista</button></div></form>`
      : `<div class="btn-row"><button type="button" class="btn btn-quiet" id="addList">Ny lista</button></div>`}`;
}

// ---------- Konto ----------

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
    ${PROTOTYPE_NOTE}
    <section class="card"><h2>Så funkar det</h2>
      <p>Du lägger dina vänner i listor. <b>Närmaste</b> ser alltid när du är sugen. Övriga listor väljer du varje gång du tänder signalen. Den som inte får se signalen ser ingenting – inte heller att den finns.</p>
      <p>Svar går bara till den som tänt signalen. Signalen slocknar av sig själv klockan 02 natten efter den dag du valt.</p>
    </section>
    <div class="btn-row"><button type="button" class="btn btn-danger" id="logout">Logga ut</button></div>`;
}

// ======================================================
// HÄNDELSER
// ======================================================

function openSetup() {
  S.draft = { day: appToday(), place: "", lists: [] };
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
    if (S.signal) { S.draft = { day: S.signal.day, place: S.signal.place || "", lists: [...(S.signal.lists || [])] }; S.editing = true; render(); }
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
  if (t.id === "cancelSetup") { S.setupOpen = false; S.editing = false; render(); return; }
  if (t.id === "light") {
    const wasOn = !!S.signal;
    await act(async () => {
      await rpc("set_signal", { signal_day: S.draft.day, signal_place: S.draft.place.trim(), signal_lists: S.draft.lists });
      S.setupOpen = false; S.editing = false;
      await loadAll();
    }, wasOn ? "Sparat" : "Signalen är tänd");
    return;
  }
  if (t.id === "edit") { S.draft = { day: S.signal.day, place: S.signal.place || "", lists: [...(S.signal.lists || [])] }; S.editing = true; render(); return; }
  if (t.id === "off") {
    await act(async () => { await rpc("clear_signal"); await loadAll(); }, "Signalen är släckt");
    return;
  }
  if (t.dataset.answer) {
    await act(async () => { await rpc("answer_signal", { target: t.dataset.answer }); await loadAll(); }, "Svaret går bara till den som tänt signalen");
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
    await act(async () => { await rpc("remove_friend", { friend_id: t.dataset.remove }); S.confirm = ""; await loadAll(); }, `${f?.name || "Vännen"} är borttagen`);
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

document.addEventListener("input", e => {
  if (e.target.id === "place") S.draft.place = e.target.value;
});

document.addEventListener("change", async e => {
  const sel = e.target.closest("select[data-move]");
  if (!sel) return;
  const id = sel.dataset.move;
  const listId = sel.value || null;
  const f = S.friends.find(x => x.id === id);
  await act(async () => {
    const { error } = await sb.from("friends").update({ list_id: listId }).eq("friend", id);
    if (error) throw error;
    if (f) f.list_id = listId;
  }, f ? `${f.name} ligger nu i ${listId ? S.lists.find(l => l.id === listId)?.name : "Inte sorterade"}` : "");
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

async function enterApp() {
  S.screen = "loading";
  render();
  try {
    await loadAll();
    if (S.inviteCode && !S.inviteDismissed) await checkInvite();
    if (S.inviteCode && S.code && S.inviteCode === S.code) { S.inviteDismissed = true; storeSet(INVITE_KEY, ""); }
    S.screen = "app";
  } catch (e) {
    S.screen = "app";
    toast(errorText(e));
  }
  render();
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
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(true); });
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* appen fungerar ändå */ });
}

start();
