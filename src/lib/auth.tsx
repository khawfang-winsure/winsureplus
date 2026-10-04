import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isSupabaseConfigured, supabase } from './supabase'
import { clearReferenceCaches, getMyProfile, type Role } from './db'

/** โปรไฟล์ของ user คนเดิมถือว่าสด 30 นาที — เกินนั้นค่อยอ่านใหม่ตอนมี event (กัน role ที่แอดมินเปลี่ยนค้างข้ามวัน) */
const PROFILE_FRESH_MS = 30 * 60_000

interface AuthState {
  ready: boolean // โหลดสถานะล็อกอินเสร็จหรือยัง
  configured: boolean // ใส่กุญแจ Supabase แล้วหรือยัง (ถ้ายัง = โหมด mock ไม่ต้องล็อกอิน)
  session: Session | null
  role: Role | null
  email: string | null
  name: string | null // ชื่อผู้ใช้ที่ล็อกอิน (จาก profiles.full_name)
  isAccounting: boolean // role === 'accounting' — เห็นเฉพาะหน้าโอนเงินร้าน
  signIn: (email: string, password: string) => Promise<{ error?: string }>
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  const [role, setRole] = useState<Role | null>(null)
  const [name, setName] = useState<string | null>(null)
  // user ที่โหลดโปรไฟล์ไว้แล้ว + เวลาที่โหลด — onAuthStateChange ยิงซ้ำบ่อย (TOKEN_REFRESHED / กลับมาที่แท็บ)
  // ถ้า user เดิมและโปรไฟล์ยังสด ไม่ต้องอ่าน profiles ใหม่ (เดิม ~1.9k ครั้ง/วัน)
  const profileRef = useRef<{ userId: string; at: number } | null>(null)

  useEffect(() => {
    if (!supabase) {
      setReady(true)
      return
    }
    // โหลดโปรไฟล์ของ user นี้ — ตั้ง profileRef ก่อนยิง (กัน INITIAL_SESSION ที่มาติดกันโหลดซ้ำ)
    // ถ้าไม่ได้โปรไฟล์/พัง ล้าง ref เพื่อให้ event ถัดไปลองใหม่ · ผลของ user ที่ไม่ใช่ปัจจุบันแล้วถูกทิ้ง
    function loadProfile(userId: string): Promise<void> {
      const mark = { userId, at: Date.now() }
      profileRef.current = mark
      return getMyProfile()
        .then((p) => {
          if (profileRef.current !== mark) return
          if (!p) profileRef.current = null
          setRole(p?.role ?? null)
          setName(p?.fullName ?? null)
        })
        .catch(() => {
          if (profileRef.current === mark) profileRef.current = null
        })
    }

    supabase.auth
      .getSession()
      .then(({ data }) => {
        setSession(data.session)
        return data.session ? loadProfile(data.session.user.id) : undefined
      })
      .finally(() => setReady(true))

    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      if (s) {
        const cur = profileRef.current
        if (cur && cur.userId === s.user.id && Date.now() - cur.at < PROFILE_FRESH_MS) return
        // login ใหม่/สลับคน → ล้าง cache อ้างอิง (RLS ต่าง role เห็นร้าน/ตัวเลือกไม่เท่ากัน)
        if (!cur || cur.userId !== s.user.id) clearReferenceCaches()
        void loadProfile(s.user.id)
      } else {
        profileRef.current = null
        clearReferenceCaches()
        setRole(null)
        setName(null)
      }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  async function signIn(email: string, password: string) {
    if (!supabase) return {}
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return error ? { error: error.message } : {}
  }

  async function signOut() {
    if (supabase) await supabase.auth.signOut({ scope: 'local' })
  }

  return (
    <Ctx.Provider
      value={{
        ready,
        configured: isSupabaseConfigured,
        session,
        role,
        email: session?.user.email ?? null,
        name,
        isAccounting: role === 'accounting',
        signIn,
        signOut,
      }}
    >
      {children}
    </Ctx.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAuth ต้องอยู่ภายใน AuthProvider')
  return c
}
