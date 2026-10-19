/*===========================================================
  CUSTOMER APP v2 - shared Edge Function (PIN gate)
  Superset of customer-inventory: same sign-in, same sessions,
  plus roles, the dashboard, smart search and cycle counts.
  Trane keeps using customer-inventory until it is switched over.

  The PWA sends its customer code only at sign-in; after that the
  session decides whose data comes back and with what role, so a
  customer PIN can never read another customer's data or act as LWH.

  POST JSON { action, token, ... }
    login        { customer, pin }  -> { token, name, customer, role, features }
    logout
    dashboard                       -> totals, aging, items, bays, activity
    search       { query, location, page }
    export       { query, location }
    suggest      { text }
    transactions { from, to, direction, log }
    cc_list      { which: open|closed }      (also creates due scheduled counts)
    cc_get       { id }
    cc_request   { scope_type, items|bays|pallets, performer, due_date, notes, title }
    cc_start | cc_submit | cc_cancel  { id }
    cc_scan      { id, bay, tag, qty, note }
    cc_undo      { id, line_id }
    cc_bay_done  { id, bay }
    cc_recount   { id, line_ids }            LWH only
    cc_resolve   { id, line_id, resolution, wms_adjusted }   LWH only
    cc_close     { id, note }                LWH only
    cc_schedules | cc_schedule_save { schedule } | cc_schedule_remove { schedule_id }
  verify_jwt = false: it does its own PIN auth.
===========================================================*/
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://nbr1hawgfan.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:5500",
];
const SESSION_HOURS = 10;
const LOCKOUT_FAILS = 10;
const LOCKOUT_MINUTES = 15;
const PAGE_SIZE = 100;

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

class UserError extends Error {
  status: number;
  constructor(msg: string, status = 400) { super(msg); this.status = status; }
}

function cors(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function log(customer: string, userName: string, action: string) {
  await db.from("cust_app_access_log").insert({ customer_code: customer, user_name: userName, action: action.slice(0, 300) });
}

/** Calls a database function. Messages raised on purpose (code P0001) go back to the user as-is. */
// deno-lint-ignore no-explicit-any
async function rpc(fn: string, args: Record<string, unknown>): Promise<any> {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    if (error.code === "P0001") throw new UserError(error.message);
    throw error;
  }
  return data;
}

async function login(customerRaw: string, pinRaw: string) {
  const customer = String(customerRaw ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,20}$/.test(customer)) return { status: 400, body: { error: "This app is not set up correctly." } };

  const { data: cu } = await db.from("cust_app_customers")
    .select("code, display_name, features").eq("code", customer).eq("active", true).maybeSingle();
  if (!cu) return { status: 400, body: { error: "This app is not set up correctly." } };

  const since = new Date(Date.now() - LOCKOUT_MINUTES * 60000).toISOString();
  const { count } = await db.from("cust_app_login_failures")
    .select("id", { count: "exact", head: true }).eq("customer_code", customer).gte("at", since);
  if ((count ?? 0) >= LOCKOUT_FAILS) {
    return { status: 429, body: { error: "Too many incorrect PINs. Sign-in is paused for 15 minutes." } };
  }

  const pin = String(pinRaw ?? "").trim();
  let user: { id: number; name: string; role: string } | null = null;
  if (/^\d{6,8}$/.test(pin)) {
    const { data, error } = await db.from("cust_app_users")
      .select("id, name, role, pin_salt, pin_hash").eq("customer_code", customer).eq("active", true);
    if (error) throw error;
    for (const u of data ?? []) {
      if (await sha256Hex(u.pin_salt + ":" + pin) === u.pin_hash) { user = { id: u.id, name: u.name, role: u.role }; break; }
    }
  }

  if (!user) {
    await db.from("cust_app_login_failures").insert({ customer_code: customer });
    await new Promise((r) => setTimeout(r, 1200)); // slows guessing
    return { status: 401, body: { error: "That PIN is not recognized. Check it and try again." } };
  }

  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_HOURS * 3600000).toISOString();
  await db.from("cust_app_sessions").insert({
    token_hash: await sha256Hex(token), user_id: user.id, customer_code: customer, expires_at: expires,
  });
  await db.from("cust_app_users").update({ last_login: new Date().toISOString() }).eq("id", user.id);
  await log(customer, user.name, "Signed in");
  return {
    status: 200,
    body: { token, name: user.name, customer: cu.display_name, role: user.role, features: cu.features ?? {} },
  };
}

type Session = { name: string; customer: string; role: string };

async function session(token: string): Promise<Session | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const { data } = await db.from("cust_app_sessions")
    .select("expires_at, customer_code, cust_app_users!inner(name, role, active, customer_code)")
    .eq("token_hash", await sha256Hex(token))
    .maybeSingle();
  // deno-lint-ignore no-explicit-any
  const u = (data as any)?.cust_app_users;
  if (!data || !u?.active || u.customer_code !== data.customer_code || new Date(data.expires_at) < new Date()) return null;
  return { name: u.name as string, customer: data.customer_code as string, role: u.role === "lwh" ? "lwh" : "customer" };
}

const id = (v: unknown) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new UserError("That count was not found.");
  return n;
};
const text = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const list = (v: unknown, max = 500): string[] => {
  const raw = Array.isArray(v) ? v : String(v ?? "").split(/[\n,;]+/);
  return raw.map((x) => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, max);
};
const isoDate = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "")) ? String(v) : null);

// deno-lint-ignore no-explicit-any
async function handle(action: string, body: any, s: Session) {
  const C = s.customer, U = s.name, R = s.role;
  switch (action) {
    case "dashboard":
      return await rpc("cust_app_dashboard", { p_customer: C });

    case "search":
    case "export": {
      const query = text(body.query, 2000);
      const location = text(body.location || "ALL", 20);
      const isExport = action === "export";
      const page = Math.max(1, Number(body.page) || 1);
      const data = await rpc("cust_app_smart_search", {
        p_customer: C, p_query: query, p_location: location,
        p_limit: isExport ? 1000000 : PAGE_SIZE, p_offset: isExport ? 0 : (page - 1) * PAGE_SIZE,
      });
      if (isExport) {
        if (body.purpose !== "count") await log(C, U, `Exported ${data.total} pallets` + (query ? ` matching "${query.slice(0, 80)}"` : ""));
        return data;
      }
      const total = Number(data.total) || 0;
      return { ...data, page, pageSize: PAGE_SIZE, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
    }

    case "suggest":
      return await rpc("cust_app_suggest", { p_customer: C, p_text: text(body.text, 40) });

    case "transactions": {
      const from = isoDate(body.from), to = isoDate(body.to);
      if (!from || !to) throw new UserError("Choose a valid date range.");
      const d = String(body.direction ?? "ALL").toUpperCase();
      const data = await rpc("cust_app_transactions", {
        p_customer: C, p_from: from, p_to: to,
        p_direction: d === "INBOUND" ? "Inbound" : d === "OUTBOUND" ? "Outbound" : "ALL",
      });
      if (body.log) await log(C, U, `Exported transactions ${data.from} to ${data.to}`);
      return data;
    }

    /* ---------- cycle counts ---------- */
    case "cc_list": {
      let made = 0;
      if (body.which !== "closed") made = await rpc("cc_run_due", { p_customer: C });
      const counts = await rpc("cc_list", { p_customer: C, p_role: R, p_which: body.which === "closed" ? "closed" : "open" });
      return { counts, made };
    }
    case "cc_get":
      return await rpc("cc_get", { p_customer: C, p_id: id(body.id), p_role: R });

    case "cc_request": {
      const type = String(body.scope_type ?? "");
      const scope: Record<string, unknown> = {};
      if (type === "items") scope.items = list(body.items);
      else if (type === "bays") scope.bays = list(body.bays);
      else if (type === "pallets") scope.pallets = list(body.pallets);
      else if (type !== "all") throw new UserError("Choose what to count.");
      scope.count_qty = body.count_qty === true;   // default is a pallet check: scan only, no quantities
      const r = await rpc("cc_create", {
        p_customer: C, p_user: U, p_role: R, p_scope_type: type, p_scope: scope,
        p_performer: body.performer === "customer" ? "customer" : "lwh",
        p_due: isoDate(body.due_date), p_notes: text(body.notes, 500) || null,
        p_title: text(body.title, 80) || null, p_source: "request", p_schedule_id: null, p_blind: true,
      });
      await log(C, U, `Requested cycle count #${r.id} (${r.pallets} pallets)`);
      return r;
    }
    case "cc_start": {
      const r = await rpc("cc_start", { p_customer: C, p_id: id(body.id), p_user: U, p_role: R });
      await log(C, U, `Started cycle count #${body.id}`);
      return r;
    }
    case "cc_scan":
      return await rpc("cc_scan", {
        p_customer: C, p_id: id(body.id), p_user: U, p_role: R, p_bay: text(body.bay, 30),
        p_tag: text(body.tag, 60), p_qty: body.qty === "" || body.qty === null || body.qty === undefined ? null : Number(body.qty),
        p_note: text(body.note, 300) || null,
      });
    case "cc_undo":
      return await rpc("cc_undo", { p_customer: C, p_id: id(body.id), p_line: id(body.line_id), p_user: U, p_role: R });
    case "cc_bay_done":
      return await rpc("cc_bay_done", { p_customer: C, p_id: id(body.id), p_bay: text(body.bay, 30), p_user: U, p_role: R });
    case "cc_submit": {
      const r = await rpc("cc_submit", { p_customer: C, p_id: id(body.id), p_user: U, p_role: R });
      await log(C, U, `Submitted cycle count #${body.id} for review`);
      return r;
    }
    case "cc_cancel": {
      const r = await rpc("cc_cancel", { p_customer: C, p_id: id(body.id), p_user: U, p_role: R });
      await log(C, U, `Cancelled cycle count #${body.id}`);
      return r;
    }
    case "cc_recount": {
      const ids = (Array.isArray(body.line_ids) ? body.line_ids : []).map(id).slice(0, 2000);
      if (!ids.length) throw new UserError("Pick the lines to recount.");
      return await rpc("cc_recount", { p_customer: C, p_id: id(body.id), p_lines: ids, p_user: U, p_role: R });
    }
    case "cc_resolve":
      return await rpc("cc_resolve", {
        p_customer: C, p_id: id(body.id), p_line: id(body.line_id), p_resolution: text(body.resolution, 300),
        p_wms_adjusted: !!body.wms_adjusted, p_user: U, p_role: R,
      });
    case "cc_close": {
      const r = await rpc("cc_close", { p_customer: C, p_id: id(body.id), p_note: text(body.note, 500), p_user: U, p_role: R });
      await log(C, U, `Closed cycle count #${body.id}`);
      return r;
    }
    case "cc_schedules":
      return await rpc("cc_schedule_list", { p_customer: C });
    case "cc_schedule_save": {
      // deno-lint-ignore no-explicit-any
      const p: any = body.schedule ?? {};
      const type = String(p.scope_type ?? "");
      const scope: Record<string, unknown> = {};
      if (type === "items") scope.items = list(p.items);
      if (type === "bays") scope.bays = list(p.bays);
      if (type === "rotation") scope.cycle_runs = Number(p.cycle_runs) || 0;
      if (type === "top_items") scope.top = Number(p.top) || 0;
      scope.count_qty = p.count_qty === true;
      const r = await rpc("cc_schedule_save", {
        p_customer: C, p_user: U, p_role: R,
        p: {
          id: p.id ?? null, name: text(p.name, 60), frequency: p.frequency, weekday: p.weekday ?? null,
          month_day: p.month_day ?? null, scope_type: type, scope, lead_days: p.lead_days ?? null,
          start_date: isoDate(p.start_date), active: p.active !== false,
        },
      });
      await log(C, U, `Saved count schedule "${text(p.name, 60)}"`);
      return r;
    }
    case "cc_schedule_remove": {
      const r = await rpc("cc_schedule_remove", { p_customer: C, p_id: id(body.schedule_id), p_user: U, p_role: R });
      await log(C, U, `Removed count schedule #${body.schedule_id}`);
      return r;
    }
  }
  throw new UserError("Unknown action");
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");

    if (action === "login") {
      const r = await login(body.customer, body.pin);
      return json(r.body, r.status, origin);
    }
    if (action === "logout") {
      if (body.token) {
        await db.from("cust_app_sessions").update({ expires_at: new Date().toISOString() })
          .eq("token_hash", await sha256Hex(String(body.token)));
      }
      return json({ ok: true }, 200, origin);
    }

    const s = await session(String(body.token ?? ""));
    if (!s) return json({ error: "SESSION_EXPIRED" }, 401, origin);
    return json(await handle(action, body, s), 200, origin);
  } catch (err) {
    if (err instanceof UserError) return json({ error: err.message }, err.status, origin);
    console.error(err);
    return json({ error: "Something went wrong. Please try again." }, 500, origin);
  }
});
