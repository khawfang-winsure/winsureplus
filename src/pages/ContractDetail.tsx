import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Pencil, PackageOpen } from 'lucide-react'
import { Badge, Button, Card, Field, Input, Loading, Modal, PageTitle, Select } from '../components/ui'
import { baht, conditionLabel, installmentLabel, statusLabel, thaiDate } from '../lib/format'
import {
  getContract,
  getInstallments,
  markInstallmentPaid,
  submitReturn,
  type ReturnInput,
} from '../lib/db'
import type { Contract, Installment } from '../lib/types'

export default function ContractDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [contract, setContract] = useState<Contract | null>(null)
  const [installments, setInstallments] = useState<Installment[]>([])
  const [loading, setLoading] = useState(true)
  const [returnOpen, setReturnOpen] = useState(false)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    const [c, ins] = await Promise.all([getContract(id), getInstallments(id)])
    setContract(c)
    setInstallments(ins)
    setLoading(false)
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  async function pay(insId: string) {
    await markInstallmentPaid(insId)
    await load()
  }

  if (loading) {
    return (
      <div>
        <PageTitle>รายละเอียดสัญญา</PageTitle>
        <Loading />
      </div>
    )
  }

  if (!contract) {
    return (
      <div>
        <PageTitle>รายละเอียดสัญญา</PageTitle>
        <p className="text-ink-soft">ไม่พบสัญญานี้</p>
      </div>
    )
  }

  const paidCount = installments.filter((i) => i.paidAt).length
  const penaltyDue = installments.filter((i) => !i.paidAt).reduce((s, i) => s + i.penaltyAmount, 0)

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-ink">{contract.customerName}</h2>
          <p className="text-sm text-ink-soft">
            สัญญา {contract.contractNo} · {contract.model} {contract.storage} · {conditionLabel(contract.condition)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={contract.status === 'active' ? 'green' : 'neutral'}>{statusLabel(contract.status)}</Badge>
          <Button variant="ghost" onClick={() => navigate(`/edit/${contract.id}`)}>
            <Pencil size={15} /> แก้ไข
          </Button>
          {contract.status === 'active' && (
            <Button onClick={() => setReturnOpen(true)}>
              <PackageOpen size={15} /> คืนเครื่อง
            </Button>
          )}
        </div>
      </div>

      {/* สรุป */}
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        {[
          { l: 'ค่าเช่า/เดือน', v: `${baht(contract.monthlyPayment)} ฿` },
          { l: 'งวดที่ชำระแล้ว', v: `${paidCount}/${contract.termMonths}` },
          { l: 'ชำระทุกวันที่', v: String(contract.dueDay) },
          { l: 'ค่าปรับค้าง', v: `${baht(penaltyDue)} ฿` },
        ].map((x) => (
          <Card key={x.l} className="py-3">
            <p className="text-xs text-ink-soft">{x.l}</p>
            <p className="text-lg font-bold text-ink">{x.v}</p>
          </Card>
        ))}
      </div>

      {/* ตารางงวดผ่อน */}
      <h3 className="mb-2 font-semibold text-ink">ตารางงวดผ่อน</h3>
      {installments.length === 0 ? (
        <p className="rounded-xl bg-peach-light/40 px-4 py-3 text-sm text-ink-soft">
          ยังไม่มีตารางงวด (งวดจะถูกสร้างอัตโนมัติเมื่อเพิ่มสัญญาใหม่ในระบบจริง)
        </p>
      ) : (
        <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="bg-peach-light text-left text-ink">
                {['งวด', 'ครบกำหนด', 'จำนวน', 'ค่าปรับ', 'สถานะ', ''].map((h, i) => (
                  <th key={h || i} className="px-3 py-2.5 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {installments.map((i, idx) => (
                <tr key={i.id} className={idx % 2 ? 'bg-white' : 'bg-peach-light/20'}>
                  <td className="px-3 py-2.5">{i.installmentNo}</td>
                  <td className="px-3 py-2.5">{thaiDate(i.dueDate)}</td>
                  <td className="px-3 py-2.5">{baht(i.amount)}</td>
                  <td className="px-3 py-2.5">{i.penaltyAmount > 0 ? `${baht(i.penaltyAmount)} (${i.penaltyDays}ว.)` : '-'}</td>
                  <td className="px-3 py-2.5">
                    <Badge tone={i.status === 'paid' ? 'green' : i.status === 'late' ? 'red' : 'amber'}>
                      {installmentLabel(i.status)}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    {!i.paidAt && (
                      <button
                        onClick={() => pay(i.id)}
                        className="rounded-lg bg-salmon-deep px-3 py-1 text-xs font-semibold text-white hover:brightness-105"
                      >
                        ยืนยันชำระ
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {returnOpen && (
        <ReturnModal
          onClose={() => setReturnOpen(false)}
          onDone={async () => {
            setReturnOpen(false)
            await load()
          }}
          contractId={contract.id}
        />
      )}
    </div>
  )
}

function ReturnModal({
  contractId,
  onClose,
  onDone,
}: {
  contractId: string
  onClose: () => void
  onDone: () => void
}) {
  const [f, setF] = useState<ReturnInput>({
    caseNo: 1,
    lastInstallmentPaid: false,
    penaltyPaid: false,
    repairFee: 0,
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setErr(null)
    try {
      await submitReturn(contractId, f)
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal title="บันทึกการคืนเครื่อง" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="กรณีการคืนเครื่อง">
          <Select
            value={String(f.caseNo)}
            onChange={(e) =>
              setF((p) => ({ ...p, caseNo: Number(e.target.value) as 1 | 2 | 3 }))
            }
          >
            <option value="1">1 — ยังไม่ชำระค่างวด+ค่าปรับ (รอเช็คเครื่อง)</option>
            <option value="2">2 — ชำระค่างวด+ค่าปรับแล้ว (รอเช็คเครื่อง)</option>
            <option value="3">3 — ชำระครบ+ค่าซ่อม(ถ้ามี)แล้ว → ปิดสัญญา</option>
          </Select>
        </Field>

        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={f.lastInstallmentPaid}
            onChange={(e) => setF((p) => ({ ...p, lastInstallmentPaid: e.target.checked }))}
            className="h-4 w-4 accent-salmon-deep"
          />
          ชำระงวดสุดท้ายแล้ว
        </label>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={f.penaltyPaid}
            onChange={(e) => setF((p) => ({ ...p, penaltyPaid: e.target.checked }))}
            className="h-4 w-4 accent-salmon-deep"
          />
          ชำระค่าปรับแล้ว
        </label>

        <Field label="ค่าซ่อม (ถ้ามี — ใส่เพิ่มทีหลังได้)">
          <Input
            type="number"
            value={f.repairFee || ''}
            onChange={(e) => setF((p) => ({ ...p, repairFee: Number(e.target.value) || 0 }))}
          />
        </Field>

        {f.caseNo === 3 && (
          <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
            กรณีที่ 3 = ปิดสัญญาสมบูรณ์ (คืนเครื่องปิดสัญญา)
          </p>
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}

        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
          <Button onClick={save} disabled={busy}>{busy ? 'กำลังบันทึก...' : 'บันทึก'}</Button>
        </div>
      </div>
    </Modal>
  )
}
