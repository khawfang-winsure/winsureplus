import { useEffect, useMemo, useState } from 'react'
import { Coins, Lock, LockOpen, Plus, Trash2, Users } from 'lucide-react'
import { Badge, Button, Card, Input, Loading, PageTitle } from '../components/ui'
import { useAuth } from '../lib/auth'
import {
  getAllInstallments,
  getCommissionTiers,
  getContracts,
  getReturns,
  lockCommissionMonth,
  saveCommissionTiers,
  unlockCommissionMonth,
  type InstallmentLite,
} from '../lib/db'
import {
  buildCommissionReport,
  CLAWBACK_LABEL,
  lockUpdatesFor,
  tierLabel,
  type CommissionTier,
  type EmployeeCommission,
} from '../lib/commission'
import type { Contract, DeviceReturnRow } from '../lib/types'

// หน้าค่าคอมมิชชั่น (แยกจากเมนูตั้งค่า) — เห็นเฉพาะแอดมิน
// บน = รายงานค่าคอมต่อพนักงานต่อเดือน · ล่าง = ตั้งเรตขั้นบันได
export default function Commission() {
  const { role, configured } = useAuth()
  const canEdit = !configured || role === 'admin'

  return (
    <div>
      <PageTitle sub={canEdit ? 'รายงานค่าคอมรายเดือน + ตั้งเรตขั้นบันได' : 'ดูได้อย่างเดียว — แก้ไขเฉพาะแอดมิน'}>
        ค่าคอมมิชชั่น
      </PageTitle>
      <CommissionReport canEdit={canEdit} />
      <div className="mt-6">
        <TierEditor canEdit={canEdit} />
      </div>
    </div>
  )
}

const baht = (n: number) => n.toLocaleString('th-TH')
function thisMonth(): string {
  return new Date().toISOString().slice(0, 7)
}
function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  const names = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
  return `${names[(m || 1) - 1]} ${y + 543}`
}

// ---------- รายงานค่าคอมต่อพนักงาน ----------
function CommissionReport({ canEdit }: { canEdit: boolean }) {
  const [month, setMonth] = useState<string>(thisMonth())
  const [contracts, setContracts] = useState<Contract[]>([])
  const [installments, setInstallments] = useState<InstallmentLite[]>([])
  const [returns, setReturns] = useState<DeviceReturnRow[]>([])
  const [tiers, setTiers] = useState<CommissionTier[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<string | null>(null) // แถวพนักงานที่กางรายละเอียด

  async function load() {
    setLoading(true)
    try {
      const [c, ins, r, t] = await Promise.all([
        getContracts(),
        getAllInstallments(),
        getReturns(),
        getCommissionTiers(),
      ])
      setContracts(c)
      setInstallments(ins)
      setReturns(r)
      setTiers(t)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
  }, [])

  const asOf = new Date().toISOString().slice(0, 10)
  const report = useMemo<EmployeeCommission[]>(
    () => buildCommissionReport(month, contracts, installments, returns, tiers, asOf),
    [month, contracts, installments, returns, tiers, asOf],
  )

  const monthLocked = report.some((e) => e.locked)
  const totalNet = report.reduce((s, e) => s + e.net, 0)
  const totalGross = report.reduce((s, e) => s + e.grossAmount, 0)
  const totalClaw = report.reduce((s, e) => s + e.clawbackAmount, 0)

  async function toggleLock() {
    if (monthLocked) {
      if (!window.confirm(`ปลดล็อกยอดเดือน ${monthLabel(month)}? ระบบจะกลับไปคิดค่าคอมแบบสดอีกครั้ง`)) return
      setBusy(true)
      try {
        await unlockCommissionMonth(month)
        await load()
      } finally {
        setBusy(false)
      }
    } else {
      const updates = lockUpdatesFor(report)
      if (updates.length === 0) {
        window.alert('เดือนนี้ยังไม่มีเคสที่บันทึก — ไม่มีอะไรให้ปิดยอด')
        return
      }
      if (
        !window.confirm(
          `ปิดยอด/ล็อกเรตเดือน ${monthLabel(month)}? (${updates.length} เคส)\n` +
            'หลังล็อก ยอดเดือนนี้จะไม่เปลี่ยนแม้แก้ขั้นค่าคอมทีหลัง',
        )
      )
        return
      setBusy(true)
      try {
        await lockCommissionMonth(month, updates)
        await load()
      } finally {
        setBusy(false)
      }
    }
  }

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Users size={18} className="text-salmon-deep" />
          <h3 className="font-semibold text-ink">รายงานค่าคอมต่อพนักงาน</h3>
          {monthLocked && (
            <Badge tone="neutral">
              <Lock size={12} /> ปิดยอดแล้ว
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value || thisMonth())}
            className="rounded-xl border border-peach bg-white px-3 py-1.5 text-sm text-ink"
          />
          {canEdit && (
            <Button variant="ghost" onClick={toggleLock} disabled={busy || loading}>
              {monthLocked ? (
                <>
                  <LockOpen size={15} /> ปลดล็อก
                </>
              ) : (
                <>
                  <Lock size={15} /> ปิดยอดเดือนนี้
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <Loading />
      ) : report.length === 0 ? (
        <p className="rounded-xl bg-peach-light/40 px-4 py-6 text-center text-sm text-ink-soft">
          เดือน {monthLabel(month)} ยังไม่มีค่าคอม — ยังไม่มีเคสที่บันทึกหรือเคสที่ต้องหักคืนในเดือนนี้
        </p>
      ) : (
        <>
          <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="bg-peach-light text-left text-ink">
                  <th className="px-3 py-2.5 font-semibold">พนักงาน</th>
                  <th className="px-3 py-2.5 text-right font-semibold">เคสที่บันทึก</th>
                  <th className="px-3 py-2.5 text-right font-semibold">ค่าคอมได้</th>
                  <th className="px-3 py-2.5 text-right font-semibold">หักคืน</th>
                  <th className="px-3 py-2.5 text-right font-semibold">สุทธิ</th>
                  <th className="px-3 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {report.map((e) => {
                  const isOpen = open === e.employeeId
                  return (
                    <FragmentRow
                      key={e.employeeId}
                      e={e}
                      isOpen={isOpen}
                      onToggle={() => setOpen(isOpen ? null : e.employeeId)}
                    />
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-peach bg-peach-light/30 font-semibold text-ink">
                  <td className="px-3 py-2.5">รวมทั้งหมด</td>
                  <td className="px-3 py-2.5 text-right">{report.reduce((s, e) => s + e.grossCount, 0)}</td>
                  <td className="px-3 py-2.5 text-right text-emerald-700">{baht(totalGross)}</td>
                  <td className="px-3 py-2.5 text-right text-red-600">
                    {totalClaw > 0 ? `−${baht(totalClaw)}` : '0'}
                  </td>
                  <td className="px-3 py-2.5 text-right">{baht(totalNet)} ฿</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>

          <p className="mt-3 rounded-lg bg-peach-light/40 px-3 py-2 text-xs text-ink-soft">
            <strong>วิธีคิด:</strong> “ค่าคอมได้” = จำนวนเคสที่บันทึกในเดือนนี้ × เรตขั้นบันได (ยกขั้นทั้งก้อน) ·
            “หักคืน” = เคสที่มีงวดล่าช้าครบ 30 วัน (งวดแรกไม่จ่าย / ล่าช้าทั่วไป / คืนเครื่องหลังเลย 30 วัน) หักตามเรตเดิม
            นับเข้าเดือนที่งวดนั้นครบ 30 วัน · ลูกค้ากลับมาจ่ายทีหลังก็ไม่คืนค่าคอม ·
            <span className="text-ink"> ค่าคอมหาร้านใหม่ — ยังไม่เปิดใช้ (รอเพิ่มภายหลัง)</span>
          </p>
        </>
      )}
    </Card>
  )
}

// แถวพนักงาน + แถวรายละเอียด (กางได้)
function FragmentRow({
  e,
  isOpen,
  onToggle,
}: {
  e: EmployeeCommission
  isOpen: boolean
  onToggle: () => void
}) {
  return (
    <>
      <tr className="border-t border-peach/60">
        <td className="px-3 py-2.5">
          <span className="font-medium text-ink">{e.employeeName}</span>
          {e.locked && <Lock size={12} className="ml-1.5 inline text-ink-soft" />}
        </td>
        <td className="px-3 py-2.5 text-right">{e.grossCount}</td>
        <td className="px-3 py-2.5 text-right text-emerald-700">
          {baht(e.grossAmount)}
          <span className="ml-1 text-xs text-ink-soft">({baht(e.grossRate)}/เคส)</span>
        </td>
        <td className="px-3 py-2.5 text-right text-red-600">
          {e.clawbackAmount > 0 ? `−${baht(e.clawbackAmount)}` : '—'}
        </td>
        <td className="px-3 py-2.5 text-right font-semibold text-ink">{baht(e.net)}</td>
        <td className="px-3 py-2.5 text-right">
          {e.clawbacks.length > 0 && (
            <button onClick={onToggle} className="text-xs text-salmon-deep hover:underline">
              {isOpen ? 'ซ่อน' : `ดูที่หัก (${e.clawbacks.length})`}
            </button>
          )}
        </td>
      </tr>
      {isOpen &&
        e.clawbacks.map((cb) => (
          <tr key={cb.contractId} className="bg-red-50/40 text-xs text-ink-soft">
            <td className="py-1.5 pl-8 pr-3" colSpan={2}>
              {cb.contractNo} · {cb.customerName}
            </td>
            <td className="px-3 py-1.5" colSpan={2}>
              <Badge tone="neutral">{CLAWBACK_LABEL[cb.reason]}</Badge>
              <span className="ml-2">บันทึกเดือน {monthLabel(cb.bookingMonth)}</span>
            </td>
            <td className="px-3 py-1.5 text-right text-red-600">−{baht(cb.rate)}</td>
            <td></td>
          </tr>
        ))}
    </>
  )
}

// ---------- ตั้งเรตขั้นบันได ----------
function TierEditor({ canEdit }: { canEdit: boolean }) {
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

  if (loading) return <Loading />

  return (
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
    </Card>
  )
}
