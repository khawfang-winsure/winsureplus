// ===== ตัวคำนวณ "สรุปรายสัปดาห์" (ฟังก์ชันบริสุทธิ์ — แยกจาก UI/DB เพื่อทดสอบง่าย) =====
// รวมข้อมูลจากหลายแหล่ง (สัญญา/งวดค้าง/คืนเครื่อง/ร้าน) เป็นสรุป 6 หัวข้อสำหรับหน้า /weekly-summary
//
// ⚠️ ห้ามแก้ src/lib/execDashboard.ts — สูตรที่ใช้ร่วมกัน (ยอดดาวน์/คอม, inRange, first-contract-per-shop, aging buckets)
// ถูกคัดลอก/เขียนใหม่เป็น local function ในไฟล์นี้แทน กัน /exec พัง
import type { Contract, Shop, DeviceReturnRow } from './types'
import type { OverdueAsOfRow } from './db'
import { calcSummary } from './calc'

// ===== input =====
export interface WeeklySummaryInput {
  contracts: Contract[]
  overdue: OverdueAsOfRow[] // จาก getOverdueInstallmentsAsOf(rangeEnd)
  returns: DeviceReturnRow[]
  shops: Shop[]
  todayISO: string
}

const r0 = (n: number) => Math.round(n)

/** เทียบ ISO timestamp/date ว่าตกในช่วง [start, end] ไหม (ใช้ 10 ตัวแรกของ ISO เป็นวัน, lexicographic) */
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

// ===== 1. เคสใหม่รายวัน =====
export interface NewCasesDailyRow {
  dateISO: string
  count: number
}
export interface NewCasesDailyResult {
  rows: NewCasesDailyRow[] // เรียงเก่า→ใหม่ รวมวัน count=0
  total: number
}

export function buildNewCasesDaily(contracts: Contract[], rangeStart: string, rangeEnd: string): NewCasesDailyResult {
  const countByDay = new Map<string, number>()
  for (const c of contracts) {
    if (!inRange(c.transactionDate, rangeStart, rangeEnd)) continue
    const day = c.transactionDate.slice(0, 10)
    countByDay.set(day, (countByDay.get(day) ?? 0) + 1)
  }
  const rows: NewCasesDailyRow[] = []
  const start = new Date(`${rangeStart}T00:00:00`)
  const end = new Date(`${rangeEnd}T00:00:00`)
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const dateISO = `${y}-${m}-${day}`
    rows.push({ dateISO, count: countByDay.get(dateISO) ?? 0 })
  }
  const total = rows.reduce((s, r) => s + r.count, 0)
  return { rows, total }
}

// ===== 2. ยอดจ่าย/รับเครื่อง (Pete เคาะ: คอมจ่ายให้ร้าน = ไม่หักคอม) =====
export interface TransferSummaryRow {
  contractId: string
  contractNo: string
  deviceLineFull: number // ราคาเครื่องจริง (รวมคอม) = devicePrice + commission
  down: number
  docFee: number
  netTransfer: number // deviceLineFull − down − docFee
}
export interface TransferSummaryResult {
  rows: TransferSummaryRow[]
  deviceTotal: number
  downTotal: number
  docFeeTotal: number
  netTransferTotal: number
  commissionTotal: number // Σ ค่าคอมมิชชั่นของสัญญาในช่วง (ข้อมูลประกอบ — รวมอยู่ใน deviceTotal/netTransfer แล้ว ไม่ใช่บรรทัดหัก)
}

/**
 * รวมยอดโอนให้ร้านต่อสัญญา — reuse calcSummary (calc.ts) ต่อเคส แทนคิดสูตรเอง
 * กัน afterDown ปัดเศษเพี้ยนจากสูตรกลาง (down_percent/commission_percent เป็นทศนิยมได้)
 *
 * Trace ยืนยัน: devicePrice=19,900 / down 30% / คอม 12% / ค่าเอกสาร 100
 *   s = calcSummary(19900, 30, 12, 100) → afterDown=13,930, commission=1,672, net=15,502
 *   deviceLineFull = 19,900 + 1,672 = 21,572
 *   down           = 19,900 − 13,930 = 5,970
 *   netTransfer    = 21,572 − 5,970 − 100 = 15,502 === s.net ✓
 */
export function buildTransferSummary(contracts: Contract[], rangeStart: string, rangeEnd: string): TransferSummaryResult {
  const rows: TransferSummaryRow[] = []
  let deviceTotal = 0
  let downTotal = 0
  let docFeeTotal = 0
  let netTransferTotal = 0
  let commissionTotal = 0
  for (const c of contracts) {
    if (!inRange(c.transactionDate, rangeStart, rangeEnd)) continue
    const docFee = c.docFee || 0
    // ใช้สูตรกลางเดียวกับ AddContract/DB generated column (calc.ts calcSummary):
    // afterDown ปัดเป็นจำนวนเต็มก่อน แล้วค่อยคิด commission จาก afterDown ที่ปัดแล้ว
    const s = calcSummary(c.devicePrice, c.downPercent || 0, c.commissionPercent || 0, docFee)
    const deviceLineFull = c.devicePrice + s.commission // ราคาเครื่องรวมคอม (คอมจ่ายให้ร้าน)
    const down = c.devicePrice - s.afterDown // หักดาวน์ด้วย afterDown ที่ปัดแล้ว ให้ตารางบวกลบลงตัว
    // ทุกค่าจาก calcSummary/deviceLineFull/down เป็นจำนวนเต็มอยู่แล้ว (ไม่ต้อง r0 ซ้ำ)
    // ยืนยัน: deviceLineFull − down − docFee === s.net เป๊ะ
    rows.push({
      contractId: c.id,
      contractNo: c.contractNo,
      deviceLineFull,
      down,
      docFee,
      netTransfer: s.net,
    })
    deviceTotal += deviceLineFull
    downTotal += down
    docFeeTotal += docFee
    netTransferTotal += s.net
    commissionTotal += s.commission
  }
  return {
    rows,
    deviceTotal,
    downTotal,
    docFeeTotal,
    netTransferTotal,
    commissionTotal,
  }
}

// ===== 3. หนี้เสีย ณ วันสิ้นช่วง (Pete เคาะ: ทุกระดับความล่าช้า) =====
const AGING_BUCKETS: { bucket: string; label: string; minDays: number; maxDays: number }[] = [
  { bucket: '1-10', label: '1-10 วัน', minDays: 1, maxDays: 10 },
  { bucket: '11-30', label: '11-30 วัน', minDays: 11, maxDays: 30 },
  { bucket: '31-60', label: '31-60 วัน', minDays: 31, maxDays: 60 },
  { bucket: '61-90', label: '61-90 วัน', minDays: 61, maxDays: 90 },
  { bucket: '91-120', label: '91-120 วัน', minDays: 91, maxDays: 120 },
  { bucket: '120+', label: '120+ วัน', minDays: 121, maxDays: Infinity },
]
const BAD_DEBT_DAYS = 60 // สอดคล้องกับ execDashboard.ts (ห้ามแก้ต้นฉบับ — คัดลอกค่าคงที่มาไว้ที่นี่)

/** สถานะที่ถือว่า "ยังถือเครื่อง/มีหนี้จริง" — ไม่นับ returned/returned_closed/closed/online */
const HOLDING_STATUSES = new Set(['active'])

export interface BadDebtBucketRow {
  bucket: string
  label: string
  count: number // จำนวนสัญญา
  value: number // Σ (amount − paidAmount) ของงวดค้างในกลุ่มนี้
}
export interface BadDebtSnapshotResult {
  buckets: BadDebtBucketRow[] // ทุก bucket 1-10 ... 120+
  badDebtCount: number // เฉพาะ 60 วันขึ้นไป (61-90 + 91-120 + 120+)
  badDebtValue: number
  asOfDate: string
}

export function buildBadDebtSnapshot(
  overdue: OverdueAsOfRow[],
  contracts: Contract[],
  rangeEnd: string,
): BadDebtSnapshotResult {
  const contractById = new Map(contracts.map((c) => [c.id, c]))

  // งวดค้างเก่าสุด (dueDate เล็กสุด) ต่อสัญญา
  const oldestDueByContract = new Map<string, string>()
  const outstandingByContract = new Map<string, number>()
  for (const o of overdue) {
    const c = contractById.get(o.contractId)
    if (!c || !HOLDING_STATUSES.has(c.status)) continue
    const cur = oldestDueByContract.get(o.contractId)
    if (!cur || o.dueDate < cur) oldestDueByContract.set(o.contractId, o.dueDate)
    // ตั้งใจไม่รวม o.penaltyDue — mirror execDashboard.ts (คิดเฉพาะเงินต้นค้าง ไม่รวมค่าปรับสะสม)
    const remain = Math.max(0, o.amount - o.paidAmount)
    outstandingByContract.set(o.contractId, (outstandingByContract.get(o.contractId) ?? 0) + remain)
  }

  const bucketMap = new Map<string, { count: number; value: number }>()
  for (const b of AGING_BUCKETS) bucketMap.set(b.bucket, { count: 0, value: 0 })

  for (const [contractId, oldestDue] of oldestDueByContract) {
    const daysLate = daysBetween(rangeEnd, oldestDue)
    if (daysLate <= 0) continue // ไม่ล่าช้า ณ วันสิ้นช่วง
    const bucketDef = AGING_BUCKETS.find((b) => daysLate >= b.minDays && daysLate <= b.maxDays)
    if (!bucketDef) continue
    const g = bucketMap.get(bucketDef.bucket)!
    g.count++
    g.value += outstandingByContract.get(contractId) ?? 0
  }

  const buckets: BadDebtBucketRow[] = AGING_BUCKETS.map((b) => ({
    bucket: b.bucket,
    label: b.label,
    count: bucketMap.get(b.bucket)!.count,
    value: r0(bucketMap.get(b.bucket)!.value),
  }))

  const badBuckets = buckets.filter((b) => AGING_BUCKETS.find((a) => a.bucket === b.bucket)!.minDays >= BAD_DEBT_DAYS)
  const badDebtCount = badBuckets.reduce((s, b) => s + b.count, 0)
  const badDebtValue = badBuckets.reduce((s, b) => s + b.value, 0)

  return { buckets, badDebtCount, badDebtValue, asOfDate: rangeEnd }
}

// ===== 4. คืนเครื่องในช่วง =====
export interface ReturnsInRangeResult {
  count: number
  value: number // Σ devicePrice ของสัญญานั้น
  note: string | null // footnote ถ้า range ก่อน 2 ก.ค. 2026
}

export function buildReturnsInRange(
  returns: DeviceReturnRow[],
  contracts: Contract[],
  rangeStart: string,
  rangeEnd: string,
): ReturnsInRangeResult {
  const contractById = new Map(contracts.map((c) => [c.id, c]))
  let count = 0
  let value = 0
  for (const ret of returns) {
    if (!inRange(ret.createdAt, rangeStart, rangeEnd)) continue
    count++
    value += contractById.get(ret.contractId)?.devicePrice ?? 0
  }
  const note =
    rangeStart < '2026-07-02'
      ? 'ข้อมูลคืนเครื่องก่อน 2 ก.ค. 2026 อาจเป็นวันนำเข้าระบบ ไม่ใช่วันคืนจริง'
      : null
  return { count, value: r0(value), note }
}

// ===== 5. ขายเครื่องในช่วง =====
export interface SalesInRangeResult {
  count: number
  saleTotal: number
}

export function buildSalesInRange(returns: DeviceReturnRow[], rangeStart: string, rangeEnd: string): SalesInRangeResult {
  let count = 0
  let saleTotal = 0
  for (const ret of returns) {
    if (ret.pricedAt == null) continue
    if (!inRange(ret.pricedAt, rangeStart, rangeEnd)) continue
    count++
    saleTotal += ret.salePrice ?? 0
  }
  return { count, saleTotal: r0(saleTotal) }
}

// ===== 6. ร้านใหม่ในช่วง (Pete เคาะ: โชว์ทั้ง 2 วัน) =====
export interface NewShopRow {
  shopId: string
  shopName: string
  recruitedAt: string | null
  firstContractAt: string
}

export function buildNewShops(contracts: Contract[], shops: Shop[], rangeStart: string, rangeEnd: string): NewShopRow[] {
  const shopById = new Map(shops.map((s) => [s.id, s]))
  const firstByShop = new Map<string, string>()
  for (const c of contracts) {
    const cur = firstByShop.get(c.shopId)
    if (!cur || c.transactionDate < cur) firstByShop.set(c.shopId, c.transactionDate)
  }
  const rows: NewShopRow[] = []
  for (const [shopId, firstContractAt] of firstByShop) {
    if (!inRange(firstContractAt, rangeStart, rangeEnd)) continue
    const shop = shopById.get(shopId)
    rows.push({
      shopId,
      shopName: shop?.name || shop?.code || '(ไม่พบชื่อร้าน)',
      recruitedAt: shop?.recruitedAt ?? null,
      firstContractAt,
    })
  }
  rows.sort((a, b) => a.firstContractAt.localeCompare(b.firstContractAt))
  return rows
}

// ===== รวม 6 หัวข้อ =====
export interface WeeklySummary {
  rangeStart: string
  rangeEnd: string
  newCasesDaily: NewCasesDailyResult
  transferSummary: TransferSummaryResult
  badDebtSnapshot: BadDebtSnapshotResult
  returnsInRange: ReturnsInRangeResult
  salesInRange: SalesInRangeResult
  newShops: NewShopRow[]
}

export function buildWeeklySummary(input: WeeklySummaryInput, rangeStart: string, rangeEnd: string): WeeklySummary {
  // edge: rangeStart > rangeEnd → swap
  let start = rangeStart
  let end = rangeEnd
  if (start > end) {
    const tmp = start
    start = end
    end = tmp
  }

  return {
    rangeStart: start,
    rangeEnd: end,
    newCasesDaily: buildNewCasesDaily(input.contracts, start, end),
    transferSummary: buildTransferSummary(input.contracts, start, end),
    badDebtSnapshot: buildBadDebtSnapshot(input.overdue, input.contracts, end),
    returnsInRange: buildReturnsInRange(input.returns, input.contracts, start, end),
    salesInRange: buildSalesInRange(input.returns, start, end),
    newShops: buildNewShops(input.contracts, input.shops, start, end),
  }
}
