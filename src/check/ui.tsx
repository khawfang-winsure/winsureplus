// ===== UI primitives เฉพาะหน้าเช็คเครดิตสาธารณะ (check.html) =====
// ตั้งใจไม่ใช้ src/components/ui.tsx ของแอป staff — ดีไซน์ต้องตรงกับคู่มือร้านค้า winsureplus-manual
// (โทนกระดาษอุ่น + หมึกเข้ม + ส้มเป็นแค่ accent) ซึ่งต่างจากธีมส้ม/ครีมของแอป staff โดยตั้งใจ
// สไตล์จริงมาจาก src/check/check.css (คลาส wsc-*) ไฟล์นี้แค่ประกอบเป็น React component ให้เรียกซ้ำง่าย
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`wsc-card p-4 ${className}`}>{children}</div>
}

export function Field({
  label,
  htmlFor,
  required,
  hint,
  error,
  children,
}: {
  label: string
  htmlFor?: string
  required?: boolean
  hint?: string
  error?: string
  children: ReactNode
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="wsc-label">
        {label}
        {required && <span className="wsc-required"> *</span>}
      </label>
      {children}
      {hint && !error && <p className="wsc-hint">{hint}</p>}
      {error && (
        <p role="alert" className="wsc-error-text mt-1">
          {error}
        </p>
      )}
    </div>
  )
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`wsc-input ${props.className ?? ''}`} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`wsc-select ${props.className ?? ''}`} />
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`wsc-textarea ${props.className ?? ''}`} />
}

export function Button({
  children,
  variant = 'solid',
  onDark = false,
  className = '',
  ...props
}: {
  variant?: 'solid' | 'ghost'
  onDark?: boolean
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = ['wsc-btn', variant === 'ghost' ? 'ghost' : '', onDark ? 'on-dark' : ''].filter(Boolean).join(' ')
  return (
    <button {...props} className={`${cls} ${className}`}>
      {children}
    </button>
  )
}

export type PillTone = 'ok' | 'warn' | 'bad' | 'neutral'

export function Pill({ tone = 'neutral', children }: { tone?: PillTone; children: ReactNode }) {
  return <span className={`wsc-pill ${tone}`}>{children}</span>
}

export function Loading({ label = 'กำลังโหลด...' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 wsc-muted text-sm">
      <span className="h-4 w-4 animate-spin rounded-full border-2" style={{ borderColor: 'var(--wsc-rule)', borderTopColor: 'var(--wsc-ink)' }} />
      {label}
    </div>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="wsc-card p-8 text-center" style={{ borderStyle: 'dashed' }}>
      <p className="font-medium">{title}</p>
      {hint && <p className="wsc-hint mt-1">{hint}</p>}
    </div>
  )
}
