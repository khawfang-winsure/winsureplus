import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      // Multi-page build: หน้าเว็บหลัก (staff) + check.html (ร้านค้าเช็คเครดิตเอง สาธารณะ, no auth/db.ts)
      // ต้อง list ทั้งคู่ใน input เดียวกันเพื่อให้ Vite แชร์ chunk react/react-dom ระหว่าง 2 หน้า ไม่ bundle ซ้ำ
      // path เป็น relative string เฉยๆ (ไม่ใช้ node:url/fileURLToPath) — โปรเจกต์นี้ไม่มี @types/node ติดตั้งไว้
      input: {
        main: 'index.html',
        check: 'check.html',
      },
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'supabase': ['@supabase/supabase-js'],
          'lucide': ['lucide-react'],
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
})
