// ===== รูป/เอกสารแนบสัญญา (contract_media) — Phase 1 pure-function layer =====
// Owner-approved source: plan-media-attachments.html §3, §4, §5-ข, §10 (by แบม, 2026-09-08)
// Wave 1 (2026-09-13): เพิ่มคลิปเทสล็อกเครื่อง — video types/functions ต่อท้ายไฟล์เดิม (by แบม)
// Pure functions — ไม่มี side effect, ไม่ import db.ts/supabase, testable ด้วย node -e
import type { DeviceCondition, DeviceOrigin } from './types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MediaFile {
  id: string
  slotKey: string
  sha256: string
  width: number
  height: number
  bytes: number
  uploadedAt: string // ISO
  purgedAt?: string | null // ไฟล์ถูกลบออกจาก storage แล้ว (retention 30 วันหลังส่งเมล) แต่แถวเมทาดาต้ายังอยู่ -> นับว่าช่องครบเหมือนเดิม (ดู evaluateSlots)
  deletedAt?: string | null // ผู้ใช้ลบไฟล์นี้เอง (soft delete) -> ไม่นับ; caller ปกติกรองออกก่อนส่งเข้ามาแล้ว แต่กันซ้ำไว้เผื่อส่งดิบมา
}

export type SlotRequiredRule =
  | 'always'
  | 'never'
  | { when: 'condition'; equals: DeviceCondition }
  | { when: 'flag'; name: string }

export interface MediaSlot {
  key: string
  label: string
  sortOrder: number
  min: number
  max: number | null
  required: SlotRequiredRule
  relabel?: { when: 'origin'; equals: DeviceOrigin; label: string }
  hint?: string
  kind?: 'image' | 'video' // ไม่มีค่า = ถือว่าเป็น 'image' (backward compatible กับ media_slots JSON เก่าที่ไม่มี field นี้)
}

export type SlotStatus = 'ok' | 'missing' | 'partial' | 'optional_empty'

export interface SlotEvaluation {
  key: string
  label: string
  required: boolean
  min: number
  count: number
  status: SlotStatus
  files: MediaFile[]
}

export interface ImageCheckResult {
  accept: boolean
  warnings: Array<{
    code: 'not_image' | 'too_small' | 'dup_same_contract' | 'dup_other_contract' | 'too_large'
    message: string
  }>
}

// ---------------------------------------------------------------------------
// Video types (Wave 1 — แนบคลิปเทสล็อกในเมลบริษัท, owner-approved 2026-09-13)
// ---------------------------------------------------------------------------

export type VideoMime = 'video/mp4' | 'video/quicktime'

export interface VideoCheckResult {
  accept: boolean
  error?: string
}

/** อินพุตของ emailBudget — ไม่ผูกกับ MediaFile โดยตรง เพราะใช้กับทั้งรูปและคลิปตอนจะแนบเมล */
export interface EmailBudgetFile {
  bytes: number
  purgedAt?: string | null
  deletedAt?: string | null
}

export interface EmailBudgetResult {
  totalBytes: number
  fileCount: number
  overBytes: boolean
  overFiles: boolean
  ok: boolean
  reasonTh: string | null
}

/**
 * flag bag ทั่วไปที่ isSlotRequired/evaluateSlots ใช้เช็คช่องที่ required:{when:'flag',...}
 * เป็น Record ทั่วไป (ไม่ fix key ตายตัว) เพื่อรองรับ flag ใหม่ (เช่น video_required) โดยไม่ต้องแก้ signature เดิม
 * flag ที่ไม่รู้จัก (ไม่มี key นี้ใน object) -> isSlotRequired คืน false ตามพฤติกรรมเดิม
 */
export type MediaFlags = Record<string, boolean>

/** อินพุตฝั่งสัญญาของ buildMediaFlags — เอาเท่าที่ flag ทุกตัวใช้ ไม่เอา Contract ทั้งก้อน */
export interface MediaFlagsContract {
  creditHistoryFound: boolean
  createdAt: string | null | undefined
  emailSentAt: string | null | undefined
}

/** อินพุตฝั่ง settings ของ buildMediaFlags — ค่าจริงมาจาก app_settings ผ่าน db.ts */
export interface MediaFlagsSettings {
  videoRequiredFrom: string | null | undefined
}

// ---------------------------------------------------------------------------
// Default 17 slots (seed → app_settings.media_slots, admin-editable ภายหลัง)
// (คอมเมนต์เดิมเขียนว่า "15 slots" แต่นับจริงคือ 16 มาตั้งแต่ก่อน Wave1 — ตกหล่นตอนเพิ่ม warranty_check
//  sortOrder 4.1 ทีหลังแล้วลืมแก้เลข ตอนนี้แก้ให้ตรงของจริง 17 = 16 เดิม + lock_test_video ใหม่)
// อัปเดต 2026-09-13: เจ้าของกลับคำจากเดิม (เคยตัดวิดีโอออกโดยตั้งใจ เพราะกังวลพื้นที่เก็บ/ขนาดไฟล์)
// ตอนนี้ยอมรับคลิปเทสล็อกเครื่อง 1 คลิป/เคส (เพดานขนาดตามค่าตั้ง app_settings.media_video_max_mb, ~1 นาที) แนบไปกับเมลบริษัทฉบับเดียวกับรูป
// แล้วลบคลิปออกจากเว็บ 30 วันหลังส่งเมล ทุกเคสไม่มีข้อยกเว้น (ดู videoPurgeDueAt ด้านล่าง) — รูปไม่ลบ
// ---------------------------------------------------------------------------

export const DEFAULT_MEDIA_SLOTS: MediaSlot[] = [
  { key: 'id_card_front', label: 'หน้าบัตรประชาชนลูกค้า', sortOrder: 1, min: 1, max: 1, required: 'always' },
  { key: 'occupation_photo', label: 'รูปอาชีพ', sortOrder: 2, min: 1, max: null, required: 'always', hint: 'ใส่ได้หลายรูป' },
  { key: 'device_around', label: 'รูปรอบตัวเครื่อง', sortOrder: 3, min: 5, max: null, required: 'always', hint: 'ถ่าย บน ล่าง ซ้าย ขวา หน้า หลัง อย่างน้อย 5 มุม' },
  { key: 'box_back', label: 'รูปหลังกล่อง', sortOrder: 4, min: 1, max: 1, required: { when: 'condition', equals: 'new' } },
  { key: 'warranty_check', label: 'รูปเช็คประกันตัวเครื่อง', sortOrder: 4.1, min: 1, max: 1, required: { when: 'condition', equals: 'new' }, hint: 'เช็คประกันจากเลขเครื่อง แล้วแคปหน้าผลตรวจ' },
  { key: 'settings_about', label: 'หน้าตั้งค่า > เกี่ยวกับ', sortOrder: 5, min: 1, max: 1, required: 'always' },
  { key: 'imei_photo', label: 'รูปเลข IMEI', sortOrder: 6, min: 0, max: 1, required: 'never' },
  { key: 'battery_health', label: 'รูปสุขภาพแบตเตอรี่', sortOrder: 7, min: 1, max: 1, required: 'always' },
  { key: 'garuda_emblem', label: 'รูปตราครุฑ', sortOrder: 8, min: 1, max: 1, required: 'always' },
  { key: 'contract_docs', label: 'เอกสารสัญญามีลายเซ็น', sortOrder: 9, min: 4, max: null, required: 'always', hint: 'ต้องมีอย่างน้อย 4 แผ่น' },
  { key: 'id_copy_consent', label: 'สำเนาบัตรฯ เซ็นยินยอม', sortOrder: 10, min: 1, max: 1, required: 'always' },
  { key: 'receipt', label: 'ใบเสร็จ', sortOrder: 11, min: 1, max: 1, required: 'always' },
  { key: 'customer_id_imei', label: 'ลูกค้าถือบัตร + เครื่องโชว์ IMEI', sortOrder: 12, min: 1, max: 1, required: 'always', hint: 'ให้ลูกค้ากด *#06# แล้วถือบัตรคู่เครื่อง' },
  { key: 'credit_check', label: 'ผลเช็คเครดิต', sortOrder: 13, min: 1, max: 1, required: 'always' },
  { key: 'credit_history_evidence', label: 'ใบแจ้งความ / หลักฐานเคลียร์ยอด', sortOrder: 13.1, min: 1, max: null, required: { when: 'flag', name: 'credit_history_found' } },
  { key: 'device_on_off', label: 'สถานะ On/Off ของเครื่อง', sortOrder: 14, min: 1, max: 1, required: 'always' },
  { key: 'lock_test_video', label: 'คลิปเทสล็อกเครื่อง', sortOrder: 15, min: 1, max: 1, kind: 'video', required: { when: 'flag', name: 'video_required' }, hint: 'ไม่เกินขนาดที่ตั้งไว้ (ประมาณ 1 นาที)' },
]

// ---------------------------------------------------------------------------
// Resize policy constants (ใช้โดยน้องวิวตอน resize รูปด้วย canvas)
// ---------------------------------------------------------------------------

export const MEDIA_MAX_LONG_SIDE = 1600
export const MEDIA_JPEG_QUALITY = 0.82
export const MEDIA_JPEG_QUALITY_RETRY = 0.72
export const MEDIA_TARGET_MAX_BYTES = 400_000

// ---------------------------------------------------------------------------
// checkImageFile policy constants
// ---------------------------------------------------------------------------

export const CHECK_IMAGE_MAX_BYTES = 15 * 1024 * 1024 // 15 MB, pre-resize
export const CHECK_IMAGE_MIN_LONG_SIDE = 800 // px, warn ไม่บล็อก

// ---------------------------------------------------------------------------
// checkVideoFile / emailBudget policy constants
// อัปเดต 2026-09-13 (คำตัดสินใหม่): ทดสอบแล้ว Gmail SMTP รับข้อมูลได้จริง ~200 KB/s (แก้ฝั่งโค้ดไม่ได้)
// เจ้าของเคาะเพดานใหม่: เมลรวม 16 MB (ตรง app_settings.media_email_max_total_mb='16')
// คลิปเดียว ≤ ค่าตั้ง media_video_max_mb (ปรับได้ที่ app_settings ไม่ผูกกับตัวเลขในไฟล์นี้), จำนวนไฟล์ต่อเมล 30 (รูปจริงบางเคส 25 + คลิป 1)
// ค่าคงที่ด้านล่างเป็นแค่ default ตอนไม่ส่งเพดานมาเอง — ของจริงต้องอ่านจาก getMediaVideoSettings()
// แล้วแปลงด้วย mbToBytes() ส่งเข้า checkVideoFile/emailBudget ผ่านพารามิเตอร์ (ห้าม hardcode เพดานใน UI)
// ---------------------------------------------------------------------------

export const VIDEO_MAX_BYTES = 10 * 1024 * 1024 // 10 MB ต่อคลิป (default เมื่อไม่ส่ง maxBytes)
export const EMAIL_MAX_TOTAL_BYTES = 16 * 1024 * 1024 // รูป+คลิป ดิบรวมต่อเมล 1 ฉบับ (default เมื่อไม่ส่ง opts.maxBytes)
export const EMAIL_MAX_FILES = 30 // default เมื่อไม่ส่ง opts.maxFiles

// ---------------------------------------------------------------------------
// Gate cutoff — สัญญาที่สร้างตั้งแต่วันนี้เป็นต้นไปต้องส่งรูปครบก่อนส่งเมล
// สัญญาเก่า (createdAt < cutoff หรือไม่มี createdAt) ได้รับการยกเว้น (ungated)
// ค่าจริงมาจาก app_settings.media_gate_from (ครีมอ่านผ่าน db.ts แล้วส่ง gateFrom มาที่นี่)
// ---------------------------------------------------------------------------

/**
 * ตัดสินว่าสัญญานี้ "ต้องผ่านเกณฑ์ส่งรูปครบ" ก่อนส่งเมลหรือไม่
 * gateFrom = null/undefined/'' -> ยังไม่ตั้งค่า cutoff -> ถือว่าไม่ gate ใครเลย (false)
 * contract.createdAt ไม่มี -> ข้อมูลเก่า -> ไม่ gate (false)
 */
export function isGated(
  contract: { createdAt?: string | null },
  gateFrom: string | null | undefined,
): boolean {
  if (!gateFrom) return false
  const createdAt = contract.createdAt
  if (!createdAt) return false
  return createdAt.slice(0, 10) >= gateFrom.slice(0, 10)
}

// ---------------------------------------------------------------------------
// MEDIA_TRACK_FROM — วันที่ระบบแนบรูปในเว็บเริ่มใช้จริง (2026-09-08)
// ต่างจาก isGated()/gateFrom ด้านบน (คุม "บล็อกส่งเมล" อ่านจาก app_settings แก้ได้)
// ตัวนี้คุมแค่ "ป้ายเตือน" ในหน้ารอสรุปยอด (WaitingSummary.tsx) — เตือนอย่างเดียว ไม่บล็อก
// ฮาร์ดโค้ดตามวันที่ฟีเจอร์รูป deploy จริง (เคสเก่ากว่านี้ไม่เคยมีกติกาให้แนบรูป เตือนย้อนหลังไม่ได้)
// ---------------------------------------------------------------------------
export const MEDIA_TRACK_FROM = '2026-09-08'

/**
 * เคสนี้ "เข้าเกณฑ์ติดตามรูป" หรือยัง (createdAt >= MEDIA_TRACK_FROM)
 * createdAt ว่าง/undefined -> false (ข้อมูลเก่าไม่มี timestamp ที่เทียบได้ -> ไม่เตือน)
 */
export function isMediaTracked(createdAt: string | null | undefined): boolean {
  if (!createdAt) return false
  return createdAt.slice(0, 10) >= MEDIA_TRACK_FROM
}

// ---------------------------------------------------------------------------
// evaluateSlots
// ---------------------------------------------------------------------------

function isSlotRequired(
  rule: SlotRequiredRule,
  contract: { condition: DeviceCondition; origin: DeviceOrigin },
  flags: MediaFlags,
): boolean {
  if (rule === 'always') return true
  if (rule === 'never') return false
  if (rule.when === 'condition') return contract.condition === rule.equals
  return flags[rule.name] === true
}

function resolveLabel(slot: MediaSlot, contract: { origin: DeviceOrigin }): string {
  if (slot.relabel && contract.origin === slot.relabel.equals) return slot.relabel.label
  return slot.label
}

/**
 * ประเมินสถานะรูป/เอกสารทุกช่องของสัญญา 1 ใบ
 * dedupe ไฟล์ด้วย sha256 ภายในสัญญาเดียวกันก่อนนับ (อัปซ้ำไม่นับเพิ่ม)
 * เรียงผลลัพธ์ตาม sortOrder
 */
export function evaluateSlots(
  slots: MediaSlot[],
  contract: { condition: DeviceCondition; origin: DeviceOrigin },
  flags: MediaFlags,
  files: MediaFile[],
): { complete: boolean; slots: SlotEvaluation[]; missing: string[] } {
  const sorted = [...slots].sort((a, b) => a.sortOrder - b.sortOrder)

  const evaluations: SlotEvaluation[] = sorted.map((slot) => {
    // purgedAt (ลบออกจาก storage หลังครบ retention) ยังนับว่าช่องครบเหมือนเดิม — ไม่กรองออก
    // deletedAt (ผู้ใช้ลบเอง) ไม่นับ — ปกติ caller กรองออกก่อนส่งมาแล้ว แต่กันซ้ำไว้เผื่อส่งดิบมา
    const slotFiles = files.filter((f) => f.slotKey === slot.key && !f.deletedAt)
    const seen = new Set<string>()
    const deduped: MediaFile[] = []
    for (const f of slotFiles) {
      if (seen.has(f.sha256)) continue
      seen.add(f.sha256)
      deduped.push(f)
    }
    const count = deduped.length
    const required = isSlotRequired(slot.required, contract, flags)
    const label = resolveLabel(slot, contract)

    let status: SlotStatus
    if (!required) {
      status = count > 0 ? 'ok' : 'optional_empty'
    } else if (count === 0) {
      status = 'missing'
    } else if (count < slot.min) {
      status = 'partial'
    } else {
      status = 'ok'
    }

    return { key: slot.key, label, required, min: slot.min, count, status, files: deduped }
  })

  const missing = evaluations
    .filter((e) => e.status === 'missing' || e.status === 'partial')
    .map((e) => e.label)

  const complete = missing.length === 0

  return { complete, slots: evaluations, missing }
}

// ---------------------------------------------------------------------------
// checkImageFile
// ---------------------------------------------------------------------------

export function checkImageFile(
  file: { mime: string; width: number; height: number; bytes: number; sha256: string },
  existing: {
    sameContractHashes: Set<string>
    otherContractMatch?: { contractNo: string; customerName: string } | null
  },
): ImageCheckResult {
  const warnings: ImageCheckResult['warnings'] = []

  if (!file.mime.startsWith('image/')) {
    return { accept: false, warnings: [{ code: 'not_image', message: 'ไฟล์นี้ไม่ใช่รูปภาพ' }] }
  }

  if (file.bytes > CHECK_IMAGE_MAX_BYTES) {
    return { accept: false, warnings: [{ code: 'too_large', message: 'ไฟล์ใหญ่เกิน 15 MB' }] }
  }

  const longSide = Math.max(file.width, file.height)
  if (longSide < CHECK_IMAGE_MIN_LONG_SIDE) {
    warnings.push({ code: 'too_small', message: 'รูปมีความละเอียดต่ำ อาจอ่านรายละเอียดไม่ชัด' })
  }

  if (existing.sameContractHashes.has(file.sha256)) {
    warnings.push({ code: 'dup_same_contract', message: 'รูปนี้เคยอัปในสัญญานี้แล้ว ระบบนับให้ 1 ครั้ง' })
  } else if (existing.otherContractMatch) {
    const otherContractNo = existing.otherContractMatch.contractNo
    const otherCustomerName = existing.otherContractMatch.customerName
    warnings.push({
      code: 'dup_other_contract',
      message: 'รูปนี้เคยใช้กับสัญญา ' + otherContractNo + ' (' + maskName(otherCustomerName) + ')',
    })
  }

  return { accept: true, warnings }
}

// ---------------------------------------------------------------------------
// missingSummary
// ---------------------------------------------------------------------------

/**
 * สร้างข้อความสรุปช่องที่ขาด สำหรับป้ายบล็อกส่งเมล
 * รูปแบบ: "ยังส่งไม่ได้ ขาด: รูปรอบตัวเครื่อง (มี 3/5), เอกสารสัญญา"
 * - status='partial' ต่อท้ายด้วย "(มี {count}/{min})"
 * - status='missing' (count===0) label เปล่า ไม่มีวงเล็บ
 * - เรียงตาม sortOrder ของ evaluation.slots (evaluateSlots เรียงมาให้แล้ว)
 * - ไม่มีอะไรขาด -> คืนสตริงว่าง
 */
export function missingSummary(evaluation: { slots: SlotEvaluation[] }): string {
  const parts = evaluation.slots
    .filter((s) => s.status === 'missing' || s.status === 'partial')
    .map((s) => (s.status === 'partial' ? s.label + ' (มี ' + s.count + '/' + s.min + ')' : s.label))

  if (parts.length === 0) return ''
  return 'ยังส่งไม่ได้ ขาด: ' + parts.join(', ')
}

// ---------------------------------------------------------------------------
// sniffImageMime — เดา MIME จาก magic bytes (กันไฟล์เปลี่ยนนามสกุลหลอก)
// ---------------------------------------------------------------------------

/**
 * เดา MIME จาก magic bytes ต้นไฟล์
 * รองรับ: image/jpeg (FFD8FF), image/png (89504E47), image/webp (RIFF....WEBP),
 *         image/heic (ftyp heic/heix/hevc/mif1 ที่ offset 4)
 * ไม่รู้จัก -> null
 */
export function sniffImageMime(
  bytes: Uint8Array,
): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | null {
  if (bytes.length < 4) return null

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'

  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp'
  }

  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
    if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'mif1') return 'image/heic'
  }

  return null
}

// ---------------------------------------------------------------------------
// sniffVideoMime — เดา MIME คลิปจาก magic bytes (ftyp box) แยกจาก sniffImageMime (HEIC) เด็ดขาด
// ---------------------------------------------------------------------------

const MP4_FTYP_BRANDS = new Set(['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash'])
const MOV_FTYP_BRANDS = new Set(['qt  '])

/**
 * เดา MIME คลิปจาก magic bytes ต้นไฟล์ (ISO base media ftyp box: offset4='ftyp', brand 4 ตัวอักษรที่ offset8)
 * รองรับ mp4 ทั่วไป (isom/iso2/mp41/mp42/avc1/'M4V '/dash) -> video/mp4
 * รองรับ mov จาก QuickTime ('qt  ') -> video/quicktime
 * brand ที่ตรงกับ HEIC (heic/heix/hevc/mif1 — ดู sniffImageMime ด้านบน) ไม่อยู่ใน set นี้เลย จึงไม่ชนกัน
 * ไม่รู้จัก -> null
 */
export function sniffVideoMime(bytes: Uint8Array): VideoMime | null {
  if (bytes.length < 12) return null
  if (!(bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70)) return null
  const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
  if (MOV_FTYP_BRANDS.has(brand)) return 'video/quicktime'
  if (MP4_FTYP_BRANDS.has(brand)) return 'video/mp4'
  return null
}

// ---------------------------------------------------------------------------
// checkVideoFile — ตรวจคลิปเทสล็อกเครื่องก่อนอัป (ชนิด + ขนาด)
// ---------------------------------------------------------------------------

/**
 * ตรวจคลิปที่พนักงานเลือกแนบ ก่อนอัปขึ้นระบบ
 * sniffedMime ต้องมาจาก sniffVideoMime(bytes) ที่ caller เรียกเอง (ฟังก์ชันนี้ไม่แตะไฟล์ดิบ)
 * maxBytes ไม่ส่ง (undefined) -> ใช้ VIDEO_MAX_BYTES (10 MB); ส่งมา -> ใช้ค่านั้นแทนทั้งเช็คขนาดและข้อความ error
 *   (caller ควรแปลงจาก getMediaVideoSettings().videoMaxMb ด้วย mbToBytes() ก่อนส่งเข้ามา)
 * ไม่ใช่ mp4/mov -> บอกให้ใช้คลิปจากกล้องไอโฟนหรือที่ส่งทาง LINE
 * เกินเพดาน (>, เท่ากับพอดี "ผ่าน") -> บอกวิธีย่อด้วย QuickTime Player บน iMac พร้อมตัวเลข MB ตามเพดานจริงที่ใช้
 */
export function checkVideoFile(file: {
  size: number
  sniffedMime: VideoMime | null
  maxBytes?: number
}): VideoCheckResult {
  if (file.sniffedMime !== 'video/mp4' && file.sniffedMime !== 'video/quicktime') {
    return {
      accept: false,
      error: 'ไฟล์นี้ไม่ใช่คลิปวิดีโอที่ใช้ได้ ลองแนบคลิปที่ถ่ายจากกล้องไอโฟนโดยตรง หรือคลิปที่ร้านส่งมาทาง LINE',
    }
  }
  const maxBytes = file.maxBytes ?? VIDEO_MAX_BYTES
  if (file.size > maxBytes) {
    const maxMb = Math.round(maxBytes / (1024 * 1024))
    return {
      accept: false,
      error:
        'คลิปใหญ่เกิน ' + maxMb + ' MB ย่อบน iMac: เปิดคลิปด้วย QuickTime Player > File > Export As > 720p แล้วแนบใหม่ หรือขอร้านถ่ายใหม่ไม่เกิน 1 นาที',
    }
  }
  return { accept: true }
}

// ---------------------------------------------------------------------------
// emailBudget — เช็คขนาดรวม/จำนวนไฟล์แนบก่อนส่งเมลบริษัท (กันเมลตัดกลางทาง)
// ---------------------------------------------------------------------------

export interface EmailBudgetOptions {
  maxBytes?: number
  maxFiles?: number
}

/**
 * รวมขนาด+จำนวนไฟล์แนบที่ "ยังอยู่จริง" เท่านั้น (ไม่นับไฟล์ที่ purgedAt หรือ deletedAt มีค่า ทั้งขนาดและจำนวน)
 * opts ไม่ส่ง (undefined) -> ใช้ EMAIL_MAX_TOTAL_BYTES (16 MB) / EMAIL_MAX_FILES (30) เป็น default
 *   (caller ควรแปลง opts.maxBytes จาก getMediaVideoSettings().emailMaxTotalMb ด้วย mbToBytes() ก่อนส่งเข้ามา)
 * ok=false ถ้าเกินเพดานอันใดอันหนึ่ง (VIDEO ไม่เกี่ยว ตรวจแยกที่ checkVideoFile) — reasonTh เป็น null เมื่อ ok=true
 * reasonTh แสดงตัวเลข MB/จำนวนไฟล์ตามเพดานที่ใช้จริง (opts ถ้ามี ไม่ใช่ default เสมอ)
 */
export function emailBudget(files: EmailBudgetFile[], opts?: EmailBudgetOptions): EmailBudgetResult {
  const maxBytes = opts?.maxBytes ?? EMAIL_MAX_TOTAL_BYTES
  const maxFiles = opts?.maxFiles ?? EMAIL_MAX_FILES
  const maxMb = Math.round(maxBytes / (1024 * 1024))

  const active = files.filter((f) => !f.purgedAt && !f.deletedAt)
  const totalBytes = active.reduce((sum, f) => sum + f.bytes, 0)
  const fileCount = active.length
  const overBytes = totalBytes > maxBytes
  const overFiles = fileCount > maxFiles
  const ok = !overBytes && !overFiles

  let reasonTh: string | null = null
  if (overBytes && overFiles) {
    reasonTh = 'ไฟล์แนบรวมใหญ่เกิน ' + maxMb + ' MB และมีเกิน ' + maxFiles + ' ไฟล์ ลบรูปที่ไม่จำเป็นออกก่อนส่ง'
  } else if (overBytes) {
    reasonTh = 'ไฟล์แนบรวมใหญ่เกิน ' + maxMb + ' MB ลบรูปที่ไม่จำเป็นออกก่อนส่ง'
  } else if (overFiles) {
    reasonTh = 'ไฟล์แนบเกิน ' + maxFiles + ' ไฟล์ ลบรูปที่ไม่จำเป็นออกก่อนส่ง'
  }

  return { totalBytes, fileCount, overBytes, overFiles, ok, reasonTh }
}

// ---------------------------------------------------------------------------
// mbToBytes — แปลง MB จาก app_settings เป็นไบต์ ทางเดียวที่หน้าเว็บควรใช้ก่อนส่งเพดานเข้า
// checkVideoFile/emailBudget (กันแต่ละหน้า hardcode เพดานเองแล้วไม่ sync กับค่าจริงใน settings)
// ---------------------------------------------------------------------------

/**
 * แปลง MB (เช่น getMediaVideoSettings().videoMaxMb หรือ .emailMaxTotalMb) เป็นไบต์
 * mb ไม่ใช่ตัวเลข (null/undefined/NaN/สตริง) หรือ <= 0 -> คืน fallbackBytes แทน
 * (กันค่าตั้งค่าเพี้ยน/ยังไม่ตั้ง ทำเพดานกลายเป็น 0 หรือติดลบ)
 */
export function mbToBytes(mb: number | null | undefined, fallbackBytes: number): number {
  if (typeof mb !== 'number' || !Number.isFinite(mb) || mb <= 0) return fallbackBytes
  return Math.round(mb * 1024 * 1024)
}

// ---------------------------------------------------------------------------
// isVideoRequired — เคสนี้ต้องมีคลิปเทสล็อกก่อนส่งตรวจ/ส่งเมลไหม
// ---------------------------------------------------------------------------

function isValidDateString(s: string | null | undefined): s is string {
  if (!s) return false
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return false
  return !Number.isNaN(Date.parse(s.slice(0, 10)))
}

/**
 * video_required = requiredFrom เป็นวันที่ถูกต้อง
 *                  AND วันที่สร้างสัญญา (createdAt ตัดเอาแค่ส่วนวันที่ ถือว่าเป็น UTC date ตามที่เก็บจริง) >= requiredFrom
 *                  AND emailSentAt เป็น null (เคสที่เคยส่งเมลบริษัทไปแล้วไม่บังคับซ้ำ ไม่ว่าตอนนั้นมีคลิปหรือไม่)
 * requiredFrom ว่าง/ไม่ใช่วันที่ที่ถูกต้อง (เช่น '', 'x', undefined, null) -> false เสมอ (ไม่บังคับ)
 * createdAt ไม่มีค่า -> false (ข้อมูลเก่าไม่มี timestamp ที่เทียบได้)
 * ตั้งใจไม่แปลงเป็นเวลาไทย — createdAt ต้องเป็น ISO ที่เก็บเป็น UTC มาแล้ว เทียบ slice(0,10) ตรงๆ
 * (ล้อแบบ isGated ด้านบน แต่แยกฟังก์ชันเพราะมีเงื่อนไข emailSentAt เพิ่ม)
 */
export function isVideoRequired(
  contract: { createdAt: string | null | undefined; emailSentAt: string | null | undefined },
  requiredFrom: string | null | undefined,
): boolean {
  if (!isValidDateString(requiredFrom)) return false
  if (contract.emailSentAt) return false
  if (!contract.createdAt) return false
  return contract.createdAt.slice(0, 10) >= requiredFrom.slice(0, 10)
}

// ---------------------------------------------------------------------------
// buildMediaFlags — รวม flag ทุกตัวที่ slot ใช้ไว้จุดเดียว (credit_history_found, video_required, ...)
// ทุกหน้าที่เรียก evaluateSlots ควรประกอบ flags ผ่านฟังก์ชันนี้ตัวเดียว ห้ามประกอบ object เองกระจาย
// น้องวิว wire ครบแล้ว (ContractMediaCard.tsx, ContractDetail.tsx, WaitingEmail.tsx, WaitingSummary.tsx)
// เพิ่ม flag ใหม่ในอนาคต -> เติมที่นี่ที่เดียว แล้วไล่เช็คว่าทุกจุดยังเรียก buildMediaFlags() ไม่ประกอบเอง
// ---------------------------------------------------------------------------

export function buildMediaFlags(contract: MediaFlagsContract, settings: MediaFlagsSettings): MediaFlags {
  return {
    credit_history_found: contract.creditHistoryFound,
    video_required: isVideoRequired(
      { createdAt: contract.createdAt, emailSentAt: contract.emailSentAt },
      settings.videoRequiredFrom,
    ),
  }
}

// ---------------------------------------------------------------------------
// videoPurgeDueAt — วันที่ครบกำหนดลบคลิปออกจากเว็บ (30 วันหลังส่งเมล ทุกเคสไม่มีข้อยกเว้น)
// ---------------------------------------------------------------------------

/** emailedAt = contract.emailSentAt (ISO) ; retentionDays = ค่าจริงมาจาก app_settings ฝั่ง caller (ปกติ 30) */
export function videoPurgeDueAt(emailedAt: string, retentionDays: number): Date {
  const due = new Date(emailedAt)
  due.setUTCDate(due.getUTCDate() + retentionDays)
  return due
}

// ---------------------------------------------------------------------------
// transferMediaSlots — ช่องเอกสารรอบ "เปลี่ยนผู้ผ่อน" (feature ใหม่ 2026-09-14)
// คุณเตยเคาะ: ใช้กลไกเดียวกับรูปตอนรอตรวจเมล แต่เอาเฉพาะเอกสาร/บุคคล ไม่เอารูปตัวเครื่อง
// derive จาก DEFAULT_MEDIA_SLOTS ของจริง (label/min/max/hint เดิมทุกอย่าง) ห้ามแก้ DEFAULT_MEDIA_SLOTS เอง
// key เปลี่ยนเป็น `transfer_{N}_<baseKey>` (namespaced ต่อรอบ — เปลี่ยนผู้ผ่อนได้หลายครั้ง ไม่ชนกัน)
// required บังคับเป็น 'always' เสมอ (ต่างจาก base ที่บาง key เป็น conditional เช่น box_back/warranty_check
// ผูกกับ condition มือ1/มือ2 — แต่ 5 คีย์ที่เลือกใช้ตอนนี้ล้วน 'always' อยู่แล้วใน DEFAULT_MEDIA_SLOTS พอดี)
// ---------------------------------------------------------------------------

/** base key ใน DEFAULT_MEDIA_SLOTS ที่ใช้ประกอบช่องเอกสารรอบเปลี่ยนผู้ผ่อน — เพิ่ม/ลดง่ายที่จุดเดียว */
export const TRANSFER_DOC_BASE_KEYS = [
  'id_card_front',     // หน้าบัตรประชาชนลูกค้า (ผู้ผ่อนคนใหม่) — min1 max1
  'occupation_photo',  // รูปอาชีพ — min1 max null
  'contract_docs',     // เอกสารสัญญามีลายเซ็น — min4 max null
  'id_copy_consent',   // สำเนาบัตรฯ เซ็นยินยอม — min1 max1
  'credit_check',      // ผลเช็คเครดิต — min1 max1 (เพิ่ม 2026-09-14 ตามคุณเตยเคาะ)
] as const

/**
 * สร้างช่องเอกสาร (MediaSlot[]) ของรอบเปลี่ยนผู้ผ่อนที่ N (transferNo เริ่มที่ 1)
 * key namespaced เป็น `transfer_{N}_<baseKey>`, label ต่อท้าย "(ผู้ผ่อนคนใหม่)" ให้อ่านง่ายว่าเป็นเอกสารของใคร
 * ทุกช่อง required:'always' (เงื่อนไข condition/flag ของ base slot ไม่เกี่ยว — บังคับครบทั้ง 4 ก่อนกดยืนยันเสมอ)
 * ใช้กับ evaluateSlots ตรงๆ ได้ (ไม่ต้องพก contract/flags จริง — ดู evaluateTransferDocs ด้านล่าง)
 */
export function transferMediaSlots(transferNo: number): MediaSlot[] {
  return TRANSFER_DOC_BASE_KEYS.map((baseKey, i) => {
    const base = DEFAULT_MEDIA_SLOTS.find((s) => s.key === baseKey)
    if (!base) throw new Error(`transferMediaSlots: ไม่พบ base slot key="${baseKey}" ใน DEFAULT_MEDIA_SLOTS`)
    return {
      key: `transfer_${transferNo}_${baseKey}`,
      label: `${base.label} (ผู้ผ่อนคนใหม่)`,
      sortOrder: transferNo * 10 + i + 1,
      min: base.min,
      max: base.max,
      required: 'always',
      hint: base.hint,
    }
  })
}

/**
 * ประเมินช่องเอกสารรอบเปลี่ยนผู้ผ่อนที่ N ตรงๆ (wrapper รอบ evaluateSlots + transferMediaSlots)
 * ไม่ต้องพก contract {condition,origin} จริงเข้ามา เพราะทุกช่อง required:'always' อยู่แล้ว (ค่า dummy ไม่มีผลต่อผลลัพธ์)
 */
export function evaluateTransferDocs(
  transferNo: number,
  files: MediaFile[],
): { complete: boolean; slots: SlotEvaluation[]; missing: string[] } {
  return evaluateSlots(transferMediaSlots(transferNo), { condition: 'used', origin: 'th' }, {}, files)
}

// ---------------------------------------------------------------------------
// mediaFilename — ตั้งชื่อไฟล์แนบ ตาม slug map (spec section 3)
// ---------------------------------------------------------------------------

const SLOT_SLUG: Record<string, string> = {
  id_card_front: '01-id-card',
  occupation_photo: '02-occupation',
  device_around: '03-device',
  box_back: '04-box-back',
  warranty_check: '04-1-warranty',
  settings_about: '05-settings-about',
  imei_photo: '06-imei',
  battery_health: '07-battery',
  garuda_emblem: '08-garuda',
  contract_docs: '09-contract',
  id_copy_consent: '10-id-consent',
  receipt: '11-receipt',
  customer_id_imei: '12-customer-imei',
  credit_check: '13-credit-check',
  credit_history_evidence: '13-1-credit-history',
  device_on_off: '14-device-onoff',
  lock_test_video: '15-lock-test-video',
}

/**
 * สร้างชื่อไฟล์ (ใช้เป็น caption/ป้ายกำกับใน UI เช่น lightbox) เช่น
 * mediaFilename('device_around', 1, 'jpg') === '03-device-1.jpg'
 * slot ที่ไม่รู้จัก (เผื่ออนาคตเพิ่มช่องใหม่) -> ใช้ key ดิบแทน slug
 *
 * หมายเหตุ: ชื่อไฟล์แนบอีเมลจริง "ไม่ได้" มาจากฟังก์ชันนี้ — ต้นทางความจริงคือ
 * supabase/functions/send-company-email/index.ts ซึ่งตั้งชื่อไฟล์แรกในช่องแบบไม่มี "-1"
 * ต่อท้าย (เช่น '03-device.jpg' ไม่ใช่ '03-device-1.jpg') ต่างจากฟังก์ชันนี้ที่ใส่เลขลำดับเสมอ
 */
export function mediaFilename(slotKey: string, index: number, ext: string): string {
  const slug = SLOT_SLUG[slotKey] ?? slotKey
  return slug + '-' + index + '.' + ext
}

// ---------------------------------------------------------------------------
// maskName — ปิดบังชื่อลูกค้าบางส่วน (ใช้ตอนแจ้งเตือนรูปซ้ำข้ามสัญญา)
// ---------------------------------------------------------------------------

/** maskName('สมชาย ใจดี') === 'สม***' ; ชื่อสั้นกว่า 2 ตัวอักษร -> เท่าที่มี + '***' */
export function maskName(name: string): string {
  return name.slice(0, 2) + '***'
}

// ===========================================================================
// Trace tests (verify ด้วย node -e ผ่าน tsc transpile — repo ไม่มี vitest)
// ===========================================================================
//
// ต่อไปนี้อ้างอิง DEFAULT_MEDIA_SLOTS ทั้ง 17 ช่อง เว้นแต่ระบุเป็นอย่างอื่น (เดิม 16 ช่องจริง + lock_test_video ใหม่)
//
// evaluateSlots:
// (1) condition:'new', origin:'th', flags:{credit_history_found:false}
//     ทุกช่อง 1 ไฟล์ ยกเว้น device_around 3 ไฟล์, contract_docs 4 ไฟล์
//     -> device_around: required=true, min=5, count=3 -> status='partial'
//     -> credit_history_evidence: required=false (flag=false) -> 'optional_empty'
//     -> lock_test_video: flags ไม่มี key video_required -> flags['video_required']===true เป็น false -> required=false -> count=0 -> 'optional_empty'
//     -> complete=false, missing=['รูปรอบตัวเครื่อง']
//
// (2) เหมือน (1) แต่ device_around 6 ไฟล์ -> status='ok', complete=true, missing=[]
//
// (3) condition:'used' -> box_back required=false, warranty_check required=false
//     (ทั้งสองช่องใช้กฎ condition equals 'new' เหมือนกัน) count=0 ทั้งคู่
//     -> status='optional_empty' ไม่อยู่ใน missing
//
// (4) origin:'inter' -> garuda_emblem label ยังคง 'รูปตราครุฑ' เหมือนทุก origin (คุณเตยล็อก 2026-09-08: ห้าม relabel ช่องนี้)
//     required=true ไม่เปลี่ยน (relabel mechanism ยังใช้ได้ถ้าตั้งค่าใน app_settings ในอนาคต แต่ default ไม่ตั้ง)
//
// (5) flags.credit_history_found:true, credit_history_evidence count=0
//     -> required=true -> status='missing' -> missing includes 'ใบแจ้งความ / หลักฐานเคลียร์ยอด'
//     flags.credit_history_found:false, count=0 -> status='optional_empty' ไม่อยู่ใน missing
//
// (6) ทุกช่องครบตาม min (รวม device_around>=5, contract_docs>=4)
//     condition:'used' (box_back, warranty_check ไม่ต้องมี), flags {credit_history_found:false, video_required:false}
//     lock_test_video count=0 (video_required=false) -> 'optional_empty'
//     -> complete=true, missing=[]
//
// (6b) condition:'new', ทุกช่องครบตาม min ยกเว้น warranty_check count=0
//     -> warranty_check: required=true (condition='new'), count=0 -> status='missing'
//     -> complete=false, missing=['รูปเช็คประกันตัวเครื่อง']
//
// (6c) flags.video_required:true, lock_test_video count=0 -> required=true -> status='missing'
//      -> missing includes 'คลิปเทสล็อกเครื่อง'
//      flags.video_required:true, lock_test_video count=1 -> status='ok' -> ไม่อยู่ใน missing
//
// (6d) [regression guard] flags={credit_history_found:false} (ไม่มี key video_required เลย เหมือนโค้ดเก่าก่อน Wave1)
//      ทุกช่องครบยกเว้น lock_test_video count=0 -> lock_test_video required=false
//      -> status='optional_empty' -> complete=true, missing=[] เหมือนพฤติกรรมก่อนเพิ่มช่องนี้ทุกประการ
//
// (6e) [purgedAt ยังนับว่าช่องครบ] ทุกช่องครบตาม min, lock_test_video: files มี purgedAt ตั้งค่า, flags.video_required:true
//      -> count=1 (ไม่ถูกกรองออกเพราะ purgedAt ไม่ใช่ deletedAt) -> status='ok' -> complete=true
//
// (6f) [deletedAt ไม่นับ] เหมือน (6e) แต่ไฟล์มี deletedAt แทน purgedAt, flags.video_required:true
//      -> count=0 (ถูกกรองออก) -> status='missing' -> complete=false, missing=['คลิปเทสล็อกเครื่อง']
//
// isGated:
// (7) gateFrom=null -> false เสมอ ไม่ว่า createdAt จะเป็นอะไร
// (8) gateFrom='2026-09-08', contract.createdAt=undefined -> false (ข้อมูลเก่า)
// (9) gateFrom='2026-09-08', contract.createdAt='2026-09-08T10:00:00Z' -> true (slice 0,10 เท่ากัน = gated)
// (10) gateFrom='2026-09-08', contract.createdAt='2026-09-01' -> false (ก่อน cutoff)
//
// isMediaTracked:
// (10b) createdAt=undefined/null/'' -> false (ข้อมูลเก่าไม่มี timestamp)
// (10c) createdAt='2026-09-08T09:00:00Z' -> true (เท่ากับ MEDIA_TRACK_FROM = gated)
// (10d) createdAt='2026-06-16' (เก่ากว่า) -> false
// (10e) createdAt='2026-09-09' (ใหม่กว่า) -> true
//
// checkImageFile:
// (11) mime:'application/pdf' -> accept:false, warnings:[{code:'not_image', message:'ไฟล์นี้ไม่ใช่รูปภาพ'}]
// (12) mime:'image/jpeg', width:600, height:400, bytes:100000
//      sameContractHashes: new Set(), otherContractMatch: null
//      -> accept:true, warnings:[{code:'too_small', message:'รูปมีความละเอียดต่ำ อาจอ่านรายละเอียดไม่ชัด'}]
// (13) bytes:16_000_000 -> accept:false, warnings:[{code:'too_large', message:'ไฟล์ใหญ่เกิน 15 MB'}]
// (14) sha256:'abc' in sameContractHashes -> accept:true,
//      warnings:[{code:'dup_same_contract', message:'รูปนี้เคยอัปในสัญญานี้แล้ว ระบบนับให้ 1 ครั้ง'}]
// (15) otherContractMatch:{contractNo:'CT-000045', customerName:'สมชาย ใจดี'}
//      -> accept:true, warnings:[{code:'dup_other_contract', message:'รูปนี้เคยใช้กับสัญญา CT-000045 (สม***)'}]
// (16) image/jpeg 1600x1600, bytes:300000, ไม่ซ้ำ -> accept:true, warnings:[]
//
// missingSummary:
// (17) evaluation จาก trace (1) -> 'ยังส่งไม่ได้ ขาด: รูปรอบตัวเครื่อง (มี 3/5)'
// (18) missing รวม 2 ช่อง (1 partial + 1 missing เต็มๆ) ->
//      'ยังส่งไม่ได้ ขาด: รูปรอบตัวเครื่อง (มี 3/5), เอกสารสัญญา' (missing เต็มไม่มี count ต่อท้าย)
// (19) ไม่มีอะไรขาด -> ''
//
// sniffImageMime:
// (20) [0xFF,0xD8,0xFF,0xE0,...] -> 'image/jpeg'
// (21) [0x89,0x50,0x4E,0x47,...] -> 'image/png'
// (22) 'RIFF....WEBP' bytes -> 'image/webp'
// (23) offset4 'ftyp' + brand 'heic' -> 'image/heic'
// (24) ไม่ตรงอะไรเลย -> null
//
// sniffVideoMime:
// (24b) offset4 'ftyp' + brand 'isom' -> 'video/mp4'
// (24c) offset4 'ftyp' + brand 'mp42' -> 'video/mp4'
// (24d) offset4 'ftyp' + brand 'qt  ' (มีช่องว่าง 2 ตัวท้าย brand) -> 'video/quicktime'
// (24e) offset4 'ftyp' + brand 'heic' -> null (ต้องไม่ถูกมองเป็นวิดีโอ กันชนกับ sniffImageMime)
// (24f) offset4 'ftyp' + brand 'heix'/'hevc'/'mif1' -> null เช่นกัน (ครบทุก HEIC brand ที่ sniffImageMime รู้จัก)
// (24g) sniffImageMime กับ bytes ที่มี ftyp+brand 'isom' (mp4) -> null (ต้องไม่ถูกมองเป็นรูป กันชนอีกทาง)
// (24h) bytes.length < 12 -> null (กัน out-of-range)
// (24i) [0xFF,0xD8,0xFF] (jpeg header) -> sniffVideoMime -> null (offset4 ไม่ใช่ ftyp)
//
// checkVideoFile:
// (24j) sniffedMime:null (จำลองไฟล์ .mov ปลอมที่จริงเป็น zip) -> accept:false, error บอกใช้คลิปจากไอโฟน/LINE
// (24k) sniffedMime:'video/mp4', size:10*1024*1024, ไม่ส่ง maxBytes (พอดี default 10 MB) -> accept:true (เช็ค > ไม่ใช่ >=)
// (24l) sniffedMime:'video/mp4', size:10*1024*1024+1, ไม่ส่ง maxBytes -> accept:false, error 'คลิปใหญ่เกิน 10 MB ...'
// (24m) sniffedMime:'video/quicktime', size:1000 -> accept:true
// (24m2) sniffedMime:'video/mp4', size:5*1024*1024+1, maxBytes:5*1024*1024 -> accept:false, error 'คลิปใหญ่เกิน 5 MB ...' (เพดานกำหนดเอง)
// (24m3) sniffedMime:'video/mp4', size:20*1024*1024, maxBytes:20*1024*1024 (พอดีเพดานที่ส่งมา) -> accept:true
//
// emailBudget (ไม่ส่ง opts — ใช้ default ใหม่ 16 MB / 30 ไฟล์):
// (24n) files:[{bytes:5000000},{bytes:5000000}] -> totalBytes:10000000, fileCount:2, ok:true, reasonTh:null
// (24o) files:[{bytes:8*1024*1024},{bytes:9*1024*1024}] -> totalBytes:17825792 เกิน 16*1024*1024=16777216 -> overBytes:true, ok:false
//      reasonTh: 'ไฟล์แนบรวมใหญ่เกิน 16 MB ลบรูปที่ไม่จำเป็นออกก่อนส่ง'
// (24p) files:[{bytes:8*1024*1024},{bytes:9*1024*1024},{bytes:1000,purgedAt:'2026-10-01'}]
//      -> ไฟล์ purged ไม่นับ bytes -> totalBytes:17825792 (เท่า 24o) -> overBytes:true (พิสูจน์ purged ไม่กระทบยอด)
// (24q) 31 ไฟล์ bytes:1 ไฟล์ละ -> fileCount:31 เกิน default 30 -> overFiles:true, ok:false
//      reasonTh: 'ไฟล์แนบเกิน 30 ไฟล์ ลบรูปที่ไม่จำเป็นออกก่อนส่ง'
// (24r) files:[] -> totalBytes:0, fileCount:0, ok:true, reasonTh:null
//
// emailBudget (ส่ง opts เอง — เพดานกำหนดเอง แทน default):
// (24r2) files:[{bytes:11*1024*1024}], opts:{maxBytes:10*1024*1024,maxFiles:30}
//      -> totalBytes:11534336 เกิน 10*1024*1024=10485760 -> overBytes:true
//      reasonTh: 'ไฟล์แนบรวมใหญ่เกิน 10 MB ลบรูปที่ไม่จำเป็นออกก่อนส่ง'
// (24r3) files: 5 ไฟล์ bytes:100 ไฟล์ละ, opts:{maxFiles:3} -> fileCount:5 เกิน 3 -> overFiles:true
//      reasonTh: 'ไฟล์แนบเกิน 3 ไฟล์ ลบรูปที่ไม่จำเป็นออกก่อนส่ง'
// (24r4) files:[{bytes:20*1024*1024}], opts:{maxBytes:20*1024*1024} (พอดีเพดานที่กำหนดเอง) -> overBytes:false, ok:true
//
// mbToBytes:
// (24r5) mbToBytes(16, 999) === 16*1024*1024 === 16777216
// (24r6) mbToBytes(null, 999) === 999 (fallback)
// (24r7) mbToBytes(0, 999) === 999 (<=0 -> fallback)
// (24r8) mbToBytes(-1, 999) === 999 (ติดลบ -> fallback)
// (24r9) mbToBytes('abc' as any, 999) === 999 (ไม่ใช่ตัวเลข -> fallback)
// (24r10) mbToBytes(undefined, 12*1024*1024) === 12*1024*1024 (fallback)
//
// isVideoRequired:
// (24s) requiredFrom:null -> false (ไม่ว่า createdAt/emailSentAt จะเป็นอะไร)
// (24t) requiredFrom:'' หรือ 'ยังไม่ตั้ง' (ไม่ใช่รูปแบบวันที่) -> false
// (24u) requiredFrom:'2099-12-31' (ปิดใช้งานชั่วคราว), createdAt:'2026-09-11' -> false (ยังไม่ถึง 2099)
// (24v) requiredFrom:'2026-09-10', createdAt:'2026-09-11', emailSentAt:null -> true
// (24w) requiredFrom:'2026-09-10', createdAt:'2026-09-10T00:00:00Z' (ตรงวันเป๊ะ) -> true (>= ใช้ตัวเท่ากันด้วย)
// (24x) requiredFrom:'2026-09-10', createdAt:'2026-09-09T17:30:00Z' (เที่ยงคืนครึ่งเวลาไทย = ยังเป็นวันที่ 9 UTC) -> false
//      ข้อควรระวัง: ถ้าใครแก้ให้แปลงเป็นเวลาไทยก่อนเทียบ จะกลายเป็น true ผิด ต้องเทียบ UTC ตรงๆ ตามที่เก็บจริง
// (24y) requiredFrom:'2026-09-10', createdAt:'2026-09-11', emailSentAt:'2026-09-12T03:00:00Z' -> false (เคยส่งเมลแล้ว)
// (24z) requiredFrom:'2026-09-10', createdAt:undefined -> false (ข้อมูลเก่าไม่มี timestamp)
//
// buildMediaFlags:
// (25a) contract:{creditHistoryFound:true, createdAt:'2026-09-11', emailSentAt:null}, settings:{videoRequiredFrom:'2026-09-10'}
//      -> {credit_history_found:true, video_required:true}
// (25b) contract:{creditHistoryFound:false, createdAt:'2026-09-05', emailSentAt:null}, settings:{videoRequiredFrom:'2026-09-10'}
//      -> {credit_history_found:false, video_required:false} (สัญญาเก่าก่อน cutoff ตัวอย่างที่ 1 ใน 3 เคสที่ห้ามพฤติกรรมเปลี่ยน)
// (25c) contract:{creditHistoryFound:false, createdAt:'2026-09-11', emailSentAt:'2026-09-12'}, settings:{videoRequiredFrom:'2026-09-10'}
//      -> {credit_history_found:false, video_required:false} (ส่งเมลแล้ว ตัวอย่างที่ 2)
// (25d) contract:{creditHistoryFound:false, createdAt:'2026-09-11', emailSentAt:null}, settings:{videoRequiredFrom:'2099-12-31'}
//      -> {credit_history_found:false, video_required:false} (ระบบเพิ่งขึ้น ยังปิดอยู่ ตัวอย่างที่ 3)
//
// videoPurgeDueAt:
// (26a) videoPurgeDueAt('2026-09-13T10:00:00Z', 30) -> Date เท่ากับ '2026-10-13T10:00:00.000Z'
// (26b) videoPurgeDueAt('2026-01-15T00:00:00Z', 30) -> '2026-02-14T00:00:00.000Z' (ข้ามเดือนสั้น)
//
// mediaFilename / maskName:
// (27) mediaFilename('device_around', 1, 'jpg') === '03-device-1.jpg'
// (28) mediaFilename('credit_history_evidence', 2, 'png') === '13-1-credit-history-2.png'
// (29) mediaFilename('lock_test_video', 1, 'mp4') === '15-lock-test-video-1.mp4'
// (30) maskName('สมชาย ใจดี') === 'สม***'
//
// transferMediaSlots (feature "เปลี่ยนผู้ผ่อน" 2026-09-14; เพิ่ม credit_check เป็นช่องที่ 5 ตามคุณเตยเคาะเพิ่ม):
// (31) transferMediaSlots(1) -> 5 ช่อง key ตามลำดับ:
//      'transfer_1_id_card_front' (label 'หน้าบัตรประชาชนลูกค้า (ผู้ผ่อนคนใหม่)', min1,max1,required:'always')
//      'transfer_1_occupation_photo' (min1,max:null,required:'always')
//      'transfer_1_contract_docs' (min4,max:null,required:'always')
//      'transfer_1_id_copy_consent' (min1,max1,required:'always')
//      'transfer_1_credit_check' (label 'ผลเช็คเครดิต (ผู้ผ่อนคนใหม่)', min1,max1,required:'always')
//      sortOrder เรียง 11,12,13,14,15 (transferNo*10 + i+1)
// (32) transferMediaSlots(2) -> key ขึ้นต้น 'transfer_2_...' ทั้งหมด, sortOrder 21-25
//      (ไม่ชนกับรอบ 1 — namespaced ต่อรอบ)
// (33) evaluateTransferDocs(1, files) กับ files ครบตาม min ทุกช่อง (contract_docs 4 ไฟล์, ที่เหลือ 1 รวม credit_check)
//      -> complete:true, missing:[]
// (34) evaluateTransferDocs(1, files) กับ contract_docs มีแค่ 3 ไฟล์ (ขาด 1 จากขั้นต่ำ 4) ที่เหลือครบ
//      -> complete:false, missing:['เอกสารสัญญามีลายเซ็น (ผู้ผ่อนคนใหม่)'] (evaluateSlots.missing เป็น label ล้วน
//      ไม่มี "(มี X/Y)" ต่อท้าย — ถ้าต้องการ summary แบบมีตัวเลข ให้เรียก missingSummary({slots: result.slots}) ต่อเอง)
// (35) evaluateTransferDocs(1, []) (ไม่มีไฟล์เลย) -> complete:false, missing ครบ 5 ช่อง
//      ('หน้าบัตรประชาชนลูกค้า (ผู้ผ่อนคนใหม่)', 'รูปอาชีพ (ผู้ผ่อนคนใหม่)',
//       'เอกสารสัญญามีลายเซ็น (ผู้ผ่อนคนใหม่)', 'สำเนาบัตรฯ เซ็นยินยอม (ผู้ผ่อนคนใหม่)', 'ผลเช็คเครดิต (ผู้ผ่อนคนใหม่)')
// (36) [namespace ไม่ชนกัน] files ของรอบ 1 (slotKey='transfer_1_id_card_front') ไม่ถูกนับใน evaluateTransferDocs(2, files)
//      -> รอบ 2 ช่อง 'transfer_2_id_card_front' ยัง count:0 (คนละ key กันเด็ดขาด)
