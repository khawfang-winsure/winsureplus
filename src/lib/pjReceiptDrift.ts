// ===== ตรวจจับ "ใบเสร็จ PJ ที่หาย/ถูกแก้" (drift detection) — pure function ล้วน ไม่แตะ supabase =====
// บั๊กต้นเรื่อง (16 ก.ค. 2026): pj-sync ดึงเงิน "เข้า" อย่างเดียว ไม่เคยย้อนถามว่าใบที่เคยดึงมา
// ยังอยู่ใน PJ ไหม ร้านลบ/แก้ใบใน PJ ภายหลัง → เว็บเรากอดใบผีไว้ = เงินเฟ้อ + ลงผิดงวด
// กวาดมือ 13–16 ก.ค. เจอ 3 แบบที่ร้านแก้ได้: ลบใบ / เปลี่ยนประเภท (installment→other) / เปลี่ยนวันที่
//
// Pete locked: ฟังก์ชันนี้ "ตรวจ + รายงานเท่านั้น" ห้ามถอนเงิน/แก้ยอดเอง — ผลลัพธ์ที่ report=true
// ต้องไปเข้ากล่องรอตรวจ (reuse ตาราง pj_sync_review, reason RECEIPT_MISSING/RECEIPT_CHANGED) ให้คนตัดสิน
//
// เรียก "RECEIPT_MISSING" ไม่ใช่ "DELETED" เพราะ absence ไม่เท่ากับ deletion — ใบอาจแค่หลุด window ที่ดึงมา
// (ร้านเลื่อนวันที่ในใบ ทำให้ pjPaidDate เดิมของเราไม่ตรงกับที่ PJ โชว์แล้ว) แต่ action ของคนเหมือนกัน
// คือเปิด PJ ดูแล้วตัดสินเอง

import type { PjSyncReviewReason } from './types'

export const COVERAGE_FLOOR_ISO = '2026-07-13T00:00:00.000Z'
export const SETTLE_MARGIN_MS = 30 * 60 * 1000
export const MISSING_STREAK_THRESHOLD = 2
export const RUN_SANITY_MIN_RATIO = 0.5

export type DriftKind = 'missing' | 'amount' | 'type' | 'date'

/** ใบเสร็จที่เราถืออยู่ (จาก pj_applied_receipts ของเรา) ณ ก่อนรันตรวจรอบนี้ */
export interface OurReceipt {
  /** uuid ดิบจาก PJ (field "uuid" ใน raw_json) — คีย์เทียบหลัก */
  uuid: string
  amount: number
  /** ประเภทที่เราจดไว้ตอน apply ('installment' | 'penalty' | 'other') */
  paymentType: string
  /** วันที่ PJ รายงานตอนเราดึงมา ('YYYY-MM-DD') */
  pjPaidDate: string
  /** ISO timestamp ตอนเรา apply ใบนี้ (ไว้กัน settle margin + coverage floor) */
  appliedAt: string
  /** จำนวนรอบติดกัน "ก่อนหน้ารอบนี้" ที่หา uuid นี้ไม่เจอใน PJ แล้ว — 0 = ปกติ/ยังไม่เคยหาย */
  missingStreak: number
}

/** 1 แถวใน snapshot ที่ดึงจาก PJ มาสำหรับรอบตรวจนี้ */
export interface PjSnapshotRow {
  uuid: string
  amount: number
  paymentType: string
  pjPaidDate: string
}

/** บริบทของรอบตรวจนี้ */
export interface DriftEvalContext {
  /** ISO timestamp ตอนรันตรวจรอบนี้ (ปกติ = now() ตอน cron ทำงาน) */
  snapshotAt: string
  /** ขอบเขตล่างของช่วงวันที่ที่ดึง PJ มารอบนี้ ('YYYY-MM-DD', inclusive) */
  windowStart: string
  /** ขอบเขตบนของช่วงวันที่ที่ดึง PJ มารอบนี้ ('YYYY-MM-DD', inclusive) */
  windowEnd: string
}

/** ก้อนข้อมูล "เราถือ X / PJ ว่า Y" ต่อฝั่ง — ใช้ทั้งใน DriftVerdict.detail และ raw_json ที่ lock ไว้ */
export interface DriftSide {
  amount: number
  paymentType: string
  pjPaidDate: string
}

export interface DriftVerdict {
  uuid: string
  /** null = ยังไม่ตัดสิน (ข้อมูลไม่พอ/เสี่ยง false positive) — ไม่ใช่ "ตรวจแล้วไม่พบ drift" */
  kind: DriftKind | null
  /** true = ต้องส่งเข้ากล่องรอตรวจให้คนดู (high confidence พอ) */
  report: boolean
  /** ค่า missingStreak รอบถัดไป — เก็บกลับไปที่ OurReceipt.missingStreak ของรอบถัดไป */
  nextMissingStreak: number
  /** มีเฉพาะตอน kind ไม่ใช่ null และเจอ drift จริง (amount/type/date) หรือ kind='missing' */
  detail?: {
    ours: DriftSide
    /** null เฉพาะ kind='missing' (หา uuid ไม่เจอใน PJ เลย) */
    pj: DriftSide | null
  }
}

/** normalize ประเภทก่อนเทียบ (กันช่องว่าง/ตัวพิมพ์ต่างกันโดยไม่มีความหมายทางธุรกิจ) */
function normalizeType(t: string): string {
  return t.trim().toLowerCase()
}

/**
 * ตัดสิน drift ของ "1 ใบเสร็จ" ที่เราถืออยู่ เทียบกับ snapshot PJ ที่ดึงมารอบนี้
 *
 * ลำดับกฎ (ตามที่พี่ดิววาง):
 * 1) ไม่ตัดสิน (kind=null, report=false, streak ไม่เปลี่ยน) เมื่อเข้าเงื่อนไขใดเงื่อนไขหนึ่ง:
 *    - settle margin: appliedAt ใหม่กว่า snapshotAt ลบ 30 นาที (อาจเป็น race กับ apply path เอง)
 *    - นอก window: pjPaidDate ของเราไม่อยู่ในช่วง [windowStart, windowEnd] ที่ดึงมารอบนี้
 *    - ก่อน coverage floor: appliedAt < 2026-07-13 (ก่อนหน้านั้นไม่มี uuid ให้เทียบเป็นเนื้อเดียวกัน)
 * 2) เจอ uuid ใน PJ → nextMissingStreak รีเซ็ตเป็น 0 เสมอ (ไม่ว่าค่าจะตรงกันหรือไม่)
 *    เทียบตามลำดับ: amount (ต่าง > 0.01) → type (normalize แล้วต่าง) → date (ต่าง)
 *    เจอต่างข้อไหนก่อน → kind นั้น, report=true ทันที (high confidence เพราะเทียบตรง uuid)
 * 3) ไม่เจอ uuid ใน PJ เลย → nextMissingStreak = missingStreak + 1, kind='missing' เสมอ
 *    (แม้ report=false ก็ยัง kind='missing' ไว้ ให้ผู้เรียกเก็บ streak ต่อได้)
 *    report=true ต่อเมื่อ nextMissingStreak >= 2 เท่านั้น (low confidence รอบแรก — PJ อาจตอบไม่ครบชั่วคราว)
 *
 * ---- Trace tests (coverage floor = 2026-07-13, settle margin = 30 นาที) --------------------
 *
 * (ก) ปรียานุช missing streak — ใบ 5,379 ถูกลบออกจาก PJ จริง
 *   ours = { uuid:'preeya-5379', amount:5379, paymentType:'installment', pjPaidDate:'2026-07-14',
 *            appliedAt:'2026-07-14T09:00:00Z', missingStreak:0 }
 *   รอบ 1 (2026-07-15T10:00Z, window 2026-07-09..2026-07-15, pjByUuid ไม่มี 'preeya-5379'):
 *     appliedAt ผ่าน settle margin (>30นาที) · pjPaidDate 07-14 อยู่ใน window · appliedAt>=floor → ตัดสิน
 *     ไม่เจอใน PJ → nextMissingStreak=1 → report=false (streak<2), kind='missing'
 *   รอบ 2 (2026-07-16T10:00Z, window 2026-07-10..2026-07-16, ours.missingStreak=1 จากรอบ1, ยังไม่เจอ):
 *     → nextMissingStreak=2 → report=true, kind='missing' → เด้งกล่องรอตรวจ (RECEIPT_MISSING)
 *
 * (ข) วริศรา เปลี่ยนประเภท — ใบ 500 บาท PJ แก้จาก installment เป็น other
 *   ours = { uuid:'warisara-500', amount:500, paymentType:'installment', pjPaidDate:'2026-07-15',
 *            appliedAt:'2026-07-15T09:00:00Z', missingStreak:0 }
 *   pj   = { uuid:'warisara-500', amount:500, paymentType:'other', pjPaidDate:'2026-07-15' }
 *   ctx  = { snapshotAt:'2026-07-16T08:00:00Z', windowStart:'2026-07-10', windowEnd:'2026-07-16' }
 *   → เจอ uuid, amount ตรง, type ต่าง (installment ไม่เท่า other) → kind='type', report=true, nextMissingStreak=0
 *
 * (ค) ปรียานุช เปลี่ยนวันที่ — ใบ 3,979 บาท เราจด 15-07 แต่ PJ ตอนนี้โชว์ 16-07
 *   ours = { uuid:'preeya-3979', amount:3979, paymentType:'installment', pjPaidDate:'2026-07-15',
 *            appliedAt:'2026-07-15T09:00:00Z', missingStreak:0 }
 *   pj   = { uuid:'preeya-3979', amount:3979, paymentType:'installment', pjPaidDate:'2026-07-16' }
 *   ctx  = { snapshotAt:'2026-07-16T08:00:00Z', windowStart:'2026-07-10', windowEnd:'2026-07-16' }
 *   → เจอ uuid, amount/type ตรง, date ต่าง (15-07 ไม่เท่า 16-07) → kind='date', report=true, nextMissingStreak=0
 *
 * (ง) settle margin — เพิ่ง apply ไม่ถึง 30 นาที ไม่ตัดสินแม้จะหาไม่เจอใน PJ
 *   ours.appliedAt='2026-07-16T09:45:00Z', ctx.snapshotAt='2026-07-16T10:00:00Z' (diff=15 นาที)
 *   → withinSettleMargin=true → kind=null, report=false, nextMissingStreak=ours.missingStreak (ไม่เปลี่ยน)
 *
 * (จ) นอก window — pjPaidDate เก่ากว่าที่ดึงมารอบนี้ ไม่ตัดสิน (ไม่ใช่ว่าใบหาย แค่ไม่ได้ถามรอบนี้)
 *   ours.pjPaidDate='2026-06-01', ctx.windowStart='2026-07-10', ctx.windowEnd='2026-07-16'
 *   → outsideWindow=true → kind=null, report=false, nextMissingStreak=ours.missingStreak (ไม่เปลี่ยน)
 *
 * (ฉ) ก่อน coverage floor — ใบเก่าก่อน 13 ก.ค. ไม่มี uuid ให้เทียบเป็นเนื้อเดียวกัน ไม่ตัดสิน
 *   ours.appliedAt='2026-07-10T09:00:00Z' (< COVERAGE_FLOOR_ISO)
 *   → beforeCoverageFloor=true → kind=null, report=false, nextMissingStreak=ours.missingStreak (ไม่เปลี่ยน)
 */
export function evaluateReceiptDrift(
  ours: OurReceipt,
  pjByUuid: Map<string, PjSnapshotRow>,
  ctx: DriftEvalContext,
): DriftVerdict {
  const appliedAtMs = Date.parse(ours.appliedAt)
  const snapshotAtMs = Date.parse(ctx.snapshotAt)

  const withinSettleMargin = snapshotAtMs - appliedAtMs < SETTLE_MARGIN_MS
  const outsideWindow = ours.pjPaidDate < ctx.windowStart || ours.pjPaidDate > ctx.windowEnd
  const beforeCoverageFloor = appliedAtMs < Date.parse(COVERAGE_FLOOR_ISO)

  if (withinSettleMargin || outsideWindow || beforeCoverageFloor) {
    return { uuid: ours.uuid, kind: null, report: false, nextMissingStreak: ours.missingStreak }
  }

  const pj = pjByUuid.get(ours.uuid)
  const oursSide: DriftSide = { amount: ours.amount, paymentType: ours.paymentType, pjPaidDate: ours.pjPaidDate }

  if (!pj) {
    const nextMissingStreak = ours.missingStreak + 1
    return {
      uuid: ours.uuid,
      kind: 'missing',
      report: nextMissingStreak >= MISSING_STREAK_THRESHOLD,
      nextMissingStreak,
      detail: { ours: oursSide, pj: null },
    }
  }

  const pjSide: DriftSide = { amount: pj.amount, paymentType: pj.paymentType, pjPaidDate: pj.pjPaidDate }
  const detail = { ours: oursSide, pj: pjSide }

  if (Math.abs(ours.amount - pj.amount) > 0.01) {
    return { uuid: ours.uuid, kind: 'amount', report: true, nextMissingStreak: 0, detail }
  }
  if (normalizeType(ours.paymentType) !== normalizeType(pj.paymentType)) {
    return { uuid: ours.uuid, kind: 'type', report: true, nextMissingStreak: 0, detail }
  }
  if (ours.pjPaidDate !== pj.pjPaidDate) {
    return { uuid: ours.uuid, kind: 'date', report: true, nextMissingStreak: 0, detail }
  }
  return { uuid: ours.uuid, kind: null, report: false, nextMissingStreak: 0 }
}

/** map DriftKind -> PjSyncReviewReason (reuse คอลัมน์ reason เดิมของ pj_sync_review ไม่สร้างตารางใหม่)
 *  รายละเอียดจริง (amount/type/date ต่างกันตรงไหน) อยู่ใน raw_json (ดู PjReceiptDriftSnapshot) ไม่ใช่ reason */
export function driftKindToReviewReason(kind: DriftKind): PjSyncReviewReason {
  return kind === 'missing' ? 'RECEIPT_MISSING' : 'RECEIPT_CHANGED'
}

/**
 * เก็บลงคอลัมน์ raw_json ของ pj_sync_review เมื่อ reason = RECEIPT_MISSING หรือ RECEIPT_CHANGED
 * ต้องมีครบ: เราถืออยู่ยังไง vs PJ ว่ายังไง + kind + ตรวจเมื่อไหร่ (ให้ UI render "เราถือ X / PJ ว่า Y" ตรงๆ)
 */
export interface PjReceiptDriftSnapshot {
  /** 'missing' | 'amount' | 'type' | 'date' — เลือกข้อความ/ไอคอนใน UI */
  kind: DriftKind
  /** ISO timestamp ตอนตรวจเจอ (ctx.snapshotAt ของรอบที่ report=true) — โชว์ "ตรวจล่าสุดเมื่อ" */
  checkedAt: string
  /** ค่า nextMissingStreak ตอนรายงาน (>=2 เสมอถ้า kind='missing') — เก็บไว้ debug/audit เท่านั้น ไม่ใช่ค่าที่ต้อง action */
  missingStreak: number
  /** สิ่งที่เราจดไว้ตอน apply */
  ours: DriftSide
  /** สิ่งที่ PJ ว่าตอนตรวจ — null เฉพาะ kind='missing' (หา uuid ไม่เจอใน PJ เลย) */
  pj: DriftSide | null
}

/**
 * แปลง DriftVerdict -> PjReceiptDriftSnapshot สำหรับเขียนลง raw_json — คืน null ถ้ายังไม่ถึงเกณฑ์รายงาน
 * (kind=null หรือ report=false) กันคนเรียกพลาดเขียนกล่องรอตรวจทั้งที่ยังไม่ผ่านเกณฑ์
 */
export function toDriftSnapshot(verdict: DriftVerdict, checkedAt: string): PjReceiptDriftSnapshot | null {
  if (!verdict.kind || !verdict.report || !verdict.detail) return null
  return {
    kind: verdict.kind,
    checkedAt,
    missingStreak: verdict.nextMissingStreak,
    ours: verdict.detail.ours,
    pj: verdict.detail.pj,
  }
}

export interface RunSanityInput {
  /** จำนวนแถวที่ PJ ตอบกลับมาในรอบนี้ (ทั้งหมด ไม่ใช่แค่ที่ match) */
  pjRowCount: number
  /** จำนวนใบเสร็จของเราที่ "ควรจะตัดสินได้" ในรอบนี้ (ผ่าน settle margin + อยู่ใน window + ผ่าน coverage floor) */
  ourEvaluableCount: number
  /** true = ดึง PJ มาไม่ครบ (ชนจำนวนหน้าสูงสุด ยังมีแถวเหลือที่ไม่ได้ดึง) */
  truncated: boolean
  /** จำนวนแถวที่ดึงได้จากรอบก่อนหน้าที่ "สำเร็จ" ช่วงเวลายาวเท่ากัน — null = ยังไม่เคยมีรอบสำเร็จมาก่อน (ข้ามเช็คนี้) */
  previousSuccessfulRunRowCount: number | null
}

export type RunSanityVerdict = { ok: true } | { ok: false; reason: string }

/**
 * เกตความสมเหตุสมผลของทั้งรอบ — ต้องเรียก "ก่อน" ใช้ผล evaluateReceiptDrift ใดๆ
 * ถ้า ok=false ต้องยกเลิกทั้งรอบ ไม่เขียนอะไรลงกล่องรอตรวจเลย (ไม่ใช่แค่ข้ามบางใบ)
 *
 * ทำไมเกตนี้สำคัญ: วันที่ 16 ก.ค. เกือบสรุปผิดว่า "ใบถูกลบทั้งหมด" เพราะหน้า PJ ไม่ได้กดปุ่มกรอง
 * ทำให้คืนมาแค่วันเดียว — ถ้าไม่มีเกตนี้ ระบบจะแจ้งใบผีเป็นร้อยเคสทุกครั้งที่ PJ ตอบไม่ครบ (ไม่ใช่ใบถูกลบจริง)
 *
 * ---- Trace tests --------------------------------------------------------------
 * (ก) PJ ตอบ 0 แถว แต่เรามีใบที่ต้องตรวจ 42 ใบ -> ok=false (สงสัยดึงพลาด ไม่ใช่ลบหมด)
 * (ข) ชน MAX_PAGES ระหว่างดึง -> ok=false เสมอ ไม่ว่าตัวเลขอื่นจะโอเคแค่ไหน
 * (ค) ได้แค่ 50 แถว น้อยกว่าครึ่งของรอบก่อน (180 -> ครึ่ง=90) -> ok=false
 * (ง) ปกติ 170 แถว >= ครึ่งของ 180 (=90) -> ok=true
 */
export function evaluateRunSanity(input: RunSanityInput): RunSanityVerdict {
  if (input.pjRowCount === 0 && input.ourEvaluableCount > 0) {
    return {
      ok: false,
      reason: `PJ ตอบกลับมา 0 แถว แต่เรามีใบเสร็จที่ต้องตรวจ ${input.ourEvaluableCount} ใบในรอบนี้ — น่าจะดึง PJ ไม่สำเร็จ (เช่น ลืมกดตัวกรอง/session หลุด) ไม่ใช่ใบถูกลบทั้งหมดจริง`,
    }
  }
  if (input.truncated) {
    return {
      ok: false,
      reason: 'ดึงข้อมูล PJ มาไม่ครบ (ชนจำนวนหน้าสูงสุดที่ดึงได้ต่อรอบ) — ผลตรวจรอบนี้ไม่น่าเชื่อถือ ต้องดึงให้ครบก่อนค่อยตัดสิน',
    }
  }
  if (input.previousSuccessfulRunRowCount != null && input.previousSuccessfulRunRowCount > 0) {
    const minExpected = input.previousSuccessfulRunRowCount * RUN_SANITY_MIN_RATIO
    if (input.pjRowCount < minExpected) {
      return {
        ok: false,
        reason: `PJ ตอบกลับมาแค่ ${input.pjRowCount} แถว น้อยกว่าครึ่งของรอบก่อนที่สำเร็จ (${input.previousSuccessfulRunRowCount} แถว) — สงสัยดึงข้อมูลไม่ครบ ไม่ใช่ใบถูกลบจริงทั้งหมด`,
      }
    }
  }
  return { ok: true }
}
