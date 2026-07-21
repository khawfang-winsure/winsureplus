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

// template เป็น HTML แล้วหรือยัง (มี tag จริง) → ใช้ HTML render; ถ้าไม่ → fallback line-classification
function looksLikeHtml(s: string): boolean {
  return /<[a-z][\s\S]*>/i.test(s)
}

// sanitize เบื้องต้น (admin-only tool): อนุญาตเฉพาะ tag จัดรูปแบบ + style จำกัด, ตัด script/handler ออก
const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'br', 'div', 'p', 'span', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'font',
])
const ALLOWED_STYLE_PROPS = new Set([
  'text-align', 'font-weight', 'font-style', 'text-decoration', 'font-size',
])

function sanitizeStyle(raw: string): string {
  return raw
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const idx = d.indexOf(':')
      if (idx < 0) return ''
      const prop = d.slice(0, idx).trim().toLowerCase()
      const val = d.slice(idx + 1).trim()
      if (!ALLOWED_STYLE_PROPS.has(prop)) return ''
      // กัน url()/expression()/javascript: ใน value
      if (/url\s*\(|expression\s*\(|javascript:/i.test(val)) return ''
      return `${prop}: ${val}`
    })
    .filter(Boolean)
    .join('; ')
}

function sanitizeLetterHtml(html: string): string {
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
    // SSR/edge fallback: ตัด script + on*= แบบหยาบ
    return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  }
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  const root = doc.body.firstElementChild
  if (!root) return ''

  const walk = (node: Element) => {
    // วนสำเนา children เพราะจะมีการ replace/remove ระหว่างทาง
    Array.from(node.children).forEach((child) => {
      const tag = child.tagName.toLowerCase()
      if (tag === 'script' || tag === 'style' || !ALLOWED_TAGS.has(tag)) {
        // ตัด tag ที่ไม่อนุญาต แต่ดึงข้อความข้างในขึ้นมาแทน (unwrap)
        const text = doc.createTextNode(child.textContent ?? '')
        child.replaceWith(text)
        return
      }
      // ลบ attribute ทั้งหมดยกเว้น style ที่ผ่าน whitelist
      Array.from(child.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase()
        if (name === 'style') {
          const clean = sanitizeStyle(attr.value)
          if (clean) child.setAttribute('style', clean)
          else child.removeAttribute('style')
        } else if (name === 'size' && tag === 'font') {
          // <font size="N"> จาก execCommand('fontSize') — เก็บไว้ render ขนาด
          if (!/^[1-7]$/.test(attr.value)) child.removeAttribute('size')
        } else {
          child.removeAttribute(attr.name)
        }
      })
      walk(child)
    })
  }
  walk(root)
  return root.innerHTML
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

// เรนเดอร์เนื้อจดหมายแบบ HTML (เทมเพลตที่ Pete จัดรูปแบบไว้) — sanitize ก่อนเสมอ
function LetterHtml({ body }: { body: string }) {
  const safe = sanitizeLetterHtml(body)
  return <div className="letter-body letter-html" dangerouslySetInnerHTML={{ __html: safe }} />
}

// หน้าปริ้นจดหมาย + ซอง (route นอก Layout — ไม่มี sidebar เพื่อปริ้นสะอาด)
export default function LettersPrint() {
  const navigate = useNavigate()
  const items = loadItems()
  // 'letters' = ปริ้นเฉพาะจดหมาย, 'envelopes' = ปริ้นเฉพาะซอง, null = พรีวิวทั้งคู่
  const [printMode, setPrintMode] = useState<'letters' | 'envelopes' | null>(null)

  useEffect(() => {
    if (!printMode) return
    let resolved = false
    const finish = () => {
      if (resolved) return
      resolved = true
      setPrintMode(null)
    }
    // เคลียร์ mode หลังปิดกล่องปริ้นจริง (ไม่ว่าจะกดปริ้นหรือยกเลิก) แทนการเคลียร์ทันทีหลัง
    // window.print() คืนค่า — บาง browser คืนค่าก่อน preview render เสร็จ ทำให้ class
    // mode-envelopes/mode-letters หลุดเร็วเกินไป เสี่ยงพิมพ์ปนกัน
    window.addEventListener('afterprint', finish)
    // รอ DOM อัปเดต className ก่อนสั่งปริ้น
    const t = window.setTimeout(() => window.print(), 80)
    // กันค้าง เผื่อบาง browser ไม่ยิง afterprint
    const fallback = window.setTimeout(finish, 5000)
    return () => {
      window.clearTimeout(t)
      window.clearTimeout(fallback)
      window.removeEventListener('afterprint', finish)
    }
  }, [printMode])

  const modeClass = printMode === 'letters' ? 'mode-letters' : printMode === 'envelopes' ? 'mode-envelopes' : ''

  return (
    <div className={`min-h-screen bg-gray-100 ${modeClass}`}>
      <style>{`
        /* กระดาษจดหมาย: ใช้ "named page" แยกจากซอง (@page letter) เพราะเอกสารเดียวกันมีทั้ง
           จดหมาย (A4 แนวตั้ง) และซอง (แนวนอน) ผสมกัน — ถ้าใช้ @page เดียวแบบ global จะกระทบทั้งคู่
           @page margin: 18mm เป็นคนหักขอบกระดาษแทน container (ไม่ตรึง 210mm ตายตัวเหมือนเดิม)
           เพื่อให้พิมพ์ 100% พอดีเสมอ ไม่ว่าผู้ใช้จะเลือก "ระยะขอบ = ไม่มี/ค่าเริ่มต้น" ใน dialog
           ก็ตาม — เบราว์เซอร์ใช้ค่านี้เป็นค่าตั้งต้นให้ และ container ด้านล่างยืดเต็มพื้นที่ที่เหลือ
           (width: 100% ไม่ใช่เลข mm ตายตัว) จึงไม่มีทางล้น/เพี้ยน center */
        @page letter {
          size: A4 portrait;
          margin: 18mm;
        }
        @media print {
          .no-print { display: none !important; }
          .print-page { box-shadow: none !important; margin: 0 auto !important; }
          body { background: white !important; }
          /* แยกปริ้นทีละชนิด */
          .mode-letters .envelope-page { display: none !important; }
          .mode-envelopes .letter-page { display: none !important; }
        }

        /* --- หน้าจดหมาย: ยืดเต็มพื้นที่พิมพ์ (ไม่ตรึง 210mm) ---
           text width จริง = ความกว้าง A4 (210mm) − ขอบซ้าย/ขวาที่ @page letter กำหนด (18mm × 2)
           = 174mm (ใกล้เคียงค่าเดิม 170mm ที่เคยได้จาก padding 20mm ทั้ง 2 ข้าง — เลย์เอาต์/ฟอนต์
           แทบไม่เปลี่ยน) padding ซ้าย-ขวาของ container ลดเหลือ 0 เพราะขอบมาจาก @page แล้ว
           (ไม่ซ้อนสองชั้น) เหลือ padding บน-ล่างไว้กันตัวหนังสือชิดขอบบน-ล่างของหน้า */
        .letter-page {
          page: letter;
          box-sizing: border-box;
          width: 100%; margin: 12px auto; background: white;
          padding: 6mm 0; box-shadow: 0 1px 6px rgba(0,0,0,.15);
          page-break-after: always; color: #1f2937;
          font-family: 'Sarabun', 'TH Sarabun New', 'Noto Sans Thai', system-ui, sans-serif;
        }
        /* จอปกติ (ไม่ใช่ตอนพิมพ์): แสดงเป็นแผ่น A4 จำลองเหมือนเดิมให้ยังพรีวิวได้
           (min-height ใส่เฉพาะจอ — ตอนพิมพ์ไม่ตรึงความสูง เพราะพื้นที่พิมพ์จริงต่อหน้าไม่เท่ากัน
           ระหว่างเลือกระยะขอบ None/Default แต่ page-break-after ทำงานอิสระจากความสูงอยู่แล้ว) */
        @media screen {
          .letter-page { width: 210mm; min-height: 297mm; padding: 20mm; }
        }
        .letter-body { font-size: 15.5px; }
        /* เนื้อจดหมายที่ render จาก HTML (เทมเพลตที่จัดรูปแบบไว้) */
        .letter-html { line-height: 1.8; text-align: justify; }
        .letter-html div, .letter-html p { margin: 0; min-height: 1.2em; }
        .letter-html p { margin-bottom: 6px; }
        .letter-html ul, .letter-html ol { padding-left: 24px; margin: 4px 0; }
        .letter-html h1 { font-size: 20px; font-weight: 700; }
        .letter-html h2 { font-size: 18px; font-weight: 700; }
        .letter-html h3 { font-size: 16px; font-weight: 700; }
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

        /* --- หน้าซอง: ซองยาว DL แนวนอน 220×110mm (ขนาดจริงที่ Pete ยืนยัน) ---
           ต้องมี @page ของตัวเองแยกจาก @page letter เพราะเอกสารเดียวกันมีทั้งจดหมาย (A4 แนวตั้ง)
           กับซอง (แนวนอน เล็กกว่ามาก) ผสมกัน — ถ้าไม่มี named page ของซอง เบราว์เซอร์จะใช้ @page
           default (คือ @page letter = A4) แทน ทำให้ซองพิมพ์เป็น A4 (บั๊กเดิม)

           ⚠️ margin: 0 ที่ @page envelope (เดิมเคยตั้ง margin: 8mm ตรงนี้) — Chrome ไม่สามารถสั่ง
           ขนาดกระดาษจริงได้จาก @page เอง (ขนาดจริงมาจาก driver/print dialog เท่านั้น) พอ driver
           ตีความ margin ต่างจากที่เราประกาศ ทำให้ตัวหนังสือฝั่งซ้ายโดนตัดหายทุกบรรทัด (ผู้ใช้ยืนยัน
           ด้วยรูปจริง — "ร้านวินชัวร์พลัส" ออกมาเป็น "ชัวร์พลัส") จึงย้ายระยะขอบทั้งหมดมาไว้ที่
           padding ของ .envelope-page แทน เพราะ padding เป็นกล่องที่เราคุมได้แน่นอน 100% ไม่ผ่าน
           การตีความของ driver อีกชั้น — ห้ามย้าย margin กลับไปที่ @page envelope */
        @page envelope {
          size: 220mm 110mm;
          margin: 0;
        }
        .envelope-page {
          page: envelope;
          box-sizing: border-box;
          /* width/height: 100% (ไม่ตรึง mm ตายตัว) ให้ยืดเต็ม page box จริงที่ได้มา ไม่ว่า driver
             จะตีความขนาดกระดาษต่างจากที่เราประกาศแค่ไหนก็ตาม — padding ด้านล่างเป็นคนกันขอบแทน
             @page margin (ดูคอมเมนต์ที่ @page envelope ด้านบน)
             padding ซ้าย 24mm กว้างกว่าด้านอื่นเพราะเจอจริงว่าโดนตัดฝั่งซ้าย ~12-15mm ทุกบรรทัด
             เผื่อไว้เกินพอสำหรับ non-printable area ของเครื่องพิมพ์ทั่วไป (เช่น Epson) */
          width: 100%; height: 100%; margin: 12px auto; background: white;
          padding: 16mm 16mm 12mm 24mm; box-shadow: 0 1px 6px rgba(0,0,0,.15);
          page-break-after: always; page-break-inside: avoid; color: #1f2937; position: relative;
          font-family: 'Sarabun', 'TH Sarabun New', 'Noto Sans Thai', system-ui, sans-serif;
          display: flex; flex-direction: column;
          /* กันเนื้อหาล้นไปหน้าถัดไปเด็ดขาด (เคยเจอเบอร์โทรผู้รับหลุดไปอีกแผ่นตอนที่อยู่ยาว) */
          overflow: hidden;
        }
        /* จอปกติ: จำลองเป็นซอง DL ขนาดจริง (220×110mm) ให้พรีวิวตรงกับของจริงที่จะพิมพ์
           padding ใช้ค่าเดียวกับตอนพิมพ์ (ไม่ override) เพื่อให้พรีวิวตรงกับผลจริง */
        @media screen {
          .envelope-page { width: 220mm; height: 110mm; }
        }
        /* ผู้ส่ง: มุมซ้ายบน ตัวเล็ก ต้องพิมพ์ติดครบทุกบรรทัด (จุดที่เคยหลุดหาย) */
        .env-sender { font-size: 11.5px; line-height: 1.55; color: #374151; }
        .env-sender-label { font-weight: 600; }
        /* ผู้รับ: ตามธรรมเนียมซองไทย — ค่อนไปทางขวา + กลางค่อนล่าง ตัวใหญ่กว่าผู้ส่ง
           เดิมใช้ margin-top: auto (ดันลงล่างสุดเท่าที่มีที่ว่าง) แต่ถ้าที่อยู่ยาวหลายบรรทัด
           จะดันจนล้นไปหน้าถัดไป จึงเปลี่ยนเป็นค่าคงที่ที่ควบคุมได้แทน + ลดฟอนต์ลงเล็กน้อย
           (เดิม 15px) ให้มีที่ว่างเผื่อที่อยู่ยาวมากขึ้นก่อนจะโดน overflow:hidden ตัด */
        .env-recipient {
          margin-left: auto; margin-top: 24mm;
          max-width: 62%; font-size: 14px; line-height: 1.6;
          page-break-inside: avoid;
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

      {/* คำแนะนำวิธีปริ้นซองให้ได้ขนาดจริง — โชว์บนจอเท่านั้น (no-print) ไม่ออกกระดาษ
          เพราะขนาดกระดาษจริงต้องตั้งที่กล่องโต้ตอบของระบบ (@page คุมไม่ได้ 100%) */}
      <div className="no-print mx-auto mt-3 max-w-2xl rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        <p className="font-semibold">วิธีปริ้นซองให้ได้ขนาดจริง</p>
        <ol className="mt-1.5 list-decimal space-y-1 pl-5">
          <li>กด "ปริ้นซอง" แล้วในหน้าตัวอย่าง กด "พิมพ์โดยใช้กล่องโต้ตอบระบบ" (Ctrl+Shift+P)</li>
          <li>ตั้งขนาดกระดาษ = Envelope DL และประเภทกระดาษ = Envelope</li>
          <li>ใส่ซองที่ถาดด้านหลัง ด้านสั้นเข้าก่อน ฝาพับคว่ำลง</li>
          <li>ตั้ง Scale/มาตราส่วน = 100% และปิด "ปรับให้พอดีหน้า"</li>
        </ol>
      </div>

      {items.length === 0 ? (
        <p className="mt-10 text-center text-ink-soft">ไม่มีจดหมายให้ปริ้น — กลับไปเลือกที่หน้าส่งจดหมาย</p>
      ) : (
        <div className="py-4">
          {/* จดหมาย */}
          {items.map((it, i) => (
            <div key={`L${i}`} className="print-page letter-page">
              {looksLikeHtml(it.body) ? <LetterHtml body={it.body} /> : <LetterBody body={it.body} />}
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
                <p className="font-semibold">{it.customerName}</p>
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
