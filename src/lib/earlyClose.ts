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
import {
  computeSettlement,
  type SettlementExtensionInfo,
  type SettlementInstallmentInput,
  type SettlementMatrix,
} from './settlement'

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

// ===== โหมด "เงินเข้าครบแล้ว" (funds_in) — แยกโหมดปิดก่อนกำหนดอัตโนมัติ (คุณเตยเคาะ 19 พ.ย. 2026) =====
// ลูกค้าจ่ายเงินก้อนปิดสัญญาเข้า PJ แล้ว (ระบบลงเข้างวดท้ายๆ เอง) แต่ยอดไม่ครบตามตาราง เพราะร้านยอมลดให้
// → ไม่ต้องเก็บเงินซ้ำ แค่ "กดปิด" บันทึกส่วนลดที่ยกให้ (ไม่เขียน payment_log / ไม่แตะ installments)
// ฟังก์ชันนี้ pure — แยกโหมด + คำนวณยอด + เช็คกติกา; ส่วนลดตามตารางคิดด้วย computeSettlement (ห้ามคิดสูตรซ้ำ)

const TOL = 1 // บาท — ความคลาดเคลื่อนที่ยอมรับ (ปัดเศษ/ดาวน์ต่าง 1 บาท)
const AMBIGUOUS_PCT = 0.3

export type EarlyCloseMode = 'collect' | 'funds_in' | 'ambiguous' | 'none'

export interface FundsInInstallment {
  id: string
  installmentNo: number
  amount: number
  paidAmount: number
  paidAt: string | null
  dueDate: string
  penaltyAmount: number
  /** วันที่ (เวลาไทย) ของรายการรับชำระล่าสุดที่ไม่ถูกยกเลิก — ไม่มี = ใช้วันที่ของ paidAt */
  lastPayDate: string | null
}

export interface AnalyzeEarlyCloseInput {
  installments: FundsInInstallment[]
  penaltyPaidByInstallmentId?: Record<string, number>
  termMonths: number
  matrix: SettlementMatrix
  extension?: SettlementExtensionInfo | null
  role: 'admin' | 'staff'
  today: string
  closedAt?: string
  note?: string
  ambiguousAck?: boolean
  feeWaived?: boolean
}

export interface AnalyzeEarlyCloseResult {
  mode: EarlyCloseMode
  closeDay: string | null // D = วันที่เงินเข้าล่าสุดของชุดงวดท้าย
  defaultClosedAt: string // D (ไม่เกินวันนี้) ไม่มี D = วันนี้
  tailIds: string[] // T = งวดที่เป็นก้อนเงินปิดสัญญา
  gross: number
  received: number
  shortfall: number
  shortfallPct: number // 0..1
  expectedDiscount: number
  matrixPercent: number
  matrixMatches: boolean
  noteRequired: boolean
  penaltyDue: number
  worklistEligible: boolean
  staffBlocked: boolean
  warnings: string[]
  errors: string[]
  infos: string[]
  /** collect = true (ถ้าไม่มี error) · none = false · ambiguous = ติ๊กยืนยันแล้วค่อยไปต่อฟอร์มเก็บเงิน · funds_in = admin + ไม่มี error */
  canSubmit: boolean
}

// วันที่ตามเวลาไทย (วิธีเดียวกับ getInstallmentLastPayDates ใน db.ts) — กัน paidAt เป็น UTC ข้ามวัน
function bangkokDate(ts: string): string {
  return new Date(ts).toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)
}

function isOpen(i: FundsInInstallment): boolean {
  return i.paidAt == null || i.paidAmount < i.amount - TOL
}

function fmtNum(n: number): string {
  return Math.round(n).toLocaleString('th-TH')
}

/**
 * Trace (ครีมเช็คข้อมูลจริง 19 พ.ย. — term 12):
 *   P-JA020094: งวด 11 จ่าย 09-23 ครบ, งวด 12 จ่ายบางส่วน → T={11,12} D=09-23
 *     gross 8376 / received 7790 / shortfall 586 (7.0%) → funds_in, ตาราง (จ่ายแล้ว 10 งวด = 7%) ให้ 586 → ตรง
 *   จ่ายทีละงวดคนละวัน (3000x12, งวด 11 จ่าย 1500 วัน 11-10, งวด 12 จ่าย 1500 วัน 11-15) → ambiguous
 *   ยังไม่มีเงินเข้างวดท้ายเลย → collect (ฟอร์มเดิม)
 */
export function analyzeEarlyClose(input: AnalyzeEarlyCloseInput): AnalyzeEarlyCloseResult {
  const sorted = [...input.installments].sort((a, b) => a.installmentNo - b.installmentNo)
  const warnings: string[] = []
  const errors: string[] = []
  const infos: string[] = []
  const penaltyPaid = input.penaltyPaidByInstallmentId ?? {}
  const payDate = (i: FundsInInstallment): string | null => i.lastPayDate ?? (i.paidAt ? bangkokDate(i.paidAt) : null)

  const base: AnalyzeEarlyCloseResult = {
    mode: 'none',
    closeDay: null,
    defaultClosedAt: input.today,
    tailIds: [],
    gross: 0,
    received: 0,
    shortfall: 0,
    shortfallPct: 0,
    expectedDiscount: 0,
    matrixPercent: 0,
    matrixMatches: true,
    noteRequired: false,
    penaltyDue: 0,
    worklistEligible: false,
    staffBlocked: false,
    warnings,
    errors,
    infos,
    canSubmit: false,
  }

  const open = sorted.filter(isOpen)
  if (sorted.length === 0 || open.length === 0) return base

  const last = sorted[sorted.length - 1]
  const s = Math.min(...open.map((i) => i.installmentNo))

  // D = วันที่เงินเข้าล่าสุดในช่วงงวด >= s
  let closeDay: string | null = null
  let anyPaidFromS = false
  let dateMissing = false
  for (const i of sorted) {
    if (i.installmentNo < s || i.paidAmount <= 0) continue
    anyPaidFromS = true
    const d = payDate(i)
    if (d == null) dateMissing = true
    else if (closeDay == null || d > closeDay) closeDay = d
  }

  // T = [s..N] ขยายถอยหลังตราบที่งวดนั้นมีเงินเข้าและเข้าวัน D เดียวกัน
  const tail = sorted.filter((i) => i.installmentNo >= s)
  if (closeDay != null) {
    let idx = sorted.findIndex((i) => i.installmentNo === s) - 1
    while (idx >= 0 && sorted[idx].paidAmount > 0 && payDate(sorted[idx]) === closeDay) {
      tail.unshift(sorted[idx])
      idx -= 1
    }
  }

  const gross = tail.reduce((a, i) => a + i.amount, 0)
  const received = tail.reduce((a, i) => a + Math.min(i.paidAmount, i.amount), 0)
  const shortfall = gross - received
  const shortfallPct = gross > 0 ? shortfall / gross : 0
  const tailIds = tail.map((i) => i.id)
  const penaltyScope = new Map<string, FundsInInstallment>()
  for (const i of [...tail, ...open]) penaltyScope.set(i.id, i)
  let penaltyDue = 0
  for (const i of penaltyScope.values()) {
    penaltyDue += Math.max(0, (i.penaltyAmount || 0) - (penaltyPaid[i.id] ?? 0))
  }
  const defaultClosedAt = closeDay != null && closeDay <= input.today ? closeDay : input.today

  const common = { closeDay, defaultClosedAt, tailIds, gross, received, shortfall, shortfallPct, penaltyDue }
  const staffCannotWaive = input.feeWaived === true && input.role !== 'admin'

  // 1) ไม่มีเงินเข้างวดท้ายเลย → ฟอร์มเดิม
  if (!anyPaidFromS || received <= 0) {
    if (staffCannotWaive) errors.push('เฉพาะแอดมินเท่านั้นที่ยกเว้นค่าธรรมเนียมได้')
    return { ...base, ...common, mode: 'collect', canSubmit: errors.length === 0 }
  }

  // 2-4) รูปแบบ funds_in: ค้างงวดสุดท้ายงวดเดียว + จ่ายบางส่วน
  const shapeOk =
    !dateMissing &&
    open.length === 1 &&
    open[0].id === last.id &&
    last.paidAmount > 0 &&
    last.paidAmount < last.amount - TOL

  if (shapeOk && shortfall <= TOL) {
    return { ...base, ...common, mode: 'none' }
  }

  if (!(shapeOk && shortfall > TOL && shortfallPct <= AMBIGUOUS_PCT)) {
    warnings.push('มีเงินเข้าบางงวด ไม่แน่ใจว่าเป็นการปิดก่อนกำหนด · ติ๊กยืนยันก่อนดำเนินการ')
    if (!input.ambiguousAck) errors.push('กรุณาติ๊กยืนยันว่าลูกค้าตกลงปิดสัญญาแล้ว')
    if (staffCannotWaive) errors.push('เฉพาะแอดมินเท่านั้นที่ยกเว้นค่าธรรมเนียมได้')
    return { ...base, ...common, mode: 'ambiguous', canSubmit: input.ambiguousAck === true }
  }

  // ===== funds_in =====
  const tailSet = new Set(tailIds)
  const virtual: SettlementInstallmentInput[] = sorted.map((i) => {
    const inTail = tailSet.has(i.id)
    return {
      id: i.id,
      installmentNo: i.installmentNo,
      amount: i.amount,
      paidAmount: inTail ? 0 : i.paidAmount,
      penaltyAmount: i.penaltyAmount,
      paidAt: inTail ? null : i.paidAt,
      dueDate: i.dueDate,
    }
  })
  const settle = computeSettlement({
    installments: virtual,
    closedAt: closeDay ?? input.today,
    termMonths: input.termMonths,
    matrix: input.matrix,
    extension: input.extension ?? null,
  })
  const expectedDiscount = settle.discount
  const matrixMatches = Math.abs(shortfall - expectedDiscount) <= TOL
  const noteRequired = !matrixMatches
  const staffBlocked = input.role !== 'admin'

  infos.push(`ส่วนลด ${fmtNum(shortfall)} ฿ (${(shortfallPct * 100).toFixed(1)}% ของยอดรวม ${fmtNum(gross)} ฿)`)
  if (staffBlocked) infos.push('เงินเข้าครบแล้ว · รอแอดมินกดปิด')
  if (noteRequired) {
    warnings.push(
      `ส่วนลด ${fmtNum(shortfall)} ฿ ไม่ตรงตาราง (ตารางให้ ${fmtNum(expectedDiscount)} ฿) · ต้องระบุหมายเหตุ`,
    )
    if (!(input.note ?? '').trim()) errors.push('กรุณาระบุหมายเหตุที่ส่วนลดไม่ตรงตาราง')
  }
  if (penaltyDue > 0) {
    errors.push(`ยังมีค่าปรับค้าง ${fmtNum(penaltyDue)} ฿ · เก็บค่าปรับก่อนจึงปิดแบบเงินเข้าครบแล้วได้`)
  }
  if (staffCannotWaive) errors.push('เฉพาะแอดมินเท่านั้นที่ยกเว้นค่าธรรมเนียมได้')
  if (input.closedAt !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.closedAt)) errors.push('กรุณาระบุวันที่ปิดสัญญา')
    else if (input.closedAt > input.today) errors.push('วันที่ปิดสัญญาต้องไม่เกินวันนี้')
    else if (closeDay != null && input.closedAt < closeDay) warnings.push('วันปิดสัญญาก่อนวันที่เงินเข้าล่าสุด')
  }

  return {
    ...base,
    ...common,
    mode: 'funds_in',
    expectedDiscount,
    matrixPercent: settle.percent,
    matrixMatches,
    noteRequired,
    worklistEligible: true,
    staffBlocked,
    canSubmit: !staffBlocked && errors.length === 0,
  }
}
