import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Receipt, X } from 'lucide-react'
import { Badge, Button, EmptyState, Input, Loading, PageTitle, Select } from '../components/ui'
import CopyBox from '../components/CopyBox'
import { calcSummary } from '../lib/calc'
import { baht, thaiDate } from '../lib/format'
import { buildBulkSummary } from '../lib/messages'
import { getContracts, getShops, markSummarySent } from '../lib/db'
import { useAuth } from '../lib/auth'
import { useAsync } from '../lib/useAsync'
import type { Contract, Shop } from '../lib/types'

type SortKey = 'transactionDate' | 'contractNo' | 'createdAt'
type SortDir = 'asc' | 'desc'

const SORT_OPTS: { value: `${SortKey}_${SortDir}`; label: string }[] = [
  { value: 'transactionDate_desc', label: 'วันที่ทำรายการ (ใหม่→เก่า)' },
  { value: 'transactionDate_asc',  label: 'วันที่ทำรายการ (เก่า→ใหม่)' },
  { value: 'contractNo_asc',       label: 'เลขที่สัญญา (ก→ฮ)' },
  { value: 'contractNo_desc',      label: 'เลขที่สัญญา (ฮ→ก)' },
  { value: 'createdAt_desc',       label: 'วันที่เพิ่มข้อมูล (ใหม่→เก่า)' },
  { value: 'createdAt_asc',        label: 'วันที่เพิ่มข้อมูล (เก่า→ใหม่)' },
]

function sortContracts(list: Contract[], key: SortKey, dir: SortDir): Contract[] {
  return [...list].sort((a, b) => {
    let cmp = 0
    if (key === 'contractNo') {
      cmp = a.contractNo.localeCompare(b.contractNo, 'th', { numeric: true })
    } else {
      // date fields — null/undefined ไปท้ายเสมอ
      const av = key === 'createdAt' ? (a.createdAt ?? '') : a.transactionDate
      const bv = key === 'createdAt' ? (b.createdAt ?? '') : b.transactionDate
      if (!av && !bv) cmp = 0
      else if (!av) return 1
      else if (!bv) return -1
      else cmp = av < bv ? -1 : av > bv ? 1 : 0
    }
    return dir === 'asc' ? cmp : -cmp
  })
}

const today = new Date().toISOString().slice(0, 10)
const netOf = (c: Contract) =>
  calcSummary(c.devicePrice, c.downPercent, c.commissionPercent, c.docFee).net

export default function WaitingSummary() {
  const { name } = useAuth()
  const { data, loading } = useAsync(
    async () => {
      const [contracts, shops] = await Promise.all([getContracts(), getShops()])
      return { contracts, shops }
    },
    { contracts: [] as Contract[], shops: [] as Shop[] },
  )

  const [locallySent, setLocallySent] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [date, setDate] = useState(today)
  const [output, setOutput] = useState('')
  const [sortOpt, setSortOpt] = useState<`${SortKey}_${SortDir}`>('transactionDate_desc')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [shopFilter, setShopFilter] = useState('')

  const shopOf = (id: string) => data.shops.find((s) => s.id === id)

  // เคสที่ยังไม่ส่ง (ก่อนกรอง) — ใช้แยก empty-state
  const base = useMemo(
    () => data.contracts.filter((c) => !c.summarySentAt && !locallySent.has(c.id)),
    [data.contracts, locallySent],
  )

  // ร้านที่เลือกได้ (เรียงตามชื่อ)
  const sortedShops = useMemo(
    () => [...data.shops].sort((a, b) => a.name.localeCompare(b.name, 'th')),
    [data.shops],
  )

  const hasFilter = !!(fromDate || toDate || shopFilter)
  const clearFilter = () => {
    setFromDate('')
    setToDate('')
    setShopFilter('')
  }

  const pending = useMemo(() => {
    const [key, dir] = sortOpt.split('_') as [SortKey, SortDir]
    const filtered = base.filter((c) => {
      if (fromDate && c.transactionDate < fromDate) return false
      if (toDate && c.transactionDate > toDate) return false
      if (shopFilter && c.shopId !== shopFilter) return false
      return true
    })
    return sortContracts(filtered, key, dir)
  }, [base, sortOpt, fromDate, toDate, shopFilter])

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === pending.length ? new Set() : new Set(pending.map((c) => c.id)),
    )
  }

  // จัดกลุ่มเคสที่เลือกตามร้าน เพื่อป้อนตัวสร้างข้อความรวม
  const groups = useMemo(() => {
    const map = new Map<string, { shop: Shop; items: Contract[] }>()
    pending
      .filter((c) => selected.has(c.id))
      .forEach((c) => {
        const shop = shopOf(c.shopId)
        if (!shop) return
        if (!map.has(shop.id)) map.set(shop.id, { shop, items: [] })
        map.get(shop.id)!.items.push(c)
      })
    return [...map.values()]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, selected])

  function generate() {
    if (groups.length === 0) return
    setOutput(buildBulkSummary(groups, date))
  }

  async function markSent() {
    const ids = [...selected]
    const flagged = pending.filter((c) => ids.includes(c.id) && c.pendingDocuments)
    if (flagged.length > 0) {
      const names = flagged.map((c) => c.customerName).join(', ')
      const ok = window.confirm(
        `มี ${flagged.length} เคสรอเอกสาร: ${names}\n\nยืนยันว่าเอกสารครบทั้งหมดแล้ว?`,
      )
      if (!ok) return
    }
    await markSummarySent(ids, name ?? undefined) // บันทึกลง DB จริง (กันส่งซ้ำ)
    setLocallySent((prev) => new Set([...prev, ...ids]))
    setSelected(new Set())
    setOutput('')
  }

  const selectedNet = groups.flatMap((g) => g.items).reduce((sum, c) => sum + netOf(c), 0)

  if (loading) {
    return (
      <div>
        <PageTitle>รอสรุปยอด</PageTitle>
        <Loading />
      </div>
    )
  }

  return (
    <div>
      <PageTitle
        sub="เลือกเคสที่จะสรุปยอด → ระบบรวมยอดโอนของทุกร้านในวันเดียว (กันส่งซ้ำด้วยการทำเครื่องหมายว่าส่งแล้ว)"
        count={{ shown: pending.length }}
      >
        รอสรุปยอด
      </PageTitle>

      {base.length === 0 ? (
        <EmptyState title="ไม่มีเคสค้างสรุปยอด" hint="เคสที่ทำเครื่องหมายว่าส่งแล้วจะถูกซ่อน" />
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {/* ฝั่งซ้าย: เลือกเคส */}
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <Button variant="ghost" onClick={toggleAll}>
                {selected.size === pending.length ? 'ยกเลิกเลือกทั้งหมด' : 'เลือกทั้งหมด'}
              </Button>
              <label className="flex items-center gap-2 text-sm text-ink">
                วันที่สรุป
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-auto" />
              </label>
              <Select
                value={sortOpt}
                onChange={(e) => setSortOpt(e.target.value as `${SortKey}_${SortDir}`)}
                className="w-auto text-sm"
              >
                {SORT_OPTS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </Select>
              <span className="text-sm text-ink-soft">เลือกแล้ว {selected.size} เคส</span>
            </div>

            {/* ตัวกรอง: ช่วงวันที่ทำรายการ + ร้าน */}
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-ink">
                ตั้งแต่
                <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="w-auto" />
              </label>
              <label className="flex items-center gap-2 text-sm text-ink">
                ถึง
                <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="w-auto" />
              </label>
              <Select
                value={shopFilter}
                onChange={(e) => setShopFilter(e.target.value)}
                className="!w-auto min-w-[140px] text-sm"
              >
                <option value="">ทุกร้าน</option>
                {sortedShops.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
              {hasFilter && (
                <Button variant="ghost" onClick={clearFilter} className="text-sm">
                  <X size={13} /> ล้างตัวกรอง
                </Button>
              )}
            </div>

            {pending.length === 0 ? (
              <EmptyState title="ไม่มีเคสตรงตัวกรอง" hint="ลองปรับช่วงวันหรือร้าน" />
            ) : (
            <ul className="flex flex-col gap-2">
              {pending.map((c) => {
                const checked = selected.has(c.id)
                return (
                  <li
                    key={c.id}
                    onClick={() => toggle(c.id)}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition ${
                      checked ? 'border-salmon-deep bg-peach-light/60' : 'border-peach bg-white hover:bg-peach-light/30'
                    }`}
                  >
                    <input type="checkbox" checked={checked} readOnly className="h-4 w-4 accent-salmon-deep" />
                    <div className="flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="font-medium text-ink">
                          <Link
                            to={`/contract/${c.id}`}
                            className="text-salmon-deep hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {c.customerName}
                          </Link>
                          {' '}— {c.contractNo}
                        </p>
                        {c.pendingDocuments && <Badge tone="amber">รอเอกสาร</Badge>}
                      </div>
                      <p className="text-sm text-ink-soft">
                        {shopOf(c.shopId)?.name} · {thaiDate(c.transactionDate)}
                      </p>
                    </div>
                    <span className="font-semibold text-salmon-deep whitespace-nowrap">{baht(netOf(c))} ฿</span>
                  </li>
                )
              })}
            </ul>
            )}
          </div>

          {/* ฝั่งขวา: ผลลัพธ์ */}
          <div className="flex flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={generate} disabled={selected.size === 0}>
                <Receipt size={16} /> สร้างข้อความสรุปยอด
              </Button>
              {selected.size > 0 && (
                <Badge tone="green">รวม <span className="whitespace-nowrap">{baht(selectedNet)} ฿</span> · {groups.length} ร้าน</Badge>
              )}
            </div>

            {output ? (
              <>
                <CopyBox title="ข้อความสรุปยอดรวม" text={output} />
                <Button variant="ghost" onClick={markSent} className="self-start">
                  ✓ ทำเครื่องหมายว่าส่งแล้ว ({selected.size} เคส)
                </Button>
              </>
            ) : (
              <EmptyState title="ยังไม่มีข้อความ" hint="เลือกเคสทางซ้าย แล้วกด 'สร้างข้อความสรุปยอด'" />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
