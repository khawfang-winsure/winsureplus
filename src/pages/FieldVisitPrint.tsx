import { useNavigate } from 'react-router-dom'
import { Printer, ArrowLeft } from 'lucide-react'

// ข้อมูล 1 รายสำหรับลงพื้นที่ (ส่งมาจากหน้าส่งจดหมายผ่าน sessionStorage)
export interface FieldItem {
  customerName: string
  contractNo: string
  shopName: string
  daysLate: number
  amount: number
  device: string
  phones: string[]
  province: string // โซน (ใช้จัดกลุ่ม)
  addresses: { label: string; line: string }[] // ที่อยู่ทุกชุดที่มี
}

function loadItems(): FieldItem[] {
  try {
    return JSON.parse(sessionStorage.getItem('field_print') || '[]')
  } catch {
    return []
  }
}

const baht = (n: number) => n.toLocaleString('th-TH')

export default function FieldVisitPrint() {
  const navigate = useNavigate()
  const items = loadItems()

  // จัดกลุ่มตามจังหวัด (โซน)
  const byProvince = new Map<string, FieldItem[]>()
  for (const it of items) {
    const arr = byProvince.get(it.province)
    if (arr) arr.push(it)
    else byProvince.set(it.province, [it])
  }
  const groups = [...byProvince.entries()].sort((a, b) => a[0].localeCompare(b[0], 'th'))

  return (
    <div className="min-h-screen bg-gray-100">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .zone-page { page-break-after: always; box-shadow: none !important; margin: 0 !important; }
          .case-box { page-break-inside: avoid; }
          body { background: white !important; }
        }
        .zone-page { width: 210mm; margin: 12px auto; background: white; padding: 14mm; box-shadow: 0 1px 6px rgba(0,0,0,.15); }
      `}</style>

      <div className="no-print sticky top-0 z-10 flex items-center justify-between bg-white px-4 py-3 shadow">
        <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm text-ink-soft hover:text-ink">
          <ArrowLeft size={16} /> กลับ
        </button>
        <span className="text-sm text-ink-soft">ใบลงพื้นที่ {items.length} ราย · {groups.length} จังหวัด</span>
        <button
          onClick={() => window.print()}
          className="flex items-center gap-1 rounded-xl bg-salmon-deep px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
        >
          <Printer size={16} /> ปริ้น
        </button>
      </div>

      {items.length === 0 ? (
        <p className="mt-10 text-center text-ink-soft">ไม่มีข้อมูล — กลับไปเลือกที่หน้าส่งจดหมาย</p>
      ) : (
        <div className="py-4">
          {groups.map(([province, list]) => (
            <div key={province} className="zone-page text-ink">
              <div className="mb-3 border-b-2 border-ink pb-2">
                <h2 className="text-xl font-bold">โซน: จังหวัด{province}</h2>
                <p className="text-sm text-ink-soft">ลูกค้าลงพื้นที่ {list.length} ราย</p>
              </div>
              <div className="space-y-3">
                {list.map((it, i) => (
                  <div key={i} className="case-box rounded-xl border border-ink/30 p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-base font-bold">
                        {i + 1}. {it.customerName}
                      </span>
                      <span className="text-sm">
                        สัญญา {it.contractNo} · {it.shopName}
                      </span>
                    </div>
                    <p className="text-sm">
                      เครื่อง: {it.device || '—'} · โทร: {it.phones.length ? it.phones.join(' / ') : '—'}
                    </p>
                    <p className="text-sm font-semibold text-red-700">
                      ล่าช้า {it.daysLate} วัน · ค้างชำระ {baht(it.amount)} บาท
                    </p>
                    <div className="mt-1.5 space-y-0.5">
                      {it.addresses.map((a, j) => (
                        <p key={j} className="text-sm">
                          <span className="font-medium">• {a.label}:</span> {a.line}
                        </p>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
