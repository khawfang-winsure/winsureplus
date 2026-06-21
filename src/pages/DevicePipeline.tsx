import { useCallback, useEffect, useState } from 'react'
import { Package, Pencil } from 'lucide-react'
import { Badge, Button, EmptyState, Field, Input, Loading, Modal, PageTitle, Select, Textarea } from '../components/ui'
import { baht, thaiDate } from '../lib/format'
import { getReturns, updateDefectNotes, updateReturnWorkflow, updateSalePrice } from '../lib/db'
import type { DeviceReturnRow } from '../lib/types'
import {
  COURIERS,
  DEVICE_STATUS_LABEL,
  nextStatuses,
  type DeviceStatus,
} from '../lib/returnWorkflow'
import { useAuth } from '../lib/auth'

// ===== ตัวเลือก filter dropdown =====
const FILTER_OPTIONS: { value: DeviceStatus | 'all' | 'active'; label: string }[] = [
  { value: 'active', label: 'งานที่ยัง active (ยกเว้นจัดส่งแล้ว)' },
  { value: 'all', label: 'ทั้งหมด (รวมจัดส่งแล้ว)' },
  { value: 'in_transit', label: DEVICE_STATUS_LABEL['in_transit'] },
  { value: 'pending_check', label: DEVICE_STATUS_LABEL['pending_check'] },
  { value: 'checked', label: DEVICE_STATUS_LABEL['checked'] },
  { value: 'pending_sale', label: DEVICE_STATUS_LABEL['pending_sale'] },
  { value: 'priced', label: DEVICE_STATUS_LABEL['priced'] },
  { value: 'transferred', label: DEVICE_STATUS_LABEL['transferred'] },
  { value: 'shipped', label: DEVICE_STATUS_LABEL['shipped'] },
]

// ===== Badge tone ตาม DeviceStatus =====
const STATUS_TONE: Record<DeviceStatus, 'neutral' | 'amber' | 'green' | 'red'> = {
  in_transit: 'amber',   // 0052: ระหว่างจัดส่ง
  pending_check: 'neutral',
  checked: 'neutral',
  pending_sale: 'amber',
  priced: 'amber',
  transferred: 'amber',
  shipped: 'green',
}

// ===== ฟอร์แมต ISO timestamp สั้นๆ =====
const MONTH_SHORT: string[] = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
]

function fmtDatetime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '-'
  const day = d.getDate()
  const mon = MONTH_SHORT[d.getMonth()]
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${day} ${mon} ${hh}:${mm}`
}

// ===== Coerce deviceStatus: null/undefined → 'pending_check' (DB has DEFAULT) =====
function resolveStatus(r: DeviceReturnRow): DeviceStatus {
  return r.deviceStatus ?? 'pending_check'
}

// ===== ฟิลเตอร์ฝั่ง client =====
function applyFilter(
  rows: DeviceReturnRow[],
  filter: DeviceStatus | 'all' | 'active',
): DeviceReturnRow[] {
  if (filter === 'all') return rows
  if (filter === 'active') return rows.filter((r) => resolveStatus(r) !== 'shipped')
  return rows.filter((r) => resolveStatus(r) === filter)
}

// ===== Late-fill tracking cell (pending_check + ไม่มี tracking_number) =====
function TrackingCell({ row, onSaved }: { row: DeviceReturnRow; onSaved: () => Promise<void> }) {
  const { name } = useAuth()
  const [tracking, setTracking] = useState('')
  const [courier, setCourier] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)

  async function save() {
    if (!tracking.trim()) return
    setBusy(true)
    try {
      await updateReturnWorkflow(row.id, {
        trackingNumber: tracking.trim(),
        ...(courier ? { courier } : {}),
        updatedBy: name ?? undefined,
      })
      setSaved(true)
      await onSaved()
    } finally {
      setBusy(false)
    }
  }

  if (saved) return <span className="text-ink-soft text-xs">บันทึกแล้ว</span>

  return (
    <div className="flex flex-col gap-1">
      <Select
        value={courier}
        onChange={(e) => setCourier(e.target.value)}
        className="w-36 text-xs"
      >
        <option value="">เลือกขนส่ง</option>
        {COURIERS.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </Select>
      <div className="flex items-center gap-1">
        <Input
          type="text"
          value={tracking}
          onChange={(e) => setTracking(e.target.value)}
          placeholder="ใส่เลขพัสดุ"
          className="w-36 text-xs"
        />
        <Button variant="ghost" onClick={save} disabled={busy || !tracking.trim()}>
          {busy ? '...' : 'บันทึก'}
        </Button>
      </div>
    </div>
  )
}

// ===== Modal แก้ราคาขาย (admin — status=priced) =====
function EditSalePriceModal({
  row,
  onClose,
  onDone,
}: {
  row: DeviceReturnRow
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const [price, setPrice] = useState(row.salePrice != null ? String(row.salePrice) : '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    const parsed = Number(price)
    if (!price || isNaN(parsed) || parsed < 0) {
      setErr('กรุณาระบุราคาขายที่ถูกต้อง')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await updateSalePrice(row.id, parsed)
      await onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'เกิดข้อผิดพลาด กรุณาลองใหม่')
      setBusy(false)
    }
  }

  return (
    <Modal title={`แก้ราคาขาย — ${row.customerName}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-soft">สัญญา {row.contractNo}</p>
        {row.pricedAt && (
          <p className="text-xs text-ink-soft">อัปเดตล่าสุด: {fmtDatetime(row.pricedAt)}</p>
        )}
        <Field label="ราคาขาย (บาท)" required>
          <Input
            type="number"
            min={0}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="ระบุราคาขายเครื่อง"
            autoFocus
          />
        </Field>
        {err && (
          <p className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-600">{err}</p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>ยกเลิก</Button>
          <Button onClick={save} disabled={busy || !price}>
            <Pencil size={14} />
            {busy ? 'กำลังบันทึก...' : 'บันทึกราคา'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ===== หน้าหลัก =====
export default function DevicePipeline() {
  const { role, configured } = useAuth()
  const isAdmin = !configured || role === 'admin'

  const [rows, setRows] = useState<DeviceReturnRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<DeviceStatus | 'all' | 'active'>('active')
  const [selected, setSelected] = useState<DeviceReturnRow | null>(null)
  const [editPriceTarget, setEditPriceTarget] = useState<DeviceReturnRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setRows(await getReturns())
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const filtered = applyFilter(rows, filter)

  return (
    <div>
      <PageTitle
        sub="ติดตามสถานะเครื่องที่คืนจากลูกค้า — เปลี่ยนสถานะทีละขั้น"
        count={loading ? undefined : { shown: filtered.length, total: rows.length }}
      >
        ติดตามเครื่อง (Device Pipeline)
      </PageTitle>

      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="text-sm font-medium text-ink">กรอง:</label>
        <Select
          value={filter}
          onChange={(e) => setFilter(e.target.value as DeviceStatus | 'all' | 'active')}
          className="w-64"
        >
          {FILTER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>

      {loading ? (
        <Loading />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="ไม่มีรายการที่ตรงกับตัวกรอง"
          hint="ลองเลือก 'ทั้งหมด' เพื่อดูทุกสถานะ"
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-peach text-left text-ink-soft">
                <th className="py-2 pr-4 font-medium">สัญญา / ลูกค้า</th>
                <th className="py-2 pr-4 font-medium">สถานะปัจจุบัน</th>
                <th className="py-2 pr-4 font-medium">ขนส่ง / เลขพัสดุ</th>
                <th className="py-2 pr-4 font-medium">ราคาขาย</th>
                <th className="py-2 pr-4 font-medium">อัปเดตล่าสุด</th>
                <th className="py-2 pr-4 font-medium">ผู้ดำเนินการ</th>
                <th className="py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const status = resolveStatus(r)
                const nexts = nextStatuses(status)
                const showLateFill = !r.trackingNumber && status === 'pending_check'
                return (
                  <tr
                    key={r.id}
                    className="border-b border-peach/50 hover:bg-peach-light/30"
                  >
                    <td className="py-3 pr-4">
                      <p className="font-medium text-ink">{r.customerName}</p>
                      <p className="text-xs text-ink-soft">{r.contractNo} · เริ่ม {thaiDate(r.createdAt.slice(0, 10))}</p>
                      <p className="text-xs text-ink-soft">{r.deviceModel ?? '—'}</p>
                    </td>
                    <td className="py-3 pr-4">
                      <Badge tone={STATUS_TONE[status]}>
                        {DEVICE_STATUS_LABEL[status]}
                      </Badge>
                    </td>
                    <td className="py-3 pr-4 text-ink">
                      {r.returnMethod === 'walk_in' ? (
                        <span className="text-ink-soft text-xs">
                          คืนที่ร้าน{r.returnLocation ? `: ${r.returnLocation}` : ''}
                        </span>
                      ) : r.trackingNumber ? (
                        <div className="flex flex-col gap-0.5">
                          {r.courier && (
                            <span className="text-xs text-ink-soft">{r.courier}</span>
                          )}
                          <span>{r.trackingNumber}</span>
                        </div>
                      ) : showLateFill ? (
                        <TrackingCell row={r} onSaved={load} />
                      ) : (
                        <span className="text-ink-soft">-</span>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-ink">
                      {status === 'priced' && isAdmin ? (
                        <div className="flex items-center gap-1.5">
                          <span>{r.salePrice != null ? `${baht(r.salePrice)} ฿` : <span className="text-ink-soft">-</span>}</span>
                          <Button
                            variant="ghost"
                            onClick={() => setEditPriceTarget(r)}
                            aria-label="แก้ไขราคาขาย"
                          >
                            <Pencil size={13} />
                            แก้ราคา
                          </Button>
                        </div>
                      ) : r.salePrice != null ? (
                        `${baht(r.salePrice)} ฿`
                      ) : (
                        <span className="text-ink-soft">-</span>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-ink-soft">
                      {fmtDatetime(r.deviceStatusUpdatedAt)}
                    </td>
                    <td className="py-3 pr-4 text-ink-soft">
                      {r.deviceStatusBy ?? '-'}
                    </td>
                    <td className="py-3">
                      {nexts.length > 0 ? (
                        <Button variant="ghost" onClick={() => setSelected(r)}>
                          เปลี่ยนสถานะ
                        </Button>
                      ) : (
                        <span className="text-xs text-ink-soft">สิ้นสุดแล้ว</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <StatusModal
          row={selected}
          onClose={() => setSelected(null)}
          onDone={async () => {
            setSelected(null)
            await load()
          }}
        />
      )}

      {editPriceTarget && (
        <EditSalePriceModal
          row={editPriceTarget}
          onClose={() => setEditPriceTarget(null)}
          onDone={async () => {
            setEditPriceTarget(null)
            await load()
          }}
        />
      )}
    </div>
  )
}

// ===== Modal เปลี่ยนสถานะ =====
function StatusModal({
  row,
  onClose,
  onDone,
}: {
  row: DeviceReturnRow
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const { name } = useAuth()
  const currentStatus = resolveStatus(row)
  const nexts = nextStatuses(currentStatus)

  const [targetStatus, setTargetStatus] = useState<DeviceStatus>(nexts[0] ?? currentStatus)
  const [salePrice, setSalePrice] = useState(row.salePrice != null ? String(row.salePrice) : '')
  const [defectNotes, setDefectNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // แสดงราคาขายเมื่อ: เปลี่ยน pending_sale→priced
  const showSalePrice = currentStatus === 'pending_sale' && targetStatus === 'priced'

  // แสดงตำหนิเครื่องเมื่อ: เปลี่ยนสถานะเป็น 'checked'
  const showDefectNotes = targetStatus === 'checked'

  if (nexts.length === 0) {
    return (
      <Modal title="สถานะเครื่อง" onClose={onClose}>
        <div className="flex flex-col gap-4">
          <p className="text-ink-soft">
            สิ้นสุด workflow แล้ว — เครื่องนี้จัดส่งให้ร้านค้าเรียบร้อย
          </p>
          <div className="flex justify-end">
            <Button variant="ghost" onClick={onClose}>ปิด</Button>
          </div>
        </div>
      </Modal>
    )
  }

  async function save() {
    setBusy(true)
    setErr(null)
    try {
      await updateReturnWorkflow(row.id, {
        deviceStatus: targetStatus,
        salePrice: showSalePrice && salePrice ? Number(salePrice) : undefined,
        updatedBy: name ?? undefined,
      })
      // บันทึกตำหนิแยก (updateDefectNotes ใช้ column เดียวกันตลอด)
      if (showDefectNotes && defectNotes.trim()) {
        await updateDefectNotes(row.id, defectNotes.trim())
      }
      await onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'เกิดข้อผิดพลาด กรุณาลองใหม่')
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`เปลี่ยนสถานะเครื่อง — ${row.customerName}`}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        {/* สถานะปัจจุบัน */}
        <div className="rounded-xl bg-peach-light/40 px-4 py-2 text-sm">
          <span className="text-ink-soft">สถานะปัจจุบัน: </span>
          <Badge tone={STATUS_TONE[currentStatus]}>
            {DEVICE_STATUS_LABEL[currentStatus]}
          </Badge>
        </div>

        {/* สัญญา */}
        <p className="text-sm text-ink-soft">สัญญา {row.contractNo}</p>

        {/* เลือกสถานะถัดไป */}
        <Field label="เปลี่ยนเป็นสถานะ" required>
          <Select
            value={targetStatus}
            onChange={(e) => setTargetStatus(e.target.value as DeviceStatus)}
          >
            {nexts.map((s) => (
              <option key={s} value={s}>
                {DEVICE_STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>

        {/* ตำหนิตัวเครื่อง (เมื่อเปลี่ยนสถานะเป็น checked) */}
        {showDefectNotes && (
          <Field label="ตำหนิตัวเครื่อง (ถ้ามี)">
            <Textarea
              value={defectNotes}
              onChange={(e) => setDefectNotes(e.target.value)}
              placeholder="เช่น รอยขีดข่วนขอบซ้าย, หน้าจอมีรอยจาง..."
              rows={3}
            />
          </Field>
        )}

        {/* ราคาขาย */}
        {showSalePrice && (
          <Field label="ราคาขาย (บาท)" required>
            <Input
              type="number"
              min={0}
              value={salePrice}
              onChange={(e) => setSalePrice(e.target.value)}
              placeholder="ระบุราคาขายเครื่อง"
            />
          </Field>
        )}

        {err && (
          <p className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-600">{err}</p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button onClick={save} disabled={busy || (showSalePrice && !salePrice)}>
            <Package size={14} />
            {busy ? 'กำลังบันทึก...' : 'บันทึกสถานะ'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
