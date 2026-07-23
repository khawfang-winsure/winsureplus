import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, ArrowDownAZ, ArrowUpAZ, FileText, Package, Pencil, Search } from 'lucide-react'
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
import { useFilter } from '../lib/useFilter'

const UNASSIGNED = '__unassigned__'

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

// ===== ตำหนิเครื่องแก้ไขได้ตั้งแต่ "ตรวจสอบเรียบร้อยแล้ว" จนกว่าร้านค้าจะโอนเงิน =====
// (checked / pending_sale / priced) — ล็อกอัตโนมัติทันทีที่เข้าสถานะ transferred/shipped
function canEditDefect(status: DeviceStatus): boolean {
  return status === 'checked' || status === 'pending_sale' || status === 'priced'
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

// ===== ค้นหา multi-field (client-side, null-safe) =====
function applySearch(rows: DeviceReturnRow[], query: string): DeviceReturnRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  return rows.filter((r) => {
    const hay = [r.customerName, r.deviceModel, r.sn, r.imei, r.contractNo]
      .join(' ')
      .toLowerCase()
    return hay.includes(q)
  })
}

// ===== ฟิลเตอร์ผู้ดำเนินการ (รวม bucket "ยังไม่ระบุ") =====
function applyAssignee(rows: DeviceReturnRow[], assignee: string): DeviceReturnRow[] {
  if (!assignee) return rows
  if (assignee === UNASSIGNED) return rows.filter((r) => !r.deviceStatusBy)
  return rows.filter((r) => r.deviceStatusBy === assignee)
}

// ===== เรียงตามวันที่อัปเดตล่าสุด (null ไปท้ายสุดเสมอ) =====
function applySort(rows: DeviceReturnRow[], dir: 'asc' | 'desc'): DeviceReturnRow[] {
  return [...rows].sort((a, b) => {
    const ta = a.deviceStatusUpdatedAt ? new Date(a.deviceStatusUpdatedAt).getTime() : null
    const tb = b.deviceStatusUpdatedAt ? new Date(b.deviceStatusUpdatedAt).getTime() : null
    if (ta === null && tb === null) return 0
    if (ta === null) return 1
    if (tb === null) return -1
    return dir === 'desc' ? tb - ta : ta - tb
  })
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

// ===== Modal ดูรายละเอียด/ตำหนิเครื่อง =====
// แก้ไขตำหนิได้ตั้งแต่สถานะ "ตรวจสอบเรียบร้อยแล้ว" จนถึงก่อน "ร้านโอนแล้วรอจัดส่ง" (canEditDefect)
// นอกช่วงนั้น (ยังไม่ตรวจ / ร้านโอนเงินแล้ว) แสดงอ่านอย่างเดียว
function DeviceDetailModal({
  row,
  onClose,
  onSaved,
}: {
  row: DeviceReturnRow
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const status = resolveStatus(row)
  const editable = canEditDefect(status)
  const hasDefect = !!row.defectNotes && row.defectNotes.trim().length > 0
  const repair = row.repairCost ?? 0

  const [notes, setNotes] = useState(row.defectNotes ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function save() {
    setBusy(true)
    setErr(null)
    setSaved(false)
    try {
      await updateDefectNotes(row.id, notes.trim())
      await onSaved()
      setSaved(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'เกิดข้อผิดพลาด กรุณาลองใหม่')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`รายละเอียดเครื่อง — ${row.customerName}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {/* ข้อมูลเครื่อง */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <span className="text-ink-soft">สัญญา</span>
          <span className="text-ink">{row.contractNo}</span>
          <span className="text-ink-soft">รุ่นเครื่อง</span>
          <span className="text-ink">{row.deviceModel ?? '—'}</span>
          <span className="text-ink-soft">สถานะเครื่อง</span>
          <span>
            <Badge tone={STATUS_TONE[status]}>{DEVICE_STATUS_LABEL[status]}</Badge>
          </span>
          {repair > 0 && (
            <>
              <span className="text-ink-soft">ค่าซ่อม</span>
              <span className="text-ink whitespace-nowrap">{baht(repair)} ฿</span>
            </>
          )}
          {row.returnMethod === 'walk_in' ? (
            <>
              <span className="text-ink-soft">วิธีคืน</span>
              <span className="text-ink">คืนที่ร้าน{row.returnLocation ? `: ${row.returnLocation}` : ''}</span>
            </>
          ) : row.trackingNumber ? (
            <>
              <span className="text-ink-soft">ขนส่ง / เลขพัสดุ</span>
              <span className="text-ink">
                {row.courier ? `${row.courier} · ` : ''}{row.trackingNumber}
              </span>
            </>
          ) : null}
        </div>

        {/* ตำหนิเครื่อง */}
        <div>
          <p className="mb-1 flex items-center gap-1.5 text-sm font-medium text-ink">
            <AlertCircle size={15} className="text-salmon-deep" />
            ตำหนิตัวเครื่อง
          </p>
          {editable ? (
            <div className="flex flex-col gap-2">
              <Textarea
                value={notes}
                onChange={(e) => {
                  setNotes(e.target.value)
                  setSaved(false)
                }}
                placeholder="เช่น รอยขีดข่วนขอบซ้าย, หน้าจอมีรอยจาง..."
                rows={3}
              />
              <p className="text-xs text-ink-soft">
                แก้ไขได้จนกว่าร้านค้าจะโอนเงิน (สถานะ &quot;{DEVICE_STATUS_LABEL.transferred}&quot;) — หลังจากนั้นจะล็อกอัตโนมัติ
              </p>
              {err && (
                <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600">{err}</p>
              )}
              <div className="flex items-center gap-2">
                <Button onClick={save} disabled={busy}>
                  <Pencil size={13} />
                  {busy ? 'กำลังบันทึก...' : 'บันทึกตำหนิ'}
                </Button>
                {saved && <span className="text-xs text-ink-soft">บันทึกแล้ว</span>}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {hasDefect ? (
                <div className="whitespace-pre-line rounded-xl bg-peach-light/40 px-4 py-3 text-sm text-ink">
                  {row.defectNotes}
                </div>
              ) : (
                <p className="rounded-xl bg-peach-light/40 px-4 py-3 text-sm text-ink-soft">
                  ยังไม่มีบันทึกตำหนิ
                </p>
              )}
              <p className="text-xs text-ink-soft">
                {status === 'transferred' || status === 'shipped'
                  ? 'ล็อกแล้ว — ร้านค้าโอนเงินแล้ว'
                  : 'แก้ไขได้หลังตรวจสอบเรียบร้อยแล้ว (สถานะ "ตรวจสอบเรียบร้อยแล้ว" เป็นต้นไป)'}
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>ปิด</Button>
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
  const [query, setQuery] = useState('')
  const [assigneeFilter, setAssigneeFilter] = useFilter('devicePipeline.assignee', '')
  const [sortDir, setSortDir] = useFilter<'asc' | 'desc'>('devicePipeline.sortDir', 'desc')
  const [selected, setSelected] = useState<DeviceReturnRow | null>(null)
  const [editPriceTarget, setEditPriceTarget] = useState<DeviceReturnRow | null>(null)
  const [detailTarget, setDetailTarget] = useState<DeviceReturnRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setRows(await getReturns())
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // ผู้ดำเนินการทั้งหมดที่มีจริง (distinct, ไม่รวม null — จัดเข้า bucket "ยังไม่ระบุ" แยก)
  const assignees = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) if (r.deviceStatusBy) set.add(r.deviceStatusBy)
    return [...set].sort()
  }, [rows])

  const filtered = useMemo(
    () => applySort(applyAssignee(applySearch(applyFilter(rows, filter), query), assigneeFilter), sortDir),
    [rows, filter, query, assigneeFilter, sortDir],
  )

  return (
    <div>
      <PageTitle
        sub="ติดตามสถานะเครื่องที่คืนจากลูกค้า — เปลี่ยนสถานะทีละขั้น"
        count={loading ? undefined : { shown: filtered.length, total: rows.length }}
      >
        ติดตามเครื่อง (Device Pipeline)
      </PageTitle>

      {/* แถบค้นหา + ตัวกรอง */}
      <div className="mb-4 flex flex-col gap-3">
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ค้นหา ชื่อลูกค้า / รุ่น / SN / IMEI / เลขสัญญา"
            className="pl-9"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm font-medium text-ink">กรอง:</label>
          <Select
            value={filter}
            onChange={(e) => setFilter(e.target.value as DeviceStatus | 'all' | 'active')}
            className="!w-auto min-w-[220px]"
          >
            {FILTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select
            value={assigneeFilter}
            onChange={(e) => setAssigneeFilter(e.target.value)}
            className="!w-auto min-w-[160px]"
          >
            <option value="">ทุกผู้ดำเนินการ</option>
            <option value={UNASSIGNED}>ยังไม่ระบุ</option>
            {assignees.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </Select>
          <button
            type="button"
            onClick={() => setSortDir(sortDir === 'desc' ? 'asc' : 'desc')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-peach px-2.5 py-1.5 text-xs text-ink-soft hover:bg-peach-light"
            aria-label="สลับลำดับวันที่อัปเดตล่าสุด"
          >
            {sortDir === 'desc' ? <ArrowDownAZ size={13} /> : <ArrowUpAZ size={13} />}
            {sortDir === 'desc' ? 'อัปเดตล่าสุดก่อน' : 'อัปเดตเก่าสุดก่อน'}
          </button>
        </div>
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
                      {r.imei && (
                        <p className="text-xs text-ink-soft font-mono">IMEI: {r.imei}</p>
                      )}
                      {r.sn && (
                        <p className="text-xs text-ink-soft font-mono">SN: {r.sn}</p>
                      )}
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
                    <td className="py-3 pr-4 text-ink whitespace-nowrap">
                      {status === 'priced' && isAdmin ? (
                        <div className="flex items-center gap-1.5">
                          <span className="whitespace-nowrap">{r.salePrice != null ? `${baht(r.salePrice)} ฿` : <span className="text-ink-soft">-</span>}</span>
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
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          onClick={() => setDetailTarget(r)}
                          aria-label={canEditDefect(status) ? 'ดู/แก้ไขตำหนิเครื่อง' : 'ดูรายละเอียด/ตำหนิเครื่อง'}
                        >
                          {canEditDefect(status) ? <Pencil size={13} /> : <FileText size={13} />}
                          {canEditDefect(status) ? 'ดู/แก้ตำหนิ' : 'ดูตำหนิ'}
                        </Button>
                        {nexts.length > 0 ? (
                          <Button variant="ghost" onClick={() => setSelected(r)}>
                            เปลี่ยนสถานะ
                          </Button>
                        ) : (
                          <span className="text-xs text-ink-soft">สิ้นสุดแล้ว</span>
                        )}
                      </div>
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

      {detailTarget && (
        <DeviceDetailModal
          row={detailTarget}
          onClose={() => setDetailTarget(null)}
          onSaved={load}
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
