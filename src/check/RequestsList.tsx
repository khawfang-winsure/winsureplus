import { useCallback, useEffect, useState } from 'react'
import { thaiDate } from '../lib/format'
import { ApiError, listRequests, type RequestListItem } from './api'
import { LEVEL_DISPLAY } from './levelDisplay'
import { Button, Card, EmptyState, Loading, Pill } from './ui'

function decisionText(d: RequestListItem['decision']): string | null {
  if (d === 'approved') return 'ทีมยืนยันแล้ว — ดำเนินการต่อได้'
  if (d === 'rejected') return 'ทีมแจ้งว่ายังไม่ผ่าน'
  if (d === 'need_more_info') return 'ทีมขอเอกสาร/ข้อมูลเพิ่มเติม'
  return null
}

export default function RequestsList({
  token,
  onSessionExpired,
}: {
  token: string
  onSessionExpired: (notice: string) => void
}) {
  const [items, setItems] = useState<RequestListItem[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await listRequests(token)
      setItems(result)
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'unauthorized') {
        onSessionExpired(e.message)
        return
      }
      setError(e instanceof ApiError ? e.message : 'โหลดรายการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
    } finally {
      setLoading(false)
    }
  }, [token, onSessionExpired])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="mx-auto max-w-md px-4 py-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="wsc-h2">คำขอของร้าน</h2>
        <Button variant="ghost" onClick={() => void load()} disabled={loading} aria-label="รีเฟรชรายการ" className="!w-auto !min-h-0 px-3 py-1.5 text-xs">
          {loading ? 'กำลังโหลด...' : 'รีเฟรช'}
        </Button>
      </div>

      {loading && !items && <Loading label="กำลังโหลดรายการ..." />}

      {error && (
        <p role="alert" className="wsc-note bad mb-3">
          {error}
        </p>
      )}

      {items && items.length === 0 && (
        <EmptyState title="ยังไม่มีคำขอ" hint="เมื่อส่งคำขอเช็คเครดิตแล้ว รายการจะแสดงที่นี่" />
      )}

      {items && items.length > 0 && (
        <div className="flex flex-col gap-3">
          {items.map((item) => {
            const levelDisplay = item.engineLevel ? LEVEL_DISPLAY[item.engineLevel] : null
            const decision = decisionText(item.decision)
            return (
              <Card key={item.id}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{item.customerName}</p>
                    <p className="text-xs wsc-muted">
                      บัตร {item.nationalIdMasked} · {thaiDate(item.createdAt.slice(0, 10))}
                    </p>
                  </div>
                  {levelDisplay && (
                    <Pill tone={levelDisplay.tone}>
                      {levelDisplay.emoji} {levelDisplay.title}
                    </Pill>
                  )}
                </div>
                {(item.engineLevel === 'passed_preliminary' || item.decision) && (
                  <p className="mt-2 text-xs wsc-muted">
                    ตรวจแบล็กลิสต์: {item.blacklistDone ? 'ตรวจแล้ว' : 'รอตรวจ'} · Facebook: {item.facebookDone ? 'ตรวจแล้ว' : 'รอตรวจ'}
                  </p>
                )}
                {decision && <p className="mt-2 text-sm wsc-muted">{decision}</p>}
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
