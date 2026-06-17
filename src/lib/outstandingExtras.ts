// ===== ค่าใช้จ่ายอื่นๆ ของสัญญา + ยอดค้างรวม =====

import type { Installment } from './types'

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

// ===== outstandingAfterReturn =====
// กฎ: หลังลูกค้าคืนเครื่อง ยอดที่ต้องชำระ = งวดค้างเก่าสุด (1 งวด) + ค่าปรับ + ค่าซ่อม + อื่นๆ
// "ค้างเก่าสุด" = min(dueDate) ใน installments ที่ paidAt === null
// Partial-pay: installmentAmount = amount − paidAmount (เพื่อไม่นับส่วนที่จ่ายไปแล้ว)

export interface OutstandingAfterReturnResult {
  installmentAmount: number   // ค่างวดเก่าสุดที่ค้าง (หักส่วนที่จ่ายบางส่วนแล้ว)
  penaltyAmount: number       // ค่าปรับของงวดนั้น
  repairCost: number          // ค่าซ่อม (extras ที่ reason มี 'ซ่อม')
  otherExtras: number         // extras อื่นๆ ที่ไม่ใช่ค่าซ่อม
  total: number               // รวมทั้งหมด
  details: {
    installmentNo: number     // เลขงวด
    dueDate: string
  } | null                   // null = ไม่มีงวดค้าง
}

export function outstandingAfterReturn(
  installments: Installment[],
  extras: ExtraCharge[],
): OutstandingAfterReturnResult {
  const zeros: OutstandingAfterReturnResult = {
    installmentAmount: 0,
    penaltyAmount: 0,
    repairCost: 0,
    otherExtras: 0,
    total: 0,
    details: null,
  }

  // 1) รวบรวมงวดที่ยังไม่ได้จ่าย (paidAt === null คือ discriminator หลัก)
  const unpaid = installments.filter(i => i.paidAt === null)
  if (unpaid.length === 0) return zeros

  // 2) หางวดเก่าสุด = min dueDate (ISO YYYY-MM-DD เปรียบ lexical ได้)
  const oldest = unpaid.reduce((min, i) =>
    (i.dueDate < min.dueDate ? i : min)
  )

  // 3) คำนวณค่างวดที่ยังค้าง (กัน partial-pay)
  const installmentAmount = Math.max(0, oldest.amount - (oldest.paidAmount || 0))
  const penaltyAmount = oldest.penaltyAmount || 0

  // 4) แยก extras ค่าซ่อม vs อื่นๆ
  const repairCost = extras
    .filter(e => e.reason.includes('ซ่อม'))
    .reduce((s, e) => s + (e.amount || 0), 0)

  const otherExtras = extras
    .filter(e => !e.reason.includes('ซ่อม'))
    .reduce((s, e) => s + (e.amount || 0), 0)

  const total = installmentAmount + penaltyAmount + repairCost + otherExtras

  return {
    installmentAmount,
    penaltyAmount,
    repairCost,
    otherExtras,
    total,
    details: {
      installmentNo: oldest.installmentNo,
      dueDate: oldest.dueDate,
    },
  }
}
