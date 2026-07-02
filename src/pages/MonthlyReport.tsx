import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Printer } from 'lucide-react'
import { Badge, Card, Loading, PageTitle } from '../components/ui'
import { baht, thaiDate } from '../lib/format'
import { getContracts, getAllStatuses, getFirstInstallments, getReturns, getAllShops, getContractAggregates } from '../lib/db'
import {
  buildMonthlyReport,
  DEFAULT_MONTHLY_TARGETS,
  type MonthlyReport,
  type DimensionRow,
  type RiskLevel,
} from '../lib/monthlyReport'

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
