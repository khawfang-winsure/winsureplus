// ===== ป้าย "ทยอยจ่าย" สำหรับลูกค้าล่าช้าที่จ่ายบางส่วนของงวดค้างเก่าสุด =====
//
// ตัดสินว่าแถวลูกค้าล่าช้าแถวหนึ่งควรขึ้นป้ายทยอยจ่ายแบบไหน (dripping/stalled/none)
// pure fn — ไม่ import React ไม่ import จาก db.ts (เลียนแบบรูปทรงของ returnedInstallmentDisplay.ts)
//
// กติกา (คุณเตยเคาะแล้ว 2026-09 — ห้ามเปลี่ยนเอง):
//   - เฉพาะสัญญา status='active' เท่านั้น (คืนเครื่อง/ปิดแล้วใช้สูตรคนละตัว ไม่ปนกัน)
//   - daysLate <= 0 → none (งวดยังไม่ถึงกำหนด เช่นเงินทดล่วงหน้า — เคสจริง นายสิทธิ S00016PNQ266
//     มีเงินทด 65฿ อยู่งวดที่ 5 ต้องไม่ขึ้นป้าย)
//   - amount <= 0 หรือ paidAmount <= 0 หรือ paidAmount >= amount → none (กันหารศูนย์ / กันเคสเก็บครบแล้ว
//     รอพนักงานกดปิดงวด ซึ่งไม่ใช่ "กำลังทยอย")
//   - ผ่านประตูแล้ว แบ่ง 2 ระดับด้วย daysSinceLastPay (นับเป็นวันปฏิทิน เวลาไทย — แปลงทั้งคู่เป็น
//     เที่ยงคืนเวลาไทยก่อนลบ ห้ามคำนวณด้วย millisecond ดิบ ตามแพตเทิร์นเดียวกับที่ใช้คิด daysLate
//     ใน src/lib/priorityQueue.ts / getPromiseDateStatus)
//     - lastPaidAt ไม่ null และ daysSinceLastPay <= DRIP_WINDOW_DAYS → 'dripping' (เขียว)
//     - lastPaidAt ไม่ null และเกิน DRIP_WINDOW_DAYS วัน → 'stalled' (เหลือง) พร้อมจำนวนวัน
//     - lastPaidAt === null → 'stalled' (เหลือง) ไม่รู้จำนวนวันจริง เลยไม่ใส่ตัวเลขในป้าย
//   - ไม่มีเพดานบนของจำนวนวัน — ตัวเลข "ล่าช้ากี่วัน" โชว์อยู่ในแถวเดียวกันอยู่แล้ว
//
// ตัวหารคือ "ค่างวดเต็มของงวดค้างเก่าสุด" เท่านั้น ไม่รวมค่าปรับ (ค่าปรับเพิ่มวันละ 100 เพดาน 700
// ถ้ารวมเข้าไปตัวหารจะโตเองทุกวันทั้งที่ลูกค้าไม่ได้จ่ายเพิ่ม) — ดู PARTIAL_PAYMENT_TOOLTIP

import type { ContractStatus } from './types'
import { baht } from './format'

/** จำนวนวันสูงสุดนับจากวันจ่ายล่าสุด ที่ยังถือว่า "กำลังทยอยจ่าย" (เขียว) เกินนี้ = 'หยุดจ่าย' (เหลือง) */
export const DRIP_WINDOW_DAYS = 14

/** ข้อความ tooltip คงที่ — อธิบายว่าตัวเลขในป้ายนับจากอะไร (ใช้แนบข้างป้ายในหน้า UI) */
export const PARTIAL_PAYMENT_TOOLTIP = 'ไม่รวมค่าปรับ · นับเฉพาะงวดค้างเก่าสุด'

export type PartialPaymentMode = 'dripping' | 'stalled' | 'none'

export type PartialPaymentBadge =
  | {
      mode: 'dripping'
      label: string
      tone: 'green'
      collected: number
      total: number
      daysSinceLastPay: number
    }
  | {
      mode: 'stalled'
      label: string
      tone: 'amber'
      collected: number
      total: number
      daysSinceLastPay: number | null
    }
  | { mode: 'none' }

export interface PartialPaymentInput {
  /** สถานะสัญญา — บังคับเป็น 'active' เท่านั้น ถึงจะพิจารณาต่อ */
  status: ContractStatus
  /** จำนวนวันล่าช้า จาก v_contract_status.daysLate */
  daysLate: number
  /** ค่างวดเต็มของงวดค้างเก่าสุด (ไม่รวมค่าปรับ) */
  amount: number
  /** เก็บได้แล้วเท่าไหร่ของงวดนั้น */
  paidAmount: number
  /** วันบันทึกเงินเข้าล่าสุด (ISO date/timestamp, เวลาไทย) หรือ null ถ้าไม่รู้ */
  lastPaidAt: string | null
  /** วันนี้ — default = วันนี้เวลาไทย (ใส่ไว้ให้ test deterministic) */
  today?: Date
}

/** แปลง Date/ISO string ใดๆ → วันที่แบบ YYYY-MM-DD ตามเขตเวลาไทย (Asia/Bangkok)
 *  ใช้ toLocaleString แบบเดียวกับที่ src/lib/db.ts และไฟล์อื่นๆ ในโปรเจกต์ใช้คิด "วันนี้เวลาไทย" */
function toThaiDateOnly(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input
  return d.toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)
}

/** นับจำนวนวันปฏิทินเต็มระหว่างวันที่สองวัน (รูปแบบ YYYY-MM-DD) โดย parse เป็นเที่ยงคืน local
 *  (เติม 'T00:00:00' กัน off-by-one จาก UTC parsing — ตามแพตเทิร์นเดียวกับ priorityQueue.ts) */
function daysBetweenDateOnly(fromDateOnly: string, toDateOnly: string): number {
  const from = new Date(`${fromDateOnly}T00:00:00`)
  const to = new Date(`${toDateOnly}T00:00:00`)
  return Math.round((to.getTime() - from.getTime()) / 86_400_000)
}

/** ตัดสินป้าย "ทยอยจ่าย" ของแถวลูกค้าล่าช้าหนึ่งแถว — คืน { mode:'none' } ถ้าไม่เข้าเกณฑ์ใดๆ */
export function partialPaymentBadge(input: PartialPaymentInput): PartialPaymentBadge {
  const { status, daysLate, amount, paidAmount, lastPaidAt } = input

  if (status !== 'active') return { mode: 'none' }
  if (daysLate <= 0) return { mode: 'none' }
  if (amount <= 0) return { mode: 'none' }
  if (paidAmount <= 0) return { mode: 'none' }
  if (paidAmount >= amount) return { mode: 'none' }

  const collected = baht(paidAmount)
  const total = baht(amount)

  if (lastPaidAt === null) {
    return {
      mode: 'stalled',
      label: `จ่ายบางส่วนแล้วหยุด · เก็บแล้ว ${collected} / ${total}`,
      tone: 'amber',
      collected: paidAmount,
      total: amount,
      daysSinceLastPay: null,
    }
  }

  const today = input.today ?? new Date()
  const todayDateOnly = toThaiDateOnly(today)
  const lastPaidDateOnly = toThaiDateOnly(lastPaidAt)
  const daysSinceLastPay = Math.max(0, daysBetweenDateOnly(lastPaidDateOnly, todayDateOnly))

  if (daysSinceLastPay <= DRIP_WINDOW_DAYS) {
    return {
      mode: 'dripping',
      label: `ทยอยจ่ายอยู่ · เก็บแล้ว ${collected} / ${total}`,
      tone: 'green',
      collected: paidAmount,
      total: amount,
      daysSinceLastPay,
    }
  }

  return {
    mode: 'stalled',
    label: `จ่ายบางส่วนแล้วหยุด ${daysSinceLastPay} วัน · เก็บแล้ว ${collected} / ${total}`,
    tone: 'amber',
    collected: paidAmount,
    total: amount,
    daysSinceLastPay,
  }
}

// ===== Trace tests (คัดจาก spec Wave 1b — today ใช้ new Date('YYYY-MM-DDT12:00:00+07:00') ตัดปัญหา tz) =====
//
// 1) active, daysLate 18, paidAmount 1200, amount 2565, lastPaidAt 2 วันก่อนวันนี้
//    partialPaymentBadge({
//      status: 'active', daysLate: 18, amount: 2565, paidAmount: 1200,
//      lastPaidAt: '2026-09-26', today: new Date('2026-09-28T12:00:00+07:00'),
//    })
//    → { mode:'dripping', tone:'green', daysSinceLastPay:2,
//        label:'ทยอยจ่ายอยู่ · เก็บแล้ว 1,200 / 2,565' }
//
// 2) เหมือนข้อ 1 แต่ lastPaidAt 18 วันก่อน (2026-09-10)
//    → { mode:'stalled', tone:'amber', daysSinceLastPay:18,
//        label:'จ่ายบางส่วนแล้วหยุด 18 วัน · เก็บแล้ว 1,200 / 2,565' }
//
// 3) ขอบพอดี 14 วัน (lastPaidAt = '2026-09-14', today = '2026-09-28') → ต้องเป็น dripping (<=, ไม่ใช่ <)
//    → { mode:'dripping', tone:'green', daysSinceLastPay:14,
//        label:'ทยอยจ่ายอยู่ · เก็บแล้ว 1,200 / 2,565' }
//
// 4) daysLate 0 + paidAmount 65 (เคสเงินทดของนายสิทธิ S00016PNQ266 งวดที่ 5)
//    partialPaymentBadge({ status:'active', daysLate:0, amount:2565, paidAmount:65, lastPaidAt:'2026-09-27' })
//    → { mode:'none' }
//
// 5) paidAmount = amount (เก็บครบแล้ว รอปิดงวด)
//    partialPaymentBadge({ status:'active', daysLate:18, amount:2565, paidAmount:2565, lastPaidAt:'2026-09-26' })
//    → { mode:'none' }
//
// 6) lastPaidAt null, daysLate 171, paidAmount 3600, amount 6343 (เคสจริง น.ส. ศิรินันท์ S00018PNQ032)
//    partialPaymentBadge({ status:'active', daysLate:171, amount:6343, paidAmount:3600, lastPaidAt:null })
//    → { mode:'stalled', tone:'amber', daysSinceLastPay:null,
//        label:'จ่ายบางส่วนแล้วหยุด · เก็บแล้ว 3,600 / 6,343' }
//
// 7) status 'returned' (คืนเครื่องแล้ว) — ไม่ว่าตัวเลขอื่นจะเข้าเกณฑ์แค่ไหนก็ตาม
//    partialPaymentBadge({ status:'returned', daysLate:18, amount:2565, paidAmount:1200, lastPaidAt:'2026-09-26' })
//    → { mode:'none' }
//
// 8) amount 0 (กันหารศูนย์)
//    partialPaymentBadge({ status:'active', daysLate:18, amount:0, paidAmount:1200, lastPaidAt:'2026-09-26' })
//    → { mode:'none' }
