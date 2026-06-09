import { useEffect, useMemo, useState } from 'react'
import { Coins, Lock, LockOpen, Plus, Store, Trash2, Trophy, Users } from 'lucide-react'
import { Badge, Button, Card, Input, Loading, PageTitle } from '../components/ui'
import { useAuth } from '../lib/auth'
import {
  getAllInstallments,
  getAllShops,
  getCommissionTiers,
  getContracts,
  getEmployees,
  getRecruitBonuses,
  getRecruitTiers,
  getReturns,
  lockCommissionMonth,
  saveCommissionTiers,
  saveRecruitBonuses,
  saveRecruitTiers,
  unlockCommissionMonth,
  type InstallmentLite,
} from '../lib/db'
import {
  buildCommissionReport,
  CLAWBACK_LABEL,
  lockUpdatesFor,
  recruitTierLabel,
  tierLabel,
  type CommissionTier,
  type EmployeeCommission,
  type RecruitBonusRule,
  type RecruitTier,
} from '../lib/commission'
import type { Contract, DeviceReturnRow, Shop } from '../lib/types'

// หน้าค่าคอมมิชชั่น (แยกจากเมนูตั้งค่า) — เห็นเฉพาะแอดมิน
export default function Commission() {
  const { role, configured } = useAuth()
  const canEdit = !configured || role === 'admin'

  return (
    <div className="space-y-6">
      <div>
        <PageTitle sub={canEdit ? 'รายงานค่าคอมรายเดือน + ตั้งเรต' : 'ดูได้อย่างเดียว — แก้ไขเฉพาะแอดมิน'}>
          ค่าคอมมิชชั่น
        </PageTitle>
        <CommissionReport canEdit={canEdit} />
      </div>
      <TierEditor canEdit={canEdit} />
      <RecruitTierEditor canEdit={canEdit} />
      <RecruitBonusEditor canEdit={canEdit} />
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
  const [shops, setShops] = useState<Shop[]>([])
  const [employeeNames, setEmployeeNames] = useState<Record<string, string>>({})
  const [tiers, setTiers] = useState<CommissionTier[]>([])
  const [recruitTiers, setRecruitTiers] = useState<RecruitTier[]>([])
  const [recruitBonuses, setRecruitBonuses] = useState<RecruitBonusRule[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const [c, ins, r, sh, emp, t, rt, rb] = await Promise.all([
        getContracts(),
        getAllInstallments(),
        getReturns(),
        getAllShops(),
        getEmployees(),
        getCommissionTiers(),
        getRecruitTiers(),
        getRecruitBonuses(),
      ])
      setContracts(c)
      setInstallments(ins)
      setReturns(r)
      setShops(sh)
      setEmployeeNames(Object.fromEntries(emp.map((e) => [e.id, e.fullName])))
      setTiers(t)
      setRecruitTiers(rt)
      setRecruitBonuses(rb)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
  }, [])

  const asOf = new Date().toISOString().slice(0, 10)
  const report = useMemo<EmployeeCommission[]>(
    () =>
      buildCommissionReport({
        month,
        contracts,
        installments,
        returns,
        shops,
        employeeNames,
        tiers,
        recruitTiers,
        recruitBonuses,
        asOf,
      }),
    [month, contracts, installments, returns, shops, employeeNames, tiers, recruitTiers, recruitBonuses, asOf],
  )

  const monthLocked = report.some((e) => e.locked)
  const totalCaseNet = report.reduce((s, e) => s + e.net, 0)
  const totalRecruit = report.reduce((s, e) => s + e.recruitTotal, 0)
  const totalGrand = report.reduce((s, e) => s + e.grandTotal, 0)

  async function toggleLock() {
    if (monthLocked) {
      if (!window.confirm(`ปลดล็อกยอดเดือน ${monthLabel(month)}? ระบบจะกลับไปคิดค่าคอมเคสแบบสดอีกครั้ง`)) return
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
          `ปิดยอด/ล็อกเรตค่าคอมเคส เดือน ${monthLabel(month)}? (${updates.length} เคส)\n` +
            'หลังล็อก ค่าคอมเคสเดือนนี้จะไม่เปลี่ยนแม้แก้ขั้นค่าคอมทีหลัง\n' +
            '(หมายเหตุ: ค่าคอมหาร้านคิดสดเสมอ ล็อกไม่ได้)',
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
          เดือน {monthLabel(month)} ยังไม่มีค่าคอม — ยังไม่มีเคส/ร้าน/โบนัสที่ตกในเดือนนี้
        </p>
      ) : (
        <>
          <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="bg-peach-light text-left text-ink">
                  <th className="px-3 py-2.5 font-semibold">พนักงาน</th>
                  <th className="px-3 py-2.5 text-right font-semibold">ค่าคอมเคส (สุทธิ)</th>
                  <th className="px-3 py-2.5 text-right font-semibold">ค่าคอมหาร้าน</th>
                  <th className="px-3 py-2.5 text-right font-semibold">รวมทั้งหมด</th>
                  <th className="px-3 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {report.map((e) => (
                  <EmployeeRow
                    key={e.employeeId}
                    e={e}
                    isOpen={open === e.employeeId}
                    onToggle={() => setOpen(open === e.employeeId ? null : e.employeeId)}
                  />
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-peach bg-peach-light/30 font-semibold text-ink">
                  <td className="px-3 py-2.5">รวมทั้งหมด</td>
                  <td className="px-3 py-2.5 text-right">{baht(totalCaseNet)}</td>
                  <td className="px-3 py-2.5 text-right text-amber-700">{baht(totalRecruit)}</td>
                  <td className="px-3 py-2.5 text-right">{baht(totalGrand)} ฿</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>

          <p className="mt-3 rounded-lg bg-peach-light/40 px-3 py-2 text-xs text-ink-soft">
            <strong>ค่าคอมเคส</strong> = เคสที่บันทึกในเดือนนี้ × เรตขั้นบันได − หักคืน (งวดล่าช้าครบ 30 วัน) ·{' '}
            <strong>ค่าคอมหาร้าน</strong> = ก้อนหาร้านในเดือนนี้ + โบนัสร้านที่ส่งเคสครบเป้า (โบนัสนับเคสตาม “ร้าน”
            ทุกคนรวมกัน) · ปิดยอดล็อกได้เฉพาะค่าคอมเคส — ค่าคอมหาร้านคิดสดเสมอ
          </p>
        </>
      )}
    </Card>
  )
}

// แถวพนักงาน + รายละเอียด (กางได้)
function EmployeeRow({
  e,
  isOpen,
  onToggle,
}: {
  e: EmployeeCommission
  isOpen: boolean
  onToggle: () => void
}) {
  const hasDetail = e.clawbacks.length > 0 || e.recruitShopCount > 0 || e.recruitBonuses.length > 0
  return (
    <>
      <tr className="border-t border-peach/60">
        <td className="px-3 py-2.5">
          <span className="font-medium text-ink">{e.employeeName}</span>
          {e.locked && <Lock size={12} className="ml-1.5 inline text-ink-soft" />}
        </td>
        <td className="px-3 py-2.5 text-right">
          {baht(e.net)}
          {e.grossCount > 0 && <span className="ml-1 text-xs text-ink-soft">({e.grossCount} เคส)</span>}
        </td>
        <td className="px-3 py-2.5 text-right text-amber-700">
          {e.recruitTotal > 0 ? baht(e.recruitTotal) : '—'}
        </td>
        <td className="px-3 py-2.5 text-right font-semibold text-ink">{baht(e.grandTotal)}</td>
        <td className="px-3 py-2.5 text-right">
          {hasDetail && (
            <button onClick={onToggle} className="text-xs text-salmon-deep hover:underline">
              {isOpen ? 'ซ่อน' : 'รายละเอียด'}
            </button>
          )}
        </td>
      </tr>
      {isOpen && (
        <tr className="bg-peach-light/20 text-xs text-ink-soft">
          <td className="px-3 py-2.5" colSpan={5}>
            <div className="space-y-2">
              {/* ค่าคอมเคส */}
              <div>
                <span className="font-semibold text-ink">ค่าคอมเคส:</span> ได้ {baht(e.grossAmount)} (
                {e.grossCount} เคส × {baht(e.grossRate)})
                {e.clawbackAmount > 0 && <span className="text-red-600"> − หัก {baht(e.clawbackAmount)}</span>} ={' '}
                {baht(e.net)}
              </div>
              {e.clawbacks.map((cb) => (
                <div key={cb.contractId} className="pl-4 text-red-600">
                  ↳ {cb.contractNo} · {cb.customerName} — {CLAWBACK_LABEL[cb.reason]} (บันทึก{' '}
                  {monthLabel(cb.bookingMonth)}) −{baht(cb.rate)}
                </div>
              ))}
              {/* ค่าคอมหาร้าน */}
              {(e.recruitShopCount > 0 || e.recruitBonuses.length > 0) && (
                <div className="text-amber-700">
                  <span className="font-semibold">ค่าคอมหาร้าน:</span>
                  {e.recruitShopCount > 0 && (
                    <span className="ml-1">
                      หาร้าน {e.recruitShopCount} ร้าน × {baht(e.recruitShopRate)} = {baht(e.recruitShopAmount)}
                    </span>
                  )}
                  {e.recruitBonuses.map((b) => (
                    <div key={b.shopId} className="pl-4">
                      ↳ โบนัสร้าน {b.shopName} (ส่งครบ {b.cases} เคสใน {b.withinMonths} เดือน) +{baht(b.bonus)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ---------- ตั้งเรตค่าคอมเคส (ขั้นบันได) ----------
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
        <h3 className="font-semibold text-ink">ขั้นบันไดค่าคอมเคส (ตามจำนวนเคสที่บันทึก)</h3>
      </div>
      <p className="mb-4 text-sm text-ink-soft">
        หน่วย <span className="font-semibold text-ink">บาท/เคส</span> · แบบยกขั้นทั้งก้อน (เรตของขั้นที่ยอดรวมตกอยู่
        คูณทุกเคส)
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
                      setRow(i, { maxCases: e.target.value === '' ? null : Number(e.target.value) || 0 })
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
            {busy ? 'กำลังบันทึก...' : 'บันทึกขั้นค่าคอมเคส'}
          </Button>
          {msg && <span className="text-sm text-ink-soft">{msg}</span>}
        </div>
      )}
    </Card>
  )
}

// ---------- ตั้งเรตค่าคอมหาร้าน ก้อน 1 (ขั้นบันไดตามจำนวนร้าน) ----------
function RecruitTierEditor({ canEdit }: { canEdit: boolean }) {
  const [tiers, setTiers] = useState<RecruitTier[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    getRecruitTiers()
      .then(setTiers)
      .finally(() => setLoading(false))
  }, [])

  const setRow = (i: number, patch: Partial<RecruitTier>) =>
    setTiers((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)))
  const addRow = () => {
    const last = tiers[tiers.length - 1]
    const start = last ? (last.maxShops ?? last.minShops) + 1 : 1
    setTiers((prev) => [...prev, { minShops: start, maxShops: null, bahtPerShop: 0 }])
  }
  const removeRow = (i: number) => setTiers((prev) => prev.filter((_, idx) => idx !== i))

  async function save() {
    setBusy(true)
    setMsg(null)
    try {
      await saveRecruitTiers(tiers)
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
        <Store size={18} className="text-salmon-deep" />
        <h3 className="font-semibold text-ink">ค่าคอมหาร้าน — ก้อน 1 (ตามจำนวนร้านที่หาได้ต่อเดือน)</h3>
      </div>
      <p className="mb-4 text-sm text-ink-soft">
        หน่วย <span className="font-semibold text-ink">บาท/ร้าน</span> · แบบยกขั้นทั้งก้อน · นับร้านที่หาได้ในแต่ละเดือน
      </p>
      <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="bg-peach-light text-left text-ink">
              <th className="px-3 py-2.5 font-semibold">ตั้งแต่ (ร้าน)</th>
              <th className="px-3 py-2.5 font-semibold">ถึง (ร้าน)</th>
              <th className="px-3 py-2.5 font-semibold">บาท/ร้าน</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((t, i) => (
              <tr key={i} className={i % 2 ? 'bg-white' : 'bg-peach-light/20'}>
                <td className="px-3 py-2">
                  <Input
                    type="number"
                    value={String(t.minShops)}
                    disabled={!canEdit}
                    onChange={(e) => setRow(i, { minShops: Number(e.target.value) || 0 })}
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    type="number"
                    value={t.maxShops == null ? '' : String(t.maxShops)}
                    placeholder="ขึ้นไป"
                    disabled={!canEdit}
                    onChange={(e) =>
                      setRow(i, { maxShops: e.target.value === '' ? null : Number(e.target.value) || 0 })
                    }
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    type="number"
                    value={String(t.bahtPerShop)}
                    disabled={!canEdit}
                    onChange={(e) => setRow(i, { bahtPerShop: Number(e.target.value) || 0 })}
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
            {recruitTierLabel(t)} = {t.bahtPerShop.toLocaleString()} ฿/ร้าน
          </Badge>
        ))}
      </div>
      {canEdit && (
        <div className="mt-4 flex items-center gap-3">
          <Button variant="ghost" onClick={addRow}>
            <Plus size={15} /> เพิ่มขั้น
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? 'กำลังบันทึก...' : 'บันทึกขั้นค่าคอมหาร้าน'}
          </Button>
          {msg && <span className="text-sm text-ink-soft">{msg}</span>}
        </div>
      )}
    </Card>
  )
}

// ---------- ตั้งเงื่อนไขโบนัสร้าน ก้อน 2 ----------
function RecruitBonusEditor({ canEdit }: { canEdit: boolean }) {
  const [rules, setRules] = useState<RecruitBonusRule[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    getRecruitBonuses()
      .then(setRules)
      .finally(() => setLoading(false))
  }, [])

  const setRow = (i: number, patch: Partial<RecruitBonusRule>) =>
    setRules((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)))
  const addRow = () => setRules((prev) => [...prev, { cases: 0, months: 3, bonus: 0 }])
  const removeRow = (i: number) => setRules((prev) => prev.filter((_, idx) => idx !== i))

  async function save() {
    setBusy(true)
    setMsg(null)
    try {
      await saveRecruitBonuses(rules)
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
        <Trophy size={18} className="text-salmon-deep" />
        <h3 className="font-semibold text-ink">ค่าคอมหาร้าน — ก้อน 2 (โบนัสร้านส่งเคสครบเป้า)</h3>
      </div>
      <p className="mb-4 text-sm text-ink-soft">
        ถ้าร้านที่พนักงานหามา ส่งเคส <span className="font-semibold text-ink">ครบเป้า</span> ภายในกรอบเวลา (นับจากวันหาร้าน)
        → พนักงานได้โบนัสต่อร้าน (ครั้งเดียว/ร้าน)
      </p>
      <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="bg-peach-light text-left text-ink">
              <th className="px-3 py-2.5 font-semibold">ส่งเคสครบ (เคส)</th>
              <th className="px-3 py-2.5 font-semibold">ภายใน (เดือน)</th>
              <th className="px-3 py-2.5 font-semibold">โบนัส (บาท)</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {rules.map((t, i) => (
              <tr key={i} className={i % 2 ? 'bg-white' : 'bg-peach-light/20'}>
                <td className="px-3 py-2">
                  <Input
                    type="number"
                    value={String(t.cases)}
                    disabled={!canEdit}
                    onChange={(e) => setRow(i, { cases: Number(e.target.value) || 0 })}
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    type="number"
                    value={String(t.months)}
                    disabled={!canEdit}
                    onChange={(e) => setRow(i, { months: Number(e.target.value) || 0 })}
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    type="number"
                    value={String(t.bonus)}
                    disabled={!canEdit}
                    onChange={(e) => setRow(i, { bonus: Number(e.target.value) || 0 })}
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  {canEdit && (
                    <button
                      onClick={() => removeRow(i)}
                      className="rounded-lg p-1.5 text-ink-soft hover:bg-peach-light hover:text-red-600"
                      title="ลบเงื่อนไขนี้"
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
      {canEdit && (
        <div className="mt-4 flex items-center gap-3">
          <Button variant="ghost" onClick={addRow}>
            <Plus size={15} /> เพิ่มเงื่อนไข
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? 'กำลังบันทึก...' : 'บันทึกโบนัสร้าน'}
          </Button>
          {msg && <span className="text-sm text-ink-soft">{msg}</span>}
        </div>
      )}
    </Card>
  )
}
