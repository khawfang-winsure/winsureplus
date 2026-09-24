// Edge Function: credit-check — ร้านค้าเช็คเครดิตลูกค้าเองผ่านฟอร์มสาธารณะ (Wave 2, ครีม 2026-09-23)
// อ้างอิง: scratchpad/credit-check-api-contract.md + credit-check-decisions.md, migration 0164 (prod แล้ว)
// แก้ตามรีวิวติ๊ก (รอบ 1, 2026-09-23) — ดูรายละเอียดแต่ละจุดที่คอมเมนต์ inline ใกล้โค้ดที่แก้
//
// verify_jwt: false ที่ gateway (deploy) — endpoint นี้ต้องรับ anon (ไม่มี login Supabase) จากร้านค้าได้
// action ทุกตัวเช็คสิทธิ์เองในนี้:
//   - login/sign_upload/submit/list: ไม่มี Supabase JWT เลย ยืนยันตัวด้วย "shop token" ที่เราเซ็นเอง (HMAC)
//   - staff_file_url: ต้องมี Supabase JWT จริง (admin/staff เท่านั้น) — เหมือน admin-users/media-sign
//
// Plain Deno.serve — ไม่ใช้ jsr:@supabase/server withSupabase wrapper (เคย 500 ในโปรเจกต์นี้ตาม CLAUDE.md)
//
// เอนจิ้นคำนวณ (creditCheck()) อยู่ที่ src/lib/creditCheck.ts (pure, ไม่มี import) — เพราะ MCP
// deploy_edge_function ไม่ได้ bundle จาก src/ ให้ จึงต้องมีสำเนาไฟล์เดียวกันเป๊ะอยู่ที่ ./creditCheck.ts
// (โฟลเดอร์เดียวกับไฟล์นี้) ก่อน deploy ทุกครั้งต้องรัน `node scripts/check-credit-engine-sync.mjs`
// ให้ผ่านก่อน (เทียบไฟล์ตรงตัว) ไม่งั้นฝั่งร้าน (ใช้ src/lib ตรงๆ ผ่าน Vite) กับฝั่ง server (ไฟล์นี้)
// จะคำนวณผลไม่ตรงกันแบบเงียบๆ
//
// R2 secret ใช้ชื่อเดียวกับ media-sign (ตั้งไว้แล้วบน prod): R2_ACCOUNT_ENDPOINT / R2_ACCESS_KEY_ID /
// R2_SECRET_ACCESS_KEY / R2_BUCKET — ไม่สร้าง secret ใหม่
//
// Shop session token: ไม่ใช่ Supabase JWT — เป็น token ที่เราเซ็นเอง HMAC-SHA256 คีย์ =
// SUPABASE_SERVICE_ROLE_KEY (ไม่ต้องมี secret ใหม่ — ข้อเสียของการ reuse คีย์นี้ ดู TODO ท้ายบล็อกนี้)
// รูปแบบ `<base64url(JSON payload)>.<hex signature>` payload = { shop_id, exp } อายุ 12 ชม. — verify ด้วย
// constant-time compare (safeCompare, ก๊อป pattern จาก smtp-speed-probe/index.ts) กัน timing attack ตอน
// ไล่เดา signature
//
// ห้าม log PII (national_id/ชื่อ/ที่อยู่) ขึ้น console เด็ดขาด — error ที่ log มีแค่ error message ภายใน
// (ปกติเป็นข้อความ DB/ระบบ ไม่ใช่ข้อมูลลูกค้า) ไม่ log body ทั้งก้อนที่ไหนเลยในไฟล์นี้ — และ (แก้ตามรีวิวติ๊ก
// [RED] #1) ไม่ส่ง error.message ของ Postgres/ระบบกลับไปให้ client เห็นเด็ดขาด ทุก path 5xx ที่ไม่ได้ตั้งใจ
// (unexpected DB error ฯลฯ) ไหลไปที่ catch-all ท้ายไฟล์เดียว log ของจริงไว้ฝั่ง server แล้วตอบ client ด้วย
// ข้อความไทยทั่วไปเท่านั้น — 4xx ที่ตั้งใจ (validation, rate limit, ปิดร้าน) ยังคงข้อความเฉพาะเจาะจงได้ตามปกติ
// เพราะไม่ใช่ error ภายในระบบ
//
// TODO (ก่อนเปิด rollout เต็ม — ค้างจากรีวิวติ๊กรอบนี้ ยังไม่ทำในรอบนี้):
//   - Turnstile: ยังไม่เปิดใช้ช่วง pilot (2 ร้านรู้จักตัวตน + PIN + rate limit + lockout ที่ 0164 พอ) —
//     จุดที่ต้องเพิ่มอยู่ที่คอมเมนต์ "// TODO(turnstile)" ใน action='login' ด้านล่าง
//   - POST-policy upload: ตอนนี้ยังเชื่อ `size`/`mime` ที่ client แจ้งตอน sign_upload เฉยๆ (ไม่ได้บังคับ
//     ด้วย S3 POST policy conditions บน R2 จริง) — ไฟล์ที่อัปเกินที่แจ้งไว้จะหลุดผ่านได้ถ้า client โกหก
//   - CREDIT_CHECK_HMAC_SECRET แยกต่างหาก: ตอนนี้ reuse SUPABASE_SERVICE_ROLE_KEY เป็น HMAC key เซ็น shop
//     token — ถ้า key นี้หลุด กระทบทั้ง service role (bypass ทุกตาราง) และ shop token พร้อมกัน แยก secret
//     ใหม่จะลดรัศมีระเบิดได้ (ต้องตั้ง secret ใหม่ผ่าน MCP ก่อน — ไม่ทำเองตอนนี้)

// @ts-nocheck
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.74.0";
import { AwsClient } from "npm:aws4fetch@1";
import { creditCheck, type CreditCheckInput, type CreditCheckLevel } from "./creditCheck.ts";

// ---------- CORS: allowlist จริง ไม่ใช่ "*" (ฟอร์มสาธารณะ แต่ไม่อยากให้เว็บอื่น embed เรียก endpoint นี้
// ผ่าน browser fetch ได้ง่ายๆ — CORS กันแค่ฝั่ง browser, curl/server ยังยิงตรงได้เสมอ ไม่ใช่กำแพงความปลอดภัยหลัก
// แค่ชั้นป้องกันเสริม) ----------
const CORS_EXACT = ["https://winsureplus.vercel.app", "http://localhost:5173"] as readonly string[];
const CORS_PREVIEW_RE = /^https:\/\/winsureplus-git-[a-z0-9-]+-winsureplus-projects\.vercel\.app$/i;

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (CORS_EXACT.includes(origin)) return true;
  return CORS_PREVIEW_RE.test(origin);
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": isAllowedOrigin(origin) ? (origin as string) : "https://winsureplus.vercel.app",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

// (รีวิวติ๊ก [RED] #1) ข้อความ error ทั่วไปที่ปลอดภัยส่งกลับ client ได้เสมอ ไม่มี detail ของระบบ/DB ปน —
// ใช้ตอน error ที่ "ไม่ได้ตั้งใจ" (unexpected) เท่านั้น ส่วน error ที่ตั้งใจ (validation/rate limit/ปิดร้าน)
// ยังคงใช้ข้อความเฉพาะเจาะจงตามปกติเพราะไม่ใช่ error ภายในระบบที่เสี่ยงหลุด schema/query
const GENERIC_ERROR_TH = "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง";

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in (e as Record<string, unknown>)) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

/** ร้านถูกปิดใช้ฟีเจอร์นี้ (active=false หรือ credit_check_enabled=false) — throw แล้วให้ catch-all
 *  ท้ายไฟล์จับแปลงเป็น 401 ข้อความไทยที่ระบุ (แยกจาก error ระบบทั่วไปที่ตอบ GENERIC_ERROR_TH) */
class ShopDisabledError extends Error {
  constructor() {
    super("shop disabled or credit_check_enabled=false");
    this.name = "ShopDisabledError";
  }
}

// secret อาจมี trailing newline ติดมา — trim ก่อนใช้เสมอ (pattern เดิมทั้งโปรเจกต์)
const env = (k: string): string => (Deno.env.get(k) ?? "").trim();

// ---------- hashing / constant-time compare ----------

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// เทียบ string แบบ constant-time — ก๊อปจาก smtp-speed-probe/index.ts:66-77 ตรงๆ (hash ทั้งคู่ก่อนเทียบ
// กันความยาวสตริงต่างกันรั่ว timing เพิ่มเติมจาก naive ===)
async function safeCompare(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const arrA = new Uint8Array(digestA);
  const arrB = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < arrA.length; i++) diff |= arrA[i] ^ arrB[i];
  return diff === 0;
}

async function hmacHex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64urlEncode(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(str: string): string {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

// ---------- shop session token (ไม่ใช่ Supabase JWT — ดูคอมเมนต์หัวไฟล์) ----------

const TOKEN_TTL_SECONDS = 12 * 60 * 60; // 12 ชม.

async function signShopToken(shopId: string, secret: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payloadB64 = base64urlEncode(JSON.stringify({ shop_id: shopId, exp }));
  const sig = await hmacHex(secret, payloadB64);
  return `${payloadB64}.${sig}`;
}

interface VerifiedShopToken { shopId: string; exp: number }

async function verifyShopToken(token: unknown, secret: string): Promise<VerifiedShopToken | null> {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const dot = token.indexOf(".");
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!payloadB64 || !sig) return null;

  const expectedSig = await hmacHex(secret, payloadB64);
  if (!(await safeCompare(sig, expectedSig))) return null; // signature ไม่ตรง — token ปลอม/ถูกแก้

  let parsed: { shop_id?: unknown; exp?: unknown };
  try {
    parsed = JSON.parse(base64urlDecode(payloadB64));
  } catch {
    return null;
  }
  if (typeof parsed.shop_id !== "string" || typeof parsed.exp !== "number") return null;
  if (Math.floor(Date.now() / 1000) >= parsed.exp) return null; // หมดอายุ

  return { shopId: parsed.shop_id, exp: parsed.exp };
}

/** (รีวิวติ๊ก [RED] #2) เช็คซ้ำ shops.active + credit_check_enabled ทุกครั้งที่ใช้ shop token (ไม่ใช่แค่
 *  ตอน login) — token มีอายุ 12 ชม. ถ้าแอดมินกด "ปิด" ระหว่างนั้น (kill switch) ต้องมีผลทันทีในคำขอถัดไป
 *  ไม่ใช่รอ token หมดอายุเอง throw ShopDisabledError ให้ catch-all จับแปลงเป็น 401 ข้อความไทย */
async function assertShopEnabled(adminClient: ReturnType<typeof createClient>, shopId: string): Promise<void> {
  const { data, error } = await adminClient
    .from("shops")
    .select("active, credit_check_enabled")
    .eq("id", shopId)
    .maybeSingle();
  if (error) throw error; // ปัญหา DB จริง — ไหลไป catch-all ตอบ GENERIC_ERROR_TH
  if (!data || data.active !== true || data.credit_check_enabled !== true) {
    throw new ShopDisabledError();
  }
}

// ---------- IP hash (static salt จาก SERVICE_ROLE_KEY ตามที่ contract ระบุ — ไม่ใช้ daily salt) ----------

/** (รีวิวติ๊ก [YELLOW] #4) ลำดับความน่าเชื่อถือ: cf-connecting-ip (Cloudflare เซ็ตเอง แก้ไม่ได้จาก client
 *  ถ้าอยู่หลัง Cloudflare) > x-real-ip (reverse proxy ทั่วไปเซ็ต) > x-forwarded-for hop แรก (ปลอมง่ายสุด
 *  เพราะ client ยัดหัวเองได้ถ้าไม่มี proxy เชื่อถือได้คั่นกลาง) — แยกเป็นฟังก์ชันเดียวตรงนี้ให้ครีมปรับลำดับ/
 *  เพิ่ม header ได้ง่ายหลังทดสอบ spoof จริงบน environment ที่ deploy แล้ว (Supabase Edge Function อยู่หลัง
 *  Cloudflare หรือไม่ ยังไม่ยืนยัน 100% ตอนเขียนโค้ดนี้) */
function getClientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf && cf.trim()) return cf.trim();
  const xRealIp = req.headers.get("x-real-ip");
  if (xRealIp && xRealIp.trim()) return xRealIp.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff && xff.trim()) return xff.split(",")[0].trim();
  return "unknown";
}

async function hashIp(ip: string, salt: string): Promise<string> {
  return sha256Hex(`${ip}:${salt}`);
}

// มาสก์เลขบัตร/เอกสารเหลือ 4 ตัวท้าย — ตรรกะเดียวกับ v_credit_check_queue (0164) ใช้กับ action='list'
// (list ไม่ผ่าน view นั้นเพราะ view ต้องการ authenticated+RLS staff/admin — ที่นี่ query ตรงด้วย service_role
// แล้วมาสก์เองฝั่ง JS แทน)
function maskDigits(digits: string): string {
  if (digits.length <= 4) return digits;
  return "x".repeat(digits.length - 4) + digits.slice(-4);
}

// ---------- ไฟล์แนบ: ชนิด/ขนาดที่ยอมรับ ----------

const ALLOWED_FILE_KINDS = [
  "payslip",
  "statement",
  "work_photo",
  "facebook_screenshot",
  "id_card",
  "other",
] as readonly string[];
const ALLOWED_IMAGE_MIME = ["image/jpeg", "image/png", "image/webp", "image/heic"] as readonly string[];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_PDF_MIME = ["application/pdf"] as readonly string[];
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 10;
const SIGN_EXPIRES_SECONDS = 300; // 5 นาที

/** คืน error message ไทยถ้าไฟล์ไม่ผ่าน (kind/mime/ขนาด) — null = ผ่าน */
function validateFileSpec(f: any): string | null {
  if (!f || typeof f !== "object") return "ข้อมูลไฟล์แนบไม่ถูกต้อง";
  if (!ALLOWED_FILE_KINDS.includes(f.kind)) return `ชนิดไฟล์แนบไม่รู้จัก: ${f.kind}`;
  if (typeof f.mime !== "string") return "ไม่ระบุชนิดไฟล์ (mime)";
  if (ALLOWED_IMAGE_MIME.includes(f.mime)) {
    if (typeof f.size !== "number" || f.size <= 0 || f.size > MAX_IMAGE_BYTES) {
      return "ไฟล์รูปใหญ่เกิน 8 MB หรือขนาดไม่ถูกต้อง";
    }
  } else if (ALLOWED_PDF_MIME.includes(f.mime)) {
    if (typeof f.size !== "number" || f.size <= 0 || f.size > MAX_PDF_BYTES) {
      return "ไฟล์ PDF ใหญ่เกิน 10 MB หรือขนาดไม่ถูกต้อง";
    }
  } else {
    return `ชนิดไฟล์ไม่รองรับ: ${f.mime}`;
  }
  return null;
}

function extFromMime(mime: string): string {
  switch (mime) {
    case "image/jpeg": return ".jpg";
    case "image/png": return ".png";
    case "image/webp": return ".webp";
    case "image/heic": return ".heic";
    case "application/pdf": return ".pdf";
    default: return "";
  }
}

// Asia/Bangkok = UTC+7 คงที่ (ไม่มี DST) — บวก offset ตรงๆ พอ ไม่ต้องพึ่ง Intl.DateTimeFormat
function nowInBangkok(): Date {
  return new Date(Date.now() + 7 * 60 * 60 * 1000);
}
function bangkokTodayISO(): string {
  const n = nowInBangkok();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}-${String(n.getUTCDate()).padStart(2, "0")}`;
}
function bangkokYearMonth(): string {
  const n = nowInBangkok();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}`;
}

function buildR2Key(shopId: string, mime: string): string {
  return `credit-check/${shopId}/${bangkokYearMonth()}/${crypto.randomUUID()}${extFromMime(mime)}`;
}

// ---------- R2 presign (aws4fetch — pattern เดียวกับ media-sign) ----------

function makeAwsClient(): AwsClient {
  return new AwsClient({
    accessKeyId: env("R2_ACCESS_KEY_ID"),
    secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
    service: "s3",
    region: "auto",
  });
}

function readR2Config(): { endpoint: string; bucket: string } | null {
  const endpoint = env("R2_ACCOUNT_ENDPOINT");
  const accessKeyId = env("R2_ACCESS_KEY_ID");
  const secretAccessKey = env("R2_SECRET_ACCESS_KEY");
  const bucket = env("R2_BUCKET");
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { endpoint, bucket };
}

async function presignPut(aws: AwsClient, endpoint: string, bucket: string, key: string, mime: string): Promise<string> {
  const objectUrl = new URL(`${endpoint.replace(/\/$/, "")}/${bucket}/${key}`);
  objectUrl.searchParams.set("X-Amz-Expires", String(SIGN_EXPIRES_SECONDS));
  const signed = await aws.sign(objectUrl.toString(), {
    method: "PUT",
    headers: { "Content-Type": mime },
    aws: { signQuery: true },
  });
  return signed.url;
}

async function presignGet(aws: AwsClient, endpoint: string, bucket: string, key: string): Promise<string> {
  const objectUrl = new URL(`${endpoint.replace(/\/$/, "")}/${bucket}/${key}`);
  objectUrl.searchParams.set("X-Amz-Expires", String(SIGN_EXPIRES_SECONDS));
  const signed = await aws.sign(objectUrl.toString(), { method: "GET", aws: { signQuery: true } });
  return signed.url;
}

// ---------- แปลงระดับผลเอนจิ้น -> ค่า enum ฝั่ง DB (0164 engine_level check) ----------
const ENGINE_LEVEL_TO_DB: Record<CreditCheckLevel, string> = {
  fail: "fail",
  review: "needs_review",
  prelim_pass: "passed_preliminary",
};

const VALID_OCCUPATION = ["salaried", "freelancer", "government", "business_owner"] as readonly string[];
const VALID_DEVICE_CONDITION = ["iphone_new", "iphone_used", "ipad"] as readonly string[];
const STAFF_ROLES = ["admin", "staff"] as readonly string[];

// (รีวิวติ๊ก [YELLOW] #5) เพดานความยาว string กันฟอร์มยัด payload ใหญ่ผิดปกติ/DoS เบาๆ ผ่านช่อง text ยาวๆ
const MAX_LEN_CUSTOMER_NAME = 200;
const MAX_LEN_FACEBOOK_URL = 500;
const MAX_LEN_ID_NUMBER = 50;
const MAX_LEN_FREE_TEXT = 200; // consent_version ฯลฯ (decision/notes เป็นฝั่ง staff db.ts ไม่เกี่ยวกับ endpoint นี้)
const MAX_LEN_LOGIN_CODE = 50;

// (รีวิวติ๊ก [YELLOW] #5) เพดานขนาด body รวม กัน payload ใหญ่ผิดปกติ (ไฟล์จริงไม่ได้แนบมาใน JSON — มีแค่
// metadata + base64 เล็กๆ ถ้ามี ไม่ควรเกินนี้เลยในการใช้งานจริง)
const MAX_BODY_BYTES = 64 * 1024;

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, origin);

  const SUPABASE_URL = env("SUPABASE_URL");
  const ANON_KEY = env("SUPABASE_ANON_KEY");
  const SERVICE_ROLE = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE) {
    return json({ error: GENERIC_ERROR_TH }, 500, origin);
  }

  // (รีวิวติ๊ก [YELLOW] #5) เช็ค Content-Length ก่อนอ่าน body เต็ม (reject เร็ว ไม่เสีย CPU parse ของใหญ่)
  // แล้วยังเช็คความยาว raw text จริงซ้ำอีกชั้น (เผื่อ header ไม่ตรง/ถูกปลอม/ขาดหาย)
  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader && Number(contentLengthHeader) > MAX_BODY_BYTES) {
    return json({ error: "ข้อมูลที่ส่งใหญ่เกินไป" }, 413, origin);
  }

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return json({ error: "invalid request body" }, 400, origin);
  }
  if (rawBody.length > MAX_BODY_BYTES) {
    return json({ error: "ข้อมูลที่ส่งใหญ่เกินไป" }, 413, origin);
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid json" }, 400, origin);
  }
  const { action } = body ?? {};

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  const clientIp = getClientIp(req);
  const ipHash = await hashIp(clientIp, SERVICE_ROLE);

  try {
    // ================= action: login (anon) =================
    if (action === "login") {
      // TODO(turnstile): เพิ่มตรวจ Cloudflare Turnstile token จาก body.turnstile_token ตรงนี้ก่อน rate
      // limit — ยังไม่เปิดช่วง pilot (2 ร้านรู้จักตัวตน + PIN + rate limit + lockout ที่ mig 0164 พอแล้ว)
      const { login_code, pin } = body;
      if (
        typeof login_code !== "string" ||
        !login_code.trim() ||
        login_code.length > MAX_LEN_LOGIN_CODE ||
        typeof pin !== "string" ||
        !/^[0-9]{6}$/.test(pin)
      ) {
        return json({ ok: false, error: "กรุณากรอกรหัสร้านและ PIN 6 หลักให้ครบ" }, 400, origin);
      }

      // ยังไม่รู้ shop_id ตอนนี้ (ต้อง lookup จาก login_code ก่อน) — เช็ค rate เฉพาะฝั่ง IP ไปก่อน
      // (credit_check_rate_limit_ok เมื่อ p_shop_id=null จะข้าม shop-count แต่ยัง insert log ปกติ)
      const { data: rateOk, error: rateErr } = await adminClient.rpc("credit_check_rate_limit_ok", {
        p_shop_id: null,
        p_ip_hash: ipHash,
      });
      if (rateErr) throw rateErr; // (รีวิวติ๊ก [RED] #1) ไม่ส่ง rateErr.message กลับ — ไหลไป catch-all
      if (!rateOk) return json({ ok: false, error: "ลองมากเกินไป กรุณาลองใหม่ภายหลัง" }, 429, origin);

      const { data: loginRows, error: loginErr } = await adminClient.rpc("verify_shop_credit_login", {
        p_login_code: login_code.trim(),
        p_pin: pin,
        p_ip_hash: ipHash,
      });
      if (loginErr) throw loginErr;
      const result = Array.isArray(loginRows) ? loginRows[0] : loginRows;
      if (!result?.ok || !result?.shop_id) {
        return json({ ok: false, error: "รหัสร้านหรือ PIN ไม่ถูกต้อง" }, 401, origin);
      }

      const token = await signShopToken(result.shop_id as string, SERVICE_ROLE);
      return json({ ok: true, shop_name: result.shop_name, token }, 200, origin);
    }

    // ================= action: sign_upload (shop token) =================
    if (action === "sign_upload") {
      const verified = await verifyShopToken(body.token, SERVICE_ROLE);
      if (!verified) return json({ error: "เซสชันหมดอายุ กรุณาล็อกอินใหม่" }, 401, origin);
      await assertShopEnabled(adminClient, verified.shopId); // (รีวิวติ๊ก [RED] #2) kill switch ต้องมีผลทันที

      // (รีวิวติ๊ก [YELLOW] #3) rate limit ต่อร้าน+ต่อ IP เหมือน submit — กันร้านขอ presign URL รัวๆ
      const { data: rateOk, error: rateErr } = await adminClient.rpc("credit_check_rate_limit_ok", {
        p_shop_id: verified.shopId,
        p_ip_hash: ipHash,
      });
      if (rateErr) throw rateErr;
      if (!rateOk) return json({ error: "ขอสิทธิ์อัปโหลดถี่เกินไป กรุณาลองใหม่ภายหลัง" }, 429, origin);

      const { files } = body;
      if (!Array.isArray(files) || files.length === 0) {
        return json({ error: "ไม่มีไฟล์ให้ขอสิทธิ์อัปโหลด" }, 400, origin);
      }
      if (files.length > MAX_FILES_PER_REQUEST) {
        return json({ error: `แนบได้ไม่เกิน ${MAX_FILES_PER_REQUEST} ไฟล์ต่อครั้ง` }, 400, origin);
      }
      for (const f of files) {
        const err = validateFileSpec(f);
        if (err) return json({ error: err }, 400, origin);
      }

      const r2 = readR2Config();
      if (!r2) return json({ error: "ระบบอัปโหลดไฟล์ยังไม่พร้อม" }, 501, origin);
      const aws = makeAwsClient();

      const uploads: { r2_key: string; upload_url: string }[] = [];
      for (const f of files) {
        const r2_key = buildR2Key(verified.shopId, f.mime);
        const upload_url = await presignPut(aws, r2.endpoint, r2.bucket, r2_key, f.mime);
        uploads.push({ r2_key, upload_url });
      }
      return json({ uploads }, 200, origin);
    }

    // ================= action: submit (shop token) =================
    if (action === "submit") {
      const verified = await verifyShopToken(body.token, SERVICE_ROLE);
      if (!verified) return json({ error: "เซสชันหมดอายุ กรุณาล็อกอินใหม่" }, 401, origin);
      await assertShopEnabled(adminClient, verified.shopId); // (รีวิวติ๊ก [RED] #2)

      const { form, files, consent, consent_version } = body;

      if (
        consent !== true ||
        typeof consent_version !== "string" ||
        !consent_version.trim() ||
        consent_version.length > MAX_LEN_FREE_TEXT
      ) {
        return json({ error: "ต้องกดยินยอมให้เก็บข้อมูล (PDPA) ก่อนส่งคำขอ" }, 400, origin);
      }

      // rate limit ต่อร้าน+ต่อ IP ก่อนเขียนคำขอจริง (กัน spam ส่งคำขอรัวๆ)
      const { data: rateOk, error: rateErr } = await adminClient.rpc("credit_check_rate_limit_ok", {
        p_shop_id: verified.shopId,
        p_ip_hash: ipHash,
      });
      if (rateErr) throw rateErr;
      if (!rateOk) return json({ error: "ส่งคำขอถี่เกินไป กรุณาลองใหม่ภายหลัง" }, 429, origin);

      if (!form || typeof form !== "object") return json({ error: "ข้อมูลฟอร์มไม่ถูกต้อง" }, 400, origin);
      const {
        customerName,
        customerType,
        idNumber,
        idExpiryDate,
        birthDate,
        occupationType,
        deviceCondition,
        devicePrice,
        downPercent,
        termMonths,
        ourMonthlyPayment,
        pjMonthlyPayment,
        declaredMonthlyIncome,
        facebookUrl,
      } = form;

      if (typeof customerName !== "string" || !customerName.trim() || customerName.length > MAX_LEN_CUSTOMER_NAME) {
        return json({ error: `กรุณากรอกชื่อลูกค้า (ไม่เกิน ${MAX_LEN_CUSTOMER_NAME} ตัวอักษร)` }, 400, origin);
      }
      if (customerType !== "thai" && customerType !== "foreign") {
        return json({ error: "ประเภทลูกค้าไม่ถูกต้อง" }, 400, origin);
      }
      if (!VALID_OCCUPATION.includes(occupationType)) {
        return json({ error: "ประเภทอาชีพไม่ถูกต้อง" }, 400, origin);
      }
      if (!VALID_DEVICE_CONDITION.includes(deviceCondition)) {
        return json({ error: "ประเภทเครื่องไม่ถูกต้อง" }, 400, origin);
      }
      if (typeof idNumber !== "string" || !idNumber.trim() || idNumber.length > MAX_LEN_ID_NUMBER) {
        return json({ error: `กรุณากรอกเลขบัตร/เอกสารประจำตัว (ไม่เกิน ${MAX_LEN_ID_NUMBER} ตัวอักษร)` }, 400, origin);
      }
      if (typeof birthDate !== "string" || !birthDate.trim()) {
        return json({ error: "กรุณากรอกวันเกิด" }, 400, origin);
      }
      if (typeof facebookUrl === "string" && facebookUrl.length > MAX_LEN_FACEBOOK_URL) {
        return json({ error: `ลิงก์ Facebook ยาวเกินไป (ไม่เกิน ${MAX_LEN_FACEBOOK_URL} ตัวอักษร)` }, 400, origin);
      }

      if (!Array.isArray(files)) return json({ error: "ข้อมูลไฟล์แนบไม่ถูกต้อง" }, 400, origin);
      if (files.length > MAX_FILES_PER_REQUEST) {
        return json({ error: `แนบได้ไม่เกิน ${MAX_FILES_PER_REQUEST} ไฟล์ต่อครั้ง` }, 400, origin);
      }
      const requiredPrefix = `credit-check/${verified.shopId}/`;
      for (const f of files) {
        const err = validateFileSpec(f);
        if (err) return json({ error: err }, 400, origin);
        if (typeof f.r2_key !== "string" || !f.r2_key.startsWith(requiredPrefix)) {
          // กันร้าน A ยัด r2_key ของร้าน B (หรือ path มั่ว) มาผูกกับคำขอตัวเอง — ต้องตรงกับ shop ของ token เท่านั้น
          return json({ error: "ไฟล์แนบไม่ตรงกับร้านนี้ กรุณาอัปโหลดใหม่" }, 400, origin);
        }
      }

      const attachedFileKinds = files
        .map((f: any) => f.kind)
        .filter((k: string) => k === "payslip" || k === "statement" || k === "work_photo" || k === "other");

      const engineInput: CreditCheckInput = {
        today: bangkokTodayISO(),
        customerType,
        idNumber: String(idNumber).trim(),
        idExpiryDate: idExpiryDate ? String(idExpiryDate) : null,
        birthDate: String(birthDate),
        occupationType,
        deviceCondition,
        devicePrice: Number(devicePrice),
        downPercent: Number(downPercent),
        termMonths: Number(termMonths),
        ourMonthlyPayment: Number(ourMonthlyPayment),
        pjMonthlyPayment: Number(pjMonthlyPayment),
        declaredMonthlyIncome:
          declaredMonthlyIncome === null || declaredMonthlyIncome === undefined || declaredMonthlyIncome === ""
            ? null
            : Number(declaredMonthlyIncome),
        attachedFileKinds,
        facebookUrl: typeof facebookUrl === "string" ? facebookUrl : "",
      };

      if (
        !Number.isFinite(engineInput.devicePrice) ||
        !Number.isFinite(engineInput.termMonths) ||
        !Number.isFinite(engineInput.downPercent) ||
        !Number.isFinite(engineInput.ourMonthlyPayment) ||
        !Number.isFinite(engineInput.pjMonthlyPayment) ||
        (engineInput.declaredMonthlyIncome !== null && !Number.isFinite(engineInput.declaredMonthlyIncome))
      ) {
        return json({ error: "ตัวเลขในฟอร์มไม่ถูกต้อง" }, 400, origin);
      }

      const result = creditCheck(engineInput);
      const dbLevel = ENGINE_LEVEL_TO_DB[result.level];

      const { data: inserted, error: insErr } = await adminClient
        .from("credit_checks")
        .insert({
          shop_id: verified.shopId,
          customer_name: customerName.trim(),
          national_id: engineInput.idNumber,
          id_type: customerType,
          id_expiry: engineInput.idExpiryDate,
          birth_date: engineInput.birthDate,
          occupation_type: occupationType,
          declared_income: engineInput.declaredMonthlyIncome,
          device_price: engineInput.devicePrice,
          // เก็บเป็น % (0-100) ตรงกับ downPercent ของเอนจิ้น — ไม่ใช่จำนวนเงินบาท (ชื่อคอลัมน์ device_down
          // ใน 0164 ไม่ได้ล็อกหน่วยไว้ชัด เลือกใช้ % ให้ตรงกับ engine input โดยตรง ไม่ต้องแปลงกลับไปกลับมา
          // — แจ้งติ๊ก/คุณเตยไว้ในรายงานงานนี้แล้วว่าเป็นจุดตัดสินใจที่ควร sign-off)
          device_down: engineInput.downPercent,
          term_months: engineInput.termMonths,
          our_installment: engineInput.ourMonthlyPayment,
          pj_installment: engineInput.pjMonthlyPayment,
          facebook_url: engineInput.facebookUrl || null,
          consent_at: new Date().toISOString(),
          consent_text_version: consent_version,
          submitter_ip_hash: ipHash,
          engine_level: dbLevel,
          engine_reasons: result.reasons,
          engine_ratio: result.incomeRatio,
        })
        .select("id")
        .single();
      if (insErr) throw insErr; // (รีวิวติ๊ก [RED] #1)

      const creditCheckId = inserted.id as string;

      if (files.length > 0) {
        const fileRows = files.map((f: any) => ({
          credit_check_id: creditCheckId,
          kind: f.kind,
          r2_key: f.r2_key,
          mime: f.mime,
          size: f.size,
          sha256: typeof f.sha256 === "string" ? f.sha256 : null,
        }));
        const { error: filesErr } = await adminClient.from("credit_check_files").insert(fileRows);
        if (filesErr) {
          // แถวหลัก (credit_checks) ถูกสร้างไปแล้ว — supabase-js ไม่มี transaction ข้าม 2 insert ให้
          // rollback อัตโนมัติ — log ของจริงไว้ฝั่ง server เท่านั้น (รีวิวติ๊ก [RED] #1) แจ้ง client แบบ
          // ทั่วไปแต่ยังส่ง id กลับให้ (ไม่ใช่ PII) เผื่อ staff ต้องตามเรื่องต่อจากคำขอที่สร้างสำเร็จแล้ว
          console.error("[credit-check] submit: insert credit_check_files failed:", errMessage(filesErr));
          return json({ error: "บันทึกคำขอสำเร็จแต่แนบไฟล์ไม่สำเร็จ กรุณาติดต่อทีมงาน", id: creditCheckId }, 500, origin);
        }
      }

      return json(
        {
          id: creditCheckId,
          level: dbLevel,
          reasons_shop: result.reasons.map((r) => r.shopText),
          installment_used: result.installmentUsed,
          ratio: result.incomeRatio,
        },
        200,
        origin,
      );
    }

    // ================= action: list (shop token) =================
    if (action === "list") {
      const verified = await verifyShopToken(body.token, SERVICE_ROLE);
      if (!verified) return json({ error: "เซสชันหมดอายุ กรุณาล็อกอินใหม่" }, 401, origin);
      await assertShopEnabled(adminClient, verified.shopId); // (รีวิวติ๊ก [RED] #2)

      // (รีวิวติ๊ก [YELLOW] #3) limit สูงกว่า submit/sign_upload เพราะเป็นแค่อ่าน — ร้านกดรีเฟรชดูสถานะ
      // บ่อยๆ ได้ปกติ ไม่ควรโดน rate limit เดียวกับการเขียนข้อมูล
      const { data: rateOk, error: rateErr } = await adminClient.rpc("credit_check_rate_limit_ok", {
        p_shop_id: verified.shopId,
        p_ip_hash: ipHash,
        p_shop_limit: 120,
        p_ip_limit: 120,
      });
      if (rateErr) throw rateErr;
      if (!rateOk) return json({ error: "เรียกดูถี่เกินไป กรุณาลองใหม่ภายหลัง" }, 429, origin);

      const { data, error } = await adminClient
        .from("credit_checks")
        .select(
          "id, created_at, customer_name, national_id_digits, engine_level, blacklist_result, facebook_result, decision, decision_note",
        )
        .eq("shop_id", verified.shopId)
        .order("created_at", { ascending: false })
        .limit(30);
      if (error) throw error; // (รีวิวติ๊ก [RED] #1)

      const items = (data ?? []).map((r: any) => ({
        id: r.id,
        created_at: r.created_at,
        customer_name: r.customer_name,
        national_id_masked: maskDigits(r.national_id_digits ?? ""),
        engine_level: r.engine_level,
        blacklist_done: r.blacklist_result !== "not_checked",
        facebook_done: r.facebook_result !== "not_checked",
        decision: r.decision,
        decision_note: r.decision_note,
      }));
      return json({ items }, 200, origin);
    }

    // ================= action: staff_file_url (Supabase JWT — admin/staff เท่านั้น) =================
    if (action === "staff_file_url") {
      const authHeader = req.headers.get("Authorization") ?? "";
      const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false },
      });
      const { data: { user }, error: userErr } = await userClient.auth.getUser();
      if (userErr || !user) {
        return json({ error: "ต้องล็อกอินก่อน" }, 401, origin); // (รีวิวติ๊ก [RED] #1) ตัด detail ทิ้ง
      }

      const { data: profile, error: profileErr } = await adminClient
        .from("profiles")
        .select("role, active")
        .eq("id", user.id)
        .maybeSingle();
      if (profileErr) throw profileErr; // (รีวิวติ๊ก [RED] #1)
      if (!profile || !STAFF_ROLES.includes(profile.role) || profile.active === false) {
        return json({ error: "ไม่มีสิทธิ์เข้าถึงไฟล์นี้" }, 403, origin);
      }

      const { file_id } = body;
      if (!file_id) return json({ error: "file_id required" }, 400, origin);

      const { data: fileRow, error: fileErr } = await adminClient
        .from("credit_check_files")
        .select("r2_key")
        .eq("id", file_id)
        .maybeSingle();
      if (fileErr) throw fileErr; // (รีวิวติ๊ก [RED] #1)
      if (!fileRow) return json({ error: "ไม่พบไฟล์นี้" }, 404, origin);

      const r2 = readR2Config();
      if (!r2) return json({ error: "ระบบไฟล์ยังไม่พร้อม" }, 501, origin);
      const aws = makeAwsClient();
      const url = await presignGet(aws, r2.endpoint, r2.bucket, fileRow.r2_key as string);
      return json({ url }, 200, origin);
    }

    return json({ error: "unknown action" }, 400, origin);
  } catch (e) {
    // (รีวิวติ๊ก [RED] #2) ร้านถูกปิดใช้งาน — ข้อความเฉพาะเจาะจง ไม่ใช่ error ระบบ ปลอดภัยที่จะบอกตรงๆ
    if (e instanceof ShopDisabledError) {
      return json({ error: "ร้านนี้ยังไม่เปิดใช้การเช็คเครดิต กรุณาติดต่อทีมงาน" }, 401, origin);
    }
    // (รีวิวติ๊ก [RED] #1) จุดเดียวที่ log error ภายในจริง (ไม่มี PII ปนเพราะไม่ log body) — client ได้แค่
    // ข้อความไทยทั่วไปเสมอ ไม่ว่า error ภายในจะเป็นอะไร (Postgres/network/parse ฯลฯ)
    console.error("[credit-check] unhandled error:", errMessage(e));
    return json({ error: GENERIC_ERROR_TH }, 500, origin);
  }
});
