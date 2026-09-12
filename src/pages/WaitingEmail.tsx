import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Mail, X } from 'lucide-react'
import { Badge, Button, EmptyState, Field, Input, Loading, Modal, PageTitle, Select, Textarea } from '../components/ui'
import CopyBox from '../components/CopyBox'
import { evaluateFromStatus, normalizeMediaSlots } from '../components/ContractMediaCard'
import { thaiDate } from '../lib/format'
import { buildEmailText } from '../lib/messages'
import {
  getContracts,
  getMediaGateFrom,
  getMediaSlots,
  getMediaStatuses,
  getShops,
  logMediaGateBypass,
  markEmailSent,
  sendCompanyEmail,
} from '../lib/db'
import { DEFAULT_MEDIA_SLOTS, isGated, missingSummary, type MediaSlot } from '../lib/media'
import { canSendEmail, reviewStatusLabel, REVIEW_BADGE_DRAFT } from '../lib/review'
import { useAuth } from '../lib/auth'
import { useAsync } from '../lib/useAsync'
import type { Contract, ContractMediaStatus, Shop } from '../lib/types'

type SortKey = 'transactionDate' | 'contractNo' | 'createdAt'
type SortDir = 'asc' | 'desc'

const SORT_OPTS: { value: `${SortKey}_${SortDir}`; label: string }[] = [
  { value: 'transactionDate_desc', label: 'วันที่ทำรายการ (ใหม่→เก่า)' },
  { value: 'transactionDate_asc',  label: 'วันที่ทำรายการ (เก่า→ใหม่)' },
  { value: 'contractNo_asc',       label: 'เลขที่สัญญา (ก→ฮ)' },
  { value: 'contractNo_desc',      label: 'เลขที่สัญญา (ฮ→ก)' },
  { value: 'createdAt_desc',       label: 'วันที่เพิ่มข้อมูล (ใหม่→เก่า)' },
  { value: 'createdAt_asc',        label: 'วันที่เพิ่มข้อมูล (เก่า→ใหม่)' },
]

function sortContracts(list: Contract[], key: SortKey, dir: SortDir): Contract[] {
  return [...list].sort((a, b) => {
    let cmp = 0
    if (key === 'contractNo') {
      cmp = a.contractNo.localeCompare(b.contractNo, 'th', { numeric: true })
    } else {
      const av = key === 'createdAt' ? (a.createdAt ?? '') : a.transactionDate
      const bv = key === 'createdAt' ? (b.createdAt ?? '') : b.transactionDate
      if (!av && !bv) cmp = 0
      else if (!av) return 1
      else if (!bv) return -1
      else cmp = av < bv ? -1 : av > bv ? 1 : 0
    }
    return dir === 'asc' ? cmp : -cmp
  })
}

/** วันที่+เวลาไทยสั้นๆ จาก ISO timestamp เต็ม เช่น "08/09/2569 14:05 น." ใช้กับผลส่งเมลสำเร็จ */
function formatSentAt(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const date = thaiDate(iso.slice(0, 10))
  const time = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
  return `${date} ${time} น.`
}

export default function WaitingEmail() {
  const { name, role } = useAuth()
  const isAdmin = role === 'admin'
  const { data, loading } = useAsync(
    async () => {
      const [contracts, shops] = await Promise.all([getContracts(), getShops()])
      return { contracts, shops }
    },
    { contracts: [] as Contract[], shops: [] as Shop[] },
  )

  const [sentIds, setSentIds] = useState<Set<string>>(new Set())
  const [view, setView] = useState<Contract | null>(null)
  const [sortOpt, setSortOpt] = useState<`${SortKey}_${SortDir}`>('transactionDate_desc')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [shopFilter, setShopFilter] = useState('')

  // ===== รูปเอกสารแนบ — เกทส่งเมลถึงบริษัท (0136-0138, 2026-09-08) =====
  const [mediaSlots, setMediaSlots] = useState<MediaSlot[]>(DEFAULT_MEDIA_SLOTS)
  const [gateFrom, setGateFrom] = useState<string>('')
  // gateFromLoaded: ต้องรอ true ก่อนถึงจะเชื่อ isGated(...) ได้ — ค่าเริ่มต้น gateFrom='' เดาไม่ได้ว่าสัญญาเก่า/ใหม่
  // fail closed: โหลดพัง (เน็ตสะดุด/RLS/ฯลฯ) -> ค้าง false ตลอดไปจนกว่าจะลองใหม่สำเร็จ (ต่างจาก mediaSlots ที่มี DEFAULT ปลอดภัยอยู่แล้ว)
  const [gateFromLoaded, setGateFromLoaded] = useState(false)
  const [gateFromError, setGateFromError] = useState(false)
  const [mediaStatuses, setMediaStatuses] = useState<Map<string, ContractMediaStatus>>(new Map())
  const [mediaStatusesLoaded, setMediaStatusesLoaded] = useState(false)
  const [mediaStatusesError, setMediaStatusesError] = useState(false)
  const [mediaRetryNonce, setMediaRetryNonce] = useState(0)
  const [bypassedIds, setBypassedIds] = useState<Set<string>>(new Set())

  // ส่งเมลถึงบริษัท (Edge Function) — สถานะต่อ modal ที่เปิดอยู่
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sendSuccess, setSendSuccess] = useState<{ sentAt: string; to: string; attachmentCount: number } | null>(null)
  const [bypassOpen, setBypassOpen] = useState(false)
  const [bypassReason, setBypassReason] = useState('')
  const [bypassBusy, setBypassBusy] = useState(false)
  const [bypassError, setBypassError] = useState<string | null>(null)

  const shopOf = (id: string) => data.shops.find((s) => s.id === id)

  // เคสที่ยังไม่ส่ง (ก่อนกรอง) — ใช้แยก empty-state
  const base = useMemo(
    () => data.contracts.filter((c) => !c.emailSentAt && !sentIds.has(c.id)),
    [data.contracts, sentIds],
  )

  // โหลดค่าตั้งค่าคัตออฟ (gateFrom) + ช่องรูป — ใช้ mediaRetryNonce ร่วมกับปุ่ม "ลองใหม่" ด้านล่าง (retryLoad)
  // เพื่อให้กดครั้งเดียวลองใหม่ทั้งค่าตั้งค่านี้และสถานะรูปต่อสัญญา ไม่ทำระบบลองใหม่ 2 ชุดซ้อนกัน
  // fail closed: ถ้าพัง gateFromLoaded ค้าง false -> viewEraUnknown (ด้านล่าง) บล็อกการส่งเมลทุกกรณี
  useEffect(() => {
    let cancelled = false
    setGateFromError(false)
    Promise.all([getMediaSlots(), getMediaGateFrom()])
      .then(([raw, gate]) => {
        if (cancelled) return
        setMediaSlots(normalizeMediaSlots(raw))
        setGateFrom(gate)
        setGateFromLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setGateFromError(true)
      })
    return () => {
      cancelled = true
    }
  }, [mediaRetryNonce])

  // โหลดสถานะรูปของเคสที่ค้างส่งทั้งหมดครั้งเดียว (ไม่ใช่ทีละแถว)
  // fail closed: โหลดพัง (เน็ตสะดุด/RLS/ฯลฯ) -> mediaStatusesError=true และห้ามถือว่า "โหลดจบแล้วไม่มีข้อมูล"
  // (ต่างจากกรณีสัญญาไม่มีรูปเลย ซึ่ง view เป็น LEFT JOIN คืนแถวเสมอ — ไม่มีแถว = error ไม่ใช่ empty)
  useEffect(() => {
    const ids = base.map((c) => c.id)
    if (ids.length === 0) {
      setMediaStatuses(new Map())
      setMediaStatusesError(false)
      setMediaStatusesLoaded(true)
      return
    }
    let cancelled = false
    setMediaStatusesLoaded(false)
    setMediaStatusesError(false)
    getMediaStatuses(ids)
      .then((rows) => {
        if (cancelled) return
        setMediaStatuses(new Map(rows.map((r) => [r.contractId, r])))
        setMediaStatusesLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setMediaStatusesError(true)
        setMediaStatusesLoaded(true)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, mediaRetryNonce])

  // ลองใหม่ทั้งค่าตั้งค่าคัตออฟ (gateFrom) และสถานะรูปต่อสัญญา — ปุ่มเดียวรวม 2 ระบบ (ดูคอมเมนต์ useEffect ด้านบน)
  function retryLoad() {
    setMediaRetryNonce((n) => n + 1)
  }

  function evaluationFor(c: Contract) {
    const status = mediaStatuses.get(c.id)
    if (!status) return null
    return evaluateFromStatus(mediaSlots, status)
  }

  function renderMediaPill(c: Contract) {
    const status = mediaStatuses.get(c.id)
    const hasFiles = !!status && Object.values(status.counts).some((n) => n > 0)
    if (!hasFiles) return <Badge tone="neutral">ไม่มีข้อมูล</Badge>
    const ev = evaluationFor(c)
    if (!ev) return <Badge tone="neutral">ไม่มีข้อมูล</Badge>
    if (ev.complete) return <Badge tone="green">รูป ครบ</Badge>
    return <Badge tone={isGated(c, gateFrom) ? 'red' : 'amber'}>{`รูป ขาด ${ev.missing.length}`}</Badge>
  }

  // ร้านที่เลือกได้ (เฉพาะร้านที่มีเคสค้างในลิสต์ หลังกรองวันที่)
  const shopOptions = useMemo(() => {
    const dateFiltered = base.filter((c) => {
      if (fromDate && c.transactionDate < fromDate) return false
      if (toDate && c.transactionDate > toDate) return false
      return true
    })
    const ids = new Set(dateFiltered.map((c) => c.shopId))
    return [...data.shops]
      .filter((s) => ids.has(s.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'th'))
  }, [base, data.shops, fromDate, toDate])

  const hasFilter = !!(fromDate || toDate || shopFilter)
  const clearFilter = () => {
    setFromDate('')
    setToDate('')
    setShopFilter('')
  }

  const pending = useMemo(() => {
    const [key, dir] = sortOpt.split('_') as [SortKey, SortDir]
    const filtered = base.filter((c) => {
      if (fromDate && c.transactionDate < fromDate) return false
      if (toDate && c.transactionDate > toDate) return false
      if (shopFilter && c.shopId !== shopFilter) return false
      return true
    })
    return sortContracts(filtered, key, dir)
  }, [base, sortOpt, fromDate, toDate, shopFilter])

  async function doMarkSent(c: Contract) {
    await markEmailSent(c.id, name ?? undefined)
    setSentIds((prev) => new Set([...prev, c.id]))
    setView(null)
  }

  function openView(c: Contract) {
    setView(c)
    setSending(false)
    setSendError(null)
    setSendSuccess(null)
    setBypassOpen(false)
    setBypassReason('')
    setBypassBusy(false)
    setBypassError(null)
  }

  // ===== แก้ช่องโหว่ gateFrom fail-open (2026-09-12) =====
  // viewEraUnknown = ยังไม่รู้ว่าสัญญานี้อยู่ยุคไหน (คัตออฟกำลังโหลด หรือโหลดพัง) -> fail closed ทั้งหมด
  // ห้ามใช้ gateFrom='' (ค่าตั้งต้น/ค่าตอนพัง) ไปคำนวณ isGated ก่อน gateFromLoaded=true จริง
  // ไม่งั้นจะเดาว่า "สัญญาเก่า ไม่ต้องตรวจอะไร" ผิดๆ แล้วปล่อยส่งเมลได้ทุกกรณีอย่างเงียบๆ
  const viewSettingsChecking = !gateFromLoaded && !gateFromError
  const viewSettingsError = !gateFromLoaded && gateFromError
  const viewEraUnknown = !gateFromLoaded
  // cutoff เดียว (media_gate_from) คุมทั้งเกทรูปแนบและเกทตรวจก่อนส่งเมล — ห้ามทำ 2 อัน (ตาม ContractDetail.tsx)
  // มีผลเฉพาะตอน gateFromLoaded=true เท่านั้น — ตอนยังไม่รู้ ให้ viewEraUnknown เป็นตัวบล็อกแทนด้านล่าง
  const viewGated = view && gateFromLoaded ? isGated(view, gateFrom) : false
  const viewMediaError = viewGated && mediaStatusesLoaded && mediaStatusesError
  const viewEvaluation = view ? evaluationFor(view) : null
  const viewBypassed = view ? bypassedIds.has(view.id) : false
  const viewBlocked = viewGated && !mediaStatusesError && !!viewEvaluation && !viewEvaluation.complete && !viewBypassed
  // viewChecking: ต้องเช็ค "ยังไม่รู้ยุคสัญญา" ก่อนเช็ครูป (เดิมผูกกับ viewGated อย่างเดียว —
  // พังเพราะ viewGated เป็น false เสมอตอน gateFrom ยังว่าง ทำให้ viewChecking เป็น false ไปด้วย ปุ่มเปิดก่อนรู้ผลจริง)
  const viewMediaChecking = viewGated && !mediaStatusesLoaded
  const viewChecking = viewSettingsChecking || viewMediaChecking
  // เกทตรวจเคสก่อนส่งอีเมล (spec-review-flow.md §4.5) — สัญญาเก่าก่อน cutoff (postCutoff=false) ไม่ถูกกระทบเลย
  // สัญญาใหม่ (postCutoff=true) status===null คือ draft ที่ยังไม่กดส่งตรวจ ต้อง block เหมือนสถานะอื่นที่ไม่ใช่ approved
  const viewReviewBlocked = view ? !canSendEmail(view.reviewStatus ?? null, viewGated) : false
  const viewReviewStatusLabel = view
    ? viewGated && (view.reviewStatus ?? null) === null
      ? REVIEW_BADGE_DRAFT
      : reviewStatusLabel(view.reviewStatus ?? null)
    : ''
  // ห้าม render เนื้อข้อความอีเมลจนกว่าจะผ่านการตรวจ/เช็ครูปครบ — ไม่ใช่แค่ disabled ปุ่มคัดลอก (กันก๊อปแล้วส่งเองนอกระบบ)
  // viewEraUnknown มาก่อนเสมอ — ยังไม่รู้ยุคสัญญา ห้ามโชว์ข้อความ/ให้กดส่ง ไม่ว่า flag อื่นจะเป็นอะไร
  const viewCopyBlocked = viewEraUnknown || viewBlocked || viewReviewBlocked || viewMediaError

  async function handleSendCompanyEmail() {
    if (!view) return
    setSending(true)
    setSendError(null)
    try {
      const result = await sendCompanyEmail(view.id)
      if (!result.ok) {
        setSendError(result.error ?? 'ส่งอีเมลไม่สำเร็จ')
        return
      }
      setSendSuccess({
        sentAt: result.sentAt ?? new Date().toISOString(),
        to: result.to ?? '',
        attachmentCount: result.attachmentCount ?? 0,
      })
      setSentIds((prev) => new Set([...prev, view.id]))
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'ส่งอีเมลไม่สำเร็จ ลองใหม่อีกครั้ง')
    } finally {
      setSending(false)
    }
  }

  async function handleBypassSubmit() {
    if (!view) return
    if (!bypassReason.trim()) {
      setBypassError('กรุณาระบุเหตุผล')
      return
    }
    setBypassBusy(true)
    setBypassError(null)
    try {
      await logMediaGateBypass(view.id, bypassReason.trim())
      setBypassedIds((prev) => new Set(prev).add(view.id))
      setBypassOpen(false)
    } catch (e) {
      setBypassError(e instanceof Error ? e.message : 'บันทึกเหตุผลไม่สำเร็จ')
    } finally {
      setBypassBusy(false)
    }
  }

  return (
    <div>
      <PageTitle
        sub="เคสที่ยังไม่ได้ส่งอีเมลให้พาร์ทเนอร์ (กดดูข้อความ → คัดลอกไปส่ง → ทำเครื่องหมายส่งแล้ว)"
        count={loading ? undefined : { shown: pending.length }}
      >
        รอส่งอีเมล
      </PageTitle>
      {loading ? (
        <Loading />
      ) : base.length === 0 ? (
        <EmptyState title="ไม่มีเคสค้างส่งอีเมล" hint="เคสที่ส่งแล้วจะถูกซ่อนอัตโนมัติ" />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <Select
              value={sortOpt}
              onChange={(e) => setSortOpt(e.target.value as `${SortKey}_${SortDir}`)}
              className="w-auto text-sm"
            >
              {SORT_OPTS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
            <label className="flex items-center gap-2 text-sm text-ink">
              ตั้งแต่
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="w-auto" />
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              ถึง
              <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="w-auto" />
            </label>
            <Select
              value={shopFilter}
              onChange={(e) => setShopFilter(e.target.value)}
              className="!w-auto min-w-[140px] text-sm"
            >
              <option value="">ทุกร้าน</option>
              {shopOptions.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
            {hasFilter && (
              <Button variant="ghost" onClick={clearFilter} className="text-sm">
                <X size={13} /> ล้างตัวกรอง
              </Button>
            )}
          </div>
          {pending.length === 0 ? (
            <EmptyState title="ไม่มีเคสตรงตัวกรอง" hint="ลองปรับช่วงวันหรือร้าน" />
          ) : (
          <ul className="flex flex-col gap-2">
          {pending.map((c) => (
            <li key={c.id} className="flex items-center justify-between rounded-xl border border-peach bg-white px-4 py-3">
              <div>
                <p className="font-medium text-ink">
                  <Link to={`/contract/${c.id}`} className="text-salmon-deep hover:underline">
                    {c.customerName}
                  </Link>
                  {' '}— {c.contractNo}
                </p>
                <p className="text-sm text-ink-soft">{shopOf(c.shopId)?.name ?? '-'} · {thaiDate(c.transactionDate)}</p>
              </div>
              <div className="flex items-center gap-2">
                {c.pendingDocuments && <Badge tone="amber">รอเอกสาร</Badge>}
                {renderMediaPill(c)}
                <Badge tone="amber">ยังไม่ส่ง</Badge>
                <Button variant="ghost" onClick={() => openView(c)}>
                  <Mail size={15} /> ดูอีเมล
                </Button>
              </div>
            </li>
          ))}
          </ul>
          )}
        </>
      )}

      {view && (
        <Modal title={`อีเมล — ${view.customerName}`} onClose={() => setView(null)}>
          <div className="flex flex-col gap-3">
            {viewSettingsChecking && <p className="text-sm text-ink-soft">กำลังตรวจสอบเงื่อนไขสัญญา...</p>}

            {viewSettingsError && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                <p>โหลดเงื่อนไขสัญญาไม่สำเร็จ (เน็ตอาจสะดุด) ยังส่งเมลไม่ได้จนกว่าจะโหลดสำเร็จ</p>
                <Button variant="ghost" onClick={retryLoad} className="mt-1 text-xs">
                  ลองใหม่
                </Button>
              </div>
            )}

            {!viewSettingsChecking && !viewSettingsError && viewMediaChecking && (
              <p className="text-sm text-ink-soft">กำลังตรวจสอบรูปเอกสาร...</p>
            )}

            {viewMediaError && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                <p>ตรวจสอบรูปเอกสารไม่สำเร็จ (เน็ตอาจสะดุด) ยังส่งเมลไม่ได้จนกว่าจะตรวจสอบสำเร็จ</p>
                <Button variant="ghost" onClick={retryLoad} className="mt-1 text-xs">
                  ลองใหม่
                </Button>
              </div>
            )}

            {viewBlocked && viewEvaluation && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                <p>{missingSummary(viewEvaluation)}</p>
                <Link to={`/contract/${view.id}`} className="mt-1 inline-block font-semibold underline">
                  ไปแนบรูป
                </Link>
                {isAdmin && !bypassOpen && (
                  <div className="mt-2">
                    <Button variant="ghost" onClick={() => setBypassOpen(true)} className="text-xs">
                      ข้ามการตรวจ (แอดมินเท่านั้น)
                    </Button>
                  </div>
                )}
                {isAdmin && bypassOpen && (
                  <div className="mt-2 flex flex-col gap-2">
                    <Field label="เหตุผลที่ข้าม" required>
                      <Textarea
                        value={bypassReason}
                        onChange={(e) => setBypassReason(e.target.value)}
                        placeholder="เช่น ลูกค้าเร่งด่วน จะตามรูปเพิ่มทีหลัง"
                        rows={2}
                      />
                    </Field>
                    {bypassError && <p className="text-xs text-red-700">{bypassError}</p>}
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" onClick={() => setBypassOpen(false)} disabled={bypassBusy}>
                        ยกเลิก
                      </Button>
                      <Button onClick={() => void handleBypassSubmit()} disabled={bypassBusy}>
                        {bypassBusy ? 'กำลังบันทึก...' : 'ยืนยันข้ามการตรวจ'}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {viewReviewBlocked && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                <p>{`สถานะ: ${viewReviewStatusLabel} — ต้องตรวจผ่านก่อน จึงส่งเมลได้ที่นี่`}</p>
                <Link to={`/contract/${view.id}`} className="mt-1 inline-block font-semibold underline">
                  ไปที่หน้าสัญญาเพื่อส่งตรวจ/ดูผลตรวจ
                </Link>
              </div>
            )}

            {viewCopyBlocked ? (
              <div className="rounded-xl border border-peach bg-peach/20 px-4 py-3 text-sm text-ink-soft">
                ยังแสดงข้อความอีเมลไม่ได้ จนกว่าจะผ่านเงื่อนไขด้านบนก่อน
              </div>
            ) : (
              <CopyBox
                title="ข้อความอีเมล"
                text={shopOf(view.shopId) ? buildEmailText(view, shopOf(view.shopId)!) : ''}
              />
            )}

            {sendError && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{sendError}</div>
            )}
            {sendSuccess && (
              <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
                {`ส่งเมลแล้ว ${formatSentAt(sendSuccess.sentAt)} โดย ${name ?? '-'} ถึง ${sendSuccess.to} · แนบรูป ${sendSuccess.attachmentCount} ใบ`}
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setView(null)}>ปิด</Button>
              <Button variant="ghost" onClick={() => void doMarkSent(view)} disabled={viewCopyBlocked || viewChecking}>
                บันทึกว่าส่งเอง (สำรอง)
              </Button>
              <Button onClick={() => void handleSendCompanyEmail()} disabled={viewCopyBlocked || viewChecking || sending || !!sendSuccess}>
                {sending ? 'กำลังส่ง...' : 'ส่งเมลถึงบริษัท'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
