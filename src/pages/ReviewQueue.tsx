import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Image as ImageIcon } from 'lucide-react'
import { Badge, EmptyState, Loading, PageTitle, Select } from '../components/ui'
import { getAllShops, getMediaGateFrom, getReviewLog, getReviewQueue, getSummaryReviewSnapshot } from '../lib/db'
import { useAuth } from '../lib/auth'
import {
  buildTonightSummary,
  reviewAgeDays,
  reviewAgeLabel,
  reviewStatusLabel,
  reviewStatusTone,
  REVIEW_BADGE_NEEDS_FIX,
  REVIEW_BADGE_PENDING,
  type ReviewTone,
  type TonightSummary,
  type TonightSummaryRow,
} from '../lib/review'
import { useAsync } from '../lib/useAsync'
import { sameOperator } from '../components/nav'
import type { ReviewQueueItem } from '../lib/types'

// spec-review-flow.md §5 — เพจเดียว "/review-queue" 2 หน้าตาตาม role (ไม่ใช่ 2 route):
//  - admin  ("ตรวจเคสก่อนส่งบริษัท"): เห็นทั้งคิว pending_review + needs_fix ทุกเคส — พฤติกรรมเดิมทั้งหมด
//  - staff  ("งานที่ต้องแก้"): เห็นเฉพาะ needs_fix ที่ operator === ตัวเอง (เคสของฉันเท่านั้น — ห้าม leak
//    เคสรอตรวจ/เคสของคนอื่น) พร้อมเหตุผลที่แอดมินตีกลับล่าสุด (จาก contract_review_log ผ่าน getReviewLog)
//    กดแถวแล้วไปหน้า /contract/:id ที่การ์ดแก้ไข/ส่งตรวจใหม่มีอยู่แล้ว

type SortKey = 'age' | 'contractNo'
type SortDir = 'asc' | 'desc'

const SORT_OPTS: { value: `${SortKey}_${SortDir}`; label: string }[] = [
  { value: 'age_asc', label: 'รอมานาน (นานสุดก่อน)' },
  { value: 'age_desc', label: 'รอมานาน (ล่าสุดก่อน)' },
  { value: 'contractNo_asc', label: 'เลขที่สัญญา (ก→ฮ)' },
  { value: 'contractNo_desc', label: 'เลขที่สัญญา (ฮ→ก)' },
]

/** ReviewTone (wait/fix/ok/mute) → Badge tone ที่มีอยู่จริงใน ui.tsx (ห้าม salmon) */
function badgeToneOf(t: ReviewTone): 'green' | 'amber' | 'red' | 'neutral' {
  if (t === 'wait') return 'amber'
  if (t === 'fix') return 'red'
  if (t === 'ok') return 'green'
  return 'neutral'
}

function sortItems(list: ReviewQueueItem[], key: SortKey, dir: SortDir): ReviewQueueItem[] {
  return [...list].sort((a, b) => {
    let cmp = 0
    if (key === 'contractNo') {
      cmp = a.contractNo.localeCompare(b.contractNo, 'th', { numeric: true })
    } else {
      const av = a.reviewUpdatedAt ?? ''
      const bv = b.reviewUpdatedAt ?? ''
      cmp = av < bv ? -1 : av > bv ? 1 : 0
    }
    return dir === 'asc' ? cmp : -cmp
  })
}

const EMPTY_TONIGHT_SUMMARY: TonightSummary = {
  shops: [],
  totals: { total: 0, waitingReview: 0, needsFix: 0, notSubmitted: 0, ready: 0 },
}

/** loader เปล่า — ใช้แทน loadTonightSummary ตอนไม่ใช่ admin กันพนักงานที่เปิด "งานที่ต้องแก้"
 *  ยิง query ตรวจงานทั้งร้าน (getSummaryReviewSnapshot/getAllShops/getMediaGateFrom) ทิ้งเปล่าโดยไม่มีอะไรเรนเดอร์
 *  (ติ๊กชี้ 2026-09-12) — เลือกวิธีนี้เพราะ useAsync ไม่มี option "enabled" (ดู src/lib/useAsync.ts) และแอป
 *  gate ทั้งต้นทาง App.tsx ด้วย `if (!ready) return <Loading/>` ก่อน route จะ mount แล้ว → isAdmin ตอน
 *  ReviewQueue mount ครั้งแรกเป็นค่าจริงเสมอ (ไม่ใช่ null ชั่วคราวที่ยังไม่ resolve) จึงเลือก fn ตัวไหนตอน
 *  mount ได้ถูกต้องโดยไม่ต้องย้าย hook ไปหลัง early-return ของ isAdmin ด้านล่าง */
async function loadNothingTonightSummary(): Promise<TonightSummary> {
  return EMPTY_TONIGHT_SUMMARY
}

/** งานค้างตรวจ ณ ตอนนี้ แยกตามร้าน (แถบ admin เห็นก่อนทีมกดสรุปยอด) — คุณเตยขอเห็นเอง ไม่ต้องรอทีมแจ้งปากเปล่า
 *  🔑 ตัวกรองต้องตรงกับคอลัมน์ซ้าย "รอส่งร้าน" ของ /waiting-summary เป๊ะ — ที่นั่น shopBase filter มีแค่ 1 เงื่อนไข
 *  ที่ผูกกับ DB จริง (summary_shop_sent_at is null) ส่วนอีก 2 เงื่อนไข (locallyShopSent/locallyAccountingSent) เป็น
 *  session state ชั่วคราวเฉพาะหน้านั้น ไม่มีคู่เทียบฝั่ง DB — getSummaryReviewSnapshot() ที่น้องชีสทำมาก็กรอง
 *  summary_shop_sent_at is null เป๊ะๆเงื่อนไขเดียวกัน จึงไม่ต้องกรองเพิ่มฝั่ง client อีก (ไม่มี status
 *  ปิดสัญญา/คืนเครื่อง/ยกเลิกให้กรองซ้ำ เพราะ shopBase เองก็ไม่กรองสถานะพวกนี้เหมือนกัน) */
async function loadTonightSummary(): Promise<TonightSummary> {
  const [gateFrom, rows, shops] = await Promise.all([
    getMediaGateFrom(),
    getSummaryReviewSnapshot(),
    getAllShops(),
  ])
  const shopCodeById = new Map(shops.map((s) => [s.id, s.code]))
  const rowsForSummary: TonightSummaryRow[] = rows.map((r) => ({
    shopId: r.shopId,
    shopCode: shopCodeById.get(r.shopId) ?? r.shopId,
    createdAt: r.createdAt,
    reviewStatus: r.reviewStatus,
  }))
  return buildTonightSummary(rowsForSummary, gateFrom)
}

/** แถบสรุปงานค้างตรวจคืนนี้ แยกตามร้าน — คลิกร้านไปหน้ารอสรุปยอด (ไม่กรองตามร้านให้ เพราะหน้านั้นไม่รับพารามิเตอร์ร้านจาก URL) */
function TonightReviewSummary({ summary }: { summary: TonightSummary }) {
  if (summary.totals.total === 0) {
    return (
      <div className="mb-5 rounded-2xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
        ไม่มีงานค้างตรวจตอนนี้ — ทีมสรุปยอดได้เลยค่ะ
      </div>
    )
  }

  return (
    <div className="mb-5 flex flex-col gap-3 rounded-2xl border border-peach bg-white px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">งานค้างตรวจตอนนี้ แยกตามร้าน</h2>
        <span className="text-sm text-ink-soft">รวมทุกร้าน {summary.totals.total} เคส</span>
      </div>

      <ul className="flex flex-col gap-2">
        {summary.shops.map((s) => (
          <li key={s.shopId}>
            <Link
              to="/waiting-summary"
              className="flex flex-col gap-1.5 rounded-xl border border-peach bg-cream-deep/40 px-4 py-3 transition hover:border-salmon-deep sm:flex-row sm:items-center sm:justify-between"
            >
              <span className="font-medium text-ink">{s.shopCode}</span>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span className="text-ink-soft">ค้างทั้งหมด {s.total} เคส</span>
                <span className={s.waitingReview > 0 ? 'font-bold text-amber-700' : 'text-ink-soft'}>
                  รอคุณเตยตรวจ {s.waitingReview}
                </span>
                <span className={s.needsFix > 0 ? 'text-red-700' : 'text-ink-soft'}>ต้องแก้ไข {s.needsFix}</span>
                <span className="text-ink-soft">ยังไม่ส่งตรวจ {s.notSubmitted}</span>
                <span className={s.ready > 0 ? 'text-green-700' : 'text-ink-soft'}>พร้อมสรุป {s.ready}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function ReviewQueue() {
  const { data: items, loading, error } = useAsync(getReviewQueue, [] as ReviewQueueItem[])
  const { role, name: myName, configured } = useAuth()
  const isAdmin = !configured || role === 'admin'

  // แถบ "งานค้างตรวจ แยกตามร้าน" — useAsync ตัวที่ 2 แยกจากคิวหลัก กันแถบช้าไปฉุดคิวตรวจไม่ให้ขึ้น
  // เฉพาะ admin ถึงยิง query จริง (loadTonightSummary) — staff ที่เข้าหน้า "งานที่ต้องแก้" ได้ loader เปล่า
  // ไม่ยิง getSummaryReviewSnapshot/getAllShops/getMediaGateFrom เลย เพราะไม่มีอะไรเรนเดอร์ในมุมมองนั้น
  const {
    data: tonight,
    loading: tonightLoading,
    error: tonightError,
  } = useAsync(isAdmin ? loadTonightSummary : loadNothingTonightSummary, EMPTY_TONIGHT_SUMMARY)

  const [sortOpt, setSortOpt] = useState<`${SortKey}_${SortDir}`>('age_asc')
  const [shopFilter, setShopFilter] = useState('')

  const nowISO = useMemo(() => new Date().toISOString(), [])

  const pendingCount = useMemo(() => items.filter((i) => i.reviewStatus === 'pending_review').length, [items])
  const fixCount = useMemo(() => items.filter((i) => i.reviewStatus === 'needs_fix').length, [items])

  const shopOptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const i of items) {
      if (!map.has(i.shopId)) map.set(i.shopId, i.shopCode || i.shopId)
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'th'))
  }, [items])

  const filtered = useMemo(() => {
    const [key, dir] = sortOpt.split('_') as [SortKey, SortDir]
    const rows = shopFilter ? items.filter((i) => i.shopId === shopFilter) : items
    return sortItems(rows, key, dir)
  }, [items, sortOpt, shopFilter])

  // ── staff: "งานที่ต้องแก้" — เฉพาะ needs_fix ของตัวเอง (operator เทียบแบบ trim+lowercase ผ่าน
  // sameOperator กัน noise ปกติของช่องกรอกมือ — ⚠️ ถ้าแอดมินเปลี่ยนชื่อผู้ใช้ใน /settings/users
  // เคสเก่าที่เก็บชื่อเดิมจะไม่ match อีก แอดมินยังเห็นทุกเคสในคิวเดียวกันเสมออยู่แล้ว) ──────────
  const staffItems = useMemo(
    () => sortItems(items.filter((i) => i.reviewStatus === 'needs_fix' && sameOperator(i.operator, myName)), 'age', 'asc'),
    [items, myName],
  )

  // เหตุผลตีกลับล่าสุดต่อเคส (contract_review_log แถวล่าสุด — ครอบทั้งตีกลับจาก reject และ cancel_approval)
  const [reasons, setReasons] = useState<Record<string, string | null>>({})
  useEffect(() => {
    if (isAdmin || staffItems.length === 0) return
    let cancelled = false
    Promise.all(
      staffItems.map((i) =>
        getReviewLog(i.contractId)
          .then((log) => log[0]?.reason ?? null)
          .catch(() => null),
      ),
    ).then((list) => {
      if (cancelled) return
      const map: Record<string, string | null> = {}
      staffItems.forEach((i, idx) => {
        map[i.contractId] = list[idx]
      })
      setReasons(map)
    })
    return () => {
      cancelled = true
    }
  }, [isAdmin, staffItems])

  // ================= staff view =================
  if (!isAdmin) {
    return (
      <div>
        <PageTitle sub={`${REVIEW_BADGE_NEEDS_FIX} ${staffItems.length}`}>งานที่ต้องแก้</PageTitle>

        {loading ? (
          <Loading />
        ) : error ? (
          <EmptyState title="โหลดงานที่ต้องแก้ไม่สำเร็จ" hint={error} />
        ) : staffItems.length === 0 ? (
          <EmptyState title="ไม่มีงานที่ต้องแก้" hint="เคสที่แอดมินตีกลับให้แก้ไขจะขึ้นที่นี่" />
        ) : (
          <ul className="flex flex-col gap-2">
            {staffItems.map((item) => {
              const age = item.reviewUpdatedAt
                ? reviewAgeLabel(reviewAgeDays(item.reviewUpdatedAt, nowISO))
                : '-'
              const reason = reasons[item.contractId]
              return (
                <li key={item.contractId}>
                  <Link
                    to={`/contract/${item.contractId}`}
                    className="flex flex-col gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 transition hover:border-salmon-deep"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-medium text-ink">
                          {item.contractNo} <span className="text-ink-soft">— {item.customerName}</span>
                        </p>
                        <p className="text-sm text-ink">{item.shopCode || '-'}</p>
                      </div>
                      <Badge tone="red">{age}</Badge>
                    </div>
                    {reason && (
                      <p className="rounded-lg border border-dashed border-red-300 bg-white px-3 py-2 text-sm text-ink">
                        <span className="font-medium">เหตุผลที่ต้องแก้ไข: </span>
                        {reason}
                      </p>
                    )}
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    )
  }

  // ================= admin view (คิวตรวจเดิม ไม่เปลี่ยน + เพิ่มแถบงานค้างตรวจแยกตามร้าน) =================
  return (
    <div>
      <PageTitle sub={`${REVIEW_BADGE_PENDING} ${pendingCount} · ${REVIEW_BADGE_NEEDS_FIX} ${fixCount}`}>
        ตรวจเคสก่อนส่งบริษัท
      </PageTitle>

      {/* แถบงานค้างตรวจแยกตามร้าน — โหลดแยกจากคิวหลัก error/loading ไม่บล็อกคิวตรวจด้านล่าง
          ซ่อนทั้งแถบตอนกำลังโหลด/โหลดพลาด/โหมด mock (ไม่มี Supabase) กันหน้าพัง */}
      {configured && !tonightLoading && !tonightError && <TonightReviewSummary summary={tonight} />}

      {loading ? (
        <Loading />
      ) : error ? (
        <EmptyState title="โหลดคิวตรวจไม่สำเร็จ" hint={error} />
      ) : items.length === 0 ? (
        <EmptyState title="ไม่มีเคสรอตรวจ" hint="เคสที่พนักงานส่งตรวจจะขึ้นที่นี่" />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <Select
              value={sortOpt}
              onChange={(e) => setSortOpt(e.target.value as `${SortKey}_${SortDir}`)}
              className="w-auto text-sm"
              aria-label="เรียงลำดับ"
            >
              {SORT_OPTS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
            <Select
              value={shopFilter}
              onChange={(e) => setShopFilter(e.target.value)}
              className="!w-auto min-w-[140px] text-sm"
              aria-label="กรองตามร้าน"
            >
              <option value="">ทุกร้าน</option>
              {shopOptions.map(([id, code]) => (
                <option key={id} value={id}>{code}</option>
              ))}
            </Select>
          </div>

          {filtered.length === 0 ? (
            <EmptyState title="ไม่มีเคสตรงตัวกรอง" hint="ลองเปลี่ยนร้าน" />
          ) : (
            <ul className="flex flex-col gap-2">
              {filtered.map((item) => {
                const age = item.reviewUpdatedAt ? reviewAgeLabel(reviewAgeDays(item.reviewUpdatedAt, nowISO)) : '-'
                const needsFix = item.reviewStatus === 'needs_fix'
                return (
                  <li key={item.contractId}>
                    <Link
                      to={`/contract/${item.contractId}`}
                      className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-4 py-3 transition hover:border-salmon-deep ${
                        needsFix ? 'border-red-200 bg-red-50' : 'border-peach bg-white'
                      }`}
                    >
                      <div>
                        <p className="font-medium text-ink">
                          {item.contractNo} <span className="text-ink-soft">— {item.customerName}</span>
                        </p>
                        <p className="text-sm text-ink">{item.shopCode || '-'}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge tone="neutral">
                          <span className="inline-flex items-center gap-1">
                            <ImageIcon size={12} /> {`${item.mediaTotalFiles} ใบ`}
                          </span>
                        </Badge>
                        <span className="text-sm text-ink-soft">{age}</span>
                        <Badge tone={badgeToneOf(reviewStatusTone(item.reviewStatus))}>
                          {reviewStatusLabel(item.reviewStatus)}
                        </Badge>
                      </div>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
