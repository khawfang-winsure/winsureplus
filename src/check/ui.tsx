// ===== UI primitives เฉพาะหน้าเช็คเครดิตสาธารณะ (check.html) =====
// ตั้งใจไม่ใช้ src/components/ui.tsx ของแอป staff — ดีไซน์ต้องตรงกับคู่มือร้านค้า winsureplus-manual
// (โทนกระดาษอุ่น + หมึกเข้ม + ส้มเป็นแค่ accent) ซึ่งต่างจากธีมส้ม/ครีมของแอป staff โดยตั้งใจ
// สไตล์จริงมาจาก src/check/check.css (คลาส wsc-*) ไฟล์นี้แค่ประกอบเป็น React component ให้เรียกซ้ำง่าย
import {
  cloneElement,
  isValidElement,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`wsc-card p-4 ${className}`}>{children}</div>
}

/** props ที่ Field ต้องเซ็ตให้ลูก (id + aria-describedby) — ใช้ร่วมกับ isValidElement<T> เป็น type guard
 *  ครอบคลุม input/select/textarea ทุกตัวเพราะทั้งหมด extend HTMLAttributes/AriaAttributes อยู่แล้ว */
interface FieldChildProps {
  id?: string
  'aria-describedby'?: string
}

/**
 * ช่องฟอร์มแบบมี label — ต่อ id ให้ label กับ input ลูกอัตโนมัติเสมอ (ป้องกัน label ลอยไม่ผูกกับช่อง —
 * บั๊กที่ติ๊กจับได้ 2026-09-24 ตอน FormScreen ไม่ได้ส่ง htmlFor/id คู่กันเอง):
 * - ไม่ส่ง `htmlFor` มา -> ใช้ useId() คิดเอง
 * - ลูกมี `id` ของตัวเองอยู่แล้ว (เช่น LoginScreen ที่ผูกกับ error banner นอก Field) -> เคารพ id เดิม ไม่ทับ
 * - ประกอบ aria-describedby ให้ลูกอัตโนมัติจาก hint/error (รวมกับ aria-describedby เดิมของลูกถ้ามี ไม่ทับ)
 * ใช้ได้กับลูกที่เป็น element เดี่ยวเท่านั้น (Input/Select/Textarea ของไฟล์นี้) — ถ้าไม่ใช่ element เดี่ยว
 * (กรณีอนาคตเผื่อไว้) จะ render children เดิมเฉยๆ ไม่ throw ไม่ wiring ให้
 */
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
  const autoId = useId()
  const hintId = useId()
  const errorId = useId()

  const childIsElement = isValidElement<FieldChildProps>(children)
  const fieldId = (childIsElement ? children.props.id : undefined) ?? htmlFor ?? autoId

  let wired = children
  if (childIsElement) {
    const describedByParts = [children.props['aria-describedby']]
    if (error) describedByParts.push(errorId)
    else if (hint) describedByParts.push(hintId)
    const describedBy = describedByParts.filter(Boolean).join(' ') || undefined
    wired = cloneElement(children, { id: fieldId, 'aria-describedby': describedBy })
  }

  return (
    <div>
      <label htmlFor={fieldId} className="wsc-label">
        {label}
        {required && <span className="wsc-required"> *</span>}
      </label>
      {wired}
      {hint && !error && (
        <p id={hintId} className="wsc-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="wsc-error-text mt-1">
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
