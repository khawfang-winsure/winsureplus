import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AlertTriangle, CalendarClock, CheckCircle2, ExternalLink, Link2, Receipt, SkipForward, Wallet } from 'lucide-react'
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
import { detectDuplicatePjReviewRows, detectOddAmountFromContext, type PjReviewDupFlag } from '../lib/pjReviewDup'
import {
  explainContractGroupBanner,
  explainReviewRow,
  groupPjReviewByContract,
  reviewRowTypeChip,
  type PjReviewContractGroup,
} from '../lib/pjReviewExplain'
import type { DriftKind, PjReceiptDriftSnapshot } from '../lib/pjReceiptDrift'
import type { PjSyncReviewReason, PjSyncReviewRow, PjReviewContext, PjSyncRunRow } from '../lib/types'
import { useAuth } from '../lib/auth'

/** reason ที่เกิดจากตรวจจับ "ใบเสร็จหาย/ถูกแก้ใน PJ" — ต้องซ่อนปุ่มลงเงินทุกปุ่ม (ดูตรวจ+รายงานเท่านั้น) */
function isDriftReason(reason: PjSyncReviewReason): boolean {
  return reason === 'RECEIPT_MISSING' || reason === 'RECEIPT_CHANGED'
}

/** reason ที่ต้องลงเงินด้วยมือเสมอ (เปิด PJ เทียบยอดเอง แล้วลงชำระที่หน้าสัญญาโดยตรง) — ต่างจาก drift ตรงที่
 *  ยังโชว์คำอธิบายปกติ (explainReviewRow) แต่ต้องซ่อนปุ่ม "ลงตาม PJ" / "รายได้อื่นๆ" เพราะ pj-sync ไม่ได้
 *  คำนวณยอดให้ลงอัตโนมัติ (แค่ตรวจพบส่วนต่าง) — คงไว้แค่ "ข้าม" / "ทำเสร็จแล้ว" */
function isManualOnlyReason(reason: PjSyncReviewReason): boolean {
  return reason === 'RETURNED_CONTRACT_PAYMENT' || reason === 'RETURNED_CONTRACT_OVERAGE'
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
  RETURNED_CONTRACT_PAYMENT: 'คืนเครื่อง — เงินไม่เข้าระบบ',
  RETURNED_CONTRACT_OVERAGE: 'คืนเครื่อง — ยอดเราเกิน PJ',
}
const REASON_TONE: Record<PjSyncReviewReason, 'neutral' | 'green' | 'amber' | 'red'> = {
  MULTI: 'amber',
  PARTIAL: 'amber',
  UNMATCHED: 'red',
  OTHER: 'neutral',
  AMOUNT_MISMATCH: 'red',
  RECEIPT_MISSING: 'red',
  RECEIPT_CHANGED: 'red',
  // สีเขียว = แยกจาก drift(แดง, แค่รายงาน) และ PARTIAL/MULTI(เหลือง, มีปุ่มลงเงินอัตโนมัติ) —
  // เคสนี้ต้องลงมือทำเอง (เปิด PJ เทียบยอด) ไม่ใช่ error ของระบบ แค่ PJ ซ่อนใบเสร็จจาก feed
  RETURNED_CONTRACT_PAYMENT: 'green',
  // เหลือง = ต่างจาก RETURNED_CONTRACT_PAYMENT (เขียว) ตรงที่กลับด้าน — ระบบเราบันทึกเกินยอด PJ จริง
  // ต้องคนตรวจว่าเป็นการลงซ้ำฝั่งเราหรือใบเสร็จถูกลบฝั่ง PJ (เตือนแรงกว่า ไม่ใช่แค่ PJ ซ่อนใบให้ดู)
  RETURNED_CONTRACT_OVERAGE: 'amber',
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

/** ชิปประเภทรายการ → คลาส Tailwind (tone เพิ่มเติมนอก palette ของ Badge — blue ไม่มีใน Badge ปกติ ใช้ span เอง) */
const TYPE_CHIP_CLS: Record<'blue' | 'amber' | 'neutral', string> = {
  blue: 'bg-blue-100 text-blue-700',
  amber: 'bg-amber-100 text-amber-700',
  neutral: 'bg-peach-soft text-ink',
}

/** ฐาน URL ฝั่ง manager ของ PJ (ต้อง login PJ ในแท็บนั้นอยู่แล้ว — เป็นแค่ทางลัด ไม่ได้ auto-login ให้) */
const PJ_MANAGER_BASE_URL = 'https://pj-soft.net/manager'
/** เปิดใบเสร็จตรงๆ — uuid ที่ส่งเข้ามาคือ receipt uuid (row.receiptUuids[0]) ต้องใช้ path /receipts/
 *  ไม่ใช่ /invoices/ (invoices path ผิด → 404 เพราะ uuid นี้ไม่ใช่ invoice uuid) */
const PJ_RECEIPT_URL = (uuid: string) => `${PJ_MANAGER_BASE_URL}/receipts/${uuid}`
/** เปิดหน้า invoice ตรงๆ — ใช้ row.invUuid (มีเฉพาะแถว mode "returned_watch") คนละ uuid กับ receipt uuid */
const PJ_INVOICE_URL = (uuid: string) => `${PJ_MANAGER_BASE_URL}/invoices/${uuid}`

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
  const [ctxByContract, setCtxByContract] = useState<Record<string, PjReviewContext | null>>({})
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const [review, runList] = await Promise.all([
      getPjSyncReview('pending'),
      isAdmin ? getPjSyncRuns(10) : Promise.resolve([]),
    ])
    // แถว drift (ใบเสร็จหาย/ถูกแก้) ต้องโชว์กล่องเทียบ "เราถือ vs PJ ว่า" — ดึงรายละเอียดเพิ่มเฉพาะแถวพวกนี้
    const driftRows = review.filter((r) => isDriftReason(r.reason))
    // บริบทสัญญา (งวดถัดไป/ประวัติจ่าย/เป้าหมายค่าปรับ) — ดึงครั้งเดียวต่อสัญญา (dedupe) ใช้ทั้งการ์ด+ป็อปอัพ
    const contractIds = [...new Set(review.map((r) => r.contractId).filter((id): id is string => id != null))]
    const [details, contexts] = await Promise.all([
      Promise.all(driftRows.map((r) => getPjReceiptDriftDetail(r.id))),
      // ⚠️ .catch(() => null) ต่อสัญญา — ถ้าสัญญาใดสัญญาหนึ่งดึงบริบทพลาด (เช่น RLS/ข้อมูลแปลก) ต้องไม่ทำให้
      // ทั้งกล่องรอตรวจล่ม การ์ดสัญญานั้นจะแค่โชว์แบบไม่มีบริบท (การ์ดอื่นใช้งานได้ปกติ)
      Promise.all(contractIds.map((id) => getPjReviewContext(id).catch(() => null))),
    ])
    const detailMap: Record<string, PjReceiptDriftSnapshot | null> = {}
    driftRows.forEach((r, i) => {
      detailMap[r.id] = details[i]
    })
    const ctxMap: Record<string, PjReviewContext | null> = {}
    contractIds.forEach((id, i) => {
      ctxMap[id] = contexts[i]
    })
    setRows(review)
    setRuns(runList)
    setDriftDetails(detailMap)
    setCtxByContract(ctxMap)
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

  // แถว drift (ใบเสร็จหาย/ถูกแก้ใน PJ) สำคัญกว่าแถวรอตรวจปกติ — เรียงขึ้นบนสุดในการ์ดของสัญญาเดียวกันเสมอ
  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => Number(isDriftReason(b.reason)) - Number(isDriftReason(a.reason))),
    [rows],
  )

  // จัดกลุ่มตามสัญญา (การ์ดเดียวต่อลูกค้า/สัญญา) + แยก UNMATCHED (หาสัญญาไม่เจอ) ไว้ต่างหาก
  const grouped = useMemo(() => groupPjReviewByContract(sortedRows), [sortedRows])

  // กันชั้นใน (route ที่ App.tsx guard อยู่แล้ว)
  if (!isAdminOrStaff) return <EmptyState title="เฉพาะพนักงาน/แอดมินเท่านั้น" />

  const latest = runs[0] ?? null
  const latestBad = latest && (latest.status === 'error' || latest.status === 'login_failed')

  const applyTargetCtx = applyTarget?.contractId ? ctxByContract[applyTarget.contractId] ?? null : null
  const applyTargetDup = applyTarget ? dupMap.get(applyTarget.id)?.isDuplicate ?? false : false

  return (
    <div>
      <PageTitle
        sub="ระบบดึงยอดจาก PJ อัตโนมัติทุก 15 นาที — เคสที่ลงให้ไม่ได้ (จ่ายข้ามงวด/บางส่วน/หาสัญญาไม่เจอ) มารอให้ตรวจที่นี่ จัดกลุ่มตามสัญญาไว้ให้แล้ว"
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

      {/* ===== กล่องรอตรวจ — จัดกลุ่มตามสัญญา (การ์ดเดียวต่อลูกค้า) ===== */}
      {loading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="ไม่มีเคสรอตรวจ 🎉" hint="ระบบลงยอดที่ตรงเป๊ะให้อัตโนมัติแล้ว" />
      ) : (
        <div className="flex flex-col gap-4">
          {grouped.groups.map((group) => (
            <ContractReviewCard
              key={group.contractId}
              group={group}
              ctx={ctxByContract[group.contractId] ?? null}
              dupMap={dupMap}
              driftDetails={driftDetails}
              onApply={setApplyTarget}
              onOtherIncome={setOtherIncomeTarget}
              onResolve={(row, action) => setTarget({ row, action })}
            />
          ))}

          {grouped.unmatched.length > 0 && (
            <Card>
              <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-peach pb-3">
                <Badge tone="red">หาสัญญาไม่เจอ</Badge>
                <p className="text-sm text-ink-soft">
                  {grouped.unmatched.length} รายการ — ใบเสร็จจาก PJ ที่จับคู่กับสัญญาในระบบเราไม่ได้
                </p>
              </div>
              <div className="flex flex-col gap-3">
                {grouped.unmatched.map((row) => (
                  <div key={row.id} className="rounded-xl border border-peach bg-cream px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex flex-wrap items-center gap-1.5">
                          <Badge tone={REASON_TONE[row.reason]}>{REASON_LABEL[row.reason]}</Badge>
                          <span className="text-xs text-ink-soft whitespace-nowrap">
                            เลขใบเสร็จ {row.invoiceNo} · {row.paidDate ? thaiDate(row.paidDate.slice(0, 10)) : 'ไม่ระบุวันที่'}
                          </span>
                        </div>
                        <p className="text-sm text-ink">{explainReviewRow(row, null)}</p>
                      </div>
                      <p className="whitespace-nowrap text-sm font-semibold text-ink">{baht(row.amount + row.penaltyAmount)} ฿</p>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-end gap-1.5 border-t border-peach/60 pt-2.5">
                      <Button variant="ghost" onClick={() => setTarget({ row, action: 'skipped' })}>
                        <SkipForward size={13} />
                        ข้าม
                      </Button>
                      <Button variant="ghost" onClick={() => setTarget({ row, action: 'resolved' })}>
                        <CheckCircle2 size={13} />
                        ทำเสร็จแล้ว
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
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
        <ApplyPjModal
          row={applyTarget}
          ctx={applyTargetCtx}
          isDuplicate={applyTargetDup}
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

// ===== การ์ด 1 ใบ = แถวรอตรวจทั้งหมดของสัญญาเดียวกัน (ลูกค้า/สัญญาเดียวกัน) =====
function ContractReviewCard({
  group,
  ctx,
  dupMap,
  driftDetails,
  onApply,
  onOtherIncome,
  onResolve,
}: {
  group: PjReviewContractGroup
  ctx: PjReviewContext | null
  dupMap: Map<string, PjReviewDupFlag>
  driftDetails: Record<string, PjReceiptDriftSnapshot | null>
  onApply: (row: PjSyncReviewRow) => void
  onOtherIncome: (row: PjSyncReviewRow) => void
  onResolve: (row: PjSyncReviewRow, action: 'resolved' | 'skipped') => void
}) {
  const hasDup = group.rows.some((r) => dupMap.get(r.id)?.isDuplicate)
  const banner = explainContractGroupBanner(group.rows, ctx, hasDup)

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2 border-b border-peach pb-3">
        <div>
          <p className="font-semibold text-ink">{group.customerName ?? '—'}</p>
          <p className="text-xs text-ink-soft">
            สัญญา {group.contractNo ?? '—'} · {group.rows.length} รายการรอตรวจ
          </p>
        </div>
        <Link to={`/contract/${group.contractId}`}>
          <Button variant="ghost">
            <ExternalLink size={13} />
            ดูสัญญา
          </Button>
        </Link>
      </div>

      {banner && (
        <div
          className={`mb-3 flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm ${
            banner.tone === 'green' ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'
          }`}
        >
          {banner.tone === 'green' ? (
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          ) : (
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          )}
          <p>{banner.text}</p>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {group.rows.map((row) => (
          <ReviewLineItem
            key={row.id}
            row={row}
            ctx={ctx}
            isDuplicate={dupMap.get(row.id)?.isDuplicate ?? false}
            driftDetail={driftDetails[row.id] ?? null}
            onApply={() => onApply(row)}
            onOtherIncome={() => onOtherIncome(row)}
            onResolve={(action) => onResolve(row, action)}
          />
        ))}
      </div>
    </Card>
  )
}

// ===== 1 รายการในการ์ด — อธิบายตัวเอง + ปุ่มจัดการ (ลงตาม PJ / รายได้อื่นๆ / ข้าม / ทำเสร็จแล้ว) =====
function ReviewLineItem({
  row,
  ctx,
  isDuplicate,
  driftDetail,
  onApply,
  onOtherIncome,
  onResolve,
}: {
  row: PjSyncReviewRow
  ctx: PjReviewContext | null
  isDuplicate: boolean
  driftDetail: PjReceiptDriftSnapshot | null
  onApply: () => void
  onOtherIncome: () => void
  onResolve: (action: 'resolved' | 'skipped') => void
}) {
  const isDrift = isDriftReason(row.reason)
  const isManualOnly = isManualOnlyReason(row.reason)
  const chip = reviewRowTypeChip(row)
  // ค่าปรับล้วน (paymentType='penalty'): row.amount กับ row.penaltyAmount เป็นเลขเดียวกัน (ยอด PJ ใบเดียว)
  // ห้ามบวกกัน ไม่งั้นยอดเบิ้ล (เช่น 229 → โชว์ 458) — ใช้ตรรกะเดียวกับ isPenaltyOnly ใน ApplyPjModal
  const isPenaltyOnly = row.paymentType === 'penalty'
  const totalAmount = isPenaltyOnly ? row.amount : row.amount + row.penaltyAmount
  // ลิงก์เปิดใน PJ — มี invUuid (มีเฉพาะแถว mode "returned_watch") ให้เปิดหน้า invoice ตรงๆ ก่อน
  // ไม่มีค่อย fallback ไปเปิดใบเสร็จแรกจาก receiptUuids (แถวปกติ)
  const pjLinkHref = row.invUuid
    ? PJ_INVOICE_URL(row.invUuid)
    : row.receiptUuids[0]
      ? PJ_RECEIPT_URL(row.receiptUuids[0])
      : null

  return (
    <div className={`rounded-xl border px-4 py-3 ${isDrift ? 'border-red-200 bg-red-50/40' : 'border-peach bg-cream'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${TYPE_CHIP_CLS[chip.tone]}`}>
              {chip.label}
            </span>
            <Badge tone={REASON_TONE[row.reason]}>{REASON_LABEL[row.reason]}</Badge>
            {isDuplicate && <Badge tone="red">น่าจะซ้ำ</Badge>}
            <span className="text-xs text-ink-soft whitespace-nowrap">
              เลขใบเสร็จ {row.invoiceNo} · {row.paidDate ? thaiDate(row.paidDate.slice(0, 10)) : 'ไม่ระบุวันที่'}
            </span>
          </div>
          {!isDrift && <p className="text-sm text-ink">{explainReviewRow(row, ctx)}</p>}
        </div>
        <div className="shrink-0 text-right">
          <p className="whitespace-nowrap text-sm font-semibold text-ink">{baht(totalAmount)} ฿</p>
          {isPenaltyOnly ? (
            <p className="whitespace-nowrap text-xs text-ink-soft">ค่าปรับ {baht(row.amount)}</p>
          ) : (
            row.penaltyAmount > 0 && (
              <p className="whitespace-nowrap text-xs text-ink-soft">
                ค่างวด {baht(row.amount)} + ค่าปรับ {baht(row.penaltyAmount)}
              </p>
            )
          )}
        </div>
      </div>

      {isDrift && driftDetail && (
        <div className="mt-3">
          <DriftCompareBox detail={driftDetail} />
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-end gap-1.5 border-t border-peach/60 pt-2.5">
        {pjLinkHref && (
          <a href={pjLinkHref} target="_blank" rel="noreferrer">
            <Button variant="ghost">
              <Link2 size={13} />
              เปิดใน PJ
            </Button>
          </a>
        )}
        {isDrift ? (
          <Button variant="ghost" onClick={() => onResolve('resolved')}>
            <CheckCircle2 size={13} />
            รับทราบ
          </Button>
        ) : isManualOnly ? (
          // ต้องลงมือทำเอง (เปิด PJ เทียบยอด แล้วลงชำระที่หน้าสัญญาโดยตรง) — ไม่มีปุ่มลงเงิน/รายได้อื่นๆ
          // เพราะ pj-sync ไม่ได้คำนวณยอดที่ควรลงให้ (แค่ตรวจพบส่วนต่าง)
          <>
            <Button variant="ghost" onClick={() => onResolve('skipped')}>
              <SkipForward size={13} />
              ข้าม
            </Button>
            <Button variant="ghost" onClick={() => onResolve('resolved')}>
              <CheckCircle2 size={13} />
              ทำเสร็จแล้ว
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onResolve('skipped')}>
              <SkipForward size={13} />
              ข้าม
            </Button>
            <Button variant="ghost" onClick={onOtherIncome}>
              <Receipt size={13} />
              รายได้อื่นๆ
            </Button>
            <Button variant="ghost" onClick={() => onResolve('resolved')}>
              <CheckCircle2 size={13} />
              ทำเสร็จแล้ว
            </Button>
            <Button onClick={onApply}>
              <Wallet size={13} />
              ลงตาม PJ
            </Button>
          </>
        )}
      </div>
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

  // ปิดเมื่อกด Esc (ตาม pattern modal อื่นในโปรเจกต์)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

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

// ===== Modal ยืนยัน "ลงตาม PJ" — กดเดียวจบ: ยอด/วันที่ยึดตามที่ PJ ส่งมา ไม่ต้องพิมพ์เอง =====
// ต้อง confirm 1 ครั้งก่อนลงเสมอ (กล่องนี้ ~28% เป็นเงินซ้ำ — ห้ามกดพลาด) เตือนชัดถ้าธง "น่าจะซ้ำ"
function ApplyPjModal({
  row,
  ctx,
  isDuplicate,
  byName,
  onClose,
  onDone,
  onSwitchToOtherIncome,
}: {
  row: PjSyncReviewRow
  ctx: PjReviewContext | null
  isDuplicate: boolean
  byName: string
  onClose: () => void
  onDone: () => void
  onSwitchToOtherIncome: () => void
}) {
  // ยึดวันที่จาก PJ เสมอ — ช่องกรอกเปิดใช้เฉพาะกรณี PJ ไม่ได้ส่งวันที่มา (edge case)
  const [paidDate, setPaidDate] = useState((row.paidDate ?? '').slice(0, 10))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // ปิดเมื่อกด Esc
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // เคสค่าปรับล้วน (AMOUNT_MISMATCH, paymentType='penalty'): row.amount กับ row.penaltyAmount เป็นเลขเดียวกัน
  // (ยอด PJ ใบเดียว) — ต้องส่งเข้า penalty-only branch ของ record_payment_spread (principal=0) ไม่งั้นเงินเบิ้ล
  // (ตัดเงินต้นผี X + ลงค่าปรับ X แทนที่จะเป็นค่าปรับ X ใบเดียว) ประเภทอื่น (installment/other) ยังคงเดิม
  const isPenaltyOnly = row.paymentType === 'penalty'
  const principalToApply = isPenaltyOnly ? 0 : row.amount
  const penaltyToApply = isPenaltyOnly ? row.amount : row.penaltyAmount
  const nextUnpaid = ctx?.nextUnpaid ?? null
  const total = principalToApply + penaltyToApply
  const spreadPreview = spreadPayment(ctx?.unpaidInstallments ?? [], principalToApply)
  const oddFlag = ctx ? detectOddAmountFromContext(row.amount, ctx) : { isOddAmount: false, hint: null }
  const explanation = explainReviewRow(row, ctx)
  // penalty-only ไม่ต้องมีงวดค้างเงินต้น (record_payment_spread เข้า penalty-only branch เลย) — เคสอื่นยังต้องมี
  const canConfirm = isPenaltyOnly ? !!row.contractId && !!paidDate : !!row.contractId && !!nextUnpaid && !!paidDate

  async function confirm() {
    if (!row.contractId || !paidDate || !canConfirm) return
    setBusy(true)
    setErr(null)
    try {
      await applyPjReviewPayment({
        reviewId: row.id,
        contractId: row.contractId,
        principal: principalToApply,
        penalty: penaltyToApply,
        paidDate,
        byName,
        note: 'ลงตาม PJ จากกล่องรอตรวจ',
      })
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal title="ยืนยันลงตาม PJ" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl bg-peach-light/40 px-4 py-3 text-sm">
          <span className="text-ink-soft">ลูกค้า</span>
          <span className="text-ink">{row.customerName ?? '—'}</span>
          <span className="text-ink-soft">สัญญา</span>
          <span className="text-ink">{row.contractNo ?? '—'}</span>
          <span className="text-ink-soft">เลขใบเสร็จ</span>
          <span className="text-ink">{row.invoiceNo}</span>
        </div>

        {isDuplicate && (
          <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-700">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <p>ระบบตรวจพบรายการอื่นในกล่องที่ยอด/วันที่/สัญญาตรงกันเป๊ะ — เช็คให้ชัวร์ก่อนกดยืนยัน ป้องกันลงเงินซ้ำ</p>
          </div>
        )}

        <p className="text-sm text-ink">{explanation}</p>

        {!ctx ? (
          <Loading />
        ) : (
          <>
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
            ) : isPenaltyOnly ? (
              <div className="flex items-start gap-2 rounded-xl bg-blue-50 px-3 py-2.5 text-sm text-blue-700">
                <Wallet size={16} className="mt-0.5 shrink-0" />
                <p>รายการนี้เป็นค่าปรับล้วน ไม่ตัดเงินต้นงวดไหน — ลงได้แม้ไม่มีงวดค้าง</p>
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

            {/* ยอดที่จะลง — ยึดจาก PJ ทุกช่อง ไม่ต้องพิมพ์เอง (ค่าปรับล้วน: เงินต้น=0 เสมอ กันลงเบิ้ล) */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-peach bg-peach-light/30 px-3 py-2.5">
                <p className="text-xs text-ink-soft">เงินต้น (ค่างวด)</p>
                <p className="whitespace-nowrap text-sm font-semibold text-ink">{baht(principalToApply)} ฿</p>
              </div>
              <div className="rounded-xl border border-peach bg-peach-light/30 px-3 py-2.5">
                <p className="text-xs text-ink-soft">ค่าปรับ</p>
                <p className="whitespace-nowrap text-sm font-semibold text-ink">{baht(penaltyToApply)} ฿</p>
              </div>
              <div className="rounded-xl border border-peach bg-peach-light/30 px-3 py-2.5">
                <p className="text-xs text-ink-soft">รวม</p>
                <p className="whitespace-nowrap text-sm font-semibold text-ink">{baht(total)} ฿</p>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm text-ink-soft">วันที่จ่าย</label>
              {row.paidDate ? (
                <p className="rounded-xl border border-peach bg-peach-light/30 px-3 py-2 text-sm text-ink">
                  {thaiDate(row.paidDate.slice(0, 10))} <span className="text-xs text-ink-soft">(ตาม PJ)</span>
                </p>
              ) : (
                <>
                  <input
                    type="date"
                    value={paidDate}
                    onChange={(e) => setPaidDate(e.target.value)}
                    className="w-full rounded-xl border border-peach bg-cream px-3 py-2 text-sm text-ink outline-none focus:border-salmon"
                  />
                  <p className="mt-1 text-xs text-salmon">PJ ไม่ได้ระบุวันที่จ่ายมา กรุณาระบุเอง</p>
                </>
              )}
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

            {/* พรีวิวการตัดงวด — คำนวณจากยอดของ PJ ตรงๆ ไม่มีช่องให้แก้ */}
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

            {/* ประวัติการจ่ายล่าสุด — เทียบกับ PJ ก่อนกดยืนยันได้ */}
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
          </>
        )}

        {err && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>ยกเลิก</Button>
          <Button onClick={confirm} disabled={busy || !ctx || !canConfirm}>
            {busy ? 'กำลังบันทึก...' : !nextUnpaid && !isPenaltyOnly && ctx ? 'ไม่มีงวดค้างให้ลง' : 'ยืนยันลงตาม PJ'}
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
