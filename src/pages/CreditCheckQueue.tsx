import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bell, Search, X } from 'lucide-react'
import { Badge, EmptyState, Input, Loading, PageTitle } from '../components/ui'
import CreditCheckDetailModal, { ENGINE_LEVEL_LABEL } from '../components/CreditCheckDetailModal'
import { getCreditCheckQueue } from '../lib/db'
import type { CreditCheckQueueItem } from '../lib/types'

type FilterKey = 'pending' | 'decided' | 'all'

const FILTER_TABS: { key: FilterKey; label: string }[] = [
  { key: 'pending', label: 'รอตรวจ' },
  { key: 'decided', label: 'ตัดสินแล้ว' },
  { key: 'all', label: 'ทั้งหมด' },
]

const POLL_MS = 30_000

// ===== เสียงเตือนคำขอใหม่ — บี๊บสั้นด้วย WebAudio ตรงๆ ไม่ใช้ไฟล์เสียง (asset) =====
function playBeep(): void {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.4)
    osc.onended = () => void ctx.close()
  } catch {
    // เบราว์เซอร์ไม่รองรับ WebAudio หรือ autoplay ถูกบล็อก — ไม่ต้องบล็อกอะไรต่อ
  }
}

function notifyNewRequest(count: number): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  try {
    new Notification('มีคำขอเช็คเครดิตใหม่', { body: `ตอนนี้มีคำขอรอตรวจ ${count} รายการ`, tag: 'credit-check-queue' })
  } catch {
    // บาง context (เช่น origin ไม่ใช่ secure) อาจ throw — ไม่ต้องบล็อกอะไรต่อ
  }
}

/** เวลาที่รอ (นาที) เทียบเป้า 3 นาที — เขียว <3 / อำพัน 3-10 / แดง >10 */
function waitTone(minutes: number): 'green' | 'amber' | 'red' {
  if (minutes < 3) return 'green'
  if (minutes <= 10) return 'amber'
  return 'red'
}

function minutesLabel(minutes: number): string {
  if (minutes < 1) return '<1 นาที'
  if (minutes < 60) return `${Math.round(minutes)} นาที`
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return `${h} ชม. ${m} นาที`
}

export default function CreditCheckQueue() {
  const [items, setItems] = useState<CreditCheckQueueItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterKey>('pending')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  )
  const prevPendingRef = useRef<number | null>(null)

  const load = useCallback(async (silent?: boolean) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const rows = await getCreditCheckQueue()
      setItems(rows)
      const pendingCount = rows.filter((r) => r.decision === null).length
      if (prevPendingRef.current !== null && pendingCount > prevPendingRef.current) {
        playBeep()
        notifyNewRequest(pendingCount)
      }
      prevPendingRef.current = pendingCount
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const interval = setInterval(() => void load(true), POLL_MS)
    return () => clearInterval(interval)
  }, [load])

  async function requestNotifPermission() {
    if (typeof Notification === 'undefined') return
    const perm = await Notification.requestPermission()
    setNotifPermission(perm)
  }

  const filtered = useMemo(() => {
    let rows = items
    if (filter === 'pending') rows = rows.filter((r) => r.decision === null)
    else if (filter === 'decided') rows = rows.filter((r) => r.decision !== null)
    const q = query.trim().toLowerCase()
    if (q) {
      rows = rows.filter((r) =>
        [r.shopName, r.customerName, r.nationalIdMasked].join(' ').toLowerCase().includes(q),
      )
    }
    return rows
  }, [items, filter, query])

  const pendingCount = useMemo(() => items.filter((r) => r.decision === null).length, [items])
  const decidedCount = items.length - pendingCount

  return (
    <div>
      <PageTitle sub="คำขอเช็คเครดิตที่ร้านส่งมาผ่านฟอร์มสาธารณะ — เป้าตอบสนองครั้งแรก 3 นาที" count={loading ? undefined : { shown: filtered.length, total: items.length }}>
        คำขอเช็คเครดิต
      </PageTitle>

      {notifPermission === 'default' && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-peach bg-peach-light/40 px-4 py-2.5 text-sm">
          <span className="flex items-center gap-2 text-ink">
            <Bell className="h-4 w-4" />
            เปิดแจ้งเตือนคำขอใหม่บนเบราว์เซอร์นี้ไหมคะ
          </span>
          <button
            type="button"
            onClick={() => void requestNotifPermission()}
            className="rounded-lg bg-salmon-deep px-3 py-1.5 text-xs font-semibold text-white hover:brightness-105"
          >
            เปิดแจ้งเตือน
          </button>
        </div>
      )}

      {loading && <Loading />}

      {!loading && error && <EmptyState title="โหลดคิวไม่สำเร็จ" hint={error} />}

      {!loading && !error && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="flex gap-1.5 rounded-xl border border-peach bg-white p-1">
              {FILTER_TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setFilter(t.key)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    filter === t.key ? 'bg-salmon-deep text-white' : 'text-ink-soft hover:bg-peach-light'
                  }`}
                >
                  {t.label}
                  {t.key === 'pending' && pendingCount > 0 && ` (${pendingCount})`}
                  {t.key === 'decided' && decidedCount > 0 && ` (${decidedCount})`}
                </button>
              ))}
            </div>

            <div className="relative max-w-xs flex-1">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft" aria-hidden />
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ค้นหาร้าน / ชื่อลูกค้า / เลขบัตร"
                aria-label="ค้นหาคำขอเช็คเครดิต"
                className="pl-9 pr-9"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="ล้างคำค้นหา"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-ink-soft hover:bg-peach-light hover:text-ink"
                >
                  <X size={16} aria-hidden />
                </button>
              )}
            </div>
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              title={filter === 'pending' ? 'ไม่มีคำขอรอตรวจ' : 'ไม่พบรายการ'}
              hint="คำขอที่ร้านส่งผ่านฟอร์มเช็คเครดิตจะขึ้นที่นี่"
            />
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden overflow-x-auto rounded-2xl border border-peach bg-white shadow-sm md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-peach bg-cream-deep text-left text-xs font-semibold text-ink-soft">
                      <th className="px-4 py-3">ร้าน / ลูกค้า</th>
                      <th className="px-4 py-3">ผลเบื้องต้น</th>
                      <th className="px-4 py-3">เวลารอ</th>
                      <th className="px-4 py-3">สถานะ</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((item) => (
                      <tr
                        key={item.id}
                        onClick={() => setSelectedId(item.id)}
                        className="cursor-pointer border-b border-peach last:border-0 hover:bg-peach-light/20"
                      >
                        <td className="px-4 py-3 align-top">
                          <p className="font-medium text-ink">{item.customerName}</p>
                          <p className="text-xs text-ink-soft">{item.shopName} · บัตร {item.nationalIdMasked}</p>
                        </td>
                        <td className="px-4 py-3 align-top">
                          {item.engineLevel ? (
                            <Badge tone={ENGINE_LEVEL_LABEL[item.engineLevel].tone}>{ENGINE_LEVEL_LABEL[item.engineLevel].text}</Badge>
                          ) : (
                            <Badge tone="neutral">ไม่ทราบผล</Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 align-top">
                          {item.decision === null ? (
                            <Badge tone={waitTone(item.minutesToFirstOpen)}>{minutesLabel(item.minutesToFirstOpen)}</Badge>
                          ) : (
                            <span className="text-xs text-ink-soft">ตอบใน {minutesLabel(item.minutesToFirstOpen)}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 align-top">
                          {item.decision === null ? (
                            <Badge tone="neutral">รอตรวจ</Badge>
                          ) : (
                            <Badge tone={item.decision === 'approved' ? 'green' : item.decision === 'rejected' ? 'red' : 'amber'}>
                              {item.decision === 'approved' ? 'ผ่าน' : item.decision === 'rejected' ? 'ไม่ผ่าน' : 'ขอเอกสารเพิ่ม'}
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 align-top text-xs font-medium text-salmon-deep">ดูรายละเอียด</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile card stack */}
              <div className="flex flex-col gap-3 md:hidden">
                {filtered.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedId(item.id)}
                    className="rounded-2xl border border-peach bg-white p-4 text-left shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-semibold text-ink">{item.customerName}</p>
                        <p className="text-xs text-ink-soft">{item.shopName} · บัตร {item.nationalIdMasked}</p>
                      </div>
                      {item.decision === null ? (
                        <Badge tone={waitTone(item.minutesToFirstOpen)}>{minutesLabel(item.minutesToFirstOpen)}</Badge>
                      ) : (
                        <Badge tone={item.decision === 'approved' ? 'green' : item.decision === 'rejected' ? 'red' : 'amber'}>
                          {item.decision === 'approved' ? 'ผ่าน' : item.decision === 'rejected' ? 'ไม่ผ่าน' : 'ขอเอกสารเพิ่ม'}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-2">
                      {item.engineLevel ? (
                        <Badge tone={ENGINE_LEVEL_LABEL[item.engineLevel].tone}>{ENGINE_LEVEL_LABEL[item.engineLevel].text}</Badge>
                      ) : (
                        <Badge tone="neutral">ไม่ทราบผล</Badge>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {selectedId && (
        <CreditCheckDetailModal
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={() => void load(true)}
        />
      )}
    </div>
  )
}
