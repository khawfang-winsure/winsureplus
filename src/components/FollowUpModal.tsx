import { useEffect, useState } from 'react'
import { Badge, Button, Field, Modal, Select, Textarea } from './ui'
import { thaiDate } from '../lib/format'
import {
  addFollowUp,
  getFollowUps,
  type AddFollowUpInput,
  type FollowUpContactMethod,
  type FollowUpEntry,
  type FollowUpResult,
} from '../lib/db'
import { isContactWindowOpen } from '../lib/contactHours'
import { getComplianceErrorMessage } from '../lib/complianceErrors'

// ===== ป้ายกำกับ enum =====
const METHOD_LABEL: Record<FollowUpContactMethod, string> = {
  phone: 'โทรศัพท์',
  line: 'LINE',
  sms: 'SMS',
  visit: 'ไปพบ',
  other: 'อื่นๆ',
}

const RESULT_LABEL: Record<FollowUpResult, string> = {
  contacted: 'ติดต่อสำเร็จ',
  no_answer: 'ไม่รับสาย',
  promised: 'สัญญาจะชำระ',
  refused: 'ปฏิเสธ',
  paid: 'ชำระแล้ว',
  returned: 'คืนเครื่อง',
  other: 'อื่นๆ',
}

const RESULT_TONE: Record<FollowUpResult, 'green' | 'amber' | 'red' | 'neutral'> = {
  contacted: 'green',
  no_answer: 'amber',
  promised: 'amber',
  refused: 'red',
  paid: 'green',
  returned: 'neutral',
  other: 'neutral',
}

// ===== Props =====
interface ContractSummary {
  contractId: string
  contractNo: string
  customerName: string
  phone: string | null
  shopName: string
  daysLate: number
  address?: string // เผื่อส่งมาแสดง
  // Wave 1B optional fields (populated once db.ts update lands)
  deviceModel?: string
  phoneAlt1?: string | null
  phoneAlt2?: string | null
  installmentsPaid?: number
  installmentsTotal?: number
  penaltyDue?: number
  principalDue?: number
}

interface Props {
  contract: ContractSummary
  onClose: () => void
  /** Set ของวันหยุดราชการ (yyyy-mm-dd) รับจาก parent เพื่อกัน duplicate query */
  publicHolidays?: Set<string>
  /** Admin can record follow-ups outside contact hours (DB trigger also exempts admin) */
  adminOverride?: boolean
}

// ===== ฟอร์มสถานะ =====
interface FormState {
  noteText: string
  contactMethod: FollowUpContactMethod
  followUpResult: FollowUpResult
  nextFollowUpAt: string    // ฟิลด์นัดทั่วไป (ผลอื่นๆ ที่ไม่ใช่ promised)
  promisedDate: string      // วันที่ลูกค้าสัญญาจะจ่าย (เฉพาะ result=promised, required)
  promisedAmount: string    // จำนวนเงินที่สัญญา (optional string → parse ก่อนส่ง)
  phoneDialed: string       // เบอร์ที่โทร ('__other' = พิมพ์เอง, '' = ไม่ระบุ)
}

/** คืน yyyy-mm-dd ของวันนี้บวก n วัน โดยใช้เวลาท้องถิ่น (ป้องกัน UTC drift) */
function localDatePlusDays(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** คืน yyyy-mm-dd ของวันนี้ (ท้องถิ่น) */
function localToday(): string {
  return localDatePlusDays(0)
}

// phoneDialed ไม่รวมใน INITIAL_FORM (ต้องใช้ contract.phone ซึ่งรู้ตอน render)
// ใช้ makeInitialForm(phone) แทนตอน useState init
const BASE_FORM = {
  noteText: '',
  contactMethod: 'phone' as FollowUpContactMethod,
  followUpResult: 'no_answer' as FollowUpResult,
  nextFollowUpAt: '',
  promisedDate: localDatePlusDays(7),
  promisedAmount: '',
}

function makeInitialForm(phone: string | null, phoneAlt1?: string | null, phoneAlt2?: string | null): FormState {
  return { ...BASE_FORM, phoneDialed: phone ?? phoneAlt1 ?? phoneAlt2 ?? '' }
}

export default function FollowUpModal({ contract, onClose, publicHolidays = new Set(), adminOverride = false }: Props) {
  const [history, setHistory] = useState<FollowUpEntry[]>([])
  const [histLoading, setHistLoading] = useState(true)
  const [form, setForm] = useState<FormState>(() => makeInitialForm(contract.phone, contract.phoneAlt1, contract.phoneAlt2))
  const [customPhoneDialed, setCustomPhoneDialed] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ตรวจเวลา ณ ตอนที่เปิด modal (render-time check — UX เท่านั้น DB trigger บังคับจริง)
  const contactWindow = isContactWindowOpen(new Date(), publicHolidays)
  const outsideHours = !adminOverride && !contactWindow.ok

  // โหลดประวัติ
  const loadHistory = async () => {
    setHistLoading(true)
    try {
      const entries = await getFollowUps(contract.contractId)
      setHistory(entries)
    } catch {
      // ไม่บล็อก UI หากโหลดประวัติไม่ได้
      setHistory([])
    } finally {
      setHistLoading(false)
    }
  }

  useEffect(() => {
    void loadHistory()
  }, [contract.contractId])

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
    setSaved(false)
    setError(null)
  }

  async function handleSave() {
    // pre-check เวลาก่อนส่ง (DB ก็จะ reject แต่ UX จะเร็วกว่า)
    if (outsideHours) {
      setError('นอกเวลาทวงถามตามกฎหมาย (08:00–20:00 จ–ศ / 08:00–18:00 ส–อา+วันหยุด)')
      return
    }
    if (form.noteText.trim().length < 5) {
      setError('บันทึกการติดตามต้องมีอย่างน้อย 5 ตัวอักษร')
      return
    }
    // validation เพิ่มเติมสำหรับ promised
    if (form.followUpResult === 'promised') {
      if (!form.promisedDate) {
        setError('กรุณากรอกวันที่ลูกค้าสัญญาจะจ่าย')
        return
      }
      if (form.promisedAmount !== '' && Number(form.promisedAmount) < 0) {
        setError('จำนวนเงินที่สัญญาต้องไม่ติดลบ')
        return
      }
    }
    setSaving(true)
    setError(null)
    try {
      // แยก payload ตามประเภทผล
      const isPromised = form.followUpResult === 'promised'
      const parsedAmount =
        isPromised && form.promisedAmount !== ''
          ? Number(form.promisedAmount)
          : null
      // คำนวณ phoneDialed ที่จะส่ง DB
      const isPhoneMethod = form.contactMethod === 'phone'
      const hasAnyPhone = !!(contract.phone || contract.phoneAlt1 || contract.phoneAlt2)
      const resolvedPhoneDialed = (!isPhoneMethod || !hasAnyPhone)
        ? null
        : form.phoneDialed === '__other'
          ? customPhoneDialed.trim() || null
          : form.phoneDialed || null
      const input: AddFollowUpInput = {
        contractId: contract.contractId,
        noteText: form.noteText.trim(),
        contactMethod: form.contactMethod,
        followUpResult: form.followUpResult,
        // promised → Bangkok noon timestamp; อื่นๆ → ฟิลด์นัดทั่วไป
        nextFollowUpAt: isPromised
          ? `${form.promisedDate}T12:00:00+07:00`
          : form.nextFollowUpAt || null,
        promisedAmount: parsedAmount,
        phoneDialed: resolvedPhoneDialed,
      }
      await addFollowUp(input)
      setForm(makeInitialForm(contract.phone, contract.phoneAlt1, contract.phoneAlt2))
      setCustomPhoneDialed('')
      setSaved(true)
      await loadHistory()
    } catch (e) {
      // แปล compliance error P0001 → ภาษาไทย ถ้าไม่ใช่ compliance error → fallback ข้อความเดิม
      const complianceMsg = getComplianceErrorMessage(e)
      if (complianceMsg) {
        setError(complianceMsg)
      } else {
        setError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`บันทึกติดตาม — ${contract.customerName}`} onClose={onClose}>
      {/* สรุปสัญญา */}
      <div className="mb-4 rounded-xl bg-peach-light/40 px-4 py-3 text-sm">
        <p className="font-medium text-ink">{contract.contractNo}</p>
        {contract.deviceModel && (
          <p className="text-ink-soft">รุ่น: {contract.deviceModel}</p>
        )}
        {contract.installmentsPaid !== undefined &&
          contract.installmentsTotal !== undefined &&
          contract.installmentsTotal > 0 && (
            <p className="text-ink-soft">
              งวด {contract.installmentsPaid}/{contract.installmentsTotal}
            </p>
          )}
        {contract.penaltyDue !== undefined && (
          <p className="text-ink-soft">
            ค่าปรับสะสม:{' '}
            <span className={contract.penaltyDue > 0 ? 'font-semibold text-red-600' : ''}>
              {contract.penaltyDue.toLocaleString('th-TH')} ฿
            </span>
          </p>
        )}
        {contract.principalDue !== undefined && (
          <p className="text-ink-soft">
            เงินต้นคงค้าง:{' '}
            <span className={contract.principalDue > 0 ? 'font-semibold text-red-600' : ''}>
              {contract.principalDue.toLocaleString('th-TH')} ฿
            </span>
          </p>
        )}
        <p className="mt-1 text-ink-soft">ร้าน: {contract.shopName}</p>
        {/* เบอร์โทรทั้งหมด */}
        {contract.phone && (
          <p className="text-ink-soft">เบอร์หลัก: {contract.phone}</p>
        )}
        {contract.phoneAlt1 && (
          <p className="text-ink-soft">เบอร์สำรอง 1: {contract.phoneAlt1}</p>
        )}
        {contract.phoneAlt2 && (
          <p className="text-ink-soft">เบอร์สำรอง 2: {contract.phoneAlt2}</p>
        )}
        <p className="mt-1">
          <Badge tone="red">ค้าง {contract.daysLate} วัน</Badge>
        </p>
      </div>

      {/* banner นอกเวลา */}
      {outsideHours && (
        <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          นอกเวลาทวงถามตามกฎหมาย — ไม่สามารถบันทึกการติดต่อได้ขณะนี้
        </div>
      )}

      {/* ฟอร์มบันทึก */}
      <div className="flex flex-col gap-3">
        <Field label="บันทึกการติดตาม" required>
          <Textarea
            rows={3}
            placeholder="รายละเอียดการติดตาม (อย่างน้อย 5 ตัวอักษร)"
            value={form.noteText}
            onChange={(e) => set('noteText', e.target.value)}
            disabled={outsideHours}
          />
          <p
            className={`mt-1 text-right text-xs ${
              form.noteText.length > 200
                ? 'text-amber-600'
                : form.noteText.length < 5
                  ? 'text-red-500'
                  : 'text-ink-soft'
            }`}
          >
            {form.noteText.length}/200 ตัวอักษร
          </p>
        </Field>

        <Field label="วิธีการติดต่อ" required>
          <Select
            value={form.contactMethod}
            onChange={(e) => set('contactMethod', e.target.value as FollowUpContactMethod)}
            disabled={outsideHours}
          >
            {(Object.keys(METHOD_LABEL) as FollowUpContactMethod[]).map((m) => (
              <option key={m} value={m}>
                {METHOD_LABEL[m]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="ผลการติดต่อ" required>
          <Select
            value={form.followUpResult}
            onChange={(e) => set('followUpResult', e.target.value as FollowUpResult)}
            disabled={outsideHours}
          >
            {(Object.keys(RESULT_LABEL) as FollowUpResult[]).map((r) => (
              <option key={r} value={r}>
                {RESULT_LABEL[r]}
              </option>
            ))}
          </Select>
        </Field>

        {/* ฟิลด์เฉพาะ result=promised: วันที่ลูกค้าสัญญา (required) + จำนวนเงิน (optional) */}
        {form.followUpResult === 'promised' && (
          <>
            <Field label="วันที่ลูกค้าสัญญาจะจ่าย" required>
              <input
                type="date"
                className="w-full rounded-xl border border-peach bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-salmon-deep focus:ring-2 focus:ring-salmon/40 disabled:bg-peach-light/40 disabled:text-ink-soft"
                value={form.promisedDate}
                min={localToday()}
                onChange={(e) => set('promisedDate', e.target.value)}
                disabled={outsideHours}
              />
            </Field>
            <Field label="จำนวนเงินที่สัญญา (บาท)">
              <input
                type="number"
                min={0}
                step="any"
                className="w-full rounded-xl border border-peach bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-salmon-deep focus:ring-2 focus:ring-salmon/40 disabled:bg-peach-light/40 disabled:text-ink-soft"
                placeholder="ไม่บังคับ"
                value={form.promisedAmount}
                onChange={(e) => set('promisedAmount', e.target.value)}
                disabled={outsideHours}
              />
            </Field>
          </>
        )}

        {/* ฟิลด์นัดทั่วไป — แสดงเฉพาะผลที่ไม่ใช่ promised */}
        {form.followUpResult !== 'promised' && (
          <Field label="นัดติดต่อครั้งต่อไป (ไม่บังคับ)">
            <input
              type="date"
              className="w-full rounded-xl border border-peach bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-salmon-deep focus:ring-2 focus:ring-salmon/40 disabled:bg-peach-light/40 disabled:text-ink-soft"
              value={form.nextFollowUpAt}
              onChange={(e) => set('nextFollowUpAt', e.target.value)}
              disabled={outsideHours}
            />
          </Field>
        )}

        {/* phoneDialed dropdown — แสดงเฉพาะ method=phone และมีเบอร์อย่างน้อย 1 เบอร์ */}
        {form.contactMethod === 'phone' &&
          (contract.phone || contract.phoneAlt1 || contract.phoneAlt2) && (
            <Field label="เบอร์ที่โทร">
              <Select
                value={form.phoneDialed}
                onChange={(e) => set('phoneDialed', e.target.value)}
                disabled={outsideHours}
              >
                {contract.phone && (
                  <option value={contract.phone}>หลัก: {contract.phone}</option>
                )}
                {contract.phoneAlt1 && (
                  <option value={contract.phoneAlt1}>สำรอง 1: {contract.phoneAlt1}</option>
                )}
                {contract.phoneAlt2 && (
                  <option value={contract.phoneAlt2}>สำรอง 2: {contract.phoneAlt2}</option>
                )}
                <option value="__other">อื่นๆ (พิมพ์เอง)</option>
              </Select>
              {form.phoneDialed === '__other' && (
                <input
                  type="tel"
                  className="mt-2 w-full rounded-xl border border-peach bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-salmon-deep focus:ring-2 focus:ring-salmon/40 disabled:bg-peach-light/40 disabled:text-ink-soft"
                  placeholder="กรอกเบอร์โทร"
                  value={customPhoneDialed}
                  onChange={(e) => setCustomPhoneDialed(e.target.value)}
                  disabled={outsideHours}
                />
              )}
            </Field>
          )}

        {error && <p className="text-sm text-red-600">{error}</p>}
        {saved && <p className="text-sm text-green-700">บันทึกแล้ว</p>}

        <div className="flex gap-2 pt-1">
          <Button onClick={handleSave} disabled={saving || outsideHours}>
            {saving ? 'กำลังบันทึก...' : 'บันทึก'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
        </div>
      </div>

      {/* ประวัติการติดตาม */}
      <div className="mt-5 border-t border-peach pt-4">
        <p className="mb-3 text-sm font-semibold text-ink">ประวัติการติดตาม</p>
        {histLoading ? (
          <p className="text-sm text-ink-soft">กำลังโหลด...</p>
        ) : history.length === 0 ? (
          <p className="text-sm text-ink-soft">ยังไม่มีประวัติ</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {history.map((h) => (
              <li key={h.id} className="rounded-xl border border-peach bg-white px-3 py-2.5 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium text-ink">{h.noteText}</p>
                  <Badge tone={RESULT_TONE[h.followUpResult]}>{RESULT_LABEL[h.followUpResult]}</Badge>
                </div>
                <p className="mt-1 text-xs text-ink-soft">
                  {h.authorName} · {thaiDate(h.createdAt.slice(0, 10))} · {METHOD_LABEL[h.contactMethod]}
                  {h.nextFollowUpAt && ` · นัด: ${thaiDate(h.nextFollowUpAt)}`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
