// ===== KPI คำนวณ Performance Freelancer (Pure Functions) =====
// ไม่มี side-effect, ไม่มี I/O — ทดสอบได้เองโดยไม่ต้อง mock DB
// ใช้กับ getFreelancerPerformance() ใน db.ts
//
// Pete locked (2026-06-12):
//   Attribution window = 7 วัน
//   Tie-breaker split equally (promiseKeptCredit ส่งมาจาก v_promise_attribution_30d แบบ pre-computed)
//   Staff = เห็นทุกคน
//   Outstanding = แสดงทั้ง 2 (penaltyDue + principalDue)

// ============================================================================
// Types
// ============================================================================

export interface PerformanceInput {
  // จาก v_freelancer_performance_30d (ผ่าน getFreelancerPerformance)
  totalAttempts: number
  successfulAttempts: number     // result ∈ ('contacted','promised','paid','returned','other')
  promiseCount: number           // result = 'promised'
  resolutionCount: number        // result ∈ ('paid','returned')
  uniqueContracts: number        // distinct contract_id ที่ติดต่อ

  // attribution data — จาก v_promise_attribution_30d (Wave 2)
  // promiseKeptCredit: credit sum หลัง split-equally (1/N per co-promise group)
  // promisesTotal: denominator = promises ที่มี next_follow_up_at ใน 30 วัน
  promiseKeptCount: number       // raw row count ของ promises ที่ kept (informational)
  promiseKeptCredit: number      // split-equally credit sum (numerator ของ promiseKeepRate)
  promisesTotal: number          // promises ทั้งหมดที่มี next_follow_up_at (denominator)

  // escalation + assignment data — จาก v_grade_escalate_counts + v_grade_active_counts (Wave 2)
  escalateContracts: number      // สัญญาในเกรดที่ assigned + ESCALATE tier
  totalAssigned: number          // สัญญา active ทั้งหมดในเกรดที่ assigned (denominator)
}

export interface PerformanceKPIs {
  // null = N/A ตาม denominator=0 (ติ๊ก YELLOW #6 — น้องวิว render N/A แทน number)
  contactRate: number | null     // unique_contracts / total_assigned × 100
  promiseRate: number | null     // promise_count / successful_attempts × 100
  promiseKeepRate: number | null // promiseKeptCredit / promisesTotal × 100 (split-equally)
  resolutionRate: number | null  // resolution_count / total_attempts × 100
  escalationRate: number | null  // escalate_contracts / total_assigned × 100
}

// ============================================================================
// Core: computePerformanceKPIs
// ============================================================================

/**
 * คำนวณ KPI 5 ตัวจาก PerformanceInput
 * ทุก rate ปัดเป็น 1 ตำแหน่ง (Math.round ×10 /10 เพื่อคงเป็น number)
 * Division-by-zero → null (N/A sentinel; น้องวิว Wave 3 render "N/A" แทน number)
 *
 * N/A แยกตาม denominator ของแต่ละ rate:
 *   contactRate   → null ถ้า totalAssigned = 0
 *   promiseRate   → null ถ้า successfulAttempts = 0
 *   promiseKeepRate → null ถ้า promisesTotal = 0
 *   resolutionRate → null ถ้า totalAttempts = 0
 *   escalationRate → null ถ้า totalAssigned = 0
 *
 * หมายเหตุ split-equally:
 *   promiseKeepRate ใช้ promiseKeptCredit (1/N per group) เป็น numerator
 *   ดังนั้นถ้า freelancer เป็น sole promisor เสมอ → rate ปกติ
 *   ถ้า co-work promises เสมอ → rate ต่ำกว่า 100% แม้ทุก promise ถูก kept
 *   flag ไว้สำหรับ Pete ถ้าต้องการ denominator-weighted ด้วย
 *
 * @example
 * // High performer (sole promisor every time)
 * computePerformanceKPIs({
 *   totalAttempts: 50, successfulAttempts: 40, promiseCount: 20, resolutionCount: 10,
 *   uniqueContracts: 30, promiseKeptCount: 15, promiseKeptCredit: 15, promisesTotal: 20,
 *   escalateContracts: 1, totalAssigned: 50
 * })
 * // → { contactRate: 60.0, promiseRate: 50.0, promiseKeepRate: 75.0, resolutionRate: 20.0, escalationRate: 2.0 }
 *
 * @example
 * // No assigned contracts (all denominators 0 → N/A)
 * computePerformanceKPIs({
 *   totalAttempts: 0, successfulAttempts: 0, promiseCount: 0, resolutionCount: 0,
 *   uniqueContracts: 0, promiseKeptCount: 0, promiseKeptCredit: 0, promisesTotal: 0,
 *   escalateContracts: 0, totalAssigned: 0
 * })
 * // → { contactRate: null, promiseRate: null, promiseKeepRate: null, resolutionRate: null, escalationRate: null }
 *
 * @example
 * // Assigned contracts but no activity (totalAttempts=0)
 * computePerformanceKPIs({
 *   totalAttempts: 0, successfulAttempts: 0, promiseCount: 0, resolutionCount: 0,
 *   uniqueContracts: 0, promiseKeptCount: 0, promiseKeptCredit: 0, promisesTotal: 0,
 *   escalateContracts: 0, totalAssigned: 20
 * })
 * // → { contactRate: 0, promiseRate: null, promiseKeepRate: null, resolutionRate: null, escalationRate: 0 }
 *
 * @example
 * // All promised, none paid (promiseKeepRate = 0, not N/A because promisesTotal > 0)
 * computePerformanceKPIs({
 *   totalAttempts: 10, successfulAttempts: 8, promiseCount: 8, resolutionCount: 0,
 *   uniqueContracts: 5, promiseKeptCount: 0, promiseKeptCredit: 0, promisesTotal: 8,
 *   escalateContracts: 0, totalAssigned: 10
 * })
 * // → { contactRate: 50.0, promiseRate: 100.0, promiseKeepRate: 0, resolutionRate: 0, escalationRate: 0 }
 *
 * @example
 * // No promises at all (promisesTotal=0 → promiseKeepRate N/A; but had successful contacts)
 * computePerformanceKPIs({
 *   totalAttempts: 5, successfulAttempts: 5, promiseCount: 0, resolutionCount: 3,
 *   uniqueContracts: 4, promiseKeptCount: 0, promiseKeptCredit: 0, promisesTotal: 0,
 *   escalateContracts: 0, totalAssigned: 8
 * })
 * // → { contactRate: 50.0, promiseRate: 0, promiseKeepRate: null, resolutionRate: 60.0, escalationRate: 0 }
 *
 * @example
 * // High escalation
 * computePerformanceKPIs({
 *   totalAttempts: 30, successfulAttempts: 0, promiseCount: 0, resolutionCount: 0,
 *   uniqueContracts: 10, promiseKeptCount: 0, promiseKeptCredit: 0, promisesTotal: 0,
 *   escalateContracts: 25, totalAssigned: 30
 * })
 * // → { contactRate: 33.3, promiseRate: null, promiseKeepRate: null, resolutionRate: null, escalationRate: 83.3 }
 *
 * @example
 * // Split-equally: 2 freelancers both promised, payment came in → each gets 0.5 credit
 * // promisesTotal=1 (1 promise row for this freelancer), promiseKeptCredit=0.5
 * computePerformanceKPIs({
 *   totalAttempts: 5, successfulAttempts: 4, promiseCount: 1, resolutionCount: 0,
 *   uniqueContracts: 3, promiseKeptCount: 1, promiseKeptCredit: 0.5, promisesTotal: 1,
 *   escalateContracts: 0, totalAssigned: 10
 * })
 * // → { contactRate: 30.0, promiseRate: 25.0, promiseKeepRate: 50.0, resolutionRate: 0, escalationRate: 0 }
 *
 * @example
 * // Split-equally: sole promisor, payment came in → full credit
 * computePerformanceKPIs({
 *   totalAttempts: 5, successfulAttempts: 4, promiseCount: 1, resolutionCount: 0,
 *   uniqueContracts: 3, promiseKeptCount: 1, promiseKeptCredit: 1.0, promisesTotal: 1,
 *   escalateContracts: 0, totalAssigned: 10
 * })
 * // → { contactRate: 30.0, promiseRate: 25.0, promiseKeepRate: 100.0, resolutionRate: 0, escalationRate: 0 }
 */
export function computePerformanceKPIs(input: PerformanceInput): PerformanceKPIs {
  const round1 = (x: number): number => Math.round(x * 10) / 10

  const contactRate =
    input.totalAssigned > 0
      ? round1((input.uniqueContracts / input.totalAssigned) * 100)
      : null

  const promiseRate =
    input.successfulAttempts > 0
      ? round1((input.promiseCount / input.successfulAttempts) * 100)
      : null

  // promiseKeepRate ใช้ promiseKeptCredit (split-equally) เป็น numerator
  // denominator = promisesTotal (promises ที่มี next_follow_up_at ใน 30 วัน)
  const promiseKeepRate =
    input.promisesTotal > 0
      ? round1((input.promiseKeptCredit / input.promisesTotal) * 100)
      : null

  const resolutionRate =
    input.totalAttempts > 0
      ? round1((input.resolutionCount / input.totalAttempts) * 100)
      : null

  const escalationRate =
    input.totalAssigned > 0
      ? round1((input.escalateContracts / input.totalAssigned) * 100)
      : null

  return {
    contactRate,
    promiseRate,
    promiseKeepRate,
    resolutionRate,
    escalationRate,
  }
}

// ============================================================================
// Wave 2 scope note (สำหรับ น้องวิว + ครีม):
// ============================================================================
// computePerformanceKPIs ทำงานสมบูรณ์ทุก KPI หลัง Wave 2:
//   - contactRate: real totalAssigned จาก v_grade_active_counts
//   - promiseRate: ไม่เปลี่ยน (จาก v_freelancer_performance_30d เดิม)
//   - promiseKeepRate: real promiseKeptCredit + promisesTotal จาก v_promise_attribution_30d
//   - resolutionRate: ไม่เปลี่ยน (จาก v_freelancer_performance_30d เดิม)
//   - escalationRate: real escalateContracts จาก v_grade_escalate_counts
//
// ทุก rate คืน null (N/A) ถ้า denominator = 0 (ติ๊ก YELLOW #6)
// น้องวิว Wave 3: render null → "N/A" ใน UI
