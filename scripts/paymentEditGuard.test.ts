// ทดสอบ paymentEditGuard — รัน: npx tsx --test scripts/paymentEditGuard.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPaymentReduction, canSaveEdit } from '../src/lib/paymentEditGuard.ts'

test('ยอดน้อยลง (รวมลดเป็น 0) = ลดยอด', () => {
  assert.equal(isPaymentReduction(1000, 500), true)
  assert.equal(isPaymentReduction(1000, 0), true)
})

test('ยอดเท่าเดิมหรือเพิ่ม = ไม่ใช่ลดยอด', () => {
  assert.equal(isPaymentReduction(1000, 1000), false)
  assert.equal(isPaymentReduction(1000, 1500), false)
  assert.equal(isPaymentReduction(0, 0), false)
})

test('ไม่ลดยอด บันทึกได้เลย แม้ไม่ติ๊ก/ไม่มีหมายเหตุ', () => {
  assert.equal(canSaveEdit(false, false, ''), true)
})

test('ลดยอด ต้องติ๊กและมีหมายเหตุ (ช่องว่างล้วนไม่นับ)', () => {
  assert.equal(canSaveEdit(true, false, 'ลงผิด'), false)
  assert.equal(canSaveEdit(true, true, ''), false)
  assert.equal(canSaveEdit(true, true, '   '), false)
  assert.equal(canSaveEdit(true, true, 'ลงผิดเคส'), true)
})
