import type { ReactNode } from 'react'
import { ArrowDownAZ, ArrowUpAZ, Search } from 'lucide-react'
import { useListControls } from '../lib/useListControls'

// ลิสต์ที่มี ค้นหา + เรียงตามชื่อ + แบ่งหน้า (20/40/80) — ใช้ซ้ำได้ทุกหน้า
export function ManagedList<T extends { id: string }>({
  items,
  getText,
  renderItem,
  emptyText = 'ยังไม่มีข้อมูล',
  searchPlaceholder = 'ค้นหา...',
  toolbarRight,
}: {
  items: T[]
  getText: (t: T) => string
  renderItem: (t: T) => ReactNode
  emptyText?: string
  searchPlaceholder?: string
  toolbarRight?: ReactNode
}) {
  const c = useListControls(items, getText)
  const fieldCls =
    'rounded-xl border border-peach bg-cream-deep px-3 py-2 text-sm text-ink outline-none transition focus:border-salmon-deep focus:ring-2 focus:ring-salmon/30'

  return (
    <div>
      {/* แถบเครื่องมือ: ค้นหา / เรียง / จำนวนต่อหน้า */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft" />
          <input
            value={c.query}
            onChange={(e) => c.setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            className={`${fieldCls} w-full pl-9`}
          />
        </div>
        <button
          onClick={() => c.setSortDir(c.sortDir === 'asc' ? 'desc' : 'asc')}
          title="เรียงตามชื่อ"
          className="inline-flex items-center gap-1.5 rounded-xl border border-peach bg-cream-deep px-3 py-2 text-sm text-ink transition hover:bg-peach-light"
        >
          {c.sortDir === 'asc' ? <ArrowDownAZ size={16} /> : <ArrowUpAZ size={16} />}
          {c.sortDir === 'asc' ? 'ก-ฮ' : 'ฮ-ก'}
        </button>
        <select
          value={c.pageSize}
          onChange={(e) => c.setPageSize(Number(e.target.value))}
          className={fieldCls}
          title="จำนวนต่อหน้า"
        >
          <option value={20}>20 / หน้า</option>
          <option value={40}>40 / หน้า</option>
          <option value={80}>80 / หน้า</option>
        </select>
        {toolbarRight}
      </div>

      {/* รายการ */}
      {c.total === 0 ? (
        <p className="py-6 text-center text-sm text-ink-soft">
          {c.query ? 'ไม่พบรายการที่ค้นหา' : emptyText}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {c.paged.map((it) => (
            <div key={it.id}>{renderItem(it)}</div>
          ))}
        </div>
      )}

      {/* แบ่งหน้า */}
      {c.total > 0 && (
        <div className="mt-3 flex items-center justify-between text-sm text-ink-soft">
          <span>
            ทั้งหมด {c.total} รายการ
            {c.pageCount > 1 ? ` · หน้า ${c.page}/${c.pageCount}` : ''}
          </span>
          {c.pageCount > 1 && (
            <div className="flex items-center gap-1">
              <button
                disabled={c.page <= 1}
                onClick={() => c.setPage(c.page - 1)}
                className="rounded-lg border border-peach px-2.5 py-1 transition hover:bg-peach-light disabled:opacity-40"
              >
                ก่อนหน้า
              </button>
              <button
                disabled={c.page >= c.pageCount}
                onClick={() => c.setPage(c.page + 1)}
                className="rounded-lg border border-peach px-2.5 py-1 transition hover:bg-peach-light disabled:opacity-40"
              >
                ถัดไป
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
