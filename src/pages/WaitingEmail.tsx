import { useState } from 'react'
import { Mail } from 'lucide-react'
import { Badge, Button, EmptyState, Loading, Modal, PageTitle } from '../components/ui'
import CopyBox from '../components/CopyBox'
import { thaiDate } from '../lib/format'
import { buildEmailText } from '../lib/messages'
import { getContracts, getShops, markEmailSent } from '../lib/db'
import { useAsync } from '../lib/useAsync'
import type { Contract, Shop } from '../lib/types'

export default function WaitingEmail() {
  const { data, loading } = useAsync(
    async () => {
      const [contracts, shops] = await Promise.all([getContracts(), getShops()])
      return { contracts, shops }
    },
    { contracts: [] as Contract[], shops: [] as Shop[] },
  )

  const [sentIds, setSentIds] = useState<Set<string>>(new Set())
  const [view, setView] = useState<Contract | null>(null)

  const shopOf = (id: string) => data.shops.find((s) => s.id === id)
  const pending = data.contracts.filter((c) => !c.emailSentAt && !sentIds.has(c.id))

  async function doMarkSent(c: Contract) {
    await markEmailSent(c.id)
    setSentIds((prev) => new Set([...prev, c.id]))
    setView(null)
  }

  return (
    <div>
      <PageTitle sub="เคสที่ยังไม่ได้ส่งอีเมลให้พาร์ทเนอร์ (กดดูข้อความ → คัดลอกไปส่ง → ทำเครื่องหมายส่งแล้ว)">
        รอส่งอีเมล
      </PageTitle>
      {loading ? (
        <Loading />
      ) : pending.length === 0 ? (
        <EmptyState title="ไม่มีเคสค้างส่งอีเมล" hint="เคสที่ส่งแล้วจะถูกซ่อนอัตโนมัติ" />
      ) : (
        <ul className="flex flex-col gap-2">
          {pending.map((c) => (
            <li key={c.id} className="flex items-center justify-between rounded-xl border border-peach bg-white px-4 py-3">
              <div>
                <p className="font-medium text-ink">{c.customerName} — {c.contractNo}</p>
                <p className="text-sm text-ink-soft">{shopOf(c.shopId)?.name ?? '-'} · {thaiDate(c.transactionDate)}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone="amber">ยังไม่ส่ง</Badge>
                <Button variant="ghost" onClick={() => setView(c)}>
                  <Mail size={15} /> ดูอีเมล
                </Button>
              </div>
            </li>
          ))}
        </ul>
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
