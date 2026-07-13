import { useEffect, useMemo, useState } from 'react'
import { MessageSquare, PackageCheck } from 'lucide-react'
import { Badge, Button, Field, Modal, Select, Textarea } from './ui'
import { baht, thaiDate } from '../lib/format'
import {
  addFollowUp,
  closeCase,
  getCompanySmsSettings,
  getContractAddresses,
  getFollowUps,
  getInstallments,
  type AddFollowUpInput,
  type ContractAddresses,
  type FollowUpContactMethod,
  type FollowUpContactTarget,
  type FollowUpEntry,
  type FollowUpResult,
} from '../lib/db'
import { isContactWindowOpen } from '../lib/contactHours'
import { getComplianceErrorMessage } from '../lib/complianceErrors'
import { useAuth } from '../lib/auth'
import { paymentRecoveryStatus, type RecoveryInstallmentInput } from '../lib/calc'
import { followUpStalenessLevel } from '../lib/priorityQueue'
import { buildDebtSms } from '../lib/messages'

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
  line_pending: 'นัดทาง LINE – รอลูกค้า',
  other: 'อื่นๆ',
}

const RESULT_TONE: Record<FollowUpResult, 'green' | 'amber' | 'red' | 'neutral'> = {
  contacted: 'green',
  no_answer: 'amber',
  promised: 'amber',
  refused: 'red',
  paid: 'green',
  returned: 'neutral',
  line_pending: 'amber',
  other: 'neutral',
}

// 0091: ตัวเลือกความสัมพันธ์ผู้ติดต่อ (ญาติ/ผู้ค้ำ) — '__other' เปิดช่องพิมพ์เอง
const RELATION_OPTIONS = ['บิดา', 'มารดา', 'คู่สมรส', 'บุตร', 'พี่น้อง', 'ผู้ค้ำประกัน', 'เพื่อน', 'นายจ้าง']

// ===== Props =====
interface ContractSummary {
  contractId: string
  contractNo: string
  customerName: string
  phone: string | null
  shopName: string
  daysLate: number
  // Wave 1B optional fields (populated once db.ts update lands)
  deviceModel?: string
  color?: string | null
  phoneAlt1?: string | null
  phoneAlt2?: string | null
  installmentsPaid?: number
  installmentsTotal?: number
  penaltyDue?: number
  principalDue?: number
  // ข้อ 7: เงินต้นงวดที่เลยกำหนดและยังไม่จ่าย (v_contract_status.overdue_amount) — รวมกับ penaltyDue = ยอดต้องชำระวันนี้
  overdueAmount?: number
  // เคสคืนเครื่อง
  isReturned?: boolean
  returnClosingAmount?: number
  returnedAt?: string | null
  returnAnchorType?: 'returned' | 'overdue' | null
  returnAnchorDate?: string | null
  overdueDueDate?: string | null
  // req11: บรรทัด "ทำรายการ ... ครบกำหนดทุกวันที่ ..." (ป็อปอัพบันทึกติดตาม)
  dueDay?: number
  transactionDate?: string
  // req8: เวลาติดตามล่าสุด — ใช้คำนวณป้าย "ไม่ได้ติดตามมานาน"
  lastContactedAt?: string | null
  // req8: ซ่อนป้ายถ้าสัญญาไม่ active (เคสคืนเครื่องยังนับว่า active สำหรับตามหนี้ — ใช้ isReturned แยกจาก closed)
  isActive?: boolean
}

interface Props {
  contract: ContractSummary
  onClose: () => void
  /** เรียกเมื่อบันทึกการติดตามสำเร็จ (ให้ parent reload คิวเฉพาะตอนที่ข้อมูลเปลี่ยนจริง) */
  onSaved?: () => void
  /** เรียกเมื่อกด "ยืนยันปิดเคส" สำเร็จ (ให้ parent reload คิว + ปิด modal) */
  onCaseClosed?: () => void
  /** Set ของวันหยุดราชการ (yyyy-mm-dd) รับจาก parent เพื่อกัน duplicate query */
  publicHolidays?: Set<string>
  /** Admin can record follow-ups outside contact hours (DB trigger also exempts admin) */
  adminOverride?: boolean
  /** ซ่อนปุ่ม "ยืนยันปิดเคส" เมื่อเคสนี้ปิดไปแล้ว (เช่น มาจากแท็บ "ปิดเคสวันนี้") */
  alreadyClosed?: boolean
  /** soft-warn: CAP หรือ PROMISE_PENDING — แสดงแถบเตือนใน modal แต่ไม่ล็อกปุ่ม */
  softWarnReason?: 'CAP' | 'PROMISE_PENDING' | null
  /** วันที่ลูกค้าสัญญาจะจ่าย (yyyy-mm-dd) — ใช้แสดงในแถบเตือน PROMISE_PENDING */
  promiseToPayDate?: string | null
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
  contactTarget: FollowUpContactTarget   // 0091: โทรหาลูกหนี้เอง หรือผู้ติดต่อ (ญาติ/ผู้ค้ำ)
  contactPersonName: string              // 0091: ชื่อผู้ติดต่อ (เฉพาะ contactTarget='other')
  contactPersonRelation: string          // 0091: ตัวเลือกจาก RELATION_OPTIONS หรือ '__other' = พิมพ์เอง
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
  contactTarget: 'debtor' as FollowUpContactTarget,
  contactPersonName: '',
  contactPersonRelation: '',
}

function makeInitialForm(phone: string | null, phoneAlt1?: string | null, phoneAlt2?: string | null): FormState {
  return { ...BASE_FORM, phoneDialed: phone ?? phoneAlt1 ?? phoneAlt2 ?? '' }
}

export default function FollowUpModal({ contract, onClose, onSaved, onCaseClosed, publicHolidays = new Set(), adminOverride = false, alreadyClosed = false, softWarnReason, promiseToPayDate }: Props) {
  const { name: authName } = useAuth()
  const [history, setHistory] = useState<FollowUpEntry[]>([])
  const [histLoading, setHistLoading] = useState(true)
  const [form, setForm] = useState<FormState>(() => makeInitialForm(contract.phone, contract.phoneAlt1, contract.phoneAlt2))
  const [customPhoneDialed, setCustomPhoneDialed] = useState('')
  const [customRelation, setCustomRelation] = useState('')  // 0091: ความสัมพันธ์แบบพิมพ์เอง (เมื่อเลือก '__other')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [closingCase, setClosingCase] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)
  const [addresses, setAddresses] = useState<ContractAddresses>({})

  // req9: งวดของสัญญานี้ — ใช้คำนวณ paymentRecoveryStatus
  const [recoveryInstallments, setRecoveryInstallments] = useState<RecoveryInstallmentInput[]>([])

  // req10: ตั้งค่า SMS บริษัท (เบอร์บริษัท + ที่อยู่คืนเครื่อง)
  const [smsSettings, setSmsSettings] = useState({ companyName: '', companyPhone: '', returnAddress: '' })
  const [smsPhoneChoice, setSmsPhoneChoice] = useState<'phone' | 'phoneAlt1' | 'phoneAlt2'>('phone')
  const [smsIncludeReturn, setSmsIncludeReturn] = useState(false)

  // ตรวจเวลา ณ ตอนที่เปิด modal (render-time check — UX เท่านั้น DB trigger บังคับจริง)
  const contactWindow = isContactWindowOpen(new Date(), publicHolidays)
  const outsideHours = !adminOverride && !contactWindow.ok

  // โหลดที่อยู่ตามบัตรประชาชน เพื่อแสดงอำเภอ/จังหวัดให้คนตามหนี้
  useEffect(() => {
    getContractAddresses(contract.contractId)
      .then(setAddresses)
      .catch(() => setAddresses({}))
  }, [contract.contractId])

  // req9: โหลดงวดของสัญญานี้ — ใช้คำนวณสถานะ "กลับเป็นปกติ"
  useEffect(() => {
    getInstallments(contract.contractId)
      .then((list) => {
        setRecoveryInstallments(
          list.map((i) => ({
            installmentNo: i.installmentNo,
            dueDate: i.dueDate,
            amount: i.amount,
            paidAmount: i.paidAmount,
            paidAt: i.paidAt,
          })),
        )
      })
      .catch(() => setRecoveryInstallments([]))
  }, [contract.contractId])

  // req10: โหลดตั้งค่าบริษัทสำหรับ SMS (ครั้งเดียวตอนเปิด modal)
  useEffect(() => {
    getCompanySmsSettings()
      .then(setSmsSettings)
      .catch(() => setSmsSettings({ companyName: '', companyPhone: '', returnAddress: '' }))
  }, [])

  // req9: สถานะ "กลับเป็นปกติ" — คำนวณจากงวดที่โหลดมา
  const recoveryStatus = useMemo(
    () => paymentRecoveryStatus(recoveryInstallments, new Date()),
    [recoveryInstallments],
  )

  // req8: ป้าย "ไม่ได้ติดตามมานาน" — ซ่อนถ้าสัญญาไม่ active (default true ถ้าไม่ได้ส่งมา — เพื่อ backward compat)
  const staleness = useMemo(
    () => followUpStalenessLevel(contract.lastContactedAt ?? null, new Date()),
    [contract.lastContactedAt],
  )
  const showStalenessBadge = (contract.isActive ?? true) && staleness.level !== 'none'

  // req10: เบอร์ที่เลือกสำหรับส่ง SMS
  const smsPhoneOptions = [
    { key: 'phone' as const, value: contract.phone },
    { key: 'phoneAlt1' as const, value: contract.phoneAlt1 },
    { key: 'phoneAlt2' as const, value: contract.phoneAlt2 },
  ].filter((o): o is { key: 'phone' | 'phoneAlt1' | 'phoneAlt2'; value: string } => !!o.value)
  const smsTargetPhone = smsPhoneOptions.find((o) => o.key === smsPhoneChoice)?.value ?? smsPhoneOptions[0]?.value ?? null

  function handleSendSms() {
    if (!smsTargetPhone) return
    try {
      const body = buildDebtSms({
        customerName: contract.customerName,
        overdueAmount: recoveryStatus.overdueAmountRemaining,
        overdueCount: recoveryStatus.overdueCount,
        includeReturnInstruction: smsIncludeReturn,
        companyPhone: smsSettings.companyPhone,
        returnAddress: smsSettings.returnAddress || undefined,
      })
      // iOS ใช้ &body= / Android ใช้ ?body= — "?&body=" ใช้ได้ทั้งคู่ในทางปฏิบัติ
      window.location.href = `sms:${smsTargetPhone}?&body=${encodeURIComponent(body)}`
    } catch {
      // overdueCount=0 หรือ returnAddress ว่าง (ปุ่มถูก disable กันไว้แล้ว แต่กันเผื่อ race)
    }
  }

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
      // 0091: ผู้ติดต่อ (ญาติ/ผู้ค้ำ) — ส่งชื่อ/ความสัมพันธ์เฉพาะตอนเลือก contactTarget='other'
      const isOtherContact = form.contactTarget === 'other'
      const resolvedContactPersonName = isOtherContact
        ? form.contactPersonName.trim() || null
        : null
      const resolvedContactPersonRelation = isOtherContact
        ? (form.contactPersonRelation === '__other'
            ? customRelation.trim() || null
            : form.contactPersonRelation || null)
        : null
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
        contactTarget: form.contactTarget,
        contactPersonName: resolvedContactPersonName,
        contactPersonRelation: resolvedContactPersonRelation,
      }
      await addFollowUp(input)
      setForm(makeInitialForm(contract.phone, contract.phoneAlt1, contract.phoneAlt2))
      setCustomPhoneDialed('')
      setCustomRelation('')
      setSaved(true)
      await loadHistory()
      onSaved?.()
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

  async function handleCloseCase() {
    setClosingCase(true)
    setCloseError(null)
    try {
      await closeCase(contract.contractId, authName ?? undefined)
      onCaseClosed?.()
      onClose()
    } catch (e) {
      setCloseError(e instanceof Error ? e.message : 'ปิดเคสไม่สำเร็จ')
    } finally {
      setClosingCase(false)
    }
  }

  return (
    <Modal title={`บันทึกติดตาม — ${contract.customerName}`} onClose={onClose}>
      {/* สรุปสัญญา */}
      <div className="mb-4 rounded-xl bg-peach-light/40 px-4 py-3 text-sm">
        {/* หัวเรื่อง: เลขสัญญา + ป้ายวันค้าง/ไม่ได้ติดตามมานาน */}
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="font-medium text-ink">{contract.contractNo}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="red">ค้าง {contract.daysLate} วัน</Badge>
            {/* req8: ป้ายเตือนไม่ได้ติดตามมานาน */}
            {showStalenessBadge && (
              <Badge tone={staleness.level === 'danger' ? 'red' : 'amber'}>{staleness.badgeText}</Badge>
            )}
          </div>
        </div>

        {/* ตัวเลขเด่น: เคสคืนเครื่องแล้ว → ยอดปิดคืนเครื่อง / เคสปกติ → ยอดปิดทั้งสัญญา (เงินต้นคงค้าง + ค่าปรับสะสม)
            ข้อ 2 (Pete feedback): เอา "ค้างชำระวันนี้ (รวมค่าปรับ)" ออก เพราะพนักงานงงว่าตามยอดไหน — ให้ "ยอดปิด" เป็นตัวเลขเด่นแทน */}
        {contract.isReturned ? (
          <div className="mt-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-100 px-3 py-1 text-xs font-semibold text-indigo-700">
              <PackageCheck size={13} />
              คืนเครื่องแล้ว · ยอดปิด {baht(contract.returnClosingAmount ?? 0)} ฿
            </span>
            {contract.returnAnchorDate && (() => {
              const todayBkk = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10)
              const [ty, tm, td] = todayBkk.split('-').map(Number)
              const [ay, am, ad] = contract.returnAnchorDate.split('-').map(Number)
              const todayMs = Date.UTC(ty, tm - 1, td)
              const anchorMs = Date.UTC(ay, am - 1, ad)
              const daysSince = Math.floor((todayMs - anchorMs) / 86400000) + 1
              if (contract.returnAnchorType === 'returned' && contract.returnedAt) {
                return (
                  <p className="mt-1 text-xs text-indigo-600">
                    คืนเมื่อ {thaiDate(contract.returnedAt)} · คืนมาแล้ว {daysSince} วัน
                  </p>
                )
              }
              if (contract.returnAnchorType === 'overdue' && contract.overdueDueDate) {
                return (
                  <p className="mt-1 text-xs text-indigo-600">
                    ครบกำหนดงวด {thaiDate(contract.overdueDueDate)} · ค้างมาแล้ว {daysSince} วัน
                  </p>
                )
              }
              return null
            })()}
          </div>
        ) : (
          contract.principalDue !== undefined && (
            <p className="mt-2 rounded-lg bg-red-50 px-2.5 py-1.5">
              <span className="text-xs font-medium text-red-500">ยอดปิด (จ่ายครบทั้งสัญญา): </span>
              <span className="text-base font-bold text-red-700">
                {baht(contract.principalDue + (contract.penaltyDue ?? 0))} ฿
              </span>
            </p>
          )
        )}

        {/* ข้อ 3: รายละเอียดสัญญา/ลูกค้า — จัด 2 คอลัมน์ label-value กันกองซ้าย */}
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
          {contract.deviceModel && (
            <p className="text-ink-soft">รุ่น: <span className="text-ink">{contract.deviceModel}</span></p>
          )}
          {contract.color && (
            <p className="text-ink-soft">สีเครื่อง: <span className="text-ink">{contract.color}</span></p>
          )}
          {addresses.id_card?.district && (
            <p className="text-ink-soft">อำเภอ: <span className="text-ink">{addresses.id_card.district}</span></p>
          )}
          {addresses.id_card?.province && (
            <p className="text-ink-soft">จังหวัด: <span className="text-ink">{addresses.id_card.province}</span></p>
          )}
          {contract.installmentsPaid !== undefined &&
            contract.installmentsTotal !== undefined &&
            contract.installmentsTotal > 0 && (
              <p className="text-ink-soft">
                งวด: <span className="text-ink">{contract.installmentsPaid}/{contract.installmentsTotal}</span>
              </p>
            )}
          {contract.penaltyDue !== undefined && (
            <p className="text-ink-soft">
              ค่าปรับสะสม:{' '}
              <span className={contract.penaltyDue > 0 ? 'font-semibold text-red-600' : 'text-ink'}>
                {contract.penaltyDue.toLocaleString('th-TH')} ฿
              </span>
            </p>
          )}
          {contract.principalDue !== undefined && (
            <p className="text-ink-soft">
              เงินต้นคงค้าง:{' '}
              <span className={contract.principalDue > 0 ? 'font-semibold text-red-600' : 'text-ink'}>
                {contract.principalDue.toLocaleString('th-TH')} ฿
              </span>
            </p>
          )}
          <p className="text-ink-soft">ร้าน: <span className="text-ink">{contract.shopName}</span></p>
          {/* เบอร์โทรทั้งหมด */}
          {contract.phone && (
            <p className="text-ink-soft">เบอร์หลัก: <span className="text-ink">{contract.phone}</span></p>
          )}
          {contract.phoneAlt1 && (
            <p className="text-ink-soft">เบอร์สำรอง 1: <span className="text-ink">{contract.phoneAlt1}</span></p>
          )}
          {contract.phoneAlt2 && (
            <p className="text-ink-soft">เบอร์สำรอง 2: <span className="text-ink">{contract.phoneAlt2}</span></p>
          )}
          {/* req11: ทำรายการ + ครบกำหนดทุกวันที่ — ข้อความยาว กว้างเต็มแถว */}
          {contract.transactionDate && contract.dueDay && (
            <p className="col-span-2 text-ink-soft">
              ทำรายการ {thaiDate(contract.transactionDate)} · ครบกำหนดทุกวันที่ {contract.dueDay}
            </p>
          )}
        </div>

        {/* req9: สถานะ "กลับเป็นปกติ" — ซ่อนสำหรับเคสคืนเครื่อง (เหลือจ่ายแค่ยอดปิด ไม่ใช่ค้าง N งวด) */}
        {!contract.isReturned && (
          <p className="mt-2 text-xs text-ink-soft">{recoveryStatus.badgeText}</p>
        )}
        {/* req11: จ่ายล่าสุด (เฉพาะเมื่อมี recovered episode) */}
        {recoveryStatus.recoveredThisEpisode.lastPaidAt && (
          <p className="mt-1 text-xs text-ink-soft">
            จ่ายล่าสุด: {thaiDate(recoveryStatus.recoveredThisEpisode.lastPaidAt)} ·{' '}
            {baht(recoveryStatus.recoveredThisEpisode.lastPaidAmount)}฿
          </p>
        )}
      </div>

      {/* req10: ส่ง SMS ทวงหนี้ */}
      {smsPhoneOptions.length > 0 && (
        <div className="mb-4 rounded-xl border border-peach bg-white px-4 py-3">
          <p className="mb-2 text-sm font-semibold text-ink">ส่ง SMS ทวงหนี้</p>
          <div className="flex flex-col gap-2.5">
            {smsPhoneOptions.length > 1 && (
              <Field label="เบอร์ที่จะส่ง">
                <Select
                  value={smsPhoneChoice}
                  onChange={(e) => setSmsPhoneChoice(e.target.value as 'phone' | 'phoneAlt1' | 'phoneAlt2')}
                >
                  {smsPhoneOptions.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.key === 'phone' ? 'หลัก' : o.key === 'phoneAlt1' ? 'สำรอง 1' : 'สำรอง 2'}: {o.value}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <label
              className={`flex items-center gap-2 text-sm ${smsSettings.returnAddress ? 'text-ink' : 'text-ink-soft'}`}
              title={smsSettings.returnAddress ? undefined : 'ยังไม่ได้ตั้งค่าที่อยู่คืนเครื่อง'}
            >
              <input
                type="checkbox"
                checked={smsIncludeReturn}
                disabled={!smsSettings.returnAddress}
                onChange={(e) => setSmsIncludeReturn(e.target.checked)}
                className="h-4 w-4 accent-salmon-deep disabled:cursor-not-allowed"
              />
              แนบข้อความให้ส่งเครื่องคืน
            </label>
            <Button
              variant="ghost"
              onClick={handleSendSms}
              disabled={recoveryStatus.overdueCount === 0 || !smsTargetPhone}
              className="self-start"
            >
              <MessageSquare size={15} />
              ส่ง SMS
            </Button>
            {recoveryStatus.overdueCount === 0 && (
              <p className="text-xs text-ink-soft">ไม่มีงวดค้างชำระ — ไม่ต้องส่ง SMS ทวงหนี้</p>
            )}
          </div>
        </div>
      )}

      {/* banner นอกเวลา */}
      {outsideHours && (
        <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          นอกเวลาทวงถามตามกฎหมาย — ไม่สามารถบันทึกการติดต่อได้ขณะนี้
        </div>
      )}

      {/* soft-warn: CAP — เฉพาะตอนกำลังจะบันทึกแบบโทรหาลูกหนี้เอง (โทรผู้ติดต่อไม่นับโควตานี้) */}
      {softWarnReason === 'CAP' && !outsideHours && form.contactTarget === 'debtor' && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          โทรทวงลูกหนี้รายนี้ของวันนี้ถูกบันทึกแล้ว — บันทึกเพิ่มได้ ระบบจะถือเป็นบันทึกต่อเนื่อง (ไม่นับเป็นการทวงครั้งใหม่ตามกฎหมาย)
        </div>
      )}

      {/* soft-warn: PROMISE_PENDING */}
      {softWarnReason === 'PROMISE_PENDING' && !outsideHours && promiseToPayDate && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          ลูกค้าสัญญาจะจ่ายวันที่ {thaiDate(promiseToPayDate)} — หากติดต่อไม่สำเร็จหรือมีการเปลี่ยนแปลง สามารถบันทึกได้ตามปกติ
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

        {/* 0091: แยกโทรหาลูกหนี้เอง vs ผู้ติดต่อ (ญาติ/ผู้ค้ำ) — ผู้ติดต่อไม่นับโควตาวันละครั้งของลูกหนี้ */}
        <Field label="ติดต่อกับใคร" required>
          <Select
            value={form.contactTarget}
            onChange={(e) => set('contactTarget', e.target.value as FollowUpContactTarget)}
            disabled={outsideHours}
          >
            <option value="debtor">ลูกหนี้ (ตัวลูกค้า)</option>
            <option value="other">ผู้ติดต่อ (ญาติ/ผู้ค้ำ/คนอื่น)</option>
          </Select>
        </Field>

        {form.contactTarget === 'other' && (
          <>
            {/* คำแนะนำ (advisory) — ระบบไม่ได้บังคับจำกัดโควตา เจ้าหน้าที่ต้องดูแลเอง */}
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
              ⚠️ การโทรหาผู้ติดต่อ: ติดต่อได้เพื่อสอบถามช่องทางติดต่อลูกค้าเท่านั้น — ห้ามเปิดเผยเรื่องหนี้/ยอดหนี้
              ยกเว้นผู้ติดต่อเป็นบิดา-มารดา คู่สมรส หรือบุตรของลูกค้าที่สอบถามเอง
            </div>
            <Field label="ชื่อผู้ติดต่อ">
              <input
                type="text"
                className="w-full rounded-xl border border-peach bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-salmon-deep focus:ring-2 focus:ring-salmon/40 disabled:bg-peach-light/40 disabled:text-ink-soft"
                placeholder="ไม่บังคับ"
                value={form.contactPersonName}
                onChange={(e) => set('contactPersonName', e.target.value)}
                disabled={outsideHours}
              />
            </Field>
            <Field label="ความสัมพันธ์">
              <Select
                value={form.contactPersonRelation}
                onChange={(e) => set('contactPersonRelation', e.target.value)}
                disabled={outsideHours}
              >
                <option value="">-- เลือก --</option>
                {RELATION_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
                <option value="__other">อื่นๆ (พิมพ์เอง)</option>
              </Select>
              {form.contactPersonRelation === '__other' && (
                <input
                  type="text"
                  className="mt-2 w-full rounded-xl border border-peach bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-salmon-deep focus:ring-2 focus:ring-salmon/40 disabled:bg-peach-light/40 disabled:text-ink-soft"
                  placeholder="ระบุความสัมพันธ์"
                  value={customRelation}
                  onChange={(e) => setCustomRelation(e.target.value)}
                  disabled={outsideHours}
                />
              )}
            </Field>
            {/* คำแนะนำเฉพาะผู้ค้ำประกัน — โผล่เมื่อเลือกความสัมพันธ์นี้เท่านั้น (ระบบไม่ได้บังคับจำกัดจริง เป็นคำแนะนำให้เจ้าหน้าที่ดูแลเอง) */}
            {form.contactPersonRelation === 'ผู้ค้ำประกัน' && (
              <div className="rounded-lg border border-amber-400 bg-amber-100 px-3 py-2 text-xs font-medium leading-relaxed text-amber-800">
                ⚠️ ผู้ติดต่อรายนี้เป็น &quot;ผู้ค้ำประกัน&quot; — กฎหมายถือเสมือนลูกหนี้ โปรดจำกัดการติดต่อด้วยตนเองไม่เกินวันละ 1 ครั้ง
                (คำแนะนำ — ระบบไม่ได้บังคับจำกัดให้)
              </div>
            )}
          </>
        )}

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

        <div className="flex flex-wrap gap-2 pt-1">
          <Button onClick={handleSave} disabled={saving || closingCase || outsideHours}>
            {saving ? 'กำลังบันทึก...' : 'บันทึก'}
          </Button>
          {onCaseClosed && !alreadyClosed && (
            <Button
              variant="ghost"
              disabled={saving || closingCase}
              onClick={() => void handleCloseCase()}
              className="border-green-300 text-green-700 hover:bg-green-50"
            >
              {closingCase ? 'กำลังปิดเคส...' : '✓ ยืนยันปิดเคส'}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={saving || closingCase}>
            ยกเลิก
          </Button>
        </div>
        {closeError && <p className="mt-1 text-sm text-red-600">{closeError}</p>}
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
                {/* 0091: บอกให้ชัดว่าครั้งนี้โทรหาผู้ติดต่อ (ญาติ/ผู้ค้ำ) ไม่ใช่ลูกหนี้เอง */}
                {h.contactTarget === 'other' && (
                  <p className="mt-1 text-xs font-medium text-amber-700">
                    📞 โทรผู้ติดต่อ: {h.contactPersonName || 'ไม่ระบุชื่อ'} · {h.contactPersonRelation || 'ไม่ระบุความสัมพันธ์'}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
