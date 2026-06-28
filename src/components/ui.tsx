import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { X } from 'lucide-react'

// ===== ชิ้นส่วน UI ที่ใช้ซ้ำทั้งเว็บ =====

export function PageTitle({
  children,
  sub,
  count,
}: {
  children: ReactNode
  sub?: string
  count?: { shown: number; total?: number }
}) {
  const countText =
    count == null
      ? null
      : count.total == null || count.total === count.shown
        ? `(${count.shown} รายการ)`
        : `(แสดง ${count.shown} จาก ${count.total} รายการ)`

  return (
    <div className="mb-5">
      <h2 className="text-xl font-bold text-ink">
        {children}
        {countText && (
          <span className="ml-2 text-sm font-normal text-ink-soft">{countText}</span>
        )}
      </h2>
      {sub && <p className="mt-1 text-sm text-ink-soft">{sub}</p>}
    </div>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-peach bg-cream-deep p-5 shadow-sm ${className}`}>{children}</div>
  )
}

/** ช่องกรอกแบบมีป้ายกำกับ (label อยู่บน) */
export function Field({
  label,
  children,
  required,
}: {
  label: string
  children: ReactNode
  required?: boolean
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      {children}
    </label>
  )
}

const inputCls =
  'w-full rounded-xl border border-peach bg-surface px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-salmon-deep focus:ring-2 focus:ring-salmon/40'

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputCls} ${props.className ?? ''}`} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputCls} ${props.className ?? ''}`} />
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputCls} ${props.className ?? ''}`} />
}

export function Button({
  children,
  variant = 'primary',
  ...props
}: { variant?: 'primary' | 'ghost' } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:opacity-50'
  const styles =
    variant === 'primary'
      ? 'bg-salmon-deep text-white hover:brightness-105 shadow'
      : 'bg-surface text-ink border border-peach hover:bg-peach-light/50'
  return (
    <button {...props} className={`${base} ${styles} ${props.className ?? ''}`}>
      {children}
    </button>
  )
}

/** ป้ายสถานะแบบกลม */
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'red' }) {
  const tones: Record<string, string> = {
    neutral: 'bg-peach-soft text-ink',
    green: 'bg-green-100 text-green-700',
    amber: 'bg-amber-100 text-amber-700',
    red: 'bg-red-100 text-red-700',
  }
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  )
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-surface p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h3 className="text-lg font-bold text-ink">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิด"
            className="-mr-1 shrink-0 rounded-lg p-1 text-ink-soft transition hover:bg-peach-light/50 hover:text-ink"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Loading({ label = 'กำลังโหลด...' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-ink-soft">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-peach border-t-salmon-deep" />
      {label}
    </div>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-2xl border-2 border-dashed border-peach bg-peach-light/30 p-10 text-center">
      <p className="font-medium text-ink">{title}</p>
      {hint && <p className="mt-1 text-sm text-ink-soft">{hint}</p>}
    </div>
  )
}
