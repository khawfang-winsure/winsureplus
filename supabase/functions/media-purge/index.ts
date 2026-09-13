// Edge Function: media-purge — ลบคลิปเทสล็อกเครื่อง (contract_media.slot_key='lock_test_video') จริงจาก
// R2 storage หลังผ่าน retention (media_video_retention_days, ค่าเริ่มต้น 30 วัน) นับจาก
// contract_media.emailed_at (ประทับตอนอีเมลบริษัทส่งสำเร็จจริง — ดู 0154) — **รูปไม่ถูกแตะเลย**
//
// ⚠️ งานนี้ลบไฟล์จริง ย้อนคืนไม่ได้ — ทุกจุดที่ไม่แน่ใจให้เอียงไปทาง "ไม่ลบ" เสมอ:
//   - dryRun default true เมื่อเรียกด้วย JWT (ต้องตั้งใจส่ง dryRun:false ถึงจะลบจริง)
//   - เรียกด้วย cron secret → อ่าน app_settings.media_video_purge_enabled เป็นตัวตัดสินเปิด/ปิดจริง
//     (ไม่ใช่ 'true' เป๊ะ = dry run เสมอ ไม่สนใจ body.dryRun ที่ส่งมา)
//   - เคสที่ review_status อยู่ระหว่างตรวจ ('pending_review'/'needs_fix') → ข้ามไปก่อน (กันลบหลักฐาน
//     ระหว่างตรวจซ้ำ — เป็นกติกาความปลอดภัยของงานนี้ ไม่ใช่ข้อยกเว้นทางธุรกิจ เจ้าของสั่งลบทุกเคสไม่มีข้อยกเว้น)
//   - retention ตั้งผิด/ว่าง/<7 วัน → fallback 30 วัน (ห้ามลบเร็วกว่า 7 วันแม้ตั้งค่าผิด)
//   - R2 ลบไม่สำเร็จ (ไม่ใช่ 204/404) → ไม่ประทับ purged_at เด็ดขาด, log 'failed', ทำแถวถัดไปต่อ (ไม่ throw
//     ทั้งฟังก์ชัน กันแถวเดียวพังแล้วแถวอื่นไม่ได้ประมวลผล)
//
// Plain Deno.serve — ไม่ใช้ jsr:@supabase/server withSupabase wrapper (เคยเจอ 500 ในโปรเจกต์นี้)
// R2 delete ยิงตรงด้วย aws4fetch AwsClient.fetch() (เซิร์ฟเวอร์ต่อเซิร์ฟเวอร์ ไม่ต้อง presign URL แบบ
// media-sign) — pattern เดียวกับ r2-probe/index.ts
//
// auth 2 ทาง:
//   (ก) header x-cron-secret ตรวจผ่าน RPC public.verify_media_purge_secret (SECURITY DEFINER, service_role
//       เท่านั้นเรียกได้ — อ่าน Supabase Vault ชื่อ secret 'media_purge_cron_secret' ไม่ใช่ Edge Function
//       secret/env ตรงๆ แบบเดิม ดู 0155 SECTION 6) — RPC error หรือคืนไม่ใช่ true เป๊ะ = ปฏิเสธเสมอ
//       (fail-closed — ไม่มี "เปิดฟรีถ้ายังไม่ตั้ง secret ใน vault")
//   (ข) JWT ของ admin ที่ active (pattern เดียวกับ media-sign/r2-probe) สำหรับรันมือ/ทดสอบ
//
// deploy config: verify_jwt:false (ให้ฟังก์ชันเช็ค auth เอง — ทั้ง cron header และ JWT)

// @ts-nocheck
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.74.0";
import { AwsClient } from "npm:aws4fetch@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const ADMIN_ROLES = ["admin"] as readonly string[];
// slot_key hardcode 'lock_test_video' อยู่ในตัว RPC media_purge_candidates (0155) แล้ว ไม่ต้องประกาศซ้ำที่นี่
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 50;
const MIN_RETENTION_DAYS = 7;
const DEFAULT_RETENTION_DAYS = 30;

// secret ที่คุณเตยเคยวางมีขึ้นบรรทัดใหม่ท้ายค่า (trailing newline) → trim เสมอ (pattern เดิมของโปรเจกต์)
const env = (k: string) => (Deno.env.get(k) ?? "").trim();

interface Candidate {
  mediaId: string;
  contractId: string;
  contractNo: string;
  path: string;
  bytes: number;
  emailedAt: string;
}

interface Failure {
  mediaId: string;
  contractId: string;
  error: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const SUPABASE_URL = env("SUPABASE_URL");
  const ANON_KEY = env("SUPABASE_ANON_KEY");
  const SERVICE_ROLE = env("SUPABASE_SERVICE_ROLE_KEY");

  // ── auth ─────────────────────────────────────────────────────────────────
  let callerType: "cron" | "admin";

  const cronSecretHeader = req.headers.get("x-cron-secret") ?? "";

  if (cronSecretHeader !== "") {
    // มีการส่ง x-cron-secret มา — ตรวจผ่าน RPC verify_media_purge_secret (0155) ที่อ่าน Supabase Vault
    // ด้วย service-role client เท่านั้น (ฟังก์ชัน revoke จาก public/anon/authenticated แล้ว) — RPC error
    // หรือคืนไม่ใช่ true เป๊ะ = ปฏิเสธเสมอ (fail-closed รวมถึงกรณี extension supabase_vault ยังไม่เปิดใช้)
    const secretCheckClient = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    const { data: secretOk, error: secretErr } = await secretCheckClient.rpc("verify_media_purge_secret", {
      p_secret: cronSecretHeader,
    });
    if (secretErr || secretOk !== true) {
      return json({ error: "x-cron-secret ไม่ถูกต้อง", detail: secretErr?.message }, 401);
    }
    callerType = "cron";
  } else {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return json({ error: "ต้องล็อกอินก่อน (หรือส่ง x-cron-secret)", detail: userErr?.message }, 401);
    }

    const adminClientForAuth = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    const { data: profile, error: profileErr } = await adminClientForAuth
      .from("profiles").select("role, active").eq("id", user.id).maybeSingle();
    if (profileErr) return json({ error: profileErr.message }, 500);
    if (!profile || !ADMIN_ROLES.includes(profile.role) || profile.active === false) {
      return json({ error: "เฉพาะแอดมินเท่านั้นที่เรียกฟังก์ชันนี้ได้" }, 403);
    }
    callerType = "admin";
  }

  let body: any = {};
  try {
    const raw = await req.text();
    if (raw) body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // ── ตัดสิน dryRun ───────────────────────────────────────────────────────
  // cron: ยึด media_video_purge_enabled เท่านั้น (ไม่สนใจ body.dryRun ที่อาจส่งมา — กันเผลอ override)
  // admin (JWT): default true, ต้องส่ง dryRun:false ชัดเจนถึงจะลบจริง
  let dryRun: boolean;
  if (callerType === "cron") {
    const { data: enabledRow } = await db
      .from("app_settings").select("value").eq("key", "media_video_purge_enabled").maybeSingle();
    const enabled = (enabledRow?.value ?? "").trim() === "true";
    dryRun = !enabled;
  } else {
    dryRun = body?.dryRun !== false;
  }

  // ── retention days (setting ผิด/ว่าง/<7 → fallback 30 + log เตือน — ห้ามลบเร็วกว่า 7 วันแม้ตั้งผิด) ──
  const { data: retentionRow } = await db
    .from("app_settings").select("value").eq("key", "media_video_retention_days").maybeSingle();
  let retentionDays = DEFAULT_RETENTION_DAYS;
  const rawRetention = (retentionRow?.value ?? "").trim();
  const parsedRetention = Number(rawRetention);
  if (rawRetention === "" || !Number.isFinite(parsedRetention) || parsedRetention < MIN_RETENTION_DAYS) {
    console.warn(
      `media_video_retention_days ผิดรูปแบบ/ว่าง/น้อยกว่า ${MIN_RETENTION_DAYS} วัน (ค่าที่อ่านได้: "${rawRetention}") — ใช้ fallback ${DEFAULT_RETENTION_DAYS} วันแทน`,
    );
  } else {
    retentionDays = Math.floor(parsedRetention);
  }

  // ── limit (สูงสุด 50 เสมอ ไม่ว่า body จะส่งมาเท่าไหร่) ──────────────────
  const rawLimit = Number(body?.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const contractId: string | null = typeof body?.contractId === "string" && body.contractId ? body.contractId : null;

  // ── R2 secrets — ต้องครบก่อนจะลบจริงเท่านั้น (dry run ไม่แตะ storage เลย ไม่ต้องเช็ค) ────────────
  const R2_ACCOUNT_ENDPOINT = env("R2_ACCOUNT_ENDPOINT");
  const R2_ACCESS_KEY_ID = env("R2_ACCESS_KEY_ID");
  const R2_SECRET_ACCESS_KEY = env("R2_SECRET_ACCESS_KEY");
  const R2_BUCKET = env("R2_BUCKET");
  if (!dryRun && (!R2_ACCOUNT_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET)) {
    return json({ error: "R2 ยังไม่ได้ตั้งค่า — ปฏิเสธรันจริง (dry run ไม่ต้องใช้ R2)" }, 501);
  }

  // ── เลือกแถวที่ครบเงื่อนไข purge ผ่าน RPC media_purge_candidates (0155, SECURITY DEFINER, service_role
  // เท่านั้นเรียกได้) — กรอง review_status ('pending_review'/'needs_fix') ในฝั่ง DB ก่อนตัด limit แล้ว
  // (เดิม 2 ขั้นตอน: ดึง 500 แถวเก่าสุดจาก contract_media ก่อน แล้วค่อยกรองสถานะฝั่งแอป — ถ้า 500 แถวแรกติด
  // สถานะกำลังตรวจหมดพอดี จะไม่เหลือ candidate เลยทุกวันตลอดไป "starvation") retention floor 7 วันถูก
  // บังคับซ้ำในฟังก์ชัน SQL ด้วย ไม่ใช่พึ่งแค่ fallback ฝั่ง Edge นี้อย่างเดียว
  const { data: candidateRows, error: candidatesErr } = await db.rpc("media_purge_candidates", {
    p_retention_days: retentionDays,
    p_contract_id: contractId,
    p_limit: limit,
  });
  if (candidatesErr) return json({ error: candidatesErr.message }, 500);

  const candidates: Candidate[] = (candidateRows ?? []).map((r: any) => ({
    mediaId: r.media_id,
    contractId: r.contract_id,
    contractNo: r.contract_no ?? "",
    path: r.path,
    bytes: r.bytes,
    emailedAt: r.emailed_at,
  }));

  if (dryRun) {
    // dry run: ไม่แตะ storage/DB เลย แม้แต่ media_purge_log (กันปนกับสถิติของรอบจริง)
    return json({ ok: true, dryRun: true, retentionDays, candidates, purged: 0, failed: 0 });
  }

  // ── รันจริง: ต่อแถว sequential (ไม่ทำขนาน กันยิง R2/DB ถล่มและอ่าน error รายแถวง่ายกว่า) ──────────
  const aws = new AwsClient({
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });

  let purged = 0;
  let failed = 0;
  const failures: Failure[] = [];

  for (const c of candidates) {
    try {
      const objectUrl = new URL(`${R2_ACCOUNT_ENDPOINT.replace(/\/$/, "")}/${R2_BUCKET}/${c.path}`).toString();
      const res = await aws.fetch(objectUrl, { method: "DELETE" });

      // 204 (ลบสำเร็จ) หรือ 404 (ไม่มีไฟล์อยู่แล้ว — ถือว่าสำเร็จ ไม่ใช่ error กันไฟล์ถูกลบมือไปก่อนหน้า)
      if (res.ok || res.status === 404) {
        const { data: updated, error: updateErr } = await db
          .from("contract_media")
          .update({ purged_at: new Date().toISOString() })
          .eq("id", c.mediaId)
          .is("purged_at", null)
          .select("id");
        if (updateErr) throw new Error(`update contract_media ล้มเหลว: ${updateErr.message}`);

        if ((updated ?? []).length === 0) {
          // แถวนี้ถูก purge ไปแล้วโดยรอบอื่นระหว่างที่กำลังประมวลผล (race) — ไม่ใช่ error ข้ามไปเงียบๆ
          continue;
        }

        const { error: logErr } = await db.from("media_purge_log").insert({
          media_id: c.mediaId,
          contract_id: c.contractId,
          r2_path: c.path,
          bytes: c.bytes,
          emailed_at: c.emailedAt,
          result: "success",
        });
        if (logErr) console.error(`media_purge_log insert (success) ล้มเหลว media_id=${c.mediaId}:`, logErr.message);

        purged++;
      } else {
        const errText = `R2 DELETE ${res.status}`;
        failed++;
        failures.push({ mediaId: c.mediaId, contractId: c.contractId, error: errText });
        const { error: logErr } = await db.from("media_purge_log").insert({
          media_id: c.mediaId,
          contract_id: c.contractId,
          r2_path: c.path,
          bytes: c.bytes,
          emailed_at: c.emailedAt,
          result: "failed",
          error: errText,
        });
        if (logErr) console.error(`media_purge_log insert (failed) ล้มเหลว media_id=${c.mediaId}:`, logErr.message);
      }
    } catch (e) {
      const errText = e instanceof Error ? e.message : String(e);
      failed++;
      failures.push({ mediaId: c.mediaId, contractId: c.contractId, error: errText });
      try {
        await db.from("media_purge_log").insert({
          media_id: c.mediaId,
          contract_id: c.contractId,
          r2_path: c.path,
          bytes: c.bytes,
          emailed_at: c.emailedAt,
          result: "failed",
          error: errText,
        });
      } catch (logEx) {
        console.error(`media_purge_log insert (catch) ล้มเหลว media_id=${c.mediaId}:`, logEx);
      }
      // ไม่ throw — ทำแถวถัดไปต่อ
    }
  }

  return json({ ok: true, dryRun: false, retentionDays, candidates, purged, failed, failures });
});
