// TransferDocSlots — ช่องแนบเอกสาร "เปลี่ยนผู้ผ่อน" (feature ใหม่ 2026-09-14, owner-approved brief)
// รูปเท่านั้น (jpeg/png/webp) ไม่มีคลิป ไม่มีการเทียบ PJ — เอา UX pattern (ลากวาง, เลือกจากคลังบนไอแพด,
// ปุ่มลบกดได้บนจอสัมผัสเสมอ ไม่ใช่ hover-only, ซูมรูป) มาจาก ContractMediaCard.tsx แต่เขียนใหม่เป็นเวอร์ชันเล็ก
// เพราะ ContractMediaCard ผูกกับช่องรูปตัวเครื่องจริงของสัญญา (ดึง media_slots จากค่าตั้ง) ไม่รองรับชุดช่อง
// namespaced แบบ transfer_{N}_* — คำสั่งงาน "ห้ามแก้ ContractMediaCard.tsx" จึงต้องเขียนไฟล์ใหม่แยก
// (ครีมรับทราบจุดนี้แล้ว — ดูสรุปจุดตัดสินใจที่ส่งกลับ)
import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { Trash2, Upload, X, ZoomIn } from 'lucide-react'
import { Loading } from './ui'
import { getContractMedia, getMediaUrl, softDeleteMedia, uploadMedia } from '../lib/db'
import {
  CHECK_IMAGE_MAX_BYTES,
  MEDIA_JPEG_QUALITY,
  MEDIA_JPEG_QUALITY_RETRY,
  MEDIA_MAX_LONG_SIDE,
  MEDIA_TARGET_MAX_BYTES,
  checkImageFile,
  evaluateTransferDocs,
  sniffImageMime,
  transferMediaSlots,
  type MediaFile,
  type SlotEvaluation,
} from '../lib/media'
import type { ContractMediaFile } from '../lib/types'

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

/** ย่อรูปลงเหลือด้านยาวสุด MEDIA_MAX_LONG_SIDE แล้วบีบเป็น JPEG (นโยบายเดียวกับ ContractMediaCard) */
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

function toMediaFile(f: ContractMediaFile): MediaFile {
  return {
    id: f.id,
    slotKey: f.slotKey,
    sha256: f.sha256,
    width: f.width ?? 0,
    height: f.height ?? 0,
    bytes: f.bytes,
    uploadedAt: f.uploadedAt,
  }
}

export type TransferDocsEvaluation = ReturnType<typeof evaluateTransferDocs>

export default function TransferDocSlots({
  contractId,
  transferNo,
  onEvaluationChange,
}: {
  contractId: string
  transferNo: number
  /** ส่ง setState ตรงๆ ได้เลย (identity คงที่จาก useState) — กัน effect วนซ้ำถ้าส่ง inline arrow function ทุก render */
  onEvaluationChange?: (evaluation: TransferDocsEvaluation) => void
}) {
  const slots = useMemo(() => transferMediaSlots(transferNo), [transferNo])
  const [files, setFiles] = useState<ContractMediaFile[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<string | null>(null)
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set())
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [lightboxFile, setLightboxFile] = useState<ContractMediaFile | null>(null)
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const [zoomed, setZoomed] = useState(false)

  const prefix = `transfer_${transferNo}_`

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    getContractMedia(contractId)
      .then((all) => {
        if (cancelled) return
        setFiles(all.filter((f) => f.slotKey.startsWith(prefix)))
      })
      .catch((e) => {
        if (!cancelled) setToast(errMsg(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId, transferNo])

  const evaluation = useMemo(
    () => evaluateTransferDocs(transferNo, files.map(toMediaFile)),
    [transferNo, files],
  )

  useEffect(() => {
    onEvaluationChange?.(evaluation)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evaluation])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(t)
  }, [toast])

  useEffect(() => {
    if (!lightboxFile) {
      setLightboxUrl(null)
      return
    }
    let cancelled = false
    setZoomed(false)
    getMediaUrl(lightboxFile)
      .then((url) => {
        if (!cancelled) setLightboxUrl(url)
      })
      .catch(() => {
        if (!cancelled) setLightboxUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [lightboxFile])

  useEffect(() => {
    if (!lightboxFile) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setLightboxFile(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [lightboxFile])

  function filesForSlot(slotKey: string): ContractMediaFile[] {
    return files.filter((f) => f.slotKey === slotKey)
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
      const sameHashes = new Set(files.map((f) => f.sha256))
      const check = checkImageFile(
        { mime: 'image/jpeg', width, height, bytes: blob.size, sha256 },
        { sameContractHashes: sameHashes },
      )
      if (!check.accept) {
        setToast(check.warnings[0]?.message ?? 'ไฟล์นี้ใช้ไม่ได้')
        return
      }
      if (check.warnings.some((w) => w.code === 'dup_same_contract')) {
        setToast('รูปนี้แนบไว้แล้ว ระบบนับให้ 1 ครั้ง')
        return
      }
      const uploaded = await uploadMedia({ contractId, slotKey, blob, sha256, width, height, mime: 'image/jpeg' })
      setFiles((prev) => [...prev, uploaded])
    } catch (e) {
      setToast(errMsg(e))
    }
  }

  async function handleFiles(slotKey: string, max: number | null, fileList: FileList | File[]) {
    const arr = Array.from(fileList).filter(
      (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(f.name),
    )
    if (arr.length === 0) {
      setToast('เลือกได้เฉพาะไฟล์รูปภาพ')
      return
    }
    setBusyKeys((s) => new Set(s).add(slotKey))
    try {
      for (const file of arr) {
        const current = filesForSlot(slotKey).length
        if (max != null && current >= max) {
          setToast(`ช่องนี้แนบได้สูงสุด ${max} รูป`)
          break
        }
        await processOneFile(slotKey, file)
      }
    } finally {
      setBusyKeys((s) => {
        const n = new Set(s)
        n.delete(slotKey)
        return n
      })
    }
  }

  async function handleDelete(id: string) {
    setDeleteBusy(true)
    try {
      await softDeleteMedia(id)
      setFiles((prev) => prev.filter((f) => f.id !== id))
      setDeleteConfirmId(null)
    } catch (e) {
      setToast(errMsg(e))
    } finally {
      setDeleteBusy(false)
    }
  }

  if (loading) return <Loading label="กำลังโหลดรูป..." />

  return (
    <div className="flex flex-col gap-3">
      {toast && (
        <div role="status" className="rounded-xl border border-peach bg-peach-light/60 px-3 py-2 text-xs text-ink">
          {toast}
        </div>
      )}
      {slots.map((slot) => {
        const slotFiles = filesForSlot(slot.key)
        const evalRow: SlotEvaluation | undefined = evaluation.slots.find((s) => s.key === slot.key)
        const busy = busyKeys.has(slot.key)
        const atMax = slot.max != null && slotFiles.length >= slot.max
        return (
          <div key={slot.key} className="rounded-xl border border-peach p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-ink">
                  {slot.label}
                  <span className="text-red-500"> *</span>
                </p>
                {slot.hint && <p className="text-xs text-ink-soft">{slot.hint}</p>}
              </div>
              <SlotStatusPill status={evalRow?.status ?? 'missing'} count={slotFiles.length} min={slot.min} />
            </div>
            <div
              onDragOver={(e) => {
                e.preventDefault()
                setDragOverKey(slot.key)
              }}
              onDragLeave={() => setDragOverKey((k) => (k === slot.key ? null : k))}
              onDrop={(e) => {
                e.preventDefault()
                setDragOverKey(null)
                if (atMax) {
                  setToast(`ช่องนี้แนบได้สูงสุด ${slot.max} รูป`)
                  return
                }
                void handleFiles(slot.key, slot.max, e.dataTransfer.files)
              }}
              className={`flex flex-wrap items-center gap-2 rounded-lg border-2 border-dashed p-2 transition ${
                dragOverKey === slot.key ? 'border-salmon-deep bg-peach-light/40' : 'border-peach'
              }`}
            >
              {slotFiles.map((f) => (
                <Thumb key={f.id} file={f} onOpen={() => setLightboxFile(f)} onDelete={() => setDeleteConfirmId(f.id)} />
              ))}
              {!atMax && (
                <label className="flex h-20 w-20 shrink-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-peach bg-surface text-ink-soft hover:bg-peach-light/40">
                  <Upload size={16} />
                  <span className="text-[10px]">{busy ? 'กำลังอัป...' : 'เพิ่มรูป'}</span>
                  <input
                    type="file"
                    accept="image/*"
                    multiple={slot.max == null || slot.max - slotFiles.length > 1}
                    className="hidden"
                    disabled={busy}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      if (e.target.files) void handleFiles(slot.key, slot.max, e.target.files)
                      e.target.value = ''
                    }}
                  />
                </label>
              )}
            </div>
          </div>
        )
      })}

      {deleteConfirmId && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4"
          onClick={() => !deleteBusy && setDeleteConfirmId(null)}
        >
          <div className="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <p className="mb-4 text-sm text-ink">ลบรูปนี้?</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-xl border border-peach px-3 py-2 text-sm text-ink"
                disabled={deleteBusy}
                onClick={() => setDeleteConfirmId(null)}
              >
                ยกเลิก
              </button>
              <button
                type="button"
                className="rounded-xl bg-red-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                disabled={deleteBusy}
                onClick={() => void handleDelete(deleteConfirmId)}
              >
                {deleteBusy ? 'กำลังลบ...' : 'ลบรูป'}
              </button>
            </div>
          </div>
        </div>
      )}

      {lightboxFile && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center overflow-auto bg-black/80 p-4"
          onClick={() => setLightboxFile(null)}
        >
          <button
            type="button"
            onClick={() => setLightboxFile(null)}
            aria-label="ปิด"
            className="fixed right-4 top-4 rounded-full bg-white/20 p-2 text-white hover:bg-white/30"
          >
            <X size={20} />
          </button>
          {lightboxUrl ? (
            <img
              src={lightboxUrl}
              alt=""
              onClick={(e) => {
                e.stopPropagation()
                setZoomed((z) => !z)
              }}
              className={`rounded-lg transition ${
                zoomed ? 'max-w-none scale-150 cursor-zoom-out' : 'max-h-[85vh] max-w-full cursor-zoom-in'
              }`}
            />
          ) : (
            <Loading label="กำลังโหลดรูป..." />
          )}
        </div>
      )}
    </div>
  )
}

function Thumb({ file, onOpen, onDelete }: { file: ContractMediaFile; onOpen: () => void; onDelete: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    getMediaUrl(file)
      .then((u) => {
        if (!cancelled) setUrl(u)
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [file])
  return (
    <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-peach bg-peach-light/30">
      <button type="button" onClick={onOpen} className="block h-full w-full">
        {url ? (
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-ink-soft">
            <ZoomIn size={16} />
          </div>
        )}
      </button>
      {/* ปุ่มลบกดได้บนจอสัมผัสเสมอ — ห้าม hover-only (บทเรียนจาก ContractMediaCard/iPad fix 2026-09-13) */}
      <button
        type="button"
        onClick={onDelete}
        aria-label="ลบรูปนี้"
        className="absolute right-1 top-1 rounded-full bg-white/90 p-1 text-red-600 shadow hover:bg-white"
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}

function SlotStatusPill({ status, count, min }: { status: SlotEvaluation['status']; count: number; min: number }) {
  if (status === 'ok') {
    return <span className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-semibold text-green-700">{`ครบ (${count})`}</span>
  }
  if (status === 'partial') {
    return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">{`ขาด (${count}/${min})`}</span>
  }
  return <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">ยังไม่มี</span>
}
