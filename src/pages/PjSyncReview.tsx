import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, ExternalLink, SkipForward } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Loading, Modal, PageTitle } from '../components/ui'
import { baht, thaiDate } from '../lib/format'
import { getPjSyncReview, getPjSyncRuns, resolvePjReviewItem } from '../lib/db'
import type { PjSyncReviewReason, PjSyncReviewRow, PjSyncRunRow } from '../lib/types'
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
                  <td className="py-3 pr-4 text-right text-ink whitespace-nowrap">{baht(r.amount)} ฿</td>
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
                      <Button onClick={() => setTarget({ row: r, action: 'resolved' })}>
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
