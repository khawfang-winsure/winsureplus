// ===== คำนวณรายงานวัดผลร้านค้า (เกรดร้าน) =====
// กฎ: "ลูกค้าเสี่ยง" ฝั่งร้านค้า = สัญญาที่ยังผ่อนอยู่ (active) และล่าช้า 31 วันขึ้นไป
// (ต่างจากฝั่งลูกค้าที่นับหนี้เสียที่ 60 วัน — รายงานนี้เข้มกว่าเพื่อกรองร้านไวๆ)
import type { Contract, ContractStatusRow, Shop, ShopGrade, ShopReportRow } from './types'

const RISKY_BUCKETS = new Set(['31-60', '61-90', '91-120', '120+'])

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
): ShopReportRow[] {
  const statusByContract = new Map(statuses.map((s) => [s.contractId, s]))

  const rows: ShopReportRow[] = shops.map((shop) => {
    const shopContracts = contracts.filter((c) => c.shopId === shop.id)
    const total = shopContracts.length
    const totalSales = shopContracts.reduce((sum, c) => sum + c.devicePrice, 0)

    let risky = 0
    for (const c of shopContracts) {
      const st = statusByContract.get(c.id)
      if (st && st.status === 'active' && RISKY_BUCKETS.has(st.bucket)) risky++
    }
    const good = total - risky
    const riskyRate = total > 0 ? (risky / total) * 100 : 0

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
    }
  })

  // เรียงจากเกรดดีสุด แล้วยอดขายมากสุด
  return rows.sort(
    (a, b) => GRADE_ORDER[a.grade] - GRADE_ORDER[b.grade] || b.totalSales - a.totalSales,
  )
}
