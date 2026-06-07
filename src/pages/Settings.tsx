import { useCallback, useEffect, useState } from 'react'
import { Pencil, Plus } from 'lucide-react'
import { Badge, Button, Card, Field, Input, Loading, Modal, PageTitle } from '../components/ui'
import { useAuth } from '../lib/auth'
import {
  getAllOptions,
  getAllShops,
  saveOption,
  saveShop,
  setOptionActive,
  setShopActive,
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

const emptyData = {
  shops: [] as Shop[],
  options: {} as Record<OptionKind, Option[]>,
}

export default function Settings() {
  const { role, configured } = useAuth()
  const canEdit = !configured || role === 'admin'

  const [data, setData] = useState(emptyData)
  const [loading, setLoading] = useState(true)
  const [shopModal, setShopModal] = useState<ShopInput | null>(null)
  const [optModal, setOptModal] = useState<OptionInput | null>(null)

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

  return (
    <div>
      <PageTitle sub={canEdit ? 'เพิ่ม/แก้ไข/ปิดใช้งานได้ (ปิดแทนลบ ของเก่าไม่หาย)' : 'ดูได้อย่างเดียว — การแก้ไขเฉพาะแอดมิน'}>
        ตั้งค่า
      </PageTitle>

      {loading ? (
        <Loading />
      ) : (
        <div className="flex flex-col gap-4">
          {/* ===== ร้านค้า ===== */}
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold text-ink">ร้านค้า ({data.shops.length})</h3>
              {canEdit && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    setShopModal({ code: '', name: '', bank: '', accountNo: '', accountName: '', active: true })
                  }
                >
                  <Plus size={16} /> เพิ่มร้านค้า
                </Button>
              )}
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {data.shops.map((s) => (
                <div
                  key={s.id}
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
              ))}
            </div>
          </Card>

          {/* ===== ตัวเลือกต่างๆ ===== */}
          {OPTION_KINDS.map(({ kind, title, hasDetail }) => (
            <Card key={kind}>
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-semibold text-ink">{title}</h3>
                {canEdit && (
                  <Button
                    variant="ghost"
                    onClick={() => setOptModal({ kind, label: '', detail: '', active: true })}
                  >
                    <Plus size={16} /> เพิ่ม
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {data.options[kind]?.map((o) => (
                  <div
                    key={o.id}
                    className={`flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-sm shadow-sm ${o.active ? 'text-ink' : 'text-ink-soft line-through opacity-60'}`}
                  >
                    <span>{o.label}{hasDetail && o.detail ? ` — ${o.detail}` : ''}</span>
                    {canEdit && (
                      <>
                        <button
                          onClick={() => setOptModal({ id: o.id, kind, label: o.label, detail: o.detail ?? '', active: o.active })}
                          className="text-ink-soft hover:text-ink"
                          title="แก้ไข"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => toggleOption(o)}
                          className="text-xs text-ink-soft hover:text-ink"
                        >
                          {o.active ? '(ปิด)' : '(เปิด)'}
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
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
  const set = (k: keyof ShopInput, v: string) => setF((p) => ({ ...p, [k]: v }))

  async function save() {
    if (!f.code || !f.name) {
      setErr('กรุณากรอก รหัสร้าน และ ชื่อร้าน')
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
        <Field label="รหัสร้าน" required>
          <Input value={f.code} onChange={(e) => set('code', e.target.value)} placeholder="AQ S00016" />
        </Field>
        <Field label="ชื่อร้าน" required>
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="ธนาคาร">
          <Input value={f.bank} onChange={(e) => set('bank', e.target.value)} />
        </Field>
        <Field label="เลขบัญชี">
          <Input value={f.accountNo} onChange={(e) => set('accountNo', e.target.value)} />
        </Field>
        <Field label="ชื่อบัญชี">
          <Input value={f.accountName} onChange={(e) => set('accountName', e.target.value)} />
        </Field>
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
