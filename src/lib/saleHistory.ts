// ===== ประวัติการขายเครื่องคืน (Sale History P&L) =====

export interface SaleHistoryInput {
  contractId: string
  contractNo: string
  customerName: string
  shopName: string

  // ราคาเครื่อง (จาก contracts.financeAmount หรือ device price ที่บันทึก)
  deviceListPrice: number

  // ค่าคอม (จาก commission สำหรับ contract นี้ — admin/staff โอนให้ร้านแล้ว)
  commissionPaid: number

  // เงินดาวน์ (contracts.down_payment)
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
//   cost     = ราคาเครื่อง + ค่าคอม
//   recovery = เงินดาวน์ + เงินผ่อน (ไม่รวมค่าปรับ) + เงินขายเครื่องคืน
//   profitLoss = recovery - cost
//
// หมายเหตุ: Pete ระบุสูตรเดิมว่า cost − recovery ("บวก = ขาดทุน")
// แต่ที่นี่ใช้ recovery − cost เพื่อให้ profitLoss เป็น conventional P&L sign
// (บวก = กำไร, ลบ = ขาดทุน) — ตรงกับ profitLossLabel ทุกเคส
// ⚠️ ผู้ wire ข้อมูลนี้เข้า report ต้องใช้ convention นี้ (positive = profit)
//
// Trace 1 (ขาดทุน): price=20000 comm=2000 → cost=22000
//                    down=3000 paid=5000 resale=8000 → recovery=16000
//                    profitLoss=-6000 → "ขาดทุน"
// Trace 2 (กำไร):   price=15000 comm=1500 → cost=16500
//                    down=4000 paid=10000 resale=5000 → recovery=19000
//                    profitLoss=+2500 → "กำไร"
// Trace 3 (คุ้มทุน): profitLoss=0 → "คุ้มทุน"
export function buildSaleHistoryRow(input: SaleHistoryInput): SaleHistoryRow {
  const cost = input.deviceListPrice + input.commissionPaid
  const recovery = input.downPayment + input.customerPaidPrincipal + input.resalePrice
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
