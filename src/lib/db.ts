// ===== ชั้นกลางเข้าถึงข้อมูล (Data Layer) =====
// หน้าเว็บเรียกฟังก์ชันในไฟล์นี้เสมอ — ภายในจะเลือกเองว่าจะดึงจาก Supabase จริง
// หรือใช้ข้อมูลตัวอย่าง (mock) ตามว่าใส่กุญแจใน .env แล้วหรือยัง
import { supabase } from './supabase'
import type {
  AuditEvent,
  AuditEventType,
  CashCollectedToday,
  CollectorCallOutcome,
  Contract,
  ContractStatus,
  ContractStatusRow,
  DeviceReturnRow,
  DeviceReturnReportRow,
  ShopContractTotal,
  ExtraCharge,
  GradeChangeType,
  GradeMonthlyChange,
  Installment,
  NotificationItem,
  Option,
  OtherIncome,
  OverdueBucket,
  OverduePromiseContract,
  CollectionMonthlyRow,
  PjDaysLateBucket,
  LetterOutcome,
  LetterOutcomeByRound,
  LetterOutcomeSummary,
  PjRecoveryEmployee,
  PjRecoveryMonth,
  PjRecoveryOutcomeMonth,
  PjRecoveryOutcomeSummary,
  PjRecoverySummary,
  PjReviewContext,
  PjSyncReviewRow,
  PjSyncRunRow,
  PrivateNote,
  Shop,
  TransferSlip,
  TransferSlipItem,
  TransferSlipSummaryRow,
} from './types'
import * as mock from './mockData'
import {
  DEFAULT_TIERS,
  DEFAULT_RECRUIT_BONUS,
  DEFAULT_RECRUIT_TIERS,
  DEFAULT_DEVICE_RETURN_TIERS_V2,
  type CommissionTier,
  type RecruitBonusRule,
  type RecruitTier,
  type DeviceReturnTier,
} from './commission'
import { DEFAULT_RATE_SETS, type RateSet } from './rates'
import type { SettlementTier, SettlementMatrix } from './settlement'
import type { AddressKind, CustomerAddress, LetterRecord, LetterReply } from './letters'
import type { DeviceStatus } from './returnWorkflow'
import { outstandingAfterReturn } from './outstandingExtras'
import {
  reconcileContractFees,
  FEE_RECONCILE_LAUNCH,
  type FeeKind,
  type FeeRight,
  type ReconcileResult,
} from './feeReconcile'
import { calcSummary, computePenaltyAccrual, penaltyPaidForInstallment, type PenaltyPayEvent } from './calc'
import { buildDeviceReturnByCollector, type DeviceReturnByCollectorResult } from './deviceReturnByCollector'
import type { PjReceiptDriftSnapshot } from './pjReceiptDrift'

export type OptionKind =
  | 'phone_model'
  | 'storage'
  | 'occupation'
  | 'occupation_proof'
  | 'promotion'

export interface AppSettings {
  docFee: number
  penaltyPerDay: number
  penaltyMaxDays: number
}

const DEFAULT_SETTINGS: AppSettings = { docFee: 100, penaltyPerDay: 100, penaltyMaxDays: 7 }

/** PostgREST default cap = 1000 rows (index 0-999). ขยายเป็น 5000 rows เพื่อรองรับการเติบโต 1+ ปี
 *  ใช้ .range(0, PAGE_CAP) บน query ที่ return list (ไม่ใช่ .single() / .maybeSingle() / count) */
const PAGE_CAP = 4999

// ---------- ตัวแปลงแถวฐานข้อมูล (snake_case) -> ชนิดข้อมูลในเว็บ (camelCase) ----------
interface ContractRow {
  id: string
  contract_no: string
  inv_no: string | null
  sn: string | null
  imei: string | null
  customer_name: string
  national_id: string | null
  phone: string | null
  phone_alt1: string | null
  phone_alt2: string | null
  facebook_link: string | null
  birth_year: number | null
  occupation: string | null
  occupation_proof: string | null
  shop_id: string
  model: string | null
  storage: string | null
  condition: 'new' | 'used'
  origin: 'th' | 'inter'
  device_price: number
  down_percent: number
  commission_percent: number
  doc_fee: number
  finance_amount: number | null
  monthly_payment: number | null
  term_months: number | null
  due_day: number | null
  has_promotion: boolean
  promotion: string | null
  promotion_detail: string | null
  status: Contract['status']
  transaction_date: string
  operator: string | null
  recorded_by: string | null
  recorded_by_name: string | null
  commission_rate_locked: number | null
  commission_locked_month: string | null
  notes: string | null
  summary_sent_at: string | null
  summary_sent_by: string | null
  summary_shop_sent_at: string | null
  summary_shop_sent_by: string | null
  summary_accounting_sent_at: string | null
  summary_accounting_sent_by: string | null
  email_sent_at: string | null
  email_sent_by: string | null
  current_grade: string | null
  dnc: boolean | null
  dnc_reason: string | null
  lawyer_engaged: boolean | null
  lawyer_name: string | null
  lawyer_phone: string | null
  lawyer_engaged_at: string | null
  disputed: boolean | null
  disputed_since: string | null
  promise_to_pay_date: string | null
  promised_amount: number | null
  color: string | null
  pending_documents: boolean | null
  original_docs_received: boolean | null
  original_docs_received_at: string | null
  original_docs_received_by: string | null
  has_phone_box: boolean | null
  phone_box_received: boolean | null
  phone_box_received_at: string | null
  phone_box_received_by: string | null
  pending_doc_items: string[] | null  // jsonb array (0053)
  docs_incomplete: boolean | null
  docs_incomplete_items: string[] | null  // jsonb array (0070)
  docs_incomplete_at: string | null
  docs_incomplete_by: string | null
  settled_at: string | null
  settlement_discount: number | null
  settlement_remaining: number | null
  settlement_paid: number | null
  settled_by: string | null
  needs_fix_reason: string | null
  needs_fix_detail: string | null
  needs_fix_by: string | null
  needs_fix_at: string | null
  assigned_to: string | null
  assigned_at: string | null
  summary_note: string | null
  summary_note_by: string | null
  summary_note_at: string | null
  created_at: string
}

function mapContract(r: ContractRow): Contract {
  return {
    id: r.id,
    contractNo: r.contract_no,
    invNo: r.inv_no ?? '',
    sn: r.sn ?? '',
    imei: r.imei ?? '',
    customerName: r.customer_name,
    nationalId: r.national_id ?? '',
    phone: r.phone ?? '',
    phoneAlt1: r.phone_alt1 ?? undefined,
    phoneAlt2: r.phone_alt2 ?? undefined,
    facebookLink: r.facebook_link ?? undefined,
    birthYear: r.birth_year ?? undefined,
    occupation: r.occupation ?? undefined,
    occupationProof: r.occupation_proof ?? undefined,
    shopId: r.shop_id,
    model: r.model ?? '',
    storage: r.storage ?? '',
    condition: r.condition,
    origin: r.origin,
    devicePrice: Number(r.device_price),
    downPercent: Number(r.down_percent),
    commissionPercent: Number(r.commission_percent),
    docFee: Number(r.doc_fee),
    financeAmount: Number(r.finance_amount ?? 0),
    monthlyPayment: Number(r.monthly_payment ?? 0),
    termMonths: Number(r.term_months ?? 0),
    dueDay: Number(r.due_day ?? 1),
    hasPromotion: r.has_promotion,
    promotion: r.promotion ?? undefined,
    promotionDetail: r.promotion_detail ?? undefined,
    status: r.status,
    transactionDate: r.transaction_date,
    operator: r.operator ?? '',
    recordedBy: r.recorded_by_name ?? '',
    recordedById: r.recorded_by ?? null,
    commissionRateLocked: r.commission_rate_locked == null ? null : Number(r.commission_rate_locked),
    commissionLockedMonth: r.commission_locked_month ?? null,
    notes: r.notes ?? undefined,
    summarySentAt: r.summary_sent_at,
    summarySentBy: r.summary_sent_by,
    summaryShopSentAt: r.summary_shop_sent_at,
    summaryShopSentBy: r.summary_shop_sent_by,
    summaryAccountingSentAt: r.summary_accounting_sent_at,
    summaryAccountingSentBy: r.summary_accounting_sent_by,
    emailSentAt: r.email_sent_at,
    emailSentBy: r.email_sent_by,
    currentGrade: r.current_grade ?? null,
    dnc: r.dnc ?? false,
    dncReason: r.dnc_reason ?? null,
    lawyerEngaged: r.lawyer_engaged ?? false,
    lawyerName: r.lawyer_name ?? null,
    lawyerPhone: r.lawyer_phone ?? null,
    lawyerEngagedAt: r.lawyer_engaged_at ?? null,
    disputed: r.disputed ?? false,
    disputedSince: r.disputed_since ?? null,
    promiseToPayDate: r.promise_to_pay_date ?? null,
    promisedAmount: r.promised_amount == null ? null : Number(r.promised_amount),
    color: r.color ?? undefined,
    pendingDocuments: r.pending_documents ?? false,
    pendingDocItems: Array.isArray(r.pending_doc_items) ? r.pending_doc_items : [],
    originalDocsReceived: r.original_docs_received ?? false,
    originalDocsReceivedAt: r.original_docs_received_at ?? null,
    originalDocsReceivedBy: r.original_docs_received_by ?? null,
    hasPhoneBox: r.has_phone_box ?? false,
    phoneBoxReceived: r.phone_box_received ?? false,
    phoneBoxReceivedAt: r.phone_box_received_at ?? null,
    phoneBoxReceivedBy: r.phone_box_received_by ?? null,
    docsIncomplete: r.docs_incomplete ?? false,
    docsIncompleteItems: Array.isArray(r.docs_incomplete_items) ? r.docs_incomplete_items : [],
    docsIncompleteAt: r.docs_incomplete_at ?? null,
    docsIncompleteBy: r.docs_incomplete_by ?? null,
    settledAt: r.settled_at ?? null,
    settlementDiscount: r.settlement_discount == null ? null : Number(r.settlement_discount),
    settlementRemaining: r.settlement_remaining == null ? null : Number(r.settlement_remaining),
    settlementPaid: r.settlement_paid == null ? null : Number(r.settlement_paid),
    settledBy: r.settled_by ?? null,
    needsFixReason: r.needs_fix_reason ?? null,
    needsFixDetail: r.needs_fix_detail ?? null,
    needsFixBy: r.needs_fix_by ?? null,
    needsFixAt: r.needs_fix_at ?? null,
    assignedTo: r.assigned_to ?? null,
    assignedAt: r.assigned_at ?? null,
    summaryNote: r.summary_note ?? null,
    summaryNoteBy: r.summary_note_by ?? null,
    summaryNoteAt: r.summary_note_at ?? null,
    createdAt: r.created_at,
  }
}

/** แปลงข้อมูลจากฟอร์ม -> object สำหรับ insert (เฉพาะคอลัมน์พื้นฐาน; ยอดที่คำนวณ DB ทำเอง) */
function toInsert(c: Omit<Contract, 'id'>) {
  return {
    contract_no: c.contractNo,
    inv_no: c.invNo?.trim() || null,   // trim กันช่องว่างหลุดเข้า (unique index 0076)
    sn: c.sn || null,
    imei: c.imei || null,
    customer_name: c.customerName,
    national_id: c.nationalId || null,
    phone: c.phone || null,
    phone_alt1: c.phoneAlt1 || null,
    phone_alt2: c.phoneAlt2 || null,
    facebook_link: c.facebookLink || null,
    birth_year: c.birthYear ?? null,
    occupation: c.occupation || null,
    occupation_proof: c.occupationProof || null,
    shop_id: c.shopId,
    model: c.model || null,
    storage: c.storage || null,
    condition: c.condition,
    origin: c.origin,
    device_price: c.devicePrice,
    down_percent: c.downPercent,
    commission_percent: c.commissionPercent,
    doc_fee: c.docFee,
    finance_amount: c.financeAmount,
    monthly_payment: c.monthlyPayment,
    term_months: c.termMonths,
    due_day: c.dueDay,
    has_promotion: c.hasPromotion,
    promotion: c.promotion || null,
    promotion_detail: c.promotionDetail || null,
    status: c.status,
    transaction_date: c.transactionDate,
    operator: c.operator || null,
    notes: c.notes || null,
    color: c.color || null,
    pending_documents: c.pendingDocuments ?? false,
    pending_doc_items: c.pendingDocItems ?? [],   // 0053 — รายการเอกสารที่รอ
    original_docs_received: false, // สัญญาใหม่ = ยังไม่ได้รับเอกสาร เสมอ
    has_phone_box: c.hasPhoneBox ?? false,
  }
}

const MOCK_OPTIONS: Record<OptionKind, Option[]> = {
  phone_model: mock.phoneModels,
  storage: mock.storageOptions,
  occupation: mock.occupations,
  occupation_proof: mock.occupationProofs,
  promotion: mock.promotions,
}

// ---------- API ที่หน้าเว็บเรียกใช้ ----------

export async function getShops(): Promise<Shop[]> {
  if (!supabase) return mock.shops
  const { data, error } = await supabase
    .from('shops')
    .select('*')
    .eq('active', true)
    .order('code')
    .range(0, PAGE_CAP)
  if (error) throw error
  return (data ?? []).map((s) => ({
    id: s.id,
    code: s.code,
    name: s.name,
    bank: s.bank ?? '',
    accountNo: s.account_no ?? '',
    accountName: s.account_name ?? '',
    active: s.active,
    ownerName: s.owner_name ?? '',
    phone: s.phone ?? '',
    facebookLink: s.facebook_link ?? '',
    contactChannel: s.contact_channel ?? '',
    address: s.address ?? '',
    province: s.province ?? '',
    recruitedBy: s.recruited_by ?? null,
    recruitedAt: s.recruited_at ?? null,
  }))
}

/** ร้านค้าทุกสถานะ (รวมที่ปิดแล้ว) — สำหรับหน้าตั้งค่า */
export async function getAllShops(): Promise<Shop[]> {
  if (!supabase) return mock.shops
  const { data, error } = await supabase.from('shops').select('*').order('code').range(0, PAGE_CAP)
  if (error) throw error
  return (data ?? []).map((s) => ({
    id: s.id,
    code: s.code,
    name: s.name,
    bank: s.bank ?? '',
    accountNo: s.account_no ?? '',
    accountName: s.account_name ?? '',
    active: s.active,
    ownerName: s.owner_name ?? '',
    phone: s.phone ?? '',
    facebookLink: s.facebook_link ?? '',
    contactChannel: s.contact_channel ?? '',
    address: s.address ?? '',
    province: s.province ?? '',
    recruitedBy: s.recruited_by ?? null,
    recruitedAt: s.recruited_at ?? null,
  }))
}

export async function getOptions(kind: OptionKind): Promise<Option[]> {
  if (!supabase) return MOCK_OPTIONS[kind]
  const { data, error } = await supabase
    .from('options')
    .select('*')
    .eq('kind', kind)
    .eq('active', true)
    .order('sort_order')
    .range(0, PAGE_CAP)
  if (error) throw error
  return (data ?? []).map((o) => ({
    id: o.id,
    label: o.label,
    detail: o.detail ?? undefined,
    active: o.active,
  }))
}

export async function getContracts(): Promise<Contract[]> {
  if (!supabase) return mock.contracts
  const { data, error } = await supabase
    .from('contracts')
    .select('*')
    .order('transaction_date', { ascending: false })
    .range(0, PAGE_CAP)
  if (error) throw error
  return ((data ?? []) as ContractRow[]).map(mapContract)
}

export async function getSettings(): Promise<AppSettings> {
  if (!supabase) return DEFAULT_SETTINGS
  const { data, error } = await supabase.from('app_settings').select('key, value')
  if (error) throw error
  const m = new Map((data ?? []).map((r) => [r.key, Number(r.value)]))
  return {
    docFee: m.get('doc_fee') ?? DEFAULT_SETTINGS.docFee,
    penaltyPerDay: m.get('penalty_per_day') ?? DEFAULT_SETTINGS.penaltyPerDay,
    penaltyMaxDays: m.get('penalty_max_days') ?? DEFAULT_SETTINGS.penaltyMaxDays,
  }
}

// ---------- ขั้นบันไดค่าคอมมิชชั่น (เก็บใน app_settings เป็น JSON) ----------
const COMMISSION_KEY = 'commission_tiers'

export async function getCommissionTiers(): Promise<CommissionTier[]> {
  if (!supabase) return DEFAULT_TIERS
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', COMMISSION_KEY)
    .maybeSingle()
  if (error) throw error
  if (!data?.value) return DEFAULT_TIERS
  try {
    const t = JSON.parse(data.value as string)
    return Array.isArray(t) && t.length ? (t as CommissionTier[]) : DEFAULT_TIERS
  } catch {
    return DEFAULT_TIERS
  }
}

/** บันทึกขั้นค่าคอม — เฉพาะแอดมิน (ตาม RLS). upsert เผื่อ key ยังไม่มี */
export async function saveCommissionTiers(tiers: CommissionTier[]): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from('app_settings').upsert(
    {
      key: COMMISSION_KEY,
      value: JSON.stringify(tiers),
      description: 'ขั้นบันไดค่าคอมมิชชั่น (บาท/เคส) — แก้ในหน้าตั้งค่า',
    },
    { onConflict: 'key' },
  )
  if (error) throw error
}

/** ปิดยอด (ล็อกเรต) เดือนหนึ่ง — เขียนเรตที่แช่แข็งลงทุกสัญญาที่บันทึกในเดือนนั้น
 *  updates แต่ละตัว = { contractId, rate } โดย rate = เรต flat ของเจ้าของเคสในเดือนนั้น */
export async function lockCommissionMonth(
  month: string,
  updates: { contractId: string; rate: number }[],
): Promise<void> {
  if (!supabase || updates.length === 0) return
  // อัปเดตทีละเคส (จำนวนเคสต่อเดือนไม่มาก — ชัดเจนกว่าทำ bulk ผ่าน rpc)
  for (const u of updates) {
    const { error } = await supabase
      .from('contracts')
      .update({ commission_rate_locked: u.rate, commission_locked_month: month })
      .eq('id', u.contractId)
    if (error) throw error
  }
}

/** ปลดล็อกเดือน — ล้างเรตที่ล็อกไว้ของทุกสัญญาที่ปิดยอดเดือนนั้น (กลับไปคิดสด) */
export async function unlockCommissionMonth(month: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase
    .from('contracts')
    .update({ commission_rate_locked: null, commission_locked_month: null })
    .eq('commission_locked_month', month)
  if (error) throw error
}

// ---------- ระบบเรตผ่อน (เก็บใน app_settings เป็น JSON) ----------
const RATE_SETS_KEY = 'installment_rate_sets'

export async function getRateSets(): Promise<RateSet[]> {
  if (!supabase) return DEFAULT_RATE_SETS
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', RATE_SETS_KEY)
    .maybeSingle()
  if (error) throw error
  if (!data?.value) return DEFAULT_RATE_SETS
  try {
    const s = JSON.parse(data.value as string)
    return Array.isArray(s) && s.length ? (s as RateSet[]) : DEFAULT_RATE_SETS
  } catch {
    return DEFAULT_RATE_SETS
  }
}

/** บันทึกชุดเรต — เฉพาะแอดมิน (ตาม RLS). upsert เผื่อ key ยังไม่มี */
export async function saveRateSets(sets: RateSet[]): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from('app_settings').upsert(
    { key: RATE_SETS_KEY, value: JSON.stringify(sets), description: 'ชุดเรตผ่อน (ตัวคูณต่อจำนวนงวด)' },
    { onConflict: 'key' },
  )
  if (error) throw error
}

// ---------- ปิดสัญญาก่อนกำหนด + ส่วนลด (0078) ----------
const SETTLEMENT_TIERS_KEY = 'settlement_tiers'

/** อ่านชั้นส่วนลดปิดสัญญาก่อนกำหนด — ว่าง/พัง → [] */
export async function getSettlementTiers(): Promise<SettlementTier[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', SETTLEMENT_TIERS_KEY)
    .maybeSingle()
  if (error) throw error
  if (!data?.value) return []
  try {
    const t = JSON.parse(data.value as string)
    return Array.isArray(t) ? (t as SettlementTier[]) : []
  } catch {
    return []
  }
}

/** บันทึกชั้นส่วนลด — เฉพาะแอดมิน (ตาม RLS). upsert เผื่อ key ยังไม่มี */
export async function saveSettlementTiers(tiers: SettlementTier[]): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from('app_settings').upsert(
    {
      key: SETTLEMENT_TIERS_KEY,
      value: JSON.stringify(tiers),
      description: 'ชั้นส่วนลดปิดสัญญาก่อนกำหนด (เหลือกี่งวดขึ้นไป → ส่วนลด %)',
    },
    { onConflict: 'key' },
  )
  if (error) throw error
}

// ---------- ตารางส่วนลดปิดสัญญาแบบใหม่ (matrix ชนิดสัญญา × งวดที่จ่ายแล้ว) (0112) ----------
const SETTLEMENT_MATRIX_KEY = 'settlement_matrix'

/** อ่านตารางส่วนลดปิดสัญญาแบบ matrix — ว่าง/พัง/รูปแบบผิด → {} (ห้าม throw) */
export async function getSettlementMatrix(): Promise<SettlementMatrix> {
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', SETTLEMENT_MATRIX_KEY)
    .maybeSingle()
  if (error) throw error
  if (!data?.value) return {}
  try {
    const parsed = JSON.parse(data.value as string)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as SettlementMatrix
  } catch {
    return {}
  }
}

/** บันทึกตารางส่วนลด matrix — เฉพาะแอดมิน (ตาม RLS). upsert เผื่อ key ยังไม่มี */
export async function saveSettlementMatrix(matrix: SettlementMatrix): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from('app_settings').upsert(
    {
      key: SETTLEMENT_MATRIX_KEY,
      value: JSON.stringify(matrix),
      description:
        'ตารางส่วนลดปิดสัญญาก่อนกำหนด (ใหม่) — key ชั้นนอก = จำนวนงวดทั้งหมดของสัญญา (term), key ชั้นใน = จำนวนงวดที่จ่ายแล้ว (paidCount), value = % ส่วนลด',
    },
    { onConflict: 'key' },
  )
  if (error) throw error
}

/** ปิดสัญญาก่อนกำหนด: ปิดงวดค้างทั้งหมด + บันทึกเงินรับ 1 ก้อน + flip active→closed
 *  RPC guard: admin/staff เท่านั้น + ทำเฉพาะสัญญาที่ยังเป็น 'active'
 *  @param contractId  id ของสัญญา
 *  @param payload     ยอดที่คิดจาก computeSettlement (remaining/discount/paid/penalty)
 *  @param byName      ชื่อผู้กดปิด (useAuth().name) */
export async function settleContractEarly(
  contractId: string,
  payload: { remaining: number; discount: number; paid: number; penalty: number },
  byName: string,
): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.rpc('settle_contract_early', {
    p_contract_id: contractId,
    p_remaining: payload.remaining,
    p_discount: payload.discount,
    p_paid: payload.paid,
    p_penalty: payload.penalty,
    p_by: byName,
  })
  if (error) throw error
}

export interface SettlementReportRow {
  contractId: string
  contractNo: string
  customerName: string
  discount: number
  remaining: number
  paid: number
  settledAt: string
  settledBy: string
}

/** รายงานสัญญาที่ปิดก่อนกำหนด (settled_at not null) เรียงล่าสุดก่อน
 *  @param fromDate/toDate  กรองช่วง settled_at (ISO) — ส่งถ้าต้องการช่วง */
export async function getSettlementReport(
  fromDate?: string,
  toDate?: string,
): Promise<{
  rows: SettlementReportRow[]
  totalDiscount: number
  totalPaid: number
  count: number
}> {
  if (!supabase) return { rows: [], totalDiscount: 0, totalPaid: 0, count: 0 }
  let q = supabase
    .from('contracts')
    .select('id, contract_no, customer_name, settlement_discount, settlement_remaining, settlement_paid, settled_at, settled_by')
    .not('settled_at', 'is', null)
    .order('settled_at', { ascending: false })
    .range(0, PAGE_CAP)
  if (fromDate) q = q.gte('settled_at', fromDate)
  if (toDate) q = q.lte('settled_at', toDate)
  const { data, error } = await q
  if (error) throw error
  const rows: SettlementReportRow[] = (data ?? []).map((r) => ({
    contractId: r.id as string,
    contractNo: r.contract_no as string,
    customerName: r.customer_name as string,
    discount: Number(r.settlement_discount ?? 0),
    remaining: Number(r.settlement_remaining ?? 0),
    paid: Number(r.settlement_paid ?? 0),
    settledAt: r.settled_at as string,
    settledBy: (r.settled_by as string) ?? '',
  }))
  return {
    rows,
    totalDiscount: rows.reduce((s, r) => s + r.discount, 0),
    totalPaid: rows.reduce((s, r) => s + r.paid, 0),
    count: rows.length,
  }
}

// ---------- ค่าคอมหาร้าน (เก็บใน app_settings เป็น JSON) ----------
const RECRUIT_TIERS_KEY = 'recruit_shop_tiers'
const RECRUIT_BONUS_KEY = 'recruit_bonus'

export async function getRecruitTiers(): Promise<RecruitTier[]> {
  if (!supabase) return DEFAULT_RECRUIT_TIERS
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', RECRUIT_TIERS_KEY)
    .maybeSingle()
  if (error) throw error
  if (!data?.value) return DEFAULT_RECRUIT_TIERS
  try {
    const t = JSON.parse(data.value as string)
    return Array.isArray(t) && t.length ? (t as RecruitTier[]) : DEFAULT_RECRUIT_TIERS
  } catch {
    return DEFAULT_RECRUIT_TIERS
  }
}

export async function saveRecruitTiers(tiers: RecruitTier[]): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from('app_settings').upsert(
    { key: RECRUIT_TIERS_KEY, value: JSON.stringify(tiers), description: 'ขั้นบันไดค่าคอมหาร้าน (บาท/ร้าน)' },
    { onConflict: 'key' },
  )
  if (error) throw error
}

export async function getRecruitBonuses(): Promise<RecruitBonusRule[]> {
  if (!supabase) return DEFAULT_RECRUIT_BONUS
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', RECRUIT_BONUS_KEY)
    .maybeSingle()
  if (error) throw error
  if (!data?.value) return DEFAULT_RECRUIT_BONUS
  try {
    const t = JSON.parse(data.value as string)
    return Array.isArray(t) && t.length ? (t as RecruitBonusRule[]) : DEFAULT_RECRUIT_BONUS
  } catch {
    return DEFAULT_RECRUIT_BONUS
  }
}

export async function saveRecruitBonuses(rules: RecruitBonusRule[]): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from('app_settings').upsert(
    { key: RECRUIT_BONUS_KEY, value: JSON.stringify(rules), description: 'โบนัสร้านส่งเคสครบเป้าในกรอบเวลา' },
    { onConflict: 'key' },
  )
  if (error) throw error
}

const DEVICE_RETURN_TIERS_KEY = 'device_return_tiers_v2'

export async function getDeviceReturnTiers(): Promise<DeviceReturnTier[]> {
  if (!supabase) return DEFAULT_DEVICE_RETURN_TIERS_V2
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', DEVICE_RETURN_TIERS_KEY)
    .maybeSingle()
  if (error) throw error
  if (!data?.value) return DEFAULT_DEVICE_RETURN_TIERS_V2
  try {
    const t = JSON.parse(data.value as string)
    return Array.isArray(t) && t.length ? (t as DeviceReturnTier[]) : DEFAULT_DEVICE_RETURN_TIERS_V2
  } catch {
    return DEFAULT_DEVICE_RETURN_TIERS_V2
  }
}

export async function saveDeviceReturnTiers(tiers: DeviceReturnTier[]): Promise<void> {
  if (!supabase) return
  const { error } = await supabase
    .from('app_settings')
    .upsert(
      {
        key: DEVICE_RETURN_TIERS_KEY,
        value: JSON.stringify(tiers),
        description: 'ขั้นบรรไดค่าคอมฟรีแลนซ์คืนเครื่อง (บาท/เครื่อง retroactive รายเดือน นับทุก status)',
      },
      { onConflict: 'key' },
    )
  if (error) throw error
}

// ---------- ตั้งค่าบริษัทสำหรับข้อความ SMS/จดหมาย (เก็บใน app_settings, key แยกทีละตัว) ----------
// ยังไม่มี key เหล่านี้ใน DB จริง (ครีมจะ seed ทีหลัง) — อ่านไม่เจอ = คืนค่าว่าง '' ทั้งหมด ไม่ throw
// (ต่างจาก pattern JSON เดิม เพราะนี่เป็น 3 ค่าแยกอิสระกัน ไม่ใช่ก้อนเดียว)
export async function getCompanySmsSettings(): Promise<{
  companyName: string
  companyPhone: string
  returnAddress: string
}> {
  const fallback = { companyName: '', companyPhone: '', returnAddress: '' }
  if (!supabase) return fallback
  const { data, error } = await supabase
    .from('app_settings')
    .select('key, value')
    .in('key', ['company_name', 'company_phone', 'sms_return_address'])
  if (error) throw error
  const m = new Map((data ?? []).map((r) => [r.key as string, r.value as string]))
  return {
    companyName: m.get('company_name') ?? fallback.companyName,
    companyPhone: m.get('company_phone') ?? fallback.companyPhone,
    returnAddress: m.get('sms_return_address') ?? fallback.returnAddress,
  }
}

export async function insertContract(c: Omit<Contract, 'id'>): Promise<string> {
  if (!supabase) {
    // โหมด mock — ยังไม่บันทึกจริง
    return ''
  }
  const { data, error } = await supabase.from('contracts').insert(toInsert(c)).select('id').single()
  if (error) throw error
  return (data?.id as string) ?? ''
}

/** ทำเครื่องหมายว่าสรุปยอดแล้ว (กันส่งซ้ำ) — บันทึกลง DB จริง
 *  @param senderName ชื่อผู้ส่ง (useAuth().name = full_name) — optional เพื่อ backward compat
 *                    น้องวิวส่ง name จาก useAuth() ในหน้า WaitingSummary */
export async function markSummarySent(ids: string[], senderName?: string): Promise<void> {
  if (!supabase || ids.length === 0) return
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('contracts')
    .update({
      summary_sent_at: now,
      summary_sent_by: senderName ?? null,
      // auto-clear รอเอกสาร เมื่อยืนยันสรุปยอด (confirm-gate model 0049)
      pending_documents: false,
      documents_confirmed_at: now,
      documents_confirmed_by: senderName ?? null,
    })
    .in('id', ids)
  if (error) throw error
}

/** สรุปยอด 2 ด่าน รอบ 1 — ส่งร้าน (0075 · date-aware 0105)
 *  set summary_shop_sent_at/by + mirror summary_sent_at/by (กัน audit log เดิมที่อ่าน summary_sent_at พัง)
 *  คง auto-clear รอเอกสาร เหมือน markSummarySent เดิม (รอบ 1 = ยืนยันเอกสารครบ + ส่งร้าน)
 *  เกาะ "วันที่สรุปที่เลือก" ผ่าน RPC mark_summary_shop_sent (Postgres ประกอบ ts = วันที่เลือก +
 *    เวลานาฬิกาปัจจุบัน Bangkok) แทน now() — กัน /transfers จัดกลุ่มผิดวัน. dateISO ว่าง → fallback now()
 *  @param senderName ชื่อผู้ส่ง (useAuth().name = full_name) — optional เพื่อ backward compat
 *  @param dateISO วันที่สรุปที่พนักงานเลือก (YYYY-MM-DD) — optional; ว่าง = ใช้ now() */
export async function markSummaryShopSent(ids: string[], senderName?: string, dateISO?: string): Promise<void> {
  if (!supabase || ids.length === 0) return
  const { error } = await supabase.rpc('mark_summary_shop_sent', {
    p_ids: ids,
    p_sender: senderName ?? null,
    p_date: dateISO ?? null,
  })
  if (error) throw error
}

/** สรุปยอด 2 ด่าน รอบ 2 — ส่งบัญชี (0075 · date-aware 0105)
 *  set summary_accounting_sent_at/by เท่านั้น (ไม่แตะ pending_documents / summary_sent_at)
 *  เกาะ "วันที่สรุปที่เลือก" ผ่าน RPC mark_summary_accounting_sent เช่นเดียวกับรอบ 1. dateISO ว่าง → now()
 *  @param senderName ชื่อผู้ส่ง (useAuth().name = full_name) — optional เพื่อ backward compat
 *  @param dateISO วันที่สรุปที่พนักงานเลือก (YYYY-MM-DD) — optional; ว่าง = ใช้ now() */
export async function markSummaryAccountingSent(ids: string[], senderName?: string, dateISO?: string): Promise<void> {
  if (!supabase || ids.length === 0) return
  const { error } = await supabase.rpc('mark_summary_accounting_sent', {
    p_ids: ids,
    p_sender: senderName ?? null,
    p_date: dateISO ?? null,
  })
  if (error) throw error
}

/** เหตุผลตีกลับสรุปยอด (0084) — ตรงกับ constraint ที่ UI ใช้ (ไม่มี check constraint ใน DB ตั้งใจ เผื่อเพิ่มเหตุผลทีหลังไม่ต้อง migration) */
export type NeedsFixReason = 'docs_incorrect' | 'price_incorrect' | 'duplicate' | 'missing_info' | 'other'

/** บัญชีตีกลับเคส — set needs_fix_* + reset สถานะส่งสรุปยอดทั้ง 2 ด่าน (0084)
 *  เคสจะเด้งกลับคอลัมน์ซ้ายของ waiting-summary (filter !summaryShopSentAt เหมือนเคสใหม่)
 *  ไม่แตะ pending_documents/email_sent_* — เคสยังถือว่า "เอกสารครบ" แค่ยอด/ข้อมูลผิด ต้องแก้แล้วส่งใหม่ */
export async function rejectSummaryContract(
  contractId: string,
  reasonCode: NeedsFixReason,
  detail: string | null,
  byName: string,
): Promise<void> {
  if (!supabase) return
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('contracts')
    .update({
      needs_fix_reason: reasonCode,
      needs_fix_detail: detail,
      needs_fix_by: byName,
      needs_fix_at: now,
      // เด้งกลับคอลัมน์ซ้าย — reset สถานะส่งสรุปยอดทั้ง 2 ด่าน (ตรง pattern bounce-back ของ setContractFlags)
      summary_shop_sent_at: null,
      summary_shop_sent_by: null,
      summary_accounting_sent_at: null,
      summary_accounting_sent_by: null,
    })
    .eq('id', contractId)
  if (error) throw error
}

/** เคลียร์ needs_fix_* — พนักงานแก้เสร็จแล้ว (เรียกก่อนส่งสรุปยอดใหม่) */
export async function clearNeedsFix(contractId: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase
    .from('contracts')
    .update({
      needs_fix_reason: null,
      needs_fix_detail: null,
      needs_fix_by: null,
      needs_fix_at: null,
    })
    .eq('id', contractId)
  if (error) throw error
}

/** หมายเหตุเคสติดปัญหา (0089) — พนักงานโน้ตเองว่าเคสนี้สรุปยอดไม่ได้เพราะติดอะไร
 *  คนละระบบกับ needs_fix_* (บัญชีตีกลับ) — ห้ามชนกัน
 *  เขียนผ่าน RPC set_summary_note เท่านั้น (ไม่เปิด contracts update policy กว้างขึ้น) — RPC ดึงชื่อผู้เขียนจาก
 *  profiles ของ auth.uid() เอง กัน spoof ชื่อ; note = null หรือ '' = เคลียร์โน้ต
 *  frozen signature — น้องวิวเรียกตามนี้ (byName รับไว้เพื่อความสม่ำเสมอกับฟังก์ชันอื่นในไฟล์นี้ แต่ RPC ไม่ใช้ค่านี้) */
export async function updateSummaryNote(contractId: string, note: string | null, _byName: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.rpc('set_summary_note', {
    p_contract_id: contractId,
    p_note: note,
  })
  if (error) throw error
}

/** ส่งสรุปยอดกลับให้พนักงานแก้ (bulk) — reset สถานะส่ง 2 ด่าน + ตั้ง needs_fix เป็น reason='other' พร้อม note
 *  ต่างจาก rejectSummaryContract ตรงที่รับหลายสัญญาพร้อมกัน (ใช้ตอนเลือกหลายแถวแล้วกด "ส่งกลับ") */
export async function sendSummaryBackToStaff(contractIds: string[], note: string, byName: string): Promise<void> {
  if (!supabase || contractIds.length === 0) return
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('contracts')
    .update({
      needs_fix_reason: 'other',
      needs_fix_detail: note,
      needs_fix_by: byName,
      needs_fix_at: now,
      summary_shop_sent_at: null,
      summary_shop_sent_by: null,
      summary_accounting_sent_at: null,
      summary_accounting_sent_by: null,
    })
    .in('id', contractIds)
  if (error) throw error
}

/** แก้ "วันที่โอน" ของสัญญา ที่หน้า /transfers ใช้จัดกลุ่มยอดรายวัน (0094 RPC)
 *  ⚠️ แก้ contracts.summary_accounting_sent_at (วันส่งบัญชี — คอลัมน์ที่ getDailyTransferByShop/getDailyTransferContracts group จริง)
 *     ไม่แตะ transaction_date (วันขาย ที่ weekly-summary ใช้) — ตั้งใจแยก 2 ความหมายนี้ออกจากกัน ไม่ให้ weekly-summary เพี้ยนตามโดยไม่ตั้งใจ
 *  ⚠️ กระทบ daily-report (getDailyAudit อ่าน summary_accounting_sent_at ตัวเดียวกัน) — event "ส่งสรุปยอดให้บัญชี" จะย้ายวันตามไปด้วย (ตั้งใจ ถือเป็นพฤติกรรมที่ถูกต้อง เพราะ 2 หน้าจอนี้เกาะฟิลด์เดียวกัน)
 *  ⚠️ ไม่แตะ shop_transfer (สลิป/สถานะยืนยันโอน) เลย — เพราะ shop_transfer เป็น 1 แถว/ร้าน/วัน ไม่ใช่ต่อสัญญา ย้ายสัญญา
 *     1 ใบ "ย้ายสลิปตามไม่ได้" — RPC ไม่บล็อกแม้ร้านนั้นจะยืนยันโอน/แนบสลิปแล้ว (transferred=true) ในวันต้นทาง/ปลายทาง
 *     ก็แก้ได้ปกติ (Pete ตัดสินใจ 2026-07-10: ยอมรับความเสี่ยงยอดไม่ตรงสลิปเดิม เพื่อความยืดหยุ่นแก้ย้อนหลัง)
 *  admin-only (guard ซ้ำใน RPC เอง กัน staff เรียกตรง แม้ RLS contracts_write จะกว้างกว่า) */
export async function updateContractTransferDate(contractId: string, newDateISO: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.rpc('update_contract_transfer_date', {
    p_contract_id: contractId,
    p_new_date: newDateISO,
  })
  if (error) throw error
}

/** ทำเครื่องหมายว่าส่งอีเมลแล้ว (กันส่งซ้ำ)
 *  @param senderName ชื่อผู้ส่ง (useAuth().name = full_name) — optional เพื่อ backward compat
 *                    น้องวิวส่ง name จาก useAuth() ในหน้า WaitingEmail */
export async function markEmailSent(id: string, senderName?: string): Promise<void> {
  if (!supabase) return
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('contracts')
    .update({
      email_sent_at: now,
      email_sent_by: senderName ?? null,
    })
    .eq('id', id)
  if (error) throw error
}

/** ยืนยันว่ารับเอกสารตัวจริงแล้ว (0050)
 *  @param contractId id ของสัญญา
 *  @param receiverName ชื่อผู้รับ (useAuth().name) — optional */
export async function markDocsReceived(contractId: string, receiverName?: string): Promise<void> {
  if (!supabase) return
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('contracts')
    .update({
      original_docs_received: true,
      original_docs_received_at: now,
      original_docs_received_by: receiverName ?? null,
    })
    .eq('id', contractId)
  if (error) throw error
}

/** ยืนยันว่ารับกล่องโทรศัพท์คืนจากร้านแล้ว (0050)
 *  @param contractId id ของสัญญา
 *  @param receiverName ชื่อผู้รับ (useAuth().name) — optional */
export async function markBoxReceived(contractId: string, receiverName?: string): Promise<void> {
  if (!supabase) return
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('contracts')
    .update({
      phone_box_received: true,
      phone_box_received_at: now,
      phone_box_received_by: receiverName ?? null,
    })
    .eq('id', contractId)
  if (error) throw error
}

/** ตั้งธง "รับเอกสารแล้ว แต่ไม่ครบ/ต้องแก้ไข" (0070)
 *  เคสยังถือว่ารับเอกสารแล้ว (ไม่กระทบ originalDocsReceived / isDocComplete) แค่ติดธงเตือน
 *  @param contractId id ของสัญญา
 *  @param items คีย์เอกสารที่ขาด เช่น ["contract","receipt"] — array ว่าง = เคลียร์ธง
 *  @param byName ชื่อผู้ติดธง (useAuth().name) */
export async function setDocsIncomplete(contractId: string, items: string[], byName: string): Promise<void> {
  if (!supabase) return
  const flagged = items.length > 0
  const { error } = await supabase
    .from('contracts')
    .update({
      docs_incomplete: flagged,
      docs_incomplete_items: items,
      docs_incomplete_at: flagged ? new Date().toISOString() : null,
      docs_incomplete_by: flagged ? byName : null,
    })
    .eq('id', contractId)
  if (error) throw error
}

// ============================================================================
// Doc Reject Log (0051) — ตีกลับเอกสาร/กล่อง พร้อมเหตุผล
// ============================================================================

/** แถวจาก doc_reject_log (snake_case ตาม Postgres) */
export interface DocRejectLogRow {
  id:          string
  contract_id: string
  item_type:   'docs' | 'box'
  reason:      string
  rejected_by: string | null
  rejected_at: string
}

/** Domain type สำหรับ UI (camelCase) */
export interface DocRejectEntry {
  id:          string
  itemType:    'docs' | 'box'
  reason:      string
  rejectedBy:  string | null
  rejectedAt:  string
}

function mapDocRejectEntry(r: DocRejectLogRow): DocRejectEntry {
  return {
    id:         r.id,
    itemType:   r.item_type,
    reason:     r.reason,
    rejectedBy: r.rejected_by,
    rejectedAt: r.rejected_at,
  }
}

/** ตีกลับเอกสาร หรือ กล่องโทรศัพท์ → reset flag + บันทึกประวัติ (atomic RPC 0051)
 *  @param contractId  id ของสัญญา
 *  @param itemType    'docs' = เอกสารตัวจริง | 'box' = กล่องโทรศัพท์
 *  @param reason      เหตุผลการตีกลับ (บังคับ)
 *  @param byName      ชื่อผู้ตีกลับ (useAuth().name) — optional */
export async function revertDocReceipt(
  contractId: string,
  itemType:   'docs' | 'box',
  reason:     string,
  byName?:    string,
): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.rpc('revert_doc_receipt', {
    p_contract_id: contractId,
    p_item_type:   itemType,
    p_reason:      reason,
    p_by:          byName ?? null,
  })
  if (error) throw error
}

/** ดึงประวัติการตีกลับเอกสาร/กล่องของสัญญา เรียงล่าสุดก่อน (0051)
 *  @param contractId  id ของสัญญา */
export async function getDocRejectLog(contractId: string): Promise<DocRejectEntry[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('doc_reject_log')
    .select('*')
    .eq('contract_id', contractId)
    .order('rejected_at', { ascending: false })
  if (error) throw error
  return (data ?? []).map((r) => mapDocRejectEntry(r as DocRejectLogRow))
}

/** ปิดสัญญาเคสคืนเครื่องเมื่อรับเงินครบ: status returned → returned_closed
 *  RPC guard: admin/staff เท่านั้น + flip เฉพาะสัญญาที่ยังเป็น 'returned'
 *  @param contractId  id ของสัญญา
 *  @param byName      ชื่อผู้กดปิด (useAuth().name) */
export async function closeReturnedContract(contractId: string, byName: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.rpc('close_returned_contract', {
    p_contract_id: contractId,
    p_by: byName,
  })
  if (error) throw error
}

/** ข้อมูลเช็คก่อนลบสัญญา — ใช้โชว์คำเตือนหนักๆ ที่ UI ก่อนกดยืนยันลบ (0095)
 *  ไม่ได้ block การลบ (Pete: admin ลบได้แม้มีประวัติ) — ใช้เฉพาะเพื่อ warn */
export interface ContractDeleteGuardInfo {
  hasPayments: boolean      // เคยมี payment_log action='pay' ไหม
  hasDeviceReturn: boolean  // เคยมีรายการคืนเครื่องไหม
  wasTransferred: boolean   // เคยส่งสรุปให้ร้าน/บัญชีไปแล้วไหม (summary_shop_sent_at / summary_accounting_sent_at)
}

/** เช็คประวัติสัญญาก่อนลบ (โชว์คำเตือนที่ UI) — เรียกก่อน deleteContract() เสมอ
 *  @param contractId  id ของสัญญา */
export async function getContractDeleteGuardInfo(contractId: string): Promise<ContractDeleteGuardInfo> {
  if (!supabase) return { hasPayments: false, hasDeviceReturn: false, wasTransferred: false }

  const [paymentRes, returnRes, contractRes] = await Promise.all([
    supabase
      .from('payment_log')
      .select('id', { count: 'exact', head: true })
      .eq('contract_id', contractId)
      .eq('action', 'pay'),
    supabase
      .from('device_returns')
      .select('id', { count: 'exact', head: true })
      .eq('contract_id', contractId),
    supabase
      .from('contracts')
      .select('summary_shop_sent_at, summary_accounting_sent_at')
      .eq('id', contractId)
      .maybeSingle(),
  ])
  if (paymentRes.error) throw paymentRes.error
  if (returnRes.error) throw returnRes.error
  if (contractRes.error) throw contractRes.error

  return {
    hasPayments: (paymentRes.count ?? 0) > 0,
    hasDeviceReturn: (returnRes.count ?? 0) > 0,
    wasTransferred: !!(contractRes.data?.summary_shop_sent_at || contractRes.data?.summary_accounting_sent_at),
  }
}

/** ลบสัญญาถาวร (admin เท่านั้น — RPC guard) — สำรอง snapshot ลง deleted_contracts_archive
 *  ก่อนลบเสมอ (0095). ไม่ block แม้มีประวัติจ่าย/โอน — เตือนที่ UI ผ่าน getContractDeleteGuardInfo()
 *  แทน. เลข contract_no/inv_no กลับมาใช้ใหม่ได้ทันทีหลังลบสำเร็จ
 *  @param contractId  id ของสัญญาที่จะลบ
 *  @param byName      ชื่อผู้กดลบ (useAuth().name) — บันทึกลง archive.deleted_by (บังคับ ห้ามว่าง)
 *  @returns           contractNo ที่เพิ่งปลดออกมา (ใช้โชว์ toast ยืนยัน) */
export async function deleteContract(contractId: string, byName: string): Promise<{ contractNo: string }> {
  if (!supabase) return { contractNo: '' }
  const { data, error } = await supabase.rpc('delete_contract', {
    p_contract_id: contractId,
    p_by: byName,
  })
  if (error) throw error
  return { contractNo: (data as string) ?? '' }
}

export async function getContract(id: string): Promise<Contract | null> {
  if (!supabase) return mock.contracts.find((c) => c.id === id) ?? null
  const { data, error } = await supabase.from('contracts').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  if (!data) return null
  const contract = mapContract(data as ContractRow)
  // join ชื่อผู้ถือเคส (assignedToName) — เคสเดียว ไม่ N+1 ยิงแยกได้; ว่าง (assigned_to null) ข้ามไปเลย
  if (contract.assignedTo) {
    const { data: assigneeProfile, error: assigneeErr } = await supabase
      .from('profiles')
      .select('full_name')
      .eq('id', contract.assignedTo)
      .maybeSingle()
    if (assigneeErr) throw assigneeErr
    contract.assignedToName = (assigneeProfile as { full_name: string | null } | null)?.full_name ?? null
  }
  return contract
}

/** ดึงเลขที่สัญญาทั้งหมดของร้านหนึ่ง — ใช้รันเลขถัดไปอัตโนมัติ */
export async function getShopContractNos(shopId: string): Promise<string[]> {
  if (!supabase) return mock.contracts.filter((c) => c.shopId === shopId).map((c) => c.contractNo)
  const { data, error } = await supabase.from('contracts').select('contract_no').eq('shop_id', shopId).range(0, PAGE_CAP)
  if (error) throw error
  return (data ?? []).map((r) => r.contract_no as string)
}

/** เช็คว่าเลขที่สัญญานี้ถูกใช้ไปแล้วหรือยัง (กันเลขซ้ำ) — ข้าม id ตัวเองตอนแก้ไข */
export async function contractNoExists(contractNo: string, exceptId?: string): Promise<boolean> {
  if (!supabase) return mock.contracts.some((c) => c.contractNo === contractNo && c.id !== exceptId)
  let q = supabase.from('contracts').select('id').eq('contract_no', contractNo)
  if (exceptId) q = q.neq('id', exceptId)
  const { data, error } = await q.limit(1)
  if (error) throw error
  return (data ?? []).length > 0
}

/** หาสัญญาที่ใช้เลขใบ PJ (inv_no) นี้แล้ว — ใช้บล็อกตอนบันทึก กันคีย์ใบเดิมซ้ำ
 *  คืน null ถ้ายังไม่มีใครใช้. invNo ถูก trim ก่อนเทียบ (ตรงกับ unique index 0076) */
export async function findContractByInvNo(
  invNo: string,
): Promise<{ id: string; contractNo: string; customerName: string } | null> {
  const norm = invNo.trim()
  if (!norm) return null
  if (!supabase) {
    const m = mock.contracts.find((c) => (c.invNo ?? '').trim() === norm)
    return m ? { id: m.id, contractNo: m.contractNo, customerName: m.customerName } : null
  }
  const { data, error } = await supabase
    .from('contracts')
    .select('id, contract_no, customer_name')
    .eq('inv_no', norm)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
    ? { id: data.id as string, contractNo: data.contract_no as string, customerName: data.customer_name as string }
    : null
}

/** หาสัญญาทั้งหมดที่ใช้เลขบัตรประชาชนนี้ — ใช้เตือน (ไม่บล็อก) ตอนบันทึกลูกค้าซ้ำ
 *  คืน [] ถ้าไม่มี. select เฉพาะ contract_no + customer_name (ไม่ดึง PII เกินจำเป็น) */
export async function findContractsByNationalId(
  nationalId: string,
): Promise<{ contractNo: string; customerName: string }[]> {
  const norm = nationalId.trim()
  if (!norm) return []
  if (!supabase) {
    return mock.contracts
      .filter((c) => (c.nationalId ?? '').trim() === norm)
      .map((c) => ({ contractNo: c.contractNo, customerName: c.customerName }))
  }
  const { data, error } = await supabase
    .from('contracts')
    .select('contract_no, customer_name')
    .eq('national_id', norm)
    .range(0, PAGE_CAP)
  if (error) throw error
  return (data ?? []).map((r) => ({
    contractNo: r.contract_no as string,
    customerName: r.customer_name as string,
  }))
}

/** payload สำหรับ UPDATE — ตรงกับ toInsert แต่ไม่มี doc-tracking fields
 *  (original_docs_received, has_phone_box, pending_documents)
 *  เพื่อกันการรีเซ็ตสถานะรับเอกสาร/กล่องทุกครั้งที่กดแก้ไขสัญญา */
function toUpdate(c: Omit<Contract, 'id'>) {
  return {
    contract_no: c.contractNo,
    inv_no: c.invNo?.trim() || null,   // trim กันช่องว่างหลุดเข้า (unique index 0076)
    sn: c.sn || null,
    imei: c.imei || null,
    customer_name: c.customerName,
    national_id: c.nationalId || null,
    phone: c.phone || null,
    phone_alt1: c.phoneAlt1 || null,
    phone_alt2: c.phoneAlt2 || null,
    facebook_link: c.facebookLink || null,
    birth_year: c.birthYear ?? null,
    occupation: c.occupation || null,
    occupation_proof: c.occupationProof || null,
    shop_id: c.shopId,
    model: c.model || null,
    storage: c.storage || null,
    condition: c.condition,
    origin: c.origin,
    device_price: c.devicePrice,
    down_percent: c.downPercent,
    commission_percent: c.commissionPercent,
    doc_fee: c.docFee,
    finance_amount: c.financeAmount,
    monthly_payment: c.monthlyPayment,
    term_months: c.termMonths,
    due_day: c.dueDay,
    has_promotion: c.hasPromotion,
    promotion: c.promotion || null,
    promotion_detail: c.promotionDetail || null,
    status: c.status,
    transaction_date: c.transactionDate,
    operator: c.operator || null,
    notes: c.notes || null,
    color: c.color || null,
    // doc-tracking fields (original_docs_received, has_phone_box, pending_documents,
    //   pending_doc_items) ไม่ถูกส่งใน UPDATE — แก้ผ่าน markDocsReceived / setContractFlags / revertDocReceipt
  }
}

export async function updateContract(id: string, c: Omit<Contract, 'id'>): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from('contracts').update(toUpdate(c)).eq('id', id)
  if (error) throw error
}

// ---------- งวดผ่อน + สถานะล่าช้า (Phase 3/4) ----------
interface InstallmentRow {
  id: string
  contract_id?: string   // มีเฉพาะตอน select cross-contract (เช่น คิวเคสคืนเครื่อง)
  installment_no: number
  due_date: string
  amount: number
  paid_at: string | null
  paid_amount: number | null
  paid_by_name: string | null
  penalty_days: number
  penalty_amount: number
  status: 'pending' | 'paid' | 'late'
}

function mapInstallment(r: InstallmentRow): Installment {
  return {
    id: r.id,
    installmentNo: r.installment_no,
    dueDate: r.due_date,
    amount: Number(r.amount),
    paidAt: r.paid_at,
    paidAmount: Number(r.paid_amount ?? 0),
    paidByName: r.paid_by_name ?? null,
    penaltyDays: r.penalty_days,
    penaltyAmount: Number(r.penalty_amount),
    status: r.status,
  }
}

export async function getInstallments(contractId: string): Promise<Installment[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('installments')
    .select('*')
    .eq('contract_id', contractId)
    .order('installment_no')
    .range(0, PAGE_CAP)
  if (error) throw error
  return ((data ?? []) as InstallmentRow[]).map(mapInstallment)
}

/** งวดผ่อนแบบย่อ (ใช้คิดค่าคอม + dashboard) ของทุกสัญญา — query เดียว ไม่ N+1 */
export interface InstallmentLite {
  contractId: string
  installmentNo: number
  dueDate: string
  paidAt: string | null
  amount: number
  paidAmount: number
}

/**
 * ดึงงวดทั้งหมด (ทุกสัญญา) — ใช้ตรวจประวัติล่าช้า (ค่าคอม) + มูลค่าชำระ/คงค้าง (dashboard)
 * @deprecated for bulk — ใช้ getContractAggregates() แทนเมื่อต้องการยอดรวมต่อสัญญา
 *             ฟังก์ชันนี้ปลอดภัยเฉพาะ single-contract context หรือกรณีต้องการ raw rows จริงๆ
 *             ที่ 2,400+ สัญญา × 12 งวด = 28,800+ แถว — เกิน PAGE_CAP 4,999 แล้ว
 */
export async function getAllInstallments(): Promise<InstallmentLite[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('installments')
    .select('contract_id, installment_no, due_date, paid_at, amount, paid_amount')
    .range(0, PAGE_CAP)
  if (error) throw error
  return (data ?? []).map((r) => ({
    contractId: r.contract_id as string,
    installmentNo: r.installment_no as number,
    dueDate: r.due_date as string,
    paidAt: (r.paid_at as string | null) ?? null,
    amount: Number(r.amount ?? 0),
    paidAmount: Number(r.paid_amount ?? 0),
  }))
}

/** งวดแรก (installment_no=1) ทุกสัญญา — ใช้คำนวณอัตราผิดนัดชำระงวดแรก (~2,281 แถว ปลอดภัยใต้ PAGE_CAP) */
export interface FirstInstallmentRow {
  contractId: string
  dueDate: string        // 'YYYY-MM-DD'
  paidAt: string | null  // 'YYYY-MM-DD' ถ้าจ่ายแล้ว, null ถ้ายังไม่จ่าย
}

export async function getFirstInstallments(): Promise<FirstInstallmentRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('installments')
    .select('contract_id, due_date, paid_at')
    .eq('installment_no', 1)
    .range(0, PAGE_CAP)
  if (error) throw error
  return (data ?? []).map((r) => ({
    contractId: r.contract_id as string,
    dueDate: (r.due_date as string).slice(0, 10),
    paidAt: r.paid_at ? (r.paid_at as string).slice(0, 10) : null,
  }))
}

/** งวดที่ค้างชำระ ณ วันใดวันหนึ่งในอดีต — ใช้สรุปหนี้เสีย ณ วันสิ้นช่วงของรายงานรายสัปดาห์ */
export interface OverdueAsOfRow {
  contractId: string
  dueDate: string        // 'YYYY-MM-DD'
  amount: number         // ยอดงวด
  paidAmount: number     // จ่ายมาแล้วบางส่วน (0 ถ้ายังไม่จ่าย)
  penaltyDue: number     // ค่าปรับค้างของงวด (คอลัมน์ penalty_amount ของ installments)
}

/**
 * ดึงงวดที่ยังค้างชำระ ณ วันที่กำหนด (asOfDate): due_date <= asOfDate
 * AND (paid_at is null OR paid_at > asOfDate) — กรองที่ฝั่ง SQL ทั้งหมด
 * ตาราง installments มี 28,000+ แถวรวม (เกิน PAGE_CAP 4,999 แน่นอน) จึงต้อง page วน
 * ทีละ PAGE_CAP+1 แถว จนกว่าจะได้แถวน้อยกว่าขนาดหน้า (แปลว่าหมดแล้ว)
 */
export async function getOverdueInstallmentsAsOf(asOfDate: string): Promise<OverdueAsOfRow[]> {
  if (!supabase) return []
  const pageSize = PAGE_CAP + 1 // 5000 แถวต่อหน้า
  const rows: OverdueAsOfRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('installments')
      .select('contract_id, due_date, amount, paid_amount, penalty_amount')
      .lte('due_date', asOfDate)
      .or(`paid_at.is.null,paid_at.gt.${asOfDate}`)
      .range(from, from + pageSize - 1)
    if (error) throw error
    const batch = data ?? []
    for (const r of batch) {
      rows.push({
        contractId: r.contract_id as string,
        dueDate: r.due_date as string,
        amount: Number(r.amount ?? 0),
        paidAmount: Number(r.paid_amount ?? 0),
        penaltyDue: Number(r.penalty_amount ?? 0),
      })
    }
    if (batch.length < pageSize) break
    from += pageSize
  }
  return rows
}

// ---------- aggregate views (Fix B — รองรับ 2,400+ สัญญา) ----------

/** ยอดรวมต่อสัญญา 1 แถว — คืนจาก view v_contract_aggregates */
export interface ContractAggregate {
  contractId: string
  totalInstallments: number
  paidCount: number
  overdueCount: number
  totalPaid: number
  totalOutstanding: number
  totalPenalty: number
  totalScheduled: number   // Σ amount ทุกงวด (เพิ่ม 0057) — ใช้คำนวณ portfolioPayable ใน ExecDashboard
  lastPaidAt: string | null
  nextDueDate: string | null
}

interface ContractAggregateRow {
  contract_id: string
  total_installments: number | null
  paid_count: number | null
  overdue_count: number | null
  total_paid: number | null
  total_outstanding: number | null
  total_penalty: number | null
  total_scheduled: number | null  // เพิ่ม 0057
  last_paid_at: string | null
  next_due_date: string | null
}

function mapContractAggregate(r: ContractAggregateRow): ContractAggregate {
  return {
    contractId: r.contract_id,
    totalInstallments: Number(r.total_installments ?? 0),
    paidCount: Number(r.paid_count ?? 0),
    overdueCount: Number(r.overdue_count ?? 0),
    totalPaid: Number(r.total_paid ?? 0),
    totalOutstanding: Number(r.total_outstanding ?? 0),
    totalPenalty: Number(r.total_penalty ?? 0),
    totalScheduled: Number(r.total_scheduled ?? 0),  // เพิ่ม 0057
    lastPaidAt: r.last_paid_at ?? null,
    nextDueDate: r.next_due_date ?? null,
  }
}

/**
 * ดึงยอดรวมต่อสัญญาจาก v_contract_aggregates (1 query แทนการ scan raw installments)
 * คืน Map<contractId, ContractAggregate> สำหรับ dashboard/ค่าคอม/outstanding
 * รองรับถึง 10,000 สัญญา — range(0, 9999) เพราะ view คืน 1 แถว/สัญญา
 */
export async function getContractAggregates(): Promise<Map<string, ContractAggregate>> {
  if (!supabase) return new Map()
  const { data, error } = await supabase
    .from('v_contract_aggregates')
    .select('*')
    .range(0, 9999)
  if (error) throw error
  const map = new Map<string, ContractAggregate>()
  for (const r of (data ?? []) as ContractAggregateRow[]) {
    map.set(r.contract_id, mapContractAggregate(r))
  }
  return map
}

/** ยอดรับชำระต่อสัญญา — คืนจาก view v_payment_summary */
export interface PaymentSummary {
  contractId: string
  payCount: number
  totalPay: number
  lastPayAt: string | null
}

interface PaymentSummaryRow {
  contract_id: string
  pay_count: number | null
  total_pay: number | null
  last_pay_at: string | null
}

function mapPaymentSummary(r: PaymentSummaryRow): PaymentSummary {
  return {
    contractId: r.contract_id,
    payCount: Number(r.pay_count ?? 0),
    totalPay: Number(r.total_pay ?? 0),
    lastPayAt: r.last_pay_at ?? null,
  }
}

/**
 * ดึงยอดรับชำระต่อสัญญาจาก v_payment_summary (1 query แทน scan payment_log ทั้งหมด)
 * คืน Map<contractId, PaymentSummary> สำหรับ cashflow forecast / กราฟเก็บเงิน
 * รองรับ payment_log หลายหมื่นแถวโดยไม่ติด PAGE_CAP
 */
export async function getPaymentSummaries(): Promise<Map<string, PaymentSummary>> {
  if (!supabase) return new Map()
  const { data, error } = await supabase
    .from('v_payment_summary')
    .select('*')
    .range(0, PAGE_CAP)
  if (error) throw error
  const map = new Map<string, PaymentSummary>()
  for (const r of (data ?? []) as PaymentSummaryRow[]) {
    map.set(r.contract_id, mapPaymentSummary(r))
  }
  return map
}

/** ที่อยู่ปัจจุบันต่อสัญญา — คืนจาก view v_contract_current_address */
export interface CurrentAddress {
  contractId: string
  houseNo: string | null
  moo: string | null
  soi: string | null
  road: string | null
  subdistrict: string | null
  district: string | null
  province: string | null
  postalCode: string | null
}

interface CurrentAddressRow {
  contract_id: string
  house_no: string | null
  moo: string | null
  soi: string | null
  road: string | null
  subdistrict: string | null
  district: string | null
  province: string | null
  postal_code: string | null
}

function mapCurrentAddress(r: CurrentAddressRow): CurrentAddress {
  return {
    contractId: r.contract_id,
    houseNo: r.house_no,
    moo: r.moo,
    soi: r.soi,
    road: r.road,
    subdistrict: r.subdistrict,
    district: r.district,
    province: r.province,
    postalCode: r.postal_code,
  }
}

/**
 * ดึงที่อยู่ปัจจุบันของทุกสัญญาจาก v_contract_current_address (1 query ไม่ซ้ำ)
 * คืน Map<contractId, CurrentAddress> สำหรับหน้าส่งจดหมาย
 * แทน getAllAddresses() ที่ดึง kind ทั้งหมดแล้ว filter ฝั่ง client
 */
export async function getCurrentAddresses(): Promise<Map<string, CurrentAddress>> {
  if (!supabase) return new Map()
  const { data, error } = await supabase
    .from('v_contract_current_address')
    .select('*')
    .range(0, PAGE_CAP)
  if (error) throw error
  const map = new Map<string, CurrentAddress>()
  for (const r of (data ?? []) as CurrentAddressRow[]) {
    map.set(r.contract_id, mapCurrentAddress(r))
  }
  return map
}

/** บันทึกชำระ (เพิ่มยอดสะสม — จ่ายบางส่วนได้ งวดจะปิดเมื่อยอดสะสม >= ค่างวด) */
export async function recordPayment(installmentId: string, amount: number, note?: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.rpc('record_payment', {
    p_installment_id: installmentId,
    p_amount: amount,
    p_note: note ?? null,
  })
  if (error) throw error
}

/** แก้ไขยอดสะสมใหม่ทั้งก้อน (กรณีพนักงานกรอกผิด) */
export async function adjustPayment(installmentId: string, newTotal: number, note?: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.rpc('adjust_payment', {
    p_installment_id: installmentId,
    p_new_total: newTotal,
    p_note: note ?? null,
  })
  if (error) throw error
}

/** ยกเลิกการชำระทั้งงวด (คืนเป็นค้างชำระ) */
export async function cancelPayment(installmentId: string, note?: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.rpc('cancel_payment', {
    p_installment_id: installmentId,
    p_note: note ?? null,
  })
  if (error) throw error
}

/** 1 แถวในประวัติการชำระ */
export interface PaymentLogEntry {
  id: string
  installmentId: string
  action: 'pay' | 'edit' | 'cancel'
  amount: number
  paidAmountAfter: number
  penaltyPaidAmount: number
  note: string | null
  byName: string | null
  createdAt: string
}

interface PaymentLogRow {
  id: string
  installment_id: string
  action: 'pay' | 'edit' | 'cancel'
  amount: number | null
  paid_amount_after: number | null
  penalty_paid_amount: number | null
  note: string | null
  by_name: string | null
  created_at: string
}

/** ประวัติการชำระทั้งหมดของสัญญา (ใหม่ → เก่า) */
export async function getPaymentLog(contractId: string): Promise<PaymentLogEntry[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('payment_log')
    .select('id, installment_id, action, amount, paid_amount_after, penalty_paid_amount, note, by_name, created_at')
    .eq('contract_id', contractId)
    .order('created_at', { ascending: false })
    .range(0, PAGE_CAP)
  if (error) throw error
  return ((data ?? []) as PaymentLogRow[]).map((r) => ({
    id: r.id,
    installmentId: r.installment_id,
    action: r.action,
    amount: Number(r.amount ?? 0),
    paidAmountAfter: Number(r.paid_amount_after ?? 0),
    penaltyPaidAmount: Number(r.penalty_paid_amount ?? 0),
    note: r.note ?? null,
    byName: r.by_name ?? null,
    createdAt: r.created_at,
  }))
}

/** การรับชำระแบบย่อ (ทุกสัญญา) สำหรับกระแสเงินสด/กราฟเก็บเงินใน dashboard */
export interface PaymentLite {
  action: 'pay' | 'edit' | 'cancel'
  amount: number
  createdAt: string
}

/**
 * ดึง payment_log ทั้งหมด (เฉพาะ field ที่ใช้รวมยอดรับชำระรายเดือน)
 * @deprecated for bulk — ใช้ getPaymentSummaries() แทนสำหรับ cashflow/กราฟ dashboard
 *             ที่ 2,400+ สัญญาสะสมหลายหมื่นแถว — เกิน PAGE_CAP 4,999 แล้ว
 */
export async function getAllPayments(): Promise<PaymentLite[]> {
  if (!supabase) return []
  const { data, error } = await supabase.from('payment_log').select('action, amount, created_at').range(0, PAGE_CAP)
  if (error) throw error
  return (data ?? []).map((r) => ({
    action: r.action as 'pay' | 'edit' | 'cancel',
    amount: Number(r.amount ?? 0),
    createdAt: r.created_at as string,
  }))
}

// ---------- รายได้รายวัน (aggregate view — migration 0056) ----------

/**
 * แถวข้อมูลรายได้รายวันจาก v_cashflow_daily
 * view aggregate ฝั่ง DB → ไม่ติด PAGE_CAP ไม่ว่า payment_log จะมีกี่หมื่นแถว
 */
export interface DailyCashflowRow {
  payDate: string         // วันที่ (YYYY-MM-DD, Asia/Bangkok)
  income: number          // ยอดรับรวม = principal + penalty_paid_amount
  penaltyIncome: number   // ยอดค่าปรับแยก (เผื่อ breakdown wave ถัดไป)
  payCount: number        // จำนวนรายการ action='pay'
}

interface DailyCashflowViewRow {
  pay_date: string
  income: string | number | null
  penalty_income: string | number | null
  pay_count: string | number | null
}

function mapDailyCashflow(r: DailyCashflowViewRow): DailyCashflowRow {
  return {
    payDate: r.pay_date,
    income: Number(r.income ?? 0),
    penaltyIncome: Number(r.penalty_income ?? 0),
    payCount: Number(r.pay_count ?? 0),
  }
}

/**
 * ดึงรายได้รายวันจาก v_cashflow_daily (migration 0056)
 * แก้บั๊ก: getAllPayments ติด PAGE_CAP 4,999 ทำให้ยอดรายได้ /exec ขาด ~65%
 * view aggregate ฝั่ง DB คืน 1 แถวต่อวัน — range(0, 9999) รองรับ ~27 ปี เกินอายุโปรเจกต์
 * เรียงจากเก่าสุด → ใหม่สุด (view ใช้ ORDER BY pay_date)
 */
export async function getCashflowDaily(): Promise<DailyCashflowRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('v_cashflow_daily')
    .select('pay_date, income, penalty_income, pay_count')
    .range(0, 9999)
  if (error) throw error
  return ((data ?? []) as DailyCashflowViewRow[]).map(mapDailyCashflow)
}

/**
 * เงินเก็บได้จริงวันนี้ — ทุกช่องทาง (ทีมโทรตามได้ + ลูกค้าจ่ายเอง + PJ auto-sync)
 * นับตาม record date (วันบันทึกเข้าระบบ, Asia/Bangkok) — reuse v_cashflow_daily (0056) แถวเดียวของวันนี้
 * ไม่ join contracts/other_income เพิ่ม (หนัก) — breakdown 5 หมวดใช้ getCashflowRows() ใน execDashboard.ts แทน
 * ยังไม่มีแถวของวันนี้ (ยังไม่มีเงินเข้าเลย) → คืน income=0 ไม่ throw
 */
export async function getCashCollectedToday(): Promise<CashCollectedToday> {
  const today = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)
  if (!supabase) return { payDate: today, income: 0, penaltyIncome: 0, payCount: 0 }
  const { data, error } = await supabase
    .from('v_cashflow_daily')
    .select('pay_date, income, penalty_income, pay_count')
    .eq('pay_date', today)
    .maybeSingle()
  if (error) throw error
  if (!data) return { payDate: today, income: 0, penaltyIncome: 0, payCount: 0 }
  const row = mapDailyCashflow(data as DailyCashflowViewRow)
  return { payDate: row.payDate, income: row.income, penaltyIncome: row.penaltyIncome, payCount: row.payCount }
}

// ---------- v_due_schedule_monthly — รวมยอดงวดต่อเดือน (migration 0058) ----------

/**
 * แถวยอดงวดรายเดือน (สัญญา active ทั้งหมด รวมในเดือนเดียวกัน)
 * คืนจาก v_due_schedule_monthly — ~24-36 แถว ไม่ติด PAGE_CAP
 */
export interface DueScheduleRow {
  dueMonth: string        // yyyy-mm-dd (date_trunc month → วันที่ 1 ของเดือน)
  scheduledAmount: number // Σ amount งวดทุกสัญญา active ในเดือนนี้
  collectedAmount: number // Σ paid_amount ที่ paid_at not null
  remainingAmount: number // Σ remain ที่ยังไม่จ่าย (greatest(amount−paid_amount,0) where paid_at null)
  totalCount: number      // จำนวนงวดทั้งหมด
  paidCount: number       // จำนวนงวดที่จ่ายแล้ว
}

interface DueScheduleViewRow {
  due_month: string
  scheduled_amount: string | number | null
  collected_amount: string | number | null
  remaining_amount: string | number | null
  total_count: string | number | null
  paid_count: string | number | null
}

function mapDueSchedule(r: DueScheduleViewRow): DueScheduleRow {
  return {
    dueMonth: r.due_month.slice(0, 10),
    scheduledAmount: Number(r.scheduled_amount ?? 0),
    collectedAmount: Number(r.collected_amount ?? 0),
    remainingAmount: Number(r.remaining_amount ?? 0),
    totalCount: Number(r.total_count ?? 0),
    paidCount: Number(r.paid_count ?? 0),
  }
}

/**
 * ดึงยอดงวดรายเดือน (active contracts) จาก v_due_schedule_monthly (migration 0058)
 * แก้บั๊ก: raw installments ติด PAGE_CAP ทำให้ expectedThisMonth/expectedNextMonth ใน /exec ขาด
 * view คืน 1 แถวต่อเดือน — range(0, 999) รองรับ >80 ปี เกินอายุโปรเจกต์แน่นอน
 */
export async function getDueScheduleMonthly(): Promise<DueScheduleRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('v_due_schedule_monthly')
    .select('due_month, scheduled_amount, collected_amount, remaining_amount, total_count, paid_count')
    .range(0, 999)
  if (error) throw error
  return ((data ?? []) as DueScheduleViewRow[]).map(mapDueSchedule)
}

// ---------- v_forecast_monthly_by_grade — ยอดคาดรับรายเดือนแยก grade (migration 0058) ----------

/**
 * แถวยอดคาดรับต่อ (เดือน, grade/bucket) สำหรับ forecast chart
 * คืนจาก v_forecast_monthly_by_grade — ~60 แถว (เดือน × grade) ไม่ติด PAGE_CAP
 */
export interface ForecastByGradeRow {
  dueMonth: string       // yyyy-mm-dd (date_trunc month)
  grade: string          // เกรดร้าน A-E จาก v_contract_status.grade: 'A'|'B'|'C'|'D'|'E'|'unknown'
  expectedAmount: number // Σ amount งวดที่ยังไม่จ่าย + due_date >= today
  installmentCount: number
}

interface ForecastByGradeViewRow {
  due_month: string
  grade: string
  expected_amount: string | number | null
  installment_count: string | number | null
}

function mapForecastByGrade(r: ForecastByGradeViewRow): ForecastByGradeRow {
  return {
    dueMonth: r.due_month.slice(0, 10),
    grade: r.grade,
    expectedAmount: Number(r.expected_amount ?? 0),
    installmentCount: Number(r.installment_count ?? 0),
  }
}

/**
 * ดึงยอดคาดรับแยก grade รายเดือนจาก v_forecast_monthly_by_grade (migration 0058)
 * ใช้วาด forecast chart ใน /exec โดยไม่ scan raw installments ทุกแถว
 * view คืน 1 แถวต่อ (เดือน × grade) — range(0, 999) รองรับได้มากกว่า 100 ปี × 8 grade
 */
export async function getForecastByGrade(): Promise<ForecastByGradeRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('v_forecast_monthly_by_grade')
    .select('due_month, grade, expected_amount, installment_count')
    .range(0, 999)
  if (error) throw error
  return ((data ?? []) as ForecastByGradeViewRow[]).map(mapForecastByGrade)
}

// ---------- v_overdue_month_snapshot — แนวโน้มหนี้ค้าง/หนี้เสียรายเดือน (migration 0060) ----------

/**
 * 1 แถวต่อเดือน (12 เดือนล่าสุด) จาก v_overdue_month_snapshot
 * overdue = สัญญา active ที่ค้างอยู่ ณ สิ้นเดือน (days_late≥1)
 * badDebt  = สัญญา active ที่ค้างนานเกิน 60 วัน ณ สิ้นเดือน (days_late≥60)
 */
export interface OverdueSnapshotRow {
  snapshotMonth: string  // yyyy-mm-dd (วันที่ 1 ของเดือน)
  overdueCount: number   // จำนวนสัญญาที่ค้าง (days_late≥1)
  overdueAmount: number  // ยอดค้างรวม (บาท) ของกลุ่ม overdue
  badCount: number       // จำนวนสัญญาหนี้เสีย (days_late≥60)
  badAmount: number      // ยอดค้างรวม (บาท) ของกลุ่ม bad_debt
}

interface OverdueSnapshotViewRow {
  snapshot_month: string
  overdue_count: number | string | null
  overdue_amount: number | string | null
  bad_count: number | string | null
  bad_amount: number | string | null
}

function mapOverdueSnapshot(r: OverdueSnapshotViewRow): OverdueSnapshotRow {
  return {
    snapshotMonth: r.snapshot_month.slice(0, 10),
    overdueCount: Number(r.overdue_count ?? 0),
    overdueAmount: Number(r.overdue_amount ?? 0),
    badCount: Number(r.bad_count ?? 0),
    badAmount: Number(r.bad_amount ?? 0),
  }
}

/**
 * ดึงแนวโน้มหนี้ค้าง/หนี้เสียรายเดือน จาก v_overdue_month_snapshot (migration 0061)
 * คืนทุกเดือนตั้งแต่เดือนแรกที่มี due_date จนถึงเดือนปัจจุบัน (~21+ แถว ข้ามหลายปี)
 * เรียงจากเก่า → ใหม่ — range(0,999) รองรับ row ทั้งหมดได้สบาย
 * ใช้ใน Exec Dashboard trend chart (buildOverdueTrend — Wave ถัดไป น้องวิว)
 */
export async function getOverdueMonthSnapshot(): Promise<OverdueSnapshotRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('v_overdue_month_snapshot')
    .select('snapshot_month, overdue_count, overdue_amount, bad_count, bad_amount')
    .order('snapshot_month', { ascending: true })
    .range(0, 999)
  if (error) throw error
  return ((data ?? []) as OverdueSnapshotViewRow[]).map(mapOverdueSnapshot)
}

// ---------- ขยายระยะเวลา (restructure) — Feature B ----------
export type ExtensionType = 'due_day' | 'months' | 'both'

export interface RestructureInput {
  extType: ExtensionType
  newDueDay: number
  newTerm: number // จำนวนงวดที่จะผ่อนใหม่
  newFinance: number
  note?: string
}

/** ขยายระยะเวลา (atomic RPC): ลบงวดที่ยังไม่จ่าย → สร้างงวดใหม่ + เก็บประวัติ */
export async function restructureContract(contractId: string, input: RestructureInput): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.rpc('restructure_contract', {
    p_contract_id: contractId,
    p_ext_type: input.extType,
    p_new_due_day: input.newDueDay,
    p_new_term: input.newTerm,
    p_new_finance: input.newFinance,
    p_note: input.note ?? null,
  })
  if (error) throw error
}

/** 1 แถวประวัติการขยายระยะเวลา */
export interface ExtensionRecord {
  id: string
  contractId: string
  contractNo: string
  customerName: string
  extType: ExtensionType
  oldDueDay: number | null
  newDueDay: number | null
  oldTerm: number | null
  newTerm: number | null
  oldFinance: number | null
  newFinance: number | null
  oldMonthly: number | null
  newMonthly: number | null
  newInstallments: number | null
  note: string | null
  recordedByName: string | null
  createdAt: string
}

interface ExtensionRow {
  id: string
  contract_id: string
  ext_type: ExtensionType
  old_due_day: number | null
  new_due_day: number | null
  old_term: number | null
  new_term: number | null
  old_finance: number | null
  new_finance: number | null
  old_monthly: number | null
  new_monthly: number | null
  new_installments: number | null
  note: string | null
  recorded_by_name: string | null
  created_at: string
  // Supabase embed อาจคืนเป็น object หรือ array แล้วแต่การ infer relation
  contracts?: { contract_no: string; customer_name: string } | { contract_no: string; customer_name: string }[] | null
}

function mapExtension(r: ExtensionRow): ExtensionRecord {
  const c = Array.isArray(r.contracts) ? r.contracts[0] : r.contracts
  return {
    id: r.id,
    contractId: r.contract_id,
    contractNo: c?.contract_no ?? '',
    customerName: c?.customer_name ?? '',
    extType: r.ext_type,
    oldDueDay: r.old_due_day,
    newDueDay: r.new_due_day,
    oldTerm: r.old_term,
    newTerm: r.new_term,
    oldFinance: r.old_finance != null ? Number(r.old_finance) : null,
    newFinance: r.new_finance != null ? Number(r.new_finance) : null,
    oldMonthly: r.old_monthly != null ? Number(r.old_monthly) : null,
    newMonthly: r.new_monthly != null ? Number(r.new_monthly) : null,
    newInstallments: r.new_installments,
    note: r.note ?? null,
    recordedByName: r.recorded_by_name ?? null,
    createdAt: r.created_at,
  }
}

const EXT_SELECT =
  'id, contract_id, ext_type, old_due_day, new_due_day, old_term, new_term, old_finance, new_finance, old_monthly, new_monthly, new_installments, note, recorded_by_name, created_at'

/** ประวัติการขยายของสัญญาเดียว (ใหม่ → เก่า) */
export async function getContractExtensions(contractId: string): Promise<ExtensionRecord[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('contract_extensions')
    .select(EXT_SELECT)
    .eq('contract_id', contractId)
    .order('created_at', { ascending: false })
    .range(0, PAGE_CAP)
  if (error) throw error
  return ((data ?? []) as ExtensionRow[]).map(mapExtension)
}

/** ประวัติการขยายทั้งหมด (สำหรับเมนู "ลูกค้าขยายระยะเวลา") พร้อมชื่อลูกค้า/เลขสัญญา */
export async function getAllExtensions(): Promise<ExtensionRecord[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('contract_extensions')
    .select(`${EXT_SELECT}, contracts ( contract_no, customer_name )`)
    .order('created_at', { ascending: false })
    .range(0, PAGE_CAP)
  if (error) throw error
  return ((data ?? []) as ExtensionRow[]).map(mapExtension)
}

interface StatusRow {
  contract_id: string
  contract_no: string
  customer_name: string
  shop_id: string
  shop_name: string | null
  status: Contract['status']
  next_due: string | null
  remaining_installments: number
  penalty_due: number
  days_late: number
  bucket: OverdueBucket
  grade: string | null
  overdue_amount: number // ยอดงวดที่เลยกำหนด (0055) — numeric จาก DB มาเป็น string ต้อง Number()
}

function mapStatus(r: StatusRow): ContractStatusRow {
  return {
    contractId: r.contract_id,
    contractNo: r.contract_no,
    customerName: r.customer_name,
    shopId: r.shop_id,
    shopName: r.shop_name ?? '-',
    status: r.status,
    nextDue: r.next_due,
    remainingInstallments: r.remaining_installments,
    penaltyDue: Number(r.penalty_due),
    daysLate: r.days_late,
    bucket: r.bucket,
    grade: r.grade ?? null,
    overdueAmount: Number(r.overdue_amount),
  }
}

/** ลูกค้าตามกลุ่มความล่าช้า (สำหรับเมนูลูกค้าล่าช้า-หนี้เสีย) */
export async function getOverdueByBucket(bucket: OverdueBucket): Promise<ContractStatusRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('v_contract_status')
    .select('*')
    .eq('bucket', bucket)
    .order('days_late', { ascending: false })
    .range(0, PAGE_CAP)
  if (error) throw error
  return ((data ?? []) as StatusRow[]).map(mapStatus)
}

/** สถานะของทุกสัญญา (สำหรับหน้าภาพรวม) */
export async function getAllStatuses(): Promise<ContractStatusRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase.from('v_contract_status').select('*').range(0, PAGE_CAP)
  if (error) throw error
  return ((data ?? []) as StatusRow[]).map(mapStatus)
}

// ---------- คืนเครื่อง (Phase 5) ----------
export interface ReturnInput {
  caseNo: 1 | 2 | 3
  lastInstallmentPaid: boolean
  penaltyPaid: boolean
  repairFee: number
  // --- Shipping method (0052) — optional ไม่กระทบ call-site เดิม ---
  returnMethod?: 'shipped' | 'walk_in'   // วิธีคืนเครื่อง
  trackingNumber?: string                // เลขพัสดุ (returnMethod='shipped' เท่านั้น)
  courier?: string                       // ชื่อขนส่ง (returnMethod='shipped' เท่านั้น)
  returnLocation?: string               // สถานที่คืน (returnMethod='walk_in' เท่านั้น)
  deviceStatus?: string                 // override device_status ตอน insert (ถ้าไม่ส่ง → derive จาก returnMethod)
}

export async function submitReturn(contractId: string, input: ReturnInput): Promise<void> {
  if (!supabase) return
  // กรณี 3 = ชำระครบ+ค่าซ่อมแล้ว -> ปิดสัญญาสมบูรณ์, อื่นๆ = คืนเครื่อง (รอ)
  const newStatus = input.caseNo === 3 ? 'returned_closed' : 'returned'

  // --- คำนวณ device_status ที่ตอน insert ---
  // ลำดับความสำคัญ: explicit deviceStatus > derive จาก returnMethod > ไม่ใส่ (DB default pending_check)
  let insertDeviceStatus: string | undefined
  if (input.deviceStatus !== undefined) {
    insertDeviceStatus = input.deviceStatus
  } else if (input.returnMethod === 'shipped') {
    insertDeviceStatus = 'in_transit' // อยู่ระหว่างจัดส่ง รอตรวจสอบที่ปลายทาง
  }
  // returnMethod='walk_in' หรือไม่ระบุ → ไม่ใส่ device_status (ใช้ default 'pending_check')

  const returnRow: Record<string, unknown> = {
    contract_id: contractId,
    case_no: input.caseNo,
    last_installment_paid: input.lastInstallmentPaid,
    penalty_paid: input.penaltyPaid,
    repair_fee: input.repairFee || 0,
    checked_at: input.caseNo === 3 ? new Date().toISOString() : null,
  }

  // ใส่ shipping fields เฉพาะเมื่อมีค่า
  if (insertDeviceStatus !== undefined) returnRow.device_status = insertDeviceStatus
  if (input.returnMethod !== undefined) returnRow.return_method = input.returnMethod
  if (input.returnMethod === 'shipped') {
    if (input.trackingNumber) returnRow.tracking_number = input.trackingNumber
    if (input.courier) returnRow.courier = input.courier
  }
  if (input.returnMethod === 'walk_in' && input.returnLocation) {
    returnRow.return_location = input.returnLocation
  }

  const { error: e1 } = await supabase.from('device_returns').insert(returnRow)
  if (e1) throw e1
  const { error: e2 } = await supabase.from('contracts').update({ status: newStatus }).eq('id', contractId)
  if (e2) throw e2
}

/**
 * ยกเลิกการบันทึกคืนเครื่อง (undo submitReturn)
 * ยกเลิกได้เฉพาะเมื่อยังไม่ดำเนินการลึก:
 *   - contract.status ต้องเป็น 'returned' เท่านั้น ('returned_closed' = ปิดแล้ว ยกเลิกไม่ได้)
 *   - device_returns ทุก row ต้อง: sale_price = null (ยังไม่ขาย)
 *     และ device_status อยู่ใน {null, 'pending_check', 'in_transit'} เท่านั้น
 *     ('checked' ขึ้นไปถือว่าดำเนินการลึกเกินแล้ว)
 * ถ้าผ่าน guard: ลบ device_returns ทั้งหมดของ contractId + revert contracts.status → 'active'
 */
export async function cancelReturn(contractId: string): Promise<void> {
  if (!supabase) return

  // ดึงสถานะสัญญา
  const { data: contractData, error: contractErr } = await supabase
    .from('contracts')
    .select('status')
    .eq('id', contractId)
    .maybeSingle()
  if (contractErr) throw contractErr

  if (!contractData) throw new Error('ไม่พบสัญญา')
  if (contractData.status !== 'returned') {
    throw new Error('ยกเลิกไม่ได้ — สัญญานี้ปิดจบแล้ว')
  }

  // ดึง device_returns ทั้งหมดของ contract นี้
  const { data: returns, error: returnsErr } = await supabase
    .from('device_returns')
    .select('id, device_status, sale_price')
    .eq('contract_id', contractId)
  if (returnsErr) throw returnsErr

  if (!returns || returns.length === 0) {
    throw new Error('ไม่พบรายการคืนเครื่อง')
  }

  // Guard: ตรวจสอบทุก row
  const CANCELLABLE_STATUSES: Array<DeviceStatus | null> = [null, 'pending_check', 'in_transit']
  for (const r of returns) {
    if (r.sale_price != null) {
      throw new Error('ยกเลิกไม่ได้ — เครื่องขายไปแล้ว')
    }
    const ds = r.device_status as DeviceStatus | null
    if (!CANCELLABLE_STATUSES.includes(ds)) {
      const label = ds ?? 'ไม่ระบุ'
      throw new Error(`ยกเลิกไม่ได้ — เครื่องดำเนินการจบแล้ว (สถานะ: ${label})`)
    }
  }

  // ลบ device_returns ทั้งหมดของ contract นี้
  const { error: deleteErr } = await supabase
    .from('device_returns')
    .delete()
    .eq('contract_id', contractId)
  if (deleteErr) throw deleteErr

  // Revert contract status กลับเป็น active
  const { error: updateErr } = await supabase
    .from('contracts')
    .update({ status: 'active' })
    .eq('id', contractId)
  if (updateErr) throw updateErr
}

/** ใส่/แก้ค่าซ่อมของรายการคืนเครื่องภายหลัง (หลังเช็คเครื่อง) */
export async function updateReturnRepairFee(returnId: string, repairFee: number): Promise<void> {
  if (!supabase) return
  const { error } = await supabase
    .from('device_returns')
    .update({ repair_fee: repairFee, checked_at: new Date().toISOString() })
    .eq('id', returnId)
  if (error) throw error
}

interface ReturnRow {
  id: string
  contract_id: string
  case_no: 1 | 2 | 3
  last_installment_paid: boolean
  penalty_paid: boolean
  repair_fee: number
  checked_at: string | null
  created_at: string
  contracts: { contract_no: string; customer_name: string; model: string | null; storage: string | null; imei: string | null; sn: string | null } | null
  // Device Pipeline columns (0027)
  tracking_number: string | null
  device_status: DeviceStatus | null
  sale_price: number | null
  priced_at: string | null
  transferred_at: string | null
  shipped_at: string | null
  device_status_updated_at: string | null
  device_status_by: string | null
  // Device defect notes (0033)
  device_defect_notes: string | null
  // Attribution + repair cost (0035)
  attributed_freelancer_id: string | null
  attributed_at: string | null
  repair_cost: number | null
  attributed_freelancer: { full_name: string } | null
  // Shipping method (0052)
  courier: string | null
  return_method: string | null
  return_location: string | null
}

export async function getReturns(filter?: { deviceStatus?: DeviceStatus | 'all' }): Promise<DeviceReturnRow[]> {
  if (!supabase) return []
  let query = supabase
    .from('device_returns')
    .select('*, contracts(contract_no, customer_name, model, storage, imei, sn), attributed_freelancer:profiles!attributed_freelancer_id(full_name)')
    .order('created_at', { ascending: false })
  if (filter?.deviceStatus && filter.deviceStatus !== 'all') {
    query = query.eq('device_status', filter.deviceStatus)
  }
  query = query.range(0, PAGE_CAP)
  const { data, error } = await query
  if (error) throw error
  return ((data ?? []) as ReturnRow[]).map((r) => ({
    id: r.id,
    contractId: r.contract_id,
    contractNo: r.contracts?.contract_no ?? '-',
    customerName: r.contracts?.customer_name ?? '-',
    caseNo: r.case_no,
    lastInstallmentPaid: r.last_installment_paid,
    penaltyPaid: r.penalty_paid,
    repairFee: Number(r.repair_fee),
    checkedAt: r.checked_at,
    createdAt: r.created_at,
    // Device Pipeline fields (0027)
    trackingNumber: r.tracking_number,
    deviceStatus: r.device_status,
    salePrice: r.sale_price == null ? null : Number(r.sale_price),
    pricedAt: r.priced_at,
    transferredAt: r.transferred_at,
    shippedAt: r.shipped_at,
    deviceStatusUpdatedAt: r.device_status_updated_at,
    deviceStatusBy: r.device_status_by,
    deviceModel: [r.contracts?.model, r.contracts?.storage].filter(Boolean).join(' ') || null,
    imei: r.contracts?.imei ?? null,
    sn: r.contracts?.sn ?? null,
    // Defect notes (0033)
    defectNotes: r.device_defect_notes,
    // Attribution + repair cost (0035)
    attributedFreelancerId: r.attributed_freelancer_id,
    attributedAt: r.attributed_at,
    repairCost: r.repair_cost == null ? 0 : Number(r.repair_cost),
    attributedFreelancerName: r.attributed_freelancer?.full_name ?? null,
    // Shipping method (0052)
    courier: r.courier ?? null,
    returnMethod: r.return_method ?? null,
    returnLocation: r.return_location ?? null,
  }))
}

/** อัปเดตสถานะ Device Pipeline (เปลี่ยนสถานะ + timestamp + tracking + ราคา)
 *  @param updatedBy ชื่อผู้ดำเนินการ (useAuth().name) — optional เพื่อ backward compat
 */
export async function updateReturnWorkflow(
  returnId: string,
  patch: {
    deviceStatus?: DeviceStatus
    trackingNumber?: string
    courier?: string          // 0052: ชื่อขนส่ง (patch ภายหลัง)
    salePrice?: number
    updatedBy?: string
  },
): Promise<void> {
  if (!supabase) return
  const now = new Date().toISOString()
  const update: Record<string, unknown> = {}

  if (patch.trackingNumber !== undefined) {
    update.tracking_number = patch.trackingNumber
  }
  if (patch.courier !== undefined) {
    update.courier = patch.courier
  }
  if (patch.salePrice !== undefined) {
    update.sale_price = patch.salePrice
  }
  if (patch.deviceStatus !== undefined) {
    update.device_status = patch.deviceStatus
    update.device_status_updated_at = now
    update.device_status_by = patch.updatedBy ?? null
    // ประทับเวลาตามสถานะที่เข้าถึงครั้งแรก
    if (patch.deviceStatus === 'priced') update.priced_at = now
    if (patch.deviceStatus === 'transferred') update.transferred_at = now
    if (patch.deviceStatus === 'shipped') update.shipped_at = now
  }

  const { error } = await supabase
    .from('device_returns')
    .update(update)
    .eq('id', returnId)
  if (error) throw error
}

// ---------- แจ้งเตือน ----------
interface NotifRow {
  id: string
  contract_id: string | null
  type: 'due_today' | 'newly_late'
  message: string | null
  created_at: string
  contracts: { contract_no: string; customer_name: string } | null
}

export async function getNotifications(): Promise<NotificationItem[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('notifications')
    .select('*, contracts(contract_no, customer_name)')
    .is('read_at', null)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) throw error
  return ((data ?? []) as NotifRow[]).map((n) => ({
    id: n.id,
    contractId: n.contract_id,
    contractNo: n.contracts?.contract_no ?? '-',
    customerName: n.contracts?.customer_name ?? '-',
    type: n.type,
    message: n.message ?? '',
    createdAt: n.created_at,
  }))
}

export async function markNotificationRead(id: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

// ---------- สิทธิ์ผู้ใช้ ----------
export type Role = 'admin' | 'staff' | 'freelancer' | 'executive' | 'accounting'

export async function getMyProfile(): Promise<{ role: Role; fullName: string } | null> {
  if (!supabase) return { role: 'admin', fullName: 'ผู้ดูแลระบบ (ทดลอง)' } // โหมด mock เปิดสิทธิ์เต็มเพื่อทดลอง UI
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null
  const { data } = await supabase
    .from('profiles')
    .select('role, full_name')
    .eq('id', user.id)
    .maybeSingle()
  return {
    role: (data?.role as Role) ?? 'staff',
    fullName: (data?.full_name as string) || user.email || '',
  }
}

export interface Employee {
  id: string
  fullName: string
}

/** รายชื่อพนักงานทั้งหมด (แอดมินอ่านได้ตาม RLS) — ใช้เมนูเลือกผู้หาร้าน + แสดงชื่อในรายงาน */
export async function getEmployees(): Promise<Employee[]> {
  if (!supabase) return [{ id: 'mock-admin', fullName: 'ผู้ดูแลระบบ (ทดลอง)' }]
  const { data, error } = await supabase.from('profiles').select('id, full_name').order('full_name').range(0, PAGE_CAP)
  if (error) throw error
  return (data ?? []).map((p) => ({
    id: p.id as string,
    fullName: (p.full_name as string) || '(ไม่มีชื่อ)',
  }))
}

// ---------- จัดการ user (เฉพาะแอดมิน) ผ่าน Edge Function 'admin-users' ----------
export interface AdminUserRow {
  id: string
  fullName: string
  role: Role
  active: boolean
  email: string | null
  createdAt: string
}

/** เรียก Edge Function (กลางทาง — จัดการ auth + service_role + RLS รวมในตัว) */
async function callAdminUsers(body: Record<string, unknown>): Promise<any> {
  if (!supabase) throw new Error('โหมดตัวอย่าง: ยังไม่เชื่อม Supabase')
  const { data, error } = await supabase.functions.invoke('admin-users', { body })
  if (error) {
    // FunctionsHttpError: error.message อาจไม่บอกตัวจริงที่ Edge Function ส่งกลับ — ลองอ่าน context
    const ctx = (error as any).context
    let detail: string | null = null
    try {
      if (ctx?.body) {
        const text = typeof ctx.body === 'string' ? ctx.body : await new Response(ctx.body).text()
        try { detail = JSON.parse(text).error ?? text } catch { detail = text }
      }
    } catch { /* ignore */ }
    throw new Error(detail || error.message)
  }
  if (data?.error) throw new Error(data.error)
  return data
}

export async function listAdminUsers(): Promise<AdminUserRow[]> {
  const data = await callAdminUsers({ action: 'list' })
  return (data?.users ?? []).map((u: any): AdminUserRow => ({
    id: u.id,
    fullName: u.full_name || '(ไม่มีชื่อ)',
    role: u.role as Role,
    active: u.active !== false,
    email: u.email ?? null,
    createdAt: u.created_at,
  }))
}

export async function createAdminUser(input: { email: string; password: string; fullName: string; role: Role }): Promise<string> {
  const data = await callAdminUsers({ action: 'create', ...input })
  const id = data?.id
  if (!id) throw new Error('createAdminUser: Edge Function did not return id')
  return id as string
}

export async function updateAdminUser(input: { id: string; fullName?: string; role?: Role; password?: string }): Promise<void> {
  await callAdminUsers({ action: 'update', ...input })
}

export async function setAdminUserActive(id: string, active: boolean): Promise<void> {
  await callAdminUsers({ action: 'setActive', id, active })
}

// ---------- โอนรายวันให้ร้าน (บัญชี) — mig 0083 shop_transfer + bucket transfer-slips ----------
// role 'accounting' เห็นเฉพาะหน้านี้ + จัดการโอน ไม่ยุ่งสัญญา (RLS คุมที่ mig 0083)
// ยอดโอน "ไม่คีย์ซ้ำ" — reuse calcSummary (calc.ts) ต่อสัญญาแบบเดียวกับ weeklySummary.ts buildTransferSummary
// เพื่อให้ยอดตรงกันทุกหน้า (ไม่มีสูตรคำนวณยอดโอนสองที่ในระบบ)

interface ShopTransferRow {
  id: string
  shop_id: string
  transfer_date: string
  amount: number
  transferred: boolean
  slip_path: string | null
  transferred_by: string | null
  transferred_at: string | null
  note: string | null
  slip_waived: boolean // 0085
  voided: boolean // 0104: soft-delete สลิป
  created_at: string
}

/** 1 บรรทัด/ร้าน สำหรับหน้าโอนรายวัน — ยอด = Σ netTransfer (calcSummary) ของสัญญาร้านนั้นที่ transaction_date = dateISO */
export interface DailyTransferShopRow {
  shopId: string
  shopName: string
  shopCode: string
  amount: number // Σ netTransfer ของสัญญาวันนี้ (คำนวณสด ไม่ได้อ่านจาก shop_transfer.amount)
  contractCount: number
  transferred: boolean // จาก shop_transfer.transferred (false ถ้ายังไม่มีแถว)
  slipPath: string | null
  transferredBy: string | null
  transferredAt: string | null
  note: string | null
  slipWaived: boolean // 0085: true = ยืนยันย้อนหลังไม่มีสลิป (แยกจาก "รอแนบสลิป")
  bank: string // join จาก shops — ไว้โชว์บัญชีปลายทางตอนโอน
  accountNo: string
  accountName: string
  // 0104: หลายสลิปต่อร้าน-วัน. legacy scalar ด้านบน (transferred/slipPath/...) = derived จากสลิปใบแรก เพื่อความเข้ากันได้กับ UI เดิม
  slips: TransferSlip[] // สลิปทั้งหมดของร้าน-วันนี้ (voided=false) พร้อมสัญญาที่ผูก — UI ใหม่ (Wave 2) ใช้ตัวนี้
}

/** รายสัญญาต่อร้าน (drill-down) — ใช้เมื่อ accounting กดดูรายละเอียดยอดของร้านวันนั้น
 *  frozen contract — น้องวิว render ตามนี้เป๊ะ ห้ามเปลี่ยนชื่อ/ชนิดฟิลด์โดยไม่แจ้ง */
export interface DailyTransferContractRow {
  contractId: string
  contractNo: string
  customerName: string
  devicePrice: number
  netTransfer: number
  invNo: string | null
  model: string | null
  storage: string | null
  sn: string | null
  afterDown: number // ยอดตัวเครื่องหลังหักดาวน์ = calcSummary().afterDown
  commission: number // ค่าคอมมิชชั่น = calcSummary().commission
  docFee: number // ค่าเอกสาร
  linkedSlipId: string | null // 0104: id สลิปที่เคสนี้ถูกผูก (voided=false) — null = ยังไม่ผูกสลิป
}

interface DailyTransferContractQueryRow {
  id: string
  contract_no: string
  customer_name: string
  shop_id: string
  device_price: number
  down_percent: number
  commission_percent: number
  doc_fee: number
  inv_no: string | null
  model: string | null
  storage: string | null
  sn: string | null
}

/** สรุปยอดโอนรายวัน ต่อร้าน (สำหรับหน้าบัญชี) — LEFT JOIN สถานะโอนจาก shop_transfer
 *  รวมทุกร้านที่มีสัญญาเข้าวันนั้น (ไม่กรอง active — ร้านปิดไปแล้วแต่มีสัญญาเก่าวันนั้นยังต้องเห็น)
 *  หน้า /transfers เกาะ summary_accounting_sent_at (วันส่งบัญชี) ไม่ใช่ transaction_date (วันขาย)
 *  → เคสที่ยังไม่กดส่งบัญชี (summary_accounting_sent_at IS NULL) จะไม่ถูกนับ ตามต้องการ
 *  shop_transfer.transfer_date ยัง key ด้วย dateISO เดิม เพราะฝั่งเรียกใช้ส่ง "วันส่งบัญชีที่กำลังดู" เข้ามาอยู่แล้ว */
export async function getDailyTransferByShop(dateISO: string): Promise<DailyTransferShopRow[]> {
  if (!supabase) return []

  // แปลงวัน Bangkok (UTC+7 คงที่ ไม่มี DST) → ช่วง UTC สำหรับ query summary_accounting_sent_at
  // pattern เดียวกับ getDailyAudit — ใช้ Date.UTC ตรงๆ แล้วลบ 7 ชม. เลี่ยงกับดัก '+07:00' suffix parsing
  const [y, m, d] = dateISO.split('-').map(Number)
  const since = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - 7 * 3600 * 1000).toISOString()
  const until = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0) - 7 * 3600 * 1000).toISOString()

  const { data: contractRows, error: cErr } = await supabase
    .from('contracts')
    .select(
      'id, contract_no, customer_name, shop_id, device_price, down_percent, commission_percent, doc_fee, inv_no, model, storage, sn',
    )
    .gte('summary_accounting_sent_at', since)
    .lt('summary_accounting_sent_at', until)
    .range(0, PAGE_CAP)
  if (cErr) throw cErr

  const rows = (contractRows ?? []) as DailyTransferContractQueryRow[]
  const shopIds = [...new Set(rows.map((r) => r.shop_id))]

  // ยอดรวม + จำนวนสัญญา ต่อร้าน — reuse calcSummary ต่อเคส (ตรงสูตรเดียวกับ weeklySummary.ts)
  const totalByShop = new Map<string, { amount: number; count: number }>()
  for (const r of rows) {
    const s = calcSummary(Number(r.device_price), Number(r.down_percent), Number(r.commission_percent), Number(r.doc_fee))
    const cur = totalByShop.get(r.shop_id) ?? { amount: 0, count: 0 }
    cur.amount += s.net
    cur.count += 1
    totalByShop.set(r.shop_id, cur)
  }

  if (shopIds.length === 0) return []

  const [{ data: shopData, error: sErr }, { data: transferData, error: tErr }] = await Promise.all([
    supabase.from('shops').select('id, code, name, bank, account_no, account_name').in('id', shopIds).range(0, PAGE_CAP),
    // 0104: เอาเฉพาะสลิปที่ยังไม่ถูกยกเลิก (voided=false) — 1 แถว = 1 สลิป (หลายสลิป/ร้าน/วันได้)
    supabase.from('shop_transfer').select('*').eq('transfer_date', dateISO).eq('voided', false).in('shop_id', shopIds).range(0, PAGE_CAP),
  ])
  if (sErr) throw sErr
  if (tErr) throw tErr

  const shopNameById = new Map(
    (shopData ?? []).map((s) => [
      s.id as string,
      {
        name: s.name as string,
        code: s.code as string,
        bank: (s.bank as string | null) ?? '',
        accountNo: (s.account_no as string | null) ?? '',
        accountName: (s.account_name as string | null) ?? '',
      },
    ]),
  )

  const transferRows = (transferData ?? []) as ShopTransferRow[]
  // items ของทุกสลิป + ชื่อลูกค้า/เลขสัญญา (join contracts)
  const itemsBySlip = await getSlipItemsMap(transferRows.map((t) => t.id))

  // จัดสลิปเข้าแต่ละร้าน
  const slipsByShop = new Map<string, TransferSlip[]>()
  for (const t of transferRows) {
    const list = slipsByShop.get(t.shop_id) ?? []
    list.push(transferRowToSlip(t, itemsBySlip.get(t.id) ?? []))
    slipsByShop.set(t.shop_id, list)
  }

  const out: DailyTransferShopRow[] = shopIds.map((shopId) => {
    const totals = totalByShop.get(shopId)!
    const shopInfo = shopNameById.get(shopId)
    const slips = slipsByShop.get(shopId) ?? []
    // legacy scalar = derived จากสลิปใบแรก (คงไว้เพื่อ UI เดิม; UI ใหม่ Wave 2 ใช้ slips[])
    const first = slips[0]
    return {
      shopId,
      shopName: shopInfo?.name ?? '(ไม่พบชื่อร้าน)',
      shopCode: shopInfo?.code ?? '',
      amount: totals.amount,
      contractCount: totals.count,
      transferred: slips.length > 0,
      slipPath: slips.find((s) => s.slipPath)?.slipPath ?? null,
      transferredBy: first?.transferredBy ?? null,
      transferredAt: first?.transferredAt ?? null,
      note: first?.note ?? null,
      slipWaived: first?.slipWaived ?? false,
      bank: shopInfo?.bank ?? '',
      accountNo: shopInfo?.accountNo ?? '',
      accountName: shopInfo?.accountName ?? '',
      slips,
    }
  })
  out.sort((a, b) => a.shopCode.localeCompare(b.shopCode))
  return out
}

/** map slipId → TransferSlipItem[] (join contracts เอา contract_no/customer_name) — internal helper 0104 */
async function getSlipItemsMap(transferIds: string[]): Promise<Map<string, TransferSlipItem[]>> {
  const result = new Map<string, TransferSlipItem[]>()
  if (!supabase || transferIds.length === 0) return result

  const { data: itemData, error: iErr } = await supabase
    .from('shop_transfer_item')
    .select('id, transfer_id, contract_id, amount')
    .in('transfer_id', transferIds)
    .range(0, PAGE_CAP)
  if (iErr) throw iErr

  const items = (itemData ?? []) as { id: string; transfer_id: string; contract_id: string; amount: number }[]
  const contractIds = [...new Set(items.map((i) => i.contract_id))]

  const contractInfo = new Map<string, { contractNo: string; customerName: string }>()
  if (contractIds.length > 0) {
    const { data: cData, error: cErr } = await supabase
      .from('contracts')
      .select('id, contract_no, customer_name')
      .in('id', contractIds)
      .range(0, PAGE_CAP)
    if (cErr) throw cErr
    for (const c of cData ?? []) {
      contractInfo.set(c.id as string, { contractNo: c.contract_no as string, customerName: c.customer_name as string })
    }
  }

  for (const i of items) {
    const info = contractInfo.get(i.contract_id)
    const list = result.get(i.transfer_id) ?? []
    list.push({
      id: i.id,
      contractId: i.contract_id,
      contractNo: info?.contractNo,
      customerName: info?.customerName,
      amount: Number(i.amount),
    })
    result.set(i.transfer_id, list)
  }
  return result
}

/** map ShopTransferRow (1 แถว) → TransferSlip domain — internal helper 0104 */
function transferRowToSlip(t: ShopTransferRow, items: TransferSlipItem[]): TransferSlip {
  return {
    id: t.id,
    shopId: t.shop_id,
    transferDate: t.transfer_date,
    amount: Number(t.amount),
    slipPath: t.slip_path,
    transferredBy: t.transferred_by,
    transferredAt: t.transferred_at,
    note: t.note,
    slipWaived: t.slip_waived,
    voided: t.voided,
    items,
  }
}

/** รายสัญญาของร้านหนึ่ง ในวันหนึ่ง — สำหรับ drill-down ใต้แถวสรุป
 *  หน้า /transfers เกาะ summary_accounting_sent_at (วันส่งบัญชี) ไม่ใช่ transaction_date (วันขาย)
 *  → ต้องกรองด้วยช่วงวันเดียวกับ getDailyTransferByShop เป๊ะ ไม่งั้นยอดรวม vs drill-down ไม่ตรงกัน */
export async function getDailyTransferContracts(shopId: string, dateISO: string): Promise<DailyTransferContractRow[]> {
  if (!supabase) return []

  // แปลงวัน Bangkok → ช่วง UTC — pattern เดียวกับ getDailyTransferByShop/getDailyAudit
  const [y, m, d] = dateISO.split('-').map(Number)
  const since = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - 7 * 3600 * 1000).toISOString()
  const until = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0) - 7 * 3600 * 1000).toISOString()

  const { data, error } = await supabase
    .from('contracts')
    .select(
      'id, contract_no, customer_name, shop_id, device_price, down_percent, commission_percent, doc_fee, inv_no, model, storage, sn',
    )
    .gte('summary_accounting_sent_at', since)
    .lt('summary_accounting_sent_at', until)
    .eq('shop_id', shopId)
    .range(0, PAGE_CAP)
  if (error) throw error

  // 0104: หาว่าเคสไหนถูกผูกกับสลิป (voided=false) ของร้าน-วันนี้แล้ว → linkedSlipId
  const linkedByContract = await getContractSlipLinkMap(shopId, dateISO)

  // reuse calcSummary (calc.ts) ตัวเดียวกับที่ itemBlock/buildBulkSummary (messages.ts) ใช้สร้างข้อความส่งร้าน
  // ให้ afterDown/commission ตรงกับข้อความจริง 100% — ห้ามคำนวณแยกสูตร
  return ((data ?? []) as DailyTransferContractQueryRow[]).map((r) => {
    const s = calcSummary(Number(r.device_price), Number(r.down_percent), Number(r.commission_percent), Number(r.doc_fee))
    return {
      contractId: r.id,
      contractNo: r.contract_no,
      customerName: r.customer_name,
      devicePrice: Number(r.device_price),
      netTransfer: s.net,
      invNo: r.inv_no ?? null,
      model: r.model ?? null,
      storage: r.storage ?? null,
      sn: r.sn ?? null,
      afterDown: s.afterDown,
      commission: s.commission,
      docFee: s.docFee,
      linkedSlipId: linkedByContract.get(r.id) ?? null,
    }
  })
}

/** map contractId → transfer_id (สลิป voided=false) ของร้าน-วันหนึ่ง — internal helper 0104 */
async function getContractSlipLinkMap(shopId: string, dateISO: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (!supabase) return map

  // สลิป voided=false ของร้าน-วันนี้
  const { data: slipRows, error: sErr } = await supabase
    .from('shop_transfer')
    .select('id')
    .eq('shop_id', shopId)
    .eq('transfer_date', dateISO)
    .eq('voided', false)
    .range(0, PAGE_CAP)
  if (sErr) throw sErr

  const slipIds = (slipRows ?? []).map((r) => r.id as string)
  if (slipIds.length === 0) return map

  const { data: itemRows, error: iErr } = await supabase
    .from('shop_transfer_item')
    .select('transfer_id, contract_id')
    .in('transfer_id', slipIds)
    .range(0, PAGE_CAP)
  if (iErr) throw iErr

  for (const it of itemRows ?? []) {
    map.set(it.contract_id as string, it.transfer_id as string)
  }
  return map
}

/** อาร์กิวเมนต์สร้างสลิปโอน 1 ใบ (mig 0104) */
export interface CreateTransferSlipArgs {
  shopId: string
  dateISO: string
  amount: number // ยอดสลิป (บัญชีแก้เองได้ — default = Σ item ฝั่งเรียกใช้)
  slipPath: string | null
  note?: string
  slipWaived?: boolean
  items: { contractId: string; amount: number }[] // สัญญาที่สลิปนี้จ่ายให้ (ว่างได้ = สลิปยังไม่ผูกเคส)
}

/** สร้างสลิปโอน 1 ใบ + ผูกสัญญา (atomic ผ่าน RPC create_transfer_slip)
 *  RPC ตรวจสิทธิ์ (admin/accounting) + กันผูกสัญญาซ้ำ 2 สลิปในร้าน-วันเดียว (raise ถ้าซ้ำ)
 *  คืน transfer_id ของสลิปที่สร้าง */
export async function createTransferSlip(args: CreateTransferSlipArgs): Promise<string> {
  if (!supabase) return ''
  const { data, error } = await supabase.rpc('create_transfer_slip', {
    p_shop_id: args.shopId,
    p_transfer_date: args.dateISO,
    p_amount: args.amount,
    p_slip_path: args.slipPath,
    p_note: args.note ?? null,
    p_slip_waived: args.slipWaived ?? false,
    p_items: args.items.map((i) => ({ contract_id: i.contractId, amount: i.amount })),
  })
  if (error) throw error
  return (data as string) ?? ''
}

/** ยกเลิกสลิป (soft delete) — admin เท่านั้น (RPC void_transfer_slip guard is_admin()) */
export async function voidTransferSlip(transferId: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.rpc('void_transfer_slip', { p_transfer_id: transferId })
  if (error) throw error
}

/** [DEPRECATED — mig 0104] เดิม upsert 1 แถว/ร้าน/วัน. ตอนนี้ delegate ไป createTransferSlip (สลิปเดียว ไม่ผูกเคส)
 *  คงไว้เพื่อความเข้ากันได้กับ UI เดิมชั่วคราว — UI ใหม่ (Wave 2) ให้เรียก createTransferSlip พร้อม items */
export async function markShopTransferred(
  shopId: string,
  dateISO: string,
  amount: number,
  slipPath: string | null,
  _byName: string,
  note?: string,
): Promise<void> {
  await createTransferSlip({ shopId, dateISO, amount, slipPath, note, items: [] })
}

/** สรุปจำนวนสลิป + ยอดรวม ต่อ (ร้าน,วัน) ในช่วงวันที่ — จาก v_transfer_slip_summary + ชื่อร้าน (mig 0104) */
export async function getTransferSlipSummary(startISO: string, endISO: string): Promise<TransferSlipSummaryRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('v_transfer_slip_summary')
    .select('transfer_date, shop_id, slip_count, total_amount')
    .gte('transfer_date', startISO)
    .lte('transfer_date', endISO)
    .range(0, PAGE_CAP)
  if (error) throw error

  const rows = (data ?? []) as { transfer_date: string; shop_id: string; slip_count: number; total_amount: number }[]
  const shopIds = [...new Set(rows.map((r) => r.shop_id))]
  const shopNameById = new Map<string, string>()
  if (shopIds.length > 0) {
    const { data: shopData, error: sErr } = await supabase.from('shops').select('id, name').in('id', shopIds).range(0, PAGE_CAP)
    if (sErr) throw sErr
    for (const s of shopData ?? []) shopNameById.set(s.id as string, s.name as string)
  }

  return rows.map((r) => ({
    date: r.transfer_date,
    shopId: r.shop_id,
    shopName: shopNameById.get(r.shop_id) ?? '(ไม่พบชื่อร้าน)',
    slipCount: Number(r.slip_count),
    totalAmount: Number(r.total_amount),
  }))
}

/** รายสลิป (voided=false) ของวันหนึ่ง (กรองร้านได้) พร้อมสัญญาที่ผูก — drill-down (mig 0104) */
export async function getTransferSlipsForDay(dateISO: string, shopId?: string): Promise<TransferSlip[]> {
  if (!supabase) return []
  let q = supabase.from('shop_transfer').select('*').eq('transfer_date', dateISO).eq('voided', false)
  if (shopId) q = q.eq('shop_id', shopId)
  const { data, error } = await q.range(0, PAGE_CAP)
  if (error) throw error

  const rows = (data ?? []) as ShopTransferRow[]
  const itemsBySlip = await getSlipItemsMap(rows.map((t) => t.id))
  return rows.map((t) => transferRowToSlip(t, itemsBySlip.get(t.id) ?? []))
}

/** signed URL ชั่วคราว (60 วิ) สำหรับเปิดดูสลิปที่เก็บแบบ private ใน bucket transfer-slips
 *  path มาจาก DailyTransferShopRow.slipPath — คืน null ถ้ายังไม่มีสลิป/ไม่ได้เชื่อม Supabase */
export async function getSlipSignedUrl(slipPath: string): Promise<string | null> {
  if (!supabase) return null
  const { data, error } = await supabase.storage.from('transfer-slips').createSignedUrl(slipPath, 60)
  if (error) throw error
  return data?.signedUrl ?? null
}

// ---------- จัดการร้านค้า (เฉพาะแอดมิน ตาม RLS) ----------
export interface ShopInput {
  id?: string
  code: string
  name: string
  bank: string
  accountNo: string
  accountName: string
  active: boolean
  ownerName?: string
  phone?: string
  facebookLink?: string
  contactChannel?: string
  address?: string
  province?: string
  recruitedBy?: string | null
  recruitedAt?: string | null
}

export async function saveShop(s: ShopInput): Promise<void> {
  if (!supabase) return
  const row = {
    code: s.code,
    name: s.name,
    bank: s.bank || null,
    account_no: s.accountNo || null,
    account_name: s.accountName || null,
    active: s.active,
    owner_name: s.ownerName || null,
    phone: s.phone || null,
    facebook_link: s.facebookLink || null,
    contact_channel: s.contactChannel || null,
    address: s.address || null,
    province: s.province || null,
    recruited_by: s.recruitedBy || null,
    recruited_at: s.recruitedAt || null,
  }
  const { error } = s.id
    ? await supabase.from('shops').update(row).eq('id', s.id)
    : await supabase.from('shops').insert(row)
  if (error) throw error
}

export async function setShopActive(id: string, active: boolean): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from('shops').update({ active }).eq('id', id)
  if (error) throw error
}

// ---------- จัดการตัวเลือก (รุ่น/อาชีพ/โปร ฯลฯ) ----------
export interface OptionInput {
  id?: string
  kind: OptionKind
  label: string
  detail?: string
  active: boolean
}

export async function saveOption(o: OptionInput): Promise<void> {
  if (!supabase) return
  const row = { kind: o.kind, label: o.label, detail: o.detail || null, active: o.active }
  const { error } = o.id
    ? await supabase.from('options').update(row).eq('id', o.id)
    : await supabase.from('options').insert(row)
  if (error) throw error
}

export async function setOptionActive(id: string, active: boolean): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from('options').update({ active }).eq('id', id)
  if (error) throw error
}

/** ดึงตัวเลือกทุกสถานะ (รวมที่ปิดแล้ว) สำหรับหน้าตั้งค่า */
export async function getAllOptions(kind: OptionKind): Promise<Option[]> {
  if (!supabase) return MOCK_OPTIONS[kind]
  const { data, error } = await supabase
    .from('options')
    .select('*')
    .eq('kind', kind)
    .order('sort_order')
    .range(0, PAGE_CAP)
  if (error) throw error
  return (data ?? []).map((o) => ({
    id: o.id,
    label: o.label,
    detail: o.detail ?? undefined,
    active: o.active,
  }))
}

// ============================================================================
// ที่อยู่ลูกค้า + จดหมายติดตามหนี้ (Phase: ส่งจดหมาย)
// ============================================================================

/** ที่อยู่ของสัญญาหนึ่ง แยกตามชนิด */
export type ContractAddresses = Partial<Record<AddressKind, CustomerAddress>>

interface AddressRow {
  contract_id: string
  kind: AddressKind
  house_no: string | null
  moo: string | null
  soi: string | null
  road: string | null
  subdistrict: string | null
  district: string | null
  province: string | null
  postal_code: string | null
}

function mapAddress(r: AddressRow): CustomerAddress {
  return {
    houseNo: r.house_no ?? undefined,
    moo: r.moo ?? undefined,
    soi: r.soi ?? undefined,
    road: r.road ?? undefined,
    subdistrict: r.subdistrict ?? undefined,
    district: r.district ?? undefined,
    province: r.province ?? undefined,
    postalCode: r.postal_code ?? undefined,
  }
}

function addressToRow(contractId: string, kind: AddressKind, a: CustomerAddress) {
  return {
    contract_id: contractId,
    kind,
    house_no: a.houseNo || null,
    moo: a.moo || null,
    soi: a.soi || null,
    road: a.road || null,
    subdistrict: a.subdistrict || null,
    district: a.district || null,
    province: a.province || null,
    postal_code: a.postalCode || null,
    updated_at: new Date().toISOString(),
  }
}

/** ที่อยู่ทุกชนิดของสัญญาหนึ่ง */
export async function getContractAddresses(contractId: string): Promise<ContractAddresses> {
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('customer_addresses')
    .select('*')
    .eq('contract_id', contractId)
  if (error) throw error
  const out: ContractAddresses = {}
  for (const r of (data ?? []) as AddressRow[]) out[r.kind] = mapAddress(r)
  return out
}

/**
 * ที่อยู่ทุกสัญญา (สำหรับหน้าส่งจดหมาย) → { contractId: { current, id_card, ... } }
 * @deprecated for bulk — ใช้ getCurrentAddresses() แทนสำหรับที่อยู่ปัจจุบันในหน้า bulk
 *             ที่ 2,400+ สัญญา × 3 ที่อยู่ = 7,200+ แถว — เกิน PAGE_CAP 4,999 แล้ว
 *             ยังใช้ได้สำหรับ single-contract context (ดูที่อยู่ครบทุก kind)
 */
export async function getAllAddresses(): Promise<Record<string, ContractAddresses>> {
  if (!supabase) return {}
  const { data, error } = await supabase.from('customer_addresses').select('*').range(0, PAGE_CAP)
  if (error) throw error
  const out: Record<string, ContractAddresses> = {}
  for (const r of (data ?? []) as AddressRow[]) {
    ;(out[r.contract_id] ??= {})[r.kind] = mapAddress(r)
  }
  return out
}

/** บันทึก/อัปเดตที่อยู่ชนิดหนึ่ง (upsert ตาม contract_id+kind) */
export async function saveAddress(
  contractId: string,
  kind: AddressKind,
  a: CustomerAddress,
): Promise<void> {
  if (!supabase) return
  const { error } = await supabase
    .from('customer_addresses')
    .upsert(addressToRow(contractId, kind, a), { onConflict: 'contract_id,kind' })
  if (error) throw error
}

// ---------- จดหมาย ----------
interface LetterRow {
  id: string
  contract_id: string
  episode_key: string
  round: 1 | 2 | 3
  address_kind: 'current' | 'id_card' | 'registry'
  recipient_snapshot: string | null
  printed_at: string
  tracking_no: string | null
  reply: LetterReply
}

function mapLetter(r: LetterRow): LetterRecord {
  return {
    id: r.id,
    contractId: r.contract_id,
    episodeKey: r.episode_key,
    round: r.round,
    addressKind: r.address_kind,
    recipientSnapshot: r.recipient_snapshot,
    printedAt: r.printed_at,
    trackingNo: r.tracking_no,
    reply: r.reply,
  }
}

/** จดหมายทั้งหมด (ทุกสัญญา) — สำหรับหน้าส่งจดหมาย */
export async function getAllLetters(): Promise<LetterRecord[]> {
  if (!supabase) return []
  const { data, error } = await supabase.from('collection_letters').select('*').order('printed_at').range(0, PAGE_CAP)
  if (error) throw error
  return ((data ?? []) as LetterRow[]).map(mapLetter)
}

export async function getContractLetters(contractId: string): Promise<LetterRecord[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('collection_letters')
    .select('*')
    .eq('contract_id', contractId)
    .order('printed_at')
    .range(0, PAGE_CAP)
  if (error) throw error
  return ((data ?? []) as LetterRow[]).map(mapLetter)
}

export interface LetterInput {
  contractId: string
  episodeKey: string
  round: 1 | 2 | 3
  addressKind: 'current' | 'id_card' | 'registry'
  recipientSnapshot: string
  trackingNo?: string
}

/** บันทึกการส่งจดหมาย 1 ฉบับ (reply เริ่มเป็น pending) */
export async function insertLetter(input: LetterInput): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from('collection_letters').insert({
    contract_id: input.contractId,
    episode_key: input.episodeKey,
    round: input.round,
    address_kind: input.addressKind,
    recipient_snapshot: input.recipientSnapshot,
    tracking_no: input.trackingNo || null,
    printed_at: new Date().toISOString(),
  })
  if (error) throw error
}

/** บันทึกผลตอบกลับของจดหมาย */
export async function updateLetterReply(id: string, reply: LetterReply): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from('collection_letters').update({ reply }).eq('id', id)
  if (error) throw error
}

/** ใส่/แก้เลขพัสดุของจดหมาย */
export async function updateLetterTracking(id: string, trackingNo: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase
    .from('collection_letters')
    .update({ tracking_no: trackingNo || null })
    .eq('id', id)
  if (error) throw error
}

// ---------- ข้อความจดหมาย (template) ----------
const LETTER_TEMPLATE_KEY = 'letter_template'
const DEFAULT_LETTER_TEMPLATE =
  'เรียน คุณ{{name}}\n\nตามที่ท่านได้ทำสัญญาเช่าซื้อเลขที่ {{contractNo}} ปัจจุบันท่านค้างชำระค่างวดเป็นเวลา {{daysLate}} วัน รวมเป็นเงิน {{amount}} บาท\n\nบริษัทขอให้ท่านติดต่อชำระภายใน 7 วันนับจากวันที่ได้รับจดหมายฉบับนี้\n\nจึงเรียนมาเพื่อโปรดดำเนินการ\n\nขอแสดงความนับถือ\nWIN SURE PLUS'

export async function getLetterTemplate(): Promise<string> {
  if (!supabase) return DEFAULT_LETTER_TEMPLATE
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', LETTER_TEMPLATE_KEY)
    .maybeSingle()
  if (error) throw error
  return (data?.value as string) || DEFAULT_LETTER_TEMPLATE
}

export async function saveLetterTemplate(text: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase
    .from('app_settings')
    .upsert(
      { key: LETTER_TEMPLATE_KEY, value: text, description: 'ข้อความจดหมายติดตามหนี้' },
      { onConflict: 'key' },
    )
  if (error) throw error
}

// ============================================================================
// ผู้ติดตามหนี้ (Freelancer) — Wave 3
// ============================================================================

export type ContractGrade = 'A' | 'B' | 'C' | 'D' | 'E'
/** Alias ใช้ใน UsersAdmin — เกรด A-E ที่มอบหมายให้ผู้ติดตามหนี้ */
export type FreelancerGrade = ContractGrade

// ---------- FreelancerRow (camelCase domain type) ----------
export interface FreelancerRow {
  id: string
  fullName: string
  email: string | null
  active: boolean
  grades: string[] // เกรดที่ได้รับมอบหมาย (active assignments เท่านั้น)
}

/** รายชื่อผู้ติดตามหนี้ทั้งหมด + เกรดที่มอบหมาย (admin only — ผ่าน Edge Function) */
export async function listFreelancers(): Promise<FreelancerRow[]> {
  const data = await callAdminUsers({ action: 'listFreelancers' })
  return (data?.freelancers ?? []).map((f: any): FreelancerRow => ({
    id: f.id,
    fullName: f.fullName || '(ไม่มีชื่อ)',
    email: f.email ?? null,
    active: f.active !== false,
    grades: Array.isArray(f.grades) ? f.grades : [],
  }))
}

/** เกรดที่มอบหมายให้ผู้ติดตามหนี้คนหนึ่ง (admin or self — ผ่าน Edge Function) */
export async function getFreelancerGrades(id: string): Promise<string[]> {
  const data = await callAdminUsers({ action: 'listFreelancerGrades', id })
  return Array.isArray(data?.grades) ? data.grades : []
}

/** ตั้งเกรดให้ผู้ติดตามหนี้คนหนึ่ง (full-replace — admin only, ผ่าน Edge Function) */
export async function setFreelancerGrades(id: string, grades: string[]): Promise<void> {
  await callAdminUsers({ action: 'setFreelancerGrades', id, grades })
}

/** รายชื่อผู้ติดตามหนี้ (freelancer) ที่ active — สำหรับ dropdown "มอบหมายเคส" (0099, admin+staff เรียกได้)
 *  ต่างจาก listFreelancers(): query ตรงผ่าน RLS ไม่ผ่าน Edge Function admin-users — Edge Function เดิม
 *  guard เฉพาะ role==='admin' (403 ถ้าไม่ใช่) ทำให้ staff เรียกไม่ได้เลย → modal มอบหมายเคสเห็นรายชื่อว่างเปล่า
 *  (error ถูกกลืนเงียบ) เป็นบั๊กที่ทำให้ "staff มอบหมายได้" (Pete lock) ใช้งานจริงไม่ได้
 *  ใช้ได้ทั้ง admin/staff เพราะ RLS profiles_read_staff_view (0022: is_admin() OR is_staff()+role='freelancer')
 *  + fga_read (0022: is_admin() OR is_staff() OR freelancer_id=auth.uid()) เปิดให้ query ตรงอยู่แล้ว
 *  ไม่ต้องแก้ Edge Function / ไม่แตะ listFreelancers() เดิม (ใช้ที่หน้า user management อื่นอยู่)
 *  คืน shape เดียวกับ FreelancerRow — email เป็น null เสมอ (ไม่มี service_role เข้าถึง auth.users จากฝั่ง client
 *  ถ้าต้อง email จริงใช้ listFreelancers() แทน — ContractDetail ไม่ได้ใช้ email อยู่แล้ว) */
export async function listActiveFreelancers(): Promise<FreelancerRow[]> {
  if (!supabase) return []

  // Step 1: profiles ที่ role='freelancer' AND active=true
  const { data: profileData, error: profileErr } = await supabase
    .from('profiles')
    .select('id, full_name')
    .eq('role', 'freelancer')
    .eq('active', true)
    .order('full_name')
    .range(0, PAGE_CAP)
  if (profileErr) throw profileErr

  const freelancers = (profileData ?? []) as { id: string; full_name: string | null }[]
  if (freelancers.length === 0) return []

  const freelancerIds = freelancers.map((p) => p.id)

  // Step 2: grade assignments ที่ active (ended_at IS NULL) ของ freelancer ทั้งหมดที่ดึงมา
  const { data: fgaData, error: fgaErr } = await supabase
    .from('freelancer_grade_assignments')
    .select('freelancer_id, grade')
    .in('freelancer_id', freelancerIds)
    .is('ended_at', null)
    .range(0, PAGE_CAP)
  if (fgaErr) throw fgaErr

  const gradeMap = new Map<string, string[]>()
  for (const row of (fgaData ?? []) as { freelancer_id: string; grade: string }[]) {
    const existing = gradeMap.get(row.freelancer_id) ?? []
    existing.push(row.grade)
    gradeMap.set(row.freelancer_id, existing)
  }

  return freelancers.map(
    (p): FreelancerRow => ({
      id: p.id,
      fullName: p.full_name || '(ไม่มีชื่อ)',
      email: null,
      active: true, // query กรอง active=true มาแล้ว
      grades: gradeMap.get(p.id) ?? [],
    }),
  )
}
export type FollowUpContactMethod = 'phone' | 'line' | 'sms' | 'visit' | 'other'
export type FollowUpResult =
  | 'contacted'
  | 'no_answer'
  | 'promised'
  | 'refused'
  | 'paid'
  | 'returned'
  | 'other'
  | 'line_pending'  // 0047: ลูกค้า initiate ผ่าน Line (inbound) — ยกเว้นกฎ พ.ร.บ. ทวงหนี้

// 0091: โทรหาลูกหนี้ตัวเอง vs โทรหาผู้ติดต่อ (ญาติ/ผู้ค้ำ) — Pete Option A แบบง่าย
// (ไม่แยกผู้ค้ำเป็น cap ของตัวเอง — แค่ debtor/other) daily cap พ.ร.บ. นับเฉพาะ 'debtor'
export type FollowUpContactTarget = 'debtor' | 'other'

export interface FollowUpEntry {
  id: string
  contractId: string
  authorId: string
  authorName: string
  noteText: string
  contactMethod: FollowUpContactMethod
  followUpResult: FollowUpResult
  nextFollowUpAt: string | null
  promisedAmount: number | null
  createdAt: string
  contactTarget: FollowUpContactTarget          // 0091
  contactPersonName: string | null              // 0091: ชื่อผู้ติดต่อ (ถ้า contactTarget='other')
  contactPersonRelation: string | null          // 0091: ความสัมพันธ์ เช่น ญาติ/ผู้ค้ำ
}

interface FollowUpRow {
  id: string
  contract_id: string
  author_id: string
  author_name: string
  note_text: string
  contact_method: FollowUpContactMethod
  follow_up_result: FollowUpResult
  next_follow_up_at: string | null
  promised_amount: number | null
  created_at: string
  contact_target: FollowUpContactTarget | null            // 0091
  contact_person_name: string | null                      // 0091
  contact_person_relation: string | null                  // 0091
}

function mapFollowUp(r: FollowUpRow): FollowUpEntry {
  return {
    id: r.id,
    contractId: r.contract_id,
    authorId: r.author_id,
    authorName: r.author_name,
    noteText: r.note_text,
    contactMethod: r.contact_method,
    followUpResult: r.follow_up_result,
    nextFollowUpAt: r.next_follow_up_at,
    promisedAmount: r.promised_amount == null ? null : Number(r.promised_amount),
    createdAt: r.created_at,
    contactTarget: r.contact_target ?? 'debtor',   // 0091: fallback กันแถวเก่า/RPC ที่ไม่ select คอลัมน์นี้
    contactPersonName: r.contact_person_name ?? null,
    contactPersonRelation: r.contact_person_relation ?? null,
  }
}

/** บันทึกการติดตามใหม่ */
export interface AddFollowUpInput {
  contractId: string
  noteText: string
  contactMethod: FollowUpContactMethod
  followUpResult: FollowUpResult
  nextFollowUpAt?: string | null    // ISO timestamp — ถ้า result='promised' trigger sync ไป contracts
  promisedAmount?: number | null    // ยอดที่สัญญาไว้ (Wave 1B — ส่งเมื่อ result='promised')
  phoneDialed?: string | null       // Wave 1B: เบอร์ที่หมุน (phone/phone_alt1/phone_alt2/พิมพ์เอง) → 0021
  contactTarget?: FollowUpContactTarget | null       // 0091: default 'debtor' ที่ DB ถ้าไม่ส่ง
  contactPersonName?: string | null                  // 0091: ส่งเมื่อ contactTarget='other'
  contactPersonRelation?: string | null              // 0091: ส่งเมื่อ contactTarget='other'
}

export async function addFollowUp(input: AddFollowUpInput): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from('follow_ups').insert({
    contract_id: input.contractId,
    note_text: input.noteText,
    contact_method: input.contactMethod,
    follow_up_result: input.followUpResult,
    next_follow_up_at: input.nextFollowUpAt ?? null,
    promised_amount: input.promisedAmount ?? null,
    phone_dialed: input.phoneDialed ?? null,
    contact_target: input.contactTarget ?? 'debtor',
    contact_person_name: input.contactPersonName ?? null,
    contact_person_relation: input.contactPersonRelation ?? null,
  })
  if (error) throw error
}

/** ดึงประวัติการติดตามของสัญญาหนึ่ง (ใหม่ → เก่า) */
export async function getFollowUps(contractId: string): Promise<FollowUpEntry[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('follow_ups')
    .select('*')
    .eq('contract_id', contractId)
    .order('created_at', { ascending: false })
    .range(0, PAGE_CAP)
  if (error) throw error
  return ((data ?? []) as FollowUpRow[]).map(mapFollowUp)
}

/** เกรดที่ได้รับมอบหมายของผู้ติดตามหนี้ที่ล็อกอินอยู่ */
export async function getMyAssignedGrades(): Promise<ContractGrade[]> {
  if (!supabase) return []
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return []
  const { data, error } = await supabase
    .from('freelancer_grade_assignments')
    .select('grade')
    .eq('freelancer_id', user.id)
    .is('ended_at', null)
    .range(0, PAGE_CAP)
  if (error) throw error
  return (data ?? []).map((r) => r.grade as ContractGrade)
}

/** ดึงสัญญาในเกรดที่ระบุ (สำหรับคิวผู้ติดตามหนี้) — query จาก v_contract_status */
export interface FreelancerQueueRow {
  contractId: string
  contractNo: string
  customerName: string
  phone: string | null
  phoneAlt1: string | null           // Wave 1B: เบอร์สำรอง 1
  phoneAlt2: string | null           // Wave 1B: เบอร์สำรอง 2
  deviceModel: string                // Wave 1B: model + storage รวม (e.g. "iPhone 15 Pro 256GB")
  shopId: string
  shopName: string
  grade: ContractGrade
  daysLate: number
  monthlyPayment: number
  installmentsPaid: number           // Wave 1B: งวดที่จ่ายแล้ว = term_months - remaining_installments
  installmentsTotal: number          // Wave 1B: จำนวนงวดทั้งหมด (term_months)
  outstanding: number                // ยอดค่าปรับค้าง (penaltyDue) — ยังคงไว้เพื่อ backward compat
  principalDue: number               // Wave 1B: ยอดเงินต้นค้าง = sum(amount - paid_amount) งวดที่ยังไม่ปิด
  overdueAmount: number              // Wave 1 (คิวคนโทร): เงินต้นเฉพาะงวดที่ due_date<=today ยังไม่จ่าย (v_contract_status.overdue_amount, mig 0055) — UI บวกกับ outstanding(ค่าปรับ) เอง
  dnc: boolean
  lawyerEngaged: boolean
  disputed: boolean
  // --- Wave 1B: promise state (denormalized จาก contracts ผ่าน trigger) ---
  promiseToPayDate: string | null    // ISO date
  promisedAmount: number | null
  // --- Wave 1B: aggregate (90-day window, client-side reduce จาก follow_ups) ---
  totalAttempts: number              // จำนวน follow_ups ทั้งหมดใน 90 วัน
  successfulAttempts: number         // จำนวนที่ result IN ('contacted','promised','paid','returned','other') ใน 90 วัน
  lastResult: FollowUpResult | null  // result ของรายการล่าสุด
  lastContactedAt: string | null     // created_at ของรายการล่าสุด (ISO timestamp)
  contactedToday: boolean            // มี follow_up วันนี้ (Bangkok) ที่ result ≠ 'no_answer'
  lastContactedByName: string | null // ชื่อคนโทรล่าสุด สำหรับ team-awareness
  caseClosedToday: boolean           // พนักงานกด "ปิดเคส" วันนี้ (Bangkok) — ใช้แยกแท็บ แทน contactedToday (0081)
  caseClosedAt: string | null        // timestamp ที่ปิดเคส (ISO) — ไว้ให้ UI แสดง tooltip (0081)
  // --- Wave 3 (0047 Collaboration Hub) ---
  latestOtherAuthorAt: string | null  // MAX created_at ของ follow_up ที่ author ≠ ตัวเอง (ใน 90-day window)
  myLastTouchAt: string | null        // MAX(queue_case_seen.last_seen_at, MAX created_at ที่ author = ตัวเอง)
  latestNote: string | null           // note_text ของ follow_up ล่าสุดสุด (ทุก author, ใน window)
  // --- เคสคืนเครื่องแล้วแต่ยังค้างยอด (returned-unpaid) ---
  isReturned: boolean                 // true = status='returned' (UI badge "คืนเครื่องแล้ว")
  returnClosingAmount: number         // ยอดปิดเคสคืนเครื่อง (outstandingAfterReturn.total); 0 สำหรับ active
  returnedAt: string | null           // วันที่คืนเครื่อง (yyyy-mm-dd Bangkok) — null ถ้าไม่ใช่เคสคืนเครื่อง
  // --- anchor fields สำหรับนับ "คืนมากี่วัน" ---
  // เคสเก่า (returnedAt < 2026-07-02) created_at = วันนำเข้า ไม่ใช่วันคืนจริง → ใช้ overdueDueDate แทน
  overdueDueDate: string | null       // due_date งวดค้างเก่าสุด (yyyy-mm-dd) — null ถ้าไม่มีงวดค้าง
  returnAnchorType: 'returned' | 'overdue' | null  // 'returned'=นับจากวันคืน, 'overdue'=นับจากครบงวด, null=ไม่ได้/ไม่ใช่เคสคืน
  returnAnchorDate: string | null     // วันที่ 1 จริงๆ ที่ frontend ใช้ลบกับวันนี้
  color: string | null               // สีเครื่อง (ดึงตรงจาก contracts)
  // --- ระบบจองเคส claim/release (0086) ---
  assignedTo: string | null           // uuid ของ profiles ผู้ถือเคสอยู่ — null = ว่าง
  assignedToName: string | null       // ชื่อผู้ถือเคส (join profiles.full_name) — null ถ้าว่าง
  // --- BA spec (แบม): เพิ่มข้อมูลสัญญาให้ FollowUpModal ใช้ ---
  dueDay: number            // contracts.due_day — ชำระทุกวันที่ (1-31)
  transactionDate: string   // contracts.transaction_date — วันที่ทำรายการ (yyyy-mm-dd)
}

interface QueueStatusRow {
  contract_id: string
  contract_no: string
  customer_name: string
  shop_id: string
  shop_name: string | null
  days_late: number
  penalty_due: number
  grade: string | null
  remaining_installments: number
  status: string   // 'active' | 'returned' — แยกเคสคืนเครื่องที่ยังค้างยอด
  overdue_amount: number
}

interface QueueContractRow {
  id: string
  phone: string | null
  phone_alt1: string | null
  phone_alt2: string | null
  model: string | null
  storage: string | null
  color: string | null
  monthly_payment: number | null
  term_months: number | null
  current_grade: string | null
  dnc: boolean
  lawyer_engaged: boolean
  disputed: boolean
  promise_to_pay_date: string | null
  promised_amount: number | null
  case_closed_at: string | null
  assigned_to: string | null
  due_day: number | null
  transaction_date: string | null
}

export async function getFreelancerQueue(grades: ContractGrade[]): Promise<FreelancerQueueRow[]> {
  if (!supabase || grades.length === 0) return []

  // ดึงจาก v_contract_status:
  //  - status='active' + bucket != normal (คิวลูกหนี้ปกติเดิม)
  //  - status='returned' (เคสคืนเครื่องแล้วแต่ยังค้างยอด → เด้งเข้าคิวตามเกรดเดิม)
  // RLS เกรดยังกรองให้เอง: freelancer เห็นเฉพาะเกรดตัวเอง (ทั้ง active + returned)
  // ไม่รวม returned_closed / closed / online (ปิดแล้ว ไม่ต้องตามเก็บ)
  const { data: statusData, error: statusError } = await supabase
    .from('v_contract_status')
    .select('contract_id, contract_no, customer_name, shop_id, shop_name, days_late, penalty_due, grade, remaining_installments, status, overdue_amount')
    .in('status', ['active', 'returned'])
    .neq('bucket', 'normal')
    .in('grade', grades)
    .order('days_late', { ascending: false })
    .range(0, PAGE_CAP)
  if (statusError) throw statusError

  // กรอง bucket: เดิม view ตัด bucket='normal' ออกอยู่แล้ว แต่เคส returned
  // อาจมี bucket='normal' (จ่ายตรงเวลาก่อนคืนเครื่อง) — ต้องคงไว้ ไม่ตัดทิ้ง
  // .neq('bucket','normal') ด้านบนตัด returned ที่ normal ทิ้งไปด้วย จึงต้อง re-include
  // ด้วย query ที่สอง เฉพาะ returned (เลี่ยงทำ logic ฝั่ง SQL ซับซ้อน)
  const { data: returnedNormalData, error: returnedNormalErr } = await supabase
    .from('v_contract_status')
    .select('contract_id, contract_no, customer_name, shop_id, shop_name, days_late, penalty_due, grade, remaining_installments, status, overdue_amount')
    .eq('status', 'returned')
    .eq('bucket', 'normal')
    .in('grade', grades)
    .range(0, PAGE_CAP)
  if (returnedNormalErr) throw returnedNormalErr

  const seenIds = new Set<string>()
  const statusRows: QueueStatusRow[] = []
  for (const r of [...((statusData ?? []) as QueueStatusRow[]), ...((returnedNormalData ?? []) as QueueStatusRow[])]) {
    if (seenIds.has(r.contract_id)) continue
    seenIds.add(r.contract_id)
    statusRows.push(r)
  }
  if (statusRows.length === 0) return []

  return buildFreelancerQueueRows(statusRows)
}

/** เคสเดียวตาม contract_id — สำหรับ optimistic update หลัง save/claim/release (#4, ไม่ต้องโหลดทั้งคิว)
 *  reuse logic เดียวกับ getFreelancerQueue ผ่าน buildFreelancerQueueRows แต่ query v_contract_status แค่ 1 แถว
 *  คืน null เมื่อ: ไม่มีสัญญานี้ / RLS บล็อก (ไม่ใช่เกรดตัวเอง) / active+bucket='normal' (ยังไม่ล่าช้า ไม่เข้าคิว) /
 *  returned แต่ returnClosingAmount<=0 (จ่ายครบแล้ว ปิดจบ) / ไม่ใช่เจ้าของเคส (assigned_to คนอื่น, non-admin) */
export async function getFreelancerQueueRow(contractId: string): Promise<FreelancerQueueRow | null> {
  if (!supabase) return null
  const { data: statusData, error: statusError } = await supabase
    .from('v_contract_status')
    .select('contract_id, contract_no, customer_name, shop_id, shop_name, days_late, penalty_due, grade, remaining_installments, status, overdue_amount, bucket')
    .eq('contract_id', contractId)
    .in('status', ['active', 'returned'])
    .maybeSingle()
  if (statusError) throw statusError
  if (!statusData) return null

  // mirror เงื่อนไข SQL ของ getFreelancerQueue: active+bucket='normal' (ยังไม่ล่าช้า) ไม่เข้าคิว
  // returned เข้าเสมอไม่ว่า bucket ไหน (union Query1+Query2 เดิม) — ตัด returnClosingAmount<=0 ทีหลังใน buildFreelancerQueueRows
  const row = statusData as QueueStatusRow & { bucket: string | null }
  if (row.status === 'active' && row.bucket === 'normal') return null

  const rows = await buildFreelancerQueueRows([row])
  return rows[0] ?? null
}

/** ประกอบ FreelancerQueueRow[] จาก statusRows ที่ query จาก v_contract_status มาแล้ว
 *  (shared logic: getFreelancerQueue โหลดทั้งคิว + getFreelancerQueueRow เคสเดียว เรียกอันนี้ต่อกันเพื่อไม่ให้สูตรคำนวณเพี้ยน 2 ที่) */
async function buildFreelancerQueueRows(statusRows: QueueStatusRow[]): Promise<FreelancerQueueRow[]> {
  if (!supabase || statusRows.length === 0) return []

  // ดึง uid ของผู้ใช้ปัจจุบัน — ใช้ในการแยก my vs other author (Wave 3) + กรอง claim (0086)
  const {
    data: { user: currentUser },
  } = await supabase.auth.getUser()
  const myUid = currentUser?.id ?? null

  // role ของผู้ใช้ปัจจุบัน — admin เห็นทุกเคสในคิว (ไม่กรอง assigned_to), freelancer/staff เห็นเฉพาะ
  // เคสที่ว่าง (assigned_to is null) หรือเคสที่ตัวเอง claim ไว้ (0086 — กันคิวโดนคนอื่น claim บังหน้าจอ)
  let isAdminUser = false
  if (myUid) {
    const { data: myProfile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', myUid)
      .maybeSingle()
    isAdminUser = (myProfile as { role?: string } | null)?.role === 'admin'
  }

  // --- ยอดปิดเคสคืนเครื่อง (returnClosingAmount) ---
  // เฉพาะแถว status='returned': คำนวณยอดปิดด้วย outstandingAfterReturn
  //  = งวดค้างเก่าสุด 1 งวด + ค่าปรับงวดนั้น + ค่าซ่อม + extras อื่น
  // โหลด installments + extra_charges เฉพาะสัญญา returned (จำนวนน้อย) แบบ batch in-filter
  // → ไม่ N+1; ถ้าไม่มี returned เลย ข้ามทั้งสอง query
  // ก่อน 2 ก.ค. 2026 device_returns.created_at = วันนำเข้า/สร้างแถว ไม่ใช่วันคืนจริง
  // → เคสคืนเก่านับจากวันครบงวดค้างแทน; ตั้งแต่ 2 ก.ค. ไปวันคืนจริงเชื่อถือได้
  const RETURN_DATE_RELIABLE_FROM = '2026-07-02'
  const returnedIds = statusRows.filter((r) => r.status === 'returned').map((r) => r.contract_id)
  const returnClosingMap = new Map<string, number>()
  const overdueDueDateMap = new Map<string, string>() // contract_id → due_date งวดค้างเก่าสุด
  if (returnedIds.length > 0) {
    const [{ data: retInstData, error: retInstErr }, { data: retExtraData, error: retExtraErr }] =
      await Promise.all([
        supabase
          .from('installments')
          .select('contract_id, id, installment_no, due_date, amount, paid_at, paid_amount, paid_by_name, penalty_days, penalty_amount, status')
          .in('contract_id', returnedIds)
          .range(0, PAGE_CAP),
        supabase
          .from('extra_charges')
          .select('id, contract_id, amount, reason, created_at, created_by')
          .in('contract_id', returnedIds)
          .range(0, PAGE_CAP),
      ])
    if (retInstErr) throw retInstErr
    if (retExtraErr) throw retExtraErr

    // group installments per contract → domain Installment (ผ่าน mapInstallment)
    const instByContract = new Map<string, Installment[]>()
    for (const row of (retInstData ?? []) as InstallmentRow[]) {
      const cid = row.contract_id
      if (!cid) continue
      const arr = instByContract.get(cid) ?? []
      arr.push(mapInstallment(row))
      instByContract.set(cid, arr)
    }
    // group extra_charges per contract → domain ExtraCharge (ผ่าน mapExtraCharge)
    const extraByContract = new Map<string, ExtraCharge[]>()
    for (const row of (retExtraData ?? []) as ExtraChargeRow[]) {
      const arr = extraByContract.get(row.contract_id) ?? []
      arr.push(mapExtraCharge(row))
      extraByContract.set(row.contract_id, arr)
    }
    for (const cid of returnedIds) {
      const result = outstandingAfterReturn(
        instByContract.get(cid) ?? [],
        extraByContract.get(cid) ?? [],
      )
      returnClosingMap.set(cid, result.total)
      // ดึง due_date ของงวดค้างเก่าสุดจาก result.details (reuse ผลเดิม ไม่ N+1)
      if (result.details?.dueDate) {
        overdueDueDateMap.set(cid, result.details.dueDate)
      }
    }
  }

  // ดึง phone + model + monthly_payment + promise fields จาก contracts
  const ids = statusRows.map((r) => r.contract_id)
  const { data: contractData, error: contractError } = await supabase
    .from('contracts')
    .select(
      'id, phone, phone_alt1, phone_alt2, model, storage, color, monthly_payment, term_months, current_grade, dnc, lawyer_engaged, disputed, promise_to_pay_date, promised_amount, case_closed_at, assigned_to, due_day, transaction_date',
    )
    .in('id', ids)
    .range(0, PAGE_CAP)
  if (contractError) throw contractError

  const contractMap = new Map(
    ((contractData ?? []) as QueueContractRow[]).map((c) => [c.id, c]),
  )

  // Query: installments ที่ยังไม่ปิด (paid_at IS NULL) เพื่อคำนวณ principalDue per contract
  // principalDue = sum(amount - coalesce(paid_amount, 0)) ของงวดยังไม่ปิด
  // NOTE: ถ้า queue ขนาดใหญ่ query นี้อาจถึง PostgREST row-cap → .range(0, PAGE_CAP)
  const { data: instData, error: instErr } = await supabase
    .from('installments')
    .select('contract_id, amount, paid_amount')
    .in('contract_id', ids)
    .is('paid_at', null)
    .range(0, PAGE_CAP)
  if (instErr) throw instErr

  // Client-side reduce: principalDue per contract_id
  const principalMap = new Map<string, number>()
  for (const inst of (instData ?? []) as {
    contract_id: string
    amount: number
    paid_amount: number | null
  }[]) {
    const prev = principalMap.get(inst.contract_id) ?? 0
    const rowDue = Number(inst.amount) - Number(inst.paid_amount ?? 0)
    principalMap.set(inst.contract_id, prev + Math.max(0, rowDue))
  }

  // Query: aggregate follow_ups ย้อนหลัง 90 วัน (single round-trip)
  // Wave 3: เพิ่ม author_id + note_text เพื่อคำนวณ latestOtherAuthorAt / myLastFollowUpAt / latestNote
  // successfulAttempts = result IN ('contacted','promised','paid','returned','other','line_pending')
  // (0047: line_pending นับเป็น "ติดต่อสำเร็จ" — Pete decision)
  // (ไม่นับ 'no_answer', 'refused', หรือ null)
  const since = new Date(Date.now() - 90 * 86400 * 1000).toISOString()
  // todayBkk: วันที่ปัจจุบันตาม Bangkok timezone (UTC+7) ในรูป yyyy-mm-dd
  const todayBkk = (() => {
    const d = new Date(Date.now() + 7 * 3600 * 1000)
    return d.toISOString().slice(0, 10)
  })()
  const { data: followUpsData, error: fuErr } = await supabase
    .from('follow_ups')
    .select('contract_id, follow_up_result, created_at, author_name, author_id, note_text, contact_target')
    .in('contract_id', ids)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .range(0, PAGE_CAP)
  if (fuErr) throw fuErr

  // Query: queue_case_seen ของผู้ใช้ปัจจุบัน (batch — ไม่ N+1)
  // last_seen_at ใช้ประกอบ myLastTouchAt (max กับ myLastFollowUpAt)
  const seenMap = new Map<string, string>() // contract_id → last_seen_at (ISO)
  if (myUid) {
    const { data: seenData, error: seenErr } = await supabase
      .from('queue_case_seen')
      .select('contract_id, last_seen_at')
      .eq('freelancer_id', myUid)
      .in('contract_id', ids)
    if (seenErr) throw seenErr
    for (const s of (seenData ?? []) as { contract_id: string; last_seen_at: string }[]) {
      seenMap.set(s.contract_id, s.last_seen_at)
    }
  }

  // Client-side reduce: สร้าง aggregate map per contract_id
  type FuAgg = {
    totalAttempts: number
    successfulAttempts: number
    lastResult: FollowUpResult | null
    lastContactedAt: string | null
    contactedToday: boolean
    lastContactedByName: string | null
    // Wave 3 fields
    latestNote: string | null           // note_text ของแถวแรก (order desc → ล่าสุดอยู่หน้า)
    latestOtherAuthorAt: string | null  // created_at ของแถวแรกที่ author ≠ myUid
    myLastFollowUpAt: string | null     // created_at ของแถวแรกที่ author = myUid
  }
  const fuMap = new Map<string, FuAgg>()
  for (const fu of (followUpsData ?? []) as {
    contract_id: string
    follow_up_result: FollowUpResult | null
    created_at: string
    author_name: string | null
    author_id: string | null
    note_text: string | null
    contact_target: FollowUpContactTarget | null
  }[]) {
    const agg = fuMap.get(fu.contract_id) ?? {
      totalAttempts: 0,
      successfulAttempts: 0,
      lastResult: null,
      lastContactedAt: null,
      contactedToday: false,
      lastContactedByName: null,
      latestNote: null,
      latestOtherAuthorAt: null,
      myLastFollowUpAt: null,
    }
    agg.totalAttempts++

    // 0091: เดินเรื่อง "ติดต่อลูกหนี้สำเร็จ/วันนี้" ต้องนับเฉพาะ contact_target='debtor' —
    // โทรหาผู้ติดต่อ (ญาติ/ผู้ค้ำ) ไม่ใช่การติดต่อลูกหนี้ตัวเอง ไม่งั้น priority queue จะเพี้ยน
    // (แถวเก่าก่อน 0091 ไม่มีคอลัมน์นี้ตอน select ยัง fallback 'debtor' ที่ DB default — ถือว่า debtor)
    const isDebtorContact = (fu.contact_target ?? 'debtor') === 'debtor'

    // successfulAttempts: result ∈ {contacted, promised, paid, returned, other, line_pending}
    // ไม่นับ 'no_answer' (ไม่ติดต่อได้) และ 'refused' (ปฏิเสธ) และ null (ไม่ระบุ)
    // 0047: line_pending นับเป็น "ติดต่อสำเร็จ" (Pete decision — inbound ลูกค้า initiate)
    // 0091: ต้องเป็นการโทรหาลูกหนี้ (contact_target='debtor') ด้วย
    if (
      isDebtorContact &&
      (fu.follow_up_result === 'contacted' ||
        fu.follow_up_result === 'promised' ||
        fu.follow_up_result === 'paid' ||
        fu.follow_up_result === 'returned' ||
        fu.follow_up_result === 'other' ||
        fu.follow_up_result === 'line_pending')
    ) {
      agg.successfulAttempts++
    }

    // lastResult + lastContactedAt + lastContactedByName + latestNote:
    // ใช้แถวแรก (order desc → ล่าสุดอยู่หน้า)
    if (agg.lastResult === null) {
      agg.lastResult = fu.follow_up_result
      agg.lastContactedAt = fu.created_at
      agg.lastContactedByName = fu.author_name
      agg.latestNote = fu.note_text   // note ของแถวล่าสุดสุด (ทุก author)
    }

    // latestOtherAuthorAt: แถวแรกที่ author ≠ ตัวเอง (order desc → ล่าสุดอยู่หน้า)
    if (agg.latestOtherAuthorAt === null && fu.author_id !== myUid) {
      agg.latestOtherAuthorAt = fu.created_at
    }

    // myLastFollowUpAt: แถวแรกที่ author = ตัวเอง (order desc → ล่าสุดอยู่หน้า)
    if (agg.myLastFollowUpAt === null && myUid && fu.author_id === myUid) {
      agg.myLastFollowUpAt = fu.created_at
    }

    // contactedToday: ต้อง shift created_at เป็น Bangkok ก่อนเทียบ (กัน off-by-one)
    // contactedToday logic เดิม result !== 'no_answer' — ครอบ line_pending อยู่แล้ว (ตั้งใจ)
    // 0091: ต้องเป็น contact_target='debtor' ด้วย — โทรหาผู้ติดต่อวันนี้ไม่ถือว่า "ติดต่อลูกหนี้วันนี้"
    if (!agg.contactedToday && isDebtorContact && fu.follow_up_result !== 'no_answer') {
      const fuBkkDate = new Date(
        new Date(fu.created_at).getTime() + 7 * 3600 * 1000,
      )
        .toISOString()
        .slice(0, 10)
      if (fuBkkDate === todayBkk) {
        agg.contactedToday = true
      }
    }
    fuMap.set(fu.contract_id, agg)
  }

  // --- วันที่คืนเครื่อง (returnedAt) ---
  // batch query device_returns เฉพาะ returnedIds — ดึง created_at (วันที่สร้างแถวคืนเครื่อง)
  // ซึ่งใช้เป็น "วันที่คืน" ตาม pattern เดียวกับ v_device_return_report (mig 0073)
  // ถ้า 1 สัญญามีหลายแถว device_returns (เคยยกเลิก/คืนซ้ำ) → เอาแถวล่าสุด (order by created_at desc)
  const returnedAtMap = new Map<string, string>() // contract_id → yyyy-mm-dd (Bangkok)
  if (returnedIds.length > 0) {
    // สมมติฐาน cap: เคสคืนเครื่องในคิวจะน้อยกว่า PAGE_CAP (~4999) มาก (ปกติไม่กี่สิบรายต่อครั้ง)
    // dedup ใน JS ทำงานถูกต้องเพราะ order created_at desc → แถวแรกที่เจอต่อ contract = คืนล่าสุดเสมอ
    // ถ้า device_returns โตจนใกล้ cap ต้องเปลี่ยนเป็น DISTINCT ON (contract_id) ฝั่ง DB แทน
    const { data: drData, error: drErr } = await supabase
      .from('device_returns')
      .select('contract_id, created_at')
      .in('contract_id', returnedIds)
      .order('created_at', { ascending: false })
      .range(0, PAGE_CAP)
    if (drErr) throw drErr
    for (const dr of (drData ?? []) as { contract_id: string; created_at: string }[]) {
      // เก็บแค่แถวแรก (ล่าสุด) ต่อ contract เพราะ order desc + เราข้ามถ้ามีแล้ว
      if (returnedAtMap.has(dr.contract_id)) continue
      // แปลง timestamptz → วันที่ Bangkok (UTC+7) ตัดเวลาออก
      const bkkDate = new Date(new Date(dr.created_at).getTime() + 7 * 3600 * 1000)
        .toISOString()
        .slice(0, 10)
      returnedAtMap.set(dr.contract_id, bkkDate)
    }
  }

  // กรองทิ้งเคส returned ที่ยอดปิด ≤ 0 (ไม่มีอะไรต้องเก็บ = ไม่ต้องเด้งคิว)
  // เคส active คงเดิมทุกแถว
  // กรอง assigned_to (0086): admin เห็นหมด, freelancer/staff เห็นเฉพาะเคสว่าง (assigned_to null) หรือของตัวเอง
  // ทำหลัง filter returned-closing เพื่อไม่ไปแตะ logic tab เดิม (caseClosedToday/returned/overdueFilter ทำที่ UI ต่อจากนี้)
  const visibleRows = statusRows.filter((r) => {
    if (r.status === 'returned' && (returnClosingMap.get(r.contract_id) ?? 0) <= 0) return false
    if (isAdminUser) return true
    const owner = contractMap.get(r.contract_id)?.assigned_to ?? null
    return owner === null || owner === myUid
  })

  // ชื่อผู้ถือเคส (assignedToName) — batch query profiles เฉพาะ assigned_to ที่ปรากฏใน visibleRows (ไม่ N+1)
  const assignedToIds = [
    ...new Set(
      visibleRows
        .map((r) => contractMap.get(r.contract_id)?.assigned_to ?? null)
        .filter((v): v is string => v !== null),
    ),
  ]
  const assignedNameMap = new Map<string, string>()
  if (assignedToIds.length > 0) {
    const { data: assignedProfiles, error: assignedProfilesErr } = await supabase
      .from('profiles')
      .select('id, full_name')
      .in('id', assignedToIds)
    if (assignedProfilesErr) throw assignedProfilesErr
    for (const p of (assignedProfiles ?? []) as { id: string; full_name: string | null }[]) {
      assignedNameMap.set(p.id, p.full_name ?? '')
    }
  }

  return visibleRows.map((r): FreelancerQueueRow => {
    const c = contractMap.get(r.contract_id)
    const isReturned = r.status === 'returned'
    const agg = fuMap.get(r.contract_id) ?? {
      totalAttempts: 0,
      successfulAttempts: 0,
      lastResult: null,
      lastContactedAt: null,
      contactedToday: false,
      lastContactedByName: null,
      latestNote: null,
      latestOtherAuthorAt: null,
      myLastFollowUpAt: null,
    }
    const termMonths = Number(c?.term_months ?? 0)
    const statusRemaining = r.remaining_installments ?? 0
    const installmentsPaid = Math.max(0, termMonths - statusRemaining)
    const modelParts = [c?.model, c?.storage].filter(Boolean)

    // myLastTouchAt = max(queue_case_seen.last_seen_at, myLastFollowUpAt)
    // เปรียบเทียบผ่าน Date.getTime() กัน offset-format mismatch (Z vs +00:00)
    const seenAt = seenMap.get(r.contract_id) ?? null
    let myLastTouchAt: string | null = null
    if (seenAt && agg.myLastFollowUpAt) {
      myLastTouchAt =
        new Date(seenAt).getTime() >= new Date(agg.myLastFollowUpAt).getTime()
          ? seenAt
          : agg.myLastFollowUpAt
    } else {
      myLastTouchAt = seenAt ?? agg.myLastFollowUpAt
    }

    // caseClosedToday: เทียบ case_closed_at กับวันนี้ Bangkok (UTC+7) — mirror logic contactedToday
    const caseClosedAt = c?.case_closed_at ?? null
    const caseClosedToday = caseClosedAt
      ? new Date(new Date(caseClosedAt).getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10) === todayBkk
      : false

    // --- anchor สำหรับนับ "คืนมากี่วัน" ---
    // เคสเก่า (returnedAt < RETURN_DATE_RELIABLE_FROM) ใช้ overdueDueDate แทนวันคืน
    const returnedAt = isReturned ? (returnedAtMap.get(r.contract_id) ?? null) : null
    const overdueDueDate = isReturned ? (overdueDueDateMap.get(r.contract_id) ?? null) : null
    let returnAnchorType: 'returned' | 'overdue' | null = null
    let returnAnchorDate: string | null = null
    if (isReturned) {
      const reliable = returnedAt !== null && returnedAt >= RETURN_DATE_RELIABLE_FROM
      if (reliable) {
        returnAnchorType = 'returned'
        returnAnchorDate = returnedAt
      } else if (overdueDueDate !== null) {
        returnAnchorType = 'overdue'
        returnAnchorDate = overdueDueDate
      }
      // ถ้าไม่มีทั้งคู่ → null/null (นับไม่ได้)
    }

    return {
      contractId: r.contract_id,
      contractNo: r.contract_no,
      customerName: r.customer_name,
      phone: c?.phone ?? null,
      phoneAlt1: c?.phone_alt1 ?? null,
      phoneAlt2: c?.phone_alt2 ?? null,
      deviceModel: modelParts.join(' '),
      shopId: r.shop_id,
      shopName: r.shop_name ?? '-',
      grade: (r.grade ?? c?.current_grade ?? 'E') as ContractGrade,
      daysLate: r.days_late,
      monthlyPayment: Number(c?.monthly_payment ?? 0),
      installmentsPaid,
      installmentsTotal: termMonths,
      outstanding: Number(r.penalty_due),
      principalDue: principalMap.get(r.contract_id) ?? 0,
      overdueAmount: Number(r.overdue_amount) || 0,
      dnc: c?.dnc ?? false,
      lawyerEngaged: c?.lawyer_engaged ?? false,
      disputed: c?.disputed ?? false,
      promiseToPayDate: c?.promise_to_pay_date ?? null,
      promisedAmount: c?.promised_amount == null ? null : Number(c.promised_amount),
      totalAttempts: agg.totalAttempts,
      successfulAttempts: agg.successfulAttempts,
      lastResult: agg.lastResult,
      lastContactedAt: agg.lastContactedAt,
      contactedToday: agg.contactedToday,
      lastContactedByName: agg.lastContactedByName,
      latestOtherAuthorAt: agg.latestOtherAuthorAt,
      myLastTouchAt,
      latestNote: agg.latestNote,
      isReturned,
      returnClosingAmount: isReturned ? (returnClosingMap.get(r.contract_id) ?? 0) : 0,
      returnedAt,
      caseClosedToday,
      caseClosedAt,
      color: c?.color ?? null,
      overdueDueDate,
      returnAnchorType,
      returnAnchorDate,
      assignedTo: c?.assigned_to ?? null,
      assignedToName: c?.assigned_to ? (assignedNameMap.get(c.assigned_to) ?? null) : null,
      dueDay: Number(c?.due_day ?? 1),
      transactionDate: c?.transaction_date ?? '',
    }
  })
}

// ---------- ระบบจองเคส claim/release (0086) — กันสองคนโทรชนกันในคิวเดียวกัน ----------

/** จองเคส — atomic ผ่าน RPC claim_case (0086); มีคนถืออยู่แล้ว → throw error message 'CASE_ALREADY_CLAIMED' (UI จับเอง) */
export async function claimCase(contractId: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.rpc('claim_case', { p_contract_id: contractId })
  if (error) throw error
}

/** ปล่อยเคส — atomic ผ่าน RPC release_case (0086); ไม่ใช่เจ้าของ/ไม่ใช่ admin → throw error message 'NOT_CASE_OWNER' */
export async function releaseCase(contractId: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.rpc('release_case', { p_contract_id: contractId })
  if (error) throw error
}

/** มอบหมายเคสให้ freelancer เจาะจง — ผ่าน RPC assign_case (0099, admin+staff เท่านั้น)
 *  ต่างจาก claimCase: ข้ามเกรดได้ + reassign/steal ได้ (ไม่เช็ค assigned_to is null)
 *  ผู้รับมอบหมายต้องเป็น freelancer ที่ active — ไม่ตรง → throw 'ASSIGNEE_NOT_ACTIVE_FREELANCER'
 *  ไม่พบสัญญา → throw 'CONTRACT_NOT_FOUND' */
export async function assignCase(contractId: string, assigneeId: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.rpc('assign_case', {
    p_contract_id: contractId,
    p_assignee_id: assigneeId,
  })
  if (error) throw error
}

/** เคสที่ตัวเอง (ผู้ใช้ปัจจุบัน) ถือครองอยู่ — reuse getFreelancerQueue shape (FreelancerQueueRow)
 *  รวม 2 แหล่ง แล้ว dedupe ด้วย contractId:
 *   1) เคสในเกรดที่ตัวเองได้รับมอบหมาย (getFreelancerQueue(grades)) filter assignedTo=me — เดิม
 *   2) เคส "ข้ามเกรด" ที่ถูก assign_case (0099) มอบให้ตรงๆ โดยไม่ผูก grade เลย —
 *      getFreelancerQueue กรองด้วย grades เสมอ จึงไม่มีทางเจอเคสข้ามเกรด ต้อง query แยก:
 *      ดึง contracts.id ที่ assigned_to=me ตรงๆ ก่อน (RLS 0099 เปิด clause นี้ไม่ผูก grade แล้ว)
 *      แล้วค่อยดึงสถานะจาก v_contract_status + ประกอบด้วย buildFreelancerQueueRows เดียวกับคิวปกติ
 *      (reuse สูตรคำนวณ principalDue/aggregate เดิม ไม่เขียนซ้ำ กันเพี้ยน 2 ที่) */
export async function getMyCases(): Promise<FreelancerQueueRow[]> {
  if (!supabase) return []
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return []

  const grades = await getMyAssignedGrades()
  const inGradeQueue = grades.length > 0 ? await getFreelancerQueue(grades) : []
  const inGradeMine = inGradeQueue.filter((r) => r.assignedTo === user.id)
  const inGradeIds = new Set(inGradeMine.map((r) => r.contractId))

  // เคสที่ assigned_to=me ตรงๆ (ไม่ผูก grade) — RLS 0099 เปิดให้อ่าน contracts แถวนี้ได้แล้ว
  const { data: assignedContracts, error: assignedErr } = await supabase
    .from('contracts')
    .select('id')
    .eq('assigned_to', user.id)
    .range(0, PAGE_CAP)
  if (assignedErr) throw assignedErr
  const crossGradeIds = ((assignedContracts ?? []) as { id: string }[])
    .map((r) => r.id)
    .filter((id) => !inGradeIds.has(id))

  if (crossGradeIds.length === 0) return inGradeMine

  const { data: statusData, error: statusErr } = await supabase
    .from('v_contract_status')
    .select(
      'contract_id, contract_no, customer_name, shop_id, shop_name, days_late, penalty_due, grade, remaining_installments, status, overdue_amount, bucket',
    )
    .in('contract_id', crossGradeIds)
    .range(0, PAGE_CAP)
  if (statusErr) throw statusErr

  // mirror เงื่อนไข getFreelancerQueue: active+bucket='normal' (ยังไม่ล่าช้า) ไม่เข้าคิว
  // returned เข้าเสมอไม่ว่า bucket ไหน — buildFreelancerQueueRows ตัด returnClosingAmount<=0 ทีหลังเอง
  const filteredStatus = ((statusData ?? []) as (QueueStatusRow & { bucket: string | null })[]).filter(
    (r) => !(r.status === 'active' && r.bucket === 'normal'),
  )
  const crossGradeRows = await buildFreelancerQueueRows(filteredStatus)

  return [...inGradeMine, ...crossGradeRows]
}

interface CaseOwnershipCountRow {
  assigned_to: string
}

/** สรุปว่าใครถือกี่เคส — เฉพาะ admin (contracts RLS is_admin() → true, role อื่นเห็นแค่ของตัวเองผ่าน grade scope)
 *  group by assigned_to ฝั่ง client (จำนวนแถวเล็ก ไม่ต้อง RPC พิเศษ) */
export async function getCaseOwnershipSummary(): Promise<{ ownerId: string; ownerName: string; count: number }[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('contracts')
    .select('assigned_to')
    .not('assigned_to', 'is', null)
    .range(0, PAGE_CAP)
  if (error) throw error

  const countMap = new Map<string, number>()
  for (const r of (data ?? []) as CaseOwnershipCountRow[]) {
    countMap.set(r.assigned_to, (countMap.get(r.assigned_to) ?? 0) + 1)
  }
  const ownerIds = [...countMap.keys()]
  if (ownerIds.length === 0) return []

  const { data: profileData, error: profileErr } = await supabase
    .from('profiles')
    .select('id, full_name')
    .in('id', ownerIds)
  if (profileErr) throw profileErr
  const nameMap = new Map(
    ((profileData ?? []) as { id: string; full_name: string | null }[]).map((p) => [p.id, p.full_name ?? '']),
  )

  return ownerIds
    .map((id) => ({ ownerId: id, ownerName: nameMap.get(id) ?? '(ไม่พบชื่อ)', count: countMap.get(id) ?? 0 }))
    .sort((a, b) => b.count - a.count)
}

/** ปิดเคสในคิวโทร — บันทึกว่าพนักงานได้ดำเนินการเสร็จแล้ววันนี้
 *  เคสจะออกจากแท็บ "ที่ต้องโทร" (caseClosedToday=true) จนถึงเที่ยงคืน Bangkok แล้วกลับมาถ้ายังไม่จ่าย
 *  @param contractId  id ของสัญญาที่จะปิดเคส
 *  @param closerName  ชื่อพนักงาน (useAuth().name = full_name) — ส่งมาจาก UI */
export async function closeCase(contractId: string, closerName?: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase
    .from('contracts')
    .update({
      case_closed_at: new Date().toISOString(),
      case_closed_by: closerName ?? null,
    })
    .eq('id', contractId)
  if (error) throw error
}

// ---------- Compliance flags ----------

export type ContractFlagPatch = {
  dnc?: boolean
  dncReason?: string | null
  lawyerEngaged?: boolean
  lawyerName?: string | null
  lawyerPhone?: string | null
  lawyerEngagedAt?: string | null // date ISO
  disputed?: boolean
  disputedSince?: string | null // date ISO
  pendingDocuments?: boolean    // true = รอเอกสาร (Case Online); suppress สถานะล่าช้า
  pendingDocItems?: string[]    // 0053: รายการเอกสารที่รอ — แก้แล้ว ไม่ trigger bounce-back
  hasPhoneBox?: boolean         // แก้ค่ากล่องโทรศัพท์ (มี/ไม่มีกล่องส่งคืน) หลังสร้างสัญญาแล้ว
}

/** ตั้ง/ปลด compliance flags บนสัญญา (admin+staff ผ่าน RLS contracts_write; trigger กัน staff ปลด) */
export async function setContractFlags(
  contractId: string,
  patch: ContractFlagPatch,
): Promise<void> {
  if (!supabase) return // mock mode — no-op
  const upd: Record<string, unknown> = {}
  if (patch.dnc !== undefined) upd.dnc = patch.dnc
  if (patch.dncReason !== undefined) upd.dnc_reason = patch.dncReason
  if (patch.lawyerEngaged !== undefined) upd.lawyer_engaged = patch.lawyerEngaged
  if (patch.lawyerName !== undefined) upd.lawyer_name = patch.lawyerName
  if (patch.lawyerPhone !== undefined) upd.lawyer_phone = patch.lawyerPhone
  if (patch.lawyerEngagedAt !== undefined) upd.lawyer_engaged_at = patch.lawyerEngagedAt
  if (patch.disputed !== undefined) upd.disputed = patch.disputed
  if (patch.disputedSince !== undefined) upd.disputed_since = patch.disputedSince
  if (patch.pendingDocuments !== undefined) {
    upd.pending_documents = patch.pendingDocuments
    // bounce-back: ทุกครั้งที่ tick "รอเอกสาร" → clear ประวัติส่งเมล/สรุป
    // เพื่อให้เคสเด้งกลับเข้าหน้า WaitingEmail + WaitingSummary (filter !sentAt)
    // ปลอดภัยแม้ true→true เพราะ markEmailSent/markSummarySent ตั้ง pending=false เสมอ
    // จึงไม่มีเคสที่ pending อยู่แล้วแล้วถูก clear ซ้ำโดยไม่ตั้งใจ
    if (patch.pendingDocuments === true) {
      upd.email_sent_at = null
      upd.email_sent_by = null
      upd.summary_sent_at = null
      upd.summary_sent_by = null
      // 2 ด่านสรุปยอด (0075) — เด้งกลับรอบ 1 ครบ
      upd.summary_shop_sent_at = null
      upd.summary_shop_sent_by = null
      upd.summary_accounting_sent_at = null
      upd.summary_accounting_sent_by = null
      upd.documents_confirmed_at = null
      upd.documents_confirmed_by = null
    }
  }
  // pendingDocItems: แก้รายการเอกสารที่รอ — ไม่ trigger bounce-back (Pete: "แก้ list เฉยๆ ไม่เด้งคิว")
  if (patch.pendingDocItems !== undefined) {
    upd.pending_doc_items = patch.pendingDocItems
  }
  // hasPhoneBox: แก้ค่ากล่องโทรศัพท์หลังสร้างสัญญา — แก้เฉพาะ has_phone_box ไม่แตะ phone_box_received/ฯลฯ
  if (patch.hasPhoneBox !== undefined) {
    upd.has_phone_box = patch.hasPhoneBox
  }
  if (Object.keys(upd).length === 0) return // ไม่มีอะไรให้อัปเดต
  const { error } = await supabase.from('contracts').update(upd).eq('id', contractId)
  if (error) throw error
}

/** ดึงวันหยุดราชการทั้งหมดจาก public_holidays → Set<'YYYY-MM-DD'>
 *  mock mode: return empty Set (UI treat ทุกวันเป็น weekday — acceptable degrade)
 */
export async function getPublicHolidays(): Promise<Set<string>> {
  if (!supabase) return new Set<string>()
  const { data, error } = await supabase.from('public_holidays').select('date')
  if (error) throw error
  return new Set<string>((data ?? []).map((r: { date: string }) => String(r.date)))
}

// ---------- ESCALATE list (Wave 1B) ----------

/**
 * สัญญาที่อยู่ในสถานะ ESCALATE:
 *   totalAttempts ≥ 10 AND successfulAttempts = 0 ภายใน 90 วันย้อนหลัง
 *   (successfulAttempts = result IN ('contacted','promised','paid','returned','other')
 *    ไม่นับ 'no_answer', 'refused', หรือ null — ตรงกับ v_follow_up_stats_90d ใน 0020)
 *
 * สำหรับ Exec Dashboard widget — admin sees all (contracts RLS is_admin() → true)
 * จำกัด 100 rows เรียงตาม outstanding desc (penalty_due), daysLate desc
 */
export interface EscalateContract {
  contractId: string
  contractNo: string
  customerName: string
  grade: ContractGrade | null
  outstanding: number     // penalty_due — ใช้แสดงผล UI (display เหมือนเดิม)
  estOutstanding: number  // monthly_payment × remaining_installments — ใช้ sort (0024)
  daysLate: number
  shopName: string
  totalAttempts: number
}

export async function getEscalateContracts(): Promise<EscalateContract[]> {
  if (!supabase) return []

  // Step 1: ดึง aggregate จาก v_follow_up_stats_90d (SQL GROUP BY ใน DB — ไม่มี PostgREST row-cap)
  // successfulAttempts นิยาม: result ∈ {contacted, promised, paid, returned, other} — ดูนิยามใน view
  // PostgREST row-cap ปัญหา: raw follow_ups 90 วัน อาจเกิน default 1000 rows;
  //   aggregate view return N rows = N distinct contracts ในช่วง 90 วัน — ต่ำกว่า cap มาก
  const { data: statsData, error: statsError } = await supabase
    .from('v_follow_up_stats_90d')
    .select('contract_id, total_attempts, successful_attempts')
    .gte('total_attempts', 10)
    .eq('successful_attempts', 0)
    .range(0, PAGE_CAP)
  if (statsError) throw statsError

  const escalateIds = ((statsData ?? []) as {
    contract_id: string
    total_attempts: number
    successful_attempts: number
  }[]).map((r) => r.contract_id)

  if (escalateIds.length === 0) return []

  // Build lookup map for totalAttempts
  const statsMap = new Map(
    ((statsData ?? []) as { contract_id: string; total_attempts: number }[]).map((r) => [
      r.contract_id,
      r.total_attempts,
    ]),
  )

  // Step 2: ดึง status + details จาก v_contract_status สำหรับ ids เหล่านั้น
  // filter status='active' — ESCALATE ใช้กับสัญญาที่ยังมีผลเท่านั้น
  // sort: est_outstanding desc (0024), secondary days_late desc — top 100 rows
  // est_outstanding = monthly_payment × remaining_installments (สะท้อนภาระหนี้จริง)
  // penalty_due ยังดึงมาเพื่อ display (outstanding field ใน UI ยังใช้ penalty_due ตามเดิม)
  const { data: statusData, error: statusError } = await supabase
    .from('v_contract_status')
    .select('contract_id, contract_no, customer_name, shop_name, days_late, penalty_due, grade, est_outstanding')
    .eq('status', 'active')
    .in('contract_id', escalateIds)
    .order('est_outstanding', { ascending: false })
    .order('days_late', { ascending: false })
    .limit(100)
  if (statusError) throw statusError

  return ((statusData ?? []) as {
    contract_id: string
    contract_no: string
    customer_name: string
    shop_name: string | null
    days_late: number
    penalty_due: number
    est_outstanding: number
    grade: string | null
  }[]).map((r) => ({
    contractId: r.contract_id,
    contractNo: r.contract_no,
    customerName: r.customer_name,
    grade: (r.grade ?? null) as ContractGrade | null,
    outstanding: Number(r.penalty_due),
    estOutstanding: Number(r.est_outstanding),
    daysLate: r.days_late,
    shopName: r.shop_name ?? '-',
    totalAttempts: statsMap.get(r.contract_id) ?? 0,
  }))
}

// ---------- Customer Aggregate (หน้า /customer/:contractId) ----------

/**
 * ข้อมูลครบของลูกค้า 1 คน รวมทุกสัญญาที่เขามี
 * ระบุตัวลูกค้าด้วย contractId (reference) → ดึง national_id → หาสัญญาทั้งหมด
 */
export interface CustomerContractItem {
  contractId: string
  contractNo: string
  shopId: string | null
  shopName: string | null
  deviceModel: string                   // "iPhone 15 Pro 256GB"
  status: ContractStatus | string       // ค่าจาก DB: active | closed | returned | returned_closed | online
  monthlyPayment: number
  termMonths: number
  remainingInstallments: number
  paidInstallments: number              // termMonths - remainingInstallments
  outstanding: number                   // sum(amount - paid_amount) งวดที่ยังไม่ปิด
  penaltyDue: number
  daysLate: number
  bucket: string
  createdAt: string
}

export interface CustomerAggregate {
  // ข้อมูลตัวตนลูกค้า (snapshot จาก contract ตัวอ้างอิง)
  customerName: string
  nationalId: string | null
  phone: string | null
  phoneAlt1: string | null
  phoneAlt2: string | null

  // รายชื่อสัญญาทุกอันของลูกค้านี้
  contracts: CustomerContractItem[]

  // aggregate
  totalContracts: number
  totalOutstanding: number    // sum outstanding เฉพาะ status='active'
  totalPenalty: number        // sum penaltyDue เฉพาะ status='active'
  activeContracts: number     // count(status='active')
  closedContracts: number     // count(status ≠ 'active')
}

// row types สำหรับ query ภายใน
interface CustomerContractBaseRow {
  id: string
  contract_no: string
  shop_id: string | null
  model: string | null
  storage: string | null
  status: string
  monthly_payment: number | null
  term_months: number | null
  created_at: string
}

interface ShopsBasicRow {
  id: string
  name: string
}

interface AggStatusRow {
  contract_id: string
  remaining_installments: number
  penalty_due: number
  days_late: number
  bucket: string
}

interface AggInstallmentRow {
  contract_id: string
  amount: number
  paid_amount: number | null
}

/**
 * ดึงข้อมูลครบของลูกค้า 1 คน โดยใช้ contractId เป็น reference
 * Logic: หา national_id จาก reference contract → query สัญญาทั้งหมดของลูกค้า
 * Fallback: ถ้า national_id ว่าง → ใช้ customer_name + phone แทน
 * @returns null ถ้าไม่พบ contract ที่อ้างอิง
 */
export async function getCustomerAggregate(referenceContractId: string): Promise<CustomerAggregate | null> {
  if (!supabase) return null

  // Step 1: ดึงข้อมูลตัวตนลูกค้าจาก reference contract
  const { data: refData, error: refErr } = await supabase
    .from('contracts')
    .select('customer_name, national_id, phone, phone_alt1, phone_alt2')
    .eq('id', referenceContractId)
    .maybeSingle()
  if (refErr) throw refErr
  if (!refData) return null

  const customerName: string = refData.customer_name as string
  const nationalId: string | null = (refData.national_id as string | null) || null  // coerce '' → null
  const phone: string | null = (refData.phone as string | null) || null
  const phoneAlt1: string | null = (refData.phone_alt1 as string | null) || null
  const phoneAlt2: string | null = (refData.phone_alt2 as string | null) || null

  // Step 2: ดึง contract ทุกอันของลูกค้า (รวม closed/returned ด้วย)
  // ขับด้วย contracts ไม่ใช่ v_contract_status เพราะ view อาจไม่มีแถวสำหรับ closed contracts
  //
  // Fix D: ถ้าไม่มี national_id และไม่มี phone → ไม่ match ด้วยชื่อเดี่ยว เพราะชื่อซ้ำ merge ผิด
  // Pete ต้องเพิ่มข้อมูล national_id หรือ phone ย้อนหลังก่อนใช้ Customer 360 ได้ถูกต้อง
  if (!nationalId && !phone) {
    console.warn(
      `[getCustomerAggregate] contract ${referenceContractId}: ไม่มี national_id และ phone — ` +
      'ไม่สามารถระบุลูกค้าเดี่ยวได้ คืน empty aggregate เพื่อกันชื่อซ้ำโดนรวมผิด'
    )
    return {
      customerName,
      nationalId,
      phone,
      phoneAlt1,
      phoneAlt2,
      contracts: [],
      totalContracts: 0,
      totalOutstanding: 0,
      totalPenalty: 0,
      activeContracts: 0,
      closedContracts: 0,
    }
  }

  let contractQuery = supabase
    .from('contracts')
    .select('id, contract_no, shop_id, model, storage, status, monthly_payment, term_months, created_at')

  if (nationalId) {
    contractQuery = contractQuery.eq('national_id', nationalId)
  } else {
    // phone ต้องมีถึงจะถึงบรรทัดนี้ (guard ข้างบนกัน !nationalId && !phone แล้ว)
    contractQuery = contractQuery.eq('customer_name', customerName).eq('phone', phone!)
  }

  contractQuery = contractQuery.order('created_at', { ascending: false })
  const { data: contractData, error: contractErr } = await contractQuery
  if (contractErr) throw contractErr

  const baseContracts = (contractData ?? []) as CustomerContractBaseRow[]
  if (baseContracts.length === 0) {
    // fallback: ถ้า national_id หาไม่เจอ (edge case — ส่งแค่ reference contract เดียว)
    return {
      customerName,
      nationalId,
      phone,
      phoneAlt1,
      phoneAlt2,
      contracts: [],
      totalContracts: 0,
      totalOutstanding: 0,
      totalPenalty: 0,
      activeContracts: 0,
      closedContracts: 0,
    }
  }

  const ids = baseContracts.map((c) => c.id)

  // Step 3: ดึง status aggregate จาก v_contract_status (left-join semantics: missing row → defaults)
  const { data: statusData, error: statusErr } = await supabase
    .from('v_contract_status')
    .select('contract_id, remaining_installments, penalty_due, days_late, bucket')
    .in('contract_id', ids)
  if (statusErr) throw statusErr

  const statusMap = new Map<string, AggStatusRow>()
  for (const r of (statusData ?? []) as AggStatusRow[]) {
    statusMap.set(r.contract_id, r)
  }

  // Step 4: ดึง installments ที่ยังไม่ปิด (paid_at IS NULL) → คำนวณ outstanding per contract
  const { data: instData, error: instErr } = await supabase
    .from('installments')
    .select('contract_id, amount, paid_amount')
    .in('contract_id', ids)
    .is('paid_at', null)
  if (instErr) throw instErr

  const outstandingMap = new Map<string, number>()
  for (const inst of (instData ?? []) as AggInstallmentRow[]) {
    const prev = outstandingMap.get(inst.contract_id) ?? 0
    const rowDue = Number(inst.amount) - Number(inst.paid_amount ?? 0)
    outstandingMap.set(inst.contract_id, prev + Math.max(0, rowDue))
  }

  // Step 5: ดึง shop names จาก shops_basic (id, name เท่านั้น — ไม่มี RLS กัน freelancer)
  const shopIds = [...new Set(baseContracts.map((c) => c.shop_id).filter((id): id is string => id != null))]
  const shopNameMap = new Map<string, string>()
  if (shopIds.length > 0) {
    const { data: shopData, error: shopErr } = await supabase
      .from('shops_basic')
      .select('id, name')
      .in('id', shopIds)
    if (shopErr) throw shopErr
    for (const s of (shopData ?? []) as ShopsBasicRow[]) {
      shopNameMap.set(s.id, s.name)
    }
  }

  // Step 6: รวมเป็น CustomerContractItem[]
  const contracts: CustomerContractItem[] = baseContracts.map((c): CustomerContractItem => {
    const st = statusMap.get(c.id)
    const termMonths = Number(c.term_months ?? 0)
    const remainingInstallments = st?.remaining_installments ?? 0
    const paidInstallments = Math.max(0, termMonths - remainingInstallments)
    const modelParts = [c.model, c.storage].filter(Boolean)
    return {
      contractId: c.id,
      contractNo: c.contract_no,
      shopId: c.shop_id ?? null,
      shopName: c.shop_id ? (shopNameMap.get(c.shop_id) ?? null) : null,
      deviceModel: modelParts.join(' '),
      status: c.status,
      monthlyPayment: Number(c.monthly_payment ?? 0),
      termMonths,
      remainingInstallments,
      paidInstallments,
      outstanding: outstandingMap.get(c.id) ?? 0,
      penaltyDue: Number(st?.penalty_due ?? 0),
      daysLate: st?.days_late ?? 0,
      bucket: st?.bucket ?? 'normal',
      createdAt: c.created_at,
    }
  })

  // Step 7: Aggregate — เฉพาะ active contracts สำหรับ totalOutstanding + totalPenalty
  let totalOutstanding = 0
  let totalPenalty = 0
  let activeContracts = 0
  let closedContracts = 0
  for (const c of contracts) {
    if (c.status === 'active') {
      totalOutstanding += c.outstanding
      totalPenalty += c.penaltyDue
      activeContracts++
    } else {
      closedContracts++
    }
  }

  return {
    customerName,
    nationalId,
    phone,
    phoneAlt1,
    phoneAlt2,
    contracts,
    totalContracts: contracts.length,
    totalOutstanding,
    totalPenalty,
    activeContracts,
    closedContracts,
  }
}

// ---------- Freelancer Performance Dashboard (Wave 1B) ----------

/** ข้อมูล performance ต่อ freelancer ใน 30 วัน (สำหรับ /performance-dashboard) */
export interface FreelancerPerformanceRow {
  authorId: string
  fullName: string
  // email ไม่พร้อมใช้จาก frontend client (auth.users ไม่ expose ผ่าน PostgREST)
  // ถ้า Pete ต้องการ email → ต้องดึงผ่าน Edge Function admin-users ใน wave ถัดไป
  email: null
  assignedGrades: string[]           // grade ที่ active (ended_at IS NULL)
  totalAttempts: number              // รวมทุก grade
  successfulAttempts: number
  promiseCount: number
  resolutionCount: number
  uniqueContracts: number
  lastActivityAt: string | null
  // Wave 2: attribution metrics (real values — ไม่ใช่ placeholder 0)
  promiseKeptCount: number           // row count ของ promises ที่มี payment ภายใน 7 วัน
  promiseKeptCredit: number          // credit รวม (split-equally: 1/N per co-promise group)
  promisesTotal: number              // promises ทั้งหมดที่มี next_follow_up_at ใน 30 วัน (denominator)
  escalateContracts: number          // สัญญาในเกรดที่ assigned + ESCALATE tier
  totalAssigned: number              // สัญญา active ทั้งหมดในเกรดที่ assigned
  byGrade: Array<{
    grade: 'A' | 'B' | 'C' | 'D' | 'E'
    totalAttempts: number
    successfulAttempts: number
    promiseCount: number
    resolutionCount: number
    uniqueContracts: number
  }>
}

interface PerfViewRow {
  author_id: string
  current_grade: string | null
  total_attempts: number
  successful_attempts: number
  promise_count: number
  resolution_count: number
  unique_contracts: number
  last_activity_at: string | null
}

interface FgaRow {
  freelancer_id: string
  grade: string
}

interface FreelancerProfileRow {
  id: string
  full_name: string | null
}

interface AttributionRow {
  author_id: string
  promises_kept_count: number
  promises_kept_credit: number
  promises_total: number
}

interface GradeCountRow {
  current_grade: string
  contract_count: number
}

interface GradeEscalateRow {
  current_grade: string
  escalate_count: number
}

/**
 * ดึง performance ของ freelancer ทุกคนใน p_days วันล่าสุด (default 30)
 * ใช้กับ admin + staff (fga_read policy ใน 0022 อนุญาต staff อ่าน grade assignments ทุกคน)
 * Freelancer ที่ไม่มี follow_up ใน window → ยัง list (all-zero row)
 * @param days จำนวนวันย้อนหลัง (1–90, default 30)
 */
export async function getFreelancerPerformance(days: number = 30): Promise<FreelancerPerformanceRow[]> {
  if (!supabase) return []

  // Step 1: ดึง active freelancer profiles (role='freelancer', active=true)
  // profiles_read_staff_view ใน 0022 อนุญาต staff อ่าน role='freelancer' rows
  const { data: profileData, error: profileErr } = await supabase
    .from('profiles')
    .select('id, full_name')
    .eq('role', 'freelancer')
    .eq('active', true)
    .range(0, PAGE_CAP)
  if (profileErr) throw profileErr

  const freelancers = (profileData ?? []) as FreelancerProfileRow[]
  if (freelancers.length === 0) return []

  const freelancerIds = freelancers.map((p) => p.id)

  // Step 2: ดึง grade assignments ที่ active (ended_at IS NULL) ของ freelancer ทุกคน
  // fga_read ใน 0022 อนุญาต admin + staff + freelancer ตัวเอง
  const { data: fgaData, error: fgaErr } = await supabase
    .from('freelancer_grade_assignments')
    .select('freelancer_id, grade')
    .in('freelancer_id', freelancerIds)
    .is('ended_at', null)
    .range(0, PAGE_CAP)
  if (fgaErr) throw fgaErr

  // build grade map: freelancer_id → string[]
  const gradeMap = new Map<string, string[]>()
  for (const row of (fgaData ?? []) as FgaRow[]) {
    const existing = gradeMap.get(row.freelancer_id) ?? []
    existing.push(row.grade)
    gradeMap.set(row.freelancer_id, existing)
  }

  // Step 3: ดึง performance aggregate ผ่าน get_freelancer_perf(p_days)
  // function security_invoker → RLS ของ follow_ups + contracts apply ตาม caller's role
  // admin/staff เห็นทุก row; freelancer เห็นเฉพาะ in-grade contracts
  const { data: perfData, error: perfErr } = await supabase
    .rpc('get_freelancer_perf', { p_days: days })
  if (perfErr) throw perfErr

  // Client-side merge: aggregate per author_id + build byGrade array
  type ByGradeAgg = {
    grade: 'A' | 'B' | 'C' | 'D' | 'E'
    totalAttempts: number
    successfulAttempts: number
    promiseCount: number
    resolutionCount: number
    uniqueContracts: number
  }
  type Agg = {
    totalAttempts: number
    successfulAttempts: number
    promiseCount: number
    resolutionCount: number
    uniqueContracts: number
    lastActivityAt: string | null
    byGrade: ByGradeAgg[]
  }

  const aggMap = new Map<string, Agg>()
  for (const row of (perfData ?? []) as PerfViewRow[]) {
    const agg = aggMap.get(row.author_id) ?? {
      totalAttempts: 0,
      successfulAttempts: 0,
      promiseCount: 0,
      resolutionCount: 0,
      uniqueContracts: 0,
      lastActivityAt: null,
      byGrade: [],
    }
    agg.totalAttempts += row.total_attempts
    agg.successfulAttempts += row.successful_attempts
    agg.promiseCount += row.promise_count
    agg.resolutionCount += row.resolution_count
    agg.uniqueContracts += row.unique_contracts
    // lastActivityAt: เก็บค่าล่าสุดสุด (max)
    if (
      row.last_activity_at != null &&
      (agg.lastActivityAt == null || row.last_activity_at > agg.lastActivityAt)
    ) {
      agg.lastActivityAt = row.last_activity_at
    }
    if (row.current_grade != null) {
      agg.byGrade.push({
        grade: row.current_grade as 'A' | 'B' | 'C' | 'D' | 'E',
        totalAttempts: row.total_attempts,
        successfulAttempts: row.successful_attempts,
        promiseCount: row.promise_count,
        resolutionCount: row.resolution_count,
        uniqueContracts: row.unique_contracts,
      })
    }
    aggMap.set(row.author_id, agg)
  }

  // Step 4: ดึง promise attribution ผ่าน get_promise_attribution(p_days) (Wave 2)
  // promises_kept_count = raw row count ที่ kept=true
  // promises_kept_credit = split-equally credit sum (1/N per co-promise group, payment-anchored 5-day)
  // promises_total = denominator: promises ทั้งหมดที่มี next_follow_up_at ใน p_days วัน
  const { data: attrData, error: attrErr } = await supabase
    .rpc('get_promise_attribution', { p_days: days })
  if (attrErr) throw attrErr

  // build attribution map: author_id → AttributionRow
  const attrMap = new Map<string, AttributionRow>()
  for (const row of (attrData ?? []) as AttributionRow[]) {
    attrMap.set(row.author_id, row)
  }

  // Step 5: ดึง grade → active contract count จาก v_grade_active_counts (cap-safe: ≤6 rows)
  // ใช้สำหรับคำนวณ totalAssigned per freelancer = sum counts ในเกรดที่ assigned
  const { data: gradeCountData, error: gradeCountErr } = await supabase
    .from('v_grade_active_counts')
    .select('current_grade, contract_count')
  if (gradeCountErr) throw gradeCountErr

  const gradeCountMap = new Map<string, number>()
  for (const row of (gradeCountData ?? []) as GradeCountRow[]) {
    gradeCountMap.set(row.current_grade, row.contract_count)
  }

  // Step 6: ดึง grade → escalate contract count จาก v_grade_escalate_counts (cap-safe: ≤6 rows)
  // ใช้สำหรับคำนวณ escalateContracts per freelancer = sum escalate_count ในเกรดที่ assigned
  const { data: escCountData, error: escCountErr } = await supabase
    .from('v_grade_escalate_counts')
    .select('current_grade, escalate_count')
  if (escCountErr) throw escCountErr

  const escCountMap = new Map<string, number>()
  for (const row of (escCountData ?? []) as GradeEscalateRow[]) {
    escCountMap.set(row.current_grade, row.escalate_count)
  }

  // รวม freelancer ทุกคน — รวมถึงคนที่ไม่มี follow_up ใน 30 วัน (all-zero)
  return freelancers.map((p): FreelancerPerformanceRow => {
    const agg = aggMap.get(p.id)
    const attr = attrMap.get(p.id)
    const assignedGrades = gradeMap.get(p.id) ?? []

    // totalAssigned = sum of active contract counts for each assigned grade
    const totalAssigned = assignedGrades.reduce(
      (sum, g) => sum + (gradeCountMap.get(g) ?? 0),
      0,
    )

    // escalateContracts = sum of escalate counts for each assigned grade
    const escalateContracts = assignedGrades.reduce(
      (sum, g) => sum + (escCountMap.get(g) ?? 0),
      0,
    )

    return {
      authorId: p.id,
      fullName: p.full_name ?? '-',
      email: null,
      assignedGrades,
      totalAttempts: agg?.totalAttempts ?? 0,
      successfulAttempts: agg?.successfulAttempts ?? 0,
      promiseCount: agg?.promiseCount ?? 0,
      resolutionCount: agg?.resolutionCount ?? 0,
      uniqueContracts: agg?.uniqueContracts ?? 0,
      lastActivityAt: agg?.lastActivityAt ?? null,
      // Wave 2 attribution — real values
      promiseKeptCount: attr?.promises_kept_count ?? 0,
      promiseKeptCredit: attr ? Number(attr.promises_kept_credit) : 0,
      promisesTotal: attr?.promises_total ?? 0,
      escalateContracts,
      totalAssigned,
      byGrade: agg?.byGrade ?? [],
    }
  })
}

// ---------- Collector Scorecard (migration 0046) ----------

/** 1 row ต่อ freelancer ในตาราง scorecard (รวมทุกเกรด + byGrade drill-down) */
export interface CollectorScorecardRow {
  authorId: string
  fullName: string
  assignedGrades: string[]           // จาก freelancer_grade_assignments (active, ended_at IS NULL)
  calls: number                      // (b) จำนวนสายโทร phone ในช่วง
  uniqueContracts: number            // (c) distinct สัญญา — label UI "สัญญาที่ดูแล"
  totalAttempts: number
  successfulAttempts: number
  collectedBaht: number              // (a) last-touch attribution
  bahtPerCall: number | null         // client: collectedBaht / calls, null ถ้า calls=0
  contactRate: number | null         // client: successful/total ×100, null ถ้า total=0
  lastActivityAt: string | null
  byGrade: Array<{
    grade: 'A' | 'B' | 'C' | 'D' | 'E'
    calls: number
    uniqueContracts: number
    totalAttempts: number
    successfulAttempts: number
    collectedBaht: number
    bahtPerCall: number | null
    contactRate: number | null
  }>
}

export interface CollectorScorecardResult {
  rows: CollectorScorecardRow[]
  uncreditedBaht: number             // จาก get_uncredited_collected — ยอด pay ที่ไม่มีสายนำ
}

/** 1 row ต่อ (author_id × current_grade) จาก RPC get_collector_scorecard */
interface ScorecardViewRow {
  author_id: string
  current_grade: string | null
  calls: number
  unique_contracts: number
  total_attempts: number
  successful_attempts: number
  collected_baht: number | string    // numeric จาก PostgREST → Number(...)
  last_activity_at: string | null
}

/** ฿/call — guard หารศูนย์ → null (N/A) */
function bahtPerCall(collected: number, calls: number): number | null {
  return calls > 0 ? collected / calls : null
}

/** contact-rate % — guard หารศูนย์ → null (N/A) */
function contactRate(successful: number, total: number): number | null {
  return total > 0 ? (successful / total) * 100 : null
}

/**
 * Collector Scorecard — ยอดเก็บ last-touch attribution ต่อ freelancer ตามช่วงวัน [start, end]
 * ใช้กับหน้า admin + staff (RPC guard ด้วย is_admin()/is_staff() — freelancer เรียกได้ 0 rows)
 * Freelancer active ทุกคน list เสมอ (คนไม่มี activity = all-zero row)
 * ครีม: คืน byGrade[] (per-grade drill-down ในช่วงเดียวกัน — ตาม pattern getFreelancerPerformance)
 * @param start วันเริ่ม 'YYYY-MM-DD' (inclusive)
 * @param end   วันสุดท้าย 'YYYY-MM-DD' (inclusive)
 */
export async function getCollectorScorecard(
  start: string,
  end: string,
): Promise<CollectorScorecardResult> {
  if (!supabase) return { rows: [], uncreditedBaht: 0 }

  // Step 1: ดึง active freelancer profiles (role='freelancer', active=true) — reuse pattern getFreelancerPerformance
  const { data: profileData, error: profileErr } = await supabase
    .from('profiles')
    .select('id, full_name')
    .eq('role', 'freelancer')
    .eq('active', true)
    .range(0, PAGE_CAP)
  if (profileErr) throw profileErr

  const freelancers = (profileData ?? []) as FreelancerProfileRow[]
  if (freelancers.length === 0) return { rows: [], uncreditedBaht: 0 }

  const freelancerIds = freelancers.map((p) => p.id)

  // Step 2: ดึง grade assignments ที่ active (ended_at IS NULL)
  const { data: fgaData, error: fgaErr } = await supabase
    .from('freelancer_grade_assignments')
    .select('freelancer_id, grade')
    .in('freelancer_id', freelancerIds)
    .is('ended_at', null)
    .range(0, PAGE_CAP)
  if (fgaErr) throw fgaErr

  const gradeMap = new Map<string, string[]>()
  for (const row of (fgaData ?? []) as FgaRow[]) {
    const existing = gradeMap.get(row.freelancer_id) ?? []
    existing.push(row.grade)
    gradeMap.set(row.freelancer_id, existing)
  }

  // Step 3: ดึง scorecard aggregate ผ่าน get_collector_scorecard(p_start, p_end)
  const { data: scData, error: scErr } = await supabase
    .rpc('get_collector_scorecard', { p_start: start, p_end: end })
  if (scErr) throw scErr

  // Step 4: ดึงยอดที่ไม่มีสายนำ (uncredited) ผ่าน get_uncredited_collected(p_start, p_end)
  const { data: uncData, error: uncErr } = await supabase
    .rpc('get_uncredited_collected', { p_start: start, p_end: end })
  if (uncErr) throw uncErr
  const uncreditedBaht = Number(uncData ?? 0)

  // Client-side merge: aggregate per author_id (sum across grades) + build byGrade array
  type ByGradeAgg = CollectorScorecardRow['byGrade'][number]
  type Agg = {
    calls: number
    uniqueContracts: number
    totalAttempts: number
    successfulAttempts: number
    collectedBaht: number
    lastActivityAt: string | null
    byGrade: ByGradeAgg[]
  }

  const aggMap = new Map<string, Agg>()
  for (const row of (scData ?? []) as ScorecardViewRow[]) {
    const collected = Number(row.collected_baht)
    const agg = aggMap.get(row.author_id) ?? {
      calls: 0,
      uniqueContracts: 0,
      totalAttempts: 0,
      successfulAttempts: 0,
      collectedBaht: 0,
      lastActivityAt: null,
      byGrade: [],
    }
    agg.calls += row.calls
    agg.uniqueContracts += row.unique_contracts
    agg.totalAttempts += row.total_attempts
    agg.successfulAttempts += row.successful_attempts
    agg.collectedBaht += collected
    if (
      row.last_activity_at != null &&
      (agg.lastActivityAt == null || row.last_activity_at > agg.lastActivityAt)
    ) {
      agg.lastActivityAt = row.last_activity_at
    }
    // byGrade: เฉพาะสัญญาที่มีเกรด (null = ไม่มีเกรด → นับใน total เท่านั้น)
    if (row.current_grade != null) {
      agg.byGrade.push({
        grade: row.current_grade as 'A' | 'B' | 'C' | 'D' | 'E',
        calls: row.calls,
        uniqueContracts: row.unique_contracts,
        totalAttempts: row.total_attempts,
        successfulAttempts: row.successful_attempts,
        collectedBaht: collected,
        bahtPerCall: bahtPerCall(collected, row.calls),
        contactRate: contactRate(row.successful_attempts, row.total_attempts),
      })
    }
    aggMap.set(row.author_id, agg)
  }

  // รวม freelancer ทุกคน — รวมถึงคนที่ไม่มี activity ในช่วง (all-zero)
  const rows = freelancers.map((p): CollectorScorecardRow => {
    const agg = aggMap.get(p.id)
    const calls = agg?.calls ?? 0
    const collectedBaht = agg?.collectedBaht ?? 0
    const totalAttempts = agg?.totalAttempts ?? 0
    const successfulAttempts = agg?.successfulAttempts ?? 0
    return {
      authorId: p.id,
      fullName: p.full_name ?? '-',
      assignedGrades: gradeMap.get(p.id) ?? [],
      calls,
      uniqueContracts: agg?.uniqueContracts ?? 0,
      totalAttempts,
      successfulAttempts,
      collectedBaht,
      bahtPerCall: bahtPerCall(collectedBaht, calls),
      contactRate: contactRate(successfulAttempts, totalAttempts),
      lastActivityAt: agg?.lastActivityAt ?? null,
      byGrade: agg?.byGrade ?? [],
    }
  })

  return { rows, uncreditedBaht }
}

// ---------- Collector call & promise outcomes (migration 0068) ----------

/** 1 row ต่อ author จาก RPC get_collector_call_outcomes — numeric/int มาเป็น number|string จาก PostgREST */
interface CallOutcomeViewRow {
  author_id: string
  author_name: string | null
  cases_followed: number | string
  cases_reached: number | string
  cases_no_answer: number | string
  cases_unreachable: number | string
  promises_made: number | string
  promises_kept: number | string
  promises_broken: number | string
  promises_pending: number | string
}

/**
 * Collector call & promise outcomes — ผลการโทร + ผลการนัดชำระ ต่อคนติดตามหนี้ ตามช่วงวัน [start, end]
 * ใช้กับหน้า /staff-performance — รองรับภาพรวมทีม (sum ทุก row) + รายคน (1 row ต่อ author)
 * RPC guard ด้วย is_admin()/is_staff() — freelancer/anon เรียกได้ 0 rows
 * @param start วันเริ่ม 'YYYY-MM-DD' (inclusive)
 * @param end   วันสุดท้าย 'YYYY-MM-DD' (inclusive)
 */
export async function getCollectorCallOutcomes(
  start: string,
  end: string,
): Promise<CollectorCallOutcome[]> {
  if (!supabase) return []

  const { data, error } = await supabase
    .rpc('get_collector_call_outcomes', { p_start: start, p_end: end })
  if (error) throw error

  return ((data ?? []) as CallOutcomeViewRow[]).map((row) => ({
    authorId: row.author_id,
    authorName: row.author_name ?? '-',
    casesFollowed: Number(row.cases_followed),
    casesReached: Number(row.cases_reached),
    casesNoAnswer: Number(row.cases_no_answer),
    casesUnreachable: Number(row.cases_unreachable),
    promisesMade: Number(row.promises_made),
    promisesKept: Number(row.promises_kept),
    promisesBroken: Number(row.promises_broken),
    promisesPending: Number(row.promises_pending),
  }))
}

// ---------- My Scorecard — self-only (migration 0048) ----------

/** 1 grade row จาก RPC get_my_collector_scorecard */
interface MyScorecardViewRow {
  author_id: string
  current_grade: string | null
  calls: number
  unique_contracts: number
  total_attempts: number
  successful_attempts: number
  collected_baht: string | number
  last_activity_at: string | null
}

/** byGrade entry — ตาม shape เดิมของ CollectorScorecardRow['byGrade'][number] */
export interface MyScorecardGradeRow {
  grade: 'A' | 'B' | 'C' | 'D' | 'E'
  calls: number
  uniqueContracts: number
  totalAttempts: number
  successfulAttempts: number
  collectedBaht: number
  bahtPerCall: number | null
  contactRate: number | null
}

/** totals รวมทุก grade (รวม null-grade) */
export interface MyScorecardTotals {
  collectedBaht: number
  calls: number
  uniqueContracts: number
  totalAttempts: number
  successfulAttempts: number
  bahtPerCall: number | null
  contactRate: number | null
}

export interface MyScorecardResult {
  byGrade: MyScorecardGradeRow[]
  totals: MyScorecardTotals
}

/**
 * ผลงานของฉัน — self-only scorecard สำหรับ freelancer (RPC 0048)
 * คืน byGrade[] (per-grade) + totals (รวมทุก grade รวม null-grade)
 * ไม่ต้องการ role guard — RPC filter ด้วย auth.uid() แล้ว
 * @param start วันเริ่ม 'YYYY-MM-DD' (inclusive)
 * @param end   วันสุดท้าย 'YYYY-MM-DD' (inclusive)
 */
export async function getMyScorecard(
  start: string,
  end: string,
): Promise<MyScorecardResult> {
  const empty: MyScorecardResult = {
    byGrade: [],
    totals: {
      collectedBaht: 0,
      calls: 0,
      uniqueContracts: 0,
      totalAttempts: 0,
      successfulAttempts: 0,
      bahtPerCall: null,
      contactRate: null,
    },
  }
  if (!supabase) return empty

  const { data, error } = await supabase
    .rpc('get_my_collector_scorecard', { p_start: start, p_end: end })
  if (error) throw error

  // Aggregate — totals รวมทุก row (incl. null-grade); byGrade เฉพาะ grade ที่รู้จัก
  let tCalls = 0
  let tUniqueContracts = 0
  let tTotalAttempts = 0
  let tSuccessfulAttempts = 0
  let tCollectedBaht = 0

  const byGrade: MyScorecardGradeRow[] = []

  for (const row of (data ?? []) as MyScorecardViewRow[]) {
    const collected = Number(row.collected_baht)
    tCalls += row.calls
    tUniqueContracts += row.unique_contracts
    tTotalAttempts += row.total_attempts
    tSuccessfulAttempts += row.successful_attempts
    tCollectedBaht += collected

    if (row.current_grade != null) {
      byGrade.push({
        grade: row.current_grade as 'A' | 'B' | 'C' | 'D' | 'E',
        calls: row.calls,
        uniqueContracts: row.unique_contracts,
        totalAttempts: row.total_attempts,
        successfulAttempts: row.successful_attempts,
        collectedBaht: collected,
        bahtPerCall: bahtPerCall(collected, row.calls),
        contactRate: contactRate(row.successful_attempts, row.total_attempts),
      })
    }
  }

  return {
    byGrade,
    totals: {
      collectedBaht: tCollectedBaht,
      calls: tCalls,
      uniqueContracts: tUniqueContracts,
      totalAttempts: tTotalAttempts,
      successfulAttempts: tSuccessfulAttempts,
      bahtPerCall: bahtPerCall(tCollectedBaht, tCalls),
      contactRate: contactRate(tSuccessfulAttempts, tTotalAttempts),
    },
  }
}

// ---------- Grade Mobility (migration 0030) ----------

interface GradeMonthlyChangeRow {
  month_bkt: string
  change_type: GradeChangeType
  cnt: number
}

/**
 * ดึงข้อมูลการเปลี่ยนแปลงเกรดรายเดือน จาก view v_grade_monthly_changes
 * security_invoker=on — admin/staff/executive เห็น, freelancer เห็น 0 rows (RLS contracts)
 * @param monthsBack จำนวนเดือนย้อนหลัง (default 12)
 */
export async function getGradeChangesMonthly(monthsBack = 12): Promise<GradeMonthlyChange[]> {
  if (!supabase) return []
  const since = new Date()
  since.setMonth(since.getMonth() - monthsBack)
  since.setDate(1)
  since.setHours(0, 0, 0, 0)
  const { data, error } = await supabase
    .from('v_grade_monthly_changes')
    .select('month_bkt, change_type, cnt')
    .gte('month_bkt', since.toISOString())
    .order('month_bkt', { ascending: false })
    .range(0, PAGE_CAP)
  if (error) throw error
  return ((data ?? []) as GradeMonthlyChangeRow[]).map((r) => ({
    monthBkt: r.month_bkt.slice(0, 10), // truncate to YYYY-MM-DD
    changeType: r.change_type,
    cnt: Number(r.cnt),
  }))
}

/**
 * นับ contracts ที่ status='active' และมี current_grade (ใช้เป็น denominator ของ Roll/Cure Rate %)
 */
export async function getActiveGradedCount(): Promise<number> {
  if (!supabase) return 0
  const { count, error } = await supabase
    .from('contracts')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active')
    .not('current_grade', 'is', null)
  if (error) throw error
  return count ?? 0
}

// ---------- Overdue Promise Contracts (migration 0029 + 0020) ----------

interface OverduePromiseRow {
  id: string
  contract_no: string
  customer_name: string
  promise_to_pay_date: string
  promised_amount: number | null
  status: string
}

/**
 * ดึงสัญญาที่ผิดนัดจ่าย (promise_to_pay_date < today AND status=active)
 * RLS กรอง scope อัตโนมัติ: freelancer เห็นเฉพาะ in-grade, admin/staff/executive เห็นทุกสัญญา
 * trigger clear_promise_on_pay (0029) ล้าง promise_to_pay_date เมื่อชำระแล้ว → ไม่ต้อง join payment_log
 */
// ---------- Audit Timeline (union ทุก audit source) ----------

// row types สำหรับ query ภายใน — ไม่ export (private ใช้แค่ใน getAuditTimeline)
// type alias สำหรับ Supabase embed ที่อาจ return object หรือ array (ขึ้นกับ cardinality inference)
type ContractsEmbed = { contract_no: string; customer_name: string } | { contract_no: string; customer_name: string }[] | null

interface AuditPaymentRow {
  id: string
  contract_id: string | null
  action: 'pay' | 'edit' | 'cancel'
  amount: number | null
  by_name: string | null
  note: string | null
  created_at: string
  contracts: ContractsEmbed
}

interface AuditGradeRow {
  id: string
  contract_id: string
  old_grade: string | null
  new_grade: string | null
  changed_at: string
  contracts: ContractsEmbed
}

interface AuditSentRow {
  id: string
  contract_no: string
  customer_name: string
  email_sent_at: string | null
  email_sent_by: string | null
  summary_sent_at: string | null
  summary_sent_by: string | null
}

interface AuditFollowUpRow {
  id: string
  contract_id: string
  author_name: string
  follow_up_result: string
  note_text: string
  created_at: string
  contracts: ContractsEmbed
}

interface AuditExtensionRow {
  id: string
  contract_id: string
  ext_type: string
  recorded_by_name: string | null
  created_at: string
  contracts: ContractsEmbed
}

interface AuditDeviceRow {
  id: string
  contract_id: string
  device_status: string | null
  device_status_by: string | null
  device_status_updated_at: string | null
  contracts: ContractsEmbed
}

// row type สำหรับ getDailyAudit — สรุปยอด 2 ขั้น (mig 0075) แยกร้าน/บัญชี คนละคอลัมน์
interface AuditSentTwoStageRow {
  id: string
  contract_no: string
  customer_name: string
  summary_shop_sent_at: string | null
  summary_shop_sent_by: string | null
  summary_accounting_sent_at: string | null
  summary_accounting_sent_by: string | null
}

/**
 * ดึง audit events จากทุก source แล้วรวมเป็น timeline เดียว เรียง created_at desc
 * @param daysBack จำนวนวันย้อนหลัง (default 30)
 * @param limit จำนวน event สูงสุดที่ return (default 200)
 */
export async function getAuditTimeline(daysBack = 30, limit = 200): Promise<AuditEvent[]> {
  if (!supabase) return []

  const since = new Date(Date.now() - daysBack * 86400 * 1000).toISOString()

  // ---- helper: แปลง action ของ payment_log → ข้อความไทย ----
  const paymentActionText = (action: 'pay' | 'edit' | 'cancel', amount: number | null): string => {
    if (action === 'pay') {
      const fmt = amount != null ? amount.toLocaleString('th-TH') + ' ฿' : ''
      return fmt ? `ยืนยันชำระ ${fmt}` : 'ยืนยันชำระ'
    }
    if (action === 'edit') return 'แก้ไขการชำระ'
    return 'ยกเลิกการชำระ'
  }

  // ---- helper: แปล follow_up_result → ข้อความไทย ----
  const followUpResultText = (result: string): string => {
    const map: Record<string, string> = {
      no_answer: 'ไม่รับสาย',
      contacted: 'ติดต่อได้',
      promised: 'สัญญาจะจ่าย',
      refused: 'ปฏิเสธ',
      paid: 'ชำระแล้ว',
      returned: 'คืนเครื่อง',
      other: 'อื่นๆ',
    }
    return map[result] ?? result
  }

  // ---- helper: แปล extension_type → ข้อความไทย ----
  const extTypeText = (extType: string): string => {
    if (extType === 'due_day') return 'เปลี่ยนวันชำระ'
    if (extType === 'months') return 'ขยายงวด'
    if (extType === 'both') return 'เปลี่ยนวันชำระ+ขยายงวด'
    return extType
  }

  // ---- 7 parallel queries ----
  const [
    paymentRes,
    gradeRes,
    emailRes,
    summaryRes,
    followUpRes,
    extensionRes,
    deviceRes,
  ] = await Promise.all([
    // 1. payment_log + join contracts
    supabase
      .from('payment_log')
      .select('id, contract_id, action, amount, by_name, note, created_at, contracts(contract_no, customer_name)')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(limit),

    // 2. contract_grade_history + join contracts
    supabase
      .from('contract_grade_history')
      .select('id, contract_id, old_grade, new_grade, changed_at, contracts(contract_no, customer_name)')
      .gte('changed_at', since)
      .order('changed_at', { ascending: false })
      .limit(limit),

    // 3. contracts ที่ email_sent_at อยู่ใน window
    supabase
      .from('contracts')
      .select('id, contract_no, customer_name, email_sent_at, email_sent_by')
      .gte('email_sent_at', since)
      .not('email_sent_at', 'is', null)
      .order('email_sent_at', { ascending: false })
      .limit(limit),

    // 4. contracts ที่ summary_sent_at อยู่ใน window
    supabase
      .from('contracts')
      .select('id, contract_no, customer_name, summary_sent_at, summary_sent_by')
      .gte('summary_sent_at', since)
      .not('summary_sent_at', 'is', null)
      .order('summary_sent_at', { ascending: false })
      .limit(limit),

    // 5. follow_ups + join contracts (author_name denormalized — ไม่ต้อง join profiles)
    supabase
      .from('follow_ups')
      .select('id, contract_id, author_name, follow_up_result, note_text, created_at, contracts(contract_no, customer_name)')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(limit),

    // 6. contract_extensions + join contracts
    supabase
      .from('contract_extensions')
      .select('id, contract_id, ext_type, recorded_by_name, created_at, contracts(contract_no, customer_name)')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(limit),

    // 7. device_returns ที่ device_status_updated_at อยู่ใน window
    supabase
      .from('device_returns')
      .select('id, contract_id, device_status, device_status_by, device_status_updated_at, contracts(contract_no, customer_name)')
      .gte('device_status_updated_at', since)
      .not('device_status_updated_at', 'is', null)
      .order('device_status_updated_at', { ascending: false })
      .limit(limit),
  ])

  // throw ถ้า query ไหน error
  if (paymentRes.error) throw paymentRes.error
  if (gradeRes.error) throw gradeRes.error
  if (emailRes.error) throw emailRes.error
  if (summaryRes.error) throw summaryRes.error
  if (followUpRes.error) throw followUpRes.error
  if (extensionRes.error) throw extensionRes.error
  if (deviceRes.error) throw deviceRes.error

  const events: AuditEvent[] = []

  // ---- map payment_log ----
  for (const r of (paymentRes.data ?? []) as AuditPaymentRow[]) {
    const c = Array.isArray(r.contracts) ? r.contracts[0] : r.contracts
    events.push({
      id: `payment:${r.id}`,
      eventType: 'payment' as AuditEventType,
      contractId: r.contract_id,
      contractNo: c?.contract_no ?? null,
      customerName: c?.customer_name ?? null,
      actor: r.by_name ?? 'ระบบ',
      action: paymentActionText(r.action, r.amount != null ? Number(r.amount) : null),
      details: r.note ?? null,
      at: r.created_at,
    })
  }

  // ---- map contract_grade_history ----
  for (const r of (gradeRes.data ?? []) as AuditGradeRow[]) {
    const c = Array.isArray(r.contracts) ? r.contracts[0] : r.contracts
    const fromGrade = r.old_grade ?? '-'
    const toGrade = r.new_grade ?? '-'
    events.push({
      id: `grade:${r.id}`,
      eventType: 'grade_change' as AuditEventType,
      contractId: r.contract_id,
      contractNo: c?.contract_no ?? null,
      customerName: c?.customer_name ?? null,
      actor: 'ระบบ',
      action: `เปลี่ยนเกรด ${fromGrade}→${toGrade}`,
      details: null,
      at: r.changed_at,
    })
  }

  // ---- map email_sent events ----
  for (const r of (emailRes.data ?? []) as AuditSentRow[]) {
    if (!r.email_sent_at) continue
    events.push({
      id: `email:${r.id}`,
      eventType: 'email_sent' as AuditEventType,
      contractId: r.id,
      contractNo: r.contract_no,
      customerName: r.customer_name,
      actor: r.email_sent_by ?? 'ระบบ',
      action: 'ส่งอีเมล',
      details: null,
      at: r.email_sent_at,
    })
  }

  // ---- map summary_sent events ----
  for (const r of (summaryRes.data ?? []) as AuditSentRow[]) {
    if (!r.summary_sent_at) continue
    events.push({
      id: `summary:${r.id}`,
      eventType: 'summary_sent' as AuditEventType,
      contractId: r.id,
      contractNo: r.contract_no,
      customerName: r.customer_name,
      actor: r.summary_sent_by ?? 'ระบบ',
      action: 'ส่งสรุปยอด',
      details: null,
      at: r.summary_sent_at,
    })
  }

  // ---- map follow_ups ----
  for (const r of (followUpRes.data ?? []) as AuditFollowUpRow[]) {
    const c = Array.isArray(r.contracts) ? r.contracts[0] : r.contracts
    events.push({
      id: `followup:${r.id}`,
      eventType: 'follow_up' as AuditEventType,
      contractId: r.contract_id,
      contractNo: c?.contract_no ?? null,
      customerName: c?.customer_name ?? null,
      actor: r.author_name || 'ระบบ',
      action: `ติดตาม: ${followUpResultText(r.follow_up_result)}`,
      details: r.note_text || null,
      at: r.created_at,
    })
  }

  // ---- map contract_extensions ----
  for (const r of (extensionRes.data ?? []) as AuditExtensionRow[]) {
    const c = Array.isArray(r.contracts) ? r.contracts[0] : r.contracts
    events.push({
      id: `ext:${r.id}`,
      eventType: 'extension' as AuditEventType,
      contractId: r.contract_id,
      contractNo: c?.contract_no ?? null,
      customerName: c?.customer_name ?? null,
      actor: r.recorded_by_name ?? 'ระบบ',
      action: `ขยายระยะเวลา (${extTypeText(r.ext_type)})`,
      details: null,
      at: r.created_at,
    })
  }

  // ---- map device_returns (device status changes only) ----
  for (const r of (deviceRes.data ?? []) as AuditDeviceRow[]) {
    if (!r.device_status_updated_at || !r.device_status) continue
    const c = Array.isArray(r.contracts) ? r.contracts[0] : r.contracts
    events.push({
      id: `device:${r.id}`,
      eventType: 'device_status' as AuditEventType,
      contractId: r.contract_id,
      contractNo: c?.contract_no ?? null,
      customerName: c?.customer_name ?? null,
      actor: r.device_status_by ?? 'ระบบ',
      action: `เปลี่ยนสถานะเครื่อง: ${r.device_status}`,
      details: null,
      at: r.device_status_updated_at,
    })
  }

  // union + sort desc + cap
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  return events.slice(0, limit)
}

/**
 * ดึง audit events เฉพาะ "วันเดียว" (ตามปฏิทิน Bangkok) — ใช้สำหรับหน้าประวัติรายวัน
 * reuse AuditEvent shape เดียวกับ getAuditTimeline แต่:
 *  - filter server-side ด้วยช่วง UTC ที่แปลงจากวัน Bangkok (ไม่ดึงหมดมา slice)
 *  - แยก event สรุปยอดเป็น 2 ชนิด: summary_shop_sent / summary_accounting_sent
 *    (แทนที่จะรวมเป็น summary_sent ก้อนเดียวแบบ getAuditTimeline)
 * อีก 6 แหล่งคงเดิม (payment, grade_change, email_sent, follow_up, extension, device_status)
 * @param dayISO วันแบบ 'YYYY-MM-DD' ตามเวลา Bangkok
 */
export async function getDailyAudit(dayISO: string): Promise<AuditEvent[]> {
  if (!supabase) return []

  // แปลงวัน Bangkok (UTC+7 คงที่ ไม่มี DST) → ช่วง UTC สำหรับ query
  // Bangkok YYYY-MM-DD 00:00:00 = UTC (YYYY-MM-DD - 1 วัน) 17:00:00
  // ใช้ Date.UTC ตรงๆ แล้วลบ 7 ชม. เพื่อเลี่ยงกับดัก '+07:00' suffix (ดู applyPjReviewPayment comment)
  const [y, m, d] = dayISO.split('-').map(Number)
  const dayStartUtc = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - 7 * 3600 * 1000)
  const dayEndUtc = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0) - 7 * 3600 * 1000)
  const since = dayStartUtc.toISOString()
  const until = dayEndUtc.toISOString()

  const limit = 1000 // วันเดียว event ไม่เยอะ แต่กันเผื่อไว้ต่ำกว่า PostgREST cap

  // ---- helper: แปลง action ของ payment_log → ข้อความไทย ----
  const paymentActionText = (action: 'pay' | 'edit' | 'cancel', amount: number | null): string => {
    if (action === 'pay') {
      const fmt = amount != null ? amount.toLocaleString('th-TH') + ' ฿' : ''
      return fmt ? `ยืนยันชำระ ${fmt}` : 'ยืนยันชำระ'
    }
    if (action === 'edit') return 'แก้ไขการชำระ'
    return 'ยกเลิกการชำระ'
  }

  // ---- helper: แปล follow_up_result → ข้อความไทย ----
  const followUpResultText = (result: string): string => {
    const map: Record<string, string> = {
      no_answer: 'ไม่รับสาย',
      contacted: 'ติดต่อได้',
      promised: 'สัญญาจะจ่าย',
      refused: 'ปฏิเสธ',
      paid: 'ชำระแล้ว',
      returned: 'คืนเครื่อง',
      other: 'อื่นๆ',
    }
    return map[result] ?? result
  }

  // ---- helper: แปล extension_type → ข้อความไทย ----
  const extTypeText = (extType: string): string => {
    if (extType === 'due_day') return 'เปลี่ยนวันชำระ'
    if (extType === 'months') return 'ขยายงวด'
    if (extType === 'both') return 'เปลี่ยนวันชำระ+ขยายงวด'
    return extType
  }

  // ---- 8 parallel queries (7 เดิม + สรุปยอดแยก 2 คอลัมน์ = 1 query คืน 2 event type) ----
  const [
    paymentRes,
    gradeRes,
    emailRes,
    summaryRes,
    followUpRes,
    extensionRes,
    deviceRes,
  ] = await Promise.all([
    // 1. payment_log + join contracts
    supabase
      .from('payment_log')
      .select('id, contract_id, action, amount, by_name, note, created_at, contracts(contract_no, customer_name)')
      .gte('created_at', since)
      .lt('created_at', until)
      .order('created_at', { ascending: false })
      .limit(limit),

    // 2. contract_grade_history + join contracts
    supabase
      .from('contract_grade_history')
      .select('id, contract_id, old_grade, new_grade, changed_at, contracts(contract_no, customer_name)')
      .gte('changed_at', since)
      .lt('changed_at', until)
      .order('changed_at', { ascending: false })
      .limit(limit),

    // 3. contracts ที่ email_sent_at อยู่ในวัน
    supabase
      .from('contracts')
      .select('id, contract_no, customer_name, email_sent_at, email_sent_by')
      .gte('email_sent_at', since)
      .lt('email_sent_at', until)
      .order('email_sent_at', { ascending: false })
      .limit(limit),

    // 4. contracts ที่ summary_shop_sent_at หรือ summary_accounting_sent_at อยู่ในวัน (mig 0075 — 2 คอลัมน์แยก)
    //    ดึง row เดียวถ้าเข้าเงื่อนไขข้อใดข้อหนึ่ง แล้วค่อยแยก event ตอน map
    supabase
      .from('contracts')
      .select('id, contract_no, customer_name, summary_shop_sent_at, summary_shop_sent_by, summary_accounting_sent_at, summary_accounting_sent_by')
      .or(
        `and(summary_shop_sent_at.gte.${since},summary_shop_sent_at.lt.${until}),` +
        `and(summary_accounting_sent_at.gte.${since},summary_accounting_sent_at.lt.${until})`
      )
      .limit(limit),

    // 5. follow_ups + join contracts (author_name denormalized — ไม่ต้อง join profiles)
    supabase
      .from('follow_ups')
      .select('id, contract_id, author_name, follow_up_result, note_text, created_at, contracts(contract_no, customer_name)')
      .gte('created_at', since)
      .lt('created_at', until)
      .order('created_at', { ascending: false })
      .limit(limit),

    // 6. contract_extensions + join contracts
    supabase
      .from('contract_extensions')
      .select('id, contract_id, ext_type, recorded_by_name, created_at, contracts(contract_no, customer_name)')
      .gte('created_at', since)
      .lt('created_at', until)
      .order('created_at', { ascending: false })
      .limit(limit),

    // 7. device_returns ที่ device_status_updated_at อยู่ในวัน
    supabase
      .from('device_returns')
      .select('id, contract_id, device_status, device_status_by, device_status_updated_at, contracts(contract_no, customer_name)')
      .gte('device_status_updated_at', since)
      .lt('device_status_updated_at', until)
      .not('device_status_updated_at', 'is', null)
      .order('device_status_updated_at', { ascending: false })
      .limit(limit),
  ])

  // throw ถ้า query ไหน error
  if (paymentRes.error) throw paymentRes.error
  if (gradeRes.error) throw gradeRes.error
  if (emailRes.error) throw emailRes.error
  if (summaryRes.error) throw summaryRes.error
  if (followUpRes.error) throw followUpRes.error
  if (extensionRes.error) throw extensionRes.error
  if (deviceRes.error) throw deviceRes.error

  const events: AuditEvent[] = []

  // ---- map payment_log ----
  for (const r of (paymentRes.data ?? []) as AuditPaymentRow[]) {
    const c = Array.isArray(r.contracts) ? r.contracts[0] : r.contracts
    events.push({
      id: `payment:${r.id}`,
      eventType: 'payment' as AuditEventType,
      contractId: r.contract_id,
      contractNo: c?.contract_no ?? null,
      customerName: c?.customer_name ?? null,
      actor: r.by_name ?? 'ระบบ',
      action: paymentActionText(r.action, r.amount != null ? Number(r.amount) : null),
      details: r.note ?? null,
      at: r.created_at,
    })
  }

  // ---- map contract_grade_history ----
  for (const r of (gradeRes.data ?? []) as AuditGradeRow[]) {
    const c = Array.isArray(r.contracts) ? r.contracts[0] : r.contracts
    const fromGrade = r.old_grade ?? '-'
    const toGrade = r.new_grade ?? '-'
    events.push({
      id: `grade:${r.id}`,
      eventType: 'grade_change' as AuditEventType,
      contractId: r.contract_id,
      contractNo: c?.contract_no ?? null,
      customerName: c?.customer_name ?? null,
      actor: 'ระบบ',
      action: `เปลี่ยนเกรด ${fromGrade}→${toGrade}`,
      details: null,
      at: r.changed_at,
    })
  }

  // ---- map email_sent events ----
  for (const r of (emailRes.data ?? []) as AuditSentRow[]) {
    if (!r.email_sent_at) continue
    events.push({
      id: `email:${r.id}`,
      eventType: 'email_sent' as AuditEventType,
      contractId: r.id,
      contractNo: r.contract_no,
      customerName: r.customer_name,
      actor: r.email_sent_by ?? 'ระบบ',
      action: 'ส่งอีเมล',
      details: null,
      at: r.email_sent_at,
    })
  }

  // ---- map summary events (แยก 2 ชนิด: ร้าน / บัญชี — แต่ละ row อาจ emit ได้สูงสุด 2 events) ----
  for (const r of (summaryRes.data ?? []) as AuditSentTwoStageRow[]) {
    if (r.summary_shop_sent_at && r.summary_shop_sent_at >= since && r.summary_shop_sent_at < until) {
      events.push({
        id: `summary_shop:${r.id}`,
        eventType: 'summary_shop_sent' as AuditEventType,
        contractId: r.id,
        contractNo: r.contract_no,
        customerName: r.customer_name,
        actor: r.summary_shop_sent_by ?? 'ระบบ',
        action: 'ส่งสรุปยอดให้ร้าน',
        details: null,
        at: r.summary_shop_sent_at,
      })
    }
    if (r.summary_accounting_sent_at && r.summary_accounting_sent_at >= since && r.summary_accounting_sent_at < until) {
      events.push({
        id: `summary_accounting:${r.id}`,
        eventType: 'summary_accounting_sent' as AuditEventType,
        contractId: r.id,
        contractNo: r.contract_no,
        customerName: r.customer_name,
        actor: r.summary_accounting_sent_by ?? 'ระบบ',
        action: 'ส่งสรุปยอดให้บัญชี',
        details: null,
        at: r.summary_accounting_sent_at,
      })
    }
  }

  // ---- map follow_ups ----
  for (const r of (followUpRes.data ?? []) as AuditFollowUpRow[]) {
    const c = Array.isArray(r.contracts) ? r.contracts[0] : r.contracts
    events.push({
      id: `followup:${r.id}`,
      eventType: 'follow_up' as AuditEventType,
      contractId: r.contract_id,
      contractNo: c?.contract_no ?? null,
      customerName: c?.customer_name ?? null,
      actor: r.author_name || 'ระบบ',
      action: `ติดตาม: ${followUpResultText(r.follow_up_result)}`,
      details: r.note_text || null,
      at: r.created_at,
    })
  }

  // ---- map contract_extensions ----
  for (const r of (extensionRes.data ?? []) as AuditExtensionRow[]) {
    const c = Array.isArray(r.contracts) ? r.contracts[0] : r.contracts
    events.push({
      id: `ext:${r.id}`,
      eventType: 'extension' as AuditEventType,
      contractId: r.contract_id,
      contractNo: c?.contract_no ?? null,
      customerName: c?.customer_name ?? null,
      actor: r.recorded_by_name ?? 'ระบบ',
      action: `ขยายระยะเวลา (${extTypeText(r.ext_type)})`,
      details: null,
      at: r.created_at,
    })
  }

  // ---- map device_returns (device status changes only) ----
  for (const r of (deviceRes.data ?? []) as AuditDeviceRow[]) {
    if (!r.device_status_updated_at || !r.device_status) continue
    const c = Array.isArray(r.contracts) ? r.contracts[0] : r.contracts
    events.push({
      id: `device:${r.id}`,
      eventType: 'device_status' as AuditEventType,
      contractId: r.contract_id,
      contractNo: c?.contract_no ?? null,
      customerName: c?.customer_name ?? null,
      actor: r.device_status_by ?? 'ระบบ',
      action: `เปลี่ยนสถานะเครื่อง: ${r.device_status}`,
      details: null,
      at: r.device_status_updated_at,
    })
  }

  // union + sort desc (วันเดียว ไม่ต้อง cap ซ้ำ — query แต่ละแหล่งกรองมาแล้ว)
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  return events
}

export async function getOverduePromiseContracts(): Promise<OverduePromiseContract[]> {
  if (!supabase) return []
  const today = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)
  const { data, error } = await supabase
    .from('contracts')
    .select('id, contract_no, customer_name, promise_to_pay_date, promised_amount, status')
    .lt('promise_to_pay_date', today)
    .not('promise_to_pay_date', 'is', null)
    .eq('status', 'active')
    .order('promise_to_pay_date', { ascending: true })
    .range(0, PAGE_CAP)
  if (error) throw error
  return ((data ?? []) as OverduePromiseRow[]).map((r) => ({
    id: r.id,
    contractCode: r.contract_no,
    customerName: r.customer_name ?? '',
    promiseToPayDate: r.promise_to_pay_date,
    promisedAmount: r.promised_amount == null ? null : Number(r.promised_amount),
    daysPastPromise: Math.floor(
      (new Date(today).getTime() - new Date(r.promise_to_pay_date).getTime()) / 86400000,
    ),
  }))
}

// ============================================================================
// Wave 2B helpers — penalty split, extra charges, device defect notes, sale history
// ============================================================================

// ---------- helper 1: recordPaymentWithPenalty ----------
// Fix C (migration 0040): เปลี่ยนเป็น atomic RPC — INSERT payment_log + UPDATE installments
// อยู่ใน plpgsql transaction เดียวกัน ถ้า network ตายกลางทางจะ rollback อัตโนมัติ
//
// Trigger ที่ยังทำงานผ่าน RPC:
//   - set_payment_log_actor  (BEFORE INSERT ON payment_log) — ประทับ acted_by + by_name
//   - trg_clear_promise_on_pay (AFTER INSERT ON payment_log) — ล้าง promise เมื่อ action='pay'

/**
 * บันทึกชำระงวด พร้อมแยก penalty_paid_amount (Wave 2B — migration 0034)
 * ใช้สำหรับ payment modal ที่มีช่อง "ค่าปรับ" แยกออกมา
 *
 * Semantic ที่รักษาไว้:
 *   - payment_log.amount = principal + penalty (ยอดรับจริง)
 *   - installments.paid_amount สะสมเฉพาะ principal (outstanding formula ถูกต้อง)
 *   - ปิดงวดเมื่อ principal สะสม >= ค่างวด (จ่ายบางส่วน = งวดยังเปิด)
 *
 * @param installmentId  uuid ของงวดที่ชำระ
 * @param principal      ยอดค่างวด (ไม่รวมค่าปรับ)
 * @param penalty        ยอดค่าปรับที่ชำระ
 * @param byName         ชื่อผู้ทำรายการ (useAuth().name)
 */
export async function recordPaymentWithPenalty(
  installmentId: string,
  principal: number,
  penalty: number,
  byName: string,
): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.rpc('record_payment_with_penalty', {
    p_installment_id:      installmentId,
    p_paid_amount:         principal,
    p_paid_at:             new Date().toISOString(),
    p_by_name:             byName,
    p_penalty_paid_amount: penalty,
  })
  if (error) throw error
}

// ---------- helper 2: overridePenalty ----------

export interface PenaltyOverrideHistoryEntry {
  id: string
  installmentId: string
  installmentNo: number | null
  oldAmount: number | null
  newAmount: number
  reason: string | null
  byName: string | null
  createdAt: string
}

/**
 * แก้ค่าปรับของงวดแบบ manual (admin only — RLS คุม)
 * เซ็ต penalty_overridden = true กัน cron daily update reset ค่าที่ override ไว้
 * พร้อม INSERT audit row ลง penalty_override_history
 */
export async function overridePenalty(
  installmentId: string,
  newAmount: number,
  reason: string,
  byName: string,
): Promise<void> {
  if (!supabase) return

  // Step 1: อ่าน old_amount + contract_id จาก installments
  const { data: ins, error: readErr } = await supabase
    .from('installments')
    .select('penalty_amount, contract_id')
    .eq('id', installmentId)
    .single()
  if (readErr) throw readErr

  // Step 2: UPDATE installments (เดิม)
  const { error: updErr } = await supabase
    .from('installments')
    .update({
      penalty_amount: newAmount,
      penalty_overridden: true,
    })
    .eq('id', installmentId)
  if (updErr) throw updErr

  // Step 3: INSERT audit row
  const { error: histErr } = await supabase
    .from('penalty_override_history')
    .insert({
      installment_id: installmentId,
      contract_id: ins.contract_id,
      old_amount: ins.penalty_amount,
      new_amount: newAmount,
      reason: reason || null,
      by_name: byName || null,
    })
  if (histErr) throw histErr
}

/**
 * แก้/ลบค่าปรับของงวดผ่าน RPC admin_set_installment_penalty (admin เท่านั้น — guard ฝั่ง DB ด้วย is_admin())
 * ต่างจาก overridePenalty() ด้านบน (เขียนตรงผ่าน RLS installments_write ที่ staff เขียนได้ด้วย):
 * ทางนี้ guard เข้มกว่า + คำนวณ penalty_days ให้เอง + validate ช่วงยอด + ผูกชื่อผู้แก้จาก profiles ฝั่ง server
 * "ลบค่าปรับ" = เรียกด้วย penaltyAmount = 0
 */
export async function setInstallmentPenalty(
  installmentId: string,
  penaltyAmount: number,
  reason: string,
): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.rpc('admin_set_installment_penalty', {
    p_installment_id: installmentId,
    p_penalty_amount: penaltyAmount,
    p_reason: reason || null,
  })
  if (error) throw error
}

/**
 * ดึงประวัติการแก้ค่าปรับของสัญญา (admin+staff)
 */
export async function getPenaltyOverrideHistory(contractId: string): Promise<PenaltyOverrideHistoryEntry[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('penalty_override_history')
    .select('*, installments(installment_no)')
    .eq('contract_id', contractId)
    .order('created_at', { ascending: false })
    .range(0, 200)
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id as string,
    installmentId: r.installment_id as string,
    installmentNo: (r.installments as { installment_no: number } | null)?.installment_no ?? null,
    oldAmount: r.old_amount as number | null,
    newAmount: r.new_amount as number,
    reason: r.reason as string | null,
    byName: r.by_name as string | null,
    createdAt: r.created_at as string,
  }))
}

// ---------- helper 3: getExtraCharges ----------

interface ExtraChargeRow {
  id: string
  contract_id: string
  amount: number
  reason: string
  created_at: string
  created_by: string | null
}

function mapExtraCharge(r: ExtraChargeRow): ExtraCharge {
  return {
    id: r.id,
    contractId: r.contract_id,
    amount: Number(r.amount),
    reason: r.reason,
    createdAt: r.created_at,
    createdBy: r.created_by ?? null,
  }
}

/** ค่าใช้จ่ายเพิ่มเติมของสัญญาหนึ่ง (ใหม่ → เก่า) */
export async function getExtraCharges(contractId: string): Promise<ExtraCharge[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('extra_charges')
    .select('id, contract_id, amount, reason, created_at, created_by')
    .eq('contract_id', contractId)
    .order('created_at', { ascending: false })
    .range(0, PAGE_CAP)
  if (error) throw error
  return ((data ?? []) as ExtraChargeRow[]).map(mapExtraCharge)
}

// ---------- helper 4: insertExtraCharge ----------

/**
 * เพิ่มค่าใช้จ่ายพิเศษ (admin + staff ตาม RLS migration 0032)
 * @param byName ชื่อผู้บันทึก (useAuth().name) — เก็บเป็น text snapshot
 * @returns id ของแถวที่สร้าง
 */
export async function insertExtraCharge(
  contractId: string,
  amount: number,
  reason: string,
  byName: string,
): Promise<string> {
  if (!supabase) return ''
  const { data, error } = await supabase
    .from('extra_charges')
    .insert({
      contract_id: contractId,
      amount,
      reason,
      created_by: byName,
    })
    .select('id')
    .single()
  if (error) throw error
  return (data as { id: string }).id
}

// ---------- helper 5: deleteExtraCharge ----------

/** ลบค่าใช้จ่ายพิเศษ (admin only ตาม RLS migration 0032) */
export async function deleteExtraCharge(id: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from('extra_charges').delete().eq('id', id)
  if (error) throw error
}

// ---------- helper 6+: other_income (migration 0054) ----------

interface OtherIncomeRow {
  id: string
  contract_id: string | null
  amount: number
  category: string
  note: string | null
  received_at: string
  recorded_by: string | null
  created_at: string
  fee_kind: FeeKind | null
}

function mapOtherIncome(r: OtherIncomeRow): OtherIncome {
  return {
    id: r.id,
    contractId: r.contract_id ?? null,
    amount: Number(r.amount),
    category: r.category,
    note: r.note ?? null,
    receivedAt: r.received_at,
    recordedBy: r.recorded_by ?? null,
    createdAt: r.created_at,
    feeKind: r.fee_kind ?? null,
  }
}

/** รายได้อื่นๆ ของสัญญาหนึ่ง (ใหม่ → เก่า) */
export async function getOtherIncome(contractId: string): Promise<OtherIncome[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('other_income')
    .select('id, contract_id, amount, category, note, received_at, recorded_by, created_at, fee_kind')
    .eq('contract_id', contractId)
    .order('received_at', { ascending: false })
    .range(0, PAGE_CAP)
  if (error) throw error
  return ((data ?? []) as OtherIncomeRow[]).map(mapOtherIncome)
}

/** รายได้อื่นๆ ทั้งหมด (สำหรับ cashflow dashboard) */
export async function getAllOtherIncome(): Promise<OtherIncome[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('other_income')
    .select('id, contract_id, amount, category, note, received_at, recorded_by, created_at, fee_kind')
    .order('received_at', { ascending: false })
    .range(0, PAGE_CAP)
  if (error) throw error
  return ((data ?? []) as OtherIncomeRow[]).map(mapOtherIncome)
}

/**
 * บันทึกรายได้อื่นๆ (admin + staff ตาม RLS migration 0054)
 * @param input.recordedBy ชื่อผู้บันทึก (useAuth().name) — เก็บเป็น text snapshot
 */
export async function insertOtherIncome(input: {
  contractId?: string | null
  amount: number
  category: string
  note?: string
  receivedAt: string
  recordedBy?: string
  feeKind?: FeeKind | null // tag ค่าธรรมเนียมสิทธิ์ไหน (migration 0106) — null = รายได้ทั่วไป
}): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from('other_income').insert({
    contract_id: input.contractId ?? null,
    amount: input.amount,
    category: input.category,
    note: input.note ?? null,
    received_at: input.receivedAt,
    recorded_by: input.recordedBy ?? null,
    fee_kind: input.feeKind ?? null,
  })
  if (error) throw error
}

/** ลบรายได้อื่นๆ (admin only ตาม RLS migration 0054) */
export async function deleteOtherIncome(id: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from('other_income').delete().eq('id', id)
  if (error) throw error
}

// ---------- Fee reconcile — fee_waivers + reconcile helper (migration 0106) ----------

/** สิทธิ์ค่าธรรมเนียมที่ admin ยกเว้นแล้วของสัญญาหนึ่ง (คืน array ของ fee_right) */
export async function getFeeWaivers(contractId: string): Promise<FeeRight[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('fee_waivers')
    .select('fee_right')
    .eq('contract_id', contractId)
  if (error) throw error
  return ((data ?? []) as { fee_right: FeeRight }[]).map((r) => r.fee_right)
}

/** admin ยกเว้นค่าธรรมเนียมสิทธิ์หนึ่ง (INSERT — admin only ตาม RLS 0106)
 *  unique(contract_id, fee_right) กันซ้ำ — ยกเว้นซ้ำจะ error 23505 (UI ควรกันก่อน) */
export async function insertFeeWaiver(
  contractId: string,
  right: FeeRight,
  byName?: string,
  note?: string,
): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from('fee_waivers').insert({
    contract_id: contractId,
    fee_right: right,
    waived_by: byName ?? null,
    note: note ?? null,
  })
  if (error) throw error
}

/** ยกเลิกการยกเว้น (DELETE — admin only ตาม RLS 0106) */
export async function deleteFeeWaiver(contractId: string, right: FeeRight): Promise<void> {
  if (!supabase) return
  const { error } = await supabase
    .from('fee_waivers')
    .delete()
    .eq('contract_id', contractId)
    .eq('fee_right', right)
  if (error) throw error
}

/**
 * รวมข้อมูล reconcile ค่าธรรมเนียมของสัญญาหนึ่งแล้วคืนสถานะ 3 สิทธิ์ (derive-first)
 * ดึง extensions + otherIncome(fee_kind) + waivers + settled_at → เรียก reconcileContractFees
 * ใช้ใน ContractDetail ได้เลย (1 สัญญา — 3 query ขนาน + 1 อ่าน contract)
 */
export async function getContractFeeReconcile(contractId: string): Promise<ReconcileResult> {
  if (!supabase) {
    return { due_day: 'none', months: 'none', settle: 'none' }
  }
  const [exts, income, waivers, contractRow] = await Promise.all([
    getContractExtensions(contractId),
    getOtherIncome(contractId),
    getFeeWaivers(contractId),
    supabase.from('contracts').select('settled_at').eq('id', contractId).maybeSingle(),
  ])
  if (contractRow.error) throw contractRow.error
  const settledAt = (contractRow.data as { settled_at: string | null } | null)?.settled_at ?? null

  return reconcileContractFees({
    settledAt,
    extensions: exts.map((e) => ({ extType: e.extType, createdAt: e.createdAt })),
    otherIncome: income.map((oi) => ({ feeKind: oi.feeKind ?? null, receivedAt: oi.receivedAt })),
    dismisses: waivers,
    launchDate: FEE_RECONCILE_LAUNCH,
  })
}

// ---------- helper 6: updateDefectNotes ----------

/** บันทึก/แก้ข้อความข้อบกพร่องของเครื่องคืน (migration 0033 — device_defect_notes text) */
export async function updateDefectNotes(returnId: string, notes: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase
    .from('device_returns')
    .update({ device_defect_notes: notes || null })
    .eq('id', returnId)
  if (error) throw error
}

// ---------- helper 7a: updateSalePrice (admin แก้ราคาขายเครื่อง — item 7) ----------

/** admin แก้ราคาขายเครื่องคืน (sale_price + priced_at) — migration 0027 columns */
export async function updateSalePrice(returnId: string, newPrice: number): Promise<void> {
  if (!supabase) return
  const { error } = await supabase
    .from('device_returns')
    .update({ sale_price: newPrice, priced_at: new Date().toISOString() })
    .eq('id', returnId)
  if (error) throw error
}

// ---------- helper 7b: updateRepairCost (ค่าซ่อม เพื่อคำนวณ commission สุทธิ — item 8) ----------

/** บันทึก/แก้ค่าซ่อมเครื่อง (repair_cost) — migration 0035; ใช้คำนวณ commission สุทธิ */
export async function updateRepairCost(returnId: string, repairCost: number): Promise<void> {
  if (!supabase) return
  const { error } = await supabase
    .from('device_returns')
    .update({ repair_cost: repairCost })
    .eq('id', returnId)
  if (error) throw error
}

// ---------- helper 8: getSaleHistoryRaw ----------

/**
 * ข้อมูล raw สำหรับ sale history (เครื่องที่ขายแล้ว: device_status IN ('shipped','transferred'))
 * Return type ตั้งชื่อว่า SaleHistoryInput — mirror กับ src/lib/saleHistory.ts
 *
 * NOTE commission = finance_amount × commission_percent / 100 (ปัดเศษ Math.round)
 *      finance_amount == afterDown เป๊ะทุกเคส → ใช้เป็นฐานคูณ commission ได้
 *
 * NOTE แยกเงินที่ลูกค้าจ่ายเป็น 2 ก้อน (payment_log action='pay'):
 *      downPaid        = Σ rows ที่ installment_id IS NULL (เงินดาวน์)
 *      installmentPaid = Σ rows ที่ installment_id NOT NULL (งวดจริง)
 *      installmentCount = count DISTINCT installment_id (จำนวนงวดที่ผ่อนจริง)
 *      ทุกก้อน floor Math.max(0, amount − penalty_paid_amount) ต่อแถว (ไม่นับค่าปรับ)
 *
 * NOTE โอนให้ร้าน (transferToShop) คิดที่ saleHistory.ts (= deviceListPrice + commission)
 */
export interface SaleHistoryInput {
  contractId: string
  contractNo: string
  customerName: string
  shopId: string
  shopName: string
  deviceModel: string         // model + storage รวม เช่น "iPhone 15 Pro 256GB"
  deviceListPrice: number     // finance_amount (ยอดจัดไฟแนนซ์)
  commissionPercent: number   // contracts.commission_percent
  commission: number          // Math.round(deviceListPrice × commissionPercent / 100)
  downPaid: number            // Σ pay where installment_id IS NULL, floor 0 ต่อแถว (เงินดาวน์)
  installmentPaid: number     // Σ pay where installment_id NOT NULL, floor 0 ต่อแถว (งวดจริง)
  installmentCount: number    // count DISTINCT installment_id ของ pay rows ที่ installment_id NOT NULL
  resalePrice: number | null  // device_returns.sale_price
  returnedAt: string | null   // device_returns.transferred_at ?? shipped_at (วันที่ขาย/โอน)
}

interface SaleHistoryReturnRow {
  id: string
  contract_id: string
  device_status: string | null
  sale_price: number | null
  transferred_at: string | null
  shipped_at: string | null
}

interface SaleHistoryContractRow {
  id: string
  contract_no: string
  customer_name: string
  shop_id: string
  model: string | null
  storage: string | null
  finance_amount: number | null
  device_price: number
  down_percent: number
  commission_percent: number | null
}

interface SaleHistoryShopRow {
  id: string
  name: string
}

/**
 * ดึงข้อมูล raw ของเครื่องที่ขายแล้ว สำหรับคำนวณ sale history (Wave 3 UI)
 * ดึงเฉพาะ device_status IN ('shipped', 'transferred') — ขายเสร็จแล้ว
 */
export async function getSaleHistoryRaw(): Promise<SaleHistoryInput[]> {
  if (!supabase) return []

  // Step 1: device_returns ที่ขายแล้ว
  const { data: returnData, error: returnErr } = await supabase
    .from('device_returns')
    .select('id, contract_id, device_status, sale_price, transferred_at, shipped_at')
    .in('device_status', ['shipped', 'transferred'])
    .order('shipped_at', { ascending: false })
    .range(0, PAGE_CAP)
  if (returnErr) throw returnErr

  const returns = (returnData ?? []) as SaleHistoryReturnRow[]
  if (returns.length === 0) return []

  const contractIds = [...new Set(returns.map((r) => r.contract_id))]

  // Step 2: contracts ที่เกี่ยวข้อง
  const { data: contractData, error: contractErr } = await supabase
    .from('contracts')
    .select('id, contract_no, customer_name, shop_id, model, storage, finance_amount, device_price, down_percent, commission_percent')
    .in('id', contractIds)
  if (contractErr) throw contractErr

  const contractMap = new Map(
    ((contractData ?? []) as SaleHistoryContractRow[]).map((c) => [c.id, c]),
  )

  // Step 3: shop names
  const shopIds = [
    ...new Set(
      ((contractData ?? []) as SaleHistoryContractRow[])
        .map((c) => c.shop_id)
        .filter((id): id is string => id != null),
    ),
  ]
  const shopNameMap = new Map<string, string>()
  if (shopIds.length > 0) {
    const { data: shopData, error: shopErr } = await supabase
      .from('shops_basic')
      .select('id, name')
      .in('id', shopIds)
    if (shopErr) throw shopErr
    for (const s of (shopData ?? []) as SaleHistoryShopRow[]) {
      shopNameMap.set(s.id, s.name)
    }
  }

  // Step 4: payment_log — แยกเงินดาวน์ vs งวดจริง per contract
  // เงินดาวน์ = installment_id IS NULL | งวดจริง = installment_id NOT NULL
  // principal ต่อแถว = max(0, amount - coalesce(penalty_paid_amount, 0)) (ไม่นับค่าปรับ, migration 0034)
  // รวมเฉพาะ action='pay'
  const { data: payData, error: payErr } = await supabase
    .from('payment_log')
    .select('contract_id, amount, penalty_paid_amount, installment_id')
    .in('contract_id', contractIds)
    .eq('action', 'pay')
    .range(0, PAGE_CAP)
  if (payErr) throw payErr

  // Client-side aggregate:
  //   downMap     = Σ principal where installment_id IS NULL (เงินดาวน์)
  //   instMap     = Σ principal where installment_id NOT NULL (งวดจริง)
  //   instIdSet   = Set<installment_id> ต่อ contract → count distinct = จำนวนงวดที่ผ่อนจริง
  const downMap = new Map<string, number>()
  const instMap = new Map<string, number>()
  const instIdSet = new Map<string, Set<string>>()
  for (const row of (payData ?? []) as {
    contract_id: string
    amount: number | null
    penalty_paid_amount: number | null
    installment_id: string | null
  }[]) {
    const principal = Math.max(0, Number(row.amount ?? 0) - Number(row.penalty_paid_amount ?? 0))
    if (row.installment_id == null) {
      downMap.set(row.contract_id, (downMap.get(row.contract_id) ?? 0) + principal)
    } else {
      instMap.set(row.contract_id, (instMap.get(row.contract_id) ?? 0) + principal)
      let set = instIdSet.get(row.contract_id)
      if (!set) { set = new Set<string>(); instIdSet.set(row.contract_id, set) }
      set.add(row.installment_id)
    }
  }

  // Step 5: assemble
  return returns.map((ret): SaleHistoryInput => {
    const c = contractMap.get(ret.contract_id)
    const financeAmount = Number(c?.finance_amount ?? 0)
    const devicePrice = Number(c?.device_price ?? 0)
    const commissionPercent = Number(c?.commission_percent ?? 0)
    const modelParts = [c?.model, c?.storage].filter(Boolean)
    return {
      contractId: ret.contract_id,
      contractNo: c?.contract_no ?? '-',
      customerName: c?.customer_name ?? '-',
      shopId: c?.shop_id ?? '',
      shopName: c?.shop_id ? (shopNameMap.get(c.shop_id) ?? '-') : '-',
      deviceModel: modelParts.join(' '),
      deviceListPrice: devicePrice,
      commissionPercent,
      commission: Math.round((financeAmount * commissionPercent) / 100),
      downPaid: downMap.get(ret.contract_id) ?? 0,
      installmentPaid: instMap.get(ret.contract_id) ?? 0,
      installmentCount: instIdSet.get(ret.contract_id)?.size ?? 0,
      resalePrice: ret.sale_price == null ? null : Number(ret.sale_price),
      returnedAt: ret.transferred_at ?? ret.shipped_at ?? null,
    }
  })
}

// ===== โน้ตส่วนตัวต่อสัญญา (migration 0037) =====

interface NoteRow {
  id: string
  contract_id: string
  user_id: string
  content: string
  created_at: string
  updated_at: string
  profiles: { full_name: string } | null
}

function mapNote(r: NoteRow): PrivateNote {
  return {
    id: r.id,
    contractId: r.contract_id,
    userId: r.user_id,
    authorName: r.profiles?.full_name,
    content: r.content,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** ดึงโน้ตของ user ที่ login อยู่ สำหรับสัญญาที่ระบุ — คืน null ถ้ายังไม่มี */
export async function getMyPrivateNote(contractId: string): Promise<PrivateNote | null> {
  if (!supabase) return null
  const userId = (await supabase.auth.getUser()).data.user?.id
  if (!userId) return null
  const { data, error } = await supabase
    .from('contract_private_notes')
    .select('*, profiles!user_id(full_name)')
    .eq('contract_id', contractId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return data ? mapNote(data as NoteRow) : null
}

/** ดึงโน้ตทั้งหมดของสัญญา (admin เท่านั้น — RLS คืน 0 rows สำหรับ non-admin) */
export async function getAllPrivateNotes(contractId: string): Promise<PrivateNote[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('contract_private_notes')
    .select('*, profiles!user_id(full_name)')
    .eq('contract_id', contractId)
    .order('updated_at', { ascending: false })
  if (error) throw error
  return ((data ?? []) as NoteRow[]).map(mapNote)
}

/** บันทึกหรืออัปเดตโน้ตของ user ที่ login อยู่ (upsert on conflict contract_id, user_id) */
export async function savePrivateNote(contractId: string, content: string): Promise<void> {
  if (!supabase) return
  const userId = (await supabase.auth.getUser()).data.user?.id
  if (!userId) throw new Error('not signed in')
  const { error } = await supabase
    .from('contract_private_notes')
    .upsert(
      { contract_id: contractId, user_id: userId, content, updated_at: new Date().toISOString() },
      { onConflict: 'contract_id,user_id' },
    )
  if (error) throw error
}

/** ลบโน้ตตาม id — RLS คุม: ตัวเอง + admin */
export async function deletePrivateNote(noteId: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase
    .from('contract_private_notes')
    .delete()
    .eq('id', noteId)
  if (error) throw error
}

// ===== ค่าคอมคืนเครื่อง v2 — นับจำนวนเครื่อง (บาท/เครื่อง ตามขั้นบรรได) =====

/** นับจำนวนเครื่องที่ฟรีแลนซ์คืนสำเร็จในเดือนปัจจุบัน
 *  Pete sign-off: นับทุก device_status (ไม่กรอง) */
export async function getDeviceReturnCountThisMonth(freelancerId: string): Promise<number> {
  if (!supabase) return 0
  const now = new Date()
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const firstOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()
  const { count, error } = await supabase
    .from('device_returns')
    .select('*', { count: 'exact', head: true })
    .eq('attributed_freelancer_id', freelancerId)
    .gte('attributed_at', firstOfMonth)
    .lt('attributed_at', firstOfNextMonth)
  if (error) throw error
  return count ?? 0
}

/** per-freelancer aggregate สำหรับ Commission report + StaffPerformance
 *  คืน Map<freelancerId, count> ของเดือนปัจจุบัน (1 query, group ฝั่ง client)
 *  Pete sign-off: นับทุก device_status (ไม่กรอง) */
export async function getDeviceReturnCountsByFreelancerThisMonth(): Promise<Map<string, number>> {
  if (!supabase) return new Map()
  const now = new Date()
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const firstOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()
  const { data, error } = await supabase
    .from('device_returns')
    .select('attributed_freelancer_id')
    .not('attributed_freelancer_id', 'is', null)
    .gte('attributed_at', firstOfMonth)
    .lt('attributed_at', firstOfNextMonth)
    .range(0, 4999) // PAGE_CAP
  if (error) throw error
  const map = new Map<string, number>()
  for (const row of data ?? []) {
    const id = row.attributed_freelancer_id as string
    map.set(id, (map.get(id) ?? 0) + 1)
  }
  return map
}

// ---------- PJ Import ----------
import type { PJContract, PJInstallment, ImportResult } from './pjImport'

/**
 * importPjBatch — ส่ง 1 batch (≤100 contracts) ไปให้ RPC import_pj_batch ใน Supabase
 *
 * @param contracts       รายการสัญญาของ batch นี้ (PJContract[])
 * @param installments    รายการงวดของ batch นี้ (PJInstallment[]) — ทุก row ของ batch
 * @param batchNo         หมายเลข batch (เริ่มต้น 1) ใส่ใน error message
 * @param createNewShops  true = สร้างร้านใหม่อัตโนมัติถ้าไม่พบ
 * @returns               ImportResult สรุปผล batch
 */
export async function importPjBatch(
  contracts: PJContract[],
  installments: PJInstallment[],
  batchNo: number,
  createNewShops: boolean,
): Promise<ImportResult> {
  if (!supabase) throw new Error('โหมดตัวอย่าง: ยังไม่เชื่อม Supabase')

  const { data, error } = await supabase.rpc('import_pj_batch', {
    p_contracts_json:    contracts    as unknown as Record<string, unknown>[],
    p_installments_json: installments as unknown as Record<string, unknown>[],
    p_batch_no:          batchNo,
    p_create_new_shops:  createNewShops,
  })

  if (error) throw new Error(error.message)

  const raw = data as {
    batch_no: number
    imported: number
    contracts_created: number
    installments_created: number
    payments_logged: number
    errors: Array<{ invoice_no: string; batch?: number; error: string }>
  }

  return {
    batchNo:              raw.batch_no,
    imported:             raw.imported,
    contractsCreated:     raw.contracts_created,
    installmentsCreated:  raw.installments_created,
    paymentsLogged:       raw.payments_logged,
    errors: (raw.errors ?? []).map((e) => ({
      invoiceNo: e.invoice_no,
      batch:     e.batch,
      error:     e.error,
    })),
  }
}

// ============================================================================
// Collaboration Hub — Wave 3 (0047)
// ============================================================================

// ---------- markCaseSeen ----------

/**
 * บันทึกเวลาที่ฟรีแลนซ์เปิด/บันทึกเคสล่าสุด
 * Upsert queue_case_seen — ไม่ส่ง last_seen_at มาจาก client
 * DB trigger (0047) set last_seen_at := now() ทุกครั้ง (INSERT + UPDATE path)
 * → กัน bug เทียบเวลา client Z vs server +00:00
 */
export async function markCaseSeen(contractId: string): Promise<void> {
  if (!supabase) return
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return
  const { error } = await supabase.from('queue_case_seen').upsert(
    { freelancer_id: user.id, contract_id: contractId },
    { onConflict: 'freelancer_id,contract_id' },
  )
  if (error) throw error
}

// ---------- getInboxCases ----------

export interface InboxCase {
  contractId: string
  contractNo: string
  customerName: string
  phone: string | null
  shopName: string
  daysLate: number
  latestNote: string
  latestNoteAt: string
  latestNoteByName: string
  promiseToPayDate: string | null
  pinned: boolean
  imei: string | null // IMEI/SN ตัวเครื่อง (จาก contracts.imei) — สำหรับค้นหา
  invNo: string | null // เลขที่ใบแจ้งหนี้ (จาก contracts.inv_no) — สำหรับค้นหา
  // --- ขยาย inbox 2026-06-27: แหล่งเด้งเคส + คืนเครื่อง ---
  hasDeviceReturn: boolean // มี device_returns ที่ยังไม่จบ (non-terminal) ของสัญญานี้หรือไม่
  deviceReturnStatus: string | null // device_status ล่าสุดที่ non-terminal (null ถ้าไม่มี)
  deviceReturnAt: string | null // created_at ของ return ล่าสุดที่ non-terminal (null ถ้าไม่มี)
  sources: string[] // เหตุที่อยู่ใน inbox: 'pinned' | 'line_pending' | 'promise' | 'return' (มีได้หลายเหตุ)
}

/**
 * ดึงเคสในกล่องรับงาน (Inbox) ของ admin/staff:
 * membership = union ของ 4 แหล่ง (เฉพาะสัญญา status='active'):
 *   (1) pinned        — มี row ใน inbox_pins
 *   (2) line_pending  — follow_up ล่าสุด result='line_pending'
 *   (3) promise       — contracts.promise_to_pay_date IS NOT NULL (ทุกเคสที่มีวันนัด — Pete 2026-06-27)
 *   (4) return        — มี device_returns ที่ยัง non-terminal (ยังไม่ 'shipped')
 * เรียง daysLate DESC
 *
 * Device-return non-terminal set ที่นับเข้า inbox (ยังอยู่ในขั้นจัดการ):
 *   in_transit, pending_check, checked, pending_sale, priced, transferred
 *   — terminal = 'shipped' (จัดส่งคืนร้านเรียบร้อย) ไม่นับ; device_status = null ก็ไม่นับ
 *   (อ้างอิง DeviceStatus enum + ALLOWED_TRANSITIONS ใน returnWorkflow.ts: 'shipped' = terminal)
 *
 * การดึงข้อมูล:
 *   Step 1: inbox_pins ทั้งหมด
 *   Step 2: v_follow_up_stats_90d.last_result = 'line_pending'
 *   Step 2b: contracts.promise_to_pay_date IS NOT NULL (id เท่านั้น เพื่อ union)
 *   Step 2c: device_returns ที่ device_status non-terminal (เก็บ status + created_at ล่าสุดต่อ contract)
 *   Step 3: ดึง status + details จาก v_contract_status (active เท่านั้น) สำหรับ union ของ ids
 *   Step 4: ดึง phone + promise fields จาก contracts
 *   Step 5: ดึง note ล่าสุดต่อสัญญา (follow_ups 1 แถวต่อ contract)
 */
export async function getInboxCases(): Promise<InboxCase[]> {
  if (!supabase) return []

  // Step 1: ดึง inbox_pins ทั้งหมด
  const { data: pinsData, error: pinsErr } = await supabase
    .from('inbox_pins')
    .select('contract_id, pinned_by_id, pinned_by_name, pinned_at')
  if (pinsErr) throw pinsErr

  const pinnedIds = new Set(
    ((pinsData ?? []) as { contract_id: string }[]).map((p) => p.contract_id),
  )

  // pinned_at ต่อ contract — ใช้เทียบ re-appear หลัง dismiss (re-pin หลังเคลียร์ = กลับมา)
  const pinnedAtMap = new Map<string, string>()
  for (const p of (pinsData ?? []) as { contract_id: string; pinned_at: string }[]) {
    pinnedAtMap.set(p.contract_id, p.pinned_at)
  }

  // Step 2: หา contract ที่ last_result = 'line_pending' จาก v_follow_up_stats_90d
  // last_result = result ของ follow_up ล่าสุด (ไม่ใช่ success-filtered) — ไม่ต้องแก้ view
  const { data: statsData, error: statsErr } = await supabase
    .from('v_follow_up_stats_90d')
    .select('contract_id, last_result')
    .eq('last_result', 'line_pending')
    .range(0, PAGE_CAP)
  if (statsErr) throw statsErr

  const linePendingIds = new Set(
    ((statsData ?? []) as { contract_id: string }[]).map((r) => r.contract_id),
  )

  // Step 2b: contract ที่มีวันนัดชำระ (promise_to_pay_date IS NOT NULL) → เด้งเข้า inbox
  // filter ฝั่ง DB (.not is null) เพื่อไม่ดึงทุกสัญญา — เคสที่มีวันนัดไม่น่าเกิน cap
  const { data: promiseData, error: promiseErr } = await supabase
    .from('contracts')
    .select('id')
    .not('promise_to_pay_date', 'is', null)
    .range(0, PAGE_CAP)
  if (promiseErr) throw promiseErr

  const promiseIds = new Set(
    ((promiseData ?? []) as { id: string }[]).map((c) => c.id),
  )

  // Step 2c: device_returns ที่ยัง non-terminal (ยังไม่ 'shipped') — เด้งเข้า inbox
  // non-terminal = ทุกค่า ยกเว้น 'shipped'; null ไม่นับ. filter ฝั่ง DB (.neq shipped + not null)
  // เก็บ created_at ล่าสุดต่อ contract (order desc + client dedupe เก็บแถวแรก)
  const { data: returnData, error: returnErr } = await supabase
    .from('device_returns')
    .select('contract_id, device_status, created_at')
    .not('device_status', 'is', null)
    .neq('device_status', 'shipped')
    .order('created_at', { ascending: false })
    .range(0, PAGE_CAP)
  if (returnErr) throw returnErr

  const returnMap = new Map<string, { device_status: string; created_at: string }>()
  for (const r of (returnData ?? []) as {
    contract_id: string
    device_status: string
    created_at: string
  }[]) {
    if (!returnMap.has(r.contract_id)) {
      returnMap.set(r.contract_id, { device_status: r.device_status, created_at: r.created_at })
    }
  }
  const returnIds = new Set(returnMap.keys())

  // Step 2d: ดึง inbox_dismissals ทั้งหมด → Map<contract_id, dismissed_at>
  // เคสที่ถูกเคลียร์จะถูกซ่อน เว้นแต่มีความเคลื่อนไหวใหม่หลัง dismissed_at (ดู suppression ตอน map)
  const { data: dismissData, error: dismissErr } = await supabase
    .from('inbox_dismissals')
    .select('contract_id, dismissed_at')
    .range(0, PAGE_CAP)
  if (dismissErr) throw dismissErr

  const dismissedMap = new Map<string, string>()
  for (const d of (dismissData ?? []) as { contract_id: string; dismissed_at: string }[]) {
    dismissedMap.set(d.contract_id, d.dismissed_at)
  }

  // union: pinned OR line_pending OR promise OR return
  const allIds = Array.from(
    new Set([...pinnedIds, ...linePendingIds, ...promiseIds, ...returnIds]),
  )
  if (allIds.length === 0) return []

  // Step 3: ดึง status + details จาก v_contract_status (active เท่านั้น)
  const { data: statusData, error: statusErr } = await supabase
    .from('v_contract_status')
    .select('contract_id, contract_no, customer_name, shop_name, days_late, penalty_due')
    .eq('status', 'active')
    .in('contract_id', allIds)
    .order('days_late', { ascending: false })
    .range(0, PAGE_CAP)
  if (statusErr) throw statusErr

  const activeIds = ((statusData ?? []) as { contract_id: string }[]).map(
    (r) => r.contract_id,
  )
  if (activeIds.length === 0) return []

  // Step 4: ดึง phone + promise fields จาก contracts
  const { data: contractData, error: contractErr } = await supabase
    .from('contracts')
    .select('id, phone, promise_to_pay_date, imei, inv_no')
    .in('id', activeIds)
    .range(0, PAGE_CAP)
  if (contractErr) throw contractErr

  const contractMap = new Map(
    ((contractData ?? []) as {
      id: string
      phone: string | null
      promise_to_pay_date: string | null
      imei: string | null
      inv_no: string | null
    }[]).map((c) => [c.id, c]),
  )

  // Step 5: ดึง follow_up ล่าสุด 1 แถวต่อ contract (สำหรับ latestNote/latestNoteAt/latestNoteByName)
  // ใช้ order desc + range — PostgREST ไม่รองรับ DISTINCT ON ดังนั้น client-side dedupe
  const { data: fuData, error: fuErr } = await supabase
    .from('follow_ups')
    .select('contract_id, note_text, created_at, author_name')
    .in('contract_id', activeIds)
    .order('created_at', { ascending: false })
    .range(0, PAGE_CAP)
  if (fuErr) throw fuErr

  // Client-side dedupe: เก็บเฉพาะแถวแรก (latest) ต่อ contract_id
  const latestNoteMap = new Map<
    string,
    { note_text: string; created_at: string; author_name: string }
  >()
  for (const fu of (fuData ?? []) as {
    contract_id: string
    note_text: string
    created_at: string
    author_name: string
  }[]) {
    if (!latestNoteMap.has(fu.contract_id)) {
      latestNoteMap.set(fu.contract_id, fu)
    }
  }

  return ((statusData ?? []) as {
    contract_id: string
    contract_no: string
    customer_name: string
    shop_name: string | null
    days_late: number
    penalty_due: number
  }[]).map((r): InboxCase | null => {
    const c = contractMap.get(r.contract_id)
    const note = latestNoteMap.get(r.contract_id)
    const ret = returnMap.get(r.contract_id)
    const promiseToPayDate = c?.promise_to_pay_date ?? null

    // Suppression: เคสที่ถูกเคลียร์ (มีใน inbox_dismissals) จะถูกซ่อน
    //   เว้นแต่มี "ความเคลื่อนไหวใหม่หลัง dismissed_at" อย่างใดอย่างหนึ่ง → โชว์กลับ (re-appear):
    //     - โน้ต follow_up ใหม่ (latestNoteAt > dismissed_at) — ครอบ "นัดใหม่" ด้วย (นัดสร้าง follow_up เสมอ)
    //     - คืนเครื่องใหม่ (returnMap.created_at > dismissed_at)
    //     - re-pin (pinned_at > dismissed_at)
    //   note ที่ไม่มี (latestNoteAt null/'') = ไม่ผ่านเงื่อนไข note
    const dismissedAt = dismissedMap.get(r.contract_id)
    if (dismissedAt !== undefined) {
      const dismissedMs = new Date(dismissedAt).getTime()
      const noteAt = note?.created_at
      const noteNewer = noteAt ? new Date(noteAt).getTime() > dismissedMs : false
      const returnNewer = ret ? new Date(ret.created_at).getTime() > dismissedMs : false
      const pinnedAt = pinnedAtMap.get(r.contract_id)
      const pinNewer = pinnedAt ? new Date(pinnedAt).getTime() > dismissedMs : false
      if (!noteNewer && !returnNewer && !pinNewer) return null // ยังไม่มีความเคลื่อนไหวใหม่ → ซ่อน
    }

    // สร้าง sources[] — เหตุที่เคสอยู่ใน inbox (1 เคสมีได้หลายเหตุ)
    const sources: string[] = []
    if (pinnedIds.has(r.contract_id)) sources.push('pinned')
    if (linePendingIds.has(r.contract_id)) sources.push('line_pending')
    if (promiseToPayDate !== null) sources.push('promise')
    if (ret !== undefined) sources.push('return')

    return {
      contractId: r.contract_id,
      contractNo: r.contract_no,
      customerName: r.customer_name,
      phone: c?.phone ?? null,
      shopName: r.shop_name ?? '-',
      daysLate: r.days_late,
      latestNote: note?.note_text ?? '',
      latestNoteAt: note?.created_at ?? '',
      latestNoteByName: note?.author_name ?? '',
      promiseToPayDate,
      pinned: pinnedIds.has(r.contract_id),
      imei: c?.imei ?? null,
      invNo: c?.inv_no ?? null,
      hasDeviceReturn: ret !== undefined,
      deviceReturnStatus: ret?.device_status ?? null,
      deviceReturnAt: ret?.created_at ?? null,
      sources,
    }
  }).filter((x): x is InboxCase => x !== null)
}

// ---------- pinToInbox / unpinFromInbox ----------

/**
 * หยิบเคสเข้ากล่อง inbox (upsert — ถ้า pin ซ้ำ trigger 0047 refresh pinned_at)
 * pinned_by_name: snapshot จาก profiles ณ เวลา pin
 */
export async function pinToInbox(contractId: string): Promise<void> {
  if (!supabase) return
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return

  // ดึง full_name จาก profiles (snapshot — กัน spoof + ตรงกับ pattern ของ follow_ups)
  const { data: profileData, error: profileErr } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('id', user.id)
    .maybeSingle()
  if (profileErr) throw profileErr
  const pinnedByName = (profileData as { full_name: string | null } | null)?.full_name ?? ''

  const { error } = await supabase.from('inbox_pins').upsert(
    {
      contract_id: contractId,
      pinned_by_id: user.id,
      pinned_by_name: pinnedByName,
      // ไม่ส่ง pinned_at — DB default now() / trigger ใช้ได้
    },
    { onConflict: 'contract_id' },
  )
  if (error) throw error
}

/** เอาเคสออกจากกล่อง inbox */
export async function unpinFromInbox(contractId: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase
    .from('inbox_pins')
    .delete()
    .eq('contract_id', contractId)
  if (error) throw error
}

// ---------- dismissInboxCase ----------

/**
 * เคลียร์เคสออกจากกล่องรับงาน (dismiss) แบบกลับมาได้เมื่อมีความเคลื่อนไหวใหม่
 *
 * - upsert inbox_dismissals (contract_id, dismissed_at=now() ผ่าน trigger, snapshot คน+ชื่อ, note)
 *   re-dismiss = ชนกุญแจ → trigger touch_inbox_dismissal บังคับ dismissed_at := now() ใหม่
 * - ลบ inbox_pins ของ contract นั้นด้วย → "เคลียร์" = เอาออกจากทุกแหล่ง (pinned ก็หาย)
 *   ถ้า re-pin ทีหลัง pinned_at > dismissed_at → getInboxCases โชว์กลับ
 *
 * ⚠️ ordering: dismissed_at ตั้งด้วย server now() (trigger). กรณีวิวเรียก addFollowUp ก่อน
 *   แล้ว dismissInboxCase ทีหลัง → now() ของ dismiss > created_at ของ note = ไม่ re-appear ทันที
 */
export async function dismissInboxCase(contractId: string, note?: string): Promise<void> {
  if (!supabase) return
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return

  // snapshot ชื่อคนกดเคลียร์ จาก profiles (กัน spoof + ตรง pattern pinToInbox/follow_ups)
  const { data: profileData, error: profileErr } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('id', user.id)
    .maybeSingle()
  if (profileErr) throw profileErr
  const dismissedByName = (profileData as { full_name: string | null } | null)?.full_name ?? ''

  const { error } = await supabase.from('inbox_dismissals').upsert(
    {
      contract_id: contractId,
      dismissed_by_id: user.id,
      dismissed_by_name: dismissedByName,
      note: note ?? null,
      // ไม่ส่ง dismissed_at — trigger touch_inbox_dismissal บังคับ now() ทั้ง insert + update path
    },
    { onConflict: 'contract_id' },
  )
  if (error) throw error

  // เคลียร์ = เอาออกจากทุกแหล่ง → ลบ pin ด้วย (ถ้ามี)
  const { error: unpinErr } = await supabase
    .from('inbox_pins')
    .delete()
    .eq('contract_id', contractId)
  if (unpinErr) throw unpinErr
}

// ---------- clawback aggregates (Fix C — แก้ PAGE_CAP ค่าคอม clawback) ----------

/**
 * aggregate งวดล่าช้า/ค้างต่อสัญญา — มาจาก view v_clawback_status
 * ใช้แทน getAllInstallments() ในส่วนคิด clawback ของ buildCommissionReport
 * คืน ~2,400 แถว (1/สัญญา) ไม่ติด PAGE_CAP
 */
export interface ClawbackAggregate {
  contractId: string
  /** MIN(due_date) ของงวดที่จ่ายแล้วและจ่ายช้า (paid_at >= due_date+30d); null = ไม่มีงวดจ่ายช้า */
  earliestPaidLateDue: string | null
  /** installment_no ของ earliestPaidLateDue; null ถ้า earliestPaidLateDue null */
  earliestPaidLateNo: number | null
  /** MIN(due_date) ของงวดที่ยังไม่จ่าย; null = จ่ายครบแล้ว */
  oldestUnpaidDue: string | null
  /** installment_no ของ oldestUnpaidDue; null ถ้า oldestUnpaidDue null */
  oldestUnpaidNo: number | null
}

interface ClawbackAggregateRow {
  contract_id: string
  earliest_paid_late_due: string | null
  earliest_paid_late_no: number | null
  oldest_unpaid_due: string | null
  oldest_unpaid_no: number | null
}

function mapClawbackAggregate(r: ClawbackAggregateRow): ClawbackAggregate {
  return {
    contractId: r.contract_id,
    earliestPaidLateDue: r.earliest_paid_late_due ?? null,
    earliestPaidLateNo: r.earliest_paid_late_no != null ? Number(r.earliest_paid_late_no) : null,
    oldestUnpaidDue: r.oldest_unpaid_due ?? null,
    oldestUnpaidNo: r.oldest_unpaid_no != null ? Number(r.oldest_unpaid_no) : null,
  }
}

/**
 * ดึง aggregate งวดล่าช้า/ค้างจาก v_clawback_status (1 query, 1 แถว/สัญญา)
 * คืน Map<contractId, ClawbackAggregate> สำหรับ buildCommissionReport
 * range(0, 9999) รองรับถึง 10,000 สัญญา
 */
export async function getClawbackAggregates(): Promise<Map<string, ClawbackAggregate>> {
  if (!supabase) return new Map()
  const { data, error } = await supabase
    .from('v_clawback_status')
    .select('contract_id, earliest_paid_late_due, earliest_paid_late_no, oldest_unpaid_due, oldest_unpaid_no')
    .range(0, 9999)
  if (error) throw error
  const map = new Map<string, ClawbackAggregate>()
  for (const r of (data ?? []) as ClawbackAggregateRow[]) {
    map.set(r.contract_id, mapClawbackAggregate(r))
  }
  return map
}

// ===== Schedule Regen (Wave 2 — 2026-06-25) =====

/**
 * เรียก RPC regen_installments เพื่อสร้างตารางงวดใหม่
 * ถ้า DB raise 'blocked_extended' หรือ 'blocked_paid' → throw Error ข้อความนั้น
 * UI รับ error.message แล้ว map แสดงผล
 */
export async function regenerateInstallments(contractId: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.rpc('regen_installments', { p_contract_id: contractId })
  if (error) throw error
}

/**
 * ดึง contract_extensions ของสัญญาเดียว (เฉพาะ id) สำหรับป้อน regenSafety()
 * ใช้ getContractExtensions() ที่มีอยู่แล้วได้เลย — แต่ฟังก์ชันนี้ return เฉพาะ {id}
 * เพื่อให้ signature ตรงกับ regenSafety param และไม่ดึงข้อมูลเกิน
 */
export async function getContractExtensionIds(contractId: string): Promise<{ id: string }[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('contract_extensions')
    .select('id')
    .eq('contract_id', contractId)
    .limit(1)
  if (error) throw error
  return (data ?? []) as { id: string }[]
}

// ---------- PJ Recovery report — การตามหนี้ย้อนหลังจาก PJ (migration 0066) ----------
// อ่านจาก 4 aggregate views (1 แถว / รายเดือน / พนักงาน / bucket วันช้า)
// "recovered" = งวดจ่ายช้า ไม่ใช่แถวค่าปรับ — filter อยู่ใน view แล้ว
// ทุก view aggregate ฝั่ง DB → ไม่ติด PAGE_CAP; รองรับ isSupabaseConfigured=false

interface PjRecoverySummaryRow {
  late_contracts: string | number | null
  late_installments: string | number | null
  recovered_total: string | number | null
  avg_days_late: string | number | null
  max_days_late: string | number | null
}

interface PjRecoveryMonthRow {
  month: string
  installments: string | number | null
  contracts: string | number | null
  recovered_baht: string | number | null
}

interface PjRecoveryEmployeeRow {
  employee: string
  contracts: string | number | null
  late_installments: string | number | null
  recovered_baht: string | number | null
  avg_days_late: string | number | null
}

interface PjDaysLateBucketRow {
  bucket: string
  installments: string | number | null
  contracts: string | number | null
}

/**
 * สรุปรวมการตามหนี้จาก PJ (v_pj_recovery_summary — 1 แถว)
 * คืนค่าศูนย์ทั้งหมดถ้าไม่ได้ตั้ง Supabase หรือยังไม่มีข้อมูล
 */
export async function getPjRecoverySummary(): Promise<PjRecoverySummary> {
  const empty: PjRecoverySummary = {
    lateContracts: 0, lateInstallments: 0, recoveredTotal: 0, avgDaysLate: 0, maxDaysLate: 0,
  }
  if (!supabase) return empty
  const { data, error } = await supabase
    .from('v_recovery_summary')
    .select('late_contracts, late_installments, recovered_total, avg_days_late, max_days_late')
    .maybeSingle()
  if (error) throw error
  if (!data) return empty
  const r = data as PjRecoverySummaryRow
  return {
    lateContracts: Number(r.late_contracts ?? 0),
    lateInstallments: Number(r.late_installments ?? 0),
    recoveredTotal: Number(r.recovered_total ?? 0),
    avgDaysLate: Number(r.avg_days_late ?? 0),
    maxDaysLate: Number(r.max_days_late ?? 0),
  }
}

/** เงินตามกลับรายเดือน (v_pj_recovery_monthly — เรียงตามเดือนใน view) */
export async function getPjRecoveryMonthly(): Promise<PjRecoveryMonth[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('v_recovery_monthly')
    .select('month, installments, contracts, recovered_baht')
    .range(0, 999)
  if (error) throw error
  return ((data ?? []) as PjRecoveryMonthRow[]).map(r => ({
    month: r.month,
    installments: Number(r.installments ?? 0),
    contracts: Number(r.contracts ?? 0),
    recoveredBaht: Number(r.recovered_baht ?? 0),
  }))
}

/** เงินตามกลับแยกพนักงาน (v_pj_recovery_by_employee — เฉพาะเคสที่อยู่ใน DEBTFLOW) */
export async function getPjRecoveryByEmployee(): Promise<PjRecoveryEmployee[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('v_pj_recovery_by_employee')
    .select('employee, contracts, late_installments, recovered_baht, avg_days_late')
    .range(0, 999)
  if (error) throw error
  return ((data ?? []) as PjRecoveryEmployeeRow[]).map(r => ({
    employee: r.employee,
    contracts: Number(r.contracts ?? 0),
    lateInstallments: Number(r.late_installments ?? 0),
    recoveredBaht: Number(r.recovered_baht ?? 0),
    avgDaysLate: Number(r.avg_days_late ?? 0),
  }))
}

/** การกระจายวันช้าของงวด recovery (v_pj_days_late_dist) */
export async function getPjDaysLateDist(): Promise<PjDaysLateBucket[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('v_recovery_days_late_dist')
    .select('bucket, installments, contracts')
    .range(0, 999)
  if (error) throw error
  return ((data ?? []) as PjDaysLateBucketRow[]).map(r => ({
    bucket: r.bucket,
    installments: Number(r.installments ?? 0),
    contracts: Number(r.contracts ?? 0),
  }))
}

// ---------- PJ Recovery outcome — ตามเก็บได้ vs ยังเก็บไม่ได้ (migration 0067) ----------
// cohort ตามเดือนครบกำหนด (due_date): recovered (จ่ายช้าแล้วในที่สุดจ่าย) vs
// outstanding (เลยกำหนดแล้วยังไม่จ่าย) — filter แถวค่าปรับออกใน view แล้ว
// aggregate ฝั่ง DB → ไม่ติด PAGE_CAP; รองรับ isSupabaseConfigured=false

interface PjRecoveryOutcomeMonthRow {
  due_month: string
  recovered_installments: string | number | null
  recovered_baht: string | number | null
  outstanding_installments: string | number | null
  outstanding_baht: string | number | null
}

interface PjRecoveryOutcomeSummaryRow {
  recovered_installments: string | number | null
  recovered_baht: string | number | null
  outstanding_installments: string | number | null
  outstanding_baht: string | number | null
}

/** ตามเก็บได้ vs ยังเก็บไม่ได้ รายเดือนครบกำหนด (v_pj_recovery_outcome_monthly — เรียงตามเดือนใน view) */
export async function getPjRecoveryOutcomeMonthly(): Promise<PjRecoveryOutcomeMonth[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('v_recovery_outcome_monthly')
    .select('due_month, recovered_installments, recovered_baht, outstanding_installments, outstanding_baht')
    .range(0, 999)
  if (error) throw error
  return ((data ?? []) as PjRecoveryOutcomeMonthRow[]).map(r => ({
    month: r.due_month,
    recoveredInstallments: Number(r.recovered_installments ?? 0),
    recoveredBaht: Number(r.recovered_baht ?? 0),
    outstandingInstallments: Number(r.outstanding_installments ?? 0),
    outstandingBaht: Number(r.outstanding_baht ?? 0),
  }))
}

/**
 * สรุปรวม ตามเก็บได้ vs ยังเก็บไม่ได้ (v_pj_recovery_outcome_summary — 1 แถว)
 * คืนค่าศูนย์ทั้งหมดถ้าไม่ได้ตั้ง Supabase หรือยังไม่มีข้อมูล
 */
export async function getPjRecoveryOutcomeSummary(): Promise<PjRecoveryOutcomeSummary> {
  const empty: PjRecoveryOutcomeSummary = {
    recoveredInstallments: 0, recoveredBaht: 0, outstandingInstallments: 0, outstandingBaht: 0,
  }
  if (!supabase) return empty
  const { data, error } = await supabase
    .from('v_recovery_outcome_summary')
    .select('recovered_installments, recovered_baht, outstanding_installments, outstanding_baht')
    .maybeSingle()
  if (error) throw error
  if (!data) return empty
  const r = data as PjRecoveryOutcomeSummaryRow
  return {
    recoveredInstallments: Number(r.recovered_installments ?? 0),
    recoveredBaht: Number(r.recovered_baht ?? 0),
    outstandingInstallments: Number(r.outstanding_installments ?? 0),
    outstandingBaht: Number(r.outstanding_baht ?? 0),
  }
}

// ---------- Collection monthly — อัตราเก็บเงินย้อนหลังรายเดือน (migration 0102) ----------
// นับตามเดือนครบกำหนด (due_date): จ่ายแล้ว vs ยังค้าง — ไม่พึ่ง paid_at (ย้อนหลังมั่ว)
// นับเฉพาะงวดที่ due_date <= current_date (ตัดงวดอนาคตออกใน view แล้ว)
// aggregate ฝั่ง DB → ไม่ติด PAGE_CAP; รองรับ isSupabaseConfigured=false

interface VCollectionMonthlyRow {
  due_month: string | null
  total_installments: string | number | null
  paid_installments: string | number | null
  unpaid_installments: string | number | null
  collected_baht: string | number | null
  pct_collected: string | number | null
  active_total: string | number | null
  active_paid: string | number | null
  active_unpaid: string | number | null
  active_collected_baht: string | number | null
  active_pct_collected: string | number | null
}

/** อัตราเก็บเงินรายเดือนครบกำหนด (v_collection_monthly — เรียงตามเดือนใน view) */
export async function getCollectionMonthly(): Promise<CollectionMonthlyRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('v_collection_monthly')
    .select('due_month, total_installments, paid_installments, unpaid_installments, collected_baht, pct_collected, active_total, active_paid, active_unpaid, active_collected_baht, active_pct_collected')
    .range(0, 999)
  if (error) throw error
  return ((data ?? []) as VCollectionMonthlyRow[]).map(r => ({
    month: (r.due_month ?? '').slice(0, 7),   // 'YYYY-MM-DD' → 'YYYY-MM'
    total: Number(r.total_installments ?? 0),
    paid: Number(r.paid_installments ?? 0),
    unpaid: Number(r.unpaid_installments ?? 0),
    collectedBaht: Number(r.collected_baht ?? 0),
    pctCollected: Number(r.pct_collected ?? 0),
    activeTotal: Number(r.active_total ?? 0),
    activePaid: Number(r.active_paid ?? 0),
    activeUnpaid: Number(r.active_unpaid ?? 0),
    activeCollectedBaht: Number(r.active_collected_baht ?? 0),
    activePctCollected: Number(r.active_pct_collected ?? 0),  // null → 0
  }))
}

// ---------- Letter outcome report — วัดผลจดหมายติดตามหนี้ (migration 0069) ----------
// อ่านจาก 3 aggregate views: 1 แถวสรุปรวม / รายรอบ / รายฉบับ (drill-down)
// outcome คำนวณ auto ใน view (paid/returned/no_response) — ไม่มี trigger
// aggregate ฝั่ง DB → ไม่ติด PAGE_CAP; รองรับ isSupabaseConfigured=false

interface LetterOutcomeSummaryRow {
  total_letters: string | number | null
  paid_count: string | number | null
  returned_count: string | number | null
  no_response_count: string | number | null
  effective_count: string | number | null
  effectiveness_pct: string | number | null
  avg_days_to_outcome: string | number | null
}

interface LetterOutcomeByRoundRow {
  round: string | number | null
  paid_count: string | number | null
  returned_count: string | number | null
  no_response_count: string | number | null
  effective_count: string | number | null
  effectiveness_pct: string | number | null
  avg_days_to_outcome: string | number | null
}

interface LetterOutcomeRow {
  letter_id: string
  contract_id: string
  contract_no: string | null
  customer_name: string | null
  round: string | number | null
  printed_at: string
  outcome: string
  responded_at: string | null
  days_to_outcome: string | number | null
}

/**
 * สรุปรวมวัดผลจดหมายติดตามหนี้ (v_letter_outcome_summary — 1 แถว)
 * คืนค่าศูนย์ทั้งหมดถ้าไม่ได้ตั้ง Supabase หรือยังไม่มีจดหมาย
 */
export async function getLetterOutcomeSummary(): Promise<LetterOutcomeSummary | null> {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('v_letter_outcome_summary')
    .select('total_letters, paid_count, returned_count, no_response_count, effective_count, effectiveness_pct, avg_days_to_outcome')
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const r = data as LetterOutcomeSummaryRow
  return {
    totalLetters: Number(r.total_letters ?? 0),
    paidCount: Number(r.paid_count ?? 0),
    returnedCount: Number(r.returned_count ?? 0),
    noResponseCount: Number(r.no_response_count ?? 0),
    effectiveCount: Number(r.effective_count ?? 0),
    effectivenessPct: Number(r.effectiveness_pct ?? 0),
    avgDaysToOutcome: Number(r.avg_days_to_outcome ?? 0),
  }
}

/** วัดผลจดหมายแยกตามรอบ (v_letter_outcome_by_round — เรียงตาม round) */
export async function getLetterOutcomeByRound(): Promise<LetterOutcomeByRound[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('v_letter_outcome_by_round')
    .select('round, paid_count, returned_count, no_response_count, effective_count, effectiveness_pct, avg_days_to_outcome')
    .order('round')
  if (error) throw error
  return ((data ?? []) as LetterOutcomeByRoundRow[]).map(r => ({
    round: Number(r.round ?? 0),
    paidCount: Number(r.paid_count ?? 0),
    returnedCount: Number(r.returned_count ?? 0),
    noResponseCount: Number(r.no_response_count ?? 0),
    effectiveCount: Number(r.effective_count ?? 0),
    effectivenessPct: Number(r.effectiveness_pct ?? 0),
    avgDaysToOutcome: Number(r.avg_days_to_outcome ?? 0),
  }))
}

/** ผลลัพธ์รายจดหมาย สำหรับ drill-down (v_letter_outcomes — เรียง printed_at ล่าสุดก่อน) */
export async function getLetterOutcomes(): Promise<LetterOutcome[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('v_letter_outcomes')
    .select('letter_id, contract_id, contract_no, customer_name, round, printed_at, outcome, responded_at, days_to_outcome')
    .order('printed_at', { ascending: false })
  if (error) throw error
  return ((data ?? []) as LetterOutcomeRow[]).map(r => ({
    letterId: r.letter_id,
    contractId: r.contract_id,
    contractNo: r.contract_no ?? '',
    customerName: r.customer_name ?? '',
    round: Number(r.round ?? 0),
    printedAt: r.printed_at,
    outcome: (r.outcome as LetterOutcome['outcome']),
    respondedAt: r.responded_at,
    daysToOutcome: r.days_to_outcome === null ? null : Number(r.days_to_outcome),
  }))
}

// ===== รายงานการคืนเครื่อง (admin) — view 0073 =====

interface DeviceReturnReportViewRow {
  contract_id: string
  contract_no: string | null
  customer_name: string | null
  shop_id: string | null
  shop_name: string | null
  grade: string | null
  status: string
  return_date: string | null
  case_no: number | null
  device_status: string | null
  return_method: string | null
  total_installments: string | number | null
  paid_installments: string | number | null
  ever_paid: boolean | null
  principal_remaining: string | number | null
  collectible_remaining: string | number | null
  repair_cost: string | number | null
  resale: string | number | null
  device_price: string | number | null
}

interface ShopContractTotalRow {
  shop_id: string
  total_contracts: string | number | null
}

/** ดึงทุกสัญญาคืนเครื่อง (returned + returned_closed) สำหรับ buildReturnReport()
 *  ใช้ .range กัน PostgREST cap (เคสน้อยแต่กันไว้) + coerce ตัวเลขด้วย Number() */
export async function getDeviceReturnReportRows(): Promise<DeviceReturnReportRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('v_device_return_report')
    .select('contract_id, contract_no, customer_name, shop_id, shop_name, grade, status, return_date, case_no, device_status, return_method, total_installments, paid_installments, ever_paid, principal_remaining, collectible_remaining, repair_cost, resale, device_price')
    .range(0, PAGE_CAP)
  if (error) throw error
  return ((data ?? []) as DeviceReturnReportViewRow[]).map(r => ({
    contractId: r.contract_id,
    contractNo: r.contract_no ?? '-',
    customerName: r.customer_name ?? '-',
    shopId: r.shop_id,
    shopName: r.shop_name,
    grade: r.grade,
    status: (r.status as DeviceReturnReportRow['status']),
    returnDate: r.return_date,
    caseNo: r.case_no,
    deviceStatus: r.device_status,
    returnMethod: r.return_method,
    totalInstallments: Number(r.total_installments ?? 0),
    paidInstallments: Number(r.paid_installments ?? 0),
    everPaid: r.ever_paid === true,
    principalRemaining: Number(r.principal_remaining ?? 0),
    collectibleRemaining: Number(r.collectible_remaining) || 0,
    repairCost: Number(r.repair_cost ?? 0),
    resale: Number(r.resale ?? 0),
    devicePrice: Number(r.device_price ?? 0),
  }))
}

interface DeviceReturnByCollectorViewRow {
  contract_id: string
  return_date: string | null
  case_no: number | null
  device_price: string | number | null
  attributed_freelancer_id: string | null
}

/** รายงาน "พนักงานโทรตามเครื่องคืนได้กี่เคส/คน" — จำนวนเคส + มูลค่าเครื่องต่อคน ในช่วงวันที่เลือก
 *  Attribution = attributed_freelancer_id (mig 0035/0093, ตัวเดียวกับ commission ใช้อยู่) — "คนที่โทรจนลูกค้ายอมคืน"
 *  ไม่ใช่ assigned_to (คนถือเคส)
 *
 *  @param fromISO ขอบล่าง inclusive (>=), รูปแบบ ISO ('yyyy-MM-dd' หรือ timestamp เต็ม)
 *  @param toISO   ขอบบน exclusive (<) ตาม pattern since/until เดิมในไฟล์นี้ — ถ้าต้องการรวมทั้งวันสุดท้าย
 *                 ให้ caller ส่งเที่ยงคืนของ "วันถัดจากวันสุดท้าย"
 *
 *  18 เคสเก่า (returned_closed ก่อนมี device_returns) ที่ return_date = null จะไม่ถูกนับ
 *  (ไม่มีวันคืนจริงให้เทียบช่วง — ตรงตามเจตนา "รายงานตามช่วงวันที่คืน")
 */
export async function getDeviceReturnByCollector(fromISO: string, toISO: string): Promise<DeviceReturnByCollectorResult[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('v_device_return_report')
    .select('contract_id, return_date, case_no, device_price, attributed_freelancer_id')
    .gte('return_date', fromISO)
    .lt('return_date', toISO)
    .range(0, PAGE_CAP)
  if (error) throw error

  const rows = ((data ?? []) as DeviceReturnByCollectorViewRow[]).map((r) => ({
    contractId: r.contract_id,
    collectorId: r.attributed_freelancer_id,
    returnDate: r.return_date,
    caseNo: r.case_no,
    devicePrice: r.device_price == null ? null : Number(r.device_price),
  }))

  const employees = await getEmployees()
  const profileNames = new Map(employees.map((e) => [e.id, e.fullName]))

  return buildDeviceReturnByCollector(rows, profileNames)
}

/** นับสัญญาทั้งหมดต่อร้าน (ทุก status) — ตัวหารของอัตราคืนเครื่องต่อร้าน
 *  group by ทำที่ DB ผ่าน view v_shop_contract_totals (ไม่ดึงทุก contract มานับ client) */
export async function getShopContractTotals(): Promise<ShopContractTotal[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('v_shop_contract_totals')
    .select('shop_id, total_contracts')
    .range(0, PAGE_CAP)
  if (error) throw error
  return ((data ?? []) as ShopContractTotalRow[]).map(r => ({
    shopId: r.shop_id,
    total: Number(r.total_contracts ?? 0),
  }))
}

// ===== PJ auto-sync review box (migration 0077) =====

/** 1 receipt ดิบใน raw_json (array) — field ที่ใช้รวมค่าปรับ + uuid ต่อใบเสร็จ (migration 0100) */
interface PjRawReceipt {
  payment_type?: string | null
  amount?: string | number | null
  paid_date?: string | null
  invoice_no?: string | null
  uuid?: string | null
}

interface PjSyncReviewViewRow {
  id: string
  created_at: string
  pj_invoice_no: string
  pj_payment_type: string | null
  pj_amount: string | number | null
  pj_paid_date: string | null
  matched_contract_id: string | null
  reason: string
  status: string
  raw_json: PjRawReceipt[] | null
  contracts: { contract_no: string | null; customer_name: string | null } | null
}

/** parse จำนวนเงินที่เก็บเป็น string ("4,115.00") → number; ว่าง/พังคืน 0 */
function parsePjAmount(v: string | number | null | undefined): number {
  if (v == null) return 0
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

/** รวม amount ของ receipt ที่ payment_type='penalty' ใน raw_json (ว่าง/พัง = 0) */
function sumPjPenalty(raw: PjRawReceipt[] | null | undefined): number {
  if (!Array.isArray(raw)) return 0
  return raw.reduce(
    (sum, r) => (r?.payment_type === 'penalty' ? sum + parsePjAmount(r.amount) : sum),
    0,
  )
}

/** ดึง uuid ดิบต่อใบเสร็จทุกตัวจาก raw_json (migration 0100 pj_applied_receipts ใช้เป็น dedup key) — [] ถ้าไม่มี */
function extractPjReceiptUuids(raw: PjRawReceipt[] | null | undefined): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map(r => (r?.uuid ? String(r.uuid).trim() : null))
    .filter((u): u is string => !!u)
}

// ===== เป้าหมายงวดค่าปรับ (18 ก.ค. 2026, mig 0115/0116) =====
// mirror ตรงตัวของ target-selection ใน record_payment_spread (0115):
//   งวดเก่าสุด (installment_no น้อยสุด) ที่ penalty_amount > penalty_paid_for_installment(id)
//   ไม่มี → fallback งวด unpaid (paid_at is null) แรกสุด
// ใช้ใน getPjReviewContext (อ่านอย่างเดียว — อธิบาย "ระบบเราคิดเท่าไร" ในหน้าจอกล่องรอตรวจ)
// (ถอดออกจาก applyPjReviewPayment 18 ก.ค. 2026 — align penalty_amount ตาม PJ ซ้ำซ้อนกับ mig 0116 + ปัญหาสิทธิ์ staff)

/** 1 งวดที่เป็นตัวเลือกเป้าหมายค่าปรับ — ต้องเรียงมาแล้วตาม installment_no ascending ก่อนส่งเข้าฟังก์ชันนี้ */
interface PenaltyTargetCandidate {
  id: string
  installmentNo: number
  dueDate: string
  paidAt: string | null
  penaltyAmount: number
}

function pickPenaltyTargetInstallment(
  rows: PenaltyTargetCandidate[],
  eventsById: Map<string, PenaltyPayEvent[]>,
): PenaltyTargetCandidate | null {
  const withPenaltyOwed = rows.find(
    r => r.penaltyAmount > penaltyPaidForInstallment(eventsById.get(r.id) ?? []),
  )
  if (withPenaltyOwed) return withPenaltyOwed
  const firstUnpaid = rows.find(r => r.paidAt === null)
  return firstUnpaid ?? null
}

interface PjPenaltyLogRow {
  installment_id: string | null
  action: string
  penalty_paid_amount: string | number | null
  created_at: string
}

/** group payment_log (action pay/cancel) ต่องวด → PenaltyPayEvent[] ไว้ป้อน penaltyPaidForInstallment/computePenaltyAccrual */
function groupPenaltyEventsByInstallment(rows: PjPenaltyLogRow[]): Map<string, PenaltyPayEvent[]> {
  const map = new Map<string, PenaltyPayEvent[]>()
  for (const r of rows) {
    if (!r.installment_id) continue
    const list = map.get(r.installment_id) ?? []
    list.push({
      action: r.action as 'pay' | 'cancel',
      penaltyPaidAmount: parsePjAmount(r.penalty_paid_amount),
      createdAt: r.created_at,
    })
    map.set(r.installment_id, list)
  }
  return map
}

/** วันนี้ (UTC yyyy-mm-dd) — ใช้เทียบกับ due_date แบบเดียวกับ computePenaltyAccrual/utcDayDiff (calc.ts) */
function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10)
}

interface PjSyncRunViewRow {
  id: string
  started_at: string
  finished_at: string | null
  status: string
  receipts_fetched: number | null
  auto_applied_count: number | null
  auto_applied_amount: string | number | null
  review_count: number | null
  error_detail: string | null
}

/** กล่องรอตรวจ PJ — เคสที่ auto-sync ลงไม่ได้ (default = pending) join contracts โชว์เลขสัญญา+ชื่อลูกค้า */
export async function getPjSyncReview(
  status: PjSyncReviewRow['status'] = 'pending',
): Promise<PjSyncReviewRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('pj_sync_review')
    .select('id, created_at, pj_invoice_no, pj_payment_type, pj_amount, pj_paid_date, matched_contract_id, reason, status, raw_json, contracts(contract_no, customer_name)')
    .eq('status', status)
    .order('created_at', { ascending: false })
    .range(0, PAGE_CAP)
  if (error) throw error
  return ((data ?? []) as unknown as PjSyncReviewViewRow[]).map(r => ({
    id: r.id,
    createdAt: r.created_at,
    invoiceNo: r.pj_invoice_no,
    paymentType: r.pj_payment_type,
    amount: Number(r.pj_amount ?? 0),
    paidDate: r.pj_paid_date,
    contractId: r.matched_contract_id,
    contractNo: r.contracts?.contract_no ?? null,
    customerName: r.contracts?.customer_name ?? null,
    reason: (r.reason as PjSyncReviewRow['reason']),
    status: (r.status as PjSyncReviewRow['status']),
    penaltyAmount: sumPjPenalty(r.raw_json),
    receiptUuids: extractPjReceiptUuids(r.raw_json),
  }))
}

/** 1 แถวดิบเฉพาะที่ต้องใช้ parse drift snapshot (reason + raw_json เท่านั้น) */
interface PjSyncReviewDriftViewRow {
  reason: string
  raw_json: unknown
}

/**
 * ดึงรายละเอียด drift (เราถือ X / PJ ว่า Y) ของ 1 แถวในกล่องรอตรวจ — คืน null ถ้าแถวนี้ไม่ใช่ reason
 * drift (RECEIPT_MISSING/RECEIPT_CHANGED) หรือ raw_json ไม่ตรง shape ที่ล็อกไว้ (มี.ย. 2026)
 *
 * ⚠️ ไม่ได้เพิ่มลง PjSyncReviewRow ใน types.ts ตรงๆ (types.ts เป็นไฟล์ที่แบมทำเสร็จแล้ว ห้ามแตะรอบนี้) —
 * แยกเป็นฟังก์ชันเรียกเพิ่มแทน (query แยก 1 ก้อนเบาๆ ต่อแถวที่ต้องดูรายละเอียด ไม่ใช่ join ทุกแถวใน
 * getPjSyncReview เพราะแถวส่วนใหญ่ไม่ใช่ reason drift) น้องวิวเรียกใช้ตอนกดดูรายละเอียดแถว drift ในกล่องรอตรวจ
 * shape ของ raw_json ล็อกแล้วที่ src/lib/pjReceiptDrift.ts (PjReceiptDriftSnapshot) — เขียนโดย
 * migration 0114 (RPC reconcile_pj_receipts) เท่านั้น ไม่มี caller อื่นเขียน field นี้
 */
export async function getPjReceiptDriftDetail(reviewId: string): Promise<PjReceiptDriftSnapshot | null> {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('pj_sync_review')
    .select('reason, raw_json')
    .eq('id', reviewId)
    .maybeSingle()
  if (error) throw error
  const row = data as PjSyncReviewDriftViewRow | null
  if (!row || (row.reason !== 'RECEIPT_MISSING' && row.reason !== 'RECEIPT_CHANGED')) return null

  const raw = row.raw_json as Partial<PjReceiptDriftSnapshot> | null
  if (!raw || typeof raw !== 'object' || !raw.kind || !raw.checkedAt || !raw.ours) return null
  return {
    kind: raw.kind,
    checkedAt: raw.checkedAt,
    missingStreak: raw.missingStreak ?? 0,
    ours: raw.ours,
    pj: raw.pj ?? null,
  }
}

/** รอบการรัน auto-sync ล่าสุด (default 20 รอบ) — โชว์สถานะ + แจ้งเตือนเมื่อรอบล่าสุดพัง */
export async function getPjSyncRuns(limit = 20): Promise<PjSyncRunRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('pj_sync_runs')
    .select('id, started_at, finished_at, status, receipts_fetched, auto_applied_count, auto_applied_amount, review_count, error_detail')
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return ((data ?? []) as PjSyncRunViewRow[]).map(r => ({
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: (r.status as PjSyncRunRow['status']),
    receiptsFetched: Number(r.receipts_fetched ?? 0),
    autoAppliedCount: Number(r.auto_applied_count ?? 0),
    autoAppliedAmount: Number(r.auto_applied_amount ?? 0),
    reviewCount: Number(r.review_count ?? 0),
    errorDetail: r.error_detail,
  }))
}

/** ยืนยัน/ข้ามเคสในกล่องรอตรวจ — set status + resolved_by/at + note (RLS อนุญาตเฉพาะ admin) */
export async function resolvePjReviewItem(
  id: string,
  action: 'resolved' | 'skipped',
  byName: string,
  note?: string,
): Promise<void> {
  if (!supabase) return
  const { error } = await supabase
    .from('pj_sync_review')
    .update({
      status: action,
      resolved_by: byName,
      resolved_at: new Date().toISOString(),
      resolution_note: note ?? null,
    })
    .eq('id', id)
  if (error) throw error
}

// ---- บริบทประกอบการตัดสินใจในกล่องรอตรวจ (งวดถัดไป + ยอดรวม + ประวัติชำระ) ----

interface PjCtxInstallmentRow {
  id: string
  installment_no: number
  amount: string | number | null
  paid_amount: string | number | null
  status: string
  penalty_amount: string | number | null
  paid_at: string | null
  due_date: string
}

interface PjCtxPaymentRow {
  installment_id: string | null
  amount: string | number | null
  penalty_paid_amount: string | number | null
  by_name: string | null
  created_at: string
}

/** แถวอื่นของสัญญาเดียวกันที่ยังค้างในกล่องรอตรวจ (status='pending') */
interface PjSiblingReviewRow {
  id: string
  pj_paid_date: string | null
  pj_amount: string | number | null
  reason: string
  raw_json: PjRawReceipt[] | null
}

/**
 * บริบทของสัญญาที่ผูกกับเคสในกล่องรอตรวจ — ช่วยให้คนตรวจเห็นงวดถัดไป/ยอดรวม/ประวัติ
 * ไม่มี supabase → คืนค่าว่าง graceful
 */
export async function getPjReviewContext(contractId: string): Promise<PjReviewContext> {
  const empty: PjReviewContext = {
    monthly: 0,
    nextUnpaid: null,
    totalPaid: 0,
    totalDue: 0,
    recentPayments: [],
    unpaidInstallments: [],
    siblingReviewRows: [],
    penaltyTarget: null,
  }
  if (!supabase) return empty

  const [contractRes, instRes, payRes, siblingRes, penaltyLogRes] = await Promise.all([
    supabase.from('contracts').select('monthly_payment').eq('id', contractId).maybeSingle(),
    supabase
      .from('installments')
      .select('id, installment_no, amount, paid_amount, status, penalty_amount, paid_at, due_date')
      .eq('contract_id', contractId)
      .order('installment_no'),
    supabase
      .from('payment_log')
      .select('installment_id, amount, penalty_paid_amount, by_name, created_at')
      .eq('contract_id', contractId)
      .eq('action', 'pay')
      .order('created_at', { ascending: false })
      .limit(8),
    supabase
      .from('pj_sync_review')
      .select('id, pj_paid_date, pj_amount, reason, raw_json')
      .eq('matched_contract_id', contractId)
      .eq('status', 'pending')
      .order('pj_paid_date', { ascending: false }),
    // (18 ก.ค. 2026) 1 query เพิ่ม — ประวัติ pay/cancel เต็มของทุกงวดในสัญญานี้ ไว้หาเป้าหมายค่าปรับ
    // (pickPenaltyTargetInstallment) เหมือน record_payment_spread ตัดสินใจ — payRes ด้านบน limit 8 ไม่พอ
    supabase
      .from('payment_log')
      .select('installment_id, action, penalty_paid_amount, created_at')
      .eq('contract_id', contractId)
      .in('action', ['pay', 'cancel'])
      .order('created_at', { ascending: true }),
  ])
  if (contractRes.error) throw contractRes.error
  if (instRes.error) throw instRes.error
  if (payRes.error) throw payRes.error
  if (siblingRes.error) throw siblingRes.error
  if (penaltyLogRes.error) throw penaltyLogRes.error

  const instRows = (instRes.data ?? []) as PjCtxInstallmentRow[]

  // งวดแรกที่ยังไม่จ่าย (รายการเรียงตาม installment_no แล้ว)
  const firstOpen = instRows.find(r => r.status === 'pending' || r.status === 'late')
  let nextUnpaid: PjReviewContext['nextUnpaid'] = null
  if (firstOpen) {
    const amt = parsePjAmount(firstOpen.amount)
    const paid = parsePjAmount(firstOpen.paid_amount)
    nextUnpaid = {
      id: firstOpen.id,
      no: firstOpen.installment_no,
      amount: amt,
      paid,
      remaining: Math.max(amt - paid, 0),
    }
  }

  const totalDue = instRows.reduce((s, r) => s + parsePjAmount(r.amount), 0)
  const totalPaid = instRows.reduce((s, r) => s + parsePjAmount(r.paid_amount), 0)

  // map installment_id → installment_no สำหรับประวัติชำระ
  const instNoById = new Map<string, number>()
  for (const r of instRows) instNoById.set(r.id, r.installment_no)

  const recentPayments = ((payRes.data ?? []) as PjCtxPaymentRow[]).map(r => ({
    date: (r.created_at ?? '').slice(0, 10),
    principal: parsePjAmount(r.amount),
    penalty: parsePjAmount(r.penalty_paid_amount),
    byName: r.by_name ?? '',
    installmentNo: r.installment_id ? instNoById.get(r.installment_id) ?? null : null,
  }))

  // งวดที่ยังไม่จ่าย เรียง installment_no — ไว้พรีวิวการตัดของ record_payment_spread + เทียบยอดแปลก (pjReviewDup.ts)
  const unpaidInstallments = instRows
    .filter(r => r.status === 'pending' || r.status === 'late')
    .map(r => ({
      no: r.installment_no,
      amount: parsePjAmount(r.amount),
      remaining: Math.max(parsePjAmount(r.amount) - parsePjAmount(r.paid_amount), 0),
    }))

  // แถวอื่น (pending) ในกล่องรอตรวจของสัญญาเดียวกัน — ไว้เช็คซ้ำ/บริบท (pjReviewDup.ts)
  const siblingReviewRows = ((siblingRes.data ?? []) as PjSiblingReviewRow[]).map(r => ({
    id: r.id,
    paidDate: r.pj_paid_date,
    amount: parsePjAmount(r.pj_amount),
    penaltyAmount: sumPjPenalty(r.raw_json),
    reason: r.reason as PjSyncReviewRow['reason'],
  }))

  // งวดเป้าหมายค่าปรับ (18 ก.ค. 2026) — เลียนแบบ record_payment_spread (0115), ค่าปรับ "ระบบเราคิด"
  // จาก penalty_accrual_for_installment (0116, mirror ผ่าน computePenaltyAccrual ฝั่ง TS)
  const penaltyEventsByInst = groupPenaltyEventsByInstallment((penaltyLogRes.data ?? []) as PjPenaltyLogRow[])
  const penaltyCandidates: PenaltyTargetCandidate[] = instRows.map(r => ({
    id: r.id,
    installmentNo: r.installment_no,
    dueDate: r.due_date,
    paidAt: r.paid_at,
    penaltyAmount: parsePjAmount(r.penalty_amount),
  }))
  const penaltyTargetRow = pickPenaltyTargetInstallment(penaltyCandidates, penaltyEventsByInst)
  let penaltyTarget: PjReviewContext['penaltyTarget'] = null
  if (penaltyTargetRow) {
    const targetEvents = penaltyEventsByInst.get(penaltyTargetRow.id) ?? []
    const accrual = computePenaltyAccrual({
      dueDate: penaltyTargetRow.dueDate,
      paidAt: penaltyTargetRow.paidAt,
      events: targetEvents,
      today: todayUtcDate(),
    })
    penaltyTarget = {
      installmentNo: penaltyTargetRow.installmentNo,
      chargedPenalty: accrual.penaltyAmount,
      penaltyPaid: penaltyPaidForInstallment(targetEvents),
      settled: accrual.settled,
    }
  }

  return {
    monthly: parsePjAmount((contractRes.data as { monthly_payment: string | number | null } | null)?.monthly_payment),
    nextUnpaid,
    totalPaid,
    totalDue,
    recentPayments,
    unpaidInstallments,
    siblingReviewRows,
    penaltyTarget,
  }
}

/**
 * ลงยอดจากกล่องรอตรวจ PJ — กระจายชำระหลายงวด แล้ว resolve เคสในกล่อง
 * ใช้ record_payment_spread (0079) แทน record_payment_with_penalty (0040)
 * เพื่อรองรับยอดโอนที่ครอบคลุมมากกว่า 1 งวด
 *
 * ⚠️ p_paid_at = paidDate + 'T00:00:00.000Z' (UTC midnight, ลงท้าย Z เสมอ)
 *    ห้ามใช้ +07:00 — timestamptz เก็บ UTC, +07:00 จะเลื่อนเป็นวันก่อนหน้า พัง idempotency
 * rpc error → throw ก่อน resolve (ไม่ปิดเคสถ้าลงยอดไม่สำเร็จ)
 *
 * ⚠️ p_receipt_uuids (migration 0100, ติ๊ก review RED fix): ดึง uuid ต่อใบเสร็จจาก raw_json ของแถวใน
 *    กล่องรอตรวจ "ก่อน" เรียก RPC แล้วส่งเข้าไปพร้อมกัน — ให้ RPC insert pj_applied_receipts ใน
 *    transaction เดียวกับ payment_log/installments (atomic) เหมือน path auto-sync ใน pj-sync/index.ts
 *    ห้ามแยก insert หลัง RPC เป็นคนละ tx อีก (เดิมทำแบบนั้น → insert fail แล้ว uuid ไม่ถูกจด → auto-sync
 *    รอบถัดไปเห็นว่ายังไม่เคยลง → apply ซ้ำ = เงินเบิ้ล) — ถ้าอ่าน raw_json ไม่สำเร็จ (best-effort)
 *    ยังส่ง null ต่อได้ตามปกติ (แค่ไม่มี uuid ไว้กัน auto-sync ซ้ำ ไม่กระทบการลงเงินหลัก)
 *
 * (ถอดออก 18 ก.ค. 2026) เดิมมีขั้น "align penalty_amount ตาม PJ" ผ่าน admin_set_installment_penalty
 *    หลัง record_payment_spread สำเร็จ — ถอดออกเพราะ (1) admin_set_installment_penalty บังคับ is_admin()
 *    (0096) แต่หน้ากล่องรอตรวจเปิดให้ staff ใช้ด้วย → align เงียบๆ fail ไม่มีผลจริง (2) migration 0116
 *    (run_daily_update + penalty_accrual_for_installment) auto-settle penalty_amount ให้ตรงยอดจ่ายจริงอยู่
 *    แล้วทุกวันผ่าน cron ไม่ต้อง override มือซ้ำ (3) admin_set_installment_penalty ตั้ง
 *    penalty_overridden=true ถาวร → freeze งวดนั้นไม่ให้ 0116 แตะอีกเลย ซึ่งไม่จำเป็น
 */
export async function applyPjReviewPayment(params: {
  reviewId: string
  contractId: string
  principal: number
  penalty: number
  paidDate: string // 'YYYY-MM-DD'
  byName: string
  note?: string
}): Promise<void> {
  if (!supabase) return
  const { reviewId, contractId, principal, penalty, paidDate, byName, note } = params

  // 🚨 กันชั้นสอง (defense in depth, migration 0114 landmine 3) — ห้ามลงยอดจากเคส drift (ใบเสร็จ PJ
  // ที่หาย/ถูกแก้ — reason RECEIPT_MISSING/RECEIPT_CHANGED) เด็ดขาด ต่อให้ UI ซ่อนปุ่มแล้ว (น้องวิว) ก็ต้อง
  // กันที่ db.ts ด้วย เผื่อบั๊ก UI ในอนาคต/เรียกตรงจาก console — เคสนี้ "ตรวจ+รายงานเท่านั้น" (Pete locked)
  // ต้องไปให้แอดมินตรวจสอบใน PJ มือ ไม่ใช่กดยืนยันลงยอดซ้ำ (จะลงเงินผีซ้ำเข้าไปอีก) — throw ไม่ swallow
  // (18 ก.ค. 2026) รวม query เดียวกับที่เคยแยกอ่าน raw_json ด้านล่าง — ประหยัด 1 round-trip
  // pj_payment_type ยังใช้เติม payment_type fallback ใน receiptUuidsPayload ด้านล่าง
  const { data: reviewRow, error: reviewRowErr } = await supabase
    .from('pj_sync_review')
    .select('reason, pj_invoice_no, pj_payment_type, raw_json')
    .eq('id', reviewId)
    .maybeSingle()
  if (reviewRowErr) throw reviewRowErr
  if (reviewRow?.reason === 'RECEIPT_MISSING' || reviewRow?.reason === 'RECEIPT_CHANGED') {
    throw new Error('เคสนี้เป็นใบเสร็จ PJ ที่หาย/ถูกแก้ (drift) — ห้ามยืนยันลงยอด ให้แอดมินตรวจสอบใน PJ ก่อนแล้วจัดการมือ')
  }

  // ดึง uuid ต่อใบเสร็จจาก raw_json "ก่อน" เรียก RPC (read-only ไม่กระทบ atomicity ของการลงเงิน)
  let receiptUuidsPayload:
    | { uuid: string; invoice_no: string | null; paid_date: string | null; amount: number; payment_type: string | null; source: string }[]
    | null = null
  try {
    const rawReceipts = (reviewRow?.raw_json ?? []) as PjRawReceipt[]
    const receiptsFound = Array.isArray(rawReceipts) ? rawReceipts.filter(r => r?.uuid) : []
    if (receiptsFound.length > 0) {
      receiptUuidsPayload = receiptsFound.map(r => ({
        uuid:         String(r.uuid),
        invoice_no:   reviewRow?.pj_invoice_no ?? null,
        paid_date:    paidDate || null,
        amount:       parsePjAmount(r.amount),
        payment_type: r.payment_type ?? reviewRow?.pj_payment_type ?? null,
        source:       'review',
      }))
    }
  } catch { /* best-effort อ่าน raw_json — ไม่มี uuid ก็ยังลงเงินได้ปกติ แค่ไม่มี exact-dedup เสริม */ }

  const { error } = await supabase.rpc('record_payment_spread', {
    p_contract_id:    contractId,
    p_principal:      principal,
    p_penalty:        penalty,
    p_paid_at:        `${paidDate}T00:00:00.000Z`,
    p_by_name:        byName,
    p_receipt_uuids:  receiptUuidsPayload,
  })
  if (error) throw error

  // จด ledger กันลงซ้ำ (legacy safety net คนละกลไกจาก pj_applied_receipts — คงไว้เหมือนเดิม ห้ามลบ
  // แยก tx เหมือนเดิมทุกประการ ไม่ใช่ scope ของ atomic fix รอบนี้): cron รอบถัดไป (< DEDUP_CUTOFF ใน
  // pj-sync/index.ts) เจอ ledger → ข้าม ไม่ลงซ้ำ (best-effort)
  if (paidDate) {
    try {
      await supabase.from('pj_applied_ledger').upsert({
        contract_id:  contractId,
        pj_paid_date: paidDate,
        inst_amount:  principal,
        pen_amount:   penalty,
        source:       'review',
        applied_at:   new Date().toISOString(),
      }, { onConflict: 'contract_id,pj_paid_date' })
    } catch { /* best-effort — ไม่บล็อก flow หลัก */ }
  }

  await resolvePjReviewItem(reviewId, 'resolved', byName, note ?? 'ลงยอดจากกล่องรอตรวจ')
}

/**
 * ลงเงินจากกล่องรอตรวจ PJ เป็น "รายได้อื่นๆ" (other_income, migration 0054) แทนค่างวด/ค่าปรับ
 * ใช้กับยอดที่ PJ ตัดเป็นค่างวด/ค่าปรับแต่จริงๆ ไม่ใช่ (เช่น ค่าส่งกล่องพัสดุ, ค่าเปลี่ยนวันชำระ)
 * ไม่แตะ installments/payment_log เลย — insert other_income แล้ว resolve แถวในกล่องเท่านั้น
 *
 * 🚨 ห้ามเขียน pj_applied_ledger จาก path นี้เด็ดขาด — ต่างจาก applyPjReviewPayment ด้านบน
 *    ledger กันซ้ำของ auto-sync คีย์แค่ (contract_id, pj_paid_date) ไม่สนยอด/ประเภท
 *    ถ้าวันเดียวกันมีค่างวดจริงจ่ายเข้ามาด้วย (คนละรายการ) แล้วเราเขียน ledger จาก other-income ไปก่อน
 *    cron รอบถัดไปจะเห็น ledger มี entry ของวันนั้นแล้ว → skip ค่างวดจริงทิ้งไปเงียบๆ (เงินหาย)
 *    การกันซ้ำของทางนี้ใช้แค่ "แถว pj_sync_review.status = resolved" พอ — getPjSyncReview('pending')
 *    กรอง status อยู่แล้ว จึงไม่มีทางถูกหยิบมาประมวลผลซ้ำจากกล่องรอตรวจ
 */
export async function applyPjReviewAsOtherIncome(params: {
  reviewId: string
  contractId: string
  amount: number
  category: string    // หมวดรายได้อื่นๆ free-text เช่น 'ค่าส่งกล่องพัสดุ', 'ค่าเปลี่ยนวันที่ชำระ'
  receivedAt: string  // 'YYYY-MM-DD' วันรับเงินจริง — ปกติใช้ row.paidDate จากกล่องรอตรวจ
  note?: string
  byName: string
  feeKind?: FeeKind | null // tag ค่าธรรมเนียมสิทธิ์ (migration 0106) — ถ้ายอดนี้คือค่าเปลี่ยนวัน/ขยายงวด/ปิดด่วน
}): Promise<void> {
  if (!supabase) return
  const { reviewId, contractId, amount, category, receivedAt, note, byName, feeKind } = params

  // 🚨 กันชั้นสอง (defense in depth, migration 0114 landmine 3) — ดู comment เต็มใน applyPjReviewPayment
  // ด้านบน เหตุผลเดียวกัน: ห้ามลงยอด (แม้เป็นรายได้อื่นๆ) จากเคส drift เด็ดขาด — throw ไม่ swallow
  const { data: driftGuardRow, error: driftGuardErr } = await supabase
    .from('pj_sync_review')
    .select('reason')
    .eq('id', reviewId)
    .maybeSingle()
  if (driftGuardErr) throw driftGuardErr
  if (driftGuardRow?.reason === 'RECEIPT_MISSING' || driftGuardRow?.reason === 'RECEIPT_CHANGED') {
    throw new Error('เคสนี้เป็นใบเสร็จ PJ ที่หาย/ถูกแก้ (drift) — ห้ามลงเป็นรายได้อื่นๆ ให้แอดมินตรวจสอบใน PJ ก่อนแล้วจัดการมือ')
  }

  await insertOtherIncome({
    contractId,
    amount,
    category,
    note,
    receivedAt,
    recordedBy: byName,
    feeKind: feeKind ?? null,
  })

  await resolvePjReviewItem(
    reviewId,
    'resolved',
    byName,
    note ? `ลงเป็นรายได้อื่นๆ (${category}): ${note}` : `ลงเป็นรายได้อื่นๆ (${category})`,
  )
}

// ---------- Freelancer HR report (migration 0108) ----------

/** time 'HH:MM:SS' (PostgREST) → 'HH:MM' ; null คงเป็น null */
function toHhmm(t: string | null): string | null {
  return t ? t.slice(0, 5) : null
}

/** 1 แถวต่อ (author × วัน) จาก RPC get_freelancer_hr_by_day — int/bigint มาเป็น number|string จาก PostgREST */
interface HrByDayViewRow {
  author_id: string
  author_name: string | null
  day: string
  logs_total: number | string
  cases_touched: number | string
  first_activity: string | null
  last_activity: string | null
  morning_count: number | string
  afternoon_count: number | string
  evening_count: number | string
  reached_count: number | string
  attempts_count: number | string
  debtor_count: number | string
  other_count: number | string
  demands_count: number | string
  promises_made: number | string
}

export type HrByDayRow = {
  authorId: string
  authorName: string
  day: string // 'YYYY-MM-DD'
  logsTotal: number
  casesTouched: number
  firstActivity: string | null // 'HH:MM'
  lastActivity: string | null // 'HH:MM'
  morningCount: number
  afternoonCount: number
  eveningCount: number
  reachedCount: number
  attemptsCount: number
  debtorCount: number
  otherCount: number
  demandsCount: number
  promisesMade: number
}

/**
 * รายงาน HR ทีมฟรีแลนซ์ — สรุป 1 แถวต่อ (คน × วัน) ตามช่วงวัน [start, end] (RPC 0108)
 * frontend นำไป roll up เป็นรายคนเอง. guard is_admin/is_staff/is_executive — freelancer/anon เห็น 0 rows
 * @param startISO วันเริ่ม 'YYYY-MM-DD' (inclusive)
 * @param endISO   วันสุดท้าย 'YYYY-MM-DD' (inclusive)
 */
export async function getFreelancerHrByDay(
  startISO: string,
  endISO: string,
): Promise<HrByDayRow[]> {
  if (!supabase) return []

  const { data, error } = await supabase
    .rpc('get_freelancer_hr_by_day', { p_start: startISO, p_end: endISO })
  if (error) throw error

  return ((data ?? []) as HrByDayViewRow[]).map((r) => ({
    authorId: r.author_id,
    authorName: r.author_name ?? '-',
    day: r.day,
    logsTotal: Number(r.logs_total),
    casesTouched: Number(r.cases_touched),
    firstActivity: toHhmm(r.first_activity),
    lastActivity: toHhmm(r.last_activity),
    morningCount: Number(r.morning_count),
    afternoonCount: Number(r.afternoon_count),
    eveningCount: Number(r.evening_count),
    reachedCount: Number(r.reached_count),
    attemptsCount: Number(r.attempts_count),
    debtorCount: Number(r.debtor_count),
    otherCount: Number(r.other_count),
    demandsCount: Number(r.demands_count),
    promisesMade: Number(r.promises_made),
  }))
}

/** 1 แถวต่อ follow_up จาก RPC get_freelancer_hr_daily_log */
interface HrDailyLogViewRow {
  id: string
  created_at: string
  contract_id: string
  contract_no: string | null
  customer_name: string | null
  contact_method: string | null
  contact_target: string | null
  contact_person_name: string | null
  contact_person_relation: string | null
  follow_up_result: string | null
  next_follow_up_at: string | null
  promised_amount: number | string | null
  counts_as_demand: boolean
  note_text: string | null
}

export type HrDailyLogRow = {
  id: string
  createdAt: string
  contractId: string
  contractNo: string | null
  customerName: string | null
  contactMethod: string
  contactTarget: string
  contactPersonName: string | null
  contactPersonRelation: string | null
  followUpResult: string
  nextFollowUpAt: string | null
  promisedAmount: number | null
  countsAsDemand: boolean
  noteText: string
}

/**
 * รายงาน HR — drill-down รายเคสของคนคนเดียว ตามช่วงวัน [start, end] (RPC 0108)
 * guard is_admin/is_staff/is_executive — freelancer/anon เห็น 0 rows
 * @param authorId uuid ของ freelancer ที่ต้องการดู
 * @param startISO วันเริ่ม 'YYYY-MM-DD' (inclusive)
 * @param endISO   วันสุดท้าย 'YYYY-MM-DD' (inclusive)
 */
export async function getFreelancerHrDailyLog(
  authorId: string,
  startISO: string,
  endISO: string,
): Promise<HrDailyLogRow[]> {
  if (!supabase) return []

  const { data, error } = await supabase
    .rpc('get_freelancer_hr_daily_log', { p_author: authorId, p_start: startISO, p_end: endISO })
  if (error) throw error

  return ((data ?? []) as HrDailyLogViewRow[]).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    contractId: r.contract_id,
    contractNo: r.contract_no,
    customerName: r.customer_name,
    contactMethod: r.contact_method ?? '',
    contactTarget: r.contact_target ?? '',
    contactPersonName: r.contact_person_name,
    contactPersonRelation: r.contact_person_relation,
    followUpResult: r.follow_up_result ?? '',
    nextFollowUpAt: r.next_follow_up_at,
    promisedAmount: r.promised_amount == null ? null : Number(r.promised_amount),
    countsAsDemand: r.counts_as_demand,
    noteText: r.note_text ?? '',
  }))
}
