// ===== ตัวสร้างข้อความ "สรุปยอดโอน" และ "อีเมล" จากข้อมูลสัญญา =====
// รูปแบบอ้างอิงจาก สรุปข้อมูล.txt — ปรับข้อความที่เดียว มีผลทุกที่
import { calcSummary } from './calc'
import { baht, thaiDate } from './format'
import type { Contract, Shop } from './types'

const LINE = '⸻'

/** หัวข้อมูลร้าน (ใช้ทั้งสรุปเดี่ยวและรวมหลายร้าน) */
function shopHeader(shop: Shop): string {
  return [
    `รหัสร้านค้า: ${shop.code} ${shop.name}`,
    `ธนาคาร : ${shop.bank}`,
    `เลขบัญชี : ${shop.accountNo}`,
    `ชื่อบัญชี : ${shop.accountName}`,
  ].join('\n')
}

/** บล็อก "▶️ รายการที่ N" ของ 1 เครื่อง + คืนค่ายอดสุทธิไว้รวม */
function itemBlock(c: Contract, index: number): { text: string; net: number } {
  const s = calcSummary(c.devicePrice, c.downPercent, c.commissionPercent, c.docFee)
  const text = [
    `▶️ รายการที่ ${index}`,
    `หมายเลขสัญญา: ${c.contractNo}`,
    `หมายเลขใบแจ้งหนี้(INV) : ${c.invNo}`,
    `ชื่อลูกค้า : ${c.customerName}`,
    `สินทรัพย์รุ่น : ${c.model} ${c.storage}`,
    `หมายเลขSN: ${c.sn}`,
    `ราคาตัวเครื่อง: ${baht(c.devicePrice)}`,
    `ยอดตัวเครื่องจริงหลังหักดาวน์ ${baht(s.afterDown)} บาท`,
    `ค่าคอมมิชชั่น ${baht(s.commission)} บาท`,
    `ค่าเอกสาร ${baht(s.docFee)} บาท`,
    `สุทธิ ${baht(s.net)} บาท`,
  ].join('\n')
  return { text, net: s.net }
}

/** สรุปยอดของ "หนึ่งร้าน" (อาจมีหลายเครื่อง) */
export function buildShopSummary(shop: Shop, items: Contract[], dateISO: string): string {
  const blocks = items.map((c, i) => itemBlock(c, i + 1))
  const total = blocks.reduce((sum, b) => sum + b.net, 0)
  return [
    `วันที่: ${thaiDate(dateISO)}`,
    shopHeader(shop),
    '',
    `รายละเอียดรายการโอนค่าซื้อเครื่อง iPhone ${items.length} รายการ`,
    '',
    LINE,
    blocks.map((b) => b.text).join(`\n${LINE}\n\n`),
    LINE,
    `ยอดโอนสุทธิรวมทั้งสิ้น: ${baht(total)} บาท`,
  ].join('\n')
}

/** สรุปยอดเดี่ยว (1 เครื่อง 1 ร้าน) — ใช้ในหน้าเพิ่มสัญญา */
export function buildSingleSummary(c: Contract, shop: Shop, dateISO: string): string {
  return buildShopSummary(shop, [c], dateISO)
}

/** สรุปยอดรวมหลายร้านในวันเดียว (ใช้หน้า "รอสรุปยอด") */
export function buildBulkSummary(
  groups: { shop: Shop; items: Contract[] }[],
  dateISO: string,
): string {
  const parts: string[] = [`วันที่: ${thaiDate(dateISO)}`, `ทั้งหมด ${groups.length} ร้านค้า`, '']
  let grand = 0
  groups.forEach((g, gi) => {
    const blocks = g.items.map((c, i) => itemBlock(c, i + 1))
    const total = blocks.reduce((sum, b) => sum + b.net, 0)
    grand += total
    parts.push(
      `ร้านที่ ${gi + 1}`,
      shopHeader(g.shop),
      '',
      `รายละเอียดรายการโอนค่าซื้อเครื่อง iPhone ${g.items.length} รายการ`,
      '',
      LINE,
      blocks.map((b) => b.text).join(`\n${LINE}\n\n`),
      LINE,
      `ยอดโอนสุทธิรวมทั้งสิ้น: ${baht(total)} บาท`,
      '',
      '———————————————',
    )
  })
  parts.push('', `ยอดโอนสุทธิ ${baht(grand)} บาท`)
  return parts.join('\n')
}

/** ข้อความแจ้งร้านค้าเรื่องเอกสารค้าง (Case Online) */
export function buildPendingDocMessage(
  contract: Pick<Contract, 'contractNo' | 'invNo' | 'customerName' | 'pendingDocItems'>,
  shopName: string,
): string {
  const items = contract.pendingDocItems ?? []
  if (items.length === 0) return ''
  const lines: string[] = [
    '📋 แจ้งเอกสารค้าง',
    `ร้าน: ${shopName}`,
  ]
  if (contract.contractNo) lines.push(`เลขที่สัญญา: ${contract.contractNo}`)
  if (contract.invNo) lines.push(`INV: ${contract.invNo}`)
  lines.push(
    `ลูกค้า: ${contract.customerName}`,
    '',
    'ยังขาดเอกสารต่อไปนี้:',
    ...items.map((item) => `• ${item}`),
    '',
    'รบกวนส่งเอกสารเพิ่มเติมด้วยนะคะ ขอบคุณค่ะ 🙏',
  )
  return lines.join('\n')
}

/** ข้อความอีเมลส่งพาร์ทเนอร์ (1 เคส) */
export function buildEmailText(c: Contract, shop: Shop): string {
  const downAmount = Math.round(c.devicePrice * (c.downPercent / 100))
  const rentTotal = c.monthlyPayment * c.termMonths
  return [
    `Partners รหัสร้าน ${shop.code}`,
    `ผ่อนบริษัท ล็อก MDM`,
    `หมายเลขสัญญา : ${c.contractNo}`,
    `หมายเลขใบแจ้งหนี้(INV) ${c.invNo}`,
    `ชื่อลูกค้า : ${c.customerName}`,
    `สินทรัพย์รุ่น ${c.model} ${c.storage}`,
    `หมายเลขSN : ${c.sn}`,
    `ยอดจัดไฟแนนซ์ : ${baht(c.financeAmount)} บาท`,
    `ราคาเช่าซื้อ (ราคาผ่อน*เดือน) : ${baht(rentTotal)} บาท`,
    `ค่าเช่าต่อเดือน : ${baht(c.monthlyPayment)} บาท`,
    `ระยะเวลาเช่าซื้อ : ${c.termMonths} เดือน`,
    `ยอดเงินดาวน์ : ${baht(downAmount)} บาท`,
    `เรทดาวน์ : ${c.downPercent} %`,
    `ชำระทุกวันที่ : ${c.dueDay}`,
    `เบอร์โทรลูกค้า : ${c.phone}`,
    `โทรศัพท์สำรอง1 ${c.phoneAlt1 ?? '-'}`,
    `โทรศัพท์สำรอง2 ${c.phoneAlt2 ?? '-'}`,
    `ลิงค์เฟสลูกค้า : ${c.facebookLink ?? '-'}`,
    `เว็บไซต์นี้ : https://nebula.spaceoneinovative.com/login`,
  ].join('\n')
}
