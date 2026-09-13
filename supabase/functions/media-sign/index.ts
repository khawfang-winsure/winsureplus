// Edge Function: media-sign — ออก presigned URL สำหรับอัป/โหลดรูป+คลิปเอกสารแนบสัญญาเมื่อ media_provider='r2'
// (ตอน provider='supabase' — ฝั่งเว็บอัปตรงผ่าน supabase-js storage SDK ไม่เรียกฟังก์ชันนี้เลย)
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
//
// (0154 Wave 2 — คลิปเทสล็อกเครื่อง `lock_test_video`) branch 'put' อ่าน kind ของ slot จาก
// app_settings.media_slots ฝั่ง server เท่านั้น (ห้ามเชื่อ kind จาก client) — kind==='video' ใช้กติกา
// mime video/mp4|video/quicktime + เพดาน app_settings.media_video_max_mb (fallback 10 MB ถ้าอ่านไม่ได้/
// ผิดรูปแบบ) ส่วน slot เดิม (ไม่มี kind หรือ kind ไม่ใช่ 'video') ใช้กติกาเดิมทุกอย่างไม่เปลี่ยน (8 MB, image
// mime) — ถ้า media_slots ยังไม่มี lock_test_video (ก่อน apply 0154) คำขอคลิปจะตกไปกติกาเดิม (image) แล้วโดน
// mime reject อย่างสุภาพ ไม่ crash (ดักไว้อีกชั้นด้วย looksLikeVideoMime เพื่อข้อความที่ตรงกว่า)
//
// ⚠️ signed Content-Length: เพิ่มเฉพาะ branch คลิป (ผ่าน aws4fetch `allHeaders:true` เพื่อดึง content-length
// ออกจาก UNSIGNABLE_HEADERS default) บังคับว่าขนาดจริงที่ PUT ต้องตรงกับ `bytes` ที่ประกาศตอนขอ sign เป๊ะ
// ไม่งั้น R2 ปฏิเสธด้วย signature mismatch — ยังไม่เคยทดสอบกับ R2 จริง (เหมือนกับ SigV4 presign เดิม) ต้อง
// smoke ก่อนเปิดใช้จริง ตั้งใจไม่แตะ branch รูปเดิมเพื่อกันของเดิมพัง (ดูรายละเอียดในรายงานที่ส่งพร้อมงานนี้)

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

// (0154 Wave 2) ช่องคลิปเทสล็อกเครื่อง — kind ต้องอ่านจาก media_slots ฝั่ง server เท่านั้น
const ALLOWED_VIDEO_MIME = ["video/mp4", "video/quicktime"] as readonly string[];
const DEFAULT_VIDEO_MAX_MB = 10; // fallback ถ้าอ่าน app_settings.media_video_max_mb ไม่ได้/ผิดรูปแบบ

interface MediaSlotDef {
  key: string;
  kind?: string;
}

interface AppSettingRow {
  key: string;
  value: string;
}

// secret ที่คุณเตยเคยวางมีขึ้นบรรทัดใหม่ท้ายค่า (trailing newline) → aws4fetch โยน "Invalid header value"
// เลยอ่านผ่าน helper นี้เสมอ แล้ว trim ก่อนใช้ทุกที่ — ว่างหลัง trim = ถือว่ายังไม่ได้ตั้ง
const env = (k: string) => (Deno.env.get(k) ?? "").trim();

// (0154 Wave 2) อ่าน media_slots + media_video_max_mb จาก DB ด้วย service-role client (bypass RLS ตาม
// grant 0017) — ทั้งคู่ parse แบบ defensive: ผิดรูปแบบ/หาไม่เจอ = fallback ปลอดภัย ไม่ throw ให้ 500 เปล่าๆ
//
// ⚠️ query นี้ถูกเรียกก่อนทุก put รวมถึงรูปเดิมที่ไม่เคยพึ่ง app_settings เลย — ถ้า query ล้ม (network blip ฯลฯ)
// ต้อง "ไม่ throw" เด็ดขาด ไม่งั้นการอัปรูปปกติทั้งบริษัทจะโดน 500 ไปด้วย แค่ log แล้วคืน fallback ที่ทำให้
// branch รูปทำงานเหมือนเดิมทุกอย่าง (slots=[] → isVideoSlot=false เสมอ → ตกไปกติกา image เดิม) ส่วนคลิปจะโดน
// ปฏิเสธแบบสุภาพ (ปลอดภัยฝั่งปฏิเสธ ไม่ใช่ฝั่งยอม)
async function loadMediaSettings(
  adminClient: ReturnType<typeof createClient>,
): Promise<{ slots: MediaSlotDef[]; videoMaxMb: number }> {
  const fallback = { slots: [] as MediaSlotDef[], videoMaxMb: DEFAULT_VIDEO_MAX_MB };

  const { data, error } = await adminClient
    .from("app_settings")
    .select("key, value")
    .in("key", ["media_slots", "media_video_max_mb"]);
  if (error) {
    console.error("loadMediaSettings: query app_settings failed, falling back", error.message);
    return fallback;
  }

  let slots: MediaSlotDef[] = [];
  let videoMaxMb = DEFAULT_VIDEO_MAX_MB;

  for (const row of (data ?? []) as AppSettingRow[]) {
    if (row.key === "media_slots") {
      try {
        const parsed: unknown = JSON.parse(row.value);
        if (Array.isArray(parsed)) slots = parsed as MediaSlotDef[];
      } catch {
        slots = []; // ผิดรูปแบบ — ถือว่าไม่มีช่องไหนเป็น video เลย (ตกไปกติกา image เดิม)
      }
    }
    if (row.key === "media_video_max_mb") {
      const n = Number(row.value);
      // clamp เพดานบน 25 MB — เกินนี้ยังไงก็แนบส่งเมลไม่ได้อยู่แล้ว ค่าผิดรูปแบบ/≤0 ใช้ fallback เดิม
      if (Number.isFinite(n) && n > 0) videoMaxMb = Math.min(n, 25);
    }
  }

  return { slots, videoMaxMb };
}

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

      // (0154 Wave 2) kind ของช่องมาจาก DB เท่านั้น — ห้ามเชื่อ client ว่านี่คือช่องคลิปหรือรูป
      const { slots, videoMaxMb } = await loadMediaSettings(adminClient);
      const slotDef = slots.find((s) => s && s.key === slotKey);
      const isVideoSlot = slotDef?.kind === "video";
      const looksLikeVideoMime = ALLOWED_VIDEO_MIME.includes(mime);

      if (!isVideoSlot && looksLikeVideoMime) {
        // ช่องนี้ยังไม่ถูกตั้งเป็น video ใน media_slots (เช่น apply mig 0154 ไม่ทัน) — ปฏิเสธสุภาพ ไม่ crash
        return json({ error: "ช่องนี้ยังไม่รองรับคลิป" }, 400);
      }

      if (isVideoSlot) {
        if (!ALLOWED_VIDEO_MIME.includes(mime)) {
          return json({ error: "รองรับเฉพาะคลิป mp4 หรือ mov" }, 400);
        }
        const maxVideoBytes = videoMaxMb * 1024 * 1024;
        if (bytes > maxVideoBytes) {
          return json({ error: `คลิปใหญ่เกิน ${videoMaxMb} MB` }, 400);
        }
      } else {
        if (!ALLOWED_MIME.includes(mime)) {
          return json({ error: "ชนิดไฟล์ไม่รองรับ (รับเฉพาะ jpeg/png/webp)" }, 400);
        }
        if (bytes > MAX_BYTES) {
          return json({ error: "ไฟล์ใหญ่เกิน 8 MB" }, 400);
        }
      }

      // upload = admin/staff เท่านั้น (mirror contract_media_insert policy, 0136) — freelancer/accounting อัปไม่ได้
      // (ใช้กติกาเดียวกันทั้งรูปและคลิป — ไม่แยกสิทธิ์ตาม kind)
      if (!PUT_ROLES.includes(profile.role)) {
        return json({ error: "อัปโหลดได้เฉพาะแอดมิน/พนักงานเท่านั้น" }, 403);
      }
      // เช็ค scope ต่อสัญญาด้วย user client (เกาะ RLS) — ผ่าน role gate ข้างบนแล้วยังต้องเห็นสัญญานี้จริง
      const { data: scopeRow, error: scopeErr } = await userClient
        .from("contracts").select("id").eq("id", contractId).maybeSingle();
      if (scopeErr) return json({ error: scopeErr.message }, 500);
      if (!scopeRow) return json({ error: "ไม่มีสิทธิ์เข้าถึงสัญญานี้" }, 403);

      // นามสกุลไฟล์ตาม mime: คลิป mp4/mov ตามชนิดจริง, รูปคง .jpg เดิมทุกกรณี (ไม่เปลี่ยนพฤติกรรมเดิม)
      const ext = isVideoSlot ? (mime === "video/quicktime" ? ".mov" : ".mp4") : ".jpg";
      const path = `${contractId}/${slotKey}/${crypto.randomUUID()}${ext}`;
      const objectUrl = new URL(`${R2_ACCOUNT_ENDPOINT.replace(/\/$/, "")}/${R2_BUCKET}/${path}`);
      objectUrl.searchParams.set("X-Amz-Expires", String(SIGN_EXPIRES_SECONDS));

      // signed Content-Length: เฉพาะ branch คลิป (ดูคอมเมนต์หัวไฟล์) — branch รูปคงเดิมเป๊ะไม่แตะ กันของเดิมพัง
      const signed = isVideoSlot
        ? await aws.sign(objectUrl.toString(), {
          method: "PUT",
          headers: { "Content-Type": mime, "Content-Length": String(bytes) },
          aws: { signQuery: true, allHeaders: true },
        })
        : await aws.sign(objectUrl.toString(), {
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
