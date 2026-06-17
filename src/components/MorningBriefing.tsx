import { useState } from 'react'
import type { ReactNode } from 'react'
import { Card, Badge, Modal } from './ui'
import { baht } from '../lib/format'
import type { Briefing, BriefingAlert } from '../lib/execDashboard'

interface MorningBriefingProps {
  data: Briefing
  npl: number
  newCases: number
  collectedThisMonth: number
  expectedThisMonth: number
  isExec?: boolean
}

function alertText(a: BriefingAlert, isExec: boolean): string {
  switch (a.type) {
    case 'npl_high':
      return 'หนี้เสียเกิน 20% ของพอร์ต — ต้องดูเร่งด่วน'
    case 'early_default':
      return `ลูกค้าไม่จ่ายงวดแรก ${a.count} ราย เดือนนี้`
    case 'high_risky_shop': {
      const shopLabel = isExec ? `ร้าน ${String.fromCharCode(65 + a.shopIndex)}` : `ร้าน ${a.shopName}`
      return `${shopLabel} หนี้เสียสูง (${a.riskyRate}%) — ควรหยุดรับเคสชั่วคราว`
    }
  }
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `฿${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 10_000) return `฿${(n / 1_000).toFixed(0)}K`
  return `฿${baht(n)}`
}

function KpiCell({
  label,
  value,
  sub,
  tone = 'text-ink',
  onClick,
}: {
  label: string
  value: string
  sub?: ReactNode
  tone?: string
  onClick?: () => void
}) {
  const cls = 'rounded-2xl border border-peach bg-white p-4 text-left'
  const inner = (
    <>
      <p className="text-xs text-ink-soft">{label}</p>
      <p className={`mt-0.5 text-2xl font-bold ${tone}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-soft">{sub}</p>}
    </>
  )
  if (onClick) {
    return (
      <button
        onClick={onClick}
        className={`${cls} transition hover:bg-peach-light/70 hover:border-salmon`}
      >
        {inner}
      </button>
    )
  }
  return <div className={cls}>{inner}</div>
}

export default function MorningBriefing({
  data,
  npl,
  newCases,
  collectedThisMonth,
  expectedThisMonth,
  isExec = false,
}: MorningBriefingProps) {
  const [showComModal, setShowComModal] = useState(false)

  const { commissionLiabilityThisMonth, nplDeltaPct, alerts } = data

  // NPL delta display
  let nplDeltaText = '—'
  let nplDeltaTone = 'text-ink-soft'
  if (nplDeltaPct > 0) {
    nplDeltaText = `▲ +${nplDeltaPct.toFixed(1)}%`
    nplDeltaTone = 'text-red-600'
  } else if (nplDeltaPct < 0) {
    nplDeltaText = `▼ ${nplDeltaPct.toFixed(1)}%`
    nplDeltaTone = 'text-green-600'
  }

  // Commission top-earner sub text
  const topEarnerDisplayName =
    commissionLiabilityThisMonth.topEarner !== null
      ? (isExec ? 'พนักงาน A' : commissionLiabilityThisMonth.topEarner.name)
      : null
  const comSub =
    topEarnerDisplayName !== null
      ? `top: ${topEarnerDisplayName} ฿${baht(commissionLiabilityThisMonth.topEarner!.amount)}`
      : 'ยังไม่มีค่าคอมเดือนนี้'

  // Commission top5 max for bar width
  const top5Max = Math.max(1, ...commissionLiabilityThisMonth.top5.map((s) => s.amount))

  return (
    <Card>
      <h3 className="mb-4 font-semibold text-ink">Morning Briefing</h3>

      {/* 5 KPI row */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-5">
        <KpiCell
          label="เคสใหม่เดือนนี้"
          value={`${newCases} ราย`}
          tone="text-green-600"
        />
        <KpiCell
          label="เก็บได้เดือนนี้"
          value={fmt(collectedThisMonth)}
          tone="text-green-600"
        />
        <KpiCell
          label="คาดเก็บที่เหลือเดือนนี้"
          value={fmt(expectedThisMonth)}
        />
        <KpiCell
          label="NPL%"
          value={`${npl.toFixed(1)}%`}
          sub={<><span className={nplDeltaTone}>{nplDeltaText}</span>{' '}vs เดือนก่อน</>}
          tone={npl >= 10 ? 'text-red-600' : npl >= 5 ? 'text-amber-600' : 'text-ink'}
        />
        <KpiCell
          label="ค่าคอมต้องจ่ายเดือนนี้"
          value={fmt(commissionLiabilityThisMonth.total)}
          sub={comSub}
          onClick={commissionLiabilityThisMonth.top5.length > 0 ? () => setShowComModal(true) : undefined}
        />
      </div>

      {/* Alert pills */}
      {alerts.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2" role="list" aria-label="สัญญาณเตือน">
          {alerts.map((a, i) => (
            <span key={i} role="listitem">
              <Badge tone={a.level === 'red' ? 'red' : 'amber'}>{alertText(a, isExec)}</Badge>
            </span>
          ))}
        </div>
      )}

      {/* Commission top-5 modal */}
      {showComModal && (
        <Modal title="Top 5 ค่าคอมเดือนนี้" onClose={() => setShowComModal(false)}>
          {commissionLiabilityThisMonth.top5.length === 0 ? (
            <p className="text-sm text-ink-soft">ยังไม่มีข้อมูลค่าคอมเดือนนี้</p>
          ) : (
            <div className="flex flex-col gap-3">
              {commissionLiabilityThisMonth.top5.map((s, i) => (
                <div key={i}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="font-medium text-ink">{isExec ? `พนักงาน ${String.fromCharCode(65 + i)}` : s.name}</span>
                    <span className="text-ink-soft">฿{baht(s.amount)}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-peach-light">
                    <div
                      className="h-full rounded-full bg-salmon-deep"
                      style={{ width: `${(s.amount / top5Max) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
              <p className="mt-2 text-right text-sm font-semibold text-ink">
                รวม ฿{baht(commissionLiabilityThisMonth.total)}
              </p>
            </div>
          )}
        </Modal>
      )}
    </Card>
  )
}
