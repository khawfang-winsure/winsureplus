// ===== เรียก Edge Function `credit-check` จากหน้าเว็บสาธารณะของร้าน (check.html) =====
// ตั้งใจไม่ import supabase-js / db.ts / auth.tsx เลย — คุยกับ Edge Function ตรงด้วย fetch() เท่านั้น
// (กันหน้านี้ลาก staff bundle/DB layer มาด้วย ตาม scope Wave 2)
// อ้างอิง credit-check-api-contract.md (ครีม 2026-09-23) — คีย์ JSON ที่ส่ง/รับต้องตรงกับ Edge Function
// ที่น้องชีสเขียนคู่ขนานกันตามสัญญาเดียวกันนี้

import type { AttachedFileKind, CustomerType, DeviceCondition, OccupationType } from '../lib/creditCheck'
import { CONSENT_VERSION } from './consent'

const FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/credit-check`
const PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export type ApiErrorKind = 'unauthorized' | 'rate_limited' | 'network' | 'server'

export class ApiError extends Error {
  kind: ApiErrorKind
  constructor(kind: ApiErrorKind, message: string) {
    super(message)
    this.kind = kind
    this.name = 'ApiError'
  }
}

function readErrorText(json: unknown): string | null {
  if (json && typeof json === 'object' && 'error' in json) {
    const e = (json as { error: unknown }).error
    if (typeof e === 'string') return e
  }
  return null
}

async function callApi<T>(body: Record<string, unknown>): Promise<T> {
  let res: Response
  try {
    res = await fetch(FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: PUBLISHABLE_KEY,
        Authorization: `Bearer ${PUBLISHABLE_KEY}`,
      },
      body: JSON.stringify(body),
    })
  } catch {
    throw new ApiError('network', 'เชื่อมต่ออินเทอร์เน็ตไม่ได้ กรุณาตรวจสอบสัญญาณแล้วลองใหม่อีกครั้ง')
  }

  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    json = null
  }

  if (res.status === 401) {
    throw new ApiError('unauthorized', readErrorText(json) ?? 'รหัสร้านหรือ PIN ไม่ถูกต้อง หรือเซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่')
  }
  if (res.status === 429) {
    throw new ApiError('rate_limited', readErrorText(json) ?? 'ใช้งานถี่เกินไป ช้าลงหน่อยนะ แล้วลองใหม่อีกครั้งใน 1-2 นาที')
  }
  if (!res.ok) {
    throw new ApiError('server', readErrorText(json) ?? 'เกิดข้อผิดพลาดที่ระบบ กรุณาลองใหม่อีกครั้ง')
  }
  return json as T
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

export interface LoginResult {
  shopName: string
  token: string
}

export async function loginShop(loginCode: string, pin: string): Promise<LoginResult> {
  const json = await callApi<{ ok: true; shop_name: string; token: string }>({
    action: 'login',
    login_code: loginCode,
    pin,
  })
  return { shopName: json.shop_name, token: json.token }
}

// ---------------------------------------------------------------------------
// sign_upload
// ---------------------------------------------------------------------------

export type FileKind = 'id_card' | 'payslip' | 'statement' | 'work_photo' | 'facebook_screenshot' | 'thaid_name_history' | 'other'

export interface FileToSign {
  kind: FileKind
  mime: string
  size: number
  sha256: string
}

export interface SignedUpload {
  r2Key: string
  uploadUrl: string
}

export async function signUploads(token: string, files: FileToSign[]): Promise<SignedUpload[]> {
  const json = await callApi<{ uploads: Array<{ r2_key: string; upload_url: string }> }>({
    action: 'sign_upload',
    token,
    files,
  })
  return json.uploads.map((u) => ({ r2Key: u.r2_key, uploadUrl: u.upload_url }))
}

/** อัปโหลดไฟล์ดิบ (หลัง sign_upload แล้ว) ไป R2 ตรงๆ ด้วย presigned PUT — pattern เดียวกับ ContractMediaCard.tsx */
export async function putToSignedUrl(uploadUrl: string, blob: Blob, mime: string): Promise<void> {
  let res: Response
  try {
    res = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': mime }, body: blob })
  } catch {
    throw new ApiError('network', 'อัปโหลดไฟล์ไม่สำเร็จ (เชื่อมต่อไม่ได้) กรุณาลองใหม่อีกครั้ง')
  }
  if (!res.ok) {
    throw new ApiError('server', 'อัปโหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
  }
}

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------

export interface SubmitFormInput {
  customerName: string
  customerType: CustomerType
  idNumber: string
  idExpiryDate: string | null
  /** วันออกบัตร — บังคับเฉพาะบัตรประชาชนไทย (ต่างชาติ/เอกสารอื่น optional), Wave 3 addendum 2026-09-28 */
  idIssueDate: string | null
  birthDate: string
  occupationType: OccupationType
  deviceCondition: DeviceCondition
  devicePrice: number
  downPercent: number
  termMonths: number
  ourMonthlyPayment: number
  pjMonthlyPayment: number
  declaredMonthlyIncome: number | null
  attachedFileKinds: AttachedFileKind[]
  facebookUrl: string
  /** IMEI เครื่อง (ถ้ามี) — 15 หลัก ใช้ค้นบัญชีดำ PJ เพิ่มเติมจากเลขบัตร (Wave 3, 2026-09-28) */
  imei: string | null
}

export interface SubmittedFile {
  kind: FileKind
  r2Key: string
  mime: string
  size: number
  sha256: string
}

// หมายเหตุ: `level` ที่ Edge Function ตอบกลับใช้ชื่อ enum ฝั่ง DB (EngineLevel ด้านล่าง — fail/needs_review/
// passed_preliminary) ไม่ใช่ชื่อ level ดิบของ src/lib/creditCheck.ts (fail/review/prelim_pass) — ดู
// ENGINE_LEVEL_TO_DB ใน supabase/functions/credit-check/index.ts
export interface SubmitResult {
  id: string
  level: EngineLevel
  reasonsShop: string[]
  installmentUsed: number
  ratio: number | null
  /** ผลค้นบัญชีดำ PJ อัตโนมัติ (Wave 3) — server ค้นเสร็จก่อนตอบกลับเสมอ ไม่มีค่า 'not_checked' ในจุดนี้
   *  'found' เอนจิ้นบังคับ level อย่างน้อย 'needs_review' ไปแล้ว (ดู reasonsShop ที่มีข้อความทั่วไปกำกับ) —
   *  'error' ไม่ต้องโชว์อะไรพิเศษที่ฝั่งร้าน (เจ้าหน้าที่ตามที่คิวแทน) */
  pjBlacklist: 'clear' | 'found' | 'error'
}

export async function submitCreditCheck(
  token: string,
  form: SubmitFormInput,
  files: SubmittedFile[],
): Promise<SubmitResult> {
  const json = await callApi<{
    id: string
    level: EngineLevel
    reasons_shop: string[]
    installment_used: number
    ratio: number | null
    pj_blacklist: 'clear' | 'found' | 'error'
  }>({
    action: 'submit',
    token,
    form,
    files: files.map((f) => ({ kind: f.kind, r2_key: f.r2Key, mime: f.mime, size: f.size, sha256: f.sha256 })),
    consent: true,
    consent_version: CONSENT_VERSION,
  })
  return {
    id: json.id,
    level: json.level,
    reasonsShop: json.reasons_shop,
    installmentUsed: json.installment_used,
    ratio: json.ratio,
    pjBlacklist: json.pj_blacklist,
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export type EngineLevel = 'fail' | 'needs_review' | 'passed_preliminary'
export type Decision = 'approved' | 'rejected' | 'need_more_info'

export interface RequestListItem {
  id: string
  createdAt: string
  customerName: string
  nationalIdMasked: string
  engineLevel: EngineLevel | null
  blacklistDone: boolean
  facebookDone: boolean
  decision: Decision | null
  decisionNote: string | null
}

interface RawRequestItem {
  id: string
  created_at: string
  customer_name: string
  national_id_masked: string
  engine_level: EngineLevel | null
  blacklist_done: boolean
  facebook_done: boolean
  decision: Decision | null
  decision_note: string | null
}

export async function listRequests(token: string): Promise<RequestListItem[]> {
  const json = await callApi<{ items: RawRequestItem[] }>({ action: 'list', token })
  return json.items.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    customerName: r.customer_name,
    nationalIdMasked: r.national_id_masked,
    engineLevel: r.engine_level,
    blacklistDone: r.blacklist_done,
    facebookDone: r.facebook_done,
    decision: r.decision,
    decisionNote: r.decision_note,
  }))
}
