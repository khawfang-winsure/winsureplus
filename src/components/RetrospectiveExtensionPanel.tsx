import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, Card, Field, Input, Loading, Modal, Select, Textarea } from './ui'
import {
  approveRetrospectiveExtension,
  createRetrospectiveExtensionRequest,
  getRetrospectiveExtensionPreview,
  getRetrospectiveExtensionRequests,
  rejectRetrospectiveExtension,
  type ExtensionSchedulePreview,
  type ExtensionType,
  type RetrospectiveExtensionInput,
  type RetrospectiveExtensionPreview,
  type RetrospectiveExtensionRequest,
} from '../lib/db'
import { thaiDate } from '../lib/format'
import type { Contract, Installment } from '../lib/types'

const money = (value: number) => value.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const primaryStyle = { backgroundColor: 'var(--color-ink)', color: '#ffffff' }
const typeLabels: Record<ExtensionType, string> = {
  months: 'ขยายจำนวนงวด', due_day: 'เปลี่ยนวันชำระ', both: 'เปลี่ยนวันชำระและขยายจำนวนงวด',
}
const statusLabels = { pending: 'รอผู้ดูแลพิจารณา', approved: 'อนุมัติแล้ว', rejected: 'ไม่อนุมัติ' }
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message
  return 'ทำรายการไม่สำเร็จ กรุณาลองอีกครั้ง'
}
function dateTime(value: string): string {
  return new Date(value).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'short', timeStyle: 'short' })
}

export default function RetrospectiveExtensionPanel({ contract, installments, isAdmin, onChanged }: {
  contract: Contract
  installments: Installment[]
  isAdmin: boolean
  onChanged: () => Promise<void>
}) {
  const [requests, setRequests] = useState<RetrospectiveExtensionRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [selected, setSelected] = useState<RetrospectiveExtensionRequest | null>(null)
  const [notice, setNotice] = useState('')
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try { setRequests(await getRetrospectiveExtensionRequests(contract.id)) }
    catch (e) { setError(errorMessage(e)) }
    finally { setLoading(false) }
  }, [contract.id])
  useEffect(() => { void load() }, [load])
  return <Card className="mt-6">
    <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="font-bold text-ink">คำขอขยายย้อนหลังตามหลักฐาน</h3>
        <p className="mt-1 text-sm text-ink">ใช้เมื่อมีข้อตกลงเดิมที่ยังไม่ได้บันทึก ต้องให้ผู้ดูแลตรวจตารางและยอดเงินก่อนอนุมัติ</p></div>
      {contract.status === 'active' && <Button variant="ghost" onClick={() => setCreateOpen(true)}>สร้างคำขอขยายย้อนหลัง</Button>}
    </div>
    {notice && <p role="status" className="mb-3 text-sm text-green-800">{notice}</p>}
    {loading ? <Loading /> : error ? <div role="alert" className="text-sm text-red-700">{error} <Button variant="ghost" onClick={() => void load()}>โหลดใหม่</Button></div> : requests.length === 0 ? <p className="text-sm text-ink">ยังไม่มีคำขอ</p> : <div className="space-y-3">
      {requests.map((request) => <div key={request.id} className="rounded-xl border border-peach p-3 text-sm">
        <div className="mb-2 flex flex-wrap items-center gap-2"><Badge tone={request.status === 'approved' ? 'green' : request.status === 'pending' ? 'amber' : 'neutral'}>{statusLabels[request.status]}</Badge><span>{typeLabels[request.input.extType]}</span></div>
        <p>ลูกค้าขอเมื่อ {thaiDate(request.customerRequestedAt.slice(0, 10))} · มีผล {thaiDate(request.effectiveDate)}</p>
        <p>บันทึกจริง {dateTime(request.recordedAt)} โดย {request.recordedByName || '—'}</p>
        <p className="mt-1 whitespace-pre-wrap break-words">เหตุผล: {request.reason}</p>
        <p className="whitespace-pre-wrap break-words">หลักฐานอ้างอิง: {request.evidenceRef}</p>
        {request.approvalReason && <p className="mt-1 whitespace-pre-wrap break-words">ผลพิจารณา: {request.approvalReason}{request.penaltyAdjustmentConfirmed && ' · ยืนยันปรับค่าปรับตามยอดที่แสดง'}{request.approvedAt && <> · เมื่อ {dateTime(request.approvedAt)} โดย {request.approvedByName || '—'}</>}</p>}
        <Button variant="ghost" className="mt-2" onClick={() => setSelected(request)}>{isAdmin && request.status === 'pending' ? 'ตรวจสอบคำขอ' : 'ดูรายละเอียดคำขอ'}</Button>
      </div>)}
    </div>}
    {createOpen && <RetrospectiveRequestModal contract={contract} installments={installments} onClose={() => setCreateOpen(false)} onCreated={async () => {
      setCreateOpen(false); setNotice('บันทึกคำขอแล้ว ยังไม่มีการเปลี่ยนยอดเงินหรือตารางงวด'); await load()
    }} />}
    {selected && <RetrospectiveReviewModal request={selected} customerName={contract.customerName} isAdmin={isAdmin} onClose={() => setSelected(null)} onDone={async () => {
      setSelected(null); setNotice('บันทึกผลการพิจารณาแล้ว'); await load(); await onChanged()
    }} />}
  </Card>
}

interface ScheduleDraft { key: string; existing: boolean; installmentNo: string; dueDate: string; amount: string }
function RetrospectiveRequestModal({ contract, installments, onClose, onCreated }: {
  contract: Contract; installments: Installment[]; onClose: () => void; onCreated: () => Promise<void>
}) {
  const [extType, setExtType] = useState<ExtensionType>('months')
  const [requestedDate, setRequestedDate] = useState('')
  const [effectiveDate, setEffectiveDate] = useState('')
  const [reason, setReason] = useState('')
  const [evidence, setEvidence] = useState('')
  const [evidenceRemaining, setEvidenceRemaining] = useState('')
  const [dueDay, setDueDay] = useState(String(contract.dueDay))
  const [financeAmount, setFinanceAmount] = useState(String(contract.financeAmount))
  const [monthlyPayment, setMonthlyPayment] = useState('')
  const [schedule, setSchedule] = useState<ScheduleDraft[]>(() => installments.filter((row) => !row.paidAt).map((row) => ({ key: row.id, existing: true, installmentNo: String(row.installmentNo), dueDate: row.dueDate, amount: String(row.amount) })))
  const nextKey = useRef(0)
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const valid = !!requestedDate && !!effectiveDate && reason.trim().length >= 10 && evidence.trim().length >= 10 && evidenceRemaining.trim() !== '' && Number.isFinite(Number(evidenceRemaining)) && Number(evidenceRemaining) >= 0 && Number.isInteger(Number(dueDay)) && Number(dueDay) >= 1 && Number(dueDay) <= 31 && financeAmount.trim() !== '' && Number.isFinite(Number(financeAmount)) && Number(financeAmount) > 0 && monthlyPayment.trim() !== '' && Number.isFinite(Number(monthlyPayment)) && Number(monthlyPayment) > 0 && schedule.length > 0 && schedule.every((row) => Number.isInteger(Number(row.installmentNo)) && Number(row.installmentNo) > 0 && row.dueDate && row.amount.trim() !== '' && Number.isFinite(Number(row.amount)) && Number(row.amount) >= 0)
  function updateRow(key: string, field: 'installmentNo' | 'dueDate' | 'amount', value: string) {
    setSchedule((rows) => rows.map((row) => row.key === key ? { ...row, [field]: value } : row))
  }
  async function submit() {
    if (saving.current || !valid) return
    saving.current = true; setBusy(true); setError(null)
    const input: RetrospectiveExtensionInput = {
      extType, customerRequestedAt: requestedDate, effectiveDate, reason: reason.trim(), evidenceRef: evidence.trim(), evidenceRemaining: Number(evidenceRemaining), newDueDay: Number(dueDay), newFinanceAmount: Number(financeAmount), newMonthlyPayment: Number(monthlyPayment),
      schedule: schedule.map((row) => ({ installmentNo: Number(row.installmentNo), dueDate: row.dueDate, amount: Number(row.amount) })),
    }
    try { await createRetrospectiveExtensionRequest(contract.id, input); await onCreated() }
    catch (e) { setError(errorMessage(e)); saving.current = false; setBusy(false) }
  }
  return <Modal accessible size="lg" title="สร้างคำขอขยายย้อนหลัง" closeOnEsc={!busy} onClose={() => { if (!busy) onClose() }}>
    <div className="space-y-4 text-sm text-ink">
      <p className="font-bold">{contract.customerName} · {contract.contractNo}</p>
      <p className="rounded-xl border border-peach bg-peach-light/40 p-3">ขั้นตอนนี้บันทึกคำขอเท่านั้น ยอดเงินและตารางงวดยังไม่เปลี่ยน วันที่บันทึกจริงจะเป็นเวลาที่กดส่งคำขอ</p>
      <Field label="ประเภทข้อตกลง" required><Select disabled={busy} value={extType} onChange={(e) => setExtType(e.target.value as ExtensionType)}>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
      <div className="grid gap-3 sm:grid-cols-2"><Field label="วันที่ลูกค้าขอขยาย" required><Input type="date" disabled={busy} value={requestedDate} onChange={(e) => setRequestedDate(e.target.value)} /></Field><Field label="วันที่ข้อตกลงเริ่มมีผล" required><Input type="date" disabled={busy} value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} /></Field></div>
      <Field label="เหตุผลที่บันทึกย้อนหลัง (อย่างน้อย 10 ตัวอักษร)" required><Textarea disabled={busy} minLength={10} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <Field label="หลักฐานอ้างอิง (อย่างน้อย 10 ตัวอักษร)" required><Textarea disabled={busy} minLength={10} maxLength={2000} value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="ระบุเอกสาร ข้อความสนทนา หรือลิงก์ที่ตรวจสอบข้อตกลงเดิมได้" /></Field>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Field label="ยอดคงเหลือตามหลักฐาน (บาท)" required><Input type="number" min="0" step="0.01" disabled={busy} value={evidenceRemaining} onChange={(e) => setEvidenceRemaining(e.target.value)} /></Field><Field label="ยอดจัดไฟแนนซ์ตามหลักฐาน (บาท)" required><Input type="number" min="0.01" step="0.01" disabled={busy} value={financeAmount} onChange={(e) => setFinanceAmount(e.target.value)} /></Field><Field label="วันชำระทุกเดือน (1–31)" required><Input type="number" min="1" max="31" step="1" disabled={busy} value={dueDay} onChange={(e) => setDueDay(e.target.value)} /></Field><Field label="ค่างวดปกติตามข้อตกลงใหม่ (บาท)" required><Input type="number" min="0.01" step="0.01" disabled={busy} value={monthlyPayment} onChange={(e) => setMonthlyPayment(e.target.value)} /></Field></div>
      <p className="text-xs text-ink">ยอดคงเหลือตามตารางเป็นเงินที่ลูกค้ายังต้องชำระ ส่วนยอดจัดไฟแนนซ์เป็นยอดตามสัญญา ให้กรอกแยกตามหลักฐานใน PJ</p>
      <div><h4 className="font-bold">ตารางงวดใหม่ที่ยังต้องชำระ ({schedule.length} งวด ไม่รวมงวดที่ชำระครบแล้ว)</h4>
        <p className="mb-2 mt-1">เก็บหมายเลขงวดเดิมไว้ครบ แก้วันและยอดแต่ละงวดให้ตรงหลักฐาน งวดปกติต้องตรงค่างวดใหม่ ส่วนงวดสุดท้ายระบุยอดต่างได้ตามหลักฐาน ยอดค่างวดเป็นยอดเต็มก่อนหักเงินที่รับไว้ ระบบจะหักยอดจ่ายเดิมเพียงครั้งเดียว</p>
        <div className="max-h-80 overflow-auto" tabIndex={0} role="region" aria-label="กรอกตารางงวดใหม่"><table className="w-full min-w-[560px]"><thead><tr><th scope="col" className="p-2 text-left">งวดที่</th><th scope="col" className="p-2 text-left">วันครบกำหนด</th><th scope="col" className="p-2 text-left">ค่างวดเต็ม (บาท)</th><th scope="col" className="p-2">จัดการ</th></tr></thead><tbody>{schedule.map((row, index) => <tr key={row.key}><td className="p-1"><Input aria-label={`งวดที่ แถว ${index + 1}`} type="number" min="1" step="1" disabled={busy || row.existing} value={row.installmentNo} onChange={(e) => updateRow(row.key, 'installmentNo', e.target.value)} /></td><td className="p-1"><Input aria-label={`วันครบกำหนด แถว ${index + 1}`} type="date" disabled={busy} value={row.dueDate} onChange={(e) => updateRow(row.key, 'dueDate', e.target.value)} /></td><td className="p-1"><Input aria-label={`ค่างวดเต็ม แถว ${index + 1}`} type="number" min="0" step="0.01" disabled={busy} value={row.amount} onChange={(e) => updateRow(row.key, 'amount', e.target.value)} /></td><td className="p-1"><Button variant="ghost" disabled={busy || row.existing} onClick={() => setSchedule((rows) => rows.filter((item) => item.key !== row.key))} aria-label={`นำแถว ${index + 1} ออกจากคำขอ`}>นำแถวออก</Button></td></tr>)}</tbody></table></div>
        <Button variant="ghost" className="mt-2" disabled={busy} onClick={() => setSchedule((rows) => [...rows, { key: `new-${nextKey.current++}`, existing: false, installmentNo: '', dueDate: '', amount: '' }])}>เพิ่มงวดตามหลักฐาน</Button>
        <p className="mt-2">ผู้ดูแลต้องตรวจทุกงวดและการจับคู่เงินรับเดิมก่อนอนุมัติ หากยอดไม่ตรงหลักฐาน ระบบจะไม่อนุมัติ</p>
      </div>
      {error && <p role="alert" className="text-red-700">{error}</p>}
      <div className="flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={onClose}>ยกเลิก</Button><Button style={primaryStyle} disabled={busy || !valid} onClick={() => void submit()}>{busy ? 'กำลังส่งคำขอ...' : 'ส่งคำขอให้ผู้ดูแลตรวจสอบ'}</Button></div>
    </div>
  </Modal>
}

function SchedulePreview({ title, schedule }: { title: string; schedule: ExtensionSchedulePreview }) {
  return <div className="rounded-xl border border-peach p-3 text-sm text-ink"><h4 className="font-bold">{title}</h4><p>{schedule.termMonths} งวดรวมทั้งสัญญา · ค่างวด {money(schedule.monthlyPayment)} บาท · วันที่ชำระ {schedule.dueDay}</p><div className="mt-2 max-h-80 overflow-auto" tabIndex={0} role="region" aria-label={title}><table className="w-full min-w-[430px]"><thead><tr><th scope="col">งวด</th><th scope="col">ครบกำหนด</th><th scope="col">ค่างวดเต็ม</th><th scope="col">รับแล้ว</th><th scope="col">ชำระครบเมื่อ</th></tr></thead><tbody>{schedule.installments.map((row) => <tr key={row.id}><td className="p-1">{row.installmentNo}</td><td className="p-1">{thaiDate(row.dueDate)}</td><td className="p-1">{money(row.amount)}</td><td className="p-1">{money(row.paidAmount)}</td><td className="p-1">{row.paidAt ? thaiDate(row.paidAt.slice(0, 10)) : 'ยังไม่ครบ'}</td></tr>)}</tbody></table></div></div>
}

function RetrospectiveReviewModal({ request, customerName, isAdmin, onClose, onDone }: {
  request: RetrospectiveExtensionRequest; customerName: string; isAdmin: boolean; onClose: () => void; onDone: () => Promise<void>
}) {
  const [preview, setPreview] = useState<RetrospectiveExtensionPreview | null>(request.status === 'pending' && isAdmin ? null : request.preview)
  const [loading, setLoading] = useState(request.status === 'pending' && isAdmin)
  const [reason, setReason] = useState('')
  const [checked, setChecked] = useState(false)
  const [penaltyChecked, setPenaltyChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (request.status !== 'pending' || !isAdmin) return
    let active = true
    void getRetrospectiveExtensionPreview(request.id).then((value) => { if (active) setPreview(value) }).catch((e: unknown) => { if (active) setError(errorMessage(e)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [request.id, request.status, isAdmin])
  async function decide(approve: boolean) {
    const penaltyChanges = !!preview && preview.penaltyBefore !== preview.penaltyAfter
    if (saving.current || !isAdmin || request.status !== 'pending' || reason.trim().length < 10 || (approve && (!checked || !preview?.canApprove || (penaltyChanges && !penaltyChecked)))) return
    saving.current = true; setBusy(true); setError(null)
    try {
      if (approve) await approveRetrospectiveExtension(request.id, reason.trim(), penaltyChecked)
      else await rejectRetrospectiveExtension(request.id, reason.trim())
      await onDone()
    } catch (e) {
      setError(errorMessage(e)); setChecked(false)
      try { setPreview(await getRetrospectiveExtensionPreview(request.id)) } catch { setPreview(null) }
      saving.current = false; setBusy(false)
    }
  }
  return <Modal accessible size="lg" title={isAdmin && request.status === 'pending' ? 'ตรวจสอบคำขอขยายย้อนหลัง' : 'รายละเอียดคำขอขยายย้อนหลัง'} closeOnEsc={!busy} onClose={() => { if (!busy) onClose() }}>
    <div className="space-y-3 text-sm text-ink"><p className="font-bold">{customerName}</p><Badge tone={request.status === 'approved' ? 'green' : request.status === 'pending' ? 'amber' : 'neutral'}>{statusLabels[request.status]}</Badge>
      <p>วันที่ลูกค้าขอ: {thaiDate(request.customerRequestedAt.slice(0, 10))} · วันที่มีผล: {thaiDate(request.effectiveDate)}</p><p>บันทึกจริง: {dateTime(request.recordedAt)} โดย {request.recordedByName || '—'}</p>
      <p className="whitespace-pre-wrap break-words">เหตุผล: {request.reason}</p><p className="whitespace-pre-wrap break-words">หลักฐานอ้างอิง: {request.evidenceRef}</p>
      {request.approvalReason && <p className="whitespace-pre-wrap break-words">ผลพิจารณา: {request.approvalReason}</p>}
      {loading ? <Loading label="กำลังตรวจข้อมูลล่าสุด..." /> : preview && <>
        <div className="grid gap-3 sm:grid-cols-2"><SchedulePreview title="ตารางก่อนเปลี่ยน" schedule={preview.before} /><SchedulePreview title="ตารางตามคำขอ" schedule={preview.after} /></div>
        <div className="rounded-xl border border-peach bg-peach-light/40 p-3 space-y-1"><p>ยอดจัดไฟแนนซ์: {money(preview.before.financeAmount)} → {money(preview.after.financeAmount)} บาท</p><p>ค่างวดคงเหลือ: {money(preview.remainingBefore)} → {money(preview.remainingAfter)} บาท</p><p>ยอดคงเหลือตามหลักฐาน: {money(preview.evidenceRemaining)} บาท · ส่วนต่างตารางใหม่กับหลักฐาน: {money(preview.difference)} บาท</p><p>ค่าปรับ: {money(preview.penaltyBefore)} → {money(preview.penaltyAfter)} บาท</p><p>เงินที่รับไว้บางส่วน: {money(preview.partialPaid)} บาท</p></div>
      <p>เงินรับเดิมผูกกับงวดหมายเลขเดิม ตรวจช่องรับแล้วทั้งสองตารางให้ครบ หากยอดค่าปรับเปลี่ยน ระบบจะใช้ยอดหลังที่แสดงเมื่ออนุมัติ</p>
        {preview.blockedReasons.length > 0 && <div role="alert" className="rounded-xl border border-peach p-3 text-red-800"><p className="font-bold">ยังอนุมัติไม่ได้</p><ul className="list-disc pl-5">{preview.blockedReasons.map((message, index) => <li key={index}>{message}</li>)}</ul></div>}
      </>}
      {isAdmin && request.status === 'pending' && <><Field label="เหตุผลการพิจารณา (อย่างน้อย 10 ตัวอักษร)" required><Textarea disabled={busy} minLength={10} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} /></Field><label className="flex items-start gap-2"><input type="checkbox" disabled={busy || loading || !preview?.canApprove} checked={checked} onChange={(e) => setChecked(e.target.checked)} /><span>ตรวจหลักฐาน ตารางทุกงวด ยอดเงิน และการจับคู่เงินรับเดิมแล้ว</span></label>{preview && preview.penaltyBefore !== preview.penaltyAfter && <label className="flex items-start gap-2 rounded-xl border border-peach p-3"><input type="checkbox" disabled={busy || loading || !preview.canApprove} checked={penaltyChecked} onChange={(e) => setPenaltyChecked(e.target.checked)} /><span>ยืนยันใช้ค่าปรับหลังอนุมัติ {money(preview.penaltyAfter)} บาท แทนยอดเดิม {money(preview.penaltyBefore)} บาท</span></label>}</>}
      {error && <p role="alert" className="text-red-700">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={onClose}>ปิด</Button>{isAdmin && request.status === 'pending' && <><Button variant="ghost" disabled={busy || reason.trim().length < 10} onClick={() => void decide(false)}>ไม่อนุมัติ</Button><Button style={primaryStyle} disabled={busy || loading || !preview?.canApprove || !checked || reason.trim().length < 10} onClick={() => void decide(true)}>{busy ? 'กำลังบันทึก...' : 'อนุมัติและใช้ตารางนี้'}</Button></>}</div>
    </div>
  </Modal>
}
