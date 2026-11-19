// ตัวตรวจใบเสร็จ PJ ตกหล่น (mode="unrecorded_watch") — pure function ไม่แตะ DB / fetch / Date.now()
// spec: แบม 19 พ.ย. 2026 (ใบค่างวด/ค่าปรับ/อื่นๆ จาก PJ ที่ไม่ถูกลงในระบบ แม้จะมีแถวกล่องรอตรวจ OTHER ที่ resolve ไปแล้ว)
// caller (index.ts) เป็นคนดึง PJ + โหลด ctx จาก DB + insert กล่องรอตรวจ — ไฟล์นี้ตัดสินใจอย่างเดียว

import { classifyPjReceiptPaymentType } from "./receiptPaymentType.ts";
import { allUuidsOfRawJson, pendingUuidsOfRawJson } from "./reviewDedup.ts";

export interface PjReceipt {
  uuid: string;
  invoiceNo: string;
  paymentTypeRaw: unknown;
  amount: number;
  paidDate: string; // YYYY-MM-DD
  pjRow: Record<string, any>;
}

export type ReviewStatus = "pending" | "resolved" | "skipped" | "auto_resolved";

export interface ReviewRef {
  id: string;
  reason: string;
  status: ReviewStatus;
  pjPaymentType: string | null;
}

export interface StaffLog {
  logId: string;
  bangkokPaidDate: string; // YYYY-MM-DD
  amount: number;
  penaltyPaidAmount: number;
  capacityLeft: number;
  byName: string;
}

export interface UnrecordedCtx {
  todayIso: string;
  appliedUuids: Set<string>;
  reviewRowsByUuid: Map<string, ReviewRef[]>;
  opaqueRowKeys: Map<string, ReviewRef[]>; // `${invoiceNo}::${paidDate}`
  contractsByInvoice: Map<string, { id: string; contractNo: string; status: string | null }[]>;
  staffLogsByContract: Map<string, StaffLog[]>;
  otherIncomeByContract: Map<string, { id: string; amount: number; receivedAt: string }[]>;
}

export type PjCategory = "installment" | "penalty" | "other";
export type ContractNote = null | "CONTRACT_CLOSED" | "CONTRACT_RETURNED" | "CONTRACT_INACTIVE";

export interface StaffCandidate {
  logId: string;
  amount: number;
  penaltyPaidAmount: number;
  bangkokPaidDate: string;
  byName: string;
  matchKind: "exact_total" | "exact_principal" | "near";
  dayDiff: number;
  capacityLeft: number;
}

export interface Finding {
  outcome: "RECEIPT_UNRECORDED" | "STAFF_MANUAL_OVERLAP";
  contractId: string;
  contractNo: string;
  invoiceNo: string;
  paidDate: string;
  pjPaymentType: PjCategory;
  pjAmount: number;
  receiptTotal: number; // ยอดรวมทุกใบใน rawJson (ใช้รายงานขนาดเงิน)
  rawJson: Record<string, any>[];
  uuids: string[];
  candidates?: StaffCandidate[];
  confidence?: "exact" | "possible";
  contractNote: ContractNote;
  applyBlocked: boolean;
  explainTh: string;
}

export interface UnrecordedStats {
  scanned: number;
  skippedDown: number;
  skippedSettling: number;
  accountedApplied: number;
  accountedPending: number;
  accountedResolved: number;
  accountedSkippedRows: number;
  accountedOtherIncome: number;
  noContract: number;
  findingsUnrecorded: number;
  findingsStaff: number;
  sumAmountFlagged: number;
}

export interface UnrecordedResult {
  findings: Finding[];
  stats: UnrecordedStats;
}

const EPS = 0.005;
const SETTLE_DAYS = 2; // ใบที่จ่ายภายใน 2 วันล่าสุด ให้ sync ปกติจัดการก่อน
const EXACT_DAY_DIFF = 10; // ตรงเป๊ะ + ห่างไม่เกิน 10 วัน = exact; 11-35 วัน = possible (คนตรวจ — งวดยอดเท่ากันรายเดือนอาจจับคู่ผิดเดือน)
const OVERLAP_WINDOW = 35; // พนักงานมักคีย์ช้ากว่า PJ เป็นสัปดาห์-เดือน (คุณเตยอนุมัติ 19 พ.ย.)
const NEAR_TOLERANCE = 20;
const OTHER_INCOME_DAY_DIFF = 3;

function dayNum(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return NaN;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
}

function daysBetween(a: string, b: string): number {
  return dayNum(b) - dayNum(a);
}

function money(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function ddmm(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/** แถวกล่องที่ resolved/skipped "ครอบคลุม" ใบประเภทนี้ไหม — แถว OTHER (และแถวทึบเช่น PLAN_CHANGE_*) ครอบแค่ใบ "อื่นๆ" */
function covers(reason: string, opaque: boolean, cat: PjCategory): boolean {
  if (opaque) return cat === "other";
  if (reason === "OTHER") return cat === "other";
  return true;
}

/** สร้าง index จากแถว pj_sync_review ทั้งหมดของ invoice ที่เกี่ยวข้อง — อ่านทุก element ของ raw_json */
export function buildReviewIndex(
  rows: { id: string; reason: string; status: string; pj_payment_type: string | null; pj_invoice_no: string; pj_paid_date: string | null; raw_json: unknown }[],
): { reviewRowsByUuid: Map<string, ReviewRef[]>; opaqueRowKeys: Map<string, ReviewRef[]> } {
  const reviewRowsByUuid = new Map<string, ReviewRef[]>();
  const opaqueRowKeys = new Map<string, ReviewRef[]>();
  const push = <K>(m: Map<K, ReviewRef[]>, k: K, ref: ReviewRef) => {
    const arr = m.get(k);
    if (arr) arr.push(ref); else m.set(k, [ref]);
  };
  for (const r of rows) {
    const status = (["pending", "resolved", "skipped", "auto_resolved"].includes(r.status) ? r.status : "resolved") as ReviewStatus;
    const ref: ReviewRef = { id: r.id, reason: r.reason, status, pjPaymentType: r.pj_payment_type };
    const all = allUuidsOfRawJson(r.raw_json);
    const key = `${r.pj_invoice_no}::${r.pj_paid_date ?? "unknown"}`;
    if (status === "pending") {
      const pend = pendingUuidsOfRawJson(r.raw_json);
      if (pend) for (const u of pend) push(reviewRowsByUuid, u, ref);
      else if (all.length > 0) for (const u of all) push(reviewRowsByUuid, u, ref); // อ่านรายใบไม่ได้ → ถือว่าทุกใบรออยู่ (ปลอดภัยกว่า)
      else push(opaqueRowKeys, key, ref);
    } else if (all.length > 0) {
      for (const u of all) push(reviewRowsByUuid, u, ref);
    } else {
      push(opaqueRowKeys, key, ref);
    }
  }
  return { reviewRowsByUuid, opaqueRowKeys };
}

type Item = { r: PjReceipt; cat: PjCategory };

function outcomeFor(cat: PjCategory, kind: Finding["outcome"]): string {
  return `${kind}/${cat}`;
}

export function classifyUnrecorded(receipts: PjReceipt[], ctx: UnrecordedCtx): UnrecordedResult {
  const stats: UnrecordedStats = {
    scanned: 0, skippedDown: 0, skippedSettling: 0, accountedApplied: 0, accountedPending: 0,
    accountedResolved: 0, accountedSkippedRows: 0, accountedOtherIncome: 0, noContract: 0,
    findingsUnrecorded: 0, findingsStaff: 0, sumAmountFlagged: 0,
  };

  // เหลือใบที่ไม่ซ้ำ uuid และยอดใช้ได้
  const seen = new Set<string>();
  const unaccounted: (Item & { contract: { id: string; contractNo: string; status: string | null } })[] = [];

  for (const r of receipts) {
    const dupKey = r.uuid;
    if (dupKey) {
      if (seen.has(dupKey)) continue;
      seen.add(dupKey);
    }
    stats.scanned++;
    if (!Number.isFinite(r.amount) || !(r.amount > EPS)) continue;
    const t = classifyPjReceiptPaymentType(r.paymentTypeRaw);
    // 1) down ข้าม
    if (t === "down") { stats.skippedDown++; continue; }
    const cat: PjCategory = t;
    const cs = ctx.contractsByInvoice.get(r.invoiceNo);
    if (!r.uuid || !cs || cs.length !== 1) { stats.noContract++; continue; }
    // 2) ใบใหม่ล่าสุดปล่อยให้ sync ปกติจัดการก่อน
    const age = daysBetween(r.paidDate, ctx.todayIso);
    if (!(age > SETTLE_DAYS)) { stats.skippedSettling++; continue; }

    // 3) accounted?
    if (ctx.appliedUuids.has(r.uuid)) { stats.accountedApplied++; continue; }
    const refs = ctx.reviewRowsByUuid.get(r.uuid) ?? [];
    const opaque = ctx.opaqueRowKeys.get(`${r.invoiceNo}::${r.paidDate}`) ?? [];
    if (refs.some((x) => x.status === "pending") || opaque.some((x) => x.status === "pending")) {
      stats.accountedPending++; continue;
    }
    const resolvedHit = refs.some((x) => (x.status === "resolved" || x.status === "auto_resolved") && covers(x.reason, false, cat))
      || opaque.some((x) => (x.status === "resolved" || x.status === "auto_resolved") && covers(x.reason, true, cat));
    if (resolvedHit) { stats.accountedResolved++; continue; }
    const skippedHit = refs.some((x) => x.status === "skipped" && covers(x.reason, false, cat))
      || opaque.some((x) => x.status === "skipped" && covers(x.reason, true, cat));
    if (skippedHit) { stats.accountedSkippedRows++; continue; }

    unaccounted.push({ r, cat, contract: cs[0] });
  }

  const findings: Finding[] = [];
  const noteOf = (status: string | null): ContractNote =>
    status === "active" ? null
      : status === "closed" ? "CONTRACT_CLOSED"
        : status === "returned" || status === "returned_closed" ? "CONTRACT_RETURNED"
          : "CONTRACT_INACTIVE";

  // 4) ใบ "อื่นๆ" — จับคู่ other_income 1:1 ไม่งั้นเป็น finding (ไม่ปนกับค่างวด/ค่าปรับ)
  const usedOther = new Set<string>();
  const otherGroups = new Map<string, (Item & { contract: { id: string; contractNo: string; status: string | null } })[]>();
  const orderedOthers = unaccounted
    .filter((u) => u.cat === "other")
    .sort((a, b) => (a.r.paidDate < b.r.paidDate ? -1 : a.r.paidDate > b.r.paidDate ? 1 : a.r.uuid < b.r.uuid ? -1 : 1));
  for (const u of orderedOthers) {
    const list = ctx.otherIncomeByContract.get(u.contract.id) ?? [];
    const hit = list.find((o) =>
      !usedOther.has(o.id) && Math.abs(o.amount - u.r.amount) < EPS &&
      Math.abs(daysBetween(u.r.paidDate, o.receivedAt.slice(0, 10))) <= OTHER_INCOME_DAY_DIFF);
    if (hit) { usedOther.add(hit.id); stats.accountedOtherIncome++; continue; }
    const k = `${u.contract.id}::${u.r.paidDate}`;
    const g = otherGroups.get(k);
    if (g) g.push(u); else otherGroups.set(k, [u]);
  }
  for (const g of otherGroups.values()) {
    const first = g[0];
    const total = g.reduce((s, x) => s + x.r.amount, 0);
    const note = noteOf(first.contract.status);
    findings.push({
      outcome: "RECEIPT_UNRECORDED",
      contractId: first.contract.id, contractNo: first.contract.contractNo,
      invoiceNo: first.r.invoiceNo, paidDate: first.r.paidDate,
      pjPaymentType: "other", pjAmount: total, receiptTotal: total,
      rawJson: g.map((x) => ({ ...x.r.pjRow, payment_type: "other" })),
      uuids: g.map((x) => x.r.uuid),
      contractNote: note, applyBlocked: note !== null,
      explainTh: `PJ มีใบอื่นๆ ${money(total)} บาท วันที่ ${ddmm(first.r.paidDate)} · ยังไม่ลงเป็นรายได้อื่นๆ${suffix(note)}`,
    });
  }

  // 5) ใบค่างวด/ค่าปรับ — group (contract, paidDate)
  const ipGroups = new Map<string, (Item & { contract: { id: string; contractNo: string; status: string | null } })[]>();
  for (const u of unaccounted) {
    if (u.cat === "other") continue;
    const k = `${u.contract.id}::${u.r.paidDate}`;
    const g = ipGroups.get(k);
    if (g) g.push(u); else ipGroups.set(k, [u]);
  }
  for (const g of ipGroups.values()) {
    const first = g[0];
    const sorted = [...g].sort((a, b) => (a.r.uuid < b.r.uuid ? -1 : a.r.uuid > b.r.uuid ? 1 : 0));
    const P = sorted.filter((x) => x.cat === "installment").reduce((s, x) => s + x.r.amount, 0);
    const PEN = sorted.filter((x) => x.cat === "penalty").reduce((s, x) => s + x.r.amount, 0);
    const T = P + PEN;
    const logs = ctx.staffLogsByContract.get(first.contract.id) ?? [];
    const exact: StaffCandidate[] = [];
    const possible: StaffCandidate[] = [];
    for (const l of logs) {
      const dayDiff = Math.abs(daysBetween(first.r.paidDate, l.bangkokPaidDate));
      if (!(dayDiff <= OVERLAP_WINDOW)) continue;
      if (!(l.capacityLeft >= T - NEAR_TOLERANCE)) continue;
      let kind: StaffCandidate["matchKind"] | null = null;
      if (Math.abs(l.amount - T) < EPS) kind = "exact_total";
      else if (Math.abs(l.amount - l.penaltyPaidAmount - P) < EPS) kind = "exact_principal";
      else if (Math.min(Math.abs(l.amount - T), Math.abs(l.amount - l.penaltyPaidAmount - P)) <= NEAR_TOLERANCE) kind = "near";
      if (!kind) continue;
      const c: StaffCandidate = {
        logId: l.logId, amount: l.amount, penaltyPaidAmount: l.penaltyPaidAmount,
        bangkokPaidDate: l.bangkokPaidDate, byName: l.byName, matchKind: kind, dayDiff, capacityLeft: l.capacityLeft,
      };
      possible.push(c);
      if (kind !== "near" && dayDiff <= EXACT_DAY_DIFF) exact.push(c);
    }
    const byRank = (a: StaffCandidate, b: StaffCandidate) =>
      a.dayDiff - b.dayDiff || (a.logId < b.logId ? -1 : a.logId > b.logId ? 1 : 0);
    exact.sort(byRank);
    possible.sort(byRank);

    const note = noteOf(first.contract.status);
    const pjType: PjCategory = P > 0 ? "installment" : "penalty";
    const pjAmount = P > 0 ? P : PEN;
    const rawJson = sorted.map((x) => ({ ...x.r.pjRow, payment_type: x.cat }));
    const base = {
      contractId: first.contract.id, contractNo: first.contract.contractNo,
      invoiceNo: first.r.invoiceNo, paidDate: first.r.paidDate,
      pjPaymentType: pjType, pjAmount, receiptTotal: T, rawJson,
      uuids: sorted.map((x) => x.r.uuid),
      contractNote: note, applyBlocked: note !== null,
    };
    if (exact.length > 0 || possible.length > 0) {
      const isExact = exact.length > 0;
      const cands = isExact ? exact : possible;
      const top = cands[0];
      const text = isExact
        ? `ตรงกับที่พนักงานลงไว้ ${money(top.amount)} บาท (${top.byName} ${ddmm(top.bangkokPaidDate)}) · กดยืนยันเพื่อผูก`
        : `ใกล้เคียงรายการที่พนักงานลง ${money(top.amount)} บาท (ห่าง ${top.dayDiff} วัน) · ตรวจก่อนผูก`;
      findings.push({
        ...base, outcome: "STAFF_MANUAL_OVERLAP", candidates: cands,
        confidence: isExact ? "exact" : "possible", explainTh: text + suffix(note),
      });
    } else {
      const label = pjType === "installment" ? "ค่างวด" : "ค่าปรับ";
      findings.push({
        ...base, outcome: "RECEIPT_UNRECORDED",
        explainTh: `PJ มีใบ${label} ${money(pjAmount)} บาท วันที่ ${ddmm(first.r.paidDate)} · ยังไม่ลงในระบบ${suffix(note)}`,
      });
    }
  }

  // 8) เรียง
  findings.sort((a, b) =>
    a.paidDate < b.paidDate ? -1 : a.paidDate > b.paidDate ? 1
      : a.invoiceNo < b.invoiceNo ? -1 : a.invoiceNo > b.invoiceNo ? 1
        : outcomeFor(a.pjPaymentType, a.outcome) < outcomeFor(b.pjPaymentType, b.outcome) ? -1 : 1);

  for (const f of findings) {
    if (f.outcome === "STAFF_MANUAL_OVERLAP") stats.findingsStaff++; else stats.findingsUnrecorded++;
    stats.sumAmountFlagged += f.receiptTotal;
  }
  return { findings, stats };
}

function suffix(note: ContractNote): string {
  return note === "CONTRACT_CLOSED" ? " · สัญญาปิดแล้ว ต้องตรวจมือ"
    : note === "CONTRACT_RETURNED" ? " · เครื่องคืนแล้ว ต้องตรวจมือ"
      : note === "CONTRACT_INACTIVE" ? " · สถานะสัญญาไม่ใช่ผ่อนปกติ ต้องตรวจมือ" : "";
}
