import { useState } from 'react'
import { MapPin } from 'lucide-react'
import type { FieldVisitStatusInfo } from '../lib/types'
import {
  FIELD_VISIT_REASON_LABEL,
  validateFieldVisitRequest,
  type FieldVisitReason,
} from '../lib/fieldVisit'
import { cancelFieldVisitRequest, requestFieldVisit } from '../lib/db'
import { useAuth } from '../lib/auth'
import { Button, Field, Modal, Textarea } from './ui'
import { FieldVisitBadge } from './FieldVisitBadge'

const REASONS: FieldVisitReason[] = ['unreachable_all_phones', 'answered_uncooperative', 'defiant', 'other']

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง'
}

export function FieldVisitRequestButton({
  contractId,
  info,
  onChanged,
  compact = false,
}: {
  contractId: string
  info?: FieldVisitStatusInfo
  onChanged: () => void
  /** ปุ่มเล็กสำหรับแถวในคิว */
  compact?: boolean
}) {
  const { role, session } = useAuth()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<FieldVisitReason | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancelError, setCancelError] = useState<string | null>(null)

  const close = () => {
    if (busy) return
    setOpen(false)
    setReason(null)
    setNote('')
    setError(null)
  }

  const submit = async () => {
    const v = validateFieldVisitRequest(reason, note)
    if (v || !reason) {
      setError(v)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await requestFieldVisit(contractId, reason, note.trim())
      setBusy(false)
      setOpen(false)
      setReason(null)
      setNote('')
      onChanged()
    } catch (e) {
      setError(errMsg(e))
      setBusy(false)
    }
  }

  const cancel = async () => {
    if (!info) return
    setBusy(true)
    setCancelError(null)
    try {
      await cancelFieldVisitRequest(info.requestId, 'คนขอยกเลิกเอง')
      onChanged()
    } catch (e) {
      setCancelError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  if (info && (info.status === 'requested' || info.status === 'dispatched')) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <FieldVisitBadge info={info} />
        {info.status === 'requested' && (role === 'admin' || info.requestedBy === (session?.user.id ?? null)) && (
          <button
            type="button"
            onClick={cancel}
            disabled={busy}
            className="text-xs text-ink-soft underline hover:text-ink disabled:opacity-50"
          >
            ยกเลิกคำขอ
          </button>
        )}
        {cancelError && (
          <span role="alert" className="text-xs text-red-700">
            {cancelError}
          </span>
        )}
      </span>
    )
  }

  const showResult = info && (info.status === 'found' || info.status === 'not_found')

  return (
    <>
      {showResult && <FieldVisitBadge info={info} />}
      {compact ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-xl border border-peach bg-white px-3 py-2 text-xs font-semibold text-ink-soft transition hover:bg-peach-light/50"
        >
          <MapPin size={13} aria-hidden="true" />
          ขอลงพื้นที่
        </button>
      ) : (
        <Button variant="ghost" type="button" onClick={() => setOpen(true)}>
          <span className="inline-flex items-center gap-1.5">
            <MapPin size={14} aria-hidden="true" />
            ขอลงพื้นที่
          </span>
        </Button>
      )}
      {open && (
        <Modal title="ขอลงพื้นที่" onClose={close} closeOnEsc={!busy} accessible>
          <div className="space-y-3">
            <fieldset>
              <legend className="mb-1 text-sm font-medium text-ink">เหตุผลที่ขอลงพื้นที่</legend>
              <div className="space-y-1.5">
                {REASONS.map((r) => (
                  <label key={r} className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                    <input
                      type="radio"
                      name="field-visit-reason"
                      checked={reason === r}
                      onChange={() => setReason(r)}
                    />
                    {FIELD_VISIT_REASON_LABEL[r]}
                  </label>
                ))}
              </div>
            </fieldset>
            <Field label={reason === 'other' ? 'หมายเหตุ (จำเป็น)' : 'หมายเหตุ (ไม่บังคับ)'}>
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
            </Field>
            <p className="text-xs text-ink-soft">
              คำขอจะเข้าคิวรอรอบ แอดมินจะรวบส่งทีมลงพื้นที่เป็นรอบ ไม่ได้ลงทันที — ระหว่างนี้ยังโทรติดตามได้ตามปกติ
            </p>
            {error && (
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" type="button" onClick={close} disabled={busy}>
                ยกเลิก
              </Button>
              <Button type="button" onClick={submit} disabled={busy}>
                {busy ? 'กำลังส่ง...' : 'ส่งคำขอ'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
