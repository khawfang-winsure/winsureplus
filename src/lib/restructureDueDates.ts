// พรีวิววันครบกำหนดงวดใหม่ของการขยายระยะเวลา/เปลี่ยนวันชำระ
// มิเรอร์กติกาใน RPC restructure_contract (pure function — รับ today เป็นพารามิเตอร์)
//
// กติกา: คำนวณวันครบกำหนดในเดือนปัจจุบันก่อน (clamp ปลายเดือน)
//   - ถ้า "มากกว่าวันนี้" → งวดที่ 1 อยู่เดือนนี้
//   - ถ้า "น้อยกว่าหรือเท่ากับวันนี้" → งวดที่ 1 อยู่เดือนหน้า
//   งวดถัดไปบวกทีละเดือน และ clamp ปลายเดือนทุกงวด
// "วันนี้" = วันที่ตามเวลาไทย (Asia/Bangkok) ไม่ขึ้นกับ timezone ของเครื่อง

export interface YMD {
  y: number
  m: number // 1-based
  d: number
}

/** วันนี้ตามเวลาไทย */
export function todayBangkok(now: Date = new Date()): YMD {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0')
  return { y: get('year'), m: get('month'), d: get('day') }
}

function daysInMonth(y: number, m1: number): number {
  return new Date(Date.UTC(y, m1, 0)).getUTCDate()
}

/** วันครบกำหนดของงวดที่ installmentNo (เริ่มที่ 1) */
export function restructureDueDate(installmentNo: number, dueDay: number, today: YMD): YMD {
  const thisMonthDay = Math.min(dueDay, daysInMonth(today.y, today.m))
  const firstOffset = thisMonthDay > today.d ? 0 : 1
  const idx = today.m - 1 + firstOffset + (installmentNo - 1)
  const y = today.y + Math.floor(idx / 12)
  const m = ((idx % 12) + 12) % 12 + 1
  return { y, m, d: Math.min(dueDay, daysInMonth(y, m)) }
}

/** รูปแบบ dd/mm/yyyy */
export function formatRestructureDueDate(installmentNo: number, dueDay: number, today: YMD): string {
  const r = restructureDueDate(installmentNo, dueDay, today)
  return `${String(r.d).padStart(2, '0')}/${String(r.m).padStart(2, '0')}/${r.y}`
}

/** คืน [] ถ้าผ่านหมด, คืน list ข้อความ error ถ้ามี case พลาด (เรียกเองใน test/console) */
export function validateRestructureDueDates(): string[] {
  const errs: string[] = []
  const cases: Array<[string, YMD, number, number, string]> = [
    ['16/11 day30 n1', { y: 2026, m: 11, d: 16 }, 30, 1, '30/11/2026'],
    ['16/11 day30 n4', { y: 2026, m: 11, d: 16 }, 30, 4, '28/02/2027'],
    ['16/11 day30 n9', { y: 2026, m: 11, d: 16 }, 30, 9, '30/07/2027'],
    ['16/11 day16 n1', { y: 2026, m: 11, d: 16 }, 16, 1, '16/12/2026'],
    ['16/11 day5 n1', { y: 2026, m: 11, d: 16 }, 5, 1, '05/12/2026'],
    ['31/01 day31 n1', { y: 2027, m: 1, d: 31 }, 31, 1, '28/02/2027'],
    ['15/12 day31 n1', { y: 2026, m: 12, d: 15 }, 31, 1, '31/12/2026'],
    ['15/12 day31 n2', { y: 2026, m: 12, d: 15 }, 31, 2, '31/01/2027'],
  ]
  for (const [name, today, day, n, want] of cases) {
    const got = formatRestructureDueDate(n, day, today)
    if (got !== want) errs.push(`${name}: got ${got} (want ${want})`)
  }
  return errs
}
