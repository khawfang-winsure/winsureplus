import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Card } from './ui'
import { getCashCollectedToday } from '../lib/db'
import { baht } from '../lib/format'
import type { CashCollectedToday } from '../lib/types'

const POLL_MS = 45_000

/** เวลา HH:mm (24 ชม.) สำหรับป้าย "อัปเดตล่าสุด" */
function fmtHHmm(d: Date): string {
  return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/**
 * Widget "เงินเก็บได้จริงวันนี้ (สด)" — ยอดเงินเข้าระบบทุกช่องทาง (ทีมโทรตามได้ + ลูกค้าจ่ายเอง + PJ auto-sync)
 * นับตามวันที่บันทึกเข้าระบบ (record date, ไม่ใช่วันครบกำหนดงวด) — ต้องซื่อตรงกับ label เสมอ
 * อัปเดตอัตโนมัติทุก 45 วิ (+ ปุ่มรีเฟรชมือ) ใช้ร่วมกันที่ /exec (แท็บภาพรวม) และ /staff-performance
 * คู่กับ TeamCallTodayWidget — เป็นยอดรวมพอร์ต ไม่ใช่ PII ลูกค้า จึงไม่ gate isExec ที่นี่
 */
export default function CashCollectedTodayWidget() {
  const [data, setData] = useState<CashCollectedToday | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const load = useCallback((isManual: boolean) => {
    if (isManual) setLoading(true)
    getCashCollectedToday()
      .then((res) => {
        setData(res)
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

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-ink">เงินเก็บได้จริงวันนี้ (สด)</h3>
          <p className="mt-0.5 text-xs text-ink-soft">
            รวมทุกช่องทาง · นับตามวันที่บันทึกเข้าระบบ · อัปเดตอัตโนมัติทุก 45 วินาที
          </p>
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

      {loading && !data ? (
        <p className="text-sm text-ink-soft">กำลังโหลด...</p>
      ) : !data || data.income === 0 ? (
        <p className="text-sm text-ink-soft">ยังไม่มีเงินเข้าระบบวันนี้</p>
      ) : (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-3xl font-bold text-green-700">฿{baht(data.income)}</div>
            <div className="mt-1 text-xs text-ink-soft">{data.payCount.toLocaleString('th-TH')} รายการ</div>
          </div>
          {data.penaltyIncome > 0 && (
            <div className="text-xs text-ink-soft">รวมค่าปรับ ฿{baht(data.penaltyIncome)}</div>
          )}
        </div>
      )}
    </Card>
  )
}
