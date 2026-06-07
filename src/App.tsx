import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import { AuthProvider, useAuth } from './lib/auth'
import AddContract from './pages/AddContract'
import AllCustomers from './pages/AllCustomers'
import DueToday from './pages/DueToday'
import Overdue from './pages/Overdue'
import Returns from './pages/Returns'
import Letters from './pages/Letters'
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
  const { ready, configured, session } = useAuth()

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
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/add" replace />} />
        <Route path="/add" element={<AddContract />} />
        <Route path="/edit/:id" element={<AddContract />} />
        <Route path="/waiting-email" element={<WaitingEmail />} />
        <Route path="/waiting-summary" element={<WaitingSummary />} />
        <Route path="/customers" element={<AllCustomers />} />
        <Route path="/due" element={<DueToday />} />
        <Route path="/overdue/:bucket" element={<Overdue />} />
        <Route path="/letters" element={<Letters />} />
        <Route path="/returns" element={<Returns />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/add" replace />} />
      </Route>
    </Routes>
  )
}
