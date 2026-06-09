// ===== ค่าคอมมิชชั่นแบบขั้นบันได (ตั้งค่าได้ ไม่ hardcode) =====
// หน่วย = บาท/เคส · คิดตอนบันทึกสัญญา · เก็บใน app_settings key='commission_tiers' (JSON)
// ส่วนล่างของไฟล์ = ตัวสร้างรายงานค่าคอมต่อพนักงานต่อเดือน (gross − clawback = net)

import type { Contract, DeviceReturnRow } from './types'

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

export interface EmployeeCommission {
  employeeId: string
  employeeName: string
  grossCount: number // จำนวนเคสที่บันทึกในเดือนนี้
  grossRate: number // เรต flat (บาท/เคส) ของเดือนนี้
  grossAmount: number // grossCount × grossRate
  grossCases: GrossCase[]
  clawbackAmount: number // รวมยอดหักคืน
  clawbacks: ClawbackCase[]
  net: number // grossAmount − clawbackAmount
  locked: boolean // เดือนนี้ของคนนี้ปิดยอด (ล็อกเรต) แล้วหรือยัง
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

interface ClawbackEvent {
  reason: ClawbackReason
  month: string // yyyy-mm ที่เหตุการณ์เกิด (เดือนที่งวดล่าช้าครบ 30 วัน)
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
  return { reason, month: ym(addDays(earliest.due, LATE_DAYS)) }
}

/** สร้างรายงานค่าคอมของทุกพนักงาน สำหรับเดือนหนึ่ง (yyyy-mm) */
export function buildCommissionReport(
  month: string,
  contracts: Contract[],
  installments: ReportInstallment[],
  returns: DeviceReturnRow[],
  tiers: CommissionTier[],
  asOf: string,
): EmployeeCommission[] {
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

  const empKey = (c: Contract) => c.recordedById ?? 'unknown'
  const empName = (c: Contract) => c.recordedBy || '(ไม่ระบุผู้บันทึก)'

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
  const ensure = (c: Contract): EmployeeCommission => {
    const id = empKey(c)
    let e = emps.get(id)
    if (!e) {
      e = {
        employeeId: id,
        employeeName: empName(c),
        grossCount: 0,
        grossRate: 0,
        grossAmount: 0,
        grossCases: [],
        clawbackAmount: 0,
        clawbacks: [],
        net: 0,
        locked: false,
      }
      emps.set(id, e)
    }
    return e
  }

  for (const c of contracts) {
    // (ก) ได้ค่าคอม — เคสที่บันทึกในเดือนรายงาน
    if (ym(c.transactionDate) === month) {
      const e = ensure(c)
      e.grossCases.push({ contractId: c.id, contractNo: c.contractNo, customerName: c.customerName })
      if (c.commissionLockedMonth === month) e.locked = true
    }
    // (ข) หักคืน — เคสที่ "เสีย" ในเดือนรายงาน (ไม่ว่าบันทึกเดือนไหน)
    const cb = detectClawback(c, instByContract.get(c.id) ?? [], retById.get(c.id), asOf)
    if (cb && cb.month === month) {
      const e = ensure(c)
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

  for (const e of emps.values()) {
    e.grossCount = e.grossCases.length
    // ล็อกแล้วใช้เรตที่ล็อก (อ่านจากเคสที่ล็อกตัวใดก็ได้); ไม่งั้นคิดสด
    const lockedCase = e.locked
      ? contracts.find(
          (c) =>
            empKey(c) === e.employeeId &&
            c.commissionLockedMonth === month &&
            c.commissionRateLocked != null,
        )
      : undefined
    e.grossRate =
      lockedCase?.commissionRateLocked != null
        ? lockedCase.commissionRateLocked
        : rateForCaseCount(e.grossCount, tiers)
    e.grossAmount = e.grossCount * e.grossRate
    e.net = e.grossAmount - e.clawbackAmount
  }

  return [...emps.values()].sort((a, b) => b.net - a.net)
}

/** แปลงรายงาน (คิดสด) -> รายการอัปเดตสำหรับปิดยอด: ทุกเคส gross ล็อกที่เรตของเจ้าของเคสเดือนนั้น */
export function lockUpdatesFor(report: EmployeeCommission[]): { contractId: string; rate: number }[] {
  const out: { contractId: string; rate: number }[] = []
  for (const e of report) {
    for (const g of e.grossCases) out.push({ contractId: g.contractId, rate: e.grossRate })
  }
  return out
}
