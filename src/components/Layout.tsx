import { Outlet } from 'react-router-dom'
import { LogOut } from 'lucide-react'
import Logo from './Logo'
import Sidebar from './Sidebar'
import NotificationBell from './NotificationBell'
import { Badge } from './ui'
import { useAuth } from '../lib/auth'

// โครงหน้าหลัก: กรอบครีม + หัวโลโก้ + เมนูซ้าย + เนื้อหาขวา (การ์ดขาว)
export default function Layout() {
  const { email, role, signOut } = useAuth()

  return (
    <div className="min-h-screen bg-cream p-4 md:p-6">
      <div className="mx-auto max-w-[1400px] rounded-[28px] border-2 border-indigo-300/50 bg-cream-deep p-5 md:p-7">
        {/* หัว */}
        <header className="mb-5 flex items-center gap-4">
          <Logo />
          <h1 className="text-2xl font-bold tracking-wide text-ink">WIN SURE PLUS</h1>

          {email && (
            <div className="ml-auto flex items-center gap-3">
              <NotificationBell />
              <div className="text-right">
                <p className="text-sm font-medium text-ink">{email}</p>
                {role && (
                  <Badge tone={role === 'admin' ? 'green' : 'neutral'}>
                    {role === 'admin' ? 'แอดมิน' : 'พนักงาน'}
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
          <main className="min-h-[70vh] min-w-0 flex-1 rounded-3xl bg-white p-6 shadow-sm">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  )
}
