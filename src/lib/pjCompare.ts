// ===== เทียบค่า PJ ↔ ค่าของเรา — decorate แผงตรวจก่อนส่งอีเมล (คอลัมน์ที่ 3) =====
// Pure function layer — ไม่มี side effect, ไม่อ่านนาฬิกา, ไม่ import db.ts/supabase, testable ด้วย tsx -e
// รับ ReviewFieldGroup[] จาก buildReviewFields() (reviewFields.ts) มา decorate เพิ่ม pjValue/pjCompare/pjNote
//
// 🔴 กฎเหล็ก (บทเรียนเลือดของโปรเจกต์นี้ — ห้ามฝ่าฝืน):
// ค่าที่ PJ ไม่มี (ไม่มีคีย์เลย) หรือ parse ไม่ได้ (รูปแบบอ่านไม่ออก) ต้องได้สถานะของตัวเอง
// ('no_pj' / 'pj_blank') ห้ามตกไปเป็น 'hard' (แดง) เด็ดขาด — เคยเตือนผิด 93 เคสรวดเพราะ parse พังแล้วนับว่า "ไม่ตรง"

import type { ReviewField, ReviewFieldGroup } from './reviewFields'
import type { PJContract } from './pjImport'
import { parsePJDate } from './pjImport'
import { baht, thaiDate } from './format'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PjCompareStatus = NonNullable<ReviewField['pjCompare']>

export interface PjFlagCounts {
  hard: number
  soft: number
  same: number // เพิ่มแยกออกมา (2026-09-12) — ใช้เป็นตัวหารร่วมกับ hard/soft
  noPj: number
  pjBlank: number // เพิ่มแยกออกมา (2026-09-12) — ห้ามเอาไปพองตัวหารเช่นกัน (เหมือน noPj)
  total: number // จำนวนช่องทั้งหมดที่ decorate แล้ว (same+soft+hard+no_pj+pj_blank) — ใช้เป็นตัวหารคำนวณสัดส่วน
}

// คีย์ snapshot ที่ PJContract (pjImport.ts) ยังไม่มีตรงตัว แต่ recon จากหน้า PJ สดวันนี้ (2026-09-12, เคส S00029PNQ037)
// พบว่า PJ มีข้อมูลจริง — รอน้องชีสเพิ่มคีย์นี้ตอน parse snapshot (ชื่อคีย์ที่คาดหวังไว้ล่าง — ยืนยันชื่อจริงกับน้องชีสอีกที):
//   device_price = การ์ด "ข้อมูลการชำระเงิน" ช่อง "ราคาสินค้า" (เงิน)
//   down_percent = การ์ดเดียวกัน ช่อง "จำนวนเงินดาวน์" ส่วนเปอร์เซ็นต์ในวงเล็บ เช่น 3,570.00 (30 percent) เอาแค่ 30
//                  (down_payment มีอยู่แล้วในคีย์เดิม คือส่วนจำนวนเงิน 3,570.00 คนละคีย์กัน อย่าปนกัน)
// ถ้า snapshot ที่ยิงจริงยังไม่มีคีย์นี้ (น้องชีสยังไม่เพิ่ม/ตั้งชื่อคนละอย่าง) กลไก readSnapshotKey เดิมข้างล่างจะตีเป็น
// 'no_pj' ให้อัตโนมัติ (เพราะ key in snapshot เป็น false) — ไฟล์นี้ไม่พังแม้ยังไม่ตรงคีย์กัน 100%
type ExtraSnapshotKey = 'device_price' | 'down_percent'
type SnapshotKey = keyof PJContract | ExtraSnapshotKey

/** snapshot ที่ได้จาก DB เป็น jsonb ตามชื่อคีย์ของ PJContract (pjImport.ts) รวมคีย์เพิ่มที่ยังไม่เข้า type หลัก (ดู ExtraSnapshotKey ด้านบน) — อาจไม่ครบทุกคีย์ (ข้อมูลเก่า/scrape บางส่วน) */
export type PjSnapshot = Partial<Record<SnapshotKey, string | boolean | null | undefined>>

// ---------------------------------------------------------------------------
// Normalizers — export แยกทุกตัว ให้เทสต์/เรียกใช้ซ้ำได้
// ---------------------------------------------------------------------------

/** ดึงเฉพาะตัวเลขจาก string แสดงผล (ตัด ฿, คอมมา, หน่วย, ช่องว่างทิ้งหมด) → null ถ้าไม่มีตัวเลขเหลือเลย */
export function extractDigits(display: string): number | null {
  const digits = display.replace(/[^\d]/g, '')
  if (digits === '') return null
  return parseInt(digits, 10)
}

/** parse ตัวเลขเงินจาก PJ แบบทนทาน (คอมมา/ทศนิยม) → null ถ้า parse ไม่ได้ (กันเคส "parse ไม่ได้" ไม่ให้กลายเป็น hard) */
export function normalizeMoney(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').trim()
  if (cleaned === '') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

/** เบอร์โทร: ตัดอักขระที่ไม่ใช่ตัวเลข, ^66 → 0, เทียบ 9 หลักท้าย */
export function normalizePhone(raw: string): string {
  let digits = raw.replace(/\D/g, '')
  if (digits.startsWith('66')) digits = '0' + digits.slice(2)
  return digits.slice(-9)
}

/** เลขบัตรประชาชน: ตัดอักขระที่ไม่ใช่ตัวเลข */
export function normalizeNationalId(raw: string): string {
  return raw.replace(/\D/g, '')
}

/** IMEI/SN: ตัดช่องว่าง/ขีด + uppercase */
export function normalizeImeiSn(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase()
}

// อักขระเว้นวรรค "ที่มองไม่เห็น" ที่พบได้จากก๊อปข้ามระบบ — NBSP / zero-width / BOM
const INVISIBLE_SPACE_RE = /[\s\u00A0\u200B\u200C\u200D\uFEFF]+/g
const NAME_PREFIX_RE = /^(นาย|นาง|นางสาว|น\.ส\.|ด\.ช\.|ด\.ญ\.|Mr\.?|Mrs\.?|Ms\.?)\s*/i

/**
 * ชื่อลูกค้า: trim → ยุบช่องว่างทุกชนิด(รวม NBSP/zero-width) → ตัดคำนำหน้า → ตัดช่องว่างที่เหลือทั้งหมด
 * ไม่ lowercase — ชื่อไทยไม่มีเคส ต่างตัวพิมพ์ในชื่ออังกฤษถือเป็นความต่างจริงที่ยังอยากเห็น (สเปกไม่ได้ขอ case-fold)
 */
export function normalizeName(raw: string): string {
  let s = raw.replace(INVISIBLE_SPACE_RE, ' ').trim()
  s = s.replace(NAME_PREFIX_RE, '')
  s = s.replace(INVISIBLE_SPACE_RE, '')
  return s
}

/** ข้อความอิสระ (รุ่น/ความจุ/สี/อาชีพ): lowercase, ตัด "iphone", normalize ความจุ (128 GB/128GB/128 → 128), ตัดช่องว่าง/วรรคตอนทั้งหมด */
export function normalizeFreeText(raw: string): string {
  let s = raw.toLowerCase()
  s = s.replace(/iphone/g, '')
  s = s.replace(/(\d+)\s*gb/g, '$1')
  s = s.replace(/[^\p{L}\p{N}]/gu, '')
  return s
}

// สภาพเครื่อง: เรา (types.ts DeviceCondition) เก็บค่าปิด 'new'|'used' แล้วแสดงผลเป็น "มือ 1"/"มือ 2" (conditionLabel)
// PJ เขียนเป็นคำไทยอิสระ ("มือสอง"/"มือหนึ่ง"/"ใหม่" ฯลฯ) — คนละภาษา/รูปแบบกับเราเป๊ะ
// ห้ามเอาไป compareFreeText ตรงๆ (จะขึ้นเหลือง soft มั่วทุกเคสทั้งระบบ เพราะข้อความไม่มีทางตรงกันเป็นตัวอักษร)
// ต้อง map ทั้ง 2 ฝั่งเป็นค่ากลาง 'new'|'used' ก่อนเทียบเสมอ — ดู normalizeCondition
const CONDITION_USED_ALIASES = new Set(['มือสอง', 'มือ2', 'มือที่สอง', 'secondhand', 'used', '2'])
const CONDITION_NEW_ALIASES = new Set(['มือหนึ่ง', 'มือ1', 'มือแรก', 'มือใหม่', 'ใหม่', 'new', '1'])

/** map ข้อความสภาพเครื่อง (ทั้งฝั่งเราและฝั่ง PJ) → ค่ากลาง 'new'|'used' — คืน null ถ้าไม่รู้จักคำนั้น (ห้ามเดา) */
export function normalizeCondition(raw: string): 'new' | 'used' | null {
  const s = raw.replace(INVISIBLE_SPACE_RE, '').toLowerCase()
  if (CONDITION_USED_ALIASES.has(s)) return 'used'
  if (CONDITION_NEW_ALIASES.has(s)) return 'new'
  return null
}

/** วันที่แสดงผลแบบ dd/mm/yyyy (ผลลัพธ์ของ thaiDate() ใน format.ts) → ISO yyyy-mm-dd, null ถ้ารูปแบบไม่ตรง */
export function isoFromDisplayDate(display: string): string | null {
  const m = display.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return null
  const [, d, mo, y] = m
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
}

/** วันที่ ISO yyyy-mm-dd → วันที่ในเดือน (1-31), null ถ้ารูปแบบไม่ตรง */
export function dayOfMonthFromIso(iso: string): number | null {
  const parts = iso.split('-')
  if (parts.length !== 3) return null
  const d = parseInt(parts[2], 10)
  return Number.isFinite(d) && d >= 1 && d <= 31 ? d : null
}

// ---------------------------------------------------------------------------
// Field-level compare — คืน patch ให้ merge เข้า ReviewField, หรือ null ถ้าไม่รองรับคีย์นี้
// ---------------------------------------------------------------------------

type Patch = Pick<ReviewField, 'pjValue' | 'pjCompare' | 'pjNote'>

function compareMoney(ourDisplay: string, pjRaw: string): Patch {
  const pjNumRaw = normalizeMoney(pjRaw)
  if (pjNumRaw === null) return { pjValue: pjRaw, pjCompare: 'pj_blank', pjNote: `รูปแบบอ่านไม่ได้: ${pjRaw}` }
  const pjNum = Math.round(pjNumRaw)
  const pjDisplay = `${baht(pjNum)} ฿`
  const ourNum = extractDigits(ourDisplay)
  if (ourNum === null) return { pjValue: pjDisplay, pjCompare: 'no_pj' } // defensive — ไม่ควรเกิดจริง (ค่าเราเป็นตัวเลขเสมอ)
  const diff = Math.abs(ourNum - pjNum)
  if (diff === 0) return { pjValue: pjDisplay, pjCompare: 'same' }
  if (diff <= 2) return { pjValue: pjDisplay, pjCompare: 'same', pjNote: `ต่าง ${diff} บาท (ปัดเศษ)` }
  return { pjValue: pjDisplay, pjCompare: 'hard' }
}

function compareInt(ourDisplay: string, pjRaw: string): Patch {
  const pjNum = extractDigits(pjRaw)
  if (pjNum === null) return { pjValue: pjRaw, pjCompare: 'pj_blank', pjNote: `รูปแบบอ่านไม่ได้: ${pjRaw}` }
  const ourNum = extractDigits(ourDisplay)
  if (ourNum === null) return { pjValue: `${pjNum}`, pjCompare: 'no_pj' }
  if (ourNum === pjNum) return { pjValue: `${pjNum}`, pjCompare: 'same' }
  return { pjValue: `${pjNum}`, pjCompare: 'hard' }
}

/**
 * dueDay ไม่มีคีย์ตรงตัวใน PJ (PJ เก็บ first_due_date เป็นวันที่เต็ม ไม่ใช่ "วันที่ N ของทุกเดือน")
 * ใช้วิธีอ่านวันที่ในเดือนจาก first_due_date ตรง ๆ (ไม่ใช่คำนวณย้อนจากสูตร/ฟิลด์อื่น — อ่านค่าที่มีอยู่แล้วเฉย ๆ)
 * ยืนยันจากเคสจริง S00029PNQ037 แล้ว (recon 2026-09-12): PJ วันที่เริ่มต้นการผ่อนชำระ=12-10-2026, เรา due_day=12 → ตรงกันพอดี
 */
function compareDueDay(ourDisplay: string, pjRawDate: string): Patch {
  const pjIso = parsePJDate(pjRawDate)
  if (pjIso === null) {
    return { pjValue: pjRawDate, pjCompare: 'pj_blank', pjNote: `วันครบกำหนดงวดแรกอ่านไม่ได้: ${pjRawDate}` }
  }
  const pjDay = dayOfMonthFromIso(pjIso)
  const ourDay = extractDigits(ourDisplay)
  if (pjDay === null || ourDay === null) {
    return { pjValue: thaiDate(pjIso), pjCompare: 'pj_blank', pjNote: 'วันครบกำหนดงวดแรกอ่านไม่ได้' }
  }
  const note = `จาก PJ วันครบกำหนดงวดแรก ${thaiDate(pjIso)}`
  if (ourDay === pjDay) return { pjValue: `${pjDay}`, pjCompare: 'same', pjNote: note }
  return { pjValue: `${pjDay}`, pjCompare: 'hard', pjNote: note }
}

function compareNationalId(ourDisplay: string, pjRaw: string): Patch {
  const ourDigits = normalizeNationalId(ourDisplay)
  const pjDigits = normalizeNationalId(pjRaw)
  if (pjDigits === '') return { pjValue: pjRaw, pjCompare: 'pj_blank' }
  if (ourDigits === pjDigits) return { pjValue: pjDigits, pjCompare: 'same' }
  return { pjValue: pjDigits, pjCompare: 'hard' }
}

function compareImeiSn(ourDisplay: string, pjRaw: string): Patch {
  const ourNorm = normalizeImeiSn(ourDisplay)
  const pjNorm = normalizeImeiSn(pjRaw)
  if (pjNorm === '') return { pjValue: pjRaw, pjCompare: 'pj_blank' }
  if (ourNorm === pjNorm) return { pjValue: pjRaw, pjCompare: 'same' }
  return { pjValue: pjRaw, pjCompare: 'hard' }
}

function compareName(ourDisplay: string, pjRaw: string): Patch {
  const ourNorm = normalizeName(ourDisplay)
  const pjNorm = normalizeName(pjRaw)
  if (pjNorm === '') return { pjValue: pjRaw, pjCompare: 'pj_blank' }
  if (ourNorm === pjNorm) return { pjValue: pjRaw, pjCompare: 'same' }
  return { pjValue: pjRaw, pjCompare: 'hard' }
}

function compareFreeText(ourDisplay: string, pjRaw: string): Patch {
  const ourNorm = normalizeFreeText(ourDisplay)
  const pjNorm = normalizeFreeText(pjRaw)
  if (pjNorm === '') return { pjValue: pjRaw, pjCompare: 'pj_blank' }
  if (ourNorm === pjNorm) return { pjValue: pjRaw, pjCompare: 'same' }
  return { pjValue: pjRaw, pjCompare: 'soft' } // ข้อความอิสระ = เตือนเหลืองเท่านั้น ห้ามแดงเด็ดขาด
}

/**
 * สภาพเครื่อง: map ค่าเป็นกลาง ('new'/'used') ก่อนเทียบเสมอ (ดู normalizeCondition ด้านบน) —
 * ห้ามเทียบข้อความ "มือสอง" กับ "มือ 2" ตรงๆ เพราะคนละภาษา จะขึ้นเหลืองมั่วทุกเคสทั้งระบบ
 * ถ้า map ไม่ออกฝั่งใดฝั่งหนึ่ง (คำที่ไม่รู้จักทั้ง 2 รายการ alias) → pj_blank (ไม่เดา ไม่ขึ้นเหลือง/แดงมั่ว)
 */
function compareCondition(ourDisplay: string, pjRaw: string): Patch {
  const pjNorm = normalizeCondition(pjRaw)
  const ourNorm = normalizeCondition(ourDisplay)
  if (pjNorm === null || ourNorm === null) {
    return { pjValue: pjRaw, pjCompare: 'pj_blank', pjNote: `อ่านค่าสภาพเครื่องไม่ออก: ${pjRaw}` }
  }
  const pjLabel = pjNorm === 'used' ? 'มือ 2' : 'มือ 1'
  if (ourNorm === pjNorm) return { pjValue: pjLabel, pjCompare: 'same' }
  return { pjValue: pjLabel, pjCompare: 'soft' } // สภาพเครื่องยังนับเป็นข้อความอธิบาย ไม่ใช่ตัวเลข — ต่างจริงก็แค่เตือนเหลือง ไม่แดง
}

function compareDate(ourDisplay: string, pjRaw: string): Patch {
  const pjIso = parsePJDate(pjRaw)
  if (pjIso === null) return { pjValue: pjRaw, pjCompare: 'pj_blank', pjNote: `รูปแบบวันที่อ่านไม่ได้: ${pjRaw}` }
  const pjDisplay = thaiDate(pjIso)
  const ourIso = isoFromDisplayDate(ourDisplay)
  if (ourIso === null) return { pjValue: pjDisplay, pjCompare: 'no_pj' } // defensive
  if (ourIso === pjIso) return { pjValue: pjDisplay, pjCompare: 'same' }
  return { pjValue: pjDisplay, pjCompare: 'hard' }
}

// ---------------------------------------------------------------------------
// FIELD_MAP — ReviewField.key → วิธีเทียบกับ PJ
// คีย์ที่ "ไม่อยู่ในตารางนี้" (เช่น contractNo, invNo, shopCode, docFee, afterDown, ...) = นอก scope เฟสนี้
// ปล่อยผ่าน ไม่ decorate เลย (ไม่ใช่ no_pj) — เก็บไว้เผื่อเฟสหน้า อย่าเดาเพิ่มเอง
// ---------------------------------------------------------------------------

type Kind = 'money' | 'int' | 'due_day' | 'nationalId' | 'imeiSn' | 'name' | 'freeText' | 'condition' | 'date' | 'always_no_pj'

interface FieldMapping {
  kind: Kind
  snapshotKey: SnapshotKey | null // null = PJ ไม่มีคีย์นี้เลยเชิงโครงสร้าง (ไม่ใช่แค่เคสนี้ว่าง) → no_pj เสมอ
}

const FIELD_MAP: Record<string, FieldMapping> = {
// recon 2026-09-12 จากหน้า PJ สด (เคส S00029PNQ037 อารญา นาสิงห์) แก้ 3 จุดจากแผนเดิม:
// 1) devicePrice: PJ การ์ด "ข้อมูลการชำระเงิน" ช่อง "ราคาสินค้า" = 11,900.00 ตรงกับ device_price เป๊ะ
//    เดิมเข้าใจผิดว่า PJ ไม่มี (always_no_pj) — เปลี่ยนเป็นเทียบจริงด้วยเกณฑ์เงิน
// 2) downPercent: PJ ช่อง "จำนวนเงินดาวน์" เขียนเป็น 3,570.00 พร้อมเปอร์เซ็นต์ในวงเล็บต่อท้าย (เช่น 30) อยู่บรรทัดเดียวกันจริง
//    เปลี่ยนเป็นเทียบจริง (int ตรงๆ ไม่ใช่คำนวณย้อนจากยอดเงิน/ราคาเครื่อง — เลี่ยงความไม่ตรงปลอมจากการปัดเศษ)
//    snapshot key ใหม่ทั้งคู่ 'device_price'/'down_percent' ยังไม่อยู่ใน PJContract (pjImport.ts) — ดู ExtraSnapshotKey ต้นไฟล์
//    ถ้าน้องชีสยังไม่เพิ่มคีย์นี้ในของจริง readSnapshotKey จะตีเป็น no_pj อัตโนมัติ ไม่พัง (ดูกลไกด้านล่าง)
// 3) commissionPercent ยืนยันแล้วจากเคสจริงว่า PJ ไม่เก็บค่านี้เลย (ไม่มีช่องค่าคอมในการ์ดไหนของ PJ) — คงเป็น no_pj ตามเดิม
// 4) condition: PJ เขียนไทยอิสระ (มือสอง) ส่วนเราโชว์ "มือ 2" — ห้ามเทียบข้อความตรงๆ (คนละรูปแบบ จะขึ้นเหลืองมั่วทุกเคส)
//    เปลี่ยน kind เป็น 'condition' ใหม่ที่ map ค่ากลางก่อนเทียบ (ดู normalizeCondition/compareCondition ด้านบน)
// 5) model→device_name ยืนยันแล้วจากเคสจริง: PJ ชื่อ=iPhone 13 ตรงกับ model ของเราเป๊ะ (ไม่เปลี่ยน kind)
  devicePrice: { kind: 'money', snapshotKey: 'device_price' },
  financeAmount: { kind: 'money', snapshotKey: 'finance_amount' },
  monthlyPayment: { kind: 'money', snapshotKey: 'monthly_payment' },
  downAmount: { kind: 'money', snapshotKey: 'down_payment' },
  termMonths: { kind: 'int', snapshotKey: 'term_months' },
  dueDay: { kind: 'due_day', snapshotKey: 'first_due_date' },
  downPercent: { kind: 'int', snapshotKey: 'down_percent' },
  commissionPercent: { kind: 'always_no_pj', snapshotKey: null },
  nationalId: { kind: 'nationalId', snapshotKey: 'national_id' },
  imei: { kind: 'imeiSn', snapshotKey: 'imei' },
  sn: { kind: 'imeiSn', snapshotKey: 'sn' },
  customerName: { kind: 'name', snapshotKey: 'customer_name' },
  model: { kind: 'freeText', snapshotKey: 'device_name' },
  storage: { kind: 'freeText', snapshotKey: 'device_storage' },
  color: { kind: 'freeText', snapshotKey: 'device_color' },
  condition: { kind: 'condition', snapshotKey: 'condition' },
  occupation: { kind: 'freeText', snapshotKey: 'occupation' },
  transactionDate: { kind: 'date', snapshotKey: 'trade_date' },
}

/** อ่านค่าดิบจาก snapshot ตามคีย์ — แยก "ไม่มีคีย์" (no_pj) ออกจาก "มีคีย์แต่ว่าง" (pj_blank) ให้ชัดเจน */
function readSnapshotKey(snapshot: PjSnapshot, key: SnapshotKey): { present: boolean; raw: string } {
  if (!(key in snapshot)) return { present: false, raw: '' }
  const v = snapshot[key]
  if (v === null || v === undefined) return { present: true, raw: '' }
  const raw = String(v).trim()
  return { present: true, raw }
}

function compareField(field: ReviewField, snapshot: PjSnapshot): Patch | null {
  const mapping = FIELD_MAP[field.key]
  if (!mapping) return null

  if (mapping.kind === 'always_no_pj' || mapping.snapshotKey === null) {
    return { pjValue: '', pjCompare: 'no_pj' }
  }

  const { present, raw } = readSnapshotKey(snapshot, mapping.snapshotKey)
  if (!present) return { pjValue: '', pjCompare: 'no_pj' }
  if (raw === '') return { pjValue: '', pjCompare: 'pj_blank' }

  switch (mapping.kind) {
    case 'money':
      return compareMoney(field.value, raw)
    case 'int':
      return compareInt(field.value, raw)
    case 'due_day':
      return compareDueDay(field.value, raw)
    case 'nationalId':
      return compareNationalId(field.value, raw)
    case 'imeiSn':
      return compareImeiSn(field.value, raw)
    case 'name':
      return compareName(field.value, raw)
    case 'freeText':
      return compareFreeText(field.value, raw)
    case 'condition':
      return compareCondition(field.value, raw)
    case 'date':
      return compareDate(field.value, raw)
  }
}

// ---------------------------------------------------------------------------
// เบอร์โทร 3 ช่อง — เทียบเป็นกลุ่ม (ไม่ใช่ทีละคีย์) เพราะต้องเช็คว่า "สลับช่อง" ระหว่างกันหรือไม่
// ---------------------------------------------------------------------------

const PHONE_KEYS = ['phone', 'phoneAlt1', 'phoneAlt2'] as const
type PhoneKey = (typeof PHONE_KEYS)[number]
const PHONE_SNAPSHOT_KEY: Record<PhoneKey, keyof PJContract> = {
  phone: 'phone',
  phoneAlt1: 'phone_alt1',
  phoneAlt2: 'phone_alt2',
}

function comparePhoneGroup(fields: ReviewField[], snapshot: PjSnapshot): Partial<Record<PhoneKey, Patch>> {
  const ourNorm: Record<PhoneKey, string> = { phone: '', phoneAlt1: '', phoneAlt2: '' }
  for (const k of PHONE_KEYS) {
    const f = fields.find((x) => x.key === k)
    ourNorm[k] = normalizePhone(f?.value ?? '')
  }

  const results: Partial<Record<PhoneKey, Patch>> = {}
  for (const k of PHONE_KEYS) {
    const { present, raw } = readSnapshotKey(snapshot, PHONE_SNAPSHOT_KEY[k])
    if (!present) {
      results[k] = { pjValue: '', pjCompare: 'no_pj' }
      continue
    }
    if (raw === '') {
      results[k] = { pjValue: '', pjCompare: 'pj_blank' }
      continue
    }
    const pjNorm = normalizePhone(raw)
    if (pjNorm === '') {
      results[k] = { pjValue: raw, pjCompare: 'pj_blank', pjNote: `รูปแบบอ่านไม่ได้: ${raw}` }
      continue
    }
    if (ourNorm[k] === pjNorm) {
      results[k] = { pjValue: raw, pjCompare: 'same' }
      continue
    }
    const swappedWith = PHONE_KEYS.find((other) => other !== k && ourNorm[other] !== '' && ourNorm[other] === pjNorm)
    if (swappedWith) {
      results[k] = { pjValue: raw, pjCompare: 'same', pjNote: 'เบอร์เดียวกัน แต่สลับช่องกับ PJ' }
    } else {
      results[k] = { pjValue: raw, pjCompare: 'hard' }
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * applyPjComparison — decorate ReviewFieldGroup[] ที่ buildReviewFields() คืนมา ด้วยค่าจาก PJ (คอลัมน์ที่ 3)
 * snapshot = null → คืน groups เดิมทุกประการ (ไม่ decorate อะไรเลย แม้แต่ no_pj) — ยังไม่มีข้อมูล PJ ให้เทียบ
 * ไม่แก้ groups เดิม (คืน array/object ใหม่) — ปลอดภัยต่อ reference เดิมที่ผู้เรียกอาจถืออยู่
 */
export function applyPjComparison(groups: ReviewFieldGroup[], snapshot: PjSnapshot | null): ReviewFieldGroup[] {
  if (snapshot === null) return groups

  return groups.map((group) => {
    const hasPhoneFields = group.fields.some((f) => (PHONE_KEYS as readonly string[]).includes(f.key))
    const phoneResults = hasPhoneFields ? comparePhoneGroup(group.fields, snapshot) : null

    return {
      ...group,
      fields: group.fields.map((field) => {
        if (phoneResults && field.key in phoneResults) {
          return { ...field, ...phoneResults[field.key as PhoneKey] }
        }
        const patch = compareField(field, snapshot)
        return patch ? { ...field, ...patch } : field
      }),
    }
  })
}

/**
 * countPjFlags — นับสัดส่วน pjCompare ทุกช่องที่ decorate แล้ว (ใช้เช็คก่อน deploy: ยิง 30 เคสจริงแล้วดู hard/total)
 * total = ทุกช่องที่มี pjCompare ตั้งค่าแล้ว (same+soft+hard+no_pj+pj_blank) — ไม่ใช่แค่ที่ต่างกัน
 * 2026-09-12: แยก same/pjBlank ออกมาเป็น field ของตัวเอง — ผู้เรียกคำนวณสัดส่วน hard/(hard+soft+same) เองได้
 */
export function countPjFlags(groups: ReviewFieldGroup[]): PjFlagCounts {
  let hard = 0
  let soft = 0
  let same = 0
  let noPj = 0
  let pjBlank = 0
  let total = 0
  for (const g of groups) {
    for (const f of g.fields) {
      if (!f.pjCompare) continue
      total++
      if (f.pjCompare === 'hard') hard++
      else if (f.pjCompare === 'soft') soft++
      else if (f.pjCompare === 'same') same++
      else if (f.pjCompare === 'no_pj') noPj++
      else if (f.pjCompare === 'pj_blank') pjBlank++
    }
  }
  return { hard, soft, same, noPj, pjBlank, total }
}

// ===========================================================================
// Trace tests (verify ด้วย tsx -e — repo ไม่มี vitest, ตาม convention reviewFields.ts)
// ===========================================================================
//
// สมมติ ReviewField (value = จัดรูปแบบเสร็จแล้วเหมือนที่ buildReviewFields() คืนจริง):
//   financeAmount: value="13,930 ฿"  monthlyPayment: value="1,500 ฿"  termMonths: value="12 เดือน"
//   dueDay: value="6"  nationalId: value="1234567890123"  imei: value="123456789012345"
//   customerName: value="สมชาย ใจดี"  model: value="iPhone 13 Pro"  storage: value="128GB"
//   transactionDate: value="06/04/2026" (ผลลัพธ์ของ thaiDate() บน ISO "2026-04-06")
//   phone: value="0812345678"  phoneAlt1: value="0898765432"  phoneAlt2: value=""
//
// (1) เงินต่าง 0/1/2/3 บาท — compareMoney("13,930 ฿", pjRaw)
//     pjRaw="13930"   → diff=0 → same (ไม่มี pjNote)
//     pjRaw="13929"   → diff=1 → same, pjNote ต่าง 1 บาท (ปัดเศษ)
//     pjRaw="13928"   → diff=2 → same, pjNote ต่าง 2 บาท (ปัดเศษ)
//     pjRaw="13927"   → diff=3 → hard (เกิน 2 บาท = ต่างจริง ไม่ใช่ปัดเศษ)
//
// (2) เบอร์สลับช่อง — ours: phone="0812345678", phoneAlt1="0898765432", phoneAlt2=""
//     PJ: phone="0898765432", phone_alt1="0812345678" (สลับกับเรา)
//     normalizePhone("0898765432")="898765432" ไม่ตรง ourNorm.phone="812345678"
//     แต่ตรงกับ ourNorm.phoneAlt1="898765432" → swappedWith='phoneAlt1'
//     ผล: phone = same, pjNote "เบอร์เดียวกัน แต่สลับช่องกับ PJ" (สมมาตรกันทั้งคู่)
//
// (3) ชื่อเว้นวรรคต่าง — our="สมชาย ใจดี" (เว้นวรรค 1 ช่อง), PJ="สมชาย  ใจดี" (เว้นวรรค 2 ช่อง)
//     normalizeName ยุบช่องว่างทุกชนิดแล้วตัดออกหมด → ทั้งคู่ได้ "สมชายใจดี" → เท่ากัน → same
//
// (4) ชื่อมีคำนำหน้าต่าง — our="สมชาย ใจดี", PJ="นายสมชาย ใจดี"
//     normalizeName(PJ): ยุบช่องว่าง → ตัด prefix "นาย" → ตัดช่องว่างที่เหลือ → "สมชายใจดี"
//     normalizeName(our)="สมชายใจดี" → เท่ากัน → same (คำนำหน้าไม่ใช่ความต่างจริง)
//
// (5) ความจุเขียนต่างรูปแบบ — our="128GB" → normalizeFreeText="128"
//     PJ="128 GB" → normalizeFreeText="128" → same
//     PJ="128"    → normalizeFreeText="128" → same
//     PJ="256GB"  → normalizeFreeText="256" ไม่ตรง "128" → soft (ความจุต่างจริง แต่ห้ามเป็น hard)
//
// (6) snapshot เป็น null — applyPjComparison(groups, null) คืน reference เดิม (groups เดิมเป๊ะ) ไม่ decorate อะไรเลย
//     ทุก field.pjCompare ยัง undefined เหมือนตอนออกจาก buildReviewFields() ตรง ๆ
//
// (7) คีย์ไม่มี vs คีย์ว่าง — สมมติ snapshot = { finance_amount: '13930', term_months: '' } (ไม่มีคีย์ 'monthly_payment' เลย)
//     financeAmount  → present=true, raw='13930' → compareMoney ปกติ
//     monthlyPayment → present=false             → no_pj   (โครงสร้างไม่มีคีย์)
//     termMonths     → present=true, raw=''      → pj_blank (มีคีย์แต่ค่าว่าง)
//     สองสถานะนี้ต้องไม่ปนกัน — no_pj ไม่ใช่ pj_blank เสมอ
//
// (8) always_no_pj — commissionPercent ได้ pjValue='' pjCompare='no_pj' เสมอ ไม่ว่า snapshot จะมีคีย์อะไรก็ตาม
//     (ยืนยันจากเคสจริงแล้วว่า PJ ไม่เก็บค่าคอมจริง ๆ)
//
// (9) countPjFlags — สมมติ 20 ช่อง decorate แล้ว: same=15, soft=2, hard=1, no_pj=1, pj_blank=1
//     คืน hard=1 soft=2 same=15 noPj=1 pjBlank=1 total=20
//     ตัวหารที่ถูกต้องของ "สัดส่วนต่างจริง" = hard/(hard+soft+same) = 1/18 ประมาณ 5.6% (ไม่ใช่ hard/total=1/20 — total พองด้วย no_pj/pj_blank)
//
// (10) devicePrice เทียบเป็นเงินแล้ว (ก่อนหน้านี้ always_no_pj) — compareMoney("11,900 ฿", "11900.00") diff=0 → same
//
// (11) downPercent เทียบเป็น int แล้ว (ก่อนหน้านี้ always_no_pj) — compareInt("30 %", "30") ทั้งคู่ได้ 30 → same
//      ถ้า snapshot ไม่มีคีย์ 'down_percent' เลย (น้องชีสยังไม่เพิ่ม) → readSnapshotKey คืน present=false → no_pj (ไม่พัง ไม่ใช่ hard)
//
// (12) condition map ก่อนเทียบ — our value="มือ 2" (conditionLabel('used')), PJ raw="มือสอง"
//      normalizeCondition("มือ 2") ตัดช่องว่าง → "มือ2" → อยู่ใน CONDITION_USED_ALIASES → 'used'
//      normalizeCondition("มือสอง") อยู่ใน CONDITION_USED_ALIASES ตรงตัว → 'used'
//      ourNorm เท่ากับ pjNorm เท่ากับ 'used' → pjValue='มือ 2' pjCompare='same'
//      ถ้า PJ raw="ใหม่" (ไม่ตรง used) → pjNorm='new' ไม่ตรง ourNorm='used' → pjValue='มือ 1' pjCompare='soft' (เตือนเหลือง ไม่แดง)
//      ถ้า PJ raw="สภาพดี" (map ไม่ออกทั้งคู่) → pjNorm=null → pj_blank, pjNote 'อ่านค่าสภาพเครื่องไม่ออก: สภาพดี'
//
// (13) เคสจริง S00029PNQ037 (อารญา นาสิงห์) — recon จากหน้า PJ สด 2026-09-12 คาดหวัง "ไม่มี hard เลยสักช่อง":
//      PJ: ราคา 11,900.00 · ดาวน์ 3,570.00 (30 percent) · เงินกู้ 8,330.00 · เงินผ่อน 1,530.00 · งวด 12
//          วันเริ่มผ่อน 12-10-2026 · วันดาวน์ 12-09-2026 · ชื่อสินค้า iPhone 13 · สี ชมพู · ความจุ 128 GB
//          สภาพ มือสอง · SN NM7P2D4D5X
//      เรา: device_price 11900 · down_percent 30 · finance_amount 8330 · monthly_payment 1530 · term_months 12
//           due_day 12 · transaction_date 2026-09-12 · model "iPhone 13" · color ชมพู · storage "128GB"
//           condition "used" · sn NM7P2D4D5X
//
//      devicePrice     compareMoney("11,900 ฿","11900.00")      diff=0         same
//      downPercent     compareInt("30 %","30")                  30 เท่ากับ 30   same
//      financeAmount   compareMoney("8,330 ฿","8330.00")        diff=0         same
//      monthlyPayment  compareMoney("1,530 ฿","1530.00")        diff=0         same
//      termMonths      compareInt("12 เดือน","12")               12 เท่ากับ 12   same
//      dueDay          compareDueDay("12","12-10-2026")          pjDay 12 เท่ากับ ourDay 12  same
//      downAmount      compareMoney("3,570 ฿","3570.00")        diff=0         same
//      model           compareFreeText("iPhone 13","iPhone 13") ตัด iphone ทั้งคู่เหลือ 13  same
//      color           compareFreeText("ชมพู","ชมพู")            เท่ากัน         same
//      storage         compareFreeText("128GB","128 GB")        normalize เหลือ 128 ทั้งคู่  same
//      condition       compareCondition("มือ 2","มือสอง")       used เท่ากับ used  same
//      sn              compareImeiSn("NM7P2D4D5X","NM7P2D4D5X") เท่ากัน         same
//      transactionDate compareDate("12/09/2026","12-09-2026")   ISO ตรงกัน      same
//      commissionPercent always_no_pj (ยืนยันแล้วว่า PJ ไม่มีจริง)              no_pj
//      ผลลัพธ์ตรงตามคาด: ไม่มี hard เลยสักช่องในเคสนี้
