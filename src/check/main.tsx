import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import './check.css'
import CheckApp from './CheckApp'

// Vite entry แยกสำหรับหน้าเช็คเครดิตสาธารณะ (check.html) — ไม่มี BrowserRouter/AuthProvider/Layout ของแอปหลัก
// ตั้งใจไม่ import อะไรจาก src/App.tsx, src/lib/auth.tsx, src/lib/db.ts, src/lib/supabase.ts เลย
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CheckApp />
  </StrictMode>,
)
