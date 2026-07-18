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
  installmentNo: number
  dueDate: string // yyyy-mm-dd
  amount: number
  paidAmount: number
  paidAt: string | null // ISO timestamptz (เช่น '2026-04-02T09:15:00+00:00'), ตัด .slice(0,10) ก่อนเทียบ
}

export interface PaymentRecoveryStatus {
  overdueCount: number
  overdueAmountRemaining: number
  recoveredThisEpisode: {
    installmentCount: number
    amountPaid: number
    lastPaidAt: string | null
    /** ยอดของ "งวดเดียว" ที่จ่ายล่าสุด (paidAt สูงสุด) — ต่างจาก amountPaid ที่เป็นผลรวมทั้ง episode */
    lastPaidAmount: number
  }
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
 * recoveredThisEpisode = "contiguous streak" นับถอยหลังจากงวดค้างตัวแรกของรอบปัจจุบัน:
 * เรียงตาม installmentNo, หา firstOverdueIdx (paidAt===null && dueDate<=today) แล้วเดินถอยหลัง
 * นับต่อเมื่อ paidAt!==null && paidAt.slice(0,10)>dueDate (จ่ายช้า/จ่ายไล่) — หยุดทันทีเมื่อเจอ
 * paidAt===null (งวดค้างของ episode ก่อนหน้า) หรือ paidAt.slice(0,10)<=dueDate (จ่ายตรงเวลา = ปกติ)
 *
 * ⚠️ paidAt เป็น ISO timestamptz เต็ม (ตั้งด้วย now() ทุก payment path) ไม่ใช่ yyyy-mm-dd ล้วน —
 * ต้อง .slice(0,10) ก่อนเทียบกับ dueDate เสมอ ไม่งั้นงวดที่จ่ายตรงวันกำหนด (เวลาบวกเข้ามา) จะ
 * string-compare เป็น '>' ผิดพลาด กลายเป็น "จ่ายช้า" ทั้งที่ตรงเวลา (pattern เดียวกับ monthlyReport.ts:173)
 *
 * ---- Trace tests (today = '2026-07-04', amount=1712 ทุกงวด เว้นระบุเอง) --------------------
 * (ก) เคส Pete: ง1 due04-02 paidAt='2026-04-02T09:15:00+00:00'(ตรงเวลา)
 *     · ง2 due05-02 paidAt='2026-06-30T10:00:00+00:00'(ช้า)
 *     · ง3 due06-02 paid null · ง4 due07-02 paid null
 *   → firstOverdue=ง3 → ถอยหลัง ง2 จ่ายช้า(2026-06-30>2026-05-02)→นับ,
 *     ง1 จ่ายตรงเวลา(2026-04-02<=2026-04-02)→หยุด
 *   → recovered={1, 1712, lastPaidAt='2026-06-30', lastPaidAmount=1712}
 *
 * (ข) จ่ายดี 6 งวด (paidAt.slice(0,10)===dueDate ทุกงวด) เพิ่งค้าง ง7,ง8
 *   → firstOverdue=ง7 → ถอยหลัง ง6 paid<=due→หยุดทันที
 *   → recovered={0, 0, null, 0}
 *
 * (ค) partial: ง1 due05-02 paidAt='2026-05-02T08:00:00+00:00' เต็ม
 *     · ง2 due06-02 paidAt null paidAmount 500(งวดยังเปิด) · ง3 due07-02 paidAt null
 *   → firstOverdue=ง2 (paidAt===null แม้มี paidAmount>0) → ถอยหลัง ง1 paid<=due→หยุด
 *   → recovered={0, 0, null, 0}. overdueAmountRemaining ของ ง2 = max(0,1712-500)=1212 (ไม่แก้ สูตรเดิมถูกอยู่แล้ว)
 *
 * (ง) หลายงวด paidAmount ต่างกัน จ่ายช้าทั้งคู่: ง1 due03-02 paidAmount=500 paidAt='2026-05-10'(ช้า)
 *     · ง2 due04-02 paidAmount=700 paidAt='2026-06-15'(ช้า) · ง3 due05-02 paidAmount=900 paidAt='2026-06-20'(ช้า)
 *     · ง4 due06-02 paid null (ค้าง, firstOverdue)
 *   → firstOverdue=ง4 → ถอยหลัง ง3 ช้า→นับ, ง2 ช้า→นับ, ง1 ช้า→นับ (ชนขอบเขต idx=0 หยุด)
 *   → recovered={3, amountPaid=500+700+900=2100, lastPaidAt='2026-06-20'(ของง3=max),
 *      lastPaidAmount=900 (paidAmount ของง3 เท่านั้น ไม่ใช่ผลรวม 2100)}
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

  const sorted = [...installments].sort((a, b) => a.installmentNo - b.installmentNo)
  const firstOverdueIdx = sorted.findIndex((i) => i.paidAt === null && i.dueDate <= todayStr)

  const recoveredList: RecoveryInstallmentInput[] = []
  if (firstOverdueIdx > 0) {
    for (let idx = firstOverdueIdx - 1; idx >= 0; idx--) {
      const inst = sorted[idx]
      if (inst.paidAt !== null && inst.paidAt.slice(0, 10) > inst.dueDate) {
        recoveredList.push(inst)
      } else {
        break
      }
    }
  }
  const recoveredDatesOnly = recoveredList.map((i) => (i.paidAt as string).slice(0, 10))
  // หา installment ที่ paidAt (slice 0,10) สูงสุด — ใช้ paidAmount ของงวดนั้นเดียว (ไม่ใช่ Σ)
  const lastPaidInstallment = recoveredList.reduce<RecoveryInstallmentInput | null>((latest, i) => {
    if (latest === null) return i
    return (i.paidAt as string).slice(0, 10) > (latest.paidAt as string).slice(0, 10) ? i : latest
  }, null)
  const recoveredThisEpisode = {
    installmentCount: recoveredList.length,
    amountPaid: recoveredList.reduce((sum, i) => sum + i.paidAmount, 0),
    lastPaidAt:
      recoveredDatesOnly.length === 0
        ? null
        : recoveredDatesOnly.reduce<string>((max, d) => (d > max ? d : max), recoveredDatesOnly[0]),
    lastPaidAmount: lastPaidInstallment === null ? 0 : lastPaidInstallment.paidAmount,
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
    parts.push(`จ่ายลดมาแล้ว ${recoveredThisEpisode.installmentCount} งวด (${baht(recoveredThisEpisode.amountPaid)} ฿)`)
  }

  parts.push(`เหลือตามอีก ${toNormal.installmentsToClose} งวด`)

  return parts.join(' · ')
}

// ===== penaltyPaidForInstallment — ค่าปรับที่ "จ่ายแล้วจริง" ต่องวด (ตาราง issue #2, req พี่พิธ 16 ก.ค. 2026) =====

/**
 * โครง payment_log ขั้นต่ำที่ฟังก์ชันนี้ต้องใช้ — ตั้งใจไม่ import PaymentLogEntry จาก db.ts ตรงๆ
 * (field penaltyPaidAmount ยังไม่มีใน db.ts ตอนเขียนไฟล์นี้ — น้องชีสเพิ่มขนานอยู่คนละ PR)
 * เมื่อ db.ts เพิ่ม penaltyPaidAmount แล้ว PaymentLogEntry จะ structurally compatible กับ type นี้ทันที
 * เรียกจาก ContractDetail ได้ตรงๆ โดยไม่ต้องแก้ไฟล์นี้อีก
 */
export interface PenaltyPaymentLogEntry {
  action: 'pay' | 'edit' | 'cancel'
  penaltyPaidAmount?: number | null
  createdAt: string
}

/**
 * ผลรวมค่าปรับที่ "จ่ายแล้วจริง" สะสมของงวดเดียว — คนละตัวกับ installments.penalty_amount
 * (= ค่าปรับที่ "ต้องเรียก" คำนวณโดย run_daily_update ทุกวัน 100/วัน เพดาน 700 — ไฟล์นี้ไม่แตะ/ไม่คำนวณ)
 *
 * กติกา:
 *   1) sort entries ตาม createdAt ASC เอง (caller ส่งมาเรียงหรือไม่เรียงก็ได้) — string compare ISO
 *      timestamp ตรงๆ (pattern เดียวกับ priorityQueue.ts:156 / paymentRecoveryStatus ด้านบน)
 *   2) action='cancel' → reset running total = 0 ทันที (คนละแนวเดียวกับ cancel_payment RPC ที่ reset
 *      installments.paid_amount = 0 — คงความหมาย "ยกเลิกทั้งรายการ" ให้ตรงกันระหว่างเงินต้น/ค่าปรับ)
 *   3) action='pay' → บวก penaltyPaidAmount (?? 0) เข้า running total
 *   4) action='edit' → ไม่ทำอะไร (0-contribution, ไม่ reset) — adjust_payment RPC ไม่เคยแตะค่าปรับ
 *      ปัจจุบัน insert penalty_paid_amount=0 เสมอ จึงไม่มีผลต่อผลรวมอยู่แล้ว แต่กันไว้ชัดเจนไม่ให้ reset
 *   5) penaltyPaidAmount undefined/null (แถวเก่าก่อนคอลัมน์นี้มีอยู่) → ถือเป็น 0 ห้าม throw
 *   6) entries ว่าง → 0
 *   7) ไม่ปัดเศษ (Math.round) — ยอดจาก payment_log เป็นจำนวนเต็มบาทอยู่แล้ว
 *
 * Trace 1 (เคสลักขณา — 100+400=500, ส่งมาไม่เรียงลำดับตั้งใจ):
 *   entries = [
 *     { action:'pay', penaltyPaidAmount:400, createdAt:'2026-07-16T02:00:00Z' },
 *     { action:'pay', penaltyPaidAmount:100, createdAt:'2026-07-12T03:00:00Z' },
 *   ]
 *   sort ASC → [12 ก.ค. pay 100] → [16 ก.ค. pay 400], ไม่มี cancel
 *   total = 100 + 400 = 500
 *   → ผลลัพธ์ 500
 *
 * Trace 2 (cancel reset — ต้องได้ 50 ไม่ใช่ 150):
 *   entries = [
 *     { action:'pay',    penaltyPaidAmount:100, createdAt:'2026-07-01T00:00:00Z' },
 *     { action:'cancel', penaltyPaidAmount:0,    createdAt:'2026-07-02T00:00:00Z' },
 *     { action:'pay',    penaltyPaidAmount:50,   createdAt:'2026-07-03T00:00:00Z' },
 *   ]
 *   sort ASC (เรียงอยู่แล้ว) → pay 100 (total=100) → cancel (total reset=0) → pay 50 (total=50)
 *   → ผลลัพธ์ 50
 *
 * Trace 3 (entries ว่าง):
 *   entries = []
 *   → ผลลัพธ์ 0
 *
 * Trace 4 (penaltyPaidAmount undefined/null — แถวเก่าก่อนมีคอลัมน์นี้):
 *   entries = [
 *     { action:'pay', penaltyPaidAmount: undefined, createdAt:'2026-01-01T00:00:00Z' },
 *     { action:'pay', penaltyPaidAmount: null,       createdAt:'2026-01-02T00:00:00Z' },
 *     { action:'pay', penaltyPaidAmount: 200,        createdAt:'2026-01-03T00:00:00Z' },
 *   ]
 *   total = 0 + 0 + 200 = 200 (ไม่ throw)
 *   → ผลลัพธ์ 200
 */
export function penaltyPaidForInstallment(entries: PenaltyPaymentLogEntry[]): number {
  if (entries.length === 0) return 0

  const sorted = [...entries].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  )

  let total = 0
  for (const e of sorted) {
    if (e.action === 'cancel') {
      total = 0
      continue
    }
    if (e.action === 'pay') {
      total += e.penaltyPaidAmount ?? 0
    }
    // action === 'edit' → 0-contribution ตั้งใจ ไม่ reset ไม่บวก
  }
  return total
}

// ===== computePenaltyAccrual — กติกาค่าปรับใหม่: นับจนกว่าจะจ่ายค่าปรับ "ครบ" ไม่หยุดตอนจ่ายเงินต้น =====
// (spec แบม 18 ก.ค. 2026, root cause บั๊ก: run_daily_update เดิม (mig 0031) freeze penalty ทันทีที่
//  paid_at ของงวดถูกเซ็ต แม้ค่าปรับที่เรียกไว้ยังจ่ายไม่ครบ — ฟังก์ชันนี้แทนที่ด้วยตรรกะ "settled = จ่ายค่าปรับ
//  ทันงวดที่มันค้างจริง ณ วันนั้น" ไม่ใช่ "เงินต้นปิดแล้ว")

export interface PenaltyPayEvent {
  action: 'pay' | 'edit' | 'cancel'
  penaltyPaidAmount?: number | null
  createdAt: string
}

export interface PenaltyAccrualConfig {
  perDay?: number // ค่าปรับต่อวัน (บาท) — default 100 (app_settings.penalty_per_day)
  maxDays?: number // เพดานวันที่คิดค่าปรับต่องวด — default 7 (app_settings.penalty_max_days)
}

export interface PenaltyAccrualResult {
  penaltyDays: number // จำนวนวันที่ใช้คิดค่าปรับ (คลิป 0..maxDays) — ถ้า settled = แช่แข็งที่ค่า ณ วัน settle
  penaltyAmount: number // penaltyDays * perDay
  settled: boolean // true = จ่ายค่าปรับทันยอดที่ค้าง ณ วันหนึ่งแล้ว (frozen ไม่โตต่อ)
  settledAt: string | null // วันที่ (yyyy-mm-dd) ที่ settle — null ถ้ายังไม่ settled
}

const DEFAULT_PENALTY_PER_DAY = 100
const DEFAULT_PENALTY_MAX_DAYS = 7

/**
 * จำนวนวันเต็ม (to - from) โดยคำนวณผ่าน Date.UTC ล้วน — ตั้งใจไม่ใช้ `new Date(str)` ตรงๆ
 * (parse string เป็น local time ได้ถ้า string ไม่มี timezone suffix ชัดเจน = TZ drift trap)
 * pattern เดียวกับ commission.ts addDays/addMonths (Date.UTC(y, m-1, d))
 */
function utcDayDiff(fromISO: string, toISO: string): number {
  const [fy, fm, fd] = fromISO.slice(0, 10).split('-').map(Number)
  const [ty, tm, td] = toISO.slice(0, 10).split('-').map(Number)
  const fromUtc = Date.UTC(fy, fm - 1, fd)
  const toUtc = Date.UTC(ty, tm - 1, td)
  return Math.floor((toUtc - fromUtc) / 86_400_000)
}

/** ค่าปรับที่ "ต้องเรียก" ณ วันหนึ่ง (owed-at-date) — days late คลิป >=0 คูณ perDay เพดาน maxDays */
function owedAt(
  dueDate: string,
  atDate: string,
  perDay: number,
  maxDays: number,
): { days: number; amount: number } {
  const lateDays = Math.max(0, utcDayDiff(dueDate, atDate))
  const days = Math.min(lateDays, maxDays)
  return { days, amount: days * perDay }
}

/**
 * ค่าปรับค้างของ 1 งวด ตามกติกาใหม่ (แทน freeze-on-principal-paid ของ run_daily_update เดิม):
 *
 *   0) guard แรกสุด (บั๊กที่ 2 ที่ครีมจับได้บนฝั่ง SQL — mirror มาไว้ฝั่งนี้ด้วยกันเพี้ยน): ถ้า paidAt ไม่ null
 *      และ paidAt (ตัด date) <= dueDate (ตัด date) = เงินต้นจ่ายตรงเวลาหรือก่อนกำหนด → คืนค่าปรับ 0 ทันที
 *      settled=true, settledAt=null (ไม่มี "เหตุการณ์จ่ายค่าปรับ" จริงให้ผูก — ไม่เคยมีค่าปรับค้างเลยตามนิยาม)
 *      ไม่ต้อง walk events เลย (ถ้า events ไม่ว่างก็ไม่สำคัญ เพราะไม่มีทางมีค่าปรับค้างให้จ่ายตั้งแต่แรก)
 *   1) anchor เริ่มนับ = dueDate ของงวด
 *   2) sort events ('pay'/'edit'/'cancel' จาก payment_log ของงวดนั้น) ตาม createdAt ASC เอง
 *      (caller ส่งมาเรียงหรือไม่ก็ได้ — เหมือน penaltyPaidForInstallment ด้านบน)
 *   3) walk ทีละ event สะสม cumPaid:
 *      - action='cancel' → reset cumPaid=0 **และ** ถ้าเคย settled มาก่อนหน้านี้ ให้ยกเลิกสถานะ settled
 *        ด้วย (การจ่ายที่ทำให้ settle ถูกยกเลิกไปแล้ว ต้องกลับไปนับต่อ ไม่ใช่แช่แข็งค้างผิดๆ) แล้ว
 *        เดินต่อจาก event ถัดไปเสมือนเริ่มใหม่
 *      - action='pay' → บวก penaltyPaidAmount (?? 0) เข้า cumPaid; ถ้ายัง "ไม่ settled" ให้เช็ค
 *        owed(ณ วันที่ event นี้เกิด) — ถ้า owed > 0 และ cumPaid >= owed ณ วันนั้น = **event แรกที่จ่ายทัน
 *        ยอดที่ค้างจริง** → settled=true, freeze penaltyDays/penaltyAmount ที่ค่า ณ วันนั้น (ไม่ตรวจซ้ำอีก
 *        เว้นแต่โดน cancel ทีหลัง)
 *      - action='edit' → ไม่มีผล (0-contribution เหมือน penaltyPaidForInstallment — adjust_payment ไม่แตะค่าปรับ)
 *   4) จบ loop แล้ว settled=true → คืนค่าที่ freeze ไว้ (ไม่นับต่อถึง today ต่อให้ late streak ยังเดินอยู่)
 *   5) จบ loop แล้ว settled=false (ไม่มี event ไหนจ่ายทันยอดค้าง ณ วันนั้นเลย) → คำนวณจาก owed(ณ today)
 *      คือค่าปรับที่ "ต้องเรียกวันนี้" ตามงวดยังค้างอยู่ตามปกติ
 *
 * Trace 1 (ตัวอย่างวิไลรัตน์-style — จ่ายทันที่ ง.4/400 = settled):
 *   dueDate='2026-06-30', today='2026-07-18'
 *   events=[{ action:'pay', penaltyPaidAmount:400, createdAt:'2026-07-04T10:00:00Z' }]
 *   → วันที่ event = 4 วันหลัง due (utcDayDiff=4) → owed(ณ 4ก.ค.)=min(4,7)*100=400
 *   → cumPaid=400 >= 400 → settled=true, settledAt='2026-07-04', penaltyDays=4, penaltyAmount=400
 *   → (ไม่นับต่อถึงวันนี้ 18ก.ค. ต่อให้ยังไม่จ่ายเงินต้นงวดนั้นเลยก็ตาม — คนละมิติกับเงินต้น)
 *
 * Trace 2 (still-open — ไม่เคยจ่ายค่าปรับเลย เกินเพดาน):
 *   dueDate='2026-06-01', today='2026-07-18', events=[]
 *   → utcDayDiff=47 วัน คลิป max_days=7 → owed(today)=700
 *   → settled=false, settledAt=null, penaltyDays=7, penaltyAmount=700
 *
 * Trace 3 (cancel-reset — จ่ายทันแล้วโดนยกเลิก ต้องกลับไปนับต่อ ไม่ค้าง settled ผิดๆ):
 *   dueDate='2026-06-30', today='2026-07-18'
 *   events=[
 *     { action:'pay',    penaltyPaidAmount:400, createdAt:'2026-07-04T10:00:00Z' }, // settle ชั่วคราว ง.4/400
 *     { action:'cancel',                          createdAt:'2026-07-05T09:00:00Z' }, // ยกเลิก → reset
 *   ]
 *   → หลัง cancel: cumPaid=0, settled=false, ไม่มี event ต่อจากนี้ → ตกไป owed(today)
 *   → utcDayDiff(due,today)=18 คลิป 7 → penaltyDays=7, penaltyAmount=700, settled=false, settledAt=null
 *
 * Trace 4 (not-due — ยังไม่ถึงกำหนด ไม่มีค่าปรับ):
 *   dueDate='2026-07-25', today='2026-07-18', events=[]
 *   → utcDayDiff=-7 → clamp 0 → penaltyDays=0, penaltyAmount=0, settled=false, settledAt=null
 *
 * Trace 5 (partial-never-catch-up — จ่ายบางส่วนหลายครั้งแต่ไม่เคยทันยอดค้าง ณ วันนั้น):
 *   dueDate='2026-06-01', today='2026-07-18'
 *   events=[
 *     { action:'pay', penaltyPaidAmount:100, createdAt:'2026-06-10T00:00:00Z' }, // ง.9 คลิป7=700 owed 700, cumPaid=100 <700
 *     { action:'pay', penaltyPaidAmount:100, createdAt:'2026-06-20T00:00:00Z' }, // owed ยังคลิป 700, cumPaid=200 <700
 *   ]
 *   → ไม่มี event ไหนจ่ายทัน 700 เลย → settled=false → owed(today) คลิป 7 → penaltyDays=7, penaltyAmount=700
 *
 * Trace 6 (paid-on-time guard — เงินต้นจ่ายตรงเวลา/ก่อนกำหนด ไม่เคยมีค่าปรับค้างจริง — บั๊กที่ 2 ฝั่ง SQL):
 *   dueDate='2026-06-30', paidAt='2026-06-30T09:00:00Z' (จ่ายวันครบกำหนดพอดี), today='2026-07-18', events=[]
 *   → paidAt(ตัด date)='2026-06-30' <= dueDate='2026-06-30' → guard ชน ก่อน walk events เลย
 *   → penaltyDays=0, penaltyAmount=0, settled=true, settledAt=null (ไม่มี event จ่ายค่าปรับจริงให้ผูกวันที่)
 *   → (ถ้า paidAt เป็น null หรือ paidAt > dueDate จะไม่ชน guard นี้ — ไหลไป walk events ตามปกติ)
 */
export function computePenaltyAccrual(input: {
  dueDate: string
  paidAt?: string | null
  events: PenaltyPayEvent[]
  today: string
  cfg?: PenaltyAccrualConfig
}): PenaltyAccrualResult {
  const perDay = input.cfg?.perDay ?? DEFAULT_PENALTY_PER_DAY
  const maxDays = input.cfg?.maxDays ?? DEFAULT_PENALTY_MAX_DAYS

  // guard 0: เงินต้นจ่ายตรงเวลาหรือก่อนกำหนด → ไม่เคยมีค่าปรับค้างจริงตามนิยาม ไม่ต้อง walk events
  if (input.paidAt != null && input.paidAt.slice(0, 10) <= input.dueDate.slice(0, 10)) {
    return { penaltyDays: 0, penaltyAmount: 0, settled: true, settledAt: null }
  }

  const sorted = [...input.events].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  )

  let cumPaid = 0
  let settled = false
  let settledAt: string | null = null
  let settledDays = 0
  let settledAmount = 0

  for (const e of sorted) {
    if (e.action === 'cancel') {
      cumPaid = 0
      settled = false
      settledAt = null
      settledDays = 0
      settledAmount = 0
      continue
    }
    if (e.action === 'pay') {
      cumPaid += e.penaltyPaidAmount ?? 0
      if (!settled) {
        const owedAtEvent = owedAt(input.dueDate, e.createdAt, perDay, maxDays)
        if (owedAtEvent.amount > 0 && cumPaid >= owedAtEvent.amount) {
          settled = true
          settledAt = e.createdAt.slice(0, 10)
          settledDays = owedAtEvent.days
          settledAmount = owedAtEvent.amount
        }
      }
    }
    // action === 'edit' → 0-contribution ตั้งใจ ไม่ reset ไม่บวก ไม่กระทบ settled
  }

  if (settled) {
    return { penaltyDays: settledDays, penaltyAmount: settledAmount, settled: true, settledAt }
  }

  const owedToday = owedAt(input.dueDate, input.today, perDay, maxDays)
  return {
    penaltyDays: owedToday.days,
    penaltyAmount: owedToday.amount,
    settled: false,
    settledAt: null,
  }
}
