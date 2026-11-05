// กติกากล่องรอตรวจ PJ แบบ pure function (ไม่แตะ DB / ไม่ import อะไรเลย) — ใช้ใน index.ts และเทสต์ใน scripts/pjReviewDedup.test.ts
//
// ปัญหาเดิม (5 พ.ย. 2026): "seen" dedup ท้าย index.ts เทียบแค่เลข invoice กับแถว pending → ใบเสร็จใหม่ของ invoice
// เดียวกันที่เกิดระหว่างที่แถว pending เก่ายังค้าง ถูกทิ้งเงียบ (และถ้า pending ค้างเกินหน้าต่างสแกน = หลุดถาวร)
// แก้: เทียบรายใบด้วย uuid —
//   - ใบที่อยู่ใน pending เดิมแล้ว  → ไม่สร้างซ้ำ (กันแถวบวม 96 รอบ/วัน)
//   - ใบใหม่                         → สร้างแถวใหม่ที่มี "เฉพาะใบใหม่" (ยอด + รายการ) ไม่รวมใบที่ค้างอยู่
// แถวใหม่ใช้ raw_json shape เดียวกับ RECEIPT_PARTIAL_APPLIED ({unapplied_receipts, ...}) ซึ่งหน้าเว็บ
// (db.ts extractPjPendingReceipts) อ่านเฉพาะ unapplied_receipts ตอนลงเงิน/บวกค่าปรับ/ส่ง uuid → กันลงซ้ำใบเดิม

export type ReceiptCategory = "installment" | "penalty" | "other";

export interface ReceiptItem {
  uuid: string;
  amount: number;
  paymentType: ReceiptCategory;
}

export interface GroupLike {
  invoice_no: string;
  paid_date: string | null;
  receipts: ReceiptItem[];
  raw: any[];
}

export interface ReviewRowLike {
  pj_invoice_no: string;
  pj_payment_type: string | null;
  pj_amount: number;
  reason?: string;
  raw_json: any;
  [k: string]: unknown;
}

function str(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/,/g, "").replace(/[^\d.-]/g, "").trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// ประเภทของใบดิบ PJ → หมวด (ตรงกับ receiptPaymentType.ts; down ไม่ควรมาถึงที่นี่ ถือเป็น other กันเหนียว)
function categoryOfRaw(v: unknown): ReceiptCategory {
  const t = String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (t === "ค่าปรับ" || t === "penalty") return "penalty";
  if (t === "ค่างวด" || t === "installment") return "installment";
  return "other";
}

function isPlainObject(x: unknown): x is Record<string, any> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

/** uuid ที่ "รอคนตัดสินใจ" ของแถว pending — null = อ่านไม่ได้ (shape แปลก/แถวไม่มี uuid → ต้องถือว่าทึบ) */
export function pendingUuidsOfRawJson(raw: unknown): string[] | null {
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const r of raw) {
      const u = str(r?.uuid);
      if (u) out.push(u);
    }
    return out.length > 0 ? out : null;
  }
  if (isPlainObject(raw)) {
    if (Array.isArray(raw.unapplied_receipts)) {
      // shape RECEIPT_PARTIAL_APPLIED / แถวแยกใบใหม่ — นับเฉพาะ unapplied (already_applied ลง pj_applied_receipts แล้ว)
      const out: string[] = [];
      for (const r of raw.unapplied_receipts) {
        const u = str(r?.uuid);
        if (u) out.push(u);
      }
      return out.length > 0 ? out : null;
    }
    if (Array.isArray(raw.receiptUuids)) { // returned_watch
      const out = raw.receiptUuids.map(str).filter((x: string | null): x is string => !!x);
      return out.length > 0 ? out : null;
    }
  }
  return null;
}

/** uuid ทุกใบที่เคยปรากฏในแถว (ใช้กับแถว resolved/skipped/auto_resolved ที่คนจัดการแล้ว) — รวมทุก shape */
export function allUuidsOfRawJson(raw: unknown): string[] {
  const out = new Set<string>();
  const add = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const r of arr) {
      const u = str(r?.uuid);
      if (u) out.add(u);
    }
  };
  if (Array.isArray(raw)) add(raw);
  else if (isPlainObject(raw)) {
    add(raw.unapplied_receipts);
    add(raw.already_applied_receipts);
    add(raw.raw);
    if (Array.isArray(raw.receiptUuids)) for (const u of raw.receiptUuids) { const s = str(u); if (s) out.add(s); }
  }
  return Array.from(out);
}

/** ใบที่ "ต้องตัดสินใจ" ของแถวที่กำลังจะ insert (array ดิบ หรือ shape unapplied_receipts) — null = แยกรายใบไม่ได้ */
export function receiptsOfReviewRow(raw: unknown): ReceiptItem[] | null {
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    const out: ReceiptItem[] = [];
    for (const r of raw) {
      const u = str(r?.uuid);
      if (!u) return null; // มีใบไม่มี uuid ปน → แยกไม่ได้ ใช้พฤติกรรมเดิม
      out.push({ uuid: u, amount: num(r?.amount ?? r?.paid_amount ?? r?.total), paymentType: categoryOfRaw(r?.payment_type ?? r?.type) });
    }
    return out;
  }
  if (isPlainObject(raw) && Array.isArray(raw.unapplied_receipts) && raw.unapplied_receipts.length > 0) {
    const out: ReceiptItem[] = [];
    for (const r of raw.unapplied_receipts) {
      const u = str(r?.uuid);
      if (!u) return null;
      out.push({ uuid: u, amount: num(r?.amount), paymentType: categoryOfRaw(r?.paymentType) });
    }
    return out;
  }
  return null;
}

export interface PendingInvoiceInfo {
  uuids: Set<string>;
  opaque: boolean; // มีแถว pending ที่อ่าน uuid ไม่ได้ → ใช้พฤติกรรมเดิม (ทิ้งทั้ง invoice) เพื่อไม่เสี่ยงเบิ้ล
}

export function buildPendingIndex(
  pendingRows: { pj_invoice_no: string; raw_json: unknown }[],
): Map<string, PendingInvoiceInfo> {
  const idx = new Map<string, PendingInvoiceInfo>();
  for (const p of pendingRows) {
    let info = idx.get(p.pj_invoice_no);
    if (!info) { info = { uuids: new Set(), opaque: false }; idx.set(p.pj_invoice_no, info); }
    const us = pendingUuidsOfRawJson(p.raw_json);
    if (!us) info.opaque = true;
    else for (const u of us) info.uuids.add(u);
  }
  return idx;
}

export function sumByCategory(rs: ReceiptItem[]): Record<ReceiptCategory, number> {
  const t: Record<ReceiptCategory, number> = { installment: 0, penalty: 0, other: 0 };
  for (const r of rs) t[r.paymentType] += r.amount;
  return t;
}

/** สร้าง (ประเภท, ยอด, raw_json) ของแถวที่มีเฉพาะใบใหม่ — convention เดียวกับ RECEIPT_PARTIAL_APPLIED:
 *  คง preferredType ถ้ายอดหมวดนั้น > 0 ไม่งั้น installment > penalty > other */
export function buildSubsetReview(
  group: GroupLike,
  newOnes: ReceiptItem[],
  preferredType: string | null,
  extra: Record<string, unknown> = {},
  alreadyApplied: ReceiptItem[] = [],
): { pjType: ReceiptCategory; pjAmount: number; rawJson: Record<string, unknown> } {
  const totals = sumByCategory(newOnes);
  const pref = preferredType === "installment" || preferredType === "penalty" || preferredType === "other" ? preferredType : null;
  const pjType: ReceiptCategory =
    pref && totals[pref] > 0 ? pref
      : totals.installment > 0 ? "installment"
        : totals.penalty > 0 ? "penalty"
          : "other";
  const keep = new Set(newOnes.map((r) => r.uuid));
  return {
    pjType,
    pjAmount: totals[pjType],
    rawJson: {
      invoice_no: group.invoice_no,
      paid_date: group.paid_date,
      already_applied_receipts: alreadyApplied,
      unapplied_receipts: newOnes,
      unapplied_totals: totals,
      raw: group.raw.filter((r) => { const u = str(r?.uuid); return !!u && keep.has(u); }),
      ...extra,
    },
  };
}

export interface FilterResult {
  insert: any[];
  droppedDuplicate: number; // ทุกใบอยู่ใน pending เดิมแล้ว (หรือเข้าโหมดเดิมแล้วทิ้ง)
  split: number;            // แถวที่ตัดเหลือเฉพาะใบใหม่
}

/** แทน "seen.has(invoice)" เดิม — กรองรายใบ (ดูหัวไฟล์) */
export function filterFreshReviewRows(rows: ReviewRowLike[], idx: Map<string, PendingInvoiceInfo>): FilterResult {
  const insert: any[] = [];
  let droppedDuplicate = 0;
  let split = 0;
  for (const row of rows) {
    const info = idx.get(row.pj_invoice_no);
    if (!info) { insert.push(row); continue; }
    // STAFF_MANUAL_OVERLAP ห้ามแยกแถว (link_pj_review_to_payment_log ต้องการ raw_json array + overlap_detail ทั้งก้อน) -> ทิ้งแบบเดิม
    if (row.reason === "STAFF_MANUAL_OVERLAP") { droppedDuplicate++; continue; }
    if (info.opaque) { droppedDuplicate++; continue; } // พฤติกรรมเดิม
    const receipts = receiptsOfReviewRow(row.raw_json);
    if (!receipts) { droppedDuplicate++; continue; }   // ไม่มี uuid (ก่อน DEDUP_CUTOFF) → พฤติกรรมเดิม
    const newOnes = receipts.filter((r) => !info.uuids.has(r.uuid));
    if (newOnes.length === 0) { droppedDuplicate++; continue; }
    if (newOnes.length === receipts.length) { insert.push(row); continue; }
    const rj = row.raw_json;
    const group: GroupLike = {
      invoice_no: row.pj_invoice_no,
      paid_date: isPlainObject(rj) ? (rj.paid_date ?? (row as any).pj_paid_date ?? null) : ((row as any).pj_paid_date ?? null),
      receipts,
      raw: Array.isArray(rj) ? rj : (isPlainObject(rj) && Array.isArray(rj.raw) ? rj.raw : []),
    };
    const held = receipts.filter((r) => info.uuids.has(r.uuid)).map((r) => r.uuid);
    const alreadyApplied = isPlainObject(rj) && Array.isArray(rj.already_applied_receipts) ? rj.already_applied_receipts : [];
    const sub = buildSubsetReview(group, newOnes, row.pj_payment_type, { held_in_pending_uuids: held }, alreadyApplied);
    insert.push({ ...row, pj_payment_type: sub.pjType, pj_amount: sub.pjAmount, raw_json: sub.rawJson });
    split++;
  }
  return { insert, droppedDuplicate, split };
}

/** ข้อ ข. — ก้อนไม่มีค่างวด (ค่าปรับล้วน/อื่นๆ) ที่วันที่ >= DEDUP_CUTOFF และทุกใบมี uuid:
 *  คืนใบที่ "ยังไม่เคยจัดการ" (ไม่อยู่ใน pj_applied_receipts และไม่อยู่ในแถว resolved/skipped/auto_resolved)
 *  คืน null = ใช้พฤติกรรมเดิม (ก่อน cutoff / ไม่มี uuid / มีใบไม่มี uuid ปน) */
export function unhandledReceiptsForGroup(
  group: GroupLike,
  dedupCutoff: string,
  appliedUuids: Set<string>,
  handledUuids: Set<string>,
): ReceiptItem[] | null {
  if (!group.paid_date || group.paid_date < dedupCutoff) return null;
  if (group.receipts.length === 0 || group.receipts.length !== group.raw.length) return null;
  return group.receipts.filter((r) => !appliedUuids.has(r.uuid) && !handledUuids.has(r.uuid));
}

/** แถวที่จัดการแล้ว (resolved/skipped/auto_resolved) ของ invoice + pj_paid_date เดียวกันที่ "อ่าน uuid ไม่ได้" (เช่น PLAN_CHANGE_*)
 *  -> ถือว่าก้อนนี้จัดการแล้ว (fallback natural key เดิม) */
export function hasOpaqueHandledRow(rows: { pj_paid_date: string | null; raw_json: unknown }[], paidDate: string | null): boolean {
  return rows.some((r) => (r.pj_paid_date ?? null) === (paidDate ?? null) && allUuidsOfRawJson(r.raw_json).length === 0);
}

/** ledger (contract+วัน) บอกแค่ยอดรวมที่ลงไปแล้ว ไม่มี uuid: ตัดใบ (ค่างวด/ค่าปรับ) ที่ยอดรวมเท่ากับ ledger ออกว่าจัดการแล้ว
 *  - ledger ครอบทั้งหมด (ledger >= ยอดรวม) -> ว่าง
 *  - มีชุดย่อยที่ยอดรวม = ledger พอดี -> ตัดชุดนั้น เหลือใบที่เหลือ (ใบใหม่)
 *  - จับคู่ไม่ได้ -> คืนทั้งหมด (ไม่กลืนใบใหม่; คนเห็นและตัดสินใจ) ใบ "อื่นๆ" ไม่เคยอยู่ใน ledger จึงไม่ถูกตัด */
export function removeLedgerCovered(rs: ReceiptItem[], ledgerTotal: number): ReceiptItem[] {
  if (!(ledgerTotal > 0.005)) return rs;
  const idxs = rs.map((r, i) => i).filter((i) => rs[i].paymentType !== "other");
  const total = idxs.reduce((s, i) => s + rs[i].amount, 0);
  const drop = new Set<number>();
  if (ledgerTotal + 0.01 >= total) idxs.forEach((i) => drop.add(i));
  else if (idxs.length <= 15) {
    for (let m = 1; m < (1 << idxs.length); m++) {
      let sum = 0;
      for (let b = 0; b < idxs.length; b++) if (m & (1 << b)) sum += rs[idxs[b]].amount;
      if (Math.abs(sum - ledgerTotal) <= 0.01) { for (let b = 0; b < idxs.length; b++) if (m & (1 << b)) drop.add(idxs[b]); break; }
    }
  }
  return rs.filter((_, i) => !drop.has(i));
}

/** แถวจัดการแล้วที่อ่าน uuid ไม่ได้ (PLAN_CHANGE_* ฯลฯ) เกี่ยวกับค่าธรรมเนียม "อื่นๆ" เท่านั้น: ตัดเฉพาะใบ other ออก
 *  ใบค่าปรับ/ค่างวดใหม่ไม่ถูกกลืน (ก้อนมีแต่ other = ข้ามหมดเหมือนเดิม) */
export function applyOpaqueHandled(
  unhandled: ReceiptItem[],
  handledRows: { pj_paid_date: string | null; raw_json: unknown }[],
  paidDate: string | null,
): ReceiptItem[] {
  if (unhandled.length === 0 || !hasOpaqueHandledRow(handledRows, paidDate)) return unhandled;
  return unhandled.filter((r) => r.paymentType !== "other");
}

/** ใช้ ledger กับใบที่ uuid ยังอธิบายไม่ได้: หักยอดใบของก้อนที่อธิบายด้วย uuid แล้ว (applied/handled) ออกจาก ledger ก่อน
 *  แล้วเอาส่วนที่เหลือไป removeLedgerCovered (ledger 700 + ใบเก่า 700 มี uuid -> เหลือ 0 ไม่ครอบใบใหม่ 100) */
export function unhandledAfterLedger(
  receipts: ReceiptItem[],
  appliedUuids: Set<string>,
  handledUuids: Set<string>,
  ledgerTotal: number,
): ReceiptItem[] {
  const explained = receipts.filter((r) => appliedUuids.has(r.uuid) || handledUuids.has(r.uuid));
  const unexplained = receipts.filter((r) => !appliedUuids.has(r.uuid) && !handledUuids.has(r.uuid));
  const explainedSum = explained.filter((r) => r.paymentType !== "other").reduce((s, r) => s + r.amount, 0);
  const remaining = Math.max(0, ledgerTotal - explainedSum);
  return removeLedgerCovered(unexplained, remaining);
}

// ══════════════════════════════════════════════════════════════════════════════════════
// (5 พ.ย. 2026) รอบย้อนหลัง pj-sync ชนงบเวลา 45 วิ — เวลาหมดไปกับ query ต่อกลุ่ม (contracts + installments +
// pj_applied_receipts ≈ 3 รอบ/กลุ่ม ≈ 85ms) ทั้งที่กลุ่มส่วนใหญ่ (~98%) ลงครบแล้ว → ข้ามได้ทันทีถ้ารู้ล่วงหน้า
// ฟังก์ชันด้านล่างเป็น pure (ไม่แตะ DB) ใช้โหลดล่วงหน้าแบบ batch + ตัดกลุ่มที่ลงครบแล้ว + เรียงเก่าก่อน
// ══════════════════════════════════════════════════════════════════════════════════════

/** แบ่งรายการเป็นก้อนละไม่เกิน size (กันเพดาน 1000 แถวของ PostgREST + ความยาว URL ของ .in(...)) */
export function chunkArray<T>(items: T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** ตัดซ้ำ + ตัดค่าว่าง คงลำดับแรกที่เจอ */
export function uniqueNonEmpty(values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const v of values) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s !== "") seen.add(s);
  }
  return Array.from(seen);
}

export interface FastSkipGroup {
  has_installment: boolean;
  has_other: boolean;
  paid_date: string | null;
  receipts: ReceiptItem[];
  raw: any[];
}

/**
 * กลุ่มนี้ "ลงครบทุกใบแล้ว" และ gate เดิมของ loop จะจบด้วย skippedAlreadySynced แน่ๆ ไหม (true = ข้ามได้เลยไม่ต้อง query)
 * เป็น fast-path แบบ "ยืนยันเชิงบวกเท่านั้น": false = ปล่อยให้ loop เดิมทำงานเต็มเหมือนเดิมทุกประการ
 *  - appliedUuids = uuid ที่รู้ล่วงหน้าว่าอยู่ใน pj_applied_receipts (ตาราง append-only → ข้อมูลเก่าไม่ทำให้ผิดทิศ;
 *    ลงใหม่ระหว่างรอบ = ไม่อยู่ใน set = false = เดินทางเดิม จึงไม่ต้องอัปเดต cache หลัง apply)
 *  - contractStatuses = status ของสัญญาทุกแถวที่ inv_no ตรง (undefined = โหลดไม่สำเร็จ/ไม่ได้โหลด → false)
 * กลุ่ม mixed (ค่างวด + อื่นๆ) ไม่เคยผ่าน uuid dedup → false เสมอ
 * กลุ่มค่างวดล้วน: gate เดิม "contracts ต้องเจอตัวเดียว" มาก่อน alreadyAppliedByUuid และ alreadyAppliedByUuid มาก่อน closed
 * กลุ่มไม่มีค่างวด (ค่าปรับ/อื่นๆ ล้วน): gate closed มาก่อน uuid-level → ข้ามเฉพาะเมื่อไม่มีสัญญา closed เลย
 */
export function isFullyAppliedGroup(
  g: FastSkipGroup,
  syncIsoDate: string | null,
  dedupCutoff: string,
  appliedUuids: Set<string>,
  contractStatuses: (string | null)[] | undefined,
): boolean {
  if (!contractStatuses) return false;
  if (g.receipts.length === 0) return false;
  if (!g.receipts.every((r) => appliedUuids.has(r.uuid))) return false;
  if (!g.has_installment) {
    if (!g.paid_date || g.paid_date < dedupCutoff) return false;
    if (g.receipts.length !== g.raw.length) return false;
    return !contractStatuses.some((s) => s === "closed");
  }
  if (g.has_other) return false;
  const target = g.paid_date ?? syncIsoDate;
  if (!target || target < dedupCutoff) return false;
  return contractStatuses.length === 1;
}

/** เรียงเก่าก่อน (paid_date น้อย→มาก, ไม่มีวันที่ไว้ท้าย) คงลำดับเดิมในวันเดียวกัน (stable) ไม่แก้ array เดิม */
export function orderGroupsOldestFirst<T extends { paid_date: string | null }>(groups: T[]): T[] {
  return groups
    .map((g, i) => ({ g, i }))
    .sort((x, y) => {
      const a = x.g.paid_date, b = y.g.paid_date;
      if (a === b) return x.i - y.i;
      if (a == null) return 1;
      if (b == null) return -1;
      return a < b ? -1 : 1;
    })
    .map((x) => x.g);
}
