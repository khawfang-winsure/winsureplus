import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, ExternalLink, SkipForward, Wallet } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Loading, Modal, PageTitle } from '../components/ui'
import { baht, thaiDate } from '../lib/format'
import { applyPjReviewPayment, getPjReviewContext, getPjSyncReview, getPjSyncRuns, resolvePjReviewItem } from '../lib/db'
import { spreadPayment } from '../lib/paymentSpread'
import type { PjReviewContext, PjSyncReviewReason, PjSyncReviewRow, PjSyncRunRow } from '../lib/types'
import { useAuth } from '../lib/auth'

// ===== ป้ายเหตุผล (reason → ไทย + โทนสี) =====
const REASON_LABEL: Record<PjSyncReviewReason, string> = {
  MULTI: 'จ่ายข้ามงวด',
  PARTIAL: 'จ่ายบางส่วน',
  UNMATCHED: 'หาสัญญาไม่เจอ',
  OTHER: 'ประเภทอื่น',
  AMOUNT_MISMATCH: 'ยอดไม่ตรง',
}
const REASON_TONE: Record<PjSyncReviewReason, 'neutral' | 'amber' | 'red'> = {
  MULTI: 'amber',
  PARTIAL: 'amber',
  UNMATCHED: 'red',
  OTHER: 'neutral',
  AMOUNT_MISMATCH: 'red',
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
  const isAdmin = !configured || role === 'admin'

  const [rows, setRows] = useState<PjSyncReviewRow[]>([])
  const [runs, setRuns] = useState<PjSyncRunRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const [review, runList] = await Promise.all([getPjSyncReview('pending'), getPjSyncRuns(10)])
    setRows(review)
    setRuns(runList)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const [target, setTarget] = useState<{ row: PjSyncReviewRow; action: 'resolved' | 'skipped' } | null>(null)
  const [applyTarget, setApplyTarget] = useState<PjSyncReviewRow | null>(null)

  // กันชั้นใน (route ที่ App.tsx guard อยู่แล้ว)
  if (!isAdmin) return <EmptyState title="เฉพาะแอดมินเท่านั้น" />

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

      {/* ===== แถบสถานะการรัน ===== */}
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
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-peach/50 hover:bg-peach-light/30">
                  <td className="py-3 pr-4 text-ink-soft whitespace-nowrap">
                    {r.paidDate ? thaiDate(r.paidDate.slice(0, 10)) : '—'}
                  </td>
                  <td className="py-3 pr-4 text-ink whitespace-nowrap">{r.invoiceNo}</td>
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
                    <Badge tone={REASON_TONE[r.reason]}>{REASON_LABEL[r.reason]}</Badge>
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
                      <Button variant="ghost" onClick={() => setTarget({ row: r, action: 'resolved' })}>
                        <CheckCircle2 size={13} />
                        ทำเสร็จแล้ว
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {target && (
        <ResolveModal
          row={target.row}
          action={target.action}
          byName={userName ?? 'ไม่ทราบ'}
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
        />
      )}
    </div>
  )
}

// ===== Modal ยืนยัน ทำเสร็จแล้ว / ข้าม (note optional) =====
function ResolveModal({
  row,
  action,
  byName,
  onClose,
  onDone,
}: {
  row: PjSyncReviewRow
  action: 'resolved' | 'skipped'
  byName: string
  onClose: () => void
  onDone: () => void
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const title = action === 'resolved' ? 'ทำเสร็จแล้ว' : 'ข้ามเคสนี้'

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
          {action === 'resolved'
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
}: {
  row: PjSyncReviewRow
  byName: string
  onClose: () => void
  onDone: () => void
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
