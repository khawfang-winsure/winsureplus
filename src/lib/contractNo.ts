// ===== คำนวณเลขที่สัญญาถัดไป (รันอัตโนมัติแยกตามร้าน) =====
// เลขสัญญาหน้าตา: <prefix><ลำดับ>  เช่น "S00016PNQ280", "P-JA020099"
// กฎ: filter เฉพาะ prefix ของร้านนั้น → หาลำดับสูงสุด → +1
// (แก้บั๊ก: เดิมหยิบเลขปน prefix ผิดมาแทนรหัสร้าน)

/**
 * หา prefix + width จาก shopCode
 * - "AQ S00001" → { prefix: "S00001PNQ", width: 3 }
 * - "AQ S00016" → { prefix: "S00016PNQ", width: 3 }
 * - "JA02"      → { prefix: "P-JA02",    width: 4 }
 * - อื่นๆ       → null (พนักงานพิมพ์เอง)
 */
export function derivePrefix(code: string): { prefix: string; width: number } | null {
  const c = code.trim().toUpperCase()

  // รูปแบบ AQ S00XXX  (เช่น "AQ S00001", "AQ S00016")
  const aqMatch = /^AQ\s*(S\d+)$/i.exec(c)
  if (aqMatch) {
    return { prefix: aqMatch[1].toUpperCase() + 'PNQ', width: 3 }
  }

  // รูปแบบ JA##  (เช่น "JA02", "JA12")
  const jaMatch = /^JA\d+$/i.exec(c)
  if (jaMatch) {
    return { prefix: 'P-' + c, width: 4 }
  }

  return null
}

/**
 * หาเลขที่สัญญาถัดไปสำหรับร้านนี้
 * @param shopCode - รหัสร้าน (เช่น "AQ S00001", "JA02")
 * @param existing - รายการเลขสัญญาทั้งหมดของร้านนี้ (จาก getShopContractNos)
 * @returns เลขถัดไป หรือ null ถ้า shopCode ไม่ตรง pattern (ให้พนักงานพิมพ์เอง)
 *
 * Trace tests (แบม 2026-06-19):
 * A: ('AQ S00001', ['S00018PNQ232','S00001PNQ005','S00001PNQ003']) → 'S00001PNQ006'
 *    (ไม่นับ S00018PNQ232 เพราะ prefix ต่างกัน)
 * B: ('AQ S00001', ['S00018PNQ232']) → 'S00001PNQ001'
 *    (ไม่มี S00001PNQ* เลย → เริ่มที่ 001)
 * C: ('AQ S00016', ['S00016PNQ280','S00016PNQ279']) → 'S00016PNQ281'
 * D: ('JA02', []) → 'P-JA020001'
 * E: ('AQ S00001', ['S00001PNQ001','S00001PNQ002','S00001PNQ003']) → 'S00001PNQ004'
 * F: ('PARTNER001', []) → null (fallback พิมพ์เอง)
 */
export function nextContractNo(shopCode: string, existing: string[]): string | null {
  const p = derivePrefix(shopCode)
  if (!p) return null

  // กรอง + แปลงเฉพาะเลขที่ขึ้นต้นด้วย prefix ของร้านนี้
  const bucket = existing
    .filter((no) => no.startsWith(p.prefix))
    .map((no) => no.slice(p.prefix.length))
    .filter((tail) => /^\d+$/.test(tail))
    .map(Number)

  const usedSet = new Set(bucket)
  const maxSeq = bucket.length ? Math.max(...bucket) : 0

  let candidate = maxSeq + 1
  while (usedSet.has(candidate)) candidate++

  return p.prefix + String(candidate).padStart(p.width, '0')
}
