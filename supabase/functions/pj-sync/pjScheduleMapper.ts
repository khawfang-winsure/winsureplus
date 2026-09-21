// pj-sync/pjScheduleMapper.ts
//
// ฟังก์ชันบริสุทธิ์ map แถวดิบจาก PJ endpoint /manager/ajax/invoice-items/{uuid} → PjScheduleRow
// (ตารางงวด PJ) สำหรับ decideDueDayShift (dueDayShift.ts) เท่านั้น — แยกไฟล์ต่างหากจาก dueDayShift.ts
// เพราะไฟล์นั้นสงวนไว้เฉพาะ "กติกาตัดสินใจ" ล้วนๆ ส่วนไฟล์นี้คือ "field-name mapping" ที่ผูกกับรูปแบบ
// ข้อมูลจริงของ PJ (มีสิทธิ์ต้องแก้ถ้า PJ เปลี่ยน field) — แยกให้ทดสอบ/แก้อิสระจากกัน ไม่มี Deno API
// เลย (ทดสอบด้วย `deno test` หรือ node/tsc ธรรมดาก็ได้ — ดู pjScheduleMapper.test.ts)
//
// (21 ก.ย. 2026 รอบแก้ที่ 2) ครีมเช็คกับ PJ จริงแล้ว ยืนยัน field ต่อไปนี้:
//   index, uuid, invoice_no, payment_type ("installment"|"penalty"|"other"|"down_payment"),
//   amount ("500.00" — string!), tax_amount, paid_amount, remaining_amount,
//   installment_date ("31-07-2026" — DD-MM-YYYY), status (HTML ดิบ เช่น
//   `<span class="badge badge-success">Paid</span>`), payment_status (ตัวเลข 1=Pending, 2=Paid;
//   Partial ยังไม่เคยเห็นค่าจริงจาก PJ), actions
//
// กติกา status (คุณเตย/ครีมยืนยัน):
//   1) payment_status เป็นตัวหลัก: 1→pending, 2→paid, ค่าอื่น (หรืออ่านไม่ได้)→ถือเป็น partial (safe
//      default — partial บังคับเข้า review เสมอ ไม่มีทางหลุดไป auto-apply ผิดๆ)
//   2) fallback: ถ้า payment_status อ่านไม่ได้ (NaN) แต่ status (HTML text หลัง strip tag) มีคำ paid/
//      pending ตรงๆ ให้ใช้ค่านั้นแทน partial default
//   3) override เด็ดขาด: paid_amount>0 && remaining_amount>0 → partial เสมอ ไม่ว่า payment_status/
//      status text จะว่าไง (จ่ายบางส่วนจริงมีหลักฐานชัดกว่า flag ตัวเลข)

import type { PjScheduleRow, PjScheduleType, PjScheduleStatus } from "./dueDayShift.ts";

function pick(row: any, keys: string[]): any {
  for (const k of keys) {
    if (row && row[k] != null && row[k] !== "") return row[k];
  }
  return null;
}

// "1,234.50" / "1234" / number → number. กับดัก: PJ ส่ง string มี comma หรือทศนิยมเป็น string เสมอ
function parseAmount(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const cleaned = v.replace(/,/g, "").replace(/[^\d.-]/g, "").trim();
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// "DD-MM-YYYY" หรือ "YYYY-MM-DD" → "YYYY-MM-DD" — เหมือน toIsoDate ใน index.ts เป๊ะ (ก๊อปมาเพื่อให้
// ไฟล์นี้ไม่มี dependency ข้าม index.ts เลย ทดสอบแยกอิสระได้ 100%)
function toIsoDate(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  const datePart = s.split(/[ T]/)[0];
  let m = datePart.match(/^(\d{2})-(\d{2})-(\d{4})$/); // DD-MM-YYYY (installment_date ของ PJ)
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/); // YYYY-MM-DD
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = datePart.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); // DD/MM/YYYY
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

export function mapPjScheduleRowsForDueDayShift(rows: any[]): PjScheduleRow[] {
  return rows.map((row) => {
    const typeRaw = String(pick(row, ["payment_type", "type"]) ?? "").toLowerCase();
    const amount = parseAmount(pick(row, ["amount"]));
    const paidAmt = parseAmount(pick(row, ["paid_amount"]));
    const remainingAmt = parseAmount(pick(row, ["remaining_amount"]));
    // installment_date = field จริงยืนยันแล้ว ("31-07-2026" DD-MM-YYYY) — ใส่เป็นตัวแรกเสมอ
    const dueDateRaw = pick(row, ["installment_date", "due_date", "payment_due_date", "dueDate"]);
    const statusHtmlRaw = String(pick(row, ["status"]) ?? "");
    const statusText = statusHtmlRaw.replace(/<[^>]*>/g, "").trim().toLowerCase(); // strip HTML tag ก่อนเทียบ
    // ⚠️ pick() คืน null ถ้า field หายไปเลย (ไม่ใช่ 0) — ต้องเช็ค null ก่อน Number() เพราะ Number(null)
    //    === 0 ใน JS (ไม่ใช่ NaN!) ถ้าไม่เช็คก่อน จะพลาดตกไป "ค่าอื่น" (0 !== 1/2) แทนที่จะ fallback ไป
    //    อ่าน status text ด้านล่าง (เจอบั๊กนี้จริงตอนเทสต์ 21 ก.ย. 2026 รอบแก้ที่ 2 — ต้องเช็ค null เอง)
    const paymentStatusRaw = pick(row, ["payment_status"]);
    const paymentStatusNum = paymentStatusRaw == null ? NaN : Number(paymentStatusRaw);

    let type: PjScheduleType = "other";
    if (typeRaw.includes("down")) type = "down"; // "down_payment" ตรงนี้แล้ว
    else if (typeRaw.includes("penalty")) type = "penalty";
    else if (typeRaw.includes("installment")) type = "installment";

    let status: PjScheduleStatus;
    if (paymentStatusNum === 1) status = "pending";
    else if (paymentStatusNum === 2) status = "paid";
    else status = "partial"; // ค่าอื่น/อ่านไม่ได้ → safe default = partial
    // fallback เผื่อ payment_status หาย/พังแต่ status (HTML text) ยังอ่านได้ตรงๆ
    if (Number.isNaN(paymentStatusNum) && statusText) {
      if (statusText.includes("paid")) status = "paid";
      else if (statusText.includes("pending")) status = "pending";
      // เจอคำว่า partial ตรงๆ ใน status text ก็ยังเป็น partial อยู่แล้ว (ไม่ต้องเซ็ตซ้ำ)
    }
    // override เด็ดขาด: จ่ายบางส่วนจริง (paid_amount>0 && remaining_amount>0) = partial เสมอ
    if (paidAmt > 0 && remainingAmt > 0) status = "partial";

    return { type, amount, dueDate: toIsoDate(dueDateRaw), status };
  });
}
