// โครงเมนูด้านซ้าย — แก้ที่เดียว มีผลทั้งเว็บ
// โครง "ทำ / ดู / ตั้ง" (Pete เคาะแบบ A 2026-07-13)
// 3 กลุ่มใหญ่ พับได้ — ไม่มี gate ระดับกลุ่ม. สิทธิ์การมองเห็นย้ายลงไปที่ child ทุกอัน
// (adminOnly / freelancerOnly / executiveVisible / accountingOnly). กลุ่มโชว์ก็ต่อเมื่อมี child
// ที่ role นั้นเห็นอย่างน้อย 1 อัน (Sidebar คำนวณให้). ห้ามแตะ route/path ใน App.tsx — path เดิมทุกอัน
import { BarChart3, Landmark, LayoutDashboard, ListChecks, Phone, Settings, TrendingUp, type LucideIcon } from 'lucide-react'

export interface NavChild {
  to: string
  label: string
  adminOnly?: boolean // ซ่อนจากพนักงาน (staff) — เห็นเฉพาะแอดมิน (+exec ถ้าตั้ง executiveVisible ด้วย)
  freelancerOnly?: boolean // เห็นเฉพาะผู้ติดตามหนี้ (freelancer) — ซ่อนจาก admin/staff
  executiveVisible?: boolean // executive เห็นด้วยทั้งที่ adminOnly=true
  accountingOnly?: boolean // เห็นเฉพาะบัญชี (+admin) — ซ่อนจาก staff/freelancer/executive
  /** หัวข้อย่อย (เส้นคั่น) ที่จะโชว์เหนือลิงก์นี้ — ใช้แบ่ง subsection ภายใน submenu เดียวกัน
   *  Sidebar จะยกหัวข้อนี้ไปไว้เหนือ child แรกที่ role นั้นยังเห็น (กันหัวข้อลอยโล่ง) */
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
  // ── ลิงก์เดี่ยว top-level (นอกกลุ่ม) ─────────────────────────
  // ภาพรวม = หน้าแรก (admin+staff เห็น เหมือนเดิม ไม่มี role flag)
  { to: '/', label: 'ภาพรวม', icon: LayoutDashboard },
  // 3 เมนูเฉพาะ role — Pete ขอให้เป็นลิงก์เดี่ยว ไม่ต้องกดกางกลุ่ม (role flag เดิมเป๊ะ)
  { to: '/queue', label: 'คิวติดตาม', icon: Phone, freelancerOnly: true },
  { to: '/my-performance', label: 'ผลงานของฉัน', icon: TrendingUp, freelancerOnly: true },
  { to: '/transfers', label: 'โอนเงินร้าน', icon: Landmark, accountingOnly: true },

  // ── กลุ่ม 1: ทำ · งานประจำวัน ─────────────────────────────
  {
    label: 'ทำ · งานประจำวัน',
    icon: ListChecks,
    children: [
      { to: '/add', label: 'เพิ่มข้อมูลสัญญา', sectionLabel: 'รับงานเข้า' },
      { to: '/inbox', label: 'กล่องรับงาน' },
      { to: '/pj-sync-review', label: 'กล่องรอตรวจ PJ' },

      { to: '/due', label: 'ลูกค้าถึงวันครบกำหนด', sectionLabel: 'ติดตามหนี้' },
      { to: '/overdue/last', label: 'ลูกค้าล่าช้า-หนี้เสีย' },
      { to: '/letters', label: 'ส่งจดหมาย' },

      { to: '/waiting-summary', label: 'รอสรุปยอด', sectionLabel: 'เงินโอนร้าน' },
      { to: '/waiting-email', label: 'รอส่งอีเมล' },
      { to: '/other-income', label: 'รายได้อื่นๆ' },

      { to: '/doc-tracking', label: 'รับเอกสาร/กล่อง', sectionLabel: 'เครื่อง & เอกสาร' },
      { to: '/device-pipeline', label: 'ติดตามเครื่อง' },
      { to: '/returns', label: 'ลูกค้าคืนเครื่อง' },
    ],
  },

  // ── กลุ่ม 2: ดู · รายงาน & วิเคราะห์ ──────────────────────
  {
    label: 'ดู · รายงาน & วิเคราะห์',
    icon: BarChart3,
    children: [
      { to: '/exec', label: 'Dashboard ผู้บริหาร', adminOnly: true, executiveVisible: true, sectionLabel: 'ผู้บริหาร' },
      { to: '/monthly-report', label: 'รายงานประจำเดือน', adminOnly: true, executiveVisible: true },

      { to: '/commission', label: 'ค่าคอมมิชชั่น', adminOnly: true, sectionLabel: 'การเงิน' },
      { to: '/settlements', label: 'ปิดสัญญาก่อนกำหนด', adminOnly: true },
      { to: '/transfer-summary', label: 'สรุปการโอนเงินร้าน', adminOnly: true, executiveVisible: true },
      { to: '/weekly-summary', label: 'สรุปรายสัปดาห์', adminOnly: true },

      { to: '/shop-report', label: 'รายงานร้านค้า', adminOnly: true, sectionLabel: 'ร้านค้า-เครื่อง' },
      { to: '/shop-promo-analysis', label: 'วิเคราะห์ร้านเพื่อจัดโปร', adminOnly: true, executiveVisible: true },
      { to: '/sale-history', label: 'ประวัติการขายเครื่อง', adminOnly: true },
      { to: '/returns-report', label: 'รายงานการคืนเครื่อง', adminOnly: true },

      { to: '/staff-performance', label: 'สรุปภาพรวมการติดตามหนี้', adminOnly: true, executiveVisible: true, sectionLabel: 'ทีมโทร' },
      { to: '/hr-report', label: 'รายงาน HR ทีมโทร', adminOnly: true, executiveVisible: true },
      { to: '/staff-daily-report', label: 'รายงานการทำงานพนักงานรายวัน', adminOnly: true, executiveVisible: true },

      { to: '/customers', label: 'ลูกค้าทั้งหมด', sectionLabel: 'ลูกค้า' },
      { to: '/customer-overview', label: 'วิเคราะห์ลูกค้า (กราฟ)' },
      { to: '/extended', label: 'ลูกค้าขยายระยะเวลา' },
    ],
  },

  // ── กลุ่ม 3: ตั้ง · ตั้งค่า ────────────────────────────────
  {
    label: 'ตั้ง · ตั้งค่า',
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
