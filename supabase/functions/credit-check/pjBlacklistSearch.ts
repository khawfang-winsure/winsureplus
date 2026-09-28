// ===== login PJ + ค้นบัญชีดำ (/manager/check-blacklist) — network layer (impure) =====
// อ้างอิง pj-blacklist-contract.md — login helper "ก๊อปตรง" จาก supabase/functions/pj-sync/index.ts
// (mergeSetCookies/cookieHeader/extractToken + 3-step login) ตามกฎเดิมของโปรเจกต์ "ห้ามเขียน login ใหม่"
// — ทำไม่ import ข้ามโฟลเดอร์ function: Supabase MCP deploy_edge_function deploy ทีละฟังก์ชัน แต่ละ
// โฟลเดอร์แยก dependency กัน ครีมส่งเฉพาะไฟล์ในโฟลเดอร์ credit-check/ ตอน deploy เท่านั้น
//
// ⚠️ session/concurrency decision (ตอบคำถาม contract "CHECK FIRST"):
// อ่าน supabase/functions/pj-sync/index.ts แล้วพบว่า pj-sync "login ใหม่ทุกครั้ง" ที่ถูกเรียก (cron ทุก
// 15 นาที = ~96 ครั้ง/วัน มาตั้งแต่กลางปี 2026 ตามบันทึก pj-autosync-plan.md/pj-autosync-health-audit)
// ไม่เคยมีรายงานว่า login ใหม่ไป "เตะ" เซสชันของ pj-sync เองรอบก่อน หรือเซสชัน browser ของคุณเตย/พนักงาน
// ออกเลยตลอดหลายเดือนที่ผ่านมา — เป็นหลักฐานเชิงประจักษ์ที่หนักแน่นว่า PJ (Laravel, session-based)
// "รองรับหลาย session พร้อมกันต่อ 1 บัญชี" ได้ตามปกติ (ไม่ได้ตั้ง "logout other devices" ไว้)
//
// เลือก: "login ใหม่ทุกครั้งที่เรียก" (เหมือน pj-sync เป๊ะ) ไม่สร้างตาราง pj_session cache ใหม่ เหตุผล:
//   1) หลักฐานข้างต้น — ล็อกอินซ้ำถี่ๆ (ทุก 15 นาที ต่อเนื่องหลายเดือน) ไม่เคยเป็นปัญหากับบัญชีนี้เลย
//   2) ปริมาณใช้งานเช็คเครดิตต่ำมาก (pilot 2 ร้าน, "≤1 ค้นต่อ submit +1 ถ้ามี IMEI, ไม่มี bulk" ตาม
//      contract) — ไม่มีเหตุผลด้าน throughput ที่ต้อง cache session เลย
//   3) ความปลอดภัย: ไม่ต้องเก็บ session cookie ของ PJ ไว้ใน DB เพิ่ม (แม้จะเป็น service_role-only table
//      ก็ยังเป็นพื้นที่เสี่ยงเพิ่มที่ต้องดูแล RLS/revoke ให้ถูกต้อง — น้อยกว่าดีกว่าตามหลัก "ยิ่งน้อย
//      privileged state ยิ่งง่ายต่อการ review")
//   4) ความง่าย: ไม่ต้องจัดการ cookie หมดอายุ/re-login on 419 เลย เพราะ login ใหม่ทุกครั้งอยู่แล้ว
// ถ้าปริมาณใช้งานโตขึ้นมากในอนาคต (เปิดทุกร้าน ไม่ใช่แค่ pilot) ค่อยกลับมาพิจารณา cache ใหม่อีกที
//
// ⚠️ ยังไม่เคยทดสอบกับ PJ จริง (ไม่มี login จริงในสภาพแวดล้อมที่เขียนโค้ดนี้) — smoke test ก่อนเปิดใช้จริง
// ด้วย staff_pj_recheck กับเคสที่รู้ผลอยู่แล้ว (ดู CLAUDE.md เรื่อง verify ก่อนถือว่าเสร็จ)

// @ts-nocheck
import { AwsClient } from "npm:aws4fetch@1";
import { parsePjBlacklistHtml, PjBlacklistParseError, type PjBlacklistRawHit } from "./pjBlacklistParse.ts";

const PJ_BASE = "https://pj-soft.net";
const LOGIN_URL = `${PJ_BASE}/manager/login`;
const BLACKLIST_URL = `${PJ_BASE}/manager/check-blacklist`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── cookie jar helpers (ก๊อปจาก pj-sync/index.ts ตรงๆ — "ห้ามเขียน login ใหม่") ──────────────
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
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
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

/** (รีวิวติ๊ก [YELLOW] #4) ลบ "ทุก" ครั้งที่เจอ secret ในข้อความ — split/join แทน .replace(string,...) ที่
 *  ลบแค่ครั้งแรกที่เจอเท่านั้น ป้องกัน string ว่างทำให้ split ยิบย่อยผิดปกติ (split('').join('***') จะยัด
 *  '***' คั่นทุกตัวอักษร) ด้วยการข้ามไปเลยถ้า secret เป็นค่าว่าง */
function redactAll(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("***");
}

// ── login (3-step, ก๊อปจาก pj-sync/index.ts ตรงๆ) ──────────────────────────────────────────
async function login(
  jar: Map<string, string>,
  signal: AbortSignal,
  username: string,
  password: string,
): Promise<void> {
  const r1 = await fetch(LOGIN_URL, {
    method: "GET",
    headers: { "User-Agent": UA, Accept: "text/html" },
    redirect: "manual",
    signal,
  });
  mergeSetCookies(jar, r1);
  const html1 = await r1.text();
  const token = extractToken(html1);
  if (!token || jar.size === 0) {
    throw new Error("pj login: ไม่ได้ token/cookie จากหน้า login");
  }

  const loginBody = new URLSearchParams();
  loginBody.set("_token", token);
  loginBody.set("email", username);
  loginBody.set("password", password);
  loginBody.set("remember", "on");

  const r2 = await fetch(LOGIN_URL, {
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
    signal,
  });
  mergeSetCookies(jar, r2);
  const location = r2.headers.get("location");
  await r2.text().catch(() => {});

  const is302 = r2.status >= 300 && r2.status < 400;
  const redirectAwayFromLogin = !!location && !/\/manager\/login\/?($|\?)/i.test(location);
  if (!(is302 && redirectAwayFromLogin)) {
    throw new Error("pj login: ไม่สำเร็จ (รหัส/validation ไม่ผ่าน)");
  }
}

// ── ค้น 1 ครั้ง: GET form ดึง token สด (Laravel มักหมุน token รอบ login ใหม่ — เอาจากหน้า login เดิม
// ไม่ชัวร์ว่าใช้ได้กับฟอร์มอื่น) แล้ว POST search_value ตามที่ contract ระบุ (form field ธรรมดา ไม่ใช่
// AJAX DataTable — ไม่ต้องมี X-CSRF-TOKEN header เหมือน endpoint DataTable ของ pj-sync) ──────────
async function fetchFreshToken(jar: Map<string, string>, signal: AbortSignal): Promise<string> {
  const res = await fetch(BLACKLIST_URL, {
    method: "GET",
    headers: { "User-Agent": UA, Accept: "text/html", Cookie: cookieHeader(jar) },
    redirect: "manual",
    signal,
  });
  mergeSetCookies(jar, res);
  const html = await res.text();
  const token = extractToken(html);
  if (!token) throw new Error("pj check-blacklist: ไม่พบ CSRF token");
  return token;
}

async function searchOne(jar: Map<string, string>, signal: AbortSignal, searchValue: string): Promise<string> {
  const token = await fetchFreshToken(jar, signal);
  const body = new URLSearchParams();
  body.set("_token", token);
  body.set("search_value", searchValue);

  // redirect:"follow" ตั้งใจ (ต่างจาก login ที่ต้อง "manual" เพื่ออ่าน Location) — ผลลัพธ์ "พบ"/"ไม่พบ"
  // ของหน้านี้แยกกันด้วยเนื้อหา HTML สุดท้ายที่ได้ ไม่ใช่ด้วยสถานะ redirect เอง (ดู contract: "ไม่พบ" คือ
  // redirect กลับฟอร์มพร้อม flash — เราแค่อยากได้ HTML หน้าสุดท้ายไม่ว่าจะ redirect กี่ hop ก็ตาม)
  const res = await fetch(BLACKLIST_URL, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(jar),
      Referer: BLACKLIST_URL,
      Origin: PJ_BASE,
      Accept: "text/html",
    },
    body: body.toString(),
    redirect: "follow",
    signal,
  });
  mergeSetCookies(jar, res);
  return await res.text();
}

export type PjBlacklistStatus = "clear" | "found" | "error";

export interface PjBlacklistHitWithMatch extends PjBlacklistRawHit {
  matchedBy: "national_id" | "imei";
}

export interface PjBlacklistSearchOutcome {
  status: PjBlacklistStatus;
  hits: PjBlacklistHitWithMatch[];
  error?: string; // สั้น ไม่มี PII/credential — เก็บลง credit_checks.pj_blacklist_error ได้ตรงๆ
}

/** แปลง hit ภายใน (camelCase) → snake_case ตาม shape ที่ contract กำหนดไว้เก็บใน credit_checks.pj_blacklist_hits */
export function toStoredHit(h: PjBlacklistHitWithMatch): Record<string, unknown> {
  return {
    invoice_no: h.invoiceNo,
    status_label: h.statusLabel,
    customer_name: h.customerName,
    shop_name: h.shopName,
    shop_contact: h.shopContact,
    brand: h.brand,
    model: h.model,
    imei_last4: h.imeiLast4,
    down_payment_date: h.downPaymentDate,
    next_due_date: h.nextDueDate,
    installments_total: h.installmentsTotal,
    installments_paid: h.installmentsPaid,
    installments_overdue: h.installmentsOverdue,
    overdue_days: h.overdueDays,
    total_amount: h.totalAmount,
    matched_by: h.matchedBy,
  };
}

/**
 * ค้นบัญชีดำ PJ ด้วยเลขบัตร (เสมอ) + IMEI (ถ้ามี) — ≤2 ครั้งค้นต่อเรียก ตามที่ contract จำกัดไว้
 * ไม่ throw เด็ดขาด (ผู้เรียกจะได้ status='error' แทน ไม่ต้อง try/catch ซ้อนฝั่งเรียกก็ปลอดภัย — แต่ผู้เรียก
 * (index.ts) ยังควรห่อด้วย timeout budget ของตัวเองอีกชั้นเผื่อ signal ไม่ถูก respect ที่ไหนสักจุด)
 */
export async function searchPjBlacklist(opts: {
  username: string;
  password: string;
  nationalIdDigits: string;
  imeiDigits?: string | null;
  signal: AbortSignal;
}): Promise<PjBlacklistSearchOutcome> {
  const jar = new Map<string, string>();
  const hits: PjBlacklistHitWithMatch[] = [];

  try {
    await login(jar, opts.signal, opts.username, opts.password);

    const html1 = await searchOne(jar, opts.signal, opts.nationalIdDigits);
    const parsed1 = parsePjBlacklistHtml(html1);
    if (parsed1.found) {
      for (const h of parsed1.hits) hits.push({ ...h, matchedBy: "national_id" });
    }

    if (opts.imeiDigits) {
      const html2 = await searchOne(jar, opts.signal, opts.imeiDigits);
      const parsed2 = parsePjBlacklistHtml(html2);
      if (parsed2.found) {
        for (const h of parsed2.hits) hits.push({ ...h, matchedBy: "imei" });
      }
    }

    // dedupe ตาม invoiceNo (ค้น 2 รอบอาจเจอใบเดียวกันซ้ำ) — เก็บรอบแรกที่เจอไว้ (national_id มาก่อน imei)
    const seen = new Set<string>();
    const deduped = hits.filter((h) => {
      if (!h.invoiceNo) return true; // ไม่มีเลขใบแจ้งหนี้ (parse พลาดบางฟิลด์) — เก็บไว้ดีกว่าทิ้งเงียบๆ
      if (seen.has(h.invoiceNo)) return false;
      seen.add(h.invoiceNo);
      return true;
    });

    return { status: deduped.length > 0 ? "found" : "clear", hits: deduped };
  } catch (e) {
    const msg = e instanceof PjBlacklistParseError
      ? "รูปแบบหน้าเว็บ PJ เปลี่ยนไป"
      : e instanceof Error
      ? e.message
      : "ค้นบัญชีดำ PJ ไม่สำเร็จ";
    // กรอง username/password ทิ้งเผื่อหลุดมาปนใน error message ของ network layer ไหนสักจุด (defense-in-depth
    // — ปกติ error message ของเราเองไม่เคยมี credential ปนอยู่แล้ว แต่กันไว้ก่อนตามกฎ "ห้าม log credential")
    // (รีวิวติ๊ก [YELLOW] #4) ต้องลบ "ทุก" ครั้งที่เจอ ไม่ใช่แค่ครั้งแรก — .replace(string,...) แทนที่แค่ตัว
    // แรกที่เจอเท่านั้น ใช้ split/join แทนเพื่อลบทั้งหมดทุกจุดที่ซ้ำ
    const safeMsg = redactAll(redactAll(msg, opts.password), opts.username);
    return { status: "error", hits: [], error: safeMsg.slice(0, 200) };
  }
}
