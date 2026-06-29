import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Info } from 'lucide-react'
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
  getShops,
  getCashflowDaily,
  getAllExtensions,
  getReturns,
  getCommissionTiers,
  getRecruitTiers,
  getRecruitBonuses,
  getEmployees,
  getEscalateContracts,
  getGradeChangesMonthly,
  getActiveGradedCount,
  getOverduePromiseContracts,
  getAllOtherIncome,
  getContractAggregates,
  getDueScheduleMonthly,
  getForecastByGrade,
  getClawbackAggregates,
  getOverdueMonthSnapshot,
  getDeviceReturnReportRows,
  type EscalateContract,
  type ForecastByGradeRow,
} from '../lib/db'
import { buildExecDashboard, buildGradeMovement, buildOverdueTrend, type ExecDashboard, type RiskGroup, type CashflowRow, type Granularity, type GradeMovementResult, type OverdueTrendResult, type ExpenseSummary, type FirstDefaultSummary } from '../lib/execDashboard'
import { buildCashflowForecast, type CashflowForecastResult } from '../lib/cashflowForecast'
import { detectBottlenecks, type BottleneckAlert } from '../lib/bottleneck'
import { DateRangePicker, loadStoredRange, type DateRange } from '../components/DateRangePicker'
import type { ShopGrade } from '../lib/types'

type Tab = 'overview' | Granularity | 'grade' | 'forecast'
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'ภาพรวมทั้งหมด' },
  { key: 'day', label: 'รายวัน' },
  { key: 'week', label: 'รายสัปดาห์' },
  { key: 'month', label: 'รายเดือน' },
  { key: 'grade', label: 'การขยับเกรด' },
  { key: 'forecast', label: 'พยากรณ์' },
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
  E: '#dc2626',
  '-': '#9ca3af',
}

export default function ExecDashboard() {
  const navigate = useNavigate()
  const { role } = useAuth()
  // fail-safe: ถ้า role ยัง loading/unknown (null) → mask ชื่อจริง (กัน name leak ระหว่าง refetch)
  const showRealNames = role === 'admin' || role === 'staff'
  const isExec = !showRealNames
  const [tab, setTab] = useState<Tab>('overview')
  const [range, setRange] = useState<DateRange | null>(() => loadStoredRange('exec.dateRange'))
  const rangeKey = range ? `${range.start}_${range.end}` : 'all'
  const [data, setData] = useState<ExecDashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [overdueTrend, setOverdueTrend] = useState<OverdueTrendResult | null>(null)
  useEffect(() => {
    let active = true
    setLoading(true)
    Promise.all([
      getContracts(),
      getAllStatuses(),
      getShops(),
      getCashflowDaily(),
      getAllExtensions(),
      getReturns(),
      getCommissionTiers(),
      getRecruitTiers(),
      getRecruitBonuses(),
      getEmployees(),
      getAllOtherIncome(),
      getContractAggregates(),
      getDueScheduleMonthly(),
      getClawbackAggregates(),
      getOverdueMonthSnapshot(),
    ])
      .then(([contracts, statuses, shops, dailyRows, extensions, returns, commissionTiers, recruitTiers, recruitBonuses, employees, otherIncome, contractAggregates, dueSchedule, clawbackAggregates, overdueSnapshot]) => {
        if (!active) return
        const built = buildExecDashboard({
          contracts,
          statuses,
          shops,
          dailyRows,
          extensions,
          returns,
          todayISO,
          rangeStart: range?.start,
          rangeEnd: range?.end,
          commissionTiers,
          recruitTiers,
          recruitBonuses,
          employeeNames: Object.fromEntries(employees.map((e) => [e.id, e.fullName])),
          otherIncome,
          contractAggregates,
          dueSchedule,
          clawbackAggregates,
        })
        setData(built)
        setOverdueTrend(buildOverdueTrend(overdueSnapshot))
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [rangeKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const { data: gradeMovement, loading: gradeLoading, error: gradeError } = useAsync<GradeMovementResult | null>(async () => {
    const [rows, count] = await Promise.all([getGradeChangesMonthly(), getActiveGradedCount()])
    return buildGradeMovement(rows, count, todayISO)
  }, null)

  const { data: forecastRows, loading: forecastLoading, error: forecastError } = useAsync<ForecastByGradeRow[] | null>(async () => {
    // เฟส B: ใช้ getForecastByGrade() แทน getAllInstallments() — ไม่ติด PAGE_CAP
    return getForecastByGrade()
  }, null)

  // ยอดตามเก็บจากเคสคืนเครื่อง (status='returned') ทั้งหมด — ไม่อิงช่วงวันที่ที่เลือก
  const { data: returnedCollectible } = useAsync<number>(async () => {
    const rows = await getDeviceReturnReportRows()
    return rows.filter((r) => r.status === 'returned').reduce((s, r) => s + r.collectibleRemaining, 0)
  }, 0)

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
  const noDataInRange =
    range !== null &&
    d.receivedThisMonth === 0 &&
    d.expectedThisMonth === 0 &&
    d.newContractsThisMonth === 0 &&
    d.extensionsThisMonth === 0 &&
    d.returnsThisMonth.count === 0 &&
    d.newShopsThisMonth === 0

  return (
    <div className="flex flex-col gap-5">
      <PageTitle sub={`ข้อมูล ณ ${todayISO}`}>Dashboard ผู้บริหาร</PageTitle>

      <DateRangePicker storageKey="exec.dateRange" value={range} onChange={setRange} emptyDataChip={noDataInRange} />

      {/* ===== Morning Briefing (above tabs, scrolls naturally) ===== */}
      <MorningBriefing
        data={d.briefing}
        npl={d.nplRate}
        newCases={d.newContractsThisMonth}
        collectedThisMonth={d.receivedThisMonth}
        expectedThisMonth={d.expectedThisMonth}
        isExec={isExec}
      />

      {/* ===== Workflow Bottleneck Alert ===== */}
      <BottleneckWidget navigate={navigate} isExec={isExec} />

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

      {tab === 'forecast' && (
        forecastLoading ? <Loading />
        : forecastError ? <p className="text-sm text-red-500 p-4">โหลดข้อมูลไม่ได้: {String(forecastError)}</p>
        : forecastRows ? <ForecastView
            result={buildCashflowForecast({
              forecastRows,
              pastMonthlyOutflows: d.cashflowMonth.slice(-3).map((r) => r.expense),
              todayISO,
            })}
          />
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
        <Kpi label="ลูกค้าทั้งหมด" value={String(d.totalContracts)} sub={`ผ่อนอยู่ ${d.activeContracts} · ปิด ${d.closedContracts}`} onClick={() => navigate('/customers')} snapshot />
        <Kpi label="ยอดผ่อนรวม (พอร์ต)" value={`฿${money(d.portfolioPayable)}`} sub="ค่างวด × จำนวนงวด" snapshot />
        <Kpi label="ยอดจัดไฟแนนซ์รวม" value={`฿${money(d.portfolioFinance)}`} sub="เงินต้นที่ปล่อย" snapshot />
        <Kpi label="ชำระแล้ว" value={`฿${money(d.collected)}`} sub={`${collectedPct.toFixed(0)}% ของพอร์ต`} tone="text-green-600" snapshot />
        <Kpi label="คงค้าง" value={`฿${money(d.outstanding)}`} sub="ยังไม่ได้เก็บ" tone="text-amber-600" snapshot />
        <Kpi label="หนี้เสีย (NPL)" value={`${d.nplRate.toFixed(1)}%`} sub={`฿${money(d.badDebt.value)}`} tone="text-red-600" onClick={() => navigate('/customer-overview')} snapshot />
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
          <Kpi label="อัตราเก็บเงิน" value={`${d.collectionRate.toFixed(0)}%`} sub="เก็บได้ ÷ ที่ครบกำหนด" small snapshot />
          <Kpi label="รับชำระในช่วง" value={`฿${money(d.receivedThisMonth)}`} small tone="text-green-600" />
          <Kpi label="คาดเก็บในช่วง" value={`฿${money(d.expectedThisMonth)}`} small />
          <Kpi label="คาดเก็บเดือนหน้า" value={`฿${money(d.expectedNextMonth)}`} small snapshot />
          <Kpi label="ค่าปรับค้างรวม" value={`฿${money(d.penaltyTotal)}`} small tone="text-amber-600" snapshot />
          <Kpi label="กำไรคร่าวๆ*" value={`฿${money(d.grossMarginEstimate)}`} sub="*ประมาณการ" small tone="text-green-600" snapshot />
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
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <Kpi label="ไม่จ่ายงวดแรก" value={`${d.earlyDefault.count} ราย`} sub={`฿${money(d.earlyDefault.value)}`} tone="text-red-600" small snapshot />
          <Kpi label="ขอขยายในช่วง" value={`${d.extensionsThisMonth} ราย`} onClick={() => navigate('/extended')} tone="text-amber-600" small />
          <Kpi label="คืนเครื่องในช่วง" value={`${d.returnsThisMonth.count} ราย`} sub={`฿${money(d.returnsThisMonth.value)}`} onClick={() => navigate('/returns')} small />
          <Kpi label="ยอดตามเก็บจากเคสคืนเครื่อง" value={`฿${money(returnedCollectible)}`} sub="เงินที่ยังตามเก็บได้ (1 งวด+ปรับ+ซ่อม) — ค้างทั้งหมด ไม่อิงช่วงวันที่" tone="text-orange-600" small snapshot />
          <Kpi label="เคสใหม่ในช่วง" value={`${d.newContractsThisMonth} ราย`} tone="text-green-600" small />
          <Kpi label="ร้านใหม่ในช่วง" value={`${d.newShopsThisMonth} ร้าน`} tone="text-green-600" small />
        </div>
      </Card>

      {/* ===== แถว 5b: เงินจ่ายออกให้ร้าน + ทิ้งงวดแรก (ทั้งพอร์ต) ===== */}
      <div className="grid gap-4 lg:grid-cols-2">
        <ExpenseSummaryCard summary={d.expenseSummary} />
        <FirstDefaultCard summary={d.firstDefaultSummary} shopRows={d.shopRows} navigate={navigate} isExec={isExec} />
      </div>

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

      {/* ===== แถว 6b: แนวโน้มหนี้ล่าช้า/หนี้เสียรายเดือน ===== */}
      {overdueTrend && overdueTrend.points.length >= 2 && (
        <OverdueTrendCard trend={overdueTrend} />
      )}

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

  // รวม 5 หมวดทั้งช่วง
  const totalInstallment = rows.reduce((s, r) => s + r.incomeInstallment, 0)
  const totalPenalty = rows.reduce((s, r) => s + r.incomePenalty, 0)
  const totalDown = rows.reduce((s, r) => s + r.incomeDown, 0)
  const totalDocFee = rows.reduce((s, r) => s + r.incomeDocFee, 0)
  const totalOther = rows.reduce((s, r) => s + r.incomeOther, 0)

  // legend สีต่อหมวด (ใช้ซ้ำทั้งตารางรวมและตารางรายช่วง)
  const BREAKDOWN_ITEMS: { key: keyof CashflowRow; label: string; color: string }[] = [
    { key: 'incomeInstallment', label: 'ค่างวด', color: 'text-green-700' },
    { key: 'incomePenalty', label: 'ค่าปรับ', color: 'text-amber-600' },
    { key: 'incomeDown', label: 'เงินดาวน์', color: 'text-sky-600' },
    { key: 'incomeDocFee', label: 'ค่าเอกสาร', color: 'text-violet-600' },
    { key: 'incomeOther', label: 'อื่นๆ', color: 'text-pink-600' },
  ]

  return (
    <div className="flex flex-col gap-5">
      {/* สรุปรวมทั้งช่วง */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label={`เงินเข้า (รวม ${rows.length} ${unit})`} value={`฿${money(totalIncome)}`} sub="ค่างวด + ดาวน์ + รายได้อื่นๆ" tone="text-green-600" />
        <Kpi label={`เงินออก (รวม ${rows.length} ${unit})`} value={`฿${money(totalExpense)}`} sub="โอนให้ร้าน (สัญญาใหม่)" tone="text-amber-600" />
        <Kpi label="กระแสเงินสดสุทธิ" value={`฿${money(totalNet)}`} sub="เข้า − ออก" tone={totalNet >= 0 ? 'text-green-600' : 'text-red-600'} />
        <Kpi label={`เคสใหม่ (${rows.length} ${unit})`} value={`${totalCases} ราย`} sub={last ? `ล่าสุด ${last.label}: ${last.newCases} ราย` : ''} />
      </div>

      {/* แยกหมวดรายได้ (รวมทั้งช่วง) */}
      <Card>
        <h3 className="mb-3 font-semibold text-ink">รายได้แยกหมวด (รวม {rows.length} {unit})</h3>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {[
            { label: 'ค่างวด', value: totalInstallment, color: 'text-green-700', dot: 'bg-green-700' },
            { label: 'ค่าปรับ', value: totalPenalty, color: 'text-amber-600', dot: 'bg-amber-500' },
            { label: 'เงินดาวน์', value: totalDown, color: 'text-sky-600', dot: 'bg-sky-500' },
            { label: 'ค่าเอกสาร', value: totalDocFee, color: 'text-violet-600', dot: 'bg-violet-500' },
            { label: 'รายได้อื่นๆ', value: totalOther, color: 'text-pink-600', dot: 'bg-pink-500' },
          ].map((item) => (
            <div key={item.label} className="rounded-xl border border-peach bg-white p-3">
              <div className="flex items-center gap-1.5 text-xs text-ink-soft">
                <span className={`inline-block h-2 w-2 rounded-full ${item.dot}`} />
                {item.label}
              </div>
              <p className={`mt-1 text-lg font-bold ${item.color}`}>฿{money(item.value)}</p>
              <p className="text-xs text-ink-soft">
                {totalIncome > 0 ? `${((item.value / totalIncome) * 100).toFixed(0)}%` : '—'} ของรายได้
              </p>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-ink-soft">รวม 5 หมวด = เงินเข้าทั้งหมด (ค่างวดดูดเศษปัดเศษ — ผลรวมตรงทุก{unit})</p>
      </Card>

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

      {/* ตารางรายช่วง (รวม breakdown 5 หมวด) */}
      <Card>
        <h3 className="mb-3 font-semibold text-ink">รายละเอียดราย{unit}</h3>
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-peach text-left text-ink-soft">
                <th className="py-2 font-semibold">ช่วง</th>
                <th className="py-2 text-right font-semibold">เงินเข้า</th>
                {BREAKDOWN_ITEMS.map((b) => (
                  <th key={b.key as string} className={`py-2 text-right text-xs font-semibold ${b.color}`}>{b.label}</th>
                ))}
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
                  <td className="py-1.5 text-right font-medium text-green-600">฿{money(r.income)}</td>
                  {BREAKDOWN_ITEMS.map((b) => (
                    <td key={b.key as string} className={`py-1.5 text-right text-xs ${b.color}`}>
                      {(r[b.key] as number) > 0 ? `฿${money(r[b.key] as number)}` : <span className="text-ink-soft/40">—</span>}
                    </td>
                  ))}
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
          * เงินเข้า = รวมทุกหมวด (ค่างวด + ค่าปรับ + เงินดาวน์ + ค่าเอกสาร + อื่นๆ) · เงินออก = เงินโอนให้ร้านของสัญญาใหม่ตามวันที่ทำรายการ
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
  snapshot,
}: {
  label: string
  value: string
  sub?: string
  tone?: string
  small?: boolean
  onClick?: () => void
  snapshot?: boolean
}) {
  const inner = (
    <>
      <p className="flex items-center gap-1 text-xs text-ink-soft">
        <span>{label}</span>
        {snapshot && (
          <span
            title="ค่านี้คำนวณ ณ วันนี้ ไม่ถูกผลกระทบจากช่วงที่เลือก"
            className="inline-flex cursor-help items-center text-ink-soft/70"
            aria-label="ค่านี้คำนวณ ณ วันนี้ ไม่ถูกผลกระทบจากช่วงที่เลือก"
          >
            <Info size={12} />
          </span>
        )}
      </p>
      <p className={`font-bold ${small ? 'text-xl' : 'text-2xl'} ${tone}`}>{value}</p>
      {sub && <p className="text-xs text-ink-soft">{sub}</p>}
    </>
  )
  if (onClick)
    return (
      <button
        onClick={onClick}
        title={snapshot ? 'ค่านี้คำนวณ ณ วันนี้ ไม่ถูกผลกระทบจากช่วงที่เลือก' : undefined}
        className="rounded-2xl border border-peach bg-peach-light/40 p-4 text-left transition hover:bg-peach-light/70"
      >
        {inner}
      </button>
    )
  return (
    <div
      className="rounded-2xl border border-peach bg-white p-4"
      title={snapshot ? 'ค่านี้คำนวณ ณ วันนี้ ไม่ถูกผลกระทบจากช่วงที่เลือก' : undefined}
    >
      {inner}
    </div>
  )
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

// ---------- การ์ดเงินจ่ายออกให้ร้าน (ทั้งพอร์ต) ----------
function ExpenseSummaryCard({ summary }: { summary: ExpenseSummary }) {
  return (
    <Card>
      <h3 className="mb-1 font-semibold text-ink">เงินจ่ายออกให้ร้าน (ทั้งพอร์ต)</h3>
      <p className="mb-3 text-xs text-ink-soft">สุทธิที่โอนให้ร้านทั้งหมด — รวมทุกสัญญา ไม่อิงช่วงวันที่</p>
      <p className="whitespace-nowrap text-3xl font-bold text-amber-600">฿{money(summary.netTransferTotal)}</p>
      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl bg-peach-light/40 py-2">
          <p className="text-xs text-ink-soft">ราคาเครื่องรวม</p>
          <p className="whitespace-nowrap font-semibold text-ink">฿{money(summary.deviceTotal)}</p>
        </div>
        <div className="rounded-xl bg-peach-light/40 py-2">
          <p className="text-xs text-ink-soft">ค่าคอมรวม</p>
          <p className="whitespace-nowrap font-semibold text-ink">฿{money(summary.commissionTotal)}</p>
        </div>
        <div className="rounded-xl bg-peach-light/40 py-2">
          <p className="text-xs text-ink-soft">ค่าเอกสารรวม (หัก)</p>
          <p className="whitespace-nowrap font-semibold text-green-600">−฿{money(summary.docFeeTotal)}</p>
        </div>
      </div>
      <p className="mt-2 text-xs text-ink-soft">สุทธิ = ราคาเครื่องหลังหักดาวน์ + ค่าคอม − ค่าเอกสาร</p>
    </Card>
  )
}

// ---------- การ์ดทิ้งงวดแรก (ทั้งพอร์ต) + Top 5 ร้านถือเครื่อง ----------
function FirstDefaultCard({
  summary,
  shopRows,
  navigate,
  isExec,
}: {
  summary: FirstDefaultSummary
  shopRows: import('../lib/types').ShopReportRow[]
  navigate: (to: string) => void
  isExec: boolean
}) {
  const top5 = [...shopRows]
    .filter((r) => r.firstDefaultHolding > 0)
    .sort((a, b) => b.firstDefaultHoldingRate - a.firstDefaultHoldingRate || b.firstDefaultHolding - a.firstDefaultHolding)
    .slice(0, 5)
  return (
    <Card>
      <h3 className="mb-1 font-semibold text-ink">ทิ้งงวดแรก (ทั้งพอร์ต)</h3>
      <p className="mb-3 text-xs text-ink-soft">สัญญาที่ยังไม่เคยจ่ายค่างวดสักงวด — รวมทุกสัญญา ไม่อิงช่วงวันที่</p>
      <div className="grid grid-cols-2 gap-2 text-center">
        <div className="rounded-xl border border-red-200 bg-red-50 py-2.5">
          <p className="text-xs text-ink-soft">ยังถือเครื่อง</p>
          <p className="text-2xl font-bold text-red-600">{summary.holdingCount} ราย</p>
          <p className="whitespace-nowrap text-xs text-red-500">เงินเสี่ยง ฿{money(summary.holdingValue)}</p>
        </div>
        <div className="rounded-xl border border-peach bg-peach-light/40 py-2.5">
          <p className="text-xs text-ink-soft">คืนเครื่องแล้ว</p>
          <p className="text-2xl font-bold text-ink">{summary.returnedCount} ราย</p>
          <p className="text-xs text-ink-soft">ไม่เคยจ่ายแต่คืนเครื่อง</p>
        </div>
      </div>

      <p className="mb-2 mt-4 text-xs font-semibold text-ink-soft">Top 5 ร้านทิ้งงวดแรก · ยังถือเครื่อง (เรียงตาม %)</p>
      {top5.length === 0 ? (
        <p className="text-sm text-green-600">— ไม่มีร้านที่มีเคสทิ้งงวดแรกแบบถือเครื่อง</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {top5.map((s, i) => (
            <li key={s.shopId} className="flex items-center justify-between gap-2">
              {isExec ? (
                <span className="truncate text-ink">{maskName(s.name || s.code, i, true)}</span>
              ) : (
                <button onClick={() => navigate(`/shop/${s.shopId}`)} className="truncate text-left text-salmon-deep hover:underline">
                  {s.name || s.code}
                </button>
              )}
              <span className="flex shrink-0 items-center gap-2">
                <Badge tone="red">{s.firstDefaultHoldingRate.toFixed(0)}%</Badge>
                <b className="whitespace-nowrap text-ink">{s.firstDefaultHolding} ราย</b>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
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

// ---------- Bottleneck Alert widget — เคสค้างใน Device Pipeline + ผิดนัดจ่าย ----------
function BottleneckWidget({ navigate, isExec }: { navigate: (to: string) => void; isExec: boolean }) {
  const [alerts, setAlerts] = useState<BottleneckAlert[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)

    Promise.all([getReturns(), getOverduePromiseContracts()])
      .then(([returns, overduePromises]) => {
        if (!active) return
        const deviceReturns = returns
          .filter((r) => r.deviceStatus != null && r.deviceStatus !== 'shipped')
          .map((r) => ({
            id: r.id,
            contractId: r.contractId,
            contractNo: r.contractNo,
            customerName: r.customerName,
            deviceStatus: r.deviceStatus as string,
            deviceStatusUpdatedAt: r.deviceStatusUpdatedAt ?? null,
          }))

        const promiseOverdue = overduePromises.map((p) => ({
          contractId: p.id,
          contractNo: p.contractCode,
          customerName: p.customerName,
          promiseToPayDate: p.promiseToPayDate,
        }))

        const result = detectBottlenecks({
          deviceReturns,
          contractsWithStatus: [], // check #2 ข้าม (ไม่มี bulk lastFollowUpAt จาก db.ts)
          promiseOverdue,
          todayISO,
        })
        setAlerts(result)
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ')
      })
      .finally(() => { if (active) setLoading(false) })

    return () => { active = false }
  }, [tick])

  const visible = alerts.slice(0, 10)
  const redCount = alerts.filter((a) => a.severity === 'red').length

  function handleAlertClick(alert: BottleneckAlert) {
    if (alert.type === 'stuck_device_pipeline') {
      navigate('/returns')
    } else if (alert.contractId) {
      navigate(`/contract/${alert.contractId}`)
    }
  }

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-ink">
            Workflow Bottleneck — เคสที่ต้องเร่งดำเนินการ
            {!loading && !error && alerts.length > 0 && (
              <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                {alerts.length} รายการ
                {redCount > 0 && (
                  <span className="ml-1 rounded-full bg-red-500 px-1.5 text-white">{redCount} เร่งด่วน</span>
                )}
              </span>
            )}
          </h3>
          <p className="mt-0.5 text-xs text-ink-soft">เครื่องคืนค้างสถานะนาน + ลูกค้านัดจ่ายแล้วผิดนัด</p>
        </div>
        {!loading && (
          <button
            onClick={() => setTick((n) => n + 1)}
            className="rounded-xl border border-peach px-3 py-1.5 text-xs text-ink-soft hover:bg-peach-light"
          >
            รีเฟรช
          </button>
        )}
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

      {!loading && !error && alerts.length === 0 && (
        <p className="text-sm text-green-600">ไม่มีเคสค้างในขณะนี้</p>
      )}

      {!loading && !error && visible.length > 0 && (
        <ul className="flex flex-col gap-2">
          {visible.map((alert, i) => (
            <li key={`${alert.type}-${alert.contractId ?? ''}-${i}`} className="flex items-start gap-3">
              <Badge tone={alert.severity === 'red' ? 'red' : 'amber'}>
                {alert.severity === 'red' ? 'เร่งด่วน' : 'รอดำเนินการ'}
              </Badge>
              <div className="min-w-0 flex-1">
                {isExec ? (
                  <p className="text-sm text-ink">{alert.message}</p>
                ) : (
                  <button
                    onClick={() => handleAlertClick(alert)}
                    className="text-left text-sm text-salmon-deep hover:underline"
                  >
                    {alert.customerName && `${alert.customerName} · `}{alert.contractNo && `${alert.contractNo} · `}{alert.message}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {!loading && !error && alerts.length > 10 && (
        <p className="mt-2 text-xs text-ink-soft">แสดง 10 รายการแรก (ทั้งหมด {alerts.length} รายการ)</p>
      )}
    </Card>
  )
}

// ---------- พยากรณ์กระแสเงินสด 3 เดือนข้างหน้า ----------
function ForecastView({ result }: { result: CashflowForecastResult }) {
  const { months, totalExpectedInflow, totalExpectedOutflow, totalNet, assumptions } = result

  if (months.length === 0) {
    return (
      <Card>
        <h3 className="mb-2 font-semibold text-ink">พยากรณ์ 3 เดือนข้างหน้า</h3>
        <p className="text-sm text-ink-soft">ไม่มีงวดที่ครบกำหนดในอนาคต</p>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {/* สรุปรวม */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="เงินเข้าคาดหวัง (รวม 3 เดือน)" value={`฿${money(totalExpectedInflow)}`} tone="text-green-600" />
        <Kpi label="เงินออกคาดหวัง (รวม 3 เดือน)" value={`฿${money(totalExpectedOutflow)}`} tone="text-amber-600" />
        <Kpi label="สุทธิคาดหวัง (รวม 3 เดือน)" value={`฿${money(totalNet)}`} tone={totalNet >= 0 ? 'text-green-600' : 'text-red-600'} />
      </div>

      {/* ตารางรายเดือน */}
      <Card>
        <h3 className="mb-3 font-semibold text-ink">พยากรณ์ 3 เดือนข้างหน้า (จากค่างวดในอนาคต × ความน่าจะเป็นตามเกรด)</h3>
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-peach text-left text-ink-soft">
                <th className="py-2 font-semibold">เดือน</th>
                <th className="py-2 text-right font-semibold">งวดที่ครบ</th>
                <th className="py-2 text-right font-semibold">คาดว่าจ่าย</th>
                <th className="py-2 text-right font-semibold">เงินเข้าคาดหวัง</th>
                <th className="py-2 text-right font-semibold">เงินออกคาดหวัง</th>
                <th className="py-2 text-right font-semibold">สุทธิ</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.monthLabel} className="border-b border-peach/50 last:border-0">
                  <td className="py-2 font-medium text-ink">{m.monthLabel}</td>
                  <td className="py-2 text-right text-ink-soft">{m.installmentCount}</td>
                  <td className="py-2 text-right text-ink-soft">{m.expectedPaidCount}</td>
                  <td className="py-2 text-right text-green-600">฿{money(m.expectedInflow)}</td>
                  <td className="py-2 text-right text-amber-600">฿{money(m.expectedOutflow)}</td>
                  <td className={`py-2 text-right font-semibold ${m.net >= 0 ? 'text-ink' : 'text-red-600'}`}>
                    {m.net >= 0 ? '+' : ''}฿{money(m.net)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-peach">
                <td className="py-2 font-semibold text-ink" colSpan={3}>รวม 3 เดือน</td>
                <td className="py-2 text-right font-semibold text-green-600">฿{money(totalExpectedInflow)}</td>
                <td className="py-2 text-right font-semibold text-amber-600">฿{money(totalExpectedOutflow)}</td>
                <td className={`py-2 text-right font-bold ${totalNet >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {totalNet >= 0 ? '+' : ''}฿{money(totalNet)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* กล่องสมมติฐาน */}
        <div className="mt-4 rounded-xl border border-peach bg-peach-light/40 p-3 text-xs text-ink-soft">
          <p className="mb-1 font-semibold text-ink">หมายเหตุ (สมมติฐานที่ใช้คำนวณ)</p>
          <p>
            · อัตราจ่ายตรงตามเกรดค้าง:{' '}
            {Object.entries(assumptions.payRateByGrade)
              .map(([g, r]) => `${g}=${Math.round(r * 100)}%`)
              .join(' · ')}
          </p>
          <p>· ลูกค้าที่จ่ายตรงกำหนด (ยังไม่มีเกรดค้าง) ใช้อัตราอนุรักษ์นิยม 50% ตัวเลขจริงอาจสูงกว่านี้</p>
          <p>
            · เงินออกเฉลี่ย:{' '}
            {assumptions.avgMonthlyOutflow > 0
              ? `฿${money(assumptions.avgMonthlyOutflow)}/เดือน (จากเงินโอนให้ร้านย้อนหลัง 3 เดือน)`
              : 'ไม่มีข้อมูลเงินออกย้อนหลัง (แสดง 0)'}
          </p>
          <p>· ตัวเลขนี้เป็นการประมาณการเท่านั้น ไม่ใช่การรับประกันการชำระ</p>
        </div>
      </Card>
    </div>
  )
}

// ---------- แนวโน้มหนี้ล่าช้า/หนี้เสียรายเดือน ----------
function OverdueTrendCard({ trend }: { trend: OverdueTrendResult }) {
  const { points } = trend

  // label format: "มิ.ย. 26" (CE year 2-digit suffix จาก execDashboard.ts)
  // derive CE = 2000 + parseInt(suffix), กรองเฉพาะปีที่มีข้อมูลจริง (overdueCount > 0 อย่างน้อย 1 เดือน)
  const availableYears = useMemo(() => {
    const ceMap = new Map<number, number>() // ce → max overdueCount ของปีนั้น
    for (const p of points) {
      const parts = p.label.split(' ')
      if (parts.length === 2) {
        const ce = 2000 + parseInt(parts[1], 10)
        ceMap.set(ce, Math.max(ceMap.get(ce) ?? 0, p.overdueCount))
      }
    }
    return Array.from(ceMap.entries())
      .filter(([, maxCount]) => maxCount > 0)
      .map(([ce]) => ce)
      .sort((a, b) => a - b)
  }, [points])

  const latestYear = availableYears[availableYears.length - 1] ?? new Date().getFullYear()
  const [trendMetric, setTrendMetric] = useState<'count' | 'amount'>('count')
  const [trendYear, setTrendYear] = useState<number>(latestYear)

  // sync trendYear เมื่อ availableYears เปลี่ยน (เช่น first render หรือข้อมูลโหลดใหม่)
  useEffect(() => {
    if (!availableYears.includes(trendYear)) {
      setTrendYear(latestYear)
    }
  }, [availableYears, latestYear, trendYear])

  // filter เฉพาะเดือนในปีที่เลือก
  const filteredPoints = useMemo(() => {
    return points.filter((p) => {
      const parts = p.label.split(' ')
      if (parts.length !== 2) return false
      return 2000 + parseInt(parts[1], 10) === trendYear
    })
  }, [points, trendYear])

  // MoM จากจุดสุดท้าย 2 จุดของ filtered list ตาม metric ที่กำลังดู
  const mom = useMemo(() => {
    if (filteredPoints.length < 2) return null
    const prev = filteredPoints[filteredPoints.length - 2]
    const last = filteredPoints[filteredPoints.length - 1]
    if (trendMetric === 'count') {
      return {
        overdue: last.overdueCount - prev.overdueCount,
        bad: last.badCount - prev.badCount,
        isCount: true,
      }
    } else {
      return {
        overdue: last.overdueAmount - prev.overdueAmount,
        bad: last.badAmount - prev.badAmount,
        isCount: false,
      }
    }
  }, [filteredPoints, trendMetric])

  /** format delta จำนวนเคส: +12 หรือ -5 */
  function fmtCount(delta: number): string {
    return `${delta >= 0 ? '+' : ''}${delta.toLocaleString('th-TH')} เคส`
  }
  /** format delta ยอดเงิน: +฿1.20M / -฿320K */
  function fmtAmt(delta: number): string {
    const sign = delta >= 0 ? '+' : '-'
    const abs = Math.abs(delta)
    if (abs >= 1_000_000) return `${sign}฿${(abs / 1_000_000).toFixed(2)}M`
    if (abs >= 10_000) return `${sign}฿${(abs / 1_000).toFixed(0)}K`
    return `${sign}฿${abs.toLocaleString('th-TH')}`
  }

  const labels = filteredPoints.map((p) => p.label.split(' ')[0]) // แสดงแค่ชื่อเดือน (ปีอยู่ใน dropdown แล้ว)

  const seriesCount = [
    { name: 'ค้างทั้งหมด (เคส)', color: '#f59e0b', values: filteredPoints.map((p) => p.overdueCount), fill: true as const },
    { name: 'หนี้เสีย (เคส)', color: '#dc2626', values: filteredPoints.map((p) => p.badCount) },
  ]
  const seriesAmount = [
    { name: 'ค้างทั้งหมด (พันบาท)', color: '#f59e0b', values: filteredPoints.map((p) => Math.round(p.overdueAmount / 1000)), fill: true as const },
    { name: 'หนี้เสีย (พันบาท)', color: '#dc2626', values: filteredPoints.map((p) => Math.round(p.badAmount / 1000)) },
  ]

  return (
    <Card>
      {/* Header row */}
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-ink">
            แนวโน้มหนี้ล่าช้า / หนี้เสีย
            <span className="ml-2 text-xs font-normal text-ink-soft">(ประมาณการ)</span>
          </h3>
          <p className="mt-0.5 text-xs text-ink-soft">สัญญาที่ค้างชำระรายเดือน ณ สิ้นเดือน</p>
        </div>

        {/* Controls: metric toggle + year dropdown */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Segmented toggle: จำนวนเคส / ยอดเงิน */}
          <div className="flex overflow-hidden rounded-xl border border-peach text-sm">
            <button
              onClick={() => setTrendMetric('count')}
              className={`px-3 py-1.5 font-medium transition ${
                trendMetric === 'count'
                  ? 'bg-salmon-deep text-white'
                  : 'bg-white text-ink-soft hover:bg-peach-light'
              }`}
            >
              จำนวนเคส
            </button>
            <button
              onClick={() => setTrendMetric('amount')}
              className={`px-3 py-1.5 font-medium transition ${
                trendMetric === 'amount'
                  ? 'bg-salmon-deep text-white'
                  : 'bg-white text-ink-soft hover:bg-peach-light'
              }`}
            >
              ยอดเงิน (บาท)
            </button>
          </div>

          {/* Year dropdown */}
          {availableYears.length > 1 && (
            <select
              value={trendYear}
              onChange={(e) => setTrendYear(Number(e.target.value))}
              className="rounded-xl border border-peach bg-white px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-salmon-deep/30"
            >
              {availableYears.map((ce) => (
                <option key={ce} value={ce}>
                  พ.ศ. {ce + 543}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* ===== บล็อกสรุปภาษาคน ===== */}
      {filteredPoints.length > 0 && (() => {
        const last = filteredPoints[filteredPoints.length - 1]
        const monthLabel = last.label // เช่น "มิ.ย. 26"
        const overdueCount = last.overdueCount
        const overdueAmt = last.overdueAmount
        const badCount = last.badCount
        const badAmt = last.badAmount

        const overdueDir = mom ? (mom.overdue > 0 ? 'up' : mom.overdue < 0 ? 'down' : 'flat') : 'flat'
        const badDir = mom ? (mom.bad > 0 ? 'up' : mom.bad < 0 ? 'down' : 'flat') : 'flat'

        const arrowOverdue = overdueDir === 'up' ? '▲' : overdueDir === 'down' ? '▼' : '—'
        const arrowBad = badDir === 'up' ? '▲' : badDir === 'down' ? '▼' : '—'
        const colorOverdue = overdueDir === 'up' ? 'text-red-600' : overdueDir === 'down' ? 'text-green-600' : 'text-ink-soft'
        const colorBad = badDir === 'up' ? 'text-red-600' : badDir === 'down' ? 'text-green-600' : 'text-ink-soft'

        const momOverdueStr = mom
          ? (mom.isCount
            ? `${arrowOverdue} ${mom.overdue >= 0 ? '+' : ''}${mom.overdue.toLocaleString('th-TH')} ราย`
            : `${arrowOverdue} ${fmtAmt(mom.overdue)}`)
          : null
        const momBadStr = mom
          ? (mom.isCount
            ? `${arrowBad} ${mom.bad >= 0 ? '+' : ''}${mom.bad.toLocaleString('th-TH')} ราย`
            : `${arrowBad} ${fmtAmt(mom.bad)}`)
          : null

        return (
          <div className="mb-4 rounded-2xl border-2 border-amber-200 bg-amber-50 px-4 py-4">
            <p className="mb-3 text-sm font-bold text-ink">
              สรุปเดือน {monthLabel}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {/* ค้างชำระทั้งหมด */}
              <div>
                <p className="mb-0.5 text-xs text-ink-soft">ค้างชำระทั้งหมด</p>
                <p className="text-2xl font-bold text-amber-700">
                  {trendMetric === 'count'
                    ? <>{overdueCount.toLocaleString('th-TH')} <span className="text-base font-normal">ราย</span></>
                    : <>{fmtAmt(overdueAmt).replace(/^[+-]/, '')}</>
                  }
                </p>
                {trendMetric === 'count' && (
                  <p className="mt-0.5 text-xs text-ink-soft">{fmtAmt(overdueAmt).replace(/^[+-]/, '')} คงค้าง</p>
                )}
                {momOverdueStr && (
                  <p className={`mt-1 text-sm font-semibold ${colorOverdue}`}>
                    {momOverdueStr}
                    <span className="ml-1 font-normal text-ink-soft">จากเดือนก่อน</span>
                  </p>
                )}
              </div>
              {/* หนี้เสีย */}
              <div>
                <p className="mb-0.5 text-xs text-ink-soft">หนี้เสีย (ค้าง ≥ 60 วัน)</p>
                <p className="text-2xl font-bold text-red-700">
                  {trendMetric === 'count'
                    ? <>{badCount.toLocaleString('th-TH')} <span className="text-base font-normal">ราย</span></>
                    : <>{fmtAmt(badAmt).replace(/^[+-]/, '')}</>
                  }
                </p>
                {trendMetric === 'count' && (
                  <p className="mt-0.5 text-xs text-ink-soft">{fmtAmt(badAmt).replace(/^[+-]/, '')} คงค้าง</p>
                )}
                {momBadStr && (
                  <p className={`mt-1 text-sm font-semibold ${colorBad}`}>
                    {momBadStr}
                    <span className="ml-1 font-normal text-ink-soft">จากเดือนก่อน</span>
                  </p>
                )}
              </div>
            </div>
          </div>
        )
      })()}

      {/* MoM badges (เล็ก ยังคงไว้เป็น reference) */}
      {mom && (
        <div className="mb-3 flex flex-wrap gap-2 text-xs">
          <div className="rounded-xl border border-peach bg-peach-light/50 px-3 py-1.5">
            <p className="font-semibold text-ink">ค้างทั้งหมด (vs เดือนก่อน)</p>
            <p className={mom.overdue > 0 ? 'font-medium text-red-600' : mom.overdue < 0 ? 'font-medium text-green-600' : 'text-ink-soft'}>
              {mom.isCount ? fmtCount(mom.overdue) : fmtAmt(mom.overdue)}
              {mom.overdue > 0 ? ' ↑' : mom.overdue < 0 ? ' ↓' : ''}
            </p>
          </div>
          <div className="rounded-xl border border-peach bg-peach-light/50 px-3 py-1.5">
            <p className="font-semibold text-ink">หนี้เสีย (vs เดือนก่อน)</p>
            <p className={mom.bad > 0 ? 'font-medium text-red-600' : mom.bad < 0 ? 'font-medium text-green-600' : 'text-ink-soft'}>
              {mom.isCount ? fmtCount(mom.bad) : fmtAmt(mom.bad)}
              {mom.bad > 0 ? ' ↑' : mom.bad < 0 ? ' ↓' : ''}
            </p>
          </div>
        </div>
      )}

      {filteredPoints.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-soft">ไม่มีข้อมูลในปีนี้</p>
      ) : (
        <LineChart
          labels={labels}
          valueSuffix={trendMetric === 'amount' ? 'K' : undefined}
          series={trendMetric === 'count' ? seriesCount : seriesAmount}
        />
      )}

      <p className="mt-2 text-xs text-ink-soft">
        * หนี้เสีย = ค้างชำระ ≥ 60 วัน · ค้างทั้งหมด = ค้างชำระ ≥ 1 วัน
        {trendMetric === 'amount' ? ' · ยอดเงินหน่วยพันบาท (K)' : ''}
        {' '}· ตัวเลขประมาณการจากข้อมูลปัจจุบัน
      </p>
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
