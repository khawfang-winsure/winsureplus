import { useEffect, useMemo, useState } from 'react'
import { Download, ChevronRight, X, Clock } from 'lucide-react'
import { Button, Card, PageTitle, Badge, Loading, EmptyState } from '../components/ui'
import {
  DateRangePicker,
  loadStoredRange,
  fmtThaiShort,
  daysBetween,
  type DateRange,
} from '../components/DateRangePicker'
import {
  getFreelancerHrByDay,
  getFreelancerHrDailyLog,
  getCollectorCallOutcomes,
  getCollectorScorecard,
  type HrByDayRow,
  type HrDailyLogRow,
} from '../lib/db'
import type { CollectorCallOutcome } from '../lib/types'
import { escCell, downloadCSV } from '../lib/csv'

// ===== ตัวช่วยแสดงผล =====

const todayISO = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)

/** range === null ("ทั้งหมด") → ขอบเขตจริง (date param รับ null ไม่ได้) */
function effectiveRange(range: DateRange | null): DateRange {
  return range ?? { start: '2020-01-01', end: todayISO }
}

/** จำนวนเต็ม: 0 → "—" */
function fmtInt(n: number): string {
  if (n === 0) return '—'
  return n.toLocaleString('th-TH')
}

/** เงิน: "฿1,234" หรือ "—" ถ้า 0 */
function fmtBaht(n: number): string {
  if (!n) return '—'
  return `฿${Math.round(n).toLocaleString('th-TH')}`
}

/** อัตราติดต่อได้ = reached / attempts × 100 — null ถ้า attempts=0 */
function contactPct(reached: number, attempts: number): number | null {
  if (attempts <= 0) return null
  return Math.round((reached / attempts) * 100)
}
function fmtPct(v: number | null): string {
  return v === null ? 'N/A' : `${v}%`
}
function pctCls(v: number | null): string {
  if (v === null) return 'text-ink-soft'
  if (v >= 60) return 'font-semibold text-green-700'
  if (v < 30) return 'font-semibold text-red-600'
  return 'text-ink'
}

/** 'YYYY-MM-DD' → 'จ. 12 มิ.ย.' (สั้น) — reuse fmtThaiShort + ชื่อวัน */
const WEEKDAY_TH = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.']
function fmtDay(iso: string): string {
  const d = new Date(iso + 'T00:00:00+07:00')
  if (isNaN(d.getTime())) return iso
  return `${WEEKDAY_TH[d.getDay()]} ${fmtThaiShort(iso)}`
}

/** min ของ 'HH:MM' (ข้าม null) */
function minTime(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a < b ? a : b
}
/** max ของ 'HH:MM' (ข้าม null) */
function maxTime(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}

// ===== label maps สำหรับ drill-down (fallback กันค่าที่ไม่รู้จัก) =====
const METHOD_LABEL: Record<string, string> = {
  phone: 'โทรศัพท์',
  line: 'LINE',
  sms: 'SMS',
  visit: 'ไปพบ',
  other: 'อื่นๆ',
}
const RESULT_LABEL: Record<string, string> = {
  contacted: 'ติดต่อสำเร็จ',
  no_answer: 'ไม่รับสาย',
  promised: 'สัญญาจะชำระ',
  refused: 'ปฏิเสธ',
  paid: 'ชำระแล้ว',
  returned: 'คืนเครื่อง',
  line_pending: 'นัดทาง LINE – รอลูกค้า',
  other: 'อื่นๆ',
}
const RESULT_TONE: Record<string, 'green' | 'amber' | 'red' | 'neutral'> = {
  contacted: 'green',
  no_answer: 'amber',
  promised: 'amber',
  refused: 'red',
  paid: 'green',
  returned: 'neutral',
  line_pending: 'amber',
  other: 'neutral',
}
function methodLabel(m: string): string {
  return METHOD_LABEL[m] ?? m
}
function resultLabel(r: string): string {
  return RESULT_LABEL[r] ?? r
}
function resultTone(r: string): 'green' | 'amber' | 'red' | 'neutral' {
  return RESULT_TONE[r] ?? 'neutral'
}

/** โทรหาใคร: ลูกหนี้ / ญาติ+ชื่อ+ความสัมพันธ์ */
function contactWho(row: HrDailyLogRow): string {
  if (row.contactTarget === 'debtor') return 'ลูกหนี้'
  const name = row.contactPersonName?.trim()
  const rel = row.contactPersonRelation?.trim()
  if (name && rel) return `${name} (${rel})`
  if (name) return name
  return 'ผู้ติดต่อ'
}

/** เวลา 'HH:MM' จาก ISO createdAt (โซนไทย) */
function fmtTimeFromIso(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '-'
  return d.toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Bangkok',
    hour12: false,
  })
}

// ===== rollup รายคน =====
interface PersonSummary {
  authorId: string
  authorName: string
  workDays: number          // วันที่มีบันทึกอย่างน้อย 1 รายการ
  logsTotal: number         // บันทึกรวม
  distinctCases: number     // เคสที่ดูแล (distinct — จาก call outcomes casesFollowed)
  avgPerDay: number         // เฉลี่ยบันทึก/วันทำงาน
  reached: number
  attempts: number
  contactRate: number | null
  debtorCount: number
  otherCount: number
  demands: number
  promisesMade: number
  promisesKept: number
  collectedBaht: number
  morning: number
  afternoon: number
  evening: number
  firstActivity: string | null
  lastActivity: string | null
  days: HrByDayRow[]        // แถวรายวันของคนนี้ (เรียงวัน) — ใช้ในมุมมองรายวัน
}

function rollup(
  byDay: HrByDayRow[],
  callOutcomes: Map<string, CollectorCallOutcome>,
  collected: Map<string, number>,
): PersonSummary[] {
  const map = new Map<string, PersonSummary>()

  for (const r of byDay) {
    let p = map.get(r.authorId)
    if (!p) {
      p = {
        authorId: r.authorId,
        authorName: r.authorName,
        workDays: 0,
        logsTotal: 0,
        distinctCases: 0,
        avgPerDay: 0,
        reached: 0,
        attempts: 0,
        contactRate: null,
        debtorCount: 0,
        otherCount: 0,
        demands: 0,
        promisesMade: 0,
        promisesKept: 0,
        collectedBaht: 0,
        morning: 0,
        afternoon: 0,
        evening: 0,
        firstActivity: null,
        lastActivity: null,
        days: [],
      }
      map.set(r.authorId, p)
    }
    if (r.logsTotal > 0) p.workDays += 1
    p.logsTotal += r.logsTotal
    p.reached += r.reachedCount
    p.attempts += r.attemptsCount
    p.debtorCount += r.debtorCount
    p.otherCount += r.otherCount
    p.demands += r.demandsCount
    p.promisesMade += r.promisesMade
    p.morning += r.morningCount
    p.afternoon += r.afternoonCount
    p.evening += r.eveningCount
    p.firstActivity = minTime(p.firstActivity, r.firstActivity)
    p.lastActivity = maxTime(p.lastActivity, r.lastActivity)
    p.days.push(r)
  }

  for (const p of map.values()) {
    p.contactRate = contactPct(p.reached, p.attempts)
    p.avgPerDay = p.workDays > 0 ? Math.round((p.logsTotal / p.workDays) * 10) / 10 : 0
    p.days.sort((a, b) => a.day.localeCompare(b.day))
    const co = callOutcomes.get(p.authorId)
    // distinct cases: ใช้ casesFollowed จาก call outcomes (distinct สัญญาที่มี follow-up)
    // fallback: ผลรวม casesTouched รายวัน (อาจนับซ้ำข้ามวัน)
    p.distinctCases = co
      ? co.casesFollowed
      : p.days.reduce((s, d) => s + d.casesTouched, 0)
    p.promisesKept = co ? co.promisesKept : 0
    p.collectedBaht = collected.get(p.authorId) ?? 0
  }

  return [...map.values()].sort((a, b) => b.collectedBaht - a.collectedBaht || b.logsTotal - a.logsTotal)
}

// ===== CSV =====
function summaryCSV(rows: PersonSummary[]): string {
  const headers = [
    'ชื่อ', 'วันทำงาน', 'บันทึกรวม', 'เคสที่ดูแล', 'เฉลี่ย/วัน',
    'ติดต่อได้ (%)', 'โทรลูกหนี้', 'โทรญาติ/ผู้ติดต่อ', 'นัดจ่าย', 'ตามนัด',
    'เก็บได้ (฿)', 'การทวง', 'เข้างาน (เร็วสุด)', 'เลิกงาน (ช้าสุด)',
    'เช้า', 'บ่าย', 'เย็น',
  ]
  const out: string[] = [headers.map(escCell).join(',')]
  for (const r of rows) {
    out.push([
      escCell(r.authorName),
      escCell(r.workDays),
      escCell(r.logsTotal),
      escCell(r.distinctCases),
      escCell(r.avgPerDay),
      escCell(r.contactRate === null ? 'N/A' : r.contactRate),
      escCell(r.debtorCount),
      escCell(r.otherCount),
      escCell(r.promisesMade),
      escCell(r.promisesKept),
      escCell(Math.round(r.collectedBaht)),
      escCell(r.demands),
      escCell(r.firstActivity ?? '-'),
      escCell(r.lastActivity ?? '-'),
      escCell(r.morning),
      escCell(r.afternoon),
      escCell(r.evening),
    ].join(','))
  }
  return '﻿' + out.join('\r\n')
}
function dailyCSV(rows: PersonSummary[]): string {
  const headers = [
    'ชื่อ', 'วันที่', 'บันทึก', 'เคสที่แตะ', 'เข้างาน', 'เลิกงาน',
    'เช้า', 'บ่าย', 'เย็น', 'ติดต่อได้', 'พยายามติดต่อ', 'นัดจ่าย', 'การทวง',
  ]
  const out: string[] = [headers.map(escCell).join(',')]
  for (const p of rows) {
    for (const d of p.days) {
      out.push([
        escCell(p.authorName),
        escCell(d.day),
        escCell(d.logsTotal),
        escCell(d.casesTouched),
        escCell(d.firstActivity ?? '-'),
        escCell(d.lastActivity ?? '-'),
        escCell(d.morningCount),
        escCell(d.afternoonCount),
        escCell(d.eveningCount),
        escCell(d.reachedCount),
        escCell(d.attemptsCount),
        escCell(d.promisesMade),
        escCell(d.demandsCount),
      ].join(','))
    }
  }
  return '﻿' + out.join('\r\n')
}

// ===== แถบกระจายเวลา (เช้า/บ่าย/เย็น) =====
function TimeSplit({ m, a, e }: { m: number; a: number; e: number }) {
  const total = m + a + e
  if (total === 0) return <span className="text-ink-soft">—</span>
  const seg = (n: number, color: string) =>
    n > 0 ? <span className={color} style={{ flex: n }} /> : null
  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-peach-light">
        {seg(m, 'bg-amber-400')}
        {seg(a, 'bg-orange-500')}
        {seg(e, 'bg-indigo-500')}
      </div>
      <div className="flex gap-2 text-[10px] text-ink-soft">
        <span>เช้า {m}</span>
        <span>บ่าย {a}</span>
        <span>เย็น {e}</span>
      </div>
    </div>
  )
}

// ===== มุมมองรายวัน / drill-down =====
function DrillDown({
  person,
  range,
  onClose,
}: {
  person: PersonSummary
  range: DateRange | null
  onClose: () => void
}) {
  const [logs, setLogs] = useState<HrDailyLogRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const eff = effectiveRange(range)
    let alive = true
    setLogs(null)
    setErr(null)
    getFreelancerHrDailyLog(person.authorId, eff.start, eff.end)
      .then((d) => {
        if (alive) setLogs(d)
      })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : 'โหลดรายละเอียดไม่สำเร็จ')
      })
    return () => {
      alive = false
    }
  }, [person.authorId, range])

  return (
    <Card className="mt-2 border-salmon/30 bg-cream-deep/70">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h3 className="text-base font-bold text-ink">{person.authorName}</h3>
          <p className="mt-0.5 text-sm text-ink-soft">
            บันทึก {fmtInt(person.logsTotal)} · {person.workDays} วันทำงาน · เก็บได้ {fmtBaht(person.collectedBaht)}
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-ink-soft hover:bg-peach/50 hover:text-ink"
          aria-label="ปิด"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* เวลาเข้า-ออกงานรายวัน (attendance proxy) */}
      <div className="mb-5">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">
          เวลาเข้า-ออกงานรายวัน
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-peach text-left text-xs text-ink-soft">
                <th className="pb-1.5 font-medium">วันที่</th>
                <th className="pb-1.5 text-right font-medium">เข้างาน</th>
                <th className="pb-1.5 text-right font-medium">เลิกงาน</th>
                <th className="pb-1.5 text-right font-medium">บันทึก</th>
                <th className="pb-1.5 text-right font-medium">เคสที่แตะ</th>
                <th className="pb-1.5 text-right font-medium">นัดจ่าย</th>
              </tr>
            </thead>
            <tbody>
              {person.days.map((d) => (
                <tr key={d.day} className="border-b border-peach/40 last:border-0">
                  <td className="py-1.5 font-medium text-ink">{fmtDay(d.day)}</td>
                  <td className="py-1.5 text-right text-ink">{d.firstActivity ?? '—'}</td>
                  <td className="py-1.5 text-right text-ink">{d.lastActivity ?? '—'}</td>
                  <td className="py-1.5 text-right text-ink">{fmtInt(d.logsTotal)}</td>
                  <td className="py-1.5 text-right text-ink-soft">{fmtInt(d.casesTouched)}</td>
                  <td className="py-1.5 text-right text-ink-soft">{fmtInt(d.promisesMade)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* รายการติดตามรายเคส */}
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">
        รายการบันทึกติดตาม (รายเคส)
      </p>
      {err && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>
      )}
      {!err && logs === null && <Loading label="กำลังโหลดรายละเอียด..." />}
      {!err && logs !== null && logs.length === 0 && (
        <p className="py-4 text-sm text-ink-soft">ไม่มีบันทึกในช่วงนี้</p>
      )}
      {!err && logs !== null && logs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-peach text-left text-xs text-ink-soft">
                <th className="pb-2 font-medium">เวลา</th>
                <th className="pb-2 font-medium">ลูกค้า</th>
                <th className="pb-2 font-medium">ช่องทาง</th>
                <th className="pb-2 font-medium">โทรหาใคร</th>
                <th className="pb-2 font-medium">ผล</th>
                <th className="pb-2 text-right font-medium">นัด/ยอด</th>
                <th className="pb-2 font-medium">ป้าย</th>
                <th className="pb-2 font-medium">โน้ต</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id} className="border-b border-peach/40 align-top last:border-0">
                  <td className="whitespace-nowrap py-2 text-ink-soft">{fmtTimeFromIso(l.createdAt)}</td>
                  <td className="py-2">
                    <div className="font-medium text-ink">{l.customerName || '-'}</div>
                    <div className="text-xs text-ink-soft">{l.contractNo || '-'}</div>
                  </td>
                  <td className="py-2 text-ink">{methodLabel(l.contactMethod)}</td>
                  <td className="py-2 text-ink">{contactWho(l)}</td>
                  <td className="py-2">
                    <Badge tone={resultTone(l.followUpResult)}>{resultLabel(l.followUpResult)}</Badge>
                  </td>
                  <td className="whitespace-nowrap py-2 text-right text-ink-soft">
                    {l.nextFollowUpAt ? fmtThaiShort(l.nextFollowUpAt.slice(0, 10)) : ''}
                    {l.promisedAmount ? ` · ${fmtBaht(l.promisedAmount)}` : ''}
                    {!l.nextFollowUpAt && !l.promisedAmount ? '—' : ''}
                  </td>
                  <td className="py-2">
                    {l.countsAsDemand ? (
                      <Badge tone="amber">นับเป็นการทวง</Badge>
                    ) : (
                      <Badge tone="neutral">บันทึกต่อเนื่อง</Badge>
                    )}
                  </td>
                  <td className="max-w-xs py-2 text-xs text-ink-soft">{l.noteText || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ===== Main Page =====
export default function HrReport() {
  const [byDay, setByDay] = useState<HrByDayRow[]>([])
  const [callOutcomes, setCallOutcomes] = useState<CollectorCallOutcome[]>([])
  const [collectedMap, setCollectedMap] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [range, setRange] = useState<DateRange | null>(() =>
    loadStoredRange('hr-report.dateRange', '7d'),
  )

  useEffect(() => {
    if (!loading) setRefreshing(true)
    const eff = effectiveRange(range)
    let alive = true
    Promise.all([
      getFreelancerHrByDay(eff.start, eff.end),
      getCollectorCallOutcomes(eff.start, eff.end),
      getCollectorScorecard(eff.start, eff.end),
    ])
      .then(([days, outcomes, scorecard]) => {
        if (!alive) return
        setByDay(days)
        setCallOutcomes(outcomes)
        const m = new Map<string, number>()
        for (const r of scorecard.rows) m.set(r.authorId, r.collectedBaht)
        setCollectedMap(m)
        setSelectedId(null)
        setLoading(false)
        setRefreshing(false)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ')
        setLoading(false)
        setRefreshing(false)
      })
    return () => {
      alive = false
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range])

  const callOutcomeMap = useMemo(() => {
    const m = new Map<string, CollectorCallOutcome>()
    for (const c of callOutcomes) m.set(c.authorId, c)
    return m
  }, [callOutcomes])

  const people = useMemo(
    () => rollup(byDay, callOutcomeMap, collectedMap),
    [byDay, callOutcomeMap, collectedMap],
  )

  const totals = useMemo(() => {
    let logsTotal = 0, demands = 0, promisesMade = 0, collectedBaht = 0, workDays = 0
    for (const p of people) {
      logsTotal += p.logsTotal
      demands += p.demands
      promisesMade += p.promisesMade
      collectedBaht += p.collectedBaht
      workDays += p.workDays
    }
    return { logsTotal, demands, promisesMade, collectedBaht, workDays }
  }, [people])

  const rangeLabel = useMemo(() => {
    if (!range) return 'ทั้งหมด'
    return `${fmtThaiShort(range.start)} – ${fmtThaiShort(range.end)} (${daysBetween(range.start, range.end)} วัน)`
  }, [range])

  const selected = people.find((p) => p.authorId === selectedId) ?? null

  function toggle(id: string) {
    setSelectedId((prev) => (prev === id ? null : id))
  }

  if (loading) return <Loading label="กำลังโหลดรายงาน HR..." />

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageTitle sub={`ช่วง ${rangeLabel}`} count={{ shown: people.length }}>
          รายงาน HR ทีมโทร
        </PageTitle>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            disabled={people.length === 0 || refreshing}
            onClick={() => downloadCSV(summaryCSV(people), `hr_report_summary_${todayISO}.csv`)}
          >
            <Download className="h-4 w-4" />
            สรุปรายคน (CSV)
          </Button>
          <Button
            variant="ghost"
            disabled={people.length === 0 || refreshing}
            onClick={() => downloadCSV(dailyCSV(people), `hr_report_daily_${todayISO}.csv`)}
          >
            <Download className="h-4 w-4" />
            รายวัน (CSV)
          </Button>
          <Button variant="ghost" onClick={() => window.print()}>
            พิมพ์
          </Button>
        </div>
      </div>

      <DateRangePicker
        storageKey="hr-report.dateRange"
        defaultPreset="7d"
        value={range}
        onChange={setRange}
      />

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* หมายเหตุที่มาของข้อมูล */}
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        <span className="font-semibold">หมายเหตุ:</span>{' '}
        รายงานนี้อิงการบันทึกการติดตามใน /queue — เวลาเข้า-ออกงานคือ
        <span className="font-medium"> เวลาที่กดบันทึกในระบบ ไม่ใช่เวลาโทรจริง</span>
      </div>

      {people.length === 0 && !error ? (
        <EmptyState
          title="ยังไม่มีบันทึกติดตามในช่วงนี้"
          hint="ลองเลือกช่วงวันอื่น หรือรอให้ทีมเริ่มบันทึกการติดตามใน /queue"
        />
      ) : (
        <>
          {/* สรุปทีม */}
          <Card>
            <p className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-soft">
              สรุปทีม (ช่วงที่เลือก)
            </p>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="rounded-xl border border-peach bg-white px-4 py-3">
                <div className="text-2xl font-bold text-ink">{fmtInt(totals.logsTotal)}</div>
                <div className="mt-1 text-xs text-ink-soft">📋 บันทึกติดตามรวม</div>
              </div>
              <div className="rounded-xl border border-peach bg-white px-4 py-3">
                <div className="text-2xl font-bold text-ink">{fmtInt(totals.promisesMade)}</div>
                <div className="mt-1 text-xs text-ink-soft">นัดจ่าย</div>
              </div>
              <div className="rounded-xl border border-peach bg-white px-4 py-3">
                <div className="text-2xl font-bold text-ink">{fmtInt(totals.demands)}</div>
                <div className="mt-1 text-xs text-ink-soft">การทวง (ตามกฎหมาย)</div>
              </div>
              <div className="rounded-xl border border-peach bg-white px-4 py-3">
                <div className="text-2xl font-bold text-green-700">{fmtBaht(totals.collectedBaht)}</div>
                <div className="mt-1 text-xs text-ink-soft">💰 เก็บได้จากการโทร</div>
              </div>
            </div>
          </Card>

          {/* ตารางสรุปรายคน */}
          <Card className="overflow-hidden p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-peach bg-peach-light/40 text-left">
                    <th className="px-4 py-3 font-semibold text-ink">ชื่อ</th>
                    <th className="px-4 py-3 text-right font-semibold text-ink">วันทำงาน</th>
                    <th className="px-4 py-3 text-right font-semibold text-ink">บันทึกรวม</th>
                    <th className="px-4 py-3 text-right font-semibold text-ink">เคสที่ดูแล</th>
                    <th className="px-4 py-3 text-right font-semibold text-ink">เฉลี่ย/วัน</th>
                    <th className="px-4 py-3 text-right font-semibold text-ink">ติดต่อได้</th>
                    <th className="px-4 py-3 text-right font-semibold text-ink">ลูกหนี้:ญาติ</th>
                    <th className="px-4 py-3 text-right font-semibold text-ink">นัดจ่าย</th>
                    <th className="px-4 py-3 text-right font-semibold text-ink">ตามนัด</th>
                    <th className="px-4 py-3 text-right font-semibold text-ink">เก็บได้</th>
                    <th className="px-4 py-3 text-right font-semibold text-ink">การทวง</th>
                    <th className="w-10 px-4 py-3" />
                  </tr>
                </thead>
                {people.map((p) => {
                  const isSel = selectedId === p.authorId
                  return (
                    <tbody key={p.authorId}>
                      <tr
                        className={`cursor-pointer border-b border-peach/50 transition-colors hover:bg-peach-light/30 ${
                          isSel ? 'bg-peach-light/50' : ''
                        }`}
                        onClick={() => toggle(p.authorId)}
                      >
                        <td className="px-4 py-3 font-medium text-ink">{p.authorName}</td>
                        <td className="px-4 py-3 text-right text-ink">{fmtInt(p.workDays)}</td>
                        <td className="px-4 py-3 text-right font-semibold text-ink">{fmtInt(p.logsTotal)}</td>
                        <td className="px-4 py-3 text-right text-ink">{fmtInt(p.distinctCases)}</td>
                        <td className="px-4 py-3 text-right text-ink">{p.avgPerDay > 0 ? p.avgPerDay.toLocaleString('th-TH') : '—'}</td>
                        <td className={`px-4 py-3 text-right ${pctCls(p.contactRate)}`}>{fmtPct(p.contactRate)}</td>
                        <td className="px-4 py-3 text-right text-ink-soft">
                          {p.debtorCount.toLocaleString('th-TH')}:{p.otherCount.toLocaleString('th-TH')}
                        </td>
                        <td className="px-4 py-3 text-right text-ink">{fmtInt(p.promisesMade)}</td>
                        <td className="px-4 py-3 text-right font-semibold text-green-700">{fmtInt(p.promisesKept)}</td>
                        <td className="px-4 py-3 text-right font-semibold text-ink">{fmtBaht(p.collectedBaht)}</td>
                        <td className="px-4 py-3 text-right text-ink">{fmtInt(p.demands)}</td>
                        <td className="px-4 py-3 text-right">
                          <ChevronRight
                            className={`h-4 w-4 text-ink-soft transition-transform ${isSel ? 'rotate-90' : ''}`}
                          />
                        </td>
                      </tr>
                      {isSel && selected && (
                        <tr>
                          <td colSpan={12} className="px-4 pb-4">
                            <DrillDown person={selected} range={range} onClose={() => setSelectedId(null)} />
                          </td>
                        </tr>
                      )}
                    </tbody>
                  )
                })}
              </table>
            </div>
          </Card>

          {/* การกระจายเวลา + เวลาเข้า-ออกงาน (attendance) ต่อคน */}
          <Card>
            <div className="mb-4 flex items-center gap-2">
              <Clock className="h-4 w-4 text-ink-soft" />
              <h2 className="text-base font-bold text-ink">การกระจายเวลาทำงาน &amp; เวลาเข้า-ออกงาน</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-peach text-left text-xs text-ink-soft">
                    <th className="pb-2 font-medium">ชื่อ</th>
                    <th className="pb-2 text-right font-medium">เข้างาน (เร็วสุด)</th>
                    <th className="pb-2 text-right font-medium">เลิกงาน (ช้าสุด)</th>
                    <th className="pb-2 font-medium">กระจายช่วงเวลา (บันทึก)</th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((p) => (
                    <tr key={p.authorId} className="border-b border-peach/40 last:border-0">
                      <td className="py-2.5 font-medium text-ink">{p.authorName}</td>
                      <td className="py-2.5 text-right text-ink">{p.firstActivity ?? '—'}</td>
                      <td className="py-2.5 text-right text-ink">{p.lastActivity ?? '—'}</td>
                      <td className="w-1/2 py-2.5">
                        <TimeSplit m={p.morning} a={p.afternoon} e={p.evening} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-ink-soft">
              เวลาเหล่านี้คือเวลาที่กดบันทึกในระบบ ไม่ใช่เวลาโทรจริง — ใช้ประเมินคร่าวๆ เท่านั้น ·
              เช้า = ก่อนเที่ยง · บ่าย = 12:00–17:00 · เย็น = หลัง 17:00
            </p>
          </Card>
        </>
      )}
    </div>
  )
}
