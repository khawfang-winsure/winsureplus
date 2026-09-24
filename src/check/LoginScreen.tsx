import { useId, useState, type FormEvent } from 'react'
import { LogIn } from 'lucide-react'
import { Button, Card, Field, Input } from '../components/ui'
import { ApiError, loginShop } from './api'
import { loadRememberedLoginCode, saveStoredSession, type StoredSession } from './storage'

export default function LoginScreen({
  notice,
  onLoggedIn,
}: {
  notice?: string | null
  onLoggedIn: (session: StoredSession) => void
}) {
  const [loginCode, setLoginCode] = useState(() => loadRememberedLoginCode())
  const [pin, setPin] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const codeId = useId()
  const pinId = useId()
  const errorId = useId()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (submitting) return
    const code = loginCode.trim().toUpperCase()
    if (!code || pin.trim().length === 0) {
      setError('กรุณากรอกรหัสร้านและ PIN ให้ครบ')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const result = await loginShop(code, pin.trim())
      const session: StoredSession = { loginCode: code, token: result.token, shopName: result.shopName, savedAt: Date.now() }
      saveStoredSession(session)
      onLoggedIn(session)
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message)
      } else {
        setError('เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-cream px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold text-ink">เช็คเครดิตเบื้องต้น</h1>
          <p className="mt-1 text-sm text-muted-check">WIN SURE PLUS — สำหรับร้านค้าพาร์ทเนอร์</p>
        </div>

        <Card>
          {notice && (
            <p className="mb-4 rounded-xl bg-amber-100 px-3 py-2 text-sm text-amber-800">{notice}</p>
          )}
          <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
            <Field label="รหัสร้าน" required>
              <Input
                id={codeId}
                autoFocus
                autoComplete="off"
                autoCapitalize="characters"
                value={loginCode}
                onChange={(e) => setLoginCode(e.target.value.toUpperCase())}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                placeholder="เช่น A1B2C3"
              />
            </Field>
            <Field label="PIN 6 หลัก" required>
              <Input
                id={pinId}
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, ''))}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                placeholder="••••••"
              />
            </Field>

            {error && (
              <p id={errorId} role="alert" className="text-sm font-medium text-red-600">
                {error}
              </p>
            )}

            <Button type="submit" disabled={submitting} className="mt-1 w-full !bg-orange-700">
              <LogIn className="h-4 w-4" />
              {submitting ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
            </Button>
          </form>
        </Card>

        <p className="mt-4 text-center text-xs text-muted-check">
          ยังไม่มีรหัสร้าน/PIN ติดต่อแอดมิน WIN SURE PLUS
        </p>
      </div>
    </main>
  )
}
