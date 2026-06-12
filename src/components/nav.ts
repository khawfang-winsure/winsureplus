// โครงเมนูด้านซ้าย — แก้ที่เดียว มีผลทั้งเว็บ
import {
  AlertTriangle,
  BarChart3,
  CalendarClock,
  CalendarRange,
  Coins,
  Gauge,
  FilePlus2,
  LayoutDashboard,
  Mail,
  PackageOpen,
  Phone,
  PieChart,
  Receipt,
  Send,
  Settings,
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
}

export const NAV: NavItem[] = [
  { to: '/queue', label: 'คิวติดตาม', icon: Phone, freelancerOnly: true },
  { to: '/', label: 'ภาพรวม', icon: LayoutDashboard },
  { to: '/exec', label: 'Dashboard ผู้บริหาร', icon: Gauge, adminOnly: true },
  { to: '/add', label: 'เพิ่มข้อมูลสัญญา', icon: FilePlus2 },
  { to: '/waiting-email', label: 'รอส่งอีเมล', icon: Mail },
  { to: '/waiting-summary', label: 'รอสรุปยอด', icon: Receipt },
  { to: '/customers', label: 'ลูกค้าทั้งหมด', icon: Users },
  { to: '/customer-overview', label: 'ภาพรวมลูกค้า', icon: PieChart },
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
  { to: '/letters', label: 'ส่งจดหมาย', icon: Send },
  { to: '/returns', label: 'ลูกค้าคืนเครื่อง', icon: PackageOpen },
  { to: '/extended', label: 'ลูกค้าขยายระยะเวลา', icon: CalendarRange },
  { to: '/shop-report', label: 'รายงานร้านค้า', icon: BarChart3 },
  { to: '/staff-performance', label: 'Performance ฟรีแลนซ์', icon: BarChart3 },
  { to: '/commission', label: 'ค่าคอมมิชชั่น', icon: Coins, adminOnly: true },
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
    ],
  },
]
