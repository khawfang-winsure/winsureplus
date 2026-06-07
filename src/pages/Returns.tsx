import { EmptyState, PageTitle } from '../components/ui'

export default function Returns() {
  return (
    <div>
      <PageTitle sub="ลูกค้าที่คืนเครื่อง — แบ่ง 3 กรณีตามการชำระและการเช็คเครื่อง">ลูกค้าคืนเครื่อง</PageTitle>

      <div className="mb-5 grid gap-3 md:grid-cols-3">
        {[
          { n: 1, t: 'ยังไม่ชำระค่างวด+ค่าปรับ', d: 'รอเช็คเครื่อง' },
          { n: 2, t: 'ชำระค่างวด+ค่าปรับแล้ว', d: 'รอเช็คเครื่อง' },
          { n: 3, t: 'ชำระครบ + ค่าซ่อม (ถ้ามี)', d: 'ปิดสัญญาสมบูรณ์' },
        ].map((c) => (
          <div key={c.n} className="rounded-2xl border border-peach bg-peach-light/40 p-4">
            <p className="text-sm font-semibold text-salmon-deep">กรณีที่ {c.n}</p>
            <p className="mt-1 font-medium text-ink">{c.t}</p>
            <p className="text-sm text-ink-soft">{c.d}</p>
          </div>
        ))}
      </div>

      <EmptyState
        title="Workflow คืนเครื่องทำใน Phase 5"
        hint="พนักงานกดเปลี่ยนสถานะ → เด้ง popup ให้ติ๊กกรณี → ใส่ค่าซ่อมเพิ่มได้ภายหลัง"
      />
    </div>
  )
}
