// ===== ปิดสัญญาก่อนกำหนด + ส่วนลด (Early Settlement) =====
// กฎ Pete เคาะ Wave 1:
//   - ลูกค้าอยากปิดสัญญาก่อนครบงวด → ให้ส่วนลดเงินต้นที่เหลือตามจำนวนงวดที่เหลือ
//   - เหลือเยอะ (ปิดเร็ว) → ส่วนลด % มากกว่า
//   - ส่วนลดคิดจาก "เงินต้นที่เหลือ" เท่านั้น — ค่าปรับค้างไม่ลด ต้องจ่ายเต็ม
//
// pure function ล้วน ไม่แตะ supabase (ลอกสไตล์ comment/Trace จาก outstandingExtras.ts / calc.ts)

/** ชั้นส่วนลด: ถ้างวดที่เหลือ >= minRemaining → ได้ส่วนลด percent%
 *  เก็บใน app_settings key 'settlement_tiers' เป็น JSON array */
export interface SettlementTier {
  minRemaining: number // เหลือกี่งวดขึ้นไปถึงเข้า band นี้
  percent: number      // ส่วนลด % ของเงินต้นที่เหลือ
}

/** เลือก % ส่วนลดตามจำนวนงวดที่เหลือ
 *  - หา band ที่ minRemaining "มากสุด" ที่ยัง <= remainingCount (เหลือยิ่งเยอะ ยิ่งได้ band สูง)
 *  - ไม่มี band ไหนเข้า → 0
 *  Trace (tiers = [{5,7},{10,10}]):
 *    remaining 3  → ไม่มี band เข้า (3 < 5)        → 0
 *    remaining 5  → เข้า {5,7} (5<=5)              → 7
 *    remaining 9  → เข้า {5,7} (9>=5, 9<10)        → 7
 *    remaining 10 → เข้า {10,10} (10>=10, มากสุด)  → 10
 *    remaining 20 → เข้า {10,10}                   → 10 */
export function pickDiscountPercent(remainingCount: number, tiers: SettlementTier[]): number {
  // เรียง minRemaining จากมากไปน้อย แล้วหยิบตัวแรกที่ remainingCount เข้าเกณฑ์
  const sorted = [...tiers].sort((a, b) => b.minRemaining - a.minRemaining)
  for (const t of sorted) {
    if (remainingCount >= t.minRemaining) return t.percent
  }
  return 0
}

export interface SettlementInstallmentInput {
  amount: number       // ค่างวดเต็มของงวด
  paidAmount: number   // จ่ายสะสมแล้วของงวด (principal)
  penaltyAmount: number // ค่าปรับของงวด
  paidAt: string | null // null = ยังไม่ปิดงวด (ยังค้าง)
}

export interface SettlementResult {
  remainingPrincipal: number // เงินต้นที่เหลือ = Σ max(0, amount − paidAmount) ของงวดที่ยังค้าง
  remainingCount: number     // จำนวนงวดที่ยังค้าง (paidAt IS NULL)
  percent: number            // ส่วนลด % ที่ได้
  discount: number           // ส่วนลดเป็นบาท = ceil(remainingPrincipal × percent/100)
  penaltyDue: number         // ค่าปรับค้างรวม (ไม่ลด)
  customerPays: number       // ลูกค้าจ่ายปิด = (remainingPrincipal − discount) + penaltyDue
}

/** คิดยอดปิดสัญญาก่อนกำหนด
 *  สูตร (Pete เคาะ):
 *    remainingPrincipal = Σ max(0, amount − paidAmount) ของงวด paidAt IS NULL   [เงินต้นล้วน]
 *    remainingCount     = นับงวด paidAt IS NULL
 *    percent            = pickDiscountPercent(remainingCount, tiers)
 *    discount           = Math.ceil(remainingPrincipal × percent/100)            [ปัดขึ้นเป็นบาท]
 *    penaltyDue         = Σ penaltyAmount ของงวด paidAt IS NULL                   [ไม่ลด]
 *    customerPays       = (remainingPrincipal − discount) + penaltyDue
 *  Trace (tiers = [{5,7},{10,10}]):
 *    งวดเหลือ 10 งวด งวดละ 1000 ค้างทั้งหมด ไม่มีค่าปรับ:
 *      remainingPrincipal=10000, remainingCount=10, percent=10,
 *      discount=ceil(1000)=1000, penaltyDue=0, customerPays=9000
 *    ไม่มีงวดค้าง: ทุกค่า = 0 */
export function computeSettlement(input: {
  installments: SettlementInstallmentInput[]
  tiers: SettlementTier[]
}): SettlementResult {
  // งวดที่ยังค้าง = paidAt เป็น null (discriminator หลัก เหมือน outstandingAfterReturn)
  const unpaid = input.installments.filter((i) => i.paidAt === null)

  const remainingPrincipal = unpaid.reduce(
    (s, i) => s + Math.max(0, (i.amount || 0) - (i.paidAmount || 0)),
    0,
  )
  const remainingCount = unpaid.length
  const penaltyDue = unpaid.reduce((s, i) => s + (i.penaltyAmount || 0), 0)

  const percent = pickDiscountPercent(remainingCount, input.tiers)
  const discount = Math.ceil((remainingPrincipal * percent) / 100)
  const customerPays = remainingPrincipal - discount + penaltyDue

  return {
    remainingPrincipal,
    remainingCount,
    percent,
    discount,
    penaltyDue,
    customerPays,
  }
}
