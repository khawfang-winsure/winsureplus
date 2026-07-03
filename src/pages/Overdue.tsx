import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Badge, EmptyState, Loading, PageTitle } from '../components/ui'
import { baht } from '../lib/format'
import { getOverdueByBucket } from '../lib/db'
import { useFilter } from '../lib/useFilter'
import type { ContractStatusRow, OverdueBucket } from '../lib/types'
import Pagination from '../components/Pagination'

const LABELS: Record<OverdueBucket, string> = {
  normal: 'ปกติ (ยังไม่ครบกำหนด)',
  '1-10': 'ล่าช้า 1-10 วัน',
  '11-30': 'ล่าช้า 11-30 วัน',
  '31-60': 'ล่าช้า 31-60 วัน',
  '61-90': 'ล่าช้า 61-90 วัน',
  '91-120': 'ล่าช้า 91-120 วัน',
  '120+': 'ล่าช้า 120 วันขึ้นไป',
}

// แท็บสลับช่วงในหน้า — ไม่รวม 'normal' (กลุ่มนี้เข้าถึงผ่านลิงก์ล่าช้าเท่านั้น จึงโชว์เฉพาะช่วงล่าช้าจริง)
const TAB_BUCKETS: OverdueBucket[] = ['1-10', '11-30', '31-60', '61-90', '91-120', '120+']
const TAB_LABELS: Record<OverdueBucket, string> = {
  normal: 'ปกติ',
  '1-10': '1-10 วัน',
  '11-30': '11-30 วัน',
  '31-60': '31-60 วัน',
  '61-90': '61-90 วัน',
  '91-120': '91-120 วัน',
  '120+': '120 วันขึ้นไป',
}

const DEFAULT_BUCKET: OverdueBucket = '31-60'

function isOverdueBucket(v: string | undefined): v is OverdueBucket {
  return !!v && v in LABELS
}

export default function Overdue() {
  const { bucket: urlBucket } = useParams()
  const navigate = useNavigate()

  // จำช่วงล่าสุดที่เลือกไว้ใน localStorage (pattern เดียวกับ useFilter ที่ใช้ทั่วเว็บ)
  const [lastBucket, setLastBucket] = useFilter<OverdueBucket>('overdue.lastBucket', DEFAULT_BUCKET)

  // '/overdue/last' = ลิงก์เมนู ไม่ใช่ bucket จริง → เด้งไปช่วงที่จำไว้ล่าสุดทันที
  // ส่วน '/overdue/<bucket จริง>' (bookmark เดิม) ยังเข้าตรงได้ปกติ + อัปเดตค่าที่จำไว้ตามนั้น
  useEffect(() => {
    if (urlBucket === 'last') {
      navigate(`/overdue/${lastBucket}`, { replace: true })
      return
    }
    if (isOverdueBucket(urlBucket) && urlBucket !== lastBucket) {
      setLastBucket(urlBucket)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlBucket])

  const bucket: OverdueBucket = isOverdueBucket(urlBucket) ? urlBucket : DEFAULT_BUCKET
  const label = LABELS[bucket]

  const [rows, setRows] = useState<ContractStatusRow[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)

  const load = useCallback(async () => {
    setLoading(true)
    setRows(await getOverdueByBucket(bucket))
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

      {/* แท็บสลับช่วงล่าช้า — เปลี่ยน URL + จำไว้ใน localStorage สำหรับครั้งถัดไป */}
      <div className="mb-4 flex flex-wrap gap-2">
        {TAB_BUCKETS.map((b) => (
          <button
            key={b}
            type="button"
            onClick={() => navigate(`/overdue/${b}`)}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
              bucket === b
                ? 'bg-salmon-deep text-white'
                : 'border border-peach bg-white text-ink-soft hover:bg-peach-light'
            }`}
          >
            {TAB_LABELS[b]}
          </button>
        ))}
      </div>

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
