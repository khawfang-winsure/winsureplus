import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { FileCheck, Mail, Pencil, PackageOpen, History, CalendarClock, MoreHorizontal, ShieldAlert, Phone, Plus, AlertCircle } from 'lucide-react'
import { Badge, Button, Card, Field, Input, Loading, Modal, PageTitle, Select, Textarea } from '../components/ui'
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
  getExtraCharges,
  insertExtraCharge,
  deleteExtraCharge,
  adjustPayment,
  cancelPayment,
  restructureContract,
  submitReturn,
  setContractFlags,
  type ContractFlagPatch,
  type PaymentLogEntry,
  type ExtensionRecord,
  type ExtensionType,
  type ReturnInput,
  type FollowUpEntry,
  type FollowUpContactMethod,
  type FollowUpResult,
} from '../lib/db'
import {
  activeRateSets,
  multiplierFor,
  termsOf,
  type RateSet,
} from '../lib/rates'
import { calcSummary, calcExtensionPrincipal } from '../lib/calc'
import { sumExtraCharges, totalOutstanding as calcTotalOutstanding, outstandingAfterReturn, type OutstandingAfterReturnResult } from '../lib/outstandingExtras'
import { getComplianceErrorMessage } from '../lib/complianceErrors'
import { useAuth } from '../lib/auth'
import type { Contract, ExtraCharge, Installment } from '../lib/types'

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
  const [loading, setLoading] = useState(true)
  const [returnOpen, setReturnOpen] = useState(false)
  const [extendOpen, setExtendOpen] = useState(false)
  const [flagsOpen, setFlagsOpen] = useState(false)
  // โมดัลชำระเงิน: เก็บงวดที่กำลังทำ + โหมด ('pay' รับชำระ / 'edit' แก้ไขยอด)
  const [payTarget, setPayTarget] = useState<{ ins: Installment; mode: 'pay' | 'edit' } | null>(null)
  const [cancelTarget, setCancelTarget] = useState<Installment | null>(null)
  const [histTarget, setHistTarget] = useState<Installment | null>(null) // โมดัลประวัติของงวดหนึ่ง
  const [penaltyOverrideTarget, setPenaltyOverrideTarget] = useState<Installment | null>(null)
  const [addExtraOpen, setAddExtraOpen] = useState(false)
  const [followHistory, setFollowHistory] = useState<FollowUpEntry[]>([])
  const [followHistoryLoading, setFollowHistoryLoading] = useState(true)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    const [c, ins, lg, ext, rs, ec] = await Promise.all([
      getContract(id),
      getInstallments(id),
      getPaymentLog(id),
      getContractExtensions(id),
      getRateSets(),
      getExtraCharges(id),
    ])
    setContract(c)
    setInstallments(ins)
    setLog(lg)
    setExtensions(ext)
    setRateSets(rs)
    setExtraCharges(ec)
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
  // ยอดคงค้างหลังคืนเครื่อง (แสดงแทน totalOutstanding เมื่อ status='returned')
  const returnedOutstanding: OutstandingAfterReturnResult | null =
    contract.status === 'returned'
      ? outstandingAfterReturn(installments, extraCharges)
      : null

  // จัดกลุ่มประวัติการชำระตามงวด + แยกรายการที่งวดถูกลบไปแล้ว (installmentId หลุดเป็น null หลังขยายเวลา)
  const liveInsIds = new Set(installments.map((i) => i.id))
  const logByIns = new Map<string, PaymentLogEntry[]>()
  const orphanLogs: PaymentLogEntry[] = []
  for (const e of log) {
    if (e.installmentId && liveInsIds.has(e.installmentId)) {
      const arr = logByIns.get(e.installmentId)
      if (arr) arr.push(e)
      else logByIns.set(e.installmentId, [e])
    } else {
      orphanLogs.push(e)
    }
  }

  // สิทธิ์ขยายที่ยังเหลือ (ขยาย/เปลี่ยนวันที่ ได้สิทธิ์ละครั้ง)
  const canExtend = allowedExtTypes(extensions).length > 0

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
        <div className="flex items-center gap-2">
          <Badge tone={contract.status === 'active' ? 'green' : 'neutral'}>{statusLabel(contract.status)}</Badge>
          {/* แก้ไขสัญญา — admin only */}
          {isAdmin && (
            <Button variant="ghost" onClick={() => navigate(`/edit/${contract.id}`)}>
              <Pencil size={15} /> แก้ไข
            </Button>
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
            <p className="text-lg font-bold text-ink">{x.v}</p>
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
              <p className="font-semibold text-ink">{baht(returnedOutstanding.installmentAmount)} ฿</p>
            </div>
            <div>
              <p className="text-xs text-ink-soft">ค่าปรับ</p>
              <p className="font-semibold text-ink">{baht(returnedOutstanding.penaltyAmount)} ฿</p>
            </div>
            <div>
              <p className="text-xs text-ink-soft">ค่าซ่อม</p>
              <p className="font-semibold text-ink">{baht(returnedOutstanding.repairCost)} ฿</p>
            </div>
            <div>
              <p className="text-xs text-ink-soft">ค่าใช้จ่ายอื่น</p>
              <p className="font-semibold text-ink">{baht(returnedOutstanding.otherExtras)} ฿</p>
            </div>
          </div>
          <div className="mt-2 border-t border-amber-200 pt-2">
            <p className="text-xs text-ink-soft">ยอดรวมที่ต้องชำระ</p>
            <p className="text-xl font-bold text-amber-700">{baht(returnedOutstanding.total)} ฿</p>
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
            {contract.dnc ? (
              <Badge tone="red">ห้ามติดต่อ (DNC)</Badge>
            ) : null}
            {contract.lawyerEngaged ? (
              <Badge tone="amber">มีทนายความ</Badge>
            ) : null}
            {contract.disputed ? (
              <Badge tone="amber">โต้แย้งยอดหนี้</Badge>
            ) : null}
            {!contract.dnc && !contract.lawyerEngaged && !contract.disputed && (
              <span className="text-xs text-ink-soft">— ไม่มีสถานะพิเศษ</span>
            )}
          </div>
        </Card>
      )}

      {/* ===== ประวัติการติดตาม (admin + staff เห็น) ===== */}
      {canStaff && (
        <FollowHistory entries={followHistory} loading={followHistoryLoading} />
      )}

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
                      {partial ? (
                        <Badge tone="amber">ชำระบางส่วน</Badge>
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
                    <td className="px-3 py-2.5 font-semibold text-red-600">{baht(ec.amount)} ฿</td>
                    <td className="px-3 py-2.5 text-ink-soft">{ec.createdBy || '—'}</td>
                    <td className="px-3 py-2.5">
                      {/* admin เท่านั้นที่ลบได้ */}
                      {isAdmin && (
                        <button
                          onClick={async () => {
                            await deleteExtraCharge(ec.id)
                            await load()
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
            รวมค่าใช้จ่ายอื่นๆ <b className="text-ink">{baht(extraChargesSum)} ฿</b>
          </p>
        )}
      </div>

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
                    <td className="px-3 py-2.5">{e.action === 'cancel' ? '-' : `${baht(e.amount)} ฿`}</td>
                    <td className="px-3 py-2.5">{baht(e.paidAmountAfter)} ฿</td>
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
                  <p className="mt-0.5 text-xs text-green-700">
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
  onPay,
  onEdit,
  onCancel,
  onHistory,
}: {
  ins: Installment
  hasLog: boolean
  logCount: number
  canStaff: boolean
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
      {/* รับชำระ — primary, โชว์เฉพาะ admin+staff ถ้างวดยังไม่ปิด (#5) */}
      {canStaff && !ins.paidAt && (
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
          ครบกำหนด {thaiDate(ins.dueDate)} · ค่างวด {baht(ins.amount)} ฿ · ชำระแล้ว {baht(ins.paidAmount)} ฿
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
                    {e.action !== 'cancel' && <b className="text-ink">{baht(e.amount)} ฿</b>}
                  </span>
                  <span className="text-xs text-ink-soft">{thaiDateTime(e.createdAt)}</span>
                </div>
                <p className="mt-1 text-xs text-ink-soft">
                  ยอดสะสมหลังทำ {baht(e.paidAmountAfter)} ฿ · โดย {e.byName || '—'}
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
  const willClose = previewTotal >= ins.amount
  const grandTotal = amount + (mode === 'pay' ? penaltyPaid : 0)

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

        {/* #2 — ค่าปรับ: แสดงเฉพาะโหมด 'pay' */}
        {mode === 'pay' && (
          <Field label={`ค่าปรับที่จ่ายครั้งนี้ (บาท) — ค่าปรับคงค้าง ${baht(ins.penaltyAmount)} ฿`}>
            <Input
              type="number"
              value={penaltyPaid || ''}
              onChange={(e) => setPenaltyPaid(Number(e.target.value) || 0)}
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
                <span className="font-semibold text-ink">{baht(amount)} ฿</span>
              </div>
              <div className="flex justify-between">
                <span>ค่าปรับที่รับครั้งนี้</span>
                <span className="font-semibold text-ink">{baht(penaltyPaid)} ฿</span>
              </div>
              <div className="mt-1 flex justify-between border-t border-peach pt-1 font-semibold">
                <span className="text-ink">รวมรับทั้งหมด</span>
                <span className="text-ink">{baht(grandTotal)} ฿</span>
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

        <p className={`rounded-lg px-3 py-2 text-sm ${willClose ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
          {willClose
            ? `ยอดสะสมค่างวดจะเป็น ${baht(previewTotal)} ฿ → ปิดงวดนี้ (ชำระครบ)`
            : `ยอดสะสมค่างวดจะเป็น ${baht(previewTotal)} ฿ → ค้างอีก ${baht(Math.max(0, ins.amount - previewTotal))} ฿ (งวดยังเปิด)`}
        </p>

        {/* Note: แสดงเฉพาะโหมด edit เท่านั้น (recordPaymentWithPenalty ไม่รับ note) */}
        {mode === 'edit' && (
          <Field label="หมายเหตุ (ถ้ามี)">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น โอนผ่านธนาคาร / แก้ไขจากกรอกผิด" />
          </Field>
        )}

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
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setErr(null)
    try {
      await overridePenalty(ins.id, newAmount, userName)
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
          <p className="font-semibold text-ink">{baht(ins.penaltyAmount)} ฿ ({ins.penaltyDays} วัน)</p>
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
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
          <Button onClick={save} disabled={busy || newAmount < 0}>
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

  return (
    <Modal title="ขยายระยะเวลา" onClose={onClose}>
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
                  <span>{baht(i.paidAmount)} ฿</span>
                  {i.paidAt && (
                    <span className="text-ink-soft">(จ่ายเมื่อ {thaiDate(i.paidAt.slice(0, 10))})</span>
                  )}
                </li>
              ))}
            </ol>
            <p className="mt-2 border-t border-peach pt-2 text-xs">
              เงินต้นคงค้าง: <b className="text-ink">{baht(calc?.principalRemaining ?? outstanding)} ฿</b>
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
          ค้างชำระ <b className="text-ink">{unpaidCount}</b> งวด · จ่ายล่าสุดงวดที่ <b className="text-ink">{lastPaidNo || '-'}</b> · ยอดคงค้าง <b className="text-ink">{baht(outstanding)} ฿</b>
          {partialPaid > 0 && (
            <span className="mt-1 block rounded-lg bg-green-50 px-2 py-1 text-green-700">
              หักยอดที่จ่ายบางส่วน {baht(partialPaid)} ฿ ออกจากเงินต้นค้างให้ลูกค้าแล้ว
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
              เรต: <b className="text-ink">{rateMult ?? '—'}</b> · เงินต้นแท้: <b className="text-ink">{baht(afterDown)} ฿</b> · งวดที่ยังไม่ชำระ: <b className="text-ink">{unpaidCount}</b> งวด
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
                <b className="text-ink">{baht(outstanding)} ฿</b>
              </div>
              <div className="flex justify-between pl-4 text-ink-soft">
                <span>เงินต้นค้าง</span>
                <span className="font-semibold text-ink">{baht(calc.principalRemaining)} ฿</span>
              </div>
              <div className="flex justify-between pl-4 text-ink-soft">
                <span>ดอกเบี้ยเก่า (ลูกค้าจ่ายผ่านงวดใหม่)</span>
                <span>{baht(Math.max(0, oldInterest))} ฿</span>
              </div>
              {penaltyDue > 0 && (
                <div className="flex justify-between text-ink-soft">
                  <span>ค่าปรับสะสม (จ่ายแยก)</span>
                  <span className="text-red-600">{baht(penaltyDue)} ฿</span>
                </div>
              )}
              <div className="mt-1 flex justify-between border-t border-peach pt-1 font-semibold">
                <span className="text-ink">รวมทั้งสิ้น</span>
                <span className="text-ink">{baht(totalOutstandingLocal)} ฿</span>
              </div>
            </div>
            <div className="mt-3 rounded-lg bg-peach-light/60 px-3 py-2 text-sm">
              ขยาย <b className="text-ink">{rateTerm}</b> งวด × เรต <b className="text-ink">{rateMult}</b>{' '}
              → ค่างวดใหม่: <b className="text-salmon-deep">{baht(calc.newMonthly)} ฿/เดือน</b>
              {' '}(ยอดจัดไฟแนนซ์ {baht(calc.newFinance)} ฿)
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
            ค่างวดใหม่ <b className="text-ink">{baht(activeMonthly)} ฿/เดือน</b> · งวดเลขที่{' '}
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

        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
          <Button onClick={save} disabled={busy || !canSubmit || alreadyPaidOff || (extType !== 'due_day' && missingPrincipal)}>
            {busy ? 'กำลังบันทึก...' : 'ยืนยันขยายระยะเวลา'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * ReturnModal: บันทึกการคืนเครื่อง
 * หมายเหตุ: เลขพัสดุ (tracking_number) รอน้องชีสเพิ่ม ReturnInput.trackingNumber + submitReturn
 * → ยังไม่แสดง field นี้ในโมดัลนี้ กรอกได้ภายหลังที่หน้าไพพ์ไลน์เครื่อง
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

        {/* เลขพัสดุ: กรอกได้ที่หน้าไพพ์ไลน์เครื่องภายหลัง (รอน้องชีสเพิ่ม ReturnInput.trackingNumber) */}

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
            พนักงานสามารถเพิ่มสถานะได้ แต่การปลดสถานะต้องดำเนินการโดยแอดมิน
          </p>
        )}

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
