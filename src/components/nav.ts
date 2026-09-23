// โครงเมนูด้านซ้าย — แก้ที่เดียว มีผลทั้งเว็บ
// โครง "ทำ / ดู / ตั้ง" (Pete เคาะแบบ A 2026-07-13)
// 3 กลุ่มใหญ่ พับได้ — ไม่มี gate ระดับกลุ่ม. สิทธิ์การมองเห็นย้ายลงไปที่ child ทุกอัน
// (adminOnly / freelancerOnly / executiveVisible / accountingOnly). กลุ่มโชว์ก็ต่อเมื่อมี child
// ที่ role นั้นเห็นอย่างน้อย 1 อัน (Sidebar คำนวณให้). ห้ามแตะ route/path ใน App.tsx — path เดิมทุกอัน
import { useEffect, useState } from 'react'
import { BarChart3, Landmark, LayoutDashboard, ListChecks, Phone, Settings, TrendingUp, type LucideIcon } from 'lucide-react'
import { getInboxCases, getPjSyncReview, getReviewQueue } from '../lib/db'

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
  /** ป้ายเมนูที่จะโชว์แทน `label` ตอน role='staff' (spec-review-flow.md §5 — เพจเดียวกัน 2 หน้าตา
   *  admin เห็น "ตรวจเคสก่อนส่งบริษัท" / staff เห็น "งานที่ต้องแก้") — ไม่ตั้ง = ใช้ label เดิมทุก role */
  staffLabel?: string
  /** คีย์ badge แดงบนเมนู (ตัวเลขนับสด) — Sidebar ใช้ useNavBadgeCounts() แม็พคีย์นี้เป็นจำนวนจริง
   *  เพิ่มคีย์ใหม่ได้ถ้ามี badge อื่นในอนาคต (ต่อ query ในฟังก์ชันเดียวกัน อย่าก็อปปี้ทั้ง hook):
   *  - 'reviewQueue'   เคสรอตรวจ/ต้องแก้ (spec-review-flow.md §2 "ป้ายแจ้งเตือนเมนู")
   *  - 'pjSyncReview'  แถวรอตรวจในกล่องรอตรวจ PJ (เพิ่ม 23 ก.ย. 2026)
   *  - 'inbox'         เคสทั้งหมดในกล่องรับงาน (เพิ่ม 23 ก.ย. 2026) */
  badgeKey?: 'reviewQueue' | 'pjSyncReview' | 'inbox'
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
      { to: '/inbox', label: 'กล่องรับงาน', badgeKey: 'inbox' },
      { to: '/pj-sync-review', label: 'กล่องรอตรวจ PJ', badgeKey: 'pjSyncReview' },

      { to: '/overdue/last', label: 'ลูกค้าล่าช้า-หนี้เสีย', sectionLabel: 'ติดตามหนี้' },
      { to: '/letters', label: 'ส่งจดหมาย' },

      { to: '/waiting-summary', label: 'รอสรุปยอด', sectionLabel: 'เงินโอนร้าน' },
      { to: '/review-queue', label: 'ตรวจเคสก่อนส่งบริษัท', staffLabel: 'งานที่ต้องแก้', badgeKey: 'reviewQueue' },
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

/** ตัวเลข badge สีแดงบนเมนู — รวมทุกคีย์ไว้ hook เดียว (กัน copy-paste useState+useEffect+cancelled flag
 *  ซ้ำ 3 ชุด) ยิง 3 query ขนานกันด้วย Promise.allSettled — แหล่งไหนพังก็ไม่ลากอีก 2 แหล่งให้ล้มตาม
 *  (fallback 0 เฉพาะตัวที่พัง ตัวอื่นขึ้นเลขปกติ)
 *
 *  - 'reviewQueue' "ตรวจเคสก่อนส่งบริษัท" / "งานที่ต้องแก้" (spec-review-flow.md §2/§5) หน้าเดียวกัน
 *    แยกความหมายตาม role: admin = จำนวนเคส "รอตรวจ" (pending_review) ทั้งหมด (needs_fix อยู่ในมือ
 *    พนักงานแล้ว ไม่ใช่งานค้างของแอดมินอีกต่อไป) · staff (role='staff' เท่านั้น ไม่รวม
 *    freelancer/executive/accounting) = จำนวนเคส "ต้องแก้ไข" (needs_fix) ของตัวเอง
 *    (operator === myName เหมือนหน้า /review-queue)
 *  - 'pjSyncReview' "กล่องรอตรวจ PJ" — จำนวนแถวสถานะ 'pending' ทั้งหมดจาก getPjSyncReview('pending')
 *    เท่ากับ rows.length ที่หน้า /pj-sync-review โชว์เป๊ะ (รวมแถว "ใบเสร็จหาย/ถูกแก้" อยู่แล้ว เพราะเป็น
 *    subset ของ rows ชุดเดียวกัน ไม่ได้แยกนับต่างหาก) — admin/staff เห็นเลขเดียวกัน (หน้าไม่กรองตาม role)
 *  - 'inbox' "กล่องรับงาน" — จำนวนเคสทั้งหมดในกล่องจาก getInboxCases() เท่ากับ cases.length ที่หน้า
 *    /inbox ก่อนกรองค้นหา — หน้านั้นไม่ได้กรองตาม role เลย ทุก role ที่เห็นเมนูนี้เห็นเลขเดียวกัน */
export interface NavBadgeCounts {
  reviewQueue: number
  pjSyncReview: number
  inbox: number
}

const ZERO_BADGE_COUNTS: NavBadgeCounts = { reviewQueue: 0, pjSyncReview: 0, inbox: 0 }

export function useNavBadgeCounts(isAdmin: boolean, isStaff: boolean, myName: string | null): NavBadgeCounts {
  const [counts, setCounts] = useState<NavBadgeCounts>(ZERO_BADGE_COUNTS)
  useEffect(() => {
    if (!isAdmin && !isStaff) {
      setCounts(ZERO_BADGE_COUNTS)
      return
    }
    let cancelled = false
    Promise.allSettled([getReviewQueue(), getPjSyncReview('pending'), getInboxCases()]).then(
      ([reviewResult, pjResult, inboxResult]) => {
        if (cancelled) return
        const reviewRows = reviewResult.status === 'fulfilled' ? reviewResult.value : []
        const pjRows = pjResult.status === 'fulfilled' ? pjResult.value : []
        const inboxRows = inboxResult.status === 'fulfilled' ? inboxResult.value : []
        const reviewQueue = isAdmin
          ? reviewRows.filter((r) => r.reviewStatus === 'pending_review').length
          : reviewRows.filter((r) => r.reviewStatus === 'needs_fix' && sameOperator(r.operator, myName)).length
        setCounts({ reviewQueue, pjSyncReview: pjRows.length, inbox: inboxRows.length })
      },
    )
    return () => {
      cancelled = true
    }
  }, [isAdmin, isStaff, myName])
  return counts
}

/** เทียบชื่อ operator ของเคส (field กรอกมือ ไม่ผูก user id) กับชื่อผู้ใช้ล็อกอิน — trim+lowercase
 *  กัน noise ปกติ (เว้นวรรคเกิน/ตัวพิมพ์ไม่ตรง) ไม่ให้งานของพนักงานหลุดหายจากคิวของตัวเอง
 *  ⚠️ ข้อจำกัดที่รู้: ถ้าแอดมินเปลี่ยนชื่อผู้ใช้ใน /settings/users เคสเก่าที่ยังเก็บชื่อเดิมจะไม่ match
 *  อีกต่อไป — fallback คือแอดมินเห็นทุกเคสอยู่แล้วในคิวเดียวกัน (ไม่มีงานตกหาย แค่ staff มองไม่เห็นชั่วคราว) */
export function sameOperator(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}
