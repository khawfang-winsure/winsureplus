import { useParams } from 'react-router-dom'
import { EmptyState, PageTitle } from '../components/ui'

const LABELS: Record<string, string> = {
  '1-10': 'ล่าช้า 1-10 วัน',
  '11-30': 'ล่าช้า 11-30 วัน',
  '31-60': 'ล่าช้า 31-60 วัน',
  '61-90': 'ล่าช้า 61-90 วัน',
  '91-120': 'ล่าช้า 91-120 วัน',
  '120+': 'ล่าช้า 120 วันขึ้นไป',
}

export default function Overdue() {
  const { bucket } = useParams()
  const label = LABELS[bucket ?? ''] ?? 'ลูกค้าล่าช้า'

  return (
    <div>
      <PageTitle sub="กลุ่มนี้คำนวณอัตโนมัติจากจำนวนวันเลยกำหนด">{label}</PageTitle>
      <EmptyState
        title="ส่วนนี้ทำงานเต็มรูปแบบใน Phase 3-4"
        hint="เมื่อมีตารางงวด + ระบบรันวันล่าช้าอัตโนมัติ ลูกค้าจะถูกจัดเข้ากลุ่มนี้เองตามจำนวนวันที่ค้าง"
      />
    </div>
  )
}
