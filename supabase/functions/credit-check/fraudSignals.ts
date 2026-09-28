// ===== สัญญาณเตือนทุจริตชั้นที่ 1 (addendum, ครีม 2026-09-28) — network+DB layer (impure) =====
// อ้างอิง ADDENDUM ท้าย pj-blacklist-contract.md — best-effort เสมอ (ห้าม throw ทะลุไปบล็อก submit)
// แต่ละสัญญาณ wrap เดี่ยว (Promise.allSettled) กันตัวหนึ่งพังแล้วลากตัวอื่นตายไปด้วย
//
// ⚠️ known limitation (บันทึกไว้ตรงๆ ให้ติ๊ก/คุณเตยรีวิว — ไม่ได้ซ่อน):
//   - NAME_CHANGED/FB_SHARED เทียบกับ contracts.national_id/facebook_link แบบ exact string match เท่านั้น
//     (ตาราง contracts ไม่มีคอลัมน์ digits-only แบบ credit_checks.national_id_digits — ถ้าร้านพิมพ์เลขบัตร
//     มีขีด/เว้นวรรคตอนทำสัญญาไว้ก่อนหน้า จะจับคู่ไม่เจอ) แก้ได้ในอนาคตด้วยการเพิ่ม generated column
//     คล้าย 0164 ให้ contracts เช่นกัน — นอกขอบเขตงานนี้
//   - FB_SHARED ดึงแบบ bounded (limit 500 ต่อตาราง) มา normalize+เทียบฝั่ง JS แทนการ query ด้วย
//     lower(facebook_url) ตรงๆ ผ่าน index ที่ 0167 เพิ่มไว้ (ดูเหตุผลเต็มในคอมเมนต์ migration 0167
//     SECTION 3) — พอสำหรับ pilot scale ตอนนี้ ต้อง revisit ถ้าแถวโตเกินหลักพัน
//   - PDF_EDITED/PDF_UNREADABLE เป็น heuristic scan ข้อความดิบของไฟล์ PDF (ไม่ใช่ PDF parser จริง) —
//     PDF สมัยใหม่จำนวนมากใช้ compressed object streams ทำให้ Producer/Creator scan ไม่เจอในหัว/ท้ายไฟล์ที่
//     สแกนได้โดยไม่ได้ถูกแก้ไขอะไรเลย (false negative) — เคส "หาไม่เจอในข้อความที่สแกนได้เฉยๆ" ไม่ flag
//     PDF_UNREADABLE (จะ noisy เกินไปจน staff เมินคำเตือนทั้งหมด) เจาะจง flag PDF_UNREADABLE เฉพาะ 3 เคส
//     ที่ชัดเจนว่า "สแกนไม่ได้จริงๆ": มี /Encrypt dictionary, เซิร์ฟเวอร์ไม่ตอบ Range (206) ตามที่ขอ,
//     หรือไฟล์ใหญ่เกิน 15 MB (รีวิวติ๊ก [RED] — ดู checkPdfFiles/fetchStrictPartial: สแกนแค่หัว+ท้ายไฟล์
//     อย่างละ 64 KB ผ่าน Range request เท่านั้น ไม่เคย buffer ทั้งไฟล์เข้าหน่วยความจำไม่ว่ากรณีใด)

// @ts-nocheck
import type { AwsClient } from "npm:aws4fetch@1";

export interface FraudFlag {
  code: "NAME_CHANGED" | "DUP_FILE" | "FB_SHARED" | "PDF_EDITED" | "PDF_UNREADABLE";
  severity: "warn" | "high";
  detailStaff: string; // ไทย สั้น เฉพาะ staff เห็น — ร้านห้ามเห็นเด็ดขาด
}

/** ตัดคำนำหน้าไทย/อังกฤษ + ช่องว่าง + ตัวพิมพ์ใหญ่เล็ก ก่อนเทียบชื่อ */
function normalizeName(name: string): string {
  // ⚠️ ลำดับ alternation สำคัญมาก — JS regex ลองซ้ายไปขวาแล้วหยุดที่ตัวแรกที่แมตช์ (ไม่ใช่ตัวที่ยาวสุด)
  // เดิมเขียน (นาย|นาง|นางสาว|...) ทำให้ "นางสาว" ไม่มีทางถูกแมตช์เต็มคำเลย เพราะ "นาง" (3 ตัวอักษรแรก
  // ของ "นางสาว" พอดี) แมตช์สำเร็จก่อนเสมอ เหลือ "สาว" ติดหน้าชื่อไป (เช่น "นางสาวทดสอบ" ถูกตัดผิดเป็น
  // "สาวทดสอบ" ไม่ใช่ "ทดสอบ") ทำให้ชื่อเดียวกันที่บางที่กรอกมี "นางสาว" บางที่กรอกไม่มีคำนำหน้าเลย
  // จะ normalize ไม่ตรงกัน → true positive NAME_CHANGED กลายเป็น false positive ได้ — แก้โดยเรียงคำนำหน้า
  // ที่ยาวกว่า/เจาะจงกว่าไว้ก่อนเสมอ (นางสาว ก่อน นาง, Mrs ก่อน Mr เผื่อวันหลังเพิ่ม Mr โดยไม่ทันคิด)
  return (name ?? "")
    .replace(/^(นางสาว|นาง|นาย|น\.ส\.|Mrs\.?|Mr\.?|Ms\.?)\s*/i, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** ตัด protocol/www/trailing slash/query string — เทียบแค่ "ตัวตน" ของลิงก์ ไม่สนรูปแบบที่พิมพ์ */
function normalizeFacebookUrl(url: string): string {
  let u = (url ?? "").trim().toLowerCase();
  if (!u) return "";
  u = u.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  u = u.split("?")[0];
  return u;
}

async function checkNameChanged(
  adminClient: any,
  nationalIdDigits: string,
  currentName: string,
): Promise<FraudFlag | null> {
  const normalizedCurrent = normalizeName(currentName);
  const prevEntries: string[] = [];

  const { data: prevChecks } = await adminClient
    .from("credit_checks")
    .select("customer_name, created_at")
    .eq("national_id_digits", nationalIdDigits)
    .order("created_at", { ascending: false })
    .limit(5);
  for (const row of prevChecks ?? []) {
    if (normalizeName(row.customer_name) !== normalizedCurrent) {
      prevEntries.push(`"${row.customer_name}" (${String(row.created_at).slice(0, 10)}, เคยเช็คเครดิต)`);
    }
  }

  // best-effort เท่านั้น (ดู known limitation หัวไฟล์) — exact match กับ national_id ดิบที่เก็บใน contracts
  const { data: prevContracts } = await adminClient
    .from("contracts")
    .select("customer_name, transaction_date")
    .eq("national_id", nationalIdDigits)
    .order("transaction_date", { ascending: false })
    .limit(5);
  for (const row of prevContracts ?? []) {
    if (normalizeName(row.customer_name) !== normalizedCurrent) {
      prevEntries.push(`"${row.customer_name}" (${String(row.transaction_date).slice(0, 10)}, เคยทำสัญญา)`);
    }
  }

  if (prevEntries.length === 0) return null;
  return {
    code: "NAME_CHANGED",
    severity: "warn",
    detailStaff: `พบชื่อเดิมที่ต่างจากที่กรอกวันนี้: ${prevEntries.slice(0, 3).join("; ")}`,
  };
}

/** ETag เดี่ยว (PUT ธรรมดา ไม่ใช่ multipart) = MD5 hex ของเนื้อไฟล์ตรงๆ — ตัวตนที่เชื่อถือได้เพราะ R2 คำนวณ
 *  เอง (ไม่ใช่ค่าที่ client อ้าง) ETag แบบ multipart จะมี suffix "-<partcount>" (ไม่ใช่ MD5 ของเนื้อไฟล์
 *  ล้วนๆ อีกต่อไป) — เจอ suffix แบบนี้หรือไม่มี etag เลย ให้ถือว่า "เชื่อไม่ได้" แล้ว fallback ไป sha256 แทน
 *  (รีวิวติ๊ก [YELLOW] #2) */
function isReliableEtag(etag: string | null | undefined): etag is string {
  return !!etag && !/-\d+$/.test(etag);
}

async function checkDupFile(
  adminClient: any,
  nationalIdDigits: string,
  files: { sha256?: string | null; r2_etag?: string | null }[],
): Promise<FraudFlag | null> {
  const etagKeys = Array.from(new Set(files.map((f) => f.r2_etag).filter(isReliableEtag)));
  // sha256 fallback เฉพาะไฟล์ที่ etag ใช้ไม่ได้เท่านั้น (ไม่ผสมกันทุกไฟล์ — เชื่อ etag ก่อนเสมอถ้ามี)
  const shaKeys = Array.from(
    new Set(
      files
        .filter((f) => !isReliableEtag(f.r2_etag))
        .map((f) => f.sha256)
        .filter((h): h is string => !!h),
    ),
  );
  if (etagKeys.length === 0 && shaKeys.length === 0) return null;

  const others: any[] = [];
  if (etagKeys.length > 0) {
    const { data: etagMatches } = await adminClient
      .from("credit_check_files")
      .select("r2_etag, credit_checks!inner(national_id_digits, created_at)")
      .in("r2_etag", etagKeys);
    others.push(...(etagMatches ?? []));
  }
  if (shaKeys.length > 0) {
    const { data: shaMatches } = await adminClient
      .from("credit_check_files")
      .select("sha256, credit_checks!inner(national_id_digits, created_at)")
      .in("sha256", shaKeys);
    others.push(...(shaMatches ?? []));
  }

  const filtered = others.filter(
    (m: any) => m.credit_checks?.national_id_digits && m.credit_checks.national_id_digits !== nationalIdDigits,
  );
  if (filtered.length === 0) return null;

  const first = filtered[0] as any;
  return {
    code: "DUP_FILE",
    severity: "high",
    detailStaff: `ไฟล์แนบซ้ำกับคำขออื่น (เลขบัตรคนละคน) เมื่อ ${String(first.credit_checks?.created_at ?? "").slice(0, 10)}`,
  };
}

async function checkFbShared(
  adminClient: any,
  nationalIdDigits: string,
  facebookUrl: string,
): Promise<FraudFlag | null> {
  const normalized = normalizeFacebookUrl(facebookUrl);
  if (!normalized) return null;

  const matches: string[] = [];

  const { data: prevChecks } = await adminClient
    .from("credit_checks")
    .select("facebook_url, customer_name, created_at, national_id_digits")
    .not("facebook_url", "is", null)
    .neq("national_id_digits", nationalIdDigits)
    .order("created_at", { ascending: false })
    .limit(500);
  for (const row of prevChecks ?? []) {
    if (normalizeFacebookUrl(row.facebook_url ?? "") === normalized) {
      matches.push(`"${row.customer_name}" (${String(row.created_at).slice(0, 10)}, เคยเช็คเครดิต)`);
    }
  }

  const { data: prevContracts } = await adminClient
    .from("contracts")
    .select("facebook_link, customer_name, transaction_date, national_id")
    .not("facebook_link", "is", null)
    .order("transaction_date", { ascending: false })
    .limit(500);
  for (const row of prevContracts ?? []) {
    const rowDigits = String(row.national_id ?? "").replace(/\D/g, "");
    if (rowDigits === nationalIdDigits) continue;
    if (normalizeFacebookUrl(row.facebook_link ?? "") === normalized) {
      matches.push(`"${row.customer_name}" (${String(row.transaction_date).slice(0, 10)}, เคยทำสัญญา)`);
    }
  }

  if (matches.length === 0) return null;
  return {
    code: "FB_SHARED",
    severity: "warn",
    detailStaff: `Facebook เดียวกันเคยใช้กับ: ${matches.slice(0, 3).join("; ")}`,
  };
}

// ── PDF heuristic scan ──────────────────────────────────────────────────────────────────────
const PDF_EDITOR_MARKERS = [
  "photoshop", "illustrator", "microsoft word", "word", "excel", "canva", "ilovepdf", "smallpdf",
  "sejda", "pdfescape", "foxit phantompdf", "foxit editor", "nitro", "wps", "libreoffice",
  "microsoft print to pdf", "chrome", "skia", "pdf-xchange editor",
] as const;

function extractPdfInfoField(text: string, field: string): string {
  const m = text.match(new RegExp(`/${field}\\s*\\(([^)]*)\\)`));
  return m ? m[1] : "";
}

function parsePdfDate(raw: string): number | null {
  // รูปแบบ D:YYYYMMDDHHmmSS(+/-HH'mm' หรือ Z) — เอา 14 หลักแรกพอสำหรับเทียบหยาบๆ (ไม่ปรับ timezone)
  const m = raw.match(/D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

function scanPdfText(text: string): { edited: boolean; unreadable: boolean; detail: string } {
  if (/\/Encrypt\b/.test(text)) {
    return { edited: false, unreadable: true, detail: "ไฟล์ PDF เข้ารหัส อ่าน metadata ไม่ได้" };
  }

  const producer = extractPdfInfoField(text, "Producer");
  const creator = extractPdfInfoField(text, "Creator");
  const combined = `${producer} ${creator}`.toLowerCase();
  const matchedEditor = PDF_EDITOR_MARKERS.find((m) => combined.includes(m));

  const creationMs = parsePdfDate(extractPdfInfoField(text, "CreationDate"));
  const modMs = parsePdfDate(extractPdfInfoField(text, "ModDate"));
  const dateDiffFlag = creationMs !== null && modMs !== null && Math.abs(modMs - creationMs) > 60_000;

  if (matchedEditor || dateDiffFlag) {
    const parts: string[] = [];
    if (matchedEditor) parts.push(`Producer/Creator ตรงกับโปรแกรมแก้ไข: "${producer || creator}"`);
    if (dateDiffFlag) parts.push("วันที่แก้ไข (ModDate) ต่างจากวันที่สร้าง (CreationDate) เกิน 1 นาที");
    return { edited: true, unreadable: false, detail: parts.join(" | ") };
  }
  return { edited: false, unreadable: false, detail: "" };
}

// (รีวิวติ๊ก [RED] #1) ห้าม buffer ไฟล์ PDF แบบไม่จำกัดขนาดเด็ดขาด — เพดาน 15 MB (เกินนี้ข้ามสแกนเลย ไม่โหลด
// เข้าหน่วยความจำ Edge Function) และสแกนแค่หัว+ท้ายไฟล์อย่างละ 64 KB ผ่าน Range request (R2 รองรับ
// `Range: bytes=`) เพราะ Info dictionary/trailer/xref ของ PDF ปกติอยู่ใกล้ต้น/ท้ายไฟล์ ไม่ใช่กลางไฟล์
// ขนาดใหญ่ (ยังเป็น heuristic เหมือนเดิม ไม่ใช่ PDF parser จริง — ดู known limitation หัวไฟล์)
const MAX_PDF_SCAN_BYTES = 15 * 1024 * 1024;
const PDF_SCAN_WINDOW_BYTES = 64 * 1024;

/** ขอ byte-range แบบเข้มงวด — ยอมรับเฉพาะ 206 Partial Content เท่านั้นถึงจะอ่าน body (≤ ช่วงที่ขอ) ถ้า
 *  เซิร์ฟเวอร์ไม่เคารพ Range (ตอบ 200 พร้อมไฟล์เต็ม) ยกเลิกทันทีไม่อ่าน body เด็ดขาด — กัน unbounded read
 *  ถ้าไฟล์ใหญ่ผิดปกติ (ปลอดภัยไว้ก่อน: ข้ามสแกนไฟล์นั้นไปเลยดีกว่าเสี่ยงโหลดไฟล์เป็นร้อย MB เข้าหน่วยความจำ) */
async function fetchStrictPartial(
  url: string,
  start: number,
  end: number,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; totalSize: number | null } | null> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
  if (res.status !== 206) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return null;
  }
  const contentRange = res.headers.get("content-range"); // รูปแบบ "bytes 0-65535/1234567"
  const m = contentRange?.match(/\/(\d+)$/);
  const totalSize = m ? Number(m[1]) : null;
  const bytes = new Uint8Array(await res.arrayBuffer()); // ปลอดภัย: 206 การันตีว่า body คือช่วงที่ขอเท่านั้น
  return { bytes, totalSize };
}

async function checkPdfFiles(
  files: { kind: string; mime: string; r2_key: string }[],
  r2: { endpoint: string; bucket: string } | null,
  aws: AwsClient | null,
  presignGet: (aws: AwsClient, endpoint: string, bucket: string, key: string) => Promise<string>,
  signal: AbortSignal,
): Promise<FraudFlag[]> {
  if (!r2 || !aws) return [];
  const targets = files.filter((f) => (f.kind === "statement" || f.kind === "payslip") && f.mime === "application/pdf");
  if (targets.length === 0) return [];

  const editedDetails: string[] = [];
  let unreadableDetail = "";

  for (const f of targets) {
    try {
      const url = await presignGet(aws, r2.endpoint, r2.bucket, f.r2_key);

      // ขอ chunk แรก (หัวไฟล์) ก่อนเสมอ — response 206 แถม Content-Range มาด้วยซึ่งบอกขนาดไฟล์จริงทั้งก้อน
      // โดยไม่ต้องขอ HEAD แยก (presigned URL ผูก method ไว้กับ GET ตั้งแต่ตอน sign แล้ว)
      const head = await fetchStrictPartial(url, 0, PDF_SCAN_WINDOW_BYTES - 1, signal);
      if (!head || head.totalSize === null) {
        unreadableDetail = "อ่านไฟล์ไม่ได้ (เซิร์ฟเวอร์ไม่รองรับ/ไม่ตอบ Range) ข้ามการสแกน";
        continue;
      }
      if (head.totalSize > MAX_PDF_SCAN_BYTES) {
        unreadableDetail = `ไฟล์ใหญ่เกิน 15 MB (${Math.round(head.totalSize / (1024 * 1024))} MB) ข้ามการสแกน`;
        continue;
      }

      let tailBytes = new Uint8Array(0);
      if (head.totalSize > PDF_SCAN_WINDOW_BYTES) {
        const tailStart = Math.max(PDF_SCAN_WINDOW_BYTES, head.totalSize - PDF_SCAN_WINDOW_BYTES);
        const tail = await fetchStrictPartial(url, tailStart, head.totalSize - 1, signal);
        if (tail) tailBytes = tail.bytes;
      }

      const text = `${new TextDecoder("latin1").decode(head.bytes)}\n${new TextDecoder("latin1").decode(tailBytes)}`;
      const result = scanPdfText(text);
      if (result.unreadable) unreadableDetail = result.detail;
      if (result.edited) editedDetails.push(result.detail);
    } catch {
      // ไฟล์เดียวพัง (timeout/network) ไม่ล้มทั้งชุด — ข้ามไปไฟล์ถัดไป (best-effort)
    }
  }

  const flags: FraudFlag[] = [];
  if (editedDetails.length > 0) {
    flags.push({ code: "PDF_EDITED", severity: "warn", detailStaff: editedDetails.slice(0, 3).join(" | ") });
  } else if (unreadableDetail) {
    flags.push({ code: "PDF_UNREADABLE", severity: "warn", detailStaff: unreadableDetail });
  }
  return flags;
}

/** รวม 4 สัญญาณ — แต่ละตัว wrap เดี่ยว (allSettled) ไม่ให้ตัวหนึ่งพังลากตัวอื่น ไม่ throw ออกไปเลย */
export async function computeFraudSignals(opts: {
  adminClient: any;
  nationalIdDigits: string;
  customerName: string;
  facebookUrl: string;
  files: { kind: string; mime: string; r2_key: string; sha256?: string | null; r2_etag?: string | null }[];
  r2: { endpoint: string; bucket: string } | null;
  aws: AwsClient | null;
  presignGet: (aws: AwsClient, endpoint: string, bucket: string, key: string) => Promise<string>;
  signal: AbortSignal;
}): Promise<FraudFlag[]> {
  const results = await Promise.allSettled([
    checkNameChanged(opts.adminClient, opts.nationalIdDigits, opts.customerName),
    checkDupFile(opts.adminClient, opts.nationalIdDigits, opts.files),
    checkFbShared(opts.adminClient, opts.nationalIdDigits, opts.facebookUrl),
    checkPdfFiles(opts.files, opts.r2, opts.aws, opts.presignGet, opts.signal),
  ]);

  const flags: FraudFlag[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled" || !r.value) continue;
    if (Array.isArray(r.value)) flags.push(...r.value);
    else flags.push(r.value);
  }
  return flags;
}
