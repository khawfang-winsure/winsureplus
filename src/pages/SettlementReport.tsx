import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, EmptyState, Field, Input, Loading, PageTitle } from '../components/ui'
import { getSettlementReport, listEarlyCloseCandidates, type EarlyCloseCandidate } from '../lib/db'
import { baht, thaiDate } from '../lib/format'

type ReportRow = {
  contractId: string
  contractNo: string
  customerName: string
  discount: number
  remaining: number
  paid: number
  settledAt: string
  settledBy: string
}

type Report = {
  rows: ReportRow[]
  totalDiscount: number
  totalPaid: number
  count: number
}

const emptyReport: Report = { rows: [], totalDiscount: 0, totalPaid: 0, count: 0 }

type Tab = 'report' | 'waiting'

export default function SettlementReport() {
  const [tab, setTab] = useState<Tab>('report')
  const [report, setReport] = useState<Report>(emptyReport)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')

  // แท็บ "รอกดปิด" — สัญญาที่เงินเข้าครบแล้ว รอแอดมินกดปิด (โหลดแยก ไม่ผูกกับตัวกรองวันที่ของรายงาน)
  const [candidates, setCandidates] = useState<EarlyCloseCandidate[] | null>(null)
  const [candLoading, setCandLoading] = useState(true)
  const [candErr, setCandErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const r = await getSettlementReport(fromDate || undefined, toDate || undefined)
      setReport(r)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [fromDate, toDate])

  const loadCandidates = useCallback(async () => {
    setCandLoading(true)
    setCandErr(null)
    try {
      setCandidates(await listEarlyCloseCandidates())
    } catch (e) {
      setCandErr(e instanceof Error ? e.message : String(e))
    } finally {
      setCandLoading(false)
    }
  }, [])

  // โหลดครั้งแรก
  useEffect(() => {
    load()
    void loadCandidates()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function clearFilter() {
    setFromDate('')
    setToDate('')
  }

  const waitingCount = candidates?.length ?? 0
  const tabCls = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold transition ${
      active ? 'bg-salmon-deep text-white' : 'bg-peach-light/60 text-ink hover:bg-peach-light'
    }`

  return (
    <div>
      <PageTitle sub="ประวัติลูกค้าที่ปิดสัญญาก่อนกำหนด พร้อมส่วนลดที่ให้ไป">
        รายงานปิดสัญญาก่อนกำหนด
      </PageTitle>

      <div className="mb-4 flex flex-wrap gap-2" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'report'}
          className={tabCls(tab === 'report')}
          onClick={() => setTab('report')}
        >
          รายงานที่ปิดแล้ว
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'waiting'}
          className={tabCls(tab === 'waiting')}
          onClick={() => setTab('waiting')}
        >
          รอกดปิด
          {waitingCount > 0 && (
            <span className="rounded-full bg-red-500 px-1.5 text-[11px] font-bold leading-5 text-white">
              {waitingCount}
            </span>
          )}
        </button>
      </div>

      {tab === 'waiting' ? (
        <WaitingTab
          loading={candLoading}
          err={candErr}
          rows={candidates ?? []}
          onReload={() => void loadCandidates()}
        />
      ) : (
        <>
          {/* ===== ตัวกรองช่วงวันที่ ===== */}
          <Card className="mb-4 py-3">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="ตั้งแต่วันที่">
                <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
              </Field>
              <Field label="ถึงวันที่">
                <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
              </Field>
              <Button onClick={() => void load()} disabled={loading}>
                {loading ? 'กำลังโหลด...' : 'ดูรายงาน'}
              </Button>
              {(fromDate || toDate) && (
                <Button variant="ghost" onClick={() => { clearFilter() }}>
                  ล้างตัวกรอง
                </Button>
              )}
            </div>
          </Card>

          {loading ? (
            <Loading />
          ) : err ? (
            <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{err}</p>
          ) : (
            <>
              {/* ===== KPI ===== */}
              <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Card className="p-4 text-center">
                  <p className="mb-1 text-xs text-ink-soft">จำนวนเคสที่ปิด</p>
                  <p className="text-xl font-bold text-ink">{report.count.toLocaleString()}</p>
                  <p className="text-xs text-ink-soft">เคส</p>
                </Card>
                <Card className="p-4 text-center">
                  <p className="mb-1 text-xs text-ink-soft">รวมส่วนลดที่ให้</p>
                  <p className="text-xl font-bold text-green-700 whitespace-nowrap">{baht(report.totalDiscount)} ฿</p>
                </Card>
                <Card className="p-4 text-center">
                  <p className="mb-1 text-xs text-ink-soft">รวมเงินรับปิด</p>
                  <p className="text-xl font-bold text-salmon-deep whitespace-nowrap">{baht(report.totalPaid)} ฿</p>
                </Card>
              </div>

              {/* ===== ตาราง ===== */}
              {report.rows.length === 0 ? (
                <EmptyState
                  title="ยังไม่มีเคสปิดสัญญาก่อนกำหนด"
                  hint="เมื่อมีลูกค้าปิดสัญญาก่อนกำหนด รายการจะแสดงที่นี่"
                />
              ) : (
                <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
                  <table className="w-full min-w-[760px] text-sm">
                    <thead>
                      <tr className="bg-peach-light text-left text-ink">
                        {['สัญญา', 'ลูกค้า', 'วันที่ปิด', 'ค่างวดเหลือ', 'ส่วนลด', 'จ่ายปิด', 'โดย'].map((h) => (
                          <th key={h} className="px-3 py-2.5 font-semibold">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {report.rows.map((r, idx) => (
                        <tr key={r.contractId} className={idx % 2 ? 'bg-white' : 'bg-peach-light/20'}>
                          <td className="px-3 py-2.5">
                            <Link to={`/contract/${r.contractId}`} className="font-medium text-salmon-deep hover:underline">
                              {r.contractNo}
                            </Link>
                          </td>
                          <td className="px-3 py-2.5">{r.customerName}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap">{thaiDate(r.settledAt.slice(0, 10))}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap">{baht(r.remaining)} ฿</td>
                          <td className="px-3 py-2.5 whitespace-nowrap text-green-700">{baht(r.discount)} ฿</td>
                          <td className="px-3 py-2.5 whitespace-nowrap font-semibold text-ink">{baht(r.paid)} ฿</td>
                          <td className="px-3 py-2.5 text-ink-soft">{r.settledBy || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

/** แท็บ "รอกดปิด" — ลูกค้าจ่ายเงินปิดสัญญาเข้ามาแล้วแต่สัญญายังขึ้นผ่อนอยู่ รอแอดมินเปิดสัญญาแล้วกด "ปิดสัญญาก่อนกำหนด" */
function WaitingTab({
  loading,
  err,
  rows,
  onReload,
}: {
  loading: boolean
  err: string | null
  rows: EarlyCloseCandidate[]
  onReload: () => void
}) {
  if (loading) return <Loading />
  if (err) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">
        <span>โหลดรายการรอกดปิดไม่สำเร็จ: {err}</span>
        <Button variant="ghost" onClick={onReload}>ลองใหม่</Button>
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title="ไม่มีสัญญารอกดปิด"
        hint="เมื่อลูกค้าจ่ายเงินปิดสัญญาเข้ามาแล้ว แต่สัญญายังไม่ถูกปิด จะแสดงที่นี่"
      />
    )
  }
  return (
    <>
      <p className="mb-3 text-sm text-ink-soft">
        ลูกค้ากลุ่มนี้จ่ายเงินปิดสัญญาเข้ามาแล้ว แต่สัญญายังขึ้นเป็นผ่อนอยู่ — กดที่เลขสัญญา แล้วกด &quot;ปิดสัญญาก่อนกำหนด&quot;
      </p>
      <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="bg-peach-light text-left text-ink">
              {['สัญญา', 'ลูกค้า', 'เงินเข้าล่าสุด', 'งวดสุดท้ายครบกำหนด', 'ยอดเต็ม', 'รับแล้ว', 'ส่วนลด', 'หมายเหตุ'].map((h) => (
                <th key={h} className="px-3 py-2.5 font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={r.contractId} className={idx % 2 ? 'bg-white' : 'bg-peach-light/20'}>
                <td className="px-3 py-2.5">
                  <Link to={`/contract/${r.contractId}`} className="font-medium text-salmon-deep hover:underline">
                    {r.contractNo}
                  </Link>
                </td>
                <td className="px-3 py-2.5">{r.customerName}</td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  {r.closedDay ? thaiDate(r.closedDay) : '—'}
                  <span className="block text-xs text-ink-soft">{r.daysSinceD} วันก่อน</span>
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">{r.lastDueDate ? thaiDate(r.lastDueDate) : '—'}</td>
                <td className="px-3 py-2.5 whitespace-nowrap">{baht(r.gross)} ฿</td>
                <td className="px-3 py-2.5 whitespace-nowrap font-semibold text-ink">{baht(r.received)} ฿</td>
                <td className="px-3 py-2.5 whitespace-nowrap text-green-700">
                  {baht(r.shortfall)} ฿ ({(r.shortfallPct * 100).toFixed(1)}%)
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {r.penaltyDue > 0 && <Badge tone="red">ค่าปรับค้าง {baht(r.penaltyDue)} ฿</Badge>}
                    {r.hasPendingPjReview && <Badge tone="amber">มีใบ PJ รอตรวจ</Badge>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
