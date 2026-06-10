import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Pencil, PackageOpen, History, CalendarClock } from 'lucide-react'
import { Badge, Button, Card, Field, Input, Loading, Modal, PageTitle, Select } from '../components/ui'
import { baht, conditionLabel, installmentLabel, statusLabel, thaiDate } from '../lib/format'
import {
  getContract,
  getInstallments,
  getPaymentLog,
  getContractExtensions,
  recordPayment,
  adjustPayment,
  cancelPayment,
  restructureContract,
  submitReturn,
  type PaymentLogEntry,
  type ExtensionRecord,
  type ExtensionType,
  type ReturnInput,
} from '../lib/db'
import type { Contract, Installment } from '../lib/types'

export const EXT_TYPE_LABEL: Record<ExtensionType, string> = {
  due_day: 'เปลี่ยนวันที่ชำระ',
  months: 'ขยายจำนวนงวด',
  both: 'เปลี่ยนวันชำระ + ขยายงวด',
}

/** พรีวิววันครบกำหนดงวดใหม่ (มิเรอร์ตรรกะใน RPC restructure_contract: งวด i = เดือนปัจจุบัน + i, clamp ปลายเดือน) */
function previewDueDate(monthOffset: number, dueDay: number): string {
  const now = new Date()
  const y0 = now.getFullYear()
  const m0 = now.getMonth() // 0-based
  const idx = m0 + monthOffset
  const y = y0 + Math.floor(idx / 12)
  const m = (idx % 12 + 12) % 12 // 0-based เดือนเป้าหมาย
  const lastDay = new Date(y, m + 1, 0).getDate()
  const d = Math.min(dueDay, lastDay)
  return `${String(d).padStart(2, '0')}/${String(m + 1).padStart(2, '0')}/${y}`
}

const ACTION_LABEL: Record<PaymentLogEntry['action'], string> = {
  pay: 'รับชำระ',
  edit: 'แก้ไขยอด',
  cancel: 'ยกเลิกชำระ',
}
const ACTION_TONE: Record<PaymentLogEntry['action'], 'green' | 'amber' | 'red'> = {
  pay: 'green',
  edit: 'amber',
  cancel: 'red',
}

export default function ContractDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [contract, setContract] = useState<Contract | null>(null)
  const [installments, setInstallments] = useState<Installment[]>([])
  const [log, setLog] = useState<PaymentLogEntry[]>([])
  const [extensions, setExtensions] = useState<ExtensionRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [returnOpen, setReturnOpen] = useState(false)
  const [extendOpen, setExtendOpen] = useState(false)
  // โมดัลชำระเงิน: เก็บงวดที่กำลังทำ + โหมด ('pay' รับชำระ / 'edit' แก้ไขยอด)
  const [payTarget, setPayTarget] = useState<{ ins: Installment; mode: 'pay' | 'edit' } | null>(null)
  const [cancelTarget, setCancelTarget] = useState<Installment | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    const [c, ins, lg, ext] = await Promise.all([
      getContract(id),
      getInstallments(id),
      getPaymentLog(id),
      getContractExtensions(id),
    ])
    setContract(c)
    setInstallments(ins)
    setLog(lg)
    setExtensions(ext)
    setLoading(false)
  }, [id])

  useEffect(() => {
    load()
  }, [load])

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
            <>
              <Button variant="ghost" onClick={() => setExtendOpen(true)}>
                <CalendarClock size={15} /> ขยายระยะเวลา
              </Button>
              <Button onClick={() => setReturnOpen(true)}>
                <PackageOpen size={15} /> คืนเครื่อง
              </Button>
            </>
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

      {/* ข้อมูลการบันทึก */}
      <Card className="mb-4 py-3">
        <div className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <p className="text-xs text-ink-soft">ผู้ดำเนินการ</p>
            <p className="font-semibold text-ink">{contract.operator || '—'}</p>
          </div>
          <div>
            <p className="text-xs text-ink-soft">ผู้บันทึก (อัตโนมัติ)</p>
            <p className="font-semibold text-ink">{contract.recordedBy || '—'}</p>
          </div>
          <div>
            <p className="text-xs text-ink-soft">วันที่ทำรายการ</p>
            <p className="font-semibold text-ink">{thaiDate(contract.transactionDate)}</p>
          </div>
        </div>
      </Card>

      {/* ตารางงวดผ่อน */}
      <h3 className="mb-2 font-semibold text-ink">ตารางงวดผ่อน</h3>
      {installments.length === 0 ? (
        <p className="rounded-xl bg-peach-light/40 px-4 py-3 text-sm text-ink-soft">
          ยังไม่มีตารางงวด (งวดจะถูกสร้างอัตโนมัติเมื่อเพิ่มสัญญาใหม่ในระบบจริง)
        </p>
      ) : (
        <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="bg-peach-light text-left text-ink">
                {['งวด', 'ครบกำหนด', 'ค่างวด', 'ชำระแล้ว', 'ค่าปรับ', 'สถานะ', ''].map((h, i) => (
                  <th key={h || i} className="px-3 py-2.5 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {installments.map((i, idx) => {
                const remaining = Math.max(0, i.amount - i.paidAmount)
                const partial = !i.paidAt && i.paidAmount > 0
                return (
                  <tr key={i.id} className={idx % 2 ? 'bg-white' : 'bg-peach-light/20'}>
                    <td className="px-3 py-2.5">{i.installmentNo}</td>
                    <td className="px-3 py-2.5">{thaiDate(i.dueDate)}</td>
                    <td className="px-3 py-2.5">{baht(i.amount)}</td>
                    <td className="px-3 py-2.5">
                      {i.paidAmount > 0 ? (
                        <span>
                          {baht(i.paidAmount)}
                          {remaining > 0 && <span className="text-red-600"> (ค้าง {baht(remaining)})</span>}
                        </span>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className="px-3 py-2.5">{i.penaltyAmount > 0 ? `${baht(i.penaltyAmount)} (${i.penaltyDays}ว.)` : '-'}</td>
                    <td className="px-3 py-2.5">
                      {partial ? (
                        <Badge tone="amber">ชำระบางส่วน</Badge>
                      ) : (
                        <Badge tone={i.status === 'paid' ? 'green' : i.status === 'late' ? 'red' : 'amber'}>
                          {installmentLabel(i.status)}
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1.5">
                        {!i.paidAt && (
                          <button
                            onClick={() => setPayTarget({ ins: i, mode: 'pay' })}
                            className="rounded-lg bg-salmon-deep px-3 py-1 text-xs font-semibold text-white hover:brightness-105"
                          >
                            รับชำระ
                          </button>
                        )}
                        {i.paidAmount > 0 && (
                          <>
                            <button
                              onClick={() => setPayTarget({ ins: i, mode: 'edit' })}
                              className="rounded-lg border border-peach px-3 py-1 text-xs font-semibold text-ink-soft hover:bg-peach-light/40"
                            >
                              แก้ไขยอด
                            </button>
                            <button
                              onClick={() => setCancelTarget(i)}
                              className="rounded-lg border border-red-300 px-3 py-1 text-xs font-semibold text-red-600 hover:bg-red-50"
                            >
                              ยกเลิก
                            </button>
                          </>
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

      {/* ประวัติการชำระ (audit log) */}
      <h3 className="mb-2 mt-6 flex items-center gap-1.5 font-semibold text-ink">
        <History size={16} /> ประวัติการชำระ
      </h3>
      {log.length === 0 ? (
        <p className="rounded-xl bg-peach-light/40 px-4 py-3 text-sm text-ink-soft">ยังไม่มีประวัติการชำระ</p>
      ) : (
        <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="bg-peach-light text-left text-ink">
                {['เวลา', 'รายการ', 'จำนวน', 'ยอดสะสมหลังทำ', 'ผู้ทำรายการ', 'หมายเหตุ'].map((h) => (
                  <th key={h} className="px-3 py-2.5 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {log.map((e, idx) => {
                const ins = installments.find((i) => i.id === e.installmentId)
                return (
                  <tr key={e.id} className={idx % 2 ? 'bg-white' : 'bg-peach-light/20'}>
                    <td className="px-3 py-2.5 whitespace-nowrap">{thaiDateTime(e.createdAt)}</td>
                    <td className="px-3 py-2.5">
                      <Badge tone={ACTION_TONE[e.action]}>{ACTION_LABEL[e.action]}</Badge>
                      {ins && <span className="ml-1.5 text-ink-soft">งวด {ins.installmentNo}</span>}
                    </td>
                    <td className="px-3 py-2.5">{e.action === 'cancel' ? '-' : `${baht(e.amount)} ฿`}</td>
                    <td className="px-3 py-2.5">{baht(e.paidAmountAfter)} ฿</td>
                    <td className="px-3 py-2.5">{e.byName || '—'}</td>
                    <td className="px-3 py-2.5 text-ink-soft">{e.note || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ประวัติการขยายระยะเวลา */}
      {extensions.length > 0 && (
        <>
          <h3 className="mb-2 mt-6 flex items-center gap-1.5 font-semibold text-ink">
            <CalendarClock size={16} /> ประวัติการขยายระยะเวลา
          </h3>
          <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="bg-peach-light text-left text-ink">
                  {['เวลา', 'ประเภท', 'วันชำระ', 'ค่างวด', 'จำนวนงวด', 'ยอดจัดไฟแนนซ์', 'ผู้ทำ', 'หมายเหตุ'].map((h) => (
                    <th key={h} className="px-3 py-2.5 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {extensions.map((e, idx) => (
                  <tr key={e.id} className={idx % 2 ? 'bg-white' : 'bg-peach-light/20'}>
                    <td className="px-3 py-2.5 whitespace-nowrap">{thaiDateTime(e.createdAt)}</td>
                    <td className="px-3 py-2.5"><Badge tone="amber">{EXT_TYPE_LABEL[e.extType]}</Badge></td>
                    <td className="px-3 py-2.5">{e.oldDueDay} → {e.newDueDay}</td>
                    <td className="px-3 py-2.5">{baht(e.oldMonthly ?? 0)} → {baht(e.newMonthly ?? 0)}</td>
                    <td className="px-3 py-2.5">{e.oldTerm} → {e.newTerm} <span className="text-ink-soft">(+{e.newInstallments} งวดใหม่)</span></td>
                    <td className="px-3 py-2.5">{baht(e.oldFinance ?? 0)} → {baht(e.newFinance ?? 0)}</td>
                    <td className="px-3 py-2.5">{e.recordedByName || '—'}</td>
                    <td className="px-3 py-2.5 text-ink-soft">{e.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {extendOpen && (
        <ExtendModal
          contract={contract}
          installments={installments}
          onClose={() => setExtendOpen(false)}
          onDone={async () => {
            setExtendOpen(false)
            await load()
          }}
        />
      )}

      {payTarget && (
        <PaymentModal
          ins={payTarget.ins}
          mode={payTarget.mode}
          onClose={() => setPayTarget(null)}
          onDone={async () => {
            setPayTarget(null)
            await load()
          }}
        />
      )}

      {cancelTarget && (
        <CancelModal
          ins={cancelTarget}
          onClose={() => setCancelTarget(null)}
          onDone={async () => {
            setCancelTarget(null)
            await load()
          }}
        />
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

/** ดึงข้อความ error ให้อ่านออก (PostgREST error เป็น object มี .message ไม่ใช่ Error instance) */
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}

/** เวลาไทยแบบสั้น (วัน/เดือน/ปี เวลา) สำหรับ audit log — แปลงจาก ISO timestamp เต็ม */
function thaiDateTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const time = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
  return `${dd}/${mm}/${d.getFullYear()} ${time}`
}

function PaymentModal({
  ins,
  mode,
  onClose,
  onDone,
}: {
  ins: Installment
  mode: 'pay' | 'edit'
  onClose: () => void
  onDone: () => void
}) {
  const remaining = Math.max(0, ins.amount - ins.paidAmount)
  // โหมดรับชำระ: ตั้งค่าเริ่มต้น = ยอดค้างที่เหลือ / โหมดแก้ไข: = ยอดสะสมปัจจุบัน
  const [amount, setAmount] = useState<number>(mode === 'pay' ? remaining : ins.paidAmount)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setErr(null)
    try {
      if (mode === 'pay') await recordPayment(ins.id, amount, note || undefined)
      else await adjustPayment(ins.id, amount, note || undefined)
      onDone()
    } catch (e) {
      setErr(errMsg(e))
      setBusy(false)
    }
  }

  const previewTotal = mode === 'pay' ? ins.paidAmount + amount : amount
  const willClose = previewTotal >= ins.amount

  return (
    <Modal title={mode === 'pay' ? `รับชำระ — งวดที่ ${ins.installmentNo}` : `แก้ไขยอด — งวดที่ ${ins.installmentNo}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-3 gap-2 rounded-xl bg-peach-light/40 p-3 text-sm">
          <div>
            <p className="text-xs text-ink-soft">ค่างวด</p>
            <p className="font-semibold text-ink">{baht(ins.amount)} ฿</p>
          </div>
          <div>
            <p className="text-xs text-ink-soft">ชำระแล้ว</p>
            <p className="font-semibold text-ink">{baht(ins.paidAmount)} ฿</p>
          </div>
          <div>
            <p className="text-xs text-ink-soft">ค้าง</p>
            <p className="font-semibold text-red-600">{baht(remaining)} ฿</p>
          </div>
        </div>

        <Field label={mode === 'pay' ? 'จำนวนเงินที่รับชำระครั้งนี้ (บาท)' : 'ยอดที่ชำระสะสมใหม่ (บาท)'}>
          <Input
            type="number"
            autoFocus
            value={amount || ''}
            onChange={(e) => setAmount(Number(e.target.value) || 0)}
          />
        </Field>

        <Field label="หมายเหตุ (ถ้ามี)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น โอนผ่านธนาคาร / แก้ไขจากกรอกผิด" />
        </Field>

        <p className={`rounded-lg px-3 py-2 text-sm ${willClose ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
          {willClose
            ? `ยอดสะสมจะเป็น ${baht(previewTotal)} ฿ → ปิดงวดนี้ (ชำระครบ)`
            : `ยอดสะสมจะเป็น ${baht(previewTotal)} ฿ → ค้างอีก ${baht(Math.max(0, ins.amount - previewTotal))} ฿ (งวดยังเปิด)`}
        </p>

        {err && <p className="text-sm text-red-600">{err}</p>}

        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
          <Button onClick={save} disabled={busy || amount < 0}>{busy ? 'กำลังบันทึก...' : 'บันทึก'}</Button>
        </div>
      </div>
    </Modal>
  )
}

function CancelModal({ ins, onClose, onDone }: { ins: Installment; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setErr(null)
    try {
      await cancelPayment(ins.id, note || undefined)
      onDone()
    } catch (e) {
      setErr(errMsg(e))
      setBusy(false)
    }
  }

  return (
    <Modal title={`ยกเลิกการชำระ — งวดที่ ${ins.installmentNo}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          จะล้างยอดชำระทั้งหมดของงวดนี้ ({baht(ins.paidAmount)} ฿) แล้วคืนเป็น “ค้างชำระ” — บันทึกลงประวัติด้วย
        </p>
        <Field label="เหตุผลที่ยกเลิก (แนะนำให้ระบุ)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น กดรับชำระผิดเคส" />
        </Field>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>ปิด</Button>
          <Button onClick={save} disabled={busy}>{busy ? 'กำลังยกเลิก...' : 'ยืนยันยกเลิก'}</Button>
        </div>
      </div>
    </Modal>
  )
}

function ExtendModal({
  contract,
  installments,
  onClose,
  onDone,
}: {
  contract: Contract
  installments: Installment[]
  onClose: () => void
  onDone: () => void
}) {
  const unpaidCount = installments.filter((i) => !i.paidAt).length
  const lastPaidNo = installments.filter((i) => i.paidAt).reduce((m, i) => Math.max(m, i.installmentNo), 0)
  const partialPaid = installments
    .filter((i) => !i.paidAt && i.paidAmount > 0)
    .reduce((s, i) => s + i.paidAmount, 0)
  const baseTerm = Math.max(1, unpaidCount)

  const [extType, setExtType] = useState<ExtensionType>('both')
  const [newDueDay, setNewDueDay] = useState(contract.dueDay)
  const [newTerm, setNewTerm] = useState(baseTerm)
  const [newFinance, setNewFinance] = useState(Math.round(baseTerm * contract.monthlyPayment))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const lockDueDay = extType === 'months' // ขยายงวดอย่างเดียว = วันชำระเดิม
  const lockTermFinance = extType === 'due_day' // เปลี่ยนวันชำระอย่างเดียว = งวด/ยอดเดิม

  function changeType(t: ExtensionType) {
    setExtType(t)
    if (t === 'due_day') {
      setNewTerm(baseTerm)
      setNewFinance(Math.round(baseTerm * contract.monthlyPayment))
    }
    if (t === 'months') {
      setNewDueDay(contract.dueDay)
    }
  }

  const newMonthly = newTerm > 0 ? Math.round(newFinance / newTerm) : 0
  const firstNo = lastPaidNo + 1
  const lastNo = lastPaidNo + newTerm
  const totalTerm = lastPaidNo + newTerm
  const valid = newDueDay >= 1 && newDueDay <= 31 && newTerm > 0 && newFinance >= 0

  async function save() {
    setBusy(true)
    setErr(null)
    try {
      await restructureContract(contract.id, {
        extType,
        newDueDay,
        newTerm,
        newFinance,
        note: note || undefined,
      })
      onDone()
    } catch (e) {
      setErr(errMsg(e))
      setBusy(false)
    }
  }

  return (
    <Modal title="ขยายระยะเวลา" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="ประเภทการขยาย">
          <Select value={extType} onChange={(e) => changeType(e.target.value as ExtensionType)}>
            <option value="both">เปลี่ยนวันชำระ + ขยายจำนวนงวด</option>
            <option value="due_day">เปลี่ยนวันที่ชำระอย่างเดียว</option>
            <option value="months">ขยายจำนวนงวดอย่างเดียว (วันชำระเดิม)</option>
          </Select>
        </Field>

        <div className="rounded-xl bg-peach-light/40 px-3 py-2 text-sm text-ink-soft">
          ค้างชำระ <b className="text-ink">{unpaidCount}</b> งวด · จ่ายล่าสุดงวดที่ <b className="text-ink">{lastPaidNo || '-'}</b>
          {partialPaid > 0 && (
            <span className="mt-1 block text-amber-700">
              ⚠️ มีจ่ายบางส่วนค้างอยู่ {baht(partialPaid)} ฿ — งวดนี้จะถูกลบด้วย ควรหักออกจากยอดจัดไฟแนนซ์ใหม่
            </span>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="วันที่ชำระใหม่ (1–31)">
            <Input
              type="number"
              value={newDueDay || ''}
              disabled={lockDueDay}
              onChange={(e) => setNewDueDay(Number(e.target.value) || 0)}
            />
          </Field>
          <Field label="จำนวนงวดที่จะผ่อนใหม่">
            <Input
              type="number"
              value={newTerm || ''}
              disabled={lockTermFinance}
              onChange={(e) => setNewTerm(Number(e.target.value) || 0)}
            />
          </Field>
          <Field label="ยอดจัดไฟแนนซ์ใหม่ (บาท)">
            <Input
              type="number"
              value={newFinance || ''}
              disabled={lockTermFinance}
              onChange={(e) => setNewFinance(Number(e.target.value) || 0)}
            />
          </Field>
        </div>

        <div className="rounded-xl border border-peach bg-white px-3 py-2.5 text-sm">
          <p className="font-semibold text-ink">สรุปงวดใหม่</p>
          <p className="text-ink-soft">
            ค่างวดใหม่ <b className="text-ink">{baht(newMonthly)} ฿/เดือน</b> · งวดเลขที่{' '}
            <b className="text-ink">{firstNo}–{lastNo}</b> ({newTerm} งวด · รวมทั้งสัญญา {totalTerm} งวด)
          </p>
          <p className="text-ink-soft">
            งวดแรกครบ <b className="text-ink">{previewDueDate(1, newDueDay)}</b> · งวดสุดท้ายครบ{' '}
            <b className="text-ink">{previewDueDate(newTerm, newDueDay)}</b>
          </p>
          <p className="mt-1 text-red-600">งวดที่ยังไม่จ่าย {unpaidCount} งวด จะถูกลบแล้วสร้างใหม่ตามนี้</p>
        </div>

        <Field label="หมายเหตุ (ถ้ามี)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น ลูกค้าขอลดค่างวด ผ่อนยาวขึ้น" />
        </Field>

        {err && <p className="text-sm text-red-600">{err}</p>}

        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
          <Button onClick={save} disabled={busy || !valid}>{busy ? 'กำลังบันทึก...' : 'ยืนยันขยายระยะเวลา'}</Button>
        </div>
      </div>
    </Modal>
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
      setErr(errMsg(e))
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
