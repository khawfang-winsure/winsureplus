import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Badge, Card, Loading, PageTitle } from '../components/ui'
import { baht } from '../lib/format'
import { getContracts, getAllStatuses, getAllShops, getContractAggregates } from '../lib/db'
import {
  buildShopPromoAnalysis,
  DEFAULT_SHOP_PROMO_THRESHOLDS,
  type ShopPromoAnalysis,
  type ShopPromoRow,
  type PromoSegment,
  type PromoGrowthFlag,
} from '../lib/shopAnalysis'

const SEGMENT_BADGE: Record<PromoSegment, { tone: 'green' | 'amber' | 'red' | 'neutral'; label: string }> = {
  แนะนำโปรดาวน์ต่ำ: { tone: 'green', label: 'แนะนำโปรดาวน์ต่ำ' },
  เสี่ยง: { tone: 'red', label: 'เสี่ยง' },
  ส่งน้อย: { tone: 'amber', label: 'ส่งน้อย' },
  ข้อมูลน้อย: { tone: 'neutral', label: 'ข้อมูลน้อย' },
  ไม่มีข้อมูล: { tone: 'neutral', label: 'ไม่มีข้อมูล' },
}

const GROWTH_BADGE: Record<PromoGrowthFlag, { tone: 'green' | 'amber' | 'red' | 'neutral'; label: string }> = {
  โต: { tone: 'green', label: 'โต' },
  ทรง: { tone: 'neutral', label: 'ทรง' },
  หด: { tone: 'red', label: 'หด' },
  ข้อมูลน้อย: { tone: 'amber', label: 'ข้อมูลน้อย' },
}

const MONTH_TH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
function monthLabelShort(monthISO: string): string {
  const [, m] = monthISO.split('-').map(Number)
  return MONTH_TH[m - 1]
}

export default function ShopPromoAnalysisPage() {
  const [data, setData] = useState<ShopPromoAnalysis | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [expandedShopId, setExpandedShopId] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setErr(null)
    Promise.all([getContracts(), getAllStatuses(), getAllShops(), getContractAggregates()])
      .then(([contracts, statuses, shops, aggregates]) => {
        if (!active) return
        const todayISO = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)
        const built = buildShopPromoAnalysis({ contracts, statuses, aggregates, shops, todayISO }, DEFAULT_SHOP_PROMO_THRESHOLDS, 6)
        setData(built)
      })
      .catch((e: unknown) => {
        if (active) setErr(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <div className="flex flex-col gap-5">
      <PageTitle sub="วิเคราะห์ร้านค้าเพื่อพิจารณาจัดโปรดาวน์ต่ำ — ดูจากปริมาณเคส คุณภาพหนี้ และการทิ้งงวดแรก">
        วิเคราะห์ร้านเพื่อจัดโปรดาวน์ต่ำ
      </PageTitle>

      {loading || !data ? (
        <Loading />
      ) : err ? (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{err}</p>
      ) : data.rows.length === 0 ? (
        <Card>
          <p className="text-center text-sm text-ink-soft">ยังไม่มีร้านที่มีสัญญา</p>
        </Card>
      ) : (
        <>
          <ThresholdNote data={data} />
          <SummaryCards data={data} />
          <ShopTable data={data} expandedShopId={expandedShopId} onToggle={setExpandedShopId} />
        </>
      )}
    </div>
  )
}

// ===== เกณฑ์ปัจจุบัน =====
function ThresholdNote({ data }: { data: ShopPromoAnalysis }) {
  const { thresholds } = data
  return (
    <Card className="bg-peach-light/40">
      <p className="text-xs text-ink-soft">
        เกณฑ์ที่ใช้ตอนนี้: ส่งอย่างน้อย <strong className="text-ink">{thresholds.minCases} เคส</strong> ใน {data.trendMonths} เดือนล่าสุด · หนี้เสีย 60 วันขึ้นไป
        ไม่เกิน <strong className="text-ink">{thresholds.maxNplRate}%</strong> (คิดตามมูลค่า) · ทิ้งงวดแรก (ยังถือเครื่อง) ไม่เกิน{' '}
        <strong className="text-ink">{thresholds.maxFirstDefaultRate}%</strong>
      </p>
    </Card>
  )
}

// ===== การ์ดสรุป segment =====
function SummaryCards({ data }: { data: ShopPromoAnalysis }) {
  const { summary } = data
  const cards: { label: string; value: number; tone: string }[] = [
    { label: 'แนะนำโปรดาวน์ต่ำ', value: summary.recommendedCount, tone: 'text-green-600' },
    { label: 'เสี่ยง', value: summary.riskyCount, tone: 'text-red-600' },
    { label: 'ส่งน้อย', value: summary.lowVolumeCount, tone: 'text-amber-600' },
    { label: 'ข้อมูลน้อย/ไม่มีข้อมูล', value: summary.lowDataCount, tone: 'text-ink-soft' },
  ]
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.label}>
          <p className="mb-1 text-xs text-ink-soft">{c.label}</p>
          <p className={`text-2xl font-bold ${c.tone}`}>{c.value} ร้าน</p>
        </Card>
      ))}
    </div>
  )
}

// ===== ตารางร้าน =====
function ShopTable({
  data,
  expandedShopId,
  onToggle,
}: {
  data: ShopPromoAnalysis
  expandedShopId: string | null
  onToggle: (id: string | null) => void
}) {
  return (
    <Card>
      <h3 className="mb-3 font-semibold text-ink">ร้านเรียงตามคะแนนความเหมาะสม</h3>
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-peach text-left text-ink-soft">
              <th className="py-2 font-semibold">ร้าน</th>
              <th className="py-2 text-right font-semibold">เคส ({data.trendMonths} ด.)</th>
              <th className="py-2 text-right font-semibold">หนี้เสีย 60+</th>
              <th className="py-2 text-right font-semibold">มูลค่าพอร์ต</th>
              <th className="py-2 text-right font-semibold">แนวโน้ม</th>
              <th className="py-2 text-right font-semibold">ทิ้งงวดแรก</th>
              <th className="py-2 text-right font-semibold">คะแนน</th>
              <th className="py-2 text-right font-semibold">สรุป</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => {
              const expanded = expandedShopId === row.shopId
              return (
                <ShopRowGroup key={row.shopId} row={row} expanded={expanded} onToggle={onToggle} />
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function ShopRowGroup({
  row,
  expanded,
  onToggle,
}: {
  row: ShopPromoRow
  expanded: boolean
  onToggle: (id: string | null) => void
}) {
  const segBadge = SEGMENT_BADGE[row.segment]
  const growthBadge = GROWTH_BADGE[row.growthFlag]
  return (
    <>
      <tr
        className="cursor-pointer border-b border-peach/50 hover:bg-peach-light/30"
        onClick={() => onToggle(expanded ? null : row.shopId)}
      >
        <td className="py-1.5">
          <div className="flex items-center gap-1.5">
            {expanded ? <ChevronUp size={14} className="text-ink-soft" /> : <ChevronDown size={14} className="text-ink-soft" />}
            <span className="text-ink">{row.shopName}</span>
          </div>
        </td>
        <td className="py-1.5 text-right text-ink">{row.trendCasesTotal}</td>
        <td className="py-1.5 text-right text-ink-soft">
          {row.npl60ValueRate.toFixed(1)}% <span className="text-xs">({row.npl60Count} ราย)</span>
        </td>
        <td className="py-1.5 text-right text-ink-soft">฿{baht(row.totalOutstanding)}</td>
        <td className="py-1.5 text-right">
          <Badge tone={growthBadge.tone}>{growthBadge.label}</Badge>
        </td>
        <td className="py-1.5 text-right text-ink-soft">{row.firstDefaultHoldingRate.toFixed(1)}%</td>
        <td className="py-1.5 text-right font-semibold text-ink">{row.promoScore}</td>
        <td className="py-1.5 text-right">
          <Badge tone={segBadge.tone}>{segBadge.label}</Badge>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-peach/50">
          <td colSpan={8} className="bg-peach-light/20 px-3 py-3">
            <ShopDetailPanel row={row} />
          </td>
        </tr>
      )}
    </>
  )
}

function ShopDetailPanel({ row }: { row: ShopPromoRow }) {
  const maxCount = Math.max(1, ...row.trend.map((p) => p.count))
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div>
        <p className="mb-2 text-xs font-semibold text-ink-soft">รุ่นที่ส่งเยอะสุด</p>
        {row.topModels.length === 0 ? (
          <p className="text-xs text-ink-soft">— ไม่มีข้อมูล</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {row.topModels.map((m) => (
              <li key={m.model} className="flex items-center justify-between text-xs">
                <span className="text-ink">{m.model}</span>
                <span className="text-ink-soft">
                  {m.count} เครื่อง ({m.pctOfShop.toFixed(0)}%)
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="mb-2 text-xs font-semibold text-ink-soft">แนวโน้มรายเดือน</p>
        <div className="flex items-end gap-2">
          {row.trend.map((p) => (
            <div key={p.monthISO} className="flex flex-1 flex-col items-center gap-1">
              <div
                className="w-full rounded-t bg-salmon-deep/60"
                style={{ height: `${Math.max(4, (p.count / maxCount) * 48)}px` }}
                title={`${p.count} เคส`}
              />
              <span className="text-[10px] text-ink-soft">{monthLabelShort(p.monthISO)}</span>
              <span className="text-[10px] text-ink">{p.count}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
