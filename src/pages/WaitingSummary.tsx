import { Badge, EmptyState, PageTitle } from '../components/ui'
import { thaiDate } from '../lib/format'
import { contracts, shops } from '../lib/mockData'

const shopName = (id: string) => shops.find((s) => s.id === id)?.name ?? '-'

export default function WaitingSummary() {
  const pending = contracts.filter((c) => !c.summarySentAt)

  return (
    <div>
      <PageTitle sub="เคสที่ยังไม่ได้สรุปยอดโอน — เฟสถัดไปจะเลือกหลายเคสแล้วรวมยอดต่อร้านได้">
        รอสรุปยอด
      </PageTitle>
      {pending.length === 0 ? (
        <EmptyState title="ไม่มีเคสค้างสรุปยอด" />
      ) : (
        <ul className="flex flex-col gap-2">
          {pending.map((c) => (
            <li key={c.id} className="flex items-center justify-between rounded-xl border border-peach bg-white px-4 py-3">
              <div>
                <p className="font-medium text-ink">{c.customerName} — {c.contractNo}</p>
                <p className="text-sm text-ink-soft">{shopName(c.shopId)} · {thaiDate(c.transactionDate)}</p>
              </div>
              <Badge tone="amber">ยังไม่สรุปยอด</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
