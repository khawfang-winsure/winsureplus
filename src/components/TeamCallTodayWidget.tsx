import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Card } from './ui'
import { getCollectorCallOutcomes } from '../lib/db'
import { computeCallOutcomeTotals } from '../lib/callOutcomes'
import type { CollectorCallOutcome } from '../lib/types'

const POLL_MS = 45_000

/** วันนี้ตามเขตเวลากรุงเทพ (UTC+7) รูปแบบ YYYY-MM-DD */
function todayBangkok(): string {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)
}

/** เวลา HH:mm (24 ชม.) สำหรับป้าย "อัปเดตล่าสุด" */
function fmtHHmm(d: Date): string {
  return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** จำนวนเต็มในตาราง: 0 → "—" (ให้สอดคล้องกับ scorecard เดิม) */
function fmtInt(n: number): string {
  if (n === 0) return '—'
  return n.toLocaleString('th-TH')
}

/**
 * Widget "ผลงานทีมโทรวันนี้ (สด)" — สรุปยอดติดตาม/นัดชำระของทีมผู้ติดตามหนี้ เฉพาะวันนี้
 * อัปเดตอัตโนมัติทุก 45 วิ (+ ปุ่มรีเฟรชมือ) ใช้ร่วมกันที่ /exec (แท็บภาพรวม) และ /staff-performance
 * (เหนือ CallOutcomeSection ซึ่งเลือกช่วงวันที่เองได้ — คนละส่วนกัน)
 *
 * โชว์ "ชื่อพนักงาน" ไม่ใช่ชื่อ/ข้อมูลลูกค้า — ไม่ใช่ PII ที่ต้องล็อกสำหรับ role exec จึงไม่ gate isExec ที่นี่
 */
export default function TeamCallTodayWidget() {
  const [rows, setRows] = useState<CollectorCallOutcome[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [showAll, setShowAll] = useState(false)

  const load = useCallback((isManual: boolean) => {
    if (isManual) setLoading(true)
    const today = todayBangkok()
    getCollectorCallOutcomes(today, today)
      .then((data) => {
        setRows(data)
        setLastUpdated(new Date())
        setError(null)
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ')
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load(true) // โหลดตอน mount

    const interval = setInterval(() => {
      if (document.hidden) return // แท็บซ่อนอยู่ — ข้ามยิง request รอบนี้
      load(false)
    }, POLL_MS)

    // กลับมาดูแท็บนี้อีกครั้ง (สลับแท็บไปมา) — รีเฟรชทันทีให้ทันข้อมูลล่าสุด
    function handleVisibility() {
      if (!document.hidden) load(false)
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const totals = computeCallOutcomeTotals(rows)
  const sorted = [...rows].sort((a, b) => b.casesFollowed - a.casesFollowed)
  const CAP = 6
  const visible = showAll ? sorted : sorted.slice(0, CAP)

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-ink">ผลงานทีมโทรวันนี้ (สด)</h3>
          <p className="mt-0.5 text-xs text-ink-soft">อิงการบันทึกการติดตามใน /queue ของวันนี้ — อัปเดตอัตโนมัติทุก 45 วินาที</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-ink-soft">
          {lastUpdated && <span>อัปเดตล่าสุด {fmtHHmm(lastUpdated)}</span>}
          <button
            onClick={() => load(true)}
            disabled={loading}
            className="flex items-center gap-1 rounded-lg border border-peach px-2 py-1 text-ink-soft transition hover:bg-peach-light disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            รีเฟรช
          </button>
        </div>
      </div>

      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

      {loading && rows.length === 0 ? (
        <p className="text-sm text-ink-soft">กำลังโหลด...</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-soft">ยังไม่มีการบันทึกการโทรวันนี้</p>
      ) : (
        <div className="flex flex-col gap-4">
          {/* สรุปทีมวันนี้ */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MiniStat label="📋 ติดตาม (เคส)" value={totals.casesFollowed} />
            <MiniStat label="📞 ติดต่อได้" value={totals.casesReached} />
            <MiniStat label="✅ ตามนัด" value={totals.promisesKept} tone="text-green-700" toneBg="border-green-200 bg-green-50" />
            <MiniStat label="❌ ผิดนัด" value={totals.promisesBroken} tone="text-red-600" toneBg="border-red-200 bg-red-50" />
          </div>

          {/* รายคน (เรียงตามติดตามมากสุด) */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-peach text-left text-xs text-ink-soft">
                  <th className="pb-2 font-medium">พนักงาน</th>
                  <th className="pb-2 text-right font-medium">ติดตาม</th>
                  <th className="pb-2 text-right font-medium">ติดต่อได้</th>
                  <th className="pb-2 text-right font-medium">ตามนัด</th>
                  <th className="pb-2 text-right font-medium">ผิดนัด</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.authorId} className="border-b border-peach/40 last:border-0">
                    <td className="py-1.5 font-medium text-ink">{r.authorName}</td>
                    <td className="py-1.5 text-right text-ink">{fmtInt(r.casesFollowed)}</td>
                    <td className="py-1.5 text-right text-ink">{fmtInt(r.casesReached)}</td>
                    <td className="py-1.5 text-right font-semibold text-green-700">{fmtInt(r.promisesKept)}</td>
                    <td className="py-1.5 text-right font-semibold text-red-600">{fmtInt(r.promisesBroken)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {sorted.length > CAP && !showAll && (
            <button onClick={() => setShowAll(true)} className="self-start text-xs text-salmon-deep hover:underline">
              ดูทั้งหมด ({sorted.length} คน)
            </button>
          )}
        </div>
      )}
    </Card>
  )
}

function MiniStat({
  label,
  value,
  tone,
  toneBg,
}: {
  label: string
  value: number
  tone?: string
  toneBg?: string
}) {
  return (
    <div className={`rounded-xl border px-3 py-2 text-center ${toneBg ?? 'border-peach bg-white'}`}>
      <div className={`text-xl font-bold ${tone ?? 'text-ink'}`}>{value.toLocaleString('th-TH')}</div>
      <div className="mt-0.5 text-xs text-ink-soft">{label}</div>
    </div>
  )
}
