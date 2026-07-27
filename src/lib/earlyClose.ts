// ===== ปิดสัญญาก่อนกำหนด (Early Close) =====
// Pete เคาะกติกา (ล็อกแล้ว):
//   1) ค่าปรับค้าง = บังคับเก็บอย่างน้อยเท่าที่ค้างเสมอ ห้ามต่ำกว่า — เก็บเกินได้ (ล็อกรอบ 2, 27 ก.ค. 2026)
//      เหตุผล: PJ คิดค่าปรับสะสมทุกงวดที่ค้าง มักเกินเพดาน 700 ของเรา (พบ 342 งวดจริงที่เกิน 700)
//      ถ้าบังคับเท่ากันเป๊ะจะปิดสัญญาไม่ได้ในเคสจริงจำนวนมาก
//      (ถ้าจะเก็บน้อยกว่ายอดค้าง ต้องไปแก้ยอดค่าปรับรายงวดก่อนด้วยปุ่มเดิม) → ไม่มี waive flag
//   2) ค่าธรรมเนียมปิด = เลือกจากรายการมาตรฐาน (0..n) + ตัวเลือก "อื่นๆ (ระบุเอง)"
//   3) คงตารางงวดเสมอ — ฟังก์ชันนี้แค่คำนวณยอด ไม่แตะ/เขียน installments
//
// แก้รอบ 3 (27 ก.ค. 2026 — flag โดยน้องชีส, ครีมเช็คข้อมูลจริงยืนยันแล้ว 2 สัญญา active รวม 600฿):
//   penaltyAmount ดิบของงวด (installments.penalty_amount) เป็น "ยอดตั้ง" ที่คำนวณสะสมทุกวัน —
//   ไม่ได้หักลบเวลามีการเก็บค่าปรับบางส่วนไปแล้วในงวดเดียวกัน (เช่น ตั้ง 700 เก็บไปแล้ว 300)
//   → ถ้าเอา penaltyAmount ดิบมาบังคับเก็บตรงๆ ในจุดที่ "เรียกเก็บเงินจริง" (จุดนี้) จะเรียกเก็บซ้ำ
//   ⚠️ penaltyAmount ดิบ (ไม่หักที่จ่ายแล้ว) ยังเป็น convention ที่ใช้ทั่วเว็บอยู่ (ContractDetail.tsx:440,
//   settlement.ts:190) — ห้ามไปแก้ 2 ที่นั้น แก้เฉพาะในไฟล์นี้ เพราะเป็นจุดเดียวที่เอาไปเรียกเก็บเงินจริง
//   Installment (types.ts) ไม่มี field เก็บ "ค่าปรับที่จ่ายแล้วต่องวด" ตรงๆ (มีแต่ penaltyPaidForInstallment()
//   ใน calc.ts ที่รับ payment_log entries) → เพิ่ม input ใหม่ optional penaltyPaidByInstallmentId แทน
//   ให้ UI/caller คำนวณจาก payment_log ส่งเข้ามาเอง (ฟังก์ชันนี้ยังคง pure ไม่เรียก db)
//
// แก้รอบ 4 (27 ก.ค. 2026 — ติ๊กรีวิว): ข้อความ error ต้องตรงกับ RPC
//   public.close_contract_early_preserve_schedule (migration 0131) คำต่อคำ กัน drift เงียบระหว่าง
//   TS/SQL วันหลัง — เปลี่ยน 2 จุด:
//     1) แยก validate ยอดติดลบเป็น 3 ข้อความเฉพาะ (settlementPaid / penaltyReceived / fee.amount)
//        แทนข้อความรวมเดิม + ตัวเลขที่แทรกไม่ใส่ comma format (ตรงกับ postgres numeric-to-text ที่ไม่มี
//        thousands separator — ก่อนหน้านี้ TS ใช้ toLocaleString('th-TH') ทำให้ข้อความหน้าตาต่างจาก SQL)
//     2) ตัด suffix "กรุณาตรวจสอบ" ออกจากข้อความยอดจ่ายเกินคงเหลือ ให้ตรง SQL เป๊ะ
//   เพิ่ม validate closedAt ว่าง/ผิดรูปแบบ (ไม่มีฝั่ง SQL ตรงกัน — SQL รับ p_closed_at เป็น date type
//   ผ่าน type cast อยู่แล้ว จะไม่มีทางเป็น '' ได้ก่อนถึง RPC; เช็คนี้เป็น UX guard ฝั่ง client เท่านั้น
//   เพื่อกันฟอร์มส่งว่างไปเงียบๆ ก่อนเรียก RPC)
//
// pure function ล้วน ไม่เรียก supabase/Date.now() ตรงๆ — `today` เป็น param (default ให้ถ้าไม่ส่งมา)
// สไตล์ comment/Trace ลอกจาก settlement.ts / outstandingExtras.ts

import type { Installment } from './types'

export const EARLY_CLOSE_FEE_CATEGORIES = [
  'ค่าดำเนินการ',
  'ค่าลงทะเบียนออกจากระบบ',
  'ค่าปลดล็อก',
  'ค่าปิดด่วน',
  'ค่าบริการอื่นๆ',
] as const

export type EarlyCloseFee = { category: string; amount: number }

export type EarlyCloseInput = {
  installments: Installment[] // ทั้งตาราง (ใช้หา unpaid + anchor + penaltyDue)
  settlementPaid: number // ยอดที่ลูกค้าจ่ายปิด (เข้ารายได้ค่างวด)
  penaltyReceived: number // ค่าปรับที่เก็บ (ต้อง >= penaltyDue สุทธิ — เก็บเกินได้ ห้ามต่ำกว่า)
  fees: EarlyCloseFee[] // ค่าธรรมเนียม 0..n
  closedAt: string // ISO date 'YYYY-MM-DD'
  today?: string // default = วันนี้ (ให้ test ได้)
  /** ค่าปรับที่เก็บไปแล้วจริงต่องวด (key = installment.id, value = บาทที่เก็บสะสมแล้ว)
   *  ไม่บังคับ default {} (= ยังไม่เคยเก็บค่าปรับงวดไหนเลย)
   *  caller (UI/db.ts) คำนวณจาก payment_log ผ่าน penaltyPaidForInstallment() ใน calc.ts เอง
   *  แล้ว map เป็น record ก่อนส่งเข้ามา — ฟังก์ชันนี้ไม่เรียก db ตรงๆ */
  penaltyPaidByInstallmentId?: Record<string, number>
}

export type EarlyCloseResult = {
  anchorInstallmentId: string | null // งวดแรกที่ยังไม่จ่าย (min installmentNo where !paidAt)
  settlementRemaining: number // Σ max(0, amount − paidAmount) ของงวดที่ยังไม่จ่าย
  settlementDiscount: number // = settlementRemaining − settlementPaid (derived ห้ามให้กรอก)
  penaltyCharged: number // Σ penaltyAmount ดิบ (ยอดตั้งไว้ ยังไม่หักที่เก็บแล้ว) ของงวดที่ยังไม่จ่าย — เพื่อ UI อธิบายที่มา
  penaltyAlreadyPaid: number // Σ ค่าปรับที่เก็บไปแล้วจริงของงวดที่ยังไม่จ่าย (จาก penaltyPaidByInstallmentId)
  penaltyDue: number // ค่าปรับสุทธิที่ต้องเก็บเพิ่ม = Σ max(0, penaltyAmount − เก็บไปแล้ว) ของงวดที่ยังไม่จ่าย
  feeTotal: number
  totalReceived: number // settlementPaid + penaltyReceived + feeTotal
  errors: string[] // ข้อความไทย พร้อมโชว์ผู้ใช้ (ว่าง = ผ่าน) — ต้องตรงกับ RPC 0131 คำต่อคำ
}

// pattern เดียวกับ priorityQueue.ts (toLocalDateString) — คัดลอกมาเป็น private helper
// กันไฟล์นี้ import ข้ามไฟล์อื่นโดยไม่จำเป็น (pure lib แยกอิสระ)
function toLocalDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ปัดทศนิยม 2 ตำแหน่งก่อนเทียบเงิน กัน floating point เพี้ยน (เช่น 0.1+0.2 !== 0.3)
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// เช็ครูปแบบวันที่ ISO 'YYYY-MM-DD' แบบง่าย (ไม่ validate ปฏิทินจริง เช่น 02-30 — พอสำหรับกัน UX ส่งค่าว่าง/พิมพ์มั่ว)
function isIsoDateString(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s)
}

/**
 * คำนวณยอดปิดสัญญาก่อนกำหนด (คงตารางงวดเดิมเสมอ — ไม่แตะ installments)
 *
 * Trace test (deterministic):
 *   installments:
 *     #1 installmentNo 1, amount 1000, paidAmount 1000, paidAt '2026-01-01', penalty 0   (จ่ายแล้ว)
 *     #2 installmentNo 2, amount 1000, paidAmount 300,  paidAt null,          penalty 200 (ค้าง จ่ายบางส่วน)
 *     #3 installmentNo 3, amount 1000, paidAmount 0,    paidAt null,          penalty 0
 *   penaltyPaidByInstallmentId = {} (ยังไม่เคยเก็บค่าปรับงวดไหนเลย)
 *   settlementPaid = 1700   (= (1000-300) งวด#2 + (1000-0) งวด#3)
 *   penaltyReceived = 200   (= penaltyDue พอดี)
 *   fees = [{ category:'ค่าดำเนินการ', amount:300 }]
 *   closedAt = '2026-07-27', today = '2026-07-27' (ไม่เกินวันนี้)
 *   →
 *     anchorInstallmentId = id ของ #2 (installmentNo ต่ำสุดในกลุ่มค้าง)
 *     settlementRemaining = 1700
 *     settlementDiscount  = 1700 - 1700 = 0
 *     penaltyCharged      = 200 (ดิบ)
 *     penaltyAlreadyPaid  = 0
 *     penaltyDue          = 200 (สุทธิ = 200 - 0)
 *     feeTotal            = 300
 *     totalReceived       = 1700 + 200 + 300 = 2200
 *     errors              = []
 *
 * Trace test — เก็บค่าปรับบางส่วนไปแล้ว (กันเก็บซ้ำ, แก้รอบ 3):
 *   งวดเดียวค้าง: penaltyAmount ตั้งไว้ 700 (ดิบ), penaltyPaidByInstallmentId[งวดนั้น] = 300 (เก็บไปแล้ว)
 *   →
 *     penaltyCharged     = 700
 *     penaltyAlreadyPaid = 300
 *     penaltyDue         = max(0, 700-300) = 400  (ไม่ใช่ 700 — ป้องกันเก็บซ้ำ)
 *   penaltyReceived = 400 → errors: []  (พอดีสุทธิ ผ่าน)
 *   penaltyReceived = 300 → errors: ['ต้องเก็บค่าปรับค้างอย่างน้อย 400 ฿ (...)']  (ต่ำกว่าสุทธิ ไม่ผ่าน)
 *
 * Trace test — ข้อความ error ต้องตรง RPC 0131 คำต่อคำ (แก้รอบ 4):
 *   งวดเดียวค้าง amount 1000 paidAmount 0 penalty 200:
 *   settlementPaid=-50   → errors รวม 'ยอดจ่ายปิดต้องไม่ติดลบ: -50'
 *   penaltyReceived=-10  → errors รวม 'ยอดค่าปรับที่เก็บต้องไม่ติดลบ: -10'
 *   fees=[{category:'ค่าดำเนินการ',amount:-5}] → errors รวม 'ยอดค่าธรรมเนียมต้องไม่ติดลบ: -5'
 *   settlementPaid=5000 (เกิน settlementRemaining=1000) → errors รวม
 *     'ยอดจ่ายปิดมากกว่ายอดคงเหลือตามตาราง (1000 ฿)' (ไม่มี "กรุณาตรวจสอบ" ต่อท้ายอีกแล้ว)
 *   closedAt='' → errors รวม 'กรุณาระบุวันที่ปิดสัญญา' (ไม่ยิง "เกินวันนี้" ซ้ำเพราะ format ไม่ผ่านตั้งแต่แรก)
 */
/**
 * Edge cases:
 *   - installments ว่าง/จ่ายครบทุกงวดแล้ว (unpaid.length===0) → error "สัญญานี้ไม่มีงวดค้าง ปิดก่อนกำหนดไม่ได้"
 *     anchorInstallmentId=null, settlementRemaining=0, penaltyCharged/penaltyAlreadyPaid/penaltyDue=0
 *     (ยังคำนวณ feeTotal/totalReceived ตามปกติ)
 *   - settlementPaid ติดลบ / penaltyReceived ติดลบ / fee.amount ติดลบ → แยกข้อความเฉพาะทางต่อรายการ
 *     (ไม่ short-circuit — ถ้าติดลบหลายจุดพร้อมกัน จะได้ error หลายบรรทัด, ถ้ามีหลาย fee ติดลบพร้อมกัน
 *     จะได้ 1 บรรทัดต่อ fee ที่ผิด ไม่ได้รวมเป็นบรรทัดเดียว)
 *   - settlementPaid > settlementRemaining → error พร้อมยอดคงเหลือจริงในวงเล็บ (settlementDiscount จะติดลบ — UI แสดง error ต้องกันไม่ให้ submit)
 *   - penaltyReceived ต่ำกว่า penaltyDue สุทธิ (พยายามยก/ลดค่าปรับ) → ปฏิเสธเสมอ ไม่มี waive flag
 *   - penaltyReceived สูงกว่า penaltyDue สุทธิ (เก็บเกิน เช่นเคส PJ ที่คิดสะสมเกินเพดาน 700) → ผ่าน ไม่ error
 *     (เงื่อนไขคือ "ห้ามต่ำกว่า" เท่านั้น ล็อกรอบ 2 27 ก.ค. 2026 — ก่อนหน้านี้เคยล็อก "เท่ากับ" เป๊ะ ยกเลิกแล้ว)
 *   - งวดที่เคยเก็บค่าปรับไปแล้วมากกว่า penaltyAmount ดิบ (ไม่ควรเกิดแต่กันไว้) → Math.max(0, ...) ต่อรายงวด
 *     กันไม่ให้ penaltyDue ติดลบ (งวดนั้นถือว่า "จ่ายค่าปรับครบแล้ว" มีส่วนสุทธิ 0)
 *   - closedAt ว่าง/ไม่ตรง 'YYYY-MM-DD' → "กรุณาระบุวันที่ปิดสัญญา" (เช็คก่อนเช็คอนาคต — ถ้า format ผิด
 *     จะไม่เช็คต่อว่าเกินวันนี้ไหม กันข้อความซ้ำซ้อนที่ไม่มีความหมาย)
 *   - closedAt ตรงรูปแบบแต่เป็นวันในอนาคต → "วันที่ปิดสัญญาต้องไม่เกินวันนี้" (เทียบ string ISO ตรงๆ กับ todayStr)
 *   - fee category ว่างแต่ amount>0 → "กรุณาระบุประเภทค่าธรรมเนียม"
 *   - หลาย error เกิดพร้อมกันได้ — คืน errors[] ครบทุกข้อที่ชน ไม่ short-circuit ที่ข้อแรก
 */
export function computeEarlyClose(input: EarlyCloseInput): EarlyCloseResult {
  const todayStr = input.today ?? toLocalDateString(new Date())
  const errors: string[] = []
  const penaltyPaidMap = input.penaltyPaidByInstallmentId ?? {}

  const unpaid = input.installments.filter((i) => i.paidAt === null)

  // anchor = งวดค้างที่ installmentNo ต่ำสุด
  const anchor =
    unpaid.length > 0
      ? unpaid.reduce((min, i) => (i.installmentNo < min.installmentNo ? i : min))
      : null
  const anchorInstallmentId = anchor ? anchor.id : null

  const settlementRemaining = unpaid.reduce(
    (s, i) => s + Math.max(0, (i.amount || 0) - (i.paidAmount || 0)),
    0,
  )

  // ค่าปรับ: ดิบ (ยอดตั้ง) vs เก็บไปแล้วจริง vs สุทธิที่ยังต้องเก็บ (กันเก็บซ้ำ — แก้รอบ 3)
  const penaltyCharged = unpaid.reduce((s, i) => s + (i.penaltyAmount || 0), 0)
  const penaltyAlreadyPaid = unpaid.reduce(
    (s, i) => s + (penaltyPaidMap[i.id] ?? 0),
    0,
  )
  const penaltyDue = unpaid.reduce((s, i) => {
    const paidForThis = penaltyPaidMap[i.id] ?? 0
    return s + Math.max(0, (i.penaltyAmount || 0) - paidForThis)
  }, 0)

  const feeTotal = input.fees.reduce((s, f) => s + (f.amount || 0), 0)

  const settlementDiscount = settlementRemaining - input.settlementPaid
  const totalReceived = input.settlementPaid + input.penaltyReceived + feeTotal

  // ===== validate (ไม่ short-circuit — เก็บทุก error ที่ชน) =====
  // ข้อความทุกอันด้านล่างต้องตรงกับ RPC public.close_contract_early_preserve_schedule (migration 0131)
  // คำต่อคำ (ยกเว้นข้อ closedAt ว่าง/format — ไม่มีฝั่ง SQL เทียบ เป็น UX guard ฝั่ง client เท่านั้น)
  if (unpaid.length === 0) {
    errors.push('สัญญานี้ไม่มีงวดค้าง ปิดก่อนกำหนดไม่ได้')
  }

  // แยกข้อความเฉพาะทางต่อรายการ (แก้รอบ 4 — เดิมรวมเป็น "ยอดเงินต้องไม่ติดลบ" อันเดียว ไม่ตรง SQL)
  // ตัวเลขที่แทรกไม่ใส่ comma format ให้ตรงกับ postgres numeric-to-text (raw %)
  if (input.settlementPaid < 0) {
    errors.push(`ยอดจ่ายปิดต้องไม่ติดลบ: ${input.settlementPaid}`)
  }

  if (input.penaltyReceived < 0) {
    errors.push(`ยอดค่าปรับที่เก็บต้องไม่ติดลบ: ${input.penaltyReceived}`)
  }

  for (const f of input.fees) {
    if (f.amount < 0) {
      errors.push(`ยอดค่าธรรมเนียมต้องไม่ติดลบ: ${f.amount}`)
    }
  }

  if (input.settlementPaid > settlementRemaining) {
    // ตัด " กรุณาตรวจสอบ" ออกแล้ว (แก้รอบ 4) ให้ตรง SQL: 'ยอดจ่ายปิดมากกว่ายอดคงเหลือตามตาราง (% ฿)'
    errors.push(`ยอดจ่ายปิดมากกว่ายอดคงเหลือตามตาราง (${settlementRemaining} ฿)`)
  }

  // เก็บเกินได้ ห้ามต่ำกว่ายอดค้างสุทธิ (หักที่เก็บไปแล้ว กันเรียกเก็บซ้ำ — แก้รอบ 3, 27 ก.ค. 2026)
  if (round2(input.penaltyReceived) < round2(penaltyDue)) {
    errors.push(
      `ต้องเก็บค่าปรับค้างอย่างน้อย ${penaltyDue} ฿ (ถ้าต้องการลดค่าปรับ ให้แก้ยอดค่าปรับรายงวดก่อน)`,
    )
  }

  // closedAt ว่าง/ผิดรูปแบบ → guard ก่อน (ไม่ใช่ของ SQL — UX เท่านั้น) แล้วค่อยเช็คอนาคตถ้า format ผ่าน
  // (กันข้อความซ้ำซ้อนไม่มีความหมายเวลา format ผิดอยู่แล้ว)
  if (!input.closedAt || !isIsoDateString(input.closedAt)) {
    errors.push('กรุณาระบุวันที่ปิดสัญญา')
  } else if (input.closedAt > todayStr) {
    errors.push('วันที่ปิดสัญญาต้องไม่เกินวันนี้')
  }

  // แถวว่าง (category ว่าง + amount ≤ 0) ถือว่าไม่ใช้งาน UI ต้องกรองก่อนส่ง — ไม่ error ตรงนี้
  const hasMissingFeeCategory = input.fees.some(
    (f) => (!f.category || f.category.trim() === '') && f.amount > 0,
  )
  if (hasMissingFeeCategory) {
    errors.push('กรุณาระบุประเภทค่าธรรมเนียม')
  }

  return {
    anchorInstallmentId,
    settlementRemaining,
    settlementDiscount,
    penaltyCharged,
    penaltyAlreadyPaid,
    penaltyDue,
    feeTotal,
    totalReceived,
    errors,
  }
}
