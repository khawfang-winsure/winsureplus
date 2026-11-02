// ทดสอบ media.ts ส่วนคลิปรอบตัวเครื่อง — รัน: npx tsx --test scripts/media.test.ts
// (ล้อ scripts/priceRate.test.ts · ไม่แตะ DB/เมลจริง)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  AROUND_VIDEO_SLOT_KEY,
  DEFAULT_MEDIA_SLOTS,
  EMAIL_MAX_TOTAL_BYTES,
  VIDEO_SLOT_KEYS,
  VIDEO_TOTAL_MAX_BYTES,
  buildMediaFlags,
  checkVideoBudget,
  checkVideoFile,
  evaluateSlots,
  isVideoRequired,
  isVideoSlotVisible,
  mediaFilename,
  videoBudgetHint,
  videoSlotRequiredFrom,
  type MediaFile,
  type MediaFlagsSettings,
} from '../src/lib/media.ts'

const MB = 1024 * 1024
const LOCK = 'lock_test_video'
const AROUND = AROUND_VIDEO_SLOT_KEY

const settings = (v: string | null, a: string | null): MediaFlagsSettings => ({
  videoRequiredFrom: v,
  aroundVideoRequiredFrom: a,
})
const c = (createdAt: string | undefined, emailSentAt: string | null = null) => ({
  creditHistoryFound: false,
  createdAt,
  emailSentAt,
})

// ---------- ช่อง + slug ----------
test('slot device_around_video ตรงแผน', () => {
  assert.equal(AROUND, 'device_around_video')
  const s = DEFAULT_MEDIA_SLOTS.find((x) => x.key === AROUND)
  assert.ok(s)
  assert.equal(s.label, 'คลิปรอบตัวเครื่อง')
  assert.equal(s.sortOrder, 15.1)
  assert.equal(s.min, 1)
  assert.equal(s.max, 1)
  assert.equal(s.kind, 'video')
  assert.deepEqual(s.required, { when: 'flag', name: 'around_video_required' })
  assert.equal(DEFAULT_MEDIA_SLOTS.length, 18)
  assert.deepEqual([...VIDEO_SLOT_KEYS], [LOCK, AROUND])
})

test('slug ไฟล์', () => {
  assert.equal(mediaFilename(AROUND, 1, 'mp4'), '15-1-device-around-video-1.mp4')
  assert.equal(mediaFilename(LOCK, 1, 'mp4'), '15-lock-test-video-1.mp4')
})

// ---------- flags ----------
test('flag around_video_required: ก่อน/ตรงวัน/หลังวันเริ่ม (UTC)', () => {
  const st = settings(null, '2026-12-01')
  assert.equal(buildMediaFlags(c('2026-11-30T23:59:59Z'), st).around_video_required, false)
  assert.equal(buildMediaFlags(c('2026-12-01T00:00:00Z'), st).around_video_required, true)
  assert.equal(buildMediaFlags(c('2026-12-02'), st).around_video_required, true)
})

test('flag: ส่งเมลแล้ว / วันที่ผิด / 2099 / ไม่มี createdAt -> false', () => {
  assert.equal(buildMediaFlags(c('2026-12-02', '2026-12-03T00:00:00Z'), settings(null, '2026-12-01')).around_video_required, false)
  for (const bad of ['', 'x', null, undefined]) {
    assert.equal(buildMediaFlags(c('2026-12-02'), settings(null, bad as string | null)).around_video_required, false)
  }
  assert.equal(buildMediaFlags(c('2026-12-02'), settings(null, '2099-12-31')).around_video_required, false)
  assert.equal(buildMediaFlags(c(undefined), settings(null, '2026-12-01')).around_video_required, false)
})

test('flag ทั้งสองอิสระกัน + พฤติกรรม video_required/credit_history_found เดิมไม่เปลี่ยน', () => {
  const f = buildMediaFlags({ ...c('2026-09-11'), creditHistoryFound: true }, settings('2026-09-10', '2099-12-31'))
  assert.deepEqual(f, { credit_history_found: true, video_required: true, around_video_required: false })
  const g = buildMediaFlags(c('2026-12-05'), settings('2099-12-31', '2026-12-01'))
  assert.equal(g.video_required, false)
  assert.equal(g.around_video_required, true)
  // isVideoRequired / isVideoSlotVisible ยังตามเดิม
  assert.equal(isVideoRequired({ createdAt: '2026-09-09T17:30:00Z', emailSentAt: null }, '2026-09-10'), false)
  assert.equal(isVideoSlotVisible({ createdAt: '2026-09-19' }, '2026-09-10'), true)
})

test('evaluateSlots: flag หาย = ไม่บังคับ ; flag true + ว่าง = missing ; ลบแล้วแนบใหม่ได้ ; purged ยังนับ', () => {
  const ctx = { condition: 'used', origin: 'th' } as const
  const slot = DEFAULT_MEDIA_SLOTS.filter((s) => s.key === AROUND)
  const file = (over: Partial<MediaFile>): MediaFile => ({
    id: 'a', slotKey: AROUND, sha256: 'h', width: 0, height: 0, bytes: 1, uploadedAt: '2026-12-02', ...over,
  })
  const req = { around_video_required: true }
  assert.equal(evaluateSlots(slot, ctx, {}, []).slots[0].status, 'optional_empty')
  assert.equal(evaluateSlots(slot, ctx, req, []).slots[0].status, 'missing')
  assert.equal(evaluateSlots(slot, ctx, req, [file({ deletedAt: '2026-12-03' })]).slots[0].status, 'missing')
  assert.equal(evaluateSlots(slot, ctx, req, [file({ deletedAt: '2026-12-03' }), file({ id: 'b', sha256: 'h2' })]).slots[0].status, 'ok')
  assert.equal(evaluateSlots(slot, ctx, req, [file({ purgedAt: '2026-12-30' })]).slots[0].status, 'ok')
})

// ---------- visibility ต่อช่อง ----------
test('videoSlotRequiredFrom แยกวันที่ต่อช่อง ; เคสเก่าโชว์ช่องเทสล็อกแต่ไม่โชว์ช่องรอบตัว', () => {
  const st = settings('2026-09-10', '2026-12-01')
  assert.equal(videoSlotRequiredFrom(LOCK, st), '2026-09-10')
  assert.equal(videoSlotRequiredFrom(AROUND, st), '2026-12-01')
  assert.equal(videoSlotRequiredFrom('receipt', st), null)
  const old = { createdAt: '2026-10-15' }
  assert.equal(isVideoSlotVisible(old, videoSlotRequiredFrom(LOCK, st)), true)
  assert.equal(isVideoSlotVisible(old, videoSlotRequiredFrom(AROUND, st)), false)
  assert.equal(isVideoSlotVisible({ createdAt: '2026-12-01' }, videoSlotRequiredFrom(AROUND, st)), true)
  assert.equal(isVideoSlotVisible({ createdAt: '2026-12-01' }, videoSlotRequiredFrom('receipt', st)), false)
})

// ---------- budget ----------
const lockFile = (bytes: number, extra: object = {}) => ({ slotKey: LOCK, bytes, ...extra })

test('ค่าคงที่: 10.5 MB', () => {
  assert.equal(VIDEO_TOTAL_MAX_BYTES, 11010048)
})

test('budget: พอดี 10.5 ผ่าน, เกิน 1 ไบต์ไม่ผ่าน', () => {
  const files = [lockFile(5 * MB)]
  assert.equal(checkVideoBudget({ newSlotKey: AROUND, newBytes: 5.5 * MB, files }).ok, true)
  const r = checkVideoBudget({ newSlotKey: AROUND, newBytes: 5.5 * MB + 1, files })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'video_total')
})

test('budget: ข้อความเหลือที่ (1 ทศนิยม, left ปัดลง)', () => {
  const r = checkVideoBudget({ newSlotKey: AROUND, newBytes: 7 * MB, files: [lockFile(5 * MB)] })
  assert.equal(
    r.reasonTh,
    'คลิปนี้ 7.0 MB แต่เหลือที่อีก 5.5 MB (2 คลิปรวมกันไม่เกิน 10.5 MB, คลิปเทสล็อกเครื่อง ใช้ไป 5.0 MB) ย่อคลิปนี้ให้เหลือไม่เกิน 5.5 MB',
  )
  // 10.5 - 4.96 = 5.54 -> ปัดลง 5.5 ไม่ใช่ 5.6
  const r2 = checkVideoBudget({ newSlotKey: AROUND, newBytes: 9 * MB, files: [lockFile(4.96 * MB)] })
  assert.match(r2.reasonTh ?? '', /เหลือที่อีก 5\.5 MB/)
})

test('budget: เหลือน้อยกว่า 1 MB -> ข้อความให้ลบอีกคลิป', () => {
  const r = checkVideoBudget({ newSlotKey: AROUND, newBytes: 2 * MB, files: [lockFile(10 * MB)] })
  assert.equal(r.reason, 'video_total_no_room')
  assert.equal(
    r.reasonTh,
    'คลิปเทสล็อกเครื่อง ใช้ไป 10.0 MB จนเหลือที่ไม่พอ ลบคลิปเทสล็อกเครื่องแล้วแนบตัวที่ย่อแล้ว (2 คลิปรวมกันไม่เกิน 10.5 MB)',
  )
  // อีกทิศ: อัปคลิปเทสล็อก ขณะรอบตัวเครื่องใช้ที่หมด
  const r2 = checkVideoBudget({ newSlotKey: LOCK, newBytes: 1 * MB, files: [{ slotKey: AROUND, bytes: 10.5 * MB }] })
  assert.equal(r2.reason, 'video_total_no_room')
  assert.match(r2.reasonTh ?? '', /^คลิปรอบตัวเครื่อง ใช้ไป 10\.5 MB/)
})

test('budget: ไฟล์ purged/deleted ไม่นับ', () => {
  const files = [lockFile(10 * MB, { purgedAt: '2026-12-01' }), lockFile(10 * MB, { deletedAt: '2026-12-01' })]
  const r = checkVideoBudget({ newSlotKey: AROUND, newBytes: 10.5 * MB, files })
  assert.equal(r.ok, true)
  assert.equal(r.otherBytes, 0)
})

test('budget: แทนที่ช่องเดิม - ไฟล์ live ในช่องเดียวกันไม่นับรวม', () => {
  // รอบตัวมี 9 MB อยู่ แทนที่ด้วย 10 MB; เทสล็อกว่าง -> ผ่าน
  const files = [{ slotKey: AROUND, bytes: 9 * MB }]
  assert.equal(checkVideoBudget({ newSlotKey: AROUND, newBytes: 10 * MB, files }).ok, true)
  // ถ้ามีเทสล็อก 1 MB ด้วย 10 + 1 = 11 > 10.5
  assert.equal(checkVideoBudget({ newSlotKey: AROUND, newBytes: 10 * MB, files: [...files, lockFile(1 * MB)] }).ok, false)
})

test('budget: เพดานเมล 16 MB (รูปรวมกับคลิปใหม่)', () => {
  const photos = [{ slotKey: 'device_around', bytes: 11 * MB }]
  assert.equal(checkVideoBudget({ newSlotKey: AROUND, newBytes: 5 * MB, files: photos }).ok, true) // พอดี 16
  const r = checkVideoBudget({ newSlotKey: AROUND, newBytes: 5.5 * MB, files: photos })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'email_total')
  assert.equal(r.reasonTh, 'เมลฉบับนี้จะหนัก 16.5 MB เกินเพดาน 16 MB ต้องลดอีก 0.5 MB')
  // ต้องลดอีก ปัดขึ้น: เกิน 0.01 MB -> 0.1
  const r2 = checkVideoBudget({ newSlotKey: AROUND, newBytes: 5.01 * MB, files: photos })
  assert.match(r2.reasonTh ?? '', /ต้องลดอีก 0\.1 MB$/)
  assert.equal(EMAIL_MAX_TOTAL_BYTES, 16 * MB)
})

test('budget: เพดานจาก settings ใช้แทน default', () => {
  const r = checkVideoBudget({ newSlotKey: AROUND, newBytes: 3 * MB, files: [lockFile(3 * MB)], videoTotalMaxBytes: 5 * MB })
  assert.equal(r.ok, false)
  assert.match(r.reasonTh ?? '', /ไม่เกิน 5\.0 MB/)
})

test('hint ใต้ช่อง', () => {
  assert.equal(videoBudgetHint(0), '2 คลิปรวมกันไม่เกิน 10.5 MB · เหลืออีก 10.5 MB')
  assert.equal(videoBudgetHint(5 * MB), '2 คลิปรวมกันไม่เกิน 10.5 MB · เหลืออีก 5.5 MB')
  assert.equal(videoBudgetHint(12 * MB), '2 คลิปรวมกันไม่เกิน 10.5 MB · เหลืออีก 0.0 MB')
})

test('checkVideoFile: เพดาน 10.5 ไม่ถูกปัดเป็น 11 ; 10 ยังเป็น 10 ; ไม่ขยายคำแนะนำ QuickTime', () => {
  const r = checkVideoFile({ size: 11 * MB, sniffedMime: 'video/mp4', maxBytes: 10.5 * MB })
  assert.equal(r.accept, false)
  assert.match(r.error ?? '', /^คลิปใหญ่เกิน 10\.5 MB /)
  const r10 = checkVideoFile({ size: 10 * MB + 1, sniffedMime: 'video/mp4' })
  assert.match(r10.error ?? '', /^คลิปใหญ่เกิน 10 MB /)
  assert.equal(
    r10.error,
    'คลิปใหญ่เกิน 10 MB ย่อบน iMac: เปิดคลิปด้วย QuickTime Player > File > Export As > 720p แล้วแนบใหม่ หรือขอร้านถ่ายใหม่ไม่เกิน 1 นาที',
  )
  assert.equal(checkVideoFile({ size: 10.5 * MB, sniffedMime: 'video/mp4', maxBytes: 10.5 * MB }).accept, true)
})

// ---------- parity: ชื่อเดียวกันใน TS / Edge / SQL ----------
// ข้ามอย่างมีเหตุผลถ้าไฟล์ฝั่งน้องชีสยังไม่มี (node:test รายงานเป็น skipped ไม่ใช่ pass)
const root = join(import.meta.dirname, '..')
const migrationByPrefix = (prefix: string) => {
  const dir = join(root, 'supabase', 'migrations')
  const f = readdirSync(dir).find((n) => n.startsWith(prefix + '_'))
  return f ? 'supabase/migrations/' + f : null
}

const parityTargets: Array<{ name: string; path: string | null; must: string[] }> = [
  { name: 'src/lib/media.ts', path: 'src/lib/media.ts', must: [AROUND, '15-1-device-around-video', 'around_video_required'] },
  { name: 'src/lib/db.ts', path: 'src/lib/db.ts', must: ['media_around_video_required_from', 'media_video_total_max_mb'] },
  {
    name: 'send-company-email',
    path: 'supabase/functions/send-company-email/index.ts',
    must: [AROUND, '15-1-device-around-video', 'around_video_required', 'media_around_video_required_from'],
  },
  {
    name: 'media-sign',
    path: 'supabase/functions/media-sign/index.ts',
    must: [AROUND, 'media_around_video_required_from', 'media_video_total_max_mb'],
  },
  {
    name: 'migration 0174',
    path: migrationByPrefix('0174'),
    must: ['media_around_video_required_from', 'media_video_total_max_mb', 'around_video_required', AROUND, 'contract_media_around_video_unique_live'],
  },
  { name: 'migration 0175', path: migrationByPrefix('0175'), must: [AROUND, '15.1', 'around_video_required'] },
]

for (const t of parityTargets) {
  const exists = t.path !== null && existsSync(join(root, t.path))
  test('parity: ' + t.name, { skip: exists ? false : 'ไฟล์ยังไม่มี (น้องชีสยังไม่เขียน) - ข้าม ไม่ได้ตรวจ' }, () => {
    const text = readFileSync(join(root, t.path as string), 'utf8')
    const missing = t.must.filter((m) => !text.includes(m))
    assert.deepEqual(missing, [], t.name + ' ขาดชื่อ: ' + missing.join(', '))
  })
}
