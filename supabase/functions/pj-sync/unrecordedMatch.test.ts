import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildReviewIndex, classifyUnrecorded } from "./unrecordedMatch.ts";
import type { PjReceipt, ReviewRef, StaffLog, UnrecordedCtx } from "./unrecordedMatch.ts";
import { pendingUuidsOfRawJson } from "./reviewDedup.ts";

const TODAY = "2026-11-19";
const INV = "S00016PNQ023";
const C1 = { id: "c1", contractNo: "S00016PNQ023", status: "active" };

function rc(uuid: string, type: string, amount: number, paidDate: string, invoiceNo = INV): PjReceipt {
  return { uuid, invoiceNo, paymentTypeRaw: type, amount, paidDate, pjRow: { uuid, invoice_no: invoiceNo, payment_type: type, amount: String(amount) } };
}

function ctx(over: Partial<UnrecordedCtx> = {}): UnrecordedCtx {
  return {
    todayIso: TODAY,
    appliedUuids: new Set(),
    reviewRowsByUuid: new Map(),
    opaqueRowKeys: new Map(),
    contractsByInvoice: new Map([[INV, [C1]]]),
    staffLogsByContract: new Map(),
    otherIncomeByContract: new Map(),
    ...over,
  };
}

function ref(reason: string, status: ReviewRef["status"]): ReviewRef {
  return { id: "r1", reason, status, pjPaymentType: "other" };
}

function log(logId: string, date: string, amount: number, cap = amount, pen = 0): StaffLog {
  return { logId, bangkokPaidDate: date, amount, penaltyPaidAmount: pen, capacityLeft: cap, byName: "นภา" };
}

const U1 = "01a161ce-7670-7000-8000-000000000001";

Deno.test("1 applied + resolved OTHER row -> no finding, accountedApplied", () => {
  const r = classifyUnrecorded([rc(U1, "ค่างวด", 700, "2026-10-22")], ctx({
    appliedUuids: new Set([U1]),
    reviewRowsByUuid: new Map([[U1, [ref("OTHER", "resolved")]]]),
  }));
  assertEquals(r.findings.length, 0);
  assertEquals(r.stats.accountedApplied, 1);
});

Deno.test("2 not applied, only resolved OTHER -> RECEIPT_UNRECORDED installment", () => {
  const r = classifyUnrecorded([rc(U1, "ค่างวด", 700, "2026-10-22")], ctx({
    reviewRowsByUuid: new Map([[U1, [ref("OTHER", "resolved")]]]),
  }));
  assertEquals(r.findings.length, 1);
  assertEquals(r.findings[0].outcome, "RECEIPT_UNRECORDED");
  assertEquals(r.findings[0].pjPaymentType, "installment");
  assertEquals(r.findings[0].pjAmount, 700);
  assertEquals(r.findings[0].rawJson.map((x) => x.payment_type), ["installment"]);
});

Deno.test("3 skipped OTHER row does not cover installment", () => {
  const r = classifyUnrecorded([rc(U1, "ค่างวด", 700, "2026-10-22")], ctx({
    reviewRowsByUuid: new Map([[U1, [ref("OTHER", "skipped")]]]),
  }));
  assertEquals(r.findings.length, 1);
  assertEquals(r.findings[0].outcome, "RECEIPT_UNRECORDED");
});

Deno.test("4 staff log 700 next day -> STAFF exact", () => {
  const r = classifyUnrecorded([rc(U1, "ค่างวด", 700, "2026-11-05")], ctx({
    staffLogsByContract: new Map([["c1", [log("L1", "2026-11-06", 700)]]]),
  }));
  assertEquals(r.findings.length, 1);
  const f = r.findings[0];
  assertEquals(f.outcome, "STAFF_MANUAL_OVERLAP");
  assertEquals(f.confidence, "exact");
  assertEquals(f.candidates!.length, 1);
  assertEquals(f.candidates![0].matchKind, "exact_total");
  assertEquals(f.candidates![0].dayDiff, 1);
});

Deno.test("5 two receipts 400+300 = one staff log 700 -> ONE finding", () => {
  const r = classifyUnrecorded([rc("u-a", "ค่างวด", 400, "2026-11-05"), rc("u-b", "ค่างวด", 300, "2026-11-05")], ctx({
    staffLogsByContract: new Map([["c1", [log("L1", "2026-11-06", 700)]]]),
  }));
  assertEquals(r.findings.length, 1);
  assertEquals(r.findings[0].outcome, "STAFF_MANUAL_OVERLAP");
  assertEquals(r.findings[0].confidence, "exact");
  assertEquals(r.findings[0].rawJson.length, 2);
  assertEquals(r.findings[0].pjAmount, 700);
});

Deno.test("6 far exact_total and near 690 -> possible", () => {
  const far = classifyUnrecorded([rc(U1, "ค่างวด", 700, "2026-11-05")], ctx({
    staffLogsByContract: new Map([["c1", [log("L1", "2026-11-17", 700)]]]),
  }));
  assertEquals(far.findings[0].outcome, "STAFF_MANUAL_OVERLAP");
  assertEquals(far.findings[0].confidence, "possible");
  const near = classifyUnrecorded([rc(U1, "ค่างวด", 700, "2026-11-05")], ctx({
    staffLogsByContract: new Map([["c1", [log("L2", "2026-11-06", 690)]]]),
  }));
  assertEquals(near.findings[0].confidence, "possible");
  assertEquals(near.findings[0].candidates![0].matchKind, "near");
});

Deno.test("7 other 200 vs other_income 200 -> accounted; vs 150 -> finding", () => {
  const hit = classifyUnrecorded([rc("u-o", "อื่นๆ", 200, "2026-11-06")], ctx({
    otherIncomeByContract: new Map([["c1", [{ id: "o1", amount: 200, receivedAt: "2026-11-07" }]]]),
  }));
  assertEquals(hit.findings.length, 0);
  assertEquals(hit.stats.accountedOtherIncome, 1);
  const miss = classifyUnrecorded([rc("u-o", "อื่นๆ", 200, "2026-11-06")], ctx({
    otherIncomeByContract: new Map([["c1", [{ id: "o1", amount: 150, receivedAt: "2026-11-07" }]]]),
  }));
  assertEquals(miss.findings.length, 1);
  assertEquals(miss.findings[0].outcome, "RECEIPT_UNRECORDED");
  assertEquals(miss.findings[0].pjPaymentType, "other");
});

Deno.test("8 closed contract -> RECEIPT_UNRECORDED + CONTRACT_CLOSED + applyBlocked", () => {
  const r = classifyUnrecorded([rc(U1, "ค่างวด", 700, "2026-11-05")], ctx({
    contractsByInvoice: new Map([[INV, [{ ...C1, status: "closed" }]]]),
  }));
  assertEquals(r.findings[0].outcome, "RECEIPT_UNRECORDED");
  assertEquals(r.findings[0].contractNote, "CONTRACT_CLOSED");
  assertEquals(r.findings[0].applyBlocked, true);
});

Deno.test("9 settle margin: 11-18 / 11-17 skipped, 11-16 evaluated", () => {
  const a = classifyUnrecorded([rc("u1", "ค่างวด", 700, "2026-11-18"), rc("u2", "ค่างวด", 700, "2026-11-17")], ctx());
  assertEquals(a.stats.skippedSettling, 2);
  assertEquals(a.findings.length, 0);
  const b = classifyUnrecorded([rc("u3", "ค่างวด", 700, "2026-11-16")], ctx());
  assertEquals(b.stats.skippedSettling, 0);
  assertEquals(b.findings.length, 1);
});

Deno.test("10 uuid in a pending row -> accounted", () => {
  const r = classifyUnrecorded([rc(U1, "ค่างวด", 700, "2026-11-05")], ctx({
    reviewRowsByUuid: new Map([[U1, [ref("OTHER", "pending")]]]),
  }));
  assertEquals(r.findings.length, 0);
  assertEquals(r.stats.accountedPending, 1);
});

Deno.test("11 uuid in skipped AMOUNT_MISMATCH row -> accounted, accountedSkippedRows", () => {
  const r = classifyUnrecorded([rc(U1, "ค่างวด", 700, "2026-11-05")], ctx({
    reviewRowsByUuid: new Map([[U1, [ref("AMOUNT_MISMATCH", "skipped")]]]),
  }));
  assertEquals(r.findings.length, 0);
  assertEquals(r.stats.accountedSkippedRows, 1);
});

Deno.test("12 down payment skipped", () => {
  const r = classifyUnrecorded([rc(U1, "เงินดาวน์", 5970, "2026-11-05")], ctx());
  assertEquals(r.stats.skippedDown, 1);
  assertEquals(r.findings.length, 0);
});

Deno.test("13 invoice with 2 contracts -> noContract", () => {
  const r = classifyUnrecorded([rc(U1, "ค่างวด", 700, "2026-11-05")], ctx({
    contractsByInvoice: new Map([[INV, [C1, { ...C1, id: "c2" }]]]),
  }));
  assertEquals(r.stats.noContract, 1);
  assertEquals(r.findings.length, 0);
});

Deno.test("shape: rawJson is array readable by pendingUuidsOfRawJson", () => {
  const r = classifyUnrecorded([rc("u-a", "ค่างวด", 400, "2026-11-05"), rc("u-b", "ค่าปรับ", 100, "2026-11-05")], ctx());
  assertEquals(r.findings.length, 1);
  assertEquals(pendingUuidsOfRawJson(r.findings[0].rawJson)!.sort(), ["u-a", "u-b"]);
  assertEquals(r.findings[0].rawJson.map((x) => x.payment_type).sort(), ["installment", "penalty"]);
});

Deno.test("buildReviewIndex reads every raw_json element and opaque rows", () => {
  const idx = buildReviewIndex([
    { id: "a", reason: "OTHER", status: "resolved", pj_payment_type: "other", pj_invoice_no: INV, pj_paid_date: "2026-10-22",
      raw_json: [{ uuid: "x1" }, { uuid: "x2" }, { uuid: "x3" }] },
    { id: "b", reason: "PLAN_CHANGE_REVIEW", status: "resolved", pj_payment_type: "other", pj_invoice_no: INV, pj_paid_date: "2026-10-23", raw_json: { kind: "plan" } },
  ]);
  assertEquals(idx.reviewRowsByUuid.get("x3")!.length, 1);
  assertEquals(idx.opaqueRowKeys.get(`${INV}::2026-10-23`)!.length, 1);
});

Deno.test("contract status -> note mapping (returned / returned_closed / online / null)", () => {
  const note = (status: string | null) =>
    classifyUnrecorded([rc(U1, "ค่างวด", 700, "2026-11-05")], ctx({
      contractsByInvoice: new Map([[INV, [{ ...C1, status }]]]),
    })).findings[0];
  assertEquals(note("returned").contractNote, "CONTRACT_RETURNED");
  assertEquals(note("returned_closed").contractNote, "CONTRACT_RETURNED");
  const inactive = note("online");
  assertEquals(inactive.contractNote, "CONTRACT_INACTIVE");
  assertEquals(inactive.applyBlocked, true);
  assertEquals(inactive.explainTh.endsWith(" · สถานะสัญญาไม่ใช่ผ่อนปกติ ต้องตรวจมือ"), true);
  assertEquals(note(null).contractNote, "CONTRACT_INACTIVE");
});

Deno.test("6b exact amount 28 days away -> possible (not exact); 36 days -> RECEIPT_UNRECORDED; 10 days -> exact", () => {
  const mk = (d: string) => classifyUnrecorded([rc(U1, "ค่างวด", 700, "2026-10-20")], ctx({
    staffLogsByContract: new Map([["c1", [log("L1", d, 700)]]]),
  })).findings[0];
  const f28 = mk("2026-11-17");
  assertEquals(f28.outcome, "STAFF_MANUAL_OVERLAP");
  assertEquals(f28.confidence, "possible");
  assertEquals(f28.candidates![0].dayDiff, 28);
  assertEquals(mk("2026-11-25").outcome, "RECEIPT_UNRECORDED"); // 36 วัน
  assertEquals(mk("2026-10-30").confidence, "exact"); // 10 วัน
});
