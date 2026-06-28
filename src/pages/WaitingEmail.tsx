import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Mail, X } from 'lucide-react'
import { Badge, Button, EmptyState, Input, Loading, Modal, PageTitle, Select } from '../components/ui'
import CopyBox from '../components/CopyBox'
import { thaiDate } from '../lib/format'
import { buildEmailText } from '../lib/messages'
import { getContracts, getShops, markEmailSent } from '../lib/db'
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

export default function WaitingEmail() {
  const { name } = useAuth()
  const { data, loading } = useAsync(
    async () => {
      const [contracts, shops] = await Promise.all([getContracts(), getShops()])
      return { contracts, shops }
    },
    { contracts: [] as Contract[], shops: [] as Shop[] },
  )

  const [sentIds, setSentIds] = useState<Set<string>>(new Set())
  const [view, setView] = useState<Contract | null>(null)
  const [sortOpt, setSortOpt] = useState<`${SortKey}_${SortDir}`>('transactionDate_desc')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [shopFilter, setShopFilter] = useState('')

  const shopOf = (id: string) => data.shops.find((s) => s.id === id)

  // เคสที่ยังไม่ส่ง (ก่อนกรอง) — ใช้แยก empty-state
  const base = useMemo(
    () => data.contracts.filter((c) => !c.emailSentAt && !sentIds.has(c.id)),
    [data.contracts, sentIds],
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

  async function doMarkSent(c: Contract) {
    if (c.pendingDocuments) {
      const ok = window.confirm(
        `เอกสารของ ${c.customerName} ครบแล้วใช่ไหม?\n\nยืนยัน = ส่งอีเมล + เคลียร์สถานะรอเอกสาร`,
      )
      if (!ok) return
    }
    await markEmailSent(c.id, name ?? undefined)
    setSentIds((prev) => new Set([...prev, c.id]))
    setView(null)
  }

  return (
    <div>
      <PageTitle
        sub="เคสที่ยังไม่ได้ส่งอีเมลให้พาร์ทเนอร์ (กดดูข้อความ → คัดลอกไปส่ง → ทำเครื่องหมายส่งแล้ว)"
        count={loading ? undefined : { shown: pending.length }}
      >
        รอส่งอีเมล
      </PageTitle>
      {loading ? (
        <Loading />
      ) : base.length === 0 ? (
        <EmptyState title="ไม่มีเคสค้างส่งอีเมล" hint="เคสที่ส่งแล้วจะถูกซ่อนอัตโนมัติ" />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <Select
              value={sortOpt}
              onChange={(e) => setSortOpt(e.target.value as `${SortKey}_${SortDir}`)}
              className="w-auto text-sm"
            >
              {SORT_OPTS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
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
          {pending.map((c) => (
            <li key={c.id} className="flex items-center justify-between rounded-xl border border-peach bg-white px-4 py-3">
              <div>
                <p className="font-medium text-ink">
                  <Link to={`/contract/${c.id}`} className="text-salmon-deep hover:underline">
                    {c.customerName}
                  </Link>
                  {' '}— {c.contractNo}
                </p>
                <p className="text-sm text-ink-soft">{shopOf(c.shopId)?.name ?? '-'} · {thaiDate(c.transactionDate)}</p>
              </div>
              <div className="flex items-center gap-2">
                {c.pendingDocuments && <Badge tone="amber">รอเอกสาร</Badge>}
                <Badge tone="amber">ยังไม่ส่ง</Badge>
                <Button variant="ghost" onClick={() => setView(c)}>
                  <Mail size={15} /> ดูอีเมล
                </Button>
              </div>
            </li>
          ))}
          </ul>
          )}
        </>
      )}

      {view && (
        <Modal title={`อีเมล — ${view.customerName}`} onClose={() => setView(null)}>
          <div className="flex flex-col gap-3">
            <CopyBox title="ข้อความอีเมล" text={shopOf(view.shopId) ? buildEmailText(view, shopOf(view.shopId)!) : ''} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setView(null)}>ปิด</Button>
              <Button onClick={() => doMarkSent(view)}>✓ ทำเครื่องหมายว่าส่งแล้ว</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
