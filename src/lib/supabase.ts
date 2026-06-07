// ===== ตัวเชื่อม Supabase =====
// ถ้ายังไม่ได้ใส่กุญแจใน .env -> client เป็น null และเว็บจะใช้ข้อมูลตัวอย่าง (mock) แทน
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/** true เมื่อใส่กุญแจครบแล้ว — ใช้สลับระหว่างข้อมูลจริง / mock */
export const isSupabaseConfigured = Boolean(url && anonKey)

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url!, anonKey!)
  : null
