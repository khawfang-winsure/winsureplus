// ===== Pure functions สำหรับ "สร้างตารางงวดใหม่ตอนแก้สัญญา" =====
// Wave 2 — 2026-06-25

import { buildSchedule } from './calc'
import type { Contract, Installment } from './types'

// ---------- ประเภท ----------

export type RegenSafetyResult =
  | { status: 'safe' }
  | { status: 'blocked_paid'; reason: string; paidCount: number }
  | { status: 'blocked_extended'; reason: string }

export interface SchedulePreviewRow {
  installmentNo: number
  dueDate: string // 'YYYY-MM-DD' (local, timezone-safe)
  amount: number
}

// ---------- ฟังก์ชัน 1: ตรวจว่าต้องสร้างตารางใหม่ไหม ----------

/**
 * คืน true ถ้าการแก้สัญญาเปลี่ยนอย่างน้อย 1 ใน:
 * transactionDate / dueDay / termMonths / monthlyPayment
 * (fields เหล่านี้กำหนดตารางงวดทั้งหมด)
 */
export function scheduleRegenFields(prev: Contract, next: Contract): boolean {
  return (
    prev.transactionDate !== next.transactionDate ||
    prev.dueDay !== next.dueDay ||
    prev.termMonths !== next.termMonths ||
    prev.monthlyPayment !== next.monthlyPayment
  )
}

// ---------- ฟังก์ชัน 2: ตรวจความปลอดภัยก่อน regen ----------

/**
 * ตรวจว่า regen ปลอดภัยไหม
 * ลำดับการตรวจ: blocked_extended ก่อน → blocked_paid → safe
 *
 * จ่ายบางส่วน (paidAt=null แต่ paidAmount>0) = ยังไม่ชำระสมบูรณ์ → ไม่ block
 */
export function regenSafety(
  installments: Installment[],
  extensions: { id: string }[],
): RegenSafetyResult {
  if (extensions.length > 0) {
    return {
      status: 'blocked_extended',
      reason:
        'สัญญานี้เคยปรับโครงสร้างแล้ว — ไม่สามารถสร้างตารางงวดใหม่ได้ หากต้องการแก้ไขกรุณาใช้เมนูขยายระยะเวลา',
    }
  }

  const paidCount = installments.filter((i) => i.paidAt !== null).length
  if (paidCount > 0) {
    return {
      status: 'blocked_paid',
      reason: `มีงวดที่ชำระแล้ว ${paidCount} งวด — ไม่สามารถสร้างตารางงวดใหม่ได้ เพราะจะลบประวัติการชำระ`,
      paidCount,
    }
  }

  return { status: 'safe' }
}

// ---------- ฟังก์ชัน 3: preview ตารางงวดใหม่ ----------

/**
 * คำนวณตารางงวดจาก parameters ของสัญญา
 * ใช้ buildSchedule จาก calc.ts (ไม่เขียน date math ซ้ำ)
 * คืน dueDate เป็น 'YYYY-MM-DD' แบบ local (ใช้ getFullYear/getMonth/getDate ไม่ใช่ toISOString)
 */
export function computeSchedulePreview(
  transactionDate: string,
  dueDay: number,
  termMonths: number,
  monthlyPayment: number,
): SchedulePreviewRow[] {
  const dates = buildSchedule(transactionDate, dueDay, termMonths)
  return dates.map((d, idx) => {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return {
      installmentNo: idx + 1,
      dueDate: `${y}-${m}-${day}`,
      amount: monthlyPayment,
    }
  })
}
