import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageTitle, Textarea } from '../components/ui'
import { FIELD_VISIT_CHANGED_EVENT } from '../components/nav'
import {
  ackFieldVisitUpdate,
  cancelDispatchedFieldVisit,
  cancelFieldVisitRequest,
  closeFieldVisitRequest,
  dispatchFieldVisitRound,
  getAddressesForContracts,
  getFieldVisitAttention,
  listFieldVisitRequests,
  recordFieldVisitOutcome,
} from '../lib/db'
import {
  FIELD_VISIT_REASON_LABEL,
  FIELD_VISIT_UPDATE_TONE,
  FIELD_VISIT_RESULT_CODES,
  FIELD_VISIT_RESULT_GROUP,
  FIELD_VISIT_RESULT_LABEL,
  FIELD_VISIT_STATUS_LABEL,
  PAID_NO_MONEY_HINT,
  RELATIVE_MET_LEGAL_HINT,
  buildFieldCopyText,
  buildFieldUpdateLineText,
  defaultRoundLabel,
  fieldVisitResultLabel,
  fieldVisitStatusTone,
  fieldVisitUpdateLabel,
  preDispatchWarnings,
  toFieldItem,
  validateFieldVisitOutcome,
  waitingDays,
  type FieldItem,
  type FieldVisitResultCode,
  type FieldVisitTone,
} from '../lib/fieldVisit'
import type { FieldVisitAttention, FieldVisitRequestRow } from '../lib/types'

type Tab = 'updates' | 'waiting' | 'dispatched' | 'done'
type Tone = 'neutral' | 'green' | 'amber' | 'red'

const RESULT_GROUPS: { title: string; group: 'found' | 'not_found' }[] = [
  { title: 'พบตัวลูกค้า', group: 'found' },
  { title: 'ไม่พบตัวลูกค้า', group: 'not_found' },
]

function toneFrom(t: FieldVisitTone): Tone {
  return t === 'gray' || t === 'blue' ? 'neutral' : t
}

function toneOf(r: FieldVisitRequestRow): Tone {
  return toneFrom(fieldVisitStatusTone(r.status, r.resultCode, r.closeCode))
}

function todayBangkok(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date())
}

type Dialog =
  | { kind: 'round'; rows: FieldVisitRequestRow[] }
  | { kind: 'cancelDispatched'; row: FieldVisitRequestRow }
  | { kind: 'confirmPaid'; row: FieldVisitRequestRow }
  | { kind: 'cancel'; row: FieldVisitRequestRow }
  | { kind: 'result'; row: FieldVisitRequestRow }
  | { kind: 'close'; row: FieldVisitRequestRow }

const baht = (n: number) => n.toLocaleString('th-TH')

function formatDateOnly(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-GB', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric' })
}

function formatYmd(ymd: string): string {
  const [y, m, d] = ymd.split('-')
  return y && m && d ? `${d}/${m}/${y}` : ymd
}

/** บวกวันให้ YYYY-MM-DD (ปฏิทินล้วน ไม่ผูกเขตเวลา) */
function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** คำขอที่พักไว้ถึงวันหลังวันนี้ (ลูกค้านัดจ่าย) — เลือกเข้ารอบไม่ได้ */
function isOnHold(r: FieldVisitRequestRow, today: string): boolean {
  return r.status === 'requested' && !!r.holdUntil && r.holdUntil > today
}

/** จำนวนวันตามปฏิทินไทยตั้งแต่ iso ถึงวันนี้ */
function daysSince(iso: string): number {
  return waitingDays(iso, new Date())
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : 'ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง'
}

function RowInfo({ r, children }: { r: FieldVisitRequestRow; children?: React.ReactNode }) {
  const closedContract = r.contractStatus === 'closed' || r.contractStatus === 'returned_closed'
  const open = r.status === 'requested' || r.status === 'dispatched'
  return (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-semibold text-ink">{r.customerName}</span>
        <Badge tone={toneOf(r)}>
          {r.status === 'found' || r.status === 'not_found'
            ? `ลงพื้นที่: ${fieldVisitResultLabel(r.status, r.resultCode, r.promiseDate)}`
            : FIELD_VISIT_STATUS_LABEL[r.status]}
        </Badge>
        {open && closedContract && <Badge tone="red">สัญญาปิดแล้ว</Badge>}
        {r.status === 'dispatched' && r.liveState && (
          <Badge tone={toneFrom(FIELD_VISIT_UPDATE_TONE[r.liveState])}>
            {fieldVisitUpdateLabel(r.liveState, {
              overdueAmount: r.overdueAmount,
              promiseDate: r.latestPromiseDate ?? r.activePromiseDate,
            })}
          </Badge>
        )}
        {r.holdUntil && isOnHold(r, todayBangkok()) && (
          <Badge tone="amber">พักไว้ถึง {formatYmd(r.holdUntil)} (ลูกค้านัดจ่าย)</Badge>
        )}
        {r.status === 'requested' && r.paidSinceRequest > 0 && (
          <Badge tone="amber">
            จ่ายแล้ว {baht(r.paidSinceRequest)} บาท หลังวันที่ขอ
          </Badge>
        )}
      </div>
      <div className="mt-1 text-sm text-ink-soft">
        <Link to={`/contract/${r.contractId}`} className="font-medium text-ink underline">
          {r.contractNo}
        </Link>{' '}
        · ร้าน {r.shopName ?? '-'} · ค้าง {r.daysLate} วัน · ยอดค้าง {baht(r.overdueAmount)} บาท
      </div>
      <p className="mt-1 text-sm text-ink">
        เหตุผล: {FIELD_VISIT_REASON_LABEL[r.reason]}
        {r.note ? <span className="text-ink-soft"> — {r.note}</span> : null}
      </p>
      <p className="mt-1 text-xs text-ink-soft">
        ขอโดย {r.requestedByName ?? '-'} · {formatDateOnly(r.requestedAt)}
        {r.status === 'requested' && <> · รอมาแล้ว {waitingDays(r.requestedAt, new Date())} วัน</>}
      </p>
      {children}
    </div>
  )
}

function OpenLink({ r }: { r: FieldVisitRequestRow }) {
  return (
    <Link
      to={`/contract/${r.contractId}`}
      className="inline-flex min-h-11 items-center gap-1 rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-white"
    >
      เปิดสัญญา
      <ChevronRight size={16} aria-hidden />
    </Link>
  )
}

function ActionModal({
  dialog,
  onClose,
  onDone,
}: {
  dialog: Extract<Dialog, { kind: 'round' | 'cancel' | 'close' | 'result' }>
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const [label, setLabel] = useState(() => defaultRoundLabel(new Date()))
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [code, setCode] = useState<FieldVisitResultCode | null>(null)
  const [promiseDate, setPromiseDate] = useState('')
  const [reviewed, setReviewed] = useState(false)
  const today = todayBangkok()
  const warned = useMemo(
    () =>
      dialog.kind === 'round'
        ? dialog.rows
            .map((row) => ({ row, warns: preDispatchWarnings(row, today) }))
            .filter((x) => x.warns.length > 0)
        : [],
    [dialog, today],
  )

  const needText = dialog.kind === 'cancel' || dialog.kind === 'close'
  const title =
    dialog.kind === 'round'
      ? `สร้างรอบส่งลงพื้นที่ (${dialog.rows.length} เคส)`
      : dialog.kind === 'cancel'
        ? `ยกเลิกคำขอ — ${dialog.row.customerName}`
        : dialog.kind === 'close'
          ? `ปิดเรื่อง — ${dialog.row.customerName}`
          : `ลงผลลงพื้นที่ — ${dialog.row.customerName}`

  async function submit() {
    if (busy) return
    const t = text.trim()
    if (dialog.kind === 'result') {
      const v = validateFieldVisitOutcome(code, t, promiseDate || null, today)
      if (v || !code) {
        setErr(v)
        return
      }
    }
    if (needText && !t) {
      setErr('กรุณาใส่เหตุผล')
      return
    }
    if (dialog.kind === 'round' && !label.trim()) {
      setErr('กรุณาใส่ชื่อรอบ')
      return
    }
    if (dialog.kind === 'round' && warned.length > 0 && !reviewed) {
      setErr('กรุณาติ๊ก "ตรวจแล้ว ยืนยันส่ง" ก่อน')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      if (dialog.kind === 'round')
        await dispatchFieldVisitRound(
          dialog.rows.map((row) => row.id),
          label.trim(),
          t,
        )
      else if (dialog.kind === 'cancel') await cancelFieldVisitRequest(dialog.row.id, t)
      else if (dialog.kind === 'close') await closeFieldVisitRequest(dialog.row.id, t)
      else if (code) await recordFieldVisitOutcome(dialog.row.id, code, t, code === 'promised' ? promiseDate : null)
      await onDone()
    } catch (e: unknown) {
      setErr(errText(e))
      setBusy(false)
    }
  }

  return (
    <Modal title={title} onClose={busy ? () => undefined : onClose} closeOnEsc={!busy} accessible>
      <div className="flex flex-col gap-3">
        {dialog.kind === 'round' && (
          <Field label="ชื่อรอบ" required>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
          </Field>
        )}
        {dialog.kind === 'round' && warned.length > 0 && (
          <div role="alert" className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <p className="flex items-center gap-1.5 font-semibold">
              <AlertTriangle size={16} aria-hidden />
              {warned.length} เคสมีข้อควรระวัง
            </p>
            <ul className="mt-1.5 space-y-1.5">
              {warned.map(({ row, warns }) => (
                <li key={row.id}>
                  <span className="font-medium">{row.customerName}</span>
                  {row.invNo ? ` (${row.invNo})` : ''}
                  <ul className="list-disc pl-5">
                    {warns.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <label className="mt-2 flex cursor-pointer items-center gap-2 font-medium">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
                disabled={busy}
              />
              ตรวจแล้ว ยืนยันส่ง
            </label>
          </div>
        )}
        {dialog.kind === 'result' &&
          RESULT_GROUPS.map((g) => (
            <fieldset key={g.group}>
              <legend className="mb-1 text-sm font-semibold text-ink">{g.title}</legend>
              <div className="space-y-1.5">
                {FIELD_VISIT_RESULT_CODES.filter((c) => FIELD_VISIT_RESULT_GROUP[c] === g.group).map((c) => (
                  <label key={c} className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                    <input
                      type="radio"
                      name="field-visit-result"
                      checked={code === c}
                      onChange={() => setCode(c)}
                      disabled={busy}
                    />
                    {FIELD_VISIT_RESULT_LABEL[c]}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        {dialog.kind === 'result' && code === 'promised' && (
          <Field label="วันนัดจ่าย" required>
            <Input type="date" min={today} value={promiseDate} onChange={(e) => setPromiseDate(e.target.value)} />
          </Field>
        )}
        {dialog.kind === 'result' && code === 'relative_met' && (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">{RELATIVE_MET_LEGAL_HINT}</p>
        )}
        {dialog.kind === 'result' && code === 'paid' && (
          <p className="rounded-xl bg-peach-light px-3 py-2 text-sm text-ink-soft">{PAID_NO_MONEY_HINT}</p>
        )}
        <Field
          label={
            dialog.kind === 'round'
              ? 'โน้ตถึงทีมลงพื้นที่ (ไม่บังคับ)'
              : dialog.kind === 'result'
                ? code === 'relative_met'
                  ? 'โน้ตผลการลงพื้นที่ (จำเป็น)'
                  : 'โน้ตผลการลงพื้นที่ (ไม่บังคับ)'
                : 'เหตุผล'
          }
          required={needText || (dialog.kind === 'result' && code === 'relative_met')}
        >
          <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        {err && (
          <p role="alert" className="text-sm text-red-700">
            {err}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>
            ยกเลิก
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={busy}>
            {busy ? 'กำลังบันทึก...' : 'ยืนยัน'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

type CancelCode = 'paid_before_visit' | 'on_hold_promise' | 'cancel_other'

const CANCEL_OPTIONS: { code: CancelCode; label: string }[] = [
  { code: 'paid_before_visit', label: 'ลูกค้าจ่ายเองก่อนลงพื้นที่' },
  { code: 'on_hold_promise', label: 'ลูกค้านัดจ่ายแล้ว (พักไว้)' },
  { code: 'cancel_other', label: 'อื่นๆ' },
]

function CancelDispatchedModal({
  row,
  onClose,
  onDone,
}: {
  row: FieldVisitRequestRow
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const today = todayBangkok()
  const maxHold = addDaysYmd(today, 60)
  const suggested = [row.latestPromiseDate, row.activePromiseDate].find((d): d is string => !!d && d >= today) ?? ''
  const [code, setCode] = useState<CancelCode | null>(null)
  const [holdUntil, setHoldUntil] = useState(suggested)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    if (busy) return
    if (!code) {
      setErr('กรุณาเลือกเหตุผล')
      return
    }
    const n = note.trim()
    if (code === 'on_hold_promise' && (!holdUntil || holdUntil < today)) {
      setErr('กรุณาใส่วันนัดจ่าย (ต้องเป็นวันนี้หรืออนาคต)')
      return
    }
    if (code === 'on_hold_promise' && holdUntil > maxHold) {
      setErr('พักรอนัดจ่ายได้ไม่เกิน 60 วันนับจากวันนี้')
      return
    }
    if (code === 'cancel_other' && !n) {
      setErr('กรุณาใส่เหตุผล')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await cancelDispatchedFieldVisit(row.id, code, n, code === 'on_hold_promise' ? holdUntil : null)
      await onDone()
    } catch (e: unknown) {
      setErr(errText(e))
      setBusy(false)
    }
  }

  return (
    <Modal title={`ยกเลิกการไป — ${row.customerName}`} onClose={busy ? () => undefined : onClose} closeOnEsc={!busy} accessible>
      <div className="flex flex-col gap-3">
        <fieldset>
          <legend className="mb-1 text-sm font-semibold text-ink">เหตุผลที่ไม่ต้องไปแล้ว</legend>
          <div className="space-y-1.5">
            {CANCEL_OPTIONS.map((o) => (
              <label key={o.code} className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                <input
                  type="radio"
                  name="field-visit-cancel"
                  checked={code === o.code}
                  onChange={() => setCode(o.code)}
                  disabled={busy}
                />
                {o.label}
              </label>
            ))}
          </div>
        </fieldset>
        {code === 'on_hold_promise' && (
          <>
            <Field label="วันนัดจ่าย (พักคำขอไว้ถึงวันนี้)" required>
              <Input type="date" min={today} max={maxHold} value={holdUntil} onChange={(e) => setHoldUntil(e.target.value)} />
            </Field>
            <p className="rounded-xl bg-peach-light px-3 py-2 text-sm text-ink-soft">
              ระบบจะสร้างคำขอใหม่รอไว้ในแท็บ รอรอบ และพักไว้จนถึงวันนัด
            </p>
          </>
        )}
        <Field label={code === 'cancel_other' ? 'เหตุผล' : 'โน้ต (ไม่บังคับ)'} required={code === 'cancel_other'}>
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {err && (
          <p role="alert" className="text-sm text-red-700">
            {err}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>
            ปิดหน้าต่าง
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={busy}>
            {busy ? 'กำลังบันทึก...' : 'ยืนยันยกเลิกการไป'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function ConfirmPaidModal({
  row,
  onClose,
  onDone,
}: {
  row: FieldVisitRequestRow
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      await cancelDispatchedFieldVisit(row.id, 'paid_before_visit', '', null)
      await onDone()
    } catch (e: unknown) {
      setErr(errText(e))
      setBusy(false)
    }
  }

  return (
    <Modal title={`ยกเลิกการไป — ${row.customerName}`} onClose={busy ? () => undefined : onClose} closeOnEsc={!busy} accessible>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink">ลูกค้าจ่ายครบแล้ว ยืนยันยกเลิกการลงพื้นที่เคสนี้ใช่ไหม</p>
        {err && (
          <p role="alert" className="text-sm text-red-700">
            {err}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>
            ปิดหน้าต่าง
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={busy}>
            {busy ? 'กำลังบันทึก...' : 'ยืนยัน'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

interface Round {
  key: string
  label: string
  date: string | null
  rows: FieldVisitRequestRow[]
}

export default function FieldVisitRequests() {
  const navigate = useNavigate()
  const [data, setData] = useState<FieldVisitRequestRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('waiting')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyRound, setBusyRound] = useState<string | null>(null)
  const [staleRounds, setStaleRounds] = useState<FieldVisitAttention['staleRounds']>([])
  const [ackBusy, setAckBusy] = useState<string | null>(null)
  const tabChosen = useRef(false)

  const load = useCallback(async () => {
    try {
      const rows = await listFieldVisitRequests(90)
      setData(rows)
      setError(null)
      // เข้าหน้าครั้งแรก: ถ้ามีอัปเดตที่ยังไม่แจ้งทีม ให้เปิดแท็บนั้นก่อน
      if (!tabChosen.current) {
        tabChosen.current = true
        if (rows.some((r) => r.status === 'dispatched' && r.liveState && r.liveKey !== r.ackKey)) setTab('updates')
      }
    } catch (e: unknown) {
      setError(errText(e))
    } finally {
      setLoading(false)
    }
    // แบนเนอร์รอบค้าง: พังไม่ต้องบล็อกหน้า
    try {
      setStaleRounds((await getFieldVisitAttention()).staleRounds)
    } catch (e: unknown) {
      console.error('getFieldVisitAttention failed', e)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const today = todayBangkok()
  const waiting = useMemo(() => data.filter((r) => r.status === 'requested'), [data])
  const selectable = useMemo(() => waiting.filter((r) => !isOnHold(r, today)), [waiting, today])
  const heldCount = waiting.length - selectable.length
  // เฉพาะที่ยังเลือกได้จริง: ตัดแถวที่ถูกพัก/ไม่รอรอบแล้วออก ให้เลขบนปุ่ม = ที่ส่งจริง
  const chosen = useMemo(() => selectable.filter((r) => selected.has(r.id)), [selectable, selected])
  const dispatched = useMemo(() => data.filter((r) => r.status === 'dispatched'), [data])
  const updates = useMemo(
    () => dispatched.filter((r) => r.liveState !== null && r.liveKey !== r.ackKey),
    [dispatched],
  )
  /** แถวที่เข้าข้อความอัปเดตส่ง LINE: กำลังลงพื้นที่ + ยกเลิก/ปิดพร้อม closeCode ใน 7 วัน (ไม่รวมปิดอัตโนมัติก่อนเข้ารอบ) */
  const lineRows = useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    return data.filter((r) => {
      if (r.status === 'dispatched') return true
      if (!(r.status === 'cancelled' || r.status === 'closed') || !r.closeCode) return false
      if (r.closeCode === 'auto_paid_before_round' || !r.roundId) return false
      const t = r.closedAt ? new Date(r.closedAt).getTime() : NaN
      return !Number.isNaN(t) && t >= cutoff
    })
  }, [data])
  const done = useMemo(
    () => data.filter((r) => r.status !== 'requested' && r.status !== 'dispatched'),
    [data],
  )

  const rounds = useMemo<Round[]>(() => {
    const m = new Map<string, Round>()
    for (const r of dispatched) {
      const label = r.roundLabel ?? '(ไม่มีชื่อรอบ)'
      const key = r.roundId ?? `${label}|${formatDateOnly(r.dispatchedAt)}`
      const g = m.get(key)
      if (g) g.rows.push(r)
      else m.set(key, { key, label, date: r.dispatchedAt, rows: [r] })
    }
    return [...m.values()]
  }, [dispatched])

  async function afterChange() {
    setDialog(null)
    setSelected(new Set())
    await load()
    window.dispatchEvent(new Event(FIELD_VISIT_CHANGED_EVENT))
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function ack(r: FieldVisitRequestRow) {
    if (!r.liveKey || ackBusy) return
    setAckBusy(r.id)
    setNotice(null)
    try {
      await ackFieldVisitUpdate(r.id, r.liveKey)
      setNotice(`แจ้งทีมแล้ว: ${r.customerName}`)
    } catch (e: unknown) {
      // สถานะเปลี่ยนระหว่างดู (FIELD_VISIT_UPDATE_CHANGED) → ข้อความไทยจาก db.ts + โหลดใหม่ให้เห็นสถานะล่าสุด
      setNotice(errText(e))
    } finally {
      setAckBusy(null)
      await load()
      window.dispatchEvent(new Event(FIELD_VISIT_CHANGED_EVENT))
    }
  }

  async function copyUpdates() {
    setNotice(null)
    const text = buildFieldUpdateLineText(lineRows, todayBangkok())
    if (!text) {
      setNotice('ยังไม่มีอัปเดต')
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      setNotice('คัดลอกสรุปอัปเดตแล้ว วางใน LINE ส่งให้ทีมลงพื้นที่ได้เลย')
    } catch (e: unknown) {
      setNotice(e instanceof DOMException ? 'คัดลอกไม่สำเร็จ (เบราว์เซอร์ไม่อนุญาต)' : errText(e))
    }
  }

  async function buildItems(rows: FieldVisitRequestRow[]): Promise<FieldItem[]> {
    const addrs = await getAddressesForContracts(rows.map((r) => r.contractId))
    return rows.map((r) =>
      toFieldItem({
        customerName: r.customerName,
        contractNo: r.contractNo,
        shopName: r.shopName ?? '-',
        daysLate: r.daysLate,
        amount: r.overdueAmount,
        model: r.model ?? undefined,
        storage: r.storage ?? undefined,
        phones: [r.phone, r.phoneAlt1, r.phoneAlt2],
        addresses: addrs.get(r.contractId) ?? {},
      }),
    )
  }

  async function printRound(round: Round) {
    setBusyRound(round.key)
    setNotice(null)
    try {
      const items = await buildItems(round.rows)
      sessionStorage.setItem('field_print', JSON.stringify(items))
      navigate('/letters/field')
    } catch (e: unknown) {
      setNotice(errText(e))
    } finally {
      setBusyRound(null)
    }
  }

  async function copyRound(round: Round) {
    setBusyRound(round.key)
    setNotice(null)
    try {
      const items = await buildItems(round.rows)
      await navigator.clipboard.writeText(buildFieldCopyText(items))
      setNotice('คัดลอกแล้ว วางใน LINE ส่งให้ทีมลงพื้นที่ได้เลย')
    } catch (e: unknown) {
      setNotice(e instanceof DOMException ? 'คัดลอกไม่สำเร็จ (เบราว์เซอร์ไม่อนุญาต)' : errText(e))
    } finally {
      setBusyRound(null)
    }
  }

  const tabCls = (active: boolean) =>
    `min-h-11 rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
      active ? 'bg-ink text-white' : 'bg-peach-light text-ink-soft'
    }`

  return (
    <div className="flex flex-col gap-4">
      <PageTitle sub="คำขอลงพื้นที่จากทีมติดตามหนี้ — รวมเคสเป็นรอบ ส่งให้ทีมข้างนอก แล้วลงผลการลงพื้นที่">
        คำขอลงพื้นที่
      </PageTitle>

      {staleRounds.length > 0 && (
        <div role="alert" className="flex flex-col gap-1 rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-800">
          {staleRounds.map((s) => (
            <p key={s.roundId} className="flex items-center gap-2">
              <AlertTriangle size={16} aria-hidden className="shrink-0" />
              รอบ {s.label} ส่งไปแล้ว {daysSince(s.dispatchedAt)} วัน ยังไม่ลงผล {s.pending} เคส — ทวงผลจากทีม
            </p>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" className={tabCls(tab === 'updates')} onClick={() => setTab('updates')}>
          มีอัปเดต ({updates.length})
        </button>
        <button type="button" className={tabCls(tab === 'waiting')} onClick={() => setTab('waiting')}>
          รอรอบ ({selectable.length}
          {heldCount > 0 ? ` +${heldCount} พักไว้` : ''})
        </button>
        <button type="button" className={tabCls(tab === 'dispatched')} onClick={() => setTab('dispatched')}>
          กำลังลงพื้นที่ ({dispatched.length})
        </button>
        <button type="button" className={tabCls(tab === 'done')} onClick={() => setTab('done')}>
          ผลแล้ว/ปิด 90 วันล่าสุด ({done.length})
        </button>
      </div>

      {notice && (
        <p role="status" className="rounded-xl bg-peach-light px-4 py-2 text-sm text-ink">
          {notice}
        </p>
      )}

      {loading ? (
        <Loading />
      ) : error ? (
        <Card>
          <p className="text-sm text-red-700">โหลดข้อมูลไม่สำเร็จ: {error}</p>
        </Card>
      ) : tab === 'updates' ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="ghost" type="button" onClick={() => void copyUpdates()}>
              คัดลอกสรุปส่ง LINE ทีม
            </Button>
            <span className="text-xs text-ink-soft">สรุปรวมทุกเคสที่กำลังลงพื้นที่ + ที่เพิ่งยกเลิกใน 7 วัน</span>
          </div>
          {updates.length === 0 ? (
            <EmptyState title="ไม่มีอัปเดตใหม่ที่ต้องแจ้งทีม" />
          ) : (
            <div className="flex flex-col gap-3">
              {updates.map((r) => (
                <Card key={r.id}>
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-base font-semibold text-ink">{r.customerName}</span>
                        {r.liveState && (
                          <Badge tone={toneFrom(FIELD_VISIT_UPDATE_TONE[r.liveState])}>
                            {fieldVisitUpdateLabel(r.liveState, {
                              overdueAmount: r.overdueAmount,
                              promiseDate: r.latestPromiseDate,
                            })}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-ink-soft">
                        <Link to={`/contract/${r.contractId}`} className="font-medium text-ink underline">
                          {r.invNo ?? r.contractNo}
                        </Link>{' '}
                        · {r.roundLabel ?? '(ไม่มีชื่อรอบ)'}
                      </p>
                      <p className="mt-1 text-sm text-ink">
                        จ่ายหลังเข้ารอบ {baht(r.paidSinceDispatch)} บาท
                        {r.latestPromiseDate ? ` · วันนัดจ่ายล่าสุด ${formatYmd(r.latestPromiseDate)}` : ''}
                        {r.penaltyDue > 0 ? ` · ค่าปรับค้าง ${baht(r.penaltyDue)} บาท` : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" disabled={ackBusy === r.id} onClick={() => void ack(r)}>
                        {ackBusy === r.id ? 'กำลังบันทึก...' : 'แจ้งทีมแล้ว'}
                      </Button>
                      {r.liveState === 'paid_full' && (
                        <Button variant="ghost" type="button" onClick={() => setDialog({ kind: 'confirmPaid', row: r })}>
                          ยกเลิกการไป — ลูกค้าจ่ายแล้ว
                        </Button>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      ) : tab === 'waiting' ? (
        waiting.length === 0 ? (
          <EmptyState title="ไม่มีคำขอที่รอรอบ" />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                disabled={chosen.length === 0}
                onClick={() => setDialog({ kind: 'round', rows: chosen })}
              >
                สร้างรอบส่งลงพื้นที่ ({chosen.length})
              </Button>
              <Button
                variant="ghost"
                type="button"
                disabled={selectable.length === 0}
                onClick={() =>
                  setSelected(
                    chosen.length === selectable.length ? new Set() : new Set(selectable.map((r) => r.id)),
                  )
                }
              >
                {selectable.length > 0 && chosen.length === selectable.length ? 'ยกเลิกเลือกทั้งหมด' : 'เลือกทั้งหมด'}
              </Button>
            </div>
            <div className="flex flex-col gap-3">
              {waiting.map((r) => (
                <Card key={r.id}>
                  <div className={`flex flex-wrap items-start gap-3 ${isOnHold(r, today) ? 'opacity-60' : ''}`}>
                    <input
                      type="checkbox"
                      className="mt-1.5 h-5 w-5"
                      checked={selected.has(r.id)}
                      disabled={isOnHold(r, today)}
                      onChange={() => toggle(r.id)}
                      aria-label={`เลือก ${r.customerName}`}
                    />
                    <RowInfo r={r} />
                    <div className="flex flex-wrap gap-2">
                      <OpenLink r={r} />
                      <Button variant="ghost" type="button" onClick={() => setDialog({ kind: 'cancel', row: r })}>
                        ยกเลิกคำขอ
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </>
        )
      ) : tab === 'dispatched' ? (
        rounds.length === 0 ? (
          <EmptyState title="ไม่มีเคสที่กำลังลงพื้นที่" />
        ) : (
          <div className="flex flex-col gap-5">
            {rounds.map((round) => (
              <section key={round.key} className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-base font-bold text-ink">
                    {round.label} · ส่งเมื่อ {formatDateOnly(round.date)} ({round.rows.length} เคส)
                  </h2>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="ghost"
                      type="button"
                      disabled={busyRound === round.key}
                      onClick={() => void printRound(round)}
                    >
                      ปริ้นใบลงพื้นที่
                    </Button>
                    <Button
                      variant="ghost"
                      type="button"
                      disabled={busyRound === round.key}
                      onClick={() => void copyRound(round)}
                    >
                      คัดลอกข้อความส่ง LINE
                    </Button>
                  </div>
                </div>
                {round.rows.map((r) => (
                  <Card key={r.id}>
                    <div className="flex flex-wrap items-start gap-3">
                      <RowInfo r={r} />
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" onClick={() => setDialog({ kind: 'result', row: r })}>
                          ลงผล
                        </Button>
                        <Button
                          variant="ghost"
                          type="button"
                          onClick={() => setDialog({ kind: 'cancelDispatched', row: r })}
                        >
                          ยกเลิกการไป
                        </Button>
                        <Button variant="ghost" type="button" onClick={() => setDialog({ kind: 'close', row: r })}>
                          ปิดเรื่อง
                        </Button>
                      </div>
                    </div>
                  </Card>
                ))}
              </section>
            ))}
          </div>
        )
      ) : done.length === 0 ? (
        <EmptyState title="ยังไม่มีเคสที่ลงผลหรือปิดใน 90 วันล่าสุด" />
      ) : (
        <div className="flex flex-col gap-3">
          {done.map((r) => (
            <Card key={r.id}>
              <div className="flex flex-wrap items-start gap-3">
                <RowInfo r={r}>
                  {r.roundLabel && <p className="mt-1 text-xs text-ink-soft">{r.roundLabel}</p>}
                  {(r.status === 'found' || r.status === 'not_found') && (
                    <p className="mt-1 text-sm text-ink">
                      ผล: {fieldVisitResultLabel(r.status, r.resultCode, r.promiseDate)}
                      {r.resultNote ? ` — ${r.resultNote}` : ''}
                      <span className="text-ink-soft">
                        {' '}
                        · ลงโดย {r.resultByName ?? '-'} · {formatDateOnly(r.resultAt)}
                      </span>
                    </p>
                  )}
                  {(r.status === 'closed' || r.status === 'cancelled') && (
                    <p className="mt-1 text-sm text-ink-soft">
                      {r.status === 'closed' ? 'ปิดเรื่อง' : 'ยกเลิก'}: {r.closedReason ?? '-'} ·{' '}
                      {formatDateOnly(r.closedAt)}
                    </p>
                  )}
                </RowInfo>
                <div className="flex flex-wrap gap-2">
                  <OpenLink r={r} />
                  {(r.status === 'found' || r.status === 'not_found') && (
                    <Button variant="ghost" type="button" onClick={() => setDialog({ kind: 'close', row: r })}>
                      ปิดเรื่อง
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {dialog?.kind === 'cancelDispatched' ? (
        <CancelDispatchedModal row={dialog.row} onClose={() => setDialog(null)} onDone={afterChange} />
      ) : dialog?.kind === 'confirmPaid' ? (
        <ConfirmPaidModal row={dialog.row} onClose={() => setDialog(null)} onDone={afterChange} />
      ) : dialog ? (
        <ActionModal dialog={dialog} onClose={() => setDialog(null)} onDone={afterChange} />
      ) : null}
    </div>
  )
}
