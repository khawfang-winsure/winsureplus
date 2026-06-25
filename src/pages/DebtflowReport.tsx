import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Search, Users, Wallet, CalendarClock, AlertTriangle } from 'lucide-react'
import { Badge, Card, Loading, PageTitle } from '../components/ui'
import Pagination from '../components/Pagination'
import {
  getDebtflowSummary,
  getDebtflowCases,
  getPjRecoverySummary,
  getPjRecoveryMonthly,
  getPjRecoveryByEmployee,
  getPjDaysLateDist,
  getPjRecoveryOutcomeMonthly,
  getPjRecoveryOutcomeSummary,
} from '../lib/db'
import type {
  DebtflowCase,
  DebtflowSummary,
  PjRecoverySummary,
  PjRecoveryMonth,
  PjRecoveryEmployee,
  PjDaysLateBucket,
  PjRecoveryOutcomeMonth,
  PjRecoveryOutcomeSummary,
} from '../lib/types'
import { baht, thaiDate } from '../lib/format'
import { useAsync } from '../lib/useAsync'

// ===== helpers =====

const EMPTY_SUMMARY: DebtflowSummary = {
  totalCases: 0,
  totalCollected: 0,
  closedCases: 0,
  byEmployee: [],
  byGrade: [],
  byPaymentStatus: [],
}

function pct(num: number, den: number): string {
  if (den === 0) return '0%'
  return `${Math.round((num / den) * 100)}%`
}

function fmtBaht(n: number | null): string {
  if (!n) return '—'
  return `฿${baht(n)}`
}

type GradeKey = 'A' | 'B' | 'C' | 'D' | 'E'
const GRADE_TONE: Record<GradeKey, 'neutral' | 'amber' | 'red'> = {
  A: 'neutral',
  B: 'neutral',
  C: 'amber',
  D: 'amber',
  E: 'red',
}
function gradeTone(g: string | null): 'neutral' | 'amber' | 'red' {
  if (g && g in GRADE_TONE) return GRADE_TONE[g as GradeKey]
  return 'neutral'
}

// สถานะชำระ → Badge tone
function statusTone(s: string | null): 'green' | 'amber' | 'neutral' {
  if (!s) return 'neutral'
  if (s === 'ชำระเงินครบแล้ว') return 'green'
  if (s.includes('รอ') || s.includes('pending')) return 'amber'
  return 'neutral'
}

// ===== helpers สำหรับ "การตามหนี้ย้อนหลัง (PJ)" =====

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

const MONTH_TH_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']

// 'YYYY-MM' (ค.ศ.) → 'ส.ค.68' (พ.ศ. ย่อ)
function thaiMonthShort(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  if (!y || !m || m < 1 || m > 12) return ym
  const be = (y + 543) % 100 // 2 หลักท้าย พ.ศ.
  return `${MONTH_TH_SHORT[m - 1]}${be.toString().padStart(2, '0')}`
}

// เรียงช่วงวันช้าให้ถูก (อย่าให้ 90+ มาก่อน)
const DAYS_LATE_ORDER = ['1-7', '8-30', '31-60', '61-90', '90+']
function sortDaysLateBuckets(rows: PjDaysLateBucket[]): PjDaysLateBucket[] {
  return [...rows].sort(
    (a, b) => DAYS_LATE_ORDER.indexOf(a.bucket) - DAYS_LATE_ORDER.indexOf(b.bucket),
  )
}

// ===== KPI cards =====
function KpiCards({ s }: { s: DebtflowSummary }) {
  const closeRate = pct(s.closedCases, s.totalCases)
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Card className="p-4 text-center">
        <p className="text-xs text-ink-soft mb-1">เก็บได้รวม</p>
        <p className="text-xl font-bold text-green-600">฿{baht(s.totalCollected)}</p>
      </Card>
      <Card className="p-4 text-center">
        <p className="text-xs text-ink-soft mb-1">ปิดเคสได้</p>
        <p className="text-xl font-bold text-ink">{s.closedCases.toLocaleString()}</p>
        <p className="text-xs text-ink-soft">เคส</p>
      </Card>
      <Card className="p-4 text-center">
        <p className="text-xs text-ink-soft mb-1">เคสทั้งหมด</p>
        <p className="text-xl font-bold text-ink">{s.totalCases.toLocaleString()}</p>
        <p className="text-xs text-ink-soft">เคส</p>
      </Card>
      <Card className="p-4 text-center">
        <p className="text-xs text-ink-soft mb-1">อัตราปิดเคส</p>
        <p className="text-xl font-bold text-peach-deep">{closeRate}</p>
        <p className="text-xs text-ink-soft">ของเคสทั้งหมด</p>
      </Card>
    </div>
  )
}

// ===== ตารางแยกพนักงาน =====
function EmployeeTable({ s }: { s: DebtflowSummary }) {
  if (s.byEmployee.length === 0) return null
  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-ink">แยกตามพนักงาน</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-peach text-left text-xs text-ink-soft">
              <th className="pb-2 font-medium">พนักงาน</th>
              <th className="pb-2 text-right font-medium">เคส</th>
              <th className="pb-2 text-right font-medium">ยอดเลยกำหนด (฿)</th>
              <th className="pb-2 text-right font-medium">เก็บได้ (฿)</th>
              <th className="pb-2 text-right font-medium">เฉลี่ย/เคส (฿)</th>
              <th className="pb-2 text-right font-medium">ปิดได้ (%)</th>
            </tr>
          </thead>
          <tbody>
            {s.byEmployee.map((row) => {
              const crColor =
                row.closedRate >= 50 ? 'text-green-700' : row.closedRate >= 20 ? 'text-amber-600' : 'text-red-600'
              const barWidth = Math.min(100, Math.max(0, row.closedRate))
              const barColor =
                row.closedRate >= 50 ? 'bg-green-500' : row.closedRate >= 20 ? 'bg-amber-400' : 'bg-red-500'
              return (
                <tr key={row.employee} className="border-b border-peach/40 last:border-0">
                  <td className="py-2 font-medium text-ink">{row.employee}</td>
                  <td className="py-2 text-right text-ink-soft">{row.cases}</td>
                  <td className="py-2 text-right text-amber-700">
                    {row.outstandingHeld > 0 ? `฿${baht(row.outstandingHeld)}` : '—'}
                  </td>
                  <td className="py-2 text-right font-semibold text-green-700">
                    ฿{baht(row.collected)}
                  </td>
                  <td className="py-2 text-right text-ink-soft">
                    {row.avgPerCase > 0 ? `฿${baht(row.avgPerCase)}` : '—'}
                  </td>
                  <td className="py-2 text-right">
                    <div className="flex flex-col items-end gap-0.5">
                      <span className={`text-xs font-semibold ${crColor}`}>
                        {row.closed}/{row.cases}
                      </span>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-peach-light">
                          <div
                            className={`h-full rounded-full ${barColor}`}
                            style={{ width: `${barWidth}%` }}
                          />
                        </div>
                        <span className={`w-10 text-right text-xs font-semibold ${crColor}`}>
                          {row.closedRate}%
                        </span>
                      </div>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-soft">
        * ยอดเลยกำหนด = ยอดงวดที่เลยกำหนดและยังไม่จ่าย · ปิดได้ = จำนวนปิดเคส ÷ เคสทั้งหมด · สีเขียว ≥ 50% / เหลือง ≥ 20% / แดง &lt; 20%
      </p>
    </Card>
  )
}

// ===== การ์ดแยกเกรด =====
function GradeSection({ s }: { s: DebtflowSummary }) {
  if (s.byGrade.length === 0) return null
  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-ink">แยกตามเกรด</h2>
      <div className="flex flex-wrap gap-2">
        {s.byGrade.map((row) => (
          <div
            key={row.grade}
            className="flex min-w-[120px] flex-col items-center rounded-xl border border-peach bg-cream p-3 text-center"
          >
            <Badge tone={gradeTone(row.grade)}>{row.grade}</Badge>
            <p className="mt-1 text-xs text-ink-soft">{row.cases} เคส</p>
            <p className="text-sm font-semibold text-ink">฿{baht(row.collected)}</p>
          </div>
        ))}
      </div>
    </Card>
  )
}

// ===== แยกสถานะชำระ =====
function StatusSection({ s }: { s: DebtflowSummary }) {
  if (s.byPaymentStatus.length === 0) return null
  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-ink">แยกตามสถานะชำระ</h2>
      <div className="flex flex-wrap gap-2">
        {s.byPaymentStatus.map((row) => (
          <div
            key={row.status}
            className="flex items-center gap-2 rounded-full border border-peach bg-cream px-3 py-1.5 text-sm"
          >
            <Badge tone={statusTone(row.status)}>{row.status}</Badge>
            <span className="font-semibold text-ink">{row.n}</span>
            <span className="text-ink-soft">เคส</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

// ===== ตารางรายเคส =====
const PAGE_SIZE_OPTIONS = [20, 50, 100]

function CaseTable({ cases }: { cases: DebtflowCase[] }) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return cases
    return cases.filter(
      (c) =>
        (c.customerName ?? '').toLowerCase().includes(q) ||
        (c.sourceInv ?? '').toLowerCase().includes(q) ||
        (c.contractNo ?? '').toLowerCase().includes(q) ||
        (c.assignedEmployee ?? '').toLowerCase().includes(q),
    )
  }, [cases, search])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const sliced = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)

  function handleSearch(v: string) {
    setSearch(v)
    setPage(1)
  }

  function handlePageSize(s: number) {
    setPageSize(s)
    setPage(1)
  }

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">รายเคสทั้งหมด</h2>
        <div className="relative w-64">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft" />
          <input
            type="text"
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="ค้นหา ชื่อ / เลขสัญญา / พนักงาน"
            className="w-full rounded-lg border border-peach bg-cream py-1.5 pl-8 pr-3 text-sm text-ink placeholder:text-ink-soft focus:outline-none focus:ring-1 focus:ring-salmon"
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-peach text-left text-xs text-ink-soft">
              <th className="pb-2 font-medium">เลขสัญญา</th>
              <th className="pb-2 font-medium">ลูกค้า</th>
              <th className="pb-2 font-medium">เกรด</th>
              <th className="pb-2 font-medium">พนักงาน</th>
              <th className="pb-2 font-medium">สถานะชำระ</th>
              <th className="pb-2 text-right font-medium">เก็บได้</th>
              <th className="pb-2 text-right font-medium">ค้างกี่วัน</th>
            </tr>
          </thead>
          <tbody>
            {sliced.length === 0 && (
              <tr>
                <td colSpan={7} className="py-8 text-center text-ink-soft">
                  ไม่พบรายการ
                </td>
              </tr>
            )}
            {sliced.map((c) => (
              <tr key={c.id} className="border-b border-peach/40 last:border-0 hover:bg-cream/60">
                <td className="py-2 pr-3">
                  {c.contractId ? (
                    <Link
                      to={`/contract/${c.contractId}`}
                      className="font-mono text-xs font-medium text-salmon-deep underline-offset-2 hover:underline"
                    >
                      {c.contractNo ?? c.sourceInv}
                    </Link>
                  ) : (
                    <span className="font-mono text-xs text-ink-soft" title="จับคู่สัญญาในระบบไม่ได้">
                      {c.sourceInv}
                    </span>
                  )}
                </td>
                <td className="py-2 pr-3 text-ink">{c.customerName ?? '—'}</td>
                <td className="py-2 pr-3">
                  {c.grade ? (
                    <Badge tone={gradeTone(c.grade)}>{c.grade}</Badge>
                  ) : (
                    <span className="text-ink-soft">—</span>
                  )}
                </td>
                <td className="py-2 pr-3 text-ink-soft">{c.assignedEmployee ?? '(ไม่ระบุ)'}</td>
                <td className="py-2 pr-3">
                  {c.paymentStatus ? (
                    <Badge tone={statusTone(c.paymentStatus)}>{c.paymentStatus}</Badge>
                  ) : (
                    <span className="text-ink-soft">—</span>
                  )}
                </td>
                <td className="py-2 text-right font-semibold text-green-700">
                  {fmtBaht(c.cumulativePaid)}
                </td>
                <td className="py-2 text-right">
                  {c.daysLate !== null ? (
                    <span className={c.daysLate > 60 ? 'font-semibold text-red-600' : 'text-ink-soft'}>
                      {c.daysLate} วัน
                    </span>
                  ) : (
                    <span className="text-ink-soft">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination
        total={filtered.length}
        page={safePage}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={handlePageSize}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
      />
    </Card>
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

// ===== PJ: ตารางแยกพนักงาน =====
function PjEmployeeTable({ rows, lateContracts }: { rows: PjRecoveryEmployee[]; lateContracts: number }) {
  const sorted = useMemo(
    () => [...rows].sort((a, b) => b.recoveredBaht - a.recoveredBaht),
    [rows],
  )
  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold text-ink">เงินตามกลับมาได้ แยกพนักงาน</h2>
      <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
        แยกตามพนักงานได้เฉพาะเคสที่อยู่ในระบบ DEBTFLOW — เคสจ่ายช้าทั้งหมด {lateContracts.toLocaleString()} ราย
        แต่รู้ผู้ดูแลเฉพาะส่วนที่ DEBTFLOW บันทึกไว้ ส่วนที่เหลือไม่ทราบผู้ดูแล
      </p>
      {sorted.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-soft">ยังไม่มีข้อมูล</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-peach text-left text-xs text-ink-soft">
                <th className="pb-2 font-medium">พนักงาน</th>
                <th className="pb-2 text-right font-medium">จำนวนสัญญา</th>
                <th className="pb-2 text-right font-medium">เงินตามกลับมาได้ (฿)</th>
                <th className="pb-2 text-right font-medium">ช้าเฉลี่ย (วัน)</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr key={row.employee} className="border-b border-peach/40 last:border-0">
                  <td className="py-2 font-medium text-ink">{row.employee}</td>
                  <td className="py-2 text-right text-ink-soft">{row.contracts.toLocaleString()}</td>
                  <td className="py-2 text-right font-semibold text-green-700">฿{baht(row.recoveredBaht)}</td>
                  <td className="py-2 text-right text-ink-soft">{row.avgDaysLate.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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

// ===== PJ: section รวม =====
function PjRecoverySection({
  summary,
  monthly,
  byEmployee,
  daysLate,
  outcomeSummary,
  outcomeMonthly,
}: {
  summary: PjRecoverySummary
  monthly: PjRecoveryMonth[]
  byEmployee: PjRecoveryEmployee[]
  daysLate: PjDaysLateBucket[]
  outcomeSummary: PjRecoveryOutcomeSummary
  outcomeMonthly: PjRecoveryOutcomeMonth[]
}) {
  return (
    <div className="space-y-4 border-t border-peach pt-6">
      <div>
        <h2 className="text-base font-bold text-ink">การตามหนี้ย้อนหลัง (จากระบบ PJ)</h2>
        <p className="text-sm text-ink-soft">
          วันจ่ายจริงรายงวดจาก PJ — เงินจากงวดที่จ่ายช้าแล้วในที่สุดตามกลับมาได้
        </p>
      </div>

      <PjKpiCards s={summary} />
      <PjMonthlyChart rows={monthly} />
      <PjDaysLateDist rows={daysLate} />
      <PjEmployeeTable rows={byEmployee} lateContracts={summary.lateContracts} />

      <PjOutcomeSection summary={outcomeSummary} monthly={outcomeMonthly} />
    </div>
  )
}

// ===== หน้าหลัก =====

interface AllData {
  summary: DebtflowSummary
  cases: DebtflowCase[]
  pjSummary: PjRecoverySummary
  pjMonthly: PjRecoveryMonth[]
  pjByEmployee: PjRecoveryEmployee[]
  pjDaysLate: PjDaysLateBucket[]
  pjOutcomeSummary: PjRecoveryOutcomeSummary
  pjOutcomeMonthly: PjRecoveryOutcomeMonth[]
}

async function loadAll(): Promise<AllData> {
  const [
    summary,
    cases,
    pjSummary,
    pjMonthly,
    pjByEmployee,
    pjDaysLate,
    pjOutcomeSummary,
    pjOutcomeMonthly,
  ] = await Promise.all([
    getDebtflowSummary(),
    getDebtflowCases(),
    getPjRecoverySummary(),
    getPjRecoveryMonthly(),
    getPjRecoveryByEmployee(),
    getPjDaysLateDist(),
    getPjRecoveryOutcomeSummary(),
    getPjRecoveryOutcomeMonthly(),
  ])
  return {
    summary,
    cases,
    pjSummary,
    pjMonthly,
    pjByEmployee,
    pjDaysLate,
    pjOutcomeSummary,
    pjOutcomeMonthly,
  }
}

const INIT: AllData = {
  summary: EMPTY_SUMMARY,
  cases: [],
  pjSummary: EMPTY_PJ,
  pjMonthly: [],
  pjByEmployee: [],
  pjDaysLate: [],
  pjOutcomeSummary: EMPTY_OUTCOME,
  pjOutcomeMonthly: [],
}

export default function DebtflowReport() {
  const { data, loading, error } = useAsync(loadAll, INIT)
  const {
    summary,
    cases,
    pjSummary,
    pjMonthly,
    pjByEmployee,
    pjDaysLate,
    pjOutcomeSummary,
    pjOutcomeMonthly,
  } = data

  // last import date อ่านจาก importedAt ของเคสแรก (ทุกเคสนำเข้าพร้อมกัน)
  const importedDate = useMemo(() => {
    if (cases.length === 0) return null
    const ts = cases[0].importedAt
    if (!ts) return null
    const d = ts.slice(0, 10) // 'YYYY-MM-DD'
    return thaiDate(d)
  }, [cases])

  // เคสที่จับคู่สัญญาไม่ได้
  const unmatchedCount = useMemo(
    () => cases.filter((c) => !c.contractId).length,
    [cases],
  )

  if (loading) return <Loading />
  if (error) {
    return (
      <div className="p-6 text-center text-red-600">
        โหลดข้อมูลไม่สำเร็จ: {error}
      </div>
    )
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <PageTitle>ติดตามหนี้ (DEBTFLOW)</PageTitle>

      {/* หมายเหตุ snapshot */}
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        <span className="font-semibold">หมายเหตุ:</span>{' '}
        ข้อมูลนำเข้าจาก DEBTFLOW
        {importedDate ? ` ณ ${importedDate}` : ''}{' '}
        (snapshot — ไม่ได้ sync real-time)
        {unmatchedCount > 0 && (
          <span>
            {' '}· {unmatchedCount} เคสจับคู่สัญญาในระบบไม่ได้ (เลขสัญญาอาจไม่ตรง)
          </span>
        )}
      </div>

      {/* KPI */}
      <KpiCards s={summary} />

      {/* พนักงาน + เกรด + สถานะ */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <EmployeeTable s={summary} />
        <div className="space-y-4">
          <GradeSection s={summary} />
          <StatusSection s={summary} />
        </div>
      </div>

      {/* รายเคส */}
      <CaseTable cases={cases} />

      {/* การตามหนี้ย้อนหลัง (PJ) */}
      <PjRecoverySection
        summary={pjSummary}
        monthly={pjMonthly}
        byEmployee={pjByEmployee}
        daysLate={pjDaysLate}
        outcomeSummary={pjOutcomeSummary}
        outcomeMonthly={pjOutcomeMonthly}
      />
    </div>
  )
}
