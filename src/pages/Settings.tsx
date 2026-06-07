import { Badge, Card, PageTitle } from '../components/ui'
import type { Option } from '../lib/types'
import {
  occupationProofs,
  occupations,
  phoneModels,
  promotions,
  shops,
  storageOptions,
} from '../lib/mockData'

function OptionList({ title, items }: { title: string; items: Option[] }) {
  return (
    <Card>
      <h3 className="mb-3 font-semibold text-ink">{title}</h3>
      <div className="flex flex-wrap gap-2">
        {items.map((o) => (
          <span key={o.id} className="rounded-full bg-white px-3 py-1.5 text-sm text-ink shadow-sm">
            {o.label}
          </span>
        ))}
      </div>
    </Card>
  )
}

export default function Settings() {
  return (
    <div>
      <PageTitle sub="จัดการร้านค้าและตัวเลือกต่างๆ (เฉพาะแอดมิน) — แก้/เพิ่ม/ลบได้เมื่อเชื่อม Supabase">
        ตั้งค่า
      </PageTitle>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="md:col-span-2">
          <h3 className="mb-3 font-semibold text-ink">ร้านค้า ({shops.length})</h3>
          <div className="grid gap-2 md:grid-cols-2">
            {shops.map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-xl bg-white px-4 py-3">
                <div>
                  <p className="font-medium text-ink">{s.code} · {s.name}</p>
                  <p className="text-sm text-ink-soft">{s.bank} · {s.accountNo}</p>
                </div>
                <Badge tone={s.active ? 'green' : 'neutral'}>{s.active ? 'ใช้งาน' : 'ปิด'}</Badge>
              </div>
            ))}
          </div>
        </Card>

        <OptionList title="รุ่นโทรศัพท์" items={phoneModels} />
        <OptionList title="ความจำ" items={storageOptions} />
        <OptionList title="อาชีพ" items={occupations} />
        <OptionList title="หลักฐานอาชีพ" items={occupationProofs} />
        <OptionList title="โปรโมชั่น" items={promotions} />
      </div>

      <p className="mt-5 rounded-xl bg-peach-light/50 px-4 py-3 text-sm text-ink-soft">
        💡 หมายเหตุ: การ "ลบ" ตัวเลือกจะใช้วิธีปิดการใช้งาน (ซ่อน) ไม่ลบจริง เพื่อให้ข้อมูลเก่าที่อ้างอิงอยู่ไม่หาย
      </p>
    </div>
  )
}
