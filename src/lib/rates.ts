// ===== ระบบเรตผ่อน (ตัวคูณต่อจำนวนงวด) — ฟังก์ชันบริสุทธิ์ แยกจาก UI/DB =====
// แนวคิด: ยอดจัดไฟแนนซ์ = ยอดต้น × ตัวคูณของจำนวนงวดนั้น ; ค่างวด = ยอด ÷ งวด
// เก็บเป็น "ชุดเรต" หลายชุด (รองรับโปรโมชันต่างเดือน + อนาคตผูกต่อร้านค้า)

export interface RateTier {
  term: number // จำนวนงวด (เดือน) เช่น 6, 12, 18
  multiplier: number // ตัวคูณยอดต้น เช่น 1.10
}

export interface RateSet {
  id: string
  name: string // เช่น "ปกติ", "โปรมิถุนายน 2026"
  active: boolean
  tiers: RateTier[]
}

/** ชุดเรตเริ่มต้น (เรต 0 = ยังไม่ตั้ง ให้แอดมินมากรอกจริง) */
export const DEFAULT_RATE_SETS: RateSet[] = [
  {
    id: 'default',
    name: 'ปกติ',
    active: true,
    tiers: [
      { term: 6, multiplier: 1 },
      { term: 12, multiplier: 1 },
      { term: 18, multiplier: 1 },
    ],
  },
]

/** ชุดเรตที่ใช้งานได้ (active) — ชุดแรกถือเป็นค่าเริ่มต้น */
export function activeRateSets(sets: RateSet[]): RateSet[] {
  return sets.filter((s) => s.active && s.tiers.length > 0)
}

/** หาตัวคูณของจำนวนงวดในชุดเรต (ตรงเป๊ะ) — ไม่พบคืน null */
export function multiplierFor(set: RateSet | undefined | null, term: number): number | null {
  if (!set) return null
  const t = set.tiers.find((x) => x.term === term)
  return t ? t.multiplier : null
}

/** รายการจำนวนงวดที่ตั้งเรตไว้ในชุดนั้น (เรียงน้อย→มาก) */
export function termsOf(set: RateSet | undefined | null): number[] {
  if (!set) return []
  return [...set.tiers].map((t) => t.term).sort((a, b) => a - b)
}

/** ยอดจัดไฟแนนซ์ = ยอดต้น × ตัวคูณ (ปัดเศษ) */
export function financeFromPrincipal(principal: number, multiplier: number): number {
  return Math.round(principal * multiplier)
}

/** ค่างวด = ยอดจัดไฟแนนซ์ ÷ จำนวนงวด (ปัดเศษ) */
export function monthlyFrom(finance: number, term: number): number {
  return term > 0 ? Math.round(finance / term) : 0
}
