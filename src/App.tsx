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
const MonthlyReport = lazy(() => import('./pages/MonthlyReport'))
const ShopPromoAnalysis = lazy(() => import('./pages/ShopPromoAnalysis'))
const WeeklySummary = lazy(() => import('./pages/WeeklySummary'))
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
const Import = lazy(() => import('./pages/Import'))
const InboxPage = lazy(() => import('./pages/InboxPage'))
const MyPerformance = lazy(() => import('./pages/MyPerformance'))
const DocTracking = lazy(() => import('./pages/DocTracking'))
const OtherIncomePage = lazy(() => import('./pages/OtherIncome'))
const ReturnsReport = lazy(() => import('./pages/ReturnsReport'))
const SettlementReport = lazy(() => import('./pages/SettlementReport'))
const PjSyncReview = lazy(() => import('./pages/PjSyncReview'))
const AccountingTransfers = lazy(() => import('./pages/AccountingTransfers'))
const TransferSummary = lazy(() => import('./pages/TransferSummary'))
const HrReport = lazy(() => import('./pages/HrReport'))

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
  const isAccounting = configured && role === 'accounting'
  const isAdminOrStaff = isAdmin || role === 'staff'
  // ปลายทาง redirect เริ่มต้นของแต่ละ role ที่ไม่ใช่ admin/staff (ผู้ติดตามหนี้/ผู้บริหาร/บัญชี เห็นแค่โซนของตัวเอง)
  const fallbackTo = isExecutive ? '/exec' : isFreelancer ? '/queue' : isAccounting ? '/transfers' : '/'

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
        <Route path="/letters/print" element={isExecutive ? <Navigate to="/exec" replace /> : isAccounting ? <Navigate to="/transfers" replace /> : <LettersPrint />} />
        <Route path="/letters/field" element={isExecutive ? <Navigate to="/exec" replace /> : isAccounting ? <Navigate to="/transfers" replace /> : <FieldVisitPrint />} />
        <Route element={<Layout />}>
          {/* ผู้ติดตามหนี้ — เห็นเฉพาะ /queue และ /my-performance */}
          <Route path="/queue" element={isExecutive ? <Navigate to="/exec" replace /> : isAccounting ? <Navigate to="/transfers" replace /> : <FreelancerWorkspace />} />
          <Route path="/my-performance" element={isFreelancer ? <MyPerformance /> : <Navigate to={fallbackTo} replace />} />

          {/* บัญชี — เห็นเฉพาะ /transfers */}
          <Route path="/transfers" element={(isAdmin || isAccounting) ? <AccountingTransfers /> : <Navigate to={fallbackTo} replace />} />

          {/* admin / staff — ถ้าเป็น freelancer ให้ redirect ไป /queue; executive ไป /exec; บัญชี ไป /transfers */}
          <Route index element={isFreelancer ? <Navigate to="/queue" replace /> : (isExecutive || isAccounting) ? <Navigate to={fallbackTo} replace /> : <Dashboard />} />
          <Route path="/exec" element={(isAdmin || isExecutive) ? <ExecDashboard /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/monthly-report" element={(isAdmin || isExecutive) ? <MonthlyReport /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/transfer-summary" element={(isAdmin || isExecutive) ? <TransferSummary /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/shop-promo-analysis" element={(isAdmin || isExecutive) ? <ShopPromoAnalysis /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/weekly-summary" element={isAdmin ? <WeeklySummary /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/add" element={isAdminOrStaff ? <AddContract /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/edit/:id" element={isAdminOrStaff ? <AddContract /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/sale-history" element={isAdmin ? <SaleHistory /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/waiting-email" element={isAdminOrStaff ? <WaitingEmail /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/waiting-summary" element={isAdminOrStaff ? <WaitingSummary /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/doc-tracking" element={isAdminOrStaff ? <DocTracking /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/other-income" element={isAdminOrStaff ? <OtherIncomePage /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/customers" element={isAdminOrStaff ? <AllCustomers /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/customer-overview" element={isAdminOrStaff ? <CustomerOverview /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/contract/:id" element={isAdminOrStaff ? <ContractDetail /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/customer/:id" element={isAdminOrStaff ? <CustomerDetail /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/due" element={isAdminOrStaff ? <DueToday /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/overdue/:bucket" element={isAdminOrStaff ? <Overdue /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/letters" element={isAdminOrStaff ? <Letters /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/returns" element={isAdminOrStaff ? <Returns /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/device-pipeline" element={isAdminOrStaff ? <DevicePipeline /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/extended" element={isAdminOrStaff ? <ExtendedContracts /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/shop-report" element={isAdmin ? <ShopReport /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/shop/:id" element={isAdmin ? <ShopDetail /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/staff-performance" element={(isAdmin || isExecutive) ? <StaffPerformance /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/hr-report" element={(isAdmin || isExecutive) ? <HrReport /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/staff-daily-report" element={(isAdmin || isExecutive) ? <StaffDailyReport /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/commission" element={isAdmin ? <Commission /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/settings" element={isAdminOrStaff ? <Navigate to="/settings/shops" replace /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/settings/:cat" element={isAdminOrStaff ? <Settings /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/returns-report" element={isAdmin ? <ReturnsReport /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/settlements" element={isAdmin ? <SettlementReport /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/pj-sync-review" element={isAdminOrStaff ? <PjSyncReview /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/import" element={isAdmin ? <Import /> : <Navigate to={fallbackTo} replace />} />
          <Route path="/inbox" element={isAdminOrStaff ? <InboxPage /> : <Navigate to={fallbackTo} replace />} />
          <Route path="*" element={<Navigate to={isFreelancer ? '/queue' : (isExecutive || isAccounting) ? fallbackTo : '/add'} replace />} />
        </Route>
      </Routes>
      </Suspense>
    </ErrorBoundary>
  )
}
