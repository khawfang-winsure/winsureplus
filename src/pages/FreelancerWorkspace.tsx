import { useCallback, useEffect, useMemo, useState } from 'react'
import { useFilter } from '../lib/useFilter'
import { AlarmClock, Search } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Loading, Modal, PageTitle } from '../components/ui'
import { baht } from '../lib/format'
import {
  addFollowUp,
  getFreelancerQueue,
  getMyAssignedGrades,
  getOverduePromiseContracts,
  getPublicHolidays,
  markCaseSeen,
  type ContractGrade,
  type FollowUpResult,
  type FreelancerQueueRow,
} from '../lib/db'
import type { OverduePromiseContract } from '../lib/types'
import { useAuth } from '../lib/auth'
import { isContactWindowOpen } from '../lib/contactHours'
import {
  computePriorityScore,
  hasUnseenUpdate,
  sortQueue,
  type PriorityTier,
  type SuppressReason,
} from '../lib/priorityQueue'
import FollowUpModal from '../components/FollowUpModal'

// ===== ป้ายกำกับเกรด + สีตาม Badge tone =====
const GRADE_TONE: Record<ContractGrade, 'red' | 'amber' | 'neutral'> = {
  A: 'neutral',
  B: 'neutral',
  C: 'amber',
  D: 'amber',
  E: 'red',
}

// ===== emoji + label ต่อ tier =====
const TIER_EMOJI: Record<PriorityTier, string> = {
  HOT: '🔥',
  WARM: '⚡',
  COLD: '❄️',
  ESCALATE: '🚨',
}

const TIER_LABEL: Record<PriorityTier, string> = {
  HOT: 'HOT',
  WARM: 'WARM',
  COLD: 'COLD',
  ESCALATE: 'ESCALATE',
}

// ===== Badge color ต่อ tier (ใช้ inline style เพราะ Badge ไม่มี salmon/custom tone) =====
const TIER_SCORE_CLS: Record<PriorityTier, string> = {
  HOT: 'bg-red-100 text-red-700',
  WARM: 'bg-amber-100 text-amber-700',
  COLD: 'bg-blue-100 text-blue-600',
  ESCALATE: 'bg-purple-100 text-purple-700',
}

// ===== label แสดงผล FollowUpResult เป็นภาษาไทย =====
const RESULT_LABEL: Record<FollowUpResult, string> = {
  contacted: 'ติดต่อสำเร็จ',
  no_answer: 'ไม่รับสาย',
  promised: 'สัญญาจะจ่าย',
  refused: 'ปฏิเสธ',
  paid: 'จ่ายแล้ว',
  returned: 'คืนเครื่อง',
  line_pending: 'นัดทาง LINE – รอลูกค้า',
  other: 'อื่นๆ',
}

// ===== tooltip ภาษาไทยสำหรับ suppressReason =====
const SUPPRESS_LABEL: Record<NonNullable<SuppressReason>, string> = {
  DNC: 'สัญญานี้อยู่ในสถานะห้ามติดต่อ (DNC)',
  LAWYER: 'สัญญานี้มีทนายความ กรุณาติดต่อทนายแทน',
  CAP: 'ติดต่อครบแล้วสำหรับวันนี้',
  PROMISE_PENDING: 'ลูกค้าสัญญาจะจ่าย รอถึงวันนัด',
}

// ===== default expand per tier (localStorage: "true"/"false") =====
const TIER_DEFAULT_OPEN: Record<PriorityTier, boolean> = {
  HOT: true,
  WARM: true,
  COLD: false,
  ESCALATE: true,
}

const TIER_ORDER: PriorityTier[] = ['HOT', 'WARM', 'COLD', 'ESCALATE']

// strip dashes/spaces จากเบอร์โทรเพื่อเทียบแบบ normalize
function stripPhone(p: string): string {
  return p.replace(/[\s-]/g, '')
}

// ===== Banner นอกเวลาทวงถาม =====
function OutsideHoursBanner() {
  return (
    <div className="mb-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
      <span className="font-semibold">นอกเวลาทวงถามตามกฎหมาย</span>
      {' '}— การติดต่อลูกค้าอนุญาตเฉพาะ{' '}
      <span className="font-medium">08:00–20:00 (จ–ศ)</span> และ{' '}
      <span className="font-medium">08:00–18:00 (ส–อา+วันหยุดราชการ)</span>
    </div>
  )
}

// ===== relative time helper (Bangkok UTC+7) =====
function relativeContactTime(isoTimestamp: string): string {
  // แปลง timestamp เป็น Bangkok local date + time
  const bkkMs = new Date(isoTimestamp).getTime() + 7 * 3600 * 1000
  const bkkDate = new Date(bkkMs)
  const datePart = bkkDate.toISOString().slice(0, 10) // yyyy-mm-dd

  const nowBkkMs = Date.now() + 7 * 3600 * 1000
  const nowBkk = new Date(nowBkkMs)
  const todayPart = nowBkk.toISOString().slice(0, 10)

  const yesterdayMs = nowBkkMs - 86400 * 1000
  const yesterdayPart = new Date(yesterdayMs).toISOString().slice(0, 10)

  const hh = String(bkkDate.getUTCHours()).padStart(2, '0')
  const mm = String(bkkDate.getUTCMinutes()).padStart(2, '0')
  const timeStr = `${hh}:${mm}`

  if (datePart === todayPart) return `วันนี้ ${timeStr}`
  if (datePart === yesterdayPart) return `เมื่อวาน ${timeStr}`
  const [, mo, dy] = datePart.split('-')
  return `${dy}/${mo}`
}

// ===== Row ขยายในแต่ละ section =====
interface ScoredRow {
  row: FreelancerQueueRow
  score: number
  tier: PriorityTier
  actionableNow: boolean
  suppressReason: SuppressReason
  promiseToPayDate: string | null
}

// ===== Section collapsible =====
function SectionHeader({
  tier,
  count,
  open,
  onToggle,
}: {
  tier: PriorityTier
  count: number
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-xl px-4 py-2.5 text-left text-sm font-semibold text-ink transition hover:bg-peach-light/40"
    >
      <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${TIER_SCORE_CLS[tier]}`}>
        {TIER_EMOJI[tier]} {TIER_LABEL[tier]} ({count})
      </span>
      <span className="ml-auto text-ink-soft">{open ? '▲' : '▼'}</span>
    </button>
  )
}

// ===== Row ใน Tab 1 =====
function QueueRow({
  sr,
  outsideHours,
  onSelect,
  selected,
  onToggleSelect,
}: {
  sr: ScoredRow
  outsideHours: boolean
  onSelect: (r: FreelancerQueueRow) => void
  selected: boolean
  onToggleSelect: (contractId: string) => void
}) {
  const r = sr.row
  const isBlocked = r.dnc || r.lawyerEngaged
  const disableButton = outsideHours || !sr.actionableNow

  let tooltip = ''
  if (outsideHours) tooltip = 'นอกเวลาทวงถามตามกฎหมาย'
  else if (sr.suppressReason) tooltip = SUPPRESS_LABEL[sr.suppressReason]

  // promise badge color
  const todayPart = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10)
  const promiseOverdue =
    r.promiseToPayDate !== null && r.promiseToPayDate < todayPart

  const [, pMonth, pDay] = r.promiseToPayDate ? r.promiseToPayDate.split('-') : [null, null, null]

  return (
    <tr className={`border-b border-peach last:border-0 hover:bg-peach-light/20 ${selected ? 'bg-peach-light/40' : ''}`}>
      {/* checkbox */}
      <td className="px-3 py-3 text-center">
        <input
          type="checkbox"
          checked={selected}
          disabled={!sr.actionableNow}
          onChange={() => onToggleSelect(r.contractId)}
          title={!sr.actionableNow && sr.suppressReason ? SUPPRESS_LABEL[sr.suppressReason] : undefined}
          className="h-4 w-4 cursor-pointer accent-salmon-deep disabled:cursor-not-allowed disabled:opacity-40"
        />
      </td>
      {/* ลูกค้า */}
      <td className="px-4 py-3">
        {/* unseen update badge */}
        {hasUnseenUpdate(r.myLastTouchAt, r.latestOtherAuthorAt) && (
          <div className="mb-1">
            <span className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
              🔔 มีอัปเดตใหม่
            </span>
          </div>
        )}
        {/* status flags */}
        {(r.dnc || r.lawyerEngaged || r.disputed) && (
          <div className="mb-1 flex flex-wrap gap-1">
            {r.dnc && <Badge tone="red">⛔ ห้ามติดต่อ (DNC)</Badge>}
            {r.lawyerEngaged && !r.dnc && <Badge tone="amber">⚖️ มีทนายความ</Badge>}
            {r.disputed && <Badge tone="amber">📋 โต้แย้งยอด</Badge>}
          </div>
        )}
        <p className={`font-medium ${isBlocked ? 'text-ink-soft' : 'text-ink'}`}>
          {r.customerName}
        </p>
        <p className="text-xs text-ink-soft">{r.contractNo}</p>
        {/* รุ่น iPhone */}
        {r.deviceModel && (
          <p className="text-xs text-ink-soft">📱 {r.deviceModel}</p>
        )}
        {/* เบอร์หลัก */}
        {r.phone && <p className="text-xs text-ink-soft">{r.phone}</p>}
        {/* เบอร์สำรอง */}
        {(r.phoneAlt1 || r.phoneAlt2) && (
          <p className="text-xs text-ink-soft">
            📞 สำรอง:{' '}
            {[r.phoneAlt1, r.phoneAlt2].filter(Boolean).join(', ')}
          </p>
        )}
        {/* team awareness */}
        {r.lastResult !== null && r.lastContactedAt !== null && (
          <p className="mt-0.5 text-xs text-ink-soft">
            🕐 {r.lastContactedByName ?? '?'}{' '}
            {relativeContactTime(r.lastContactedAt)}{' '}
            — {RESULT_LABEL[r.lastResult]}
          </p>
        )}
        {/* latest note */}
        {r.latestNote && (
          <p className="mt-0.5 text-xs text-ink-soft">
            💬 {r.latestNote.length > 40 ? r.latestNote.slice(0, 40) + '…' : r.latestNote}
          </p>
        )}
        {/* promise badge */}
        {r.promiseToPayDate !== null && pDay !== null && pMonth !== null && (
          <span
            className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
              promiseOverdue ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
            }`}
          >
            📅 สัญญาจะจ่าย {pDay}/{pMonth}
          </span>
        )}
      </td>
      {/* ร้าน */}
      <td className="px-4 py-3 text-sm text-ink-soft">{r.shopName}</td>
      {/* เกรด */}
      <td className="px-4 py-3 text-center">
        <Badge tone={GRADE_TONE[r.grade]}>เกรด {r.grade}</Badge>
      </td>
      {/* score badge */}
      <td className="px-4 py-3 text-center">
        <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${TIER_SCORE_CLS[sr.tier]}`}>
          {TIER_EMOJI[sr.tier]} {sr.score}
        </span>
      </td>
      {/* ค้าง (วัน) */}
      <td className="px-4 py-3 text-right">
        <span className="font-semibold text-red-600">{r.daysLate}</span>
      </td>
      {/* งวด X/Y */}
      <td className="px-4 py-3 text-right text-sm text-ink">
        {r.installmentsTotal === 0
          ? <span className="text-ink-soft">—</span>
          : <span>งวด {r.installmentsPaid}/{r.installmentsTotal}</span>
        }
      </td>
      {/* ค่างวด + ค่าปรับ */}
      <td className="px-4 py-3 text-right">
        <p className="text-sm text-ink">{baht(r.monthlyPayment)} ฿</p>
        {r.outstanding > 0 ? (
          <p className="text-xs font-semibold text-red-600">{baht(r.outstanding)} ฿ ค่าปรับ</p>
        ) : (
          <p className="text-xs text-ink-soft">-</p>
        )}
      </td>
      {/* เงินต้นค้าง */}
      <td className="px-4 py-3 text-right">
        {r.principalDue > 0 ? (
          <span className="font-semibold text-red-600">{baht(r.principalDue)} ฿</span>
        ) : (
          <span className="text-ink-soft">-</span>
        )}
      </td>
      {/* ปุ่ม */}
      <td className="px-4 py-3">
        <button
          disabled={disableButton}
          onClick={() => !disableButton && onSelect(r)}
          title={tooltip || undefined}
          className={`whitespace-nowrap rounded-xl border px-3 py-2 text-xs font-semibold transition ${
            disableButton
              ? 'cursor-not-allowed border-peach bg-peach-light/40 text-ink-soft opacity-60'
              : 'border-peach bg-white text-ink hover:bg-peach-light/50'
          }`}
        >
          บันทึกติดตาม
        </button>
      </td>
    </tr>
  )
}

// ===== Component หลัก =====
export default function FreelancerWorkspace() {
  const { role } = useAuth()
  const [assignedGrades, setAssignedGrades] = useState<ContractGrade[]>([])
  const [selectedGrades, setSelectedGrades] = useState<ContractGrade[]>([])
  const [rows, setRows] = useState<FreelancerQueueRow[]>([])
  const [loading, setLoading] = useState(true)
  const [shopFilter, setShopFilter] = useFilter<string>('queue.shop', '')
  const [searchTerm, setSearchTerm] = useState<string>('')
  const [selectedContract, setSelectedContract] = useState<FreelancerQueueRow | null>(null)
  const [publicHolidays, setPublicHolidays] = useState<Set<string>>(new Set())
  const [activeTab, setActiveTab] = useFilter<'todo' | 'done'>('queue.tab', 'todo')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkSubmitting, setBulkSubmitting] = useState(false)
  const [showBulkConfirm, setShowBulkConfirm] = useState(false)
  const [bulkResult, setBulkResult] = useState<{ success: number; failedNos: string[] } | null>(null)

  // overdue promise state
  const [overdue, setOverdue] = useState<OverduePromiseContract[]>([])
  const [overdueFilter, setOverdueFilter] = useState(false)

  // section expand states (localStorage-backed)
  const [sectionOpen, setSectionOpen] = useState<Record<PriorityTier, boolean>>(() => {
    const load = (tier: PriorityTier): boolean => {
      try {
        const stored = localStorage.getItem(`worklist-section-${tier}`)
        return stored === null ? TIER_DEFAULT_OPEN[tier] : stored === 'true'
      } catch {
        return TIER_DEFAULT_OPEN[tier]
      }
    }
    return {
      HOT: load('HOT'),
      WARM: load('WARM'),
      COLD: load('COLD'),
      ESCALATE: load('ESCALATE'),
    }
  })

  function toggleSection(tier: PriorityTier) {
    setSectionOpen((prev) => {
      const next = { ...prev, [tier]: !prev[tier] }
      try {
        localStorage.setItem(`worklist-section-${tier}`, String(next[tier]))
      } catch {
        // ignore storage errors
      }
      return next
    })
  }

  // ตรวจเวลา render-time
  const windowResult = isContactWindowOpen(new Date(), publicHolidays)
  const outsideHours = role !== 'admin' && !windowResult.ok

  // โหลด public holidays ครั้งเดียวตอน mount
  useEffect(() => {
    getPublicHolidays().then(setPublicHolidays)
  }, [])

  // โหลด overdue promise contracts ครั้งเดียวตอน mount
  useEffect(() => {
    getOverduePromiseContracts().then(setOverdue).catch(() => setOverdue([]))
  }, [])

  // เก็บ overdue raw (ทั้งหมดที่ DB คืน — รวมถึงที่ไม่อยู่ในคิว)
  const overdueIdsAll = useMemo(() => new Set(overdue.map((o) => o.id)), [overdue])

  // โหลดเกรดที่ได้รับมอบหมาย
  const loadGrades = useCallback(async () => {
    const grades = await getMyAssignedGrades()
    setAssignedGrades(grades)
    setSelectedGrades(grades)
    return grades
  }, [])

  // โหลดคิว
  const loadQueue = useCallback(async (grades: ContractGrade[]) => {
    setLoading(true)
    try {
      const data = await getFreelancerQueue(grades)
      setRows(data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadGrades().then((grades) => {
      if (grades.length > 0) void loadQueue(grades)
      else setLoading(false)
    })
  }, [loadGrades, loadQueue])

  // สลับเกรดที่เลือก
  function toggleGrade(grade: ContractGrade) {
    setSelectedGrades((prev) => {
      const next = prev.includes(grade)
        ? prev.filter((g) => g !== grade)
        : [...prev, grade]
      void loadQueue(next)
      return next
    })
  }

  // ดึงรายการร้านไม่ซ้ำ
  const shopOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of rows) seen.set(r.shopId, r.shopName)
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [rows])

  // rows หลัง shop filter + search (ก่อนแตะ overdue) — ใช้เป็น base สำหรับ intersection
  const rowsBeforeOverdueFilter = useMemo(() => {
    let result = shopFilter ? rows.filter((r) => r.shopId === shopFilter) : rows
    const q = searchTerm.trim().toLowerCase()
    if (q) {
      const qPhone = stripPhone(q)
      result = result.filter(
        (r) =>
          r.customerName?.toLowerCase().includes(q) ||
          r.contractNo?.toLowerCase().includes(q) ||
          stripPhone(r.phone ?? '').includes(qPhone) ||
          stripPhone(r.phoneAlt1 ?? '').includes(qPhone) ||
          stripPhone(r.phoneAlt2 ?? '').includes(qPhone),
      )
    }
    return result
  }, [rows, shopFilter, searchTerm])

  // contractId ที่อยู่ในคิวจริง (หลัง shop+search, ก่อน overdue filter)
  const rowsInQueueIds = useMemo(
    () => new Set(rowsBeforeOverdueFilter.map((r) => r.contractId)),
    [rowsBeforeOverdueFilter],
  )

  // intersect: เฉพาะ overdue ที่อยู่ในคิวจริง (ตรงกับ role/scope/late-installment ของ getFreelancerQueue)
  const activeOverdueIds = useMemo(() => {
    const s = new Set<string>()
    overdueIdsAll.forEach((id) => { if (rowsInQueueIds.has(id)) s.add(id) })
    return s
  }, [overdueIdsAll, rowsInQueueIds])

  // ยอดรวม promise เฉพาะ overdue ที่อยู่ใน scope จริง
  const totalPromised = useMemo(
    () => overdue.filter((o) => activeOverdueIds.has(o.id)).reduce((s, o) => s + (o.promisedAmount ?? 0), 0),
    [overdue, activeOverdueIds],
  )

  // กรองตามร้าน + search term + overdue filter (universal — ใช้ก่อน split todayRows/pendingRows)
  const filtered = useMemo(() => {
    // overdueFilter ใช้ทั้ง 2 tabs — freelancer อาจอยากดูเฉพาะคนที่ผิดนัดทั้งใน "ที่ต้องโทร" และ "ติดต่อแล้ววันนี้"
    // guard: ถ้าไม่มี overdue ในคิวเลย ข้ามตัวกรองเพื่อป้องกัน empty list โดยไม่มีปุ่มล้าง
    if (overdueFilter && activeOverdueIds.size > 0) {
      return rowsBeforeOverdueFilter.filter((r) => activeOverdueIds.has(r.contractId))
    }
    return rowsBeforeOverdueFilter
  }, [rowsBeforeOverdueFilter, overdueFilter, activeOverdueIds])

  // แบ่ง 2 กลุ่ม: contacted today (Tab 2) vs ยังไม่ (Tab 1)
  const todayRows = useMemo(() => filtered.filter((r) => r.contactedToday), [filtered])
  const pendingRows = useMemo(() => filtered.filter((r) => !r.contactedToday), [filtered])

  // คำนวณ priority สำหรับ Tab 1 — memoized
  const today = useMemo(() => new Date(), [])
  const scoredRows = useMemo((): ScoredRow[] => {
    return pendingRows.map((r) => {
      const result = computePriorityScore(
        {
          grade: r.grade,
          outstanding: r.outstanding,
          daysLate: r.daysLate,
          dnc: r.dnc,
          lawyerEngaged: r.lawyerEngaged,
          disputed: r.disputed,
          promiseToPayDate: r.promiseToPayDate,
          totalAttempts: r.totalAttempts,
          successfulAttempts: r.successfulAttempts,
          lastResult: r.lastResult,
          lastContactedAt: r.lastContactedAt,
          contactedToday: r.contactedToday,
        },
        today,
      )
      return {
        row: r,
        score: result.score,
        tier: result.tier,
        actionableNow: result.actionableNow,
        suppressReason: result.suppressReason,
        promiseToPayDate: r.promiseToPayDate,
      }
    })
  }, [pendingRows, today])

  // today string (Bangkok UTC+7) สำหรับ sortQueue + promise badge
  const todayStr = useMemo(
    () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10),
    [],
  )

  // todayPlus7 สำหรับแบ่ง P2 boundary
  const todayPlus7Str = useMemo(() => {
    const d = new Date(`${todayStr}T00:00:00`)
    d.setDate(d.getDate() + 7)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }, [todayStr])

  // แบ่ง P1/P2/P3 และ tierGroups (จาก P3 เท่านั้น — ป้องกัน row ซ้ำใน P1/P2 section)
  const { p1Rows, p2Rows, tierGroups } = useMemo(() => {
    const sorted = sortQueue(scoredRows, todayStr)
    const p1: ScoredRow[] = []
    const p2: ScoredRow[] = []
    const p3: ScoredRow[] = []
    for (const sr of sorted) {
      const d = sr.promiseToPayDate
      if (d !== null && d < todayStr) p1.push(sr)
      else if (d !== null && d >= todayStr && d <= todayPlus7Str) p2.push(sr)
      else p3.push(sr)
    }
    const groups: Record<PriorityTier, ScoredRow[]> = {
      HOT: [],
      WARM: [],
      COLD: [],
      ESCALATE: [],
    }
    for (const sr of p3) {
      groups[sr.tier].push(sr)
    }
    return { p1Rows: p1, p2Rows: p2, tierGroups: groups }
  }, [scoredRows, todayStr, todayPlus7Str])

  // toggle checkbox ทีละรายการ
  function toggleSelectId(contractId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(contractId)) next.delete(contractId)
      else next.add(contractId)
      return next
    })
  }

  // toggle ทุก row ที่ actionableNow ใน tier นั้น
  function toggleSelectTier(group: ScoredRow[]) {
    const selectableIds = group
      .filter((sr) => sr.actionableNow)
      .map((sr) => sr.row.contractId)
    const allSelected = selectableIds.every((id) => selectedIds.has(id))
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allSelected) {
        selectableIds.forEach((id) => next.delete(id))
      } else {
        selectableIds.forEach((id) => next.add(id))
      }
      return next
    })
  }

  // ส่ง bulk no_answer
  async function handleBulkSubmit() {
    setBulkSubmitting(true)
    setShowBulkConfirm(false)
    let successCount = 0
    const failedNos: string[] = []
    for (const id of selectedIds) {
      try {
        await addFollowUp({
          contractId: id,
          contactMethod: 'phone',
          followUpResult: 'no_answer',
          phoneDialed: null,
          noteText: 'โทรไม่ติด (bulk)',
          promisedAmount: null,
          nextFollowUpAt: null,
        })
        successCount++
      } catch {
        const found = rows.find((r) => r.contractId === id)
        failedNos.push(found?.contractNo ?? id)
      }
    }
    setSelectedIds(new Set())
    setBulkSubmitting(false)
    setBulkResult({ success: successCount, failedNos })
    if (selectedGrades.length > 0) void loadQueue(selectedGrades)
  }

  // refresh ทั้งหมด
  function handleRefresh() {
    if (selectedGrades.length > 0) void loadQueue(selectedGrades)
  }

  // เปิด FollowUpModal: mark seen ก่อน แล้วค่อย set selected
  function handleOpenCase(r: FreelancerQueueRow) {
    void markCaseSeen(r.contractId)
    setSelectedContract(r)
  }

  // ปิด modal เฉยๆ — ไม่ reload (เปิด-ปิดโดยไม่บันทึก = ปิดทันที ไม่กระพริบ)
  function handleModalClose() {
    setSelectedContract(null)
  }

  return (
    <div>
      {/* Header + refresh */}
      <div className="mb-5 flex items-start justify-between gap-3">
        <PageTitle sub="รายการลูกค้าที่ต้องติดตามตามเกรดที่ได้รับมอบหมาย" count={loading ? undefined : { shown: filtered.length, total: rows.length }}>
          คิวติดตามหนี้ — ผู้ติดตามหนี้
        </PageTitle>
        <button
          onClick={handleRefresh}
          className="mt-1 flex shrink-0 items-center gap-1.5 rounded-xl border border-peach bg-white px-3 py-2 text-sm font-medium text-ink transition hover:bg-peach-light/50"
          title="โหลดข้อมูลใหม่"
        >
          🔄 รีเฟรช
        </button>
      </div>

      {/* banner นอกเวลา */}
      {outsideHours && <OutsideHoursBanner />}

      {/* search box */}
      <div className="mb-4 max-w-sm">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="ค้นหา ชื่อลูกค้า / เลขสัญญา / เบอร์โทร"
            className="w-full rounded-xl border border-peach bg-white py-2 pl-9 pr-3 text-sm text-ink outline-none transition focus:border-salmon-deep"
          />
        </div>
      </div>

      {/* grade filter chips */}
      {assignedGrades.length > 0 && (
        <Card className="mb-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink">เกรด:</span>
            {assignedGrades.map((grade) => {
              const active = selectedGrades.includes(grade)
              return (
                <button
                  key={grade}
                  onClick={() => toggleGrade(grade)}
                  className={`rounded-full border px-4 py-1.5 text-sm font-semibold transition ${
                    active
                      ? 'border-salmon-deep bg-salmon-deep text-white shadow-sm'
                      : 'border-peach bg-white text-ink-soft hover:bg-peach-light'
                  }`}
                >
                  เกรด {grade}
                </button>
              )
            })}

            {/* shop filter */}
            {shopOptions.length > 1 && (
              <select
                value={shopFilter}
                onChange={(e) => setShopFilter(e.target.value)}
                className="ml-2 rounded-xl border border-peach bg-white px-3 py-1.5 text-sm text-ink outline-none transition focus:border-salmon-deep"
              >
                <option value="">ทุกร้าน</option>
                {shopOptions.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </Card>
      )}

      {/* เนื้อหาหลัก */}
      {loading ? (
        <Loading />
      ) : assignedGrades.length === 0 ? (
        <EmptyState
          title="ยังไม่ได้รับมอบหมายเกรด"
          hint="กรุณาติดต่อผู้ดูแลระบบเพื่อรับมอบหมายเกรดการติดตามหนี้"
        />
      ) : (
        <>
          {/* === Overdue promise badge === */}
          {activeOverdueIds.size > 0 && (
            <div className="mb-4 flex items-center gap-2">
              <button
                onClick={() => setOverdueFilter((v) => !v)}
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-semibold transition ${
                  overdueFilter
                    ? 'border-red-700 bg-red-600 text-white'
                    : 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
                }`}
              >
                <AlarmClock size={16} />
                ผิดนัด: {activeOverdueIds.size} รายการ
                {totalPromised > 0 && (
                  <span>· รวม {baht(totalPromised)} ฿</span>
                )}
              </button>
              {overdueFilter && (
                <button
                  onClick={() => setOverdueFilter(false)}
                  className="rounded-full border border-peach bg-white px-2.5 py-1 text-xs text-ink-soft transition hover:bg-peach-light"
                >
                  ✕ ยกเลิกตัวกรอง
                </button>
              )}
            </div>
          )}

          {/* === Tab bar === */}
          <div className="mb-4 flex gap-2">
            <button
              onClick={() => setActiveTab('todo')}
              className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
                activeTab === 'todo'
                  ? 'bg-salmon-deep text-white'
                  : 'border border-peach bg-white text-ink-soft hover:bg-peach-light'
              }`}
            >
              🎯 ที่ต้องโทร ({pendingRows.length})
            </button>
            <button
              onClick={() => setActiveTab('done')}
              className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
                activeTab === 'done'
                  ? 'bg-salmon-deep text-white'
                  : 'border border-peach bg-white text-ink-soft hover:bg-peach-light'
              }`}
            >
              ✅ ติดต่อแล้ววันนี้ ({todayRows.length})
            </button>
          </div>

          {/* === Tab 1: ที่ต้องโทร === */}
          {activeTab === 'todo' && (
            <>
              {pendingRows.length === 0 ? (
                searchTerm.trim() ? (
                  <EmptyState
                    title="ไม่พบลูกค้าที่ค้นหา"
                    hint="ลองเปลี่ยนคำค้นหา หรือล้างช่องค้นหาเพื่อดูทั้งหมด"
                  />
                ) : (
                  <EmptyState
                    title="ยังไม่มีลูกค้าที่ต้องตามในเกรดที่ได้รับมอบหมาย"
                    hint="เมื่อมีลูกค้าค้างชำระในเกรดของคุณ จะปรากฏที่นี่"
                  />
                )
              ) : (
                <div className="flex flex-col gap-3">
                  {/* === P1: นัดจ่ายเลยกำหนด === */}
                  {p1Rows.length > 0 && (
                    <div className="overflow-hidden rounded-2xl border border-red-200 bg-white shadow-sm">
                      <div className="flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-red-700">
                        <span className="inline-block rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-semibold text-red-700">
                          📅 นัดจ่าย – เลยกำหนด ({p1Rows.length})
                        </span>
                      </div>
                      {/* Desktop */}
                      <div className="hidden overflow-x-auto md:block">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-peach bg-cream-deep text-left text-xs font-semibold text-ink-soft">
                              <th className="px-3 py-3 text-center" />
                              <th className="px-4 py-3">ลูกค้า</th>
                              <th className="px-4 py-3">ร้าน</th>
                              <th className="px-4 py-3 text-center">เกรด</th>
                              <th className="px-4 py-3 text-center">คะแนน</th>
                              <th className="px-4 py-3 text-right">ค้าง (วัน)</th>
                              <th className="px-4 py-3 text-right">งวด</th>
                              <th className="px-4 py-3 text-right">ค่างวด / ค่าปรับ</th>
                              <th className="px-4 py-3 text-right">เงินต้นค้าง</th>
                              <th className="px-4 py-3" />
                            </tr>
                          </thead>
                          <tbody>
                            {p1Rows.map((sr) => (
                              <QueueRow
                                key={sr.row.contractId}
                                sr={sr}
                                outsideHours={outsideHours}
                                onSelect={handleOpenCase}
                                selected={selectedIds.has(sr.row.contractId)}
                                onToggleSelect={toggleSelectId}
                              />
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {/* Mobile */}
                      <div className="flex flex-col divide-y divide-peach/60 md:hidden">
                        {p1Rows.map((sr) => {
                          const r = sr.row
                          const isBlocked = r.dnc || r.lawyerEngaged
                          const disableButton = outsideHours || !sr.actionableNow
                          const tStr = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10)
                          const pOverdue = r.promiseToPayDate !== null && r.promiseToPayDate < tStr
                          const [, pMo, pDy] = r.promiseToPayDate ? r.promiseToPayDate.split('-') : [null, null, null]
                          let tip = ''
                          if (outsideHours) tip = 'นอกเวลาทวงถามตามกฎหมาย'
                          else if (sr.suppressReason) tip = SUPPRESS_LABEL[sr.suppressReason]
                          return (
                            <div key={r.contractId} className={`p-4 ${selectedIds.has(r.contractId) ? 'bg-peach-light/40' : ''}`}>
                              <div className="mb-1 flex items-start gap-2">
                                <input type="checkbox" checked={selectedIds.has(r.contractId)} disabled={!sr.actionableNow} onChange={() => toggleSelectId(r.contractId)} className="mt-0.5 h-4 w-4 cursor-pointer accent-salmon-deep disabled:cursor-not-allowed disabled:opacity-40" />
                                <div className="flex-1 min-w-0">
                                  {hasUnseenUpdate(r.myLastTouchAt, r.latestOtherAuthorAt) && (
                                    <div className="mb-1"><span className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">🔔 มีอัปเดตใหม่</span></div>
                                  )}
                                  {(r.dnc || r.lawyerEngaged || r.disputed) && (
                                    <div className="mb-1 flex flex-wrap gap-1">
                                      {r.dnc && <Badge tone="red">⛔ ห้ามติดต่อ</Badge>}
                                      {r.lawyerEngaged && !r.dnc && <Badge tone="amber">⚖️ ทนายความ</Badge>}
                                      {r.disputed && <Badge tone="amber">📋 โต้แย้ง</Badge>}
                                    </div>
                                  )}
                                  <p className={`font-semibold leading-tight ${isBlocked ? 'text-ink-soft' : 'text-ink'}`}>{r.customerName}</p>
                                  <p className="text-xs text-ink-soft">{r.contractNo} · {r.shopName}</p>
                                  {r.deviceModel && <p className="text-xs text-ink-soft">📱 {r.deviceModel}</p>}
                                  {r.phone && <p className="text-xs text-ink-soft">{r.phone}</p>}
                                  {(r.phoneAlt1 || r.phoneAlt2) && <p className="text-xs text-ink-soft">📞 สำรอง: {[r.phoneAlt1, r.phoneAlt2].filter(Boolean).join(', ')}</p>}
                                  {r.lastResult !== null && r.lastContactedAt !== null && (
                                    <p className="mt-0.5 text-xs text-ink-soft">🕐 {r.lastContactedByName ?? '?'} {relativeContactTime(r.lastContactedAt)} — {RESULT_LABEL[r.lastResult]}</p>
                                  )}
                                  {r.latestNote && <p className="mt-0.5 text-xs text-ink-soft">💬 {r.latestNote.length > 40 ? r.latestNote.slice(0, 40) + '…' : r.latestNote}</p>}
                                  {r.promiseToPayDate !== null && pDy !== null && pMo !== null && (
                                    <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${pOverdue ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>📅 สัญญาจะจ่าย {pDy}/{pMo}</span>
                                  )}
                                </div>
                                <span className={`shrink-0 self-start rounded-full px-2.5 py-0.5 text-xs font-semibold ${TIER_SCORE_CLS[sr.tier]}`}>{TIER_EMOJI[sr.tier]} {sr.score}</span>
                              </div>
                              <div className="mb-3 mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
                                <span>เกรด <Badge tone={GRADE_TONE[r.grade]}>{r.grade}</Badge></span>
                                <span>ค้าง <span className="font-semibold text-red-600">{r.daysLate} วัน</span></span>
                                {r.installmentsTotal > 0 && <span>งวด {r.installmentsPaid}/{r.installmentsTotal}</span>}
                                <span>ค่างวด {baht(r.monthlyPayment)} ฿</span>
                                {r.outstanding > 0 && <span className="font-semibold text-red-600">ค่าปรับ {baht(r.outstanding)} ฿</span>}
                                {r.principalDue > 0 && <span className="font-semibold text-red-600">เงินต้นค้าง {baht(r.principalDue)} ฿</span>}
                              </div>
                              <button disabled={disableButton} onClick={() => !disableButton && handleOpenCase(r)} title={tip || undefined} className={`w-full rounded-xl border px-3 py-2 text-sm font-semibold transition ${disableButton ? 'cursor-not-allowed border-peach bg-peach-light/40 text-ink-soft opacity-60' : 'border-peach bg-white text-ink hover:bg-peach-light/50'}`}>บันทึกติดตาม</button>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* === P2: นัดจ่ายใกล้ถึง (ภายใน 7 วัน) === */}
                  {p2Rows.length > 0 && (
                    <div className="overflow-hidden rounded-2xl border border-amber-200 bg-white shadow-sm">
                      <div className="flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-amber-700">
                        <span className="inline-block rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
                          📅 นัดจ่าย – ใกล้ถึง (ภายใน 7 วัน) ({p2Rows.length})
                        </span>
                      </div>
                      {/* Desktop */}
                      <div className="hidden overflow-x-auto md:block">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-peach bg-cream-deep text-left text-xs font-semibold text-ink-soft">
                              <th className="px-3 py-3 text-center" />
                              <th className="px-4 py-3">ลูกค้า</th>
                              <th className="px-4 py-3">ร้าน</th>
                              <th className="px-4 py-3 text-center">เกรด</th>
                              <th className="px-4 py-3 text-center">คะแนน</th>
                              <th className="px-4 py-3 text-right">ค้าง (วัน)</th>
                              <th className="px-4 py-3 text-right">งวด</th>
                              <th className="px-4 py-3 text-right">ค่างวด / ค่าปรับ</th>
                              <th className="px-4 py-3 text-right">เงินต้นค้าง</th>
                              <th className="px-4 py-3" />
                            </tr>
                          </thead>
                          <tbody>
                            {p2Rows.map((sr) => (
                              <QueueRow
                                key={sr.row.contractId}
                                sr={sr}
                                outsideHours={outsideHours}
                                onSelect={handleOpenCase}
                                selected={selectedIds.has(sr.row.contractId)}
                                onToggleSelect={toggleSelectId}
                              />
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {/* Mobile */}
                      <div className="flex flex-col divide-y divide-peach/60 md:hidden">
                        {p2Rows.map((sr) => {
                          const r = sr.row
                          const isBlocked = r.dnc || r.lawyerEngaged
                          const disableButton = outsideHours || !sr.actionableNow
                          const tStr = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10)
                          const pOverdue = r.promiseToPayDate !== null && r.promiseToPayDate < tStr
                          const [, pMo, pDy] = r.promiseToPayDate ? r.promiseToPayDate.split('-') : [null, null, null]
                          let tip = ''
                          if (outsideHours) tip = 'นอกเวลาทวงถามตามกฎหมาย'
                          else if (sr.suppressReason) tip = SUPPRESS_LABEL[sr.suppressReason]
                          return (
                            <div key={r.contractId} className={`p-4 ${selectedIds.has(r.contractId) ? 'bg-peach-light/40' : ''}`}>
                              <div className="mb-1 flex items-start gap-2">
                                <input type="checkbox" checked={selectedIds.has(r.contractId)} disabled={!sr.actionableNow} onChange={() => toggleSelectId(r.contractId)} className="mt-0.5 h-4 w-4 cursor-pointer accent-salmon-deep disabled:cursor-not-allowed disabled:opacity-40" />
                                <div className="flex-1 min-w-0">
                                  {hasUnseenUpdate(r.myLastTouchAt, r.latestOtherAuthorAt) && (
                                    <div className="mb-1"><span className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">🔔 มีอัปเดตใหม่</span></div>
                                  )}
                                  {(r.dnc || r.lawyerEngaged || r.disputed) && (
                                    <div className="mb-1 flex flex-wrap gap-1">
                                      {r.dnc && <Badge tone="red">⛔ ห้ามติดต่อ</Badge>}
                                      {r.lawyerEngaged && !r.dnc && <Badge tone="amber">⚖️ ทนายความ</Badge>}
                                      {r.disputed && <Badge tone="amber">📋 โต้แย้ง</Badge>}
                                    </div>
                                  )}
                                  <p className={`font-semibold leading-tight ${isBlocked ? 'text-ink-soft' : 'text-ink'}`}>{r.customerName}</p>
                                  <p className="text-xs text-ink-soft">{r.contractNo} · {r.shopName}</p>
                                  {r.deviceModel && <p className="text-xs text-ink-soft">📱 {r.deviceModel}</p>}
                                  {r.phone && <p className="text-xs text-ink-soft">{r.phone}</p>}
                                  {(r.phoneAlt1 || r.phoneAlt2) && <p className="text-xs text-ink-soft">📞 สำรอง: {[r.phoneAlt1, r.phoneAlt2].filter(Boolean).join(', ')}</p>}
                                  {r.lastResult !== null && r.lastContactedAt !== null && (
                                    <p className="mt-0.5 text-xs text-ink-soft">🕐 {r.lastContactedByName ?? '?'} {relativeContactTime(r.lastContactedAt)} — {RESULT_LABEL[r.lastResult]}</p>
                                  )}
                                  {r.latestNote && <p className="mt-0.5 text-xs text-ink-soft">💬 {r.latestNote.length > 40 ? r.latestNote.slice(0, 40) + '…' : r.latestNote}</p>}
                                  {r.promiseToPayDate !== null && pDy !== null && pMo !== null && (
                                    <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${pOverdue ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>📅 สัญญาจะจ่าย {pDy}/{pMo}</span>
                                  )}
                                </div>
                                <span className={`shrink-0 self-start rounded-full px-2.5 py-0.5 text-xs font-semibold ${TIER_SCORE_CLS[sr.tier]}`}>{TIER_EMOJI[sr.tier]} {sr.score}</span>
                              </div>
                              <div className="mb-3 mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
                                <span>เกรด <Badge tone={GRADE_TONE[r.grade]}>{r.grade}</Badge></span>
                                <span>ค้าง <span className="font-semibold text-red-600">{r.daysLate} วัน</span></span>
                                {r.installmentsTotal > 0 && <span>งวด {r.installmentsPaid}/{r.installmentsTotal}</span>}
                                <span>ค่างวด {baht(r.monthlyPayment)} ฿</span>
                                {r.outstanding > 0 && <span className="font-semibold text-red-600">ค่าปรับ {baht(r.outstanding)} ฿</span>}
                                {r.principalDue > 0 && <span className="font-semibold text-red-600">เงินต้นค้าง {baht(r.principalDue)} ฿</span>}
                              </div>
                              <button disabled={disableButton} onClick={() => !disableButton && handleOpenCase(r)} title={tip || undefined} className={`w-full rounded-xl border px-3 py-2 text-sm font-semibold transition ${disableButton ? 'cursor-not-allowed border-peach bg-peach-light/40 text-ink-soft opacity-60' : 'border-peach bg-white text-ink hover:bg-peach-light/50'}`}>บันทึกติดตาม</button>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* === P3: tier sections (ที่เหลือ ไม่มี promise หรือ promise > 7 วัน) === */}
                  {TIER_ORDER.map((tier) => {
                    const group = tierGroups[tier]
                    if (group.length === 0) return null
                    const open = sectionOpen[tier]
                    return (
                      <div
                        key={tier}
                        className="overflow-hidden rounded-2xl border border-peach bg-white shadow-sm"
                      >
                        <SectionHeader
                          tier={tier}
                          count={group.length}
                          open={open}
                          onToggle={() => toggleSection(tier)}
                        />
                        {open && (
                          <>
                            {/* ===== Desktop table (≥ md) ===== */}
                            <div className="hidden overflow-x-auto md:block">
                              <table className="w-full text-sm">
                                <thead>
                                  <tr className="border-b border-peach bg-cream-deep text-left text-xs font-semibold text-ink-soft">
                                    <th className="px-3 py-3 text-center">
                                      {/* per-section select-all */}
                                      {(() => {
                                        const selectableIds = group
                                          .filter((sr) => sr.actionableNow)
                                          .map((sr) => sr.row.contractId)
                                        const allSelected =
                                          selectableIds.length > 0 &&
                                          selectableIds.every((id) => selectedIds.has(id))
                                        return (
                                          <input
                                            type="checkbox"
                                            checked={allSelected}
                                            disabled={selectableIds.length === 0}
                                            onChange={() => toggleSelectTier(group)}
                                            title="เลือกทั้งหมดในส่วนนี้"
                                            className="h-4 w-4 cursor-pointer accent-salmon-deep disabled:cursor-not-allowed disabled:opacity-40"
                                          />
                                        )
                                      })()}
                                    </th>
                                    <th className="px-4 py-3">ลูกค้า</th>
                                    <th className="px-4 py-3">ร้าน</th>
                                    <th className="px-4 py-3 text-center">เกรด</th>
                                    <th className="px-4 py-3 text-center">คะแนน</th>
                                    <th className="px-4 py-3 text-right">ค้าง (วัน)</th>
                                    <th className="px-4 py-3 text-right">งวด</th>
                                    <th className="px-4 py-3 text-right">ค่างวด / ค่าปรับ</th>
                                    <th className="px-4 py-3 text-right">เงินต้นค้าง</th>
                                    <th className="px-4 py-3" />
                                  </tr>
                                </thead>
                                <tbody>
                                  {group.map((sr) => (
                                    <QueueRow
                                      key={sr.row.contractId}
                                      sr={sr}
                                      outsideHours={outsideHours}
                                      onSelect={handleOpenCase}
                                      selected={selectedIds.has(sr.row.contractId)}
                                      onToggleSelect={toggleSelectId}
                                    />
                                  ))}
                                </tbody>
                              </table>
                            </div>

                            {/* ===== Mobile card stack (< md) ===== */}
                            <div className="flex flex-col divide-y divide-peach/60 md:hidden">
                              {group.map((sr) => {
                                const r = sr.row
                                const isBlocked = r.dnc || r.lawyerEngaged
                                const disableButton = outsideHours || !sr.actionableNow
                                const todayPart = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10)
                                const promiseOverdue = r.promiseToPayDate !== null && r.promiseToPayDate < todayPart
                                const [, pMonth, pDay] = r.promiseToPayDate ? r.promiseToPayDate.split('-') : [null, null, null]
                                let tooltip = ''
                                if (outsideHours) tooltip = 'นอกเวลาทวงถามตามกฎหมาย'
                                else if (sr.suppressReason) tooltip = SUPPRESS_LABEL[sr.suppressReason]
                                return (
                                  <div
                                    key={r.contractId}
                                    className={`p-4 ${selectedIds.has(r.contractId) ? 'bg-peach-light/40' : ''}`}
                                  >
                                    {/* บรรทัด 1: checkbox + ชื่อ + tier badge */}
                                    <div className="mb-1 flex items-start gap-2">
                                      <input
                                        type="checkbox"
                                        checked={selectedIds.has(r.contractId)}
                                        disabled={!sr.actionableNow}
                                        onChange={() => toggleSelectId(r.contractId)}
                                        className="mt-0.5 h-4 w-4 cursor-pointer accent-salmon-deep disabled:cursor-not-allowed disabled:opacity-40"
                                      />
                                      <div className="flex-1 min-w-0">
                                        {/* unseen update badge */}
                                        {hasUnseenUpdate(r.myLastTouchAt, r.latestOtherAuthorAt) && (
                                          <div className="mb-1">
                                            <span className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                                              🔔 มีอัปเดตใหม่
                                            </span>
                                          </div>
                                        )}
                                        {/* status flags */}
                                        {(r.dnc || r.lawyerEngaged || r.disputed) && (
                                          <div className="mb-1 flex flex-wrap gap-1">
                                            {r.dnc && <Badge tone="red">⛔ ห้ามติดต่อ</Badge>}
                                            {r.lawyerEngaged && !r.dnc && <Badge tone="amber">⚖️ ทนายความ</Badge>}
                                            {r.disputed && <Badge tone="amber">📋 โต้แย้ง</Badge>}
                                          </div>
                                        )}
                                        <p className={`font-semibold leading-tight ${isBlocked ? 'text-ink-soft' : 'text-ink'}`}>
                                          {r.customerName}
                                        </p>
                                        <p className="text-xs text-ink-soft">{r.contractNo} · {r.shopName}</p>
                                        {r.deviceModel && <p className="text-xs text-ink-soft">📱 {r.deviceModel}</p>}
                                        {r.phone && <p className="text-xs text-ink-soft">{r.phone}</p>}
                                        {(r.phoneAlt1 || r.phoneAlt2) && (
                                          <p className="text-xs text-ink-soft">
                                            📞 สำรอง: {[r.phoneAlt1, r.phoneAlt2].filter(Boolean).join(', ')}
                                          </p>
                                        )}
                                        {r.lastResult !== null && r.lastContactedAt !== null && (
                                          <p className="mt-0.5 text-xs text-ink-soft">
                                            🕐 {r.lastContactedByName ?? '?'} {relativeContactTime(r.lastContactedAt)} — {RESULT_LABEL[r.lastResult]}
                                          </p>
                                        )}
                                        {r.latestNote && (
                                          <p className="mt-0.5 text-xs text-ink-soft">
                                            💬 {r.latestNote.length > 40 ? r.latestNote.slice(0, 40) + '…' : r.latestNote}
                                          </p>
                                        )}
                                        {r.promiseToPayDate !== null && pDay !== null && pMonth !== null && (
                                          <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${promiseOverdue ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                                            📅 สัญญาจะจ่าย {pDay}/{pMonth}
                                          </span>
                                        )}
                                      </div>
                                      {/* tier + score */}
                                      <span className={`shrink-0 self-start rounded-full px-2.5 py-0.5 text-xs font-semibold ${TIER_SCORE_CLS[sr.tier]}`}>
                                        {TIER_EMOJI[sr.tier]} {sr.score}
                                      </span>
                                    </div>
                                    {/* บรรทัด 2: ตัวเลข */}
                                    <div className="mb-3 mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
                                      <span>เกรด <Badge tone={GRADE_TONE[r.grade]}>{r.grade}</Badge></span>
                                      <span>ค้าง <span className="font-semibold text-red-600">{r.daysLate} วัน</span></span>
                                      {r.installmentsTotal > 0 && <span>งวด {r.installmentsPaid}/{r.installmentsTotal}</span>}
                                      <span>ค่างวด {baht(r.monthlyPayment)} ฿</span>
                                      {r.outstanding > 0 && <span className="font-semibold text-red-600">ค่าปรับ {baht(r.outstanding)} ฿</span>}
                                      {r.principalDue > 0 && <span className="font-semibold text-red-600">เงินต้นค้าง {baht(r.principalDue)} ฿</span>}
                                    </div>
                                    {/* ปุ่มบันทึก */}
                                    <button
                                      disabled={disableButton}
                                      onClick={() => !disableButton && handleOpenCase(r)}
                                      title={tooltip || undefined}
                                      className={`w-full rounded-xl border px-3 py-2 text-sm font-semibold transition ${
                                        disableButton
                                          ? 'cursor-not-allowed border-peach bg-peach-light/40 text-ink-soft opacity-60'
                                          : 'border-peach bg-white text-ink hover:bg-peach-light/50'
                                      }`}
                                    >
                                      บันทึกติดตาม
                                    </button>
                                  </div>
                                )
                              })}
                            </div>
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}

          {/* === Tab 2: ติดต่อแล้ววันนี้ === */}
          {activeTab === 'done' && (
            <>
              {todayRows.length === 0 ? (
                searchTerm.trim() ? (
                  <EmptyState
                    title="ไม่พบลูกค้าที่ค้นหา"
                    hint="ลองเปลี่ยนคำค้นหา หรือล้างช่องค้นหาเพื่อดูทั้งหมด"
                  />
                ) : (
                  <EmptyState
                    title="ยังไม่มีรายการที่ติดต่อวันนี้"
                    hint="เมื่อบันทึกติดตามสำเร็จแล้ว รายการจะย้ายมาที่นี่"
                  />
                )
              ) : (
                <>
                  {/* ===== Desktop table (≥ md) ===== */}
                  <div className="hidden overflow-x-auto rounded-2xl border border-peach bg-white shadow-sm md:block">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-peach bg-cream-deep text-left text-xs font-semibold text-ink-soft">
                          <th className="px-4 py-3">ลูกค้า / สัญญา</th>
                          <th className="px-4 py-3 text-center">เกรด</th>
                          <th className="px-4 py-3">ผลล่าสุด</th>
                          <th className="px-4 py-3">เวลา</th>
                          <th className="px-4 py-3">โดย</th>
                        </tr>
                      </thead>
                      <tbody>
                        {todayRows.map((r) => (
                          <tr
                            key={r.contractId}
                            className="border-b border-peach last:border-0 hover:bg-peach-light/20"
                          >
                            <td className="px-4 py-3">
                              <p className="font-medium text-ink">{r.customerName}</p>
                              <p className="text-xs text-ink-soft">{r.contractNo}</p>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <Badge tone={GRADE_TONE[r.grade]}>เกรด {r.grade}</Badge>
                            </td>
                            <td className="px-4 py-3 text-ink-soft">
                              {r.lastResult !== null ? RESULT_LABEL[r.lastResult] : '-'}
                            </td>
                            <td className="px-4 py-3 text-ink-soft">
                              {r.lastContactedAt !== null
                                ? relativeContactTime(r.lastContactedAt)
                                : '-'}
                            </td>
                            <td className="px-4 py-3 text-ink-soft">
                              {r.lastContactedByName ?? '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="px-4 py-2 text-xs text-ink-soft">
                      แสดง {todayRows.length} รายการที่ติดต่อวันนี้
                    </p>
                  </div>

                  {/* ===== Mobile card stack (< md) ===== */}
                  <div className="flex flex-col gap-3 md:hidden">
                    {todayRows.map((r) => (
                      <div
                        key={r.contractId}
                        className="rounded-2xl border border-peach bg-white p-4 shadow-sm"
                      >
                        <div className="mb-1 flex items-start justify-between gap-2">
                          <div>
                            <p className="font-semibold text-ink">{r.customerName}</p>
                            <p className="text-xs text-ink-soft">{r.contractNo}</p>
                          </div>
                          <Badge tone={GRADE_TONE[r.grade]}>เกรด {r.grade}</Badge>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-ink-soft">
                          <span>ผล: <span className="text-ink">{r.lastResult !== null ? RESULT_LABEL[r.lastResult] : '-'}</span></span>
                          <span>เวลา: {r.lastContactedAt !== null ? relativeContactTime(r.lastContactedAt) : '-'}</span>
                          <span>โดย: {r.lastContactedByName ?? '-'}</span>
                        </div>
                      </div>
                    ))}
                    <p className="text-xs text-ink-soft">แสดง {todayRows.length} รายการที่ติดต่อวันนี้</p>
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}

      {/* === Floating bulk action bar === */}
      {activeTab === 'todo' && selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2">
          <div className="flex items-center gap-3 rounded-2xl border border-peach bg-white px-5 py-3 shadow-xl">
            <span className="text-sm font-semibold text-ink">
              เลือก {selectedIds.size} ลูกค้า
            </span>
            <Button
              variant="primary"
              disabled={outsideHours || bulkSubmitting}
              onClick={() => setShowBulkConfirm(true)}
              title={outsideHours ? 'นอกเวลาทวงถามตามกฎหมาย' : undefined}
            >
              {bulkSubmitting ? (
                <>
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                  กำลังบันทึก...
                </>
              ) : (
                'ทำเครื่องหมายว่าโทรไม่ติด'
              )}
            </Button>
            <Button
              variant="ghost"
              disabled={bulkSubmitting}
              onClick={() => setSelectedIds(new Set())}
            >
              ยกเลิก
            </Button>
          </div>
        </div>
      )}

      {/* === Bulk confirm modal === */}
      {showBulkConfirm && (
        <Modal title="ยืนยันการบันทึก" onClose={() => setShowBulkConfirm(false)}>
          <p className="mb-5 text-sm text-ink">
            ทำเครื่องหมาย <span className="font-semibold">{selectedIds.size} รายการ</span> ว่า
            &ldquo;โทรไม่ติด&rdquo; — ลูกค้าทั้งหมดที่เลือกจะถูกบันทึกในประวัติการติดต่อ
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowBulkConfirm(false)}>
              ยกเลิก
            </Button>
            <Button variant="primary" onClick={() => void handleBulkSubmit()}>
              ยืนยัน
            </Button>
          </div>
        </Modal>
      )}

      {/* === Bulk result modal === */}
      {bulkResult !== null && (
        <Modal title="ผลการบันทึก" onClose={() => setBulkResult(null)}>
          <p className="mb-2 text-sm text-ink">
            บันทึกสำเร็จ{' '}
            <span className="font-semibold text-green-600">{bulkResult.success} รายการ</span>
            {bulkResult.failedNos.length > 0 && (
              <>
                {' '}ล้มเหลว{' '}
                <span className="font-semibold text-red-600">{bulkResult.failedNos.length} รายการ</span>
              </>
            )}
          </p>
          {bulkResult.failedNos.length > 0 && (
            <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <p className="mb-1 font-semibold">สัญญาที่บันทึกไม่สำเร็จ:</p>
              <p>{bulkResult.failedNos.join(', ')}</p>
            </div>
          )}
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => setBulkResult(null)}>
              ปิด
            </Button>
          </div>
        </Modal>
      )}

      {/* modal */}
      {selectedContract && (
        <FollowUpModal
          contract={{
            contractId: selectedContract.contractId,
            contractNo: selectedContract.contractNo,
            customerName: selectedContract.customerName,
            phone: selectedContract.phone,
            shopName: selectedContract.shopName,
            daysLate: selectedContract.daysLate,
            deviceModel: selectedContract.deviceModel,
            phoneAlt1: selectedContract.phoneAlt1,
            phoneAlt2: selectedContract.phoneAlt2,
            installmentsPaid: selectedContract.installmentsPaid,
            installmentsTotal: selectedContract.installmentsTotal,
            penaltyDue: selectedContract.outstanding,
            principalDue: selectedContract.principalDue,
          }}
          publicHolidays={publicHolidays}
          adminOverride={role === 'admin'}
          onClose={handleModalClose}
          onSaved={() => {
            if (selectedGrades.length > 0) void loadQueue(selectedGrades)
          }}
        />
      )}
    </div>
  )
}
