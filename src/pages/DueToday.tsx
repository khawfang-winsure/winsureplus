import { EmptyState, PageTitle } from '../components/ui'

export default function DueToday() {
  return (
    <div>
      <PageTitle sub="ลูกค้าที่ถึงวันครบกำหนดชำระวันนี้ / ใกล้ครบ">ลูกค้าถึงวันครบกำหนด</PageTitle>
      <EmptyState
        title="ส่วนนี้ทำงานเต็มรูปแบบใน Phase 3-4"
        hint="ต้องสร้างตารางงวดผ่อน + ระบบรันวันที่อัตโนมัติ (pg_cron) ก่อน จึงจะดึงรายชื่อครบกำหนดได้แม่นยำ"
      />
    </div>
  )
}
