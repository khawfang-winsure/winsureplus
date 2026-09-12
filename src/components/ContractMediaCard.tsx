import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Image as ImageIcon,
  RefreshCw,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { Badge, Button, Card, Loading } from './ui'
import {
  confirmMediaDuplicate,
  findMediaDuplicate,
  getContractMedia,
  getMediaGateFrom,
  getMediaProvider,
  getMediaSlots,
  getMediaStorageGuardMb,
  getMediaStorageUsageMb,
  getMediaUrl,
  getPjImage,
  setCreditHistoryFound,
  softDeleteMedia,
  uploadMedia,
  type UploadMediaInput,
} from '../lib/db'
import {
  CHECK_IMAGE_MAX_BYTES,
  DEFAULT_MEDIA_SLOTS,
  checkImageFile,
  evaluateSlots,
  isGated,
  MEDIA_JPEG_QUALITY,
  MEDIA_JPEG_QUALITY_RETRY,
  MEDIA_MAX_LONG_SIDE,
  MEDIA_TARGET_MAX_BYTES,
  sniffImageMime,
  type MediaFile,
  type MediaSlot,
  type SlotEvaluation,
} from '../lib/media'
import type { Contract, ContractMediaFile, ContractMediaStatus, MediaDuplicateMatch, PjContractSnapshot, PjImageRef, Shop } from '../lib/types'
import type { PJContract } from '../lib/pjImport'
import { buildReviewFields, type ReviewField, type ReviewFieldGroup } from '../lib/reviewFields'
import { applyPjComparison, countPjFlags, type PjSnapshot } from '../lib/pjCompare'
import { reviewAgeDays, reviewAgeLabel, REVIEW_BADGE_PENDING } from '../lib/review'

// ===== ยูทิลิตี้ใช้ร่วมกับ WaitingEmail.tsx (แคสต์/ประเมินสถานะรูปจาก view สรุป ไม่ต้องดึงไฟล์จริงทีละสัญญา) =====

function isValidMediaSlot(x: unknown): x is MediaSlot {
  if (!x || typeof x !== 'object') return false
  const s = x as Record<string, unknown>
  return typeof s.key === 'string' && typeof s.label === 'string' && typeof s.sortOrder === 'number' && typeof s.min === 'number'
}

/** parse ค่าดิบจาก getMediaSlots() → MediaSlot[] ที่ใช้งานได้ ว่าง/parse ไม่ได้ → fallback ชุดเริ่มต้น */
export function normalizeMediaSlots(raw: unknown[]): MediaSlot[] {
  const valid = raw.filter(isValidMediaSlot)
  return valid.length > 0 ? valid : DEFAULT_MEDIA_SLOTS
}

/** สร้างไฟล์ปลอมจำนวนเท่ากับ counts ต่อช่อง (จาก view v_contract_media_status ที่ dedupe sha256 มาให้แล้ว)
 *  แล้วส่งเข้า evaluateSlots ตัวเดียวกับที่การ์ดใช้ — ใช้ตอนต้องประเมินหลายสัญญาพร้อมกัน (เช่นหน้ารอส่งเมล) โดยไม่ต้องโหลดไฟล์จริงทีละสัญญา */
export function evaluateFromStatus(slots: MediaSlot[], status: ContractMediaStatus): ReturnType<typeof evaluateSlots> {
  const files: MediaFile[] = []
  for (const [slotKey, count] of Object.entries(status.counts)) {
    for (let i = 0; i < count; i++) {
      files.push({
        id: `${status.contractId}-${slotKey}-${i}`,
        slotKey,
        sha256: `${status.contractId}-${slotKey}-${i}`, // unique เสมอ กัน evaluateSlots dedupe ซ้อนของนับซ้ำ (counts จาก view dedupe มาแล้ว)
        width: 0,
        height: 0,
        bytes: 0,
        uploadedAt: status.createdAt ?? '',
      })
    }
  }
  return evaluateSlots(
    slots,
    { condition: status.condition, origin: status.origin },
    { credit_history_found: status.creditHistoryFound },
    files,
  )
}

function toMediaFile(f: ContractMediaFile): MediaFile {
  return { id: f.id, slotKey: f.slotKey, sha256: f.sha256, width: f.width ?? 0, height: f.height ?? 0, bytes: f.bytes, uploadedAt: f.uploadedAt }
}

function isConditionalRule(rule: MediaSlot['required']): boolean {
  return typeof rule === 'object'
}

/** ดึงข้อความ error ให้อ่านออก (PostgREST/Edge Function error เป็น object มี .message ไม่ใช่ Error instance เสมอ) */
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}

async function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('สร้างไฟล์รูปไม่สำเร็จ'))), 'image/jpeg', quality)
  })
}

/** ย่อรูปลงเหลือด้านยาวสุด MEDIA_MAX_LONG_SIDE แล้วบีบเป็น JPEG ตามนโยบายใน media.ts (แบม) */
async function resizeToJpeg(bitmap: ImageBitmap): Promise<{ blob: Blob; width: number; height: number }> {
  const longSide = Math.max(bitmap.width, bitmap.height)
  const scale = longSide > MEDIA_MAX_LONG_SIDE ? MEDIA_MAX_LONG_SIDE / longSide : 1
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('ประมวลผลรูปไม่สำเร็จ')
  ctx.drawImage(bitmap, 0, 0, width, height)

  let blob = await canvasToBlob(canvas, MEDIA_JPEG_QUALITY)
  if (blob.size > MEDIA_TARGET_MAX_BYTES) {
    blob = await canvasToBlob(canvas, MEDIA_JPEG_QUALITY_RETRY)
  }
  return { blob, width, height }
}

async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const hashBuf = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function uploadWithRetry(input: UploadMediaInput, attemptsLeft = 2): Promise<ContractMediaFile> {
  try {
    return await uploadMedia(input)
  } catch (e) {
    const msg = errMsg(e)
    if (msg === 'ที่เก็บรูปเต็ม แจ้งแอดมิน' || attemptsLeft <= 0) throw e
    return uploadWithRetry(input, attemptsLeft - 1)
  }
}

interface DupConfirmState {
  match: MediaDuplicateMatch
  resolve: (v: boolean) => void
}

const MEDIA_CARD_OPEN_PREFIX = 'media-card-open:'

/** อ่านสถานะเปิด/ยุบการ์ดของสัญญานี้จาก localStorage — ถ้าไม่มีค่าเดิม (ยังไม่เคยกด) ใช้ defaultOpen ที่คำนวณจากสถานะสัญญา */
function readStoredMediaCardOpen(contractId: string, defaultOpen: boolean): boolean {
  try {
    const raw = localStorage.getItem(`${MEDIA_CARD_OPEN_PREFIX}${contractId}`)
    if (raw === 'true') return true
    if (raw === 'false') return false
  } catch {
    // localStorage ใช้ไม่ได้ (private mode ฯลฯ) — ใช้ค่าเริ่มต้น
  }
  return defaultOpen
}

function writeStoredMediaCardOpen(contractId: string, open: boolean): void {
  try {
    localStorage.setItem(`${MEDIA_CARD_OPEN_PREFIX}${contractId}`, String(open))
  } catch {
    // ไม่ต้องบล็อกถ้าจำสถานะไม่ได้
  }
}

function readIsCoarsePointer(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  } catch {
    return false
  }
}

// ===== cache URL ระดับโมดูล (spec §3, 2026-09-09; generalize เป็น key/fetcher ใดก็ได้ 2026-09-12) =====
// เดิมผูกกับ signed URL ของรูปเราอย่างเดียว (อายุจริง 300 วิ จาก db.ts getMediaUrl createSignedUrl(..., 300))
// ตอนนี้ generalize ให้รับ cache key + fetcher ใดก็ได้ — เผื่อรูปจากแหล่งอื่นในอนาคต (เช่นรูปบัตร PJ ที่ต้องผ่านตัวกลางฝั่งเรา
// ไม่ให้ลิงก์ปลายทางภายนอกโผล่ในเบราว์เซอร์ แล้วคืนมาเป็นก้อน blob/data URL แทน signed URL ธรรมดา)
// ถือว่าหมดอายุก่อนเวลาจริง 30 วิ กันพลาด แล้วขอใหม่อัตโนมัติในครั้งถัดไปที่มีการเรียกใช้ (thumb เข้าจอ/เปิด lightbox/preload)
// กันรูปพังเงียบตอนเปิดหน้าค้างไว้นาน แอดมินเปิดแท็บทิ้งไว้ทั้งวันไล่ตรวจหลายสิบเคส
// — ตั้งเพดานจำนวน entry + ล้างของหมดอายุตอนเขียนเข้า กันแคชโตไม่มีที่สิ้นสุด
const MEDIA_URL_TTL_MS = 300_000
const MEDIA_URL_SAFETY_MARGIN_MS = 30_000
const MEDIA_URL_CACHE_MAX_ENTRIES = 300
const urlCache = new Map<string, { url: string; expiresAt: number }>()
// request ที่กำลังวิ่งอยู่ (ยังไม่ settle) ต่อ cache key — กัน thumb (เลื่อนถึง) กับ lightbox (preload) ยิงซ้ำพร้อมกัน
const urlPending = new Map<string, Promise<string | null>>()

/** revoke object URL ตอนทิ้งออกจากแคช — เฉพาะ blob: URL เท่านั้น (signed URL ปกติของเราไม่ใช่ blob: เรียก revoke แล้วไม่มีผลอะไร ปลอดภัย)
 *  เผื่อไว้สำหรับรูปแหล่งอื่นในอนาคตที่ fetcher คืน URL.createObjectURL(...) แทน URL ปลายทางตรง — กัน memory รั่วตอนแคชหมดอายุ/ถูกเบียดออก */
function releaseCachedUrl(url: string): void {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url)
}

/** ล้าง entry ที่หมดอายุแล้วทั้งหมด แล้วถ้ายังเกินเพดานให้ทิ้งตัวเก่าสุดจนกว่าจะพอ (insertion order ของ Map) */
function pruneUrlCache(now: number): void {
  for (const [key, entry] of urlCache) {
    if (entry.expiresAt <= now) {
      releaseCachedUrl(entry.url)
      urlCache.delete(key)
    }
  }
  while (urlCache.size > MEDIA_URL_CACHE_MAX_ENTRIES) {
    const oldestKey = urlCache.keys().next().value
    if (oldestKey === undefined) break
    const oldest = urlCache.get(oldestKey)
    if (oldest) releaseCachedUrl(oldest.url)
    urlCache.delete(oldestKey)
  }
}

/** cache กลาง — key ใดก็ได้ + fetcher ใดก็ได้ ไม่ผูกกับ ContractMediaFile หรือ Supabase อีกต่อไป
 *  ttlMs default 300 วิ ตรงกับ signed URL ของเรา (และตรงกับอายุลิงก์รูปฝั่ง PJ พอดีเป๊ะ ณ วันที่เขียน — ใช้ semantics เดิมได้ 1:1) */
async function getCachedUrl(cacheKey: string, fetcher: () => Promise<string | null>, ttlMs: number = MEDIA_URL_TTL_MS): Promise<string | null> {
  const now = Date.now()
  pruneUrlCache(now)

  const cached = urlCache.get(cacheKey)
  if (cached && cached.expiresAt - MEDIA_URL_SAFETY_MARGIN_MS > now) return cached.url

  const pending = urlPending.get(cacheKey)
  if (pending) return pending

  const request = fetcher()
    .then((url) => {
      const prev = urlCache.get(cacheKey)
      if (prev) releaseCachedUrl(prev.url) // ทิ้งของเก่าก่อนเสมอ (ทั้งกรณี refresh สำเร็จหรือได้ null) — กัน object URL ค้างไม่ถูก revoke
      urlCache.delete(cacheKey) // ลบก่อน set เพื่อขยับไปท้าย insertion order — ทำให้ prune ทิ้ง LRU จริง ไม่ใช่ทิ้งตัวที่ถูก refresh บ่อยที่สุด
      if (url) {
        urlCache.set(cacheKey, { url, expiresAt: Date.now() + ttlMs })
        pruneUrlCache(Date.now())
      }
      return url
    })
    .finally(() => {
      urlPending.delete(cacheKey)
    })

  urlPending.set(cacheKey, request)
  return request
}

/** thin wrapper ของ getCachedUrl เฉพาะรูปของเรา (ContractMediaFile) — คงชื่อ/พฤติกรรมเดิมไว้ให้จุดเรียกเดิมไม่ต้องแก้ */
async function getCachedMediaUrl(file: ContractMediaFile): Promise<string | null> {
  return getCachedUrl(file.id, () => getMediaUrl(file))
}

// ===== รูปจากเว็บ PJ (แผงตรวจ, เฟส 2 — 2026-09-12) — proxy ผ่าน Edge Function pj-snapshot ไม่มีลิงก์ S3 ตรงโผล่ในเบราว์เซอร์ =====

/** base64 (จาก getPjImage) → Blob จริง เอาไปสร้าง object URL ให้ <img src> ใช้ได้ */
function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/** PJ ไม่ติดป้ายว่ารูปไหนคือช่องไหน (ทุกใบ alt เดียวกันหมด) — แยกได้แค่ 2 กลุ่มหยาบๆ จากชื่อคีย์ที่เราตั้งฝั่งเราเอง (id_card_* vs customer_photo_*) ห้ามพยายามเดามากกว่านี้ */
function pjImageLabel(kind: string): string {
  return kind.startsWith('id_card') ? 'บัตรประชาชน' : 'รูปจากร้าน'
}

/** adapter: รูป 1 ใบจากเว็บ PJ → MediaSource กลาง — cache ผ่าน getCachedUrl เดียวกับรูปของเรา
 *  (TTL 300 วิ ตรงกับอายุลิงก์ปลายทางจริงฝั่ง PJ พอดี — ดู comment บน getCachedUrl ด้านบน)
 *  โหลดจริงเฉพาะตอน MediaThumb เลื่อนเข้าจอ (useInView ในตัว MediaThumb เอง) — กัน 11 รูป x 3-8 วิ ยิงพร้อมกันจนค้าง */
function pjImageToSource(contractId: string, ref: PjImageRef): MediaSource {
  const cacheKey = `pj:${contractId}:${ref.kind}`
  return {
    id: cacheKey,
    alt: pjImageLabel(ref.kind),
    load: () =>
      getCachedUrl(cacheKey, async () => {
        const result = await getPjImage(contractId, ref.kind)
        if (!result.ok || !result.base64 || !result.mime) return null
        return URL.createObjectURL(base64ToBlob(result.base64, result.mime))
      }),
  }
}

/** ข้อความเวลาแบบคนอ่าน ("5 นาทีที่แล้ว") จาก timestamp ที่ดึงข้อมูล PJ ครั้งล่าสุด */
function pjFetchedAgoLabel(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return 'เมื่อสักครู่'
  if (minutes < 60) return `${minutes} นาทีที่แล้ว`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ชั่วโมงที่แล้ว`
  const days = Math.floor(hours / 24)
  return `${days} วันที่แล้ว`
}

/** shape กลางสำหรับ MediaThumb/MediaLightbox — ไม่ผูกกับ ContractMediaFile เพื่อให้รูปจากแหล่งอื่น (เช่นรูปบัตร PJ ในแผงตรวจ รอบหน้า) ใช้ component เดียวกันได้
 *  load() ต้องคืน string ที่ใส่ <img src> ได้ตรง — ครอบคลุมทั้ง URL ปลายทางธรรมดา และ object URL/data URL (กรณีข้อมูลรูปเป็นก้อนไบต์ ไม่ใช่ URL ปลายทาง) */
interface MediaSource {
  id: string
  load: () => Promise<string | null>
  alt?: string
}

/** adapter: ContractMediaFile (แถวรูปของเรา) → MediaSource กลาง */
function mediaFileToSource(file: ContractMediaFile): MediaSource {
  return { id: file.id, load: () => getCachedMediaUrl(file) }
}

/** ขอ URL ของ source + วอร์มแคชรูปในเบราว์เซอร์ล่วงหน้า (fire-and-forget) — ใช้ตอนเปิด lightbox เพื่อให้กดลูกศรแล้วลื่น */
function preloadSource(source: MediaSource | undefined): void {
  if (!source) return
  void source
    .load()
    .then((url) => {
      if (!url) return
      const img = new Image()
      img.src = url
    })
    .catch(() => undefined) // preload ล้มเหลวเงียบๆ ได้ — ไม่กระทบ UI เพราะตอนกดดูจริงจะขอ URL ใหม่อยู่แล้ว
}

// เผื่อเคส IntersectionObserver ไม่ยิง callback เลย (เช่นแท็บพื้นหลัง — เบราว์เซอร์หยุด rendering lifecycle)
// ผ่านไปเท่านี้แล้วยังไม่มีการยิงสักครั้ง แต่ tile ยังอยู่ในระยะ viewport ตามที่วัดเอง → ปลดล็อกให้โหลด กันรูปค้าง "…" ทั้งการ์ด
const IN_VIEW_STUCK_OBSERVER_FALLBACK_MS = 2000

/** true ถ้า rect (จาก getBoundingClientRect) อยู่ในจอหรือใกล้จอตาม margin เดียวกับ rootMargin ของ observer */
function isRectNearViewport(rect: DOMRect, marginPx: number): boolean {
  const vh = window.innerHeight || document.documentElement.clientHeight
  const vw = window.innerWidth || document.documentElement.clientWidth
  return rect.bottom >= -marginPx && rect.top <= vh + marginPx && rect.right >= -marginPx && rect.left <= vw + marginPx
}

/** แปลง rootMargin แบบ '200px' ให้เป็นตัวเลข px ใช้กับการวัด rect เอง (ไม่รองรับหน่วยอื่น — พอสำหรับ default ที่ใช้อยู่) */
function parseMarginPx(rootMargin: string): number {
  const n = parseFloat(rootMargin)
  return Number.isFinite(n) ? n : 0
}

/** true เมื่อ element เข้ามาในจอ (หรือใกล้จอตาม rootMargin) ครั้งแรก — ใช้ lazy-load thumb ไม่ยิง request ทั้งหมดตอนเปิดหน้า
 *  ไม่พึ่ง callback ของ IntersectionObserver เพียงอย่างเดียว (พิสูจน์แล้วว่าแท็บพื้นหลังทำ observer ไม่ยิงเลย):
 *  1) เช็คตำแหน่งเองตอน mount ก่อน — ถ้าอยู่ในระยะแล้วปลดล็อกทันทีไม่ต้องรอ observer
 *  2) ยังคง observer ไว้สำหรับ tile ที่อยู่นอกจอตอนแรกแล้วผู้ใช้เลื่อนมาทีหลัง (ยัง lazy จริง)
 *  3) ไม่มี IntersectionObserver ในเบราว์เซอร์ → ปลดล็อกไปเลย ดีกว่ารูปไม่ขึ้น
 *  4) กันค้างถาวร: ผ่านไป ~2 วิ observer ยังไม่ยิงสักครั้ง แต่ยังอยู่ในระยะตามที่วัดเอง → ปลดล็อก */
function useInView<T extends Element>(rootMargin = '200px'): [(el: T | null) => void, boolean] {
  const [inView, setInView] = useState(false)
  const elRef = useRef<T | null>(null)
  const setRef = (el: T | null) => {
    elRef.current = el
  }

  useEffect(() => {
    if (inView) return
    const el = elRef.current
    if (!el) return

    if (typeof IntersectionObserver === 'undefined') {
      setInView(true) // เบราว์เซอร์เก่าไม่รองรับ — โหลดปกติ ไม่บล็อกผู้ใช้
      return
    }

    const marginPx = parseMarginPx(rootMargin)

    // เช็คตำแหน่งเองก่อนตั้ง observer — ถ้าอยู่ในระยะแล้วไม่ต้องรอ callback เลย
    if (isRectNearViewport(el.getBoundingClientRect(), marginPx)) {
      setInView(true)
      return
    }

    let fired = false
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          fired = true
          setInView(true)
        }
      },
      { rootMargin },
    )
    obs.observe(el)

    const stuckTimer = setTimeout(() => {
      if (fired) return
      const current = elRef.current
      if (current && isRectNearViewport(current.getBoundingClientRect(), marginPx)) {
        setInView(true)
      }
    }, IN_VIEW_STUCK_OBSERVER_FALLBACK_MS)

    return () => {
      obs.disconnect()
      clearTimeout(stuckTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView, rootMargin])

  return [setRef, inView]
}

// ===== แผงข้อมูลสำหรับตรวจก่อนส่งอีเมลบริษัท (อ่านอย่างเดียว) — spec §2, 2026-09-09 =====

const REVIEW_PANEL_OPEN_PREFIX = 'review-panel-open:'

function readReviewPanelOpen(contractId: string): boolean {
  try {
    const raw = localStorage.getItem(`${REVIEW_PANEL_OPEN_PREFIX}${contractId}`)
    if (raw === 'true') return true
    if (raw === 'false') return false
  } catch {
    // localStorage ใช้ไม่ได้ (private mode ฯลฯ) — ใช้ค่าเริ่มต้น
  }
  return true // default เปิด
}

function writeReviewPanelOpen(contractId: string, open: boolean): void {
  try {
    localStorage.setItem(`${REVIEW_PANEL_OPEN_PREFIX}${contractId}`, String(open))
  } catch {
    // ไม่ต้องบล็อกถ้าจำสถานะไม่ได้
  }
}

/** ข้อความ 1 บรรทัดสำหรับปุ่มคัดลอก — ต่อค่า PJ ท้ายบรรทัดถ้ามีการเทียบแล้ว (pjCompare ถูกตั้งค่า) ไม่มี PJ เลยก็คงบรรทัดเดิมเป๊ะ */
function fieldCopyLine(f: ReviewField): string {
  const altText = f.alt ? ` (${f.alt})` : ''
  const pjText = !f.pjCompare
    ? ''
    : f.pjCompare === 'no_pj'
      ? ' | PJ: ไม่มีช่องนี้'
      : f.pjCompare === 'pj_blank'
        ? ' | PJ: เว้นว่าง'
        : ` | PJ: ${f.pjValue || '-'}`
  return `${f.label}: ${f.value || '-'}${altText}${pjText}`
}

function groupCopyText(g: ReviewFieldGroup): string {
  return `${g.name}\n${g.fields.map(fieldCopyLine).join('\n')}`
}

/** สีข้อความ + พื้นหลังของช่องค่า PJ ตามผลเทียบ — hard ต้องสะดุดตาที่สุด (แดงเข้ม+พื้นแดงอ่อน), soft เตือนเบา (เหลือง),
 *  same/no_pj/pj_blank ไม่ต้องมีพื้นหลัง (ไม่ใช่จุดที่ต้องสนใจ) */
function pjCellBgClass(compare: ReviewField['pjCompare']): string {
  if (compare === 'hard') return 'bg-red-50'
  if (compare === 'soft') return 'bg-amber-50'
  return ''
}

/** เนื้อหาช่องค่า PJ ต่อ 1 ช่อง — คืนทั้งข้อความหลักและคลาสสี ให้ตรงกับกฎ:
 *  hard=แดงเข้ม, soft=เหลืองเข้ม, same=ปกติ/จาง, no_pj/pj_blank=เทาจาง+ข้อความอธิบายว่าทำไมไม่มีให้เทียบ,
 *  ไม่ได้อยู่ใน scope การเทียบเลย (f.pjCompare undefined ทั้งที่ hasPjData) = เทาจางเช่นกัน แต่ข้อความสั้นกว่า */
function pjCellText(f: ReviewField): { text: string; className: string } {
  if (!f.pjCompare) return { text: '—', className: 'text-ink-soft/70' }
  if (f.pjCompare === 'no_pj') return { text: 'PJ ไม่มีช่องนี้', className: 'text-ink-soft/70 italic' }
  if (f.pjCompare === 'pj_blank') return { text: 'PJ เว้นว่าง', className: 'text-ink-soft/70 italic' }
  const text = f.pjValue || '—'
  if (f.pjCompare === 'hard') return { text, className: 'font-semibold text-red-700' }
  if (f.pjCompare === 'soft') return { text, className: 'font-semibold text-amber-700' }
  return { text, className: 'text-ink-soft' } // same — ตรงกันแล้ว ไม่ต้องเน้น
}

/** แถบสถานะเหนือแผงตรวจ — สรุปว่าดึงข้อมูลจาก PJ มาถึงไหนแล้ว + ปุ่มดึงใหม่ + สรุปจุดที่ไม่ตรง
 *  แสดงเสมอเมื่อหน้าเว็บส่ง pjSnapshot ลงมา (แม้เป็น null ก็แสดงเป็นสถานะ "ยังไม่เคยดึง") — ไม่ส่งลงมาเลย (undefined) = ปิดฟีเจอร์นี้ทั้งหมด ไม่โชว์อะไรเลย */
function PjStatusBar({
  pjSnapshot,
  pjRefreshing,
  onPjRefresh,
  hasPjData,
  hardSoftCount,
}: {
  pjSnapshot: PjContractSnapshot | null
  pjRefreshing: boolean
  onPjRefresh?: () => void
  hasPjData: boolean
  hardSoftCount: number
}) {
  let mainText: string
  if (pjRefreshing) {
    mainText = 'กำลังดึงข้อมูลจาก PJ มาเทียบ…'
  } else if (!pjSnapshot || pjSnapshot.status === 'never_fetched') {
    mainText = 'ยังไม่เคยดึงข้อมูลจาก PJ มาเทียบ'
  } else if (pjSnapshot.status === 'fetching') {
    mainText = 'กำลังดึงข้อมูลจาก PJ มาเทียบ…'
  } else if (pjSnapshot.status === 'failed') {
    mainText = pjSnapshot.errorReason ? `ดึงข้อมูลจาก PJ ไม่สำเร็จ: ${pjSnapshot.errorReason}` : 'ดึงข้อมูลจาก PJ ไม่สำเร็จ'
  } else if (pjSnapshot.status === 'not_found_in_pj') {
    mainText = pjSnapshot.pjInvoiceNo
      ? `หาสัญญานี้ใน PJ ไม่เจอ (เลขที่ใบ: ${pjSnapshot.pjInvoiceNo})`
      : 'หาสัญญานี้ใน PJ ไม่เจอ'
  } else if (pjSnapshot.fetchedAt) {
    mainText = `ดึงจาก PJ เมื่อ ${pjFetchedAgoLabel(pjSnapshot.fetchedAt)}`
  } else {
    mainText = 'ดึงข้อมูลจาก PJ แล้ว'
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-peach bg-peach-light/30 px-4 py-2 text-xs text-ink">
      <span className="flex-1">{mainText}</span>
      {hasPjData && (
        <Badge tone={hardSoftCount > 0 ? 'amber' : 'green'}>
          {hardSoftCount > 0 ? `ไม่ตรง ${hardSoftCount} จุด` : 'ข้อมูลตรงกันหมด'}
        </Badge>
      )}
      {onPjRefresh && (
        <button
          type="button"
          onClick={onPjRefresh}
          disabled={pjRefreshing}
          className="inline-flex items-center gap-1.5 rounded-lg border border-peach bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink transition hover:bg-peach-light/60 disabled:opacity-50"
        >
          <RefreshCw size={13} className={pjRefreshing ? 'animate-spin' : ''} />
          {pjRefreshing ? 'กำลังดึง...' : 'ดึงใหม่'}
        </button>
      )}
    </div>
  )
}

/** บรรทัดข้อมูล LINE จากหน้าใบสัญญา PJ — ฝั่งเราไม่มีช่องนี้เลย แสดงไว้ดูเฉยๆ ตอนตรวจ ไม่ใช่การเทียบ (ไม่มีสีตรง/ไม่ตรง)
 *  line_status ว่าง = PJ ไม่ได้ระบุ (ไม่ใช่ "ยังไม่เชื่อมต่อ") — ไม่แสดงบรรทัดนี้เลยถ้าว่าง กันเข้าใจผิด
 *  status มีค่าแต่ไม่ใช่ "เชื่อมต่อแล้ว" → เน้นเหลืองแบบเดียวกับป้ายเตือนอื่นในเว็บ ให้สังเกตว่าต้องทักร้าน */
function PjLineInfoBar({ data }: { data: Partial<PJContract> | null }) {
  const status = (data?.line_status ?? '').trim()
  if (!status) return null

  const userCount = (data?.line_user_count ?? '').trim()
  const lineId = (data?.line_id ?? '').trim()
  const isConnected = status === 'เชื่อมต่อแล้ว'

  const parts = [status]
  if (userCount) parts.push(`${userCount} ผู้ใช้`)
  if (lineId) parts.push(`ID ${lineId}`)

  return (
    <div
      className={`border-b border-peach px-4 py-1.5 text-xs ${
        isConnected ? 'text-ink-soft' : 'bg-amber-50 font-semibold text-amber-700'
      }`}
    >
      LINE: {parts.join(' · ')}
    </div>
  )
}

/** กองรูปที่ scrape มาจาก PJ — แสดงรวมกัน ไม่พยายามจับคู่กับ 15 ช่องของเรา (PJ ไม่ติดป้ายว่ารูปไหนคืออะไร)
 *  lazy-load ต่อรูปผ่าน MediaThumb (useInView ในตัว) กัน 11 รูป x 3-8 วิ ยิงพร้อมกันจนหน้าค้าง */
function PjPhotoGallery({ contractId, imageRefs }: { contractId: string; imageRefs: PjImageRef[] }) {
  const sources = useMemo(() => imageRefs.map((ref) => pjImageToSource(contractId, ref)), [contractId, imageRefs])
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const openSource = openIndex != null ? sources[openIndex] : null

  return (
    <div className="border-t border-peach px-4 py-3">
      <p className="mb-1 text-xs font-bold uppercase tracking-wide text-ink">{`รูปจาก PJ (${imageRefs.length} รูป)`}</p>
      <p className="mb-2 text-[11px] text-ink-soft">PJ ไม่ได้บอกว่ารูปไหนคือช่องไหน แสดงเป็นกองรวมไว้ให้กวาดตาเทียบกับรูปของเราด้านล่างนี้เอง</p>
      <div className="flex flex-wrap gap-3">
        {imageRefs.map((ref, i) => (
          <div key={ref.kind} className="flex flex-col items-center gap-1">
            <MediaThumb source={sources[i]} onOpen={() => setOpenIndex(i)} />
            <span className="text-[10px] text-ink-soft">{pjImageLabel(ref.kind)}</span>
          </div>
        ))}
      </div>
      {openSource && openIndex != null && (
        <MediaLightbox
          source={openSource}
          hasPrev={openIndex > 0}
          hasNext={openIndex < sources.length - 1}
          onPrev={() => setOpenIndex((i) => (i != null && i > 0 ? i - 1 : i))}
          onNext={() => setOpenIndex((i) => (i != null && i < sources.length - 1 ? i + 1 : i))}
          onClose={() => setOpenIndex(null)}
          preloadPrev={openIndex > 0 ? sources[openIndex - 1] : undefined}
          preloadNext={openIndex < sources.length - 1 ? sources[openIndex + 1] : undefined}
        />
      )}
    </div>
  )
}

function ReviewPanel({
  contract,
  shop,
  pjSnapshot,
  pjRefreshing = false,
  onPjRefresh,
}: {
  contract: Contract
  shop?: Shop | null
  /** undefined = ปิดฟีเจอร์เทียบ PJ ทั้งหมด (แผงหน้าตาเหมือนก่อนมีฟีเจอร์นี้เป๊ะ) · null = เปิดใช้แล้วแต่ยังไม่มีข้อมูล (เช่นยังโหลดไม่เสร็จ/ไม่เคยดึง) */
  pjSnapshot?: PjContractSnapshot | null
  pjRefreshing?: boolean
  onPjRefresh?: () => void
}) {
  const baseGroups = useMemo(() => buildReviewFields(contract, shop ?? null, new Date().getFullYear()), [contract, shop])
  const pjEnabled = pjSnapshot !== undefined
  // มีข้อมูลจริงให้เทียบก็ต่อเมื่อดึงสำเร็จ (status='ok') และมี data จริง — สถานะอื่น (กำลังดึง/ล่ม/หาไม่เจอ/ยังไม่เคยดึง)
  // ต้อง fallback เป็น 2 คอลัมน์เดิมเป๊ะ ไม่โชว์คอลัมน์ที่ 3 ว่างๆ ให้ดูเหมือนพัง
  const pjData: PjSnapshot | null = pjEnabled && pjSnapshot && pjSnapshot.status === 'ok' && pjSnapshot.data ? pjSnapshot.data : null
  const hasPjData = pjData !== null
  // ข้อมูล LINE (line_status/line_user_count/line_id) ไม่ใช่ช่องเทียบ (ไม่มีคู่ฝั่งเรา) — อ่านตรงจาก data ดิบ ไม่ผ่าน pjCompare
  const pjLineData: Partial<PJContract> | null = pjSnapshot && pjSnapshot.status === 'ok' ? pjSnapshot.data : null
  const groups = useMemo(() => applyPjComparison(baseGroups, pjData), [baseGroups, pjData])
  const pjFlagCounts = useMemo(() => (hasPjData ? countPjFlags(groups) : null), [hasPjData, groups])
  const pjImages = useMemo(
    () => (pjEnabled && pjSnapshot?.imageRefs ? pjSnapshot.imageRefs.filter((r) => r.kind && r.path) : []),
    [pjEnabled, pjSnapshot],
  )
  const fieldsGridCls = hasPjData ? 'grid grid-cols-1 sm:grid-cols-[180px_1fr_1fr]' : 'grid grid-cols-1 sm:grid-cols-[180px_1fr]'

  const [open, setOpen] = useState<boolean>(() => readReviewPanelOpen(contract.id))
  const [copyToast, setCopyToast] = useState<string | null>(null)

  useEffect(() => {
    setOpen(readReviewPanelOpen(contract.id))
  }, [contract.id])

  useEffect(() => {
    if (!copyToast) return
    const t = setTimeout(() => setCopyToast(null), 2000)
    return () => clearTimeout(t)
  }, [copyToast])

  function toggle() {
    setOpen((prev) => {
      const next = !prev
      writeReviewPanelOpen(contract.id, next)
      return next
    })
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopyToast(`คัดลอก${label}แล้ว`)
    } catch {
      setCopyToast('คัดลอกไม่สำเร็จ ลองใหม่อีกครั้ง')
    }
  }

  const ageText = contract.reviewUpdatedAt
    ? reviewAgeLabel(reviewAgeDays(contract.reviewUpdatedAt, new Date().toISOString()))
    : null

  return (
    <div className="mb-4 overflow-hidden rounded-2xl border border-peach bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-peach bg-peach-soft px-4 py-3">
        <p className="mr-1 flex-1 text-sm font-bold text-ink">ข้อมูลสำหรับตรวจ</p>
        <Badge tone="amber">{ageText ? `${REVIEW_BADGE_PENDING} · ${ageText}` : REVIEW_BADGE_PENDING}</Badge>
        <button
          type="button"
          onClick={() => void copy(groups.map(groupCopyText).join('\n\n'), 'ทั้งแผง')}
          className="inline-flex items-center gap-1.5 rounded-lg border border-peach bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink transition hover:bg-peach-light/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-salmon/40"
        >
          <Copy size={13} /> คัดลอกทั้งแผง
        </button>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={open ? 'ยุบแผงข้อมูลสำหรับตรวจ' : 'ขยายแผงข้อมูลสำหรับตรวจ'}
          className="inline-flex items-center rounded-lg border border-peach bg-surface p-1.5 text-ink transition hover:bg-peach-light/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-salmon/40"
        >
          {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
      </div>

      {pjEnabled && (
        <>
          <PjStatusBar
            pjSnapshot={pjSnapshot ?? null}
            pjRefreshing={pjRefreshing}
            onPjRefresh={onPjRefresh}
            hasPjData={hasPjData}
            hardSoftCount={pjFlagCounts ? pjFlagCounts.hard + pjFlagCounts.soft : 0}
          />
          <PjLineInfoBar data={pjLineData} />
        </>
      )}

      {open && (
        <>
          <div className="flex flex-wrap gap-4 border-b border-peach bg-surface px-4 py-2 text-xs text-ink-soft">
            <span className="inline-flex items-center gap-1.5">
              <span className="text-salmon-deep" aria-hidden="true">✉</span> อยู่ในอีเมลที่ส่งบริษัท
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="rounded bg-peach-light px-1.5 py-0.5 font-semibold text-ink">คำนวณ</span>
              ระบบคิดให้เอง พนักงานไม่ได้พิมพ์
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-grid h-4 w-4 place-items-center rounded-full bg-red-600 text-[10px] font-bold text-white">
                !
              </span>
              ว่างทั้งที่ควรมีค่า
            </span>
            {hasPjData && (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm bg-red-200" aria-hidden="true" /> ไม่ตรงกับ PJ
                <span className="h-2.5 w-2.5 rounded-sm bg-amber-200" aria-hidden="true" /> ต่างแบบเตือน (ข้อความ)
              </span>
            )}
          </div>

          {hasPjData && (
            <div className="hidden border-b border-peach bg-peach-light/40 text-[11px] font-bold uppercase tracking-wide text-ink-soft sm:grid sm:grid-cols-[180px_1fr_1fr]">
              <div className="px-4 py-1.5">รายการ</div>
              <div className="px-4 py-1.5">ที่เราคีย์</div>
              <div className="px-4 py-1.5">ที่ร้านคีย์ใน PJ</div>
            </div>
          )}

          {groups.map((g) => (
            <div key={g.name} className="border-b border-peach last:border-b-0">
              <div className="flex items-center gap-2 bg-cream-deep px-4 py-2">
                <h4 className="flex-1 text-xs font-bold uppercase tracking-wide text-ink">{g.name}</h4>
                <button
                  type="button"
                  onClick={() => void copy(groupCopyText(g), g.name)}
                  className="inline-flex items-center gap-1 rounded-lg border border-peach bg-surface px-2 py-1 text-[11px] font-semibold text-ink-soft transition hover:bg-peach-light/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-salmon/40"
                >
                  <Copy size={11} /> คัดลอกกลุ่มนี้
                </button>
              </div>
              <div className={fieldsGridCls}>
                {g.fields.map((f) => {
                  const pjCell = hasPjData ? pjCellText(f) : null
                  return (
                    <Fragment key={f.key}>
                      <div className={`border-t border-peach px-4 py-1.5 text-sm text-ink-soft ${f.missing ? 'bg-red-50' : ''}`}>{f.label}</div>
                      <div
                        className={`flex flex-wrap items-center gap-1.5 border-t border-peach px-4 py-1.5 text-sm ${
                          f.missing ? 'bg-red-50 font-semibold text-red-700' : 'text-ink'
                        } ${f.mono ? 'tabular-nums' : ''}`}
                      >
                        {f.inEmail && (
                          <span className="text-salmon-deep" title="อยู่ในอีเมลที่ส่งบริษัท" aria-hidden="true">
                            ✉
                          </span>
                        )}
                        {f.missing ? (
                          <>
                            <span aria-hidden="true" className="inline-grid h-4 w-4 place-items-center rounded-full bg-red-600 text-[10px] font-bold text-white">
                              !
                            </span>
                            <span>ยังไม่ได้กรอก</span>
                          </>
                        ) : f.value ? (
                          <span>{f.value}</span>
                        ) : (
                          <span className="text-ink-soft">—</span>
                        )}
                        {f.derived && (
                          <span className="rounded bg-peach-light px-1.5 py-0.5 text-[11px] font-semibold text-ink">คำนวณ</span>
                        )}
                        {f.alt && (
                          <span className="text-xs text-ink-soft" title="ต่างกันเพราะปัดเศษคนละสูตร ไม่ใช่คีย์ผิด">{`(${f.alt})`}</span>
                        )}
                      </div>
                      {hasPjData && pjCell && (
                        <div className={`border-t border-peach px-4 py-1.5 text-sm ${pjCellBgClass(f.pjCompare)} ${f.mono ? 'tabular-nums' : ''}`}>
                          <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-ink-soft sm:hidden">
                            ที่ร้านคีย์ใน PJ
                          </span>
                          <span className={pjCell.className}>{pjCell.text}</span>
                          {f.pjNote && <span className="ml-1.5 text-xs text-ink-soft" title={f.pjNote}>{`(${f.pjNote})`}</span>}
                        </div>
                      )}
                    </Fragment>
                  )
                })}
              </div>
            </div>
          ))}

          {pjImages.length > 0 && <PjPhotoGallery contractId={contract.id} imageRefs={pjImages} />}
        </>
      )}

      {copyToast && (
        <div role="status" className="border-t border-peach bg-peach-light/60 px-4 py-2 text-center text-xs font-semibold text-ink">
          {copyToast}
        </div>
      )}
    </div>
  )
}

// ===== การ์ดรูปเอกสารต่อสัญญา =====

export default function ContractMediaCard({
  contract,
  canUpload,
  canDelete,
  onStatusChange,
  isAdmin,
  shop,
  pjSnapshot,
  pjRefreshing,
  onPjRefresh,
}: {
  contract: Contract
  canUpload: boolean
  canDelete: boolean
  onStatusChange?: (evaluation: ReturnType<typeof evaluateSlots>) => void
  isAdmin: boolean
  shop?: Shop | null
  /** ข้อมูล/รูปจากเว็บ PJ ไว้เทียบในแผงตรวจ — undefined = ไม่ส่งฟีเจอร์นี้มาเลย (แผงตรวจหน้าตาเหมือนเดิม) */
  pjSnapshot?: PjContractSnapshot | null
  pjRefreshing?: boolean
  onPjRefresh?: () => void
}) {
  const [slots, setSlots] = useState<MediaSlot[]>(DEFAULT_MEDIA_SLOTS)
  const [files, setFiles] = useState<ContractMediaFile[]>([])
  const [gateFrom, setGateFrom] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [creditHistoryFound, setCreditHistoryFoundLocal] = useState(false)
  const [creditToggleBusy, setCreditToggleBusy] = useState(false)
  const [progress, setProgress] = useState<Record<string, { current: number; total: number } | undefined>>({})
  const [toast, setToast] = useState<string | null>(null)
  const [bannerError, setBannerError] = useState<string | null>(null)
  const [tooSmallIds, setTooSmallIds] = useState<Set<string>>(new Set())
  const [dupConfirm, setDupConfirm] = useState<DupConfirmState | null>(null)
  const [lightbox, setLightbox] = useState<{ slotKey: string; fileId: string } | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteErr, setDeleteErr] = useState<string | null>(null)
  const [storageWarning, setStorageWarning] = useState<{ usageMb: number; guardMb: number } | null>(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  const [isCoarsePointer] = useState<boolean>(readIsCoarsePointer)
  const locked = Boolean(contract.emailSentAt && contract.summarySentAt) // เคสจบแล้ว — เงื่อนไขเดียวกับ ContractDetail.tsx (ล็อกแก้ไข)
  const [expanded, setExpanded] = useState<boolean>(() => readStoredMediaCardOpen(contract.id, !locked))
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  useEffect(() => {
    setExpanded(readStoredMediaCardOpen(contract.id, !locked))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract.id])

  function toggleExpanded() {
    setExpanded((prev) => {
      const next = !prev
      writeStoredMediaCardOpen(contract.id, next)
      return next
    })
  }

  async function refreshStorageWarning() {
    try {
      const provider = await getMediaProvider()
      if (provider !== 'supabase') {
        setStorageWarning(null)
        return
      }
      const [usageMb, guardMb] = await Promise.all([getMediaStorageUsageMb(), getMediaStorageGuardMb()])
      setStorageWarning(usageMb >= 600 ? { usageMb, guardMb } : null)
    } catch {
      // เช็คพื้นที่ไม่สำเร็จ — ไม่บล็อกการใช้งานปกติ
    }
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    Promise.all([getMediaSlots(), getContractMedia(contract.id), getMediaGateFrom()])
      .then(([rawSlots, mediaFiles, gate]) => {
        if (cancelled) return
        setSlots(normalizeMediaSlots(rawSlots))
        setFiles(mediaFiles)
        setGateFrom(gate)
        setCreditHistoryFoundLocal(contract.creditHistoryFound ?? false)
      })
      .catch((e) => {
        if (!cancelled) setLoadError(errMsg(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [contract.id, contract.creditHistoryFound])

  useEffect(() => {
    void refreshStorageWarning()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(t)
  }, [toast])

  // ปิดกล่องยืนยันรูปซ้ำข้ามสัญญาด้วย Esc = ยกเลิก
  useEffect(() => {
    if (!dupConfirm) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        dupConfirm?.resolve(false)
        setDupConfirm(null)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [dupConfirm])

  const evaluation = useMemo(
    () =>
      evaluateSlots(
        slots,
        { condition: contract.condition, origin: contract.origin },
        { credit_history_found: creditHistoryFound },
        files.map(toMediaFile),
      ),
    [slots, contract.condition, contract.origin, creditHistoryFound, files],
  )

  useEffect(() => {
    onStatusChange?.(evaluation)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evaluation])

  const slotDefByKey = useMemo(() => new Map(slots.map((s) => [s.key, s])), [slots])

  const visibleSlots = evaluation.slots.filter((e) => {
    const def = slotDefByKey.get(e.key)
    if (!def) return true
    if (isConditionalRule(def.required) && !e.required && e.count === 0) return false
    return true
  })

  const filesBySlot = useMemo(() => {
    const map = new Map<string, ContractMediaFile[]>()
    for (const f of files) {
      const list = map.get(f.slotKey) ?? []
      list.push(f)
      map.set(f.slotKey, list)
    }
    return map
  }, [files])

  const gated = isGated(contract, gateFrom)
  const totalRequiredSlots = evaluation.slots.filter((s) => s.required).length

  async function handleToggleCreditHistory(ev: ChangeEvent<HTMLInputElement>) {
    const value = ev.target.checked
    const prev = creditHistoryFound
    setCreditHistoryFoundLocal(value)
    setCreditToggleBusy(true)
    try {
      await setCreditHistoryFound(contract.id, value)
    } catch (e) {
      setCreditHistoryFoundLocal(prev)
      setToast(errMsg(e))
    } finally {
      setCreditToggleBusy(false)
    }
  }

  async function processOneFile(slotKey: string, file: File) {
    try {
      if (file.size > CHECK_IMAGE_MAX_BYTES) {
        setToast('ไฟล์ใหญ่เกิน 15 MB')
        return
      }

      const head = new Uint8Array(await file.slice(0, 16).arrayBuffer())
      if (!sniffImageMime(head)) {
        setToast('ไฟล์นี้ไม่ใช่รูปภาพ')
        return
      }

      const bitmap = await createImageBitmap(file)
      const { blob, width, height } = await resizeToJpeg(bitmap)
      bitmap.close()
      const sha256 = await sha256Hex(blob)

      const sameContractHashes = new Set(files.map((f) => f.sha256))
      let otherMatch: MediaDuplicateMatch | null = null
      try {
        otherMatch = await findMediaDuplicate(sha256, contract.id)
      } catch {
        otherMatch = null // เช็คซ้ำไม่สำเร็จ — ปล่อยผ่าน ไม่บล็อกการอัป
      }

      const check = checkImageFile(
        { mime: 'image/jpeg', width, height, bytes: blob.size, sha256 },
        {
          sameContractHashes,
          otherContractMatch: otherMatch ? { contractNo: otherMatch.contractNo, customerName: otherMatch.customerNameMasked } : null,
        },
      )

      if (!check.accept) {
        setToast(check.warnings[0]?.message ?? 'ไฟล์นี้ใช้ไม่ได้')
        return
      }

      if (check.warnings.some((w) => w.code === 'dup_same_contract')) {
        setToast('รูปนี้อัปไว้แล้ว ระบบนับให้ 1 ครั้ง')
        return
      }

      const isDupOther = check.warnings.some((w) => w.code === 'dup_other_contract')
      if (isDupOther && otherMatch) {
        const confirmed = await new Promise<boolean>((resolve) => {
          setDupConfirm({ match: otherMatch!, resolve })
        })
        setDupConfirm(null)
        if (!confirmed) return
      }

      const tooSmall = check.warnings.some((w) => w.code === 'too_small')

      const uploaded = await uploadWithRetry({
        contractId: contract.id,
        slotKey,
        blob,
        sha256,
        width,
        height,
        mime: 'image/jpeg',
      })

      if (isDupOther) {
        await confirmMediaDuplicate(uploaded.id)
      }
      if (tooSmall) {
        setTooSmallIds((s) => new Set(s).add(uploaded.id))
      }
      setFiles((prev) => [...prev, uploaded])
      void refreshStorageWarning()
    } catch (e) {
      const msg = errMsg(e)
      if (msg === 'ที่เก็บรูปเต็ม แจ้งแอดมิน') {
        setBannerError(msg)
      } else {
        setToast(msg)
      }
    }
  }

  async function handleFilesArray(slotKey: string, arr: File[]) {
    if (arr.length === 0) return
    setBannerError(null)
    for (let i = 0; i < arr.length; i++) {
      setProgress((p) => ({ ...p, [slotKey]: { current: i + 1, total: arr.length } }))
      await processOneFile(slotKey, arr[i])
    }
    setProgress((p) => {
      const next = { ...p }
      delete next[slotKey]
      return next
    })
  }

  async function handleFilesSelected(slotKey: string, fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    await handleFilesArray(slotKey, Array.from(fileList))
    const input = fileInputRefs.current[slotKey]
    if (input) input.value = ''
  }

  /** เอาไฟล์แรกถ้าช่องรับได้แค่ 1 รูป (ลาก/วางหลายไฟล์เข้าช่องเดียว) */
  function capToSlotMax(def: MediaSlot | undefined, arr: File[]): File[] {
    const allowMultiple = def?.max !== 1
    if (allowMultiple || arr.length <= 1) return arr
    setToast('ช่องนี้ใส่ได้ 1 รูป ระบบใช้รูปแรก')
    return [arr[0]]
  }

  function handleDragOver(slotKey: string, ev: DragEvent<HTMLDivElement>) {
    if (!canUpload || progress[slotKey]) return
    ev.preventDefault()
    setDragOverKey(slotKey)
  }

  function handleDragLeave(slotKey: string) {
    setDragOverKey((k) => (k === slotKey ? null : k))
  }

  function handleDrop(slotKey: string, def: MediaSlot | undefined, ev: DragEvent<HTMLDivElement>) {
    if (!canUpload) return
    ev.preventDefault()
    setDragOverKey((k) => (k === slotKey ? null : k))
    if (progress[slotKey]) return // กำลังอัปช่องนี้อยู่ — ไม่รับซ้ำ
    const fileList = ev.dataTransfer.files
    if (!fileList || fileList.length === 0) {
      setToast('ลากไฟล์รูปจากเครื่องเท่านั้น (ลากจากหน้าเว็บไม่ได้ ให้เซฟรูปก่อน)')
      return
    }
    void handleFilesArray(slotKey, capToSlotMax(def, Array.from(fileList)))
  }

  function handlePaste(slotKey: string, def: MediaSlot | undefined, ev: ClipboardEvent<HTMLDivElement>) {
    if (!canUpload || progress[slotKey]) return
    const fileList = ev.clipboardData?.files
    if (!fileList || fileList.length === 0) return
    ev.preventDefault()
    void handleFilesArray(slotKey, capToSlotMax(def, Array.from(fileList)))
  }

  async function handleConfirmDelete() {
    if (!deleteConfirmId) return
    setDeleteBusy(true)
    setDeleteErr(null)
    try {
      await softDeleteMedia(deleteConfirmId)
      setFiles((prev) => prev.filter((f) => f.id !== deleteConfirmId))
      setDeleteConfirmId(null)
    } catch (e) {
      setDeleteErr(errMsg(e))
    } finally {
      setDeleteBusy(false)
    }
  }

  const lightboxFiles = lightbox ? (filesBySlot.get(lightbox.slotKey) ?? []) : []
  const lightboxIndex = lightbox ? lightboxFiles.findIndex((f) => f.id === lightbox.fileId) : -1
  const lightboxFile = lightboxIndex >= 0 ? lightboxFiles[lightboxIndex] : null
  const lightboxPrevFile = lightboxIndex > 0 ? lightboxFiles[lightboxIndex - 1] : undefined
  const lightboxNextFile = lightboxIndex >= 0 && lightboxIndex < lightboxFiles.length - 1 ? lightboxFiles[lightboxIndex + 1] : undefined

  return (
    <Card className="mb-4 py-4">
      {isAdmin && contract.reviewStatus === 'pending_review' && (
        <ReviewPanel
          contract={contract}
          shop={shop}
          pjSnapshot={pjSnapshot}
          pjRefreshing={pjRefreshing}
          onPjRefresh={onPjRefresh}
        />
      )}

      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
            <ImageIcon size={15} /> รูปเอกสาร
          </p>
          {files.length === 0 ? (
            <Badge tone="neutral">ไม่มีข้อมูล</Badge>
          ) : evaluation.complete ? (
            <Badge tone="green">{`ครบ ${totalRequiredSlots} ช่อง`}</Badge>
          ) : (
            <Badge tone={gated ? 'red' : 'amber'}>{`ขาด ${evaluation.missing.length} ช่อง`}</Badge>
          )}
          {!expanded && <span className="text-xs text-ink">{`${files.length} ใบ`}</span>}
        </div>
        <button
          type="button"
          onClick={toggleExpanded}
          aria-expanded={expanded}
          className="inline-flex items-center gap-1 rounded-lg border border-peach px-2.5 py-1.5 text-xs font-semibold text-ink transition hover:bg-peach-light/40"
        >
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {expanded ? 'ซ่อน' : 'ดูรูป'}
        </button>
      </div>

      {expanded && canUpload && !isCoarsePointer && (
        <p className="mb-3 text-xs text-ink">ลากรูปจากคอมมาวางในช่องได้เลย หรือกดที่ช่องแล้ววาง (Ctrl+V)</p>
      )}

      {expanded && (
        <>
          {toast && (
            <div className="mb-3 rounded-xl border border-peach bg-peach-light/40 px-3 py-2 text-xs text-ink">{toast}</div>
          )}
          {bannerError && (
            <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{bannerError}</div>
          )}
          {loadError && (
            <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</div>
          )}
          {storageWarning && (
            <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
              {`ที่เก็บรูปใกล้เต็ม แจ้งคุณเตย (${storageWarning.usageMb.toFixed(1)} / ${storageWarning.guardMb} MB)`}
            </div>
          )}

          {loading ? (
            <Loading label="กำลังโหลดรูป..." />
          ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visibleSlots.map((e) => {
            const def = slotDefByKey.get(e.key)
            const slotFiles = filesBySlot.get(e.key) ?? []
            const prog = progress[e.key]
            const allowMultiple = def?.max !== 1
            const isDragOver = dragOverKey === e.key
            const isOverMax = def?.max != null && e.count > def.max
            return (
              <div
                key={e.key}
                tabIndex={canUpload ? 0 : undefined}
                aria-label={canUpload ? `ช่องอัปโหลด ${e.label}` : undefined}
                onDragOver={(ev) => handleDragOver(e.key, ev)}
                onDragLeave={() => handleDragLeave(e.key)}
                onDrop={(ev) => handleDrop(e.key, def, ev)}
                onPaste={(ev) => handlePaste(e.key, def, ev)}
                className={`rounded-xl border p-3 transition ${
                  isDragOver ? 'border-dashed border-salmon-deep bg-peach-light/50' : 'border-peach bg-white'
                } ${canUpload ? 'focus:outline-none focus:ring-2 focus:ring-salmon/40 focus:border-salmon-deep' : ''}`}
              >
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-ink">{e.label}</p>
                    {def?.hint && <p className="text-xs text-ink-soft">{def.hint}</p>}
                  </div>
                  <SlotStatusPill status={e.status} count={e.count} min={e.min} />
                </div>

                {isOverMax && (
                  <p className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700">
                    {`เกิน — ช่องนี้ใส่ได้ ${def?.max} ใบ มี ${e.count} ใบ`}
                  </p>
                )}

                {e.key === 'credit_check' && (
                  <label className="mb-2 flex items-center gap-2 text-xs text-ink">
                    <input
                      type="checkbox"
                      checked={creditHistoryFound}
                      disabled={creditToggleBusy || !canUpload}
                      onChange={handleToggleCreditHistory}
                      className="h-4 w-4 rounded border-peach accent-salmon-deep"
                    />
                    พบประวัติ (เปิดช่องแนบใบแจ้งความ/หลักฐานเคลียร์ยอด)
                  </label>
                )}

                {slotFiles.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {slotFiles.map((f) => (
                      <MediaThumb
                        key={f.id}
                        source={mediaFileToSource(f)}
                        tooSmall={tooSmallIds.has(f.id)}
                        canDelete={canDelete}
                        onOpen={() => setLightbox({ slotKey: e.key, fileId: f.id })}
                        onDeleteRequest={() => setDeleteConfirmId(f.id)}
                      />
                    ))}
                  </div>
                )}

                {canUpload && (
                  <>
                    <label className="sr-only" htmlFor={`media-input-${e.key}`}>
                      เพิ่มรูป {e.label}
                    </label>
                    <input
                      id={`media-input-${e.key}`}
                      ref={(el) => {
                        fileInputRefs.current[e.key] = el
                      }}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      multiple={allowMultiple}
                      className="hidden"
                      onChange={(ev) => void handleFilesSelected(e.key, ev.target.files)}
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRefs.current[e.key]?.click()}
                      disabled={!!prog}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-peach px-2.5 py-1.5 text-xs font-semibold text-ink-soft transition hover:bg-peach-light/40 disabled:opacity-50"
                    >
                      <Upload size={13} /> เพิ่มรูป
                    </button>
                    {prog && (
                      <p className="mt-1 text-xs text-ink-soft">{`กำลังอัป ${prog.current}/${prog.total}`}</p>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
          )}
        </>
      )}

      {dupConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          onClick={() => {
            dupConfirm.resolve(false)
            setDupConfirm(null)
          }}
        >
          <div className="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-xl" onClick={(ev) => ev.stopPropagation()}>
            <p className="mb-4 text-sm text-ink">
              {`รูปนี้เคยใช้กับสัญญา ${dupConfirm.match.contractNo} (${dupConfirm.match.customerNameMasked}) ยืนยันว่าถูกต้องหรือไม่`}
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  dupConfirm.resolve(false)
                  setDupConfirm(null)
                }}
              >
                ยกเลิก
              </Button>
              <Button
                onClick={() => {
                  dupConfirm.resolve(true)
                  setDupConfirm(null)
                }}
              >
                ใช้รูปนี้ต่อ
              </Button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirmId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setDeleteConfirmId(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-xl" onClick={(ev) => ev.stopPropagation()}>
            <p className="mb-4 text-sm text-ink">ยืนยันลบรูปนี้? ลบแล้วกู้คืนไม่ได้</p>
            {deleteErr && <p className="mb-3 text-sm text-red-600">{deleteErr}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDeleteConfirmId(null)} disabled={deleteBusy}>
                ยกเลิก
              </Button>
              <Button onClick={() => void handleConfirmDelete()} disabled={deleteBusy}>
                {deleteBusy ? 'กำลังลบ...' : 'ลบรูป'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {lightboxFile && (
        <MediaLightbox
          source={mediaFileToSource(lightboxFile)}
          hasPrev={lightboxIndex > 0}
          hasNext={lightboxIndex < lightboxFiles.length - 1}
          onPrev={() => setLightbox({ slotKey: lightboxFile.slotKey, fileId: lightboxFiles[lightboxIndex - 1].id })}
          onNext={() => setLightbox({ slotKey: lightboxFile.slotKey, fileId: lightboxFiles[lightboxIndex + 1].id })}
          onClose={() => setLightbox(null)}
          preloadPrev={lightboxPrevFile ? mediaFileToSource(lightboxPrevFile) : undefined}
          preloadNext={lightboxNextFile ? mediaFileToSource(lightboxNextFile) : undefined}
        />
      )}
    </Card>
  )
}

function SlotStatusPill({ status, count, min }: { status: SlotEvaluation['status']; count: number; min: number }) {
  if (status === 'ok') return <Badge tone="green">{count > 1 ? `ครบ ${count}` : 'ครบ'}</Badge>
  if (status === 'partial') return <Badge tone="amber">{`มี ${count}/${min}`}</Badge>
  if (status === 'missing') return <Badge tone="red">ขาด</Badge>
  return <Badge tone="neutral">ไม่บังคับ</Badge>
}

function MediaThumb({
  source,
  tooSmall = false,
  canDelete = false,
  onOpen,
  onDeleteRequest,
}: {
  source: MediaSource
  tooSmall?: boolean
  canDelete?: boolean
  onOpen: () => void
  onDeleteRequest?: () => void
}) {
  const [setInViewRef, inView] = useInView<HTMLDivElement>()
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => {
    if (!inView) return
    let cancelled = false
    setFailed(false)
    setUrl(null)
    source
      .load()
      .then((u) => {
        if (cancelled) return
        if (u) setUrl(u)
        else setFailed(true) // resolve ว่างแบบไม่ throw ก็ถือว่าล้มเหลว — กันค้าง "…" ตลอดกาล
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id, inView, retryCount])

  function handleRetry(ev: MouseEvent<HTMLButtonElement>) {
    ev.stopPropagation()
    setFailed(false)
    setRetryCount((n) => n + 1)
  }

  return (
    <div
      ref={setInViewRef}
      className="group relative h-28 w-28 shrink-0 overflow-hidden rounded-lg border border-peach bg-peach-light/30 sm:h-40 sm:w-40"
    >
      <button type="button" onClick={onOpen} disabled={failed} className="block h-full w-full disabled:cursor-default" aria-label="ดูรูปขยาย">
        {url ? (
          <img src={url} alt={source.alt ?? ''} loading="lazy" decoding="async" className="h-full w-full object-cover" />
        ) : failed ? (
          <span className="flex h-full items-center justify-center text-center text-[10px] text-ink">โหลดไม่ได้</span>
        ) : (
          <span className="flex h-full items-center justify-center text-xs text-ink">…</span>
        )}
      </button>
      {failed && (
        <button
          type="button"
          onClick={handleRetry}
          aria-label="ลองโหลดรูปนี้ใหม่"
          className="absolute inset-x-1 bottom-1 rounded bg-black/60 px-1 py-0.5 text-[10px] font-semibold text-white transition hover:bg-black/75"
        >
          ลองใหม่
        </button>
      )}
      {tooSmall && (
        <span
          title="ความชัดต่ำ อาจอ่านตัวเลขไม่ได้ ลองถ่ายใหม่"
          className="absolute left-0.5 top-0.5 rounded bg-amber-500 p-0.5 text-white"
        >
          <AlertTriangle size={11} />
        </span>
      )}
      {canDelete && onDeleteRequest && (
        <button
          type="button"
          onClick={onDeleteRequest}
          aria-label="ลบรูปนี้"
          className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100"
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  )
}

// ===== ซูม/แพนในหน้าขยาย (spec §3, 2026-09-09) =====
const ZOOM_MIN = 0.4
const ZOOM_MAX = 6
const ZOOM_WHEEL_STEP = 1.16
const ZOOM_BUTTON_STEP = 1.35
const ZOOM_DOUBLE_CLICK = 2.6
// ลากแพนเกินกี่ px ถึงนับว่าเป็นการลาก ไม่ใช่คลิกฉากหลังเพื่อปิด (กันปล่อยเมาส์ท้ายการลากแล้วโมดัลปิดโดยไม่ตั้งใจ)
const BACKDROP_CLICK_DRAG_THRESHOLD_PX = 4

function clampScale(v: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v))
}

function MediaLightbox({
  source,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
  preloadPrev,
  preloadNext,
}: {
  source: MediaSource
  hasPrev: boolean
  hasNext: boolean
  onPrev: () => void
  onNext: () => void
  onClose: () => void
  preloadPrev?: MediaSource
  preloadNext?: MediaSource
}) {
  const [url, setUrl] = useState<string | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const imgWrapRef = useRef<HTMLDivElement>(null)
  const imgElRef = useRef<HTMLImageElement>(null)

  const scaleRef = useRef(1)
  const txRef = useRef(0)
  const tyRef = useRef(0)
  const [zoomPercent, setZoomPercent] = useState(100)
  const [dragging, setDragging] = useState(false)
  const dragStartRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const draggedPastThresholdRef = useRef(false) // true ถ้า pointerdown→ตอนนี้ลากเกิน threshold แล้ว — กันคลิกฉากหลังปิดโมดัลตอนปล่อยเมาส์ท้ายการลาก
  const baseSizeRef = useRef<{ w: number; h: number } | null>(null)
  const naturalSizeRef = useRef<{ w: number; h: number } | null>(null)

  function applyTransform() {
    if (imgWrapRef.current) {
      imgWrapRef.current.style.transform = `translate(${txRef.current}px, ${tyRef.current}px) scale(${scaleRef.current})`
    }
    setZoomPercent(Math.round(scaleRef.current * 100))
  }

  function setScale(next: number, cx?: number, cy?: number) {
    const clamped = clampScale(next)
    if (cx != null && cy != null && stageRef.current && clamped !== scaleRef.current) {
      const r = stageRef.current.getBoundingClientRect()
      const ox = cx - r.left - r.width / 2
      const oy = cy - r.top - r.height / 2
      txRef.current = ox - (ox - txRef.current) * (clamped / scaleRef.current)
      tyRef.current = oy - (oy - tyRef.current) * (clamped / scaleRef.current)
    }
    scaleRef.current = clamped
    applyTransform()
  }

  useEffect(() => {
    let cancelled = false
    setUrl(null)
    source
      .load()
      .then((u) => {
        if (!cancelled) setUrl(u)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id])

  // preload รูปข้างเคียงล่วงหน้า — กดลูกศรแล้วลื่นไม่ต้องรอโหลดใหม่ (spec §3)
  // dep ใช้ .id เท่านั้น: caller ส่ง MediaSource object ใหม่ทุก render (adapter สร้าง literal ใหม่) — ถ้าใช้ทั้ง object เป็น dep effect จะยิง preload ซ้ำทุกครั้งที่ parent re-render โดยไม่จำเป็น
  useEffect(() => {
    preloadSource(preloadPrev)
    preloadSource(preloadNext)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preloadPrev?.id, preloadNext?.id])

  useEffect(() => {
    closeRef.current?.focus()
  }, [source.id])

  // รีเซ็ตซูม/ตำแหน่งทุกครั้งที่เปลี่ยนรูป
  useEffect(() => {
    scaleRef.current = 1
    txRef.current = 0
    tyRef.current = 0
    baseSizeRef.current = null
    naturalSizeRef.current = null
    setZoomPercent(100)
    applyTransform()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id])

  function handleImgLoad() {
    const img = imgElRef.current
    if (!img) return
    naturalSizeRef.current = { w: img.naturalWidth, h: img.naturalHeight }
    const rect = img.getBoundingClientRect()
    baseSizeRef.current = { w: rect.width, h: rect.height }
  }

  function handleZoomIn() {
    setScale(scaleRef.current * ZOOM_BUTTON_STEP)
  }
  function handleZoomOut() {
    setScale(scaleRef.current / ZOOM_BUTTON_STEP)
  }
  function handleFit() {
    scaleRef.current = 1
    txRef.current = 0
    tyRef.current = 0
    applyTransform()
  }
  function handleOneToOne() {
    const base = baseSizeRef.current
    const nat = naturalSizeRef.current
    if (!base || !nat || base.w === 0) return
    setScale(nat.w / base.w)
  }
  function handleDoubleClick(ev: MouseEvent<HTMLDivElement>) {
    if ((ev.target as HTMLElement).closest('button')) return // ดับเบิลคลิกปุ่มลูกศร/ซูมเร็วๆ ต้องไม่สลับซูมมั่ว (เหมือน guard ใน handlePointerDown)
    const next = Math.abs(scaleRef.current - 1) < 0.02 ? ZOOM_DOUBLE_CLICK : 1
    setScale(next, ev.clientX, ev.clientY)
  }

  // ล้อเมาส์ซูมที่ตำแหน่งเคอร์เซอร์ — ต้อง addEventListener แบบ passive:false ถึง preventDefault ได้จริง (React onWheel เป็น passive)
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    function onWheel(ev: WheelEvent) {
      ev.preventDefault()
      setScale(scaleRef.current * (ev.deltaY < 0 ? ZOOM_WHEEL_STEP : 1 / ZOOM_WHEEL_STEP), ev.clientX, ev.clientY)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handlePointerDown(ev: PointerEvent<HTMLDivElement>) {
    if ((ev.target as HTMLElement).closest('button')) return
    dragStartRef.current = { x: ev.clientX, y: ev.clientY, tx: txRef.current, ty: tyRef.current }
    draggedPastThresholdRef.current = false
    setDragging(true)
    stageRef.current?.setPointerCapture(ev.pointerId)
  }
  function handlePointerMove(ev: PointerEvent<HTMLDivElement>) {
    if (!dragStartRef.current) return
    const dx = ev.clientX - dragStartRef.current.x
    const dy = ev.clientY - dragStartRef.current.y
    if (Math.abs(dx) > BACKDROP_CLICK_DRAG_THRESHOLD_PX || Math.abs(dy) > BACKDROP_CLICK_DRAG_THRESHOLD_PX) {
      draggedPastThresholdRef.current = true
    }
    txRef.current = dragStartRef.current.tx + dx
    tyRef.current = dragStartRef.current.ty + dy
    applyTransform()
  }
  /** คลิกบนฉากหลัง (ไม่ใช่รูป/ปุ่ม) แล้วไม่ได้เพิ่งลากแพนมา → ปิดโมดัล (convention เดียวกับ Modal ใน ui.tsx) */
  function handleStageClick(ev: MouseEvent<HTMLDivElement>) {
    if (draggedPastThresholdRef.current) return
    const target = ev.target as HTMLElement
    if (target.closest('button') || target.tagName === 'IMG') return
    onClose()
  }
  function endDrag() {
    dragStartRef.current = null
    setDragging(false)
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === 'ArrowLeft' && hasPrev) {
        onPrev()
        return
      }
      if (e.key === 'ArrowRight' && hasNext) {
        onNext()
        return
      }
      if (e.key === '+' || e.key === '=') {
        setScale(scaleRef.current * ZOOM_BUTTON_STEP)
        return
      }
      if (e.key === '-') {
        setScale(scaleRef.current / ZOOM_BUTTON_STEP)
        return
      }
      if (e.key === 'Tab') {
        const focusables = containerRef.current?.querySelectorAll<HTMLElement>('button')
        if (!focusables || focusables.length === 0) return
        const list = Array.from(focusables)
        const first = list[0]
        const last = list[list.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, onPrev, onNext, hasPrev, hasNext])

  const zoomButtonCls =
    'rounded-lg border border-white/25 bg-white/10 text-white transition hover:bg-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70'

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label="ดูรูปขยาย"
      className="fixed inset-0 z-50 flex flex-col bg-black/85"
    >
      <div className="flex flex-wrap items-center gap-2 bg-black/40 px-3 py-2">
        <button type="button" onClick={handleZoomOut} aria-label="ซูมออก" className={`${zoomButtonCls} p-1.5`}>
          <ZoomOut size={16} />
        </button>
        <span className="min-w-[48px] text-center text-xs font-semibold tabular-nums text-white">{zoomPercent}%</span>
        <button type="button" onClick={handleZoomIn} aria-label="ซูมเข้า" className={`${zoomButtonCls} p-1.5`}>
          <ZoomIn size={16} />
        </button>
        <button type="button" onClick={handleFit} className={`${zoomButtonCls} px-2.5 py-1.5 text-xs font-semibold`}>
          พอดีจอ
        </button>
        <button type="button" onClick={handleOneToOne} className={`${zoomButtonCls} px-2.5 py-1.5 text-xs font-semibold`}>
          1:1
        </button>
        <span className="flex-1" />
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="ปิด (Esc)"
          className="rounded-full bg-white/15 p-2 text-white transition hover:bg-white/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          <X size={18} />
        </button>
      </div>

      <div
        ref={stageRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={handleStageClick}
        onDoubleClick={handleDoubleClick}
        className={`relative flex-1 touch-none select-none overflow-hidden ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      >
        {hasPrev && (
          <button
            type="button"
            onClick={(ev) => {
              ev.stopPropagation()
              onPrev()
            }}
            aria-label="รูปก่อนหน้า"
            className="absolute left-4 top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/20 p-2 text-white transition hover:bg-white/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <ChevronLeft size={22} />
          </button>
        )}
        {hasNext && (
          <button
            type="button"
            onClick={(ev) => {
              ev.stopPropagation()
              onNext()
            }}
            aria-label="รูปถัดไป"
            className="absolute right-4 top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/20 p-2 text-white transition hover:bg-white/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <ChevronRight size={22} />
          </button>
        )}
        <div className="flex h-full w-full items-center justify-center">
          <div ref={imgWrapRef} style={{ transformOrigin: 'center center' }}>
            {url ? (
              <img
                ref={imgElRef}
                src={url}
                alt={source.alt ?? ''}
                onLoad={handleImgLoad}
                onDragStart={(ev) => ev.preventDefault()}
                style={{ maxHeight: '80vh', maxWidth: '92vw', width: 'auto', height: 'auto', display: 'block' }}
              />
            ) : (
              <p className="text-white">กำลังโหลด...</p>
            )}
          </div>
        </div>
      </div>
      <p className="bg-black/40 px-3 py-1.5 text-center text-xs text-white/70">
        หมุนล้อเมาส์เพื่อซูม · ลากเพื่อเลื่อน · ดับเบิลคลิกสลับซูม · ลูกศรซ้ายขวาเปลี่ยนรูป · Esc ปิด
      </p>
    </div>
  )
}
