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

/** "2026-06-24" -> "24 มิ.ย. 2026" (ปี ค.ศ.) หรือ useBE=true -> "24 มิ.ย. 69" (ปี พ.ศ. 2 หลัก เหมือน thaiMonthYearBE ด้านล่าง — ให้เข้าชุดกับแกนกราฟที่ใช้ พ.ศ.) */
function thaiShortDate(iso: string, useBE = false): string {
  const [y, m, d] = iso.split('-').map(Number)
  const year = useBE ? String((y + 543) % 100).padStart(2, '0') : String(y)
  return `${d} ${THAI_MONTH_SHORT[m - 1] ?? ''} ${year}`
}

/**
 * ข้อความหมายเหตุท้ายการ์ด — วันเริ่มมีข้อมูลต้องอ่านจาก minDateISO (=NPL_HISTORY_MIN_DATE จาก db.ts) เสมอ
 * ห้าม hardcode วันที่ตรง ๆ ในหน้าเว็บ เพราะวันเริ่มมีข้อมูลย้อนหลังปรับได้ (เช่นตัดช่วงข้อมูลเพี้ยนออก)
 * ส่วน "16 ก.ย." คือวันที่ระบบเริ่มบันทึกจริงทุกคืน (คนละความหมายกับ minDateISO) — เป็นข้อเท็จจริงตายตัว ไม่ต้องคำนวณ
 *
 * useBE (default false = พฤติกรรมเดิม ปี ค.ศ. เต็ม — ใช้ในหน้ารายงานประจำเดือน /monthly-report ห้ามเปลี่ยน default)
 * true → แสดงปี พ.ศ. 2 หลัก ให้ตรงกับแกนกราฟที่ใช้ พ.ศ. (การ์ดแนวโน้มใน /exec)
 */
export function nplHistoryFootnote(minDateISO: string, useBE = false): string {
  const startDate = thaiShortDate(minDateISO, useBE)
  const cutoverDate = useBE ? '16 ก.ย. 69' : '16 ก.ย. 2026'
  return `มีข้อมูลตั้งแต่ ${startDate} · ตัวเลขก่อน ${cutoverDate} คำนวณย้อนหลัง อาจคลาดเคลื่อนเล็กน้อย · ระบบบันทึกตัวเลขอัตโนมัติทุกคืน`
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

// ===== แนวโน้มรายเดือน (ใช้กับการ์ด "แนวโน้มหนี้ล่าช้า / หนี้เสีย" หน้า /exec) =====
// 1 จุดต่อเดือน (สิ้นเดือน ถ้ามี ไม่งั้นวันล่าสุดที่มีในเดือนนั้น — คัด row ด้วย pickNplTableRows เดิม)
// พร้อม % ทั้ง 2 สูตร (มูลค่า/สัญญา) ของทั้งหนี้เสีย(60+) และค้างทั้งหมด(1+, อาจไม่มีข้อมูลเก่า → null)

export interface NplMonthlyPoint {
  /** 'YYYY-MM' */
  monthKey: string
  /** ป้ายภาษาไทยสำหรับแกน/สรุป เช่น "มิ.ย. 69" หรือเดือนปัจจุบันที่ยังไม่จบ "ก.ย. (ถึง 16)" */
  label: string
  /** true = แถวนี้ไม่ใช่วันสิ้นเดือนจริง (ปกติคือเดือนปัจจุบันที่ยังไม่จบ) */
  isPartial: boolean
  /** แถวดิบที่ใช้คำนวณจุดนี้ (สิ้นเดือน หรือวันล่าสุดที่มีของเดือนนั้น) */
  point: NplHistoryPoint
  /** % หนี้เสีย (60 วันขึ้นไป) ตามมูลค่า — เท่ากับ nplValueRate(point) */
  valuePct: number
  /** % หนี้เสีย (60 วันขึ้นไป) ตามจำนวนสัญญา — เท่ากับ nplCountRate(point) */
  countPct: number
  badOutstanding: number
  badCount: number
  /** % ค้างทั้งหมด (1 วันขึ้นไป) ตามมูลค่า — null ถ้าเดือนนั้นยังไม่มีข้อมูล overdueOutstanding */
  overdueValuePct: number | null
  /** % ค้างทั้งหมด (1 วันขึ้นไป) ตามจำนวนสัญญา — null ถ้าเดือนนั้นยังไม่มีข้อมูล overdueCount */
  overdueCountPct: number | null
  overdueOutstanding: number | null
  overdueCount: number | null
}

/** "2026-06" -> "มิ.ย. 69" (ปี พ.ศ. 2 หลัก — ต่างจาก thaiShortDate ด้านบนที่ใช้ปี ค.ศ. เต็ม เพราะการ์ดนี้โชว์ปี พ.ศ.) */
function thaiMonthYearBE(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number)
  const be2 = String((y + 543) % 100).padStart(2, '0')
  return `${THAI_MONTH_SHORT[m - 1] ?? ''} ${be2}`
}

/**
 * points ต้องเรียงเก่า→ใหม่ (ตาม contract ของ getNplHistory) — ใช้ pickNplTableRows คัด 1 แถวต่อเดือนซ้ำ
 * (สิ้นเดือนถ้ามี ไม่งั้นวันล่าสุดที่มีของเดือนนั้น) แล้วคำนวณ % + ป้ายไทยต่อจุด
 */
export function buildNplMonthlyTrend(points: NplHistoryPoint[]): NplMonthlyPoint[] {
  const rows = pickNplTableRows(points)
  return rows.map((p) => {
    const monthKey = p.date.slice(0, 7)
    const monthEndDate = lastDayOfMonthISO(monthKey)
    const isPartial = p.date !== monthEndDate
    const day = Number(p.date.slice(8, 10))
    const label = isPartial ? `${THAI_MONTH_SHORT[Number(monthKey.slice(5, 7)) - 1] ?? ''} (ถึง ${day})` : thaiMonthYearBE(monthKey)
    return {
      monthKey,
      label,
      isPartial,
      point: p,
      valuePct: nplValueRate(p),
      countPct: nplCountRate(p),
      badOutstanding: p.badOutstanding,
      badCount: p.badCount,
      overdueValuePct: p.overdueOutstanding != null ? pctSafe(p.overdueOutstanding, p.outstandingTotal) : null,
      overdueCountPct: p.overdueCount != null ? pctSafe(p.overdueCount, p.activeCount) : null,
      overdueOutstanding: p.overdueOutstanding ?? null,
      overdueCount: p.overdueCount ?? null,
    }
  })
}

// ===== เปลี่ยนแปลงเทียบ "สิ้นเดือนก่อนหน้า" — ใช้ทั้งการ์ดแนวโน้ม (สรุปด้านบนกราฟ) และ MorningBriefing =====
export interface NplMonthlyChange {
  /** จุดล่าสุด (เดือนปัจจุบัน อาจยังไม่จบ) */
  current: NplMonthlyPoint
  /** เดือนก่อนหน้า — null ถ้ามีข้อมูลแค่เดือนเดียว */
  previous: NplMonthlyPoint | null
  /** current.valuePct - previous.valuePct หน่วย "จุด %" — null ถ้าไม่มี previous */
  changeValuePts: number | null
  /** current.countPct - previous.countPct หน่วย "จุด %" — null ถ้าไม่มี previous */
  changeCountPts: number | null
}

/**
 * monthly ว่าง → null; monthly ต้องเรียงเก่า→ใหม่ (ผลจาก buildNplMonthlyTrend เรียงแบบนี้อยู่แล้ว)
 * index ไม่ส่ง (undefined) = เดือนล่าสุด (พฤติกรรมเดิม — ใช้ที่ MorningBriefing ห้ามเปลี่ยน)
 * ส่ง index = เทียบเดือนนั้นกับเดือนก่อนหน้ามันเอง (ใช้ที่การ์ดแนวโน้ม /exec ตอนแตะเลือกเดือนอื่นในกราฟ)
 * index นอกช่วง [0, monthly.length-1] จะถูก clamp ให้อัตโนมัติ; index=0 → previous เป็น null เสมอ (ไม่มีเดือนก่อนหน้า)
 */
export function nplChangeVsPreviousMonthEnd(monthly: NplMonthlyPoint[], index?: number): NplMonthlyChange | null {
  if (monthly.length === 0) return null
  const i = index === undefined ? monthly.length - 1 : Math.max(0, Math.min(monthly.length - 1, index))
  const current = monthly[i]
  const previous = i >= 1 ? monthly[i - 1] : null
  return {
    current,
    previous,
    changeValuePts: previous ? current.valuePct - previous.valuePct : null,
    changeCountPts: previous ? current.countPct - previous.countPct : null,
  }
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
// 7) buildNplMonthlyTrend: points มี 30 มิ.ย. (สิ้นเดือน) + 16 ก.ย. (ล่าสุด, ไม่ใช่สิ้นเดือน) →
//    จุด มิ.ย. isPartial=false label="มิ.ย. 69"; จุด ก.ย. isPartial=true label="ก.ย. (ถึง 16)"
//    จุดที่ overdueOutstanding/overdueCount เป็น null (ยังไม่มีข้อมูลค้างทั้งหมดของเดือนนั้น) →
//    overdueValuePct/overdueCountPct = null (ไม่ใช่ 0) ให้หน้าเว็บรู้ว่า "ไม่มีข้อมูล" ต่างจาก "ค้าง 0%"
// 8) nplChangeVsPreviousMonthEnd([]) → null; มี 1 จุด → previous=null, changeValuePts/changeCountPts=null
//    มี ≥2 จุด → previous=จุดก่อนสุดท้าย, changeValuePts=current.valuePct-previous.valuePct (บวก=แย่ลง)
// 9) nplChangeVsPreviousMonthEnd(monthly, 0) → previous=null เสมอ (เดือนแรกไม่มีเดือนก่อนหน้า)
//    nplChangeVsPreviousMonthEnd(monthly, 1) → current=monthly[1], previous=monthly[0] (ไม่ใช่เดือนล่าสุด)
//    เรียกไม่ส่ง index (undefined) → เหมือนเดิมทุกกรณี (เดือนล่าสุด vs ก่อนหน้า) — MorningBriefing ไม่พัง
