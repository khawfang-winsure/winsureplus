import { Card, Loading, PageTitle } from '../components/ui'
import { baht } from '../lib/format'
import { getAllStatuses, getContracts, getShops } from '../lib/db'
import { buildShopReport } from '../lib/report'
import { useAsync } from '../lib/useAsync'
import type { ShopGrade } from '../lib/types'

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

export default function ShopReport() {
  const { data, loading } = useAsync(
    async () => {
      const [shops, contracts, statuses] = await Promise.all([
        getShops(),
        getContracts(),
        getAllStatuses(),
      ])
      return buildShopReport(shops, contracts, statuses)
    },
    [] as ReturnType<typeof buildShopReport>,
  )

  const gradeA = data.filter((r) => r.grade === 'A').length
  const gradeD = data.filter((r) => r.grade === 'D').length

  return (
    <div>
      <PageTitle sub="วัดผลแต่ละร้าน — ปริมาณงาน + คุณภาพลูกค้า สรุปเป็นเกรด (ลูกค้าเสี่ยง = ล่าช้า 31 วันขึ้นไป)">
        รายงานร้านค้า
      </PageTitle>

      {loading ? (
        <Loading />
      ) : (
        <>
          {/* สรุปด้านบน */}
          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <Card className="py-3">
              <p className="text-xs text-ink-soft">ร้านค้าทั้งหมด</p>
              <p className="text-2xl font-bold text-ink">{data.length}</p>
            </Card>
            <Card className="py-3">
              <p className="text-xs text-ink-soft">เกรด A (ดีเยี่ยม)</p>
              <p className="text-2xl font-bold text-green-600">{gradeA}</p>
            </Card>
            <Card className="py-3">
              <p className="text-xs text-ink-soft">เกรด D (ต้องระวัง)</p>
              <p className="text-2xl font-bold text-red-600">{gradeD}</p>
            </Card>
          </div>

          {/* ตารางร้านค้า */}
          <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="bg-peach-light text-left text-ink">
                  {['ร้านค้า', 'สัญญา', 'ยอดขายรวม', 'ลูกค้าดี', 'เสี่ยง (31วัน+)', '% เสี่ยง', 'เกรด'].map((h) => (
                    <th key={h} className="whitespace-nowrap px-3 py-2.5 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((r, i) => (
                  <tr key={r.shopId} className={i % 2 ? 'bg-white' : 'bg-peach-light/20'}>
                    <td className="px-3 py-2.5">
                      <p className="font-medium text-ink">{r.name}</p>
                      <p className="text-xs text-ink-soft">{r.code}</p>
                    </td>
                    <td className="px-3 py-2.5 text-center">{r.contracts}</td>
                    <td className="px-3 py-2.5 text-right">{baht(r.totalSales)}</td>
                    <td className="px-3 py-2.5 text-center text-green-600">{r.good}</td>
                    <td className="px-3 py-2.5 text-center font-medium text-red-600">{r.risky}</td>
                    <td className="px-3 py-2.5 text-center">{r.riskyRate.toFixed(0)}%</td>
                    <td className="px-3 py-2.5">
                      <GradeBadge grade={r.grade} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-4 text-xs text-ink-soft">
            เกณฑ์เกรด: A &lt;5% · B 5-15% · C 15-30% · D &gt;30% (ของลูกค้าเสี่ยง) ·
            ขีด "-" = ยังไม่มีสัญญา
          </p>
        </>
      )}
    </div>
  )
}
