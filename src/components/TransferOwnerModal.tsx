// TransferOwnerModal — "เปลี่ยนผู้ผ่อน" (feature ใหม่ 2026-09-14, owner-approved brief transfer-owner-brief.md)
// สัญญาเดิม (ไม่สร้างสัญญาใหม่) เปลี่ยนแค่ชื่อผู้ผ่อน — ยอดค้าง/ค่าปรับ/ตารางงวดไม่เปลี่ยน
// 3 ขั้น: (1) ข้อมูลผู้ผ่อนใหม่ + ที่อยู่ (2) เอกสาร (3) ยืนยัน → ถ้ากรอก INV ใหม่ไว้ เปิดส่วนผูกเลข INV ต่อทันที
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Badge, Button, Field, Input, Modal, Select } from './ui'
import { AddressFields } from './AddressFields'
import TransferDocSlots, { type TransferDocsEvaluation } from './TransferDocSlots'
import TransferInvoiceCutover from './TransferInvoiceCutover'
import { baht, maskNationalId } from '../lib/format'
import { getOptions, transferContractOwner } from '../lib/db'
import type { CustomerAddress } from '../lib/letters'
import {
  nextTransferNo,
  normalizeInvNo,
  transferDebtWarning,
  validateTransferInput,
  type ContractTransfer,
  type TransferAddresses,
  type TransferNewPerson,
} from '../lib/contractTransfer'
import type { Contract } from '../lib/types'

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}

const num = (s: string) => Number(s) || 0

type AddrKey = 'current' | 'id_card' | 'work'
const ADDR_KEYS: { key: AddrKey; title: string }[] = [
  { key: 'current', title: 'ที่อยู่ปัจจุบัน' },
  { key: 'id_card', title: 'ที่อยู่ตามบัตรประชาชน' },
  { key: 'work', title: 'ที่อยู่ที่ทำงาน' },
]

const EMPTY_PERSON: TransferNewPerson = {
  customerName: '',
  nationalId: '',
  phone: '',
  phoneAlt1: '',
  phoneAlt2: '',
  facebookLink: '',
  birthYear: null,
  occupation: '',
  occupationProof: '',
}

type Step = 1 | 2 | 3

export default function TransferOwnerModal({
  contract,
  history,
  overdueAmount,
  penaltyDue,
  isAdmin,
  onClose,
  onDone,
  onSuccess,
}: {
  contract: Contract
  history: ContractTransfer[]
  overdueAmount: number
  penaltyDue: number
  isAdmin: boolean
  onClose: () => void
  /** เรียกหลังเปลี่ยนผู้ผ่อนสำเร็จ (หรือหลังผูกเลข INV สำเร็จ) — ให้หน้าเรียก reload ข้อมูล */
  onDone: () => void
  /** เรียกครั้งเดียวทันทีที่เปลี่ยนผู้ผ่อนสำเร็จ — ให้หน้าโชว์ข้อความแจ้งเตือนค้างไว้ (โมดัลอาจปิดไปแล้ว) */
  onSuccess: (message: string) => void
}) {
  const transferNo = useMemo(() => nextTransferNo(history), [history])
  const debtWarning = transferDebtWarning(overdueAmount, penaltyDue)

  const [step, setStep] = useState<Step>(1)

  // ===== ขั้น 1: ข้อมูลผู้ผ่อนใหม่ =====
  const [person, setPerson] = useState<TransferNewPerson>(EMPTY_PERSON)
  const [birthYearStr, setBirthYearStr] = useState('')
  const [addr, setAddr] = useState<Record<AddrKey, CustomerAddress>>({ current: {}, id_card: {}, work: {} })
  const [newInvNoInput, setNewInvNoInput] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [occupations, setOccupations] = useState<{ id: string; label: string }[]>([])
  const [proofs, setProofs] = useState<{ id: string; label: string }[]>([])

  const setField = <K extends keyof TransferNewPerson>(key: K, value: TransferNewPerson[K]) => {
    setPerson((prev) => ({ ...prev, [key]: value }))
    if (errors[key]) setErrors((prev) => { const n = { ...prev }; delete n[key]; return n })
  }
  const setAddrField = (k: AddrKey, field: keyof CustomerAddress, v: string) =>
    setAddr((p) => ({ ...p, [k]: { ...p[k], [field]: v } }))
  const copyFromCurrent = (k: AddrKey) => setAddr((p) => ({ ...p, [k]: { ...p.current } }))

  useEffect(() => {
    let cancelled = false
    Promise.all([getOptions('occupation'), getOptions('occupation_proof')])
      .then(([occ, prf]) => {
        if (cancelled) return
        setOccupations(occ)
        setProofs(prf)
        setPerson((prev) => ({
          ...prev,
          occupation: prev.occupation || occ[0]?.label || '',
          occupationProof: prev.occupationProof || prf[0]?.label || '',
        }))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  function goStep2() {
    const addresses: TransferAddresses = { current: addr.current, id_card: addr.id_card, work: addr.work }
    const check = validateTransferInput(person, addresses, contract.nationalId)
    if (!check.ok) {
      setErrors(check.errors)
      return
    }
    setErrors({})
    setStep(2)
  }

  // ===== ขั้น 2: เอกสาร =====
  const [docsEval, setDocsEval] = useState<TransferDocsEvaluation | null>(null)
  const docsComplete = docsEval?.complete ?? false

  // ===== ขั้น 3: ยืนยัน =====
  const [submitting, setSubmitting] = useState(false)
  const [submitErr, setSubmitErr] = useState<string | null>(null)
  const [phase, setPhase] = useState<'form' | 'done'>('form')
  const [doneTransferId, setDoneTransferId] = useState<string | null>(null)
  const [doneToast, setDoneToast] = useState<string | null>(null)

  async function handleConfirm() {
    setSubmitting(true)
    setSubmitErr(null)
    try {
      const addresses: TransferAddresses = { current: addr.current, id_card: addr.id_card, work: addr.work }
      const invNo = normalizeInvNo(newInvNoInput)
      const res = await transferContractOwner(contract.id, person, addresses, invNo || null)
      const msg = 'เปลี่ยนผู้ผ่อนสำเร็จ · โปรดลงค่าธรรมเนียมปรับโครงสร้าง 500 บาทที่กล่องรายได้อื่นๆ'
      setDoneToast(msg)
      onSuccess(msg)
      if (invNo) {
        setDoneTransferId(res.transferId)
        setPhase('done')
      } else {
        onDone()
        onClose()
      }
    } catch (e) {
      setSubmitErr(errMsg(e))
    } finally {
      setSubmitting(false)
    }
  }

  // ===== หลังยืนยันสำเร็จ + มี INV ใหม่ให้ผูกต่อทันที =====
  if (phase === 'done' && doneTransferId) {
    return (
      <Modal title={`เปลี่ยนผู้ผ่อน — สัญญา ${contract.contractNo}`} onClose={() => { onDone(); onClose() }} size="lg">
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-green-200 bg-green-50 px-3 py-2.5 text-sm text-green-800">
            <p className="flex items-center gap-1.5 font-semibold">
              <CheckCircle2 size={15} /> {doneToast}
            </p>
          </div>
          <div>
            <p className="mb-2 text-sm font-semibold text-ink">ผูกเลข INV ใหม่</p>
            <TransferInvoiceCutover
              contractId={contract.id}
              transferId={doneTransferId}
              isAdmin={isAdmin}
              initialInvNo={newInvNoInput}
              onDone={onDone}
            />
          </div>
          <div className="flex justify-end">
            <Button onClick={() => { onDone(); onClose() }}>เสร็จสิ้น</Button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title={`เปลี่ยนผู้ผ่อน — สัญญา ${contract.contractNo}`} onClose={() => !submitting && onClose()} size="lg">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-soft">
          ใช้สัญญาเดิม ยอดค้าง/ค่าปรับ/ตารางงวดไม่เปลี่ยน โอนเป็นชื่อผู้ผ่อนคนใหม่เท่านั้น
        </p>

        {/* stepper */}
        <div className="flex items-center gap-2 text-xs font-semibold text-ink-soft">
          {(['ข้อมูลผู้ผ่อนใหม่', 'เอกสาร', 'ยืนยัน'] as const).map((label, i) => {
            const n = (i + 1) as Step
            return (
              <div key={label} className="flex items-center gap-2">
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full ${
                    step === n ? 'bg-salmon-deep text-white' : step > n ? 'bg-green-100 text-green-700' : 'bg-peach-soft text-ink-soft'
                  }`}
                >
                  {n}
                </span>
                <span className={step === n ? 'text-ink' : ''}>{label}</span>
                {n < 3 && <span className="text-ink-soft">›</span>}
              </div>
            )
          })}
        </div>

        {debtWarning && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
            <p className="flex items-start gap-1.5">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {debtWarning}
            </p>
          </div>
        )}

        {/* ===== ขั้น 1 ===== */}
        {step === 1 && (
          <div className="flex flex-col gap-4">
            <div>
              <h3 className="mb-2 font-semibold text-ink">ข้อมูลผู้ผ่อนคนใหม่</h3>
              <div className="grid grid-cols-2 gap-3">
                <Field label="ชื่อลูกค้า" required>
                  <Input value={person.customerName} onChange={(e) => setField('customerName', e.target.value)} />
                  {errors.customerName && <p className="mt-1 text-xs text-red-600">{errors.customerName}</p>}
                </Field>
                <Field label="เลขบัตรประชาชน" required>
                  <Input
                    value={person.nationalId}
                    onChange={(e) => setField('nationalId', e.target.value)}
                    placeholder="เลขบัตร 13 หลัก"
                  />
                  {errors.nationalId && <p className="mt-1 text-xs text-red-600">{errors.nationalId}</p>}
                </Field>
                <Field label="เบอร์โทรลูกค้า" required>
                  <Input value={person.phone} onChange={(e) => setField('phone', e.target.value)} />
                  {errors.phone && <p className="mt-1 text-xs text-red-600">{errors.phone}</p>}
                </Field>
                <Field label="โทรศัพท์สำรอง 1" required>
                  <Input value={person.phoneAlt1} onChange={(e) => setField('phoneAlt1', e.target.value)} />
                  {errors.phoneAlt1 && <p className="mt-1 text-xs text-red-600">{errors.phoneAlt1}</p>}
                </Field>
                <Field label="โทรศัพท์สำรอง 2" required>
                  <Input value={person.phoneAlt2} onChange={(e) => setField('phoneAlt2', e.target.value)} />
                  {errors.phoneAlt2 && <p className="mt-1 text-xs text-red-600">{errors.phoneAlt2}</p>}
                </Field>
                <Field label="ลิงค์เฟสลูกค้า" required>
                  <Input value={person.facebookLink} onChange={(e) => setField('facebookLink', e.target.value)} />
                  {errors.facebookLink && <p className="mt-1 text-xs text-red-600">{errors.facebookLink}</p>}
                </Field>
                <Field label="ปีเกิด (ค.ศ.)" required>
                  <Input
                    type="number"
                    value={birthYearStr}
                    onChange={(e) => {
                      setBirthYearStr(e.target.value)
                      setField('birthYear', e.target.value.trim() ? num(e.target.value) : null)
                    }}
                    placeholder="1998"
                  />
                  {errors.birthYear && <p className="mt-1 text-xs text-red-600">{errors.birthYear}</p>}
                </Field>
                <Field label="อาชีพ" required>
                  <Select value={person.occupation} onChange={(e) => setField('occupation', e.target.value)}>
                    {occupations.map((o) => (
                      <option key={o.id} value={o.label}>{o.label}</option>
                    ))}
                  </Select>
                  {errors.occupation && <p className="mt-1 text-xs text-red-600">{errors.occupation}</p>}
                </Field>
                <Field label="หลักฐานอาชีพ" required>
                  <Select value={person.occupationProof} onChange={(e) => setField('occupationProof', e.target.value)}>
                    {proofs.map((o) => (
                      <option key={o.id} value={o.label}>{o.label}</option>
                    ))}
                  </Select>
                  {errors.occupationProof && <p className="mt-1 text-xs text-red-600">{errors.occupationProof}</p>}
                </Field>
                <Field label="เลข INV ใหม่">
                  <Input value={newInvNoInput} onChange={(e) => setNewInvNoInput(e.target.value)} placeholder="ไม่บังคับ" />
                  <p className="mt-1 text-xs text-ink-soft">ถ้าร้านเปิดใบใหม่ใน PJ แล้ว</p>
                </Field>
              </div>
            </div>

            <div>
              <h3 className="mb-1 font-semibold text-ink">ที่อยู่ผู้ผ่อนคนใหม่</h3>
              <p className="mb-2 text-xs text-red-600">
                {errors.currentAddress || errors.idCardAddress || errors.workAddress || ''}
              </p>
              <div className="grid gap-4 lg:grid-cols-3">
                {ADDR_KEYS.map(({ key, title }) => (
                  <AddressFields
                    key={key}
                    title={title}
                    value={addr[key]}
                    onChange={(field, v) => setAddrField(key, field, v)}
                    onCopy={key === 'current' ? undefined : () => copyFromCurrent(key)}
                  />
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
              <Button onClick={goStep2}>ถัดไป</Button>
            </div>
          </div>
        )}

        {/* ===== ขั้น 2 ===== */}
        {step === 2 && (
          <div className="flex flex-col gap-4">
            <TransferDocSlots contractId={contract.id} transferNo={transferNo} onEvaluationChange={setDocsEval} />
            {!docsComplete && docsEval && (
              <p className="text-sm text-amber-700">{`ยังยืนยันไม่ได้ ขาด: ${docsEval.missing.join(', ')}`}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setStep(1)}>ย้อนกลับ</Button>
              <Button onClick={() => setStep(3)} disabled={!docsComplete}>ถัดไป</Button>
            </div>
          </div>
        )}

        {/* ===== ขั้น 3 ===== */}
        {step === 3 && (
          <div className="flex flex-col gap-4">
            <div className="rounded-xl border border-peach bg-white p-4 text-sm">
              <p className="mb-2 font-semibold text-ink">สรุปก่อนยืนยัน</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-ink-soft">ผู้ผ่อนเดิม</p>
                  <p className="font-medium text-ink">{contract.customerName}</p>
                  <p className="text-xs text-ink-soft">{maskNationalId(contract.nationalId)}</p>
                </div>
                <div>
                  <p className="text-xs text-ink-soft">ผู้ผ่อนใหม่</p>
                  <p className="font-medium text-ink">{person.customerName}</p>
                  <p className="text-xs text-ink-soft">{maskNationalId(person.nationalId)}</p>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-1.5 border-t border-peach pt-3">
                <Badge tone="green">เอกสารครบ ✓</Badge>
                {newInvNoInput.trim() && <Badge tone="neutral">{`เลข INV ใหม่: ${normalizeInvNo(newInvNoInput)}`}</Badge>}
              </div>
              {(overdueAmount > 0 || penaltyDue > 0) && (
                <p className="mt-2 text-xs text-ink-soft">
                  ยอดค้าง {baht(overdueAmount)} ฿ · ค่าปรับค้าง {baht(penaltyDue)} ฿ — จะเป็นภาระผู้ผ่อนใหม่ทันที
                </p>
              )}
            </div>

            {submitErr && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">{submitErr}</div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={submitting} onClick={() => setStep(2)}>ย้อนกลับ</Button>
              <Button onClick={() => void handleConfirm()} disabled={submitting}>
                {submitting ? 'กำลังบันทึก...' : 'ยืนยันเปลี่ยนผู้ผ่อน'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
