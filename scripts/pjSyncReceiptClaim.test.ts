// ทดสอบตัวแยก error "ใบเสร็จถูกลงไปแล้ว" ของ pj-sync (0184) — รัน: npx tsx --test scripts/pjSyncReceiptClaim.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isReceiptAlreadyAppliedError } from '../supabase/functions/pj-sync/receiptClaim.ts'

test('จับด้วยรหัส PJ409', () => {
  assert.equal(isReceiptAlreadyAppliedError({ code: 'PJ409', message: 'x' }), true)
})
test('จับด้วยข้อความ tag เมื่อ code หาย', () => {
  assert.equal(isReceiptAlreadyAppliedError({ message: '[PJS:RECEIPT_ALREADY_APPLIED] ใบเสร็จ PJ ถูกลงไปแล้ว 1 ใบ' }), true)
})
test('error อื่นต้องไม่ถูกกลืน (deadlock, permission, ยอดติดลบ)', () => {
  assert.equal(isReceiptAlreadyAppliedError({ code: '40P01', message: 'deadlock detected' }), false)
  assert.equal(isReceiptAlreadyAppliedError({ code: '42501', message: 'permission denied' }), false)
  assert.equal(isReceiptAlreadyAppliedError({ message: 'ยอดติดลบไม่ถูกต้อง' }), false)
})
test('ค่าว่าง/ไม่ใช่ object = false', () => {
  assert.equal(isReceiptAlreadyAppliedError(null), false)
  assert.equal(isReceiptAlreadyAppliedError(undefined), false)
  assert.equal(isReceiptAlreadyAppliedError('PJ409'), false)
})
