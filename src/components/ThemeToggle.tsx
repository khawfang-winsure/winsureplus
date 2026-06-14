import { Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'

/** อ่านค่าเริ่มต้นจาก localStorage → fallback system preference */
function getInitialDark(): boolean {
  const stored = localStorage.getItem('theme')
  if (stored !== null) return stored === 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export default function ThemeToggle() {
  const [dark, setDark] = useState<boolean>(getInitialDark)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('theme', dark ? 'dark' : 'light')
  }, [dark])

  return (
    <button
      type="button"
      onClick={() => setDark((v) => !v)}
      title={dark ? 'สลับเป็นโหมดสว่าง' : 'สลับเป็นโหมดมืด'}
      aria-label={dark ? 'สลับเป็นโหมดสว่าง' : 'สลับเป็นโหมดมืด'}
      className="inline-flex items-center justify-center rounded-xl border border-peach bg-surface p-2 text-ink transition hover:bg-peach-light/50"
    >
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  )
}
