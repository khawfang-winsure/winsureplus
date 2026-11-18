import { MapPin } from 'lucide-react'
import type { FieldVisitStatusInfo } from '../lib/types'
import { FIELD_VISIT_REASON_LABEL, fieldVisitBadgeText, fieldVisitStatusTone } from '../lib/fieldVisit'
import { Badge } from './ui'

/** ป้ายเตือนอย่างเดียว — ไม่ปิดปุ่มโทร/บันทึกติดตาม */
export function FieldVisitBadge({ info }: { info: FieldVisitStatusInfo | undefined }) {
  if (!info) return null
  const tone = fieldVisitStatusTone(info.status, info.resultCode, info.closeCode)
  const text = fieldVisitBadgeText(info, new Date())
  return (
    <span
      title={
        info.closeCode
          ? `เหตุผลที่ขอลงพื้นที่: ${FIELD_VISIT_REASON_LABEL[info.reason]}`
          : `เหตุผล: ${FIELD_VISIT_REASON_LABEL[info.reason]} — อยู่ระหว่างลงพื้นที่ ยังโทรติดตามได้ตามปกติ`
      }
      className="inline-flex"
    >
      <Badge tone={tone === 'gray' || tone === 'blue' ? 'neutral' : tone}>
        <span className="inline-flex items-center gap-1">
          <MapPin size={12} aria-hidden="true" />
          {text}
        </span>
      </Badge>
    </span>
  )
}
