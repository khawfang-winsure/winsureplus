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
import StaffPerformance from './pages/StaffPerformance'
import DevicePipeline from './pages/DevicePipeline'

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
  const isExecutive = configured && role === 'executive'
  const isAdminOrStaff = isAdmin || role === 'staff'

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
      {/* executive ไม่เห็นข้อมูลลูกค้ารายคน → redirect กลับ /exec */}
      <Route path="/letters/print" element={isExecutive ? <Navigate to="/exec" replace /> : <LettersPrint />} />
      <Route path="/letters/field" element={isExecutive ? <Navigate to="/exec" replace /> : <FieldVisitPrint />} />
      <Route element={<Layout />}>
        {/* ผู้ติดตามหนี้ — เห็นเฉพาะ /queue */}
        <Route path="/queue" element={isExecutive ? <Navigate to="/exec" replace /> : <FreelancerWorkspace />} />

        {/* admin / staff — ถ้าเป็น freelancer ให้ redirect ไป /queue; executive ไป /exec */}
        <Route index element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <Dashboard />} />
        <Route path="/exec" element={(isAdmin || isExecutive) ? <ExecDashboard /> : <Navigate to="/" replace />} />
        <Route path="/add" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <AddContract />} />
        <Route path="/edit/:id" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <AddContract />} />
        <Route path="/waiting-email" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <WaitingEmail />} />
        <Route path="/waiting-summary" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <WaitingSummary />} />
        <Route path="/customers" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <AllCustomers />} />
        <Route path="/customer-overview" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <CustomerOverview />} />
        <Route path="/contract/:id" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <ContractDetail />} />
        <Route path="/due" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <DueToday />} />
        <Route path="/overdue/:bucket" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <Overdue />} />
        <Route path="/letters" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <Letters />} />
        <Route path="/returns" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <Returns />} />
        <Route path="/device-pipeline" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <DevicePipeline />} />
        <Route path="/extended" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <ExtendedContracts />} />
        <Route path="/shop-report" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <ShopReport />} />
        <Route path="/shop/:id" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <ShopDetail />} />
        <Route path="/staff-performance" element={isExecutive ? <Navigate to="/exec" replace /> : isAdminOrStaff ? <StaffPerformance /> : <Navigate to={isFreelancer ? '/queue' : '/'} replace />} />
        <Route path="/commission" element={isExecutive ? <Navigate to="/exec" replace /> : isAdmin ? <Commission /> : <Navigate to="/" replace />} />
        <Route path="/settings" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <Navigate to="/settings/shops" replace />} />
        <Route path="/settings/:cat" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <Settings />} />
        <Route path="*" element={<Navigate to={isExecutive ? '/exec' : isFreelancer ? '/queue' : '/add'} replace />} />
      </Route>
    </Routes>
  )
}
