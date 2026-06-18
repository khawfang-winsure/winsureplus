import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { FileBox, FileCheck } from 'lucide-react'
import { Badge, Button, EmptyState, Input, Loading, PageTitle, Select } from '../components/ui'
import { thaiDate } from '../lib/format'
import { getContracts, getShops, markDocsReceived, markBoxReceived } from '../lib/db'
import { isDocComplete, shopDocStats } from '../lib/docTracking'
import { useAsync } from '../lib/useAsync'
import { useAuth } from '../lib/auth'
import type { Contract, Shop } from '../lib/types'

// ===== วันค้าง (วันนี้ − transactionDate, Math.floor) =====
function daysOpen(transactionDate: string, ref: Date): number {
  const txMs = new Date(transactionDate).getTime()
  if (isNaN(txMs)) return 0
  return Math.floor((ref.getTime() - txMs) / (1000 * 60 * 60 * 24))
}

// ===== แถวสัญญาพร้อมปุ่มติ๊กรับ inline =====
function DocRow({
  contract,
  refDate,
  userName,
  onUpdated,
}: {
  contract: Contract
  refDate: Date
  userName: string | null
  onUpdated: (updated: Partial<Contract> & { id: string }) => void
}) {
  const days = contract.transactionDate ? daysOpen(contract.transactionDate, refDate) : null

  async function handleMarkDocs() {
    await markDocsReceived(contract.id, userName ?? undefined)
    const now = new Date().toISOString()
    onUpdated({
      id: contract.id,
      originalDocsReceived: true,
      originalDocsReceivedAt: now,
      originalDocsReceivedBy: userName ?? null,
    })
  }

  async function handleMarkBox() {
    await markBoxReceived(contract.id, userName ?? undefined)
    const now = new Date().toISOString()
    onUpdated({
      id: contract.id,
      phoneBoxReceived: true,
      phoneBoxReceivedAt: now,
      phoneBoxReceivedBy: userName ?? null,
    })
  }

  return (
    <tr className="border-t border-peach-light/60 hover:bg-peach-light/20">
      <td className="py-2 pr-3 text-sm">
        <Link
          to={`/contract/${contract.id}`}
          className="font-medium text-ink hover:text-salmon-deep hover:underline"
        >
          {contract.customerName}
        </Link>
        <p className="text-xs text-ink-soft">{contract.contractNo}</p>
      </td>
      <td className="py-2 pr-3 text-sm text-ink">
        {days !== null ? `${days} วัน` : '—'}
      </td>
      <td className="py-2 pr-3">
        {contract.originalDocsReceived ? (
          <span className="flex items-center gap-1 text-xs text-green-700">
            <FileCheck size={13} />
            {contract.originalDocsReceivedAt
              ? thaiDate(contract.originalDocsReceivedAt.slice(0, 10))
              : 'รับแล้ว'}
          </span>
        ) : (
          <div className="flex items-center gap-1.5">
            <Badge tone="amber">รอรับ</Badge>
            <Button variant="ghost" onClick={() => void handleMarkDocs()}>
              ติ๊ก
            </Button>
          </div>
        )}
      </td>
      <td className="py-2">
        {!contract.hasPhoneBox ? (
          <span className="text-xs text-ink-soft">—</span>
        ) : contract.phoneBoxReceived ? (
          <span className="flex items-center gap-1 text-xs text-green-700">
            <FileCheck size={13} />
            {contract.phoneBoxReceivedAt
              ? thaiDate(contract.phoneBoxReceivedAt.slice(0, 10))
              : 'รับแล้ว'}
          </span>
        ) : (
          <div className="flex items-center gap-1.5">
            <Badge tone="amber">รอรับ</Badge>
            <Button variant="ghost" onClick={() => void handleMarkBox()}>
              ติ๊ก
            </Button>
          </div>
        )}
      </td>
    </tr>
  )
}

export default function DocTracking() {
  const { name: userName } = useAuth()

  const refDate = useMemo(() => new Date(), [])

  const { data, loading } = useAsync(
    async () => {
      const [contracts, shops] = await Promise.all([getContracts(), getShops()])
      return { contracts, shops }
    },
    { contracts: [] as Contract[], shops: [] as Shop[] },
  )

  // optimistic update — แก้ contract ใน local state โดยไม่ต้อง refetch
  const [overrides, setOverrides] = useState<Map<string, Partial<Contract>>>(new Map())

  function handleUpdated(patch: Partial<Contract> & { id: string }) {
    setOverrides((prev) => {
      const next = new Map(prev)
      next.set(patch.id, { ...(next.get(patch.id) ?? {}), ...patch })
      return next
    })
  }

  // รวม overrides เข้ากับ contracts จาก DB
  const merged = useMemo<Contract[]>(
    () =>
      data.contracts.map((c) => {
        const ov = overrides.get(c.id)
        return ov ? { ...c, ...ov } : c
      }),
    [data.contracts, overrides],
  )

  const [search, setSearch] = useState('')
  const [filterShop, setFilterShop] = useState('all')

  // active/online ทั้งหมด — ใช้เป็นฐานให้ shopDocStats (completedCount รวมตัวที่รับครบแล้ว)
  const activeOnline = useMemo(
    () => merged.filter((c) => c.status === 'active' || c.status === 'online'),
    [merged],
  )

  // กรอง: active/online เท่านั้น + ยังไม่ complete
  const pending = useMemo(
    () => activeOnline.filter((c) => !isDocComplete(c)),
    [activeOnline],
  )

  // search filter
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return pending
    return pending.filter(
      (c) =>
        c.customerName.toLowerCase().includes(q) ||
        c.contractNo.toLowerCase().includes(q),
    )
  }, [pending, search])

  // shop filter
  const filtered = useMemo(() => {
    if (filterShop === 'all') return searched
    return searched.filter((c) => c.shopId === filterShop)
  }, [searched, filterShop])

  // จัดกลุ่มตาม shopId เรียงตาม totalPendingCount มาก→น้อย
  const groups = useMemo(() => {
    const map = new Map<string, Contract[]>()
    filtered.forEach((c) => {
      if (!map.has(c.shopId)) map.set(c.shopId, [])
      map.get(c.shopId)!.push(c)
    })
    const shopOf = (id: string) => data.shops.find((s) => s.id === id)
    return Array.from(map.entries())
      .map(([shopId, rows]) => ({
        shopId,
        shop: shopOf(shopId),
        rows,
        stats: shopDocStats(activeOnline, shopId, refDate),
      }))
      .sort((a, b) => b.stats.totalPendingCount - a.stats.totalPendingCount)
  }, [filtered, data.shops, activeOnline, refDate])

  // shop dropdown options — เฉพาะร้านที่มีรายการค้าง
  const shopOptions = useMemo(() => {
    const ids = new Set(pending.map((c) => c.shopId))
    return data.shops.filter((s) => ids.has(s.id))
  }, [pending, data.shops])

  if (loading) {
    return (
      <div>
        <PageTitle>รับเอกสาร/กล่อง</PageTitle>
        <Loading />
      </div>
    )
  }

  return (
    <div>
      <PageTitle sub={`ค้าง ${pending.length} รายการ`}>
        <span className="flex items-center gap-2">
          <FileBox size={20} /> รับเอกสาร/กล่อง
        </span>
      </PageTitle>

      {/* search + filter */}
      <div className="mb-4 flex flex-wrap gap-3">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="ค้นหาชื่อลูกค้า / เลขสัญญา"
          className="w-64"
        />
        <Select
          value={filterShop}
          onChange={(e) => setFilterShop(e.target.value)}
          className="w-52"
        >
          <option value="all">ทุกร้าน</option>
          {shopOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} {s.name}
            </option>
          ))}
        </Select>
      </div>

      {groups.length === 0 ? (
        <EmptyState title="ไม่มีรายการค้าง" hint="ทุกสัญญาได้รับเอกสาร/กล่องครบแล้ว" />
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map(({ shopId, shop, rows, stats }) => (
            <div key={shopId}>
              {/* sub-header ร้าน */}
              <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="font-semibold text-ink">
                  {shop ? `${shop.code} ${shop.name}` : shopId}
                </span>
                <span className="text-sm text-ink-soft">
                  ค้าง {stats.totalPendingCount} รายการ
                  {stats.avgDaysOpen !== null && ` · เฉลี่ย ${stats.avgDaysOpen} วัน`}
                  {stats.maxDaysOpen !== null && ` · ค้างนาน ${stats.maxDaysOpen} วัน`}
                </span>
              </div>

              {/* ตาราง */}
              <div className="overflow-x-auto rounded-2xl border border-peach-light/60 bg-white">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-peach-light/60 text-xs text-ink-soft">
                      <th className="py-2 pr-3 font-medium">ลูกค้า / สัญญา</th>
                      <th className="py-2 pr-3 font-medium">วันค้าง</th>
                      <th className="py-2 pr-3 font-medium">เอกสารตัวจริง</th>
                      <th className="py-2 font-medium">กล่องเครื่อง</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c) => (
                      <DocRow
                        key={c.id}
                        contract={c}
                        refDate={refDate}
                        userName={userName}
                        onUpdated={handleUpdated}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
