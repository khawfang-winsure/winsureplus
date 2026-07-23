// ===== อธิบายกล่องรอตรวจ PJ เป็นภาษาคน (pure function ล้วน — ไม่แตะ supabase) =====
// รื้อหน้า /pj-sync-review ตาม mockup ที่ Pete เคาะ (18 ก.ค. 2026) — ใช้ทำ 3 อย่าง:
//   1) จัดกลุ่มแถวในกล่องรอตรวจตามสัญญา (การ์ดเดียวต่อลูกค้า/สัญญา แทนตารางแบนที่กระจาย)
//   2) อธิบายแต่ละแถวเป็นข้อความไทยอ่านง่าย ตาม reason — โดยเฉพาะ AMOUNT_MISMATCH ค่าปรับ ต้องบอกชัดว่า
//      PJ คิดเท่าไร ระบบเราคิดเท่าไร (แก้ความสับสนยอด 400/800 ที่ Pete เจอ)
//   3) สรุปบริบทรวมของการ์ด (หลายแถวในกล่องของสัญญาเดียวกัน) — แถบเขียว "ไม่ใช่เงินซ้ำ" หรือแถบเหลือง
//      ถ้า detectDuplicatePjReviewRows (pjReviewDup.ts) ธงว่าน่าจะซ้ำจริง
//
// ไม่มี logic ใหม่ที่ตัดสินใจแทนคน — แค่ "แปล" ข้อมูลที่มีอยู่แล้วจาก PjSyncReviewRow/PjReviewContext
// ให้อ่านง่ายขึ้น เทสได้ตรงไปตรงมาเหมือน pjReviewDup.ts (ไม่แตะ supabase)

import type { PjReviewContext, PjSyncReviewReason, PjSyncReviewRow } from './types'

/** reason ที่เป็น drift (ใบเสร็จหาย/ถูกแก้ใน PJ) — ตรวจ+รายงานเท่านั้น ไม่อยู่ใน flow ลงเงิน
 *  (คัดลอก guard เดียวกับ isDriftReason ใน PjSyncReview.tsx มาไว้ในไฟล์ pure fn นี้ด้วย กัน import วน) */
function isDriftReason(reason: PjSyncReviewReason): boolean {
  return reason === 'RECEIPT_MISSING' || reason === 'RECEIPT_CHANGED'
}

// ---------------------------------------------------------------------------
// 1) จัดกลุ่มตามสัญญา
// ---------------------------------------------------------------------------

/** 1 การ์ด = แถวรอตรวจทั้งหมดของสัญญาเดียวกัน (ลูกค้า/INV เดียวกัน) */
export interface PjReviewContractGroup {
  contractId: string
  contractNo: string | null
  customerName: string | null
  /** ลำดับตามที่ส่งเข้ามา (แนะนำส่ง rows ที่ drift มาก่อนแล้ว — ดู isDriftReason sort ในหน้า) */
  rows: PjSyncReviewRow[]
  /** true = มีอย่างน้อย 1 แถวเป็น drift (RECEIPT_MISSING/RECEIPT_CHANGED) */
  hasDrift: boolean
}

export interface PjReviewGrouped {
  groups: PjReviewContractGroup[]
  /** contractId = null (หาสัญญาไม่เจอ) — แยกไว้ต่างหาก ไม่จัดกลุ่ม */
  unmatched: PjSyncReviewRow[]
}

/**
 * จัดกลุ่มแถวกล่องรอตรวจตามสัญญา (contractId) — คงลำดับเดิมของ rows ที่ส่งเข้ามา
 * (การ์ดของ contractId ที่เจอก่อนใน rows จะได้ตำแหน่งก่อนในผลลัพธ์)
 */
export function groupPjReviewByContract(rows: PjSyncReviewRow[]): PjReviewGrouped {
  const order: string[] = []
  const map = new Map<string, PjReviewContractGroup>()
  const unmatched: PjSyncReviewRow[] = []

  for (const r of rows) {
    if (!r.contractId) {
      unmatched.push(r)
      continue
    }
    let g = map.get(r.contractId)
    if (!g) {
      g = { contractId: r.contractId, contractNo: r.contractNo, customerName: r.customerName, rows: [], hasDrift: false }
      map.set(r.contractId, g)
      order.push(r.contractId)
    }
    g.rows.push(r)
    if (isDriftReason(r.reason)) g.hasDrift = true
  }

  return { groups: order.map((id) => map.get(id)!), unmatched }
}

// ---------------------------------------------------------------------------
// 2) อธิบายแต่ละแถว
// ---------------------------------------------------------------------------

const th = (n: number): string => n.toLocaleString('th-TH')

/**
 * อธิบายแถว 1 รายการในกล่องรอตรวจเป็นภาษาคน ตาม reason — ใช้กับแถวปกติเท่านั้น
 * (แถว drift มีกล่องเทียบของตัวเองอยู่แล้ว — DriftCompareBox ในหน้า ไม่ต้องเรียกฟังก์ชันนี้)
 *
 * @param row แถวในกล่องรอตรวจ
 * @param ctx บริบทของสัญญา (จาก getPjReviewContext) — null ถ้ายังโหลดไม่เสร็จ/ไม่มีสัญญา (UNMATCHED)
 */
export function explainReviewRow(row: PjSyncReviewRow, ctx: PjReviewContext | null): string {
  switch (row.reason) {
    case 'AMOUNT_MISMATCH': {
      const isPenalty = row.paymentType === 'penalty' || row.penaltyAmount > 0
      if (isPenalty) {
        const pjAmount = row.paymentType === 'penalty' ? row.amount : row.penaltyAmount
        const target = ctx?.penaltyTarget ?? null
        if (target) {
          return `PJ คิดค่าปรับ ${th(pjAmount)} ฿ (งวดที่ ${target.installmentNo}) · ระบบเราคิด ${th(target.chargedPenalty)} ฿ · สลิป = PJ — กด "ลงตาม PJ" จะปรับยอดเรียกเก็บค่าปรับของงวดนี้ให้ตรงกับ PJ ให้เอง`
        }
        return `PJ คิดค่าปรับ ${th(pjAmount)} ฿ — ระบบหางวดที่จะลงค่าปรับให้ไม่เจอ (อาจจ่ายครบทุกงวดแล้ว) ตรวจสอบก่อนลง`
      }
      return `ยอด ${th(row.amount)} ฿ ไม่ตรงกับยอดที่ระบบคาดไว้ของงวดถัดไป (เช่น จ่ายเกิน/จ่ายซ้อนงวดที่ปิดไปแล้ว) — ตรวจสอบก่อนลง`
    }
    case 'MULTI':
      return `ยอด ${th(row.amount + row.penaltyAmount)} ฿ น่าจะครอบคลุมมากกว่า 1 งวด — กด "ลงตาม PJ" ระบบจะกระจายเงินเข้าหลายงวดให้อัตโนมัติ`
    case 'PARTIAL': {
      const remaining = ctx?.nextUnpaid?.remaining
      const no = ctx?.nextUnpaid?.no
      if (remaining != null && no != null) {
        const short = Math.max(remaining - row.amount, 0)
        return `จ่ายมา ${th(row.amount)} ฿ ยังไม่ครบงวดที่ ${no}${short > 0 ? ` (ขาดอีก ${th(short)} ฿)` : ''} — ระบบจะลงเป็นจ่ายบางส่วนของงวดนั้น`
      }
      return `จ่ายมา ${th(row.amount)} ฿ ยังไม่ครบยอดที่ต้องจ่ายของงวดถัดไป — ระบบจะลงเป็นจ่ายบางส่วน`
    }
    case 'OTHER':
      return `ยอด ${th(row.amount + row.penaltyAmount)} ฿ ไม่ใช่ค่างวด/ค่าปรับตามปกติ — น่าจะเป็นค่าใช้จ่ายอื่น (เช่น ค่าส่งพัสดุ/ค่าธรรมเนียม) แนะนำลงเป็น "รายได้อื่นๆ" แทน`
    case 'UNMATCHED':
      return `หาสัญญาที่ตรงกับเลขใบเสร็จนี้ในระบบเราไม่เจอ — ตรวจสอบเลข INV หรือชื่อลูกค้าใน PJ อีกครั้ง`
    case 'RETURNED_CONTRACT_PAYMENT':
      return `PJ ได้รับเงินเข้าสัญญาคืนเครื่องนี้มากกว่าที่เราบันทึกไว้ ${th(row.amount)} ฿ — PJ ซ่อนใบเสร็จของสัญญาคืนเครื่องไม่ให้ระบบอัตโนมัติเห็น จึงลงให้ไม่ได้ กรุณาเปิดใบเสร็จใน PJ เทียบยอดกับสัญญานี้ แล้วบันทึกเงินที่ขาดด้วยการลงชำระที่หน้าสัญญาโดยตรง (ไม่ใช่จากปุ่มในกล่องนี้)`
    case 'RETURNED_CONTRACT_OVERAGE':
      return `ระบบเราบันทึกไว้มากกว่ายอดที่ PJ ได้รับจริง ${th(row.amount)} ฿ — เปิดใบใน PJ เทียบรายการ อาจมีการลงซ้ำฝั่งเราหรือใบเสร็จถูกลบฝั่ง PJ ต้องให้คนตรวจสอบและแก้ไขด้วยมือที่หน้าสัญญาโดยตรง (ไม่ใช่จากปุ่มในกล่องนี้)`
    case 'RECEIPT_MISSING':
    case 'RECEIPT_CHANGED':
      return '' // แถว drift ใช้ DriftCompareBox แสดงรายละเอียดแทน ไม่ใช้ข้อความนี้
    default:
      return `ยอด ${th(row.amount)} ฿ รอตรวจสอบ`
  }
}

// ---------------------------------------------------------------------------
// 3) บริบทรวมของการ์ด (หลายแถวในกล่องของสัญญาเดียวกัน)
// ---------------------------------------------------------------------------

export interface PjReviewGroupBanner {
  tone: 'green' | 'amber'
  text: string
}

/**
 * บริบทรวมของการ์ด — บอกว่ารายการที่เหลือ "เป็นคนละก้อน ไม่ใช่เงินซ้ำ" (แถบเขียว) หรือเตือนว่า
 * "น่าจะซ้ำจริง" (แถบเหลือง ถ้า hasDuplicateFlag = true จาก detectDuplicatePjReviewRows) — แก้ความสับสน
 * ยอด 400/800 ที่ Pete เจอ (เห็นตัวเลขรวมแล้วนึกว่าเงินซ้ำ ทั้งที่เป็นค่างวด+ค่าปรับคนละก้อน)
 * คืน null ถ้าการ์ดมีแถวปกติ (ไม่ใช่ drift) แค่แถวเดียว — ไม่ต้องอธิบายเพิ่ม
 */
export function explainContractGroupBanner(
  rows: PjSyncReviewRow[],
  ctx: PjReviewContext | null,
  hasDuplicateFlag: boolean,
): PjReviewGroupBanner | null {
  const nonDrift = rows.filter((r) => !isDriftReason(r.reason))
  if (nonDrift.length < 2) return null

  if (hasDuplicateFlag) {
    return {
      tone: 'amber',
      text: 'ระบบตรวจพบว่ามีบางรายการด้านล่างยอด/วันที่/สัญญาตรงกันเป๊ะ — น่าจะเป็นเงินก้อนเดียวกันที่ถูกดึงซ้ำ เช็คให้ชัวร์ก่อนลงทุกรายการ',
    }
  }

  const nextInfo = ctx?.nextUnpaid
    ? `งวดที่ ${ctx.nextUnpaid.no} เก็บได้แล้ว ${th(ctx.nextUnpaid.paid)}/${th(ctx.nextUnpaid.amount)} ฿`
    : ctx
      ? 'ค่างวดครบทุกงวดแล้ว'
      : null

  return {
    tone: 'green',
    text: `${nonDrift.length} รายการด้านล่างนี้เป็นเงินคนละก้อนกัน ไม่ใช่เงินซ้ำ${nextInfo ? ` — ${nextInfo}` : ''}`,
  }
}

// ---------------------------------------------------------------------------
// ชิปประเภทรายการต่อแถว (ตาม mockup Pete: ค่างวด = ฟ้า / ค่าปรับยอดไม่ตรง = เหลือง)
// ---------------------------------------------------------------------------

export interface PjReviewTypeChip {
  label: string
  tone: 'blue' | 'amber' | 'neutral'
}

export function reviewRowTypeChip(row: PjSyncReviewRow): PjReviewTypeChip {
  if (row.reason === 'AMOUNT_MISMATCH' && (row.paymentType === 'penalty' || row.penaltyAmount > 0)) {
    return { label: 'ค่าปรับยอดไม่ตรง', tone: 'amber' }
  }
  if (row.paymentType === 'installment') return { label: 'ค่างวด', tone: 'blue' }
  if (row.paymentType === 'penalty') return { label: 'ค่าปรับ', tone: 'amber' }
  if (row.paymentType === 'other') return { label: 'อื่นๆ', tone: 'neutral' }
  return { label: 'ไม่ระบุประเภท', tone: 'neutral' }
}
