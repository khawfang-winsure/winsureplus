import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isSupabaseConfigured, supabase } from './supabase'
import { getMyProfile, type Role } from './db'

interface AuthState {
  ready: boolean // โหลดสถานะล็อกอินเสร็จหรือยัง
  configured: boolean // ใส่กุญแจ Supabase แล้วหรือยัง (ถ้ายัง = โหมด mock ไม่ต้องล็อกอิน)
  session: Session | null
  role: Role | null
  email: string | null
  signIn: (email: string, password: string) => Promise<{ error?: string }>
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  const [role, setRole] = useState<Role | null>(null)

  useEffect(() => {
    if (!supabase) {
      setReady(true)
      return
    }
    supabase.auth
      .getSession()
      .then(({ data }) => {
        setSession(data.session)
        return data.session ? getMyProfile() : null
      })
      .then((p) => setRole(p?.role ?? null))
      .finally(() => setReady(true))

    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      if (s) getMyProfile().then((p) => setRole(p?.role ?? null))
      else setRole(null)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  async function signIn(email: string, password: string) {
    if (!supabase) return {}
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return error ? { error: error.message } : {}
  }

  async function signOut() {
    if (supabase) await supabase.auth.signOut()
  }

  return (
    <Ctx.Provider
      value={{
        ready,
        configured: isSupabaseConfigured,
        session,
        role,
        email: session?.user.email ?? null,
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
