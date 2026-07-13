import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { NAV, type NavChild, type NavItem } from './nav'
import { useAuth } from '../lib/auth'

// สิทธิ์การมองเห็นของแต่ละ role (คำนวณครั้งเดียวใน Sidebar แล้วส่งลงไป)
interface Roles {
  isAdmin: boolean
  isFreelancer: boolean
  isExecutive: boolean
  isAccounting: boolean
}

// เกณฑ์เดียว ใช้ได้ทั้ง item เดี่ยวและ child — ตรรกะเดียวกับตัวกรอง top-level เดิมเป๊ะ
// (ย้ายลงมาระดับ child เพราะโครงใหม่ยุบทุกอย่างเป็น child ใน 3 กลุ่มใหญ่ที่ไม่มี gate ระดับกลุ่ม)
type Gated = Pick<NavItem | NavChild, 'adminOnly' | 'freelancerOnly' | 'executiveVisible' | 'accountingOnly'>
function entryVisible(e: Gated, r: Roles): boolean {
  if (r.isExecutive) return e.executiveVisible === true
  if (r.isFreelancer) return e.freelancerOnly === true
  if (r.isAccounting) return e.accountingOnly === true
  if (e.freelancerOnly) return false
  if (e.accountingOnly) return r.isAdmin
  return !e.adminOnly || r.isAdmin
}

// เมนูซ้าย:
//   desktop/tablet (≥md) → rail w-16 (icon-only) เมื่อ hover กางเป็น w-60 + ดันเนื้อหา ไม่ overlay
//   phone (<md)          → hamburger drawer (overlay เลื่อนจากซ้าย) ไม่กระทบ

interface SidebarProps {
  mobileOpen: boolean
  onMobileClose: () => void
}

interface NavContentProps {
  expanded: Record<string, boolean>
  onToggleGroup: (label: string) => void
  items: typeof NAV
  roles: Roles
  pathname: string
  /** true = ใน mobile drawer (labels โชว์ครบ ไม่มี md: class ซ่อน) */
  isMobile: boolean
  /** true = อุปกรณ์ touch (hover: none) — desktop sidebar กางถาวร + เปิด submenu ด้วยการแตะ ไม่พึ่ง hover */
  isTouch: boolean
}

// label/chevron: โชว์เต็มใน mobile; desktop ซ่อนตอน rail → โผล่ตอน group-hover
const labelCls =
  'whitespace-nowrap md:opacity-0 md:transition-opacity md:duration-200 md:group-hover:opacity-100'

function NavContent({
  expanded,
  onToggleGroup,
  items,
  roles,
  pathname,
  isMobile,
  isTouch,
}: NavContentProps) {
  const itemBase =
    'flex items-center rounded-xl px-3 py-3 text-sm font-medium transition-colors'

  return (
    <>
      {items.map((item) => {
        if (item.children) {
          // ผูก sectionLabel ปัจจุบัน (running) ให้ทุก child ก่อนกรอง — เพื่อยกหัวข้อย่อยไปไว้เหนือ
          // child แรกที่ role นั้น "ยังเห็น" (กันหัวข้อลอยโล่งเมื่อ child ตัวแรกของ subsection ถูกซ่อน)
          let running: string | undefined
          const tagged = item.children.map((c) => {
            if (c.sectionLabel) running = c.sectionLabel
            return { child: c, section: running }
          })
          const visibleChildren = tagged.filter(({ child }) => entryVisible(child, roles))
          if (visibleChildren.length === 0) return null
          const groupActive = visibleChildren.some(({ child }) => pathname === child.to)
          // mobile: accordion — open ถ้า active หรือ expanded; desktop: click-toggle เท่านั้น
          const open = !!expanded[item.label] || (isMobile && groupActive)

          const childLinks = visibleChildren.map(({ child, section }, idx) => {
            const prevSection = idx > 0 ? visibleChildren[idx - 1].section : undefined
            const showHeader = !!section && section !== prevSection
            return (
            <div key={child.to} className="flex flex-col">
              {showHeader && (
                <div
                  className={`whitespace-nowrap px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-soft/70 ${
                    idx === 0 ? 'pt-0' : 'mt-1 border-t border-peach pt-2'
                  }`}
                >
                  {section}
                </div>
              )}
              <NavLink
                to={child.to}
                className={({ isActive }) =>
                  `flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors ${
                    isActive
                      ? 'bg-salmon-deep text-white shadow-sm'
                      : 'text-ink-soft hover:bg-peach-light hover:text-ink'
                  }`
                }
              >
                <ChevronRight size={14} className="shrink-0" />
                <span className="whitespace-nowrap">{child.label}</span>
              </NavLink>
            </div>
            )
          })

          return (
            <div key={item.label} className="flex flex-col gap-1">
              <button
                type="button"
                aria-expanded={open}
                title={item.label}
                onClick={() => onToggleGroup(item.label)}
                className={`${itemBase} w-full gap-3 cursor-pointer ${
                  groupActive ? 'text-salmon-deep' : 'text-ink'
                } hover:bg-peach-light hover:text-ink`}
              >
                <item.icon size={20} className="shrink-0 text-salmon-deep" />
                <span className={isMobile || isTouch ? 'whitespace-nowrap' : labelCls}>{item.label}</span>
                {/* chevron: desktop ซ่อนตอน rail โผล่ตอน hover กาง (touch = โชว์เสมอ) */}
                <span
                  className={
                    isMobile || isTouch
                      ? 'ml-auto'
                      : 'ml-auto md:opacity-0 md:transition-opacity md:duration-200 md:group-hover:opacity-100'
                  }
                >
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
              </button>

              {/* submenu mobile = flex/hidden ธรรมดา */}
              {isMobile && (
                <div
                  className={[
                    'ml-5 flex-col gap-1 border-l border-peach pl-3',
                    open ? 'flex' : 'hidden',
                  ].join(' ')}
                >
                  {childLinks}
                </div>
              )}

              {/* submenu desktop = grid-rows slide-down
                  Logic: ลูกเมนูเปิดได้ก็ต่อเมื่อ rail กาง (group-hover) AND กดเปิด (expanded)
                  - [grid-template-rows:0fr]                     = base: ปิดเสมอ
                  - md:group-hover:[grid-template-rows:0fr]       = rail กาง แต่ไม่ expanded → ปิด
                  - open → md:group-hover:[grid-template-rows:1fr] = rail กาง + expanded → เปิด */}
              {!isMobile && (
                <div
                  className={[
                    'ml-5 border-l border-peach pl-3',
                    'grid [grid-template-rows:0fr] transition-[grid-template-rows] duration-200 ease-out',
                    isTouch
                      ? open
                        ? '[grid-template-rows:1fr]'
                        : '[grid-template-rows:0fr]'
                      : open
                        ? 'md:group-hover:[grid-template-rows:1fr]'
                        : 'md:group-hover:[grid-template-rows:0fr]',
                  ].join(' ')}
                >
                  <div className="overflow-hidden min-h-0">
                    <div className="flex flex-col gap-1 pt-1">
                      {childLinks}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        }

        return (
          <NavLink
            key={item.to}
            to={item.to!}
            end={item.to === '/'}
            title={item.label}
            className={({ isActive }) =>
              `${itemBase} gap-3 ${
                isActive
                  ? 'bg-salmon-deep text-white shadow-sm'
                  : 'text-ink-soft hover:bg-peach-light hover:text-ink'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <item.icon
                  size={20}
                  className={`shrink-0 ${isActive ? 'text-white' : 'text-salmon-deep'}`}
                />
                <span className={isMobile || isTouch ? 'whitespace-nowrap' : labelCls}>{item.label}</span>
              </>
            )}
          </NavLink>
        )
      })}
    </>
  )
}

export default function Sidebar({ mobileOpen, onMobileClose }: SidebarProps) {
  const { pathname } = useLocation()
  const { role, configured } = useAuth()
  const isAdmin = !configured || role === 'admin'
  const isFreelancer = configured && role === 'freelancer'
  const isExecutive = configured && role === 'executive'
  const isAccounting = configured && role === 'accounting'

  // state สำหรับ expand/collapse ของแต่ละ group บนมือถือ (key = label)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  // ตรวจอุปกรณ์ touch (hover: none) — iPad/มือถือ คืน true, เมาส์ desktop คืน false
  // touch ใช้ desktop sidebar (≥md) แต่ไม่มี hover → ต้องกางถาวร + เปิด submenu ด้วยการแตะ
  const [isTouch, setIsTouch] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia('(hover: none)')
    setIsTouch(mql.matches)
    const onChange = (e: MediaQueryListEvent) => setIsTouch(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  function toggleGroup(label: string) {
    setExpanded((prev) => ({ ...prev, [label]: !prev[label] }))
  }

  const roles: Roles = { isAdmin, isFreelancer, isExecutive, isAccounting }

  // กลุ่มใหญ่ (มี children) โชว์ก็ต่อเมื่อมี child ที่ role นั้นเห็น ≥1 อัน — ไม่มี gate ระดับกลุ่ม
  // item เดี่ยว (ถ้ามี) ใช้เกณฑ์ entryVisible เดียวกับ child. โครงปัจจุบันเป็นกลุ่มล้วน 3 กลุ่ม
  const items = NAV.filter((item) =>
    item.children ? item.children.some((c) => entryVisible(c, roles)) : entryVisible(item, roles),
  )

  const sharedNavProps = {
    expanded,
    onToggleGroup: toggleGroup,
    items,
    roles,
    pathname,
  }

  return (
    <>
      {/* ===== Mobile drawer (< md) ===== */}
      {/* overlay */}
      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity duration-200 md:hidden ${
          mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={onMobileClose}
        aria-hidden="true"
      />
      {/* drawer panel */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-72 flex-col gap-1 overflow-y-auto rounded-r-2xl border-r border-peach bg-cream-deep p-3 shadow-xl transition-transform duration-200 ease-out md:hidden ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <NavContent {...sharedNavProps} isMobile={true} isTouch={false} />
      </aside>

      {/* ===== Desktop sidebar (≥ md) ===== */}
      {/*
        aside เป็น flex child ปกติ (ไม่ absolute) → ดันเนื้อหาขวา ไม่ลอยทับ
        - hover ที่ตัวเอง  → md:hover:w-60 ขยายความกว้าง (self-hover)
        - group บน aside  → ลูกๆ ใช้ md:group-hover: เพื่อแสดง label/submenu
        - overflow-x-hidden กัน label ล้นออกมาขณะ transition
      */}
      <aside
        className={
          isTouch
            ? 'group hidden md:sticky md:top-6 md:flex md:shrink-0 md:self-start md:h-[calc(100vh-3rem)] md:w-60 md:flex-col md:gap-1 md:overflow-x-hidden md:overflow-y-auto md:rounded-2xl md:border md:border-peach md:bg-cream-deep md:p-3 md:shadow-sm md:transition-[width] md:duration-200 md:ease-out'
            : 'group hidden md:sticky md:top-6 md:flex md:shrink-0 md:self-start md:h-[calc(100vh-3rem)] md:w-16 md:hover:w-60 md:flex-col md:gap-1 md:overflow-x-hidden md:overflow-y-auto md:rounded-2xl md:border md:border-peach md:bg-cream-deep md:p-3 md:shadow-sm md:transition-[width] md:duration-200 md:ease-out'
        }
      >
        <NavContent {...sharedNavProps} isMobile={false} isTouch={isTouch} />
      </aside>
    </>
  )
}
