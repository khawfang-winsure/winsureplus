// ===== บังคับเวลาทวงถามหนี้ตาม พ.ร.บ. ทวงถามหนี้ 2558 — ฟังก์ชันบริสุทธิ์ ไม่มี side-effect =====
//
// Trace tests (ยืนยันด้วยมือ — ไม่มี test runner):
//
//   กรณี 1: Fri 2026-06-12 14:30 BKK, holidays=[]
//     dow=5 (จันทร์-ศุกร์), ไม่ใช่ holiday → restricted=false → window [480,1200)
//     minutesSinceMidnight = 14*60+30 = 870 → 480 ≤ 870 < 1200 → { ok: true }  ✓
//
//   กรณี 2: Sat 2026-06-13 18:00 BKK, holidays=[]
//     dow=6 (เสาร์) → restricted=true → window [480,1080)
//     minutesSinceMidnight = 18*60 = 1080 → 1080 >= 1080 (exclusive) → { ok: false, reason: 'outside_hours' }  ✓
//
//   กรณี 3: Sat 2026-06-13 17:59 BKK, holidays=[]
//     restricted=true → window [480,1080)
//     minutesSinceMidnight = 17*60+59 = 1079 → 480 ≤ 1079 < 1080 → { ok: true }  ✓
//
//   กรณี 4: Fri 2026-06-12 07:59 BKK, holidays=[]
//     restricted=false → window [480,1200)
//     minutesSinceMidnight = 7*60+59 = 479 → 479 < 480 → { ok: false, reason: 'outside_hours' }  ✓
//
//   กรณี 5: Fri 2026-06-12 08:00 BKK, holidays=[]
//     restricted=false → window [480,1200)
//     minutesSinceMidnight = 8*60 = 480 → 480 ≤ 480 < 1200 → { ok: true }  ✓
//
//   กรณี 6: Fri 2026-06-12 20:00 BKK, holidays=[]
//     restricted=false → window [480,1200)
//     minutesSinceMidnight = 20*60 = 1200 → 1200 >= 1200 (exclusive) → { ok: false, reason: 'outside_hours' }  ✓
//
//   กรณี 7: Mon 2026-04-06 14:00 BKK + holidays={'2026-04-06'}
//     dow=1 (จันทร์) แต่เป็น holiday → restricted=true → window [480,1080)
//     minutesSinceMidnight = 14*60 = 840 → 480 ≤ 840 < 1080 → { ok: true }  ✓
//
//   กรณี 8: Mon 2026-04-06 18:30 BKK + holidays={'2026-04-06'}
//     restricted=true → window [480,1080)
//     minutesSinceMidnight = 18*60+30 = 1110 → 1110 >= 1080 (exclusive) → { ok: false, reason: 'outside_hours' }  ✓

export interface ContactWindowResult {
  ok: boolean
  /** สาเหตุที่ไม่สามารถติดต่อได้ (มีเฉพาะตอน ok=false)
   *
   * Pete decision: UI ใช้ banner เดียวกันสำหรับ outside-hours และ holiday
   * ถ้าอนาคตต้องการแยก banner → ขยาย type + เพิ่ม logic ใน isContactWindowOpen ใหม่
   */
  reason?: 'outside_hours'
}

/**
 * ตรวจสอบว่าขณะนี้อยู่ในเวลาที่กฎหมายอนุญาตให้ทวงถามหนี้ได้หรือไม่
 *
 * กฎ พ.ร.บ. ทวงถามหนี้ 2558:
 * - จ-ศ (ไม่ใช่วันหยุดราชการ): 08:00–20:00 (inclusive 08:00, exclusive 20:00)
 * - ส-อา หรือวันหยุดราชการ: 08:00–18:00 (inclusive 08:00, exclusive 18:00)
 *
 * @param nowUtc - เวลา UTC ปัจจุบัน (ส่ง `new Date()` ตรงๆ)
 * @param publicHolidays - Set ของวันหยุดราชการในรูป ISO yyyy-mm-dd (Bangkok timezone)
 */
export function isContactWindowOpen(
  nowUtc: Date,
  publicHolidays: Set<string>,
): ContactWindowResult {
  // แปลงเป็น Bangkok wall-clock: UTC+7 ไม่มี DST
  // ใช้ getTime() + offset แล้วอ่านผ่าน getUTC* เพื่อหลีกเลี่ยง local tz ของ browser
  const BKK_OFFSET_MS = 7 * 60 * 60 * 1000
  const bkk = new Date(nowUtc.getTime() + BKK_OFFSET_MS)

  // วันในสัปดาห์ (getUTCDay): 0=อาทิตย์, 1=จันทร์, ..., 6=เสาร์
  const dow = bkk.getUTCDay()
  const isWeekend = dow === 0 || dow === 6

  // วันที่ใน Bangkok เพื่อ lookup holidays set
  // toISOString() บน bkk (ที่ shift แล้ว) จะให้ "yyyy-mm-ddTHH:MM:SSZ" โดยที่
  // ส่วน date เป็น Bangkok date ถูกต้อง
  const bkkDateStr = bkk.toISOString().slice(0, 10)
  const isHoliday = publicHolidays.has(bkkDateStr)

  // restricted = เสาร์/อาทิตย์ หรือวันหยุดราชการ → window 08:00–18:00
  // ปกติ = จ–ศ ที่ไม่ใช่วันหยุด → window 08:00–20:00
  const restricted = isWeekend || isHoliday

  const bkkHour = bkk.getUTCHours()
  const bkkMinute = bkk.getUTCMinutes()
  const minutesSinceMidnight = bkkHour * 60 + bkkMinute

  // กรอบเวลา (นาทีนับจากเที่ยงคืน), boundary: lower inclusive, upper exclusive
  const windowStart = 480  // 08:00 = 8*60
  const windowEnd = restricted ? 1080 : 1200  // 18:00 = 18*60 หรือ 20:00 = 20*60

  if (minutesSinceMidnight >= windowStart && minutesSinceMidnight < windowEnd) {
    return { ok: true }
  }

  return { ok: false, reason: 'outside_hours' }
}
