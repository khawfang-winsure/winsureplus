import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, ChevronRight, Landmark, Receipt, Store, X } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Loading, Modal, PageTitle } from '../components/ui'
import { DateRangePicker, loadStoredRange, type DateRange } from '../components/DateRangePicker'
import { baht, thaiDate } from '../lib/format'
import { getSlipSignedUrl, getTransferSlipsForDay, getTransferSlipSummary } from '../lib/db'
import type { TransferSlip, TransferSlipSummaryRow } from '../lib/types'

const STORAGE_KEY = 'transferSummary.dateRange'

/** วันนี้ตามเขตเวลากรุงเทพ (UTC+7) รูปแบบ YYYY-MM-DD */
function todayBangkok(): string {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)
}

// ===== ป็อปอัพดูสลิป =====
function SlipModal({ shopName, url, onClose }: { shopName: string; url: string; onClose: () => void }) {
  return (
    <Modal title={`สลิปโอนเงิน — ${shopName}`} onClose={onClose}>
      <img src={url} alt={`สลิปโอนเงิน ${shopName}`} className="w-full rounded-xl border border-peach" />
    </Modal>
  )
}

// ===== รายสลิปของร้าน-วัน (drill-down) =====
function ShopSlipsDetail({
  dateISO,
  shopId,
  shopName,
  onViewSlip,
}: {
  dateISO: string
  shopId: string
  shopName: string
  onViewSlip: (slipPath: string, shopName: string) => void
}) {
  const [slips, setSlips] = useState<TransferSlip[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSlips(null)
    setErr(null)
    getTransferSlipsForDay(dateISO, shopId)
      .then((data) => {
        if (!cancelled) setSlips(data)
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'โหลดสลิปไม่สำเร็จ')
      })
    return () => {
      cancelled = true
    }
  }, [dateISO, shopId])

  if (err) return <p className="px-4 py-3 text-sm text-red-700">โหลดสลิปไม่สำเร็จ: {err}</p>
  if (slips === null) return <Loading label="กำลังโหลดสลิป..." />
  if (slips.length === 0) return <p className="px-4 py-3 text-sm text-ink-soft">ไม่มีสลิปของร้านนี้ในวันนี้</p>

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      {slips.map((slip) => (
        <div key={slip.id} className="rounded-xl border border-peach bg-white px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Receipt size={15} className="text-salmon-deep" />
              <span className="font-semibold text-ink">{baht(slip.amount)} บาท</span>
              {slip.slipWaived && <Badge tone="amber">ไม่มีสลิป (ยืนยันย้อนหลัง)</Badge>}
            </div>
            {slip.slipPath && !slip.slipWaived && (
              <Button variant="ghost" onClick={() => onViewSlip(slip.slipPath as string, shopName)}>
                <Receipt size={14} />
                ดูสลิป
              </Button>
            )}
          </div>
          <p className="mt-1 text-xs text-ink-soft">
            โดย {slip.transferredBy ?? '-'}
            {slip.transferredAt && ` · ${thaiDate(slip.transferredAt.slice(0, 10))}`}
            {slip.note && ` · หมายเหตุ: ${slip.note}`}
          </p>
          <div className="mt-1.5 text-xs text-ink">
            {slip.items.length > 0 ? (
              <ul className="flex flex-col gap-0.5">
                {slip.items.map((it) => (
                  <li key={it.id} className="flex items-baseline justify-between gap-2">
                    <span>
                      {it.contractNo ?? it.contractId} · {it.customerName ?? '-'}
                    </span>
                    <span className="text-ink-soft">{baht(it.amount)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-ink-soft">ทั้งร้าน (ข้อมูลเดิม)</span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ===== แถวร้านในแต่ละวัน =====
function ShopSummaryRow({
  row,
  onViewSlip,
}: {
  row: TransferSlipSummaryRow
  onViewSlip: (slipPath: string, shopName: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="rounded-xl border border-peach bg-white">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-peach-light/30"
      >
        <div className="flex items-center gap-2">
          <ChevronRight size={16} className={`text-ink-soft transition-transform ${expanded ? 'rotate-90' : ''}`} />
          <Store size={16} className="text-salmon-deep" />
          <span className="font-semibold text-ink">{row.shopName}</span>
          <span className="text-xs text-ink-soft">({row.slipCount} สลิป)</span>
        </div>
        <span className="text-base font-bold text-ink">{baht(row.totalAmount)} บาท</span>
      </button>
      {expanded && (
        <div className="border-t border-peach bg-peach-light/10">
          <ShopSlipsDetail dateISO={row.date} shopId={row.shopId} shopName={row.shopName} onViewSlip={onViewSlip} />
        </div>
      )}
    </div>
  )
}

// ===== กลุ่มต่อวัน =====
function DayGroup({
  date,
  rows,
  onViewSlip,
}: {
  date: string
  rows: TransferSlipSummaryRow[]
  onViewSlip: (slipPath: string, shopName: string) => void
}) {
  const dayTotal = rows.reduce((s, r) => s + r.totalAmount, 0)
  const daySlipCount = rows.reduce((s, r) => s + r.slipCount, 0)
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          <CalendarDays size={15} className="text-salmon-deep" />
          {thaiDate(date)}
        </div>
        <div className="text-xs text-ink-soft">
          {rows.length} ร้าน · {daySlipCount} สลิป ·{' '}
          <span className="font-semibold text-ink">{baht(dayTotal)}</span> บาท
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {rows.map((row) => (
          <ShopSummaryRow key={`${row.date}|${row.shopId}`} row={row} onViewSlip={onViewSlip} />
        ))}
      </div>
    </div>
  )
}

// ===== หน้าหลัก =====
export default function TransferSummary() {
  const [range, setRange] = useState<DateRange | null>(() => loadStoredRange(STORAGE_KEY, '7d'))
  const [rows, setRows] = useState<TransferSlipSummaryRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [slipModal, setSlipModal] = useState<{ shopName: string; url: string } | null>(null)
  const [slipLoading, setSlipLoading] = useState(false)
  const [slipError, setSlipError] = useState<string | null>(null)

  const startISO = range?.start ?? '2000-01-01'
  const endISO = range?.end ?? todayBangkok()

  useEffect(() => {
    let cancelled = false
    setRows(null)
    setError(null)
    getTransferSlipSummary(startISO, endISO)
      .then((data) => {
        if (!cancelled) setRows(data)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ')
      })
    return () => {
      cancelled = true
    }
  }, [startISO, endISO])

  const summary = useMemo(() => {
    const list = rows ?? []
    const total = list.reduce((s, r) => s + r.totalAmount, 0)
    const slipCount = list.reduce((s, r) => s + r.slipCount, 0)
    const shopCount = new Set(list.map((r) => r.shopId)).size
    return { total, slipCount, shopCount }
  }, [rows])

  // group ตามวัน (ใหม่ก่อน) → ในวันเรียงตามชื่อร้าน
  const byDay = useMemo(() => {
    const map = new Map<string, TransferSlipSummaryRow[]>()
    for (const r of rows ?? []) {
      const arr = map.get(r.date)
      if (arr) arr.push(r)
      else map.set(r.date, [r])
    }
    const dates = [...map.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    return dates.map((date) => ({
      date,
      rows: (map.get(date) ?? []).slice().sort((a, b) => a.shopName.localeCompare(b.shopName, 'th')),
    }))
  }, [rows])

  async function handleViewSlip(slipPath: string, shopName: string) {
    setSlipError(null)
    setSlipLoading(true)
    try {
      const url = await getSlipSignedUrl(slipPath)
      if (url) setSlipModal({ shopName, url })
      else setSlipError('ไม่พบไฟล์สลิป')
    } catch (e) {
      setSlipError(e instanceof Error ? e.message : 'เปิดสลิปไม่สำเร็จ')
    } finally {
      setSlipLoading(false)
    }
  }

  const loading = rows === null

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
      <PageTitle sub="สรุปการโอนเงินให้ร้านค้า แยกตามวันและร้าน — กดที่ร้านเพื่อดูรายสลิปและลูกค้าในแต่ละสลิป">
        สรุปการโอนเงินร้าน
      </PageTitle>

      <DateRangePicker value={range} onChange={setRange} storageKey={STORAGE_KEY} defaultPreset="7d" />

      {/* การ์ดสรุป */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-peach bg-cream-deep p-4">
          <p className="flex items-center gap-1.5 text-xs text-ink-soft">
            <Landmark size={13} /> ยอดโอนรวม
          </p>
          <p className="mt-1 text-xl font-bold text-ink">{baht(summary.total)} บาท</p>
        </div>
        <div className="rounded-2xl border border-peach bg-cream-deep p-4">
          <p className="flex items-center gap-1.5 text-xs text-ink-soft">
            <Receipt size={13} /> จำนวนสลิป
          </p>
          <p className="mt-1 text-xl font-bold text-ink">{summary.slipCount} สลิป</p>
        </div>
        <div className="rounded-2xl border border-peach bg-cream-deep p-4">
          <p className="flex items-center gap-1.5 text-xs text-ink-soft">
            <Store size={13} /> จำนวนร้าน
          </p>
          <p className="mt-1 text-xl font-bold text-ink">{summary.shopCount} ร้าน</p>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          โหลดข้อมูลไม่สำเร็จ: {error}
        </div>
      )}
      {slipError && (
        <div className="flex items-start justify-between gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{slipError}</span>
          <button type="button" onClick={() => setSlipError(null)} aria-label="ปิด">
            <X size={14} />
          </button>
        </div>
      )}

      {loading ? (
        <Loading label="กำลังโหลดสรุปยอดโอน..." />
      ) : byDay.length === 0 ? (
        <EmptyState title="ไม่มีการโอนเงินในช่วงที่เลือก" hint="ลองขยายช่วงวันที่ดูค่ะ" />
      ) : (
        <div className="space-y-5">
          {byDay.map((g) => (
            <Card key={g.date}>
              <DayGroup date={g.date} rows={g.rows} onViewSlip={handleViewSlip} />
            </Card>
          ))}
        </div>
      )}

      {slipLoading && <p className="text-center text-xs text-ink-soft">กำลังเปิดสลิป...</p>}

      {slipModal && (
        <SlipModal shopName={slipModal.shopName} url={slipModal.url} onClose={() => setSlipModal(null)} />
      )}
    </div>
  )
}
