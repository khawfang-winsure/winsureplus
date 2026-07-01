import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { FileBox, FileCheck, Mail, Pencil, PackageOpen, History, CalendarClock, MoreHorizontal, ShieldAlert, Phone, Plus, AlertCircle, MessageSquarePlus, Pin, PinOff, RotateCcw, AlertTriangle, Wallet, BadgePercent } from 'lucide-react'
import { Badge, Button, Card, Field, Input, Loading, Modal, PageTitle, Select, Textarea } from '../components/ui'
import UndoToast from '../components/UndoToast'
import { baht, conditionLabel, installmentLabel, statusLabel, thaiDate } from '../lib/format'
import {
  getContract,
  getInstallments,
  getPaymentLog,
  getContractExtensions,
  getRateSets,
  getFollowUps,
  recordPaymentWithPenalty,
  overridePenalty,
  getPenaltyOverrideHistory,
  getExtraCharges,
  insertExtraCharge,
  deleteExtraCharge,
  getOtherIncome,
  insertOtherIncome,
  deleteOtherIncome,
  adjustPayment,
  cancelPayment,
  restructureContract,
  closeReturnedContract,
  getSettlementTiers,
  settleContractEarly,
  submitReturn,
  setContractFlags,
  getMyPrivateNote,
  getAllPrivateNotes,
  savePrivateNote,
  deletePrivateNote,
  pinToInbox,
  unpinFromInbox,
  getInboxCases,
  getShops,
  markDocsReceived,
  markBoxReceived,
  revertDocReceipt,
  setDocsIncomplete,
  getDocRejectLog,
  type DocRejectEntry,
  type ContractFlagPatch,
  type PaymentLogEntry,
  type ExtensionRecord,
  type ExtensionType,
  type ReturnInput,
  type FollowUpEntry,
  type FollowUpContactMethod,
  type FollowUpResult,
  type PenaltyOverrideHistoryEntry,
} from '../lib/db'
import {
  activeRateSets,
  multiplierFor,
  termsOf,
  type RateSet,
} from '../lib/rates'
import { calcSummary, calcExtensionPrincipal } from '../lib/calc'
import { computeSettlement, type SettlementTier } from '../lib/settlement'
import { COURIERS } from '../lib/returnWorkflow'
import { sumExtraCharges, totalOutstanding as calcTotalOutstanding, outstandingAfterReturn, type OutstandingAfterReturnResult } from '../lib/outstandingExtras'
import { getComplianceErrorMessage } from '../lib/complianceErrors'
import { boxRequired, DOC_BOX_RULE_CUTOFF, DOC_ITEM_KEYS, DOC_ITEM_LABELS, formatIncompleteItems } from '../lib/docTracking'
import { useAuth } from '../lib/auth'
import type { Contract, ExtraCharge, Installment, OtherIncome, PrivateNote } from '../lib/types'
import FollowUpModal from '../components/FollowUpModal'
import CopyBox from '../components/CopyBox'
import { buildPendingDocMessage } from '../lib/messages'

export const EXT_TYPE_LABEL: Record<ExtensionType, string> = {
  due_day: 'เปลี่ยนวันที่ชำระ',
  months: 'ขยายจำนวนงวด',
  both: 'เปลี่ยนวันชำระ + ขยายงวด',
}

/** สิทธิ์ที่ใช้ไปแล้วของสัญญา (ขยายได้สิทธิ์ละครั้ง) */
export function usedExtRights(exts: ExtensionRecord[]): { date: boolean; months: boolean } {
  return {
    date: exts.some((e) => e.extType === 'due_day' || e.extType === 'both'),
    months: exts.some((e) => e.extType === 'months' || e.extType === 'both'),
  }
}

/** ประเภทที่ยังขยายได้ (ตามสิทธิ์ที่เหลือ) */
export function allowedExtTypes(exts: ExtensionRecord[]): ExtensionType[] {
  const u = usedExtRights(exts)
  if (!u.date && !u.months) return ['both', 'due_day', 'months']
  if (u.date && !u.months) return ['months']
  if (!u.date && u.months) return ['due_day']
  return []
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

// ===== ป้ายกำกับ FollowUp (ใช้เฉพาะในหน้านี้ — ไม่ import จากไฟล์อื่น) =====
const FU_METHOD_LABEL: Record<FollowUpContactMethod, string> = {
  phone: 'โทร',
  line: 'Line',
  sms: 'SMS',
  visit: 'ไปพบ',
  other: 'อื่นๆ',
}
const FU_RESULT_LABEL: Record<FollowUpResult, string> = {
  contacted: 'ติดต่อสำเร็จ',
  promised: 'สัญญาจะจ่าย',
  paid: 'จ่ายแล้ว',
  refused: 'ปฏิเสธ',
  no_answer: 'ไม่รับสาย',
  returned: 'คืนเครื่อง',
  line_pending: 'นัดทาง LINE – รอลูกค้า',
  other: 'อื่นๆ',
}
type BadgeTone = 'green' | 'amber' | 'red' | 'neutral'
const FU_RESULT_TONE: Record<FollowUpResult, BadgeTone> = {
  contacted: 'green',
  promised: 'green',
  paid: 'green',
  refused: 'amber',
  no_answer: 'neutral',
  returned: 'red',
  line_pending: 'amber',
  other: 'neutral',
}

export default function ContractDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { role, name: userName } = useAuth()
  const isAdmin = role === 'admin'
  const canStaff = role === 'admin' || role === 'staff'

  const [contract, setContract] = useState<Contract | null>(null)
  const [installments, setInstallments] = useState<Installment[]>([])
  const [log, setLog] = useState<PaymentLogEntry[]>([])
  const [extensions, setExtensions] = useState<ExtensionRecord[]>([])
  const [rateSets, setRateSets] = useState<RateSet[]>([])
  const [extraCharges, setExtraCharges] = useState<ExtraCharge[]>([])
  const [otherIncomeItems, setOtherIncomeItems] = useState<OtherIncome[]>([])
  const [addOtherIncomeOpen, setAddOtherIncomeOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [returnOpen, setReturnOpen] = useState(false)
  const [extendOpen, setExtendOpen] = useState(false)
  const [settleOpen, setSettleOpen] = useState(false)
  // ปิดสัญญา (คืนเครื่อง): modal ยืนยัน + loading guard + error
  const [closeReturnOpen, setCloseReturnOpen] = useState(false)
  const [closeReturnBusy, setCloseReturnBusy] = useState(false)
  const [closeReturnErr, setCloseReturnErr] = useState<string | null>(null)
  const [flagsOpen, setFlagsOpen] = useState(false)
  // โมดัลชำระเงิน: เก็บงวดที่กำลังทำ + โหมด ('pay' รับชำระ / 'edit' แก้ไขยอด)
  const [payTarget, setPayTarget] = useState<{ ins: Installment; mode: 'pay' | 'edit' } | null>(null)
  const [cancelTarget, setCancelTarget] = useState<Installment | null>(null)
  const [histTarget, setHistTarget] = useState<Installment | null>(null) // โมดัลประวัติของงวดหนึ่ง
  const [penaltyOverrideTarget, setPenaltyOverrideTarget] = useState<Installment | null>(null)
  const [addExtraOpen, setAddExtraOpen] = useState(false)
  const [followHistory, setFollowHistory] = useState<FollowUpEntry[]>([])
  const [followHistoryLoading, setFollowHistoryLoading] = useState(true)
  const [penaltyOverrideHistory, setPenaltyOverrideHistory] = useState<PenaltyOverrideHistoryEntry[]>([])

  // ===== Private Notes =====
  const [myNote, setMyNote] = useState<PrivateNote | null>(null)
  const [allNotes, setAllNotes] = useState<PrivateNote[]>([])
  const [noteDraft, setNoteDraft] = useState('')
  const [noteSaving, setNoteSaving] = useState(false)
  const [noteErr, setNoteErr] = useState<string | null>(null)
  const [noteSaved, setNoteSaved] = useState(false) // subtle save indicator
  const [noteDeleteTarget, setNoteDeleteTarget] = useState<PrivateNote | null>(null) // confirm delete modal
  const [noteAdminTab, setNoteAdminTab] = useState<'mine' | 'all'>('mine') // admin tab

  // Soft-undo state สำหรับ deleteExtraCharge (Sub-task A)
  const [undoKey, setUndoKey] = useState(0)
  type UndoState = { label: string; onUndo: () => Promise<void> } | null
  const [undoState, setUndoState] = useState<UndoState>(null)

  // ===== FollowUpModal + pin state =====
  const [followUpOpen, setFollowUpOpen] = useState(false)
  const [isPinned, setIsPinned] = useState(false)
  const [pinBusy, setPinBusy] = useState(false)
  const [contractShopName, setContractShopName] = useState('')

  // ===== ตีกลับเอกสาร/กล่อง =====
  const [revertTarget, setRevertTarget] = useState<'docs' | 'box' | null>(null)
  const [docRejectLog, setDocRejectLog] = useState<DocRejectEntry[]>([])

  // ===== ธงเอกสารไม่ครบ/ต้องแก้ไข =====
  const [docsIncompleteEditing, setDocsIncompleteEditing] = useState(false) // เปิดส่วนเลือก checkbox
  const [docsIncompleteDraft, setDocsIncompleteDraft] = useState<string[]>([]) // คีย์ที่เลือกอยู่
  const [docsIncompleteSaving, setDocsIncompleteSaving] = useState(false)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    const [c, ins, lg, ext, rs, ec, poh, oi] = await Promise.all([
      getContract(id),
      getInstallments(id),
      getPaymentLog(id),
      getContractExtensions(id),
      getRateSets(),
      getExtraCharges(id),
      getPenaltyOverrideHistory(id),
      getOtherIncome(id),
    ])
    setContract(c)
    setInstallments(ins)
    setLog(lg)
    setExtensions(ext)
    setRateSets(rs)
    setExtraCharges(ec)
    setPenaltyOverrideHistory(poh)
    setOtherIncomeItems(oi)
    setLoading(false)
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!id) return
    setFollowHistoryLoading(true)
    getFollowUps(id)
      .then(setFollowHistory)
      .finally(() => setFollowHistoryLoading(false))
  }, [id])

  // โหลดสถานะ pin ของสัญญานี้
  useEffect(() => {
    if (!id) return
    getInboxCases()
      .then((cases) => {
        setIsPinned(cases.some((c) => c.contractId === id && c.pinned))
      })
      .catch(() => {/* ไม่มี inbox_pins table ใน mock mode — ข้ามเงียบๆ */})
  }, [id])

  // โหลดประวัติตีกลับเอกสาร/กล่อง
  useEffect(() => {
    if (!id) return
    getDocRejectLog(id)
      .then(setDocRejectLog)
      .catch(() => setDocRejectLog([]))
  }, [id])

  // โหลดชื่อร้านสำหรับแสดงใน FollowUpModal
  useEffect(() => {
    if (!contract?.shopId) return
    getShops()
      .then((shops) => {
        const shop = shops.find((s) => s.id === contract.shopId)
        if (shop) setContractShopName(shop.name)
      })
      .catch(() => {/* ข้ามในโหมด mock */})
  }, [contract?.shopId])

  const reloadNotes = useCallback(async () => {
    if (!id) return
    const mine = await getMyPrivateNote(id)
    setMyNote(mine)
    if (isAdmin) {
      const all = await getAllPrivateNotes(id)
      setAllNotes(all)
    }
  }, [id, isAdmin])

  // โหลดโน้ตครั้งแรก
  useEffect(() => { reloadNotes() }, [reloadNotes])

  // sync draft เมื่อ myNote โหลดมาแล้ว (หลัง async)
  useEffect(() => { setNoteDraft(myNote?.content ?? '') }, [myNote])

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
  const extraChargesSum = sumExtraCharges(extraCharges)
  const principalRemaining = installments.reduce((s, i) => s + Math.max(0, i.amount - i.paidAmount), 0)
  const totalOutstandingAmt = calcTotalOutstanding(penaltyDue, extraChargesSum, principalRemaining)
  // เงินดาวน์ + ค่าเอกสาร (ชำระ ณ วันเริ่มสัญญา — ไม่ดันเข้า installments state)
  const _summary = contract.devicePrice
    ? calcSummary(contract.devicePrice, contract.downPercent, contract.commissionPercent, contract.docFee)
    : null
  const downPayment = _summary ? Math.round(contract.devicePrice - _summary.afterDown) : 0
  const downPlusDoc = downPayment + contract.docFee
  const downRowDate = contract.transactionDate ?? installments[0]?.dueDate
  // ยอดคงค้างหลังคืนเครื่อง (แสดงแทน totalOutstanding เมื่อคืนเครื่อง — ทั้งยังตามเก็บ + ปิดเคสแล้ว)
  const isReturned = contract.status === 'returned' || contract.status === 'returned_closed'
  const returnedOutstanding: OutstandingAfterReturnResult | null =
    isReturned ? outstandingAfterReturn(installments, extraCharges) : null
  // เลขงวดค้างเก่าสุด = งวดเดียวที่ยังตามเก็บตามกฎคืนเครื่อง
  const oldestUnpaidNo = returnedOutstanding?.details?.installmentNo ?? null

  // จัดกลุ่มประวัติการชำระตามงวด + แยก 3 ทาง:
  // - logByIns: ผูกกับงวดปัจจุบัน
  // - orphanLogs: งวดถูกลบตอนขยายเวลา (installmentId != null แต่ไม่อยู่ใน live)
  // - downLogs: เงินดาวน์ (installmentId == null — ไม่เคยผูกกับงวด)
  const liveInsIds = new Set(installments.map((i) => i.id))
  const logByIns = new Map<string, PaymentLogEntry[]>()
  const orphanLogs: PaymentLogEntry[] = []
  const downLogs: PaymentLogEntry[] = []
  for (const e of log) {
    if (e.installmentId && liveInsIds.has(e.installmentId)) {
      const arr = logByIns.get(e.installmentId)
      if (arr) arr.push(e)
      else logByIns.set(e.installmentId, [e])
    } else if (e.installmentId == null) {
      downLogs.push(e)
    } else {
      orphanLogs.push(e)
    }
  }

  // สิทธิ์ขยายที่ยังเหลือ (ขยาย/เปลี่ยนวันที่ ได้สิทธิ์ละครั้ง)
  const canExtend = allowedExtTypes(extensions).length > 0

  async function handleSaveNote() {
    if (!id) return
    setNoteSaving(true)
    setNoteErr(null)
    setNoteSaved(false)
    try {
      await savePrivateNote(id, noteDraft.trim())
      await reloadNotes()
      setNoteSaved(true)
    } catch (e) {
      setNoteErr(errMsg(e))
    } finally {
      setNoteSaving(false)
    }
  }

  async function handleDeleteNote(note: PrivateNote) {
    try {
      await deletePrivateNote(note.id)
      await reloadNotes()
      setNoteDeleteTarget(null)
      // ถ้าลบโน้ตของตัวเอง → เคลียร์ draft ด้วย
      if (note.userId === myNote?.userId) setNoteDraft('')
    } catch (e) {
      setNoteErr(errMsg(e))
      setNoteDeleteTarget(null)
    }
  }

  async function handleTogglePin() {
    if (!id) return
    setPinBusy(true)
    try {
      if (isPinned) {
        await unpinFromInbox(id)
        setIsPinned(false)
      } else {
        await pinToInbox(id)
        setIsPinned(true)
      }
    } finally {
      setPinBusy(false)
    }
  }

  // ยืนยันรับชำระยอดปิดครบ → flip สถานะ returned → returned_closed
  async function handleCloseReturned() {
    if (!contract) return
    setCloseReturnBusy(true)
    setCloseReturnErr(null)
    try {
      await closeReturnedContract(contract.id, userName ?? 'ไม่ทราบ')
      setCloseReturnOpen(false)
      await load()
    } catch (e) {
      setCloseReturnErr(errMsg(e))
    } finally {
      setCloseReturnBusy(false)
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-ink">{contract.customerName}</h2>
          <p className="text-sm text-ink-soft">
            สัญญา {contract.contractNo} · {contract.model} {contract.storage} · {conditionLabel(contract.condition)}
          </p>
          {(contract.emailSentAt || contract.summarySentAt) && (
            <div className="mt-1 flex flex-wrap items-center gap-3">
              {contract.emailSentAt && (
                <span className="flex items-center gap-1 text-xs text-ink-soft">
                  <Mail className="h-3 w-3" />
                  {`ส่งอีเมลแล้ว · ${thaiDate(contract.emailSentAt.slice(0, 10))} · โดย ${contract.emailSentBy ?? 'ไม่ทราบ'}`}
                </span>
              )}
              {contract.summarySentAt && (
                <span className="flex items-center gap-1 text-xs text-ink-soft">
                  <FileCheck className="h-3 w-3" />
                  {`สรุปยอดแล้ว · ${thaiDate(contract.summarySentAt.slice(0, 10))} · โดย ${contract.summarySentBy ?? 'ไม่ทราบ'}`}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={contract.status === 'active' ? 'green' : 'neutral'}>{statusLabel(contract.status)}</Badge>
          {contract.pendingDocuments && <Badge tone="amber">รอเอกสาร</Badge>}
          {/* บันทึกการคุย — admin และ staff */}
          {canStaff && (
            <Button variant="ghost" onClick={() => setFollowUpOpen(true)}>
              <MessageSquarePlus size={15} /> บันทึกการคุย
            </Button>
          )}
          {/* เพิ่ม/เอาออกจากกล่อง — admin และ staff */}
          {canStaff && (
            <Button
              variant="ghost"
              disabled={pinBusy}
              onClick={() => void handleTogglePin()}
            >
              {isPinned ? (
                <><PinOff size={15} /> เอาออกจากกล่อง</>
              ) : (
                <><Pin size={15} /> เพิ่มเข้ากล่อง</>
              )}
            </Button>
          )}
          {/* แก้ไขสัญญา — admin เสมอ, staff ได้เมื่อยังไม่ยืนยัน */}
          {canStaff && (
            isAdmin || !(contract.emailSentAt && contract.summarySentAt)
              ? (
                <Button variant="ghost" onClick={() => navigate(`/edit/${contract.id}`)}>
                  <Pencil size={15} /> แก้ไข
                </Button>
              ) : (
                <span className="rounded-xl px-3 py-1.5 text-xs text-ink-soft">
                  ยืนยันแล้ว — แก้ไม่ได้ (ติดต่อแอดมิน)
                </span>
              )
          )}
          {/* ขยายระยะเวลา + คืนเครื่อง — admin และ staff */}
          {canStaff && contract.status === 'active' && (
            <>
              {canExtend ? (
                <Button variant="ghost" onClick={() => setExtendOpen(true)}>
                  <CalendarClock size={15} /> ขยายระยะเวลา
                </Button>
              ) : (
                <span className="rounded-xl bg-peach-light/60 px-3 py-1.5 text-xs text-ink-soft">
                  ใช้สิทธิ์ขยายระยะเวลาครบแล้ว
                </span>
              )}
              {/* ปิดสัญญาก่อนกำหนด — แสดงเมื่อยังมีงวดค้าง */}
              {(principalRemaining > 0 || installments.some((i) => !i.paidAt)) && (
                <Button variant="ghost" onClick={() => setSettleOpen(true)}>
                  <BadgePercent size={15} /> ปิดสัญญาก่อนกำหนด
                </Button>
              )}
              <Button onClick={() => setReturnOpen(true)}>
                <PackageOpen size={15} /> คืนเครื่อง
              </Button>
            </>
          )}
        </div>
      </div>

      {/* สรุป — เมื่อคืนเครื่องแล้วให้ซ่อน "ยอดค้างรวม" (เงินต้นเต็ม) เพราะมี breakdown หลังคืนด้านล่างแทน */}
      <div className={`mb-4 grid gap-3 ${returnedOutstanding !== null ? 'sm:grid-cols-4' : 'sm:grid-cols-5'}`}>
        {[
          { l: 'ค่าเช่า/เดือน', v: `${baht(contract.monthlyPayment)} ฿` },
          { l: 'งวดที่ชำระแล้ว', v: `${paidCount}/${contract.termMonths}` },
          { l: 'ชำระทุกวันที่', v: String(contract.dueDay) },
          { l: 'ค่าปรับค้าง', v: `${baht(penaltyDue)} ฿` },
          // ซ่อน "ยอดค้างรวม" เมื่อ returned — breakdown ที่ถูกต้องอยู่ด้านล่าง
          ...(returnedOutstanding === null
            ? [{ l: 'ยอดค้างรวม', v: `${baht(totalOutstandingAmt)} ฿` }]
            : []),
        ].map((x) => (
          <Card key={x.l} className="py-3">
            <p className="text-xs text-ink-soft">{x.l}</p>
            <p className="text-lg font-bold text-ink whitespace-nowrap">{x.v}</p>
          </Card>
        ))}
      </div>

      {/* ยอดคงค้างหลังคืนเครื่อง — แสดงเฉพาะ status='returned' */}
      {returnedOutstanding !== null && (
        <Card className="mb-4 border-amber-200 bg-amber-50 py-3">
          <p className="mb-2 text-sm font-semibold text-amber-800">ยอดคงค้างหลังคืนเครื่อง</p>
          <div className="grid gap-2 text-sm sm:grid-cols-4">
            <div>
              <p className="text-xs text-ink-soft">
                ค่างวด{returnedOutstanding.details ? ` (งวด ${returnedOutstanding.details.installmentNo})` : ''}
              </p>
              <p className="font-semibold text-ink whitespace-nowrap">{baht(returnedOutstanding.installmentAmount)} ฿</p>
            </div>
            <div>
              <p className="text-xs text-ink-soft">ค่าปรับ</p>
              <p className="font-semibold text-ink whitespace-nowrap">{baht(returnedOutstanding.penaltyAmount)} ฿</p>
            </div>
            <div>
              <p className="text-xs text-ink-soft">ค่าซ่อม</p>
              <p className="font-semibold text-ink whitespace-nowrap">{baht(returnedOutstanding.repairCost)} ฿</p>
            </div>
            <div>
              <p className="text-xs text-ink-soft">ค่าใช้จ่ายอื่น</p>
              <p className="font-semibold text-ink whitespace-nowrap">{baht(returnedOutstanding.otherExtras)} ฿</p>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-end justify-between gap-2 border-t border-amber-200 pt-2">
            <div>
              <p className="text-xs text-ink-soft">ยอดรวมที่ต้องชำระ</p>
              <p className="text-xl font-bold text-amber-700 whitespace-nowrap">{baht(returnedOutstanding.total)} ฿</p>
            </div>
            {/* ปิดสัญญา (คืนเครื่อง) — admin + staff: ยืนยันว่ารับชำระยอดปิดครบแล้ว */}
            {canStaff && (
              <Button onClick={() => { setCloseReturnErr(null); setCloseReturnOpen(true) }}>
                <FileCheck size={15} /> ปิดสัญญา (คืนเครื่อง)
              </Button>
            )}
          </div>
        </Card>
      )}

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

      {/* เลขอ้างอิงเครื่อง + ลูกค้า (เลขบัตรเต็มเฉพาะหน้านี้) */}
      <Card className="mb-4 py-3">
        <div className="grid gap-3 text-sm sm:grid-cols-4">
          <div>
            <p className="text-xs text-ink-soft">เลข INV</p>
            <p className="font-semibold text-ink">{contract.invNo || '—'}</p>
          </div>
          <div>
            <p className="text-xs text-ink-soft">หมายเลข SN</p>
            <p className="font-semibold text-ink">{contract.sn || '—'}</p>
          </div>
          <div>
            <p className="text-xs text-ink-soft">หมายเลข IMEI</p>
            <p className="font-semibold text-ink">{contract.imei || '—'}</p>
          </div>
          <div>
            <p className="text-xs text-ink-soft">เลขบัตรประชาชน</p>
            <p className="font-semibold text-ink">{contract.nationalId || '—'}</p>
          </div>
          <div>
            <p className="text-xs text-ink-soft">สีเครื่อง</p>
            <p className="font-semibold text-ink">{contract.color || '—'}</p>
          </div>
          <div>
            <p className="text-xs text-ink-soft">อำเภอ / เขต</p>
            <p className="font-semibold text-ink">{contract.district || '—'}</p>
          </div>
          <div>
            <p className="text-xs text-ink-soft">จังหวัด</p>
            <p className="font-semibold text-ink">{contract.province || '—'}</p>
          </div>
        </div>
      </Card>

      {/* ===== สถานะพิเศษ (admin + staff เห็น; freelancer ซ่อน) ===== */}
      {canStaff && (
        <Card className="mb-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <ShieldAlert size={15} /> สถานะพิเศษ
            </p>
            <Button variant="ghost" onClick={() => setFlagsOpen(true)}>
              แก้ไขสถานะ
            </Button>
          </div>
          <p className="mt-1 text-xs text-ink-soft">
            DNC / มีทนายความ / โต้แย้งยอด — แก้ไขโดยผู้ดูแลระบบหรือพนักงาน (ปลดโดย admin เท่านั้น)
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {contract.pendingDocuments ? (
              <Badge tone="amber">รอเอกสาร (Case Online)</Badge>
            ) : null}
            {contract.dnc ? (
              <Badge tone="red">ห้ามติดต่อ (DNC)</Badge>
            ) : null}
            {contract.lawyerEngaged ? (
              <Badge tone="amber">มีทนายความ</Badge>
            ) : null}
            {contract.disputed ? (
              <Badge tone="amber">โต้แย้งยอดหนี้</Badge>
            ) : null}
            {!contract.pendingDocuments && !contract.dnc && !contract.lawyerEngaged && !contract.disputed && (
              <span className="text-xs text-ink-soft">— ไม่มีสถานะพิเศษ</span>
            )}
          </div>

          {/* ===== รายการเอกสารที่รอ (read-only — แก้ที่หน้าแก้ไขสัญญา) ===== */}
          {contract.pendingDocuments && contract.pendingDocItems && contract.pendingDocItems.length > 0 && (
            <>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {contract.pendingDocItems.map((item) => (
                  <span
                    key={item}
                    className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs text-amber-800"
                  >
                    {item}
                  </span>
                ))}
              </div>
              <div className="mt-3">
                <CopyBox
                  title="แจ้งร้านค้า — เอกสารที่ยังขาด"
                  text={contractShopName ? buildPendingDocMessage(contract, contractShopName) : ''}
                />
              </div>
            </>
          )}
        </Card>
      )}

      {/* ===== รับเอกสารตัวจริง + กล่องเครื่อง (admin + staff; ทุกสถานะรวม closed — ต้องเช็คเอกสาร/กล่องคืนจากร้านย้อนหลังได้) ===== */}
      {canStaff && (
        <Card className="mb-4 py-3">
          <p className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink">
            <FileBox size={15} /> รับเอกสาร/กล่อง (ร้านส่งคืน)
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {/* ===== เอกสารตัวจริง ===== */}
            <div>
              <p className="mb-1 text-xs text-ink-soft">เอกสารตัวจริง</p>
              {contract.originalDocsReceived ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="flex items-center gap-1 text-sm text-green-700">
                    <FileCheck size={14} />
                    {`รับแล้ว · ${contract.originalDocsReceivedAt ? thaiDate(contract.originalDocsReceivedAt.slice(0, 10)) : '—'} · โดย ${contract.originalDocsReceivedBy ?? 'ไม่ทราบ'}`}
                  </p>
                  <Button
                    variant="ghost"
                    onClick={() => setRevertTarget('docs')}
                    className="text-xs text-red-600 hover:bg-red-50"
                  >
                    <RotateCcw size={13} /> ตีกลับ
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Badge tone="amber">รอรับ</Badge>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      void markDocsReceived(contract.id, userName ?? undefined).then(() => {
                        const now = new Date().toISOString()
                        setContract((prev) =>
                          prev
                            ? {
                                ...prev,
                                originalDocsReceived: true,
                                originalDocsReceivedAt: now,
                                originalDocsReceivedBy: userName ?? null,
                              }
                            : prev,
                        )
                      })
                    }}
                  >
                    ติ๊กรับเอกสาร
                  </Button>
                </div>
              )}

              {/* ===== ธงเอกสารไม่ครบ/ต้องแก้ไข (แสดงเฉพาะเมื่อรับเอกสารแล้ว) ===== */}
              {contract.originalDocsReceived === true && (() => {
                const isFlagged = contract.docsIncomplete === true
                const flaggedItems = contract.docsIncompleteItems ?? []

                async function saveFlag(items: string[]) {
                  if (!contract) return
                  setDocsIncompleteSaving(true)
                  try {
                    await setDocsIncomplete(contract.id, items, userName ?? 'ไม่ทราบ')
                    const now = new Date().toISOString()
                    const hasItems = items.length > 0
                    setContract((prev) =>
                      prev
                        ? {
                            ...prev,
                            docsIncomplete: hasItems,
                            docsIncompleteItems: items,
                            docsIncompleteAt: hasItems ? now : null,
                            docsIncompleteBy: hasItems ? (userName ?? null) : null,
                          }
                        : prev,
                    )
                    setDocsIncompleteEditing(false)
                  } finally {
                    setDocsIncompleteSaving(false)
                  }
                }

                function openEditor() {
                  setDocsIncompleteDraft(isFlagged ? [...flaggedItems] : [])
                  setDocsIncompleteEditing(true)
                }

                function toggleDraft(key: string) {
                  setDocsIncompleteDraft((prev) =>
                    prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
                  )
                }

                return (
                  <div className="mt-2">
                    {/* แถบเตือนเมื่อติดธงอยู่ */}
                    {isFlagged && (
                      <div className="mb-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2">
                        <p className="flex items-center gap-1.5 text-sm font-medium text-amber-800">
                          <AlertTriangle size={14} />
                          เอกสารไม่ครบ: {formatIncompleteItems(flaggedItems) || '—'}
                        </p>
                        {(contract.docsIncompleteBy || contract.docsIncompleteAt) && (
                          <p className="mt-0.5 text-xs text-amber-700">
                            {`โดย ${contract.docsIncompleteBy ?? 'ไม่ทราบ'}`}
                            {contract.docsIncompleteAt
                              ? ` · ${thaiDate(contract.docsIncompleteAt.slice(0, 10))}`
                              : ''}
                          </p>
                        )}
                      </div>
                    )}

                    {/* ส่วนเลือก checkbox (inline) */}
                    {docsIncompleteEditing ? (
                      <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2.5">
                        <p className="mb-1.5 text-xs font-medium text-ink-soft">
                          เลือกเอกสารที่ขาด/ต้องแก้ไข
                        </p>
                        <div className="flex flex-col gap-1.5">
                          {DOC_ITEM_KEYS.map((key) => (
                            <label
                              key={key}
                              className="flex cursor-pointer items-center gap-1.5 text-sm text-ink"
                            >
                              <input
                                type="checkbox"
                                checked={docsIncompleteDraft.includes(key)}
                                onChange={() => toggleDraft(key)}
                                className="h-3.5 w-3.5 accent-salmon-deep"
                              />
                              {DOC_ITEM_LABELS[key]}
                            </label>
                          ))}
                        </div>
                        <div className="mt-2.5 flex flex-wrap items-center gap-2">
                          <Button
                            onClick={() => void saveFlag(docsIncompleteDraft)}
                            disabled={docsIncompleteDraft.length === 0 || docsIncompleteSaving}
                            className="px-3 py-1.5 text-xs"
                          >
                            บันทึก
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => setDocsIncompleteEditing(false)}
                            disabled={docsIncompleteSaving}
                            className="px-3 py-1.5 text-xs"
                          >
                            ยกเลิก
                          </Button>
                        </div>
                      </div>
                    ) : isFlagged ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="ghost"
                          onClick={openEditor}
                          className="px-3 py-1.5 text-xs"
                        >
                          แก้รายการ
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => void saveFlag([])}
                          disabled={docsIncompleteSaving}
                          className="px-3 py-1.5 text-xs text-green-700 hover:bg-green-50"
                        >
                          <FileCheck size={13} /> แก้ครบแล้ว / เคลียร์ธง
                        </Button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={openEditor}
                        className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 hover:text-amber-800 hover:underline"
                      >
                        <AlertTriangle size={13} /> เอกสารไม่ครบ / ต้องแก้ไข
                      </button>
                    )}
                  </div>
                )
              })()}
            </div>
            {/* ===== กล่องเครื่อง ===== */}
            <div>
              <p className="mb-1 text-xs text-ink-soft">กล่องเครื่อง</p>
              {boxRequired(contract) && contract.phoneBoxReceived !== true && (
                <div className="mb-1">
                  <Badge tone="red">📦 มือหนึ่ง ต้องมีกล่อง</Badge>
                </div>
              )}
              {/* toggle "มีกล่องเครื่อง" — แก้ has_phone_box หลังสร้างสัญญา
                  มือหนึ่งบังคับมีกล่อง (new + createdAt >= cutoff) → read-only ปลดไม่ได้
                  มือสอง / มือหนึ่งก่อน cutoff → ติ๊กได้ */}
              {contract.condition === 'new' &&
              (contract.createdAt ?? '').slice(0, 10) >= DOC_BOX_RULE_CUTOFF ? (
                <p className="mb-2 flex items-center gap-1.5 text-xs text-ink-soft">
                  <input type="checkbox" checked disabled className="h-3.5 w-3.5 accent-salmon-deep" />
                  มีกล่อง (บังคับ - มือหนึ่ง)
                </p>
              ) : (
                <label className="mb-2 flex cursor-pointer items-center gap-1.5 text-xs text-ink">
                  <input
                    type="checkbox"
                    checked={contract.hasPhoneBox === true}
                    onChange={() => {
                      const nextHasBox = !contract.hasPhoneBox
                      void setContractFlags(contract.id, { hasPhoneBox: nextHasBox }).then(() => {
                        setContract((prev) =>
                          prev ? { ...prev, hasPhoneBox: nextHasBox } : prev,
                        )
                      })
                    }}
                    className="h-3.5 w-3.5 accent-salmon-deep"
                  />
                  สินค้ามีกล่อง (ติ๊กเมื่อร้านส่งกล่องมา)
                </label>
              )}
              {!boxRequired(contract) ? (
                <p className="text-sm text-ink-soft">ร้านแจ้งว่าไม่มีกล่อง</p>
              ) : contract.phoneBoxReceived ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="flex items-center gap-1 text-sm text-green-700">
                    <FileCheck size={14} />
                    {`รับแล้ว · ${contract.phoneBoxReceivedAt ? thaiDate(contract.phoneBoxReceivedAt.slice(0, 10)) : '—'} · โดย ${contract.phoneBoxReceivedBy ?? 'ไม่ทราบ'}`}
                  </p>
                  <Button
                    variant="ghost"
                    onClick={() => setRevertTarget('box')}
                    className="text-xs text-red-600 hover:bg-red-50"
                  >
                    <RotateCcw size={13} /> ตีกลับ
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Badge tone="amber">รอรับ</Badge>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      void markBoxReceived(contract.id, userName ?? undefined).then(() => {
                        const now = new Date().toISOString()
                        setContract((prev) =>
                          prev
                            ? {
                                ...prev,
                                phoneBoxReceived: true,
                                phoneBoxReceivedAt: now,
                                phoneBoxReceivedBy: userName ?? null,
                              }
                            : prev,
                        )
                      })
                    }}
                  >
                    ติ๊กรับกล่อง
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* ===== ประวัติตีกลับ (แสดงเมื่อมีประวัติ) ===== */}
          {docRejectLog.length > 0 && (
            <div className="mt-3 border-t border-peach pt-3">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink-soft">
                <RotateCcw size={12} /> ประวัติตีกลับ ({docRejectLog.length} ครั้ง)
              </p>
              <ol className="flex flex-col gap-1.5">
                {docRejectLog.map((e) => (
                  <li key={e.id} className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                    <span className="font-semibold">
                      ตีกลับ{e.itemType === 'docs' ? 'เอกสาร' : 'กล่อง'}:
                    </span>{' '}
                    {e.reason}
                    <span className="ml-2 text-red-500">
                      · {thaiDate(e.rejectedAt.slice(0, 10))} · โดย {e.rejectedBy ?? 'ไม่ทราบ'}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </Card>
      )}

      {/* ===== ประวัติการติดตาม (admin + staff เห็น) ===== */}
      {canStaff && (
        <FollowHistory entries={followHistory} loading={followHistoryLoading} />
      )}

      {/* ===== โน้ตส่วนตัว (ทุก role เห็น) ===== */}
      <Card className="mb-4 py-3">
        <p className="mb-3 text-sm font-semibold text-ink">โน้ตส่วนตัว</p>

        {/* Admin: 2 tabs */}
        {isAdmin && (
          <div className="mb-3 flex gap-1 rounded-xl bg-peach-light/40 p-1">
            <button
              onClick={() => setNoteAdminTab('mine')}
              className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${noteAdminTab === 'mine' ? 'bg-white text-ink shadow-sm' : 'text-ink-soft hover:text-ink'}`}
            >
              โน้ตของฉัน
            </button>
            <button
              onClick={() => setNoteAdminTab('all')}
              className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${noteAdminTab === 'all' ? 'bg-white text-ink shadow-sm' : 'text-ink-soft hover:text-ink'}`}
            >
              โน้ตทุกคน (Admin)
              {allNotes.length > 0 && (
                <span className="ml-1 rounded-full bg-salmon-deep/20 px-1.5 py-0.5 text-xs text-salmon-deep">
                  {allNotes.length}
                </span>
              )}
            </button>
          </div>
        )}

        {/* Tab: โน้ตของฉัน (แสดงทุก role, หรือ admin tab='mine') */}
        {(!isAdmin || noteAdminTab === 'mine') && (
          <div className="flex flex-col gap-2">
            <div className="relative">
              <Textarea
                value={noteDraft}
                onChange={(e) => {
                  setNoteDraft(e.target.value.slice(0, 2000))
                  setNoteSaved(false)
                }}
                placeholder="ยังไม่มีโน้ต — เริ่มเขียนได้เลย"
                rows={4}
                maxLength={2000}
              />
              <span className="absolute bottom-2 right-3 text-xs text-ink-soft">
                {noteDraft.length} / 2000
              </span>
            </div>
            <p className="text-xs text-ink-soft">โน้ตนี้เห็นเฉพาะคุณและแอดมิน</p>
            {noteErr && <p className="text-sm text-red-600">{noteErr}</p>}
            {noteSaved && (
              <p className="text-xs text-green-700">บันทึกแล้ว</p>
            )}
            <div className="flex items-center gap-2">
              <Button
                onClick={handleSaveNote}
                disabled={noteSaving || noteDraft.trim() === (myNote?.content ?? '').trim()}
              >
                {noteSaving ? 'กำลังบันทึก...' : 'บันทึกโน้ต'}
              </Button>
              {myNote && (
                <Button
                  variant="ghost"
                  onClick={() => setNoteDeleteTarget(myNote)}
                >
                  ลบโน้ต
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Tab: โน้ตทุกคน (admin เท่านั้น) */}
        {isAdmin && noteAdminTab === 'all' && (
          <div>
            {allNotes.length === 0 ? (
              <p className="text-sm text-ink-soft">ยังไม่มีโน้ตจากพนักงานคนใด</p>
            ) : (
              <ol className="flex flex-col divide-y divide-peach/60">
                {allNotes.map((n) => (
                  <li key={n.id} className="py-3 text-sm first:pt-0 last:pb-0">
                    <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-ink">{n.authorName ?? 'ไม่ทราบชื่อ'}</span>
                      <span className="text-xs text-ink-soft">{thaiDateTime(n.updatedAt)}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-ink">{n.content}</p>
                    <div className="mt-1.5">
                      <button
                        onClick={() => setNoteDeleteTarget(n)}
                        className="rounded px-2 py-0.5 text-xs text-red-600 hover:bg-red-50"
                      >
                        ลบ
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
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
              {/* บรรทัดพิเศษ: เงินดาวน์ + ค่าเอกสาร — ชำระแล้ว ณ วันเริ่มสัญญา */}
              {downPlusDoc > 0 && (
                <tr className="bg-green-50/40">
                  <td className="px-3 py-2.5 whitespace-nowrap text-xs text-ink-soft">เงินดาวน์ + ค่าเอกสาร</td>
                  <td className="px-3 py-2.5">{downRowDate ? thaiDate(downRowDate) : '—'}</td>
                  <td className="px-3 py-2.5">{baht(downPlusDoc)}</td>
                  <td className="px-3 py-2.5">{baht(downPlusDoc)}</td>
                  <td className="px-3 py-2.5 text-ink-soft">-</td>
                  <td className="px-3 py-2.5"><Badge tone="green">ชำระแล้ว</Badge></td>
                  <td className="px-3 py-2.5" />
                </tr>
              )}
              {installments.map((i, idx) => {
                const remaining = Math.max(0, i.amount - i.paidAmount)
                const partial = !i.paidAt && i.paidAmount > 0
                // ป้ายสถานะกรณีคืนเครื่อง (เรียง else-if ก่อน logic เดิม)
                const returnedClosedUnpaid = contract.status === 'returned_closed' && !i.paidAt
                const returnPendingOldest =
                  contract.status === 'returned' && !i.paidAt && i.installmentNo === oldestUnpaidNo
                const returnNotCollect =
                  (contract.status === 'returned' && !i.paidAt && i.installmentNo !== oldestUnpaidNo) ||
                  returnedClosedUnpaid
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
                    {/* #3 — ค่าปรับ: admin คลิกได้เพื่อ override, staff เห็น display only */}
                    <td className="px-3 py-2.5">
                      {i.penaltyAmount > 0 ? (
                        <span className="inline-flex items-center gap-1.5">
                          {isAdmin ? (
                            <button
                              onClick={() => setPenaltyOverrideTarget(i)}
                              className="rounded px-1 py-0.5 text-left hover:bg-amber-50 hover:text-amber-700"
                              title="คลิกเพื่อแก้ไขค่าปรับ (admin)"
                            >
                              {baht(i.penaltyAmount)} ({i.penaltyDays}ว.)
                            </button>
                          ) : (
                            <span>{baht(i.penaltyAmount)} ({i.penaltyDays}ว.)</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-ink-soft">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {i.paidAt ? (
                        <Badge tone="green">{installmentLabel(i.status)}</Badge>
                      ) : partial ? (
                        <Badge tone="amber">ชำระบางส่วน</Badge>
                      ) : returnedClosedUnpaid ? (
                        <Badge tone="neutral">ไม่เก็บแล้ว (ปิดเคสคืนเครื่อง)</Badge>
                      ) : returnPendingOldest ? (
                        <Badge tone="amber">ค้างชำระ</Badge>
                      ) : returnNotCollect ? (
                        <Badge tone="neutral">ไม่เก็บแล้ว (คืนเครื่อง)</Badge>
                      ) : (
                        <Badge tone={i.status === 'paid' ? 'green' : i.status === 'late' ? 'red' : 'amber'}>
                          {installmentLabel(i.status)}
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <RowActions
                        ins={i}
                        hasLog={logByIns.has(i.id)}
                        logCount={logByIns.get(i.id)?.length ?? 0}
                        canStaff={canStaff}
                        notCollectible={returnNotCollect}
                        onPay={() => setPayTarget({ ins: i, mode: 'pay' })}
                        onEdit={() => setPayTarget({ ins: i, mode: 'edit' })}
                        onCancel={() => setCancelTarget(i)}
                        onHistory={() => setHistTarget(i)}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* #4 — ค่าใช้จ่ายอื่นๆ */}
      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="font-semibold text-ink">ค่าใช้จ่ายอื่นๆ</h3>
          {/* admin+staff เพิ่มได้ */}
          {canStaff && (
            <Button variant="ghost" onClick={() => setAddExtraOpen(true)}>
              <Plus size={14} /> เพิ่มค่าใช้จ่าย
            </Button>
          )}
        </div>
        {extraCharges.length === 0 ? (
          <p className="rounded-xl bg-peach-light/40 px-4 py-3 text-sm text-ink-soft">
            ยังไม่มีค่าใช้จ่ายอื่นๆ
          </p>
        ) : (
          <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
            <table className="w-full min-w-[540px] text-sm">
              <thead>
                <tr className="bg-peach-light text-left text-ink">
                  {['วันที่', 'เหตุผล', 'ยอด', 'ผู้บันทึก', ''].map((h, i) => (
                    <th key={h || i} className="px-3 py-2.5 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {extraCharges.map((ec, idx) => (
                  <tr key={ec.id} className={idx % 2 ? 'bg-white' : 'bg-peach-light/20'}>
                    <td className="px-3 py-2.5 whitespace-nowrap">{thaiDate(ec.createdAt.slice(0, 10))}</td>
                    <td className="px-3 py-2.5">{ec.reason}</td>
                    <td className="px-3 py-2.5 font-semibold text-red-600 whitespace-nowrap">{baht(ec.amount)} ฿</td>
                    <td className="px-3 py-2.5 text-ink-soft">{ec.createdBy || '—'}</td>
                    <td className="px-3 py-2.5">
                      {/* admin เท่านั้นที่ลบได้ — ใช้ soft-undo 5 วินาที */}
                      {isAdmin && (
                        <button
                          onClick={async () => {
                            const snapshot = { ...ec }
                            await deleteExtraCharge(snapshot.id)
                            await load()
                            setUndoState({
                              label: `ลบ "${snapshot.reason}" แล้ว`,
                              onUndo: async () => {
                                await insertExtraCharge(
                                  snapshot.contractId,
                                  snapshot.amount,
                                  snapshot.reason,
                                  snapshot.createdBy ?? '',
                                )
                                await load()
                                setUndoState(null)
                              },
                            })
                            setUndoKey((k) => k + 1)
                          }}
                          className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                        >
                          ลบ
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {extraCharges.length > 0 && (
          <p className="mt-2 text-right text-sm text-ink-soft">
            รวมค่าใช้จ่ายอื่นๆ <b className="text-ink whitespace-nowrap">{baht(extraChargesSum)} ฿</b>
          </p>
        )}
      </div>

      {/* #4b — รายได้อื่นๆ ของสัญญานี้ */}
      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="font-semibold text-ink">รายได้อื่นๆ (ของสัญญานี้)</h3>
          {/* admin+staff เพิ่มได้ */}
          {canStaff && (
            <Button variant="ghost" onClick={() => setAddOtherIncomeOpen(true)}>
              <Plus size={14} /> เพิ่มรายได้
            </Button>
          )}
        </div>
        {otherIncomeItems.length === 0 ? (
          <p className="rounded-xl bg-green-50/60 px-4 py-3 text-sm text-ink-soft">
            ยังไม่มีรายได้อื่นๆ
          </p>
        ) : (
          <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-green-200">
            <table className="w-full min-w-[540px] text-sm">
              <thead>
                <tr className="bg-green-50 text-left text-ink">
                  {['วันที่รับ', 'หมวด', 'ยอด', 'หมายเหตุ', 'ผู้บันทึก', ''].map((h, i) => (
                    <th key={h || i} className="px-3 py-2.5 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {otherIncomeItems.map((oi, idx) => (
                  <tr key={oi.id} className={idx % 2 ? 'bg-white' : 'bg-green-50/30'}>
                    <td className="px-3 py-2.5 whitespace-nowrap">{thaiDate(oi.receivedAt)}</td>
                    <td className="px-3 py-2.5">{oi.category}</td>
                    <td className="px-3 py-2.5 font-semibold text-green-600 whitespace-nowrap">{baht(oi.amount)} ฿</td>
                    <td className="px-3 py-2.5 text-ink-soft">{oi.note || '—'}</td>
                    <td className="px-3 py-2.5 text-ink-soft">{oi.recordedBy || '—'}</td>
                    <td className="px-3 py-2.5">
                      {isAdmin && (
                        <button
                          onClick={async () => {
                            if (!window.confirm('ยืนยันลบรายการนี้?')) return
                            try {
                              await deleteOtherIncome(oi.id)
                              await load()
                            } catch (e) {
                              alert(errMsg(e))
                            }
                          }}
                          className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                        >
                          ลบ
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {otherIncomeItems.length > 0 && (
          <p className="mt-2 text-right text-sm text-ink-soft">
            รวมรายได้อื่นๆ{' '}
            <b className="text-green-600 whitespace-nowrap">
              {baht(otherIncomeItems.reduce((s, oi) => s + oi.amount, 0))} ฿
            </b>
          </p>
        )}
      </div>

      {/* ประวัติการแก้ค่าปรับ (admin+staff) */}
      {canStaff && penaltyOverrideHistory.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 flex items-center gap-1.5 font-semibold text-ink">
            <ShieldAlert size={16} /> ประวัติการแก้ค่าปรับ ({penaltyOverrideHistory.length} ครั้ง)
          </h3>
          <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="bg-peach-light text-left text-ink">
                  {['วันที่', 'งวด', 'ค่าปรับเดิม', 'ค่าปรับใหม่', 'เหตุผล', 'โดย'].map((h) => (
                    <th key={h} className="px-3 py-2.5 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {penaltyOverrideHistory.map((e, idx) => (
                  <tr key={e.id} className={idx % 2 ? 'bg-white' : 'bg-peach-light/20'}>
                    <td className="px-3 py-2.5 whitespace-nowrap">{thaiDate(e.createdAt.slice(0, 10))}</td>
                    <td className="px-3 py-2.5">{e.installmentNo != null ? `งวดที่ ${e.installmentNo}` : '—'}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{e.oldAmount != null ? `${baht(e.oldAmount)} ฿` : '—'}</td>
                    <td className="px-3 py-2.5 font-semibold text-amber-700 whitespace-nowrap">{baht(e.newAmount)} ฿</td>
                    <td className="px-3 py-2.5">{e.reason || '—'}</td>
                    <td className="px-3 py-2.5 text-ink-soft">{e.byName || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ประวัติการชำระของงวดที่ถูกแทนที่ (งวดถูกลบตอนขยายระยะเวลา → ไม่ผูกกับงวดปัจจุบัน) */}
      {orphanLogs.length > 0 && (
        <>
          <h3 className="mb-2 mt-6 flex items-center gap-1.5 font-semibold text-ink">
            <History size={16} /> ประวัติการชำระงวดก่อนหน้า (ก่อนขยายระยะเวลา)
          </h3>
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
                {orphanLogs.map((e, idx) => (
                  <tr key={e.id} className={idx % 2 ? 'bg-white' : 'bg-peach-light/20'}>
                    <td className="px-3 py-2.5 whitespace-nowrap">{thaiDateTime(e.createdAt)}</td>
                    <td className="px-3 py-2.5"><Badge tone={ACTION_TONE[e.action]}>{ACTION_LABEL[e.action]}</Badge></td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{e.action === 'cancel' ? '-' : `${baht(e.amount)} ฿`}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{baht(e.paidAmountAfter)} ฿</td>
                    <td className="px-3 py-2.5">{e.byName || '—'}</td>
                    <td className="px-3 py-2.5 text-ink-soft">{e.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ประวัติการชำระเงินดาวน์ (payment_log ที่ไม่ผูกกับงวด — installmentId = null) */}
      {downLogs.length > 0 && (
        <>
          <h3 className="mb-2 mt-6 flex items-center gap-1.5 font-semibold text-ink">
            <Wallet size={16} /> เงินดาวน์
          </h3>
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
                {downLogs.map((e, idx) => (
                  <tr key={e.id} className={idx % 2 ? 'bg-white' : 'bg-peach-light/20'}>
                    <td className="px-3 py-2.5 whitespace-nowrap">{thaiDateTime(e.createdAt)}</td>
                    <td className="px-3 py-2.5"><Badge tone={ACTION_TONE[e.action]}>{ACTION_LABEL[e.action]}</Badge></td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{e.action === 'cancel' ? '-' : `${baht(e.amount)} ฿`}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{baht(e.paidAmountAfter)} ฿</td>
                    <td className="px-3 py-2.5">{e.byName || '—'}</td>
                    <td className="px-3 py-2.5 text-ink-soft">{e.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
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

      {histTarget && (
        <PaymentHistoryModal
          ins={histTarget}
          entries={logByIns.get(histTarget.id) ?? []}
          onClose={() => setHistTarget(null)}
        />
      )}

      {extendOpen && (
        <ExtendModal
          contract={contract}
          installments={installments}
          extensions={extensions}
          rateSets={rateSets}
          onClose={() => setExtendOpen(false)}
          onDone={async () => {
            setExtendOpen(false)
            await load()
          }}
        />
      )}

      {settleOpen && (
        <SettleModal
          contract={contract}
          installments={installments}
          userName={userName ?? 'ไม่ทราบ'}
          onClose={() => setSettleOpen(false)}
          onDone={async () => {
            setSettleOpen(false)
            await load()
          }}
        />
      )}

      {payTarget && (
        <PaymentModal
          ins={payTarget.ins}
          mode={payTarget.mode}
          userName={userName ?? ''}
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

      {/* ปิดสัญญา (คืนเครื่อง) — confirm modal สรุปยอดปิดให้ตรวจก่อนกดยืนยัน */}
      {closeReturnOpen && returnedOutstanding !== null && (
        <Modal title="ปิดสัญญา (คืนเครื่อง)" onClose={() => !closeReturnBusy && setCloseReturnOpen(false)}>
          <p className="mb-3 text-sm text-ink">
            ตรวจยอดปิดที่รับชำระจากลูกค้าก่อนปิดสัญญา
          </p>
          <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
            <div className="flex justify-between py-0.5">
              <span className="text-ink-soft">
                ค่างวด{returnedOutstanding.details ? ` (งวด ${returnedOutstanding.details.installmentNo})` : ''}
              </span>
              <span className="font-semibold text-ink whitespace-nowrap">{baht(returnedOutstanding.installmentAmount)} ฿</span>
            </div>
            <div className="flex justify-between py-0.5">
              <span className="text-ink-soft">ค่าปรับ</span>
              <span className="font-semibold text-ink whitespace-nowrap">{baht(returnedOutstanding.penaltyAmount)} ฿</span>
            </div>
            <div className="flex justify-between py-0.5">
              <span className="text-ink-soft">ค่าซ่อม</span>
              <span className="font-semibold text-ink whitespace-nowrap">{baht(returnedOutstanding.repairCost)} ฿</span>
            </div>
            <div className="flex justify-between py-0.5">
              <span className="text-ink-soft">ค่าใช้จ่ายอื่น</span>
              <span className="font-semibold text-ink whitespace-nowrap">{baht(returnedOutstanding.otherExtras)} ฿</span>
            </div>
            <div className="mt-1 flex justify-between border-t border-amber-200 pt-1.5">
              <span className="font-semibold text-amber-800">ยอดรวม</span>
              <span className="text-lg font-bold text-amber-700 whitespace-nowrap">{baht(returnedOutstanding.total)} ฿</span>
            </div>
          </div>
          <p className="mb-4 text-sm text-ink">
            ยืนยันว่ารับชำระยอดปิดครบแล้ว และต้องการปิดสัญญา (คืนเครื่อง)?
          </p>
          {closeReturnErr && (
            <p className="mb-3 text-sm text-red-600">{closeReturnErr}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={closeReturnBusy} onClick={() => setCloseReturnOpen(false)}>
              ยกเลิก
            </Button>
            <Button disabled={closeReturnBusy} onClick={() => void handleCloseReturned()}>
              {closeReturnBusy ? 'กำลังปิดสัญญา...' : 'ยืนยันปิดสัญญา'}
            </Button>
          </div>
        </Modal>
      )}

      {flagsOpen && (
        <FlagsModal
          contract={contract}
          role={role}
          onClose={() => setFlagsOpen(false)}
          onDone={async () => {
            setFlagsOpen(false)
            await load()
          }}
        />
      )}

      {/* #3 — Penalty override modal (admin only) */}
      {penaltyOverrideTarget && (
        <PenaltyOverrideModal
          ins={penaltyOverrideTarget}
          userName={userName ?? ''}
          onClose={() => setPenaltyOverrideTarget(null)}
          onDone={async () => {
            setPenaltyOverrideTarget(null)
            await load()
          }}
        />
      )}

      {/* #4 — เพิ่มค่าใช้จ่ายอื่นๆ (admin+staff) */}
      {addExtraOpen && id && (
        <AddExtraChargeModal
          contractId={id}
          userName={userName ?? ''}
          onClose={() => setAddExtraOpen(false)}
          onDone={async () => {
            setAddExtraOpen(false)
            await load()
          }}
        />
      )}

      {/* #4b — เพิ่มรายได้อื่นๆ ของสัญญา (admin+staff) */}
      {addOtherIncomeOpen && id && (
        <AddContractOtherIncomeModal
          contractId={id}
          userName={userName ?? ''}
          onClose={() => setAddOtherIncomeOpen(false)}
          onDone={async () => {
            setAddOtherIncomeOpen(false)
            await load()
          }}
        />
      )}

      {/* Confirm ลบโน้ตส่วนตัว */}
      {noteDeleteTarget && (
        <Modal title="ยืนยันลบโน้ต" onClose={() => setNoteDeleteTarget(null)}>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink">
              ต้องการลบโน้ตของ <b>{noteDeleteTarget.authorName ?? 'คนนี้'}</b> ใช่หรือไม่? ไม่สามารถกู้คืนได้
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setNoteDeleteTarget(null)}>ยกเลิก</Button>
              <Button onClick={() => handleDeleteNote(noteDeleteTarget)}>ยืนยันลบ</Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Soft-undo toast (Sub-task A) */}
      {undoState && (
        <UndoToast
          key={undoKey}
          label={undoState.label}
          onUndo={undoState.onUndo}
          onExpire={() => setUndoState(null)}
        />
      )}

      {/* ตีกลับเอกสาร/กล่อง */}
      {revertTarget && id && (
        <RevertDocModal
          contractId={id}
          itemType={revertTarget}
          userName={userName ?? undefined}
          onClose={() => setRevertTarget(null)}
          onDone={() => {
            // capture ค่าก่อน clear (closure ยังเห็นค่าเดิมอยู่ เพราะ setRevertTarget async)
            const wasType = revertTarget
            setRevertTarget(null)
            // optimistic reverse: คืนสถานะกลับเป็น "รอรับ"
            if (wasType === 'docs') {
              setContract((prev) =>
                prev
                  ? { ...prev, originalDocsReceived: false, originalDocsReceivedAt: null, originalDocsReceivedBy: null }
                  : prev,
              )
            } else {
              setContract((prev) =>
                prev
                  ? { ...prev, phoneBoxReceived: false, phoneBoxReceivedAt: null, phoneBoxReceivedBy: null }
                  : prev,
              )
            }
            // reload reject log เพื่อแสดงรายการใหม่ทันที (id guard ครอบแล้วจาก outer condition)
            getDocRejectLog(id)
              .then(setDocRejectLog)
              .catch(() => setDocRejectLog([]))
          }}
        />
      )}

      {/* FollowUpModal — admin/staff บันทึกการคุย */}
      {followUpOpen && (
        <FollowUpModal
          contract={{
            contractId: contract.id,
            contractNo: contract.contractNo,
            customerName: contract.customerName,
            phone: contract.phone ?? null,
            shopName: contractShopName,
            daysLate: 0,
          }}
          adminOverride={role === 'admin'}
          onClose={() => {
            setFollowUpOpen(false)
            // reload follow history ให้ตรง
            if (id) {
              setFollowHistoryLoading(true)
              getFollowUps(id).then(setFollowHistory).finally(() => setFollowHistoryLoading(false))
            }
          }}
        />
      )}
    </div>
  )
}

// ===== ประวัติการติดตามทั้งหมดของสัญญา =====
const MAX_FOLLOW_DISPLAY = 50

function FollowHistory({
  entries,
  loading,
}: {
  entries: FollowUpEntry[]
  loading: boolean
}) {
  const total = entries.length
  const displayed = entries.slice(0, MAX_FOLLOW_DISPLAY)

  return (
    <Card className="mb-4 py-3">
      <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
        <Phone size={15} /> ประวัติการติดตาม
        {!loading && (
          <span className="ml-1 font-normal text-ink-soft">({total} รายการ)</span>
        )}
      </p>

      {loading ? (
        <p className="text-sm text-ink-soft">กำลังโหลด...</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-ink-soft">ยังไม่มีประวัติการติดตาม</p>
      ) : (
        <>
          {total > MAX_FOLLOW_DISPLAY && (
            <p className="mb-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-700">
              แสดง {MAX_FOLLOW_DISPLAY} รายการล่าสุด จากทั้งหมด {total} รายการ
            </p>
          )}
          <ol className="flex flex-col divide-y divide-peach/60">
            {displayed.map((e) => (
              <li key={e.id} className="py-2.5 text-sm first:pt-0 last:pb-0">
                {/* บรรทัด 1: วันเวลา + ชื่อผู้ติดตาม + วิธีติดต่อ + ผลการติดต่อ */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="whitespace-nowrap text-xs text-ink-soft">
                    {thaiDateTime(e.createdAt)}
                  </span>
                  <span className="font-semibold text-ink">{e.authorName}</span>
                  <span className="text-xs text-ink-soft">{FU_METHOD_LABEL[e.contactMethod]}</span>
                  <Badge tone={FU_RESULT_TONE[e.followUpResult]}>
                    {FU_RESULT_LABEL[e.followUpResult]}
                  </Badge>
                </div>
                {/* บรรทัด 2: บันทึก */}
                {e.noteText && (
                  <p className="mt-0.5 text-ink-soft">{e.noteText}</p>
                )}
                {/* บรรทัด 3: ยอดสัญญาจะจ่าย (เฉพาะ promised) */}
                {e.followUpResult === 'promised' && e.promisedAmount != null && (
                  <p className="mt-0.5 text-xs text-green-700 whitespace-nowrap">
                    สัญญาจะจ่าย {baht(e.promisedAmount)} ฿
                  </p>
                )}
                {/* บรรทัด 4: วันนัดชำระ */}
                {e.nextFollowUpAt && (
                  <p className="mt-0.5 text-xs text-ink-soft">
                    นัดวันที่ {thaiDate(e.nextFollowUpAt.slice(0, 10))}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </Card>
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

/** ปุ่มแถวงวด: รับชำระ (primary) + "⋯" overflow menu (แก้ไขยอด/ยกเลิก) + ประวัติ (visible)
 *  a11y: Esc ปิด menu + คืน focus กลับ trigger; click-outside ปิด; เลือก item แล้วปิดอัตโนมัติ */
function RowActions({
  ins,
  hasLog,
  logCount,
  canStaff,
  notCollectible = false,
  onPay,
  onEdit,
  onCancel,
  onHistory,
}: {
  ins: Installment
  hasLog: boolean
  logCount: number
  canStaff: boolean
  notCollectible?: boolean
  onPay: () => void
  onEdit: () => void
  onCancel: () => void
  onHistory: () => void
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // ปิด menu เมื่อกด Esc + คืน focus ไปที่ trigger
  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  // ปิด menu เมื่อคลิกนอก
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  function select(action: () => void) {
    setOpen(false)
    triggerRef.current?.focus()
    action()
  }

  return (
    <div className="relative flex flex-wrap items-center gap-1.5">
      {/* รับชำระ — primary, โชว์เฉพาะ admin+staff ถ้างวดยังไม่ปิด (#5) + ซ่อนถ้างวด "ไม่เก็บแล้ว" (คืนเครื่อง) */}
      {canStaff && !ins.paidAt && !notCollectible && (
        <button
          onClick={onPay}
          className="rounded-lg bg-salmon-deep px-3 py-1 text-xs font-semibold text-white hover:brightness-105"
        >
          รับชำระ
        </button>
      )}

      {/* "⋯" overflow menu — โชว์เมื่อมียอดที่ชำระแล้ว (แก้ไขยอด / ยกเลิก อยู่ใน menu) */}
      {ins.paidAmount > 0 && (
        <div className="relative">
          <button
            ref={triggerRef}
            aria-label="ตัวเลือกเพิ่มเติม"
            aria-expanded={open}
            aria-haspopup="menu"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center justify-center rounded-lg border border-peach p-1 text-ink-soft hover:bg-peach-light/40"
          >
            <MoreHorizontal size={15} />
          </button>

          {open && (
            <div
              ref={menuRef}
              role="menu"
              className="absolute right-0 top-full z-20 mt-1 min-w-[120px] rounded-xl border border-peach bg-white py-1 shadow-lg"
            >
              <button
                role="menuitem"
                onClick={() => select(onEdit)}
                className="w-full px-3 py-2 text-left text-xs font-semibold text-ink-soft hover:bg-peach-light/40"
              >
                แก้ไขยอด
              </button>
              <button
                role="menuitem"
                onClick={() => select(onCancel)}
                className="w-full px-3 py-2 text-left text-xs font-semibold text-red-600 hover:bg-red-50"
              >
                ยกเลิก
              </button>
            </div>
          )}
        </div>
      )}

      {/* ประวัติ — โชว์เสมอถ้ามีประวัติ */}
      {hasLog && (
        <button
          onClick={onHistory}
          title="ประวัติการชำระงวดนี้"
          className="inline-flex items-center gap-1 rounded-lg border border-peach px-2.5 py-1 text-xs font-semibold text-ink-soft hover:bg-peach-light/40"
        >
          <History size={13} /> ประวัติ ({logCount})
        </button>
      )}
    </div>
  )
}

/**
 * MobileModal — Modal ที่ responsive สำหรับ PaymentModal และ ExtendModal
 * Mobile (< md): full-screen, sticky footer แยก scroll body
 * Desktop (md+): centered card เหมือน Modal ใน ui.tsx แต่ wider (max-w-lg)
 */
function MobileModal({
  title,
  onClose,
  footer,
  children,
}: {
  title: string
  onClose: () => void
  footer: ReactNode
  children: ReactNode
}) {
  // ปิดเมื่อกด Esc
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 md:items-center md:p-4"
      onClick={onClose}
    >
      <div
        className="flex w-full flex-col bg-surface shadow-xl max-h-[100dvh] md:max-h-[calc(100dvh-2rem)] md:max-w-lg md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-peach px-5 py-4">
          <h3 className="text-lg font-bold text-ink">{title}</h3>
          <button
            onClick={onClose}
            aria-label="ปิด"
            className="rounded-lg p-1 text-ink-soft hover:bg-peach-light/40"
          >
            ✕
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {children}
        </div>

        {/* Sticky footer */}
        <div className="border-t border-peach px-5 py-4">
          {footer}
        </div>
      </div>
    </div>
  )
}

/** ประวัติการชำระของงวดเดียว (เปิดจากปุ่ม "ประวัติ" ในแถวงวด) */
function PaymentHistoryModal({
  ins,
  entries,
  onClose,
}: {
  ins: Installment
  entries: PaymentLogEntry[]
  onClose: () => void
}) {
  return (
    <Modal title={`ประวัติการชำระ — งวดที่ ${ins.installmentNo}`} onClose={onClose}>
      <div className="flex flex-col gap-2">
        <p className="text-sm text-ink-soft">
          ครบกำหนด {thaiDate(ins.dueDate)} · ค่างวด <span className="whitespace-nowrap">{baht(ins.amount)} ฿</span> · ชำระแล้ว <span className="whitespace-nowrap">{baht(ins.paidAmount)} ฿</span>
        </p>
        {entries.length === 0 ? (
          <p className="rounded-xl bg-peach-light/40 px-3 py-2 text-sm text-ink-soft">ยังไม่มีรายการ</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {entries.map((e) => (
              <li key={e.id} className="rounded-xl border border-peach px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5">
                    <Badge tone={ACTION_TONE[e.action]}>{ACTION_LABEL[e.action]}</Badge>
                    {e.action !== 'cancel' && <b className="text-ink whitespace-nowrap">{baht(e.amount)} ฿</b>}
                  </span>
                  <span className="text-xs text-ink-soft">{thaiDateTime(e.createdAt)}</span>
                </div>
                <p className="mt-1 text-xs text-ink-soft">
                  ยอดสะสมหลังทำ <span className="whitespace-nowrap">{baht(e.paidAmountAfter)} ฿</span> · โดย {e.byName || '—'}
                  {e.note ? ` · ${e.note}` : ''}
                </p>
              </li>
            ))}
          </ol>
        )}
        <div className="mt-1 flex justify-end">
          <Button variant="ghost" onClick={onClose}>ปิด</Button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * #2 — PaymentModal: เพิ่ม field ค่าปรับ + breakdown
 * โหมด 'pay': ใช้ recordPaymentWithPenalty (principal + penalty แยก) — ไม่รับ note
 * โหมด 'edit': ใช้ adjustPayment เดิม (แก้ยอดสะสม — penalty ไม่เกี่ยว, รับ note ได้)
 */
function PaymentModal({
  ins,
  mode,
  userName,
  onClose,
  onDone,
}: {
  ins: Installment
  mode: 'pay' | 'edit'
  userName: string
  onClose: () => void
  onDone: () => void
}) {
  const remaining = Math.max(0, ins.amount - ins.paidAmount)
  // โหมดรับชำระ: ตั้งค่าเริ่มต้น = ยอดค้างที่เหลือ / โหมดแก้ไข: = ยอดสะสมปัจจุบัน
  const [amount, setAmount] = useState<number>(mode === 'pay' ? remaining : ins.paidAmount)
  // ค่าปรับ default = penalty_amount ของงวด (ถ้างวดยังไม่ปิด), 0 ถ้าแก้ไขยอด
  const [penaltyPaid, setPenaltyPaid] = useState<number>(mode === 'pay' ? ins.penaltyAmount : 0)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setErr(null)
    try {
      if (mode === 'pay') {
        // recordPaymentWithPenalty — แยก principal + penalty
        await recordPaymentWithPenalty(ins.id, amount, penaltyPaid, userName)
      } else {
        await adjustPayment(ins.id, amount, note || undefined)
      }
      onDone()
    } catch (e) {
      setErr(errMsg(e))
      setBusy(false)
    }
  }

  const previewTotal = mode === 'pay' ? ins.paidAmount + amount : amount
  const grandTotal = amount + (mode === 'pay' ? penaltyPaid : 0)

  // 3-state สำหรับโหมด 'pay': partial / full / over
  const payState: 'partial' | 'full' | 'over' =
    previewTotal > ins.amount ? 'over' : previewTotal === ins.amount ? 'full' : 'partial'

  // dynamic label ปุ่มบันทึก (โหมด pay)
  const payLabel =
    amount === 0
      ? 'บันทึกการรับชำระ'
      : payState === 'over'
      ? 'บันทึกเกินค่างวด'
      : payState === 'partial'
      ? 'บันทึกทยอยชำระ'
      : 'บันทึกการรับชำระ'

  const numericInputCls =
    'w-full rounded-xl border border-peach bg-surface px-3.5 py-3 text-lg text-ink outline-none transition focus:border-salmon-deep focus:ring-2 focus:ring-salmon/40'

  const payFooter = (
    <div className="flex justify-end gap-2">
      <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
      <Button onClick={save} disabled={busy || amount < 0}>
        {busy ? 'กำลังบันทึก...' : mode === 'pay' ? payLabel : 'บันทึก'}
      </Button>
    </div>
  )

  return (
    <MobileModal
      title={mode === 'pay' ? `รับชำระ — งวดที่ ${ins.installmentNo}` : `แก้ไขยอด — งวดที่ ${ins.installmentNo}`}
      onClose={onClose}
      footer={payFooter}
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-3 gap-2 rounded-xl bg-peach-light/40 p-3 text-sm">
          <div>
            <p className="text-xs text-ink-soft">ค่างวด</p>
            <p className="font-semibold text-ink whitespace-nowrap">{baht(ins.amount)} ฿</p>
          </div>
          <div>
            <p className="text-xs text-ink-soft">ชำระแล้ว</p>
            <p className="font-semibold text-ink whitespace-nowrap">{baht(ins.paidAmount)} ฿</p>
          </div>
          <div>
            <p className="text-xs text-ink-soft">ค้าง</p>
            <p className="font-semibold text-red-600 whitespace-nowrap">{baht(remaining)} ฿</p>
          </div>
        </div>

        <Field label={mode === 'pay' ? 'จำนวนเงินที่รับชำระครั้งนี้ (บาท)' : 'ยอดที่ชำระสะสมใหม่ (บาท)'}>
          <input
            type="text"
            inputMode="decimal"
            pattern="[0-9]*"
            autoFocus
            className={numericInputCls}
            value={amount || ''}
            onChange={(e) => setAmount(Number(e.target.value.replace(/[^0-9]/g, '')) || 0)}
          />
        </Field>
        {mode === 'pay' && (
          <p className="text-xs text-ink-soft -mt-1">
            ใส่จำนวนน้อยกว่าค่างวดได้ (ทยอยชำระ) ระบบจะบันทึกยอดสะสมและเก็บงวดเปิดไว้
          </p>
        )}

        {/* ค่าปรับ: แสดงเฉพาะโหมด 'pay' */}
        {mode === 'pay' && (
          <Field label={`ค่าปรับที่จ่ายครั้งนี้ (บาท) — ค่าปรับคงค้าง ${baht(ins.penaltyAmount)} ฿`}>
            <input
              type="text"
              inputMode="decimal"
              pattern="[0-9]*"
              className={numericInputCls}
              value={penaltyPaid || ''}
              onChange={(e) => setPenaltyPaid(Number(e.target.value.replace(/[^0-9]/g, '')) || 0)}
            />
          </Field>
        )}

        {/* Breakdown: ค่างวด + ค่าปรับ → รวม */}
        {mode === 'pay' && (
          <div className="rounded-xl border border-peach bg-white px-3 py-2.5 text-sm">
            <p className="mb-1.5 font-semibold text-ink">รายละเอียดการรับเงิน</p>
            <div className="flex flex-col gap-1 text-ink-soft">
              <div className="flex justify-between">
                <span>ค่างวดที่รับครั้งนี้</span>
                <span className="font-semibold text-ink whitespace-nowrap">{baht(amount)} ฿</span>
              </div>
              <div className="flex justify-between">
                <span>ค่าปรับที่รับครั้งนี้</span>
                <span className="font-semibold text-ink whitespace-nowrap">{baht(penaltyPaid)} ฿</span>
              </div>
              <div className="mt-1 flex justify-between border-t border-peach pt-1 font-semibold">
                <span className="text-ink">รวมรับทั้งหมด</span>
                <span className="text-ink whitespace-nowrap">{baht(grandTotal)} ฿</span>
              </div>
            </div>
          </div>
        )}

        {mode === 'pay' && ins.penaltyAmount > 0 && (
          <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            หมายเหตุ: ค่าปรับที่รับครั้งนี้บันทึกแยกจากค่างวด — ยอดค้างงวดคำนวณจากค่างวดเท่านั้น
          </p>
        )}

        {mode === 'pay' && (
          <p className={`rounded-lg px-3 py-2 text-sm ${payState === 'full' ? 'bg-green-50 text-green-700' : payState === 'over' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>
            {payState === 'full'
              ? `ครบจำนวน — ยอดสะสม ${baht(previewTotal)} ฿ → งวดจะถูกปิด`
              : payState === 'over'
              ? `เกินค่างวด — ยอดสะสม ${baht(previewTotal)} ฿ (เกิน ${baht(previewTotal - ins.amount)} ฿) กรุณาตรวจสอบ`
              : `ทยอยชำระ — ยอดสะสม ${baht(previewTotal)} ฿ → เหลือค้าง ${baht(ins.amount - previewTotal)} ฿ (งวดยังเปิด)`}
          </p>
        )}
        {mode === 'edit' && (
          <p className={`rounded-lg px-3 py-2 text-sm ${previewTotal >= ins.amount ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
            {previewTotal >= ins.amount
              ? `ยอดสะสมค่างวดจะเป็น ${baht(previewTotal)} ฿ → ปิดงวดนี้ (ชำระครบ)`
              : `ยอดสะสมค่างวดจะเป็น ${baht(previewTotal)} ฿ → ค้างอีก ${baht(Math.max(0, ins.amount - previewTotal))} ฿ (งวดยังเปิด)`}
          </p>
        )}

        {/* Note: แสดงเฉพาะโหมด edit เท่านั้น */}
        {mode === 'edit' && (
          <Field label="หมายเหตุ (ถ้ามี)">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น โอนผ่านธนาคาร / แก้ไขจากกรอกผิด" />
          </Field>
        )}

        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
    </MobileModal>
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
          จะล้างยอดชำระทั้งหมดของงวดนี้ ({baht(ins.paidAmount)} ฿) แล้วคืนเป็น "ค้างชำระ" — บันทึกลงประวัติด้วย
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

/**
 * #3 — PenaltyOverrideModal (admin only)
 * แก้ค่าปรับของงวดที่เลือก + ตั้ง penalty_overridden=true กัน cron reset
 * หมายเหตุ: badge "Override" ต้องรอน้องชีสเพิ่ม penaltyOverridden ใน Installment type + getInstallments mapping
 */
function PenaltyOverrideModal({
  ins,
  userName,
  onClose,
  onDone,
}: {
  ins: Installment
  userName: string
  onClose: () => void
  onDone: () => void
}) {
  const [newAmount, setNewAmount] = useState<number>(ins.penaltyAmount)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    if (!reason.trim()) {
      setErr('กรุณาระบุเหตุผลในการแก้ค่าปรับ')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await overridePenalty(ins.id, newAmount, reason.trim(), userName)
      onDone()
    } catch (e) {
      setErr(errMsg(e))
      setBusy(false)
    }
  }

  return (
    <Modal title={`แก้ไขค่าปรับ — งวดที่ ${ins.installmentNo}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="rounded-xl bg-peach-light/40 px-3 py-2.5 text-sm">
          <p className="text-ink-soft">ค่าปรับปัจจุบัน</p>
          <p className="font-semibold text-ink whitespace-nowrap">{baht(ins.penaltyAmount)} ฿ ({ins.penaltyDays} วัน)</p>
        </div>
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          การแก้ไขค่าปรับจะล็อกค่านี้ไว้ — ระบบอัตโนมัติจะไม่คำนวณค่าปรับซ้ำสำหรับงวดนี้อีก
        </p>
        <Field label="ค่าปรับใหม่ (บาท)">
          <Input
            type="number"
            autoFocus
            value={newAmount || ''}
            onChange={(e) => setNewAmount(Number(e.target.value) || 0)}
          />
        </Field>
        <Field label="เหตุผล (จำเป็น)">
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="เช่น ลูกค้าตกลงจ่ายบางส่วน, ผิดพลาดจากระบบ..."
            rows={2}
          />
        </Field>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
          <Button onClick={save} disabled={busy || newAmount < 0 || !reason.trim()}>
            {busy ? 'กำลังบันทึก...' : 'บันทึกค่าปรับใหม่'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * #4 — AddExtraChargeModal (admin+staff)
 * เพิ่มค่าใช้จ่ายพิเศษ: amount + reason
 */
function AddExtraChargeModal({
  contractId,
  userName,
  onClose,
  onDone,
}: {
  contractId: string
  userName: string
  onClose: () => void
  onDone: () => void
}) {
  const [amount, setAmount] = useState<number>(0)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    if (!reason.trim() || amount <= 0) {
      setErr('กรุณาระบุยอดเงินและเหตุผล')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await insertExtraCharge(contractId, amount, reason.trim(), userName)
      onDone()
    } catch (e) {
      setErr(errMsg(e))
      setBusy(false)
    }
  }

  return (
    <Modal title="เพิ่มค่าใช้จ่ายอื่นๆ" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="ยอดเงิน (บาท)">
          <Input
            type="number"
            autoFocus
            value={amount || ''}
            onChange={(e) => setAmount(Number(e.target.value) || 0)}
          />
        </Field>
        <Field label="เหตุผล / รายละเอียด">
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="เช่น ค่าธรรมเนียมทวงหนี้ / ค่าส่งจดหมายลงทะเบียน"
            rows={2}
          />
        </Field>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
          <Button onClick={save} disabled={busy || amount <= 0 || !reason.trim()}>
            {busy ? 'กำลังบันทึก...' : 'เพิ่มค่าใช้จ่าย'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * RevertDocModal — ตีกลับเอกสารตัวจริง หรือ กล่องโทรศัพท์
 * เหตุผลบังคับกรอก (ปุ่มยืนยันปิดเมื่อว่าง)
 */
function RevertDocModal({
  contractId,
  itemType,
  userName,
  onClose,
  onDone,
}: {
  contractId: string
  itemType: 'docs' | 'box'
  userName?: string
  onClose: () => void
  onDone: () => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const label = itemType === 'docs' ? 'เอกสารตัวจริง' : 'กล่องเครื่อง'

  async function save() {
    if (!reason.trim()) {
      setErr('กรุณาระบุเหตุผลในการตีกลับ')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await revertDocReceipt(contractId, itemType, reason.trim(), userName)
      onDone()
    } catch (e) {
      setErr(errMsg(e))
      setBusy(false)
    }
  }

  return (
    <Modal title={`ตีกลับ${label}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          การตีกลับจะเปลี่ยนสถานะ{label}กลับเป็น "รอรับ" และบันทึกลงประวัติ
        </p>
        <Field label="เหตุผลในการตีกลับ (จำเป็น)">
          <Textarea
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={`เช่น ${itemType === 'docs' ? 'เอกสารไม่ถูกต้อง / เซ็นไม่ครบ' : 'กล่องชำรุด / ไม่ใช่กล่องเดิม'}`}
            rows={2}
          />
        </Field>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
          <Button onClick={save} disabled={busy || !reason.trim()}>
            {busy ? 'กำลังบันทึก...' : 'ยืนยันตีกลับ'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function ExtendModal({
  contract,
  installments,
  extensions,
  rateSets,
  onClose,
  onDone,
}: {
  contract: Contract
  installments: Installment[]
  extensions: ExtensionRecord[]
  rateSets: RateSet[]
  onClose: () => void
  onDone: () => void
}) {
  const unpaidCount = installments.filter((i) => !i.paidAt).length
  const lastPaidNo = installments.filter((i) => i.paidAt).reduce((m, i) => Math.max(m, i.installmentNo), 0)
  const partialPaid = installments
    .filter((i) => !i.paidAt && i.paidAmount > 0)
    .reduce((s, i) => s + i.paidAmount, 0)
  const baseTerm = Math.max(1, unpaidCount)
  // ยอดคงค้าง (Σ amount − paidAmount ของงวดที่ไม่ปิด) — ใช้แสดง breakdown เท่านั้น ไม่ใช้คำนวณค่างวด
  const outstanding = installments.reduce((s, i) => s + Math.max(0, i.amount - i.paidAmount), 0)
  // ค่าปรับค้างชำระรวม
  const penaltyDue = installments.filter((i) => !i.paidAt).reduce((s, i) => s + i.penaltyAmount, 0)
  // เงินต้นแท้ตอนทำสัญญา (สูตรเดียวกับ DB generated column after_down)
  const afterDown = calcSummary(contract.devicePrice, contract.downPercent, contract.commissionPercent, contract.docFee).afterDown

  // #6 — ประวัติการชำระ: งวดที่จ่ายแล้ว (เรียงตาม installmentNo)
  const paidInstallments = installments.filter((i) => i.paidAt).sort((a, b) => a.installmentNo - b.installmentNo)
  const totalPaidAmount = paidInstallments.reduce((s, i) => s + i.paidAmount, 0)

  // ประเภทที่ยังขยายได้ตามสิทธิ์ที่เหลือ (กฎ: ขยาย/เปลี่ยนวันที่ ได้สิทธิ์ละครั้ง)
  const allowed = allowedExtTypes(extensions)
  const [extType, setExtType] = useState<ExtensionType>(allowed[0] ?? 'both')
  const [newDueDay, setNewDueDay] = useState(contract.dueDay)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // ===== ตัวช่วยคิดจากเรต (Option A — Principal-Only) =====
  const liveRateSets = activeRateSets(rateSets)
  const [rateSetId, setRateSetId] = useState(liveRateSets[0]?.id ?? '')
  const rateSet = liveRateSets.find((s) => s.id === rateSetId) ?? null
  const rateTermList = termsOf(rateSet)
  const [rateTerm, setRateTerm] = useState(rateTermList[0] ?? 0)
  const rateMult = multiplierFor(rateSet, rateTerm)

  // เปลี่ยนชุดเรตแล้วงวดเดิมไม่มีในชุดใหม่ → รีเซ็ตเป็นงวดแรกของชุด
  useEffect(() => {
    if (rateTermList.length && !rateTermList.includes(rateTerm)) setRateTerm(rateTermList[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rateSetId])

  // คำนวณ Option A: ใช้เงินต้นแท้ที่เหลือ ไม่คิดดอกซ้อน; หัก partialPaid ที่จ่ายแล้วในงวดที่ยังเปิด
  const calc = useMemo(() => {
    if (extType === 'due_day') return null
    if (afterDown <= 0 || contract.termMonths <= 0) return null
    if (rateMult == null || rateTerm <= 0) return null
    try {
      return calcExtensionPrincipal({
        afterDownOriginal: afterDown,
        originalTerm: contract.termMonths,
        unpaidInstallments: unpaidCount,
        newTerm: rateTerm,
        newRate: rateMult,
        partialPaid,
      })
    } catch {
      return null
    }
  }, [extType, afterDown, contract.termMonths, unpaidCount, rateTerm, rateMult, partialPaid])

  const lockDueDay = extType === 'months' // ขยายงวดอย่างเดียว = วันชำระเดิม

  function changeType(t: ExtensionType) {
    setExtType(t)
    if (t === 'months') {
      setNewDueDay(contract.dueDay)
    }
  }

  // สำหรับ due_day: ใช้งวด/ยอดเดิม; สำหรับ months/both: ใช้ผลจาก calc
  const activeTerm = extType === 'due_day' ? baseTerm : (calc?.newFinance != null ? rateTerm : baseTerm)
  const activeFinance = extType === 'due_day'
    ? Math.round(baseTerm * contract.monthlyPayment)
    : (calc?.newFinance ?? Math.round(baseTerm * contract.monthlyPayment))
  const activeMonthly = extType === 'due_day'
    ? (baseTerm > 0 ? Math.round(Math.round(baseTerm * contract.monthlyPayment) / baseTerm) : 0)
    : (calc?.newMonthly ?? 0)

  const firstNo = lastPaidNo + 1
  const lastNo = lastPaidNo + activeTerm
  const totalTerm = lastPaidNo + activeTerm

  // breakdown สำหรับ months/both
  const oldInterest = outstanding - (calc?.principalRemaining ?? outstanding)
  // ยอดค้างรวมใน ExtendModal: outstanding + penaltyDue (ไม่รวม extraCharges ที่ไม่ fetch ในนี้)
  const totalOutstandingLocal = outstanding + penaltyDue

  const canSubmit = newDueDay >= 1 && newDueDay <= 31 && activeTerm > 0 && activeFinance >= 0

  async function save() {
    setBusy(true)
    setErr(null)
    try {
      await restructureContract(contract.id, {
        extType,
        newDueDay,
        newTerm: activeTerm,
        newFinance: activeFinance,
        note: note || undefined,
      })
      onDone()
    } catch (e) {
      setErr(errMsg(e))
      setBusy(false)
    }
  }

  // Guard: สัญญาเก่าไม่มีข้อมูลเงินต้น
  const missingPrincipal = afterDown <= 0 || contract.termMonths <= 0

  // Guard: สัญญาผ่อนหมดแล้ว
  const alreadyPaidOff = unpaidCount === 0

  const extFooter = (
    <div className="flex justify-end gap-2">
      <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
      <Button onClick={save} disabled={busy || !canSubmit || alreadyPaidOff || (extType !== 'due_day' && missingPrincipal)}>
        {busy ? 'กำลังบันทึก...' : 'ยืนยันขยายระยะเวลา'}
      </Button>
    </div>
  )

  return (
    <MobileModal title="ขยายระยะเวลา" onClose={onClose} footer={extFooter}>
      <div className="flex flex-col gap-3">

        {/* Guard: สัญญาผ่อนหมดแล้ว */}
        {alreadyPaidOff && (
          <div className="rounded-xl bg-green-50 px-3 py-2.5 text-sm text-green-700">
            สัญญานี้ผ่อนหมดแล้ว ไม่ต้องขยายระยะเวลา
          </div>
        )}

        {/* Guard: ไม่มีข้อมูลเงินต้น */}
        {!alreadyPaidOff && missingPrincipal && (
          <div className="rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-700">
            สัญญาเก่าไม่มีข้อมูลเงินต้นแท้ ไม่สามารถขยายด้วยสูตรใหม่ — ติดต่อแอดมิน
          </div>
        )}

        {/* #6 — ประวัติการชำระ */}
        {paidInstallments.length > 0 && (
          <div className="rounded-xl border border-peach bg-white p-3">
            <p className="mb-2 text-sm font-semibold text-ink">
              ประวัติการชำระ — จ่ายมาแล้ว {paidInstallments.length} งวด · รวม {baht(totalPaidAmount)} ฿
            </p>
            <ol className="flex max-h-48 flex-col gap-1 overflow-y-auto text-xs text-ink-soft">
              {paidInstallments.map((i) => (
                <li key={i.id} className="flex items-center gap-2">
                  <span className="shrink-0 font-semibold text-green-600">งวด {i.installmentNo} ✓</span>
                  <span className="whitespace-nowrap">{baht(i.paidAmount)} ฿</span>
                  {i.paidAt && (
                    <span className="text-ink-soft">(จ่ายเมื่อ {thaiDate(i.paidAt.slice(0, 10))})</span>
                  )}
                </li>
              ))}
            </ol>
            <p className="mt-2 border-t border-peach pt-2 text-xs">
              เงินต้นคงค้าง: <b className="text-ink whitespace-nowrap">{baht(calc?.principalRemaining ?? outstanding)} ฿</b>
            </p>
          </div>
        )}

        <Field label="ประเภทการขยาย">
          <Select value={extType} onChange={(e) => changeType(e.target.value as ExtensionType)}>
            {allowed.includes('both') && <option value="both">เปลี่ยนวันชำระ + ขยายจำนวนงวด</option>}
            {allowed.includes('due_day') && <option value="due_day">เปลี่ยนวันที่ชำระอย่างเดียว</option>}
            {allowed.includes('months') && <option value="months">ขยายจำนวนงวดอย่างเดียว (วันชำระเดิม)</option>}
          </Select>
          {allowed.length < 3 && (
            <p className="mt-1 text-xs text-amber-700">
              * สัญญานี้เคยใช้สิทธิ์บางส่วนแล้ว — เลือกได้เฉพาะที่ยังเหลือ
            </p>
          )}
        </Field>

        <div className="rounded-xl bg-peach-light/40 px-3 py-2 text-sm text-ink-soft">
          ค้างชำระ <b className="text-ink">{unpaidCount}</b> งวด · จ่ายล่าสุดงวดที่ <b className="text-ink">{lastPaidNo || '-'}</b> · ยอดคงค้าง <b className="text-ink whitespace-nowrap">{baht(outstanding)} ฿</b>
          {partialPaid > 0 && (
            <span className="mt-1 block rounded-lg bg-green-50 px-2 py-1 text-green-700">
              หักยอดที่จ่ายบางส่วน <span className="whitespace-nowrap">{baht(partialPaid)} ฿</span> ออกจากเงินต้นค้างให้ลูกค้าแล้ว
            </span>
          )}
        </div>

        {/* ตัวช่วยคิดจากเรต (เฉพาะตอนขยายงวด) */}
        {extType !== 'due_day' && liveRateSets.length > 0 && (
          <div className="rounded-xl border border-peach bg-peach-light/40 p-3">
            <p className="mb-2 text-sm font-semibold text-ink">เลือกเรตขยาย (คำนวณจากเงินต้นแท้)</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="ชุดเรต">
                <Select value={rateSetId} onChange={(e) => setRateSetId(e.target.value)}>
                  {liveRateSets.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="จำนวนงวดใหม่">
                <Select value={String(rateTerm)} onChange={(e) => setRateTerm(Number(e.target.value))}>
                  {rateTermList.map((t) => (
                    <option key={t} value={t}>{t} งวด</option>
                  ))}
                </Select>
              </Field>
            </div>
            <p className="mt-2 text-xs text-ink-soft">
              เรต: <b className="text-ink">{rateMult ?? '—'}</b> · เงินต้นแท้: <b className="text-ink whitespace-nowrap">{baht(afterDown)} ฿</b> · งวดที่ยังไม่ชำระ: <b className="text-ink">{unpaidCount}</b> งวด
            </p>
          </div>
        )}

        {/* Breakdown ยอดคงค้าง (แสดงเฉพาะขยายงวด + calc พร้อม) */}
        {extType !== 'due_day' && calc != null && (
          <div className="rounded-xl border border-peach-light bg-white p-3 text-sm">
            <p className="mb-2 font-semibold text-ink">รายละเอียดยอดคงค้าง</p>
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-ink-soft">
                <span>ยอดคงค้างรวม (ไม่รวมค่าปรับ)</span>
                <b className="text-ink whitespace-nowrap">{baht(outstanding)} ฿</b>
              </div>
              <div className="flex justify-between pl-4 text-ink-soft">
                <span>เงินต้นค้าง</span>
                <span className="font-semibold text-ink whitespace-nowrap">{baht(calc.principalRemaining)} ฿</span>
              </div>
              <div className="flex justify-between pl-4 text-ink-soft">
                <span>ดอกเบี้ยเก่า (ลูกค้าจ่ายผ่านงวดใหม่)</span>
                <span className="whitespace-nowrap">{baht(Math.max(0, oldInterest))} ฿</span>
              </div>
              {penaltyDue > 0 && (
                <div className="flex justify-between text-ink-soft">
                  <span>ค่าปรับสะสม (จ่ายแยก)</span>
                  <span className="text-red-600 whitespace-nowrap">{baht(penaltyDue)} ฿</span>
                </div>
              )}
              <div className="mt-1 flex justify-between border-t border-peach pt-1 font-semibold">
                <span className="text-ink">รวมทั้งสิ้น</span>
                <span className="text-ink whitespace-nowrap">{baht(totalOutstandingLocal)} ฿</span>
              </div>
            </div>
            <div className="mt-3 rounded-lg bg-peach-light/60 px-3 py-2 text-sm">
              ขยาย <b className="text-ink">{rateTerm}</b> งวด × เรต <b className="text-ink">{rateMult}</b>{' '}
              → ค่างวดใหม่: <b className="text-salmon-deep whitespace-nowrap">{baht(calc.newMonthly)} ฿/เดือน</b>
              {' '}(ยอดจัดไฟแนนซ์ <span className="whitespace-nowrap">{baht(calc.newFinance)} ฿</span>)
            </div>
          </div>
        )}

        <Field label="วันที่ชำระใหม่ (1–31)">
          <Input
            type="number"
            value={newDueDay || ''}
            disabled={lockDueDay}
            onChange={(e) => setNewDueDay(Number(e.target.value) || 0)}
          />
        </Field>

        {/* #6 — Preview งวดใหม่ (ขยับมาอยู่หลัง input วันชำระ) */}
        <div className="rounded-xl border border-peach bg-white px-3 py-2.5 text-sm">
          <p className="font-semibold text-ink">สรุปงวดใหม่</p>
          <p className="text-ink-soft">
            ค่างวดใหม่ <b className="text-ink whitespace-nowrap">{baht(activeMonthly)} ฿/เดือน</b> · งวดเลขที่{' '}
            <b className="text-ink">{firstNo}–{lastNo}</b> ({activeTerm} งวด · รวมทั้งสัญญา {totalTerm} งวด)
          </p>
          <p className="text-ink-soft">
            งวดแรกครบ <b className="text-ink">{previewDueDate(1, newDueDay)}</b> · งวดสุดท้ายครบ{' '}
            <b className="text-ink">{previewDueDate(activeTerm, newDueDay)}</b>
          </p>
          <p className="mt-1 text-red-600">งวดที่ยังไม่จ่าย {unpaidCount} งวด จะถูกลบแล้วสร้างใหม่ตามนี้</p>
        </div>

        <Field label="หมายเหตุ (ถ้ามี)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น ลูกค้าขอลดค่างวด ผ่อนยาวขึ้น" />
        </Field>

        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
    </MobileModal>
  )
}

/**
 * SettleModal: ปิดสัญญาก่อนกำหนด + ส่วนลด
 * - โหลดชั้นส่วนลด (settlement tiers) จาก settings ตอนเปิด
 * - คิดยอดด้วย computeSettlement (pure) จากงวดของสัญญา
 * - ส่วนลดคิดจากเงินต้นที่เหลือเท่านั้น ค่าปรับค้างไม่ลด
 * - ยืนยันแล้วยกเลิกเองไม่ได้ (ยังไม่มี undo) ต้องแจ้งแอดมิน
 */
function SettleModal({
  contract,
  installments,
  userName,
  onClose,
  onDone,
}: {
  contract: Contract
  installments: Installment[]
  userName: string
  onClose: () => void
  onDone: () => void
}) {
  const [tiers, setTiers] = useState<SettlementTier[]>([])
  const [tiersLoading, setTiersLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setTiersLoading(true)
    getSettlementTiers()
      .then(setTiers)
      .catch(() => setTiers([]))
      .finally(() => setTiersLoading(false))
  }, [])

  // คิดยอดปิดจากงวดของสัญญา (map → input ที่ computeSettlement ต้องการ)
  const result = useMemo(
    () =>
      computeSettlement({
        installments: installments.map((i) => ({
          amount: i.amount,
          paidAmount: i.paidAmount,
          penaltyAmount: i.penaltyAmount,
          paidAt: i.paidAt,
        })),
        tiers,
      }),
    [installments, tiers],
  )

  const noRemaining = result.remainingCount === 0

  async function save() {
    setBusy(true)
    setErr(null)
    try {
      await settleContractEarly(
        contract.id,
        {
          remaining: result.remainingPrincipal,
          discount: result.discount,
          paid: result.customerPays,
          penalty: result.penaltyDue,
        },
        userName,
      )
      onDone()
    } catch (e) {
      setErr(errMsg(e))
      setBusy(false)
    }
  }

  const footer = (
    <div className="flex justify-end gap-2">
      <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
      <Button onClick={save} disabled={busy || tiersLoading || noRemaining}>
        {busy ? 'กำลังบันทึก...' : 'ยืนยันปิดสัญญา'}
      </Button>
    </div>
  )

  return (
    <MobileModal title="ปิดสัญญาก่อนกำหนด" onClose={onClose} footer={footer}>
      <div className="flex flex-col gap-3">
        {tiersLoading ? (
          <Loading />
        ) : noRemaining ? (
          <div className="rounded-xl bg-green-50 px-3 py-2.5 text-sm text-green-700">
            สัญญานี้ไม่มีงวดค้าง — ไม่ต้องปิดก่อนกำหนด
          </div>
        ) : (
          <>
            {/* Breakdown ยอดปิด */}
            <div className="rounded-xl border border-peach bg-white p-3 text-sm">
              <p className="mb-2 font-semibold text-ink">รายละเอียดยอดปิดสัญญา</p>
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between text-ink-soft">
                  <span>ค่างวดที่เหลือ ({result.remainingCount} งวด)</span>
                  <b className="text-ink whitespace-nowrap">{baht(result.remainingPrincipal)} ฿</b>
                </div>
                <div className="flex justify-between text-ink-soft">
                  <span>ส่วนลด {result.percent}%</span>
                  <span className="text-green-700 whitespace-nowrap">−{baht(result.discount)} ฿</span>
                </div>
                {result.penaltyDue > 0 && (
                  <div className="flex justify-between text-ink-soft">
                    <span>ค่าปรับค้าง (ไม่ลด)</span>
                    <span className="text-red-600 whitespace-nowrap">{baht(result.penaltyDue)} ฿</span>
                  </div>
                )}
                <div className="mt-1 flex items-center justify-between border-t border-peach pt-2">
                  <span className="text-sm font-semibold text-ink">ลูกค้าจ่ายปิด</span>
                  <span className="text-2xl font-bold text-salmon-deep whitespace-nowrap">{baht(result.customerPays)} ฿</span>
                </div>
              </div>
              {result.percent === 0 && (
                <p className="mt-2 rounded-lg bg-peach-light/60 px-2.5 py-1.5 text-xs text-ink-soft">
                  จำนวนงวดที่เหลือไม่เข้าชั้นส่วนลดใด — ปิดได้แต่ไม่มีส่วนลด (จ่ายเต็ม)
                </p>
              )}
            </div>

            {/* คำเตือน */}
            <div className="rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
              <p className="flex items-center gap-1.5 font-medium">
                <AlertTriangle size={14} /> ปิดแล้วยกเลิกเองไม่ได้ ต้องแจ้งแอดมินแก้
              </p>
            </div>

            {err && <p className="text-sm text-red-600">{err}</p>}
          </>
        )}
      </div>
    </MobileModal>
  )
}

/**
 * ReturnModal: บันทึกการคืนเครื่อง — รองรับ 2 วิธี
 * - "ส่งพัสดุมา" (shipped): ลูกค้าหรือร้านส่งพัสดุ → เลือกขนส่ง + เลขพัสดุ (db set device_status='in_transit')
 * - "คืนที่ร้าน" (walk_in): ลูกค้าคืนที่ร้านพาร์ทเนอร์ → ระบุรหัส/ร้านที่คืน (db คง pending_check)
 */
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
    returnMethod: 'walk_in',
    courier: '',
    trackingNumber: '',
    returnLocation: '',
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

        {/* ===== วิธีคืนเครื่อง ===== */}
        <Field label="วิธีคืนเครื่อง">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setF((p) => ({ ...p, returnMethod: 'walk_in' }))}
              className={`flex-1 rounded-xl border px-3 py-2.5 text-sm font-semibold transition ${
                f.returnMethod === 'walk_in'
                  ? 'border-salmon-deep bg-salmon/10 text-salmon-deep'
                  : 'border-peach bg-white text-ink-soft hover:bg-peach-light/40'
              }`}
            >
              คืนที่ร้าน
            </button>
            <button
              type="button"
              onClick={() => setF((p) => ({ ...p, returnMethod: 'shipped' }))}
              className={`flex-1 rounded-xl border px-3 py-2.5 text-sm font-semibold transition ${
                f.returnMethod === 'shipped'
                  ? 'border-salmon-deep bg-salmon/10 text-salmon-deep'
                  : 'border-peach bg-white text-ink-soft hover:bg-peach-light/40'
              }`}
            >
              ส่งพัสดุมา
            </button>
          </div>
        </Field>

        {/* shipped — ขนส่ง + เลขพัสดุ */}
        {f.returnMethod === 'shipped' && (
          <>
            <Field label="บริษัทขนส่ง">
              <Select
                value={f.courier ?? ''}
                onChange={(e) => setF((p) => ({ ...p, courier: e.target.value }))}
              >
                <option value="">— เลือกขนส่ง —</option>
                {COURIERS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>
            </Field>
            <Field label="เลขพัสดุ (ถ้ามี)">
              <Input
                value={f.trackingNumber ?? ''}
                onChange={(e) => setF((p) => ({ ...p, trackingNumber: e.target.value }))}
                placeholder="เช่น EE123456789TH"
              />
            </Field>
            {!f.courier && (
              <p className="text-xs text-amber-700">แนะนำให้เลือกขนส่งเพื่อง่ายต่อการติดตาม</p>
            )}
            <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700">
              ระบบจะบันทึกสถานะเครื่องเป็น "อยู่ระหว่างจัดส่ง" — เปลี่ยนเป็น "รอตรวจสอบ" เมื่อของถึงมือพนักงาน
            </p>
          </>
        )}

        {/* walk_in — ร้านที่คืน */}
        {f.returnMethod === 'walk_in' && (
          <>
            <Field label="รหัส/ชื่อร้านที่ลูกค้าคืน (ถ้ามี)">
              <Input
                value={f.returnLocation ?? ''}
                onChange={(e) => setF((p) => ({ ...p, returnLocation: e.target.value }))}
                placeholder="เช่น ร้าน ABC เชียงใหม่ / รหัสร้าน 0012"
              />
            </Field>
            <p className="rounded-lg bg-peach-light/60 px-3 py-2 text-xs text-ink-soft">
              ระบบจะบันทึกสถานะเครื่องเป็น "รอตรวจสอบ"
            </p>
          </>
        )}

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

// ===== ฟอร์มสถานะพิเศษ =====
interface FlagsFormState {
  pendingDocuments: boolean
  dnc: boolean
  dncReason: string
  lawyerEngaged: boolean
  lawyerName: string
  lawyerPhone: string
  lawyerEngagedAt: string
  disputed: boolean
  disputedSince: string
}

/**
 * Modal แก้ไข compliance flags (DNC / มีทนายความ / โต้แย้งยอด)
 * - admin: เซ็ต + ปลดได้ทุกธง
 * - staff: เซ็ตได้ แต่ DB trigger จะ reject การปลด (แสดง error ภาษาไทย)
 */
function FlagsModal({
  contract,
  role,
  onClose,
  onDone,
}: {
  contract: Contract
  role: string | null
  onClose: () => void
  onDone: () => void
}) {
  const [f, setF] = useState<FlagsFormState>(() => ({
    pendingDocuments: contract.pendingDocuments ?? false,
    dnc: contract.dnc ?? false,
    dncReason: contract.dncReason ?? '',
    lawyerEngaged: contract.lawyerEngaged ?? false,
    lawyerName: contract.lawyerName ?? '',
    lawyerPhone: contract.lawyerPhone ?? '',
    lawyerEngagedAt: contract.lawyerEngagedAt ?? '',
    disputed: contract.disputed ?? false,
    disputedSince: contract.disputedSince ?? '',
  }))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  function toggle<K extends keyof FlagsFormState>(key: K, value: FlagsFormState[K]) {
    setF((prev) => ({ ...prev, [key]: value }))
    setErr(null)
  }

  async function save() {
    setBusy(true)
    setErr(null)
    try {
      const patch: ContractFlagPatch = {
        pendingDocuments: f.pendingDocuments,
        dnc: f.dnc,
        dncReason: f.dncReason || null,
        lawyerEngaged: f.lawyerEngaged,
        lawyerName: f.lawyerEngaged ? (f.lawyerName || null) : null,
        lawyerPhone: f.lawyerEngaged ? (f.lawyerPhone || null) : null,
        lawyerEngagedAt: f.lawyerEngaged ? (f.lawyerEngagedAt || null) : null,
        disputed: f.disputed,
        disputedSince: f.disputed ? (f.disputedSince || null) : null,
      }
      await setContractFlags(contract.id, patch)
      onDone()
    } catch (e) {
      // ตรวจ compliance error ก่อน (4 codes จาก trigger)
      const complianceMsg = getComplianceErrorMessage(e)
      if (complianceMsg) {
        setErr(complianceMsg)
        return
      }
      // ตรวจ "permission denied: only admin can unset" จาก trigger ฝั่ง staff
      const raw = errMsg(e)
      if (raw.toLowerCase().includes('only admin can unset')) {
        setErr('เฉพาะแอดมินเท่านั้นที่สามารถปลดสถานะนี้ได้')
      } else {
        setErr(raw)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="แก้ไขสถานะพิเศษ" onClose={onClose}>
      <div className="flex flex-col gap-4">
        {role !== 'admin' && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
            พนักงานสามารถเพิ่มสถานะได้ แต่การปลดสถานะ DNC/ทนาย/โต้แย้งต้องดำเนินการโดยแอดมิน
          </p>
        )}

        {/* รอเอกสาร (Case Online) — admin เท่านั้น */}
        <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-3">
          {role === 'admin' ? (
            <label className="flex items-center gap-2 text-sm font-semibold text-ink">
              <input
                type="checkbox"
                checked={f.pendingDocuments}
                onChange={(e) => toggle('pendingDocuments', e.target.checked)}
                className="h-4 w-4 accent-amber-500"
              />
              รอเอกสาร (Case Online)
            </label>
          ) : (
            <div className="flex items-center gap-2 text-sm font-semibold text-ink-soft">
              <input
                type="checkbox"
                checked={f.pendingDocuments}
                disabled
                className="h-4 w-4 accent-amber-500 opacity-50"
              />
              รอเอกสาร (Case Online)
            </div>
          )}
          <p className="mt-1 text-xs text-ink-soft">
            แก้ไขโดยแอดมินเท่านั้น — เคลียร์อัตโนมัติเมื่อส่งอีเมล/สรุปยอด
          </p>
        </div>

        {/* DNC */}
        <div className="rounded-xl border border-red-200 bg-red-50/40 p-3">
          <label className="flex items-center gap-2 text-sm font-semibold text-ink">
            <input
              type="checkbox"
              checked={f.dnc}
              onChange={(e) => toggle('dnc', e.target.checked)}
              className="h-4 w-4 accent-red-600"
            />
            ห้ามติดต่อ (DNC)
          </label>
          {f.dnc && (
            <div className="mt-2">
              <Field label="เหตุผล (ไม่บังคับ)">
                <Input
                  value={f.dncReason}
                  onChange={(e) => toggle('dncReason', e.target.value)}
                  placeholder="เช่น ลูกค้าขอให้หยุดติดต่อ"
                />
              </Field>
            </div>
          )}
        </div>

        {/* มีทนายความ */}
        <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-3">
          <label className="flex items-center gap-2 text-sm font-semibold text-ink">
            <input
              type="checkbox"
              checked={f.lawyerEngaged}
              onChange={(e) => toggle('lawyerEngaged', e.target.checked)}
              className="h-4 w-4 accent-amber-600"
            />
            มีทนายความเข้าดำเนินคดี
          </label>
          {f.lawyerEngaged && (
            <div className="mt-2 flex flex-col gap-2">
              <Field label="ชื่อทนายความ">
                <Input
                  value={f.lawyerName}
                  onChange={(e) => toggle('lawyerName', e.target.value)}
                  placeholder="ชื่อ-นามสกุลทนายความ"
                />
              </Field>
              <Field label="เบอร์ติดต่อทนายความ">
                <Input
                  value={f.lawyerPhone}
                  onChange={(e) => toggle('lawyerPhone', e.target.value)}
                  placeholder="0xx-xxx-xxxx"
                />
              </Field>
              <Field label="วันที่เริ่มมีทนายความ">
                <input
                  type="date"
                  className="w-full rounded-xl border border-peach bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-salmon-deep focus:ring-2 focus:ring-salmon/40"
                  value={f.lawyerEngagedAt}
                  onChange={(e) => toggle('lawyerEngagedAt', e.target.value)}
                />
              </Field>
            </div>
          )}
        </div>

        {/* โต้แย้งยอด */}
        <div className="rounded-xl border border-yellow-200 bg-yellow-50/40 p-3">
          <label className="flex items-center gap-2 text-sm font-semibold text-ink">
            <input
              type="checkbox"
              checked={f.disputed}
              onChange={(e) => toggle('disputed', e.target.checked)}
              className="h-4 w-4 accent-yellow-600"
            />
            โต้แย้งยอดหนี้
          </label>
          {f.disputed && (
            <div className="mt-2">
              <Field label="เริ่มโต้แย้งเมื่อ">
                <input
                  type="date"
                  className="w-full rounded-xl border border-peach bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-salmon-deep focus:ring-2 focus:ring-salmon/40"
                  value={f.disputedSince}
                  onChange={(e) => toggle('disputedSince', e.target.value)}
                />
              </Field>
            </div>
          )}
        </div>

        {err && <p className="text-sm text-red-600">{err}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
          <Button onClick={save} disabled={busy}>
            {busy ? 'กำลังบันทึก...' : 'บันทึกสถานะ'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * #4b — AddContractOtherIncomeModal (admin+staff)
 * เพิ่มรายได้อื่นๆ ที่ผูกกับสัญญาโดยอัตโนมัติ
 */
function AddContractOtherIncomeModal({
  contractId,
  userName,
  onClose,
  onDone,
}: {
  contractId: string
  userName: string
  onClose: () => void
  onDone: () => void
}) {
  const [amount, setAmount] = useState<number>(0)
  const [category, setCategory] = useState('ค่าเปลี่ยนวันที่ชำระ')
  const [note, setNote] = useState('')
  const [receivedAt, setReceivedAt] = useState(
    new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10),
  )
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    if (amount <= 0 || !category.trim()) {
      setErr('กรุณาระบุหมวดหมู่และยอดเงิน')
      return
    }
    if (!receivedAt) {
      setErr('กรุณาระบุวันที่รับเงิน')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await insertOtherIncome({
        contractId,
        amount,
        category: category.trim(),
        note: note.trim() || undefined,
        receivedAt,
        recordedBy: userName,
      })
      onDone()
    } catch (e) {
      setErr(errMsg(e))
      setBusy(false)
    }
  }

  return (
    <Modal title="เพิ่มรายได้อื่นๆ" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="หมวดหมู่" required>
          <Input
            type="text"
            autoFocus
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="เช่น ค่าเปลี่ยนวันที่ชำระ"
            list="oi-contract-category-suggestions"
          />
          <datalist id="oi-contract-category-suggestions">
            <option value="ค่าเปลี่ยนวันที่ชำระ" />
            <option value="ค่าธรรมเนียมอื่นๆ" />
            <option value="รายได้อื่นๆ" />
          </datalist>
        </Field>
        <Field label="ยอดเงิน (บาท)" required>
          <Input
            type="number"
            min={1}
            value={amount || ''}
            onChange={(e) => setAmount(Number(e.target.value) || 0)}
          />
        </Field>
        <Field label="วันที่รับเงิน" required>
          <Input
            type="date"
            value={receivedAt}
            onChange={(e) => setReceivedAt(e.target.value)}
          />
        </Field>
        <Field label="หมายเหตุ (ไม่บังคับ)">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="รายละเอียดเพิ่มเติม"
            rows={2}
          />
        </Field>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
          <Button onClick={save} disabled={busy || amount <= 0 || !category.trim()}>
            {busy ? 'กำลังบันทึก...' : 'บันทึกรายได้'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
