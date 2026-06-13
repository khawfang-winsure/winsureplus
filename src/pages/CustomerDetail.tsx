import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { User, Phone, CreditCard, ChevronRight } from 'lucide-react'
import { Badge, Card, EmptyState, Loading, PageTitle } from '../components/ui'
import { baht, maskNationalId, statusLabel } from '../lib/format'
import { getCustomerAggregate, type CustomerAggregate, type CustomerContractItem } from '../lib/db'

// ป้ายสถานะที่ใช้ bucket inline จาก CustomerContractItem (ไม่ใช่ ContractStatusRow)
function ContractStatusPill({ item }: { item: CustomerContractItem }) {
  if (item.status !== 'active') {
    return <Badge tone="neutral">{statusLabel(item.status)}</Badge>
  }
  if (item.bucket === '91-120' || item.bucket === '120+') {
    return <Badge tone="red">หนี้เสีย</Badge>
  }
  if (item.bucket !== 'normal') {
    return <Badge tone="amber">ล่าช้า {item.daysLate} วัน</Badge>
  }
  return <Badge tone="green">ผ่อนปกติ</Badge>
}

// Card แสดงสัญญา 1 รายการ
function ContractRow({ item }: { item: CustomerContractItem }) {
  const progress = `${item.paidInstallments}/${item.termMonths}`
  return (
    <div className="rounded-xl border border-peach bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink">{item.contractNo}</span>
            <ContractStatusPill item={item} />
          </div>
          <p className="mt-0.5 text-sm text-ink-soft">
            {item.deviceModel || '—'}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-soft">
            {item.shopName && <span>ร้าน: {item.shopName}</span>}
            <span>งวด {progress}</span>
            {item.monthlyPayment > 0 && (
              <span>{baht(item.monthlyPayment)} ฿/เดือน</span>
            )}
            {item.status === 'active' && item.outstanding > 0 && (
              <span className="text-red-600">ค้างอยู่ {baht(item.outstanding)} ฿</span>
            )}
          </div>
        </div>
        <Link
          to={`/contract/${item.contractId}`}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-peach px-2.5 py-1.5 text-xs text-ink-soft hover:bg-peach-light"
        >
          ดูรายละเอียด
          <ChevronRight size={13} />
        </Link>
      </div>
    </div>
  )
}

export default function CustomerDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [agg, setAgg] = useState<CustomerAggregate | null | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) {
      navigate('/customers', { replace: true })
      return
    }
    let active = true
    setLoading(true)
    setError(null)
    getCustomerAggregate(id)
      .then((result) => {
        if (active) setAgg(result)
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [id, navigate])

  if (loading) return <Loading />

  if (error) {
    return (
      <EmptyState
        title="โหลดข้อมูลไม่สำเร็จ"
        hint={error}
      />
    )
  }

  // null = mock mode หรือหาไม่พบ contract
  if (agg === null || agg === undefined) {
    return (
      <EmptyState
        title="ไม่พบข้อมูลลูกค้า"
        hint="ลองตรวจสอบเลขสัญญา หรือกลับไปที่รายการลูกค้า"
      />
    )
  }

  const altPhones = [agg.phoneAlt1, agg.phoneAlt2].filter((p): p is string => !!p)

  return (
    <div className="space-y-5">
      <PageTitle sub="ดูทุกสัญญาของลูกค้าคนนี้" count={{ shown: agg.totalContracts }}>
        <User size={20} className="mr-2 inline-block align-text-bottom" />
        {agg.customerName}
      </PageTitle>

      {/* Card: ข้อมูลลูกค้า */}
      <Card>
        <h3 className="mb-3 text-sm font-semibold text-ink">ข้อมูลลูกค้า</h3>
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2 text-ink">
            <CreditCard size={14} className="shrink-0 text-ink-soft" />
            <span className="text-ink-soft">บัตรประชาชน:</span>
            <span className="font-medium tabular-nums">
              {maskNationalId(agg.nationalId ?? undefined)}
            </span>
          </div>
          <div className="flex items-center gap-2 text-ink">
            <Phone size={14} className="shrink-0 text-ink-soft" />
            <span className="text-ink-soft">เบอร์โทร:</span>
            <span className="font-medium">{agg.phone ?? '—'}</span>
          </div>
          {altPhones.map((p, i) => (
            <div key={p} className="flex items-center gap-2 text-ink">
              <Phone size={14} className="shrink-0 text-ink-soft opacity-0" />
              <span className="text-ink-soft">เบอร์สำรอง {i + 1}:</span>
              <span className="font-medium">{p}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Card: สรุปรวม */}
      <Card>
        <h3 className="mb-3 text-sm font-semibold text-ink">สรุป</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatBox label="สัญญาทั้งหมด" value={String(agg.totalContracts)} />
          <StatBox label="ที่ผ่อนอยู่" value={String(agg.activeContracts)} highlight={agg.activeContracts > 0} />
          <StatBox label="ปิดแล้ว" value={String(agg.closedContracts)} />
          <StatBox
            label="ยอดค้างรวม"
            value={agg.totalOutstanding > 0 ? `${baht(agg.totalOutstanding)} ฿` : '—'}
            highlight={agg.totalOutstanding > 0}
            red
          />
          <StatBox
            label="ค่าปรับสะสม"
            value={agg.totalPenalty > 0 ? `${baht(agg.totalPenalty)} ฿` : '—'}
            red={agg.totalPenalty > 0}
          />
        </div>
      </Card>

      {/* List: รายการสัญญา */}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-ink">
          รายการสัญญาทั้งหมด ({agg.totalContracts})
        </h3>
        {agg.contracts.length === 0 ? (
          <EmptyState title="ยังไม่มีสัญญาในระบบ" />
        ) : (
          <div className="space-y-3">
            {agg.contracts.map((item) => (
              <ContractRow key={item.contractId} item={item} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function StatBox({
  label,
  value,
  highlight = false,
  red = false,
}: {
  label: string
  value: string
  highlight?: boolean
  red?: boolean
}) {
  return (
    <div className="rounded-xl border border-peach bg-peach-light/30 p-3 text-center">
      <p className="text-xs text-ink-soft">{label}</p>
      <p
        className={`mt-1 text-lg font-bold tabular-nums ${
          red ? 'text-red-600' : highlight ? 'text-salmon-deep' : 'text-ink'
        }`}
      >
        {value}
      </p>
    </div>
  )
}
