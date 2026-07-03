// ===== ตัวคำนวณ "รายงานประจำเดือนส่ง CEO" (ฟังก์ชันบริสุทธิ์ — แยกจาก UI/DB เพื่อทดสอบง่าย) =====
// รวมข้อมูลจากหลายแหล่ง (สัญญา/สถานะ/งวดแรก/คืนเครื่อง/ร้าน) เป็นรายงาน 6 ส่วนสำหรับหน้า /monthly-report
//
// ⚠️ ห้ามแก้ src/lib/execDashboard.ts และ src/lib/weeklySummary.ts — สูตรที่ใช้ร่วมกัน
// (inRange, daysBetween, pct, r0, ageRange, gradeFor) ถูกคัดลอก/เขียนใหม่เป็น local function
// ในไฟล์นี้แทน กันไฟล์อื่นพัง (เหมือน weeklySummary.ts ทำไว้)
import type { Contract, ContractStatusRow, Shop, DeviceReturnRow } from './types'
import type { FirstInstallmentRow, ContractAggregate } from './db'

// ===== targets (Pete ปรับทีหลังได้) — 9.30/3.71 = baseline ปัจจุบัน ไม่ใช่เป้าจริง =====
export interface MonthlyReportTargets {
  firstDefaultRateTarget: number
  badDebt60Target: number
  late30to60Target: number | null
  riskThresholds: { low: number; mid: number }
}

export const DEFAULT_MONTHLY_TARGETS: MonthlyReportTargets = {
  firstDefaultRateTarget: 9.3,
  badDebt60Target: 3.71,
  late30to60Target: null,
  riskThresholds: { low: 2, mid: 5 },
}

// ===== input =====
export interface MonthlyReportInput {
  contracts: Contract[]
  statuses: ContractStatusRow[]
  firstInstallments: FirstInstallmentRow[]
  returns: DeviceReturnRow[]
  shops: Shop[]
  aggregates: Map<string, ContractAggregate> // จาก getContractAggregates() — ใช้คำนวณ outstanding ต่อสัญญา (เหมือน execDashboard.ts outstandingOf)
}

// ===== local helpers — คัดจาก execDashboard/weeklySummary ห้ามแก้ต้นฉบับ =====
const r0 = (n: number) => Math.round(n)

/** % ปลอดภัย: num/den → 0 ถ้า den=0 (กัน NaN/Infinity) */
function pct(num: number, den: number): number {
  if (den <= 0) return 0
  return (num / den) * 100
}

/** เทียบ ISO timestamp/date ว่าตกในช่วง [start, end] ไหม (ใช้ 10 ตัวแรกของ ISO เป็นวัน, lexicographic — ห้าม Date parse กัน UTC±7 เพี้ยน) */
function inRange(iso: string | null | undefined, start: string, end: string): boolean {
  if (!iso) return false
  const day = iso.length >= 10 ? iso.slice(0, 10) : iso
  return day >= start && day <= end
}

/** จำนวนวันระหว่างสอง ISO date (a − b) หน่วยวัน — ใช้ local date (ไม่สนใจเวลา) */
function daysBetween(aISO: string, bISO: string): number {
  const a = new Date(`${aISO.slice(0, 10)}T00:00:00`)
  const b = new Date(`${bISO.slice(0, 10)}T00:00:00`)
  return Math.round((a.getTime() - b.getTime()) / 86_400_000)
}

/** ช่วงอายุจากปีเกิด (ค.ศ.) — 5 ช่วงสะอาดสำหรับรายงาน CEO: <18/60+/ว่าง รวมเป็น 'อื่นๆ' (คัดจาก format.ts ageRange แต่ตัดปลายทั้งสองข้างตามสเปก CEO) */
function ageRangeClean(birthYear: number | undefined, currentYear: number): string {
  if (!birthYear) return 'อื่นๆ'
  const age = currentYear - birthYear
  if (age < 18) return 'อื่นๆ'
  if (age <= 22) return '18-22'
  if (age <= 30) return '23-30'
  if (age <= 40) return '31-40'
  if (age <= 50) return '41-50'
  if (age <= 60) return '51-60'
  return 'อื่นๆ'
}

/** เกรดจาก % ลูกค้าเสี่ยง — คัดจาก report.ts gradeFor ห้ามแก้ต้นฉบับ */
function gradeFor(riskyRate: number, totalContracts: number): 'A' | 'B' | 'C' | 'E' | '-' {
  if (totalContracts === 0) return '-'
  if (riskyRate <= 3) return 'A'
  if (riskyRate <= 8) return 'B'
  if (riskyRate <= 12) return 'C'
  return 'E'
}

const OCCUPATION_WHITELIST = new Set([
  'พนักงานประจำ',
  'ฟรีแลนซ์/รับจ้างทั่วไป',
  'เจ้าของธุรกิจ',
  'ข้าราชการ',
  'นักเรียน/นักศึกษา',
])
const OTHER_LABEL = 'อื่นๆ'
function normalizeOccupation(occ: string | undefined | null): string {
  if (!occ) return OTHER_LABEL
  return OCCUPATION_WHITELIST.has(occ) ? occ : OTHER_LABEL
}

/**
 * normalize ชื่อรุ่นเครื่องให้รุ่นเดียวกันที่พิมพ์เพี้ยนมา merge กัน (ตัดความจุออก, แก้ case, แก้ Pro Max ติดกัน)
 * ไม่ merge รุ่นที่ต่างกันจริง — iPhone 15 / 15 Plus / 15 Pro / 15 Pro Max ยังแยกกันเหมือนเดิม
 * local เท่านั้น — ไม่ export ใช้ร่วมกับไฟล์อื่น
 */
function normalizeModelName(model: string | undefined | null): string {
  if (!model || !model.trim()) return 'ไม่ระบุรุ่น'
  let s = model.trim().replace(/\s+/g, ' ')

  // แทรกช่องว่างระหว่างตัวอักษรกับเลขที่ติดกัน (ทั้ง 2 ทิศ) ก่อนตัดความจุ
  // กัน "iphone11promax256gb" ไม่ให้ความจุรั่วเข้า key ตอนตัด token ทีหลัง
  s = s.replace(/([a-zA-Z])(\d)/g, '$1 $2')
  // เลข+ตัวอักษรติดกัน แต่ยกเว้นเลข+"e" ท้ายคำ (เช่น "16e" รุ่น iPhone 16e ห้ามแยกเป็น "16 e")
  s = s.replace(/(\d)([a-zA-Z])/g, (m, d: string, l: string, offset: number, str: string) => {
    if (l.toLowerCase() === 'e' && !/^[a-zA-Z]/.test(str.slice(offset + m.length))) return m
    return `${d} ${l}`
  })
  s = s.replace(/\s+/g, ' ').trim()

  // ตัดความจุ 2 สเต็ป:
  // 1) เลข+หน่วยแบบทั่วไป (ครอบ 1TB/2TB/256GB/ทุกเลข+หน่วย — ปลอดภัยเพราะบังคับมีหน่วยต่อท้าย)
  s = s.replace(/\b\d+\s?(gb|g|tb)\b/gi, ' ')
  // 2) เลขความจุเปล่าไม่มีหน่วย ใช้ whitelist กันไปกินเลขรุ่น iPhone 11-17
  s = s.replace(/\b(32|64|128|256|512|1024)\b/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()

  // แทรกช่องว่างระหว่างเลขติดคำ เช่น 15Pro -> 15 Pro (เผื่อกรณีตัดความจุแล้วเลขรุ่นมาติดคำใหม่)
  s = s.replace(/(\d)(pro|plus|max|air|mini)/gi, '$1 $2')
  // แทรกช่องว่างระหว่าง iphone ติดเลข เช่น iPhone11 -> iPhone 11
  s = s.replace(/(iphone)(\d)/gi, '$1 $2')

  // normalize คำว่า iPhone
  s = s.replace(/iphone/gi, 'iPhone')

  // normalize "Pro Max" ก่อน (รวม Promax/promax/pro max/ProMax) — ต้องทำก่อนกฎ pro/max เดี่ยว
  s = s.replace(/pro\s*max/gi, 'Pro Max')

  // normalize คำต่อท้ายเดี่ยวๆ ที่เหลือ
  s = s.replace(/\bpro\b/gi, 'Pro')
  s = s.replace(/\bplus\b/gi, 'Plus')
  s = s.replace(/\bmax\b/gi, 'Max')
  s = s.replace(/\bair\b/gi, 'Air')
  s = s.replace(/\bmini\b/gi, 'mini')

  s = s.replace(/\s+/g, ' ').trim()
  return s || 'ไม่ระบุรุ่น'
}

const RISKY_BUCKETS = new Set(['31-60', '61-90', '91-120', '120+'])

/** วันสุดท้ายของเดือน monthISO ('YYYY-MM') → 'YYYY-MM-DD' */
function lastDayOfMonth(monthISO: string): string {
  const [y, m] = monthISO.split('-').map(Number)
  const lastDay = new Date(y, m, 0).getDate() // m คือเดือนถัดไป (1-indexed) → day 0 = วันสุดท้ายเดือนก่อนหน้า
  return `${monthISO}-${String(lastDay).padStart(2, '0')}`
}

// ===== KPI1: อัตราผิดนัดงวดแรก =====
export interface FirstDefaultKpi {
  numerator: number
  denominator: number
  rate: number // %
}

function buildFirstDefaultKpi(
  contracts: Contract[],
  firstInstallments: FirstInstallmentRow[],
  monthStart: string,
  monthEnd: string,
  todayISO: string,
): FirstDefaultKpi {
  const firstByContract = new Map(firstInstallments.map((f) => [f.contractId, f]))
  let numerator = 0
  let denominator = 0
  for (const c of contracts) {
    if (!inRange(c.transactionDate, monthStart, monthEnd)) continue
    const fi = firstByContract.get(c.id)
    if (!fi) continue // ไม่มีข้อมูลงวด 1 (edge case ป้องกัน crash) → ตัดออก
    if (fi.dueDate > todayISO) continue // งวด 1 ยังไม่ถึงกำหนด → ตัดออกทั้งบนล่าง
    denominator++
    const late = fi.paidAt === null || fi.paidAt.slice(0, 10) > fi.dueDate
    if (late) numerator++
  }
  return { numerator, denominator, rate: pct(numerator, denominator) }
}

// ===== KPI2/3: หนี้เสีย 60+ และล่าช้า 30-60 (count + value) =====
export interface BadDebtKpi {
  count: number
  countDenominator: number
  countRate: number // %
  value: number
  valueDenominator: number
  valueRate: number // %
}

/**
 * value นับจากยอดคงเหลือทั้งสัญญา (outstanding) — สูตรเดียวกับ /exec nplRate เป๊ะ
 * (execDashboard.ts: outstandingOf = aggregates.get(cid)?.totalOutstanding, nplRate = pct(badDebt.value, outstanding)
 * โดย badDebt.value/outstanding รวมจาก active contracts เท่านั้น)
 * ห้ามใช้ s.overdueAmount (=ยอดเฉพาะงวดที่เลยกำหนด) เป็นตัวตั้ง/ตัวหารมูลค่าอีก เพราะจะไม่ตรงกับ /exec
 */
function buildBucketKpi(
  statuses: ContractStatusRow[],
  aggregates: Map<string, ContractAggregate>,
  matchBucket: (bucket: string, daysLate: number) => boolean,
): BadDebtKpi {
  const activeStatuses = statuses.filter((s) => s.status === 'active')
  const outstandingOf = (contractId: string): number => aggregates.get(contractId)?.totalOutstanding ?? 0
  let count = 0
  let value = 0
  let valueDenominator = 0
  for (const s of activeStatuses) {
    const out = outstandingOf(s.contractId)
    valueDenominator += out
    if (matchBucket(s.bucket, s.daysLate)) {
      count++
      value += out
    }
  }
  const countDenominator = activeStatuses.length
  return {
    count,
    countDenominator,
    countRate: pct(count, countDenominator),
    value: r0(value),
    valueDenominator: r0(valueDenominator),
    valueRate: pct(value, valueDenominator),
  }
}

// ===== ส่วน1: ยอดอนุมัติ =====
export interface ApprovalSummary {
  thisMonthTotal: number // Σ financeAmount ในเดือน
  cumulativeTotal: number // Σ financeAmount สะสมถึงสิ้นเดือน
  newContractsCount: number
  thisMonthDeviceTotal: number // Σ devicePrice ในเดือน
}

function buildApprovalSummary(contracts: Contract[], monthStart: string, monthEnd: string): ApprovalSummary {
  let thisMonthTotal = 0
  let cumulativeTotal = 0
  let newContractsCount = 0
  let thisMonthDeviceTotal = 0
  for (const c of contracts) {
    if (c.transactionDate <= monthEnd) cumulativeTotal += c.financeAmount
    if (inRange(c.transactionDate, monthStart, monthEnd)) {
      thisMonthTotal += c.financeAmount
      thisMonthDeviceTotal += c.devicePrice
      newContractsCount++
    }
  }
  return {
    thisMonthTotal: r0(thisMonthTotal),
    cumulativeTotal: r0(cumulativeTotal),
    newContractsCount,
    thisMonthDeviceTotal: r0(thisMonthDeviceTotal),
  }
}

// ===== ส่วน3: มิติ (occupation/age/model) =====
export type RiskLevel = 'low' | 'mid' | 'high'

export interface DimensionRow {
  key: string
  count: number // จำนวนสัญญาในเดือนที่เลือก (cohort)
  pctOfMonth: number // % ของสัญญาทั้งหมดในเดือน
  badDebtCount: number // หนี้เสีย 60+ สะสมทั้งพอร์ตของกลุ่มนี้
  badDebtRate: number // % ของพอร์ตสะสมทั้งหมดของกลุ่ม (ไม่ใช่แค่ cohort เดือนนี้)
  riskLevel: RiskLevel
}

function riskLevelOf(rate: number, thresholds: { low: number; mid: number }): RiskLevel {
  if (rate < thresholds.low) return 'low'
  if (rate <= thresholds.mid) return 'mid'
  return 'high'
}

/** ผลลัพธ์ภายในของ buildDimension — มี portfolioTotal ติดมาด้วยเพื่อรวมกลุ่ม 'อื่นๆ' ได้เป๊ะ (ไม่ต้องคำนวณย้อนกลับจาก rate) */
interface DimensionRowInternal extends DimensionRow {
  portfolioTotal: number
}

/**
 * สร้างมิติความเสี่ยง: cohort เดือนนี้ (count/pctOfMonth) VS พอร์ตสะสมทั้งหมดของกลุ่ม (badDebtRate)
 * keyOf ใช้ทั้งหาสัญญา cohort เดือนนี้ และหาพอร์ตสะสมทั้งหมด (ทุกสถานะ ทุกเดือน) ของกลุ่มเดียวกัน
 */
function buildDimension(
  contracts: Contract[],
  statuses: ContractStatusRow[],
  monthStart: string,
  monthEnd: string,
  keyOf: (c: Contract) => string,
  thresholds: { low: number; mid: number },
): DimensionRowInternal[] {
  const statusByContract = new Map(statuses.map((s) => [s.contractId, s]))

  // cohort เดือนนี้: count ต่อกลุ่ม
  const monthCohort = contracts.filter((c) => inRange(c.transactionDate, monthStart, monthEnd))
  const monthCountByKey = new Map<string, number>()
  for (const c of monthCohort) {
    const key = keyOf(c)
    monthCountByKey.set(key, (monthCountByKey.get(key) ?? 0) + 1)
  }
  const monthTotal = monthCohort.length

  // พอร์ตสะสมทั้งหมด (ทุกสถานะ ทุกเดือน) ต่อกลุ่ม — denominator ของ badDebtRate
  const portfolioTotalByKey = new Map<string, number>()
  const portfolioBadByKey = new Map<string, number>()
  for (const c of contracts) {
    const key = keyOf(c)
    portfolioTotalByKey.set(key, (portfolioTotalByKey.get(key) ?? 0) + 1)
    const st = statusByContract.get(c.id)
    if (st && st.status === 'active' && st.daysLate >= 60) {
      portfolioBadByKey.set(key, (portfolioBadByKey.get(key) ?? 0) + 1)
    }
  }

  // union ของ key ที่ปรากฏใน cohort เดือนนี้ หรือพอร์ตสะสม (กันกลุ่มที่มีแค่พอร์ตเก่าแต่ไม่มี cohort เดือนนี้หาย)
  const allKeys = new Set<string>([...monthCountByKey.keys(), ...portfolioTotalByKey.keys()])

  const rows: DimensionRowInternal[] = []
  for (const key of allKeys) {
    const count = monthCountByKey.get(key) ?? 0
    const portfolioTotal = portfolioTotalByKey.get(key) ?? 0
    const badDebtCount = portfolioBadByKey.get(key) ?? 0
    const badDebtRate = pct(badDebtCount, portfolioTotal)
    rows.push({
      key,
      count,
      pctOfMonth: pct(count, monthTotal),
      badDebtCount,
      badDebtRate,
      riskLevel: riskLevelOf(badDebtRate, thresholds),
      portfolioTotal,
    })
  }
  return rows
}

function stripInternal(rows: DimensionRowInternal[]): DimensionRow[] {
  return rows.map(({ portfolioTotal: _portfolioTotal, ...rest }) => rest)
}

/** อาชีพ — เรียง count desc */
function buildOccupationRows(
  contracts: Contract[],
  statuses: ContractStatusRow[],
  monthStart: string,
  monthEnd: string,
  thresholds: { low: number; mid: number },
): DimensionRow[] {
  const rows = buildDimension(contracts, statuses, monthStart, monthEnd, (c) => normalizeOccupation(c.occupation), thresholds)
  return stripInternal([...rows].sort((a, b) => b.count - a.count))
}

/** อายุ — เรียงตามลำดับช่วงอายุคงที่ (อื่นๆ ท้ายสุด) */
const AGE_ORDER = ['18-22', '23-30', '31-40', '41-50', '51-60', 'อื่นๆ']
function buildAgeRows(
  contracts: Contract[],
  statuses: ContractStatusRow[],
  monthStart: string,
  monthEnd: string,
  monthEndYear: number,
  thresholds: { low: number; mid: number },
): DimensionRow[] {
  const rows = buildDimension(contracts, statuses, monthStart, monthEnd, (c) => ageRangeClean(c.birthYear, monthEndYear), thresholds)
  return stripInternal([...rows].sort((a, b) => AGE_ORDER.indexOf(a.key) - AGE_ORDER.indexOf(b.key)))
}

/** รุ่นเครื่อง — top5 by count เดือนนี้ ที่เหลือรวม 'อื่นๆ' (badDebtRate ของ 'อื่นๆ' รวมจาก portfolioTotal จริง ไม่ได้ประมาณย้อนกลับ) */
function buildModelRows(
  contracts: Contract[],
  statuses: ContractStatusRow[],
  monthStart: string,
  monthEnd: string,
  thresholds: { low: number; mid: number },
): DimensionRow[] {
  const keyOf = (c: Contract) => normalizeModelName(c.model)
  const rows = buildDimension(contracts, statuses, monthStart, monthEnd, keyOf, thresholds)
  const sorted = [...rows].sort((a, b) => b.count - a.count)
  const top5 = sorted.slice(0, 5)
  const rest = sorted.slice(5)
  if (rest.length === 0) return stripInternal(top5)
  const restCount = rest.reduce((s, r) => s + r.count, 0)
  const restBadDebtCount = rest.reduce((s, r) => s + r.badDebtCount, 0)
  const restPortfolioTotal = rest.reduce((s, r) => s + r.portfolioTotal, 0)
  const restBadDebtRate = pct(restBadDebtCount, restPortfolioTotal)
  const restPctOfMonth = rest.reduce((s, r) => s + r.pctOfMonth, 0)
  const otherRow: DimensionRowInternal = {
    key: OTHER_LABEL,
    count: restCount,
    pctOfMonth: restPctOfMonth,
    badDebtCount: restBadDebtCount,
    badDebtRate: restBadDebtRate,
    riskLevel: riskLevelOf(restBadDebtRate, thresholds),
    portfolioTotal: restPortfolioTotal,
  }
  return stripInternal([...top5, otherRow])
}

// ===== ส่วน4: ร้าน =====
export interface ShopMonthlyRow {
  shopId: string
  shopName: string
  casesThisMonth: number
  casesLastMonth: number
  momDelta: number
  grade: 'A' | 'B' | 'C' | 'E' | '-'
}

export interface SilentShopRow {
  shopId: string
  shopName: string
  daysSinceLastCase: number | null
}

function prevMonthRange(monthISO: string): { start: string; end: string } {
  const [y, m] = monthISO.split('-').map(Number)
  const prevM = m === 1 ? 12 : m - 1
  const prevY = m === 1 ? y - 1 : y
  const start = `${prevY}-${String(prevM).padStart(2, '0')}-01`
  const end = lastDayOfMonth(`${prevY}-${String(prevM).padStart(2, '0')}`)
  return { start, end }
}

function buildShopSection(
  contracts: Contract[],
  statuses: ContractStatusRow[],
  shops: Shop[],
  monthISO: string,
  monthStart: string,
  monthEnd: string,
): { top10: ShopMonthlyRow[]; silent: SilentShopRow[] } {
  const { start: prevStart, end: prevEnd } = prevMonthRange(monthISO)
  const statusByContract = new Map(statuses.map((s) => [s.contractId, s]))
  const shopById = new Map(shops.map((s) => [s.id, s]))

  const casesThisMonthByShop = new Map<string, number>()
  const casesLastMonthByShop = new Map<string, number>()
  const lastCaseDateByShop = new Map<string, string>()
  const totalByShop = new Map<string, number>()
  const riskyByShop = new Map<string, number>()
  const nonReturnedByShop = new Map<string, number>()

  for (const c of contracts) {
    if (inRange(c.transactionDate, monthStart, monthEnd)) {
      casesThisMonthByShop.set(c.shopId, (casesThisMonthByShop.get(c.shopId) ?? 0) + 1)
    }
    if (inRange(c.transactionDate, prevStart, prevEnd)) {
      casesLastMonthByShop.set(c.shopId, (casesLastMonthByShop.get(c.shopId) ?? 0) + 1)
    }
    const cur = lastCaseDateByShop.get(c.shopId)
    if (!cur || c.transactionDate > cur) lastCaseDateByShop.set(c.shopId, c.transactionDate)

    totalByShop.set(c.shopId, (totalByShop.get(c.shopId) ?? 0) + 1)
    const isReturned = c.status === 'returned' || c.status === 'returned_closed'
    if (!isReturned) {
      nonReturnedByShop.set(c.shopId, (nonReturnedByShop.get(c.shopId) ?? 0) + 1)
      const st = statusByContract.get(c.id)
      if (st && st.status === 'active' && RISKY_BUCKETS.has(st.bucket)) {
        riskyByShop.set(c.shopId, (riskyByShop.get(c.shopId) ?? 0) + 1)
      }
    }
  }

  const allShopIds = new Set<string>([...totalByShop.keys()])
  const rows: ShopMonthlyRow[] = []
  const silentRows: SilentShopRow[] = []

  for (const shopId of allShopIds) {
    const shop = shopById.get(shopId)
    const shopName = shop?.name || shop?.code || '(ไม่พบชื่อร้าน)'
    const casesThisMonth = casesThisMonthByShop.get(shopId) ?? 0
    const casesLastMonth = casesLastMonthByShop.get(shopId) ?? 0
    const nonReturned = nonReturnedByShop.get(shopId) ?? 0
    const risky = riskyByShop.get(shopId) ?? 0
    const riskyRate = pct(risky, nonReturned)
    const grade = gradeFor(riskyRate, nonReturned)

    if (casesThisMonth === 0) {
      const lastCase = lastCaseDateByShop.get(shopId) ?? null
      silentRows.push({
        shopId,
        shopName,
        daysSinceLastCase: lastCase ? daysBetween(monthEnd, lastCase) : null,
      })
    } else {
      rows.push({ shopId, shopName, casesThisMonth, casesLastMonth, momDelta: casesThisMonth - casesLastMonth, grade })
    }
  }

  const top10 = rows.sort((a, b) => b.casesThisMonth - a.casesThisMonth).slice(0, 10)
  silentRows.sort((a, b) => (b.daysSinceLastCase ?? -1) - (a.daysSinceLastCase ?? -1))

  return { top10, silent: silentRows }
}

// ===== เครื่องคืน =====
export interface DeviceReturnSummary {
  count: number
  valueDeviceTotal: number
  note: string | null
}

function buildDeviceReturnSummary(returns: DeviceReturnRow[], contracts: Contract[], monthStart: string, monthEnd: string): DeviceReturnSummary {
  const contractById = new Map(contracts.map((c) => [c.id, c]))
  let count = 0
  let valueDeviceTotal = 0
  for (const ret of returns) {
    if (!inRange(ret.createdAt, monthStart, monthEnd)) continue
    count++
    valueDeviceTotal += contractById.get(ret.contractId)?.devicePrice ?? 0
  }
  const note =
    monthStart < '2026-07-02'
      ? 'ก่อน 2 ก.ค. 2026 วันคืนอิงวันนำเข้าระบบ อาจคลาดเคลื่อน'
      : null
  return { count, valueDeviceTotal: r0(valueDeviceTotal), note }
}

// ===== ส่วนติดตาม (ยังไม่มีข้อมูล — followUps ว่างเสมอตอนนี้) =====
export interface FollowUpSummary {
  dataUnavailable: boolean
  totalCalls: number | null
  totalPromiseToPay: number | null
  totalKept: number | null
  keptRate: number | null
}

function buildFollowUpSummary(): FollowUpSummary {
  // followUps ยังไม่มี input จาก MonthlyReportInput (รอทีมบันทึกในเว็บ) → ว่างเสมอตอนนี้
  return { dataUnavailable: true, totalCalls: null, totalPromiseToPay: null, totalKept: null, keptRate: null }
}

// ===== รวมทั้งหมด =====
export interface MonthlyReport {
  monthISO: string
  monthStart: string
  monthEnd: string
  asOfISO: string
  kpiFirstDefault: FirstDefaultKpi
  kpiBadDebt60: BadDebtKpi
  kpiLate30to60: BadDebtKpi
  approval: ApprovalSummary
  occupationRows: DimensionRow[]
  ageRows: DimensionRow[]
  modelRows: DimensionRow[]
  shopTop10: ShopMonthlyRow[]
  shopSilent: SilentShopRow[]
  deviceReturn: DeviceReturnSummary
  followUp: FollowUpSummary
  targets: MonthlyReportTargets
}

export function buildMonthlyReport(input: MonthlyReportInput, monthISO: string, targets: MonthlyReportTargets): MonthlyReport {
  if (!/^\d{4}-\d{2}$/.test(monthISO)) {
    throw new Error(`monthISO ไม่ถูกต้อง ต้องเป็นรูปแบบ YYYY-MM: ได้ "${monthISO}"`)
  }
  const monthStart = `${monthISO}-01`
  const monthEnd = lastDayOfMonth(monthISO)
  const todayISO = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)
  const asOfISO = todayISO
  const monthEndYear = Number(monthEnd.slice(0, 4))

  const kpiFirstDefault = buildFirstDefaultKpi(input.contracts, input.firstInstallments, monthStart, monthEnd, todayISO)
  const kpiBadDebt60 = buildBucketKpi(input.statuses, input.aggregates, (_bucket, daysLate) => daysLate >= 60)
  const kpiLate30to60 = buildBucketKpi(input.statuses, input.aggregates, (bucket) => bucket === '31-60')

  const approval = buildApprovalSummary(input.contracts, monthStart, monthEnd)
  const occupationRows = buildOccupationRows(input.contracts, input.statuses, monthStart, monthEnd, targets.riskThresholds)
  const ageRows = buildAgeRows(input.contracts, input.statuses, monthStart, monthEnd, monthEndYear, targets.riskThresholds)
  const modelRows = buildModelRows(input.contracts, input.statuses, monthStart, monthEnd, targets.riskThresholds)
  const { top10: shopTop10, silent: shopSilent } = buildShopSection(input.contracts, input.statuses, input.shops, monthISO, monthStart, monthEnd)
  const deviceReturn = buildDeviceReturnSummary(input.returns, input.contracts, monthStart, monthEnd)
  const followUp = buildFollowUpSummary()

  return {
    monthISO,
    monthStart,
    monthEnd,
    asOfISO,
    kpiFirstDefault,
    kpiBadDebt60,
    kpiLate30to60,
    approval,
    occupationRows,
    ageRows,
    modelRows,
    shopTop10,
    shopSilent,
    deviceReturn,
    followUp,
    targets,
  }
}

// ===== trace-test (comment เท่านั้น — ไม่รันจริง, ไว้ตรวจ logic ด้วยตา) =====
// 1) เดือนว่าง (ไม่มีสัญญาเลย): contracts=[] → approval.thisMonthTotal=0 (ไม่ NaN),
//    occupationRows/ageRows/modelRows=[] (allKeys ว่าง), shopTop10/shopSilent=[] (allShopIds ว่าง),
//    kpiFirstDefault.denominator=0 → rate=pct(0,0)=0 (ไม่ NaN)
// 2) birthYear=1902 (currentYear=2026) → age=124 → ageRangeClean คืน 'อื่นๆ' (age>60)
//    birthYear=2026 (currentYear=2026) → age=0 → 'อื่นๆ' (age<18)
// 3) occupation='ช่างภาพอิสระ' (ไม่อยู่ whitelist) → normalizeOccupation คืน 'อื่นๆ'
//    occupation=undefined/null → 'อื่นๆ'
// 4) งวด 1 ยังไม่ถึงกำหนด: fi.dueDate='2026-08-15' > todayISO='2026-07-03'
//    → ตัดออกทั้ง numerator และ denominator (ไม่นับเป็นทั้งดีและไม่ดี)
// 5) buildBucketKpi ตัวมูลค่า (value/valueDenominator) ใช้ outstandingOf(contractId) = aggregates.get(id)?.totalOutstanding
//    เหมือน execDashboard.ts เป๊ะ → kpiBadDebt60.valueRate ของเดือนปัจจุบัน (as-of วันนี้) ต้องเท่ากับ nplRate ของ /exec
//    ถ้าสัญญาไม่มีแถวใน aggregates (เช่นสัญญาปิดไปแล้วไม่อยู่ view) → outstandingOf คืน 0 (กัน NaN เหมือน execDashboard)
