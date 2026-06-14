import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Card } from './ui'
import { baht } from '../lib/format'
import { getEscalateContracts, type EscalateContract } from '../lib/db'

/** การ์ดสรุป ESCALATE สำหรับ executive — ไม่มี PII (ชื่อ/สัญญา), แสดงเฉพาะ count + ยอดรวม + grade distribution */
export function EscalateSummaryCard() {
  const [rows, setRows] = useState<EscalateContract[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    getEscalateContracts()
      .then((data) => { if (active) setRows(data) })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ')
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [tick])

  const count = rows.length
  const totalAmount = rows.reduce((s, c) => s + c.estOutstanding, 0)

  // grade distribution — เรียง A→E ก่อน, '-' ไว้ท้ายสุด
  const gradeDist = rows.reduce<Record<string, number>>((acc, c) => {
    const g = c.grade ?? '-'
    acc[g] = (acc[g] ?? 0) + 1
    return acc
  }, {})
  const sortedGrades = Object.entries(gradeDist).sort(([a], [b]) => {
    if (a === '-') return 1
    if (b === '-') return -1
    return a.localeCompare(b)
  })

  return (
    <Card>
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="text-amber-600" size={20} />
        <h3 className="font-semibold text-ink">
          ลูกค้าที่ต้องเร่งติดตาม (ESCALATE)
        </h3>
      </div>

      {loading && <p className="text-sm text-ink-soft">กำลังโหลด...</p>}

      {error && !loading && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-red-600">{error}</p>
          <button
            onClick={() => setTick((n) => n + 1)}
            className="self-start rounded-xl border border-peach px-3 py-1.5 text-sm text-ink-soft hover:bg-peach-light"
          >
            ลองใหม่
          </button>
        </div>
      )}

      {!loading && !error && count === 0 && (
        <p className="text-sm text-ink-soft">ไม่มีลูกค้าที่ต้อง escalate ในตอนนี้</p>
      )}

      {!loading && !error && count > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="rounded-2xl border border-peach bg-amber-50 p-4">
              <p className="text-xs text-amber-700">จำนวนที่ต้องดำเนินการ</p>
              <p className="text-2xl font-bold text-amber-900">{count} ราย</p>
            </div>
            <div className="rounded-2xl border border-peach bg-amber-50 p-4">
              <p className="text-xs text-amber-700">มูลค่าคงค้างรวม</p>
              <p className="text-2xl font-bold text-amber-900">{baht(totalAmount)}</p>
            </div>
          </div>

          <div>
            <p className="text-xs text-ink-soft mb-2">แบ่งตามเกรดร้านค้า</p>
            <div className="flex flex-wrap gap-2">
              {sortedGrades.map(([grade, n]) => (
                <span
                  key={grade}
                  className="px-2.5 py-1 bg-amber-100 text-amber-900 text-xs font-medium rounded-full"
                >
                  เกรด {grade}: {n} ราย
                </span>
              ))}
            </div>
          </div>
        </>
      )}
    </Card>
  )
}
