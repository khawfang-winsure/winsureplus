import { useState } from 'react'
import { LogOut } from 'lucide-react'
import FormScreen from './FormScreen'
import LoginScreen from './LoginScreen'
import RequestsList from './RequestsList'
import ResultScreen from './ResultScreen'
import type { SubmitResult } from './api'
import { clearStoredSession, loadStoredSession, saveStoredSession, type StoredSession } from './storage'

type Screen = 'form' | 'result' | 'list'

export default function CheckApp() {
  const [session, setSession] = useState<StoredSession | null>(() => loadStoredSession())
  const [loginNotice, setLoginNotice] = useState<string | null>(null)
  const [screen, setScreen] = useState<Screen>('form')
  const [lastResult, setLastResult] = useState<SubmitResult | null>(null)

  function handleSessionExpired(notice: string) {
    clearStoredSession()
    setSession(null)
    setLoginNotice(notice)
    setScreen('form')
  }

  function handleLogout() {
    clearStoredSession()
    setSession(null)
    setLoginNotice(null)
    setScreen('form')
  }

  if (!session) {
    return (
      <LoginScreen
        notice={loginNotice}
        onLoggedIn={(s) => {
          saveStoredSession(s)
          setSession(s)
          setLoginNotice(null)
        }}
      />
    )
  }

  return (
    <div className="min-h-screen bg-cream pb-10">
      <header className="sticky top-0 z-10 border-b border-peach bg-cream-deep">
        <h1 className="sr-only">เช็คเครดิตเบื้องต้น — WIN SURE PLUS</h1>
        <div className="mx-auto flex max-w-md items-center justify-between px-4 py-3">
          <div>
            <p className="text-sm font-bold text-ink">{session.shopName}</p>
            <p className="text-xs text-muted-check">เช็คเครดิตเบื้องต้น WIN SURE PLUS</p>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            aria-label="ออกจากระบบ"
            className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-muted-check hover:bg-peach-light/60 hover:text-ink"
          >
            <LogOut className="h-4 w-4" />
            ออกจากระบบ
          </button>
        </div>
        <nav className="mx-auto flex max-w-md gap-2 px-4 pb-2">
          <button
            type="button"
            onClick={() => setScreen('form')}
            className={`rounded-full px-3 py-1 text-xs font-medium ${screen === 'form' || screen === 'result' ? 'bg-orange-700 text-white' : 'bg-surface text-muted-check'}`}
          >
            ยื่นคำขอ
          </button>
          <button
            type="button"
            onClick={() => setScreen('list')}
            className={`rounded-full px-3 py-1 text-xs font-medium ${screen === 'list' ? 'bg-orange-700 text-white' : 'bg-surface text-muted-check'}`}
          >
            คำขอของร้าน
          </button>
        </nav>
      </header>

      <main>
        {screen === 'form' && (
          <FormScreen
            token={session.token}
            onSubmitted={(result) => {
              setLastResult(result)
              setScreen('result')
            }}
            onSessionExpired={handleSessionExpired}
          />
        )}

        {screen === 'result' && lastResult && (
          <ResultScreen result={lastResult} onNewRequest={() => setScreen('form')} onViewList={() => setScreen('list')} />
        )}

        {screen === 'list' && <RequestsList token={session.token} onSessionExpired={handleSessionExpired} />}
      </main>
    </div>
  )
}
