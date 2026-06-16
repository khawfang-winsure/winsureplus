import { useEffect, useMemo, useState } from 'react'
import { Card } from './ui'

// ===== Public types =====
export interface DateRange {
  start: string
  end: string
}

export interface DateRangePickerProps {
  value: DateRange | null
  onChange: (range: DateRange | null) => void
  /** localStorage key, e.g. 'exec.dateRange', 'shopReport.dateRange' */
  storageKey?: string
  /** default preset เมื่อยังไม่มีค่าใน localStorage (default = 'thisMonth') */
  defaultPreset?: PresetKey
  /** แสดง badge "ไม่มีข้อมูลในช่วงนี้" เมื่อเป็น true */
  emptyDataChip?: boolean
}

// ===== Internals =====
const todayISO = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)
const TH_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']

/** YYYY-MM-DD → Date (interpret as local) */
function parseISO(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}
/** Date → YYYY-MM-DD (local) */
function fmtISO(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
/** วัน-เดือนปี พ.ศ. แบบย่อ */
function fmtThaiShort(iso: string): string {
  const d = parseISO(iso)
  return `${d.getDate()} ${TH_MONTHS_SHORT[d.getMonth()]} ${d.getFullYear() + 543}`
}
function daysBetween(startISO: string, endISO: string): number {
  const start = parseISO(startISO).getTime()
  const end = parseISO(endISO).getTime()
  return Math.max(0, Math.round((end - start) / 86400000) + 1)
}
function firstOfMonth(iso: string): string {
  const d = parseISO(iso)
  return fmtISO(new Date(d.getFullYear(), d.getMonth(), 1))
}
function lastOfMonth(iso: string): string {
  const d = parseISO(iso)
  return fmtISO(new Date(d.getFullYear(), d.getMonth() + 1, 0))
}
function addDays(iso: string, n: number): string {
  const d = parseISO(iso)
  d.setDate(d.getDate() + n)
  return fmtISO(d)
}

export type PresetKey = 'today' | '7d' | '30d' | 'thisMonth' | 'lastMonth' | 'thisQuarter' | 'all'
const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'today', label: 'วันนี้' },
  { key: '7d', label: '7 วันล่าสุด' },
  { key: '30d', label: '30 วันล่าสุด' },
  { key: 'thisMonth', label: 'เดือนนี้' },
  { key: 'lastMonth', label: 'เดือนที่แล้ว' },
  { key: 'thisQuarter', label: 'ไตรมาสนี้' },
  { key: 'all', label: 'ทั้งหมด' },
]

export function rangeFromPreset(key: PresetKey): DateRange | null {
  if (key === 'all') return null
  if (key === 'today') return { start: todayISO, end: todayISO }
  if (key === '7d') return { start: addDays(todayISO, -6), end: todayISO }
  if (key === '30d') return { start: addDays(todayISO, -29), end: todayISO }
  if (key === 'thisMonth') return { start: firstOfMonth(todayISO), end: todayISO }
  if (key === 'lastMonth') {
    const t = parseISO(todayISO)
    const lastMonthDay = new Date(t.getFullYear(), t.getMonth(), 0)
    const lastISO = fmtISO(lastMonthDay)
    return { start: firstOfMonth(lastISO), end: lastOfMonth(lastISO) }
  }
  // thisQuarter
  const t = parseISO(todayISO)
  const qStartMonth = Math.floor(t.getMonth() / 3) * 3
  return { start: fmtISO(new Date(t.getFullYear(), qStartMonth, 1)), end: todayISO }
}

function detectPreset(r: DateRange | null): PresetKey | null {
  for (const p of PRESETS) {
    const pr = rangeFromPreset(p.key)
    if (pr === null && r === null) return p.key
    if (pr && r && pr.start === r.start && pr.end === r.end) return p.key
  }
  return null
}

/** อ่านค่าจาก localStorage ตาม storageKey — ถ้าไม่เจอ คืน default ตาม defaultPreset */
export function loadStoredRange(storageKey: string, defaultPreset: PresetKey = 'thisMonth'): DateRange | null {
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw === null) return rangeFromPreset(defaultPreset)
    if (raw === 'null') return null // "ทั้งหมด"
    const parsed = JSON.parse(raw) as { start?: string; end?: string }
    if (parsed.start && parsed.end && /^\d{4}-\d{2}-\d{2}$/.test(parsed.start) && /^\d{4}-\d{2}-\d{2}$/.test(parsed.end)) {
      return { start: parsed.start, end: parsed.end }
    }
  } catch {
    /* ignore */
  }
  return rangeFromPreset(defaultPreset)
}

function saveRange(storageKey: string, r: DateRange | null): void {
  try {
    localStorage.setItem(storageKey, r === null ? 'null' : JSON.stringify(r))
  } catch {
    /* ignore */
  }
}

// ===== Component =====
export function DateRangePicker({ value, onChange, storageKey, defaultPreset = 'thisMonth', emptyDataChip = false }: DateRangePickerProps) {
  // local draft state for date inputs (so user can edit freely before applying)
  const [draftStart, setDraftStart] = useState<string>(value?.start ?? firstOfMonth(todayISO))
  const [draftEnd, setDraftEnd] = useState<string>(value?.end ?? todayISO)
  useEffect(() => {
    if (value) {
      setDraftStart(value.start)
      setDraftEnd(value.end)
    }
  }, [value?.start, value?.end])

  const activePreset = useMemo(() => detectPreset(value), [value])
  const invalid = draftStart > draftEnd
  const label = value
    ? `ช่วง: ${fmtThaiShort(value.start)}${value.start === value.end ? '' : ' – ' + fmtThaiShort(value.end)} (${daysBetween(value.start, value.end)} วัน)`
    : 'ช่วง: ทั้งหมด (ใช้พฤติกรรมเดิม)'

  function emit(next: DateRange | null) {
    if (storageKey) saveRange(storageKey, next)
    onChange(next)
  }

  function applyDraft() {
    if (invalid) return
    emit({ start: draftStart, end: draftEnd })
  }

  // suppress unused-var TS error if defaultPreset isn't consumed inside the body
  void defaultPreset

  return (
    <Card>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-ink-soft">ช่วงเวลา:</span>
          {PRESETS.map((p) => {
            const isActive = activePreset === p.key
            return (
              <button
                key={p.key}
                onClick={() => emit(rangeFromPreset(p.key))}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  isActive
                    ? 'bg-salmon-deep text-white'
                    : 'border border-peach bg-white text-ink-soft hover:bg-peach-light'
                }`}
              >
                {p.label}
              </button>
            )
          })}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-soft">จากวันที่</label>
            <input
              type="date"
              value={draftStart}
              onChange={(e) => setDraftStart(e.target.value)}
              className={`rounded-lg border px-2 py-1 text-sm ${
                invalid ? 'border-red-500 bg-red-50' : 'border-peach bg-white'
              }`}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-soft">ถึงวันที่</label>
            <input
              type="date"
              value={draftEnd}
              onChange={(e) => setDraftEnd(e.target.value)}
              className={`rounded-lg border px-2 py-1 text-sm ${
                invalid ? 'border-red-500 bg-red-50' : 'border-peach bg-white'
              }`}
            />
          </div>
          <button
            onClick={applyDraft}
            disabled={invalid}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
              invalid
                ? 'cursor-not-allowed bg-zinc-200 text-zinc-400'
                : 'bg-salmon-deep text-white hover:bg-salmon-deep/90'
            }`}
          >
            ใช้ช่วง
          </button>
          {invalid && (
            <span className="text-xs text-red-600">วันที่เริ่มต้นต้องไม่หลังวันที่สิ้นสุด</span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-soft">{label}</span>
          {emptyDataChip && (
            <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
              ไม่มีข้อมูลในช่วงนี้
            </span>
          )}
        </div>
      </div>
    </Card>
  )
}

// ===== Re-export helpers (อาจมีหน้าอื่นต้องใช้สำหรับ label/format) =====
export { fmtThaiShort, daysBetween, firstOfMonth, lastOfMonth, addDays }
