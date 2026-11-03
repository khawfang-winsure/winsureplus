// ทดสอบ dropCancelledPays — รัน: npx tsx --test scripts/cancelledPay.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dropCancelledPays, tsMicros } from '../src/lib/cancelledPay.ts'

const row = (action: string, inst: string | null, created_at: string, id = '') => ({ action, installment_id: inst, created_at, id })

test('pay ที่มี cancel ใหม่กว่าในงวดเดียวกัน → ถูกตัด', () => {
  const out = dropCancelledPays([
    row('pay', 'i1', '2026-10-01T10:00:00+00:00', 'a'),
    row('cancel', 'i1', '2026-10-02T10:00:00+00:00'),
  ])
  assert.equal(out.length, 0)
})

test('Data Fix: cancel กับ pay ใหม่ timestamp เท่ากันเป๊ะ → pay ใหม่ยังนับ, pay เก่าถูกตัด', () => {
  const out = dropCancelledPays([
    row('pay', 'i1', '2026-10-01T10:00:00+00:00', 'old'),
    row('cancel', 'i1', '2026-10-02T10:00:00.123456+00:00'),
    row('pay', 'i1', '2026-10-02T10:00:00.123456+00:00', 'new'),
  ])
  assert.deepEqual(out.map((r) => r.id), ['new'])
})

test('ต่างกันแค่ microsecond (ms เท่ากัน) → ต้องเทียบถูก', () => {
  const cancelLater = dropCancelledPays([
    row('pay', 'i1', '2026-10-02T10:00:00.123456+00:00', 'p'),
    row('cancel', 'i1', '2026-10-02T10:00:00.123457+00:00'),
  ])
  assert.equal(cancelLater.length, 0)
  const cancelEarlier = dropCancelledPays([
    row('pay', 'i1', '2026-10-02T10:00:00.123457+00:00', 'p'),
    row('cancel', 'i1', '2026-10-02T10:00:00.123456+00:00'),
  ])
  assert.equal(cancelEarlier.length, 1)
})

test('เศษวินาทีที่ Postgres ตัด 0 ท้าย (.1 กับ .100000) เท่ากัน', () => {
  assert.equal(tsMicros('2026-10-02T10:00:00.1+00:00'), tsMicros('2026-10-02T10:00:00.100000+00:00'))
  assert.equal(tsMicros('2026-10-02T17:00:00+07:00'), tsMicros('2026-10-02T10:00:00Z'))
})

test('เงินดาวน์ (installment_id null) นับเสมอ; cancel งวดอื่นไม่กระทบ; pay หลัง cancel นับ', () => {
  const out = dropCancelledPays([
    row('pay', null, '2026-10-01T10:00:00+00:00', 'down'),
    row('pay', 'i2', '2026-10-01T10:00:00+00:00', 'other'),
    row('cancel', 'i1', '2026-10-05T10:00:00+00:00'),
    row('pay', 'i1', '2026-10-06T10:00:00+00:00', 'repay'),
  ])
  assert.deepEqual(out.map((r) => r.id).sort(), ['down', 'other', 'repay'])
})

test('timestamp parse ไม่ได้ → ไม่ตัดทิ้ง', () => {
  assert.equal(dropCancelledPays([row('pay', 'i1', 'garbage'), row('cancel', 'i1', '2026-10-05T10:00:00+00:00')]).length, 1)
})
