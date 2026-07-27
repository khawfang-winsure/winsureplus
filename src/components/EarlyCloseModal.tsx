// EarlyCloseModal — ปิดสัญญาก่อนกำหนดแบบ "คงตารางงวด" (mig 0131)
// แทนที่ SettleModal เดิม (ContractDetail.tsx) ที่บังคับกรอก % ส่วนลด — โมดัลนี้กรอกยอดเงินบาทล้วน
// pure calc มาจาก src/lib/earlyClose.ts (แบมเขียน) — ไฟล์นี้แค่ผูก UI + เรียก db.ts (น้องชีสเขียน)
import { useMemo, useState } from 'react'
import { AlertTriangle, Plus, Trash2 } from 'lucide-react'
import { Button, Field, Input, Modal, Select } from './ui'
import { baht, statusLabel } from '../lib/format'
import { closeContractEarlyPreserve, type CloseContractEarlyFee, type PaymentLogEntry } from '../lib/db'
import { computeEarlyClose, EARLY_CLOSE_FEE_CATEGORIES } from '../lib/earlyClose'
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

  // guard ฝั่งหน้าเว็บ mirror guard ฝั่ง SQL (status='active' เท่านั้น) — เข้าโมดัลได้จาก 2 ทางที่ไม่ได้ gate
  // มาก่อน (deep-link ?feeAction=settle + ปุ่มในกล่อง "รายการรอดำเนินการ") กันโดน error ดิบจาก RPC
  const notActive = contract.status !== 'active'
  const canProceed = result.errors.length === 0 && !notActive

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
              {result.feeTotal > 0 && (
                <div className="flex justify-between text-ink-soft">
                  <span>ค่าธรรมเนียมปิด</span>
                  <b className="whitespace-nowrap text-ink">{baht(result.feeTotal)} ฿</b>
                </div>
              )}
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

            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700">
              ⚠️ ถ้าเงินก้อนนี้ถูกคีย์เข้า PJ แล้ว ระบบจะดูดมาลงให้เองอัตโนมัติ — กดปุ่มนี้เฉพาะกรณีที่ยังไม่ได้ลงใน PJ เท่านั้น
            </div>

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
                        <div className="flex items-start gap-2">
                          <Select
                            className="flex-1"
                            value={row.categoryChoice}
                            onChange={(e) => updateFeeRow(row.key, { categoryChoice: e.target.value })}
                          >
                            {EARLY_CLOSE_FEE_CATEGORIES.map((c) => (
                              <option key={c} value={c}>{c}</option>
                            ))}
                            <option value={CUSTOM_FEE_OPTION}>{CUSTOM_FEE_OPTION}</option>
                          </Select>
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
