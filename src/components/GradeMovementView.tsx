import { TrendingDown, TrendingUp } from 'lucide-react'
import { Card } from './ui'
import { LineChart } from './LineChart'
import type { GradeMovementResult, GradeMovementMonth } from '../lib/execDashboard'

function netColor(net: number): string {
  if (net > 0) return 'text-green-600'
  if (net < 0) return 'text-red-600'
  return 'text-ink-soft'
}

function BackfillRow({ month }: { month: GradeMovementMonth }) {
  return (
    <tr className="border-b border-peach/50 last:border-0">
      <td className="py-1.5 text-ink-soft">{month.monthLabel}</td>
      <td className="py-1.5 text-center text-ink-soft" title="จุดเริ่มต้นของระบบ">—</td>
      <td className="py-1.5 text-center text-ink-soft" title="จุดเริ่มต้นของระบบ">—</td>
      <td className="py-1.5 text-center text-ink-soft" title="จุดเริ่มต้นของระบบ">—</td>
    </tr>
  )
}

function MovementRow({ month }: { month: GradeMovementMonth }) {
  return (
    <tr className="border-b border-peach/50 last:border-0">
      <td className="py-1.5 text-ink">{month.monthLabel}</td>
      <td className="py-1.5 text-center text-red-600">{month.roll}</td>
      <td className="py-1.5 text-center text-green-600">{month.cure}</td>
      <td className={`py-1.5 text-center font-semibold ${netColor(month.net)}`}>
        {month.net > 0 ? `+${month.net}` : month.net}
      </td>
    </tr>
  )
}

export default function GradeMovementView({ data }: { data: GradeMovementResult }) {
  const { months, currentMonth, emptyState, backfillMonthLabel } = data

  const hasRealMovement = months.some((m) => !m.isBackfillSpike && (m.roll > 0 || m.cure > 0))

  return (
    <div className="flex flex-col gap-5">
      {/* ===== summary box เดือนนี้ ===== */}
      <Card>
        <h3 className="mb-3 font-semibold text-ink">สรุปเดือนนี้ (การขยับเกรด)</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          {/* roll */}
          <div className="flex items-center gap-3 rounded-xl bg-red-50 px-4 py-3">
            <TrendingDown className="shrink-0 text-red-500" size={20} />
            <div>
              <p className="text-xs text-ink-soft">ตกชั้น (Roll)</p>
              <p className="text-xl font-bold text-red-600">{currentMonth.roll} สัญญา</p>
              {currentMonth.rollRateApprox !== null && (
                <p className="text-xs text-ink-soft">~{currentMonth.rollRateApprox.toFixed(1)}%</p>
              )}
            </div>
          </div>
          {/* cure */}
          <div className="flex items-center gap-3 rounded-xl bg-green-50 px-4 py-3">
            <TrendingUp className="shrink-0 text-green-500" size={20} />
            <div>
              <p className="text-xs text-ink-soft">เลื่อนชั้น (Cure)</p>
              <p className="text-xl font-bold text-green-600">{currentMonth.cure} สัญญา</p>
              {currentMonth.cureRateApprox !== null && (
                <p className="text-xs text-ink-soft">~{currentMonth.cureRateApprox.toFixed(1)}%</p>
              )}
            </div>
          </div>
          {/* net */}
          <div className={`flex flex-col justify-center rounded-xl px-4 py-3 ${currentMonth.net >= 0 ? 'bg-green-50' : 'bg-red-50'}`}>
            <p className="text-xs text-ink-soft">สุทธิ</p>
            <p className={`text-xl font-bold ${netColor(currentMonth.net)}`}>
              {currentMonth.net > 0 ? `+${currentMonth.net}` : currentMonth.net} สัญญา
            </p>
            <p className="mt-0.5 text-xs text-ink-soft">
              {currentMonth.net > 0 ? 'พอร์ตดีขึ้น' : currentMonth.net < 0 ? 'พอร์ตแย่ลง' : 'ไม่เปลี่ยน'}
            </p>
          </div>
        </div>
        {currentMonth.approxNote && (
          <p className="mt-2 text-xs text-ink-soft">หมายเหตุ: {currentMonth.approxNote}</p>
        )}
      </Card>

      {/* ===== empty state ===== */}
      {emptyState && (
        <Card>
          <div className="py-6 text-center">
            <p className="text-2xl">🌱</p>
            <p className="mt-2 font-semibold text-ink">ยังไม่มีข้อมูลการขยับเกรด</p>
            <p className="mt-1 text-sm text-ink-soft">
              ระบบจะเริ่มบันทึกการเปลี่ยนเกรดตั้งแต่วันพรุ่งนี้เป็นต้นไป
            </p>
            <p className="mt-0.5 text-sm text-ink-soft">ข้อมูลจะครบในเดือนถัดไป</p>
            {backfillMonthLabel !== null && (
              <p className="mt-3 text-xs text-ink-soft">
                (ข้อมูลเดือน {backfillMonthLabel} เป็นจุดเริ่มต้นของระบบ ไม่นับเป็นการเปลี่ยนเกรด)
              </p>
            )}
          </div>
        </Card>
      )}

      {/* ===== ตารางรายเดือน ===== */}
      {months.length > 0 && (
        <Card>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-ink">ตารางรายเดือน (ย้อนหลัง 12 เดือน)</h3>
          </div>
          {backfillMonthLabel !== null && !emptyState && (
            <p className="mb-2 text-xs text-ink-soft">
              * เดือน {backfillMonthLabel} เป็นจุดเริ่มต้นของระบบ ไม่นับเป็นการเปลี่ยนเกรด
            </p>
          )}
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[400px] text-sm">
              <thead>
                <tr className="border-b border-peach text-left text-xs text-ink-soft">
                  <th className="py-2 font-semibold">เดือน</th>
                  <th className="py-2 text-center font-semibold text-red-600">ตกชั้น</th>
                  <th className="py-2 text-center font-semibold text-green-600">เลื่อนชั้น</th>
                  <th className="py-2 text-center font-semibold">สุทธิ</th>
                </tr>
              </thead>
              <tbody>
                {[...months].reverse().map((m, i) =>
                  m.isBackfillSpike ? (
                    <BackfillRow key={i} month={m} />
                  ) : (
                    <MovementRow key={i} month={m} />
                  )
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ===== กราฟแนวโน้ม (แสดงเฉพาะเมื่อมีข้อมูลจริง) ===== */}
      {hasRealMovement && (
        <Card>
          <h3 className="mb-1 font-semibold text-ink">แนวโน้มการขยับเกรด (ราย/เดือน)</h3>
          <LineChart
            labels={months.filter((m) => !m.isBackfillSpike).map((m) => m.monthLabel)}
            series={[
              {
                name: 'ตกชั้น (Roll)',
                color: '#dc2626',
                values: months.filter((m) => !m.isBackfillSpike).map((m) => m.roll),
              },
              {
                name: 'เลื่อนชั้น (Cure)',
                color: '#16a34a',
                values: months.filter((m) => !m.isBackfillSpike).map((m) => m.cure),
                fill: true,
              },
            ]}
          />
        </Card>
      )}
    </div>
  )
}
