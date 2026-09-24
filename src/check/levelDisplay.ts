// ===== ข้อความ/สีตามผลระดับ engine_level (DB naming) — ใช้ร่วมกันทั้ง ResultScreen + RequestsList =====
// ห้ามใช้คำว่า "อนุมัติ"/"ปฏิเสธ" เด็ดขาด (decisions.md 2026-09-23 — ผลนี้แค่เบื้องต้น รอทีมยืนยันเสมอ)
import type { EngineLevel } from './api'

export const LEVEL_DISPLAY: Record<EngineLevel, { emoji: string; title: string; tone: 'red' | 'amber' | 'green' }> = {
  fail: { emoji: '❌', title: 'ไม่ผ่านเบื้องต้น', tone: 'red' },
  needs_review: { emoji: '🟡', title: 'รอทีมพิจารณา', tone: 'amber' },
  passed_preliminary: { emoji: '🟢', title: 'ผ่านเบื้องต้น — รอทีมยืนยัน', tone: 'green' },
}
