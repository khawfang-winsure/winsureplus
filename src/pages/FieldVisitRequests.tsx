import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageTitle, Textarea } from '../components/ui'
import { FIELD_VISIT_CHANGED_EVENT } from '../components/nav'
import {
  cancelFieldVisitRequest,
  closeFieldVisitRequest,
  dispatchFieldVisitRound,
  getAddressesForContracts,
  listFieldVisitRequests,
  recordFieldVisitOutcome,
} from '../lib/db'
import {
  FIELD_VISIT_REASON_LABEL,
  FIELD_VISIT_RESULT_CODES,
  FIELD_VISIT_RESULT_GROUP,
  FIELD_VISIT_RESULT_LABEL,
  FIELD_VISIT_STATUS_LABEL,
  PAID_NO_MONEY_HINT,
  RELATIVE_MET_LEGAL_HINT,
  buildFieldCopyText,
  defaultRoundLabel,
  fieldVisitResultLabel,
  fieldVisitStatusTone,
  toFieldItem,
  validateFieldVisitOutcome,
  waitingDays,
  type FieldItem,
  type FieldVisitResultCode,
} from '../lib/fieldVisit'
import type { FieldVisitRequestRow } from '../lib/types'

type Tab = 'waiting' | 'dispatched' | 'done'
type Tone = 'neutral' | 'green' | 'amber' | 'red'

const RESULT_GROUPS: { title: string; group: 'found' | 'not_found' }[] = [
  { title: 'พบตัวลูกค้า', group: 'found' },
  { title: 'ไม่พบตัวลูกค้า', group: 'not_found' },
]

function toneOf(r: FieldVisitRequestRow): Tone {
  const t = fieldVisitStatusTone(r.status, r.resultCode)
  return t === 'gray' || t === 'blue' ? 'neutral' : t
}

function todayBangkok(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date())
}

type Dialog =
  | { kind: 'round'; ids: string[] }
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
        {open && r.paidSinceRequest > 0 && (
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
  dialog: Dialog
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const [label, setLabel] = useState(() => defaultRoundLabel(new Date()))
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [code, setCode] = useState<FieldVisitResultCode | null>(null)
  const [promiseDate, setPromiseDate] = useState('')
  const today = todayBangkok()

  const needText = dialog.kind === 'cancel' || dialog.kind === 'close'
  const title =
    dialog.kind === 'round'
      ? `สร้างรอบส่งลงพื้นที่ (${dialog.ids.length} เคส)`
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
    setBusy(true)
    setErr(null)
    try {
      if (dialog.kind === 'round') await dispatchFieldVisitRound(dialog.ids, label.trim(), t)
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

  const load = useCallback(async () => {
    try {
      setData(await listFieldVisitRequests(90))
      setError(null)
    } catch (e: unknown) {
      setError(errText(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const waiting = useMemo(() => data.filter((r) => r.status === 'requested'), [data])
  const dispatched = useMemo(() => data.filter((r) => r.status === 'dispatched'), [data])
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

      <div className="flex flex-wrap gap-2">
        <button type="button" className={tabCls(tab === 'waiting')} onClick={() => setTab('waiting')}>
          รอรอบ ({waiting.length})
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
      ) : tab === 'waiting' ? (
        waiting.length === 0 ? (
          <EmptyState title="ไม่มีคำขอที่รอรอบ" />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                disabled={selected.size === 0}
                onClick={() => setDialog({ kind: 'round', ids: [...selected] })}
              >
                สร้างรอบส่งลงพื้นที่ ({selected.size})
              </Button>
              <Button
                variant="ghost"
                type="button"
                onClick={() =>
                  setSelected(selected.size === waiting.length ? new Set() : new Set(waiting.map((r) => r.id)))
                }
              >
                {selected.size === waiting.length ? 'ยกเลิกเลือกทั้งหมด' : 'เลือกทั้งหมด'}
              </Button>
            </div>
            <div className="flex flex-col gap-3">
              {waiting.map((r) => (
                <Card key={r.id}>
                  <div className="flex flex-wrap items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1.5 h-5 w-5"
                      checked={selected.has(r.id)}
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

      {dialog && <ActionModal dialog={dialog} onClose={() => setDialog(null)} onDone={afterChange} />}
    </div>
  )
}
