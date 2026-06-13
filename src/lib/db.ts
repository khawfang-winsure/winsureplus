// ===== ชั้นกลางเข้าถึงข้อมูล (Data Layer) =====
// หน้าเว็บเรียกฟังก์ชันในไฟล์นี้เสมอ — ภายในจะเลือกเองว่าจะดึงจาก Supabase จริง
// หรือใช้ข้อมูลตัวอย่าง (mock) ตามว่าใส่กุญแจใน .env แล้วหรือยัง
import { supabase } from './supabase'
import type {
  Contract,
  ContractStatus,
  ContractStatusRow,
  DeviceReturnRow,
  Installment,
  NotificationItem,
  Option,
  OverdueBucket,
  Shop,
} from './types'
import * as mock from './mockData'
import {
  DEFAULT_TIERS,
  DEFAULT_RECRUIT_BONUS,
  DEFAULT_RECRUIT_TIERS,
  type CommissionTier,
  type RecruitBonusRule,
  type RecruitTier,
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
  const { data, error } = await supabase.from('shops').select('*').order('code')
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
  const { error } = await supabase
    .from('contracts')
    .update({
      summary_sent_at: new Date().toISOString(),
      summary_sent_by: senderName ?? null,
    })
    .in('id', ids)
  if (error) throw error
}

/** ทำเครื่องหมายว่าส่งอีเมลแล้ว (กันส่งซ้ำ)
 *  @param senderName ชื่อผู้ส่ง (useAuth().name = full_name) — optional เพื่อ backward compat
 *                    น้องวิวส่ง name จาก useAuth() ในหน้า WaitingEmail */
export async function markEmailSent(id: string, senderName?: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase
    .from('contracts')
    .update({
      email_sent_at: new Date().toISOString(),
      email_sent_by: senderName ?? null,
    })
    .eq('id', id)
  if (error) throw error
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
  const { data, error } = await supabase.from('contracts').select('contract_no').eq('shop_id', shopId)
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

export async function updateContract(id: string, c: Omit<Contract, 'id'>): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from('contracts').update(toInsert(c)).eq('id', id)
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

/** ดึงงวดทั้งหมด (ทุกสัญญา) — ใช้ตรวจประวัติล่าช้า (ค่าคอม) + มูลค่าชำระ/คงค้าง (dashboard) */
export async function getAllInstallments(): Promise<InstallmentLite[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('installments')
    .select('contract_id, installment_no, due_date, paid_at, amount, paid_amount')
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

/** ดึง payment_log ทั้งหมด (เฉพาะ field ที่ใช้รวมยอดรับชำระรายเดือน) */
export async function getAllPayments(): Promise<PaymentLite[]> {
  if (!supabase) return []
  const { data, error } = await supabase.from('payment_log').select('action, amount, created_at')
  if (error) throw error
  return (data ?? []).map((r) => ({
    action: r.action as 'pay' | 'edit' | 'cancel',
    amount: Number(r.amount ?? 0),
    createdAt: r.created_at as string,
  }))
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
  if (error) throw error
  return ((data ?? []) as StatusRow[]).map(mapStatus)
}

/** สถานะของทุกสัญญา (สำหรับหน้าภาพรวม) */
export async function getAllStatuses(): Promise<ContractStatusRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase.from('v_contract_status').select('*')
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
  if (error) throw error
  return ((data ?? []) as StatusRow[]).map(mapStatus)
}

// ---------- คืนเครื่อง (Phase 5) ----------
export interface ReturnInput {
  caseNo: 1 | 2 | 3
  lastInstallmentPaid: boolean
  penaltyPaid: boolean
  repairFee: number
}

export async function submitReturn(contractId: string, input: ReturnInput): Promise<void> {
  if (!supabase) return
  // กรณี 3 = ชำระครบ+ค่าซ่อมแล้ว -> ปิดสัญญาสมบูรณ์, อื่นๆ = คืนเครื่อง (รอ)
  const newStatus = input.caseNo === 3 ? 'returned_closed' : 'returned'
  const { error: e1 } = await supabase.from('device_returns').insert({
    contract_id: contractId,
    case_no: input.caseNo,
    last_installment_paid: input.lastInstallmentPaid,
    penalty_paid: input.penaltyPaid,
    repair_fee: input.repairFee || 0,
    checked_at: input.caseNo === 3 ? new Date().toISOString() : null,
  })
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
}

export async function getReturns(filter?: { deviceStatus?: DeviceStatus | 'all' }): Promise<DeviceReturnRow[]> {
  if (!supabase) return []
  let query = supabase
    .from('device_returns')
    .select('*, contracts(contract_no, customer_name, model, storage)')
    .order('created_at', { ascending: false })
  if (filter?.deviceStatus && filter.deviceStatus !== 'all') {
    query = query.eq('device_status', filter.deviceStatus)
  }
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
  const { data, error } = await supabase.from('profiles').select('id, full_name').order('full_name')
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

/** ที่อยู่ทุกสัญญา (สำหรับหน้าส่งจดหมาย) → { contractId: { current, id_card, ... } } */
export async function getAllAddresses(): Promise<Record<string, ContractAddresses>> {
  if (!supabase) return {}
  const { data, error } = await supabase.from('customer_addresses').select('*')
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
  const { data, error } = await supabase.from('collection_letters').select('*').order('printed_at')
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

export interface FollowUpEntry {
  id: string
  contractId: string
  authorId: string
  authorName: string
  noteText: string
  contactMethod: FollowUpContactMethod
  followUpResult: FollowUpResult
  nextFollowUpAt: string | null
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
  // ดึงจาก v_contract_status (status=active, bucket != normal)
  const { data: statusData, error: statusError } = await supabase
    .from('v_contract_status')
    .select('contract_id, contract_no, customer_name, shop_id, shop_name, days_late, penalty_due, grade, remaining_installments')
    .eq('status', 'active')
    .neq('bucket', 'normal')
    .in('grade', grades)
    .order('days_late', { ascending: false })
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
  if (contractError) throw contractError

  const contractMap = new Map(
    ((contractData ?? []) as QueueContractRow[]).map((c) => [c.id, c]),
  )

  // Query 4: installments ที่ยังไม่ปิด (paid_at IS NULL) เพื่อคำนวณ principalDue per contract
  // principalDue = sum(amount - coalesce(paid_amount, 0)) ของงวดยังไม่ปิด
  // NOTE: ถ้า queue ขนาดใหญ่ query นี้อาจถึง PostgREST row-cap (1000) → aggregate view เป็น fix ที่แท้จริง
  //   ตอนนี้ queue จำกัดด้วย RLS grade-scope → จำนวนงวดควรอยู่ในช่วงปลอดภัย
  const { data: instData, error: instErr } = await supabase
    .from('installments')
    .select('contract_id, amount, paid_amount')
    .in('contract_id', ids)
    .is('paid_at', null)
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

  // Query 3: aggregate follow_ups ย้อนหลัง 90 วัน (single round-trip)
  // successfulAttempts = result IN ('contacted','promised','paid','returned','other')
  // (ไม่นับ 'no_answer', 'refused', หรือ null — ตรงกับ v_follow_up_stats_90d ใน 0020)
  const since = new Date(Date.now() - 90 * 86400 * 1000).toISOString()
  // todayBkk: วันที่ปัจจุบันตาม Bangkok timezone (UTC+7) ในรูป yyyy-mm-dd
  const todayBkk = (() => {
    const d = new Date(Date.now() + 7 * 3600 * 1000)
    return d.toISOString().slice(0, 10)
  })()
  const { data: followUpsData, error: fuErr } = await supabase
    .from('follow_ups')
    .select('contract_id, follow_up_result, created_at, author_name')
    .in('contract_id', ids)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
  if (fuErr) throw fuErr

  // Client-side reduce: สร้าง aggregate map per contract_id
  type FuAgg = {
    totalAttempts: number
    successfulAttempts: number
    lastResult: FollowUpResult | null
    lastContactedAt: string | null
    contactedToday: boolean
    lastContactedByName: string | null
  }
  const fuMap = new Map<string, FuAgg>()
  for (const fu of (followUpsData ?? []) as {
    contract_id: string
    follow_up_result: FollowUpResult | null
    created_at: string
    author_name: string | null
  }[]) {
    const agg = fuMap.get(fu.contract_id) ?? {
      totalAttempts: 0,
      successfulAttempts: 0,
      lastResult: null,
      lastContactedAt: null,
      contactedToday: false,
      lastContactedByName: null,
    }
    agg.totalAttempts++
    // successfulAttempts: ตาม priorityQueue.ts line 17 — result ∈ {contacted, promised, paid, returned, other}
    // ไม่นับ 'no_answer' (ไม่ติดต่อได้) และ 'refused' (ปฏิเสธ) และ null (ไม่ระบุ)
    // ความแตกต่างจาก contactedToday: contactedToday ใช้ result !== 'no_answer' (PDPA daily-cap semantics)
    if (
      fu.follow_up_result === 'contacted' ||
      fu.follow_up_result === 'promised' ||
      fu.follow_up_result === 'paid' ||
      fu.follow_up_result === 'returned' ||
      fu.follow_up_result === 'other'
    ) {
      agg.successfulAttempts++
    }
    // lastResult + lastContactedAt + lastContactedByName: ใช้แถวแรก (order desc → ล่าสุดอยู่หน้า)
    if (agg.lastResult === null) {
      agg.lastResult = fu.follow_up_result
      agg.lastContactedAt = fu.created_at
      agg.lastContactedByName = fu.author_name
    }
    // contactedToday: ต้อง shift created_at เป็น Bangkok ก่อนเทียบ (กัน off-by-one)
    if (!agg.contactedToday && fu.follow_up_result !== 'no_answer') {
      // ตัด timezone offset +07:00 ออก → เหลือ date part ใน Bangkok
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
    }
    const termMonths = Number(c?.term_months ?? 0)
    const statusRemaining = r.remaining_installments ?? 0
    const installmentsPaid = Math.max(0, termMonths - statusRemaining)
    const modelParts = [c?.model, c?.storage].filter(Boolean)
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
  let contractQuery = supabase
    .from('contracts')
    .select('id, contract_no, shop_id, model, storage, status, monthly_payment, term_months, created_at')

  if (nationalId) {
    contractQuery = contractQuery.eq('national_id', nationalId)
  } else if (phone) {
    contractQuery = contractQuery.eq('customer_name', customerName).eq('phone', phone)
  } else {
    contractQuery = contractQuery.eq('customer_name', customerName)
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
