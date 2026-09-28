import { useId, useMemo, useState } from 'react'
import {
  creditCheck,
  type AttachedFileKind,
  type CreditCheckInput,
  type CreditCheckLevel,
  type CustomerType,
  type DeviceCondition,
  type OccupationType,
} from '../lib/creditCheck'
import {
  ApiError,
  putToSignedUrl,
  signUploads,
  submitCreditCheck,
  type FileToSign,
  type SubmitFormInput,
  type SubmitResult,
  type SubmittedFile,
} from './api'
import { CONSENT_TEXT } from './consent'
import FileUploader, { type AttachedFile } from './FileUploader'
import { MAX_FILES_PER_SUBMIT } from './fileHelpers'
import { Button, Card, Field, Input, Pill, Select } from './ui'

const CUSTOMER_TYPE_OPTIONS: Array<{ value: CustomerType; label: string }> = [
  { value: 'thai', label: 'คนไทย' },
  { value: 'foreign', label: 'ต่างชาติ (ลาว/พม่า)' },
]

const OCCUPATION_OPTIONS: Array<{ value: OccupationType; label: string }> = [
  { value: 'salaried', label: 'อาชีพประจำ (พนักงาน)' },
  { value: 'freelancer', label: 'อาชีพอิสระ' },
  { value: 'government', label: 'ข้าราชการ' },
  { value: 'business_owner', label: 'เจ้าของกิจการ' },
]

const DEVICE_CONDITION_OPTIONS: Array<{ value: DeviceCondition; label: string }> = [
  { value: 'iphone_new', label: 'ไอโฟนมือ 1' },
  { value: 'iphone_used', label: 'ไอโฟนมือ 2' },
  { value: 'ipad', label: 'ไอแพด' },
]

const PREVIEW_DISPLAY: Record<CreditCheckLevel, { emoji: string; text: string; tone: 'bad' | 'warn' | 'ok' }> = {
  fail: { emoji: '❌', text: 'ไม่ผ่านเบื้องต้น', tone: 'bad' },
  review: { emoji: '🟡', text: 'รอทีมพิจารณา', tone: 'warn' },
  prelim_pass: { emoji: '🟢', text: 'ผ่านเบื้องต้น — รอทีมยืนยัน', tone: 'ok' },
}

const ENGINE_FILE_KINDS: readonly AttachedFileKind[] = ['payslip', 'statement', 'work_photo', 'other']

function toEngineFileKinds(files: AttachedFile[]): AttachedFileKind[] {
  const set = new Set<AttachedFileKind>()
  for (const f of files) {
    if ((ENGINE_FILE_KINDS as readonly string[]).includes(f.kind)) set.add(f.kind as AttachedFileKind)
  }
  return Array.from(set)
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

interface FormState {
  customerName: string
  customerType: CustomerType
  idNumber: string
  idExpiryDate: string
  idIssueDate: string
  birthDate: string
  occupationType: OccupationType
  deviceCondition: DeviceCondition
  devicePrice: string
  downPercent: string
  termMonths: string
  ourMonthlyPayment: string
  pjMonthlyPayment: string
  declaredMonthlyIncome: string
  facebookUrl: string
  imei: string
}

const INITIAL_FORM: FormState = {
  customerName: '',
  customerType: 'thai',
  idNumber: '',
  idExpiryDate: '',
  idIssueDate: '',
  birthDate: '',
  occupationType: 'salaried',
  deviceCondition: 'iphone_new',
  devicePrice: '',
  downPercent: '',
  termMonths: '',
  ourMonthlyPayment: '',
  pjMonthlyPayment: '',
  declaredMonthlyIncome: '',
  facebookUrl: '',
  imei: '',
}

/** IMEI ไม่บังคับ — กรอกแล้วต้องเป็นตัวเลข 15 หลักพอดี (ค้นบัญชีดำ PJ เพิ่มจากเลขบัตร, Wave 3 2026-09-28) */
function imeiError(imei: string): string | undefined {
  const trimmed = imei.trim()
  if (trimmed === '') return undefined
  return /^\d{15}$/.test(trimmed) ? undefined : 'IMEI ต้องเป็นตัวเลข 15 หลัก'
}

/** บัตรออกมาไม่ถึง 180 วัน (มาตรวัดเดียวกับ engine rule CARD_RECENTLY_ISSUED) — ใช้ไฮไลต์ช่องแนบรูปประวัติเปลี่ยนชื่อ ThaID
 *  เทียบแบบวันที่ล้วน (ไม่ยุ่งเวลา/timezone) ผ่าน Date ธรรมดา ก็พอสำหรับ hint ฝั่ง client (server ตัดสินจริงอีกที) */
function isRecentlyIssued(idIssueDate: string, todayIsoStr: string): boolean {
  if (!idIssueDate) return false
  const issued = new Date(idIssueDate + 'T00:00:00Z').getTime()
  const today = new Date(todayIsoStr + 'T00:00:00Z').getTime()
  if (Number.isNaN(issued) || Number.isNaN(today)) return false
  const diffDays = (today - issued) / (1000 * 60 * 60 * 24)
  return diffDays >= 0 && diffDays < 180
}

function buildEngineInput(form: FormState, attachedFileKinds: AttachedFileKind[]): CreditCheckInput | null {
  const requiredText = [
    form.customerName,
    form.idNumber,
    form.birthDate,
    form.devicePrice,
    form.downPercent,
    form.termMonths,
    form.ourMonthlyPayment,
    form.pjMonthlyPayment,
  ]
  // วันออกบัตร: บังคับเฉพาะบัตรประชาชนไทย (ต่างชาติ/เอกสารอื่นไม่บังคับ ตาม contract "required-ish")
  if (form.customerType === 'thai') requiredText.push(form.idIssueDate)
  if (requiredText.some((v) => v.trim() === '')) return null

  const devicePrice = Number(form.devicePrice)
  const downPercent = Number(form.downPercent)
  const termMonths = Number(form.termMonths)
  const ourMonthlyPayment = Number(form.ourMonthlyPayment)
  const pjMonthlyPayment = Number(form.pjMonthlyPayment)
  if (![devicePrice, downPercent, termMonths, ourMonthlyPayment, pjMonthlyPayment].every(Number.isFinite)) return null

  const incomeTrim = form.declaredMonthlyIncome.trim()
  const parsedIncome = incomeTrim === '' ? null : Number(incomeTrim)
  const declaredMonthlyIncome = parsedIncome !== null && Number.isFinite(parsedIncome) ? parsedIncome : null

  return {
    today: todayIso(),
    customerType: form.customerType,
    idNumber: form.idNumber.trim(),
    idExpiryDate: form.idExpiryDate || null,
    idIssueDate: form.idIssueDate || undefined,
    birthDate: form.birthDate,
    occupationType: form.occupationType,
    deviceCondition: form.deviceCondition,
    devicePrice,
    downPercent,
    termMonths,
    ourMonthlyPayment,
    pjMonthlyPayment,
    declaredMonthlyIncome,
    attachedFileKinds,
    facebookUrl: form.facebookUrl.trim(),
  }
}

function toSubmitForm(input: CreditCheckInput, customerName: string, imei: string): SubmitFormInput {
  const trimmedImei = imei.trim()
  return {
    customerName,
    customerType: input.customerType,
    idNumber: input.idNumber,
    idExpiryDate: input.idExpiryDate,
    idIssueDate: input.idIssueDate ?? null,
    birthDate: input.birthDate,
    occupationType: input.occupationType,
    deviceCondition: input.deviceCondition,
    devicePrice: input.devicePrice,
    downPercent: input.downPercent,
    termMonths: input.termMonths,
    ourMonthlyPayment: input.ourMonthlyPayment,
    pjMonthlyPayment: input.pjMonthlyPayment,
    declaredMonthlyIncome: input.declaredMonthlyIncome,
    attachedFileKinds: input.attachedFileKinds,
    facebookUrl: input.facebookUrl,
    imei: trimmedImei === '' ? null : trimmedImei,
  }
}

/** หัวข้อการ์ดแบบมีเลขลำดับ (ล้อ .sec-head.num ของคู่มือร้านค้า) */
function SectionHead({ no, title }: { no: string; title: string }) {
  return (
    <div className="wsc-sec-head mb-3">
      <span className="wsc-sec-no">{no}</span>
      <h3 className="wsc-h3" style={{ marginTop: 4 }}>
        {title}
      </h3>
    </div>
  )
}

export default function FormScreen({
  token,
  onSubmitted,
  onSessionExpired,
}: {
  token: string
  onSubmitted: (result: SubmitResult) => void
  onSessionExpired: (notice: string) => void
}) {
  const [form, setForm] = useState<FormState>(INITIAL_FORM)
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [consentChecked, setConsentChecked] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [stage, setStage] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const consentId = useId()
  const consentTextId = useId()
  const submitErrorId = useId()

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function addFile(f: AttachedFile) {
    setAttachedFiles((prev) => (prev.length >= MAX_FILES_PER_SUBMIT ? prev : [...prev, f]))
  }
  function removeFile(id: string) {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== id))
  }
  function filesOfKind(kind: AttachedFile['kind']) {
    return attachedFiles.filter((f) => f.kind === kind)
  }

  const engineFileKinds = useMemo(() => toEngineFileKinds(attachedFiles), [attachedFiles])
  const engineInput = useMemo(() => buildEngineInput(form, engineFileKinds), [form, engineFileKinds])
  const preview = useMemo(() => (engineInput ? creditCheck(engineInput) : null), [engineInput])

  const showWorkEvidenceCallout = form.occupationType === 'freelancer' || form.occupationType === 'business_owner'
  const atFileLimit = attachedFiles.length >= MAX_FILES_PER_SUBMIT
  const imeiErrorText = useMemo(() => imeiError(form.imei), [form.imei])
  const recentlyIssuedCard = useMemo(() => isRecentlyIssued(form.idIssueDate, todayIso()), [form.idIssueDate])

  async function handleSubmit() {
    setSubmitError(null)

    if (!engineInput) {
      setSubmitError('กรุณากรอกข้อมูลที่มี * ให้ครบก่อนส่งคำขอ')
      return
    }
    if (imeiErrorText) {
      setSubmitError(imeiErrorText)
      return
    }
    if (!consentChecked) {
      setSubmitError('กรุณายืนยันความยินยอมก่อนส่งคำขอ')
      return
    }

    setSubmitting(true)
    try {
      let submittedFiles: SubmittedFile[] = []
      if (attachedFiles.length > 0) {
        setStage('กำลังเตรียมไฟล์แนบ...')
        const toSign: FileToSign[] = attachedFiles.map((f) => ({ kind: f.kind, mime: f.mime, size: f.size, sha256: f.sha256 }))
        const signed = await signUploads(token, toSign)
        for (let i = 0; i < attachedFiles.length; i++) {
          setStage(`กำลังอัปโหลดไฟล์ ${i + 1}/${attachedFiles.length}...`)
          await putToSignedUrl(signed[i].uploadUrl, attachedFiles[i].blob, attachedFiles[i].mime)
        }
        submittedFiles = attachedFiles.map((f, i) => ({
          kind: f.kind,
          r2Key: signed[i].r2Key,
          mime: f.mime,
          size: f.size,
          sha256: f.sha256,
        }))
      }

      setStage('กำลังส่งคำขอ...')
      const submitForm = toSubmitForm(engineInput, form.customerName.trim(), form.imei)
      const result = await submitCreditCheck(token, submitForm, submittedFiles)
      onSubmitted(result)
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'unauthorized') {
        onSessionExpired(e.message)
        return
      }
      setSubmitError(e instanceof ApiError ? e.message : 'ส่งคำขอไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
    } finally {
      setSubmitting(false)
      setStage(null)
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 py-6">
      <p className="wsc-mono-label">WINSURE+ · CREDIT CHECK</p>
      <h2 className="wsc-h2 mb-4 mt-1">ยื่นคำขอเช็คเครดิต</h2>

      <div className="flex flex-col gap-4">
        <Card>
          <SectionHead no="01" title="ข้อมูลลูกค้า" />
          <div className="flex flex-col gap-3">
            <Field label="ชื่อ-นามสกุลลูกค้า" required>
              <Input value={form.customerName} onChange={(e) => set('customerName', e.target.value)} placeholder="เช่น สมชาย ใจดี" />
            </Field>
            <Field label="ประเภทลูกค้า" required>
              <Select value={form.customerType} onChange={(e) => set('customerType', e.target.value as CustomerType)}>
                {CUSTOMER_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={form.customerType === 'thai' ? 'เลขบัตรประชาชน 13 หลัก' : 'เลขบัตรสีชมพู / ใบอนุญาตทำงาน'} required>
              <Input
                inputMode="numeric"
                value={form.idNumber}
                onChange={(e) => set('idNumber', e.target.value)}
                placeholder={form.customerType === 'thai' ? '1234567890123' : 'เลขเอกสาร'}
              />
            </Field>
            <Field label="วันหมดอายุเอกสาร">
              <Input type="date" value={form.idExpiryDate} onChange={(e) => set('idExpiryDate', e.target.value)} />
            </Field>
            <Field
              label="วันออกบัตร"
              required={form.customerType === 'thai'}
              hint={form.customerType === 'thai' ? undefined : 'ไม่บังคับสำหรับเอกสารต่างชาติ'}
            >
              <Input type="date" value={form.idIssueDate} onChange={(e) => set('idIssueDate', e.target.value)} />
            </Field>
            <Field label="วันเกิด" required>
              <Input type="date" value={form.birthDate} onChange={(e) => set('birthDate', e.target.value)} />
            </Field>
          </div>
        </Card>

        <Card>
          <SectionHead no="02" title="อาชีพและรายได้" />
          <div className="flex flex-col gap-3">
            <Field label="อาชีพ" required>
              <Select value={form.occupationType} onChange={(e) => set('occupationType', e.target.value as OccupationType)}>
                {OCCUPATION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            {showWorkEvidenceCallout && (
              <p className="wsc-note">
                อาชีพอิสระ/เจ้าของกิจการ: แนบรูปหลักฐานการทำงาน หรือ Statement ย้อนหลัง 1 เดือน อย่างใดอย่างหนึ่ง จะช่วยให้ทีมพิจารณาไวขึ้น
              </p>
            )}
            <Field label="รายได้ต่อเดือน (บาท)">
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                value={form.declaredMonthlyIncome}
                onChange={(e) => set('declaredMonthlyIncome', e.target.value)}
                placeholder="ถ้าไม่ทราบเว้นว่างไว้ได้"
              />
            </Field>
          </div>
        </Card>

        <Card>
          <SectionHead no="03" title="เครื่องและค่างวด" />
          <div className="flex flex-col gap-3">
            <Field label="ประเภทเครื่อง" required>
              <Select value={form.deviceCondition} onChange={(e) => set('deviceCondition', e.target.value as DeviceCondition)}>
                {DEVICE_CONDITION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="IMEI เครื่อง (ถ้ามี)" hint={imeiErrorText ? undefined : 'ตัวเลข 15 หลัก ใช้ช่วยค้นประวัติเพิ่มเติม'} error={imeiErrorText}>
              <Input
                inputMode="numeric"
                maxLength={15}
                value={form.imei}
                onChange={(e) => set('imei', e.target.value.replace(/[^0-9]/g, ''))}
                aria-invalid={imeiErrorText ? true : undefined}
                placeholder="เช่น 356789012345678"
              />
            </Field>
            <Field label="ราคาเครื่อง (บาท)" required>
              <Input type="number" inputMode="numeric" min={0} value={form.devicePrice} onChange={(e) => set('devicePrice', e.target.value)} />
            </Field>
            <Field label="ดาวน์ (%)" required>
              <Input type="number" inputMode="numeric" min={0} max={100} value={form.downPercent} onChange={(e) => set('downPercent', e.target.value)} />
            </Field>
            <Field label="จำนวนงวด (เดือน)" required>
              <Input type="number" inputMode="numeric" min={1} value={form.termMonths} onChange={(e) => set('termMonths', e.target.value)} />
            </Field>
            <Field label="ค่างวด/เดือน (เรทร้าน WIN SURE PLUS)" required>
              <Input type="number" inputMode="numeric" min={0} value={form.ourMonthlyPayment} onChange={(e) => set('ourMonthlyPayment', e.target.value)} />
            </Field>
            <Field label="ค่างวด/เดือน (ตามเว็บ PJ)" required>
              <Input type="number" inputMode="numeric" min={0} value={form.pjMonthlyPayment} onChange={(e) => set('pjMonthlyPayment', e.target.value)} />
            </Field>
          </div>
        </Card>

        <Card>
          <SectionHead no="04" title="Facebook ลูกค้า" />
          <Field label="ลิงก์โปรไฟล์ Facebook">
            <Input value={form.facebookUrl} onChange={(e) => set('facebookUrl', e.target.value)} placeholder="https://www.facebook.com/..." />
          </Field>
        </Card>

        <Card>
          <h3 className="wsc-h3">ไฟล์แนบ</h3>
          <p className="wsc-hint mb-3">
            แนบได้ไม่เกิน {MAX_FILES_PER_SUBMIT} ไฟล์ต่อคำขอ ({attachedFiles.length}/{MAX_FILES_PER_SUBMIT})
          </p>
          <div className="flex flex-col gap-3">
            <FileUploader
              kind="id_card"
              label="รูปบัตรประชาชน / เอกสารประจำตัว"
              files={filesOfKind('id_card')}
              disabled={atFileLimit}
              onAdd={addFile}
              onRemove={removeFile}
            />
            <FileUploader
              kind="thaid_name_history"
              label="ภาพประวัติการเปลี่ยนชื่อจากแอป ThaID"
              hint={
                recentlyIssuedCard
                  ? 'บัตรเพิ่งออกใหม่ กรุณาแนบภาพประวัติเปลี่ยนชื่อ-สกุลจากแอป ThaID ของลูกค้า'
                  : 'ไม่บังคับ — แนบเพิ่มได้ถ้ามี'
              }
              highlight={recentlyIssuedCard}
              files={filesOfKind('thaid_name_history')}
              disabled={atFileLimit}
              onAdd={addFile}
              onRemove={removeFile}
            />
            <FileUploader
              kind="payslip"
              label="สลิปเงินเดือน"
              highlight={form.occupationType === 'salaried' || form.occupationType === 'government'}
              files={filesOfKind('payslip')}
              disabled={atFileLimit}
              onAdd={addFile}
              onRemove={removeFile}
            />
            <FileUploader
              kind="statement"
              label="รายการเดินบัญชี (Statement ย้อนหลัง 1 เดือน)"
              hint="แนบเป็นรูปหรือไฟล์ PDF ก็ได้"
              allowPdf
              highlight={showWorkEvidenceCallout}
              files={filesOfKind('statement')}
              disabled={atFileLimit}
              onAdd={addFile}
              onRemove={removeFile}
            />
            <FileUploader
              kind="work_photo"
              label="รูปหลักฐานการทำงาน"
              hint="เช่น รูปขณะทำงาน หรือร้าน/สถานที่ทำงาน"
              highlight={showWorkEvidenceCallout}
              files={filesOfKind('work_photo')}
              disabled={atFileLimit}
              onAdd={addFile}
              onRemove={removeFile}
            />
            <FileUploader
              kind="facebook_screenshot"
              label="ภาพหน้าจอโปรไฟล์ Facebook"
              files={filesOfKind('facebook_screenshot')}
              disabled={atFileLimit}
              onAdd={addFile}
              onRemove={removeFile}
            />
            <FileUploader
              kind="other"
              label="เอกสารอื่นๆ (ถ้ามี)"
              allowPdf
              files={filesOfKind('other')}
              disabled={atFileLimit}
              onAdd={addFile}
              onRemove={removeFile}
            />
          </div>
        </Card>

        {preview && (
          <Card>
            <p className="text-xs font-semibold wsc-muted">ผลประเมินเบื้องต้น (ในเครื่องนี้)</p>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xl">{PREVIEW_DISPLAY[preview.level].emoji}</span>
              <Pill tone={PREVIEW_DISPLAY[preview.level].tone}>{PREVIEW_DISPLAY[preview.level].text}</Pill>
            </div>
            {preview.reasons.length > 0 && (
              <ul className="mt-3 flex flex-col gap-1.5">
                {preview.reasons.map((r) => (
                  <li key={r.code} className="wsc-note text-xs">
                    {r.shopText}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs italic wsc-muted">ผลนี้เป็นแค่ตัวช่วยดูคร่าวๆ ผลจริงต้องรอส่งคำขอให้ทีมงานตรวจสอบเท่านั้น</p>
          </Card>
        )}

        <Card>
          <div className="wsc-checkbox">
            <input id={consentId} type="checkbox" checked={consentChecked} onChange={(e) => setConsentChecked(e.target.checked)} aria-describedby={consentTextId} />
            <label htmlFor={consentId} className="text-sm font-medium">
              ข้าพเจ้าอ่านและยินยอมตามเงื่อนไขการเก็บข้อมูลด้านล่างนี้
            </label>
          </div>
          <ul id={consentTextId} className="wsc-ticks">
            {CONSENT_TEXT.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </Card>

        {submitError && (
          <p id={submitErrorId} role="alert" className="wsc-note bad">
            {submitError}
          </p>
        )}

        <Button onClick={() => void handleSubmit()} disabled={submitting} aria-describedby={submitError ? submitErrorId : undefined}>
          {submitting ? (stage ?? 'กำลังส่ง...') : 'ส่งคำขอเช็คเครดิต'}
          {!submitting && (
            <span className="wsc-go" aria-hidden="true">
              →
            </span>
          )}
        </Button>
      </div>
    </div>
  )
}
