import { NavLink, useLocation } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { NAV } from './nav'

// เมนูซ้าย: เดสก์ท็อปเป็นแถบไอคอนแคบ (w-16) เอาเมาส์ชี้แล้วกางเป็น w-72 (overlay ไม่ดันเนื้อหา)
// มือถือ: กางเต็มความกว้างตามปกติ
const itemBase =
  'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors'

// ป้ายชื่อเมนู — ซ่อนตอนแถบหุบ (เดสก์ท็อป) โผล่ตอน hover
const labelCls =
  'whitespace-nowrap md:opacity-0 md:transition-opacity md:duration-200 md:group-hover:opacity-100'

export default function Sidebar() {
  const { pathname } = useLocation()

  return (
    // ตัวกันที่ (spacer): จองความกว้างแถบไอคอนบนเดสก์ท็อป เพื่อให้ aside ลอย overlay ได้
    <div className="w-full md:relative md:w-16 md:shrink-0">
      <aside
        className="group flex w-full flex-col gap-1 rounded-2xl border border-peach bg-cream-deep p-3 shadow-sm transition-[width] duration-200 ease-out md:absolute md:inset-y-0 md:left-0 md:z-30 md:w-16 md:overflow-x-hidden md:overflow-y-auto md:p-2.5 md:hover:w-72 md:hover:p-3 md:hover:shadow-xl"
      >
        {NAV.map((item) => {
          if (item.children) {
            const groupActive = item.children.some((c) => pathname === c.to)
            return (
              <div key={item.label} className="flex flex-col gap-1">
                <div
                  className={`${itemBase} cursor-default ${
                    groupActive ? 'text-salmon-deep' : 'text-ink'
                  }`}
                >
                  <item.icon size={20} className="shrink-0 text-salmon-deep" />
                  <span className={labelCls}>{item.label}</span>
                </div>
                {/* เมนูย่อย: ซ่อนตอนแถบหุบ โผล่ตอน hover */}
                <div className="ml-5 flex flex-col gap-1 border-l border-peach pl-3 md:hidden md:group-hover:flex">
                  {item.children.map((child) => (
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
      </aside>
    </div>
  )
}
