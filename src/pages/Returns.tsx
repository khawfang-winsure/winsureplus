import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, FileText, Wrench, CheckCircle2 } from 'lucide-react'
import { Badge, Button, EmptyState, Input, Loading, Modal, PageTitle, Select } from '../components/ui'
import Pagination from '../components/Pagination'
import { baht, thaiDate } from '../lib/format'
import { getDeviceReturnReportRows, getReturns, updateReturnRepairFee, closeReturnedContract } from '../lib/db'
import type { DeviceReturnReportRow, DeviceReturnRow } from '../lib/types'
import { useAuth } from '../lib/auth'

type Tab = 'all' | 'returned' | 'returned_closed'

export default function Returns() {
  const navigate = useNavigate()
  const { role, name: userName, configured } = useAuth()
  const isAdmin = !configured || role === 'admin'
  const canStaff = isAdmin || role === 'staff'

  // ===== 2 แหล่งข้อมูล (โหลดเอง เพื่อ reload หลัง mutate) =====
  const [rows, setRows] = useState<DeviceReturnReportRow[]>([])
  const [returnMap, setReturnMap] = useState<Map<string, DeviceReturnRow>>(new Map())
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const [report, returns] = await Promise.all([getDeviceReturnReportRows(), getReturns()])
    // Map<contractId, DeviceReturnRow> — ถ้าหลายแถว/สัญญา เอาอันใหม่สุด (createdAt)
    const m = new Map<string, DeviceReturnRow>()
    for (const r of returns) {
      const cur = m.get(r.contractId)
      if (!cur || r.createdAt > cur.createdAt) m.set(r.contractId, r)
    }
    setRows(report)
    setReturnMap(m)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // ===== Tab + filter state =====
  const [tab, setTab] = useState<Tab>('returned')
  const [search, setSearch] = useState('')
  const [shop, setShop] = useState<string>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)

  // นับต่อ tab
  const counts = useMemo(() => {
    let open = 0
    let closed = 0
    for (const r of rows) {
      if (r.status === 'returned') open++
      else if (r.status === 'returned_closed') closed++
    }
    return { all: rows.length, returned: open, returned_closed: closed }
  }, [rows])

  // ตัวเลือกร้าน (distinct เฉพาะแถวที่มีชื่อร้าน)
  const shopOptions = useMemo(() => {
    const s = new Set<string>()
    for (const r of rows) if (r.shopName) s.add(r.shopName)
    return [...s].sort((a, b) => a.localeCompare(b, 'th'))
  }, [rows])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (tab !== 'all' && r.status !== tab) return false
      if (shop !== 'all' && r.shopName !== shop) return false
      if (q) {
        const hay = `${r.customerName} ${r.contractNo}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [rows, tab, shop, search])

  // reset page เมื่อเปลี่ยนตัวกรอง
  useEffect(() => { setPage(1) }, [tab, shop, search])

  const pagedRows = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page, pageSize],
  )

  // ===== modal state =====
  const [repairEdit, setRepairEdit] = useState<DeviceReturnRow | null>(null)
  const [detailTarget, setDetailTarget] = useState<{ row: DeviceReturnReportRow; ret: DeviceReturnRow } | null>(null)
  const [closeTarget, setCloseTarget] = useState<DeviceReturnReportRow | null>(null)

  const tabs: { key: Tab; label: string; n: number }[] = [
    { key: 'all', label: 'ทั้งหมด', n: counts.all },
    { key: 'returned', label: 'ยังตามเก็บ', n: counts.returned },
    { key: 'returned_closed', label: 'ปิดแล้ว', n: counts.returned_closed },
  ]

  const emptyTitle =
    tab === 'returned' ? 'ไม่มีเคสที่ยังตามเก็บ'
      : tab === 'returned_closed' ? 'ยังไม่มีเคสที่ปิดแล้ว'
        : 'ยังไม่มีรายการคืนเครื่อง'

  return (
    <div>
      <PageTitle
        sub="จัดการด้านการเงินของลูกค้าที่คืนเครื่อง — ยอดที่ต้องเก็บ ค่าซ่อม และปิดสัญญา"
        count={loading ? undefined : { shown: filtered.length, total: rows.length }}
      >
        ลูกค้าคืนเครื่อง
      </PageTitle>

      {/* ===== Tab bar (นับต่อ tab) ===== */}
      <div className="mb-4 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-xl px-4 py-2 text-sm font-medium transition ${
              tab === t.key
                ? 'bg-salmon text-white shadow-sm'
                : 'bg-peach-soft text-ink hover:bg-peach'
            }`}
          >
            {t.label} ({t.n})
          </button>
        ))}
      </div>

      {/* ===== ค้นหา + กรองร้าน ===== */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="ค้นหาชื่อลูกค้า / เลขสัญญา"
          className="w-full sm:w-72"
        />
        <Select
          value={shop}
          onChange={(e) => setShop(e.target.value)}
          className="!w-auto min-w-[160px]"
        >
          <option value="all">ทุกร้าน</option>
          {shopOptions.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </Select>
      </div>

      {loading ? (
        <Loading />
      ) : filtered.length === 0 ? (
        <EmptyState title={emptyTitle} />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-peach text-left text-ink-soft">
                  <th className="py-2 pr-4 font-medium">ลูกค้า / สัญญา</th>
                  <th className="py-2 pr-4 font-medium">ร้าน</th>
                  <th className="py-2 pr-4 font-medium">เกรด</th>
                  <th className="py-2 pr-4 font-medium text-right">ยอดที่ต้องเก็บ</th>
                  <th className="py-2 pr-4 font-medium text-right">ค่าซ่อม</th>
                  <th className="py-2 pr-4 font-medium">สถานะ</th>
                  <th className="py-2 pr-4 font-medium">วันที่คืน</th>
                  <th className="py-2 font-medium text-right">จัดการ</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((r) => {
                  const ret = returnMap.get(r.contractId) ?? null
                  const closed = r.status === 'returned_closed'
                  return (
                    <tr
                      key={r.contractId}
                      className="border-b border-peach/50 hover:bg-peach-light/30"
                    >
                      <td
                        className="py-3 pr-4 cursor-pointer"
                        onClick={() => navigate(`/contract/${r.contractId}`)}
                      >
                        <p className="font-medium text-ink hover:text-salmon-deep">{r.customerName}</p>
                        <p className="text-xs text-ink-soft">{r.contractNo}</p>
                      </td>
                      <td className="py-3 pr-4 text-ink">{r.shopName ?? '—'}</td>
                      <td className="py-3 pr-4">
                        {r.grade ? <Badge tone="neutral">{r.grade}</Badge> : <span className="text-ink-soft">—</span>}
                      </td>
                      <td className="py-3 pr-4 text-right text-ink whitespace-nowrap">
                        {closed ? <span className="text-ink-soft">—</span> : `${baht(r.collectibleRemaining)} ฿`}
                      </td>
                      <td className="py-3 pr-4 text-right text-ink whitespace-nowrap">
                        {r.repairCost > 0 ? `${baht(r.repairCost)} ฿` : <span className="text-ink-soft">-</span>}
                      </td>
                      <td className="py-3 pr-4">
                        <Badge tone={closed ? 'green' : 'amber'}>
                          {closed ? 'ปิดแล้ว' : 'ยังตามเก็บ'}
                        </Badge>
                      </td>
                      <td className="py-3 pr-4 text-ink-soft whitespace-nowrap">
                        {r.returnDate ? thaiDate(r.returnDate.slice(0, 10)) : '—'}
                      </td>
                      <td className="py-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {ret && (
                            <Button variant="ghost" onClick={() => setDetailTarget({ row: r, ret })} aria-label="ดูตำหนิเครื่อง">
                              <FileText size={13} />
                              ตำหนิ
                            </Button>
                          )}
                          {ret && !closed && (
                            <Button variant="ghost" onClick={() => setRepairEdit(ret)}>
                              <Wrench size={13} />
                              ใส่ค่าซ่อม
                            </Button>
                          )}
                          {!closed && canStaff && (
                            <Button onClick={() => setCloseTarget(r)}>
                              <CheckCircle2 size={13} />
                              ปิดสัญญา
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <Pagination
            total={filtered.length}
            page={page}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
          />
        </>
      )}

      {repairEdit && (
        <RepairModal
          row={repairEdit}
          onClose={() => setRepairEdit(null)}
          onDone={async () => {
            setRepairEdit(null)
            await load()
          }}
        />
      )}

      {detailTarget && (
        <DefectModal row={detailTarget.row} ret={detailTarget.ret} onClose={() => setDetailTarget(null)} />
      )}

      {closeTarget && (
        <CloseModal
          row={closeTarget}
          byName={userName ?? 'ไม่ทราบ'}
          onClose={() => setCloseTarget(null)}
          onDone={async () => {
            setCloseTarget(null)
            await load()
          }}
        />
      )}
    </div>
  )
}

// ===== Modal ดูตำหนิ (มุมเงิน — สัญญา/รุ่น/ค่าซ่อม/ตำหนิ เท่านั้น) =====
function DefectModal({
  row,
  ret,
  onClose,
}: {
  row: DeviceReturnReportRow
  ret: DeviceReturnRow
  onClose: () => void
}) {
  const hasDefect = !!ret.defectNotes && ret.defectNotes.trim().length > 0
  const repair = ret.repairCost ?? ret.repairFee ?? 0

  return (
    <Modal title={`ตำหนิเครื่อง — ${row.customerName}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <span className="text-ink-soft">สัญญา</span>
          <span className="text-ink">{row.contractNo}</span>
          <span className="text-ink-soft">รุ่นเครื่อง</span>
          <span className="text-ink">{ret.deviceModel ?? '—'}</span>
          <span className="text-ink-soft">ค่าซ่อม</span>
          <span className="text-ink whitespace-nowrap">{repair > 0 ? `${baht(repair)} ฿` : '-'}</span>
        </div>

        <div>
          <p className="mb-1 flex items-center gap-1.5 text-sm font-medium text-ink">
            <AlertCircle size={15} className="text-salmon-deep" />
            ตำหนิตัวเครื่อง
          </p>
          {hasDefect ? (
            <div className="whitespace-pre-line rounded-xl bg-peach-light/40 px-4 py-3 text-sm text-ink">
              {ret.defectNotes}
            </div>
          ) : (
            <p className="rounded-xl bg-peach-light/40 px-4 py-3 text-sm text-ink-soft">
              ยังไม่มีบันทึกตำหนิ
            </p>
          )}
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>ปิด</Button>
        </div>
      </div>
    </Modal>
  )
}

// ===== Modal ใส่ค่าซ่อม =====
function RepairModal({
  row,
  onClose,
  onDone,
}: {
  row: DeviceReturnRow
  onClose: () => void
  onDone: () => void
}) {
  const [fee, setFee] = useState(String(row.repairFee || ''))
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      await updateReturnRepairFee(row.id, Number(fee) || 0)
      onDone()
    } catch {
      setBusy(false)
    }
  }

  return (
    <Modal title={`ใส่ค่าซ่อม — ${row.customerName}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Input type="number" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="ค่าซ่อม (บาท)" />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
          <Button onClick={save} disabled={busy}>{busy ? 'กำลังบันทึก...' : 'บันทึก'}</Button>
        </div>
      </div>
    </Modal>
  )
}

// ===== Modal ปิดสัญญา (สรุปยอด → ยืนยัน) =====
function CloseModal({
  row,
  byName,
  onClose,
  onDone,
}: {
  row: DeviceReturnReportRow
  byName: string
  onClose: () => void
  onDone: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function confirm() {
    setBusy(true)
    setErr(null)
    try {
      await closeReturnedContract(row.contractId, byName)
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal title="ปิดสัญญา (คืนเครื่อง)" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink">
          ยืนยันปิดสัญญาของ <span className="font-semibold">{row.customerName}</span>{' '}
          <span className="text-ink-soft">({row.contractNo})</span> หรือไม่?
        </p>

        <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-peach-light/40 px-4 py-3 text-sm">
          <span className="text-ink-soft">ยอดที่ต้องเก็บ</span>
          <span className="text-ink text-right whitespace-nowrap">{baht(row.collectibleRemaining)} ฿</span>
          <span className="text-ink-soft">ค่าซ่อม</span>
          <span className="text-ink text-right whitespace-nowrap">{row.repairCost > 0 ? `${baht(row.repairCost)} ฿` : '-'}</span>
        </div>

        <p className="text-xs text-ink-soft">
          เมื่อปิดสัญญาแล้ว เคสจะย้ายไปกลุ่ม "ปิดแล้ว" และยอดที่ต้องเก็บจะถือว่าจัดการครบ
        </p>

        {err && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>ยกเลิก</Button>
          <Button onClick={confirm} disabled={busy}>{busy ? 'กำลังปิด...' : 'ยืนยันปิดสัญญา'}</Button>
        </div>
      </div>
    </Modal>
  )
}
