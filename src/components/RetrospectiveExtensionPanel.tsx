import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, Card, Field, Input, Loading, Modal, Textarea } from './ui'
import {
  approveRetrospectiveExtension,
  createRetrospectiveExtensionRequest,
  getRetrospectiveExtensionPreview,
  getRetrospectiveExtensionRequests,
  rejectRetrospectiveExtension,
  type ExtensionSchedulePreview,
  type ExtensionType,
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
        <div className="mb-2 flex flex-wrap items-center gap-2"><Badge tone={request.status === 'approved' ? 'green' : request.status === 'pending' ? 'amber' : 'neutral'}>{statusLabels[request.status]}</Badge><span>{request.input.reviewMode === 'admin' ? 'ปรับตารางตามข้อตกลง' : typeLabels[request.input.extType]}</span></div>
        <p>ลูกค้าขอเมื่อ {thaiDate(request.customerRequestedAt.slice(0, 10))}{request.input.reviewMode !== 'admin' && <> · มีผล {thaiDate(request.effectiveDate)}</>}</p>
        <p>บันทึกจริง {dateTime(request.recordedAt)} โดย {request.recordedByName || '—'}</p>
        <p className="mt-1 whitespace-pre-wrap break-words">ข้อตกลง: {request.reason}</p>
        {request.input.reviewMode !== 'admin' && <p className="whitespace-pre-wrap break-words">หลักฐานอ้างอิง: {request.evidenceRef}</p>}
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

interface ScheduleDraft { key: string; existing: boolean; installmentNo: number; dueDate: string; amount: string; paidAmount: number }
function RetrospectiveRequestModal({ contract, installments, onClose, onCreated }: {
  contract: Contract; installments: Installment[]; onClose: () => void; onCreated: () => Promise<void>
}) {
  const [requestedDate, setRequestedDate] = useState('')
  const [agreement, setAgreement] = useState('')
  const [schedule, setSchedule] = useState<ScheduleDraft[]>(() => installments.filter((row) => !row.paidAt)
    .sort((a, b) => a.installmentNo - b.installmentNo)
    .map((row) => ({ key: row.id, existing: true, installmentNo: row.installmentNo, dueDate: row.dueDate, amount: String(row.amount), paidAmount: row.paidAmount })))
  const nextKey = useRef(0)
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
  const valid = !!requestedDate && requestedDate <= today && agreement.trim().length > 0 && schedule.length > 0 && schedule.length <= 120
    && schedule.every((row) => !!row.dueDate && row.amount.trim() !== '' && Number.isFinite(Number(row.amount)) && Number(row.amount) > row.paidAmount)
  function updateRow(key: string, field: 'dueDate' | 'amount', value: string) {
    setSchedule((rows) => rows.map((row) => row.key === key ? { ...row, [field]: value } : row))
  }
  function addRow() {
    const last = schedule[schedule.length - 1]
    const nextNo = last ? last.installmentNo + 1 : Math.max(0, ...installments.map((row) => row.installmentNo)) + 1
    let dueDate = ''
    if (last?.dueDate) {
      const [year, month, day] = last.dueDate.split('-').map(Number)
      const next = new Date(year, month, 1)
      const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()
      dueDate = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`
    }
    setSchedule((rows) => [...rows, { key: `new-${nextKey.current++}`, existing: false, installmentNo: nextNo, dueDate, amount: last?.amount || String(contract.monthlyPayment), paidAmount: 0 }])
  }
  async function submit() {
    if (saving.current || !valid) return
    saving.current = true; setBusy(true); setError(null)
    try {
      await createRetrospectiveExtensionRequest(contract.id, {
        reviewMode: 'admin', reason: agreement.trim(), customerRequestedAt: requestedDate,
        schedule: schedule.map((row) => ({ installmentNo: row.installmentNo, dueDate: row.dueDate, amount: Number(row.amount) })),
      })
      await onCreated()
    } catch (e) { setError(errorMessage(e)); saving.current = false; setBusy(false) }
  }
  return <Modal accessible size="lg" title="ยื่นคำขอขยายย้อนหลัง" closeOnEsc={!busy} onClose={() => { if (!busy) onClose() }}>
    <div className="space-y-4 text-sm text-ink">
      <p className="font-bold">{contract.customerName} · {contract.contractNo}</p>
      <p className="rounded-xl border border-peach bg-peach-light/40 p-3">ระบุข้อตกลง วันที่ลูกค้าขอขยาย และปรับตารางใหม่ แล้วส่งให้แอดมินตรวจสอบ</p>
      <Field label="ข้อตกลงกับลูกค้า" required><Textarea disabled={busy} maxLength={2000} value={agreement} onChange={(e) => setAgreement(e.target.value)} placeholder="เช่น ลูกค้าขอเปลี่ยนมาชำระทุกวันที่ 5 เริ่มตั้งแต่งวดที่ 6" /></Field>
      <Field label="วันที่ลูกค้าขอขยาย" required><Input type="date" max={today} disabled={busy} value={requestedDate} onChange={(e) => setRequestedDate(e.target.value)} /><span className="mt-1 block text-xs">วันที่พนักงานยื่นคำขอจะบันทึกให้อัตโนมัติ</span></Field>
      <div><h4 className="font-bold">ปรับตารางใหม่ ({schedule.length} งวด)</h4><p className="my-2 text-xs">แก้วันครบกำหนดและค่างวดเต็มตามข้อตกลง เงินที่รับแล้วจะแสดงไว้ให้ตรวจสอบ</p>
        <div className="max-h-80 overflow-auto" tabIndex={0} role="region" aria-label="ปรับตารางงวดใหม่"><table className="w-full min-w-[580px]"><thead><tr><th scope="col" className="p-2 text-left">งวด</th><th scope="col" className="p-2 text-left">ครบกำหนดใหม่</th><th scope="col" className="p-2 text-left">ค่างวดเต็ม (บาท)</th><th scope="col" className="p-2 text-left">รับแล้ว</th><th scope="col" className="p-2">จัดการ</th></tr></thead><tbody>{schedule.map((row, index) => <tr key={row.key}>
          <td className="p-1">{row.installmentNo}</td>
          <td className="p-1"><Input aria-label={`ครบกำหนดใหม่งวด ${row.installmentNo}`} type="date" disabled={busy} value={row.dueDate} onChange={(e) => updateRow(row.key, 'dueDate', e.target.value)} /></td>
          <td className="p-1"><Input aria-label={`ค่างวดเต็มงวด ${row.installmentNo}`} type="number" min={row.paidAmount + 0.01} step="0.01" disabled={busy} value={row.amount} onChange={(e) => updateRow(row.key, 'amount', e.target.value)} /></td>
          <td className="p-1">{money(row.paidAmount)}</td>
          <td className="p-1">{!row.existing && index === schedule.length - 1 && <Button variant="ghost" disabled={busy} aria-label={`นำงวด ${row.installmentNo} ออก`} onClick={() => setSchedule((rows) => rows.slice(0, -1))}>นำออก</Button>}</td>
        </tr>)}</tbody></table></div>
        <Button variant="ghost" className="mt-2" disabled={busy || schedule.length >= 120} onClick={addRow}>เพิ่มงวด</Button>
      </div>
      <p className="text-xs">แอดมินจะตรวจข้อตกลง ตาราง และยอดเงินก่อนอนุมัติ การยื่นคำขอยังไม่เปลี่ยนสัญญาจริง</p>
      {error && <p role="alert" className="text-red-700">{error}</p>}
      <div className="flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={onClose}>ยกเลิก</Button><Button style={primaryStyle} disabled={busy || !valid} onClick={() => void submit()}>{busy ? 'กำลังยื่นคำขอ...' : 'ยื่นคำขอให้แอดมินตรวจ'}</Button></div>
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
      <p>วันที่ลูกค้าขอ: {thaiDate(request.customerRequestedAt.slice(0, 10))}{request.input.reviewMode !== 'admin' && <> · วันที่มีผล: {thaiDate(request.effectiveDate)}</>}</p><p>บันทึกจริง: {dateTime(request.recordedAt)} โดย {request.recordedByName || '—'}</p>
      <p className="whitespace-pre-wrap break-words">ข้อตกลง: {request.reason}</p>{request.input.reviewMode !== 'admin' && <p className="whitespace-pre-wrap break-words">หลักฐานอ้างอิง: {request.evidenceRef}</p>}
      {request.approvalReason && <p className="whitespace-pre-wrap break-words">ผลพิจารณา: {request.approvalReason}</p>}
      {loading ? <Loading label="กำลังตรวจข้อมูลล่าสุด..." /> : preview && <>
        <div className="grid gap-3 sm:grid-cols-2"><SchedulePreview title="ตารางก่อนเปลี่ยน" schedule={preview.before} /><SchedulePreview title="ตารางตามคำขอ" schedule={preview.after} /></div>
        <div className="rounded-xl border border-peach bg-peach-light/40 p-3 space-y-1"><p>ยอดจัดไฟแนนซ์: {money(preview.before.financeAmount)} → {money(preview.after.financeAmount)} บาท</p><p>ค่างวดคงเหลือปัจจุบัน: {money(preview.remainingBefore)} → {money(preview.remainingAfter)} บาท</p>{preview.requiresAdminEvidenceCheck ? <p className="font-bold text-amber-900">ยอดที่แสดงคำนวณจากตารางคำขอ แอดมินต้องตรวจข้อตกลงและ PJ เองก่อนอนุมัติ</p> : preview.historicalRemainingAfter !== undefined ? <p>ยอดตามตาราง ณ วันที่มีผล: {money(preview.historicalRemainingAfter)} บาท · รับหลังวันมีผล {money(preview.netPaidAfterEffectiveDate ?? 0)} บาท · หลักฐาน PJ {money(preview.evidenceRemaining ?? 0)} บาท · ส่วนต่าง {money(preview.difference ?? 0)} บาท</p> : <p>ยอดคงเหลือตามหลักฐาน: {money(preview.evidenceRemaining ?? 0)} บาท · ส่วนต่าง {money(preview.difference ?? 0)} บาท</p>}<p>ค่าปรับ: {money(preview.penaltyBefore)} → {money(preview.penaltyAfter)} บาท</p><p>เงินที่รับไว้บางส่วน: {money(preview.partialPaid)} บาท</p></div>{preview.dataChangedSinceSubmission && <div role="status" className="rounded-xl border border-peach p-3 text-amber-900">มีข้อมูลสัญญาหรือยอดรับชำระเปลี่ยนหลังส่งคำขอ ระบบคำนวณจากข้อมูลล่าสุดแล้ว กรุณาตรวจตาราง ยอด และหลักฐาน PJ อีกครั้งก่อนพิจารณา</div>}
      <p>เงินรับเดิมผูกกับงวดหมายเลขเดิม ตรวจช่องรับแล้วทั้งสองตารางให้ครบ หากยอดค่าปรับเปลี่ยน ระบบจะใช้ยอดหลังที่แสดงเมื่ออนุมัติ</p>
        {preview.blockedReasons.length > 0 && <div role="alert" className="rounded-xl border border-peach p-3 text-red-800"><p className="font-bold">ยังอนุมัติไม่ได้</p><ul className="list-disc pl-5">{preview.blockedReasons.map((message, index) => <li key={index}>{message}</li>)}</ul></div>}
      </>}
      {isAdmin && request.status === 'pending' && <><Field label="เหตุผลการพิจารณา (อย่างน้อย 10 ตัวอักษร)" required><Textarea disabled={busy} minLength={10} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} /></Field><label className="flex items-start gap-2"><input type="checkbox" disabled={busy || loading || !preview?.canApprove} checked={checked} onChange={(e) => setChecked(e.target.checked)} /><span>ตรวจหลักฐาน ตารางทุกงวด ยอดเงิน และการจับคู่เงินรับเดิมแล้ว</span></label>{preview && preview.penaltyBefore !== preview.penaltyAfter && <label className="flex items-start gap-2 rounded-xl border border-peach p-3"><input type="checkbox" disabled={busy || loading || !preview.canApprove} checked={penaltyChecked} onChange={(e) => setPenaltyChecked(e.target.checked)} /><span>ยืนยันใช้ค่าปรับหลังอนุมัติ {money(preview.penaltyAfter)} บาท แทนยอดเดิม {money(preview.penaltyBefore)} บาท</span></label>}</>}
      {error && <p role="alert" className="text-red-700">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={onClose}>ปิด</Button>{isAdmin && request.status === 'pending' && <><Button variant="ghost" disabled={busy || reason.trim().length < 10} onClick={() => void decide(false)}>ไม่อนุมัติ</Button><Button style={primaryStyle} disabled={busy || loading || !preview?.canApprove || !checked || reason.trim().length < 10} onClick={() => void decide(true)}>{busy ? 'กำลังบันทึก...' : 'อนุมัติและใช้ตารางนี้'}</Button></>}</div>
    </div>
  </Modal>
}
