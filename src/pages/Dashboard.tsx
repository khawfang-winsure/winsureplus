import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  Mail,
  Receipt,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { Loading, PageTitle } from '../components/ui'
import { getAllStatuses, getContracts } from '../lib/db'
import { useAsync } from '../lib/useAsync'
import type { Contract, ContractStatusRow } from '../lib/types'

export default function Dashboard() {
  const navigate = useNavigate()
  const { data, loading } = useAsync(
    async () => {
      const [contracts, statuses] = await Promise.all([getContracts(), getAllStatuses()])
      return { contracts, statuses }
    },
    { contracts: [] as Contract[], statuses: [] as ContractStatusRow[] },
  )

  const total = data.contracts.length
  const pendingSummary = data.contracts.filter((c) => !c.summarySentAt).length
  const pendingEmail = data.contracts.filter((c) => !c.emailSentAt).length
  const overdue = data.statuses.filter((s) => s.bucket !== 'normal').length

  const cards: { label: string; value: number; icon: LucideIcon; to: string; tone: string; sub?: string }[] = [
    { label: 'ลูกค้าทั้งหมด', value: total, icon: Users, to: '/customers', tone: 'text-ink' },
    { label: 'รอสรุปยอด', value: pendingSummary, icon: Receipt, to: '/waiting-summary', tone: 'text-amber-600', sub: 'รวมทุกเคสค้าง' },
    { label: 'รอส่งอีเมล', value: pendingEmail, icon: Mail, to: '/waiting-email', tone: 'text-amber-600', sub: 'รวมทุกเคสค้าง' },
    { label: 'ล่าช้า-หนี้เสีย', value: overdue, icon: AlertTriangle, to: '/customers?bucket=overdue', tone: 'text-red-600' },
  ]

  return (
    <div>
      <PageTitle sub="สรุปภาพรวมระบบ — คลิกการ์ดเพื่อดูรายละเอียด">ภาพรวม</PageTitle>
      {loading ? (
        <Loading />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((c) => (
            <button
              key={c.label}
              onClick={() => navigate(c.to)}
              className="flex items-center gap-4 rounded-2xl border border-peach bg-peach-light/40 p-5 text-left transition hover:bg-peach-light/70"
            >
              <div className="rounded-xl bg-white p-3 shadow-sm">
                <c.icon size={24} className={c.tone} />
              </div>
              <div>
                <p className="text-sm text-ink-soft">{c.label}</p>
                <p className={`text-3xl font-bold ${c.tone}`}>{c.value}</p>
                {c.sub && <p className="text-xs text-ink-soft">{c.sub}</p>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
