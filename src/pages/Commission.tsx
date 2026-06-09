import { useEffect, useState } from 'react'
import { Coins, Plus, Trash2 } from 'lucide-react'
import { Badge, Button, Card, Input, Loading, PageTitle } from '../components/ui'
import { useAuth } from '../lib/auth'
import { getCommissionTiers, saveCommissionTiers } from '../lib/db'
import { tierLabel, type CommissionTier } from '../lib/commission'

// หน้าตั้งค่าค่าคอมมิชชั่น (แยกจากเมนูตั้งค่า) — เห็นเฉพาะแอดมิน
export default function Commission() {
  const { role, configured } = useAuth()
  const canEdit = !configured || role === 'admin'

  const [tiers, setTiers] = useState<CommissionTier[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    getCommissionTiers()
      .then(setTiers)
      .finally(() => setLoading(false))
  }, [])

  const setRow = (i: number, patch: Partial<CommissionTier>) =>
    setTiers((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)))

  const addRow = () => {
    const last = tiers[tiers.length - 1]
    const start = last ? (last.maxCases ?? last.minCases) + 1 : 1
    setTiers((prev) => [...prev, { minCases: start, maxCases: null, bahtPerCase: 0 }])
  }
  const removeRow = (i: number) => setTiers((prev) => prev.filter((_, idx) => idx !== i))

  async function save() {
    setBusy(true)
    setMsg(null)
    try {
      await saveCommissionTiers(tiers)
      setMsg('บันทึกแล้ว ✅')
    } catch (e) {
      setMsg('บันทึกไม่สำเร็จ: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <PageTitle sub={canEdit ? 'ตั้งเรตค่าคอมแบบขั้นบันได — แก้ไขได้ตลอด' : 'ดูได้อย่างเดียว — แก้ไขเฉพาะแอดมิน'}>
        ค่าคอมมิชชั่น
      </PageTitle>

      {loading ? (
        <Loading />
      ) : (
        <Card>
          <div className="mb-1 flex items-center gap-2">
            <Coins size={18} className="text-salmon-deep" />
            <h3 className="font-semibold text-ink">ขั้นบันไดค่าคอม (ตามจำนวนเคสที่บันทึก)</h3>
          </div>
          <p className="mb-4 text-sm text-ink-soft">
            หน่วย <span className="font-semibold text-ink">บาท/เคส</span> · คิดตอนบันทึกสัญญา · แบบยกขั้นทั้งก้อน
            (เรตของขั้นที่ยอดรวมตกอยู่ คูณทุกเคส)
          </p>

          <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="bg-peach-light text-left text-ink">
                  <th className="px-3 py-2.5 font-semibold">ตั้งแต่ (เคส)</th>
                  <th className="px-3 py-2.5 font-semibold">ถึง (เคส)</th>
                  <th className="px-3 py-2.5 font-semibold">บาท/เคส</th>
                  <th className="px-3 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {tiers.map((t, i) => (
                  <tr key={i} className={i % 2 ? 'bg-white' : 'bg-peach-light/20'}>
                    <td className="px-3 py-2">
                      <Input
                        type="number"
                        value={String(t.minCases)}
                        disabled={!canEdit}
                        onChange={(e) => setRow(i, { minCases: Number(e.target.value) || 0 })}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        type="number"
                        value={t.maxCases == null ? '' : String(t.maxCases)}
                        placeholder="ขึ้นไป"
                        disabled={!canEdit}
                        onChange={(e) =>
                          setRow(i, {
                            maxCases: e.target.value === '' ? null : Number(e.target.value) || 0,
                          })
                        }
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        type="number"
                        value={String(t.bahtPerCase)}
                        disabled={!canEdit}
                        onChange={(e) => setRow(i, { bahtPerCase: Number(e.target.value) || 0 })}
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canEdit && (
                        <button
                          onClick={() => removeRow(i)}
                          className="rounded-lg p-1.5 text-ink-soft hover:bg-peach-light hover:text-red-600"
                          title="ลบขั้นนี้"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {tiers.map((t, i) => (
              <Badge key={i} tone="neutral">
                {tierLabel(t)} = {t.bahtPerCase.toLocaleString()} ฿/เคส
              </Badge>
            ))}
          </div>

          {canEdit && (
            <div className="mt-4 flex items-center gap-3">
              <Button variant="ghost" onClick={addRow}>
                <Plus size={15} /> เพิ่มขั้น
              </Button>
              <Button onClick={save} disabled={busy}>
                {busy ? 'กำลังบันทึก...' : 'บันทึกขั้นค่าคอม'}
              </Button>
              {msg && <span className="text-sm text-ink-soft">{msg}</span>}
            </div>
          )}

          <p className="mt-4 rounded-lg bg-peach-light/40 px-3 py-2 text-xs text-ink-soft">
            ขั้นถัดไป: ระบบจะนับจำนวนเคสที่แต่ละคน “บันทึก” แล้วคำนวณค่าคอมตามขั้นนี้ + หักคืนตามเรตเดิมที่เคสนั้นเคยได้
            (เมื่อไม่จ่ายงวดแรก ล่าช้า&gt;30วัน หรือคืนเครื่อง) + ค่าคอมหาร้านใหม่
          </p>
        </Card>
      )}
    </div>
  )
}
