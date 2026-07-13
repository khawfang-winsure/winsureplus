// โครงเมนูด้านซ้าย — แก้ที่เดียว มีผลทั้งเว็บ
import {
  AlertTriangle,
  BarChart3,
  CalendarRange,
  Gauge,
  History,
  Inbox,
  LayoutDashboard,
  Landmark,
  Percent,
  Phone,
  Settings,
  TrendingUp,
  Truck,
  Users,
  type LucideIcon,
} from 'lucide-react'

export interface NavChild {
  to: string
  label: string
  adminOnly?: boolean
  /** หัวข้อย่อย (เส้นคั่น) ที่จะโชว์เหนือลิงก์นี้ — ใช้แบ่งกลุ่มย่อยภายใน submenu เดียวกัน */
  sectionLabel?: string
}

export interface NavItem {
  to?: string
  label: string
  icon: LucideIcon
  children?: NavChild[]
  adminOnly?: boolean // ซ่อนจากพนักงาน (staff) — เห็นเฉพาะแอดมิน
  freelancerOnly?: boolean // เห็นเฉพาะผู้ติดตามหนี้ — ซ่อนจาก admin/staff
  executiveVisible?: boolean // executive เห็นด้วยทั้งที่ adminOnly=true
  accountingOnly?: boolean // เห็นเฉพาะบัญชี — ซ่อนจาก admin/staff/freelancer/executive
}

export const NAV: NavItem[] = [
  // กลุ่ม freelancer — แยกออกมา ไม่อยู่ในกลุ่มหลัก
  { to: '/queue', label: 'คิวติดตาม', icon: Phone, freelancerOnly: true },
  { to: '/my-performance', label: 'ผลงานของฉัน', icon: TrendingUp, freelancerOnly: true },

  // กลุ่ม accounting — แยกออกมา ไม่อยู่ในกลุ่มหลัก (admin เห็นด้วย)
  { to: '/transfers', label: 'โอนเงินร้าน', icon: Landmark, accountingOnly: true },

  // เมนูหลัก — item เดี่ยวบนสุด
  { to: '/', label: 'ภาพรวม', icon: LayoutDashboard },
  { to: '/exec', label: 'Dashboard ผู้บริหาร', icon: Gauge, adminOnly: true, executiveVisible: true },
  { to: '/monthly-report', label: 'รายงานประจำเดือน', icon: CalendarRange, adminOnly: true, executiveVisible: true },
  { to: '/shop-promo-analysis', label: 'วิเคราะห์ร้านเพื่อจัดโปร', icon: Percent, adminOnly: true, executiveVisible: true },
  { to: '/staff-daily-report', label: 'รายงานการทำงานพนักงานรายวัน', icon: History, adminOnly: true, executiveVisible: true },
  { to: '/transfer-summary', label: 'สรุปการโอนเงินร้าน', icon: Landmark, adminOnly: true, executiveVisible: true },

  // กลุ่มพับได้: รับเรื่อง/บันทึก
  {
    label: 'รับเรื่อง/บันทึก',
    icon: Inbox,
    children: [
      { to: '/inbox', label: 'กล่องรับงาน' },
      { to: '/pj-sync-review', label: 'กล่องรอตรวจ PJ' },
      { to: '/add', label: 'เพิ่มข้อมูลสัญญา' },
      { to: '/waiting-email', label: 'รอส่งอีเมล' },
      { to: '/waiting-summary', label: 'รอสรุปยอด' },
      { to: '/other-income', label: 'รายได้อื่นๆ' },
    ],
  },

  // กลุ่มพับได้: ลูกค้า & หนี้
  {
    label: 'ลูกค้า & หนี้',
    icon: Users,
    children: [
      { to: '/due', label: 'ลูกค้าถึงวันครบกำหนด' },
      { to: '/customers', label: 'ลูกค้าทั้งหมด' },
      { to: '/extended', label: 'ลูกค้าขยายระยะเวลา' },
      { to: '/customer-overview', label: 'วิเคราะห์ลูกค้า (กราฟ)' },
      { to: '/letters', label: 'ส่งจดหมาย' },
    ],
  },

  // ลูกค้าล่าช้า-หนี้เสีย — เดิมพับ 6 ลิงก์แยกช่วงวัน ยุบเหลือลิงก์เดียว
  // เข้าหน้าเดียว (/overdue/:bucket) แล้วสลับช่วงด้วยแท็บในหน้าแทน — bucket 'last' = เปิดช่วงที่จำไว้ล่าสุด
  { to: '/overdue/last', label: 'ลูกค้าล่าช้า-หนี้เสีย', icon: AlertTriangle },

  // กลุ่มพับได้: เครื่อง & เอกสาร
  {
    label: 'เครื่อง & เอกสาร',
    icon: Truck,
    children: [
      { to: '/doc-tracking', label: 'รับเอกสาร/กล่อง' },
      { to: '/device-pipeline', label: 'ติดตามเครื่อง' },
      { to: '/returns', label: 'ลูกค้าคืนเครื่อง' },
    ],
  },

  // รายงาน (collapsible)
  {
    label: 'รายงาน',
    icon: BarChart3,
    adminOnly: true, // ซ่อนทั้งกลุ่มจากพนักงาน (staff) — เห็นเฉพาะแอดมิน
    executiveVisible: true, // exec เห็นกลุ่มนี้ด้วย แต่เห็นเฉพาะ child ที่ไม่ได้ตั้ง adminOnly (ตอนนี้คือ /staff-performance เท่านั้น)
    children: [
      { to: '/commission', label: 'ค่าคอมมิชชั่น', adminOnly: true, sectionLabel: 'การเงิน' },
      { to: '/settlements', label: 'ปิดสัญญาก่อนกำหนด', adminOnly: true },
      { to: '/weekly-summary', label: 'สรุปรายสัปดาห์', adminOnly: true },

      { to: '/shop-report', label: 'รายงานร้านค้า', adminOnly: true, sectionLabel: 'ร้านค้า-เครื่อง' },
      { to: '/sale-history', label: 'ประวัติการขายเครื่อง', adminOnly: true },
      { to: '/returns-report', label: 'รายงานการคืนเครื่อง', adminOnly: true },

      { to: '/staff-performance', label: 'สรุปภาพรวมการติดตามหนี้', sectionLabel: 'ทีมตามหนี้' },
      { to: '/hr-report', label: 'รายงาน HR ทีมโทร' },
    ],
  },

  // ตั้งค่า (collapsible)
  {
    label: 'ตั้งค่า',
    icon: Settings,
    children: [
      { to: '/settings/shops', label: 'ตั้งค่าร้านค้า', sectionLabel: 'ตั้งค่าทั่วไป' },
      { to: '/settings/device', label: 'ตั้งค่าตัวเครื่อง' },
      { to: '/settings/job', label: 'ตั้งค่าอาชีพ' },
      { to: '/settings/promo', label: 'ตั้งค่าโปรโมชั่น' },

      { to: '/settings/rates', label: 'ตั้งค่าเรตผ่อน', adminOnly: true, sectionLabel: 'กระทบเงิน/สิทธิ์' },
      { to: '/settings/settlement', label: 'ส่วนลดปิดสัญญา', adminOnly: true },
      { to: '/settings/users', label: 'ตั้งค่าสิทธิ์ผู้ใช้', adminOnly: true },
      { to: '/import', label: 'Import / Export', adminOnly: true },
    ],
  },
]

