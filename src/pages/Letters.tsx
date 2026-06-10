import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FileText, MailQuestion, MapPin, Printer, Search } from 'lucide-react'
import { Badge, Button, Card, Loading, Modal, PageTitle } from '../components/ui'
import { AddressFields } from '../components/AddressFields'
import {
  getAllAddresses,
  getAllInstallments,
  getAllLetters,
  getAllStatuses,
  getContracts,
  getLetterTemplate,
  insertLetter,
  saveAddress,
  saveLetterTemplate,
  updateLetterReply,
  type ContractAddresses,
  type InstallmentLite,
} from '../lib/db'
import {
  ADDRESS_KIND_LABEL,
  addressOneLine,
  fillLetterTemplate,
  isAddressEmpty,
  nextLetterAction,
  REPLY_LABEL,
  type CustomerAddress,
  type LetterRecord,
  type LetterStage,
} from '../lib/letters'
import type { Contract, ContractStatusRow } from '../lib/types'

const today = () => new Date().toISOString().slice(0, 10)
const baht = (n: number) => n.toLocaleString('th-TH')
function thaiDateFull(): string {
  const d = new Date()
  return `${d.getDate()} ${['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'][d.getMonth()]} ${d.getFullYear() + 543}`
}

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
  const [statuses, setStatuses] = useState<ContractStatusRow[]>([])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [installments, setInstallments] = useState<InstallmentLite[]>([])
  const [letters, setLetters] = useState<LetterRecord[]>([])
  const [addresses, setAddresses] = useState<Record<string, ContractAddresses>>({})
  const [template, setTemplate] = useState('')
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [registryFor, setRegistryFor] = useState<Row | null>(null)
  const [showTpl, setShowTpl] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const [st, c, ins, lt, ad, tpl] = await Promise.all([
        getAllStatuses(),
        getContracts(),
        getAllInstallments(),
        getAllLetters(),
        getAllAddresses(),
        getLetterTemplate(),
      ])
      setStatuses(st)
      setContracts(c)
      setInstallments(ins)
      setLetters(lt)
      setAddresses(ad)
      setTemplate(tpl)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
  }, [])

  const rows = useMemo<Row[]>(() => {
    const t = today()
    const cById = new Map(contracts.map((c) => [c.id, c]))
    const insByContract = new Map<string, InstallmentLite[]>()
    for (const i of installments) {
      const arr = insByContract.get(i.contractId)
      if (arr) arr.push(i)
      else insByContract.set(i.contractId, [i])
    }
    const out: Row[] = []
    for (const s of statuses) {
      if (s.status !== 'active' || !s.nextDue) continue
      const episodeKey = s.nextDue.slice(0, 10)
      const lettersThisEpisode = letters.filter((l) => l.contractId === s.contractId && l.episodeKey === episodeKey)
      const addr = addresses[s.contractId] ?? {}
      const stage = nextLetterAction(lettersThisEpisode, s.daysLate, !isAddressEmpty(addr.registry))
      if (stage.kind === 'none') continue
      const c = cById.get(s.contractId)
      const overdueCount = (insByContract.get(s.contractId) ?? []).filter(
        (i) => !i.paidAt && i.dueDate.slice(0, 10) <= t,
      ).length
      const amount = overdueCount * (c?.monthlyPayment ?? 0) + s.penaltyDue
      out.push({ status: s, contract: c, addresses: addr, episodeKey, lettersThisEpisode, stage, amount })
    }
    return out.sort((a, b) => b.status.daysLate - a.status.daysLate)
  }, [statuses, contracts, installments, letters, addresses])

  const sendRows = rows.filter((r) => r.stage.kind === 'send')
  const waitRows = rows.filter((r) => r.stage.kind === 'waiting-reply')
  const registryRows = rows.filter((r) => r.stage.kind === 'registry-search')
  const fieldRows = rows.filter((r) => r.stage.kind === 'field-visit')

  function addrFor(r: Row, kind: 'current' | 'id_card' | 'registry'): CustomerAddress | undefined {
    return r.addresses[kind]
  }

  // ---------- ปริ้นที่เลือก ----------
  function printSelected() {
    const date = thaiDateFull()
    const items = sendRows
      .filter((r) => selected.has(r.status.contractId) && r.stage.kind === 'send')
      .map((r) => {
        const st = r.stage as { kind: 'send'; round: 1 | 2 | 3; addressKind: 'current' | 'id_card' | 'registry' }
        const a = addrFor(r, st.addressKind)
        const lines = addressOneLine(a)
        const body = fillLetterTemplate(template, {
          name: r.status.customerName,
          address: lines,
          contractNo: r.status.contractNo,
          amount: baht(r.amount),
          daysLate: r.status.daysLate,
          date,
        })
        return {
          contractNo: r.status.contractNo,
          customerName: r.status.customerName,
          round: st.round,
          addressKindLabel: ADDRESS_KIND_LABEL[st.addressKind],
          addressLines: lines,
          body,
        }
      })
      .filter((it) => it.addressLines.trim()) // ข้ามตัวที่ไม่มีที่อยู่
    if (items.length === 0) {
      alert('ไม่มีรายการที่มีที่อยู่ให้ปริ้น — เลือกเคสที่มีที่อยู่ครบก่อนนะคะ')
      return
    }
    sessionStorage.setItem('letters_print', JSON.stringify(items))
    navigate('/letters/print')
  }

  // ---------- บันทึกส่ง (ใส่เลขพัสดุ → สร้างจดหมาย) ----------
  async function recordSend(r: Row) {
    if (r.stage.kind !== 'send') return
    const st = r.stage
    const a = addrFor(r, st.addressKind)
    if (isAddressEmpty(a)) {
      alert(`ยังไม่มี${ADDRESS_KIND_LABEL[st.addressKind]} — ไปเพิ่มในสัญญาก่อนนะคะ`)
      return
    }
    const tracking = window.prompt(`บันทึกส่งจดหมายครั้งที่ ${st.round} (${ADDRESS_KIND_LABEL[st.addressKind]})\nใส่เลขพัสดุเพื่อยืนยันว่าส่งจริง:`)
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

  // ---------- บันทึกผลตอบกลับ ----------
  async function setReply(r: Row, reply: 'replied' | 'no_reply') {
    const pending = r.lettersThisEpisode.find((l) => l.reply === 'pending')
    if (!pending) return
    await updateLetterReply(pending.id, reply)
    await load()
  }

  if (loading) return <Loading />

  return (
    <div className="space-y-5">
      <PageTitle sub="ส่งจดหมายติดตามหนี้ตามรอบ — ล่าช้า 10 วัน (ครั้งที่ 1) / 20 วัน (ครั้งที่ 2)">
        ส่งจดหมาย
      </PageTitle>

      {/* 1) ถึงคิวส่ง */}
      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FileText size={18} className="text-salmon-deep" />
            <h3 className="font-semibold text-ink">ถึงคิวส่งจดหมาย ({sendRows.length})</h3>
          </div>
          {sendRows.length > 0 && (
            <Button onClick={printSelected} disabled={selected.size === 0}>
              <Printer size={15} /> ปริ้นที่เลือก ({[...selected].filter((id) => sendRows.some((r) => r.status.contractId === id)).length})
            </Button>
          )}
        </div>
        {sendRows.length === 0 ? (
          <Empty text="ยังไม่มีเคสถึงคิวส่งจดหมาย" />
        ) : (
          <div className="flex flex-col gap-2">
            {sendRows.map((r) => {
              const st = r.stage as { kind: 'send'; round: 1 | 2 | 3; addressKind: 'current' | 'id_card' | 'registry' }
              const a = addrFor(r, st.addressKind)
              const noAddr = isAddressEmpty(a)
              const checked = selected.has(r.status.contractId)
              return (
                <div key={r.status.contractId} className="rounded-xl border border-peach bg-white px-3 py-2.5">
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={noAddr}
                      onChange={(e) =>
                        setSelected((prev) => {
                          const n = new Set(prev)
                          e.target.checked ? n.add(r.status.contractId) : n.delete(r.status.contractId)
                          return n
                        })
                      }
                      className="mt-1.5"
                    />
                    <div className="flex-1">
                      <p className="font-medium text-ink">
                        {r.status.customerName} — {r.status.contractNo}{' '}
                        <Badge tone="red">ล่าช้า {r.status.daysLate} วัน</Badge>
                      </p>
                      <p className="text-sm text-ink-soft">
                        ครั้งที่ <span className="font-semibold text-ink">{st.round}</span> →{' '}
                        {ADDRESS_KIND_LABEL[st.addressKind]} · ค้าง {baht(r.amount)} ฿
                      </p>
                      {noAddr ? (
                        <p className="text-xs text-red-600">⚠️ ยังไม่มี{ADDRESS_KIND_LABEL[st.addressKind]} — เพิ่มในสัญญาก่อน</p>
                      ) : (
                        <p className="text-xs text-ink-soft">{addressOneLine(a)}</p>
                      )}
                    </div>
                    <button
                      onClick={() => recordSend(r)}
                      disabled={noAddr}
                      className="shrink-0 rounded-lg border border-peach px-2.5 py-1 text-xs text-ink hover:bg-peach-light disabled:opacity-40"
                    >
                      ✓ บันทึกส่ง
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* 2) รอบันทึกผลตอบกลับ */}
      <Card>
        <div className="mb-3 flex items-center gap-2">
          <MailQuestion size={18} className="text-salmon-deep" />
          <h3 className="font-semibold text-ink">รอบันทึกผลตอบกลับ ({waitRows.length})</h3>
        </div>
        {waitRows.length === 0 ? (
          <Empty text="ไม่มีจดหมายที่รอผลตอบกลับ" />
        ) : (
          <div className="flex flex-col gap-2">
            {waitRows.map((r) => {
              const st = r.stage as { kind: 'waiting-reply'; round: 1 | 2 | 3 }
              const pending = r.lettersThisEpisode.find((l) => l.reply === 'pending')
              return (
                <div key={r.status.contractId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-peach bg-white px-3 py-2.5">
                  <div>
                    <p className="font-medium text-ink">{r.status.customerName} — {r.status.contractNo}</p>
                    <p className="text-sm text-ink-soft">
                      ส่งครั้งที่ {st.round} แล้ว · เลขพัสดุ {pending?.trackingNo || '—'} · {REPLY_LABEL.pending}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setReply(r, 'replied')} className="rounded-lg bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100">
                      ตอบกลับแล้ว
                    </button>
                    <button onClick={() => setReply(r, 'no_reply')} className="rounded-lg bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100">
                      ไม่ตอบ/ตีกลับ
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* 3) ค้นหาทะเบียนราษฎร์ */}
      {registryRows.length > 0 && (
        <Card>
          <div className="mb-3 flex items-center gap-2">
            <Search size={18} className="text-salmon-deep" />
            <h3 className="font-semibold text-ink">ค้นหาทะเบียนราษฎร์ ({registryRows.length})</h3>
          </div>
          <p className="mb-3 text-sm text-ink-soft">ส่ง 2 ครั้งแล้วไม่ตอบทั้งคู่ — ค้นที่อยู่จากทะเบียนราษฎร์แล้วกรอกเพื่อส่งครั้งที่ 3</p>
          <div className="flex flex-col gap-2">
            {registryRows.map((r) => (
              <div key={r.status.contractId} className="flex items-center justify-between rounded-xl border border-peach bg-white px-3 py-2.5">
                <p className="font-medium text-ink">{r.status.customerName} — {r.status.contractNo}</p>
                <Button variant="ghost" onClick={() => setRegistryFor(r)}>
                  <MapPin size={15} /> กรอกที่อยู่ทะเบียน
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* 4) เตรียมลงพื้นที่ */}
      {fieldRows.length > 0 && (
        <Card>
          <div className="mb-3 flex items-center gap-2">
            <MapPin size={18} className="text-red-600" />
            <h3 className="font-semibold text-ink">เตรียมลงพื้นที่ ({fieldRows.length})</h3>
          </div>
          <p className="mb-3 text-sm text-ink-soft">ส่งจดหมายครบ 3 ครั้งแล้วไม่ตอบ — เตรียมลงพื้นที่ (ใช้ที่อยู่ที่ทำงาน)</p>
          <div className="flex flex-col gap-2">
            {fieldRows.map((r) => (
              <div key={r.status.contractId} className="rounded-xl border border-peach bg-white px-3 py-2.5">
                <p className="font-medium text-ink">{r.status.customerName} — {r.status.contractNo}</p>
                <p className="text-xs text-ink-soft">
                  ที่ทำงาน: {isAddressEmpty(r.addresses.work) ? '— ยังไม่มี —' : addressOneLine(r.addresses.work)}
                </p>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* แก้ข้อความจดหมาย */}
      <Card>
        <button onClick={() => setShowTpl((v) => !v)} className="flex w-full items-center justify-between text-left">
          <span className="font-semibold text-ink">ข้อความจดหมาย (แก้ไขได้)</span>
          <span className="text-sm text-salmon-deep">{showTpl ? 'ซ่อน' : 'แก้ไข'}</span>
        </button>
        {showTpl && <TemplateEditor template={template} onSaved={(t) => setTemplate(t)} />}
      </Card>

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

function Empty({ text }: { text: string }) {
  return <p className="rounded-xl bg-peach-light/40 px-4 py-5 text-center text-sm text-ink-soft">{text}</p>
}

function TemplateEditor({ template, onSaved }: { template: string; onSaved: (t: string) => void }) {
  const [text, setText] = useState(template)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  async function save() {
    setBusy(true)
    setMsg(null)
    try {
      await saveLetterTemplate(text)
      onSaved(text)
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
        ใช้ตัวแปร: {'{{name}} {{address}} {{contractNo}} {{amount}} {{daysLate}} {{date}}'}
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={9}
        className="w-full rounded-xl border border-peach bg-white p-3 text-sm leading-7 text-ink"
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
