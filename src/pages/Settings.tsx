import { useCallback, useEffect, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { BadgePercent, Briefcase, Check, Copy, KeyRound, Pencil, Percent, Plus, ShieldCheck, Smartphone, Store, Tag, type LucideIcon } from 'lucide-react'
import { Badge, Button, Card, Field, Input, Loading, Modal, PageTitle } from '../components/ui'
import CopyBox from '../components/CopyBox'
import { ManagedList } from '../components/ManagedList'
import { RateSetsEditor } from '../components/RateSetsEditor'
import { SettlementMatrixEditor } from '../components/SettlementMatrixEditor'
import { UsersAdmin } from '../components/UsersAdmin'
import { useAuth } from '../lib/auth'
import {
  adminSetShopCreditPin,
  getAllOptions,
  getAllShops,
  getEmployees,
  saveOption,
  saveShop,
  setOptionActive,
  setShopActive,
  setShopCreditCheckEnabled,
  type Employee,
  type OptionInput,
  type OptionKind,
  type ShopInput,
} from '../lib/db'
import type { Option, Shop } from '../lib/types'

const CREDIT_CHECK_URL = 'https://winsureplus.vercel.app/check'

function buildCreditCheckLineMessage(shopName: string, loginCode: string, pin: string): string {
  return [
    `สวัสดีค่ะ ร้าน ${shopName}`,
    '',
    'แอดมิน WIN SURE PLUS เปิดสิทธิ์ให้ร้านเช็คเครดิตลูกค้าเบื้องต้นได้เองแล้วนะคะ',
    '',
    `ลิงก์เข้าใช้งาน: ${CREDIT_CHECK_URL}`,
    `รหัสร้าน: ${loginCode}`,
    `PIN: ${pin}`,
    '',
    'กรุณาเก็บรหัสนี้เป็นความลับ ไม่ส่งต่อร้านอื่นนะคะ',
    'มีข้อสงสัยติดต่อแอดมิน WIN SURE PLUS ได้เลยค่ะ',
  ].join('\n')
}

/** สวิตช์เปิด/ปิด "เช็คเครดิตเอง" ต่อร้าน — role="switch" + aria-checked ให้ screen reader อ่านสถานะถูก */
function CreditCheckToggle({
  checked,
  busy,
  label,
  onToggle,
}: {
  checked: boolean
  busy: boolean
  label: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={busy}
      onClick={onToggle}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? 'bg-green-500' : 'bg-peach'
      }`}
    >
      <span
        aria-hidden
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  )
}

const OPTION_KINDS: { kind: OptionKind; title: string; hasDetail?: boolean }[] = [
  { kind: 'phone_model', title: 'รุ่นโทรศัพท์' },
  { kind: 'storage', title: 'ความจำ' },
  { kind: 'occupation', title: 'อาชีพ' },
  { kind: 'occupation_proof', title: 'หลักฐานอาชีพ' },
  { kind: 'promotion', title: 'โปรโมชั่น', hasDetail: true },
]

// หมวดตั้งค่า — แยกเป็นหัวข้อย่อย เลือกผ่าน URL /settings/:cat (สลับจาก sidebar submenu หรือปุ่มหน้านี้)
type CategoryKey = 'shops' | 'device' | 'job' | 'promo' | 'rates' | 'settlement' | 'users'
const CATEGORIES: { key: CategoryKey; label: string; icon: LucideIcon; kinds: OptionKind[]; adminOnly?: boolean }[] = [
  { key: 'shops', label: 'ร้านค้า', icon: Store, kinds: [] },
  { key: 'device', label: 'ตัวเครื่อง', icon: Smartphone, kinds: ['phone_model', 'storage'] },
  { key: 'job', label: 'อาชีพ & หลักฐาน', icon: Briefcase, kinds: ['occupation', 'occupation_proof'] },
  { key: 'promo', label: 'โปรโมชั่น', icon: Tag, kinds: ['promotion'] },
  { key: 'rates', label: 'เรตผ่อน', icon: Percent, kinds: [], adminOnly: true },
  { key: 'settlement', label: 'ส่วนลดปิดสัญญา', icon: BadgePercent, kinds: [], adminOnly: true },
  { key: 'users', label: 'สิทธิ์ผู้ใช้', icon: ShieldCheck, kinds: [], adminOnly: true },
]

const emptyData = {
  shops: [] as Shop[],
  options: {} as Record<OptionKind, Option[]>,
}

export default function Settings() {
  const { role, configured } = useAuth()
  const canEdit = !configured || role === 'admin'
  const isAdmin = canEdit
  const { cat: catParam } = useParams<{ cat: CategoryKey }>()
  if ((catParam === 'users' || catParam === 'settlement' || catParam === 'rates') && !isAdmin) return <Navigate to="/settings/shops" replace />

  // กรองเฉพาะหมวดที่ user ดูได้ (staff ไม่เห็น 'users')
  const visibleCats = CATEGORIES.filter((c) => !c.adminOnly || isAdmin)
  const cat: CategoryKey = visibleCats.some((c) => c.key === catParam) ? (catParam as CategoryKey) : 'shops'

  const [data, setData] = useState(emptyData)
  const [loading, setLoading] = useState(true)
  const [shopModal, setShopModal] = useState<ShopInput | null>(null)
  const [optModal, setOptModal] = useState<OptionInput | null>(null)
  const [pinModalShop, setPinModalShop] = useState<Shop | null>(null)
  const [creditToggleBusyId, setCreditToggleBusyId] = useState<string | null>(null)
  const [creditToggleMsg, setCreditToggleMsg] = useState<{ id: string; text: string } | null>(null)

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
  // toggle "เช็คเครดิตเอง" ต่อร้าน — optimistic (สลับ UI ทันที) แล้วค่อยยิง DB จริง
  // ถ้าพลาด: reload จาก DB กลับสถานะจริง (กัน UI ค้างผิดจากของจริง) + โชว์ error สั้นๆ ที่แถวนั้น
  async function toggleCreditCheckEnabled(s: Shop) {
    const next = !s.creditCheckEnabled
    setCreditToggleBusyId(s.id)
    setCreditToggleMsg(null)
    setData((prev) => ({
      ...prev,
      shops: prev.shops.map((row) => (row.id === s.id ? { ...row, creditCheckEnabled: next } : row)),
    }))
    try {
      await setShopCreditCheckEnabled(s.id, next)
    } catch (e) {
      setCreditToggleMsg({ id: s.id, text: e instanceof Error ? e.message : 'ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง' })
      await load()
    } finally {
      setCreditToggleBusyId(null)
    }
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
            <div className={`rounded-xl bg-white px-4 py-3 ${s.active ? '' : 'opacity-50'}`}>
              <div className="flex items-center justify-between">
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

              {/* เช็คเครดิตเอง — เฉพาะแอดมิน */}
              {canEdit && (
                <div className="mt-2.5 flex flex-wrap items-center gap-3 border-t border-peach pt-2.5">
                  <span className="flex items-center gap-2 text-xs text-ink-soft">
                    <CreditCheckToggle
                      checked={!!s.creditCheckEnabled}
                      busy={creditToggleBusyId === s.id}
                      label={`เช็คเครดิตเอง — ${s.name}`}
                      onToggle={() => void toggleCreditCheckEnabled(s)}
                    />
                    เช็คเครดิตเอง{s.creditCheckEnabled ? ' (เปิดอยู่)' : ' (ปิดอยู่)'}
                  </span>
                  <span className="text-xs text-ink-soft">
                    รหัสร้าน: {s.creditLoginCode ? <span className="font-mono font-medium text-ink">{s.creditLoginCode}</span> : 'ยังไม่ได้ตั้ง'}
                  </span>
                  {creditToggleMsg?.id === s.id && (
                    <span className="text-xs text-red-600">{creditToggleMsg.text}</span>
                  )}
                  <button
                    onClick={() => setPinModalShop(s)}
                    className="ml-auto inline-flex items-center gap-1 rounded-lg bg-peach-light px-2.5 py-1 text-xs font-medium text-ink hover:bg-peach"
                  >
                    <KeyRound size={13} /> ตั้ง/รีเซ็ต PIN
                  </button>
                </div>
              )}
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

  return (
    <div>
      <PageTitle sub={canEdit ? 'เพิ่ม/แก้ไข/ปิดใช้งานได้ (ปิดแทนลบ ของเก่าไม่หาย)' : 'ดูได้อย่างเดียว — การแก้ไขเฉพาะแอดมิน'}>
        ตั้งค่า
      </PageTitle>

      {loading ? (
        <Loading />
      ) : (
        <>
          {/* ===== เนื้อหาตามหมวดที่เลือก ===== */}
          <div className="flex flex-col gap-4">
            {cat === 'shops' && renderShops()}
            {cat === 'users' && <UsersAdmin />}
            {cat === 'rates' && <RateSetsEditor canEdit={canEdit} />}
            {cat === 'settlement' && <SettlementMatrixEditor canEdit={canEdit} />}
            {cat !== 'shops' &&
              cat !== 'users' &&
              cat !== 'rates' &&
              cat !== 'settlement' &&
              CATEGORIES.find((c) => c.key === cat)!.kinds.map((kind) => renderOption(kind))}
          </div>
        </>
      )}

      {/* ===== Modal ตั้ง/รีเซ็ต PIN เช็คเครดิต ===== */}
      {pinModalShop && (
        <ShopCreditPinModal
          shop={pinModalShop}
          onClose={() => setPinModalShop(null)}
          onGenerated={(loginCode) =>
            setData((prev) => ({
              ...prev,
              shops: prev.shops.map((row) => (row.id === pinModalShop.id ? { ...row, creditLoginCode: loginCode } : row)),
            }))
          }
        />
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
          existing={data.options[optModal.kind] ?? []}
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

/** ตั้ง/รีเซ็ต PIN เช็คเครดิตของร้าน — confirm ก่อนเสมอ (กันกดพลาดรีเซ็ตรหัสร้านที่ใช้อยู่)
 *  แล้วโชว์รหัสร้าน+PIN แบบข้อความเปิดเผยครั้งเดียว (adminSetShopCreditPin คืน plaintext ครั้งเดียว
 *  ไม่มีที่ไหนเก็บ/ดึงย้อนหลังได้อีก) พร้อมข้อความพร้อมส่ง LINE ให้ร้าน */
function ShopCreditPinModal({
  shop,
  onClose,
  onGenerated,
}: {
  shop: Shop
  onClose: () => void
  onGenerated: (loginCode: string) => void
}) {
  const [step, setStep] = useState<'confirm' | 'reveal'>('confirm')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<{ loginCode: string; pin: string } | null>(null)
  const [copied, setCopied] = useState(false)

  async function generate() {
    setBusy(true)
    setErr(null)
    try {
      const r = await adminSetShopCreditPin(shop.id)
      setResult(r)
      setStep('reveal')
      onGenerated(r.loginCode)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function copyCode() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(`รหัสร้าน: ${result.loginCode}\nPIN: ${result.pin}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard ใช้ไม่ได้ (สิทธิ์เบราว์เซอร์) — ไม่ต้องบล็อกอะไร ยังกดคัดลอกจาก CopyBox ด้านล่างได้
    }
  }

  return (
    <Modal
      title={step === 'confirm' ? 'ตั้ง/รีเซ็ต PIN เช็คเครดิต' : 'รหัสร้าน + PIN ใหม่'}
      onClose={onClose}
      closeOnEsc
    >
      {step === 'confirm' && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink">
            รีเซ็ต PIN เช็คเครดิตของร้าน <strong>{shop.name}</strong> ใช่ไหมคะ?
          </p>
          <p className="text-sm text-ink-soft">
            ถ้าร้านนี้เคยมีรหัสร้าน/PIN อยู่แล้ว รหัสเดิมจะใช้ไม่ได้ทันที ต้องส่งรหัสใหม่นี้ให้ร้านแทน
          </p>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
            <Button onClick={() => void generate()} disabled={busy}>
              {busy ? 'กำลังตั้งค่า...' : 'ยืนยันตั้ง/รีเซ็ต PIN'}
            </Button>
          </div>
        </div>
      )}

      {step === 'reveal' && result && (
        <div className="flex flex-col gap-3">
          <p className="rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-800">
            โชว์ได้ครั้งเดียว — คัดลอกหรือส่งให้ร้านก่อนปิดหน้าต่างนี้ ปิดแล้วดึงรหัสนี้กลับมาดูอีกไม่ได้
          </p>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-peach bg-cream-deep/40 px-4 py-3">
            <div className="text-sm text-ink">
              <p>รหัสร้าน: <span className="font-mono font-bold">{result.loginCode}</span></p>
              <p>PIN: <span className="font-mono font-bold">{result.pin}</span></p>
            </div>
            <button
              onClick={() => void copyCode()}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-salmon-deep px-3 py-1.5 text-xs font-semibold text-white hover:brightness-105"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'คัดลอกแล้ว' : 'คัดลอก'}
            </button>
          </div>
          <CopyBox
            title="ข้อความส่งร้านทาง LINE"
            text={buildCreditCheckLineMessage(shop.name, result.loginCode, result.pin)}
          />
          <div className="mt-1 flex justify-end">
            <Button onClick={onClose}>ปิด</Button>
          </div>
        </div>
      )}
    </Modal>
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
  existing,
  onClose,
  onSaved,
}: {
  value: OptionInput
  hasDetail?: boolean
  existing: Option[]
  onClose: () => void
  onSaved: () => void
}) {
  const [f, setF] = useState<OptionInput>(value)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // เช็คชื่อซ้ำ — ตัดช่องว่างหน้า/หลัง + ไม่สนตัวพิมพ์เล็ก/ใหญ่ (ตอนแก้ไขไม่นับตัวเอง)
  const norm = (s: string) => s.trim().toLowerCase()
  const isDuplicate = (label: string) => {
    const target = norm(label)
    if (!target) return false
    return existing.some((o) => o.id !== f.id && norm(o.label) === target)
  }
  const dupLive = isDuplicate(f.label)

  async function save() {
    if (!f.label.trim()) {
      setErr('กรุณากรอกชื่อ')
      return
    }
    if (isDuplicate(f.label)) {
      setErr('ชื่อนี้มีอยู่แล้วในรายการ — ไม่ต้องเพิ่มซ้ำ')
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
        {dupLive && <p className="text-sm text-red-600">ชื่อนี้มีอยู่แล้วในรายการ — ไม่ต้องเพิ่มซ้ำ</p>}
        {err && !dupLive && <p className="text-sm text-red-600">{err}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
          <Button onClick={save} disabled={busy || dupLive}>{busy ? 'กำลังบันทึก...' : 'บันทึก'}</Button>
        </div>
      </div>
    </Modal>
  )
}
