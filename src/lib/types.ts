// ===== ชนิดข้อมูลหลักของระบบ WIN SURE PLUS =====
// ไฟล์นี้เป็น "พิมพ์เขียว" ของข้อมูล ใช้ร่วมกันทั้งเว็บ
// ภายหลังจะ map ตรงกับตารางใน Supabase

import type { LateBucket } from './collectorPeriod'

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
  estOutstanding: number // รวมยอดคงเหลือ (มีใน view อยู่แล้วแต่ยังไม่ map) — เพิ่มใน 0126
  paidInstallments: number // งวดที่จ่ายแล้ว — เพิ่มใน 0126
  paidAmountTotal: number // ยอดเงินที่จ่ายแล้วรวม (ไม่รวมค่าปรับ) — เพิ่มใน 0126
  lateInstallments: number // จำนวนงวดที่เลยกำหนดและยังไม่จ่ายครบ — เพิ่มใน 0126
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
  imei?: string | null
  sn?: string | null
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

export type ShopGrade = 'A' | 'B' | 'C' | 'E' | '-'

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
  // --- ทิ้งงวดแรก (ไม่เคยจ่ายสักงวด) — แยก 2 กลุ่ม ---
  firstDefaultHolding: number // active + ไม่เคยจ่าย + งวดแรกเลยกำหนด (daysLate>0) — ยังถือเครื่อง (ตัวร้ายสุด)
  firstDefaultReturned: number // returned/returned_closed + ไม่เคยจ่าย — คืนเครื่องแล้ว
  firstDefaultHoldingValue: number // เงินเสี่ยงของกลุ่มถือเครื่อง (Σ financeAmount)
  firstDefaultHoldingRate: number // % holding ของสัญญาทั้งร้าน (0-100)
  firstDefaultReturnedRate: number // % returned ของสัญญาทั้งร้าน (0-100)
}

/** สรุปภาพรวมรายงานร้านค้า (การ์ด dashboard) */
export interface ShopReportSummary {
  totalShops: number // ร้านทั้งหมด
  topShop: ShopReportRow | null // ร้านส่งเคสเยอะสุด
  activeShops: number // ร้านที่ยังเคลื่อนไหว
  activePercent: number // % ร้านที่ยังเคลื่อนไหว (0-100)
  inactiveShops: number // ร้านที่เคยส่งเคสแต่เงียบ >30 วัน
  gradeA: number
  gradeE: number
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
  // --- สรุปยอด 2 ด่าน (0075): รอบ 1 ส่งร้าน / รอบ 2 ส่งบัญชี ---
  summaryShopSentAt?: string | null
  summaryShopSentBy?: string | null       // ผู้ส่งสรุปยอดให้ร้าน (รอบ 1)
  summaryAccountingSentAt?: string | null
  summaryAccountingSentBy?: string | null // ผู้ส่งสรุปยอดให้บัญชี (รอบ 2)
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
  // --- ปิดสัญญาก่อนกำหนด + ส่วนลด (0078) — บันทึกตอน settle_contract_early ---
  settledAt?: string | null            // timestamp ที่ปิดสัญญาก่อนกำหนด
  settlementDiscount?: number | null   // ส่วนลดเป็นบาท
  settlementRemaining?: number | null  // เงินต้นที่เหลือ (ก่อนหักส่วนลด)
  settlementPaid?: number | null       // ลูกค้าจ่ายปิดจริง
  settledBy?: string | null            // ชื่อผู้กดปิด
  // --- ถูกบัญชีตีกลับ ต้องแก้ (0084) — โชว์เป็นป้ายที่หน้า waiting-summary ---
  needsFixReason?: string | null       // 'docs_incorrect'|'price_incorrect'|'duplicate'|'missing_info'|'other'
  needsFixDetail?: string | null       // รายละเอียด/หมายเหตุประกอบ
  needsFixBy?: string | null           // ชื่อคนตีกลับ
  needsFixAt?: string | null           // เวลาที่ตีกลับ
  // --- ระบบจองเคส claim/release (0086) + มอบหมายเคส admin/staff (0099) ---
  assignedTo?: string | null           // uuid ของ profiles ผู้ถือเคสอยู่ — null = ว่าง
  assignedAt?: string | null           // เวลาที่ claim/มอบหมายล่าสุด
  assignedToName?: string | null       // ชื่อผู้ถือเคส (join profiles.full_name, เติมเฉพาะ getContract) — undefined = ยังไม่ได้ query
  // --- หมายเหตุเคสติดปัญหา (0089) — พนักงานโน้ตเองว่าสรุปยอดไม่ได้เพราะติดอะไร คนละระบบกับ needsFix_* ---
  summaryNote?: string | null          // ข้อความโน้ตอิสระ — null = ไม่มีโน้ตค้าง
  summaryNoteBy?: string | null        // ชื่อคนเขียนโน้ตล่าสุด
  summaryNoteAt?: string | null        // เวลาที่เขียน/แก้โน้ตล่าสุด
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
  feeKind?: import('./feeReconcile').FeeKind | null // ค่าธรรมเนียมสิทธิ์ไหน (migration 0106) — null = รายได้ทั่วไป
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
  | 'summary_sent'  // ส่งสรุปยอด (contracts.summary_sent_at) — legacy รวม ใช้ใน getAuditTimeline
  | 'summary_shop_sent'        // ส่งสรุปยอดให้ร้าน (contracts.summary_shop_sent_at) — ใช้ใน getDailyAudit
  | 'summary_accounting_sent'  // ส่งสรุปยอดให้บัญชี (contracts.summary_accounting_sent_at) — ใช้ใน getDailyAudit
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

// ---------- Collection monthly — อัตราเก็บเงินย้อนหลังรายเดือน (migration 0102) ----------
// นับตามเดือนที่ครบกำหนด (due_date): จ่ายแล้ว vs ยังค้าง — ไม่พึ่งวันที่จ่าย
// (paid_at ย้อนหลังเป็น placeholder จึงเชื่อ "จ่าย/ค้าง" ได้ แต่เชื่อ "จ่ายช้ากี่วัน" ไม่ได้)

/** อัตราเก็บเงินรายเดือนครบกำหนด (จาก v_collection_monthly) */
export interface CollectionMonthlyRow {
  month: string          // 'YYYY-MM' (เดือนของ due_date)
  total: number          // งวดที่ครบกำหนดในเดือนนั้น (due_date <= วันนี้)
  paid: number           // งวดที่เก็บได้ (paid_at ไม่ว่าง)
  unpaid: number         // งวดที่ยังค้าง (paid_at ว่าง)
  collectedBaht: number  // ยอดที่เก็บได้ (บาท)
  pctCollected: number   // % เก็บได้ = round(100 * paid / total)
  // มุมเฉพาะเคสเดินอยู่ (contract.status='active') — ตัดคืนเครื่อง/ปิดสัญญาออก (migration 0103)
  activeTotal: number          // งวดครบกำหนดของเคส active
  activePaid: number           // เก็บได้ (เคส active)
  activeUnpaid: number         // ยังค้าง (เคส active)
  activeCollectedBaht: number  // ยอดเก็บได้ เคส active (บาท)
  activePctCollected: number   // % เก็บได้ เคส active (null → 0 ถ้าเดือนนั้นไม่มีเคส active)
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

// ---------- PJ auto-sync review box (migration 0077) ----------
// กล่องรอตรวจ PJ — เคสที่ระบบ auto-sync (รันทุก 15 นาที) ลงไม่ได้เพราะไม่ตรงเป๊ะ
// (จ่ายข้ามงวด/บางส่วน/หาสัญญาไม่เจอ/ประเภทอื่น/ยอดไม่ตรง) → admin มาตรวจเอง

/** เหตุผลที่เคสเข้ากล่องรอตรวจ
 * RECEIPT_MISSING / RECEIPT_CHANGED = ตรวจจับ drift ใบเสร็จ PJ (16 ก.ค. 2026) — ร้านลบ/แก้ใบใน PJ
 * หลังเราดึงมาลงแล้ว ดู src/lib/pjReceiptDrift.ts (evaluateReceiptDrift + driftKindToReviewReason):
 *   RECEIPT_MISSING  ← kind='missing' (หา uuid ไม่เจอใน PJ แล้ว, streak>=2 ถึงจะแจ้ง)
 *   RECEIPT_CHANGED  ← kind='amount'|'type'|'date' (uuid ยังอยู่ใน PJ แต่ค่าต่างจากที่เราจด)
 * รายละเอียดจริง (เราถือ X / PJ ว่า Y) อยู่ใน raw_json ตาม PjReceiptDriftSnapshot
 * RETURNED_CONTRACT_PAYMENT = mode "returned_watch" ของ pj-sync (23 ก.ค. 2026) — PJ ซ่อนใบเสร็จของ
 * สัญญาคืนเครื่องจาก feed ปกติ ทำให้ auto-sync มองไม่เห็นเงินที่เข้าจริง. แถวนี้ pj_amount = ส่วนต่างที่
 * PJ ได้รับเกินกว่าที่เราบันทึก — ไม่มี flow ลงเงินอัตโนมัติ (ต่างจาก MULTI/PARTIAL) ต้องให้พนักงานเปิด PJ
 * เทียบยอดแล้วลงเงินเองที่หน้าสัญญา
 * RETURNED_CONTRACT_OVERAGE = mode "returned_watch" เหมือนกัน แต่กลับด้าน — สัญญาคืนเครื่องที่ระบบเรา
 * บันทึกไว้ "มากกว่า" ที่ PJ ได้รับจริง (อาจลงซ้ำฝั่งเรา หรือใบเสร็จถูกลบฝั่ง PJ) — เหมือนกัน คือต้องคน
 * ตรวจมือเท่านั้น ห้ามมี flow ลงเงินอัตโนมัติ (isManualOnlyReason ต้องคุมทั้งคู่) */
export type PjSyncReviewReason =
  | 'MULTI'
  | 'PARTIAL'
  | 'UNMATCHED'
  | 'OTHER'
  | 'AMOUNT_MISMATCH'
  | 'RECEIPT_MISSING'
  | 'RECEIPT_CHANGED'
  | 'RETURNED_CONTRACT_PAYMENT'
  | 'RETURNED_CONTRACT_OVERAGE'

/** สถานะของเคสในกล่องรอตรวจ */
export type PjSyncReviewStatus = 'pending' | 'resolved' | 'skipped' | 'auto_resolved'

/** 1 เคสในกล่องรอตรวจ (จาก pj_sync_review join contracts) */
export interface PjSyncReviewRow {
  id: string
  createdAt: string
  invoiceNo: string
  paymentType: string | null
  amount: number
  paidDate: string | null            // 'YYYY-MM-DD'
  contractId: string | null          // null = หาสัญญาไม่เจอ
  contractNo: string | null          // join contracts.contract_no
  customerName: string | null        // join contracts.customer_name
  reason: PjSyncReviewReason
  status: PjSyncReviewStatus
  penaltyAmount: number              // Σ amount ของ raw_json ที่ payment_type='penalty' (ค่าปรับใน batch นี้)
  /** uuid ดิบต่อใบเสร็จจาก PJ (field "uuid" ใน raw_json — migration 0100 pj_applied_receipts) — [] = ไม่มี (แถวเก่า/raw_json ไม่มี field นี้) */
  receiptUuids: string[]
  /** uuid ใบ invoice ฝั่ง PJ (23 ก.ค. 2026) — มีเฉพาะแถวจาก mode "returned_watch" (raw_json เป็น object
   *  ไม่ใช่ array — reason RETURNED_CONTRACT_PAYMENT/RETURNED_CONTRACT_OVERAGE) ไว้เปิดหน้า invoice ใน PJ
   *  ตรงๆ ให้พนักงานเทียบยอด — null = ไม่มี (แถวปกติจาก raw_json array ไม่มี invoice uuid ต่อแถว) */
  invUuid: string | null
}

/** บริบทประกอบการตัดสินใจในกล่องรอตรวจ — งวดถัดไป + ยอดรวม + ประวัติชำระล่าสุด */
export interface PjReviewContext {
  monthly: number                    // ค่างวดต่อเดือนของสัญญา
  nextUnpaid: {                      // งวดแรกที่ยังไม่จ่าย (status pending|late) — null = จ่ายครบ/ไม่มีงวด
    id: string
    no: number
    amount: number
    paid: number
    remaining: number                // max(amount - paid, 0)
  } | null
  totalPaid: number                  // Σ paid_amount ทุกงวด
  totalDue: number                   // Σ amount ทุกงวด
  recentPayments: {                  // payment_log action='pay' ล่าสุด 8 รายการ (ใหม่→เก่า)
    date: string                     // created_at::date (YYYY-MM-DD)
    principal: number                // amount
    penalty: number                  // penalty_paid_amount
    byName: string
    installmentNo: number | null     // join installments.installment_no
  }[]
  unpaidInstallments: {              // งวดที่ยังไม่จ่ายเรียง installment_no — ไว้พรีวิวการตัด record_payment_spread
    no: number
    amount: number                   // ค่างวดเต็มของงวดนี้ (ไว้เทียบยอดแปลก — pjReviewDup.ts)
    remaining: number                // max(amount - paid_amount, 0)
  }[]
  siblingReviewRows: {                // แถวอื่น (status='pending') ในกล่องรอตรวจของสัญญาเดียวกัน — ไว้เช็คซ้ำ/บริบท (pjReviewDup.ts)
    id: string
    paidDate: string | null           // 'YYYY-MM-DD'
    amount: number
    penaltyAmount: number
    reason: PjSyncReviewReason
  }[]
  /** งวดที่ค่าปรับจะไปลง (18 ก.ค. 2026, mig 0115/0116) — เลียนแบบ target-selection ของ record_payment_spread:
   *  งวดเก่าสุด (installment_no น้อยสุด) ที่ penalty_amount > ค่าปรับที่จ่ายแล้วสะสม, fallback งวด unpaid แรกสุด
   *  ถ้าไม่มีงวดไหนเลย (สัญญาไม่มีงวด/ปิดหมดแล้วไม่มีที่ลง) = null — ให้หน้าจออธิบาย "ระบบเราคิด Y" เทียบกับ PJ ได้ */
  penaltyTarget: {
    installmentNo: number
    chargedPenalty: number  // ค่าปรับที่ระบบเราคิด ณ วันนี้ของงวดนี้ (penalty_accrual_for_installment mig 0116 — sticky ถ้า settled)
    penaltyPaid: number     // ค่าปรับที่จ่ายแล้วจริงสะสมของงวดนี้ (penalty_paid_for_installment mig 0115)
    settled: boolean        // true = จ่ายค่าปรับทันยอดที่ค้าง ณ วันหนึ่งแล้ว (แช่แข็ง ไม่โตต่อ)
  } | null
}

/** 1 รอบการรัน auto-sync (จาก pj_sync_runs) */
export interface PjSyncRunRow {
  id: string
  startedAt: string
  finishedAt: string | null
  status: 'running' | 'success' | 'login_failed' | 'error'
  receiptsFetched: number
  autoAppliedCount: number
  autoAppliedAmount: number
  reviewCount: number
  errorDetail: string | null
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

// ---------- Collector collection by late-bucket — per คนติดตามหนี้ (migration 0118) ----------
// 1 row ต่อ (author, bucket) จาก RPC get_collector_collection_by_bucket(p_start, p_end)
// ≤8 แถวต่อคน (LATE_BUCKETS length) — aggregate มาจาก DB แล้ว ห้าม aggregate ซ้ำฝั่ง client

/** ยอดเก็บของคนติดตามหนี้ แยกตามกลุ่มค้าง (LateBucket) ตามช่วงวัน */
export interface CollectorBucketRow {
  authorId: string
  authorName: string
  bucket: LateBucket
  payments: number       // จำนวนครั้งที่จ่าย
  collectedBaht: number  // ยอดเงินรวม
}

// ---------- Collector ownership + recovery — migration 0120 ----------
// 3 RPC: ความเป็นเจ้าของเคส (ขอบเขตเกรด vs กดรับจริง) / กองกลาง / ปิดเคสสำเร็จ

/**
 * 1 แถวต่อ freelancer ที่ถือเกรดอยู่ตอนนี้ จาก RPC get_collector_ownership(p_start, p_end)
 * ⚠️ scopeCases/scopeBaht นับซ้ำข้ามคนตั้งใจ (เกรดเดียวหลายคนถือ = เห็นก้อนเดียวกันเต็ม) —
 * ใช้ maxSharers เตือนบน UI ห้ามเอา scopeBaht ของแต่ละคนไปรวมกันแล้วอ้างว่าเป็นยอดพอร์ตค้างจริง
 */
export interface CollectorOwnershipRow {
  authorId: string
  authorName: string
  grades: string          // เกรดที่ถืออยู่ เช่น 'A, B'
  scopeCases: number       // เคสค้างในเกรดที่ตัวเองถือ (นับซ้ำข้ามคนที่ถือเกรดเดียวกัน)
  scopeBaht: number
  maxSharers: number       // จำนวนคนมากสุดที่แชร์เกรดเดียวกับตัวเอง
  claimedCases: number     // เคสค้างที่กดรับจริง (assigned_to = ตัวเอง)
  claimedBaht: number
  touchedCases: number     // เคสในขอบเขตที่มี follow-up ของตัวเองอย่างน้อย 1 ครั้งในช่วง
}

/** กองกลาง — เคสค้างที่เกรดไม่มีใครถือเลย จาก RPC get_unowned_arrears() (ไม่มีพารามิเตอร์ — สถานะ ณ ปัจจุบัน) */
export interface UnownedArrearsRow {
  grade: string    // '(ไม่มีเกรด)' ถ้าสัญญาไม่มีเกรด
  cases: number
  baht: number
}

/**
 * ปิดเคสสำเร็จ (ลูกค้าจ่ายจนหายค้างสนิท) จาก RPC get_collector_recoveries(p_start, p_end)
 * authorId = null → ไม่มีสายนำ (ไม่มีใครโทรใน 7 วันก่อนปิด) — ห้ามซ่อนแถวนี้บน UI
 */
export interface CollectorRecoveryRow {
  authorId: string | null
  authorName: string
  recoveries: number       // จำนวนครั้งที่ปิดรอยค้างสำเร็จ (ไม่ dedupe — สัญญาเดียวหายค้างซ้ำได้)
  recoveredBaht: number
}

/**
 * สะสมตลอดกาล (ไม่ผูกช่วงวันที่) จาก RPC get_collector_ever_held() — ไม่รับพารามิเตอร์
 * everHeld = distinct สัญญาที่เคยมี follow_up x มูลค่า est_outstanding "ปัจจุบัน" (ไม่ใช่ตอนดูแล)
 * lost = subset ที่ status ปัจจุบันเป็น returned/returned_closed x overdue_amount ปัจจุบัน
 * ⚠️ ไม่ dedupe ข้ามคน — เคสเดียวหลายคนเคยโทร = ทุกคนได้เครดิตเต็ม (เหมือน CollectorOwnershipRow)
 */
export interface CollectorEverHeldRow {
  authorId: string
  authorName: string
  everHeldCases: number
  everHeldBaht: number
  lostCases: number
  lostBaht: number
}

/**
 * เงินเก็บได้จริงวันนี้ — ทุกช่องทาง (ทีมโทรตามได้ + ลูกค้าจ่ายเอง + PJ auto-sync)
 * นับตาม record date (วันบันทึกเข้าระบบ, Asia/Bangkok) จาก v_cashflow_daily (migration 0056)
 * ไม่มี breakdown 5 หมวด (installment/down/docFee/other) เพราะต้อง join contracts + other_income หนัก —
 * ถ้าต้องการ breakdown เต็มดู getCashflowRows() ใน execDashboard.ts (คำนวณช่วงวันที่เลือกได้ ไม่ใช่แค่วันนี้)
 */
export interface CashCollectedToday {
  payDate: string        // วันนี้ตาม Asia/Bangkok (YYYY-MM-DD) ที่ใช้ query
  income: number         // ยอดรับรวมวันนี้ = principal + penalty_paid_amount, 0 ถ้ายังไม่มีเงินเข้า
  penaltyIncome: number  // ยอดค่าปรับแยกวันนี้
  payCount: number       // จำนวนรายการ action='pay' วันนี้
}

/**
 * โอนเงินร้าน "หลายสลิปต่อร้านต่อวัน" (mig 0104)
 * 1 สลิป (shop_transfer 1 แถว) = จ่ายให้ N สัญญา (shop_transfer_item)
 */
export interface TransferSlipItem {
  id: string             // shop_transfer_item.id
  contractId: string
  contractNo?: string    // join จาก contracts (โชว์ใน UI)
  customerName?: string  // join จาก contracts
  amount: number         // ยอดที่บันทึกว่าจ่ายให้เคสนี้
}

export interface TransferSlip {
  id: string             // shop_transfer.id (= transfer_id)
  shopId: string
  transferDate: string   // YYYY-MM-DD
  amount: number         // ยอดสลิป (บัญชีแก้เองได้ — default = Σ item)
  slipPath: string | null
  transferredBy: string | null
  transferredAt: string | null
  note: string | null
  slipWaived: boolean    // ยืนยันย้อนหลังไม่มีสลิป
  voided: boolean        // ถูกยกเลิก (soft delete)
  items: TransferSlipItem[]
}

/** 1 แถวต่อ (ร้าน,วัน) จาก v_transfer_slip_summary + ชื่อร้าน */
export interface TransferSlipSummaryRow {
  date: string           // transfer_date (YYYY-MM-DD)
  shopId: string
  shopName: string
  slipCount: number
  totalAmount: number
}
