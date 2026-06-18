import { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Card, EmptyState, Loading, PageTitle } from '../components/ui'
import {
  getInboxCases,
  unpinFromInbox,
  type InboxCase,
} from '../lib/db'
import { useAuth } from '../lib/auth'
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

  const todayStr = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10)

  return (
    <div>
      <PageTitle
        sub="สัญญาที่นัดทาง LINE รอลูกค้า + เคสที่หยิบเข้ามาติดตาม"
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
          hint="เคสที่บันทึกผล 'นัดทาง LINE – รอลูกค้า' หรือเคสที่เพิ่มเข้ากล่องเองจะปรากฏที่นี่"
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
                  <th className="px-4 py-3">นัดจ่าย</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => {
                  const [, pMonth, pDay] = c.promiseToPayDate ? c.promiseToPayDate.split('-') : [null, null, null]
                  const promiseOverdue = c.promiseToPayDate !== null && c.promiseToPayDate < todayStr
                  return (
                    <tr key={c.contractId} className="border-b border-peach last:border-0 hover:bg-peach-light/20">
                      {/* ลูกค้า */}
                      <td className="px-4 py-3">
                        <p className="font-medium text-ink">{c.customerName}</p>
                        <p className="text-xs text-ink-soft">{c.contractNo} · {c.shopName}</p>
                        {c.phone && <p className="text-xs text-ink-soft">{c.phone}</p>}
                        {c.pinned && (
                          <Badge tone="amber">📌 เพิ่มเข้ามาเอง</Badge>
                        )}
                      </td>
                      {/* ค้าง */}
                      <td className="px-4 py-3 text-center">
                        <Badge tone={c.daysLate > 60 ? 'red' : c.daysLate > 30 ? 'amber' : 'neutral'}>
                          {c.daysLate} วัน
                        </Badge>
                      </td>
                      {/* โน้ต */}
                      <td className="px-4 py-3">
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
                      {/* นัดจ่าย */}
                      <td className="px-4 py-3">
                        {pDay && pMonth ? (
                          <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${promiseOverdue ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                            📅 {pDay}/{pMonth}
                            {promiseOverdue && ' (เลยกำหนด)'}
                          </span>
                        ) : (
                          <span className="text-ink-soft">—</span>
                        )}
                      </td>
                      {/* ปุ่ม */}
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1.5">
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
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile card stack */}
          <div className="flex flex-col gap-3 md:hidden">
            {cases.map((c) => {
              const [, pMonth, pDay] = c.promiseToPayDate ? c.promiseToPayDate.split('-') : [null, null, null]
              const promiseOverdue = c.promiseToPayDate !== null && c.promiseToPayDate < todayStr
              return (
                <Card key={c.contractId}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-ink">{c.customerName}</p>
                      <p className="text-xs text-ink-soft">{c.contractNo} · {c.shopName}</p>
                      {c.phone && <p className="text-xs text-ink-soft">{c.phone}</p>}
                      {c.pinned && <Badge tone="amber">📌 เพิ่มเข้ามาเอง</Badge>}
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

                  {pDay && pMonth && (
                    <div className="mt-2">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${promiseOverdue ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                        📅 นัดจ่าย {pDay}/{pMonth}
                        {promiseOverdue && ' (เลยกำหนด)'}
                      </span>
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2">
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
              )
            })}
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
