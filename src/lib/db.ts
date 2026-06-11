// ===== ชั้นกลางเข้าถึงข้อมูล (Data Layer) =====
// หน้าเว็บเรียกฟังก์ชันในไฟล์นี้เสมอ — ภายในจะเลือกเองว่าจะดึงจาก Supabase จริง
// หรือใช้ข้อมูลตัวอย่าง (mock) ตามว่าใส่กุญแจใน .env แล้วหรือยัง
import { supabase } from './supabase'
import type {
  Contract,
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
  email_sent_at: string | null
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
    emailSentAt: r.email_sent_at,
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

/** ทำเครื่องหมายว่าสรุปยอดแล้ว (กันส่งซ้ำ) — บันทึกลง DB จริง */
export async function markSummarySent(ids: string[]): Promise<void> {
  if (!supabase || ids.length === 0) return
  const { error } = await supabase
    .from('contracts')
    .update({ summary_sent_at: new Date().toISOString() })
    .in('id', ids)
  if (error) throw error
}

/** ทำเครื่องหมายว่าส่งอีเมลแล้ว (กันส่งซ้ำ) */
export async function markEmailSent(id: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase
    .from('contracts')
    .update({ email_sent_at: new Date().toISOString() })
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
  contracts: { contract_no: string; customer_name: string } | null
}

export async function getReturns(): Promise<DeviceReturnRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('device_returns')
    .select('*, contracts(contract_no, customer_name)')
    .order('created_at', { ascending: false })
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
  }))
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
export type Role = 'admin' | 'staff'

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

export async function createAdminUser(input: { email: string; password: string; fullName: string; role: Role }): Promise<void> {
  await callAdminUsers({ action: 'create', ...input })
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
