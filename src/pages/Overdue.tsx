import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Badge, EmptyState, Loading, PageTitle } from '../components/ui'
import { baht } from '../lib/format'
import { getOverdueByBucket } from '../lib/db'
import type { ContractStatusRow, OverdueBucket } from '../lib/types'
import Pagination from '../components/Pagination'

const LABELS: Record<string, string> = {
  '1-10': 'ล่าช้า 1-10 วัน',
  '11-30': 'ล่าช้า 11-30 วัน',
  '31-60': 'ล่าช้า 31-60 วัน',
  '61-90': 'ล่าช้า 61-90 วัน',
  '91-120': 'ล่าช้า 91-120 วัน',
  '120+': 'ล่าช้า 120 วันขึ้นไป',
}

export default function Overdue() {
  const { bucket } = useParams()
  const navigate = useNavigate()
  const label = LABELS[bucket ?? ''] ?? 'ลูกค้าล่าช้า'

  const [rows, setRows] = useState<ContractStatusRow[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)

  const load = useCallback(async () => {
    setLoading(true)
    setRows(await getOverdueByBucket((bucket ?? '1-10') as OverdueBucket))
    setLoading(false)
  }, [bucket])

  useEffect(() => {
    load()
  }, [load])

  // reset page เมื่อเปลี่ยน bucket
  useEffect(() => { setPage(1) }, [bucket])

  const pagedRows = useMemo(
    () => rows.slice((page - 1) * pageSize, page * pageSize),
    [rows, page, pageSize],
  )

  return (
    <div>
      <PageTitle sub="กลุ่มนี้คำนวณอัตโนมัติจากจำนวนวันเลยกำหนด (อัปเดตทุกวันโดยระบบ)" count={loading ? undefined : { shown: rows.length }}>{label}</PageTitle>
      {loading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="ไม่มีลูกค้าในกลุ่มนี้" hint="ลูกค้าจะถูกจัดเข้ากลุ่มเองตามจำนวนวันที่ค้างชำระ" />
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {pagedRows.map((r) => (
              <li
                key={r.contractId}
                onClick={() => navigate(`/contract/${r.contractId}`)}
                className="flex cursor-pointer items-center justify-between rounded-xl border border-peach bg-white px-4 py-3 hover:bg-peach-light/30"
              >
                <div>
                  <p className="font-medium text-ink">{r.customerName} — {r.contractNo}</p>
                  <p className="text-sm text-ink-soft">{r.shopName} · ค้าง {r.remainingInstallments} งวด</p>
                </div>
                <div className="text-right">
                  <Badge tone="red">ล่าช้า {r.daysLate} วัน</Badge>
                  {r.penaltyDue > 0 && <p className="mt-1 text-sm text-ink-soft whitespace-nowrap">ค่าปรับ {baht(r.penaltyDue)} ฿</p>}
                </div>
              </li>
            ))}
          </ul>
          <Pagination
            total={rows.length}
            page={page}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
          />
        </>
      )}
    </div>
  )
}
