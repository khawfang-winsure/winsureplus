import { useEffect, useMemo, useState } from 'react'
import { Badge, Card, EmptyState, Loading, PageTitle } from '../components/ui'
import {
  DateRangePicker,
  loadStoredRange,
  fmtThaiShort,
  daysBetween,
  type DateRange,
} from '../components/DateRangePicker'
import {
  getMyScorecard,
  type MyScorecardGradeRow,
  type MyScorecardResult,
} from '../lib/db'
import { baht } from '../lib/format'

// ===== ประเภท (จาก db.ts — น้องชีสเพิ่มแล้ว) =====
type ScorecardData = MyScorecardResult
type ByGradeRow = MyScorecardGradeRow

// ===== helpers =====

const todayISO = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)

function effectiveRange(range: DateRange | null): DateRange {
  return range ?? { start: '2020-01-01', end: todayISO }
}

/** ฿ — "—" ถ้า null (ไม่มีข้อมูล), แสดง "฿0" ถ้าค่าเป็น 0 จริง */
function fmtBaht(n: number | null): string {
  if (n === null) return '—'
  return `฿${baht(n)}`
}

/** อัตราติดต่อ % — "—" ถ้า null (ยังไม่มีข้อมูล) */
function fmtRate(value: number | null): string {
  if (value === null) return '—'
  return `${value.toFixed(1)}%`
}

/** ฿/สาย — "—" ถ้า null */
function fmtPerCall(n: number | null): string {
  if (n === null) return '—'
  return `฿${baht(n)}`
}

/** tone สีสำหรับ contact-rate */
function rateCls(value: number | null): string {
  if (value === null) return 'text-ink-soft'
  if (value >= 60) return 'font-semibold text-green-700'
  if (value < 30) return 'font-semibold text-red-600'
  return 'text-ink'
}

type ContractGrade = 'A' | 'B' | 'C' | 'D' | 'E'
const GRADE_TONE: Record<ContractGrade, 'neutral' | 'amber' | 'red'> = {
  A: 'neutral',
  B: 'neutral',
  C: 'amber',
  D: 'amber',
  E: 'red',
}

// ===== Component =====

export default function MyPerformance() {
  const [data, setData] = useState<ScorecardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [range, setRange] = useState<DateRange | null>(() =>
    loadStoredRange('my-performance.dateRange', 'thisMonth'),
  )

  useEffect(() => {
    if (!loading) setRefreshing(true)
    const eff = effectiveRange(range)
    getMyScorecard(eff.start, eff.end)
      .then((d) => {
        setData(d)
        setLoading(false)
        setRefreshing(false)
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ')
        setLoading(false)
        setRefreshing(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range])

  const rangeLabel = useMemo(() => {
    if (!range) return 'ทั้งหมด'
    return `${fmtThaiShort(range.start)} – ${fmtThaiShort(range.end)} (${daysBetween(range.start, range.end)} วัน)`
  }, [range])

  if (loading) return <Loading label="กำลังโหลดผลงานของคุณ..." />

  const totals = data?.totals
  const byGrade = data?.byGrade ?? []
  const isEmpty = totals !== undefined && totals.calls === 0 && totals.collectedBaht === 0

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <PageTitle sub={`ช่วง ${rangeLabel}`}>ผลงานของฉัน</PageTitle>

      {/* ช่วงเวลา */}
      <DateRangePicker
        storageKey="my-performance.dateRange"
        defaultPreset="thisMonth"
        value={range}
        onChange={setRange}
      />

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Empty state */}
      {!error && isEmpty && (
        <EmptyState
          title="ยังไม่มีข้อมูลผลงานในช่วงนี้"
          hint="เริ่มบันทึกการโทรในเมนู 'คิวงาน' แล้วผลงานจะมาแสดงที่นี่"
        />
      )}

      {/* Stat cards */}
      {!error && totals !== undefined && !isEmpty && (
        <>
          <div className={refreshing ? 'opacity-60 transition-opacity' : ''}>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {/* เก็บได้ */}
              <Card className="text-center">
                <div className="text-2xl font-bold text-ink">{fmtBaht(totals.collectedBaht)}</div>
                <div className="mt-1 text-xs text-ink-soft">เก็บได้ (฿)</div>
              </Card>
              {/* โทร */}
              <Card className="text-center">
                <div className="text-2xl font-bold text-ink">
                  {totals.calls.toLocaleString('th-TH')}
                </div>
                <div className="mt-1 text-xs text-ink-soft">โทร (สาย)</div>
              </Card>
              {/* ดูแล */}
              <Card className="text-center">
                <div className="text-2xl font-bold text-ink">
                  {totals.uniqueContracts.toLocaleString('th-TH')}
                </div>
                <div className="mt-1 text-xs text-ink-soft">ดูแล (คน)</div>
              </Card>
              {/* อัตราติดต่อสำเร็จ */}
              <Card className="text-center">
                <div className={`text-2xl font-bold ${rateCls(totals.contactRate)}`}>
                  {fmtRate(totals.contactRate)}
                </div>
                <div className="mt-1 text-xs text-ink-soft">อัตราติดต่อสำเร็จ</div>
              </Card>
            </div>

            {/* ฿/สาย — แสดงถ้า calls > 0 */}
            {totals.bahtPerCall !== null && (
              <div className="mt-3 rounded-xl border border-peach bg-white px-4 py-3 text-center">
                <span className="text-lg font-semibold text-ink">
                  {fmtPerCall(totals.bahtPerCall)}
                </span>
                <span className="ml-2 text-sm text-ink-soft">ต่อสาย</span>
              </div>
            )}
          </div>

          {/* Per-grade breakdown */}
          {byGrade.length > 0 && (
            <Card>
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-soft">
                แยกตามเกรดสัญญา
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-peach text-xs text-ink-soft">
                      <th className="pb-1.5 text-left font-medium">เกรด</th>
                      <th className="pb-1.5 text-right font-medium">ยอดเก็บ (฿)</th>
                      <th className="pb-1.5 text-right font-medium">สาย</th>
                      <th className="pb-1.5 text-right font-medium">สัญญาที่ดูแล</th>
                      <th className="pb-1.5 text-right font-medium">฿/สาย</th>
                      <th className="pb-1.5 text-right font-medium">อัตราโทรติด</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byGrade
                      .slice()
                      .sort((a: ByGradeRow, b: ByGradeRow) => a.grade.localeCompare(b.grade))
                      .map((g: ByGradeRow) => (
                        <tr key={g.grade} className="border-b border-peach/40 last:border-0">
                          <td className="py-1.5">
                            <Badge tone={GRADE_TONE[g.grade] ?? 'neutral'}>เกรด {g.grade}</Badge>
                          </td>
                          <td className="py-1.5 text-right font-medium">{fmtBaht(g.collectedBaht)}</td>
                          <td className="py-1.5 text-right">{g.calls.toLocaleString('th-TH')}</td>
                          <td className="py-1.5 text-right">{g.uniqueContracts.toLocaleString('th-TH')}</td>
                          <td className="py-1.5 text-right">{fmtPerCall(g.bahtPerCall)}</td>
                          <td className={`py-1.5 text-right ${rateCls(g.contactRate)}`}>
                            {fmtRate(g.contactRate)}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
