// ทดสอบ penaltySpread — รัน: npx tsx --test scripts/penaltySpread.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allocatePenaltySpread, computePenaltyAlignTargets, type PenaltySpreadInstallment } from '../src/lib/penaltySpread.ts'
import { penaltyPaidForInstallment } from '../src/lib/calc.ts'

const inst = (o: Partial<PenaltySpreadInstallment> & { id: string; installmentNo: number }): PenaltySpreadInstallment => ({
  dueDate: '2026-10-01', paidAt: null, penaltyAmount: 0, penaltyPaid: 0, ...o,
})
const amounts = (r: ReturnType<typeof allocatePenaltySpread>) => Object.fromEntries(r.allocations.map(a => [a.id, a.amount]))

test('จัดสรร: A ค้าง 300 (เลย 63 วัน), B ตั้ง 0 -> งวดเก่า A รับเต็มเพดานก่อน (700) B ไม่ได้', () => {
  const r = allocatePenaltySpread({
    installments: [
      inst({ id: 'A', installmentNo: 1, dueDate: '2026-09-01', penaltyAmount: 300 }),
      inst({ id: 'B', installmentNo: 2, dueDate: '2026-10-01', penaltyAmount: 0 }),
    ],
    penalty: 700, paidDate: '2026-11-03', perDay: 100, maxDays: 7,
  })
  assert.deepEqual(amounts(r), { A: 700 })
  assert.equal(r.noTarget, false)
})

test('จัดสรรสองงวด: A ค้าง 300 เลย 3 วัน, B ตั้ง 0 เลย 3 วัน, PJ 600 -> A 300, B 300', () => {
  const r = allocatePenaltySpread({
    installments: [
      inst({ id: 'A', installmentNo: 1, dueDate: '2026-10-31', penaltyAmount: 300 }),
      inst({ id: 'B', installmentNo: 2, dueDate: '2026-10-31', penaltyAmount: 0 }),
    ],
    penalty: 600, paidDate: '2026-11-03', perDay: 100, maxDays: 7,
  })
  assert.deepEqual(amounts(r), { A: 300, B: 300 })
})

test('ขั้น 2: งวดเลยกำหนด 3 วัน รับได้ไม่เกิน 300 ส่วนเกินไปขั้น 3 ยอดรวมครบ', () => {
  const r = allocatePenaltySpread({
    installments: [
      inst({ id: 'A', installmentNo: 1, dueDate: '2026-09-01', penaltyAmount: 300 }),
      inst({ id: 'B', installmentNo: 2, dueDate: '2026-10-31', penaltyAmount: 0 }),
    ],
    penalty: 1000, paidDate: '2026-11-03', perDay: 100, maxDays: 7,
  })
  // A: ขั้น1 300 + ขั้น2 อีก 400 (cap 700); B: เลย 3 วัน cap 300
  assert.deepEqual(amounts(r), { A: 700, B: 300 })
  assert.equal(r.allocations.reduce((s, a) => s + a.amount, 0), 1000)
})

test('งวดเลยกำหนด 3 วันอย่างเดียว: ขั้น 2 รับ 300 ที่เหลือไปขั้น 3 (ยอดรวมครบ)', () => {
  const r = allocatePenaltySpread({
    installments: [inst({ id: 'B', installmentNo: 2, dueDate: '2026-10-31', penaltyAmount: 0 })],
    penalty: 700, paidDate: '2026-11-03', perDay: 100, maxDays: 7,
  })
  assert.deepEqual(amounts(r), { B: 700 })
})

test('งวดเลยกำหนด 3 วัน + งวดเก่าเต็มเพดาน: B รับขั้น 2 ได้ไม่เกิน 300 ส่วนเกินไปงวดเป้าหมาย (A)', () => {
  const r = allocatePenaltySpread({
    installments: [
      inst({ id: 'A', installmentNo: 1, dueDate: '2026-09-01', penaltyAmount: 700, penaltyPaid: 700 }),
      inst({ id: 'B', installmentNo: 2, dueDate: '2026-10-31', penaltyAmount: 0 }),
      inst({ id: 'C', installmentNo: 3, dueDate: '2026-11-30', penaltyAmount: 0 }),
    ],
    penalty: 500, paidDate: '2026-11-03', perDay: 100, maxDays: 7,
  })
  // A ไม่ค้างและขั้น 2 ข้าม (cur=700>=cap); B รับ 300; เหลือ 200 -> ขั้น 3: target=งวด unpaid แรก = A
  assert.deepEqual(amounts(r), { A: 200, B: 300 })
})

test('งวดเดียว: ยอดรวม = PJ', () => {
  const r = allocatePenaltySpread({
    installments: [inst({ id: 'A', installmentNo: 1, dueDate: '2026-10-01', penaltyAmount: 700 })],
    penalty: 700, paidDate: '2026-11-03', perDay: 100, maxDays: 7,
  })
  assert.deepEqual(amounts(r), { A: 700 })
})

test('จ่ายบางส่วนมาก่อน: A ตั้ง 700 จ่ายแล้ว 400 -> ค้าง 300 ที่เหลือไป B', () => {
  const r = allocatePenaltySpread({
    installments: [
      inst({ id: 'A', installmentNo: 1, dueDate: '2026-09-01', penaltyAmount: 700, penaltyPaid: 400 }),
      inst({ id: 'B', installmentNo: 2, dueDate: '2026-10-01', penaltyAmount: 0 }),
    ],
    penalty: 500, paidDate: '2026-11-03', perDay: 100, maxDays: 7,
  })
  assert.deepEqual(amounts(r), { A: 300, B: 200 })
})

test('ไม่มีงวดให้ลงเลย -> noTarget', () => {
  const r = allocatePenaltySpread({
    installments: [inst({ id: 'A', installmentNo: 1, paidAt: '2026-10-02', penaltyAmount: 100, penaltyPaid: 100 })],
    penalty: 200, paidDate: '2026-11-03', perDay: 100, maxDays: 7,
  })
  assert.equal(r.noTarget, true)
  assert.equal(r.unallocated, 200)
  assert.deepEqual(r.allocations, [])
})

// ---- align ----
const ev = (action: 'pay' | 'cancel', n: number, t: string) => ({ action, penaltyPaidAmount: n, createdAt: t })

test('align ตัวอย่าง A/B (RPC ใหม่): A 300, B 400 ไม่ใช่ 700 ทั้งก้อน', () => {
  const before = new Map([['A', 0], ['B', 0]])
  const after = new Map([['A', 300], ['B', 400]])
  assert.deepEqual(computePenaltyAlignTargets(before, after), [
    { installmentId: 'A', amount: 300 },
    { installmentId: 'B', amount: 400 },
  ])
})

test('align งวดเดียว: ยอดรวม = PJ (พฤติกรรมเดิม) และ RPC เก่าลงงวดเดียวก็ได้ผลเดียวกัน', () => {
  assert.deepEqual(computePenaltyAlignTargets(new Map(), new Map([['A', 700]])), [{ installmentId: 'A', amount: 700 }])
  assert.deepEqual(
    computePenaltyAlignTargets(new Map([['A', 0], ['B', 0]]), new Map([['A', 700], ['B', 0]])),
    [{ installmentId: 'A', amount: 700 }],
  )
})

test('align งวดที่จ่ายบางส่วนก่อนหน้า: ตั้งเป็นยอดจ่ายรวมหลังลง (400+300=700)', () => {
  assert.deepEqual(
    computePenaltyAlignTargets(new Map([['A', 400]]), new Map([['A', 700]])),
    [{ installmentId: 'A', amount: 700 }],
  )
})

test('align cancel-aware: pay 100 -> cancel -> ลง 50 ใหม่ (ก่อน=0 เพราะ cancel)', () => {
  const beforeEvents = [ev('pay', 100, '2026-07-01T00:00:00Z'), ev('cancel', 0, '2026-07-02T00:00:00Z')]
  const afterEvents = [...beforeEvents, ev('pay', 50, '2026-07-03T00:00:00Z')]
  const before = new Map([['A', penaltyPaidForInstallment(beforeEvents)]])
  const after = new Map([['A', penaltyPaidForInstallment(afterEvents)]])
  assert.equal(before.get('A'), 0)
  assert.deepEqual(computePenaltyAlignTargets(before, after), [{ installmentId: 'A', amount: 50 }])
})

test('align ไม่มีงวดเปลี่ยน -> [] (ไม่เรียกอะไร)', () => {
  assert.deepEqual(computePenaltyAlignTargets(new Map([['A', 300]]), new Map([['A', 300], ['B', 0]])), [])
  assert.deepEqual(computePenaltyAlignTargets(new Map(), new Map()), [])
})
