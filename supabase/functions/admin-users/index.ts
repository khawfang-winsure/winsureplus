// Edge Function: admin-users — withSupabase + manual user client
// ใช้ withSupabase ตรวจ apikey, สร้าง user client เองเพื่อพา Authorization JWT ไปด้วย
// adminClient ใช้ service_role (bypass RLS) สำหรับ user mgmt

// @ts-nocheck
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import { createClient } from "npm:@supabase/supabase-js@2.46.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

export default {
  fetch: withSupabase({ auth: ["publishable", "secret"] }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    // ใช้ legacy anon ที่ auto-inject (รับทั้ง publishable JWT จาก gateway)
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    // สร้าง user client เอง พา Authorization JWT (Bearer access_token) ไปด้วย
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return json({ error: "ต้องล็อกอินก่อน", detail: userErr?.message }, 401);
    }

    // admin client (service role) — bypass RLS
    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    const { data: callerProfile, error: profileErr } = await adminClient
      .from("profiles").select("role, active").eq("id", user.id).maybeSingle();
    if (profileErr) return json({ error: profileErr.message }, 500);
    if (!callerProfile || callerProfile.role !== "admin" || callerProfile.active === false) {
      return json({ error: "เฉพาะแอดมินเท่านั้น" }, 403);
    }

    let body: any;
    try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
    const { action } = body ?? {};

    try {
      if (action === "list") {
        const { data, error } = await adminClient.from("profiles")
          .select("id, full_name, role, active, created_at")
          .order("created_at", { ascending: false });
        if (error) throw error;
        const { data: usersData, error: lsErr } = await adminClient.auth.admin.listUsers({ page: 1, perPage: 1000 });
        if (lsErr) throw lsErr;
        const emailMap = new Map(usersData.users.map((u: any) => [u.id, u.email]));
        return json({ users: (data ?? []).map((p: any) => ({ ...p, email: emailMap.get(p.id) ?? null })) });
      }

      if (action === "create") {
        const { email, password, fullName, role } = body;
        if (!email || !password || !fullName) return json({ error: "email/password/fullName ครบทุกช่อง" }, 400);
        if (role !== "admin" && role !== "staff") return json({ error: "role ต้องเป็น admin หรือ staff" }, 400);
        const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
          email, password, email_confirm: true, user_metadata: { full_name: fullName },
        });
        if (createErr) throw createErr;
        const newId = created.user!.id;
        const { error: upErr } = await adminClient.from("profiles").update({ full_name: fullName, role }).eq("id", newId);
        if (upErr) throw upErr;
        return json({ ok: true, id: newId });
      }

      if (action === "update") {
        const { id, fullName, role, password } = body;
        if (!id) return json({ error: "id required" }, 400);
        const patch: any = {};
        if (typeof fullName === "string") patch.full_name = fullName;
        if (role === "admin" || role === "staff") patch.role = role;
        if (Object.keys(patch).length) {
          const { error } = await adminClient.from("profiles").update(patch).eq("id", id);
          if (error) throw error;
        }
        if (typeof password === "string" && password.length > 0) {
          if (password.length < 6) return json({ error: "รหัสผ่านต้องอย่างน้อย 6 ตัว" }, 400);
          const { error } = await adminClient.auth.admin.updateUserById(id, { password });
          if (error) throw error;
        }
        return json({ ok: true });
      }

      if (action === "setActive") {
        const { id, active } = body;
        if (!id || typeof active !== "boolean") return json({ error: "id+active(boolean) required" }, 400);
        if (id === user.id && active === false) return json({ error: "ปิดบัญชีตัวเองไม่ได้ค่ะ" }, 400);
        const { error } = await adminClient.from("profiles").update({ active }).eq("id", id);
        if (error) throw error;
        return json({ ok: true });
      }

      return json({ error: "unknown action" }, 400);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }),
};
