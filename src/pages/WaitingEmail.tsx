import { Badge, EmptyState, PageTitle } from '../components/ui'
import { thaiDate } from '../lib/format'
import { contracts, shops } from '../lib/mockData'

const shopName = (id: string) => shops.find((s) => s.id === id)?.name ?? '-'

export default function WaitingEmail() {
  const pending = contracts.filter((c) => !c.emailSentAt)

  return (
    <div>
      <PageTitle sub="เคสที่ยังไม่ได้ส่งอีเมลให้พาร์ทเนอร์ (กันตกหล่น/ส่งซ้ำ)">รอส่งอีเมล</PageTitle>
      {pending.length === 0 ? (
        <EmptyState title="ไม่มีเคสค้างส่งอีเมล" hint="เคสที่ส่งแล้วจะถูกซ่อนอัตโนมัติ" />
      ) : (
        <ul className="flex flex-col gap-2">
          {pending.map((c) => (
            <li key={c.id} className="flex items-center justify-between rounded-xl border border-peach bg-white px-4 py-3">
              <div>
                <p className="font-medium text-ink">{c.customerName} — {c.contractNo}</p>
                <p className="text-sm text-ink-soft">{shopName(c.shopId)} · {thaiDate(c.transactionDate)}</p>
              </div>
              <Badge tone="amber">ยังไม่ส่งอีเมล</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
