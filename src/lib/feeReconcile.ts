// feeReconcile.ts — ผูก "action จริง (ขยาย/ปิดด่วน)" ↔ "ลงค่าธรรมเนียมเป็นรายได้" แบบ 2 ทิศทาง
//
// แนวคิด: แต่ละสัญญามีสิทธิ์ค่าธรรมเนียม 3 ตัว (FeeRight): เปลี่ยนวันชำระ / ขยายงวด / ปิดด่วน
// ต่อสิทธิ์หนึ่ง เราดูว่า
//   - มี "action จริง" ไหม (มีการขยาย/ปิดด่วนในระบบ)
//   - มี "รายได้" ไหม (มี other_income ที่ tag fee_kind ตรงกับสิทธิ์นั้น)
// แล้วจับคู่: ถ้ามีทั้งคู่ = เรียบร้อย, ขาดฝั่งใดฝั่งหนึ่ง = ค้างเตือนฝั่งนั้น
//
// derive-first / self-healing: คำนวณสดจากข้อมูลจริงทุกครั้ง ไม่ hook RPC ไม่เก็บ status ใน DB
// (fee_waivers = ทางเดียวที่เก็บ state คือ "admin ยกเว้นแล้ว")

export type FeeRight = 'due_day' | 'months' | 'settle'
export type FeeKind = 'due_day' | 'months' | 'both' | 'settle'
export type ExtType = 'due_day' | 'months' | 'both'
export type RightStatus = 'reconciled' | 'pending_action' | 'pending_income' | 'waived' | 'none'

/** baseline cutoff (วัน deploy) — action ที่เกิดก่อนวันนี้ถือว่า reconciled อัตโนมัติ
 *  (ข้อมูลเก่าก่อนมีฟีเจอร์นี้ ไม่ต้องไล่เตือนย้อนหลัง) */
export const FEE_RECONCILE_LAUNCH = '2026-07-14'

// ============================================================================
// UI presets — หมวดรายได้ค่าธรรมเนียม ↔ fee_kind (ชื่อ category ← แบมเคาะ)
// ใช้ร่วมกันทั้ง PjSyncReview + ContractDetail เพื่อให้ category ที่บันทึกตรงกัน
// ============================================================================

export interface FeeIncomePreset {
  category: string          // ข้อความ category ที่บันทึกลง other_income
  feeKind: FeeKind | null   // tag สิทธิ์ค่าธรรมเนียม (null = รายได้ทั่วไป ไม่ผูก reconcile)
}

/** หมวดรายได้สำเร็จรูป + fee_kind (เรียงตามที่เจอบ่อย) */
export const FEE_INCOME_PRESETS: FeeIncomePreset[] = [
  { category: 'ค่าส่งกล่องพัสดุ', feeKind: null },
  { category: 'ค่าเปลี่ยนวันที่ชำระ', feeKind: 'due_day' },
  { category: 'ค่าขยายระยะเวลา', feeKind: 'months' },
  { category: 'ค่าขยายระยะเวลา + เปลี่ยนวันชำระ', feeKind: 'both' },
  { category: 'ค่าปิดสัญญาก่อนกำหนด', feeKind: 'settle' },
]

/** ข้อความตัวเลือก "อื่นๆ (พิมพ์เอง)" — feeKind = null */
export const FEE_INCOME_CUSTOM = 'อื่นๆ (พิมพ์เอง)'

/** map fee_kind → category preset (สำหรับ preset ตอน deep-link เปิด modal ลงค่าธรรมเนียม) */
export function presetForFeeKind(kind: FeeKind): FeeIncomePreset | null {
  return FEE_INCOME_PRESETS.find((p) => p.feeKind === kind) ?? null
}

export interface ReconcileInput {
  settledAt: string | null                                  // timestamptz|date — ปิดด่วนเมื่อไหร่ (null = ยังไม่ปิด)
  extensions: { extType: ExtType; createdAt: string }[]     // ประวัติการขยาย
  otherIncome: { feeKind: FeeKind | null; receivedAt: string }[] // รายได้อื่นๆ (เฉพาะที่ tag fee_kind)
  dismisses: FeeRight[]                                      // สิทธิ์ที่ admin ยกเว้น (fee_waivers)
  launchDate: string                                        // baseline cutoff — ปกติส่ง FEE_RECONCILE_LAUNCH
}

export interface ReconcileResult {
  due_day: RightStatus
  months: RightStatus
  settle: RightStatus
}

const RIGHTS: FeeRight[] = ['due_day', 'months', 'settle']

/** date-only compare: ตัดเวลาออกก่อนเทียบ (createdAt/settledAt เป็น timestamptz) */
function dateOnly(s: string): string {
  return s.slice(0, 10)
}

/**
 * คำนวณสถานะ reconcile ต่อสิทธิ์ค่าธรรมเนียมทั้ง 3 ตัว
 * boolean ต่อ (right × side) ไม่ใช่ counter → มีขยาย 5 ครั้ง + ลงรายได้ 1 ครั้ง ก็ยัง reconciled
 * (กันนับซ้ำอัตโนมัติ — จับแค่ "มี/ไม่มี" ไม่ใช่ "กี่ครั้ง")
 */
export function reconcileContractFees(input: ReconcileInput): ReconcileResult {
  const { settledAt, extensions, otherIncome, dismisses, launchDate } = input

  // hasAction ต่อ right + วันที่ action เกิด (เอา action แรกสุดของ right นั้นเป็นตัวเทียบ baseline)
  const hasAction: Record<FeeRight, boolean> = { due_day: false, months: false, settle: false }
  const actionDate: Record<FeeRight, string | null> = { due_day: null, months: null, settle: null }

  const markAction = (r: FeeRight, date: string) => {
    hasAction[r] = true
    // เก็บวันที่ "เก่าสุด" ของ action สำหรับ right นั้น (เทียบ baseline แบบอนุรักษ์นิยม)
    if (actionDate[r] === null || dateOnly(date) < dateOnly(actionDate[r]!)) {
      actionDate[r] = date
    }
  }

  for (const ext of extensions) {
    if (ext.extType === 'due_day') markAction('due_day', ext.createdAt)
    else if (ext.extType === 'months') markAction('months', ext.createdAt)
    else if (ext.extType === 'both') {
      markAction('due_day', ext.createdAt)
      markAction('months', ext.createdAt)
    }
  }
  if (settledAt != null) markAction('settle', settledAt)

  // hasIncome ต่อ right (ข้าม feeKind == null — รายได้อื่นๆ ที่ไม่ได้ tag ว่าเป็นค่าธรรมเนียม)
  const hasIncome: Record<FeeRight, boolean> = { due_day: false, months: false, settle: false }
  for (const oi of otherIncome) {
    if (oi.feeKind == null) continue
    if (oi.feeKind === 'due_day') hasIncome.due_day = true
    else if (oi.feeKind === 'months') hasIncome.months = true
    else if (oi.feeKind === 'settle') hasIncome.settle = true
    else if (oi.feeKind === 'both') {
      hasIncome.due_day = true
      hasIncome.months = true
    }
  }

  const decide = (r: FeeRight): RightStatus => {
    if (dismisses.includes(r)) return 'waived'
    const action = hasAction[r]
    const income = hasIncome[r]
    if (!action && !income) return 'none'
    if (action && income) return 'reconciled'
    // baseline: action เกิดก่อนวัน launch → ถือว่าเรียบร้อย (ไม่ไล่เตือนย้อนหลัง)
    if (action && dateOnly(actionDate[r]!) < launchDate) return 'reconciled'
    if (action && !income) return 'pending_income'   // มี action แต่ยังไม่ลงรายได้
    return 'pending_action'                           // มีรายได้ แต่ไม่มี action จริง
  }

  return {
    due_day: decide('due_day'),
    months: decide('months'),
    settle: decide('settle'),
  }
}

// ============================================================================
// Unit-style validate (รันตอน import ในโหมด dev ผ่าน validateFeeReconcile())
// ไม่ auto-run — เรียกเองใน test/console ได้ ครอบทุก combination รวม 'both' + edge
// ============================================================================

/** คืน [] ถ้าผ่านหมด, คืน list ข้อความ error ถ้ามี case พลาด */
export function validateFeeReconcile(): string[] {
  const errs: string[] = []
  const LAUNCH = '2026-07-14'
  const AFTER = '2026-07-20T09:00:00Z'   // หลัง launch
  const BEFORE = '2026-07-01T09:00:00Z'  // ก่อน launch (baseline)

  const check = (name: string, got: ReconcileResult, want: ReconcileResult) => {
    for (const r of RIGHTS) {
      if (got[r] !== want[r]) errs.push(`${name}: ${r} = ${got[r]} (want ${want[r]})`)
    }
  }

  // 1) ว่างเปล่า → none ทั้งหมด
  check('empty', reconcileContractFees({
    settledAt: null, extensions: [], otherIncome: [], dismisses: [], launchDate: LAUNCH,
  }), { due_day: 'none', months: 'none', settle: 'none' })

  // 2) ขยาย due_day (หลัง launch) ไม่มีรายได้ → pending_income
  check('ext due_day no income', reconcileContractFees({
    settledAt: null, extensions: [{ extType: 'due_day', createdAt: AFTER }],
    otherIncome: [], dismisses: [], launchDate: LAUNCH,
  }), { due_day: 'pending_income', months: 'none', settle: 'none' })

  // 3) ขยาย months + ลงรายได้ months → reconciled
  check('ext months + income', reconcileContractFees({
    settledAt: null, extensions: [{ extType: 'months', createdAt: AFTER }],
    otherIncome: [{ feeKind: 'months', receivedAt: AFTER }], dismisses: [], launchDate: LAUNCH,
  }), { due_day: 'none', months: 'reconciled', settle: 'none' })

  // 4) มีรายได้ due_day แต่ไม่มี action → pending_action
  check('income due_day no action', reconcileContractFees({
    settledAt: null, extensions: [],
    otherIncome: [{ feeKind: 'due_day', receivedAt: AFTER }], dismisses: [], launchDate: LAUNCH,
  }), { due_day: 'pending_action', months: 'none', settle: 'none' })

  // 5) ext 'both' → hasAction ทั้ง due_day + months, ไม่มีรายได้ → pending_income ทั้งคู่
  check('ext both no income', reconcileContractFees({
    settledAt: null, extensions: [{ extType: 'both', createdAt: AFTER }],
    otherIncome: [], dismisses: [], launchDate: LAUNCH,
  }), { due_day: 'pending_income', months: 'pending_income', settle: 'none' })

  // 6) EDGE (แบมเน้น): income 'both' + ext 'months' only
  //    → months: action+income = reconciled ; due_day: income แต่ไม่มี action = pending_action
  check('income both + ext months only', reconcileContractFees({
    settledAt: null, extensions: [{ extType: 'months', createdAt: AFTER }],
    otherIncome: [{ feeKind: 'both', receivedAt: AFTER }], dismisses: [], launchDate: LAUNCH,
  }), { due_day: 'pending_action', months: 'reconciled', settle: 'none' })

  // 7) settle (ปิดด่วน) หลัง launch ไม่มีรายได้ → pending_income
  check('settle no income', reconcileContractFees({
    settledAt: AFTER, extensions: [], otherIncome: [], dismisses: [], launchDate: LAUNCH,
  }), { due_day: 'none', months: 'none', settle: 'pending_income' })

  // 8) settle + income settle → reconciled
  check('settle + income', reconcileContractFees({
    settledAt: AFTER, extensions: [],
    otherIncome: [{ feeKind: 'settle', receivedAt: AFTER }], dismisses: [], launchDate: LAUNCH,
  }), { due_day: 'none', months: 'none', settle: 'reconciled' })

  // 9) baseline: action ก่อน launch ไม่มีรายได้ → reconciled (ไม่เตือนย้อนหลัง)
  check('baseline before launch', reconcileContractFees({
    settledAt: BEFORE, extensions: [{ extType: 'due_day', createdAt: BEFORE }],
    otherIncome: [], dismisses: [], launchDate: LAUNCH,
  }), { due_day: 'reconciled', months: 'none', settle: 'reconciled' })

  // 10) waived override — ต่อให้ pending ก็ต้องเป็น waived
  check('waived override', reconcileContractFees({
    settledAt: null, extensions: [{ extType: 'due_day', createdAt: AFTER }],
    otherIncome: [], dismisses: ['due_day'], launchDate: LAUNCH,
  }), { due_day: 'waived', months: 'none', settle: 'none' })

  // 11) กันนับซ้ำ: ขยาย due_day 3 ครั้ง + ลงรายได้ 1 → reconciled (ไม่เพี้ยน)
  check('multi-action single income', reconcileContractFees({
    settledAt: null,
    extensions: [
      { extType: 'due_day', createdAt: AFTER },
      { extType: 'due_day', createdAt: AFTER },
      { extType: 'due_day', createdAt: AFTER },
    ],
    otherIncome: [{ feeKind: 'due_day', receivedAt: AFTER }], dismisses: [], launchDate: LAUNCH,
  }), { due_day: 'reconciled', months: 'none', settle: 'none' })

  // 12) date-only edge: action เที่ยงคืน UTC วัน launch พอดี → slice = launch, ไม่ < launch → ไม่ baseline
  //     (เป็น pending_income เพราะไม่มีรายได้) — ยืนยัน '<' ไม่ใช่ '<='
  check('action on launch day (not baseline)', reconcileContractFees({
    settledAt: null, extensions: [{ extType: 'months', createdAt: '2026-07-14T00:00:00Z' }],
    otherIncome: [], dismisses: [], launchDate: LAUNCH,
  }), { due_day: 'none', months: 'pending_income', settle: 'none' })

  return errs
}
