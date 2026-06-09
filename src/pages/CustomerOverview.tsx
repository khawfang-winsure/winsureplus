import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, Clock, PackageX, ShieldAlert } from 'lucide-react'
import { Card, Loading, PageTitle } from '../components/ui'
import { ListPager, ListToolbar } from '../components/ManagedList'
import { LineChart } from '../components/LineChart'
import { getAllStatuses, getContracts, getShops } from '../lib/db'
import { yearsFromContracts } from '../lib/report'
import { thaiDate } from '../lib/format'
import {
  breakdownBy,
  BUCKETS,
  customerSummary,
  enrichCustomers,
  monthlyProblemTrend,
  overallBreakdown,
  type CustomerRow,
  type Dimension,
} from '../lib/customerReport'
import type { OverdueBucket } from '../lib/types'
import { useAsync } from '../lib/useAsync'
import { useListControls } from '../lib/useListControls'
import type { Contract } from '../lib/types'

const todayISO = new Date().toISOString().slice(0, 10)

const DIMS: { key: Dimension; label: string }[] = [
  { key: 'all', label: 'ทั้งหมด' },
  { key: 'occupation', label: 'อาชีพ' },
  { key: 'ageGroup', label: 'กลุ่มอายุ' },
  { key: 'model', label: 'รุ่นสินค้า' },
  { key: 'shop', label: 'ร้านค้า' },
  { key: 'promotion', label: 'โปรโมชั่น' },
  { key: 'term', label: 'ระยะผ่อน' },
  { key: 'down', label: 'เรทดาวน์' },
  { key: 'condition', label: 'สภาพเครื่อง' },
  { key: 'origin', label: 'แหล่งที่มา' },
]

// หัวคอลัมน์ + สีตามกลุ่มความล่าช้า
const BUCKET_HEAD: Record<OverdueBucket, string> = {
  normal: 'ปกติ',
  '1-10': '1-10',
  '11-30': '11-30',
  '31-60': '31-60',
  '61-90': '61-90',
  '91-120': '91-120',
  '120+': '120+',
}
const BUCKET_TONE: Record<OverdueBucket, string> = {
  normal: 'text-green-600',
  '1-10': 'text-amber-600',
  '11-30': 'text-amber-600',
  '31-60': 'text-amber-600',
  '61-90': 'text-red-600',
  '91-120': 'text-red-600',
  '120+': 'text-red-600',
}

function StatCard({
  icon,
  label,
  value,
  sub,
  tone,
  iconBg,
}: {
  icon: ReactNode
  label: string
  value: string | number
  sub?: string
  tone: string
  iconBg: string
}) {
  return (
    <Card className="flex items-center gap-3 py-4">
      <div className={`rounded-xl p-2.5 ${iconBg}`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-xs text-ink-soft">{label}</p>
        <p className={`text-2xl font-bold ${tone}`}>{value}</p>
        {sub && <p className="text-xs text-ink-soft">{sub}</p>}
      </div>
    </Card>
  )
}

export default function CustomerOverview() {
  const navigate = useNavigate()
  const { data, loading } = useAsync(
    async () => {
      const [contracts, statuses, shops] = await Promise.all([getContracts(), getAllStatuses(), getShops()])
      return { rows: enrichCustomers(contracts, statuses, shops, todayISO), contracts }
    },
    { rows: [] as CustomerRow[], contracts: [] as Contract[] },
  )

  const rows = data.rows
  const summary = useMemo(() => customerSummary(rows), [rows])

  const [dim, setDim] = useState<Dimension>('all')
  const breakdown = useMemo(
    () => (dim === 'all' ? [overallBreakdown(rows)] : breakdownBy(rows, dim)),
    [rows, dim],
  )

  const years = useMemo(() => yearsFromContracts(data.contracts), [data.contracts])
  const [yearSel, setYearSel] = useState<number | null>(null)
  const year = yearSel ?? years[0] ?? new Date().getFullYear()
  const trend = useMemo(() => monthlyProblemTrend(rows, year), [rows, year])

  const firstDefaults = useMemo(() => rows.filter((r) => r.firstDefault), [rows])
  const shopOptions = useMemo(() => {
    const m = new Map<string, string>()
    rows.forEach((r) => m.set(r.shopId, r.shopName))
    return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'th'))
  }, [rows])
  const [fdShop, setFdShop] = useState('')
  const [fdFrom, setFdFrom] = useState('')
  const [fdTo, setFdTo] = useState('')
  const fdFiltered = useMemo(
    () =>
      firstDefaults.filter(
        (r) =>
          (!fdShop || r.shopId === fdShop) &&
          (!fdFrom || (r.nextDue != null && r.nextDue >= fdFrom)) &&
          (!fdTo || (r.nextDue != null && r.nextDue <= fdTo)),
      ),
    [firstDefaults, fdShop, fdFrom, fdTo],
  )
  const fd = useListControls(fdFiltered, (r) => `${r.customerName} ${r.contractNo} ${r.shopName}`)

  const activeTotal = summary.active || 1
  const pct = (n: number) => ((n / activeTotal) * 100).toFixed(0)

  return (
    <div>
      <PageTitle sub="วิเคราะห์สถานะลูกค้า — หนี้เสีย = ค้างชำระ 60 วันขึ้นไป (ฝั่งลูกค้า)">ภาพรวมลูกค้า</PageTitle>

      {loading ? (
        <Loading />
      ) : (
        <>
          {/* ===== การ์ดสถานะ ===== */}
          <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <StatCard icon={<CheckCircle2 size={22} className="text-green-600" />} iconBg="bg-green-100" label="ปกติ" value={summary.normal} sub={`${pct(summary.normal)}% ของที่ผ่อนอยู่`} tone="text-green-600" />
            <StatCard icon={<Clock size={22} className="text-amber-600" />} iconBg="bg-amber-100" label="ล่าช้า (1-59 วัน)" value={summary.late} sub={`${pct(summary.late)}%`} tone="text-amber-600" />
            <StatCard icon={<AlertTriangle size={22} className="text-red-600" />} iconBg="bg-red-100" label="หนี้เสีย (60 วัน+)" value={summary.bad} sub={`${pct(summary.bad)}%`} tone="text-red-600" />
            <StatCard icon={<ShieldAlert size={22} className="text-red-500" />} iconBg="bg-red-100" label="ไม่จ่ายตั้งแต่งวดแรก" value={summary.firstDefault} sub="ดูรายการด้านล่าง" tone="text-red-600" />
            <StatCard icon={<PackageX size={22} className="text-ink-soft" />} iconBg="bg-peach-light" label="ปิด/จบสัญญา" value={summary.closed} sub={`ทั้งหมด ${summary.total} สัญญา`} tone="text-ink" />
          </div>

          {/* ===== สัดส่วนลูกค้าที่ผ่อนอยู่ ===== */}
          {summary.active > 0 && (
            <Card className="mb-5">
              <h3 className="mb-3 font-semibold text-ink">สัดส่วนลูกค้าที่กำลังผ่อน ({summary.active} ราย)</h3>
              <div className="flex h-7 w-full overflow-hidden rounded-lg">
                <div className="bg-green-500" style={{ width: `${pct(summary.normal)}%` }} title={`ปกติ ${summary.normal}`} />
                <div className="bg-amber-400" style={{ width: `${pct(summary.late)}%` }} title={`ล่าช้า ${summary.late}`} />
                <div className="bg-red-500" style={{ width: `${pct(summary.bad)}%` }} title={`หนี้เสีย ${summary.bad}`} />
              </div>
              <div className="mt-2 flex flex-wrap gap-4 text-xs text-ink-soft">
                <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-green-500" /> ปกติ {summary.normal}</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-amber-400" /> ล่าช้า {summary.late}</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-red-500" /> หนี้เสีย {summary.bad}</span>
              </div>
            </Card>
          )}

          {/* ===== แนวโน้มรายเดือน ===== */}
          <Card className="mb-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold text-ink">แนวโน้มรายเดือน — เริ่มล่าช้า / กลายเป็นหนี้เสีย</h3>
              <select
                value={year}
                onChange={(e) => setYearSel(Number(e.target.value))}
                className="rounded-lg border border-peach bg-cream-deep px-2.5 py-1.5 text-sm text-ink outline-none focus:border-salmon-deep"
              >
                {(years.length ? years : [year]).map((y) => (
                  <option key={y} value={y}>ปี {y + 543}</option>
                ))}
              </select>
            </div>
            <LineChart
              labels={trend.map((m) => m.label)}
              series={[
                { name: 'เริ่มล่าช้า', color: '#f59e0b', values: trend.map((m) => m.newLate), fill: true },
                { name: 'กลายเป็นหนี้เสีย', color: '#dc2626', values: trend.map((m) => m.newBad) },
              ]}
              valueSuffix=" ราย"
            />
            <p className="mt-2 text-xs text-ink-soft">
              ประมาณการจากวันครบกำหนดของงวดค้างเก่าสุด · นับเฉพาะลูกค้าที่ตอนนี้ยังเป็นปัญหาอยู่
            </p>
          </Card>

          {/* ===== แยกตามมิติ ===== */}
          <Card className="mb-5">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h3 className="font-semibold text-ink">สรุปลูกค้าตามกลุ่มความล่าช้า</h3>
              <span className="text-sm text-ink-soft">แยกตาม:</span>
              <select
                value={dim}
                onChange={(e) => setDim(e.target.value as Dimension)}
                className="rounded-lg border border-peach bg-cream-deep px-3 py-1.5 text-sm text-ink outline-none focus:border-salmon-deep"
              >
                {DIMS.map((d) => (
                  <option key={d.key} value={d.key}>{d.label}</option>
                ))}
              </select>
            </div>
            {breakdown.length === 0 ? (
              <p className="py-4 text-center text-sm text-ink-soft">ไม่มีข้อมูล</p>
            ) : (
              <div className="scrollbar-thin overflow-x-auto rounded-xl border border-peach">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="bg-peach-light text-left text-ink">
                      <th className="whitespace-nowrap px-3 py-2.5 font-semibold">กลุ่ม</th>
                      <th className="px-3 py-2.5 text-center font-semibold">ทั้งหมด</th>
                      {BUCKETS.map((bk) => (
                        <th key={bk} className="whitespace-nowrap px-3 py-2.5 text-center font-semibold">{BUCKET_HEAD[bk]}</th>
                      ))}
                      <th className="px-3 py-2.5 text-center font-semibold">% เสี่ยง</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdown.map((b, i) => (
                      <tr key={b.group} className={i % 2 ? 'bg-white' : 'bg-cream-deep'}>
                        <td className="px-3 py-2.5 font-medium text-ink">{b.group}</td>
                        <td className="px-3 py-2.5 text-center font-medium">{b.total}</td>
                        {BUCKETS.map((bk) => (
                          <td key={bk} className={`px-3 py-2.5 text-center ${b.counts[bk] ? BUCKET_TONE[bk] : 'text-ink-soft'}`}>
                            {b.counts[bk] || '·'}
                          </td>
                        ))}
                        <td className="px-3 py-2.5 text-center font-semibold text-red-600">{b.badRate.toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* ===== เคสไม่จ่ายตั้งแต่งวดแรก ===== */}
          <h3 className="mb-1 font-semibold text-ink">เคสไม่จ่ายตั้งแต่งวดแรก ({firstDefaults.length})</h3>
          <p className="mb-3 text-xs text-ink-soft">ลูกค้าที่ยังไม่เคยจ่ายงวดใดเลยและเลยกำหนดแล้ว — ใช้สรุป/พิจารณาหักค่าคอมฯ ในอนาคต</p>
          {firstDefaults.length === 0 ? (
            <p className="rounded-2xl border border-peach bg-cream-deep py-6 text-center text-sm text-ink-soft">ไม่มีเคสไม่จ่ายงวดแรก 🎉</p>
          ) : (
            <>
              {/* ตัวกรอง: ร้านค้า + ช่วงวันครบกำหนด */}
              <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                <select
                  value={fdShop}
                  onChange={(e) => setFdShop(e.target.value)}
                  className="rounded-lg border border-peach bg-cream-deep px-3 py-1.5 text-ink outline-none focus:border-salmon-deep"
                >
                  <option value="">ทุกร้าน</option>
                  {shopOptions.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <span className="text-ink-soft">วันครบกำหนด:</span>
                <input type="date" value={fdFrom} onChange={(e) => setFdFrom(e.target.value)} className="rounded-lg border border-peach bg-cream-deep px-3 py-1.5 text-ink outline-none focus:border-salmon-deep" />
                <span className="text-ink-soft">ถึง</span>
                <input type="date" value={fdTo} onChange={(e) => setFdTo(e.target.value)} className="rounded-lg border border-peach bg-cream-deep px-3 py-1.5 text-ink outline-none focus:border-salmon-deep" />
                {(fdShop || fdFrom || fdTo) && (
                  <button onClick={() => { setFdShop(''); setFdFrom(''); setFdTo('') }} className="rounded-lg border border-peach px-3 py-1.5 text-ink hover:bg-peach-light">ล้างตัวกรอง</button>
                )}
              </div>
              <ListToolbar controls={fd} searchPlaceholder="ค้นหา (ชื่อ / สัญญา / ร้าน)..." />
              {fd.total === 0 ? (
                <p className="rounded-2xl border border-peach bg-cream-deep py-6 text-center text-sm text-ink-soft">ไม่พบเคสตามเงื่อนไข</p>
              ) : (
                <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="bg-peach-light text-left text-ink">
                        {['ชื่อลูกค้า', 'เลขที่สัญญา', 'ร้านค้า', 'วันครบกำหนด', 'ค้างมาแล้ว'].map((h) => (
                          <th key={h} className="whitespace-nowrap px-3 py-2.5 font-semibold">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {fd.paged.map((r, i) => (
                        <tr
                          key={r.contractId}
                          onClick={() => navigate(`/contract/${r.contractId}`)}
                          className={`cursor-pointer transition hover:bg-peach-light/60 ${i % 2 ? 'bg-white' : 'bg-cream-deep'}`}
                        >
                          <td className="px-3 py-2.5 font-medium text-salmon-deep">{r.customerName}</td>
                          <td className="whitespace-nowrap px-3 py-2.5">{r.contractNo}</td>
                          <td className="px-3 py-2.5">{r.shopName}</td>
                          <td className="whitespace-nowrap px-3 py-2.5">{r.nextDue ? thaiDate(r.nextDue) : '-'}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 font-medium text-red-600">{r.daysLate} วัน</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <ListPager controls={fd} />
            </>
          )}
        </>
      )}
    </div>
  )
}
