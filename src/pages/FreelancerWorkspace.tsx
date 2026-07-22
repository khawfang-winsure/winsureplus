import { useCallback, useEffect, useMemo, useState } from 'react'
import { useFilter } from '../lib/useFilter'
import { AlarmClock, AlertTriangle, CalendarClock, ChevronRight, PackageCheck, Search, UserCheck, Users } from 'lucide-react'
import { Badge, Card, EmptyState, Loading, PageTitle } from '../components/ui'
import Pagination from '../components/Pagination'
import { baht, thaiDate } from '../lib/format'
import {
  claimCase,
  getCaseOwnershipSummary,
  getFreelancerQueue,
  getFreelancerQueueRow,
  getMyAssignedGrades,
  getMyCases,
  getOverduePromiseContracts,
  getPublicHolidays,
  markCaseSeen,
  releaseCase,
  type ContractGrade,
  type FollowUpResult,
  type FreelancerQueueRow,
} from '../lib/db'
import type { OverduePromiseContract } from '../lib/types'
import { useAuth } from '../lib/auth'
import { isContactWindowOpen } from '../lib/contactHours'
import {
  computePriorityScore,
  followUpStalenessLevel,
  getPromiseDateStatus,
  hasUnseenUpdate,
  isHardBlocked,
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

// strip dashes/spaces จากเบอร์โทรเพื่อเทียบแบบ normalize
function stripPhone(p: string): string {
  return p.replace(/[\s-]/g, '')
}

// ===== โหมดเรียงลำดับแท็บ "ที่ต้องโทร" =====
type SortMode = 'priority' | 'daysLateAsc' | 'daysLateDesc'
const SORT_MODE_LABEL: Record<SortMode, string> = {
  priority: 'ตามความเร่งด่วน',
  daysLateAsc: 'วันค้างน้อย→มาก',
  daysLateDesc: 'วันค้างมาก→น้อย',
}

// นับวันจาก anchorDate (Bangkok) — วันเดียวกับ anchor = วันที่ 1, เมื่อวาน = วันที่ 2
// todayBkk และ anchorDate ต้องเป็น yyyy-mm-dd (Bangkok date ทั้งคู่)
function daysSinceAnchor(anchorDate: string, todayBkk: string): number {
  const [ty, tm, td] = todayBkk.split('-').map(Number)
  const [ry, rm, rd] = anchorDate.split('-').map(Number)
  const todayMs = Date.UTC(ty, tm - 1, td)
  const anchorMs = Date.UTC(ry, rm - 1, rd)
  return Math.max(1, Math.floor((todayMs - anchorMs) / 86400000) + 1)
}

// ===== Pete: เคส "เลยนัด"/"ถึงนัดวันนี้" ต้องปักหมุดบนสุดเสมอ แม้เรียงตามวันค้าง (sortMode=daysLateAsc/Desc) =====
// priorityQueue.ts เป็น pure lib ห้ามแตะ (ต้องส่งแบม) → ทำ logic ปักหมุดตรงนี้ในหน้า component แทน
// reuse getPromiseDateStatus (pure fn มีอยู่แล้ว) เพื่อแยกกลุ่มก่อน sort ภายในกลุ่มที่เหลือด้วย compareFn ที่ส่งเข้ามา
function pinDuePromise(
  rowsIn: ScoredRow[],
  todayStr: string,
  compareFn: (a: ScoredRow, b: ScoredRow) => number,
): ScoredRow[] {
  const pinned: ScoredRow[] = []
  const rest: ScoredRow[] = []
  for (const sr of rowsIn) {
    const { status } = getPromiseDateStatus(sr.row.promiseToPayDate, todayStr)
    if (status === 'overdue' || status === 'due_today') pinned.push(sr)
    else rest.push(sr)
  }
  // ภายในกลุ่มปักหมุด: เลยนัดนานสุดก่อน (เหมือน group P1 ของ sortQueue) — promiseToPayDate ASC (null ไปท้ายกลุ่มปักหมุด)
  pinned.sort((a, b) => {
    const da = a.row.promiseToPayDate ?? ''
    const db = b.row.promiseToPayDate ?? ''
    return da < db ? -1 : da > db ? 1 : 0
  })
  rest.sort(compareFn)
  return [...pinned, ...rest]
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

// ===== ป้ายวันนัดชำระ — รวม 1 ป้าย (เดิมมี 2 ป้ายซ้อนกัน: ข้อความ "สัญญาจะจ่าย dd/mm" + ป้ายเตือน overdue/today/tomorrow) =====
// ใช้ getPromiseDateStatus (pure fn) → เลือกโทนสีตามความเร่งด่วน; upcoming (ยังไม่ใกล้) → ป้ายกลางเฉยๆ ไม่ใช้สีเตือน
function PromiseBadge({ promiseToPayDate }: { promiseToPayDate: string | null }) {
  if (!promiseToPayDate) return null
  const { status, days } = getPromiseDateStatus(promiseToPayDate)
  const [, m, d] = promiseToPayDate.split('-')
  const dateLabel = `${d}/${m}`
  if (status === 'overdue') {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
        <AlertTriangle size={12} />
        เลยนัด {Math.abs(days ?? 0)} วัน ({dateLabel})
      </span>
    )
  }
  if (status === 'due_today') {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-700">
        <CalendarClock size={12} />
        ถึงวันนัดวันนี้
      </span>
    )
  }
  if (status === 'due_tomorrow') {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
        <CalendarClock size={12} />
        ใกล้นัดพรุ่งนี้ ({dateLabel})
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-peach-light px-2 py-0.5 text-xs font-medium text-ink-soft">
      📅 สัญญาจะจ่าย {dateLabel}
    </span>
  )
}

// ===== ป้าย "คืนเครื่องแล้ว" + ยอดปิดที่ต้องตามเก็บ =====
// แสดงเฉพาะเคส isReturned (status='returned' ที่ยังค้างยอดปิด) — โทนม่วง/indigo แยกจากป้ายวันนัด
function ReturnedClosingBadge({ row }: { row: FreelancerQueueRow }) {
  if (!row.isReturned) return null
  return (
    <span className="mt-0.5 inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700">
      <PackageCheck size={12} />
      คืนเครื่องแล้ว · ยอดปิด {baht(row.returnClosingAmount)} ฿
    </span>
  )
}

// ===== ป้าย "ไม่ได้ติดตามมานาน" (req8) — ซ่อนถ้าสัญญาไม่ active (เคสคืนเครื่อง/ปิดเคสวันนี้ ไม่ต้องเตือน) =====
function StalenessBadge({ row }: { row: FreelancerQueueRow }) {
  if (row.isReturned || row.caseClosedToday) return null
  const staleness = followUpStalenessLevel(row.lastContactedAt, new Date())
  if (staleness.level === 'none') return null
  return (
    <span
      className={`mt-0.5 inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${
        staleness.level === 'danger' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
      }`}
    >
      <AlertTriangle size={12} />
      {staleness.badgeText}
    </span>
  )
}

// ===== Row ใน Tab 1 =====
// รอบ 2 (feedback เจ้าของ): เอาปุ่มขยาย/ย่อออก — ข้อมูลรองทั้งหมดแสดงตลอดในคอลัมน์ "รายละเอียด"
// ลำดับสายตา: คอมพลายแอนซ์(DNC/ทนาย/โต้แย้ง) เด่นสุด → ชื่อ+เบอร์หลัก+เบอร์สำรอง (ใหญ่/หนา — ใช้โทรทันที) → ป้ายเร่งด่วนสูงสุด 2 อัน (นัดชำระ + อัปเดตใหม่)
// คอลัมน์: ลูกค้า / ร้าน / เกรด·คะแนน·ค้าง (ยุบ 3 เดิม) / งวด / ยอดต้องชำระวันนี้ (breakdown ค่างวด+ค่าปรับ) / รายละเอียด (ใหม่ แสดงตลอด) / ปุ่ม
function QueueRow({
  sr,
  outsideHours,
  enforceCallHours = true,
  actionMode = 'claim',
  claimingId = null,
  onSelect,
  onClaim,
  onRelease,
}: {
  sr: ScoredRow
  outsideHours: boolean
  // false = แท็บ "งานที่ต้องดูแล" (mine): ปุ่มบันทึกกดได้ตลอด ไม่คุมเวลาทวงถาม (Pete decision)
  enforceCallHours?: boolean
  // ปุ่มที่สอง: claim = "ฉันดูแลเคสนี้" (แท็บโทร/คืนเครื่อง) · release = "ทิ้งงาน" (แท็บ mine)
  actionMode?: 'claim' | 'release'
  claimingId?: string | null
  onSelect: (r: FreelancerQueueRow) => void
  onClaim: (r: FreelancerQueueRow) => void
  onRelease?: (r: FreelancerQueueRow) => void
}) {
  const r = sr.row
  const isBlocked = r.dnc || r.lawyerEngaged
  // enforceCallHours=false → ไม่ disable ปุ่มบันทึกเลย (แท็บ mine)
  const disableButton = enforceCallHours && isHardBlocked(outsideHours, sr.suppressReason)

  let tooltip = ''
  if (enforceCallHours) {
    if (outsideHours) tooltip = 'นอกเวลาทวงถามตามกฎหมาย'
    else if (sr.suppressReason) tooltip = SUPPRESS_LABEL[sr.suppressReason]
  }

  const hasUnseen = hasUnseenUpdate(r.myLastTouchAt, r.latestOtherAuthorAt)

  return (
    <tr className="border-b border-peach last:border-0 hover:bg-peach-light/20">
      {/* ลูกค้า */}
      <td className="px-4 py-3 align-top">
        {/* ป้ายคอมพลายแอนซ์ — เห็นเสมอ ไม่ซ่อน */}
        {(r.dnc || r.lawyerEngaged || r.disputed) && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {r.dnc && <Badge tone="red">⛔ ห้ามติดต่อ (DNC)</Badge>}
            {r.lawyerEngaged && !r.dnc && <Badge tone="amber">⚖️ มีทนายความ</Badge>}
            {r.disputed && <Badge tone="amber">📋 โต้แย้งยอด</Badge>}
          </div>
        )}

        {/* ชื่อ + ป้าย "ทำแล้ววันนี้" */}
        <div className="flex flex-wrap items-center gap-1.5">
          <p className={`text-[15px] font-semibold leading-tight ${isBlocked ? 'text-ink-soft' : 'text-ink'}`}>
            {r.customerName}
          </p>
          {r.contactedToday && (
            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-semibold text-green-700">
              ✓ โทรแล้ววันนี้
            </span>
          )}
        </div>
        <p className="text-xs text-ink-soft">{r.contractNo}</p>

        {/* เบอร์หลัก — ต้องใช้โทรทันที ให้เด่นกว่าข้อมูลรอง */}
        {r.phone && <p className="mt-1 text-sm font-medium text-ink">📞 {r.phone}</p>}
        {/* เบอร์สำรอง — แสดงเสมอต่อจากเบอร์หลัก (โทรเบอร์หลักไม่ติดต้องใช้บ่อย) */}
        {(r.phoneAlt1 || r.phoneAlt2) && (
          <p className="text-xs text-ink-soft">📞 สำรอง: {[r.phoneAlt1, r.phoneAlt2].filter(Boolean).join(', ')}</p>
        )}

        {/* ป้ายเร่งด่วนสูงสุด 2 อัน: นัดชำระ + อัปเดตใหม่ */}
        {(r.promiseToPayDate !== null || hasUnseen) && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <PromiseBadge promiseToPayDate={r.promiseToPayDate} />
            {hasUnseen && (
              <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                🔔 มีอัปเดตใหม่
              </span>
            )}
          </div>
        )}
      </td>
      {/* ร้าน */}
      <td className="px-4 py-3 align-top text-sm text-ink-soft">{r.shopName}</td>
      {/* เกรด · คะแนน · ค้าง — ยุบ 3 คอลัมน์เดิมเป็น 1 */}
      <td className="px-4 py-3 align-top text-center">
        <div className="flex flex-col items-center gap-1">
          <Badge tone={GRADE_TONE[r.grade]}>เกรด {r.grade}</Badge>
          {/* ซ่อนคะแนน/tier สำหรับเคสคืนเครื่อง — priority score ไม่มีความหมายกับเคสตามยอดปิด */}
          {!r.isReturned && (
            <span className="inline-flex items-center gap-1 text-[10px] text-ink-soft">
              คะแนน
              <span className={`rounded-full px-1.5 py-0.5 font-semibold ${TIER_SCORE_CLS[sr.tier]}`}>
                {TIER_EMOJI[sr.tier]} {sr.score}
              </span>
            </span>
          )}
          <span className="whitespace-nowrap text-xs font-semibold text-red-600">ค้าง {r.daysLate} วัน</span>
        </div>
      </td>
      {/* งวด X/Y — เลขงวดเด่น + ค่างวดจริง/เดือนเป็นบรรทัดรอง (ให้ตอบลูกค้าได้ทันทีว่างวดนึงเท่าไร) */}
      <td className="px-4 py-3 align-top text-right text-sm text-ink">
        {r.installmentsTotal === 0
          ? <span className="text-ink-soft">—</span>
          : <span>งวด {r.installmentsPaid}/{r.installmentsTotal}</span>
        }
        {r.monthlyPayment > 0 && (
          <p className="mt-0.5 whitespace-nowrap text-xs text-ink-soft">ค่างวดเดือนละ {baht(r.monthlyPayment)} ฿</p>
        )}
      </td>
      {/* ยอดต้องชำระวันนี้ — breakdown ค่างวดที่ค้าง(overdueAmount) + ค่าปรับ(outstanding) = ยอดรวม
          ใช้ overdueAmount ไม่ใช่ monthlyPayment (ค่างวดเต็ม) เพื่อให้บรรทัดย่อยบวกแล้วตรงกับ headline เป๊ะ */}
      <td className="px-4 py-3 align-top text-right">
        <div className="flex flex-col items-end gap-0.5 text-xs text-ink-soft">
          <span className="whitespace-nowrap">ค่างวดที่ค้าง {baht(r.overdueAmount)} ฿</span>
          <span className={`whitespace-nowrap ${r.outstanding > 0 ? 'font-semibold text-red-600' : ''}`}>
            + ค่าปรับ {baht(r.outstanding)} ฿
          </span>
        </div>
        <div className="mt-1 border-t border-peach/60 pt-1">
          <p className="text-[10px] font-medium text-red-500 whitespace-nowrap">ยอดต้องชำระวันนี้</p>
          <p className="text-base font-bold text-red-700 whitespace-nowrap">{baht(r.overdueAmount + r.outstanding)} ฿</p>
        </div>
      </td>
      {/* รายละเอียด — คอลัมน์ใหม่ แสดงตลอด (ย้ายจากใต้ปุ่มขยายเดิม) */}
      <td className="px-4 py-3 align-top">
        <div className="flex max-w-[220px] flex-col gap-1 text-xs text-ink-soft">
          {r.deviceModel && <p>📱 {r.deviceModel}</p>}
          {r.lastResult !== null && r.lastContactedAt !== null && (
            <p>
              🕐 {r.lastContactedByName ?? '?'} {relativeContactTime(r.lastContactedAt)} — {RESULT_LABEL[r.lastResult]}
            </p>
          )}
          {r.latestNote && <p className="whitespace-normal break-words">💬 {r.latestNote}</p>}
          {/* ป้ายคืนเครื่องแล้ว + ยอดปิด (ไม่โผล่ใน Tab นี้จริง เพราะ activeRows กรอง isReturned ออกแล้ว — คงไว้กันเคส edge) */}
          <ReturnedClosingBadge row={r} />
          {/* ป้ายไม่ได้ติดตามมานาน (req8) */}
          <StalenessBadge row={r} />
        </div>
      </td>
      {/* ปุ่ม */}
      <td className="px-4 py-3 align-top">
        <div className="flex flex-col items-stretch gap-1.5">
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
          {/* ปุ่มที่สอง: claim = ฉันดูแลเคสนี้ · release = ทิ้งงาน (แท็บ mine) */}
          {actionMode === 'claim' ? (
            <button
              onClick={() => onClaim(r)}
              className="inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100"
            >
              <UserCheck size={13} />
              ฉันดูแลเคสนี้
            </button>
          ) : (
            <button
              disabled={claimingId === r.contractId}
              onClick={() => onRelease?.(r)}
              className="whitespace-nowrap rounded-xl border border-peach bg-white px-3 py-2 text-xs font-semibold text-ink-soft transition hover:bg-peach-light/50 disabled:opacity-50"
            >
              {claimingId === r.contractId ? 'กำลังทิ้งงาน...' : 'ทิ้งงาน'}
            </button>
          )}
        </div>
      </td>
    </tr>
  )
}

// ===== Card ใน Tab 1 (มือถือ < md) =====
// รอบ 2 (feedback เจ้าของ): เอาปุ่มขยาย/ย่อออก — รายละเอียดแสดงตลอดในการ์ด
// ลำดับสายตาเดียวกับ desktop: คอมพลายแอนซ์ → ชื่อ+เบอร์หลัก+เบอร์สำรอง → ป้ายเร่งด่วน(นัด/อัปเดตใหม่) →
// กล่องยอดเงิน breakdown → เกรด·คะแนน·ค้าง·งวด (ยุบรวม) → รายละเอียด (แสดงตลอด) → ปุ่ม action
function QueueCardMobile({
  sr,
  outsideHours,
  enforceCallHours = true,
  actionMode = 'claim',
  claimingId = null,
  onSelect,
  onClaim,
  onRelease,
}: {
  sr: ScoredRow
  outsideHours: boolean
  enforceCallHours?: boolean
  actionMode?: 'claim' | 'release'
  claimingId?: string | null
  onSelect: (r: FreelancerQueueRow) => void
  onClaim: (r: FreelancerQueueRow) => void
  onRelease?: (r: FreelancerQueueRow) => void
}) {
  const r = sr.row
  const isBlocked = r.dnc || r.lawyerEngaged
  const disableButton = enforceCallHours && isHardBlocked(outsideHours, sr.suppressReason)
  let tooltip = ''
  if (enforceCallHours) {
    if (outsideHours) tooltip = 'นอกเวลาทวงถามตามกฎหมาย'
    else if (sr.suppressReason) tooltip = SUPPRESS_LABEL[sr.suppressReason]
  }

  const hasUnseen = hasUnseenUpdate(r.myLastTouchAt, r.latestOtherAuthorAt)

  return (
    <div className="p-4">
      {/* ป้ายคอมพลายแอนซ์ — เห็นเสมอ ไม่ซ่อน */}
      {(r.dnc || r.lawyerEngaged || r.disputed) && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {r.dnc && <Badge tone="red">⛔ ห้ามติดต่อ</Badge>}
          {r.lawyerEngaged && !r.dnc && <Badge tone="amber">⚖️ ทนายความ</Badge>}
          {r.disputed && <Badge tone="amber">📋 โต้แย้ง</Badge>}
        </div>
      )}

      {/* ชื่อ + ป้าย "ทำแล้ววันนี้" */}
      <div className="flex flex-wrap items-center gap-1.5">
        <p className={`font-semibold leading-tight ${isBlocked ? 'text-ink-soft' : 'text-ink'}`}>
          {r.customerName}
        </p>
        {r.contactedToday && (
          <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-semibold text-green-700">
            ✓ โทรแล้ว
          </span>
        )}
      </div>
      <p className="text-xs text-ink-soft">{r.contractNo} · {r.shopName}</p>
      {/* เบอร์หลัก — ต้องใช้โทรทันที ให้เด่นกว่าข้อมูลรอง */}
      {r.phone && <p className="mt-1 text-sm font-medium text-ink">📞 {r.phone}</p>}
      {/* เบอร์สำรอง — แสดงเสมอต่อจากเบอร์หลัก (โทรเบอร์หลักไม่ติดต้องใช้บ่อย) */}
      {(r.phoneAlt1 || r.phoneAlt2) && (
        <p className="text-xs text-ink-soft">📞 สำรอง: {[r.phoneAlt1, r.phoneAlt2].filter(Boolean).join(', ')}</p>
      )}
      {/* ป้ายเร่งด่วนสูงสุด 2 อัน: นัดชำระ + อัปเดตใหม่ */}
      {(r.promiseToPayDate !== null || hasUnseen) && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <PromiseBadge promiseToPayDate={r.promiseToPayDate} />
          {hasUnseen && (
            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
              🔔 มีอัปเดตใหม่
            </span>
          )}
        </div>
      )}

      {/* กล่องยอดเงิน — breakdown ค่างวดที่ค้าง(overdueAmount) + ค่าปรับ(outstanding) = ยอดรวม
          ใช้ overdueAmount ไม่ใช่ monthlyPayment (ค่างวดเต็ม) เพื่อให้บรรทัดย่อยบวกแล้วตรงกับ headline เป๊ะ */}
      <div className="mt-2 rounded-lg bg-red-50 px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-red-700/80">
          <span>ค่างวดที่ค้าง {baht(r.overdueAmount)} ฿</span>
          <span className={r.outstanding > 0 ? 'font-semibold text-red-600' : ''}>
            + ค่าปรับ {baht(r.outstanding)} ฿
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between border-t border-red-200/70 pt-1">
          <span className="text-[10px] font-medium text-red-500">ยอดต้องชำระวันนี้</span>
          <span className="text-lg font-bold text-red-700">{baht(r.overdueAmount + r.outstanding)} ฿</span>
        </div>
      </div>

      {/* เกรด · คะแนน · ค้าง · งวด — ยุบรวมแทนจุดกระจายเดิม + ค่างวดจริง/เดือน (ตอบลูกค้าได้ทันที) */}
      <div className="mb-2 mt-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge tone={GRADE_TONE[r.grade]}>เกรด {r.grade}</Badge>
          {/* ซ่อนคะแนน/tier สำหรับเคสคืนเครื่อง */}
          {!r.isReturned && (
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${TIER_SCORE_CLS[sr.tier]}`}>
              {TIER_EMOJI[sr.tier]} คะแนน {sr.score}
            </span>
          )}
          <span className="whitespace-nowrap font-semibold text-red-600">ค้าง {r.daysLate} วัน</span>
          {r.installmentsTotal > 0 && <span className="text-ink-soft">งวด {r.installmentsPaid}/{r.installmentsTotal}</span>}
        </div>
        {r.monthlyPayment > 0 && (
          <p className="mt-1 text-xs text-ink-soft">ค่างวดเดือนละ {baht(r.monthlyPayment)} ฿</p>
        )}
      </div>

      {/* รายละเอียด — แสดงตลอด (ย้ายจากใต้ปุ่มขยายเดิม) */}
      <div className="mb-3 flex flex-col gap-1 border-t border-peach/60 pt-2 text-xs text-ink-soft">
        {r.deviceModel && <p>📱 {r.deviceModel}</p>}
        {r.lastResult !== null && r.lastContactedAt !== null && (
          <p>
            🕐 {r.lastContactedByName ?? '?'} {relativeContactTime(r.lastContactedAt)} — {RESULT_LABEL[r.lastResult]}
          </p>
        )}
        {r.latestNote && <p className="whitespace-normal break-words">💬 {r.latestNote}</p>}
        {/* ไม่โผล่ใน Tab นี้จริง เพราะ activeRows กรอง isReturned ออกแล้ว — คงไว้กันเคส edge */}
        <ReturnedClosingBadge row={r} />
        <StalenessBadge row={r} />
      </div>

      {/* ปุ่มบันทึก + ฉันดูแลเคสนี้ */}
      <div className="flex flex-col gap-1.5">
        <button
          disabled={disableButton}
          onClick={() => !disableButton && onSelect(r)}
          title={tooltip || undefined}
          className={`w-full rounded-xl border px-3 py-2 text-sm font-semibold transition ${
            disableButton
              ? 'cursor-not-allowed border-peach bg-peach-light/40 text-ink-soft opacity-60'
              : 'border-peach bg-white text-ink hover:bg-peach-light/50'
          }`}
        >
          บันทึกติดตาม
        </button>
        {actionMode === 'claim' ? (
          <button
            onClick={() => onClaim(r)}
            className="inline-flex w-full items-center justify-center gap-1 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-100"
          >
            <UserCheck size={14} />
            ฉันดูแลเคสนี้
          </button>
        ) : (
          <button
            disabled={claimingId === r.contractId}
            onClick={() => onRelease?.(r)}
            className="w-full rounded-xl border border-peach bg-white px-3 py-2 text-sm font-semibold text-ink-soft transition hover:bg-peach-light/50 disabled:opacity-50"
          >
            {claimingId === r.contractId ? 'กำลังทิ้งงาน...' : 'ทิ้งงาน'}
          </button>
        )}
      </div>
    </div>
  )
}

// ===== Component หลัก =====
export default function FreelancerWorkspace() {
  const { role, session } = useAuth()
  const [assignedGrades, setAssignedGrades] = useState<ContractGrade[]>([])
  const [selectedGrades, setSelectedGrades] = useState<ContractGrade[]>([])
  const [rows, setRows] = useState<FreelancerQueueRow[]>([])
  const [loading, setLoading] = useState(true)
  // refetch หลัง save/claim/drop ใช้ตัวนี้แทน loading เดิม — ไม่ unmount list ไม่ให้ scroll กระโดดขึ้นบนสุด
  const [refreshing, setRefreshing] = useState(false)
  const [shopFilter, setShopFilter] = useFilter<string>('queue.shop', '')
  const [searchTerm, setSearchTerm] = useState<string>('')
  const [selectedContract, setSelectedContract] = useState<FreelancerQueueRow | null>(null)
  const [publicHolidays, setPublicHolidays] = useState<Set<string>>(new Set())
  const [activeTab, setActiveTab] = useFilter<'todo' | 'mine' | 'returned' | 'done'>('queue.tab', 'todo')
  // ข้อ 6: โหมดเรียงแท็บ "ที่ต้องโทร" — ไม่ต้อง persist ข้ามหน้า
  const [sortMode, setSortMode] = useState<SortMode>('priority')

  // overdue promise state
  const [overdue, setOverdue] = useState<OverduePromiseContract[]>([])
  const [overdueFilter, setOverdueFilter] = useState(false)

  // pagination state (default 50 — เหมือนหน้าฝั่งพนักงาน)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)

  // req7: เคสที่ตัวเอง claim ไว้ ("งานที่ต้องดูแล") + toast แจ้งเตือนเคสถูกจองไปแล้ว
  const [myCases, setMyCases] = useState<FreelancerQueueRow[]>([])
  const [claimToast, setClaimToast] = useState<string | null>(null)
  const [claimingId, setClaimingId] = useState<string | null>(null)
  // req7 admin: สรุปใครถือกี่เคส
  const [ownershipSummary, setOwnershipSummary] = useState<{ ownerId: string; ownerName: string; count: number }[]>([])

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

  // โหลดคิว — background=true ใช้ตอน refetch หลัง save/claim/drop (ไม่ toggle loading เพื่อกัน list unmount/scroll กระโดด)
  const loadQueue = useCallback(async (grades: ContractGrade[], opts?: { background?: boolean }) => {
    const background = opts?.background ?? false
    if (background) setRefreshing(true)
    else setLoading(true)
    try {
      const data = await getFreelancerQueue(grades)
      setRows(data)
    } finally {
      if (background) setRefreshing(false)
      else setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadGrades().then((grades) => {
      if (grades.length > 0) void loadQueue(grades)
      else setLoading(false)
    })
  }, [loadGrades, loadQueue])

  // req7: โหลดเคสที่ตัวเอง claim ไว้ ("งานที่ต้องดูแล")
  const loadMyCases = useCallback(async () => {
    try {
      const data = await getMyCases()
      setMyCases(data)
    } catch {
      setMyCases([])
    }
  }, [])

  useEffect(() => {
    void loadMyCases()
  }, [loadMyCases])

  // req7 admin: โหลดสรุปใครถือกี่เคส
  useEffect(() => {
    if (role !== 'admin') return
    getCaseOwnershipSummary().then(setOwnershipSummary).catch(() => setOwnershipSummary([]))
  }, [role])

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

  // #4: patch แถวเดียวใน rows + myCases จากผลลัพธ์ getFreelancerQueueRow — แทน full re-fetch ทั้งคิว
  // row=null → เคสหลุดจากคิว/ไม่ใช่ของเรา (ลบออก); row!=null → replace ถ้ามีอยู่แล้ว หรือเพิ่มเข้าไปถ้ายังไม่มี
  const applyRowPatch = useCallback((contractId: string, row: FreelancerQueueRow | null) => {
    // rows: คิวหลักตาม selectedGrades — เติมเฉพาะแถวที่ตรงเกรดที่กำลังเลือกอยู่ (กัน chip filter เพี้ยน)
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.contractId === contractId)
      if (row && (selectedGrades.length === 0 || selectedGrades.includes(row.grade))) {
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = row
          return next
        }
        return [...prev, row]
      }
      if (idx < 0) return prev
      return prev.filter((r) => r.contractId !== contractId)
    })

    // myCases: เฉพาะเคสที่ assignedTo = ตัวเอง
    setMyCases((prev) => {
      const idx = prev.findIndex((r) => r.contractId === contractId)
      const myId = session?.user.id ?? null
      if (row && myId && row.assignedTo === myId) {
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = row
          return next
        }
        return [...prev, row]
      }
      if (idx < 0) return prev
      return prev.filter((r) => r.contractId !== contractId)
    })
  }, [selectedGrades, session])

  // #4: ดึงเคสเดียวมา patch — network error → fallback full refetch (background, กันหน้า desync)
  const refreshQueueRow = useCallback(async (contractId: string) => {
    try {
      const row = await getFreelancerQueueRow(contractId)
      applyRowPatch(contractId, row)
    } catch {
      if (selectedGrades.length > 0) void loadQueue(selectedGrades, { background: true })
      void loadMyCases()
    }
  }, [applyRowPatch, selectedGrades, loadQueue, loadMyCases])

  // req7: จองเคส — เข้าแท็บ "งานที่ต้องดูแล" + หายจาก "ที่ต้องโทร"
  async function handleClaimCase(r: FreelancerQueueRow) {
    setClaimingId(r.contractId)
    setClaimToast(null)
    try {
      await claimCase(r.contractId)
      await refreshQueueRow(r.contractId)
      if (role === 'admin') void getCaseOwnershipSummary().then(setOwnershipSummary).catch(() => {})
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setClaimToast(msg.includes('CASE_ALREADY_CLAIMED') ? 'เคสนี้มีคนรับดูแลแล้ว' : 'จองเคสไม่สำเร็จ ลองใหม่อีกครั้ง')
    } finally {
      setClaimingId(null)
    }
  }

  // req7: ทิ้งงาน — กลับเข้า "ที่ต้องโทร"
  async function handleReleaseCase(r: FreelancerQueueRow) {
    setClaimingId(r.contractId)
    setClaimToast(null)
    try {
      await releaseCase(r.contractId)
      await refreshQueueRow(r.contractId)
      if (role === 'admin') void getCaseOwnershipSummary().then(setOwnershipSummary).catch(() => {})
    } catch (e) {
      setClaimToast(e instanceof Error ? e.message : 'ทิ้งงานไม่สำเร็จ ลองใหม่อีกครั้ง')
    } finally {
      setClaimingId(null)
    }
  }

  // ข้อ 5: filter "งานที่ต้องดูแล" ด้วยช่องค้นหาเดียวกับแท็บอื่น (บั๊กเดิม: myCases ไม่เคยผ่าน searchTerm)
  const filteredMyCases = useMemo(() => {
    const q = searchTerm.trim().toLowerCase()
    if (!q) return myCases
    const qPhone = stripPhone(q)
    return myCases.filter(
      (r) =>
        r.customerName?.toLowerCase().includes(q) ||
        r.contractNo?.toLowerCase().includes(q) ||
        stripPhone(r.phone ?? '').includes(qPhone) ||
        stripPhone(r.phoneAlt1 ?? '').includes(qPhone) ||
        stripPhone(r.phoneAlt2 ?? '').includes(qPhone),
    )
  }, [myCases, searchTerm])

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

  // แบ่ง 3 กลุ่ม:
  // todayRows   = caseClosedToday (Tab 3 "ปิดเคสวันนี้") — ทุกชนิดรวมคืนเครื่อง
  // returnedRows = isReturned && !caseClosedToday (Tab 2 "คืนเครื่อง")
  // activeRows  = !isReturned && !caseClosedToday && ยังไม่มีใคร claim (Tab 1 "ที่ต้องโทร")
  // contactedToday ยังคงอยู่ในข้อมูล — ใช้แสดง team awareness ใน QueueRow ตามปกติ
  // req7: admin เห็นคิวปกติทั้งหมด (ไม่ claim เอง) — เฉพาะ freelancer ที่เคส claim แล้วหายจาก "ที่ต้องโทร"
  const todayRows = useMemo(() => filtered.filter((r) => r.caseClosedToday), [filtered])
  const pendingRows = useMemo(() => filtered.filter((r) => !r.caseClosedToday), [filtered])
  // req: เคสคืนเครื่องที่ถูก claim แล้ว ย้ายออกจากแท็บ "คืนเครื่อง" ไปอยู่ "งานที่ต้องดูแล" เหมือนเคสโทรปกติ
  const returnedRows = useMemo(
    () => pendingRows.filter((r) => r.isReturned && (role === 'admin' || r.assignedTo === null)),
    [pendingRows, role],
  )
  const activeRows = useMemo(
    () => pendingRows.filter((r) => !r.isReturned && (role === 'admin' || r.assignedTo === null)),
    [pendingRows, role],
  )

  // คำนวณ priority สำหรับ Tab 1 — memoized (เฉพาะ activeRows ไม่รวมคืนเครื่อง)
  const today = useMemo(() => new Date(), [])
  const scoredRows = useMemo((): ScoredRow[] => {
    return activeRows.map((r) => {
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
  }, [activeRows, today])

  // map contractId → ScoredRow เพื่อหยิบ suppressReason ตอนเปิด modal
  const scoredRowMap = useMemo(
    () => new Map(scoredRows.map((sr) => [sr.row.contractId, sr])),
    [scoredRows],
  )

  // แท็บ "งานที่ต้องดูแล" (mine): แปลง filteredMyCases → ScoredRow เพื่อ reuse QueueRow/QueueCardMobile
  // ใช้ computePriorityScore ชุดเดียวกับ scoredRows — score/tier ยังคำนวณไว้ (ถึงแม้จะไม่ได้โชว์เคส returned)
  const myScoredRows = useMemo((): ScoredRow[] => {
    return filteredMyCases.map((r) => {
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
  }, [filteredMyCases, today])

  // today string (Bangkok UTC+7) สำหรับ sortQueue + promise badge
  const todayStr = useMemo(
    () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10),
    [],
  )

  // รายชื่อเดียวเรียงตามโหมดที่เลือก (ข้อ 6):
  // priority (default) = sortQueue เดิม (เลยนัด → ใกล้นัด≤7วัน → tier+score)
  // daysLateAsc/Desc = เรียงตามวันค้างชำระ แต่ปักหมุดเคส "เลยนัด/ถึงนัดวันนี้" ไว้บนสุดเสมอ (Pete: จะได้ไม่ต้องเลื่อนหา)
  const sortedRows = useMemo(() => {
    if (sortMode === 'daysLateAsc') {
      return pinDuePromise(scoredRows, todayStr, (a, b) => a.row.daysLate - b.row.daysLate)
    }
    if (sortMode === 'daysLateDesc') {
      return pinDuePromise(scoredRows, todayStr, (a, b) => b.row.daysLate - a.row.daysLate)
    }
    return sortQueue(scoredRows, todayStr)
  }, [scoredRows, todayStr, sortMode])

  // แท็บ "งานที่ต้องดูแล" (mine): เรียงด้วย sortQueue เดียวกับแท็บ "ที่ต้องโทร"
  // เพื่อให้เคสเลยนัด/ถึงนัดวันนี้เด้งขึ้นบนสุด — reuse sortQueue เดิม (Pete: "เคสถึงนัดแล้วขึ้นบนสุด")
  const sortedMyScoredRows = useMemo(() => sortQueue(myScoredRows, todayStr), [myScoredRows, todayStr])

  // === Pagination ของแท็บ "ที่ต้องโทร" ===
  const pagedSortedRows = useMemo(
    () => sortedRows.slice((page - 1) * pageSize, page * pageSize),
    [sortedRows, page, pageSize],
  )

  // === แท็บ "คืนเครื่อง" — เรียงนานสุดก่อน (daysSinceAnchor มากไปน้อย, null ไปท้าย) ===
  const sortedReturnedRows = useMemo(() => {
    return [...returnedRows].sort((a, b) => {
      const dA = a.returnAnchorDate ? daysSinceAnchor(a.returnAnchorDate, todayStr) : null
      const dB = b.returnAnchorDate ? daysSinceAnchor(b.returnAnchorDate, todayStr) : null
      if (dA === null && dB === null) return 0
      if (dA === null) return 1   // null ไปท้าย
      if (dB === null) return -1
      return dB - dA
    })
  }, [returnedRows, todayStr])

  const pagedReturnedRows = useMemo(
    () => sortedReturnedRows.slice((page - 1) * pageSize, page * pageSize),
    [sortedReturnedRows, page, pageSize],
  )

  // === Pagination ของแท็บ "ปิดเคสวันนี้" (ใช้ page/pageSize ชุดเดียวกัน รีเซ็ตตอนสลับแท็บ) ===
  const pagedTodayRows = useMemo(
    () => todayRows.slice((page - 1) * pageSize, page * pageSize),
    [todayRows, page, pageSize],
  )

  // reset หน้า=1 เมื่อเปลี่ยนแท็บ / ตัวกรอง / ค้นหา
  useEffect(() => {
    setPage(1)
  }, [activeTab, shopFilter, searchTerm, overdueFilter, selectedGrades, sortMode])

  function handlePageSizeChange(s: number) {
    setPageSize(s)
    setPage(1)
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
        <div className="mt-1 flex shrink-0 items-center gap-2">
          {refreshing && <span className="text-xs text-ink-soft">กำลังอัปเดต...</span>}
          <button
            onClick={handleRefresh}
            className="flex shrink-0 items-center gap-1.5 rounded-xl border border-peach bg-white px-3 py-2 text-sm font-medium text-ink transition hover:bg-peach-light/50"
            title="โหลดข้อมูลใหม่"
          >
            🔄 รีเฟรช
          </button>
        </div>
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
                  <span className="whitespace-nowrap">· รวม {baht(totalPromised)} ฿</span>
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

          {/* req7: toast แจ้งเตือนเคสถูกจองไปแล้ว / จองไม่สำเร็จ */}
          {claimToast && (
            <div className="mb-4 flex items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
              <span>{claimToast}</span>
              <button onClick={() => setClaimToast(null)} className="text-amber-700 hover:text-amber-900">
                ✕
              </button>
            </div>
          )}

          {/* req7 admin: สรุปใครถือกี่เคส */}
          {role === 'admin' && ownershipSummary.length > 0 && (
            <Card className="mb-4">
              <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
                <Users size={15} />
                ใครดูแลกี่เคส
              </div>
              <div className="flex flex-wrap gap-2">
                {ownershipSummary.map((o) => (
                  <span
                    key={o.ownerId}
                    className="inline-flex items-center gap-1 rounded-full bg-peach-light/60 px-3 py-1 text-xs font-medium text-ink"
                  >
                    {o.ownerName || 'ไม่ทราบชื่อ'} · {o.count} เคส
                  </span>
                ))}
              </div>
            </Card>
          )}

          {/* === Tab bar === */}
          <div className="mb-4 flex flex-wrap gap-2">
            <button
              onClick={() => setActiveTab('todo')}
              className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
                activeTab === 'todo'
                  ? 'bg-salmon-deep text-white'
                  : 'border border-peach bg-white text-ink-soft hover:bg-peach-light'
              }`}
            >
              🎯 ที่ต้องโทร ({activeRows.length})
            </button>
            {/* req7: งานที่ต้องดูแล — เคสที่ตัวเอง claim ไว้ */}
            <button
              onClick={() => setActiveTab('mine')}
              className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
                activeTab === 'mine'
                  ? 'bg-emerald-600 text-white'
                  : 'border border-peach bg-white text-ink-soft hover:bg-peach-light'
              }`}
            >
              <span className="inline-flex items-center gap-1.5">
                <UserCheck size={15} />
                งานที่ต้องดูแล ({filteredMyCases.length})
              </span>
            </button>
            <button
              onClick={() => setActiveTab('returned')}
              className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
                activeTab === 'returned'
                  ? 'bg-indigo-600 text-white'
                  : 'border border-peach bg-white text-ink-soft hover:bg-peach-light'
              }`}
            >
              📦 คืนเครื่อง ({returnedRows.length})
            </button>
            <button
              onClick={() => setActiveTab('done')}
              className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
                activeTab === 'done'
                  ? 'bg-salmon-deep text-white'
                  : 'border border-peach bg-white text-ink-soft hover:bg-peach-light'
              }`}
            >
              ✅ ปิดเคสวันนี้ ({todayRows.length})
            </button>
          </div>

          {/* === Tab 1: ที่ต้องโทร === */}
          {activeTab === 'todo' && (
            <>
              {/* ข้อ 6: ตัวเลือกเรียงลำดับ */}
              {activeRows.length > 0 && (
                <div className="mb-3 flex items-center justify-end gap-2 text-xs text-ink-soft">
                  <span>เรียงตาม:</span>
                  <select
                    value={sortMode}
                    onChange={(e) => setSortMode(e.target.value as SortMode)}
                    className="rounded-lg border border-peach bg-white px-2.5 py-1.5 text-xs font-medium text-ink outline-none transition focus:border-salmon-deep"
                  >
                    {(Object.keys(SORT_MODE_LABEL) as SortMode[]).map((m) => (
                      <option key={m} value={m}>
                        {SORT_MODE_LABEL[m]}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {activeRows.length === 0 ? (
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
                  {/* รายชื่อเดียวเรียงตามความสำคัญ + แบ่งหน้า */}
                  <div className="overflow-hidden rounded-2xl border border-peach bg-white shadow-sm">
                    {/* ===== Desktop table (≥ md) ===== */}
                    <div className="hidden overflow-x-auto md:block">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-peach bg-cream-deep text-left text-xs font-semibold text-ink-soft">
                            <th className="px-4 py-3">ลูกค้า</th>
                            <th className="px-4 py-3">ร้าน</th>
                            <th className="px-4 py-3 text-center">เกรด · ค้าง</th>
                            <th className="px-4 py-3 text-right">งวด</th>
                            <th className="px-4 py-3 text-right">ยอดต้องชำระวันนี้</th>
                            <th className="px-4 py-3">รายละเอียด</th>
                            <th className="px-4 py-3" />
                          </tr>
                        </thead>
                        <tbody>
                          {pagedSortedRows.map((sr) => (
                            <QueueRow
                              key={sr.row.contractId}
                              sr={sr}
                              outsideHours={outsideHours}
                              onSelect={handleOpenCase}
                              onClaim={handleClaimCase}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* ===== Mobile card stack (< md) ===== */}
                    <div className="flex flex-col divide-y divide-peach/60 md:hidden">
                      {pagedSortedRows.map((sr) => (
                        <QueueCardMobile
                          key={sr.row.contractId}
                          sr={sr}
                          outsideHours={outsideHours}
                          onSelect={handleOpenCase}
                          onClaim={handleClaimCase}
                        />
                      ))}
                    </div>

                    {/* ===== Pagination ===== */}
                    <div className="border-t border-peach px-4">
                      <Pagination
                        total={sortedRows.length}
                        page={page}
                        pageSize={pageSize}
                        onPageChange={setPage}
                        onPageSizeChange={handlePageSizeChange}
                        pageSizeOptions={[20, 50, 100]}
                      />
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* === Tab "งานที่ต้องดูแล" (req7) — เคสที่ตัวเอง claim ไว้ === */}
          {activeTab === 'mine' && (
            <>
              {filteredMyCases.length === 0 ? (
                searchTerm.trim() ? (
                  <EmptyState
                    title="ไม่พบลูกค้าที่ค้นหา"
                    hint="ลองเปลี่ยนคำค้นหา หรือล้างช่องค้นหาเพื่อดูทั้งหมด"
                  />
                ) : (
                  <EmptyState
                    title="ยังไม่มีเคสที่ดูแลอยู่"
                    hint="กด 'ฉันดูแลเคสนี้' จากแท็บ 'ที่ต้องโทร' เพื่อจองเคสมาไว้ที่นี่"
                  />
                )
              ) : (
                /* reuse QueueRow/QueueCardMobile เดียวกับแท็บ "ที่ต้องโทร" → ข้อมูลครบเหมือนกัน
                   enforceCallHours=false → ปุ่มบันทึกกดได้ตลอด ไม่คุมนอกเวลา (Pete decision)
                   actionMode="release" → ปุ่มที่สอง = "ทิ้งงาน" (handleReleaseCase) */
                <div className="overflow-hidden rounded-2xl border border-peach bg-white shadow-sm">
                  {/* ===== Desktop table (≥ md) ===== */}
                  <div className="hidden overflow-x-auto md:block">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-peach bg-emerald-50 text-left text-xs font-semibold text-ink-soft">
                          <th className="px-4 py-3">ลูกค้า</th>
                          <th className="px-4 py-3">ร้าน</th>
                          <th className="px-4 py-3 text-center">เกรด · ค้าง</th>
                          <th className="px-4 py-3 text-right">งวด</th>
                          <th className="px-4 py-3 text-right">ยอดต้องชำระวันนี้</th>
                          <th className="px-4 py-3">รายละเอียด</th>
                          <th className="px-4 py-3" />
                        </tr>
                      </thead>
                      <tbody>
                        {sortedMyScoredRows.map((sr) => (
                          <QueueRow
                            key={sr.row.contractId}
                            sr={sr}
                            outsideHours={outsideHours}
                            enforceCallHours={false}
                            actionMode="release"
                            claimingId={claimingId}
                            onSelect={handleOpenCase}
                            onClaim={handleClaimCase}
                            onRelease={handleReleaseCase}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* ===== Mobile card stack (< md) ===== */}
                  <div className="flex flex-col divide-y divide-peach/60 md:hidden">
                    {sortedMyScoredRows.map((sr) => (
                      <QueueCardMobile
                        key={sr.row.contractId}
                        sr={sr}
                        outsideHours={outsideHours}
                        enforceCallHours={false}
                        actionMode="release"
                        claimingId={claimingId}
                        onSelect={handleOpenCase}
                        onClaim={handleClaimCase}
                        onRelease={handleReleaseCase}
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* === Tab 2: คืนเครื่อง === */}
          {activeTab === 'returned' && (
            <>
              {returnedRows.length === 0 ? (
                searchTerm.trim() ? (
                  <EmptyState
                    title="ไม่พบลูกค้าที่ค้นหา"
                    hint="ลองเปลี่ยนคำค้นหา หรือล้างช่องค้นหาเพื่อดูทั้งหมด"
                  />
                ) : (
                  <EmptyState
                    title="ยังไม่มีเคสคืนเครื่องที่ต้องตาม"
                    hint="เมื่อมีสัญญาที่คืนเครื่องแล้วแต่ยังค้างยอดปิด จะปรากฏที่นี่"
                  />
                )
              ) : (
                <div className="overflow-hidden rounded-2xl border border-peach bg-white shadow-sm">
                  {/* ===== Desktop table (≥ md) ===== */}
                  <div className="hidden overflow-x-auto md:block">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-peach bg-indigo-50 text-left text-xs font-semibold text-ink-soft">
                          <th className="px-4 py-3">ลูกค้า</th>
                          <th className="px-4 py-3">ร้าน</th>
                          <th className="px-4 py-3 text-center">เกรด</th>
                          <th className="px-4 py-3 text-center">ระยะเวลา</th>
                          <th className="px-4 py-3 text-right">ยอดปิด</th>
                          <th className="px-4 py-3" />
                        </tr>
                      </thead>
                      <tbody>
                        {pagedReturnedRows.map((r) => {
                          const days = r.returnAnchorDate ? daysSinceAnchor(r.returnAnchorDate, todayStr) : null
                          return (
                            <tr
                              key={r.contractId}
                              className="border-b border-peach last:border-0 hover:bg-indigo-50/40"
                            >
                              <td className="px-4 py-3">
                                <p className="font-medium text-ink">{r.customerName}</p>
                                <p className="text-xs text-ink-soft">{r.contractNo}</p>
                                {r.deviceModel && (
                                  <p className="text-xs text-ink-soft">📱 {r.deviceModel}</p>
                                )}
                                {r.phone && <p className="text-xs text-ink-soft">{r.phone}</p>}
                                {(r.phoneAlt1 || r.phoneAlt2) && (
                                  <p className="text-xs text-ink-soft">
                                    📞 สำรอง: {[r.phoneAlt1, r.phoneAlt2].filter(Boolean).join(', ')}
                                  </p>
                                )}
                                {r.returnAnchorType === 'returned' && r.returnedAt && (
                                  <p className="mt-0.5 text-xs text-indigo-600">
                                    คืนเมื่อ {thaiDate(r.returnedAt)}
                                  </p>
                                )}
                                {r.returnAnchorType === 'overdue' && r.overdueDueDate && (
                                  <p className="mt-0.5 text-xs text-indigo-600">
                                    ครบกำหนดงวด {thaiDate(r.overdueDueDate)}
                                  </p>
                                )}
                              </td>
                              <td className="px-4 py-3 text-sm text-ink-soft">{r.shopName}</td>
                              <td className="px-4 py-3 text-center">
                                <Badge tone={GRADE_TONE[r.grade]}>เกรด {r.grade}</Badge>
                              </td>
                              <td className="px-4 py-3 text-center">
                                {days !== null ? (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-semibold text-indigo-700">
                                    <PackageCheck size={12} />
                                    {r.returnAnchorType === 'overdue' ? `ค้าง ${days} วัน` : `${days} วัน`}
                                  </span>
                                ) : (
                                  <span className="text-ink-soft">—</span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-right">
                                <span className="font-semibold text-indigo-700 whitespace-nowrap">
                                  {baht(r.returnClosingAmount)} ฿
                                </span>
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex flex-col items-stretch gap-1.5">
                                  <button
                                    onClick={() => handleOpenCase(r)}
                                    className="whitespace-nowrap rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-100"
                                  >
                                    บันทึกติดตาม
                                  </button>
                                  {/* req: รับเคสคืนเครื่องมาดูแล — reuse handleClaimCase เดิม */}
                                  <button
                                    onClick={() => handleClaimCase(r)}
                                    className="inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100"
                                  >
                                    <UserCheck size={13} />
                                    ฉันดูแลเคสนี้
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    <div className="border-t border-peach px-4">
                      <Pagination
                        total={sortedReturnedRows.length}
                        page={page}
                        pageSize={pageSize}
                        onPageChange={setPage}
                        onPageSizeChange={handlePageSizeChange}
                        pageSizeOptions={[20, 50, 100]}
                      />
                    </div>
                  </div>

                  {/* ===== Mobile card stack (< md) ===== */}
                  <div className="flex flex-col divide-y divide-peach/60 md:hidden">
                    {pagedReturnedRows.map((r) => {
                      const days = r.returnAnchorDate ? daysSinceAnchor(r.returnAnchorDate, todayStr) : null
                      return (
                        <div key={r.contractId} className="p-4">
                          <div className="mb-2 flex items-start gap-2">
                            <div className="flex-1 min-w-0">
                              <p className="font-semibold text-ink">{r.customerName}</p>
                              <p className="text-xs text-ink-soft">{r.contractNo} · {r.shopName}</p>
                              {r.deviceModel && <p className="text-xs text-ink-soft">📱 {r.deviceModel}</p>}
                              {r.phone && <p className="text-xs text-ink-soft">{r.phone}</p>}
                              {(r.phoneAlt1 || r.phoneAlt2) && (
                                <p className="text-xs text-ink-soft">
                                  📞 สำรอง: {[r.phoneAlt1, r.phoneAlt2].filter(Boolean).join(', ')}
                                </p>
                              )}
                              {r.returnAnchorType === 'returned' && r.returnedAt && (
                                <p className="mt-0.5 text-xs text-indigo-600">
                                  คืนเมื่อ {thaiDate(r.returnedAt)}
                                </p>
                              )}
                              {r.returnAnchorType === 'overdue' && r.overdueDueDate && (
                                <p className="mt-0.5 text-xs text-indigo-600">
                                  ครบกำหนดงวด {thaiDate(r.overdueDueDate)}
                                </p>
                              )}
                              <div className="mt-1 flex flex-wrap gap-2">
                                <Badge tone={GRADE_TONE[r.grade]}>เกรด {r.grade}</Badge>
                                {days !== null && (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-semibold text-indigo-700">
                                    <PackageCheck size={12} />
                                    {r.returnAnchorType === 'overdue' ? `ค้างมาแล้ว ${days} วัน` : `คืนมาแล้ว ${days} วัน`}
                                  </span>
                                )}
                                <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-semibold text-indigo-700">
                                  ยอดปิด {baht(r.returnClosingAmount)} ฿
                                </span>
                              </div>
                            </div>
                          </div>
                          <div className="flex flex-col gap-1.5">
                            <button
                              onClick={() => handleOpenCase(r)}
                              className="w-full rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-100"
                            >
                              บันทึกติดตาม
                            </button>
                            {/* req: รับเคสคืนเครื่องมาดูแล — reuse handleClaimCase เดิม */}
                            <button
                              onClick={() => handleClaimCase(r)}
                              className="inline-flex w-full items-center justify-center gap-1 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-100"
                            >
                              <UserCheck size={14} />
                              ฉันดูแลเคสนี้
                            </button>
                          </div>
                        </div>
                      )
                    })}
                    <div className="border-t border-peach px-4">
                      <Pagination
                        total={sortedReturnedRows.length}
                        page={page}
                        pageSize={pageSize}
                        onPageChange={setPage}
                        onPageSizeChange={handlePageSizeChange}
                        pageSizeOptions={[20, 50, 100]}
                      />
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* === Tab 3: ปิดเคสวันนี้ === */}
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
                    title="ยังไม่มีเคสที่ปิดวันนี้"
                    hint="เมื่อกด 'ยืนยันปิดเคส' ในหน้าต่างบันทึกการติดตาม รายการจะมาที่นี่"
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
                          <th className="px-4 py-3"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {pagedTodayRows.map((r) => (
                          <tr
                            key={r.contractId}
                            className="cursor-pointer border-b border-peach last:border-0 hover:bg-peach-light/40 transition-colors"
                            onClick={() => handleOpenCase(r)}
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
                            <td className="px-4 py-3 text-ink-soft">
                              <ChevronRight size={16} className="text-ink-soft/60" />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="border-t border-peach px-4">
                      <Pagination
                        total={todayRows.length}
                        page={page}
                        pageSize={pageSize}
                        onPageChange={setPage}
                        onPageSizeChange={handlePageSizeChange}
                        pageSizeOptions={[20, 50, 100]}
                      />
                    </div>
                  </div>

                  {/* ===== Mobile card stack (< md) ===== */}
                  <div className="flex flex-col gap-3 md:hidden">
                    {pagedTodayRows.map((r) => (
                      <div
                        key={r.contractId}
                        className="cursor-pointer rounded-2xl border border-peach bg-white p-4 shadow-sm transition-colors hover:bg-peach-light/40 active:bg-peach-light"
                        onClick={() => handleOpenCase(r)}
                      >
                        <div className="mb-1 flex items-start justify-between gap-2">
                          <div>
                            <p className="font-semibold text-ink">{r.customerName}</p>
                            <p className="text-xs text-ink-soft">{r.contractNo}</p>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Badge tone={GRADE_TONE[r.grade]}>เกรด {r.grade}</Badge>
                            <ChevronRight size={16} className="text-ink-soft/60" />
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-ink-soft">
                          <span>ผล: <span className="text-ink">{r.lastResult !== null ? RESULT_LABEL[r.lastResult] : '-'}</span></span>
                          <span>เวลา: {r.lastContactedAt !== null ? relativeContactTime(r.lastContactedAt) : '-'}</span>
                          <span>โดย: {r.lastContactedByName ?? '-'}</span>
                        </div>
                      </div>
                    ))}
                    <Pagination
                      total={todayRows.length}
                      page={page}
                      pageSize={pageSize}
                      onPageChange={setPage}
                      onPageSizeChange={handlePageSizeChange}
                      pageSizeOptions={[20, 50, 100]}
                    />
                  </div>
                </>
              )}
            </>
          )}
        </>
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
            overdueAmount: selectedContract.overdueAmount,
            color: selectedContract.color,
            isReturned: selectedContract.isReturned,
            returnClosingAmount: selectedContract.returnClosingAmount,
            returnedAt: selectedContract.returnedAt,
            returnAnchorType: selectedContract.returnAnchorType,
            returnAnchorDate: selectedContract.returnAnchorDate,
            overdueDueDate: selectedContract.overdueDueDate,
            lastContactedAt: selectedContract.lastContactedAt,
            isActive: !selectedContract.caseClosedToday,
            dueDay: selectedContract.dueDay,
            transactionDate: selectedContract.transactionDate,
          }}
          softWarnReason={(() => {
            const sr = scoredRowMap.get(selectedContract.contractId)?.suppressReason ?? null
            return sr === 'CAP' || sr === 'PROMISE_PENDING' ? sr : null
          })()}
          promiseToPayDate={selectedContract.promiseToPayDate ?? null}
          publicHolidays={publicHolidays}
          adminOverride={role === 'admin'}
          alreadyClosed={selectedContract.caseClosedToday}
          onClose={handleModalClose}
          onSaved={() => {
            // #4: patch แถวเดียว (selectedContract ยังไม่ null ในสโคปนี้) — ไม่ re-fetch ทั้งคิว
            void refreshQueueRow(selectedContract.contractId)
          }}
          onCaseClosed={() => {
            const contractId = selectedContract.contractId
            setSelectedContract(null)
            void refreshQueueRow(contractId)
          }}
        />
      )}
    </div>
  )
}
