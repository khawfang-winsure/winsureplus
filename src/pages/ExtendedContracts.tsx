import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarRange } from 'lucide-react'
import { Badge, Card, Loading, PageTitle, Select } from '../components/ui'
import { LineChart } from '../components/LineChart'
import { baht } from '../lib/format'
import { getAllExtensions, getAllStatuses, type ExtensionRecord, type ExtensionType } from '../lib/db'
import { EXT_TYPE_LABEL } from './ContractDetail'
import type { ContractStatusRow } from '../lib/types'

/** เวลาไทยแบบสั้น (วัน/เดือน/ปี เวลา) */
function thaiDateTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const time = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
  return `${dd}/${mm}/${d.getFullYear()} ${time}`
}

const TYPE_TONE: Record<ExtensionType, 'amber' | 'green' | 'red'> = {
  due_day: 'green',
  months: 'amber',
  both: 'red',
}

const TH_MON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']

/** สถานะปัจจุบันของลูกค้า (หนี้เสีย = ล่าช้า ≥ 60 วัน ฝั่งลูกค้า) */
function statusCell(st: ContractStatusRow | undefined) {
  if (!st) return <span className="text-ink-soft">—</span>
  if (st.status !== 'active') return <Badge tone="neutral">{st.status}</Badge>
  if (st.daysLate >= 60) return <Badge tone="red">หนี้เสีย ({st.daysLate} วัน)</Badge>
  if (st.daysLate > 0) return <Badge tone="amber">ล่าช้า {st.daysLate} วัน</Badge>
  return <Badge tone="green">ปกติ</Badge>
}

export default function ExtendedContracts() {
  const [rows, setRows] = useState<ExtensionRecord[]>([])
  const [statuses, setStatuses] = useState<ContractStatusRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | ExtensionType>('all')

  useEffect(() => {
    Promise.all([getAllExtensions(), getAllStatuses()])
      .then(([ext, st]) => {
        setRows(ext)
        setStatuses(st)
      })
      .finally(() => setLoading(false))
  }, [])

  const statusMap = useMemo(() => {
    const m = new Map<string, ContractStatusRow>()
    for (const s of statuses) m.set(s.contractId, s)
    return m
  }, [statuses])

  const isBadDebt = (contractId: string) => {
    const s = statusMap.get(contractId)
    return !!s && s.status === 'active' && s.daysLate >= 60
  }

  // สรุปนับตามประเภท
  const counts = useMemo(() => {
    const c = { all: rows.length, due_day: 0, months: 0, both: 0 } as Record<'all' | ExtensionType, number>
    for (const r of rows) c[r.extType]++
    return c
  }, [rows])

  // จำนวนสัญญา (ไม่ซ้ำ) ที่เคยขยาย และในนั้นกี่รายเป็นหนี้เสียตอนนี้
  const { uniqueContracts, badDebtCount } = useMemo(() => {
    const ids = new Set(rows.map((r) => r.contractId))
    let bad = 0
    for (const id of ids) if (isBadDebt(id)) bad++
    return { uniqueContracts: ids.size, badDebtCount: bad }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, statusMap])

  // กราฟแนวโน้มรายเดือน (12 เดือนล่าสุด): จำนวนการขยาย + จำนวนที่ตอนนี้เป็นหนี้เสีย
  const trend = useMemo(() => {
    const now = new Date()
    const keys: string[] = []
    const labels: string[] = []
    for (let k = 11; k >= 0; k--) {
      const d = new Date(now.getFullYear(), now.getMonth() - k, 1)
      keys.push(`${d.getFullYear()}-${d.getMonth()}`)
      labels.push(`${TH_MON[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`)
    }
    const total = new Map<string, number>()
    const bad = new Map<string, number>()
    for (const r of rows) {
      const d = new Date(r.createdAt)
      if (isNaN(d.getTime())) continue
      const key = `${d.getFullYear()}-${d.getMonth()}`
      total.set(key, (total.get(key) ?? 0) + 1)
      if (isBadDebt(r.contractId)) bad.set(key, (bad.get(key) ?? 0) + 1)
    }
    return {
      labels,
      totalValues: keys.map((k) => total.get(k) ?? 0),
      badValues: keys.map((k) => bad.get(k) ?? 0),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, statusMap])

  const filtered = filter === 'all' ? rows : rows.filter((r) => r.extType === filter)

  if (loading) {
    return (
      <div>
        <PageTitle>ลูกค้าขยายระยะเวลา</PageTitle>
        <Loading />
      </div>
    )
  }

  return (
    <div>
      <PageTitle count={{ shown: filtered.length, total: rows.length }}>ลูกค้าขยายระยะเวลา</PageTitle>

      {/* การ์ดสรุป */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          { l: 'รวมการขยายทั้งหมด', v: `${counts.all} ครั้ง`, sub: `${uniqueContracts} สัญญา` },
          { l: 'เปลี่ยนวันที่ชำระ', v: `${counts.due_day} ครั้ง`, sub: '' },
          { l: 'ขยายจำนวนงวด', v: `${counts.months} ครั้ง`, sub: '' },
          { l: 'เปลี่ยนวัน + ขยายงวด', v: `${counts.both} ครั้ง`, sub: '' },
          { l: 'ขยายแล้วเป็นหนี้เสีย', v: `${badDebtCount} สัญญา`, sub: 'ล่าช้า ≥ 60 วัน' },
        ].map((x) => (
          <Card key={x.l} className="py-3">
            <p className="text-xs text-ink-soft">{x.l}</p>
            <p className="text-lg font-bold text-ink">{x.v}</p>
            {x.sub && <p className="text-xs text-ink-soft">{x.sub}</p>}
          </Card>
        ))}
      </div>

      {/* กราฟแนวโน้มรายเดือน */}
      {rows.length > 0 && (
        <Card className="mb-4">
          <p className="mb-1 text-sm font-semibold text-ink">แนวโน้มการขยายระยะเวลา (12 เดือนล่าสุด)</p>
          <LineChart
            labels={trend.labels}
            valueSuffix=" ครั้ง"
            series={[
              { name: 'จำนวนการขยาย', color: '#f97316', values: trend.totalValues, fill: true },
              { name: 'ตอนนี้เป็นหนี้เสีย', color: '#dc2626', values: trend.badValues },
            ]}
          />
        </Card>
      )}

      {/* แถบกรอง */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-soft">แสดงเฉพาะ:</span>
        <div className="w-64">
          <Select value={filter} onChange={(e) => setFilter(e.target.value as 'all' | ExtensionType)}>
            <option value="all">ทุกประเภท ({counts.all})</option>
            <option value="due_day">เปลี่ยนวันที่ชำระ ({counts.due_day})</option>
            <option value="months">ขยายจำนวนงวด ({counts.months})</option>
            <option value="both">เปลี่ยนวัน + ขยายงวด ({counts.both})</option>
          </Select>
        </div>
        <span className="text-sm text-ink-soft">· {filtered.length} รายการ</span>
      </div>

      {filtered.length === 0 ? (
        <Card className="py-10 text-center text-ink-soft">
          <CalendarRange className="mx-auto mb-2 opacity-40" size={28} />
          {rows.length === 0 ? 'ยังไม่มีลูกค้าที่ขยายระยะเวลา' : 'ไม่มีรายการในประเภทที่เลือก'}
        </Card>
      ) : (
        <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
          <table className="w-full min-w-[960px] text-sm">
            <thead>
              <tr className="bg-peach-light text-left text-ink">
                {['เวลา', 'ลูกค้า', 'สัญญา', 'ประเภท', 'สถานะปัจจุบัน', 'วันชำระ', 'ค่างวด', 'จำนวนงวด', 'ยอดจัดไฟแนนซ์', 'ผู้ทำ'].map((h) => (
                  <th key={h} className="px-3 py-2.5 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, idx) => (
                <tr key={e.id} className={idx % 2 ? 'bg-white' : 'bg-peach-light/20'}>
                  <td className="px-3 py-2.5 whitespace-nowrap">{thaiDateTime(e.createdAt)}</td>
                  <td className="px-3 py-2.5">
                    <Link to={`/contract/${e.contractId}`} className="font-medium text-salmon-deep hover:underline">
                      {e.customerName || '—'}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">{e.contractNo || '—'}</td>
                  <td className="px-3 py-2.5"><Badge tone={TYPE_TONE[e.extType]}>{EXT_TYPE_LABEL[e.extType]}</Badge></td>
                  <td className="px-3 py-2.5">{statusCell(statusMap.get(e.contractId))}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap">{e.oldDueDay} → {e.newDueDay}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap">{baht(e.oldMonthly ?? 0)} → {baht(e.newMonthly ?? 0)}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    {e.oldTerm} → {e.newTerm} <span className="text-ink-soft">(+{e.newInstallments})</span>
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">{baht(e.oldFinance ?? 0)} → {baht(e.newFinance ?? 0)}</td>
                  <td className="px-3 py-2.5">{e.recordedByName || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
