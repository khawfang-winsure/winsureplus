// (0184) record_payment_spread จองใบเสร็จ PJ ก่อนลงเงิน: ถ้าใบไหนถูกลงไปแล้ว (เช่น พนักงานกดปุ่มกล่องรอตรวจตัดหน้า cron)
// RPC จะ raise SQLSTATE PJ409 + ข้อความ [PJS:RECEIPT_ALREADY_APPLIED] และไม่ลงเงินเลย
// pj-sync ต้องถือว่านี่คือ "ลงไปแล้ว" ไม่ใช่ error: ไม่เข้ากล่อง ไม่นับ applied ไม่เขียน ledger/ปิดแถว
export const RECEIPT_ALREADY_APPLIED_CODE = "PJ409";
export const RECEIPT_ALREADY_APPLIED_TAG = "[PJS:RECEIPT_ALREADY_APPLIED]";

export function isReceiptAlreadyAppliedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === RECEIPT_ALREADY_APPLIED_CODE) return true;
  return typeof e.message === "string" && e.message.includes(RECEIPT_ALREADY_APPLIED_TAG);
}
