// ทดสอบ pjReviewApplyError — รัน: npx tsx --test scripts/pjReviewApplyError.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyPjReviewError,
  PjReviewApplyError,
  shouldReloadAfterPjReviewError,
} from '../src/lib/pjReviewApplyError.ts'

test('NOT_PENDING / RECEIPT_APPLIED / NOT_FOUND = stale', () => {
  for (const t of ['NOT_PENDING', 'RECEIPT_APPLIED', 'NOT_FOUND']) {
    const r = classifyPjReviewError(`[PJR:${t}] อะไรก็ได้`)
    assert.equal(r.kind, 'stale')
    assert.ok(!r.message.includes('PJR'))
  }
})

test('MISMATCH = mismatch (แจ้งทีมตรวจ ไม่ใช่รีเฟรชวน) และไม่โหลดซ้ำ', () => {
  const r = classifyPjReviewError('[PJR:MISMATCH] ยอดที่ส่งมาไม่ตรง')
  assert.equal(r.kind, 'mismatch')
  assert.match(r.message, /แจ้งทีม/)
  assert.ok(!r.message.includes('โหลดรายการใหม่'))
  assert.equal(shouldReloadAfterPjReviewError(new PjReviewApplyError(r)), false)
})

test('MANUAL_ONLY / NO_CONTRACT = manual, FORBIDDEN = forbidden', () => {
  assert.equal(classifyPjReviewError('[PJR:MANUAL_ONLY] x').kind, 'manual')
  assert.equal(classifyPjReviewError('[PJR:NO_CONTRACT] x').kind, 'manual')
  assert.equal(classifyPjReviewError('[PJR:FORBIDDEN] x').kind, 'forbidden')
})

test('ไม่มี tag = other คงข้อความเดิม, ว่าง = ข้อความ default', () => {
  assert.deepEqual(classifyPjReviewError('ไม่มียอดให้บันทึก'), { kind: 'other', message: 'ไม่มียอดให้บันทึก' })
  assert.equal(classifyPjReviewError('').kind, 'other')
  assert.equal(classifyPjReviewError(null).message, 'เกิดข้อผิดพลาด ลองใหม่อีกครั้งค่ะ')
})

test('shouldReload: stale/partial ใช่, manual/other/error ทั่วไปไม่', () => {
  assert.equal(shouldReloadAfterPjReviewError(new PjReviewApplyError({ kind: 'stale', message: 'a' })), true)
  assert.equal(shouldReloadAfterPjReviewError(new PjReviewApplyError({ kind: 'partial', message: 'a' })), true)
  assert.equal(shouldReloadAfterPjReviewError(new PjReviewApplyError({ kind: 'manual', message: 'a' })), false)
  assert.equal(shouldReloadAfterPjReviewError(new Error('x')), false)
  assert.equal(shouldReloadAfterPjReviewError(null), false)
})
