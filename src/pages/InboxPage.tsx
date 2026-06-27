import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarClock, PackageOpen, MessageCircle, Pin, History } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Loading, PageTitle } from '../components/ui'
import {
  getInboxCases,
  unpinFromInbox,
  type InboxCase,
} from '../lib/db'
import { useAuth } from '../lib/auth'
import { getPromiseDateStatus } from '../lib/priorityQueue'
import { thaiDate } from '../lib/format'
import FollowUpModal from '../components/FollowUpModal'

// ===== helper: เวลาไทยแบบสั้น =====
function thaiDateTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const time = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
  return `${dd}/${mm}/${d.getFullYear()} ${time}`
}

// ===== helper: map สถานะเครื่องคืน (enum) → ไทยอ่านง่าย =====
const DEVICE_STATUS_LABEL: Record<string, string> = {
  in_transit: 'กำลังส่งคืน',
  pending_check: 'รอตรวจ',
  checked: 'ตรวจแล้ว',
  pending_sale: 'รอขาย',
  priced: 'ตั้งราคาแล้ว',
  transferred: 'โอนแล้ว',
}
function deviceStatusLabel(status: string | null): string {
  if (!status) return 'คืนเครื่อง'
  return DEVICE_STATUS_LABEL[status] ?? status
}

// ===== helper: chip บอกเหตุที่เด้งเข้า inbox (sources) =====
const SOURCE_META: Record<string, { label: string; Icon: typeof Pin }> = {
  promise: { label: 'วันนัด', Icon: CalendarClock },
  return: { label: 'คืนเครื่อง', Icon: PackageOpen },
  line_pending: { label: 'LINE', Icon: MessageCircle },
  pinned: { label: 'ปักหมุด', Icon: Pin },
}
const SOURCE_ORDER = ['promise', 'return', 'line_pending', 'pinned']

function SourceChips({ sources }: { sources: string[] }) {
  const ordered = SOURCE_ORDER.filter((s) => sources.includes(s))
  if (ordered.length === 0) return null
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {ordered.map((s) => {
        const meta = SOURCE_META[s]
        if (!meta) return null
        const { label, Icon } = meta
        return (
          <span
            key={s}
            className="inline-flex items-center gap-1 rounded-full bg-peach-light/60 px-2 py-0.5 text-[11px] font-medium text-ink-soft"
          >
            <Icon className="h-3 w-3" aria-hidden />
            {label}
          </span>
        )
      })}
    </div>
  )
}

// ===== helper: ป้ายเตือนวันนัดชำระ =====
function PromiseBadge({ promiseToPayDate }: { promiseToPayDate: string | null }) {
  const { status, days } = getPromiseDateStatus(promiseToPayDate)
  if (status === 'none' || !promiseToPayDate) return null

  let cls = 'bg-cream-deep text-ink-soft'
  let text = `นัด ${thaiDate(promiseToPayDate)}`
  if (status === 'overdue') {
    cls = 'bg-red-100 text-red-700'
    text = `เลยนัด ${Math.abs(days ?? 0)} วัน`
  } else if (status === 'due_today') {
    cls = 'bg-orange-100 text-orange-700'
    text = 'ถึงวันนัดวันนี้'
  } else if (status === 'due_tomorrow') {
    cls = 'bg-yellow-100 text-yellow-700'
    text = 'ใกล้นัด (พรุ่งนี้)'
  }

  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      <CalendarClock className="h-3 w-3" aria-hidden />
      {text}
    </span>
  )
}

// ===== helper: ป้ายคืนเครื่อง =====
function DeviceReturnBadge({ c }: { c: InboxCase }) {
  if (!c.hasDeviceReturn) return null
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700">
      <PackageOpen className="h-3 w-3" aria-hidden />
      {deviceStatusLabel(c.deviceReturnStatus)}
      {c.deviceReturnAt ? ` · ${thaiDate(c.deviceReturnAt.slice(0, 10))}` : ''}
    </span>
  )
}

// ===== component หลัก =====
export default function InboxPage() {
  const { role } = useAuth()

  const [cases, setCases] = useState<InboxCase[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [followUpTarget, setFollowUpTarget] = useState<InboxCase | null>(null)
  const [unpinBusy, setUnpinBusy] = useState<string | null>(null) // contractId ที่กำลัง unpin

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getInboxCases()
      setCases(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function handleUnpin(contractId: string) {
    setUnpinBusy(contractId)
    try {
      await unpinFromInbox(contractId)
      await load()
    } finally {
      setUnpinBusy(null)
    }
  }

  return (
    <div>
      <PageTitle
        sub="เคสที่นัดชำระ / คืนเครื่อง / นัดทาง LINE จะเด้งเข้ามาเอง + เคสที่หยิบเข้ามาติดตาม"
        count={loading ? undefined : { shown: cases.length, total: cases.length }}
      >
        กล่องรับงาน (Inbox)
      </PageTitle>

      {loading && <Loading />}

      {!loading && error && (
        <EmptyState title="โหลดข้อมูลไม่สำเร็จ" hint={error} />
      )}

      {!loading && !error && cases.length === 0 && (
        <EmptyState
          title="ยังไม่มีเคสในกล่องรับงาน"
          hint="เคสที่มีวันนัดชำระ / คืนเครื่อง / บันทึกผล 'นัดทาง LINE – รอลูกค้า' หรือเคสที่เพิ่มเข้ากล่องเองจะปรากฏที่นี่"
        />
      )}

      {!loading && !error && cases.length > 0 && (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-2xl border border-peach bg-white shadow-sm md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-peach bg-cream-deep text-left text-xs font-semibold text-ink-soft">
                  <th className="px-4 py-3">ลูกค้า / สัญญา</th>
                  <th className="px-4 py-3 text-center">ค้าง (วัน)</th>
                  <th className="px-4 py-3">โน้ตล่าสุด</th>
                  <th className="px-4 py-3">นัดจ่าย / คืนเครื่อง</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.contractId} className="border-b border-peach last:border-0 hover:bg-peach-light/20">
                    {/* ลูกค้า */}
                    <td className="px-4 py-3 align-top">
                      <p className="font-medium text-ink">{c.customerName}</p>
                      <p className="text-xs text-ink-soft">{c.contractNo} · {c.shopName}</p>
                      {c.phone && <p className="text-xs text-ink-soft">{c.phone}</p>}
                      <SourceChips sources={c.sources} />
                    </td>
                    {/* ค้าง */}
                    <td className="px-4 py-3 text-center align-top">
                      <Badge tone={c.daysLate > 60 ? 'red' : c.daysLate > 30 ? 'amber' : 'neutral'}>
                        {c.daysLate} วัน
                      </Badge>
                    </td>
                    {/* โน้ต */}
                    <td className="px-4 py-3 align-top">
                      {c.latestNote ? (
                        <>
                          <p className="text-ink">{c.latestNote}</p>
                          <p className="text-xs text-ink-soft">
                            {c.latestNoteByName}{c.latestNoteAt ? ` · ${thaiDateTime(c.latestNoteAt)}` : ''}
                          </p>
                        </>
                      ) : (
                        <span className="text-ink-soft">—</span>
                      )}
                    </td>
                    {/* นัดจ่าย / คืนเครื่อง */}
                    <td className="px-4 py-3 align-top">
                      <div className="flex flex-col items-start gap-1">
                        <PromiseBadge promiseToPayDate={c.promiseToPayDate} />
                        <DeviceReturnBadge c={c} />
                        {!c.promiseToPayDate && !c.hasDeviceReturn && (
                          <span className="text-ink-soft">—</span>
                        )}
                      </div>
                    </td>
                    {/* ปุ่ม */}
                    <td className="px-4 py-3 align-top">
                      <div className="flex flex-col gap-1.5">
                        <Link
                          to={`/contract/${c.contractId}`}
                          className="inline-flex items-center justify-center gap-1 text-xs font-medium text-salmon-deep hover:underline"
                        >
                          <History className="h-3.5 w-3.5" aria-hidden />
                          ดูประวัติ
                        </Link>
                        <Button variant="ghost" onClick={() => setFollowUpTarget(c)}>
                          บันทึกการคุย
                        </Button>
                        {c.pinned && (
                          <Button
                            variant="ghost"
                            disabled={unpinBusy === c.contractId}
                            onClick={() => void handleUnpin(c.contractId)}
                          >
                            {unpinBusy === c.contractId ? 'กำลังเอาออก…' : 'เอาออกจากกล่อง'}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile card stack */}
          <div className="flex flex-col gap-3 md:hidden">
            {cases.map((c) => (
              <Card key={c.contractId}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-ink">{c.customerName}</p>
                    <p className="text-xs text-ink-soft">{c.contractNo} · {c.shopName}</p>
                    {c.phone && <p className="text-xs text-ink-soft">{c.phone}</p>}
                    <SourceChips sources={c.sources} />
                  </div>
                  <Badge tone={c.daysLate > 60 ? 'red' : c.daysLate > 30 ? 'amber' : 'neutral'}>
                    ค้าง {c.daysLate} วัน
                  </Badge>
                </div>

                {c.latestNote && (
                  <div className="mt-2 rounded-lg bg-peach-light/40 px-3 py-2 text-xs">
                    <p className="text-ink">{c.latestNote}</p>
                    <p className="text-ink-soft">{c.latestNoteByName}{c.latestNoteAt ? ` · ${thaiDateTime(c.latestNoteAt)}` : ''}</p>
                  </div>
                )}

                {(c.promiseToPayDate || c.hasDeviceReturn) && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <PromiseBadge promiseToPayDate={c.promiseToPayDate} />
                    <DeviceReturnBadge c={c} />
                  </div>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Link
                    to={`/contract/${c.contractId}`}
                    className="inline-flex items-center gap-1 text-xs font-medium text-salmon-deep hover:underline"
                  >
                    <History className="h-3.5 w-3.5" aria-hidden />
                    ดูประวัติ
                  </Link>
                  <Button variant="ghost" onClick={() => setFollowUpTarget(c)}>
                    บันทึกการคุย
                  </Button>
                  {c.pinned && (
                    <Button
                      variant="ghost"
                      disabled={unpinBusy === c.contractId}
                      onClick={() => void handleUnpin(c.contractId)}
                    >
                      {unpinBusy === c.contractId ? 'กำลังเอาออก…' : 'เอาออกจากกล่อง'}
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </>
      )}

      {/* FollowUpModal */}
      {followUpTarget && (
        <FollowUpModal
          contract={{
            contractId: followUpTarget.contractId,
            contractNo: followUpTarget.contractNo,
            customerName: followUpTarget.customerName,
            phone: followUpTarget.phone,
            shopName: followUpTarget.shopName,
            daysLate: followUpTarget.daysLate,
          }}
          adminOverride={role === 'admin'}
          onClose={() => {
            setFollowUpTarget(null)
            void load()
          }}
        />
      )}
    </div>
  )
}
