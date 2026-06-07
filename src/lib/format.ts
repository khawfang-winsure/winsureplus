// ===== ฟังก์ชันช่วยจัดรูปแบบการแสดงผล =====

/** ใส่คอมมาให้ตัวเลข เช่น 15502 -> "15,502" */
export function baht(n: number): string {
  return n.toLocaleString('th-TH', { maximumFractionDigits: 0 })
}

/** แปลงวันที่ ISO (yyyy-mm-dd) -> dd/mm/yyyy แบบไทย */
export function thaiDate(iso: string): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${d}/${m}/${y}`
}

/** คำนวณช่วงอายุจากปีเกิด (ค.ศ.) */
export function ageRange(birthYear: number | undefined, currentYear: number): string {
  if (!birthYear) return '-'
  const age = currentYear - birthYear
  if (age < 18) return '<18'
  if (age <= 22) return '18-22'
  if (age <= 30) return '23-30'
  if (age <= 40) return '31-40'
  if (age <= 50) return '41-50'
  if (age <= 60) return '51-60'
  return '60+'
}

const CONDITION_LABEL: Record<string, string> = { new: 'มือ 1', used: 'มือ 2' }
const ORIGIN_LABEL: Record<string, string> = { th: 'เครื่องไทย', inter: 'เครื่องนอก' }
const STATUS_LABEL: Record<string, string> = {
  active: 'ผ่อนปกติ',
  closed: 'ปิดสัญญา',
  returned: 'คืนเครื่อง',
  returned_closed: 'คืนเครื่องปิดสัญญา',
  online: 'ออนไลน์',
}

const INSTALLMENT_LABEL: Record<string, string> = {
  pending: 'รอชำระ',
  paid: 'ชำระแล้ว',
  late: 'ล่าช้า',
}

export const conditionLabel = (c: string) => CONDITION_LABEL[c] ?? c
export const originLabel = (o: string) => ORIGIN_LABEL[o] ?? o
export const statusLabel = (s: string) => STATUS_LABEL[s] ?? s
export const installmentLabel = (s: string) => INSTALLMENT_LABEL[s] ?? s
