import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, Download, X, Users, Wallet, CalendarClock, AlertTriangle } from 'lucide-react'
import { Button, Card, PageTitle, Badge, Loading, EmptyState } from '../components/ui'
import {
  DateRangePicker,
  loadStoredRange,
  fmtThaiShort,
  daysBetween,
  addDays,
  type DateRange,
} from '../components/DateRangePicker'
import {
  getDeviceReturnCountsByFreelancerThisMonth,
  getDeviceReturnTiers,
  getDeviceReturnByCollector,
  getCollectorScorecard,
  getPjRecoverySummary,
  getPjRecoveryMonthly,
  getPjDaysLateDist,
  getPjRecoveryOutcomeMonthly,
  getPjRecoveryOutcomeSummary,
  getCollectorCallOutcomes,
  type CollectorScorecardRow,
} from '../lib/db'
import type {
  PjRecoverySummary,
  PjRecoveryMonth,
  PjDaysLateBucket,
  PjRecoveryOutcomeMonth,
  PjRecoveryOutcomeSummary,
  CollectorCallOutcome,
} from '../lib/types'
import type { DeviceReturnByCollectorResult } from '../lib/deviceReturnByCollector'
import { deviceReturnCommissionMonthly, type DeviceReturnTier } from '../lib/commission'
import { computeCallOutcomeTotals, type CallOutcomeTotals } from '../lib/callOutcomes'
import { baht } from '../lib/format'
import TeamCallTodayWidget from '../components/TeamCallTodayWidget'

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

// ===== PJ: helpers (ผลการตามหนี้จริงจากระบบ PJ) =====

const EMPTY_PJ: PjRecoverySummary = {
  lateContracts: 0,
  lateInstallments: 0,
  recoveredTotal: 0,
  avgDaysLate: 0,
  maxDaysLate: 0,
}

const EMPTY_OUTCOME: PjRecoveryOutcomeSummary = {
  recoveredInstallments: 0,
  recoveredBaht: 0,
  outstandingInstallments: 0,
  outstandingBaht: 0,
}

// อัตราสำเร็จ (ตามบาท) = ตามได้ / (ตามได้ + ยังค้าง) — กัน /0
function outcomeRate(recovered: number, outstanding: number): number {
  const total = recovered + outstanding
  if (total <= 0) return 0
  return Math.round((recovered / total) * 100)
}

// 'YYYY-MM' (ค.ศ.) → 'ส.ค.68' (พ.ศ. ย่อ)
function thaiMonthShort(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  if (!y || !m || m < 1 || m > 12) return ym
  const be = (y + 543) % 100 // 2 หลักท้าย พ.ศ.
  return `${MONTH_SHORT[m - 1]}${be.toString().padStart(2, '0')}`
}

// เรียงช่วงวันช้าให้ถูก (อย่าให้ 90+ มาก่อน)
const DAYS_LATE_ORDER = ['1-7', '8-30', '31-60', '61-90', '90+']
function sortDaysLateBuckets(rows: PjDaysLateBucket[]): PjDaysLateBucket[] {
  return [...rows].sort(
    (a, b) => DAYS_LATE_ORDER.indexOf(a.bucket) - DAYS_LATE_ORDER.indexOf(b.bucket),
  )
}

// ===== PJ: KPI cards 4 ใบ =====
function PjKpiCards({ s }: { s: PjRecoverySummary }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Card className="p-4 text-center">
        <Users size={18} className="mx-auto mb-1 text-ink-soft" />
        <p className="text-xs text-ink-soft mb-1">ลูกค้าเคยจ่ายช้า</p>
        <p className="text-xl font-bold text-ink">{s.lateContracts.toLocaleString()}</p>
        <p className="text-xs text-ink-soft">ราย</p>
      </Card>
      <Card className="p-4 text-center">
        <Wallet size={18} className="mx-auto mb-1 text-green-600" />
        <p className="text-xs text-ink-soft mb-1">เงินตามกลับมาได้รวม</p>
        <p className="text-xl font-bold text-green-600">฿{baht(s.recoveredTotal)}</p>
      </Card>
      <Card className="p-4 text-center">
        <CalendarClock size={18} className="mx-auto mb-1 text-peach-deep" />
        <p className="text-xs text-ink-soft mb-1">จ่ายช้าเฉลี่ย</p>
        <p className="text-xl font-bold text-peach-deep">{s.avgDaysLate.toLocaleString()}</p>
        <p className="text-xs text-ink-soft">วัน</p>
      </Card>
      <Card className="p-4 text-center">
        <AlertTriangle size={18} className="mx-auto mb-1 text-red-500" />
        <p className="text-xs text-ink-soft mb-1">ช้าสุด</p>
        <p className="text-xl font-bold text-red-600">{s.maxDaysLate.toLocaleString()}</p>
        <p className="text-xs text-ink-soft">วัน</p>
      </Card>
    </div>
  )
}

// ===== PJ: กราฟแท่งแนวตั้งเงินตามกลับรายเดือน =====
function PjMonthlyChart({ rows }: { rows: PjRecoveryMonth[] }) {
  const [hover, setHover] = useState<number | null>(null)
  if (rows.length === 0) {
    return (
      <Card>
        <h2 className="mb-1 text-sm font-semibold text-ink">เงินตามกลับมาได้ รายเดือน</h2>
        <p className="py-10 text-center text-sm text-ink-soft">ยังไม่มีข้อมูล</p>
      </Card>
    )
  }

  const max = Math.max(1, ...rows.map((r) => r.recoveredBaht))
  // โชว์ป้ายแกนทุกแท่งถ้าไม่เกิน 18 เดือน ไม่งั้นเว้น
  const showEvery = rows.length <= 18 ? 1 : 2

  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold text-ink">เงินตามกลับมาได้ รายเดือน</h2>
      <p className="mb-4 text-xs text-ink-soft">แท่งสูง = เก็บเงินจากงวดจ่ายช้าได้มากในเดือนนั้น</p>
      <div className="flex items-end gap-1.5 sm:gap-2" style={{ height: 180 }}>
        {rows.map((r, i) => {
          const h = Math.max(2, (r.recoveredBaht / max) * 150)
          const active = hover === i
          return (
            <div
              key={r.month}
              className="relative flex flex-1 flex-col items-center justify-end"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              {active && (
                <div className="pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs text-white shadow-lg">
                  <div className="font-medium text-zinc-300">{thaiMonthShort(r.month)}</div>
                  <div className="font-semibold">฿{baht(r.recoveredBaht)}</div>
                  <div className="text-zinc-300">{r.installments.toLocaleString()} งวด</div>
                </div>
              )}
              <div
                className="w-full rounded-t-md transition-colors"
                style={{
                  height: h,
                  backgroundColor: active ? '#ea580c' : '#f97316',
                  maxWidth: 36,
                }}
              />
            </div>
          )
        })}
      </div>
      {/* ป้ายแกนล่าง */}
      <div className="mt-1.5 flex gap-1.5 sm:gap-2">
        {rows.map((r, i) => (
          <span
            key={r.month}
            className="flex-1 overflow-hidden text-center text-[10px] leading-tight text-ink-soft"
          >
            {i % showEvery === 0 ? thaiMonthShort(r.month) : ''}
          </span>
        ))}
      </div>
    </Card>
  )
}

// ===== PJ: การกระจายวันช้า 5 ช่วง =====
function PjDaysLateDist({ rows }: { rows: PjDaysLateBucket[] }) {
  const sorted = sortDaysLateBuckets(rows)
  if (sorted.length === 0) return null
  const max = Math.max(1, ...sorted.map((r) => r.installments))
  // สีไล่จากเขียว (ช้าน้อย) → แดง (ช้ามาก)
  const TONE = ['bg-green-500', 'bg-lime-500', 'bg-amber-400', 'bg-orange-500', 'bg-red-500']

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-ink">จ่ายช้ากี่วัน (แยกช่วง)</h2>
      <div className="grid grid-cols-5 gap-2">
        {sorted.map((r) => {
          const tone = TONE[DAYS_LATE_ORDER.indexOf(r.bucket)] ?? 'bg-peach-deep'
          const barH = Math.max(6, (r.installments / max) * 64)
          return (
            <div key={r.bucket} className="flex flex-col items-center">
              <div className="flex h-20 w-full items-end justify-center">
                <div
                  className={`w-7 rounded-t-md ${tone}`}
                  style={{ height: barH }}
                  title={`${r.installments.toLocaleString()} งวด`}
                />
              </div>
              <p className="mt-1 text-sm font-semibold text-ink">{r.installments.toLocaleString()}</p>
              <p className="text-[10px] text-ink-soft">งวด</p>
              <p className="mt-0.5 text-xs font-medium text-ink-soft">
                {r.bucket === '90+' ? '90+ วัน' : `${r.bucket} วัน`}
              </p>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// ===== PJ outcome: การ์ดสรุป ตามได้ vs ยังค้าง =====
function PjOutcomeCards({ s }: { s: PjRecoveryOutcomeSummary }) {
  const rate = outcomeRate(s.recoveredBaht, s.outstandingBaht)
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Card className="p-4 text-center">
        <p className="text-xs text-ink-soft mb-1">อัตราสำเร็จ (คิดจากยอดเงิน)</p>
        <p className="text-3xl font-bold text-peach-deep">{rate}%</p>
        <p className="text-xs text-ink-soft">ของยอดที่ครบกำหนดทั้งหมด</p>
      </Card>
      <Card className="p-4 text-center">
        <p className="text-xs text-ink-soft mb-1">ตามเก็บได้แล้ว</p>
        <p className="text-xl font-bold text-green-600">฿{baht(s.recoveredBaht)}</p>
        <p className="text-xs text-ink-soft">{s.recoveredInstallments.toLocaleString()} งวด</p>
      </Card>
      <Card className="p-4 text-center">
        <p className="text-xs text-ink-soft mb-1">ยังเก็บไม่ได้</p>
        <p className="text-xl font-bold text-red-600">฿{baht(s.outstandingBaht)}</p>
        <p className="text-xs text-ink-soft">{s.outstandingInstallments.toLocaleString()} งวด</p>
      </Card>
    </div>
  )
}

// ===== PJ outcome: กราฟแท่งซ้อน ตามได้(เขียว)+ยังค้าง(แดง) รายเดือนครบกำหนด =====
function PjOutcomeChart({ rows }: { rows: PjRecoveryOutcomeMonth[] }) {
  const [hover, setHover] = useState<number | null>(null)
  if (rows.length === 0) {
    return (
      <Card>
        <h3 className="mb-1 text-sm font-semibold text-ink">ตามได้ vs ยังค้าง รายเดือนครบกำหนด</h3>
        <p className="py-10 text-center text-sm text-ink-soft">ยังไม่มีข้อมูล</p>
      </Card>
    )
  }

  // สเกลจากยอดรวมต่อเดือนที่สูงสุด (แท่งซ้อน)
  const max = Math.max(1, ...rows.map((r) => r.recoveredBaht + r.outstandingBaht))
  const showEvery = rows.length <= 18 ? 1 : 2

  return (
    <Card>
      <h3 className="mb-1 text-sm font-semibold text-ink">ตามได้ vs ยังค้าง รายเดือนครบกำหนด</h3>
      <p className="mb-2 text-xs text-ink-soft">
        <span className="mr-3 inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: '#22c55e' }} />
          ตามเก็บได้
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: '#ef4444' }} />
          ยังเก็บไม่ได้
        </span>
      </p>
      <div className="flex items-end gap-1.5 sm:gap-2" style={{ height: 180 }}>
        {rows.map((r, i) => {
          const total = r.recoveredBaht + r.outstandingBaht
          const stackH = Math.max(2, (total / max) * 150)
          const recH = total > 0 ? (r.recoveredBaht / total) * stackH : 0
          const outH = stackH - recH
          const active = hover === i
          const rate = outcomeRate(r.recoveredBaht, r.outstandingBaht)
          return (
            <div
              key={r.month}
              className="relative flex flex-1 flex-col items-center justify-end"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              {active && (
                <div className="pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs text-white shadow-lg">
                  <div className="font-medium text-zinc-300">{thaiMonthShort(r.month)}</div>
                  <div className="font-semibold text-green-400">
                    ตามได้ ฿{baht(r.recoveredBaht)} · {r.recoveredInstallments.toLocaleString()} งวด
                  </div>
                  <div className="font-semibold text-red-400">
                    ยังค้าง ฿{baht(r.outstandingBaht)} · {r.outstandingInstallments.toLocaleString()} งวด
                  </div>
                  <div className="mt-0.5 text-zinc-300">สำเร็จ {rate}%</div>
                </div>
              )}
              <div
                className="flex w-full flex-col justify-end"
                style={{ height: stackH, maxWidth: 36 }}
              >
                {/* ยังค้าง (แดง) อยู่ด้านบน */}
                <div
                  className="w-full rounded-t-md transition-colors"
                  style={{ height: outH, backgroundColor: active ? '#dc2626' : '#ef4444' }}
                />
                {/* ตามได้ (เขียว) อยู่ฐาน */}
                <div
                  className="w-full transition-colors"
                  style={{ height: recH, backgroundColor: active ? '#16a34a' : '#22c55e' }}
                />
              </div>
            </div>
          )
        })}
      </div>
      {/* ป้ายแกนล่าง */}
      <div className="mt-1.5 flex gap-1.5 sm:gap-2">
        {rows.map((r, i) => (
          <span
            key={r.month}
            className="flex-1 overflow-hidden text-center text-[10px] leading-tight text-ink-soft"
          >
            {i % showEvery === 0 ? thaiMonthShort(r.month) : ''}
          </span>
        ))}
      </div>
    </Card>
  )
}

// ===== PJ outcome: ตารางรายเดือน เรียงเก่า→ใหม่ =====
function PjOutcomeTable({ rows }: { rows: PjRecoveryOutcomeMonth[] }) {
  const sorted = useMemo(
    () => [...rows].sort((a, b) => a.month.localeCompare(b.month)),
    [rows],
  )
  if (sorted.length === 0) return null
  return (
    <Card>
      <h3 className="mb-3 text-sm font-semibold text-ink">รายเดือน (เรียงเดือนเก่า → ใหม่)</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-peach text-left text-xs text-ink-soft">
              <th className="pb-2 font-medium">เดือนครบกำหนด</th>
              <th className="pb-2 text-right font-medium">ตามได้ (งวด)</th>
              <th className="pb-2 text-right font-medium">ตามได้ (฿)</th>
              <th className="pb-2 text-right font-medium">ยังค้าง (งวด)</th>
              <th className="pb-2 text-right font-medium">ยังค้าง (฿)</th>
              <th className="pb-2 text-right font-medium">อัตราสำเร็จ</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const rate = outcomeRate(r.recoveredBaht, r.outstandingBaht)
              const rateColor =
                rate >= 80 ? 'text-green-700' : rate >= 50 ? 'text-amber-600' : 'text-red-600'
              const rowBg =
                rate >= 80 ? 'bg-green-50/60' : rate >= 50 ? 'bg-amber-50/50' : 'bg-red-50/50'
              return (
                <tr key={r.month} className={`border-b border-peach/40 last:border-0 ${rowBg}`}>
                  <td className="py-2 font-medium text-ink">{thaiMonthShort(r.month)}</td>
                  <td className="py-2 text-right text-ink-soft">
                    {r.recoveredInstallments.toLocaleString()}
                  </td>
                  <td className="py-2 text-right font-semibold text-green-700">
                    ฿{baht(r.recoveredBaht)}
                  </td>
                  <td className="py-2 text-right text-ink-soft">
                    {r.outstandingInstallments.toLocaleString()}
                  </td>
                  <td className="py-2 text-right font-semibold text-red-600">
                    {r.outstandingBaht > 0 ? `฿${baht(r.outstandingBaht)}` : '—'}
                  </td>
                  <td className={`py-2 text-right font-semibold ${rateColor}`}>{rate}%</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// ===== PJ outcome: sub-section รวม =====
function PjOutcomeSection({
  summary,
  monthly,
}: {
  summary: PjRecoveryOutcomeSummary
  monthly: PjRecoveryOutcomeMonth[]
}) {
  return (
    <div className="space-y-4 border-t border-peach/60 pt-5">
      <div>
        <h3 className="text-sm font-bold text-ink">
          ตามเก็บได้ vs ยังเก็บไม่ได้ (แยกตามเดือนครบกำหนด)
        </h3>
        <p className="text-sm text-ink-soft">
          งวดที่ครบกำหนดในเดือนนั้น สุดท้ายตามเก็บได้แล้วเท่าไร เทียบกับที่ยังค้างอยู่ — เห็นอัตราความสำเร็จการตามหนี้แต่ละเดือน
        </p>
      </div>

      <PjOutcomeCards s={summary} />
      <PjOutcomeChart rows={monthly} />
      <PjOutcomeTable rows={monthly} />

      <p className="text-xs text-ink-soft">
        * ยังเก็บไม่ได้ = งวดที่เลยกำหนดแล้วยังไม่จ่ายจนถึงตอนนี้ (รวมเคสค้างที่ไม่เคยจ่ายกลับมาเลยแล้ว)
      </p>
    </div>
  )
}

// ===== PJ: section รวม (ผลการตามหนี้จริงจากระบบ PJ) =====
interface PjData {
  summary: PjRecoverySummary
  monthly: PjRecoveryMonth[]
  daysLate: PjDaysLateBucket[]
  outcomeSummary: PjRecoveryOutcomeSummary
  outcomeMonthly: PjRecoveryOutcomeMonth[]
}

function PjRecoverySection({ data }: { data: PjData }) {
  return (
    <Card>
      <div className="mb-4">
        <h2 className="text-base font-bold text-ink">ผลการตามหนี้จริง (จากระบบ PJ)</h2>
        <p className="text-sm text-ink-soft">
          วันจ่ายจริงรายงวดจาก PJ — เงินจากงวดที่จ่ายช้าแล้วในที่สุดตามกลับมาได้ (ข้อมูลทั้งหมด ไม่ขึ้นกับช่วงวันที่เลือกด้านบน)
        </p>
      </div>

      <div className="space-y-4">
        <PjKpiCards s={data.summary} />
        <PjMonthlyChart rows={data.monthly} />
        <PjDaysLateDist rows={data.daysLate} />

        <PjOutcomeSection summary={data.outcomeSummary} monthly={data.outcomeMonthly} />
      </div>
    </Card>
  )
}

// ===== Call outcomes: ผลการโทร & การนัดชำระ (รายคน) =====
// computeCallOutcomeTotals + CallOutcomeTotals ย้ายไป ../lib/callOutcomes.ts (shared กับ TeamCallTodayWidget)

/** จำนวนเต็มในตาราง: 0 → "—" (ให้สอดคล้องกับ scorecard) */
function fmtInt(n: number): string {
  if (n === 0) return '—'
  return n.toLocaleString('th-TH')
}

function CallOutcomeSection({
  rows,
  totals,
}: {
  rows: CollectorCallOutcome[]
  totals: CallOutcomeTotals
}) {
  const sorted = useMemo(
    () => [...rows].sort((a, b) => b.casesFollowed - a.casesFollowed),
    [rows],
  )

  return (
    <Card>
      <div className="mb-4">
        <h2 className="text-base font-bold text-ink">ผลการโทร &amp; การนัดชำระ (รายคน)</h2>
        <p className="text-sm text-ink-soft">
          อิงการบันทึกการติดตามใน /queue ในช่วงวันที่เลือกด้านบน — โทรกี่เคส ติดต่อได้/ไม่ได้ และผลการนัดชำระของแต่ละคน
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          ยังไม่มีข้อมูลการโทรในช่วงนี้ — ตัวเลขจะขึ้นเมื่อทีมเริ่มบันทึกการติดตามใน /queue
        </div>
      ) : (
        <div className="space-y-4">
          {/* Team overview cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-peach bg-white px-4 py-3 text-center">
              <div className="text-2xl font-bold text-ink">{totals.casesFollowed.toLocaleString('th-TH')}</div>
              <div className="mt-1 text-xs text-ink-soft">📋 ติดตาม (เคส)</div>
            </div>
            <div className="rounded-xl border border-peach bg-white px-4 py-3 text-center">
              <div className="text-2xl font-bold text-ink">{totals.casesReached.toLocaleString('th-TH')}</div>
              <div className="mt-1 text-xs text-ink-soft">📞 ติดต่อได้</div>
            </div>
            <div className="rounded-xl border border-peach bg-white px-4 py-3 text-center">
              <div className="text-2xl font-bold text-ink">{totals.casesNoAnswer.toLocaleString('th-TH')}</div>
              <div className="mt-1 text-xs text-ink-soft">ไม่รับสาย</div>
            </div>
            <div className="rounded-xl border border-peach bg-white px-4 py-3 text-center">
              <div className="text-2xl font-bold text-ink">{totals.casesUnreachable.toLocaleString('th-TH')}</div>
              <div className="mt-1 text-xs text-ink-soft">ติดต่อไม่ได้เลย</div>
            </div>
            <div className="rounded-xl border border-peach bg-white px-4 py-3 text-center">
              <div className="text-2xl font-bold text-ink">{totals.promisesMade.toLocaleString('th-TH')}</div>
              <div className="mt-1 text-xs text-ink-soft">นัดจ่าย</div>
            </div>
            <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-center">
              <div className="text-2xl font-bold text-green-700">{totals.promisesKept.toLocaleString('th-TH')}</div>
              <div className="mt-1 text-xs text-green-700/80">✅ ชำระตามนัด</div>
            </div>
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-center">
              <div className="text-2xl font-bold text-red-600">{totals.promisesBroken.toLocaleString('th-TH')}</div>
              <div className="mt-1 text-xs text-red-600/80">❌ ผิดนัด</div>
            </div>
            <div className="rounded-xl border border-peach bg-white px-4 py-3 text-center">
              <div className="text-lg font-semibold text-ink-soft">{totals.promisesPending.toLocaleString('th-TH')}</div>
              <div className="mt-1 text-xs text-ink-soft">รอถึงนัด</div>
            </div>
          </div>

          {/* Per-person table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-peach text-left text-xs text-ink-soft">
                  <th className="pb-2 font-medium">พนักงาน</th>
                  <th className="pb-2 text-right font-medium">ติดตาม (เคส)</th>
                  <th className="pb-2 text-right font-medium">ติดต่อได้</th>
                  <th className="pb-2 text-right font-medium">ไม่รับสาย</th>
                  <th className="pb-2 text-right font-medium">ติดต่อไม่ได้เลย</th>
                  <th className="pb-2 text-right font-medium">นัดจ่าย</th>
                  <th className="pb-2 text-right font-medium">ตามนัด</th>
                  <th className="pb-2 text-right font-medium">ผิดนัด</th>
                  <th className="pb-2 text-right font-medium">รอถึงนัด</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.authorId} className="border-b border-peach/40 last:border-0">
                    <td className="py-2 font-medium text-ink">{r.authorName}</td>
                    <td className="py-2 text-right text-ink">{fmtInt(r.casesFollowed)}</td>
                    <td className="py-2 text-right text-ink">{fmtInt(r.casesReached)}</td>
                    <td className="py-2 text-right text-ink-soft">{fmtInt(r.casesNoAnswer)}</td>
                    <td className="py-2 text-right text-ink-soft">{fmtInt(r.casesUnreachable)}</td>
                    <td className="py-2 text-right text-ink">{fmtInt(r.promisesMade)}</td>
                    <td className="py-2 text-right font-semibold text-green-700">{fmtInt(r.promisesKept)}</td>
                    <td className="py-2 text-right font-semibold text-red-600">{fmtInt(r.promisesBroken)}</td>
                    <td className="py-2 text-right text-ink-soft">{fmtInt(r.promisesPending)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs leading-relaxed text-ink-soft">
            ติดต่อไม่ได้เลย = โทรแล้วเจอแต่ไม่รับสาย ไม่เคยติดต่อได้เลย · ตามนัด = จ่ายภายใน/ก่อนวันนัด ·
            ผิดนัด = เลยวันนัดแล้วยังไม่จ่าย · รอถึงนัด = ยังไม่ถึงวันนัด
          </p>
        </div>
      )}
    </Card>
  )
}

// ===== เครื่องที่ตามคืนได้ (นับตามคนที่โทรจนลูกค้ายอมคืน) =====

function DeviceReturnByCollectorSection({ rows }: { rows: DeviceReturnByCollectorResult[] }) {
  const totalCount = rows.reduce((sum, r) => sum + r.count, 0)

  return (
    <Card>
      <div className="mb-4">
        <h2 className="text-base font-bold text-ink">เครื่องที่ตามคืนได้ (ตามคนที่ตามจนลูกค้าคืน)</h2>
        <p className="text-sm text-ink-soft">
          นับตามคนที่โทรจนลูกค้ายอมคืนเครื่อง ในช่วงวันที่เลือกด้านบน —{' '}
          <span className="font-medium text-ink">คนละตัวกับ “ค่าคอมคืนเครื่อง” ในตารางด้านบน</span>{' '}
          (ค่าคอมนับเฉพาะยอดของเดือนนี้เสมอ ไม่ผูกกับช่วงวันที่เลือก)
        </p>
      </div>

      {totalCount === 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          ไม่มีเครื่องที่ตามคืนได้ในช่วงนี้
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-peach text-left text-xs text-ink-soft">
                <th className="pb-2 font-medium">พนักงาน</th>
                <th className="pb-2 text-right font-medium">เคสที่คืนได้</th>
                <th className="pb-2 text-right font-medium">มูลค่ารวม</th>
                <th className="pb-2 text-right font-medium">ยังไม่จ่าย</th>
                <th className="pb-2 text-right font-medium">จ่ายแล้ว (รอเช็คเครื่อง)</th>
                <th className="pb-2 text-right font-medium">จ่ายครบ ปิดสัญญา</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.collectorId} className="border-b border-peach/40 last:border-0">
                  <td className="py-2 font-medium text-ink">{r.name}</td>
                  <td className="py-2 text-right font-semibold text-ink">{fmtInt(r.count)}</td>
                  <td className="py-2 text-right text-ink">{fmtBaht(r.totalValue)}</td>
                  <td className="py-2 text-right text-ink-soft">{fmtInt(r.byCaseNo.case1)}</td>
                  <td className="py-2 text-right text-ink-soft">{fmtInt(r.byCaseNo.case2)}</td>
                  <td className="py-2 text-right font-medium text-green-700">{fmtInt(r.byCaseNo.case3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-xs leading-relaxed text-ink-soft">
        ยังไม่จ่าย = กรณีที่ 1 (ยังไม่ชำระค่างวด+ค่าปรับ) · จ่ายแล้ว (รอเช็คเครื่อง) = กรณีที่ 2 ·
        จ่ายครบ ปิดสัญญา = กรณีที่ 3 · “ยังไม่ระบุ” = ไม่มีบันทึกติดตามผูกกับเคสคืนเครื่องนี้
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

  // ผลการโทร & การนัดชำระ (รายคน): โหลดตามช่วงวันที่เลือก (เหมือน scorecard)
  const [callOutcomes, setCallOutcomes] = useState<CollectorCallOutcome[]>([])

  // เครื่องที่ตามคืนได้ต่อคน (attributed_freelancer_id — คนละตัวกับค่าคอมคืนเครื่อง): โหลดตามช่วงวันที่เลือก
  const [deviceReturnByCollector, setDeviceReturnByCollector] = useState<DeviceReturnByCollectorResult[]>([])

  // ผลการตามหนี้จริงจากระบบ PJ: โหลด 1 ครั้ง (ข้อมูลทั้งหมด ไม่ผูกช่วงวัน)
  const [pjData, setPjData] = useState<PjData>({
    summary: EMPTY_PJ,
    monthly: [],
    daysLate: [],
    outcomeSummary: EMPTY_OUTCOME,
    outcomeMonthly: [],
  })

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
    Promise.all([
      getPjRecoverySummary(),
      getPjRecoveryMonthly(),
      getPjDaysLateDist(),
      getPjRecoveryOutcomeSummary(),
      getPjRecoveryOutcomeMonthly(),
    ]).then(([summary, monthly, daysLate, outcomeSummary, outcomeMonthly]) => {
      setPjData({ summary, monthly, daysLate, outcomeSummary, outcomeMonthly })
    }).catch(() => {
      // silent — PJ ไม่กระทบ scorecard หลัก
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

  // ผลการโทร & การนัดชำระ — โหลดตามช่วงวันที่เลือก (เหมือน scorecard)
  useEffect(() => {
    const eff = effectiveRange(range)
    getCollectorCallOutcomes(eff.start, eff.end)
      .then(setCallOutcomes)
      .catch(() => {
        // silent — ไม่กระทบ scorecard หลัก
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range])

  // เครื่องที่ตามคืนได้ต่อคน — โหลดตามช่วงวันที่เลือก (toISO exclusive → +1 วันจาก eff.end)
  useEffect(() => {
    const eff = effectiveRange(range)
    getDeviceReturnByCollector(eff.start, addDays(eff.end, 1))
      .then(setDeviceReturnByCollector)
      .catch(() => {
        // silent — ไม่กระทบ scorecard หลัก
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range])

  const teamSummary = useMemo(() => computeTeamSummary(rows), [rows])
  const callOutcomeTotals = useMemo(() => computeCallOutcomeTotals(callOutcomes), [callOutcomes])
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

      {/* วันนี้สด (auto-refresh) — แยกออกจากส่วน "เลือกช่วงวันที่" ด้านล่างซึ่งขับเคลื่อนทุก section ที่เหลือ */}
      <TeamCallTodayWidget />

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

      {/* หมายเหตุ: สกอร์การ์ดด้านล่างอิงการบันทึกโทรใน /queue */}
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        <span className="font-semibold">หมายเหตุ:</span>{' '}
        สกอร์การ์ดส่วนนี้อิงการบันทึกโทรใน /queue — ถ้าทีมยังไม่เริ่มบันทึกการโทร ตัวเลขจะเป็น 0
        ดู “ผลการตามหนี้จริง (จากระบบ PJ)” ด้านล่างเพื่อดูผลการตามหนี้จากข้อมูลจริง
      </div>

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

      {/* Section 2.5: ผลการโทร & การนัดชำระ (รายคน) — อิง /queue ช่วงที่เลือก */}
      <CallOutcomeSection rows={callOutcomes} totals={callOutcomeTotals} />

      {/* Section 2.6: เครื่องที่ตามคืนได้ ต่อคน (attribution — คนละตัวกับค่าคอมคืนเครื่อง) */}
      <DeviceReturnByCollectorSection rows={deviceReturnByCollector} />

      {/* Section 3: ผลการตามหนี้จริง (จากระบบ PJ) */}
      <PjRecoverySection data={pjData} />
    </div>
  )
}
