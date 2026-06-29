import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { Badge, Loading, PageTitle } from '../components/ui'
import { ListPager, ListToolbar } from '../components/ManagedList'
import { CaseFrequencyChart } from '../components/CaseFrequencyChart'
import { baht, conditionLabel, statusLabel, thaiDate } from '../lib/format'
import { getAllStatuses, getContracts, getShops } from '../lib/db'
import { buildShopReport } from '../lib/report'
import { useAsync } from '../lib/useAsync'
import { useListControls } from '../lib/useListControls'
import type { Contract, ShopGrade, ShopReportRow } from '../lib/types'

const todayISO = new Date().toISOString().slice(0, 10)

const GRADE_STYLE: Record<ShopGrade, string> = {
  A: 'bg-green-100 text-green-700',
  B: 'bg-blue-100 text-blue-700',
  C: 'bg-amber-100 text-amber-700',
  E: 'bg-red-100 text-red-700',
  '-': 'bg-gray-100 text-gray-500',
}

function Stat({ label, value, tone = 'text-ink' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-peach bg-white px-4 py-3">
      <p className="text-xs text-ink-soft">{label}</p>
      <p className={`text-xl font-bold ${tone}`}>{value}</p>
    </div>
  )
}

export default function ShopDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const { data, loading } = useAsync(
    async () => {
      const [shops, contracts, statuses] = await Promise.all([
        getShops(),
        getContracts(),
        getAllStatuses(),
      ])
      const rows = buildShopReport(shops, contracts, statuses, todayISO)
      const row = rows.find((r) => r.shopId === id) ?? null
      const shop = shops.find((s) => s.id === id) ?? null
      const customers = contracts.filter((c) => c.shopId === id)
      return { row, shop, customers }
    },
    { row: null as ShopReportRow | null, shop: null as Awaited<ReturnType<typeof getShops>>[number] | null, customers: [] as Contract[] },
  )

  const customers = data.customers
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const dateFiltered = useMemo(
    () => customers.filter((x) => (!from || x.transactionDate >= from) && (!to || x.transactionDate <= to)),
    [customers, from, to],
  )
  const c = useListControls(dateFiltered, (x) => `${x.customerName} ${x.contractNo}`)

  if (loading) {
    return (
      <div>
        <PageTitle>รายละเอียดร้าน</PageTitle>
        <Loading />
      </div>
    )
  }

  if (!data.shop) {
    return (
      <div>
        <button onClick={() => navigate('/shop-report')} className="mb-3 inline-flex items-center gap-1 text-sm text-salmon-deep hover:underline">
          <ArrowLeft size={16} /> กลับรายงานร้านค้า
        </button>
        <p className="text-ink-soft">ไม่พบร้านค้านี้</p>
      </div>
    )
  }

  const { shop, row } = data

  return (
    <div>
      <button onClick={() => navigate('/shop-report')} className="mb-3 inline-flex items-center gap-1 text-sm text-salmon-deep hover:underline">
        <ArrowLeft size={16} /> กลับรายงานร้านค้า
      </button>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-ink">{shop.name}</h2>
          <p className="text-sm text-ink-soft">{shop.code} · {shop.bank} {shop.accountNo}</p>
        </div>
        {row && (
          <span className={`inline-flex h-10 w-10 items-center justify-center rounded-full text-lg font-bold ${GRADE_STYLE[row.grade]}`}>
            {row.grade}
          </span>
        )}
      </div>

      {/* ข้อมูลติดต่อ (ถ้ามี) */}
      {(shop.ownerName || shop.phone || shop.province || shop.address || shop.contactChannel || shop.facebookLink) && (
        <div className="mb-5 grid gap-x-6 gap-y-1.5 rounded-2xl border border-peach bg-cream-deep p-4 text-sm sm:grid-cols-2">
          {shop.ownerName && <p><span className="text-ink-soft">เจ้าของร้าน:</span> <span className="text-ink">{shop.ownerName}</span></p>}
          {shop.phone && <p><span className="text-ink-soft">เบอร์โทร:</span> <span className="text-ink">{shop.phone}</span></p>}
          {shop.province && <p><span className="text-ink-soft">จังหวัด:</span> <span className="text-ink">{shop.province}</span></p>}
          {shop.contactChannel && <p><span className="text-ink-soft">ช่องทางติดต่อ:</span> <span className="text-ink">{shop.contactChannel}</span></p>}
          {shop.address && <p className="sm:col-span-2"><span className="text-ink-soft">ที่อยู่:</span> <span className="text-ink">{shop.address}</span></p>}
          {shop.facebookLink && (
            <p className="truncate sm:col-span-2">
              <span className="text-ink-soft">เฟซบุ๊ก:</span>{' '}
              <a href={shop.facebookLink} target="_blank" rel="noreferrer" className="text-salmon-deep hover:underline">{shop.facebookLink}</a>
            </p>
          )}
        </div>
      )}

      {/* สถิติย่อ */}
      {row && (
        <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="จำนวนเคส" value={`${row.contracts}`} />
          <Stat label="ยอดขายรวม" value={baht(row.totalSales)} />
          <Stat label="ลูกค้าเสี่ยง (31วัน+)" value={`${row.risky}`} tone="text-red-600" />
          <Stat
            label="ส่งเคสล่าสุด"
            value={row.daysSinceActivity == null ? '—' : row.daysSinceActivity === 0 ? 'วันนี้' : `${row.daysSinceActivity} วันก่อน`}
            tone={row.active ? 'text-green-600' : 'text-red-600'}
          />
        </div>
      )}

      {/* กราฟความถี่การส่งเคสของร้านนี้ */}
      <div className="mb-5">
        <CaseFrequencyChart contracts={customers} />
      </div>

      {/* รายชื่อลูกค้าของร้าน */}
      <h3 className="mb-3 font-semibold text-ink">รายชื่อลูกค้า ({customers.length})</h3>

      {/* ตัวกรองช่วงวันที่ */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink-soft">ช่วงวันที่:</span>
        <button
          onClick={() => {
            setFrom('')
            setTo('')
          }}
          className={`rounded-lg border px-3 py-1.5 transition ${
            !from && !to
              ? 'border-salmon-deep bg-salmon-deep text-white'
              : 'border-peach bg-cream-deep text-ink hover:bg-peach-light'
          }`}
        >
          ทั้งหมด
        </button>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="rounded-lg border border-peach bg-cream-deep px-3 py-1.5 text-ink outline-none focus:border-salmon-deep"
        />
        <span className="text-ink-soft">ถึง</span>
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="rounded-lg border border-peach bg-cream-deep px-3 py-1.5 text-ink outline-none focus:border-salmon-deep"
        />
      </div>

      <ListToolbar controls={c} searchPlaceholder="ค้นหาลูกค้า (ชื่อ / เลขที่สัญญา)..." />
      {c.total === 0 ? (
        <p className="py-6 text-center text-sm text-ink-soft">
          {c.query ? 'ไม่พบลูกค้าที่ค้นหา' : from || to ? 'ไม่มีลูกค้าในช่วงวันที่เลือก' : 'ร้านนี้ยังไม่มีลูกค้า'}
        </p>
      ) : (
        <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="bg-peach-light text-left text-ink">
                {['วันที่', 'เลขที่สัญญา', 'ชื่อลูกค้า', 'สถานะ', 'รุ่น', 'ราคาเครื่อง', 'ชำระ/เดือน', 'สินค้า'].map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2.5 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {c.paged.map((x, i) => (
                <tr
                  key={x.id}
                  onClick={() => navigate(`/contract/${x.id}`)}
                  className={`cursor-pointer transition hover:bg-peach-light/60 ${i % 2 ? 'bg-white' : 'bg-cream-deep'}`}
                >
                  <td className="whitespace-nowrap px-3 py-2.5">{thaiDate(x.transactionDate)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 font-medium">{x.contractNo}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 font-medium text-salmon-deep">{x.customerName}</td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <Badge tone={x.status === 'active' ? 'green' : 'neutral'}>{statusLabel(x.status)}</Badge>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">{x.model}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right">{baht(x.devicePrice)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right">{baht(x.monthlyPayment)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5">{conditionLabel(x.condition)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ListPager controls={c} />
    </div>
  )
}
