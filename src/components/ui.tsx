import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
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

// ความกว้างของ Modal — 'md' (เดิม, ค่า default) ใช้กับฟอร์มสั้นๆ ทั่วไป, 'lg' สำหรับโมดัลที่มีตาราง/เนื้อหาซับซ้อนต้องการที่กว้างขึ้น
const MODAL_SIZE_CLASS: Record<'md' | 'lg', string> = {
  md: 'max-w-md',
  lg: 'max-w-3xl',
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** focus trap (Tab/Shift+Tab วนอยู่ในโมดัล) เสมอ + Esc ปิดเฉพาะตอน `closeOnEsc` (default false — ดู
 *  comment บน prop) + คืน focus ให้ element เดิมตอนปิด — ใช้ร่วมกับ <Modal> ทุกจุดในเว็บ (แก้ที่นี่ที่เดียว
 *  ทุกโมดัลได้ focus trap/aria ตาม axe/keyboard-a11y checklist) */
export function Modal({
  title,
  onClose,
  children,
  size = 'md',
  closeOnEsc = false,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  size?: 'md' | 'lg'
  /** Esc ปิดโมดัลนี้ไหม — default false เพราะฟอร์มเดิมหลายจุด (AddContract, payment/extend/close ฯลฯ)
   *  มีข้อมูลที่พิมพ์ค้างอยู่ กด Esc พลาดครั้งเดียวข้อมูลหายหมด ไม่ต้องยืนยัน (เสี่ยงเสียงานพิมพ์)
   *  เปิดเฉพาะโมดัลที่ไม่มีฟอร์มค้าง/dirty state เสี่ยงหาย (เช่น โมดัลอ่านอย่างเดียว/คิวเช็คเครดิต) */
  closeOnEsc?: boolean
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  // onClose ของผู้เรียกมักเป็น inline arrow function ที่เปลี่ยน reference ทุก render — เก็บผ่าน ref แทน
  // การใส่ลง deps ตรงๆ กัน effect ผูก/ถอด listener ใหม่ทุกครั้งที่ parent re-render (แค่เก็บค่าล่าสุดไว้เรียก)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const closeOnEscRef = useRef(closeOnEsc)
  closeOnEscRef.current = closeOnEsc

  // จับ element ที่โฟกัสอยู่ "ก่อน" โมดัลนี้ mount ผ่าน lazy initializer ของ useState — รันตอน render
  // ครั้งแรก (ก่อน browser commit DOM ของโมดัลลงจริง) ต่างจากการอ่านใน useEffect ที่รันหลัง commit แล้ว
  // ซึ่งถ้ามีลูกที่ตั้ง autoFocus ไว้ focus จะย้ายไปที่ลูกนั้นไปแล้วก่อน effect รันด้วยซ้ำ — อ่านตรงนี้เท่านั้น
  // ถึงจะได้ element ที่ถูกต้องจริงๆ (เช่นปุ่มที่กดเปิดโมดัล) ไว้คืน focus ให้ตอนปิด
  const [previouslyFocused] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null,
  )

  useEffect(() => {
    const dialog = dialogRef.current
    // ถ้ามี element ในโมดัลโฟกัสอยู่แล้ว (เช่น <input autoFocus> ของฟอร์มเดิม) อย่าแย่ง focus มา —
    // autoFocus ของ React ทำงานตอน commit (ก่อน useEffect นี้รัน) ให้ค่าตรงนี้ทันสมัยที่สุดแล้ว
    const alreadyFocusedInside = !!(dialog && document.activeElement && dialog.contains(document.activeElement))
    if (!alreadyFocusedInside) {
      const focusables = dialog?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ;(focusables && focusables.length > 0 ? focusables[0] : dialog)?.focus()
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (!closeOnEscRef.current) return
        e.stopPropagation()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab' || !dialog) return
      const nodes = dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      if (nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`max-h-[90vh] w-full ${MODAL_SIZE_CLASS[size]} overflow-y-auto rounded-2xl bg-surface p-6 shadow-xl outline-none`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h3 id={titleId} className="text-lg font-bold text-ink">{title}</h3>
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
