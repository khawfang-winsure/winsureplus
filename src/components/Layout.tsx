import { Suspense } from 'react'
import { Outlet } from 'react-router-dom'
import { LogOut, Search } from 'lucide-react'
import Logo from './Logo'
import Sidebar from './Sidebar'
import NotificationBell from './NotificationBell'
import QuickSearch from './QuickSearch'
import { Badge, Loading } from './ui'
import { useAuth } from '../lib/auth'

// โครงหน้าหลัก: กรอบครีม + หัวโลโก้ + เมนูซ้าย + เนื้อหาขวา (การ์ดขาว)
export default function Layout() {
  const { email, role, configured, signOut } = useAuth()

  // แสดงปุ่ม search เฉพาะ admin/staff เท่านั้น (เหมือน QuickSearch role-gate)
  const isAdminOrStaff = !configured || role === 'admin' || role === 'staff'

  function openQuickSearch() {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
  }

  return (
    <div className="min-h-screen bg-cream p-4 md:p-6">
      <div className="mx-auto max-w-[1400px]">
        {/* หัว */}
        <header className="mb-5 flex items-center gap-4">
          <Logo />
          <h1 className="text-2xl font-bold tracking-wide text-ink">WIN SURE PLUS</h1>

          {email && (
            <div className="ml-auto flex items-center gap-3">
              {isAdminOrStaff && (
                <button
                  type="button"
                  onClick={openQuickSearch}
                  title="ค้นหาด่วน (Ctrl+K / ⌘K)"
                  className="hidden items-center gap-2 rounded-xl border border-peach bg-white px-3 py-2 text-sm text-ink-soft transition hover:bg-peach-light/50 sm:inline-flex"
                >
                  <Search size={15} />
                  <span>ค้นหา...</span>
                  <kbd className="rounded bg-peach px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">
                    ⌘K
                  </kbd>
                </button>
              )}
              <NotificationBell />
              <div className="text-right">
                <p className="text-sm font-medium text-ink">{email}</p>
                {role && (
                  <Badge tone={role === 'admin' ? 'green' : 'neutral'}>
                    {role === 'admin' ? 'แอดมิน' : role === 'executive' ? 'ผู้บริหาร' : role === 'freelancer' ? 'ผู้ติดตามหนี้' : 'พนักงาน'}
                  </Badge>
                )}
              </div>
              <button
                onClick={() => signOut()}
                title="ออกจากระบบ"
                className="inline-flex items-center gap-1.5 rounded-xl border border-peach bg-white px-3 py-2 text-sm text-ink transition hover:bg-peach-light/50"
              >
                <LogOut size={16} /> ออก
              </button>
            </div>
          )}
        </header>

        <div className="flex flex-col gap-5 md:flex-row">
          <Sidebar />
          <main className="min-h-[70vh] min-w-0 flex-1 rounded-2xl border border-peach bg-cream-deep p-6 shadow-sm">
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
