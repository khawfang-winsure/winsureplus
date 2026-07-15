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
