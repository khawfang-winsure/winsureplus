import { useState } from 'react'
import { LogIn } from 'lucide-react'
import { Button, Field, Input } from '../components/ui'
import Logo from '../components/Logo'
import { useAuth } from '../lib/auth'

export default function Login() {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await signIn(email.trim(), password)
    if (res.error) setError('เข้าสู่ระบบไม่สำเร็จ: ' + res.error)
    setBusy(false)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-cream p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-3xl border-2 border-indigo-300/40 bg-white p-7 shadow-sm"
      >
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Logo size={56} />
          <div>
            <h1 className="text-xl font-bold text-ink">WIN SURE PLUS</h1>
            <p className="text-sm text-ink-soft">เข้าสู่ระบบเพื่อใช้งาน</p>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <Field label="อีเมล" required>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </Field>
          <Field label="รหัสผ่าน" required>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>

          {error && (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
          )}

          <Button type="submit" disabled={busy} className="mt-1 w-full">
            <LogIn size={16} /> {busy ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
          </Button>
        </div>
      </form>
    </div>
  )
}
