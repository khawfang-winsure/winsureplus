// ===== ตัวคำนวณ "ประวัติหนี้เสีย" (ฟังก์ชันบริสุทธิ์ — ใช้กับการ์ดในหน้า /monthly-report) =====
// อ่านจุดข้อมูลรายวันจาก getNplHistory() แล้วคำนวณ % หนี้เสีย, สรุปช่วงที่เลือก, แถวตาราง, ช่วงวันที่ลัด
//
// ⚠️ ห้าม import supabase หรือค่าคงที่/ฟังก์ชัน runtime จาก db.ts (เช่น NPL_HISTORY_MIN_DATE) — จะพ่วง supabase client
// เข้ามาในไฟล์นี้ทั้งที่ควรเป็น pure function ล้วน ๆ. ฟังก์ชันที่ต้องพึ่งวันที่ขั้นต่ำ/วันนี้ ให้ "รับเป็นพารามิเตอร์"
// แทน — หน้า MonthlyReport.tsx เป็นคนส่ง NPL_HISTORY_MIN_DATE (import จาก db.ts) เข้ามาเอง
// import type ไม่มีผล runtime (ถูกตัดออกตอน compile) จึงใช้ import type ได้ตามปกติ
import type { NplHistoryPoint } from './db'

/** % ปลอดภัย: num/den → 0 ถ้า den<=0 (กัน NaN/Infinity) — สูตรเดียวกับ pct() ใน monthlyReport.ts/execDashboard.ts */
function pctSafe(num: number, den: number): number {
  if (den <= 0) return 0
  return (num / den) * 100
}

/** % หนี้เสียตามมูลค่า ณ จุดนั้น (สูตรเดียวกับ /exec และการ์ด "หนี้เสีย" เดิมในหน้านี้) */
export function nplValueRate(p: NplHistoryPoint): number {
  return pctSafe(p.badOutstanding, p.outstandingTotal)
}

/** % หนี้เสียตามจำนวนสัญญา ณ จุดนั้น */
export function nplCountRate(p: NplHistoryPoint): number {
  return pctSafe(p.badCount, p.activeCount)
}

/** วันนี้แบบ ISO (YYYY-MM-DD) ตามเวลาไทย — ห้ามใช้ toISOString ตรง ๆ (จะเพี้ยน UTC), รูปแบบเดียวกับ defaultMonthISO() ใน MonthlyReport.tsx */
export function todayISOBangkok(): string {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)
}

/** วันสุดท้ายของเดือน monthISO ('YYYY-MM') → 'YYYY-MM-DD' — คัดจาก monthlyReport.ts lastDayOfMonth (ห้ามแก้ต้นฉบับ เขียน local ใหม่แทน) */
function lastDayOfMonthISO(monthISO: string): string {
  const [y, m] = monthISO.split('-').map(Number)
  const lastDay = new Date(y, m, 0).getDate() // m คือเดือนถัดไป (1-indexed) → day 0 = วันสุดท้ายเดือนก่อนหน้า
  return `${monthISO}-${String(lastDay).padStart(2, '0')}`
}

/** clamp ISO date string ให้อยู่ในช่วง [minISO, maxISO] — เทียบแบบ string เพราะเป็น YYYY-MM-DD (lexicographic = chronological) */
function clampISO(iso: string, minISO: string, maxISO: string): string {
  if (iso < minISO) return minISO
  if (iso > maxISO) return maxISO
  return iso
}

// ===== สรุปช่วงที่เลือก: ต้นช่วง / ปลายช่วง / เปลี่ยนแปลง / สูงสุดในช่วง =====
export interface NplRangeSummary {
  start: NplHistoryPoint
  end: NplHistoryPoint
  /** ปลายช่วง - ต้นช่วง หน่วย "จุด %" (ตามมูลค่า) — บวก = หนี้เสียเพิ่ม (แย่ลง), ลบ = ลด (ดีขึ้น) */
  changeValuePts: number
  /** ปลายช่วง - ต้นช่วง หน่วย "จุด %" (ตามจำนวนสัญญา) */
  changeCountPts: number
  /** จุดที่ % หนี้เสียตามมูลค่าสูงสุดในช่วง — เท่ากันหลายวันเลือกวันแรกสุดที่เจอ */
  peak: NplHistoryPoint
}

/** points ว่าง → null (ให้หน้าเว็บโชว์สถานะ "ไม่มีข้อมูล" เอง) */
export function summarizeNplRange(points: NplHistoryPoint[]): NplRangeSummary | null {
  if (points.length === 0) return null
  const start = points[0]
  const end = points[points.length - 1]
  let peak = points[0]
  let peakRate = nplValueRate(points[0])
  for (const p of points) {
    const rate = nplValueRate(p)
    if (rate > peakRate) {
      peak = p
      peakRate = rate
    }
  }
  return {
    start,
    end,
    changeValuePts: nplValueRate(end) - nplValueRate(start),
    changeCountPts: nplCountRate(end) - nplCountRate(start),
    peak,
  }
}

// ===== แถวตาราง: วันสิ้นเดือนของแต่ละเดือนในช่วง + วันสุดท้ายของช่วง (ไม่ซ้ำ) =====
/**
 * เดือนที่ไม่มีวันสิ้นเดือนอยู่ในข้อมูลจริง (เช่นเดือนปัจจุบันที่ยังไม่จบ) → ใช้วันล่าสุดที่มีของเดือนนั้นแทน
 * points ต้องเรียงเก่า→ใหม่ (ตาม contract ของ getNplHistory)
 */
export function pickNplTableRows(points: NplHistoryPoint[]): NplHistoryPoint[] {
  if (points.length === 0) return []
  const byMonth = new Map<string, NplHistoryPoint>()
  for (const p of points) {
    const monthKey = p.date.slice(0, 7)
    const monthEndDate = lastDayOfMonthISO(monthKey)
    const current = byMonth.get(monthKey)
    if (!current) {
      byMonth.set(monthKey, p)
      continue
    }
    if (current.date === monthEndDate) continue // เจอวันสิ้นเดือนของเดือนนี้แล้ว ไม่ต้องหาต่อ
    if (p.date === monthEndDate || p.date > current.date) byMonth.set(monthKey, p)
  }
  const rows = Array.from(byMonth.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const lastPoint = points[points.length - 1]
  if (rows.length === 0 || rows[rows.length - 1].date !== lastPoint.date) rows.push(lastPoint)
  return rows
}

// ===== ป้าย "ที่มา" ของแต่ละจุด (ใช้ทั้งตารางและ badge) =====
export function nplHistorySourceLabel(source: NplHistoryPoint['source']): string {
  if (source === 'backfill') return 'คำนวณย้อนหลัง'
  if (source === 'daily') return 'บันทึกจริง'
  return 'ล่าสุด'
}

// ===== หมายเหตุท้ายการ์ด =====
const THAI_MONTH_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']

/** "2026-06-24" -> "24 มิ.ย. 2026" (ปี ค.ศ. ตรงตามที่ใช้ทั้งข้อความหมายเหตุ ไม่ใช่ พ.ศ.) */
function thaiShortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return `${d} ${THAI_MONTH_SHORT[m - 1] ?? ''} ${y}`
}

/**
 * ข้อความหมายเหตุท้ายการ์ด — วันเริ่มมีข้อมูลต้องอ่านจาก minDateISO (=NPL_HISTORY_MIN_DATE จาก db.ts) เสมอ
 * ห้าม hardcode วันที่ตรง ๆ ในหน้าเว็บ เพราะวันเริ่มมีข้อมูลย้อนหลังปรับได้ (เช่นตัดช่วงข้อมูลเพี้ยนออก)
 * ส่วน "16 ก.ย. 2026" คือวันที่ระบบเริ่มบันทึกจริงทุกคืน (คนละความหมายกับ minDateISO) — เป็นข้อเท็จจริงตายตัว ไม่ต้องคำนวณ
 */
export function nplHistoryFootnote(minDateISO: string): string {
  return `มีข้อมูลตั้งแต่ ${thaiShortDate(minDateISO)} · ตัวเลขก่อน 16 ก.ย. 2026 คำนวณย้อนหลัง อาจคลาดเคลื่อนเล็กน้อย · ระบบบันทึกตัวเลขอัตโนมัติทุกคืน`
}

// ===== ช่วงวันที่ลัด =====
export type NplHistoryPreset = 'thisMonth' | 'last3Months' | 'all'

/**
 * คำนวณ [จากวันที่, ถึงวันที่] ของปุ่มลัด — "ถึงวันที่" อิงจาก toISO ที่ส่งเข้ามา (ปกติปล่อยว่าง = วันนี้จริง)
 * clamp ทั้งคู่ให้อยู่ในช่วง [minDateISO, วันนี้จริง] เสมอ (กันกรณี toISO ในอนาคต หรือ minDateISO ผิดพลาด)
 */
export function nplHistoryPresetRange(
  preset: NplHistoryPreset,
  minDateISO: string,
  toISO: string = todayISOBangkok(),
): { from: string; to: string } {
  const today = todayISOBangkok()
  const to = clampISO(toISO, minDateISO, today)
  const toMonthISO = to.slice(0, 7)

  let fromCandidate: string
  if (preset === 'all') {
    fromCandidate = minDateISO
  } else if (preset === 'thisMonth') {
    fromCandidate = `${toMonthISO}-01`
  } else {
    // last3Months: เดือนของ "to" + ย้อนอีก 2 เดือนก่อนหน้า (รวม 3 เดือนปฏิทิน)
    const [y, m] = toMonthISO.split('-').map(Number)
    const total = y * 12 + (m - 1) - 2
    const fy = Math.floor(total / 12)
    const fm = (total % 12) + 1
    fromCandidate = `${fy}-${String(fm).padStart(2, '0')}-01`
  }
  return { from: clampISO(fromCandidate, minDateISO, to), to }
}

/**
 * "ถึงวันที่" เริ่มต้นของการ์ด (ใช้ตอน mount ครั้งแรกเท่านั้น) — ถ้าเดือนที่หน้ารายงานกำลังดูอยู่ (reportMonthISO,
 * รูปแบบ 'YYYY-MM') คือเดือนปัจจุบัน → วันนี้; ถ้าเป็นเดือนอดีต → วันสุดท้ายของเดือนนั้น (กราฟจบตรงกับรายงานที่กำลังดู)
 */
export function nplHistoryAnchorISO(reportMonthISO: string, todayISO: string = todayISOBangkok()): string {
  const currentMonthISO = todayISO.slice(0, 7)
  if (reportMonthISO === currentMonthISO) return todayISO
  const anchor = lastDayOfMonthISO(reportMonthISO)
  return anchor > todayISO ? todayISO : anchor
}

// ===== trace-test (comment เท่านั้น — ไว้ตรวจ logic ด้วยตา) =====
// 1) points=[] → summarizeNplRange=null, pickNplTableRows=[]
// 2) points 1 จุดเดียว → start=end=peak=จุดนั้น, changeValuePts/changeCountPts=0, pickNplTableRows=[จุดนั้น]
// 3) outstandingTotal=0 (ไม่มีสัญญา active) → nplValueRate=pctSafe(x,0)=0 ไม่ NaN
// 4) reportMonthISO='2026-09' (เดือนปัจจุบัน, todayISO='2026-09-16') → nplHistoryAnchorISO คืน '2026-09-16' (วันนี้)
//    reportMonthISO='2026-08' → คืน '2026-08-31' (วันสุดท้ายเดือน ส.ค.)
// 5) nplHistoryPresetRange('last3Months', '2026-06-24', '2026-09-16') → to='2026-09-16', from เดือน ก.ค. (2026-07-01)
//    ตาม 3 เดือนปฏิทิน ก.ค./ส.ค./ก.ย. — from ไม่ต่ำกว่า minDateISO
//    nplHistoryPresetRange('all', '2026-06-24', '2026-09-16') → from='2026-06-24' (=minDateISO), to='2026-09-16'
// 6) pickNplTableRows เดือนที่ไม่มีวันสิ้นเดือนจริง (เช่นข้อมูลหยุดที่ 16 ก.ย.) → แถวเดือนนั้นใช้วันล่าสุดที่มี (16 ก.ย.)
//    ซึ่งซ้ำกับ lastPoint พอดี → ไม่ push ซ้ำ (กันแถวซ้ำวันเดียวกัน 2 แถว)
