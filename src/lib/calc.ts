// ===== สูตรคำนวณหลักของธุรกิจ (ทดสอบกับเคสตัวอย่างในสรุปข้อมูล.txt) =====
import { baht } from './format'

export interface SummaryBreakdown {
  afterDown: number // ยอดตัวเครื่องจริงหลังหักดาวน์
  commission: number // ค่าคอมมิชชั่น
  docFee: number // ค่าเอกสาร (หักออก)
  net: number // สุทธิ (ยอดที่โอนให้ร้านต่อเครื่อง)
}

/**
 * คำนวณยอดสรุปโอนให้ร้านต่อ 1 เครื่อง
 *   afterDown  = devicePrice * (1 - down%)
 *   commission = afterDown * commission%
 *   net        = afterDown + commission - docFee   (ค่าเอกสารหักออก)
 *
 * ตัวอย่างยืนยัน: 19,900 / ดาวน์ 30% / คอม 12% / ค่าเอกสาร 100
 *   afterDown = 13,930, commission = 1,672 (ปัด), net = 15,502
 */
export function calcSummary(
  devicePrice: number,
  downPercent: number,
  commissionPercent: number,
  docFee: number,
): SummaryBreakdown {
  const afterDown = Math.round(devicePrice * (1 - downPercent / 100))
  const commission = Math.round(afterDown * (commissionPercent / 100))
  const net = afterDown + commission - docFee
  return { afterDown, commission, docFee, net }
}

/** จำนวนวันในเดือน (month = 1-12) */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

/**
 * วันครบกำหนดของงวด โดย clamp ปลายเดือน
 * เช่น dueDay=31 แต่เดือนนั้นมี 30 วัน -> ใช้วันที่ 30
 * @param year ปี ค.ศ. ของงวดนั้น
 * @param month เดือน 1-12 ของงวดนั้น
 */
export function dueDateFor(year: number, month: number, dueDay: number): Date {
  const day = Math.min(dueDay, daysInMonth(year, month))
  return new Date(year, month - 1, day)
}

/**
 * สร้างวันครบกำหนดของทุกงวดจากวันเริ่ม
 * งวดที่ 1 = เดือนถัดจากวันทำรายการ (ปรับได้ภายหลังตามนโยบายจริง)
 */
export function buildSchedule(
  startISO: string,
  dueDay: number,
  termMonths: number,
): Date[] {
  const start = new Date(startISO)
  const out: Date[] = []
  for (let i = 1; i <= termMonths; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1)
    out.push(dueDateFor(d.getFullYear(), d.getMonth() + 1, dueDay))
  }
  return out
}

export interface PenaltyConfig {
  perDay: number // ค่าปรับต่อวัน (ดีฟอลต์ 100)
  maxDays: number // จำนวนวันสูงสุดที่คิด (ดีฟอลต์ 7)
}

export const DEFAULT_PENALTY: PenaltyConfig = { perDay: 100, maxDays: 7 }

/**
 * ค่าปรับของ "งวดที่ค้าง 1 งวด"
 * คิด perDay ต่อวัน แต่ไม่เกิน maxDays วัน (เพดาน = perDay * maxDays)
 * = เดือนแรกของการล่าช้าแต่ละครั้ง (ตามที่พี่พิธยืนยัน)
 */
export function penaltyFor(daysLate: number, cfg: PenaltyConfig = DEFAULT_PENALTY): number {
  if (daysLate <= 0) return 0
  const billableDays = Math.min(daysLate, cfg.maxDays)
  return billableDays * cfg.perDay
}

/** จัดกลุ่มความล่าช้าจากจำนวนวัน */
export function overdueBucket(daysLate: number):
  | 'normal'
  | '1-10'
  | '11-30'
  | '31-60'
  | '61-90'
  | '91-120'
  | '120+' {
  if (daysLate <= 0) return 'normal'
  if (daysLate <= 10) return '1-10'
  if (daysLate <= 30) return '11-30'
  if (daysLate <= 60) return '31-60'
  if (daysLate <= 90) return '61-90'
  if (daysLate <= 120) return '91-120'
  return '120+'
}

export interface ExtensionPrincipalArgs {
  afterDownOriginal: number // contracts.after_down (เงินต้นแท้ตอนสร้างสัญญา)
  originalTerm: number // contracts.term_months (จำนวนงวดเดิม)
  unpaidInstallments: number // นับงวดที่ paid_at IS NULL
  newTerm: number // จำนวนงวดที่จะขยายเพิ่ม (> 0)
  newRate: number // เรตขยาย (เช่น 1.1)
  partialPaid?: number // ยอดที่ลูกค้าจ่ายแล้วในงวดที่ยังเปิดอยู่ (Σ paidAmount where paidAt IS NULL); default 0
}

export interface ExtensionPrincipalResult {
  principalRemaining: number // เงินต้นที่เหลือ (จำนวนเต็ม)
  newFinance: number // ยอดผ่อนรวมใหม่ (= principal × rate)
  newMonthly: number // ค่างวดต่อเดือนใหม่
}

/**
 * คำนวณยอดใหม่หลังขยายระยะเวลา — Option A (Principal-Only)
 * Pete decision 2026-06-13: ใช้เงินต้นแท้ที่เหลือคูณเรตใหม่ ไม่คิดดอกซ้อน
 *
 * สูตร:
 *   principalRaw       = afterDownOriginal × (unpaidInstallments / originalTerm)
 *   partial            = max(0, partialPaid ?? 0)
 *   principalRemaining = max(0, round(principalRaw − partial))
 *   newFinance         = round(principalRemaining × newRate)
 *   newMonthly         = round(newFinance / newTerm)
 *
 * Trace 1: afterDown=25,000 / term=12 / unpaid=6 / partial=0 / newTerm=6 / rate=1.1
 *   principalRemaining = round(25,000 × 6/12)  = 12,500
 *   newFinance         = round(12,500 × 1.1)   = 13,750
 *   newMonthly         = round(13,750 / 6)     = 2,292
 *
 * Trace 2: afterDown=10,000 / term=10 / unpaid=10 / partial=0 / newTerm=12 / rate=1.15
 *   principalRemaining = round(10,000 × 10/10) = 10,000
 *   newFinance         = round(10,000 × 1.15)  = 11,500
 *   newMonthly         = round(11,500 / 12)    = 958
 *
 * Trace 3: afterDown=20,000 / term=12 / unpaid=1 / partial=0 / newTerm=3 / rate=1.05
 *   principalRemaining = round(20,000 × 1/12)  = 1,667
 *   newFinance         = round(1,667 × 1.05)   = 1,750
 *   newMonthly         = round(1,750 / 3)      = 583
 *
 * Trace 4: unpaidInstallments === 0 → principalRemaining=0, newFinance=0, newMonthly=0
 *   (caller ควรแสดง warning ให้ user ทราบ)
 *
 * Trace 5 (partial pay credit): afterDown=25,000 / term=12 / unpaid=6 / partial=2,000 / newTerm=6 / rate=1.1
 *   principalRaw       = 25,000 × 6/12 = 12,500
 *   principalRemaining = 12,500 − 2,000 = 10,500
 *   newFinance         = round(10,500 × 1.1) = 11,550
 *   newMonthly         = round(11,550 / 6)   = 1,925
 *
 * Trace 6 (over-paid partial → clamp 0): afterDown=25,000 / term=12 / unpaid=6 / partial=15,000 / newTerm=6 / rate=1.1
 *   principalRaw       = 12,500
 *   principalRemaining = max(0, 12,500 − 15,000) = 0
 *   newFinance = 0, newMonthly = 0
 */
export function calcExtensionPrincipal(
  args: ExtensionPrincipalArgs,
): ExtensionPrincipalResult {
  const { afterDownOriginal, originalTerm, unpaidInstallments, newTerm, newRate } = args

  // --- validation (throw ก่อน compute เสมอ) ---
  if (afterDownOriginal <= 0) throw new Error('เงินต้นต้องมากกว่า 0')
  if (originalTerm <= 0) throw new Error('จำนวนงวดเดิมต้องมากกว่า 0')
  if (newTerm <= 0) throw new Error('จำนวนงวดต้องมากกว่า 0')
  if (newRate <= 0) throw new Error('เรตต้องมากกว่า 0')
  if (unpaidInstallments < 0) throw new Error('จำนวนงวดที่ยังไม่ชำระต้องไม่น้อยกว่า 0')
  if (unpaidInstallments > originalTerm)
    throw new Error('จำนวนงวดที่ยังไม่ชำระเกินจำนวนงวดเดิม')
  if ((args.partialPaid ?? 0) < 0) throw new Error('ยอดจ่ายบางส่วนต้องไม่น้อยกว่า 0')

  // --- compute ---
  const partial = Math.max(0, args.partialPaid ?? 0)
  const principalRaw = afterDownOriginal * (unpaidInstallments / originalTerm)
  const principalRemaining = Math.max(0, Math.round(principalRaw - partial))
  const newFinance = Math.round(principalRemaining * newRate)
  const newMonthly = newTerm > 0 ? Math.round(newFinance / newTerm) : 0

  return { principalRemaining, newFinance, newMonthly }
}

// ===== paymentRecoveryStatus — สรุป "กลับเป็นปกติ" ต้องจ่ายอีกเท่าไหร่ (เพิ่ม 2026-07-02, req 9) =====

export interface RecoveryInstallmentInput {
  dueDate: string // yyyy-mm-dd
  amount: number
  paidAmount: number
  paidAt: string | null
}

export interface PaymentRecoveryStatus {
  overdueCount: number
  overdueAmountRemaining: number
  recoveredThisEpisode: { installmentCount: number; amountPaid: number }
  toNormal: { installmentsToClose: number; amountNeeded: number }
  isNormal: boolean
  badgeText: string
}

/**
 * สรุปสถานะ "กลับเป็นปกติ" จากงวดที่ค้างอยู่ ณ วันนี้
 * "กลับเป็นปกติ" = ไม่มีงวด paidAt=null AND dueDate<=today (ตรงกับ v_contract_status days_late=0)
 *
 * ใช้ string compare `dueDate<=todayStr` (ไม่ new Date() ข้างใน) — pattern เดียวกับ priorityQueue.ts:156
 *
 * ---- Trace tests (today = '2026-07-02') ----------------------------------------
 * Trace1: [ง1 due04-02 amt2000 paid2000 paidAt04-02][ง2 due05-02 amt2000 paid2000 paidAt06-15]
 *         [ง3 due06-02 amt2000 paid0 null][ง4 due07-02 amt2000 paid0 null]
 *   → overdueCount=2 (ง3,ง4), remaining=4000, recovered={1,2000}(เฉพาะง2 — ง1 จ่ายตรงเวลาไม่นับ)
 *   badge "ค้าง 2 งวด (4,000 ฿) · จ่ายมาแล้ว 1 งวด (2,000 ฿) · อีก 2 งวด (4,000 ฿) กลับปกติ"
 *
 * Trace2 partial: [ง1 due05-02 amt1500 paid1500 paidAt05-02][ง2 due06-02 amt1500 paid500 null]
 *                 [ง3 due07-01 amt1500 paid0 null]
 *   → overdueCount=2, remaining=2500, recovered={1,500}
 *   badge "ค้าง 2 งวด (2,500 ฿) · จ่ายมาแล้วบางส่วน 500 ฿ · อีก 2,500 ฿ กลับปกติ"
 */
export function paymentRecoveryStatus(
  installments: RecoveryInstallmentInput[],
  today: Date,
): PaymentRecoveryStatus {
  const y = today.getFullYear()
  const m = String(today.getMonth() + 1).padStart(2, '0')
  const d = String(today.getDate()).padStart(2, '0')
  const todayStr = `${y}-${m}-${d}`

  const overdue = installments.filter((i) => i.paidAt === null && i.dueDate <= todayStr)
  const overdueCount = overdue.length
  const overdueAmountRemaining = overdue.reduce(
    (sum, i) => sum + Math.max(0, i.amount - i.paidAmount),
    0,
  )

  const recovered = installments.filter(
    (i) => i.dueDate <= todayStr && i.paidAmount > 0 && i.paidAt !== null,
  )
  const recoveredThisEpisode = {
    installmentCount: recovered.length,
    amountPaid: recovered.reduce((sum, i) => sum + i.paidAmount, 0),
  }

  const toNormal = { installmentsToClose: overdueCount, amountNeeded: overdueAmountRemaining }
  const isNormal = overdueCount === 0

  return {
    overdueCount,
    overdueAmountRemaining,
    recoveredThisEpisode,
    toNormal,
    isNormal,
    badgeText: formatRecoveryBadge({
      overdueCount,
      overdueAmountRemaining,
      recoveredThisEpisode,
      toNormal,
      isNormal,
    }),
  }
}

/** สร้างข้อความป้ายจากผลลัพธ์ paymentRecoveryStatus (แยกต่างหากตามสเปก) */
export function formatRecoveryBadge(
  status: Omit<PaymentRecoveryStatus, 'badgeText'>,
): string {
  if (status.isNormal) return 'ผ่อนปกติ'

  const { overdueCount, overdueAmountRemaining, recoveredThisEpisode, toNormal } = status

  const parts = [`ค้าง ${overdueCount} งวด (${baht(overdueAmountRemaining)} ฿)`]

  if (recoveredThisEpisode.installmentCount > 0) {
    parts.push(`จ่ายมาแล้ว ${recoveredThisEpisode.installmentCount} งวด (${baht(recoveredThisEpisode.amountPaid)} ฿)`)
  } else if (recoveredThisEpisode.amountPaid > 0) {
    parts.push(`จ่ายมาแล้วบางส่วน ${baht(recoveredThisEpisode.amountPaid)} ฿`)
  }

  parts.push(`อีก ${toNormal.installmentsToClose} งวด (${baht(toNormal.amountNeeded)} ฿) กลับปกติ`)

  return parts.join(' · ')
}
