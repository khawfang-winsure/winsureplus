import { useId, useState } from 'react'

// กราฟเส้นโค้งลื่น (area/line) วาดด้วย SVG ล้วน — รองรับหลายเส้น
export interface LineSeries {
  name: string
  color: string // hex เช่น '#f97316'
  values: number[]
  fill?: boolean // เติมพื้นไล่เฉดใต้เส้น (ใช้กับเส้นหลัก)
}

interface TooltipItem {
  seriesName: string
  value: number
  color: string
}

interface HoverInfo {
  index: number
  xPct: number // ตำแหน่งบนแกน X เป็น % ของความกว้าง chart
  label: string
  items: TooltipItem[]
}

const W = 600
const H = 170
const PAD_T = 14
const PAD_B = 8

// เส้นโค้งลื่นแบบ Catmull-Rom → Bézier
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return ''
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`
  let d = `M ${pts[0].x} ${pts[0].y}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x} ${p2.y}`
  }
  return d
}

export function LineChart({
  labels,
  series,
  valueSuffix = '',
}: {
  labels: string[]
  series: LineSeries[]
  valueSuffix?: string
}) {
  const gid = useId().replace(/:/g, '')
  const n = labels.length
  const max = Math.max(1, ...series.flatMap((s) => s.values))
  const xAt = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W)
  const yAt = (v: number) => PAD_T + (1 - v / max) * (H - PAD_T - PAD_B)
  const showEveryLabel = n <= 14

  const [hover, setHover] = useState<HoverInfo | null>(null)

  const handleEnter = (i: number) => {
    const xPct = n <= 1 ? 50 : (i / (n - 1)) * 100
    setHover({
      index: i,
      xPct,
      label: labels[i] ?? '',
      items: series.map((s) => ({
        seriesName: s.name,
        value: s.values[i] ?? 0,
        color: s.color,
      })),
    })
  }

  const handleLeave = () => setHover(null)

  // จัดตำแหน่ง tooltip — ถ้าใกล้ขอบขวา ให้ flip ไปทางซ้าย
  const tooltipFlip = hover ? hover.xPct > 70 : false

  return (
    <div className="relative">
      {series.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-4 text-xs text-ink-soft">
          {series.map((s) => (
            <span key={s.name} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}

      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-44 w-full">
          <defs>
            {series.map((s, si) => (
              <linearGradient key={si} id={`${gid}-g${si}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity="0.35" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>

          {/* เส้นไกด์แนวตั้งตอน hover */}
          {hover && (
            <line
              x1={xAt(hover.index)}
              x2={xAt(hover.index)}
              y1={PAD_T}
              y2={H - PAD_B}
              stroke="#a1a1aa"
              strokeWidth={1}
              strokeDasharray="3 3"
              pointerEvents="none"
            />
          )}

          {series.map((s, si) => {
            const pts = s.values.map((v, i) => ({ x: xAt(i), y: yAt(v) }))
            const line = smoothPath(pts)
            const area = `${line} L ${xAt(n - 1)} ${H - PAD_B} L ${xAt(0)} ${H - PAD_B} Z`
            return (
              <g key={si}>
                {s.fill && <path d={area} fill={`url(#${gid}-g${si})`} />}
                <path d={line} fill="none" stroke={s.color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
                {pts.map((p, i) => {
                  const isActive = hover?.index === i
                  return (
                    <circle
                      key={i}
                      cx={p.x}
                      cy={p.y}
                      r={isActive ? (n > 20 ? 3.5 : 4.5) : n > 20 ? 2 : 3}
                      fill={s.color}
                      stroke={isActive ? '#ffffff' : 'none'}
                      strokeWidth={isActive ? 1.5 : 0}
                      style={{ cursor: 'pointer', transition: 'r 120ms' }}
                      onMouseEnter={() => handleEnter(i)}
                      onMouseLeave={handleLeave}
                    />
                  )
                })}
              </g>
            )
          })}
        </svg>

        {/* tooltip */}
        {hover && (
          <div
            className="pointer-events-none absolute z-10 rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white shadow-lg transition-opacity duration-150"
            style={{
              left: tooltipFlip ? undefined : `calc(${hover.xPct}% + 10px)`,
              right: tooltipFlip ? `calc(${100 - hover.xPct}% + 10px)` : undefined,
              top: 4,
              opacity: 1,
              whiteSpace: 'nowrap',
            }}
          >
            <div className="mb-1 text-xs font-medium text-zinc-300">{hover.label}</div>
            {hover.items.map((it) => (
              <div key={it.seriesName} className="flex items-center gap-1.5 text-xs">
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: it.color }} />
                <span className="text-zinc-300">{it.seriesName}:</span>
                <span className="font-semibold">
                  {it.value.toLocaleString('th-TH')}
                  {valueSuffix}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ป้ายแกนล่าง */}
      <div className="mt-1 flex">
        {labels.map((lb, i) => (
          <span key={i} className="flex-1 overflow-hidden text-center text-[10px] text-ink-soft">
            {showEveryLabel || i % 5 === 0 ? lb : ''}
          </span>
        ))}
      </div>
    </div>
  )
}
