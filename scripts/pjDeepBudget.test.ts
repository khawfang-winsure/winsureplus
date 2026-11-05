// ทดสอบตัวช่วยลดเวลารอบย้อนหลัง pj-sync (batch / ตัดกลุ่มที่ลงครบแล้ว / เรียงเก่าก่อน) — รัน: npx tsx --test scripts/pjDeepBudget.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chunkArray,
  uniqueNonEmpty,
  isFullyAppliedGroup,
  orderGroupsOldestFirst,
  type FastSkipGroup,
} from '../supabase/functions/pj-sync/reviewDedup.ts'

const CUT = '2026-07-13'
const SYNC = '2026-11-05'
const rc = (uuid: string, amount = 100, paymentType: 'installment' | 'penalty' | 'other' = 'installment') => ({ uuid, amount, paymentType })
const grp = (o: Partial<FastSkipGroup> & { uuids?: string[] }): FastSkipGroup => {
  const receipts = (o.uuids ?? ['u1']).map((u) => rc(u))
  return {
    has_installment: true, has_other: false, paid_date: '2026-11-03',
    receipts, raw: receipts.map(() => ({})), ...o,
  } as FastSkipGroup
}

test('chunkArray: แบ่งก้อนไม่เกินขนาด คงลำดับ ไม่เสียรายการ', () => {
  const xs = Array.from({ length: 1049 }, (_, i) => `u${i}`)
  const parts = chunkArray(xs, 100)
  assert.equal(parts.length, 11)
  assert.ok(parts.every((p) => p.length <= 100))
  assert.deepEqual(parts.flat(), xs)
  assert.deepEqual(chunkArray([], 100), [])
  assert.deepEqual(chunkArray([1, 2, 3], 0), [[1], [2], [3]])
})

test('uniqueNonEmpty: ตัดซ้ำ/ว่าง/null', () => {
  assert.deepEqual(uniqueNonEmpty(['a', ' a ', '', null, undefined, 'b']), ['a', 'b'])
})

test('ค่างวดล้วน: ลงครบ + สัญญาเดียว -> ข้ามได้', () => {
  assert.equal(isFullyAppliedGroup(grp({}), SYNC, CUT, new Set(['u1']), ['active']), true)
})

test('ค่างวดล้วน: สัญญา closed แต่ลงครบแล้ว -> ข้าม (alreadyApplied มาก่อน closed ตามเดิม)', () => {
  assert.equal(isFullyAppliedGroup(grp({}), SYNC, CUT, new Set(['u1']), ['closed']), true)
})

test('ค่างวดล้วน: หาสัญญาไม่เจอ/เจอซ้ำ -> ห้ามข้าม (ต้องเข้า UNMATCHED/AMOUNT_MISMATCH)', () => {
  assert.equal(isFullyAppliedGroup(grp({}), SYNC, CUT, new Set(['u1']), []), false)
  assert.equal(isFullyAppliedGroup(grp({}), SYNC, CUT, new Set(['u1']), ['active', 'active']), false)
})

test('ยังไม่โหลด/โหลดพลาด (contractStatuses undefined) -> ห้ามข้าม', () => {
  assert.equal(isFullyAppliedGroup(grp({}), SYNC, CUT, new Set(['u1']), undefined), false)
})

test('มีใบใหม่ปน (ลงบางใบ) -> ห้ามข้าม', () => {
  const g = grp({ uuids: ['u1', 'u2'] })
  assert.equal(isFullyAppliedGroup(g, SYNC, CUT, new Set(['u1']), ['active']), false)
})

test('uuid ซ้ำในก้อน ลงครบ -> ข้าม; ไม่มี uuid เลย -> ห้ามข้าม', () => {
  assert.equal(isFullyAppliedGroup(grp({ uuids: ['u1', 'u1'] }), SYNC, CUT, new Set(['u1']), ['active']), true)
  assert.equal(isFullyAppliedGroup(grp({ uuids: [] }), SYNC, CUT, new Set(), ['active']), false)
})

test('ก่อน DEDUP_CUTOFF -> ห้ามข้าม (ใช้ legacy path); paid_date ว่างใช้วัน sync', () => {
  assert.equal(isFullyAppliedGroup(grp({ paid_date: '2026-07-01' }), SYNC, CUT, new Set(['u1']), ['active']), false)
  assert.equal(isFullyAppliedGroup(grp({ paid_date: null }), SYNC, CUT, new Set(['u1']), ['active']), true)
  assert.equal(isFullyAppliedGroup(grp({ paid_date: null }), null, CUT, new Set(['u1']), ['active']), false)
})

test('mixed (ค่างวด+อื่นๆ) -> ห้ามข้ามเสมอ', () => {
  assert.equal(isFullyAppliedGroup(grp({ has_other: true }), SYNC, CUT, new Set(['u1']), ['active']), false)
})

test('ไม่มีค่างวด: ลงครบ+ไม่มีสัญญา closed -> ข้าม; closed -> ห้ามข้าม (gate CONTRACT_CLOSED มาก่อน)', () => {
  const g = grp({ has_installment: false })
  assert.equal(isFullyAppliedGroup(g, SYNC, CUT, new Set(['u1']), ['active']), true)
  assert.equal(isFullyAppliedGroup(g, SYNC, CUT, new Set(['u1']), []), true)
  assert.equal(isFullyAppliedGroup(g, SYNC, CUT, new Set(['u1']), ['active', 'closed']), false)
  assert.equal(isFullyAppliedGroup(grp({ has_installment: false, paid_date: null }), SYNC, CUT, new Set(['u1']), ['active']), false)
  assert.equal(isFullyAppliedGroup(grp({ has_installment: false, raw: [] }), SYNC, CUT, new Set(['u1']), ['active']), false)
})

test('orderGroupsOldestFirst: เก่าก่อน, null ท้าย, stable ในวันเดียวกัน, ไม่แก้ array เดิม', () => {
  const xs = [
    { id: 'a', paid_date: '2026-11-03' },
    { id: 'b', paid_date: null },
    { id: 'c', paid_date: '2026-10-30' },
    { id: 'd', paid_date: '2026-11-03' },
  ]
  const out = orderGroupsOldestFirst(xs)
  assert.deepEqual(out.map((x) => x.id), ['c', 'a', 'd', 'b'])
  assert.deepEqual(xs.map((x) => x.id), ['a', 'b', 'c', 'd'])
})
