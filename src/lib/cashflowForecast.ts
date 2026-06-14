// ===== Cashflow Forecast — 3 เดือนข้างหน้า (pure function) =====
// ผู้บริหารดูว่าพอร์ตจะหมุนเข้าเท่าไหร่ — ไม่ยุ่งกับ UI / DB โดยตรง

export interface CashflowForecastInput {
  /** ค่างวดในอนาคต — schedule ที่ทราบ */
  upcomingInstallments: Array<{
    contractId: string
    dueDate: string          // 'YYYY-MM-DD'
    amount: number           // ค่างวด principal
    status: 'pending' | 'paid' | 'late'
    contractStatus: string   // 'active' | 'returned' | 'closed' | ...
    currentGrade: string | null  // 'A' | 'B' | 'C' | 'D' | 'E'
  }>

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

  // ─── 2) Group installments → เดือน (ใช้ string compare แทน Date() → timezone-safe) ──
  const monthBuckets = new Map<string, Array<(typeof input.upcomingInstallments)[number]>>()

  for (const inst of input.upcomingInstallments) {
    if (inst.contractStatus !== 'active') continue   // ข้าม returned/closed
    if (inst.status === 'paid') continue              // ข้ามที่จ่ายแล้ว
    if (inst.dueDate < input.todayISO) continue       // ข้ามที่ผ่านมาแล้ว (ISO string compare ปลอดภัย)

    const monthKey = inst.dueDate.slice(0, 7)         // 'YYYY-MM'
    if (!monthBuckets.has(monthKey)) monthBuckets.set(monthKey, [])
    monthBuckets.get(monthKey)!.push(inst)
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
  const months: CashflowForecastMonth[] = next3Months.map((monthKey) => {
    const bucket = monthBuckets.get(monthKey)!
    let expectedInflow = 0
    let expectedPaidCount = 0

    for (const inst of bucket) {
      const rate = inst.currentGrade != null
        ? (payRateByGrade[inst.currentGrade] ?? defaultRate)
        : defaultRate
      expectedInflow += inst.amount * rate
      expectedPaidCount += rate   // ผลรวม probability = งวดที่คาดว่าจะจ่าย
    }

    const year = Number(monthKey.slice(0, 4))
    const month = Number(monthKey.slice(5, 7))   // 1-12
    const monthLabel = `${TH_MON[month - 1]} ${String(year).slice(2)}`

    return {
      monthLabel,
      expectedInflow: Math.round(expectedInflow),
      expectedOutflow: Math.round(avgMonthlyOutflow),
      net: Math.round(expectedInflow - avgMonthlyOutflow),
      installmentCount: bucket.length,
      expectedPaidCount: Math.round(expectedPaidCount),
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
