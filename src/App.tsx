import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import { AuthProvider, useAuth } from './lib/auth'
import Dashboard from './pages/Dashboard'
import AddContract from './pages/AddContract'
import AllCustomers from './pages/AllCustomers'
import CustomerOverview from './pages/CustomerOverview'
import ContractDetail from './pages/ContractDetail'
import DueToday from './pages/DueToday'
import Overdue from './pages/Overdue'
import Returns from './pages/Returns'
import ShopReport from './pages/ShopReport'
import ShopDetail from './pages/ShopDetail'
import Commission from './pages/Commission'
import Letters from './pages/Letters'
import LettersPrint from './pages/LettersPrint'
import Settings from './pages/Settings'
import WaitingEmail from './pages/WaitingEmail'
import WaitingSummary from './pages/WaitingSummary'
import Login from './pages/Login'

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  )
}

function Gate() {
  const { ready, configured, session, role } = useAuth()
  const isAdmin = !configured || role === 'admin'

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-cream text-ink-soft">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-peach border-t-salmon-deep" />
      </div>
    )
  }

  // เชื่อม Supabase แล้วแต่ยังไม่ล็อกอิน -> หน้า Login (โหมด mock ไม่ต้องล็อกอิน)
  if (configured && !session) return <Login />

  return (
    <Routes>
      {/* หน้าปริ้นจดหมาย — นอก Layout (ไม่มี sidebar เพื่อปริ้นสะอาด) */}
      <Route path="/letters/print" element={<LettersPrint />} />
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="/add" element={<AddContract />} />
        <Route path="/edit/:id" element={<AddContract />} />
        <Route path="/waiting-email" element={<WaitingEmail />} />
        <Route path="/waiting-summary" element={<WaitingSummary />} />
        <Route path="/customers" element={<AllCustomers />} />
        <Route path="/customer-overview" element={<CustomerOverview />} />
        <Route path="/contract/:id" element={<ContractDetail />} />
        <Route path="/due" element={<DueToday />} />
        <Route path="/overdue/:bucket" element={<Overdue />} />
        <Route path="/letters" element={<Letters />} />
        <Route path="/returns" element={<Returns />} />
        <Route path="/shop-report" element={<ShopReport />} />
        <Route path="/shop/:id" element={<ShopDetail />} />
        <Route path="/commission" element={isAdmin ? <Commission /> : <Navigate to="/" replace />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/add" replace />} />
      </Route>
    </Routes>
  )
}
