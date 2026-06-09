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
  // --- ลูกค้า ---
  customerName: string
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
  operator: string // ผู้ดำเนินการ
  notes?: string
  // --- flag กันส่งซ้ำ ---
  summarySentAt?: string | null
  emailSentAt?: string | null
}
