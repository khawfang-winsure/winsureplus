import { useRef, useState } from 'react'

// โดนัทวงแหวน SVG ล้วน — แสดงสัดส่วน (เช่น ปกติ/ล่าช้า/หนี้เสีย) + tooltip ตอน hover
export interface DonutSlice {
  label: string
  value: number
  color: string // hex
}

interface HoverInfo {
  sliceIndex: number
  x: number
  y: number
}

export function Donut({
  slices,
  size = 150,
  thickness = 18,
  centerLabel,
  centerValue,
}: {
  slices: DonutSlice[]
  size?: number
  thickness?: number
  centerLabel?: string
  centerValue?: string
}) {
  const total = slices.reduce((s, x) => s + x.value, 0)
  const r = (size - thickness) / 2
  const c = size / 2
  const circ = 2 * Math.PI * r
  let offset = 0

  const containerRef = useRef<HTMLDivElement | null>(null)
  const [hover, setHover] = useState<HoverInfo | null>(null)

  const updateHover = (i: number, e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    setHover({ sliceIndex: i, x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  // คำนวณตำแหน่ง tooltip ไม่ให้ล้นขอบขวา
  const TOOLTIP_W = 160 // ประมาณค่ากว้างพอเหมาะ
  const containerW = containerRef.current?.clientWidth ?? 0
  let tipLeft = 0
  let tipTop = 0
  if (hover) {
    tipLeft = hover.x + 12
    tipTop = hover.y + 12
    if (containerW > 0 && tipLeft + TOOLTIP_W > containerW) {
      tipLeft = hover.x - TOOLTIP_W - 12
      if (tipLeft < 0) tipLeft = 0
    }
  }

  const hoveredSlice = hover ? slices[hover.sliceIndex] : null
  const hoveredPct =
    hoveredSlice && total > 0 ? Math.round((hoveredSlice.value / total) * 100) : 0

  return (
    <div ref={containerRef} className="relative flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={c} cy={c} r={r} fill="none" stroke="#f3e6d8" strokeWidth={thickness} />
        {total > 0 &&
          slices.map((s, i) => {
            const len = (s.value / total) * circ
            const isHovered = hover?.sliceIndex === i
            const anyHover = hover !== null
            const seg = (
              <circle
                key={i}
                cx={c}
                cy={c}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={thickness}
                strokeDasharray={`${len} ${circ - len}`}
                strokeDashoffset={-offset}
                style={{
                  cursor: 'pointer',
                  opacity: anyHover ? (isHovered ? 1 : 0.7) : 1,
                  transition: 'opacity 150ms ease',
                }}
                onMouseEnter={(e) => updateHover(i, e)}
                onMouseMove={(e) => updateHover(i, e)}
                onMouseLeave={() => setHover(null)}
              />
            )
            offset += len
            return seg
          })}
      </svg>
      <div>
        {(centerValue || centerLabel) && (
          <div className="mb-2">
            {centerValue && <p className="text-xl font-bold text-ink">{centerValue}</p>}
            {centerLabel && <p className="text-xs text-ink-soft">{centerLabel}</p>}
          </div>
        )}
        <ul className="flex flex-col gap-1 text-sm">
          {slices.map((s) => (
            <li key={s.label} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: s.color }} />
              <span className="text-ink-soft">{s.label}</span>
              <b className="text-ink">{s.value.toLocaleString('th-TH')}</b>
              <span className="text-xs text-ink-soft">({total > 0 ? Math.round((s.value / total) * 100) : 0}%)</span>
            </li>
          ))}
        </ul>
      </div>

      {hoveredSlice && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white shadow-lg"
          style={{ left: tipLeft, top: tipTop }}
        >
          <div className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: hoveredSlice.color }}
            />
            <span className="font-medium">{hoveredSlice.label}</span>
          </div>
          <div className="mt-0.5 text-xs text-zinc-200">
            จำนวน {hoveredSlice.value.toLocaleString('th-TH')} เคส ({hoveredPct}%)
          </div>
        </div>
      )}
    </div>
  )
}
