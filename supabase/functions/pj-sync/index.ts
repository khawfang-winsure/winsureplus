// Edge Function: pj-sync — Wave 2 ตัวจริง (ดึงยอด PJ → ลงงวด EXACT อัตโนมัติ / ที่เหลือเข้ากล่องรอตรวจ)
//
// รันทุก 15 นาที (pg_cron jobid 6 — ดึงวันเดียว "วันนี้"). gate ด้วย header x-pj-sync-key (verify_jwt:false)
//
// ── ช่วงวันที่ (14 ก.ค. 2026 เพิ่ม) — แก้บั๊ก "คีย์ย้อนหลัง" ──────────────────────────────────
// jobid 6 เดิมดึงแค่ receipts ของ "วันนี้" (start_date=end_date=date) — ถ้าพนักงาน PJ คีย์ใบเสร็จ
// ย้อนหลัง (paid_date เป็นอดีต แต่กดบันทึกเข้าระบบทีหลัง) รอบของวันนั้นรันไปแล้ว ไม่มีรอบไหนดึงย้อนไปเจอ
// ใบเสร็จนั้นอีกเลย = เงินหายเงียบ ไม่เข้ากล่องรอตรวจด้วย
//
// แก้ด้วย param เสริม (ไม่บังคับ — ไม่ส่งอะไรเลย = พฤติกรรมเดิมเป๊ะ ไม่พัง jobid 6):
//   - days_back: int → start_date = date(หรือวันนี้) - days_back วัน, end_date = date(หรือวันนี้)
//   - start_date + end_date: DD-MM-YYYY ตรงตัว (มาก่อน days_back ถ้าส่งมาทั้งคู่)
// มี pg_cron jobid ใหม่แยกต่างหาก รันทุก 3 วัน ส่ง days_back=30 (ดู migration/SQL คู่กัน) — jobid 6
// ไม่ถูกแตะ ยังรันทุก 15 นาทีแบบวันเดียวเหมือนเดิม
//
// ⚠️ ห้าม log/return ค่า PJ_USERNAME / PJ_PASSWORD / cookie / token / PJ_SYNC_KEY เด็ดขาด
//    error_detail / response JSON ต้องกรอง credential ออกทุกจุด
//
// login helper ก๊อปจาก pj-probe (Wave 0 — พิสูจน์ผ่านแล้ว): mergeSetCookies / cookieHeader /
//   extractToken / cookie jar / 3-step login + X-CSRF-TOKEN. ห้ามเขียน login ใหม่
//
// กันลงซ้ำ (idempotency) — หัวใจ (รัน ~96 รอบ/วัน): เช็คที่ installments.paid_at::date == receipt.paid_date
//   ไม่ใช่ payment_log.created_at (created_at = เวลา insert, รันหลังเที่ยงคืนเพี้ยน). ดู [[pj-payment-sync-method]]

// @ts-nocheck
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.46.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pj-sync-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const PJ_BASE = "https://pj-soft.net";
const LOGIN_URL = `${PJ_BASE}/manager/login`;
const RECEIPTS_URL = `${PJ_BASE}/manager/ajax/receipts`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const SYNC_BY_NAME = "PJ Auto-Sync";
const LOCK_STALE_MINUTES = 10;

// ── กันลงซ้ำแบบ exact ด้วย receipt uuid (มิ.ย.→ก.ค. 2026 แก้บั๊ก "จ่าย 2 ก้อนวันเดียว ก้อน 2 หาย") ──
// เดิมกันซ้ำด้วย (contract_id, pj_paid_date) เท่านั้น (pj_applied_ledger, 0080) — ไม่ดู invoice/ใบเสร็จ
// → 2 ใบเสร็จคนละ invoice_no (เช่น ค่างวดปัจจุบัน + ค่างวดเก่าตกค้าง) จ่ายวันเดียวกัน ใบที่ 2 ถูก skip เงียบ
//
// DEDUP_CUTOFF = "2026-07-13" (วันถัดจากวันที่โค้ดนี้ deploy จริง 12 ก.ค. 2026) — แบ่ง 2 พฤติกรรมตาม
// receipt.paid_date:
//   - paid_date <  CUTOFF: ใช้ legacy check เดิมเป๊ะ (installments.paid_at::date + pj_applied_ledger
//     คีย์ contract_id+paid_date) — ใบเสร็จเก่าไม่เคยเก็บ uuid ไว้ ห้าม backfill จึงต้องพึ่งของเดิมต่อ
//   - paid_date >= CUTOFF: ใช้ pj_applied_receipts (migration 0100) คีย์ pj_receipt_uuid — exact ต่อใบเสร็จ
//     ไม่ชนกันข้ามใบแม้สัญญา/วันเดียวกัน → แก้บั๊กเงินหายจริง
//
// ⚠️ ทำไมไม่ใช้วันที่ deploy ตรงๆ (12 ก.ค.) — transition-day double-apply:
//    รอบ cron ก่อน deploy (เช้าวันที่ 12) sync ยอดของวันที่ 12 ไปแล้วผ่าน legacy path (ตอนนั้นยังไม่มี
//    ตาราง pj_applied_receipts) → installments.paid_at=12-07 + pj_applied_ledger(contract,12-07) มีแล้ว
//    แต่ pj_applied_receipts ยังไม่มี uuid ของใบเสร็จเหล่านั้นเลย (ตารางเพิ่งสร้างว่างเปล่า) ถ้า CUTOFF
//    ตั้งเป็น "2026-07-12" (>= เช็คตัวมันเอง) รอบ cron ถัดไปในวันเดียวกันจะเห็นใบเสร็จ paid_date=12-07
//    เข้า path uuid ทันที (12 >= 12) → หา uuid ใน pj_applied_receipts ไม่เจอ (ว่าง) → คิดว่ายังไม่เคยลง
//    → apply ซ้ำ = เงินเบิ้ลยอดที่ลงไปแล้วตั้งแต่เช้า (path uuid ไม่เช็ค installments.paid_at อีกต่อไป —
//    safety-net นั้นถูกตัดทิ้งไปแล้วเพื่อแก้บั๊ก 2-same-day จึงไม่มีอะไรกันยอดเช้านี้เลย)
//    เลื่อน CUTOFF ไปเป็นวันถัดไป (13 ก.ค.) แทน — วันที่ 12 ทั้งวัน (รวมยอดที่ sync ไปแล้วตอนเช้า) ยังคง
//    ใช้ legacy path ต่อเนื่องเป๊ะ (idempotent อยู่แล้วด้วยกลไกเดิม) ส่วน uuid path เริ่มทำงานแบบสะอาดตั้งแต่
//    ใบเสร็จวันที่ 13 เป็นต้นไป ไม่มีทางไปทับยอดที่ legacy เพิ่งลงเช้านี้
//
// trade-off ที่ยอมรับ: วันที่ 12 ก.ค. (วัน deploy) บั๊ก "2-same-day" เดิม (คนละ invoice_no จ่ายวันเดียวกัน
// ใบที่ 2 skip เงียบ) ยังเกิดได้อยู่ 1 วัน เพราะยังไม่ใช้ path uuid — แลกกับการไม่เสี่ยงเบิ้ลยอดเช้านี้ทั้งหมด
// ซึ่งเสียหายกว่ามาก (edge case นานๆ ครั้ง เทียบกับความเสี่ยงเบิ้ลทุกยอดของวันนี้)
//
// ห้ามแก้ค่านี้ย้อนหลัง (จะทำให้ใบเสร็จที่เพิ่งข้าม cutoff ไปใช้ legacy path ทั้งที่ไม่มี ledger row จริง)
const DEDUP_CUTOFF = "2026-07-13";

// ── cookie jar helpers (ก๊อปจาก pj-probe ตรงตัว — พิสูจน์ผ่านแล้ว) ────────────
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

function ddmmyyyyToday(): string {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

// เลื่อนวันที่ DD-MM-YYYY ไป deltaDays วัน (ใช้ UTC ล้วนกันปัญหา DST/timezone ตอนข้ามเดือน/ปี —
// ไม่เกี่ยวกับเวลาไทยเพราะเทียบแค่ "วันที่" ไม่มีเวลา)
function shiftDdMmYyyy(ddmmyyyy: string, deltaDays: number): string {
  const m = ddmmyyyy.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return ddmmyyyy; // defensive — ไม่ควรเกิดเพราะ caller validate regex มาก่อนแล้ว
  const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  d.setUTCDate(d.getUTCDate() + deltaDays);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

// "1,234.50" / "1234" / number → number. กับดัก: PJ ส่ง string มี comma
function parseAmount(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const cleaned = v.replace(/,/g, "").replace(/[^\d.-]/g, "").trim();
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// "DD-MM-YYYY" หรือ "YYYY-MM-DD" → "YYYY-MM-DD" (date เปรียบเทียบ + timestamptz)
function toIsoDate(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  // อาจมีเวลาต่อท้าย "DD-MM-YYYY HH:mm:ss" → เอาแค่ token แรก
  const datePart = s.split(/[ T]/)[0];
  let m = datePart.match(/^(\d{2})-(\d{2})-(\d{4})$/); // DD-MM-YYYY
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/); // YYYY-MM-DD
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = datePart.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); // DD/MM/YYYY
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

// field ใน receipt row อาจมีหลายชื่อ — defensive pick
function pick(row: any, keys: string[]): any {
  for (const k of keys) {
    if (row && row[k] != null && row[k] !== "") return row[k];
  }
  return null;
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

    // ── 0) Auth gate (x-pj-sync-key) ───────────────────────────────────────────
    const PJ_SYNC_KEY = Deno.env.get("PJ_SYNC_KEY") ?? "";
    if (!PJ_SYNC_KEY) {
      return json({ ok: false, error: "PJ_SYNC_KEY not configured" }, 500);
    }
    const callerKey = req.headers.get("x-pj-sync-key") ?? "";
    if (callerKey !== PJ_SYNC_KEY) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    // body params
    let body: any = {};
    try {
      const txt = await req.text();
      body = txt ? JSON.parse(txt) : {};
    } catch { /* default {} */ }
    const dryRun: boolean = body?.dryRun === true;
    // mode="reconcile" (0114) — ตรวจจับใบเสร็จ PJ ที่หาย/ถูกแก้ (ไม่แตะเงิน) แยกจาก path เดิม (money-in)
    // ไม่ส่ง mode มาเลย = path เดิมเป๊ะ (mode="sync") ห้ามกระทบ money-in path ที่มีอยู่แล้ว
    const mode: "sync" | "reconcile" = body?.mode === "reconcile" ? "reconcile" : "sync";
    const DDMMYYYY_RE = /^\d{2}-\d{2}-\d{4}$/;
    const date: string =
      typeof body?.date === "string" && DDMMYYYY_RE.test(body.date)
        ? body.date
        : ddmmyyyyToday();

    // ── ช่วงวันที่ดึง receipts (14 ก.ค. 2026 เพิ่ม) ──────────────────────────────
    // ลำดับความสำคัญ: start_date+end_date ระบุตรง > days_back > legacy (ไม่ส่งอะไรเลย
    // = startDate=endDate=date เป๊ะเหมือนโค้ดเดิม — ต้อง backward-compat กับ jobid 6 ทุก 15 นาที)
    const MAX_DAYS_BACK = 90; // กัน param มั่ว/ยิง window ใหญ่เกินจำเป็นจนช้า+เสี่ยง timeout
    let startDate = date;
    let endDate = date;
    let daysBackUsed = 0;
    if (
      typeof body?.start_date === "string" && DDMMYYYY_RE.test(body.start_date) &&
      typeof body?.end_date === "string" && DDMMYYYY_RE.test(body.end_date)
    ) {
      startDate = body.start_date;
      endDate = body.end_date;
    } else {
      const rawDaysBack = Number(body?.days_back);
      if (Number.isFinite(rawDaysBack) && rawDaysBack > 0) {
        daysBackUsed = Math.min(Math.floor(rawDaysBack), MAX_DAYS_BACK);
        endDate = date;
        startDate = shiftDdMmYyyy(date, -daysBackUsed);
      }
    }
    const syncIsoDate = toIsoDate(endDate); // YYYY-MM-DD ปลาย window (fallback ใบเสร็จที่ parse paid_date ไม่ได้)

    const PJ_USERNAME = Deno.env.get("PJ_USERNAME") ?? "";
    const PJ_PASSWORD = Deno.env.get("PJ_PASSWORD") ?? "";
    if (!PJ_USERNAME || !PJ_PASSWORD) {
      return json({ ok: false, error: "PJ credentials not configured" }, 500);
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // ── 1) Concurrency lock ─────────────────────────────────────────────────────
    let runId: string | null = null;
    const lockOwner = crypto.randomUUID();

    if (!dryRun) {
      const staleCut = new Date(Date.now() - LOCK_STALE_MINUTES * 60 * 1000).toISOString();
      const { data: running, error: lockErr } = await db
        .from("pj_sync_runs")
        .select("id")
        .eq("status", "running")
        .gt("started_at", staleCut)
        .limit(1);
      if (lockErr) {
        return json({ ok: false, error: "lock check failed", detail: lockErr.message }, 500);
      }
      if (running && running.length > 0) {
        return json({ ok: true, skipped: true, reason: "another run in progress" });
      }

      const { data: inserted, error: insErr } = await db
        .from("pj_sync_runs")
        .insert({ status: "running", lock_owner: lockOwner, run_kind: mode })
        .select("id")
        .single();
      if (insErr || !inserted) {
        return json({ ok: false, error: "could not start run", detail: insErr?.message }, 500);
      }
      runId = inserted.id;
    }

    // helper: ปิดรอบด้วย error (กรอง credential ไม่ให้หลุดใน error_detail)
    const failRun = async (status: string, safeDetail: string, httpStatus = 200) => {
      if (!dryRun && runId) {
        await db
          .from("pj_sync_runs")
          .update({ status, finished_at: new Date().toISOString(), error_detail: safeDetail })
          .eq("id", runId)
          .catch(() => {});
      }
      return json({ ok: false, dryRun, date, error: safeDetail }, httpStatus);
    };

    const jar = new Map<string, string>();

    try {
      // ── 2) Login PJ (helper จาก probe) ───────────────────────────────────────
      const r1 = await fetch(LOGIN_URL, {
        method: "GET",
        headers: { "User-Agent": UA, Accept: "text/html" },
        redirect: "manual",
      });
      mergeSetCookies(jar, r1);
      const html1 = await r1.text();
      const token = extractToken(html1);
      if (!token || jar.size === 0) {
        return await failRun("login_failed", "login: ไม่ได้ token/cookie จากหน้า login");
      }

      const loginBody = new URLSearchParams();
      loginBody.set("_token", token);
      loginBody.set("email", PJ_USERNAME);
      loginBody.set("password", PJ_PASSWORD);
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
      });
      mergeSetCookies(jar, r2);
      const location = r2.headers.get("location");
      await r2.text().catch(() => {});

      const is302 = r2.status >= 300 && r2.status < 400;
      const redirectAwayFromLogin = !!location && !/\/manager\/login\/?($|\?)/i.test(location);
      if (!(is302 && redirectAwayFromLogin)) {
        return await failRun("login_failed", "login: ไม่สำเร็จ (รหัส/validation ไม่ผ่าน)");
      }

      // ── 3) ดึง receipts ของช่วง [startDate, endDate] — เพจ pagination (14 ก.ค. 2026 เพิ่ม) ─────
      // ⚠️ เดิม length=500 ดึงครั้งเดียวพอเพราะ window=วันเดียว แถวไม่มากพอเกิน 500 อยู่แล้ว
      //    แต่ window 30 วัน (deep-scan cron) อาจมี receipts รวมเกิน 500 แถว — ถ้าไม่ทำ pagination
      //    ข้อมูลหน้าหลังๆ หายเงียบ (DataTable ตัดที่ length เสมอ) จึงต้อง loop ดึงทีละหน้าจนครบ
      const xsrfRaw = jar.get("XSRF-TOKEN") ?? "";
      let xsrfToken = "";
      try { xsrfToken = decodeURIComponent(xsrfRaw); } catch { xsrfToken = xsrfRaw; }

      const PAGE_LENGTH = 500;
      const MAX_PAGES = 100; // safety valve กันวนไม่รู้จบถ้า DataTable ส่ง recordsTotal เพี้ยน (100*500=50,000 แถว เกินจริงมากแล้วสำหรับ 90 วัน)

      async function fetchReceiptsPage(
        startOffset: number,
      ): Promise<{ rows: any[]; recordsTotal: number; recordsFiltered: number }> {
        const dtBody = new URLSearchParams();
        dtBody.set("draw", String(Math.floor(startOffset / PAGE_LENGTH) + 1));
        dtBody.set("start", String(startOffset));
        dtBody.set("length", String(PAGE_LENGTH));
        dtBody.set("_token", token);
        dtBody.set("start_date", startDate);
        dtBody.set("end_date", endDate);

        const res = await fetch(RECEIPTS_URL, {
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
        });

        const pageCt = res.headers.get("content-type") ?? "";
        const pageText = await res.text();
        let pageParsed: any = null;
        if (pageCt.includes("application/json")) {
          try { pageParsed = JSON.parse(pageText); } catch { /* not json */ }
        } else {
          const trimmed = pageText.trim();
          if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try { pageParsed = JSON.parse(trimmed); } catch { /* not json */ }
          }
        }
        if (!pageParsed || typeof pageParsed !== "object") {
          throw new Error("receipts: response ไม่ใช่ JSON (session/CSRF อาจไม่ผ่าน)");
        }
        return {
          rows: Array.isArray(pageParsed.data) ? pageParsed.data : [],
          recordsTotal: Number(pageParsed.recordsTotal ?? 0),
          recordsFiltered: Number(pageParsed.recordsFiltered ?? 0),
        };
      }

      const rows: any[] = [];
      let pagesFetched = 0;
      let offset = 0;
      while (true) {
        let page: { rows: any[]; recordsTotal: number; recordsFiltered: number };
        try {
          page = await fetchReceiptsPage(offset);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return await failRun("error", msg);
        }
        pagesFetched++;
        rows.push(...page.rows);
        // เช็คทั้ง recordsFiltered/recordsTotal (DataTable convention) และ "ได้น้อยกว่าที่ขอ" กันเคส
        // field เหล่านี้เพี้ยน/ไม่ส่งมา (defensive — ยังต้องหยุด loop ได้ถูกต้องอยู่ดี)
        const known = page.recordsFiltered || page.recordsTotal || 0;
        const gotFullPage = page.rows.length >= PAGE_LENGTH;
        const reachedKnownTotal = known > 0 && rows.length >= known;
        if (!gotFullPage || reachedKnownTotal || page.rows.length === 0 || pagesFetched >= MAX_PAGES) {
          break;
        }
        offset += PAGE_LENGTH;
      }

      // pagination ตัดกลางทางเพราะชน MAX_PAGES (ไม่ใช่ "ดึงครบแล้วพอดี") — ใช้เป็น truncated
      // signal ของ reconcile mode (evaluateRunSanity ใน pjReceiptDrift.ts: truncated=true → ok=false เสมอ)
      const pageTruncated = pagesFetched >= MAX_PAGES;

      // ══════════════════════════════════════════════════════════════════════════
      // mode="reconcile" (0114) — ตรวจจับใบเสร็จ PJ ที่หาย/ถูกแก้ ไม่แตะเงิน/installments เลย
      // แยกออกจาก path เดิม (money-in, ด้านล่าง) โดยสิ้นเชิง หลัง login+ดึง receipts เสร็จ (share กัน)
      // ══════════════════════════════════════════════════════════════════════════
      if (mode === "reconcile") {
        // normalize เป็น flat list ต่อ "ใบเสร็จ" (ไม่ aggregate ต่อ invoice เหมือน path เงินเข้า — ตรวจ
        // drift เทียบกัน "รายใบ" ด้วย uuid) ⚠️ ต้องรวม "down" ด้วย — พี่ดิวชี้: ถ้ากรอง down ทิ้งเหมือน
        // path เงินเข้า (บรรทัด "if (typeRaw.includes('down'))...continue") ใบที่ประเภทถูกเปลี่ยนเป็น
        // down (จาก installment เดิม) จะดูเหมือน "หายไปเลย" (missing) ทั้งที่จริงคือ "เปลี่ยนประเภท" (type
        // drift) — ห้าม reuse โค้ด skip down จาก path เงินเข้าที่นี่เด็ดขาด
        type SnapshotRow = { uuid: string; amount: number; payment_type: string; paid_date: string | null };
        const snapshotRows: SnapshotRow[] = [];
        for (const row of rows) {
          const uuidRaw = pick(row, ["uuid"]);
          const uuid = uuidRaw ? String(uuidRaw).trim() : null;
          if (!uuid) continue; // ไม่มี uuid ให้เทียบ — ข้าม (ไม่ error ทั้งรอบ)
          const typeRaw = String(pick(row, ["payment_type", "type"]) ?? "").toLowerCase();
          const amt = parseAmount(pick(row, ["amount", "paid_amount", "total"]));
          const paidDate = toIsoDate(pick(row, ["paid_date", "payment_date", "date", "created_at"]));
          let category: string;
          if (typeRaw.includes("down")) category = "down";
          else if (typeRaw.includes("penalty")) category = "penalty";
          else if (typeRaw.includes("installment")) category = "installment";
          else category = "other";
          snapshotRows.push({ uuid, amount: amt, payment_type: category, paid_date: paidDate });
        }

        const windowStartIso = toIsoDate(startDate);
        const windowEndIso = toIsoDate(endDate);
        const snapshotAtIso = new Date().toISOString();

        const { data: rpcData, error: rpcErr } = await db.rpc("reconcile_pj_receipts", {
          p_snapshot: { rows: snapshotRows, truncated: pageTruncated },
          p_window_start: windowStartIso,
          p_window_end: windowEndIso,
          p_snapshot_at: snapshotAtIso,
          p_dry_run: dryRun,
        });

        if (rpcErr) {
          return await failRun("error", `db error (reconcile_pj_receipts): ${rpcErr.message}`, 500);
        }

        const result = (rpcData ?? {}) as {
          ok: boolean;
          reason?: string | null;
          pjRowCount?: number;
          ourEvaluableCount?: number;
          evaluated?: number;
          missingReported?: number;
          changedReported?: number;
          details?: unknown[];
        };

        // finalize run row (bookkeeping เท่านั้น — RPC ไม่แตะ pj_sync_runs เลย ตามที่ comment ไว้ใน
        // migration 0114 SECTION 4: RPC=diff เงิน/ใบเสร็จ, Edge Function JS=bookkeeping เหมือน mode sync เป๊ะ)
        if (!dryRun && runId) {
          await db
            .from("pj_sync_runs")
            .update({
              finished_at: new Date().toISOString(),
              status: result.ok ? "success" : "error",
              error_detail: result.ok ? null : (result.reason ?? "reconcile sanity check failed"),
              receipts_fetched: result.pjRowCount ?? snapshotRows.length,
              auto_applied_count: 0,
              auto_applied_amount: 0,
              review_count: (result.missingReported ?? 0) + (result.changedReported ?? 0),
              window_start_date: windowStartIso,
              window_end_date: windowEndIso,
              pages_fetched: pagesFetched,
              truncated: pageTruncated,
            })
            .eq("id", runId)
            .catch(() => {});
        }

        // ⚠️ dryRun ของ reconcile ต้องคืน detail เต็ม (result.details — ไม่ใช่ summary count อย่างเดียว
        // เหมือน dryRun ของ mode sync เดิม) ไม่งั้น debug ไม่ได้ว่า uuid ไหนโดน kind อะไร
        return json({
          ok: result.ok,
          mode: "reconcile",
          dryRun,
          date,
          start_date: startDate,
          end_date: endDate,
          days_back: daysBackUsed,
          pages_fetched: pagesFetched,
          receipts_fetched: rows.length,
          snapshot_row_count: snapshotRows.length,
          truncated: pageTruncated,
          reason: result.reason ?? null,
          pj_row_count: result.pjRowCount ?? 0,
          our_evaluable_count: result.ourEvaluableCount ?? 0,
          evaluated: result.evaluated ?? 0,
          missing_reported: result.missingReported ?? 0,
          changed_reported: result.changedReported ?? 0,
          details: result.details ?? [],
        });
      }

      // ── aggregate ต่อ invoice_no ─────────────────────────────────────────────
      type Agg = {
        invoice_no: string;
        inst_amt: number;
        pen_amt: number;
        other_amt: number;
        has_installment: boolean;
        has_other: boolean;
        installment_receipt_count: number;
        paid_date: string | null; // YYYY-MM-DD
        raw: any[];
        // ใบเสร็จย่อยที่ประกอบเป็น invoice นี้ (1 แถวต่อ 1 receipt.uuid) — ใช้ dedup exact (>= DEDUP_CUTOFF)
        // แยกจาก raw (raw = ทั้งแถวดิบ เก็บไว้ล้วนๆ เผื่อ reconcile / ใส่ pj_sync_review.raw_json)
        receipts: { uuid: string; amount: number; paymentType: "installment" | "penalty" | "other" }[];
      };
      const aggMap = new Map<string, Agg>();
      let downSkipped = 0;

      for (const row of rows) {
        const invRaw = pick(row, ["invoice_no", "inv_no", "invoiceNo", "contract_no"]);
        const typeRaw = String(pick(row, ["payment_type", "type"]) ?? "").toLowerCase();
        const amt = parseAmount(pick(row, ["amount", "paid_amount", "total"]));
        const paidDate = toIsoDate(pick(row, ["paid_date", "payment_date", "date", "created_at"]));
        // uuid ดิบต่อใบเสร็จจาก PJ (field "uuid" — UUIDv7 unique ทุกใบ) — ใช้ dedup exact แทน
        // contract-day skip หยาบเดิม (ดู DEDUP_CUTOFF ด้านบน + migration 0100 pj_applied_receipts)
        const receiptUuidRaw = pick(row, ["uuid"]);
        const receiptUuid = receiptUuidRaw ? String(receiptUuidRaw).trim() : null;

        if (!invRaw) continue;
        const inv = String(invRaw).trim();

        if (typeRaw.includes("down")) {
          downSkipped++;
          continue; // down_payment = สัญญาใหม่ ข้าม
        }

        // ⚠️ (14 ก.ค. 2026) คีย์ aggMap ต้องเป็น (invoice_no + paid_date) ไม่ใช่ invoice_no เฉยๆ —
        //    เดิมดึงแค่วันเดียว ทุกแถวในรอบเดียวกัน paid_date ตรงกันอยู่แล้วโดยบังเอิญ คีย์ inv เดี่ยวๆ
        //    เลยดูเหมือนถูก แต่พอ window กว้างหลายวัน (deep-scan) invoice เดียวกันอาจมีใบเสร็จคนละวัน
        //    (เช่น จ่ายงวด 2 วันที่ 5 + งวด 3 วันที่ 20) — ถ้ายังรวมเป็นก้อนเดียวจะเอายอด 2 วันไปตัด
        //    เหมือนเป็นการจ่ายครั้งเดียว ทำให้ idempotency/paid_date ที่บันทึกผิดวัน (ใช้แค่วันแรกที่เจอ)
        //    และเสี่ยง apply ซ้ำ/พลาดในรอบถัดไป แยกคีย์ตามวันช่วยให้แต่ละ "เหตุการณ์จ่ายเงิน 1 วัน" อิสระ
        //    จากกัน ตรงกับ granularity ที่ dedup (ledger/uuid) ใช้อยู่แล้วเป๊ะ — ไม่กระทบ single-day call
        //    เดิมเลย (ทุกแถวในนั้น paid_date เดียวกันอยู่แล้ว คีย์รวมออกมาเหมือนเดิมทุกประการ)
        const aggKey = `${inv}::${paidDate ?? "unknown"}`;
        let a = aggMap.get(aggKey);
        if (!a) {
          a = {
            invoice_no: inv,
            inst_amt: 0,
            pen_amt: 0,
            other_amt: 0,
            has_installment: false,
            has_other: false,
            installment_receipt_count: 0,
            paid_date: paidDate,
            raw: [],
            receipts: [],
          };
          aggMap.set(aggKey, a);
        }
        a.raw.push(row);
        if (paidDate && !a.paid_date) a.paid_date = paidDate;

        let category: "installment" | "penalty" | "other";
        if (typeRaw.includes("penalty")) {
          a.pen_amt += amt;
          category = "penalty";
        } else if (typeRaw.includes("installment")) {
          a.inst_amt += amt;
          a.has_installment = true;
          a.installment_receipt_count++;
          category = "installment";
        } else {
          // other (หรือ type แปลก) → flag OTHER
          a.other_amt += amt;
          a.has_other = true;
          category = "other";
        }
        // เก็บ uuid ต่อใบเสร็จ (down_payment ข้ามไปแล้วด้านบน ไม่เข้ามาถึงตรงนี้)
        if (receiptUuid) a.receipts.push({ uuid: receiptUuid, amount: amt, paymentType: category });
      }

      // ── 4) categorize + apply/review ─────────────────────────────────────────
      const autoApplied: { contract_no: string; amount: number }[] = [];
      const review: { inv: string; reason: string }[] = [];
      let autoAppliedTotal = 0; // inst + pen
      let skippedAlreadySynced = 0;

      const reviewRows: any[] = []; // batch insert ตอนจบ (ไม่ dryRun)

      const queueReview = (
        a: Agg,
        reason: string,
        matchedContractId: string | null,
        pjType: string,
        pjAmount: number,
      ) => {
        review.push({ inv: a.invoice_no, reason });
        reviewRows.push({
          run_id: runId,
          pj_invoice_no: a.invoice_no,
          pj_payment_type: pjType,
          pj_amount: pjAmount,
          pj_paid_date: a.paid_date,
          matched_contract_id: matchedContractId,
          reason,
          raw_json: a.raw,
          status: "pending",
        });
      };

      // ── time budget (14 ก.ค. 2026 เพิ่ม) — กัน gateway timeout ตอน window กว้าง (30 วัน) ────────
      // ประมวลผลแต่ละ invoice-วัน ต้องเรียก DB หลายรอบ (lookup contract/installments/ledger + RPC) —
      // window ยาวอาจมี aggMap หลายร้อยก้อน รันจนหมดอาจเกิน wall-clock limit ของ Edge Function จน
      // gateway ตัดการเชื่อมต่อทั้งที่ DB ลงสำเร็จไปแล้วบางส่วน (ดู comment เรื่อง run_daily_update ท้ายไฟล์)
      // ทางแก้: ตั้งงบเวลา ถ้าเกินกลางทาง "หยุดเงียบๆ" (ไม่ทำต่อ ไม่ error) ปล่อยก้อนที่เหลือให้รอบถัดไป
      // จับต่อเอง — ปลอดภัยเพราะ cron ใหม่รันทุก 3 วันด้วย window 30 วันที่คาบเกี่ยวกันเยอะมาก (ใบเสร็จที่
      // ไม่ทันประมวลผลรอบนี้ยังอยู่ใน window ของรอบหน้าแน่นอน ไม่มีทางหลุดหาย แค่ช้าไปไม่เกิน 1 รอบ)
      const PROCESSING_TIME_BUDGET_MS = 45_000;
      const loopStartedAt = Date.now();
      let truncated = false;
      const aggEntries = Array.from(aggMap.values());
      const aggEntriesTotal = aggEntries.length;
      let aggEntriesProcessed = 0;

      for (const a of aggEntries) {
        if (Date.now() - loopStartedAt > PROCESSING_TIME_BUDGET_MS) {
          truncated = true;
          break; // ที่เหลือปล่อยรอบถัดไป (ดู comment ด้านบน) — ไม่ error ไม่ crash ทั้งรอบ
        }
        aggEntriesProcessed++;
        // เคสไม่มี installment เลย — penalty-only หรือ other-only → review
        if (!a.has_installment) {
          // lookup contract ด้วย inv_no ก่อน — เหมือน path installment (บรรทัด 399-407)
          // เพื่อผูก matched_contract_id ให้กล่องรอตรวจแสดงสัญญาได้ถูกต้อง
          const { data: noInstContracts, error: noInstCErr } = await db
            .from("contracts")
            .select("id, contract_no, inv_no")
            .eq("inv_no", a.invoice_no)
            .limit(2);
          if (noInstCErr) {
            return await failRun("error", `db error (contracts): ${noInstCErr.message}`, 500);
          }
          // เจอ ≥1 ตัว → ใช้ตัวแรก (inv ซ้ำ=ผิดปกติ แต่ผูก id ไปก่อนดีกว่า null)
          const noInstContractId =
            noInstContracts && noInstContracts.length > 0 ? noInstContracts[0].id : null;

          // ── กันลง review ซ้ำ (idempotency) — เคส penalty/other-only ที่เคย resolved/skipped/auto_resolved ไปแล้ว ─
          // Bug เดิม: batch-dedup ด้านล่าง (บรรทัด ~548) skip เฉพาะ pj_sync_review ที่ status='pending' ของ
          // pj_invoice_no เดียวกัน — ไม่ skip แถวที่ resolved/skipped ไปแล้ว → รอบ sync ถัดไปสร้าง pending ใหม่ซ้ำ
          // แก้: เช็คตรงนี้ก่อน queueReview เลย ด้วย natural key (pj_invoice_no + pj_paid_date) บน pj_sync_review
          // ที่ status ไม่ใช่ pending (แปลว่าคนจัดการไปแล้ว) + เช็ค pj_applied_ledger (contract_id + paid_date)
          // ถ้ามีสัญญาที่ match แล้ว (ครอบเคสที่คนกดยืนยันลงยอดจากกล่องรอตรวจไปแล้ว)
          // ⚠️ a.paid_date อาจเป็น null — PostgREST .eq(col, null) ไม่ match แถวที่เป็น NULL จริง (ต้องใช้ .is())
          //    เลยแยก query 2 แบบตามว่ามี paid_date หรือไม่ กัน false-negative (คิดว่ายังไม่เคย handle ทั้งที่เคยแล้ว)
          let alreadyHandled = false;
          let reviewQuery = db
            .from("pj_sync_review")
            .select("id")
            .eq("pj_invoice_no", a.invoice_no)
            .in("status", ["resolved", "skipped", "auto_resolved"]);
          reviewQuery = a.paid_date
            ? reviewQuery.eq("pj_paid_date", a.paid_date)
            : reviewQuery.is("pj_paid_date", null);
          const { data: resolvedReview } = await reviewQuery.limit(1);
          if (resolvedReview && resolvedReview.length > 0) alreadyHandled = true;

          if (!alreadyHandled && noInstContractId && a.paid_date) {
            const { data: ledgerRow } = await db
              .from("pj_applied_ledger")
              .select("id")
              .eq("contract_id", noInstContractId)
              .eq("pj_paid_date", a.paid_date)
              .maybeSingle();
            if (ledgerRow) alreadyHandled = true;
          }

          if (alreadyHandled) {
            skippedAlreadySynced++;
            continue;
          }

          if (a.has_other) {
            queueReview(a, "OTHER", noInstContractId, "other", a.other_amt);
          } else if (a.pen_amt > 0) {
            // ค่าปรับล้วน ไม่มีงวด → ให้คนตัดสิน
            queueReview(a, "AMOUNT_MISMATCH", noInstContractId, "penalty", a.pen_amt);
          }
          continue;
        }
        // มี other ปนกับ installment → flag (ยอดผสม คนต้องดู)
        if (a.has_other) {
          queueReview(a, "OTHER", null, "other", a.other_amt);
          continue;
        }

        // หา contract ด้วย inv_no
        const { data: contracts, error: cErr } = await db
          .from("contracts")
          .select("id, contract_no, inv_no")
          .eq("inv_no", a.invoice_no)
          .limit(2);
        if (cErr) {
          return await failRun("error", `db error (contracts): ${cErr.message}`, 500);
        }
        if (!contracts || contracts.length === 0) {
          queueReview(a, "UNMATCHED", null, "installment", a.inst_amt);
          continue;
        }
        if (contracts.length > 1) {
          // inv_no ซ้ำ (ไม่ควรเกิด แต่ป้องกัน) → ให้คนดู
          queueReview(a, "AMOUNT_MISMATCH", contracts[0].id, "installment", a.inst_amt);
          continue;
        }
        const contract = contracts[0];
        const contractNo = contract.contract_no ?? contract.inv_no ?? a.invoice_no;

        // ดึง installments เรียง installment_no
        const { data: insts, error: iErr } = await db
          .from("installments")
          .select("id, installment_no, amount, paid_amount, status, paid_at")
          .eq("contract_id", contract.id)
          .order("installment_no", { ascending: true });
        if (iErr) {
          return await failRun("error", `db error (installments): ${iErr.message}`, 500);
        }
        const allInsts = insts ?? [];

        // ── กันลงซ้ำ (idempotency) ─────────────────────────────────────────────
        const targetPaidDate = a.paid_date ?? syncIsoDate;
        // >= DEDUP_CUTOFF ใช้ path uuid ใหม่ (exact ต่อใบเสร็จ) / < CUTOFF (หรือ paid_date หา ไม่ได้) ใช้ legacy
        const usesUuidDedup = targetPaidDate != null && targetPaidDate >= DEDUP_CUTOFF;

        let alreadySynced = false; // legacy path เท่านั้น
        let ledgerAlreadyApplied = false; // legacy path เท่านั้น
        let alreadyAppliedByUuid = false; // uuid path เท่านั้น

        if (usesUuidDedup) {
          // ── path ใหม่: เช็ค pj_applied_receipts ด้วย uuid ต่อใบเสร็จ (a.receipts) ─────────
          //    เจอ uuid ใดก็ตามในเซ็ตนี้แปลว่า invoice นี้ (ของรอบนี้) ลงไปแล้ว → ข้ามทั้งก้อน
          //    ใบเสร็จ invoice อื่น (uuid ต่างชุด) ของสัญญา/วันเดียวกัน ไม่ถูกกระทบ — จุดที่แก้บั๊กเงินหาย
          const receiptUuids = a.receipts.map((r) => r.uuid);
          if (receiptUuids.length > 0) {
            const { data: seenReceipts, error: seenErr } = await db
              .from("pj_applied_receipts")
              .select("pj_receipt_uuid")
              .in("pj_receipt_uuid", receiptUuids);
            if (seenErr) {
              return await failRun("error", `db error (pj_applied_receipts check): ${seenErr.message}`, 500);
            }
            if (seenReceipts && seenReceipts.length > 0) alreadyAppliedByUuid = true;
          }
        } else {
          // ── path เดิม (คงพฤติกรรมเดิมเป๊ะ — ห้ามแก้) ──────────────────────────────────
          // (1) เช็ค paid_at เดิม: มีงวดที่ paid_at::date == วันจ่ายของใบเสร็จ → ลงไปแล้ว/import แล้ว
          // (2) เช็ค ledger: pj_applied_ledger มีแถวของ (contract_id, pj_paid_date) นี้แล้ว
          //     ครอบเคสจ่ายขาด (PARTIAL) ที่พนักงานกดยืนยันแล้ว → paid_at ยังเป็น null แต่ ledger จดไว้แล้ว
          alreadySynced = allInsts.some((it) => {
            if (!it.paid_at) return false;
            const d = toIsoDate(it.paid_at);
            return d != null && targetPaidDate != null && d === targetPaidDate;
          });

          if (targetPaidDate) {
            const { data: ledgerRow } = await db
              .from("pj_applied_ledger")
              .select("inst_amount, pen_amount")
              .eq("contract_id", contract.id)
              .eq("pj_paid_date", targetPaidDate)
              .maybeSingle();
            if (ledgerRow) ledgerAlreadyApplied = true;
          }
        }

        if (alreadySynced || ledgerAlreadyApplied || alreadyAppliedByUuid) {
          skippedAlreadySynced++;
          continue; // ไม่ลง ไม่ review
        }

        // next-unpaid = ตัวแรก status in (pending, late)
        const nextUnpaid = allInsts.find(
          (it) => it.status === "pending" || it.status === "late",
        );
        if (!nextUnpaid) {
          // ไม่มีงวดค้าง แต่มีใบเสร็จ installment → จ่ายเกิน/ปิดไปแล้ว ให้คนดู
          queueReview(a, "AMOUNT_MISMATCH", contract.id, "installment", a.inst_amt);
          continue;
        }

        const remaining = parseAmount(nextUnpaid.amount) - parseAmount(nextUnpaid.paid_amount);
        const instAmt = a.inst_amt;

        // กฎใหม่ (Pete สั่ง):
        //   instAmt >= remaining (จ่ายครบงวด/เกิน/ข้ามงวด) → ลงอัตโนมัติด้วย spread (ทยอยตัดข้ามงวด)
        //   instAmt <  remaining (จ่ายขาด ไม่ถึงงวด)       → PARTIAL เข้ากล่องรอตรวจ
        //   remaining<=0 หรือเคสแปลก                        → AMOUNT_MISMATCH รอตรวจ
        if (remaining > 0 && instAmt >= remaining) {
          // จ่ายครบงวด/เกิน → ลงอัตโนมัติด้วย spread
          if (dryRun) {
            autoApplied.push({ contract_no: contractNo, amount: instAmt + a.pen_amt });
            autoAppliedTotal += instAmt + a.pen_amt;
            continue;
          }
          // ⚠️ ต้องใช้ UTC midnight ("Z") ไม่ใช่ +07:00 — Postgres timestamptz เก็บเป็น UTC
          //    ถ้าใช้ +07:00 → '2026-06-30T00:00:00+07:00' = UTC '2026-06-29 17:00Z'
          //    → paid_at::date (UTC) = 29 ไม่ใช่ 30 → idempotency เช็ค toIsoDate(paid_at)='2026-06-29'
          //    ไม่ match targetPaidDate='2026-06-30' → รอบถัดไปลงซ้ำงวดถัดไป!
          //    UTC midnight → paid_at::date = วันจ่ายจริง ตรงกับ targetPaidDate (เหมือน manual sync เก่า)
          const paidAtTs = (targetPaidDate ?? syncIsoDate) + "T00:00:00.000Z";

          // ── ติ๊ก review (RED fix): p_receipt_uuids ต้องลงไปกับ RPC เดียวกันแบบ atomic ──────────
          //    เดิม INSERT pj_applied_receipts แยก tx ทีหลัง (best-effort) — ถ้า insert fail แต่ payment
          //    ผ่านแล้ว รอบถัดไปจะเห็นว่า "ยังไม่เคยลง" (ไม่เจอ uuid) แล้ว apply ซ้ำ = เงินเบิ้ลจริง
          //    ย้ายเข้า RPC (migration 0100) ให้ commit/rollback พร้อมกับ payment_log/installments เสมอ
          //    ส่งเฉพาะ path >= DEDUP_CUTOFF (usesUuidDedup) — path เดิมส่ง null (RPC ข้ามไม่แตะตารางนี้)
          const receiptUuidsPayload =
            usesUuidDedup && a.receipts.length > 0
              ? a.receipts.map((r) => ({
                  uuid: r.uuid,
                  invoice_no: a.invoice_no,
                  paid_date: targetPaidDate,
                  amount: r.amount,
                  payment_type: r.paymentType,
                  source: "auto",
                }))
              : null;

          const { error: rpcErr } = await db.rpc("record_payment_spread", {
            p_contract_id: contract.id,
            p_principal: instAmt,
            p_penalty: a.pen_amt,
            p_paid_at: paidAtTs,
            p_by_name: SYNC_BY_NAME,
            p_receipt_uuids: receiptUuidsPayload,
          });
          if (rpcErr) {
            // ลง RPC ไม่ผ่าน → flag review แทน crash (ไม่หยุดทั้งรอบ) — ไม่มีอะไรถูกลงเลย (atomic)
            queueReview(a, "AMOUNT_MISMATCH", contract.id, "installment", instAmt);
            continue;
          }
          // จด ledger (เฉพาะ path เดิม — path ใหม่จดในตัว RPC ไปแล้ว atomic) + ปิดเคสรอตรวจ (best-effort
          // — ไม่ crash ทั้งรอบ; ไม่กระทบเงิน แค่ housekeeping)
          try {
            if (!usesUuidDedup) {
              // path เดิม (< DEDUP_CUTOFF) — คงพฤติกรรมเดิมเป๊ะ (ยังเป็น best-effort แยก tx เหมือนก่อน
              // แก้รอบนี้ — ไม่ใช่บั๊กใหม่ ไม่อยู่ใน scope ของ fix นี้ ห้ามแก้)
              await db.from("pj_applied_ledger").upsert({
                contract_id: contract.id,
                pj_paid_date: targetPaidDate,
                inst_amount: instAmt,
                pen_amount: a.pen_amt,
                source: "auto",
                applied_at: new Date().toISOString(),
              }, { onConflict: "contract_id,pj_paid_date" });
            }
            // ⚠️ landmine 2 (0114, พี่ดิว) — ห้าม auto_resolved กลบแถว drift (RECEIPT_MISSING/
            // RECEIPT_CHANGED) ที่บังเอิญ invoice_no เดียวกัน: เงินเข้าใหม่ไม่ได้แปลว่าใบเสร็จผีที่เคยรายงาน
            // ไปแล้วหายไปไหน (คนละใบเสร็จ/uuid กันเลย) — exclude reason drift ออกจาก bulk update นี้เสมอ
            await db.from("pj_sync_review")
              .update({ status: "auto_resolved" })
              .eq("pj_invoice_no", a.invoice_no)
              .eq("status", "pending")
              .not("reason", "in", '("RECEIPT_MISSING","RECEIPT_CHANGED")');
          } catch { /* best-effort — ไม่บล็อกทั้งรอบ (housekeeping เท่านั้น ไม่ใช่เงิน) */ }
          autoApplied.push({ contract_no: contractNo, amount: instAmt + a.pen_amt });
          autoAppliedTotal += instAmt + a.pen_amt;
          continue;
        } else if (instAmt < remaining) {
          // จ่ายขาด ไม่ถึงงวด → ให้พนักงานยืนยัน
          queueReview(a, "PARTIAL", contract.id, "installment", instAmt);
          continue;
        } else {
          // remaining<=0 หรือเคสแปลก
          queueReview(a, "AMOUNT_MISMATCH", contract.id, "installment", instAmt);
          continue;
        }
      }

      // batch insert review (ไม่ dryRun)
      // ⚠️ dedup: รัน 96 รอบ/วัน — เคส MULTI/PARTIAL ที่ admin ยังไม่ resolve จะถูก flag ใหม่ทุกรอบ
      //    → ข้ามเคสที่มี pending review (pj_invoice_no เดียวกัน) อยู่แล้ว กัน review บวมวันละ ~288 แถวซ้ำ
      //    (ถ้า admin resolve/skip ไปแล้ว แล้วเคสโผล่อีก = flag ใหม่ได้ ถือว่าถูก)
      if (!dryRun && reviewRows.length > 0) {
        // ⚠️ landmine 1 (0114, พี่ดิว) — reviewRows (path เงินเข้านี้) ไม่มี reason drift อยู่แล้ว (drift
        // insert ผ่าน RPC reconcile_pj_receipts คนละ path) แต่ "seen" set ต้องไม่นับแถว drift ที่ pending
        // อยู่ก่อน ไม่งั้นถ้า invoice_no เดียวกันมีแถว RECEIPT_MISSING/RECEIPT_CHANGED ค้างอยู่ จะทำให้เคส
        // MULTI/PARTIAL/UNMATCHED/OTHER/AMOUNT_MISMATCH ใหม่ของ invoice นั้นถูกมองว่า "ซ้ำ" แล้วข้ามทิ้งไป
        // เงียบๆ (หายจริง ไม่ใช่แค่ drift หายอย่างเดียว) — exclude reason drift ออกจากการนับ seen เสมอ
        const { data: existing } = await db
          .from("pj_sync_review")
          .select("pj_invoice_no")
          .eq("status", "pending")
          .not("reason", "in", '("RECEIPT_MISSING","RECEIPT_CHANGED")');
        const seen = new Set((existing || []).map((r: any) => r.pj_invoice_no));
        const fresh = reviewRows.filter((r) => !seen.has(r.pj_invoice_no));
        if (fresh.length > 0) {
          const { error: revErr } = await db.from("pj_sync_review").insert(fresh);
          if (revErr) {
            return await failRun("error", `db error (review insert): ${revErr.message}`, 500);
          }
        }
      }

      // ── 5) จบรอบ ─────────────────────────────────────────────────────────────
      // ⚠️ ถ้า truncated=true (เกินงบเวลา) — status ยังคงเป็น "success" (ไม่ error) เพราะสิ่งที่ลงไป
      //    ก่อนหยุดถูก commit เรียบร้อยแล้วทั้งหมด (atomic ต่อก้อน) แค่ "ยังไม่ครบ" — รอบถัดไปจับต่อเอง
      if (!dryRun && runId) {
        await db
          .from("pj_sync_runs")
          .update({
            finished_at: new Date().toISOString(),
            status: "success",
            receipts_fetched: rows.length,
            auto_applied_count: autoApplied.length,
            auto_applied_amount: autoAppliedTotal,
            review_count: review.length,
            window_start_date: toIsoDate(startDate),
            window_end_date: toIsoDate(endDate),
            pages_fetched: pagesFetched,
            truncated,
          })
          .eq("id", runId);

        // ⚠️ ตัด run_daily_update ออก — มี daily cron (jobid 3, ตี 0:05) รันอยู่แล้ว
        //    pj-sync รันทุก 15 นาที (96 ครั้ง/วัน) → เรียกซ้ำเกินจำเป็น + รีเฟรชทั้ง DB นาน
        //    ทำ HTTP response ค้างจน gateway timeout (Internal Server Error ทั้งที่งานลง DB เสร็จแล้ว)
        //    record_payment_with_penalty อัปเดต installment เป็น paid + paid_at ทันทีอยู่แล้ว
        //    v_contract_status เป็น view คำนวณสด; penalty recalc ปล่อยให้ daily cron จัดการ
      }

      return json({
        ok: true,
        dryRun,
        date,
        start_date: startDate,
        end_date: endDate,
        days_back: daysBackUsed,
        pages_fetched: pagesFetched,
        receipts_fetched: rows.length,
        down_skipped: downSkipped,
        skipped_already_synced: skippedAlreadySynced,
        auto_applied: autoApplied,
        auto_applied_total: autoAppliedTotal,
        review,
        review_count: review.length,
        truncated,
        aggregated_invoice_days_total: aggEntriesTotal,
        aggregated_invoice_days_processed: aggEntriesProcessed,
      });
    } catch (e) {
      // ⚠️ กรอง message ไม่ให้มี credential หลุด (URLSearchParams อาจ leak ใน stack บางกรณี)
      const msg = e instanceof Error ? e.message : String(e);
      const safe = msg
        .replace(new RegExp(PJ_PASSWORD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "***")
        .replace(new RegExp(PJ_USERNAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "***");
      return await failRun("error", `exception: ${safe}`.slice(0, 500));
    }
  },
};
