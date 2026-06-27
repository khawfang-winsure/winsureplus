// ===== ชนิดข้อมูลหลักของระบบ WIN SURE PLUS =====
// ไฟล์นี้เป็น "พิมพ์เขียว" ของข้อมูล ใช้ร่วมกันทั้งเว็บ
// ภายหลังจะ map ตรงกับตารางใน Supabase

/** สถานะหลัก (lifecycle) ของสัญญา — กลุ่มล่าช้าเป็นค่าที่ "คำนวณ" จากวันครบกำหนด ไม่ได้เก็บตรงนี้ */
export type ContractStatus =
  | 'active' // ผ่อนปกติ
  | 'closed' // ปิดสัญญา
  | 'returned' // คืนเครื่อง (ยังไม่ปิด)
  | 'returned_closed' // คืนเครื่องปิดสัญญา
  | 'online' // ออนไลน์ (รอร้านแจ้งปิด)

/** กลุ่มความล่าช้า (คำนวณจากจำนวนวันเลยกำหนด) */
export type OverdueBucket =
  | 'normal'
  | '1-10'
  | '11-30'
  | '31-60'
  | '61-90'
  | '91-120'
  | '120+'

export type DeviceCondition = 'new' | 'used' // มือ 1 / มือ 2
export type DeviceOrigin = 'th' | 'inter' // เครื่องไทย / เครื่องนอก

export interface Shop {
  id: string
  code: string // เช่น "AQ S00016"
  name: string // ชื่อร้าน
  bank: string
  accountNo: string
  accountName: string
  active: boolean
  // --- ข้อมูลติดต่อ (เผื่อต่อยอดอนาคต) ---
  ownerName?: string // ชื่อเจ้าของร้าน
  phone?: string // เบอร์โทร
  facebookLink?: string // ลิงก์เฟซบุ๊ก
  contactChannel?: string // ช่องทางติดต่ออื่นๆ (LINE ฯลฯ)
  address?: string // ที่อยู่
  province?: string // จังหวัด
  // --- ค่าคอมหาร้าน ---
  recruitedBy?: string | null // user id ของพนักงานที่หาร้านนี้
  recruitedAt?: string | null // วันที่หาร้าน (ISO yyyy-mm-dd)
}

/** ตัวเลือกที่ตั้งค่าได้ (รุ่น/ความจำ/อาชีพ/หลักฐาน/โปรโมชั่น) — ลบแล้วใช้ active=false ข้อมูลเก่าไม่หาย */
export interface Option {
  id: string
  label: string
  detail?: string // ใช้กับโปรโมชั่น (รายละเอียดโปร)
  active: boolean
}

export interface Installment {
  id: string
  installmentNo: number
  dueDate: string
  amount: number
  paidAt: string | null
  paidAmount: number
  paidByName: string | null
  penaltyDays: number
  penaltyAmount: number
  status: 'pending' | 'paid' | 'late'
}

/** แถวจาก view v_contract_status (สถานะ+ความล่าช้าที่คำนวณแล้ว) */
export interface ContractStatusRow {
  contractId: string
  contractNo: string
  customerName: string
  shopId: string
  shopName: string
  status: ContractStatus
  nextDue: string | null
  remainingInstallments: number
  penaltyDue: number
  daysLate: number
  bucket: OverdueBucket
  grade: string | null // A-E หรือ null (ปกติ/ปิดแล้ว) — เพิ่มใน 0018
  overdueAmount: number // ยอดงวดที่เลยกำหนดและยังไม่ชำระ (ไม่รวมค่าปรับ) — เพิ่มใน 0055
}

export interface DeviceReturnRow {
  id: string
  contractId: string
  contractNo: string
  customerName: string
  caseNo: 1 | 2 | 3
  lastInstallmentPaid: boolean
  penaltyPaid: boolean
  repairFee: number
  checkedAt: string | null
  createdAt: string
  // --- Device Pipeline (0027) ---
  trackingNumber?: string | null
  deviceStatus?: 'pending_check' | 'checked' | 'pending_sale' | 'priced' | 'transferred' | 'shipped' | 'in_transit' | null
  salePrice?: number | null
  pricedAt?: string | null
  transferredAt?: string | null
  shippedAt?: string | null
  deviceStatusUpdatedAt?: string | null
  deviceStatusBy?: string | null
  deviceModel?: string | null
  // --- Attribution + Repair cost (0035) ---
  attributedFreelancerId?: string | null
  attributedAt?: string | null
  repairCost?: number
  defectNotes?: string | null
  attributedFreelancerName?: string | null
  // --- Shipping method (0052) ---
  courier?: string | null         // ชื่อขนส่ง (EMS, Kerry ฯลฯ)
  returnMethod?: string | null    // 'shipped' | 'walk_in' | null
  returnLocation?: string | null  // สถานที่/รหัสที่คืน (walk_in เท่านั้น)
}

// ===== รายงานการคืนเครื่อง (admin) — ตรงกับ view v_device_return_report (0073) =====
// 1 แถวต่อ 1 สัญญาที่ status IN ('returned','returned_closed')
// 18 เคสเก่าไม่มีแถว device_returns → return_date/caseNo/deviceStatus/returnMethod = null
export interface DeviceReturnReportRow {
  contractId: string
  contractNo: string
  customerName: string
  shopId: string | null
  shopName: string | null
  grade: string | null              // contracts.current_grade
  status: 'returned' | 'returned_closed'
  returnDate: string | null         // device_returns.created_at ล่าสุด (null = 18 เคสเก่า)
  caseNo: number | null
  deviceStatus: string | null       // สถานะเครื่องในมือ (pipeline); null = ไม่มี device_returns
  returnMethod: string | null
  totalInstallments: number
  paidInstallments: number          // นับงวดที่ paid_at not null
  everPaid: boolean                 // paidInstallments > 0
  principalRemaining: number        // sum(greatest(amount - paid_amount, 0)) เงินต้นค้าง (Σทุกงวด = ความเสี่ยง)
  collectibleRemaining: number      // งวดค้างเก่าสุด + ค่าปรับงวดนั้น + ค่าซ่อม = ยอดตามเก็บตามกฎคืนเครื่อง
  repairCost: number                // repair_cost ?? repair_fee ?? 0
  resale: number                    // sale_price ?? 0
  devicePrice: number               // contracts.device_price
}

export interface ShopContractTotal {
  shopId: string
  total: number                     // จำนวนสัญญาทั้งหมดต่อร้าน (ทุก status) — ตัวหารอัตราคืน
}

export type ShopGrade = 'A' | 'B' | 'C' | 'D' | '-'

export interface ShopReportRow {
  shopId: string
  code: string
  name: string
  contracts: number // จำนวนสัญญา
  totalSales: number // ยอดขายรวม (ราคาเครื่องรวม)
  good: number // ลูกค้าดี
  risky: number // ลูกค้าเสี่ยง (ล่าช้า 31 วัน+)
  riskyRate: number // % เสี่ยง (0-100)
  grade: ShopGrade
  lastActivity: string | null // วันที่ส่งเคสล่าสุด (ISO) — null = ยังไม่เคยส่ง
  daysSinceActivity: number | null // ผ่านมากี่วันจากเคสล่าสุด
  active: boolean // ยังเคลื่อนไหว (ส่งเคสใหม่ภายใน 30 วัน)
}

/** สรุปภาพรวมรายงานร้านค้า (การ์ด dashboard) */
export interface ShopReportSummary {
  totalShops: number // ร้านทั้งหมด
  topShop: ShopReportRow | null // ร้านส่งเคสเยอะสุด
  activeShops: number // ร้านที่ยังเคลื่อนไหว
  activePercent: number // % ร้านที่ยังเคลื่อนไหว (0-100)
  inactiveShops: number // ร้านที่เคยส่งเคสแต่เงียบ >30 วัน
  gradeA: number
  gradeD: number
}

export interface NotificationItem {
  id: string
  contractId: string | null
  contractNo: string
  customerName: string
  type: 'due_today' | 'newly_late'
  message: string
  createdAt: string
}

export interface Contract {
  id: string
  // --- เลขอ้างอิง ---
  contractNo: string // เลขที่สัญญา
  invNo: string // เลขที่ INV
  sn: string // หมายเลข SN
  imei?: string // หมายเลข IMEI ของเครื่อง
  // --- ลูกค้า ---
  customerName: string
  nationalId?: string // เลขบัตรประชาชน (PII — แสดงในลิสต์แบบปิดบางส่วน)
  phone: string
  phoneAlt1?: string
  phoneAlt2?: string
  facebookLink?: string
  birthYear?: number // เก็บปีเกิด แล้วคำนวณช่วงอายุ
  occupation?: string
  occupationProof?: string
  // --- เครื่อง ---
  shopId: string
  model: string
  storage: string
  color?: string
  condition: DeviceCondition
  origin: DeviceOrigin
  devicePrice: number // ราคาตัวเครื่อง
  // --- การเงินซื้อเครื่อง (สำหรับสรุปยอดโอนให้ร้าน) ---
  downPercent: number // % ดาวน์
  commissionPercent: number // % คอมมิชชั่น
  docFee: number // ค่าเอกสาร (หักออก)
  // --- การเงินผ่อน ---
  financeAmount: number // ยอดจัดไฟแนนซ์
  monthlyPayment: number // ค่าเช่าต่อเดือน
  termMonths: number // จำนวนเดือน
  dueDay: number // ชำระทุกวันที่ (1-31)
  // --- โปรโมชั่น ---
  hasPromotion: boolean
  promotion?: string
  promotionDetail?: string
  // --- lifecycle ---
  status: ContractStatus
  transactionDate: string // วันที่ทำรายการ (รองรับย้อนหลัง) — ISO yyyy-mm-dd
  operator: string // ผู้ดำเนินการ (พิมพ์เอง)
  recordedBy?: string // ผู้บันทึก — ชื่อ ณ ตอนบันทึก (DB ประทับตราอัตโนมัติ, ใช้คิดค่าคอม)
  recordedById?: string | null // user id ของผู้บันทึก (ไว้จัดกลุ่มคิดค่าคอม)
  commissionRateLocked?: number | null // เรตค่าคอมที่ล็อกไว้ (null = ยังไม่ปิดยอด)
  commissionLockedMonth?: string | null // เดือนที่ปิดยอด เช่น '2026-06' (null = ยังไม่ปิด)
  notes?: string
  // --- flag กันส่งซ้ำ + audit ว่าใครส่ง ---
  summarySentAt?: string | null
  summarySentBy?: string | null // ชื่อผู้ส่ง (useAuth().name = full_name) snapshot ณ เวลาที่ส่ง
  emailSentAt?: string | null
  emailSentBy?: string | null   // ชื่อผู้ส่ง (useAuth().name = full_name) snapshot ณ เวลาที่ส่ง
  // --- เกรดปัจจุบัน (คำนวณจาก days_late, เก็บใน DB — เพิ่มใน 0018) ---
  currentGrade?: string | null // 'A'|'B'|'C'|'D'|'E' หรือ null (ปกติ/ไม่ active)
  // --- flag สถานะพิเศษ (Wave 3) ---
  dnc?: boolean // ห้ามโทร (Do Not Contact)
  dncReason?: string | null // เหตุผลที่ห้ามโทร
  lawyerEngaged?: boolean // ส่งทนายแล้ว
  lawyerName?: string | null // ชื่อทนาย
  lawyerPhone?: string | null // เบอร์ทนาย
  lawyerEngagedAt?: string | null // วันที่ส่งทนาย (ISO date)
  disputed?: boolean // อยู่ระหว่างข้อพิพาท
  disputedSince?: string | null // วันที่เริ่มข้อพิพาท (ISO date)
  // --- promise to pay (Wave 1B — 0020) ---
  promiseToPayDate?: string | null // วันนัดชำระ ISO yyyy-mm-dd (sync จาก trigger)
  promisedAmount?: number | null   // ยอดที่สัญญาไว้ (บาท)
  // --- Case Online / รอเอกสาร (0049) ---
  pendingDocuments?: boolean   // true = รอเอกสาร; suppress สถานะล่าช้าใน view
  pendingDocItems?: string[]   // รายการเอกสารที่รอ เช่น ["บัตรประชาชน","ทะเบียนบ้าน"] (0053)
  // --- ติดตามเอกสารตัวจริง + กล่องโทรศัพท์ (0050) ---
  originalDocsReceived?: boolean       // รับเอกสารตัวจริงแล้ว
  originalDocsReceivedAt?: string | null // timestamp ที่รับ
  originalDocsReceivedBy?: string | null // ชื่อผู้รับ
  hasPhoneBox?: boolean                // สัญญานี้มีกล่องโทรศัพท์ส่งคืนหรือเปล่า
  phoneBoxReceived?: boolean           // รับกล่องโทรศัพท์แล้ว
  phoneBoxReceivedAt?: string | null   // timestamp ที่รับกล่อง
  phoneBoxReceivedBy?: string | null   // ชื่อผู้รับกล่อง
  // --- ธง "รับแล้ว แต่ไม่ครบ/ต้องแก้ไข" (0070) — ไม่กระทบ isDocComplete ---
  docsIncomplete?: boolean             // ติดธงเอกสารไม่ครบ/ต้องแก้ไข
  docsIncompleteItems?: string[]       // คีย์เอกสารที่ขาด เช่น ["contract","receipt"]
  docsIncompleteAt?: string | null     // timestamp ที่ติดธง
  docsIncompleteBy?: string | null     // ชื่อผู้ติดธง
  // --- system timestamp (กฎมือหนึ่งต้องมีกล่อง — ใช้เปรียบเทียบกับ DOC_BOX_RULE_CUTOFF) ---
  createdAt?: string // ISO timestamptz ที่บันทึกสัญญาเข้า DB (ไม่ backdatable)
}

// ---------- Extra Charges (migration 0032) ----------

export interface ExtraCharge {
  id: string
  contractId: string
  amount: number
  reason: string
  createdAt: string
  createdBy: string | null // denormalized name snapshot (text col)
}

// ---------- Other Income (migration 0054) ----------

/** รายได้อื่นๆ ที่ไม่ใช่ค่างวด (เช่น ค่าเปลี่ยนวันชำระ) */
export interface OtherIncome {
  id: string
  contractId?: string | null    // nullable — รายได้อาจไม่ผูกสัญญา
  amount: number
  category: string              // free-text เช่น 'ค่าเปลี่ยนวันที่ชำระ'
  note?: string | null
  receivedAt: string            // 'YYYY-MM-DD' — วันรับเงินจริง
  recordedBy?: string | null    // snapshot ชื่อผู้บันทึก
  createdAt: string             // ISO timestamptz
}

/** สำหรับ execDashboard cashflow bucket (เฉพาะ field ที่ต้องการ) */
export interface OtherIncomeLite {
  amount: number
  receivedAt: string // 'YYYY-MM-DD'
}

// ---------- Grade Mobility (migration 0030) ----------

/** ประเภทการเปลี่ยนแปลงเกรดรายเดือน จาก view v_grade_monthly_changes */
export type GradeChangeType = 'roll' | 'cure' | 'new' | 'exit' | 'same'

/** แถวจาก view v_grade_monthly_changes (Roll/Cure rate รายเดือน) */
export type GradeMonthlyChange = {
  monthBkt: string       // ISO 'YYYY-MM-DD' (month start — truncate ของ month_bkt)
  changeType: GradeChangeType
  cnt: number
}

// ---------- Audit Timeline ----------

export type AuditEventType =
  | 'payment'       // pay / edit / cancel จาก payment_log
  | 'grade_change'  // เปลี่ยนเกรดอัตโนมัติ จาก contract_grade_history
  | 'email_sent'    // ส่งอีเมล (contracts.email_sent_at)
  | 'summary_sent'  // ส่งสรุปยอด (contracts.summary_sent_at)
  | 'follow_up'     // บันทึกการติดตาม จาก follow_ups
  | 'extension'     // ขยายระยะเวลา จาก contract_extensions
  | 'device_status' // เปลี่ยนสถานะเครื่อง จาก device_returns

export type AuditEvent = {
  id: string             // unique: prefixed ตาม eventType เพื่อกัน React key ชน (เช่น email:uuid)
  eventType: AuditEventType
  contractId: string | null
  contractNo: string | null
  customerName: string | null
  actor: string          // ชื่อผู้ทำ หรือ 'ระบบ' ถ้าเป็น auto trigger
  action: string         // ข้อความไทยอ่านง่าย เช่น "ยืนยันชำระ 5,000 ฿"
  details: string | null // บริบทเพิ่มเติม เช่น "เกรด A → B", เหตุผลยกเลิก
  at: string             // ISO timestamp (ใช้ sort + display)
}

// ---------- Overdue Promise Contracts (badge ที่ /queue) ----------

/** สัญญาที่ผิดนัดจ่าย (promise_to_pay_date < today AND status=active) */
export type OverduePromiseContract = {
  id: string
  contractCode: string      // contracts.contract_no
  customerName: string
  promiseToPayDate: string  // 'YYYY-MM-DD'
  promisedAmount: number | null
  daysPastPromise: number   // today - promise_to_pay_date (วันที่เลยนัดมาแล้ว)
}

// ---------- Private Notes per contract (migration 0037) ----------

/** โน้ตส่วนตัวของพนักงานคนนึงต่อสัญญาคนนึง — RLS คุม: อ่านได้เฉพาะเจ้าของ + admin */
export interface PrivateNote {
  id: string
  contractId: string
  userId: string
  authorName?: string  // join profiles.full_name (admin view เท่านั้น)
  content: string
  createdAt: string
  updatedAt: string
}

// ---------- DEBTFLOW import (migration 0064) ----------

/** เคสติดตามหนี้ที่ import จาก DEBTFLOW — admin อ่านอย่างเดียว */
export interface DebtflowCase {
  id: string
  contractId: string | null       // link กลับ contracts.id (null ถ้าแมตช์ source_inv ไม่ได้)
  contractNo: string | null       // join contracts.contract_no (ถ้าแมตช์แล้ว)
  sourceInv: string               // เลขสัญญาจาก DEBTFLOW (cleaned)
  customerName: string | null
  dueDate: string | null          // 'YYYY-MM-DD'
  daysLate: number | null
  grade: string | null
  primaryPhone: string | null
  callStatus: string | null
  phoneAlt1: string | null
  phoneAlt2: string | null
  deviceStatus: string | null
  conversationNote: string | null
  promiseDate: string | null      // 'YYYY-MM-DD'
  assignedEmployee: string | null
  paymentStatus: string | null
  installmentAmount: number | null
  cumulativePaid: number | null
  dateAdded: string | null        // 'YYYY-MM-DD'
  lastUpdate: string | null       // ISO timestamptz
  importedAt: string
}

/** สรุป aggregate ของ DEBTFLOW batch สำหรับหน้ารายงาน */
export interface DebtflowSummary {
  totalCases: number
  totalCollected: number           // Σ cumulative_paid
  closedCases: number              // payment_status = 'ชำระเงินครบแล้ว'
  byEmployee: DebtflowByEmployee[]
  byGrade: DebtflowByGrade[]
  byPaymentStatus: DebtflowByStatus[]
}

export interface DebtflowByEmployee {
  employee: string
  cases: number
  collected: number
  closed: number
  outstandingHeld: number   // Σ overdue_amount ของเคสที่พนักงานรับผิดชอบ (ยอดเลยกำหนดยังไม่จ่าย)
  closedRate: number        // round(100 * closed / cases) — จำนวนเต็ม
  avgPerCase: number        // round(collected / cases)
}

export interface DebtflowByGrade {
  grade: string
  cases: number
  collected: number
}

export interface DebtflowByStatus {
  status: string
  n: number
}

// ---------- PJ Recovery report (migration 0066) ----------
// รายงาน "การตามหนี้ย้อนหลังจาก PJ" — สรุปเงินที่ตามกลับมาได้จากงวดที่จ่ายช้า
// (recovered = งวดจ่ายช้า ไม่ใช่แถวค่าปรับ) อ่านจาก 4 aggregate views

/** สรุปรวมการตามหนี้จาก PJ (1 แถว จาก v_pj_recovery_summary) */
export interface PjRecoverySummary {
  lateContracts: number
  lateInstallments: number
  recoveredTotal: number
  avgDaysLate: number
  maxDaysLate: number
}

/** เงินตามกลับรายเดือน (จาก v_pj_recovery_monthly) */
export interface PjRecoveryMonth {
  month: string          // 'YYYY-MM'
  installments: number
  contracts: number
  recoveredBaht: number
}

/** เงินตามกลับแยกพนักงาน (จาก v_pj_recovery_by_employee — เฉพาะเคสที่อยู่ใน DEBTFLOW) */
export interface PjRecoveryEmployee {
  employee: string
  contracts: number
  lateInstallments: number
  recoveredBaht: number
  avgDaysLate: number
}

/** การกระจายวันช้าของงวด recovery (จาก v_pj_days_late_dist) */
export interface PjDaysLateBucket {
  bucket: string         // '1-7' | '8-30' | '31-60' | '61-90' | '90+'
  installments: number
  contracts: number
}

// ---------- PJ Recovery outcome — ตามเก็บได้ vs ยังเก็บไม่ได้ (migration 0067) ----------
// cohort ตามเดือนครบกำหนด (due_date): recovered = จ่ายช้าแล้วในที่สุดจ่าย,
// outstanding = เลยกำหนดแล้วยังไม่จ่าย. อัตราสำเร็จ % คำนวณฝั่ง frontend

/** ตามเก็บได้ vs ยังเก็บไม่ได้ รายเดือนครบกำหนด (จาก v_pj_recovery_outcome_monthly) */
export interface PjRecoveryOutcomeMonth {
  month: string          // 'YYYY-MM' (เดือนของ due_date)
  recoveredInstallments: number
  recoveredBaht: number
  outstandingInstallments: number
  outstandingBaht: number
}

/** สรุปรวม ตามเก็บได้ vs ยังเก็บไม่ได้ (1 แถว จาก v_pj_recovery_outcome_summary) */
export interface PjRecoveryOutcomeSummary {
  recoveredInstallments: number
  recoveredBaht: number
  outstandingInstallments: number
  outstandingBaht: number
}

// ---------- Letter outcome report — วัดผลจดหมายติดตามหนี้ (migration 0069) ----------
// คำนวณ auto ว่าส่งจดหมายแล้วลูกค้าจ่าย/คืนเครื่องกี่ % — attribution ให้จดหมาย
// ฉบับล่าสุดก่อนจ่าย (จ่าย/คืนต้องเกิดก่อนจดหมายฉบับถัดไป). อ่านจาก 3 aggregate views

/** ผลลัพธ์ต่อจดหมาย 1 ฉบับ (จาก v_letter_outcomes — drill-down) */
export interface LetterOutcome {
  letterId: string
  contractId: string
  contractNo: string
  customerName: string
  round: number
  printedAt: string
  outcome: 'paid' | 'returned' | 'no_response'
  respondedAt: string | null
  daysToOutcome: number | null
}

/** สรุปรวมวัดผลจดหมาย (1 แถว จาก v_letter_outcome_summary) */
export interface LetterOutcomeSummary {
  totalLetters: number
  paidCount: number
  returnedCount: number
  noResponseCount: number
  effectiveCount: number
  effectivenessPct: number
  avgDaysToOutcome: number
}

/** วัดผลจดหมายแยกตามรอบ (จาก v_letter_outcome_by_round — 1 แถว/round 1,2,3) */
export interface LetterOutcomeByRound {
  round: number
  paidCount: number
  returnedCount: number
  noResponseCount: number
  effectiveCount: number
  effectivenessPct: number
  avgDaysToOutcome: number
}

// ---------- Collector call & promise outcomes — per คนติดตามหนี้ (migration 0068) ----------
// 1 row ต่อ author (freelancer active) จาก RPC get_collector_call_outcomes(p_start, p_end)
// รองรับภาพรวมทีม (รวมทุกแถว) + รายคน. promisesKept + promisesBroken + promisesPending = promisesMade

/** ผลการโทร + ผลการนัดชำระ ต่อคนติดตามหนี้ ตามช่วงวัน */
export interface CollectorCallOutcome {
  authorId: string
  authorName: string
  casesFollowed: number      // สัญญา (distinct) ที่บันทึก follow-up อย่างน้อย 1 ครั้ง
  casesReached: number       // สัญญาที่ติดต่อลูกค้าได้จริงอย่างน้อย 1 ครั้ง
  casesNoAnswer: number      // สัญญาที่มี no_answer อย่างน้อย 1 ครั้ง
  casesUnreachable: number   // สัญญาที่ติดต่อไม่ได้เลย (มี no_answer แต่ไม่เคยติดต่อได้)
  promisesMade: number       // จำนวนครั้งที่นัดชำระ (result='promised' + มีวันนัด)
  promisesKept: number       // นัดที่ลูกค้าจ่ายในกรอบเวลานัด
  promisesBroken: number     // นัดที่ไม่จ่าย และเลยวันนัดแล้ว (ผิดนัด)
  promisesPending: number    // นัดที่ยังไม่ถึงวันนัด (ยังไม่ตัดสิน)
}
