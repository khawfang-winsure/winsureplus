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

export type FeeRight = 'due_day' | 'months' | 'settle' | 'transfer'
export type FeeKind = 'due_day' | 'months' | 'both' | 'settle' | 'transfer'
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
  { category: 'ค่าธรรมเนียมปรับโครงสร้าง (เปลี่ยนผู้ผ่อน)', feeKind: 'transfer' },
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
  //   'transfer' เป็น count-based (นับจำนวนครั้ง ไม่ใช่ boolean) — ถ้ายกเว้นค่าธรรมเนียมรอบเปลี่ยนผู้ผ่อนกี่รอบ
  //   ให้ push 'transfer' เข้า array นี้ "หนึ่งครั้งต่อรอบที่ยกเว้น" (ต่างจาก due_day/months/settle ที่แค่มี/ไม่มีพอ)
  launchDate: string                                        // baseline cutoff — ปกติส่ง FEE_RECONCILE_LAUNCH
  transfers?: { createdAt: string; reversed?: boolean }[]    // ประวัติเปลี่ยนผู้ผ่อน (optional กัน call site เดิมพัง) — reversed=true ไม่นับ
}

export interface ReconcileResult {
  due_day: RightStatus
  months: RightStatus
  settle: RightStatus
  transfer: RightStatus
}

const RIGHTS: FeeRight[] = ['due_day', 'months', 'settle', 'transfer']

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
  const { settledAt, extensions, otherIncome, dismisses, launchDate, transfers } = input

  // hasAction ต่อ right + วันที่ action เกิด (เอา action แรกสุดของ right นั้นเป็นตัวเทียบ baseline)
  // 'transfer' key มีไว้ให้ type ครบ (Record<FeeRight,...>) เท่านั้น — decide('transfer') ไม่แตะ closure นี้เลย ใช้ path แยก (decideTransfer)
  const hasAction: Record<FeeRight, boolean> = { due_day: false, months: false, settle: false, transfer: false }
  const actionDate: Record<FeeRight, string | null> = { due_day: null, months: null, settle: null, transfer: null }

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
  const hasIncome: Record<FeeRight, boolean> = { due_day: false, months: false, settle: false, transfer: false }
  for (const oi of otherIncome) {
    if (oi.feeKind == null) continue
    if (oi.feeKind === 'due_day') hasIncome.due_day = true
    else if (oi.feeKind === 'months') hasIncome.months = true
    else if (oi.feeKind === 'settle') hasIncome.settle = true
    else if (oi.feeKind === 'both') {
      hasIncome.due_day = true
      hasIncome.months = true
    }
    else if (oi.feeKind === 'transfer') hasIncome.transfer = true
  }

  /**
   * 'transfer' เป็นสิทธิ์เดียวที่ "เปลี่ยนได้หลายครั้ง" ต่อสัญญา ต่างจาก due_day/months/settle
   * (boolean มี/ไม่มีพอ) — ต้องนับจำนวนครั้งเทียบจำนวนรายได้ที่ลงจริง ไม่งั้นเปลี่ยนรอบ 2
   * จะถูกกลืนไปว่า "reconciled" ทั้งที่ยังไม่ได้ลงรายได้รอบใหม่ (บั๊กที่ boolean แบบเดิมจะพลาด)
   *
   * ขั้นตอน:
   *  1) dismisses.includes('transfer') อย่างน้อย 1 ครั้ง + counts ลงตัวพอดี (income+waiver===transfer หลัง launch)
   *     → ให้ 'waived' ชนะ (สอดคล้อง priority เดิมที่ dismiss ตัดสินก่อนเสมอ)
   *  2) baseline: transfer ทุกครั้งเกิดก่อน launchDate (ไม่มีครั้งไหนหลัง launch) → 'reconciled' อัตโนมัติ
   *     เหมือน due_day/months/settle (ไม่ไล่เตือนย้อนหลังข้อมูลเก่าก่อนมีฟีเจอร์นี้)
   *  3) หลัง launch: เทียบจำนวน "income + waiver" กับจำนวน transfer หลัง launch
   *     income+waiver < transfer  → pending_income (เปลี่ยนแล้ว ลงรายได้ไม่ครบ)
   *     income > transfer         → pending_action (ลงรายได้เกินจำนวนที่เปลี่ยนจริง — ผิดปกติ)
   *     เท่ากัน                    → 'waived' ถ้ามี waiver ปนอยู่ ไม่งั้น 'reconciled'
   */
  const decideTransfer = (): RightStatus => {
    const list = (transfers ?? []).filter((t) => !t.reversed)
    const waiverCount = dismisses.filter((r) => r === 'transfer').length
    // incomeCount (ไม่กรองวัน) ใช้เฉพาะ branch "ไม่มี transfer เลย" ด้านล่าง — ตั้งใจไม่กรอง launch ตรงนั้น
    // เพราะ branch นั้นตอบคำถามคนละอย่าง ("มีรายได้ลอยไม่มี action คู่กันเลยไหม" ไม่ใช่ "รายได้พอสำหรับ
    // transfer รอบหลัง launch ไหม")
    const incomeCount = otherIncome.filter((oi) => oi.feeKind === 'transfer').length

    if (list.length === 0) return incomeCount > 0 || waiverCount > 0 ? 'pending_action' : 'none'

    const afterLaunch = list.filter((t) => !(dateOnly(t.createdAt) < launchDate)).length
    if (afterLaunch === 0) return 'reconciled' // ทุกครั้งเกิดก่อน launch = baseline

    // 🛡️ defensive (ติ๊กรีวิว RED, 2026-09-14): เทียบกับ afterLaunch (กรองวันแล้ว) ต้องใช้ income ที่กรองวัน
    // เดียวกันด้วย ไม่งั้น income เก่าก่อน launch (เช่นข้อมูล backfill/ทดสอบ) จะไปหักลบกับ transfer รอบหลัง
    // launch แบบไม่ตั้งใจ (เข้าใจผิดว่า settled ทั้งที่ income นั้นไม่เกี่ยวกับรอบหลัง launch เลย) — กรอง
    // ด้วย launchDate ให้สมมาตรกับฝั่ง action เสมอ (waiverCount ไม่ต้องกรอง เพราะผูกกับ transfer_id ตรงตัวอยู่แล้ว)
    const incomeAfterLaunch = otherIncome.filter(
      (oi) => oi.feeKind === 'transfer' && !(dateOnly(oi.receivedAt) < launchDate),
    ).length

    const settled = incomeAfterLaunch + waiverCount
    if (settled < afterLaunch) return 'pending_income'
    if (incomeAfterLaunch > afterLaunch) return 'pending_action'
    return waiverCount > 0 ? 'waived' : 'reconciled'
  }

  const decide = (r: FeeRight): RightStatus => {
    if (r === 'transfer') return decideTransfer()
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
    transfer: decide('transfer'),
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
  }), { due_day: 'none', months: 'none', settle: 'none' , transfer: 'none' })

  // 2) ขยาย due_day (หลัง launch) ไม่มีรายได้ → pending_income
  check('ext due_day no income', reconcileContractFees({
    settledAt: null, extensions: [{ extType: 'due_day', createdAt: AFTER }],
    otherIncome: [], dismisses: [], launchDate: LAUNCH,
  }), { due_day: 'pending_income', months: 'none', settle: 'none' , transfer: 'none' })

  // 3) ขยาย months + ลงรายได้ months → reconciled
  check('ext months + income', reconcileContractFees({
    settledAt: null, extensions: [{ extType: 'months', createdAt: AFTER }],
    otherIncome: [{ feeKind: 'months', receivedAt: AFTER }], dismisses: [], launchDate: LAUNCH,
  }), { due_day: 'none', months: 'reconciled', settle: 'none' , transfer: 'none' })

  // 4) มีรายได้ due_day แต่ไม่มี action → pending_action
  check('income due_day no action', reconcileContractFees({
    settledAt: null, extensions: [],
    otherIncome: [{ feeKind: 'due_day', receivedAt: AFTER }], dismisses: [], launchDate: LAUNCH,
  }), { due_day: 'pending_action', months: 'none', settle: 'none' , transfer: 'none' })

  // 5) ext 'both' → hasAction ทั้ง due_day + months, ไม่มีรายได้ → pending_income ทั้งคู่
  check('ext both no income', reconcileContractFees({
    settledAt: null, extensions: [{ extType: 'both', createdAt: AFTER }],
    otherIncome: [], dismisses: [], launchDate: LAUNCH,
  }), { due_day: 'pending_income', months: 'pending_income', settle: 'none' , transfer: 'none' })

  // 6) EDGE (แบมเน้น): income 'both' + ext 'months' only
  //    → months: action+income = reconciled ; due_day: income แต่ไม่มี action = pending_action
  check('income both + ext months only', reconcileContractFees({
    settledAt: null, extensions: [{ extType: 'months', createdAt: AFTER }],
    otherIncome: [{ feeKind: 'both', receivedAt: AFTER }], dismisses: [], launchDate: LAUNCH,
  }), { due_day: 'pending_action', months: 'reconciled', settle: 'none' , transfer: 'none' })

  // 7) settle (ปิดด่วน) หลัง launch ไม่มีรายได้ → pending_income
  check('settle no income', reconcileContractFees({
    settledAt: AFTER, extensions: [], otherIncome: [], dismisses: [], launchDate: LAUNCH,
  }), { due_day: 'none', months: 'none', settle: 'pending_income' , transfer: 'none' })

  // 8) settle + income settle → reconciled
  check('settle + income', reconcileContractFees({
    settledAt: AFTER, extensions: [],
    otherIncome: [{ feeKind: 'settle', receivedAt: AFTER }], dismisses: [], launchDate: LAUNCH,
  }), { due_day: 'none', months: 'none', settle: 'reconciled' , transfer: 'none' })

  // 9) baseline: action ก่อน launch ไม่มีรายได้ → reconciled (ไม่เตือนย้อนหลัง)
  check('baseline before launch', reconcileContractFees({
    settledAt: BEFORE, extensions: [{ extType: 'due_day', createdAt: BEFORE }],
    otherIncome: [], dismisses: [], launchDate: LAUNCH,
  }), { due_day: 'reconciled', months: 'none', settle: 'reconciled' , transfer: 'none' })

  // 10) waived override — ต่อให้ pending ก็ต้องเป็น waived
  check('waived override', reconcileContractFees({
    settledAt: null, extensions: [{ extType: 'due_day', createdAt: AFTER }],
    otherIncome: [], dismisses: ['due_day'], launchDate: LAUNCH,
  }), { due_day: 'waived', months: 'none', settle: 'none' , transfer: 'none' })

  // 11) กันนับซ้ำ: ขยาย due_day 3 ครั้ง + ลงรายได้ 1 → reconciled (ไม่เพี้ยน)
  check('multi-action single income', reconcileContractFees({
    settledAt: null,
    extensions: [
      { extType: 'due_day', createdAt: AFTER },
      { extType: 'due_day', createdAt: AFTER },
      { extType: 'due_day', createdAt: AFTER },
    ],
    otherIncome: [{ feeKind: 'due_day', receivedAt: AFTER }], dismisses: [], launchDate: LAUNCH,
  }), { due_day: 'reconciled', months: 'none', settle: 'none' , transfer: 'none' })

  // 12) date-only edge: action เที่ยงคืน UTC วัน launch พอดี → slice = launch, ไม่ < launch → ไม่ baseline
  //     (เป็น pending_income เพราะไม่มีรายได้) — ยืนยัน '<' ไม่ใช่ '<='
  check('action on launch day (not baseline)', reconcileContractFees({
    settledAt: null, extensions: [{ extType: 'months', createdAt: '2026-07-14T00:00:00Z' }],
    otherIncome: [], dismisses: [], launchDate: LAUNCH,
  }), { due_day: 'none', months: 'pending_income', settle: 'none' , transfer: 'none' })

  // ============================================================================
  // 'transfer' (เปลี่ยนผู้ผ่อน) — count-based สิทธิ์เดียวที่เปลี่ยนได้หลายครั้งต่อสัญญา
  // ============================================================================

  // 13a) 1 transfer หลัง launch ไม่มี income → pending_income
  check('transfer x1 no income', reconcileContractFees({
    settledAt: null, extensions: [], otherIncome: [], dismisses: [], launchDate: LAUNCH,
    transfers: [{ createdAt: AFTER }],
  }), { due_day: 'none', months: 'none', settle: 'none', transfer: 'pending_income' })

  // 13b) 1 transfer + 1 income (feeKind='transfer') → reconciled
  check('transfer x1 + income x1', reconcileContractFees({
    settledAt: null, extensions: [], otherIncome: [{ feeKind: 'transfer', receivedAt: AFTER }],
    dismisses: [], launchDate: LAUNCH, transfers: [{ createdAt: AFTER }],
  }), { due_day: 'none', months: 'none', settle: 'none', transfer: 'reconciled' })

  // 13c) 2 transfers + income x1 → income ไม่พอ (1 < 2) → pending_income
  check('transfer x2 + income x1', reconcileContractFees({
    settledAt: null, extensions: [], otherIncome: [{ feeKind: 'transfer', receivedAt: AFTER }],
    dismisses: [], launchDate: LAUNCH,
    transfers: [{ createdAt: AFTER }, { createdAt: AFTER }],
  }), { due_day: 'none', months: 'none', settle: 'none', transfer: 'pending_income' })

  // 13d) income x1 (feeKind='transfer') ไม่มี transfer เลย → pending_action (มีรายได้ แต่ไม่มี action จริง)
  check('income transfer no transfer', reconcileContractFees({
    settledAt: null, extensions: [], otherIncome: [{ feeKind: 'transfer', receivedAt: AFTER }],
    dismisses: [], launchDate: LAUNCH, transfers: [],
  }), { due_day: 'none', months: 'none', settle: 'none', transfer: 'pending_action' })

  // 13e) transfer เกิดก่อน launch ไม่มี income → baseline (เหมือน due_day/months/settle) → reconciled
  //      (ตัดสินใจ: ให้ transfer ใช้กฎ baseline เดียวกับสิทธิ์อื่นทั้ง 3 ตัว ไม่ใช่ 'none' — สม่ำเสมอทั้งระบบ)
  check('transfer before launch (baseline)', reconcileContractFees({
    settledAt: null, extensions: [], otherIncome: [], dismisses: [], launchDate: LAUNCH,
    transfers: [{ createdAt: BEFORE }],
  }), { due_day: 'none', months: 'none', settle: 'none', transfer: 'reconciled' })

  // 13f) 2 transfers + waiver 1 + income 1 → settled(income+waiver)=2=transfers → เท่ากันแบบมี waiver ปน → 'waived'
  check('transfer x2 + waiver x1 + income x1', reconcileContractFees({
    settledAt: null, extensions: [], otherIncome: [{ feeKind: 'transfer', receivedAt: AFTER }],
    dismisses: ['transfer'], launchDate: LAUNCH,
    transfers: [{ createdAt: AFTER }, { createdAt: AFTER }],
  }), { due_day: 'none', months: 'none', settle: 'none', transfer: 'waived' })

  // 13g) transfer ที่ reversed:true ไม่นับ — เหลือ 0 ครั้ง + ไม่มี income → none
  check('reversed transfer not counted', reconcileContractFees({
    settledAt: null, extensions: [], otherIncome: [], dismisses: [], launchDate: LAUNCH,
    transfers: [{ createdAt: AFTER, reversed: true }],
  }), { due_day: 'none', months: 'none', settle: 'none', transfer: 'none' })

  // 13h) transfers undefined (call site เก่ายังไม่ส่ง field นี้มาเลย) → เหมือนไม่มี transfer ไหนเลย → ไม่พัง
  check('transfers field omitted (backward compat)', reconcileContractFees({
    settledAt: null, extensions: [], otherIncome: [], dismisses: [], launchDate: LAUNCH,
  }), { due_day: 'none', months: 'none', settle: 'none', transfer: 'none' })

  // preset lookup ใช้กับ 'transfer' ได้ + category ตรงตามที่แบมเคาะ
  const transferPreset = presetForFeeKind('transfer')
  if (!transferPreset || transferPreset.category !== 'ค่าธรรมเนียมปรับโครงสร้าง (เปลี่ยนผู้ผ่อน)') {
    errs.push(`presetForFeeKind('transfer') ผิด: ${JSON.stringify(transferPreset)}`)
  }

  return errs
}
