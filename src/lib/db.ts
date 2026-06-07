// ===== ชั้นกลางเข้าถึงข้อมูล (Data Layer) =====
// หน้าเว็บเรียกฟังก์ชันในไฟล์นี้เสมอ — ภายในจะเลือกเองว่าจะดึงจาก Supabase จริง
// หรือใช้ข้อมูลตัวอย่าง (mock) ตามว่าใส่กุญแจใน .env แล้วหรือยัง
import { supabase } from './supabase'
import type { Contract, Option, Shop } from './types'
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
