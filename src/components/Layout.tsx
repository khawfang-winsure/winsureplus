import { Suspense, useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { LogOut, Menu, Search } from 'lucide-react'
import Logo from './Logo'
import Sidebar from './Sidebar'
import NotificationBell from './NotificationBell'
import QuickSearch from './QuickSearch'
import ThemeToggle from './ThemeToggle'
import { Badge, Loading } from './ui'
import { useAuth } from '../lib/auth'

// โครงหน้าหลัก: กรอบครีม + หัวโลโก้ + เมนูซ้าย + เนื้อหาขวา (การ์ดขาว)
export default function Layout() {
  const { email, role, configured, signOut } = useAuth()
  const { pathname } = useLocation()

  // mobile drawer state — อยู่ที่นี่เพราะ hamburger (header) ต้องสื่อสารกับ Sidebar
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  // ปิด drawer ทุกครั้งที่ navigate (คลิก link หรือ programmatic)
  useEffect(() => {
    setMobileNavOpen(false)
  }, [pathname])

  // ปิด drawer เมื่อกด ESC
  useEffect(() => {
    if (!mobileNavOpen) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMobileNavOpen(false)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [mobileNavOpen])

  // แสดงปุ่ม search เฉพาะ admin/staff เท่านั้น (เหมือน QuickSearch role-gate)
  const isAdminOrStaff = !configured || role === 'admin' || role === 'staff'

  function openQuickSearch() {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
  }

  return (
    <div className="min-h-screen bg-cream p-3 md:p-6">
      <div className="mx-auto max-w-[1400px]">
        {/* หัว */}
        <header className="mb-4 flex items-center gap-2 md:mb-5 md:gap-4">
          {/* hamburger — mobile เท่านั้น — แสดงเมื่อล็อกอินแล้ว */}
          {email && (
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="เปิดเมนู"
              title="เปิดเมนู"
              className="inline-flex items-center justify-center rounded-xl border border-peach bg-surface p-2 text-ink transition hover:bg-peach-light/50 md:hidden"
            >
              <Menu size={20} />
            </button>
          )}

          <Logo />
          <h1 className="text-lg font-bold tracking-wide text-ink sm:text-2xl">WIN SURE PLUS</h1>

          {email && (
            <div className="ml-auto flex items-center gap-2 md:gap-3">
              {isAdminOrStaff && (
                <button
                  type="button"
                  onClick={openQuickSearch}
                  title="ค้นหาด่วน (Ctrl+K / ⌘K)"
                  className="hidden items-center gap-2 rounded-xl border border-peach bg-surface px-3 py-2 text-sm text-ink-soft transition hover:bg-peach-light/50 sm:inline-flex"
                >
                  <Search size={15} />
                  <span>ค้นหา...</span>
                  <kbd className="rounded bg-peach px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">
                    ⌘K
                  </kbd>
                </button>
              )}
              <ThemeToggle />
              <NotificationBell />
              <div className="text-right">
                <p className="hidden text-sm font-medium text-ink sm:block">{email}</p>
                {role && (
                  <Badge tone={role === 'admin' ? 'green' : 'neutral'}>
                    {role === 'admin' ? 'แอดมิน' : role === 'executive' ? 'ผู้บริหาร' : role === 'freelancer' ? 'ผู้ติดตามหนี้' : 'พนักงาน'}
                  </Badge>
                )}
              </div>
              <button
                onClick={() => signOut()}
                title="ออกจากระบบ"
                className="inline-flex items-center gap-1.5 rounded-xl border border-peach bg-surface px-2.5 py-2 text-sm text-ink transition hover:bg-peach-light/50 md:px-3"
              >
                <LogOut size={16} />
                <span className="hidden sm:inline">ออก</span>
              </button>
            </div>
          )}
        </header>

        <div className="flex flex-col gap-5 md:flex-row">
          <Sidebar mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />
          <main className="min-h-[70vh] min-w-0 flex-1 rounded-2xl border border-peach bg-cream-deep p-4 shadow-sm md:p-6">
            <Suspense fallback={<Loading />}>
              <Outlet />
            </Suspense>
          </main>
        </div>
      </div>

      {/* Quick Search modal — เปิดด้วย Ctrl+K / ⌘K จากทุกหน้า */}
      <QuickSearch />
    </div>
  )
}
