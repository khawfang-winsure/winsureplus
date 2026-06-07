import { useEffect, useState } from 'react'

// hook เล็กๆ ช่วยโหลดข้อมูลแบบ async พร้อมสถานะ loading/error
// ใช้ครั้งเดียวตอนหน้าโหลด (deps ว่าง) — เหมาะกับหน้าแสดงรายการ
export function useAsync<T>(fn: () => Promise<T>, initial: T) {
  const [data, setData] = useState<T>(initial)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    fn()
      .then((d) => {
        if (active) {
          setData(d)
          setError(null)
        }
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
    // โหลดครั้งเดียวตอน mount
  }, [])

  return { data, loading, error }
}
