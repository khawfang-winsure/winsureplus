import { useEffect, useMemo, useState } from 'react'
import { Coins, Lock, LockOpen, Plus, Smartphone, Store, Trash2, Trophy, Users } from 'lucide-react'
import { Badge, Button, Card, Input, Loading, PageTitle } from '../components/ui'
import { useAuth } from '../lib/auth'
import {
  getAllInstallments,
  getAllShops,
  getCommissionTiers,
  getContracts,
  getDeviceReturnTiers,
  getEmployees,
  getRecruitBonuses,
  getRecruitTiers,
  getReturns,
  lockCommissionMonth,
  saveCommissionTiers,
  saveDeviceReturnTiers,
  saveRecruitBonuses,
  saveRecruitTiers,
  unlockCommissionMonth,
  type InstallmentLite,
} from '../lib/db'
import {
  buildCommissionReport,
  CLAWBACK_LABEL,
  deviceReturnCommission,
  deviceReturnTierLabel,
  lockUpdatesFor,
  periodKeyOf,
  rateForDevicePrice,
  recruitTierLabel,
  tierLabel,
  type CommissionTier,
  type DeviceReturnTier,
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
      <DeviceReturnTierEditor canEdit={canEdit} />
    </div>
  )
}

const baht = (n: number) => n.toLocaleString('th-TH')
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
function today(): string {
  return new Date().toISOString().slice(0, 10)
}
function firstOfThisMonth(): string {
  return today().slice(0, 7) + '-01'
}
// ป้ายเดือนจาก yyyy-mm (ใช้ในรายละเอียดเคส)
function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return `${TH_MONTHS[(m || 1) - 1]} ${y + 543}`
}
// ป้ายวันจาก yyyy-mm-dd
function dayLabel(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return `${d} ${TH_MONTHS[(m || 1) - 1]} ${y + 543}`
}

// ---------- รายงานค่าคอมต่อพนักงาน ----------
function CommissionReport({ canEdit }: { canEdit: boolean }) {
  const [start, setStart] = useState<string>(firstOfThisMonth())
  const [end, setEnd] = useState<string>(today())
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

  const asOf = today()
  const report = useMemo<EmployeeCommission[]>(
    () =>
      buildCommissionReport({
        start,
        end,
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
    [start, end, contracts, installments, returns, shops, employeeNames, tiers, recruitTiers, recruitBonuses, asOf],
  )

  const periodKey = periodKeyOf(start, end)
  const periodText = `${dayLabel(start)} – ${dayLabel(end)}`
  const monthLocked = report.some((e) => e.locked)
  const totalCaseNet = report.reduce((s, e) => s + e.net, 0)
  const totalRecruit = report.reduce((s, e) => s + e.recruitTotal, 0)
  const totalGrand = report.reduce((s, e) => s + e.grandTotal, 0)

  async function toggleLock() {
    if (start > end) {
      window.alert('ช่วงวันที่ไม่ถูกต้อง — วันเริ่มต้องไม่เกินวันสิ้นสุด')
      return
    }
    if (monthLocked) {
      if (!window.confirm(`ปลดล็อกยอดช่วง ${periodText}? ระบบจะกลับไปคิดค่าคอมเคสแบบสดอีกครั้ง`)) return
      setBusy(true)
      try {
        await unlockCommissionMonth(periodKey)
        await load()
      } finally {
        setBusy(false)
      }
    } else {
      const updates = lockUpdatesFor(report)
      if (updates.length === 0) {
        window.alert('ช่วงนี้ยังไม่มีเคสที่บันทึก — ไม่มีอะไรให้ปิดยอด')
        return
      }
      if (
        !window.confirm(
          `ปิดยอด/ล็อกเรตค่าคอมเคส ช่วง ${periodText}? (${updates.length} เคส)\n` +
            'หลังล็อก ค่าคอมเคสช่วงนี้จะไม่เปลี่ยนแม้แก้ขั้นค่าคอมทีหลัง\n' +
            '(หมายเหตุ: ค่าคอมหาร้านคิดสดเสมอ ล็อกไม่ได้)',
        )
      )
        return
      setBusy(true)
      try {
        await lockCommissionMonth(periodKey, updates)
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
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={start}
            max={end}
            onChange={(e) => setStart(e.target.value || firstOfThisMonth())}
            className="rounded-xl border border-peach bg-white px-3 py-1.5 text-sm text-ink"
          />
          <span className="text-ink-soft">–</span>
          <input
            type="date"
            value={end}
            min={start}
            onChange={(e) => setEnd(e.target.value || today())}
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
          ช่วง {periodText} ยังไม่มีค่าคอม — ยังไม่มีเคส/ร้าน/โบนัสที่ตกในช่วงนี้
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
            <strong>ค่าคอมหาร้าน</strong> = ก้อนหาร้านในช่วงนี้ + โบนัสร้านที่ส่งเคสครบเป้า (นับเคสตาม “ร้าน”
            ทุกคนรวมกัน · ได้โบนัสเฉพาะร้านเกรด A/B ณ สิ้นกรอบเวลา) · ปิดยอดล็อกได้เฉพาะค่าคอมเคส —
            ค่าคอมหาร้านคิดสดเสมอ
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
                      ↳ โบนัสร้าน {b.shopName} (ส่งครบ {b.cases} เคสใน {b.withinMonths} เดือน · เกรด {b.grade}) +
                      {baht(b.bonus)}
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

// ---------- ตั้งเรตค่าคอมคืนเครื่อง (ขั้นบันไดตามราคาขาย) ----------
function validateDeviceTiers(tiers: DeviceReturnTier[]): string | null {
  if (tiers.length === 0) return 'ต้องมีอย่างน้อย 1 ขั้น'
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i]
    if (t.percent < 0 || t.percent > 100) return `ขั้น ${i + 1}: % ค่าคอมต้องอยู่ระหว่าง 0–100`
    if (t.min < 0) return `ขั้น ${i + 1}: ราคาตั้งต้นต้องไม่ติดลบ`
    if (t.max !== null && t.max < t.min) return `ขั้น ${i + 1}: ราคาสูงสุดต้องไม่น้อยกว่าราคาต่ำสุด`
    if (i < tiers.length - 1) {
      if (t.max === null) return `ขั้น ${i + 1}: ขั้นกลางต้องระบุราคาสูงสุด`
      if (tiers[i + 1].min !== t.max + 1)
        return `ขั้นต้องต่อกัน ไม่เว้นช่วง/ไม่ซ้อน (ขั้น ${i + 1} จบที่ ${t.max.toLocaleString()} → ขั้น ${i + 2} ต้องเริ่มที่ ${(t.max + 1).toLocaleString()})`
    } else {
      if (t.max !== null) return 'ขั้นสุดท้ายต้องตั้งเป็น "ไม่จำกัด" (เว้นช่อง ถึง ว่าง)'
    }
  }
  return null
}

function DeviceReturnTierEditor({ canEdit }: { canEdit: boolean }) {
  const [tiers, setTiers] = useState<DeviceReturnTier[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [preview, setPreview] = useState<number>(0)

  useEffect(() => {
    getDeviceReturnTiers()
      .then(setTiers)
      .finally(() => setLoading(false))
  }, [])

  const setRow = (i: number, patch: Partial<DeviceReturnTier>) =>
    setTiers((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)))

  const addTier = () => {
    const last = tiers[tiers.length - 1]
    if (!last) {
      setTiers([{ min: 0, max: null, percent: 5 }])
      return
    }
    // ขั้นก่อนหน้าต้องมี max — ตั้งให้อัตโนมัติถ้า null
    const prevMax = last.max ?? last.min + 5000
    const newLast: DeviceReturnTier = { ...last, max: prevMax }
    const newTier: DeviceReturnTier = { min: prevMax + 1, max: null, percent: last.percent }
    setTiers([...tiers.slice(0, -1), newLast, newTier])
  }

  const removeTier = (i: number) => setTiers((prev) => prev.filter((_, idx) => idx !== i))

  async function save() {
    const err = validateDeviceTiers(tiers)
    if (err) {
      setMsg(err)
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      await saveDeviceReturnTiers(tiers)
      setMsg('บันทึกแล้ว ✅')
    } catch (e) {
      setMsg('บันทึกไม่สำเร็จ: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const previewPercent = rateForDevicePrice(preview, tiers)
  const previewCommission = deviceReturnCommission(preview, tiers)
  const previewTierIdx = tiers.findIndex((t) => preview >= t.min && (t.max == null || preview <= t.max))

  if (loading) return <Loading />

  return (
    <Card>
      <div className="mb-1 flex items-center gap-2">
        <Smartphone size={18} className="text-salmon-deep" />
        <h3 className="font-semibold text-ink">ค่าคอมคืนเครื่องฟรีแลนซ์ (ขั้นบันได)</h3>
      </div>
      <p className="mb-4 text-sm text-ink-soft">
        ฟรีแลนซ์ที่ตามจนลูกค้าคืนเครื่องสำเร็จ ได้ค่าคอม{' '}
        <span className="font-semibold text-ink">% ของราคาขาย</span>{' '}
        ตามช่วงราคาที่ขายได้จริง
      </p>

      <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="bg-peach-light text-left text-ink">
              <th className="px-3 py-2.5 font-semibold">ขั้น</th>
              <th className="px-3 py-2.5 font-semibold">จาก (฿)</th>
              <th className="px-3 py-2.5 font-semibold">ถึง (฿)</th>
              <th className="px-3 py-2.5 font-semibold">% ค่าคอม</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((t, i) => (
              <tr key={i} className={i % 2 ? 'bg-white' : 'bg-peach-light/20'}>
                <td className="px-3 py-2 text-center text-ink-soft">{i + 1}</td>
                <td className="px-3 py-2">
                  <Input
                    type="number"
                    value={String(t.min)}
                    disabled={!canEdit}
                    onChange={(e) => setRow(i, { min: Number(e.target.value) || 0 })}
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    type="number"
                    value={t.max == null ? '' : String(t.max)}
                    placeholder="ไม่จำกัด"
                    disabled={!canEdit}
                    onChange={(e) =>
                      setRow(i, { max: e.target.value === '' ? null : Number(e.target.value) || 0 })
                    }
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    type="number"
                    value={String(t.percent)}
                    disabled={!canEdit}
                    onChange={(e) => setRow(i, { percent: Number(e.target.value) || 0 })}
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  {canEdit && (
                    <button
                      onClick={() => removeTier(i)}
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
            {deviceReturnTierLabel(t)} = {t.percent}%
          </Badge>
        ))}
      </div>

      {/* ทดลองคำนวณ */}
      <div className="mt-4 rounded-xl border border-peach bg-peach-light/30 px-4 py-3">
        <p className="mb-2 text-sm font-semibold text-ink">ทดลองคำนวณ</p>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-sm text-ink-soft">ราคาขาย</label>
            <Input
              type="number"
              value={String(preview)}
              onChange={(e) => setPreview(Number(e.target.value) || 0)}
              placeholder="0"
            />
            <span className="text-sm text-ink-soft">฿</span>
          </div>
          {preview > 0 && tiers.length > 0 && (
            <p className="text-sm text-ink">
              {previewTierIdx >= 0 ? (
                <>
                  เข้าขั้น {previewTierIdx + 1} →{' '}
                  <span className="font-semibold">
                    {preview.toLocaleString('th-TH')} × {previewPercent}% ={' '}
                    {previewCommission.toLocaleString('th-TH')} ฿
                  </span>
                </>
              ) : (
                <span className="text-ink-soft">ราคานี้ไม่ตรงขั้นใด</span>
              )}
            </p>
          )}
        </div>
      </div>

      {canEdit && (
        <div className="mt-4 flex items-center gap-3">
          <Button variant="ghost" onClick={addTier}>
            <Plus size={15} /> เพิ่มขั้น
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? 'กำลังบันทึก...' : 'บันทึกค่าคอมคืนเครื่อง'}
          </Button>
          {msg && <span className="text-sm text-ink-soft">{msg}</span>}
        </div>
      )}
    </Card>
  )
}
