// โครงเมนูด้านซ้าย — แก้ที่เดียว มีผลทั้งเว็บ
import {
  AlertTriangle,
  BarChart3,
  Gauge,
  Inbox,
  LayoutDashboard,
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

  // เมนูหลัก — item เดี่ยวบนสุด
  { to: '/', label: 'ภาพรวม', icon: LayoutDashboard },
  { to: '/exec', label: 'Dashboard ผู้บริหาร', icon: Gauge, adminOnly: true, executiveVisible: true },

  // กลุ่มพับได้: รับเรื่อง/บันทึก
  {
    label: 'รับเรื่อง/บันทึก',
    icon: Inbox,
    children: [
      { to: '/inbox', label: 'กล่องรับงาน' },
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
      { to: '/customer-overview', label: 'ภาพรวมลูกค้า' },
      { to: '/letters', label: 'ส่งจดหมาย' },
    ],
  },

  // กลุ่มพับได้: ลูกค้าล่าช้า-หนี้เสีย
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

