import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Award, Activity, Moon, Store } from 'lucide-react'
import { Card, Loading, PageTitle } from '../components/ui'
import { ListPager, ListToolbar } from '../components/ManagedList'
import { LineChart } from '../components/LineChart'
import { DateRangePicker, loadStoredRange, type DateRange } from '../components/DateRangePicker'
import { baht } from '../lib/format'
import { getAllStatuses, getContracts, getShops } from '../lib/db'
import {
  buildShopReport,
  monthlyShopActivity,
  shopReportSummary,
  topShopsByCases,
  yearsFromContracts,
} from '../lib/report'
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

function GradeBadge({ grade }: { grade: ShopGrade }) {
  return (
    <span className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-base font-bold ${GRADE_STYLE[grade]}`}>
      {grade}
    </span>
  )
}

function ActivityBadge({ row }: { row: ShopReportRow }) {
  if (row.contracts === 0)
    return <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-500">ยังไม่มีเคส</span>
  if (row.active)
    return <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700">เคลื่อนไหว</span>
  return <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700">เงียบ {row.daysSinceActivity} วัน</span>
}

export default function ShopReport() {
  const navigate = useNavigate()
  const [range, setRange] = useState<DateRange | null>(() => loadStoredRange('shopReport.dateRange'))
  const { data, loading } = useAsync(
    async () => {
      const [shops, contracts, statuses] = await Promise.all([
        getShops(),
        getContracts(),
        getAllStatuses(),
      ])
      return { shops, contracts, statuses }
    },
    { shops: [] as Awaited<ReturnType<typeof getShops>>, contracts: [] as Contract[], statuses: [] as Awaited<ReturnType<typeof getAllStatuses>> },
  )

  // กรองสัญญาตามช่วงวันที่ (transactionDate) ก่อนนำไปคำนวณรายงาน
  const filteredContracts = useMemo(() => {
    if (!range) return data.contracts
    return data.contracts.filter((c) => c.transactionDate >= range.start && c.transactionDate <= range.end)
  }, [data.contracts, range])

  const rows = useMemo<ShopReportRow[]>(
    () => buildShopReport(data.shops, filteredContracts, data.statuses, todayISO),
    [data.shops, filteredContracts, data.statuses],
  )
  const summary = useMemo(() => shopReportSummary(rows), [rows])
  const topShops = useMemo(() => topShopsByCases(rows, 10), [rows])
  const maxCases = topShops[0]?.contracts ?? 0
  const top5Shops = useMemo(
    () => topShopsByCases(rows, 5).filter((r) => r.contracts > 0),
    [rows],
  )
  const top5Max = top5Shops[0]?.contracts ?? 0

  // ป้ายช่วงวันที่สำหรับการ์ด Top 5 — แปลงเป็น พ.ศ.
  const rangeChipText = useMemo(() => {
    if (!range) return 'ทั้งหมด'
    const fmt = (iso: string) => {
      const d = new Date(iso)
      return `${d.getDate()}/${d.getMonth() + 1}/${(d.getFullYear() + 543).toString().slice(-2)}`
    }
    return `${fmt(range.start)} – ${fmt(range.end)}`
  }, [range])

  const noDataInRange = range !== null && filteredContracts.length === 0 && data.contracts.length > 0

  // ภาพรวมรายเดือน: ร้านใหม่ / ร้านที่ส่งเคส (ใช้ข้อมูลทั้งหมด ไม่กรองตามช่วง)
  const years = useMemo(() => yearsFromContracts(data.contracts), [data.contracts])
  const [yearSel, setYearSel] = useState<number | null>(null)
  const year = yearSel ?? years[0] ?? new Date().getFullYear()
  const monthly = useMemo(() => monthlyShopActivity(data.contracts, year), [data.contracts, year])

  const c = useListControls(rows, (r) => `${r.name} ${r.code}`)

  return (
    <div>
      <PageTitle
        sub={
          loading
            ? 'วัดผลแต่ละร้าน — ปริมาณงาน + คุณภาพลูกค้า + ความเคลื่อนไหว (ลูกค้าเสี่ยง = ล่าช้า 31 วันขึ้นไป)'
            : `วัดผลแต่ละร้าน — ปริมาณงาน + คุณภาพลูกค้า + ความเคลื่อนไหว (ลูกค้าเสี่ยง = ล่าช้า 31 วันขึ้นไป) · ร้านทั้งหมด ${rows.length} ร้าน`
        }
      >
        รายงานร้านค้า
      </PageTitle>

      {loading ? (
        <Loading />
      ) : (
        <>
          {/* ===== ตัวเลือกช่วงวันที่ ===== */}
          <div className="mb-5">
            <DateRangePicker
              storageKey="shopReport.dateRange"
              value={range}
              onChange={setRange}
              emptyDataChip={noDataInRange}
            />
          </div>

          {/* ===== Top 5 ร้านค้า — ส่งเคสมากที่สุดในช่วงนี้ ===== */}
          <Card className="mb-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold text-ink">
                <span aria-hidden="true">🏆 </span>
                Top 5 ร้านค้า — ส่งเคสมากที่สุดในช่วงนี้
              </h3>
              <span className="rounded-full bg-peach-light px-3 py-1 text-xs font-medium text-ink-soft">
                {rangeChipText}
              </span>
            </div>
            {top5Shops.length === 0 ? (
              <p className="py-6 text-center text-sm text-ink-soft">
                ไม่มีร้านค้าที่ส่งเคสในช่วงนี้
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
                {top5Shops.map((r, i) => {
                  const isFirst = i === 0
                  const pct = top5Max ? Math.max((r.contracts / top5Max) * 100, 8) : 0
                  return (
                    <button
                      key={r.shopId}
                      onClick={() => navigate(`/shop/${r.shopId}`)}
                      title={r.name}
                      className={`group flex flex-col gap-2 rounded-xl border p-3 text-left transition hover:shadow-md ${
                        isFirst
                          ? 'border-amber-300 bg-amber-50'
                          : 'border-peach bg-cream-deep hover:border-salmon'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={`inline-flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-xs font-bold ${
                            isFirst
                              ? 'bg-amber-400 text-white'
                              : 'bg-zinc-200 text-zinc-700'
                          }`}
                        >
                          #{i + 1}
                        </span>
                        <span className="text-xs text-ink-soft">{r.code}</span>
                      </div>
                      <p className="truncate text-sm font-medium text-ink group-hover:text-salmon-deep">
                        {r.name}
                      </p>
                      <p className={`text-2xl font-bold ${isFirst ? 'text-amber-600' : 'text-ink'}`}>
                        {r.contracts}
                        <span className="ml-1 text-xs font-normal text-ink-soft">เคส</span>
                      </p>
                      <span className="h-1.5 w-full overflow-hidden rounded-full bg-peach-light">
                        <span
                          className={`block h-full rounded-full ${
                            isFirst ? 'bg-amber-400' : 'bg-salmon-deep'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </Card>

          {/* ===== การ์ดสรุป (dashboard) ===== */}
          <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="flex items-center gap-3 py-4">
              <div className="rounded-xl bg-amber-100 p-2.5"><Award size={22} className="text-amber-600" /></div>
              <div className="min-w-0">
                <p className="text-xs text-ink-soft">ร้านส่งเคสเยอะสุด</p>
                {summary.topShop ? (
                  <>
                    <p className="truncate font-bold text-ink">{summary.topShop.name}</p>
                    <p className="text-xs text-ink-soft">{summary.topShop.contracts} เคส</p>
                  </>
                ) : (
                  <p className="font-bold text-ink">—</p>
                )}
              </div>
            </Card>

            <Card className="flex items-center gap-3 py-4">
              <div className="rounded-xl bg-green-100 p-2.5"><Activity size={22} className="text-green-600" /></div>
              <div>
                <p className="text-xs text-ink-soft">ร้านที่ยังเคลื่อนไหว</p>
                <p className="text-2xl font-bold text-green-600">{summary.activePercent.toFixed(0)}%</p>
                <p className="text-xs text-ink-soft">{summary.activeShops}/{summary.totalShops} ร้าน (ส่งเคสใน 30 วัน)</p>
              </div>
            </Card>

            <Card className="flex items-center gap-3 py-4">
              <div className="rounded-xl bg-red-100 p-2.5"><Moon size={22} className="text-red-500" /></div>
              <div>
                <p className="text-xs text-ink-soft">ร้านเงียบ &gt;30 วัน</p>
                <p className="text-2xl font-bold text-red-600">{summary.inactiveShops}</p>
                <p className="text-xs text-ink-soft">ไม่มีเคสใหม่เกิน 30 วัน</p>
              </div>
            </Card>

            <Card className="flex items-center gap-3 py-4">
              <div className="rounded-xl bg-salmon/20 p-2.5"><Store size={22} className="text-salmon-deep" /></div>
              <div>
                <p className="text-xs text-ink-soft">ร้านทั้งหมด</p>
                <p className="text-2xl font-bold text-ink">{summary.totalShops}</p>
                <p className="text-xs text-ink-soft">เกรด A: {summary.gradeA} · เกรด E: {summary.gradeE}</p>
              </div>
            </Card>
          </div>

          {/* ===== กราฟแท่ง Top 10 ส่งเคสเยอะสุด ===== */}
          {topShops.length > 0 && (
            <Card className="mb-5">
              <h3 className="mb-3 font-semibold text-ink">Top 10 ร้านส่งเคสเยอะสุด</h3>
              <div className="flex flex-col gap-2.5">
                {topShops.map((r) => (
                  <button
                    key={r.shopId}
                    onClick={() => navigate(`/shop/${r.shopId}`)}
                    className="group flex items-center gap-3 text-left"
                  >
                    <span className="w-32 shrink-0 truncate text-sm text-ink group-hover:text-salmon-deep">{r.name}</span>
                    <span className="h-6 flex-1 overflow-hidden rounded-lg bg-peach-light">
                      <span
                        className="flex h-full items-center justify-end rounded-lg bg-salmon-deep px-2 text-xs font-semibold text-white"
                        style={{ width: `${maxCases ? Math.max((r.contracts / maxCases) * 100, 12) : 0}%` }}
                      >
                        {r.contracts}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </Card>
          )}

          {/* ===== ภาพรวมรายเดือน: ร้านใหม่ / ร้านที่ส่งเคส ===== */}
          <Card className="mb-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold text-ink">ภาพรวมรายเดือน — ร้านใหม่ / ร้านที่ส่งเคส</h3>
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
              labels={monthly.map((m) => m.label)}
              series={[
                { name: 'ร้านที่ส่งเคส', color: '#f97316', values: monthly.map((m) => m.activeShops), fill: true },
                { name: 'ร้านใหม่', color: '#0d9488', values: monthly.map((m) => m.newShops) },
              ]}
              valueSuffix=" ร้าน"
            />
            <p className="mt-2 text-xs text-ink-soft">
              "ร้านใหม่" = เดือนที่ร้านส่งเคสครั้งแรก · "ร้านที่ส่งเคส" = ร้านที่มีเคสในเดือนนั้น (นับไม่ซ้ำ)
            </p>
          </Card>

          {/* ===== ตารางร้านค้า (ค้นหา/เรียง/แบ่งหน้า + กดเข้าร้าน) ===== */}
          <ListToolbar controls={c} searchPlaceholder="ค้นหาร้านค้า (ชื่อ / รหัส)..." />
          <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
            <table className="w-full min-w-[980px] text-sm">
              <thead>
                <tr className="bg-peach-light text-left text-ink">
                  {['ร้านค้า', 'สัญญา', 'ยอดขายรวม', 'เสี่ยง (31วัน+)', '% เสี่ยง', 'ทิ้งงวดแรก', 'ส่งเคสล่าสุด', 'สถานะ', 'เกรด'].map((h) => (
                    <th key={h} className="whitespace-nowrap px-3 py-2.5 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {c.paged.map((r, i) => (
                  <tr
                    key={r.shopId}
                    onClick={() => navigate(`/shop/${r.shopId}`)}
                    className={`cursor-pointer transition hover:bg-peach-light/60 ${i % 2 ? 'bg-white' : 'bg-cream-deep'}`}
                  >
                    <td className="px-3 py-2.5">
                      <p className="font-medium text-salmon-deep">{r.name}</p>
                      <p className="text-xs text-ink-soft">{r.code}</p>
                    </td>
                    <td className="px-3 py-2.5 text-center">{r.contracts}</td>
                    <td className="px-3 py-2.5 text-right">{baht(r.totalSales)}</td>
                    <td className="px-3 py-2.5 text-center font-medium text-red-600">{r.risky}</td>
                    <td className="px-3 py-2.5 text-center">{r.riskyRate.toFixed(0)}%</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-center">
                      {r.firstDefaultHolding === 0 && r.firstDefaultReturned === 0 ? (
                        <span className="text-ink-soft/40">—</span>
                      ) : (
                        <>
                          <span className="font-medium text-red-600">
                            ถือเครื่อง {r.firstDefaultHolding} ({r.firstDefaultHoldingRate.toFixed(0)}%)
                          </span>
                          {r.firstDefaultReturned > 0 && (
                            <span className="block text-xs text-ink-soft">คืนแล้ว {r.firstDefaultReturned}</span>
                          )}
                        </>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-center text-ink-soft">
                      {r.daysSinceActivity == null ? '—' : r.daysSinceActivity === 0 ? 'วันนี้' : `${r.daysSinceActivity} วันก่อน`}
                    </td>
                    <td className="px-3 py-2.5"><ActivityBadge row={r} /></td>
                    <td className="px-3 py-2.5"><GradeBadge grade={r.grade} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ListPager controls={c} />

          <p className="mt-4 text-xs text-ink-soft">
            เกณฑ์เกรด: A ≤3% · B &gt;3–8% · C &gt;8–12% · E &gt;12% (% ลูกค้าค้างเกิน 30 วัน) ·
            กดที่ร้านเพื่อดูรายชื่อลูกค้าของร้านนั้น
          </p>
        </>
      )}
    </div>
  )
}
