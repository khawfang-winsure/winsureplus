import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Badge, Button, Card, Input, Loading } from './ui'
import { getRateSets, saveRateSets } from '../lib/db'
import { financeFromPrincipal, monthlyFrom, type RateSet, type RateTier } from '../lib/rates'

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `set-${Date.now()}`)

export function RateSetsEditor({ canEdit }: { canEdit: boolean }) {
  const [sets, setSets] = useState<RateSet[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    getRateSets()
      .then(setSets)
      .finally(() => setLoading(false))
  }, [])

  function update(id: string, patch: Partial<RateSet>) {
    setSets((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
    setSaved(false)
  }
  function updateTier(setId: string, idx: number, patch: Partial<RateTier>) {
    setSets((prev) =>
      prev.map((s) =>
        s.id === setId ? { ...s, tiers: s.tiers.map((t, i) => (i === idx ? { ...t, ...patch } : t)) } : s,
      ),
    )
    setSaved(false)
  }
  function addTier(setId: string) {
    setSets((prev) => prev.map((s) => (s.id === setId ? { ...s, tiers: [...s.tiers, { term: 12, multiplier: 1 }] } : s)))
    setSaved(false)
  }
  function removeTier(setId: string, idx: number) {
    setSets((prev) => prev.map((s) => (s.id === setId ? { ...s, tiers: s.tiers.filter((_, i) => i !== idx) } : s)))
    setSaved(false)
  }
  function addSet() {
    setSets((prev) => [...prev, { id: uid(), name: 'ชุดใหม่', active: true, tiers: [{ term: 6, multiplier: 1 }] }])
    setSaved(false)
  }
  function removeSet(id: string) {
    setSets((prev) => prev.filter((s) => s.id !== id))
    setSaved(false)
  }

  async function save() {
    setBusy(true)
    setErr(null)
    try {
      // เรียงงวดน้อย→มากในแต่ละชุดก่อนบันทึก
      const cleaned = sets.map((s) => ({ ...s, tiers: [...s.tiers].sort((a, b) => a.term - b.term) }))
      await saveRateSets(cleaned)
      setSets(cleaned)
      setSaved(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Loading />

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-peach bg-peach-light/40 px-4 py-3 text-sm text-ink-soft">
        เรตผ่อน = <b className="text-ink">ตัวคูณต่อจำนวนงวด</b> · ยอดจัดไฟแนนซ์ = ยอดต้น × ตัวคูณ · ค่างวด = ยอด ÷ งวด
        <br />ทำหลายชุดได้ (เช่น ชุดปกติ / ชุดโปรโมชัน) แล้วเลือกตอนสร้างสัญญา/ขยายเวลา
      </div>

      {sets.map((s) => (
        <Card key={s.id} className={s.active ? '' : 'opacity-60'}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Input
                value={s.name}
                disabled={!canEdit}
                onChange={(e) => update(s.id, { name: e.target.value })}
                className="font-semibold"
              />
              <Badge tone={s.active ? 'green' : 'neutral'}>{s.active ? 'ใช้งาน' : 'ปิด'}</Badge>
            </div>
            {canEdit && (
              <div className="flex items-center gap-2">
                <button onClick={() => update(s.id, { active: !s.active })} className="rounded-lg px-2 py-1 text-xs text-ink-soft hover:bg-peach-light">
                  {s.active ? 'ปิดชุด' : 'เปิดชุด'}
                </button>
                <button onClick={() => removeSet(s.id)} className="rounded-lg p-1.5 text-red-500 hover:bg-red-50" title="ลบชุด">
                  <Trash2 size={15} />
                </button>
              </div>
            )}
          </div>

          <div className="overflow-x-auto rounded-xl border border-peach">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="bg-peach-light text-left text-ink">
                  <th className="px-3 py-2 font-semibold">จำนวนงวด</th>
                  <th className="px-3 py-2 font-semibold">ตัวคูณ</th>
                  <th className="px-3 py-2 font-semibold">ตัวอย่าง: เครื่อง 20,000</th>
                  {canEdit && <th className="w-10 px-3 py-2" />}
                </tr>
              </thead>
              <tbody>
                {s.tiers.map((t, i) => {
                  const fin = financeFromPrincipal(20000, t.multiplier)
                  return (
                    <tr key={i} className={i % 2 ? 'bg-white' : 'bg-peach-light/20'}>
                      <td className="px-3 py-1.5">
                        <Input
                          type="number"
                          value={t.term || ''}
                          disabled={!canEdit}
                          onChange={(e) => updateTier(s.id, i, { term: Number(e.target.value) || 0 })}
                          className="w-24"
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <Input
                          type="number"
                          step="0.01"
                          value={t.multiplier || ''}
                          disabled={!canEdit}
                          onChange={(e) => updateTier(s.id, i, { multiplier: Number(e.target.value) || 0 })}
                          className="w-24"
                        />
                      </td>
                      <td className="px-3 py-1.5 text-ink-soft">
                        ยอด {fin.toLocaleString('th-TH')} · งวดละ {monthlyFrom(fin, t.term).toLocaleString('th-TH')}
                      </td>
                      {canEdit && (
                        <td className="px-3 py-1.5">
                          <button onClick={() => removeTier(s.id, i)} className="rounded-lg p-1 text-red-500 hover:bg-red-50" title="ลบงวด">
                            <Trash2 size={14} />
                          </button>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {canEdit && (
            <button onClick={() => addTier(s.id)} className="mt-2 inline-flex items-center gap-1 text-sm text-salmon-deep hover:underline">
              <Plus size={14} /> เพิ่มจำนวนงวด
            </button>
          )}
        </Card>
      ))}

      {canEdit && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="ghost" onClick={addSet}>
            <Plus size={16} /> เพิ่มชุดเรต
          </Button>
          <div className="flex items-center gap-3">
            {saved && <span className="text-sm text-green-600">บันทึกแล้ว ✓</span>}
            {err && <span className="text-sm text-red-600">{err}</span>}
            <Button onClick={save} disabled={busy}>{busy ? 'กำลังบันทึก...' : 'บันทึกชุดเรต'}</Button>
          </div>
        </div>
      )}
    </div>
  )
}
