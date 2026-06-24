import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Printer } from 'lucide-react'
import { Button, Loading } from '../components/ui'
import { useAsync } from '../lib/useAsync'
import {
  getContracts,
  getAllStatuses,
  getAllInstallments,
  getCashflowDaily,
  getReturns,
  getEscalateContracts,
  getFreelancerPerformance,
  getOverduePromiseContracts,
  getAllOtherIncome,
  type DailyCashflowRow,
} from '../lib/db'
import { detectBottlenecks } from '../lib/bottleneck'
import { buildCashflow } from '../lib/execDashboard'
import type { Contract, ContractStatusRow } from '../lib/types'
import type { InstallmentLite } from '../lib/db'

// ===== date helpers =====

const MONTH_TH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function todayISO(): string {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)
}

/** วันจันทร์ของสัปดาห์ที่ d อยู่ */
function weekStartOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const dow = (x.getDay() + 6) % 7 // จันทร์=0 … อาทิตย์=6
  x.setDate(x.getDate() - dow)
  return x
}

/** สัปดาห์จาก ?week=YYYY-WW หรือสัปดาห์นี้ */
function resolveWeek(weekParam: string | null): { start: Date; end: Date } {
  if (weekParam) {
    const m = weekParam.match(/^(\d{4})-(\d{2})$/)
    if (m) {
      const year = Number(m[1])
      const week = Number(m[2])
      // ISO week: หา Jan 4 ปีนั้น (มั่นใจว่าอยู่ใน week 1) แล้วเลื่อน
      const jan4 = new Date(year, 0, 4)
      const start = weekStartOf(jan4)
      start.setDate(start.getDate() + (week - 1) * 7)
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6)
      return { start, end }
    }
  }
  const today = new Date()
  const start = weekStartOf(today)
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6)
  return { start, end }
}

function fmtDate(d: Date): string {
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear() + 543}`
}

function fmtDateFull(d: Date): string {
  return `${pad2(d.getDate())} ${MONTH_TH[d.getMonth()]} ${d.getFullYear() + 543}`
}

function fmtDateTime(): string {
  const now = new Date()
  const h = pad2(now.getHours())
  const min = pad2(now.getMinutes())
  return `${fmtDate(now)} ${h}:${min}`
}

function fmtBaht(n: number): string {
  return n.toLocaleString('th-TH', { maximumFractionDigits: 0 }) + ' ฿'
}

function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

// ===== loader =====

async function loadAll() {
  const [contracts, statuses, installments, dailyRows, returns_, escalate, freelancers, promiseOverdue, otherIncome] =
    await Promise.all([
      getContracts(),
      getAllStatuses(),
      getAllInstallments(),
      getCashflowDaily(),
      getReturns(),
      getEscalateContracts(),
      getFreelancerPerformance(7),
      getOverduePromiseContracts(),
      getAllOtherIncome(),
    ])
  return { contracts, statuses, installments, dailyRows, returns: returns_, escalate, freelancers, promiseOverdue, otherIncome }
}

type LoadedData = Awaited<ReturnType<typeof loadAll>>

// ===== aggregation helpers (pure) =====

interface WeekStats {
  totalContracts: number
  activeContracts: number
  portfolioValue: number // Σ financeAmount ของ active
  nplCount: number       // เกรด D+E
  nplPct: number         // นับสัญญา
  gradeA: number; gradeB: number; gradeC: number; gradeD: number; gradeE: number
  gradeTotal: number
  // งวดถึงกำหนดในสัปดาห์นี้ + เก็บได้
  dueThisWeek: number      // จำนวนงวด
  collectedThisWeek: number // ฿
  collectionRate: number
}

function computeWeekStats(
  contracts: Contract[],
  statuses: ContractStatusRow[],
  installments: InstallmentLite[],
  dailyRows: DailyCashflowRow[],
  weekStart: Date,
  weekEnd: Date,
): WeekStats {
  const startISO = dayKeyOf(weekStart)
  const endISO = dayKeyOf(weekEnd)

  const activeContracts = contracts.filter((c) => c.status === 'active').length
  const portfolioValue = contracts
    .filter((c) => c.status === 'active')
    .reduce((s, c) => s + (c.financeAmount ?? 0), 0)

  // เกรดจาก statuses (active เท่านั้น)
  const activeStatuses = statuses.filter((s) => s.status === 'active')
  let gradeA = 0, gradeB = 0, gradeC = 0, gradeD = 0, gradeE = 0
  for (const s of activeStatuses) {
    if (s.grade === 'A') gradeA++
    else if (s.grade === 'B') gradeB++
    else if (s.grade === 'C') gradeC++
    else if (s.grade === 'D') gradeD++
    else if (s.grade === 'E') gradeE++
  }
  const gradeTotal = gradeA + gradeB + gradeC + gradeD + gradeE
  const nplCount = gradeD + gradeE
  const nplPct = gradeTotal > 0 ? Math.round((nplCount / gradeTotal) * 100) : 0

  // งวดถึงกำหนดในสัปดาห์นี้ (dueDate ใน window)
  const dueInWeek = installments.filter((i) => i.dueDate >= startISO && i.dueDate <= endISO)
  const dueThisWeek = dueInWeek.length

  // ยอดชำระใน window — จาก v_cashflow_daily aggregate (payDate = YYYY-MM-DD ท้องถิ่น)
  const collectedThisWeek = dailyRows
    .filter((dr) => dr.payDate >= startISO && dr.payDate <= endISO)
    .reduce((s, dr) => s + dr.income, 0)

  // อัตราจัดเก็บ = เก็บได้ ÷ งวดที่ครบกำหนด (จำนวนงวด × ค่างวดเฉลี่ย)
  const expectedThisWeek = dueInWeek.reduce((s, i) => s + i.amount, 0)
  const collectionRate = expectedThisWeek > 0
    ? Math.round((collectedThisWeek / expectedThisWeek) * 100)
    : 0

  return {
    totalContracts: contracts.length,
    activeContracts,
    portfolioValue,
    nplCount,
    nplPct,
    gradeA, gradeB, gradeC, gradeD, gradeE,
    gradeTotal,
    dueThisWeek,
    collectedThisWeek,
    collectionRate,
  }
}

// ===== auto-generated recommendations =====

interface Recommendation {
  text: string
}

function buildRecommendations(stats: WeekStats, bottleneckCount: number): Recommendation[] {
  const recs: Recommendation[] = []

  if (stats.collectionRate < 70 && stats.dueThisWeek > 0) {
    recs.push({ text: `อัตราจัดเก็บอยู่ที่ ${stats.collectionRate}% — ต่ำกว่าเกณฑ์ อาจต้องเพิ่มการติดตาม` })
  }

  if (stats.nplPct > 20) {
    recs.push({ text: `NPL ${stats.nplPct}% สูงเกินเกณฑ์ 20% — พิจารณาเร่งจัดการเกรด D และ E` })
  }

  if (bottleneckCount > 0) {
    recs.push({ text: `มีเคสค้างในระบบ ${bottleneckCount} รายการ — ตรวจสอบหน้าติดตามเครื่องและรายการนัดชำระ` })
  }

  if (stats.gradeE > 0) {
    recs.push({ text: `เกรด E มี ${stats.gradeE} สัญญา — แนะนำส่งจดหมายตาม timeline` })
  }

  if (recs.length === 0) {
    recs.push({ text: 'ภาพรวมสัปดาห์นี้ปกติ ไม่พบความเสี่ยงเร่งด่วน' })
  }

  return recs
}

// ===== section components =====

function SectionTitle({ children }: { children: string }) {
  return (
    <div className="mb-3 mt-6 border-b-2 border-ink pb-1 print:mt-4">
      <h2 className="text-base font-bold text-ink">{children}</h2>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1 text-sm">
      <span className="text-ink-soft">{label}</span>
      <span className="font-semibold text-ink">{value}</span>
    </div>
  )
}

function GradeRow({ grade, count, total }: { grade: string; count: number; total: number }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <div className="flex items-center gap-2">
        <span className="w-16 font-medium text-ink">เกรด {grade}</span>
        <div className="h-2 w-32 overflow-hidden rounded-full bg-peach print:w-24">
          <div
            className="h-full rounded-full bg-salmon-deep"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <span className="text-ink-soft">{count} สัญญา ({pct}%)</span>
    </div>
  )
}

// ===== main page =====

export default function WeeklyReport() {
  const [searchParams] = useSearchParams()
  const weekParam = searchParams.get('week')

  const { start: weekStart, end: weekEnd } = useMemo(() => resolveWeek(weekParam), [weekParam])

  const { data, loading, error } = useAsync<LoadedData>(
    loadAll,
    { contracts: [], statuses: [], installments: [], dailyRows: [], returns: [], escalate: [], freelancers: [], promiseOverdue: [], otherIncome: [] },
  )

  const stats = useMemo(() => {
    if (!data.contracts.length && !data.statuses.length) return null
    return computeWeekStats(
      data.contracts,
      data.statuses,
      data.installments,
      data.dailyRows,
      weekStart,
      weekEnd,
    )
  }, [data, weekStart, weekEnd])

  // Cashflow สัปดาห์นี้ (buildCashflow: 1 week window รวม other income)
  const cashflow = useMemo(() => {
    if (!data.contracts.length && !data.dailyRows.length) return null
    const rows = buildCashflow(data.contracts, data.dailyRows, 'week', 1, todayISO(), undefined, data.otherIncome)
    return rows[0] ?? null
  }, [data])

  // Bottlenecks
  const bottlenecks = useMemo(() => {
    const deviceReturns = data.returns
      .filter((r) => r.deviceStatus && r.deviceStatus !== 'shipped')
      .map((r) => ({
        id: r.id,
        contractId: r.contractId,
        contractNo: r.contractNo,
        customerName: r.customerName,
        deviceStatus: r.deviceStatus ?? '',
        deviceStatusUpdatedAt: r.deviceStatusUpdatedAt ?? null,
      }))

    const promiseOverdue = data.promiseOverdue.map((p) => ({
      contractId: p.id,
      contractNo: p.contractCode,
      customerName: p.customerName,
      promiseToPayDate: p.promiseToPayDate,
    }))

    return detectBottlenecks({
      deviceReturns,
      contractsWithStatus: [],
      promiseOverdue,
      todayISO: todayISO(),
    })
  }, [data])

  const recommendations = useMemo(
    () => (stats ? buildRecommendations(stats, bottlenecks.length) : []),
    [stats, bottlenecks],
  )

  // ESCALATE total value
  const escalateValue = useMemo(
    () => data.escalate.reduce((s, c) => s + c.estOutstanding, 0),
    [data.escalate],
  )

  const today = todayISO()

  if (loading) return <Loading label="กำลังโหลดรายงานประจำสัปดาห์..." />

  if (error) {
    return (
      <div className="mx-auto max-w-3xl p-4">
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          โหลดข้อมูลไม่สำเร็จ: {error}
        </div>
      </div>
    )
  }

  return (
    <>
      {/* @media print: ซ่อนทุกอย่าง ยกเว้น #weekly-report */}
      <style>{`
        @media print {
          @page { margin: 1.5cm 1.8cm; }
          body * { visibility: hidden !important; }
          #weekly-report, #weekly-report * { visibility: visible !important; }
          #weekly-report { position: absolute; top: 0; left: 0; width: 100%; }
          #wr-print-btn { display: none !important; }
        }
      `}</style>

      <div id="weekly-report" className="mx-auto max-w-3xl space-y-1 p-4 md:p-6 print:p-0 print:text-sm">
        {/* หัวรายงาน */}
        <div className="flex items-start justify-between gap-4 print:block">
          <div>
            <h1 className="text-xl font-bold text-ink print:text-lg">WIN SURE PLUS — รายงานประจำสัปดาห์</h1>
            <p className="mt-1 text-sm text-ink-soft">
              สัปดาห์ที่: {fmtDateFull(weekStart)} – {fmtDateFull(weekEnd)}
            </p>
            <p className="text-sm text-ink-soft">สร้างเมื่อ: {fmtDateTime()}</p>
          </div>
          <div id="wr-print-btn" className="print:hidden">
            <Button
              variant="primary"
              onClick={() => window.print()}
            >
              <Printer size={16} />
              พิมพ์รายงาน
            </Button>
          </div>
        </div>

        {/* ─── สรุปภาพรวม ─── */}
        <SectionTitle>สรุปภาพรวม</SectionTitle>
        {stats ? (
          <div className="divide-y divide-peach rounded-xl border border-peach bg-white px-4 py-2 print:border-gray-300">
            <Row label="สัญญาทั้งหมด" value={`${stats.totalContracts.toLocaleString()} รายการ`} />
            <Row label="สัญญา active" value={`${stats.activeContracts.toLocaleString()} รายการ`} />
            <Row label="มูลค่าพอร์ต (จัดไฟแนนซ์)" value={fmtBaht(stats.portfolioValue)} />
            <Row label="NPL (เกรด D+E)" value={`${stats.nplPct}%  (${stats.nplCount} สัญญา)`} />
            <Row label="งวดถึงกำหนดสัปดาห์นี้" value={`${stats.dueThisWeek} งวด`} />
            <Row label="เก็บได้แล้ว (สัปดาห์นี้)" value={fmtBaht(stats.collectedThisWeek)} />
            <Row label="อัตราจัดเก็บ" value={`${stats.collectionRate}%`} />
          </div>
        ) : (
          <p className="text-sm text-ink-soft">(ไม่มีข้อมูลพอ)</p>
        )}

        {/* ─── กระจายตามเกรด ─── */}
        <SectionTitle>กระจายตามเกรด</SectionTitle>
        {stats && stats.gradeTotal > 0 ? (
          <div className="rounded-xl border border-peach bg-white px-4 py-2 print:border-gray-300">
            {(['A', 'B', 'C', 'D', 'E'] as const).map((g) => (
              <GradeRow
                key={g}
                grade={g}
                count={stats[`grade${g}` as 'gradeA' | 'gradeB' | 'gradeC' | 'gradeD' | 'gradeE']}
                total={stats.gradeTotal}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-ink-soft">(ไม่มีข้อมูลเกรด)</p>
        )}

        {/* ─── เงินสดสัปดาห์นี้ ─── */}
        <SectionTitle>เงินสด สัปดาห์นี้</SectionTitle>
        {cashflow ? (
          <div className="divide-y divide-peach rounded-xl border border-peach bg-white px-4 py-2 print:border-gray-300">
            <Row label="เงินเข้า (ค่างวด + ดาวน์ + รายได้อื่นๆ)" value={fmtBaht(cashflow.income)} />
            <Row label="เงินออก (โอนให้ร้านสัญญาใหม่)" value={fmtBaht(cashflow.expense)} />
            <Row label="สุทธิ" value={fmtBaht(cashflow.net)} />
            <Row label="สัญญาใหม่" value={`${cashflow.newCases} รายการ`} />
          </div>
        ) : (
          <p className="text-sm text-ink-soft">(ไม่มีข้อมูลกระแสเงินสด)</p>
        )}

        {/* ─── Bottlenecks ─── */}
        <SectionTitle>{`สิ่งที่ต้องเร่งดำเนินการ (Top ${Math.min(bottlenecks.length, 5)} Bottlenecks)`}</SectionTitle>
        {bottlenecks.length > 0 ? (
          <div className="rounded-xl border border-peach bg-white px-4 py-2 print:border-gray-300">
            <ol className="list-decimal list-inside space-y-1.5">
              {bottlenecks.slice(0, 5).map((b, i) => (
                <li key={i} className="text-sm">
                  <span className={b.severity === 'red' ? 'font-semibold text-red-600' : 'text-amber-700'}>
                    {b.customerName ?? b.contractNo ?? '-'}
                  </span>
                  {' '}— {b.message}
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <div className="rounded-xl border border-peach bg-white px-4 py-2 print:border-gray-300">
            <p className="py-1 text-sm text-ink-soft">ไม่มีเคสค้างในระบบ</p>
          </div>
        )}

        {/* ─── ESCALATE Recovery ─── */}
        <SectionTitle>ESCALATE Recovery</SectionTitle>
        <div className="rounded-xl border border-peach bg-white px-4 py-2 print:border-gray-300">
          <Row
            label="เคสที่ต้องเร่ง"
            value={`${data.escalate.length} ราย · มูลค่ารวม ${fmtBaht(escalateValue)}`}
          />
          {data.escalate.length === 0 && (
            <p className="pb-1 text-sm text-ink-soft">ไม่มีเคส ESCALATE ขณะนี้</p>
          )}
        </div>

        {/* ─── ผลงานทีม ─── */}
        <SectionTitle>ผลงานทีมสัปดาห์นี้ (7 วันล่าสุด)</SectionTitle>
        {data.freelancers.length > 0 ? (
          <div className="overflow-hidden rounded-xl border border-peach bg-white print:border-gray-300">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-peach bg-peach-light/40 text-left print:border-gray-300">
                  <th className="px-4 py-2 font-semibold text-ink">พนักงาน</th>
                  <th className="px-4 py-2 font-semibold text-ink text-right">ติดตาม (ครั้ง)</th>
                  <th className="px-4 py-2 font-semibold text-ink text-right">สัญญา (รายการ)</th>
                  <th className="px-4 py-2 font-semibold text-ink text-right">แก้ไขสำเร็จ</th>
                </tr>
              </thead>
              <tbody>
                {data.freelancers.map((f) => (
                  <tr key={f.authorId} className="border-b border-peach last:border-0 print:border-gray-200">
                    <td className="px-4 py-2 text-ink">{f.fullName || '-'}</td>
                    <td className="px-4 py-2 text-right text-ink">{f.totalAttempts.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right text-ink">{f.uniqueContracts.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right text-ink">{f.resolutionCount.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-ink-soft">(ไม่มีข้อมูลพอ — ดูเพิ่มที่หน้า สรุปภาพรวมการติดตามหนี้)</p>
        )}

        {/* ─── ข้อเสนอแนะ ─── */}
        <SectionTitle>ข้อเสนอแนะ</SectionTitle>
        <div className="rounded-xl border border-peach bg-white px-4 py-3 print:border-gray-300">
          {recommendations.length > 0 ? (
            <ul className="space-y-1.5">
              {recommendations.map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-ink">
                  <span className="mt-0.5 shrink-0 text-salmon-deep">·</span>
                  <span>{r.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-soft">(ไม่มีข้อมูลพอ)</p>
          )}
        </div>

        {/* footer */}
        <div className="pt-6 text-right text-xs text-ink-soft print:pt-4">
          สร้างโดย WIN SURE PLUS · {today}
        </div>
      </div>
    </>
  )
}
