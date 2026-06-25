// ===== ชั้นกลางเข้าถึงข้อมูล (Data Layer) =====
// หน้าเว็บเรียกฟังก์ชันในไฟล์นี้เสมอ — ภายในจะเลือกเองว่าจะดึงจาก Supabase จริง
// หรือใช้ข้อมูลตัวอย่าง (mock) ตามว่าใส่กุญแจใน .env แล้วหรือยัง
import { supabase } from './supabase'
import type {
  AuditEvent,
  AuditEventType,
  Contract,
  ContractStatus,
  ContractStatusRow,
  DebtflowByEmployee,
  DebtflowByGrade,
  DebtflowByStatus,
  DebtflowCase,
  DebtflowSummary,
  DeviceReturnRow,
  ExtraCharge,
  GradeChangeType,
  GradeMonthlyChange,
  Installment,
  NotificationItem,
  Option,
  OtherIncome,
  OverdueBucket,
  OverduePromiseContract,
  PrivateNote,
  Shop,
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
import type { AddressKind, CustomerAddress, LetterRecord, LetterReply } from './letters'
import type { DeviceStatus } from './returnWorkflow'

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
    createdAt: r.created_at,
  }
}

/** แปลงข้อมูลจากฟอร์ม -> object สำหรับ insert (เฉพาะคอลัมน์พื้นฐาน; ยอดที่คำนวณ DB ทำเอง) */
function toInsert(c: Omit<Contract, 'id'>) {
  return {
    contract_no: c.contractNo,
    inv_no: c.invNo || null,
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
      // auto-clear รอเอกสาร เมื่อยืนยันส่งเมล (confirm-gate model 0049)
      pending_documents: false,
      documents_confirmed_at: now,
      documents_confirmed_by: senderName ?? null,
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

export async function getContract(id: string): Promise<Contract | null> {
  if (!supabase) return mock.contracts.find((c) => c.id === id) ?? null
  const { data, error } = await supabase.from('contracts').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data ? mapContract(data as ContractRow) : null
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

/** payload สำหรับ UPDATE — ตรงกับ toInsert แต่ไม่มี doc-tracking fields
 *  (original_docs_received, has_phone_box, pending_documents)
 *  เพื่อกันการรีเซ็ตสถานะรับเอกสาร/กล่องทุกครั้งที่กดแก้ไขสัญญา */
function toUpdate(c: Omit<Contract, 'id'>) {
  return {
    contract_no: c.contractNo,
    inv_no: c.invNo || null,
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
  note: string | null
  by_name: string | null
  created_at: string
}

/** ประวัติการชำระทั้งหมดของสัญญา (ใหม่ → เก่า) */
export async function getPaymentLog(contractId: string): Promise<PaymentLogEntry[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('payment_log')
    .select('id, installment_id, action, amount, paid_amount_after, note, by_name, created_at')
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

/** ลูกค้าที่ใกล้/ถึงวันครบกำหนด (next_due ตั้งแต่วันนี้ถึง +7 วัน) */
export async function getDueSoon(): Promise<ContractStatusRow[]> {
  if (!supabase) return []
  const today = new Date()
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const in7 = new Date(today)
  in7.setDate(in7.getDate() + 7)
  const { data, error } = await supabase
    .from('v_contract_status')
    .select('*')
    .eq('status', 'active')
    .gte('next_due', iso(today))
    .lte('next_due', iso(in7))
    .order('next_due')
    .range(0, PAGE_CAP)
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
  contracts: { contract_no: string; customer_name: string; model: string | null; storage: string | null } | null
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
    .select('*, contracts(contract_no, customer_name, model, storage), attributed_freelancer:profiles!attributed_freelancer_id(full_name)')
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
export type Role = 'admin' | 'staff' | 'freelancer' | 'executive'

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
  // --- Wave 3 (0047 Collaboration Hub) ---
  latestOtherAuthorAt: string | null  // MAX created_at ของ follow_up ที่ author ≠ ตัวเอง (ใน 90-day window)
  myLastTouchAt: string | null        // MAX(queue_case_seen.last_seen_at, MAX created_at ที่ author = ตัวเอง)
  latestNote: string | null           // note_text ของ follow_up ล่าสุดสุด (ทุก author, ใน window)
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
}

interface QueueContractRow {
  id: string
  phone: string | null
  phone_alt1: string | null
  phone_alt2: string | null
  model: string | null
  storage: string | null
  monthly_payment: number | null
  term_months: number | null
  current_grade: string | null
  dnc: boolean
  lawyer_engaged: boolean
  disputed: boolean
  promise_to_pay_date: string | null
  promised_amount: number | null
}

export async function getFreelancerQueue(grades: ContractGrade[]): Promise<FreelancerQueueRow[]> {
  if (!supabase || grades.length === 0) return []

  // ดึง uid ของผู้ใช้ปัจจุบัน — ใช้ในการแยก my vs other author (Wave 3)
  const {
    data: { user: currentUser },
  } = await supabase.auth.getUser()
  const myUid = currentUser?.id ?? null

  // ดึงจาก v_contract_status (status=active, bucket != normal)
  const { data: statusData, error: statusError } = await supabase
    .from('v_contract_status')
    .select('contract_id, contract_no, customer_name, shop_id, shop_name, days_late, penalty_due, grade, remaining_installments')
    .eq('status', 'active')
    .neq('bucket', 'normal')
    .in('grade', grades)
    .order('days_late', { ascending: false })
    .range(0, PAGE_CAP)
  if (statusError) throw statusError

  const statusRows = (statusData ?? []) as QueueStatusRow[]
  if (statusRows.length === 0) return []

  // ดึง phone + model + monthly_payment + promise fields จาก contracts
  const ids = statusRows.map((r) => r.contract_id)
  const { data: contractData, error: contractError } = await supabase
    .from('contracts')
    .select(
      'id, phone, phone_alt1, phone_alt2, model, storage, monthly_payment, term_months, current_grade, dnc, lawyer_engaged, disputed, promise_to_pay_date, promised_amount',
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
    .select('contract_id, follow_up_result, created_at, author_name, author_id, note_text')
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

    // successfulAttempts: result ∈ {contacted, promised, paid, returned, other, line_pending}
    // ไม่นับ 'no_answer' (ไม่ติดต่อได้) และ 'refused' (ปฏิเสธ) และ null (ไม่ระบุ)
    // 0047: line_pending นับเป็น "ติดต่อสำเร็จ" (Pete decision — inbound ลูกค้า initiate)
    if (
      fu.follow_up_result === 'contacted' ||
      fu.follow_up_result === 'promised' ||
      fu.follow_up_result === 'paid' ||
      fu.follow_up_result === 'returned' ||
      fu.follow_up_result === 'other' ||
      fu.follow_up_result === 'line_pending'
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
    if (!agg.contactedToday && fu.follow_up_result !== 'no_answer') {
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

  return statusRows.map((r): FreelancerQueueRow => {
    const c = contractMap.get(r.contract_id)
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
    }
  })
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
      upd.documents_confirmed_at = null
      upd.documents_confirmed_by = null
    }
  }
  // pendingDocItems: แก้รายการเอกสารที่รอ — ไม่ trigger bounce-back (Pete: "แก้ list เฉยๆ ไม่เด้งคิว")
  if (patch.pendingDocItems !== undefined) {
    upd.pending_doc_items = patch.pendingDocItems
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
  }
}

/** รายได้อื่นๆ ของสัญญาหนึ่ง (ใหม่ → เก่า) */
export async function getOtherIncome(contractId: string): Promise<OtherIncome[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('other_income')
    .select('id, contract_id, amount, category, note, received_at, recorded_by, created_at')
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
    .select('id, contract_id, amount, category, note, received_at, recorded_by, created_at')
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
}): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from('other_income').insert({
    contract_id: input.contractId ?? null,
    amount: input.amount,
    category: input.category,
    note: input.note ?? null,
    received_at: input.receivedAt,
    recorded_by: input.recordedBy ?? null,
  })
  if (error) throw error
}

/** ลบรายได้อื่นๆ (admin only ตาม RLS migration 0054) */
export async function deleteOtherIncome(id: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from('other_income').delete().eq('id', id)
  if (error) throw error
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
 * Return type ตั้งชื่อว่า SaleHistoryInput เพื่อรอ reconcile กับ src/lib/saleHistory.ts ที่แบมจะเขียน
 *
 * NOTE commissionPaid = 0 เสมอ — ไม่มีตาราง commission_disbursements ใน DB
 * commission คำนวณจาก commission.ts (แบม pure function) ไม่ใช่จาก DB column
 *
 * NOTE downPayment = device_price * down_percent / 100 (คำนวณจาก 2 columns, ไม่มี down_payment column)
 * ถ้าแบมต้องการสูตรอื่น → แก้ที่ saleHistory.ts ได้โดยไม่ต้องแตะ helper นี้
 *
 * NOTE ถ้า saleHistory.ts ของแบมมี type SaleHistoryInput ที่ต่างจากนี้ → ครีมต้อง reconcile field names
 */
export interface SaleHistoryInput {
  contractId: string
  contractNo: string
  customerName: string
  shopId: string
  shopName: string
  deviceModel: string         // model + storage รวม เช่น "iPhone 15 Pro 256GB"
  deviceListPrice: number     // finance_amount (ยอดจัดไฟแนนซ์)
  commissionPaid: number      // 0 เสมอ — ไม่มี disbursement table (ดู NOTE ด้านบน)
  downPayment: number         // device_price * down_percent / 100
  customerPaidPrincipal: number  // sum(amount - coalesce(penalty_paid_amount,0)) จาก payment_log action='pay'
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
    .select('id, contract_no, customer_name, shop_id, model, storage, finance_amount, device_price, down_percent')
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

  // Step 4: payment_log — sum principal paid per contract
  // principal = amount - coalesce(penalty_paid_amount, 0) (migration 0034)
  // รวมเฉพาะ action='pay'
  const { data: payData, error: payErr } = await supabase
    .from('payment_log')
    .select('contract_id, amount, penalty_paid_amount')
    .in('contract_id', contractIds)
    .eq('action', 'pay')
    .range(0, PAGE_CAP)
  if (payErr) throw payErr

  // Client-side aggregate: sum(amount - coalesce(penalty_paid_amount,0)) per contract_id
  const principalMap = new Map<string, number>()
  for (const row of (payData ?? []) as {
    contract_id: string
    amount: number | null
    penalty_paid_amount: number | null
  }[]) {
    const prev = principalMap.get(row.contract_id) ?? 0
    const principal = Number(row.amount ?? 0) - Number(row.penalty_paid_amount ?? 0)
    principalMap.set(row.contract_id, prev + Math.max(0, principal))
  }

  // Step 5: assemble
  return returns.map((ret): SaleHistoryInput => {
    const c = contractMap.get(ret.contract_id)
    const devicePrice = Number(c?.device_price ?? 0)
    const downPercent = Number(c?.down_percent ?? 0)
    const modelParts = [c?.model, c?.storage].filter(Boolean)
    return {
      contractId: ret.contract_id,
      contractNo: c?.contract_no ?? '-',
      customerName: c?.customer_name ?? '-',
      shopId: c?.shop_id ?? '',
      shopName: c?.shop_id ? (shopNameMap.get(c.shop_id) ?? '-') : '-',
      deviceModel: modelParts.join(' '),
      deviceListPrice: Number(c?.finance_amount ?? 0),
      commissionPaid: 0, // ไม่มีตาราง disbursement — แบมคำนวณจาก commission.ts
      downPayment: Math.round((devicePrice * downPercent) / 100),
      customerPaidPrincipal: principalMap.get(ret.contract_id) ?? 0,
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
}

/**
 * ดึงเคสในกล่องรับงาน (Inbox) ของ admin/staff:
 * membership = (follow_up ล่าสุดของสัญญา result='line_pending') OR (มี row ใน inbox_pins)
 * เฉพาะสัญญา status='active', เรียง daysLate DESC
 *
 * การดึงข้อมูล:
 *   Step 1: inbox_pins ทั้งหมด (pinned contracts + metadata)
 *   Step 2: follow_ups ล่าสุดต่อสัญญา (ทุก active contract) ที่ last_result = 'line_pending'
 *           — ใช้ v_follow_up_stats_90d.last_result เพื่อลด round-trip
 *   Step 3: ดึง contract details + status สำหรับ union ของ ids
 *   Step 4: ดึง note ล่าสุดต่อสัญญา (follow_ups 1 แถวต่อ contract)
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

  // union: pinned OR line_pending
  const allIds = Array.from(new Set([...pinnedIds, ...linePendingIds]))
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
    .select('id, phone, promise_to_pay_date')
    .in('id', activeIds)
    .range(0, PAGE_CAP)
  if (contractErr) throw contractErr

  const contractMap = new Map(
    ((contractData ?? []) as { id: string; phone: string | null; promise_to_pay_date: string | null }[]).map(
      (c) => [c.id, c],
    ),
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
  }[]).map((r): InboxCase => {
    const c = contractMap.get(r.contract_id)
    const note = latestNoteMap.get(r.contract_id)
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
      promiseToPayDate: c?.promise_to_pay_date ?? null,
      pinned: pinnedIds.has(r.contract_id),
    }
  })
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

// ===== DEBTFLOW import (migration 0064) =====

interface DebtflowCaseRow {
  id: string
  contract_id: string | null
  source_inv: string
  customer_name: string | null
  due_date: string | null
  days_late: number | null
  grade: string | null
  primary_phone: string | null
  call_status: string | null
  phone_alt1: string | null
  phone_alt2: string | null
  device_status: string | null
  conversation_note: string | null
  promise_date: string | null
  assigned_employee: string | null
  payment_status: string | null
  installment_amount: number | null
  cumulative_paid: number | null
  date_added: string | null
  last_update: string | null
  imported_at: string
  // join field (ถ้า select contracts(contract_no)) — supabase-js คืน array แม้ join FK
  contracts?: { contract_no: string }[] | null
}

function mapDebtflowCase(r: DebtflowCaseRow): DebtflowCase {
  return {
    id: r.id,
    contractId: r.contract_id ?? null,
    contractNo: r.contracts?.[0]?.contract_no ?? null,
    sourceInv: r.source_inv,
    customerName: r.customer_name ?? null,
    dueDate: r.due_date ?? null,
    daysLate: r.days_late != null ? Number(r.days_late) : null,
    grade: r.grade ?? null,
    primaryPhone: r.primary_phone ?? null,
    callStatus: r.call_status ?? null,
    phoneAlt1: r.phone_alt1 ?? null,
    phoneAlt2: r.phone_alt2 ?? null,
    deviceStatus: r.device_status ?? null,
    conversationNote: r.conversation_note ?? null,
    promiseDate: r.promise_date ?? null,
    assignedEmployee: r.assigned_employee ?? null,
    paymentStatus: r.payment_status ?? null,
    installmentAmount: r.installment_amount != null ? Number(r.installment_amount) : null,
    cumulativePaid: r.cumulative_paid != null ? Number(r.cumulative_paid) : null,
    dateAdded: r.date_added ?? null,
    lastUpdate: r.last_update ?? null,
    importedAt: r.imported_at,
  }
}

/**
 * รายการเคส DEBTFLOW ทั้งหมด (admin only ตาม RLS)
 * join contracts.contract_no เพื่อให้ Wave 2 แสดงเลขสัญญาของระบบ
 * 450 เคส ไม่เกิน PAGE_CAP — range(0, 999) ไว้กันถ้ามีเพิ่มในอนาคต
 */
export async function getDebtflowCases(): Promise<DebtflowCase[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('debtflow_cases')
    .select(`
      id, contract_id, source_inv,
      customer_name, due_date, days_late, grade,
      primary_phone, call_status, phone_alt1, phone_alt2,
      device_status, conversation_note, promise_date,
      assigned_employee, payment_status,
      installment_amount, cumulative_paid,
      date_added, last_update, imported_at,
      contracts(contract_no)
    `)
    .order('days_late', { ascending: false })
    .range(0, 999)
  if (error) throw error
  return ((data ?? []) as DebtflowCaseRow[]).map(mapDebtflowCase)
}

/**
 * สรุป aggregate ของ DEBTFLOW batch สำหรับหน้ารายงาน
 * aggregate ฝั่ง DB ผ่าน query แยก — กัน PAGE_CAP / ไม่ดึง raw rows มา client
 */
export async function getDebtflowSummary(): Promise<DebtflowSummary> {
  if (!supabase) {
    return {
      totalCases: 0, totalCollected: 0, closedCases: 0,
      byEmployee: [], byGrade: [], byPaymentStatus: [],
    }
  }

  // query 1: totals
  const { data: totalsData, error: totalsErr } = await supabase
    .from('debtflow_cases')
    .select('cumulative_paid, payment_status')
    .range(0, 999)
  if (totalsErr) throw totalsErr

  const rows = (totalsData ?? []) as { cumulative_paid: number | null; payment_status: string | null }[]
  const totalCases = rows.length
  const totalCollected = rows.reduce((s, r) => s + (Number(r.cumulative_paid) || 0), 0)
  const closedCases = rows.filter(r => r.payment_status === 'ชำระเงินครบแล้ว').length

  // query 2: by employee
  const { data: empData, error: empErr } = await supabase
    .from('debtflow_cases')
    .select('assigned_employee, cumulative_paid, payment_status')
    .range(0, 999)
  if (empErr) throw empErr

  const empMap = new Map<string, { cases: number; collected: number; closed: number }>()
  for (const r of (empData ?? []) as { assigned_employee: string | null; cumulative_paid: number | null; payment_status: string | null }[]) {
    const key = r.assigned_employee || '(ไม่ระบุ)'
    const cur = empMap.get(key) ?? { cases: 0, collected: 0, closed: 0 }
    cur.cases++
    cur.collected += Number(r.cumulative_paid) || 0
    if (r.payment_status === 'ชำระเงินครบแล้ว') cur.closed++
    empMap.set(key, cur)
  }
  const byEmployee: DebtflowByEmployee[] = Array.from(empMap.entries())
    .map(([employee, v]) => ({ employee, ...v }))
    .sort((a, b) => b.collected - a.collected)

  // query 3: by grade
  const { data: gradeData, error: gradeErr } = await supabase
    .from('debtflow_cases')
    .select('grade, cumulative_paid')
    .range(0, 999)
  if (gradeErr) throw gradeErr

  const gradeMap = new Map<string, { cases: number; collected: number }>()
  for (const r of (gradeData ?? []) as { grade: string | null; cumulative_paid: number | null }[]) {
    const key = r.grade || '(ไม่ระบุ)'
    const cur = gradeMap.get(key) ?? { cases: 0, collected: 0 }
    cur.cases++
    cur.collected += Number(r.cumulative_paid) || 0
    gradeMap.set(key, cur)
  }
  const byGrade: DebtflowByGrade[] = Array.from(gradeMap.entries())
    .map(([grade, v]) => ({ grade, ...v }))
    .sort((a, b) => a.grade.localeCompare(b.grade))

  // query 4: by payment status
  const statusMap = new Map<string, number>()
  for (const r of rows) {
    const key = r.payment_status || '(ไม่ระบุ)'
    statusMap.set(key, (statusMap.get(key) ?? 0) + 1)
  }
  const byPaymentStatus: DebtflowByStatus[] = Array.from(statusMap.entries())
    .map(([status, n]) => ({ status, n }))
    .sort((a, b) => b.n - a.n)

  return { totalCases, totalCollected, closedCases, byEmployee, byGrade, byPaymentStatus }
}
