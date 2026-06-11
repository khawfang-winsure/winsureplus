import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Briefcase, Pencil, Percent, Plus, ShieldCheck, Smartphone, Store, Tag, type LucideIcon } from 'lucide-react'
import { Badge, Button, Card, Field, Input, Loading, Modal, PageTitle } from '../components/ui'
import { ManagedList } from '../components/ManagedList'
import { RateSetsEditor } from '../components/RateSetsEditor'
import { useAuth } from '../lib/auth'
import {
  getAllOptions,
  getAllShops,
  getEmployees,
  saveOption,
  saveShop,
  setOptionActive,
  setShopActive,
  type Employee,
  type OptionInput,
  type OptionKind,
  type ShopInput,
} from '../lib/db'
import type { Option, Shop } from '../lib/types'

const OPTION_KINDS: { kind: OptionKind; title: string; hasDetail?: boolean }[] = [
  { kind: 'phone_model', title: 'รุ่นโทรศัพท์' },
  { kind: 'storage', title: 'ความจำ' },
  { kind: 'occupation', title: 'อาชีพ' },
  { kind: 'occupation_proof', title: 'หลักฐานอาชีพ' },
  { kind: 'promotion', title: 'โปรโมชั่น', hasDetail: true },
]

// หมวดตั้งค่า — แยกเป็นหัวข้อย่อย เลือกผ่าน URL /settings/:cat (สลับจาก sidebar submenu หรือปุ่มหน้านี้)
type CategoryKey = 'shops' | 'device' | 'job' | 'promo' | 'rates' | 'users'
const CATEGORIES: { key: CategoryKey; label: string; icon: LucideIcon; kinds: OptionKind[]; adminOnly?: boolean }[] = [
  { key: 'shops', label: 'ร้านค้า', icon: Store, kinds: [] },
  { key: 'device', label: 'ตัวเครื่อง', icon: Smartphone, kinds: ['phone_model', 'storage'] },
  { key: 'job', label: 'อาชีพ & หลักฐาน', icon: Briefcase, kinds: ['occupation', 'occupation_proof'] },
  { key: 'promo', label: 'โปรโมชั่น', icon: Tag, kinds: ['promotion'] },
  { key: 'rates', label: 'เรตผ่อน', icon: Percent, kinds: [] },
  { key: 'users', label: 'สิทธิ์ผู้ใช้', icon: ShieldCheck, kinds: [], adminOnly: true },
]

// ===== โครงสิทธิ์ผู้ใช้ (ตัวอย่างที่เสนอ — ยังไม่บันทึกจริง รอกำหนดอีกครั้ง) =====
const PERMISSIONS: { key: string; label: string; staffDefault: boolean }[] = [
  { key: 'view_contracts', label: 'ดูรายชื่อลูกค้า / สัญญา', staffDefault: true },
  { key: 'add_contract', label: 'เพิ่มสัญญาใหม่', staffDefault: true },
  { key: 'edit_contract', label: 'แก้ไขสัญญา (รวมย้อนหลัง)', staffDefault: false },
  { key: 'confirm_payment', label: 'ยืนยันการชำระเงิน', staffDefault: true },
  { key: 'manage_return', label: 'จัดการคืนเครื่อง', staffDefault: true },
  { key: 'gen_summary', label: 'สร้างข้อความสรุปยอด / อีเมล', staffDefault: true },
  { key: 'view_report', label: 'ดูรายงานวัดผลร้านค้า', staffDefault: false },
  { key: 'manage_settings', label: 'จัดการตั้งค่า (ร้าน / ตัวเลือก)', staffDefault: false },
  { key: 'manage_users', label: 'จัดการสิทธิ์ผู้ใช้', staffDefault: false },
]

const emptyData = {
  shops: [] as Shop[],
  options: {} as Record<OptionKind, Option[]>,
}

export default function Settings() {
  const { role, configured } = useAuth()
  const canEdit = !configured || role === 'admin'
  const isAdmin = canEdit
  const navigate = useNavigate()
  const { cat: catParam } = useParams<{ cat: CategoryKey }>()

  // กรองเฉพาะหมวดที่ user ดูได้ (staff ไม่เห็น 'users')
  const visibleCats = CATEGORIES.filter((c) => !c.adminOnly || isAdmin)
  const cat: CategoryKey = visibleCats.some((c) => c.key === catParam) ? (catParam as CategoryKey) : 'shops'
  const setCat = (next: CategoryKey) => navigate(`/settings/${next}`)

  const [data, setData] = useState(emptyData)
  const [loading, setLoading] = useState(true)
  const [shopModal, setShopModal] = useState<ShopInput | null>(null)
  const [optModal, setOptModal] = useState<OptionInput | null>(null)
  // สิทธิ์พนักงาน (ตัวอย่าง — ยังไม่บันทึกจริง)
  const [staffPerms, setStaffPerms] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(PERMISSIONS.map((p) => [p.key, p.staffDefault])),
  )

  const load = useCallback(async () => {
    setLoading(true)
    const [shops, ...lists] = await Promise.all([
      getAllShops(),
      ...OPTION_KINDS.map((k) => getAllOptions(k.kind)),
    ])
    const options = {} as Record<OptionKind, Option[]>
    OPTION_KINDS.forEach((k, i) => (options[k.kind] = lists[i]))
    setData({ shops, options })
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function toggleShop(s: Shop) {
    await setShopActive(s.id, !s.active)
    await load()
  }
  async function toggleOption(o: Option) {
    await setOptionActive(o.id, !o.active)
    await load()
  }

  // ----- ส่วนร้านค้า -----
  function renderShops() {
    return (
      <Card>
        <h3 className="mb-3 font-semibold text-ink">ร้านค้า</h3>
        <ManagedList
          items={data.shops}
          getText={(s) => `${s.code} ${s.name}`}
          emptyText="ยังไม่มีร้านค้า"
          searchPlaceholder="ค้นหาร้านค้า (รหัส / ชื่อ)..."
          toolbarRight={
            canEdit ? (
              <Button
                variant="ghost"
                onClick={() =>
                  setShopModal({ code: '', name: '', bank: '', accountNo: '', accountName: '', active: true })
                }
              >
                <Plus size={16} /> เพิ่มร้านค้า
              </Button>
            ) : undefined
          }
          renderItem={(s) => (
            <div
              className={`flex items-center justify-between rounded-xl bg-white px-4 py-3 ${s.active ? '' : 'opacity-50'}`}
            >
              <div>
                <p className="font-medium text-ink">{s.code} · {s.name}</p>
                <p className="text-sm text-ink-soft">{s.bank} · {s.accountNo}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={s.active ? 'green' : 'neutral'}>{s.active ? 'ใช้งาน' : 'ปิด'}</Badge>
                {canEdit && (
                  <>
                    <button
                      onClick={() => setShopModal({ ...s })}
                      className="rounded-lg p-1.5 text-ink-soft hover:bg-peach-light"
                      title="แก้ไข"
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      onClick={() => toggleShop(s)}
                      className="rounded-lg px-2 py-1 text-xs text-ink-soft hover:bg-peach-light"
                    >
                      {s.active ? 'ปิด' : 'เปิด'}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        />
      </Card>
    )
  }

  // ----- ส่วนตัวเลือก (รุ่น/ความจำ/อาชีพ/หลักฐาน/โปรโมชั่น) -----
  function renderOption(kind: OptionKind) {
    const meta = OPTION_KINDS.find((k) => k.kind === kind)!
    return (
      <Card key={kind}>
        <h3 className="mb-3 font-semibold text-ink">{meta.title}</h3>
        <ManagedList
          items={data.options[kind] ?? []}
          getText={(o) => o.label}
          emptyText={`ยังไม่มี${meta.title}`}
          searchPlaceholder={`ค้นหา${meta.title}...`}
          toolbarRight={
            canEdit ? (
              <Button
                variant="ghost"
                onClick={() => setOptModal({ kind, label: '', detail: '', active: true })}
              >
                <Plus size={16} /> เพิ่ม
              </Button>
            ) : undefined
          }
          renderItem={(o) => (
            <div
              className={`flex items-center justify-between gap-2 rounded-xl bg-white px-4 py-2.5 ${o.active ? '' : 'opacity-60'}`}
            >
              <span className={o.active ? 'text-ink' : 'text-ink-soft line-through'}>
                {o.label}
                {meta.hasDetail && o.detail ? <span className="text-ink-soft"> — {o.detail}</span> : ''}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <Badge tone={o.active ? 'green' : 'neutral'}>{o.active ? 'ใช้งาน' : 'ปิด'}</Badge>
                {canEdit && (
                  <>
                    <button
                      onClick={() => setOptModal({ id: o.id, kind, label: o.label, detail: o.detail ?? '', active: o.active })}
                      className="rounded-lg p-1.5 text-ink-soft hover:bg-peach-light"
                      title="แก้ไข"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => toggleOption(o)}
                      className="rounded-lg px-2 py-1 text-xs text-ink-soft hover:bg-peach-light"
                    >
                      {o.active ? 'ปิด' : 'เปิด'}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        />
      </Card>
    )
  }

  // ----- ส่วนสิทธิ์ผู้ใช้ (ตัวอย่างโครงสร้าง — ยังไม่บันทึกจริง) -----
  function renderPermissions() {
    return (
      <Card>
        <h3 className="mb-1 font-semibold text-ink">สิทธิ์ผู้ใช้งาน</h3>
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          🔧 นี่คือ <b>ตัวอย่างโครงสร้าง</b>ที่เสนอไว้ — ยังไม่มีผลจริง (ผู้บริหารมีสิทธิ์ทั้งหมดเสมอ).
          พี่กำหนดได้ว่าจะให้ <b>พนักงาน</b> ทำอะไรได้บ้าง แล้วค่อยบอกหนูบันทึกจริงทีหลังค่ะ
        </div>
        <div className="overflow-x-auto rounded-xl border border-peach">
          <table className="w-full min-w-[460px] text-sm">
            <thead>
              <tr className="bg-peach-light text-left text-ink">
                <th className="px-4 py-2.5 font-semibold">สิทธิ์การใช้งาน</th>
                <th className="w-28 px-3 py-2.5 text-center font-semibold">พนักงาน</th>
                <th className="w-28 px-3 py-2.5 text-center font-semibold">ผู้บริหาร</th>
              </tr>
            </thead>
            <tbody>
              {PERMISSIONS.map((p, i) => (
                <tr key={p.key} className={i % 2 ? 'bg-white' : 'bg-cream-deep'}>
                  <td className="px-4 py-2.5 text-ink">{p.label}</td>
                  <td className="px-3 py-2.5 text-center">
                    <input
                      type="checkbox"
                      checked={!!staffPerms[p.key]}
                      disabled={!canEdit}
                      onChange={(e) => setStaffPerms((prev) => ({ ...prev, [p.key]: e.target.checked }))}
                      className="h-4 w-4 accent-salmon-deep"
                    />
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    {/* ผู้บริหารมีสิทธิ์ทั้งหมดเสมอ */}
                    <input type="checkbox" checked readOnly disabled className="h-4 w-4 accent-salmon-deep opacity-70" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {canEdit && (
          <div className="mt-4 flex justify-end">
            <Button disabled title="ยังไม่เปิดใช้ — รอกำหนดสิทธิ์จริง">
              บันทึกสิทธิ์ (เร็วๆ นี้)
            </Button>
          </div>
        )}
      </Card>
    )
  }

  return (
    <div>
      <PageTitle sub={canEdit ? 'เพิ่ม/แก้ไข/ปิดใช้งานได้ (ปิดแทนลบ ของเก่าไม่หาย)' : 'ดูได้อย่างเดียว — การแก้ไขเฉพาะแอดมิน'}>
        ตั้งค่า
      </PageTitle>

      {loading ? (
        <Loading />
      ) : (
        <>
          {/* ===== ปุ่มเลือกหมวด (สลับได้จากที่นี่หรือ sidebar submenu) ===== */}
          <div className="mb-5 flex flex-wrap gap-2">
            {visibleCats.map((c) => {
              const active = cat === c.key
              return (
                <button
                  key={c.key}
                  onClick={() => setCat(c.key)}
                  className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold transition ${
                    active
                      ? 'border-salmon-deep bg-salmon-deep text-white shadow-sm'
                      : 'border-peach bg-cream-deep text-ink hover:bg-peach-light'
                  }`}
                >
                  <c.icon size={17} className={active ? 'text-white' : 'text-salmon-deep'} />
                  {c.label}
                </button>
              )
            })}
          </div>

          {/* ===== เนื้อหาตามหมวดที่เลือก ===== */}
          <div className="flex flex-col gap-4">
            {cat === 'shops' && renderShops()}
            {cat === 'users' && renderPermissions()}
            {cat === 'rates' && <RateSetsEditor canEdit={canEdit} />}
            {cat !== 'shops' &&
              cat !== 'users' &&
              cat !== 'rates' &&
              CATEGORIES.find((c) => c.key === cat)!.kinds.map((kind) => renderOption(kind))}
          </div>
        </>
      )}

      {/* ===== Modal แก้ไขร้านค้า ===== */}
      {shopModal && (
        <ShopModalForm
          value={shopModal}
          onClose={() => setShopModal(null)}
          onSaved={async () => {
            setShopModal(null)
            await load()
          }}
        />
      )}

      {/* ===== Modal แก้ไขตัวเลือก ===== */}
      {optModal && (
        <OptionModalForm
          value={optModal}
          hasDetail={OPTION_KINDS.find((k) => k.kind === optModal.kind)?.hasDetail}
          onClose={() => setOptModal(null)}
          onSaved={async () => {
            setOptModal(null)
            await load()
          }}
        />
      )}
    </div>
  )
}

function ShopModalForm({
  value,
  onClose,
  onSaved,
}: {
  value: ShopInput
  onClose: () => void
  onSaved: () => void
}) {
  const [f, setF] = useState<ShopInput>(value)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [employees, setEmployees] = useState<Employee[]>([])
  const set = (k: keyof ShopInput, v: string) => setF((p) => ({ ...p, [k]: v }))

  useEffect(() => {
    getEmployees().then(setEmployees).catch(() => setEmployees([]))
  }, [])

  // เลือกผู้หาร้าน — ถ้าเลือกคนแล้วยังไม่มีวันที่ ให้เติมวันนี้อัตโนมัติ (วันหาร้านบังคับมี)
  const setRecruiter = (id: string) =>
    setF((p) => ({
      ...p,
      recruitedBy: id || null,
      recruitedAt: id ? p.recruitedAt || new Date().toISOString().slice(0, 10) : null,
    }))

  async function save() {
    if (!f.code || !f.name) {
      setErr('กรุณากรอก รหัสร้าน และ ชื่อร้าน')
      return
    }
    if (f.recruitedBy && !f.recruitedAt) {
      setErr('เลือกผู้หาร้านแล้ว กรุณาระบุวันที่หาร้านด้วย')
      return
    }
    setBusy(true)
    try {
      await saveShop(f)
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal title={value.id ? 'แก้ไขร้านค้า' : 'เพิ่มร้านค้า'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto pr-1">
          <Field label="รหัสร้าน" required>
            <Input value={f.code} onChange={(e) => set('code', e.target.value)} placeholder="AQ S00016" />
          </Field>
          <Field label="ชื่อร้าน" required>
            <Input value={f.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="ธนาคาร">
            <Input value={f.bank} onChange={(e) => set('bank', e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="เลขบัญชี">
              <Input value={f.accountNo} onChange={(e) => set('accountNo', e.target.value)} />
            </Field>
            <Field label="ชื่อบัญชี">
              <Input value={f.accountName} onChange={(e) => set('accountName', e.target.value)} />
            </Field>
          </div>

          <p className="mt-1 border-t border-peach pt-3 text-sm font-semibold text-ink">ข้อมูลติดต่อ (เผื่อต่อยอด)</p>
          <Field label="ชื่อเจ้าของร้าน">
            <Input value={f.ownerName ?? ''} onChange={(e) => set('ownerName', e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="เบอร์โทร">
              <Input value={f.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />
            </Field>
            <Field label="จังหวัด">
              <Input value={f.province ?? ''} onChange={(e) => set('province', e.target.value)} />
            </Field>
          </div>
          <Field label="ลิงก์เฟซบุ๊ก">
            <Input value={f.facebookLink ?? ''} onChange={(e) => set('facebookLink', e.target.value)} placeholder="https://facebook.com/..." />
          </Field>
          <Field label="ช่องทางติดต่ออื่นๆ (LINE ฯลฯ)">
            <Input value={f.contactChannel ?? ''} onChange={(e) => set('contactChannel', e.target.value)} />
          </Field>
          <Field label="ที่อยู่">
            <Input value={f.address ?? ''} onChange={(e) => set('address', e.target.value)} />
          </Field>

          <p className="mt-1 border-t border-peach pt-3 text-sm font-semibold text-ink">ค่าคอมหาร้าน</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="พนักงานที่หาร้านนี้">
              <select
                value={f.recruitedBy ?? ''}
                onChange={(e) => setRecruiter(e.target.value)}
                className="w-full rounded-xl border border-peach bg-white px-3 py-2 text-sm text-ink"
              >
                <option value="">— ไม่ระบุ —</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.fullName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="วันที่หาร้าน">
              <Input
                type="date"
                value={f.recruitedAt ?? ''}
                disabled={!f.recruitedBy}
                onChange={(e) => set('recruitedAt', e.target.value)}
              />
            </Field>
          </div>
        </div>

        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
          <Button onClick={save} disabled={busy}>{busy ? 'กำลังบันทึก...' : 'บันทึก'}</Button>
        </div>
      </div>
    </Modal>
  )
}

function OptionModalForm({
  value,
  hasDetail,
  onClose,
  onSaved,
}: {
  value: OptionInput
  hasDetail?: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [f, setF] = useState<OptionInput>(value)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    if (!f.label) {
      setErr('กรุณากรอกชื่อ')
      return
    }
    setBusy(true)
    try {
      await saveOption(f)
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal title={value.id ? 'แก้ไขตัวเลือก' : 'เพิ่มตัวเลือก'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="ชื่อ" required>
          <Input value={f.label} onChange={(e) => setF((p) => ({ ...p, label: e.target.value }))} />
        </Field>
        {hasDetail && (
          <Field label="รายละเอียด">
            <Input value={f.detail ?? ''} onChange={(e) => setF((p) => ({ ...p, detail: e.target.value }))} />
          </Field>
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
          <Button onClick={save} disabled={busy}>{busy ? 'กำลังบันทึก...' : 'บันทึก'}</Button>
        </div>
      </div>
    </Modal>
  )
}
