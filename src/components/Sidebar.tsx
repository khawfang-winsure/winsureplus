import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { NAV } from './nav'
import { useAuth } from '../lib/auth'

// เมนูซ้าย:
//   desktop/tablet (≥md) → 2 สถานะ: rail (w-16 icon-only) / full (w-60) สลับด้วยปุ่มคลิก, ดันเนื้อหา ไม่ overlay
//   phone (<md)          → hamburger drawer (overlay เลื่อนจากซ้าย) ไม่กระทบ

const LS_KEY = 'sidebar_collapsed'

interface SidebarProps {
  mobileOpen: boolean
  onMobileClose: () => void
}

interface NavContentProps {
  rail: boolean
  expanded: Record<string, boolean>
  onToggleGroup: (label: string) => void
  onExpandSidebar: () => void
  items: typeof NAV
  isAdmin: boolean
  pathname: string
}

function NavContent({
  rail,
  expanded,
  onToggleGroup,
  onExpandSidebar,
  items,
  isAdmin,
  pathname,
}: NavContentProps) {
  const itemBase =
    'flex items-center rounded-xl px-3 py-3 text-sm font-medium transition-colors'

  return (
    <>
      {items.map((item) => {
        if (item.children) {
          const visibleChildren = item.children.filter((c) => !c.adminOnly || isAdmin)
          if (visibleChildren.length === 0) return null
          const groupActive = visibleChildren.some((c) => pathname === c.to)
          const isOpen = !rail && (groupActive || !!expanded[item.label])

          return (
            <div key={item.label} className="flex flex-col gap-1">
              <button
                type="button"
                aria-expanded={isOpen}
                title={rail ? item.label : undefined}
                onClick={() => {
                  if (rail) {
                    // rail mode: กดที่ group icon → ขยาย sidebar ก่อน
                    onExpandSidebar()
                  } else {
                    onToggleGroup(item.label)
                  }
                }}
                className={`${itemBase} w-full cursor-pointer ${rail ? 'justify-center gap-0' : 'gap-3'} ${
                  groupActive ? 'text-salmon-deep' : 'text-ink'
                } hover:bg-peach-light hover:text-ink`}
              >
                <item.icon size={20} className="shrink-0 text-salmon-deep" />
                {!rail && (
                  <>
                    <span className="whitespace-nowrap">{item.label}</span>
                    <span className="ml-auto">
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </span>
                  </>
                )}
              </button>
              {isOpen && (
                <div className="ml-5 flex flex-col gap-1 border-l border-peach pl-3">
                  {visibleChildren.map((child) => (
                    <NavLink
                      key={child.to}
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
                  ))}
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
            title={rail ? item.label : undefined}
            className={({ isActive }) =>
              `${itemBase} ${rail ? 'justify-center gap-0' : 'gap-3'} ${
                isActive
                  ? 'bg-salmon-deep text-white shadow-sm'
                  : 'text-ink-soft hover:bg-peach-light hover:text-ink'
              }`
            }
          >
            {({ isActive }) => (
              <item.icon
                size={20}
                className={`shrink-0 ${isActive ? 'text-white' : 'text-salmon-deep'}`}
              />
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

  // lazy init: อ่าน localStorage ก่อน; ถ้าไม่มี → touch=false(full), mouse=true(rail)
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const saved = localStorage.getItem(LS_KEY)
    if (saved !== null) return saved === 'true'
    return !window.matchMedia('(hover:none) and (pointer:coarse)').matches
  })

  // persist ทุกครั้งที่ collapsed เปลี่ยน
  useEffect(() => {
    localStorage.setItem(LS_KEY, String(collapsed))
  }, [collapsed])

  // state สำหรับ expand/collapse ของแต่ละ group (key = label)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  function toggleGroup(label: string) {
    setExpanded((prev) => ({ ...prev, [label]: !prev[label] }))
  }

  const items = NAV.filter((item) => {
    if (isExecutive) return item.executiveVisible === true
    if (isFreelancer) return item.freelancerOnly === true
    if (item.freelancerOnly) return false
    return !item.adminOnly || isAdmin
  })

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
        <NavContent
          rail={false}
          expanded={expanded}
          onToggleGroup={toggleGroup}
          onExpandSidebar={() => setCollapsed(false)}
          items={items}
          isAdmin={isAdmin}
          pathname={pathname}
        />
      </aside>

      {/* ===== Desktop sidebar (≥ md) ===== */}
      {/* aside เดียวเป็น flex child — เปลี่ยนความกว้างตาม collapsed state ดัน <main> เอง ไม่ overlay */}
      <aside
        className={`hidden md:sticky md:top-6 md:flex md:shrink-0 md:self-start md:h-[calc(100vh-3rem)] md:flex-col md:gap-1 md:overflow-x-hidden md:overflow-y-auto md:rounded-2xl md:border md:border-peach md:bg-cream-deep md:p-3 md:shadow-sm md:transition-[width] md:duration-200 ${
          collapsed ? 'md:w-16' : 'md:w-60'
        }`}
      >
        {/* ปุ่ม toggle ย่อ/ขยาย — desktop เท่านั้น */}
        <button
          type="button"
          aria-label={collapsed ? 'ขยายเมนู' : 'ย่อเมนู'}
          title={collapsed ? 'ขยายเมนู' : 'ย่อเมนู'}
          onClick={() => setCollapsed((c) => !c)}
          className={`flex items-center rounded-xl px-3 py-2 text-ink-soft transition-colors hover:bg-peach-light hover:text-ink mb-1 ${
            collapsed ? 'justify-center' : 'justify-end'
          }`}
        >
          {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>

        <NavContent
          rail={collapsed}
          expanded={expanded}
          onToggleGroup={toggleGroup}
          onExpandSidebar={() => setCollapsed(false)}
          items={items}
          isAdmin={isAdmin}
          pathname={pathname}
        />
      </aside>
    </>
  )
}
