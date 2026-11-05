// ทดสอบกติกากล่องรอตรวจ PJ (ใบเสร็จใหม่ต้องไม่ถูกกลืน) — รัน: npx tsx --test scripts/pjReviewDedup.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  allUuidsOfRawJson,
  buildPendingIndex,
  buildSubsetReview,
  filterFreshReviewRows,
  applyOpaqueHandled,
  hasOpaqueHandledRow,
  unhandledAfterLedger,
  removeLedgerCovered,
  pendingUuidsOfRawJson,
  unhandledReceiptsForGroup,
  type GroupLike,
  type ReceiptItem,
} from '../supabase/functions/pj-sync/reviewDedup.ts'

const INV = 'INV-1778387641'
const raw = (uuid: string, amount: number, type = 'ค่าปรับ') => ({ uuid, amount: String(amount), payment_type: type, invoice_no: INV })
const item = (uuid: string, amount: number, paymentType: ReceiptItem['paymentType'] = 'penalty'): ReceiptItem => ({ uuid, amount, paymentType })

// แถวที่ queueReview จะ insert (ก้อนค่าปรับล้วน)
function penaltyRow(raws: any[], type = 'penalty') {
  const amt = raws.reduce((s, r) => s + Number(r.amount), 0)
  return { pj_invoice_no: INV, pj_payment_type: type, pj_amount: amt, pj_paid_date: '2026-11-03', reason: 'AMOUNT_MISMATCH', status: 'pending', raw_json: raws }
}

const pending300 = [{ pj_invoice_no: INV, raw_json: [raw('r0', 300)] }]

test('S00016PNQ266: pending 300 ค้างอยู่ ใบใหม่ 100+100 วันอื่น -> ได้แถวใหม่ 200 (ไม่ใช่ถูกทิ้ง)', () => {
  const r = filterFreshReviewRows([penaltyRow([raw('n1', 100), raw('n2', 100)])], buildPendingIndex(pending300))
  assert.equal(r.insert.length, 1)
  assert.equal(r.insert[0].pj_amount, 200)
  assert.equal(r.droppedDuplicate, 0)
})

test('ก้อนเดียวกันมีใบค้างปนกับใบใหม่ (300 เดิม + 100 + 100) -> แถวใหม่ 200 เฉพาะใบใหม่ ไม่รวม 300', () => {
  const row = penaltyRow([raw('r0', 300), raw('n1', 100), raw('n2', 100)])
  const r = filterFreshReviewRows([row], buildPendingIndex(pending300))
  assert.equal(r.insert.length, 1)
  assert.equal(r.split, 1)
  const out = r.insert[0]
  assert.equal(out.pj_amount, 200)
  assert.equal(out.pj_payment_type, 'penalty')
  assert.deepEqual(out.raw_json.unapplied_receipts.map((x: ReceiptItem) => x.uuid), ['n1', 'n2'])
  assert.deepEqual(out.raw_json.held_in_pending_uuids, ['r0'])
  assert.ok(!allUuidsOfRawJson(out.raw_json.unapplied_receipts).includes('r0'))
  // หน้าเว็บอ่านเฉพาะ unapplied_receipts -> ใบ r0 ไม่ถูกส่งซ้ำ
  assert.deepEqual(pendingUuidsOfRawJson(out.raw_json), ['n1', 'n2'])
  assert.equal(out.raw_json.raw.length, 2)
})

test('รอบซ้ำ (96 รอบ/วัน): หลังแถวใหม่ถูก insert แล้ว รอบถัดไปไม่สร้างแถวเพิ่ม', () => {
  const row = penaltyRow([raw('r0', 300), raw('n1', 100), raw('n2', 100)])
  const first = filterFreshReviewRows([row], buildPendingIndex(pending300))
  const pendingNow = [...pending300, ...first.insert.map((r) => ({ pj_invoice_no: r.pj_invoice_no, raw_json: r.raw_json }))]
  const second = filterFreshReviewRows([penaltyRow([raw('r0', 300), raw('n1', 100), raw('n2', 100)])], buildPendingIndex(pendingNow))
  assert.equal(second.insert.length, 0)
  assert.equal(second.droppedDuplicate, 1)
  // และแถวเดิมล้วนๆ ก็ไม่เด้ง
  const third = filterFreshReviewRows([penaltyRow([raw('r0', 300)])], buildPendingIndex(pending300))
  assert.equal(third.insert.length, 0)
})

test('ใบใหม่เพิ่มอีกใบ (n3) ตอนมีแถวแยกอยู่แล้ว -> ได้เฉพาะ n3', () => {
  const split = filterFreshReviewRows([penaltyRow([raw('r0', 300), raw('n1', 100)])], buildPendingIndex(pending300)).insert[0]
  const pendingNow = [...pending300, { pj_invoice_no: INV, raw_json: split.raw_json }]
  const r = filterFreshReviewRows([penaltyRow([raw('r0', 300), raw('n1', 100), raw('n3', 50)])], buildPendingIndex(pendingNow))
  assert.equal(r.insert.length, 1)
  assert.equal(r.insert[0].pj_amount, 50)
  assert.deepEqual(r.insert[0].raw_json.unapplied_receipts.map((x: ReceiptItem) => x.uuid), ['n3'])
})

test('invoice ไม่มี pending -> insert ทั้งแถวตามเดิม', () => {
  const row = penaltyRow([raw('n1', 100)])
  const r = filterFreshReviewRows([row], buildPendingIndex([]))
  assert.deepEqual(r.insert, [row])
})

test('แถวไม่มี uuid (ก่อน DEDUP_CUTOFF) และ pending ที่อ่าน uuid ไม่ได้ -> ทิ้งทั้ง invoice เหมือนเดิม', () => {
  const noUuid = penaltyRow([{ amount: '100', payment_type: 'ค่าปรับ' }])
  assert.equal(filterFreshReviewRows([noUuid], buildPendingIndex(pending300)).insert.length, 0)
  const mixedMissing = penaltyRow([raw('n1', 100), { amount: '50', payment_type: 'ค่าปรับ' }])
  assert.equal(filterFreshReviewRows([mixedMissing], buildPendingIndex(pending300)).insert.length, 0)
  const opaquePending = [{ pj_invoice_no: INV, raw_json: [{ amount: '300' }] }]
  assert.equal(filterFreshReviewRows([penaltyRow([raw('n1', 100)])], buildPendingIndex(opaquePending)).insert.length, 0)
  const objPending = [{ pj_invoice_no: INV, raw_json: { kind: 'returned_watch', receiptUuids: [] } }]
  assert.equal(filterFreshReviewRows([penaltyRow([raw('n1', 100)])], buildPendingIndex(objPending)).insert.length, 0)
})

test('shape ทั้งสอง: array ดิบ และ {raw, unapplied_receipts, already_applied_receipts}', () => {
  assert.deepEqual(pendingUuidsOfRawJson([raw('a', 1), raw('b', 2)]), ['a', 'b'])
  const shape2 = { raw: [raw('x', 1), raw('y', 2)], already_applied_receipts: [item('x', 1)], unapplied_receipts: [item('y', 2)] }
  assert.deepEqual(pendingUuidsOfRawJson(shape2), ['y']) // ใบที่ลงแล้วไม่ใช่ "ค้างรอตัดสินใจ"
  assert.deepEqual(allUuidsOfRawJson(shape2).sort(), ['x', 'y'])
  assert.equal(pendingUuidsOfRawJson({ kind: 'x' }), null)
  assert.equal(pendingUuidsOfRawJson(null), null)
  // pending เป็น shape2 ก็กันใบใหม่ได้
  const idx = buildPendingIndex([{ pj_invoice_no: INV, raw_json: shape2 }])
  const r = filterFreshReviewRows([penaltyRow([raw('y', 2), raw('z', 7)])], idx)
  assert.equal(r.insert[0].pj_amount, 7)
})

test('แถวขาเข้าเป็น shape2 (RECEIPT_PARTIAL_APPLIED) ถูกตัดเหลือเฉพาะใบใหม่ และคง already_applied', () => {
  const incoming = {
    pj_invoice_no: INV, pj_payment_type: 'installment', pj_amount: 1000, pj_paid_date: '2026-11-03', reason: 'RECEIPT_PARTIAL_APPLIED',
    raw_json: {
      invoice_no: INV, paid_date: '2026-11-03', already_applied_receipts: [item('ap', 500, 'installment')],
      unapplied_receipts: [item('p1', 1000, 'installment'), item('p2', 100)], raw: [raw('ap', 500, 'ค่างวด'), raw('p1', 1000, 'ค่างวด'), raw('p2', 100)],
    },
  }
  const idx = buildPendingIndex([{ pj_invoice_no: INV, raw_json: [raw('p1', 1000, 'ค่างวด')] }])
  const r = filterFreshReviewRows([incoming], idx)
  assert.equal(r.insert.length, 1)
  const o = r.insert[0]
  assert.equal(o.pj_payment_type, 'penalty') // เหลือแต่ค่าปรับ 100 -> เปลี่ยนประเภทตามยอด
  assert.equal(o.pj_amount, 100)
  assert.equal(o.raw_json.already_applied_receipts.length, 1)
})

// ── ข้อ ข: ก้อนไม่มีค่างวด ───────────────────────────────────────────────────────────────
const group = (receipts: ReceiptItem[], rawRows = receipts.map((r) => raw(r.uuid, r.amount)), paid = '2026-11-03'): GroupLike =>
  ({ invoice_no: INV, paid_date: paid, receipts, raw: rawRows })
const CUT = '2026-07-13'

test('ค่าปรับล้วน: ใบเดิม resolve แล้ว + ใบใหม่วันเดียวกัน เหลือเฉพาะใบใหม่', () => {
  const g = group([item('old', 100), item('new', 100)])
  const out = unhandledReceiptsForGroup(g, CUT, new Set(), new Set(['old']))
  assert.deepEqual(out?.map((r) => r.uuid), ['new'])
  const sub = buildSubsetReview(g, out!, 'penalty')
  assert.equal(sub.pjAmount, 100)
  assert.equal(sub.pjType, 'penalty')
})

test('ใบเดิมไม่เด้งหลัง resolve/skip หรือลง pj_applied_receipts แล้ว', () => {
  const g = group([item('old', 100)])
  assert.deepEqual(unhandledReceiptsForGroup(g, CUT, new Set(), new Set(['old'])), [])
  assert.deepEqual(unhandledReceiptsForGroup(g, CUT, new Set(['old']), new Set()), [])
  const g2 = group([item('a', 100), item('b', 200)])
  assert.deepEqual(unhandledReceiptsForGroup(g2, CUT, new Set(['a']), new Set(['b'])), [])
})

test('ใบใหม่ล้วน คืนทุกใบ (ใช้เส้นทางคิวปกติ)', () => {
  const g = group([item('n', 100)])
  assert.equal(unhandledReceiptsForGroup(g, CUT, new Set(), new Set())?.length, 1)
})

test('ก่อน cutoff / ไม่มี uuid / uuid ไม่ครบ คืน null (พฤติกรรมเดิม)', () => {
  assert.equal(unhandledReceiptsForGroup(group([item('a', 1)], undefined, '2026-07-01'), CUT, new Set(), new Set()), null)
  assert.equal(unhandledReceiptsForGroup(group([item('a', 1)], undefined, null as unknown as string), CUT, new Set(), new Set()), null)
  assert.equal(unhandledReceiptsForGroup(group([], [{ amount: '100' }]), CUT, new Set(), new Set()), null)
  assert.equal(unhandledReceiptsForGroup(group([item('a', 1)], [raw('a', 1), { amount: '5' }]), CUT, new Set(), new Set()), null)
})

test('buildSubsetReview: other ล้วนได้ type other, ปน installment ได้ installment', () => {
  const g = group([item('o', 80, 'other')])
  assert.equal(buildSubsetReview(g, [item('o', 80, 'other')], 'other').pjType, 'other')
  assert.equal(buildSubsetReview(g, [item('o', 80, 'other'), item('i', 900, 'installment')], null).pjType, 'installment')
})

test('CONTRACT_CLOSED cache: แถว A,B (array) + แถวแยก C (object) ที่ resolve แล้ว -> ก้อน A,B,C จัดการแล้วทั้งหมด', () => {
  const handled = new Set<string>()
  const rows = [
    [raw('A', 100), raw('B', 100)],
    { invoice_no: INV, paid_date: '2026-11-03', already_applied_receipts: [], unapplied_receipts: [item('C', 100)], raw: [raw('C', 100)], held_in_pending_uuids: ['A', 'B'] },
  ]
  for (const r of rows) for (const u of allUuidsOfRawJson(r)) handled.add(u)
  const g = group([item('A', 100), item('B', 100), item('C', 100)])
  assert.deepEqual(unhandledReceiptsForGroup(g, CUT, new Set(), handled), [])
})

test('แถวจัดการแล้วที่อ่าน uuid ไม่ได้ (PLAN_CHANGE) วัน/invoice เดียวกัน นับว่าจัดการแล้ว; คนละวันไม่นับ', () => {
  const rows = [{ pj_paid_date: '2026-11-03', raw_json: { kind: 'plan_change', comparison: [] } }]
  assert.equal(hasOpaqueHandledRow(rows, '2026-11-03'), true)
  assert.equal(hasOpaqueHandledRow(rows, '2026-11-04'), false)
  assert.equal(hasOpaqueHandledRow([{ pj_paid_date: '2026-11-03', raw_json: [raw('x', 1)] }], '2026-11-03'), false)
})

test('STAFF_MANUAL_OVERLAP ทับ pending -> ไม่แยกแถว ทิ้งแบบเดิม', () => {
  const row = { ...penaltyRow([raw('r0', 300), raw('n1', 100)]), reason: 'STAFF_MANUAL_OVERLAP' }
  const r = filterFreshReviewRows([row], buildPendingIndex(pending300))
  assert.equal(r.insert.length, 0)
  assert.equal(r.split, 0)
  // ไม่มี pending -> insert ปกติ
  assert.equal(filterFreshReviewRows([row], buildPendingIndex([])).insert.length, 1)
})

test('ledger: ครอบทั้งก้อน -> ข้าม; ใบใหม่เกินยอด ledger -> เหลือใบใหม่ (จับคู่ยอดพอดี); จับคู่ไม่ได้ -> ไม่กลืน', () => {
  assert.deepEqual(removeLedgerCovered([item('a', 100)], 100), [])
  assert.deepEqual(removeLedgerCovered([item('a', 100), item('b', 100, 'installment')], 300), [])
  assert.deepEqual(removeLedgerCovered([item('a', 300), item('n', 100)], 300).map((r) => r.uuid), ['n'])
  assert.deepEqual(removeLedgerCovered([item('a', 300), item('n', 100)], 250).map((r) => r.uuid), ['a', 'n'])
  assert.deepEqual(removeLedgerCovered([item('o', 80, 'other')], 500).map((r) => r.uuid), ['o'])
  assert.equal(removeLedgerCovered([item('a', 100)], 0).length, 1)
})

test('ledger 700 + ใบเก่า 700 มี uuid (จัดการแล้ว) + ใบใหม่ 100 -> คิว 100 ไม่ถูกกลืน', () => {
  const rs = [item('old', 700), item('new', 100)]
  const out = unhandledAfterLedger(rs, new Set(['old']), new Set(), 700)
  assert.deepEqual(out.map((r) => r.uuid), ['new'])
  const out2 = unhandledAfterLedger(rs, new Set(), new Set(['old']), 700)
  assert.deepEqual(out2.map((r) => r.uuid), ['new'])
})

test('INV เปลี่ยนเลข: uuid ใหม่หมด ยอดเท่า ledger -> ข้าม', () => {
  assert.deepEqual(unhandledAfterLedger([item('u1', 400), item('u2', 300)], new Set(), new Set(), 700), [])
})

test('ledger 700 ไม่มี uuid + ใบรวม 700 + ใบใหม่ 100 -> คิว 100', () => {
  const out = unhandledAfterLedger([item('x', 700), item('new', 100)], new Set(), new Set(), 700)
  assert.deepEqual(out.map((r) => r.uuid), ['new'])
})

test('แถว opaque ที่จัดการแล้ว: ก้อน other ล้วนข้ามหมด; ก้อนมีค่าปรับ ใบค่าปรับใหม่ยังอยู่', () => {
  const rows = [{ pj_paid_date: '2026-11-03', raw_json: { kind: 'plan_change' } }]
  assert.deepEqual(applyOpaqueHandled([item('o', 80, 'other')], rows, '2026-11-03'), [])
  assert.deepEqual(applyOpaqueHandled([item('o', 80, 'other'), item('p', 100)], rows, '2026-11-03').map((r) => r.uuid), ['p'])
  assert.equal(applyOpaqueHandled([item('p', 100)], [], '2026-11-03').length, 1)
})
