import { useEffect, useMemo, useState } from 'react'
import { Save } from 'lucide-react'
import { Button, Card, Field, Input, Loading, PageTitle, Select } from '../components/ui'
import CopyBox from '../components/CopyBox'
import { calcSummary } from '../lib/calc'
import { ageRange, baht } from '../lib/format'
import { buildEmailText, buildSingleSummary } from '../lib/messages'
import type { Contract, DeviceCondition, DeviceOrigin } from '../lib/types'
import { getOptions, getShops, insertContract } from '../lib/db'
import { useAsync } from '../lib/useAsync'
import { isSupabaseConfigured } from '../lib/supabase'

interface FormState {
  transactionDate: string
  shopId: string
  contractNo: string
  invNo: string
  customerName: string
  phone: string
  phoneAlt1: string
  phoneAlt2: string
  facebookLink: string
  birthYear: string
  occupation: string
  occupationProof: string
  model: string
  storage: string
  sn: string
  condition: DeviceCondition
  origin: DeviceOrigin
  devicePrice: string
  downPercent: string
  commissionPercent: string
  docFee: string
  financeAmount: string
  monthlyPayment: string
  termMonths: string
  dueDay: string
  hasPromotion: boolean
  promotion: string
  promotionDetail: string
  operator: string
  notes: string
}

const today = new Date().toISOString().slice(0, 10)

const initial: FormState = {
  transactionDate: today,
  shopId: '',
  contractNo: '',
  invNo: '',
  customerName: '',
  phone: '',
  phoneAlt1: '',
  phoneAlt2: '',
  facebookLink: '',
  birthYear: '',
  occupation: '',
  occupationProof: '',
  model: '',
  storage: '',
  sn: '',
  condition: 'new',
  origin: 'th',
  devicePrice: '',
  downPercent: '30',
  commissionPercent: '12',
  docFee: '100',
  financeAmount: '',
  monthlyPayment: '',
  termMonths: '12',
  dueDay: '1',
  hasPromotion: false,
  promotion: '',
  promotionDetail: '',
  operator: '',
  notes: '',
}

const num = (s: string) => Number(s) || 0

export default function AddContract() {
  // โหลดร้านค้า + ตัวเลือกผ่านชั้นข้อมูลกลาง (mock หรือ Supabase อัตโนมัติ)
  const { data: opts, loading } = useAsync(
    async () => {
      const [shops, models, storages, occupations, proofs, promotions] = await Promise.all([
        getShops(),
        getOptions('phone_model'),
        getOptions('storage'),
        getOptions('occupation'),
        getOptions('occupation_proof'),
        getOptions('promotion'),
      ])
      return { shops, models, storages, occupations, proofs, promotions }
    },
    { shops: [], models: [], storages: [], occupations: [], proofs: [], promotions: [] },
  )

  const [f, setF] = useState<FormState>(initial)
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setF((prev) => ({ ...prev, [key]: value }))

  // ตั้งค่าดีฟอลต์ของ dropdown เมื่อข้อมูลโหลดเสร็จ (เฉพาะช่องที่ยังว่าง)
  useEffect(() => {
    setF((prev) => ({
      ...prev,
      shopId: prev.shopId || opts.shops[0]?.id || '',
      model: prev.model || opts.models[0]?.label || '',
      storage: prev.storage || opts.storages[0]?.label || '',
      occupation: prev.occupation || opts.occupations[0]?.label || '',
      occupationProof: prev.occupationProof || opts.proofs[0]?.label || '',
    }))
  }, [opts])

  const shop = opts.shops.find((s) => s.id === f.shopId)
  const currentYear = new Date().getFullYear()

  const summary = useMemo(
    () => calcSummary(num(f.devicePrice), num(f.downPercent), num(f.commissionPercent), num(f.docFee)),
    [f.devicePrice, f.downPercent, f.commissionPercent, f.docFee],
  )

  // สร้าง object สัญญาจากฟอร์ม เพื่อป้อนตัวสร้างข้อความ + บันทึก
  const preview: Contract = {
    id: 'preview',
    contractNo: f.contractNo || '—',
    invNo: f.invNo || '—',
    sn: f.sn || '—',
    customerName: f.customerName || '—',
    phone: f.phone,
    phoneAlt1: f.phoneAlt1,
    phoneAlt2: f.phoneAlt2,
    facebookLink: f.facebookLink,
    birthYear: num(f.birthYear) || undefined,
    occupation: f.occupation,
    occupationProof: f.occupationProof,
    shopId: f.shopId,
    model: f.model,
    storage: f.storage,
    condition: f.condition,
    origin: f.origin,
    devicePrice: num(f.devicePrice),
    downPercent: num(f.downPercent),
    commissionPercent: num(f.commissionPercent),
    docFee: num(f.docFee),
    financeAmount: num(f.financeAmount),
    monthlyPayment: num(f.monthlyPayment),
    termMonths: num(f.termMonths),
    dueDay: num(f.dueDay),
    hasPromotion: f.hasPromotion,
    promotion: f.promotion,
    promotionDetail: f.promotionDetail,
    status: 'active',
    transactionDate: f.transactionDate,
    operator: f.operator,
    notes: f.notes,
  }

  const summaryText = shop ? buildSingleSummary(preview, shop, f.transactionDate) : ''
  const emailText = shop ? buildEmailText(preview, shop) : ''

  async function handleSave() {
    if (!f.contractNo || !f.customerName || !shop) {
      alert('กรุณากรอก เลขที่สัญญา / ชื่อลูกค้า / ร้านค้า ก่อนนะคะ')
      return
    }
    setSaving(true)
    try {
      await insertContract(preview) // ฟังก์ชันละ id ออกให้เอง
      alert(
        isSupabaseConfigured
          ? 'บันทึกสัญญาสำเร็จ ✅'
          : 'ตรวจสอบข้อมูลเรียบร้อย (โหมดตัวอย่าง — ยังไม่บันทึกจริงจนกว่าจะเชื่อม Supabase)',
      )
      if (isSupabaseConfigured) setF(initial)
    } catch (e) {
      alert('บันทึกไม่สำเร็จ: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div>
        <PageTitle>เพิ่มข้อมูลสัญญา</PageTitle>
        <Loading />
      </div>
    )
  }

  return (
    <div>
      <PageTitle sub="กรอกครั้งเดียว ได้ครบ — ระบบคำนวณยอดและสร้างข้อความสรุปยอด/อีเมลให้อัตโนมัติ">
        เพิ่มข้อมูลสัญญา
      </PageTitle>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ===== ฝั่งซ้าย: ฟอร์ม ===== */}
        <div className="flex flex-col gap-5">
          <Card>
            <h3 className="mb-3 font-semibold text-ink">ข้อมูลรายการ</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="วันที่ทำรายการ" required>
                <Input
                  type="date"
                  value={f.transactionDate}
                  onChange={(e) => set('transactionDate', e.target.value)}
                />
              </Field>
              <Field label="ชื่อร้านค้า" required>
                <Select value={f.shopId} onChange={(e) => set('shopId', e.target.value)}>
                  {opts.shops.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="เลขที่สัญญา" required>
                <Input value={f.contractNo} onChange={(e) => set('contractNo', e.target.value)} placeholder="S00016PNQ280" />
              </Field>
              <Field label="เลข INV" required>
                <Input value={f.invNo} onChange={(e) => set('invNo', e.target.value)} placeholder="INV-..." />
              </Field>
            </div>
          </Card>

          <Card>
            <h3 className="mb-3 font-semibold text-ink">ข้อมูลลูกค้า</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="ชื่อลูกค้า" required>
                <Input value={f.customerName} onChange={(e) => set('customerName', e.target.value)} />
              </Field>
              <Field label="เบอร์โทรลูกค้า">
                <Input value={f.phone} onChange={(e) => set('phone', e.target.value)} />
              </Field>
              <Field label="โทรศัพท์สำรอง 1">
                <Input value={f.phoneAlt1} onChange={(e) => set('phoneAlt1', e.target.value)} />
              </Field>
              <Field label="โทรศัพท์สำรอง 2">
                <Input value={f.phoneAlt2} onChange={(e) => set('phoneAlt2', e.target.value)} />
              </Field>
              <Field label="ลิงค์เฟสลูกค้า">
                <Input value={f.facebookLink} onChange={(e) => set('facebookLink', e.target.value)} />
              </Field>
              <Field label={`ปีเกิด (ค.ศ.)  ›  อายุ ${ageRange(num(f.birthYear) || undefined, currentYear)}`}>
                <Input
                  type="number"
                  value={f.birthYear}
                  onChange={(e) => set('birthYear', e.target.value)}
                  placeholder="1998"
                />
              </Field>
              <Field label="อาชีพ">
                <Select value={f.occupation} onChange={(e) => set('occupation', e.target.value)}>
                  {opts.occupations.map((o) => (
                    <option key={o.id} value={o.label}>{o.label}</option>
                  ))}
                </Select>
              </Field>
              <Field label="หลักฐานอาชีพ">
                <Select value={f.occupationProof} onChange={(e) => set('occupationProof', e.target.value)}>
                  {opts.proofs.map((o) => (
                    <option key={o.id} value={o.label}>{o.label}</option>
                  ))}
                </Select>
              </Field>
            </div>
          </Card>

          <Card>
            <h3 className="mb-3 font-semibold text-ink">ข้อมูลเครื่อง</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="รุ่น">
                <Select value={f.model} onChange={(e) => set('model', e.target.value)}>
                  {opts.models.map((o) => (
                    <option key={o.id} value={o.label}>{o.label}</option>
                  ))}
                </Select>
              </Field>
              <Field label="ความจำ">
                <Select value={f.storage} onChange={(e) => set('storage', e.target.value)}>
                  {opts.storages.map((o) => (
                    <option key={o.id} value={o.label}>{o.label}</option>
                  ))}
                </Select>
              </Field>
              <Field label="หมายเลข SN">
                <Input value={f.sn} onChange={(e) => set('sn', e.target.value)} />
              </Field>
              <Field label="ราคาตัวเครื่อง (บาท)" required>
                <Input type="number" value={f.devicePrice} onChange={(e) => set('devicePrice', e.target.value)} placeholder="19900" />
              </Field>
              <Field label="สภาพสินค้า">
                <Select value={f.condition} onChange={(e) => set('condition', e.target.value as DeviceCondition)}>
                  <option value="new">มือ 1</option>
                  <option value="used">มือ 2</option>
                </Select>
              </Field>
              <Field label="แหล่งเครื่อง">
                <Select value={f.origin} onChange={(e) => set('origin', e.target.value as DeviceOrigin)}>
                  <option value="th">เครื่องไทย</option>
                  <option value="inter">เครื่องนอก</option>
                </Select>
              </Field>
            </div>
          </Card>

          <Card>
            <h3 className="mb-3 font-semibold text-ink">การเงิน — ซื้อเครื่อง (สำหรับสรุปยอดโอน)</h3>
            <div className="grid grid-cols-3 gap-3">
              <Field label="% ดาวน์">
                <Input type="number" value={f.downPercent} onChange={(e) => set('downPercent', e.target.value)} />
              </Field>
              <Field label="% คอมมิชชั่น">
                <Input type="number" value={f.commissionPercent} onChange={(e) => set('commissionPercent', e.target.value)} />
              </Field>
              <Field label="ค่าเอกสาร (หักออก)">
                <Input type="number" value={f.docFee} onChange={(e) => set('docFee', e.target.value)} />
              </Field>
            </div>
            {/* แสดงผลคำนวณสด */}
            <div className="mt-3 grid grid-cols-3 gap-3 rounded-xl bg-white p-3 text-sm">
              <div>
                <p className="text-ink-soft">หลังหักดาวน์</p>
                <p className="font-semibold text-ink">{baht(summary.afterDown)} ฿</p>
              </div>
              <div>
                <p className="text-ink-soft">ค่าคอมมิชชั่น</p>
                <p className="font-semibold text-ink">{baht(summary.commission)} ฿</p>
              </div>
              <div>
                <p className="text-ink-soft">สุทธิ (โอนให้ร้าน)</p>
                <p className="font-bold text-salmon-deep">{baht(summary.net)} ฿</p>
              </div>
            </div>
          </Card>

          <Card>
            <h3 className="mb-3 font-semibold text-ink">การเงิน — ผ่อน</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="ยอดจัดไฟแนนซ์">
                <Input type="number" value={f.financeAmount} onChange={(e) => set('financeAmount', e.target.value)} />
              </Field>
              <Field label="ค่าเช่าต่อเดือน">
                <Input type="number" value={f.monthlyPayment} onChange={(e) => set('monthlyPayment', e.target.value)} />
              </Field>
              <Field label="จำนวนเดือน">
                <Input type="number" value={f.termMonths} onChange={(e) => set('termMonths', e.target.value)} />
              </Field>
              <Field label="ชำระทุกวันที่ (1-31)">
                <Input type="number" min={1} max={31} value={f.dueDay} onChange={(e) => set('dueDay', e.target.value)} />
              </Field>
            </div>
          </Card>

          <Card>
            <h3 className="mb-3 font-semibold text-ink">โปรโมชั่น & ผู้ดำเนินการ</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="มีโปรโมชั่นไหม">
                <Select
                  value={f.hasPromotion ? 'yes' : 'no'}
                  onChange={(e) => set('hasPromotion', e.target.value === 'yes')}
                >
                  <option value="no">ไม่มีโปร</option>
                  <option value="yes">มีโปร</option>
                </Select>
              </Field>
              {f.hasPromotion && (
                <Field label="รายละเอียดโปร">
                  <Select
                    value={f.promotion}
                    onChange={(e) => {
                      const p = opts.promotions.find((x) => x.label === e.target.value)
                      set('promotion', e.target.value)
                      set('promotionDetail', p?.detail ?? '')
                    }}
                  >
                    <option value="">— เลือกโปร —</option>
                    {opts.promotions.map((o) => (
                      <option key={o.id} value={o.label}>{o.label}</option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label="ผู้ดำเนินการ" required>
                <Input value={f.operator} onChange={(e) => set('operator', e.target.value)} />
              </Field>
              <Field label="หมายเหตุ">
                <Input value={f.notes} onChange={(e) => set('notes', e.target.value)} />
              </Field>
            </div>
          </Card>

          <Button onClick={handleSave} disabled={saving} className="self-start">
            <Save size={16} /> {saving ? 'กำลังบันทึก...' : 'บันทึกสัญญา'}
          </Button>
        </div>

        {/* ===== ฝั่งขวา: ข้อความที่สร้างให้สดๆ ===== */}
        <div className="flex flex-col gap-4 lg:sticky lg:top-4 lg:self-start">
          <p className="text-sm text-ink-soft">
            ข้อความด้านล่างสร้างจากข้อมูลที่กรอกแบบเรียลไทม์ — กรอกครบแล้วกด "คัดลอก" ไปวางส่งได้เลย
          </p>
          <CopyBox title="ข้อความสรุปยอดโอน" text={summaryText} />
          <CopyBox title="ข้อความอีเมล (ส่งพาร์ทเนอร์)" text={emailText} />
        </div>
      </div>
    </div>
  )
}
