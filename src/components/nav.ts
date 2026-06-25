// โครงเมนูด้านซ้าย — แก้ที่เดียว มีผลทั้งเว็บ
import {
  AlertTriangle,
  BarChart3,
  CalendarClock,
  CalendarRange,
  FileBox,
  FilePlus2,
  Gauge,
  Inbox,
  LayoutDashboard,
  Mail,
  PackageOpen,
  Phone,
  PieChart,
  Receipt,
  Send,
  Settings,
  TrendingUp,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'

export interface NavChild {
  to: string
  label: string
  adminOnly?: boolean
}

export interface NavItem {
  to?: string
  label: string
  icon: LucideIcon
  children?: NavChild[]
  adminOnly?: boolean // ซ่อนจากพนักงาน (staff) — เห็นเฉพาะแอดมิน
  freelancerOnly?: boolean // เห็นเฉพาะผู้ติดตามหนี้ — ซ่อนจาก admin/staff
  executiveVisible?: boolean // executive เห็นด้วยทั้งที่ adminOnly=true
}

export const NAV: NavItem[] = [
  // กลุ่ม freelancer — แยกออกมา ไม่อยู่ในกลุ่มหลัก
  { to: '/queue', label: 'คิวติดตาม', icon: Phone, freelancerOnly: true },
  { to: '/my-performance', label: 'ผลงานของฉัน', icon: TrendingUp, freelancerOnly: true },

  // เมนูหลัก (ไม่มีหัวข้อกลุ่ม)
  { to: '/', label: 'ภาพรวม', icon: LayoutDashboard },
  { to: '/exec', label: 'Dashboard ผู้บริหาร', icon: Gauge, adminOnly: true, executiveVisible: true },
  { to: '/inbox', label: 'กล่องรับงาน', icon: Inbox },
  { to: '/add', label: 'เพิ่มข้อมูลสัญญา', icon: FilePlus2 },
  { to: '/waiting-email', label: 'รอส่งอีเมล', icon: Mail },
  { to: '/waiting-summary', label: 'รอสรุปยอด', icon: Receipt },
  { to: '/other-income', label: 'รายได้อื่นๆ', icon: Wallet },
  { to: '/doc-tracking', label: 'รับเอกสาร/กล่อง', icon: FileBox },
  { to: '/due', label: 'ลูกค้าถึงวันครบกำหนด', icon: CalendarClock },
  {
    label: 'ลูกค้าล่าช้า-หนี้เสีย',
    icon: AlertTriangle,
    children: [
      { to: '/overdue/1-10', label: 'ล่าช้า 1-10 วัน' },
      { to: '/overdue/11-30', label: 'ล่าช้า 11-30 วัน' },
      { to: '/overdue/31-60', label: 'ล่าช้า 31-60 วัน' },
      { to: '/overdue/61-90', label: 'ล่าช้า 61-90 วัน' },
      { to: '/overdue/91-120', label: 'ล่าช้า 91-120 วัน' },
      { to: '/overdue/120+', label: 'ล่าช้า 120 วันขึ้นไป' },
    ],
  },
  { to: '/customers', label: 'ลูกค้าทั้งหมด', icon: Users },
  { to: '/extended', label: 'ลูกค้าขยายระยะเวลา', icon: CalendarRange },
  { to: '/customer-overview', label: 'ภาพรวมลูกค้า', icon: PieChart },
  { to: '/letters', label: 'ส่งจดหมาย', icon: Send },
  { to: '/device-pipeline', label: 'ติดตามเครื่อง', icon: Truck },
  { to: '/returns', label: 'ลูกค้าคืนเครื่อง', icon: PackageOpen },

  // รายงาน (collapsible)
  {
    label: 'รายงาน',
    icon: BarChart3,
    adminOnly: true, // ซ่อนทั้งกลุ่มจากพนักงาน (staff) — เห็นเฉพาะแอดมิน
    children: [
      { to: '/sale-history', label: 'ประวัติการขายเครื่อง', adminOnly: true },
      { to: '/shop-report', label: 'รายงานร้านค้า' },
      { to: '/staff-performance', label: 'สรุปภาพรวมการติดตามหนี้' },
      { to: '/staff-daily-report', label: 'รายงานการทำงานพนักงานรายวัน' },
      { to: '/weekly-report', label: 'รายงานประจำสัปดาห์' },
      { to: '/commission', label: 'ค่าคอมมิชชั่น', adminOnly: true },
      { to: '/debtflow', label: 'ติดตามหนี้ (DEBTFLOW)', adminOnly: true },
    ],
  },

  // ตั้งค่า (collapsible)
  {
    label: 'ตั้งค่า',
    icon: Settings,
    children: [
      { to: '/settings/shops', label: 'ตั้งค่าร้านค้า' },
      { to: '/settings/device', label: 'ตั้งค่าตัวเครื่อง' },
      { to: '/settings/job', label: 'ตั้งค่าอาชีพ' },
      { to: '/settings/promo', label: 'ตั้งค่าโปรโมชั่น' },
      { to: '/settings/rates', label: 'ตั้งค่าเรตผ่อน' },
      { to: '/settings/users', label: 'ตั้งค่าสิทธิ์ผู้ใช้', adminOnly: true },
      { to: '/import', label: 'Import / Export', adminOnly: true },
    ],
  },
]

