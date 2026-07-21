// ===== ช่วงเวลา + ตัวช่วยเปรียบเทียบสำหรับ /staff-performance (pure functions ล้วน — ไม่แตะ DB/React) =====
// ทุกคำนวณวันที่ใช้ UTC ล้วน (Date.UTC) — ห้ามใช้ new Date(y, m, d) ของ local timezone เพี้ยนได้

export interface DateRange {
  start: string // 'YYYY-MM-DD' รวมวันนี้ (inclusive)
  end: string // 'YYYY-MM-DD' รวมวันนี้ (inclusive)
}

const MS_PER_DAY = 86_400_000

/** แปลง 'YYYY-MM-DD' (ตัดส่วนเวลาถ้ามี) → epoch ms แบบ UTC ล้วน */
function parseUTC(dateStr: string): number {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

/** แปลง epoch ms (UTC) กลับเป็น 'YYYY-MM-DD' */
function formatUTC(ms: number): string {
  const dt = new Date(ms)
  const y = dt.getUTCFullYear()
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const d = String(dt.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * ช่วงเวลาก่อนหน้าที่ "ยาวเท่ากัน" และติดกัน (ต่อท้ายไปทางอดีต) — ใช้เทียบดีขึ้น/แย่ลง
 * ห้าม hard-code ว่าเป็น "เดือนก่อน" — ต้องรองรับ preset วันนี้/สัปดาห์นี้/เดือนนี้/ปีนี้/กำหนดเอง ทั้ง 5 แบบ
 *
 * สูตร: lengthDays = (end - start) วัน + 1 (inclusive ทั้งสองฝั่ง)
 *   prevEnd   = start - 1 วัน
 *   prevStart = prevEnd - (lengthDays - 1) วัน
 *
 * Trace 1 (เดือนเต็ม, cross-month): { start:'2026-07-01', end:'2026-07-31' } (31 วัน)
 *   prevEnd='2026-06-30', prevStart = prevEnd - 30 วัน = '2026-05-31'
 *   -> { start:'2026-05-31', end:'2026-06-30' }
 *
 * Trace 2 (ช่วง 1 วัน - preset "วันนี้"): { start:'2026-07-21', end:'2026-07-21' } (1 วัน)
 *   prevEnd='2026-07-20', prevStart = prevEnd - 0 วัน = '2026-07-20'
 *   -> { start:'2026-07-20', end:'2026-07-20' }
 *
 * Trace 3 (กำหนดเอง 17 วัน, cross-year): { start:'2025-12-25', end:'2026-01-10' } (17 วัน)
 *   prevEnd='2025-12-24', prevStart = prevEnd - 16 วัน = '2025-12-08'
 *   -> { start:'2025-12-08', end:'2025-12-24' }
 *
 * Trace 4: null (preset "ทั้งหมด") -> null (ไม่มีอะไรให้เทียบ)
 */
export function previousRange(range: DateRange | null): DateRange | null {
  if (range === null) return null
  const startMs = parseUTC(range.start)
  const endMs = parseUTC(range.end)
  const lengthDays = Math.round((endMs - startMs) / MS_PER_DAY) + 1
  const prevEndMs = startMs - MS_PER_DAY
  const prevStartMs = prevEndMs - (lengthDays - 1) * MS_PER_DAY
  return { start: formatUTC(prevStartMs), end: formatUTC(prevEndMs) }
}

export interface DeltaResult {
  dir: 'up' | 'down' | 'flat' | 'na'
  pct: number // ค่าสัมบูรณ์ของ % ที่เปลี่ยน ปัดทศนิยม 1 ตำแหน่ง
}

/**
 * เปรียบเทียบตัวเลขช่วงปัจจุบันกับช่วงก่อนหน้า -> ทิศทาง + % ที่เปลี่ยน
 * previous เป็น 0 / null / undefined -> 'na' เสมอ (ห้ามคืน Infinity หรือ NaN เด็ดขาด)
 *
 * Trace 1: current=120, previous=100 -> { dir:'up', pct:20.0 }
 * Trace 2: current=80, previous=100 -> { dir:'down', pct:20.0 }
 * Trace 3: current=50, previous=50 -> { dir:'flat', pct:0 }
 * Trace 4: current=50, previous=0 -> { dir:'na', pct:0 } (ห้าม Infinity)
 * Trace 5: current=50, previous=null -> { dir:'na', pct:0 }
 * Trace 6: current=33, previous=99 -> pct = round1(66.666...) = 66.7 -> { dir:'down', pct:66.7 }
 */
export function deltaPct(current: number, previous: number | null | undefined): DeltaResult {
  if (previous === null || previous === undefined || previous === 0) {
    return { dir: 'na', pct: 0 }
  }
  if (current === previous) {
    return { dir: 'flat', pct: 0 }
  }
  const rawPct = Math.abs(((current - previous) / previous) * 100)
  const pct = Math.round(rawPct * 10) / 10
  return { dir: current > previous ? 'up' : 'down', pct }
}

export type LateBucket =
  | 'ตรงเวลา'
  | '1-10'
  | '11-30'
  | '31-60'
  | '61-90'
  | '91-120'
  | '120+'
  | 'ไม่ทราบช่วง'

/** ลำดับกลุ่มค้างที่ใช้เรียงในตาราง - รวม 'ตรงเวลา' และ 'ไม่ทราบช่วง' เสมอ */
export const LATE_BUCKETS: LateBucket[] = [
  'ตรงเวลา',
  '1-10',
  '11-30',
  '31-60',
  '61-90',
  '91-120',
  '120+',
  'ไม่ทราบช่วง',
]

/**
 * จัดกลุ่มค้างจากจำนวนวันล่าช้า สำหรับตารางยอดเก็บแยกตามกลุ่มค้าง
 * (คนละตัวกับ overdueBucket ใน calc.ts ตรงมีป้าย 'ไม่ทราบช่วง' - บางรายการจ่ายเชื่อมกับงวดไม่ได้แล้ว
 * เช่นหลังขยายสัญญา ต้องมีที่ลงเสมอ ห้ามทิ้งเงียบ)
 *
 * Trace 1: daysLate=0 -> 'ตรงเวลา'
 * Trace 2: daysLate=-3 (จ่ายก่อนกำหนด) -> 'ตรงเวลา'
 * Trace 3: daysLate=10 -> '1-10' (ขอบบน inclusive)
 * Trace 4: daysLate=11 -> '11-30'
 * Trace 5: daysLate=120 -> '91-120' (ขอบบน inclusive)
 * Trace 6: daysLate=121 -> '120+'
 * Trace 7: daysLate=null -> 'ไม่ทราบช่วง'
 * Trace 8: daysLate=undefined -> 'ไม่ทราบช่วง'
 */
export function bucketLabel(daysLate: number | null | undefined): LateBucket {
  if (daysLate === null || daysLate === undefined) return 'ไม่ทราบช่วง'
  if (daysLate <= 0) return 'ตรงเวลา'
  if (daysLate <= 10) return '1-10'
  if (daysLate <= 30) return '11-30'
  if (daysLate <= 60) return '31-60'
  if (daysLate <= 90) return '61-90'
  if (daysLate <= 120) return '91-120'
  return '120+'
}

/**
 * จำนวนวัน grace หลังวันนัด ที่ยังนับว่า "ตามนัด" ได้ (Pete lock)
 * ⚠️ ค่านี้เป็นสำเนาสำหรับแสดงผลเท่านั้น (StaffPerformance.tsx ใช้ขึ้นข้อความอธิบายนิยามให้ผู้ใช้อ่าน)
 * แหล่งความจริงคือ migration 0119 (`get_collector_call_outcomes`) — ถ้าจะเปลี่ยนกติกาต้องแก้ที่ SQL ด้วยเสมอ
 * ไม่งั้นข้อความบนหน้าเว็บจะโกหกผู้ใช้
 */
export const PROMISE_GRACE_DAYS = 3
/**
 * สัดส่วนขั้นต่ำของยอดนัดที่ต้องจ่ายถึง จึงนับว่า "ตามนัด" (Pete lock)
 * ⚠️ ค่านี้เป็นสำเนาสำหรับแสดงผลเท่านั้น (StaffPerformance.tsx ใช้ขึ้นข้อความอธิบายนิยามให้ผู้ใช้อ่าน)
 * แหล่งความจริงคือ migration 0119 (`get_collector_call_outcomes`) — ถ้าจะเปลี่ยนกติกาต้องแก้ที่ SQL ด้วยเสมอ
 * ไม่งั้นข้อความบนหน้าเว็บจะโกหกผู้ใช้
 */
export const PROMISE_KEPT_RATIO = 0.8
