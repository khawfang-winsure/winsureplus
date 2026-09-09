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
import type { Contract, ContractMediaFile, ContractMediaStatus, MediaDuplicateMatch, Shop } from '../lib/types'
import { buildReviewFields, type ReviewField, type ReviewFieldGroup } from '../lib/reviewFields'
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

// ===== cache signed URL ระดับโมดูล (spec §3, 2026-09-09) =====
// signed URL อายุจริง 300 วิ (db.ts getMediaUrl createSignedUrl(..., 300)) — ถือว่าหมดอายุก่อนเวลาจริง 30 วิ กันพลาด
// แล้วขอใหม่อัตโนมัติในครั้งถัดไปที่มีการเรียกใช้ (thumb เข้าจอ/เปิด lightbox/preload) กันรูปพังเงียบตอนเปิดหน้าค้างไว้นาน
// แอดมินเปิดแท็บทิ้งไว้ทั้งวันไล่ตรวจหลายสิบเคส — ตั้งเพดานจำนวน entry + ล้างของหมดอายุตอนเขียนเข้า กันแคชโตไม่มีที่สิ้นสุด
const MEDIA_URL_TTL_MS = 300_000
const MEDIA_URL_SAFETY_MARGIN_MS = 30_000
const MEDIA_URL_CACHE_MAX_ENTRIES = 300
const mediaUrlCache = new Map<string, { url: string; expiresAt: number }>()
// request ที่กำลังวิ่งอยู่ (ยังไม่ settle) ต่อ fileId — กัน thumb (เลื่อนถึง) กับ lightbox (preload) ยิง media-sign ซ้ำพร้อมกัน
const mediaUrlPending = new Map<string, Promise<string | null>>()

/** ล้าง entry ที่หมดอายุแล้วทั้งหมด แล้วถ้ายังเกินเพดานให้ทิ้งตัวเก่าสุดจนกว่าจะพอ (insertion order ของ Map) */
function pruneMediaUrlCache(now: number): void {
  for (const [id, entry] of mediaUrlCache) {
    if (entry.expiresAt <= now) mediaUrlCache.delete(id)
  }
  while (mediaUrlCache.size > MEDIA_URL_CACHE_MAX_ENTRIES) {
    const oldestId = mediaUrlCache.keys().next().value
    if (oldestId === undefined) break
    mediaUrlCache.delete(oldestId)
  }
}

async function getCachedMediaUrl(file: ContractMediaFile): Promise<string | null> {
  const now = Date.now()
  pruneMediaUrlCache(now)

  const cached = mediaUrlCache.get(file.id)
  if (cached && cached.expiresAt - MEDIA_URL_SAFETY_MARGIN_MS > now) return cached.url

  const pending = mediaUrlPending.get(file.id)
  if (pending) return pending

  const request = getMediaUrl(file)
    .then((url) => {
      if (url) {
        mediaUrlCache.delete(file.id) // ลบก่อน set เพื่อขยับไปท้าย insertion order — ทำให้ prune ทิ้ง LRU จริง ไม่ใช่ทิ้งตัวที่ถูก refresh บ่อยที่สุด
        mediaUrlCache.set(file.id, { url, expiresAt: Date.now() + MEDIA_URL_TTL_MS })
        pruneMediaUrlCache(Date.now())
      } else {
        mediaUrlCache.delete(file.id)
      }
      return url
    })
    .finally(() => {
      mediaUrlPending.delete(file.id)
    })

  mediaUrlPending.set(file.id, request)
  return request
}

/** ขอ signed URL + วอร์มแคชรูปในเบราว์เซอร์ล่วงหน้า (fire-and-forget) — ใช้ตอนเปิด lightbox เพื่อให้กดลูกศรแล้วลื่น */
function preloadMediaUrl(file: ContractMediaFile | undefined): void {
  if (!file) return
  void getCachedMediaUrl(file)
    .then((url) => {
      if (!url) return
      const img = new Image()
      img.src = url
    })
    .catch(() => undefined) // preload ล้มเหลวเงียบๆ ได้ — ไม่กระทบ UI เพราะตอนกดดูจริงจะขอ signed URL ใหม่อยู่แล้ว
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

function fieldCopyLine(f: ReviewField): string {
  const altText = f.alt ? ` (${f.alt})` : ''
  return `${f.label}: ${f.value || '-'}${altText}`
}

function groupCopyText(g: ReviewFieldGroup): string {
  return `${g.name}\n${g.fields.map(fieldCopyLine).join('\n')}`
}

function ReviewPanel({ contract, shop }: { contract: Contract; shop?: Shop | null }) {
  const groups = useMemo(() => buildReviewFields(contract, shop ?? null, new Date().getFullYear()), [contract, shop])
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
          </div>

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
              <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr]">
                {g.fields.map((f) => (
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
                  </Fragment>
                ))}
              </div>
            </div>
          ))}
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
}: {
  contract: Contract
  canUpload: boolean
  canDelete: boolean
  onStatusChange?: (evaluation: ReturnType<typeof evaluateSlots>) => void
  isAdmin: boolean
  shop?: Shop | null
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
      {isAdmin && contract.reviewStatus === 'pending_review' && <ReviewPanel contract={contract} shop={shop} />}

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
                        file={f}
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
          file={lightboxFile}
          hasPrev={lightboxIndex > 0}
          hasNext={lightboxIndex < lightboxFiles.length - 1}
          onPrev={() => setLightbox({ slotKey: lightboxFile.slotKey, fileId: lightboxFiles[lightboxIndex - 1].id })}
          onNext={() => setLightbox({ slotKey: lightboxFile.slotKey, fileId: lightboxFiles[lightboxIndex + 1].id })}
          onClose={() => setLightbox(null)}
          preloadPrev={lightboxPrevFile}
          preloadNext={lightboxNextFile}
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
  file,
  tooSmall,
  canDelete,
  onOpen,
  onDeleteRequest,
}: {
  file: ContractMediaFile
  tooSmall: boolean
  canDelete: boolean
  onOpen: () => void
  onDeleteRequest: () => void
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
    getCachedMediaUrl(file)
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
  }, [file.id, inView, retryCount])

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
          <img src={url} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
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
      {canDelete && (
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
  file,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
  preloadPrev,
  preloadNext,
}: {
  file: ContractMediaFile
  hasPrev: boolean
  hasNext: boolean
  onPrev: () => void
  onNext: () => void
  onClose: () => void
  preloadPrev?: ContractMediaFile
  preloadNext?: ContractMediaFile
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
    getCachedMediaUrl(file)
      .then((u) => {
        if (!cancelled) setUrl(u)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [file])

  // preload รูปข้างเคียงล่วงหน้า — กดลูกศรแล้วลื่นไม่ต้องรอโหลดใหม่ (spec §3)
  useEffect(() => {
    preloadMediaUrl(preloadPrev)
    preloadMediaUrl(preloadNext)
  }, [preloadPrev, preloadNext])

  useEffect(() => {
    closeRef.current?.focus()
  }, [file.id])

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
  }, [file.id])

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
                alt=""
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
