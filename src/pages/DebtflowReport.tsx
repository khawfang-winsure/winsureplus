import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Search } from 'lucide-react'
import { Badge, Card, Loading, PageTitle } from '../components/ui'
import Pagination from '../components/Pagination'
import { getDebtflowSummary, getDebtflowCases } from '../lib/db'
import type { DebtflowCase, DebtflowSummary } from '../lib/types'
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

// ===== การตามเครื่อง (จาก snapshot DEBTFLOW) =====

const DEVICE_UNSPEC = '(ยังไม่ระบุ)'
// สถานะที่ถือว่า "ตามคืนได้แล้ว"
const DEVICE_RECOVERED = 'ลูกค้าคืนเครื่องแล้ว'
// สถานะที่ถือว่า "ล็อค/กดดัน"
const DEVICE_LOCK_STATUSES = ['ล็อคเครื่อง', 'จำกัดการใช้แอพ', 'ล็อคภาพหน้าจอ']
const DEVICE_WITH_CUSTOMER = 'เครื่องอยู่กับลูกค้า'
// ลำดับการแสดงสถานะที่รู้จัก (ที่เหลือ + (ยังไม่ระบุ) ต่อท้าย)
const DEVICE_STATUS_ORDER = [
  DEVICE_RECOVERED,
  'ล็อคเครื่อง',
  'จำกัดการใช้แอพ',
  'ล็อคภาพหน้าจอ',
  DEVICE_WITH_CUSTOMER,
  'ใช้งานปกติ',
]

function deviceLabel(status: string | null): string {
  const s = (status ?? '').trim()
  return s === '' ? DEVICE_UNSPEC : s
}

interface DeviceBucket {
  label: string
  n: number
}

interface DeviceEmployeeRow {
  employee: string
  cases: number
  recovered: number
  locked: number
  withCustomer: number
  unspecified: number
}

interface DeviceAgg {
  recovered: number
  locked: number
  withCustomer: number
  unspecified: number
  total: number
  buckets: DeviceBucket[]
  byEmployee: DeviceEmployeeRow[]
}

function buildDeviceAgg(cases: DebtflowCase[]): DeviceAgg {
  const counts = new Map<string, number>()
  const empMap = new Map<string, DeviceEmployeeRow>()
  let recovered = 0
  let locked = 0
  let withCustomer = 0
  let unspecified = 0

  for (const c of cases) {
    const label = deviceLabel(c.deviceStatus)
    counts.set(label, (counts.get(label) ?? 0) + 1)

    const isRecovered = label === DEVICE_RECOVERED
    const isLocked = DEVICE_LOCK_STATUSES.includes(label)
    const isWithCustomer = label === DEVICE_WITH_CUSTOMER
    const isUnspec = label === DEVICE_UNSPEC

    if (isRecovered) recovered++
    if (isLocked) locked++
    if (isWithCustomer) withCustomer++
    if (isUnspec) unspecified++

    const emp = (c.assignedEmployee ?? '').trim() || '(ไม่ระบุ)'
    let row = empMap.get(emp)
    if (!row) {
      row = { employee: emp, cases: 0, recovered: 0, locked: 0, withCustomer: 0, unspecified: 0 }
      empMap.set(emp, row)
    }
    row.cases++
    if (isRecovered) row.recovered++
    if (isLocked) row.locked++
    if (isWithCustomer) row.withCustomer++
    if (isUnspec) row.unspecified++
  }

  // buckets: known statuses ตามลำดับ แล้วต่อด้วยสถานะอื่นๆ ที่ไม่อยู่ในลิสต์ (ยกเว้น unspec) แล้วปิดท้ายด้วย unspec
  const buckets: DeviceBucket[] = []
  const seen = new Set<string>()
  for (const label of DEVICE_STATUS_ORDER) {
    if (counts.has(label)) {
      buckets.push({ label, n: counts.get(label) ?? 0 })
      seen.add(label)
    }
  }
  for (const [label, n] of counts) {
    if (label === DEVICE_UNSPEC || seen.has(label)) continue
    buckets.push({ label, n })
  }
  if (counts.has(DEVICE_UNSPEC)) {
    buckets.push({ label: DEVICE_UNSPEC, n: counts.get(DEVICE_UNSPEC) ?? 0 })
  }

  const byEmployee = [...empMap.values()].sort(
    (a, b) => b.recovered - a.recovered || b.cases - a.cases,
  )

  return {
    recovered,
    locked,
    withCustomer,
    unspecified,
    total: cases.length,
    buckets,
    byEmployee,
  }
}

function DeviceSection({ cases }: { cases: DebtflowCase[] }) {
  const agg = useMemo(() => buildDeviceAgg(cases), [cases])
  if (agg.total === 0) return null

  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold text-ink">การตามเครื่อง</h2>
      <p className="mb-3 text-xs text-ink-soft">สถานะการตามเครื่องจากข้อมูล DEBTFLOW (snapshot)</p>

      {/* KPI */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-center">
          <p className="text-xs text-green-700 mb-1">ตามคืนได้แล้ว</p>
          <p className="text-xl font-bold text-green-700">{agg.recovered.toLocaleString()}</p>
          <p className="text-xs text-green-700/80">เครื่อง</p>
        </div>
        <div className="rounded-xl border border-peach bg-cream p-4 text-center">
          <p className="text-xs text-ink-soft mb-1">กำลังล็อคกดดัน</p>
          <p className="text-xl font-bold text-ink">{agg.locked.toLocaleString()}</p>
          <p className="text-xs text-ink-soft">เครื่อง</p>
        </div>
        <div className="rounded-xl border border-peach bg-cream p-4 text-center">
          <p className="text-xs text-ink-soft mb-1">เครื่องอยู่กับลูกค้า</p>
          <p className="text-xl font-bold text-ink">{agg.withCustomer.toLocaleString()}</p>
          <p className="text-xs text-ink-soft">เครื่อง</p>
        </div>
        <div className="rounded-xl border border-peach bg-cream p-4 text-center">
          <p className="text-xs text-ink-soft mb-1">ยังไม่ระบุสถานะ</p>
          <p className="text-xl font-bold text-ink">{agg.unspecified.toLocaleString()}</p>
          <p className="text-xs text-ink-soft">เครื่อง</p>
        </div>
      </div>

      {/* แยกตามสถานะเครื่อง + แถบสัดส่วน */}
      <div className="mb-4 space-y-2">
        {agg.buckets.map((b) => {
          const isRecovered = b.label === DEVICE_RECOVERED
          const barWidth = agg.total > 0 ? Math.round((b.n / agg.total) * 100) : 0
          return (
            <div key={b.label} className="flex items-center gap-3 text-sm">
              <span className={`w-40 shrink-0 ${isRecovered ? 'font-semibold text-green-700' : 'text-ink'}`}>
                {b.label}
              </span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-peach-light">
                <div
                  className={`h-full rounded-full ${isRecovered ? 'bg-green-500' : 'bg-salmon'}`}
                  style={{ width: `${barWidth}%` }}
                />
              </div>
              <span className={`w-16 shrink-0 text-right ${isRecovered ? 'font-semibold text-green-700' : 'text-ink-soft'}`}>
                {b.n.toLocaleString()}
              </span>
              <span className="w-12 shrink-0 text-right text-xs text-ink-soft">
                {pct(b.n, agg.total)}
              </span>
            </div>
          )
        })}
      </div>

      {/* ตารางแยกพนักงาน */}
      {agg.byEmployee.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-peach text-left text-xs text-ink-soft">
                <th className="pb-2 font-medium">พนักงาน</th>
                <th className="pb-2 text-right font-medium">จำนวนเคส</th>
                <th className="pb-2 text-right font-medium">คืนเครื่องแล้ว</th>
                <th className="pb-2 text-right font-medium">ล็อค/กดดัน</th>
                <th className="pb-2 text-right font-medium">อยู่กับลูกค้า</th>
                <th className="pb-2 text-right font-medium">ยังไม่ระบุ</th>
              </tr>
            </thead>
            <tbody>
              {agg.byEmployee.map((row) => (
                <tr key={row.employee} className="border-b border-peach/40 last:border-0">
                  <td className="py-2 font-medium text-ink">{row.employee}</td>
                  <td className="py-2 text-right text-ink-soft">{row.cases}</td>
                  <td className="py-2 text-right font-semibold text-green-700">
                    {row.recovered > 0 ? row.recovered : '—'}
                  </td>
                  <td className="py-2 text-right text-ink-soft">{row.locked > 0 ? row.locked : '—'}</td>
                  <td className="py-2 text-right text-ink-soft">{row.withCustomer > 0 ? row.withCustomer : '—'}</td>
                  <td className="py-2 text-right text-ink-soft">{row.unspecified > 0 ? row.unspecified : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
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

// ===== หน้าหลัก =====

interface AllData {
  summary: DebtflowSummary
  cases: DebtflowCase[]
}

async function loadAll(): Promise<AllData> {
  const [summary, cases] = await Promise.all([
    getDebtflowSummary(),
    getDebtflowCases(),
  ])
  return { summary, cases }
}

const INIT: AllData = {
  summary: EMPTY_SUMMARY,
  cases: [],
}

export default function DebtflowReport() {
  const { data, loading, error } = useAsync(loadAll, INIT)
  const { summary, cases } = data

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

      {/* การตามเครื่อง */}
      <DeviceSection cases={cases} />

      {/* รายเคส */}
      <CaseTable cases={cases} />
    </div>
  )
}
