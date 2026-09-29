// ทดสอบ evaluatePrice / parseRateTable — รัน: npx tsx --test scripts/priceRate.test.ts
// (โปรเจกต์ไม่มี test runner ของ src/lib — ใช้ node:test ผ่าน tsx ที่มีอยู่แล้ว · ไฟล์นี้อยู่นอก src เลยไม่ถูก tsc/vite build ตรวจ)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluatePrice, parseRateTable, type PriceCheckInput, type RateTable } from '../src/lib/priceRate.ts'

// เรทจริงย่อ: iPhone 17 Pro 256GB = มือ1 43,900 · มือ2 40,000 · นอก 39,000
const raw = [
  { model: 'iPhone 17 Pro', variants: [{ storage: '256GB', priceFirstHand: 43900, priceSecondHand: 40000, priceImported: 39000 }] },
  { model: 'iPhone Air', variants: [{ storage: '256GB', priceFirstHand: 30000, priceSecondHand: 27000, priceImported: 26000 }] },
  { model: 'iPhone 16', variants: [{ storage: '128GB', priceFirstHand: 25000, priceSecondHand: 0, priceImported: 22000 }] },
  { model: 'iPad Pro', variants: [{ storage: '256GB', priceFirstHand: 40000, priceSecondHand: 35000, priceImported: 34000 }] },
  // เติมให้ครบขั้นต่ำ 20 แถวที่ parseRateTable ต้องการ
  ...Array.from({ length: 20 }, (_, i) => ({
    model: `iPhone Filler ${i}`,
    variants: [{ storage: '64GB', priceFirstHand: 10000, priceSecondHand: 9000, priceImported: 8000 }],
  })),
]
const table = parseRateTable(raw) as RateTable

function input(over: Partial<PriceCheckInput>): PriceCheckInput {
  return { model: 'iPhone 17 Pro', storage: '256GB', condition: 'new', origin: 'th', devicePrice: 43900, ...over }
}

test('parseRateTable: ไม่ใช่ array / แถวน้อยเกิน → null', () => {
  assert.equal(parseRateTable(null), null)
  assert.equal(parseRateTable({}), null)
  assert.equal(parseRateTable(raw.slice(0, 3)), null)
})

test('ไทยมือ1 เกินเรท 1,000 พอดี → ผ่าน / 1,001 → แดง', () => {
  assert.equal(evaluatePrice(input({ devicePrice: 44900 }), table).level, 'ok')
  const r = evaluatePrice(input({ devicePrice: 44901 }), table)
  assert.equal(r.level, 'red')
  assert.match(r.message, /1,001 บาท/)
  assert.match(r.message, /ไทยมือ1/)
})

test('ไทยมือ2: ใช้ช่อง priceSecondHand', () => {
  const r = evaluatePrice(input({ condition: 'used', devicePrice: 40000 }), table)
  assert.equal(r.level, 'ok')
  assert.equal(r.rate, 40000)
})

test('เครื่องนอก เกิน 1 บาท → แดง / เท่าเรท → ผ่าน', () => {
  assert.equal(evaluatePrice(input({ origin: 'inter', devicePrice: 39001 }), table).level, 'red')
  assert.equal(evaluatePrice(input({ origin: 'inter', devicePrice: 39000 }), table).level, 'ok')
})

test('เคสจริง S00032PNQ191: 17 Pro 256GB นอก 40000 → แดง + อาจเลือกประเภทผิด (ตรงเรทไทยมือ2)', () => {
  const r = evaluatePrice(input({ origin: 'inter', condition: 'used', devicePrice: 40000 }), table)
  assert.equal(r.level, 'red')
  assert.match(r.message, /อาจเลือกประเภทเครื่องผิด \(ตรงกับเรทไทยมือ2\)/)
  assert.match(r.message, /40,000/)
  assert.match(r.message, /39,000/)
  assert.match(r.message, /1,000 บาท/)
  assert.match(r.message, /เกินเรทไม่ได้เลย/)
})

test('ไม่พบรุ่น/ความจุ → เหลือง', () => {
  const r = evaluatePrice(input({ model: 'iPhone 15 Plus', storage: '32GB', devicePrice: 15000 }), table)
  assert.equal(r.level, 'yellow')
  assert.match(r.message, /ไม่พบ/)
  assert.equal(evaluatePrice(input({ storage: '9999GB' }), table).level, 'yellow')
})

test('ต่ำกว่า 70% ของเรท → เหลือง (ขอบ 70% พอดีผ่าน)', () => {
  assert.equal(evaluatePrice(input({ devicePrice: 30000 }), table).level, 'yellow') // 43900*0.7=30730
  assert.equal(evaluatePrice(input({ devicePrice: 30730 }), table).level, 'ok')
})

test('เรทช่องนั้นเป็น 0 → info', () => {
  const r = evaluatePrice(input({ model: 'iPhone 16', storage: '128GB', condition: 'used', devicePrice: 20000 }), table)
  assert.equal(r.level, 'info')
  assert.match(r.message, /ยังไม่มีราคาช่องนี้/)
})

test('ดึงเรทไม่ได้ (null) → info · iPad → none แม้ไม่มีเรท', () => {
  const r = evaluatePrice(input({}), null)
  assert.equal(r.level, 'info')
  assert.match(r.message, /เช็กราคากับเว็บเรทไม่ได้ตอนนี้/)
  assert.equal(evaluatePrice(input({ model: 'iPad Pro' }), table).level, 'none')
  assert.equal(evaluatePrice(input({ model: 'iPad Pro' }), null).level, 'none')
})

test('alias iPhone 17 Air → iPhone Air · ไม่สนตัวพิมพ์/ช่องว่างความจุ', () => {
  assert.equal(evaluatePrice(input({ model: 'iPhone 17 Air', storage: '256GB', devicePrice: 30000 }), table).level, 'ok')
  assert.equal(evaluatePrice(input({ model: 'IPHONE 17 pro', storage: '256 gb' }), table).level, 'ok')
})

test('ok: ข้อความบอกเรท', () => {
  assert.equal(evaluatePrice(input({}), table).message, 'ราคาอยู่ในเรท (เรท 43,900)')
})

test('ราคาเครื่องไม่ใช่ตัวเลขจริง (NaN/Infinity) → info ไม่หลุดเป็นเขียว', () => {
  for (const v of [NaN, Infinity, -Infinity]) {
    const r = evaluatePrice(input({ devicePrice: v }), table)
    assert.equal(r.level, 'info')
    assert.equal(r.message, 'ไม่มีราคาเครื่องให้เช็ก')
  }
})
