// Edge Function: send-company-email — ส่งอีเมลเอกสารสัญญา (พร้อมรูป+คลิปแนบ) ให้บริษัท ผ่าน Gmail SMTP
//
// Plain Deno.serve — ไม่ใช้ jsr:@supabase/server withSupabase wrapper (เคยเจอ 500 ในโปรเจกต์นี้)
// auth เอง: Authorization header → createClient(ANON) → userClient.auth.getUser() → เช็ค profiles.role
// (admin/staff เท่านั้น) ด้วย service-role client (bypass RLS ตาม grant 0017)
//
// Server ตรวจ gate ซ้ำเสมอ (ไม่เชื่อฝั่ง client) — สัญญาที่สร้างตั้งแต่ media_gate_from ต้องมีรูปครบ 16 ช่อง
// (ตาม app_settings.media_slots) ก่อนส่งได้ เว้นแต่มีแถวใน contract_media_gate_override (แอดมินกดข้ามแล้ว)
// + เกทตรวจของคุณเตย (review_status ต้อง approved) — ดู SECTION 2/2.1 ด้านล่าง
//
// body/subject ก๊อปฟิลด์จาก buildEmailText (src/lib/messages.ts:114-138) มาเขียนใหม่ในนี้ตรงๆ
// เพราะ Edge Function รันบน Deno import จาก src/ ของ Vite bundle ไม่ได้
//
// Free-plan Edge limits: wall 150s / mem 256MB / CPU 2s — โหลดไฟล์แนบทีละไฟล์ (sequential) ห้าม parallel
// เพดาน 30 ไฟล์ (ปรับ 2026-09-13: รูปจริงบางเคส 25 ไฟล์ + คลิป 1 = 26 เกินเพดานเดิม 25) / งบขนาดรวมอ่านจาก
// app_settings.media_email_max_total_mb (fallback 16 MB ถ้าอ่านไม่ได้/ค่า ≤0, clamp ไม่ให้เกิน 17 MB แม้ตั้ง
// มาจาก setting เกินนั้น — ผลทดสอบจริง Gmail SMTP รับ ~200 KB/s ทั้ง nodemailer และ raw SMTP: 17 MiB ใช้เวลา
// ~128-136s ชนเพดาน wall 150s ของ Edge Function พอดี เกินกว่านี้เสี่ยง timeout กลางทาง) — เกิน → 413 ก่อนเริ่ม
// โหลดไฟล์ + เช็คซ้ำระหว่างโหลดจริง
//
// ─── Wave 2 (2026-09-13) "แนบคลิปเทสล็อกในเมลบริษัท" — เพิ่มจาก Wave 1 (0154 schema):
//   1) video_required flag (mirror SQL media_gate_complete SECTION 5 + src/lib/media.ts isVideoRequired)
//      ผ่านฟังก์ชันใหม่ evaluateSendGates() — ไม่แตะ evaluateGate/isSlotRequired เดิม (generic อยู่แล้ว)
//   2) ตัดไฟล์ purged_at ออกจากการแนบจริง (ยังนับครบใน gate check) + รองรับ mime วิดีโอ
//   3) งบขนาดอ่านจาก media_email_max_total_mb (fallback 16MB, clamp ไม่เกิน 17MB) + เช็ค 2 ชั้น (ก่อนโหลด/ระหว่างโหลด)
//   4) email_send_log สถานะ 'sending' ก่อนยิง SMTP + attached_media_ids, ปฏิเสธ 409/413 ก็ log 'failed'
//   5) หลังส่งสำเร็จ: contract_media.emailed_at ประทับเฉพาะแถว lock_test_video (รูปไม่ purge ไม่ต้องประทับ)
//   6) dryRun:true — ประเมิน gate ครบ + งบขนาด ไม่โหลดไฟล์/ไม่ส่ง/ไม่เขียน log
//
// ⚠️ SECTION 2 (เกทตรวจรูป/คลิป, cutoff media_gate_from) และ SECTION 2.1 (เกทตรวจของคุณเตย, review_status)
// ด้านล่าง **ไม่ถูกแตะแม้บรรทัดเดียว** จาก Wave 1 — การบังคับจริงของ video_required (ใหม่ Wave 2) ทำผ่าน
// evaluateSendGates() ซึ่งรันเป็น pre-check ก่อนถึง SECTION 2/2.1 เสมอ (ดู comment เหนือ pre-check ด้านล่าง
// สำหรับเหตุผลที่ออกแบบแบบนี้แทนที่จะแก้ ctx.flags ใน SECTION 2 ตรงๆ)

// @ts-nocheck
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.74.0";
import nodemailer from "npm:nodemailer@6";
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

const ALLOWED_ROLES = ["admin", "staff"] as readonly string[];
const MAX_FILES = 30;
const DEFAULT_MAX_TOTAL_MB = 16; // fallback ถ้า app_settings.media_email_max_total_mb ว่าง/ผิดรูปแบบ/≤0
// เพดานบนสุดที่ยอมรับจาก setting แม้เจ้าของตั้งเกินมา (clamp) — วัดจริง (Wave 2, 2026-09-13): Gmail SMTP
// รับ ~200 KB/s ทั้ง nodemailer และ raw SMTP, 17 MiB ใช้เวลา ~128-136s ชนเพดาน wall 150s ของ Edge Function
// (free plan) พอดี เกินกว่านี้เสี่ยง timeout กลางทาง (เมลอาจส่งถึงจริงแต่ function ถูกฆ่าก่อนอัปเดต log/
// contracts — ดู comment แถว 'sending' ด้านล่าง) เจ้าของเลือกใช้จริงที่ 16 MB (DEFAULT_MAX_TOTAL_MB ด้านบน)
// เผื่อ margin จากเพดาน clamp นี้
const MAX_ALLOWED_TOTAL_MB = 17;

// secret ที่คุณเตยเคยวางมีขึ้นบรรทัดใหม่ท้ายค่า (trailing newline) → aws4fetch โยน "Invalid header value"
// เลยอ่านผ่าน helper นี้เสมอ แล้ว trim ก่อนใช้ทุกที่ (GMAIL_*/R2_*) — ว่างหลัง trim = ถือว่ายังไม่ได้ตั้ง
const env = (k: string) => (Deno.env.get(k) ?? "").trim();

// slug ไฟล์แนบ ตาม spec-media-bam.md §3 — slug คงที่แม้ garuda_emblem ถูก relabel
// lock_test_video เพิ่ม Wave 2 (2026-09-13) — ตรงกับ SLOT_SLUG ใน src/lib/media.ts (แบม) เป๊ะ
const SLOT_SLUG: Record<string, string> = {
  id_card_front: "01-id-card",
  occupation_photo: "02-occupation",
  device_around: "03-device",
  box_back: "04-box-back",
  warranty_check: "04-1-warranty",
  settings_about: "05-settings-about",
  imei_photo: "06-imei",
  battery_health: "07-battery",
  garuda_emblem: "08-garuda",
  contract_docs: "09-contract",
  id_copy_consent: "10-id-consent",
  receipt: "11-receipt",
  customer_id_imei: "12-customer-imei",
  credit_check: "13-credit-check",
  credit_history_evidence: "13-1-credit-history",
  device_on_off: "14-device-onoff",
  lock_test_video: "15-lock-test-video",
};

function extFromMime(mime: string | null): string {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "video/mp4") return "mp4";
  if (mime === "video/quicktime") return "mov";
  return "jpg"; // image/jpeg และ default
}

// ---- re-implement evaluateSlots (pure, ย่อจาก src/lib/media.ts ของแบม) เฉพาะส่วนที่ต้องใช้ทาง server ----
interface SlotDef {
  key: string;
  label: string;
  sortOrder: number;
  min: number;
  max: number | null;
  required: "always" | "never" | { when: "condition"; equals: "new" | "used" } | { when: "flag"; name: string };
  relabel?: { when: "origin"; equals: "th" | "inter"; label: string };
}

function isSlotRequired(
  slot: SlotDef,
  ctx: { condition: string; origin: string; flags: Record<string, boolean> },
): boolean {
  if (slot.required === "always") return true;
  if (slot.required === "never") return false;
  if (slot.required.when === "condition") return ctx.condition === slot.required.equals;
  if (slot.required.when === "flag") return ctx.flags[slot.required.name] === true;
  return false;
}

function slotLabel(slot: SlotDef, origin: string): string {
  if (slot.relabel && slot.relabel.when === "origin" && slot.relabel.equals === origin) return slot.relabel.label;
  return slot.label;
}

// ไม่แก้ฟังก์ชันนี้ — รับ ctx.flags เป็น Record<string, boolean> ทั่วไปอยู่แล้ว จึงรองรับ flag ใหม่
// "video_required" ได้ทันทีโดยไม่ต้องแก้ signature (ผู้เรียกเป็นคนประกอบ flags object เอง — ดู evaluateSendGates)
function evaluateGate(
  slots: SlotDef[],
  ctx: { condition: string; origin: string; flags: Record<string, boolean> },
  counts: Record<string, number>,
): { complete: boolean; missingText: string[] } {
  const missingText: string[] = [];
  const sorted = [...slots].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const slot of sorted) {
    const required = isSlotRequired(slot, ctx);
    if (!required) continue;
    const count = counts[slot.key] ?? 0;
    if (count < slot.min) {
      const label = slotLabel(slot, ctx.origin);
      missingText.push(count > 0 ? `${label} (มี ${count}/${slot.min})` : label);
    }
  }
  return { complete: missingText.length === 0, missingText };
}

// ---------------------------------------------------------------------------------------------
// (Wave 2) video_required — mirror ตรงตัวของ isVideoRequired ใน src/lib/media.ts (แบม) และ
// media_gate_complete SECTION 5 ใน 0154 — 3 ที่นี้ต้องตรงกันเป๊ะ แก้กฎต้องแก้ทั้ง 3 จุด
// ---------------------------------------------------------------------------------------------

function isValidDateString(s: string | null | undefined): boolean {
  if (!s) return false;
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return false;
  return !Number.isNaN(Date.parse(s.slice(0, 10)));
}

function computeVideoRequired(
  createdAt: string | null,
  emailSentAt: string | null,
  requiredFrom: string | null,
): boolean {
  if (!isValidDateString(requiredFrom)) return false; // ว่าง/ผิดรูปแบบ -> ไม่บังคับ ห้าม throw
  if (emailSentAt) return false; // เคยส่งเมลบริษัทไปแล้ว -> ไม่บังคับซ้ำ
  if (!createdAt) return false;
  return createdAt.slice(0, 10) >= (requiredFrom as string).slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// (Wave 2) evaluateSendGates — จุดบังคับจริงของ "เกทตรวจรูป/คลิป" (รวม video_required) + "เกทตรวจคุณเตย"
// สำหรับ dryRun และ pre-check-ก่อน-log — ตั้งใจแยกจาก SECTION 2/2.1 ด้านล่างซึ่งเป็นโค้ด Wave 1 เดิมที่
// **ห้ามแตะ** (ตามสั่ง) เพื่อให้ diff ของ SECTION 2/2.1 เป็น 0 บรรทัด แต่ยังบังคับ video_required ได้จริง —
// เพราะฟังก์ชันนี้ทำงาน (และอาจ return early ก่อน) เสมอก่อนถึง SECTION 2/2.1 บนเส้นทาง real-send และ
// dryRun ไม่เคยไปถึง SECTION 2/2.1 เลย (return ก่อน) SECTION 2/2.1 เดิมจึงกลายเป็น safety-net ซ้ำที่ทำงาน
// harmless เสมอ (ไม่มีทางที่ pre-check ปล่อยผ่านเคสที่ SECTION 2/2.1 เดิมจะ reject เพราะเดิมเข้มกว่าไม่เคยหลวมกว่า)
// ---------------------------------------------------------------------------------------------

interface GateEvalResult {
  isGated: boolean;
  gateOk: boolean;
  gateReason: string | null;
  reviewOk: boolean;
  reviewReason: string | null;
}

const REVIEW_REJECT_MSG =
  'ยังส่งไม่ได้ เคสนี้ยังไม่ผ่านการตรวจจากแอดมิน ต้องได้สถานะ "ตรวจแล้ว" ก่อนถึงส่งอีเมลได้';

async function evaluateSendGates(
  // deno-lint-ignore no-explicit-any
  db: any,
  contractId: string,
  // deno-lint-ignore no-explicit-any
  contract: any,
  // deno-lint-ignore no-explicit-any
  files: any[],
  slots: SlotDef[],
  gateFrom: string,
  videoRequiredFromSetting: string | null,
): Promise<GateEvalResult> {
  const createdAt: string | null = contract.created_at ?? null;
  const isGated = !!createdAt && createdAt.slice(0, 10) >= gateFrom;

  let gateOk = true;
  let gateReason: string | null = null;

  if (isGated) {
    const videoRequired = computeVideoRequired(createdAt, contract.email_sent_at ?? null, videoRequiredFromSetting);
    const counts: Record<string, number> = {};
    for (const f of files) counts[f.slot_key] = (counts[f.slot_key] ?? 0) + 1;
    const gate = evaluateGate(
      slots,
      {
        condition: contract.condition,
        origin: contract.origin,
        flags: { credit_history_found: !!contract.credit_history_found, video_required: videoRequired },
      },
      counts,
    );
    if (!gate.complete) {
      const { data: overrideRows, error: oErr } = await db
        .from("contract_media_gate_override").select("id").eq("contract_id", contractId).limit(1);
      if (oErr) throw new Error(oErr.message);
      if (!overrideRows || overrideRows.length === 0) {
        gateOk = false;
        gateReason = `ยังส่งไม่ได้ ขาด: ${gate.missingText.join(", ")}`;
      }
    }
  }

  const reviewStatus: string | null = contract.review_status ?? null;
  const reviewOk = !(isGated && reviewStatus !== "approved");

  return { isGated, gateOk, gateReason, reviewOk, reviewReason: reviewOk ? null : REVIEW_REJECT_MSG };
}

// ---------------------------------------------------------------------------------------------
// (Wave 2) budgetMessage — ข้อความไทยตอนเกินเพดานไฟล์แนบ (ใช้ทั้ง dryRun/pre-check/413 จริง)
// ---------------------------------------------------------------------------------------------

function budgetMessage(fileCount: number, totalBytes: number, maxBytes: number): string {
  const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
  const maxMb = (maxBytes / (1024 * 1024)).toFixed(0);
  const parts: string[] = [];
  if (fileCount > MAX_FILES) parts.push(`จำนวนไฟล์เกิน ${MAX_FILES} ไฟล์ (ตอนนี้ ${fileCount} ไฟล์)`);
  if (totalBytes > maxBytes) parts.push(`ขนาดรวมเกิน ${maxMb} MB (ตอนนี้ ${totalMb} MB)`);
  if (parts.length === 0) parts.push(`ขนาดรวม ${totalMb} MB เกินเพดาน ${maxMb} MB`);
  return `แนบไฟล์เกินจำกัด: ${parts.join(" และ ")} — ลบรูปที่ไม่จำเป็นออกหรือย่อคลิปให้เล็กลงก่อนส่งใหม่`;
}

// ---------------------------------------------------------------------------------------------
// (Wave 2) formatThaiDate — วันที่ไทยสั้นๆ (พ.ศ.) สำหรับบรรทัด "คลิปเทสล็อกส่งไปแล้วเมื่อ ..."
// ---------------------------------------------------------------------------------------------

const THAI_MONTH_ABBR = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];

function formatThaiDate(iso: string): string {
  const d = new Date(iso);
  const day = d.getUTCDate();
  const month = THAI_MONTH_ABBR[d.getUTCMonth()];
  const yearBE = d.getUTCFullYear() + 543;
  return `${day} ${month} ${yearBE}`;
}

// ---------------------------------------------------------------------------------------------
// (Wave 2) logRejected — บันทึก email_send_log สถานะ 'failed' ตอนปฏิเสธด้วย 409/413 (ก่อนหน้านี้ไม่ log)
// 'failed' เป็นค่าที่ constraint เดิม (0138) รับอยู่แล้วก่อน apply 0154 — insert นี้จึงไม่พังแม้ยังไม่ apply
// migration ใหม่ (ต่างจาก insert สถานะ 'sending' ตอนจะยิง SMTP จริง ที่ต้องมี 0154 เท่านั้น) — กัน error ตรงนี้
// ไม่ให้บัง response 409/413 หลักที่จะ return อยู่แล้ว (best-effort, ไม่ throw)
// ---------------------------------------------------------------------------------------------

async function logRejected(
  // deno-lint-ignore no-explicit-any
  db: any,
  args: { contractId: string; to: string; subject: string; userId: string; error: string; totalBytes?: number; attachmentCount?: number },
): Promise<void> {
  try {
    await db.from("email_send_log").insert({
      contract_id: args.contractId,
      to_addr: args.to,
      subject: args.subject,
      attachment_count: args.attachmentCount ?? 0,
      total_bytes: args.totalBytes ?? 0,
      status: "failed",
      error: args.error,
      sent_by: args.userId,
      sent_at: new Date().toISOString(),
    });
  } catch {
    // ห้ามให้การ log พังบัง error หลักที่กำลังจะ return อยู่แล้ว (409/413) — เงียบไว้พอ
  }
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

  const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  const { data: callerProfile, error: profileErr } = await db
    .from("profiles").select("role, active, full_name").eq("id", user.id).maybeSingle();
  if (profileErr) return json({ error: profileErr.message }, 500);
  if (!callerProfile || !ALLOWED_ROLES.includes(callerProfile.role) || callerProfile.active === false) {
    return json({ error: "เฉพาะแอดมิน/พนักงานเท่านั้นที่ส่งอีเมลนี้ได้" }, 403);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const { contractId, dryRun } = body ?? {};
  if (!contractId) return json({ error: "contractId required" }, 400);

  // ---- 1) โหลดข้อมูลทั้งหมดที่ต้องใช้ ----
  const { data: contract, error: cErr } = await db.from("contracts").select("*").eq("id", contractId).maybeSingle();
  if (cErr) return json({ error: cErr.message }, 500);
  if (!contract) return json({ error: "ไม่พบสัญญา" }, 404);

  const { data: shop, error: sErr } = await db.from("shops").select("code, name").eq("id", contract.shop_id).maybeSingle();
  if (sErr) return json({ error: sErr.message }, 500);
  if (!shop) return json({ error: "ไม่พบร้านค้าของสัญญานี้" }, 500);

  // subject ยกมาคำนวณตั้งแต่ต้น (เดิมอยู่ใน "SECTION 4") เพราะต้องใช้ใน logRejected ตอน 409/413 ด้วย
  const subject = `Partners รหัสร้าน ${shop.code} หมายเลขสัญญา : ${contract.contract_no}`;

  const { data: settingsRows, error: setErr } = await db
    .from("app_settings")
    .select("key, value")
    .in("key", [
      "media_slots",
      "media_gate_from",
      "company_email_to",
      "media_email_note_video",
      "company_email_cc",
      "media_email_reply_to_sender",
      "media_email_attach_summary",
      "media_video_required_from", // (Wave 2)
      "media_email_max_total_mb", // (Wave 2)
    ]);
  if (setErr) return json({ error: setErr.message }, 500);
  const settings = Object.fromEntries((settingsRows ?? []).map((r: any) => [r.key, r.value as string]));

  let slots: SlotDef[] = [];
  try {
    slots = JSON.parse(settings.media_slots ?? "[]");
  } catch {
    slots = [];
  }
  const gateFrom = settings.media_gate_from || "2026-09-09";
  const companyEmailTo = (settings.company_email_to || "").trim();
  const noteVideo = settings.media_email_note_video !== "false"; // default true (แต่ปัจจุบันตั้งเป็น 'false')
  const companyEmailCc = (settings.company_email_cc || "").trim();
  const replyToSender = settings.media_email_reply_to_sender === "true"; // default false
  const rawAttachSummary = settings.media_email_attach_summary;
  const attachSummaryMode: "short" | "full" | "off" =
    rawAttachSummary === "full" || rawAttachSummary === "off" ? rawAttachSummary : "short"; // ค่าไม่รู้จัก/ไม่มี -> short
  const videoRequiredFromSetting: string | null = settings.media_video_required_from ?? null; // (Wave 2)

  // (Wave 2) งบขนาดรวมต่อเมล — อ่านจาก app_settings.media_email_max_total_mb, fallback 16 MB ถ้าอ่านไม่ได้/
  // ผิดรูปแบบ/≤0, clamp ไม่ให้เกิน MAX_ALLOWED_TOTAL_MB (17) แม้ตั้งมาจาก setting เกินนั้น (เหตุผล/ตัวเลขที่
  // วัดจริง ดู comment เหนือ MAX_ALLOWED_TOTAL_MB ด้านบน)
  const rawMaxMb = Number(settings.media_email_max_total_mb);
  const effectiveMaxMb = Number.isFinite(rawMaxMb) && rawMaxMb > 0
    ? Math.min(rawMaxMb, MAX_ALLOWED_TOTAL_MB)
    : DEFAULT_MAX_TOTAL_MB;
  const MAX_TOTAL_BYTES = Math.round(effectiveMaxMb * 1024 * 1024);

  if (!companyEmailTo) {
    return json({ error: "ยังไม่ได้ตั้งอีเมลปลายทาง แจ้งแอดมินตั้งค่าก่อนส่ง" }, 400);
  }

  // (Wave 2) เพิ่ม purged_at/emailed_at เข้า select — purged_at ใช้ตัดไฟล์ที่ไม่มีอยู่จริงใน storage
  // ออกจากการแนบ (แต่ยังนับครบใน gate check ต่อ — ดู evaluateSendGates/SECTION 2), emailed_at ใช้แสดง
  // บรรทัด "คลิปเทสล็อกส่งไปแล้วเมื่อ ..." ตอนคลิปถูก purge ไปแล้วแต่ต้องส่งเมลซ้ำ
  const { data: mediaRows, error: mErr } = await db
    .from("contract_media")
    .select("id, slot_key, storage_provider, path, bytes, mime, uploaded_at, purged_at, emailed_at")
    .eq("contract_id", contractId)
    .is("deleted_at", null)
    .order("uploaded_at", { ascending: true });
  if (mErr) return json({ error: mErr.message }, 500);
  const files = mediaRows ?? []; // ทุกแถวที่ยังไม่ถูกลบ (รวม purged_at) — ใช้นับ gate check
  const attachableFiles = files.filter((f: any) => !f.purged_at); // (Wave 2) ไฟล์ที่ยังโหลด/แนบได้จริง

  // =====================================================================================
  // (Wave 2) 1.5) dryRun mode — ประเมิน auth (ทำแล้วด้านบน) + review gate + media gate (รวม video_required)
  // + งบขนาด (จาก bytes ใน DB) แล้วคืนผลทันที ไม่โหลดไฟล์/ไม่ส่ง/ไม่เขียน log/ไม่ประทับอะไร
  // ใช้ evaluateSendGates() ตัวเดียวกับ pre-check ของเส้นทาง real-send ด้านล่าง — ไม่แตะ/ไม่ผ่าน SECTION 2/2.1
  // =====================================================================================
  if (dryRun === true) {
    const gateEval = await evaluateSendGates(db, contractId, contract, files, slots, gateFrom, videoRequiredFromSetting);
    const totalBytes = attachableFiles.reduce((sum: number, f: any) => sum + (f.bytes ?? 0), 0);
    const fileCount = attachableFiles.length;
    const budgetOk = fileCount <= MAX_FILES && totalBytes <= MAX_TOTAL_BYTES;

    const reasons: string[] = [];
    if (gateEval.gateReason) reasons.push(gateEval.gateReason);
    if (gateEval.reviewReason) reasons.push(gateEval.reviewReason);
    if (!budgetOk) reasons.push(budgetMessage(fileCount, totalBytes, MAX_TOTAL_BYTES));

    return json({
      ok: gateEval.gateOk && gateEval.reviewOk && budgetOk,
      gateOk: gateEval.gateOk,
      reviewOk: gateEval.reviewOk,
      totalBytes,
      maxBytes: MAX_TOTAL_BYTES,
      fileCount,
      reasons,
    });
  }

  // =====================================================================================
  // (Wave 2) pre-check ก่อนถึง SECTION 2/2.1 เดิม — เพื่อ log 'failed' ตอนปฏิเสธ (ข้อ 4 ของสั่งงาน) และ
  // บังคับ video_required จริง โดยไม่ต้องแก้ SECTION 2/2.1 (ทำไม่ได้ตามคำสั่ง "ห้ามแตะแม้บรรทัดเดียว")
  // ถ้าผ่านตรงนี้ SECTION 2/2.1 ด้านล่างจะ evaluate ซ้ำแล้ว fall-through เฉยๆ (ไม่มีทาง reject เพิ่ม เพราะ
  // เกทเดิมไม่รู้จัก video_required เลย = หลวมกว่าไม่ใช่แน่นกว่า evaluateSendGates ด้านบนเสมอ)
  // =====================================================================================
  let preGate: GateEvalResult;
  try {
    preGate = await evaluateSendGates(db, contractId, contract, files, slots, gateFrom, videoRequiredFromSetting);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
  if (!preGate.gateOk) {
    await logRejected(db, { contractId, to: companyEmailTo, subject, userId: user.id, error: preGate.gateReason! });
    return json({ error: preGate.gateReason }, 409);
  }
  if (!preGate.reviewOk) {
    await logRejected(db, { contractId, to: companyEmailTo, subject, userId: user.id, error: preGate.reviewReason! });
    return json({ error: preGate.reviewReason }, 409);
  }

  // ---- 2) เช็ค gate (server-side, ไม่เชื่อฝั่ง client) ----
  const createdAt: string | null = contract.created_at ?? null;
  const isGated = !!createdAt && createdAt.slice(0, 10) >= gateFrom;

  if (isGated) {
    const countsBySlot: Record<string, number> = {};
    for (const f of files) {
      // นับ distinct ต่อ slot (ไฟล์ในตารางนี้ไม่มี sha256 ในผลลัพธ์นี้ — แต่ upload flow กันซ้ำ sha256 ไว้แล้วตอนอัป
      // จึงนับจำนวนแถวตรงๆ ได้ปลอดภัยพอสำหรับ gate check ฝั่งนี้)
      countsBySlot[f.slot_key] = (countsBySlot[f.slot_key] ?? 0) + 1;
    }
    const gate = evaluateGate(
      slots,
      {
        condition: contract.condition,
        origin: contract.origin,
        flags: { credit_history_found: !!contract.credit_history_found },
      },
      countsBySlot,
    );

    if (!gate.complete) {
      const { data: overrideRows, error: oErr } = await db
        .from("contract_media_gate_override")
        .select("id")
        .eq("contract_id", contractId)
        .limit(1);
      if (oErr) return json({ error: oErr.message }, 500);
      if (!overrideRows || overrideRows.length === 0) {
        return json({ error: `ยังส่งไม่ได้ ขาด: ${gate.missingText.join(", ")}` }, 409);
      }
    }
  }

  // ---- 2.1) เช็ค review gate (0142/0149, server-side, ไม่เชื่อฝั่ง client) ----
  // แก้บั๊ก 2026-09-12: เดิมเช็ค `reviewStatus !== null` ซึ่งปล่อย draft (สัญญา post-cutoff ที่ยังไม่กด
  // "ส่งให้คุณเตยตรวจ" ครั้งแรก — review_status เป็น null เหมือนสัญญาเก่า pre-cutoff) ให้ส่งเมลผ่านได้เลย
  // ผลจริง: 3 สัญญา (S00052PNQ001, S00026PNQ014, S00029PNQ037) ส่งเมลออกบริษัทจริงพร้อมไฟล์แนบ โดยคุณเตย
  // ไม่เคยเห็น/อนุมัติ — ห้ามแก้ย้อนหลัง 3 เคสนี้ (ดู contract_review_log เป็น append-only ตาม 0142 SECTION 2)
  //
  // ใช้ isGated (คำนวณไว้แล้วบรรทัด ~204 จาก media_gate_from เทียบ created_at) แยกสัญญาเก่า/ใหม่แทน
  // null ตรงๆ: isGated=false (pre-cutoff) → ไม่ gate เกทตรวจเลย (พฤติกรรมเดิม, review_status เป็น null
  // ถาวรสำหรับเคสเก่า) — isGated=true (post-cutoff) → ต้อง review_status === 'approved' เท่านั้นถึงส่งได้
  //
  // ⚠️ ห้ามย้ายเช็คนี้เข้าไปในบล็อก `if (isGated) { ... }` ด้านบน (บรรทัด ~206-234) — บล็อกนั้นมีทางออก
  // ผ่าน contract_media_gate_override (แอดมินกด "ข้ามการตรวจรูป") ซึ่งเป็นคนละเกทกับอันนี้ (เกทตรวจของ
  // คุณเตย) ถ้าปนกันจะกลายเป็นบั๊กชนิดเดียวกับที่กำลังแก้อยู่นี่แหละ — override ไม่ควร skip เกทตรวจได้
  const reviewStatus: string | null = contract.review_status ?? null;
  if (isGated && reviewStatus !== "approved") {
    return json(
      { error: "ยังส่งไม่ได้ เคสนี้ยังไม่ผ่านการตรวจจากแอดมิน ต้องได้สถานะ \"ตรวจแล้ว\" ก่อนถึงส่งอีเมลได้" },
      409,
    );
  }

  // ---- 2.2) หาชื่อผู้ตรวจ (contract.review_updated_by) — ใส่ในบรรทัดท้ายอีเมล ----
  // อยู่หลังเกททุกตัวผ่านแล้ว (เคสที่ถูกเกทปฏิเสธไปแล้วด้านบนไม่ต้องเสีย query นี้)
  // ⚠️ query error/exception ห้ามทำให้ส่งเมลล้มเหลว — ถือว่าหาชื่อผู้ตรวจไม่เจอ แล้วส่งเมลต่อตามปกติ
  let reviewerName: string | null = null;
  if (contract.review_updated_by) {
    try {
      const { data: reviewerProfile } = await db
        .from("profiles").select("full_name").eq("id", contract.review_updated_by).maybeSingle();
      reviewerName = reviewerProfile?.full_name ?? null;
    } catch {
      reviewerName = null;
    }
  }

  // ---- 3) เพดานไฟล์แนบ (เช็คก่อนโหลดไฟล์จริงเลย กัน CPU/mem บานบน free plan) ----
  // (Wave 2) ใช้ attachableFiles (ตัด purged_at ออกแล้ว) + MAX_TOTAL_BYTES จาก settings + log 'failed' ก่อน 413
  const totalBytes = attachableFiles.reduce((sum: number, f: any) => sum + (f.bytes ?? 0), 0);
  if (attachableFiles.length > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) {
    const msg = budgetMessage(attachableFiles.length, totalBytes, MAX_TOTAL_BYTES);
    await logRejected(db, {
      contractId, to: companyEmailTo, subject, userId: user.id, error: msg,
      totalBytes, attachmentCount: attachableFiles.length,
    });
    return json({ error: msg }, 413);
  }

  // ---- 4) สร้าง body (subject คำนวณไว้แล้วด้านบน — ก๊อปฟิลด์จาก buildEmailText messages.ts:114-138) ----
  const downAmount = Math.round(Number(contract.device_price) * (Number(contract.down_percent) / 100));
  const rentTotal = Number(contract.monthly_payment ?? 0) * Number(contract.term_months ?? 0);
  const baht = (n: number) => Math.round(n).toLocaleString("th-TH");

  // (Wave 2) แยกไฟล์รูป (ไม่รวมคลิป) ไว้นับ "แนบรูปเอกสาร N ใบ" — คลิปมีบรรทัดของตัวเองแยกต่างหาก (ข้อ 7)
  const imageAttachFiles = attachableFiles.filter((f: any) => f.slot_key !== "lock_test_video");
  const videoAttachFile = attachableFiles.find((f: any) => f.slot_key === "lock_test_video") ?? null;
  const purgedVideoFile = files.find((f: any) => f.slot_key === "lock_test_video" && f.purged_at) ?? null;

  const slotByKey = Object.fromEntries(slots.map((s) => [s.key, s]));
  const slotCountByKey: Record<string, number> = {};
  for (const f of imageAttachFiles) slotCountByKey[f.slot_key] = (slotCountByKey[f.slot_key] ?? 0) + 1;
  const attachSummaryParts = Object.entries(slotCountByKey)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => {
      const slot = slotByKey[key];
      const label = slot ? slotLabel(slot, contract.origin) : key;
      return { sortOrder: slot?.sortOrder ?? 999, text: `${label} (${count})` };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((x) => x.text);

  const bodyLines = [
    `Partners รหัสร้าน ${shop.code}`,
    `ผ่อนบริษัท ล็อก MDM`,
    `หมายเลขสัญญา : ${contract.contract_no}`,
    `หมายเลขใบแจ้งหนี้(INV) ${contract.inv_no ?? ""}`,
    `ชื่อลูกค้า : ${contract.customer_name}`,
    `สินทรัพย์รุ่น ${contract.model ?? ""} ${contract.storage ?? ""}`,
    `หมายเลขSN : ${contract.sn ?? ""}`,
    `ยอดจัดไฟแนนซ์ : ${baht(Number(contract.finance_amount ?? 0))} บาท`,
    `ราคาเช่าซื้อ (ราคาผ่อน*เดือน) : ${baht(rentTotal)} บาท`,
    `ค่าเช่าต่อเดือน : ${baht(Number(contract.monthly_payment ?? 0))} บาท`,
    `ระยะเวลาเช่าซื้อ : ${contract.term_months ?? 0} เดือน`,
    `ยอดเงินดาวน์ : ${baht(downAmount)} บาท`,
    `เรทดาวน์ : ${contract.down_percent} %`,
    `ชำระทุกวันที่ : ${contract.due_day}`,
    `เบอร์โทรลูกค้า : ${contract.phone ?? ""}`,
    `โทรศัพท์สำรอง1 ${contract.phone_alt1 ?? "-"}`,
    `โทรศัพท์สำรอง2 ${contract.phone_alt2 ?? "-"}`,
    `ลิงค์เฟสลูกค้า : ${contract.facebook_link ?? "-"}`,
    `เว็บไซต์นี้ : https://nebula.spaceoneinovative.com/login`,
  ];
  if (attachSummaryMode === "full" && attachSummaryParts.length > 0) {
    bodyLines.push(`แนบรูปเอกสาร ${imageAttachFiles.length} ใบ (${attachSummaryParts.length} ช่อง): ${attachSummaryParts.join(", ")}`);
  } else if (attachSummaryMode === "short" && imageAttachFiles.length > 0) {
    bodyLines.push(`แนบรูปเอกสาร ${imageAttachFiles.length} ใบ`);
  }
  // attachSummaryMode === "off" -> ไม่ต่อบรรทัดนี้เลย

  // (Wave 2) บรรทัดสถานะคลิปเทสล็อก — 3 กรณีแยกกันเด็ดขาด (มีแนบ / เคย purge ไปแล้ว / ไม่มีคลิปในเคสเลย)
  if (videoAttachFile) {
    bodyLines.push("แนบคลิปเทสล็อกเครื่อง 1 คลิป");
  } else if (purgedVideoFile?.emailed_at) {
    bodyLines.push(`คลิปเทสล็อกส่งไปแล้วเมื่อ ${formatThaiDate(purgedVideoFile.emailed_at)}`);
  } else if (noteVideo) {
    // ข้อความเดิม (ควบคุมด้วย media_email_note_video, ปัจจุบัน 'false') — แสดงเฉพาะไม่มีคลิปในเคสเลย
    bodyLines.push("วิดีโอส่งแยกใน Gmail");
  }

  // บรรทัดท้าย: ผู้ทำรายการ (contract.operator) | ตรวจโดย (reviewerName) | ผู้ส่ง (callerProfile.full_name)
  // — trim ก่อนเทียบ/แสดงเสมอ กันช่องว่างหัวท้ายทำให้เทียบชื่อไม่ตรงแล้วโชว์ซ้ำ (ดู spec ในงานนี้)
  const trimName = (s: unknown): string => (typeof s === "string" ? s.trim() : "");
  const operatorName = trimName(contract.operator);
  const senderName = trimName(callerProfile.full_name);
  const reviewerNameTrimmed = trimName(reviewerName);
  const isApproved = reviewStatus === "approved";
  const reviewerSameAsSender = isApproved && !!reviewerNameTrimmed && reviewerNameTrimmed === senderName;

  const lastLineParts = [
    operatorName ? `ผู้ทำรายการ: ${operatorName}` : null,
    isApproved && reviewerNameTrimmed ? `ตรวจโดย: ${reviewerNameTrimmed}` : null,
    !reviewerSameAsSender && senderName ? `ผู้ส่ง: ${senderName}` : null,
  ].filter(Boolean);
  if (lastLineParts.length > 0) bodyLines.push(lastLineParts.join(" | "));

  const text = bodyLines.join("\n");

  // ---- 5) โหลดไฟล์แนบทีละไฟล์ (sequential — ห้าม parallel บน free plan) ----
  const R2_ACCOUNT_ENDPOINT = env("R2_ACCOUNT_ENDPOINT");
  const R2_ACCESS_KEY_ID = env("R2_ACCESS_KEY_ID");
  const R2_SECRET_ACCESS_KEY = env("R2_SECRET_ACCESS_KEY");
  const R2_BUCKET = env("R2_BUCKET");
  const r2Client = (R2_ACCOUNT_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET)
    ? new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" })
    : null;

  const slotOrdinal: Record<string, number> = {};
  const attachments: Array<{ filename: string; content: Uint8Array; contentType: string }> = [];
  let downloadedBytes = 0; // (Wave 2) รวมไบต์ที่ดาวน์โหลดได้จริง ใช้เช็คระหว่างโหลด (ต่างจาก totalBytes ที่มาจาก DB)

  try {
    for (const f of attachableFiles) { // (Wave 2) ตัด purged_at ออกแล้วตั้งแต่ต้น
      let bytes: Uint8Array;
      if (f.storage_provider === "r2") {
        if (!r2Client) throw new Error(`R2 ยังไม่ได้ตั้งค่า แต่ไฟล์ ${f.path} เก็บบน R2`);
        const objectUrl = new URL(`${R2_ACCOUNT_ENDPOINT!.replace(/\/$/, "")}/${R2_BUCKET}/${f.path}`);
        const res = await r2Client.fetch(objectUrl.toString(), { method: "GET" });
        if (!res.ok) throw new Error(`โหลดไฟล์ ${f.path} จาก R2 ไม่สำเร็จ (${res.status})`);
        bytes = new Uint8Array(await res.arrayBuffer());
      } else {
        const { data: blob, error: dlErr } = await db.storage.from("contract-media").download(f.path);
        if (dlErr) throw new Error(`โหลดไฟล์ ${f.path} ไม่สำเร็จ: ${dlErr.message}`);
        bytes = new Uint8Array(await blob.arrayBuffer());
      }

      // (Wave 2) เช็คงบขนาดระหว่างโหลดจริง (ต่าง DB bytes อาจคลาดเคลื่อน) — เกิน abort ทันที ไม่ส่ง
      downloadedBytes += bytes.byteLength;
      if (downloadedBytes > MAX_TOTAL_BYTES) {
        const msg = budgetMessage(attachments.length + 1, downloadedBytes, MAX_TOTAL_BYTES);
        await logRejected(db, {
          contractId, to: companyEmailTo, subject, userId: user.id, error: msg,
          totalBytes: downloadedBytes, attachmentCount: attachments.length,
        });
        return json({ error: msg }, 413);
      }

      const slug = SLOT_SLUG[f.slot_key] ?? f.slot_key;
      const ext = extFromMime(f.mime);
      slotOrdinal[f.slot_key] = (slotOrdinal[f.slot_key] ?? 0) + 1;
      const n = slotOrdinal[f.slot_key];
      // ตั้งใจต่างจาก mediaFilename ใน src/lib/media.ts (แบม) ตรงที่ไฟล์แรกไม่มี suffix "-1"
      // (media.ts: mediaFilename(key,1,ext) === "slug-1.ext" เสมอ) — ชื่อไฟล์แนบอีเมลจริงยึดตามที่นี่ (server) เท่านั้น
      const filename = n > 1 ? `${slug}-${n}.${ext}` : `${slug}.${ext}`;
      attachments.push({ filename, content: bytes, contentType: f.mime || "image/jpeg" });
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }

  // ---- 6) ส่งเมลจริงผ่าน Gmail SMTP ----
  const GMAIL_USER = env("GMAIL_USER");
  const GMAIL_APP_PASSWORD = env("GMAIL_APP_PASSWORD");
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    return json({ error: "ยังไม่ได้ตั้งค่าบัญชีส่งอีเมล (GMAIL_USER/GMAIL_APP_PASSWORD) แจ้งแอดมิน" }, 501);
  }

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });

  const nowISO = new Date().toISOString();

  const mailOptions: Record<string, unknown> = {
    from: GMAIL_USER,
    to: companyEmailTo,
    subject,
    text,
    attachments,
  };
  if (companyEmailCc) mailOptions.cc = companyEmailCc;
  if (replyToSender && user.email) mailOptions.replyTo = user.email;

  // (Wave 2) insert แถว 'sending' + attached_media_ids ก่อนยิง SMTP จริง — ถ้า runtime ถูกฆ่ากลางทาง
  // แถวจะค้าง 'sending' เป็นสัญญาณ "ไม่แน่ชัด ตรวจกล่องเมลก่อนส่งซ้ำ" (ตามสั่ง)
  // ⚠️ ถ้า insert นี้พัง (เช่น migration 0154 ยังไม่ apply — คอลัมน์ attached_media_ids ไม่มี/constraint
  // ยังไม่รับ 'sending') ต้อง "ไม่ส่งเมลต่อ" (ตามข้อ 8: ห้ามพังเงียบ) ให้ error ชัดเจนแทน
  const attachedMediaIds = attachableFiles.map((f: any) => f.id);
  const { data: sendingLog, error: sendingLogErr } = await db
    .from("email_send_log")
    .insert({
      contract_id: contractId,
      to_addr: companyEmailTo,
      subject,
      attachment_count: attachments.length,
      total_bytes: downloadedBytes,
      status: "sending",
      attached_media_ids: attachedMediaIds,
      sent_by: user.id,
      sent_at: nowISO,
    })
    .select("id")
    .single();
  if (sendingLogErr || !sendingLog) {
    return json({
      error: `บันทึกสถานะก่อนส่งเมลไม่สำเร็จ (เช็คว่า migration 0154 apply แล้วหรือยัง): ${sendingLogErr?.message ?? "ไม่ทราบสาเหตุ"}`,
    }, 500);
  }
  const logId = sendingLog.id;

  try {
    const info = await transporter.sendMail(mailOptions);

    // (Wave 2) ประทับ contract_media.emailed_at เฉพาะแถว "คลิป" (lock_test_video) เท่านั้น — รูปไม่ purge
    // เลยไม่ต้องประทับ (ดู comment คอลัมน์นี้ใน 0154 SECTION 1: "รูปไม่ตั้งค่านี้ (ไม่ purge)")
    // ทำก่อน/พร้อมกับการประทับ contracts.email_sent_at ด้านล่าง (ไม่เปลี่ยนวิธีประทับ email_sent_at เดิม)
    const videoMediaIds = attachableFiles
      .filter((f: any) => f.slot_key === "lock_test_video")
      .map((f: any) => f.id);
    if (videoMediaIds.length > 0) {
      try {
        const { error: emailedAtErr } = await db
          .from("contract_media").update({ emailed_at: nowISO }).in("id", videoMediaIds);
        if (emailedAtErr) {
          // ไม่บล็อกการส่งที่สำเร็จแล้วจริง — ถ้าพังแค่กระทบ purge job ในอนาคต (ยังไม่มี job จริงในเวฟนี้)
          console.error("อัปเดต contract_media.emailed_at ไม่สำเร็จ:", emailedAtErr.message);
        }
      } catch (e) {
        console.error("อัปเดต contract_media.emailed_at ไม่สำเร็จ:", e instanceof Error ? e.message : String(e));
      }
    }

    // (แก้ 2026-09-13 ตามรีวิวติ๊ก) update สถานะ 'sent' ต้องเช็ค error — เดิมไม่เช็ค ถ้า update ล้ม
    // แถวจะค้างสถานะ 'sending' ทั้งที่เมลส่งถึงจริง ทำให้หน้าเว็บเตือนพนักงานผิดว่า "ไม่แน่ชัดว่าส่งถึงไหม"
    // เสี่ยงกดส่งซ้ำ — ลอง retry ได้อีก 1 ครั้ง (ไม่ loop) ถ้ายังล้มอีก ไม่ throw/ไม่เปลี่ยน response
    // (เมลส่งถึงแล้วจริง ต้องคืนผลสำเร็จเหมือนเดิม) ใส่ logWarning ให้หน้าเว็บ/ครีมเห็นแทน แล้วเดินหน้า
    // ประทับ contracts.email_sent_at ต่อตามปกติไม่ว่าผลตรงนี้จะเป็นอย่างไร
    let logWarning: string | null = null;
    let { error: sentUpdateErr } = await db.from("email_send_log").update({
      status: "sent",
      provider_message_id: info.messageId ?? null,
      total_bytes: downloadedBytes,
    }).eq("id", logId);
    if (sentUpdateErr) {
      console.error(
        `อัปเดต email_send_log เป็น 'sent' ไม่สำเร็จ (logId=${logId}, messageId=${info.messageId ?? "-"}): ${sentUpdateErr.message} — retry อีก 1 ครั้ง`,
      );
      ({ error: sentUpdateErr } = await db.from("email_send_log").update({
        status: "sent",
        provider_message_id: info.messageId ?? null,
        total_bytes: downloadedBytes,
      }).eq("id", logId));
      if (sentUpdateErr) {
        console.error(
          `retry อัปเดต email_send_log เป็น 'sent' ไม่สำเร็จอีกครั้ง (logId=${logId}, messageId=${info.messageId ?? "-"}): ${sentUpdateErr.message}`,
        );
        logWarning = "บันทึกสถานะส่งเมลไม่สำเร็จ แต่เมลส่งถึงแล้ว";
      }
    }

    await db.from("contracts").update({
      email_sent_at: nowISO,
      email_sent_by: callerProfile.full_name ?? null,
    }).eq("id", contractId);

    return json({
      ok: true,
      messageId: info.messageId ?? null,
      to: companyEmailTo,
      sentAt: nowISO,
      attachmentCount: attachments.length,
      totalBytes: downloadedBytes,
      ...(logWarning ? { logWarning } : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const { error: failedUpdateErr } = await db
      .from("email_send_log").update({ status: "failed", error: msg }).eq("id", logId);
    if (failedUpdateErr) {
      console.error(`อัปเดต email_send_log เป็น 'failed' ไม่สำเร็จ (logId=${logId}): ${failedUpdateErr.message}`);
    }
    return json({ error: `ส่งอีเมลไม่สำเร็จ: ${msg}` }, 502);
  }
});
