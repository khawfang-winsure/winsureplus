import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AlertTriangle, CalendarClock, CheckCircle2, ExternalLink, Receipt, SkipForward, Wallet } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Loading, Modal, PageTitle } from '../components/ui'
import { baht, thaiDate } from '../lib/format'
import {
  applyPjReviewAsOtherIncome,
  applyPjReviewPayment,
  getContractFeeReconcile,
  getPjReceiptDriftDetail,
  getPjReviewContext,
  getPjSyncReview,
  getPjSyncRuns,
  resolvePjReviewItem,
} from '../lib/db'
import { FEE_INCOME_PRESETS, FEE_INCOME_CUSTOM, type FeeKind } from '../lib/feeReconcile'
import { spreadPayment } from '../lib/paymentSpread'
import { detectDuplicatePjReviewRows, detectOddAmountFromContext } from '../lib/pjReviewDup'
import type { DriftKind, PjReceiptDriftSnapshot } from '../lib/pjReceiptDrift'
import type { PjReviewContext, PjSyncReviewReason, PjSyncReviewRow, PjSyncRunRow } from '../lib/types'
import { useAuth } from '../lib/auth'

/** reason ที่เกิดจากตรวจจับ "ใบเสร็จหาย/ถูกแก้ใน PJ" — ต้องซ่อนปุ่มลงเงินทุกปุ่ม (ดูตรวจ+รายงานเท่านั้น) */
function isDriftReason(reason: PjSyncReviewReason): boolean {
  return reason === 'RECEIPT_MISSING' || reason === 'RECEIPT_CHANGED'
}

/** ประเภทเงินที่จดไว้ (ทั้งฝั่งเราและฝั่ง PJ ใน snapshot) → ไทย */
const PAYMENT_TYPE_LABEL: Record<string, string> = {
  installment: 'ค่างวด',
  penalty: 'ค่าปรับ',
  other: 'อื่นๆ',
}
function paymentTypeLabel(t: string): string {
  return PAYMENT_TYPE_LABEL[t] ?? t
}

/** หัวข้อสั้นบอกว่า drift แบบไหน (ใช้โชว์ในกล่องเทียบ — ละเอียดกว่า badge เหตุผลหลัก) */
const DRIFT_KIND_LABEL: Record<DriftKind, string> = {
  missing: 'ไม่เจอใบเสร็จนี้ใน PJ',
  amount: 'ยอดเงินไม่ตรงกัน',
  type: 'ประเภทเงินไม่ตรงกัน',
  date: 'วันที่ไม่ตรงกัน',
}

// ===== หมวดรายได้อื่นๆ สำเร็จรูป + fee_kind (ชื่อ + mapping จาก feeReconcile — single source) =====
const OTHER_INCOME_CUSTOM = FEE_INCOME_CUSTOM

// ===== ป้ายเหตุผล (reason → ไทย + โทนสี) =====
const REASON_LABEL: Record<PjSyncReviewReason, string> = {
  MULTI: 'จ่ายข้ามงวด',
  PARTIAL: 'จ่ายบางส่วน',
  UNMATCHED: 'หาสัญญาไม่เจอ',
  OTHER: 'ประเภทอื่น',
  AMOUNT_MISMATCH: 'ยอดไม่ตรง',
  RECEIPT_MISSING: 'ไม่เจอใบเสร็จนี้ใน PJ',
  RECEIPT_CHANGED: 'ใบเสร็จถูกแก้ใน PJ',
}
const REASON_TONE: Record<PjSyncReviewReason, 'neutral' | 'amber' | 'red'> = {
  MULTI: 'amber',
  PARTIAL: 'amber',
  UNMATCHED: 'red',
  OTHER: 'neutral',
  AMOUNT_MISMATCH: 'red',
  RECEIPT_MISSING: 'red',
  RECEIPT_CHANGED: 'red',
}

// ===== ป้ายสถานะการรัน (run.status → ไทย + โทนสี) =====
const RUN_STATUS_LABEL: Record<PjSyncRunRow['status'], string> = {
  running: 'กำลังรัน',
  success: 'สำเร็จ',
  login_failed: 'ล็อกอินไม่ได้',
  error: 'ผิดพลาด',
}
const RUN_STATUS_TONE: Record<PjSyncRunRow['status'], 'neutral' | 'green' | 'red'> = {
  running: 'neutral',
  success: 'green',
  login_failed: 'red',
  error: 'red',
}

/** เวลาแบบไทย dd/mm/yyyy HH:MM จาก ISO timestamp */
function thaiDateTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const date = thaiDate(
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
  )
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${date} ${time}`
}

export default function PjSyncReview() {
  const { role, name: userName, configured } = useAuth()
  const isAdminOrStaff = !configured || role === 'admin' || role === 'staff'
  const isAdmin = !configured || role === 'admin'

  const [rows, setRows] = useState<PjSyncReviewRow[]>([])
  const [runs, setRuns] = useState<PjSyncRunRow[]>([])
  const [driftDetails, setDriftDetails] = useState<Record<string, PjReceiptDriftSnapshot | null>>({})
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const [review, runList] = await Promise.all([
      getPjSyncReview('pending'),
      isAdmin ? getPjSyncRuns(10) : Promise.resolve([]),
    ])
    // แถว drift (ใบเสร็จหาย/ถูกแก้) ต้องโชว์กล่องเทียบ "เราถือ vs PJ ว่า" — ดึงรายละเอียดเพิ่มเฉพาะแถวพวกนี้
    const driftRows = review.filter((r) => isDriftReason(r.reason))
    const details = await Promise.all(driftRows.map((r) => getPjReceiptDriftDetail(r.id)))
    const detailMap: Record<string, PjReceiptDriftSnapshot | null> = {}
    driftRows.forEach((r, i) => {
      detailMap[r.id] = details[i]
    })
    setRows(review)
    setRuns(runList)
    setDriftDetails(detailMap)
    setLoading(false)
  }, [isAdmin])

  useEffect(() => {
    load()
  }, [load])

  const [target, setTarget] = useState<{ row: PjSyncReviewRow; action: 'resolved' | 'skipped' } | null>(null)
  const [applyTarget, setApplyTarget] = useState<PjSyncReviewRow | null>(null)
  const [otherIncomeTarget, setOtherIncomeTarget] = useState<PjSyncReviewRow | null>(null)

  // แถวที่น่าจะซ้ำในกล่อง (contract เดียวกัน + วันจ่ายเดียวกัน + ยอดเท่ากัน) — คำนวณครั้งเดียวต่อการโหลด rows
  const dupMap = useMemo(() => detectDuplicatePjReviewRows(rows), [rows])

  // แถว drift (ใบเสร็จหาย/ถูกแก้ใน PJ) สำคัญกว่าแถวรอตรวจปกติ — เรียงขึ้นบนสุดเสมอ (sort เสถียร คงลำดับเดิมในกลุ่ม)
  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => Number(isDriftReason(b.reason)) - Number(isDriftReason(a.reason))),
    [rows],
  )

  // กันชั้นใน (route ที่ App.tsx guard อยู่แล้ว)
  if (!isAdminOrStaff) return <EmptyState title="เฉพาะพนักงาน/แอดมินเท่านั้น" />

  const latest = runs[0] ?? null
  const latestBad = latest && (latest.status === 'error' || latest.status === 'login_failed')

  return (
    <div>
      <PageTitle
        sub="ระบบดึงยอดจาก PJ อัตโนมัติทุก 15 นาที — เคสที่ลงให้ไม่ได้ (จ่ายข้ามงวด/บางส่วน/หาสัญญาไม่เจอ) มารอให้ตรวจที่นี่"
        count={loading ? undefined : { shown: rows.length }}
      >
        กล่องรอตรวจ PJ
      </PageTitle>

      {/* ===== แถบสถานะการรัน (admin เท่านั้น — staff เห็นแค่กล่องรอตรวจ) ===== */}
      {isAdmin && (
        <Card className="mb-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">สถานะการดึงยอดอัตโนมัติ</h3>
            {latest && <span className="text-xs text-ink-soft">รอบล่าสุด {thaiDateTime(latest.startedAt)}</span>}
          </div>

          {loading ? (
            <Loading />
          ) : runs.length === 0 ? (
            <p className="text-sm text-ink-soft">ยังไม่มีประวัติการรัน</p>
          ) : (
            <>
              {/* เตือนเมื่อรอบล่าสุดพัง */}
              {latestBad && latest && (
                <div className="mb-3 flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-700">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">การดึงยอดรอบล่าสุดมีปัญหา ({RUN_STATUS_LABEL[latest.status]})</p>
                    {latest.errorDetail && <p className="mt-0.5 text-xs text-red-600">{latest.errorDetail}</p>}
                  </div>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-peach text-left text-ink-soft">
                      <th className="py-2 pr-4 font-medium">เวลา</th>
                      <th className="py-2 pr-4 font-medium">สถานะ</th>
                      <th className="py-2 pr-4 font-medium text-right">ลงอัตโนมัติ</th>
                      <th className="py-2 font-medium text-right">เข้ากล่อง</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run) => (
                      <tr key={run.id} className="border-b border-peach/50">
                        <td className="py-2 pr-4 text-ink-soft whitespace-nowrap">{thaiDateTime(run.startedAt)}</td>
                        <td className="py-2 pr-4">
                          <Badge tone={RUN_STATUS_TONE[run.status]}>{RUN_STATUS_LABEL[run.status]}</Badge>
                        </td>
                        <td className="py-2 pr-4 text-right text-ink whitespace-nowrap">
                          {run.autoAppliedCount} ราย · {baht(run.autoAppliedAmount)} ฿
                        </td>
                        <td className="py-2 text-right text-ink whitespace-nowrap">{run.reviewCount} ราย</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}

      {/* ===== ตารางกล่องรอตรวจ ===== */}
      {loading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="ไม่มีเคสรอตรวจ 🎉" hint="ระบบลงยอดที่ตรงเป๊ะให้อัตโนมัติแล้ว" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-peach text-left text-ink-soft">
                <th className="py-2 pr-4 font-medium">วันที่จ่าย</th>
                <th className="py-2 pr-4 font-medium">เลขใบเสร็จ</th>
                <th className="py-2 pr-4 font-medium">ลูกค้า / สัญญา</th>
                <th className="py-2 pr-4 font-medium">เหตุผล</th>
                <th className="py-2 pr-4 font-medium text-right">ยอด</th>
                <th className="py-2 font-medium text-right">จัดการ</th>
              </tr>
            </thead>
            {sortedRows.map((r) => {
              const isDrift = isDriftReason(r.reason)
              const detail = driftDetails[r.id] ?? null
              return (
                // แถวละ 1 tbody (ไม่ nested tbody) — ให้แถวเดียวมีทั้งแถวหลัก + แถวกล่องเทียบ drift ต่อท้ายได้
                <tbody key={r.id}>
                  <tr className={`border-b ${isDrift ? 'border-red-100 bg-red-50/40' : 'border-peach/50'} hover:bg-peach-light/30`}>
                    <td className="py-3 pr-4 text-ink-soft whitespace-nowrap">
                      {r.paidDate ? thaiDate(r.paidDate.slice(0, 10)) : '—'}
                    </td>
                    <td className="py-3 pr-4 text-ink whitespace-nowrap">
                      {r.invoiceNo}
                      {r.paymentType && <span className="block text-xs text-ink-soft">{r.paymentType}</span>}
                    </td>
                    <td className="py-3 pr-4">
                      {r.contractId ? (
                        <>
                          <p className="font-medium text-ink">{r.customerName ?? '—'}</p>
                          <p className="text-xs text-ink-soft">{r.contractNo ?? '—'}</p>
                        </>
                      ) : (
                        <Badge tone="red">หาสัญญาไม่เจอ</Badge>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      <div className="flex flex-col items-start gap-1">
                        <Badge tone={REASON_TONE[r.reason]}>{REASON_LABEL[r.reason]}</Badge>
                        {dupMap.get(r.id)?.isDuplicate && <Badge tone="amber">น่าจะซ้ำ</Badge>}
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-right text-ink">
                      {r.penaltyAmount > 0 ? (
                        <>
                          <span className="block whitespace-nowrap">ค่างวด {baht(r.amount)} + ค่าปรับ {baht(r.penaltyAmount)} ฿</span>
                          <span className="block whitespace-nowrap text-xs font-semibold text-ink">
                            = {baht(r.amount + r.penaltyAmount)} ฿
                          </span>
                        </>
                      ) : (
                        <span className="whitespace-nowrap">ค่างวด {baht(r.amount)} ฿</span>
                      )}
                    </td>
                    <td className="py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {r.contractId && (
                          <Link to={`/contract/${r.contractId}`}>
                            <Button variant="ghost">
                              <ExternalLink size={13} />
                              ดูสัญญา
                            </Button>
                          </Link>
                        )}
                        {isDrift ? (
                          // แถว drift = ตรวจ+รายงานเท่านั้น ห้ามถอนเงิน/ลงเงินเอง — เหลือปุ่มเดียว "รับทราบ"
                          <Button variant="ghost" onClick={() => setTarget({ row: r, action: 'resolved' })}>
                            <CheckCircle2 size={13} />
                            รับทราบ
                          </Button>
                        ) : (
                          <>
                            <Button variant="ghost" onClick={() => setTarget({ row: r, action: 'skipped' })}>
                              <SkipForward size={13} />
                              ข้าม
                            </Button>
                            {r.contractId && (
                              <Button onClick={() => setApplyTarget(r)}>
                                <Wallet size={13} />
                                ยืนยันลงยอด
                              </Button>
                            )}
                            {r.contractId && (
                              <Button variant="ghost" onClick={() => setOtherIncomeTarget(r)}>
                                <Receipt size={13} />
                                รายได้อื่นๆ
                              </Button>
                            )}
                            <Button variant="ghost" onClick={() => setTarget({ row: r, action: 'resolved' })}>
                              <CheckCircle2 size={13} />
                              ทำเสร็จแล้ว
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>

                  {/* กล่องเทียบ "เราถือ vs PJ ว่า" — เฉพาะแถว drift ที่ดึงรายละเอียดมาได้แล้ว */}
                  {isDrift && detail && (
                    <tr className="border-b border-red-100 bg-red-50/40">
                      <td colSpan={6} className="px-4 pb-4">
                        <DriftCompareBox detail={detail} />
                      </td>
                    </tr>
                  )}
                </tbody>
              )
            })}
          </table>
        </div>
      )}

      {target && (
        <ResolveModal
          row={target.row}
          action={target.action}
          byName={userName ?? 'ไม่ทราบ'}
          driftDetail={driftDetails[target.row.id] ?? null}
          onClose={() => setTarget(null)}
          onDone={async () => {
            setTarget(null)
            await load()
          }}
        />
      )}

      {applyTarget && (
        <ApplyModal
          row={applyTarget}
          byName={userName ?? 'ไม่ทราบ'}
          onClose={() => setApplyTarget(null)}
          onDone={async () => {
            setApplyTarget(null)
            await load()
          }}
          onSwitchToOtherIncome={() => {
            setOtherIncomeTarget(applyTarget)
            setApplyTarget(null)
          }}
        />
      )}

      {otherIncomeTarget && (
        <OtherIncomeModal
          row={otherIncomeTarget}
          byName={userName ?? 'ไม่ทราบ'}
          onClose={() => setOtherIncomeTarget(null)}
          onDone={async () => {
            setOtherIncomeTarget(null)
            await load()
          }}
        />
      )}
    </div>
  )
}

// ===== กล่องเทียบ "เราถืออยู่ vs PJ ว่า (ตอนตรวจ)" — เฉพาะแถว drift (ใบเสร็จหาย/ถูกแก้ใน PJ) =====
function DriftCompareBox({ detail }: { detail: PjReceiptDriftSnapshot }) {
  return (
    <div className="rounded-xl border border-red-200 bg-cream px-4 py-3 text-sm">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-red-700">{DRIFT_KIND_LABEL[detail.kind]}</p>
        <span className="text-xs text-ink-soft">ตรวจล่าสุดเมื่อ {thaiDateTime(detail.checkedAt)}</span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-peach bg-peach-light/30 px-3 py-2.5">
          <p className="mb-1.5 text-xs font-medium text-ink-soft">เราถืออยู่</p>
          <p className="text-ink">ยอด <span className="whitespace-nowrap font-medium">{baht(detail.ours.amount)} ฿</span></p>
          <p className="text-ink">ประเภท {paymentTypeLabel(detail.ours.paymentType)}</p>
          <p className="text-ink">วันที่ {thaiDate(detail.ours.pjPaidDate)}</p>
        </div>

        <div className="rounded-lg border border-peach bg-peach-light/30 px-3 py-2.5">
          <p className="mb-1.5 text-xs font-medium text-ink-soft">PJ ว่า (ตอนตรวจ)</p>
          {detail.pj ? (
            <>
              <p className="text-ink">ยอด <span className="whitespace-nowrap font-medium">{baht(detail.pj.amount)} ฿</span></p>
              <p className="text-ink">ประเภท {paymentTypeLabel(detail.pj.paymentType)}</p>
              <p className="text-ink">วันที่ {thaiDate(detail.pj.pjPaidDate)}</p>
            </>
          ) : (
            <p className="text-red-600">ไม่เจอใบนี้ใน PJ ตอนตรวจ (เช็คแล้ว {detail.missingStreak} รอบ)</p>
          )}
        </div>
      </div>

      <p className="mt-2.5 text-xs text-ink-soft">
        ระบบตรวจจับและรายงานเท่านั้น ยังไม่ได้แก้ยอดเงินให้อัตโนมัติ — ถ้าต้องแก้ยอดจริงในระบบ แจ้งครีมให้ช่วยตรวจเคสนี้ให้นะคะ
      </p>
    </div>
  )
}

// ===== Modal ยืนยัน ทำเสร็จแล้ว / ข้าม / รับทราบ (drift) — note optional =====
function ResolveModal({
  row,
  action,
  byName,
  driftDetail,
  onClose,
  onDone,
}: {
  row: PjSyncReviewRow
  action: 'resolved' | 'skipped'
  byName: string
  driftDetail: PjReceiptDriftSnapshot | null
  onClose: () => void
  onDone: () => void
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const isDrift = isDriftReason(row.reason)
  const title = isDrift ? 'รับทราบเคสนี้' : action === 'resolved' ? 'ทำเสร็จแล้ว' : 'ข้ามเคสนี้'

  async function confirm() {
    setBusy(true)
    setErr(null)
    try {
      await resolvePjReviewItem(row.id, action, byName, note.trim() || undefined)
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink">
          {isDrift
            ? 'ยืนยันว่ารับทราบเคสนี้แล้ว (เอาออกจากกล่องรอตรวจ) — การรับทราบไม่มีการแก้ไขยอดเงินใดๆ ในระบบ'
            : action === 'resolved'
              ? 'ยืนยันว่าได้จัดการเคสนี้แล้ว (เอาออกจากกล่องรอตรวจ)'
              : 'ข้ามเคสนี้ออกจากกล่องรอตรวจโดยไม่ดำเนินการ'}
        </p>

        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl bg-peach-light/40 px-4 py-3 text-sm">
          <span className="text-ink-soft">เลขใบเสร็จ</span>
          <span className="text-ink">{row.invoiceNo}</span>
          <span className="text-ink-soft">ลูกค้า</span>
          <span className="text-ink">{row.contractId ? `${row.customerName ?? '—'} (${row.contractNo ?? '—'})` : 'หาสัญญาไม่เจอ'}</span>
          <span className="text-ink-soft">เหตุผล</span>
          <span className="text-ink">{REASON_LABEL[row.reason]}</span>
          <span className="text-ink-soft">ยอด</span>
          <span className="text-ink whitespace-nowrap">{baht(row.amount)} ฿</span>
        </div>

        {isDrift && driftDetail && <DriftCompareBox detail={driftDetail} />}

        <div>
          <label className="mb-1 block text-sm text-ink-soft">หมายเหตุ (ไม่บังคับ)</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="เช่น ลงยอดให้แล้วผ่านหน้าสัญญา"
            className="w-full rounded-xl border border-peach bg-cream px-3 py-2 text-sm text-ink outline-none focus:border-salmon"
          />
        </div>

        {err && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>ยกเลิก</Button>
          <Button onClick={confirm} disabled={busy}>{busy ? 'กำลังบันทึก...' : `ยืนยัน${title}`}</Button>
        </div>
      </div>
    </Modal>
  )
}

// ===== Modal ยืนยันลงยอด — โชว์บริบทสัญญา + ฟอร์มลงยอดในกล่องเลย =====
function ApplyModal({
  row,
  byName,
  onClose,
  onDone,
  onSwitchToOtherIncome,
}: {
  row: PjSyncReviewRow
  byName: string
  onClose: () => void
  onDone: () => void
  onSwitchToOtherIncome: () => void
}) {
  const [ctx, setCtx] = useState<PjReviewContext | null>(null)
  const [ctxLoading, setCtxLoading] = useState(true)

  const [principal, setPrincipal] = useState(String(row.amount))
  const [penalty, setPenalty] = useState(String(row.penaltyAmount))
  const [paidDate, setPaidDate] = useState((row.paidDate ?? '').slice(0, 10))

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setCtxLoading(true)
    getPjReviewContext(row.contractId!)
      .then((c) => {
        if (alive) setCtx(c)
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setCtxLoading(false)
      })
    return () => {
      alive = false
    }
  }, [row.contractId])

  const nextUnpaid = ctx?.nextUnpaid ?? null

  // พรีวิวสด: เงินต้นที่กรอกจะถูกตัดเข้างวดไหนบ้าง (ตรงกับ RPC record_payment_spread)
  const spreadPreview = spreadPayment(ctx?.unpaidInstallments ?? [], Number(principal) || 0)

  // เตือน "ยอดแปลก" สด — เงินต้นที่กรอกเล็กกว่าค่างวดจริงมาก อาจไม่ใช่ค่างวด (ค่าส่งพัสดุ/ค่าธรรมเนียม)
  const oddFlag = ctx ? detectOddAmountFromContext(Number(principal) || 0, ctx) : { isOddAmount: false, hint: null }

  async function confirm() {
    if (!nextUnpaid || !paidDate) return
    setBusy(true)
    setErr(null)
    try {
      await applyPjReviewPayment({
        reviewId: row.id,
        contractId: row.contractId!,
        principal: Number(principal) || 0,
        penalty: Number(penalty) || 0,
        paidDate,
        byName,
      })
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal title="ยืนยันลงยอด" onClose={onClose}>
      <div className="flex flex-col gap-4">
        {/* หัว: ลูกค้า / สัญญา / ใบเสร็จ */}
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl bg-peach-light/40 px-4 py-3 text-sm">
          <span className="text-ink-soft">ลูกค้า</span>
          <span className="text-ink">{row.customerName ?? '—'}</span>
          <span className="text-ink-soft">สัญญา</span>
          <span className="text-ink">{row.contractNo ?? '—'}</span>
          <span className="text-ink-soft">เลขใบเสร็จ</span>
          <span className="text-ink">{row.invoiceNo}</span>
        </div>

        {ctxLoading ? (
          <Loading />
        ) : ctx ? (
          <>
            {/* งวดถัดไปที่ต้องชำระ */}
            {nextUnpaid ? (
              <div className="rounded-xl border border-peach bg-cream px-4 py-3 text-sm">
                <p className="mb-1 font-semibold text-ink">งวดที่ {nextUnpaid.no}</p>
                <p className="text-ink-soft">
                  ค่างวด <span className="whitespace-nowrap text-ink">{baht(nextUnpaid.amount)} ฿</span>
                  {' · '}จ่ายแล้ว <span className="whitespace-nowrap text-ink">{baht(nextUnpaid.paid)} ฿</span>
                  {' · '}
                  <span className="font-semibold text-salmon whitespace-nowrap">คงเหลือ {baht(nextUnpaid.remaining)} ฿</span>
                </p>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-700">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <p>ไม่มีงวดค้างให้ลง — สัญญานี้จ่ายครบทุกงวดแล้ว</p>
              </div>
            )}

            {/* แถบสรุปจ่ายแล้ว / ทั้งหมด */}
            <div className="flex items-center justify-between rounded-xl bg-peach-light/40 px-4 py-3 text-sm">
              <span className="text-ink-soft">จ่ายแล้วรวม</span>
              <span className="whitespace-nowrap text-ink">
                {baht(ctx.totalPaid)} / {baht(ctx.totalDue)} ฿
              </span>
            </div>

            {/* ประวัติการจ่ายล่าสุด */}
            {ctx.recentPayments.length > 0 && (
              <div>
                <p className="mb-1.5 text-sm font-medium text-ink-soft">ประวัติการจ่ายล่าสุด</p>
                <div className="overflow-x-auto rounded-xl border border-peach">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-peach text-left text-ink-soft">
                        <th className="px-3 py-2 font-medium">วันที่</th>
                        <th className="px-3 py-2 font-medium text-right">ค่างวด</th>
                        <th className="px-3 py-2 font-medium text-right">ค่าปรับ</th>
                        <th className="px-3 py-2 font-medium">โดย</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ctx.recentPayments.map((p, i) => (
                        <tr key={i} className="border-b border-peach/50 last:border-0">
                          <td className="px-3 py-2 text-ink-soft whitespace-nowrap">
                            {p.installmentNo != null && <span className="mr-1 text-xs">ง.{p.installmentNo}</span>}
                            {p.date ? thaiDate(p.date.slice(0, 10)) : '—'}
                          </td>
                          <td className="px-3 py-2 text-right text-ink whitespace-nowrap">{baht(p.principal)} ฿</td>
                          <td className="px-3 py-2 text-right text-ink whitespace-nowrap">{baht(p.penalty)} ฿</td>
                          <td className="px-3 py-2 text-ink-soft">{p.byName}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ฟอร์มลงยอด */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-sm text-ink-soft">เงินต้น (ค่างวด)</label>
                <input
                  type="number"
                  inputMode="decimal"
                  value={principal}
                  onChange={(e) => setPrincipal(e.target.value)}
                  className="w-full rounded-xl border border-peach bg-cream px-3 py-2 text-sm text-ink outline-none focus:border-salmon"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm text-ink-soft">ค่าปรับ</label>
                <input
                  type="number"
                  inputMode="decimal"
                  value={penalty}
                  onChange={(e) => setPenalty(e.target.value)}
                  className="w-full rounded-xl border border-peach bg-cream px-3 py-2 text-sm text-ink outline-none focus:border-salmon"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm text-ink-soft">วันที่จ่าย</label>
                <input
                  type="date"
                  value={paidDate}
                  onChange={(e) => setPaidDate(e.target.value)}
                  className="w-full rounded-xl border border-peach bg-cream px-3 py-2 text-sm text-ink outline-none focus:border-salmon"
                />
                {!paidDate && <p className="mt-1 text-xs text-salmon">กรุณาระบุวันที่จ่าย</p>}
              </div>
            </div>

            {/* เตือนยอดแปลก — เงินต้นเล็กกว่าค่างวดจริงมาก อาจไม่ใช่ค่างวด */}
            {oddFlag.isOddAmount && oddFlag.hint && (
              <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-700">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <div className="flex-1">
                  <p>{oddFlag.hint}</p>
                  <button
                    type="button"
                    onClick={onSwitchToOtherIncome}
                    className="mt-1.5 text-xs font-semibold text-amber-800 underline underline-offset-2 hover:text-amber-900"
                  >
                    ลงเป็นรายได้อื่นๆแทน →
                  </button>
                </div>
              </div>
            )}

            {/* พรีวิวการตัดงวด — อัปเดตตามเงินต้นที่กรอก */}
            {spreadPreview.length > 0 && (
              <div className="rounded-xl border border-peach bg-peach-light/30 px-4 py-3 text-sm">
                <p className="mb-1.5 font-medium text-ink-soft">เงินนี้จะตัดเข้า</p>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ink">
                  {spreadPreview.map((s, i) => (
                    <span key={s.no} className="whitespace-nowrap">
                      {i > 0 && <span className="mr-2 text-ink-soft">·</span>}
                      งวด {s.no}: {baht(s.applied)} ฿{' '}
                      {s.fullyPaid ? (
                        <span className="text-emerald-600">✓ครบ</span>
                      ) : (
                        <span className="text-amber-600">(บางส่วน)</span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : null}

        {err && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>ยกเลิก</Button>
          <Button onClick={confirm} disabled={busy || ctxLoading || !nextUnpaid || !paidDate}>
            {busy ? 'กำลังบันทึก...' : !nextUnpaid && !ctxLoading ? 'ไม่มีงวดค้างให้ลง' : 'ยืนยันลงยอด'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** map fee_kind + สิทธิ์ที่ยัง pending → query param feeAction (deep-link ไปเปิด modal action บน ContractDetail) */
function feeActionParam(kind: FeeKind, pendingDue: boolean, pendingMonths: boolean): string | null {
  if (kind === 'settle') return 'settle'
  if (kind === 'due_day') return 'extend_due_day'
  if (kind === 'months') return 'extend_months'
  // both: เลือก param ตามฝั่งที่ยังไม่ได้ทำ
  if (pendingDue && pendingMonths) return 'extend_both'
  if (pendingDue) return 'extend_due_day'
  if (pendingMonths) return 'extend_months'
  return null
}

// ===== Modal ลงเป็น "รายได้อื่นๆ" — ยอดที่ PJ ตัดมาแต่ไม่ใช่ค่างวด/ค่าปรับ (เช่น ค่าส่งพัสดุ, ค่าเปลี่ยนวันชำระ) =====
function OtherIncomeModal({
  row,
  byName,
  onClose,
  onDone,
}: {
  row: PjSyncReviewRow
  byName: string
  onClose: () => void
  onDone: () => void
}) {
  const navigate = useNavigate()
  const [categoryChoice, setCategoryChoice] = useState<string>(FEE_INCOME_PRESETS[0].category)
  const [customCategory, setCustomCategory] = useState('')
  const [amount, setAmount] = useState(String(row.amount))
  const [note, setNote] = useState('')

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // หลังบันทึกค่าธรรมเนียมที่ต้องมี action คู่ (ขยาย/ปิดด่วน) แต่ยังไม่ได้ทำ → เด้ง prompt นี้
  const [followPrompt, setFollowPrompt] = useState<{ feeAction: string; verb: string } | null>(null)

  // ปิดเมื่อกด Esc (ตาม pattern modal อื่นในโปรเจกต์)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const isCustomCategory = categoryChoice === OTHER_INCOME_CUSTOM
  const selectedPreset = FEE_INCOME_PRESETS.find((p) => p.category === categoryChoice) ?? null
  const feeKind: FeeKind | null = isCustomCategory ? null : (selectedPreset?.feeKind ?? null)
  const category = (isCustomCategory ? customCategory : categoryChoice).trim()
  const receivedAt = (row.paidDate ?? '').slice(0, 10)
  const amountNum = Number(amount) || 0
  const canSubmit = !!row.contractId && !!receivedAt && amountNum > 0 && category.length > 0

  async function confirm() {
    if (!row.contractId || !canSubmit) return
    setBusy(true)
    setErr(null)
    try {
      await applyPjReviewAsOtherIncome({
        reviewId: row.id,
        contractId: row.contractId,
        amount: amountNum,
        category,
        receivedAt,
        note: note.trim() || undefined,
        byName,
        feeKind,
      })

      // ค่าธรรมเนียมที่ต้องมี action จริงบนสัญญา → เช็ก reconcile ว่าทำ action แล้วยัง
      // ถ้ายัง (pending_action) → เด้ง prompt ให้ไปทำต่อทันที (กันลืม)
      if (feeKind) {
        try {
          const rec = await getContractFeeReconcile(row.contractId)
          const pendingDue = rec.due_day === 'pending_action'
          const pendingMonths = rec.months === 'pending_action'
          const pendingSettle = rec.settle === 'pending_action'
          const needAction =
            feeKind === 'settle' ? pendingSettle
            : feeKind === 'due_day' ? pendingDue
            : feeKind === 'months' ? pendingMonths
            : (pendingDue || pendingMonths) // both
          if (needAction) {
            const param = feeActionParam(feeKind, pendingDue, pendingMonths)
            if (param) {
              setFollowPrompt({ feeAction: param, verb: feeKind === 'settle' ? 'ปิดสัญญาก่อนกำหนด' : 'ขยายระยะเวลา' })
              setBusy(false)
              return // ค้าง modal ไว้โชว์ prompt ก่อน (ไม่ปิด/ไม่ reload จนกว่าจะเลือก)
            }
          }
        } catch {
          // เช็ก reconcile พลาด → ไม่บล็อก แค่ปิดตามปกติ (บันทึกรายได้สำเร็จไปแล้ว)
        }
      }
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  // ---- prompt: บันทึกรายได้แล้ว แต่ยังต้องทำ action บนสัญญา ----
  if (followPrompt && row.contractId) {
    return (
      <Modal title="บันทึกรายได้แล้ว — เหลืออีกขั้น" onClose={onDone}>
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-2 rounded-xl bg-green-50 px-3 py-2.5 text-sm text-green-700">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
            <p>ลงค่าธรรมเนียมเป็นรายได้เรียบร้อยแล้ว</p>
          </div>
          <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-700">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <p>
              แต่เคสนี้ยัง<b>ไม่ได้{followPrompt.verb}</b>บนสัญญา —
              ไปทำรายการให้ครบเลยไหมคะ จะได้ไม่ลืม
            </p>
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onDone}>ไว้ทีหลัง</Button>
            <Button
              onClick={() => navigate(`/contract/${row.contractId}?feeAction=${followPrompt.feeAction}`)}
            >
              {followPrompt.verb === 'ปิดสัญญาก่อนกำหนด' ? <Wallet size={14} /> : <CalendarClock size={14} />}
              ไป{followPrompt.verb}
            </Button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="ลงเป็นรายได้อื่นๆ" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl bg-peach-light/40 px-4 py-3 text-sm">
          <span className="text-ink-soft">ลูกค้า</span>
          <span className="text-ink">{row.customerName ?? '—'} ({row.contractNo ?? '—'})</span>
          <span className="text-ink-soft">เลขใบเสร็จ</span>
          <span className="text-ink">{row.invoiceNo}</span>
          {row.paymentType && (
            <>
              <span className="text-ink-soft">ประเภทจาก PJ</span>
              <span className="text-ink">{row.paymentType}</span>
            </>
          )}
          <span className="text-ink-soft">วันที่รับเงิน</span>
          <span className="text-ink">{receivedAt ? thaiDate(receivedAt) : '—'}</span>
        </div>

        <div>
          <label className="mb-1 block text-sm text-ink-soft">หมวดรายได้</label>
          <select
            value={categoryChoice}
            onChange={(e) => setCategoryChoice(e.target.value)}
            className="w-full rounded-xl border border-peach bg-cream px-3 py-2 text-sm text-ink outline-none focus:border-salmon"
          >
            {FEE_INCOME_PRESETS.map((p) => (
              <option key={p.category} value={p.category}>{p.category}</option>
            ))}
            <option value={OTHER_INCOME_CUSTOM}>{OTHER_INCOME_CUSTOM}</option>
          </select>
          {isCustomCategory && (
            <input
              type="text"
              value={customCategory}
              onChange={(e) => setCustomCategory(e.target.value)}
              placeholder="พิมพ์ชื่อหมวด เช่น ค่าธรรมเนียมเปลี่ยนเครื่อง"
              className="mt-2 w-full rounded-xl border border-peach bg-cream px-3 py-2 text-sm text-ink outline-none focus:border-salmon"
            />
          )}
          {feeKind && (
            <p className="mt-1.5 text-xs text-ink-soft">
              หมวดนี้ผูกกับการ{feeKind === 'settle' ? 'ปิดสัญญาก่อนกำหนด' : 'ขยายระยะเวลา/เปลี่ยนวันชำระ'} —
              ถ้ายังไม่ได้ทำบนสัญญา ระบบจะเตือนให้ทำต่อ
            </p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm text-ink-soft">จำนวนเงิน</label>
          <input
            type="number"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full rounded-xl border border-peach bg-cream px-3 py-2 text-sm text-ink outline-none focus:border-salmon"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm text-ink-soft">หมายเหตุ (ไม่บังคับ)</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="รายละเอียดเพิ่มเติม"
            className="w-full rounded-xl border border-peach bg-cream px-3 py-2 text-sm text-ink outline-none focus:border-salmon"
          />
        </div>

        {err && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>ยกเลิก</Button>
          <Button onClick={confirm} disabled={busy || !canSubmit}>
            {busy ? 'กำลังบันทึก...' : 'ยืนยันลงเป็นรายได้อื่นๆ'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
