import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Card, Loading, PageTitle, Select } from '../components/ui'
import {
  getDeviceReturnReportRows,
  getShopContractTotals,
} from '../lib/db'
import {
  buildReturnReport,
  type ReturnReport,
  type ReturnByMonth,
  type ReturnByShop,
  type NeverPaidReturned,
  type ReturnRateByShop,
  type ReturnPipeline,
} from '../lib/returnReport'
import type { DeviceReturnReportRow, ShopContractTotal } from '../lib/types'
import { baht, thaiDate } from '../lib/format'
import { useAsync } from '../lib/useAsync'

// ===== helpers =====

function fmtBaht(n: number): string {
  return `฿${baht(n)}`
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return thaiDate(iso.slice(0, 10))
}

// 'yyyy-MM' → 'มี.ค. 2569' (พ.ศ.)
const THAI_MONTH_ABBR = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
]
function thaiMonthLabel(month: string): string {
  const [y, m] = month.split('-')
  const mi = Number(m) - 1
  if (mi < 0 || mi > 11 || !y) return month
  return `${THAI_MONTH_ABBR[mi]} ${Number(y) + 543}`
}

// แปลงสถานะเครื่อง (pipeline) → ไทย
const DEVICE_STATUS_TH: Record<string, string> = {
  in_transit: 'กำลังส่งคืน',
  pending_check: 'รอตรวจ',
  checked: 'ตรวจแล้ว',
  pending_sale: 'รอขาย',
  priced: 'ตั้งราคาแล้ว',
  transferred: 'โอนแล้ว',
  shipped: 'ส่งคืนร้านแล้ว',
}
function deviceStatusTh(s: string): string {
  return DEVICE_STATUS_TH[s] ?? s
}

// ===== 1) KPI =====

function KpiCards({ r }: { r: ReturnReport }) {
  const { kpi } = r
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Card className="p-4 text-center">
        <p className="mb-1 text-xs text-ink-soft">คืนเครื่องทั้งหมด</p>
        <p className="text-xl font-bold text-ink">{kpi.totalReturns.toLocaleString()}</p>
        <p className="text-xs text-ink-soft">เครื่อง</p>
      </Card>
      <Card className="p-4 text-center">
        <p className="mb-1 text-xs text-ink-soft">ยังตามเก็บ</p>
        <p className="text-xl font-bold text-amber-600">{kpi.open.toLocaleString()}</p>
        <p className="text-xs text-ink-soft">เคส</p>
      </Card>
      <Card className="p-4 text-center">
        <p className="mb-1 text-xs text-ink-soft">ปิดแล้ว</p>
        <p className="text-xl font-bold text-green-600">{kpi.closed.toLocaleString()}</p>
        <p className="text-xs text-ink-soft">เคส</p>
      </Card>
      <Card className="p-4 text-center">
        <p className="mb-1 text-xs text-ink-soft">อัตราปิดสำเร็จ</p>
        <p className="text-xl font-bold text-peach-deep">{kpi.closeRatePct}%</p>
        <p className="text-xs text-ink-soft">ของทั้งหมด</p>
      </Card>
      <Card className="p-4 text-center">
        <p className="mb-1 text-xs text-ink-soft">เงินต้นคงค้าง (ยังตามเก็บ)</p>
        <p className="text-lg font-bold text-amber-700">{fmtBaht(kpi.sumPrincipalRemaining)}</p>
      </Card>
      <Card className="p-4 text-center">
        <p className="mb-1 text-xs text-ink-soft">ค่าซ่อมรวม</p>
        <p className="text-lg font-bold text-ink">{fmtBaht(kpi.sumRepair)}</p>
      </Card>
      <Card className="p-4 text-center">
        <p className="mb-1 text-xs text-ink-soft">ขายเครื่องคืนได้</p>
        <p className="text-lg font-bold text-green-700">{fmtBaht(kpi.sumResale)}</p>
      </Card>
      <Card className="border-salmon p-4 text-center">
        <p className="mb-1 text-xs text-ink-soft">ความเสียหายสุทธิ</p>
        <p className="text-lg font-bold text-red-600">{fmtBaht(kpi.netDamage)}</p>
      </Card>
    </div>
  )
}

// ===== 2) รายเดือน — กราฟแท่ง + เลือกปี + toggle บาท =====

function MonthSection({ byMonth }: { byMonth: ReturnByMonth[] }) {
  const years = useMemo(() => {
    const set = new Set<string>()
    for (const m of byMonth) set.add(m.month.slice(0, 4))
    return [...set].sort((a, b) => b.localeCompare(a))
  }, [byMonth])

  const [year, setYear] = useState<string>(() => years[0] ?? '')
  const [mode, setMode] = useState<'count' | 'baht'>('count')

  // ถ้าปีที่เลือกหลุดจากชุดข้อมูล (เปลี่ยน data) ให้ fallback ปีแรก
  const activeYear = years.includes(year) ? year : (years[0] ?? '')

  const rows = useMemo(
    () => byMonth.filter((m) => m.month.startsWith(activeYear)),
    [byMonth, activeYear],
  )

  const maxVal = useMemo(() => {
    if (rows.length === 0) return 0
    return Math.max(...rows.map((m) => (mode === 'count' ? m.count : m.principalRemaining)))
  }, [rows, mode])

  if (byMonth.length === 0) {
    return (
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-ink">คืนเครื่องรายเดือน</h2>
        <p className="py-6 text-center text-ink-soft">ยังไม่มีข้อมูลรายเดือน</p>
      </Card>
    )
  }

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">คืนเครื่องรายเดือน</h2>
        <div className="flex items-center gap-2">
          {/* toggle จำนวน/บาท */}
          <div className="flex overflow-hidden rounded-lg border border-peach text-xs">
            <button
              type="button"
              onClick={() => setMode('count')}
              className={`px-3 py-1.5 ${mode === 'count' ? 'bg-salmon text-white' : 'bg-cream text-ink-soft'}`}
            >
              จำนวน
            </button>
            <button
              type="button"
              onClick={() => setMode('baht')}
              className={`px-3 py-1.5 ${mode === 'baht' ? 'bg-salmon text-white' : 'bg-cream text-ink-soft'}`}
            >
              เงินต้นคงค้าง
            </button>
          </div>
          {/* เลือกปี */}
          <Select
            value={activeYear}
            onChange={(e) => setYear(e.target.value)}
            className="!w-auto min-w-[110px] !py-1.5 !text-sm"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                ปี {Number(y) + 543}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="py-6 text-center text-ink-soft">ไม่มีข้อมูลในปีนี้</p>
      ) : (
        <div className="flex items-end gap-2 overflow-x-auto pb-2" style={{ minHeight: 180 }}>
          {rows.map((m) => {
            const val = mode === 'count' ? m.count : m.principalRemaining
            const h = maxVal > 0 ? Math.round((val / maxVal) * 140) : 0
            return (
              <div key={m.month} className="flex min-w-[44px] flex-1 flex-col items-center gap-1">
                <span className="text-xs font-semibold text-ink">
                  {mode === 'count' ? m.count : (val > 0 ? `฿${baht(val)}` : '0')}
                </span>
                <div className="flex w-full items-end justify-center" style={{ height: 140 }}>
                  <div
                    className="w-7 rounded-t-md bg-salmon"
                    style={{ height: `${Math.max(h, val > 0 ? 4 : 0)}px` }}
                    title={`${thaiMonthLabel(m.month)}: ${mode === 'count' ? `${m.count} เครื่อง` : `฿${baht(m.principalRemaining)}`}`}
                  />
                </div>
                <span className="whitespace-nowrap text-[10px] text-ink-soft">
                  {thaiMonthLabel(m.month)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

// ===== 3) แยกร้าน =====

function ByShopTable({ rows }: { rows: ReturnByShop[] }) {
  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-ink">คืนเครื่องแยกร้าน</h2>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-ink-soft">ไม่มีข้อมูล</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-peach text-left text-xs text-ink-soft">
                <th className="pb-2 font-medium">ร้าน</th>
                <th className="pb-2 text-right font-medium">จำนวนคืน</th>
                <th className="pb-2 text-right font-medium">เงินต้นคงค้าง</th>
                <th className="pb-2 text-right font-medium">ความเสียหายสุทธิ</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.shopId || `none-${i}`} className="border-b border-peach/40 last:border-0">
                  <td className="py-2 font-medium text-ink">{row.shopName}</td>
                  <td className="py-2 text-right text-ink-soft">{row.count}</td>
                  <td className="py-2 text-right text-amber-700">{fmtBaht(row.principalRemaining)}</td>
                  <td className={`py-2 text-right font-semibold ${row.netDamage > 0 ? 'text-red-600' : 'text-green-700'}`}>
                    {fmtBaht(row.netDamage)}
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

// ===== 4) ลูกค้าไม่เคยจ่ายเลย + คืนเครื่อง =====

function NeverPaidTable({ rows }: { rows: NeverPaidReturned[] }) {
  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold text-ink">ลูกค้าไม่เคยจ่ายเลย แล้วคืนเครื่อง</h2>
      <p className="mb-3 text-xs text-ink-soft">เคสที่ไม่เคยชำระค่างวดเลยสักงวด — เสี่ยงเป็นการฉ้อโกง/ผิดนัดตั้งแต่ต้น</p>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-ink-soft">ไม่มี</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-peach text-left text-xs text-ink-soft">
                <th className="pb-2 font-medium">ลูกค้า</th>
                <th className="pb-2 font-medium">ร้าน</th>
                <th className="pb-2 text-right font-medium">เงินต้นคงค้าง</th>
                <th className="pb-2 text-right font-medium">วันคืน</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.contractId} className="border-b border-peach/40 last:border-0 hover:bg-cream/60">
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-2">
                      <Link
                        to={`/contract/${row.contractId}`}
                        className="font-medium text-salmon-deep underline-offset-2 hover:underline"
                      >
                        {row.customerName || row.contractNo}
                      </Link>
                      <Badge tone="red">ไม่เคยจ่ายเลย</Badge>
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-ink-soft">{row.shopName}</td>
                  <td className="py-2 text-right font-semibold text-amber-700">{fmtBaht(row.principalRemaining)}</td>
                  <td className="py-2 text-right text-ink-soft">{fmtDate(row.returnDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ===== 5) อัตราคืนเครื่องต่อร้าน =====

function ReturnRateTable({ rows }: { rows: ReturnRateByShop[] }) {
  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold text-ink">อัตราคืนเครื่องต่อร้าน</h2>
      <p className="mb-3 text-xs text-ink-soft">จับร้านที่ลูกค้าคืนเครื่องบ่อยผิดปกติ — แดง = สูงกว่า 20% ของสัญญาทั้งหมดของร้าน</p>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-ink-soft">ไม่มีข้อมูล</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-peach text-left text-xs text-ink-soft">
                <th className="pb-2 font-medium">ร้าน</th>
                <th className="pb-2 text-right font-medium">คืน / ทั้งหมด</th>
                <th className="pb-2 text-right font-medium">อัตราคืน</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const high = row.ratePct > 20
                return (
                  <tr key={row.shopId} className="border-b border-peach/40 last:border-0">
                    <td className="py-2 font-medium text-ink">{row.shopName}</td>
                    <td className="py-2 text-right text-ink-soft">
                      {row.returns} / {row.totalContracts}
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-peach-light">
                          <div
                            className={`h-full rounded-full ${high ? 'bg-red-500' : 'bg-salmon'}`}
                            style={{ width: `${Math.min(100, row.ratePct)}%` }}
                          />
                        </div>
                        <span className={`w-12 text-right font-semibold ${high ? 'text-red-600' : 'text-ink-soft'}`}>
                          {row.ratePct}%
                        </span>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ===== 6) จ่ายก่อนคืนกี่งวด =====

function PayBeforeSection({ r }: { r: ReturnReport }) {
  const { payBeforeReturn: p } = r
  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold text-ink">จ่ายก่อนคืนกี่งวด</h2>
      <p className="mb-3 text-xs text-ink-soft">เคสที่จ่ายน้อย (≤ 1 งวด) แล้วคืนเครื่อง = เสี่ยงสูง</p>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-peach bg-cream p-4 text-center">
          <p className="mb-1 text-xs text-ink-soft">เฉลี่ยจ่ายก่อนคืน</p>
          <p className="text-xl font-bold text-ink">{p.avgPaidInstallments}</p>
          <p className="text-xs text-ink-soft">งวด</p>
        </div>
        <div className="rounded-xl border border-salmon bg-cream p-4 text-center">
          <p className="mb-1 text-xs text-ink-soft">เคสเสี่ยง (จ่าย ≤ 1 งวด)</p>
          <p className="text-xl font-bold text-red-600">{p.riskLowPayCount}</p>
          <p className="text-xs text-ink-soft">เคส</p>
        </div>
      </div>

      {p.riskLowPay.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-peach text-left text-xs text-ink-soft">
                <th className="pb-2 font-medium">ลูกค้า</th>
                <th className="pb-2 font-medium">ร้าน</th>
                <th className="pb-2 text-right font-medium">เงินต้นคงค้าง</th>
                <th className="pb-2 text-right font-medium">วันคืน</th>
              </tr>
            </thead>
            <tbody>
              {p.riskLowPay.map((row) => (
                <tr key={row.contractId} className="border-b border-peach/40 last:border-0 hover:bg-cream/60">
                  <td className="py-2 pr-3">
                    <Link
                      to={`/contract/${row.contractId}`}
                      className="font-medium text-salmon-deep underline-offset-2 hover:underline"
                    >
                      {row.customerName || row.contractNo}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 text-ink-soft">{row.shopName}</td>
                  <td className="py-2 text-right font-semibold text-amber-700">{fmtBaht(row.principalRemaining)}</td>
                  <td className="py-2 text-right text-ink-soft">{fmtDate(row.returnDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ===== 7) ความเสียหายแยกร้าน =====

function DamageByShopTable({ rows }: { rows: ReturnByShop[] }) {
  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold text-ink">ความเสียหายแยกร้าน</h2>
      <p className="mb-3 text-xs text-ink-soft">ความเสียหายสุทธิ = เงินต้นคงค้าง + ค่าซ่อม − ราคาขายเครื่องคืน (เรียงเสียหายมากสุด)</p>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-ink-soft">ไม่มีข้อมูล</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-peach text-left text-xs text-ink-soft">
                <th className="pb-2 font-medium">ร้าน</th>
                <th className="pb-2 text-right font-medium">จำนวนคืน</th>
                <th className="pb-2 text-right font-medium">เงินต้นคงค้าง</th>
                <th className="pb-2 text-right font-medium">ความเสียหายสุทธิ</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.shopId || `none-${i}`} className="border-b border-peach/40 last:border-0">
                  <td className="py-2 font-medium text-ink">{row.shopName}</td>
                  <td className="py-2 text-right text-ink-soft">{row.count}</td>
                  <td className="py-2 text-right text-amber-700">{fmtBaht(row.principalRemaining)}</td>
                  <td className={`py-2 text-right font-semibold ${row.netDamage > 0 ? 'text-red-600' : 'text-green-700'}`}>
                    {fmtBaht(row.netDamage)}
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

// ===== 8) สถานะเครื่องในมือเรา (pipeline) =====

function PipelineSection({ rows }: { rows: ReturnPipeline[] }) {
  const total = useMemo(() => rows.reduce((s, p) => s + p.count, 0), [rows])
  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold text-ink">สถานะเครื่องในมือเรา</h2>
      <p className="mb-3 text-xs text-ink-soft">เครื่องที่คืนมาแล้วอยู่ขั้นตอนไหน</p>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-ink-soft">ไม่มีข้อมูลสถานะเครื่อง</p>
      ) : (
        <div className="space-y-2">
          {rows.map((p) => {
            const barWidth = total > 0 ? Math.round((p.count / total) * 100) : 0
            return (
              <div key={p.deviceStatus} className="flex items-center gap-3 text-sm">
                <span className="w-32 shrink-0 text-ink">{deviceStatusTh(p.deviceStatus)}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-peach-light">
                  <div className="h-full rounded-full bg-salmon" style={{ width: `${barWidth}%` }} />
                </div>
                <span className="w-12 shrink-0 text-right font-semibold text-ink">{p.count}</span>
                <span className="w-24 shrink-0 text-right text-xs text-ink-soft">
                  {fmtBaht(p.principalRemaining)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

// ===== 9) อัตราปิดสำเร็จ (highlight) =====

function CloseRateCard({ r }: { r: ReturnReport }) {
  const { closeRate: c } = r
  return (
    <Card className="border-green-200 bg-green-50">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-green-800">อัตราปิดสำเร็จ</h2>
          <p className="text-xs text-green-700/80">เคสคืนเครื่องที่รับเงินครบและปิดได้แล้ว</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold text-green-700">{c.pct}%</p>
          <p className="text-xs text-green-700/80">
            ปิด {c.closed.toLocaleString()} / {c.total.toLocaleString()} เคส
          </p>
        </div>
      </div>
      <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-green-100">
        <div className="h-full rounded-full bg-green-500" style={{ width: `${Math.min(100, c.pct)}%` }} />
      </div>
    </Card>
  )
}

// ===== หน้าหลัก =====

interface AllData {
  rows: DeviceReturnReportRow[]
  shopTotals: ShopContractTotal[]
}

async function loadAll(): Promise<AllData> {
  const [rows, shopTotals] = await Promise.all([
    getDeviceReturnReportRows(),
    getShopContractTotals(),
  ])
  return { rows, shopTotals }
}

const INIT: AllData = { rows: [], shopTotals: [] }

export default function ReturnsReport() {
  const { data, loading, error } = useAsync(loadAll, INIT)
  const report = useMemo(
    () => buildReturnReport(data.rows, data.shopTotals),
    [data],
  )

  if (loading) return <Loading />
  if (error) {
    return <div className="p-6 text-center text-red-600">โหลดข้อมูลไม่สำเร็จ: {error}</div>
  }

  if (report.kpi.totalReturns === 0) {
    return (
      <div className="space-y-6 p-4 sm:p-6">
        <PageTitle>รายงานการคืนเครื่อง</PageTitle>
        <Card>
          <p className="py-10 text-center text-ink-soft">ยังไม่มีข้อมูลการคืนเครื่อง</p>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <PageTitle sub="ภาพรวมเครื่องที่ลูกค้าคืน — ความเสียหาย จุดเสี่ยง และสถานะเครื่องในมือ">
        รายงานการคืนเครื่อง
      </PageTitle>

      {/* 1) KPI */}
      <KpiCards r={report} />

      {/* 9) อัตราปิดสำเร็จ (highlight ใต้ KPI) */}
      <CloseRateCard r={report} />

      {/* 2) รายเดือน */}
      <MonthSection byMonth={report.byMonth} />

      {/* 3) แยกร้าน + 7) ความเสียหายแยกร้าน */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ByShopTable rows={report.byShop} />
        <DamageByShopTable rows={report.damageByShop} />
      </div>

      {/* 5) อัตราคืนต่อร้าน + 8) pipeline */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ReturnRateTable rows={report.returnRateByShop} />
        <PipelineSection rows={report.pipeline} />
      </div>

      {/* 6) จ่ายก่อนคืนกี่งวด */}
      <PayBeforeSection r={report} />

      {/* 4) ไม่เคยจ่ายเลย */}
      <NeverPaidTable rows={report.neverPaidReturned} />
    </div>
  )
}
