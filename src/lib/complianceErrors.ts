// ===== แปลง SQLSTATE compliance error จาก Postgres trigger → ข้อความภาษาไทย =====
// trigger ใน migration 0019 จะ RAISE EXCEPTION ด้วย message ขึ้นต้นด้วย "CODE|..."
// db.ts ใช้ `throw error` ตรงๆ หลัง .rpc() → caller จะได้ PostgREST error object
// (shape: { message: string, code: string, details: string, hint: string })
// ซึ่งไม่ใช่ instanceof Error — ต้อง narrow ด้วย shape check เท่านั้น

/** ข้อความภาษาไทยสำหรับแต่ละ compliance code
 *
 * 4 codes เท่านั้น — ตรงกับที่ migration 0019 trigger RAISE จริง
 * DISPUTED_BLOCK: Pete decision = แค่แสดง badge ไม่ block → ไม่ raise exception
 * DISABLED:       kill-switch = silent bypass (`return new`) → ไม่ raise exception
 */
const COMPLIANCE_MESSAGES: Record<string, string> = {
  OUTSIDE_HOURS:
    'นอกเวลาทวงถามตามกฎหมาย (08:00–20:00 จ–ศ / 08:00–18:00 ส–อา+วันหยุด)',
  DAILY_CAP:
    'ติดต่อลูกค้ารายนี้แล้ว 1 ครั้งวันนี้ (ลูกหนี้) ไม่สามารถบันทึกเพิ่มได้',
  DNC:
    'สัญญานี้อยู่ในสถานะห้ามติดต่อ (DNC)',
  LAWYER:
    'สัญญานี้มีทนายความเข้ามาดำเนินคดี กรุณาติดต่อทนายแทน',
}

/**
 * แปลง error จาก Supabase/PostgREST ที่มี compliance code → ข้อความภาษาไทย
 *
 * ใช้ใน catch block ของ follow-up / contact log ฟังก์ชัน:
 * ```ts
 * } catch (err) {
 *   const msg = getComplianceErrorMessage(err)
 *   alert(msg ?? 'บันทึกไม่สำเร็จ: ' + String(err))
 * }
 * ```
 *
 * @returns ข้อความภาษาไทย ถ้าเป็น compliance error
 *          null ถ้าไม่ใช่ compliance error (caller ใช้ default message แทน)
 */
export function getComplianceErrorMessage(err: unknown): string | null {
  // ดึง message string ออกมาอย่างปลอดภัย — รองรับทั้ง:
  //   - PostgREST error object: { message: string, code: string, ... }
  //   - Error instance: { message: string }
  //   - สิ่งอื่นๆ (null, undefined, number, string, etc.)
  let message: string | null = null

  if (typeof err === 'object' && err !== null && 'message' in err) {
    // รองรับทั้ง PostgREST error object { message, code, details, hint }
    // และ Error instance (ซึ่งก็มี 'message' เป็น own property เช่นกัน)
    const raw = (err as { message: unknown }).message
    if (typeof raw === 'string') {
      message = raw
    }
  }

  if (message === null) return null

  // trigger raise ข้อความในรูป "CODE|optional detail"
  // ดึงเฉพาะส่วน code (ก่อน | แรก)
  const code = message.split('|')[0].trim()

  return COMPLIANCE_MESSAGES[code] ?? null
}
