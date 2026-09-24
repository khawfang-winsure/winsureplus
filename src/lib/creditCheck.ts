// ===== ตรวจเครดิตเบื้องต้นก่อนทำสัญญา (shop self credit-check) — ฟังก์ชันบริสุทธิ์ =====
// อ้างอิงคู่มือเช็คเครดิต + owner decisions (2026-09-23) — ดูรายละเอียดกฎที่ spec ของแบม
// ไม่แตะ DB/network และไม่ใช้ Date.now() ในไฟล์นี้ — ผู้เรียกต้องส่ง `today` เข้ามาเสมอ
// เช็คครบทุกกฎเสมอ (ไม่ early-return ตัวแรกที่ fail) เพื่อให้เจ้าหน้าที่เห็นภาพรวมครบในครั้งเดียว

export type CustomerType = 'thai' | 'foreign'
export type OccupationType = 'salaried' | 'freelancer' | 'government' | 'business_owner'
export type DeviceCondition = 'iphone_new' | 'iphone_used' | 'ipad'
export type AttachedFileKind = 'payslip' | 'statement' | 'work_photo' | 'other'

export interface CreditCheckInput {
  today: string // ISO 'YYYY-MM-DD' ณ เวลาที่ตรวจ (ผู้เรียกส่งเข้ามา ห้ามใช้ system clock ในฟังก์ชันนี้)

  customerType: CustomerType // ต่างชาติ = ลาว/พม่า ตามคู่มือ (สัญชาติอื่นจัดเป็น foreign เหมือนกันไปก่อน — ดู open Q1 ใน spec)
  idNumber: string // เลขบัตร ปชช. 13 หลัก (thai) หรือเลขบัตรชมพู/ใบอนุญาตทำงาน (foreign)
  idExpiryDate: string | null // ISO date วันหมดอายุเอกสารระบุตัวตน; null = ไม่ได้กรอก/เอกสารไม่ระบุวันหมดอายุ
  birthDate: string // ISO date วันเกิด

  occupationType: OccupationType
  deviceCondition: DeviceCondition // มือ1 / มือ2 / ไอแพด — กำหนดดาวน์ขั้นต่ำ
  devicePrice: number
  downPercent: number // % ดาวน์ที่ร้านเลือกในระบบ (0-100)
  termMonths: number

  ourMonthlyPayment: number // ค่างวด/เดือน คำนวณจากเรตของเราแล้ว (rates.ts) — ฟังก์ชันนี้ไม่คำนวณเรตเอง
  pjMonthlyPayment: number // ค่างวด/เดือน ที่ร้านกรอกจากเว็บ PJ (แหล่งเลขจริงตอนทำสัญญา)

  declaredMonthlyIncome: number | null // รายได้/เดือนที่ลูกค้าแจ้ง; null หรือ <=0 = ไม่ได้กรอก
  attachedFileKinds: AttachedFileKind[]
  facebookUrl: string
}

export type CreditCheckSeverity = 'fail' | 'review'
export type CreditCheckLevel = 'fail' | 'review' | 'prelim_pass'

export interface CreditCheckReason {
  code: string // stable id เช่น 'AGE_UNDERAGE' (ผูก analytics/i18n ภายหลังได้)
  severity: CreditCheckSeverity
  shopText: string // ไทย สุภาพ บอกชัดว่าเป็นผลเบื้องต้น
  staffText: string // ไทย สั้น ตรงประเด็น สำหรับคิวเจ้าหน้าที่
}

export interface CreditCheckResult {
  level: CreditCheckLevel
  levelLabelShop: string
  levelLabelStaff: string
  reasons: CreditCheckReason[] // ว่างได้เฉพาะตอน prelim_pass
  installmentUsed: number // max(ourMonthlyPayment, pjMonthlyPayment)
  installmentDiff: number // ourMonthlyPayment - pjMonthlyPayment (มีเครื่องหมาย ไว้ debug)
  incomeRatio: number | null // declaredMonthlyIncome / installmentUsed; null ถ้าไม่มีรายได้แจ้ง
  effectiveMinDownPercent: number // เกณฑ์ดาวน์ขั้นต่ำที่ใช้จริง (รวมกฎต่างชาติแล้ว)
}

/** ข้อความไทยต่อ reason code — ดูตารางเต็มใน spec ของแบม */
const REASON_TEXT: Record<string, { shopText: string; staffText: string }> = {
  INPUT_INVALID: {
    shopText: 'ข้อมูลไม่ครบถ้วน กรุณาตรวจสอบอีกครั้ง',
    staffText: 'ข้อมูลฟอร์มผิดปกติ (ราคา/งวด/ดาวน์)',
  },
  ID_INVALID_FORMAT: {
    shopText: 'เลขเอกสารไม่ถูกต้อง กรุณาตรวจสอบ',
    staffText: 'รูปแบบเลขบัตร/เอกสารไม่ถูกต้อง',
  },
  ID_INVALID_CHECKSUM: {
    shopText: 'เลขบัตรประชาชนไม่ถูกต้อง กรุณาตรวจสอบ',
    staffText: 'checksum เลขบัตร ปชช. ไม่ผ่าน',
  },
  ID_EXPIRY_MISSING: {
    shopText: 'ไม่พบวันหมดอายุในเอกสาร กรุณาแนบเอกสารที่ระบุวันหมดอายุ',
    staffText: 'เอกสารไม่ระบุวันหมดอายุ ตามคู่มือถือว่าใช้ไม่ได้',
  },
  ID_EXPIRED: {
    shopText: 'เอกสารประจำตัวหมดอายุแล้ว กรุณาต่ออายุก่อนยื่นเรื่อง',
    staffText: 'เอกสารหมดอายุ',
  },
  AGE_UNDERAGE: {
    shopText: 'ลูกค้าอายุยังไม่ถึงเกณฑ์ 18 ปี',
    staffText: 'อายุต่ำกว่า 18 ปี',
  },
  DOWN_BELOW_MIN: {
    shopText: 'ยอดดาวน์ยังไม่ถึงขั้นต่ำสำหรับรุ่น/ประเภทลูกค้านี้',
    staffText: 'ดาวน์ต่ำกว่าเกณฑ์ (ต้อง ≥ effectiveMinDownPercent%)',
  },
  FREELANCER_ALWAYS_REVIEW: {
    shopText: 'อาชีพอิสระ รับเรื่องแล้ว รอทีมตรวจเพิ่มเติม',
    staffText: 'อาชีพอิสระ ต้อง review ทุกเคส',
  },
  BUSINESS_OWNER_ALWAYS_REVIEW: {
    shopText: 'เจ้าของกิจการ รับเรื่องแล้ว รอทีมตรวจเพิ่มเติม',
    staffText: 'เจ้าของกิจการ ยังไม่มีกฎในคู่มือ ตั้ง review ชั่วคราว',
  },
  GOVERNMENT_GUARANTOR_REQUIRED: {
    shopText: 'เคสข้าราชการ ต้องมีผู้ค้ำประกัน รอทีมตรวจเอกสารผู้ค้ำ',
    staffText: 'ข้าราชการ ต้องมีผู้ค้ำ 1 ท่าน',
  },
  MISSING_INCOME_EVIDENCE: {
    shopText: 'ยังไม่พบหลักฐานรายได้แนบมา รอทีมตรวจเพิ่มเติม',
    staffText: 'ไม่มีสลิป/statement/รูปหลักฐานทำงานแนบ',
  },
  INCOME_MISSING: {
    shopText: 'ยังไม่ได้แจ้งรายได้ต่อเดือน รอทีมตรวจเพิ่มเติม',
    staffText: 'ไม่มีรายได้ที่แจ้งไว้ คำนวณสัดส่วนไม่ได้',
  },
  INCOME_BELOW_4X: {
    shopText: 'รายได้เทียบค่างวดยังไม่ถึงเกณฑ์ รอทีมตรวจเพิ่มเติม',
    staffText: 'รายได้ต่ำกว่า 4 เท่าค่างวด (ดู incomeRatio)',
  },
  INSTALLMENT_DIFF_FLAG: {
    shopText: 'ยอดค่างวดกำลังตรวจสอบความถูกต้องอีกครั้ง',
    staffText: 'ค่างวดเราต่างจาก PJ เกิน 5 บาท (ดู installmentDiff)',
  },
  FACEBOOK_UNVERIFIED: {
    shopText: 'ลิงก์ Facebook ยังไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง',
    staffText: 'Facebook URL รูปแบบผิดหรือว่าง ต้องยืนยันด้วยตา',
  },
}

/** label ตามระดับผล — ห้ามใช้คำว่า "อนุมัติ"/"ปฏิเสธ" เด็ดขาด แม้แต่ fail ก็ใช้โทน "รอทีม" */
const LEVEL_LABEL: Record<CreditCheckLevel, { shop: string; staff: string }> = {
  fail: {
    shop: 'ยังไม่ผ่านเกณฑ์เบื้องต้น รอทีมตรวจสอบอีกครั้ง',
    staff: 'FAIL — เกณฑ์บังคับไม่ผ่าน',
  },
  review: {
    shop: 'รับเรื่องแล้ว ต้องรอทีมตรวจเพิ่มเติมก่อนยืนยัน',
    staff: 'REVIEW — มีจุดต้องเช็คเพิ่ม',
  },
  prelim_pass: {
    shop: 'ผ่านเกณฑ์เบื้องต้นแล้ว รอทีมยืนยันอีกครั้งก่อนอนุมัติจริง',
    staff: 'PRELIM PASS — รอเช็คแบล็กลิสต์ + Facebook',
  },
}

function makeReason(code: string, severity: CreditCheckSeverity): CreditCheckReason {
  const text = REASON_TEXT[code]
  return { code, severity, shopText: text.shopText, staffText: text.staffText }
}

/**
 * ตรวจ checksum เลขบัตรประชาชนไทย 13 หลัก (mod-11)
 * ต้องเป็นตัวเลขล้วน 13 หลักก่อน ไม่งั้นคืน false ทันที (รูปแบบผิด)
 */
export function isValidThaiNationalId(idNumber: string): boolean {
  if (!/^[0-9]{13}$/.test(idNumber)) return false
  const digits = idNumber.split('').map(Number)
  let sum = 0
  for (let i = 0; i < 12; i++) {
    sum += digits[i] * (13 - i)
  }
  const check = (11 - (sum % 11)) % 10
  return check === digits[12]
}

/**
 * คำนวณอายุเต็มปี ณ วันที่ `today` จาก `birthDate`
 * เทียบเดือน/วันเกิดของปีนี้กับ today — ยังไม่ถึงวันเกิดปีนี้ให้ลบ 1 ปี
 * Edge: เกิด 29 ก.พ. ปีที่ไม่ใช่อธิกสุรทิน ให้ถือวันเกิดเป็น 28 ก.พ.
 */
export function calcAge(birthDate: string, today: string): number {
  const b = new Date(birthDate + 'T00:00:00Z')
  const t = new Date(today + 'T00:00:00Z')

  let age = t.getUTCFullYear() - b.getUTCFullYear()

  const birthMonth = b.getUTCMonth()
  const birthDay = b.getUTCDate()

  // วันเกิด "ปีนี้" เทียบกับ today — ถ้า 29 ก.พ. แต่ปีนี้ไม่ใช่อธิกสุรทิน ให้เลื่อนมาเป็น 28 ก.พ.
  const birthdayThisYear = new Date(Date.UTC(t.getUTCFullYear(), birthMonth, birthDay))
  if (birthMonth === 1 && birthDay === 29 && birthdayThisYear.getUTCMonth() !== 1) {
    birthdayThisYear.setUTCDate(28)
  }

  if (t.getTime() < birthdayThisYear.getTime()) {
    age -= 1
  }
  return age
}

/** ดาวน์ขั้นต่ำตามประเภทเครื่อง ก่อนรวมกฎต่างชาติ */
function baseMinDownPercent(deviceCondition: DeviceCondition): number {
  if (deviceCondition === 'iphone_new') return 20
  if (deviceCondition === 'iphone_used') return 30
  return 40 // ipad
}

/**
 * ตรวจเครดิตเบื้องต้นก่อนทำสัญญา — เช็คครบทุกกฎ (ไม่ early-return) แล้วรวมผลเป็น level เดียว
 * level = severity แรงสุดใน reasons (fail > review) ไม่มี reason เลย = prelim_pass
 */
export function creditCheck(input: CreditCheckInput): CreditCheckResult {
  const reasons: CreditCheckReason[] = []

  // R0 — ความสมเหตุสมผลของ input
  if (input.devicePrice <= 0 || input.termMonths <= 0 || input.downPercent < 0 || input.downPercent > 100) {
    reasons.push(makeReason('INPUT_INVALID', 'fail'))
  }

  // R1 / R1b — เลขเอกสาร
  if (input.customerType === 'thai') {
    if (!/^[0-9]{13}$/.test(input.idNumber)) {
      reasons.push(makeReason('ID_INVALID_FORMAT', 'fail'))
    } else if (!isValidThaiNationalId(input.idNumber)) {
      reasons.push(makeReason('ID_INVALID_CHECKSUM', 'fail'))
    }
  } else {
    if (input.idNumber.trim() === '') {
      reasons.push(makeReason('ID_INVALID_FORMAT', 'fail'))
    }
  }

  // R2 — วันหมดอายุเอกสาร
  if (input.idExpiryDate === null) {
    reasons.push(makeReason('ID_EXPIRY_MISSING', 'fail'))
  } else if (input.idExpiryDate < input.today) {
    reasons.push(makeReason('ID_EXPIRED', 'fail'))
  }

  // R3 — อายุ
  const age = calcAge(input.birthDate, input.today)
  if (age < 18) {
    reasons.push(makeReason('AGE_UNDERAGE', 'fail'))
  }

  // R4 — ดาวน์ขั้นต่ำ
  const baseMin = baseMinDownPercent(input.deviceCondition)
  const effectiveMinDownPercent = input.customerType === 'foreign' ? Math.max(baseMin, 50) : baseMin
  if (input.downPercent < effectiveMinDownPercent) {
    reasons.push(makeReason('DOWN_BELOW_MIN', 'fail'))
  }

  // R5 — กลุ่มอาชีพ
  if (input.occupationType === 'freelancer') {
    reasons.push(makeReason('FREELANCER_ALWAYS_REVIEW', 'review'))
  } else if (input.occupationType === 'business_owner') {
    reasons.push(makeReason('BUSINESS_OWNER_ALWAYS_REVIEW', 'review'))
  } else if (input.occupationType === 'government') {
    reasons.push(makeReason('GOVERNMENT_GUARANTOR_REQUIRED', 'review'))
  }
  const hasIncomeEvidence = input.attachedFileKinds.some(
    (k) => k === 'payslip' || k === 'statement' || k === 'work_photo',
  )
  if (!hasIncomeEvidence) {
    reasons.push(makeReason('MISSING_INCOME_EVIDENCE', 'review'))
  }

  // R6 — อัตราส่วนรายได้ต่อค่างวด
  const installmentUsed = Math.max(input.ourMonthlyPayment, input.pjMonthlyPayment)
  const installmentDiff = input.ourMonthlyPayment - input.pjMonthlyPayment
  let incomeRatio: number | null = null
  if (input.declaredMonthlyIncome === null || input.declaredMonthlyIncome <= 0) {
    reasons.push(makeReason('INCOME_MISSING', 'review'))
  } else {
    incomeRatio = input.declaredMonthlyIncome / installmentUsed
    if (incomeRatio < 4) {
      reasons.push(makeReason('INCOME_BELOW_4X', 'review'))
    }
  }

  // R7 — ส่วนต่างค่างวดเรา vs PJ
  if (Math.abs(installmentDiff) > 5) {
    reasons.push(makeReason('INSTALLMENT_DIFF_FLAG', 'review'))
  }

  // R8 — Facebook รูปแบบเบื้องต้น
  const fb = input.facebookUrl.trim()
  if (fb === '' || !/^https?:\/\/(www\.)?(facebook|fb)\.com\//i.test(fb)) {
    reasons.push(makeReason('FACEBOOK_UNVERIFIED', 'review'))
  }

  const level: CreditCheckLevel = reasons.some((r) => r.severity === 'fail')
    ? 'fail'
    : reasons.length > 0
      ? 'review'
      : 'prelim_pass'

  return {
    level,
    levelLabelShop: LEVEL_LABEL[level].shop,
    levelLabelStaff: LEVEL_LABEL[level].staff,
    reasons,
    installmentUsed,
    installmentDiff,
    incomeRatio,
    effectiveMinDownPercent,
  }
}
