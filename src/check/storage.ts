// ===== จำรหัสร้าน + token บนเครื่องนี้ (localStorage) =====
// try/catch ทุกจุด — private mode / quota เต็ม ต้องไม่ทำแอปพัง แค่ให้ผู้ใช้ login ใหม่ทุกครั้งแทน

const STORAGE_KEY = 'wsp_credit_check_session_v1'

export interface StoredSession {
  loginCode: string
  token: string
  shopName: string
  savedAt: number // epoch ms — ไว้โชว์/debug เฉยๆ ไม่ใช้ตัดสิน expiry (server เป็นคนตัดสินจริงตอนเรียก API)
}

function isStoredSession(v: unknown): v is StoredSession {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return typeof s.loginCode === 'string' && typeof s.token === 'string' && typeof s.shopName === 'string'
}

export function loadStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isStoredSession(parsed)) return null
    return { ...parsed, savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0 }
  } catch {
    return null
  }
}

export function saveStoredSession(session: StoredSession): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
  } catch {
    // จำไม่ได้ (private mode ฯลฯ) — ผู้ใช้แค่ต้อง login ใหม่ทุกครั้ง ไม่ใช่ bug ที่ต้อง throw ต่อ
  }
}

export function clearStoredSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // เข้าถึง localStorage ไม่ได้ตั้งแต่แรก — ไม่มีอะไรต้องลบอยู่แล้ว
  }
}

/** ใช้ prefill ช่อง "รหัสร้าน" ตอนต้อง login ใหม่ (เช่น token หมดอายุ) จะได้ไม่ต้องพิมพ์รหัสร้านซ้ำ */
export function loadRememberedLoginCode(): string {
  return loadStoredSession()?.loginCode ?? ''
}
