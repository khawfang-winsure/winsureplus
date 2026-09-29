// ===== ดึงเรทราคาจาก "เว็บเรท" (https://winsure.lovable.app/prices) =====
//
// เว็บเรทเป็นแอป Lovable ของบริษัทเอง เก็บราคาใน Supabase คนละโปรเจกต์กับเว็บนี้ — เลยไม่ผ่าน db.ts / supabase client ของเรา
// ใช้ fetch ธรรมดา อ่านตาราง admin_config (key='products') ที่เปิดอ่านสาธารณะ
// ตรวจแล้ว 2026-09-29: GET จาก Origin localhost ได้ 200 + Access-Control-Allow-Origin ตรง origin · preflight ตอบ *
//
// cache ในหน่วยความจำต่อ 1 page load — เปิดหลายเคสยิงครั้งเดียว. ถ้าล้มเหลวจำผลไว้สั้นๆ (FAIL_COOLDOWN_MS) กันยิงรัวตอนเว็บเรทล่ม

import { parseRateTable, type RateTable } from './priceRate'

const RATE_SUPABASE_URL = 'https://zsjvddetnokjyyyphkou.supabase.co'
/** publishable key ของ Supabase เว็บเรท — เป็นกุญแจสาธารณะอยู่แล้ว (ฝังอยู่ใน JS bundle ของ https://winsure.lovable.app)
 *  ดึงมาจาก bundle นั้นด้วย regex sb_publishable_[A-Za-z0-9_-]+ เมื่อ 2026-09-29 · ถ้าเว็บเรทหมุนคีย์ ป้ายจะขึ้น "เช็กไม่ได้" ให้ไปดึงคีย์ใหม่จาก bundle */
const RATE_PUBLISHABLE_KEY = 'sb_publishable__gkgvoiVaMRJRctDDcqKaQ_g6ir2PJp'
const RATE_URL = `${RATE_SUPABASE_URL}/rest/v1/admin_config?select=value&key=eq.products`
const TIMEOUT_MS = 8000
const FAIL_COOLDOWN_MS = 60_000

const FRESH_MS = 10 * 60_000 // ผลที่ดึงสำเร็จถือว่าเก่าเมื่อเกิน 10 นาที → ดึงใหม่ครั้งถัดไปที่ component mount (ไม่มี polling)

let cached: Promise<RateTable | null> | null = null
let settledAt = 0 // 0 = ยังโหลดอยู่ (ใช้ผลเดียวกัน ไม่ยิงซ้ำ)
let settledOk = false // รอบล่าสุดดึงสำเร็จไหม (กำหนดอายุแคช: สำเร็จ 10 นาที / ล้มเหลว 60 วินาที)
let lastGood: RateTable | null = null

async function load(): Promise<RateTable | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(RATE_URL, {
      headers: { apikey: RATE_PUBLISHABLE_KEY, Authorization: `Bearer ${RATE_PUBLISHABLE_KEY}` },
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    const body: unknown = await res.json()
    const value = Array.isArray(body) && body.length > 0 ? (body[0] as { value?: unknown } | null)?.value : undefined
    return parseRateTable(value)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** คืนตารางเรท iPhone หรือ null ถ้าดึงไม่ได้/รูปแบบผิด — ไม่ throw
 *  ใช้ผลที่จำไว้ถ้ายังสด (สำเร็จ < 10 นาที · ล้มเหลว < 60 วินาที) · รีเฟรชแล้วล้มเหลวแต่เคยได้ตารางมาก่อน → ใช้ตารางเดิมต่อ */
export function fetchPriceRates(): Promise<RateTable | null> {
  if (cached) {
    if (settledAt === 0) return cached
    if (Date.now() - settledAt < (settledOk ? FRESH_MS : FAIL_COOLDOWN_MS)) return cached
  }
  settledAt = 0
  const p = load().then((t) => {
    settledOk = t !== null
    settledAt = Date.now()
    if (t) lastGood = t
    return t ?? lastGood
  })
  cached = p
  return p
}
