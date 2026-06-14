import { useState, useEffect, type Dispatch, type SetStateAction } from 'react'

const PREFIX = 'winsureplus.filters.'

/**
 * useState wrapper ที่จำค่าลงใน localStorage อัตโนมัติ
 * key → ใช้ชื่อสั้น เช่น 'customers.status' (PREFIX จะเติมให้)
 * defaultValue → ค่า fallback เมื่อยังไม่มีข้อมูลใน storage
 *
 * คืน tuple [value, setter] เหมือน useState ทุกประการ
 * setter รับทั้งค่าตรง (T) และ functional updater ((prev: T) => T) ได้
 */
export function useFilter<T>(
  key: string,
  defaultValue: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(PREFIX + key)
      if (stored !== null) return JSON.parse(stored) as T
    } catch {
      // storage ไม่พร้อม หรือ JSON เสีย → ใช้ default
    }
    return defaultValue
  })

  useEffect(() => {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value))
    } catch {
      // storage เต็ม หรือ private mode ที่บล็อก write → ข้าม
    }
  }, [key, value])

  return [value, setValue]
}
