// ===== รายงานการคืนเครื่อง — Pure Functions =====
// ไม่มี side-effect / ไม่มี I/O — ทดสอบเองได้โดยไม่ต้อง mock DB
// input มาจาก getDeviceReturnReportRows() + getShopContractTotals() ใน db.ts
//
// นิยามเงินที่ใช้ (ตรงกับ view v_device_return_report 0073):
//   principalRemaining = เงินต้นค้าง = sum(greatest(amount - paid_amount, 0)) ของงวด
//                        (ไม่รวมดอก/ค่าปรับสะสม)
//   repairCost         = ค่าซ่อม (repair_cost ?? repair_fee ?? 0)
//   resale             = เงินขายเครื่องคืน (sale_price ?? 0)
//   netDamage          = "ความเสียหายสุทธิ" — คิด "ต่อเคส" max(0, principalRemaining + repairCost − resale)
//                        แล้วค่อยรวม. floor ที่ 0 ต่อเคส = เคสที่ขายเครื่องคืนคุ้มหนี้แล้วนับเป็น 0
//                        (ไม่เอาส่วนที่ขายเกินหนี้ไปกลบเคสอื่น → ยอดรวม/ยอดต่อร้านไม่ติดลบ)
//
// status:
//   returned        = คืนเครื่องแล้ว ยังไม่ปิด (= "เปิด" / open)
//   returned_closed = คืนเครื่อง + รับเงินครบ ปิดเคสแล้ว (= "ปิด" / closed)

import type { DeviceReturnReportRow, ShopContractTotal } from './types'

// ============================================================================
// Output types
// ============================================================================

export interface ReturnKpi {
  totalReturns: number
  open: number               // status = 'returned'
  closed: number             // status = 'returned_closed'
  closeRatePct: number       // closed / total × 100 (0 ถ้า total=0)
  sumPrincipalRemaining: number // รวมเงินต้นค้าง (Σทุกงวด=ความเสี่ยง) เฉพาะเคส open
  sumCollectible: number        // รวมยอดตามเก็บ (1งวด+ปรับ+ซ่อม) เฉพาะเคส open
  sumRepair: number
  sumResale: number
  netDamage: number          // Σ max(0, principalRemaining + repairCost − resale) ต่อเคส (ไม่ติดลบ)
}

export interface ReturnByMonth {
  month: string              // 'yyyy-MM'
  count: number
  principalRemaining: number
}

export interface ReturnByShop {
  shopId: string
  shopName: string
  count: number
  principalRemaining: number
  collectibleRemaining: number     // รวมยอดตามเก็บ (1งวด+ปรับ+ซ่อม) ต่อร้าน
  netDamage: number
}

export interface NeverPaidReturned {
  contractId: string
  contractNo: string
  customerName: string
  shopName: string
  principalRemaining: number
  returnDate: string | null
}

export interface ReturnRateByShop {
  shopId: string
  shopName: string
  returns: number
  totalContracts: number
  ratePct: number            // returns / totalContracts × 100 (0 ถ้าหาร 0)
}

export interface PayBeforeReturn {
  avgPaidInstallments: number          // เฉลี่ย paidInstallments ทุกเคส (0 ถ้าไม่มีเคส)
  riskLowPayCount: number              // จำนวนเคสที่ paidInstallments <= 1
  riskLowPay: NeverPaidReturned[]      // รายการเคสเสี่ยง (paidInstallments <= 1)
}

export interface ReturnPipeline {
  deviceStatus: string
  count: number
  principalRemaining: number
}

export interface CloseRate {
  closed: number
  total: number
  pct: number
}

export interface ReturnReport {
  kpi: ReturnKpi
  byMonth: ReturnByMonth[]
  byShop: ReturnByShop[]
  damageByShop: ReturnByShop[]         // = byShop เรียงตาม netDamage desc
  neverPaidReturned: NeverPaidReturned[]
  returnRateByShop: ReturnRateByShop[]
  payBeforeReturn: PayBeforeReturn
  pipeline: ReturnPipeline[]
  closeRate: CloseRate
}

// ============================================================================
// Helpers
// ============================================================================

const round1 = (x: number): number => Math.round(x * 10) / 10
const round0 = (x: number): number => Math.round(x)

/** netDamage ดิบของ 1 แถว = เงินต้นค้าง + ค่าซ่อม − เงินขายคืน (อาจติดลบ — ผู้เรียก floor ที่ 0 ต่อเคสก่อนรวม) */
function rowNetDamage(r: DeviceReturnReportRow): number {
  return r.principalRemaining + r.repairCost - r.resale
}

const UNKNOWN_SHOP = '(ไม่ระบุร้าน)'

// ============================================================================
// Core: buildReturnReport
// ============================================================================

/**
 * รวบรวมรายงานการคืนเครื่องครบ 9 ส่วนจาก rows + shopTotals
 *
 * @param rows       ทุกสัญญาคืนเครื่อง (getDeviceReturnReportRows)
 * @param shopTotals จำนวนสัญญาทั้งหมดต่อร้าน (getShopContractTotals) — ตัวหารอัตราคืน
 */
export function buildReturnReport(
  rows: DeviceReturnReportRow[],
  shopTotals: ShopContractTotal[],
): ReturnReport {
  const total = rows.length
  const openRows = rows.filter(r => r.status === 'returned')
  const closedRows = rows.filter(r => r.status === 'returned_closed')

  // ---- 1) KPI ----
  const sumPrincipalRemaining = round0(openRows.reduce((s, r) => s + r.principalRemaining, 0))
  const sumCollectible = round0(openRows.reduce((s, r) => s + r.collectibleRemaining, 0))
  const sumRepair = round0(rows.reduce((s, r) => s + r.repairCost, 0))
  const sumResale = round0(rows.reduce((s, r) => s + r.resale, 0))
  const closeRatePct = total > 0 ? round1((closedRows.length / total) * 100) : 0
  const kpi: ReturnKpi = {
    totalReturns: total,
    open: openRows.length,
    closed: closedRows.length,
    closeRatePct,
    sumPrincipalRemaining,
    sumCollectible,
    sumRepair,
    sumResale,
    netDamage: round0(rows.reduce((s, r) => s + Math.max(0, rowNetDamage(r)), 0)),
  }

  // ---- 2) byMonth (จาก returnDate; ข้าม null) ----
  const monthMap = new Map<string, { count: number; principalRemaining: number }>()
  for (const r of rows) {
    if (!r.returnDate) continue
    const month = r.returnDate.slice(0, 7) // 'yyyy-MM' จาก ISO timestamp
    const cur = monthMap.get(month) ?? { count: 0, principalRemaining: 0 }
    cur.count += 1
    cur.principalRemaining += r.principalRemaining
    monthMap.set(month, cur)
  }
  const byMonth: ReturnByMonth[] = [...monthMap.entries()]
    .map(([month, v]) => ({ month, count: v.count, principalRemaining: round0(v.principalRemaining) }))
    .sort((a, b) => a.month.localeCompare(b.month))

  // ---- 3) byShop + 7) damageByShop ----
  const shopMap = new Map<string, { shopName: string; count: number; principalRemaining: number; collectibleRemaining: number; netDamage: number }>()
  for (const r of rows) {
    const key = r.shopId ?? '__none__'
    const cur = shopMap.get(key) ?? {
      shopName: r.shopName ?? UNKNOWN_SHOP, count: 0, principalRemaining: 0, collectibleRemaining: 0, netDamage: 0,
    }
    cur.count += 1
    cur.principalRemaining += r.principalRemaining
    cur.collectibleRemaining += r.collectibleRemaining
    cur.netDamage += Math.max(0, rowNetDamage(r))
    shopMap.set(key, cur)
  }
  const byShop: ReturnByShop[] = [...shopMap.entries()]
    .map(([shopId, v]) => ({
      shopId: shopId === '__none__' ? '' : shopId,
      shopName: v.shopName,
      count: v.count,
      principalRemaining: round0(v.principalRemaining),
      collectibleRemaining: round0(v.collectibleRemaining),
      netDamage: round0(v.netDamage),
    }))
    .sort((a, b) => b.count - a.count)
  const damageByShop = [...byShop].sort((a, b) => b.netDamage - a.netDamage)

  // ---- 4) neverPaidReturned (everPaid=false) ----
  const neverPaidReturned: NeverPaidReturned[] = rows
    .filter(r => !r.everPaid)
    .map(r => ({
      contractId: r.contractId,
      contractNo: r.contractNo,
      customerName: r.customerName,
      shopName: r.shopName ?? UNKNOWN_SHOP,
      principalRemaining: round0(r.principalRemaining),
      returnDate: r.returnDate,
    }))
    .sort((a, b) => b.principalRemaining - a.principalRemaining)

  // ---- 5) returnRateByShop (returns / totalContracts) ----
  const totalsMap = new Map<string, number>()
  for (const t of shopTotals) totalsMap.set(t.shopId, t.total)
  const returnRateByShop: ReturnRateByShop[] = [...shopMap.entries()]
    .filter(([shopId]) => shopId !== '__none__')
    .map(([shopId, v]) => {
      const totalContracts = totalsMap.get(shopId) ?? 0
      const ratePct = totalContracts > 0 ? round1((v.count / totalContracts) * 100) : 0
      return { shopId, shopName: v.shopName, returns: v.count, totalContracts, ratePct }
    })
    .sort((a, b) => b.ratePct - a.ratePct)

  // ---- 6) payBeforeReturn ----
  const avgPaidInstallments = total > 0
    ? round1(rows.reduce((s, r) => s + r.paidInstallments, 0) / total)
    : 0
  const riskLowPayRows = rows.filter(r => r.paidInstallments <= 1)
  const payBeforeReturn: PayBeforeReturn = {
    avgPaidInstallments,
    riskLowPayCount: riskLowPayRows.length,
    riskLowPay: riskLowPayRows
      .map(r => ({
        contractId: r.contractId,
        contractNo: r.contractNo,
        customerName: r.customerName,
        shopName: r.shopName ?? UNKNOWN_SHOP,
        principalRemaining: round0(r.principalRemaining),
        returnDate: r.returnDate,
      }))
      .sort((a, b) => b.principalRemaining - a.principalRemaining),
  }

  // ---- 8) pipeline (deviceStatus not null) ----
  const pipeMap = new Map<string, { count: number; principalRemaining: number }>()
  for (const r of rows) {
    if (!r.deviceStatus) continue
    const cur = pipeMap.get(r.deviceStatus) ?? { count: 0, principalRemaining: 0 }
    cur.count += 1
    cur.principalRemaining += r.principalRemaining
    pipeMap.set(r.deviceStatus, cur)
  }
  const pipeline: ReturnPipeline[] = [...pipeMap.entries()]
    .map(([deviceStatus, v]) => ({ deviceStatus, count: v.count, principalRemaining: round0(v.principalRemaining) }))
    .sort((a, b) => b.count - a.count)

  // ---- 9) closeRate (re-expose) ----
  const closeRate: CloseRate = {
    closed: closedRows.length,
    total,
    pct: closeRatePct,
  }

  return {
    kpi,
    byMonth,
    byShop,
    damageByShop,
    neverPaidReturned,
    returnRateByShop,
    payBeforeReturn,
    pipeline,
    closeRate,
  }
}

// ============================================================================
// Inline trace test (comment) — จำลอง 4 row ครอบ never-paid / closed / pipeline / div0
// ============================================================================
//
// shopTotals = [
//   { shopId: 'S1', total: 10 },   // ร้าน S1 มี 10 สัญญา → 2 คืน = 20%
//   { shopId: 'S2', total: 0  },   // ร้าน S2 total=0 → ratePct ต้อง 0 (กัน div0)
// ]
//
// rows = [
//   // R1: open, เคยจ่าย 3 งวด, เงินต้นค้าง 5000, ตามเก็บ 1800, ซ่อม 1000, ขาย 4000, pipeline=checked, ร้าน S1, มี.ค.
//   { contractId:'a', contractNo:'C1', customerName:'A', shopId:'S1', shopName:'S1',
//     grade:'A', status:'returned', returnDate:'2026-03-10T00:00:00Z', caseNo:1,
//     deviceStatus:'checked', returnMethod:'shipped', totalInstallments:12, paidInstallments:3,
//     everPaid:true, principalRemaining:5000, collectibleRemaining:1800, repairCost:1000, resale:4000, devicePrice:30000 },
//
//   // R2: closed, เคยจ่าย 6 งวด, เงินต้นค้าง 0, ตามเก็บ 0, ซ่อม 0, ขาย 8000, pipeline=shipped, ร้าน S1, มี.ค.
//   { ... status:'returned_closed', returnDate:'2026-03-20...', deviceStatus:'shipped',
//     paidInstallments:6, everPaid:true, principalRemaining:0, collectibleRemaining:0, repairCost:0, resale:8000 }  // shopId S1
//
//   // R3: open, never-paid (paidInstallments 0), เงินต้นค้าง 9000, ตามเก็บ 1600, ไม่มี device_returns (returnDate null,
//   //     deviceStatus null) → ข้าม byMonth + ข้าม pipeline, ร้าน S2
//   { ... shopId:'S2', shopName:'S2', status:'returned', returnDate:null, deviceStatus:null,
//     paidInstallments:0, everPaid:false, principalRemaining:9000, collectibleRemaining:1600, repairCost:0, resale:0 }
//
//   // R4: open, paidInstallments 1 (เสี่ยง low-pay แต่ everPaid=true), เงินต้นค้าง 2000, ตามเก็บ 2000,
//   //     pipeline=in_transit, ไม่มีร้าน (shopId null), เม.ย.
//   { ... shopId:null, shopName:null, status:'returned', returnDate:'2026-04-01...',
//     deviceStatus:'in_transit', paidInstallments:1, everPaid:true, principalRemaining:2000,
//     collectibleRemaining:2000, repairCost:500, resale:0 }
// ]
//
// EXPECTED buildReturnReport(rows, shopTotals):
//
// 1) kpi:
//    total=4, open=3 (R1,R3,R4), closed=1 (R2)
//    closeRatePct = 1/4*100 = 25.0
//    sumPrincipalRemaining (open only: R1,R3,R4) = 5000+9000+2000 = 16000
//    sumCollectible (open only: R1,R3,R4) = 1800+1600+2000 = 5400
//    sumRepair (all) = 1000+0+0+500 = 1500
//    sumResale (all) = 4000+8000+0+0 = 12000
//    netDamage = Σ max(0, perCase): R1=max(0,5000+1000−4000)=2000, R2=max(0,0+0−8000)=0,
//                R3=max(0,9000+0−0)=9000, R4=max(0,2000+500−0)=2500 → 2000+0+9000+2500 = 13500
//
// 2) byMonth (skip R3 null): '2026-03' {count:2, principal:5000+0=5000}, '2026-04' {count:1, principal:2000}
//    เรียง: ['2026-03','2026-04']
//
// 3) byShop (เรียง count desc) — netDamage floor ต่อเคสก่อนรวม (max(0,·)):
//    S1: count 2, principal 5000+0=5000, collectible 1800+0=1800, netDamage max(0,2000)+max(0,−8000)= 2000+0= 2000
//    S2: count 1, principal 9000, collectible 1600, netDamage max(0,9000) = 9000
//    '' (no shop): count 1, principal 2000, collectible 2000, netDamage max(0,2500) = 2500
//    → [S1(2), S2(1), ''(1)] (S2 ก่อน '' เพราะ insertion order เมื่อ count เท่ากัน — stable sort)
//
// 7) damageByShop (เรียง netDamage desc): [S2(9000), ''(2500), S1(2000)]
//
// 4) neverPaidReturned: เฉพาะ R3 (everPaid=false) → [{C3, principal 9000, returnDate null}]
//
// 5) returnRateByShop (เรียง ratePct desc):
//    S1: returns 2 / total 10 = 20.0
//    S2: returns 1 / total 0  = 0 (กัน div0)
//    (ไม่นับกลุ่ม no-shop) → [S1(20.0), S2(0)]
//
// 6) payBeforeReturn:
//    avgPaidInstallments = (3+6+0+1)/4 = 2.5
//    riskLowPayCount = เคส paidInstallments<=1 = R3(0)+R4(1) = 2
//    riskLowPay เรียง principal desc: [R3(9000), R4(2000)]
//
// 8) pipeline (skip R3 null, เรียง count desc): checked{1,5000}, shipped{1,0}, in_transit{1,2000}
//    (count เท่ากันหมด → insertion order: checked, shipped, in_transit)
//
// 9) closeRate: { closed:1, total:4, pct:25.0 }
