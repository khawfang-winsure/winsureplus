// ===== ติดตามเอกสารตัวจริง + กล่องโทรศัพท์ (Wave 2 — 0050) =====
// Pure functions — ไม่มี side effect, testable โดยไม่ต้องการ Supabase
import type { Contract } from './types'

// ---------------------------------------------------------------------------
// กฎ "มือหนึ่งต้องมีกล่อง" — Pete เคาะ 2026-06-21
// สัญญาใหม่ condition='new' ที่สร้างตั้งแต่วันนี้เป็นต้นไปต้องส่งกล่อง
// สัญญาเก่า 467 สัญญา (PJ import, createdAt < CUTOFF) ยกเว้น ไม่บังคับกล่อง
// ---------------------------------------------------------------------------
export const DOC_BOX_RULE_CUTOFF = '2026-06-21' // วันที่ deploy กฎนี้ (Pete sign-off)

// ---------------------------------------------------------------------------
// ธง "รับเอกสารแล้ว แต่ไม่ครบ/ต้องแก้ไข" (0070)
// 3 ชนิดเอกสารที่ขาดได้ — คีย์คงที่ (เก็บใน docs_incomplete_items)
// ไม่กระทบ isDocComplete (เคสยังถือว่ารับแล้ว) แค่ติดธงเตือน
// ---------------------------------------------------------------------------
export const DOC_ITEM_KEYS = ['contract', 'consent', 'receipt'] as const

export const DOC_ITEM_LABELS: Record<string, string> = {
  contract: 'เอกสารสัญญา',
  consent: 'เอกสารยินยอม',
  receipt: 'ใบเสร็จ',
}

/**
 * แปลง array ของคีย์เอกสารที่ขาด → ป้ายภาษาไทยคั่นด้วย ", "
 * เรียงตามลำดับ DOC_ITEM_KEYS เสมอ (ไม่อิงลำดับใน input)
 * @example formatIncompleteItems(['receipt','contract']) === 'เอกสารสัญญา, ใบเสร็จ'
 * @example formatIncompleteItems([]) === ''
 */
export function formatIncompleteItems(items: string[]): string {
  return DOC_ITEM_KEYS.filter((k) => items.includes(k))
    .map((k) => DOC_ITEM_LABELS[k])
    .join(', ')
}

export interface ShopDocStats {
  shopId: string
  pendingDocsCount: number   // สัญญาที่ originalDocsReceived=false
  pendingBoxCount: number    // สัญญาที่ boxRequired=true && phoneBoxReceived=false
  totalPendingCount: number  // union: สัญญาที่ไม่ complete (ไม่นับซ้ำ)
  completedCount: number     // สัญญาที่ complete
  avgDaysOpen: number | null // เฉลี่ยวันค้างของ open cases (null ถ้าไม่มี open ที่มี transactionDate)
  maxDaysOpen: number | null // สูงสุดวันค้างของ open cases (null เช่นเดียวกัน)
}

/**
 * ตัดสินว่าสัญญานี้ "ต้องมีกล่อง" หรือเปล่า
 *
 * กฎ:
 *   - มือหนึ่ง (condition='new') AND createdAt >= CUTOFF  → บังคับกล่อง
 *   - มือสอง ที่ staff ติ๊ก hasPhoneBox=true เอง          → บังคับกล่อง
 *   - อื่นๆ (มือสองไม่มีกล่อง / เครื่องเก่าก่อน cutoff)  → ไม่บังคับ
 *
 * Note: createdAt missing (undefined/'') → '' < CUTOFF → grandfathered (ตั้งใจ)
 *       ใช้งานได้ใน mock dev mode ที่ไม่มี createdAt
 */
export function boxRequired(c: Contract): boolean {
  const isNewDevice = c.condition === 'new'
  // slice(0,10) กัน 'T' timezone suffix — compare date-only string กับ CUTOFF
  const isAfterCutoff = (c.createdAt ?? '').slice(0, 10) >= DOC_BOX_RULE_CUTOFF
  return (isNewDevice && isAfterCutoff) || (c.hasPhoneBox === true)
}

/**
 * ตรวจว่าสัญญา "รับครบแล้ว" หรือยัง
 *
 * กฎ:
 *   - originalDocsReceived = true
 *   - ถ้า boxRequired → phoneBoxReceived = true ด้วย
 *
 * Trace tests:
 * (1) new + createdAt='2026-06-21' + originalDocsReceived=true + hasPhoneBox=false + phoneBoxReceived=false
 *     boxRequired = true (new && >= cutoff)
 *     complete = true && (true → false) = false  ✗ ไม่ครบ (ยังไม่รับกล่อง)
 *
 * (2) new + createdAt='2026-06-15' (ก่อน cutoff) + originalDocsReceived=true + hasPhoneBox=false + phoneBoxReceived=false
 *     boxRequired = false ('2026-06-15' < '2026-06-21', hasPhoneBox=false)
 *     complete = true && (!false) = true  ✓ ครบ (เครื่องเก่าก่อน cutoff)
 *
 * (3) used + createdAt='2026-06-21' + originalDocsReceived=true + hasPhoneBox=false + phoneBoxReceived=false
 *     boxRequired = false (isNewDevice=false, hasPhoneBox=false)
 *     complete = true && true = true  ✓ ครบ (มือสองไม่มีกล่อง)
 *
 * (4) used + createdAt=any + originalDocsReceived=true + hasPhoneBox=true + phoneBoxReceived=false
 *     boxRequired = true (hasPhoneBox=true)
 *     complete = true && (true → false) = false  ✗ ไม่ครบ (staff ติ๊กว่ามีกล่องแต่ยังไม่รับ)
 *
 * (5) new + createdAt='2026-06-21' + originalDocsReceived=true + hasPhoneBox=false + phoneBoxReceived=true
 *     boxRequired = true (new && >= cutoff)
 *     complete = true && (true → true) = true  ✓ ครบ (รับกล่องแล้ว)
 */
export function isDocComplete(c: Contract): boolean {
  const required = boxRequired(c)
  return (
    c.originalDocsReceived === true &&
    (!required || c.phoneBoxReceived === true)
  )
}

/**
 * คำนวณสถิติเอกสาร/กล่องรายร้าน
 * @param contracts รายการสัญญาทั้งหมด (ส่งครบ ฟังก์ชัน filter shopId เอง)
 * @param shopId รหัสร้านที่ต้องการ
 * @param referenceDate วันอ้างอิง (default: new Date()) — รับ arg เพื่อ test
 *
 * @example
 * // trace test — today 2026-06-21, ร้าน X 4 สัญญา
 * // สัญญา 1: transactionDate='2026-06-01', condition='new', createdAt='2026-06-21',
 * //           originalDocsReceived=true, hasPhoneBox=false, phoneBoxReceived=false
 * //           → boxRequired=true, isDocComplete=false → pendingBox
 * // สัญญา 2: transactionDate='2026-06-09', condition='new', createdAt='2026-06-10',
 * //           originalDocsReceived=true, hasPhoneBox=false, phoneBoxReceived=false
 * //           → boxRequired=false (createdAt<cutoff), isDocComplete=true → completed
 * // สัญญา 3: transactionDate='2026-06-07', condition='used', createdAt='2026-06-21',
 * //           originalDocsReceived=false, hasPhoneBox=true, phoneBoxReceived=false
 * //           → boxRequired=true (hasPhoneBox), isDocComplete=false → pendingDocs+pendingBox
 * // สัญญา 4: transactionDate='2026-06-15', condition='used', createdAt=undefined,
 * //           originalDocsReceived=true, hasPhoneBox=false, phoneBoxReceived=false
 * //           → boxRequired=false, isDocComplete=true → completed
 * // ผล: pendingDocs=1, pendingBox=2, totalPending=2, completed=2
 */
export function shopDocStats(
  contracts: Contract[],
  shopId: string,
  referenceDate: Date = new Date(),
): ShopDocStats {
  const shop = contracts.filter((c) => c.shopId === shopId)

  const refMs = referenceDate.getTime()

  // วันค้าง (วันนี้ - transactionDate) ปัดลง — skip ถ้าไม่มี date
  function daysOpen(c: Contract): number | null {
    if (!c.transactionDate) return null
    const txMs = new Date(c.transactionDate).getTime()
    if (isNaN(txMs)) return null
    return Math.floor((refMs - txMs) / (1000 * 60 * 60 * 24))
  }

  const pendingDocsCount = shop.filter((c) => c.originalDocsReceived !== true).length

  const pendingBoxCount = shop.filter(
    (c) => boxRequired(c) && c.phoneBoxReceived !== true,
  ).length

  const openCases = shop.filter((c) => !isDocComplete(c))
  const totalPendingCount = openCases.length

  const completedCount = shop.filter((c) => isDocComplete(c)).length

  // วันค้างของ open cases ที่มี transactionDate เท่านั้น
  const openDays: number[] = openCases
    .map((c) => daysOpen(c))
    .filter((d): d is number => d !== null)

  const avgDaysOpen =
    openDays.length > 0
      ? Math.round(openDays.reduce((s, d) => s + d, 0) / openDays.length)
      : null

  const maxDaysOpen =
    openDays.length > 0 ? Math.max(...openDays) : null

  return {
    shopId,
    pendingDocsCount,
    pendingBoxCount,
    totalPendingCount,
    completedCount,
    avgDaysOpen,
    maxDaysOpen,
  }
}
