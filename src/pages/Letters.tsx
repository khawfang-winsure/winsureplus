import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge, EmptyState, Loading, PageTitle } from '../components/ui'
import { baht } from '../lib/format'
import { getOverdueByBucket } from '../lib/db'
import type { ContractStatusRow, OverdueBucket } from '../lib/types'

// ลูกค้าล่าช้าหนัก (31 วันขึ้นไป) = ตัวเลือกสำหรับออกจดหมายติดตาม
const SERIOUS: OverdueBucket[] = ['31-60', '61-90', '91-120', '120+']

export default function Letters() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<ContractStatusRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all(SERIOUS.map((b) => getOverdueByBucket(b)))
      .then((lists) => setRows(lists.flat().sort((a, b) => b.daysLate - a.daysLate)))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div>
      <PageTitle sub="รายชื่อลูกค้าล่าช้า 31 วันขึ้นไป — ตัวเลือกสำหรับออกจดหมายติดตามหนี้">
        ส่งจดหมาย
      </PageTitle>
      {loading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="ยังไม่มีลูกค้าล่าช้าหนัก" hint="รายชื่อจะขึ้นเมื่อมีลูกค้าค้างชำระเกิน 30 วัน" />
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
                <p className="text-sm text-ink-soft">{r.shopName} · ค่าปรับค้าง {baht(r.penaltyDue)} ฿</p>
              </div>
              <Badge tone="red">ล่าช้า {r.daysLate} วัน</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
