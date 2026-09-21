// pj-sync/dueDayShift.test.ts — Deno test (รันตอน deploy/CI ผ่าน `deno test`) — ครีมไม่มี deno
// ติดตั้งในเครื่อง ณ วันที่เขียนไฟล์นี้ (21 ก.ย. 2026) — ตรรกะเดียวกันนี้ถูก compile+รันจริงแล้วด้วย
// node (tsc --target es2020 --module commonjs) ผ่านครบ 39/39 เคส ก่อนส่งงานกลับ (ดูรายงานในแชท)
// ไฟล์นี้คือชุดทดสอบถาวรในรีโป — ให้ ครีม/ติ๊ก รัน `deno test supabase/functions/pj-sync` ยืนยันซ้ำ
// ได้ทุกเมื่อ (ไม่ต้องพึ่ง node harness ชั่วคราวอีกต่อไป)

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decideDueDayShift, type OurInstallment, type PjScheduleRow } from "./dueDayShift.ts";

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function clamp(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(Math.min(d, daysInMonth(y, m))).padStart(2, "0")}`;
}

// เดือนทดสอบ: ต.ค./พ.ย./ธ.ค. 2026 + ก.พ. 2027 (28 วัน, ปีปกติ) ครอบทั้งเดือนสั้น/ยาว
const MONTHS: [number, number][] = [[2026, 10], [2026, 11], [2026, 12], [2027, 2]];
const TODAY = "2026-09-21";

// ── 8 เคสจริงที่ครีมแก้มือ 21 ก.ย. 2026 — ตรรกะนี้ต้องคำนวณวันใหม่ตรงกับที่แก้มือทุกประการ ────────
type RealCase = { contract: string; oldDay: number; newDay: number };
const realCases: RealCase[] = [
  { contract: "S00006PNQ033", oldDay: 25, newDay: 31 }, // "สิ้นเดือน" ทดสอบด้วย 31 (คลุมทุกเดือนสั้น)
  { contract: "S00015PNQ060", oldDay: 25, newDay: 2 },
  { contract: "S00017PNQ128", oldDay: 27, newDay: 1 },
  { contract: "S00017PNQ186", oldDay: 3, newDay: 8 },
  { contract: "S00018PNQ052", oldDay: 28, newDay: 1 },
  { contract: "S00018PNQ233", oldDay: 17, newDay: 5 },
  { contract: "S00023PNQ002", oldDay: 7, newDay: 15 },
  { contract: "S00032PNQ062", oldDay: 31, newDay: 5 },
];

for (const rc of realCases) {
  Deno.test(`decideDueDayShift — เคสจริง ${rc.contract} (${rc.oldDay}→${rc.newDay})`, () => {
    const ourInstallments: OurInstallment[] = MONTHS.map(([y, m], idx) => ({
      id: `${rc.contract}-${y}-${m}`,
      installmentNo: idx + 1,
      amount: 3000,
      paidAmount: 0,
      dueDate: clamp(y, m, rc.oldDay),
    }));
    const pjSchedule: PjScheduleRow[] = MONTHS.map(([y, m]) => ({
      type: "installment",
      amount: 3000,
      dueDate: clamp(y, m, rc.newDay),
      status: "pending",
    }));

    const decision = decideDueDayShift({ pjSchedule, ourInstallments, today: TODAY });
    assertEquals(decision.kind, "auto_shift");
    if (decision.kind !== "auto_shift") return; // narrow (unreachable — assertEquals โยนก่อนหน้านี้ถ้าไม่ตรง)

    assertEquals(decision.newDueDay, rc.newDay);
    assertEquals(decision.updates.length, MONTHS.length);
    const gotDates = decision.updates.map((u) => u.newDueDate);
    const expectedDates = MONTHS.map(([y, m]) => clamp(y, m, rc.newDay));
    assertEquals(gotDates, expectedDates);
  });
}

Deno.test("decideDueDayShift — จำนวนงวด Pending ไม่เท่ากัน ต้องเข้า review", () => {
  const ourInstallments: OurInstallment[] = [
    { id: "a", installmentNo: 1, amount: 3000, paidAmount: 0, dueDate: "2026-10-25" },
    { id: "b", installmentNo: 2, amount: 3000, paidAmount: 0, dueDate: "2026-11-25" },
  ];
  const pjSchedule: PjScheduleRow[] = [
    { type: "installment", amount: 3000, dueDate: "2026-10-02", status: "pending" },
  ];
  const d = decideDueDayShift({ pjSchedule, ourInstallments, today: TODAY });
  assertEquals(d.kind, "review");
});

Deno.test("decideDueDayShift — ยอดเงินไม่ตรงกัน ต้องเข้า review", () => {
  const ourInstallments: OurInstallment[] = [
    { id: "a", installmentNo: 1, amount: 3000, paidAmount: 0, dueDate: "2026-10-25" },
  ];
  const pjSchedule: PjScheduleRow[] = [
    { type: "installment", amount: 3500, dueDate: "2026-10-02", status: "pending" },
  ];
  const d = decideDueDayShift({ pjSchedule, ourInstallments, today: TODAY });
  assertEquals(d.kind, "review");
});

Deno.test("decideDueDayShift — จับคู่คนละเดือน ต้องเข้า review", () => {
  const ourInstallments: OurInstallment[] = [
    { id: "a", installmentNo: 1, amount: 3000, paidAmount: 0, dueDate: "2026-10-25" },
  ];
  const pjSchedule: PjScheduleRow[] = [
    { type: "installment", amount: 3000, dueDate: "2026-11-02", status: "pending" },
  ];
  const d = decideDueDayShift({ pjSchedule, ourInstallments, today: TODAY });
  assertEquals(d.kind, "review");
});

Deno.test("decideDueDayShift — มีงวดจ่ายบางส่วน (Partial) ต้องเข้า review", () => {
  const ourInstallments: OurInstallment[] = [
    { id: "a", installmentNo: 1, amount: 3000, paidAmount: 0, dueDate: "2026-10-25" },
  ];
  const pjSchedule: PjScheduleRow[] = [
    { type: "installment", amount: 3000, dueDate: "2026-10-02", status: "pending" },
    { type: "installment", amount: 1500, dueDate: "2026-09-25", status: "partial" },
  ];
  const d = decideDueDayShift({ pjSchedule, ourInstallments, today: TODAY });
  assertEquals(d.kind, "review");
});

Deno.test("decideDueDayShift — เลื่อนแล้วกลายเป็นเลยกำหนดทันที ต้องเข้า review", () => {
  const ourInstallments: OurInstallment[] = [
    { id: "a", installmentNo: 1, amount: 3000, paidAmount: 0, dueDate: "2026-10-25" },
  ];
  const pjSchedule: PjScheduleRow[] = [
    { type: "installment", amount: 3000, dueDate: "2026-10-02", status: "pending" },
  ];
  const d = decideDueDayShift({ pjSchedule, ourInstallments, today: "2026-10-10" }); // > 2, < 25
  assertEquals(d.kind, "review");
});

Deno.test("decideDueDayShift — วันไม่สม่ำเสมอ (ไม่ใช่แค่ปลายเดือนสั้นกว่า) ต้องเข้า review", () => {
  const ourInstallments: OurInstallment[] = [
    { id: "a", installmentNo: 1, amount: 3000, paidAmount: 0, dueDate: "2026-10-25" },
    { id: "b", installmentNo: 2, amount: 3000, paidAmount: 0, dueDate: "2026-11-25" },
  ];
  const pjSchedule: PjScheduleRow[] = [
    { type: "installment", amount: 3000, dueDate: "2026-10-05", status: "pending" },
    { type: "installment", amount: 3000, dueDate: "2026-11-09", status: "pending" }, // วันไม่ตรงกัน
  ];
  const d = decideDueDayShift({ pjSchedule, ourInstallments, today: TODAY });
  assertEquals(d.kind, "review");
});

Deno.test("decideDueDayShift — ไม่มีงวดค้างที่ยังไม่ถึงกำหนด → no_candidates", () => {
  const ourInstallments: OurInstallment[] = [
    { id: "a", installmentNo: 1, amount: 3000, paidAmount: 3000, dueDate: "2026-10-25" },
  ];
  const d = decideDueDayShift({ pjSchedule: [], ourInstallments, today: TODAY });
  assertEquals(d.kind, "no_candidates");
  assert(true);
});
