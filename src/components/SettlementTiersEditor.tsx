import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button, Card, Input, Loading } from './ui'
import { getSettlementTiers, saveSettlementTiers } from '../lib/db'
import type { SettlementTier } from '../lib/settlement'

export function SettlementTiersEditor({ canEdit }: { canEdit: boolean }) {
  const [tiers, setTiers] = useState<SettlementTier[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    getSettlementTiers()
      .then(setTiers)
      .finally(() => setLoading(false))
  }, [])

  function update(idx: number, patch: Partial<SettlementTier>) {
    setTiers((prev) => prev.map((t, i) => (i === idx ? { ...t, ...patch } : t)))
    setSaved(false)
  }
  function addTier() {
    setTiers((prev) => [...prev, { minRemaining: 1, percent: 0 }])
    setSaved(false)
  }
  function removeTier(idx: number) {
    setTiers((prev) => prev.filter((_, i) => i !== idx))
    setSaved(false)
  }

  async function save() {
    setBusy(true)
    setErr(null)
    try {
      // เรียงจากเหลือน้อย→มาก ก่อนบันทึก (อ่านง่าย)
      const cleaned = [...tiers].sort((a, b) => a.minRemaining - b.minRemaining)
      await saveSettlementTiers(cleaned)
      setTiers(cleaned)
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
        ส่วนลดปิดสัญญาก่อนกำหนด = <b className="text-ink">ดูจากจำนวนงวดที่เหลือ</b>
        <br />
        ระบบจะเลือกชั้นที่ <b className="text-ink">"เหลือตั้งแต่"</b> มากสุดที่ยังไม่เกินจำนวนงวดที่เหลือจริง
        <br />
        เหลือเยอะ (ปิดเร็ว) ควรตั้งให้ลดมากกว่า · ส่วนลดคิดจากค่างวดที่เหลือเท่านั้น ค่าปรับค้างไม่ลด
      </div>

      <Card>
        <div className="overflow-x-auto rounded-xl border border-peach">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="bg-peach-light text-left text-ink">
                <th className="px-3 py-2 font-semibold">เหลือตั้งแต่ (งวด)</th>
                <th className="px-3 py-2 font-semibold">ส่วนลด (%)</th>
                {canEdit && <th className="w-10 px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {tiers.length === 0 ? (
                <tr>
                  <td colSpan={canEdit ? 3 : 2} className="px-3 py-4 text-center text-ink-soft">
                    ยังไม่มีชั้นส่วนลด — เพิ่มได้ด้านล่าง
                  </td>
                </tr>
              ) : (
                tiers.map((t, i) => (
                  <tr key={i} className={i % 2 ? 'bg-white' : 'bg-peach-light/20'}>
                    <td className="px-3 py-1.5">
                      <Input
                        type="number"
                        value={t.minRemaining || ''}
                        disabled={!canEdit}
                        onChange={(e) => update(i, { minRemaining: Number(e.target.value) || 0 })}
                        className="w-28"
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <Input
                        type="number"
                        step="0.1"
                        value={t.percent || ''}
                        disabled={!canEdit}
                        onChange={(e) => update(i, { percent: Number(e.target.value) || 0 })}
                        className="w-28"
                      />
                    </td>
                    {canEdit && (
                      <td className="px-3 py-1.5">
                        <button
                          onClick={() => removeTier(i)}
                          className="rounded-lg p-1 text-red-500 hover:bg-red-50"
                          title="ลบชั้น"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {canEdit && (
          <button
            onClick={addTier}
            className="mt-2 inline-flex items-center gap-1 text-sm text-salmon-deep hover:underline"
          >
            <Plus size={14} /> เพิ่มชั้นส่วนลด
          </button>
        )}
      </Card>

      {canEdit && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {saved && <span className="text-sm text-green-600">บันทึกแล้ว ✓</span>}
          {err && <span className="text-sm text-red-600">{err}</span>}
          <Button onClick={save} disabled={busy}>
            {busy ? 'กำลังบันทึก...' : 'บันทึกส่วนลด'}
          </Button>
        </div>
      )}
    </div>
  )
}
