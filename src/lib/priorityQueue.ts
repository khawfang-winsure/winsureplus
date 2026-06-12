// ===== Priority Score สำหรับ Queue ติดตามหนี้ =====
// Pure function — ห้าม import Supabase / React / no new Date() ภายใน
// Types import แบบ "import type" เพื่อไม่ให้ runtime dep ดึง db.ts เข้า bundle
import type { ContractGrade, FollowUpResult } from './db'

// ---- Public interfaces -------------------------------------------------------

export interface PriorityInput {
  grade: ContractGrade // A-E (mandatory — null → fallback in caller)
  outstanding: number // ยอดค้าง บาท
  daysLate: number // วันที่ค้าง
  dnc: boolean
  lawyerEngaged: boolean
  disputed: boolean
  promiseToPayDate: string | null // ISO yyyy-mm-dd
  totalAttempts: number // count follow_ups ทั้งหมด (90-day window)
  successfulAttempts: number // count where result ∈ contacted/promised/paid/returned/other (90-day)
  lastResult: FollowUpResult | null // ผลลัพธ์ครั้งล่าสุด (any time)
  lastContactedAt: string | null // ISO timestamp (any time) — ใช้เช็ค 90-day gate
  contactedToday: boolean // มี follow_up วันนี้ที่ result ≠ 'no_answer'
}

export type PriorityTier = 'HOT' | 'WARM' | 'COLD' | 'ESCALATE'
export type SuppressReason = 'CAP' | 'DNC' | 'LAWYER' | 'PROMISE_PENDING' | null

export interface PriorityResult {
  score: number // 0-100 stable sort key
  tier: PriorityTier
  magnitudeScore: number // 0-80 (debug + UI display)
  warmthScore: number // -15 to +20 (debug + UI display)
  actionableNow: boolean // false → UI disable ปุ่ม "บันทึก"
  suppressReason: SuppressReason
}

// ---- ตารางน้ำหนักเกรด -------------------------------------------------------

const GRADE_MAGNITUDE: Record<ContractGrade, number> = {
  A: 10,
  B: 20,
  C: 30,
  D: 45,
  E: 60,
}

// ---- Helper: แปลง Date → yyyy-mm-dd (local time, ไม่ใช้ UTC เพื่อกัน off-by-one TH UTC+7) ----

function toLocalDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ---- Helper: เช็คว่า ISO timestamp อยู่ภายใน windowDays วันย้อนหลังจาก today ----

function withinDays(isoTimestamp: string | null, today: string, windowDays: number): boolean {
  if (!isoTimestamp) return false
  // ตัดเหลือแค่ date part (10 ตัวอักษร yyyy-mm-dd) แล้วเทียบ lexicographic
  const thatDate = isoTimestamp.slice(0, 10)
  // คำนวณ cutoff date = today - windowDays ผ่าน Date object
  const cutoff = new Date(`${today}T00:00:00`)
  cutoff.setDate(cutoff.getDate() - windowDays)
  const cutoffStr = toLocalDateString(cutoff)
  return thatDate >= cutoffStr
}

// ---- Core function -----------------------------------------------------------

/**
 * คำนวณ Priority Score สำหรับสัญญา 1 รายการ
 *
 * @param input - ข้อมูลสัญญา + ประวัติติดตาม
 * @param today - วันปัจจุบัน (caller pass new Date() — no internal now())
 * @returns PriorityResult — score, tier, magnitudeScore, warmthScore, actionableNow, suppressReason
 *
 * ---- Trace tests (verify กับสูตรที่ Pete locked) ----------------------------
 *
 * // Trace 1: WARM promise overdue
 * // Input: grade=D, daysLate=100, outstanding=12000, promise='2026-06-10', today='2026-06-12',
 * //        lastResult='promised', contactedToday=false, dnc=false, lawyer=false, disputed=false,
 * //        totalAttempts=3, successfulAttempts=1
 * // Magnitude: 45 + min(20,floor(12000/5000)) = 45+2 = 47
 * // Warmth: promise overdue (2026-06-10 < 2026-06-12) → +20 → score=67
 * // Tier: 40 ≤ 67 < 70 → WARM, actionableNow=true, suppressReason=null
 * // Result: { score:67, tier:'WARM', magnitudeScore:47, warmthScore:20, actionableNow:true, suppressReason:null }
 *
 * // Trace 2: HOT but CAP block
 * // Input: grade=E, daysLate=150, outstanding=30000, lastResult='contacted', contactedToday=true,
 * //        totalAttempts=5, successfulAttempts=3, promiseToPayDate=null
 * //        lastContactedAt=<within 90 days>, dnc=false, lawyerEngaged=false
 * // Magnitude: 60 + min(20, floor(30000/5000)=6) = 66
 * // Warmth: lastResult='contacted' within 90d → +10 → score=76
 * // Tier: 76 ≥ 70 → HOT, actionableNow=false (contactedToday→CAP), suppressReason='CAP'
 * // Result: { score:76, tier:'HOT', magnitudeScore:66, warmthScore:10, actionableNow:false, suppressReason:'CAP' }
 *
 * // Trace 3: ESCALATE
 * // Input: grade=C, daysLate=80, outstanding=8000, lastResult='no_answer', contactedToday=false,
 * //        totalAttempts=12, successfulAttempts=0, promiseToPayDate=null, dnc=false, lawyerEngaged=false
 * //        lastContactedAt=null
 * // Magnitude: 30 + floor(8000/5000)=1 → 31
 * // Warmth: successfulAttempts=0 AND totalAttempts≥10 → -15, ESCALATE override → score=16
 * // Tier: ESCALATE, actionableNow=true, suppressReason=null
 * // Result: { score:16, tier:'ESCALATE', magnitudeScore:31, warmthScore:-15, actionableNow:true, suppressReason:null }
 *
 * // Trace 4: PROMISE_PENDING suppress
 * // Input: grade=B, lastResult='promised', promiseToPayDate='2026-06-15' (future), today='2026-06-12',
 * //        contactedToday=false, totalAttempts=2, successfulAttempts=1, outstanding=5000
 * //        dnc=false, lawyerEngaged=false
 * // Magnitude: 20+1=21
 * // Warmth: lastResult='promised' AND promise not overdue → warmth=0 (suppress)
 * // Tier: 21 < 40 → COLD
 * // actionableNow=false, suppressReason='PROMISE_PENDING'
 * // Result: { score:21, tier:'COLD', magnitudeScore:21, warmthScore:0, actionableNow:false, suppressReason:'PROMISE_PENDING' }
 *
 * // Trace 5: DNC block + high magnitude
 * // Input: grade=E, dnc=true, outstanding=15000, lastResult=null, contactedToday=false,
 * //        totalAttempts=0, successfulAttempts=0, promiseToPayDate=null, lawyerEngaged=false
 * //        lastContactedAt=null
 * // Magnitude: 60+3=63, Warmth: 0 (no other modifier) → score=63
 * // Tier: 40 ≤ 63 < 70 → WARM
 * // actionableNow=false, suppressReason='DNC' (priority DNC > anything else)
 * // Result: { score:63, tier:'WARM', magnitudeScore:63, warmthScore:0, actionableNow:false, suppressReason:'DNC' }
 *
 * // Trace 6: Clean low score
 * // Input: grade=A, outstanding=2000, lastResult=null, contactedToday=false, totalAttempts=0,
 * //        successfulAttempts=0, promiseToPayDate=null, dnc=false, lawyerEngaged=false
 * //        lastContactedAt=null
 * // Magnitude: 10+0=10, Warmth: 0 → score=10
 * // Tier: COLD, actionableNow=true, suppressReason=null
 * // Result: { score:10, tier:'COLD', magnitudeScore:10, warmthScore:0, actionableNow:true, suppressReason:null }
 *
 * // Trace 7: ESCALATE override แม้ lastResult='refused'
 * // Input: grade=C, daysLate=60, outstanding=5000, lastResult='refused', contactedToday=false,
 * //        totalAttempts=10, successfulAttempts=0, promiseToPayDate=null,
 * //        dnc=false, lawyerEngaged=false, lastContactedAt=null
 * // Magnitude: 30 + min(20, floor(5000/5000)=1) = 31
 * // Warmth: lastResult='refused' → 0
 * // score: 31
 * // ESCALATE override: successfulAttempts=0 && totalAttempts≥10 → true → tier='ESCALATE'
 * // actionableNow=true, suppressReason=null
 * // Result: { score:31, tier:'ESCALATE', magnitudeScore:31, warmthScore:0, actionableNow:true, suppressReason:null }
 *
 * NOTE: lastContactedAt > 90 days case ไม่มีใน trace — implement ตาม spec แต่ไม่ได้ verified ผ่าน trace
 */
export function computePriorityScore(input: PriorityInput, today: Date): PriorityResult {
  const todayStr = toLocalDateString(today)

  // ---- 1. Magnitude (0-80) --------------------------------------------------
  // grade score + outstanding modifier (ทุก 5,000 บาท = +1, cap 20)
  const gradeScore = GRADE_MAGNITUDE[input.grade]
  const outstandingMod = Math.min(20, Math.floor(input.outstanding / 5000))
  const magnitudeScore = gradeScore + outstandingMod

  // ---- 2. Promise overdue flag (คำนวณครั้งเดียว ใช้ทั้ง warmth + suppress) ---
  const promiseOverdue =
    input.promiseToPayDate !== null && input.promiseToPayDate < todayStr

  const promisePending =
    input.lastResult === 'promised' &&
    input.promiseToPayDate !== null &&
    input.promiseToPayDate >= todayStr

  // ---- 3. Warmth (-15 to +20) — single-select branches ไม่ additive ----------
  let warmthScore = 0

  if (promiseOverdue) {
    // promise นัดแล้วแต่เลยกำหนด → +20 (priority สูงสุด)
    warmthScore = 20
  } else if (promisePending) {
    // promise นัดและยังอยู่ในอนาคต → warmth = 0 (suppress จัดการใน actionableNow)
    warmthScore = 0
  } else if (input.lastResult === 'contacted' && withinDays(input.lastContactedAt, todayStr, 90)) {
    // เคยติดต่อสำเร็จ ภายใน 90 วัน → +10
    warmthScore = 10
  } else if (input.lastResult === 'refused') {
    // ปฏิเสธ → 0
    warmthScore = 0
  } else if (input.successfulAttempts === 0 && input.totalAttempts >= 10) {
    // โทร 10 ครั้งขึ้นไปไม่ผ่านเลย → -15
    warmthScore = -15
  } else if (input.successfulAttempts === 0 && input.totalAttempts >= 5) {
    // โทร 5-9 ครั้งไม่ผ่านเลย → -10
    warmthScore = -10
  }
  // else: warmth คงเป็น 0 (กรณี lastResult=null, 'paid', 'returned', 'other', totalAttempts<5)

  // ESCALATE override — ตรวจ independent จาก lastResult branch
  // refused + 10 ครั้งไม่สำเร็จ = ยังควรเข้า ESCALATE (ไม่ใช่แค่ no_answer)
  const forceEscalate = input.successfulAttempts === 0 && input.totalAttempts >= 10

  // ---- 4. Score = clamp(magnitude + warmth, 0, 100) -------------------------
  const rawScore = magnitudeScore + warmthScore
  const score = Math.max(0, Math.min(100, rawScore))

  // ---- 5. Tier ---------------------------------------------------------------
  let tier: PriorityTier
  if (forceEscalate) {
    tier = 'ESCALATE'
  } else if (score >= 70) {
    tier = 'HOT'
  } else if (score >= 40) {
    tier = 'WARM'
  } else {
    tier = 'COLD'
  }

  // ---- 6. actionableNow + suppressReason ------------------------------------
  // Priority: DNC > LAWYER > CAP > PROMISE_PENDING
  let actionableNow = true
  let suppressReason: SuppressReason = null

  if (input.dnc) {
    actionableNow = false
    suppressReason = 'DNC'
  } else if (input.lawyerEngaged) {
    actionableNow = false
    suppressReason = 'LAWYER'
  } else if (input.contactedToday) {
    actionableNow = false
    suppressReason = 'CAP'
  } else if (promisePending) {
    actionableNow = false
    suppressReason = 'PROMISE_PENDING'
  }

  return {
    score,
    tier,
    magnitudeScore,
    warmthScore,
    actionableNow,
    suppressReason,
  }
}
