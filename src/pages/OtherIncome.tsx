import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { Button, Field, Input, Loading, Modal, PageTitle, Textarea } from '../components/ui'
import Pagination from '../components/Pagination'
import { baht, thaiDate } from '../lib/format'
import { getAllOtherIncome, insertOtherIncome, deleteOtherIncome } from '../lib/db'
import { useAuth } from '../lib/auth'
import type { OtherIncome } from '../lib/types'

/** วันนี้ในโซนเวลา Bangkok (YYYY-MM-DD) */
function todayBKK(): string {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)
}

/** ข้อผิดพลาดเป็น string */
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

// ===== Modal เพิ่มรายได้อื่นๆ =====

function AddOtherIncomeModal({
  onClose,
  onDone,
  userName,
}: {
  onClose: () => void
  onDone: () => void
  userName: string
}) {
  const [amount, setAmount] = useState<number>(0)
  const [category, setCategory] = useState('ค่าเปลี่ยนวันที่ชำระ')
  const [note, setNote] = useState('')
  const [receivedAt, setReceivedAt] = useState(todayBKK())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    if (amount <= 0 || !category.trim()) {
      setErr('กรุณาระบุหมวดหมู่และยอดเงิน')
      return
    }
    if (!receivedAt) {
      setErr('กรุณาระบุวันที่รับเงิน')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await insertOtherIncome({
        amount,
        category: category.trim(),
        note: note.trim() || undefined,
        receivedAt,
        recordedBy: userName,
      })
      onDone()
    } catch (e) {
      setErr(errMsg(e))
      setBusy(false)
    }
  }

  return (
    <Modal title="เพิ่มรายได้อื่นๆ" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="หมวดหมู่ (category)" required>
          <Input
            type="text"
            autoFocus
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="เช่น ค่าเปลี่ยนวันที่ชำระ"
            list="oi-category-suggestions"
          />
          <datalist id="oi-category-suggestions">
            <option value="ค่าเปลี่ยนวันที่ชำระ" />
            <option value="ค่าธรรมเนียมอื่นๆ" />
            <option value="รายได้อื่นๆ" />
          </datalist>
        </Field>
        <Field label="ยอดเงิน (บาท)" required>
          <Input
            type="number"
            min={1}
            value={amount || ''}
            onChange={(e) => setAmount(Number(e.target.value) || 0)}
          />
        </Field>
        <Field label="วันที่รับเงิน" required>
          <Input
            type="date"
            value={receivedAt}
            onChange={(e) => setReceivedAt(e.target.value)}
          />
        </Field>
        <Field label="หมายเหตุ (ไม่บังคับ)">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="รายละเอียดเพิ่มเติม"
            rows={2}
          />
        </Field>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
          <Button onClick={save} disabled={busy || amount <= 0 || !category.trim()}>
            {busy ? 'กำลังบันทึก...' : 'บันทึกรายได้'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ===== หน้าหลัก =====

const PAGE_SIZE_OPTIONS = [20, 50, 100]

export default function OtherIncomePage() {
  const { role, name: userName } = useAuth()
  const isAdmin = role === 'admin'

  const [rows, setRows] = useState<OtherIncome[]>([])
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadErr(null)
    try {
      const data = await getAllOtherIncome()
      setRows(data)
    } catch (e) {
      setLoadErr(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // กรองด้วย search
  const filtered = rows.filter((r) => {
    if (!search.trim()) return true
    const q = search.trim().toLowerCase()
    return (
      r.category.toLowerCase().includes(q) ||
      (r.note ?? '').toLowerCase().includes(q) ||
      (r.recordedBy ?? '').toLowerCase().includes(q)
    )
  })

  const total = filtered.length
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize)
  const grandTotal = rows.reduce((s, r) => s + r.amount, 0)

  function handlePageSize(s: number) {
    setPageSize(s)
    setPage(1)
  }

  function handleSearch(v: string) {
    setSearch(v)
    setPage(1)
  }

  async function handleDelete(id: string) {
    if (!window.confirm('ยืนยันลบรายการนี้?')) return
    try {
      await deleteOtherIncome(id)
      await load()
    } catch (e) {
      alert(errMsg(e))
    }
  }

  if (loading) return <Loading />
  if (loadErr) return <p className="p-6 text-red-600">โหลดข้อมูลไม่ได้: {loadErr}</p>

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <PageTitle
        sub="รายได้ที่ไม่ใช่ค่างวด เช่น ค่าเปลี่ยนวันที่ชำระ"
        count={{ shown: filtered.length, total: rows.length }}
      >
        รายได้อื่นๆ
      </PageTitle>

      {/* toolbar */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Input
          type="search"
          placeholder="ค้นหาหมวด / หมายเหตุ / ผู้บันทึก..."
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          className="w-64"
        />
        <Button onClick={() => setAddOpen(true)}>
          <Plus size={16} /> เพิ่มรายได้อื่นๆ
        </Button>
      </div>

      {/* ยอดรวม */}
      {rows.length > 0 && (
        <p className="mb-3 text-sm text-ink-soft">
          ยอดรวมทั้งหมด{' '}
          <span className="font-semibold text-green-600 whitespace-nowrap">{baht(grandTotal)} ฿</span>
        </p>
      )}

      {/* ตาราง */}
      {filtered.length === 0 ? (
        <p className="rounded-xl bg-peach-light/40 px-4 py-6 text-center text-sm text-ink-soft">
          {search.trim() ? 'ไม่พบรายการที่ตรงกับการค้นหา' : 'ยังไม่มีรายได้อื่นๆ'}
        </p>
      ) : (
        <>
          <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="bg-peach-light text-left text-ink">
                  {['วันที่รับ', 'หมวด', 'จำนวนเงิน', 'ลูกค้า', 'หมายเหตุ', 'ผู้บันทึก', ''].map((h, i) => (
                    <th key={h || i} className="px-3 py-2.5 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r, idx) => (
                  <tr key={r.id} className={idx % 2 === 0 ? 'bg-white' : 'bg-peach-light/20'}>
                    <td className="whitespace-nowrap px-3 py-2.5">{thaiDate(r.receivedAt)}</td>
                    <td className="px-3 py-2.5">{r.category}</td>
                    <td className="px-3 py-2.5 font-semibold text-green-600 whitespace-nowrap">{baht(r.amount)} ฿</td>
                    <td className="px-3 py-2.5">
                      {r.contractId ? (
                        <Link
                          to={`/contract/${r.contractId}`}
                          className="text-salmon-deep hover:underline"
                        >
                          ดูสัญญา
                        </Link>
                      ) : (
                        <span className="text-ink-soft">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-ink-soft">{r.note || '—'}</td>
                    <td className="px-3 py-2.5 text-ink-soft">{r.recordedBy || '—'}</td>
                    <td className="px-3 py-2.5">
                      {isAdmin && (
                        <button
                          onClick={() => handleDelete(r.id)}
                          className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                        >
                          ลบ
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            total={total}
            page={page}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={handlePageSize}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
          />
        </>
      )}

      {/* modal เพิ่ม */}
      {addOpen && (
        <AddOtherIncomeModal
          userName={userName ?? ''}
          onClose={() => setAddOpen(false)}
          onDone={() => {
            setAddOpen(false)
            load()
          }}
        />
      )}
    </div>
  )
}
