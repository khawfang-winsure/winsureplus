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
              <th className="pb-2 text-right font-medium">เก็บได้ (฿)</th>
              <th className="pb-2 text-right font-medium">ปิดได้</th>
            </tr>
          </thead>
          <tbody>
            {s.byEmployee.map((row) => (
              <tr key={row.employee} className="border-b border-peach/40 last:border-0">
                <td className="py-2 font-medium text-ink">{row.employee}</td>
                <td className="py-2 text-right text-ink-soft">{row.cases}</td>
                <td className="py-2 text-right font-semibold text-green-700">
                  ฿{baht(row.collected)}
                </td>
                <td className="py-2 text-right text-ink-soft">{row.closed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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

async function loadAll(): Promise<{ summary: DebtflowSummary; cases: DebtflowCase[] }> {
  const [summary, cases] = await Promise.all([getDebtflowSummary(), getDebtflowCases()])
  return { summary, cases }
}

const INIT = { summary: EMPTY_SUMMARY, cases: [] as DebtflowCase[] }

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

      {/* รายเคส */}
      <CaseTable cases={cases} />
    </div>
  )
}
