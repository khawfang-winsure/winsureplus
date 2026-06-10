import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarRange } from 'lucide-react'
import { Badge, Card, Loading, PageTitle } from '../components/ui'
import { baht } from '../lib/format'
import { getAllExtensions, type ExtensionRecord } from '../lib/db'
import { EXT_TYPE_LABEL } from './ContractDetail'

/** เวลาไทยแบบสั้น (วัน/เดือน/ปี เวลา) */
function thaiDateTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const time = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
  return `${dd}/${mm}/${d.getFullYear()} ${time}`
}

export default function ExtendedContracts() {
  const [rows, setRows] = useState<ExtensionRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getAllExtensions()
      .then(setRows)
      .finally(() => setLoading(false))
  }, [])

  // จำนวนสัญญา (ไม่ซ้ำ) ที่เคยขยาย
  const uniqueContracts = new Set(rows.map((r) => r.contractId)).size

  if (loading) {
    return (
      <div>
        <PageTitle>ลูกค้าขยายระยะเวลา</PageTitle>
        <Loading />
      </div>
    )
  }

  return (
    <div>
      <PageTitle>ลูกค้าขยายระยะเวลา</PageTitle>
      <p className="mb-4 text-sm text-ink-soft">
        ประวัติการขยายระยะเวลาทั้งหมด <b className="text-ink">{rows.length}</b> ครั้ง · จาก{' '}
        <b className="text-ink">{uniqueContracts}</b> สัญญา (ใหม่ → เก่า)
      </p>

      {rows.length === 0 ? (
        <Card className="py-10 text-center text-ink-soft">
          <CalendarRange className="mx-auto mb-2 opacity-40" size={28} />
          ยังไม่มีลูกค้าที่ขยายระยะเวลา
        </Card>
      ) : (
        <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
          <table className="w-full min-w-[920px] text-sm">
            <thead>
              <tr className="bg-peach-light text-left text-ink">
                {['เวลา', 'ลูกค้า', 'สัญญา', 'ประเภท', 'วันชำระ', 'ค่างวด', 'จำนวนงวด', 'ยอดจัดไฟแนนซ์', 'ผู้ทำ', 'หมายเหตุ'].map((h) => (
                  <th key={h} className="px-3 py-2.5 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((e, idx) => (
                <tr key={e.id} className={idx % 2 ? 'bg-white' : 'bg-peach-light/20'}>
                  <td className="px-3 py-2.5 whitespace-nowrap">{thaiDateTime(e.createdAt)}</td>
                  <td className="px-3 py-2.5">
                    <Link to={`/contract/${e.contractId}`} className="font-medium text-salmon-deep hover:underline">
                      {e.customerName || '—'}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">{e.contractNo || '—'}</td>
                  <td className="px-3 py-2.5"><Badge tone="amber">{EXT_TYPE_LABEL[e.extType]}</Badge></td>
                  <td className="px-3 py-2.5 whitespace-nowrap">{e.oldDueDay} → {e.newDueDay}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap">{baht(e.oldMonthly ?? 0)} → {baht(e.newMonthly ?? 0)}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    {e.oldTerm} → {e.newTerm} <span className="text-ink-soft">(+{e.newInstallments})</span>
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">{baht(e.oldFinance ?? 0)} → {baht(e.newFinance ?? 0)}</td>
                  <td className="px-3 py-2.5">{e.recordedByName || '—'}</td>
                  <td className="px-3 py-2.5 text-ink-soft">{e.note || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
