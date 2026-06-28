// ===== ประวัติการขายเครื่องคืน (Sale History P&L) =====

export interface SaleHistoryInput {
  contractId: string
  contractNo: string
  customerName: string
  shopName: string

  // ราคาเครื่อง = finance_amount (ยอดจัดไฟแนนซ์ = afterDown)
  deviceListPrice: number

  // ค่าคอมร้าน = finance_amount × commission_percent / 100 (ปัดเศษแล้วใน db.ts)
  commissionPercent: number
  commission: number

  // เงินที่ลูกค้าจ่ายจริง แยก 2 ก้อน (payment_log action='pay', ไม่รวมค่าปรับ)
  downPaid: number          // เงินดาวน์ (installment_id IS NULL)
  installmentPaid: number   // งวดจริง (installment_id NOT NULL)
  installmentCount: number  // จำนวนงวดที่ผ่อนจริง (count DISTINCT installment_id)

  // เงินที่ขายเครื่องคืนได้ (device_returns.sale_price); null/0 = ยังไม่ขาย
  resalePrice: number

  // metadata
  returnedAt: string        // วันที่ขาย/โอน
}

export interface SaleHistoryRow extends SaleHistoryInput {
  transferToShop: number   // ต้นทุน — เงินสดบริษัทจ่ายให้ร้านต่อเครื่อง
  recovery: number         // เก็บเงินคืน — ดาวน์ + ผ่อน + ขายเครื่องคืน
  profitLoss: number       // + = กำไร, - = ขาดทุน, 0 = คุ้มทุน
  profitLossLabel: string  // "กำไร" | "ขาดทุน" | "คุ้มทุน"
}

// สูตรผลกำไร/ขาดทุน per Pete's P&L view:
//   transferToShop = deviceListPrice + commission   (โอนให้ร้าน = finance + ค่าคอม)
//                    ⚠️ Pete สั่ง: รวมค่าเอกสาร — ไม่หัก docFee
//   recovery       = downPaid + installmentPaid + resale  (เก็บเงินคืนทุกก้อน)
//   profitLoss     = recovery − transferToShop   (บวก = กำไร, ลบ = ขาดทุน)
//
// Trace จริง ปรียพัธน์:
//   deviceListPrice = 34,320 · commission = 4,118 → transferToShop = 38,438
//   downPaid = 8,580 · installmentPaid = 5,491 · resale = 35,000 → recovery = 49,071
//   profitLoss = 49,071 − 38,438 = +10,633 → "กำไร"
export function buildSaleHistoryRow(input: SaleHistoryInput): SaleHistoryRow {
  const transferToShop = input.deviceListPrice + input.commission
  const resale = input.resalePrice ?? 0
  const recovery = input.downPaid + input.installmentPaid + resale
  const profitLoss = recovery - transferToShop

  let profitLossLabel: string
  if (profitLoss > 0) profitLossLabel = 'กำไร'
  else if (profitLoss < 0) profitLossLabel = 'ขาดทุน'
  else profitLossLabel = 'คุ้มทุน'

  return { ...input, transferToShop, recovery, profitLoss, profitLossLabel }
}

export function buildSaleHistory(inputs: SaleHistoryInput[]): SaleHistoryRow[] {
  return inputs.map(buildSaleHistoryRow)
}
