import { useId, useState, type FormEvent } from 'react'
import { Button, Card, Field, Input } from './ui'
import { ApiError, loginShop } from './api'
import { loadRememberedLoginCode, saveStoredSession, type StoredSession } from './storage'
import mascotWai from './assets/mascot-wai.webp'

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
    <main className="wsc-root flex min-h-screen flex-col">
      <div className="wsc-hero">
        <div className="mx-auto max-w-sm px-4 pb-6 pt-7">
          <p className="wsc-mono-label">WINSURE+ · CREDIT CHECK</p>
          <h1 className="wsc-h1">
            เช็คเครดิต
            <br />
            เบื้องต้น
          </h1>
          <div className="mt-3 flex items-end justify-between gap-3">
            <p className="text-sm wsc-muted">สำหรับร้านค้าพาร์ทเนอร์</p>
            <img src={mascotWai} alt="" width={265} height={480} className="wsc-mascot" />
          </div>
        </div>
      </div>

      <div className="flex-1 px-4 py-6">
        <div className="mx-auto w-full max-w-sm">
          <Card>
            {notice && <p className="wsc-note mb-4">{notice}</p>}
            <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
              <Field label="รหัสร้าน" htmlFor={codeId} required>
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
              <Field label="PIN 6 หลัก" htmlFor={pinId} required>
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
                <p id={errorId} role="alert" className="wsc-error-text">
                  {error}
                </p>
              )}

              <Button type="submit" disabled={submitting} className="mt-1">
                {submitting ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
                <span className="wsc-go" aria-hidden="true">
                  →
                </span>
              </Button>
            </form>
          </Card>

          <p className="mt-4 text-center text-xs wsc-muted">ยังไม่มีรหัสร้าน/PIN ติดต่อแอดมิน WIN SURE PLUS</p>
        </div>
      </div>
    </main>
  )
}
