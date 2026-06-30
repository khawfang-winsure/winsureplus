/**
 * paymentSpread.ts
 *
 * จำลอง logic ของ RPC record_payment_spread (migration 0079) ฝั่ง client
 * ใช้สำหรับพรีวิว "เงินที่กรอกจะตัดเข้างวดไหนบ้าง" ก่อนกดยืนยัน
 *
 * บริสุทธิ์ล้วน (pure): ไม่มี side effect, ไม่ import ไฟล์อื่น, ไม่เรียก Supabase
 */

export interface SpreadRow {
  /** หมายเลขงวด (installment_no) */
  no: number
  /** จำนวนเงินที่ตัดเข้างวดนี้ */
  applied: number
  /** งวดนี้จ่ายครบหลังตัดหรือไม่ */
  fullyPaid: boolean
}

/**
 * จำลองการทยอยตัดเงินเข้างวดที่ยังค้าง — ตัดเต็มไล่ลงงวดถัดไป เศษค้างงวดท้าย
 * ตรงกับ RPC record_payment_spread (migration 0079)
 *
 * @param unpaid  งวดที่ยังไม่จ่าย เรียงตามหมายเลขงวดแล้ว
 *                (no = installment_no, remaining = ยอดค้างของงวด = amount − paid_amount)
 * @param principal เงินต้นรวมที่จะลง (ไม่รวมค่าปรับ)
 * @returns รายการงวดที่ถูกตัด พร้อมจำนวนและสถานะครบ/บางส่วน
 *
 * Edge cases:
 *   - unpaid เป็น [] → คืน [] (ไม่มีงวดให้ตัด)
 *   - principal <= 0  → คืน [] (ไม่มีอะไรตัด)
 *   - เงินเกินกว่าทุกงวดรวม (rem > 0 หลังวนจบ) → บวก rem เข้างวดสุดท้ายของ unpaid
 *     เหตุผล: เลียนแบบ RPC ที่ใส่เศษเกินไว้ที่งวดสุดท้ายของสัญญา (overpayment credit)
 *             ถ้างวดสุดท้ายนั้นได้รับ applied ไปแล้วในรอบนี้ → บวกเพิ่ม applied + fullyPaid=true
 *             ถ้างวดสุดท้ายยังไม่ถูกแตะ (remaining = 0 ข้ามไป) → push row ใหม่ applied=rem, fullyPaid=true
 */
export function spreadPayment(
  unpaid: { no: number; remaining: number }[],
  principal: number,
): SpreadRow[] {
  if (unpaid.length === 0 || principal <= 0) return []

  const rows: SpreadRow[] = []
  let rem = principal

  for (const item of unpaid) {
    if (rem <= 0) break

    const take = Math.min(item.remaining, rem)
    if (take <= 0) continue

    rows.push({
      no: item.no,
      applied: take,
      fullyPaid: take >= item.remaining,
    })

    rem -= take
  }

  // เศษเกิน: rem ยังเหลือหลังวนจบทุกงวด
  if (rem > 0) {
    const lastUnpaidNo = unpaid[unpaid.length - 1].no
    const existing = rows.find(r => r.no === lastUnpaidNo)
    if (existing) {
      // งวดสุดท้ายถูกตัดในรอบนี้แล้ว → บวก rem เพิ่ม
      existing.applied += rem
      existing.fullyPaid = true
    } else {
      // งวดสุดท้ายถูกข้ามเพราะ remaining = 0 → push row ใหม่
      rows.push({ no: lastUnpaidNo, applied: rem, fullyPaid: true })
    }
  }

  return rows
}
