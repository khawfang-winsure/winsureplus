import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Copy, Landmark, Receipt, Store, Upload, X, XCircle } from 'lucide-react'
import { Badge, Button, EmptyState, Field, Loading, Modal, PageTitle, Select, Textarea } from '../components/ui'
import { Input } from '../components/ui'
import { useAuth } from '../lib/auth'
import { baht, thaiDate } from '../lib/format'
import { REJECTION_REASON_LABEL } from '../lib/messages'
import {
  getDailyTransferByShop,
  getDailyTransferContracts,
  getSlipSignedUrl,
  markShopTransferred,
  rejectSummaryContract,
  sendSummaryBackToStaff,
  updateContractTransferDate,
  type DailyTransferContractRow,
  type DailyTransferShopRow,
  type NeedsFixReason,
} from '../lib/db'
import { supabase } from '../lib/supabase'

// ===== ปุ่มก็อปเลขบัญชี (req1) =====
function CopyAccountNoButton({ accountNo }: { accountNo: string }) {
  const [copied, setCopied] = useState(false)

  async function copy(e: MouseEvent) {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(accountNo)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title="คัดลอกเลขบัญชี"
      className="inline-flex items-center gap-1 rounded-lg border border-peach bg-white px-1.5 py-0.5 text-xs text-ink-soft transition hover:bg-peach-light/50"
    >
      {copied ? <Check size={11} className="text-green-600" /> : <Copy size={11} />}
      {copied ? 'คัดลอกแล้ว' : accountNo}
    </button>
  )
}

// ===== ป็อปอัพ "ยังไม่โอน/ไม่ผ่าน" ต่อเคส (req2) =====
const REJECTION_REASON_CODES = Object.keys(REJECTION_REASON_LABEL) as NeedsFixReason[]

function RejectContractModal({
  contract,
  byName,
  onClose,
  onDone,
}: {
  contract: DailyTransferContractRow
  byName: string
  onClose: () => void
  onDone: () => void
}) {
  const [reasonCode, setReasonCode] = useState<NeedsFixReason>(REJECTION_REASON_CODES[0])
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const noteRequired = reasonCode === 'other'

  async function handleSave() {
    if (noteRequired && note.trim().length === 0) {
      setError('กรุณาระบุเหตุผล')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await rejectSummaryContract(contract.contractId, reasonCode, note.trim() || null, byName)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`ยังไม่โอน/ไม่ผ่าน — ${contract.customerName}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-soft">
          {contract.contractNo} · ยอดโอนสุทธิ {baht(contract.netTransfer)} บาท
        </p>

        <Field label="เหตุผล" required>
          <Select value={reasonCode} onChange={(e) => setReasonCode(e.target.value as NeedsFixReason)}>
            {REJECTION_REASON_CODES.map((code) => (
              <option key={code} value={code}>
                {REJECTION_REASON_LABEL[code]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="หมายเหตุ" required={noteRequired}>
          <Textarea
            rows={3}
            placeholder={noteRequired ? 'กรุณาระบุเหตุผล' : 'ไม่บังคับ'}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            ยกเลิก
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'กำลังบันทึก...' : 'ยืนยันตีกลับ'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ===== ป็อปอัพ "แก้วันที่โอน" ต่อเคส (req4, admin only) =====
function EditTransactionDateModal({
  contract,
  onClose,
  onDone,
}: {
  contract: DailyTransferContractRow
  onClose: () => void
  onDone: () => void
}) {
  const [newDate, setNewDate] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    if (!newDate) {
      setError('กรุณาเลือกวันที่')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await updateContractTransferDate(contract.contractId, newDate)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`แก้วันที่โอน — ${contract.customerName}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-soft">{contract.contractNo}</p>

        <Field label="วันที่โอนใหม่" required>
          <Input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
        </Field>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            ยกเลิก
          </Button>
          <Button onClick={handleSave} disabled={saving || !newDate}>
            {saving ? 'กำลังบันทึก...' : 'ยืนยันแก้วันที่'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ===== ป็อปอัพ "ส่งกลับให้พนักงาน" ทั้งร้าน (req4, admin only) =====
function SendBackToStaffModal({
  shop,
  contracts,
  byName,
  onClose,
  onDone,
}: {
  shop: DailyTransferShopRow
  contracts: DailyTransferContractRow[]
  byName: string
  onClose: () => void
  onDone: () => void
}) {
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      await sendSummaryBackToStaff(
        contracts.map((c) => c.contractId),
        note.trim(),
        byName,
      )
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`ส่งกลับให้พนักงาน — ${shop.shopName}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-soft">
          ส่งกลับทั้งหมด {contracts.length} สัญญาของร้านนี้ ให้พนักงานตรวจ/แก้ไขใหม่
        </p>

        <Field label="หมายเหตุ (ไม่บังคับ)">
          <Textarea
            rows={3}
            placeholder="เช่น ยอดไม่ตรง กรุณาตรวจสอบใหม่"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            ยกเลิก
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'กำลังบันทึก...' : 'ยืนยันส่งกลับ'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

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

// ===== แถวย่อย "ข้อมูลที่ส่งให้ร้าน" (drill-down ต่อสัญญา) =====
function ContractDetailRow({ r }: { r: DailyTransferContractRow }) {
  const dash = (v: string | null) => v ?? '-'
  const fields: { label: string; value: string }[] = [
    { label: 'เลขที่สัญญา', value: r.contractNo },
    { label: 'เลขที่ INV', value: dash(r.invNo) },
    { label: 'ชื่อลูกค้า', value: r.customerName },
    { label: 'รุ่นเครื่อง', value: dash(r.model) },
    { label: 'ความจุ', value: dash(r.storage) },
    { label: 'SN', value: dash(r.sn) },
    { label: 'ราคาตัวเครื่อง', value: `${baht(r.devicePrice)} บาท` },
    { label: 'ยอดหลังหักดาวน์', value: `${baht(r.afterDown)} บาท` },
    { label: 'ค่าคอมมิชชั่น', value: `${baht(r.commission)} บาท` },
    { label: 'ค่าเอกสาร', value: `${baht(r.docFee)} บาท` },
    { label: 'ยอดโอนสุทธิ', value: `${baht(r.netTransfer)} บาท` },
  ]

  return (
    <tr className="border-b border-peach/60 last:border-0 bg-peach-light/20">
      <td colSpan={5} className="px-4 py-3">
        <p className="mb-2 text-xs font-semibold text-ink-soft">ข้อมูลที่ส่งให้ร้าน</p>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {fields.map((f) => (
            <div key={f.label} className="flex items-baseline justify-between gap-2 text-sm sm:justify-start">
              <dt className="text-ink-soft">{f.label}</dt>
              <dd className="font-medium text-ink sm:ml-1.5">{f.value}</dd>
            </div>
          ))}
        </dl>
      </td>
    </tr>
  )
}

// ===== รายสัญญาของร้าน (drill-down) =====
function ShopContractsList({
  shopId,
  dateISO,
  refreshKey,
  isAdmin,
  onReject,
  onEditDate,
  onRowsLoaded,
}: {
  shopId: string
  dateISO: string
  refreshKey: number
  isAdmin: boolean
  onReject: (contract: DailyTransferContractRow) => void
  onEditDate: (contract: DailyTransferContractRow) => void
  onRowsLoaded?: (rows: DailyTransferContractRow[]) => void
}) {
  const [rows, setRows] = useState<DailyTransferContractRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedContractId, setExpandedContractId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setRows(null)
    setError(null)
    getDailyTransferContracts(shopId, dateISO)
      .then((data) => {
        if (!cancelled) {
          setRows(data)
          onRowsLoaded?.(data)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'โหลดรายการไม่สำเร็จ')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId, dateISO, refreshKey])

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
            <th className="px-4 py-2" />
          </tr>
        </thead>
        {rows.map((r) => {
          const isOpen = expandedContractId === r.contractId
          return (
            <tbody key={r.contractId}>
              <tr
                onClick={() => setExpandedContractId((cur) => (cur === r.contractId ? null : r.contractId))}
                aria-expanded={isOpen}
                className="cursor-pointer border-b border-peach/60 transition hover:bg-peach-light/20 last:border-0"
              >
                <td className="px-4 py-2 text-ink">
                  <span className="inline-flex items-center gap-1.5">
                    <ChevronDown
                      size={14}
                      className={`shrink-0 text-ink-soft transition-transform ${isOpen ? 'rotate-180' : ''}`}
                    />
                    {r.contractNo}
                  </span>
                </td>
                <td className="px-4 py-2 text-ink">{r.customerName}</td>
                <td className="px-4 py-2 text-right text-ink-soft">{baht(r.devicePrice)}</td>
                <td className="px-4 py-2 text-right font-medium text-ink">{baht(r.netTransfer)}</td>
                <td className="px-4 py-2 text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onEditDate(r) }}
                        className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-peach bg-white px-2 py-1 text-xs font-medium text-ink-soft transition hover:bg-peach-light/50"
                      >
                        แก้วันที่โอน
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onReject(r) }}
                      className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-700 transition hover:bg-red-100"
                    >
                      <XCircle size={12} />
                      ยังไม่โอน/ไม่ผ่าน
                    </button>
                  </div>
                </td>
              </tr>
              {isOpen && <ContractDetailRow r={r} />}
            </tbody>
          )
        })}
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
  refreshKey,
  isAdmin,
  onToggle,
  onUpload,
  onViewSlip,
  onRejectContract,
  onEditDateContract,
  onSendBackToStaff,
}: {
  shop: DailyTransferShopRow
  dateISO: string
  expanded: boolean
  refreshKey: number
  isAdmin: boolean
  onToggle: () => void
  onUpload: () => void
  onViewSlip: () => void
  onRejectContract: (contract: DailyTransferContractRow) => void
  onEditDateContract: (contract: DailyTransferContractRow) => void
  onSendBackToStaff: (contracts: DailyTransferContractRow[]) => void
}) {
  const [loadedRows, setLoadedRows] = useState<DailyTransferContractRow[]>([])

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
          <div>
            <span className="font-semibold text-ink">{shop.shopName}</span>
            <span className="ml-1.5 text-xs text-ink-soft">({shop.contractCount} สัญญา)</span>
            {/* req1: ธนาคาร + เลขบัญชี + ชื่อบัญชี พร้อมปุ่มก็อป */}
            <p className="mt-0.5 text-xs text-ink-soft">
              {shop.bank} · <CopyAccountNoButton accountNo={shop.accountNo} /> · {shop.accountName}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-base font-bold text-ink">{baht(shop.amount)} บาท</span>
          {shop.transferred ? (
            shop.slipWaived ? (
              <Badge tone="green">โอนแล้ว (ย้อนหลัง)</Badge>
            ) : (
              <Badge tone="green">โอนแล้ว</Badge>
            )
          ) : (
            <Badge tone="amber">ยังไม่โอน</Badge>
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-peach">
          <ShopContractsList
            shopId={shop.shopId}
            dateISO={dateISO}
            refreshKey={refreshKey}
            isAdmin={isAdmin}
            onReject={onRejectContract}
            onEditDate={onEditDateContract}
            onRowsLoaded={setLoadedRows}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-peach px-4 py-3">
            <div className="text-xs text-ink-soft">
              {shop.transferred ? (
                <>
                  {shop.slipWaived ? 'ยืนยันย้อนหลังโดย' : 'โอนโดย'} {shop.transferredBy ?? '-'}
                  {shop.transferredAt && ` · ${thaiDate(shop.transferredAt.slice(0, 10))}`}
                  {shop.note && ` · หมายเหตุ: ${shop.note}`}
                </>
              ) : (
                'ยังไม่มีการบันทึกโอนเงินสำหรับร้านนี้ในวันนี้'
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {isAdmin && loadedRows.length > 0 && (
                <Button
                  variant="ghost"
                  onClick={(e) => { e.stopPropagation(); onSendBackToStaff(loadedRows) }}
                >
                  ส่งกลับให้พนักงาน
                </Button>
              )}
              {shop.transferred && !shop.slipWaived && (
                <Button variant="ghost" onClick={(e) => { e.stopPropagation(); onViewSlip() }}>
                  <Receipt size={15} />
                  ดูสลิป
                </Button>
              )}
              {!shop.transferred && (
                <Button onClick={(e) => { e.stopPropagation(); onUpload() }}>
                  <Upload size={15} />
                  อัปโหลดสลิป
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ===== หน้าหลัก =====
export default function AccountingTransfers() {
  const { name, role } = useAuth()
  const byName = name ?? 'บัญชี'
  const isAdmin = role === 'admin'

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
  const [rejectContract, setRejectContract] = useState<DailyTransferContractRow | null>(null)
  const [editDateContract, setEditDateContract] = useState<DailyTransferContractRow | null>(null)
  const [sendBackTarget, setSendBackTarget] = useState<{ shop: DailyTransferShopRow; contracts: DailyTransferContractRow[] } | null>(null)

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
        <PageTitle sub="รายการยอดโอนเงินให้ร้านค้า จัดกลุ่มตามวันที่ส่งบัญชี — อัปโหลดสลิปเมื่อโอนแล้ว">
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
            <Landmark size={13} /> ยอดที่ต้องโอน (ตามวันที่ส่งบัญชี)
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
        <EmptyState title="ยังไม่มีเคสส่งบัญชีในวันที่เลือก" hint="ลองเปลี่ยนวันที่ดู หรือรอพนักงานกดส่งบัญชีก่อนค่ะ" />
      ) : (
        <div className="flex flex-col gap-2">
          {shops.map((shop) => (
            <ShopRow
              key={shop.shopId}
              shop={shop}
              dateISO={dateISO}
              expanded={expandedShopId === shop.shopId}
              refreshKey={tick}
              isAdmin={isAdmin}
              onToggle={() => setExpandedShopId((cur) => (cur === shop.shopId ? null : shop.shopId))}
              onUpload={() => setUploadShop(shop)}
              onViewSlip={() => handleViewSlip(shop)}
              onRejectContract={(c) => setRejectContract(c)}
              onEditDateContract={(c) => setEditDateContract(c)}
              onSendBackToStaff={(contracts) => setSendBackTarget({ shop, contracts })}
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

      {rejectContract && (
        <RejectContractModal
          contract={rejectContract}
          byName={byName}
          onClose={() => setRejectContract(null)}
          onDone={() => {
            setRejectContract(null)
            refresh()
          }}
        />
      )}

      {editDateContract && (
        <EditTransactionDateModal
          contract={editDateContract}
          onClose={() => setEditDateContract(null)}
          onDone={() => {
            setEditDateContract(null)
            refresh()
          }}
        />
      )}

      {sendBackTarget && (
        <SendBackToStaffModal
          shop={sendBackTarget.shop}
          contracts={sendBackTarget.contracts}
          byName={byName}
          onClose={() => setSendBackTarget(null)}
          onDone={() => {
            setSendBackTarget(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}
