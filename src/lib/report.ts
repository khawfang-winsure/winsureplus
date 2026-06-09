// ===== คำนวณรายงานวัดผลร้านค้า (เกรดร้าน + ความเคลื่อนไหว) =====
// กฎ: "ลูกค้าเสี่ยง" ฝั่งร้านค้า = สัญญาที่ยังผ่อนอยู่ (active) และล่าช้า 31 วันขึ้นไป
// (ต่างจากฝั่งลูกค้าที่นับหนี้เสียที่ 60 วัน — รายงานนี้เข้มกว่าเพื่อกรองร้านไวๆ)
import type {
  Contract,
  ContractStatusRow,
  Shop,
  ShopGrade,
  ShopReportRow,
  ShopReportSummary,
} from './types'

const RISKY_BUCKETS = new Set(['31-60', '61-90', '91-120', '120+'])

// ร้านที่ "ยังเคลื่อนไหว" = มีเคสใหม่ภายในกี่วันนี้
export const ACTIVE_WINDOW_DAYS = 30

/** จำนวนวันระหว่าง 2 วันที่ (ISO yyyy-mm-dd) */
function daysBetween(fromISO: string, toISO: string): number {
  const ms = Date.parse(toISO) - Date.parse(fromISO)
  return Math.floor(ms / 86_400_000)
}

/** เกรดจาก % ลูกค้าเสี่ยง */
export function gradeFor(riskyRate: number, totalContracts: number): ShopGrade {
  if (totalContracts === 0) return '-'
  if (riskyRate < 5) return 'A'
  if (riskyRate < 15) return 'B'
  if (riskyRate < 30) return 'C'
  return 'D'
}

const GRADE_ORDER: Record<ShopGrade, number> = { A: 0, B: 1, C: 2, D: 3, '-': 4 }

export function buildShopReport(
  shops: Shop[],
  contracts: Contract[],
  statuses: ContractStatusRow[],
  todayISO: string,
): ShopReportRow[] {
  const statusByContract = new Map(statuses.map((s) => [s.contractId, s]))

  const rows: ShopReportRow[] = shops.map((shop) => {
    const shopContracts = contracts.filter((c) => c.shopId === shop.id)
    const total = shopContracts.length
    const totalSales = shopContracts.reduce((sum, c) => sum + c.devicePrice, 0)

    let risky = 0
    let lastActivity: string | null = null
    for (const c of shopContracts) {
      const st = statusByContract.get(c.id)
      if (st && st.status === 'active' && RISKY_BUCKETS.has(st.bucket)) risky++
      // เคสล่าสุด = วันที่ทำรายการมากสุด
      if (!lastActivity || c.transactionDate > lastActivity) lastActivity = c.transactionDate
    }
    const good = total - risky
    const riskyRate = total > 0 ? (risky / total) * 100 : 0
    const daysSinceActivity = lastActivity ? daysBetween(lastActivity, todayISO) : null
    const active = daysSinceActivity != null && daysSinceActivity <= ACTIVE_WINDOW_DAYS

    return {
      shopId: shop.id,
      code: shop.code,
      name: shop.name,
      contracts: total,
      totalSales,
      good,
      risky,
      riskyRate,
      grade: gradeFor(riskyRate, total),
      lastActivity,
      daysSinceActivity,
      active,
    }
  })

  // เรียงจากเกรดดีสุด แล้วยอดขายมากสุด
  return rows.sort(
    (a, b) => GRADE_ORDER[a.grade] - GRADE_ORDER[b.grade] || b.totalSales - a.totalSales,
  )
}

/** สรุปภาพรวมสำหรับการ์ด dashboard */
export function shopReportSummary(rows: ShopReportRow[]): ShopReportSummary {
  const totalShops = rows.length
  const topShop = rows.reduce<ShopReportRow | null>(
    (best, r) => (r.contracts > 0 && (!best || r.contracts > best.contracts) ? r : best),
    null,
  )
  const activeShops = rows.filter((r) => r.active).length
  // ร้านที่ "เคยส่งเคส" แต่เงียบเกิน 30 วัน
  const inactiveShops = rows.filter((r) => r.contracts > 0 && !r.active).length
  const activePercent = totalShops > 0 ? (activeShops / totalShops) * 100 : 0

  return {
    totalShops,
    topShop,
    activeShops,
    activePercent,
    inactiveShops,
    gradeA: rows.filter((r) => r.grade === 'A').length,
    gradeD: rows.filter((r) => r.grade === 'D').length,
  }
}

/** Top N ร้านส่งเคสเยอะสุด (สำหรับกราฟแท่ง) */
export function topShopsByCases(rows: ShopReportRow[], n = 5): ShopReportRow[] {
  return [...rows]
    .filter((r) => r.contracts > 0)
    .sort((a, b) => b.contracts - a.contracts)
    .slice(0, n)
}
