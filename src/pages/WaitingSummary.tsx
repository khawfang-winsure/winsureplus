import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Pencil, RotateCcw, X } from 'lucide-react'
import { Badge, Button, EmptyState, Input, Loading, Modal, PageTitle, Select, Textarea } from '../components/ui'
import CopyBox from '../components/CopyBox'
import { calcSummary } from '../lib/calc'
import { baht, thaiDate } from '../lib/format'
import { buildBulkSummary, buildRejectionBanner, REJECTION_REASON_LABEL } from '../lib/messages'
import {
  clearNeedsFix,
  getContracts,
  getShops,
  markSummaryShopSent,
  markSummaryAccountingSent,
  updateSummaryNote,
} from '../lib/db'
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

// ===== ป็อปอัพหมายเหตุเคสติดปัญหา (สรุปยอดไม่ได้เพราะติดอะไร) =====
function SummaryNoteModal({
  contract,
  byName,
  onClose,
  onDone,
}: {
  contract: Contract
  byName: string
  onClose: () => void
  onDone: (note: string | null, byName: string) => void
}) {
  const [note, setNote] = useState(contract.summaryNote ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const trimmed = note.trim()
      await updateSummaryNote(contract.id, trimmed || null, byName)
      onDone(trimmed || null, byName)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`หมายเหตุเคสติดปัญหา — ${contract.customerName}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-soft">{contract.contractNo}</p>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">หมายเหตุ</span>
          <Textarea
            autoFocus
            rows={3}
            placeholder="เช่น รอลูกค้าโอนดาวน์เพิ่ม, เอกสารไม่ครบ ฯลฯ"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <p className="text-xs text-ink-soft">เว้นว่างแล้วบันทึก = ลบหมายเหตุ</p>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            ยกเลิก
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'กำลังบันทึก...' : 'บันทึกหมายเหตุ'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

const today = new Date().toISOString().slice(0, 10)
const SEL_KEY = 'waiting-summary:selected'
const DATE_KEY = 'waiting-summary:date'
const netOf = (c: Contract) =>
  calcSummary(c.devicePrice, c.downPercent, c.commissionPercent, c.docFee).net

export default function WaitingSummary() {
  const { name, role } = useAuth()
  const canEditNote = role === 'admin' || role === 'staff'
  const byName = name ?? 'ไม่ระบุชื่อ'
  const { data, loading } = useAsync(
    async () => {
      const [contracts, shops] = await Promise.all([getContracts(), getShops()])
      return { contracts, shops }
    },
    { contracts: [] as Contract[], shops: [] as Shop[] },
  )

  // 2 ด่าน: locallyShopSent = กดส่งร้านรอบนี้ (เด้งไปคอลัมน์ขวา), locallyAccountingSent = กดส่งบัญชี (จบ)
  const [locallyShopSent, setLocallyShopSent] = useState<Set<string>>(new Set())
  const [locallyAccountingSent, setLocallyAccountingSent] = useState<Set<string>>(new Set())
  // เคสที่กด "แก้แล้ว ส่งใหม่" รอบนี้ — ซ่อนป้ายตีกลับทันทีโดยไม่ต้อง reload ทั้งหน้า (req2)
  const [locallyClearedNeedsFix, setLocallyClearedNeedsFix] = useState<Set<string>>(new Set())
  const [clearingId, setClearingId] = useState<string | null>(null)
  // หมายเหตุเคสติดปัญหา — เก็บ override ในเครื่องหลังบันทึก (ทั้งข้อความ+คนเขียน) กันต้อง reload ทั้งหน้า
  const [noteOverride, setNoteOverride] = useState<Map<string, { note: string | null; by: string }>>(new Map())
  const [noteTarget, setNoteTarget] = useState<Contract | null>(null)
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
  const [selectedAccounting, setSelectedAccounting] = useState<Set<string>>(new Set())
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
  // หมายเหตุที่ใช้แสดงจริง — ถ้ามี override (เพิ่งบันทึกรอบนี้) ใช้ override ก่อน ไม่งั้นใช้ค่าจาก DB
  const noteOf = (c: Contract) =>
    noteOverride.has(c.id) ? noteOverride.get(c.id)!.note : c.summaryNote ?? null
  // ป้ายชื่อคนโน้ต — ต้องมาจากแหล่งเดียวกับ noteOf กันข้อความ/ชื่อไม่ตรงกันระหว่างรอ reload
  const noteByOf = (c: Contract) =>
    noteOverride.has(c.id) ? noteOverride.get(c.id)!.by : c.summaryNoteBy ?? null

  // จำสิ่งที่ติ๊กไว้ (ฝั่งร้าน) + วันที่สรุป ข้าม reload
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

  // คอลัมน์ซ้าย (รอส่งร้าน): ยังไม่ส่งร้าน + ยังไม่กดอะไรรอบนี้
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

  // คอลัมน์ขวา (รอส่งบัญชี): ส่งร้านแล้ว (DB หรือรอบนี้) แต่ยังไม่ส่งบัญชี
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

  // ตัด id ที่ค้างใน localStorage แต่ไม่อยู่ในคอลัมน์ซ้ายแล้ว (ถูกส่ง/เด้งไปขวา) ออก หลังโหลดเสร็จ
  useEffect(() => {
    if (loading) return
    const valid = new Set(shopBase.map((c) => c.id))
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => valid.has(id)))
      return next.size !== prev.size ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, shopBase])

  // prune ฝั่งบัญชี เทียบ accountingBase (กัน id ค้างหลังเคสถูกส่งบัญชี/หายไป)
  useEffect(() => {
    if (loading) return
    const valid = new Set(accountingBase.map((c) => c.id))
    setSelectedAccounting((prev) => {
      const next = new Set([...prev].filter((id) => valid.has(id)))
      return next.size !== prev.size ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, accountingBase])

  // ร้านที่เลือกได้ = ร้านที่มีเคสค้างใน "ทั้ง 2 base" (union) หลังกรองช่วงวันที่ — จะได้ไม่หายตอนกรอง
  const shopOptions = useMemo(() => {
    const inRange = (c: Contract) => {
      if (fromDate && c.transactionDate < fromDate) return false
      if (toDate && c.transactionDate > toDate) return false
      return true
    }
    const ids = new Set<string>()
    shopBase.filter(inRange).forEach((c) => ids.add(c.shopId))
    accountingBase.filter(inRange).forEach((c) => ids.add(c.shopId))
    return [...data.shops]
      .filter((s) => ids.has(s.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'th'))
  }, [shopBase, accountingBase, data.shops, fromDate, toDate])

  const hasFilter = !!(fromDate || toDate || shopFilter)
  const clearFilter = () => {
    setFromDate('')
    setToDate('')
    setShopFilter('')
  }

  // ตัวกรอง+sort ใช้ร่วมทั้ง 2 คอลัมน์
  const applyFilterSort = (list: Contract[]) => {
    const [key, dir] = sortOpt.split('_') as [SortKey, SortDir]
    const filtered = list.filter((c) => {
      if (fromDate && c.transactionDate < fromDate) return false
      if (toDate && c.transactionDate > toDate) return false
      if (shopFilter && c.shopId !== shopFilter) return false
      return true
    })
    return sortContracts(filtered, key, dir)
  }

  const pendingShop = useMemo(
    () => applyFilterSort(shopBase),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shopBase, sortOpt, fromDate, toDate, shopFilter],
  )

  const pendingAccounting = useMemo(
    () => applyFilterSort(accountingBase),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accountingBase, sortOpt, fromDate, toDate, shopFilter],
  )

  function toggleShop(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllShop() {
    setSelected((prev) =>
      prev.size === pendingShop.length ? new Set() : new Set(pendingShop.map((c) => c.id)),
    )
  }

  function toggleAccounting(id: string) {
    setSelectedAccounting((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllAccounting() {
    setSelectedAccounting((prev) =>
      prev.size === pendingAccounting.length
        ? new Set()
        : new Set(pendingAccounting.map((c) => c.id)),
    )
  }

  // จัดกลุ่มเคสที่เลือกตามร้าน เพื่อป้อนตัวสร้างข้อความรวม — ฝั่งร้าน
  const groups = useMemo(() => {
    const map = new Map<string, { shop: Shop; items: Contract[] }>()
    pendingShop
      .filter((c) => selected.has(c.id))
      .forEach((c) => {
        const shop = shopOf(c.shopId)
        if (!shop) return
        if (!map.has(shop.id)) map.set(shop.id, { shop, items: [] })
        map.get(shop.id)!.items.push(c)
      })
    return [...map.values()]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingShop, selected])

  // ข้อความสรุปยอดส่งร้าน — derived อัตโนมัติจากเคสที่เลือก + วันที่สรุป
  const shopOutput = useMemo(
    () => (groups.length === 0 ? '' : buildBulkSummary(groups, date)),
    [groups, date],
  )

  // จัดกลุ่มเคสที่เลือกฝั่งบัญชีตามร้าน
  const accountingGroups = useMemo(() => {
    const map = new Map<string, { shop: Shop; items: Contract[] }>()
    pendingAccounting
      .filter((c) => selectedAccounting.has(c.id))
      .forEach((c) => {
        const shop = shopOf(c.shopId)
        if (!shop) return
        if (!map.has(shop.id)) map.set(shop.id, { shop, items: [] })
        map.get(shop.id)!.items.push(c)
      })
    return [...map.values()]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAccounting, selectedAccounting])

  // ข้อความสรุปยอดส่งบัญชี — derived จากเคสที่เลือก
  const accountingOutput = useMemo(
    () => (accountingGroups.length === 0 ? '' : buildBulkSummary(accountingGroups, date)),
    [accountingGroups, date],
  )

  async function markShopSent() {
    const ids = [...selected]
    const flagged = pendingShop.filter((c) => ids.includes(c.id) && c.pendingDocuments)
    if (flagged.length > 0) {
      const names = flagged.map((c) => c.customerName).join(', ')
      const ok = window.confirm(
        `มี ${flagged.length} เคสรอเอกสาร: ${names}\n\nยืนยันว่าเอกสารครบทั้งหมดแล้ว?`,
      )
      if (!ok) return
    }
    await markSummaryShopSent(ids, name ?? undefined, date) // บันทึกลง DB จริง (กันส่งซ้ำ) — เกาะวันที่สรุปที่เลือก
    setLocallyShopSent((prev) => new Set([...prev, ...ids]))
    setSelected(new Set())
  }

  async function markAccountingSent() {
    const ids = [...selectedAccounting]
    if (ids.length === 0) return
    await markSummaryAccountingSent(ids, name ?? undefined, date) // บันทึกลง DB จริง — เกาะวันที่สรุปที่เลือก
    setLocallyAccountingSent((prev) => new Set([...prev, ...ids]))
    setSelectedAccounting(new Set())
  }

  // req2: เคสที่ถูกตีกลับ (needsFixReason != null) กด "แก้แล้ว ส่งใหม่" → เคลียร์ needs_fix_* แล้วซ่อนป้ายทันที
  async function handleClearNeedsFix(contractId: string) {
    setClearingId(contractId)
    try {
      await clearNeedsFix(contractId)
      setLocallyClearedNeedsFix((prev) => new Set([...prev, contractId]))
    } finally {
      setClearingId(null)
    }
  }

  const selectedShopNet = groups.flatMap((g) => g.items).reduce((sum, c) => sum + netOf(c), 0)
  const selectedAccountingNet = accountingGroups
    .flatMap((g) => g.items)
    .reduce((sum, c) => sum + netOf(c), 0)

  if (loading) {
    return (
      <div>
        <PageTitle>รอสรุปยอด</PageTitle>
        <Loading />
      </div>
    )
  }

  const noneAtAll = shopBase.length === 0 && accountingBase.length === 0

  return (
    <div>
      <PageTitle sub="2 ด่านต่อเคส: รอบ 1 ส่งให้ร้านค้า → รอบ 2 สรุปยอดรวมส่งแผนกบัญชี (กันส่งซ้ำด้วยการทำเครื่องหมายว่าส่งแล้ว)">
        รอสรุปยอด
      </PageTitle>

      {noneAtAll ? (
        <EmptyState title="ไม่มีเคสรอสรุปยอด" hint="เคสใหม่จะเข้ามาที่นี่อัตโนมัติ" />
      ) : (
        <>
          {/* แถบควบคุมรวม: วันที่สรุป + sort + ตัวกรอง (ช่วงวันที่+ร้าน) — กระทบทั้ง 2 คอลัมน์ */}
          <div className="mb-5 flex flex-col gap-3 rounded-2xl border border-peach bg-white px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
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
            </div>
            <div className="flex flex-wrap items-center gap-3">
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
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            {/* ── คอลัมน์ซ้าย: รอส่งร้าน ── */}
            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-ink">รอส่งร้าน ({pendingShop.length})</h2>
                {pendingShop.length > 0 && (
                  <Button variant="ghost" onClick={toggleAllShop} className="text-sm">
                    {selected.size === pendingShop.length ? 'ยกเลิกเลือกทั้งหมด' : 'เลือกทั้งหมด'}
                  </Button>
                )}
              </div>

              {shopBase.length === 0 ? (
                <EmptyState title="ไม่มีเคสรอส่งร้าน" />
              ) : pendingShop.length === 0 ? (
                <EmptyState title="ไม่มีเคสตรงตัวกรอง" hint="ลองปรับช่วงวันหรือร้าน" />
              ) : (
                <ul className="flex flex-col gap-2">
                  {pendingShop.map((c) => {
                    const checked = selected.has(c.id)
                    const isRejected = !!c.needsFixReason && !locallyClearedNeedsFix.has(c.id)
                    return (
                      <li
                        key={c.id}
                        onClick={() => toggleShop(c.id)}
                        className={`flex cursor-pointer flex-col gap-2 rounded-xl border px-4 py-3 transition ${
                          isRejected
                            ? 'border-red-300 bg-red-50/60'
                            : checked
                              ? 'border-salmon-deep bg-peach-light/60'
                              : 'border-peach bg-white hover:bg-peach-light/30'
                        }`}
                      >
                        <div className="flex items-center gap-3">
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
                              {canEditNote && (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); setNoteTarget(c) }}
                                  aria-label="แก้ไขหมายเหตุ"
                                  title="แก้ไขหมายเหตุ"
                                  className="rounded p-0.5 text-ink-soft transition hover:bg-peach-light/50 hover:text-ink"
                                >
                                  <Pencil size={12} />
                                </button>
                              )}
                            </div>
                            <p className="text-sm text-ink-soft">
                              {shopOf(c.shopId)?.name} · {thaiDate(c.transactionDate)}
                            </p>
                            {noteOf(c) && (
                              <p className="text-xs text-ink-soft">
                                หมายเหตุ: {noteOf(c)}
                                {noteByOf(c) && <span className="ml-1 text-[11px]">({noteByOf(c)})</span>}
                              </p>
                            )}
                          </div>
                          <span className="font-semibold text-salmon-deep whitespace-nowrap">{baht(netOf(c))} ฿</span>
                        </div>
                        {isRejected && (
                          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-red-100 px-3 py-2">
                            <p className="text-xs font-medium text-red-700">
                              {buildRejectionBanner(
                                REJECTION_REASON_LABEL[c.needsFixReason ?? ''] ?? c.needsFixReason ?? '',
                                c.needsFixDetail ?? null,
                                c.needsFixBy ?? '-',
                                c.needsFixAt ?? '',
                              )}
                            </p>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                void handleClearNeedsFix(c.id)
                              }}
                              disabled={clearingId === c.id}
                              className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-red-300 bg-white px-2 py-1 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-50"
                            >
                              <RotateCcw size={12} />
                              {clearingId === c.id ? 'กำลังบันทึก...' : 'แก้แล้ว ส่งใหม่'}
                            </button>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}

              {shopOutput && (
                <div className="flex flex-col gap-3">
                  <Badge tone="green">
                    รวม <span className="whitespace-nowrap">{baht(selectedShopNet)} ฿</span> · {groups.length} ร้าน
                  </Badge>
                  <CopyBox title="ข้อความสรุปยอดส่งร้าน" text={shopOutput} />
                  <Button variant="ghost" onClick={markShopSent} className="self-start">
                    ✓ ทำเครื่องหมายว่าส่งร้านแล้ว ({selected.size} เคส)
                  </Button>
                </div>
              )}
            </section>

            {/* ── คอลัมน์ขวา: ส่งร้านแล้ว · รอส่งบัญชี ── */}
            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-ink">
                  ส่งร้านแล้ว · รอส่งบัญชี ({pendingAccounting.length})
                </h2>
                {pendingAccounting.length > 0 && (
                  <Button variant="ghost" onClick={toggleAllAccounting} className="text-sm">
                    {selectedAccounting.size === pendingAccounting.length ? 'ยกเลิกเลือกทั้งหมด' : 'เลือกทั้งหมด'}
                  </Button>
                )}
              </div>

              {accountingBase.length === 0 ? (
                <EmptyState title="ยังไม่มีเคสรอส่งบัญชี" hint="เคสจะเข้ามาเมื่อกดส่งร้านแล้ว" />
              ) : pendingAccounting.length === 0 ? (
                <EmptyState title="ไม่มีเคสตรงตัวกรอง" hint="ลองปรับช่วงวันหรือร้าน" />
              ) : (
                <ul className="flex flex-col gap-2">
                  {pendingAccounting.map((c) => {
                    const checked = selectedAccounting.has(c.id)
                    return (
                      <li
                        key={c.id}
                        onClick={() => toggleAccounting(c.id)}
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
                            {canEditNote && (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setNoteTarget(c) }}
                                aria-label="แก้ไขหมายเหตุ"
                                title="แก้ไขหมายเหตุ"
                                className="rounded p-0.5 text-ink-soft transition hover:bg-peach-light/50 hover:text-ink"
                              >
                                <Pencil size={12} />
                              </button>
                            )}
                          </div>
                          <p className="text-sm text-ink-soft">
                            {shopOf(c.shopId)?.name} · {thaiDate(c.transactionDate)}
                          </p>
                          {noteOf(c) && (
                            <p className="text-xs text-ink-soft">
                              หมายเหตุ: {noteOf(c)}
                              {noteByOf(c) && <span className="ml-1 text-[11px]">({noteByOf(c)})</span>}
                            </p>
                          )}
                        </div>
                        <span className="font-semibold text-salmon-deep whitespace-nowrap">{baht(netOf(c))} ฿</span>
                      </li>
                    )
                  })}
                </ul>
              )}

              {accountingOutput && (
                <div className="flex flex-col gap-3">
                  <Badge tone="green">
                    รวม <span className="whitespace-nowrap">{baht(selectedAccountingNet)} ฿</span> · {accountingGroups.length} ร้าน
                  </Badge>
                  <CopyBox title="ข้อความสรุปยอดส่งบัญชี" text={accountingOutput} />
                  <Button variant="ghost" onClick={markAccountingSent} className="self-start">
                    ✓ ทำเครื่องหมายส่งบัญชีแล้ว ({selectedAccounting.size} เคส)
                  </Button>
                </div>
              )}
            </section>
          </div>
        </>
      )}

      {noteTarget && (
        <SummaryNoteModal
          contract={noteTarget}
          byName={byName}
          onClose={() => setNoteTarget(null)}
          onDone={(savedNote, savedBy) => {
            setNoteOverride((prev) => new Map(prev).set(noteTarget.id, { note: savedNote, by: savedBy }))
            setNoteTarget(null)
          }}
        />
      )}
    </div>
  )
}
