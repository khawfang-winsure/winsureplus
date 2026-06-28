import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { X } from 'lucide-react'
import { Badge, Button, EmptyState, Input, Loading, PageTitle, Select } from '../components/ui'
import CopyBox from '../components/CopyBox'
import { calcSummary } from '../lib/calc'
import { baht, thaiDate } from '../lib/format'
import { buildBulkSummary } from '../lib/messages'
import { getContracts, getShops, markSummaryShopSent, markSummaryAccountingSent } from '../lib/db'
import { useAuth } from '../lib/auth'
import { useAsync } from '../lib/useAsync'
import type { Contract, Shop } from '../lib/types'

type SortKey = 'transactionDate' | 'contractNo' | 'createdAt'
type SortDir = 'asc' | 'desc'
type Tab = 'shop' | 'accounting'

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
const SEL_KEY = 'waiting-summary:selected'
const DATE_KEY = 'waiting-summary:date'
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

  const [tab, setTab] = useState<Tab>('shop')
  // 2 ด่าน: locallyShopSent = กดส่งร้านรอบนี้ (เด้งไปแท็บ 2), locallyAccountingSent = กดส่งบัญชี (จบ)
  const [locallyShopSent, setLocallyShopSent] = useState<Set<string>>(new Set())
  const [locallyAccountingSent, setLocallyAccountingSent] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(SEL_KEY)
      if (!raw) return new Set<string>()
      const arr = JSON.parse(raw) as string[]
      return new Set<string>(arr)
    } catch {
      return new Set<string>()
    }
  })
  const [date, setDate] = useState<string>(() => {
    try {
      return localStorage.getItem(DATE_KEY) || today
    } catch {
      return today
    }
  })
  const [sortOpt, setSortOpt] = useState<`${SortKey}_${SortDir}`>('transactionDate_desc')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [shopFilter, setShopFilter] = useState('')

  const shopOf = (id: string) => data.shops.find((s) => s.id === id)

  // จำสิ่งที่ติ๊กไว้ + วันที่สรุป ข้าม reload
  useEffect(() => {
    try {
      localStorage.setItem(SEL_KEY, JSON.stringify([...selected]))
    } catch {
      /* ignore quota/private-mode errors */
    }
  }, [selected])

  useEffect(() => {
    try {
      localStorage.setItem(DATE_KEY, date)
    } catch {
      /* ignore quota/private-mode errors */
    }
  }, [date])

  // แท็บ 1 (รอส่งร้าน): ยังไม่ส่งร้าน + ยังไม่กดอะไรรอบนี้
  const shopBase = useMemo(
    () =>
      data.contracts.filter(
        (c) =>
          c.summaryShopSentAt == null &&
          !locallyShopSent.has(c.id) &&
          !locallyAccountingSent.has(c.id),
      ),
    [data.contracts, locallyShopSent, locallyAccountingSent],
  )

  // แท็บ 2 (รอส่งบัญชี): ส่งร้านแล้ว (DB หรือรอบนี้) แต่ยังไม่ส่งบัญชี
  const accountingBase = useMemo(
    () =>
      data.contracts.filter(
        (c) =>
          c.summaryAccountingSentAt == null &&
          !locallyAccountingSent.has(c.id) &&
          (c.summaryShopSentAt != null || locallyShopSent.has(c.id)),
      ),
    [data.contracts, locallyShopSent, locallyAccountingSent],
  )

  // ตัด id ที่ค้างใน localStorage แต่ไม่อยู่ในแท็บ 1 แล้ว (ถูกส่ง/เด้งไปแท็บ 2) ออก หลังโหลดเสร็จ
  useEffect(() => {
    if (loading) return
    const valid = new Set(shopBase.map((c) => c.id))
    const next = new Set([...selected].filter((id) => valid.has(id)))
    if (next.size !== selected.size) setSelected(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, shopBase])

  // ร้านที่เลือกได้ (เฉพาะร้านที่มีเคสค้างในลิสต์ หลังกรองวันที่) — แท็บ 1
  const shopOptions = useMemo(() => {
    const dateFiltered = shopBase.filter((c) => {
      if (fromDate && c.transactionDate < fromDate) return false
      if (toDate && c.transactionDate > toDate) return false
      return true
    })
    const ids = new Set(dateFiltered.map((c) => c.shopId))
    return [...data.shops]
      .filter((s) => ids.has(s.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'th'))
  }, [shopBase, data.shops, fromDate, toDate])

  const hasFilter = !!(fromDate || toDate || shopFilter)
  const clearFilter = () => {
    setFromDate('')
    setToDate('')
    setShopFilter('')
  }

  const pending = useMemo(() => {
    const [key, dir] = sortOpt.split('_') as [SortKey, SortDir]
    const filtered = shopBase.filter((c) => {
      if (fromDate && c.transactionDate < fromDate) return false
      if (toDate && c.transactionDate > toDate) return false
      if (shopFilter && c.shopId !== shopFilter) return false
      return true
    })
    return sortContracts(filtered, key, dir)
  }, [shopBase, sortOpt, fromDate, toDate, shopFilter])

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

  // จัดกลุ่มเคสที่เลือกตามร้าน เพื่อป้อนตัวสร้างข้อความรวม — แท็บ 1
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

  // ข้อความสรุปยอดส่งร้าน — derived อัตโนมัติจากเคสที่เลือก + วันที่สรุป (ไม่ต้องกดปุ่ม)
  const output = useMemo(
    () => (groups.length === 0 ? '' : buildBulkSummary(groups, date)),
    [groups, date],
  )

  // จัดกลุ่มเคสแท็บ 2 ตามร้าน (ทั้งหมด ไม่ต้องติ๊ก)
  const accountingGroups = useMemo(() => {
    const map = new Map<string, { shop: Shop; items: Contract[] }>()
    accountingBase.forEach((c) => {
      const shop = shopOf(c.shopId)
      if (!shop) return
      if (!map.has(shop.id)) map.set(shop.id, { shop, items: [] })
      map.get(shop.id)!.items.push(c)
    })
    return [...map.values()]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountingBase])

  // ข้อความสรุปยอดส่งบัญชี — รวมทุกร้านที่รอส่งบัญชี
  const accountingOutput = useMemo(
    () => (accountingGroups.length === 0 ? '' : buildBulkSummary(accountingGroups, date)),
    [accountingGroups, date],
  )

  async function markShopSent() {
    const ids = [...selected]
    const flagged = pending.filter((c) => ids.includes(c.id) && c.pendingDocuments)
    if (flagged.length > 0) {
      const names = flagged.map((c) => c.customerName).join(', ')
      const ok = window.confirm(
        `มี ${flagged.length} เคสรอเอกสาร: ${names}\n\nยืนยันว่าเอกสารครบทั้งหมดแล้ว?`,
      )
      if (!ok) return
    }
    await markSummaryShopSent(ids, name ?? undefined) // บันทึกลง DB จริง (กันส่งซ้ำ)
    setLocallyShopSent((prev) => new Set([...prev, ...ids]))
    setSelected(new Set())
  }

  async function markAccountingSent() {
    const ids = accountingBase.map((c) => c.id)
    if (ids.length === 0) return
    await markSummaryAccountingSent(ids, name ?? undefined) // บันทึกลง DB จริง
    setLocallyAccountingSent((prev) => new Set([...prev, ...ids]))
  }

  const selectedNet = groups.flatMap((g) => g.items).reduce((sum, c) => sum + netOf(c), 0)
  const accountingNet = accountingBase.reduce((sum, c) => sum + netOf(c), 0)

  if (loading) {
    return (
      <div>
        <PageTitle>รอสรุปยอด</PageTitle>
        <Loading />
      </div>
    )
  }

  const tabBtn = (t: Tab, label: string, n: number) => (
    <button
      onClick={() => setTab(t)}
      className={`rounded-xl px-4 py-2 text-sm font-medium transition ${
        tab === t
          ? 'bg-salmon-deep text-white'
          : 'bg-white text-ink-soft hover:bg-peach-light/40 border border-peach'
      }`}
    >
      {label} ({n})
    </button>
  )

  return (
    <div>
      <PageTitle sub="2 ด่านต่อเคส: รอบ 1 ส่งให้ร้านค้า → รอบ 2 สรุปยอดรวมส่งแผนกบัญชี (กันส่งซ้ำด้วยการทำเครื่องหมายว่าส่งแล้ว)">
        รอสรุปยอด
      </PageTitle>

      <div className="mb-4 flex flex-wrap gap-2">
        {tabBtn('shop', 'รอบ 1 · ส่งร้าน', pending.length)}
        {tabBtn('accounting', 'รอบ 2 · ส่งบัญชี', accountingBase.length)}
      </div>

      {tab === 'shop' ? (
        shopBase.length === 0 ? (
          <EmptyState title="ไม่มีเคสรอส่งร้าน" hint="เคสที่ส่งร้านแล้วจะไปรออยู่ที่รอบ 2 (ส่งบัญชี)" />
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
                  {shopOptions.map((s) => (
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
                          <Badge tone="amber">รอส่งร้าน</Badge>
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
              {selected.size > 0 && (
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone="green">รวม <span className="whitespace-nowrap">{baht(selectedNet)} ฿</span> · {groups.length} ร้าน</Badge>
                </div>
              )}

              {output ? (
                <>
                  <CopyBox title="ข้อความสรุปยอดส่งร้าน" text={output} />
                  <Button variant="ghost" onClick={markShopSent} className="self-start">
                    ✓ ทำเครื่องหมายว่าส่งร้านแล้ว ({selected.size} เคส)
                  </Button>
                </>
              ) : (
                <EmptyState title="ยังไม่มีข้อความ" hint="เลือกเคสทางซ้าย ระบบจะสร้างข้อความให้อัตโนมัติ" />
              )}
            </div>
          </div>
        )
      ) : (
        // แท็บ 2: รอส่งบัญชี — auto ไม่ต้องติ๊ก
        accountingBase.length === 0 ? (
          <EmptyState
            title="ยังไม่มีเคสรอส่งบัญชี"
            hint="เคสจะเข้ามาที่นี่อัตโนมัติเมื่อส่งร้านแล้ว"
          />
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            {/* ฝั่งซ้าย: ลิสต์เคส (read-only) */}
            <div>
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-ink">
                  วันที่สรุป
                  <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-auto" />
                </label>
                <span className="text-sm text-ink-soft">
                  {accountingBase.length} เคส · {accountingGroups.length} ร้าน
                </span>
              </div>

              <ul className="flex flex-col gap-2">
                {accountingBase.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center gap-3 rounded-xl border border-peach bg-white px-4 py-3"
                  >
                    <div className="flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="font-medium text-ink">
                          <Link to={`/contract/${c.id}`} className="text-salmon-deep hover:underline">
                            {c.customerName}
                          </Link>
                          {' '}— {c.contractNo}
                        </p>
                        <Badge tone="neutral">ส่งร้านแล้ว · รอส่งบัญชี</Badge>
                      </div>
                      <p className="text-sm text-ink-soft">
                        {shopOf(c.shopId)?.name} · {thaiDate(c.transactionDate)}
                      </p>
                    </div>
                    <span className="font-semibold text-salmon-deep whitespace-nowrap">{baht(netOf(c))} ฿</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* ฝั่งขวา: ผลลัพธ์ */}
            <div className="flex flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone="green">รวม <span className="whitespace-nowrap">{baht(accountingNet)} ฿</span> · {accountingGroups.length} ร้าน</Badge>
              </div>
              <CopyBox title="ข้อความสรุปยอดส่งบัญชี" text={accountingOutput} />
              <Button variant="ghost" onClick={markAccountingSent} className="self-start">
                ✓ ทำเครื่องหมายส่งบัญชีแล้ว ({accountingBase.length} เคส)
              </Button>
            </div>
          </div>
        )
      )}
    </div>
  )
}
