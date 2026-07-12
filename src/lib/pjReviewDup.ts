// ===== ตรวจ "แถวน่าสงสัย" ในกล่องรอตรวจ PJ (pure function ล้วน — ไม่แตะ supabase) =====
// ใช้เตือน UI (เวฟ 2 — น้องวิว) ว่าแถวไหนควรระวังเป็นพิเศษ ไม่ใช่กฎตายตัว/ไม่ block อะไร
//
// 2 เรื่องที่ตรวจ:
//   1) ซ้ำ      — contract เดียวกัน + วันจ่ายเดียวกัน + ยอดเท่ากัน โผล่ >1 แถวในกล่อง
//                 (ทีมคีย์มือใน PJ เอง + auto-sync ดึงมาซ้ำคนละรอบ)
//   2) ยอดแปลก  — ยอดจ่ายเล็กกว่าค่างวดจริงของสัญญามาก และไม่ตรงเป๊ะกับค่างวด/ยอดคงเหลือ
//                 (เช่น จ่าย 100/500 ทั้งที่ค่างวดจริง 1,680 — น่าจะเป็นค่าใช้จ่ายอื่น ไม่ใช่ค่างวด)

import type { PjReviewContext, PjSyncReviewRow } from './types'

// ---------------------------------------------------------------------------
// 1) ตรวจซ้ำ — ทำงานบนทั้งกล่อง (rows ที่โหลดมาแล้ว เช่นจาก getPjSyncReview('pending'))
// ---------------------------------------------------------------------------

/** ผลตรวจซ้ำของ 1 แถว */
export interface PjReviewDupFlag {
  /** true = มีแถวอื่นในกล่องที่ contract เดียวกัน + วันจ่ายเดียวกัน + ยอดเท่ากัน */
  isDuplicate: boolean
  /** id ของแถวอื่นในกลุ่มซ้ำเดียวกัน (ไม่รวมตัวเอง) — [] ถ้าไม่ซ้ำ */
  duplicateRowIds: string[]
}

/**
 * หาแถวที่ "น่าจะซ้ำ" ในกล่องรอตรวจ PJ ทั้งกล่อง
 * key กลุ่ม = contractId + paidDate (ตัดเหลือ YYYY-MM-DD) + amount (เงินต้น ไม่รวม penaltyAmount)
 * แถวที่ contractId เป็น null (หาสัญญาไม่เจอ) หรือ paidDate เป็น null ไม่ถูกจัดกลุ่ม (ไม่มี key ให้เทียบ) → isDuplicate เสมอ false
 *
 * @param rows แถวทั้งหมดในกล่องรอตรวจที่จะเทียบกัน (ปกติคือ rows ทั้งหน้า — สถานะ 'pending')
 * @returns Map<rowId, PjReviewDupFlag> — 1 entry ต่อ 1 แถวใน rows (lookup O(1) ต่อแถวตอน render)
 */
export function detectDuplicatePjReviewRows(rows: PjSyncReviewRow[]): Map<string, PjReviewDupFlag> {
  // คีย์กลุ่ม:
  //   - ถ้าแถวมี receiptUuids (uuid ดิบต่อใบเสร็จจาก PJ — field "uuid") → ใช้ตรงนี้เป็นหลัก
  //     exact กว่า composite เดิม เพราะ uuid ไม่ชนกันข้ามใบเสร็จแม้สัญญา/วันเดียวกัน (ต่างจาก contract+date+amount)
  //   - ไม่มี uuid (แถวเก่าก่อน deploy หรือ raw_json ไม่มี field นี้) → fallback composite เดิม
  //     เพิ่ม payment_type เข้าคีย์ (เดิมไม่มี) กัน invoice เดียวจ่าย 2 ยอดคนละประเภท (เช่น ค่างวด + ค่าปรับ
  //     ยอดเท่ากันโดยบังเอิญ) ถูกมองว่าซ้ำกันทั้งที่เป็นคนละรายการ
  const dupKey = (r: PjSyncReviewRow): string | null => {
    if (r.receiptUuids && r.receiptUuids.length > 0) {
      return `uuid:${[...r.receiptUuids].sort().join(',')}`
    }
    if (r.contractId && r.paidDate) {
      return `${r.contractId}|${r.paidDate.slice(0, 10)}|${r.amount}|${r.paymentType ?? ''}`
    }
    return null
  }

  const groups = new Map<string, string[]>()
  for (const r of rows) {
    const key = dupKey(r)
    if (key === null) continue
    const list = groups.get(key)
    if (list) list.push(r.id)
    else groups.set(key, [r.id])
  }

  const result = new Map<string, PjReviewDupFlag>()
  for (const r of rows) {
    const key = dupKey(r)
    if (key === null) {
      result.set(r.id, { isDuplicate: false, duplicateRowIds: [] })
      continue
    }
    const groupIds = groups.get(key) ?? [r.id]
    const others = groupIds.filter((id) => id !== r.id)
    result.set(r.id, { isDuplicate: others.length > 0, duplicateRowIds: others })
  }
  return result
}

// ---------------------------------------------------------------------------
// 2) ตรวจยอดแปลก — ทำงานบน 1 แถว เทียบกับค่างวดอ้างอิงของสัญญานั้น
// ---------------------------------------------------------------------------

/** สัดส่วนที่ถือว่า "เล็กผิดปกติ" เทียบกับค่างวดอ้างอิง (< referenceAmount * ratio นี้ = ยอดแปลก) */
export const ODD_AMOUNT_RATIO = 0.5

/** ผลตรวจยอดแปลกของ 1 แถว */
export interface PjReviewOddAmountFlag {
  isOddAmount: boolean
  /** ข้อความอธิบายเป็นภาษาไทย พร้อมโชว์ตรงๆ ใน UI — null ถ้า isOddAmount = false */
  hint: string | null
}

/**
 * ตรวจ "ยอดแปลก" ของยอด 1 แถว เทียบกับค่างวดอ้างอิง (referenceAmount) — heuristic เตือนคนตรวจ ไม่ใช่กฎตายตัว
 *
 * เงื่อนไข isOddAmount = true ต้องเข้าทุกข้อ:
 *  - referenceAmount และ amount ต้อง > 0 (ไม่งั้นข้อมูลไม่พอเช็ค → false เสมอ ไม่ถือว่า "ไม่แปลก")
 *  - amount < referenceAmount (จ่ายเต็ม/จ่ายเกิน/ข้ามหลายงวด ถือว่าปกติ ไม่ตรวจ)
 *  - amount ไม่ตรงเป๊ะกับ remainingAmount ที่ส่งมา (ถ้ามี) —จ่ายพอดียอดคงเหลือ = ปกติ ไม่ใช่ยอดแปลก
 *  - amount < referenceAmount * ODD_AMOUNT_RATIO — เล็กกว่าค่างวดอ้างอิงเกินครึ่ง
 *
 * @param amount ยอดของแถวที่จะตรวจ (เงินต้น ไม่รวม penalty)
 * @param referenceAmount ค่างวดอ้างอิงของสัญญา (แนะนำ: ctx.nextUnpaid?.amount ?? ctx.monthly) — null/0 = ไม่มีข้อมูลพอเช็ค
 * @param remainingAmount ยอดคงเหลือของงวดที่จะตัด (ctx.nextUnpaid?.remaining) — optional เผื่อจ่ายพอดีเศษที่เหลือ
 */
export function detectOddAmount(
  amount: number,
  referenceAmount: number | null,
  remainingAmount?: number | null,
): PjReviewOddAmountFlag {
  if (!referenceAmount || referenceAmount <= 0 || !amount || amount <= 0) {
    return { isOddAmount: false, hint: null }
  }
  if (amount >= referenceAmount) return { isOddAmount: false, hint: null }
  if (remainingAmount != null && amount === remainingAmount) return { isOddAmount: false, hint: null }
  if (amount < referenceAmount * ODD_AMOUNT_RATIO) {
    return {
      isOddAmount: true,
      hint: `ยอด ${amount.toLocaleString('th-TH')} ฿ เล็กกว่าค่างวดจริง ${referenceAmount.toLocaleString('th-TH')} ฿ มาก — อาจไม่ใช่ค่างวด (เช่น ค่าส่งพัสดุ/ค่าธรรมเนียม) ลองพิจารณาลงเป็นรายได้อื่นๆ แทน`,
    }
  }
  return { isOddAmount: false, hint: null }
}

/**
 * convenience wrapper — ใช้ PjReviewContext ตรงๆ (จาก getPjReviewContext) เป็นแหล่งอ้างอิง
 * reference = ค่างวดของงวดถัดไปที่ยังไม่จ่าย ถ้าไม่มี fallback ไปที่ค่างวดมาตรฐานของสัญญา (ctx.monthly)
 */
export function detectOddAmountFromContext(amount: number, ctx: PjReviewContext): PjReviewOddAmountFlag {
  const referenceAmount = ctx.nextUnpaid?.amount ?? ctx.monthly ?? null
  const remainingAmount = ctx.nextUnpaid?.remaining ?? null
  return detectOddAmount(amount, referenceAmount, remainingAmount)
}
