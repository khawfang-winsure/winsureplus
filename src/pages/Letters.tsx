import { EmptyState, PageTitle } from '../components/ui'

export default function Letters() {
  return (
    <div>
      <PageTitle sub="รายการสำหรับออกจดหมายติดตามหนี้">ส่งจดหมาย</PageTitle>
      <EmptyState
        title="รอรายละเอียดเพิ่มเติม"
        hint="ข้อมูลส่วนนี้ในไฟล์ยังไม่ละเอียด — ค่อยเก็บ requirement (รูปแบบจดหมาย/เงื่อนไข) แล้วทำใน stage ถัดไป"
      />
    </div>
  )
}
