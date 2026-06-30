// Edge Function: pj-sync — Wave 2 ตัวจริง (ดึงยอด PJ → ลงงวด EXACT อัตโนมัติ / ที่เหลือเข้ากล่องรอตรวจ)
//
// รันทุก 15 นาที (pg_cron — ครีมตั้งทีหลังหลัง Pete ดู dryRun). gate ด้วย header x-pj-sync-key (verify_jwt:false)
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
    const date: string =
      typeof body?.date === "string" && /^\d{2}-\d{2}-\d{4}$/.test(body.date)
        ? body.date
        : ddmmyyyyToday();
    const syncIsoDate = toIsoDate(date); // YYYY-MM-DD ของ date ที่ดึง (fallback window)

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
        .insert({ status: "running", lock_owner: lockOwner })
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

      // ── 3) ดึง receipts ของ date (length=500 ครบทุกแถว) ──────────────────────
      const xsrfRaw = jar.get("XSRF-TOKEN") ?? "";
      let xsrfToken = "";
      try { xsrfToken = decodeURIComponent(xsrfRaw); } catch { xsrfToken = xsrfRaw; }

      const dtBody = new URLSearchParams();
      dtBody.set("draw", "1");
      dtBody.set("start", "0");
      dtBody.set("length", "500");
      dtBody.set("_token", token);
      dtBody.set("start_date", date);
      dtBody.set("end_date", date);

      const r3 = await fetch(RECEIPTS_URL, {
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

      const ct = r3.headers.get("content-type") ?? "";
      const text3 = await r3.text();
      let parsed: any = null;
      if (ct.includes("application/json")) {
        try { parsed = JSON.parse(text3); } catch { /* not json */ }
      } else {
        const trimmed = text3.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          try { parsed = JSON.parse(trimmed); } catch { /* not json */ }
        }
      }
      if (!parsed || typeof parsed !== "object") {
        return await failRun("error", "receipts: response ไม่ใช่ JSON (session/CSRF อาจไม่ผ่าน)");
      }
      const rows: any[] = Array.isArray(parsed.data) ? parsed.data : [];

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
      };
      const aggMap = new Map<string, Agg>();
      let downSkipped = 0;

      for (const row of rows) {
        const invRaw = pick(row, ["invoice_no", "inv_no", "invoiceNo", "contract_no"]);
        const typeRaw = String(pick(row, ["payment_type", "type"]) ?? "").toLowerCase();
        const amt = parseAmount(pick(row, ["amount", "paid_amount", "total"]));
        const paidDate = toIsoDate(pick(row, ["paid_date", "payment_date", "date", "created_at"]));

        if (!invRaw) continue;
        const inv = String(invRaw).trim();

        if (typeRaw.includes("down")) {
          downSkipped++;
          continue; // down_payment = สัญญาใหม่ ข้าม
        }

        let a = aggMap.get(inv);
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
          };
          aggMap.set(inv, a);
        }
        a.raw.push(row);
        if (paidDate && !a.paid_date) a.paid_date = paidDate;

        if (typeRaw.includes("penalty")) {
          a.pen_amt += amt;
        } else if (typeRaw.includes("installment")) {
          a.inst_amt += amt;
          a.has_installment = true;
          a.installment_receipt_count++;
        } else {
          // other (หรือ type แปลก) → flag OTHER
          a.other_amt += amt;
          a.has_other = true;
        }
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

      for (const a of aggMap.values()) {
        // เคสไม่มี installment เลย — penalty-only หรือ other-only → review
        if (!a.has_installment) {
          if (a.has_other) {
            queueReview(a, "OTHER", null, "other", a.other_amt);
          } else if (a.pen_amt > 0) {
            // ค่าปรับล้วน ไม่มีงวด → ให้คนตัดสิน
            queueReview(a, "AMOUNT_MISMATCH", null, "penalty", a.pen_amt);
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
        // (1) เช็ค paid_at เดิม: มีงวดที่ paid_at::date == วันจ่ายของใบเสร็จ → ลงไปแล้ว/import แล้ว
        // (2) เช็ค ledger: pj_applied_ledger มีแถวของ (contract_id, pj_paid_date) นี้แล้ว
        //     ครอบเคสจ่ายขาด (PARTIAL) ที่พนักงานกดยืนยันแล้ว → paid_at ยังเป็น null แต่ ledger จดไว้แล้ว
        const targetPaidDate = a.paid_date ?? syncIsoDate;
        const alreadySynced = allInsts.some((it) => {
          if (!it.paid_at) return false;
          const d = toIsoDate(it.paid_at);
          return d != null && targetPaidDate != null && d === targetPaidDate;
        });

        // ตรวจ ledger (เฉพาะเมื่อ targetPaidDate ไม่เป็น null)
        let ledgerAlreadyApplied = false;
        if (targetPaidDate) {
          const { data: ledgerRow } = await db
            .from("pj_applied_ledger")
            .select("inst_amount, pen_amount")
            .eq("contract_id", contract.id)
            .eq("pj_paid_date", targetPaidDate)
            .maybeSingle();
          if (ledgerRow) ledgerAlreadyApplied = true;
        }

        if (alreadySynced || ledgerAlreadyApplied) {
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
          const { error: rpcErr } = await db.rpc("record_payment_spread", {
            p_contract_id: contract.id,
            p_principal: instAmt,
            p_penalty: a.pen_amt,
            p_paid_at: paidAtTs,
            p_by_name: SYNC_BY_NAME,
          });
          if (rpcErr) {
            // ลง RPC ไม่ผ่าน → flag review แทน crash (ไม่หยุดทั้งรอบ)
            queueReview(a, "AMOUNT_MISMATCH", contract.id, "installment", instAmt);
            continue;
          }
          // จด ledger กันลงซ้ำรอบถัดไป + ปิดเคสรอตรวจ (best-effort — ไม่ crash ทั้งรอบ)
          try {
            await db.from("pj_applied_ledger").upsert({
              contract_id: contract.id,
              pj_paid_date: targetPaidDate,
              inst_amount: instAmt,
              pen_amount: a.pen_amt,
              source: "auto",
              applied_at: new Date().toISOString(),
            }, { onConflict: "contract_id,pj_paid_date" });
            await db.from("pj_sync_review")
              .update({ status: "auto_resolved" })
              .eq("pj_invoice_no", a.invoice_no)
              .eq("status", "pending");
          } catch { /* best-effort — ไม่บล็อกทั้งรอบ */ }
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
        const { data: existing } = await db
          .from("pj_sync_review")
          .select("pj_invoice_no")
          .eq("status", "pending");
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
        receipts_fetched: rows.length,
        down_skipped: downSkipped,
        skipped_already_synced: skippedAlreadySynced,
        auto_applied: autoApplied,
        auto_applied_total: autoAppliedTotal,
        review,
        review_count: review.length,
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
