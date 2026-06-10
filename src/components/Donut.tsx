// โดนัทวงแหวน SVG ล้วน — แสดงสัดส่วน (เช่น ปกติ/ล่าช้า/หนี้เสีย)
export interface DonutSlice {
  label: string
  value: number
  color: string // hex
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

  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={c} cy={c} r={r} fill="none" stroke="#f3e6d8" strokeWidth={thickness} />
        {total > 0 &&
          slices.map((s, i) => {
            const len = (s.value / total) * circ
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
    </div>
  )
}
