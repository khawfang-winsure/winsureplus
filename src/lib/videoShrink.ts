// ย่อคลิปในเบราว์เซอร์ก่อนอัป (WebCodecs ผ่าน mediabunny) — ผลลัพธ์ไม่มีเสียงเสมอ
// โหลดไลบรารีแบบ dynamic import เฉพาะตอนต้องย่อจริง เพื่อไม่ให้ bundle หลักโต
// ค่าคำนวณบิตเรต/ขนาดภาพย้ายมาจากหน้าต้นแบบที่ทดสอบผ่านแล้ว (prototype-video-shrink.html)
import { sniffVideoMime } from './media'

export const VIDEO_SHRINK_FAIL_MESSAGE =
  'เครื่องนี้ย่อคลิปไม่สำเร็จ ลองจากเครื่องอื่น หรือขอร้านถ่ายใหม่ให้สั้นลง'

export const VIDEO_SHRINK_RELOAD_MESSAGE = 'กรุณารีเฟรชหน้าเว็บแล้วลองใหม่'
export const VIDEO_SHRINK_TOO_LONG_MESSAGE = 'คลิปยาวเกินไป ระบบย่อให้พอดีไม่ได้ ขอร้านถ่ายใหม่ให้สั้นลง'

/** ย่อไม่สำเร็จ/ตรวจผลไม่ผ่าน/เครื่องไม่รองรับ — message เป็นไทยอ่านรู้เรื่อง แสดงให้ผู้ใช้ได้ตรงๆ */
export class VideoShrinkError extends Error {
  constructor(message: string = VIDEO_SHRINK_FAIL_MESSAGE) {
    super(message)
    this.name = 'VideoShrinkError'
  }
}

/** ผู้ใช้กดยกเลิก หรือออกจากหน้า — ไม่ใช่ error ห้ามเด้งข้อความ */
export class VideoShrinkCanceledError extends Error {
  constructor() {
    super('canceled')
    this.name = 'VideoShrinkCanceledError'
  }
}

export interface ShrinkOptions {
  /** 0..1 ของรอบที่กำลังย่อ (ถ้าต้องลองซ้ำ ตัวเลขเริ่มนับใหม่) */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

const AUDIO_NONE = 0
const MAX_FPS = 30
const MIN_VIDEO_BPS = 80_000
const MIN_BITS_PER_PIXEL = 0.07
const MAX_DURATION_DRIFT_SEC = 1
const MAX_ATTEMPTS = 2

interface Plan {
  videoBps: number
  width: number
  height: number
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

/** เลือกบิตเรตภาพ + ขนาดภาพ: ใหญ่สุดที่ยังได้ bits/pixel/frame >= 0.07 และไม่ขยายเกินต้นฉบับ */
function plan(target: number, duration: number, dw: number, dh: number, fps: number, shrinkFactor: number): Plan {
  // เผื่อ container ~3% + 30 KB และเผื่อ encoder เกินเป้าอีก 8%
  const budgetBytes = target * 0.89 - 30_000
  const totalBps = (budgetBytes * 8) / duration
  const videoBps = Math.max(Math.floor((totalBps - AUDIO_NONE) * shrinkFactor), MIN_VIDEO_BPS)
  const longSide = Math.max(dw, dh)
  const cands = [1280, 960, 854, 640, 480].filter((c) => c <= longSide)
  if ((cands.length === 0 || cands[0] < longSide) && longSide <= 1280) cands.unshift(longSide)
  let chosen = cands[cands.length - 1] ?? longSide
  for (const c of cands) {
    const s = c / longSide
    if (videoBps / (dw * s * dh * s * fps) >= MIN_BITS_PER_PIXEL) {
      chosen = c
      break
    }
  }
  const s = Math.min(1, chosen / longSide)
  return { videoBps, width: even(dw * s), height: even(dh * s) }
}

type Mediabunny = typeof import('mediabunny')

/**
 * ย่อคลิปให้ไม่เกิน targetBytes ตัดเสียงเสมอ H.264 สูงสุด 30 fps ลองซ้ำได้ 1 รอบถ้าเกินเป้า
 * ตรวจผลก่อนคืนเสมอ: มีแทร็กภาพ · ความยาวต่างจากต้นฉบับไม่เกิน 1 วินาที · ขนาดไม่เกินเป้า · sniffVideoMime ผ่าน
 * ไม่ผ่านข้อใด -> throw VideoShrinkError (ห้ามเอาไฟล์นั้นไปอัป) ; ยกเลิก -> throw VideoShrinkCanceledError
 */
export async function shrinkVideo(file: File, targetBytes: number, opts: ShrinkOptions = {}): Promise<File> {
  const { signal, onProgress } = opts
  const throwIfCanceled = () => {
    if (signal?.aborted) throw new VideoShrinkCanceledError()
  }
  throwIfCanceled()

  let mb: Mediabunny
  try {
    mb = await import('mediabunny')
  } catch {
    throw new VideoShrinkError(VIDEO_SHRINK_RELOAD_MESSAGE)
  }
  throwIfCanceled()

  let canEncode = false
  try {
    canEncode = await mb.canEncodeVideo('avc', { width: 1280, height: 720, bitrate: 1_000_000 })
  } catch {
    canEncode = false
  }
  if (!canEncode) throw new VideoShrinkError()

  const openInput = () => new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(file) })
  let input = openInput()
  let current: Awaited<ReturnType<Mediabunny['Conversion']['init']>> | null = null
  const onAbort = () => {
    void current?.cancel().catch(() => undefined)
  }
  signal?.addEventListener('abort', onAbort)

  try {
    const vt = await input.getPrimaryVideoTrack()
    if (!vt) throw new VideoShrinkError()
    // ความยาวของแทร็กภาพ (ไม่รวมเสียง) ใช้ทั้งคำนวณบิตเรตและเทียบกับผล
    const duration = await vt.computeDuration()
    if (!Number.isFinite(duration) || duration <= 0) throw new VideoShrinkError()
    // บิตเรตขั้นต่ำยังเกินงบ = ย่อให้พอดีไม่ได้ ไม่ต้องเริ่มเข้ารหัส
    if ((duration * MIN_VIDEO_BPS) / 8 > targetBytes * 0.89 - 30_000) throw new VideoShrinkError(VIDEO_SHRINK_TOO_LONG_MESSAGE)
    if (!(await vt.canDecode())) throw new VideoShrinkError()
    const dw = await vt.getDisplayWidth()
    const dh = await vt.getDisplayHeight()
    let fps = MAX_FPS
    try {
      const st = await vt.computePacketStats(120)
      fps = Math.max(10, Math.min(MAX_FPS, Math.round(st.averagePacketRate)))
    } catch {
      fps = MAX_FPS
    }
    throwIfCanceled()

    let shrinkFactor = 1
    let result: Blob | null = null
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      throwIfCanceled()
      const p = plan(targetBytes, duration, dw, dh, fps, shrinkFactor)
      const bufTarget = new mb.BufferTarget()
      const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: bufTarget })
      const conv = await mb.Conversion.init({
        input,
        output,
        video: {
          codec: 'avc',
          bitrate: p.videoBps,
          width: p.width,
          height: p.height,
          fit: 'fill',
          frameRate: fps,
          forceTranscode: true,
          keyFrameInterval: 2,
        },
        audio: { discard: true },
        showWarnings: false,
      })
      current = conv
      if (signal?.aborted) {
        await conv.cancel().catch(() => undefined)
        throw new VideoShrinkCanceledError()
      }
      if (!conv.isValid) throw new VideoShrinkError()
      conv.onProgress = (fraction) => onProgress?.(Math.min(1, Math.max(0, fraction)))
      try {
        await conv.execute()
      } catch (e) {
        if (signal?.aborted || e instanceof mb.ConversionCanceledError) throw new VideoShrinkCanceledError()
        throw e
      }
      current = null
      const buf = bufTarget.buffer
      if (!buf) throw new VideoShrinkError()
      result = new Blob([buf], { type: 'video/mp4' })
      if (result.size <= targetBytes) break
      if (attempt < MAX_ATTEMPTS) {
        shrinkFactor = Math.min(0.85, (targetBytes * 0.85) / result.size)
        input.dispose()
        input = openInput()
      }
    }
    if (!result) throw new VideoShrinkError()
    await verifyShrunk(mb, result, duration, targetBytes)
    const baseName = file.name.replace(/\.[A-Za-z0-9]+$/, '') || 'clip'
    return new File([result], `${baseName}.mp4`, { type: 'video/mp4' })
  } catch (e) {
    if (e instanceof VideoShrinkCanceledError || e instanceof VideoShrinkError) throw e
    if (signal?.aborted) throw new VideoShrinkCanceledError()
    throw new VideoShrinkError()
  } finally {
    signal?.removeEventListener('abort', onAbort)
    try {
      input.dispose()
    } catch {
      // ปล่อยผ่าน — ล้างทรัพยากรไม่สำเร็จไม่กระทบผล
    }
  }
}

/** ตรวจไฟล์ผลก่อนใช้ — ไม่ผ่านข้อไหน throw VideoShrinkError */
async function verifyShrunk(mb: Mediabunny, blob: Blob, srcDuration: number, targetBytes: number): Promise<void> {
  if (blob.size <= 0 || blob.size > targetBytes) throw new VideoShrinkError()
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
  if (sniffVideoMime(head) !== 'video/mp4') throw new VideoShrinkError()
  const out = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(blob) })
  try {
    const track = await out.getPrimaryVideoTrack()
    if (!track) throw new VideoShrinkError()
    const outDuration = await track.computeDuration()
    if (!Number.isFinite(outDuration) || Math.abs(outDuration - srcDuration) > MAX_DURATION_DRIFT_SEC) {
      throw new VideoShrinkError()
    }
  } finally {
    out.dispose()
  }
}
