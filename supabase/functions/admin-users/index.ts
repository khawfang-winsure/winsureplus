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
        if (role !== "admin" && role !== "staff" && role !== "freelancer") return json({ error: "role ต้องเป็น admin, staff หรือ freelancer" }, 400);
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
        if (role === "admin" || role === "staff" || role === "freelancer") patch.role = role;
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

      // ── freelancer management ──────────────────────────────────────────────

      if (action === "listFreelancers") {
        // Admin only (already checked above)
        const { data: profiles, error: pErr } = await adminClient
          .from("profiles")
          .select("id, full_name, active, created_at")
          .eq("role", "freelancer")
          .order("created_at", { ascending: false });
        if (pErr) throw pErr;

        const { data: usersData, error: lsErr } = await adminClient.auth.admin.listUsers({ page: 1, perPage: 1000 });
        if (lsErr) throw lsErr;
        const emailMap = new Map(usersData.users.map((u: any) => [u.id, u.email]));

        // Fetch all currently active grade assignments for these freelancers in one query
        const ids = (profiles ?? []).map((p: any) => p.id);
        let gradeMap: Map<string, string[]> = new Map();
        if (ids.length > 0) {
          const { data: assignments, error: aErr } = await adminClient
            .from("freelancer_grade_assignments")
            .select("freelancer_id, grade")
            .in("freelancer_id", ids)
            .is("ended_at", null);
          if (aErr) throw aErr;
          for (const row of (assignments ?? [])) {
            const list = gradeMap.get(row.freelancer_id) ?? [];
            list.push(row.grade);
            gradeMap.set(row.freelancer_id, list);
          }
        }

        return json({
          freelancers: (profiles ?? []).map((p: any) => ({
            id: p.id,
            fullName: p.full_name || "(ไม่มีชื่อ)",
            email: emailMap.get(p.id) ?? null,
            active: p.active !== false,
            grades: (gradeMap.get(p.id) ?? []).sort(),
          })),
        });
      }

      if (action === "listFreelancerGrades") {
        // Admin only at this point (gate above blocks non-admin).
        // For a freelancer's own grades, the frontend uses getMyAssignedGrades() directly via RLS.
        const { id } = body;
        if (!id) return json({ error: "id required" }, 400);
        const { data, error } = await adminClient
          .from("freelancer_grade_assignments")
          .select("grade")
          .eq("freelancer_id", id)
          .is("ended_at", null);
        if (error) throw error;
        return json({ grades: (data ?? []).map((r: any) => r.grade).sort() });
      }

      if (action === "setFreelancerGrades") {
        // Admin only (already checked above)
        const { id, grades } = body;
        if (!id) return json({ error: "id required" }, 400);
        if (!Array.isArray(grades)) return json({ error: "grades ต้องเป็น array" }, 400);
        const valid = ["A", "B", "C", "D", "E"];
        for (const g of grades) {
          if (!valid.includes(g)) return json({ error: `grade ไม่ถูกต้อง: ${g}` }, 400);
        }

        // Verify target is actually a freelancer
        const { data: targetProfile, error: tErr } = await adminClient
          .from("profiles").select("role").eq("id", id).maybeSingle();
        if (tErr) throw tErr;
        if (!targetProfile || targetProfile.role !== "freelancer") {
          return json({ error: "user นี้ไม่ใช่ freelancer" }, 400);
        }

        const now = new Date().toISOString();

        // End-date grades NOT in the input that are currently active
        if (grades.length > 0) {
          const { error: e1 } = await adminClient
            .from("freelancer_grade_assignments")
            .update({ ended_at: now })
            .eq("freelancer_id", id)
            .is("ended_at", null)
            .not("grade", "in", `(${grades.map((g: string) => `"${g}"`).join(",")})`);
          if (e1) throw e1;
        } else {
          // Empty input = remove all grades
          const { error: e1 } = await adminClient
            .from("freelancer_grade_assignments")
            .update({ ended_at: now })
            .eq("freelancer_id", id)
            .is("ended_at", null);
          if (e1) throw e1;
        }

        // Upsert each grade in the input (handles re-add after end-date)
        for (const grade of grades) {
          const { error: e2 } = await adminClient
            .from("freelancer_grade_assignments")
            .upsert(
              { freelancer_id: id, grade, assigned_at: now, assigned_by: user.id, ended_at: null },
              { onConflict: "freelancer_id,grade" },
            );
          if (e2) throw e2;
        }

        // Return updated freelancer record
        const { data: updProfiles, error: upErr } = await adminClient
          .from("profiles").select("id, full_name, active").eq("id", id).maybeSingle();
        if (upErr) throw upErr;
        const { data: updGrades, error: ugErr } = await adminClient
          .from("freelancer_grade_assignments")
          .select("grade")
          .eq("freelancer_id", id)
          .is("ended_at", null);
        if (ugErr) throw ugErr;
        const { data: authUser } = await adminClient.auth.admin.getUserById(id);
        return json({
          ok: true,
          freelancer: {
            id,
            fullName: updProfiles?.full_name || "(ไม่มีชื่อ)",
            email: authUser?.user?.email ?? null,
            active: updProfiles?.active !== false,
            grades: (updGrades ?? []).map((r: any) => r.grade).sort(),
          },
        });
      }

      return json({ error: "unknown action" }, 400);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }),
};
