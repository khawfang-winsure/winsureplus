import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Award, Activity, Moon, Store } from 'lucide-react'
import { Card, Loading, PageTitle } from '../components/ui'
import { ListPager, ListToolbar } from '../components/ManagedList'
import { baht } from '../lib/format'
import { getAllStatuses, getContracts, getShops } from '../lib/db'
import { buildShopReport, shopReportSummary, topShopsByCases } from '../lib/report'
import { useAsync } from '../lib/useAsync'
import { useListControls } from '../lib/useListControls'
import type { ShopGrade, ShopReportRow } from '../lib/types'

const todayISO = new Date().toISOString().slice(0, 10)

const GRADE_STYLE: Record<ShopGrade, string> = {
  A: 'bg-green-100 text-green-700',
  B: 'bg-blue-100 text-blue-700',
  C: 'bg-amber-100 text-amber-700',
  D: 'bg-red-100 text-red-700',
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
  const { data, loading } = useAsync(
    async () => {
      const [shops, contracts, statuses] = await Promise.all([
        getShops(),
        getContracts(),
        getAllStatuses(),
      ])
      return buildShopReport(shops, contracts, statuses, todayISO)
    },
    [] as ShopReportRow[],
  )

  const summary = useMemo(() => shopReportSummary(data), [data])
  const topShops = useMemo(() => topShopsByCases(data, 10), [data])
  const maxCases = topShops[0]?.contracts ?? 0

  const c = useListControls(data, (r) => `${r.name} ${r.code}`)

  return (
    <div>
      <PageTitle sub="วัดผลแต่ละร้าน — ปริมาณงาน + คุณภาพลูกค้า + ความเคลื่อนไหว (ลูกค้าเสี่ยง = ล่าช้า 31 วันขึ้นไป)">
        รายงานร้านค้า
      </PageTitle>

      {loading ? (
        <Loading />
      ) : (
        <>
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
                <p className="text-xs text-ink-soft">เกรด A: {summary.gradeA} · เกรด D: {summary.gradeD}</p>
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

          {/* ===== ตารางร้านค้า (ค้นหา/เรียง/แบ่งหน้า + กดเข้าร้าน) ===== */}
          <ListToolbar controls={c} searchPlaceholder="ค้นหาร้านค้า (ชื่อ / รหัส)..." />
          <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="bg-peach-light text-left text-ink">
                  {['ร้านค้า', 'สัญญา', 'ยอดขายรวม', 'เสี่ยง (31วัน+)', '% เสี่ยง', 'ส่งเคสล่าสุด', 'สถานะ', 'เกรด'].map((h) => (
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
            เกณฑ์เกรด: A &lt;5% · B 5-15% · C 15-30% · D &gt;30% (ของลูกค้าเสี่ยง) ·
            กดที่ร้านเพื่อดูรายชื่อลูกค้าของร้านนั้น
          </p>
        </>
      )}
    </div>
  )
}
