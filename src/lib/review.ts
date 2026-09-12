// ===== Review-before-email flow (contract_review) — pure-function layer =====
// Owner-approved source: review-flow-mockup.html, owner-approved 2026-09-08 (by แบม)
// Pure functions — ไม่มี side effect, ไม่ import db.ts/supabase, testable ด้วย node -e

import { isGated } from './media'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * สถานะเคสในระบบตรวจก่อนส่งเมล
 * null (จากที่เก็บจริง) กินความหมาย 2 อย่าง — แยกกันด้วย postCutoff (isGated) ที่ caller คำนวณเอง:
 *   - สัญญาเก่าก่อน cutoff (postCutoff=false) -> ได้รับการยกเว้นทุกกฎ เหมือน 'approved'
 *   - สัญญาใหม่ที่ยังไม่กดส่งตรวจ (postCutoff=true) -> เทียบเท่า 'draft' ต้องถูกกฎเหมือนสถานะอื่น
 */
export type ReviewStatus = 'draft' | 'pending_review' | 'needs_fix' | 'approved'

export type ActorRole = 'staff' | 'admin'

export type ReviewAction = 'submit' | 'approve' | 'approve_and_send' | 'reject' | 'unapprove'

/** ป้ายสี badge — ใช้ map ไปสีจริงฝั่ง UI (วิวเลือกสีเอง ฟังก์ชันนี้ให้แค่ชนิด) */
export type ReviewTone = 'wait' | 'fix' | 'ok' | 'mute'

/** context ของการเปลี่ยนสถานะ ส่งเข้า nextStatus */
export interface NextStatusContext {
  actorRole: ActorRole
  reason?: string
  mediaComplete?: boolean
}

// ---------------------------------------------------------------------------
// canSubmitForReview — staff/admin กดปุ่ม "ส่งให้คุณเตยตรวจ" ได้ไหม
// ---------------------------------------------------------------------------

/**
 * ส่งตรวจได้จากสถานะ draft หรือ needs_fix เท่านั้น (resubmit หลังถูกตีกลับ)
 * ต้องส่งรูปครบก่อน (mediaEvaluation.complete จาก evaluateSlots() ใน src/lib/media.ts)
 * pending_review / approved -> false เสมอ (กันส่งซ้ำ/แหกรอบตรวจที่ทำไปแล้ว)
 */
export function canSubmitForReview(
  mediaEvaluation: { complete: boolean },
  currentStatus: ReviewStatus,
): boolean {
  if (currentStatus !== 'draft' && currentStatus !== 'needs_fix') return false
  return mediaEvaluation.complete === true
}

// ---------------------------------------------------------------------------
// canStaffEdit / canSendEmail
// ---------------------------------------------------------------------------

/**
 * staff แก้ไขสัญญา/อัปโหลดรูปได้ไหม
 * status===null (สัญญาเก่า) -> true เสมอ (ไม่ล็อก ตรงกับพฤติกรรมปัจจุบัน)
 * ล็อกเฉพาะตอน approved (แอดมินตรวจผ่านแล้ว ต่อให้ยังไม่ส่งเมลก็ล็อกทันที)
 */
export function canStaffEdit(status: ReviewStatus | null): boolean {
  return status !== 'approved'
}

/**
 * ปุ่มส่งเมล/บันทึกว่าส่งเอง กดได้ไหม (canSendEmail ที่ฝั่ง client + server ต้อง mirror กัน)
 * postCutoff ต้องคำนวณจาก isGated() ใน src/lib/media.ts ก่อนเรียก (ห้ามส่ง Contract ทั้งก้อนเข้ามาที่นี่ —
 * ฟังก์ชันนี้ต้องเป็น pure function ไม่ import db.ts/new Date() ดู ContractDetail.tsx: reviewPostCutoff เป็นตัวอย่าง)
 * postCutoff===false (สัญญาเก่าก่อน cutoff) -> true เสมอ ไม่ gate เลย ไม่ว่า status จะเป็นอะไร
 * postCutoff===true (สัญญาใหม่) -> ต้อง status==='approved' เท่านั้น — null ในยุคนี้คือ draft ที่ยังไม่ส่งตรวจ ต้อง block ด้วย
 * ไม่มี bypass สำหรับ staff หรือ timeout ใดๆ (ล็อกตาม spec — ห้ามเพิ่ม branch ที่ 3)
 */
export function canSendEmail(status: ReviewStatus | null, postCutoff: boolean): boolean {
  if (!postCutoff) return true
  return status === 'approved'
}

// ---------------------------------------------------------------------------
// canMarkSummary / summaryBlockReason — เกทกดสรุปยอดส่งร้าน (ห้ามโอนเงินก่อนตรวจ, ล็อกคุณเตย 2026-09-12)
// ---------------------------------------------------------------------------

/**
 * กดปุ่ม "สรุปยอดส่งร้าน" ได้ไหม — mental model เดียวกับ canSendEmail เป๊ะ (จงใจลอกโครง เพื่อไม่ให้คนอ่านโค้ดงง)
 * postCutoff ต้องคำนวณจาก isGated() ก่อนเรียก (ดู canSendEmail ด้านบน — วิธีคำนวณเหมือนกันทุกประการ)
 * postCutoff===false (สัญญาเก่าก่อน cutoff) -> true เสมอ ไม่ gate เลย ไม่ว่า status จะเป็นอะไร
 * postCutoff===true (สัญญาใหม่) -> ต้อง status==='approved' เท่านั้น — null/'draft' ในยุคนี้ต้อง block ด้วย
 * ห้ามมี branch ที่ 3 (ไม่มี bypass staff/timeout ใดๆ — ตาม canSendEmail)
 */
export function canMarkSummary(status: ReviewStatus | null, postCutoff: boolean): boolean {
  if (!postCutoff) return true
  return status === 'approved'
}

/**
 * ข้อความอธิบายให้พนักงานเห็นตอนกดสรุปยอดไม่ได้ (คืน null ถ้ากดได้ — ค่าตรงข้ามกับ canMarkSummary เสมอคู่กัน)
 * ข้อความล็อกแล้ว (คุณเตยเคาะ 2026-09-12) ต้องตรงเป๊ะกับข้อความฝั่งฐานข้อมูล (RPC guard ที่น้องชีสเขียน) — ห้ามแต่งใหม่
 * status===null หรือ 'draft' (ยังไม่เคยส่งตรวจ) นับเป็นกลุ่มเดียวกัน — DB จริงเก็บเป็น null เท่านั้น
 * ('draft' ไม่ถูก persist แต่ type ยอมรับไว้เผื่อ caller ส่ง state จาก nextStatus() ผ่านมาตรงๆ)
 */
export function summaryBlockReason(status: ReviewStatus | null, postCutoff: boolean): string | null {
  if (!postCutoff) return null
  if (status === 'approved') return null
  if (status === 'pending_review') return REVIEW_SUMMARY_BLOCK_PENDING
  if (status === 'needs_fix') return REVIEW_SUMMARY_BLOCK_NEEDS_FIX
  return REVIEW_SUMMARY_BLOCK_NOT_SUBMITTED
}

export const REVIEW_SUMMARY_BLOCK_NOT_SUBMITTED =
  'เคสนี้ยังไม่ได้ส่งให้ตรวจ — เปิดสัญญาแล้วกดปุ่ม "ส่งให้คุณเตยตรวจ" ก่อนนะคะ'
export const REVIEW_SUMMARY_BLOCK_PENDING = 'เคสนี้รอคุณเตยตรวจอยู่ ยังสรุปยอดไม่ได้ค่ะ'
export const REVIEW_SUMMARY_BLOCK_NEEDS_FIX =
  'เคสนี้ต้องแก้ไขก่อน — ดูเหตุผลที่แจ้งไว้ในสัญญา แก้แล้วส่งตรวจใหม่นะคะ'

// ---------------------------------------------------------------------------
// buildTonightSummary — สรุปงานค้างตรวจแยกตามร้าน (หน้ารอสรุปยอด ใช้เตือนก่อนเข้าเมนูโอนเงิน)
// ---------------------------------------------------------------------------

/** แถวดิบต่อสัญญา ที่ buildTonightSummary ใช้ตัด (caller ดึงจาก getContracts/status view เอง) */
export interface TonightSummaryRow {
  shopId: string
  shopCode: string
  createdAt: string | null
  reviewStatus: ReviewStatus | null
}

/** ยอดนับ 1 ชุด (ใช้ทั้งต่อร้าน และรวมทั้งกล่องใน totals) */
export interface TonightSummaryCounts {
  total: number
  waitingReview: number // pending_review + postCutoff
  needsFix: number // needs_fix + postCutoff
  notSubmitted: number // null/'draft' + postCutoff (ยังไม่กดส่งตรวจเลย)
  ready: number // สรุปยอดได้แล้ว: postCutoff=false (สัญญาเก่า ได้รับการยกเว้น) หรือ approved
}

export interface TonightSummaryShopRow extends TonightSummaryCounts {
  shopId: string
  shopCode: string
}

export interface TonightSummary {
  shops: TonightSummaryShopRow[]
  totals: TonightSummaryCounts
}

/**
 * รวมเคสค้างตรวจของคืนนี้ แยกตามร้าน เรียง waitingReview มาก->น้อย แล้ว shopCode ก-ฮ/A-Z (localeCompare)
 * เคสก่อน gateFrom (postCutoff=false จาก isGated) ไม่ต้องตรวจตามกฎ -> นับเป็น ready เสมอ ไม่ว่า reviewStatus จะเป็นอะไร
 * เคสหลัง gateFrom (postCutoff=true) กระจายนับตาม reviewStatus: approved->ready, pending_review->waitingReview,
 * needs_fix->needsFix, null/'draft'->notSubmitted
 * rows ว่าง -> {shops:[], totals: ทุกช่อง 0} (caller เช็คเองว่าจะซ่อนกล่องนี้ทั้งกล่องหรือไม่)
 * ไม่อ่านนาฬิกาเอง — gateFrom มาจาก caller (app_settings.media_gate_from ผ่าน db.ts) ใช้ isGated ตัวเดียวกับทั้งเว็บ
 * (ป้ายเตือน/badge ที่ใช้ตัวเลขพวกนี้ วิวไปคำนวณสีเอง — ฟังก์ชันนี้ให้แค่ตัวนับ)
 */
export function buildTonightSummary(rows: TonightSummaryRow[], gateFrom: string): TonightSummary {
  const byShop = new Map<string, TonightSummaryShopRow>()

  for (const row of rows) {
    let bucket = byShop.get(row.shopId)
    if (!bucket) {
      bucket = {
        shopId: row.shopId,
        shopCode: row.shopCode,
        total: 0,
        waitingReview: 0,
        needsFix: 0,
        notSubmitted: 0,
        ready: 0,
      }
      byShop.set(row.shopId, bucket)
    }

    bucket.total += 1
    const postCutoff = isGated({ createdAt: row.createdAt }, gateFrom)
    if (!postCutoff) {
      bucket.ready += 1
    } else if (row.reviewStatus === 'approved') {
      bucket.ready += 1
    } else if (row.reviewStatus === 'pending_review') {
      bucket.waitingReview += 1
    } else if (row.reviewStatus === 'needs_fix') {
      bucket.needsFix += 1
    } else {
      bucket.notSubmitted += 1
    }
  }

  const shops = Array.from(byShop.values()).sort((a, b) => {
    if (b.waitingReview !== a.waitingReview) return b.waitingReview - a.waitingReview
    return a.shopCode.localeCompare(b.shopCode)
  })

  const totals: TonightSummaryCounts = {
    total: 0,
    waitingReview: 0,
    needsFix: 0,
    notSubmitted: 0,
    ready: 0,
  }
  for (const s of shops) {
    totals.total += s.total
    totals.waitingReview += s.waitingReview
    totals.needsFix += s.needsFix
    totals.notSubmitted += s.notSubmitted
    totals.ready += s.ready
  }

  return { shops, totals }
}

// ---------------------------------------------------------------------------
// nextStatus — state machine เดียวที่คุมทุกทาง เปลี่ยนสถานะ
// ---------------------------------------------------------------------------

/**
 * คำนวณสถานะถัดไปจาก action ปัจจุบัน หรือคืน error string (ภาษาไทย) ถ้า transition ไม่ถูกต้อง
 * เรียก error ทุกครั้งที่: role ผิด (staff ทำงานที่ admin เท่านั้นทำได้), current status ไม่ตรงกับ action,
 * หรือ action ต้องมี reason แต่ reason ว่าง/ไม่ส่งมา
 * ไม่มี side effect — ไม่ set submitted_at/reviewed_at/ฯลฯ ตรงนี้ (หน้าที่ของชั้น db/RPC)
 *
 * หมายเหตุ caller: ผลลัพธ์เป็น ReviewStatus หรือ string ข้อความ error — เช็คว่าเป็นหนึ่งใน
 * 'draft' | 'pending_review' | 'needs_fix' | 'approved' ก่อนใช้เป็นสถานะจริง ถ้าไม่ตรงคือ error
 */
export function nextStatus(
  current: ReviewStatus,
  action: ReviewAction,
  ctx: NextStatusContext,
): ReviewStatus | string {
  const { actorRole, reason, mediaComplete } = ctx

  if (action === 'submit') {
    if (current !== 'draft' && current !== 'needs_fix') {
      return 'ส่งตรวจได้เฉพาะเคสที่ยังไม่ส่งตรวจ หรือถูกตีกลับให้แก้ไขเท่านั้น'
    }
    if (mediaComplete !== true) {
      return 'แนบรูปให้ครบทุกช่องก่อน จึงส่งตรวจได้'
    }
    return 'pending_review'
  }

  if (action === 'reject') {
    if (actorRole !== 'admin') return 'เฉพาะแอดมินเท่านั้นที่ตีกลับเคสได้'
    if (current !== 'pending_review') return 'ตีกลับได้เฉพาะเคสที่อยู่ในสถานะรอตรวจ'
    if (!reason || reason.trim() === '') return 'ต้องกรอกเหตุผลที่ต้องแก้ไข'
    return 'needs_fix'
  }

  if (action === 'approve' || action === 'approve_and_send') {
    if (actorRole !== 'admin') return 'เฉพาะแอดมินเท่านั้นที่ตรวจผ่านเคสได้'
    if (current !== 'pending_review') return 'ตรวจผ่านได้เฉพาะเคสที่อยู่ในสถานะรอตรวจ'
    return 'approved'
  }

  if (action === 'unapprove') {
    if (actorRole !== 'admin') return 'เฉพาะแอดมินเท่านั้นที่ยกเลิกการตรวจได้'
    if (current !== 'approved') return 'ยกเลิกการตรวจได้เฉพาะเคสที่ตรวจผ่านแล้ว'
    if (!reason || reason.trim() === '') return 'ต้องกรอกเหตุผลที่ยกเลิกการตรวจ'
    return 'needs_fix'
  }

  return 'การกระทำไม่ถูกต้อง'
}

// ---------------------------------------------------------------------------
// reviewAgeDays — อายุเคส (ค้างมากี่วัน)
// ---------------------------------------------------------------------------

/**
 * นับจำนวนวันเต็ม (floor) จาก sinceISO ถึง nowISO
 * sinceISO อยู่ในอนาคตเทียบกับ nowISO -> clamp เป็น 0 (ไม่ติดลบ)
 */
export function reviewAgeDays(sinceISO: string, nowISO: string): number {
  const sinceMs = new Date(sinceISO).getTime()
  const nowMs = new Date(nowISO).getTime()
  const days = Math.floor((nowMs - sinceMs) / (24 * 60 * 60 * 1000))
  return Math.max(0, days)
}

/**
 * แปลงจำนวนวัน (จาก reviewAgeDays) เป็นข้อความป้ายอายุเคส (section 2)
 * น้อยกว่า 1 วัน -> "ค้างมาไม่ถึง 1 วัน" ; อื่นๆ -> "ค้างมา N วัน"
 */
export function reviewAgeLabel(days: number): string {
  if (days < 1) return 'ค้างมาไม่ถึง 1 วัน'
  return 'ค้างมา ' + days + ' วัน'
}

// ---------------------------------------------------------------------------
// reviewStatusLabel / reviewStatusTone — ป้ายสถานะ (Thai badge)
// ---------------------------------------------------------------------------

/**
 * ข้อความป้ายสถานะภาษาไทย (section 2)
 * status===approved คืนข้อความ "ยังไม่ส่งเมล" เป็นค่าเริ่มต้น (ฟังก์ชันนี้ไม่รู้เรื่อง emailSentAt) —
 * หน้าเว็บที่มีข้อมูล emailSentAt ให้เลือกใช้ REVIEW_BADGE_APPROVED_SENT เองแทนเมื่อมีการส่งเมลแล้ว
 */
export function reviewStatusLabel(status: ReviewStatus | null): string {
  if (status === null) return REVIEW_BADGE_LEGACY
  if (status === 'draft') return REVIEW_BADGE_DRAFT
  if (status === 'pending_review') return REVIEW_BADGE_PENDING
  if (status === 'needs_fix') return REVIEW_BADGE_NEEDS_FIX
  return REVIEW_BADGE_APPROVED_NOT_SENT
}

/** โทนสี badge (section 2): wait=เหลือง fix=แดง ok=เขียว mute=เทา */
export function reviewStatusTone(status: ReviewStatus | null): ReviewTone {
  if (status === null) return 'mute'
  if (status === 'draft') return 'mute'
  if (status === 'pending_review') return 'wait'
  if (status === 'needs_fix') return 'fix'
  return 'ok'
}

// ---------------------------------------------------------------------------
// UI copy strings (section 2) — วิวอิมพอร์ตจากที่นี่ ห้ามพิมพ์ข้อความเองซ้ำ
// ---------------------------------------------------------------------------

export const REVIEW_BTN_SUBMIT = 'ส่งให้คุณเตยตรวจ'
export const REVIEW_TOOLTIP_SUBMIT_DISABLED = 'แนบรูปให้ครบทุกช่องก่อน จึงส่งตรวจได้'
export const REVIEW_BTN_APPROVE_AND_SEND = '✓ ตรวจแล้ว ส่งเมลเลย'
export const REVIEW_BTN_APPROVE_ONLY = '✓ ตรวจแล้ว ยังไม่ส่ง'
export const REVIEW_BTN_REJECT = '✎ ต้องแก้ไข'
export const REVIEW_LABEL_REJECT_REASON = 'เหตุผลที่ต้องแก้ไข (บังคับกรอก)'
export const REVIEW_PLACEHOLDER_REJECT_REASON =
  'เช่น รูปใบเสร็จเบลอ อ่านยอดไม่ออก, เลขสัญญาในเอกสารไม่ตรงกับที่คีย์'
export const REVIEW_LOCKED_MESSAGE = 'เคสนี้ตรวจผ่านแล้ว แก้ไขไม่ได้ ถ้าต้องแก้ แจ้งแอดมิน'
export const REVIEW_BTN_UNAPPROVE = 'ยกเลิกการตรวจ ส่งกลับให้แก้'
export const REVIEW_CONFIRM_UNAPPROVE =
  'เคสนี้จะกลับไปเป็น ต้องแก้ไข พนักงานจะแก้ไขข้อมูลหรือรูปได้อีกครั้ง'
export const REVIEW_LABEL_UNAPPROVE_REASON = 'เหตุผลที่ยกเลิกการตรวจ (บังคับกรอก)'
export const REVIEW_WARNING_EMAIL_ALREADY_SENT = 'เมลออกไปแล้ว แก้เสร็จต้องส่งใหม่'
export const REVIEW_MENU_BADGE_STAFF =
  'งานที่ต้องแก้ — ตัวเลขสีแดง คือจำนวนเคสของตัวเองที่เป็นต้องแก้ไข'
export const REVIEW_MENU_BADGE_ADMIN =
  'ตรวจเคสก่อนส่งบริษัท — ตัวเลขสีแดง คือจำนวนเคสรอตรวจทั้งหมด'
export const REVIEW_BADGE_DRAFT = 'ยังไม่ส่งตรวจ'
export const REVIEW_BADGE_PENDING = 'รอตรวจ'
export const REVIEW_BADGE_NEEDS_FIX = 'ต้องแก้ไข'
export const REVIEW_BADGE_APPROVED_NOT_SENT = 'ตรวจแล้ว ยังไม่ส่ง'
export const REVIEW_BADGE_APPROVED_SENT = 'ตรวจแล้ว ส่งเมลแล้ว'
export const REVIEW_BADGE_LEGACY = 'ไม่มีข้อมูล'
export const REVIEW_TOAST_SUBMIT = 'ส่งให้คุณเตยตรวจแล้ว'
export const REVIEW_TOAST_APPROVE_ONLY = 'ตรวจผ่านแล้ว ยังไม่ส่งเมล'
export const REVIEW_TOAST_APPROVE_SEND_OK = 'ตรวจผ่านแล้ว ส่งเมลสำเร็จ'
export const REVIEW_TOAST_APPROVE_SEND_FAIL =
  'ตรวจผ่านแล้ว แต่ส่งเมลไม่สำเร็จ กดส่งอีกครั้งได้ที่หน้ารอส่งอีเมล'
export const REVIEW_TOAST_REJECT = 'ตีกลับให้แก้ไขแล้ว'
export const REVIEW_TOAST_UNAPPROVE = 'ยกเลิกการตรวจแล้ว เคสกลับไปที่ ต้องแก้ไข'
export const REVIEW_TOAST_RESUBMIT = 'แก้ไขแล้ว ส่งตรวจอีกครั้ง'

/** กระดิ่งแจ้งแอดมิน: staffName + " ส่งเคส " + contractNo + " มาให้ตรวจ" */
export function reviewBellTextAdmin(staffName: string, contractNo: string): string {
  return staffName + ' ส่งเคส ' + contractNo + ' มาให้ตรวจ'
}

/** กระดิ่งแจ้ง staff ตอนถูกตีกลับ: adminName + " ตีกลับเคส " + contractNo + " ต้องแก้ไข" */
export function reviewBellTextStaff(adminName: string, contractNo: string): string {
  return adminName + ' ตีกลับเคส ' + contractNo + ' ต้องแก้ไข'
}

// ===========================================================================
// Trace tests (verify ด้วย node -e ผ่าน tsc transpile — repo ไม่มี vitest)
// ===========================================================================
//
// canSubmitForReview:
// (1) {complete:true}, 'draft' -> true
// (2) {complete:false}, 'draft' -> false
// (3) {complete:true}, 'approved' -> false (ล็อกแล้ว ห้าม resubmit ผ่านรอบตรวจ)
// (4) {complete:true}, 'pending_review' -> false (ส่งตรวจซ้ำไม่ได้ระหว่างรอตรวจ)
// (5) {complete:true}, 'needs_fix' -> true (resubmit หลังถูกตีกลับ)
//
// canStaffEdit / canSendEmail:
// (6) canStaffEdit('pending_review') -> true ; canStaffEdit('approved') -> false ; canStaffEdit(null) -> true
// (7) canSendEmail(null, false) -> true ; canSendEmail('pending_review', false) -> true (สัญญาเก่า ไม่ gate เลย)
//     canSendEmail(null, true) -> false (draft ยุคใหม่ ต้อง block) ; canSendEmail('pending_review', true) -> false
//     canSendEmail('needs_fix', true) -> false ; canSendEmail('approved', true) -> true ; canSendEmail('approved', false) -> true
//
// nextStatus:
// (8)  ('pending_review','approve_and_send',{actorRole:'admin'}) -> 'approved'
// (9)  ('pending_review','reject',{actorRole:'admin',reason:''}) -> error string (ต้องกรอกเหตุผล...)
// (10) ('pending_review','reject',{actorRole:'admin',reason:'รูปเบลอ'}) -> 'needs_fix'
// (11) ('approved','unapprove',{actorRole:'staff',reason:'x'}) -> error string (เฉพาะแอดมิน...)
// (12) ('draft','approve',{actorRole:'admin'}) -> error string (invalid: draft ข้ามตรงไป approved ไม่ได้)
// (13) ('draft','submit',{actorRole:'staff',mediaComplete:true}) -> 'pending_review'
// (14) ('draft','submit',{actorRole:'staff',mediaComplete:false}) -> error string (แนบรูปให้ครบ...)
// (15) ('needs_fix','submit',{actorRole:'admin',mediaComplete:true}) -> 'pending_review'
//
// reviewAgeDays:
// (16) '2026-09-05T10:00:00Z' -> '2026-09-08T10:00:00Z' -> 3
// (17) sinceISO อยู่ในอนาคตกว่า nowISO -> 0 (clamp ไม่ติดลบ)
//
// reviewAgeLabel:
// (18) 0 -> 'ค้างมาไม่ถึง 1 วัน'
// (19) 5 -> 'ค้างมา 5 วัน'
//
// reviewStatusLabel / reviewStatusTone:
// (20) reviewStatusLabel(null) -> 'ไม่มีข้อมูล' ; reviewStatusTone(null) -> 'mute'
// (21) reviewStatusLabel('pending_review') -> 'รอตรวจ' ; reviewStatusTone('pending_review') -> 'wait'
// (22) reviewStatusLabel('needs_fix') -> 'ต้องแก้ไข' ; reviewStatusTone('needs_fix') -> 'fix'
// (23) reviewStatusLabel('approved') -> 'ตรวจแล้ว ยังไม่ส่ง' (ค่าเริ่มต้น) ; reviewStatusTone('approved') -> 'ok'
//
// canMarkSummary / summaryBlockReason (เกทกดสรุปยอดส่งร้าน, ล็อกคุณเตย 2026-09-12):
// (24) canMarkSummary(null, false) -> true ; canMarkSummary('pending_review', false) -> true (สัญญาเก่า ไม่ gate เลย)
// (25) canMarkSummary(null, true) -> false ; canMarkSummary('pending_review', true) -> false
//      canMarkSummary('needs_fix', true) -> false ; canMarkSummary('approved', true) -> true ; canMarkSummary('approved', false) -> true
// (26) summaryBlockReason(null, false) -> null ; summaryBlockReason('pending_review', false) -> null (สัญญาเก่า สรุปได้เสมอ)
// (27) summaryBlockReason(null, true) -> REVIEW_SUMMARY_BLOCK_NOT_SUBMITTED (ยังไม่ส่งตรวจ)
// (28) summaryBlockReason('pending_review', true) -> REVIEW_SUMMARY_BLOCK_PENDING
// (29) summaryBlockReason('needs_fix', true) -> REVIEW_SUMMARY_BLOCK_NEEDS_FIX
// (30) summaryBlockReason('approved', true) -> null
//
// buildTonightSummary (gateFrom='2026-09-10'):
// (31) ร้าน AQ S00016 3 แถว: createdAt='2026-09-05'(ก่อน cutoff, status=null) + createdAt='2026-09-11'(status='pending_review')
//      + createdAt='2026-09-11'(status='needs_fix')
//      -> {shopId:'AQ', shopCode:'AQ S00016', total:3, waitingReview:1, needsFix:1, notSubmitted:0, ready:1}
// (32) ร้าน BB S00099 2 แถว: createdAt='2026-09-12'(status=null, ยังไม่ส่งตรวจ) + createdAt='2026-09-12'(status='approved')
//      -> {shopId:'BB', shopCode:'BB S00099', total:2, waitingReview:0, needsFix:0, notSubmitted:1, ready:1}
// (33) createdAt='2026-09-10' (เท่ากับ gateFrom เป๊ะ) status=null -> isGated ใช้ >= -> postCutoff=true -> notSubmitted:1 (ไม่ใช่ ready)
// (34) รวม (31)+(32) เข้า rows เดียวกัน -> shops เรียง AQ ก่อน BB (waitingReview 1 > 0)
//      -> totals = {total:5, waitingReview:1, needsFix:1, notSubmitted:1, ready:2}
// (35) rows=[] -> {shops:[], totals:{total:0,waitingReview:0,needsFix:0,notSubmitted:0,ready:0}}
