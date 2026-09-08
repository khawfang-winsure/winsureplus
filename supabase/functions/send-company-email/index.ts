// Edge Function: send-company-email — ส่งอีเมลเอกสารสัญญา (พร้อมรูปแนบ) ให้บริษัท ผ่าน Gmail SMTP
//
// Plain Deno.serve — ไม่ใช้ jsr:@supabase/server withSupabase wrapper (เคยเจอ 500 ในโปรเจกต์นี้)
// auth เอง: Authorization header → createClient(ANON) → userClient.auth.getUser() → เช็ค profiles.role
// (admin/staff เท่านั้น) ด้วย service-role client (bypass RLS ตาม grant 0017)
//
// Server ตรวจ gate ซ้ำเสมอ (ไม่เชื่อฝั่ง client) — สัญญาที่สร้างตั้งแต่ media_gate_from ต้องมีรูปครบ 14 ช่อง
// (ตาม app_settings.media_slots) ก่อนส่งได้ เว้นแต่มีแถวใน contract_media_gate_override (แอดมินกดข้ามแล้ว)
//
// body/subject ก๊อปฟิลด์จาก buildEmailText (src/lib/messages.ts:114-138) มาเขียนใหม่ในนี้ตรงๆ
// เพราะ Edge Function รันบน Deno import จาก src/ ของ Vite bundle ไม่ได้
//
// Free-plan Edge limits: wall 150s / mem 256MB / CPU 2s — โหลดไฟล์แนบทีละไฟล์ (sequential) ห้าม parallel
// เพดาน 25 ไฟล์ / 18 MB รวม — เกิน → 413 ก่อนเริ่มโหลดไฟล์เลย (กัน CPU/mem บาน)

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
const MAX_FILES = 25;
const MAX_TOTAL_BYTES = 18 * 1024 * 1024; // 18 MB

// secret ที่คุณเตยเคยวางมีขึ้นบรรทัดใหม่ท้ายค่า (trailing newline) → aws4fetch โยน "Invalid header value"
// เลยอ่านผ่าน helper นี้เสมอ แล้ว trim ก่อนใช้ทุกที่ (GMAIL_*/R2_*) — ว่างหลัง trim = ถือว่ายังไม่ได้ตั้ง
const env = (k: string) => (Deno.env.get(k) ?? "").trim();

// slug ไฟล์แนบ ตาม spec-media-bam.md §3 — slug คงที่แม้ garuda_emblem ถูก relabel
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
};

function extFromMime(mime: string | null): string {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
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
  const { contractId } = body ?? {};
  if (!contractId) return json({ error: "contractId required" }, 400);

  // ---- 1) โหลดข้อมูลทั้งหมดที่ต้องใช้ ----
  const { data: contract, error: cErr } = await db.from("contracts").select("*").eq("id", contractId).maybeSingle();
  if (cErr) return json({ error: cErr.message }, 500);
  if (!contract) return json({ error: "ไม่พบสัญญา" }, 404);

  const { data: shop, error: sErr } = await db.from("shops").select("code, name").eq("id", contract.shop_id).maybeSingle();
  if (sErr) return json({ error: sErr.message }, 500);
  if (!shop) return json({ error: "ไม่พบร้านค้าของสัญญานี้" }, 500);

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
  const noteVideo = settings.media_email_note_video !== "false"; // default true
  const companyEmailCc = (settings.company_email_cc || "").trim();
  const replyToSender = settings.media_email_reply_to_sender === "true"; // default false
  const rawAttachSummary = settings.media_email_attach_summary;
  const attachSummaryMode: "short" | "full" | "off" =
    rawAttachSummary === "full" || rawAttachSummary === "off" ? rawAttachSummary : "short"; // ค่าไม่รู้จัก/ไม่มี -> short

  if (!companyEmailTo) {
    return json({ error: "ยังไม่ได้ตั้งอีเมลปลายทาง แจ้งแอดมินตั้งค่าก่อนส่ง" }, 400);
  }

  const { data: mediaRows, error: mErr } = await db
    .from("contract_media")
    .select("id, slot_key, storage_provider, path, bytes, mime, uploaded_at")
    .eq("contract_id", contractId)
    .is("deleted_at", null)
    .order("uploaded_at", { ascending: true });
  if (mErr) return json({ error: mErr.message }, 500);
  const files = mediaRows ?? [];

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

  // ---- 2.1) เช็ค review gate (0142, server-side, ไม่เชื่อฝั่ง client) ----
  // review_status: null = สัญญาเก่า/ยังไม่เข้า flow ตรวจ (unrestricted, พฤติกรรมเดิม) — mirror canSendEmail
  // ใน src/lib/review.ts (แบม): canSendEmail = status === null || status === 'approved'
  // นี่คือจุดเดียวที่ REST/curl ตรงสามารถแหกทุกปุ่ม UI ได้ — ต้องเช็คซ้ำเสมอ ห้ามเชื่อว่า UI เช็คมาแล้ว
  const reviewStatus: string | null = contract.review_status ?? null;
  if (reviewStatus !== null && reviewStatus !== "approved") {
    return json(
      { error: "ยังส่งไม่ได้ เคสนี้ยังไม่ผ่านการตรวจจากแอดมิน ต้องได้สถานะ \"ตรวจแล้ว\" ก่อนถึงส่งอีเมลได้" },
      409,
    );
  }

  // ---- 3) เพดานไฟล์แนบ (เช็คก่อนโหลดไฟล์จริงเลย กัน CPU/mem บานบน free plan) ----
  const totalBytes = files.reduce((sum: number, f: any) => sum + (f.bytes ?? 0), 0);
  if (files.length > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) {
    return json({ error: "แนบไฟล์เกินจำกัด (สูงสุด 25 ไฟล์ หรือ 18 MB รวม) ลบรูปซ้ำ/ไม่จำเป็นก่อนส่ง" }, 413);
  }

  // ---- 4) สร้าง subject/body (ก๊อปฟิลด์จาก buildEmailText messages.ts:114-138) ----
  const downAmount = Math.round(Number(contract.device_price) * (Number(contract.down_percent) / 100));
  const rentTotal = Number(contract.monthly_payment ?? 0) * Number(contract.term_months ?? 0);
  const baht = (n: number) => Math.round(n).toLocaleString("th-TH");

  const subject = `Partners รหัสร้าน ${shop.code} หมายเลขสัญญา : ${contract.contract_no}`;

  const slotByKey = Object.fromEntries(slots.map((s) => [s.key, s]));
  const slotCountByKey: Record<string, number> = {};
  for (const f of files) slotCountByKey[f.slot_key] = (slotCountByKey[f.slot_key] ?? 0) + 1;
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
    bodyLines.push(`แนบรูปเอกสาร ${files.length} ใบ (${attachSummaryParts.length} ช่อง): ${attachSummaryParts.join(", ")}`);
  } else if (attachSummaryMode === "short" && files.length > 0) {
    bodyLines.push(`แนบรูปเอกสาร ${files.length} ใบ`);
  }
  // attachSummaryMode === "off" -> ไม่ต่อบรรทัดนี้เลย
  if (noteVideo) {
    bodyLines.push("วิดีโอส่งแยกใน Gmail");
  }
  bodyLines.push(`ผู้ส่ง: ${callerProfile.full_name ?? ""}`);
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

  try {
    for (const f of files) {
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

  try {
    const info = await transporter.sendMail(mailOptions);

    await db.from("email_send_log").insert({
      contract_id: contractId,
      to_addr: companyEmailTo,
      subject,
      attachment_count: attachments.length,
      total_bytes: totalBytes,
      provider_message_id: info.messageId ?? null,
      status: "sent",
      sent_by: user.id,
      sent_at: nowISO,
    });

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
      totalBytes,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("email_send_log").insert({
      contract_id: contractId,
      to_addr: companyEmailTo,
      subject,
      attachment_count: attachments.length,
      total_bytes: totalBytes,
      status: "failed",
      error: msg,
      sent_by: user.id,
      sent_at: nowISO,
    });
    return json({ error: `ส่งอีเมลไม่สำเร็จ: ${msg}` }, 502);
  }
});
