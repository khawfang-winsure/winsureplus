// ===== คำขอลงพื้นที่ (pure functions) =====
// ป้ายเตือนเท่านั้น ไม่ระงับการโทร — แอดมินรวบส่งทีมข้างนอกเป็นรอบ แล้วลงผลพบตัว/ไม่พบตัว
import { ADDRESS_KIND_LABEL, addressOneLine, isAddressEmpty, type AddressKind, type CustomerAddress } from './letters'

export type FieldVisitReason = 'unreachable_all_phones' | 'answered_uncooperative' | 'defiant' | 'other'
export type FieldVisitStatus = 'requested' | 'dispatched' | 'found' | 'not_found' | 'closed' | 'cancelled'
export type FieldVisitTone = 'amber' | 'blue' | 'green' | 'red' | 'gray'

export const FIELD_VISIT_REASON_LABEL: Record<FieldVisitReason, string> = {
  unreachable_all_phones: 'ติดต่อไม่ได้ทั้ง 3 เบอร์',
  answered_uncooperative: 'รับสายแต่ไม่ให้ความร่วมมือ',
  defiant: 'ลูกค้าท้าทาย/ดื้อ ไม่เกรงกฎหมาย',
  other: 'อื่นๆ',
}

export const FIELD_VISIT_STATUS_LABEL: Record<FieldVisitStatus, string> = {
  requested: 'ขอลงพื้นที่ · รอรอบ',
  dispatched: 'กำลังลงพื้นที่',
  found: 'ลงพื้นที่: พบตัว',
  not_found: 'ลงพื้นที่: ไม่พบตัว',
  closed: 'ปิดเรื่องลงพื้นที่',
  cancelled: 'ยกเลิกคำขอลงพื้นที่',
}

// ---------- ผลลงพื้นที่ 7 แบบ (status found/not_found = กลุ่ม, result_code = รายละเอียด) ----------
export type FieldVisitResultCode =
  | 'paid'
  | 'promised'
  | 'device_returned'
  | 'uncooperative'
  | 'relative_met'
  | 'not_found'
  | 'wrong_address'

export const FIELD_VISIT_RESULT_CODES: FieldVisitResultCode[] = [
  'paid',
  'promised',
  'device_returned',
  'uncooperative',
  'relative_met',
  'not_found',
  'wrong_address',
]

export const FIELD_VISIT_RESULT_LABEL: Record<FieldVisitResultCode, string> = {
  paid: 'กลับมาจ่ายแล้ว',
  promised: 'นัดจ่าย',
  device_returned: 'คืนเครื่อง / ได้เครื่องคืน',
  uncooperative: 'พบแต่ไม่ให้ความร่วมมือ',
  relative_met: 'พบญาติ/คนในบ้าน (ไม่พบตัวลูกค้า)',
  not_found: 'ไม่พบใครเลย / ย้ายออก',
  wrong_address: 'ที่อยู่ไม่ถูกต้อง',
}

// 4 ตัวแรก = found, 3 ตัวหลัง = not_found
export const FIELD_VISIT_RESULT_GROUP: Record<FieldVisitResultCode, 'found' | 'not_found'> = {
  paid: 'found',
  promised: 'found',
  device_returned: 'found',
  uncooperative: 'found',
  relative_met: 'not_found',
  not_found: 'not_found',
  wrong_address: 'not_found',
}

const FIELD_VISIT_RESULT_TONE: Record<FieldVisitResultCode, FieldVisitTone> = {
  paid: 'green',
  promised: 'green',
  device_returned: 'green',
  uncooperative: 'red',
  relative_met: 'amber',
  not_found: 'amber',
  wrong_address: 'red',
}

export const RELATIVE_MET_LEGAL_HINT =
  'ตาม พ.ร.บ.ทวงถามหนี้ 2558 ห้ามแจ้งญาติ/บุคคลอื่นว่าลูกค้าค้างหนี้ ถามได้แค่ช่องทางติดต่อลูกค้า — จดว่าคุยกับใคร เกี่ยวข้องอย่างไร ได้ข้อมูลอะไร'
export const PAID_NO_MONEY_HINT = 'ลงผลนี้เป็นป้ายสถานะเท่านั้น ไม่บันทึกยอดเงิน — ยอดเงินเข้าทาง PJ/รับชำระตามปกติ'

/** 'YYYY-MM-DD' → 'dd/mm/yyyy' (พ.ศ.); รูปแบบผิด → คืนค่าเดิม */
function thaiShortDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd)
  if (!m) return ymd
  return `${m[3]}/${m[2]}/${Number(m[1]) + 543}`
}

/** ป้ายผล: มี code → ชื่อละเอียด (นัดจ่ายต่อท้ายวัน); ไม่มี code → 'พบตัว'/'ไม่พบตัว' (ข้อมูลเก่า); อื่นๆ → ป้ายสถานะเดิม */
export function fieldVisitResultLabel(
  status: FieldVisitStatus,
  code: FieldVisitResultCode | null,
  promiseDate?: string | null,
): string {
  if (code) {
    const base = FIELD_VISIT_RESULT_LABEL[code]
    return code === 'promised' && promiseDate ? `${base} (นัด ${thaiShortDate(promiseDate)})` : base
  }
  if (status === 'found') return 'พบตัว'
  if (status === 'not_found') return 'ไม่พบตัว'
  return FIELD_VISIT_STATUS_LABEL[status]
}

/** คืน null ถ้าผ่าน, ไม่ผ่าน → ข้อความไทย (todayBangkok = 'YYYY-MM-DD') */
export function validateFieldVisitOutcome(
  code: FieldVisitResultCode | null | undefined,
  note: string | null | undefined,
  promiseDate: string | null | undefined,
  todayBangkok: string,
): string | null {
  if (!code) return 'เลือกผลการลงพื้นที่ก่อน'
  if (code === 'promised') {
    if (!promiseDate) return 'ผลนัดจ่ายต้องระบุวันนัด'
    if (promiseDate < todayBangkok) return 'วันนัดจ่ายต้องไม่เป็นวันที่ผ่านมาแล้ว'
  }
  if (code === 'relative_met' && !(note ?? '').trim()) {
    return 'ผลพบญาติ/คนในบ้านต้องจดหมายเหตุ (คุยกับใคร เกี่ยวข้องอย่างไร ได้ข้อมูลอะไร)'
  }
  return null
}

export function fieldVisitStatusTone(
  status: FieldVisitStatus,
  resultCode?: FieldVisitResultCode | null,
): FieldVisitTone {
  if ((status === 'found' || status === 'not_found') && resultCode) return FIELD_VISIT_RESULT_TONE[resultCode]
  switch (status) {
    case 'requested':
      return 'amber'
    case 'dispatched':
      return 'blue'
    case 'found':
      return 'green'
    case 'not_found':
      return 'red'
    default:
      return 'gray'
  }
}

export function isFieldVisitOpen(status: FieldVisitStatus): boolean {
  return status === 'requested' || status === 'dispatched'
}

const TRANSITIONS: Record<FieldVisitStatus, FieldVisitStatus[]> = {
  requested: ['dispatched', 'cancelled', 'closed'],
  dispatched: ['found', 'not_found', 'closed'],
  found: ['closed'],
  not_found: ['closed'],
  closed: [],
  cancelled: [],
}

export function canTransition(from: FieldVisitStatus, to: FieldVisitStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

// ---------- วัน/เวลาแบบไทย (UTC+7 ไม่มี DST) ----------
const BKK_OFFSET_MS = 7 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** เลขวันของปฏิทินไทย (นับจาก epoch) ของ instant นั้น */
function bangkokDayNumber(ms: number): number {
  return Math.floor((ms + BKK_OFFSET_MS) / DAY_MS)
}

function bangkokParts(ms: number): { y: number; m: number; d: number } {
  const dt = new Date(ms + BKK_OFFSET_MS)
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** จำนวนวันที่รอ นับตามปฏิทินไทย (ข้ามเที่ยงคืนไทย = +1 วัน) ไม่ติดลบ; ค่าวันที่ผิด → 0 */
export function waitingDays(requestedAt: string, today: Date): number {
  const req = new Date(requestedAt).getTime()
  const now = today.getTime()
  if (Number.isNaN(req) || Number.isNaN(now)) return 0
  return Math.max(0, bangkokDayNumber(now) - bangkokDayNumber(req))
}

export function fieldVisitBadgeText(
  info: {
    status: FieldVisitStatus
    requestedAt: string
    dispatchedAt?: string | null
    resultCode?: FieldVisitResultCode | null
    promiseDate?: string | null
  },
  today: Date,
): string {
  if ((info.status === 'found' || info.status === 'not_found') && info.resultCode) {
    return `ลงพื้นที่: ${fieldVisitResultLabel(info.status, info.resultCode, info.promiseDate)}`
  }
  const base = FIELD_VISIT_STATUS_LABEL[info.status]
  if (info.status === 'requested') return `${base} (${waitingDays(info.requestedAt, today)} วัน)`
  if (info.status === 'dispatched' && info.dispatchedAt) {
    const t = new Date(info.dispatchedAt).getTime()
    if (!Number.isNaN(t)) {
      const p = bangkokParts(t)
      return `${base} (ส่งเมื่อ ${pad2(p.d)}/${pad2(p.m)})`
    }
  }
  return base
}

/** เช่น "รอบ 15 พ.ย. 69" (ปี พ.ศ. 2 หลัก ตามเวลาไทย) */
export function defaultRoundLabel(today: Date): string {
  const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
  const p = bangkokParts(today.getTime())
  return `รอบ ${p.d} ${MONTHS[p.m - 1]} ${pad2((p.y + 543) % 100)}`
}

/** คืน null ถ้าผ่าน, ไม่ผ่าน → ข้อความไทย */
export function validateFieldVisitRequest(
  reason: FieldVisitReason | null | undefined,
  note: string | null | undefined,
): string | null {
  if (!reason) return 'เลือกเหตุผลที่ขอลงพื้นที่ก่อน'
  if (reason === 'other' && !(note ?? '').trim()) return 'เหตุผลอื่นๆ ต้องใส่หมายเหตุ'
  return null
}

// ---------- ใบลงพื้นที่ ----------
// ข้อมูล 1 รายสำหรับลงพื้นที่ (ส่งมาจากหน้าส่งจดหมายผ่าน sessionStorage)
export interface FieldItem {
  customerName: string
  contractNo: string
  shopName: string
  daysLate: number
  amount: number
  device: string
  phones: string[]
  province: string // โซน (ใช้จัดกลุ่ม)
  addresses: { label: string; line: string }[] // ที่อยู่ทุกชุดที่มี
}

export interface FieldItemInput {
  customerName: string
  contractNo: string
  shopName: string
  daysLate: number
  amount: number
  model?: string
  storage?: string
  phones: (string | null | undefined)[]
  addresses: Partial<Record<AddressKind, CustomerAddress>>
}

const FIELD_KINDS: AddressKind[] = ['current', 'id_card', 'work', 'registry']
const NO_PROVINCE = '(ไม่ระบุจังหวัด)'

export function toFieldItem(input: FieldItemInput): FieldItem {
  const a = input.addresses
  const province =
    a.current?.province || a.id_card?.province || a.work?.province || a.registry?.province || NO_PROVINCE
  return {
    customerName: input.customerName,
    contractNo: input.contractNo,
    shopName: input.shopName,
    daysLate: input.daysLate,
    amount: input.amount,
    device: [input.model, input.storage].filter(Boolean).join(' '),
    phones: input.phones.filter(Boolean) as string[],
    province,
    addresses: FIELD_KINDS.filter((k) => !isAddressEmpty(a[k])).map((k) => ({
      label: ADDRESS_KIND_LABEL[k],
      line: addressOneLine(a[k]),
    })),
  }
}

/** ข้อความคัดลอกส่ง LINE/แชท จัดกลุ่มตามจังหวัด (output ตรงกับ Letters.copyField เดิม) */
export function buildFieldCopyText(items: FieldItem[]): string {
  const byProv = new Map<string, FieldItem[]>()
  for (const it of items) {
    const arr = byProv.get(it.province)
    if (arr) arr.push(it)
    else byProv.set(it.province, [it])
  }
  const money = (n: number) => n.toLocaleString('th-TH')
  let text = ''
  for (const [prov, list] of byProv) {
    text += `=== โซน: จังหวัด${prov} (${list.length} ราย) ===\n`
    list.forEach((it, i) => {
      text += `${i + 1}. ${it.customerName} | สัญญา ${it.contractNo} | ${it.shopName}\n`
      text += `   เครื่อง: ${it.device || '—'} | โทร: ${it.phones.join(' / ') || '—'}\n`
      text += `   ล่าช้า ${it.daysLate} วัน | ค้าง ${money(it.amount)} บาท\n`
      it.addresses.forEach((ad) => (text += `   - ${ad.label}: ${ad.line}\n`))
      text += '\n'
    })
  }
  return text.trim()
}

/* ===== Trace tests (โปรเจกต์ไม่มี vitest — ตรวจด้วยมือ) =====
1) ไม่มีที่อยู่ → province "(ไม่ระบุจังหวัด)", addresses []
   toFieldItem({customerName:'ก',contractNo:'C1',shopName:'S',daysLate:5,amount:1000,phones:[null,'081'],addresses:{}})
   → province '(ไม่ระบุจังหวัด)', phones ['081'], device ''
2) canTransition: dispatched -> cancelled = false ; requested -> cancelled = true
   found -> closed = true ; closed -> requested = false
3) waitingDays ข้ามเที่ยงคืนไทย:
   requestedAt 2026-11-12T16:59:00Z (23:59 ไทย 12/11), today 2026-11-12T17:01:00Z (00:01 ไทย 13/11)
   -> 1 (แม้ห่างกัน 2 นาที)
   requestedAt 2026-11-12T10:00:00Z, today 2026-11-15T10:00:00Z -> 3
4) fieldVisitBadgeText status requested, requestedAt 2026-11-12T10:00:00Z, today 15/11
   -> "ขอลงพื้นที่ · รอรอบ (3 วัน)"
   status dispatched, dispatchedAt 2026-11-17T20:00:00Z (03:00 ไทย 18/11) -> "กำลังลงพื้นที่ (ส่งเมื่อ 18/11)"
5) defaultRoundLabel(2026-11-15T05:00:00Z) -> "รอบ 15 พ.ย. 69"
6) validateFieldVisitRequest(other, 2 spaces) -> "เหตุผลอื่นๆ ต้องใส่หมายเหตุ" ; (defiant, empty) -> null
7) fieldVisitResultLabel: 7 code -> label ตาม FIELD_VISIT_RESULT_LABEL
   ('found',null) -> 'พบตัว' ; ('not_found',null) -> 'ไม่พบตัว'
   ('found','promised','2026-11-20') -> 'นัดจ่าย (นัด 20/11/2569)'
8) validateFieldVisitOutcome('promised','', '2026-11-16','2026-11-17') -> error ; ('promised','', '2026-11-17', same) -> null
   ('relative_met','   ',null,today) -> error ; ('paid','',null,today) -> null
9) fieldVisitStatusTone('found','uncooperative') -> 'red' ; ('not_found','relative_met') -> 'amber' ; ('found',null) -> 'green'
*/
