// TransferInvoiceCutover — "ผูกเลข INV ใหม่" หลังเปลี่ยนผู้ผ่อน (feature ใหม่ 2026-09-14, owner-approved brief)
// ใช้ได้ทั้ง 2 ที่: ต่อจากขั้นยืนยันใน TransferOwnerModal (ถ้ากรอก INV ใหม่ไว้ตั้งแต่ขั้น 1)
// และจากแถวประวัติเปลี่ยนผู้ผ่อนใน ContractDetail.tsx (ตอนร้านเปิดใบ INV ใหม่ทีหลัง)
// ภาษาที่ใช้ในหน้าจอ: "ดึงใบเสร็จจาก PJ" / "ผูกเลข INV ใหม่" — ห้ามใช้ precheck/cutover/RPC ให้ผู้ใช้เห็น
import { useState } from 'react'
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react'
import { Button, Field, Input, Textarea } from './ui'
import { baht } from '../lib/format'
import { cutoverTransferInvoice, fetchPjInvoiceReceipts } from '../lib/db'
import { normalizeInvNo } from '../lib/contractTransfer'

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}

const PAYMENT_TYPE_LABEL: Record<string, string> = {
  down: 'เงินดาวน์',
  installment: 'ค่างวด',
  penalty: 'ค่าปรับ',
  other: 'อื่นๆ',
}

function paymentTypeLabel(t: string): string {
  return PAYMENT_TYPE_LABEL[t] ?? t
}

interface ReceiptRow {
  uuid: string
  paymentType: string
  amount: number
  paidDate: string
}

export default function TransferInvoiceCutover({
  contractId,
  transferId,
  isAdmin,
  initialInvNo,
  onDone,
}: {
  contractId: string
  transferId: string
  isAdmin: boolean
  initialInvNo?: string | null
  onDone?: () => void
}) {
  const [invNo, setInvNo] = useState(initialInvNo ?? '')
  const [fetching, setFetching] = useState(false)
  const [fetchErr, setFetchErr] = useState<string | null>(null)
  const [precheckId, setPrecheckId] = useState<string | null>(null)
  const [receipts, setReceipts] = useState<ReceiptRow[]>([])
  const [pjTotalFromFetch, setPjTotalFromFetch] = useState<number>(0)

  const [confirming, setConfirming] = useState(false)
  const [confirmErr, setConfirmErr] = useState<string | null>(null)
  const [overrideReason, setOverrideReason] = useState('')
  const [attempted, setAttempted] = useState(false)
  const [result, setResult] = useState<{ matched: boolean; ourTotal: number; pjTotal: number } | null>(null)

  // ข้อความจาก RPC เมื่อยอดไม่ตรง (ล็อกคำนี้ตาม cutover_transfer_invoice, mig 0158) — เฉพาะเคสนี้ที่ต้องการเหตุผล/ให้แอดมินยืนยัน
  const isMismatch = !!confirmErr && confirmErr.includes('ไม่ตรงกับยอดที่เราบันทึกไว้')
  const isExpired = !!confirmErr && (confirmErr.includes('เก่าเกินไป') || confirmErr.includes('หมดอายุ'))

  async function handleFetch() {
    const norm = normalizeInvNo(invNo)
    if (!norm) {
      setFetchErr('กรุณากรอกเลข INV ก่อน')
      return
    }
    setFetching(true)
    setFetchErr(null)
    setPrecheckId(null)
    setReceipts([])
    try {
      const res = await fetchPjInvoiceReceipts(contractId, norm)
      setInvNo(norm)
      setPrecheckId(res.precheckId)
      setReceipts(res.receipts)
      setPjTotalFromFetch(res.total)
    } catch (e) {
      setFetchErr(errMsg(e))
    } finally {
      setFetching(false)
    }
  }

  async function handleCutover() {
    if (!precheckId) return
    setConfirming(true)
    setConfirmErr(null)
    try {
      const res = await cutoverTransferInvoice(
        transferId,
        precheckId,
        normalizeInvNo(invNo),
        attempted && overrideReason.trim() ? overrideReason.trim() : undefined,
      )
      setResult({ matched: res.matched, ourTotal: res.ourTotal, pjTotal: res.pjTotal })
      onDone?.()
    } catch (e) {
      setConfirmErr(errMsg(e))
      setAttempted(true)
    } finally {
      setConfirming(false)
    }
  }

  if (result) {
    return (
      <div
        className={`rounded-xl border p-3 text-sm ${
          result.matched ? 'border-green-200 bg-green-50 text-green-800' : 'border-amber-200 bg-amber-50 text-amber-800'
        }`}
      >
        <p className="flex items-center gap-1.5 font-semibold">
          <CheckCircle2 size={15} /> ผูกเลข INV {invNo} แล้ว
        </p>
        <p className="mt-1">
          ยอด PJ {baht(result.pjTotal)} บาท · ยอดเรา {baht(result.ourTotal)} บาท ·{' '}
          {result.matched ? 'ตรงกัน' : 'ไม่ตรงกัน (ยืนยันโดยแอดมินแล้ว)'}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-peach bg-white p-3">
      <p className="text-xs text-ink-soft">
        ใบเสร็จที่ร้านลงซ้ำตอนเปิดใบใหม่ ระบบจะไม่นับเป็นเงินเข้าอีก
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="เลข INV ใหม่">
          <Input value={invNo} onChange={(e) => setInvNo(e.target.value)} placeholder="เช่น INV-17892784203457" />
        </Field>
        <Button variant="ghost" onClick={() => void handleFetch()} disabled={fetching}>
          <RefreshCw size={14} className={fetching ? 'animate-spin' : ''} />
          {fetching ? 'กำลังดึง...' : 'ดึงใบเสร็จจาก PJ'}
        </Button>
      </div>
      {fetchErr && <p className="text-sm text-red-600">{fetchErr}</p>}

      {receipts.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="overflow-x-auto rounded-lg border border-peach">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="bg-peach-light text-left text-ink">
                  <th className="px-3 py-2 font-semibold">ประเภท</th>
                  <th className="px-3 py-2 font-semibold">วันที่</th>
                  <th className="px-3 py-2 font-semibold">ยอด</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((r) => (
                  <tr key={r.uuid} className="border-t border-peach">
                    <td className="px-3 py-2">{paymentTypeLabel(r.paymentType)}</td>
                    <td className="px-3 py-2">{r.paidDate}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{baht(r.amount)} ฿</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-right text-sm font-semibold text-ink">ยอดรวม PJ {baht(pjTotalFromFetch)} ฿</p>

          {confirmErr && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <p className="flex items-center gap-1.5 font-semibold">
                <AlertTriangle size={14} /> {confirmErr}
              </p>
              {isMismatch ? (
                isAdmin ? (
                  <div className="mt-2">
                    <Field label="เหตุผล (ยอดไม่ตรง)" required>
                      <Textarea
                        value={overrideReason}
                        onChange={(e) => setOverrideReason(e.target.value)}
                        rows={2}
                        placeholder="เช่น ร้านคีย์ใบเสร็จตกหล่น ยืนยันแล้วว่ายอดถูกต้อง"
                      />
                    </Field>
                  </div>
                ) : (
                  <p className="mt-1">ยอดไม่ตรงกับระบบ ต้องให้แอดมินยืนยัน</p>
                )
              ) : (
                isExpired && (
                  <div className="mt-2">
                    <Button onClick={() => void handleFetch()} disabled={fetching}>
                      <RefreshCw size={14} className={fetching ? 'animate-spin' : ''} />
                      {fetching ? 'กำลังดึง...' : 'ดึงใบเสร็จจาก PJ ใหม่'}
                    </Button>
                  </div>
                )
              )}
            </div>
          )}

          <div className="flex justify-end">
            <Button
              onClick={() => void handleCutover()}
              disabled={
                confirming ||
                (attempted && isMismatch && (!isAdmin || !overrideReason.trim()))
              }
            >
              {confirming ? 'กำลังบันทึก...' : 'ยืนยันผูกเลข'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
