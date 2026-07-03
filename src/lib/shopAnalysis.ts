// ===== วิเคราะห์ร้านเพื่อจัดโปรดาวน์ต่ำ (ฟังก์ชันบริสุทธิ์ — หน้า /shop-promo-analysis) =====
// ให้ผู้บริหารดูว่าร้านไหนควรให้โปรดาวน์ต่ำ (ส่งเคสเยอะ + หนี้เสียต่ำ + ทิ้งงวดแรกน้อย)
//
// ⚠️ ห้ามแก้ src/lib/execDashboard.ts, src/lib/monthlyReport.ts, src/lib/weeklySummary.ts — สูตรที่ใช้ร่วมกัน
// (pct, normalizeModelName) ถูกคัดลอกคำต่อคำจาก monthlyReport.ts มาเป็น local function ในไฟล์นี้แทน
// ยกเว้น buildShopReport จาก report.ts — import ตรงๆ (Pete สั่ง reuse ตัวคำนวณทิ้งงวดแรก ไม่เขียนใหม่)
import type { Contract, ContractStatusRow, Shop } from './types'
import type { ContractAggregate } from './db'
import { buildShopReport } from './report'

// ===== เกณฑ์ (Pete ปรับได้) =====
export interface ShopPromoThresholds {
  minCases: number // จำนวนเคสขั้นต่ำใน trend window ถึงจะพอตัดสินใจ
  maxNplRate: number // % หนี้เสีย 60+ (ตามมูลค่า) สูงสุดที่ยอมรับได้
  maxFirstDefaultRate: number // % ทิ้งงวดแรก(ถือเครื่อง) สูงสุดที่ยอมรับได้
}

export const DEFAULT_SHOP_PROMO_THRESHOLDS: ShopPromoThresholds = {
  minCases: 10,
  maxNplRate: 5,
  maxFirstDefaultRate: 10,
}

// ===== input =====
export interface ShopPromoAnalysisInput {
  contracts: Contract[]
  statuses: ContractStatusRow[]
  aggregates: Map<string, ContractAggregate>
  shops: Shop[]
  todayISO: string // 'YYYY-MM-DD'
}

// ===== local helpers — คัดจาก monthlyReport.ts คำต่อคำ ห้ามแก้ต้นฉบับ =====
const r0 = (n: number) => Math.round(n)

/** % ปลอดภัย: num/den → 0 ถ้า den=0 (กัน NaN/Infinity) */
function pct(num: number, den: number): number {
  if (den <= 0) return 0
  return (num / den) * 100
}

/**
 * normalize ชื่อรุ่นเครื่องให้รุ่นเดียวกันที่พิมพ์เพี้ยนมา merge กัน (ตัดความจุออก, แก้ case, แก้ Pro Max ติดกัน)
 * ไม่ merge รุ่นที่ต่างกันจริง — iPhone 15 / 15 Plus / 15 Pro / 15 Pro Max ยังแยกกันเหมือนเดิม
 * local เท่านั้น — ไม่ export ใช้ร่วมกับไฟล์อื่น
 */
function normalizeModelName(model: string | undefined | null): string {
  if (!model || !model.trim()) return 'ไม่ระบุรุ่น'
  let s = model.trim().replace(/\s+/g, ' ')

  // แทรกช่องว่างระหว่างตัวอักษรกับเลขที่ติดกัน (ทั้ง 2 ทิศ) ก่อนตัดความจุ
  // กัน "iphone11promax256gb" ไม่ให้ความจุรั่วเข้า key ตอนตัด token ทีหลัง
  s = s.replace(/([a-zA-Z])(\d)/g, '$1 $2')
  // เลข+ตัวอักษรติดกัน แต่ยกเว้นเลข+"e" ท้ายคำ (เช่น "16e" รุ่น iPhone 16e ห้ามแยกเป็น "16 e")
  s = s.replace(/(\d)([a-zA-Z])/g, (m, d: string, l: string, offset: number, str: string) => {
    if (l.toLowerCase() === 'e' && !/^[a-zA-Z]/.test(str.slice(offset + m.length))) return m
    return `${d} ${l}`
  })
  s = s.replace(/\s+/g, ' ').trim()

  // ตัดความจุ 2 สเต็ป:
  // 1) เลข+หน่วยแบบทั่วไป (ครอบ 1TB/2TB/256GB/ทุกเลข+หน่วย — ปลอดภัยเพราะบังคับมีหน่วยต่อท้าย)
  s = s.replace(/\b\d+\s?(gb|g|tb)\b/gi, ' ')
  // 2) เลขความจุเปล่าไม่มีหน่วย ใช้ whitelist กันไปกินเลขรุ่น iPhone 11-17
  s = s.replace(/\b(32|64|128|256|512|1024)\b/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()

  // แทรกช่องว่างระหว่างเลขติดคำ เช่น 15Pro -> 15 Pro (เผื่อกรณีตัดความจุแล้วเลขรุ่นมาติดคำใหม่)
  s = s.replace(/(\d)(pro|plus|max|air|mini)/gi, '$1 $2')
  // แทรกช่องว่างระหว่าง iphone ติดเลข เช่น iPhone11 -> iPhone 11
  s = s.replace(/(iphone)(\d)/gi, '$1 $2')

  // normalize คำว่า iPhone
  s = s.replace(/iphone/gi, 'iPhone')

  // normalize "Pro Max" ก่อน (รวม Promax/promax/pro max/ProMax) — ต้องทำก่อนกฎ pro/max เดี่ยว
  s = s.replace(/pro\s*max/gi, 'Pro Max')

  // normalize คำต่อท้ายเดี่ยวๆ ที่เหลือ
  s = s.replace(/\bpro\b/gi, 'Pro')
  s = s.replace(/\bplus\b/gi, 'Plus')
  s = s.replace(/\bmax\b/gi, 'Max')
  s = s.replace(/\bair\b/gi, 'Air')
  s = s.replace(/\bmini\b/gi, 'mini')

  s = s.replace(/\s+/g, ' ').trim()
  return s || 'ไม่ระบุรุ่น'
}

const NPL60_BUCKETS = new Set(['61-90', '91-120', '120+'])

/** 'YYYY-MM' ของ ISO date/timestamp string (10 ตัวแรกพอ) */
function monthOf(iso: string): string {
  return iso.slice(0, 7)
}

/** เลื่อนเดือน monthISO ('YYYY-MM') ไป delta เดือน */
function shiftMonth(monthISO: string, delta: number): string {
  const [y, m] = monthISO.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  const newY = Math.floor(total / 12)
  const newM = (total % 12) + 1
  return `${newY}-${String(newM).padStart(2, '0')}`
}

export type PromoGrowthFlag = 'โต' | 'ทรง' | 'หด' | 'ข้อมูลน้อย'
export type PromoSegment = 'แนะนำโปรดาวน์ต่ำ' | 'เสี่ยง' | 'ส่งน้อย' | 'ข้อมูลน้อย' | 'ไม่มีข้อมูล'

export interface ShopPromoTrendPoint {
  monthISO: string
  count: number
}

export interface ShopPromoTopModel {
  model: string
  count: number
  pctOfShop: number
}

export interface ShopPromoRow {
  shopId: string
  shopName: string
  shopCode: string

  npl60Count: number
  npl60CountRate: number // % ของสัญญา active ทั้งร้าน
  npl60Value: number
  npl60ValueRate: number // % ของ outstanding รวม active ทั้งร้าน — ใช้คิดคะแนน

  totalOutstanding: number
  totalFinanceAmount: number

  trend: ShopPromoTrendPoint[]
  trendCasesTotal: number
  activeMonthsInTrend: number
  growthFlag: PromoGrowthFlag

  topModels: ShopPromoTopModel[]

  firstDefaultHoldingRate: number
  firstDefaultReturnedRate: number

  promoScore: number // 0-100 (ยิ่งสูงยิ่งควรได้โปร)
  segment: PromoSegment
}

export interface ShopPromoAnalysisSummary {
  totalShops: number
  recommendedCount: number
  riskyCount: number
  lowVolumeCount: number
  lowDataCount: number
}

export interface ShopPromoAnalysis {
  todayISO: string
  trendMonths: number
  thresholds: ShopPromoThresholds
  rows: ShopPromoRow[]
  summary: ShopPromoAnalysisSummary
}

/** growthFlag: เทียบครึ่งแรก vs ครึ่งหลังของ trend window, delta>20% โต / <-20% หด / กลาง ทรง; activeMonths<2 = 'ข้อมูลน้อย' */
function growthFlagOf(trend: ShopPromoTrendPoint[], activeMonthsInTrend: number): PromoGrowthFlag {
  if (activeMonthsInTrend < 2) return 'ข้อมูลน้อย'
  const half = Math.floor(trend.length / 2)
  const firstHalf = trend.slice(0, half)
  const secondHalf = trend.slice(half)
  const firstSum = firstHalf.reduce((s, p) => s + p.count, 0)
  const secondSum = secondHalf.reduce((s, p) => s + p.count, 0)
  if (firstSum === 0) return secondSum > 0 ? 'โต' : 'ข้อมูลน้อย'
  const delta = ((secondSum - firstSum) / firstSum) * 100
  if (delta > 20) return 'โต'
  if (delta < -20) return 'หด'
  return 'ทรง'
}

export function buildShopPromoAnalysis(
  input: ShopPromoAnalysisInput,
  thresholds: ShopPromoThresholds = DEFAULT_SHOP_PROMO_THRESHOLDS,
  trendMonths = 6,
): ShopPromoAnalysis {
  const { contracts, statuses, aggregates, shops, todayISO } = input
  const outstandingOf = (contractId: string): number => aggregates.get(contractId)?.totalOutstanding ?? 0
  const statusByContract = new Map(statuses.map((s) => [s.contractId, s]))

  // เดือนของ trend window (เก่า -> ใหม่), เดือนปัจจุบันรวมด้วย
  const currentMonthISO = monthOf(todayISO)
  const monthList: string[] = []
  for (let i = trendMonths - 1; i >= 0; i--) monthList.push(shiftMonth(currentMonthISO, -i))
  const earliestMonth = monthList[0]

  // ทิ้งงวดแรก ต่อร้าน — reuse buildShopReport (ห้ามเขียนสูตรใหม่)
  const shopReportRows = buildShopReport(shops, contracts, statuses, todayISO)
  const shopReportById = new Map(shopReportRows.map((r) => [r.shopId, r]))

  const contractsByShop = new Map<string, Contract[]>()
  for (const c of contracts) {
    const arr = contractsByShop.get(c.shopId)
    if (arr) arr.push(c)
    else contractsByShop.set(c.shopId, [c])
  }

  const rows: ShopPromoRow[] = []

  for (const shop of shops) {
    const shopContracts = contractsByShop.get(shop.id) ?? []
    if (shopContracts.length === 0) continue // เฉพาะร้านมี contract ตามสเปก

    // ---- NPL 60+ (เฉพาะ active) ----
    let activeCount = 0
    let activeOutstanding = 0
    let npl60Count = 0
    let npl60Value = 0
    let totalOutstanding = 0
    let totalFinanceAmount = 0
    for (const c of shopContracts) {
      totalOutstanding += outstandingOf(c.id)
      totalFinanceAmount += c.financeAmount
      const st = statusByContract.get(c.id)
      if (!st || st.status !== 'active') continue
      activeCount++
      const out = outstandingOf(c.id)
      activeOutstanding += out
      if (NPL60_BUCKETS.has(st.bucket)) {
        npl60Count++
        npl60Value += out
      }
    }
    const npl60CountRate = pct(npl60Count, activeCount)
    const npl60ValueRate = pct(npl60Value, activeOutstanding)

    // ---- trend (นับ transactionDate group by เดือน, รวมเดือน count=0) ----
    const countByMonth = new Map<string, number>()
    for (const c of shopContracts) {
      const m = monthOf(c.transactionDate)
      if (m < earliestMonth || m > currentMonthISO) continue
      countByMonth.set(m, (countByMonth.get(m) ?? 0) + 1)
    }
    const trend: ShopPromoTrendPoint[] = monthList.map((m) => ({ monthISO: m, count: countByMonth.get(m) ?? 0 }))
    const trendCasesTotal = trend.reduce((s, p) => s + p.count, 0)
    const activeMonthsInTrend = trend.filter((p) => p.count > 0).length
    const growthFlag = growthFlagOf(trend, activeMonthsInTrend)

    // ---- top models (top5, ไม่ทำ 'อื่นๆ') ----
    const modelCounts = new Map<string, number>()
    for (const c of shopContracts) {
      const key = normalizeModelName(c.model)
      modelCounts.set(key, (modelCounts.get(key) ?? 0) + 1)
    }
    const shopTotal = shopContracts.length
    const topModels: ShopPromoTopModel[] = [...modelCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([model, count]) => ({ model, count, pctOfShop: pct(count, shopTotal) }))

    // ---- ทิ้งงวดแรก (reuse buildShopReport) ----
    const shopReport = shopReportById.get(shop.id)
    const firstDefaultHoldingRate = shopReport?.firstDefaultHoldingRate ?? 0
    const firstDefaultReturnedRate = shopReport?.firstDefaultReturnedRate ?? 0

    // ---- promoScore ----
    const volumeScore = Math.min(100, pct(trendCasesTotal, thresholds.minCases * 2))
    const qualityScore = Math.max(0, 100 - npl60ValueRate * (100 / thresholds.maxNplRate))
    const defaultScore = Math.max(0, 100 - firstDefaultHoldingRate * (100 / thresholds.maxFirstDefaultRate))
    const promoScore = r0(volumeScore * 0.4 + qualityScore * 0.35 + defaultScore * 0.25)

    // ---- segment (ลำดับ if-else สำคัญ) ----
    let segment: PromoSegment
    if (shopContracts.length === 0) {
      segment = 'ไม่มีข้อมูล'
    } else if (activeMonthsInTrend < 2) {
      segment = 'ข้อมูลน้อย'
    } else if (trendCasesTotal < thresholds.minCases) {
      segment = 'ส่งน้อย'
    } else if (npl60ValueRate > thresholds.maxNplRate || firstDefaultHoldingRate > thresholds.maxFirstDefaultRate) {
      segment = 'เสี่ยง'
    } else {
      segment = 'แนะนำโปรดาวน์ต่ำ'
    }

    rows.push({
      shopId: shop.id,
      shopName: shop.name || shop.code || '(ไม่พบชื่อร้าน)',
      shopCode: shop.code,
      npl60Count,
      npl60CountRate,
      npl60Value: r0(npl60Value),
      npl60ValueRate,
      totalOutstanding: r0(totalOutstanding),
      totalFinanceAmount: r0(totalFinanceAmount),
      trend,
      trendCasesTotal,
      activeMonthsInTrend,
      growthFlag,
      topModels,
      firstDefaultHoldingRate,
      firstDefaultReturnedRate,
      promoScore,
      segment,
    })
  }

  rows.sort((a, b) => b.promoScore - a.promoScore)

  const summary: ShopPromoAnalysisSummary = {
    totalShops: rows.length,
    recommendedCount: rows.filter((r) => r.segment === 'แนะนำโปรดาวน์ต่ำ').length,
    riskyCount: rows.filter((r) => r.segment === 'เสี่ยง').length,
    lowVolumeCount: rows.filter((r) => r.segment === 'ส่งน้อย').length,
    lowDataCount: rows.filter((r) => r.segment === 'ข้อมูลน้อย' || r.segment === 'ไม่มีข้อมูล').length,
  }

  return { todayISO, trendMonths, thresholds, rows, summary }
}

// ===== trace-test (comment เท่านั้น — ไม่รันจริง, ไว้ตรวจ logic ด้วยตา) =====
// 1) ร้านว่าง (ไม่มี contract เลย): shopContracts.length===0 → continue ข้ามร้านนี้ไปเลย ไม่ push แถว
//    (ตรงสเปก "rows: เฉพาะร้านมี contract")
// 2) ร้าน returned ล้วน (ทุกสัญญา status='returned'/'returned_closed'): statusByContract คืน st.status
//    ที่ != 'active' → activeCount=0, npl60CountRate/npl60ValueRate = pct(0,0) = 0 (ไม่ NaN)
//    firstDefaultHoldingRate มาจาก buildShopReport ซึ่งนับ holding เฉพาะ status==='active' อยู่แล้ว
//    → ร้าน returned ล้วนจะ holdingRate=0 แต่ returnedRate อาจ>0 (ไม่กระทบ segment เพราะเช็คแค่ holding)
// 3) ร้านมีเคสแค่ 1 เดือนใน trend window (เช่นเพิ่งเข้าใหม่): activeMonthsInTrend=1 <2
//    → growthFlag='ข้อมูลน้อย', segment='ข้อมูลน้อย' (ไม่ไปต่อเงื่อนไข minCases/npl แม้ trendCasesTotal จะเยอะ)
// 4) trend เดือนที่ไม่มีสัญญาเลย: countByMonth.get(m) ?? 0 → count=0 ทุกเดือน แต่ trend array ยังมีครบ trendMonths จุด
//    (ตรงสเปก "รวมเดือน count=0")
