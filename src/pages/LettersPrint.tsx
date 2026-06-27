import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Printer, Mail, ArrowLeft } from 'lucide-react'

// ข้อมูลจดหมาย 1 ฉบับที่ส่งมาจากหน้าส่งจดหมาย (ผ่าน sessionStorage)
export interface PrintItem {
  contractNo: string
  customerName: string
  round: number
  addressKindLabel: string
  addressLines: string // ที่อยู่หลายบรรทัด
  body: string // เนื้อจดหมาย (แทนค่าตัวแปรแล้ว)
  primaryPhone?: string // เบอร์หลักของลูกค้า (โชว์บนซอง)
}

// ข้อมูลผู้ส่ง (มุมซ้ายบนของซอง)
const SENDER_LINES = [
  'ร้านวินชัวร์พลัส',
  '316/48 หมู่ 1 ต.แหลมฟ้าผ่า อ.พระสมุทรเจดีย์ จ.สมุทรปราการ 10290',
  'โทร. 0826853906',
]

function loadItems(): PrintItem[] {
  try {
    return JSON.parse(sessionStorage.getItem('letters_print') || '[]')
  } catch {
    return []
  }
}

// จัด alignment รายบรรทัดของเนื้อจดหมาย โดยไม่พึ่ง leading space ในเทมเพลต
type LineKind = 'title' | 'right' | 'sign' | 'list' | 'normal'

const SIGN_LINES = ['ขอแสดงความนับถือ', 'ผู้มีอำนาจลงนามแทน', 'วิน ชัวร์ พลัส', 'วินชัวร์พลัส']

function classifyLine(raw: string, index: number): LineKind {
  const t = raw.trim()
  if (index === 0) return 'title' // บรรทัดแรก = หัวเรื่อง
  if (t.startsWith('ทำที่') || t.startsWith('วันที่')) return 'right'
  if (SIGN_LINES.some((s) => t.startsWith(s))) return 'sign'
  if (/^\d+\./.test(t) || t.startsWith('-')) return 'list'
  return 'normal'
}

// เรนเดอร์เนื้อจดหมาย: split ตามบรรทัด แล้วจัด alignment ด้วย CSS
function LetterBody({ body }: { body: string }) {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  return (
    <div className="letter-body">
      {lines.map((raw, i) => {
        const t = raw.trim()
        const kind = classifyLine(raw, i)
        if (t === '') return <div key={i} className="letter-line letter-blank" />
        if (kind === 'title')
          return (
            <div key={i} className="letter-line letter-title">
              {t}
            </div>
          )
        if (kind === 'right')
          return (
            <div key={i} className="letter-line letter-right">
              {t}
            </div>
          )
        if (kind === 'sign')
          return (
            <div key={i} className="letter-line letter-sign">
              {t}
            </div>
          )
        if (kind === 'list')
          return (
            <div key={i} className="letter-line letter-list">
              {t}
            </div>
          )
        return (
          <div key={i} className="letter-line letter-normal">
            {t}
          </div>
        )
      })}
    </div>
  )
}

// หน้าปริ้นจดหมาย + ซอง (route นอก Layout — ไม่มี sidebar เพื่อปริ้นสะอาด)
export default function LettersPrint() {
  const navigate = useNavigate()
  const items = loadItems()
  // 'letters' = ปริ้นเฉพาะจดหมาย, 'envelopes' = ปริ้นเฉพาะซอง, null = พรีวิวทั้งคู่
  const [printMode, setPrintMode] = useState<'letters' | 'envelopes' | null>(null)

  useEffect(() => {
    if (!printMode) return
    // รอ DOM อัปเดต className ก่อนสั่งปริ้น
    const t = window.setTimeout(() => {
      window.print()
      setPrintMode(null)
    }, 80)
    return () => window.clearTimeout(t)
  }, [printMode])

  const modeClass = printMode === 'letters' ? 'mode-letters' : printMode === 'envelopes' ? 'mode-envelopes' : ''

  return (
    <div className={`min-h-screen bg-gray-100 ${modeClass}`}>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .print-page { box-shadow: none !important; margin: 0 !important; }
          body { background: white !important; }
          /* แยกปริ้นทีละชนิด */
          .mode-letters .envelope-page { display: none !important; }
          .mode-envelopes .letter-page { display: none !important; }
        }

        /* --- หน้าจดหมาย: เต็ม A4 --- */
        .letter-page {
          width: 210mm; min-height: 297mm; margin: 12px auto; background: white;
          padding: 20mm; box-shadow: 0 1px 6px rgba(0,0,0,.15);
          page-break-after: always; color: #1f2937;
          font-family: 'Sarabun', 'TH Sarabun New', 'Noto Sans Thai', system-ui, sans-serif;
        }
        .letter-body { font-size: 15.5px; }
        .letter-line { margin: 0; }
        .letter-blank { height: 12px; }
        .letter-title {
          text-align: center; font-weight: 700; font-size: 18px;
          margin-bottom: 14px; line-height: 1.5;
        }
        .letter-right { text-align: right; line-height: 1.9; }
        .letter-normal { text-align: justify; line-height: 1.8; text-indent: 0; }
        .letter-list {
          text-align: justify; line-height: 1.8;
          padding-left: 22px; text-indent: -22px; /* hanging indent */
        }
        .letter-sign {
          text-align: center; line-height: 1.8;
        }

        /* --- หน้าซอง: แนวนอน --- */
        .envelope-page {
          width: 210mm; min-height: 148mm; margin: 12px auto; background: white;
          padding: 18mm; box-shadow: 0 1px 6px rgba(0,0,0,.15);
          page-break-after: always; color: #1f2937; position: relative;
          font-family: 'Sarabun', 'TH Sarabun New', 'Noto Sans Thai', system-ui, sans-serif;
          display: flex; flex-direction: column;
        }
        .env-sender { font-size: 13px; line-height: 1.6; color: #374151; }
        .env-sender-label { font-weight: 600; }
        .env-recipient {
          margin-left: auto; margin-top: auto; margin-bottom: auto;
          max-width: 58%; font-size: 16px; line-height: 1.8;
        }
      `}</style>

      <div className="no-print sticky top-0 z-10 flex items-center justify-between bg-white px-4 py-3 shadow">
        <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm text-ink-soft hover:text-ink">
          <ArrowLeft size={16} /> กลับ
        </button>
        <span className="text-sm text-ink-soft">
          จดหมาย {items.length} ฉบับ · ซอง {items.length} ใบ
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPrintMode('letters')}
            disabled={items.length === 0}
            className="flex items-center gap-1 rounded-xl bg-salmon-deep px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40"
          >
            <Printer size={16} /> ปริ้นจดหมาย
          </button>
          <button
            onClick={() => setPrintMode('envelopes')}
            disabled={items.length === 0}
            className="flex items-center gap-1 rounded-xl border border-salmon-deep px-4 py-2 text-sm font-semibold text-salmon-deep hover:bg-salmon-deep/5 disabled:opacity-40"
          >
            <Mail size={16} /> ปริ้นซอง
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="mt-10 text-center text-ink-soft">ไม่มีจดหมายให้ปริ้น — กลับไปเลือกที่หน้าส่งจดหมาย</p>
      ) : (
        <div className="py-4">
          {/* จดหมาย */}
          {items.map((it, i) => (
            <div key={`L${i}`} className="print-page letter-page">
              <LetterBody body={it.body} />
            </div>
          ))}
          {/* ซอง */}
          {items.map((it, i) => (
            <div key={`E${i}`} className="print-page envelope-page">
              <div className="env-sender">
                <p className="env-sender-label">ผู้ส่ง</p>
                {SENDER_LINES.map((line, k) => (
                  <p key={k}>{line}</p>
                ))}
              </div>
              <div className="env-recipient">
                <p className="text-ink-soft">เรียน</p>
                <p className="font-semibold">คุณ{it.customerName}</p>
                <p className="whitespace-pre-line">{it.addressLines}</p>
                {it.primaryPhone ? <p>โทร. {it.primaryPhone}</p> : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
