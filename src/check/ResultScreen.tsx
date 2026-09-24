import { Button, Card, Pill } from './ui'
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
        <h2 className="wsc-h2 mt-3">{display.title}</h2>
        <p className="mt-1 text-xs wsc-muted">
          รหัสคำขอ <Pill tone="neutral">{result.id.slice(0, 8)}</Pill>
        </p>

        {result.reasonsShop.length > 0 && (
          <ul className="mt-4 space-y-1.5 text-left text-sm">
            {result.reasonsShop.map((text, i) => (
              <li key={i} className="wsc-note">
                {text}
              </li>
            ))}
          </ul>
        )}

        <p className="mt-4 text-xs wsc-muted">
          ผลนี้เป็นการตรวจเบื้องต้นเท่านั้น ทีมงาน WIN SURE PLUS จะตรวจสอบเพิ่มเติม (ประวัติเครดิต + Facebook)
          ก่อนยืนยันผลจริงอีกครั้ง
        </p>

        <div className="mt-6 flex flex-col gap-2">
          <Button onClick={onNewRequest}>
            ยื่นคำขอใหม่
            <span className="wsc-go" aria-hidden="true">
              →
            </span>
          </Button>
          <Button variant="ghost" onClick={onViewList}>
            ดูคำขอของร้าน
          </Button>
        </div>
      </Card>
    </div>
  )
}
