// ===== วิเคราะห์ภาพรวมลูกค้า (ปกติ / ล่าช้า / หนี้เสีย) =====
// กฎฝั่งลูกค้า: หนี้เสีย = ค้างชำระ 60 วันขึ้นไป (ต่างจากฝั่งร้านที่ 31 วัน)
import type { Contract, ContractStatusRow, OverdueBucket, Shop } from './types'

export const BAD_DAYS = 60

// กลุ่มความล่าช้า (ตามแถบเมนูด้านซ้าย)
export const BUCKETS: OverdueBucket[] = ['normal', '1-10', '11-30', '31-60', '61-90', '91-120', '120+']
const BAD_BUCKETS = new Set<OverdueBucket>(['61-90', '91-120', '120+'])

export type CustomerCategory = 'normal' | 'late' | 'bad' | 'closed'

export interface CustomerRow {
  contractId: string
  contractNo: string
  customerName: string
  shopId: string
  shopName: string
  category: CustomerCategory
  bucket: OverdueBucket
  daysLate: number
  nextDue: string | null // วันครบกำหนดงวดค้างเก่าสุด
  occupation: string
  ageGroup: string
  model: string
  promotion: string
  term: string
  downRate: string
  condition: string
  origin: string
  firstDefault: boolean // ไม่จ่ายตั้งแต่งวดแรก (ไม่เคยจ่ายเลย + เลยกำหนด)
  lateMonth: string | null
  badMonth: string | null
}

export type Dimension =
  | 'all'
  | 'occupation'
  | 'ageGroup'
  | 'model'
  | 'shop'
  | 'promotion'
  | 'term'
  | 'down'
  | 'condition'
  | 'origin'

function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function ageGroupOf(birthYear: number | undefined, todayISO: string): string {
  if (!birthYear) return 'ไม่ระบุ'
  const gregYear = Number(todayISO.slice(0, 4))
  const age = birthYear > 2400 ? gregYear + 543 - birthYear : gregYear - birthYear // รองรับ พ.ศ./ค.ศ.
  if (age >= 18 && age <= 22) return '18-22'
  if (age <= 30) return '23-30'
  if (age <= 40) return '31-40'
  if (age <= 50) return '41-50'
  if (age <= 60) return '51-60'
  return 'ไม่ระบุ'
}

export function enrichCustomers(
  contracts: Contract[],
  statuses: ContractStatusRow[],
  shops: Shop[],
  todayISO: string,
): CustomerRow[] {
  const stByContract = new Map(statuses.map((s) => [s.contractId, s]))
  const shopName = new Map(shops.map((s) => [s.id, s.name]))

  return contracts.map((c) => {
    const st = stByContract.get(c.id)
    const daysLate = st?.daysLate ?? 0
    const active = c.status === 'active'

    let category: CustomerCategory
    if (!active) category = 'closed'
    else if (daysLate >= BAD_DAYS) category = 'bad'
    else if (daysLate >= 1) category = 'late'
    else category = 'normal'

    const neverPaid = !!st && st.remainingInstallments >= c.termMonths
    const firstDefault = active && neverPaid && daysLate > 0

    const lateMonth = active && daysLate >= 1 && st?.nextDue ? st.nextDue.slice(0, 7) : null
    const badMonth =
      active && daysLate >= BAD_DAYS && st?.nextDue ? addDaysISO(st.nextDue, BAD_DAYS).slice(0, 7) : null

    return {
      contractId: c.id,
      contractNo: c.contractNo,
      customerName: c.customerName,
      shopId: c.shopId,
      shopName: shopName.get(c.shopId) ?? '-',
      category,
      bucket: st?.bucket ?? 'normal',
      daysLate,
      nextDue: st?.nextDue ?? null,
      occupation: c.occupation || 'ไม่ระบุ',
      ageGroup: ageGroupOf(c.birthYear, todayISO),
      model: c.model || 'ไม่ระบุ',
      promotion: c.promotion || (c.hasPromotion ? 'มีโปร' : 'ไม่มีโปร'),
      term: `${c.termMonths} เดือน`,
      downRate: `ดาวน์ ${c.downPercent}%`,
      condition: c.condition === 'new' ? 'มือ 1' : 'มือ 2',
      origin: c.origin === 'th' ? 'เครื่องไทย' : 'เครื่องนอก',
      firstDefault,
      lateMonth,
      badMonth,
    }
  })
}

export interface CustomerSummary {
  total: number
  active: number
  normal: number
  late: number
  bad: number
  closed: number
  firstDefault: number
}

export function customerSummary(rows: CustomerRow[]): CustomerSummary {
  const s: CustomerSummary = { total: rows.length, active: 0, normal: 0, late: 0, bad: 0, closed: 0, firstDefault: 0 }
  for (const r of rows) {
    if (r.category === 'closed') s.closed++
    else {
      s.active++
      if (r.category === 'normal') s.normal++
      else if (r.category === 'late') s.late++
      else s.bad++
    }
    if (r.firstDefault) s.firstDefault++
  }
  return s
}

export interface BreakdownRow {
  group: string
  total: number
  counts: Record<OverdueBucket, number> // จำนวนแยกตามกลุ่มความล่าช้า
  bad: number
  badRate: number
}

const DIM_KEY: Record<Exclude<Dimension, 'all'>, (r: CustomerRow) => string> = {
  occupation: (r) => r.occupation,
  ageGroup: (r) => r.ageGroup,
  model: (r) => r.model,
  shop: (r) => r.shopName,
  promotion: (r) => r.promotion,
  term: (r) => r.term,
  down: (r) => r.downRate,
  condition: (r) => r.condition,
  origin: (r) => r.origin,
}

function emptyCounts(): Record<OverdueBucket, number> {
  return { normal: 0, '1-10': 0, '11-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '120+': 0 }
}

/** แยกตามมิติ + แตกความล่าช้าตามกลุ่มเมนู — เฉพาะสัญญาที่ยังผ่อนอยู่ */
export function breakdownBy(rows: CustomerRow[], dim: Exclude<Dimension, 'all'>): BreakdownRow[] {
  const keyOf = DIM_KEY[dim]
  const map = new Map<string, BreakdownRow>()
  for (const r of rows) {
    if (r.category === 'closed') continue
    const g = keyOf(r)
    const cur = map.get(g) ?? { group: g, total: 0, counts: emptyCounts(), bad: 0, badRate: 0 }
    cur.total++
    cur.counts[r.bucket]++
    if (BAD_BUCKETS.has(r.bucket)) cur.bad++
    map.set(g, cur)
  }
  const out = [...map.values()]
  for (const b of out) b.badRate = b.total > 0 ? (b.bad / b.total) * 100 : 0
  return out.sort((a, b) => b.badRate - a.badRate || b.total - a.total)
}

/** ภาพรวมลูกค้าทั้งหมดเป็นแถวเดียว (ไม่แยกกลุ่ม) */
export function overallBreakdown(rows: CustomerRow[]): BreakdownRow {
  const row: BreakdownRow = { group: 'ลูกค้าทั้งหมด', total: 0, counts: emptyCounts(), bad: 0, badRate: 0 }
  for (const r of rows) {
    if (r.category === 'closed') continue
    row.total++
    row.counts[r.bucket]++
    if (BAD_BUCKETS.has(r.bucket)) row.bad++
  }
  row.badRate = row.total > 0 ? (row.bad / row.total) * 100 : 0
  return row
}

const MONTH_TH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']

export interface MonthlyProblem {
  month: number
  label: string
  newLate: number
  newBad: number
}

/** แนวโน้มรายเดือน: เริ่มล่าช้า / กลายเป็นหนี้เสีย (ของลูกค้าที่ตอนนี้ยังเป็นปัญหาอยู่) */
export function monthlyProblemTrend(rows: CustomerRow[], year: number): MonthlyProblem[] {
  const late = Array<number>(12).fill(0)
  const bad = Array<number>(12).fill(0)
  for (const r of rows) {
    if (r.lateMonth && Number(r.lateMonth.slice(0, 4)) === year) {
      const m = Number(r.lateMonth.slice(5, 7))
      if (m >= 1 && m <= 12) late[m - 1]++
    }
    if (r.badMonth && Number(r.badMonth.slice(0, 4)) === year) {
      const m = Number(r.badMonth.slice(5, 7))
      if (m >= 1 && m <= 12) bad[m - 1]++
    }
  }
  return MONTH_TH.map((label, i) => ({ month: i + 1, label, newLate: late[i], newBad: bad[i] }))
}
