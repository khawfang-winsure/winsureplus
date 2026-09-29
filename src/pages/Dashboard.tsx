import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  Mail,
  Receipt,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { Loading, PageTitle } from '../components/ui'
import { getDashboardCounts, type DashboardCounts } from '../lib/db'

export default function Dashboard() {
  const navigate = useNavigate()
  const [data, setData] = useState<DashboardCounts | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [tick, setTick] = useState(0)

  // โหลดไม่สำเร็จ → โชว์ข้อความ + ปุ่มลองใหม่ (ห้ามโชว์ 0 เพราะคนอ่านจะเข้าใจว่าไม่มีข้อมูล)
  useEffect(() => {
    let active = true
    setLoading(true)
    setFailed(false)
    getDashboardCounts()
      .then((d) => {
        if (active) setData(d)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [tick])

  const cards: { label: string; value: number; icon: LucideIcon; to: string; tone: string; sub?: string }[] = [
    { label: 'ลูกค้าทั้งหมด', value: data?.total ?? 0, icon: Users, to: '/customers', tone: 'text-ink' },
    { label: 'รอสรุปยอด', value: data?.pendingSummary ?? 0, icon: Receipt, to: '/waiting-summary', tone: 'text-amber-600', sub: 'รวมทุกเคสค้าง' },
    { label: 'รอส่งอีเมล', value: data?.pendingEmail ?? 0, icon: Mail, to: '/waiting-email', tone: 'text-amber-600', sub: 'รวมทุกเคสค้าง' },
    { label: 'ล่าช้า-หนี้เสีย', value: data?.overdue ?? 0, icon: AlertTriangle, to: '/customers?bucket=overdue', tone: 'text-red-600' },
  ]

  return (
    <div>
      <PageTitle sub="สรุปภาพรวมระบบ — คลิกการ์ดเพื่อดูรายละเอียด">ภาพรวม</PageTitle>
      {loading ? (
        <Loading />
      ) : failed || !data ? (
        <div className="flex flex-col items-start gap-3 rounded-2xl border border-peach bg-peach-light/40 p-5" role="alert">
          <p className="text-sm text-red-600">โหลดข้อมูลไม่สำเร็จ</p>
          <button
            onClick={() => setTick((n) => n + 1)}
            className="rounded-xl border border-peach px-3 py-1.5 text-sm text-ink-soft hover:bg-peach-light"
          >
            ลองใหม่
          </button>
        </div>
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
