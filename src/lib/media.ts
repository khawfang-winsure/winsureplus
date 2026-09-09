// ===== รูป/เอกสารแนบสัญญา (contract_media) — Phase 1 pure-function layer =====
// Owner-approved source: plan-media-attachments.html §3, §4, §5-ข, §10 (by แบม, 2026-09-08)
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
// Default 15 slots (seed → app_settings.media_slots, admin-editable ภายหลัง)
// Video ตัดออกโดยตั้งใจ (เจ้าของ: ไม่เก็บวิดีโอในเว็บ)
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
  flags: { credit_history_found: boolean },
): boolean {
  if (rule === 'always') return true
  if (rule === 'never') return false
  if (rule.when === 'condition') return contract.condition === rule.equals
  return (flags as Record<string, boolean>)[rule.name] === true
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
  flags: { credit_history_found: boolean },
  files: MediaFile[],
): { complete: boolean; slots: SlotEvaluation[]; missing: string[] } {
  const sorted = [...slots].sort((a, b) => a.sortOrder - b.sortOrder)

  const evaluations: SlotEvaluation[] = sorted.map((slot) => {
    const slotFiles = files.filter((f) => f.slotKey === slot.key)
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
// ต่อไปนี้อ้างอิง DEFAULT_MEDIA_SLOTS ทั้ง 15 ช่อง เว้นแต่ระบุเป็นอย่างอื่น
//
// evaluateSlots:
// (1) condition:'new', origin:'th', flags:{credit_history_found:false}
//     ทุกช่อง 1 ไฟล์ ยกเว้น device_around 3 ไฟล์, contract_docs 4 ไฟล์
//     -> device_around: required=true, min=5, count=3 -> status='partial'
//     -> credit_history_evidence: required=false (flag=false) -> 'optional_empty'
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
//     condition:'used' (box_back, warranty_check ไม่ต้องมี), flags false (credit_history_evidence ไม่ต้องมี)
//     -> complete=true, missing=[]
//
// (6b) condition:'new', ทุกช่องครบตาม min ยกเว้น warranty_check count=0
//     -> warranty_check: required=true (condition='new'), count=0 -> status='missing'
//     -> complete=false, missing=['รูปเช็คประกันตัวเครื่อง']
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
// mediaFilename / maskName:
// (25) mediaFilename('device_around', 1, 'jpg') === '03-device-1.jpg'
// (26) mediaFilename('credit_history_evidence', 2, 'png') === '13-1-credit-history-2.png'
// (27) maskName('สมชาย ใจดี') === 'สม***'
