// EarlyCloseModal — ปิดสัญญาก่อนกำหนดแบบ "คงตารางงวด" (mig 0131)
// แทนที่ SettleModal เดิม (ContractDetail.tsx) ที่บังคับกรอก % ส่วนลด — โมดัลนี้กรอกยอดเงินบาทล้วน
// pure calc มาจาก src/lib/earlyClose.ts (แบมเขียน) — ไฟล์นี้แค่ผูก UI + เรียก db.ts (น้องชีสเขียน)
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Plus, Trash2 } from 'lucide-react'
import { Badge, Button, Field, Input, Modal, Select } from './ui'
import CopyBox from './CopyBox'
import { baht, statusLabel, thaiDate } from '../lib/format'
import {
  closeContractEarlyPreserve,
  getContractExtensions,
  getSettlementMatrix,
  type CloseContractEarlyFee,
  type ExtensionRecord,
  type PaymentLogEntry,
} from '../lib/db'
import { computeEarlyClose, EARLY_CLOSE_FEE_CATEGORIES } from '../lib/earlyClose'
import {
  computeSettlement,
  type SettlementExtensionInfo,
  type SettlementInstallmentInput,
  type SettlementMatrix,
  type SettlementResult,
} from '../lib/settlement'
import { penaltyPaidForInstallment } from '../lib/calc'
import type { Contract, Installment } from '../lib/types'

const CUSTOM_FEE_OPTION = 'อื่นๆ (ระบุเอง)'

interface FeeRowState {
  key: string
  categoryChoice: string // หนึ่งใน EARLY_CLOSE_FEE_CATEGORIES หรือ CUSTOM_FEE_OPTION
  customName: string
  amount: number
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}

/** วันนี้ตามเวลาไทย (Asia/Bangkok) แบบ 'YYYY-MM-DD' — pattern เดียวกับ AddContractOtherIncomeModal ในหน้านี้ */
function todayBangkok(): string {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)
}

/** ค่าปรับที่เก็บไปแล้วจริงต่องวด (เฉพาะงวดที่ยังไม่จ่าย) — ใช้ penaltyPaidForInstallment ตัวเดียวกับ
 *  คอลัมน์ค่าปรับในตารางงวด (ContractDetail.tsx) กันตัวเลขไม่ตรงกัน */
function buildPenaltyPaidMap(
  installments: Installment[],
  logByIns: Map<string, PaymentLogEntry[]>,
): Record<string, number> {
  const map: Record<string, number> = {}
  for (const ins of installments) {
    if (ins.paidAt) continue
    map[ins.id] = penaltyPaidForInstallment(logByIns.get(ins.id) ?? [])
  }
  return map
}

function resolveCategory(row: FeeRowState): string {
  return row.categoryChoice === CUSTOM_FEE_OPTION ? row.customName.trim() : row.categoryChoice
}

interface SuspiciousPaymentRow {
  dateStr: string
  amount: number
  byName: string | null
}

/** เงินที่อาจซ้ำกับยอดปิดสัญญา — รายการรับชำระ (action='pay') ที่เกิดตั้งแต่วันที่ปิด (closedAt) เป็นต้นไป
 *  ใช้วันจ่ายจริงของงวด (installment.paidAt) เป็นหลัก เพราะเป็นวันที่งวดปิดสนิทจริง ถ้างวดยังไม่ปิดสนิท
 *  (จ่ายบางส่วน paidAt=null) ค่อย fallback ไปวันที่บันทึกรายการ (entry.createdAt) — pattern เดียวกับ
 *  buildPenaltyPaidMap ด้านบน กันเลขไม่ตรงกับที่คอลัมน์อื่นในหน้านี้ใช้
 *
 *  ⚠️ ต้องข้ามรายการ 'pay' ที่ถูกยกเลิกไปแล้ว — cancel_payment (mig 0011) reset ยอดงวดแต่ "ไม่ลบ" แถว pay
 *  เดิมใน payment_log แค่เพิ่มแถว cancel ต่อท้าย ถ้านับ pay เดิมด้วยจะเตือนซ้ำซ้อนทั้งที่เงินถูกยกเลิกไปแล้ว
 *  แก้ด้วย pattern เดียวกับ penaltyPaidForInstallment (calc.ts) — ไล่ log ของแต่ละงวดตามลำดับเวลา (เก่า→ใหม่)
 *  เจอ 'cancel' เมื่อไหร่ ทิ้งรายการ 'pay' ที่สะสมมาก่อนหน้าของงวดนั้นทั้งหมด นับเฉพาะ 'pay' ที่ยังไม่โดนยกเลิก
 *  ล่าสุด (เกิดหลัง 'cancel' ล่าสุด หรือไม่มี cancel เลย)
 *
 *  ⚠️ ทิศทาง logByIns: getPaymentLog (db.ts) ดึงมาเรียง created_at ใหม่→เก่า และ ContractDetail.tsx ไม่ได้
 *  re-sort ตอน group เป็น logByIns (แค่ push ตามลำดับที่ได้มา) ดังนั้น logByIns.get(id) คือ "ใหม่→เก่า" —
 *  ต้อง sort เป็น "เก่า→ใหม่" เองก่อน walk (เหมือนที่ penaltyPaidForInstallment ทำ [...entries].sort(...)
 *  ภายในฟังก์ชันเอง ไม่พึ่งลำดับจากผู้เรียก) */
function buildSuspiciousPayments(
  installments: Installment[],
  logByIns: Map<string, PaymentLogEntry[]>,
  closedAt: string,
): { count: number; total: number; rows: SuspiciousPaymentRow[] } {
  const rows: SuspiciousPaymentRow[] = []
  let total = 0
  for (const ins of installments) {
    const entries = logByIns.get(ins.id) ?? []
    const sorted = [...entries].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))

    // เก็บเฉพาะแถว 'pay' ที่ยังไม่ถูกยกเลิก — เจอ 'cancel' เมื่อไหร่ ล้างสะสมของงวดนี้ทิ้งทั้งหมด
    let livePays: PaymentLogEntry[] = []
    for (const entry of sorted) {
      if (entry.action === 'cancel') {
        livePays = []
        continue
      }
      if (entry.action === 'pay') {
        livePays.push(entry)
      }
      // action === 'edit' → ไม่ใช่เงินเข้าใหม่ ไม่นับไม่ล้าง (0-contribution เหมือน penaltyPaidForInstallment)
    }

    for (const entry of livePays) {
      const dateStr = ins.paidAt ? ins.paidAt.slice(0, 10) : entry.createdAt.slice(0, 10)
      if (dateStr < closedAt) continue
      rows.push({ dateStr, amount: entry.amount, byName: entry.byName })
      total += entry.amount
    }
  }
  rows.sort((a, b) => (a.dateStr < b.dateStr ? 1 : a.dateStr > b.dateStr ? -1 : 0))
  return { count: rows.length, total, rows }
}

/** ข้อความสรุปยอดปิดสัญญาก่อนกำหนด สำหรับคัดลอกส่งลูกค้า — รูปแบบเดียวกับที่ทีมส่งลูกค้าจริง
 *  (ตัวอย่าง: "ยอดรวม 30,780 (2565x12 เดือน)" / "ส่วนลด 12% = 3,694 บาท" / "ยอดหลังลด 27,086 บาท" /
 *  "ปิดด่วน 200 บาท" / "รวมชำระ 27,286 บาท" / "สำหรับชำระเพื่อปิดสัญญาภายในวันนี้เท่านั้น ขอบคุณครับ")
 *
 *  แก้ 08 ก.ย. 2026 (feedback คุณเตยจากการทดสอบจริง — ก่อนหน้านี้ข้อความดึงส่วนลด/ยอดจากตารางเสมอ แม้พนักงาน
 *  พิมพ์ยอดปิดเองในช่องจริง (badge "กรอกเอง") ทำให้ข้อความไม่ตรงกับยอดที่กรอก เสี่ยงส่งเลขผิดลูกค้า):
 *  - settlementPaid (ยอดในช่องจริง ณ ขณะนั้น) เป็นฐานของทุกยอดเสมอ ไม่ใช่ preview.remainingPrincipal/discount
 *  - settlementDiscount / totalReceived รับมาจาก computeEarlyClose(result) ตรงๆ — ให้ตรงกับ "รับจริงทั้งหมด"
 *    ที่หน้ายืนยันโชว์ทุกกรณี (ตามตาราง/กรอกเอง)
 *  - isFromTable: true เฉพาะตอน settlementPaid ตรงกับยอดที่ตารางแนะนำ (suggestedSettlementPaid) เป๊ะ — โชว์ %
 *    เฉพาะตอนนั้น ถ้ากรอกเอง (ไม่ตรงตาราง) ไม่ใส่ % ที่ไม่จริง
 *  - ตัดคำว่า "เมื่อวันที่ ..." ออกทั้งหมด แทนด้วยบรรทัดปิดท้ายคงที่
 *  - settlementPaid ว่าง/≤0/ไม่ใช่ตัวเลข → คืน null (caller โชว่ข้อความ "กรอกยอดจ่ายปิดก่อน" แทนกล่องคัดลอก) */
function buildEarlyCloseMessage(params: {
  installments: Installment[]
  preview: SettlementResult
  settlementPaid: number
  settlementDiscount: number
  isFromTable: boolean
  penaltyReceived: number
  fees: { category: string; amount: number }[]
  totalReceived: number
}): string | null {
  const { installments, preview, settlementPaid, settlementDiscount, isFromTable, penaltyReceived, fees, totalReceived } =
    params

  if (!settlementPaid || !Number.isFinite(settlementPaid) || settlementPaid <= 0) return null
  // defense in depth — ชั้นที่ 2 กันโชว์ "ส่วนลดติดลบ" ในข้อความส่งลูกค้า (เช่น ยอดปิดเกินยอดคงเหลือ)
  // ชั้นแรกคือ caller ซ่อน CopyBox ทั้งกล่องเมื่อ result.errors.length > 0 อยู่แล้ว
  if (!Number.isFinite(settlementDiscount) || settlementDiscount < 0) return null

  const unpaid = installments.filter((i) => i.paidAt === null)
  const noPartialPayment = unpaid.every((i) => (i.paidAmount || 0) === 0)
  const perInstallmentAmount = unpaid.length > 0 ? unpaid[0].amount : 0
  const uniformAmount = unpaid.every((i) => i.amount === perInstallmentAmount)
  const canShowMultiply =
    noPartialPayment &&
    uniformAmount &&
    perInstallmentAmount > 0 &&
    perInstallmentAmount * preview.remainingCount === preview.remainingPrincipal

  const lines: string[] = []

  lines.push(
    canShowMultiply
      ? `ยอดรวม ${baht(preview.remainingPrincipal)} (${baht(perInstallmentAmount)}x${preview.remainingCount} เดือน)`
      : `ยอดรวม ${baht(preview.remainingPrincipal)} (เหลือ ${preview.remainingCount} งวด)`,
  )

  lines.push(
    isFromTable
      ? `ส่วนลด ${preview.percent}% = ${baht(settlementDiscount)} บาท`
      : `ส่วนลด ${baht(settlementDiscount)} บาท`,
  )

  // ยอดหลังลด = settlementRemaining − settlementDiscount = settlementPaid เป๊ะเสมอ (นิยาม settlementDiscount
  // มาจาก settlementRemaining − settlementPaid) — ใส่บรรทัดนี้ให้ลูกค้าเห็นที่มาก่อนเจอค่าปรับ/ค่าธรรมเนียม
  lines.push(`ยอดหลังลด ${baht(settlementPaid)} บาท`)

  if (penaltyReceived > 0) {
    lines.push(`ค่าปรับ ${baht(penaltyReceived)} บาท`)
  }

  const validFees = fees.filter((f) => f.amount > 0 && f.category.trim() !== '')
  for (const f of validFees) {
    // ตัดคำนำหน้า "ค่า" ออกให้ตรงข้อความที่ทีมส่งลูกค้าจริง (เช่น "ค่าปิดด่วน" -> "ปิดด่วน")
    // เฉพาะข้อความคัดลอกนี้เท่านั้น — ชื่อเต็มยังใช้แสดงในฟอร์ม/สรุปยืนยันตามเดิม
    lines.push(`${f.category.replace(/^ค่า/, '')} ${baht(f.amount)} บาท`)
  }

  lines.push(`รวมชำระ ${baht(totalReceived)} บาท`)
  lines.push('สำหรับชำระเพื่อปิดสัญญาภายในวันนี้เท่านั้น ขอบคุณครับ')

  return lines.join('\n')
}

let feeRowSeq = 0
function nextFeeRowKey(): string {
  feeRowSeq += 1
  return `fee-${feeRowSeq}`
}

/**
 * EarlyCloseModal: ปิดสัญญาก่อนกำหนด (คงตารางงวด) — กรอกยอดเงินบาทล้วน ไม่มี %
 * - ยอดจ่ายปิด + ค่าปรับที่เก็บ + ค่าธรรมเนียม (0..n รายการ) + วันที่ปิดจริง
 * - ส่วนลดที่ยกให้ = คำนวณให้เอง (read-only) จาก computeEarlyClose (pure, src/lib/earlyClose.ts)
 * - ยืนยัน 2 ขั้น (เหมือน SettleModal เดิม) — ขั้นสุดท้ายมีคำเตือนเรื่อง PJ auto-sync บังคับอ่านก่อนกด
 */
export default function EarlyCloseModal({
  contract,
  installments,
  logByIns,
  onClose,
  onDone,
}: {
  contract: Contract
  installments: Installment[]
  logByIns: Map<string, PaymentLogEntry[]>
  onClose: () => void
  onDone: () => void
}) {
  const todayStr = useMemo(() => todayBangkok(), [])

  const penaltyPaidByInstallmentId = useMemo(
    () => buildPenaltyPaidMap(installments, logByIns),
    [installments, logByIns],
  )

  const [settlementPaid, setSettlementPaid] = useState<number>(0)
  // prefill = penaltyDue ตอนเปิดโมดัล (แก้ได้ทีหลัง แต่ห้ามต่ำกว่า — computeEarlyClose เป็นคนบังคับ)
  const [penaltyReceived, setPenaltyReceived] = useState<number>(() =>
    computeEarlyClose({
      installments,
      settlementPaid: 0,
      penaltyReceived: 0,
      fees: [],
      closedAt: todayStr,
      today: todayStr,
      penaltyPaidByInstallmentId,
    }).penaltyDue,
  )
  const [feeRows, setFeeRows] = useState<FeeRowState[]>([])
  const [closedAt, setClosedAt] = useState(todayStr)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // ===== ตารางส่วนลดปิดสัญญา (settlement matrix, mig 0112) — โหลดเงียบๆ ตอนเปิดโมดัล =====
  // matrix=null แปลว่า "ยังไม่โหลดเสร็จ" หรือ "โหลดไม่สำเร็จ" — ทั้ง 2 กรณี ซ่อนกล่องคำนวณจากตาราง
  // ไปเลย (ข้อบังคับข้อ 4) ไม่บล็อกการปิดสัญญาแบบกรอกยอดเอง
  const [matrix, setMatrix] = useState<SettlementMatrix | null>(null)
  const [extensions, setExtensions] = useState<ExtensionRecord[]>([])
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const m = await getSettlementMatrix()
        if (alive) setMatrix(m)
      } catch {
        if (alive) setMatrix(null)
      }
    })()
    void (async () => {
      try {
        const ext = await getContractExtensions(contract.id)
        if (alive) setExtensions(ext)
      } catch {
        if (alive) setExtensions([])
      }
    })()
    return () => {
      alive = false
    }
  }, [contract.id])

  // เคสขยายเวลาแบบเพิ่มจำนวนงวด (ext_type != 'due_day') — เอาอันล่าสุดที่เข้าเงื่อนไข (list เรียงใหม่→เก่า)
  // ตาม logic ที่ settlement.ts กำหนด (isExtendedInstallmentsCase) — ไฟล์นี้แค่ map ข้อมูล ไม่คิดสูตรเอง
  const extensionInfo = useMemo<SettlementExtensionInfo | null>(() => {
    const match = extensions.find((e) => e.extType !== 'due_day' && e.newInstallments != null)
    return match ? { extType: match.extType, newInstallments: match.newInstallments } : null
  }, [extensions])

  const settlementInstallments = useMemo<SettlementInstallmentInput[]>(
    () =>
      installments.map((i) => ({
        amount: i.amount,
        paidAmount: i.paidAmount,
        penaltyAmount: i.penaltyAmount,
        paidAt: i.paidAt,
        installmentNo: i.installmentNo,
      })),
    [installments],
  )

  // preview จากตารางส่วนลด — reuse computeSettlement (src/lib/settlement.ts) ตรงๆ ห้ามคิดสูตรเอง
  const settlementPreview = useMemo(() => {
    if (matrix == null) return null
    return computeSettlement({
      installments: settlementInstallments,
      termMonths: contract.termMonths,
      matrix,
      extension: extensionInfo,
    })
  }, [matrix, settlementInstallments, contract.termMonths, extensionInfo])

  // ยอดจ่ายปิด (เฉพาะค่างวด ไม่รวมค่าปรับ — ค่าปรับกรอกแยกในช่องถัดไป) ที่ตารางแนะนำ
  const suggestedSettlementPaid = settlementPreview
    ? Math.max(0, settlementPreview.remainingPrincipal - settlementPreview.discount)
    : null

  // จำยอดล่าสุดที่กด "ใช้ยอดนี้" ไว้ — ถ้าผู้ใช้แก้ช่องทีหลังจนไม่ตรงกับยอดนี้แล้ว ป้ายจะเปลี่ยนเป็น "กรอกเอง"
  const [appliedTableValue, setAppliedTableValue] = useState<number | null>(null)
  const isFromTable = appliedTableValue != null && settlementPaid === appliedTableValue

  function applyTableSuggestion() {
    if (suggestedSettlementPaid == null) return
    setSettlementPaid(suggestedSettlementPaid)
    setAppliedTableValue(suggestedSettlementPaid)
  }

  function addFeeRow() {
    setFeeRows((prev) => [
      ...prev,
      { key: nextFeeRowKey(), categoryChoice: EARLY_CLOSE_FEE_CATEGORIES[0], customName: '', amount: 0 },
    ])
  }
  function removeFeeRow(key: string) {
    setFeeRows((prev) => prev.filter((r) => r.key !== key))
  }
  function updateFeeRow(key: string, patch: Partial<FeeRowState>) {
    setFeeRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }

  const fees = useMemo(
    () => feeRows.map((row) => ({ category: resolveCategory(row), amount: row.amount })),
    [feeRows],
  )
  const hasAnyFee = fees.some((f) => f.amount > 0)

  const result = useMemo(
    () =>
      computeEarlyClose({
        installments,
        settlementPaid,
        penaltyReceived,
        fees,
        closedAt,
        today: todayStr,
        penaltyPaidByInstallmentId,
      }),
    [installments, settlementPaid, penaltyReceived, fees, closedAt, todayStr, penaltyPaidByInstallmentId],
  )

  // ตรงกับยอดที่ตารางแนะนำเป๊ะไหม (ไม่ใช่แค่ "เคยกดใช้ยอดนี้" — เผื่อเคสพิมพ์เลขตรงกับตารางเองโดยไม่กดปุ่ม)
  // ใช้ตัดสินว่าข้อความส่งลูกค้าควรโชว์ % ส่วนลดหรือไม่ (ข้อ 1 — กันโชว์ % ที่ไม่จริงตอนกรอกยอดเอง)
  const matchesTableAmount = suggestedSettlementPaid != null && settlementPaid === suggestedSettlementPaid

  // ข้อความคัดลอกส่งลูกค้า — คำนวณจาก settlementPaid ที่กรอกจริง + ผล computeEarlyClose (result) เสมอ
  // ไม่ใช่จากตารางตรงๆ (แก้ 08 ก.ย. 2026, ดูรายละเอียดที่ comment ของ buildEarlyCloseMessage ด้านบน)
  const earlyCloseMessage = useMemo(() => {
    if (!settlementPreview) return null
    return buildEarlyCloseMessage({
      installments,
      preview: settlementPreview,
      settlementPaid,
      settlementDiscount: result.settlementDiscount,
      isFromTable: matchesTableAmount,
      penaltyReceived,
      fees,
      totalReceived: result.totalReceived,
    })
  }, [
    settlementPreview,
    installments,
    settlementPaid,
    result.settlementDiscount,
    result.totalReceived,
    matchesTableAmount,
    penaltyReceived,
    fees,
  ])

  // guard ฝั่งหน้าเว็บ mirror guard ฝั่ง SQL (status='active' เท่านั้น) — เข้าโมดัลได้จาก 2 ทางที่ไม่ได้ gate
  // มาก่อน (deep-link ?feeAction=settle + ปุ่มในกล่อง "รายการรอดำเนินการ") กันโดน error ดิบจาก RPC
  const notActive = contract.status !== 'active'
  const canProceed = result.errors.length === 0 && !notActive

  // ตรวจกันซ้ำ: เงินที่ลงเว็บไปแล้วตั้งแต่วันที่ปิด (closedAt) — ไม่ block ปุ่ม แค่เตือนให้เช็คก่อนกด
  // (แทนคำเตือน PJ auto-sync เดิมที่ไม่ตรงความจริง — pj-sync เข้ากล่องรอตรวจเมื่อไม่มีงวดค้าง ไม่ลงอัตโนมัติ)
  const suspiciousPayments = useMemo(
    () => buildSuspiciousPayments(installments, logByIns, closedAt),
    [installments, logByIns, closedAt],
  )

  async function handleConfirm() {
    setBusy(true)
    setErr(null)
    try {
      // กรองแถวที่ยังไม่กรอกออกก่อนส่ง (amount<=0 หรือ category ว่าง) — ฝั่ง SQL ไม่พัง (no-op)
      // แต่กันไม่ให้ยิงแถวขยะไปเป็น payload โดยไม่จำเป็น
      const feePayload: CloseContractEarlyFee[] = fees.filter((f) => f.amount > 0 && f.category.trim() !== '')
      await closeContractEarlyPreserve(contract.id, {
        settlementPaid,
        penaltyReceived,
        closedAt,
        fees: feePayload,
      })
      onDone()
    } catch (e) {
      setErr(errMsg(e))
      setConfirming(false)
      setBusy(false)
    }
  }

  return (
    <Modal title="ปิดสัญญาก่อนกำหนด" onClose={() => !busy && onClose()}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-soft">
          {contract.customerName} · สัญญา {contract.contractNo}
        </p>

        {notActive ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
            <p className="flex items-center gap-1.5 font-semibold">
              <AlertTriangle size={14} /> ปิดก่อนกำหนดไม่ได้
            </p>
            <p className="mt-1">
              สัญญานี้ไม่ได้อยู่สถานะกำลังผ่อน จึงปิดก่อนกำหนดไม่ได้ (สถานะปัจจุบัน: {statusLabel(contract.status)})
            </p>
          </div>
        ) : confirming ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
            <p className="mb-3 flex items-center gap-1.5 font-semibold text-amber-800">
              <AlertTriangle size={15} /> ยืนยันปิดสัญญาของ {contract.customerName}?
            </p>
            <div className="flex flex-col gap-1.5 rounded-lg bg-white p-3">
              <div className="flex justify-between text-ink-soft">
                <span>ยอดจ่ายปิด (ค่างวด)</span>
                <b className="whitespace-nowrap text-ink">{baht(settlementPaid)} ฿</b>
              </div>
              <div className="flex justify-between text-ink-soft">
                <span>ค่าปรับที่เก็บ</span>
                <b className="whitespace-nowrap text-ink">{baht(penaltyReceived)} ฿</b>
              </div>
              {feeRows
                .filter((row) => row.amount > 0 && resolveCategory(row).trim() !== '')
                .map((row) => (
                  <div key={row.key} className="flex justify-between text-ink-soft">
                    <span>{resolveCategory(row)}</span>
                    <b className="whitespace-nowrap text-ink">{baht(row.amount)} ฿</b>
                  </div>
                ))}
              <div className="flex justify-between text-ink-soft">
                <span>ส่วนลดที่ยกให้</span>
                <span className="whitespace-nowrap text-green-700">−{baht(result.settlementDiscount)} ฿</span>
              </div>
              <div className="mt-1 flex items-center justify-between border-t border-peach pt-2">
                <span className="text-sm font-semibold text-ink">รับจริงทั้งหมด</span>
                <span className="whitespace-nowrap text-2xl font-bold text-salmon-deep">
                  {baht(result.totalReceived)} ฿
                </span>
              </div>
            </div>
            <p className="mt-3 text-xs text-amber-800">วันที่ปิดจริง: {closedAt}</p>

            {suspiciousPayments.count === 0 ? (
              <div className="mt-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2.5 text-xs text-green-800">
                <p className="font-semibold">✅ ตรวจแล้ว — ยังไม่มีการลงเงินก้อนนี้ในเว็บ</p>
                <p className="mt-1">
                  ไม่พบรายการรับชำระตั้งแต่วันที่ {thaiDate(closedAt)} เป็นต้นมา กดยืนยันได้เลย ไม่ซ้ำแน่นอน
                </p>
              </div>
            ) : (
              <div className="mt-3 rounded-lg border border-amber-300 bg-amber-100 px-3 py-2.5 text-xs text-amber-800">
                <p className="font-semibold">
                  ⚠️ พบการลงเงินในเว็บแล้ว {suspiciousPayments.count} รายการ รวม {baht(suspiciousPayments.total)} บาท
                </p>
                <p className="mt-1">
                  ถ้านี่คือเงินก้อนเดียวกับยอดปิดสัญญา ให้ยกเลิกรายการชำระนั้นก่อน แล้วค่อยกดปิด
                  ไม่งั้นเงินจะถูกนับซ้ำ
                </p>
                <ul className="mt-1.5 list-disc pl-4">
                  {suspiciousPayments.rows.slice(0, 5).map((row, idx) => (
                    <li key={`${row.dateStr}-${idx}`}>
                      {thaiDate(row.dateStr)} · {baht(row.amount)} บาท · โดย {row.byName ?? 'ไม่ระบุ'}
                    </li>
                  ))}
                </ul>
                {suspiciousPayments.count > 5 && (
                  <p className="mt-1">และอีก {suspiciousPayments.count - 5} รายการ</p>
                )}
              </div>
            )}
            <p className="mt-2 text-[11px] text-ink-soft">
              หมายเหตุ: ถ้าเงินก้อนนี้เข้า PJ แล้ว ระบบจะไม่ลงซ้ำให้เอง — จะเด้งเข้ากล่องรอตรวจให้คนตรวจอีกครั้ง
            </p>

            {!hasAnyFee && (
              <p className="mt-2 text-xs text-ink-soft">
                ไม่ได้ใส่ค่าธรรมเนียม — กล่อง &quot;รายการรอดำเนินการ&quot; จะเตือนค้างจนกว่าจะลงค่าธรรมเนียม
                หรือแอดมินกด &quot;ไม่คิดค่าธรรมเนียม (ฟรี)&quot; ทีหลัง
              </p>
            )}

            {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
          </div>
        ) : (
          <>
            <Field label="ยอดที่ลูกค้าจ่ายปิด (เข้ารายได้ค่างวด)" required>
              <Input
                type="number"
                min={0}
                value={settlementPaid || ''}
                onChange={(e) => setSettlementPaid(Number(e.target.value) || 0)}
              />
              <p className="mt-1 text-xs text-ink-soft">
                ยอดคงเหลือตามตาราง {baht(result.settlementRemaining)} ฿
              </p>
            </Field>

            {settlementPreview && (
              <div className="rounded-xl border border-peach bg-peach-light/40 p-3 text-sm">
                {!settlementPreview.matched ? (
                  <p className="flex items-start gap-1.5 text-amber-800">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    ไม่มีตารางส่วนลดสำหรับสัญญางวด {settlementPreview.rowTerm} เดือน
                  </p>
                ) : settlementPreview.paidCount === 0 ? (
                  <p className="flex items-start gap-1.5 text-amber-800">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    ยังไม่จ่ายงวดไหนเลย (ปิดเดือนแรก) — ตารางไม่มีส่วนลด ให้คิดเป็นค่าดำเนินการแทน
                  </p>
                ) : settlementPreview.remainingCount === 1 ? (
                  <p className="flex items-start gap-1.5 text-amber-800">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    เหลืองวดสุดท้ายงวดเดียว — ตามตารางไม่มีส่วนลด (0%)
                  </p>
                ) : result.errors.length > 0 ? (
                  <p className="flex items-start gap-1.5 text-red-600">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    แก้ยอดให้ถูกต้องก่อน จึงจะสร้างข้อความส่งลูกค้าได้
                  </p>
                ) : earlyCloseMessage ? (
                  <CopyBox title="ข้อความส่งลูกค้า" text={earlyCloseMessage} />
                ) : (
                  <p className="flex items-start gap-1.5 text-ink-soft">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    กรอกยอดจ่ายปิดก่อน ระบบจะสร้างข้อความให้คัดลอกส่งลูกค้า
                  </p>
                )}
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={applyTableSuggestion}
                    disabled={suggestedSettlementPaid == null}
                  >
                    ใช้ยอดนี้
                  </Button>
                  {appliedTableValue != null && (
                    <Badge tone={isFromTable ? 'green' : 'neutral'}>{isFromTable ? 'ตามตาราง' : 'กรอกเอง'}</Badge>
                  )}
                </div>
              </div>
            )}

            <Field label="ค่าปรับที่เก็บ" required>
              <Input
                type="number"
                min={0}
                value={penaltyReceived || ''}
                onChange={(e) => setPenaltyReceived(Number(e.target.value) || 0)}
              />
              <p className="mt-1 text-xs text-ink-soft">
                ค่าปรับตั้งไว้ {baht(result.penaltyCharged)} ฿ · เก็บไปแล้ว {baht(result.penaltyAlreadyPaid)} ฿ ·
                ต้องเก็บอีก {baht(result.penaltyDue)} ฿
              </p>
            </Field>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-sm font-medium text-ink">ค่าธรรมเนียมปิด</span>
                <button
                  type="button"
                  onClick={addFeeRow}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-salmon-deep hover:bg-peach-light/50"
                >
                  <Plus size={13} /> เพิ่มรายการ
                </button>
              </div>
              {feeRows.length === 0 ? (
                <p className="rounded-xl bg-peach-light/40 px-3 py-2 text-xs text-ink-soft">
                  ไม่มีรายการค่าธรรมเนียม (ไม่ใส่เลยก็ได้)
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {feeRows.map((row) => {
                    const isCustom = row.categoryChoice === CUSTOM_FEE_OPTION
                    return (
                      <div key={row.key} className="rounded-xl border border-peach p-2.5">
                        {/* ข้อ 3 (feedback คุณเตย): เดิม select ถูก flex-1 บีบเหลือแค่ลูกศรตอนโมดัลแคบ/มือถือ
                            (min-content ของ <select> ในเบราว์เซอร์เล็กมาก ไม่คิดตามความยาวชื่อตัวเลือก) —
                            แก้ด้วยการวางแนวตั้งบนมือถือ (select เต็มบรรทัดแรก เห็นชื่อยาวสุดครบ ไม่ถูกตัด)
                            แล้วค่อยจัดแถวเดียวจาก sm ขึ้นไป (จอกว้างพอ) โดยให้ select ยังยืดหยุ่น (flex-1 min-w-0)
                            ส่วนช่องจำนวนเงินคงความกว้างตายตัว (w-28) ไม่แย่งพื้นที่ select */}
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                          <Select
                            className="w-full sm:min-w-0 sm:flex-1"
                            value={row.categoryChoice}
                            onChange={(e) => updateFeeRow(row.key, { categoryChoice: e.target.value })}
                          >
                            {EARLY_CLOSE_FEE_CATEGORIES.map((c) => (
                              <option key={c} value={c}>{c}</option>
                            ))}
                            <option value={CUSTOM_FEE_OPTION}>{CUSTOM_FEE_OPTION}</option>
                          </Select>
                          <div className="flex items-center gap-2">
                            <Input
                              type="number"
                              min={0}
                              className="w-28 shrink-0"
                              placeholder="บาท"
                              value={row.amount || ''}
                              onChange={(e) => updateFeeRow(row.key, { amount: Number(e.target.value) || 0 })}
                            />
                            <button
                              type="button"
                              onClick={() => removeFeeRow(row.key)}
                              aria-label="ลบรายการ"
                              className="shrink-0 rounded-lg p-2 text-ink-soft hover:bg-red-50 hover:text-red-600"
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        </div>
                        {isCustom && (
                          <Input
                            className="mt-2"
                            autoFocus
                            value={row.customName}
                            onChange={(e) => updateFeeRow(row.key, { customName: e.target.value })}
                            placeholder="พิมพ์ชื่อค่าธรรมเนียมเอง"
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <Field label="วันที่ปิดจริง" required>
              <Input
                type="date"
                max={todayStr}
                value={closedAt}
                onChange={(e) => setClosedAt(e.target.value)}
              />
            </Field>

            {/* สรุปยอดสด */}
            <div className="rounded-xl border border-peach bg-white p-3 text-sm">
              <p className="mb-2 font-semibold text-ink">สรุปยอดปิดสัญญา</p>
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between text-ink-soft">
                  <span>ส่วนลดที่ยกให้ (คำนวณให้อัตโนมัติ)</span>
                  <span className={`whitespace-nowrap ${result.settlementDiscount < 0 ? 'text-red-600' : 'text-green-700'}`}>
                    {result.settlementDiscount < 0 ? '' : '−'}{baht(result.settlementDiscount)} ฿
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between border-t border-peach pt-2">
                  <span className="text-sm font-semibold text-ink">รับจริงทั้งหมด</span>
                  <span className="text-2xl font-bold text-salmon-deep whitespace-nowrap">
                    {baht(result.totalReceived)} ฿
                  </span>
                </div>
              </div>
            </div>

            {result.errors.length > 0 && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
                <p className="mb-1 flex items-center gap-1.5 font-semibold">
                  <AlertTriangle size={14} /> ตรวจสอบก่อนปิดสัญญา
                </p>
                <ul className="list-disc pl-5">
                  {result.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            )}

            {!hasAnyFee && result.errors.length === 0 && (
              <p className="text-xs text-ink-soft">
                ไม่ได้ใส่ค่าธรรมเนียม — กล่อง &quot;รายการรอดำเนินการ&quot; จะเตือนค้างจนกว่าจะลงค่าธรรมเนียม
                หรือแอดมินกด &quot;ไม่คิดค่าธรรมเนียม (ฟรี)&quot; ทีหลัง
              </p>
            )}
          </>
        )}

        <div className="flex justify-end gap-2">
          {notActive ? (
            <Button variant="ghost" onClick={onClose}>ปิดหน้าต่าง</Button>
          ) : confirming ? (
            <>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>กลับไปแก้ไข</Button>
              <Button onClick={() => void handleConfirm()} disabled={busy || !canProceed}>
                {busy ? 'กำลังบันทึก...' : 'ยืนยันปิดสัญญา'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
              <Button onClick={() => setConfirming(true)} disabled={!canProceed}>
                ตรวจสอบยอดก่อนปิดสัญญา
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
