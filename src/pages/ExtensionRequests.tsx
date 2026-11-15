import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { Badge, Card, EmptyState, Loading, PageTitle } from '../components/ui'
import { listExtensionRequests, type ExtensionRequestRow } from '../lib/db'
import { useAsync } from '../lib/useAsync'

const EXT_TYPE_LABEL: Record<string, string> = {
  months: 'ขยายจำนวนงวด',
  due_day: 'เปลี่ยนวันชำระ',
  both: 'เปลี่ยนวันชำระและขยายจำนวนงวด',
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const time = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
  return `${dd}/${mm}/${d.getFullYear()} ${time}`
}

function formatDateOnly(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
}

function daysSince(iso: string): number {
  const t = new Date(iso).getTime()
  if (isNaN(t)) return 0
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000))
}

type Tab = 'pending' | 'decided'

function RequestCard({ r }: { r: ExtensionRequestRow }) {
  const waiting = r.status === 'pending'
  const days = daysSince(r.recordedAt)
  const tone = r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : 'amber'
  const statusText = r.status === 'approved' ? 'อนุมัติแล้ว' : r.status === 'rejected' ? 'ไม่อนุมัติ' : 'รอพิจารณา'
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold text-ink">{r.customerName ?? '-'}</span>
            <Badge tone={tone}>{statusText}</Badge>
            {waiting && days >= 3 && <Badge tone="red">ค้างนาน</Badge>}
          </div>
          <div className="mt-1 text-sm text-ink-soft">
            INV {r.invNo ?? '-'} · สัญญา {r.contractNo ?? '-'}
          </div>
        </div>
        <Link
          to={`/contract/${r.contractId}`}
          className="inline-flex min-h-11 items-center gap-1 rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-white"
        >
          เปิดสัญญา
          <ChevronRight size={16} aria-hidden />
        </Link>
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div>
          <dt className="inline text-ink-soft">ประเภท: </dt>
          <dd className="inline text-ink">{r.extType ? (EXT_TYPE_LABEL[r.extType] ?? r.extType) : '-'}</dd>
        </div>
        <div>
          <dt className="inline text-ink-soft">ลูกค้าขอเมื่อ: </dt>
          <dd className="inline text-ink">{formatDateOnly(r.customerRequestedAt)}</dd>
        </div>
        <div>
          <dt className="inline text-ink-soft">ผู้ส่งคำขอ: </dt>
          <dd className="inline text-ink">{r.recordedByName ?? '-'}</dd>
        </div>
        <div>
          <dt className="inline text-ink-soft">ส่งเมื่อ: </dt>
          <dd className="inline text-ink">
            {formatDateTime(r.recordedAt)}
            {waiting && <span className="text-ink-soft"> (ส่งมาแล้ว {days} วัน)</span>}
          </dd>
        </div>
        {!waiting && (
          <div className="sm:col-span-2">
            <dt className="inline text-ink-soft">ตัดสินโดย: </dt>
            <dd className="inline text-ink">
              {r.decidedByName ?? '-'} · {formatDateTime(r.decidedAt)}
            </dd>
          </div>
        )}
      </dl>
      {r.reason && <p className="mt-2 text-sm text-ink-soft">เหตุผล: {r.reason}</p>}
    </Card>
  )
}

export default function ExtensionRequests() {
  const { data, loading, error } = useAsync<ExtensionRequestRow[]>(() => listExtensionRequests(30), [])
  const [tab, setTab] = useState<Tab>('pending')

  const pending = useMemo(() => data.filter((r) => r.status === 'pending'), [data])
  const decided = useMemo(() => data.filter((r) => r.status !== 'pending'), [data])
  const rows = tab === 'pending' ? pending : decided

  const tabCls = (active: boolean) =>
    `min-h-11 rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
      active ? 'bg-ink text-white' : 'bg-peach-light text-ink-soft'
    }`

  return (
    <div className="flex flex-col gap-4">
      <PageTitle sub="คำขอขยาย/เปลี่ยนวันชำระย้อนหลังที่พนักงานส่งมา — เปิดสัญญาเพื่ออนุมัติหรือไม่อนุมัติ">
        คำขอรออนุมัติ
      </PageTitle>

      <div className="flex flex-wrap gap-2">
        <button type="button" className={tabCls(tab === 'pending')} onClick={() => setTab('pending')}>
          รอพิจารณา ({pending.length})
        </button>
        <button type="button" className={tabCls(tab === 'decided')} onClick={() => setTab('decided')}>
          ตัดสินแล้ว 30 วันล่าสุด ({decided.length})
        </button>
      </div>

      {loading ? (
        <Loading />
      ) : error ? (
        <Card>
          <p className="text-sm text-red-700">โหลดข้อมูลไม่สำเร็จ: {error}</p>
        </Card>
      ) : rows.length === 0 ? (
        <EmptyState title={tab === 'pending' ? 'ไม่มีคำขอที่รออนุมัติ' : 'ไม่มีคำขอที่ตัดสินใน 30 วันล่าสุด'} />
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((r) => (
            <RequestCard key={r.id} r={r} />
          ))}
        </div>
      )}
    </div>
  )
}
