import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, ChevronLeft, ChevronRight, Landmark, Receipt, Store, Upload, X } from 'lucide-react'
import { Badge, Button, EmptyState, Loading, Modal, PageTitle } from '../components/ui'
import { Input } from '../components/ui'
import { useAuth } from '../lib/auth'
import { baht, thaiDate } from '../lib/format'
import {
  getDailyTransferByShop,
  getDailyTransferContracts,
  getSlipSignedUrl,
  markShopTransferred,
  type DailyTransferContractRow,
  type DailyTransferShopRow,
} from '../lib/db'
import { supabase } from '../lib/supabase'

/** วันนี้ตามเขตเวลากรุงเทพ (UTC+7) รูปแบบ YYYY-MM-DD */
function todayBangkok(): string {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)
}

/** วันก่อนหน้า/ถัดไปของวันที่ ISO ที่ระบุ (บวก/ลบวัน) */
function shiftDay(isoDate: string, delta: number): string {
  const d = new Date(isoDate + 'T00:00:00')
  d.setDate(d.getDate() + delta)
  return d.toLocaleString('en-CA').slice(0, 10)
}

// ===== รายสัญญาของร้าน (drill-down) =====
function ShopContractsList({ shopId, dateISO }: { shopId: string; dateISO: string }) {
  const [rows, setRows] = useState<DailyTransferContractRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setRows(null)
    setError(null)
    getDailyTransferContracts(shopId, dateISO)
      .then((data) => {
        if (!cancelled) setRows(data)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'โหลดรายการไม่สำเร็จ')
      })
    return () => {
      cancelled = true
    }
  }, [shopId, dateISO])

  if (error) {
    return <p className="px-4 py-3 text-sm text-red-700">โหลดรายการไม่สำเร็จ: {error}</p>
  }
  if (rows === null) {
    return <Loading label="กำลังโหลดรายสัญญา..." />
  }
  if (rows.length === 0) {
    return <p className="px-4 py-3 text-sm text-ink-soft">ไม่มีสัญญาของร้านนี้ในวันที่เลือก</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-peach text-left text-xs text-ink-soft">
            <th className="px-4 py-2 font-medium">เลขที่สัญญา</th>
            <th className="px-4 py-2 font-medium">ชื่อลูกค้า</th>
            <th className="px-4 py-2 text-right font-medium">ราคาเครื่อง</th>
            <th className="px-4 py-2 text-right font-medium">ยอดโอนสุทธิ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.contractId} className="border-b border-peach/60 last:border-0">
              <td className="px-4 py-2 text-ink">{r.contractNo}</td>
              <td className="px-4 py-2 text-ink">{r.customerName}</td>
              <td className="px-4 py-2 text-right text-ink-soft">{baht(r.devicePrice)}</td>
              <td className="px-4 py-2 text-right font-medium text-ink">{baht(r.netTransfer)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ===== ป็อปอัพดูสลิป =====
function SlipModal({ shopName, url, onClose }: { shopName: string; url: string; onClose: () => void }) {
  return (
    <Modal title={`สลิปโอนเงิน — ${shopName}`} onClose={onClose}>
      <img src={url} alt={`สลิปโอนเงิน ${shopName}`} className="w-full rounded-xl border border-peach" />
    </Modal>
  )
}

// ===== ป็อปอัพอัปโหลดสลิป =====
function UploadSlipModal({
  shop,
  dateISO,
  byName,
  onClose,
  onDone,
}: {
  shop: DailyTransferShopRow
  dateISO: string
  byName: string
  onClose: () => void
  onDone: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    if (!file) {
      setError('กรุณาเลือกไฟล์สลิปก่อนบันทึก')
      return
    }
    if (!supabase) {
      setError('ยังไม่ได้เชื่อมต่อระบบฐานข้อมูล')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const ext = file.name.split('.').pop() || 'jpg'
      const path = `${shop.shopId}/${dateISO}.${ext}`
      const { error: upErr } = await supabase.storage
        .from('transfer-slips')
        .upload(path, file, { upsert: true })
      if (upErr) throw upErr
      await markShopTransferred(shop.shopId, dateISO, shop.amount, path, byName, note.trim() || undefined)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`อัปโหลดสลิป — ${shop.shopName}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-xl border border-peach bg-peach-light/30 px-4 py-3 text-sm">
          <p className="text-ink-soft">ยอดที่ต้องโอน</p>
          <p className="text-lg font-bold text-ink">{baht(shop.amount)} บาท</p>
          <p className="text-xs text-ink-soft">{shop.contractCount} สัญญา</p>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-ink">ไฟล์สลิปโอนเงิน</p>
          <div
            className="flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed border-peach bg-peach-light/20 px-5 py-4 transition hover:border-salmon/50 hover:bg-peach-light/40"
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="h-5 w-5 shrink-0 text-ink-soft" />
            <span className="text-sm text-ink-soft">{file ? file.name : 'คลิกเพื่อเลือกรูปสลิป'}</span>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>

        <div>
          <p className="mb-1.5 text-sm font-medium text-ink">หมายเหตุ (ถ้ามี)</p>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น โอนแยก 2 รอบ" />
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            ยกเลิก
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'กำลังบันทึก...' : 'บันทึกว่าโอนแล้ว'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ===== แถวร้าน (expand ดูรายสัญญา) =====
function ShopRow({
  shop,
  dateISO,
  expanded,
  onToggle,
  onUpload,
  onViewSlip,
}: {
  shop: DailyTransferShopRow
  dateISO: string
  expanded: boolean
  onToggle: () => void
  onUpload: () => void
  onViewSlip: () => void
}) {
  return (
    <div className="rounded-xl border border-peach bg-white">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-peach-light/30"
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronRight size={16} className="rotate-90 text-ink-soft transition-transform" />
          ) : (
            <ChevronRight size={16} className="text-ink-soft transition-transform" />
          )}
          <Store size={16} className="text-salmon-deep" />
          <span className="font-semibold text-ink">{shop.shopName}</span>
          <span className="text-xs text-ink-soft">({shop.contractCount} สัญญา)</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-base font-bold text-ink">{baht(shop.amount)} บาท</span>
          {shop.transferred ? (
            <Badge tone="green">โอนแล้ว</Badge>
          ) : (
            <Badge tone="amber">ยังไม่โอน</Badge>
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-peach">
          <ShopContractsList shopId={shop.shopId} dateISO={dateISO} />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-peach px-4 py-3">
            <div className="text-xs text-ink-soft">
              {shop.transferred ? (
                <>
                  โอนโดย {shop.transferredBy ?? '-'}
                  {shop.transferredAt && ` · ${thaiDate(shop.transferredAt.slice(0, 10))}`}
                  {shop.note && ` · หมายเหตุ: ${shop.note}`}
                </>
              ) : (
                'ยังไม่มีการบันทึกโอนเงินสำหรับร้านนี้ในวันนี้'
              )}
            </div>
            {shop.transferred ? (
              <Button variant="ghost" onClick={(e) => { e.stopPropagation(); onViewSlip() }}>
                <Receipt size={15} />
                ดูสลิป
              </Button>
            ) : (
              <Button onClick={(e) => { e.stopPropagation(); onUpload() }}>
                <Upload size={15} />
                อัปโหลดสลิป
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ===== หน้าหลัก =====
export default function AccountingTransfers() {
  const { name } = useAuth()
  const byName = name ?? 'บัญชี'

  const [dateISO, setDateISO] = useState<string>(() => todayBangkok())
  const [shops, setShops] = useState<DailyTransferShopRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [tick, setTick] = useState(0)

  const [expandedShopId, setExpandedShopId] = useState<string | null>(null)
  const [uploadShop, setUploadShop] = useState<DailyTransferShopRow | null>(null)
  const [slipModal, setSlipModal] = useState<{ shopName: string; url: string } | null>(null)
  const [slipLoadingShopId, setSlipLoadingShopId] = useState<string | null>(null)
  const [slipError, setSlipError] = useState<string | null>(null)

  const refresh = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    setRefreshing(true)
    setError(null)
    getDailyTransferByShop(dateISO)
      .then((data) => {
        setShops(data)
        setRefreshing(false)
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ')
        setRefreshing(false)
      })
  }, [dateISO, tick])

  const summary = useMemo(() => {
    const list = shops ?? []
    const total = list.reduce((s, r) => s + r.amount, 0)
    const transferredCount = list.filter((r) => r.transferred).length
    return { total, transferredCount, shopCount: list.length }
  }, [shops])

  async function handleViewSlip(shop: DailyTransferShopRow) {
    if (!shop.slipPath) return
    setSlipError(null)
    setSlipLoadingShopId(shop.shopId)
    try {
      const url = await getSlipSignedUrl(shop.slipPath)
      if (url) setSlipModal({ shopName: shop.shopName, url })
      else setSlipError('ไม่พบไฟล์สลิป')
    } catch (e) {
      setSlipError(e instanceof Error ? e.message : 'เปิดสลิปไม่สำเร็จ')
    } finally {
      setSlipLoadingShopId(null)
    }
  }

  const loading = shops === null

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageTitle sub="รายการยอดโอนเงินให้ร้านค้าประจำวัน — อัปโหลดสลิปเมื่อโอนแล้ว">
          โอนเงินร้าน
        </PageTitle>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            onClick={() => setDateISO((d) => shiftDay(d, -1))}
            disabled={refreshing}
            aria-label="วันก่อนหน้า"
            className="!px-2"
          >
            <ChevronLeft size={15} />
          </Button>
          <Input
            type="date"
            value={dateISO}
            onChange={(e) => setDateISO(e.target.value)}
            className="w-auto text-sm"
            disabled={refreshing}
          />
          <Button
            variant="ghost"
            onClick={() => setDateISO((d) => shiftDay(d, 1))}
            disabled={refreshing || dateISO >= todayBangkok()}
            aria-label="วันถัดไป"
            className="!px-2"
          >
            <ChevronRight size={15} />
          </Button>
        </div>
      </div>

      {/* สรุปยอดรวม */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-peach bg-cream-deep p-4">
          <p className="flex items-center gap-1.5 text-xs text-ink-soft">
            <Landmark size={13} /> ยอดที่ต้องโอนวันนี้
          </p>
          <p className="mt-1 text-xl font-bold text-ink">{baht(summary.total)} บาท</p>
        </div>
        <div className="rounded-2xl border border-peach bg-cream-deep p-4">
          <p className="text-xs text-ink-soft">จำนวนร้าน</p>
          <p className="mt-1 text-xl font-bold text-ink">{summary.shopCount} ร้าน</p>
        </div>
        <div className="rounded-2xl border border-peach bg-cream-deep p-4">
          <p className="flex items-center gap-1.5 text-xs text-ink-soft">
            <CheckCircle2 size={13} /> โอนแล้ว
          </p>
          <p className="mt-1 text-xl font-bold text-ink">
            {summary.transferredCount} / {summary.shopCount} ร้าน
          </p>
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
        <Loading label="กำลังโหลดข้อมูลยอดโอน..." />
      ) : shops.length === 0 ? (
        <EmptyState title="ไม่มีสัญญาในวันที่เลือก" hint="ลองเปลี่ยนวันที่ดูค่ะ" />
      ) : (
        <div className="flex flex-col gap-2">
          {shops.map((shop) => (
            <ShopRow
              key={shop.shopId}
              shop={shop}
              dateISO={dateISO}
              expanded={expandedShopId === shop.shopId}
              onToggle={() => setExpandedShopId((cur) => (cur === shop.shopId ? null : shop.shopId))}
              onUpload={() => setUploadShop(shop)}
              onViewSlip={() => handleViewSlip(shop)}
            />
          ))}
        </div>
      )}

      {slipLoadingShopId && <p className="text-center text-xs text-ink-soft">กำลังเปิดสลิป...</p>}

      {uploadShop && (
        <UploadSlipModal
          shop={uploadShop}
          dateISO={dateISO}
          byName={byName}
          onClose={() => setUploadShop(null)}
          onDone={() => {
            setUploadShop(null)
            refresh()
          }}
        />
      )}

      {slipModal && (
        <SlipModal shopName={slipModal.shopName} url={slipModal.url} onClose={() => setSlipModal(null)} />
      )}
    </div>
  )
}
