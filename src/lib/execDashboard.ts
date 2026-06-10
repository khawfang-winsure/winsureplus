// ===== ตัวคำนวณ Dashboard ผู้บริหาร (ฟังก์ชันบริสุทธิ์ — แยกจาก UI/DB เพื่อทดสอบง่าย) =====
// รวมข้อมูลจากหลายแหล่ง (สัญญา/สถานะ/งวด/ร้าน/การชำระ/ขยายเวลา/คืนเครื่อง) เป็นตัวเลขสรุป
import type { Contract, ContractStatusRow, Shop, DeviceReturnRow, ShopGrade, ShopReportRow } from './types'
import type { InstallmentLite, PaymentLite, ExtensionRecord } from './db'
import { ageRange } from './format'
import { buildShopReport, topShopsByCases } from './report'

const BAD_DEBT_DAYS = 60 // หนี้เสียฝั่งลูกค้า = ล่าช้า ≥ 60 วัน

export interface ExecInput {
  contracts: Contract[]
  statuses: ContractStatusRow[]
  installments: InstallmentLite[]
  shops: Shop[]
  payments: PaymentLite[]
  extensions: ExtensionRecord[]
  returns: DeviceReturnRow[]
  todayISO: string // 'YYYY-MM-DD'
}

export interface StatusGroup { count: number; value: number }
export interface AgingRow { bucket: string; label: string; count: number; value: number }
export interface RiskGroup { key: string; total: number; badDebt: number; rate: number }
export interface TrendPoint { label: string }

export interface ExecDashboard {
  // KPI
  totalContracts: number
  activeContracts: number
  closedContracts: number
  portfolioPayable: number // ยอดผ่อนรวม (Σ ค่างวดทุกงวดของสัญญาที่ผ่อนอยู่)
  portfolioFinance: number // ยอดจัดไฟแนนซ์รวม
  collected: number // ชำระแล้ว (฿)
  outstanding: number // คงค้าง (฿)
  nplRate: number // % หนี้เสีย (มูลค่า)
  // สุขภาพลูกค้า
  normal: StatusGroup
  late: StatusGroup
  badDebt: StatusGroup
  aging: AgingRow[]
  // การเงินเชิงลึก
  collectionRate: number // เก็บได้ ÷ ครบกำหนดถึงวันนี้ (%)
  receivedThisMonth: number
  expectedThisMonth: number
  expectedNextMonth: number
  penaltyTotal: number
  grossMarginEstimate: number
  // ร้านค้า
  shopRows: ShopReportRow[]
  gradeDist: { grade: ShopGrade; count: number; value: number }[]
  topShops: ShopReportRow[]
  silentShops: ShopReportRow[]
  riskyShops: ShopReportRow[]
  // สัญญาณเตือน
  earlyDefault: StatusGroup
  extensionsThisMonth: number
  returnsThisMonth: { count: number; value: number }
  newContractsThisMonth: number
  newShopsThisMonth: number
  // แนวโน้ม 12 เดือน
  trendLabels: string[]
  newCasesByMonth: number[]
  collectedByMonth: number[]
  portfolioByMonth: number[]
  // ความเสี่ยงตามกลุ่ม
  riskByOccupation: RiskGroup[]
  riskByAge: RiskGroup[]
  riskByModel: RiskGroup[]
}

const TH_MON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']

const AGING_BUCKETS: { bucket: string; label: string }[] = [
  { bucket: '1-10', label: '1-10 วัน' },
  { bucket: '11-30', label: '11-30 วัน' },
  { bucket: '31-60', label: '31-60 วัน' },
  { bucket: '61-90', label: '61-90 วัน' },
  { bucket: '91-120', label: '91-120 วัน' },
  { bucket: '120+', label: '120+ วัน' },
]

const r0 = (n: number) => Math.round(n)
const pct = (num: number, den: number) => (den > 0 ? (num / den) * 100 : 0)

/** คีย์เดือนจาก ISO timestamp/date → 'YYYY-M' (เดือน 0-based) */
function monthKey(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${d.getMonth()}`
}

export function buildExecDashboard(input: ExecInput): ExecDashboard {
  const { contracts, statuses, installments, shops, payments, extensions, returns, todayISO } = input
  const today = new Date(`${todayISO}T00:00:00`)
  const curYear = today.getFullYear()
  const curMonthKey = `${curYear}-${today.getMonth()}`
  const nextMonthDate = new Date(curYear, today.getMonth() + 1, 1)
  const nextMonthKey = `${nextMonthDate.getFullYear()}-${nextMonthDate.getMonth()}`

  const statusBy = new Map(statuses.map((s) => [s.contractId, s]))
  const contractById = new Map(contracts.map((c) => [c.id, c]))

  // ----- รวมยอดต่อสัญญาจากตารางงวด -----
  const perContract = new Map<string, { scheduled: number; paid: number }>()
  for (const ins of installments) {
    const cur = perContract.get(ins.contractId) ?? { scheduled: 0, paid: 0 }
    cur.scheduled += ins.amount
    cur.paid += ins.paidAmount
    perContract.set(ins.contractId, cur)
  }
  const outstandingOf = (cid: string) => {
    const p = perContract.get(cid)
    return p ? Math.max(0, p.scheduled - p.paid) : 0
  }

  const active = contracts.filter((c) => c.status === 'active')
  const activeIds = new Set(active.map((c) => c.id))
  const closedContracts = contracts.length - active.length

  // ----- KPI การเงิน (พอร์ต = สัญญาที่ผ่อนอยู่) -----
  let portfolioPayable = 0
  let portfolioFinance = 0
  let collected = 0
  for (const c of active) {
    const p = perContract.get(c.id) ?? { scheduled: 0, paid: 0 }
    portfolioPayable += p.scheduled
    portfolioFinance += c.financeAmount
    collected += p.paid
  }
  const outstanding = Math.max(0, portfolioPayable - collected)

  // ----- สุขภาพลูกค้า + aging + NPL -----
  const normal: StatusGroup = { count: 0, value: 0 }
  const late: StatusGroup = { count: 0, value: 0 }
  const badDebt: StatusGroup = { count: 0, value: 0 }
  const agingMap = new Map<string, StatusGroup>()
  for (const b of AGING_BUCKETS) agingMap.set(b.bucket, { count: 0, value: 0 })

  for (const c of active) {
    const st = statusBy.get(c.id)
    const days = st?.daysLate ?? 0
    const out = outstandingOf(c.id)
    if (days >= BAD_DEBT_DAYS) {
      badDebt.count++
      badDebt.value += out
    } else if (days > 0) {
      late.count++
      late.value += out
    } else {
      normal.count++
      normal.value += out
    }
    if (st && st.bucket !== 'normal') {
      const g = agingMap.get(st.bucket)
      if (g) {
        g.count++
        g.value += out
      }
    }
  }
  const aging: AgingRow[] = AGING_BUCKETS.map((b) => ({ ...b, ...agingMap.get(b.bucket)! }))
  const nplRate = pct(badDebt.value, outstanding)

  // ----- collection rate + กระแสเงินสด (เฉพาะสัญญาที่ผ่อนอยู่ — ไม่นับเคสปิด/คืนเครื่อง) -----
  let dueToDate = 0
  let collectedDue = 0
  let expectedThisMonth = 0
  let expectedNextMonth = 0
  for (const ins of installments) {
    if (!activeIds.has(ins.contractId)) continue
    if (ins.dueDate <= todayISO) {
      dueToDate += ins.amount
      collectedDue += Math.min(ins.paidAmount, ins.amount)
    }
    const remain = Math.max(0, ins.amount - ins.paidAmount)
    const mk = monthKey(ins.dueDate)
    if (mk === curMonthKey) expectedThisMonth += remain
    else if (mk === nextMonthKey) expectedNextMonth += remain
  }
  const collectionRate = pct(collectedDue, dueToDate)

  let receivedThisMonth = 0
  for (const p of payments) {
    if (p.action === 'pay' && monthKey(p.createdAt) === curMonthKey) receivedThisMonth += p.amount
  }

  const penaltyTotal = active.reduce((s, c) => s + (statusBy.get(c.id)?.penaltyDue ?? 0), 0)

  // กำไรคร่าวๆ = Σ (ยอดผ่อนทั้งสัญญา − เงินโอนต้นทุนให้ร้าน)  *ประมาณการ*
  let grossMarginEstimate = 0
  for (const c of active) {
    const afterDown = c.devicePrice * (1 - (c.downPercent || 0) / 100)
    const commission = afterDown * ((c.commissionPercent || 0) / 100)
    const netTransfer = afterDown + commission - (c.docFee || 0)
    grossMarginEstimate += c.monthlyPayment * c.termMonths - netTransfer
  }

  // ----- ร้านค้า -----
  const shopRows = buildShopReport(shops, contracts, statuses, todayISO)
  const GRADES: ShopGrade[] = ['A', 'B', 'C', 'D']
  const gradeDist = GRADES.map((grade) => {
    const rs = shopRows.filter((r) => r.grade === grade)
    return { grade, count: rs.length, value: rs.reduce((s, r) => s + r.totalSales, 0) }
  })
  const topShops = topShopsByCases(shopRows, 5)
  const silentShops = shopRows.filter((r) => r.contracts > 0 && !r.active).slice(0, 5)
  const riskyShops = [...shopRows]
    .filter((r) => r.contracts >= 3 && r.risky > 0)
    .sort((a, b) => b.riskyRate - a.riskyRate)
    .slice(0, 5)

  // ----- สัญญาณเตือน -----
  const earlyDefault: StatusGroup = { count: 0, value: 0 }
  for (const c of active) {
    const st = statusBy.get(c.id)
    if (st && st.remainingInstallments === c.termMonths && st.daysLate > 0) {
      earlyDefault.count++
      earlyDefault.value += outstandingOf(c.id)
    }
  }
  const extensionsThisMonth = extensions.filter((e) => monthKey(e.createdAt) === curMonthKey).length
  let returnsCount = 0
  let returnsValue = 0
  for (const ret of returns) {
    if (monthKey(ret.createdAt) === curMonthKey) {
      returnsCount++
      returnsValue += contractById.get(ret.contractId)?.devicePrice ?? 0
    }
  }
  const newContractsThisMonth = contracts.filter((c) => monthKey(c.transactionDate) === curMonthKey).length

  // ร้านใหม่เดือนนี้ = ร้านที่มีเคสแรกในเดือนนี้
  const firstByShop = new Map<string, string>()
  for (const c of contracts) {
    const cur = firstByShop.get(c.shopId)
    if (!cur || c.transactionDate < cur) firstByShop.set(c.shopId, c.transactionDate)
  }
  let newShopsThisMonth = 0
  for (const d of firstByShop.values()) if (monthKey(d) === curMonthKey) newShopsThisMonth++

  // ----- แนวโน้ม 12 เดือนล่าสุด -----
  const trendKeys: string[] = []
  const trendLabels: string[] = []
  for (let k = 11; k >= 0; k--) {
    const d = new Date(curYear, today.getMonth() - k, 1)
    trendKeys.push(`${d.getFullYear()}-${d.getMonth()}`)
    trendLabels.push(`${TH_MON[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`)
  }
  const newCasesMap = new Map<string, number>()
  for (const c of contracts) {
    const mk = monthKey(c.transactionDate)
    newCasesMap.set(mk, (newCasesMap.get(mk) ?? 0) + 1)
  }
  const collectedMap = new Map<string, number>()
  for (const p of payments) {
    if (p.action !== 'pay') continue
    const mk = monthKey(p.createdAt)
    collectedMap.set(mk, (collectedMap.get(mk) ?? 0) + p.amount)
  }
  const newCasesByMonth = trendKeys.map((k) => newCasesMap.get(k) ?? 0)
  const collectedByMonth = trendKeys.map((k) => r0(collectedMap.get(k) ?? 0))
  // พอร์ตสะสม = มูลค่าผ่อนของสัญญาที่ทำรายการถึงสิ้นเดือนนั้น
  const portfolioByMonth = trendKeys.map((k) => {
    const [y, m] = k.split('-').map(Number)
    const endOfMonth = new Date(y, m + 1, 0)
    let sum = 0
    for (const c of contracts) {
      const td = new Date(`${c.transactionDate}T00:00:00`)
      if (td <= endOfMonth) sum += c.monthlyPayment * c.termMonths
    }
    return r0(sum)
  })

  // ----- ความเสี่ยงตามกลุ่ม (active เท่านั้น) -----
  function riskBy(keyOf: (c: Contract) => string): RiskGroup[] {
    const tot = new Map<string, number>()
    const bad = new Map<string, number>()
    for (const c of active) {
      const key = keyOf(c) || '-'
      tot.set(key, (tot.get(key) ?? 0) + 1)
      if ((statusBy.get(c.id)?.daysLate ?? 0) >= BAD_DEBT_DAYS) bad.set(key, (bad.get(key) ?? 0) + 1)
    }
    return [...tot.entries()]
      .map(([key, total]) => ({ key, total, badDebt: bad.get(key) ?? 0, rate: pct(bad.get(key) ?? 0, total) }))
      .sort((a, b) => b.rate - a.rate || b.total - a.total)
  }
  const riskByOccupation = riskBy((c) => c.occupation ?? '-')
  const riskByAge = riskBy((c) => ageRange(c.birthYear, curYear))
  const riskByModel = riskBy((c) => c.model || '-')

  return {
    totalContracts: contracts.length,
    activeContracts: active.length,
    closedContracts,
    portfolioPayable: r0(portfolioPayable),
    portfolioFinance: r0(portfolioFinance),
    collected: r0(collected),
    outstanding: r0(outstanding),
    nplRate,
    normal,
    late,
    badDebt,
    aging,
    collectionRate,
    receivedThisMonth: r0(receivedThisMonth),
    expectedThisMonth: r0(expectedThisMonth),
    expectedNextMonth: r0(expectedNextMonth),
    penaltyTotal: r0(penaltyTotal),
    grossMarginEstimate: r0(grossMarginEstimate),
    shopRows,
    gradeDist,
    topShops,
    silentShops,
    riskyShops,
    earlyDefault,
    extensionsThisMonth,
    returnsThisMonth: { count: returnsCount, value: r0(returnsValue) },
    newContractsThisMonth,
    newShopsThisMonth,
    trendLabels,
    newCasesByMonth,
    collectedByMonth,
    portfolioByMonth,
    riskByOccupation,
    riskByAge,
    riskByModel,
  }
}
