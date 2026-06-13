import { useEffect, useState } from 'react'
import { ChevronRight, X } from 'lucide-react'
import { Card, PageTitle, Badge, Loading, EmptyState } from '../components/ui'
import {
  getFreelancerPerformance,
  type FreelancerPerformanceRow,
} from '../lib/db'
import {
  computePerformanceKPIs,
  type PerformanceInput,
} from '../lib/freelancerPerformance'

// ===== ตัวช่วย =====

/** ฟอร์แมต ISO timestamp เป็น "12 มิ.ย. 21:45" */
const MONTH_SHORT: string[] = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
]
function fmtDatetime(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '-'
  const day = d.getDate()
  const mon = MONTH_SHORT[d.getMonth()]
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${day} ${mon} ${hh}:${mm}`
}

/**
 * แสดง rate เป็น "X.X%" ถ้า value ไม่ใช่ null
 * null (N/A sentinel จาก computePerformanceKPIs) → "N/A"
 */
function fmtRate(value: number | null): string {
  if (value === null) return 'N/A'
  return `${value.toFixed(1)}%`
}

/** tone สำหรับเซลล์ rate (highlight ถ้าต่ำ/สูงเกิน) */
function rateCls(value: number | null, higherIsBetter: boolean): string {
  if (value === null) return 'text-ink-soft'
  if (higherIsBetter) {
    if (value >= 60) return 'font-semibold text-green-700'
    if (value < 30) return 'font-semibold text-red-600'
  } else {
    // escalation: ต่ำดี
    if (value <= 5) return 'font-semibold text-green-700'
    if (value > 20) return 'font-semibold text-red-600'
  }
  return 'text-ink'
}

// ===== แปลง FreelancerPerformanceRow → PerformanceInput =====
// Wave 2: ใช้ real attribution fields จาก db.ts
function toInput(row: FreelancerPerformanceRow): PerformanceInput {
  return {
    totalAttempts: row.totalAttempts,
    successfulAttempts: row.successfulAttempts,
    promiseCount: row.promiseCount,
    resolutionCount: row.resolutionCount,
    uniqueContracts: row.uniqueContracts,
    promiseKeptCount: row.promiseKeptCount,
    promiseKeptCredit: row.promiseKeptCredit,
    promisesTotal: row.promisesTotal,
    escalateContracts: row.escalateContracts,
    totalAssigned: row.totalAssigned,
  }
}

// ===== Grade badge =====
type ContractGrade = 'A' | 'B' | 'C' | 'D' | 'E'
const GRADE_TONE: Record<ContractGrade, 'neutral' | 'amber' | 'red'> = {
  A: 'neutral',
  B: 'neutral',
  C: 'amber',
  D: 'amber',
  E: 'red',
}
function gradeStr(grades: string[]): string {
  return grades.length > 0 ? grades.sort().join(', ') : '-'
}

// ===== Team summary (เฉลี่ยเฉพาะแถวที่มี denom > 0) =====
interface TeamSummary {
  avgContactRate: number | null
  avgPromiseRate: number | null
  avgPromiseKeepRate: number | null
  avgEscalationRate: number | null
}
function computeTeamSummary(rows: FreelancerPerformanceRow[]): TeamSummary {
  let cSum = 0, cCount = 0
  let prSum = 0, prCount = 0
  let pkSum = 0, pkCount = 0
  let esSum = 0, esCount = 0

  for (const row of rows) {
    const kpi = computePerformanceKPIs(toInput(row))
    // null = N/A (denominator=0) → exclude from team average
    if (kpi.contactRate !== null)    { cSum  += kpi.contactRate;    cCount++ }
    if (kpi.promiseRate !== null)    { prSum += kpi.promiseRate;    prCount++ }
    if (kpi.promiseKeepRate !== null){ pkSum += kpi.promiseKeepRate; pkCount++ }
    if (kpi.escalationRate !== null) { esSum += kpi.escalationRate; esCount++ }
  }

  return {
    avgContactRate:     cCount  > 0 ? Math.round((cSum  / cCount)  * 10) / 10 : null,
    avgPromiseRate:     prCount > 0 ? Math.round((prSum / prCount) * 10) / 10 : null,
    avgPromiseKeepRate: pkCount > 0 ? Math.round((pkSum / pkCount) * 10) / 10 : null,
    avgEscalationRate:  esCount > 0 ? Math.round((esSum / esCount) * 10) / 10 : null,
  }
}

// ===== DrillDown Panel =====
interface DrillDownProps {
  row: FreelancerPerformanceRow
  onClose: () => void
  daysWindow: number
}

function DrillDownPanel({ row, onClose, daysWindow }: DrillDownProps) {
  const inp = toInput(row)
  const kpi = computePerformanceKPIs(inp)

  const kpiCards: { label: string; value: string; kpiVal: number | null; higherIsBetter: boolean }[] = [
    { label: 'Contact Rate', value: fmtRate(kpi.contactRate),    kpiVal: kpi.contactRate,    higherIsBetter: true },
    { label: 'Promise Rate', value: fmtRate(kpi.promiseRate),    kpiVal: kpi.promiseRate,    higherIsBetter: true },
    { label: 'Promise Keep', value: fmtRate(kpi.promiseKeepRate),kpiVal: kpi.promiseKeepRate,higherIsBetter: true },
    { label: 'Resolution',   value: fmtRate(kpi.resolutionRate), kpiVal: kpi.resolutionRate, higherIsBetter: true },
    { label: 'Escalation',   value: fmtRate(kpi.escalationRate), kpiVal: kpi.escalationRate, higherIsBetter: false },
  ]

  return (
    <Card className="mt-2 border-salmon/30 bg-cream-deep/80">
      {/* Header */}
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h3 className="text-base font-bold text-ink">{row.fullName}</h3>
          <p className="mt-0.5 text-sm text-ink-soft">
            เกรดที่รับ: <span className="font-medium text-ink">{gradeStr(row.assignedGrades)}</span>
            &nbsp;·&nbsp;อีเมล: <span className="text-ink">-</span>
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-ink-soft hover:bg-peach/50 hover:text-ink"
          aria-label="ปิด"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* KPI Cards */}
      <div className="mb-5 grid grid-cols-5 gap-3">
        {kpiCards.map((k) => (
          <div
            key={k.label}
            className="rounded-xl border border-peach bg-white px-3 py-3 text-center"
          >
            <div className={`text-xl font-bold ${k.kpiVal === null ? 'text-ink-soft' : 'text-ink'}`}>
              {k.value}
            </div>
            <div className="mt-1 text-xs text-ink-soft">{k.label}</div>
          </div>
        ))}
      </div>

      {/* Per-Grade Breakdown */}
      {row.byGrade.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">
            Per-Grade Breakdown
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-peach text-xs text-ink-soft">
                <th className="pb-1.5 text-left font-medium">เกรด</th>
                <th className="pb-1.5 text-right font-medium">Contacts</th>
                <th className="pb-1.5 text-right font-medium">Attempts</th>
                <th className="pb-1.5 text-right font-medium">สัญญา</th>
                <th className="pb-1.5 text-right font-medium">Promised</th>
                <th className="pb-1.5 text-right font-medium">Resolved</th>
              </tr>
            </thead>
            <tbody>
              {row.byGrade
                .slice()
                .sort((a, b) => a.grade.localeCompare(b.grade))
                .map((g) => (
                  <tr key={g.grade} className="border-b border-peach/40 last:border-0">
                    <td className="py-1.5">
                      <Badge tone={GRADE_TONE[g.grade as ContractGrade] ?? 'neutral'}>
                        เกรด {g.grade}
                      </Badge>
                    </td>
                    <td className="py-1.5 text-right font-medium">{g.successfulAttempts}</td>
                    <td className="py-1.5 text-right">{g.totalAttempts}</td>
                    <td className="py-1.5 text-right">{g.uniqueContracts}</td>
                    <td className="py-1.5 text-right">{g.promiseCount}</td>
                    <td className="py-1.5 text-right">{g.resolutionCount}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
      {row.byGrade.length === 0 && (
        <p className="text-sm text-ink-soft">ยังไม่มีข้อมูล follow-up ใน {daysWindow} วันล่าสุด</p>
      )}

      {/* Last activity */}
      <p className="mt-4 text-xs text-ink-soft">
        Last activity: {fmtDatetime(row.lastActivityAt)}
      </p>
    </Card>
  )
}

// ===== Main Page =====

export default function StaffPerformance() {
  const [rows, setRows] = useState<FreelancerPerformanceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [daysWindow, setDaysWindow] = useState<7 | 30 | 90>(30)

  useEffect(() => {
    if (!loading) setRefreshing(true)
    getFreelancerPerformance(daysWindow)
      .then((d) => {
        setRows(d)
        setSelectedId(null)
        setLoading(false)
        setRefreshing(false)
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ')
        setLoading(false)
        setRefreshing(false)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daysWindow])

  const teamSummary = computeTeamSummary(rows)

  const selectedRow = rows.find((r) => r.authorId === selectedId) ?? null

  function toggleSelect(id: string) {
    setSelectedId((prev) => (prev === id ? null : id))
  }

  if (loading) return <Loading label="กำลังโหลดข้อมูล performance..." />

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-start justify-between">
        <PageTitle sub={`ข้อมูล ${daysWindow} วันล่าสุด`} count={{ shown: rows.length }}>
          สรุปภาพรวมการติดตามหนี้
        </PageTitle>
        <select
          value={daysWindow}
          onChange={(e) => setDaysWindow(Number(e.target.value) as 7 | 30 | 90)}
          disabled={refreshing}
          className="rounded-xl border border-peach bg-white px-3 py-1.5 text-sm text-ink outline-none transition focus:border-salmon-deep disabled:opacity-50"
        >
          <option value={7}>7 วันล่าสุด</option>
          <option value={30}>30 วันล่าสุด</option>
          <option value={90}>90 วันล่าสุด</option>
        </select>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Section 1: Team Summary */}
      <Card>
        <p className="mb-3 text-sm font-semibold text-ink-soft uppercase tracking-wide">
          Team Summary
        </p>
        <div className="grid grid-cols-4 gap-4">
          {[
            { label: 'Contact Rate เฉลี่ย', val: teamSummary.avgContactRate },
            { label: 'Promise Rate เฉลี่ย', val: teamSummary.avgPromiseRate },
            { label: 'Promise Keep Rate เฉลี่ย', val: teamSummary.avgPromiseKeepRate },
            { label: 'Escalation เฉลี่ย', val: teamSummary.avgEscalationRate },
          ].map((item) => (
            <div key={item.label} className="rounded-xl border border-peach bg-white px-4 py-3">
              <div className="text-2xl font-bold text-ink">
                {item.val !== null ? `${item.val.toFixed(1)}%` : 'N/A'}
              </div>
              <div className="mt-1 text-xs text-ink-soft">{item.label}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Section 2: Leaderboard */}
      {rows.length === 0 && !error ? (
        <EmptyState
          title="ยังไม่มีผู้ติดตามหนี้"
          hint="เพิ่ม freelancer ในระบบและมอบหมายเกรดก่อนค่ะ"
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-peach bg-peach-light/40">
                  <th className="px-4 py-3 text-left font-semibold text-ink">ชื่อ</th>
                  <th className="px-4 py-3 text-left font-semibold text-ink">เกรด</th>
                  <th className="px-4 py-3 text-right font-semibold text-ink">Contact</th>
                  <th className="px-4 py-3 text-right font-semibold text-ink">Promise</th>
                  <th className="px-4 py-3 text-right font-semibold text-ink">Keep</th>
                  <th className="px-4 py-3 text-right font-semibold text-ink">Resolution</th>
                  <th className="px-4 py-3 text-right font-semibold text-ink">Escalation</th>
                  <th className="px-4 py-3 text-right font-semibold text-ink">Last Active</th>
                  <th className="w-10 px-4 py-3" />
                </tr>
              </thead>
              {rows.map((row) => {
                const kpi = computePerformanceKPIs(toInput(row))
                const isSelected = selectedId === row.authorId
                return (
                  <tbody key={row.authorId}>
                    <tr
                      className={`cursor-pointer border-b border-peach/50 transition-colors hover:bg-peach-light/30 ${
                        isSelected ? 'bg-peach-light/50' : ''
                      }`}
                      onClick={() => toggleSelect(row.authorId)}
                    >
                      {/* ชื่อ */}
                      <td className="px-4 py-3 font-medium text-ink">{row.fullName}</td>
                      {/* เกรด */}
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {row.assignedGrades.length > 0
                            ? row.assignedGrades
                                .sort()
                                .map((g) => (
                                  <Badge
                                    key={g}
                                    tone={GRADE_TONE[g as ContractGrade] ?? 'neutral'}
                                  >
                                    {g}
                                  </Badge>
                                ))
                            : <span className="text-ink-soft">-</span>}
                        </div>
                      </td>
                      {/* Contact Rate */}
                      <td className={`px-4 py-3 text-right ${rateCls(kpi.contactRate, true)}`}>
                        {fmtRate(kpi.contactRate)}
                      </td>
                      {/* Promise Rate */}
                      <td className={`px-4 py-3 text-right ${rateCls(kpi.promiseRate, true)}`}>
                        {fmtRate(kpi.promiseRate)}
                      </td>
                      {/* Promise Keep Rate */}
                      <td className={`px-4 py-3 text-right ${rateCls(kpi.promiseKeepRate, true)}`}>
                        {fmtRate(kpi.promiseKeepRate)}
                      </td>
                      {/* Resolution Rate */}
                      <td className={`px-4 py-3 text-right ${rateCls(kpi.resolutionRate, true)}`}>
                        {fmtRate(kpi.resolutionRate)}
                      </td>
                      {/* Escalation Rate */}
                      <td className={`px-4 py-3 text-right ${rateCls(kpi.escalationRate, false)}`}>
                        {fmtRate(kpi.escalationRate)}
                      </td>
                      {/* Last Active */}
                      <td className="px-4 py-3 text-right text-xs text-ink-soft">
                        {fmtDatetime(row.lastActivityAt)}
                      </td>
                      {/* Drill-down toggle */}
                      <td className="px-4 py-3 text-right">
                        <ChevronRight
                          className={`h-4 w-4 text-ink-soft transition-transform ${isSelected ? 'rotate-90' : ''}`}
                        />
                      </td>
                    </tr>
                    {/* Drill-down row */}
                    {isSelected && selectedRow && (
                      <tr>
                        <td colSpan={9} className="px-4 pb-4">
                          <DrillDownPanel
                            row={selectedRow}
                            onClose={() => setSelectedId(null)}
                            daysWindow={daysWindow}
                          />
                        </td>
                      </tr>
                    )}
                  </tbody>
                )
              })}
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
