// ===== CSV export helpers (ใช้ร่วมกันหลายหน้า: HrReport, StaffPerformance, Overdue) =====

/** escape CSV cell: ครอบ quote ถ้ามี comma / quote / newline */
export function escCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/** สั่งดาวน์โหลด CSV string เป็นไฟล์ (เติม UTF-8 BOM ให้ Excel เปิดภาษาไทยไม่เพี้ยนตอนเรียก escCell + join เอง) */
export function downloadCSV(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
