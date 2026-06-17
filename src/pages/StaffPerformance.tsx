import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, Download, X } from 'lucide-react'
import { Button, Card, PageTitle, Badge, Loading, EmptyState } from '../components/ui'
import {
  DateRangePicker,
  loadStoredRange,
  fmtThaiShort,
  daysBetween,
  type DateRange,
} from '../components/DateRangePicker'
import {
  getDeviceReturnCountsByFreelancerThisMonth,
  getDeviceReturnTiers,
  getCollectorScorecard,
  type CollectorScorecardRow,
} from '../lib/db'
import { deviceReturnCommissionMonthly, type DeviceReturnTier } from '../lib/commission'
import { baht } from '../lib/format'

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
 * null (N/A sentinel — total_attempts=0) → "N/A"
 */
function fmtRate(value: number | null): string {
  if (value === null) return 'N/A'
  return `${value.toFixed(1)}%`
}

/** tone สำหรับเซลล์ contact-rate (สูงดี) */
function rateCls(value: number | null): string {
  if (value === null) return 'text-ink-soft'
  if (value >= 60) return 'font-semibold text-green-700'
  if (value < 30) return 'font-semibold text-red-600'
  return 'text-ink'
}

/** เงิน: "฿1,234" หรือ "—" ถ้า 0 / null */
function fmtBaht(n: number | null): string {
  if (n === null || n === 0) return '—'
  return `฿${baht(n)}`
}

/** ฿/สาย: "฿123" หรือ "—" ถ้า null (0 สาย) */
function fmtPerCall(n: number | null): string {
  if (n === null) return '—'
  return `฿${baht(n)}`
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
  return grades.length > 0 ? grades.slice().sort().join(', ') : '-'
}

// ===== Team summary =====
interface TeamSummary {
  totalCollected: number
  totalCalls: number
  totalContracts: number
  avgContactRate: number | null
}
function computeTeamSummary(rows: CollectorScorecardRow[]): TeamSummary {
  let totalCollected = 0
  let totalCalls = 0
  let totalContracts = 0
  let crSum = 0, crCount = 0

  for (const row of rows) {
    totalCollected += row.collectedBaht
    totalCalls += row.calls
    totalContracts += row.uniqueContracts
    // null = N/A (total_attempts=0) → exclude from team average
    if (row.contactRate !== null) { crSum += row.contactRate; crCount++ }
  }

  return {
    totalCollected,
    totalCalls,
    totalContracts,
    avgContactRate: crCount > 0 ? Math.round((crSum / crCount) * 10) / 10 : null,
  }
}

// ===== CSV Export =====

/** escape CSV cell: wrap in quotes if contains comma, quote, or newline */
function escCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function generateCSV(rows: CollectorScorecardRow[]): string {
  const headers = [
    'ชื่อ',
    'เกรดที่ดูแล',
    'ยอดเก็บจากโทร (฿)',
    'จำนวนสาย',
    'สัญญาที่ดูแล',
    '฿/สาย',
    'อัตราโทรติด (%)',
    'กิจกรรมล่าสุด',
  ]

  const csvRows: string[] = [headers.map(escCell).join(',')]
  for (const r of rows) {
    csvRows.push(
      [
        escCell(r.fullName),
        escCell(gradeStr(r.assignedGrades)),
        escCell(Math.round(r.collectedBaht)),
        escCell(r.calls),
        escCell(r.uniqueContracts),
        escCell(r.bahtPerCall !== null ? Math.round(r.bahtPerCall) : 'N/A'),
        escCell(r.contactRate !== null ? r.contactRate.toFixed(1) : 'N/A'),
        escCell(
          r.lastActivityAt
            ? new Date(r.lastActivityAt).toLocaleDateString('th-TH')
            : '-',
        ),
      ].join(','),
    )
  }

  // '﻿' = UTF-8 BOM — ensures Excel reads Thai characters correctly
  return '﻿' + csvRows.join('\r\n')
}

function downloadCSV(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

// ===== DrillDown Panel =====
interface DrillDownProps {
  row: CollectorScorecardRow
  onClose: () => void
  rangeLabel: string
}

function DrillDownPanel({ row, onClose, rangeLabel }: DrillDownProps) {
  const summaryCards: { label: string; value: string; muted: boolean }[] = [
    { label: '💰 ยอดเก็บจากโทร', value: fmtBaht(row.collectedBaht), muted: row.collectedBaht === 0 },
    { label: '📞 จำนวนสาย', value: row.calls.toLocaleString('th-TH'), muted: row.calls === 0 },
    { label: '👥 สัญญาที่ดูแล', value: row.uniqueContracts.toLocaleString('th-TH'), muted: row.uniqueContracts === 0 },
    { label: '฿/สาย', value: fmtPerCall(row.bahtPerCall), muted: row.bahtPerCall === null },
    { label: 'อัตราโทรติด', value: fmtRate(row.contactRate), muted: row.contactRate === null },
  ]

  return (
    <Card className="mt-2 border-salmon/30 bg-cream-deep/80">
      {/* Header */}
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h3 className="text-base font-bold text-ink">{row.fullName}</h3>
          <p className="mt-0.5 text-sm text-ink-soft">
            เกรดที่รับ: <span className="font-medium text-ink">{gradeStr(row.assignedGrades)}</span>
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

      {/* Summary Cards */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {summaryCards.map((k) => (
          <div
            key={k.label}
            className="rounded-xl border border-peach bg-white px-3 py-3 text-center"
          >
            <div className={`text-xl font-bold ${k.muted ? 'text-ink-soft' : 'text-ink'}`}>
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
            แยกตามเกรดสัญญา
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-peach text-xs text-ink-soft">
                <th className="pb-1.5 text-left font-medium">เกรด</th>
                <th className="pb-1.5 text-right font-medium">ยอดเก็บ (฿)</th>
                <th className="pb-1.5 text-right font-medium">จำนวนสาย</th>
                <th className="pb-1.5 text-right font-medium">สัญญาที่ดูแล</th>
                <th className="pb-1.5 text-right font-medium">฿/สาย</th>
                <th className="pb-1.5 text-right font-medium">อัตราโทรติด</th>
              </tr>
            </thead>
            <tbody>
              {row.byGrade
                .slice()
                .sort((a, b) => a.grade.localeCompare(b.grade))
                .map((g) => (
                  <tr key={g.grade} className="border-b border-peach/40 last:border-0">
                    <td className="py-1.5">
                      <Badge tone={GRADE_TONE[g.grade] ?? 'neutral'}>เกรด {g.grade}</Badge>
                    </td>
                    <td className="py-1.5 text-right font-medium">{fmtBaht(g.collectedBaht)}</td>
                    <td className="py-1.5 text-right">{g.calls.toLocaleString('th-TH')}</td>
                    <td className="py-1.5 text-right">{g.uniqueContracts.toLocaleString('th-TH')}</td>
                    <td className="py-1.5 text-right">{fmtPerCall(g.bahtPerCall)}</td>
                    <td className={`py-1.5 text-right ${rateCls(g.contactRate)}`}>{fmtRate(g.contactRate)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
      {row.byGrade.length === 0 && (
        <p className="text-sm text-ink-soft">ยังไม่มีข้อมูลแยกตามเกรดในช่วง {rangeLabel}</p>
      )}

      {/* Last activity */}
      <p className="mt-4 text-xs text-ink-soft">
        กิจกรรมล่าสุด: {fmtDatetime(row.lastActivityAt)}
      </p>
    </Card>
  )
}

// ===== Main Page =====

const todayISO = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)

/** range === null ("ทั้งหมด") → ขอบเขตจริงสำหรับ RPC (date param รับ null ไม่ได้) */
function effectiveRange(range: DateRange | null): DateRange {
  return range ?? { start: '2020-01-01', end: todayISO }
}

export default function StaffPerformance() {
  const [rows, setRows] = useState<CollectorScorecardRow[]>([])
  const [uncreditedBaht, setUncreditedBaht] = useState(0)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [range, setRange] = useState<DateRange | null>(() =>
    loadStoredRange('staff-performance.dateRange', 'thisMonth'),
  )

  // ค่าคอมคืนเครื่อง: โหลด 1 ครั้ง (ไม่ขึ้นกับช่วงวัน — เป็นยอดเดือนนี้เสมอ)
  const [deviceCountMap, setDeviceCountMap] = useState<Map<string, number>>(new Map())
  const [deviceTiers, setDeviceTiers] = useState<DeviceReturnTier[]>([])

  useEffect(() => {
    Promise.all([
      getDeviceReturnCountsByFreelancerThisMonth(),
      getDeviceReturnTiers(),
    ]).then(([counts, tiers]) => {
      setDeviceCountMap(counts)
      setDeviceTiers(tiers)
    }).catch(() => {
      // silent — ค่าคอมคืนเครื่องไม่กระทบ scorecard หลัก
    })
  }, [])

  useEffect(() => {
    if (!loading) setRefreshing(true)
    const eff = effectiveRange(range)
    getCollectorScorecard(eff.start, eff.end)
      .then((d) => {
        setRows(d.rows)
        setUncreditedBaht(d.uncreditedBaht)
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
  }, [range])

  const teamSummary = useMemo(() => computeTeamSummary(rows), [rows])
  const totalWithUncredited = teamSummary.totalCollected + uncreditedBaht

  const rangeLabel = useMemo(() => {
    if (!range) return 'ทั้งหมด'
    return `${fmtThaiShort(range.start)} – ${fmtThaiShort(range.end)} (${daysBetween(range.start, range.end)} วัน)`
  }, [range])

  const selectedRow = rows.find((r) => r.authorId === selectedId) ?? null

  function toggleSelect(id: string) {
    setSelectedId((prev) => (prev === id ? null : id))
  }

  if (loading) return <Loading label="กำลังโหลดข้อมูลผลงาน..." />

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-3">
        <PageTitle sub={`ช่วง ${rangeLabel}`} count={{ shown: rows.length }}>
          สกอร์การ์ดผู้ติดตามหนี้
        </PageTitle>
        <Button
          variant="ghost"
          disabled={rows.length === 0 || refreshing}
          onClick={() => {
            const filename = `collector_scorecard_${todayISO}.csv`
            downloadCSV(generateCSV(rows), filename)
          }}
        >
          <Download className="h-4 w-4" />
          Export Excel
        </Button>
      </div>

      {/* ตัวเลือกช่วงวันที่ */}
      <DateRangePicker
        storageKey="staff-performance.dateRange"
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

      {/* Section 1: Team Summary */}
      <Card>
        <p className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-soft">
          สรุปทีม (ช่วงที่เลือก)
        </p>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="rounded-xl border border-peach bg-white px-4 py-3">
            <div className="text-2xl font-bold text-ink">{fmtBaht(teamSummary.totalCollected)}</div>
            <div className="mt-1 text-xs text-ink-soft">💰 ยอดเก็บจากการโทร (รวมทีม)</div>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <div className="text-2xl font-bold text-amber-700">{fmtBaht(uncreditedBaht)}</div>
            <div className="mt-1 text-xs text-amber-700/80">ยอดที่ไม่มีสายนำ</div>
          </div>
          <div className="rounded-xl border border-peach bg-white px-4 py-3">
            <div className="text-2xl font-bold text-ink">{teamSummary.totalCalls.toLocaleString('th-TH')}</div>
            <div className="mt-1 text-xs text-ink-soft">📞 จำนวนสายรวม</div>
          </div>
          <div className="rounded-xl border border-peach bg-white px-4 py-3">
            <div className="text-2xl font-bold text-ink">
              {teamSummary.avgContactRate !== null ? `${teamSummary.avgContactRate.toFixed(1)}%` : 'N/A'}
            </div>
            <div className="mt-1 text-xs text-ink-soft">อัตราโทรติดเฉลี่ย</div>
          </div>
        </div>
        {/* helper line — reconcile ยอดเงิน */}
        <p className="mt-3 text-xs leading-relaxed text-ink-soft">
          “ยอดที่ไม่มีสายนำ” คือเงินที่ลูกค้าจ่ายเข้ามาในช่วงนี้ แต่ไม่มีสายโทรของผู้ติดตามคนไหนนำก่อนจ่ายภายใน 7 วัน
          จึงไม่ถูกนับให้ใคร — ยอดเก็บรวมทีม {fmtBaht(teamSummary.totalCollected)} + ยอดที่ไม่มีสายนำ{' '}
          {fmtBaht(uncreditedBaht)} = ยอดที่ลูกค้าจ่ายทั้งหมดในช่วงนี้ {fmtBaht(totalWithUncredited)}
        </p>
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
                  <th className="px-4 py-3 text-right font-semibold text-ink">💰 ยอดเก็บจากโทร</th>
                  <th className="px-4 py-3 text-right font-semibold text-ink">📞 สาย</th>
                  <th className="px-4 py-3 text-right font-semibold text-ink">👥 สัญญาที่ดูแล</th>
                  <th className="px-4 py-3 text-right font-semibold text-ink">฿/สาย</th>
                  <th className="px-4 py-3 text-right font-semibold text-ink">อัตราโทรติด</th>
                  <th className="px-4 py-3 text-right font-semibold text-ink">คืนเครื่อง (เดือนนี้)</th>
                  <th className="w-10 px-4 py-3" />
                </tr>
              </thead>
              {rows.map((row) => {
                const isSelected = selectedId === row.authorId
                const deviceCount = deviceCountMap.get(row.authorId) ?? 0
                const deviceComm = deviceReturnCommissionMonthly(deviceCount, deviceTiers)
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
                                .slice()
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
                      {/* ยอดเก็บจากโทร */}
                      <td className="px-4 py-3 text-right font-semibold text-ink">
                        {fmtBaht(row.collectedBaht)}
                      </td>
                      {/* จำนวนสาย */}
                      <td className="px-4 py-3 text-right text-ink">
                        {row.calls.toLocaleString('th-TH')}
                      </td>
                      {/* สัญญาที่ดูแล */}
                      <td className="px-4 py-3 text-right text-ink">
                        {row.uniqueContracts.toLocaleString('th-TH')}
                      </td>
                      {/* ฿/สาย */}
                      <td className="px-4 py-3 text-right text-ink">
                        {fmtPerCall(row.bahtPerCall)}
                      </td>
                      {/* อัตราโทรติด */}
                      <td className={`px-4 py-3 text-right ${rateCls(row.contactRate)}`}>
                        {fmtRate(row.contactRate)}
                      </td>
                      {/* ค่าคอมคืนเครื่อง */}
                      <td className="px-4 py-3 text-right">
                        <div className="text-sm font-medium text-ink">
                          {deviceComm.totalBaht > 0
                            ? `฿${baht(deviceComm.totalBaht)}`
                            : '—'}
                        </div>
                        <div className="text-xs text-ink-soft">{deviceCount} เครื่อง</div>
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
                            rangeLabel={rangeLabel}
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
