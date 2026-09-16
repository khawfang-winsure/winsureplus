import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Printer } from 'lucide-react'
import { Badge, Card, Field, Input, Loading, PageTitle } from '../components/ui'
import { baht, thaiDate } from '../lib/format'
import {
  getContracts,
  getAllStatuses,
  getFirstInstallments,
  getReturns,
  getAllShops,
  getContractAggregates,
  getNplHistory,
  NPL_HISTORY_MIN_DATE,
  type NplHistoryPoint,
} from '../lib/db'
import {
  buildMonthlyReport,
  DEFAULT_MONTHLY_TARGETS,
  type MonthlyReport,
  type DimensionRow,
  type RiskLevel,
} from '../lib/monthlyReport'
import {
  nplValueRate,
  nplCountRate,
  summarizeNplRange,
  pickNplTableRows,
  nplHistorySourceLabel,
  nplHistoryPresetRange,
  nplHistoryAnchorISO,
  nplHistoryFootnote,
  todayISOBangkok,
  type NplHistoryPreset,
} from '../lib/nplHistory'

/** เดือนก่อนหน้าเดือนปัจจุบัน (Asia/Bangkok) — default = เดือนล่าสุดที่จบแล้ว */
function defaultMonthISO(): string {
  const todayISO = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)
  const [y, m] = todayISO.slice(0, 7).split('-').map(Number)
  const prevM = m === 1 ? 12 : m - 1
  const prevY = m === 1 ? y - 1 : y
  return `${prevY}-${String(prevM).padStart(2, '0')}`
}

function shiftMonth(monthISO: string, delta: number): string {
  const [y, m] = monthISO.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  const newY = Math.floor(total / 12)
  const newM = (total % 12) + 1
  return `${newY}-${String(newM).padStart(2, '0')}`
}

function monthLabel(monthISO: string): string {
  const MONTH_TH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
  const [y, m] = monthISO.split('-').map(Number)
  return `${MONTH_TH[m - 1]} ${y + 543}`
}

export default function MonthlyReportPage() {
  const [monthISO, setMonthISO] = useState<string>(defaultMonthISO)
  const [data, setData] = useState<MonthlyReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setErr(null)
    Promise.all([getContracts(), getAllStatuses(), getFirstInstallments(), getReturns(), getAllShops(), getContractAggregates()])
      .then(([contracts, statuses, firstInstallments, returns, shops, aggregates]) => {
        if (!active) return
        const built = buildMonthlyReport({ contracts, statuses, firstInstallments, returns, shops, aggregates }, monthISO, DEFAULT_MONTHLY_TARGETS)
        setData(built)
      })
      .catch((e: unknown) => {
        if (active) setErr(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [monthISO])

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <PageTitle sub={`รายงานประจำเดือนส่งผู้บริหาร — สถานะหนี้คำนวณ ณ วันนี้ (${data ? thaiDate(data.asOfISO) : ''})`}>
          รายงานประจำเดือน
        </PageTitle>
        <button
          onClick={() => window.print()}
          className="inline-flex items-center gap-2 rounded-xl border border-peach bg-white px-3.5 py-2 text-sm font-semibold text-ink-soft hover:bg-peach-light"
        >
          <Printer size={16} /> พิมพ์
        </button>
      </div>

      <div className="flex items-center justify-center gap-3 print:hidden">
        <button
          onClick={() => setMonthISO((m) => shiftMonth(m, -1))}
          aria-label="เดือนก่อนหน้า"
          className="rounded-xl border border-peach bg-white p-2 text-ink-soft hover:bg-peach-light"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="min-w-[140px] text-center text-lg font-semibold text-ink">{monthLabel(monthISO)}</span>
        <button
          onClick={() => setMonthISO((m) => shiftMonth(m, 1))}
          aria-label="เดือนถัดไป"
          className="rounded-xl border border-peach bg-white p-2 text-ink-soft hover:bg-peach-light"
        >
          <ChevronRight size={18} />
        </button>
      </div>

      {loading || !data ? (
        <Loading />
      ) : err ? (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{err}</p>
      ) : data.approval.newContractsCount === 0 &&
        data.kpiFirstDefault.denominator === 0 &&
        data.shopTop10.length === 0 &&
        data.shopSilent.length === 0 ? (
        <Card>
          <p className="text-center text-sm text-ink-soft">ไม่มีสัญญาในเดือนนี้</p>
        </Card>
      ) : (
        <>
          <KpiSection data={data} />
          {/* key=monthISO: เปลี่ยนเดือนรายงาน (ลูกศร ◀/▶) → remount การ์ดนี้ทั้งก้อน รีเซ็ตกลับ "3 เดือนล่าสุด" ของเดือนใหม่เสมอ
              (เลี่ยง effect ไล่ sync เอง — unmount ตัวเก่าจะ cleanup fetch ค้างให้อัตโนมัติ ไม่มีผลเก่าทับผลใหม่) */}
          <NplHistoryCard key={data.monthISO} reportMonthISO={data.monthISO} badDebtTarget={data.targets.badDebt60Target} />
          <ApprovalSection data={data} />
          <FollowUpSection data={data} />
          <DimensionSection title="อาชีพ" rows={data.occupationRows} />
          <DimensionSection title="ช่วงอายุ" rows={data.ageRows} />
          <DimensionSection title="รุ่นเครื่อง" rows={data.modelRows} />
          <ShopSection data={data} />
          <DeviceReturnSection data={data} />
        </>
      )}
    </div>
  )
}

// ===== KPI การ์ด =====
function deltaTone(actual: number, target: number | null, lowerIsBetter = true): 'text-green-600' | 'text-red-600' | 'text-ink-soft' {
  if (target === null) return 'text-ink-soft'
  const better = lowerIsBetter ? actual <= target : actual >= target
  return better ? 'text-green-600' : 'text-red-600'
}

function KpiSection({ data }: { data: MonthlyReport }) {
  const { kpiFirstDefault, kpiBadDebt60, kpiLate30to60, targets } = data
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card>
        <h3 className="mb-1 font-semibold text-ink">อัตราผิดนัดงวดแรก</h3>
        <p className="mb-2 text-xs text-ink-soft">
          สัญญาที่ทำในเดือนนี้และงวด 1 ถึงกำหนดแล้ว: {kpiFirstDefault.numerator}/{kpiFirstDefault.denominator} ราย
        </p>
        <p className={`text-3xl font-bold ${deltaTone(kpiFirstDefault.rate, targets.firstDefaultRateTarget)}`}>
          {kpiFirstDefault.rate.toFixed(2)}%
        </p>
        <p className="mt-1 text-xs text-ink-soft">เป้า {targets.firstDefaultRateTarget.toFixed(2)}%</p>
      </Card>

      <Card>
        <h3 className="mb-1 font-semibold text-ink">หนี้เสีย (ล่าช้า 60 วันขึ้นไป)</h3>
        <p className="mb-2 text-xs text-ink-soft">เฉพาะสัญญาที่ยังผ่อนอยู่ (active) ณ วันนี้</p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <p className={`text-2xl font-bold ${deltaTone(kpiBadDebt60.valueRate, targets.badDebt60Target)}`}>
              {kpiBadDebt60.valueRate.toFixed(2)}%
            </p>
            <p className="text-xs text-ink-soft">
              ตามมูลค่า ฿{baht(kpiBadDebt60.value)}/฿{baht(kpiBadDebt60.valueDenominator)}
            </p>
          </div>
          <div>
            <p className="text-2xl font-bold text-ink-soft">{kpiBadDebt60.countRate.toFixed(2)}%</p>
            <p className="text-xs text-ink-soft">
              ตามสัญญา {kpiBadDebt60.count}/{kpiBadDebt60.countDenominator} ราย
            </p>
          </div>
        </div>
        <p className="mt-2 text-xs text-ink-soft">เป้า {targets.badDebt60Target.toFixed(2)}% (ตามมูลค่า)</p>
      </Card>

      <Card>
        <h3 className="mb-1 font-semibold text-ink">ล่าช้า 30-60 วัน</h3>
        <p className="mb-2 text-xs text-ink-soft">เฉพาะสัญญาที่ยังผ่อนอยู่ (active) ณ วันนี้</p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <p className="text-2xl font-bold text-ink">{kpiLate30to60.valueRate.toFixed(2)}%</p>
            <p className="text-xs text-ink-soft">
              ตามมูลค่า ฿{baht(kpiLate30to60.value)}/฿{baht(kpiLate30to60.valueDenominator)}
            </p>
          </div>
          <div>
            <p className="text-2xl font-bold text-ink-soft">{kpiLate30to60.countRate.toFixed(2)}%</p>
            <p className="text-xs text-ink-soft">
              ตามสัญญา {kpiLate30to60.count}/{kpiLate30to60.countDenominator} ราย
            </p>
          </div>
        </div>
        <p className="mt-2 text-xs text-ink-soft">ยังไม่ตั้งเป้าหมาย</p>
      </Card>
    </div>
  )
}

// ===== ประวัติหนี้เสีย (โหลดแยกจาก data หลักของหน้า — error/ช้าที่นี่ไม่กระทบส่วนอื่น) =====
const NPL_PRESETS: { value: NplHistoryPreset; label: string }[] = [
  { value: 'thisMonth', label: 'เดือนนี้' },
  { value: 'last3Months', label: '3 เดือนล่าสุด' },
  { value: 'all', label: 'ทั้งหมด' },
]

const NPL_SOURCE_TONE: Record<NplHistoryPoint['source'], 'green' | 'amber' | 'neutral'> = {
  backfill: 'amber',
  daily: 'green',
  live: 'neutral',
}

/** ตัวย่อวันที่แกน X กราฟ เช่น "16/9" (ไม่มีปี — วันที่เต็มดูได้ที่ตาราง/แผงรายละเอียดใต้กราฟ) */
function shortAxisDate(iso: string): string {
  const parts = iso.split('-')
  return `${Number(parts[2] ?? 0)}/${Number(parts[1] ?? 0)}`
}

/** เปลี่ยนแปลงหน่วยจุด % เช่น "+0.24 จุด" / "-0.24 จุด" / "±0.00 จุด" */
function fmtChangePts(delta: number): string {
  const sign = delta > 0 ? '+' : delta < 0 ? '' : '±'
  return `${sign}${delta.toFixed(2)} จุด`
}

/** เปลี่ยนแปลง: เพิ่ม = แย่ลง (แดง), ลด = ดีขึ้น (เขียว), เท่าเดิม = เทา */
function changeTone(delta: number): 'text-red-600' | 'text-green-600' | 'text-ink-soft' {
  if (delta > 0) return 'text-red-600'
  if (delta < 0) return 'text-green-600'
  return 'text-ink-soft'
}

function NplHistoryCard({ reportMonthISO, badDebtTarget }: { reportMonthISO: string; badDebtTarget: number }) {
  const today = todayISOBangkok()

  const [preset, setPreset] = useState<NplHistoryPreset | null>('last3Months')
  // ค่าเริ่มต้น (ครั้งเดียวตอน mount): ถ้าหน้ารายงานกำลังดูเดือนในอดีต ให้กราฟจบตรงสิ้นเดือนนั้น ไม่ใช่วันนี้เสมอไป
  const [range, setRange] = useState<{ from: string; to: string }>(() =>
    nplHistoryPresetRange('last3Months', NPL_HISTORY_MIN_DATE, nplHistoryAnchorISO(reportMonthISO)),
  )
  const [points, setPoints] = useState<NplHistoryPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  const invalidRange = range.from > range.to

  useEffect(() => {
    if (range.from > range.to) {
      setLoading(false)
      setErr(null)
      return
    }
    let active = true
    setLoading(true)
    setErr(null)
    getNplHistory(range.from, range.to)
      .then((pts) => {
        if (!active) return
        setPoints(pts)
        setActiveIndex(null)
      })
      .catch((e: unknown) => {
        if (active) setErr(e instanceof Error ? e.message : 'โหลดข้อมูลประวัติหนี้เสียไม่สำเร็จ')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [range.from, range.to])

  function applyPreset(p: NplHistoryPreset) {
    setPreset(p)
    // ปุ่มลัดยึดวันนี้จริงเสมอ (ต่างจากค่าเริ่มต้นตอน mount ที่ยึดเดือนของรายงานที่กำลังดู)
    setRange(nplHistoryPresetRange(p, NPL_HISTORY_MIN_DATE, todayISOBangkok()))
  }

  function updateFrom(value: string) {
    setPreset(null)
    setRange((r) => ({ ...r, from: value }))
  }

  function updateTo(value: string) {
    setPreset(null)
    setRange((r) => ({ ...r, to: value }))
  }

  const summary = useMemo(() => summarizeNplRange(points), [points])
  const tableRows = useMemo(() => pickNplTableRows(points), [points])
  const activePoint = activeIndex !== null ? points[activeIndex] : null
  const detailPoint = activePoint ?? (points.length > 0 ? points[points.length - 1] : null)

  return (
    <Card className="print:break-inside-avoid">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-ink">ประวัติหนี้เสีย (ล่าช้า 60 วันขึ้นไป)</h3>
          <p className="mt-0.5 text-xs text-ink-soft">ย้อนดูหนี้เสีย ณ วันที่ต่าง ๆ ในอดีต — เทียบการเปลี่ยนแปลงตามช่วงที่เลือก</p>
        </div>
        <div
          className="flex overflow-hidden rounded-xl border border-peach text-sm print:hidden"
          role="group"
          aria-label="เลือกช่วงเวลาแบบลัด"
        >
          {NPL_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => applyPreset(p.value)}
              aria-pressed={preset === p.value}
              className={`px-3 py-1.5 font-medium transition ${
                preset === p.value ? 'bg-salmon-deep text-white' : 'bg-white text-ink-soft hover:bg-peach-light'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3 print:hidden">
        <Field label="จากวันที่">
          <Input type="date" value={range.from} min={NPL_HISTORY_MIN_DATE} max={today} onChange={(e) => updateFrom(e.target.value)} />
        </Field>
        <Field label="ถึงวันที่">
          <Input type="date" value={range.to} min={NPL_HISTORY_MIN_DATE} max={today} onChange={(e) => updateTo(e.target.value)} />
        </Field>
      </div>

      {invalidRange ? (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">"จากวันที่" ต้องไม่เกิน "ถึงวันที่" — กรุณาเลือกช่วงวันที่ใหม่</p>
      ) : loading ? (
        <Loading label="กำลังโหลดประวัติหนี้เสีย..." />
      ) : err ? (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{err}</p>
      ) : points.length === 0 || !summary ? (
        <p className="rounded-xl border-2 border-dashed border-peach bg-peach-light/30 px-4 py-6 text-center text-sm text-ink-soft">
          ยังไม่มีข้อมูลในช่วงที่เลือก
        </p>
      ) : (
        <>
          {/* แถวสรุป 4 ช่อง */}
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl bg-peach-light/40 py-2.5 text-center">
              <p className="text-xs text-ink-soft">ต้นช่วง ({thaiDate(summary.start.date)})</p>
              <p className={`text-xl font-bold ${deltaTone(nplValueRate(summary.start), badDebtTarget)}`}>
                {nplValueRate(summary.start).toFixed(2)}%
              </p>
              <p className="text-xs text-ink-soft">สัญญา {nplCountRate(summary.start).toFixed(2)}%</p>
            </div>
            <div className="rounded-xl bg-peach-light/40 py-2.5 text-center">
              <p className="text-xs text-ink-soft">ปลายช่วง ({thaiDate(summary.end.date)})</p>
              <p className={`text-xl font-bold ${deltaTone(nplValueRate(summary.end), badDebtTarget)}`}>
                {nplValueRate(summary.end).toFixed(2)}%
              </p>
              <p className="text-xs text-ink-soft">สัญญา {nplCountRate(summary.end).toFixed(2)}%</p>
            </div>
            <div className="rounded-xl bg-peach-light/40 py-2.5 text-center">
              <p className="text-xs text-ink-soft">เปลี่ยนแปลง</p>
              <p className={`text-xl font-bold ${changeTone(summary.changeValuePts)}`}>{fmtChangePts(summary.changeValuePts)}</p>
              <p className="text-xs text-ink-soft">สัญญา {fmtChangePts(summary.changeCountPts)}</p>
            </div>
            <div className="rounded-xl bg-peach-light/40 py-2.5 text-center">
              <p className="text-xs text-ink-soft">สูงสุดในช่วง ({thaiDate(summary.peak.date)})</p>
              <p className={`text-xl font-bold ${deltaTone(nplValueRate(summary.peak), badDebtTarget)}`}>
                {nplValueRate(summary.peak).toFixed(2)}%
              </p>
              <p className="text-xs text-ink-soft">สัญญา {nplCountRate(summary.peak).toFixed(2)}%</p>
            </div>
          </div>

          {/* legend + กราฟ */}
          <div className="mb-2 flex items-center gap-4 text-xs text-ink-soft">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: '#dc2626' }} /> % มูลค่า
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: '#f59e0b' }} /> % สัญญา
            </span>
          </div>
          <NplHistoryChart points={points} activeIndex={activeIndex} onActiveIndexChange={setActiveIndex} />

          {/* แผงรายละเอียดวันที่เลือก (แตะ/ชี้ที่กราฟ หรือค่าเริ่มต้น = วันล่าสุดของช่วง) */}
          {detailPoint && (
            <div className="mt-2 rounded-xl border border-peach bg-white px-4 py-3 text-sm">
              <p className="font-semibold text-ink">{thaiDate(detailPoint.date)}</p>
              <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-ink-soft sm:grid-cols-4">
                <p className="tabular-nums">มูลค่า {nplValueRate(detailPoint).toFixed(2)}%</p>
                <p className="tabular-nums">สัญญา {nplCountRate(detailPoint).toFixed(2)}%</p>
                <p className="tabular-nums">
                  ฿{baht(detailPoint.badOutstanding)} / ฿{baht(detailPoint.outstandingTotal)}
                </p>
                <p className="tabular-nums">
                  {detailPoint.badCount} / {detailPoint.activeCount} ราย
                </p>
              </div>
              {points.length > 1 && activeIndex === null && (
                <p className="mt-1 text-xs italic text-ink-soft print:hidden">แตะหรือชี้ที่กราฟเพื่อดูวันอื่น</p>
              )}
            </div>
          )}

          {/* ตาราง */}
          <div className="scrollbar-thin mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-peach text-left text-ink-soft">
                  <th className="py-2 font-semibold">ณ วันที่</th>
                  <th className="py-2 text-right font-semibold">หนี้เสีย (มูลค่า) %</th>
                  <th className="py-2 text-right font-semibold">ยอดหนี้เสีย / ยอดคงเหลือ</th>
                  <th className="py-2 text-right font-semibold">หนี้เสีย (สัญญา) %</th>
                  <th className="py-2 text-right font-semibold">ราย / ทั้งหมด</th>
                  <th className="py-2 text-right font-semibold">ที่มา</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((r) => (
                  <tr key={r.date} className="border-b border-peach/50 last:border-0">
                    <td className="py-1.5 text-ink">{thaiDate(r.date)}</td>
                    <td className="py-1.5 text-right tabular-nums text-ink">{nplValueRate(r).toFixed(2)}%</td>
                    <td className="py-1.5 text-right tabular-nums text-ink-soft">
                      ฿{baht(r.badOutstanding)} / ฿{baht(r.outstandingTotal)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-ink">{nplCountRate(r).toFixed(2)}%</td>
                    <td className="py-1.5 text-right tabular-nums text-ink-soft">
                      {r.badCount} / {r.activeCount}
                    </td>
                    <td className="py-1.5 text-right">
                      <Badge tone={NPL_SOURCE_TONE[r.source]}>{nplHistorySourceLabel(r.source)}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className="mt-3 text-xs text-ink-soft">{nplHistoryFootnote(NPL_HISTORY_MIN_DATE)}</p>
    </Card>
  )
}

function NplHistoryChart({
  points,
  activeIndex,
  onActiveIndexChange,
}: {
  points: NplHistoryPoint[]
  activeIndex: number | null
  onActiveIndexChange: (i: number | null) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const n = points.length
  if (n === 0) return null

  const W = 680
  const H = 220
  const PAD = { l: 34, r: 14, t: 18, b: 26 }
  const plotW = W - PAD.l - PAD.r
  const lastIdx = n - 1

  const valueRates = points.map(nplValueRate)
  const countRates = points.map(nplCountRate)
  const rawMax = Math.max(0.1, ...valueRates, ...countRates)
  const yMax = Math.ceil(rawMax * 1.2 * 10) / 10

  const xAt = (i: number) => PAD.l + (n <= 1 ? plotW / 2 : (i / lastIdx) * plotW)
  const yAt = (v: number) => PAD.t + (1 - v / yMax) * (H - PAD.t - PAD.b)

  const valueLinePts = points.map((p, i) => `${xAt(i).toFixed(1)},${yAt(nplValueRate(p)).toFixed(1)}`).join(' ')
  const countLinePts = points.map((p, i) => `${xAt(i).toFixed(1)},${yAt(nplCountRate(p)).toFixed(1)}`).join(' ')

  const gridVals = [0, yMax / 4, yMax / 2, (yMax * 3) / 4, yMax]
  const showEvery = n <= 8 ? 1 : Math.ceil(n / 8)

  function indexFromClientX(clientX: number): number | null {
    const svgEl = svgRef.current
    if (!svgEl) return null
    const rect = svgEl.getBoundingClientRect()
    if (rect.width === 0) return null
    const scaleX = rect.width / W
    const xInSvg = (clientX - rect.left) / scaleX
    const clamped = Math.max(PAD.l, Math.min(W - PAD.r, xInSvg))
    const frac = n <= 1 ? 0 : (clamped - PAD.l) / plotW
    return Math.max(0, Math.min(lastIdx, Math.round(frac * lastIdx)))
  }

  function handlePointerMove(e: React.PointerEvent<SVGRectElement>) {
    const idx = indexFromClientX(e.clientX)
    if (idx !== null) onActiveIndexChange(idx)
  }
  function handlePointerDown(e: React.PointerEvent<SVGRectElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    handlePointerMove(e)
  }
  function handlePointerLeave(e: React.PointerEvent<SVGRectElement>) {
    if (e.pointerType === 'mouse') onActiveIndexChange(null)
  }

  const first = points[0]
  const last = points[lastIdx]
  const ariaLabel = `กราฟแนวโน้มหนี้เสียตามมูลค่า ตั้งแต่วันที่ ${thaiDate(first.date)} ถึง ${thaiDate(last.date)} — เริ่มที่ ${nplValueRate(first).toFixed(2)}% จบที่ ${nplValueRate(last).toFixed(2)}%`

  return (
    <div className="overflow-x-auto">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ minWidth: n > 20 ? 480 : undefined }}
        role="img"
        aria-label={ariaLabel}
      >
        {gridVals.map((g, gi) => (
          <g key={gi}>
            <line x1={PAD.l} x2={W - PAD.r} y1={yAt(g)} y2={yAt(g)} stroke="currentColor" className="text-peach" strokeWidth={1} opacity={0.6} />
            <text x={PAD.l - 6} y={yAt(g) + 3} textAnchor="end" fill="currentColor" className="text-ink-soft" fontSize={10}>
              {g.toFixed(1)}
            </text>
          </g>
        ))}

        <polyline points={countLinePts} fill="none" stroke="#f59e0b" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" opacity={0.85} />
        <polyline points={valueLinePts} fill="none" stroke="#dc2626" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />

        {activeIndex !== null && (
          <line
            x1={xAt(activeIndex)}
            x2={xAt(activeIndex)}
            y1={PAD.t}
            y2={H - PAD.b}
            stroke="currentColor"
            className="text-ink-soft"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        )}

        {points.map((p, i) => {
          const show = i === activeIndex || (activeIndex === null && i === lastIdx)
          if (!show) return null
          return (
            <g key={p.date}>
              <circle cx={xAt(i)} cy={yAt(nplValueRate(p))} r={5} fill="#dc2626" stroke="#fff" strokeWidth={2} />
              <circle cx={xAt(i)} cy={yAt(nplCountRate(p))} r={4} fill="#f59e0b" stroke="#fff" strokeWidth={2} />
            </g>
          )
        })}

        {points.map((p, i) =>
          i % showEvery === 0 || i === lastIdx ? (
            <text key={p.date} x={xAt(i)} y={H - 7} textAnchor="middle" fill="currentColor" className="text-ink-soft" fontSize={10}>
              {shortAxisDate(p.date)}
            </text>
          ) : null,
        )}

        {/* พื้นที่รับ pointer สำหรับชี้/แตะดูรายละเอียด — touchAction: pan-y ให้ยังเลื่อนหน้าจอแนวตั้งได้ปกติบนมือถือ/iPad */}
        <rect
          x={PAD.l}
          y={0}
          width={plotW}
          height={H}
          fill="transparent"
          onPointerMove={handlePointerMove}
          onPointerDown={handlePointerDown}
          onPointerLeave={handlePointerLeave}
          style={{ touchAction: 'pan-y', cursor: 'crosshair' }}
        />
      </svg>
    </div>
  )
}

// ===== ส่วน1: ยอดอนุมัติ =====
function ApprovalSection({ data }: { data: MonthlyReport }) {
  const { approval } = data
  return (
    <Card>
      <h3 className="mb-3 font-semibold text-ink">ยอดอนุมัติ</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl bg-peach-light/40 py-2.5 text-center">
          <p className="text-xs text-ink-soft">อนุมัติเดือนนี้</p>
          <p className="whitespace-nowrap font-bold text-ink">฿{baht(approval.thisMonthTotal)}</p>
        </div>
        <div className="rounded-xl bg-peach-light/40 py-2.5 text-center">
          <p className="text-xs text-ink-soft">อนุมัติสะสม</p>
          <p className="whitespace-nowrap font-bold text-ink">฿{baht(approval.cumulativeTotal)}</p>
        </div>
        <div className="rounded-xl bg-peach-light/40 py-2.5 text-center">
          <p className="text-xs text-ink-soft">สัญญาใหม่</p>
          <p className="font-bold text-ink">{approval.newContractsCount} ราย</p>
        </div>
        <div className="rounded-xl bg-peach-light/40 py-2.5 text-center">
          <p className="text-xs text-ink-soft">มูลค่าเครื่องเดือนนี้</p>
          <p className="whitespace-nowrap font-bold text-ink">฿{baht(approval.thisMonthDeviceTotal)}</p>
        </div>
      </div>
    </Card>
  )
}

// ===== ส่วนติดตาม =====
function FollowUpSection({ data }: { data: MonthlyReport }) {
  const { followUp } = data
  return (
    <Card>
      <h3 className="mb-3 font-semibold text-ink">การติดตามหนี้</h3>
      {followUp.dataUnavailable ? (
        <p className="text-sm italic text-ink-soft">รอทีมบันทึกในเว็บ</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl bg-peach-light/40 py-2.5 text-center">
            <p className="text-xs text-ink-soft">โทรทั้งหมด</p>
            <p className="font-bold text-ink">{followUp.totalCalls}</p>
          </div>
          <div className="rounded-xl bg-peach-light/40 py-2.5 text-center">
            <p className="text-xs text-ink-soft">นัดจ่าย</p>
            <p className="font-bold text-ink">{followUp.totalPromiseToPay}</p>
          </div>
          <div className="rounded-xl bg-peach-light/40 py-2.5 text-center">
            <p className="text-xs text-ink-soft">รักษาสัญญา</p>
            <p className="font-bold text-ink">{followUp.totalKept}</p>
          </div>
          <div className="rounded-xl bg-peach-light/40 py-2.5 text-center">
            <p className="text-xs text-ink-soft">อัตรารักษาสัญญา</p>
            <p className="font-bold text-ink">{followUp.keptRate?.toFixed(0)}%</p>
          </div>
        </div>
      )}
    </Card>
  )
}

// ===== ส่วน3: มิติ (อาชีพ/อายุ/รุ่นเครื่อง) =====
const RISK_BADGE: Record<RiskLevel, { tone: 'green' | 'amber' | 'red'; label: string }> = {
  low: { tone: 'green', label: 'ต่ำ' },
  mid: { tone: 'amber', label: 'กลาง' },
  high: { tone: 'red', label: 'สูง' },
}

function DimensionSection({ title, rows }: { title: string; rows: DimensionRow[] }) {
  return (
    <Card>
      <h3 className="mb-3 font-semibold text-ink">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-soft">— ไม่มีข้อมูล</p>
      ) : (
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-peach text-left text-ink-soft">
                <th className="py-2 font-semibold">{title}</th>
                <th className="py-2 text-right font-semibold">สัญญาเดือนนี้</th>
                <th className="py-2 text-right font-semibold">% ของเดือน</th>
                <th className="py-2 text-right font-semibold">หนี้เสีย 60+ (สะสม)</th>
                <th className="py-2 text-right font-semibold">% หนี้เสีย (พอร์ตสะสม)</th>
                <th className="py-2 text-right font-semibold">ความเสี่ยง</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b border-peach/50 last:border-0">
                  <td className="py-1.5 text-ink">{r.key}</td>
                  <td className="py-1.5 text-right text-ink">{r.count}</td>
                  <td className="py-1.5 text-right text-ink-soft">{r.pctOfMonth.toFixed(0)}%</td>
                  <td className="py-1.5 text-right text-ink-soft">{r.badDebtCount}</td>
                  <td className="py-1.5 text-right text-ink-soft">{r.badDebtRate.toFixed(1)}%</td>
                  <td className="py-1.5 text-right">
                    <Badge tone={RISK_BADGE[r.riskLevel].tone}>{RISK_BADGE[r.riskLevel].label}</Badge>
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

// ===== ส่วน4: ร้าน =====
function ShopSection({ data }: { data: MonthlyReport }) {
  const { shopTop10, shopSilent } = data
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <h3 className="mb-3 font-semibold text-ink">Top 10 ร้านส่งเคสเยอะ</h3>
        {shopTop10.length === 0 ? (
          <p className="text-sm text-ink-soft">— ไม่มีร้านที่ส่งเคสเดือนนี้</p>
        ) : (
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead>
                <tr className="border-b border-peach text-left text-ink-soft">
                  <th className="py-2 font-semibold">ร้าน</th>
                  <th className="py-2 text-right font-semibold">เดือนนี้</th>
                  <th className="py-2 text-right font-semibold">เดือนก่อน</th>
                  <th className="py-2 text-right font-semibold">MoM</th>
                  <th className="py-2 text-right font-semibold">เกรด</th>
                </tr>
              </thead>
              <tbody>
                {shopTop10.map((s) => {
                  const momColor = s.momDelta > 0 ? 'text-green-600' : s.momDelta < 0 ? 'text-red-600' : 'text-ink-soft'
                  const momSign = s.momDelta > 0 ? '+' : ''
                  return (
                    <tr key={s.shopId} className="border-b border-peach/50 last:border-0">
                      <td className="py-1.5">
                        <Link to={`/shop/${s.shopId}`} className="text-salmon-deep hover:underline">
                          {s.shopName}
                        </Link>
                      </td>
                      <td className="py-1.5 text-right text-ink">{s.casesThisMonth}</td>
                      <td className="py-1.5 text-right text-ink-soft">{s.casesLastMonth}</td>
                      <td className={`py-1.5 text-right font-medium ${momColor}`}>
                        {momSign}
                        {s.momDelta}
                      </td>
                      <td className="py-1.5 text-right">
                        <Badge tone={s.grade === 'A' || s.grade === 'B' ? 'green' : s.grade === 'C' ? 'amber' : 'red'}>{s.grade}</Badge>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h3 className="mb-3 font-semibold text-ink">ร้านเงียบ (ไม่มีเคสเดือนนี้)</h3>
        {shopSilent.length === 0 ? (
          <p className="text-sm text-green-600">— ทุกร้านมีเคสในเดือนนี้</p>
        ) : (
          <div className="scrollbar-thin max-h-80 overflow-y-auto overflow-x-auto">
            <table className="w-full min-w-[380px] text-sm">
              <thead>
                <tr className="border-b border-peach text-left text-ink-soft">
                  <th className="py-2 font-semibold">ร้าน</th>
                  <th className="py-2 text-right font-semibold">เงียบมากี่วัน</th>
                </tr>
              </thead>
              <tbody>
                {shopSilent.map((s) => (
                  <tr key={s.shopId} className="border-b border-peach/50 last:border-0">
                    <td className="py-1.5">
                      <Link to={`/shop/${s.shopId}`} className="text-salmon-deep hover:underline">
                        {s.shopName}
                      </Link>
                    </td>
                    <td className="py-1.5 text-right text-ink-soft">{s.daysSinceLastCase != null ? `${s.daysSinceLastCase} วัน` : 'ไม่เคยมีเคส'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

// ===== เครื่องคืน =====
function DeviceReturnSection({ data }: { data: MonthlyReport }) {
  const { deviceReturn } = data
  return (
    <Card>
      <h3 className="mb-3 font-semibold text-ink">เครื่องคืนในเดือนนี้</h3>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-peach-light/40 py-2.5 text-center">
          <p className="text-xs text-ink-soft">จำนวน</p>
          <p className="text-xl font-bold text-ink">{deviceReturn.count} ราย</p>
        </div>
        <div className="rounded-xl bg-peach-light/40 py-2.5 text-center">
          <p className="text-xs text-ink-soft">มูลค่าเครื่อง</p>
          <p className="whitespace-nowrap text-xl font-bold text-ink">฿{baht(deviceReturn.valueDeviceTotal)}</p>
        </div>
      </div>
      {deviceReturn.note && <p className="mt-3 text-xs text-amber-600">{deviceReturn.note}</p>}
    </Card>
  )
}
