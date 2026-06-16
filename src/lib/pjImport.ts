// ===== PJ Import Helpers =====
// Pure functions สำหรับแปลงข้อมูลจาก PJ scrape CSV → format ที่ RPC รับ
// ไม่มี side-effect ทดสอบได้ง่าย

// ---------- Types ----------

/** 1 แถวจาก contracts.csv */
export interface PJContract {
  invoice_no: string
  trade_date: string
  shop_name: string
  customer_name: string
  birth_date: string
  national_id: string
  occupation: string
  phone: string
  phone_alt1: string
  phone_alt2: string
  email: string
  device_brand: string
  device_name: string
  device_color: string
  device_storage: string
  device_condition: string
  imei: string
  down_payment: string
  monthly_payment: string
  term_months: string
  finance_amount: string
  first_due_date: string
  addr_card_full: string
  addr_current_full: string
  addr_work_full: string
  // v8 merged sheet override columns
  contract_no: string
  condition: string
  promotion: string
  has_promotion: boolean
  promotion_detail: string
  occupation_proof: string
  notes: string
  operator: string
}

/** 1 แถวจาก installments.csv */
export interface PJInstallment {
  invoice_no: string
  row_no: string
  payment_type: string   // 'เงินดาวน์' | 'ค่างวด' | 'ค่าปรับ'
  amount: string
  tax: string
  paid_amount: string
  remaining: string
  due_date: string
  status: string         // 'Paid' | 'Pending' | 'Partial'
  paid_date: string
}

/** ผลลัพธ์จาก import_pj_batch RPC */
export interface ImportResult {
  batchNo: number
  imported: number
  contractsCreated: number
  installmentsCreated: number
  paymentsLogged: number
  errors: ImportError[]
}

export interface ImportError {
  invoiceNo: string
  batch?: number
  error: string
}

// ---------- Date Parsers ----------

/**
 * parsePJDate — แปลงวันที่จาก PJ (รองรับ 2 format)
 * "06-04-2026" (DD-MM-YYYY) → "2026-04-06"
 * "2026-04-06" (YYYY-MM-DD) → "2026-04-06" (pass-through)
 * คืน null ถ้า parse ไม่ได้
 */
export function parsePJDate(s: string): string | null {
  if (!s || s.trim() === '') return null
  const trimmed = s.trim()

  // ตรวจรูปแบบ: ถ้าส่วนแรก (ก่อน - ตัวแรก) มี 4 หลัก → YYYY-MM-DD
  const parts = trimmed.split('-')
  if (parts.length !== 3) return null

  if (parts[0].length === 4) {
    // YYYY-MM-DD: validate + pass-through
    const [y, m, d] = parts.map(Number)
    if (isNaN(y) || isNaN(m) || isNaN(d)) return null
    if (m < 1 || m > 12 || d < 1 || d > 31) return null
    return trimmed
  } else {
    // DD-MM-YYYY: สลับเป็น YYYY-MM-DD
    const [d, m, y] = parts.map(Number)
    if (isNaN(y) || isNaN(m) || isNaN(d)) return null
    if (m < 1 || m > 12 || d < 1 || d > 31) return null
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }
}

// ---------- Address Parser ----------

/**
 * parsePJAddress — แปลง address string เต็มเป็น object แยก field
 * "229 หมู่ 10, ตำบล แหลมรัง, อำเภอ บึงนาราง, จังหวัด พิจิตร, 66130"
 * → { house_no: "229", moo: "10", subdistrict: "แหลมรัง", district: "บึงนาราง",
 *     province: "พิจิตร", postal_code: "66130" }
 *
 * NOTE: การ parse เบื้องต้นฝั่ง JS ใช้สำหรับ preview/validation ก่อนส่ง RPC
 *       การ parse จริงเกิดที่ SQL function parse_pj_address() ใน DB (SECTION 3 ของ migration)
 */
export interface ParsedAddress {
  house_no: string | null
  moo: string | null
  soi: string | null
  road: string | null
  subdistrict: string | null
  district: string | null
  province: string | null
  postal_code: string | null
}

export function parsePJAddress(full: string): ParsedAddress {
  const result: ParsedAddress = {
    house_no: null,
    moo: null,
    soi: null,
    road: null,
    subdistrict: null,
    district: null,
    province: null,
    postal_code: null,
  }

  if (!full || full.trim() === '') return result

  const parts = full.split(',').map((p) => p.trim()).filter(Boolean)

  for (const part of parts) {
    // รหัสไปรษณีย์ (5 หลัก)
    if (/^\d{5}$/.test(part)) {
      result.postal_code = part
      continue
    }

    // ตำบล / แขวง
    const subMatch = part.match(/^(ตำบล|แขวง)\s*(.+)/)
    if (subMatch) {
      result.subdistrict = subMatch[2].trim()
      continue
    }

    // อำเภอ / เขต
    const distMatch = part.match(/^(อำเภอ|เขต)\s*(.+)/)
    if (distMatch) {
      result.district = distMatch[2].trim()
      continue
    }

    // จังหวัด
    const provMatch = part.match(/^จังหวัด\s*(.+)/)
    if (provMatch) {
      result.province = provMatch[1].trim()
      continue
    }

    // ถนน
    const roadMatch = part.match(/^(ถนน|ถ\.)\s*(.+)/)
    if (roadMatch) {
      result.road = roadMatch[2].trim()
      continue
    }

    // ซอย
    const soiMatch = part.match(/^(ซอย|ซ\.)\s*(.+)/)
    if (soiMatch) {
      result.soi = soiMatch[2].trim()
      continue
    }

    // หมู่บ้าน (อาจมี house_no นำหน้า)
    if (/หมู่/.test(part)) {
      const mooWithHouse = part.match(/^(\S+)\s+หมู่\s*(\S+)/)
      if (mooWithHouse) {
        // "229 หมู่ 10"
        if (result.house_no === null) result.house_no = mooWithHouse[1]
        result.moo = mooWithHouse[2]
      } else {
        const mooOnly = part.match(/^หมู่\s*(\S+)/)
        if (mooOnly) result.moo = mooOnly[1]
      }
      continue
    }

    // บ้านเลขที่ (ขึ้นต้นตัวเลข ยังไม่ได้ assign)
    if (result.house_no === null && /^\d/.test(part)) {
      result.house_no = part
    }
  }

  return result
}

// ---------- Amount Parser ----------

/**
 * parsePJAmount — แปลง string ตัวเลขแบบ PJ (มีลูกน้ำ + ทศนิยม)
 * "8,070.00" → 8070
 * "15,000"   → 15000
 * ""         → 0
 */
export function parsePJAmount(s: string): number {
  if (!s || s.trim() === '') return 0
  const cleaned = s.replace(/,/g, '').trim()
  const n = parseFloat(cleaned)
  return isNaN(n) ? 0 : n
}

// ---------- Phone Splitter ----------

/**
 * splitPhones — แยกเบอร์โทรศัพท์จาก string เดียว
 * "0922814511 0624403966" → ["0922814511", "0624403966"]
 * "0922814511"            → ["0922814511"]
 * ""                      → []
 */
export function splitPhones(s: string): string[] {
  if (!s || s.trim() === '') return []
  // split ด้วย space, comma, / หรือ ; แล้ว filter ค่าว่าง
  return s
    .split(/[\s,/;]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

// ---------- CSV Row Normalizer ----------

/**
 * normalizePJContract — แปลง raw CSV row (keys อาจมี BOM / space) → PJContract
 * เรียกหลัง papaparse เพื่อ normalize keys และแปลง date fields
 */
export function normalizePJContract(raw: Record<string, string>): PJContract {
  // clean keys: trim whitespace + BOM
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    clean[k.replace(/^﻿/, '').trim()] = v ?? ''
  }

  const phones = splitPhones(clean['phone'] ?? '')

  // v8 condition column overrides v7 device_condition when present
  const v8Condition = (clean['condition'] ?? '').trim()
  const v7DeviceCondition = (clean['device_condition'] ?? '').trim()
  const condition = v8Condition || v7DeviceCondition

  return {
    invoice_no:       (clean['invoice_no'] ?? '').trim(),
    trade_date:       parsePJDate(clean['trade_date'] ?? '') ?? (clean['trade_date'] ?? '').trim(),
    shop_name:        (clean['shop_name'] ?? '').trim(),
    customer_name:    (clean['customer_name'] ?? '').trim(),
    birth_date:       parsePJDate(clean['birth_date'] ?? '') ?? (clean['birth_date'] ?? '').trim(),
    national_id:      (clean['national_id'] ?? '').trim(),
    occupation:       (clean['occupation'] ?? '').trim(),
    phone:            phones[0] ?? (clean['phone'] ?? '').trim(),
    phone_alt1:       clean['phone_alt1']
                        ? (clean['phone_alt1']).trim()
                        : (phones[1] ?? ''),
    phone_alt2:       clean['phone_alt2']
                        ? (clean['phone_alt2']).trim()
                        : (phones[2] ?? ''),
    email:            (clean['email'] ?? '').trim(),
    device_brand:     (clean['device_brand'] ?? '').trim(),
    device_name:      (clean['device_name'] ?? '').trim(),
    device_color:     (clean['device_color'] ?? '').trim(),
    device_storage:   (clean['device_storage'] ?? '').trim(),
    device_condition: condition,
    imei:             (clean['imei'] ?? '').trim(),
    down_payment:     String(parsePJAmount(clean['down_payment'] ?? '')),
    monthly_payment:  String(parsePJAmount(clean['monthly_payment'] ?? '')),
    term_months:      (clean['term_months'] ?? '').trim(),
    finance_amount:   String(parsePJAmount(clean['finance_amount'] ?? '')),
    first_due_date:   parsePJDate(clean['first_due_date'] ?? '') ?? (clean['first_due_date'] ?? '').trim(),
    addr_card_full:   (clean['addr_card_full'] ?? '').trim(),
    addr_current_full:(clean['addr_current_full'] ?? '').trim(),
    addr_work_full:   (clean['addr_work_full'] ?? '').trim(),
    // v8 merged sheet override columns
    contract_no:      (clean['contract_no'] ?? '').trim(),
    condition,
    promotion:        (clean['promotion'] ?? '').trim(),
    has_promotion:    (clean['has_promotion'] ?? '').trim().toLowerCase() === 'true',
    promotion_detail: (clean['promotion_detail'] ?? '').trim(),
    occupation_proof: (clean['occupation_proof'] ?? '').trim(),
    notes:            (clean['notes'] ?? '').trim(),
    operator:         (clean['operator'] ?? '').trim(),
  }
}

/**
 * normalizePJInstallment — แปลง raw CSV row → PJInstallment
 */
export function normalizePJInstallment(raw: Record<string, string>): PJInstallment {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    clean[k.replace(/^﻿/, '').trim()] = v ?? ''
  }

  return {
    invoice_no:   (clean['invoice_no'] ?? '').trim(),
    row_no:       (clean['row_no'] ?? '0').trim(),
    payment_type: (clean['payment_type'] ?? '').trim(),
    amount:       String(parsePJAmount(clean['amount'] ?? '')),
    tax:          String(parsePJAmount(clean['tax'] ?? '')),
    paid_amount:  String(parsePJAmount(clean['paid_amount'] ?? '')),
    remaining:    String(parsePJAmount(clean['remaining'] ?? '')),
    due_date:     parsePJDate(clean['due_date'] ?? '') ?? (clean['due_date'] ?? '').trim(),
    status:       (clean['status'] ?? '').trim(),
    paid_date:    parsePJDate(clean['paid_date'] ?? '') ?? (clean['paid_date'] ?? '').trim(),
  }
}

// ---------- Batch Builder ----------

/** BATCH_SIZE: จำนวน contract ต่อ 1 RPC call */
export const BATCH_SIZE = 100

/**
 * buildBatches — แบ่ง contracts เป็น batch ขนาด BATCH_SIZE
 * พร้อม filter installments ให้ตรงกับ invoice_no ของ batch
 */
export function buildBatches(
  contracts: PJContract[],
  installments: PJInstallment[],
): Array<{ contracts: PJContract[]; installments: PJInstallment[]; batchNo: number }> {
  const batches: Array<{ contracts: PJContract[]; installments: PJInstallment[]; batchNo: number }> = []

  for (let i = 0; i < contracts.length; i += BATCH_SIZE) {
    const batchContracts = contracts.slice(i, i + BATCH_SIZE)
    const batchInvoiceNos = new Set(batchContracts.map((c) => c.invoice_no))
    const batchInstallments = installments.filter((inst) => batchInvoiceNos.has(inst.invoice_no))

    batches.push({
      contracts: batchContracts,
      installments: batchInstallments,
      batchNo: Math.floor(i / BATCH_SIZE) + 1,
    })
  }

  return batches
}
