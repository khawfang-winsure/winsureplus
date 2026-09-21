// ===== กันระบบลงเงินซ้ำกับที่พนักงานลงมือไปแล้ว (pure function ล้วน — ไม่แตะ supabase) =====
// Wave 1 (แบมเขียนสเปก 21 ก.ย. 2026, คุณเตยอนุมัติวันเดียวกัน) — ทำแค่ pure function ก่อน
// UI 2 หน้า (PaymentModal ที่หน้าสัญญา + แถวในกล่องตรวจเงิน PJ) จะตามมา Wave 2 หลังน้องชีสทำ
// RPC `find_staff_payment_overlap` (migration 0162) + เพิ่ม reason 'STAFF_MANUAL_OVERLAP' และ
// field `overlapDetail` ให้ PjSyncReviewRow ใน types.ts เสร็จ
//
// pattern เดียวกับ pjReviewExplain.ts/pjReviewDup.ts — pure, inject `now` เข้ามาเสมอ (ห้าม
// new Date() ข้างในไฟล์นี้), parse วันที่ 'YYYY-MM-DD' แบบ UTC-midnight ตาม convention pj-sync
// (ดู calc.ts utcDayDiff / collectorPeriod.ts — ตั้งใจไม่ใช้ new Date(str) ตรงๆ กัน TZ drift)
//
// 3 เรื่องที่ไฟล์นี้ทำ:
//   1) classifyOverlapMatch — เทียบยอดที่พนักงานลงมือ vs ยอดใบเสร็จ PJ ว่า "น่าจะเป็นเงินก้อนเดียวกัน" แค่ไหน
//   2) buildPaymentModalWarning — แบนเนอร์เตือนในหน้าลงชำระ (PaymentModal) ก่อนพนักงานกดบันทึกซ้ำ
//   3) explainStaffOverlapRow — อธิบายแถวในกล่องตรวจเงิน PJ ที่ชนกับรายการที่พนักงานลงไว้แล้ว (reason
//      STAFF_MANUAL_OVERLAP) + ปุ่ม "เงินก้อนเดียวกัน"/"คนละก้อน" ให้เลือกผูกใบเสร็จ

import { baht, thaiDate } from './format'

// ---------------------------------------------------------------------------
// Types + ค่าคงที่ร่วม
// ---------------------------------------------------------------------------

export type OverlapMatchKind = 'exact_total' | 'exact_principal' | 'near' | 'other'

/** ยอดต่างกันไม่เกินนี้ (บาท) ถือว่า "ใกล้เคียง" (near) — ต้องตรงกับ SQL find_staff_payment_overlap (มิเกรชัน 0162) */
export const OVERLAP_NEAR_THRESHOLD_BAHT = 20

/** เทียบเฉพาะรายการที่ห่างกันไม่เกินกี่วัน (ทั้งสองทิศทาง) */
export const OVERLAP_WINDOW_DAYS = 10

/** ยอดตามใบเสร็จ PJ */
export interface PjMoneyFigure {
  principal: number
  penalty: number
}

/** ยอดที่พนักงานลงมือ — payment_log.amount (รวมค่าปรับแล้ว) + penalty_paid_amount */
export interface StaffMoneyFigure {
  amount: number
  penaltyPaid: number
}

/** จำนวนวันเต็มระหว่างวันที่สอง string (parse 10 อักษรแรกแบบ UTC-midnight เสมอ ตัด time-of-day ทิ้ง) —
 *  ⚠️ ใช้ได้เฉพาะกับ string ที่เป็น "วันที่ปฏิทิน" ที่ถูกต้องแล้วเท่านั้น (date-only 'YYYY-MM-DD' หรือ
 *  ผ่าน isoToBangkokDate() มาแล้ว) ห้ามส่ง ISO timestamp เต็ม (มี time-of-day) เข้ามาตรงๆ — จะตัด
 *  10 อักษรแรกเป็นวันที่ UTC ซึ่งคลาดเคลื่อนจากวันที่ไทยได้ถึง 1 วัน (ช่วงเที่ยงคืน–ตี 6 เวลาไทย) */
function diffDaysUtc(aISO: string, bISO: string): number {
  const [ay, am, ad] = aISO.slice(0, 10).split('-').map(Number)
  const [by, bm, bd] = bISO.slice(0, 10).split('-').map(Number)
  return Math.floor((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000)
}

/** แปลง ISO timestamp (UTC) → วันที่ปฏิทินตามเวลาไทย 'YYYY-MM-DD' — ใช้ก่อนส่งเข้า diffDaysUtc ทุกครั้งที่
 *  ค่าที่มี ต้นทางเป็น timestamptz (now ที่ inject เข้ามา, payment_log.created_at) ต่างจาก paidDate ที่เป็น
 *  date-only 'YYYY-MM-DD' อยู่แล้ว (ไม่มี time-of-day ให้เพี้ยน ใช้ตรงๆ ได้เลยไม่ต้องผ่านฟังก์ชันนี้) —
 *  pattern เดียวกับ todayISOBangkok() ใน nplHistory.ts แต่รับ ISO ใดก็ได้ ไม่ใช่แค่ "ตอนนี้" (ต้อง inject
 *  ได้ ห้าม new Date() แบบไม่มีอากิวเมนต์ในไฟล์นี้) */
function isoToBangkokDate(iso: string): string {
  return new Date(iso).toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)
}

/** วันที่ไทย dd/mm/yyyy จาก string ที่อาจเป็น 'YYYY-MM-DD' หรือ ISO timestamp เต็ม (ตัดเหลือ 10 อักษรแรกก่อน) */
function fmtDate(dateOnlyOrIso: string): string {
  return thaiDate(dateOnlyOrIso.slice(0, 10))
}

export const OVERLAP_MATCH_KIND_LABEL: Record<OverlapMatchKind, string> = {
  exact_total: 'ยอดตรงเป๊ะ',
  exact_principal: 'ค่างวดตรงเป๊ะ (ค่าปรับแยก)',
  near: 'ใกล้เคียง',
  other: 'ยอดไม่ตรง',
}

const MATCH_KIND_RANK: Record<OverlapMatchKind, number> = {
  exact_total: 0,
  exact_principal: 1,
  near: 2,
  other: 3,
}

// ---------------------------------------------------------------------------
// 1) classifyOverlapMatch — เทียบยอดพนักงานลงมือ vs ยอดใบเสร็จ PJ
// ---------------------------------------------------------------------------

/**
 * จัดระดับว่ายอดที่พนักงานลงมือ (staff) กับยอดใบเสร็จ PJ (pj) "น่าจะเป็นเงินก้อนเดียวกัน" แค่ไหน
 *  - exact_total: ยอดรวม (ค่างวด+ค่าปรับ) ตรงกันเป๊ะ
 *  - exact_principal: ค่างวดอย่างเดียวตรงกันเป๊ะ (ค่าปรับพนักงานลงแยกไว้ต่างหาก)
 *  - near: ต่างกันไม่เกิน OVERLAP_NEAR_THRESHOLD_BAHT บาท (ทั้งเทียบยอดรวมหรือเทียบเฉพาะค่างวด แล้วแต่ตัวไหนใกล้กว่า)
 *  - other: ไม่เข้าเงื่อนไขไหนเลย (หรือยอดใดยอดหนึ่ง <= 0 — ข้อมูลไม่พอเทียบ)
 */
export function classifyOverlapMatch(staff: StaffMoneyFigure, pj: PjMoneyFigure): OverlapMatchKind {
  const staffTotal = staff.amount
  const staffPrincipalOnly = Math.max(0, staff.amount - staff.penaltyPaid)
  const pjTotal = pj.principal + pj.penalty

  if (staffTotal <= 0 || pjTotal <= 0) return 'other'
  if (staffTotal === pjTotal) return 'exact_total'
  if (staffPrincipalOnly === pj.principal) return 'exact_principal'

  const nearDiff = Math.min(Math.abs(staffTotal - pjTotal), Math.abs(staffPrincipalOnly - pj.principal))
  if (nearDiff <= OVERLAP_NEAR_THRESHOLD_BAHT) return 'near'
  return 'other'
}

// ---------------------------------------------------------------------------
// 2) buildPaymentModalWarning — แบนเนอร์เตือนในหน้าลงชำระ (PaymentModal)
// ---------------------------------------------------------------------------

export type PaymentWarningLevel = 'info' | 'warn' | 'danger'

/** 1 แถว = กลุ่มใบเสร็จ PJ ที่ลงวันเดียวกัน (ยอดรวมของวันนั้น) */
export interface RecentPjMoney {
  paidDate: string // 'YYYY-MM-DD'
  principal: number
  penalty: number
  installmentNo: number | null
}

export interface PaymentModalWarning {
  level: PaymentWarningLevel
  message: string
  requireConfirm: boolean
  /** ข้อความ window.confirm ก่อนบันทึก — null เมื่อ level = 'info' (requireConfirm = false ไม่ต้องถาม) */
  confirmMessage: string | null
  /** paidDate ของรายการ PJ ที่ใช้ประกอบข้อความ — null เมื่อไม่มีรายการ PJ ที่ใกล้เคียงเลย (เตือนจาก pendingBox อย่างเดียว) */
  matchedDate: string | null
}

const LEVEL_RANK: Record<PaymentWarningLevel, number> = { info: 0, warn: 1, danger: 2 }

function higherLevel(a: PaymentWarningLevel | null, b: PaymentWarningLevel | null): PaymentWarningLevel | null {
  if (!a) return b
  if (!b) return a
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b
}

/** ข้อความ #6 — มีกล่องรอตรวจ PJ ค้างอยู่ แต่ไม่มีรายการ PJ ที่ใกล้เคียงยอด/วันที่ให้อ้างอิง */
export const STAFF_OVERLAP_PENDING_BOX_MESSAGE =
  'สัญญานี้มีรายการรอตรวจเรื่องเงินจาก PJ ค้างอยู่ — ตรวจสอบที่หน้าตรวจเงิน PJ ก่อนบันทึกเพิ่ม'

/** ข้อความ window.confirm คู่กับ STAFF_OVERLAP_PENDING_BOX_MESSAGE */
export const STAFF_OVERLAP_PENDING_BOX_CONFIRM =
  '⚠️ สัญญานี้มีรายการรอตรวจเรื่องเงินจาก PJ ค้างอยู่ (ที่หน้าตรวจเงิน PJ) แน่ใจว่าต้องการบันทึกเพิ่มหรือไม่?'

const infoText = (paidDate: string, amount: number): string =>
  `มีเงินจาก PJ เข้าสัญญานี้เมื่อ ${fmtDate(paidDate)} (${baht(amount)} ฿) — เงินที่ลูกค้าโอนผ่าน PJ ระบบลงให้เองภายใน 15 นาที ไม่ต้องลงมือ`

const warnMatchText = (total: number, paidDate: string, pjAmount: number): string =>
  `ยอดที่กำลังจะลง (${baht(total)} ฿) ใกล้เคียงกับเงินจาก PJ ที่ลงไว้แล้วเมื่อ ${fmtDate(paidDate)} (${baht(pjAmount)} ฿) — ตรวจสอบให้ชัวร์ก่อนบันทึกว่าไม่ใช่เงินก้อนเดียวกัน`

const dangerMatchText = (total: number, paidDate: string, pjAmount: number): string =>
  `ยอดที่กำลังจะลง (${baht(total)} ฿) ตรงกับเงินจาก PJ ที่ระบบลงให้แล้วเมื่อ ${fmtDate(paidDate)} เป๊ะ (${baht(pjAmount)} ฿) — น่าจะเป็นเงินก้อนเดียวกัน`

const confirmWarnText = (paidDate: string, pjAmount: number): string =>
  `⚠️ ยอดนี้ใกล้เคียงกับเงินจาก PJ ที่ลงไว้แล้วเมื่อ ${fmtDate(paidDate)} (${baht(pjAmount)} ฿) แน่ใจว่าไม่ใช่เงินก้อนเดียวกันและต้องการบันทึกหรือไม่?`

const confirmDangerText = (paidDate: string, pjAmount: number): string =>
  `⚠️ ยอดนี้ตรงกับเงินจาก PJ ที่ระบบลงให้แล้วเมื่อ ${fmtDate(paidDate)} เป๊ะ (${baht(pjAmount)} ฿) น่าจะเป็นเงินก้อนเดียวกัน แน่ใจว่าต้องการบันทึกซ้ำหรือไม่?`

/**
 * สร้างแบนเนอร์เตือนก่อนบันทึกเงินในหน้าลงชำระ — เทียบยอดที่กำลังจะกรอก (principalEntered/penaltyEntered)
 * กับรายการ PJ ล่าสุดของสัญญานี้ (recent) + กล่องรอตรวจ PJ ที่ยังค้าง (pendingBox)
 *
 * ลำดับความสำคัญของข้อความ: มีรายการ PJ ที่ยอดตรง/ใกล้เคียง (best) มาก่อนเสมอ (ต่อให้ pendingBox=true
 * ด้วยก็ยังอ้างอิงรายละเอียดของ best อยู่ — สีของแบนเนอร์ (level) ถูกยกระดับเป็น 'danger' ได้จาก pendingBox
 * แต่เนื้อข้อความยังคงอธิบายตาม best) > มีแค่ pendingBox ค้างไม่มีรายการ PJ ให้อ้างอิงเลย (ข้อความ generic #6)
 * > มีรายการ PJ ในช่วงเวลาใกล้กันแต่ยอดไม่เข้าเกณฑ์ match ใดๆ (แค่แจ้งเป็นข้อมูล 'info' เฉยๆ)
 *
 * @param now ISO timestamp "ตอนนี้" ต้อง inject เข้ามา (ห้ามใช้ new Date() ในไฟล์นี้)
 * @returns null = ไม่ต้องเตือน (ยังไม่ได้กรอกเงินเลย หรือไม่มีอะไรน่าสงสัยเลย)
 */
export function buildPaymentModalWarning(
  recent: RecentPjMoney[],
  pendingBox: boolean,
  principalEntered: number,
  penaltyEntered: number,
  now: string,
): PaymentModalWarning | null {
  // now เป็น ISO timestamp เต็ม (มี time-of-day) ต้องแปลงเป็นวันที่ปฏิทินไทยก่อนเทียบกับ paidDate
  // (date-only) เสมอ — ไม่งั้นช่วงเที่ยงคืน–ตี 6 เวลาไทยจะนับวันผิด 1 วัน (YELLOW 2, ติ๊ก review)
  const nowBangkok = isoToBangkokDate(now)
  const windowed = recent.filter((r) => Math.abs(diffDaysUtc(nowBangkok, r.paidDate)) <= OVERLAP_WINDOW_DAYS)

  if (principalEntered <= 0 && penaltyEntered <= 0) return null

  const staff: StaffMoneyFigure = { amount: principalEntered + penaltyEntered, penaltyPaid: penaltyEntered }

  interface Scored {
    row: RecentPjMoney
    kind: OverlapMatchKind
  }
  const scored: Scored[] = windowed.map((row) => ({
    row,
    kind: classifyOverlapMatch(staff, { principal: row.principal, penalty: row.penalty }),
  }))
  const matchable = scored.filter((s) => s.kind !== 'other')
  matchable.sort((a, b) => {
    const rd = MATCH_KIND_RANK[a.kind] - MATCH_KIND_RANK[b.kind]
    if (rd !== 0) return rd
    return Math.abs(diffDaysUtc(nowBangkok, a.row.paidDate)) - Math.abs(diffDaysUtc(nowBangkok, b.row.paidDate))
  })
  const best = matchable[0] ?? null

  const matchLevel: PaymentWarningLevel | null = best
    ? best.kind === 'near'
      ? 'warn'
      : 'danger'
    : windowed.length > 0
      ? 'info'
      : null
  const pendingBoxLevel: PaymentWarningLevel | null = pendingBox ? 'danger' : null
  const level = higherLevel(matchLevel, pendingBoxLevel)
  if (!level) return null

  const requireConfirm = level !== 'info'
  const total = staff.amount

  if (best) {
    const pjAmount = best.row.principal + best.row.penalty
    const isNear = best.kind === 'near'
    return {
      level,
      message: isNear ? warnMatchText(total, best.row.paidDate, pjAmount) : dangerMatchText(total, best.row.paidDate, pjAmount),
      requireConfirm,
      confirmMessage: isNear ? confirmWarnText(best.row.paidDate, pjAmount) : confirmDangerText(best.row.paidDate, pjAmount),
      matchedDate: best.row.paidDate,
    }
  }

  if (pendingBox) {
    return {
      level,
      message: STAFF_OVERLAP_PENDING_BOX_MESSAGE,
      requireConfirm,
      confirmMessage: STAFF_OVERLAP_PENDING_BOX_CONFIRM,
      matchedDate: null,
    }
  }

  // เหลือกรณีเดียว: matchLevel === 'info' (windowed มีอย่างน้อย 1 แถว แต่ไม่มีตัวไหน match เข้าเกณฑ์เลย)
  const nearest = [...windowed].sort(
    (a, b) => Math.abs(diffDaysUtc(nowBangkok, a.paidDate)) - Math.abs(diffDaysUtc(nowBangkok, b.paidDate)),
  )[0]
  return {
    level,
    message: infoText(nearest.paidDate, nearest.principal + nearest.penalty),
    requireConfirm,
    confirmMessage: null,
    matchedDate: nearest.paidDate,
  }
}

// ---------------------------------------------------------------------------
// 3) explainStaffOverlapRow — แถวในกล่องตรวจเงิน PJ ที่ชนกับรายการที่พนักงานลงไว้แล้ว
// ---------------------------------------------------------------------------

/** ตัวเลือกผูก 1 รายการที่พนักงานเคยลงไว้ — matchKind เชื่อจากที่ backend คำนวณส่งมา ไม่ recompute ในนี้ */
export interface PjStaffOverlapCandidate {
  paymentLogId: string
  createdAt: string // ISO
  byName: string
  amount: number
  penaltyPaidAmount: number
  installmentNo: number | null
  /** เหลือผูกได้อีกกี่บาท (0 = ผูกกับใบเสร็จอื่นไปแล้วเต็มยอด เลือกไม่ได้) */
  capacityLeft: number
  matchKind: OverlapMatchKind
}

export interface PjStaffOverlapDetail {
  candidates: PjStaffOverlapCandidate[]
}

export interface PjStaffOverlapCandidateLine {
  candidate: PjStaffOverlapCandidate
  label: string
  /** capacityLeft <= 0 — เลือกผูกไม่ได้แล้ว (ใช้ปิดปุ่ม/ทำจาง ไม่ต้องเอาออกจากลิสต์ ให้เห็นบริบทครบ) */
  disabled: boolean
  /** 0 < capacityLeft < ยอดใบเสร็จ PJ นี้ — ผูกได้แต่เตือนว่าเหลือไม่พอเต็มยอด */
  caution: boolean
}

export interface PjStaffOverlapExplain {
  headline: string
  candidateLines: PjStaffOverlapCandidateLine[]
  /** paymentLogId ของตัวเลือกที่แนะนำให้ผูก — null = ไม่มีตัวไหนแนะนำได้ */
  recommendedCandidateId: string | null
  primaryButtonHint: 'bind' | 'separate'
}

/** input แบบ structural ของ PjSyncReviewRow — types.ts ยังไม่มี reason 'STAFF_MANUAL_OVERLAP' /
 *  field overlapDetail (น้องชีสเพิ่มรอบ Wave 2) เลี่ยง breaking change ไปก่อนด้วยชนิดนี้แทน */
export interface PjStaffOverlapRowLike {
  reason: string
  amount: number // pj principal
  penaltyAmount: number // pj penalty
  paidDate: string | null
  overlapDetail?: PjStaffOverlapDetail | null
}

/** ป้ายเหตุผล #1 — ใช้คู่กับ REASON_LABEL/REASON_TONE ที่มีอยู่แล้วในหน้ากล่องตรวจเงิน PJ */
export const STAFF_OVERLAP_REASON_TEXT = 'พนักงานลงเงินไว้แล้ว'
export const STAFF_OVERLAP_REASON_TONE = 'red' as const

/** ปุ่ม #2 — reason นี้ซ่อนปุ่ม "ข้าม"/"ทำเสร็จแล้ว"/"รายได้อื่นๆ" ของเดิม ใช้ 3 ปุ่มนี้แทน */
export const STAFF_OVERLAP_ACTION_LABELS = {
  bind: { label: 'เงินก้อนเดียวกัน', caption: 'ผูกใบเสร็จกับรายการที่พนักงานลงไว้ — ไม่ลงเงินเพิ่ม' },
  separate: { label: 'คนละก้อน', caption: 'ลงเพิ่มตามปกติ' },
  openInPj: 'เปิดใน PJ',
} as const

const STAFF_OVERLAP_FALLBACK_HEADLINE = 'ยอดรอตรวจสอบ'

/** #7 — เคยพบตัวที่น่าจะผูกได้ แต่ตอนคำนวณจริง (capacityLeft ทุกตัว = 0) หาที่ผูกไม่เจอแล้ว */
const STAFF_OVERLAP_NO_CANDIDATE_HEADLINE =
  'ระบบเคยพบรายการที่พนักงานลงไว้ใกล้เคียงกัน แต่ตอนนี้หาที่ผูกไม่เจอแล้ว (อาจถูกผูกกับใบอื่นไปก่อนหน้า) — ตรวจสอบประวัติการชำระของสัญญานี้ก่อนลงเงินเพิ่ม'

function candidateLabel(c: PjStaffOverlapCandidate, pjTotal: number): string {
  let label = `${fmtDate(c.createdAt)} · ${c.byName} · ${baht(c.amount)} ฿ · งวดที่ ${c.installmentNo ?? '-'} · ${OVERLAP_MATCH_KIND_LABEL[c.matchKind]}`
  if (c.capacityLeft <= 0) {
    label += ' (ผูกกับใบเสร็จอื่นไปแล้ว)'
  } else if (c.capacityLeft < pjTotal) {
    label += ` — เหลือผูกได้ ${baht(c.capacityLeft)} ฿ น้อยกว่ายอดใบนี้ ${baht(pjTotal)} ฿ ตรวจสอบก่อนผูก`
  }
  return label
}

// #3/#4/#5/(other) — headline อธิบายว่าทำไมถึงคิดว่าเป็นเงินก้อนเดียวกัน (หรือไม่ใช่) ของตัวที่แนะนำ (top)
const headlineExactTotal = (byName: string, amount: number, createdAt: string, pjTotal: number): string =>
  `พนักงาน ${byName} ลงรับชำระ ${baht(amount)} ฿ เมื่อ ${fmtDate(createdAt)} ตรงกับใบเสร็จ PJ นี้เป๊ะ (${baht(pjTotal)} ฿) — น่าจะเป็นเงินก้อนเดียวกัน`

const headlineExactPrincipal = (
  byName: string,
  amount: number,
  penaltyPaidAmount: number,
  createdAt: string,
  pjPrincipal: number,
): string => {
  const principalOnly = Math.max(0, amount - penaltyPaidAmount)
  return `พนักงาน ${byName} ลงรับชำระ ${baht(amount)} ฿ (ค่างวด ${baht(principalOnly)} + ค่าปรับ ${baht(penaltyPaidAmount)}) เมื่อ ${fmtDate(createdAt)} — ค่างวดตรงกับใบเสร็จ PJ นี้เป๊ะ (${baht(pjPrincipal)} ฿) ค่าปรับลงแยกไว้แล้ว น่าจะเป็นเงินก้อนเดียวกัน`
}

const headlineNear = (
  byName: string,
  amount: number,
  penaltyPaidAmount: number,
  createdAt: string,
  pjPrincipal: number,
  pjTotal: number,
): string => {
  const staffPrincipalOnly = Math.max(0, amount - penaltyPaidAmount)
  const diff = Math.min(Math.abs(amount - pjTotal), Math.abs(staffPrincipalOnly - pjPrincipal))
  return `พนักงาน ${byName} ลงรับชำระ ${baht(amount)} ฿ เมื่อ ${fmtDate(createdAt)} ใกล้เคียงกับใบเสร็จ PJ นี้ (${baht(pjTotal)} ฿ ต่างกัน ${baht(diff)} ฿) — ตรวจสอบให้ชัวร์ก่อนว่าเป็นเงินก้อนเดียวกันหรือคนละก้อน`
}

const headlineOther = (byName: string, amount: number, createdAt: string, pjTotal: number): string =>
  `พนักงาน ${byName} ลงรับชำระ ${baht(amount)} ฿ เมื่อ ${fmtDate(createdAt)} ช่วงใกล้กับใบเสร็จ PJ นี้ (${baht(pjTotal)} ฿) แต่ยอดไม่ตรง — น่าจะคนละก้อน ตรวจสอบก่อนลงเพิ่ม`

/**
 * อธิบายแถวในกล่องตรวจเงิน PJ ที่เป็น reason 'STAFF_MANUAL_OVERLAP' — สรุปว่ามีรายการที่พนักงานเคยลง
 * ไว้เองที่ "น่าจะ" เป็นเงินก้อนเดียวกับใบเสร็จ PJ ใบนี้ไหม แนะนำตัวที่ควรผูก + สร้างลิสต์ตัวเลือกให้เลือกเอง
 *
 * @param row แถวในกล่องตรวจเงิน PJ (แบบ structural — ดู PjStaffOverlapRowLike)
 * @returns fallback {headline:'ยอดรอตรวจสอบ', ...} เสมอถ้า row.reason ไม่ใช่ 'STAFF_MANUAL_OVERLAP' (ไม่ throw)
 */
export function explainStaffOverlapRow(row: PjStaffOverlapRowLike): PjStaffOverlapExplain {
  if (row.reason !== 'STAFF_MANUAL_OVERLAP') {
    return {
      headline: STAFF_OVERLAP_FALLBACK_HEADLINE,
      candidateLines: [],
      recommendedCandidateId: null,
      primaryButtonHint: 'separate',
    }
  }

  const pjPrincipal = row.amount
  const pjPenalty = row.penaltyAmount
  const pjTotal = pjPrincipal + pjPenalty
  const candidates = row.overlapDetail?.candidates ?? []
  const paidDate = row.paidDate

  // createdAt เป็น ISO timestamptz เต็ม (payment_log.created_at) ต้องแปลงเป็นวันที่ไทยก่อนเทียบกับ
  // paidDate (date-only) เหมือนกับ nowBangkok ใน buildPaymentModalWarning ด้านบน
  const dayDiffFromRow = (createdAt: string): number =>
    paidDate ? Math.abs(diffDaysUtc(paidDate, isoToBangkokDate(createdAt))) : 0

  const sorted = [...candidates].sort((a, b) => {
    const rd = MATCH_KIND_RANK[a.matchKind] - MATCH_KIND_RANK[b.matchKind]
    if (rd !== 0) return rd
    const dd = dayDiffFromRow(a.createdAt) - dayDiffFromRow(b.createdAt)
    if (dd !== 0) return dd
    const ia = a.installmentNo ?? Number.POSITIVE_INFINITY
    const ib = b.installmentNo ?? Number.POSITIVE_INFINITY
    if (ia !== ib) return ia - ib
    return a.paymentLogId.localeCompare(b.paymentLogId)
  })

  const candidateLines: PjStaffOverlapCandidateLine[] = sorted.map((c) => ({
    candidate: c,
    label: candidateLabel(c, pjTotal),
    disabled: c.capacityLeft <= 0,
    caution: c.capacityLeft > 0 && c.capacityLeft < pjTotal,
  }))

  const active = sorted.filter((c) => c.capacityLeft > 0)
  if (active.length === 0) {
    return {
      headline: STAFF_OVERLAP_NO_CANDIDATE_HEADLINE,
      candidateLines,
      recommendedCandidateId: null,
      primaryButtonHint: 'separate',
    }
  }

  const top = active[0]
  const isExact = top.matchKind === 'exact_total' || top.matchKind === 'exact_principal'

  let headline: string
  if (top.matchKind === 'exact_total') {
    headline = headlineExactTotal(top.byName, top.amount, top.createdAt, pjTotal)
    const exactTotalCount = active.filter((c) => c.matchKind === 'exact_total').length
    if (exactTotalCount > 1) headline += ` (พบ ${exactTotalCount} รายการที่ยอดตรงเป๊ะ)`
  } else if (top.matchKind === 'exact_principal') {
    headline = headlineExactPrincipal(top.byName, top.amount, top.penaltyPaidAmount, top.createdAt, pjPrincipal)
  } else if (top.matchKind === 'near') {
    headline = headlineNear(top.byName, top.amount, top.penaltyPaidAmount, top.createdAt, pjPrincipal, pjTotal)
  } else {
    headline = headlineOther(top.byName, top.amount, top.createdAt, pjTotal)
  }

  return {
    headline,
    candidateLines,
    recommendedCandidateId: top.paymentLogId,
    primaryButtonHint: isExact ? 'bind' : 'separate',
  }
}

// ---------------------------------------------------------------------------
// #9 — modal ยืนยันผูกใบเสร็จ PJ นี้กับรายการที่พนักงานลงไว้ (ปุ่ม "เงินก้อนเดียวกัน")
// ---------------------------------------------------------------------------

export interface PjStaffOverlapBindConfirm {
  title: string
  body: string
  confirmLabel: string
  cancelLabel: string
}

/**
 * สร้างข้อความ modal ยืนยันก่อนผูกใบเสร็จ PJ เข้ากับรายการที่พนักงานลงไว้แล้ว (candidate ที่เลือก)
 * @param candidateCreatedAt ISO timestamp ตอนพนักงานลงรายการนั้น
 */
export function buildStaffOverlapBindConfirm(
  byName: string,
  candidateCreatedAt: string,
  candidateAmount: number,
  pjTotal: number,
): PjStaffOverlapBindConfirm {
  return {
    title: 'ยืนยันผูกใบเสร็จนี้กับรายการที่พนักงานลงไว้',
    body: `ผูกใบเสร็จ PJ นี้ (${baht(pjTotal)} ฿) กับรายการที่ ${byName} ลงไว้เมื่อ ${fmtDate(candidateCreatedAt)} (${baht(candidateAmount)} ฿)? ระบบจะไม่ลงเงินเพิ่มให้สัญญานี้จากใบเสร็จนี้อีก — ใช้เมื่อมั่นใจว่าเป็นเงินก้อนเดียวกันเท่านั้น`,
    confirmLabel: 'ยืนยันผูก',
    cancelLabel: 'ยกเลิก',
  }
}
