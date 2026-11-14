// ======================================================
// Ska vi ta en öl? – notiser
//
// GET  → { publicKey } (behövs för att slå på notiser)
// POST { event: "signal" }                 – jag har tänt/ändrat min signal
// POST { event: "answer", signal_id }      – jag har svarat "Jag är på!"
// POST { event: "test" }                   – testnotis till mig själv
//
// Vem som får vad räknas ut i databasen (notify_plan).
// Nycklarna (VAPID_*) är hemligheter i Supabase och skapas
// av GitHub Actions.
// ======================================================

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.110.1";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "https://indie-pekka.github.io/ska-vi-ta-en-ol/";

type Plan = { recipient: string; kind: string; title: string; body: string; tag: string };
type Sub = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  if (req.method === "GET") {
    return json({ publicKey: PUBLIC_KEY, ready: !!(PUBLIC_KEY && PRIVATE_KEY && SERVICE_KEY) });
  }

  if (req.method !== "POST") return json({ error: "Fel metod" }, 405);
  if (!PUBLIC_KEY || !PRIVATE_KEY || !SERVICE_KEY) {
    return json({ error: "Notiserna är inte uppsatta än." }, 503);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Vem anropar?
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: userData } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (!user) return json({ error: "Logga in först." }, 401);

  let payload: { event?: string; signal_id?: string } = {};
  try { payload = await req.json(); } catch (_) { /* tomt */ }
  const event = payload.event ?? "";

  let plan: Plan[] = [];
  if (event === "test") {
    plan = [{ recipient: user.id, kind: "test", title: "Notiserna fungerar 🍻", body: "Så här ser det ut när någon är sugen.", tag: "test" }];
  } else if (event === "signal" || event === "answer") {
    const { data, error } = await admin.rpc("notify_plan", {
      sender: user.id,
      event,
      target_signal: payload.signal_id ?? null,
    });
    if (error) return json({ error: error.message }, 500);
    plan = (data ?? []) as Plan[];
  } else {
    return json({ error: "Okänd händelse" }, 400);
  }

  if (!plan.length) return json({ sent: 0 });

  const recipients = [...new Set(plan.map((p) => p.recipient))];
  const { data: subsData, error: subsError } = await admin
    .from("push_subscriptions")
    .select("id, user_id, endpoint, p256dh, auth")
    .in("user_id", recipients);
  if (subsError) return json({ error: subsError.message }, 500);
  const subs = (subsData ?? []) as Sub[];

  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);

  let sent = 0;
  const failures: string[] = [];
  const gone: string[] = [];

  await Promise.all(plan.flatMap((p) =>
    subs.filter((s) => s.user_id === p.recipient).map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title: p.title, body: p.body, tag: p.tag, kind: p.kind }),
          { TTL: 6 * 3600, urgency: "high" },
        );
        sent++;
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) gone.push(s.id);
        else failures.push(String((err as Error).message ?? err).slice(0, 200));
      }
    })
  ));

  // Telefoner som inte längre finns
  if (gone.length) await admin.from("push_subscriptions").delete().in("id", gone);

  return json({ sent, removed: gone.length, failures });
});
