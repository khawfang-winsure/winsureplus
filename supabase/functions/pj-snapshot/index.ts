// Edge Function: pj-snapshot — ดึงข้อมูลสัญญาจากเว็บ PJ (Laravel เดิม ไม่มี API) มาเก็บแคชไว้เทียบกับค่าที่
// ทีมเราคีย์เอง ในแผงตรวจของคุณเตย (เฟส 2 ต่อจาก migration 0152 — ดู schema/comment ที่ไฟล์นั้น)
//
// 2 mode ต่อ 1 สัญญา ไม่มี loop ทั้งฐาน:
//   mode='snapshot' → staff+admin เรียกได้ (พนักงานกด "ส่งให้คุณเตยตรวจ" ยิงอัตโนมัติแบบ fire-and-forget) →
//     login PJ → หา uuid จาก inv_no → GET หน้าใบ → parse → upsert public.pj_contract_snapshot
//   mode='images'   → admin เท่านั้น → คืน "ตัวไฟล์รูป" (base64) ไม่ใช่ลิงก์ — คุณเตยเคาะแล้วว่าลิงก์รูปบัตร
//     ห้ามโผล่ในเบราว์เซอร์เลย ต้อง proxy bytes ผ่าน function นี้เสมอ (รับช้าได้ 3-8 วิ) ห้ามเก็บสำเนาไฟล์รูป
//     ไว้ที่ไหนทั้งนั้น (ไม่ storage.upload, ไม่ insert ตารางไหน) fetch สดทุกครั้งแล้วส่งผ่านไปเลย
//   mode='debug'    → admin เท่านั้น → เครื่องมือ diagnostic ชั่วคราว (mirror pj-sync debugInv pattern) ไม่เขียน
//     DB — ใช้ตรวจ anchor/โครง HTML จริงหลัง deploy โดยไม่ต้อง deploy ใหม่ทุกครั้งที่ปรับ parser
//
// ✅ LIVE ใช้งานจริงแล้ว (commit b3d5b49 — "เทียบข้อมูลสัญญากับ PJ ในแผงตรวจ") — smoke test ผ่าน mode='debug'
//   บน PJ จริงแล้ว: (1) โครง HTML ของ /manager/invoices/{uuid} ตรงกับที่ recon ไว้ (2) search[value] ใน
//   DataTable /manager/ajax/invoices/all ใช้ได้จริง (uuidLookupMethod ได้ 'search') (3) ลิงก์ "ดูภาพเต็ม" ยังเป็น
//   presigned S3 query string รูปแบบเดิม — 3 เรื่องนี้ยังคงคาลิเบรตต่อได้ถ้า PJ เปลี่ยนโครงหน้าในอนาคต ใช้
//   mode='debug' เช็คก่อนปรับ parser ทุกครั้ง (ไม่ต้อง deploy ใหม่ก็ยิงเช็คได้)
//
// Auth: ตาม pattern supabase/functions/media-sign/index.ts:43-64 — verify_jwt:false ที่ gateway, function เช็ค
//   เอง: Authorization header → createClient(ANON) → userClient.auth.getUser() → profiles.role/active (ผ่าน
//   service-role client, bypass RLS ตาม grant 0017) ⚠️ ไม่ใช่ static header key แบบ pj-sync (อันนั้นสำหรับ
//   pg_cron ไม่ใช่ user-triggered — คนละโมเดล auth กันคนละเหตุผล)
//
// ── โค้ดที่ก๊อปมาจาก supabase/functions/pj-sync/index.ts ตรงๆ (ห้ามทำ _shared module รอบนี้ตามที่สั่ง) ──
//   mergeSetCookies / cookieHeader / extractToken   → pj-sync/index.ts:84-123
//   login 3-step (GET login → extract _token → POST email/password → เช็ค 302 ไม่กลับไป /manager/login)
//                                                    → pj-sync/index.ts:453-491
//   parseAmount / pick                               → pj-sync/index.ts:147-178 (toIsoDate ของ pj-sync ไม่ได้
//     ก๊อปมา — ที่นี่เก็บวันที่เป็น raw string ตามที่ scrape ได้ (DD-MM-YYYY) แล้วปล่อยให้ parsePJDate ใน
//     src/lib/pjImport.ts ฝั่ง frontend แปลงตอนเทียบ ไม่ต้องแปลงซ้ำที่นี่ — รองรับ 2 รูปแบบอยู่แล้ว)
//   fetchInvoicesPage DataTable ต่อหน้า (POST /manager/ajax/invoices/all) → pj-sync/index.ts:568-612 — ขยาย
//     เพิ่มพารามิเตอร์ search[value] เป็นทางลัดก่อน paginate (ดู findInvoiceUuid ด้านล่าง)
//
// 🔴🔴 กฎเหล็ก (บทเรียนเลือดของไฟล์ pj-sync เอง — ดู pj-sync/index.ts:180-189, 918-930):
//   parseInvoiceDetailHtml เดิมเคยได้ rowCount=0 เพราะตารางในหน้าเติมด้วย ajax แล้วโค้ดตีความว่า "ข้อมูลจริง
//   (ไม่มีเงินเลย)" → เตือนผิด 93 เคสรวด ยึดตรงนี้ทั้งไฟล์:
//     - หา anchor หลักไม่เจอ (หัวเพจ "หมายเลขใบแจ้งหนี้" / การ์ดหลัก) → ok:false ทันที ไม่เดาต่อ
//     - parse ได้ไม่ครบ core fields (invoice_no, customer_name, national_id, finance_amount) → บันทึกเป็น
//       'failed' ห้ามบันทึกเป็น 'ok' ที่มีค่าว่าง (ค่าว่าง = แผงตรวจจะโชว์ "ตรงหมด" บนข้อมูลขยะ — อันตรายกว่า
//       error เห็นชัดๆ อีก)
//
// ⚠️ ห้าม log/return ค่า PJ_USERNAME / PJ_PASSWORD / cookie / token เด็ดขาด
// ⚠️ ห้ามแตะตาราง pj_sync_runs เลย (lock ของ pj-sync ที่รันทุก 15 นาที — ฟังก์ชันนี้ไม่ใช้ lock เดียวกัน กัน
//   ชนกับ auto-sync เงินโดยไม่ตั้งใจ)
// ⚠️ session PJ หมดอายุเร็วมาก (พิสูจน์แล้วจากงาน pj-sync — หลุดใน ~1 ชม.) → login ใหม่ทุกครั้งที่เรียก ไม่พยายาม
//   cache session ข้ามการเรียก

// @ts-nocheck
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.74.0";

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

const env = (k: string) => (Deno.env.get(k) ?? "").trim();

const SNAPSHOT_ROLES = ["admin", "staff"] as readonly string[];

const PJ_BASE = "https://pj-soft.net";
const LOGIN_URL = `${PJ_BASE}/manager/login`;
const INVOICES_URL = `${PJ_BASE}/manager/ajax/invoices/all`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const REQUEST_BUDGET_MS = 20000; // งบเวลารวมต่อ 1 การเรียก (snapshot) — เกินแล้วคืน failed ห้ามค้าง

// ============================================================================
// เวลา — deadline แบบ per-request (ห้ามใช้ global mutable ข้าม request เพราะ isolate เดียวรับหลาย request ได้)
// ============================================================================
interface Deadline {
  timeLeftMs(): number;
}
function makeDeadline(budgetMs: number): Deadline {
  const endAt = Date.now() + budgetMs;
  return { timeLeftMs: () => endAt - Date.now() };
}
function perCallTimeout(deadline: Deadline): number {
  return Math.max(1000, Math.min(10000, deadline.timeLeftMs()));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

// ============================================================================
// ── ก๊อปจาก pj-sync/index.ts:84-123 ตรงตัว (พิสูจน์ผ่านแล้ว) ──
// ============================================================================
function mergeSetCookies(jar: Map<string, string>, res: Response) {
  let setCookies: string[] = [];
  try {
    setCookies = (res.headers as any).getSetCookie?.() ?? [];
  } catch { /* ignore */ }
  if (setCookies.length === 0) {
    const raw = res.headers.get("set-cookie");
    if (raw) setCookies = [raw];
  }
  for (const line of setCookies) {
    const firstPair = line.split(";")[0];
    const eq = firstPair.indexOf("=");
    if (eq <= 0) continue;
    const name = firstPair.slice(0, eq).trim();
    const value = firstPair.slice(eq + 1).trim();
    if (name) jar.set(name, value);
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function extractToken(html: string): string | null {
  const patterns = [
    /name="_token"\s+value="([^"]+)"/i,
    /value="([^"]+)"\s+name="_token"/i,
    /name='_token'\s+value='([^']+)'/i,
    /value='([^']+)'\s+name='_token'/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1];
  }
  const meta = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/i);
  if (meta && meta[1]) return meta[1];
  return null;
}

// ── ก๊อปจาก pj-sync/index.ts:147-178 (parseAmount, pick) — toIsoDate ไม่ได้ก๊อปมา (ดู comment หัวไฟล์) ──
function parseAmount(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const cleaned = v.replace(/,/g, "").replace(/[^\d.-]/g, "").trim();
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function pick(row: any, keys: string[]): any {
  for (const k of keys) {
    if (row && row[k] != null && row[k] !== "") return row[k];
  }
  return null;
}

function digitsOnly(s: string): string {
  return s.replace(/[^\d]/g, "");
}

// ============================================================================
// Login PJ — 3-step ตาม pj-sync/index.ts:453-491 ตรงตัว (คืน token/xsrfToken แทน embed ใน scope ใหญ่)
// ============================================================================
type LoginResult =
  | { ok: true; token: string; xsrfToken: string }
  | { ok: false; reason: string };

async function loginPJ(jar: Map<string, string>, deadline: Deadline): Promise<LoginResult> {
  const PJ_USERNAME = env("PJ_USERNAME");
  const PJ_PASSWORD = env("PJ_PASSWORD");
  if (!PJ_USERNAME || !PJ_PASSWORD) {
    return { ok: false, reason: "PJ_USERNAME/PJ_PASSWORD ยังไม่ได้ตั้งค่า (secret ของ Supabase)" };
  }

  let r1: Response;
  try {
    r1 = await fetchWithTimeout(LOGIN_URL, {
      method: "GET",
      headers: { "User-Agent": UA, Accept: "text/html" },
      redirect: "manual",
    }, perCallTimeout(deadline));
  } catch (e) {
    return { ok: false, reason: `login: เปิดหน้า login ไม่สำเร็จ (${e instanceof Error ? e.message : String(e)})` };
  }
  mergeSetCookies(jar, r1);
  const html1 = await r1.text();
  const token = extractToken(html1);
  if (!token || jar.size === 0) {
    return { ok: false, reason: "login: ไม่ได้ token/cookie จากหน้า login" };
  }

  const loginBody = new URLSearchParams();
  loginBody.set("_token", token);
  loginBody.set("email", PJ_USERNAME);
  loginBody.set("password", PJ_PASSWORD);
  loginBody.set("remember", "on");

  let r2: Response;
  try {
    r2 = await fetchWithTimeout(LOGIN_URL, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader(jar),
        Referer: LOGIN_URL,
        Origin: PJ_BASE,
        Accept: "text/html",
      },
      body: loginBody.toString(),
      redirect: "manual",
    }, perCallTimeout(deadline));
  } catch (e) {
    return { ok: false, reason: `login: ส่ง form login ไม่สำเร็จ (${e instanceof Error ? e.message : String(e)})` };
  }
  mergeSetCookies(jar, r2);
  const location = r2.headers.get("location");
  await r2.text().catch(() => {});

  const is302 = r2.status >= 300 && r2.status < 400;
  const redirectAwayFromLogin = !!location && !/\/manager\/login\/?($|\?)/i.test(location);
  if (!(is302 && redirectAwayFromLogin)) {
    return { ok: false, reason: "login: ไม่สำเร็จ (รหัส/validation ไม่ผ่าน หรือ PJ เปลี่ยนหน้า login)" };
  }

  const xsrfRaw = jar.get("XSRF-TOKEN") ?? "";
  let xsrfToken = "";
  try {
    xsrfToken = decodeURIComponent(xsrfRaw);
  } catch {
    xsrfToken = xsrfRaw;
  }

  return { ok: true, token, xsrfToken };
}

// ============================================================================
// หา uuid จาก invoice_no — 1) ใช้ cache ถ้ามี  2) ลอง search[value] (ยังไม่ยืนยันสดว่า PJ รองรับ — verify ด้วย
// diagnostics.uuidLookupMethod)  3) fallback paginate ทั้งลิสต์ (pattern จาก pj-sync/index.ts:568-612)
// ============================================================================
const INV_PAGE_LENGTH = 500;
const INV_MAX_PAGES = 20; // recordsTotal ~2,400+ / 500 ≈ 5 หน้า — เผื่อโตในอนาคต กันวนไม่รู้จบ

async function fetchInvoicesPage(
  jar: Map<string, string>,
  token: string,
  xsrfToken: string,
  startOffset: number,
  searchValue: string | undefined,
  deadline: Deadline,
): Promise<{ rows: any[]; recordsTotal: number; recordsFiltered: number }> {
  const dtBody = new URLSearchParams();
  dtBody.set("draw", String(Math.floor(startOffset / INV_PAGE_LENGTH) + 1));
  dtBody.set("start", String(startOffset));
  dtBody.set("length", String(INV_PAGE_LENGTH));
  dtBody.set("_token", token);
  if (searchValue) {
    // (pj-snapshot ใหม่ — ยังไม่ยืนยันสด) DataTable server-side มาตรฐาน (yajra/laravel-datatables ก็ตาม
    // convention นี้) รับ search[value] เป็น global filter — ถ้า PJ implement ตาม convention ตัวนี้ควรกรองให้
    // เลย ไม่ต้อง paginate ทั้งฐาน ลองก่อนแล้ว verify ผลจริงที่ caller (เทียบ invoice_no ตรงเป๊ะ ไม่ใช่แค่ "มี
    // แถวกลับมา" — กันเคส PJ เมิน filter แล้ว echo หน้าแรกทั้งฐานกลับมาเฉยๆ)
    dtBody.set("search[value]", searchValue);
    dtBody.set("search[regex]", "false");
  }

  const res = await fetchWithTimeout(INVOICES_URL, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(jar),
      Referer: `${PJ_BASE}/manager/home`,
      Origin: PJ_BASE,
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-TOKEN": xsrfToken,
    },
    body: dtBody.toString(),
    redirect: "manual",
  }, perCallTimeout(deadline));

  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  let parsed: any = null;
  if (ct.includes("application/json")) {
    try { parsed = JSON.parse(text); } catch { /* not json */ }
  } else {
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try { parsed = JSON.parse(trimmed); } catch { /* not json */ }
    }
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("invoices/all: response ไม่ใช่ JSON (session/CSRF อาจไม่ผ่าน)");
  }
  return {
    rows: Array.isArray(parsed.data) ? parsed.data : [],
    recordsTotal: Number(parsed.recordsTotal ?? 0),
    recordsFiltered: Number(parsed.recordsFiltered ?? 0),
  };
}

type UuidLookupMethod = "cached" | "search" | "paginate" | "not_found";

async function findInvoiceUuid(
  jar: Map<string, string>,
  token: string,
  xsrfToken: string,
  invNo: string,
  cachedUuid: string | null,
  deadline: Deadline,
): Promise<{ uuid: string | null; method: UuidLookupMethod; pagesFetched: number }> {
  if (cachedUuid) return { uuid: cachedUuid, method: "cached", pagesFetched: 0 };

  let pagesFetched = 0;
  const matchesInvNo = (row: any) => {
    const rowInvNo = pick(row, ["invoice_no", "inv_no", "invoiceNo"]);
    return rowInvNo != null && String(rowInvNo).trim() === invNo;
  };

  // 1) ลอง search[value] ก่อน — เร็วกว่า paginate ทั้งฐานมาก ถ้า PJ รองรับจริง
  try {
    if (deadline.timeLeftMs() > 0) {
      const page = await fetchInvoicesPage(jar, token, xsrfToken, 0, invNo, deadline);
      pagesFetched++;
      const hit = page.rows.find(matchesInvNo);
      if (hit) {
        const uuidRaw = pick(hit, ["uuid"]);
        if (uuidRaw) return { uuid: String(uuidRaw).trim(), method: "search", pagesFetched };
      }
    }
  } catch {
    // เงียบไว้ — ไป fallback ด้านล่างต่อ (endpoint นี้ป่วย 1 ครั้งไม่ควรพัง fallback ที่ยังทำงานได้)
  }

  // 2) ไม่เจอ/PJ ไม่รองรับ search[value] จริง → paginate ทั้งลิสต์
  let offset = 0;
  for (let i = 0; i < INV_MAX_PAGES; i++) {
    if (deadline.timeLeftMs() <= 0) break;
    let page: { rows: any[]; recordsTotal: number; recordsFiltered: number };
    try {
      page = await fetchInvoicesPage(jar, token, xsrfToken, offset, undefined, deadline);
    } catch {
      break;
    }
    pagesFetched++;
    const hit = page.rows.find(matchesInvNo);
    if (hit) {
      const uuidRaw = pick(hit, ["uuid"]);
      if (uuidRaw) return { uuid: String(uuidRaw).trim(), method: "paginate", pagesFetched };
    }
    const known = page.recordsFiltered || page.recordsTotal || 0;
    const gotFullPage = page.rows.length >= INV_PAGE_LENGTH;
    if (!gotFullPage || page.rows.length === 0 || (known > 0 && offset + page.rows.length >= known)) break;
    offset += INV_PAGE_LENGTH;
  }

  return { uuid: null, method: "not_found", pagesFetched };
}

// ============================================================================
// เปิดหน้าใบสัญญา GET /manager/invoices/{uuid}
// ============================================================================
async function getInvoiceDetailHtml(jar: Map<string, string>, uuid: string, deadline: Deadline): Promise<string> {
  const res = await fetchWithTimeout(`${PJ_BASE}/manager/invoices/${uuid}`, {
    method: "GET",
    headers: {
      "User-Agent": UA,
      Cookie: cookieHeader(jar),
      Referer: `${PJ_BASE}/manager/home`,
      Accept: "text/html",
    },
    redirect: "manual",
  }, perCallTimeout(deadline));
  if (res.status !== 200) {
    throw new Error(`ได้ status ${res.status} (คาดว่า 200) — session อาจหลุด/uuid ผิด`);
  }
  return await res.text();
}

// ============================================================================
// Parser — โครงเพจ "label บรรทัดบน / ค่าบรรทัดล่าง" ในการ์ดที่มีหัวข้อ (ดู FIELD MAP ในคำสั่งงาน)
//
// ⚠️ regex/indexOf ล้วน (ไม่มี HTML parser lib ใน Deno edge runtime นี้ — สไตล์เดียวกับ extractToken/
// parseInvoiceDetailHtml ของ pj-sync) แนวทางนี้ "ทนทานพอประมาณ" กับ tag ที่เปลี่ยนได้ (div/p/span/label/dt/dd)
// แต่ "ไม่ทนทาน" กับ label text ที่เปลี่ยนคำ/สลับการ์ด — ยังไม่มีโอกาส verify กับ HTML จริง ใช้ mode='debug'
// (ด้านล่าง) ตรวจก่อนพึ่งพา parse ผลจริงบน prod
// ============================================================================

const CARD_TITLES = [
  "ข้อมูลสินค้า",
  "ข้อมูลการชำระเงิน",
  "ข้อมูลส่วนตัว",
  "ข้อมูลติดต่อ",
  "ข้อมูลที่อยู่",
  "ภาพบัตรประชาชน",
  "ภาพลูกค้า",
  // boundary เท่านั้น (ไม่ parse เนื้อหา 3 การ์ดนี้เลย) — "ภาพลูกค้า" เป็นการ์ดสุดท้ายที่เรา parse จริง ไม่มี
  // หัวข้อถัดไปกั้นไว้แต่ก่อน เลยไหลไปชน cap 30000 ตัวอักษรกลางการ์ด (ตัดรูปทิ้งไป 2 จาก 10 — สาเหตุที่ 3 ใน
  // คำสั่งงาน) ใส่ไว้แค่กันขอบเขต ไม่ต้อง parse เนื้อหาการ์ดพวกนี้
  "ประวัติการชำระเงินและใบเสร็จ",
  "รายการงวด",
  "ดูตัวอย่างสินเชื่อ",
] as const;

/** ตัด scope เฉพาะการ์ดที่มีหัวข้อ title — จบที่การ์ดอื่นตัวถัดไปที่เจอก่อน (กันข้อมูลการ์ดถัดไปเปื้อนเข้ามา) */
function cardScope(html: string, title: string): string | null {
  const idx = html.indexOf(title);
  if (idx === -1) return null;
  let end = html.length;
  let boundaryFound = false;
  for (const other of CARD_TITLES) {
    if (other === title) continue;
    const otherIdx = html.indexOf(other, idx + title.length);
    if (otherIdx !== -1 && otherIdx < end) { end = otherIdx; boundaryFound = true; }
  }
  // cap 30000 ใช้เฉพาะตอนหา boundary (การ์ดถัดไป) ไม่เจอเลย — กันไหลยาวจนจบเอกสาร ถ้าเจอ boundary แล้วใช้ตรงๆ
  // ห้าม cap ทับ เพราะวัดจริงจากเคส "ภาพลูกค้า" การ์ดยาวถึง 41,184 chars (รูปที่ 9-10 ตกขอบ cap เดิม — สาเหตุ
  // ที่ 3 รอบล่าสุด) โดยที่ boundary หา "ประวัติการชำระเงินและใบเสร็จ" เจอถูกต้องอยู่แล้ว
  if (!boundaryFound) end = Math.min(end, idx + 30000);
  return html.slice(idx, end);
}

/** หา index ของ label ในสโคป — บังคับให้ label เป็น "เนื้อหาทั้งหมด" ของ tag เดียว (ล้อมด้วย > ... < ไม่มี
 * ตัวอักษรอื่นปน นอกจาก whitespace) ก่อนเสมอ แล้วค่อย fallback เป็น indexOf ธรรมดา (เผื่อโครง markup ไม่ตรง
 * pattern ที่คาด — ยังดีกว่าไม่ได้ค่าเลย)
 *
 * เหตุผล: label สั้น (1-2 พยางค์ เช่น "สี", "ชื่อ", "สภาพ", "สาขา") เจอปัญหาจริงจาก mode='debug' — plain
 * indexOf ไปแมตช์ "สี" ที่แฝงอยู่ในข้อความ UI อื่นของหน้า (เช่นในประโยคแจ้งเตือน) เพราะภาษาไทยไม่มีช่องว่างคั่นคำ
 * ทำให้ substring สั้นๆ ไปโผล่กลางคำอื่นได้ง่ายมาก การบังคับ tag-boundary (`>สี<`) ตัดปัญหานี้เพราะ label จริง
 * ในหน้านี้เป็นเนื้อหาล้วนของ element เดี่ยวๆ (แถวคู่ label/value) ไม่ใช่ข้อความปนอยู่กลางประโยค */
function findLabelIndex(scope: string, label: string): number {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tagBoundedRe = new RegExp(`>\\s*${escaped}\\s*<`, "i");
  const m = tagBoundedRe.exec(scope);
  if (m) return m.index + m[0].indexOf(label);
  return scope.indexOf(label);
}

/** label บรรทัดบน / ค่าบรรทัดล่าง (ค่าเดียว บรรทัดแรกที่ไม่ว่างหลัง label) — ใช้กับฟิลด์ที่ไม่ควรมีค่าหลายบรรทัด
 * (ชื่อ/แบรนด์/สี/ตัวเลข/วันที่ ฯลฯ) กัน join ข้ามไปโดนค่าของ label ถัดไปโดยไม่ตั้งใจ */
function extractLabelValue(scope: string, label: string, windowSize = 400): string | null {
  const idx = findLabelIndex(scope, label);
  if (idx === -1) return null;
  const after = scope.slice(idx + label.length, idx + label.length + windowSize);
  const lines = after
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((s) => s.replace(/&nbsp;/gi, " ").trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[0] : null;
}

/** label บรรทัดบน / เอาหลายบรรทัดแรกดิบๆ (ไม่ join อัตโนมัติ) — ใช้กับฟิลด์ที่ HTML แยกค่าเป็นหลาย element
 * ติดกัน (เช่น "จำนวนเงินดาวน์" ที่จำนวนเงินกับ % เป็นคนละ element แถม % เองยังถูกหั่นเป็น 2 ชิ้นอีก
 * "(30" กับ "%)") ต่างจาก extractLabelValue (คืนแค่บรรทัดแรก) และ extractLabelValueMultiLine (ต้องมี
 * stopLabels ข้างเคียงมากั้น) — ที่นี่ไม่มี stopLabel ที่รู้จักแน่ชัด เลย cap ด้วยจำนวนบรรทัด (maxLines) แทน
 * เรียก caller เองที่ join(" ") แล้วไป regex ต่อ */
function extractLabelValueLines(scope: string, label: string, maxLines: number, windowSize = 400): string[] {
  const idx = findLabelIndex(scope, label);
  if (idx === -1) return [];
  const after = scope.slice(idx + label.length, idx + label.length + windowSize);
  const lines = after
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((s) => s.replace(/&nbsp;/gi, " ").trim())
    .filter(Boolean);
  return lines.slice(0, maxLines);
}

/** label บรรทัดบน / ค่าหลายบรรทัด (join ด้วยช่องว่าง) — ใช้กับที่อยู่ที่อาจขึ้นบรรทัดใหม่ในค่าเดียว
 * bound ด้วย stopLabels (label ข้างเคียงในการ์ดเดียวกัน) กัน join ทะลุไปโดนค่าของฟิลด์ถัดไป */
function extractLabelValueMultiLine(scope: string, label: string, stopLabels: string[]): string | null {
  const idx = findLabelIndex(scope, label);
  if (idx === -1) return null;
  let end = scope.length;
  for (const stop of stopLabels) {
    const stopIdx = findLabelIndex(scope.slice(idx + label.length), stop);
    if (stopIdx !== -1 && idx + label.length + stopIdx < end) end = idx + label.length + stopIdx;
  }
  end = Math.min(end, idx + label.length + 1000);
  const after = scope.slice(idx + label.length, end);
  const lines = after
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((s) => s.replace(/&nbsp;/gi, " ").trim())
    .filter(Boolean);
  return lines.length > 0 ? lines.join(" ") : null;
}

const ADDR_LABELS = ["ที่อยู่ตามบัตรประชาชน", "ที่อยู่ปัจจุบัน", "ที่อยู่ที่ทำงาน"];
function extractAddr(scope: string, label: string): string | null {
  return extractLabelValueMultiLine(scope, label, ADDR_LABELS.filter((l) => l !== label));
}

type ParseResult =
  | { ok: true; data: Record<string, string> }
  | { ok: false; reason: string };

/** parse หน้าใบสัญญา PJ → data ตามคีย์ PJContract (src/lib/pjImport.ts:8-41) เท่าที่หน้านี้มีจริง (ดู FIELD MAP
 * ในคำสั่งงาน — ช่องที่หน้านี้ไม่มี เช่น email/shop_code/promotion* ไม่ set คีย์เลย (ไม่ใช่ค่าว่าง) เพื่อให้
 * pjCompare.ts อ่านเป็น 'no_pj' ถูกต้อง ไม่ใช่ 'pj_blank' — ตัดสินใจนี้อยู่ใน scope ของ backend ล้วน ไม่แตะ
 * pjCompare.ts (occupation จากการ์ด "ข้อมูลส่วนตัว" กับ facebook_link จากการ์ด "ข้อมูลติดต่อ" ดึงได้แล้ว —
 * เพิ่มรอบนี้: line_status/line_user_count จาก "ข้อมูลส่วนตัว" + line_id จาก "ข้อมูลติดต่อ" นอก PJContract
 * ทั้ง 3 คีย์ ไม่ใช่ core field และไม่เก็บ LINE User ID (base64) เด็ดขาด) */
function parseInvoiceDetail(html: string): ParseResult {
  // 🔴 กฎเหล็ก: anchor หลักไม่เจอ = ok:false ทันที (ดู comment หัวไฟล์ — บทเรียนจาก pj-sync)
  const invoiceNoMatch = html.match(/หมายเลขใบแจ้งหนี้[\s\S]{0,60}?(INV-[A-Za-z0-9-]+)/);
  if (!invoiceNoMatch) {
    return {
      ok: false,
      reason: 'ไม่พบหัวเพจ "หมายเลขใบแจ้งหนี้ : INV-..." — หน้าที่ได้อาจไม่ใช่หน้าใบสัญญาจริง (session หลุด/uuid ผิด/PJ เปลี่ยนหน้า)',
    };
  }
  const invoiceNo = invoiceNoMatch[1].trim();

  const productScope = cardScope(html, "ข้อมูลสินค้า");
  const paymentScope = cardScope(html, "ข้อมูลการชำระเงิน");
  if (!productScope || !paymentScope) {
    const missing = [!productScope && "ข้อมูลสินค้า", !paymentScope && "ข้อมูลการชำระเงิน"].filter(Boolean).join(", ");
    return { ok: false, reason: `ไม่พบการ์ดหลัก (${missing}) — หน้าอาจโหลดไม่ครบหรือ PJ เปลี่ยนโครงหน้า` };
  }
  const personalScope = cardScope(html, "ข้อมูลส่วนตัว");
  const contactScope = cardScope(html, "ข้อมูลติดต่อ");
  const addressScope = cardScope(html, "ข้อมูลที่อยู่");

  const customerName = personalScope ? extractLabelValue(personalScope, "ชื่อ") : null;
  const nationalId = personalScope ? extractLabelValue(personalScope, "เลขบัตรประชาชน") : null;
  const financeAmountRaw = extractLabelValue(paymentScope, "จำนวนเงินกู้");

  // core fields: ขาดตัวไหนไปเลยก็ 'failed' ทั้งชุด (ห้ามบันทึกครึ่งๆกลางๆเป็น 'ok' — ดูกฎเหล็กหัวไฟล์)
  if (!customerName || !nationalId || !financeAmountRaw) {
    const missing = [
      !customerName && "customer_name",
      !nationalId && "national_id",
      !financeAmountRaw && "finance_amount",
    ].filter(Boolean).join(", ");
    return { ok: false, reason: `parse ได้ไม่ครบ core fields (${missing}) — ไม่บันทึกเป็น ok เพื่อกันแผงตรวจโชว์ "ตรงหมด" บนข้อมูลขยะ` };
  }

  // จำนวนเงินดาวน์ — ต้องพาร์สแยก 2 ค่า (จำนวนเงิน + %) — แบมรองรับฝั่งเทียบไว้แล้วด้วยคีย์นอก PJContract 2 ตัว
  // (device_price, down_percent — ดู ExtraSnapshotKey ใน pjImport.ts:36 + FIELD_MAP ใน pjCompare.ts:264,270)
  // เก็บ % เป็นเลขล้วนไม่มีวงเล็บ/สัญลักษณ์ % (เช่น "30" ไม่ใช่ "30 %")
  // ⚠️ ตรวจจาก mode='debug' จริง (recon 09-12): จำนวนเงินกับ % ไม่ได้อยู่บรรทัดเดียวกัน แยกเป็นคนละ element
  // แถม % เองยังถูกหั่นเป็น 2 ชิ้นอีก → บรรทัดดิบ 4 บรรทัดแรกหลัง label คือ ["3,570.00", "(30", "%)", ...]
  // extractLabelValue (คืนแค่บรรทัดแรก) จับ % ไม่ได้เลย เปลี่ยนมาดึงหลายบรรทัดแล้ว join(" ") ก่อนค่อย regex —
  // cap 4 บรรทัดกัน join ไกลเกินจนไปโดนค่าของ label ถัดไป (มี <svg> เป็นตัวคั่นธรรมชาติอยู่ก่อนถึงตรงนั้น)
  const downRaw = extractLabelValueLines(paymentScope, "จำนวนเงินดาวน์", 4).join(" ");
  const downAmountMatch = downRaw.match(/[\d,]+\.?\d*/);
  const downAmount = downAmountMatch ? downAmountMatch[0] : downRaw;
  const downPercentMatch = downRaw.match(/\(\s*([\d.]+)\s*%\s*\)/);
  const downPercent = downPercentMatch ? downPercentMatch[1] : "";

  // โทรศัพท์สำรอง — 2 เบอร์ในบรรทัดเดียว คั่นด้วยช่องว่าง
  const phoneAltRaw = contactScope ? (extractLabelValue(contactScope, "โทรศัพท์สำรอง") ?? "") : "";
  const phoneAltParts = phoneAltRaw.split(/\s+/).filter(Boolean);

  // สถานะ LINE — เจอปัญหาเดียวกับ "จำนวนเงินดาวน์" (ดู comment ตรงนั้น): ค่ากับจำนวนผู้ใช้ถูกหั่นเป็นหลาย
  // element ติดกัน (recon 12/09 บนเคส "เชื่อมต่อแล้ว"): บรรทัดดิบ 3 บรรทัดแรกหลัง label คือ
  // ["เชื่อมต่อแล้ว", "(1", "ผู้ใช้)"] — ต้อง extractLabelValueLines + join(" ") ก่อน แล้วค่อยตัดส่วนวงเล็บทิ้ง
  // ให้เหลือสถานะล้วน (ห้ามให้ "เชื่อมต่อแล้ว (1 ผู้ใช้)" ปนไปเป็นค่า line_status)
  // ⚠️ ไม่เคยเห็น HTML จริงของเคส "ยังไม่เชื่อมต่อ" (มีแต่ตัวอย่างเคสที่เชื่อมต่อแล้ว) — โค้ดนี้ "ทน" กับกรณีนั้น
  // เองตามธรรมชาติของ regex (ไม่ได้ hardcode คำว่า "เชื่อมต่อแล้ว"): ถ้าไม่มีวงเล็บจำนวนผู้ใช้เลย lineStatus จะ
  // ได้ raw string เต็มๆ (เช่น "ยังไม่เชื่อมต่อ") และ lineUserCount จะเป็น "" (หาไม่เจอ ไม่ใช่ "0") — แต่ถ้า PJ
  // ใช้คำอื่น/โครง markup ต่างไปจนหา label "สถานะ LINE" ไม่เจอเลย extractLabelValueLines คืน [] → ทั้งคู่เป็น ""
  // (อ่านเป็น "PJ ไม่มีข้อมูล" ที่ pjCompare.ts ได้เอง ไม่ถือเป็น core field เลยไม่ทำให้ทั้งชุด failed)
  const lineStatusRaw = personalScope ? extractLabelValueLines(personalScope, "สถานะ LINE", 4).join(" ") : "";
  const lineUserCountMatch = lineStatusRaw.match(/\(\s*(\d+)/);
  const lineUserCount = lineUserCountMatch ? lineUserCountMatch[1] : "";
  const lineStatus = lineStatusRaw.replace(/\s*\(.*$/, "").trim();

  const data: Record<string, string> = {
    invoice_no: invoiceNo,
    contract_no: invoiceNo, // หน้านี้ไม่มีเลขที่สัญญาแยกจาก invoice_no
    trade_date: extractLabelValue(paymentScope, "วันที่ชำระเงินดาวน์") ?? "",
    shop_name: extractLabelValue(paymentScope, "สาขา") ?? "",
    customer_name: customerName,
    national_id: nationalId,
    device_brand: extractLabelValue(productScope, "แบรนด์") ?? "",
    device_name: extractLabelValue(productScope, "ชื่อ") ?? "",
    device_color: extractLabelValue(productScope, "สี") ?? "",
    device_storage: extractLabelValue(productScope, "ความจุ") ?? "",
    device_condition: extractLabelValue(productScope, "สภาพ") ?? "",
    condition: extractLabelValue(productScope, "สภาพ") ?? "", // pjCompare.ts FIELD_MAP เทียบ 'condition' คีย์นี้ตรง (ไม่ใช่ device_condition)
    imei: extractLabelValue(productScope, "IMEI") ?? "",
    sn: extractLabelValue(productScope, "หมายเลขเครื่อง") ?? "",
    down_payment: String(parseAmount(downAmount)),
    down_percent: downPercent, // นอก PJContract ตามที่แบมเผื่อไว้ (ExtraSnapshotKey) — เก็บเลขล้วน ไม่มี % / วงเล็บ
    monthly_payment: String(parseAmount(extractLabelValue(paymentScope, "จำนวนเงินผ่อน") ?? "")),
    term_months: digitsOnly(extractLabelValue(paymentScope, "จำนวนงวด") ?? ""),
    finance_amount: String(parseAmount(financeAmountRaw)),
    device_price: String(parseAmount(extractLabelValue(paymentScope, "ราคาสินค้า") ?? "")), // นอก PJContract (ExtraSnapshotKey) — เทียบกับ device_price ฝั่งเรา
    first_due_date: extractLabelValue(paymentScope, "วันที่เริ่มต้นการผ่อนชำระ") ?? "",
    birth_date: personalScope ? (extractLabelValue(personalScope, "วันเกิด") ?? "") : "",
    occupation: personalScope ? (extractLabelValue(personalScope, "อาชีพ") ?? "") : "",
    // line_status: ค่าสถานะล้วน (เช่น "เชื่อมต่อแล้ว") ตัดวงเล็บจำนวนผู้ใช้ทิ้งแล้ว — ดู comment เหนือ
    // lineStatusRaw ด้านบนสำหรับเคส "ยังไม่เชื่อมต่อ" ที่ยังไม่เคยเห็น HTML จริง
    line_status: lineStatus,
    // line_user_count: เลขล้วนไม่มีวงเล็บ/คำว่า "ผู้ใช้" — "" = หาไม่เจอ (ไม่รู้), ไม่ใช่ "0" (รู้ว่าไม่มี)
    line_user_count: lineUserCount,
    phone: contactScope ? (extractLabelValue(contactScope, "โทรศัพท์") ?? "") : "",
    phone_alt1: phoneAltParts[0] ?? "",
    phone_alt2: phoneAltParts[1] ?? "",
    // LINE ID (จากการ์ด "ข้อมูลติดต่อ") — ⚠️ เก็บเฉพาะ LINE ID (ตัวที่ลูกค้าตั้งเอง/แก้ได้) ห้ามเก็บ "LINE User
    // ID" (ค่า base64 ใต้บล็อกผู้ใช้ LINE ที่เชื่อมต่อ) เด็ดขาด — เป็น identifier ส่วนตัวที่ไม่ได้ใช้ประโยชน์ใน
    // งานตรวจ ไม่มี label "LINE ID" ปนกับ "LINE User ID" ในสโคปเดียวกันแบบ ambiguous เพราะ findLabelIndex ผูก
    // tag-boundary พอดีคำ (`>LINE ID<` ไม่ match กลางคำ "LINE User ID")
    line_id: contactScope ? (extractLabelValue(contactScope, "LINE ID") ?? "") : "",
    // Facebook ID มีช่องว่างกลาง label เอง (findLabelIndex escape เฉพาะ regex metachar ไม่แตะช่องว่าง) —
    // tag-boundary (`>Facebook ID<`) ยัง match ได้ปกติเพราะ regex เดิมไม่ได้ตัดคำที่ \s ตรงกลาง แค่ trim หัวท้าย
    facebook_link: contactScope ? (extractLabelValue(contactScope, "Facebook ID") ?? "") : "",
    addr_card_full: addressScope ? (extractAddr(addressScope, "ที่อยู่ตามบัตรประชาชน") ?? "") : "",
    addr_current_full: addressScope ? (extractAddr(addressScope, "ที่อยู่ปัจจุบัน") ?? "") : "",
    addr_work_full: addressScope ? (extractAddr(addressScope, "ที่อยู่ที่ทำงาน") ?? "") : "",
    // 3 ช่องล่างนี้ "เก็บไว้ดูเฉยๆ" ไม่ได้ใช้เทียบ (แบมไม่ decorate ใน pjCompare.ts) — มีประโยชน์ตอน debug ว่า
    // PJ คิดเลขยังไง (รวม/คงเหลือ/พาร์ทเนอร์ได้รับ มักมาจาก finance_amount + ค่าธรรมเนียมต่างๆ ของ PJ เอง)
    pj_total_amount: String(parseAmount(extractLabelValue(paymentScope, "จำนวนเงินรวม") ?? "")),
    pj_remaining_amount: String(parseAmount(extractLabelValue(paymentScope, "จำนวนเงินคงเหลือ") ?? "")),
    pj_partner_received: String(parseAmount(extractLabelValue(paymentScope, "พาร์ทเนอร์ได้รับ") ?? "")),
    // ไม่ set: shop_code, email, promotion, has_promotion, promotion_detail, occupation_proof, notes, operator
    // — หน้าใบสัญญานี้ไม่มีข้อมูลพวกนี้เลย (ไม่ใช่ parse พลาด) ปล่อยให้ pjCompare.ts อ่านเป็น 'no_pj' ถูกต้อง
    // (occupation, facebook_link ดึงได้แล้วจากรอบก่อน; line_status/line_user_count (การ์ด "ข้อมูลส่วนตัว") +
    // line_id (การ์ด "ข้อมูลติดต่อ") ดึงเพิ่มรอบนี้ — ยืนยันจาก HTML จริงบน PJ แล้ว 12/09 เฉพาะเคส "เชื่อมต่อ
    // แล้ว" เท่านั้น เคส "ยังไม่เชื่อมต่อ" ยังไม่เคยเห็น HTML จริง แต่โค้ดออกแบบให้ไม่พัง — ว่างเปล่า/ไม่เจอ label
    // เลย = "" ทั้งคู่ ไม่ใช่การเดา "0"/"ยังไม่เชื่อมต่อ" เอง — 3 คีย์นี้ "เก็บไว้ดูเฉยๆ" ไม่ใช่ core field
    // ขาดไปก็ไม่ทำให้ทั้งชุด failed, ไม่มีการเก็บ LINE User ID (base64) ลง DB เด็ดขาดตามที่สั่ง)
  };

  return { ok: true, data };
}

// ============================================================================
// รูปภาพ — ปุ่ม "ดูภาพเต็ม" ชี้ไป wasabisys S3 แบบ presigned (หมดอายุ 300 วิ) — เก็บแค่ kind+path (ไม่มี query
// string signature) ตอน snapshot mode, เก็บ href (presigned เต็ม) ไว้ใช้ทันทีเฉพาะตอน images mode เท่านั้น
// (ไม่เขียนลง DB เด็ดขาด — mig 0152 ห้ามเก็บ presigned URL)
// ============================================================================
interface ImageRef {
  kind: string;
  path: string;
  href: string;
}

const IMAGE_CARD_PREFIX: Record<string, string> = {
  "ภาพบัตรประชาชน": "id_card",
  "ภาพลูกค้า": "customer_photo",
};

// กรองเฉพาะโฟลเดอร์รูปลูกค้า/บัตรจริง — กันเคส scope คาบเกี่ยวไปโดนการ์ดอื่น (ลายเซ็น/บัญชีธนาคาร/โลโก้ร้าน)
// ปนเข้ามาโดยไม่ตั้งใจ (สาเหตุที่ 3 ในคำสั่งงาน — เพิ่ม CARD_TITLES boundary แล้วก็ยังกันซ้ำอีกชั้นด้วยตัวนี้)
const ALLOWED_IMAGE_FOLDERS = ["national_id_images/", "customer_images/"];

// mode='images' เจอ 403 จริงบน prod (12/09) — วัด href ดิบจาก HTML แล้วพบว่า Laravel/Blade escape
// query string ทั้งเส้นเป็น HTML entity ก่อนพิมพ์ลง <a href="…">: "&" → "&amp;" (447 ตัวอักษร, มี &amp; 6
// ตัว, ไม่มี & ธรรมดาเลย) ตัว regex จับ href เดิม (m[1]) ได้ string ที่ยังไม่ decode → เอาไปยิง Wasabi ตรงๆ
// ทำให้ query param ชื่อ "X-Amz-Algorithm" กลายเป็น "amp;X-Amz-Algorithm" (คั่นด้วย &amp; ไม่ใช่ &) →
// signature ไม่ตรง → 403 (ไม่ใช่ลิงก์หมดอายุ — fetch สดมาใช้ทันทีอยู่แล้ว) ไม่มี DOMParser ใน Deno edge
// runtime นี้ เลย decode เองเฉพาะ entity ที่ Laravel escape จริง (single-pass regex กันเคส decode ซ้อน เช่น
// "&amp;lt;" ต้องได้ "&lt;" ไม่ใช่ "<")
function decodeHtmlEntities(s: string): string {
  const map: Record<string, string> = {
    "&amp;": "&",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&lt;": "<",
    "&gt;": ">",
    "&#x2f;": "/",
    "&#47;": "/",
  };
  return s.replace(/&(?:amp|quot|#39|apos|lt|gt|#x2f|#47);/gi, (m) => map[m.toLowerCase()] ?? m);
}

function parseImageRefs(html: string): ImageRef[] {
  const refs: ImageRef[] = [];
  for (const [title, prefix] of Object.entries(IMAGE_CARD_PREFIX)) {
    const scope = cardScope(html, title);
    if (!scope) continue;
    // เดิมจับด้วยข้อความปุ่ม "ดูภาพเต็ม" ตรงๆ (/<a...>\s*ดูภาพเต็ม\s*<\/a>/) แต่ mode='debug' เจอโครงจริงคือ
    // <a href="…"><svg>…</svg> ดูภาพเต็ม</a> — มี <svg><path/><circle/></svg> คั่นระหว่าง <a> กับข้อความ ทำให้
    // regex เดิม (บังคับ whitespace ตามด้วยข้อความทันทีหลัง >) ไม่ match เลย (สาเหตุที่ 3 ในคำสั่งงาน)
    // เปลี่ยนมาจับทุก <a href="..."> ในสโคปการ์ดนี้แล้วกรองด้วย href ที่มี wasabisys.com แทน — ไม่ต้องพึ่ง
    // ข้อความปุ่มเลย เพราะ URL host (wasabisys.com) เปลี่ยนยากกว่าข้อความ UI ภาษาไทยที่แก้ได้ทุกเมื่อ ทนกว่า
    // ต่อการเปลี่ยนโครง markup ภายใน <a> (svg/icon เพิ่ม-ลด-สลับตำแหน่งได้ ไม่กระทบการจับคู่นี้เลย)
    const anchorRe = /<a\s+[^>]*href="([^"]+)"[^>]*>/gi;
    let m: RegExpExecArray | null;
    let i = 0;
    // dedup ด้วย path (ตัด query string presign ออกก่อนเทียบ) — PJ ใส่ 2 <a> ต่อรูปจริง 1 ใบ (ตัว placeholder
    // "Loading..." ที่โชว์ตอน lazy-load + ปุ่ม "ดูภาพเต็ม" ข้างล่าง) ชี้ href เดียวกัน ถ้าไม่ dedup ก่อนตั้งเลข
    // kind เลขจะเบิ้ล/เพี้ยนตามจำนวนลิงก์ ไม่ใช่ตามจำนวนรูปจริง (สาเหตุที่ 2 ในคำสั่งงาน)
    const seenPaths = new Set<string>();
    while ((m = anchorRe.exec(scope)) !== null) {
      const href = decodeHtmlEntities(m[1]); // decode &amp; ฯลฯ ก่อนใช้ (ดู comment เหนือ decodeHtmlEntities)
      if (!/wasabisys\.com/i.test(href)) continue; // เอาเฉพาะลิงก์ S3 จริง กันจับ href อื่นในการ์ดผิด
      const path = href.split("?")[0].replace(/^https?:\/\/[^/]+\//i, ""); // ตัด host + query (presign signature)
      if (!ALLOWED_IMAGE_FOLDERS.some((f) => path.includes(f))) continue; // กันรูปโฟลเดอร์อื่นปน (signatures/ ฯลฯ)
      if (seenPaths.has(path)) continue; // ลิงก์ซ้ำไฟล์เดียวกัน — ข้าม ไม่นับเป็นรูปใหม่
      seenPaths.add(path);
      i++;
      refs.push({ kind: `${prefix}_${i}`, path, href });
    }
  }
  return refs;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000; // กัน String.fromCharCode(...bytes) stack overflow กับไฟล์ใหญ่
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ============================================================================
// เขียนแคช — ไม่มี trigger updated_at (mig 0152 comment) ต้องตั้งเองทุกครั้ง
// ============================================================================
async function upsertSnapshot(adminClient: any, contractId: string, patch: Record<string, unknown>): Promise<void> {
  const row = { contract_id: contractId, updated_at: nowIso(), ...patch };
  const { error } = await adminClient.from("pj_contract_snapshot").upsert(row, { onConflict: "contract_id" });
  if (error) {
    // best-effort bookkeeping เท่านั้น — ไม่ throw ซ้อน (response หลักของ caller ยังบอกผลลัพธ์ตรงได้แม้เขียนแคชพลาด)
    console.error("pj-snapshot: upsertSnapshot failed:", error.message);
  }
}

// ============================================================================
// mode='snapshot'
// ============================================================================
async function handleSnapshot(userClient: any, adminClient: any, body: any, deadline: Deadline): Promise<Response> {
  const contractId = String(body?.contractId ?? "").trim();
  if (!contractId) return json({ ok: false, status: "failed", error: "contractId จำเป็น" }, 400);

  // เช็ค scope ด้วย user client (เกาะ RLS) — ผ่าน role gate มาแล้วยังต้องเห็นสัญญานี้จริง (mirror media-sign)
  const { data: scopeRow, error: scopeErr } = await userClient
    .from("contracts").select("id, inv_no").eq("id", contractId).maybeSingle();
  if (scopeErr) return json({ ok: false, status: "failed", error: scopeErr.message }, 500);
  if (!scopeRow) return json({ ok: false, status: "failed", error: "ไม่มีสิทธิ์เข้าถึงสัญญานี้" }, 403);
  const invNo = String(scopeRow.inv_no ?? "").trim();

  // ── debounce: ดึงแถวเดิม (ถ้ามี) — fetched_at < 60 วิ → คืนของเดิม ไม่ยิง PJ ซ้ำ ──
  const DEBOUNCE_MS = 60_000;
  const { data: existing } = await adminClient
    .from("pj_contract_snapshot").select("*").eq("contract_id", contractId).maybeSingle();

  if (existing?.fetched_at) {
    const ageMs = Date.now() - new Date(existing.fetched_at).getTime();
    if (ageMs >= 0 && ageMs < DEBOUNCE_MS) {
      return json({
        ok: existing.status === "ok",
        status: existing.status,
        error: existing.error_reason ?? undefined,
        diagnostics: { debounced: true, ageMs },
      });
    }
  }

  if (!invNo) {
    await upsertSnapshot(adminClient, contractId, {
      status: "failed",
      error_reason: "สัญญานี้ไม่มีเลขที่ใบ PJ (inv_no) ผูกไว้ — เทียบกับ PJ ไม่ได้",
      fetched_at: nowIso(),
    });
    return json({ ok: false, status: "failed", error: "สัญญานี้ไม่มีเลขที่ใบ PJ (inv_no) ผูกไว้" });
  }

  await upsertSnapshot(adminClient, contractId, { status: "fetching", pj_invoice_no: invNo });

  try {
    const jar = new Map<string, string>();
    const loginResult = await loginPJ(jar, deadline);
    if (!loginResult.ok) {
      await upsertSnapshot(adminClient, contractId, {
        status: "failed", pj_invoice_no: invNo, error_reason: loginResult.reason, fetched_at: nowIso(),
      });
      return json({ ok: false, status: "failed", error: loginResult.reason });
    }
    const { token, xsrfToken } = loginResult;

    if (deadline.timeLeftMs() <= 0) {
      await upsertSnapshot(adminClient, contractId, {
        status: "failed", pj_invoice_no: invNo, error_reason: "เกินเวลาที่กำหนด (20 วิ) ตอน login เสร็จ", fetched_at: nowIso(),
      });
      return json({ ok: false, status: "failed", error: "เกินเวลาที่กำหนด (20 วิ)" });
    }

    const lookup = await findInvoiceUuid(jar, token, xsrfToken, invNo, existing?.pj_invoice_uuid ?? null, deadline);
    if (!lookup.uuid) {
      await upsertSnapshot(adminClient, contractId, {
        status: "not_found_in_pj", pj_invoice_no: invNo, error_reason: null, fetched_at: nowIso(),
      });
      return json({
        ok: true,
        status: "not_found_in_pj",
        diagnostics: { uuidLookupMethod: lookup.method, pagesFetched: lookup.pagesFetched },
      });
    }

    if (deadline.timeLeftMs() <= 0) {
      await upsertSnapshot(adminClient, contractId, {
        status: "failed", pj_invoice_no: invNo, pj_invoice_uuid: lookup.uuid,
        error_reason: "เกินเวลาที่กำหนด (20 วิ) ตอนหา uuid เสร็จ", fetched_at: nowIso(),
      });
      return json({ ok: false, status: "failed", error: "เกินเวลาที่กำหนด (20 วิ)" });
    }

    let html: string;
    try {
      html = await getInvoiceDetailHtml(jar, lookup.uuid, deadline);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await upsertSnapshot(adminClient, contractId, {
        status: "failed", pj_invoice_no: invNo, pj_invoice_uuid: lookup.uuid,
        error_reason: `เปิดหน้าใบไม่สำเร็จ: ${msg}`, fetched_at: nowIso(),
      });
      return json({ ok: false, status: "failed", error: `เปิดหน้าใบไม่สำเร็จ: ${msg}` });
    }

    const parsed = parseInvoiceDetail(html);
    if (!parsed.ok) {
      await upsertSnapshot(adminClient, contractId, {
        status: "failed", pj_invoice_no: invNo, pj_invoice_uuid: lookup.uuid,
        error_reason: parsed.reason, fetched_at: nowIso(),
      });
      return json({ ok: false, status: "failed", error: parsed.reason, diagnostics: { uuidLookupMethod: lookup.method } });
    }

    const imageRefs = parseImageRefs(html).map(({ kind, path }) => ({ kind, path }));

    await upsertSnapshot(adminClient, contractId, {
      status: "ok",
      pj_invoice_no: invNo,
      pj_invoice_uuid: lookup.uuid,
      data: parsed.data,
      image_refs: imageRefs,
      error_reason: null,
      fetched_at: nowIso(),
    });

    return json({
      ok: true,
      status: "ok",
      diagnostics: { uuidLookupMethod: lookup.method, pagesFetched: lookup.pagesFetched, imageCount: imageRefs.length },
    });
  } catch (e) {
    // safety net สุดท้าย — ห้าม throw ทำ caller (flow ส่งตรวจ) พัง เก็บ failed ไว้ให้เห็นสาเหตุ
    const msg = e instanceof Error ? e.message : String(e);
    await upsertSnapshot(adminClient, contractId, {
      status: "failed", pj_invoice_no: invNo, error_reason: `unexpected: ${msg}`, fetched_at: nowIso(),
    });
    return json({ ok: false, status: "failed", error: msg });
  }
}

// ============================================================================
// mode='images' — admin เท่านั้น — คืน bytes (base64) proxy ผ่านฟังก์ชันนี้เสมอ ห้ามคืนลิงก์ S3 เด็ดขาด
// ============================================================================
async function handleImages(userClient: any, adminClient: any, body: any, deadline: Deadline): Promise<Response> {
  const contractId = String(body?.contractId ?? "").trim();
  const imageKey = String(body?.imageKey ?? "").trim();
  if (!contractId || !imageKey) return json({ ok: false, error: "contractId/imageKey จำเป็น" }, 400);

  const { data: scopeRow, error: scopeErr } = await userClient
    .from("contracts").select("id").eq("id", contractId).maybeSingle();
  if (scopeErr) return json({ ok: false, error: scopeErr.message }, 500);
  if (!scopeRow) return json({ ok: false, error: "ไม่มีสิทธิ์เข้าถึงสัญญานี้" }, 403);

  const { data: snap, error: snapErr } = await adminClient
    .from("pj_contract_snapshot").select("pj_invoice_uuid").eq("contract_id", contractId).maybeSingle();
  if (snapErr) return json({ ok: false, error: snapErr.message }, 500);
  const invUuid = snap?.pj_invoice_uuid as string | null | undefined;
  if (!invUuid) {
    return json({ ok: false, error: 'ยังไม่มีข้อมูลจาก PJ สำหรับสัญญานี้ — กดดึงข้อมูล PJ (mode=snapshot) ก่อน' });
  }

  try {
    const jar = new Map<string, string>();
    const loginResult = await loginPJ(jar, deadline);
    if (!loginResult.ok) return json({ ok: false, error: `เข้าเว็บ PJ ไม่สำเร็จ: ${loginResult.reason}` });

    const html = await getInvoiceDetailHtml(jar, invUuid, deadline);
    const refs = parseImageRefs(html);
    const target = refs.find((r) => r.kind === imageKey);
    if (!target) {
      return json({ ok: false, error: `ไม่พบรูป "${imageKey}" ในหน้าใบสัญญานี้ (PJ อาจไม่มีรูปนี้แล้ว หรือชื่อช่องไม่ตรง)` });
    }

    const imgRes = await fetchWithTimeout(target.href, { headers: { "User-Agent": UA } }, perCallTimeout(deadline));
    if (!imgRes.ok) {
      return json({ ok: false, error: `โหลดไฟล์รูปไม่สำเร็จ (${imgRes.status}) — ลิงก์ presigned อาจหมดอายุ ลองใหม่อีกครั้ง` });
    }
    const buf = await imgRes.arrayBuffer();
    const mime = imgRes.headers.get("content-type") ?? "image/jpeg";
    const base64 = base64Encode(new Uint8Array(buf));

    return new Response(JSON.stringify({ ok: true, base64, mime }), {
      status: 200,
      // ⚠️ คุณเตยเคาะแล้ว: ลิงก์/ไฟล์รูปบัตรห้ามถูก cache เก็บไว้ที่ไหนเลย
      headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

// ============================================================================
// mode='debug' — admin เท่านั้น, ไม่เขียน DB — เครื่องมือ diagnostic ชั่วคราว mirror pj-sync debugInv pattern
// (pj-sync/index.ts:725-732) ใช้ตรวจ anchor/โครง HTML จริงหลัง deploy โดยไม่ต้อง deploy ใหม่ทุกครั้งที่ปรับ
// parser — ลบทิ้งได้เมื่อ parser คาลิเบรตจนมั่นใจแล้ว (ไม่ใช่โค้ดถาวร)
// ============================================================================
async function handleDebug(userClient: any, body: any, deadline: Deadline): Promise<Response> {
  const contractId = String(body?.contractId ?? "").trim();
  if (!contractId) return json({ error: "contractId จำเป็น" }, 400);

  const { data: scopeRow } = await userClient.from("contracts").select("id, inv_no").eq("id", contractId).maybeSingle();
  if (!scopeRow) return json({ error: "ไม่มีสิทธิ์เข้าถึงสัญญานี้" }, 403);
  const invNo = String(scopeRow.inv_no ?? "").trim();
  if (!invNo) return json({ error: "สัญญานี้ไม่มี inv_no" }, 400);

  const jar = new Map<string, string>();
  const loginResult = await loginPJ(jar, deadline);
  if (!loginResult.ok) return json({ error: `login: ${loginResult.reason}` });

  const lookup = await findInvoiceUuid(jar, loginResult.token, loginResult.xsrfToken, invNo, null, deadline);
  if (!lookup.uuid) {
    return json({ error: "ไม่พบ invoice ใน PJ", diagnostics: { uuidLookupMethod: lookup.method, pagesFetched: lookup.pagesFetched } });
  }

  const html = await getInvoiceDetailHtml(jar, lookup.uuid, deadline);
  const parsed = parseInvoiceDetail(html);
  const imageRefs = parseImageRefs(html).map(({ kind, path }) => ({ kind, path })); // ไม่คืน href (presigned) แม้ใน debug

  return json({
    uuid: lookup.uuid,
    uuidLookupMethod: lookup.method,
    pagesFetched: lookup.pagesFetched,
    htmlLength: html.length,
    anchors: {
      hasInvoiceHeader: html.includes("หมายเลขใบแจ้งหนี้"),
      hasProductCard: html.includes("ข้อมูลสินค้า"),
      hasPaymentCard: html.includes("ข้อมูลการชำระเงิน"),
      hasPersonalCard: html.includes("ข้อมูลส่วนตัว"),
      hasContactCard: html.includes("ข้อมูลติดต่อ"),
      hasAddressCard: html.includes("ข้อมูลที่อยู่"),
      hasIdCardImageCard: html.includes("ภาพบัตรประชาชน"),
      hasCustomerImageCard: html.includes("ภาพลูกค้า"),
    },
    parsed,
    imageRefs,
    htmlSample: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000),
  });
}

// ============================================================================
// Entry point
// ============================================================================
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
  if (!profile || profile.active === false) {
    return json({ error: "บัญชีถูกปิดใช้งาน หรือไม่มีสิทธิ์เข้าถึง" }, 403);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const mode = body?.mode;
  const deadline = makeDeadline(REQUEST_BUDGET_MS);

  if (mode === "snapshot") {
    if (!SNAPSHOT_ROLES.includes(profile.role)) return json({ error: "ไม่มีสิทธิ์ดึงข้อมูล PJ" }, 403);
    return await handleSnapshot(userClient, adminClient, body, deadline);
  }
  if (mode === "images") {
    if (profile.role !== "admin") return json({ error: "ดึงรูปจาก PJ ได้เฉพาะแอดมิน" }, 403);
    return await handleImages(userClient, adminClient, body, deadline);
  }
  if (mode === "debug") {
    if (profile.role !== "admin") return json({ error: "debug เฉพาะแอดมิน" }, 403);
    return await handleDebug(userClient, body, deadline);
  }
  return json({ error: "unknown mode (ต้องเป็น snapshot/images/debug)" }, 400);
});

// ============================================================================
// curl smoke test สำหรับครีมหลัง deploy (ดึง access token จาก localStorage ใน browser ที่ login ไว้แล้ว —
// ดูวิธีที่ CLAUDE.md หัวข้อ Live Testing)
//
// 1) mode='debug' ก่อนอย่างอื่นเสมอ — เช็คว่า anchor/โครงหน้าตรงกับที่ recon ไว้จริงไหม:
//   curl -s -X POST "https://zyitutjogbrahnwtbemr.supabase.co/functions/v1/pj-snapshot" \
//     -H "Authorization: Bearer <ADMIN_ACCESS_TOKEN>" -H "Content-Type: application/json" \
//     -d '{"mode":"debug","contractId":"<uuid สัญญาที่รู้ว่ามี inv_no ตรงกับ PJ จริง>"}'
//   → เช็ค anchors ทุกตัว = true, parsed.ok = true, ตัวเลขใน parsed.data สมเหตุสมผล (ไม่ว่างเปล่า),
//     uuidLookupMethod ควรได้ 'search' ถ้า PJ รองรับ search[value] (ถ้าได้ 'paginate' ก็ใช้ได้ แค่ช้ากว่า)
//
// 2) mode='snapshot' (staff หรือ admin) — เขียนแคชจริง:
//   curl -s -X POST ".../pj-snapshot" -H "Authorization: Bearer <STAFF_ACCESS_TOKEN>" \
//     -H "Content-Type: application/json" -d '{"mode":"snapshot","contractId":"<uuid>"}'
//   → ตรวจ select * from pj_contract_snapshot where contract_id='<uuid>' ว่า status/data/image_refs ตรงคาด
//
// 3) mode='images' (admin เท่านั้น) — ต้องรัน mode='snapshot' ให้ status='ok' ก่อน (ต้องมี pj_invoice_uuid):
//   curl -s -X POST ".../pj-snapshot" -H "Authorization: Bearer <ADMIN_ACCESS_TOKEN>" \
//     -H "Content-Type: application/json" -d '{"mode":"images","contractId":"<uuid>","imageKey":"id_card_1"}'
//   → เช็ค ok:true + base64 ไม่ว่าง + เปิด base64 เป็นรูปได้จริง (เช่นแปะใส่ <img src="data:image/jpeg;base64,...">)
// ============================================================================
