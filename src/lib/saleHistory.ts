// ===== ประวัติการขายเครื่องคืน (Sale History P&L) =====

export interface SaleHistoryInput {
  contractId: string
  contractNo: string
  customerName: string
  shopName: string

  // ราคาเครื่อง (จาก contracts.financeAmount หรือ device price ที่บันทึก)
  deviceListPrice: number

  // ยอดโอนให้ร้านสุทธิ = ต้นทุนเงินสดบริษัทต่อเครื่อง (contracts.net_transfer)
  netTransfer: number

  // เงินดาวน์ (contracts.down_payment) — ใช้แสดงคอลัมน์เท่านั้น ไม่ใช้ใน P&L
  downPayment: number

  // เงินที่ลูกค้าผ่อนรวม (ไม่รวมค่าปรับ)
  // — จาก payment_log sum(amount - penalty_paid_amount)
  customerPaidPrincipal: number

  // เงินที่ขายเครื่องคืนได้ (device_returns.sale_price)
  resalePrice: number

  // metadata
  returnedAt: string       // device_returns.returned_at
  shippedAt: string | null // device_returns.shipped_at (ถ้าจัดส่งเรียบร้อย)
}

export interface SaleHistoryRow extends SaleHistoryInput {
  profitLoss: number       // + = กำไร, - = ขาดทุน
  profitLossLabel: string  // "กำไร" | "ขาดทุน" | "คุ้มทุน"
}

// สูตรผลกำไร/ขาดทุน per Pete's P&L view:
//   cost     = ยอดโอนร้านสุทธิ (net_transfer) — เงินสดบริษัทจ่ายออกต่อเครื่อง
//   recovery = เงินลูกค้าผ่อน (ไม่รวมค่าปรับ) + เงินขายเครื่องคืน
//   profitLoss = recovery - cost   (บวก = กำไร, ลบ = ขาดทุน)
//
// หมายเหตุ: ไม่นับเงินดาวน์ใน recovery เพราะลูกค้าจ่ายดาวน์ให้ร้านตรง ไม่เข้าบริษัท
// และไม่บวกค่าคอมแยกใน cost เพราะค่าคอมรวมอยู่ใน net_transfer แล้ว
// ⚠️ ผู้ wire ข้อมูลนี้เข้า report ต้องใช้ convention นี้ (positive = profit)
//
// Trace จริง S00017PNQ95: netTransfer=38,338 · customerPaid=14,071 · resale=35,000
//                          recovery=49,071 − cost 38,338 = +10,733 → "กำไร"
// Trace 2 (ขาดทุน): netTransfer=40,000 · customerPaid=5,000 · resale=20,000
//                    recovery=25,000 − cost 40,000 = -15,000 → "ขาดทุน"
// Trace 3 (คุ้มทุน): profitLoss=0 → "คุ้มทุน"
export function buildSaleHistoryRow(input: SaleHistoryInput): SaleHistoryRow {
  const cost = input.netTransfer
  const recovery = input.customerPaidPrincipal + input.resalePrice
  const profitLoss = recovery - cost

  let profitLossLabel: string
  if (profitLoss > 0) profitLossLabel = 'กำไร'
  else if (profitLoss < 0) profitLossLabel = 'ขาดทุน'
  else profitLossLabel = 'คุ้มทุน'

  return { ...input, profitLoss, profitLossLabel }
}

export function buildSaleHistory(inputs: SaleHistoryInput[]): SaleHistoryRow[] {
  return inputs.map(buildSaleHistoryRow)
}
