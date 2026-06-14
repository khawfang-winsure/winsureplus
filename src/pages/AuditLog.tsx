import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CalendarPlus,
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
import { Button, EmptyState, Loading, PageTitle, Select } from '../components/ui'
import { getAuditTimeline } from '../lib/db'
import type { AuditEvent, AuditEventType } from '../lib/types'

// ===== ตัวช่วยฟอร์แมตวันเวลา =====
const MONTH_SHORT: string[] = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
]

function fmtDatetime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '-'
  const day = d.getDate()
  const mon = MONTH_SHORT[d.getMonth()]
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${day} ${mon} ${hh}:${mm}`
}

// ===== Icon + color ต่อ eventType =====
type IconDef = { icon: LucideIcon; cls: string }

const EVENT_ICON: Record<AuditEventType, IconDef> = {
  payment:       { icon: CreditCard,  cls: 'text-green-600' },
  grade_change:  { icon: TrendingDown, cls: 'text-amber-600' },
  email_sent:    { icon: Mail,         cls: 'text-blue-600' },
  summary_sent:  { icon: FileCheck,    cls: 'text-purple-600' },
  follow_up:     { icon: Phone,        cls: 'text-gray-500' },
  extension:     { icon: CalendarPlus, cls: 'text-indigo-600' },
  device_status: { icon: Truck,        cls: 'text-orange-600' },
}

// ===== ป้ายชื่อ eventType ภาษาไทย =====
const EVENT_LABEL: Record<AuditEventType, string> = {
  payment:       'การชำระ',
  grade_change:  'เปลี่ยนเกรด',
  email_sent:    'ส่งอีเมล',
  summary_sent:  'ส่งสรุปยอด',
  follow_up:     'บันทึกติดตาม',
  extension:     'ขยายระยะเวลา',
  device_status: 'สถานะเครื่อง',
}

// ===== ตัวเลือก filter =====
type DaysBack = 7 | 30 | 90

const DAYS_OPTIONS: { value: DaysBack; label: string }[] = [
  { value: 7,  label: '7 วันล่าสุด' },
  { value: 30, label: '30 วันล่าสุด' },
  { value: 90, label: '90 วันล่าสุด' },
]

const EVENT_TYPE_OPTIONS: { value: AuditEventType | 'all'; label: string }[] = [
  { value: 'all',          label: 'ทุกประเภท' },
  { value: 'payment',      label: EVENT_LABEL['payment'] },
  { value: 'grade_change', label: EVENT_LABEL['grade_change'] },
  { value: 'email_sent',   label: EVENT_LABEL['email_sent'] },
  { value: 'summary_sent', label: EVENT_LABEL['summary_sent'] },
  { value: 'follow_up',    label: EVENT_LABEL['follow_up'] },
  { value: 'extension',    label: EVENT_LABEL['extension'] },
  { value: 'device_status',label: EVENT_LABEL['device_status'] },
]

// ===== รายการ audit เดี่ยว =====
function TimelineRow({ event }: { event: AuditEvent }) {
  const { icon: Icon, cls } = EVENT_ICON[event.eventType]

  return (
    <li className="flex gap-3 rounded-xl border border-peach bg-white px-4 py-3">
      {/* icon */}
      <div className="mt-0.5 shrink-0">
        <Icon size={18} className={cls} />
      </div>

      {/* content */}
      <div className="min-w-0 flex-1">
        {/* บรรทัด 1: วันเวลา + ลูกค้า + สัญญา */}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-xs text-ink-soft">{fmtDatetime(event.at)}</span>
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
        </div>

        {/* บรรทัด 2: ผู้ทำ */}
        <p className="mt-0.5 text-xs text-ink-soft">
          โดย <span className="font-medium text-ink">{event.actor}</span>
        </p>

        {/* บรรทัด 3: action + details */}
        <p className="mt-1 text-sm text-ink">
          {event.action}
          {event.details && (
            <span className="ml-1 text-xs text-ink-soft">— {event.details}</span>
          )}
        </p>
      </div>
    </li>
  )
}

// ===== หน้าหลัก =====
export default function AuditLog() {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // filter state
  const [daysBack, setDaysBack] = useState<DaysBack>(30)
  const [filterType, setFilterType] = useState<AuditEventType | 'all'>('all')
  const [filterActor, setFilterActor] = useState<string>('all')

  // fetch ใหม่เมื่อ daysBack เปลี่ยน หรือกด refresh (tick)
  const [tick, setTick] = useState(0)

  const doRefresh = useCallback(() => {
    setTick((n) => n + 1)
  }, [])

  useEffect(() => {
    if (!loading) setRefreshing(true)
    setError(null)
    getAuditTimeline(daysBack, 200)
      .then((data) => {
        setEvents(data)
        // reset actor filter only if the selected actor no longer exists in new data
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
  }, [daysBack, tick])

  // รายชื่อ actor ที่ไม่ซ้ำกัน
  const actorOptions = useMemo<string[]>(() => {
    const seen = new Set<string>()
    for (const e of events) seen.add(e.actor)
    return Array.from(seen).sort((a, b) => a.localeCompare(b, 'th'))
  }, [events])

  // client-side filter
  const filtered = useMemo(() => {
    return events.filter((e) => {
      if (filterType !== 'all' && e.eventType !== filterType) return false
      if (filterActor !== 'all' && e.actor !== filterActor) return false
      return true
    })
  }, [events, filterType, filterActor])

  if (loading) return <Loading label="กำลังโหลดประวัติการใช้งาน..." />

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      {/* หัวข้อ */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageTitle
          sub="200 รายการล่าสุด · ข้อมูลจากทุกกิจกรรมในระบบ"
          count={loading ? undefined : { shown: filtered.length, total: events.length }}
        >
          ประวัติการใช้งานระบบ
        </PageTitle>

        {/* filter row + refresh */}
        <div className="flex flex-wrap items-center gap-2">
          {/* ประเภทกิจกรรม */}
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

          {/* ผู้ทำ */}
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

          {/* ช่วงวัน (trigger refetch) */}
          <Select
            value={daysBack}
            onChange={(e) => setDaysBack(Number(e.target.value) as DaysBack)}
            className="w-36 text-sm"
            disabled={refreshing}
          >
            {DAYS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </Select>

          {/* Refresh */}
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

      {/* error */}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          โหลดข้อมูลไม่สำเร็จ: {error}
        </div>
      )}

      {/* list */}
      {!error && filtered.length === 0 ? (
        <EmptyState
          title="ยังไม่มีกิจกรรมในช่วงนี้"
          hint="ลองขยายช่วงวัน หรือเปลี่ยนตัวกรอง"
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {filtered.map((e) => (
            <TimelineRow key={e.id} event={e} />
          ))}
        </ul>
      )}
    </div>
  )
}
