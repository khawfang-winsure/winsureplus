// ทดสอบแยกแถวก้อน mixed (อื่นๆ + ค่างวด/ค่าปรับ) ของ pj-sync — รัน: npx tsx --test scripts/pjMixedSplit.test.ts
// harness จำลอง "mixed branch" ใน supabase/functions/pj-sync/index.ts (splitMixedGroup -> buildSubsetReview ->
// filterFreshReviewRows -> insert) ด้วย DB ในหน่วยความจำ; สาขา pure-other / pure-installment ไม่ผ่าน splitMixedGroup
// ใน index.ts (ใช้ path เดิม) จึงทดสอบแค่ว่าฟังก์ชันไม่เปลี่ยนความหมายถ้าถูกเรียก
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPendingIndex,
  buildSubsetReview,
  filterFreshReviewRows,
  splitMixedGroup,
  type GroupLike,
  type ReceiptItem,
} from '../supabase/functions/pj-sync/reviewDedup.ts'

const INV = 'S00016PNQ023'
const DATE = '2026-10-22'

const rawRow = (uuid: string, amount: number, type: string) => ({ uuid, amount: String(amount), payment_type: type, invoice_no: INV })
const item = (uuid: string, amount: number, paymentType: ReceiptItem['paymentType']): ReceiptItem => ({ uuid, amount, paymentType })
const TYPE_TH = { installment: 'ค่างวด', penalty: 'ค่าปรับ', other: 'อื่นๆ' } as const

interface Row { id: number; reason: string; status: string; pj_invoice_no: string; pj_paid_date: string; pj_payment_type: string; pj_amount: number; raw_json: any }

class FakeDb {
  reviews: Row[] = []
  applied = new Set<string>()
  ledger: number | null = null
  nextId = 1
  /** จำลอง 1 รอบ sync ของก้อน mixed */
  runMixed(receipts: ReceiptItem[]) {
    const group: GroupLike = {
      invoice_no: INV, paid_date: DATE, receipts,
      raw: receipts.map((r) => rawRow(r.uuid, r.amount, TYPE_TH[r.paymentType])),
    }
    const handled = this.reviews.filter((r) => ['resolved', 'skipped', 'auto_resolved'].includes(r.status))
    const split = splitMixedGroup(group, this.applied, handled, this.ledger)
    const rows: any[] = []
    if (split.other.length > 0) {
      const keep = new Set(split.other.map((r) => r.uuid))
      rows.push({
        pj_invoice_no: INV, pj_payment_type: 'other', pj_amount: split.other.reduce((s, r) => s + r.amount, 0),
        pj_paid_date: DATE, reason: 'OTHER', status: 'pending', raw_json: group.raw.filter((r) => keep.has(r.uuid)),
      })
    }
    if (split.unapplied.length > 0) {
      const sub = buildSubsetReview(group, split.unapplied, 'installment', {}, split.applied)
      rows.push({
        pj_invoice_no: INV, pj_payment_type: sub.pjType, pj_amount: sub.pjAmount, pj_paid_date: DATE,
        reason: 'RECEIPT_PARTIAL_APPLIED', status: 'pending', raw_json: sub.rawJson,
      })
    }
    const pending = this.reviews.filter((r) => r.status === 'pending').map((r) => ({ pj_invoice_no: r.pj_invoice_no, raw_json: r.raw_json }))
    const fr = filterFreshReviewRows(rows, buildPendingIndex(pending))
    for (const r of fr.insert) this.reviews.push({ id: this.nextId++, ...r })
    return fr.insert
  }
}

const five = [1, 2, 3, 4, 5].map((i) => item(`i${i}`, 700, 'installment'))
const run2 = [...five, item('o1', 200, 'other'), item('i6', 700, 'installment')]

function sequence() {
  const db = new FakeDb()
  // run 1: 5 งวดลงแล้ว (auto-apply จริง -> pj_applied_receipts + ledger)
  for (const r of five) db.applied.add(r.uuid)
  db.ledger = 3500
  return db
}

test('S00016PNQ023 run 2: other 200 + งวด 700 -> OTHER มีแค่ 200 + แถวแยกงวด 700 (ไม่รวมงวดที่ลงแล้ว)', () => {
  const db = sequence()
  const ins = db.runMixed(run2)
  assert.equal(ins.length, 2)
  const other = ins.find((r) => r.reason === 'OTHER')!
  assert.equal(other.pj_amount, 200)
  assert.deepEqual(other.raw_json.map((r: any) => r.uuid), ['o1'])
  const inst = ins.find((r) => r.reason === 'RECEIPT_PARTIAL_APPLIED')!
  assert.equal(inst.pj_payment_type, 'installment')
  assert.equal(inst.pj_amount, 700)
  assert.deepEqual(inst.raw_json.unapplied_receipts.map((r: any) => r.uuid), ['i6'])
  assert.deepEqual(inst.raw_json.already_applied_receipts.map((r: any) => r.uuid).sort(), ['i1', 'i2', 'i3', 'i4', 'i5'])
  assert.deepEqual(inst.raw_json.raw.map((r: any) => r.uuid), ['i6'])
})

test('รันซ้ำ (15 นาทีถัดไป) ขณะแถว pending อยู่ -> ไม่สร้างแถวซ้ำ', () => {
  const db = sequence()
  db.runMixed(run2)
  assert.equal(db.runMixed(run2).length, 0)
  assert.equal(db.reviews.length, 2)
})

test('หลังพนักงาน resolve OTHER เป็นรายได้อื่นๆ: งวด 700 ที่ยังค้างไม่ถูกนับว่าจัดการแล้ว / ไม่คิวซ้ำเมื่อแถวงวดยังอยู่', () => {
  const db = sequence()
  db.runMixed(run2)
  db.reviews.find((r) => r.reason === 'OTHER')!.status = 'resolved'
  assert.equal(db.runMixed(run2).length, 0) // แถวงวดยัง pending = ถือว่ามีคนดูแล
  db.reviews.find((r) => r.reason === 'RECEIPT_PARTIAL_APPLIED')!.status = 'skipped'
  assert.equal(db.runMixed(run2).length, 0) // ทั้งสองแถวจัดการแล้ว
})

test('แถว OTHER เก่า (ทุกใบอยู่ใน raw_json) resolved แล้ว: ใบงวดที่ไม่เคยลงถูกคิวใหม่ เฉพาะใบงวด', () => {
  const db = sequence()
  db.reviews.push({
    id: 99, reason: 'OTHER', status: 'resolved', pj_invoice_no: INV, pj_paid_date: DATE, pj_payment_type: 'other', pj_amount: 200,
    raw_json: run2.map((r) => rawRow(r.uuid, r.amount, TYPE_TH[r.paymentType])),
  })
  const ins = db.runMixed(run2)
  assert.equal(ins.length, 1) // other o1 ถูก OTHER เก่าครอบแล้ว
  assert.equal(ins[0].reason, 'RECEIPT_PARTIAL_APPLIED')
  assert.equal(ins[0].pj_amount, 700)
})

test('แถว detector (RECEIPT_UNRECORDED) เคยคิวใบงวดไว้แล้ว (pending/resolved/skipped) -> ไม่คิวซ้ำ', () => {
  for (const status of ['pending', 'resolved', 'skipped']) {
    const db = sequence()
    db.reviews.push({
      id: 98, reason: 'OTHER', status: 'resolved', pj_invoice_no: INV, pj_paid_date: DATE, pj_payment_type: 'other', pj_amount: 200,
      raw_json: run2.map((r) => rawRow(r.uuid, r.amount, TYPE_TH[r.paymentType])),
    })
    db.reviews.push({
      id: 97, reason: 'RECEIPT_UNRECORDED', status, pj_invoice_no: INV, pj_paid_date: DATE, pj_payment_type: 'installment', pj_amount: 700,
      raw_json: [rawRow('i6', 700, 'ค่างวด')],
    })
    assert.equal(db.runMixed(run2).length, 0, status)
  }
})

test('ใบที่ลงแล้ว (pj_applied_receipts) ไม่อยู่ในแถวใดเลย แม้ใบงวดใหม่ + other มาพร้อมกัน', () => {
  const db = sequence()
  const ins = db.runMixed(run2)
  const all = JSON.stringify(ins.map((r) => (r.reason === 'OTHER' ? r.raw_json : r.raw_json.unapplied_receipts)))
  for (const u of ['i1', 'i2', 'i3', 'i4', 'i5']) assert.ok(!all.includes(`"${u}"`))
})

test('ค่าปรับ + other (งวดลงแล้ว) -> แถวแยก pj_payment_type=penalty pj_amount=ยอดค่าปรับ', () => {
  const db = sequence()
  const rs = [...five, item('o1', 200, 'other'), item('p1', 100, 'penalty'), item('p2', 100, 'penalty')]
  const ins = db.runMixed(rs)
  const pen = ins.find((r) => r.reason === 'RECEIPT_PARTIAL_APPLIED')!
  assert.equal(pen.pj_payment_type, 'penalty')
  assert.equal(pen.pj_amount, 200)
})

test('งวด + ค่าปรับ ปนกัน -> installment pj_amount=ต้นเงินล้วน (ค่าปรับอ่านจาก unapplied_receipts ตามสูตร apply_pj_review_payment)', () => {
  const db = sequence()
  const ins = db.runMixed([...five, item('o1', 200, 'other'), item('i6', 700, 'installment'), item('p1', 100, 'penalty')])
  const row = ins.find((r) => r.reason === 'RECEIPT_PARTIAL_APPLIED')!
  assert.equal(row.pj_payment_type, 'installment')
  assert.equal(row.pj_amount, 700)
  assert.equal(row.raw_json.unapplied_totals.penalty, 100)
})

test('ก้อน other ล้วน: ผลเหมือนเดิม (ใบ other ทุกใบ ไม่มีแถวงวด)', () => {
  const db = new FakeDb()
  const ins = db.runMixed([item('o1', 200, 'other'), item('o2', 300, 'other')])
  assert.equal(ins.length, 1)
  assert.equal(ins[0].reason, 'OTHER')
  assert.equal(ins[0].pj_amount, 500)
  assert.equal(ins[0].raw_json.length, 2)
})

test('ก้อนงวดล้วน (ยังไม่ลง): ทุกใบเป็น unapplied ไม่มีแถว OTHER (index.ts ใช้ path งวดเดิมอยู่แล้ว)', () => {
  const g: GroupLike = { invoice_no: INV, paid_date: DATE, receipts: five, raw: five.map((r) => rawRow(r.uuid, r.amount, 'ค่างวด')) }
  const s = splitMixedGroup(g, new Set(), [], null)
  assert.equal(s.other.length, 0)
  assert.equal(s.unapplied.length, 5)
})

test('แถวทึบ (PLAN_CHANGE ไม่มี uuid) ตัดเฉพาะใบ other ใบงวดไม่ถูกกลืน', () => {
  const db = sequence()
  db.reviews.push({
    id: 50, reason: 'PLAN_CHANGE_AUTO', status: 'auto_resolved', pj_invoice_no: INV, pj_paid_date: DATE, pj_payment_type: 'other', pj_amount: 200,
    raw_json: { comparison: [] },
  })
  const ins = db.runMixed(run2)
  assert.equal(ins.length, 1)
  assert.equal(ins[0].pj_amount, 700)
})
