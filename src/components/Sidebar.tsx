import { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { NAV } from './nav'
import { useAuth } from '../lib/auth'

// เมนูซ้าย: เดสก์ท็อปเป็นแถบไอคอนแคบ (w-16) เอาเมาส์ชี้แล้วกางเป็น w-72 (overlay ไม่ดันเนื้อหา)
// มือถือ: hamburger ใน topbar → drawer slide จากซ้าย + overlay
const itemBase =
  'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors'

// ป้ายชื่อเมนู — ซ่อนตอนแถบหุบ (เดสก์ท็อป) โผล่ตอน hover
const labelCls =
  'whitespace-nowrap md:opacity-0 md:transition-opacity md:duration-200 md:group-hover:opacity-100'

interface SidebarProps {
  mobileOpen: boolean
  onMobileClose: () => void
}

export default function Sidebar({ mobileOpen, onMobileClose }: SidebarProps) {
  const { pathname } = useLocation()
  const { role, configured } = useAuth()
  const isAdmin = !configured || role === 'admin' // โหมด mock เปิดเต็ม
  const isFreelancer = configured && role === 'freelancer'
  const isExecutive = configured && role === 'executive'

  // state สำหรับ expand/collapse ของแต่ละ group (key = label)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  function toggleGroup(label: string) {
    setExpanded((prev) => ({ ...prev, [label]: !prev[label] }))
  }

  // executive เห็นเฉพาะ executiveVisible; freelancer เห็นเฉพาะ freelancerOnly; admin/staff ตามปกติ
  const items = NAV.filter((item) => {
    if (isExecutive) return item.executiveVisible === true
    if (isFreelancer) return item.freelancerOnly === true
    if (item.freelancerOnly) return false
    return !item.adminOnly || isAdmin
  })

  // เนื้อ nav — render เหมือนกันทั้ง desktop และ mobile drawer
  // เรียกแบบ function call (ไม่ใช่ JSX element) เพื่อหลีกเลี่ยงการ remount ทุกครั้ง pathname เปลี่ยน
  function navContent() {
    return (
      <>
        {items.map((item) => {
          if (item.children) {
            // กรอง child เมนูที่เป็น admin only ตอน role=staff
            const visibleChildren = item.children.filter((c) => !c.adminOnly || isAdmin)
            if (visibleChildren.length === 0) return null
            const groupActive = visibleChildren.some((c) => pathname === c.to)
            // auto-expand ถ้า current route อยู่ใน sub; ไม่งั้นใช้ manual toggle
            const isOpen = groupActive || !!expanded[item.label]
            return (
              <div key={item.label} className="flex flex-col gap-1">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => toggleGroup(item.label)}
                  className={`${itemBase} w-full cursor-pointer ${
                    groupActive ? 'text-salmon-deep' : 'text-ink'
                  } hover:bg-peach-light hover:text-ink`}
                >
                  <item.icon size={20} className="shrink-0 text-salmon-deep" />
                  <span className={labelCls}>{item.label}</span>
                  {/* chevron: ซ่อนตอนแถบหุบ โผล่ตอน hover */}
                  <span className="ml-auto md:opacity-0 md:transition-opacity md:duration-200 md:group-hover:opacity-100">
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </span>
                </button>
                {/* เมนูย่อย: โชว์เมื่อ isOpen, แต่ยังคง md:hidden md:group-hover:flex เพื่อให้แถบหุบกันไม่โชว์บน rail */}
                {isOpen && (
                  <div className="ml-5 flex flex-col gap-1 border-l border-peach pl-3 md:hidden md:group-hover:flex">
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
              className={({ isActive }) =>
                `${itemBase} ${
                  isActive
                    ? 'bg-salmon-deep text-white shadow-sm'
                    : 'text-ink-soft hover:bg-peach-light hover:text-ink'
                }`
              }
            >
              <item.icon
                size={20}
                className={`shrink-0 ${pathname === item.to ? 'text-white' : 'text-salmon-deep'}`}
              />
              <span className={labelCls}>{item.label}</span>
            </NavLink>
          )
        })}
      </>
    )
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
        {navContent()}
      </aside>

      {/* ===== Desktop sidebar (≥ md) ===== */}
      {/* ตัวกันที่ (spacer): จองความกว้างแถบไอคอน เพื่อให้ aside ลอย overlay ได้ */}
      <div className="relative hidden md:block md:w-16 md:shrink-0">
        <aside
          className="group flex w-full flex-col gap-1 rounded-2xl border border-peach bg-cream-deep p-2.5 shadow-sm transition-[width] duration-200 ease-out md:absolute md:inset-y-0 md:left-0 md:z-30 md:w-16 md:overflow-x-hidden md:overflow-y-auto md:hover:w-72 md:hover:p-3 md:hover:shadow-xl"
        >
          {navContent()}
        </aside>
      </div>
    </>
  )
}
