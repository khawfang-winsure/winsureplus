import { useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Badge, Card, EmptyState, Loading, PageTitle } from '../components/ui'
import { baht, thaiDate } from '../lib/format'
import { getSaleHistoryRaw, type SaleHistoryInput as RawInput } from '../lib/db'
import { buildSaleHistory, type SaleHistoryRow } from '../lib/saleHistory'
import { useAsync } from '../lib/useAsync'
import { useAuth } from '../lib/auth'

// ===== ปรับ raw output ของ db → แบบที่ buildSaleHistory ต้องการ =====
function adaptRaw(raw: RawInput): Parameters<typeof buildSaleHistory>[0][number] {
  return {
    contractId: raw.contractId,
    contractNo: raw.contractNo,
    customerName: raw.customerName,
    shopName: raw.shopName,
    deviceListPrice: raw.deviceListPrice,
    commissionPaid: raw.commissionPaid,
    downPayment: raw.downPayment,
    customerPaidPrincipal: raw.customerPaidPrincipal,
    resalePrice: raw.resalePrice ?? 0,        // null → 0 (ยังไม่ขาย)
    returnedAt: raw.returnedAt ?? '',          // null → '' (ไม่มีวันที่)
    shippedAt: null,                           // db ยังไม่ expose — ⚠️ flag น้องชีส
  }
}

// ===== ดึง YYYY-MM จาก returnedAt เพื่อทำ month filter =====
function monthKey(iso: string): string {
  if (!iso) return ''
  return iso.slice(0, 7) // "2025-11"
}

function monthLabel(key: string): string {
  if (!key) return '-'
  const [y, m] = key.split('-')
  const MONTHS = ['', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
  const buddhistYear = String(Number(y) + 543).slice(2)
  return `${MONTHS[Number(m)]} ${buddhistYear}`
}

// ===== Summary card =====
function Summary({ rows }: { rows: SaleHistoryRow[] }) {
  const totalProfit = rows.filter((r) => r.profitLoss > 0).reduce((s, r) => s + r.profitLoss, 0)
  const totalLoss = rows.filter((r) => r.profitLoss < 0).reduce((s, r) => s + r.profitLoss, 0)
  const net = rows.reduce((s, r) => s + r.profitLoss, 0)

  return (
    <div className="mb-6 grid grid-cols-3 gap-3">
      <Card className="p-4 text-center">
        <p className="text-xs text-ink-soft mb-1">กำไรสะสม</p>
        <p className="text-lg font-semibold text-green-600">{totalProfit > 0 ? `+${baht(totalProfit)} ฿` : '0 ฿'}</p>
      </Card>
      <Card className="p-4 text-center">
        <p className="text-xs text-ink-soft mb-1">ขาดทุนสะสม</p>
        <p className="text-lg font-semibold text-red-600">{totalLoss < 0 ? `${baht(totalLoss)} ฿` : '0 ฿'}</p>
      </Card>
      <Card className="p-4 text-center">
        <p className="text-xs text-ink-soft mb-1">Net</p>
        <p className={`text-lg font-semibold ${net > 0 ? 'text-green-600' : net < 0 ? 'text-red-600' : 'text-ink-soft'}`}>
          {net > 0 ? `+${baht(net)} ฿` : net < 0 ? `${baht(net)} ฿` : '0 ฿'}
        </p>
      </Card>
    </div>
  )
}

// ===== P&L badge =====
function ProfitBadge({ value }: { value: number }) {
  if (value > 0) return <Badge tone="green">+{baht(value)} ฿</Badge>
  if (value < 0) return <Badge tone="red">{baht(value)} ฿</Badge>
  return <span className="text-ink-soft text-xs">0 ฿</span>
}

// ===== หน้าหลัก =====
export default function SaleHistory() {
  const { role, configured } = useAuth()
  const isAdmin = !configured || role === 'admin'
  if (!isAdmin) return <Navigate to="/" replace />

  const { data: rawRows, loading, error } = useAsync(
    () => getSaleHistoryRaw(),
    [],
  )

  const rows: SaleHistoryRow[] = useMemo(
    () => buildSaleHistory(rawRows.map(adaptRaw)),
    [rawRows],
  )

  // Month options จาก returnedAt
  const monthOptions = useMemo(() => {
    const keys = [...new Set(rows.map((r) => monthKey(r.returnedAt)).filter(Boolean))]
    return keys.sort().reverse()
  }, [rows])

  const [filterMonth, setFilterMonth] = useState<string>('all')

  const filtered = useMemo(() => {
    if (filterMonth === 'all') return rows
    return rows.filter((r) => monthKey(r.returnedAt) === filterMonth)
  }, [rows, filterMonth])

  return (
    <div>
      <PageTitle
        sub="สรุปผลกำไร/ขาดทุนจากการขายเครื่องคืน"
        count={loading ? undefined : { shown: filtered.length, total: rows.length }}
      >
        ประวัติการขายเครื่อง
      </PageTitle>

      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="text-sm font-medium text-ink">เดือน:</label>
        <select
          value={filterMonth}
          onChange={(e) => setFilterMonth(e.target.value)}
          className="rounded-xl border border-peach bg-white px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-salmon/40"
        >
          <option value="all">ทุกเดือน</option>
          {monthOptions.map((k) => (
            <option key={k} value={k}>
              {monthLabel(k)}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <Loading />
      ) : error ? (
        <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">
          เกิดข้อผิดพลาดในการโหลดข้อมูล กรุณาลองใหม่
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="ยังไม่มีข้อมูลการขายเครื่อง"
          hint="หน้านี้จะแสดงข้อมูลเมื่อมีเครื่องที่จัดส่งหรือโอนให้ร้านค้าแล้ว"
        />
      ) : (
        <>
          <Summary rows={filtered} />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-peach text-left text-ink-soft">
                  <th className="py-2 pr-4 font-medium">วันที่ขาย/โอน</th>
                  <th className="py-2 pr-4 font-medium">สัญญา / ลูกค้า</th>
                  <th className="py-2 pr-4 font-medium">ร้าน</th>
                  <th className="py-2 pr-4 font-medium text-right">ราคาเครื่อง</th>
                  <th className="py-2 pr-4 font-medium text-right">ค่าคอม</th>
                  <th className="py-2 pr-4 font-medium text-right">เงินดาวน์</th>
                  <th className="py-2 pr-4 font-medium text-right">ลูกค้าผ่อน</th>
                  <th className="py-2 pr-4 font-medium text-right">ขายได้</th>
                  <th className="py-2 font-medium text-right">กำไร/ขาดทุน</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr
                    key={r.contractId}
                    className="border-b border-peach/50 hover:bg-peach-light/30"
                  >
                    <td className="py-3 pr-4 text-ink-soft">
                      {r.returnedAt ? thaiDate(r.returnedAt.slice(0, 10)) : '-'}
                    </td>
                    <td className="py-3 pr-4">
                      <p className="font-medium text-ink">{r.customerName}</p>
                      <p className="text-xs text-ink-soft">{r.contractNo}</p>
                    </td>
                    <td className="py-3 pr-4 text-ink">{r.shopName}</td>
                    <td className="py-3 pr-4 text-right text-ink">{baht(r.deviceListPrice)} ฿</td>
                    <td className="py-3 pr-4 text-right text-ink">
                      {r.commissionPaid > 0 ? `${baht(r.commissionPaid)} ฿` : <span className="text-ink-soft">-</span>}
                    </td>
                    <td className="py-3 pr-4 text-right text-ink">{baht(r.downPayment)} ฿</td>
                    <td className="py-3 pr-4 text-right text-ink">{baht(r.customerPaidPrincipal)} ฿</td>
                    <td className="py-3 pr-4 text-right text-ink">
                      {r.resalePrice > 0 ? `${baht(r.resalePrice)} ฿` : <span className="text-ink-soft">-</span>}
                    </td>
                    <td className="py-3 text-right">
                      <ProfitBadge value={r.profitLoss} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
