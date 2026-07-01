// Edge Function: pj-phone-backfill — backfill เบอร์สำรองลูกค้าจาก PJ → contracts (phone_alt1/phone_alt2)
// เติมเฉพาะช่องที่ว่าง ไม่ทับของเดิม — ทำงานฝั่งเซิร์ฟเวอร์ทั้งหมด
//
// gate: header x-pj-sync-key == PJ_SYNC_KEY (เหมือน pj-sync)
// body: { limit?: number (default 80) }
// response: { ok, processed, filled, notFound, errors, checked }
// ใช้ pj_phone_checked (boolean) แทน keyset cursor — ประมวลผลแล้ว mark true → ไม่ต้องพึ่ง cursor/response
//
// ⚠️ ห้าม log/return ค่า PJ_USERNAME / PJ_PASSWORD / cookie / token / PJ_SYNC_KEY / เบอร์โทร เด็ดขาด
//    cookie jar / csrf ห้ามหลุดออก response JSON
//
// login helper + cookie jar reuse จาก pj-sync (ก๊อปตรงๆ — พิสูจน์ผ่านแล้ว):
//   mergeSetCookies / cookieHeader / extractToken / 3-step login

// @ts-nocheck
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.46.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-pj-sync-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const PJ_BASE = "https://pj-soft.net";
const LOGIN_URL = `${PJ_BASE}/manager/login`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── cookie jar helpers (ก๊อปจาก pj-sync ตรงตัว — พิสูจน์ผ่านแล้ว) ────────────

function mergeSetCookies(jar: Map<string, string>, res: Response) {
  let setCookies: string[] = [];
  try {
    setCookies = (res.headers as any).getSetCookie?.() ?? [];
  } catch {
    /* ignore */
  }
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

// ── delay helper (กัน PJ rate-limit) ────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── parse เบอร์จาก HTML strip + regex ──────────────────────────────────────
// คืน string[] ของเบอร์ 10 หลักขึ้นต้น 0 เท่านั้น (ทิ้งเบอร์เพี้ยน/9 หลัก)
function parseAltPhones(html: string): string[] {
  const stripped = html.replace(/<[^>]+>/g, " ");
  const m = stripped.match(/โทรศัพท์สำรอง[\s:]*([0-9\/\-]{8,40})/);
  if (!m || !m[1]) return [];
  const raw = m[1];
  const tokens = raw
    .split(/[^0-9]+/)
    .filter(Boolean)
    .filter((t) => /^0\d{9}$/.test(t));
  return [...new Set(tokens)];
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

    // ── 0) Auth gate (x-pj-sync-key) ────────────────────────────────────────
    const PJ_SYNC_KEY = Deno.env.get("PJ_SYNC_KEY") ?? "";
    if (!PJ_SYNC_KEY) {
      return json({ ok: false, error: "PJ_SYNC_KEY not configured" }, 500);
    }
    const callerKey = req.headers.get("x-pj-sync-key") ?? "";
    if (callerKey !== PJ_SYNC_KEY) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    // ── body params ──────────────────────────────────────────────────────────
    let body: any = {};
    try {
      const txt = await req.text();
      body = txt ? JSON.parse(txt) : {};
    } catch {
      /* default {} */
    }
    const limit: number =
      typeof body?.limit === "number" && body.limit > 0 && body.limit <= 200
        ? Math.floor(body.limit)
        : 80;

    // ── PJ credentials ───────────────────────────────────────────────────────
    const PJ_USERNAME = Deno.env.get("PJ_USERNAME") ?? "";
    const PJ_PASSWORD = Deno.env.get("PJ_PASSWORD") ?? "";
    if (!PJ_USERNAME || !PJ_PASSWORD) {
      return json({ ok: false, error: "PJ credentials not configured" }, 500);
    }

    // ── service role client (service_role → bypass RLS via mig 0017) ─────────
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false },
    });

    const jar = new Map<string, string>();

    // ─────────────────────────────────────────────────────────────────────────
    // ── 1) Login PJ (3-step — ก๊อปจาก pj-sync ตรงๆ) ────────────────────────
    // ─────────────────────────────────────────────────────────────────────────
    let csrf: string;
    try {
      // step 1: GET /manager/login → token + cookie
      const r1 = await fetch(LOGIN_URL, {
        method: "GET",
        headers: { "User-Agent": UA, Accept: "text/html" },
        redirect: "manual",
      });
      mergeSetCookies(jar, r1);
      const html1 = await r1.text();
      const token = extractToken(html1);
      if (!token || jar.size === 0) {
        return json({ ok: false, error: "login: ไม่ได้ token/cookie จากหน้า login" });
      }

      // step 2: POST /manager/login → session cookie (302 redirect)
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
        return json({ ok: false, error: "login: ไม่สำเร็จ (รหัส/validation ไม่ผ่าน)" });
      }

      // step 3: GET /manager/invoices/all → csrf token สด (สำหรับ DataTable AJAX)
      const r3 = await fetch(`${PJ_BASE}/manager/invoices/all`, {
        method: "GET",
        headers: {
          "User-Agent": UA,
          Accept: "text/html",
          Cookie: cookieHeader(jar),
          Referer: `${PJ_BASE}/manager/home`,
        },
        redirect: "manual",
      });
      mergeSetCookies(jar, r3);
      const html3 = await r3.text();
      const freshToken = extractToken(html3);
      if (!freshToken) {
        return json({ ok: false, error: "csrf: ไม่ได้ token จากหน้า invoices/all" });
      }
      csrf = freshToken;
    } catch (e) {
      // กรอง credential ไม่ให้หลุดใน error
      const msg = e instanceof Error ? e.message : String(e);
      const safe = msg
        .replace(new RegExp(PJ_PASSWORD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "***")
        .replace(new RegExp(PJ_USERNAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "***");
      return json({ ok: false, error: `login exception: ${safe}`.slice(0, 300) });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ── 2) Query candidates จาก DB ──────────────────────────────────────────
    // contracts ที่ active + มี inv_no + (phone_alt1 ว่าง OR phone_alt2 ว่าง)
    // + ยังไม่เคย mark pj_phone_checked=true (null = ยังไม่เช็ค)
    // ─────────────────────────────────────────────────────────────────────────
    const { data: candidates, error: qErr } = await db
      .from("contracts")
      .select("id, inv_no, phone, phone_alt1, phone_alt2")
      .eq("status", "active")
      .neq("inv_no", "")
      .not("inv_no", "is", null)
      .or("phone_alt1.is.null,phone_alt1.eq.,phone_alt2.is.null,phone_alt2.eq.")
      .is("pj_phone_checked", null)
      .order("id", { ascending: true })
      .limit(limit);

    if (qErr) {
      return json({ ok: false, error: `db query failed: ${qErr.message}` });
    }
    const rows = candidates ?? [];

    // ─────────────────────────────────────────────────────────────────────────
    // ── 3) Loop แต่ละ candidate ─────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────────────────────
    let processed = 0;
    let filled = 0;
    let notFound = 0;
    let errors = 0;
    let checked = 0; // นับ row ที่ mark pj_phone_checked=true สำเร็จ
    let consecutiveCsrfFail = 0; // นับครั้งที่ AJAX ไม่คืน JSON (อาจ CSRF stale)

    for (const row of rows) {
      processed++;

      // delay ~120ms กัน PJ rate-limit
      if (processed > 1) await sleep(120);

      const inv = String(row.inv_no ?? "").trim();
      if (!inv) continue;

      // ── 3a) ค้นหา uuid จาก DataTable invoices/all ───────────────────────
      //       POST /manager/ajax/invoices/all พร้อม search[value]=inv_no
      let uuid: string | null = null;
      try {
        // ถ้า csrf อาจ stale (หลายครั้งติด) → refresh ก่อน
        if (consecutiveCsrfFail >= 3) {
          const rRefresh = await fetch(`${PJ_BASE}/manager/invoices/all`, {
            method: "GET",
            headers: {
              "User-Agent": UA,
              Accept: "text/html",
              Cookie: cookieHeader(jar),
              Referer: `${PJ_BASE}/manager/home`,
            },
            redirect: "manual",
          });
          mergeSetCookies(jar, rRefresh);
          const htmlR = await rRefresh.text();
          const refreshed = extractToken(htmlR);
          if (refreshed) {
            csrf = refreshed;
            consecutiveCsrfFail = 0;
          }
        }

        const dtBody = new URLSearchParams();
        dtBody.set("_token", csrf);
        dtBody.set("draw", "1");
        dtBody.set("start", "0");
        dtBody.set("length", "3");
        dtBody.set("search[value]", inv);
        dtBody.set("search[regex]", "false");

        const rAjax = await fetch(`${PJ_BASE}/manager/ajax/invoices/all`, {
          method: "POST",
          headers: {
            "User-Agent": UA,
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: cookieHeader(jar),
            Referer: `${PJ_BASE}/manager/invoices/all`,
            Origin: PJ_BASE,
            Accept: "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRF-TOKEN": csrf,
          },
          body: dtBody.toString(),
          redirect: "manual",
        });

        const ct = rAjax.headers.get("content-type") ?? "";
        const text = await rAjax.text();
        let parsed: any = null;

        if (ct.includes("application/json")) {
          try {
            parsed = JSON.parse(text);
          } catch {
            /* not json */
          }
        } else {
          const trimmed = text.trim();
          if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
              parsed = JSON.parse(trimmed);
            } catch {
              /* not json */
            }
          }
        }

        if (!parsed || !Array.isArray(parsed.data)) {
          // ไม่ใช่ JSON — อาจ CSRF stale หรือ session หมด → error, ห้าม mark checked
          consecutiveCsrfFail++;
          errors++;
          continue;
        }
        consecutiveCsrfFail = 0;

        if (parsed.data.length === 0) {
          // PJ ไม่เจอ invoice นี้ → จบสมบูรณ์ mark checked
          notFound++;
          await db.from("contracts").update({ pj_phone_checked: true }).eq("id", row.id);
          checked++;
          continue;
        }
        uuid = parsed.data[0]?.uuid ?? null;
        if (!uuid) {
          // data มีแต่ไม่มี uuid → จบสมบูรณ์ mark checked
          notFound++;
          await db.from("contracts").update({ pj_phone_checked: true }).eq("id", row.id);
          checked++;
          continue;
        }
      } catch {
        // network/parse error ใน 3a → ห้าม mark checked
        errors++;
        continue;
      }

      // ── 3b) GET /manager/invoices/{uuid} → HTML รายละเอียดสัญญา ───────────
      let invoiceHtml: string;
      try {
        const rDetail = await fetch(`${PJ_BASE}/manager/invoices/${uuid}`, {
          method: "GET",
          headers: {
            "User-Agent": UA,
            Accept: "text/html",
            Cookie: cookieHeader(jar),
            Referer: `${PJ_BASE}/manager/invoices/all`,
          },
          redirect: "manual",
        });
        mergeSetCookies(jar, rDetail);
        invoiceHtml = await rDetail.text();
      } catch {
        // network error ดึง detail → ห้าม mark checked
        errors++;
        continue;
      }

      // ── 3c-d) strip tags + regex + validate เบอร์ 10 หลักขึ้นต้น 0 ────────
      const valid = parseAltPhones(invoiceHtml);

      // ── 3e) กรองเบอร์ซ้ำกับที่มีอยู่แล้ว ──────────────────────────────────
      const existing = [row.phone, row.phone_alt1, row.phone_alt2].filter(Boolean) as string[];
      const fresh = valid.filter((n) => !existing.includes(n));

      // ── 3f) เติมช่องว่าง ─────────────────────────────────────────────────
      // na1/na2 = ค่าปัจจุบัน (null ถ้าว่าง) — เติมจาก fresh ทีละช่อง
      let na1: string | null = row.phone_alt1 && row.phone_alt1 !== "" ? row.phone_alt1 : null;
      let na2: string | null = row.phone_alt2 && row.phone_alt2 !== "" ? row.phone_alt2 : null;

      const freshQueue = [...fresh]; // copy เพื่อ shift
      if (na1 === null && freshQueue.length > 0) na1 = freshQueue.shift()!;
      if (na2 === null && freshQueue.length > 0) na2 = freshQueue.shift()!;

      // ── 3g) UPDATE เฉพาะถ้ามีการเปลี่ยนแปลง ──────────────────────────────
      const na1Changed = na1 !== null && na1 !== (row.phone_alt1 ?? null);
      const na2Changed = na2 !== null && na2 !== (row.phone_alt2 ?? null);

      if (na1Changed || na2Changed) {
        // UPDATE เฉพาะช่องที่เปลี่ยน — ช่องไหนไม่เปลี่ยนให้ส่ง undefined (supabase-js จะ skip ให้)
        // fill-empty guard ฝั่ง WHERE: .or(...) กัน race condition ถ้าคนกรอกมาก่อน UPDATE ถึง
        // (na1/na2 ถูก assign ก็ต่อเมื่อ row.phone_alt1/phone_alt2 ว่างอยู่แล้ว → ปลอดภัยในทุกกรณีปกติ)
        // mark pj_phone_checked เป็น update แยก (ไม่มี guard .or) เพื่อไม่ให้ guard บล็อก
        let phoneUpdateOk = false;
        try {
          const updatePayload: Record<string, string | null> = {};
          if (na1Changed) updatePayload.phone_alt1 = na1;
          if (na2Changed) updatePayload.phone_alt2 = na2;

          const guardClauses: string[] = [];
          if (na1Changed) guardClauses.push("phone_alt1.is.null", "phone_alt1.eq.");
          if (na2Changed) guardClauses.push("phone_alt2.is.null", "phone_alt2.eq.");

          const { error: upErr } = await db
            .from("contracts")
            .update(updatePayload)
            .eq("id", row.id)
            .or(guardClauses.join(","));

          if (upErr) {
            errors++;
          } else {
            filled++;
            phoneUpdateOk = true;
          }
        } catch {
          errors++;
        }
        // mark checked แยก — ทำเสมอถ้า phone update ไม่ error (ถือว่าจบสมบูรณ์)
        if (phoneUpdateOk) {
          await db.from("contracts").update({ pj_phone_checked: true }).eq("id", row.id);
          checked++;
        }
      } else {
        // ไม่มีเบอร์ใหม่ให้เติม (PJ ไม่มีเบอร์ใหม่ หรือซ้ำทั้งหมด) → จบสมบูรณ์ mark checked
        await db.from("contracts").update({ pj_phone_checked: true }).eq("id", row.id);
        checked++;
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ── 4) Response — ไม่ return เบอร์โทรเลย (privacy) ─────────────────────
    // ─────────────────────────────────────────────────────────────────────────
    return json({
      ok: true,
      processed,
      filled,
      notFound,
      errors,
      checked,
    });
  },
};
