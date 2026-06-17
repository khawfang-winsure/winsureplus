import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Undo2 } from 'lucide-react'

/**
 * UndoToast — แถบแจ้งเตือนลอยมุมล่างขวา 5 วินาที พร้อมปุ่ม ↩ ยกเลิก
 *
 * Props:
 *   label    — ข้อความแสดง เช่น `ลบ "ค่าซ่อม" แล้ว`
 *   onUndo   — callback เมื่อกดยกเลิก (async)
 *   onExpire — callback เมื่อหมดเวลาโดยไม่ได้กด undo
 *
 * ให้ใส่ key ที่ไม่ซ้ำกัน (เช่น `key={undoKey}`) บน component นี้
 * เพื่อให้ React remount และรีเซ็ต timer ทุกครั้งที่ delete ใหม่
 */
export default function UndoToast({
  label,
  onUndo,
  onExpire,
}: {
  label: string
  onUndo: () => Promise<void>
  onExpire: () => void
}) {
  const DURATION = 5000
  const barRef = useRef<HTMLDivElement>(null)
  const calledRef = useRef(false)

  useEffect(() => {
    // animate progress bar
    const bar = barRef.current
    if (bar) {
      bar.style.transition = `width ${DURATION}ms linear`
      // รอ 1 frame ให้ browser วัด width ก่อนแล้วค่อย animate
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          bar.style.width = '0%'
        })
      })
    }

    const timer = setTimeout(() => {
      if (!calledRef.current) {
        calledRef.current = true
        onExpire()
      }
    }, DURATION)

    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleUndo() {
    if (calledRef.current) return
    calledRef.current = true
    await onUndo()
  }

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 right-4 z-[9999] flex w-80 flex-col overflow-hidden rounded-2xl bg-ink shadow-xl"
    >
      {/* progress bar */}
      <div className="h-1 w-full bg-ink-soft/30">
        <div
          ref={barRef}
          className="h-full w-full bg-salmon-deep"
        />
      </div>

      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="text-sm text-white">{label}</span>
        <button
          onClick={handleUndo}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-white/15 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/25 focus:outline-none focus:ring-2 focus:ring-white/50"
        >
          <Undo2 size={13} />
          ยกเลิก
        </button>
      </div>
    </div>,
    document.body,
  )
}
