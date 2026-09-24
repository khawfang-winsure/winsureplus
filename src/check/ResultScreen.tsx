import { Button, Card } from '../components/ui'
import type { SubmitResult } from './api'
import { LEVEL_DISPLAY } from './levelDisplay'

export default function ResultScreen({
  result,
  onNewRequest,
  onViewList,
}: {
  result: SubmitResult
  onNewRequest: () => void
  onViewList: () => void
}) {
  const display = LEVEL_DISPLAY[result.level]

  return (
    <div className="mx-auto max-w-md px-4 py-6">
      <Card className="text-center">
        <div className="text-5xl">{display.emoji}</div>
        <h2 className="mt-3 text-lg font-bold text-ink">{display.title}</h2>
        <p className="mt-1 text-xs text-muted-check">รหัสคำขอ {result.id.slice(0, 8)}</p>

        {result.reasonsShop.length > 0 && (
          <ul className="mt-4 space-y-1.5 text-left text-sm text-muted-check">
            {result.reasonsShop.map((text, i) => (
              <li key={i} className="rounded-lg bg-peach-light/50 px-3 py-2">
                {text}
              </li>
            ))}
          </ul>
        )}

        <p className="mt-4 text-xs text-muted-check">
          ผลนี้เป็นการตรวจเบื้องต้นเท่านั้น ทีมงาน WIN SURE PLUS จะตรวจสอบเพิ่มเติม (ประวัติเครดิต + Facebook)
          ก่อนยืนยันผลจริงอีกครั้ง
        </p>

        <div className="mt-6 flex flex-col gap-2">
          <Button onClick={onNewRequest} className="w-full !bg-orange-700">
            ยื่นคำขอใหม่
          </Button>
          <Button variant="ghost" onClick={onViewList} className="w-full">
            ดูคำขอของร้าน
          </Button>
        </div>
      </Card>
    </div>
  )
}
