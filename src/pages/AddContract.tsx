import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Save } from 'lucide-react'
import { Button, Card, Field, Input, Loading, Modal, PageTitle, Select } from '../components/ui'
import { calcSummary } from '../lib/calc'
import { ageRange, baht } from '../lib/format'
import { derivePrefix, nextContractNo } from '../lib/contractNo'
import type { Contract, DeviceCondition, DeviceOrigin } from '../lib/types'
import {
  contractNoExists,
  findContractByInvNo,
  findContractsByNationalId,
  getContract,
  getContractAddresses,
  getContractExtensionIds,
  getInstallments,
  getOptions,
  getRateSets,
  getShopContractNos,
  getShops,
  insertContract,
  regenerateInstallments,
  saveAddress,
  setContractFlags,
  updateContract,
} from '../lib/db'
import {
  computeSchedulePreview,
  regenSafety,
  scheduleRegenFields,
  type SchedulePreviewRow,
} from '../lib/scheduleRegen'
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
  nationalId: string
  phone: string
  phoneAlt1: string
  phoneAlt2: string
  facebookLink: string
  birthYear: string
  occupation: string
  occupationProof: string
  model: string
  storage: string
  color: string
  sn: string
  imei: string
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
  pendingDocuments: boolean
  pendingDocItems: string[]
  hasPhoneBox: boolean
}

type AddrKey = 'current' | 'id_card' | 'work'

const today = new Date().toISOString().slice(0, 10)

/** ดึงวันที่ (1-31) จาก string "YYYY-MM-DD" ตรงๆ — ไม่ผ่าน Date object กันเพี้ยนเรื่อง timezone */
function dayOfMonth(dateStr: string): number {
  const day = Number(dateStr.split('-')[2])
  return day >= 1 && day <= 31 ? day : 1
}

const CASE_ONLINE_DOC_ITEMS: string[] = [
  'ข้อมูลลูกค้า ยื่นเข้าในระบบ',
  'อาชีพ',
  'เฟสบุ๊ค',
  'เบอร์สำรอง',
  'รูปรอบตัวเครื่อง (หน้า-หลัง, ซ้าย-ขวา, บน-ล่าง)',
  'รูปรายละเอียดตัวเครื่อง (หน้าเกี่ยวกับ, เปอร์เซ็นแบต, ตราครุฑ)',
  'เอกสารสัญญา',
  'เอกสารยินยอม',
  'ใบเสร็จ',
  'ลูกค้าลงทะเบียนไลน์',
  'วีดีโอเทสล็อก',
  'รูปรับเครื่องจบเคส',
]

const initial: FormState = {
  transactionDate: today,
  shopId: '',
  contractNo: '',
  invNo: '',
  customerName: '',
  nationalId: '',
  phone: '',
  phoneAlt1: '',
  phoneAlt2: '',
  facebookLink: '',
  birthYear: '',
  occupation: '',
  occupationProof: '',
  model: '',
  storage: '',
  color: '',
  sn: '',
  imei: '',
  condition: 'new',
  origin: 'th',
  devicePrice: '',
  downPercent: '30',
  commissionPercent: '12',
  docFee: '100',
  financeAmount: '',
  monthlyPayment: '',
  termMonths: '12',
  dueDay: String(dayOfMonth(today)),
  hasPromotion: false,
  promotion: '',
  promotionDetail: '',
  operator: '',
  notes: '',
  pendingDocuments: false,
  pendingDocItems: [],
  hasPhoneBox: false,
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
    nationalId: c.nationalId ?? '',
    phone: c.phone,
    phoneAlt1: c.phoneAlt1 ?? '',
    phoneAlt2: c.phoneAlt2 ?? '',
    facebookLink: c.facebookLink ?? '',
    birthYear: str(c.birthYear),
    occupation: c.occupation ?? '',
    occupationProof: c.occupationProof ?? '',
    model: c.model,
    storage: c.storage,
    color: c.color ?? '',
    sn: c.sn,
    imei: c.imei ?? '',
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
    pendingDocuments: c.pendingDocuments ?? false,
    pendingDocItems: Array.isArray(c.pendingDocItems) ? c.pendingDocItems : [],
    hasPhoneBox: c.hasPhoneBox ?? false,
  }
}


export default function AddContract() {
  const { id } = useParams()
  const isEdit = Boolean(id)
  const navigate = useNavigate()
  const { name: myName, role, configured } = useAuth()
  const isStaff = configured && role === 'staff'

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
  // edit mode + real auth + non-admin → lock Case Online toggle & checklist (admin-only)
  // ยกเว้น: ถ้าสัญญาอยู่สถานะรอเอกสาร (pendingDocuments=true) ให้ staff แก้เช็กลิสต์ได้
  const lockCaseOnline = isEdit && configured && role !== 'admin' && !f.pendingDocuments
  const [saving, setSaving] = useState(false)
  const [loadingContract, setLoadingContract] = useState(isEdit)
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({})
  const [confirmed, setConfirmed] = useState(false) // ยืนยันแล้ว (emailSentAt && summarySentAt)
  const [dupWarning, setDupWarning] = useState(false) // เลขสัญญาซ้ำ (ตรวจสดจาก DB)
  const [dupCustomers, setDupCustomers] = useState<{ contractNo: string }[]>([]) // ลูกค้าบัตรนี้มีสัญญาแล้ว (เตือนนุ่ม)
  const manualNoRef = useRef(false) // true = พนักงานพิมพ์เลขสัญญาเอง (ห้ามระบบทับ)
  const shopChangedRef = useRef(false) // true = เปลี่ยนร้านระหว่างแก้ไข (ต้องบังคับ prefix ใหม่)
  const dueDayTouchedRef = useRef(false) // true = พนักงานแก้ "วันครบกำหนด" เอง (เฉพาะโหมดเพิ่มใหม่ — ห้ามให้วันที่ทำรายการทับค่านี้อีก)
  const origDocsRef = useRef<{ pendingDocuments: boolean; pendingDocItems: string[] }>({
    pendingDocuments: false,
    pendingDocItems: [],
  })
  // snapshot 4 fields ที่กำหนดตารางงวด (โหลดจาก DB ตอน edit mode)
  const origScheduleRef = useRef<{
    transactionDate: string
    dueDay: number
    termMonths: number
    monthlyPayment: number
  } | null>(null)

  // state สำหรับ modal ยืนยันสร้างตารางงวดใหม่ (safe)
  const [regenConfirm, setRegenConfirm] = useState<{
    preview: SchedulePreviewRow[]
    pendingPayload: Parameters<typeof updateContract>[1]
  } | null>(null)
  // state สำหรับ modal แจ้งเหตุผลที่ทำไม่ได้ (blocked)
  const [regenBlocked, setRegenBlocked] = useState<string | null>(null)
  // state สำหรับ modal แจ้ง error บันทึกไม่สำเร็จ
  const [saveError, setSaveError] = useState<string | null>(null)
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setF((prev) => ({ ...prev, [key]: value }))
    if (errors[key]) setErrors((prev) => { const next = { ...prev }; delete next[key]; return next })
  }

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
        if (c) {
          setF(fromContract(c))
          setConfirmed(Boolean(c.emailSentAt && c.summarySentAt))
          origDocsRef.current = {
            pendingDocuments: c.pendingDocuments ?? false,
            pendingDocItems: Array.isArray(c.pendingDocItems) ? c.pendingDocItems : [],
          }
          // snapshot 4 fields ที่กำหนดตารางงวด
          origScheduleRef.current = {
            transactionDate: c.transactionDate,
            dueDay: c.dueDay,
            termMonths: c.termMonths,
            monthlyPayment: c.monthlyPayment,
          }
        }
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
    const shopCode = opts.shops.find((s) => s.id === f.shopId)?.code ?? ''
    let cancelled = false
    getShopContractNos(f.shopId)
      .then((nos) => {
        if (cancelled) return
        const next = nextContractNo(shopCode, nos)
        setF((prev) => {
          if (manualNoRef.current && prev.contractNo) return prev // พนักงานพิมพ์เองแล้ว
          return { ...prev, contractNo: next ?? '' }
        })
      })
      .catch(() => {}) // ดึงไม่ได้ก็ปล่อยให้พิมพ์เอง
    return () => {
      cancelled = true
    }
  }, [f.shopId, isEdit, opts.shops])

  // ตรวจเลขสัญญาซ้ำสด — แสดง warning ใต้ช่องเลขสัญญา
  useEffect(() => {
    if (!f.contractNo) { setDupWarning(false); return }
    let cancelled = false
    contractNoExists(f.contractNo, isEdit ? id : undefined)
      .then((dup) => { if (!cancelled) setDupWarning(dup) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [f.contractNo, isEdit, id])

  const currentYear = new Date().getFullYear()

  const summary = useMemo(
    () => calcSummary(num(f.devicePrice), num(f.downPercent), num(f.commissionPercent), num(f.docFee)),
    [f.devicePrice, f.downPercent, f.commissionPercent, f.docFee],
  )

  // ===== ตัวช่วยคิดค่างวดจากเรต (ตัวคูณต่อจำนวนงวด) =====
  // โหมดกรอกการเงิน: 'manual' = พิมพ์เลขเอง (ค่าเริ่มต้น เหมาะกับข้อมูลเก่า) / 'rate' = คำนวณจากเรต
  const [financeMode, setFinanceMode] = useState<'manual' | 'rate'>('manual')
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

  // เคสใหม่: auto-fill ผู้ดำเนินการ = ชื่อผู้ที่ล็อกอิน (พนักงานไม่ต้องพิมพ์เอง)
  // เคสแก้ไข: คง operator เดิมไว้ (audit trail — ไม่ใช่ "ใครเป็นคนกดล่าสุด")
  useEffect(() => {
    if (!isEdit && myName) setF((prev) => ({ ...prev, operator: myName }))
  }, [isEdit, myName])

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
    imei: f.imei || undefined,
    customerName: f.customerName || '—',
    nationalId: f.nationalId || undefined,
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
    color: f.color || undefined,
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
    pendingDocuments: f.pendingDocuments,
    pendingDocItems: f.pendingDocuments ? f.pendingDocItems : [],
    hasPhoneBox: f.hasPhoneBox,
  }

  // ---- helper: บันทึก edit (ไม่ regen) ----
  async function doEditSave(
    contractId: string,
    payload: Parameters<typeof updateContract>[1],
    saveAddresses: (cid: string) => Promise<void>,
  ) {
    await updateContract(contractId, payload)
    // ตรวจว่า pendingDocuments หรือ pendingDocItems เปลี่ยนจากค่าที่โหลดมาไหม
    const origPD = origDocsRef.current.pendingDocuments
    const origPI = origDocsRef.current.pendingDocItems
    const newPD = f.pendingDocuments
    const newPI = f.pendingDocuments ? f.pendingDocItems : []
    const pdChanged = newPD !== origPD
    const piChanged = newPI.length !== origPI.length || newPI.some((x) => !origPI.includes(x))
    if (pdChanged || piChanged) {
      await setContractFlags(contractId, { pendingDocuments: newPD, pendingDocItems: newPI })
    }
    await saveAddresses(contractId)
    alert('แก้ไขสัญญาสำเร็จ')
    if (isSupabaseConfigured) navigate('/customers')
  }

  // ---- handler: ผู้ใช้กดยืนยันสร้างตารางงวดใหม่ ----
  async function handleRegenConfirm() {
    if (!regenConfirm || !id) return
    setSaving(true)
    setRegenConfirm(null)
    try {
      const saveAddresses = async (contractId: string) => {
        const keys: AddrKey[] = ['current', 'id_card', 'work']
        await Promise.all(
          keys.filter((k) => !isAddressEmpty(addr[k])).map((k) => saveAddress(contractId, k, addr[k])),
        )
      }
      await updateContract(id, regenConfirm.pendingPayload)
      await regenerateInstallments(id)
      // update origScheduleRef ให้ตรงกับค่าใหม่ (กันกด Save ซ้ำ)
      origScheduleRef.current = {
        transactionDate: regenConfirm.pendingPayload.transactionDate,
        dueDay: regenConfirm.pendingPayload.dueDay,
        termMonths: regenConfirm.pendingPayload.termMonths,
        monthlyPayment: regenConfirm.pendingPayload.monthlyPayment,
      }
      // บันทึก flags + ที่อยู่
      const origPD = origDocsRef.current.pendingDocuments
      const origPI = origDocsRef.current.pendingDocItems
      const newPD = f.pendingDocuments
      const newPI = f.pendingDocuments ? f.pendingDocItems : []
      const pdChanged = newPD !== origPD
      const piChanged = newPI.length !== origPI.length || newPI.some((x) => !origPI.includes(x))
      if (pdChanged || piChanged) {
        await setContractFlags(id, { pendingDocuments: newPD, pendingDocItems: newPI })
      }
      await saveAddresses(id)
      alert('แก้ไขสัญญาสำเร็จ และสร้างตารางงวดใหม่แล้ว')
      if (isSupabaseConfigured) navigate('/customers')
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      const friendlyMsg =
        raw.includes('blocked_paid')
          ? 'ไม่สามารถแก้ไขตารางงวดได้ เนื่องจากสัญญานี้มีการบันทึกชำระเงินแล้ว'
          : raw.includes('blocked_extended')
          ? 'ไม่สามารถแก้ไขตารางงวดได้ เนื่องจากสัญญานี้มีการขยายระยะเวลาแล้ว'
          : `บันทึกไม่สำเร็จ: ${raw}`
      setSaveError(friendlyMsg)
    } finally {
      setSaving(false)
    }
  }

  // ---- handler: ผู้ใช้กดยกเลิก (ไม่สร้างตารางใหม่) → ย้อน 4 field แล้วยกเลิก save ทั้งหมด ----
  function handleRegenCancel() {
    setRegenConfirm(null)
    if (origScheduleRef.current) {
      const orig = origScheduleRef.current
      setF((prev) => ({
        ...prev,
        transactionDate: orig.transactionDate,
        dueDay: String(orig.dueDay),
        termMonths: String(orig.termMonths),
        monthlyPayment: String(orig.monthlyPayment),
      }))
    }
  }

  async function handleSave() {
    const newErrors: Partial<Record<keyof FormState, string>> = {}

    // create = สัญญาใหม่ ต้องบังคับกรอกครบทุกช่อง / edit = สัญญาเก่า (เช่นนำเข้าจาก PJ) มีช่องว่างจริง ห้ามบังคับ backfill — ใช้ validation ขั้นต่ำเดิม
    if (!isEdit) {
      // ===== ส่วน 1: ข้อมูลรายการ =====
      if (!f.transactionDate) newErrors.transactionDate = 'กรุณาเลือกวันที่ทำรายการ'
      if (!f.shopId) newErrors.shopId = 'กรุณาเลือกร้านค้า'
      if (!f.contractNo) newErrors.contractNo = 'กรุณากรอกเลขที่สัญญา'
      if (!f.invNo) newErrors.invNo = 'กรุณากรอกเลข INV'

      // ===== ส่วน 2: ข้อมูลลูกค้า =====
      if (!f.customerName) newErrors.customerName = 'กรุณากรอกชื่อลูกค้า'
      if (!f.nationalId) newErrors.nationalId = 'กรุณากรอกเลขบัตรประชาชน'
      if (!f.phone) newErrors.phone = 'กรุณากรอกเบอร์โทรลูกค้า'
      if (!f.phoneAlt1) newErrors.phoneAlt1 = 'กรุณากรอกเบอร์โทรศัพท์สำรอง 1'
      if (!f.phoneAlt2) newErrors.phoneAlt2 = 'กรุณากรอกเบอร์โทรศัพท์สำรอง 2'
      if (!f.facebookLink) newErrors.facebookLink = 'กรุณากรอกลิงค์เฟสลูกค้า'
      if (!f.birthYear) newErrors.birthYear = 'กรุณากรอกปีเกิด'
      if (!f.occupation) newErrors.occupation = 'กรุณาเลือกอาชีพ'
      if (!f.occupationProof) newErrors.occupationProof = 'กรุณาเลือกหลักฐานอาชีพ'

      // ===== ส่วน 3: ข้อมูลเครื่อง =====
      if (!f.model) newErrors.model = 'กรุณาเลือกรุ่น'
      if (!f.storage) newErrors.storage = 'กรุณาเลือกความจำ'
      if (!f.color) newErrors.color = 'กรุณากรอกสี'
      if (!f.sn) newErrors.sn = 'กรุณากรอกหมายเลข SN'
      if (!f.imei) newErrors.imei = 'กรุณากรอกหมายเลข IMEI'
      if (!f.devicePrice || num(f.devicePrice) <= 0) newErrors.devicePrice = 'กรุณากรอกราคาตัวเครื่อง'

      // ===== ส่วน 4: การซื้อเครื่อง (สรุปยอดโอน) =====
      if (!f.downPercent) newErrors.downPercent = 'กรุณากรอก % ดาวน์'
      if (!f.commissionPercent) newErrors.commissionPercent = 'กรุณากรอก % คอมมิชชั่น'
      if (!f.docFee) newErrors.docFee = 'กรุณากรอกค่าเอกสาร'

      // ===== ส่วน 5: การผ่อน =====
      // โหมด "กรอกเลขเอง" → บังคับกรอกเอง / โหมด "คำนวณจากเรต" → ต้องกดใช้เรต (ระบบเติมให้แล้ว) ก่อนถึงจะบันทึกได้
      if (financeMode === 'manual') {
        if (!f.financeAmount || num(f.financeAmount) <= 0) newErrors.financeAmount = 'กรุณากรอกยอดจัดไฟแนนซ์'
        if (!f.monthlyPayment || num(f.monthlyPayment) <= 0) newErrors.monthlyPayment = 'กรุณากรอกค่าเช่าต่อเดือน'
        if (!f.termMonths || num(f.termMonths) <= 0) newErrors.termMonths = 'กรุณากรอกจำนวนเดือน'
      } else if (liveRateSets.length === 0) {
        if (!f.financeAmount || num(f.financeAmount) <= 0 || !f.monthlyPayment || num(f.monthlyPayment) <= 0) {
          newErrors.financeAmount = 'ยังไม่ได้ตั้งเรต — กรุณาสลับเป็น "กรอกเลขเอง"'
        }
      } else {
        if (!f.financeAmount || num(f.financeAmount) <= 0 || !f.monthlyPayment || num(f.monthlyPayment) <= 0) {
          newErrors.financeAmount = 'กรุณากดปุ่ม "ใช้เรตนี้" เพื่อคำนวณยอดก่อนบันทึก'
        }
      }
      if (!f.dueDay) newErrors.dueDay = 'กรุณากรอกวันที่ชำระ'

      // โปรโมชั่น — บังคับรายละเอียดเฉพาะตอนเลือก "มีโปร"
      if (f.hasPromotion && !f.promotion) newErrors.promotion = 'กรุณาเลือกรายละเอียดโปร'
    } else {
      // โหมดแก้ไข — validation ขั้นต่ำเดิม (ก่อนงานบังคับครบทุกช่อง) กันบล็อกพนักงานแก้สัญญาเก่าที่มีช่องว่างมาแต่เดิม
      if (!f.contractNo) newErrors.contractNo = 'กรุณากรอกเลขที่สัญญา'
      if (!f.customerName) newErrors.customerName = 'กรุณากรอกชื่อลูกค้า'
      if (!f.shopId) newErrors.shopId = 'กรุณาเลือกร้านค้า'
      if (!f.invNo) newErrors.invNo = 'กรุณากรอกเลข INV'
      if (!f.devicePrice || num(f.devicePrice) <= 0) newErrors.devicePrice = 'กรุณากรอกราคาตัวเครื่อง'
    }

    // ตรวจ prefix — บังคับเฉพาะ: เพิ่มใหม่ หรือ แก้ไขและเปลี่ยนร้าน
    if (!isEdit || shopChangedRef.current) {
      const shopCode = opts.shops.find((s) => s.id === f.shopId)?.code ?? ''
      const p = derivePrefix(shopCode)
      if (p && f.contractNo && !f.contractNo.startsWith(p.prefix)) {
        newErrors.contractNo = `เลขสัญญาต้องขึ้นต้นด้วย "${p.prefix}" (ร้านนี้)`
      }
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      window.scrollTo({ top: 0, behavior: 'smooth' })
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
        // ===== ตรวจ schedule regen =====
        const orig = origScheduleRef.current
        if (orig) {
          // สร้าง Contract object จาก orig snapshot เพื่อป้อน scheduleRegenFields
          const origContract = {
            transactionDate: orig.transactionDate,
            dueDay: orig.dueDay,
            termMonths: orig.termMonths,
            monthlyPayment: orig.monthlyPayment,
          } as Parameters<typeof scheduleRegenFields>[0]

          const needRegen = scheduleRegenFields(origContract, preview)
          if (needRegen) {
            setSaving(false)
            // ดึง installments + extensions ขนาน
            const [installments, extensions] = await Promise.all([
              getInstallments(id),
              getContractExtensionIds(id),
            ])
            const safety = regenSafety(installments, extensions)

            if (safety.status !== 'safe') {
              // blocked — แจ้งสาเหตุ แล้วย้อน 4 field กลับค่าเดิม
              setF((prev) => ({
                ...prev,
                transactionDate: orig.transactionDate,
                dueDay: String(orig.dueDay),
                termMonths: String(orig.termMonths),
                monthlyPayment: String(orig.monthlyPayment),
              }))
              setRegenBlocked(safety.reason)
              return
            }

            // safe — คำนวณ preview แล้วเปิด confirm modal
            const schedPreview = computeSchedulePreview(
              preview.transactionDate,
              preview.dueDay,
              preview.termMonths,
              preview.monthlyPayment,
            )
            setRegenConfirm({ preview: schedPreview, pendingPayload: preview })
            return
          }
        }

        // ไม่ต้อง regen — save ปกติ
        await doEditSave(id, preview, saveAddresses)
        return
      } else {
        // ===== ชั้น 1: บล็อกเลขใบ PJ (inv_no) ซ้ำ — สร้างใหม่เท่านั้น =====
        const invDup = await findContractByInvNo(f.invNo)
        if (invDup) {
          setSaveError(
            `เลขใบ PJ "${f.invNo}" นี้มีสัญญาอยู่แล้ว: ${invDup.contractNo} (${invDup.customerName}) — ตรวจสอบก่อนบันทึกซ้ำ`,
          )
          setSaving(false)
          return
        }
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
      const raw = e instanceof Error ? e.message : String(e)
      // เผื่อหลุดถึง insert แล้วชน unique index ของเลขใบ PJ (23505) — แสดงข้อความเดียวกับชั้น 1
      if (raw.includes('23505') && raw.toLowerCase().includes('inv')) {
        setSaveError(`เลขใบ PJ "${f.invNo}" นี้มีสัญญาอยู่แล้ว — ตรวจสอบก่อนบันทึกซ้ำ`)
      } else {
        alert('บันทึกไม่สำเร็จ: ' + raw)
      }
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

  // staff แก้ไม่ได้เมื่อยืนยันแล้ว (emailSentAt && summarySentAt) — admin ผ่านได้เสมอ
  if (isEdit && isStaff && confirmed) {
    return (
      <div>
        <PageTitle>{isEdit ? 'แก้ไขสัญญา' : 'เพิ่มข้อมูลสัญญา'}</PageTitle>
        <Card>
          <p className="text-sm text-ink">สัญญานี้ยืนยันแล้ว — แก้ไม่ได้ (ติดต่อแอดมิน)</p>
        </Card>
      </div>
    )
  }

  return (
    <div>
      <PageTitle sub="กรอกครั้งเดียว ได้ครบ — บันทึกแล้วไปสร้างข้อความสรุปยอด/อีเมลที่หน้าคิวได้เลย">
        {isEdit ? 'แก้ไขสัญญา' : 'เพิ่มข้อมูลสัญญา'}
      </PageTitle>

      <div className="mx-auto grid max-w-3xl gap-5">
        {/* ===== สรุปช่องที่ยังกรอกไม่ครบ ===== */}
        {Object.keys(errors).length > 0 && (
          <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3">
            <p className="mb-1.5 text-sm font-semibold text-red-700">
              กรุณากรอกให้ครบ {Object.keys(errors).length} ช่อง:
            </p>
            <ul className="list-inside list-disc text-xs text-red-600">
              {Object.values(errors).map((msg, i) => (
                <li key={i}>{msg}</li>
              ))}
            </ul>
          </div>
        )}
        {/* ===== ฟอร์มกรอกข้อมูลสัญญา ===== */}
        <div className="flex flex-col gap-5">
          <Card>
            <h3 className="mb-3 font-semibold text-ink">ข้อมูลรายการ</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="วันที่ทำรายการ" required>
                <Input
                  type="date"
                  value={f.transactionDate}
                  onChange={(e) => {
                    const newDate = e.target.value
                    set('transactionDate', newDate)
                    // เพิ่มสัญญาใหม่: วันครบกำหนดตามวันที่ทำรายการอัตโนมัติ — เว้นพนักงานแก้วันครบกำหนดเองแล้ว
                    if (!isEdit && !dueDayTouchedRef.current && newDate) {
                      set('dueDay', String(dayOfMonth(newDate)))
                    }
                  }}
                />
                {errors.transactionDate && <p className="mt-1 text-xs text-red-600">{errors.transactionDate}</p>}
              </Field>
              <Field label="ชื่อร้านค้า" required>
                <Select
                  value={f.shopId}
                  onChange={(e) => {
                    const newShopId = e.target.value
                    set('shopId', newShopId)
                    if (isEdit) {
                      shopChangedRef.current = true
                      // รันเลขถัดไปของร้านใหม่ (อัตโนมัติ)
                      const shopCode = opts.shops.find((s) => s.id === newShopId)?.code ?? ''
                      getShopContractNos(newShopId)
                        .then((nos) => {
                          const next = nextContractNo(shopCode, nos)
                          if (next) {
                            manualNoRef.current = false
                            setF((prev) => ({ ...prev, contractNo: next }))
                          }
                        })
                        .catch(() => {})
                    }
                  }}
                >
                  {opts.shops.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} {s.name}
                    </option>
                  ))}
                </Select>
                {errors.shopId && <p className="mt-1 text-xs text-red-600">{errors.shopId}</p>}
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
                {isEdit && (
                  <p className="mt-1 text-xs text-ink-soft">
                    เปลี่ยนร้านค้า → ระบบจะรันเลขถัดไปของร้านใหม่ให้อัตโนมัติ
                  </p>
                )}
                {dupWarning && (
                  <p className="mt-1 text-xs font-semibold text-red-600">⚠️ เลขซ้ำ — มีสัญญาเลขนี้อยู่แล้วในระบบ</p>
                )}
                {errors.contractNo && <p className="mt-1 text-xs text-red-600">{errors.contractNo}</p>}
              </Field>
              <Field label="เลข INV" required>
                <Input value={f.invNo} onChange={(e) => set('invNo', e.target.value)} placeholder="INV-..." />
                {errors.invNo && <p className="mt-1 text-xs text-red-600">{errors.invNo}</p>}
              </Field>
            </div>
            {/* Case Online — โหมดเพิ่มใหม่: ใครก็ติ๊กได้ / โหมดแก้ไข: admin only */}
            <div className="mt-3">
              <label
                className={`flex items-center gap-2 text-sm ${lockCaseOnline ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
              >
                <input
                  type="checkbox"
                  checked={f.pendingDocuments}
                  onChange={(e) => {
                    const on = e.target.checked
                    set('pendingDocuments', on)
                    // เปิด Case Online ใหม่: seed ทุกรายการเป็น "ยังไม่ได้รับ" (= อยู่ใน pending)
                    // ใช้ length === 0 กันทับค่าที่โหลดมาในโหมดแก้ไข
                    if (on && f.pendingDocItems.length === 0) {
                      set('pendingDocItems', [...CASE_ONLINE_DOC_ITEMS])
                    }
                  }}
                  disabled={lockCaseOnline}
                  className="h-4 w-4 accent-amber-500"
                />
                <span className="font-medium text-ink">เป็น Case Online (รอเอกสาร)</span>
                {isEdit && lockCaseOnline && (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-ink-soft">
                    admin เท่านั้น
                  </span>
                )}
              </label>
              <p className="ml-6 mt-0.5 text-xs text-ink-soft">
                เคสออนไลน์ที่ยังรอเอกสาร — จะมีแจ้งเตือนก่อนส่งเมล/สรุปยอด
              </p>

              {/* Checklist รายการเอกสาร — โผล่เมื่อติ๊ก Case Online */}
              {f.pendingDocuments && (
                <div className="ml-6 mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
                  <p className="mb-2 text-xs font-semibold text-amber-800">
                    ติ๊กรายการที่ได้รับแล้ว (ที่เหลือ = ยังรออยู่):
                  </p>
                  <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                    {CASE_ONLINE_DOC_ITEMS.map((item) => {
                      const inPending = f.pendingDocItems.includes(item)
                      return (
                        <label
                          key={item}
                          className={`flex items-start gap-2 text-xs ${lockCaseOnline ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                        >
                          <input
                            type="checkbox"
                            checked={!inPending}
                            disabled={lockCaseOnline}
                            onChange={() => {
                              const next = inPending
                                ? f.pendingDocItems.filter((x) => x !== item)
                                : CASE_ONLINE_DOC_ITEMS.filter(
                                    (x) => f.pendingDocItems.includes(x) || x === item,
                                  )
                              set('pendingDocItems', next)
                            }}
                            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-amber-500"
                          />
                          <span className="leading-snug text-amber-900">{item}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* กล่องเครื่อง — เฉพาะโหมดเพิ่มใหม่ (ระบบติดตามรับกล่องหลังสร้างสัญญา) */}
            {!isEdit && (
              <div className="mt-2">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={f.hasPhoneBox}
                    onChange={(e) => set('hasPhoneBox', e.target.checked)}
                    className="h-4 w-4 accent-amber-500"
                  />
                  <span className="font-medium text-ink">มีกล่องเครื่อง</span>
                  {f.condition === 'new' && (
                    <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-semibold text-red-700">
                      มือหนึ่ง: ต้องมีกล่อง
                    </span>
                  )}
                </label>
                <p className="ml-6 mt-0.5 text-xs text-ink-soft">
                  ร้านแจ้งว่าจะส่งกล่องโทรศัพท์คืนมาด้วย — ระบบจะติดตามการรับกล่อง
                </p>
              </div>
            )}
          </Card>

          <Card>
            <h3 className="mb-3 font-semibold text-ink">ข้อมูลลูกค้า</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="ชื่อลูกค้า" required>
                <Input value={f.customerName} onChange={(e) => set('customerName', e.target.value)} />
                {errors.customerName && <p className="mt-1 text-xs text-red-600">{errors.customerName}</p>}
              </Field>
              <Field label="เลขบัตรประชาชน" required>
                <Input
                  value={f.nationalId}
                  onChange={(e) => {
                    set('nationalId', e.target.value)
                    if (dupCustomers.length) setDupCustomers([])
                  }}
                  onBlur={() => {
                    // เตือนนุ่ม: บัตรนี้มีสัญญาแล้วไหม — เฉพาะตอนสร้างใหม่ + กรอกครบพอ
                    if (isEdit) return
                    const norm = f.nationalId.trim()
                    if (norm.length < 13) { setDupCustomers([]); return }
                    findContractsByNationalId(norm)
                      .then((rows) => setDupCustomers(rows.map((r) => ({ contractNo: r.contractNo }))))
                      .catch(() => {})
                  }}
                  placeholder="เลขบัตร 13 หลัก"
                />
                {!isEdit && dupCustomers.length > 0 && (
                  <p className="mt-1 text-xs text-amber-700">
                    ⚠️ ลูกค้าบัตรนี้มีสัญญาแล้ว: {dupCustomers.map((d) => d.contractNo).join(', ')} — ตรวจสอบก่อนบันทึก (ผ่อนเครื่อง 2 ได้)
                  </p>
                )}
                {errors.nationalId && <p className="mt-1 text-xs text-red-600">{errors.nationalId}</p>}
              </Field>
              <Field label="เบอร์โทรลูกค้า" required>
                <Input value={f.phone} onChange={(e) => set('phone', e.target.value)} />
                {errors.phone && <p className="mt-1 text-xs text-red-600">{errors.phone}</p>}
              </Field>
              <Field label="โทรศัพท์สำรอง 1" required>
                <Input value={f.phoneAlt1} onChange={(e) => set('phoneAlt1', e.target.value)} />
                {errors.phoneAlt1 && <p className="mt-1 text-xs text-red-600">{errors.phoneAlt1}</p>}
              </Field>
              <Field label="โทรศัพท์สำรอง 2" required>
                <Input value={f.phoneAlt2} onChange={(e) => set('phoneAlt2', e.target.value)} />
                {errors.phoneAlt2 && <p className="mt-1 text-xs text-red-600">{errors.phoneAlt2}</p>}
              </Field>
              <Field label="ลิงค์เฟสลูกค้า" required>
                <Input value={f.facebookLink} onChange={(e) => set('facebookLink', e.target.value)} />
                {errors.facebookLink && <p className="mt-1 text-xs text-red-600">{errors.facebookLink}</p>}
              </Field>
              <Field label={`ปีเกิด (ค.ศ.)  ›  อายุ ${ageRange(num(f.birthYear) || undefined, currentYear)}`} required>
                <Input
                  type="number"
                  value={f.birthYear}
                  onChange={(e) => set('birthYear', e.target.value)}
                  placeholder="1998"
                />
                {errors.birthYear && <p className="mt-1 text-xs text-red-600">{errors.birthYear}</p>}
              </Field>
              <Field label="อาชีพ" required>
                <Select value={f.occupation} onChange={(e) => set('occupation', e.target.value)}>
                  {opts.occupations.map((o) => (
                    <option key={o.id} value={o.label}>{o.label}</option>
                  ))}
                </Select>
                {errors.occupation && <p className="mt-1 text-xs text-red-600">{errors.occupation}</p>}
              </Field>
              <Field label="หลักฐานอาชีพ" required>
                <Select value={f.occupationProof} onChange={(e) => set('occupationProof', e.target.value)}>
                  {opts.proofs.map((o) => (
                    <option key={o.id} value={o.label}>{o.label}</option>
                  ))}
                </Select>
                {errors.occupationProof && <p className="mt-1 text-xs text-red-600">{errors.occupationProof}</p>}
              </Field>
            </div>
          </Card>

          <Card>
            <h3 className="mb-3 font-semibold text-ink">ข้อมูลเครื่อง</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="รุ่น" required>
                <Select value={f.model} onChange={(e) => set('model', e.target.value)}>
                  {opts.models.map((o) => (
                    <option key={o.id} value={o.label}>{o.label}</option>
                  ))}
                </Select>
                {errors.model && <p className="mt-1 text-xs text-red-600">{errors.model}</p>}
              </Field>
              <Field label="ความจำ" required>
                <Select value={f.storage} onChange={(e) => set('storage', e.target.value)}>
                  {opts.storages.map((o) => (
                    <option key={o.id} value={o.label}>{o.label}</option>
                  ))}
                </Select>
                {errors.storage && <p className="mt-1 text-xs text-red-600">{errors.storage}</p>}
              </Field>
              <Field label="สี" required>
                <Input
                  value={f.color}
                  onChange={(e) => set('color', e.target.value)}
                  placeholder="เช่น Black, Blue, Natural Titanium"
                />
                {errors.color && <p className="mt-1 text-xs text-red-600">{errors.color}</p>}
              </Field>
              <Field label="หมายเลข SN" required>
                <Input value={f.sn} onChange={(e) => set('sn', e.target.value)} />
                {errors.sn && <p className="mt-1 text-xs text-red-600">{errors.sn}</p>}
              </Field>
              <Field label="หมายเลข IMEI" required>
                <Input value={f.imei} onChange={(e) => set('imei', e.target.value)} placeholder="เลข IMEI 15 หลัก" />
                {errors.imei && <p className="mt-1 text-xs text-red-600">{errors.imei}</p>}
              </Field>
              <Field label="ราคาตัวเครื่อง (บาท)" required>
                <Input type="number" value={f.devicePrice} onChange={(e) => set('devicePrice', e.target.value)} placeholder="19900" />
                {errors.devicePrice && <p className="mt-1 text-xs text-red-600">{errors.devicePrice}</p>}
              </Field>
              <Field label="สภาพสินค้า" required>
                <Select value={f.condition} onChange={(e) => set('condition', e.target.value as DeviceCondition)}>
                  <option value="new">มือ 1</option>
                  <option value="used">มือ 2</option>
                </Select>
              </Field>
              <Field label="แหล่งเครื่อง" required>
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
              <Field label="% ดาวน์" required>
                <Input type="number" value={f.downPercent} onChange={(e) => set('downPercent', e.target.value)} />
                {errors.downPercent && <p className="mt-1 text-xs text-red-600">{errors.downPercent}</p>}
              </Field>
              <Field label="% คอมมิชชั่น" required>
                <Input type="number" value={f.commissionPercent} onChange={(e) => set('commissionPercent', e.target.value)} />
                {errors.commissionPercent && <p className="mt-1 text-xs text-red-600">{errors.commissionPercent}</p>}
              </Field>
              <Field label="ค่าเอกสาร (หักออก)" required>
                <Input type="number" value={f.docFee} onChange={(e) => set('docFee', e.target.value)} />
                {errors.docFee && <p className="mt-1 text-xs text-red-600">{errors.docFee}</p>}
              </Field>
            </div>
            {/* แสดงผลคำนวณสด */}
            <div className="mt-3 grid grid-cols-2 gap-3 rounded-xl bg-white p-3 text-sm sm:grid-cols-4">
              <div>
                <p className="text-ink-soft">ยอดเงินดาวน์</p>
                <p className="font-semibold text-ink whitespace-nowrap">
                  {num(f.devicePrice) && num(f.downPercent)
                    ? `${baht(Math.round(num(f.devicePrice) * num(f.downPercent) / 100))} ฿`
                    : '—'}
                </p>
              </div>
              <div>
                <p className="text-ink-soft">หลังหักดาวน์</p>
                <p className="font-semibold text-ink whitespace-nowrap">{baht(summary.afterDown)} ฿</p>
              </div>
              <div>
                <p className="text-ink-soft">ค่าคอมมิชชั่น</p>
                <p className="font-semibold text-ink whitespace-nowrap">{baht(summary.commission)} ฿</p>
              </div>
              <div>
                <p className="text-ink-soft">สุทธิ (โอนให้ร้าน)</p>
                <p className="font-bold text-salmon-deep whitespace-nowrap">{baht(summary.net)} ฿</p>
              </div>
            </div>
          </Card>

          <Card>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold text-ink">การเงิน — ผ่อน</h3>
              {/* สลับโหมด: กรอกเลขเอง (ข้อมูลเก่า) / คำนวณจากเรต (สัญญาใหม่) */}
              <div className="inline-flex overflow-hidden rounded-xl border border-peach">
                <button
                  type="button"
                  onClick={() => setFinanceMode('manual')}
                  className={`px-3 py-1.5 text-sm transition ${
                    financeMode === 'manual'
                      ? 'bg-salmon-deep text-white'
                      : 'bg-white text-ink-soft hover:bg-peach-light/40'
                  }`}
                >
                  กรอกเลขเอง
                </button>
                <button
                  type="button"
                  onClick={() => setFinanceMode('rate')}
                  className={`px-3 py-1.5 text-sm transition ${
                    financeMode === 'rate'
                      ? 'bg-salmon-deep text-white'
                      : 'bg-white text-ink-soft hover:bg-peach-light/40'
                  }`}
                >
                  คำนวณจากเรต
                </button>
              </div>
            </div>

            {/* ตัวช่วยคิดค่างวดจากเรต — โชว์เฉพาะตอนเลือกโหมด "คำนวณจากเรต" */}
            {financeMode === 'rate' && liveRateSets.length > 0 ? (
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
                    <b className="text-ink whitespace-nowrap">ยอด {baht(rateFinance)} ฿</b> · งวดละ{' '}
                    <b className="text-salmon-deep whitespace-nowrap">{baht(rateMonthly)} ฿</b>
                  </span>
                  <Button variant="ghost" onClick={applyRate} disabled={rateMult == null}>
                    ใช้เรตนี้
                  </Button>
                </div>
              </div>
            ) : financeMode === 'rate' ? (
              <p className="mb-3 rounded-xl bg-peach-light/40 px-3 py-2 text-sm text-ink-soft">
                ยังไม่ได้ตั้งเรต — ตั้งได้ที่ <b>ตั้งค่า → เรตผ่อน</b> หรือสลับเป็น "กรอกเลขเอง" ก็ได้ค่ะ
              </p>
            ) : null}

            {/* โหมดเรต = ช่อง 3 ตัวที่คำนวณจากเรต ล็อกเป็น read-only (สีเทา) — ป้องกันกดผิด ส่วน "ชำระทุกวันที่" ยังกรอกได้เสมอ */}
            {(() => {
              const lock = financeMode === 'rate'
              const lockCls = lock ? 'bg-slate-100 text-ink-soft cursor-not-allowed' : ''
              return (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="ยอดจัดไฟแนนซ์" required>
                    <Input
                      type="number"
                      value={f.financeAmount}
                      onChange={(e) => set('financeAmount', e.target.value)}
                      disabled={lock}
                      readOnly={lock}
                      className={lockCls}
                    />
                    {errors.financeAmount && <p className="mt-1 text-xs text-red-600">{errors.financeAmount}</p>}
                  </Field>
                  <Field label="ค่าเช่าต่อเดือน" required>
                    <Input
                      type="number"
                      value={f.monthlyPayment}
                      onChange={(e) => set('monthlyPayment', e.target.value)}
                      disabled={lock}
                      readOnly={lock}
                      className={lockCls}
                    />
                    {errors.monthlyPayment && <p className="mt-1 text-xs text-red-600">{errors.monthlyPayment}</p>}
                  </Field>
                  <Field label="จำนวนเดือน" required>
                    <Input
                      type="number"
                      value={f.termMonths}
                      onChange={(e) => set('termMonths', e.target.value)}
                      disabled={lock}
                      readOnly={lock}
                      className={lockCls}
                    />
                    {errors.termMonths && <p className="mt-1 text-xs text-red-600">{errors.termMonths}</p>}
                  </Field>
                  <Field label="ชำระทุกวันที่ (1-31)" required>
                    <Input
                      type="number"
                      min={1}
                      max={31}
                      value={f.dueDay}
                      onChange={(e) => {
                        if (!isEdit) dueDayTouchedRef.current = true // พนักงานแก้เอง — กันวันที่ทำรายการทับ
                        set('dueDay', e.target.value)
                      }}
                    />
                    {!isEdit && (
                      <p className="mt-1 text-xs text-ink-soft">
                        ตั้งตามวันที่ทำรายการให้อัตโนมัติ — แก้เองได้ถ้าลูกค้าตกลงวันจ่ายอื่น
                      </p>
                    )}
                    {errors.dueDay && <p className="mt-1 text-xs text-red-600">{errors.dueDay}</p>}
                  </Field>
                </div>
              )
            })()}
          </Card>

          <Card>
            <h3 className="mb-3 font-semibold text-ink">โปรโมชั่น</h3>
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
                <Field label="รายละเอียดโปร" required>
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
                  {errors.promotion && <p className="mt-1 text-xs text-red-600">{errors.promotion}</p>}
                </Field>
              )}
            </div>
          </Card>

          <Card>
            <h3 className="mb-3 font-semibold text-ink">ผู้ดำเนินการ</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label={isEdit ? 'ผู้ดำเนินการ (ค่าเดิมในสัญญา)' : 'ผู้ดำเนินการ (อัตโนมัติจากผู้ที่ล็อกอิน)'}>
                <div className="rounded-xl bg-slate-100 px-3 py-2 text-sm text-ink-soft">
                  {f.operator || myName || '— กรุณาล็อกอินก่อนเพิ่มสัญญา —'}
                </div>
                {!isEdit && (
                  <p className="mt-1 text-xs text-ink-soft">
                    📝 บันทึกอัตโนมัติ ใช้คิดค่าคอมมิชชั่นให้พนักงานคนนี้
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

      {/* ===== Modal: save error ===== */}
      {saveError && (
        <Modal title="บันทึกไม่สำเร็จ" onClose={() => setSaveError(null)}>
          <p className="mb-5 text-sm leading-relaxed text-ink">{saveError}</p>
          <div className="flex justify-end">
            <Button onClick={() => setSaveError(null)}>รับทราบ</Button>
          </div>
        </Modal>
      )}

      {/* ===== Modal: blocked — ทำไม่ได้ ===== */}
      {regenBlocked && (
        <Modal title="ไม่สามารถเปลี่ยนตารางงวดได้" onClose={() => setRegenBlocked(null)}>
          <p className="mb-5 text-sm leading-relaxed text-ink">{regenBlocked}</p>
          <p className="mb-5 text-sm text-ink-soft">
            ข้อมูลอื่นๆ ที่แก้ไว้ (เช่น ชื่อลูกค้า เบอร์โทร) ยังถูกบันทึกตามปกติ
            — เฉพาะฟิลด์วันที่ทำรายการ / วันครบกำหนด / จำนวนงวด / ค่างวดจะถูกคืนกลับค่าเดิม
          </p>
          <div className="flex justify-end">
            <Button onClick={() => setRegenBlocked(null)}>รับทราบ</Button>
          </div>
        </Modal>
      )}

      {/* ===== Modal: safe — ขอยืนยันสร้างตารางงวดใหม่ ===== */}
      {regenConfirm && (() => {
        const rows = regenConfirm.preview
        const first = rows[0]
        const last = rows[rows.length - 1]
        const thaiDateShort = (d: string) => {
          const [y, m, day] = d.split('-')
          const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.']
          return `${Number(day)} ${months[Number(m) - 1]} ${Number(y) + 543}`
        }
        return (
          <Modal title="ยืนยันสร้างตารางงวดใหม่" onClose={handleRegenCancel}>
            <div className="mb-4 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-900">
              <p className="font-semibold mb-1">ระบบจะลบตารางงวดเดิมแล้วสร้างใหม่ทั้งหมด</p>
              <p>จำนวน <span className="font-bold">{rows.length} งวด</span></p>
              {first && <p>งวดแรก: <span className="font-semibold">{thaiDateShort(first.dueDate)}</span></p>}
              {last && rows.length > 1 && (
                <p>งวดสุดท้าย: <span className="font-semibold">{thaiDateShort(last.dueDate)}</span></p>
              )}
              <p className="mt-1 text-xs text-amber-700">ค่างวดละ {regenConfirm.pendingPayload.monthlyPayment.toLocaleString()} บาท</p>
            </div>
            <p className="mb-5 text-sm text-ink-soft">
              การดำเนินการนี้ไม่สามารถยกเลิกได้ — กดยืนยันเพื่อบันทึกการแก้ไขและสร้างตารางงวดใหม่
            </p>
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={handleRegenCancel} disabled={saving}>
                ยกเลิก (ไม่เปลี่ยนตาราง)
              </Button>
              <Button onClick={handleRegenConfirm} disabled={saving}>
                {saving ? 'กำลังบันทึก...' : 'ยืนยัน สร้างตารางงวดใหม่'}
              </Button>
            </div>
          </Modal>
        )
      })()}
    </div>
  )
}
