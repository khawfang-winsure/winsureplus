// กติกา "แถวจ่ายเงินที่ถูกยกเลิกภายหลัง" (ตรงกับ SQL migration 0178-0180)
// แถว payment_log action='pay' ที่มี installment_id และมีแถว action='cancel' ของงวดเดียวกัน
// ที่ created_at "มากกว่า" (>) แถว pay นั้น = ถูกยกเลิกแล้ว ไม่ต้องนับเป็นเงิน
// เวลาเท่ากันเป๊ะ (เคส Data Fix: cancel กับ pay ยอดใหม่ timestamp เดียวกัน) = ยังนับ
// pay ที่ installment_id เป็น null (เงินดาวน์) นับเสมอ

export interface PayLogLike {
  action: string
  installment_id: string | null
  created_at: string
}

const TS_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/

/** แปลง timestamp จาก PostgREST เป็นไมโครวินาที (คงความละเอียด microsecond; Date เก็บได้แค่ ms)
 *  คืน NaN ถ้า parse ไม่ได้ (NaN เทียบแล้วเป็น false เสมอ → ไม่ตัดแถวทิ้ง) */
export function tsMicros(ts: string): number {
  const m = TS_RE.exec(ts.trim())
  if (!m) return NaN
  let off = m[4] ?? 'Z'
  if (/^[+-]\d{2}$/.test(off)) off += ':00'
  else if (/^[+-]\d{4}$/.test(off)) off = `${off.slice(0, 3)}:${off.slice(3)}`
  const secMs = Date.parse(`${m[1]}T${m[2]}${off}`)
  if (Number.isNaN(secMs)) return NaN
  const frac = Number((m[3] ?? '').padEnd(6, '0').slice(0, 6))
  return secMs * 1000 + frac
}

/** คืนเฉพาะแถว action='pay' ที่ยังไม่ถูกยกเลิก (ส่งแถว pay+cancel ของสัญญาที่สนใจเข้ามาได้เลย) */
export function dropCancelledPays<T extends PayLogLike>(rows: readonly T[]): T[] {
  const lastCancel = new Map<string, number>() // installment_id → cancel ล่าสุด (µs)
  for (const r of rows) {
    if (r.action !== 'cancel' || r.installment_id == null) continue
    const t = tsMicros(r.created_at)
    if (Number.isNaN(t)) continue
    const prev = lastCancel.get(r.installment_id)
    if (prev === undefined || t > prev) lastCancel.set(r.installment_id, t)
  }
  return rows.filter((r) => {
    if (r.action !== 'pay') return false
    if (r.installment_id == null) return true
    const c = lastCancel.get(r.installment_id)
    if (c === undefined) return true
    return !(c > tsMicros(r.created_at))
  })
}
