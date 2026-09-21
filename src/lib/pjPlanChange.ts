// ===== "PJ เปลี่ยนแผนผ่อน/วันชำระ" (PLAN_CHANGE_*) — pure types + helper ล้วน ไม่แตะ supabase =====
// เพิ่ม 21 ก.ย. 2026: pj-sync ตรวจจับตอนร้านเปลี่ยนวันชำระ/แผนผ่อนใน PJ แล้วยิงเข้ากล่องรอตรวจ 3 reason
// (ดู PjSyncReviewReason ใน types.ts สำหรับความหมายเต็มของแต่ละ reason)
//
// รายละเอียดจริง (ตารางเทียบงวด "เราถือ vs PJ ว่า") อยู่ใน raw_json ของแถว — ดึงแยกต่อแถวผ่าน
// getPjPlanChangeDetail (db.ts) เหมือน RECEIPT_MISSING/RECEIPT_CHANGED ไม่ join ทุกแถวเพราะแถวส่วนใหญ่
// ไม่ใช่ reason นี้ shape ของ raw_json เป็นสัญญาจากฝั่ง pj-sync (น้องชีส) — เขียนกันพังทุก field เพราะ
// ยังไม่ล็อกสัญญา 100% ตอนที่เขียนไฟล์นี้ (21 ก.ย. 2026)

import type { PjSyncReviewReason } from './types'

export function isPlanChangeReason(reason: PjSyncReviewReason): boolean {
  return reason === 'PLAN_CHANGE_REVIEW' || reason === 'PLAN_CHANGE_DRYRUN' || reason === 'PLAN_CHANGE_AUTO'
}

/** true = เคสนี้ต้องให้คนไปแก้ที่หน้าสัญญาเอง แล้วกลับมากดยืนยันพร้อมหมายเหตุบังคับ (ต่างจาก AUTO ที่ระบบ
 *  ทำให้แล้ว แค่ต้องรับทราบ) */
export function isPlanChangeManualFixReason(reason: PjSyncReviewReason): boolean {
  return reason === 'PLAN_CHANGE_REVIEW' || reason === 'PLAN_CHANGE_DRYRUN'
}

/** 1 แถวเทียบงวด (เราถือ vs PJ ว่า) จาก raw_json.comparison — ทุก field เป็น optional เพราะ shape จริง
 *  มาจากฝั่ง pj-sync (น้องชีสเขียน) ยังไม่ล็อกสัญญา 100% ต้องกันพังทุกช่อง */
export interface PjPlanChangeComparisonRow {
  no: number
  ourDue: string | null
  pjDue: string | null
  ourAmount: number | null
  pjAmount: number | null
  status: string | null
}

export interface PjPlanChangeSnapshot {
  comparison: PjPlanChangeComparisonRow[]
  proposedDueDay: number | null
  decisionReason: string | null
  /** ข้อมูลดิบเป็นข้อความ — โชว์แทนตารางเมื่อ raw_json ไม่มี field ที่คาดไว้เลย (กันพัง ไม่ใช่หน้าจอว่างเปล่า) */
  rawNote: string | null
}

/** true ถ้าแถวมีวันที่ต่างกัน (our_due ≠ pj_due) — ใช้ไฮไลต์แถวในตารางเทียบ */
export function comparisonRowDiffers(row: PjPlanChangeComparisonRow): boolean {
  return !!row.ourDue && !!row.pjDue && row.ourDue !== row.pjDue
}
