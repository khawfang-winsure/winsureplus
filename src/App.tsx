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
import ExtendedContracts from './pages/ExtendedContracts'
import ShopReport from './pages/ShopReport'
import ShopDetail from './pages/ShopDetail'
import Commission from './pages/Commission'
import ExecDashboard from './pages/ExecDashboard'
import Letters from './pages/Letters'
import LettersPrint from './pages/LettersPrint'
import FieldVisitPrint from './pages/FieldVisitPrint'
import Settings from './pages/Settings'
import WaitingEmail from './pages/WaitingEmail'
import WaitingSummary from './pages/WaitingSummary'
import Login from './pages/Login'
import FreelancerWorkspace from './pages/FreelancerWorkspace'

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
  const isFreelancer = configured && role === 'freelancer'

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
      {/* หน้าปริ้น — นอก Layout (ไม่มี sidebar เพื่อปริ้นสะอาด) */}
      <Route path="/letters/print" element={<LettersPrint />} />
      <Route path="/letters/field" element={<FieldVisitPrint />} />
      <Route element={<Layout />}>
        {/* ผู้ติดตามหนี้ — เห็นเฉพาะ /queue */}
        <Route path="/queue" element={<FreelancerWorkspace />} />

        {/* admin / staff — ถ้าเป็น freelancer ให้ redirect ไป /queue */}
        <Route index element={isFreelancer ? <Navigate to="/queue" replace /> : <Dashboard />} />
        <Route path="/exec" element={isAdmin ? <ExecDashboard /> : <Navigate to="/" replace />} />
        <Route path="/add" element={isFreelancer ? <Navigate to="/queue" replace /> : <AddContract />} />
        <Route path="/edit/:id" element={isFreelancer ? <Navigate to="/queue" replace /> : <AddContract />} />
        <Route path="/waiting-email" element={isFreelancer ? <Navigate to="/queue" replace /> : <WaitingEmail />} />
        <Route path="/waiting-summary" element={isFreelancer ? <Navigate to="/queue" replace /> : <WaitingSummary />} />
        <Route path="/customers" element={isFreelancer ? <Navigate to="/queue" replace /> : <AllCustomers />} />
        <Route path="/customer-overview" element={isFreelancer ? <Navigate to="/queue" replace /> : <CustomerOverview />} />
        <Route path="/contract/:id" element={isFreelancer ? <Navigate to="/queue" replace /> : <ContractDetail />} />
        <Route path="/due" element={isFreelancer ? <Navigate to="/queue" replace /> : <DueToday />} />
        <Route path="/overdue/:bucket" element={isFreelancer ? <Navigate to="/queue" replace /> : <Overdue />} />
        <Route path="/letters" element={isFreelancer ? <Navigate to="/queue" replace /> : <Letters />} />
        <Route path="/returns" element={isFreelancer ? <Navigate to="/queue" replace /> : <Returns />} />
        <Route path="/extended" element={isFreelancer ? <Navigate to="/queue" replace /> : <ExtendedContracts />} />
        <Route path="/shop-report" element={isFreelancer ? <Navigate to="/queue" replace /> : <ShopReport />} />
        <Route path="/shop/:id" element={isFreelancer ? <Navigate to="/queue" replace /> : <ShopDetail />} />
        <Route path="/commission" element={isAdmin ? <Commission /> : <Navigate to="/" replace />} />
        <Route path="/settings" element={isFreelancer ? <Navigate to="/queue" replace /> : <Navigate to="/settings/shops" replace />} />
        <Route path="/settings/:cat" element={isFreelancer ? <Navigate to="/queue" replace /> : <Settings />} />
        <Route path="*" element={<Navigate to={isFreelancer ? '/queue' : '/add'} replace />} />
      </Route>
    </Routes>
  )
}
