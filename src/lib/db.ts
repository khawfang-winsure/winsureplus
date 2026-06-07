// ===== ชั้นกลางเข้าถึงข้อมูล (Data Layer) =====
// หน้าเว็บเรียกฟังก์ชันในไฟล์นี้เสมอ — ภายในจะเลือกเองว่าจะดึงจาก Supabase จริง
// หรือใช้ข้อมูลตัวอย่าง (mock) ตามว่าใส่กุญแจใน .env แล้วหรือยัง
import { supabase } from './supabase'
import type {
  Contract,
  ContractStatusRow,
  DeviceReturnRow,
  Installment,
  Option,
  OverdueBucket,
  Shop,
} from './types'
import * as mock from './mockData'

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
  customer_name: string
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
    customerName: r.customer_name,
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
    customer_name: c.customerName,
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

export async function insertContract(c: Omit<Contract, 'id'>): Promise<void> {
  if (!supabase) {
    // โหมด mock — ยังไม่บันทึกจริง
    return
  }
  const { error } = await supabase.from('contracts').insert(toInsert(c))
  if (error) throw error
}

export async function getContract(id: string): Promise<Contract | null> {
  if (!supabase) return mock.contracts.find((c) => c.id === id) ?? null
  const { data, error } = await supabase.from('contracts').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data ? mapContract(data as ContractRow) : null
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

export async function markInstallmentPaid(installmentId: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.rpc('mark_installment_paid', { p_installment_id: installmentId })
  if (error) throw error
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

// ---------- สิทธิ์ผู้ใช้ ----------
export type Role = 'admin' | 'staff'

export async function getMyProfile(): Promise<{ role: Role } | null> {
  if (!supabase) return { role: 'admin' } // โหมด mock เปิดสิทธิ์เต็มเพื่อทดลอง UI
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null
  const { data } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle()
  return { role: (data?.role as Role) ?? 'staff' }
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
