// ===== ค่าคอมมิชชั่นแบบขั้นบันได (ตั้งค่าได้ ไม่ hardcode) =====
// หน่วย = บาท/เคส · คิดตอนบันทึกสัญญา · เก็บใน app_settings key='commission_tiers' (JSON)
// สูตรคำนวณจริง + การหักคืน (clawback) จะทำในขั้นถัดไป

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
