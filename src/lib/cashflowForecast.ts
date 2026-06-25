// ===== Cashflow Forecast — 3 เดือนข้างหน้า (pure function) =====
// ผู้บริหารดูว่าพอร์ตจะหมุนเข้าเท่าไหร่ — ไม่ยุ่งกับ UI / DB โดยตรง
// เฟส B: เปลี่ยน input จาก raw installments → ForecastByGradeRow[] (aggregate view) ไม่ติด PAGE_CAP

import type { ForecastByGradeRow } from './db'

export interface CashflowForecastInput {
  /**
   * ยอดคาดรับงวดในอนาคต แยกตาม (เดือน, grade/bucket) จาก v_forecast_monthly_by_grade
   * เฟส B: แทน upcomingInstallments[] เดิม ไม่ติด PAGE_CAP
   */
  forecastRows: ForecastByGradeRow[]

  /**
   * เงินที่ต้องโอนออกให้ร้านย้อนหลัง 3 เดือน (รายเดือน)
   * ระบบไม่มี future outflow ที่แน่นอน → ใช้ค่าเฉลี่ยจากอดีตแทน
   */
  pastMonthlyOutflows: number[]

  /** วันที่อ้างอิง (วันนี้) 'YYYY-MM-DD' */
  todayISO: string
}

export interface CashflowForecastMonth {
  monthLabel: string         // 'ก.ค. 26'
  expectedInflow: number     // เงินเข้าคาดหวัง (จากค่างวด × probability)
  expectedOutflow: number    // เงินออกคาดหวัง (เฉลี่ยอดีต)
  net: number                // inflow - outflow
  installmentCount: number   // จำนวนงวดที่ครบกำหนดในเดือนนี้
  expectedPaidCount: number  // คาดว่าจะจ่ายกี่งวด (ผลรวม probability แต่ละงวด)
}

export interface CashflowForecastResult {
  /** 3 เดือนแรกที่มีงวดครบกำหนด (window = first-3-nonempty buckets ไม่ใช่ calendar window) */
  months: CashflowForecastMonth[]
  totalExpectedInflow: number
  totalExpectedOutflow: number
  totalNet: number
  assumptions: {
    payRateByGrade: Record<string, number>  // % คาดว่าจะจ่ายตรงต่อ grade
    avgMonthlyOutflow: number
  }
}

// ชื่อเดือนไทยย่อ — hoist ออกนอก loop เพื่อไม่สร้างใหม่ทุกรอบ
const TH_MON = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
]


export function buildCashflowForecast(input: CashflowForecastInput): CashflowForecastResult {
  // ─── 1) อัตราความน่าจะเป็นจ่ายตรงต่อ grade ─────────────────────────────────
  // baseline ค่าเริ่มต้น — Pete สามารถ override ผ่าน settings อนาคตได้
  const payRateByGrade: Record<string, number> = {
    A: 0.95,
    B: 0.85,
    C: 0.70,
    D: 0.50,
    E: 0.25,
  }
  const defaultRate = 0.50  // ไม่มี grade (ลูกค้าใหม่ / ข้อมูลเก่า)

  // ─── 2) Group forecastRows → เดือน (ใช้ string compare → timezone-safe) ──────
  // forecastRows มี dueMonth เป็น 'YYYY-MM-DD' (วันที่ 1 ของเดือน)
  // กรอง: เฉพาะเดือนที่ dueMonth >= todayISO[:7] (เดือนปัจจุบันขึ้นไป)
  const todayMonth = input.todayISO.slice(0, 7) // 'YYYY-MM'

  // Map<monthYYYYMM, { expectedInflow, installmentCount, expectedPaidCount }>
  type MonthBucket = { expectedInflow: number; installmentCount: number; expectedPaidCount: number }
  const monthBuckets = new Map<string, MonthBucket>()

  for (const row of input.forecastRows) {
    const rowMonth = row.dueMonth.slice(0, 7) // 'YYYY-MM'
    if (rowMonth < todayMonth) continue        // ข้ามเดือนที่ผ่านมาแล้ว

    // row.grade มาจาก v_contract_status: grade_for_days_late() → 'A'|'B'|'C'|'D'|'E'|null
    // null → coalesced เป็น 'unknown' ใน view → ตก defaultRate (ถูกต้อง)
    const rate = payRateByGrade[row.grade] ?? defaultRate
    const inflow = row.expectedAmount * rate
    const paidCount = row.installmentCount * rate

    const existing = monthBuckets.get(rowMonth)
    if (existing) {
      existing.expectedInflow += inflow
      existing.installmentCount += row.installmentCount
      existing.expectedPaidCount += paidCount
    } else {
      monthBuckets.set(rowMonth, {
        expectedInflow: inflow,
        installmentCount: row.installmentCount,
        expectedPaidCount: paidCount,
      })
    }
  }

  // ─── 3) คัด 3 เดือนแรกที่มีข้อมูล (ตามลำดับเวลา) ──────────────────────────
  const sortedMonths = Array.from(monthBuckets.keys()).sort()
  const next3Months = sortedMonths.slice(0, 3)

  // ─── 4) เฉลี่ยเงินออก ────────────────────────────────────────────────────────
  const avgMonthlyOutflow =
    input.pastMonthlyOutflows.length > 0
      ? input.pastMonthlyOutflows.reduce((a, b) => a + b, 0) / input.pastMonthlyOutflows.length
      : 0

  // ─── 5) คำนวณรายเดือน ────────────────────────────────────────────────────────
  const months: CashflowForecastMonth[] = next3Months.map((mk) => {
    const bucket = monthBuckets.get(mk)!

    const year = Number(mk.slice(0, 4))
    const month = Number(mk.slice(5, 7))   // 1-12
    const monthLabel = `${TH_MON[month - 1]} ${String(year).slice(2)}`

    return {
      monthLabel,
      expectedInflow: Math.round(bucket.expectedInflow),
      expectedOutflow: Math.round(avgMonthlyOutflow),
      net: Math.round(bucket.expectedInflow - avgMonthlyOutflow),
      installmentCount: bucket.installmentCount,
      expectedPaidCount: Math.round(bucket.expectedPaidCount),
    }
  })

  // ─── 6) Summary ──────────────────────────────────────────────────────────────
  return {
    months,
    totalExpectedInflow: months.reduce((s, m) => s + m.expectedInflow, 0),
    totalExpectedOutflow: months.reduce((s, m) => s + m.expectedOutflow, 0),
    totalNet: months.reduce((s, m) => s + m.net, 0),
    assumptions: {
      payRateByGrade,
      avgMonthlyOutflow: Math.round(avgMonthlyOutflow),
    },
  }
}
