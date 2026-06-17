import { useNavigate } from 'react-router-dom'
import { Printer, ArrowLeft } from 'lucide-react'

// ข้อมูลจดหมาย 1 ฉบับที่ส่งมาจากหน้าส่งจดหมาย (ผ่าน sessionStorage)
export interface PrintItem {
  contractNo: string
  customerName: string
  round: number
  addressKindLabel: string
  addressLines: string // ที่อยู่หลายบรรทัด
  body: string // เนื้อจดหมาย (แทนค่าตัวแปรแล้ว)
}

const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม']
function thaiDate(): string {
  const d = new Date()
  return `${d.getDate()} ${TH_MONTHS[d.getMonth()]} ${d.getFullYear() + 543}`
}

function loadItems(): PrintItem[] {
  try {
    return JSON.parse(sessionStorage.getItem('letters_print') || '[]')
  } catch {
    return []
  }
}

// หน้าปริ้นจดหมาย + ซอง (route นอก Layout — ไม่มี sidebar เพื่อปริ้นสะอาด)
export default function LettersPrint() {
  const navigate = useNavigate()
  const items = loadItems()
  const date = thaiDate()

  return (
    <div className="min-h-screen bg-gray-100">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .print-page { page-break-after: always; box-shadow: none !important; margin: 0 !important; }
          body { background: white !important; }
        }
        .print-page { width: 210mm; min-height: 148mm; margin: 12px auto; background: white; padding: 18mm; box-shadow: 0 1px 6px rgba(0,0,0,.15); }
      `}</style>

      <div className="no-print sticky top-0 z-10 flex items-center justify-between bg-white px-4 py-3 shadow">
        <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm text-ink-soft hover:text-ink">
          <ArrowLeft size={16} /> กลับ
        </button>
        <span className="text-sm text-ink-soft">จดหมาย {items.length} ฉบับ (+ ซอง {items.length})</span>
        <button
          onClick={() => window.print()}
          className="flex items-center gap-1 rounded-xl bg-salmon-deep px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
        >
          <Printer size={16} /> ปริ้น
        </button>
      </div>

      {items.length === 0 ? (
        <p className="mt-10 text-center text-ink-soft">ไม่มีจดหมายให้ปริ้น — กลับไปเลือกที่หน้าส่งจดหมาย</p>
      ) : (
        <div className="py-4">
          {/* จดหมาย */}
          {items.map((it, i) => (
            <div key={`L${i}`} className="print-page text-ink">
              <p className="text-right text-sm">วันที่ {date}</p>
              <p className="mt-6 font-semibold">เรียน คุณ{it.customerName}</p>
              <p className="whitespace-pre-line text-sm leading-7">{it.addressLines}</p>
              <p className="mt-1 text-xs text-ink-soft">
                (สัญญา {it.contractNo} · จดหมายครั้งที่ {it.round} · {it.addressKindLabel})
              </p>
              <div className="mt-6 whitespace-pre-line leading-8">{it.body}</div>
            </div>
          ))}
          {/* ซอง */}
          {items.map((it, i) => (
            <div key={`E${i}`} className="print-page flex flex-col justify-center text-ink">
              <div className="ml-auto max-w-[55%]">
                <p className="mb-1 text-sm text-ink-soft">เรียน</p>
                <p className="text-lg font-semibold">คุณ{it.customerName}</p>
                <p className="whitespace-pre-line leading-8">{it.addressLines}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
