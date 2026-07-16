// ============================================================
// admin-users — privileged user management for Content Verify.
//
// Only the admin may call this. It verifies the caller's JWT email
// against ADMIN_EMAIL, then uses the SERVICE-ROLE key (injected by
// Supabase at runtime — never shipped to the browser) to create,
// delete, deactivate/reactivate, or reset the password of users, and
// mirrors them into public.members.
//
// Actions (POST JSON):
//   { action: "list" }
//   { action: "create",         email, password }
//   { action: "delete",         user_id }
//   { action: "deactivate",     user_id }
//   { action: "reactivate",     user_id }
//   { action: "reset_password", user_id, password }
//
// Deploy:  supabase functions deploy admin-users
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ADMIN_EMAIL = "yoyotsai2024@gmail.com";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // 1) Identify the caller from their bearer token and REQUIRE the admin.
  const authHeader = req.headers.get("Authorization") ?? "";
  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: uErr } = await caller.auth.getUser();
  if (uErr || !user || (user.email ?? "").toLowerCase() !== ADMIN_EMAIL) {
    return json({ error: "Forbidden — admin only." }, 403);
  }

  // 2) Service-role client for the privileged operations.
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Bad JSON body" }, 400); }
  const action = String(body.action ?? "");

  try {
    if (action === "list") {
      const { data, error } = await admin
        .from("members")
        .select("user_id, email, active, created_at")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return json({ members: data ?? [] });
    }

    if (action === "create") {
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      if (!email) return json({ error: "Email is required." }, 400);
      if (password.length < 6) return json({ error: "Temporary password must be at least 6 characters." }, 400);
      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
      });
      if (error) throw error;
      const uid = data.user!.id;
      const { error: mErr } = await admin
        .from("members")
        .upsert({ user_id: uid, email, active: true }, { onConflict: "user_id" });
      if (mErr) throw mErr;
      return json({ ok: true, user_id: uid });
    }

    // Everything below targets an existing user.
    const targetId = String(body.user_id ?? "");
    if (!targetId) return json({ error: "user_id is required." }, 400);
    if (targetId === user.id) {
      return json({ error: "You can't modify your own admin account here." }, 400);
    }

    if (action === "delete") {
      const { error } = await admin.auth.admin.deleteUser(targetId);
      if (error) throw error; // members row is removed by the FK cascade
      return json({ ok: true });
    }

    if (action === "deactivate" || action === "reactivate") {
      const active = action === "reactivate";
      const { error: mErr } = await admin.from("members").update({ active }).eq("user_id", targetId);
      if (mErr) throw mErr;
      // Ban blocks login/refresh; RLS (is_approved) blocks data access at once.
      const { error: bErr } = await admin.auth.admin.updateUserById(targetId, {
        ban_duration: active ? "none" : "876000h",
      });
      if (bErr) throw bErr;
      return json({ ok: true });
    }

    if (action === "reset_password") {
      const password = String(body.password ?? "");
      if (password.length < 6) return json({ error: "New password must be at least 6 characters." }, 400);
      const { error } = await admin.auth.admin.updateUserById(targetId, { password });
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "Unknown action: " + action }, 400);
  } catch (e) {
    return json({ error: (e as Error)?.message ?? String(e) }, 400);
  }
});
