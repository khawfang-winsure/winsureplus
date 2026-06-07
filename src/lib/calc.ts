// ===== สูตรคำนวณหลักของธุรกิจ (ทดสอบกับเคสตัวอย่างในสรุปข้อมูล.txt) =====

export interface SummaryBreakdown {
  afterDown: number // ยอดตัวเครื่องจริงหลังหักดาวน์
  commission: number // ค่าคอมมิชชั่น
  docFee: number // ค่าเอกสาร (หักออก)
  net: number // สุทธิ (ยอดที่โอนให้ร้านต่อเครื่อง)
}

/**
 * คำนวณยอดสรุปโอนให้ร้านต่อ 1 เครื่อง
 *   afterDown  = devicePrice * (1 - down%)
 *   commission = afterDown * commission%
 *   net        = afterDown + commission - docFee   (ค่าเอกสารหักออก)
 *
 * ตัวอย่างยืนยัน: 19,900 / ดาวน์ 30% / คอม 12% / ค่าเอกสาร 100
 *   afterDown = 13,930, commission = 1,672 (ปัด), net = 15,502
 */
export function calcSummary(
  devicePrice: number,
  downPercent: number,
  commissionPercent: number,
  docFee: number,
): SummaryBreakdown {
  const afterDown = Math.round(devicePrice * (1 - downPercent / 100))
  const commission = Math.round(afterDown * (commissionPercent / 100))
  const net = afterDown + commission - docFee
  return { afterDown, commission, docFee, net }
}

/** จำนวนวันในเดือน (month = 1-12) */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

/**
 * วันครบกำหนดของงวด โดย clamp ปลายเดือน
 * เช่น dueDay=31 แต่เดือนนั้นมี 30 วัน -> ใช้วันที่ 30
 * @param year ปี ค.ศ. ของงวดนั้น
 * @param month เดือน 1-12 ของงวดนั้น
 */
export function dueDateFor(year: number, month: number, dueDay: number): Date {
  const day = Math.min(dueDay, daysInMonth(year, month))
  return new Date(year, month - 1, day)
}

/**
 * สร้างวันครบกำหนดของทุกงวดจากวันเริ่ม
 * งวดที่ 1 = เดือนถัดจากวันทำรายการ (ปรับได้ภายหลังตามนโยบายจริง)
 */
export function buildSchedule(
  startISO: string,
  dueDay: number,
  termMonths: number,
): Date[] {
  const start = new Date(startISO)
  const out: Date[] = []
  for (let i = 1; i <= termMonths; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1)
    out.push(dueDateFor(d.getFullYear(), d.getMonth() + 1, dueDay))
  }
  return out
}

export interface PenaltyConfig {
  perDay: number // ค่าปรับต่อวัน (ดีฟอลต์ 100)
  maxDays: number // จำนวนวันสูงสุดที่คิด (ดีฟอลต์ 7)
}

export const DEFAULT_PENALTY: PenaltyConfig = { perDay: 100, maxDays: 7 }

/**
 * ค่าปรับของ "งวดที่ค้าง 1 งวด"
 * คิด perDay ต่อวัน แต่ไม่เกิน maxDays วัน (เพดาน = perDay * maxDays)
 * = เดือนแรกของการล่าช้าแต่ละครั้ง (ตามที่พี่พิธยืนยัน)
 */
export function penaltyFor(daysLate: number, cfg: PenaltyConfig = DEFAULT_PENALTY): number {
  if (daysLate <= 0) return 0
  const billableDays = Math.min(daysLate, cfg.maxDays)
  return billableDays * cfg.perDay
}

/** จัดกลุ่มความล่าช้าจากจำนวนวัน */
export function overdueBucket(daysLate: number):
  | 'normal'
  | '1-10'
  | '11-30'
  | '31-60'
  | '61-90'
  | '91-120'
  | '120+' {
  if (daysLate <= 0) return 'normal'
  if (daysLate <= 10) return '1-10'
  if (daysLate <= 30) return '11-30'
  if (daysLate <= 60) return '31-60'
  if (daysLate <= 90) return '61-90'
  if (daysLate <= 120) return '91-120'
  return '120+'
}
