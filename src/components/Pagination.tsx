import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button, Select } from './ui'

interface PaginationProps {
  total: number
  page: number
  pageSize: number
  onPageChange: (p: number) => void
  onPageSizeChange: (s: number) => void
  pageSizeOptions?: number[]
}

export default function Pagination({
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [20, 50, 100],
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      {/* ซ้าย: dropdown เลือกจำนวนแถว */}
      <div className="flex items-center gap-2 text-sm text-ink-soft">
        <span className="whitespace-nowrap">แสดง</span>
        <Select
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          className="!w-auto min-w-[72px] !py-1.5 !text-sm"
        >
          {pageSizeOptions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <span className="whitespace-nowrap">รายการ</span>
      </div>

      {/* กลาง: ตัวบอกช่วง */}
      <p className="text-sm text-ink-soft">
        {total === 0 ? (
          'ไม่มีรายการ'
        ) : (
          <>
            <span className="font-medium text-ink">{from}–{to}</span>
            {' '}จาก{' '}
            <span className="font-medium text-ink">{total}</span>
            {' '}รายการ
          </>
        )}
      </p>

      {/* ขวา: ปุ่มเลื่อนหน้า + เลขหน้า */}
      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="!px-2 !py-1.5"
          aria-label="หน้าก่อนหน้า"
        >
          <ChevronLeft size={16} />
        </Button>
        <span className="min-w-[72px] text-center text-sm text-ink-soft">
          หน้า <span className="font-semibold text-ink">{page}</span>{' '}
          / {totalPages}
        </span>
        <Button
          variant="ghost"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          className="!px-2 !py-1.5"
          aria-label="หน้าถัดไป"
        >
          <ChevronRight size={16} />
        </Button>
      </div>
    </div>
  )
}
