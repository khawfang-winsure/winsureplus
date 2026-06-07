import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge, Button, EmptyState, Input, Loading, Modal, PageTitle } from '../components/ui'
import { baht, thaiDate } from '../lib/format'
import { getReturns, updateReturnRepairFee } from '../lib/db'
import type { DeviceReturnRow } from '../lib/types'

const CASE_LABEL: Record<number, string> = {
  1: 'ยังไม่ชำระค่างวด+ค่าปรับ (รอเช็คเครื่อง)',
  2: 'ชำระค่างวด+ค่าปรับแล้ว (รอเช็คเครื่อง)',
  3: 'ปิดสัญญาสมบูรณ์',
}

export default function Returns() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<DeviceReturnRow[]>([])
  const [loading, setLoading] = useState(true)
  const [repairEdit, setRepairEdit] = useState<DeviceReturnRow | null>(null)

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
      <PageTitle sub="ลูกค้าที่คืนเครื่อง — แบ่ง 3 กรณีตามการชำระและการเช็คเครื่อง">ลูกค้าคืนเครื่อง</PageTitle>

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
    </div>
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
