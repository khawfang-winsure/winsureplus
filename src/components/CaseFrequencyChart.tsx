import { useMemo, useState } from 'react'
import type { Contract } from '../lib/types'

// กราฟความถี่การส่งเคสตามเวลา — สลับมุมมอง รายปี (รายเดือน) / รายเดือน (รายวัน)
const MONTH_TH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']

type Mode = 'year' | 'month'

export function CaseFrequencyChart({ contracts }: { contracts: Contract[] }) {
  // ปีที่มีข้อมูล (ใหม่สุดก่อน)
  const years = useMemo(() => {
    const set = new Set<number>()
    for (const c of contracts) {
      const y = Number(c.transactionDate.slice(0, 4))
      if (y) set.add(y)
    }
    return [...set].sort((a, b) => b - a)
  }, [contracts])

  const [mode, setMode] = useState<Mode>('year')
  const [year, setYear] = useState<number>(() => years[0] ?? new Date().getFullYear())
  const [month, setMonth] = useState<number>(1) // 1-12

  const bars = useMemo(() => {
    if (mode === 'year') {
      const counts = Array<number>(12).fill(0)
      for (const c of contracts) {
        if (Number(c.transactionDate.slice(0, 4)) === year) {
          const m = Number(c.transactionDate.slice(5, 7))
          if (m >= 1 && m <= 12) counts[m - 1]++
        }
      }
      return counts.map((value, i) => ({ key: i, label: MONTH_TH[i], value }))
    }
    const daysInMonth = new Date(year, month, 0).getDate()
    const counts = Array<number>(daysInMonth).fill(0)
    for (const c of contracts) {
      if (Number(c.transactionDate.slice(0, 4)) === year && Number(c.transactionDate.slice(5, 7)) === month) {
        const d = Number(c.transactionDate.slice(8, 10))
        if (d >= 1 && d <= daysInMonth) counts[d - 1]++
      }
    }
    return counts.map((value, i) => ({ key: i, label: `${i + 1}`, value }))
  }, [contracts, mode, year, month])

  const max = Math.max(1, ...bars.map((b) => b.value))
  const totalInView = bars.reduce((s, b) => s + b.value, 0)
  const showEveryLabel = bars.length <= 14 // รายวันจะเยอะ → โชว์ label เป็นช่วง

  const selectCls =
    'rounded-lg border border-peach bg-cream-deep px-2.5 py-1.5 text-sm text-ink outline-none focus:border-salmon-deep'
  const yearOptions = years.length ? years : [year]

  return (
    <div className="rounded-2xl border border-peach bg-cream-deep p-5 shadow-sm">
      {/* หัว + ปุ่มควบคุม */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold text-ink">ความถี่การส่งเคส</h3>
        <div className="flex flex-wrap items-center gap-2">
          {/* สวิตช์โหมด */}
          <div className="inline-flex overflow-hidden rounded-lg border border-peach">
            {(['year', 'month'] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-3 py-1.5 text-sm transition ${
                  mode === m ? 'bg-salmon-deep text-white' : 'bg-cream-deep text-ink hover:bg-peach-light'
                }`}
              >
                {m === 'year' ? 'รายปี' : 'รายเดือน'}
              </button>
            ))}
          </div>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} className={selectCls}>
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                ปี {y + 543}
              </option>
            ))}
          </select>
          {mode === 'month' && (
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className={selectCls}>
              {MONTH_TH.map((m, i) => (
                <option key={i} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {totalInView === 0 ? (
        <p className="py-10 text-center text-sm text-ink-soft">
          ไม่มีเคสในช่วง{mode === 'year' ? `ปี ${year + 543}` : `เดือน${MONTH_TH[month - 1]} ${year + 543}`}
        </p>
      ) : (
        <>
          {/* แท่งกราฟ (แนวตั้ง) */}
          <div className="flex h-44 items-end gap-1">
            {bars.map((b) => (
              <div
                key={b.key}
                title={`${b.label}: ${b.value} เคส`}
                className="flex flex-1 items-end justify-center rounded-t bg-salmon-deep transition hover:bg-salmon"
                style={{ height: `${b.value === 0 ? 0 : Math.max((b.value / max) * 100, 6)}%` }}
              >
                {bars.length <= 12 && b.value > 0 && (
                  <span className="pb-0.5 text-[10px] font-semibold text-white">{b.value}</span>
                )}
              </div>
            ))}
          </div>
          {/* ป้ายแกนล่าง */}
          <div className="mt-1 flex gap-1">
            {bars.map((b, i) => (
              <span key={b.key} className="flex-1 overflow-hidden text-center text-[10px] text-ink-soft">
                {showEveryLabel || i % 5 === 0 ? b.label : ''}
              </span>
            ))}
          </div>
          <p className="mt-3 text-sm text-ink-soft">
            รวม <b className="text-ink">{totalInView}</b> เคส ใน
            {mode === 'year' ? `ปี ${year + 543}` : `เดือน${MONTH_TH[month - 1]} ${year + 543}`}
          </p>
        </>
      )}
    </div>
  )
}
