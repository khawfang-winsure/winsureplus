// ===== Workflow Bottleneck Detection — pure function =====
// ตรวจเคสที่ค้างในระบบ: Device Pipeline ล่าช้า + ลูกค้านัดจ่ายแล้วผิดนัด
// check #2 (no_followup_overdue) ข้ามในรอบนี้ — ต้องการ bulk lastFollowUpAt จาก db.ts

export type BottleneckType =
  | 'stuck_device_pipeline' // device_return ติดสถานะเดิม > N วัน
  | 'no_followup_overdue'   // contract bucket >= 11-30 days แต่ไม่มี follow_up >7 วัน
  | 'letter_overdue'        // จดหมายควรส่งแต่ยังไม่ส่ง (ถ้ามี data)
  | 'promise_overdue'       // promise_to_pay_date เลยมาแล้วยังไม่ clear

export interface BottleneckAlert {
  type: BottleneckType
  contractId: string | null
  contractNo: string | null
  customerName: string | null
  message: string      // Thai user-facing
  severity: 'red' | 'amber'
  daysStuck: number
}

export interface BottleneckInput {
  deviceReturns: Array<{
    id: string
    contractId: string
    contractNo: string
    customerName: string
    deviceStatus: string
    deviceStatusUpdatedAt: string | null
  }>
  contractsWithStatus: Array<{
    id: string
    contractNo: string
    customerName: string
    bucket: string
    daysLate: number
    lastFollowUpAt: string | null
  }>
  promiseOverdue: Array<{
    contractId: string
    contractNo: string
    customerName: string
    promiseToPayDate: string // 'YYYY-MM-DD'
  }>
  todayISO: string
}

// วัน threshold ต่อสถานะ Device Pipeline
const STUCK_THRESHOLDS: Record<string, number> = {
  pending_check: 3,  // รอตรวจสอบ > 3 วัน = stuck
  checked: 5,        // ตรวจสอบเรียบร้อยแล้ว > 5 วัน (ควร list ขายแล้ว)
  pending_sale: 7,   // รอเสนอขาย > 7 วัน
  priced: 5,         // ได้ราคาแล้วรอร้านโอน > 5 วัน
  transferred: 3,    // ร้านโอนแล้วรอจัดส่ง > 3 วัน
}

const LATE_BUCKETS = ['11-30', '31-60', '61-90', '91-120', '120+']

export function detectBottlenecks(input: BottleneckInput): BottleneckAlert[] {
  const alerts: BottleneckAlert[] = []
  const today = new Date(input.todayISO)

  // ─── 1) stuck_device_pipeline ───────────────────────────────────────────────
  for (const r of input.deviceReturns) {
    // shipped = ปิดแล้ว, ข้าม
    if (r.deviceStatus === 'shipped') continue
    if (!r.deviceStatusUpdatedAt) continue

    const updatedAt = new Date(r.deviceStatusUpdatedAt)
    const days = Math.floor((today.getTime() - updatedAt.getTime()) / 86400000)
    const threshold = STUCK_THRESHOLDS[r.deviceStatus] ?? 7

    if (days > threshold) {
      alerts.push({
        type: 'stuck_device_pipeline',
        contractId: r.contractId,
        contractNo: r.contractNo,
        customerName: r.customerName,
        message: `เครื่องคืนค้างสถานะ "${r.deviceStatus}" มา ${days} วัน (ปกติ ≤ ${threshold} วัน)`,
        severity: days > threshold * 2 ? 'red' : 'amber',
        daysStuck: days,
      })
    }
  }

  // ─── 2) no_followup_overdue — ข้ามในรอบนี้ (ต้องการ bulk follow_up query) ──
  // contractsWithStatus ถูกส่งเข้ามาเพื่อ forward-compat
  // ตรวจเฉพาะเมื่อ lastFollowUpAt ถูก populate (ไม่ใช่ null ทั้งหมด)
  const hasFollowUpData = input.contractsWithStatus.some((c) => c.lastFollowUpAt !== null)
  if (hasFollowUpData) {
    for (const c of input.contractsWithStatus) {
      if (!LATE_BUCKETS.includes(c.bucket)) continue
      const lastFollowUpAt = c.lastFollowUpAt ? new Date(c.lastFollowUpAt) : null
      const daysSinceFollowUp = lastFollowUpAt
        ? Math.floor((today.getTime() - lastFollowUpAt.getTime()) / 86400000)
        : null
      // ข้ามถ้าไม่รู้ lastFollowUpAt (null = ไม่มีข้อมูล ไม่ใช่ "ไม่เคยติดตาม")
      if (daysSinceFollowUp !== null && daysSinceFollowUp > 7) {
        alerts.push({
          type: 'no_followup_overdue',
          contractId: c.id,
          contractNo: c.contractNo,
          customerName: c.customerName,
          message: `ล่าช้า ${c.daysLate} วัน — ไม่มีการติดตามมา ${daysSinceFollowUp} วัน`,
          severity: daysSinceFollowUp > 14 ? 'red' : 'amber',
          daysStuck: daysSinceFollowUp,
        })
      }
    }
  }

  // ─── 3) promise_overdue (ลูกค้านัดแล้วไม่จ่าย) ─────────────────────────────
  for (const p of input.promiseOverdue) {
    const promiseDate = new Date(p.promiseToPayDate)
    const daysOverdue = Math.floor((today.getTime() - promiseDate.getTime()) / 86400000)
    if (daysOverdue > 0) {
      alerts.push({
        type: 'promise_overdue',
        contractId: p.contractId,
        contractNo: p.contractNo,
        customerName: p.customerName,
        message: `นัดจ่าย ${p.promiseToPayDate} เลยมา ${daysOverdue} วัน`,
        severity: daysOverdue > 7 ? 'red' : 'amber',
        daysStuck: daysOverdue,
      })
    }
  }

  // sort: red ก่อน, จากนั้น daysStuck มากสุดก่อน
  alerts.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'red' ? -1 : 1
    return b.daysStuck - a.daysStuck
  })

  return alerts
}
