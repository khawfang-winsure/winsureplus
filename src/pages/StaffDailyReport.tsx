import { useCallback, useEffect, useMemo, useState } from 'react'
import { useFilter } from '../lib/useFilter'
import {
  CalendarPlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  FileCheck,
  Mail,
  Phone,
  RefreshCw,
  TrendingDown,
  Truck,
  type LucideIcon,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { Badge, Button, EmptyState, Input, Loading, PageTitle, Select } from '../components/ui'
import { getDailyAudit } from '../lib/db'
import type { AuditEvent, AuditEventType } from '../lib/types'

/** วันนี้ตามเขตเวลากรุงเทพ (UTC+7) รูปแบบ YYYY-MM-DD */
function todayBangkok(): string {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)
}

/** วันก่อนหน้า/ถัดไปของวันที่ ISO ที่ระบุ (บวก/ลบวัน) */
function shiftDay(isoDate: string, delta: number): string {
  const d = new Date(isoDate + 'T00:00:00')
  d.setDate(d.getDate() + delta)
  return d.toLocaleString('en-CA').slice(0, 10)
}

// ===== ตัวช่วยฟอร์แมตวันเวลา =====
const MONTH_SHORT: string[] = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
]

function fmtDatetime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '-'
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    day: 'numeric',
    month: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const day = get('day')
  const mon = MONTH_SHORT[Number(get('month')) - 1] ?? ''
  const hh = get('hour')
  const mm = get('minute')
  return `${day} ${mon} ${hh}:${mm}`
}

function fmtDateLabel(isoDate: string): string {
  // isoDate = "2026-06-13"
  const d = new Date(isoDate + 'T00:00:00')
  if (isNaN(d.getTime())) return isoDate
  const day = d.getDate()
  const mon = MONTH_SHORT[d.getMonth()]
  const year = d.getFullYear() + 543
  const DOW = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์']
  return `วัน${DOW[d.getDay()]}ที่ ${day} ${mon} ${year}`
}

// ===== Icon + color ต่อ eventType =====
type IconDef = { icon: LucideIcon; cls: string }

const EVENT_ICON: Record<AuditEventType, IconDef> = {
  payment:                  { icon: CreditCard,   cls: 'text-green-600' },
  grade_change:             { icon: TrendingDown, cls: 'text-amber-600' },
  email_sent:               { icon: Mail,         cls: 'text-blue-600' },
  summary_sent:             { icon: FileCheck,    cls: 'text-purple-600' },
  summary_shop_sent:        { icon: FileCheck,    cls: 'text-purple-600' },
  summary_accounting_sent:  { icon: FileCheck,    cls: 'text-fuchsia-600' },
  follow_up:                { icon: Phone,        cls: 'text-gray-500' },
  extension:                { icon: CalendarPlus, cls: 'text-indigo-600' },
  device_status:            { icon: Truck,        cls: 'text-orange-600' },
}

const EVENT_LABEL: Record<AuditEventType, string> = {
  payment:                  'การชำระ',
  grade_change:             'เปลี่ยนเกรด',
  email_sent:               'ส่งอีเมล',
  summary_sent:             'ส่งสรุปยอด',
  summary_shop_sent:        'สรุปยอด · ส่งร้าน',
  summary_accounting_sent:  'สรุปยอด · ส่งบัญชี',
  follow_up:                'บันทึกติดตาม',
  extension:                'ขยายระยะเวลา',
  device_status:            'สถานะเครื่อง',
}

// ===== ตัวเลือก filter =====

const EVENT_TYPE_OPTIONS: { value: AuditEventType | 'all'; label: string }[] = [
  { value: 'all',                      label: 'ทุกประเภท' },
  { value: 'payment',                  label: EVENT_LABEL['payment'] },
  { value: 'grade_change',             label: EVENT_LABEL['grade_change'] },
  { value: 'email_sent',               label: EVENT_LABEL['email_sent'] },
  { value: 'summary_shop_sent',        label: EVENT_LABEL['summary_shop_sent'] },
  { value: 'summary_accounting_sent',  label: EVENT_LABEL['summary_accounting_sent'] },
  { value: 'follow_up',                label: EVENT_LABEL['follow_up'] },
  { value: 'extension',                label: EVENT_LABEL['extension'] },
  { value: 'device_status',            label: EVENT_LABEL['device_status'] },
]

// ===== grouping types =====

/** key = "YYYY-MM-DD" */
type DateGroup = {
  date: string
  actors: ActorGroup[]
}

type ActorGroup = {
  actor: string
  buckets: TypeBucket[]
  total: number
}

type TypeBucket = {
  eventType: AuditEventType
  events: AuditEvent[]
}

// ===== group events: date → actor → eventType =====
// หน้านี้โหลดข้อมูลของ "วันเดียว" (selectedDay ตามเวลาไทย) เสมอ — ใช้ selectedDay
// เป็น date key ตรงๆ แทนการ derive จาก e.at (ซึ่งเป็น UTC และจะเพี้ยนวันสำหรับ
// เคสที่เกิดช่วง Bangkok 00:00–06:59)
function groupEvents(events: AuditEvent[], selectedDay: string): DateGroup[] {
  // date → actor → eventType → events[]
  const dateMap = new Map<string, Map<string, Map<AuditEventType, AuditEvent[]>>>()
  const date = selectedDay

  for (const e of events) {
    if (!dateMap.has(date)) dateMap.set(date, new Map())
    const actorMap = dateMap.get(date)!
    if (!actorMap.has(e.actor)) actorMap.set(e.actor, new Map())
    const typeMap = actorMap.get(e.actor)!
    if (!typeMap.has(e.eventType)) typeMap.set(e.eventType, [])
    typeMap.get(e.eventType)!.push(e)
  }

  const dateGroups: DateGroup[] = []
  // dates newest first
  const dates = [...dateMap.keys()].sort().reverse()
  for (const date of dates) {
    const actorMap = dateMap.get(date)!
    const actors: ActorGroup[] = []
    for (const [actor, typeMap] of actorMap.entries()) {
      const buckets: TypeBucket[] = []
      let total = 0
      for (const [eventType, evs] of typeMap.entries()) {
        buckets.push({ eventType, events: evs })
        total += evs.length
      }
      actors.push({ actor, buckets, total })
    }
    // actors alphabetical
    actors.sort((a, b) => a.actor.localeCompare(b.actor, 'th'))
    dateGroups.push({ date, actors })
  }
  return dateGroups
}

// ===== drilldown row สำหรับ event เดี่ยว =====
function EventDrillRow({ event }: { event: AuditEvent }) {
  return (
    <li className="flex items-baseline gap-2 py-1 text-sm">
      <span className="w-16 shrink-0 text-xs text-ink-soft">{fmtDatetime(event.at).split(' ').slice(1).join(' ')}</span>
      {event.customerName && (
        <span className="font-medium text-ink">{event.customerName}</span>
      )}
      {event.contractNo && event.contractId ? (
        <Link
          to={`/contract/${event.contractId}`}
          className="text-xs text-salmon-deep underline underline-offset-2 hover:brightness-90"
        >
          {event.contractNo}
        </Link>
      ) : event.contractNo ? (
        <span className="text-xs text-ink-soft">{event.contractNo}</span>
      ) : null}
      {event.action && (
        <span className="text-xs text-ink-soft">— {event.action}</span>
      )}
    </li>
  )
}

// ===== TypeBucket accordion =====
function TypeBucketRow({
  bucket,
  expandKey,
  expanded,
  onToggle,
}: {
  bucket: TypeBucket
  expandKey: string
  expanded: boolean
  onToggle: (key: string) => void
}) {
  const { icon: Icon, cls } = EVENT_ICON[bucket.eventType]
  const label = EVENT_LABEL[bucket.eventType]

  return (
    <div className="mb-1">
      <button
        className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm hover:bg-peach-light/40 transition-colors"
        onClick={() => onToggle(expandKey)}
        aria-expanded={expanded}
      >
        {expanded
          ? <ChevronDown size={14} className="shrink-0 text-ink-soft" />
          : <ChevronRight size={14} className="shrink-0 text-ink-soft" />}
        <Icon size={15} className={cls} />
        <span className="text-ink">
          {label}
        </span>
        <Badge tone="neutral">{bucket.events.length}</Badge>
        <span className="ml-1 text-xs text-ink-soft">รายการ</span>
      </button>
      {expanded && (
        <ul className="ml-8 mt-1 border-l-2 border-peach pl-3">
          {bucket.events.map((e) => (
            <EventDrillRow key={e.id} event={e} />
          ))}
        </ul>
      )}
    </div>
  )
}

// ===== ActorGroup card =====
function ActorGroupCard({
  group,
  date,
  openKeys,
  onToggle,
}: {
  group: ActorGroup
  date: string
  openKeys: Set<string>
  onToggle: (key: string) => void
}) {
  const actorKey = `${date}|${group.actor}`
  const isOpen = openKeys.has(actorKey)

  return (
    <div className="rounded-xl border border-peach bg-white">
      {/* actor header */}
      <button
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-peach-light/30 transition-colors rounded-xl"
        onClick={() => onToggle(actorKey)}
        aria-expanded={isOpen}
      >
        <div className="flex items-center gap-2">
          {isOpen
            ? <ChevronDown size={16} className="text-ink-soft" />
            : <ChevronRight size={16} className="text-ink-soft" />}
          <span className="font-semibold text-ink">{group.actor}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {group.buckets.map((b) => {
            const { icon: Icon, cls } = EVENT_ICON[b.eventType]
            return (
              <span key={b.eventType} className="flex items-center gap-1 text-xs text-ink-soft">
                <Icon size={12} className={cls} />
                {EVENT_LABEL[b.eventType]} {b.events.length}
              </span>
            )
          })}
          <Badge tone="neutral">{group.total} รายการ</Badge>
        </div>
      </button>

      {/* drilldown */}
      {isOpen && (
        <div className="border-t border-peach px-4 py-3">
          {group.buckets.map((b) => {
            const typeKey = `${date}|${group.actor}|${b.eventType}`
            return (
              <TypeBucketRow
                key={b.eventType}
                bucket={b}
                expandKey={typeKey}
                expanded={openKeys.has(typeKey)}
                onToggle={onToggle}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

// ===== DateSection =====
function DateSection({
  group,
  openKeys,
  onToggle,
}: {
  group: DateGroup
  openKeys: Set<string>
  onToggle: (key: string) => void
}) {
  const total = group.actors.reduce((s, a) => s + a.total, 0)
  return (
    <div className="mb-6">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-ink">{fmtDateLabel(group.date)}</h2>
        <span className="text-xs text-ink-soft">({total} รายการ)</span>
      </div>
      <div className="flex flex-col gap-2">
        {group.actors.map((a) => (
          <ActorGroupCard
            key={a.actor}
            group={a}
            date={group.date}
            openKeys={openKeys}
            onToggle={onToggle}
          />
        ))}
      </div>
    </div>
  )
}

// ===== หน้าหลัก =====
export default function StaffDailyReport() {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [selectedDay, setSelectedDay] = useState<string>(() => todayBangkok())
  const [filterType, setFilterType] = useFilter<AuditEventType | 'all'>('staff-daily-report.filterType', 'all')
  const [filterActor, setFilterActor] = useFilter<string>('staff-daily-report.filterActor', 'all')

  const [tick, setTick] = useState(0)
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set())

  const doRefresh = useCallback(() => {
    setTick((n) => n + 1)
  }, [])

  const toggleKey = useCallback((key: string) => {
    setOpenKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  useEffect(() => {
    if (!loading) setRefreshing(true)
    setError(null)
    getDailyAudit(selectedDay)
      .then((data) => {
        setEvents(data)
        setFilterActor((prev) =>
          prev === 'all' || data.some((e) => e.actor === prev) ? prev : 'all',
        )
        setLoading(false)
        setRefreshing(false)
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ')
        setLoading(false)
        setRefreshing(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDay, tick])

  const actorOptions = useMemo<string[]>(() => {
    const seen = new Set<string>()
    for (const e of events) seen.add(e.actor)
    return Array.from(seen).sort((a, b) => a.localeCompare(b, 'th'))
  }, [events])

  const filtered = useMemo(() => {
    return events.filter((e) => {
      if (filterType !== 'all' && e.eventType !== filterType) return false
      if (filterActor !== 'all' && e.actor !== filterActor) return false
      return true
    })
  }, [events, filterType, filterActor])

  const grouped = useMemo(() => groupEvents(filtered, selectedDay), [filtered, selectedDay])

  if (loading) return <Loading label="กำลังโหลดข้อมูลรายงาน..." />

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageTitle
          sub="สรุปกิจกรรมพนักงานรายวัน — กดขยายเพื่อดูรายละเอียด"
          count={loading ? undefined : { shown: filtered.length, total: events.length }}
        >
          รายงานการทำงานพนักงานรายวัน
        </PageTitle>

        {/* filter row + refresh */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              onClick={() => setSelectedDay((d) => shiftDay(d, -1))}
              disabled={refreshing}
              aria-label="วันก่อนหน้า"
              className="!px-2"
            >
              <ChevronLeft size={15} />
            </Button>
            <Input
              type="date"
              value={selectedDay}
              onChange={(e) => setSelectedDay(e.target.value)}
              className="w-auto text-sm"
              disabled={refreshing}
            />
            <Button
              variant="ghost"
              onClick={() => setSelectedDay((d) => shiftDay(d, 1))}
              disabled={refreshing || selectedDay >= todayBangkok()}
              aria-label="วันถัดไป"
              className="!px-2"
            >
              <ChevronRight size={15} />
            </Button>
          </div>

          <Select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value as AuditEventType | 'all')}
            className="w-40 text-sm"
            disabled={refreshing}
          >
            {EVENT_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </Select>

          <Select
            value={filterActor}
            onChange={(e) => setFilterActor(e.target.value)}
            className="w-36 text-sm"
            disabled={refreshing}
          >
            <option value="all">ทุกคน</option>
            {actorOptions.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </Select>

          <Button
            variant="ghost"
            onClick={doRefresh}
            disabled={refreshing}
            aria-label="โหลดข้อมูลใหม่"
          >
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? 'กำลังโหลด...' : 'รีเฟรช'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          โหลดข้อมูลไม่สำเร็จ: {error}
        </div>
      )}

      {!error && grouped.length === 0 ? (
        <EmptyState
          title="ยังไม่มีกิจกรรมในวันนี้"
          hint="ลองเปลี่ยนวันที่ หรือเปลี่ยนตัวกรอง"
        />
      ) : (
        <div>
          {grouped.map((g) => (
            <DateSection
              key={g.date}
              group={g}
              openKeys={openKeys}
              onToggle={toggleKey}
            />
          ))}
        </div>
      )}
    </div>
  )
}
