// ===== ป้ายเตือนราคาเครื่องเทียบ "เว็บเรท" (https://winsure.lovable.app/prices) =====
//
// pure fn — ไม่มี side effect ไม่ import React ไม่แตะ db.ts (ตัวดึงเรทอยู่ที่ priceRateApi.ts)
// ใช้ในแผง "ข้อมูลสำหรับตรวจ" (ContractMediaCard → ReviewPanel) เพื่อเตือนพนักงานตรวจ "อย่างเดียว" — ห้ามบล็อกปุ่มอนุมัติ/ส่งเมล
//
// กติกา (คุณเตยเคาะแล้ว — ห้ามเปลี่ยนเอง · ต้องตรงกับ C:/Users/Teay/.cream-photo-check/pricecheck.mjs ของครีม):
//   เลือกช่องเรทตามสัญญา: origin='inter' → priceImported · condition='new' → priceFirstHand · อื่นๆ (ไทยมือสอง) → priceSecondHand
//   red    : ไทย (มือ1/มือ2) device_price > เรท + 1,000 · เครื่องนอก device_price > เรท (เกินไม่ได้เลย)
//   yellow : หารุ่น/ความจุไม่เจอในเรท (อาจคีย์ผิด) · device_price < เรท × 0.7 (ต่ำผิดปกติ)
//   info   : เรทช่องนั้นเป็น 0/ว่าง · ดึงเรทไม่ได้ (ตาราง null) — สีเทา ไม่ใช่คำเตือน
//   ok     : อยู่ในเรท
//   none   : ไม่ใช่ iPhone (เช่น iPad) → ไม่แสดงป้าย
//   จับคู่รุ่น: ไม่สนตัวพิมพ์ + ตัดช่องว่างในความจุ · alias 'iPhone 17 Air' → 'iPhone Air'

import type { DeviceCondition, DeviceOrigin } from './types'
import { baht } from './format'

/** เพดานที่เครื่องไทยตั้งเกินเรทได้ (บาท) — เครื่องนอกเกินไม่ได้เลย */
export const THAI_OVER_RATE_ALLOWANCE = 1000
/** ต่ำกว่าเรทเกินสัดส่วนนี้ (เหลือน้อยกว่า 70% ของเรท) = เหลือง */
export const LOW_PRICE_RATIO = 0.7
/** ต้องมีแถว iPhone อย่างน้อยเท่านี้ ไม่งั้นถือว่ารูปแบบข้อมูลเรทผิดปกติ (เหมือน pricecheck.mjs) */
export const MIN_IPHONE_RATE_ROWS = 20
export const RATE_WEB_URL = 'https://winsure.lovable.app/prices'

/** เรทของ 1 รุ่น+ความจุ (บาท) · 0 = เว็บเรทยังไม่มีราคาช่องนั้น */
export interface RateRow {
  model: string
  storage: string
  firstHand: number // priceFirstHand — ไทยมือ 1
  secondHand: number // priceSecondHand — ไทยมือ 2
  imported: number // priceImported — เครื่องนอก
}

/** lookup key = รุ่น(พิมพ์เล็ก) + '|' + ความจุ(พิมพ์เล็ก ไม่มีช่องว่าง) */
export type RateTable = ReadonlyMap<string, RateRow>

export type PriceLevel = 'red' | 'yellow' | 'info' | 'ok' | 'none'
export type PriceKind = 'firstHand' | 'secondHand' | 'imported'

export interface PriceCheckInput {
  model: string
  storage: string
  condition: DeviceCondition
  origin: DeviceOrigin
  devicePrice: number
}

export interface PriceCheck {
  level: PriceLevel
  message: string
  /** เรทของช่องที่ใช้เทียบ (มีเมื่อเจอรุ่นและเรท > 0) */
  rate?: number
  /** ประเภทเครื่องที่ใช้เทียบ */
  kind?: PriceKind
}

const KIND_LABEL: Record<PriceKind, string> = {
  firstHand: 'ไทยมือ1',
  secondHand: 'ไทยมือ2',
  imported: 'เครื่องนอก',
}

function normModel(model: string): string {
  const m = model.trim().replace(/\s+/g, ' ').toLowerCase()
  return m === 'iphone 17 air' ? 'iphone air' : m
}

function rateKey(model: string, storage: string): string {
  return `${normModel(model)}|${storage.replace(/\s+/g, '').toLowerCase()}`
}

function toPrice(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

/** แปลงข้อมูลดิบจากเว็บเรท (admin_config.products) → lookup เฉพาะ iPhone
 *  คืน null ถ้ารูปแบบผิดปกติ (ไม่ใช่ array / แถว iPhone น้อยกว่า MIN_IPHONE_RATE_ROWS) → UI แสดง info "เช็กไม่ได้" */
export function parseRateTable(raw: unknown): RateTable | null {
  if (!Array.isArray(raw)) return null
  const table = new Map<string, RateRow>()
  for (const p of raw) {
    if (typeof p !== 'object' || p === null) continue
    const rec = p as { model?: unknown; variants?: unknown }
    const model = typeof rec.model === 'string' ? rec.model : ''
    if (!/iphone/i.test(model) || !Array.isArray(rec.variants)) continue
    for (const v of rec.variants) {
      if (typeof v !== 'object' || v === null) continue
      const rv = v as Record<string, unknown>
      const storage = typeof rv.storage === 'string' ? rv.storage : ''
      if (!storage) continue
      table.set(rateKey(model, storage), {
        model,
        storage,
        firstHand: toPrice(rv.priceFirstHand),
        secondHand: toPrice(rv.priceSecondHand),
        imported: toPrice(rv.priceImported),
      })
    }
  }
  return table.size >= MIN_IPHONE_RATE_ROWS ? table : null
}

function pickKind(condition: DeviceCondition, origin: DeviceOrigin): PriceKind {
  if (origin === 'inter') return 'imported'
  if (condition === 'new') return 'firstHand'
  return 'secondHand'
}

function rateOf(row: RateRow, kind: PriceKind): number {
  return kind === 'imported' ? row.imported : kind === 'firstHand' ? row.firstHand : row.secondHand
}

/** ตัดสินป้ายราคา 1 สัญญา — table = null หมายถึงดึงเรทไม่ได้ */
export function evaluatePrice(input: PriceCheckInput, table: RateTable | null): PriceCheck {
  if (!/iphone/i.test(input.model)) return { level: 'none', message: '' }
  if (!table) return { level: 'info', message: 'เช็กราคากับเว็บเรทไม่ได้ตอนนี้' }

  const row = table.get(rateKey(input.model, input.storage))
  if (!row) {
    return { level: 'yellow', message: 'ไม่พบรุ่น/ความจุนี้ในเว็บเรท (อาจคีย์รุ่นหรือความจุผิด)' }
  }

  const kind = pickKind(input.condition, input.origin)
  const rate = rateOf(row, kind)
  if (rate <= 0) return { level: 'info', message: 'เว็บเรทยังไม่มีราคาช่องนี้', kind }

  const price = input.devicePrice
  if (!Number.isFinite(price)) return { level: 'info', message: 'ไม่มีราคาเครื่องให้เช็ก', rate, kind }
  const allowance = kind === 'imported' ? 0 : THAI_OVER_RATE_ALLOWANCE

  if (price > rate + allowance) {
    const over = price - rate
    const allowText = allowance > 0 ? `เกินได้ไม่เกิน ${baht(allowance)} บาท` : 'เกินเรทไม่ได้เลย'
    let message = `ราคาที่คีย์ ${baht(price)} ฿ สูงกว่าเรท${KIND_LABEL[kind]} ${baht(rate)} ฿ อยู่ ${baht(over)} บาท (${KIND_LABEL[kind]}${allowText})`
    const others = (['firstHand', 'secondHand', 'imported'] as const).filter((k) => k !== kind && rateOf(row, k) === price)
    if (others.length > 0) {
      message += ` — อาจเลือกประเภทเครื่องผิด (ตรงกับเรท${others.map((k) => KIND_LABEL[k]).join(' / ')})`
    }
    return { level: 'red', message, rate, kind }
  }

  if (price < rate * LOW_PRICE_RATIO) {
    return {
      level: 'yellow',
      message: `ราคาที่คีย์ ${baht(price)} ฿ ต่ำกว่าเรท${KIND_LABEL[kind]} ${baht(rate)} ฿ ผิดปกติ (อาจคีย์ผิด)`,
      rate,
      kind,
    }
  }

  return { level: 'ok', message: `ราคาอยู่ในเรท (เรท ${baht(rate)})`, rate, kind }
}
