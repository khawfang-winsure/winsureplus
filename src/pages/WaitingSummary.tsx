import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Pencil, RotateCcw, X } from 'lucide-react'
import { Badge, Button, EmptyState, Input, Loading, Modal, PageTitle, Select, Textarea } from '../components/ui'
import CopyBox from '../components/CopyBox'
import { evaluateFromStatus, normalizeMediaSlots } from '../components/ContractMediaCard'
import { calcSummary } from '../lib/calc'
import { baht, thaiDate } from '../lib/format'
import { buildBulkSummary, buildRejectionBanner, REJECTION_REASON_LABEL } from '../lib/messages'
import {
  clearNeedsFix,
  forceMarkSummaryShopSent,
  getContracts,
  getMediaGateFrom,
  getMediaSlots,
  getMediaStatuses,
  getShops,
  markSummaryShopSent,
  markSummaryAccountingSent,
  updateSummaryNote,
} from '../lib/db'
import { DEFAULT_MEDIA_SLOTS, isGated, type MediaSlot } from '../lib/media'
import { canMarkSummary, summaryBlockReason } from '../lib/review'
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
      // date fields — null/undefined ไปท้ายเสมอ
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

// ===== ป็อปอัพหมายเหตุเคสติดปัญหา (สรุปยอดไม่ได้เพราะติดอะไร) =====
function SummaryNoteModal({
  contract,
  byName,
  onClose,
  onDone,
}: {
  contract: Contract
  byName: string
  onClose: () => void
  onDone: (note: string | null, byName: string) => void
}) {
  const [note, setNote] = useState(contract.summaryNote ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const trimmed = note.trim()
      await updateSummaryNote(contract.id, trimmed || null, byName)
      onDone(trimmed || null, byName)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`หมายเหตุเคสติดปัญหา — ${contract.customerName}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-soft">{contract.contractNo}</p>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">หมายเหตุ</span>
          <Textarea
            autoFocus
            rows={3}
            placeholder="เช่น รอลูกค้าโอนดาวน์เพิ่ม, เอกสารไม่ครบ ฯลฯ"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <p className="text-xs text-ink-soft">เว้นว่างแล้วบันทึก = ลบหมายเหตุ</p>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            ยกเลิก
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'กำลังบันทึก...' : 'บันทึกหมายเหตุ'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ===== ปุ่มฉุกเฉิน: สรุปยอดโดยไม่ผ่านตรวจ (ล็อกคุณเตย 2026-09-12, เฉพาะแอดมิน) =====
// ใช้เฉพาะเคสที่ตรวจไม่ผ่านได้จริงๆ (รูปหายถาวร/ลูกค้าติดต่อไม่ได้) — ไม่ใช่ทางลัดใช้ประจำ
// validate ความยาวเหตุผล ≥10 ตัวอักษรฝั่งนี้ก่อนยิง RPC (ฐานข้อมูลเช็คซ้ำอีกชั้น ห้ามพึ่ง UI อย่างเดียว)
const FORCE_SUMMARY_MIN_REASON = 10

function ForceSummaryModal({
  contract,
  dateISO,
  onClose,
  onDone,
}: {
  contract: Contract
  dateISO: string
  onClose: () => void
  onDone: (contractId: string) => void
}) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const trimmedLen = reason.trim().length
  const tooShort = trimmedLen < FORCE_SUMMARY_MIN_REASON

  async function handleConfirm() {
    const trimmed = reason.trim()
    if (trimmed.length < FORCE_SUMMARY_MIN_REASON) {
      setError(`เหตุผลสั้นเกินไป (ตอนนี้ ${trimmed.length} ตัวอักษร) — เขียนอธิบายให้ละเอียดกว่านี้ อย่างน้อย ${FORCE_SUMMARY_MIN_REASON} ตัวอักษรค่ะ`)
      return
    }
    setError(null)
    setSaving(true)
    try {
      await forceMarkSummaryShopSent(contract.id, trimmed, dateISO)
      onDone(contract.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="สรุปยอดโดยไม่ผ่านตรวจ (ฉุกเฉิน)" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">{contract.customerName} — {contract.contractNo}</p>
          <p className="mt-1">
            เคสนี้ยังไม่ผ่านการตรวจ การกดยืนยันจะข้ามการตรวจแล้วสรุปยอดส่งร้านทันที
            ระบบจะบันทึกชื่อผู้กดและเหตุผลนี้ไว้ถาวรในประวัติสัญญา ใช้เฉพาะเคสที่ตรวจไม่ผ่านได้จริงๆ เท่านั้น
            (เช่น รูปหลักฐานหายถาวร ลูกค้าติดต่อไม่ได้)
          </p>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">เหตุผล (บังคับ)</span>
          <Textarea
            autoFocus
            rows={3}
            placeholder={`เช่น รูปหลักฐานหายถาวร ลูกค้าติดต่อไม่ได้มากกว่า 2 สัปดาห์ (อย่างน้อย ${FORCE_SUMMARY_MIN_REASON} ตัวอักษร)`}
            value={reason}
            onChange={(e) => { setReason(e.target.value); setError(null) }}
          />
          <span className={`text-xs ${tooShort ? 'text-amber-700' : 'text-ink-soft'}`}>
            {tooShort
              ? `ต้องอย่างน้อย ${FORCE_SUMMARY_MIN_REASON} ตัวอักษร (ตอนนี้ ${trimmedLen})`
              : `ครบตามที่กำหนดแล้ว (${trimmedLen} ตัวอักษร)`}
          </span>
        </label>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            ยกเลิก
          </Button>
          <Button onClick={handleConfirm} disabled={saving || tooShort}>
            {saving ? 'กำลังบันทึก...' : 'ยืนยันสรุปยอดข้ามการตรวจ'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

const today = new Date().toISOString().slice(0, 10)
const SEL_KEY = 'waiting-summary:selected'
const DATE_KEY = 'waiting-summary:date'
const netOf = (c: Contract) =>
  calcSummary(c.devicePrice, c.downPercent, c.commissionPercent, c.docFee).net

export default function WaitingSummary() {
  const { name, role, configured } = useAuth()
  // ปุ่มฉุกเฉิน "สรุปยอดโดยไม่ผ่านตรวจ" ใช้ convention เดียวกับที่เหลือของเว็บ (เทียบ ReviewQueue.tsx) —
  // !configured = โหมด mock ไม่มี Supabase (dev เครื่อง) ถือทุกคนเป็นแอดมิน กันปุ่มไม่โผล่ตอนทดสอบในเครื่อง
  // บน prod configured เป็น true เสมอ ผลลัพธ์เท่ากับ role === 'admin' เป๊ะ ไม่เปลี่ยนพฤติกรรม
  const isAdminOrMock = !configured || role === 'admin'
  const canEditNote = role === 'admin' || role === 'staff'
  const byName = name ?? 'ไม่ระบุชื่อ'
  const { data, loading } = useAsync(
    async () => {
      const [contracts, shops] = await Promise.all([getContracts(), getShops()])
      return { contracts, shops }
    },
    { contracts: [] as Contract[], shops: [] as Shop[] },
  )

  // 2 ด่าน: locallyShopSent = กดส่งร้านรอบนี้ (เด้งไปคอลัมน์ขวา), locallyAccountingSent = กดส่งบัญชี (จบ)
  const [locallyShopSent, setLocallyShopSent] = useState<Set<string>>(new Set())
  const [locallyAccountingSent, setLocallyAccountingSent] = useState<Set<string>>(new Set())
  // เคสที่กด "แก้แล้ว ส่งใหม่" รอบนี้ — ซ่อนป้ายตีกลับทันทีโดยไม่ต้อง reload ทั้งหน้า (req2)
  const [locallyClearedNeedsFix, setLocallyClearedNeedsFix] = useState<Set<string>>(new Set())
  const [clearingId, setClearingId] = useState<string | null>(null)
  // หมายเหตุเคสติดปัญหา — เก็บ override ในเครื่องหลังบันทึก (ทั้งข้อความ+คนเขียน) กันต้อง reload ทั้งหน้า
  const [noteOverride, setNoteOverride] = useState<Map<string, { note: string | null; by: string }>>(new Map())
  const [noteTarget, setNoteTarget] = useState<Contract | null>(null)
  // ปุ่มฉุกเฉิน "สรุปยอดโดยไม่ผ่านตรวจ" — เฉพาะแอดมิน, เฉพาะเคสที่ canSummarizeCase() เป็น false (คุณเตยเคาะ 2026-09-12)
  const [forceTarget, setForceTarget] = useState<Contract | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(SEL_KEY)
      if (!raw) return new Set<string>()
      const arr = JSON.parse(raw) as string[]
      return new Set<string>(arr)
    } catch {
      return new Set<string>()
    }
  })
  const [selectedAccounting, setSelectedAccounting] = useState<Set<string>>(new Set())
  const [date, setDate] = useState<string>(() => {
    try {
      return localStorage.getItem(DATE_KEY) || today
    } catch {
      return today
    }
  })
  const [sortOpt, setSortOpt] = useState<`${SortKey}_${SortDir}`>('transactionDate_desc')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [shopFilter, setShopFilter] = useState('')

  // ===== ป้ายเตือนรูป (เตือนอย่างเดียว ไม่บล็อก) + เกทกดสรุปยอดจริง (บล็อกจริง — เจ้าของเคาะ 2026-09-12) =====
  // เฉพาะคอลัมน์ "รอส่งร้าน" (ก่อนเงินออกจริง) เฉพาะเคสตั้งแต่ gateFrom (cutoff เดียวกันทั้งเว็บ — ห้ามทำ 2 อัน)
  const [mediaSlots, setMediaSlots] = useState<MediaSlot[]>(DEFAULT_MEDIA_SLOTS)
  const [mediaStatuses, setMediaStatuses] = useState<Map<string, ContractMediaStatus>>(new Map())
  // gateFrom (app_settings.media_gate_from) — ตัวเดียวกับ WaitingEmail.tsx ใช้กันส่งเมล
  // fail closed: ยังไม่โหลดเสร็จ/โหลดพัง -> canSummarizeCase คืน false เสมอ (ห้ามเดาว่าสัญญาเก่าแล้วปล่อยผ่าน)
  const [gateFrom, setGateFrom] = useState<string>('')
  const [gateFromLoaded, setGateFromLoaded] = useState(false)
  const [gateFromError, setGateFromError] = useState(false)
  const [gateFromRetryNonce, setGateFromRetryNonce] = useState(0)
  // สถานะยิง markSummaryShopSent จริง — กันกดซ้ำระหว่างรอ + โชว์ error ถ้าฐานข้อมูลตีกลับ (RPC guard)
  const [markShopBusy, setMarkShopBusy] = useState(false)
  const [markShopError, setMarkShopError] = useState<string | null>(null)

  const shopOf = (id: string) => data.shops.find((s) => s.id === id)
  // หมายเหตุที่ใช้แสดงจริง — ถ้ามี override (เพิ่งบันทึกรอบนี้) ใช้ override ก่อน ไม่งั้นใช้ค่าจาก DB
  const noteOf = (c: Contract) =>
    noteOverride.has(c.id) ? noteOverride.get(c.id)!.note : c.summaryNote ?? null
  // ป้ายชื่อคนโน้ต — ต้องมาจากแหล่งเดียวกับ noteOf กันข้อความ/ชื่อไม่ตรงกันระหว่างรอ reload
  const noteByOf = (c: Contract) =>
    noteOverride.has(c.id) ? noteOverride.get(c.id)!.by : c.summaryNoteBy ?? null

  // จำสิ่งที่ติ๊กไว้ (ฝั่งร้าน) + วันที่สรุป ข้าม reload
  useEffect(() => {
    try {
      localStorage.setItem(SEL_KEY, JSON.stringify([...selected]))
    } catch {
      /* ignore quota/private-mode errors */
    }
  }, [selected])

  useEffect(() => {
    try {
      localStorage.setItem(DATE_KEY, date)
    } catch {
      /* ignore quota/private-mode errors */
    }
  }, [date])

  // คอลัมน์ซ้าย (รอส่งร้าน): ยังไม่ส่งร้าน + ยังไม่กดอะไรรอบนี้
  const shopBase = useMemo(
    () =>
      data.contracts.filter(
        (c) =>
          c.summaryShopSentAt == null &&
          !locallyShopSent.has(c.id) &&
          !locallyAccountingSent.has(c.id),
      ),
    [data.contracts, locallyShopSent, locallyAccountingSent],
  )

  // โหลดนิยามช่องรูป + วันเริ่มบังคับตรวจก่อนสรุปยอด (ตัวเดียวกับที่ WaitingEmail.tsx ใช้กันส่งเมล — ห้ามทำ cutoff 2 อัน)
  // gateFromRetryNonce ให้กดปุ่ม "ลองใหม่" เมื่อโหลดพัง (ดู banner error ด้านล่าง)
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
  }, [gateFromRetryNonce])

  function retryGateFrom() {
    setGateFromRetryNonce((n) => n + 1)
  }

  // เคสฝั่ง "รอส่งร้าน" ที่เข้าเกณฑ์ต้องตรวจ (createdAt >= gateFrom) เท่านั้น — รอ gateFromLoaded ก่อนคำนวณ
  // (ระหว่างที่ยังไม่รู้ค่า gateFrom จริง ห้ามเดาว่าเข้าเกณฑ์หรือไม่ กันดึงสถานะรูปผิดชุด)
  const trackedShopIds = useMemo(
    () => (gateFromLoaded ? shopBase.filter((c) => isGated(c, gateFrom)).map((c) => c.id) : []),
    [shopBase, gateFromLoaded, gateFrom],
  )

  // กดสรุปยอดส่งร้านของเคสนี้ได้ไหม — เกทเดียวกับ canSendEmail (ห้ามโอนเงินก่อนตรวจผ่าน, ล็อกคุณเตย 2026-09-12)
  // fail closed: ยังไม่รู้ gateFrom (กำลังโหลด/โหลดพัง) -> false เสมอ ไม่ว่าเคสจะเก่าหรือใหม่
  function canSummarizeCase(c: Contract): boolean {
    if (!gateFromLoaded) return false
    return canMarkSummary(c.reviewStatus ?? null, isGated(c, gateFrom))
  }

  // ข้อความอธิบายว่าทำไมกดสรุปยอดไม่ได้ — ใช้ summaryBlockReason() ที่ล็อกคำไว้แล้ว (ห้ามพิมพ์เอง)
  // ยกเว้นช่วงกำลังโหลด/โหลดพัง ซึ่งเป็นสถานะ "ยังไม่รู้" ไม่ใช่กฎทางธุรกิจ เลยมีข้อความของตัวเอง
  function summaryReasonFor(c: Contract): string | null {
    if (!gateFromLoaded) {
      return gateFromError
        ? 'ตรวจสอบเงื่อนไขก่อนสรุปยอดไม่สำเร็จ (เน็ตอาจสะดุด) กดลองใหม่ด้านบนก่อนนะคะ'
        : 'กำลังตรวจสอบเงื่อนไขก่อนสรุปยอด...'
    }
    return summaryBlockReason(c.reviewStatus ?? null, isGated(c, gateFrom))
  }

  // โหลดสถานะรูปเฉพาะเคสที่เข้าเกณฑ์ (ไม่ดึงทั้ง 25 เคส) — กันหน้าช้าลง
  useEffect(() => {
    if (trackedShopIds.length === 0) {
      setMediaStatuses(new Map())
      return
    }
    let cancelled = false
    getMediaStatuses(trackedShopIds)
      .then((rows) => {
        if (cancelled) return
        setMediaStatuses(new Map(rows.map((r) => [r.contractId, r])))
      })
      .catch(() => {
        /* เงียบ: ป้ายรูปแค่ไม่โชว์ ไม่บล็อกหน้า */
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackedShopIds])

  // ประเมินสถานะรูปของเคส (null = ยังไม่โหลดเสร็จ/ไม่เข้าเกณฑ์ติดตาม)
  function mediaEvaluationFor(c: Contract) {
    const status = mediaStatuses.get(c.id)
    if (!status) return null
    return evaluateFromStatus(mediaSlots, status)
  }

  // คอลัมน์ขวา (รอส่งบัญชี): ส่งร้านแล้ว (DB หรือรอบนี้) แต่ยังไม่ส่งบัญชี
  const accountingBase = useMemo(
    () =>
      data.contracts.filter(
        (c) =>
          c.summaryAccountingSentAt == null &&
          !locallyAccountingSent.has(c.id) &&
          (c.summaryShopSentAt != null || locallyShopSent.has(c.id)),
      ),
    [data.contracts, locallyShopSent, locallyAccountingSent],
  )

  // ตัด id ที่ค้างใน localStorage แต่ไม่อยู่ในคอลัมน์ซ้ายแล้ว (ถูกส่ง/เด้งไปขวา) ออก หลังโหลดเสร็จ
  // + เขี่ยเคสที่กดสรุปยอดไม่ได้ (ยังไม่ผ่านตรวจ) ออกจาก selection ด้วย กัน selection เก่าที่ค้างใน localStorage หลุดไป
  // (รอ gateFromLoaded ก่อนตัดด้วยเงื่อนไขตรวจ — ตอนยังไม่รู้ค่าจริง ตัดแค่เคสที่หลุดจาก shopBase ไปก่อน)
  useEffect(() => {
    if (loading) return
    const shopIds = new Set(shopBase.map((c) => c.id))
    const valid = gateFromLoaded
      ? new Set(shopBase.filter((c) => canSummarizeCase(c)).map((c) => c.id))
      : shopIds
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => valid.has(id)))
      return next.size !== prev.size ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, shopBase, gateFromLoaded, gateFrom])

  // prune ฝั่งบัญชี เทียบ accountingBase (กัน id ค้างหลังเคสถูกส่งบัญชี/หายไป)
  useEffect(() => {
    if (loading) return
    const valid = new Set(accountingBase.map((c) => c.id))
    setSelectedAccounting((prev) => {
      const next = new Set([...prev].filter((id) => valid.has(id)))
      return next.size !== prev.size ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, accountingBase])

  // ร้านที่เลือกได้ = ร้านที่มีเคสค้างใน "ทั้ง 2 base" (union) หลังกรองช่วงวันที่ — จะได้ไม่หายตอนกรอง
  const shopOptions = useMemo(() => {
    const inRange = (c: Contract) => {
      if (fromDate && c.transactionDate < fromDate) return false
      if (toDate && c.transactionDate > toDate) return false
      return true
    }
    const ids = new Set<string>()
    shopBase.filter(inRange).forEach((c) => ids.add(c.shopId))
    accountingBase.filter(inRange).forEach((c) => ids.add(c.shopId))
    return [...data.shops]
      .filter((s) => ids.has(s.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'th'))
  }, [shopBase, accountingBase, data.shops, fromDate, toDate])

  const hasFilter = !!(fromDate || toDate || shopFilter)
  const clearFilter = () => {
    setFromDate('')
    setToDate('')
    setShopFilter('')
  }

  // ตัวกรอง+sort ใช้ร่วมทั้ง 2 คอลัมน์
  const applyFilterSort = (list: Contract[]) => {
    const [key, dir] = sortOpt.split('_') as [SortKey, SortDir]
    const filtered = list.filter((c) => {
      if (fromDate && c.transactionDate < fromDate) return false
      if (toDate && c.transactionDate > toDate) return false
      if (shopFilter && c.shopId !== shopFilter) return false
      return true
    })
    return sortContracts(filtered, key, dir)
  }

  const pendingShop = useMemo(
    () => applyFilterSort(shopBase),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shopBase, sortOpt, fromDate, toDate, shopFilter],
  )

  const pendingAccounting = useMemo(
    () => applyFilterSort(accountingBase),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accountingBase, sortOpt, fromDate, toDate, shopFilter],
  )

  // เคสในตัวกรองปัจจุบันที่กดสรุปยอดได้จริง (ตัดเคสที่ยังไม่ผ่านตรวจออก) — ใช้ทั้งเลือกทั้งหมด + ป้ายจำนวน
  const eligibleShopIds = useMemo(
    () => pendingShop.filter((c) => canSummarizeCase(c)).map((c) => c.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pendingShop, gateFromLoaded, gateFrom],
  )
  const blockedShopCount = pendingShop.length - eligibleShopIds.length

  function toggleShop(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // เลือกทั้งหมด ต้องข้ามเคสที่กดสรุปยอดไม่ได้ (ยังไม่ผ่านตรวจ) เสมอ — ไม่งั้นเงินจะโอนออกก่อนตรวจ
  function toggleAllShop() {
    if (eligibleShopIds.length === 0) return
    const allSelected = eligibleShopIds.every((id) => selected.has(id))
    setSelected(allSelected ? new Set() : new Set(eligibleShopIds))
  }

  function toggleAccounting(id: string) {
    setSelectedAccounting((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllAccounting() {
    setSelectedAccounting((prev) =>
      prev.size === pendingAccounting.length
        ? new Set()
        : new Set(pendingAccounting.map((c) => c.id)),
    )
  }

  // จัดกลุ่มเคสที่เลือกตามร้าน เพื่อป้อนตัวสร้างข้อความรวม — ฝั่งร้าน
  const groups = useMemo(() => {
    const map = new Map<string, { shop: Shop; items: Contract[] }>()
    pendingShop
      .filter((c) => selected.has(c.id))
      .forEach((c) => {
        const shop = shopOf(c.shopId)
        if (!shop) return
        if (!map.has(shop.id)) map.set(shop.id, { shop, items: [] })
        map.get(shop.id)!.items.push(c)
      })
    return [...map.values()]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingShop, selected])

  // ข้อความสรุปยอดส่งร้าน — derived อัตโนมัติจากเคสที่เลือก + วันที่สรุป
  const shopOutput = useMemo(
    () => (groups.length === 0 ? '' : buildBulkSummary(groups, date)),
    [groups, date],
  )

  // จัดกลุ่มเคสที่เลือกฝั่งบัญชีตามร้าน
  const accountingGroups = useMemo(() => {
    const map = new Map<string, { shop: Shop; items: Contract[] }>()
    pendingAccounting
      .filter((c) => selectedAccounting.has(c.id))
      .forEach((c) => {
        const shop = shopOf(c.shopId)
        if (!shop) return
        if (!map.has(shop.id)) map.set(shop.id, { shop, items: [] })
        map.get(shop.id)!.items.push(c)
      })
    return [...map.values()]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAccounting, selectedAccounting])

  // ข้อความสรุปยอดส่งบัญชี — derived จากเคสที่เลือก
  const accountingOutput = useMemo(
    () => (accountingGroups.length === 0 ? '' : buildBulkSummary(accountingGroups, date)),
    [accountingGroups, date],
  )

  async function markShopSent() {
    // กรองซ้ำอีกชั้นก่อนยิงจริง — กันเคสที่ยังไม่ผ่านตรวจหลุดมาจาก selection เก่า
    // (defense-in-depth คู่กับ checkbox disabled + toggleAllShop + prune effect ด้านบน ห้ามพึ่ง UI ชั้นเดียว)
    const ids = [...selected].filter((id) => {
      const c = shopBase.find((x) => x.id === id)
      return !!c && canSummarizeCase(c)
    })
    if (ids.length === 0) return
    const flagged = pendingShop.filter((c) => ids.includes(c.id) && c.pendingDocuments)
    if (flagged.length > 0) {
      const names = flagged.map((c) => c.customerName).join(', ')
      const ok = window.confirm(
        `มี ${flagged.length} เคสรอเอกสาร: ${names}\n\nยืนยันว่าเอกสารครบทั้งหมดแล้ว?`,
      )
      if (!ok) return
    }
    setMarkShopError(null)
    setMarkShopBusy(true)
    try {
      await markSummaryShopSent(ids, name ?? undefined, date) // บันทึกลง DB จริง (กันส่งซ้ำ) — เกาะวันที่สรุปที่เลือก
      setLocallyShopSent((prev) => new Set([...prev, ...ids]))
      setSelected(new Set())
    } catch (e) {
      setMarkShopError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง')
    } finally {
      setMarkShopBusy(false)
    }
  }

  async function markAccountingSent() {
    const ids = [...selectedAccounting]
    if (ids.length === 0) return
    await markSummaryAccountingSent(ids, name ?? undefined, date) // บันทึกลง DB จริง — เกาะวันที่สรุปที่เลือก
    setLocallyAccountingSent((prev) => new Set([...prev, ...ids]))
    setSelectedAccounting(new Set())
  }

  // req2: เคสที่ถูกตีกลับ (needsFixReason != null) กด "แก้แล้ว ส่งใหม่" → เคลียร์ needs_fix_* แล้วซ่อนป้ายทันที
  async function handleClearNeedsFix(contractId: string) {
    setClearingId(contractId)
    try {
      await clearNeedsFix(contractId)
      setLocallyClearedNeedsFix((prev) => new Set([...prev, contractId]))
    } finally {
      setClearingId(null)
    }
  }

  const selectedShopNet = groups.flatMap((g) => g.items).reduce((sum, c) => sum + netOf(c), 0)
  const selectedAccountingNet = accountingGroups
    .flatMap((g) => g.items)
    .reduce((sum, c) => sum + netOf(c), 0)

  if (loading) {
    return (
      <div>
        <PageTitle>รอสรุปยอด</PageTitle>
        <Loading />
      </div>
    )
  }

  const noneAtAll = shopBase.length === 0 && accountingBase.length === 0

  return (
    <div>
      <PageTitle sub="2 ด่านต่อเคส: รอบ 1 ส่งให้ร้านค้า → รอบ 2 สรุปยอดรวมส่งแผนกบัญชี (กันส่งซ้ำด้วยการทำเครื่องหมายว่าส่งแล้ว)">
        รอสรุปยอด
      </PageTitle>

      {noneAtAll ? (
        <EmptyState title="ไม่มีเคสรอสรุปยอด" hint="เคสใหม่จะเข้ามาที่นี่อัตโนมัติ" />
      ) : (
        <>
          {/* แถบควบคุมรวม: วันที่สรุป + sort + ตัวกรอง (ช่วงวันที่+ร้าน) — กระทบทั้ง 2 คอลัมน์ */}
          <div className="mb-5 flex flex-col gap-3 rounded-2xl border border-peach bg-white px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-ink">
                วันที่สรุป
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-auto" />
              </label>
              <Select
                value={sortOpt}
                onChange={(e) => setSortOpt(e.target.value as `${SortKey}_${SortDir}`)}
                className="w-auto text-sm"
              >
                {SORT_OPTS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-wrap items-center gap-3">
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
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            {/* ── คอลัมน์ซ้าย: รอส่งร้าน ── */}
            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-ink">รอส่งร้าน ({pendingShop.length})</h2>
                {pendingShop.length > 0 && (
                  <Button
                    variant="ghost"
                    onClick={toggleAllShop}
                    disabled={eligibleShopIds.length === 0}
                    className="text-sm"
                  >
                    {selected.size === eligibleShopIds.length && eligibleShopIds.length > 0
                      ? 'ยกเลิกเลือกทั้งหมด'
                      : 'เลือกทั้งหมด'}
                  </Button>
                )}
              </div>

              {gateFromError && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  <p>ตรวจสอบเงื่อนไขก่อนสรุปยอดไม่สำเร็จ (เน็ตอาจสะดุด) เคสที่ยังไม่ผ่านตรวจจะกดสรุปยอดไม่ได้จนกว่าจะโหลดสำเร็จ</p>
                  <Button variant="ghost" onClick={retryGateFrom} className="mt-1 text-xs">
                    ลองใหม่
                  </Button>
                </div>
              )}

              {!gateFromLoaded && !gateFromError && (
                <p className="text-xs text-ink-soft">กำลังตรวจสอบเงื่อนไขก่อนสรุปยอด...</p>
              )}

              {gateFromLoaded && blockedShopCount > 0 && (
                <p className="text-xs text-ink-soft">
                  {blockedShopCount} เคส ยังกดสรุปยอดไม่ได้ (ยังไม่ผ่านตรวจ) — ดูเหตุผลที่แต่ละเคสด้านล่าง
                </p>
              )}

              {markShopError && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {markShopError}
                </div>
              )}

              {shopBase.length === 0 ? (
                <EmptyState title="ไม่มีเคสรอส่งร้าน" />
              ) : pendingShop.length === 0 ? (
                <EmptyState title="ไม่มีเคสตรงตัวกรอง" hint="ลองปรับช่วงวันหรือร้าน" />
              ) : (
                <ul className="flex flex-col gap-2">
                  {pendingShop.map((c) => {
                    const checked = selected.has(c.id)
                    const isRejected = !!c.needsFixReason && !locallyClearedNeedsFix.has(c.id)
                    const canPick = canSummarizeCase(c)
                    const blockReason = canPick ? null : summaryReasonFor(c)
                    // ป้าย "รูป ขาด" / "ยังไม่ผ่านตรวจ" ขึ้นเฉพาะเคสที่เข้าเกณฑ์จริง (createdAt >= gateFrom
                    // จาก app_settings.media_gate_from — cutoff เดียวจริงตัวเดียวทั้งเว็บ ห้ามใช้วันตายตัวสอง
                    // ค่าที่เคยเข้าใจผิดว่ามีสองรอบคีย์ 8-9 ก.ย. 2026 — ตอนนี้ยึด gateFrom จาก DB เท่านั้น)
                    const showsGateBadges = gateFromLoaded && isGated(c, gateFrom)
                    return (
                      <li
                        key={c.id}
                        onClick={() => { if (canPick) toggleShop(c.id) }}
                        title={blockReason ?? undefined}
                        className={`flex flex-col gap-2 rounded-xl border px-4 py-3 transition ${
                          !canPick
                            ? 'cursor-not-allowed border-peach bg-peach-light/20 opacity-70'
                            : `cursor-pointer ${
                                isRejected
                                  ? 'border-red-300 bg-red-50/60'
                                  : checked
                                    ? 'border-salmon-deep bg-peach-light/60'
                                    : 'border-peach bg-white hover:bg-peach-light/30'
                              }`
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            checked={checked}
                            readOnly
                            disabled={!canPick}
                            className="h-4 w-4 accent-salmon-deep disabled:cursor-not-allowed disabled:opacity-50"
                          />
                          <div className="flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <p className="font-medium text-ink">
                                <Link
                                  to={`/contract/${c.id}`}
                                  className="text-salmon-deep hover:underline"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {c.customerName}
                                </Link>
                                {' '}— {c.contractNo}
                              </p>
                              {c.pendingDocuments && <Badge tone="amber">รอเอกสาร</Badge>}
                              {showsGateBadges && (() => {
                                const ev = mediaEvaluationFor(c)
                                return ev && !ev.complete ? (
                                  <Badge tone="amber">{`รูป ขาด ${ev.missing.length}`}</Badge>
                                ) : null
                              })()}
                              {showsGateBadges && (c.reviewStatus ?? null) !== 'approved' && (
                                <Badge tone="amber">ยังไม่ผ่านตรวจ</Badge>
                              )}
                              {canEditNote && (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); setNoteTarget(c) }}
                                  aria-label="แก้ไขหมายเหตุ"
                                  title="แก้ไขหมายเหตุ"
                                  className="rounded p-0.5 text-ink-soft transition hover:bg-peach-light/50 hover:text-ink"
                                >
                                  <Pencil size={12} />
                                </button>
                              )}
                            </div>
                            <p className="text-sm text-ink-soft">
                              {shopOf(c.shopId)?.name} · {thaiDate(c.transactionDate)}
                            </p>
                            {noteOf(c) && (
                              <p className="text-xs text-ink-soft">
                                หมายเหตุ: {noteOf(c)}
                                {noteByOf(c) && <span className="ml-1 text-[11px]">({noteByOf(c)})</span>}
                              </p>
                            )}
                          </div>
                          <span className="font-semibold text-salmon-deep whitespace-nowrap">{baht(netOf(c))} ฿</span>
                        </div>
                        {blockReason && (
                          <p className="rounded-lg bg-peach-light/50 px-3 py-2 text-xs font-medium text-ink-soft">
                            {blockReason}
                          </p>
                        )}
                        {/* ปุ่มฉุกเฉิน — เฉพาะแอดมิน + เฉพาะเคสที่กดสรุปยอดปกติไม่ได้ + รู้ผลเกทแล้วจริงๆ (ไม่ใช่กำลังโหลด) */}
                        {gateFromLoaded && !canPick && isAdminOrMock && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              setForceTarget(c)
                            }}
                            className="self-start text-xs text-ink-soft underline decoration-dotted hover:text-ink"
                          >
                            สรุปยอดโดยไม่ผ่านตรวจ (ฉุกเฉิน)
                          </button>
                        )}
                        {isRejected && (
                          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-red-100 px-3 py-2">
                            <p className="text-xs font-medium text-red-700">
                              {buildRejectionBanner(
                                REJECTION_REASON_LABEL[c.needsFixReason ?? ''] ?? c.needsFixReason ?? '',
                                c.needsFixDetail ?? null,
                                c.needsFixBy ?? '-',
                                c.needsFixAt ?? '',
                              )}
                            </p>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                void handleClearNeedsFix(c.id)
                              }}
                              disabled={clearingId === c.id}
                              className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-red-300 bg-white px-2 py-1 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-50"
                            >
                              <RotateCcw size={12} />
                              {clearingId === c.id ? 'กำลังบันทึก...' : 'แก้แล้ว ส่งใหม่'}
                            </button>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}

              {shopOutput && (
                <div className="flex flex-col gap-3">
                  <Badge tone="green">
                    รวม <span className="whitespace-nowrap">{baht(selectedShopNet)} ฿</span> · {groups.length} ร้าน
                  </Badge>
                  <CopyBox title="ข้อความสรุปยอดส่งร้าน" text={shopOutput} />
                  <Button variant="ghost" onClick={markShopSent} disabled={markShopBusy} className="self-start">
                    {markShopBusy ? 'กำลังบันทึก...' : `✓ ทำเครื่องหมายว่าส่งร้านแล้ว (${selected.size} เคส)`}
                  </Button>
                </div>
              )}
            </section>

            {/* ── คอลัมน์ขวา: ส่งร้านแล้ว · รอส่งบัญชี ── */}
            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-ink">
                  ส่งร้านแล้ว · รอส่งบัญชี ({pendingAccounting.length})
                </h2>
                {pendingAccounting.length > 0 && (
                  <Button variant="ghost" onClick={toggleAllAccounting} className="text-sm">
                    {selectedAccounting.size === pendingAccounting.length ? 'ยกเลิกเลือกทั้งหมด' : 'เลือกทั้งหมด'}
                  </Button>
                )}
              </div>

              {accountingBase.length === 0 ? (
                <EmptyState title="ยังไม่มีเคสรอส่งบัญชี" hint="เคสจะเข้ามาเมื่อกดส่งร้านแล้ว" />
              ) : pendingAccounting.length === 0 ? (
                <EmptyState title="ไม่มีเคสตรงตัวกรอง" hint="ลองปรับช่วงวันหรือร้าน" />
              ) : (
                <ul className="flex flex-col gap-2">
                  {pendingAccounting.map((c) => {
                    const checked = selectedAccounting.has(c.id)
                    return (
                      <li
                        key={c.id}
                        onClick={() => toggleAccounting(c.id)}
                        className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition ${
                          checked ? 'border-salmon-deep bg-peach-light/60' : 'border-peach bg-white hover:bg-peach-light/30'
                        }`}
                      >
                        <input type="checkbox" checked={checked} readOnly className="h-4 w-4 accent-salmon-deep" />
                        <div className="flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <p className="font-medium text-ink">
                              <Link
                                to={`/contract/${c.id}`}
                                className="text-salmon-deep hover:underline"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {c.customerName}
                              </Link>
                              {' '}— {c.contractNo}
                            </p>
                            {c.pendingDocuments && <Badge tone="amber">รอเอกสาร</Badge>}
                            {canEditNote && (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setNoteTarget(c) }}
                                aria-label="แก้ไขหมายเหตุ"
                                title="แก้ไขหมายเหตุ"
                                className="rounded p-0.5 text-ink-soft transition hover:bg-peach-light/50 hover:text-ink"
                              >
                                <Pencil size={12} />
                              </button>
                            )}
                          </div>
                          <p className="text-sm text-ink-soft">
                            {shopOf(c.shopId)?.name} · {thaiDate(c.transactionDate)}
                          </p>
                          {noteOf(c) && (
                            <p className="text-xs text-ink-soft">
                              หมายเหตุ: {noteOf(c)}
                              {noteByOf(c) && <span className="ml-1 text-[11px]">({noteByOf(c)})</span>}
                            </p>
                          )}
                        </div>
                        <span className="font-semibold text-salmon-deep whitespace-nowrap">{baht(netOf(c))} ฿</span>
                      </li>
                    )
                  })}
                </ul>
              )}

              {accountingOutput && (
                <div className="flex flex-col gap-3">
                  <Badge tone="green">
                    รวม <span className="whitespace-nowrap">{baht(selectedAccountingNet)} ฿</span> · {accountingGroups.length} ร้าน
                  </Badge>
                  <CopyBox title="ข้อความสรุปยอดส่งบัญชี" text={accountingOutput} />
                  <Button variant="ghost" onClick={markAccountingSent} className="self-start">
                    ✓ ทำเครื่องหมายส่งบัญชีแล้ว ({selectedAccounting.size} เคส)
                  </Button>
                </div>
              )}
            </section>
          </div>
        </>
      )}

      {noteTarget && (
        <SummaryNoteModal
          contract={noteTarget}
          byName={byName}
          onClose={() => setNoteTarget(null)}
          onDone={(savedNote, savedBy) => {
            setNoteOverride((prev) => new Map(prev).set(noteTarget.id, { note: savedNote, by: savedBy }))
            setNoteTarget(null)
          }}
        />
      )}

      {forceTarget && (
        <ForceSummaryModal
          contract={forceTarget}
          dateISO={date}
          onClose={() => setForceTarget(null)}
          onDone={(contractId) => {
            // เด้งเคสนี้ออกจากคอลัมน์ซ้ายทันที เหมือน markShopSent ปกติ (ไม่ต้อง reload ทั้งหน้า)
            setLocallyShopSent((prev) => new Set([...prev, contractId]))
            setSelected((prev) => {
              if (!prev.has(contractId)) return prev
              const next = new Set(prev)
              next.delete(contractId)
              return next
            })
            setForceTarget(null)
          }}
        />
      )}
    </div>
  )
}
