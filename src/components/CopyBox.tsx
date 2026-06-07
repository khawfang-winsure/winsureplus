import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

// กล่องแสดงข้อความที่สร้าง พร้อมปุ่ม "คัดลอก" (ตามที่พี่พิธเลือก: ก๊อปไปวางเอง)
export default function CopyBox({ title, text }: { title: string; text: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="rounded-2xl border border-peach bg-white">
      <div className="flex items-center justify-between border-b border-peach px-4 py-2.5">
        <span className="text-sm font-semibold text-ink">{title}</span>
        <button
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-salmon-deep px-3 py-1.5 text-xs font-semibold text-white transition hover:brightness-105"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? 'คัดลอกแล้ว' : 'คัดลอก'}
        </button>
      </div>
      <pre className="scrollbar-thin max-h-80 overflow-auto whitespace-pre-wrap px-4 py-3 text-[13px] leading-relaxed text-ink">
        {text}
      </pre>
    </div>
  )
}
