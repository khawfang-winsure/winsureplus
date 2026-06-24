// ===== ตัวคำนวณ Dashboard ผู้บริหาร (ฟังก์ชันบริสุทธิ์ — แยกจาก UI/DB เพื่อทดสอบง่าย) =====
// รวมข้อมูลจากหลายแหล่ง (สัญญา/สถานะ/งวด/ร้าน/การชำระ/ขยายเวลา/คืนเครื่อง) เป็นตัวเลขสรุป
import type { Contract, ContractStatusRow, Shop, DeviceReturnRow, ShopGrade, ShopReportRow, GradeMonthlyChange, OtherIncomeLite } from './types'
import type { InstallmentLite, ExtensionRecord, DailyCashflowRow } from './db'
import { ageRange } from './format'
import { buildShopReport, topShopsByCases } from './report'
import { buildCommissionReport, type CommissionTier, type RecruitTier, type RecruitBonusRule } from './commission'

const BAD_DEBT_DAYS = 60 // หนี้เสียฝั่งลูกค้า = ล่าช้า ≥ 60 วัน

export interface ExecInput {
  contracts: Contract[]
  statuses: ContractStatusRow[]
  installments: InstallmentLite[]
  shops: Shop[]
  /** ยอดรายได้รวมรายวัน จาก v_cashflow_daily (migration 0056) แทน raw payments ที่ติด PAGE_CAP */
  dailyRows: DailyCashflowRow[]
  extensions: ExtensionRecord[]
  returns: DeviceReturnRow[]
  todayISO: string // 'YYYY-MM-DD'
  // ช่วงวันที่ที่ผู้ใช้เลือก (inclusive). undefined ทั้งคู่ = ใช้ "เดือนนี้" เหมือนเดิม (backward compat)
  rangeStart?: string // 'YYYY-MM-DD'
  rangeEnd?: string   // 'YYYY-MM-DD'
  // optional commission config — absent when ExecDashboard.tsx hasn't been wired yet (W2.B task)
  commissionTiers?: CommissionTier[]
  recruitTiers?: RecruitTier[]
  recruitBonuses?: RecruitBonusRule[]
  employeeNames?: Record<string, string> // user id → ชื่อ
  // optional other income — wired by น้องวิว in Wave 2 (ExecDashboard.tsx calls getAllOtherIncome())
  // absent → default empty [] → cashflow unchanged (backward compat)
  otherIncome?: OtherIncomeLite[]
}

export interface StatusGroup { count: number; value: number }
export interface AgingRow { bucket: string; label: string; count: number; value: number }
export interface RiskGroup { key: string; total: number; badDebt: number; rate: number }
export interface TrendPoint { label: string }

// ===== Morning Briefing types =====

export interface BriefingCommissionLiability {
  total: number
  topEarner: { name: string; amount: number } | null // null ถ้าไม่มีค่าคอมเดือนนี้
  top5: Array<{ name: string; amount: number }>
}

export type BriefingAlert =
  | { level: 'red'; type: 'npl_high' }
  | { level: 'red'; type: 'early_default'; count: number }
  | { level: 'amber'; type: 'high_risky_shop'; shopName: string; riskyRate: number; shopIndex: number }

export interface BriefingStaffCase {
  name: string
  casesThisMonth: number
  casesLastMonth: number
  momDelta: number              // = thisMonth − lastMonth
  portfolioOutstanding: number  // ยอดคงค้างของ active contracts ของพนักงานคนนี้
  nplRate: number               // 0..100 (active contracts ของคนนี้ที่หนี้เสีย)
}

export interface BriefingMonthlyPL {
  income: number
  expense: number
  net: number
  monthLabel: string // เช่น "มิ.ย. 2026"
}

export interface Briefing {
  commissionLiabilityThisMonth: BriefingCommissionLiability
  nplDeltaPct: number    // currentMonthNPL% − previousMonthNPL% (positive = แย่ลง)
  alerts: BriefingAlert[]
  staffCases: BriefingStaffCase[]
  monthlyPL: BriefingMonthlyPL | null
}

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
  // กระแสเงินสด รายวัน/สัปดาห์/เดือน (เข้า=เก็บค่างวด, ออก=โอนให้ร้าน)
  cashflowDay: CashflowRow[]
  cashflowWeek: CashflowRow[]
  cashflowMonth: CashflowRow[]
  // Morning Briefing panel (W2.B)
  briefing: Briefing
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

// ===== ตัวช่วยกระแสเงินสดรายวัน/สัปดาห์/เดือน =====
export type Granularity = 'day' | 'week' | 'month'
export interface CashflowRow {
  key: string
  label: string
  income: number // เงินเข้า: ค่างวดที่เก็บได้ (payment_log action='pay')
  expense: number // เงินออก: เงินโอนให้ร้านของสัญญาใหม่
  net: number // สุทธิ = เข้า − ออก
  newCases: number // จำนวนสัญญาใหม่
  paymentsCount: number // จำนวนครั้งที่รับชำระ
}

/**
 * เงินดาวน์ที่บริษัทได้รับ (รายได้ต้นสัญญา) = ราคาเครื่อง × %ดาวน์
 * ใช้ bucket ตาม transactionDate (ไม่ใช่วันนำเข้า)
 */
function downOf(c: Contract): number {
  if (!c.devicePrice) return 0
  return Math.max(0, c.devicePrice * ((c.downPercent || 0) / 100))
}

/**
 * เงินโอนจริงให้ร้าน (เงินออก) = ยอดหลังหักดาวน์ + คอม
 * หมายเหตุ: ค่าเอกสาร (docFee) ถูก reclassify เป็น income stream แยกต่างหาก
 * ดังนั้น cash-out จริงคือ afterDown + commission (ไม่หัก docFee)
 */
function shopCashOut(c: Contract): number {
  const afterDown = c.devicePrice * (1 - (c.downPercent || 0) / 100)
  const commission = afterDown * ((c.commissionPercent || 0) / 100)
  return afterDown + commission
}

/**
 * เงินโอนให้ร้าน (ต้นทุนปล่อยเครื่อง) สำหรับ grossMarginEstimate = ยอดหลังหักดาวน์ + คอม − ค่าเอกสาร
 * ยังคงหัก docFee เพื่อให้ grossMarginEstimate เท่าเดิม (docFee = รายได้ที่ดัน margin ขึ้นอยู่แล้วทางอ้อม)
 * ใช้เฉพาะใน grossMarginEstimate เท่านั้น — ห้ามนำไปใช้คำนวณ cashflow expense
 */
function netTransferOf(c: Contract): number {
  const afterDown = c.devicePrice * (1 - (c.downPercent || 0) / 100)
  const commission = afterDown * ((c.commissionPercent || 0) / 100)
  return afterDown + commission - (c.docFee || 0)
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** ตีความ ISO เป็นเวลาท้องถิ่น: 'YYYY-MM-DD' = วันท้องถิ่น, timestamp = แปลงตาม TZ เครื่อง (ไทย UTC+7) */
function localDate(iso: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  return new Date(iso)
}
const dayKeyOf = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
/** วันจันทร์ของสัปดาห์ที่ d อยู่ */
function weekStartOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const dow = (x.getDay() + 6) % 7 // จันทร์=0 ... อาทิตย์=6
  x.setDate(x.getDate() - dow)
  return x
}

/**
 * สร้างตารางกระแสเงินสด (เก่า→ใหม่) ตามความถี่ที่เลือก
 * - ถ้าไม่ส่ง anchorISO → ใช้ todayISO เป็นจุดสิ้นสุด (พฤติกรรมเดิม)
 * - ถ้าส่ง anchorISO → ใช้ anchorISO เป็นจุดสิ้นสุด (สำหรับ range ที่ผู้ใช้เลือก)
 */
export function buildCashflow(
  contracts: Contract[],
  dailyRows: DailyCashflowRow[],
  granularity: Granularity,
  count: number,
  todayISO: string,
  anchorISO?: string,
  otherIncome?: OtherIncomeLite[],
): CashflowRow[] {
  const today = localDate(anchorISO ?? todayISO)
  const rows: CashflowRow[] = []
  const idx = new Map<string, number>()
  for (let k = count - 1; k >= 0; k--) {
    let key: string, label: string
    if (granularity === 'day') {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - k)
      key = dayKeyOf(d)
      label = `${d.getDate()}/${d.getMonth() + 1}`
    } else if (granularity === 'week') {
      const ws = weekStartOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - k * 7))
      const we = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 6)
      key = dayKeyOf(ws)
      label = `${ws.getDate()}/${ws.getMonth() + 1}–${we.getDate()}/${we.getMonth() + 1}`
    } else {
      const d = new Date(today.getFullYear(), today.getMonth() - k, 1)
      key = `${d.getFullYear()}-${d.getMonth()}`
      label = `${TH_MON[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`
    }
    idx.set(key, rows.length)
    rows.push({ key, label, income: 0, expense: 0, net: 0, newCases: 0, paymentsCount: 0 })
  }

  const keyOf = (d: Date): string => {
    if (granularity === 'day') return dayKeyOf(d)
    if (granularity === 'week') return dayKeyOf(weekStartOf(d))
    return `${d.getFullYear()}-${d.getMonth()}`
  }

  // เงินเข้า — การรับชำระค่างวด (จาก v_cashflow_daily aggregate — ไม่ติด PAGE_CAP)
  // payDate เป็น YYYY-MM-DD ท้องถิ่น (Asia/Bangkok) จาก view — ใช้ localDate() แบบ date-only path
  for (const dr of dailyRows) {
    const i = idx.get(keyOf(localDate(dr.payDate)))
    if (i == null) continue
    rows[i].income += dr.income
    rows[i].paymentsCount += dr.payCount
  }
  // เงินเข้า — รายได้อื่นๆ (other_income bucket by received_at; paymentsCount ไม่นับ — metric นั้นนับ collection ค่างวดล้วน)
  for (const oi of (otherIncome ?? [])) {
    const i = idx.get(keyOf(localDate(oi.receivedAt)))
    if (i == null) continue
    rows[i].income += oi.amount
  }
  // เงินเข้า — เงินดาวน์ + ค่าเอกสาร (bucket ตาม transactionDate ของสัญญา)
  // docFee reclassify: เดิมถูกหักออกจากยอดโอนร้าน → ย้ายมาเป็น income stream แยก (net เท่าเดิม)
  // down: รายได้ใหม่ที่ไม่เคยนับมาก่อน (net เพิ่มขึ้นตาม Σdown จริง — ตั้งใจ)
  for (const c of contracts) {
    const i = idx.get(keyOf(localDate(c.transactionDate)))
    if (i == null) continue
    rows[i].income += downOf(c) + (c.docFee || 0)
  }
  // เงินออก — โอนให้ร้านของสัญญาใหม่ (ตามวันที่ทำรายการ)
  // ใช้ shopCashOut (afterDown + commission) ไม่หัก docFee เพราะ docFee ย้ายไปเป็น income แล้ว
  for (const c of contracts) {
    const i = idx.get(keyOf(localDate(c.transactionDate)))
    if (i == null) continue
    rows[i].expense += shopCashOut(c)
    rows[i].newCases++
  }
  for (const r of rows) {
    r.income = r0(r.income)
    r.expense = r0(r.expense)
    r.net = r.income - r.expense
  }
  return rows
}

// ===== Morning Briefing — helper สำหรับ NPL ณ สิ้นเดือนที่แล้ว =====
// หมายเหตุ: installments.paidAmount คือยอดสะสม ณ ปัจจุบัน ไม่ใช่ time-stamped
// ดังนั้น "NPL เดือนที่แล้ว" เป็นการประมาณ: นับงวดที่ due ≤ สิ้นเดือนที่แล้ว
// และยังไม่มี paid_at (หรือ paid_at > สิ้นเดือนที่แล้ว) + ล่าช้า ≥ 60 วัน
function nplRateAsOfEndOfLastMonth(
  contracts: Contract[],
  installments: InstallmentLite[],
  endOfLastMonth: string, // yyyy-mm-dd
): number {
  const instByContract = new Map<string, InstallmentLite[]>()
  for (const ins of installments) {
    const arr = instByContract.get(ins.contractId)
    if (arr) arr.push(ins)
    else instByContract.set(ins.contractId, [ins])
  }
  let totalOut = 0
  let badOut = 0
  for (const c of contracts) {
    if (c.status !== 'active') continue
    const insts = instByContract.get(c.id) ?? []
    // ยอดคงค้าง ณ endOfLastMonth (ประมาณ — ใช้ paidAmount ปัจจุบัน)
    let scheduled = 0
    let paid = 0
    for (const ins of insts) {
      scheduled += ins.amount
      paid += ins.paidAmount
    }
    const out = Math.max(0, scheduled - paid)
    totalOut += out
    // หาวันครบกำหนดงวดเก่าสุดที่ยังไม่ถูกชำระ ณ endOfLastMonth
    let oldestUnpaidDue: string | null = null
    for (const ins of insts) {
      if (ins.dueDate > endOfLastMonth) continue
      const paidByEndOfLastMonth = ins.paidAt != null && ins.paidAt.slice(0, 10) <= endOfLastMonth
      if (!paidByEndOfLastMonth) {
        if (oldestUnpaidDue == null || ins.dueDate < oldestUnpaidDue) oldestUnpaidDue = ins.dueDate
      }
    }
    if (oldestUnpaidDue != null) {
      const daysLate =
        Math.floor((Date.parse(endOfLastMonth) - Date.parse(oldestUnpaidDue)) / 86_400_000)
      if (daysLate >= BAD_DEBT_DAYS) badOut += out
    }
  }
  return pct(badOut, totalOut)
}

// ===== Morning Briefing builder =====
function buildBriefing(
  input: ExecInput,
  // ผลลัพธ์จาก buildExecDashboard ที่คำนวณไปแล้ว
  nplRate: number,
  earlyDefault: StatusGroup,
  riskyShops: ShopReportRow[],
  cashflowMonth: CashflowRow[],
  outstandingOf: (cid: string) => number,
  statusBy: Map<string, ContractStatusRow>,
  curMonthKey: string,
  prevMonthKey: string,
  curYear: number,
  curMonthIndex: number,
): Briefing {
  const { contracts, installments, shops, returns, todayISO } = input

  // ─── commissionLiabilityThisMonth ───
  let commissionLiability: BriefingCommissionLiability = {
    total: 0,
    topEarner: null,
    top5: [],
  }
  if (input.commissionTiers && input.recruitTiers && input.recruitBonuses) {
    const [y, m] = todayISO.slice(0, 7).split('-').map(Number)
    const monthStart = `${y}-${String(m).padStart(2, '0')}-01`
    const report = buildCommissionReport({
      start: monthStart,
      end: todayISO,
      contracts,
      installments: installments.map((ins) => ({
        contractId: ins.contractId,
        installmentNo: ins.installmentNo,
        dueDate: ins.dueDate,
        paidAt: ins.paidAt,
      })),
      returns,
      shops,
      employeeNames: input.employeeNames ?? {},
      tiers: input.commissionTiers,
      recruitTiers: input.recruitTiers,
      recruitBonuses: input.recruitBonuses,
      asOf: todayISO,
    })
    const sorted = [...report].sort((a, b) => b.grandTotal - a.grandTotal)
    const top5 = sorted.slice(0, 5).filter((e) => e.grandTotal > 0).map((e) => ({
      name: e.employeeName,
      amount: e.grandTotal,
    }))
    const total = sorted.reduce((s, e) => s + e.grandTotal, 0)
    commissionLiability = {
      total,
      topEarner: top5.length > 0 ? top5[0] : null,
      top5,
    }
  }

  // ─── nplDeltaPct ───
  // สิ้นเดือนที่แล้ว: วันสุดท้ายของเดือน prevMonthKey
  const [py, pm] = prevMonthKey.split('-').map(Number)
  const lastDayOfPrevMonth = new Date(py, pm + 1, 0) // เดือน JS 0-based, +1 แล้ว day=0 = วันสุดท้าย
  const endOfLastMonth = `${lastDayOfPrevMonth.getFullYear()}-${String(lastDayOfPrevMonth.getMonth() + 1).padStart(2, '0')}-${String(lastDayOfPrevMonth.getDate()).padStart(2, '0')}`
  const prevNplRate = nplRateAsOfEndOfLastMonth(contracts, installments, endOfLastMonth)
  const nplDeltaPct = nplRate - prevNplRate

  // ─── alerts (สร้างเรียงตามลำดับ: red ก่อน, cap 3 ทั้งหมด) ───
  const alerts: BriefingAlert[] = []
  if (nplRate >= 20) {
    alerts.push({ level: 'red', type: 'npl_high' })
  }
  if (earlyDefault.count >= 3) {
    alerts.push({ level: 'red', type: 'early_default', count: earlyDefault.count })
  }
  for (let si = 0; si < riskyShops.length; si++) {
    if (alerts.length >= 3) break
    const shop = riskyShops[si]
    if (shop.riskyRate >= 50) {
      alerts.push({
        level: 'amber',
        type: 'high_risky_shop',
        shopName: shop.name,
        riskyRate: Math.round(shop.riskyRate),
        shopIndex: si,
      })
    }
  }

  // ─── staffCases ───
  const empKey = (c: Contract) => c.recordedById ?? 'unknown'
  const empName = (c: Contract) =>
    (input.employeeNames?.[empKey(c)]) ?? (c.recordedBy || '(ไม่ระบุ)')

  // เดือนนี้ + เดือนที่แล้ว: นับเคส (สัญญาทุกสถานะ)
  const casesByEmpMonth = new Map<string, { name: string; thisMonth: number; lastMonth: number }>()
  for (const c of contracts) {
    const id = empKey(c)
    const mk = monthKey(c.transactionDate)
    let entry = casesByEmpMonth.get(id)
    if (!entry) {
      entry = { name: empName(c), thisMonth: 0, lastMonth: 0 }
      casesByEmpMonth.set(id, entry)
    }
    if (mk === curMonthKey) entry.thisMonth++
    else if (mk === prevMonthKey) entry.lastMonth++
  }
  // ยอดคงค้าง + NPL ต่อพนักงาน (เฉพาะ active contracts)
  const activeContracts = contracts.filter((c) => c.status === 'active')
  const empOutstanding = new Map<string, number>()
  const empBadDebt = new Map<string, number>()
  for (const c of activeContracts) {
    const id = empKey(c)
    const out = outstandingOf(c.id)
    empOutstanding.set(id, (empOutstanding.get(id) ?? 0) + out)
    const days = statusBy.get(c.id)?.daysLate ?? 0
    if (days >= BAD_DEBT_DAYS) {
      empBadDebt.set(id, (empBadDebt.get(id) ?? 0) + out)
    }
  }
  const staffCases: BriefingStaffCase[] = [...casesByEmpMonth.entries()]
    .map(([id, v]) => {
      const portfolioOut = empOutstanding.get(id) ?? 0
      const badDebtOut = empBadDebt.get(id) ?? 0
      return {
        name: v.name,
        casesThisMonth: v.thisMonth,
        casesLastMonth: v.lastMonth,
        momDelta: v.thisMonth - v.lastMonth,
        portfolioOutstanding: Math.round(portfolioOut),
        nplRate: pct(badDebtOut, portfolioOut),
      }
    })
    .sort((a, b) => b.casesThisMonth - a.casesThisMonth)

  // ─── monthlyPL ───
  let monthlyPL: BriefingMonthlyPL | null = null
  const lastCf = cashflowMonth[cashflowMonth.length - 1]
  if (lastCf) {
    monthlyPL = {
      income: lastCf.income,
      expense: lastCf.expense,
      net: lastCf.net,
      monthLabel: `${TH_MON[curMonthIndex]} ${curYear}`,
    }
  }

  return { commissionLiabilityThisMonth: commissionLiability, nplDeltaPct, alerts, staffCases, monthlyPL }
}

export function buildExecDashboard(input: ExecInput): ExecDashboard {
  const { contracts, statuses, installments, shops, dailyRows, extensions, returns, todayISO } = input
  const today = new Date(`${todayISO}T00:00:00`)
  const curYear = today.getFullYear()
  const curMonthIndex = today.getMonth() // 0-based
  const curMonthKey = `${curYear}-${curMonthIndex}`
  const nextMonthDate = new Date(curYear, curMonthIndex + 1, 1)
  const nextMonthKey = `${nextMonthDate.getFullYear()}-${nextMonthDate.getMonth()}`
  const prevMonthDate = new Date(curYear, curMonthIndex - 1, 1)
  const prevMonthKey = `${prevMonthDate.getFullYear()}-${prevMonthDate.getMonth()}`

  // ----- คำนวณช่วง effective ที่ใช้ filter flow KPIs -----
  // ถ้าไม่ส่งทั้งคู่ → fallback = "วันที่ 1 ของเดือน todayISO" ถึง todayISO (backward compat กับ curMonthKey)
  const monthStartISO = `${curYear}-${String(curMonthIndex + 1).padStart(2, '0')}-01`
  let effectiveStart: string
  let effectiveEnd: string
  const hasRange = input.rangeStart != null && input.rangeEnd != null
  if (hasRange) {
    let s = input.rangeStart as string
    let e = input.rangeEnd as string
    if (s > e) {
      const tmp = s; s = e; e = tmp
    }
    effectiveStart = s
    effectiveEnd = e
  } else {
    effectiveStart = monthStartISO
    effectiveEnd = todayISO
  }
  // ISO เปรียบเทียบเป็น string ได้ตรงๆ (YYYY-MM-DD lexicographic = chronological)
  // helper: เทียบ ISO timestamp/date ตกในช่วงไหม (ใช้ 10 ตัวแรกของ ISO timestamp เป็นวัน)
  const inRange = (iso: string): boolean => {
    if (!iso) return false
    const day = iso.length >= 10 ? iso.slice(0, 10) : iso
    return day >= effectiveStart && day <= effectiveEnd
  }

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
    // expectedThisMonth = ยอด remain ของงวดที่ dueDate ∈ ช่วง effective (ชื่อ field คงเดิมเพื่อ backward compat)
    if (inRange(ins.dueDate)) expectedThisMonth += remain
    // expectedNextMonth ใช้เดือนถัดจาก todayISO ตามเดิม (ไม่ผูก range — UI ไม่ relabel ตัวนี้)
    if (monthKey(ins.dueDate) === nextMonthKey) expectedNextMonth += remain
  }
  const collectionRate = pct(collectedDue, dueToDate)

  let receivedThisMonth = 0
  // รวมยอดรายวันจาก v_cashflow_daily แทน raw payments ที่ติด PAGE_CAP
  for (const dr of dailyRows) {
    if (inRange(dr.payDate)) receivedThisMonth += dr.income
  }
  // รวมรายได้อื่นๆ ที่ received_at ตกในช่วง effective (inRange ใช้ ISO date ได้ตรงๆ)
  for (const oi of (input.otherIncome ?? [])) {
    if (inRange(oi.receivedAt)) receivedThisMonth += oi.amount
  }
  // รวมเงินดาวน์ + ค่าเอกสาร bucket ตาม transactionDate (mirror buildCashflow income loop)
  // docFee reclassify: net เท่าเดิม (ดูหมายเหตุใน shopCashOut)
  // down: รายได้ใหม่ที่เพิ่ม receivedThisMonth จริง (ตั้งใจ)
  for (const c of contracts) {
    if (inRange(c.transactionDate)) receivedThisMonth += downOf(c) + (c.docFee || 0)
  }

  const penaltyTotal = active.reduce((s, c) => s + (statusBy.get(c.id)?.penaltyDue ?? 0), 0)

  // กำไรคร่าวๆ = Σ (ยอดผ่อนทั้งสัญญา − เงินโอนต้นทุนให้ร้าน)  *ประมาณการ*
  let grossMarginEstimate = 0
  for (const c of active) {
    grossMarginEstimate += c.monthlyPayment * c.termMonths - netTransferOf(c)
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
  const extensionsThisMonth = extensions.filter((e) => inRange(e.createdAt)) .length
  let returnsCount = 0
  let returnsValue = 0
  for (const ret of returns) {
    if (inRange(ret.createdAt)) {
      returnsCount++
      returnsValue += contractById.get(ret.contractId)?.devicePrice ?? 0
    }
  }
  const newContractsThisMonth = contracts.filter((c) => inRange(c.transactionDate)).length

  // ร้านใหม่ในช่วง = ร้านที่มีเคสแรกอยู่ใน effective range
  const firstByShop = new Map<string, string>()
  for (const c of contracts) {
    const cur = firstByShop.get(c.shopId)
    if (!cur || c.transactionDate < cur) firstByShop.set(c.shopId, c.transactionDate)
  }
  let newShopsThisMonth = 0
  for (const d of firstByShop.values()) if (inRange(d)) newShopsThisMonth++

  // ----- แนวโน้ม 12 เดือนล่าสุด -----
  const trendKeys: string[] = []
  const trendLabels: string[] = []
  for (let k = 11; k >= 0; k--) {
    const d = new Date(curYear, curMonthIndex - k, 1)
    trendKeys.push(`${d.getFullYear()}-${d.getMonth()}`)
    trendLabels.push(`${TH_MON[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`)
  }
  const newCasesMap = new Map<string, number>()
  for (const c of contracts) {
    const mk = monthKey(c.transactionDate)
    newCasesMap.set(mk, (newCasesMap.get(mk) ?? 0) + 1)
  }
  // collectedByMonth (12-month trend) — bucket ยอดรายวันตามเดือน
  const collectedMap = new Map<string, number>()
  for (const dr of dailyRows) {
    const mk = monthKey(dr.payDate)
    collectedMap.set(mk, (collectedMap.get(mk) ?? 0) + dr.income)
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

  // ----- กระแสเงินสด: ถ้ามี range → คำนวณ count + anchor จากช่วง, ถ้าไม่มี → default เดิม -----
  // anchor = effectiveEnd (จุดสิ้นสุดของช่วง), count = จำนวนหน่วยย้อนหลังจาก anchor ถึง effectiveStart
  // ถ้า day > 366 → cap ไว้ที่ 366 (กัน render เยอะ ตาม spec edge case)
  let cfDayCount = 14
  let cfWeekCount = 8
  let cfMonthCount = 12
  let cfAnchor: string | undefined = undefined
  if (hasRange) {
    cfAnchor = effectiveEnd
    const startD = localDate(effectiveStart)
    const endD = localDate(effectiveEnd)
    const dayDiff = Math.floor((endD.getTime() - startD.getTime()) / 86_400_000)
    cfDayCount = Math.max(1, Math.min(366, dayDiff + 1))
    cfWeekCount = Math.max(1, Math.ceil((dayDiff + 1) / 7))
    const monthDiff =
      (endD.getFullYear() - startD.getFullYear()) * 12 + (endD.getMonth() - startD.getMonth())
    cfMonthCount = Math.max(1, monthDiff + 1)
  }
  const oi = input.otherIncome ?? [] // other_income ถ้ายังไม่ wire (Wave 2) → [] → cashflow ไม่เปลี่ยน
  const cashflowDay = buildCashflow(contracts, dailyRows, 'day', cfDayCount, todayISO, cfAnchor, oi)
  const cashflowWeek = buildCashflow(contracts, dailyRows, 'week', cfWeekCount, todayISO, cfAnchor, oi)
  const cashflowMonth = buildCashflow(contracts, dailyRows, 'month', cfMonthCount, todayISO, cfAnchor, oi)

  const briefing = buildBriefing(
    input,
    nplRate,
    earlyDefault,
    riskyShops,
    cashflowMonth,
    outstandingOf,
    statusBy,
    curMonthKey,
    prevMonthKey,
    curYear,
    curMonthIndex,
  )

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
    cashflowDay,
    cashflowWeek,
    cashflowMonth,
    briefing,
  }
}

// ===== Grade Movement (Roll / Cure rate รายเดือน) =====
// TH_MON ใช้จากที่ประกาศด้านบน (บรรทัด 120) — ไม่ประกาศซ้ำ

/** 'YYYY-MM-DD' → 'YYYY-MM' (ใช้ภายใน buildGradeMovement เท่านั้น — ต่างจาก monthKey เดิมที่ return 'YYYY-M' 0-based) */
function ymKey(isoDate: string): string {
  return isoDate.slice(0, 7)
}

/** 'YYYY-MM' → 'พ.ค. 26' (CE 2-digit — ตรงกับ convention ที่ใช้ใน buildExecDashboard) */
function ymLabel(monthYYYYMM: string): string {
  const [y, m] = monthYYYYMM.split('-').map(Number)
  return TH_MON[m - 1] + ' ' + String(y).slice(2)
}

export interface GradeMovementMonth {
  monthLabel: string      // เช่น 'พ.ค. 26'
  roll: number            // จำนวนสัญญาที่ grade แย่ลง (roll into worse bucket)
  cure: number            // จำนวนสัญญาที่ grade ดีขึ้น (cure)
  net: number             // cure − roll (บวก = ดีขึ้น)
  newCount: number        // สัญญาใหม่ที่เข้า graded pool เดือนนั้น
  exit: number            // สัญญาที่ออกจาก graded pool (ปิด/คืน)
  isBackfillSpike: boolean // true = เดือนที่ข้อมูลน่าจะเป็น backfill (new พุ่งสูง roll=cure=exit=0)
}

export interface GradeMovementSummary {
  roll: number
  cure: number
  net: number
  rollRateApprox: number | null  // null ถ้า activeGradedCount = 0
  cureRateApprox: number | null
  approxNote: string
}

export interface GradeMovementResult {
  months: GradeMovementMonth[]          // เรียง ASC (เก่า→ใหม่) สูงสุด 12 เดือนล่าสุด (รวม backfill spike)
  currentMonth: GradeMovementSummary
  emptyState: boolean                    // true เมื่อทุกเดือนมี roll=0 && cure=0
  backfillMonthLabel: string | null      // label เดือนที่ตรวจพบ backfill spike (null = ไม่มี)
}

/**
 * สรุปการเคลื่อนไหวเกรดรายเดือน (Roll/Cure rate) จากข้อมูล v_grade_monthly_changes
 *
 * @param rows       ผลลัพธ์จาก getGradeChangesMonthly() — GradeMonthlyChange[] (monthBkt='YYYY-MM-DD')
 * @param activeGradedCount  จำนวนสัญญา active ที่มีเกรด ณ ปัจจุบัน (ใช้เป็นตัวหาร rate)
 * @param todayISO   วันที่วันนี้ 'YYYY-MM-DD'
 */
export function buildGradeMovement(
  rows: GradeMonthlyChange[],
  activeGradedCount: number,
  todayISO: string,
): GradeMovementResult {
  // ── 1. Aggregate rows → Map<monthYYYYMM, counts> ──────────────────────────────
  type MonthAgg = { roll: number; cure: number; newCount: number; exit: number }
  const agg = new Map<string, MonthAgg>()

  for (const r of rows) {
    const mk = ymKey(r.monthBkt)
    if (!agg.has(mk)) agg.set(mk, { roll: 0, cure: 0, newCount: 0, exit: 0 })
    const entry = agg.get(mk)!
    if (r.changeType === 'roll')  entry.roll      += r.cnt
    else if (r.changeType === 'cure') entry.cure   += r.cnt
    else if (r.changeType === 'new')  entry.newCount += r.cnt
    else if (r.changeType === 'exit') entry.exit   += r.cnt
    // 'same' — ไม่นับใน output fields
  }

  if (agg.size === 0) {
    return {
      months: [],
      currentMonth: { roll: 0, cure: 0, net: 0, rollRateApprox: null, cureRateApprox: null, approxNote: '' },
      emptyState: true,
      backfillMonthLabel: null,
    }
  }

  // ── 2. หา earliest month key → ตรวจ backfill spike ─────────────────────────
  const sortedKeys = [...agg.keys()].sort() // ASC
  const earliestKey = sortedKeys[0]
  const earliestAgg = agg.get(earliestKey)!
  const isBackfill =
    earliestAgg.newCount > 0 &&
    earliestAgg.roll === 0 &&
    earliestAgg.cure === 0 &&
    earliestAgg.exit === 0

  const backfillMonthLabel = isBackfill ? ymLabel(earliestKey) : null

  // ── 3. Build months[] — เรียง ASC, slice(-12) ────────────────────────────────
  const curMonthKey = ymKey(todayISO)

  const months: GradeMovementMonth[] = sortedKeys.map((mk) => {
    const a = agg.get(mk)!
    const backfillFlag = isBackfill && mk === earliestKey
    return {
      monthLabel: ymLabel(mk),
      roll: a.roll,
      cure: a.cure,
      net: a.cure - a.roll,
      newCount: a.newCount,
      exit: a.exit,
      isBackfillSpike: backfillFlag,
    }
  }).slice(-12)

  // ── 4. currentMonth summary ──────────────────────────────────────────────────
  const curAgg = agg.get(curMonthKey) ?? { roll: 0, cure: 0, newCount: 0, exit: 0 }
  const rollRateApprox =
    activeGradedCount > 0 ? (curAgg.roll / activeGradedCount) * 100 : null
  const cureRateApprox =
    activeGradedCount > 0 ? (curAgg.cure / activeGradedCount) * 100 : null
  const approxNote =
    activeGradedCount > 0
      ? 'คิดจากสัญญา active ที่มีเกรด ' + activeGradedCount + ' รายการ'
      : 'ไม่มีสัญญา active ที่มีเกรด'

  const currentMonth: GradeMovementSummary = {
    roll: curAgg.roll,
    cure: curAgg.cure,
    net: curAgg.cure - curAgg.roll,
    rollRateApprox,
    cureRateApprox,
    approxNote,
  }

  // ── 5. emptyState ────────────────────────────────────────────────────────────
  const emptyState = months.every((m) => m.roll === 0 && m.cure === 0)

  return { months, currentMonth, emptyState, backfillMonthLabel }
}
