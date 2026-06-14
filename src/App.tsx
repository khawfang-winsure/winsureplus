import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { ErrorBoundary } from './components/ErrorBoundary'
import Layout from './components/Layout'
import { Loading } from './components/ui'
import { AuthProvider, useAuth } from './lib/auth'
// Login stays eager — it renders outside <Routes> on the unauthenticated path
import Login from './pages/Login'

const Dashboard = lazy(() => import('./pages/Dashboard'))
const AddContract = lazy(() => import('./pages/AddContract'))
const AllCustomers = lazy(() => import('./pages/AllCustomers'))
const CustomerOverview = lazy(() => import('./pages/CustomerOverview'))
const ContractDetail = lazy(() => import('./pages/ContractDetail'))
const DueToday = lazy(() => import('./pages/DueToday'))
const Overdue = lazy(() => import('./pages/Overdue'))
const Returns = lazy(() => import('./pages/Returns'))
const ExtendedContracts = lazy(() => import('./pages/ExtendedContracts'))
const ShopReport = lazy(() => import('./pages/ShopReport'))
const ShopDetail = lazy(() => import('./pages/ShopDetail'))
const Commission = lazy(() => import('./pages/Commission'))
const ExecDashboard = lazy(() => import('./pages/ExecDashboard'))
const Letters = lazy(() => import('./pages/Letters'))
const LettersPrint = lazy(() => import('./pages/LettersPrint'))
const FieldVisitPrint = lazy(() => import('./pages/FieldVisitPrint'))
const Settings = lazy(() => import('./pages/Settings'))
const WaitingEmail = lazy(() => import('./pages/WaitingEmail'))
const WaitingSummary = lazy(() => import('./pages/WaitingSummary'))
const FreelancerWorkspace = lazy(() => import('./pages/FreelancerWorkspace'))
const StaffPerformance = lazy(() => import('./pages/StaffPerformance'))
const DevicePipeline = lazy(() => import('./pages/DevicePipeline'))
const CustomerDetail = lazy(() => import('./pages/CustomerDetail'))
const StaffDailyReport = lazy(() => import('./pages/StaffDailyReport'))
const SaleHistory = lazy(() => import('./pages/SaleHistory'))
const WeeklyReport = lazy(() => import('./pages/WeeklyReport'))

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
    <ErrorBoundary>
      <Suspense fallback={<Loading />}>
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
          <Route path="/add" element={isExecutive ? <Navigate to="/exec" replace /> : isAdminOrStaff ? <AddContract /> : <Navigate to="/" replace />} />
          <Route path="/edit/:id" element={isExecutive ? <Navigate to="/exec" replace /> : isAdmin ? <AddContract /> : <Navigate to="/" replace />} />
          <Route path="/sale-history" element={isAdmin ? <SaleHistory /> : <Navigate to={isExecutive ? '/exec' : isFreelancer ? '/queue' : '/'} replace />} />
          <Route path="/waiting-email" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <WaitingEmail />} />
          <Route path="/waiting-summary" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <WaitingSummary />} />
          <Route path="/customers" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <AllCustomers />} />
          <Route path="/customer-overview" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <CustomerOverview />} />
          <Route path="/contract/:id" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <ContractDetail />} />
          <Route path="/customer/:id" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <CustomerDetail />} />
          <Route path="/due" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <DueToday />} />
          <Route path="/overdue/:bucket" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <Overdue />} />
          <Route path="/letters" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <Letters />} />
          <Route path="/returns" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <Returns />} />
          <Route path="/device-pipeline" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <DevicePipeline />} />
          <Route path="/extended" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <ExtendedContracts />} />
          <Route path="/shop-report" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <ShopReport />} />
          <Route path="/shop/:id" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <ShopDetail />} />
          <Route path="/staff-performance" element={isExecutive ? <Navigate to="/exec" replace /> : isAdminOrStaff ? <StaffPerformance /> : <Navigate to={isFreelancer ? '/queue' : '/'} replace />} />
          <Route path="/staff-daily-report" element={isExecutive ? <Navigate to="/exec" replace /> : isAdminOrStaff ? <StaffDailyReport /> : <Navigate to={isFreelancer ? '/queue' : '/'} replace />} />
          <Route path="/weekly-report" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <WeeklyReport />} />
          <Route path="/commission" element={isExecutive ? <Navigate to="/exec" replace /> : isAdmin ? <Commission /> : <Navigate to="/" replace />} />
          <Route path="/settings" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <Navigate to="/settings/shops" replace />} />
          <Route path="/settings/:cat" element={isExecutive ? <Navigate to="/exec" replace /> : isFreelancer ? <Navigate to="/queue" replace /> : <Settings />} />
          <Route path="*" element={<Navigate to={isExecutive ? '/exec' : isFreelancer ? '/queue' : '/add'} replace />} />
        </Route>
      </Routes>
      </Suspense>
    </ErrorBoundary>
  )
}
