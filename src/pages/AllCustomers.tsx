import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { FileCheck, Mail, Pencil, Search, X } from 'lucide-react'
import { Badge, Input, Loading, PageTitle, Select } from '../components/ui'
import { baht, maskNationalId, statusLabel, thaiDate } from '../lib/format'
import { getAllInstallments, getAllStatuses, getContracts, getShops } from '../lib/db'
import type { Contract, ContractStatus, ContractStatusRow, OverdueBucket } from '../lib/types'
import { useAsync } from '../lib/useAsync'

// ป้ายกลุ่มความล่าช้า (ใช้ในดรอปดาวน์ + badge)
const BUCKET_LABEL: Record<OverdueBucket, string> = {
  normal: 'ปกติ',
  '1-10': 'ล่าช้า 1-10 วัน',
  '11-30': 'ล่าช้า 11-30 วัน',
  '31-60': 'ล่าช้า 31-60 วัน',
  '61-90': 'ล่าช้า 61-90 วัน',
  '91-120': 'ล่าช้า 91-120 วัน',
  '120+': 'ล่าช้า 120 วันขึ้นไป',
}
const STATUS_OPTS: ContractStatus[] = ['active', 'closed', 'returned', 'returned_closed', 'online']
const BUCKET_OPTS: OverdueBucket[] = ['normal', '1-10', '11-30', '31-60', '61-90', '91-120', '120+']

// ป้ายสถานะสุขภาพสัญญา — ใช้ bucket จาก v_contract_status
function StatusPills({ contract, st }: { contract: Contract; st: ContractStatusRow | undefined }) {
  if (contract.status !== 'active') {
    return <Badge tone="neutral">{statusLabel(contract.status)}</Badge>
  }
  const bucket = st?.bucket ?? 'normal'
  const daysLate = st?.daysLate ?? 0
  if (bucket === '91-120' || bucket === '120+') {
    return <Badge tone="red">หนี้เสีย</Badge>
  }
  if (bucket !== 'normal') {
    return <Badge tone="amber">ล่าช้า {daysLate} วัน</Badge>
  }
  return <Badge tone="green">ผ่อนปกติ</Badge>
}

export default function AllCustomers() {
  const { data, loading } = useAsync(
    async () => {
      const [contracts, shops, statuses, installments] = await Promise.all([
        getContracts(),
        getShops(),
        getAllStatuses(),
        getAllInstallments(),
      ])
      return { contracts, shops, statuses, installments }
    },
    { contracts: [], shops: [], statuses: [], installments: [] },
  )

  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [bucketFilter, setBucketFilter] = useState<OverdueBucket | 'overdue' | ''>(() => {
    const p = searchParams.get('bucket')
    if (p === 'overdue') return 'overdue'
    if (p && (BUCKET_OPTS as string[]).includes(p)) return p as OverdueBucket
    return ''
  })
  const [shopFilter, setShopFilter] = useState('')
  const [modelFilter, setModelFilter] = useState('')

  // ----- ดัชนีช่วยค้นหา -----
  const shopName = (id: string) => data.shops.find((s) => s.id === id)?.name ?? '-'
  const statusBy = useMemo(
    () => new Map(data.statuses.map((s) => [s.contractId, s])),
    [data.statuses],
  )
  // ความคืบหน้างวด: ชำระแล้ว = งวดที่ปิด (paidAt != null) / ทั้งหมด = จำนวนงวดในตาราง
  const progressBy = useMemo(() => {
    const m = new Map<string, { paid: number; total: number }>()
    for (const ins of data.installments) {
      const cur = m.get(ins.contractId) ?? { paid: 0, total: 0 }
      cur.total++
      if (ins.paidAt) cur.paid++
      m.set(ins.contractId, cur)
    }
    return m
  }, [data.installments])

  // รุ่นทั้งหมดที่มีจริง (สำหรับดรอปดาวน์)
  const models = useMemo(() => {
    const set = new Set<string>()
    for (const c of data.contracts) if (c.model) set.add(c.model)
    return [...set].sort()
  }, [data.contracts])

  // ----- กรอง + ค้นหา -----
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return data.contracts.filter((c) => {
      if (statusFilter && c.status !== statusFilter) return false
      if (bucketFilter) {
        const b = statusBy.get(c.id)?.bucket ?? 'normal'
        if (bucketFilter === 'overdue' ? b === 'normal' : b !== bucketFilter) return false
      }
      if (shopFilter && c.shopId !== shopFilter) return false
      if (modelFilter && c.model !== modelFilter) return false
      if (q) {
        const hay = [
          c.contractNo,
          c.invNo,
          c.customerName,
          shopName(c.shopId),
          c.model,
          c.sn,
          c.imei,
          c.nationalId,
          c.phone,
        ]
          .join(' ')
          .toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.contracts, query, statusFilter, bucketFilter, shopFilter, modelFilter, statusBy])

  const hasFilter = !!(query || statusFilter || bucketFilter || shopFilter || modelFilter)
  const clearAll = () => {
    setQuery('')
    setStatusFilter('')
    setBucketFilter('')
    setShopFilter('')
    setModelFilter('')
  }

  return (
    <div>
      <PageTitle count={loading ? undefined : { shown: rows.length, total: data.contracts.length }}>
        ลูกค้าทั้งหมด
      </PageTitle>

      {loading ? (
        <Loading />
      ) : (
        <>
          {/* แถบค้นหา + ตัวกรอง */}
          <div className="mb-4 flex flex-col gap-3">
            <div className="relative">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ค้นหา เลขสัญญา / INV / ชื่อลูกค้า / ร้าน / รุ่น / SN / IMEI / เลขบัตร / เบอร์โทร"
                className="pl-9"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="!w-auto min-w-[140px]">
                <option value="">ทุกสถานะ</option>
                {STATUS_OPTS.map((s) => (
                  <option key={s} value={s}>{statusLabel(s)}</option>
                ))}
              </Select>
              <Select value={bucketFilter} onChange={(e) => setBucketFilter(e.target.value as OverdueBucket | 'overdue' | '')} className="!w-auto min-w-[140px]">
                <option value="">ทุกความล่าช้า</option>
                <option value="overdue">ล่าช้าทั้งหมด</option>
                {BUCKET_OPTS.map((b) => (
                  <option key={b} value={b}>{BUCKET_LABEL[b]}</option>
                ))}
              </Select>
              <Select value={shopFilter} onChange={(e) => setShopFilter(e.target.value)} className="!w-auto min-w-[140px]">
                <option value="">ทุกร้าน</option>
                {data.shops.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
              <Select value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} className="!w-auto min-w-[140px]">
                <option value="">ทุกรุ่น</option>
                {models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </Select>
              {hasFilter && (
                <button
                  onClick={clearAll}
                  className="inline-flex items-center gap-1 rounded-lg border border-peach px-2.5 py-1.5 text-xs text-ink-soft hover:bg-peach-light"
                >
                  <X size={13} /> ล้างตัวกรอง
                </button>
              )}
            </div>
          </div>

          {rows.length === 0 ? (
            <p className="rounded-xl bg-peach-light/40 px-4 py-6 text-center text-sm text-ink-soft">
              ไม่พบรายการที่ตรงกับเงื่อนไข
            </p>
          ) : (
            <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
              <table className="w-full min-w-[980px] border-collapse text-sm">
                <thead>
                  <tr className="bg-peach-light text-left text-ink">
                    {['วันที่', 'เลขที่สัญญา', 'ชื่อลูกค้า', 'ร้านค้า', 'สถานะ', 'รุ่น', 'ค่างวด', 'ความคืบหน้า', ''].map((h, i) => (
                      <th key={h || i} className="whitespace-nowrap px-3 py-2.5 font-semibold">{h}</th>
                    ))}
                  </tr>
                </thead>
                {rows.map((c, i) => {
                    const st = statusBy.get(c.id)
                    const pr = progressBy.get(c.id) ?? { paid: 0, total: c.termMonths || 0 }
                    const pct = pr.total > 0 ? Math.round((pr.paid / pr.total) * 100) : 0
                    const zebra = i % 2 ? 'bg-white' : 'bg-peach-light/20'
                    return (
                      <tbody key={c.id} className="border-b border-peach/60">
                        <tr className={zebra}>
                          <td className="whitespace-nowrap px-3 pt-2.5 align-top">{thaiDate(c.transactionDate)}</td>
                          <td className="whitespace-nowrap px-3 pt-2.5 align-top">
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium">{c.contractNo}</span>
                              {c.emailSentAt && (
                                <span
                                  className="shrink-0 text-ink-soft"
                                  title={`ส่งอีเมลแล้วเมื่อ ${thaiDate(c.emailSentAt.slice(0, 10))} โดย ${c.emailSentBy ?? 'ไม่ทราบ'}`}
                                >
                                  <Mail className="h-3 w-3" />
                                </span>
                              )}
                              {c.summarySentAt && (
                                <span
                                  className="shrink-0 text-ink-soft"
                                  title={`สรุปยอดแล้วเมื่อ ${thaiDate(c.summarySentAt.slice(0, 10))} โดย ${c.summarySentBy ?? 'ไม่ทราบ'}`}
                                >
                                  <FileCheck className="h-3 w-3" />
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-3 pt-2.5 align-top">
                            <button
                              onClick={() => navigate(`/contract/${c.id}`)}
                              className="font-medium text-salmon-deep hover:underline"
                            >
                              {c.customerName}
                            </button>
                          </td>
                          <td className="whitespace-nowrap px-3 pt-2.5 align-top">{shopName(c.shopId)}</td>
                          <td className="whitespace-nowrap px-3 pt-2.5 align-top">
                            <StatusPills contract={c} st={st} />
                          </td>
                          <td className="whitespace-nowrap px-3 pt-2.5 align-top">{c.model} {c.storage}</td>
                          <td className="whitespace-nowrap px-3 pt-2.5 text-right align-top">{baht(c.monthlyPayment)}</td>
                          <td className="whitespace-nowrap px-3 pt-2.5 align-top">
                            <div className="flex items-center gap-2">
                              <span className="tabular-nums text-ink">{pr.paid}/{pr.total}</span>
                              <span className="h-1.5 w-16 overflow-hidden rounded-full bg-peach-light">
                                <span className="block h-full rounded-full bg-salmon-deep" style={{ width: `${pct}%` }} />
                              </span>
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-3 pt-2.5 align-top">
                            <button
                              onClick={() => navigate(`/edit/${c.id}`)}
                              className="inline-flex items-center gap-1 rounded-lg border border-peach px-2.5 py-1 text-xs text-ink-soft hover:bg-peach-light"
                            >
                              <Pencil size={13} /> แก้ไข
                            </button>
                          </td>
                        </tr>
                        <tr className={zebra}>
                          <td />
                          <td colSpan={8} className="px-3 pb-2.5 pt-0.5 text-xs text-ink-soft">
                            <span className="mr-3">บัตร: {maskNationalId(c.nationalId)}</span>
                            <span className="mr-3">IMEI: {c.imei || '—'}</span>
                            <span className="mr-3">SN: {c.sn || '—'}</span>
                            <span>INV: {c.invNo || '—'}</span>
                          </td>
                        </tr>
                      </tbody>
                    )
                  })}
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
