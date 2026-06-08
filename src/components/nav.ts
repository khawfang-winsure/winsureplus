// โครงเมนูด้านซ้าย — แก้ที่เดียว มีผลทั้งเว็บ
import {
  AlertTriangle,
  BarChart3,
  CalendarClock,
  FilePlus2,
  LayoutDashboard,
  Mail,
  PackageOpen,
  Receipt,
  Send,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react'

export interface NavChild {
  to: string
  label: string
}

export interface NavItem {
  to?: string
  label: string
  icon: LucideIcon
  children?: NavChild[]
}

export const NAV: NavItem[] = [
  { to: '/', label: 'ภาพรวม', icon: LayoutDashboard },
  { to: '/add', label: 'เพิ่มข้อมูลสัญญา', icon: FilePlus2 },
  { to: '/waiting-email', label: 'รอส่งอีเมล', icon: Mail },
  { to: '/waiting-summary', label: 'รอสรุปยอด', icon: Receipt },
  { to: '/customers', label: 'ลูกค้าทั้งหมด', icon: Users },
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
  { to: '/shop-report', label: 'รายงานร้านค้า', icon: BarChart3 },
  { to: '/settings', label: 'ตั้งค่า', icon: Settings },
]
