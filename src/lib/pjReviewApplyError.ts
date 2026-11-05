// แปลง error จาก RPC apply_pj_review_payment (mig 0183) เป็นข้อความไทยที่เข้าใจง่าย — pure function
// RPC ใส่ tag [PJR:XXX] นำหน้าข้อความเสมอ

export type PjReviewErrorKind =
  | 'stale'       // รายการถูกจัดการไปแล้ว/ใบลงแล้ว/ข้อมูลเปลี่ยน -> ให้รีเฟรชแล้วดูใหม่
  | 'mismatch'    // ยอด/วันที่ในรายการไม่ตรงกับที่ระบบคำนวณ -> ไม่ให้ลง ให้แจ้งทีมตรวจ (ไม่ใช่ให้รีเฟรช)
  | 'manual'      // ประเภทที่ห้ามลงจากกล่องนี้
  | 'forbidden'   // ไม่มีสิทธิ์
  | 'partial'     // เงินลงแล้ว แต่ขั้นตอนหลังลง (ปรับค่าปรับตาม PJ) ไม่ครบ
  | 'other'

export interface PjReviewErrorInfo {
  kind: PjReviewErrorKind
  message: string
}

const STALE_TEXT = 'รายการนี้ถูกจัดการไปแล้ว (อาจมีคนอื่นกดลงยอดไปก่อน หรือระบบลงให้เองแล้ว) — ระบบกำลังโหลดรายการใหม่ ไม่ต้องกดซ้ำค่ะ'

export function classifyPjReviewError(raw: string | null | undefined): PjReviewErrorInfo {
  const msg = (raw ?? '').trim()
  const m = /\[PJR:([A-Z_]+)\]/.exec(msg)
  const tag = m ? m[1] : null
  switch (tag) {
    case 'NOT_PENDING':
    case 'NOT_FOUND':
    case 'RECEIPT_APPLIED':
      return { kind: 'stale', message: STALE_TEXT }
    case 'MISMATCH':
      return {
        kind: 'mismatch',
        message: 'ยอดหรือวันที่ในรายการนี้ไม่ตรงกับที่ระบบคำนวณ จึงลงยอดให้ไม่ได้ — กรุณาแจ้งทีมให้ตรวจรายการนี้ค่ะ (ไม่ต้องรีเฟรช)',
      }
    case 'MANUAL_ONLY':
      return { kind: 'manual', message: 'รายการประเภทนี้ลงยอดจากกล่องรอตรวจไม่ได้ ต้องตรวจใน PJ แล้วจัดการเองที่หน้าสัญญาค่ะ' }
    case 'NO_CONTRACT':
      return { kind: 'manual', message: 'รายการนี้ยังไม่ผูกกับสัญญา ลงยอดไม่ได้ค่ะ' }
    case 'FORBIDDEN':
      return { kind: 'forbidden', message: 'บัญชีนี้ไม่มีสิทธิ์ลงยอดจากกล่องรอตรวจค่ะ' }
    default:
      // ไม่มี tag = error อื่น (เช่น ไม่มีงวดให้ลง) ส่งข้อความเดิมต่อ ตัด tag ออกถ้ามี
      return { kind: 'other', message: msg.replace(/\[PJR:[A-Z_]+\]\s*/, '') || 'เกิดข้อผิดพลาด ลองใหม่อีกครั้งค่ะ' }
  }
}

/** error ที่โยนจาก db.ts ให้หน้าเว็บรู้ว่าควรรีเฟรชรายการ (kind = stale/partial) */
export class PjReviewApplyError extends Error {
  kind: PjReviewErrorKind
  constructor(info: PjReviewErrorInfo) {
    super(info.message)
    this.name = 'PjReviewApplyError'
    this.kind = info.kind
  }
}

/** ควรโหลดรายการใหม่ไหม — stale (ถูกจัดการแล้ว) หรือ partial (เงินลงแล้วแต่ขั้นหลังไม่ครบ ห้ามกดซ้ำ) */
export function shouldReloadAfterPjReviewError(e: unknown): boolean {
  return e instanceof PjReviewApplyError && (e.kind === 'stale' || e.kind === 'partial')
}

export const PJ_ALIGN_PARTIAL_TEXT =
  'ลงเงินให้เรียบร้อยแล้ว แต่ปรับค่าปรับตาม PJ ไม่ครบ — ห้ามกดลงซ้ำ (เงินจะเบิ้ล) กรุณาแจ้งทีมให้เช็คค่าปรับของสัญญานี้ค่ะ'
