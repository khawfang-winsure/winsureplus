import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell } from 'lucide-react'
import { getNotifications, markNotificationRead } from '../lib/db'
import type { NotificationItem } from '../lib/types'

export default function NotificationBell() {
  const navigate = useNavigate()
  const [items, setItems] = useState<NotificationItem[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    getNotifications()
      .then(setItems)
      .catch(() => setItems([]))
  }, [])

  async function openItem(n: NotificationItem) {
    await markNotificationRead(n.id)
    setItems((prev) => prev.filter((i) => i.id !== n.id))
    setOpen(false)
    if (n.contractId) navigate(`/contract/${n.contractId}`)
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-xl border border-peach bg-white p-2.5 text-ink hover:bg-peach-light/50"
        title="แจ้งเตือน"
      >
        <Bell size={18} />
        {items.length > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[11px] font-bold text-white">
            {items.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-xl border border-peach bg-white shadow-lg">
          <div className="border-b border-peach px-4 py-2.5 text-sm font-semibold text-ink">
            แจ้งเตือน ({items.length})
          </div>
          {items.length === 0 ? (
            <p className="p-4 text-sm text-ink-soft">ไม่มีแจ้งเตือนค้าง</p>
          ) : (
            <ul className="max-h-96 overflow-auto">
              {items.map((n) => (
                <li
                  key={n.id}
                  onClick={() => openItem(n)}
                  className="cursor-pointer border-b border-peach/50 px-4 py-3 hover:bg-peach-light/30"
                >
                  <p className="text-sm font-medium text-ink">
                    {n.type === 'due_today' ? '⏰ ครบกำหนดชำระวันนี้' : '⚠️ เลยกำหนดชำระ'}
                  </p>
                  <p className="text-sm text-ink-soft">{n.customerName} — {n.contractNo}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
