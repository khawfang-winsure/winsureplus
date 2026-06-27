import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, FileText } from 'lucide-react'
import { Badge, Button, EmptyState, Input, Loading, Modal, PageTitle } from '../components/ui'
import { baht, thaiDate } from '../lib/format'
import { getReturns, updateReturnRepairFee } from '../lib/db'
import type { DeviceReturnRow } from '../lib/types'

const CASE_LABEL: Record<number, string> = {
  1: 'ยังไม่ชำระค่างวด+ค่าปรับ (รอเช็คเครื่อง)',
  2: 'ชำระค่างวด+ค่าปรับแล้ว (รอเช็คเครื่อง)',
  3: 'ปิดสัญญาสมบูรณ์',
}

const DEVICE_STATUS_LABEL_TH: Record<string, string> = {
  in_transit: 'อยู่ระหว่างจัดส่ง',
  pending_check: 'รอตรวจสอบ',
  checked: 'ตรวจสอบเรียบร้อยแล้ว',
  pending_sale: 'รอขาย',
  priced: 'ตั้งราคาแล้ว',
  transferred: 'โอนแล้ว',
  shipped: 'จัดส่งให้ร้านค้าเรียบร้อย',
}

export default function Returns() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<DeviceReturnRow[]>([])
  const [loading, setLoading] = useState(true)
  const [repairEdit, setRepairEdit] = useState<DeviceReturnRow | null>(null)
  const [detailTarget, setDetailTarget] = useState<DeviceReturnRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setRows(await getReturns())
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div>
      <PageTitle sub="ลูกค้าที่คืนเครื่อง — แบ่ง 3 กรณีตามการชำระและการเช็คเครื่อง" count={loading ? undefined : { shown: rows.length }}>ลูกค้าคืนเครื่อง</PageTitle>

      <div className="mb-5 grid gap-3 md:grid-cols-3">
        {[
          { n: 1, t: 'ยังไม่ชำระค่างวด+ค่าปรับ', d: 'รอเช็คเครื่อง' },
          { n: 2, t: 'ชำระค่างวด+ค่าปรับแล้ว', d: 'รอเช็คเครื่อง' },
          { n: 3, t: 'ชำระครบ + ค่าซ่อม (ถ้ามี)', d: 'ปิดสัญญาสมบูรณ์' },
        ].map((c) => (
          <div key={c.n} className="rounded-2xl border border-peach bg-peach-light/40 p-4">
            <p className="text-sm font-semibold text-salmon-deep">กรณีที่ {c.n}</p>
            <p className="mt-1 font-medium text-ink">{c.t}</p>
            <p className="text-sm text-ink-soft">{c.d}</p>
          </div>
        ))}
      </div>

      <p className="mb-3 text-sm text-ink-soft">
        เริ่มการคืนเครื่องได้จากหน้ารายละเอียดสัญญา (กดปุ่ม "คืนเครื่อง")
      </p>

      {loading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="ยังไม่มีรายการคืนเครื่อง" />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li key={r.id} className="rounded-xl border border-peach bg-white px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div
                  className="cursor-pointer"
                  onClick={() => navigate(`/contract/${r.contractId}`)}
                >
                  <p className="font-medium text-ink">{r.customerName} — {r.contractNo}</p>
                  <p className="text-sm text-ink-soft">{CASE_LABEL[r.caseNo]} · {thaiDate(r.createdAt)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={r.caseNo === 3 ? 'green' : 'amber'}>
                    {r.caseNo === 3 ? 'ปิดสัญญา' : 'รอดำเนินการ'}
                  </Badge>
                  <span className="text-sm text-ink-soft">
                    ค่าซ่อม {r.repairFee > 0 ? `${baht(r.repairFee)} ฿` : '-'}
                  </span>
                  <Button variant="ghost" onClick={() => setDetailTarget(r)} aria-label="ดูรายละเอียด/ตำหนิเครื่อง">
                    <FileText size={13} />
                    ดูรายละเอียด
                  </Button>
                  <Button variant="ghost" onClick={() => setRepairEdit(r)}>ใส่ค่าซ่อม</Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {repairEdit && (
        <RepairModal
          row={repairEdit}
          onClose={() => setRepairEdit(null)}
          onDone={async () => {
            setRepairEdit(null)
            await load()
          }}
        />
      )}

      {detailTarget && (
        <DeviceDetailModal row={detailTarget} onClose={() => setDetailTarget(null)} />
      )}
    </div>
  )
}

// ===== Modal ดูรายละเอียด/ตำหนิเครื่อง (อ่านอย่างเดียว) =====
function DeviceDetailModal({
  row,
  onClose,
}: {
  row: DeviceReturnRow
  onClose: () => void
}) {
  const statusKey = row.deviceStatus ?? 'pending_check'
  const statusLabel = DEVICE_STATUS_LABEL_TH[statusKey] ?? statusKey
  const hasDefect = !!row.defectNotes && row.defectNotes.trim().length > 0
  const repair = row.repairCost ?? 0

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
          <span><Badge tone="neutral">{statusLabel}</Badge></span>
          {repair > 0 && (
            <>
              <span className="text-ink-soft">ค่าซ่อม</span>
              <span className="text-ink">{baht(repair)} ฿</span>
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
              <span className="text-ink">{row.courier ? `${row.courier} · ` : ''}{row.trackingNumber}</span>
            </>
          ) : null}
        </div>

        {/* ตำหนิเครื่อง */}
        <div>
          <p className="mb-1 flex items-center gap-1.5 text-sm font-medium text-ink">
            <AlertCircle size={15} className="text-salmon-deep" />
            ตำหนิตัวเครื่อง
          </p>
          {hasDefect ? (
            <div className="whitespace-pre-line rounded-xl bg-peach-light/40 px-4 py-3 text-sm text-ink">
              {row.defectNotes}
            </div>
          ) : (
            <p className="rounded-xl bg-peach-light/40 px-4 py-3 text-sm text-ink-soft">
              ยังไม่มีบันทึกตำหนิ
            </p>
          )}
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>ปิด</Button>
        </div>
      </div>
    </Modal>
  )
}

function RepairModal({
  row,
  onClose,
  onDone,
}: {
  row: DeviceReturnRow
  onClose: () => void
  onDone: () => void
}) {
  const [fee, setFee] = useState(String(row.repairFee || ''))
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      await updateReturnRepairFee(row.id, Number(fee) || 0)
      onDone()
    } catch {
      setBusy(false)
    }
  }

  return (
    <Modal title={`ใส่ค่าซ่อม — ${row.customerName}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Input type="number" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="ค่าซ่อม (บาท)" />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
          <Button onClick={save} disabled={busy}>{busy ? 'กำลังบันทึก...' : 'บันทึก'}</Button>
        </div>
      </div>
    </Modal>
  )
}
