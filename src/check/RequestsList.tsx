import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Loading } from '../components/ui'
import { thaiDate } from '../lib/format'
import { ApiError, listRequests, type RequestListItem } from './api'
import { LEVEL_DISPLAY } from './levelDisplay'

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
        <h2 className="text-lg font-bold text-ink">คำขอของร้าน</h2>
        <Button variant="ghost" onClick={() => void load()} disabled={loading} aria-label="รีเฟรชรายการ">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          รีเฟรช
        </Button>
      </div>

      {loading && !items && <Loading label="กำลังโหลดรายการ..." />}

      {error && (
        <p role="alert" className="mb-3 rounded-xl bg-red-100 px-3 py-2 text-sm font-medium text-red-700">
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
              <Card key={item.id} className="!p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium text-ink">{item.customerName}</p>
                    <p className="text-xs text-muted-check">
                      บัตร {item.nationalIdMasked} · {thaiDate(item.createdAt.slice(0, 10))}
                    </p>
                  </div>
                  {levelDisplay && (
                    <Badge tone={levelDisplay.tone}>
                      {levelDisplay.emoji} {levelDisplay.title}
                    </Badge>
                  )}
                </div>
                {(item.engineLevel === 'passed_preliminary' || item.decision) && (
                  <p className="mt-2 text-xs text-muted-check">
                    ตรวจแบล็กลิสต์: {item.blacklistDone ? 'ตรวจแล้ว' : 'รอตรวจ'} · Facebook: {item.facebookDone ? 'ตรวจแล้ว' : 'รอตรวจ'}
                  </p>
                )}
                {decision && <p className="mt-2 text-sm text-muted-check">{decision}</p>}
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
