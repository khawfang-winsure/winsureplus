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
  if (riskyRate <= 3) return 'A'
  if (riskyRate <= 8) return 'B'
  if (riskyRate <= 12) return 'C'
  return 'E'
}

const GRADE_ORDER: Record<ShopGrade, number> = { A: 0, B: 1, C: 2, E: 3, '-': 4 }

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
    // ทิ้งงวดแรก = สัญญาที่ยังไม่เคยจ่ายสักงวด (remainingInstallments === termMonths)
    let firstDefaultHolding = 0
    let firstDefaultReturned = 0
    let firstDefaultHoldingValue = 0
    for (const c of shopContracts) {
      const st = statusByContract.get(c.id)
      if (st && st.status === 'active' && RISKY_BUCKETS.has(st.bucket)) risky++
      // เคสล่าสุด = วันที่ทำรายการมากสุด
      if (!lastActivity || c.transactionDate > lastActivity) lastActivity = c.transactionDate
      // ทิ้งงวดแรก: ไม่เคยจ่ายสักงวด (งวดเหลือครบ = ไม่เคยจ่าย) — ใช้นิยามเดียวกับ earlyDefault ใน execDashboard
      const neverPaid = st != null && st.remainingInstallments === c.termMonths
      if (neverPaid) {
        if (c.status === 'active' && st.daysLate > 0) {
          // ยังถือเครื่อง + งวดแรกเลยกำหนดแล้ว (เสียทั้งเงินทั้งเครื่อง)
          firstDefaultHolding++
          firstDefaultHoldingValue += c.financeAmount // เงินเสี่ยง = ยอดจัดไฟแนนซ์
        } else if (c.status === 'returned' || c.status === 'returned_closed') {
          firstDefaultReturned++
        }
      }
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
      firstDefaultHolding,
      firstDefaultReturned,
      firstDefaultHoldingValue,
      firstDefaultHoldingRate: total > 0 ? (firstDefaultHolding / total) * 100 : 0,
      firstDefaultReturnedRate: total > 0 ? (firstDefaultReturned / total) * 100 : 0,
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
    gradeE: rows.filter((r) => r.grade === 'E').length,
  }
}

/** Top N ร้านส่งเคสเยอะสุด (สำหรับกราฟแท่ง) */
export function topShopsByCases(rows: ShopReportRow[], n = 5): ShopReportRow[] {
  return [...rows]
    .filter((r) => r.contracts > 0)
    .sort((a, b) => b.contracts - a.contracts)
    .slice(0, n)
}

const MONTH_TH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']

export interface MonthlyShopStat {
  month: number // 1-12
  label: string
  newShops: number // ร้านที่ส่งเคส "ครั้งแรก" ในเดือนนี้ (ใช้แทนวันร้านเข้าใหม่)
  activeShops: number // ร้านที่ส่งเคสในเดือนนี้ (นับแบบไม่ซ้ำ)
}

/** ปีที่มีข้อมูลเคส (ใหม่สุดก่อน) */
export function yearsFromContracts(contracts: Contract[]): number[] {
  const set = new Set<number>()
  for (const c of contracts) {
    const y = Number(c.transactionDate.slice(0, 4))
    if (y) set.add(y)
  }
  return [...set].sort((a, b) => b - a)
}

/** ร้านใหม่ + ร้านที่ส่งเคสจริง รายเดือนของปีที่เลือก */
export function monthlyShopActivity(contracts: Contract[], year: number): MonthlyShopStat[] {
  // เคสแรกสุดของแต่ละร้าน → ใช้ดู "ร้านเข้าใหม่"
  const firstByShop = new Map<string, string>()
  for (const c of contracts) {
    const cur = firstByShop.get(c.shopId)
    if (!cur || c.transactionDate < cur) firstByShop.set(c.shopId, c.transactionDate)
  }

  const newCounts = Array<number>(12).fill(0)
  for (const date of firstByShop.values()) {
    if (Number(date.slice(0, 4)) === year) {
      const m = Number(date.slice(5, 7))
      if (m >= 1 && m <= 12) newCounts[m - 1]++
    }
  }

  const activeSets = Array.from({ length: 12 }, () => new Set<string>())
  for (const c of contracts) {
    if (Number(c.transactionDate.slice(0, 4)) === year) {
      const m = Number(c.transactionDate.slice(5, 7))
      if (m >= 1 && m <= 12) activeSets[m - 1].add(c.shopId)
    }
  }

  return MONTH_TH.map((label, i) => ({
    month: i + 1,
    label,
    newShops: newCounts[i],
    activeShops: activeSets[i].size,
  }))
}
