import { useMemo, useState } from 'react'
import { Receipt } from 'lucide-react'
import { Badge, Button, EmptyState, Input, PageTitle } from '../components/ui'
import CopyBox from '../components/CopyBox'
import { calcSummary } from '../lib/calc'
import { baht, thaiDate } from '../lib/format'
import { buildBulkSummary } from '../lib/messages'
import { contracts as allContracts, shops } from '../lib/mockData'
import type { Contract, Shop } from '../lib/types'

const shopOf = (id: string) => shops.find((s) => s.id === id)
const today = new Date().toISOString().slice(0, 10)

export default function WaitingSummary() {
  // ใช้ state ติดตามว่าเคสไหน "ส่งแล้ว" (mock — เฟสถัดไปจะบันทึกลง Supabase)
  const [sentIds, setSentIds] = useState<Set<string>>(
    () => new Set(allContracts.filter((c) => c.summarySentAt).map((c) => c.id)),
  )
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [date, setDate] = useState(today)
  const [output, setOutput] = useState('')

  const pending = allContracts.filter((c) => !sentIds.has(c.id))

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
  }, [pending, selected])

  function generate() {
    if (groups.length === 0) return
    setOutput(buildBulkSummary(groups, date))
  }

  function markSent() {
    setSentIds((prev) => new Set([...prev, ...selected]))
    setSelected(new Set())
    setOutput('')
  }

  const selectedNet = groups
    .flatMap((g) => g.items)
    .reduce((sum, c) => sum + calcSummary(c.devicePrice, c.downPercent, c.commissionPercent, c.docFee).net, 0)

  return (
    <div>
      <PageTitle sub="เลือกเคสที่จะสรุปยอด → ระบบรวมยอดโอนของทุกร้านในวันเดียว (กันส่งซ้ำด้วยการทำเครื่องหมายว่าส่งแล้ว)">
        รอสรุปยอด
      </PageTitle>

      {pending.length === 0 ? (
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
              <span className="text-sm text-ink-soft">เลือกแล้ว {selected.size} เคส</span>
            </div>

            <ul className="flex flex-col gap-2">
              {pending.map((c) => {
                const net = calcSummary(c.devicePrice, c.downPercent, c.commissionPercent, c.docFee).net
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
                      <p className="font-medium text-ink">{c.customerName} — {c.contractNo}</p>
                      <p className="text-sm text-ink-soft">
                        {shopOf(c.shopId)?.name} · {thaiDate(c.transactionDate)}
                      </p>
                    </div>
                    <span className="font-semibold text-salmon-deep">{baht(net)} ฿</span>
                  </li>
                )
              })}
            </ul>
          </div>

          {/* ฝั่งขวา: ผลลัพธ์ */}
          <div className="flex flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={generate} disabled={selected.size === 0}>
                <Receipt size={16} /> สร้างข้อความสรุปยอด
              </Button>
              {selected.size > 0 && (
                <Badge tone="green">รวม {baht(selectedNet)} ฿ · {groups.length} ร้าน</Badge>
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
