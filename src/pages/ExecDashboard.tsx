import { useNavigate } from 'react-router-dom'
import { Loading, PageTitle, Card, Badge } from '../components/ui'
import { Donut } from '../components/Donut'
import { LineChart } from '../components/LineChart'
import { baht } from '../lib/format'
import { useAsync } from '../lib/useAsync'
import {
  getContracts,
  getAllStatuses,
  getAllInstallments,
  getShops,
  getAllPayments,
  getAllExtensions,
  getReturns,
} from '../lib/db'
import { buildExecDashboard, type ExecDashboard, type RiskGroup } from '../lib/execDashboard'
import type { ShopGrade } from '../lib/types'

const todayISO = new Date().toISOString().slice(0, 10)

/** ย่อจำนวนเงินก้อนใหญ่: 2,400,000 → 2.40M, 12,300 → 12.3K */
function money(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(0)}K`
  return baht(n)
}

const GRADE_COLOR: Record<ShopGrade, string> = {
  A: '#16a34a',
  B: '#65a30d',
  C: '#f59e0b',
  D: '#dc2626',
  '-': '#9ca3af',
}

export default function ExecDashboard() {
  const navigate = useNavigate()
  const { data, loading } = useAsync<ExecDashboard | null>(async () => {
    const [contracts, statuses, installments, shops, payments, extensions, returns] = await Promise.all([
      getContracts(),
      getAllStatuses(),
      getAllInstallments(),
      getShops(),
      getAllPayments(),
      getAllExtensions(),
      getReturns(),
    ])
    return buildExecDashboard({ contracts, statuses, installments, shops, payments, extensions, returns, todayISO })
  }, null)

  if (loading || !data) {
    return (
      <div>
        <PageTitle>Dashboard ผู้บริหาร</PageTitle>
        <Loading />
      </div>
    )
  }
  const d: ExecDashboard = data
  const collectedPct = d.portfolioPayable > 0 ? (d.collected / d.portfolioPayable) * 100 : 0

  return (
    <div className="flex flex-col gap-5">
      <PageTitle sub={`ข้อมูล ณ ${todayISO} — ภาพรวมทั้งหมดในหน้าเดียว`}>Dashboard ผู้บริหาร</PageTitle>

      {/* ===== แถว 1: KPI หัวใจ ===== */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi label="ลูกค้าทั้งหมด" value={String(d.totalContracts)} sub={`ผ่อนอยู่ ${d.activeContracts} · ปิด ${d.closedContracts}`} onClick={() => navigate('/customers')} />
        <Kpi label="ยอดผ่อนรวม (พอร์ต)" value={`฿${money(d.portfolioPayable)}`} sub="ค่างวด × จำนวนงวด" />
        <Kpi label="ยอดจัดไฟแนนซ์รวม" value={`฿${money(d.portfolioFinance)}`} sub="เงินต้นที่ปล่อย" />
        <Kpi label="ชำระแล้ว" value={`฿${money(d.collected)}`} sub={`${collectedPct.toFixed(0)}% ของพอร์ต`} tone="text-green-600" />
        <Kpi label="คงค้าง" value={`฿${money(d.outstanding)}`} sub="ยังไม่ได้เก็บ" tone="text-amber-600" />
        <Kpi label="หนี้เสีย (NPL)" value={`${d.nplRate.toFixed(1)}%`} sub={`฿${money(d.badDebt.value)}`} tone="text-red-600" onClick={() => navigate('/customer-overview')} />
      </div>

      {/* ===== แถว 2: สุขภาพลูกค้า ===== */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h3 className="mb-3 font-semibold text-ink">สุขภาพลูกค้า (สัญญาที่ผ่อนอยู่)</h3>
          <Donut
            centerLabel="ผ่อนอยู่"
            centerValue={String(d.activeContracts)}
            slices={[
              { label: 'ปกติ', value: d.normal.count, color: '#16a34a' },
              { label: 'ล่าช้า', value: d.late.count, color: '#f59e0b' },
              { label: 'หนี้เสีย (≥60 วัน)', value: d.badDebt.count, color: '#dc2626' },
            ]}
          />
          <div className="mt-3 grid grid-cols-3 gap-2 text-center text-sm">
            <ValueChip label="ปกติ" value={d.normal.value} tone="text-green-600" />
            <ValueChip label="ล่าช้า" value={d.late.value} tone="text-amber-600" />
            <ValueChip label="หนี้เสีย" value={d.badDebt.value} tone="text-red-600" />
          </div>
        </Card>

        <Card>
          <h3 className="mb-3 font-semibold text-ink">กระจายตามวันล่าช้า (มูลค่าคงค้าง)</h3>
          <BarList
            rows={d.aging.map((a) => ({ label: a.label, count: a.count, value: a.value }))}
            color="#f97316"
            onClick={(i) => navigate(`/overdue/${d.aging[i].bucket}`)}
          />
        </Card>
      </div>

      {/* ===== แถว 3: การเงินเชิงลึก ===== */}
      <Card>
        <h3 className="mb-3 font-semibold text-ink">การเงินเชิงลึก</h3>
        {/* progress bar ชำระ vs คงค้าง */}
        <div className="mb-1 flex justify-between text-sm">
          <span className="text-green-600">ชำระแล้ว ฿{money(d.collected)}</span>
          <span className="text-amber-600">คงค้าง ฿{money(d.outstanding)}</span>
        </div>
        <div className="mb-4 flex h-4 overflow-hidden rounded-full bg-peach-light">
          <div className="bg-green-500" style={{ width: `${collectedPct}%` }} />
          <div className="bg-amber-400" style={{ width: `${100 - collectedPct}%` }} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Kpi label="อัตราเก็บเงิน" value={`${d.collectionRate.toFixed(0)}%`} sub="เก็บได้ ÷ ที่ครบกำหนด" small />
          <Kpi label="รับชำระเดือนนี้" value={`฿${money(d.receivedThisMonth)}`} small tone="text-green-600" />
          <Kpi label="คาดเก็บเดือนนี้" value={`฿${money(d.expectedThisMonth)}`} small />
          <Kpi label="คาดเก็บเดือนหน้า" value={`฿${money(d.expectedNextMonth)}`} small />
          <Kpi label="ค่าปรับค้างรวม" value={`฿${money(d.penaltyTotal)}`} small tone="text-amber-600" />
          <Kpi label="กำไรคร่าวๆ*" value={`฿${money(d.grossMarginEstimate)}`} sub="*ประมาณการ" small tone="text-green-600" />
        </div>
      </Card>

      {/* ===== แถว 4: ร้านค้า ===== */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h3 className="mb-3 font-semibold text-ink">เกรดร้านค้า ({d.shopRows.length} ร้าน)</h3>
          <BarList
            rows={d.gradeDist.map((g) => ({ label: `เกรด ${g.grade}`, count: g.count, value: g.value }))}
            colorOf={(i) => GRADE_COLOR[d.gradeDist[i].grade]}
            valueLabel="ยอดขายรวม"
          />
        </Card>
        <Card>
          <h3 className="mb-3 font-semibold text-ink">Top 5 ร้านส่งเคสเยอะ</h3>
          {d.topShops.length === 0 ? (
            <p className="text-sm text-ink-soft">—</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {d.topShops.map((s) => (
                <li key={s.shopId} className="flex items-center justify-between gap-2 text-sm">
                  <button onClick={() => navigate(`/shop/${s.shopId}`)} className="truncate text-left text-salmon-deep hover:underline">
                    {s.name || s.code}
                  </button>
                  <span className="flex items-center gap-2">
                    <Badge tone={s.grade === 'A' || s.grade === 'B' ? 'green' : s.grade === 'C' ? 'amber' : 'red'}>{s.grade}</Badge>
                    <b className="text-ink">{s.contracts} เคส</b>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <h3 className="mb-3 font-semibold text-ink">ร้านพอร์ตเสี่ยง (ส่งเยอะแต่หนี้เสียสูง)</h3>
          <ShopMini rows={d.riskyShops} navigate={navigate} metric="risky" />
        </Card>
        <Card>
          <h3 className="mb-3 font-semibold text-ink">ร้านเงียบ &gt; 30 วัน</h3>
          <ShopMini rows={d.silentShops} navigate={navigate} metric="silent" />
        </Card>
      </div>

      {/* ===== แถว 5: สัญญาณเตือน ===== */}
      <Card>
        <h3 className="mb-3 font-semibold text-ink">สัญญาณเตือนล่วงหน้า</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Kpi label="ไม่จ่ายงวดแรก" value={`${d.earlyDefault.count} ราย`} sub={`฿${money(d.earlyDefault.value)}`} tone="text-red-600" small />
          <Kpi label="ขอขยายเวลาเดือนนี้" value={`${d.extensionsThisMonth} ราย`} onClick={() => navigate('/extended')} tone="text-amber-600" small />
          <Kpi label="คืนเครื่องเดือนนี้" value={`${d.returnsThisMonth.count} ราย`} sub={`฿${money(d.returnsThisMonth.value)}`} onClick={() => navigate('/returns')} small />
          <Kpi label="เคสใหม่เดือนนี้" value={`${d.newContractsThisMonth} ราย`} tone="text-green-600" small />
          <Kpi label="ร้านใหม่เดือนนี้" value={`${d.newShopsThisMonth} ร้าน`} tone="text-green-600" small />
        </div>
      </Card>

      {/* ===== แถว 6: แนวโน้ม 12 เดือน ===== */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h3 className="mb-1 font-semibold text-ink">เคสใหม่ & เก็บเงินได้ (12 เดือน)</h3>
          <LineChart
            labels={d.trendLabels}
            series={[
              { name: 'เคสใหม่ (ราย)', color: '#f97316', values: d.newCasesByMonth, fill: true },
              { name: 'เก็บเงิน (พันบาท)', color: '#16a34a', values: d.collectedByMonth.map((v) => Math.round(v / 1000)) },
            ]}
          />
        </Card>
        <Card>
          <h3 className="mb-1 font-semibold text-ink">การเติบโตของพอร์ต (ยอดผ่อนสะสม, พันบาท)</h3>
          <LineChart
            labels={d.trendLabels}
            valueSuffix="K"
            series={[{ name: 'พอร์ตสะสม', color: '#0ea5e9', values: d.portfolioByMonth.map((v) => Math.round(v / 1000)), fill: true }]}
          />
        </Card>
      </div>

      {/* ===== แถว 7: ความเสี่ยงตามกลุ่ม ===== */}
      <div className="grid gap-4 lg:grid-cols-3">
        <RiskTable title="หนี้เสียตามอาชีพ" rows={d.riskByOccupation} />
        <RiskTable title="หนี้เสียตามช่วงอายุ" rows={d.riskByAge} />
        <RiskTable title="หนี้เสียตามรุ่นเครื่อง" rows={d.riskByModel} />
      </div>
    </div>
  )
}

// ---------- ส่วนประกอบย่อย ----------
function Kpi({
  label,
  value,
  sub,
  tone = 'text-ink',
  small,
  onClick,
}: {
  label: string
  value: string
  sub?: string
  tone?: string
  small?: boolean
  onClick?: () => void
}) {
  const inner = (
    <>
      <p className="text-xs text-ink-soft">{label}</p>
      <p className={`font-bold ${small ? 'text-xl' : 'text-2xl'} ${tone}`}>{value}</p>
      {sub && <p className="text-xs text-ink-soft">{sub}</p>}
    </>
  )
  if (onClick)
    return (
      <button onClick={onClick} className="rounded-2xl border border-peach bg-peach-light/40 p-4 text-left transition hover:bg-peach-light/70">
        {inner}
      </button>
    )
  return <div className="rounded-2xl border border-peach bg-white p-4">{inner}</div>
}

function ValueChip({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-xl bg-peach-light/40 py-2">
      <p className="text-xs text-ink-soft">{label}</p>
      <p className={`font-semibold ${tone}`}>฿{money(value)}</p>
    </div>
  )
}

function BarList({
  rows,
  color,
  colorOf,
  valueLabel = 'มูลค่า',
  onClick,
}: {
  rows: { label: string; count: number; value: number }[]
  color?: string
  colorOf?: (i: number) => string
  valueLabel?: string
  onClick?: (i: number) => void
}) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r, i) => (
        <button
          key={r.label}
          onClick={onClick ? () => onClick(i) : undefined}
          className={`text-left ${onClick ? 'cursor-pointer' : 'cursor-default'}`}
        >
          <div className="flex justify-between text-sm">
            <span className="text-ink-soft">{r.label} <span className="text-ink">({r.count})</span></span>
            <span className="text-ink-soft" title={valueLabel}>฿{money(r.value)}</span>
          </div>
          <div className="mt-0.5 h-2.5 overflow-hidden rounded-full bg-peach-light">
            <div className="h-full rounded-full" style={{ width: `${(r.value / max) * 100}%`, backgroundColor: colorOf ? colorOf(i) : color }} />
          </div>
        </button>
      ))}
    </div>
  )
}

function ShopMini({ rows, navigate, metric }: { rows: import('../lib/types').ShopReportRow[]; navigate: (to: string) => void; metric: 'risky' | 'silent' }) {
  if (rows.length === 0) return <p className="text-sm text-ink-soft">— ไม่มี</p>
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {rows.map((s) => (
        <li key={s.shopId} className="flex items-center justify-between gap-2">
          <button onClick={() => navigate(`/shop/${s.shopId}`)} className="truncate text-left text-salmon-deep hover:underline">
            {s.name || s.code}
          </button>
          {metric === 'risky' ? (
            <span className="text-red-600">หนี้เสีย {s.riskyRate.toFixed(0)}% ({s.risky}/{s.contracts})</span>
          ) : (
            <span className="text-ink-soft">เงียบ {s.daysSinceActivity} วัน</span>
          )}
        </li>
      ))}
    </ul>
  )
}

function RiskTable({ title, rows }: { title: string; rows: RiskGroup[] }) {
  const shown = rows.filter((r) => r.total > 0).slice(0, 6)
  return (
    <Card>
      <h3 className="mb-2 font-semibold text-ink">{title}</h3>
      {shown.length === 0 ? (
        <p className="text-sm text-ink-soft">—</p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {shown.map((r) => (
              <tr key={r.key} className="border-b border-peach/50 last:border-0">
                <td className="py-1.5 text-ink">{r.key}</td>
                <td className="py-1.5 text-right text-ink-soft">{r.badDebt}/{r.total}</td>
                <td className="py-1.5 text-right">
                  <Badge tone={r.rate >= 30 ? 'red' : r.rate >= 15 ? 'amber' : 'green'}>{r.rate.toFixed(0)}%</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
