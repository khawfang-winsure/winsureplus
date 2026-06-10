// ===== ตรรกะส่งจดหมายติดตามหนี้ =====
// หัวใจ = state machine "รอบจดหมาย" ต่อ episode (งวดที่ค้าง)
// เขียนเป็นฟังก์ชันบริสุทธิ์ตัวเดียว ทดสอบง่าย แยกจาก UI/DB

export type AddressKind = 'current' | 'id_card' | 'work' | 'registry'

/** ที่อยู่แยกช่อง (ตาราง customer_addresses) */
export interface CustomerAddress {
  houseNo?: string
  moo?: string
  soi?: string
  road?: string
  subdistrict?: string
  district?: string
  province?: string
  postalCode?: string
}

export const ADDRESS_KIND_LABEL: Record<AddressKind, string> = {
  current: 'ที่อยู่ปัจจุบัน',
  id_card: 'ที่อยู่ตามบัตรประชาชน',
  work: 'ที่อยู่ที่ทำงาน',
  registry: 'ที่อยู่ทะเบียนราษฎร์',
}

export type LetterReply = 'pending' | 'replied' | 'no_reply'

export const REPLY_LABEL: Record<LetterReply, string> = {
  pending: 'รอผลตอบกลับ',
  replied: 'ตอบกลับแล้ว',
  no_reply: 'ไม่ตอบ/ตีกลับ',
}

/** 1 แถวในตาราง collection_letters */
export interface LetterRecord {
  id: string
  contractId: string
  episodeKey: string // yyyy-mm-dd (= next_due ที่ trigger รอบนี้)
  round: 1 | 2 | 3
  addressKind: 'current' | 'id_card' | 'registry'
  recipientSnapshot?: string | null
  printedAt: string
  trackingNo?: string | null
  reply: LetterReply
}

/** สิ่งที่ต้องทำต่อไปของสัญญาหนึ่ง (ใน episode ปัจจุบัน) */
export type LetterStage =
  | { kind: 'none' } // ยังไม่ถึงเกณฑ์ / จบรอบแล้ว
  | { kind: 'send'; round: 1 | 2 | 3; addressKind: 'current' | 'id_card' | 'registry' }
  | { kind: 'waiting-reply'; round: 1 | 2 | 3 } // ส่งแล้ว รอบันทึกผลตอบกลับ
  | { kind: 'registry-search' } // 2 ครั้งไม่ตอบ รอกรอกที่อยู่ทะเบียนราษฎร์
  | { kind: 'field-visit' } // ครั้งที่ 3 ไม่ตอบ → เตรียมลงพื้นที่

export const DAYS_LETTER_1 = 10
export const DAYS_LETTER_2 = 20

/**
 * หาสิ่งที่ต้องทำต่อไปของ episode ปัจจุบัน
 * @param lettersThisEpisode จดหมายเฉพาะ episode ปัจจุบัน (episodeKey === next_due)
 * @param daysLate จำนวนวันล่าช้าปัจจุบัน
 * @param registryAddrPresent กรอกที่อยู่ทะเบียนราษฎร์แล้วหรือยัง
 */
export function nextLetterAction(
  lettersThisEpisode: LetterRecord[],
  daysLate: number,
  registryAddrPresent: boolean,
): LetterStage {
  const byRound = (r: 1 | 2 | 3) => lettersThisEpisode.find((l) => l.round === r)
  const r1 = byRound(1)
  const r2 = byRound(2)
  const r3 = byRound(3)

  // --- ครั้งที่ 3 ส่งแล้ว ---
  if (r3) {
    if (r3.reply === 'pending') return { kind: 'waiting-reply', round: 3 }
    if (r3.reply === 'no_reply') return { kind: 'field-visit' }
    return { kind: 'none' } // ตอบกลับ = ติดต่อได้ จบรอบ
  }

  // --- ครั้งที่ 2 ส่งแล้ว ---
  if (r2) {
    if (r2.reply === 'pending') return { kind: 'waiting-reply', round: 2 }
    // ขึ้นทะเบียนราษฎร์เฉพาะเมื่อ "ทั้ง 2 ครั้งไม่ตอบ"
    if (r1?.reply === 'no_reply' && r2.reply === 'no_reply') {
      return registryAddrPresent
        ? { kind: 'send', round: 3, addressKind: 'registry' }
        : { kind: 'registry-search' }
    }
    return { kind: 'none' } // มีตอบกลับอย่างน้อยครั้งหนึ่ง → หยุดรอ
  }

  // --- ครั้งที่ 1 ส่งแล้ว ---
  if (r1) {
    if (r1.reply === 'pending') return { kind: 'waiting-reply', round: 1 }
    // บันทึกผลครั้ง 1 แล้ว → รอครบ 20 วันค่อยส่งครั้งที่ 2
    if (daysLate >= DAYS_LETTER_2) {
      return { kind: 'send', round: 2, addressKind: r1.reply === 'replied' ? 'current' : 'id_card' }
    }
    return { kind: 'none' }
  }

  // --- ยังไม่ส่งเลย ---
  if (daysLate >= DAYS_LETTER_1) return { kind: 'send', round: 1, addressKind: 'current' }
  return { kind: 'none' }
}

/** ที่อยู่เป็นข้อความบรรทัดเดียว (สำหรับ snapshot/ค้นหา) */
export function addressOneLine(a: CustomerAddress | null | undefined): string {
  if (!a) return ''
  const parts = [
    a.houseNo && `${a.houseNo}`,
    a.moo && `หมู่ ${a.moo}`,
    a.soi && `ซ.${a.soi}`,
    a.road && `ถ.${a.road}`,
    a.subdistrict && `ต./แขวง ${a.subdistrict}`,
    a.district && `อ./เขต ${a.district}`,
    a.province,
    a.postalCode,
  ].filter(Boolean)
  return parts.join(' ')
}

/** ที่อยู่ว่างเปล่าหรือไม่ (ทุกช่องว่าง) */
export function isAddressEmpty(a: CustomerAddress | null | undefined): boolean {
  if (!a) return true
  return !addressOneLine(a).trim()
}

/** แทนค่าตัวแปรในข้อความจดหมาย */
export function fillLetterTemplate(
  tpl: string,
  v: { name: string; address: string; contractNo: string; amount: string; daysLate: number; date: string },
): string {
  return tpl
    .replace(/\{\{name\}\}/g, v.name)
    .replace(/\{\{address\}\}/g, v.address)
    .replace(/\{\{contractNo\}\}/g, v.contractNo)
    .replace(/\{\{amount\}\}/g, v.amount)
    .replace(/\{\{daysLate\}\}/g, String(v.daysLate))
    .replace(/\{\{date\}\}/g, v.date)
}
