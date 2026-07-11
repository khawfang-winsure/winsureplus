import type { CollectorCallOutcome } from './types'

/**
 * รวมผลการโทร/นัดชำระของทั้งทีม จาก rows รายคน — ใช้กับหน้า /staff-performance
 * (CallOutcomeSection ช่วงวันที่เลือก) และ widget "ผลงานทีมโทรวันนี้ (สด)" ที่ /exec + /staff-performance
 */
export interface CallOutcomeTotals {
  casesFollowed: number
  casesReached: number
  casesNoAnswer: number
  casesUnreachable: number
  promisesMade: number
  promisesKept: number
  promisesBroken: number
  promisesPending: number
}

/** sum rows (1 แถวต่อคน จาก getCollectorCallOutcomes) → ยอดรวมทั้งทีม */
export function computeCallOutcomeTotals(rows: CollectorCallOutcome[]): CallOutcomeTotals {
  const t: CallOutcomeTotals = {
    casesFollowed: 0,
    casesReached: 0,
    casesNoAnswer: 0,
    casesUnreachable: 0,
    promisesMade: 0,
    promisesKept: 0,
    promisesBroken: 0,
    promisesPending: 0,
  }
  for (const r of rows) {
    t.casesFollowed += r.casesFollowed
    t.casesReached += r.casesReached
    t.casesNoAnswer += r.casesNoAnswer
    t.casesUnreachable += r.casesUnreachable
    t.promisesMade += r.promisesMade
    t.promisesKept += r.promisesKept
    t.promisesBroken += r.promisesBroken
    t.promisesPending += r.promisesPending
  }
  return t
}
