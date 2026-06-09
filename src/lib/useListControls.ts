import { useMemo, useState } from 'react'

// ตัวช่วยจัดการลิสต์: ค้นหา + เรียงตามชื่อ + แบ่งหน้า (ใช้ซ้ำได้ทุกหน้า)
export type SortDir = 'asc' | 'desc'

export function useListControls<T>(items: T[], getText: (t: T) => string) {
  const [query, setQuery] = useState('')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [pageSize, setPageSize] = useState(20)
  const [page, setPage] = useState(1)

  const processed = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? items.filter((it) => getText(it).toLowerCase().includes(q))
      : items
    return [...filtered].sort(
      (a, b) => getText(a).localeCompare(getText(b), 'th') * (sortDir === 'asc' ? 1 : -1),
    )
    // getText เป็นฟังก์ชันสั้นๆ ลิสต์ไม่ใหญ่ — คำนวณใหม่ทุกครั้งได้ ไม่กระทบ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, query, sortDir])

  const total = processed.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, pageCount)
  const paged = processed.slice((safePage - 1) * pageSize, safePage * pageSize)

  return {
    query,
    setQuery,
    sortDir,
    setSortDir,
    pageSize,
    setPageSize,
    page: safePage,
    setPage,
    paged,
    total,
    pageCount,
  }
}
