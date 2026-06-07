import { Outlet } from 'react-router-dom'
import Logo from './Logo'
import Sidebar from './Sidebar'

// โครงหน้าหลัก: กรอบครีม + หัวโลโก้ + เมนูซ้าย + เนื้อหาขวา (การ์ดขาว)
export default function Layout() {
  return (
    <div className="min-h-screen bg-cream p-4 md:p-6">
      <div className="mx-auto max-w-[1400px] rounded-[28px] border-2 border-indigo-300/50 bg-cream-deep p-5 md:p-7">
        {/* หัว */}
        <header className="mb-5 flex items-center gap-4">
          <Logo />
          <h1 className="text-2xl font-bold tracking-wide text-ink">WIN SURE PLUS</h1>
        </header>

        <div className="flex flex-col gap-5 md:flex-row">
          <Sidebar />
          <main className="min-h-[70vh] flex-1 rounded-3xl bg-white p-6 shadow-sm">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  )
}
