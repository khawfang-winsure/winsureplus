// ===== แผงข้อมูลสำหรับตรวจก่อนส่งอีเมลบริษัท — pure-function layer =====
// Owner-approved layout: review-panel-mockup.html (owner-approved 2026-09-09)
// Pure function — ไม่มี side effect, ไม่ import db.ts/supabase, testable ด้วย node -e
// ใช้ประกอบรายการช่องให้ ContractMediaCard.tsx render แผงอ่านอย่างเดียว (ไม่มี input ใดๆ)

import type { Contract, Shop } from './types'
import { ageRange, baht, conditionLabel, originLabel, thaiDate } from './format'
import { calcSummary } from './calc'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewField {
  key: string
  label: string // ไทย
  value: string // จัดรูปแบบเสร็จแล้ว ('' = ว่าง)
  mono?: boolean // เลขอ้างอิง/เงิน → ใช้ font tabular (tabular-nums)
  inEmail?: boolean // อยู่ในอีเมลที่ส่งบริษัท
  derived?: boolean // ระบบคำนวณให้ ไม่ใช่ค่าที่พนักงานคีย์
  missing?: boolean // ว่างทั้งที่ควรมีค่า → ไฮไลต์เตือน
  alt?: string // ค่าที่สอง กรณี 2 สูตรไม่ตรงกัน (ดาวน์ต่าง 1 บาท) — ข้อความพร้อมแสดงต่อท้าย เช่น "ตารางงวด 5,969 ฿"
  // --- เทียบกับ PJ (คอลัมน์ที่ 3 ในแผงตรวจ) — decorate เพิ่มทีหลังโดย applyPjComparison() ใน pjCompare.ts ---
  // buildReviewFields() เองไม่ตั้งค่า 3 ช่องนี้เลย (undefined เสมอ) — เรียก applyPjComparison(groups, null) แล้วต้องได้แผงหน้าตาเดิมเป๊ะ
  pjValue?: string // ค่าที่ดึงมาจาก PJ จัดรูปแบบพร้อมแสดง ('' = PJ ไม่มี/ไม่มีคีย์นี้)
  pjCompare?: 'same' | 'soft' | 'hard' | 'no_pj' | 'pj_blank' // same=ตรงกัน · soft=ต่างแบบเตือนเหลือง(ข้อความอิสระ) · hard=ต่างแบบแดง · no_pj=PJ ไม่เก็บข้อมูลนี้เลย(ไม่มีคีย์) · pj_blank=PJ มีคีย์นี้แต่ค่าว่าง/parse ไม่ได้
  pjNote?: string // หมายเหตุประกอบ เช่น "ต่าง 1 บาท (ปัดเศษ)" หรือ "สลับช่องเบอร์สำรอง"
}

export interface ReviewFieldGroup {
  name: string
  fields: ReviewField[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ว่างสำหรับ string field — undefined/null/สตริงว่างล้วน */
function missingStr(v: string | undefined | null): boolean {
  return !v || v.trim() === ''
}

/**
 * ว่างสำหรับ number field ที่ "ต้องมีค่าจริงทางธุรกิจ" (ราคาเครื่อง/เรทดาวน์/ค่าคอม/ค่าเอกสาร/ยอดจัด/ค่างวด/จำนวนงวด/วันครบกำหนด)
 * ทุกฟิลด์นี้ type เป็น number ไม่ใช่ number|undefined ใน Contract (คีย์ไม่ครบจะกลายเป็น 0 จาก DB/ฟอร์มเก่า) —
 * เลย treat 0 เป็น "ยังไม่กรอก" แทน — ไม่มีสัญญาไหนราคาเครื่อง/ยอดจัด/ค่างวด/จำนวนงวด/วันครบกำหนดเท่ากับ 0 จริง
 * (docFee เป็นข้อยกเว้นทางธุรกิจที่ 0 ได้จริง แต่สเปกล็อกให้เช็คเหมือนกันทั้งกลุ่ม — ดูรายงานท้ายไฟล์)
 */
function missingNum(v: number | undefined | null): boolean {
  return v == null || v === 0
}

// ---------------------------------------------------------------------------
// buildReviewFields — 9 กลุ่ม เรียงตามลำดับที่เจ้าของอนุมัติ (PJ ค้นเลขอ้างอิงก่อนเสมอ)
// ---------------------------------------------------------------------------

export function buildReviewFields(c: Contract, shop: Shop | null | undefined, currentYear: number): ReviewFieldGroup[] {
  const summary = calcSummary(c.devicePrice, c.downPercent, c.commissionPercent, c.docFee)

  // ดาวน์ต่าง 1 บาท: สูตรอีเมล (messages.ts) ปัดเศษคนละทางกับสูตรตารางงวด (ContractDetail.tsx)
  const downAmountEmail = Math.round(c.devicePrice * (c.downPercent / 100))
  const downAmountTable = c.devicePrice - summary.afterDown
  const downAmountAlt = downAmountTable !== downAmountEmail ? `ตารางงวด ${baht(downAmountTable)} ฿` : undefined

  const rentTotal = c.monthlyPayment * c.termMonths

  const birthYearValue = c.birthYear ? `${c.birthYear} · ช่วงอายุ ${ageRange(c.birthYear, currentYear)}` : ''

  const promoParts = [c.promotion, c.promotionDetail].filter((v): v is string => !!v && v.trim() !== '')
  const promotionDetailValue = promoParts.join(' · ')

  return [
    {
      name: 'เลขอ้างอิง',
      fields: [
        { key: 'contractNo', label: 'เลขที่สัญญา', value: c.contractNo ?? '', mono: true, inEmail: true, missing: missingStr(c.contractNo) },
        { key: 'invNo', label: 'เลขที่ INV', value: c.invNo ?? '', mono: true, inEmail: true, missing: missingStr(c.invNo) },
        { key: 'sn', label: 'หมายเลข SN', value: c.sn ?? '', mono: true, inEmail: true, missing: missingStr(c.sn) },
        { key: 'imei', label: 'หมายเลข IMEI', value: c.imei ?? '', mono: true },
      ],
    },
    {
      name: 'ลูกค้า',
      fields: [
        { key: 'customerName', label: 'ชื่อลูกค้า', value: c.customerName ?? '', inEmail: true, missing: missingStr(c.customerName) },
        { key: 'nationalId', label: 'เลขบัตรประชาชน', value: c.nationalId ?? '', mono: true, missing: missingStr(c.nationalId) },
        { key: 'phone', label: 'เบอร์โทรลูกค้า', value: c.phone ?? '', mono: true, inEmail: true, missing: missingStr(c.phone) },
        { key: 'phoneAlt1', label: 'โทรศัพท์สำรอง 1', value: c.phoneAlt1 ?? '', mono: true, inEmail: true },
        { key: 'phoneAlt2', label: 'โทรศัพท์สำรอง 2', value: c.phoneAlt2 ?? '', mono: true, inEmail: true },
        { key: 'facebookLink', label: 'ลิงก์เฟซบุ๊ก', value: c.facebookLink ?? '', inEmail: true },
        { key: 'birthYear', label: 'ปีเกิด', value: birthYearValue },
        { key: 'occupation', label: 'อาชีพ', value: c.occupation ?? '' },
        { key: 'occupationProof', label: 'หลักฐานอาชีพ', value: c.occupationProof ?? '' },
      ],
    },
    {
      name: 'เครื่อง',
      fields: [
        { key: 'model', label: 'รุ่น', value: c.model ?? '', inEmail: true, missing: missingStr(c.model) },
        { key: 'storage', label: 'ความจุ', value: c.storage ?? '', inEmail: true, missing: missingStr(c.storage) },
        { key: 'color', label: 'สีเครื่อง', value: c.color ?? '' },
        { key: 'condition', label: 'สภาพสินค้า', value: c.condition ? conditionLabel(c.condition) : '' },
        { key: 'origin', label: 'แหล่งเครื่อง', value: c.origin ? originLabel(c.origin) : '' },
        { key: 'devicePrice', label: 'ราคาตัวเครื่อง', value: `${baht(c.devicePrice)} ฿`, mono: true, missing: missingNum(c.devicePrice) },
      ],
    },
    {
      name: 'ยอดเงิน — ก้อนโอนร้าน',
      fields: [
        { key: 'downPercent', label: 'เรทดาวน์', value: `${c.downPercent} %`, inEmail: true, missing: missingNum(c.downPercent) },
        { key: 'commissionPercent', label: 'เปอร์เซ็นต์ค่าคอม', value: `${c.commissionPercent} %`, missing: missingNum(c.commissionPercent) },
        { key: 'docFee', label: 'ค่าเอกสาร (หักออก)', value: `${baht(c.docFee)} ฿`, mono: true, missing: missingNum(c.docFee) },
        { key: 'afterDown', label: 'ยอดหลังหักดาวน์', value: `${baht(summary.afterDown)} ฿`, mono: true, derived: true },
        { key: 'commission', label: 'ค่าคอมมิชชั่น', value: `${baht(summary.commission)} ฿`, mono: true, derived: true },
        { key: 'net', label: 'ยอดโอนสุทธิให้ร้าน', value: `${baht(summary.net)} ฿`, mono: true, derived: true },
      ],
    },
    {
      name: 'ยอดเงิน — ก้อนผ่อนที่ส่งบริษัท',
      fields: [
        { key: 'financeAmount', label: 'ยอดจัดไฟแนนซ์', value: `${baht(c.financeAmount)} ฿`, mono: true, inEmail: true, missing: missingNum(c.financeAmount) },
        {
          key: 'downAmount',
          label: 'ยอดเงินดาวน์',
          value: `${baht(downAmountEmail)} ฿`,
          mono: true,
          inEmail: true,
          derived: true,
          alt: downAmountAlt,
        },
        { key: 'monthlyPayment', label: 'ค่างวดต่อเดือน', value: `${baht(c.monthlyPayment)} ฿`, mono: true, inEmail: true, missing: missingNum(c.monthlyPayment) },
        { key: 'termMonths', label: 'จำนวนงวด', value: `${c.termMonths} เดือน`, inEmail: true, missing: missingNum(c.termMonths) },
        { key: 'rentTotal', label: 'ราคาเช่าซื้อรวม', value: `${baht(rentTotal)} ฿`, mono: true, inEmail: true, derived: true },
        { key: 'dueDay', label: 'ชำระทุกวันที่', value: `${c.dueDay}`, inEmail: true, missing: missingNum(c.dueDay) },
      ],
    },
    {
      name: 'ร้านค้า',
      fields: [
        { key: 'shopCode', label: 'รหัสร้าน', value: shop?.code ?? '', mono: true, inEmail: true, missing: !shop || missingStr(shop.code) },
        { key: 'shopName', label: 'ชื่อร้าน', value: shop?.name ?? '' },
      ],
    },
    {
      name: 'โปรโมชั่น',
      fields: [
        { key: 'hasPromotion', label: 'มีโปรโมชั่นไหม', value: c.hasPromotion ? 'มีโปร' : 'ไม่มีโปร' },
        { key: 'promotionDetail', label: 'รายละเอียดโปร', value: promotionDetailValue },
      ],
    },
    {
      name: 'ผู้ทำรายการ',
      fields: [
        { key: 'transactionDate', label: 'วันที่ทำรายการ', value: c.transactionDate ? thaiDate(c.transactionDate) : '' },
        { key: 'operator', label: 'ผู้ดำเนินการ', value: c.operator ?? '', missing: missingStr(c.operator) },
        { key: 'recordedBy', label: 'ผู้บันทึก', value: c.recordedBy ?? '', derived: true },
      ],
    },
    {
      name: 'เอกสาร และเคสพิเศษ',
      fields: [
        { key: 'pendingDocuments', label: 'Case Online', value: c.pendingDocuments ? 'ใช่' : 'ไม่ใช่' },
        { key: 'hasPhoneBox', label: 'มีกล่องเครื่อง', value: c.hasPhoneBox ? 'มี' : 'ไม่มี' },
        { key: 'creditHistoryFound', label: 'พบประวัติเครดิตเสีย', value: c.creditHistoryFound ? 'พบ' : 'ไม่พบ' },
        { key: 'notes', label: 'หมายเหตุ', value: c.notes ?? '' },
      ],
    },
  ]
}

// ===========================================================================
// Trace tests (verify ด้วย node -e ผ่าน tsc transpile — repo ไม่มี vitest)
// ===========================================================================
//
// สมมติ Contract ตัวอย่าง: devicePrice=19900, downPercent=30, commissionPercent=12, docFee=100,
// financeAmount=13930, monthlyPayment=1500, termMonths=12
// เรียกด้วย buildReviewFields(c, shop, currentYear) — currentYear เป็นพารามิเตอร์ (ไม่อ่านนาฬิกาเอง เหมือน ageRange(birthYear, currentYear) ที่ format.ts)
// สมมติทุกเคสด้านล่าง: currentYear = 2026 (ไม่ผูกกับปีจริงตอนรัน — ผลลัพธ์นี้ยืนตลอดไปไม่ว่ารันวันไหน)
//
// calcSummary(19900,30,12,100):
//   afterDown = round(19900*0.7) = 13930
//   commission = round(13930*0.12) = 1672
//   net = 13930+1672-100 = 15502
//
// (1) downAmountEmail = round(19900*0.30) = 5970
// (2) downAmountTable = 19900 - 13930 = 5970 → เท่ากัน → alt = undefined (ไม่ต่างในเคสนี้)
//     ถ้า devicePrice=19899 → afterDown=round(19899*0.7)=13929 → table=19899-13929=5970
//        email=round(19899*0.30)=5970 → ยังเท่ากัน (ตัวอย่างเคสต่าง 1 บาทจริงต้องเลขที่ปัดต่างทาง เช่น
//        devicePrice=19905 → afterDown=round(19905*0.7)=13934(.5→14) → 19905-13934=5971
//        email=round(19905*0.30)=5972(.5→) → ต่าง 1 บาท → alt='ตารางงวด 5,971 ฿'
//
// (3) missingNum(0) -> true ; missingNum(undefined) -> true ; missingNum(1500) -> false
// (4) missingStr('') -> true ; missingStr('  ') -> true ; missingStr('AQ S00016') -> false
//
// (5) buildReviewFields(c, null, 2026).find(g => g.name === 'ร้านค้า')!.fields[0].missing -> true (shop=null)
// (6) buildReviewFields(c, shop, 2026).find(g => g.name === 'ร้านค้า')!.fields[0].value -> shop.code
//
// (7) กลุ่มลำดับต้องเป็น: เลขอ้างอิง, ลูกค้า, เครื่อง, ยอดเงิน — ก้อนโอนร้าน, ยอดเงิน — ก้อนผ่อนที่ส่งบริษัท,
//     ร้านค้า, โปรโมชั่น, ผู้ทำรายการ, เอกสาร และเคสพิเศษ (9 กลุ่มเป๊ะ)
//
// (8) c.birthYear=1998, currentYear=2026 (พารามิเตอร์ที่ส่งเข้ามา ไม่ใช่ new Date().getFullYear())
//     → ageRange(1998,2026): age=28 → '23-30' (format.ts บรรทัด 22)
//     birthYearValue -> '1998 · ช่วงอายุ 23-30'
//     ถ้าเรียกด้วย currentYear=2036 แทน (สมมติรันในอนาคต) → age=38 → '31-40' — คนละคำตอบ พิสูจน์ว่าฟังก์ชันไม่ผูกนาฬิกาจริงอีกต่อไป
