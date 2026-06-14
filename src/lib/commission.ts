// ===== ค่าคอมมิชชั่นแบบขั้นบันได (ตั้งค่าได้ ไม่ hardcode) =====
// หน่วย = บาท/เคส · คิดตอนบันทึกสัญญา · เก็บใน app_settings key='commission_tiers' (JSON)
// ส่วนล่างของไฟล์ = ตัวสร้างรายงานค่าคอมต่อพนักงานต่อเดือน (gross − clawback = net)

import type { Contract, DeviceReturnRow, Shop, ShopGrade } from './types'
import { gradeFor } from './report'

export interface CommissionTier {
  minCases: number // ตั้งแต่กี่เคส
  maxCases: number | null // ถึงกี่เคส (null = ขึ้นไป)
  bahtPerCase: number // ค่าคอมต่อเคส (บาท)
}

/** ค่าเริ่มต้น — เรต 0 ให้แอดมินกรอกเองในหน้าตั้งค่า */
export const DEFAULT_TIERS: CommissionTier[] = [
  { minCases: 1, maxCases: 10, bahtPerCase: 0 },
  { minCases: 11, maxCases: 20, bahtPerCase: 0 },
  { minCases: 21, maxCases: null, bahtPerCase: 0 },
]

/** ป้ายช่วงขั้น เช่น "1–10 เคส" หรือ "21 เคสขึ้นไป" */
export function tierLabel(t: CommissionTier): string {
  return t.maxCases == null ? `${t.minCases} เคสขึ้นไป` : `${t.minCases}–${t.maxCases} เคส`
}

/** หาเรต (บาท/เคส) ของขั้นที่จำนวนเคสตกอยู่ — แบบ flat (ยกขั้นทั้งก้อน) */
export function rateForCaseCount(caseCount: number, tiers: CommissionTier[]): number {
  const t = tiers.find(
    (t) => caseCount >= t.minCases && (t.maxCases == null || caseCount <= t.maxCases),
  )
  return t ? t.bahtPerCase : 0
}

/** ค่าคอมรวมแบบ flat: เรตของขั้นที่ยอดรวมตกอยู่ × จำนวนเคสทั้งหมด */
export function commissionFlat(caseCount: number, tiers: CommissionTier[]): number {
  return caseCount * rateForCaseCount(caseCount, tiers)
}

// ===== ค่าคอมหาร้าน =====
// ก้อน 1: ตามจำนวนร้านที่หาได้ (ขั้นบันได flat บาท/ร้าน · นับต่อเดือน)
// ก้อน 2: โบนัสเมื่อร้านที่หามาส่งเคสครบเป้าภายในกรอบเวลา (นับจากวันหาร้าน)

/** ขั้นบันไดค่าคอมหาร้าน (บาท/ร้าน) — โครงเดียวกับค่าคอมเคสแต่นับ "ร้าน" */
export interface RecruitTier {
  minShops: number
  maxShops: number | null
  bahtPerShop: number
}

export const DEFAULT_RECRUIT_TIERS: RecruitTier[] = [
  { minShops: 1, maxShops: 4, bahtPerShop: 0 },
  { minShops: 5, maxShops: null, bahtPerShop: 0 },
]

/** เงื่อนไขโบนัสร้าน: ส่งเคสครบ cases เคส ภายใน months เดือน → ได้ bonus บาท (ต่อร้าน ครั้งเดียว) */
export interface RecruitBonusRule {
  cases: number // จำนวนเคสเป้า
  months: number // กรอบเวลา (เดือน นับจากวันหาร้าน)
  bonus: number // โบนัส (บาท)
}

export const DEFAULT_RECRUIT_BONUS: RecruitBonusRule[] = [{ cases: 0, months: 3, bonus: 0 }]

export function recruitTierLabel(t: RecruitTier): string {
  return t.maxShops == null ? `${t.minShops} ร้านขึ้นไป` : `${t.minShops}–${t.maxShops} ร้าน`
}

/** หาเรต (บาท/ร้าน) ของขั้นที่จำนวนร้านตกอยู่ — flat (ยกขั้นทั้งก้อน) */
export function rateForShopCount(shopCount: number, tiers: RecruitTier[]): number {
  const t = tiers.find(
    (t) => shopCount >= t.minShops && (t.maxShops == null || shopCount <= t.maxShops),
  )
  return t ? t.bahtPerShop : 0
}

// ============================================================================
// รายงานค่าคอมต่อพนักงานต่อเดือน (แบบผสม: คิดสด + ปิดยอดล็อกเรตได้)
//   ค่าคอม "ได้" (gross)  : นับเคสที่บันทึกในเดือนนั้น × เรต flat ของจำนวนเคสรวม
//   ค่าคอม "หัก" (clawback): เคสที่เสีย หักคืนตามเรตเดิม ตกเดือนที่เหตุการณ์เกิด (หักครั้งเดียว)
//   ค่าคอม "สุทธิ" (net)   : ได้ − หัก
// ============================================================================

/** สาเหตุการหักคืนค่าคอม */
export type ClawbackReason = 'first_unpaid' | 'over30' | 'returned'

export const CLAWBACK_LABEL: Record<ClawbackReason, string> = {
  first_unpaid: 'ไม่จ่ายงวดแรก',
  over30: 'ล่าช้า > 30 วัน',
  returned: 'คืนเครื่อง',
}

export interface GrossCase {
  contractId: string
  contractNo: string
  customerName: string
}

export interface ClawbackCase {
  contractId: string
  contractNo: string
  customerName: string
  reason: ClawbackReason
  rate: number // เรตเดิม (บาท) ที่เคสนี้เคยได้ — ถูกหักคืน
  bookingMonth: string // เดือนที่บันทึกเคส (yyyy-mm)
}

/** โบนัสร้าน 1 รายการที่ได้ในเดือน (ก้อน 2) */
export interface RecruitBonusEarned {
  shopId: string
  shopName: string
  cases: number // จำนวนเคสเป้าที่ทำได้
  withinMonths: number // กรอบเวลา
  bonus: number // โบนัส (บาท)
  grade: ShopGrade // เกรดร้าน ณ สิ้นกรอบเวลา (ได้โบนัสเฉพาะ A/B)
}

export interface EmployeeCommission {
  employeeId: string
  employeeName: string
  // --- ค่าคอมเคส (ล็อกได้ด้วยปุ่มปิดยอด) ---
  grossCount: number // จำนวนเคสที่บันทึกในเดือนนี้
  grossRate: number // เรต flat (บาท/เคส) ของเดือนนี้
  grossAmount: number // grossCount × grossRate
  grossCases: GrossCase[]
  clawbackAmount: number // รวมยอดหักคืน
  clawbacks: ClawbackCase[]
  net: number // ค่าคอมเคสสุทธิ = grossAmount − clawbackAmount
  locked: boolean // เดือนนี้ของคนนี้ปิดยอด (ล็อกเรต) แล้วหรือยัง
  // --- ค่าคอมหาร้าน (คิดสดเสมอ ล็อกไม่ได้ใน v1) ---
  recruitShopCount: number // ก้อน 1: ร้านที่หาในเดือนนี้
  recruitShopRate: number // เรต flat (บาท/ร้าน)
  recruitShopAmount: number // = count × rate
  recruitBonusAmount: number // ก้อน 2: รวมโบนัสร้าน
  recruitBonuses: RecruitBonusEarned[]
  recruitTotal: number // ก้อน 1 + ก้อน 2
  grandTotal: number // ค่าคอมเคสสุทธิ + ค่าคอมหาร้าน
}

/** งวดผ่อนแบบย่อที่รายงานต้องใช้ (โครงสร้างตรงกับ db.InstallmentLite) */
export interface ReportInstallment {
  contractId: string
  installmentNo: number
  dueDate: string
  paidAt: string | null
}

const LATE_DAYS = 30 // เกณฑ์หักค่าคอม: ล่าช้าครบ 30 วัน

/** เดือน (yyyy-mm) ของวันที่ ISO */
function ym(iso: string): string {
  return iso.slice(0, 7)
}

/** เฉพาะส่วนวันที่ (yyyy-mm-dd) ของ ISO ใดๆ */
function dateOnly(iso: string): string {
  return iso.slice(0, 10)
}

/** วันที่ (yyyy-mm-dd) ของ (วันที่ + จำนวนวัน) — คิดแบบ UTC ล้วน กันขอบเดือนเพี้ยนเพราะ timezone */
function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

/** วันที่ (yyyy-mm-dd) ของ (วันที่ + จำนวนเดือน) — clamp สิ้นเดือน (31 ม.ค. +1 เดือน → 28/29 ก.พ.) */
function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number)
  const target = new Date(Date.UTC(y, m - 1 + months, 1))
  const ty = target.getUTCFullYear()
  const tm = target.getUTCMonth()
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate() // วันสุดท้ายของเดือนเป้าหมาย
  return new Date(Date.UTC(ty, tm, Math.min(d, lastDay))).toISOString().slice(0, 10)
}

/** จำนวนวันระหว่าง 2 วันที่ (yyyy-mm-dd) */
function daysBetween(fromISO: string, toISO: string): number {
  return Math.floor((Date.parse(toISO.slice(0, 10)) - Date.parse(fromISO.slice(0, 10))) / 86_400_000)
}

/** สัญญานี้ "เสี่ยง" (ล่าช้า 31 วันขึ้นไป) ณ วันที่ asOf หรือไม่ — ดูจากประวัติงวด ณ เวลานั้น
 *  (งวดถือว่ายังไม่จ่ายถ้า paid_at ว่าง หรือจ่ายหลัง asOf) */
function isRiskyAsOf(insts: ReportInstallment[], asOf: string): boolean {
  let oldestUnpaidDue: string | null = null
  for (const i of insts) {
    const paidByAsOf = i.paidAt != null && dateOnly(i.paidAt) <= asOf
    if (!paidByAsOf && (oldestUnpaidDue == null || i.dueDate < oldestUnpaidDue)) {
      oldestUnpaidDue = i.dueDate
    }
  }
  if (oldestUnpaidDue == null) return false
  return daysBetween(oldestUnpaidDue, asOf) >= 31
}

interface ClawbackEvent {
  reason: ClawbackReason
  date: string // yyyy-mm-dd ที่เหตุการณ์เกิด (วันที่งวดล่าช้าครบ 30 วัน)
}

/** ตรวจว่าสัญญานี้ต้องหักคืนค่าคอมไหม + เกิดเดือนไหน
 *  กฎ: เคส "เสีย" เมื่อมีงวดใดเคยล่าช้า "ครบ 30 วัน"
 *   - งวดที่จ่ายแล้ว: ช้าถ้า paid_at ≥ ครบกำหนด + 30 (ประวัติคงที่ → ลูกค้ากลับมาจ่ายก็ไม่คืนค่าคอม)
 *   - งวดที่ยังไม่จ่าย: วัดถึง "วันอ้างอิง" = วันนี้ (ถ้ายังผ่อน) หรือวันคืนเครื่อง (ถ้าคืนแล้ว)
 *     → คืนเครื่องก่อนครบ 30 วัน = ไม่เสีย; คืนหลังครบ 30 วัน = เสีย
 *  เลือกงวดที่ครบ 30 วัน "เร็วที่สุด" เป็นเดือนที่หัก (หักครั้งเดียว) */
function detectClawback(
  c: Contract,
  insts: ReportInstallment[],
  ret: DeviceReturnRow | undefined,
  asOf: string, // วันนี้ yyyy-mm-dd
): ClawbackEvent | null {
  // วันอ้างอิงสำหรับงวดที่ยังไม่จ่าย
  let asOfRef: string | null
  if (c.status === 'active') asOfRef = asOf
  else if (c.status === 'returned' || c.status === 'returned_closed')
    asOfRef = ret ? dateOnly(ret.checkedAt ?? ret.createdAt) : asOf
  else asOfRef = null // closed/online: นับเฉพาะประวัติงวดที่จ่ายช้า

  let earliest: { due: string; no: number } | null = null
  for (const i of insts) {
    const cross = addDays(i.dueDate, LATE_DAYS) // วันที่ครบ 30 วันของงวดนี้
    const bad = i.paidAt ? dateOnly(i.paidAt) >= cross : asOfRef != null && asOfRef >= cross
    if (bad && (!earliest || i.dueDate < earliest.due)) {
      earliest = { due: i.dueDate, no: i.installmentNo }
    }
  }
  if (!earliest) return null

  const reason: ClawbackReason =
    c.status === 'returned' || c.status === 'returned_closed'
      ? 'returned'
      : earliest.no === 1
        ? 'first_unpaid'
        : 'over30'
  return { reason, date: addDays(earliest.due, LATE_DAYS) }
}

/** คีย์ระบุช่วงปิดยอด (เก็บใน commission_locked_month) — ช่วงวันเองได้ ไม่ตัดตามเดือน */
export function periodKeyOf(start: string, end: string): string {
  return `${start}..${end}`
}

/** ข้อมูลที่รายงานค่าคอมต้องใช้ — เลือกช่วงวันเอง (start..end) ไม่ตัดตามเดือน */
export interface CommissionReportInput {
  start: string // yyyy-mm-dd (รวมวันนี้)
  end: string // yyyy-mm-dd (รวมวันนี้)
  contracts: Contract[]
  installments: ReportInstallment[]
  returns: DeviceReturnRow[]
  shops: Shop[]
  employeeNames: Record<string, string> // user id -> ชื่อ (จากตาราง profiles)
  tiers: CommissionTier[]
  recruitTiers: RecruitTier[]
  recruitBonuses: RecruitBonusRule[]
  asOf: string // วันนี้ yyyy-mm-dd
}

/** สร้างรายงานค่าคอมของทุกพนักงาน สำหรับช่วงวันที่เลือก (ค่าคอมเคส + ค่าคอมหาร้าน) */
export function buildCommissionReport(input: CommissionReportInput): EmployeeCommission[] {
  const { start, end, contracts, installments, returns, shops, tiers, recruitTiers, recruitBonuses, asOf } =
    input
  const periodKey = periodKeyOf(start, end)
  const inRange = (iso: string) => {
    const d = iso.slice(0, 10)
    return d >= start && d <= end
  }

  // จัดงวดผ่อนเข้ากลุ่มตามสัญญา
  const instByContract = new Map<string, ReportInstallment[]>()
  for (const i of installments) {
    const arr = instByContract.get(i.contractId)
    if (arr) arr.push(i)
    else instByContract.set(i.contractId, [i])
  }
  // คืนเครื่องล่าสุดต่อสัญญา
  const retById = new Map<string, DeviceReturnRow>()
  for (const r of returns) {
    const prev = retById.get(r.contractId)
    if (!prev || r.createdAt > prev.createdAt) retById.set(r.contractId, r)
  }
  // วันที่ทำรายการของทุกเคส ต่อร้าน (เรียงเก่า→ใหม่) — ใช้คิดโบนัสร้าน (ก้อน 2 นับตาม "ร้าน" ทุกคน)
  const caseDatesByShop = new Map<string, string[]>()
  for (const c of contracts) {
    const arr = caseDatesByShop.get(c.shopId)
    if (arr) arr.push(dateOnly(c.transactionDate))
    else caseDatesByShop.set(c.shopId, [dateOnly(c.transactionDate)])
  }
  for (const arr of caseDatesByShop.values()) arr.sort()

  const empKey = (c: Contract) => c.recordedById ?? 'unknown'

  // ชื่อพนักงาน: เริ่มจาก profiles แล้วเติมจากชื่อ ณ ตอนบันทึกเคส (เผื่อ id ที่ไม่อยู่ใน profiles)
  const names: Record<string, string> = { ...input.employeeNames }
  for (const c of contracts) {
    const id = empKey(c)
    if (!names[id]) names[id] = c.recordedBy || '(ไม่ระบุผู้บันทึก)'
  }
  const nameOf = (id: string) => names[id] || '(ไม่ระบุ)'

  // นับเคสที่บันทึก ต่อ (พนักงาน|เดือนบันทึก) — ใช้หาเรต flat ของเดือนนั้น
  const countByEmpMonth = new Map<string, number>()
  for (const c of contracts) {
    const k = empKey(c) + '|' + ym(c.transactionDate)
    countByEmpMonth.set(k, (countByEmpMonth.get(k) ?? 0) + 1)
  }
  const countOf = (emp: string, mon: string) => countByEmpMonth.get(emp + '|' + mon) ?? 0
  // เรตเดิมของเคส: ถ้าล็อกใช้เรตที่ล็อก, ไม่งั้นคิดสดจากจำนวนเคสเดือนที่บันทึก
  const originalRate = (c: Contract) =>
    c.commissionRateLocked != null
      ? c.commissionRateLocked
      : rateForCaseCount(countOf(empKey(c), ym(c.transactionDate)), tiers)

  const emps = new Map<string, EmployeeCommission>()
  const ensureEmp = (id: string): EmployeeCommission => {
    let e = emps.get(id)
    if (!e) {
      e = {
        employeeId: id,
        employeeName: nameOf(id),
        grossCount: 0,
        grossRate: 0,
        grossAmount: 0,
        grossCases: [],
        clawbackAmount: 0,
        clawbacks: [],
        net: 0,
        locked: false,
        recruitShopCount: 0,
        recruitShopRate: 0,
        recruitShopAmount: 0,
        recruitBonusAmount: 0,
        recruitBonuses: [],
        recruitTotal: 0,
        grandTotal: 0,
      }
      emps.set(id, e)
    }
    return e
  }

  // ===== ค่าคอมเคส =====
  for (const c of contracts) {
    // (ก) ได้ค่าคอม — เคสที่บันทึกในช่วงรายงาน
    if (inRange(c.transactionDate)) {
      const e = ensureEmp(empKey(c))
      e.grossCases.push({ contractId: c.id, contractNo: c.contractNo, customerName: c.customerName })
      if (c.commissionLockedMonth === periodKey) e.locked = true
    }
    // (ข) หักคืน — เคสที่ "เสีย" ในช่วงรายงาน (ไม่ว่าบันทึกช่วงไหน)
    const cb = detectClawback(c, instByContract.get(c.id) ?? [], retById.get(c.id), asOf)
    if (cb && inRange(cb.date)) {
      const e = ensureEmp(empKey(c))
      const rate = originalRate(c)
      e.clawbacks.push({
        contractId: c.id,
        contractNo: c.contractNo,
        customerName: c.customerName,
        reason: cb.reason,
        rate,
        bookingMonth: ym(c.transactionDate),
      })
      e.clawbackAmount += rate
    }
  }

  // ===== ค่าคอมหาร้าน — ก้อน 1: ร้านที่หาในช่วงรายงาน (flat ยกขั้น นับร้านในช่วง) =====
  const shopsRecruitedInRange = new Map<string, number>() // empId -> จำนวนร้าน
  for (const s of shops) {
    if (s.recruitedBy && s.recruitedAt && inRange(s.recruitedAt)) {
      shopsRecruitedInRange.set(s.recruitedBy, (shopsRecruitedInRange.get(s.recruitedBy) ?? 0) + 1)
    }
  }
  for (const [empId, count] of shopsRecruitedInRange) {
    const e = ensureEmp(empId)
    e.recruitShopCount = count
    e.recruitShopRate = rateForShopCount(count, recruitTiers)
    e.recruitShopAmount = count * e.recruitShopRate
  }

  // ===== ค่าคอมหาร้าน — ก้อน 2: โบนัสร้านที่ส่งเคสครบเป้าภายในกรอบเวลา (นับจากวันหาร้าน) =====
  for (const s of shops) {
    if (!s.recruitedBy || !s.recruitedAt) continue
    const recruitStart = dateOnly(s.recruitedAt)
    const dates = caseDatesByShop.get(s.id) ?? []
    for (const rule of recruitBonuses) {
      if (rule.cases <= 0 || rule.bonus <= 0) continue
      const windowEnd = addMonths(recruitStart, rule.months)
      const inWindow = dates.filter((d) => d >= recruitStart && d <= windowEnd) // เรียงเก่า→ใหม่อยู่แล้ว
      if (inWindow.length < rule.cases) continue
      const hitDate = inWindow[rule.cases - 1] // วันที่เคสที่ N ส่งถึง = วันได้โบนัส
      if (!inRange(hitDate)) continue
      // เงื่อนไขเกรด: ร้านต้องเกรด A/B ณ สิ้นกรอบเวลา (windowEnd) ถึงได้โบนัส
      const shopContracts = contracts.filter(
        (c) => c.shopId === s.id && dateOnly(c.transactionDate) <= windowEnd,
      )
      let risky = 0
      for (const c of shopContracts) {
        if (isRiskyAsOf(instByContract.get(c.id) ?? [], windowEnd)) risky++
      }
      const grade = gradeFor(
        shopContracts.length ? (risky / shopContracts.length) * 100 : 0,
        shopContracts.length,
      )
      if (grade !== 'A' && grade !== 'B') continue // เกรด C ลงไป = อดโบนัส
      const e = ensureEmp(s.recruitedBy)
      e.recruitBonuses.push({
        shopId: s.id,
        shopName: s.name,
        cases: rule.cases,
        withinMonths: rule.months,
        bonus: rule.bonus,
        grade,
      })
      e.recruitBonusAmount += rule.bonus
    }
  }

  // ===== สรุปยอดต่อพนักงาน =====
  for (const e of emps.values()) {
    e.grossCount = e.grossCases.length
    // ล็อกแล้วใช้เรตที่ล็อก (อ่านจากเคสที่ล็อกตัวใดก็ได้); ไม่งั้นคิดสด
    const lockedCase = e.locked
      ? contracts.find(
          (c) =>
            empKey(c) === e.employeeId &&
            c.commissionLockedMonth === periodKey &&
            c.commissionRateLocked != null,
        )
      : undefined
    e.grossRate =
      lockedCase?.commissionRateLocked != null
        ? lockedCase.commissionRateLocked
        : rateForCaseCount(e.grossCount, tiers)
    e.grossAmount = e.grossCount * e.grossRate
    e.net = e.grossAmount - e.clawbackAmount
    e.recruitTotal = e.recruitShopAmount + e.recruitBonusAmount
    e.grandTotal = e.net + e.recruitTotal
  }

  return [...emps.values()].sort((a, b) => b.grandTotal - a.grandTotal)
}

/** แปลงรายงาน (คิดสด) -> รายการอัปเดตสำหรับปิดยอด: ทุกเคส gross ล็อกที่เรตของเจ้าของเคสเดือนนั้น */
export function lockUpdatesFor(report: EmployeeCommission[]): { contractId: string; rate: number }[] {
  const out: { contractId: string; rate: number }[] = []
  for (const e of report) {
    for (const g of e.grossCases) out.push({ contractId: g.contractId, rate: e.grossRate })
  }
  return out
}

// ===== ค่าคอมคืนเครื่อง (tier-based ตามราคาขาย) =====
// คิดจากราคาที่ขายได้จริง (salePrice) ×เปอร์เซ็นต์ตามช่วงราคา
// เรตเป็น % (ไม่ใช่บาท/เคส) — แตกต่างจาก CommissionTier ด้านบน

export interface DeviceReturnTier {
  min: number;       // ราคาขายตั้งแต่ (฿) — รวม
  max: number | null; // ถึง (฿); null = ไม่จำกัด (ขั้นสุดท้าย)
  percent: number;   // % ค่าคอม
}

export const DEFAULT_DEVICE_RETURN_TIERS: DeviceReturnTier[] = [
  { min: 0,     max: 5000,  percent: 5 },
  { min: 5001,  max: 10000, percent: 7 },
  { min: 10001, max: null,  percent: 10 },
];

export function deviceReturnTierLabel(t: DeviceReturnTier): string {
  const minStr = t.min.toLocaleString('th-TH');
  if (t.max == null) return `${minStr} ฿ขึ้นไป`;
  return `${minStr}–${t.max.toLocaleString('th-TH')} ฿`;
}

export function rateForDevicePrice(salePrice: number, tiers: DeviceReturnTier[]): number {
  const t = tiers.find((t) => salePrice >= t.min && (t.max == null || salePrice <= t.max));
  return t ? t.percent : 0;
}

export function deviceReturnCommission(salePrice: number, tiers: DeviceReturnTier[]): number {
  return Math.round((salePrice * rateForDevicePrice(salePrice, tiers)) / 100);
}
