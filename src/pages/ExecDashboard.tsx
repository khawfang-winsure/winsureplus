import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loading, PageTitle, Card, Badge } from '../components/ui'
import { Donut } from '../components/Donut'
import { LineChart } from '../components/LineChart'
import MorningBriefing from '../components/MorningBriefing'
import GradeMovementView from '../components/GradeMovementView'
import { EscalateSummaryCard } from '../components/EscalateSummaryCard'
import { baht } from '../lib/format'
import { useAsync } from '../lib/useAsync'
import { useAuth } from '../lib/auth'
import {
  getContracts,
  getAllStatuses,
  getAllInstallments,
  getShops,
  getAllPayments,
  getAllExtensions,
  getReturns,
  getCommissionTiers,
  getRecruitTiers,
  getRecruitBonuses,
  getEmployees,
  getEscalateContracts,
  getGradeChangesMonthly,
  getActiveGradedCount,
  type EscalateContract,
} from '../lib/db'
import { buildExecDashboard, buildGradeMovement, type ExecDashboard, type RiskGroup, type CashflowRow, type Granularity, type GradeMovementResult } from '../lib/execDashboard'
import type { ShopGrade } from '../lib/types'

type Tab = 'overview' | Granularity | 'grade'
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'ภาพรวมทั้งหมด' },
  { key: 'day', label: 'รายวัน' },
  { key: 'week', label: 'รายสัปดาห์' },
  { key: 'month', label: 'รายเดือน' },
  { key: 'grade', label: 'การขยับเกรด' },
]

const todayISO = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)

/** ย่อจำนวนเงินก้อนใหญ่: 2,400,000 → 2.40M, 12,300 → 12.3K */
function money(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(0)}K`
  return baht(n)
}

/** แปลง index → ตัวอักษร A, B, C … Z, AA, AB ฯลฯ */
function maskLabel(index: number): string {
  if (index < 26) return String.fromCharCode(65 + index)
  return String.fromCharCode(65 + Math.floor(index / 26) - 1) + String.fromCharCode(65 + (index % 26))
}

/** ถ้า mask=true คืน "ร้าน A" / "พนักงาน A" ตาม kind; ไม่งั้น return ชื่อจริง */
function maskName(realName: string, index: number, mask: boolean, kind: 'shop' | 'staff' = 'shop'): string {
  if (!mask) return realName
  const prefix = kind === 'staff' ? 'พนักงาน ' : 'ร้าน '
  return prefix + maskLabel(index)
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
  const { role } = useAuth()
  // fail-safe: ถ้า role ยัง loading/unknown (null) → mask ชื่อจริง (กัน name leak ระหว่าง refetch)
  const showRealNames = role === 'admin' || role === 'staff'
  const isExec = !showRealNames
  const [tab, setTab] = useState<Tab>('overview')
  const { data, loading } = useAsync<ExecDashboard | null>(async () => {
    const [contracts, statuses, installments, shops, payments, extensions, returns, commissionTiers, recruitTiers, recruitBonuses, employees] = await Promise.all([
      getContracts(),
      getAllStatuses(),
      getAllInstallments(),
      getShops(),
      getAllPayments(),
      getAllExtensions(),
      getReturns(),
      getCommissionTiers(),
      getRecruitTiers(),
      getRecruitBonuses(),
      getEmployees(),
    ])
    return buildExecDashboard({
      contracts,
      statuses,
      installments,
      shops,
      payments,
      extensions,
      returns,
      todayISO,
      commissionTiers,
      recruitTiers,
      recruitBonuses,
      employeeNames: Object.fromEntries(employees.map((e) => [e.id, e.fullName])),
    })
  }, null)

  const { data: gradeMovement, loading: gradeLoading, error: gradeError } = useAsync<GradeMovementResult | null>(async () => {
    const [rows, count] = await Promise.all([getGradeChangesMonthly(), getActiveGradedCount()])
    return buildGradeMovement(rows, count, todayISO)
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
      <PageTitle sub={`ข้อมูล ณ ${todayISO}`}>Dashboard ผู้บริหาร</PageTitle>

      {/* ===== Morning Briefing (above tabs, scrolls naturally) ===== */}
      <MorningBriefing
        data={d.briefing}
        npl={d.nplRate}
        newCases={d.newContractsThisMonth}
        collectedThisMonth={d.receivedThisMonth}
        expectedThisMonth={d.expectedThisMonth}
        isExec={isExec}
      />

      {/* แท็บเลือกมุมมอง: ภาพรวม / รายวัน / สัปดาห์ / เดือน */}
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
              tab === t.key ? 'bg-salmon-deep text-white' : 'border border-peach bg-white text-ink-soft hover:bg-peach-light'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {(tab === 'day' || tab === 'week' || tab === 'month') && (
        <CashflowView
          gran={tab}
          rows={tab === 'day' ? d.cashflowDay : tab === 'week' ? d.cashflowWeek : d.cashflowMonth}
        />
      )}

      {tab === 'grade' && (
        gradeLoading ? <Loading />
        : gradeError ? <p className="text-sm text-red-500 p-4">โหลดข้อมูลไม่ได้: {String(gradeError)}</p>
        : gradeMovement ? <GradeMovementView data={gradeMovement} />
        : <Loading />
      )}

      {tab === 'overview' && (
      <>
      {/* ===== P&L strip รายเดือน ===== */}
      {d.briefing.monthlyPL !== null && (
        <Card>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="font-semibold text-ink">รายเดือน {d.briefing.monthlyPL.monthLabel}</span>
            <span className="text-green-600">เข้า ฿{money(d.briefing.monthlyPL.income)}</span>
            <span className="text-amber-600">ออก ฿{money(d.briefing.monthlyPL.expense)}</span>
            <span className={`font-semibold ${d.briefing.monthlyPL.net >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              สุทธิ ฿{money(d.briefing.monthlyPL.net)}
            </span>
          </div>
        </Card>
      )}

      {/* ===== ผลงานพนักงานรายเดือน ===== */}
      {d.briefing.staffCases.length > 0 && (
        <StaffCaseTable rows={d.briefing.staffCases} isExec={isExec} />
      )}

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
              {d.topShops.map((s, i) => (
                <li key={s.shopId} className="flex items-center justify-between gap-2 text-sm">
                  {isExec ? (
                    <span className="truncate text-ink">{maskName(s.name || s.code, i, true)}</span>
                  ) : (
                    <button onClick={() => navigate(`/shop/${s.shopId}`)} className="truncate text-left text-salmon-deep hover:underline">
                      {s.name || s.code}
                    </button>
                  )}
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
          <ShopMini rows={d.riskyShops} navigate={navigate} metric="risky" mask={isExec} />
        </Card>
        <Card>
          <h3 className="mb-3 font-semibold text-ink">ร้านเงียบ &gt; 30 วัน</h3>
          <ShopMini rows={d.silentShops} navigate={navigate} metric="silent" mask={isExec} />
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

      {/* ===== แถว 8: ESCALATE — admin/staff เห็นรายละเอียด, exec เห็นเฉพาะสรุป aggregate ===== */}
      {isExec ? <EscalateSummaryCard /> : <EscalateWidget navigate={navigate} />}
      </>
      )}
    </div>
  )
}

// ---------- มุมมองกระแสเงินสด รายวัน/สัปดาห์/เดือน ----------
function CashflowView({ gran, rows }: { gran: Granularity; rows: CashflowRow[] }) {
  const unit = gran === 'day' ? 'วัน' : gran === 'week' ? 'สัปดาห์' : 'เดือน'
  const totalIncome = rows.reduce((s, r) => s + r.income, 0)
  const totalExpense = rows.reduce((s, r) => s + r.expense, 0)
  const totalNet = totalIncome - totalExpense
  const totalCases = rows.reduce((s, r) => s + r.newCases, 0)
  // ช่วงล่าสุด (แถวสุดท้าย)
  const last = rows[rows.length - 1]

  return (
    <div className="flex flex-col gap-5">
      {/* สรุปรวมทั้งช่วง */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label={`เงินเข้า (รวม ${rows.length} ${unit})`} value={`฿${money(totalIncome)}`} sub="ค่างวดที่เก็บได้" tone="text-green-600" />
        <Kpi label={`เงินออก (รวม ${rows.length} ${unit})`} value={`฿${money(totalExpense)}`} sub="โอนให้ร้าน (สัญญาใหม่)" tone="text-amber-600" />
        <Kpi label="กระแสเงินสดสุทธิ" value={`฿${money(totalNet)}`} sub="เข้า − ออก" tone={totalNet >= 0 ? 'text-green-600' : 'text-red-600'} />
        <Kpi label={`เคสใหม่ (${rows.length} ${unit})`} value={`${totalCases} ราย`} sub={last ? `ล่าสุด ${last.label}: ${last.newCases} ราย` : ''} />
      </div>

      {/* กราฟเข้า vs ออก */}
      <Card>
        <h3 className="mb-1 font-semibold text-ink">เงินเข้า vs เงินออก ราย{unit} (พันบาท)</h3>
        <LineChart
          labels={rows.map((r) => r.label)}
          valueSuffix="K"
          series={[
            { name: 'เงินเข้า', color: '#16a34a', values: rows.map((r) => Math.round(r.income / 1000)), fill: true },
            { name: 'เงินออก', color: '#f59e0b', values: rows.map((r) => Math.round(r.expense / 1000)) },
          ]}
        />
      </Card>

      {/* ตารางรายช่วง */}
      <Card>
        <h3 className="mb-3 font-semibold text-ink">รายละเอียดราย{unit}</h3>
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-peach text-left text-ink-soft">
                <th className="py-2 font-semibold">ช่วง</th>
                <th className="py-2 text-right font-semibold">เงินเข้า</th>
                <th className="py-2 text-right font-semibold">เงินออก</th>
                <th className="py-2 text-right font-semibold">สุทธิ</th>
                <th className="py-2 text-right font-semibold">รับชำระ</th>
                <th className="py-2 text-right font-semibold">เคสใหม่</th>
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().map((r) => (
                <tr key={r.key} className="border-b border-peach/50 last:border-0">
                  <td className="py-1.5 text-ink">{r.label}</td>
                  <td className="py-1.5 text-right text-green-600">฿{money(r.income)}</td>
                  <td className="py-1.5 text-right text-amber-600">฿{money(r.expense)}</td>
                  <td className={`py-1.5 text-right font-semibold ${r.net >= 0 ? 'text-ink' : 'text-red-600'}`}>฿{money(r.net)}</td>
                  <td className="py-1.5 text-right text-ink-soft">{r.paymentsCount}</td>
                  <td className="py-1.5 text-right text-ink-soft">{r.newCases}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-ink-soft">
          * เงินเข้า = ค่างวดที่บันทึกรับชำระในช่วงนั้น (อิงเวลาที่พนักงานคีย์) · เงินออก = เงินโอนให้ร้านของสัญญาใหม่ตามวันที่ทำรายการ
        </p>
      </Card>
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

function ShopMini({ rows, navigate, metric, mask }: { rows: import('../lib/types').ShopReportRow[]; navigate: (to: string) => void; metric: 'risky' | 'silent'; mask: boolean }) {
  if (rows.length === 0) return <p className="text-sm text-ink-soft">— ไม่มี</p>
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {rows.map((s, i) => (
        <li key={s.shopId} className="flex items-center justify-between gap-2">
          {mask ? (
            <span className="truncate text-ink">{maskName(s.name || s.code, i, true)}</span>
          ) : (
            <button onClick={() => navigate(`/shop/${s.shopId}`)} className="truncate text-left text-salmon-deep hover:underline">
              {s.name || s.code}
            </button>
          )}
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

function StaffCaseTable({ rows, isExec }: { rows: import('../lib/execDashboard').BriefingStaffCase[]; isExec: boolean }) {
  const [showAll, setShowAll] = useState(false)
  const CAP = 8
  const visible = showAll ? rows : rows.slice(0, CAP)
  return (
    <Card>
      <h3 className="mb-3 font-semibold text-ink">ผลงานพนักงาน (เคสรายเดือน)</h3>
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-peach text-left text-xs text-ink-soft">
              <th className="py-2 font-semibold">ชื่อ</th>
              <th className="py-2 text-right font-semibold">เคสเดือนนี้</th>
              <th className="py-2 text-right font-semibold">เคสเดือนก่อน</th>
              <th className="py-2 text-right font-semibold">MoM</th>
              <th className="py-2 text-right font-semibold">ยอดคงค้าง</th>
              <th className="py-2 text-right font-semibold">NPL%</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s, i) => {
              const momColor = s.momDelta > 0 ? 'text-green-600' : s.momDelta < 0 ? 'text-red-600' : 'text-ink-soft'
              const momSign = s.momDelta > 0 ? '+' : ''
              const nplTone: 'green' | 'amber' | 'red' = s.nplRate >= 20 ? 'red' : s.nplRate >= 10 ? 'amber' : 'green'
              const displayName = maskName(s.name, i, isExec, 'staff')
              return (
                <tr key={s.name} className="border-b border-peach/50 last:border-0">
                  <td className="py-2 text-ink">{displayName}</td>
                  <td className="py-2 text-right text-ink">{s.casesThisMonth}</td>
                  <td className="py-2 text-right text-ink-soft">{s.casesLastMonth}</td>
                  <td className={`py-2 text-right font-medium ${momColor}`}>{momSign}{s.momDelta}</td>
                  <td className="py-2 text-right text-ink-soft">฿{money(s.portfolioOutstanding)}</td>
                  <td className="py-2 text-right">
                    <Badge tone={nplTone}>{s.nplRate.toFixed(1)}%</Badge>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {rows.length > CAP && !showAll && (
        <button
          onClick={() => setShowAll(true)}
          className="mt-3 text-xs text-salmon-deep hover:underline"
        >
          ดูทั้งหมด ({rows.length} คน)
        </button>
      )}
    </Card>
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

// ---------- ESCALATE widget — ลูกค้าที่ฟรีแลนซ์ติดต่อไม่ได้ ≥10 ครั้ง ----------
function EscalateWidget({ navigate }: { navigate: (to: string) => void }) {
  const [rows, setRows] = useState<EscalateContract[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // reload counter — เพิ่มค่าเพื่อ trigger re-fetch (ใช้กับปุ่ม retry)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    getEscalateContracts()
      .then((data) => { if (active) setRows(data) })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ')
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [tick])

  // โทนสีเกรด: A|B → green, C → amber, D|E หรืออื่นๆ → red, null → neutral
  function gradeTone(grade: EscalateContract['grade']): 'green' | 'amber' | 'red' | 'neutral' {
    if (grade === 'A' || grade === 'B') return 'green'
    if (grade === 'C') return 'amber'
    if (grade === null) return 'neutral'
    return 'red'
  }

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-ink">
            🚨 ลูกค้าที่ต้องแอดมินตรวจสอบ (ESCALATE)
            {!loading && !error && (
              <span className="ml-2 inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
                {rows.length} รายการ
              </span>
            )}
          </h3>
          <p className="mt-0.5 text-xs text-ink-soft">
            ลูกค้าที่ฟรีแลนซ์พยายามติดต่อแล้ว ≥10 ครั้งโดยไม่สำเร็จ
          </p>
        </div>
      </div>

      {loading && <p className="text-sm text-ink-soft">กำลังโหลด...</p>}

      {error && !loading && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-red-600">{error}</p>
          <button
            onClick={() => setTick((n) => n + 1)}
            className="self-start rounded-xl border border-peach px-3 py-1.5 text-sm text-ink-soft hover:bg-peach-light"
          >
            ลองใหม่
          </button>
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <p className="text-sm text-ink-soft">ยังไม่มีลูกค้าใน ESCALATE bucket</p>
      )}

      {!loading && !error && rows.length > 0 && (
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-peach text-left text-xs text-ink-soft">
                <th className="py-2 font-semibold">ลูกค้า / สัญญา</th>
                <th className="py-2 font-semibold">เกรด</th>
                <th className="py-2 text-right font-semibold">ค้างกี่วัน</th>
                <th className="py-2 text-right font-semibold">ค่าปรับคงค้าง</th>
                <th className="py-2 text-right font-semibold">จำนวนครั้งที่ลอง</th>
                <th className="py-2 font-semibold">ดำเนินการ</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.contractId} className="border-b border-peach/50 last:border-0">
                  <td className="py-2">
                    <p className="font-medium text-ink">{r.customerName}</p>
                    <p className="text-xs text-ink-soft">{r.contractNo} · {r.shopName}</p>
                  </td>
                  <td className="py-2">
                    <Badge tone={gradeTone(r.grade)}>{r.grade ?? '-'}</Badge>
                  </td>
                  <td className="py-2 text-right">
                    <span className="font-semibold text-red-600">{r.daysLate}</span>
                    <span className="ml-0.5 text-xs text-ink-soft">วัน</span>
                  </td>
                  <td className="py-2 text-right text-amber-600">฿{money(r.outstanding)}</td>
                  <td className="py-2 text-right">
                    <span className="font-semibold text-ink">{r.totalAttempts}</span>
                    <span className="ml-0.5 text-xs text-ink-soft">ครั้ง</span>
                  </td>
                  <td className="py-2">
                    <button
                      onClick={() => navigate(`/contract/${r.contractId}`)}
                      className="rounded-lg border border-peach px-2.5 py-1 text-xs text-salmon-deep hover:bg-peach-light"
                    >
                      จัดการ
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
