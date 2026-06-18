// ===== ติดตามเอกสารตัวจริง + กล่องโทรศัพท์ (Wave 2 — 0050) =====
// Pure functions — ไม่มี side effect, testable โดยไม่ต้องการ Supabase
import type { Contract } from './types'

export interface ShopDocStats {
  shopId: string
  pendingDocsCount: number   // สัญญาที่ originalDocsReceived=false
  pendingBoxCount: number    // สัญญาที่ hasPhoneBox=true && phoneBoxReceived=false
  totalPendingCount: number  // union: สัญญาที่ไม่ complete (ไม่นับซ้ำ)
  completedCount: number     // สัญญาที่ complete
  avgDaysOpen: number | null // เฉลี่ยวันค้างของ open cases (null ถ้าไม่มี open ที่มี transactionDate)
  maxDaysOpen: number | null // สูงสุดวันค้างของ open cases (null เช่นเดียวกัน)
}

/**
 * ตรวจว่าสัญญา "รับครบแล้ว" หรือยัง
 * กฎ: originalDocsReceived=true AND (hasPhoneBox=false OR phoneBoxReceived=true)
 */
export function isDocComplete(c: Contract): boolean {
  return (
    c.originalDocsReceived === true &&
    (c.hasPhoneBox === false || c.phoneBoxReceived === true)
  )
}

/**
 * คำนวณสถิติเอกสาร/กล่องรายร้าน
 * @param contracts รายการสัญญาทั้งหมด (ส่งครบ ฟังก์ชัน filter shopId เอง)
 * @param shopId รหัสร้านที่ต้องการ
 * @param referenceDate วันอ้างอิง (default: new Date()) — รับ arg เพื่อ test
 *
 * @example
 * // trace test — today 2026-06-19, ร้าน X 4 สัญญา
 * // สัญญา 1: transactionDate='2026-06-01', docs=false, hasBox=false → incomplete
 * // สัญญา 2: transactionDate='2026-06-09', docs=false, hasBox=true,  boxReceived=false → incomplete
 * // สัญญา 3: transactionDate='2026-06-07', docs=true,  hasBox=true,  boxReceived=false → incomplete
 * // สัญญา 4: transactionDate='2026-06-15', docs=true,  hasBox=false  → complete
 * // ผล: pendingDocs=2, pendingBox=2, totalPending=3, completed=1
 * //      open days [18,10,12] → avg=Math.round(40/3)=13, max=18
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
    (c) => c.hasPhoneBox === true && c.phoneBoxReceived !== true,
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
