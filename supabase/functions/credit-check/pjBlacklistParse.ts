// ===== แปลง HTML ผลค้นบัญชีดำ PJ (/manager/check-blacklist) เป็นข้อมูลโครงสร้าง — ฟังก์ชันบริสุทธิ์ =====
// v2 (2026-09-28, หลัง live E2E จริงเจอบั๊ก) — เขียนใหม่ทั้งไฟล์ ดู
// scratchpad/pj-blacklist-real-html.md (โครง HTML จริง anonymized) — เดิม parser v1 ทำ normalize
// ทั้งหน้าเป็นข้อความแบนๆ ก่อน parse (ดู git history) ทำให้ field ของการ์ดถัดไป/ nested div ไหล "เปื้อน"
// เข้าด้วยกัน (เช่น model ปนท้ายด้วย IMEI, next_due_date ปนคำว่า "N days overdue") — v2 เปลี่ยนมา parse
// per `.customer-card` ด้วย class selector จริง (regex สแกนหา div ตาม class + นับความลึกวงเล็บเอง แทนที่จะ
// flatten ทั้งหน้าเป็น text ก่อน) ไม่มี DOM parser ภายนอก (Deno edge runtime ไม่มี DOMParser ในตัว และไม่
// อยากเพิ่ม dependency ใหม่แค่สำหรับไฟล์นี้ไฟล์เดียว)
//
// ⚠️ v1 เคย deploy จริงแล้วพบบั๊กจาก live E2E (ดูรายงานที่ส่งพร้อมงานนี้): not-found คืน 'error' เพราะ
// marker จริงเป็น Swal.fire(...) escape แบบ \uXXXX ไม่ใช่ข้อความไทยตรงๆ, found-card field ผสมกันเพราะ
// full-page normalize — v2 นี้แก้ทั้งสองจุดแล้ว แต่ "ยังไม่เคย" re-test กับ PJ จริงอีกรอบ (ครีมจะ deploy +
// ยิง live E2E ซ้ำเอง) — fixture ในไฟล์ test คู่กันเป็น HTML สังเคราะห์เลียนโครงจริงเท่านั้น ไม่ใช่ HTML จริง

export interface PjBlacklistRawHit {
  invoiceNo: string
  statusLabel: string
  customerName: string
  shopName: string
  shopContact: string
  brand: string
  model: string
  imeiLast4: string // (v2) "IMEI / SERIAL" ดิบคั่นด้วย " / " — ตัดเหลือ 4 ตัวท้ายของแต่ละฝั่งแล้วต่อกลับด้วย " / "
  downPaymentDate: string
  nextDueDate: string // (v2) วันที่ล้วนๆ แล้ว — ไม่ปนคำว่า "N days overdue" อีกต่อไป (แยกไป overdueDays)
  installmentsTotal: number | null
  installmentsPaid: number | null
  installmentsOverdue: number | null
  overdueDays: number | null // (v2 ใหม่) จำนวนวันค้างจาก ".payment-status" เช่น "540 days overdue"
  totalAmount: number | null // (v2 ใหม่) ยอดเงินรวม (บาท) จาก info-item "จำนวนงวดทั้งหมด" ที่ PJ ตั้งชื่อ label ผิด (ไม่ใช่จำนวนงวด — ดู doc จริง)
}

export type PjBlacklistParseResult = { found: false } | { found: true; hits: PjBlacklistRawHit[] }

export class PjBlacklistParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PjBlacklistParseError'
  }
}

const FOUND_TITLE_MARKER = 'ผลการค้นหาบัญชีดำ'
// "ไม่พบข้อมูล" ตัวจริง (JS/JSON \uXXXX escape ที่ปรากฏเป็นตัวอักษรดิบในซอร์ส Swal.fire(...) ของ PJ) —
// เขียนแบบ double-backslash ในซอร์สไฟล์นี้เจตนา (กัน TS/JS ตีความ \u เป็น unicode escape ตอน compile จน
// กลายเป็นอักษรไทยจริงไปซะเอง — เราต้องการสตริง "แบบดิบ" ที่มี \uXXXX เป็นตัวอักษรตรงๆ ไปเทียบกับ HTML)
const NOT_FOUND_MARKER_ESCAPED =
  '\\u0e44\\u0e21\\u0e48\\u0e1e\\u0e1a\\u0e02\\u0e49\\u0e2d\\u0e21\\u0e39\\u0e25'
const NOT_FOUND_MARKER_PLAIN = 'ไม่พบข้อมูล' // เผื่อ PJ เปลี่ยนมาไม่ escape ในอนาคต — เช็คทั้งสองแบบ

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** หา index ของจุดสิ้นสุด opening tag `<div ... class="...CLASSNAME...">` ตัวแรกที่เจอ (จับ class เป็น
 *  token คั่นด้วยช่องว่างจริง ไม่ใช่ substring — กัน "info-value" ไปแมตช์ "info-value-extra" มั่วๆ) */
function findDivOpenTagEnd(html: string, className: string, fromIndex: number): number | null {
  const cls = escapeRegExp(className)
  const re = new RegExp(`<div\\b[^>]*\\bclass=["'](?:[^"']*\\s)?${cls}(?:\\s[^"']*)?["'][^>]*>`, 'i')
  const slice = html.slice(fromIndex)
  const m = slice.match(re)
  if (!m || m.index === undefined) return null
  return fromIndex + m.index + m[0].length
}

/** จาก contentStart (ตำแหน่งทันทีหลัง "<div ...>") หา `</div>` ที่จับคู่กันจริงโดยนับความลึกของ div ที่
 *  ซ้อนอยู่ข้างใน (กัน bug เดิมของ v1 ที่ใช้ `</div>` ตัวแรกที่เจอ ซึ่งพังทันทีถ้าเนื้อในมี div ซ้อน เช่น
 *  "กำหนดชำระครั้งถัดไป" ที่มี <div class="mb-1"> อยู่ข้างในอีกที) คืน null ถ้าหา closing ไม่เจอ */
function extractBalancedDiv(html: string, contentStart: number): { content: string; end: number } | null {
  let depth = 1
  const tagRe = /<div\b[^>]*>|<\/div\s*>/gi
  tagRe.lastIndex = contentStart
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(html))) {
    if (/^<\/div/i.test(m[0])) {
      depth--
      if (depth === 0) return { content: html.slice(contentStart, m.index), end: m.index + m[0].length }
    } else {
      depth++
    }
  }
  return null
}

function findFirstDivByClass(html: string, className: string, fromIndex = 0): { content: string; end: number } | null {
  const contentStart = findDivOpenTagEnd(html, className, fromIndex)
  if (contentStart === null) return null
  return extractBalancedDiv(html, contentStart)
}

/** หาทุก div ที่มี class ตรงกัน (ไม่ซ้อนกันเอง — เดินหน้าต่อจากจุดจบของอันก่อนหน้าเสมอ) ใช้กับ
 *  .customer-card / .info-item / .installment-stat ที่เป็น sibling ต่อกันในระดับเดียวกัน */
function findAllDivsByClass(html: string, className: string): string[] {
  const results: string[] = []
  let idx = 0
  for (;;) {
    const found = findFirstDivByClass(html, className, idx)
    if (!found) break
    results.push(found.content)
    idx = found.end
  }
  return results
}

function stripTagsToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function toIntOrNull(s: string): number | null {
  const m = s.replace(/,/g, '').match(/-?\d+/)
  return m ? Number(m[0]) : null
}

/** .info-item ต่อ 1 label/value คู่ (label มาก่อน value ใน DOM) — คืน Map<label ล้วน, value ดิบ (อาจมี
 *  nested tag เช่น กำหนดชำระครั้งถัดไป)> ใช้ label ข้อความล้วนเป็นคีย์เพราะเสถียรกว่าเดา class/ตำแหน่ง */
function buildInfoMap(cardHtml: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const block of findAllDivsByClass(cardHtml, 'info-item')) {
    const labelBlock = findFirstDivByClass(block, 'info-label', 0)
    const valueBlock = findFirstDivByClass(block, 'info-value', 0)
    if (!labelBlock || !valueBlock) continue
    map.set(stripTagsToText(labelBlock.content), valueBlock.content)
  }
  return map
}

/** .installment-stat ต่อ 1 stat — ตาม doc "value ข้อความมาก่อน label ใน DOM" (ตรงข้ามกับ info-item) และ
 *  ชื่อ class ของ stat ตัวที่ 3 (ค้างชำระ) ไม่ชัวร์ 100% ว่าคืออะไร — จึงไม่ยึด class suffix เลย ใช้
 *  ข้อความ .stat-label เป็นคีย์แทน (เสถียรกว่า, ไม่ขึ้นกับ PJ ตั้งชื่อ class อะไร) */
function buildStatMap(cardHtml: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const block of findAllDivsByClass(cardHtml, 'installment-stat')) {
    const valueBlock = findFirstDivByClass(block, 'stat-value', 0)
    const labelBlock = findFirstDivByClass(block, 'stat-label', 0)
    if (!valueBlock || !labelBlock) continue
    map.set(stripTagsToText(labelBlock.content), stripTagsToText(valueBlock.content))
  }
  return map
}

function extractBadgeText(cardHtml: string): string {
  const m = cardHtml.match(/<(span|div)\b[^>]*\bclass=["'](?:[^"']*\s)?badge(?:\s[^"']*)?["'][^>]*>([\s\S]*?)<\/\1>/i)
  return m ? stripTagsToText(m[2]) : ''
}

function parseCard(cardHtml: string): PjBlacklistRawHit {
  const invMatch = cardHtml.match(/INV-[0-9A-Za-z-]+/)
  const invoiceNo = invMatch ? invMatch[0] : ''
  const statusLabel = extractBadgeText(cardHtml)

  const infoMap = buildInfoMap(cardHtml)
  const statMap = buildStatMap(cardHtml)

  const getInfo = (label: string): string => infoMap.get(label) ?? ''

  const customerName = stripTagsToText(getInfo('ชื่อลูกค้า'))
  const brand = stripTagsToText(getInfo('ยี่ห้อสินค้า'))
  const model = stripTagsToText(getInfo('รุ่นสินค้า'))
  const shopName = stripTagsToText(getInfo('ชื่อร้าน'))
  const shopContact = stripTagsToText(getInfo('ติดต่อร้าน'))
  const downPaymentDate = stripTagsToText(getInfo('วันที่จ่ายเงินดาวน์'))

  // label จริงเขียน "IMEI/Serial" (ตัวพิมพ์ผสม) — เทียบแบบ case-insensitive กันสะกดคลาดเคลื่อน
  let imeiRaw = ''
  for (const [label, value] of infoMap) {
    if (label.replace(/\s+/g, '').toLowerCase() === 'imei/serial') {
      imeiRaw = stripTagsToText(value)
      break
    }
  }
  const imeiLast4 = imeiRaw
    ? imeiRaw
        .split('/')
        .map((p) => p.trim().slice(-4))
        .filter(Boolean)
        .join(' / ')
    : ''

  // "กำหนดชำระครั้งถัดไป" ค่าเป็น nested: <div class="mb-1">DATE</div><span class="payment-status ...">N days overdue</span>
  // — แยกวันที่ล้วนๆ ออกจากจำนวนวันค้าง (v1 บั๊ก: ปนกันเป็นสตริงเดียว)
  const nextDueRaw = getInfo('กำหนดชำระครั้งถัดไป')
  const nextDueDateMatch = nextDueRaw.match(/\d{1,2}\/\d{1,2}\/\d{4}/)
  const nextDueDate = nextDueDateMatch ? nextDueDateMatch[0] : stripTagsToText(nextDueRaw)
  const overdueMatch = nextDueRaw.match(/(\d+)\s*days?\s*overdue/i)
  const overdueDays = overdueMatch ? Number(overdueMatch[1]) : null

  // "จำนวนงวดทั้งหมด" ใน info-item เป็น label ที่ PJ ตั้งชื่อผิด — ค่าจริงคือยอดเงินรวม เช่น "38,728 THB"
  // (v1 บั๊ก: เอาเลขนี้ไปใช้เป็น installmentsTotal ทั้งที่ไม่ใช่ — ตัวเลขงวดจริงอยู่ที่ .installment-stat
  // คนละที่กันเลย ต้องแยก label เดียวกันคนละ scope ออกจากกันให้ถูก)
  const totalAmount = toIntOrNull(getInfo('จำนวนงวดทั้งหมด'))

  const installmentsTotal = toIntOrNull(statMap.get('จำนวนงวดทั้งหมด') ?? '')
  const installmentsPaid = toIntOrNull(statMap.get('จำนวนงวดที่ชำระแล้ว') ?? '')
  const installmentsOverdue = toIntOrNull(statMap.get('จำนวนงวดที่ค้างชำระ') ?? '')

  return {
    invoiceNo,
    statusLabel,
    customerName,
    shopName,
    shopContact,
    brand,
    model,
    imeiLast4,
    downPaymentDate,
    nextDueDate,
    installmentsTotal,
    installmentsPaid,
    installmentsOverdue,
    overdueDays,
    totalAmount,
  }
}

/**
 * parse หน้าผล /manager/check-blacklist ของ PJ (found หรือ not-found)
 * ลำดับเช็ค (ตาม doc จริง): 1) มี .customer-card อย่างน้อย 1 ใบ หรือมีหัวข้อผลค้นหา → found (parse การ์ด)
 * 2) ไม่งั้นเช็ค marker "ไม่พบข้อมูล" (ทั้งข้อความไทยตรงๆ และ \uXXXX escape ที่ PJ ใช้จริง) → not found
 * 3) ไม่เจอทั้งคู่ → throw ให้ผู้เรียก (pjBlacklistSearch.ts) ตั้ง pj_blacklist_status='error' เสมอ
 */
export function parsePjBlacklistHtml(html: string): PjBlacklistParseResult {
  const cardBlocks = findAllDivsByClass(html, 'customer-card')
  if (cardBlocks.length > 0 || html.includes(FOUND_TITLE_MARKER)) {
    return { found: true, hits: cardBlocks.map(parseCard) }
  }

  if (html.includes(NOT_FOUND_MARKER_PLAIN) || html.includes(NOT_FOUND_MARKER_ESCAPED)) {
    return { found: false }
  }

  throw new PjBlacklistParseError(
    'รูปแบบหน้าเว็บ PJ เปลี่ยนไป (ไม่พบทั้ง .customer-card, หัวข้อผลค้นหา, และ marker ไม่พบข้อมูล)',
  )
}
