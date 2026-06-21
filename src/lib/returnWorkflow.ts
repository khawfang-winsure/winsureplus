// ===== Device Pipeline — state machine (pure functions) =====
// ไฟล์นี้ไม่ import Supabase/DOM ใดๆ ทดสอบได้แยก ใช้ร่วมกันได้ทุกหน้า

export type DeviceStatus =
  | 'in_transit'      // อยู่ระหว่างจัดส่ง (starting state — ร้านส่งพัสดุมา)
  | 'pending_check'
  | 'checked'
  | 'pending_sale'
  | 'priced'
  | 'transferred'
  | 'shipped'

export const DEVICE_STATUS_LABEL: Record<DeviceStatus, string> = {
  in_transit: 'อยู่ระหว่างจัดส่ง',
  pending_check: 'รอตรวจสอบ',
  checked: 'ตรวจสอบเรียบร้อยแล้ว',
  pending_sale: 'รอเสนอขาย',
  priced: 'ได้ราคาขายแล้วรอร้านโอน',
  transferred: 'ร้านโอนแล้วรอจัดส่ง',
  shipped: 'จัดส่งให้ร้านค้าเรียบร้อย',
}

// สถานะที่เปลี่ยนได้ต่อไป (one-way linear pipeline)
// in_transit → pending_check เท่านั้น (ของถึงพนักงาน กดรับ)
// in_transit ไม่มีสถานะใดเปลี่ยนมาได้ (เป็น valid starting state)
const ALLOWED_TRANSITIONS: Record<DeviceStatus, DeviceStatus[]> = {
  in_transit: ['pending_check'],
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

/**
 * รายชื่อขนส่ง (สำหรับ dropdown เลือกบริษัทขนส่งเมื่อสร้าง return แบบส่งพัสดุ)
 * import { COURIERS } from '../lib/returnWorkflow'
 */
export const COURIERS = [
  'ไปรษณีย์ไทย',
  'Kerry Express',
  'Flash Express',
  'J&T Express',
  'Shopee Express',
  'นิ่มเอ็กซ์เพรส',
  'อื่นๆ',
] as const

export type Courier = (typeof COURIERS)[number]

/*
  trace test (run in browser console หรือ Deno):

  import { canTransition, nextStatuses, DEVICE_STATUS_LABEL, COURIERS } from './returnWorkflow'

  // ✅ valid transitions (pipeline ปกติ)
  console.assert(canTransition('pending_check', 'checked') === true)
  console.assert(canTransition('checked', 'pending_sale') === true)
  console.assert(canTransition('pending_sale', 'priced') === true)
  console.assert(canTransition('priced', 'transferred') === true)
  console.assert(canTransition('transferred', 'shipped') === true)

  // ✅ in_transit → pending_check (ของถึงพนักงาน กดเปลี่ยนสถานะ)
  console.assert(canTransition('in_transit', 'pending_check') === true)

  // ❌ in_transit → checked ต้องผ่าน pending_check ก่อน
  console.assert(canTransition('in_transit', 'checked') === false)

  // ❌ in_transit → shipped ข้ามขั้น
  console.assert(canTransition('in_transit', 'shipped') === false)

  // ❌ invalid transitions (skip step / reverse)
  console.assert(canTransition('pending_check', 'shipped') === false)
  console.assert(canTransition('shipped', 'pending_check') === false)
  console.assert(canTransition('checked', 'shipped') === false)

  // terminal
  console.assert(nextStatuses('shipped').length === 0)

  // in_transit เป็น starting state → nextStatuses คืน ['pending_check']
  console.assert(nextStatuses('in_transit')[0] === 'pending_check')

  // labels
  console.assert(DEVICE_STATUS_LABEL['in_transit'] === 'อยู่ระหว่างจัดส่ง')
  console.assert(DEVICE_STATUS_LABEL['pending_check'] === 'รอตรวจสอบ')
  console.assert(DEVICE_STATUS_LABEL['shipped'] === 'จัดส่งให้ร้านค้าเรียบร้อย')

  // COURIERS
  console.assert(COURIERS[0] === 'ไปรษณีย์ไทย')
  console.assert(COURIERS.length === 7)

  console.log('returnWorkflow trace test passed')
*/
