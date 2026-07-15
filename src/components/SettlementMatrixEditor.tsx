import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'
import { Button, Card, Input, Loading, Modal } from './ui'
import { getSettlementMatrix, saveSettlementMatrix } from '../lib/db'
import type { SettlementMatrix } from '../lib/settlement'

// ร่างข้อมูลระหว่างแก้ไข — เก็บเป็น string (ไม่ใช่ number) เพื่อให้พิมพ์ค้างว่างได้ระหว่างกรอก
type DraftMatrix = Record<string, Record<string, string>>

function matrixToDraft(m: SettlementMatrix): DraftMatrix {
  const draft: DraftMatrix = {}
  for (const term of Object.keys(m)) {
    const row: Record<string, string> = {}
    for (const paidCount of Object.keys(m[term])) {
      row[paidCount] = String(m[term][paidCount])
    }
    draft[term] = row
  }
  return draft
}

function draftToMatrix(draft: DraftMatrix): SettlementMatrix {
  const result: SettlementMatrix = {}
  for (const term of Object.keys(draft)) {
    const row: Record<string, number> = {}
    for (const paidCount of Object.keys(draft[term])) {
      const raw = draft[term][paidCount].trim()
      if (raw === '') continue
      const num = Number(raw)
      if (!Number.isNaN(num)) row[paidCount] = num
    }
    result[term] = row
  }
  return result
}

/** ชื่อสัญญาเรียงจากน้อย→มาก ตามเลขจำนวนงวด (key เป็น string) */
function sortTermKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => Number(a) - Number(b))
}

export function SettlementMatrixEditor({ canEdit }: { canEdit: boolean }) {
  const [draft, setDraft] = useState<DraftMatrix>({})
  const [original, setOriginal] = useState<SettlementMatrix>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [addTermRaw, setAddTermRaw] = useState('')
  const [addTermErr, setAddTermErr] = useState<string | null>(null)
  const [clearWarningTerms, setClearWarningTerms] = useState<string[] | null>(null)

  useEffect(() => {
    getSettlementMatrix().then((m) => {
      setOriginal(m)
      setDraft(matrixToDraft(m))
      // เปิดค้างชนิดสัญญาแรกไว้ให้เห็นตัวอย่าง ที่เหลือพับไว้
      const terms = sortTermKeys(Object.keys(m))
      setExpanded(terms.length > 0 ? { [terms[0]]: true } : {})
      setLoading(false)
    })
  }, [])

  const terms = useMemo(() => sortTermKeys(Object.keys(draft)), [draft])

  function setCell(term: string, paidCount: number, value: string) {
    setDraft((prev) => ({
      ...prev,
      [term]: { ...(prev[term] ?? {}), [String(paidCount)]: value },
    }))
    setSaved(false)
  }

  function toggleExpand(term: string) {
    setExpanded((prev) => ({ ...prev, [term]: !prev[term] }))
  }

  function addTerm() {
    setAddTermErr(null)
    const num = Number(addTermRaw.trim())
    if (!addTermRaw.trim() || Number.isNaN(num) || !Number.isInteger(num) || num < 2) {
      setAddTermErr('กรอกจำนวนงวดเป็นตัวเลขจำนวนเต็ม ตั้งแต่ 2 งวดขึ้นไป')
      return
    }
    const key = String(num)
    if (draft[key]) {
      setAddTermErr(`มีชนิดสัญญา ${num} งวดอยู่แล้ว`)
      return
    }
    setDraft((prev) => ({ ...prev, [key]: {} }))
    setExpanded((prev) => ({ ...prev, [key]: true }))
    setAddTermRaw('')
    setSaved(false)
  }

  function removeTerm(term: string) {
    setDraft((prev) => {
      const next = { ...prev }
      delete next[term]
      return next
    })
    setSaved(false)
  }

  // เซลล์ที่กรอกไม่ถูกต้อง (ไม่ใช่ตัวเลข หรือ นอกช่วง 0-100)
  const invalidCells = useMemo(() => {
    const bad: { term: string; paidCount: string }[] = []
    for (const term of Object.keys(draft)) {
      for (const paidCount of Object.keys(draft[term])) {
        const raw = draft[term][paidCount].trim()
        if (raw === '') continue
        const num = Number(raw)
        if (Number.isNaN(num) || num < 0 || num > 100) bad.push({ term, paidCount })
      }
    }
    return bad
  }, [draft])

  // หาชนิดสัญญาที่ "เคยมีค่า" แต่ตอนนี้ว่างทั้งแถว (จะทำให้สัญญาชนิดนี้ไม่ได้ส่วนลดเลย)
  function findNewlyEmptyTerms(): string[] {
    const nextMatrix = draftToMatrix(draft)
    const flagged: string[] = []
    for (const term of Object.keys(original)) {
      const hadValues = Object.keys(original[term] ?? {}).length > 0
      const nowValues = Object.keys(nextMatrix[term] ?? {}).length > 0
      if (hadValues && !nowValues) flagged.push(term)
    }
    return sortTermKeys(flagged)
  }

  function handleSaveClick() {
    if (invalidCells.length > 0) return
    const flagged = findNewlyEmptyTerms()
    if (flagged.length > 0) {
      setClearWarningTerms(flagged)
      return
    }
    void doSave()
  }

  async function doSave() {
    setBusy(true)
    setErr(null)
    try {
      const cleaned = draftToMatrix(draft)
      await saveSettlementMatrix(cleaned)
      setOriginal(cleaned)
      setDraft(matrixToDraft(cleaned))
      setSaved(true)
      setClearWarningTerms(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Loading />

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-peach bg-peach-light/40 px-4 py-3 text-sm text-ink-soft">
        ส่วนลดปิดสัญญาก่อนกำหนด = <b className="text-ink">ดูจากชนิดสัญญา (กี่งวด) + จ่ายไปแล้วกี่งวด</b>
        <br />
        ตั้ง % ส่วนลดของเงินต้นที่เหลือ ไว้แต่ละชนิดสัญญา — <b className="text-ink">ค่าปรับค้างคิดเต็มไม่ลด</b>
        <br />
        ช่องไหนเว้นว่างไว้ = ไม่มีส่วนลด (0%) — เช่น ลูกค้ายังไม่จ่ายงวดไหนเลย หรือเหลืองวดสุดท้ายงวดเดียว ปกติไม่ตั้งส่วนลด
      </div>

      {terms.length === 0 && (
        <Card>
          <p className="text-center text-sm text-ink-soft">ยังไม่มีชนิดสัญญาในตาราง — เพิ่มได้ด้านล่าง</p>
        </Card>
      )}

      {terms.map((term) => {
        const rowDraft = draft[term] ?? {}
        const termNum = Number(term)
        const paidCounts = Array.from({ length: Math.max(0, termNum - 1) }, (_, i) => i + 1)
        const isOpen = !!expanded[term]
        return (
          <Card key={term}>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => toggleExpand(term)}
                className="flex flex-1 items-center gap-2 text-left"
              >
                {isOpen ? <ChevronUp size={16} className="text-ink-soft" /> : <ChevronDown size={16} className="text-ink-soft" />}
                <h3 className="font-semibold text-ink">สัญญา {term} งวด</h3>
              </button>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => removeTerm(term)}
                  className="rounded-lg p-1.5 text-red-500 hover:bg-red-50"
                  title="ลบชนิดสัญญานี้"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>

            {isOpen && (
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                {paidCounts.map((paidCount) => {
                  const raw = rowDraft[String(paidCount)] ?? ''
                  const cellInvalid = invalidCells.some(
                    (c) => c.term === term && c.paidCount === String(paidCount),
                  )
                  return (
                    <label
                      key={paidCount}
                      className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-sm ${
                        cellInvalid ? 'border-red-400 bg-red-50' : 'border-peach bg-white'
                      }`}
                    >
                      <span className="whitespace-nowrap text-ink-soft">จ่าย {paidCount} งวด</span>
                      <div className="flex items-center gap-1">
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          step="0.1"
                          value={raw}
                          disabled={!canEdit}
                          onChange={(e) => setCell(term, paidCount, e.target.value)}
                          className="w-16 px-2 py-1 text-right"
                        />
                        <span className="text-xs text-ink-soft">%</span>
                      </div>
                    </label>
                  )
                })}
              </div>
            )}
          </Card>
        )
      })}

      {canEdit && (
        <Card>
          <p className="mb-2 text-sm font-medium text-ink">เพิ่มชนิดสัญญาใหม่</p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              min={2}
              placeholder="จำนวนงวด เช่น 18"
              value={addTermRaw}
              onChange={(e) => setAddTermRaw(e.target.value)}
              className="w-40"
            />
            <Button variant="ghost" onClick={addTerm}>
              <Plus size={16} /> เพิ่มชนิดสัญญา
            </Button>
          </div>
          {addTermErr && <p className="mt-1.5 text-sm text-red-600">{addTermErr}</p>}
        </Card>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {invalidCells.length > 0 && (
            <span className="flex items-center gap-1 text-sm text-red-600">
              <AlertTriangle size={14} /> มีช่องกรอก % ไม่ถูกต้อง ({invalidCells.length} ช่อง) — ต้องอยู่ระหว่าง 0-100
            </span>
          )}
          {saved && <span className="text-sm text-green-600">บันทึกแล้ว ✓</span>}
          {err && <span className="text-sm text-red-600">{err}</span>}
          <Button onClick={handleSaveClick} disabled={busy || invalidCells.length > 0}>
            {busy ? 'กำลังบันทึก...' : 'บันทึกตารางส่วนลด'}
          </Button>
        </div>
      )}

      {clearWarningTerms && (
        <Modal title="ยืนยันก่อนบันทึก" onClose={() => setClearWarningTerms(null)}>
          <div className="flex flex-col gap-3 text-sm">
            <p className="flex items-start gap-2 text-amber-800">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>
                สัญญา{' '}
                <b>
                  {clearWarningTerms.map((t) => `${t} งวด`).join(', ')}
                </b>{' '}
                จะไม่ได้รับส่วนลดเลยเมื่อลูกค้าปิดสัญญาก่อนกำหนด (ทุกช่องในชนิดสัญญานี้ว่างหมด) — ยืนยันจะบันทึกแบบนี้ใช่ไหม?
              </span>
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setClearWarningTerms(null)}>
                กลับไปแก้ไข
              </Button>
              <Button onClick={doSave} disabled={busy}>
                {busy ? 'กำลังบันทึก...' : 'ยืนยันบันทึก'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
