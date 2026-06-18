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
  deviceStatus?: 'pending_check' | 'checked' | 'pending_sale' | 'priced' | 'transferred' | 'shipped' | null
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
  pendingDocuments?: boolean // true = รอเอกสาร; suppress สถานะล่าช้าใน view
  // --- ติดตามเอกสารตัวจริง + กล่องโทรศัพท์ (0050) ---
  originalDocsReceived?: boolean       // รับเอกสารตัวจริงแล้ว
  originalDocsReceivedAt?: string | null // timestamp ที่รับ
  originalDocsReceivedBy?: string | null // ชื่อผู้รับ
  hasPhoneBox?: boolean                // สัญญานี้มีกล่องโทรศัพท์ส่งคืนหรือเปล่า
  phoneBoxReceived?: boolean           // รับกล่องโทรศัพท์แล้ว
  phoneBoxReceivedAt?: string | null   // timestamp ที่รับกล่อง
  phoneBoxReceivedBy?: string | null   // ชื่อผู้รับกล่อง
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
