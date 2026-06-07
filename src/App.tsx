import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import AddContract from './pages/AddContract'
import AllCustomers from './pages/AllCustomers'
import DueToday from './pages/DueToday'
import Overdue from './pages/Overdue'
import Returns from './pages/Returns'
import Letters from './pages/Letters'
import Settings from './pages/Settings'
import WaitingEmail from './pages/WaitingEmail'
import WaitingSummary from './pages/WaitingSummary'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/add" replace />} />
        <Route path="/add" element={<AddContract />} />
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
