// ===== เปลี่ยนผู้ผ่อน (contract transfer) — Pure-function layer =====
// Owner-approved brief: transfer-owner-brief.md (คุณเตย, 2026-09-14)
// สัญญาเดิม (ไม่สร้างสัญญาใหม่) เปลี่ยนแค่ชื่อผู้ผ่อน — ยอดค้าง/ค่าปรับ/ตารางงวดไม่เปลี่ยน
// Pure functions — ไม่มี side effect, ไม่ import db.ts/supabase, testable ด้วย node -e ผ่าน tsc transpile
import type { AddressKind, CustomerAddress } from './letters'
import { isAddressEmpty } from './letters'
import { baht, sanitizeInvNo } from './format'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** ข้อมูลผู้ผ่อนคนใหม่ (บาร์เดียวกับ AddContract "ส่วน 2: ข้อมูลลูกค้า" ตอนสร้างสัญญาใหม่) */
export interface TransferNewPerson {
  customerName: string
  nationalId: string
  phone: string
  phoneAlt1: string
  phoneAlt2: string
  facebookLink: string
  birthYear: number | null
  occupation: string
  occupationProof: string
}

/** ที่อยู่ผู้ผ่อน แยกตามชนิด (current/idCard/work บังคับ, registry ไม่บังคับ) — คีย์ตรงกับ AddressKind ใน letters.ts */
export type TransferAddresses = Partial<Record<AddressKind, CustomerAddress>>

/** 1 แถวประวัติเปลี่ยนผู้ผ่อน (แสดงถัดจากประวัติขยายเวลาใน ContractDetail) */
export interface ContractTransfer {
  id: string
  contractId: string
  transferNo: number // ครั้งที่ N (เริ่ม 1, ไม่ล็อกจำนวนครั้ง)
  effectiveAt: string // ISO — เมื่อไหร่ที่เปลี่ยนผู้ผ่อนมีผล

  // --- ผู้ผ่อนเดิม (full snapshot ตอนเปลี่ยน) ---
  oldCustomerName: string
  oldNationalId: string | null
  oldPhone: string | null
  oldPhoneAlt1: string | null
  oldPhoneAlt2: string | null
  oldFacebookLink: string | null
  oldBirthYear: number | null
  oldOccupation: string | null
  oldOccupationProof: string | null
  oldAddresses: TransferAddresses | null

  // --- ผู้ผ่อนใหม่ ---
  newCustomerName: string
  newNationalId: string | null
  newPhone: string | null
  newPhoneAlt1: string | null
  newPhoneAlt2: string | null
  newFacebookLink: string | null
  newBirthYear: number | null
  newOccupation: string | null
  newOccupationProof: string | null
  newAddresses: TransferAddresses | null

  // --- INV / cutover (PJ) ---
  oldInvNo: string | null
  newInvNo: string | null
  cutoverAt: string | null // ISO — เมื่อไหร่ที่ cutover_transfer_invoice ทำสำเร็จ (null = ยังไม่ cutover)

  // --- cutover audit (0158 SECTION 0 — เพิ่มโดยน้องชีส Wave 4, field-only addition ตาม brief) ---
  // optional กันโค้ดเก่า/เทสต์ trace ที่สร้าง object ด้วยมือ (mk() ใน validateContractTransfer) ไม่ต้องแก้
  cutoverPjTotal?: number | null // ยอดรวมจาก PJ ตอน cutover
  cutoverOurTotal?: number | null // ยอดที่เราคำนวณเอง ณ ตอน cutover
  cutoverMatched?: boolean | null // true = ยอดตรงกันพอดีตอน cutover
  cutoverOverrideReason?: string | null // เหตุผลที่แอดมินยืนยันแม้ยอดไม่ตรง
  cutoverByName?: string | null // ชื่อผู้กดผูกเลขที่ใบ PJ

  note: string | null
  createdByName: string | null
  createdAt: string

  // --- undo (admin only) ---
  reversedAt: string | null
  reversedByName: string | null
  reversedReason: string | null
}

// ---------------------------------------------------------------------------
// validateTransferInput
// ---------------------------------------------------------------------------

/** ที่อยู่บังคับ + ข้อความ error ต่อชนิด (key errors ใช้ camelCase ให้ wire เข้าฟอร์มง่าย) — registry ไม่อยู่ในนี้ = ไม่บังคับ */
const REQUIRED_ADDRESS_KINDS: { kind: AddressKind; errorKey: string; message: string }[] = [
  { kind: 'current', errorKey: 'currentAddress', message: 'กรุณากรอกที่อยู่ปัจจุบัน' },
  { kind: 'id_card', errorKey: 'idCardAddress', message: 'กรุณากรอกที่อยู่ตามบัตรประชาชน' },
  { kind: 'work', errorKey: 'workAddress', message: 'กรุณากรอกที่อยู่ที่ทำงาน' },
]

/**
 * ตรวจข้อมูลผู้ผ่อนคนใหม่ก่อนกดยืนยันเปลี่ยนผู้ผ่อน — บาร์เดียวกับ AddContract (ส่วน "ข้อมูลลูกค้า" ตอนสร้างสัญญาใหม่)
 * + เพิ่ม 2 กฎเฉพาะฟีเจอร์นี้: เลขบัตร 13 หลัก และห้ามซ้ำกับเลขบัตรผู้ผ่อนคนเดิม (oldNationalId)
 * ที่อยู่ current/id_card/work บังคับห้ามว่าง (ใช้ isAddressEmpty จาก letters.ts) — registry ไม่บังคับ
 * คืน { ok:false, errors:{} } ถ้ามีช่องพลาด — key ของ errors ตรงกับชื่อ field ของ TransferNewPerson
 * หรือ 'currentAddress' | 'idCardAddress' | 'workAddress' สำหรับที่อยู่
 */
export function validateTransferInput(
  person: TransferNewPerson,
  addresses: TransferAddresses,
  oldNationalId?: string | null,
): { ok: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {}

  if (!person.customerName.trim()) errors.customerName = 'กรุณากรอกชื่อลูกค้า'

  const nid = person.nationalId.trim()
  if (!nid) errors.nationalId = 'กรุณากรอกเลขบัตรประชาชน'
  else if (!/^\d{13}$/.test(nid)) errors.nationalId = 'เลขบัตรประชาชนต้องเป็นตัวเลข 13 หลัก'
  else if (oldNationalId && nid === oldNationalId.trim()) {
    errors.nationalId = 'เลขบัตรนี้เป็นของผู้ผ่อนคนเดิม เปลี่ยนผู้ผ่อนต้องใช้เลขบัตรใหม่'
  }

  if (!person.phone.trim()) errors.phone = 'กรุณากรอกเบอร์โทรลูกค้า'
  if (!person.phoneAlt1.trim()) errors.phoneAlt1 = 'กรุณากรอกเบอร์โทรศัพท์สำรอง 1'
  if (!person.phoneAlt2.trim()) errors.phoneAlt2 = 'กรุณากรอกเบอร์โทรศัพท์สำรอง 2'
  if (!person.facebookLink.trim()) errors.facebookLink = 'กรุณากรอกลิงค์เฟสลูกค้า'
  if (person.birthYear == null || !Number.isFinite(person.birthYear) || person.birthYear <= 0) {
    errors.birthYear = 'กรุณากรอกปีเกิด'
  }
  if (!person.occupation.trim()) errors.occupation = 'กรุณาเลือกอาชีพ'
  if (!person.occupationProof.trim()) errors.occupationProof = 'กรุณาเลือกหลักฐานอาชีพ'

  for (const { kind, errorKey, message } of REQUIRED_ADDRESS_KINDS) {
    if (isAddressEmpty(addresses[kind])) errors[errorKey] = message
  }
  // registry ไม่บังคับ — ไม่เช็ค

  return { ok: Object.keys(errors).length === 0, errors }
}

// ---------------------------------------------------------------------------
// normalizeInvNo — thin wrapper รอบ sanitizeInvNo() ที่มีอยู่แล้ว (format.ts)
// ---------------------------------------------------------------------------

/** ตัดข้อความขยะ + ทำเลข INV ให้เป็นรูปแบบมาตรฐาน (reuse sanitizeInvNo เดิม ไม่เขียนกฎ normalize ซ้ำ) */
export function normalizeInvNo(raw: string): string {
  return sanitizeInvNo(raw).value
}

// ---------------------------------------------------------------------------
// nextTransferNo / latestActiveTransfer
// ---------------------------------------------------------------------------

/** ครั้งถัดไป = max(transferNo ที่มีอยู่ทั้งหมด รวม reversed) + 1 — ไม่นับใหม่ 1 เสมอเวลา undo (เลขไม่ recycle) */
export function nextTransferNo(history: ContractTransfer[]): number {
  if (history.length === 0) return 1
  return Math.max(...history.map((h) => h.transferNo)) + 1
}

/** ครั้งล่าสุดที่ "ยังไม่ถูก undo" (reversedAt เป็น null) — ใช้เช็คสิทธิ์ undo (undo ได้เฉพาะครั้งล่าสุด) */
export function latestActiveTransfer(history: ContractTransfer[]): ContractTransfer | null {
  const active = history.filter((h) => !h.reversedAt)
  if (active.length === 0) return null
  return active.reduce((latest, h) => (h.transferNo > latest.transferNo ? h : latest), active[0])
}

// ---------------------------------------------------------------------------
// compareCutoverTotals — เทียบยอด PJ (ใบเสร็จภายใต้ INV เดิม) กับยอดที่เราเก็บจริง ก่อน cutover
// ---------------------------------------------------------------------------

export interface PjReceiptForCompare {
  uuid: string
  paymentType: string
  amount: number
  paidDate: string
}

export interface CutoverTotalsInput {
  pjReceipts: PjReceiptForCompare[]
  ourDown: number
  ourInstallmentsPaid: number
  ourPenaltyPaid: number
  ourOtherIncome: number
}

export interface CutoverTotalsResult {
  pjTotal: number
  ourTotal: number
  diff: number // pjTotal - ourTotal (ปัดสตางค์แล้ว) — 0 แปลว่าตรงกัน
  match: boolean
}

/** ปัดสตางค์ (2 ตำแหน่ง) กัน float dust เช่น 0.1+0.2 !== 0.3 */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * เทียบยอดรวมใบเสร็จฝั่ง PJ (ภายใต้ INV เดิม ณ ตอนก่อน cutover) กับยอดที่เราเก็บจริงในระบบ
 * (ดาวน์ + งวดที่จ่ายแล้ว + ค่าปรับที่เก็บแล้ว + รายได้อื่นๆ) — ต้องตรงกันก่อน staff จะ cutover ได้เอง
 * ไม่ตรง (match:false) → ต้อง admin + เหตุผล ตามกติกาใน brief (ก) cutover_transfer_invoice
 */
export function compareCutoverTotals(input: CutoverTotalsInput): CutoverTotalsResult {
  const pjTotal = round2(input.pjReceipts.reduce((sum, r) => sum + r.amount, 0))
  const ourTotal = round2(
    input.ourDown + input.ourInstallmentsPaid + input.ourPenaltyPaid + input.ourOtherIncome,
  )
  const diff = round2(pjTotal - ourTotal)
  return { pjTotal, ourTotal, diff, match: diff === 0 }
}

// ---------------------------------------------------------------------------
// transferDebtWarning
// ---------------------------------------------------------------------------

/**
 * ข้อความเตือนก่อนยืนยันเปลี่ยนผู้ผ่อน ถ้าสัญญามียอดค้าง/ค่าปรับค้างอยู่ (จะกลายเป็นภาระผู้ผ่อนคนใหม่ทันที)
 * ทั้งสองยอด <= 0 → ไม่มีอะไรต้องเตือน คืน null (ปุ่มยืนยันไม่ต้องโชว์แบนเนอร์)
 */
export function transferDebtWarning(overdueAmount: number, penaltyDue: number): string | null {
  if (overdueAmount <= 0 && penaltyDue <= 0) return null
  return (
    `สัญญานี้มียอดค้าง ${baht(overdueAmount)} บาท และค่าปรับค้าง ${baht(penaltyDue)} บาท` +
    ' — ยอดนี้จะกลายเป็นภาระของผู้ผ่อนคนใหม่ทันที'
  )
}

// ===========================================================================
// Trace tests (verify ด้วย node -e ผ่าน tsc transpile — repo ไม่มี vitest)
// ===========================================================================

/** คืน [] ถ้าผ่านหมด, คืน list ข้อความ error ถ้ามี case พลาด */
export function validateContractTransfer(): string[] {
  const errs: string[] = []
  const check = (name: string, got: unknown, want: unknown) => {
    const g = JSON.stringify(got)
    const w = JSON.stringify(want)
    if (g !== w) errs.push(`${name}: got ${g} (want ${w})`)
  }

  const fullAddr: CustomerAddress = { houseNo: '1', subdistrict: 'ก', district: 'ข', province: 'ค' }
  const validPerson: TransferNewPerson = {
    customerName: 'สมหญิง ใจดี',
    nationalId: '1234567890123',
    phone: '0812345678',
    phoneAlt1: '0812345679',
    phoneAlt2: '0812345680',
    facebookLink: 'fb.com/somying',
    birthYear: 2540,
    occupation: 'ค้าขาย',
    occupationProof: 'สลิปเงินเดือน',
  }
  const validAddresses: TransferAddresses = { current: fullAddr, id_card: fullAddr, work: fullAddr }

  // --- compareCutoverTotals ---

  // 1) 9,738 vs 9,738 → match
  check(
    'cutover match 9738',
    compareCutoverTotals({
      pjReceipts: [
        { uuid: 'a', paymentType: 'down', amount: 5000, paidDate: '2026-09-01' },
        { uuid: 'b', paymentType: 'installment', amount: 4738, paidDate: '2026-09-10' },
      ],
      ourDown: 5000, ourInstallmentsPaid: 4738, ourPenaltyPaid: 0, ourOtherIncome: 0,
    }),
    { pjTotal: 9738, ourTotal: 9738, diff: 0, match: true },
  )

  // 2) ต่าง 500 → not match
  check(
    'cutover mismatch 500',
    compareCutoverTotals({
      pjReceipts: [{ uuid: 'a', paymentType: 'down', amount: 9738, paidDate: '2026-09-01' }],
      ourDown: 5000, ourInstallmentsPaid: 4238, ourPenaltyPaid: 0, ourOtherIncome: 0,
    }),
    { pjTotal: 9738, ourTotal: 9238, diff: 500, match: false },
  )

  // 3) 0 receipts — ไม่ crash, ยอดเป็น 0 ทั้งคู่ = match
  check(
    'cutover zero receipts',
    compareCutoverTotals({ pjReceipts: [], ourDown: 0, ourInstallmentsPaid: 0, ourPenaltyPaid: 0, ourOtherIncome: 0 }),
    { pjTotal: 0, ourTotal: 0, diff: 0, match: true },
  )

  // 3b) 0 receipts แต่เรามียอดเก็บอยู่ → not match (กันสับสนว่า 0 receipts = ผ่านเสมอ)
  check(
    'cutover zero receipts but our total > 0',
    compareCutoverTotals({ pjReceipts: [], ourDown: 5000, ourInstallmentsPaid: 0, ourPenaltyPaid: 0, ourOtherIncome: 0 }),
    { pjTotal: 0, ourTotal: 5000, diff: -5000, match: false },
  )

  // --- validateTransferInput ---

  // 4) ครบถ้วน ถูกต้อง → ok:true
  check('validate ok', validateTransferInput(validPerson, validAddresses, '9999999999999'), {
    ok: true, errors: {},
  })

  // 5) เลขบัตรซ้ำคนเดิม → error
  check(
    'validate dup national id',
    validateTransferInput(validPerson, validAddresses, validPerson.nationalId).errors.nationalId,
    'เลขบัตรนี้เป็นของผู้ผ่อนคนเดิม เปลี่ยนผู้ผ่อนต้องใช้เลขบัตรใหม่',
  )

  // 6) เลขบัตรไม่ครบ 13 หลัก → error
  check(
    'validate national id not 13 digits',
    validateTransferInput({ ...validPerson, nationalId: '123' }, validAddresses, null).errors.nationalId,
    'เลขบัตรประชาชนต้องเป็นตัวเลข 13 หลัก',
  )

  // 7) ที่อยู่ current ว่าง → error, work/idCard ไม่ว่าง → ไม่มี error
  {
    const r = validateTransferInput(validPerson, { id_card: fullAddr, work: fullAddr }, null)
    check('validate missing current address', [r.ok, r.errors.currentAddress != null, r.errors.workAddress], [
      false, true, undefined,
    ])
  }

  // 8) registry ว่าง → ไม่ error (ไม่บังคับ)
  check('validate registry not required', validateTransferInput(validPerson, validAddresses, null).ok, true)

  // --- nextTransferNo / latestActiveTransfer ---

  const mk = (transferNo: number, reversedAt: string | null): ContractTransfer =>
    ({
      id: `t${transferNo}`, contractId: 'c1', transferNo, effectiveAt: '2026-09-01T00:00:00Z',
      oldCustomerName: 'เก่า', oldNationalId: null, oldPhone: null, oldPhoneAlt1: null, oldPhoneAlt2: null,
      oldFacebookLink: null, oldBirthYear: null, oldOccupation: null, oldOccupationProof: null, oldAddresses: null,
      newCustomerName: 'ใหม่', newNationalId: null, newPhone: null, newPhoneAlt1: null, newPhoneAlt2: null,
      newFacebookLink: null, newBirthYear: null, newOccupation: null, newOccupationProof: null, newAddresses: null,
      oldInvNo: null, newInvNo: null, cutoverAt: null, note: null, createdByName: null,
      createdAt: '2026-09-01T00:00:00Z', reversedAt, reversedByName: null, reversedReason: null,
    }) as ContractTransfer

  // 9) nextTransferNo([]) = 1
  check('nextTransferNo empty', nextTransferNo([]), 1)

  // 10) มี 2 ครั้ง (1 reversed) → 3 (เลขไม่ recycle ตอน undo)
  check('nextTransferNo with reversed', nextTransferNo([mk(1, '2026-09-05T00:00:00Z'), mk(2, null)]), 3)

  // 11) latestActiveTransfer — ตัวล่าสุดที่ไม่ถูก undo
  check(
    'latestActiveTransfer skips reversed',
    latestActiveTransfer([mk(1, null), mk(2, '2026-09-05T00:00:00Z')])?.transferNo,
    1,
  )
  check('latestActiveTransfer empty history', latestActiveTransfer([]), null)
  check('latestActiveTransfer all reversed', latestActiveTransfer([mk(1, '2026-09-05T00:00:00Z')]), null)

  // --- normalizeInvNo ---

  // 12) ' inv-17892784203457 ' → 'INV-17892784203457'
  check('normalizeInvNo trims+uppercases', normalizeInvNo(' inv-17892784203457 '), 'INV-17892784203457')

  // --- transferDebtWarning ---

  check(
    'transferDebtWarning with debt',
    transferDebtWarning(1500, 300),
    'สัญญานี้มียอดค้าง 1,500 บาท และค่าปรับค้าง 300 บาท — ยอดนี้จะกลายเป็นภาระของผู้ผ่อนคนใหม่ทันที',
  )
  check('transferDebtWarning no debt', transferDebtWarning(0, 0), null)

  return errs
}
