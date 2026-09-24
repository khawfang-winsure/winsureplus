import { useState } from 'react'
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
    <div className="wsc-root min-h-screen pb-10">
      <header className="wsc-hero sticky top-0 z-10">
        <h1 className="sr-only">เช็คเครดิตเบื้องต้น — WIN SURE PLUS</h1>
        <div className="mx-auto flex max-w-md items-center justify-between px-4 pt-3">
          <div>
            <p className="wsc-mono-label">WINSURE+ · CREDIT CHECK</p>
            <p className="text-sm font-semibold">{session.shopName}</p>
          </div>
          <button type="button" onClick={handleLogout} className="wsc-btn ghost on-dark !w-auto !min-h-0 px-3 py-1.5 text-xs">
            ออกจากระบบ
          </button>
        </div>
        <nav className="mx-auto flex max-w-md gap-5 px-4 pt-3">
          <button type="button" onClick={() => setScreen('form')} className={`wsc-tab ${screen === 'form' || screen === 'result' ? 'on' : ''}`}>
            ยื่นคำขอ
          </button>
          <button type="button" onClick={() => setScreen('list')} className={`wsc-tab ${screen === 'list' ? 'on' : ''}`}>
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
