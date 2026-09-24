// ===== อ่าน/ย่อ/ตรวจไฟล์แนบก่อนอัป — หน้าเช็คเครดิตสาธารณะ (check.html) =====
// ย่อรูปด้วย canvas ตามนโยบายเดียวกับ src/components/ContractMediaCard.tsx (ค่าคงที่มาจาก lib/media.ts ของแบม)
// ไฟล์นี้เป็น browser-only (ใช้ canvas/crypto.subtle) — ไม่ใช่ pure function module เหมือน lib/media.ts เอง
// เพดานขนาด (8 MB รูป / 10 MB PDF / 10 ไฟล์ต่อคำขอ) ตาม credit-check-api-contract.md บรรทัด sign_upload

import {
  MEDIA_JPEG_QUALITY,
  MEDIA_JPEG_QUALITY_RETRY,
  MEDIA_MAX_LONG_SIDE,
  MEDIA_TARGET_MAX_BYTES,
  sniffImageMime,
} from '../lib/media'

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_PDF_BYTES = 10 * 1024 * 1024
export const MAX_FILES_PER_SUBMIT = 10

export interface ProcessedFile {
  blob: Blob
  mime: string
  size: number
  sha256: string
}

export type ProcessFileResult = { ok: true; result: ProcessedFile } | { ok: false; error: string }

async function canvasToJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('ประมวลผลรูปไม่สำเร็จ'))), 'image/jpeg', quality)
  })
}

/** ย่อรูปลงเหลือด้านยาวสุด MEDIA_MAX_LONG_SIDE แล้วบีบเป็น JPEG (นโยบายเดียวกับ ContractMediaCard.tsx) */
async function resizeImageToJpeg(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  try {
    const longSide = Math.max(bitmap.width, bitmap.height)
    const scale = longSide > MEDIA_MAX_LONG_SIDE ? MEDIA_MAX_LONG_SIDE / longSide : 1
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('เบราว์เซอร์นี้ประมวลผลรูปไม่ได้')
    ctx.drawImage(bitmap, 0, 0, width, height)

    let blob = await canvasToJpegBlob(canvas, MEDIA_JPEG_QUALITY)
    if (blob.size > MEDIA_TARGET_MAX_BYTES) {
      blob = await canvasToJpegBlob(canvas, MEDIA_JPEG_QUALITY_RETRY)
    }
    return blob
  } finally {
    bitmap.close()
  }
}

async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const hashBuf = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * ประมวลผลไฟล์ที่ผู้ใช้เลือก 1 ไฟล์
 * - รูป (jpeg/png/webp/heic ตรวจจาก magic bytes ไม่เชื่อนามสกุล) → ย่อ + แปลงเป็น JPEG เสมอ
 * - PDF (เฉพาะช่องที่ allowPdf=true เช่น statement) → ใช้ไฟล์ดิบ ตรวจแค่ชนิด+ขนาด ไม่ย่อ
 */
export async function processSelectedFile(file: File, opts: { allowPdf: boolean }): Promise<ProcessFileResult> {
  if (opts.allowPdf && file.type === 'application/pdf') {
    if (file.size > MAX_PDF_BYTES) {
      return { ok: false, error: 'ไฟล์ PDF ใหญ่เกิน 10 MB กรุณาแนบไฟล์ที่เล็กลง' }
    }
    const sha256 = await sha256Hex(file)
    return { ok: true, result: { blob: file, mime: 'application/pdf', size: file.size, sha256 } }
  }

  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  const sniffed = sniffImageMime(head)
  if (!sniffed) {
    return {
      ok: false,
      error: opts.allowPdf
        ? 'รองรับเฉพาะไฟล์รูป (JPG/PNG/WEBP/HEIC) หรือ PDF เท่านั้น'
        : 'รองรับเฉพาะไฟล์รูป (JPG/PNG/WEBP/HEIC) เท่านั้น',
    }
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return { ok: false, error: 'ไฟล์รูปใหญ่เกิน 8 MB กรุณาถ่ายใหม่หรือเลือกรูปอื่น' }
  }

  try {
    const resized = await resizeImageToJpeg(file)
    const sha256 = await sha256Hex(resized)
    return { ok: true, result: { blob: resized, mime: 'image/jpeg', size: resized.size, sha256 } }
  } catch {
    return { ok: false, error: 'ประมวลผลรูปไม่สำเร็จ กรุณาลองใหม่หรือเลือกรูปอื่น' }
  }
}
