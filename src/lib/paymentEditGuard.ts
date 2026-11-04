// กันพนักงานลดยอดงวดด้วยโหมด "แก้ไขยอด" แล้วลงเงินใหม่ — การแก้ยอดไม่ลบรายการรับเงินเดิม รายงานจึงนับซ้ำ

/** ยอดใหม่น้อยกว่ายอดที่จ่ายแล้วปัจจุบัน = ลดยอด (เท่าเดิม/เพิ่ม = false) */
export function isPaymentReduction(current: number, next: number): boolean {
  return next < current
}

/** บันทึกได้เมื่อไม่ใช่การลดยอด หรือ (ติ๊กยืนยันแล้ว และมีหมายเหตุไม่ว่าง) */
export function canSaveEdit(reduction: boolean, confirmed: boolean, note: string): boolean {
  return !reduction || (confirmed && note.trim().length > 0)
}
