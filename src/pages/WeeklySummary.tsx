import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, EmptyState, Loading, PageTitle } from '../components/ui'
import { DateRangePicker, type DateRange } from '../components/DateRangePicker'
import { baht, thaiDate } from '../lib/format'
import { getContracts, getReturns, getAllShops, getOverdueInstallmentsAsOf } from '../lib/db'
import { buildWeeklySummary, type WeeklySummary } from '../lib/weeklySummary'

const todayISO = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)

/** วันจันทร์ของสัปดาห์ที่ iso อยู่ (Asia/Bangkok) */
function mondayOf(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const dow = (date.getDay() + 6) % 7 // จันทร์=0 ... อาทิตย์=6
  date.setDate(date.getDate() - dow)
  const yy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

/** วันอาทิตย์ของสัปดาห์ที่ iso อยู่ */
function sundayOf(iso: string): string {
  const mon = mondayOf(iso)
  const [y, m, d] = mon.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + 6)
  const yy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

// สัปดาห์นี้ จันทร์–อาทิตย์ (Asia/Bangkok) — default เมื่อยังไม่เคยเลือกช่วงเอง หรือกด "ทั้งหมด"
const defaultRange: DateRange = { start: mondayOf(todayISO), end: sundayOf(todayISO) }
const STORAGE_KEY = 'weeklySummary.dateRange'

/** อ่านช่วงที่จำไว้จาก localStorage — ถ้ายังไม่เคยเลือก (เข้าครั้งแรก) ใช้ "สัปดาห์นี้ จันทร์–อาทิตย์" เป็นค่าเริ่มต้น */
function loadInitialRange(): DateRange | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return defaultRange
    if (raw === 'null') return null // ผู้ใช้กด "ทั้งหมด" เอง
    const parsed = JSON.parse(raw) as { start?: string; end?: string }
    if (parsed.start && parsed.end && /^\d{4}-\d{2}-\d{2}$/.test(parsed.start) && /^\d{4}-\d{2}-\d{2}$/.test(parsed.end)) {
      return { start: parsed.start, end: parsed.end }
    }
  } catch {
    /* ignore */
  }
  return defaultRange
}

export default function WeeklySummaryPage() {
  const [range, setRange] = useState<DateRange | null>(loadInitialRange)
  const [data, setData] = useState<WeeklySummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const effectiveRange = range ?? defaultRange
    setLoading(true)
    setErr(null)
    Promise.all([
      getContracts(),
      getReturns(),
      getAllShops(),
      getOverdueInstallmentsAsOf(effectiveRange.end),
    ])
      .then(([contracts, returns, shops, overdue]) => {
        if (!active) return
        const built = buildWeeklySummary(
          { contracts, overdue, returns, shops, todayISO },
          effectiveRange.start,
          effectiveRange.end,
        )
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range?.start, range?.end])

  return (
    <div className="flex flex-col gap-5">
      <PageTitle sub="สรุปยอดรายสัปดาห์ — เคสใหม่ ยอดโอนให้ร้าน หนี้เสีย คืนเครื่อง ขายเครื่อง ร้านใหม่">
        สรุปรายสัปดาห์
      </PageTitle>

      <DateRangePicker storageKey={STORAGE_KEY} value={range} onChange={setRange} />

      {loading || !data ? (
        <Loading />
      ) : err ? (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{err}</p>
      ) : (
        <>
          <NewCasesSection data={data} />
          <TransferSection data={data} />
          <BadDebtSection data={data} />
          <div className="grid gap-4 lg:grid-cols-2">
            <ReturnsSection data={data} />
            <SalesSection data={data} />
          </div>
          <NewShopsSection data={data} />
        </>
      )}
    </div>
  )
}

// ===== 1. เคสใหม่รายวัน =====
function NewCasesSection({ data }: { data: WeeklySummary }) {
  const { rows, total } = data.newCasesDaily
  return (
    <Card>
      <h3 className="mb-3 font-semibold text-ink">เคสใหม่รายวัน</h3>
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full min-w-[480px] text-sm">
          <thead>
            <tr className="border-b border-peach text-left text-ink-soft">
              <th className="py-2 font-semibold">วันที่</th>
              <th className="py-2 text-right font-semibold">จำนวนเคสใหม่</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.dateISO} className="border-b border-peach/50 last:border-0">
                <td className="py-1.5 text-ink">{thaiDate(r.dateISO)}</td>
                <td className={`py-1.5 text-right ${r.count > 0 ? 'font-semibold text-ink' : 'text-ink-soft/50'}`}>{r.count}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-peach">
              <td className="py-2 font-semibold text-ink">รวม</td>
              <td className="py-2 text-right font-bold text-salmon-deep">{total} ราย</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  )
}

// ===== 2. ยอดจ่าย/รับเครื่อง =====
function TransferSection({ data }: { data: WeeklySummary }) {
  const { deviceTotal, downTotal, docFeeTotal, netTransferTotal, commissionTotal, rows } = data.transferSummary
  return (
    <Card>
      <h3 className="mb-1 font-semibold text-ink">ยอดจ่าย/รับเครื่อง (โอนให้ร้าน)</h3>
      <p className="mb-3 text-xs text-ink-soft">ค่าคอมจ่ายให้ร้าน — ไม่ได้หักออกจากยอดโอน</p>
      <div className="mb-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div className="rounded-xl bg-peach-light/40 py-2 text-center">
          <p className="text-xs text-ink-soft">ราคาเครื่องจริง (รวมคอม)</p>
          <p className="whitespace-nowrap font-semibold text-ink">฿{baht(deviceTotal)}</p>
        </div>
        <div className="rounded-xl bg-peach-light/40 py-2 text-center">
          <p className="text-xs text-ink-soft">− หักเงินดาวน์</p>
          <p className="whitespace-nowrap font-semibold text-green-600">−฿{baht(downTotal)}</p>
        </div>
        <div className="rounded-xl bg-peach-light/40 py-2 text-center">
          <p className="text-xs text-ink-soft">− หักค่าเอกสาร</p>
          <p className="whitespace-nowrap font-semibold text-green-600">−฿{baht(docFeeTotal)}</p>
        </div>
        <div className="rounded-xl border border-salmon-deep/30 bg-salmon-deep/10 py-2 text-center">
          <p className="text-xs text-ink-soft">= ยอดโอนให้ร้าน</p>
          <p className="whitespace-nowrap font-bold text-salmon-deep">฿{baht(netTransferTotal)}</p>
        </div>
      </div>

      <p className="mb-4 text-xs text-ink-soft">
        หมายเหตุ: รวมค่าคอมมิชชั่นในยอดข้างต้น <span className="font-semibold text-ink">฿{baht(commissionTotal)}</span>
      </p>

      {rows.length === 0 ? (
        <p className="text-sm text-ink-soft">— ไม่มีสัญญาใหม่ในช่วงนี้</p>
      ) : (
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-peach text-left text-ink-soft">
                <th className="py-2 font-semibold">สัญญา</th>
                <th className="py-2 text-right font-semibold">ราคาเครื่อง(รวมคอม)</th>
                <th className="py-2 text-right font-semibold">ดาวน์</th>
                <th className="py-2 text-right font-semibold">ค่าเอกสาร</th>
                <th className="py-2 text-right font-semibold">โอนให้ร้าน</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.contractId} className="border-b border-peach/50 last:border-0">
                  <td className="py-1.5">
                    <Link to={`/contract/${r.contractId}`} className="text-salmon-deep hover:underline">
                      {r.contractNo}
                    </Link>
                  </td>
                  <td className="py-1.5 text-right text-ink">฿{baht(r.deviceLineFull)}</td>
                  <td className="py-1.5 text-right text-ink-soft">฿{baht(r.down)}</td>
                  <td className="py-1.5 text-right text-ink-soft">฿{baht(r.docFee)}</td>
                  <td className="py-1.5 text-right font-semibold text-ink">฿{baht(r.netTransfer)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ===== 3. หนี้เสีย ณ วันสิ้นช่วง =====
function BadDebtSection({ data }: { data: WeeklySummary }) {
  const { badDebtSnapshot } = data
  return (
    <Card>
      <h3 className="mb-1 font-semibold text-ink">หนี้เสีย ณ วันสิ้นช่วง</h3>
      <p className="mb-3 text-xs text-ink-soft">ยอด ณ วันสิ้นช่วงที่เลือก ({thaiDate(badDebtSnapshot.asOfDate)})</p>

      <div className="mb-4 inline-flex flex-col rounded-xl border border-red-200 bg-red-50 px-4 py-3">
        <p className="text-xs text-ink-soft">หนี้เสีย (ล่าช้า 60 วันขึ้นไป)</p>
        <p className="text-2xl font-bold text-red-600">{badDebtSnapshot.badDebtCount} ราย</p>
        <p className="text-sm font-semibold text-red-500">฿{baht(badDebtSnapshot.badDebtValue)}</p>
      </div>

      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <thead>
            <tr className="border-b border-peach text-left text-ink-soft">
              <th className="py-2 font-semibold">ช่วงล่าช้า</th>
              <th className="py-2 text-right font-semibold">จำนวนสัญญา</th>
              <th className="py-2 text-right font-semibold">มูลค่าคงค้าง</th>
            </tr>
          </thead>
          <tbody>
            {badDebtSnapshot.buckets.map((b) => (
              <tr key={b.bucket} className="border-b border-peach/50 last:border-0">
                <td className="py-1.5 text-ink">{b.label}</td>
                <td className="py-1.5 text-right text-ink-soft">{b.count}</td>
                <td className="py-1.5 text-right text-ink">฿{baht(b.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// ===== 4. คืนเครื่องในช่วง =====
function ReturnsSection({ data }: { data: WeeklySummary }) {
  const { returnsInRange } = data
  return (
    <Card>
      <h3 className="mb-3 font-semibold text-ink">คืนเครื่องในช่วง</h3>
      <div className="grid grid-cols-2 gap-2 text-center">
        <div className="rounded-xl bg-peach-light/40 py-2.5">
          <p className="text-xs text-ink-soft">จำนวน</p>
          <p className="text-xl font-bold text-ink">{returnsInRange.count} ราย</p>
        </div>
        <div className="rounded-xl bg-peach-light/40 py-2.5">
          <p className="text-xs text-ink-soft">มูลค่าเครื่อง</p>
          <p className="whitespace-nowrap text-xl font-bold text-ink">฿{baht(returnsInRange.value)}</p>
        </div>
      </div>
      {returnsInRange.note && <p className="mt-3 text-xs text-amber-600">{returnsInRange.note}</p>}
    </Card>
  )
}

// ===== 5. ขายเครื่องในช่วง =====
function SalesSection({ data }: { data: WeeklySummary }) {
  const { salesInRange } = data
  return (
    <Card>
      <h3 className="mb-3 font-semibold text-ink">ขายเครื่องในช่วง</h3>
      <div className="grid grid-cols-2 gap-2 text-center">
        <div className="rounded-xl bg-peach-light/40 py-2.5">
          <p className="text-xs text-ink-soft">จำนวน</p>
          <p className="text-xl font-bold text-ink">{salesInRange.count} เครื่อง</p>
        </div>
        <div className="rounded-xl bg-peach-light/40 py-2.5">
          <p className="text-xs text-ink-soft">ยอดขายรวม</p>
          <p className="whitespace-nowrap text-xl font-bold text-green-600">฿{baht(salesInRange.saleTotal)}</p>
        </div>
      </div>
    </Card>
  )
}

// ===== 6. ร้านใหม่ในช่วง =====
function NewShopsSection({ data }: { data: WeeklySummary }) {
  const { newShops } = data
  return (
    <Card>
      <h3 className="mb-3 font-semibold text-ink">ร้านใหม่ในช่วง</h3>
      {newShops.length === 0 ? (
        <EmptyState title="ยังไม่มีร้านใหม่ในช่วงนี้" hint="เมื่อมีร้านที่ทำสัญญาแรกในช่วงที่เลือก จะแสดงที่นี่" />
      ) : (
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="border-b border-peach text-left text-ink-soft">
                <th className="py-2 font-semibold">ร้าน</th>
                <th className="py-2 font-semibold">วันหาร้านได้</th>
                <th className="py-2 font-semibold">วันสัญญาแรก</th>
              </tr>
            </thead>
            <tbody>
              {newShops.map((s) => (
                <tr key={s.shopId} className="border-b border-peach/50 last:border-0">
                  <td className="py-1.5">
                    <Link to={`/shop/${s.shopId}`} className="text-salmon-deep hover:underline">
                      {s.shopName}
                    </Link>
                  </td>
                  <td className="py-1.5 text-ink-soft">{s.recruitedAt ? thaiDate(s.recruitedAt) : '—'}</td>
                  <td className="py-1.5 text-ink">{thaiDate(s.firstContractAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
