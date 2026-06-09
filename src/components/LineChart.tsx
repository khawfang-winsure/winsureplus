import { useId } from 'react'

// กราฟเส้นโค้งลื่น (area/line) วาดด้วย SVG ล้วน — รองรับหลายเส้น
export interface LineSeries {
  name: string
  color: string // hex เช่น '#f97316'
  values: number[]
  fill?: boolean // เติมพื้นไล่เฉดใต้เส้น (ใช้กับเส้นหลัก)
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

  return (
    <div>
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

      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-44 w-full">
        <defs>
          {series.map((s, si) => (
            <linearGradient key={si} id={`${gid}-g${si}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.35" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        {series.map((s, si) => {
          const pts = s.values.map((v, i) => ({ x: xAt(i), y: yAt(v) }))
          const line = smoothPath(pts)
          const area = `${line} L ${xAt(n - 1)} ${H - PAD_B} L ${xAt(0)} ${H - PAD_B} Z`
          return (
            <g key={si}>
              {s.fill && <path d={area} fill={`url(#${gid}-g${si})`} />}
              <path d={line} fill="none" stroke={s.color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
              {pts.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r={n > 20 ? 2 : 3} fill={s.color}>
                  <title>{`${labels[i]} · ${s.name}: ${s.values[i]}${valueSuffix}`}</title>
                </circle>
              ))}
            </g>
          )
        })}
      </svg>

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
