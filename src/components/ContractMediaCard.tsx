import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Image as ImageIcon,
  Trash2,
  Upload,
  X,
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
import type { Contract, ContractMediaFile, ContractMediaStatus, MediaDuplicateMatch } from '../lib/types'

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

// ===== การ์ดรูปเอกสารต่อสัญญา =====

export default function ContractMediaCard({
  contract,
  canUpload,
  canDelete,
  onStatusChange,
}: {
  contract: Contract
  canUpload: boolean
  canDelete: boolean
  onStatusChange?: (evaluation: ReturnType<typeof evaluateSlots>) => void
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

  return (
    <Card className="mb-4 py-4">
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
          {!expanded && <span className="text-xs text-ink-soft">{`${files.length} ใบ`}</span>}
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
        <p className="mb-3 text-xs text-ink-soft">ลากรูปจากคอมมาวางในช่องได้เลย หรือกดที่ช่องแล้ววาง (Ctrl+V)</p>
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
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setUrl(null)
    setFailed(false)
    getMediaUrl(file)
      .then((u) => {
        if (!cancelled) setUrl(u)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id])

  return (
    <div className="group relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-peach bg-peach-light/30">
      <button type="button" onClick={onOpen} className="block h-full w-full" aria-label="ดูรูปขยาย">
        {url ? (
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : failed ? (
          <span className="flex h-full items-center justify-center text-center text-[10px] text-ink-soft">โหลดไม่ได้</span>
        ) : (
          <span className="flex h-full items-center justify-center text-xs text-ink-soft">…</span>
        )}
      </button>
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

function MediaLightbox({
  file,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
}: {
  file: ContractMediaFile
  hasPrev: boolean
  hasNext: boolean
  onPrev: () => void
  onNext: () => void
  onClose: () => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setUrl(null)
    getMediaUrl(file)
      .then((u) => {
        if (!cancelled) setUrl(u)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [file])

  useEffect(() => {
    closeRef.current?.focus()
  }, [file.id])

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

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label="ดูรูปขยาย"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label="ปิด"
        className="absolute right-4 top-4 rounded-full bg-white/20 p-2 text-white hover:bg-white/30"
      >
        <X size={20} />
      </button>
      {hasPrev && (
        <button
          type="button"
          onClick={(ev) => {
            ev.stopPropagation()
            onPrev()
          }}
          aria-label="รูปก่อนหน้า"
          className="absolute left-4 rounded-full bg-white/20 p-2 text-white hover:bg-white/30"
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
          className="absolute right-4 rounded-full bg-white/20 p-2 text-white hover:bg-white/30"
        >
          <ChevronRight size={22} />
        </button>
      )}
      <div onClick={(ev) => ev.stopPropagation()} className="max-h-[85vh] max-w-[90vw]">
        {url ? (
          <img src={url} alt="" className="max-h-[85vh] max-w-[90vw] rounded-lg object-contain" />
        ) : (
          <p className="text-white">กำลังโหลด...</p>
        )}
      </div>
    </div>
  )
}
