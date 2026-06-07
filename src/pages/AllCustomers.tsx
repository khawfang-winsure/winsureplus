import { Badge, Loading, PageTitle } from '../components/ui'
import { baht, conditionLabel, statusLabel, thaiDate } from '../lib/format'
import { getContracts, getShops } from '../lib/db'
import { useAsync } from '../lib/useAsync'

export default function AllCustomers() {
  const { data, loading } = useAsync(
    async () => {
      const [contracts, shops] = await Promise.all([getContracts(), getShops()])
      return { contracts, shops }
    },
    { contracts: [], shops: [] },
  )

  const shopName = (id: string) => data.shops.find((s) => s.id === id)?.name ?? '-'

  return (
    <div>
      <PageTitle sub={loading ? '' : `ทั้งหมด ${data.contracts.length} รายการ`}>ลูกค้าทั้งหมด</PageTitle>

      {loading ? (
        <Loading />
      ) : (
        <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
          <table className="w-full min-w-[1100px] border-collapse text-sm">
            <thead>
              <tr className="bg-peach-light text-left text-ink">
                {['วันที่', 'เลขที่สัญญา', 'INV', 'ชื่อลูกค้า', 'ร้านค้า', 'สถานะ', 'รุ่น', 'ความจำ', 'ราคาเครื่อง', 'ชำระ/เดือน', 'เดือน', 'สินค้า'].map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2.5 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.contracts.map((c, i) => (
                <tr key={c.id} className={i % 2 ? 'bg-white' : 'bg-peach-light/20'}>
                  <td className="whitespace-nowrap px-3 py-2.5">{thaiDate(c.transactionDate)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 font-medium">{c.contractNo}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-ink-soft">{c.invNo}</td>
                  <td className="whitespace-nowrap px-3 py-2.5">{c.customerName}</td>
                  <td className="whitespace-nowrap px-3 py-2.5">{shopName(c.shopId)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <Badge tone={c.status === 'active' ? 'green' : 'neutral'}>{statusLabel(c.status)}</Badge>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">{c.model}</td>
                  <td className="whitespace-nowrap px-3 py-2.5">{c.storage}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right">{baht(c.devicePrice)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right">{baht(c.monthlyPayment)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-center">{c.termMonths}</td>
                  <td className="whitespace-nowrap px-3 py-2.5">{conditionLabel(c.condition)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
