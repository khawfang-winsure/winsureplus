import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Save } from 'lucide-react'
import { Button, Card, Field, Input, Loading, PageTitle, Select } from '../components/ui'
import { calcSummary } from '../lib/calc'
import { ageRange, baht } from '../lib/format'
import { nextContractNo } from '../lib/contractNo'
import type { Contract, DeviceCondition, DeviceOrigin } from '../lib/types'
import {
  contractNoExists,
  getContract,
  getContractAddresses,
  getOptions,
  getRateSets,
  getShopContractNos,
  getShops,
  insertContract,
  saveAddress,
  updateContract,
} from '../lib/db'
import {
  activeRateSets,
  financeFromPrincipal,
  monthlyFrom,
  multiplierFor,
  termsOf,
  type RateSet,
} from '../lib/rates'
import { isAddressEmpty, type CustomerAddress } from '../lib/letters'
import { AddressFields } from '../components/AddressFields'
import { useAsync } from '../lib/useAsync'
import { isSupabaseConfigured } from '../lib/supabase'
import { useAuth } from '../lib/auth'

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

type AddrKey = 'current' | 'id_card' | 'work'

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
const str = (n: number | undefined) => (n === undefined || n === 0 ? '' : String(n))

/** แปลงสัญญาที่โหลดมา -> ค่าในฟอร์ม (สำหรับโหมดแก้ไข) */
function fromContract(c: Contract): FormState {
  return {
    transactionDate: c.transactionDate,
    shopId: c.shopId,
    contractNo: c.contractNo,
    invNo: c.invNo,
    customerName: c.customerName,
    phone: c.phone,
    phoneAlt1: c.phoneAlt1 ?? '',
    phoneAlt2: c.phoneAlt2 ?? '',
    facebookLink: c.facebookLink ?? '',
    birthYear: str(c.birthYear),
    occupation: c.occupation ?? '',
    occupationProof: c.occupationProof ?? '',
    model: c.model,
    storage: c.storage,
    sn: c.sn,
    condition: c.condition,
    origin: c.origin,
    devicePrice: str(c.devicePrice),
    downPercent: String(c.downPercent),
    commissionPercent: String(c.commissionPercent),
    docFee: String(c.docFee),
    financeAmount: str(c.financeAmount),
    monthlyPayment: str(c.monthlyPayment),
    termMonths: String(c.termMonths),
    dueDay: String(c.dueDay),
    hasPromotion: c.hasPromotion,
    promotion: c.promotion ?? '',
    promotionDetail: c.promotionDetail ?? '',
    operator: c.operator,
    notes: c.notes ?? '',
  }
}

export default function AddContract() {
  const { id } = useParams()
  const isEdit = Boolean(id)
  const navigate = useNavigate()
  const { name: myName } = useAuth()

  // โหลดร้านค้า + ตัวเลือกผ่านชั้นข้อมูลกลาง (mock หรือ Supabase อัตโนมัติ)
  const { data: opts, loading } = useAsync(
    async () => {
      const [shops, models, storages, occupations, proofs, promotions, rateSets] = await Promise.all([
        getShops(),
        getOptions('phone_model'),
        getOptions('storage'),
        getOptions('occupation'),
        getOptions('occupation_proof'),
        getOptions('promotion'),
        getRateSets(),
      ])
      return { shops, models, storages, occupations, proofs, promotions, rateSets }
    },
    { shops: [], models: [], storages: [], occupations: [], proofs: [], promotions: [], rateSets: [] as RateSet[] },
  )

  const [f, setF] = useState<FormState>(initial)
  const [saving, setSaving] = useState(false)
  const [loadingContract, setLoadingContract] = useState(isEdit)
  const manualNoRef = useRef(false) // true = พนักงานพิมพ์เลขสัญญาเอง (ห้ามระบบทับ)
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setF((prev) => ({ ...prev, [key]: value }))

  // ที่อยู่ (สำหรับส่งจดหมาย) — 3 ชุด กรอกตอนเพิ่มสัญญา ไม่บังคับ
  const [addr, setAddr] = useState<Record<AddrKey, CustomerAddress>>({
    current: {},
    id_card: {},
    work: {},
  })
  const setAddrField = (k: AddrKey, field: keyof CustomerAddress, v: string) =>
    setAddr((p) => ({ ...p, [k]: { ...p[k], [field]: v } }))
  const copyFromCurrent = (k: AddrKey) => setAddr((p) => ({ ...p, [k]: { ...p.current } }))

  // โหมดแก้ไข: โหลดสัญญาเดิม + ที่อยู่มาใส่ฟอร์ม
  useEffect(() => {
    if (!id) return
    setLoadingContract(true)
    Promise.all([getContract(id), getContractAddresses(id)])
      .then(([c, a]) => {
        if (c) setF(fromContract(c))
        setAddr({ current: a.current ?? {}, id_card: a.id_card ?? {}, work: a.work ?? {} })
      })
      .finally(() => setLoadingContract(false))
  }, [id])

  // ตั้งค่าดีฟอลต์ของ dropdown เมื่อข้อมูลโหลดเสร็จ (เฉพาะช่องที่ยังว่าง — ไม่ทับค่าตอนแก้ไข)
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

  // รันเลขที่สัญญาถัดไปอัตโนมัติเมื่อเลือกร้าน (แยกตามร้าน) — ไม่ทับถ้าพนักงานพิมพ์เอง / โหมดแก้ไข
  useEffect(() => {
    if (isEdit || !f.shopId) return
    let cancelled = false
    getShopContractNos(f.shopId)
      .then((nos) => {
        if (cancelled) return
        const next = nextContractNo(nos)
        setF((prev) => {
          if (manualNoRef.current && prev.contractNo) return prev // พนักงานพิมพ์เองแล้ว
          return { ...prev, contractNo: next ?? '' }
        })
      })
      .catch(() => {}) // ดึงไม่ได้ก็ปล่อยให้พิมพ์เอง
    return () => {
      cancelled = true
    }
  }, [f.shopId, isEdit])

  const shop = opts.shops.find((s) => s.id === f.shopId)
  const currentYear = new Date().getFullYear()

  const summary = useMemo(
    () => calcSummary(num(f.devicePrice), num(f.downPercent), num(f.commissionPercent), num(f.docFee)),
    [f.devicePrice, f.downPercent, f.commissionPercent, f.docFee],
  )

  // ===== ตัวช่วยคิดค่างวดจากเรต (ตัวคูณต่อจำนวนงวด) =====
  const [rateSetId, setRateSetId] = useState('')
  const [rateTerm, setRateTerm] = useState(0)
  const liveRateSets = activeRateSets(opts.rateSets)
  // ตั้งชุดเรต/งวดเริ่มต้นเมื่อข้อมูลโหลด
  useEffect(() => {
    if (!liveRateSets.length) return
    setRateSetId((prev) => prev || liveRateSets[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.rateSets])
  const rateSet = liveRateSets.find((s) => s.id === rateSetId) ?? null
  const rateTerms = termsOf(rateSet)
  useEffect(() => {
    if (rateTerms.length && !rateTerms.includes(rateTerm)) setRateTerm(rateTerms[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rateSetId, opts.rateSets])
  const principal = summary.afterDown // ยอดต้น = ยอดหลังหักดาวน์
  const rateMult = multiplierFor(rateSet, rateTerm)
  const rateFinance = rateMult != null ? financeFromPrincipal(principal, rateMult) : 0
  const rateMonthly = rateMult != null ? monthlyFrom(rateFinance, rateTerm) : 0

  // เติมค่าที่คิดได้ลงช่อง (ยังแก้มือต่อได้)
  function applyRate() {
    if (rateMult == null) return
    setF((prev) => ({
      ...prev,
      financeAmount: String(rateFinance),
      monthlyPayment: String(rateMonthly),
      termMonths: String(rateTerm),
    }))
  }

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

  async function handleSave() {
    if (!f.contractNo || !f.customerName || !shop) {
      alert('กรุณากรอก เลขที่สัญญา / ชื่อลูกค้า / ร้านค้า ก่อนนะคะ')
      return
    }
    setSaving(true)
    try {
      // กันเลขสัญญาซ้ำ — เตือนก่อนบันทึก
      const dup = await contractNoExists(f.contractNo, isEdit ? id : undefined)
      if (dup && !window.confirm(`⚠️ เลขที่สัญญา "${f.contractNo}" นี้มีอยู่แล้วในระบบ\nต้องการบันทึกซ้ำหรือไม่?`)) {
        setSaving(false)
        return
      }

      // หารหัสสัญญา (แก้ไข=id เดิม, เพิ่มใหม่=id ที่เพิ่งสร้าง) แล้วบันทึกที่อยู่ที่กรอก
      const saveAddresses = async (contractId: string) => {
        if (!contractId) return
        const keys: AddrKey[] = ['current', 'id_card', 'work']
        await Promise.all(
          keys.filter((k) => !isAddressEmpty(addr[k])).map((k) => saveAddress(contractId, k, addr[k])),
        )
      }

      if (isEdit && id) {
        await updateContract(id, preview)
        await saveAddresses(id)
        alert('แก้ไขสัญญาสำเร็จ ✅')
        if (isSupabaseConfigured) navigate('/customers')
      } else {
        const newId = await insertContract(preview)
        await saveAddresses(newId)
        if (isSupabaseConfigured) {
          alert('บันทึกสัญญาสำเร็จ ✅ ไปที่หน้ารอสรุปยอด/รอส่งอีเมลได้เลย')
          navigate('/waiting-summary') // เด้งไปคิวรอสรุปยอด (เคสจะอยู่ในรอส่งอีเมลด้วย)
        } else {
          alert('ตรวจสอบข้อมูลเรียบร้อย (โหมดตัวอย่าง — ยังไม่บันทึกจริงจนกว่าจะเชื่อม Supabase)')
          setF(initial)
        }
      }
    } catch (e) {
      alert('บันทึกไม่สำเร็จ: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setSaving(false)
    }
  }

  if (loading || loadingContract) {
    return (
      <div>
        <PageTitle>{isEdit ? 'แก้ไขสัญญา' : 'เพิ่มข้อมูลสัญญา'}</PageTitle>
        <Loading />
      </div>
    )
  }

  return (
    <div>
      <PageTitle sub="กรอกครั้งเดียว ได้ครบ — บันทึกแล้วไปสร้างข้อความสรุปยอด/อีเมลที่หน้าคิวได้เลย">
        {isEdit ? 'แก้ไขสัญญา' : 'เพิ่มข้อมูลสัญญา'}
      </PageTitle>

      <div className="mx-auto grid max-w-3xl gap-5">
        {/* ===== ฟอร์มกรอกข้อมูลสัญญา ===== */}
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
                <Input
                  value={f.contractNo}
                  onChange={(e) => {
                    manualNoRef.current = true
                    set('contractNo', e.target.value)
                  }}
                  placeholder="S00016PNQ280"
                />
                {!isEdit && (
                  <p className="mt-1 text-xs text-ink-soft">
                    เลือกร้านแล้วระบบจะรันเลขถัดไปให้ — แก้เองได้ (เคสแรกของร้านพิมพ์เอง)
                  </p>
                )}
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

            {/* ตัวช่วยคิดค่างวดจากเรต */}
            {liveRateSets.length > 0 ? (
              <div className="mb-3 rounded-xl border border-peach bg-peach-light/40 p-3">
                <p className="mb-2 text-sm font-semibold text-ink">คิดจากเรต (ตัวคูณต่อจำนวนงวด)</p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="ชุดเรต">
                    <Select value={rateSetId} onChange={(e) => setRateSetId(e.target.value)}>
                      {liveRateSets.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="จำนวนงวด (ตามเรต)">
                    <Select value={String(rateTerm)} onChange={(e) => setRateTerm(Number(e.target.value))}>
                      {rateTerms.map((t) => (
                        <option key={t} value={t}>{t} งวด</option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="text-ink-soft">
                    ยอดต้น {baht(principal)} × {rateMult ?? '—'} ={' '}
                    <b className="text-ink">ยอด {baht(rateFinance)} ฿</b> · งวดละ{' '}
                    <b className="text-salmon-deep">{baht(rateMonthly)} ฿</b>
                  </span>
                  <Button variant="ghost" onClick={applyRate} disabled={rateMult == null}>
                    ใช้เรตนี้
                  </Button>
                </div>
              </div>
            ) : (
              <p className="mb-3 rounded-xl bg-peach-light/40 px-3 py-2 text-sm text-ink-soft">
                ยังไม่ได้ตั้งเรต — ตั้งได้ที่ <b>ตั้งค่า → เรตผ่อน</b> หรือกรอกค่างวดเองด้านล่าง
              </p>
            )}

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
                {!isEdit && myName && (
                  <p className="mt-1 text-xs text-ink-soft">
                    📝 ระบบจะบันทึกผู้บันทึกเป็น <span className="font-semibold text-ink">{myName}</span> โดยอัตโนมัติ (ใช้คิดค่าคอม)
                  </p>
                )}
              </Field>
              <Field label="หมายเหตุ">
                <Input value={f.notes} onChange={(e) => set('notes', e.target.value)} />
              </Field>
            </div>
          </Card>

          <Card>
            <h3 className="mb-1 font-semibold text-ink">ที่อยู่ลูกค้า (สำหรับส่งจดหมาย)</h3>
            <p className="mb-4 text-sm text-ink-soft">
              ไม่บังคับ — กรอกไว้เลยจะได้ไม่ต้องตามเก็บทีหลังตอนส่งจดหมาย
            </p>
            <div className="grid gap-5 lg:grid-cols-3">
              <AddressFields
                title="ที่อยู่ปัจจุบัน"
                value={addr.current}
                onChange={(field, v) => setAddrField('current', field, v)}
              />
              <AddressFields
                title="ที่อยู่ตามบัตรประชาชน"
                value={addr.id_card}
                onChange={(field, v) => setAddrField('id_card', field, v)}
                onCopy={() => copyFromCurrent('id_card')}
              />
              <AddressFields
                title="ที่อยู่ที่ทำงาน"
                value={addr.work}
                onChange={(field, v) => setAddrField('work', field, v)}
                onCopy={() => copyFromCurrent('work')}
              />
            </div>
          </Card>

          <Button onClick={handleSave} disabled={saving} className="self-start">
            <Save size={16} /> {saving ? 'กำลังบันทึก...' : isEdit ? 'บันทึกการแก้ไข' : 'บันทึกสัญญา'}
          </Button>
        </div>
      </div>
    </div>
  )
}
