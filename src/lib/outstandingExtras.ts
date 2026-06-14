// ===== ค่าใช้จ่ายอื่นๆ ของสัญญา + ยอดค้างรวม =====

export interface ExtraCharge {
  id: string
  contractId: string
  amount: number
  reason: string
  createdAt: string
  createdBy: string | null
}

// รวมค่าใช้จ่ายอื่นๆ ทั้งหมดของสัญญานี้
// Trace: [] → 0 | [{100},{50}] → 150
export function sumExtraCharges(charges: ExtraCharge[]): number {
  return charges.reduce((s, c) => s + (c.amount || 0), 0)
}

// ยอดค้างรวม = ค่าปรับค้าง + ค่าใช้จ่ายอื่นๆ + เงินต้นที่เหลือ
// Math.max(0, ...) ป้องกันกรณีที่ penaltyDue เป็นลบ (ไม่ควรเกิด แต่ป้องกันไว้)
// Trace: (500, 200, 10000) → 10700 | (0, 0, 0) → 0 | (-100, 50, 0) → 0
export function totalOutstanding(
  penaltyDue: number,
  extraChargesSum: number,
  principalRemaining: number,
): number {
  return Math.max(0, penaltyDue + extraChargesSum + principalRemaining)
}
