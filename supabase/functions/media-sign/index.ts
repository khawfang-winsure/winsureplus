// Edge Function: media-sign — ออก presigned URL สำหรับอัป/โหลดรูปเอกสารแนบสัญญาเมื่อ media_provider='r2'
// (ตอน provider='supabase' — ค่าเริ่มต้นตอนนี้ — ฝั่งเว็บอัปตรงผ่าน supabase-js storage SDK ไม่เรียกฟังก์ชันนี้เลย)
//
// Plain Deno.serve — ไม่ใช้ jsr:@supabase/server withSupabase wrapper (เคยเจอ 500 ในโปรเจกต์นี้ที่ admin-users dev)
// auth เอง: ดึง Authorization header → createClient(ANON) → userClient.auth.getUser() → เช็ค profiles.role+active
// ด้วย service-role client (bypass RLS ตาม grant 0017)
//
// R2 ยังไม่ตั้ง secret จริง (wave 6) — ถ้าไม่ครบ R2_ACCOUNT_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET
// ตอบ 501 ทันที ไม่ throw ให้ 500 เปล่าๆ
//
// ⚠️ SigV4 presign ผ่าน aws4fetch ยังไม่เคยทดสอบกับ R2 จริง (ยังไม่มี secret ให้ลอง ณ ตอนเขียน) — ก่อนเปิดใช้จริง
//    ต้อง smoke test PUT/GET ตรงด้วยไฟล์เล็กๆ ก่อน (ดู CLAUDE.md เรื่อง verify ก่อนถือว่าเสร็จ)

// @ts-nocheck
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.74.0";
import { AwsClient } from "npm:aws4fetch@1";

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

const ALLOWED_ROLES = ["admin", "staff", "freelancer", "accounting"] as readonly string[];
const PUT_ROLES = ["admin", "staff"] as readonly string[]; // mirror contract_media_insert policy (0136)
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as readonly string[];
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB — ตรงกับ bucket contract-media file_size_limit (0136)
const SIGN_EXPIRES_SECONDS = 300; // 5 นาที

// secret ที่คุณเตยเคยวางมีขึ้นบรรทัดใหม่ท้ายค่า (trailing newline) → aws4fetch โยน "Invalid header value"
// เลยอ่านผ่าน helper นี้เสมอ แล้ว trim ก่อนใช้ทุกที่ — ว่างหลัง trim = ถือว่ายังไม่ได้ตั้ง
const env = (k: string) => (Deno.env.get(k) ?? "").trim();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const SUPABASE_URL = env("SUPABASE_URL");
  const ANON_KEY = env("SUPABASE_ANON_KEY");
  const SERVICE_ROLE = env("SUPABASE_SERVICE_ROLE_KEY");

  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) {
    return json({ error: "ต้องล็อกอินก่อน", detail: userErr?.message }, 401);
  }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  const { data: profile, error: profileErr } = await adminClient
    .from("profiles").select("role, active").eq("id", user.id).maybeSingle();
  if (profileErr) return json({ error: profileErr.message }, 500);
  if (!profile || !ALLOWED_ROLES.includes(profile.role) || profile.active === false) {
    return json({ error: "ไม่มีสิทธิ์เข้าถึงไฟล์รูปเอกสาร" }, 403);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const R2_ACCOUNT_ENDPOINT = env("R2_ACCOUNT_ENDPOINT");
  const R2_ACCESS_KEY_ID = env("R2_ACCESS_KEY_ID");
  const R2_SECRET_ACCESS_KEY = env("R2_SECRET_ACCESS_KEY");
  const R2_BUCKET = env("R2_BUCKET");

  if (!R2_ACCOUNT_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    return json({ error: "R2 ยังไม่ได้ตั้งค่า" }, 501);
  }

  const aws = new AwsClient({
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });

  try {
    const { action } = body ?? {};

    if (action === "put") {
      const { contractId, slotKey, mime, bytes } = body;
      if (!contractId || !slotKey || !mime || typeof bytes !== "number") {
        return json({ error: "contractId/slotKey/mime/bytes ครบทุกช่อง" }, 400);
      }
      if (!ALLOWED_MIME.includes(mime)) {
        return json({ error: "ชนิดไฟล์ไม่รองรับ (รับเฉพาะ jpeg/png/webp)" }, 400);
      }
      if (bytes > MAX_BYTES) {
        return json({ error: "ไฟล์ใหญ่เกิน 8 MB" }, 400);
      }
      // upload = admin/staff เท่านั้น (mirror contract_media_insert policy, 0136) — freelancer/accounting อัปไม่ได้
      if (!PUT_ROLES.includes(profile.role)) {
        return json({ error: "อัปโหลดได้เฉพาะแอดมิน/พนักงานเท่านั้น" }, 403);
      }
      // เช็ค scope ต่อสัญญาด้วย user client (เกาะ RLS) — ผ่าน role gate ข้างบนแล้วยังต้องเห็นสัญญานี้จริง
      const { data: scopeRow, error: scopeErr } = await userClient
        .from("contracts").select("id").eq("id", contractId).maybeSingle();
      if (scopeErr) return json({ error: scopeErr.message }, 500);
      if (!scopeRow) return json({ error: "ไม่มีสิทธิ์เข้าถึงสัญญานี้" }, 403);

      const path = `${contractId}/${slotKey}/${crypto.randomUUID()}.jpg`;
      const objectUrl = new URL(`${R2_ACCOUNT_ENDPOINT.replace(/\/$/, "")}/${R2_BUCKET}/${path}`);
      objectUrl.searchParams.set("X-Amz-Expires", String(SIGN_EXPIRES_SECONDS));

      const signed = await aws.sign(objectUrl.toString(), {
        method: "PUT",
        headers: { "Content-Type": mime },
        aws: { signQuery: true },
      });

      return json({ url: signed.url, path });
    }

    if (action === "get") {
      const { path } = body;
      if (!path) return json({ error: "path required" }, 400);

      // path convention: '<contract_id>/<slot_key>/<uuid>.jpg' (uploadMedia ใน db.ts) — ดึง contractId มาเช็ค scope
      const contractId = String(path).split("/")[0];
      const { data: scopeRow, error: scopeErr } = await userClient
        .from("contracts").select("id").eq("id", contractId).maybeSingle();
      if (scopeErr) return json({ error: scopeErr.message }, 500);
      if (!scopeRow) return json({ error: "ไม่มีสิทธิ์เข้าถึงสัญญานี้" }, 403);

      const objectUrl = new URL(`${R2_ACCOUNT_ENDPOINT.replace(/\/$/, "")}/${R2_BUCKET}/${path}`);
      objectUrl.searchParams.set("X-Amz-Expires", String(SIGN_EXPIRES_SECONDS));

      const signed = await aws.sign(objectUrl.toString(), {
        method: "GET",
        aws: { signQuery: true },
      });

      return json({ url: signed.url });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
