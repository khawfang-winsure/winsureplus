import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Copy,
  Italic,
  MailCheck,
  MapPin,
  Printer,
  Search,
  Underline,
} from 'lucide-react'
import { Badge, Button, Card, Loading, Modal, PageTitle } from '../components/ui'
import { AddressFields } from '../components/AddressFields'
import Pagination from '../components/Pagination'
import { useAuth } from '../lib/auth'
import {
  getAllAddresses,
  getAllLetters,
  getAllStatuses,
  getContracts,
  getLetterOutcomeByRound,
  getLetterOutcomeSummary,
  getLetterTemplate,
  insertLetter,
  saveAddress,
  saveLetterTemplate,
  updateLetterReply,
  type ContractAddresses,
} from '../lib/db'
import {
  ADDRESS_KIND_LABEL,
  addressOneLine,
  fillLetterTemplate,
  isAddressEmpty,
  nextLetterAction,
  REPLY_LABEL,
  type AddressKind,
  type CustomerAddress,
  type LetterRecord,
  type LetterStage,
} from '../lib/letters'
import type { FieldItem } from './FieldVisitPrint'
import type {
  Contract,
  ContractStatusRow,
  LetterOutcomeByRound,
  LetterOutcomeSummary,
} from '../lib/types'

const baht = (n: number) => n.toLocaleString('th-TH')
function thaiDateFull(): string {
  const d = new Date()
  return `${d.getDate()} ${['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'][d.getMonth()]} ${d.getFullYear() + 543}`
}

type TabKey = 'send' | 'wait' | 'registry' | 'field'
type SendStage = { kind: 'send'; round: 1 | 2 | 3; addressKind: 'current' | 'id_card' | 'registry' }

interface Row {
  status: ContractStatusRow
  contract?: Contract
  addresses: ContractAddresses
  episodeKey: string
  lettersThisEpisode: LetterRecord[]
  stage: LetterStage
  amount: number
}

export default function Letters() {
  const navigate = useNavigate()
  const { role } = useAuth()
  const isAdmin = role === 'admin'
  const [statuses, setStatuses] = useState<ContractStatusRow[]>([])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [letters, setLetters] = useState<LetterRecord[]>([])
  const [addresses, setAddresses] = useState<Record<string, ContractAddresses>>({})
  const [template, setTemplate] = useState('')
  const [outcomeSummary, setOutcomeSummary] = useState<LetterOutcomeSummary | null>(null)
  const [outcomeByRound, setOutcomeByRound] = useState<LetterOutcomeByRound[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [registryFor, setRegistryFor] = useState<Row | null>(null)
  const [showTpl, setShowTpl] = useState(false)
  // ตัวกรอง
  const [tab, setTab] = useState<TabKey>('send')
  const [search, setSearch] = useState('')
  const [shopFilter, setShopFilter] = useState('all')
  const [onlyWithAddr, setOnlyWithAddr] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const [st, c, lt, ad, tpl, outSum, outRound] = await Promise.all([
        getAllStatuses(),
        getContracts(),
        getAllLetters(),
        getAllAddresses(),
        getLetterTemplate(),
        isAdmin ? getLetterOutcomeSummary() : Promise.resolve(null),
        isAdmin ? getLetterOutcomeByRound() : Promise.resolve([]),
      ])
      setStatuses(st)
      setContracts(c)
      setLetters(lt)
      setAddresses(ad)
      setTemplate(tpl)
      setOutcomeSummary(outSum)
      setOutcomeByRound(outRound)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin])

  const rows = useMemo<Row[]>(() => {
    const cById = new Map(contracts.map((c) => [c.id, c]))
    const out: Row[] = []
    for (const s of statuses) {
      if (s.status !== 'active' || !s.nextDue) continue
      const episodeKey = s.nextDue.slice(0, 10)
      const lettersThisEpisode = letters.filter((l) => l.contractId === s.contractId && l.episodeKey === episodeKey)
      const addr = addresses[s.contractId] ?? {}
      const stage = nextLetterAction(lettersThisEpisode, s.daysLate, !isAddressEmpty(addr.registry))
      if (stage.kind === 'none') continue
      const c = cById.get(s.contractId)
      const amount = s.overdueAmount + s.penaltyDue
      out.push({ status: s, contract: c, addresses: addr, episodeKey, lettersThisEpisode, stage, amount })
    }
    return out.sort((a, b) => b.status.daysLate - a.status.daysLate)
  }, [statuses, contracts, letters, addresses])

  const allByTab: Record<TabKey, Row[]> = {
    send: rows.filter((r) => r.stage.kind === 'send'),
    wait: rows.filter((r) => r.stage.kind === 'waiting-reply'),
    registry: rows.filter((r) => r.stage.kind === 'registry-search'),
    field: rows.filter((r) => r.stage.kind === 'field-visit'),
  }

  const shopOptions = useMemo(() => {
    const m = new Map<string, string>()
    rows.forEach((r) => m.set(r.status.shopId, r.status.shopName))
    return [...m.entries()]
  }, [rows])

  const addrFor = (r: Row, kind: 'current' | 'id_card' | 'registry') => r.addresses[kind]
  const hasAddr = (r: Row) =>
    r.stage.kind === 'send' && !isAddressEmpty(addrFor(r, (r.stage as SendStage).addressKind))

  // กรองตามแท็บ + ค้นหา + ร้าน
  const visibleRows = useMemo(() => {
    let base = allByTab[tab]
    const q = search.trim().toLowerCase()
    if (q) base = base.filter((r) => (r.status.customerName + ' ' + r.status.contractNo).toLowerCase().includes(q))
    if (shopFilter !== 'all') base = base.filter((r) => r.status.shopId === shopFilter)
    if (tab === 'send' && onlyWithAddr) base = base.filter(hasAddr)
    return base
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, tab, search, shopFilter, onlyWithAddr])

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)

  useEffect(() => { setPage(1) }, [tab, search, shopFilter, onlyWithAddr])

  const pagedRows = useMemo(
    () => visibleRows.slice((page - 1) * pageSize, page * pageSize),
    [visibleRows, page, pageSize],
  )

  // ส่ง = เลือกได้เฉพาะที่มีที่อยู่; ลงพื้นที่ = เลือกได้ทุกราย
  // selectableIds ขอบเขตเฉพาะหน้าปัจจุบัน (pagedRows) — "select all" = เลือกทุกแถวในหน้านี้
  const selectableIds = (tab === 'send' ? pagedRows.filter(hasAddr) : tab === 'field' ? pagedRows : [])
    .map((r) => r.status.contractId)
  const allPageSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id))
  const selectedSendCount = [...selected].filter((id) => allByTab.send.some((r) => r.status.contractId === id)).length
  const selectedFieldCount = [...selected].filter((id) => allByTab.field.some((r) => r.status.contractId === id)).length

  function toggleSelect(id: string, on: boolean) {
    setSelected((prev) => {
      const n = new Set(prev)
      on ? n.add(id) : n.delete(id)
      return n
    })
  }
  function toggleSelectPage(on: boolean) {
    setSelected((prev) => {
      const n = new Set(prev)
      selectableIds.forEach((id) => (on ? n.add(id) : n.delete(id)))
      return n
    })
  }

  function printSelected() {
    const date = thaiDateFull()
    const items = allByTab.send
      .filter((r) => selected.has(r.status.contractId))
      .map((r) => {
        const st = r.stage as SendStage
        const lines = addressOneLine(addrFor(r, st.addressKind))
        return {
          contractNo: r.status.contractNo,
          customerName: r.status.customerName,
          round: st.round,
          addressKindLabel: ADDRESS_KIND_LABEL[st.addressKind],
          addressLines: lines,
          primaryPhone: r.contract?.phone || '',
          body: fillLetterTemplate(template, {
            name: r.status.customerName,
            address: lines,
            contractNo: r.status.contractNo,
            amount: baht(r.amount),
            daysLate: r.status.daysLate,
            date,
          }),
        }
      })
      .filter((it) => it.addressLines.trim())
    if (items.length === 0) {
      alert('ไม่มีรายการที่มีที่อยู่ให้ปริ้น')
      return
    }
    sessionStorage.setItem('letters_print', JSON.stringify(items))
    navigate('/letters/print')
  }

  // ---------- ลงพื้นที่: รวมข้อมูลทุกที่อยู่ + จัดโซนจังหวัด ----------
  function buildFieldItems(): FieldItem[] {
    const KINDS: AddressKind[] = ['current', 'id_card', 'work', 'registry']
    return allByTab.field
      .filter((r) => selected.has(r.status.contractId))
      .map((r) => {
        const c = r.contract
        const a = r.addresses
        const province =
          a.current?.province || a.id_card?.province || a.work?.province || a.registry?.province || '(ไม่ระบุจังหวัด)'
        return {
          customerName: r.status.customerName,
          contractNo: r.status.contractNo,
          shopName: r.status.shopName,
          daysLate: r.status.daysLate,
          amount: r.amount,
          device: [c?.model, c?.storage].filter(Boolean).join(' '),
          phones: [c?.phone, c?.phoneAlt1, c?.phoneAlt2].filter(Boolean) as string[],
          province,
          addresses: KINDS.filter((k) => !isAddressEmpty(a[k])).map((k) => ({
            label: ADDRESS_KIND_LABEL[k],
            line: addressOneLine(a[k]),
          })),
        }
      })
  }

  function printField() {
    const items = buildFieldItems()
    if (!items.length) return alert('เลือกรายการก่อนนะคะ')
    sessionStorage.setItem('field_print', JSON.stringify(items))
    navigate('/letters/field')
  }

  async function copyField() {
    const items = buildFieldItems()
    if (!items.length) return alert('เลือกรายการก่อนนะคะ')
    const byProv = new Map<string, FieldItem[]>()
    for (const it of items) (byProv.get(it.province) ?? byProv.set(it.province, []).get(it.province)!).push(it)
    let text = ''
    for (const [prov, list] of byProv) {
      text += `=== โซน: จังหวัด${prov} (${list.length} ราย) ===\n`
      list.forEach((it, i) => {
        text += `${i + 1}. ${it.customerName} | สัญญา ${it.contractNo} | ${it.shopName}\n`
        text += `   เครื่อง: ${it.device || '—'} | โทร: ${it.phones.join(' / ') || '—'}\n`
        text += `   ล่าช้า ${it.daysLate} วัน | ค้าง ${baht(it.amount)} บาท\n`
        it.addresses.forEach((ad) => (text += `   - ${ad.label}: ${ad.line}\n`))
        text += '\n'
      })
    }
    try {
      await navigator.clipboard.writeText(text.trim())
      alert('คัดลอกแล้ว ✅ วางใน LINE/แชทส่งให้คนลงพื้นที่ได้เลย')
    } catch {
      alert('คัดลอกไม่สำเร็จ (เบราว์เซอร์ไม่อนุญาต)')
    }
  }

  async function recordSend(r: Row) {
    if (r.stage.kind !== 'send') return
    const st = r.stage
    const a = addrFor(r, st.addressKind)
    if (isAddressEmpty(a)) return alert(`ยังไม่มี${ADDRESS_KIND_LABEL[st.addressKind]}`)
    const tracking = window.prompt(`บันทึกส่งจดหมายครั้งที่ ${st.round} (${ADDRESS_KIND_LABEL[st.addressKind]})\nใส่เลขพัสดุ:`)
    if (tracking == null) return
    await insertLetter({
      contractId: r.status.contractId,
      episodeKey: r.episodeKey,
      round: st.round,
      addressKind: st.addressKind,
      recipientSnapshot: addressOneLine(a),
      trackingNo: tracking.trim() || undefined,
    })
    await load()
  }

  async function setReply(r: Row, reply: 'replied' | 'no_reply') {
    const pending = r.lettersThisEpisode.find((l) => l.reply === 'pending')
    if (!pending) return
    await updateLetterReply(pending.id, reply)
    await load()
  }

  if (loading) return <Loading />

  const TABS: { key: TabKey; label: string }[] = [
    { key: 'send', label: 'ถึงคิวส่ง' },
    { key: 'wait', label: 'รอผลตอบกลับ' },
    { key: 'registry', label: 'ค้นทะเบียนราษฎร์' },
    { key: 'field', label: 'เตรียมลงพื้นที่' },
  ]

  return (
    <div className="space-y-4 pb-20">
      <PageTitle sub="ส่งจดหมายตามรอบ — ล่าช้า 10 วัน (ครั้งที่ 1) / 20 วัน (ครั้งที่ 2)" count={loading ? undefined : { shown: visibleRows.length, total: rows.length }}>ส่งจดหมาย</PageTitle>

      {/* วัดผลจดหมาย (ผู้บริหารเท่านั้น) */}
      {isAdmin && <LetterOutcomeSection summary={outcomeSummary} byRound={outcomeByRound} />}

      {/* แท็บสเตจ + ตัวนับ */}
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => {
          const n = allByTab[t.key].length
          const active = tab === t.key
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-xl border px-3 py-2 text-sm font-medium transition ${
                active ? 'border-salmon-deep bg-salmon-deep text-white' : 'border-peach bg-white text-ink hover:bg-peach-light'
              }`}
            >
              {t.label}{' '}
              <span className={`ml-1 rounded-full px-1.5 text-xs ${active ? 'bg-white/25' : 'bg-peach-light text-ink-soft'}`}>
                {n}
              </span>
            </button>
          )
        })}
      </div>

      <Card>
        {/* แถบเครื่องมือ: ค้นหา + กรองร้าน + เลือกทั้งหน้า */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <Search size={15} className="absolute left-3 top-2.5 text-ink-soft" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ค้นหาชื่อ / เลขสัญญา"
              className="w-full rounded-xl border border-peach bg-white py-2 pl-9 pr-3 text-sm text-ink"
            />
          </div>
          <select
            value={shopFilter}
            onChange={(e) => setShopFilter(e.target.value)}
            className="rounded-xl border border-peach bg-white px-3 py-2 text-sm text-ink"
          >
            <option value="all">ทุกร้าน</option>
            {shopOptions.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
          {tab === 'send' && (
            <label className="flex items-center gap-1.5 text-sm text-ink-soft">
              <input type="checkbox" checked={onlyWithAddr} onChange={(e) => setOnlyWithAddr(e.target.checked)} />
              เฉพาะที่มีที่อยู่
            </label>
          )}
        </div>

        {visibleRows.length === 0 ? (
          <p className="rounded-xl bg-peach-light/40 px-4 py-6 text-center text-sm text-ink-soft">
            ไม่มีรายการในสเตจนี้
          </p>
        ) : (
          <>
          <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="bg-peach-light text-left text-ink">
                  {(tab === 'send' || tab === 'field') && (
                    <th className="px-3 py-2.5">
                      <input type="checkbox" checked={allPageSelected} onChange={(e) => toggleSelectPage(e.target.checked)} />
                    </th>
                  )}
                  <th className="px-3 py-2.5 font-semibold">ลูกค้า / สัญญา</th>
                  <th className="px-3 py-2.5 font-semibold">ล่าช้า</th>
                  {tab === 'send' && <th className="px-3 py-2.5 font-semibold">รอบ → ที่อยู่</th>}
                  {tab === 'send' && <th className="px-3 py-2.5 text-right font-semibold">ยอดค้าง</th>}
                  {tab === 'wait' && <th className="px-3 py-2.5 font-semibold">สถานะ</th>}
                  {tab === 'field' && <th className="px-3 py-2.5 font-semibold">จังหวัด (โซน)</th>}
                  {tab === 'field' && <th className="px-3 py-2.5 text-right font-semibold">ยอดค้าง</th>}
                  <th className="px-3 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((r) => (
                  <RowView
                    key={r.status.contractId}
                    r={r}
                    tab={tab}
                    selected={selected.has(r.status.contractId)}
                    onSelect={(on) => toggleSelect(r.status.contractId, on)}
                    onRecordSend={() => recordSend(r)}
                    onReply={(v) => setReply(r, v)}
                    onRegistry={() => setRegistryFor(r)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            total={visibleRows.length}
            page={page}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
          />
          </>
        )}
      </Card>

      {/* ข้อความจดหมาย */}
      <Card>
        <button onClick={() => setShowTpl((v) => !v)} className="flex w-full items-center justify-between text-left">
          <span className="font-semibold text-ink">ข้อความจดหมาย (แก้ไขได้)</span>
          <span className="text-sm text-salmon-deep">{showTpl ? 'ซ่อน' : 'แก้ไข'}</span>
        </button>
        {showTpl && <TemplateEditor template={template} onSaved={setTemplate} />}
      </Card>

      {/* แถบปริ้นลอยล่าง */}
      {tab === 'send' && selectedSendCount > 0 && (
        <div className="fixed bottom-5 left-1/2 z-20 -translate-x-1/2">
          <Button onClick={printSelected} className="shadow-lg">
            <Printer size={16} /> ปริ้นที่เลือก ({selectedSendCount})
          </Button>
        </div>
      )}
      {tab === 'field' && selectedFieldCount > 0 && (
        <div className="fixed bottom-5 left-1/2 z-20 flex -translate-x-1/2 gap-2">
          <Button onClick={printField} className="shadow-lg">
            <Printer size={16} /> ปริ้นข้อมูลลงพื้นที่ ({selectedFieldCount})
          </Button>
          <Button variant="ghost" onClick={copyField} className="bg-white shadow-lg">
            <Copy size={16} /> คัดลอกข้อมูล
          </Button>
        </div>
      )}

      {registryFor && (
        <RegistryModal
          row={registryFor}
          onClose={() => setRegistryFor(null)}
          onSaved={async () => {
            setRegistryFor(null)
            await load()
          }}
        />
      )}
    </div>
  )
}

// ===== วัดผลจดหมาย — จดหมายได้ผลแค่ไหน =====
function LetterOutcomeSection({
  summary,
  byRound,
}: {
  summary: LetterOutcomeSummary | null
  byRound: LetterOutcomeByRound[]
}) {
  const empty = !summary || summary.totalLetters === 0

  return (
    <Card>
      <div className="mb-4 flex items-start gap-2">
        <MailCheck size={18} className="mt-0.5 shrink-0 text-salmon-deep" />
        <div>
          <h2 className="text-base font-bold text-ink">วัดผลจดหมาย — จดหมายได้ผลแค่ไหน</h2>
          <p className="text-sm text-ink-soft">
            หลังส่งจดหมายแต่ละฉบับ ลูกค้ากลับมาจ่ายหรือคืนเครื่องก่อนถึงจดหมายฉบับถัดไปหรือไม่
          </p>
        </div>
      </div>

      {empty ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          ยังไม่มีข้อมูล — รายงานจะแสดงเมื่อเริ่มบันทึกการส่งจดหมายในระบบ
        </div>
      ) : (
        <div className="space-y-5">
          {/* การ์ดสรุป */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <div className="rounded-xl border border-peach bg-peach-light/40 px-4 py-3 text-center sm:col-span-3 lg:col-span-1">
              <div className="text-3xl font-bold text-salmon-deep">
                {summary.effectivenessPct.toLocaleString('th-TH')}%
              </div>
              <div className="mt-1 text-xs text-ink-soft">จดหมายได้ผล</div>
            </div>
            <div className="rounded-xl border border-peach bg-white px-4 py-3 text-center">
              <div className="text-2xl font-bold text-ink">
                {summary.totalLetters.toLocaleString('th-TH')}
              </div>
              <div className="mt-1 text-xs text-ink-soft">✉️ ส่งทั้งหมด</div>
            </div>
            <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-center">
              <div className="text-2xl font-bold text-green-700">
                {summary.paidCount.toLocaleString('th-TH')}
              </div>
              <div className="mt-1 text-xs text-green-700/80">✅ ลูกค้าจ่าย</div>
            </div>
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-center">
              <div className="text-2xl font-bold text-blue-700">
                {summary.returnedCount.toLocaleString('th-TH')}
              </div>
              <div className="mt-1 text-xs text-blue-700/80">📦 คืนเครื่อง</div>
            </div>
            <div className="rounded-xl border border-peach bg-white px-4 py-3 text-center">
              <div className="text-2xl font-bold text-ink-soft">
                {summary.noResponseCount.toLocaleString('th-TH')}
              </div>
              <div className="mt-1 text-xs text-ink-soft">ไม่ตอบ</div>
            </div>
            <div className="rounded-xl border border-peach bg-white px-4 py-3 text-center">
              <div className="text-2xl font-bold text-ink">
                {summary.avgDaysToOutcome.toLocaleString('th-TH')}
              </div>
              <div className="mt-1 text-xs text-ink-soft">เฉลี่ย (วัน)</div>
            </div>
          </div>

          {/* ตารางแยกครั้งที่ส่ง */}
          {byRound.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-bold text-ink">แยกตามครั้งที่ส่ง</h3>
              <div className="scrollbar-thin overflow-x-auto rounded-2xl border border-peach">
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="bg-peach-light text-left text-ink">
                      <th className="px-3 py-2.5 font-semibold">ครั้งที่</th>
                      <th className="px-3 py-2.5 text-right font-semibold">ส่ง</th>
                      <th className="px-3 py-2.5 text-right font-semibold">จ่าย</th>
                      <th className="px-3 py-2.5 text-right font-semibold">คืนเครื่อง</th>
                      <th className="px-3 py-2.5 text-right font-semibold">ไม่ตอบ</th>
                      <th className="px-3 py-2.5 text-right font-semibold">ได้ผล %</th>
                      <th className="px-3 py-2.5 text-right font-semibold">เฉลี่ย (วัน)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byRound.map((r) => {
                      const sent = r.paidCount + r.returnedCount + r.noResponseCount
                      return (
                        <tr key={r.round} className="border-t border-peach/60">
                          <td className="px-3 py-2.5 font-medium text-ink">ครั้งที่ {r.round}</td>
                          <td className="px-3 py-2.5 text-right text-ink">{sent.toLocaleString('th-TH')}</td>
                          <td className="px-3 py-2.5 text-right text-green-700">{r.paidCount.toLocaleString('th-TH')}</td>
                          <td className="px-3 py-2.5 text-right text-blue-700">{r.returnedCount.toLocaleString('th-TH')}</td>
                          <td className="px-3 py-2.5 text-right text-ink-soft">{r.noResponseCount.toLocaleString('th-TH')}</td>
                          <td className="px-3 py-2.5 text-right font-semibold text-salmon-deep">{r.effectivenessPct.toLocaleString('th-TH')}%</td>
                          <td className="px-3 py-2.5 text-right text-ink">{r.avgDaysToOutcome.toLocaleString('th-TH')}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

function RowView({
  r,
  tab,
  selected,
  onSelect,
  onRecordSend,
  onReply,
  onRegistry,
}: {
  r: Row
  tab: TabKey
  selected: boolean
  onSelect: (on: boolean) => void
  onRecordSend: () => void
  onReply: (v: 'replied' | 'no_reply') => void
  onRegistry: () => void
}) {
  const st = r.stage
  const sendSt = st.kind === 'send' ? (st as SendStage) : null
  const noAddr = sendSt ? isAddressEmpty(r.addresses[sendSt.addressKind]) : false
  const pending = r.lettersThisEpisode.find((l) => l.reply === 'pending')
  const a = r.addresses
  const fieldProvince =
    a.current?.province || a.id_card?.province || a.work?.province || a.registry?.province || '(ไม่ระบุ)'
  return (
    <tr className="border-t border-peach/60 align-top">
      {(tab === 'send' || tab === 'field') && (
        <td className="px-3 py-2.5">
          <input
            type="checkbox"
            checked={selected}
            disabled={tab === 'send' && noAddr}
            onChange={(e) => onSelect(e.target.checked)}
          />
        </td>
      )}
      <td className="px-3 py-2.5">
        <p className="font-medium text-ink">{r.status.customerName}</p>
        <p className="text-xs text-ink-soft">{r.status.contractNo} · {r.status.shopName}</p>
      </td>
      <td className="px-3 py-2.5">
        <Badge tone="red">{r.status.daysLate} วัน</Badge>
      </td>

      {tab === 'send' && sendSt && (
        <td className="px-3 py-2.5">
          <span className="font-medium text-ink">ครั้งที่ {sendSt.round}</span> ▸ {ADDRESS_KIND_LABEL[sendSt.addressKind]}
          {noAddr ? (
            <p className="text-xs text-red-600">⚠️ ยังไม่มีที่อยู่</p>
          ) : (
            <p className="text-xs text-ink-soft">{addressOneLine(r.addresses[sendSt.addressKind])}</p>
          )}
        </td>
      )}
      {tab === 'send' && <td className="px-3 py-2.5 text-right">{baht(r.amount)} ฿</td>}

      {tab === 'wait' && (
        <td className="px-3 py-2.5 text-ink-soft">
          ส่งครั้งที่ {(st as { round: 1 | 2 | 3 }).round} · พัสดุ {pending?.trackingNo || '—'} · {REPLY_LABEL.pending}
        </td>
      )}
      {tab === 'field' && (
        <td className="px-3 py-2.5">
          {fieldProvince}
          <span className="ml-1 text-xs text-ink-soft">({r.addresses ? Object.values(r.addresses).filter((x) => !isAddressEmpty(x)).length : 0} ที่อยู่)</span>
        </td>
      )}
      {tab === 'field' && <td className="px-3 py-2.5 text-right">{baht(r.amount)} ฿</td>}

      <td className="px-3 py-2.5 text-right">
        {tab === 'send' && (
          <button onClick={onRecordSend} disabled={noAddr} className="rounded-lg border border-peach px-2.5 py-1 text-xs text-ink hover:bg-peach-light disabled:opacity-40">
            ✓ บันทึกส่ง
          </button>
        )}
        {tab === 'wait' && (
          <div className="flex justify-end gap-1.5">
            <button onClick={() => onReply('replied')} className="rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100">ตอบกลับ</button>
            <button onClick={() => onReply('no_reply')} className="rounded-lg bg-red-50 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-100">ไม่ตอบ</button>
          </div>
        )}
        {tab === 'registry' && (
          <button onClick={onRegistry} className="rounded-lg border border-peach px-2.5 py-1 text-xs text-ink hover:bg-peach-light">
            <MapPin size={13} className="mr-1 inline" /> กรอกที่อยู่ทะเบียน
          </button>
        )}
      </td>
    </tr>
  )
}

// แปลง plain text เดิม → HTML (แต่ละบรรทัด wrap ด้วย <div>, บรรทัดว่าง = <div><br></div>)
function plainTextToHtml(text: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.trim() === '' ? '<div><br></div>' : `<div>${esc(line)}</div>`))
    .join('')
}

// template ใน DB เป็น HTML แล้วหรือยัง (มี tag จริง)
function looksLikeHtml(s: string): boolean {
  return /<[a-z][\s\S]*>/i.test(s)
}

const TPL_VARS: { token: string; label: string }[] = [
  { token: '{{name}}', label: 'ชื่อลูกค้า' },
  { token: '{{date}}', label: 'วันที่' },
  { token: '{{amount}}', label: 'ยอดค้าง' },
  { token: '{{contractNo}}', label: 'เลขสัญญา' },
  { token: '{{address}}', label: 'ที่อยู่' },
  { token: '{{daysLate}}', label: 'วันที่ค้าง' },
]

function ToolbarButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  // ใช้ onMouseDown + preventDefault กัน contentEditable เสีย selection ก่อน execCommand
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => {
        e.preventDefault()
        onClick()
      }}
      className="flex h-8 min-w-8 items-center justify-center rounded-lg border border-peach bg-white px-2 text-sm text-ink transition hover:bg-peach-light"
    >
      {children}
    </button>
  )
}

function TemplateEditor({ template, onSaved }: { template: string; onSaved: (t: string) => void }) {
  const editorRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  // โหลดค่าเริ่มต้นเข้า contentEditable ครั้งเดียว (uncontrolled — React ไม่ยุ่งกับ DOM ภายใน)
  useEffect(() => {
    if (!editorRef.current) return
    editorRef.current.innerHTML = looksLikeHtml(template) ? template : plainTextToHtml(template)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function exec(command: string, value?: string) {
    editorRef.current?.focus()
    document.execCommand(command, false, value)
  }

  // แทรกข้อความ literal ณ ตำแหน่ง cursor (สำหรับปุ่มตัวแปร)
  function insertVar(token: string) {
    editorRef.current?.focus()
    document.execCommand('insertText', false, token)
  }

  async function save() {
    const html = editorRef.current?.innerHTML ?? ''
    setBusy(true)
    setMsg(null)
    try {
      await saveLetterTemplate(html)
      onSaved(html)
      setMsg('บันทึกแล้ว ✅')
    } catch (e) {
      setMsg('บันทึกไม่สำเร็จ: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3">
      <p className="mb-2 text-xs text-ink-soft">
        จัดรูปแบบด้วยปุ่มด้านล่าง แล้วกดบันทึก — ปุ่มตัวแปรจะแทรกค่าจริงตอนปริ้น
      </p>

      {/* แถบเครื่องมือจัดอักษร */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-xl border border-peach bg-peach-light/40 p-2">
        <ToolbarButton onClick={() => exec('bold')} title="ตัวหนา">
          <Bold size={15} />
        </ToolbarButton>
        <ToolbarButton onClick={() => exec('italic')} title="ตัวเอียง">
          <Italic size={15} />
        </ToolbarButton>
        <ToolbarButton onClick={() => exec('underline')} title="ขีดเส้นใต้">
          <Underline size={15} />
        </ToolbarButton>

        <span className="mx-1 h-5 w-px bg-peach" />

        <ToolbarButton onClick={() => exec('fontSize', '2')} title="ตัวเล็ก">
          <span className="text-xs font-semibold">เล็ก</span>
        </ToolbarButton>
        <ToolbarButton onClick={() => exec('fontSize', '3')} title="ตัวปกติ">
          <span className="text-sm font-semibold">ปกติ</span>
        </ToolbarButton>
        <ToolbarButton onClick={() => exec('fontSize', '5')} title="ตัวใหญ่">
          <span className="text-base font-semibold">ใหญ่</span>
        </ToolbarButton>

        <span className="mx-1 h-5 w-px bg-peach" />

        <ToolbarButton onClick={() => exec('justifyLeft')} title="ชิดซ้าย">
          <AlignLeft size={15} />
        </ToolbarButton>
        <ToolbarButton onClick={() => exec('justifyCenter')} title="กึ่งกลาง">
          <AlignCenter size={15} />
        </ToolbarButton>
        <ToolbarButton onClick={() => exec('justifyRight')} title="ชิดขวา">
          <AlignRight size={15} />
        </ToolbarButton>
      </div>

      {/* ปุ่มแทรกตัวแปร */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-ink-soft">แทรกตัวแปร:</span>
        {TPL_VARS.map((v) => (
          <button
            key={v.token}
            type="button"
            title={v.token}
            onMouseDown={(e) => {
              e.preventDefault()
              insertVar(v.token)
            }}
            className="rounded-lg border border-peach bg-white px-2 py-1 text-xs text-salmon-deep transition hover:bg-peach-light"
          >
            {v.label}
          </button>
        ))}
      </div>

      {/* กล่องแก้ไข rich text */}
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        className="min-h-[220px] w-full rounded-xl border border-peach bg-white p-3 text-sm leading-7 text-ink focus:outline-none focus:ring-2 focus:ring-salmon-deep/40"
      />

      <div className="mt-2 flex items-center gap-3">
        <Button onClick={save} disabled={busy}>{busy ? 'กำลังบันทึก...' : 'บันทึกข้อความ'}</Button>
        {msg && <span className="text-sm text-ink-soft">{msg}</span>}
      </div>
    </div>
  )
}

function RegistryModal({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const [addr, setAddr] = useState<CustomerAddress>(row.addresses.registry ?? {})
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true)
    try {
      await saveAddress(row.status.contractId, 'registry', addr)
      onSaved()
    } catch (e) {
      alert('บันทึกไม่สำเร็จ: ' + (e instanceof Error ? e.message : String(e)))
      setBusy(false)
    }
  }
  return (
    <Modal title={`ที่อยู่ทะเบียนราษฎร์ — ${row.status.customerName}`} onClose={onClose}>
      <AddressFields value={addr} onChange={(field, v) => setAddr((p) => ({ ...p, [field]: v }))} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
        <Button onClick={save} disabled={busy}>{busy ? 'กำลังบันทึก...' : 'บันทึกที่อยู่'}</Button>
      </div>
    </Modal>
  )
}
