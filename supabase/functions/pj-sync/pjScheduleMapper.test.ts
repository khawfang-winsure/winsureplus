// pj-sync/pjScheduleMapper.test.ts — Deno test ยืนยัน mapping ตรงกับแถวจริงจาก PJ ที่ครีมเช็คแล้ว
// (21 ก.ย. 2026 รอบแก้ที่ 2) รันด้วย `deno test supabase/functions/pj-sync` — ยืนยันแล้วด้วย
// node/tsc (compile ผ่านสะอาด) ก่อนส่งงาน ดูรายงานในแชท

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mapPjScheduleRowsForDueDayShift } from "./pjScheduleMapper.ts";

// ── แถวตัวอย่างจริงที่ครีมยืนยันจาก PJ (โครงสร้างเป๊ะ ค่าที่ไม่กระทบผลลัพธ์ใส่พอสมเหตุสมผล) ─────────
function pjRow(overrides: Record<string, unknown>) {
  return {
    index: 1,
    uuid: "11111111-1111-1111-1111-111111111111",
    invoice_no: "S00006PNQ033",
    payment_type: "installment",
    amount: "500.00",
    tax_amount: "0.00",
    paid_amount: "0.00",
    remaining_amount: "500.00",
    installment_date: "31-07-2026",
    status: '<span class="badge badge-warning">Pending</span>',
    payment_status: 1,
    actions: "<a>...</a>",
    ...overrides,
  };
}

Deno.test("mapper — Pending: payment_status=1 → pending, installment_date แปลงเป็น ISO ถูกต้อง", () => {
  const [row] = mapPjScheduleRowsForDueDayShift([pjRow({})]);
  assertEquals(row.type, "installment");
  assertEquals(row.amount, 500);
  assertEquals(row.dueDate, "2026-07-31"); // DD-MM-YYYY → YYYY-MM-DD
  assertEquals(row.status, "pending");
});

Deno.test("mapper — Paid: payment_status=2 (+ status HTML Paid) → paid", () => {
  const [row] = mapPjScheduleRowsForDueDayShift([
    pjRow({
      payment_status: 2,
      status: '<span class="badge badge-success">Paid</span>',
      paid_amount: "500.00",
      remaining_amount: "0.00",
    }),
  ]);
  assertEquals(row.status, "paid");
});

Deno.test("mapper — payment_status เป็นค่าอื่น (ไม่ใช่ 1/2) → partial (safe default)", () => {
  const [row] = mapPjScheduleRowsForDueDayShift([pjRow({ payment_status: 3 })]);
  assertEquals(row.status, "partial");
});

Deno.test("mapper — payment_status อ่านไม่ได้ (missing/NaN) แต่ status HTML บอก Pending → ใช้ text แทน", () => {
  const [row] = mapPjScheduleRowsForDueDayShift([
    pjRow({ payment_status: null, status: '<span class="badge badge-warning">Pending</span>' }),
  ]);
  assertEquals(row.status, "pending");
});

Deno.test("mapper — override เด็ดขาด: paid_amount>0 && remaining_amount>0 → partial แม้ payment_status=2", () => {
  const [row] = mapPjScheduleRowsForDueDayShift([
    pjRow({
      payment_status: 2, // บอกว่า Paid แต่ยอดจริงจ่ายไม่ครบ
      status: '<span class="badge badge-success">Paid</span>',
      paid_amount: "200.00",
      remaining_amount: "300.00",
    }),
  ]);
  assertEquals(row.status, "partial");
});

Deno.test("mapper — override เด็ดขาด: paid_amount>0 && remaining_amount>0 → partial แม้ payment_status=1", () => {
  const [row] = mapPjScheduleRowsForDueDayShift([
    pjRow({ payment_status: 1, paid_amount: "100.00", remaining_amount: "400.00" }),
  ]);
  assertEquals(row.status, "partial");
});

Deno.test("mapper — remaining_amount=0 (จ่ายครบ) ไม่ถูก override เป็น partial", () => {
  const [row] = mapPjScheduleRowsForDueDayShift([
    pjRow({ payment_status: 2, paid_amount: "500.00", remaining_amount: "0.00" }),
  ]);
  assertEquals(row.status, "paid");
});

Deno.test("mapper — payment_type ครบ 4 ค่า (installment/penalty/other/down_payment)", () => {
  const rows = mapPjScheduleRowsForDueDayShift([
    pjRow({ payment_type: "installment" }),
    pjRow({ payment_type: "penalty" }),
    pjRow({ payment_type: "other" }),
    pjRow({ payment_type: "down_payment" }),
  ]);
  assertEquals(rows.map((r) => r.type), ["installment", "penalty", "other", "down"]);
});

Deno.test("mapper — amount เป็น string มี comma (\"1,234.50\") parse ถูกต้อง", () => {
  const [row] = mapPjScheduleRowsForDueDayShift([pjRow({ amount: "1,234.50" })]);
  assertEquals(row.amount, 1234.5);
});

Deno.test("mapper — installment_date หาย → dueDate เป็น null (ไม่ throw)", () => {
  const [row] = mapPjScheduleRowsForDueDayShift([pjRow({ installment_date: null })]);
  assertEquals(row.dueDate, null);
});

Deno.test("mapper — installment_date รูปแบบ YYYY-MM-DD ก็อ่านได้เหมือนกัน (defensive)", () => {
  const [row] = mapPjScheduleRowsForDueDayShift([pjRow({ installment_date: "2026-07-31" })]);
  assertEquals(row.dueDate, "2026-07-31");
});
