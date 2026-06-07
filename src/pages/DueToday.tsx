import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge, EmptyState, Loading, PageTitle } from '../components/ui'
import { thaiDate } from '../lib/format'
import { getDueSoon } from '../lib/db'
import type { ContractStatusRow } from '../lib/types'

const todayISO = new Date().toISOString().slice(0, 10)

export default function DueToday() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<ContractStatusRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getDueSoon()
      .then(setRows)
      .finally(() => setLoading(false))
  }, [])

  return (
    <div>
      <PageTitle sub="ลูกค้าที่ถึง/ใกล้วันครบกำหนดชำระ (ภายใน 7 วันข้างหน้า)">ลูกค้าถึงวันครบกำหนด</PageTitle>
      {loading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="ยังไม่มีลูกค้าที่ใกล้ครบกำหนด" />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li
              key={r.contractId}
              onClick={() => navigate(`/contract/${r.contractId}`)}
              className="flex cursor-pointer items-center justify-between rounded-xl border border-peach bg-white px-4 py-3 hover:bg-peach-light/30"
            >
              <div>
                <p className="font-medium text-ink">{r.customerName} — {r.contractNo}</p>
                <p className="text-sm text-ink-soft">{r.shopName}</p>
              </div>
              <Badge tone={r.nextDue === todayISO ? 'red' : 'amber'}>
                ครบ {r.nextDue ? thaiDate(r.nextDue) : '-'}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
