import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Download } from 'lucide-react'
import { Badge, Button, EmptyState, Loading, PageTitle } from '../components/ui'
import { baht, thaiDate } from '../lib/format'
import { getOverdueByBucket } from '../lib/db'
import { useFilter } from '../lib/useFilter'
import type { ContractStatusRow, OverdueBucket } from '../lib/types'
import Pagination from '../components/Pagination'
import { escCell, downloadCSV } from '../lib/csv'

const todayISO = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 10)

// ===== สถานะสัญญา (active/returned เท่านั้นที่ปรากฏในหน้านี้ — bucket อื่น view suppress เป็น normal หมด) =====
const STATUS_LABELS: Record<string, string> = {
  active: 'ผ่อนอยู่',
  returned: 'คืนเครื่อง',
}
function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}
function statusTone(status: string): 'neutral' | 'amber' {
  return status === 'returned' ? 'amber' : 'neutral'
}

type StatusFilterValue = 'all' | 'active' | 'returned'
const STATUS_FILTERS: { key: StatusFilterValue; label: string }[] = [
  { key: 'all', label: 'ทั้งหมด' },
  { key: 'active', label: 'เฉพาะผ่อนอยู่' },
  { key: 'returned', label: 'เฉพาะคืนเครื่อง' },
]

// ===== CSV Export =====
function overdueCSV(rows: ContractStatusRow[]): string {
  const headers = [
    'ลูกค้า', 'สถานะ', 'เลขที่สัญญา', 'เลข INV', 'รุ่น', 'จำนวนเดือนในสัญญา', 'ร้าน', 'ครบกำหนด',
    'ชำระแล้ว (งวด)', 'ชำระแล้ว (บาท)', 'ค้างชำระ (งวด)', 'เลยกำหนด (เดือน)',
    'ล่าช้า (วัน)', 'รวมคงเหลือ', 'เกินกำหนด', 'ยังไม่ถึงกำหนด', 'ค้างชำระ+ค่าปรับ',
  ]
  const out: string[] = [headers.map(escCell).join(',')]
  for (const r of rows) {
    const notYetDue = Math.max(0, r.estOutstanding - r.overdueAmount)
    const dueTotal = r.overdueAmount + r.penaltyDue
    const modelText = [r.model, r.storage].filter((v) => v && v.trim()).join(' ')
    out.push([
      escCell(r.customerName),
      escCell(statusLabel(r.status)),
      escCell(r.contractNo),
      escCell(r.invNo ?? ''),
      escCell(modelText),
      escCell(r.termMonths),
      escCell(r.shopName),
      escCell(r.nextDue ? thaiDate(r.nextDue) : '-'),
      escCell(r.paidInstallments),
      escCell(r.paidAmountTotal),
      escCell(r.remainingInstallments),
      escCell(r.lateInstallments),
      escCell(r.daysLate),
      escCell(r.estOutstanding),
      escCell(r.overdueAmount),
      escCell(notYetDue),
      escCell(dueTotal),
    ].join(','))
  }
  return '﻿' + out.join('\r\n')
}

const LABELS: Record<OverdueBucket, string> = {
  normal: 'ปกติ (ยังไม่ครบกำหนด)',
  '1-10': 'ล่าช้า 1-10 วัน',
  '11-30': 'ล่าช้า 11-30 วัน',
  '31-60': 'ล่าช้า 31-60 วัน',
  '61-90': 'ล่าช้า 61-90 วัน',
  '91-120': 'ล่าช้า 91-120 วัน',
  '120+': 'ล่าช้า 120 วันขึ้นไป',
}

// แท็บสลับช่วงในหน้า — ไม่รวม 'normal' (กลุ่มนี้เข้าถึงผ่านลิงก์ล่าช้าเท่านั้น จึงโชว์เฉพาะช่วงล่าช้าจริง)
const TAB_BUCKETS: OverdueBucket[] = ['1-10', '11-30', '31-60', '61-90', '91-120', '120+']
const TAB_LABELS: Record<OverdueBucket, string> = {
  normal: 'ปกติ',
  '1-10': '1-10 วัน',
  '11-30': '11-30 วัน',
  '31-60': '31-60 วัน',
  '61-90': '61-90 วัน',
  '91-120': '91-120 วัน',
  '120+': '120 วันขึ้นไป',
}

const DEFAULT_BUCKET: OverdueBucket = '31-60'

function isOverdueBucket(v: string | undefined): v is OverdueBucket {
  return !!v && v in LABELS
}

export default function Overdue() {
  const { bucket: urlBucket } = useParams()
  const navigate = useNavigate()

  // จำช่วงล่าสุดที่เลือกไว้ใน localStorage (pattern เดียวกับ useFilter ที่ใช้ทั่วเว็บ)
  const [lastBucket, setLastBucket] = useFilter<OverdueBucket>('overdue.lastBucket', DEFAULT_BUCKET)

  // '/overdue/last' = ลิงก์เมนู ไม่ใช่ bucket จริง → เด้งไปช่วงที่จำไว้ล่าสุดทันที
  // ส่วน '/overdue/<bucket จริง>' (bookmark เดิม) ยังเข้าตรงได้ปกติ + อัปเดตค่าที่จำไว้ตามนั้น
  useEffect(() => {
    if (urlBucket === 'last') {
      navigate(`/overdue/${lastBucket}`, { replace: true })
      return
    }
    if (isOverdueBucket(urlBucket) && urlBucket !== lastBucket) {
      setLastBucket(urlBucket)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlBucket])

  const bucket: OverdueBucket = isOverdueBucket(urlBucket) ? urlBucket : DEFAULT_BUCKET
  const label = LABELS[bucket]

  const [rows, setRows] = useState<ContractStatusRow[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>('all')

  const load = useCallback(async () => {
    setLoading(true)
    setRows(await getOverdueByBucket(bucket))
    setLoading(false)
  }, [bucket])

  useEffect(() => {
    load()
  }, [load])

  // เปลี่ยน bucket แล้วรีเซ็ตตัวกรองสถานะกลับ "ทั้งหมด" ด้วย — กันเลือก "เฉพาะคืนเครื่อง" ค้างข้ามช่วง แล้วเข้าใจผิดว่าไม่มีข้อมูล
  useEffect(() => { setStatusFilter('all') }, [bucket])

  // กรองตามสถานะ (ผ่อนอยู่/คืนเครื่อง) ก่อนแบ่งหน้า
  const filteredRows = useMemo(
    () => (statusFilter === 'all' ? rows : rows.filter((r) => r.status === statusFilter)),
    [rows, statusFilter],
  )

  // reset page เมื่อเปลี่ยน bucket หรือเปลี่ยนตัวกรองสถานะ (กันหน้าค้างเกินจำนวนหลังกรอง)
  useEffect(() => { setPage(1) }, [bucket, statusFilter])

  const pagedRows = useMemo(
    () => filteredRows.slice((page - 1) * pageSize, page * pageSize),
    [filteredRows, page, pageSize],
  )

  const filenameSuffix = statusFilter === 'all' ? '' : `_${statusFilter}`

  return (
    <div>
      <PageTitle
        sub="กลุ่มนี้คำนวณอัตโนมัติจากจำนวนวันเลยกำหนด (อัปเดตทุกวันโดยระบบ)"
        count={loading ? undefined : { shown: filteredRows.length, total: rows.length }}
      >
        {label}
      </PageTitle>

      {/* แท็บสลับช่วงล่าช้า — เปลี่ยน URL + จำไว้ใน localStorage สำหรับครั้งถัดไป */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          {TAB_BUCKETS.map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => navigate(`/overdue/${b}`)}
              className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
                bucket === b
                  ? 'bg-salmon-deep text-white'
                  : 'border border-peach bg-white text-ink-soft hover:bg-peach-light'
              }`}
            >
              {TAB_LABELS[b]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* ตัวกรองสถานะ — แยกลูกค้าผ่อนอยู่ ออกจากลูกค้าคืนเครื่อง */}
          <div className="inline-flex rounded-xl border border-peach bg-white p-1">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setStatusFilter(f.key)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  statusFilter === f.key
                    ? 'bg-peach text-ink'
                    : 'text-ink-soft hover:bg-peach-light'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            disabled={loading || filteredRows.length === 0}
            onClick={() => downloadCSV(overdueCSV(filteredRows), `overdue_${bucket}${filenameSuffix}_${todayISO}.csv`)}
          >
            <Download className="h-4 w-4" />
            ส่งออก CSV
          </Button>
        </div>
      </div>

      {loading ? (
        <Loading />
      ) : filteredRows.length === 0 ? (
        <EmptyState
          title={rows.length === 0 ? 'ไม่มีลูกค้าในกลุ่มนี้' : 'ไม่มีลูกค้าตรงกับตัวกรองสถานะที่เลือก'}
          hint={rows.length === 0 ? 'ลูกค้าจะถูกจัดเข้ากลุ่มเองตามจำนวนวันที่ค้างชำระ' : 'ลองเลือก "ทั้งหมด" เพื่อดูทุกสถานะ'}
        />
      ) : (
        <>
          {/* ===== Desktop table (≥ md) ===== */}
          <div className="scrollbar-thin hidden overflow-x-auto rounded-2xl border border-peach md:block">
            <table className="w-full min-w-[1400px] border-collapse text-sm">
              <thead>
                <tr className="bg-peach-light text-left text-ink">
                  <th className="whitespace-nowrap px-3 py-2.5 font-semibold">ลูกค้า</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-semibold">สถานะ</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-semibold">ร้าน</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-semibold">ครบกำหนด</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">ชำระแล้ว</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">ค้างชำระ (งวด)</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">เลยกำหนด (เดือน)</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">ล่าช้า (วัน)</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">รวมคงเหลือ</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">เกินกำหนด</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">ยังไม่ถึงกำหนด</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">ค้างชำระ+ค่าปรับ</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((r, i) => {
                  const notYetDue = Math.max(0, r.estOutstanding - r.overdueAmount)
                  const dueTotal = r.overdueAmount + r.penaltyDue
                  const zebra = i % 2 ? 'bg-white' : 'bg-peach-light/20'
                  return (
                    <tr
                      key={r.contractId}
                      onClick={() => navigate(`/contract/${r.contractId}`)}
                      className={`cursor-pointer border-b border-peach/60 hover:bg-peach-light/40 ${zebra}`}
                    >
                      <td className="whitespace-nowrap px-3 py-2.5 align-top">
                        <p className="font-medium text-ink">{r.customerName}</p>
                        <p className="text-xs text-ink-soft">{r.contractNo}</p>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 align-top">
                        <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 align-top">{r.shopName}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 align-top">{r.nextDue ? thaiDate(r.nextDue) : '-'}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right align-top">
                        {r.paidInstallments} งวด <span className="text-ink-soft">· {baht(r.paidAmountTotal)}</span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right align-top">{r.remainingInstallments}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right align-top">{r.lateInstallments}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right align-top">
                        <Badge tone="red">{r.daysLate} วัน</Badge>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right align-top">{baht(r.estOutstanding)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right align-top">{baht(r.overdueAmount)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right align-top">{baht(notYetDue)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right align-top font-semibold text-salmon-deep">
                        {baht(dueTotal)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* ===== Mobile card stack (< md) ===== */}
          <div className="flex flex-col gap-3 md:hidden">
            {pagedRows.map((r) => {
              const notYetDue = Math.max(0, r.estOutstanding - r.overdueAmount)
              const dueTotal = r.overdueAmount + r.penaltyDue
              return (
                <div
                  key={r.contractId}
                  onClick={() => navigate(`/contract/${r.contractId}`)}
                  className="cursor-pointer rounded-2xl border border-peach bg-white p-4 shadow-sm hover:bg-peach-light/30"
                >
                  <div className="mb-1 flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium text-ink">{r.customerName}</p>
                      <p className="text-xs text-ink-soft">{r.contractNo} · {r.shopName}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
                      <Badge tone="red">ล่าช้า {r.daysLate} วัน</Badge>
                    </div>
                  </div>
                  <p className="mb-2 text-xs text-ink-soft">
                    ครบกำหนด {r.nextDue ? thaiDate(r.nextDue) : '-'} · ชำระแล้ว {r.paidInstallments} งวด ({baht(r.paidAmountTotal)}) · ค้าง {r.remainingInstallments} งวด ({r.lateInstallments} เดือน)
                  </p>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-soft">
                    <span>รวมคงเหลือ {baht(r.estOutstanding)}</span>
                    <span>เกินกำหนด {baht(r.overdueAmount)}</span>
                    <span>ยังไม่ถึงกำหนด {baht(notYetDue)}</span>
                  </div>
                  <p className="mt-2 text-sm font-semibold text-salmon-deep">
                    ค้างชำระ+ค่าปรับ {baht(dueTotal)} ฿
                  </p>
                </div>
              )
            })}
          </div>

          <Pagination
            total={filteredRows.length}
            page={page}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
          />
        </>
      )}
    </div>
  )
}
