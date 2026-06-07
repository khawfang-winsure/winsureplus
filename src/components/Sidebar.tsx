import { NavLink, useLocation } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { NAV } from './nav'

// เมนูปุ่มสีขาวมุมมน ตามภาพตัวอย่าง — active = พื้นพีชเข้ม
const itemBase =
  'flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors'

export default function Sidebar() {
  const { pathname } = useLocation()

  return (
    <aside className="flex w-72 flex-col gap-2 rounded-3xl bg-salmon/70 p-4 shadow-sm">
      {NAV.map((item) => {
        if (item.children) {
          const groupActive = item.children.some((c) => pathname === c.to)
          return (
            <div key={item.label} className="flex flex-col gap-1">
              <div
                className={`${itemBase} cursor-default bg-white/90 text-ink ${
                  groupActive ? 'ring-2 ring-salmon-deep' : ''
                }`}
              >
                <item.icon size={18} className="shrink-0 text-salmon-deep" />
                <span>{item.label}</span>
              </div>
              <div className="ml-5 flex flex-col gap-1 border-l-2 border-white/70 pl-3">
                {item.children.map((child) => (
                  <NavLink
                    key={child.to}
                    to={child.to}
                    className={({ isActive }) =>
                      `flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors ${
                        isActive
                          ? 'bg-salmon-deep text-white shadow'
                          : 'bg-white/80 text-ink hover:bg-white'
                      }`
                    }
                  >
                    <ChevronRight size={14} className="shrink-0" />
                    {child.label}
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
            className={({ isActive }) =>
              `${itemBase} ${
                isActive
                  ? 'bg-salmon-deep text-white shadow'
                  : 'bg-white/90 text-ink hover:bg-white'
              }`
            }
          >
            <item.icon
              size={18}
              className={`shrink-0 ${pathname === item.to ? 'text-white' : 'text-salmon-deep'}`}
            />
            <span>{item.label}</span>
          </NavLink>
        )
      })}
    </aside>
  )
}
