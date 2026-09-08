// ===== ป้ายสถานะงวดผ่อน สำหรับสัญญาเคสคืนเครื่อง (isReturned / isReturnedClosed) =====
//
// สกัดมาจาก logic ที่มีอยู่แล้วใน src/pages/ContractDetail.tsx (ตารางงวดผ่อน) เพื่อให้
// FollowUpModal แสดงผลตรงกับหน้ารายละเอียดสัญญาเป๊ะ — ห้ามคิดคำ/สีใหม่
//
// อ้างอิงต้นทาง (ContractDetail.tsx):
//   - เส้น ~717-730  : isReturned, reliableReturnDate, oldestUnpaidNo (ใช้ outstandingAfterReturn)
//   - เส้น ~1956-1965: returnedClosedUnpaid / returnPendingOldest / returnNotCollect / closedPending
//   - เส้น ~2049-2065: ป้าย Badge ต่องวด (ข้อความ + tone เป๊ะตามนี้ ห้ามเปลี่ยน)
//
// ทำไมแยกฟังก์ชันหางวด "ตามเก็บได้จริง" (findCollectibleInstallmentNo) ออกจาก outstandingAfterReturn เดิม:
// outstandingAfterReturn ต้องการ extraCharges + repairFee เพื่อคำนวณ "ยอดรวม" ที่ต้องปิด แต่สิ่งที่ใช้ตัดสินว่า
// "งวดไหนคืองวดที่ต้องตามเก็บ" ใช้แค่ installments + วันคืนที่เชื่อถือได้ (ไม่กระทบจาก extras/ค่าซ่อม) —
// FollowUpModal มี Installment[] อยู่แล้ว (ผ่าน getInstallments) แต่ไม่มี extraCharges/repairFee (ไม่ได้ query เพิ่ม
// ตามกฎ CLAUDE.md) จึงมิเรอร์เฉพาะส่วนที่จำเป็นออกมา ผลลัพธ์ installmentNo ที่ได้ต้องตรงกับ
// outstandingAfterReturn(...).details?.installmentNo (เมื่อไม่ถูก gate) เสมอ

import type { Installment } from './types'

export type ReturnedInstallmentTone = 'green' | 'amber' | 'red' | 'neutral'

export interface ReturnedInstallmentDisplay {
  /** ข้อความป้าย — ตรงคำเป๊ะกับ Badge ใน ContractDetail.tsx */
  label: string
  tone: ReturnedInstallmentTone
  /** true = งวดนี้ยังต้องตามเก็บจริง (ใช้ตัดสินสีแถว/ไฮไลต์ในตารางที่เรียกใช้) */
  collectible: boolean
}

export interface ReturnedContractContext {
  /** true เมื่อสถานะสัญญา = 'returned' (คืนเครื่องแล้วแต่ยังไม่ปิดยอด) */
  isReturned: boolean
  /** true เมื่อสถานะสัญญา = 'returned_closed' (คืนเครื่อง + ปิดยอดครบแล้ว)
   *  หมายเหตุ 2026-09-08: ปัจจุบันยังไม่มีจุดเรียก FollowUpModal ไหนส่งเคสนี้จริง
   *  (คิว freelancer กรอง returned_closed ออกไปแล้ว — ดู getFreelancerQueue ใน src/lib/db.ts)
   *  ใส่ไว้เผื่ออนาคต ถ้าจะโชว์เคสนี้ใน FollowUpModal ต้องขอ ContractSummary เพิ่ม field นี้จากน้องชีสก่อน */
  isReturnedClosed?: boolean
  /** installmentNo ของงวดที่ "ตามเก็บได้จริง" (ผลจาก findCollectibleInstallmentNo) — null = ไม่มีงวดต้องตามเก็บ */
  collectibleInstallmentNo: number | null
}

/** หา installmentNo ของงวดค้างเก่าสุดที่ "ตามเก็บได้จริง" หลังคืนเครื่อง
 *  mirror ส่วน gate ของ outstandingAfterReturn() (src/lib/outstandingExtras.ts) —
 *  ไม่ต้องใช้ extraCharges/repairFee เพราะไม่มีผลต่อว่างวดไหนตามเก็บได้ (มีผลแค่ยอดรวมที่ต้องปิด)
 *
 *  @param installments        งวดทั้งหมดของสัญญา
 *  @param reliableReturnDate  วันคืนเครื่องที่เชื่อถือได้ (yyyy-mm-dd) — ส่ง null ถ้าไม่รู้/ไม่เชื่อถือได้
 *                             (เคสก่อน RETURN_DATE_RELIABLE_FROM) เพื่อไม่ apply filter งวดอนาคต (พฤติกรรมเดิม)
 */
export function findCollectibleInstallmentNo(
  installments: Installment[],
  reliableReturnDate: string | null,
): number | null {
  const unpaid = installments.filter((i) => i.paidAt === null)
  if (unpaid.length === 0) return null

  const oldest = unpaid.reduce((min, i) => (i.dueDate < min.dueDate ? i : min))

  // คืนเครื่องก่อนถึงกำหนดงวดเก่าสุด → ยังไม่ถือว่าค้างจริง (งวด+ค่าปรับ = 0 ตาม outstandingAfterReturn)
  if (reliableReturnDate != null && oldest.dueDate > reliableReturnDate) return null

  const installmentAmount = Math.max(0, oldest.amount - (oldest.paidAmount || 0))
  const penaltyAmount = oldest.penaltyAmount || 0
  if (installmentAmount <= 0 && penaltyAmount <= 0) return null

  return oldest.installmentNo
}

/** ป้ายสถานะของงวดหนึ่งงวด เฉพาะสัญญาเคสคืนเครื่อง (isReturned / isReturnedClosed)
 *  คืน null เมื่อไม่ต้อง override ป้าย (เช่น งวดจ่ายแล้ว หรือสัญญาไม่ใช่เคสคืนเครื่อง) —
 *  ผู้เรียกใช้ fallback เป็นป้ายปกติของหน้าตัวเองต่อไป */
export function returnedInstallmentDisplay(
  installment: Pick<Installment, 'paidAt' | 'installmentNo'>,
  ctx: ReturnedContractContext,
): ReturnedInstallmentDisplay | null {
  if (installment.paidAt) return null
  if (!ctx.isReturned && !ctx.isReturnedClosed) return null

  if (ctx.isReturnedClosed) {
    return { label: 'ไม่เก็บแล้ว (ปิดเคสคืนเครื่อง)', tone: 'neutral', collectible: false }
  }
  if (installment.installmentNo === ctx.collectibleInstallmentNo) {
    return { label: 'ค้างชำระ', tone: 'amber', collectible: true }
  }
  return { label: 'ไม่เก็บแล้ว (คืนเครื่อง)', tone: 'neutral', collectible: false }
}
