// ===== คำนวณเลขที่สัญญาถัดไป (รันอัตโนมัติแยกตามร้าน) =====
// เลขสัญญาหน้าตา: <prefix>Q<ลำดับ>  เช่น "S00016PNQ280"
// กฎ: เอาเลขเดิมของร้านที่ตัวเลขหลัง Q มากสุด แล้ว +1 (คงรูปแบบ/จำนวนหลักเดิม)

/**
 * หาเลขที่สัญญาถัดไปจากรายการเลขเดิมของร้าน
 * @returns เลขถัดไป หรือ null ถ้าไม่มีเลขเดิมที่อ่านรูปแบบได้ (ให้พนักงานพิมพ์เคสแรกเอง)
 *
 * ตัวอย่าง: ["S00016PNQ280", "S00016PNQ279"] -> "S00016PNQ281"
 */
export function nextContractNo(existing: string[]): string | null {
  let best: { prefix: string; num: number; width: number } | null = null
  for (const raw of existing) {
    const m = /^(.*[Qq])(\d+)$/.exec(raw.trim()) // ตัวเลขท้ายสุดหลัง Q
    if (!m) continue
    const num = Number(m[2])
    if (!best || num > best.num) best = { prefix: m[1], num, width: m[2].length }
  }
  if (!best) return null
  return best.prefix + String(best.num + 1).padStart(best.width, '0')
}
