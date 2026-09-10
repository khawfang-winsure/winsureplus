// ===== ปิดสัญญาก่อนกำหนด + ส่วนลด (Early Settlement) =====
// กฎ Pete เคาะ Wave 1 (band ตามงวดที่เหลือ) — ยังเก็บไว้เพื่อ backward-compat
// กฎ Pete เคาะ Wave 2 (15 ก.ค. 2026): เปลี่ยนเป็น matrix keyed by
//   (ชนิดสัญญา = จำนวนงวดทั้งสัญญา x จำนวนงวดที่จ่ายแล้ว)
//   - ฐานคิดส่วนลด (แก้ 9 ก.ย. 2026 — คุณเตยยืนยันกฎใหม่): คิดเฉพาะเงินต้นค้างของงวดที่ "ยังไม่ถึงกำหนด"
//     (dueDate >= closedAt) ด้วย Math.round(เงินต้นค้างงวดนั้น x %) — งวดที่เลยกำหนดแล้ว (dueDate < closedAt)
//     จ่ายเต็ม ไม่ได้ส่วนลด, ค่าปรับคิดเต็มไม่ลดเหมือนเดิม
//   - รองรับ manual override % (admin กรอกเอง แทนตาราง)
//   - เคสขยายเวลาแบบ "เพิ่มจำนวนงวด" (ext_type != 'due_day')
//     นับ row key + paidCount เฉพาะช่วงที่ขยายใหม่
//
// pure function ล้วน ไม่แตะ supabase
// (ลอกสไตล์ comment/Trace จาก outstandingExtras.ts / calc.ts)

/** ชั้นส่วนลด (Wave 1 — band): ถ้างวดที่เหลือ >= minRemaining
 *  ได้ส่วนลด percent% เก็บใน app_settings key 'settlement_tiers' เป็น JSON array
 *  @deprecated ถูกแทนที่ด้วย SettlementMatrix (Wave 2)
 *  เก็บ export ไว้ก่อนกันไฟล์อื่นที่ยังไม่อัปเดต build พัง
 *  ครีมจะสั่งลบทีหลังตอน db.ts/component ย้ายไป matrix ครบแล้ว */
export interface SettlementTier {
  minRemaining: number // เหลือกี่งวดขึ้นไปถึงเข้า band นี้
  percent: number      // ส่วนลด % ของเงินต้นที่เหลือ
}

/** เลือก % ส่วนลดตามจำนวนงวดที่เหลือ (Wave 1 — band)
 *  - หา band ที่ minRemaining มากสุดที่ยัง <= remainingCount
 *  - ไม่มี band ไหนเข้า → 0
 *  Trace (tiers = [{5,7},{10,10}]):
 *    remaining 3  → ไม่เข้า band ไหน  → 0
 *    remaining 5  → เข้า {5,7}        → 7
 *    remaining 10 → เข้า {10,10}      → 10
 *  @deprecated ใช้เฉพาะ fallback ตอนไม่มี matrix ส่งเข้า computeSettlement
 *  เคสใหม่ใช้ pickDiscountPercentMatrix */
export function pickDiscountPercent(remainingCount: number, tiers: SettlementTier[]): number {
  // เรียง minRemaining จากมากไปน้อย แล้วหยิบตัวแรกที่ remainingCount เข้าเกณฑ์
  const sorted = [...tiers].sort((a, b) => b.minRemaining - a.minRemaining)
  for (const t of sorted) {
    if (remainingCount >= t.minRemaining) return t.percent
  }
  return 0
}

/** ตารางส่วนลด (Wave 2 — matrix):
 *  key ชั้นนอก = จำนวนงวดทั้งสัญญา (termMonths, string),
 *  key ชั้นใน  = จำนวนงวดที่จ่ายแล้ว (paidCount, string) → ค่า = % ส่วนลด
 *  เก็บใน app_settings (โหลด/เซฟผ่าน db.ts — ไฟล์นี้ไม่แตะ supabase)
 *  Seed จาก Pete (15 ก.ค. 2026):
 *    3  งวด: {1:5}
 *    6  งวด: {1:10, 2:12, 3:12, 4:7}
 *    9  งวด: {1:10, 2:10, 3:12, 4:12, 5:12, 6:15, 7:7}
 *    12 งวด: {1:10, 2:10, 3:12, 4:12, 5:12, 6:12, 7:15, 8:15, 9:15, 10:7}
 *    15 งวด: {1:12, 2:12, 3:12, 4:15, 5:15, 6:15, 7:15, 8:15, 9:18, 10:18, 11:18, 12:18, 13:7}
 *  key ที่ไม่มีในตาราง (ทั้งแถวหรือแค่ช่อง) = 0%
 *  (paid=0 / เหลืองวดเดียว / term หลุดตาราง) */
export type SettlementMatrix = Record<string, Record<string, number>>

/** เลือก % ส่วนลดจาก matrix ตาม (rowTerm, paidCount)
 *  - แถว rowTerm ไม่มีในตาราง → 0 (ห้าม throw)
 *  - ช่อง paidCount ไม่มีในแถวนั้น → 0 (ห้าม throw)
 *  Trace (seed ด้านบน):
 *    (12, 3)  → แถว 12 มี paid 3 = 12%  → 12
 *    (12, 11) → แถว 12 ไม่มี paid 11    → 0
 *    (6, 0)   → แถว 6 ไม่มี paid 0      → 0
 *    (99, 5)  → ไม่มีแถว 99             → 0 */
export function pickDiscountPercentMatrix(
  rowTerm: number,
  paidCount: number,
  matrix: SettlementMatrix,
): number {
  const row = matrix[String(rowTerm)]
  if (!row) return 0
  const val = row[String(paidCount)]
  return typeof val === 'number' ? val : 0
}

/** ข้อมูลการขยายเวลาล่าสุดของสัญญา (ส่งเข้ามาเฉพาะเคสที่ต้องเช็ค — optional)
 *  ไม่ import type จาก db.ts ตรงๆ (ไฟล์นี้เป็น pure lib ไม่ผูกกับชั้นข้อมูล)
 *  caller (db.ts/component) map จาก ExtensionRecord ล่าสุดของสัญญามาเอง
 *  โดยฟิลด์ต้องตรงกับ contract_extensions.ext_type / contract_extensions.new_installments */
export interface SettlementExtensionInfo {
  extType: string // 'due_day' | 'months' | 'both' ตรงกับ ext_type; 'due_day' = เลื่อนวันชำระเฉยๆ ไม่นับเคสนี้
  newInstallments: number | null // new_installments — จำนวนงวดที่ขยายใหม่ (null = ไม่ได้เพิ่มงวด)
}

export interface SettlementInstallmentInput {
  amount: number       // ค่างวดเต็มของงวด
  paidAmount: number   // จ่ายสะสมแล้วของงวด (principal)
  penaltyAmount: number // ค่าปรับของงวด (ยอดตั้งดิบ — ยังไม่หักที่เก็บไปแล้ว)
  paidAt: string | null // null = ยังไม่ปิดงวด (รวมจ่ายบางส่วน — paidAmount > 0 แต่ paidAt ยัง null)
  dueDate: string       // วันครบกำหนดของงวด ('YYYY-MM-DD') — ใช้แยกงวดค้าง (เลยกำหนด) vs ยังไม่ถึงกำหนด
  installmentNo?: number // ลำดับงวด (1-based) — ใช้เฉพาะเคสขยายเวลาแบบเพิ่มจำนวนงวด
  id?: string           // id ของงวด — ใช้จับคู่กับ penaltyPaidByInstallmentId (netPenaltyDue) เท่านั้น optional
}

export interface SettlementResult {
  remainingPrincipal: number // เงินต้นที่เหลือ = Σ max(0, amount − paidAmount) ของงวดค้างทั้งหมด (ค้าง+ยังไม่ถึงกำหนด)
  remainingCount: number     // จำนวนงวดที่ยังค้าง (paidAt IS NULL) ทั้งหมด
  overdueRemaining: number      // เงินต้นค้างเฉพาะงวดที่เลยกำหนดแล้ว (dueDate < closedAt) — จ่ายเต็ม ไม่ลด
  overdueCount: number          // จำนวนงวดที่เลยกำหนดแล้ว
  discountableRemaining: number // เงินต้นค้างเฉพาะงวดที่ยังไม่ถึงกำหนด (dueDate >= closedAt) — ใช้เป็นฐานคิดส่วนลด
  discountableCount: number     // จำนวนงวดที่ยังไม่ถึงกำหนด
  percent: number            // ส่วนลด % ที่ได้ (matrix/tiers หรือ override)
  discount: number           // ส่วนลดเป็นบาท = round(discountableRemaining x percent/100)
  penaltyDue: number         // ค่าปรับค้างรวม "สุทธิ" (ไม่ลด แต่หักที่เก็บไปแล้วต่องวดแล้ว — กันเก็บซ้ำตอนปิด
                              // แก้ 2026-09-10, ดู netPenaltyDue ใน calc.ts / computeEarlyClose ใน earlyClose.ts)
  customerPays: number       // ลูกค้าจ่ายปิด = (remainingPrincipal − discount) + penaltyDue (penaltyDue สุทธิแล้ว)
  paidCount: number          // จำนวนงวดที่จ่ายแล้วจริง (นับตรงจาก paidAt !== null) — column key ของ matrix
  rowTerm: number            // row key จริงที่ใช้เลือก matrix (ปกติ = termMonths, ยกเว้นเคสขยายงวด = newInstallments)
  matched: boolean           // true = rowTerm มีในตาราง matrix จริง (false = term หลุดตาราง → UI ขึ้นเตือน)
  overridden: boolean        // true = ใช้ % ที่ admin กรอกเอง (overridePercent) แทนค่าจากตาราง/band
}

/** เช็คว่าเคสนี้เป็น "ขยายเวลาแบบเพิ่มจำนวนงวด" ที่ต้องนับ row/paidCount เฉพาะช่วงขยายใหม่หรือไม่
 *  เงื่อนไข: มี extension ส่งมา + extType ไม่ใช่ 'due_day' (แค่เลื่อนวันชำระ)
 *  + newInstallments ไม่ null + มี termMonths ปัจจุบันให้คำนวณ threshold
 *  ฐานจริงมีเคสเดียว (ณ 15 ก.ค. 2026): S00017PNQ067
 *  old_term 12, ขยายใหม่ 12 งวด, term_months กลายเป็น 16, จ่ายไปแล้ว 4 งวด (ก่อนขยาย)
 *  → rowTerm = 12, threshold = 16-12 = 4, paidCount (installmentNo > 4) = 0 → 0% */
function isExtendedInstallmentsCase(
  termMonths: number | undefined,
  extension: SettlementExtensionInfo | null | undefined,
): extension is SettlementExtensionInfo {
  return (
    !!extension &&
    extension.extType !== 'due_day' &&
    extension.newInstallments != null &&
    termMonths != null
  )
}

/** คิดยอดปิดสัญญาก่อนกำหนด
 *  สูตร (Pete เคาะ Wave 1-2, คุณเตยยืนยันกฎใหม่ 9 ก.ย. 2026 — ฐานคิดส่วนลดเปลี่ยนจากเดิม):
 *    remainingPrincipal     = Σ max(0, amount − paidAmount) ของงวด paidAt IS NULL ทั้งหมด (ค้าง+ยังไม่ถึงกำหนด)
 *    remainingCount         = นับงวด paidAt IS NULL ทั้งหมด
 *    overdueRemaining       = ผลรวมเดียวกัน เฉพาะงวดที่ dueDate <  closedAt (เลยกำหนดแล้ว) — จ่ายเต็ม ไม่ลด
 *    discountableRemaining  = ผลรวมเดียวกัน เฉพาะงวดที่ dueDate >= closedAt (ยังไม่ถึงกำหนด) — ฐานคิดส่วนลด
 *                             (overdueRemaining + discountableRemaining = remainingPrincipal เสมอ)
 *    paidCount              = นับงวด paidAt IS NOT NULL ตรงๆ
 *                             (ไม่คำนวณจาก termMonths − remainingCount)
 *                             ยกเว้นเคสขยายงวด → นับเฉพาะ installmentNo > (termMonths − newInstallments)
 *    rowTerm                = termMonths ปกติ ยกเว้นเคสขยายงวด → newInstallments
 *    percent                = overridePercent ถ้ามีส่งมา
 *                             ไม่งั้น pickDiscountPercentMatrix(rowTerm, paidCount, matrix) ถ้ามี matrix
 *                             ไม่งั้น (fallback wave เก่า) pickDiscountPercent(remainingCount, tiers)
 *    discount               = Math.round(discountableRemaining x percent/100)  ← เปลี่ยนจาก ceil(remainingPrincipal x ...)
 *    penaltyDue             = Σ max(0, penaltyAmount − penaltyPaidByInstallmentId[id]) ของงวด paidAt IS NULL
 *                             (สุทธิ — หักค่าปรับที่เก็บไปแล้วต่องวด กันเก็บซ้ำตอนปิด, แก้ 2026-09-10
 *                             ล็อกนิยามเดียวกับ netPenaltyDue ใน calc.ts / computeEarlyClose ใน earlyClose.ts
 *                             penaltyPaidByInstallmentId ไม่ส่งมา/ไม่มี id ตรงกัน → ถือว่ายังไม่เก็บอะไรเลย = penaltyAmount เดิม)
 *    customerPays           = (remainingPrincipal − discount) + penaltyDue   ← สูตรไม่เปลี่ยน (penaltyDue เป็นค่าสุทธิแล้ว)
 *
 *  ⚠️ ฟังก์ชันนี้ไม่ validate closedAt — ถ้า caller ส่ง '' หรือค่าที่ผิดรูปแบบมา string compare
 *     ('YYYY-MM-DD' < '' เป็น false เสมอ) จะทำให้ทุกงวดถูกนับเป็น "ยังไม่ถึงกำหนด" (ได้ส่วนลดหมดทั้งก้อน)
 *     caller ต้องรับผิดชอบส่งวันที่ปิดจริงที่ถูกต้องเสมอ ห้ามส่งค่าว่าง/placeholder
 */
/** Trace 1 — term12/paid3 → 12% (matrix seed, ไม่ผ่านขยายเวลา, ทุกงวดยังไม่ถึงกำหนด):
 *    12 งวด งวดละ 1000, จ่ายแล้ว 3 งวด (installmentNo 1-3), เหลือค้าง 9 งวด ไม่มีค่าปรับ
 *    closedAt เร็วกว่า dueDate ของทั้ง 9 งวดที่เหลือ (ยังไม่ถึงกำหนดทั้งหมด)
 *    paidCount=3, rowTerm=12(=termMonths), matrix[12][3]=12 → percent=12, matched=true
 *    remainingPrincipal=9000, overdueRemaining=0, discountableRemaining=9000
 *    discount=round(9000x0.12)=1080, penaltyDue=0, customerPays=7920
 *
 *  Trace 2 — term12/paid11 → 0% (เหลืองวดเดียว ไม่มีใน column ของแถว 12):
 *    จ่ายแล้ว 11/12 งวด เหลือค้าง 1 งวด (1000, ไม่มีค่าปรับ, ยังไม่ถึงกำหนด)
 *    paidCount=11, rowTerm=12, matrix[12][11] ไม่มี → percent=0, matched=true
 *    remainingPrincipal=1000, discountableRemaining=1000, discount=0, penaltyDue=0, customerPays=1000
 *
 *  Trace 3 — term6/paid0 → 0% (ยังไม่จ่ายงวดไหนเลย):
 *    6 งวด งวดละ 1000 ยังไม่จ่ายเลย เหลือค้างครบ 6 งวด (ยังไม่ถึงกำหนดทั้งหมด)
 *    paidCount=0, rowTerm=6, matrix[6][0] ไม่มี (แถว 6 เริ่มที่ 1) → percent=0, matched=true
 *    remainingPrincipal=6000, discount=0, penaltyDue=0, customerPays=6000
 *
 *  Trace 4 — term ไม่มีในตาราง → 0% + matched:false:
 *    termMonths=99 (ไม่มีในตารางเลย) → matrix[99] undefined → percent=0, matched=false
 *    UI ต้องขึ้นคำเตือน "ไม่มีตารางส่วนลดสำหรับสัญญางวด 99 เดือน"
 */
/** Trace 5 — งวดจ่ายบางส่วน (partial payment ไม่นับว่าจ่ายแล้ว):
 *    term12, งวด 4 จ่ายไปแล้ว paidAmount=500 (จาก 1000) แต่ paidAt ยังเป็น null
 *    → งวด 4 นับเป็น "ยังไม่จ่าย" ทั้งใน paidCount (ไม่รวม)
 *      และ remainingPrincipal (รวม max(0,1000-500)=500 เข้าเหลือค้าง)
 *    ถ้างวด 1-3 จ่ายเต็มแล้ว + งวด 4 จ่ายบางส่วน + งวด 5-12 ยังไม่แตะ:
 *    paidCount=3 (ไม่ใช่ 4), rowTerm=12 → percent=matrix[12][3]=12
 *
 *  Trace 6 — override (admin กรอก % เองแทนตาราง):
 *    term12/paid3 (ตารางให้ 12%) แต่ admin ใส่ overridePercent=20
 *    → percent=20, overridden=true, matched ยังคงคำนวณจากตารางไว้ (=true)
 *    discountableRemaining=9000 (สมมติเหมือน Trace1, ยังไม่ถึงกำหนดทั้งหมด) → discount=round(9000x0.20)=1800
 *
 *  Trace 7 — เคสขยายเวลา S00017PNQ067 (row key = งวดที่ขยายใหม่ ไม่ใช่ termMonths ปัจจุบัน):
 *    termMonths=16 (หลังขยาย), extension={extType:'months', newInstallments:12}
 *    installments 16 งวด: installmentNo 1-4 จ่ายแล้ว (ก่อนขยาย), 5-16 ยังไม่จ่าย
 *    isExtendedInstallmentsCase → true → rowTerm=12 (=newInstallments)
 *    threshold = 16-12 = 4 → paidCount = งวดที่ paidAt≠null และ installmentNo>4 = 0
 *    matrix[12][0] ไม่มี → percent=0, matched=true (แถว 12 มีจริง แค่ column 0 ไม่มี)
 *
 *  Trace 8 — งวดค้างชำระจริง (เลยกำหนด) ต้องจ่ายเต็ม ไม่ได้ส่วนลด (กฎใหม่ 9 ก.ย. 2026):
 *    term12, closedAt='2026-08-22', เหลือค้าง 9 งวด (งวดละ 1000 ไม่มีค่าปรับ):
 *      3 งวดแรก dueDate < closedAt (เลยกำหนดแล้ว) → overdueRemaining=3000
 *      6 งวดหลัง dueDate >= closedAt (ยังไม่ถึงกำหนด) → discountableRemaining=6000
 *    paidCount=3, rowTerm=12, matrix[12][3]=12 → percent=12
 *    discount=round(6000x0.12)=720 (ไม่ใช่ round(9000x0.12)=1080 แบบเดิม)
 *    remainingPrincipal=9000, customerPays=9000-720+0=8280 */
export function computeSettlement(input: {
  installments: SettlementInstallmentInput[]
  closedAt: string                // วันที่ปิดจริง ('YYYY-MM-DD') — ใช้แบ่งงวดค้าง (เลยกำหนด) vs ยังไม่ถึงกำหนด
  tiers?: SettlementTier[]        // Wave 1 fallback — ใช้เมื่อไม่มี matrix ส่งเข้ามา
  termMonths?: number             // จำนวนงวดทั้งสัญญาปัจจุบัน
  matrix?: SettlementMatrix       // Wave 2 — ตารางส่วนลดใหม่ (term x paidCount)
  extension?: SettlementExtensionInfo | null // ข้อมูลขยายเวลาล่าสุด (ถ้ามี)
  overridePercent?: number | null // admin กรอก % เอง (0-100) — มีค่า = ใช้แทนตาราง/band เสมอ
  penaltyPaidByInstallmentId?: Record<string, number> // ค่าปรับที่เก็บไปแล้วจริงต่องวด (key = installment.id)
                                                       // ไม่ส่งมา = ถือว่ายังไม่เก็บเลย (backward-compat กับ caller เดิม)
}): SettlementResult {
  // งวดที่ยังค้าง = paidAt เป็น null (รวมงวดจ่ายบางส่วนด้วย)
  const unpaid = input.installments.filter((i) => i.paidAt === null)

  // 1 loop เดียว แยกสะสม overdue (dueDate < closedAt) กับ discountable (dueDate >= closedAt)
  // เทียบด้วย string ตรงๆ ('YYYY-MM-DD') ห้ามแปลงเป็น Date (กัน timezone bug)
  // ปิดตรงวันครบกำหนดพอดี (dueDate === closedAt) นับว่า "ยังไม่ถึงกำหนด" (ได้ส่วนลด)
  let remainingPrincipal = 0
  let overdueRemaining = 0
  let overdueCount = 0
  let discountableRemaining = 0
  let discountableCount = 0
  for (const i of unpaid) {
    const owed = Math.max(0, (i.amount || 0) - (i.paidAmount || 0))
    remainingPrincipal += owed
    if (i.dueDate < input.closedAt) {
      overdueRemaining += owed
      overdueCount += 1
    } else {
      discountableRemaining += owed
      discountableCount += 1
    }
  }

  const remainingCount = unpaid.length
  // ค่าปรับค้างสุทธิ — หักค่าปรับที่เก็บไปแล้วต่องวด (กันเก็บซ้ำตอนปิด, แก้ 2026-09-10)
  // ไม่มี id ตรงกันใน map (หรือไม่ส่ง penaltyPaidByInstallmentId มาเลย) = ยังไม่เก็บอะไร = penaltyAmount เดิม
  const penaltyPaidMap = input.penaltyPaidByInstallmentId ?? {}
  const penaltyDue = unpaid.reduce((s, i) => {
    const paidForThis = i.id != null ? (penaltyPaidMap[i.id] ?? 0) : 0
    return s + Math.max(0, (i.penaltyAmount || 0) - paidForThis)
  }, 0)

  // rowTerm + paidCount: ปกติ vs เคสขยายเวลาเพิ่มงวด
  let rowTerm: number
  let paidCount: number
  if (isExtendedInstallmentsCase(input.termMonths, input.extension)) {
    const newInstallments = input.extension.newInstallments as number
    const termMonths = input.termMonths as number
    rowTerm = newInstallments
    const threshold = termMonths - newInstallments
    paidCount = input.installments.filter(
      (i) => i.paidAt !== null && (i.installmentNo ?? 0) > threshold,
    ).length
  } else {
    rowTerm = input.termMonths ?? 0
    paidCount = input.installments.filter((i) => i.paidAt !== null).length
  }

  // percent: override > matrix > tiers (fallback wave เก่า)
  let percent: number
  let matched: boolean
  let overridden = false

  if (input.matrix) {
    matched = Object.prototype.hasOwnProperty.call(input.matrix, String(rowTerm))
  } else {
    matched = true // ไม่มี matrix ส่งมา = ยังใช้โหมด band เดิม ไม่มีแนวคิด "term หลุดตาราง"
  }

  if (input.overridePercent != null) {
    percent = input.overridePercent
    overridden = true
  } else if (input.matrix) {
    percent = pickDiscountPercentMatrix(rowTerm, paidCount, input.matrix)
  } else {
    percent = pickDiscountPercent(remainingCount, input.tiers ?? [])
  }

  const discount = Math.round((discountableRemaining * percent) / 100)
  const customerPays = remainingPrincipal - discount + penaltyDue

  return {
    remainingPrincipal,
    remainingCount,
    overdueRemaining,
    overdueCount,
    discountableRemaining,
    discountableCount,
    percent,
    discount,
    penaltyDue,
    customerPays,
    paidCount,
    rowTerm,
    matched,
    overridden,
  }
}
