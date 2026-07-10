// ===== รายงาน "พนักงานโทรตามเครื่องคืนได้กี่เคส/คน" — Pure Function =====
// ไม่มี side-effect / ไม่มี I/O — ทดสอบได้เองโดยไม่ต้อง mock DB
// input มาจาก getDeviceReturnByCollector() ใน db.ts (v_device_return_report + profiles)
//
// Attribution (Pete locked): ใช้ attributed_freelancer_id (mig 0035) — คนที่บันทึก
//   follow_up result='returned' ล่าสุดภายใน 30 วันก่อนคืนเครื่อง = "คนที่โทรจนลูกค้ายอมคืน"
//   ตัวเดียวกับที่ commission.getDeviceReturnCountsByFreelancerThisMonth ใช้อยู่
//   ไม่ใช่ assigned_to (คนถือเคส อาจไม่ใช่คนที่โทรสำเร็จ)
//
// caller (db.ts) ต้องกรองช่วงวันที่ (return_date ใน [from, to]) + dedupe 1 แถวต่อสัญญา
//   มาก่อนแล้ว (v_device_return_report ทำ dedupe ให้อยู่แล้วผ่าน distinct-on contract_id)

// ============================================================================
// Types
// ============================================================================

/** 1 แถว = 1 สัญญาที่คืนเครื่อง (dedupe แล้ว, กรองช่วงวันแล้วจาก caller) */
export interface DeviceReturnByCollectorInputRow {
  contractId: string
  collectorId: string | null   // = attributed_freelancer_id; null = ไม่มี follow_up ผูก (เคสเก่า/ไม่พบ)
  returnDate: string | null
  caseNo: number | null        // 1 | 2 | 3 ปกติ; null ได้ (18 เคสเก่าไม่มีแถว device_returns)
  devicePrice: number | null   // contracts.device_price — null → นับเป็น 0
}

export interface DeviceReturnByCollectorResult {
  collectorId: string          // uuid จริง หรือ sentinel 'unassigned'
  name: string                 // ชื่อจาก profileNames map, 'ยังไม่ระบุ' ถ้า unassigned
  count: number                // จำนวนเคสที่คืนเครื่อง
  totalValue: number           // Σ device_price ของกลุ่มนี้ (null ในแต่ละแถวนับเป็น 0)
  byCaseNo: { case1: number; case2: number; case3: number } // นับตาม case_no (ไม่นับ null/นอกช่วง 1-3)
}

const UNASSIGNED_ID = 'unassigned'
const UNASSIGNED_NAME = 'ยังไม่ระบุ'

// ============================================================================
// Core: buildDeviceReturnByCollector
// ============================================================================

/**
 * สรุปจำนวนเคส + มูลค่าเครื่องที่คืนได้ ต่อ 1 พนักงาน (attributed_freelancer_id)
 * เรียงจากคืนได้เยอะสุดไปน้อยสุด (count desc) — กลุ่ม "ยังไม่ระบุ" ท้ายสุดเสมอ ไม่ว่า count เท่าไหร่
 *
 * @param rows          แถวคืนเครื่อง (กรองช่วงวัน + dedupe มาแล้วจาก caller)
 * @param profileNames  map id → full_name (จาก getEmployees() หรือเทียบเท่า)
 *
 * @example
 * // เคสปกติ 2 คน + 1 เคสไม่มี attribution
 * buildDeviceReturnByCollector(
 *   [
 *     { contractId: 'c1', collectorId: 'u1', returnDate: '2026-07-01', caseNo: 1, devicePrice: 15000 },
 *     { contractId: 'c2', collectorId: 'u1', returnDate: '2026-07-02', caseNo: 2, devicePrice: 12000 },
 *     { contractId: 'c3', collectorId: 'u2', returnDate: '2026-07-03', caseNo: 1, devicePrice: 20000 },
 *     { contractId: 'c4', collectorId: null, returnDate: '2026-07-04', caseNo: null, devicePrice: 18000 },
 *   ],
 *   new Map([['u1', 'สมชาย'], ['u2', 'สมหญิง']])
 * )
 * // →
 * // [
 * //   { collectorId: 'u1', name: 'สมชาย', count: 2, totalValue: 27000, byCaseNo: { case1: 1, case2: 1, case3: 0 } },
 * //   { collectorId: 'u2', name: 'สมหญิง', count: 1, totalValue: 20000, byCaseNo: { case1: 1, case2: 0, case3: 0 } },
 * //   { collectorId: 'unassigned', name: 'ยังไม่ระบุ', count: 1, totalValue: 18000, byCaseNo: { case1: 0, case2: 0, case3: 0 } },
 * // ]
 *
 * @example
 * // rows ว่าง → []
 * buildDeviceReturnByCollector([], new Map())
 * // → []
 *
 * @example
 * // devicePrice null ไม่ทำ NaN — นับเป็น 0
 * buildDeviceReturnByCollector(
 *   [{ contractId: 'c1', collectorId: 'u1', returnDate: '2026-07-01', caseNo: 1, devicePrice: null }],
 *   new Map([['u1', 'สมชาย']])
 * )
 * // → [{ collectorId: 'u1', name: 'สมชาย', count: 1, totalValue: 0, byCaseNo: { case1: 1, case2: 0, case3: 0 } }]
 *
 * @example
 * // unassigned มากกว่า assigned ในจำนวนเคส ก็ยังต้องอยู่ท้ายสุด (ไม่ sort ตาม count ปน)
 * buildDeviceReturnByCollector(
 *   [
 *     { contractId: 'c1', collectorId: null, returnDate: '2026-07-01', caseNo: null, devicePrice: 1000 },
 *     { contractId: 'c2', collectorId: null, returnDate: '2026-07-02', caseNo: null, devicePrice: 1000 },
 *     { contractId: 'c3', collectorId: 'u1', returnDate: '2026-07-03', caseNo: 1, devicePrice: 5000 },
 *   ],
 *   new Map([['u1', 'สมชาย']])
 * )
 * // →
 * // [
 * //   { collectorId: 'u1', name: 'สมชาย', count: 1, totalValue: 5000, byCaseNo: { case1: 1, case2: 0, case3: 0 } },
 * //   { collectorId: 'unassigned', name: 'ยังไม่ระบุ', count: 2, totalValue: 2000, byCaseNo: { case1: 0, case2: 0, case3: 0 } },
 * // ]
 */
export function buildDeviceReturnByCollector(
  rows: DeviceReturnByCollectorInputRow[],
  profileNames: Map<string, string>
): DeviceReturnByCollectorResult[] {
  if (rows.length === 0) return []

  const groups = new Map<string, DeviceReturnByCollectorResult>()

  for (const row of rows) {
    const key = row.collectorId ?? UNASSIGNED_ID
    let group = groups.get(key)
    if (!group) {
      group = {
        collectorId: key,
        name: key === UNASSIGNED_ID ? UNASSIGNED_NAME : (profileNames.get(key) ?? 'ไม่พบชื่อ'),
        count: 0,
        totalValue: 0,
        byCaseNo: { case1: 0, case2: 0, case3: 0 },
      }
      groups.set(key, group)
    }
    group.count += 1
    group.totalValue += row.devicePrice ?? 0
    if (row.caseNo === 1) group.byCaseNo.case1 += 1
    else if (row.caseNo === 2) group.byCaseNo.case2 += 1
    else if (row.caseNo === 3) group.byCaseNo.case3 += 1
  }

  const assigned = [...groups.values()]
    .filter((g) => g.collectorId !== UNASSIGNED_ID)
    .sort((a, b) => b.count - a.count)
  const unassigned = groups.get(UNASSIGNED_ID)

  return unassigned ? [...assigned, unassigned] : assigned
}
