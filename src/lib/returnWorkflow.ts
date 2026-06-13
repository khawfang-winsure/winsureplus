// ===== Device Pipeline — state machine (pure functions) =====
// ไฟล์นี้ไม่ import Supabase/DOM ใดๆ ทดสอบได้แยก ใช้ร่วมกันได้ทุกหน้า

export type DeviceStatus =
  | 'pending_check'
  | 'checked'
  | 'pending_sale'
  | 'priced'
  | 'transferred'
  | 'shipped'

export const DEVICE_STATUS_LABEL: Record<DeviceStatus, string> = {
  pending_check: 'รอตรวจสอบ',
  checked: 'ตรวจสอบเรียบร้อยแล้ว',
  pending_sale: 'รอเสนอขาย',
  priced: 'ได้ราคาขายแล้วรอร้านโอน',
  transferred: 'ร้านโอนแล้วรอจัดส่ง',
  shipped: 'จัดส่งให้ร้านค้าเรียบร้อย',
}

// สถานะที่เปลี่ยนได้ต่อไป (one-way linear pipeline)
const ALLOWED_TRANSITIONS: Record<DeviceStatus, DeviceStatus[]> = {
  pending_check: ['checked'],
  checked: ['pending_sale'],
  pending_sale: ['priced'],
  priced: ['transferred'],
  transferred: ['shipped'],
  shipped: [], // terminal — ไม่มีสถานะถัดไป
}

/** เช็คว่าการเปลี่ยนสถานะ from → to ถูกต้องตาม pipeline หรือไม่ */
export function canTransition(from: DeviceStatus, to: DeviceStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false
}

/** คืนรายการสถานะที่เปลี่ยนได้จากสถานะปัจจุบัน ([] = terminal) */
export function nextStatuses(from: DeviceStatus): DeviceStatus[] {
  return ALLOWED_TRANSITIONS[from] ?? []
}

/*
  trace test (run in browser console หรือ Deno):

  import { canTransition, nextStatuses, DEVICE_STATUS_LABEL } from './returnWorkflow'

  // ✅ valid transitions
  console.assert(canTransition('pending_check', 'checked') === true)
  console.assert(canTransition('checked', 'pending_sale') === true)
  console.assert(canTransition('pending_sale', 'priced') === true)
  console.assert(canTransition('priced', 'transferred') === true)
  console.assert(canTransition('transferred', 'shipped') === true)

  // ❌ invalid transitions (skip step / reverse)
  console.assert(canTransition('pending_check', 'shipped') === false)
  console.assert(canTransition('shipped', 'pending_check') === false)
  console.assert(canTransition('checked', 'shipped') === false)

  // terminal
  console.assert(nextStatuses('shipped').length === 0)

  // labels
  console.assert(DEVICE_STATUS_LABEL['pending_check'] === 'รอตรวจสอบ')
  console.assert(DEVICE_STATUS_LABEL['shipped'] === 'จัดส่งให้ร้านค้าเรียบร้อย')

  console.log('returnWorkflow trace test passed')
*/
