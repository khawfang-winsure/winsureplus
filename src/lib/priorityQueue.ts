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

// ===== ฟังก์ชันสำหรับฟีเจอร์ "ศูนย์ประสานงานลูกค้า" (เพิ่ม 2026-06-18) =====
// ยังไม่ wire เข้า UI — logic ตาม Pete spec รอบหน้า

// ---- Function 1: hasUnseenUpdate — badge "มีอัปเดตใหม่" ----------------------

/**
 * ตรวจว่า "คนอื่น" บันทึกล่าสุด หลังจากที่ผู้ใช้คนนี้แตะเคสครั้งล่าสุดหรือไม่
 *
 * @param myLastTouchAt     - timestamptz ที่ฉันแตะเคสล่าสุด (max ของ queue_case_seen + follow_ups ของตัวเอง)
 *                            null = ยังไม่เคยแตะเคสนี้เลย
 * @param latestOtherAuthorAt - timestamptz ที่ "คนอื่น" (author ≠ ฉัน) บันทึกล่าสุด
 *                              null = ไม่มีคนอื่นบันทึกใดๆ
 * @returns true = มีอัปเดตที่ฉันยังไม่ได้เห็น → แสดง badge
 *
 * ⚠️ WHY EPOCH COMPARE: timestamptz จาก PostgREST อาจมาในรูป "2026-06-18T10:00:00+00:00"
 * ส่วน client-side อาจเก็บเป็น "2026-06-18T10:00:00Z" — ตัวอักษร '+' (ASCII 43) < 'Z' (ASCII 90)
 * ทำให้ string compare ตรงๆ บอกว่า "+00:00" มาก่อน "Z" ทั้งที่แทน timestamp เดียวกัน
 * → badge จะกลับด้านเงียบๆ โดยไม่มี error. วิธีแก้: แปลงเป็น epoch ms ก่อนเทียบเสมอ
 *
 * Rules (Pete decision — เด้งกว้าง):
 *   latestOtherAuthorAt == null → false
 *   myLastTouchAt == null       → true  (คนอื่นบันทึกอยู่ แต่ฉันยังไม่เคยเปิดเลย)
 *   latestOtherAuthorAt > myLastTouchAt (epoch) → true
 *   else → false  (timestamps เท่ากันพอดี = ถือว่าเห็นแล้ว)
 *
 * ---- Trace tests ---------------------------------------------------------------
 * // T1: ฉันยังไม่เคยแตะ + มีคนอื่นบันทึก
 * // hasUnseenUpdate(null, '2026-06-18T10:00:00+00:00') → true
 * // (myLastTouchAt=null → คืน true ทันที)
 *
 * // T2: คนอื่นบันทึกหลังฉัน
 * // hasUnseenUpdate('2026-06-18T09:00:00Z', '2026-06-18T11:00:00+00:00') → true
 * // epoch('11:00+00:00') === epoch('11:00Z') (string ต่างแต่ค่าเดียวกัน)
 * // epoch('11:00Z') > epoch('09:00Z') → true
 *
 * // T3: ฉันแตะหลังคนอื่น
 * // hasUnseenUpdate('2026-06-18T12:00:00Z', '2026-06-18T10:00:00+00:00') → false
 * // epoch('12:00Z') > epoch('10:00Z') → ไม่มีของใหม่
 *
 * // T4: ไม่มีใครบันทึกเลย
 * // hasUnseenUpdate(null, null) → false
 * // (latestOtherAuthorAt=null → คืน false ทันที)
 */
export function hasUnseenUpdate(
  myLastTouchAt: string | null,
  latestOtherAuthorAt: string | null,
): boolean {
  // Rule 1: ไม่มีคนอื่นบันทึกเลย → ไม่มีของใหม่
  if (latestOtherAuthorAt === null) return false

  // Rule 2: ฉันยังไม่เคยแตะ + มีคนอื่นบันทึก → ถือว่ามีของใหม่
  if (myLastTouchAt === null) return true

  // Rule 3: เทียบ epoch ms เพื่อหลีกเลี่ยง "+00:00" vs "Z" string compare bug
  const otherEpoch = new Date(latestOtherAuthorAt).getTime()
  const myEpoch = new Date(myLastTouchAt).getTime()

  // NaN guard: ถ้า parse ไม่ได้ (timestamp รูปแบบผิด) → ถือว่าไม่มีของใหม่ (safe default)
  if (isNaN(otherEpoch) || isNaN(myEpoch)) return false

  // strict >: timestamps เท่ากันพอดี = ฉันเห็นแล้ว → false
  return otherEpoch > myEpoch
}

// ---- Function 2: sortQueue — เคสนัดจ่ายเด้งขึ้นก่อน (Pete: ภายใน 7 วัน) ----

/**
 * จัด queue ให้เคสนัดจ่ายลอยขึ้นก่อน แบ่งเป็น 3 กลุ่ม (ไม่ mutate input)
 *
 * @param rows  - แถว queue; ต้องมี tier, score, promiseToPayDate ที่ root level
 *               (ถ้า ScoredRow ยังไม่มี promiseToPayDate ให้ db.ts/caller map ขึ้นมาก่อน)
 * @param today - วันปัจจุบัน รูป "yyyy-mm-dd" (caller pass — ไม่ new Date() เองในฟังก์ชัน)
 * @returns สำเนา array ที่จัดเรียงใหม่ตาม 3 กลุ่ม:
 *   P1 (group 0) — promise overdue: promiseToPayDate < today → เรียง ASC by date (เลยนานสุดก่อน)
 *   P2 (group 1) — promise ใกล้ถึง ≤ 7 วัน: today ≤ date ≤ today+7 → เรียง ASC by date (ใกล้สุดก่อน)
 *   P3 (group 2) — ที่เหลือ: date == null หรือ date > today+7 → เรียงตาม tier (HOT→WARM→COLD→ESCALATE) + score DESC
 *
 * ⚠️ promiseToPayDate เป็น yyyy-mm-dd plain date (ไม่ใช่ timestamptz)
 *    → ใช้ lexicographic string compare ได้ถูกต้อง (pattern เดียวกับ computePriorityScore บรรทัด 156)
 *    ไม่ต้องแปลงเป็น epoch
 *
 * ⚠️ Pete decision (7-day window):
 *    เคสนัดอีก 20 วัน ต้องตกไป P3 (เรียงตามคะแนนปกติ) ไม่ใช่ P2
 *    window 7 วัน = today+7 วัน inclusive (date === today+7 → P2)
 *
 * ---- Trace tests (today สมมติ = '2026-06-18') ----------------------------------
 * // สมมติ rows:
 * //   A: { promiseToPayDate:'2026-06-15', tier:'WARM', score:50 }  ← promise เลย 3 วัน
 * //   B: { promiseToPayDate:'2026-06-20', tier:'COLD', score:25 }  ← นัดอีก 2 วัน (≤7)
 * //   C: { promiseToPayDate:null,         tier:'HOT',  score:76 }  ← ไม่มี promise
 * //   D: { promiseToPayDate:'2026-07-08', tier:'WARM', score:55 }  ← นัดอีก 20 วัน (>7)
 * //
 * // today+7 = '2026-06-25'
 * // A: '2026-06-15' < '2026-06-18' → P1
 * // B: '2026-06-18' ≤ '2026-06-20' ≤ '2026-06-25' → P2
 * // C: null → P3 (HOT, score=76)
 * // D: '2026-07-08' > '2026-06-25' → P3 (WARM, score=55)
 * //
 * // Expected order: [A, B, C, D]
 * //   A (P1 overdue '2026-06-15')
 * //   B (P2 upcoming '2026-06-20')
 * //   C (P3 HOT > WARM → score 76 > 55 → C ก่อน D)
 * //   D (P3 WARM, score 55)
 */

// TIER_ORDER สำหรับ P3 sort (local — ห้าม import จาก page component)
// HOT=0 (สูงสุด) → ESCALATE=3 (ต่ำสุดในการแสดง แต่ยังอยู่ใต้ HOT/WARM/COLD ใน sort)
const TIER_ORDER_LOCAL: Record<PriorityTier, number> = {
  HOT: 0,
  WARM: 1,
  COLD: 2,
  ESCALATE: 3,
}

export function sortQueue<
  T extends { tier: PriorityTier; score: number; promiseToPayDate: string | null },
>(rows: T[], today: string): T[] {
  // คำนวณ today+7 วัน (yyyy-mm-dd) ผ่าน Date object — reuse pattern ของ withinDays (line 61)
  const todayPlus7Date = new Date(`${today}T00:00:00`)
  todayPlus7Date.setDate(todayPlus7Date.getDate() + 7)
  const todayPlus7 = toLocalDateString(todayPlus7Date)

  // แบ่ง 3 กลุ่ม (ไม่ mutate input — ใช้ filter สร้าง array ใหม่)
  const p1: T[] = [] // promise overdue: date < today
  const p2: T[] = [] // promise ≤ 7 วัน: today ≤ date ≤ today+7
  const p3: T[] = [] // ที่เหลือ: null หรือ date > today+7

  for (const row of rows) {
    const d = row.promiseToPayDate
    if (d !== null && d < today) {
      p1.push(row)
    } else if (d !== null && d >= today && d <= todayPlus7) {
      p2.push(row)
    } else {
      p3.push(row) // null หรือ d > todayPlus7
    }
  }

  // P1: เลยกำหนดนานสุดก่อน (ASC by date — '2026-06-10' < '2026-06-15' → ขึ้นก่อน)
  p1.sort((a, b) => {
    const da = a.promiseToPayDate! // guaranteed non-null (อยู่ P1)
    const db = b.promiseToPayDate!
    return da < db ? -1 : da > db ? 1 : 0
  })

  // P2: ใกล้ถึงสุดก่อน (ASC by date — '2026-06-20' < '2026-06-25' → ขึ้นก่อน)
  p2.sort((a, b) => {
    const da = a.promiseToPayDate!
    const db = b.promiseToPayDate!
    return da < db ? -1 : da > db ? 1 : 0
  })

  // P3: เรียงตาม tier (HOT→WARM→COLD→ESCALATE) + score DESC ในกลุ่มเดียวกัน
  p3.sort((a, b) => {
    const tierDiff = TIER_ORDER_LOCAL[a.tier] - TIER_ORDER_LOCAL[b.tier]
    if (tierDiff !== 0) return tierDiff
    return b.score - a.score // score สูงกว่าขึ้นก่อน
  })

  return [...p1, ...p2, ...p3]
}

// ===== Function 3: getPromiseDateStatus — สัญลักษณ์เตือนวันนัดชำระ (เพิ่ม 2026-06-27) =====
// pure fn — UI (Inbox / queue / customer detail) เอาไปแสดงป้ายเตือนวันนัด

export type PromiseDateStatus =
  | 'overdue' // เลยวันนัดมาแล้ว (days < 0)
  | 'due_today' // นัดวันนี้ (days === 0)
  | 'due_tomorrow' // นัดพรุ่งนี้ (days === 1)
  | 'upcoming' // นัดในอนาคต > 1 วัน (days > 1)
  | 'none' // ไม่มีวันนัด

/**
 * แปลงวันนัดชำระ → สถานะ + จำนวนวันห่างจากวันนี้ (date-only, เขต Asia/Bangkok)
 *
 * @param promiseToPayDate - วันนัด 'yyyy-mm-dd' (หรือ null/undefined ถ้าไม่มี)
 * @param today            - วันนี้ 'yyyy-mm-dd'; ถ้าไม่ส่ง = วันนี้ตามเครื่อง (local time,
 *                           ใช้ toLocalDateString เดียวกับ withinDays/sortQueue กัน off-by-one TH UTC+7)
 * @returns { status, days } — days = (promise - today) เป็นจำนวนวันเต็ม
 *                             (ติดลบ = เลยมาแล้ว, 0 = วันนี้, 1 = พรุ่งนี้); null ถ้าไม่มีวันนัด
 *
 * ⚠️ ทำไมต้อง parse แบบ 'yyyy-mm-ddT00:00:00' (ไม่ใส่ Z):
 *    new Date('2026-06-27') ถูก parse เป็น UTC midnight → ใน TH (UTC+7) กลายเป็น 07:00 ของวันเดียวกัน
 *    แต่บางเคส (เวลาเครื่องคนละ tz) อาจเพี้ยนเป็นคนละวัน. การเติม 'T00:00:00' บังคับ parse เป็น local midnight
 *    → diff เป็น whole-day ตรงเสมอ (pattern เดียวกับ sortQueue บรรทัด 354)
 *
 * ---- Trace tests (today สมมติ = '2026-06-27') ----------------------------------
 * // overdue:      getPromiseDateStatus('2026-06-25', '2026-06-27') → { status:'overdue',      days:-2 }
 * // due_today:    getPromiseDateStatus('2026-06-27', '2026-06-27') → { status:'due_today',    days:0  }
 * // due_tomorrow: getPromiseDateStatus('2026-06-28', '2026-06-27') → { status:'due_tomorrow', days:1  }
 * // upcoming:     getPromiseDateStatus('2026-07-05', '2026-06-27') → { status:'upcoming',     days:8  }
 * // none (null):  getPromiseDateStatus(null,         '2026-06-27') → { status:'none',         days:null }
 * // none (undef): getPromiseDateStatus(undefined,    '2026-06-27') → { status:'none',         days:null }
 * // ข้ามเดือน:    getPromiseDateStatus('2026-07-01', '2026-06-27') → { status:'upcoming',     days:4  }
 */
// ===== isHardBlocked — soft-warn migration (เพิ่ม 2026-07-01) =====
// คืน true เฉพาะเคสที่ต้อง hard-block ปุ่ม "บันทึกติดตาม" (DNC / ทนาย / นอกเวลา)
// CAP / PROMISE_PENDING → false (soft-warn แทน — โชว์แถบเตือนในป็อปอัพแทนการล็อกปุ่ม)
//
// Trace tests:
//   isHardBlocked(false, 'CAP')            → false
//   isHardBlocked(false, 'PROMISE_PENDING') → false
//   isHardBlocked(true, null)              → true
//   isHardBlocked(false, 'DNC')            → true
//   isHardBlocked(false, 'LAWYER')         → true
//   isHardBlocked(false, null)             → false
export function isHardBlocked(
  outsideHours: boolean,
  suppressReason: SuppressReason,
): boolean {
  return outsideHours || suppressReason === 'DNC' || suppressReason === 'LAWYER'
}

export function getPromiseDateStatus(
  promiseToPayDate: string | null | undefined,
  today?: string,
): { status: PromiseDateStatus; days: number | null } {
  if (!promiseToPayDate) return { status: 'none', days: null }

  const todayStr = today ?? toLocalDateString(new Date())

  // parse เป็น local midnight (เติม T00:00:00) → diff เป็น whole-day ไม่เพี้ยนข้าม tz
  const promiseMs = new Date(`${promiseToPayDate}T00:00:00`).getTime()
  const todayMs = new Date(`${todayStr}T00:00:00`).getTime()

  // NaN guard: รูปแบบวันที่ผิด → ถือว่าไม่มีวันนัด (safe default)
  if (isNaN(promiseMs) || isNaN(todayMs)) return { status: 'none', days: null }

  const MS_PER_DAY = 86_400_000
  const days = Math.round((promiseMs - todayMs) / MS_PER_DAY)

  let status: PromiseDateStatus
  if (days < 0) status = 'overdue'
  else if (days === 0) status = 'due_today'
  else if (days === 1) status = 'due_tomorrow'
  else status = 'upcoming'

  return { status, days }
}
