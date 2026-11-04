// ===== กระจายค่าปรับตามงวด (pure function ล้วน — ไม่แตะ supabase) =====
// 2 หน้าที่ (mig 0181 record_payment_spread):
//   1) allocatePenaltySpread — จำลองการจัดสรร 3 ขั้นของ RPC เพื่อพรีวิวในกล่องรอตรวจ PJ
//        ขั้น 1: เรียง installmentNo ลงเท่ายอดค้าง (penaltyAmount - penaltyPaid) เท่าที่มี
//        ขั้น 2: เหลือ -> งวดที่ยังไม่จ่ายเงินต้น + due < วันชำระ (เรียง due, no) ไม่เกินเพดานต่องวด
//                เพดาน = min(perDay*maxDays, perDay*จำนวนวันที่เลยกำหนด ณ วันชำระ) หักที่จ่ายแล้ว+ที่จัดสรรรอบนี้
//        ขั้น 3: ยังเหลือ -> งวดเป้าหมายเดิม (0115): งวดแรกที่ค้างค่าปรับ, ไม่มีก็งวดแรกที่ยังไม่จ่าย
//   2) computePenaltyAlignTargets — หลัง RPC ลงเงินแล้ว หางวดที่ "ค่าปรับจ่ายเพิ่ม" โดยเทียบก่อน/หลัง
//        เพื่อตั้ง penalty_amount = ค่าปรับที่จ่ายแล้วรวมของงวดนั้น (ปุ่ม "ลงตาม PJ")
//        ทำงานถูกทั้งกับ RPC เก่า (ลงงวดเดียว) และ RPC ใหม่ (กระจาย) เพราะดูจากผลที่ลงจริงเท่านั้น

export interface PenaltySpreadInstallment {
  id: string
  installmentNo: number
  /** 'YYYY-MM-DD' */
  dueDate: string
  /** null = ยังไม่จ่ายเงินต้นครบ */
  paidAt: string | null
  /** installments.penalty_amount (ค่าปรับที่เรียกเก็บ ณ ตอนนี้) */
  penaltyAmount: number
  /** ค่าปรับที่จ่ายแล้วสะสม (cancel-aware: penaltyPaidForInstallment) */
  penaltyPaid: number
}

export interface PenaltyAllocation {
  id: string
  installmentNo: number
  amount: number
}

export interface PenaltySpreadResult {
  /** งวดที่จะได้รับค่าปรับ (รวมทุกขั้นต่องวด) เรียง installmentNo */
  allocations: PenaltyAllocation[]
  /** true = ขั้น 3 ไม่มีงวดให้ลง (RPC จะ raise exception) — ยอดที่เหลืออยู่ใน unallocated */
  noTarget: boolean
  unallocated: number
}

const MS_PER_DAY = 86_400_000

/** จำนวนวันเต็มจาก dueDate ถึง paidDate (ทั้งคู่ 'YYYY-MM-DD', คิดแบบ UTC เหมือน date - date ใน SQL) */
export function daysBetweenDates(dueDate: string, paidDate: string): number {
  const d = Date.parse(`${dueDate.slice(0, 10)}T00:00:00Z`)
  const p = Date.parse(`${paidDate.slice(0, 10)}T00:00:00Z`)
  return Math.round((p - d) / MS_PER_DAY)
}

/** งวดเป้าหมายเดิม (0115): งวดแรกที่ penaltyAmount > paid, ไม่มีก็งวดแรกที่ยังไม่จ่าย */
function pickTarget(sorted: PenaltySpreadInstallment[]): PenaltySpreadInstallment | null {
  return (
    sorted.find(r => r.penaltyAmount > r.penaltyPaid) ??
    sorted.find(r => r.paidAt === null) ??
    null
  )
}

export function allocatePenaltySpread(input: {
  installments: PenaltySpreadInstallment[]
  penalty: number
  /** 'YYYY-MM-DD' วันชำระตาม UTC (= (p_paid_at at time zone 'UTC')::date) */
  paidDate: string
  perDay: number
  maxDays: number
}): PenaltySpreadResult {
  const sorted = [...input.installments].sort((a, b) => a.installmentNo - b.installmentNo)
  const alloc = new Map<string, number>()
  const add = (id: string, n: number) => alloc.set(id, (alloc.get(id) ?? 0) + n)
  let left = Math.max(0, input.penalty)

  // ขั้น 1
  for (const r of sorted) {
    if (left <= 0) break
    const owed = r.penaltyAmount - r.penaltyPaid
    if (owed <= 0) continue
    const a = Math.min(owed, left)
    add(r.id, a)
    left -= a
  }

  // ขั้น 2
  if (left > 0) {
    const fullCap = input.perDay * input.maxDays
    const step2 = sorted
      .filter(r => r.paidAt === null && r.dueDate.slice(0, 10) < input.paidDate.slice(0, 10))
      .sort((a, b) =>
        a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.installmentNo - b.installmentNo,
      )
    for (const r of step2) {
      if (left <= 0) break
      const cap = Math.min(fullCap, input.perDay * daysBetweenDates(r.dueDate, input.paidDate))
      const cur = r.penaltyPaid + (alloc.get(r.id) ?? 0)
      if (cur >= cap) continue
      const a = Math.min(cap - cur, left)
      add(r.id, a)
      left -= a
    }
  }

  // ขั้น 3
  let noTarget = false
  if (left > 0) {
    const target = pickTarget(sorted)
    if (target) {
      add(target.id, left)
      left = 0
    } else {
      noTarget = true
    }
  }

  const allocations = sorted
    .filter(r => (alloc.get(r.id) ?? 0) > 0)
    .map(r => ({ id: r.id, installmentNo: r.installmentNo, amount: alloc.get(r.id) as number }))
  return { allocations, noTarget, unallocated: left }
}

/**
 * หลัง RPC ลงเงินแล้ว: งวดไหนค่าปรับจ่ายเพิ่ม (after > before) -> คืน {installmentId, amount = ค่าปรับที่จ่ายแล้วรวมหลังลง}
 * ไม่มีงวดเปลี่ยน -> [] (caller ไม่ต้องเรียก RPC ตั้งค่าอะไร)
 * @param before id -> ค่าปรับจ่ายแล้วสะสม "ก่อน" ลง (id ที่ไม่อยู่ใน map = 0)
 * @param after  id -> ค่าปรับจ่ายแล้วสะสม "หลัง" ลง
 */
export function computePenaltyAlignTargets(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): { installmentId: string; amount: number }[] {
  const out: { installmentId: string; amount: number }[] = []
  for (const [id, a] of after) {
    if (a > (before.get(id) ?? 0)) out.push({ installmentId: id, amount: a })
  }
  return out
}
