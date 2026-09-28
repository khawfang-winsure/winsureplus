import { useEffect, useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, Copy, ExternalLink, FileText, RefreshCw } from 'lucide-react'
import { Badge, Button, Loading, Modal, Textarea } from './ui'
import {
  decideCreditCheck,
  getCreditCheck,
  getCreditCheckFileUrl,
  markCreditCheckOpened,
  recheckPjBlacklist,
  setCreditCheckBlacklist,
  setCreditCheckFacebook,
} from '../lib/db'
import type { CreditCheckDecision, CreditCheckDetail, CreditCheckFile } from '../lib/types'
import { thaiDate } from '../lib/format'

// ===== บัญชีดำ PJ (ค้นอัตโนมัติ) — Wave 3 2026-09-28 (contract: pj-blacklist-contract.md)
// สถานะ/รายการ hit มาจาก credit_checks.pj_blacklist_* (น้องชีสกำลังเพิ่มใน types.ts/db.ts พร้อมกัน) =====
const PJ_BLACKLIST_TONE: Record<string, 'green' | 'amber' | 'red' | 'neutral'> = {
  not_checked: 'neutral',
  clear: 'green',
  found: 'red',
  error: 'amber',
}

function pjBlacklistLabel(status: string, hitCount: number): string {
  if (status === 'clear') return 'ไม่พบ'
  if (status === 'found') return `พบ ${hitCount} รายการ`
  if (status === 'error') return 'ค้นไม่สำเร็จ'
  return 'ยังไม่ค้น'
}

// ===== label ไทยฝั่ง staff (คนละชุดกับ shopText ที่ร้านเห็น — engineReasons.staffText มาจาก DB ตรงๆ อยู่แล้ว
// ตัวนี้ใช้แค่ label ระดับผลรวม (engine_level) + field อาชีพ/ประเภทเอกสารที่เก็บเป็น string ดิบ) =====
export const ENGINE_LEVEL_LABEL: Record<string, { text: string; tone: 'red' | 'amber' | 'green' }> = {
  fail: { text: 'FAIL — เกณฑ์บังคับไม่ผ่าน', tone: 'red' },
  needs_review: { text: 'REVIEW — มีจุดต้องเช็คเพิ่ม', tone: 'amber' },
  passed_preliminary: { text: 'PRELIM PASS — รอเช็คแบล็กลิสต์ + Facebook', tone: 'green' },
}

const OCCUPATION_LABEL: Record<string, string> = {
  salaried: 'อาชีพประจำ',
  freelancer: 'อาชีพอิสระ',
  government: 'ข้าราชการ',
  business_owner: 'เจ้าของกิจการ',
}

const ID_TYPE_LABEL: Record<string, string> = { thai: 'คนไทย', foreign: 'ต่างชาติ (ลาว/พม่า)' }

const FILE_KIND_LABEL: Record<CreditCheckFile['kind'], string> = {
  id_card: 'บัตรประชาชน / เอกสารประจำตัว',
  payslip: 'สลิปเงินเดือน',
  statement: 'รายการเดินบัญชี (Statement)',
  work_photo: 'รูปหลักฐานการทำงาน',
  facebook_screenshot: 'ภาพหน้าจอ Facebook',
  thaid_name_history: 'ประวัติเปลี่ยนชื่อจากแอป ThaID',
  other: 'เอกสารอื่นๆ',
}

// ===== สัญญาณเตือน (fraud_flags) — anti-fraud layer 1, addendum 2026-09-28 =====
const FRAUD_FLAG_LABEL: Record<string, string> = {
  NAME_CHANGED: 'ชื่อเปลี่ยนจากประวัติเดิม',
  DUP_FILE: 'ไฟล์แนบซ้ำกับคำขออื่น (คนละเลขบัตร)',
  FB_SHARED: 'ลิงก์ Facebook ซ้ำกับคำขออื่น',
  PDF_EDITED: 'ไฟล์ PDF มีร่องรอยถูกแก้ไข',
  PDF_UNREADABLE: 'ไฟล์ PDF เปิดอ่านไม่ได้ (เข้ารหัส)',
}
function fraudFlagLabel(code: string): string {
  return FRAUD_FLAG_LABEL[code] ?? code
}

const STATEMENT_CHECKLIST_ITEMS = [
  'ยอดคงเหลือบวก/ลบตรงทุกบรรทัด',
  'เงินเดือนเข้าตรงกับสลิป (ชื่อบริษัท/ยอด/วันที่)',
  'บัตร: รูป/ฟอนต์/ลายน้ำปกติ',
] as const

const BLACKLISTSELLER_URL = 'https://www.blacklistseller.com'

function thaiDateTime(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const time = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
  return `${thaiDate(iso.slice(0, 10))} ${time}`
}

function money(n: number | null): string {
  if (n === null) return '-'
  return n.toLocaleString('th-TH', { maximumFractionDigits: 0 }) + ' บาท'
}

/** 1 ไฟล์แนบ — รูป: preview ในหน้า (เปิดขยายในแท็บใหม่ได้), PDF/อื่นๆ: ปุ่มเปิดในแท็บใหม่ (getCreditCheckFileUrl signed 300 วิ) */
function FileRow({ file }: { file: CreditCheckFile }) {
  const isImage = (file.mime ?? '').startsWith('image/')
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!isImage) return
    let cancelled = false
    setBusy(true)
    getCreditCheckFileUrl(file.id)
      .then((u) => {
        if (!cancelled) setUrl(u)
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'โหลดรูปไม่สำเร็จ')
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, isImage])

  async function openInNewTab() {
    setBusy(true)
    setErr(null)
    try {
      const u = url ?? (await getCreditCheckFileUrl(file.id))
      window.open(u, '_blank', 'noopener')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'เปิดไฟล์ไม่สำเร็จ')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <span className="text-xs font-medium text-ink-soft">{FILE_KIND_LABEL[file.kind]}</span>
      {isImage ? (
        url ? (
          <button type="button" onClick={() => void openInNewTab()} className="block rounded-lg border border-peach">
            <img src={url} alt={FILE_KIND_LABEL[file.kind]} className="h-24 w-24 rounded-lg object-cover" />
          </button>
        ) : (
          <div className="flex h-24 w-24 items-center justify-center rounded-lg border border-dashed border-peach text-center text-[11px] text-ink-soft">
            {busy ? 'กำลังโหลด...' : (err ?? 'โหลดรูปไม่สำเร็จ')}
          </div>
        )
      ) : (
        <Button variant="ghost" onClick={() => void openInNewTab()} disabled={busy} className="!px-2.5 !py-1.5 !text-xs">
          <FileText className="h-3.5 w-3.5" />
          {busy ? 'กำลังเปิด...' : 'เปิดไฟล์'}
          <ExternalLink className="h-3 w-3" />
        </Button>
      )}
      {err && !isImage && <p className="text-[11px] text-red-600">{err}</p>}
    </div>
  )
}

export default function CreditCheckDetailModal({
  id,
  onClose,
  onChanged,
}: {
  id: string
  onClose: () => void
  onChanged: () => void
}) {
  const [detail, setDetail] = useState<CreditCheckDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [blacklistBusy, setBlacklistBusy] = useState(false)
  const [pjRecheckBusy, setPjRecheckBusy] = useState(false)
  const [pjRecheckErr, setPjRecheckErr] = useState<string | null>(null)
  const [facebookBusy, setFacebookBusy] = useState(false)
  const [decisionChoice, setDecisionChoice] = useState<CreditCheckDecision | null>(null)
  const [note, setNote] = useState('')
  const [decisionBusy, setDecisionBusy] = useState(false)
  const [decisionErr, setDecisionErr] = useState<string | null>(null)
  const decisionErrId = useId()
  // เช็คลิสต์ตรวจเอกสารด้วยตา — เก็บแค่ session นี้ ไม่บันทึกลง DB (ตั้งใจง่ายตาม contract "your call, keep simple")
  const [checklist, setChecklist] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    Promise.all([getCreditCheck(id), markCreditCheckOpened(id).catch(() => undefined)])
      .then(([d]) => {
        if (cancelled) return
        if (!d) {
          setLoadError('ไม่พบคำขอนี้ (อาจถูกลบ หรือหมดสิทธิ์เข้าถึง)')
        } else {
          setDetail(d)
          setNote(d.decisionNote ?? '')
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  async function copyNationalId() {
    if (!detail) return
    try {
      await navigator.clipboard.writeText(detail.nationalId)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard ใช้ไม่ได้ (สิทธิ์เบราว์เซอร์) — ไม่ต้องบล็อกอะไร
    }
  }

  async function handlePjRecheck() {
    if (!detail) return
    setPjRecheckBusy(true)
    setPjRecheckErr(null)
    try {
      await recheckPjBlacklist(detail.id)
      const fresh = await getCreditCheck(detail.id)
      if (fresh) setDetail(fresh)
      onChanged()
    } catch (e) {
      setPjRecheckErr(e instanceof Error ? e.message : 'ค้นซ้ำไม่สำเร็จ')
    } finally {
      setPjRecheckBusy(false)
    }
  }

  async function handleBlacklist(result: 'clear' | 'found') {
    if (!detail) return
    setBlacklistBusy(true)
    try {
      await setCreditCheckBlacklist(detail.id, result)
      setDetail({ ...detail, blacklistResult: result })
      onChanged()
    } finally {
      setBlacklistBusy(false)
    }
  }

  async function handleFacebook(result: 'confirmed' | 'mismatch') {
    if (!detail) return
    setFacebookBusy(true)
    try {
      await setCreditCheckFacebook(detail.id, result)
      setDetail({ ...detail, facebookResult: result })
      onChanged()
    } finally {
      setFacebookBusy(false)
    }
  }

  async function handleDecide() {
    if (!detail || !decisionChoice) return
    if ((decisionChoice === 'rejected' || decisionChoice === 'need_more_info') && !note.trim()) {
      setDecisionErr('กรุณาระบุเหตุผล/รายละเอียดก่อนบันทึก')
      return
    }
    setDecisionErr(null)
    setDecisionBusy(true)
    try {
      await decideCreditCheck(detail.id, decisionChoice, note)
      onChanged()
      onClose()
    } catch (e) {
      setDecisionErr(e instanceof Error ? e.message : 'บันทึกผลตัดสินไม่สำเร็จ')
      setDecisionBusy(false)
    }
  }

  return (
    <Modal
      title="รายละเอียดคำขอเช็คเครดิต"
      onClose={onClose}
      size="lg"
      // Esc ปิดได้เฉพาะตอนยังไม่เริ่มกรอกคำตัดสิน (ยังไม่กดเลือก ผ่าน/ไม่ผ่าน/ขอเอกสารเพิ่ม) — กัน Esc
      // มือลื่นทำหมายเหตุที่พิมพ์ค้างไว้ในกล่องคำตัดสินหายโดยไม่ได้ตั้งใจ
      closeOnEsc={decisionChoice === null}
    >
      {loading && <Loading />}
      {!loading && loadError && <p className="text-sm text-red-600">{loadError}</p>}

      {!loading && detail && (
        <div className="flex flex-col gap-5">
          {/* สัญญาณเตือน (fraud_flags) — โชว์บนสุดเสมอเมื่อมีสัญญาณ ไม่เคยโชว์รายละเอียดนี้ให้ร้านเห็น */}
          {detail.fraudFlags.length > 0 && (
            <div className="rounded-xl border-2 border-red-300 bg-red-50 p-4">
              <h4 className="mb-2 text-sm font-bold text-red-800">⚠ สัญญาณเตือน ({detail.fraudFlags.length})</h4>
              <ul className="flex flex-col gap-1.5">
                {detail.fraudFlags.map((f, i) => (
                  <li key={i} className={`rounded-lg px-3 py-1.5 text-xs ${f.severity === 'high' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}>
                    <span className="font-semibold">{fraudFlagLabel(f.code)}</span>
                    {f.detailStaff && <span> — {f.detailStaff}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* เช็คลิสต์ตรวจเอกสารด้วยตา — ไม่บังคับ ไม่บันทึก ใช้เตือนความจำเจ้าหน้าที่เฉยๆ */}
          <div className="rounded-xl border border-peach p-4">
            <h4 className="mb-2 text-sm font-semibold text-ink">เช็คลิสต์ตรวจเอกสารด้วยตา</h4>
            <ul className="flex flex-col gap-1.5">
              {STATEMENT_CHECKLIST_ITEMS.map((item) => (
                <li key={item}>
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={!!checklist[item]}
                      onChange={(e) => setChecklist((prev) => ({ ...prev, [item]: e.target.checked }))}
                      className="h-4 w-4 rounded border-peach text-salmon-deep focus:ring-salmon/40"
                    />
                    {item}
                  </label>
                </li>
              ))}
            </ul>
          </div>

          {detail.contractId && (
            <div className="rounded-xl bg-green-50 px-3 py-2 text-sm text-green-800">
              ผูกกับสัญญาแล้ว —{' '}
              <Link to={`/contract/${detail.contractId}`} className="font-medium underline">
                ดูสัญญา
              </Link>
            </div>
          )}

          {/* ระดับผลเอนจิ้น + เหตุผล */}
          <div>
            <div className="flex flex-wrap items-center gap-2">
              {detail.engineLevel ? (
                <Badge tone={ENGINE_LEVEL_LABEL[detail.engineLevel].tone}>{ENGINE_LEVEL_LABEL[detail.engineLevel].text}</Badge>
              ) : (
                <Badge tone="neutral">ไม่ทราบผล</Badge>
              )}
              {detail.engineRatio !== null && (
                <span className="text-xs text-ink-soft">รายได้/ค่างวด ≈ {detail.engineRatio.toFixed(2)} เท่า</span>
              )}
            </div>
            {detail.engineReasons.length > 0 && (
              <ul className="mt-2 space-y-1 text-sm text-ink-soft">
                {detail.engineReasons.map((r) => (
                  <li key={r.code} className={`rounded-lg px-3 py-1.5 ${r.severity === 'fail' ? 'bg-red-50' : 'bg-amber-50'}`}>
                    {r.staffText}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ข้อมูลลูกค้า */}
          <div className="grid grid-cols-1 gap-x-4 gap-y-2 rounded-xl border border-peach bg-cream-deep/40 p-4 text-sm sm:grid-cols-2">
            <div><span className="text-ink-soft">ร้าน: </span>{detail.shopName}</div>
            <div><span className="text-ink-soft">ชื่อลูกค้า: </span>{detail.customerName}</div>
            <div className="flex items-center gap-2">
              <span className="text-ink-soft">เลขบัตร: </span>
              {detail.nationalId}
              <button
                type="button"
                onClick={() => void copyNationalId()}
                className="inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-xs text-salmon-deep hover:bg-peach-light"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'คัดลอกแล้ว' : 'คัดลอก'}
              </button>
            </div>
            <div><span className="text-ink-soft">ประเภท: </span>{ID_TYPE_LABEL[detail.idType] ?? detail.idType}</div>
            <div><span className="text-ink-soft">วันหมดอายุเอกสาร: </span>{detail.idExpiry ? thaiDate(detail.idExpiry) : 'ไม่ระบุ'}</div>
            <div><span className="text-ink-soft">วันออกบัตร: </span>{detail.idIssueDate ? thaiDate(detail.idIssueDate) : 'ไม่ระบุ'}</div>
            <div><span className="text-ink-soft">วันเกิด: </span>{detail.birthDate ? thaiDate(detail.birthDate) : '-'}</div>
            <div><span className="text-ink-soft">อาชีพ: </span>{detail.occupationType ? (OCCUPATION_LABEL[detail.occupationType] ?? detail.occupationType) : '-'}</div>
            <div><span className="text-ink-soft">รายได้แจ้ง: </span>{money(detail.declaredIncome)}</div>
            <div><span className="text-ink-soft">ราคาเครื่อง: </span>{money(detail.devicePrice)}</div>
            <div><span className="text-ink-soft">ดาวน์: </span>{detail.deviceDown === null ? '-' : `${detail.deviceDown}%`}</div>
            <div><span className="text-ink-soft">งวด: </span>{detail.termMonths ?? '-'} เดือน</div>
            <div><span className="text-ink-soft">ค่างวดเรา / PJ: </span>{money(detail.ourInstallment)} / {money(detail.pjInstallment)}</div>
            <div><span className="text-ink-soft">ยื่นคำขอเมื่อ: </span>{thaiDateTime(detail.createdAt)}</div>
          </div>

          {/* ไฟล์แนบ */}
          {detail.files.length > 0 && (
            <div>
              <h4 className="mb-2 text-sm font-semibold text-ink">ไฟล์แนบ ({detail.files.length})</h4>
              <div className="flex flex-wrap gap-3">
                {detail.files.map((f) => (
                  <FileRow key={f.id} file={f} />
                ))}
              </div>
            </div>
          )}

          {/* บัญชีดำ PJ (ค้นอัตโนมัติ) — Wave 3 */}
          <div className="rounded-xl border border-peach p-4">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-ink">บัญชีดำ PJ (ค้นอัตโนมัติ)</h4>
              <Badge tone={PJ_BLACKLIST_TONE[detail.pjBlacklistStatus] ?? 'neutral'}>
                {pjBlacklistLabel(detail.pjBlacklistStatus, detail.pjBlacklistHits.length)}
              </Badge>
            </div>
            <p className="text-xs text-ink-soft">
              ค้นล่าสุด: {detail.pjBlacklistCheckedAt ? thaiDateTime(detail.pjBlacklistCheckedAt) : 'ยังไม่เคยค้น'}
            </p>
            {detail.pjBlacklistStatus === 'error' && detail.pjBlacklistError && (
              <p className="mt-1 text-xs text-red-600">เหตุผล: {detail.pjBlacklistError}</p>
            )}
            {detail.pjBlacklistHits.length > 0 && (
              <ul className="mt-3 flex flex-col gap-2">
                {detail.pjBlacklistHits.map((h, i) => (
                  <li key={i} className="rounded-lg border border-peach bg-cream-deep/40 p-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-ink">{h.invoiceNo}</span>
                      <Badge tone="amber">{h.statusLabel}</Badge>
                    </div>
                    <p className="mt-1 text-ink-soft">
                      ร้าน: {h.shopName}
                      {h.shopContact ? ` · ${h.shopContact}` : ''}
                    </p>
                    <p className="text-ink-soft">
                      รุ่น: {[h.brand, h.model].filter(Boolean).join(' ') || '-'}
                      {h.imeiLast4 ? ` · IMEI ...${h.imeiLast4}` : ''}
                    </p>
                    <p className="text-ink-soft">
                      งวด: จ่ายแล้ว {h.installmentsPaid ?? '-'} / ทั้งหมด {h.installmentsTotal ?? '-'} · ค้าง {h.installmentsOverdue ?? '-'}
                    </p>
                    <p className="text-ink-soft">จับคู่ด้วย: {h.matchedBy === 'imei' ? 'IMEI' : 'เลขบัตรประชาชน'}</p>
                  </li>
                ))}
              </ul>
            )}
            {pjRecheckErr && <p className="mt-2 text-xs text-red-600">{pjRecheckErr}</p>}
            <div className="mt-3">
              <Button variant="ghost" onClick={() => void handlePjRecheck()} disabled={pjRecheckBusy} className="!text-xs">
                <RefreshCw className={`h-3.5 w-3.5 ${pjRecheckBusy ? 'animate-spin' : ''}`} />
                {pjRecheckBusy ? 'กำลังค้นซ้ำ...' : 'ค้นซ้ำ'}
              </Button>
            </div>
          </div>

          {/* ตรวจ Blacklist (blacklistseller.com — ด้วยตา) */}
          <div className="rounded-xl border border-peach p-4">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-ink">ตรวจแบล็กลิสต์</h4>
              <Badge tone={detail.blacklistResult === 'clear' ? 'green' : detail.blacklistResult === 'found' ? 'red' : 'neutral'}>
                {detail.blacklistResult === 'clear' ? 'ไม่พบ' : detail.blacklistResult === 'found' ? 'พบ' : 'ยังไม่ตรวจ'}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" onClick={() => void copyNationalId()} className="!text-xs">
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                คัดลอกเลขบัตร
              </Button>
              <Button
                variant="ghost"
                onClick={() => window.open(BLACKLISTSELLER_URL, '_blank', 'noopener')}
                className="!text-xs"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                เปิด blacklistseller.com
              </Button>
              <Button
                variant={detail.blacklistResult === 'clear' ? 'primary' : 'ghost'}
                aria-pressed={detail.blacklistResult === 'clear'}
                disabled={blacklistBusy}
                onClick={() => void handleBlacklist('clear')}
                className="!text-xs"
              >
                ไม่พบ
              </Button>
              <Button
                variant={detail.blacklistResult === 'found' ? 'primary' : 'ghost'}
                aria-pressed={detail.blacklistResult === 'found'}
                disabled={blacklistBusy}
                onClick={() => void handleBlacklist('found')}
                className="!text-xs"
              >
                พบ
              </Button>
            </div>
          </div>

          {/* ตรวจ Facebook */}
          <div className="rounded-xl border border-peach p-4">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-ink">ตรวจ Facebook</h4>
              <Badge tone={detail.facebookResult === 'confirmed' ? 'green' : detail.facebookResult === 'mismatch' ? 'red' : 'neutral'}>
                {detail.facebookResult === 'confirmed' ? 'ตัวตนจริง' : detail.facebookResult === 'mismatch' ? 'ไม่ตรง' : 'ยังไม่ตรวจ'}
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {detail.facebookUrl ? (
                <Button
                  variant="ghost"
                  onClick={() => window.open(detail.facebookUrl!, '_blank', 'noopener')}
                  className="!text-xs"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  เปิดลิงก์ Facebook
                </Button>
              ) : (
                <span className="text-xs text-ink-soft">ร้านไม่ได้แนบลิงก์ Facebook</span>
              )}
              <Button
                variant={detail.facebookResult === 'confirmed' ? 'primary' : 'ghost'}
                aria-pressed={detail.facebookResult === 'confirmed'}
                disabled={facebookBusy}
                onClick={() => void handleFacebook('confirmed')}
                className="!text-xs"
              >
                ตัวตนจริง
              </Button>
              <Button
                variant={detail.facebookResult === 'mismatch' ? 'primary' : 'ghost'}
                aria-pressed={detail.facebookResult === 'mismatch'}
                disabled={facebookBusy}
                onClick={() => void handleFacebook('mismatch')}
                className="!text-xs"
              >
                ไม่ตรง
              </Button>
            </div>
          </div>

          {/* คำตัดสิน */}
          <div className="rounded-xl border border-peach p-4">
            <h4 className="mb-2 text-sm font-semibold text-ink">คำตัดสิน</h4>
            {detail.decision ? (
              <div className="mb-3 rounded-lg bg-peach-light/50 px-3 py-2 text-sm text-ink">
                ตัดสินแล้ว:{' '}
                <strong>
                  {detail.decision === 'approved' ? 'ผ่าน' : detail.decision === 'rejected' ? 'ไม่ผ่าน' : 'ขอเอกสารเพิ่ม'}
                </strong>
                {detail.decisionNote && <p className="mt-1 text-ink-soft">หมายเหตุ: {detail.decisionNote}</p>}
              </div>
            ) : (
              <>
                <div className="mb-2 flex flex-wrap gap-2">
                  <Button
                    variant={decisionChoice === 'approved' ? 'primary' : 'ghost'}
                    aria-pressed={decisionChoice === 'approved'}
                    onClick={() => setDecisionChoice('approved')}
                    className="!text-xs"
                  >
                    ผ่าน
                  </Button>
                  <Button
                    variant={decisionChoice === 'rejected' ? 'primary' : 'ghost'}
                    aria-pressed={decisionChoice === 'rejected'}
                    onClick={() => setDecisionChoice('rejected')}
                    className="!text-xs"
                  >
                    ไม่ผ่าน
                  </Button>
                  <Button
                    variant={decisionChoice === 'need_more_info' ? 'primary' : 'ghost'}
                    aria-pressed={decisionChoice === 'need_more_info'}
                    onClick={() => setDecisionChoice('need_more_info')}
                    className="!text-xs"
                  >
                    ขอเอกสารเพิ่ม
                  </Button>
                </div>
                {decisionChoice && (
                  <>
                    <Textarea
                      aria-label={decisionChoice === 'approved' ? 'หมายเหตุ (ไม่บังคับ)' : 'เหตุผล/สิ่งที่ต้องแก้ไข (บังคับ)'}
                      aria-describedby={decisionErr ? decisionErrId : undefined}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder={
                        decisionChoice === 'approved'
                          ? 'หมายเหตุ (ไม่บังคับ)'
                          : 'ระบุเหตุผล/สิ่งที่ต้องแก้ไข (บังคับ) — ข้อความนี้ร้านจะเห็น'
                      }
                      rows={3}
                    />
                    {decisionErr && (
                      <p id={decisionErrId} role="alert" className="mt-1 text-sm text-red-600">
                        {decisionErr}
                      </p>
                    )}
                    <div className="mt-2 flex justify-end">
                      <Button onClick={() => void handleDecide()} disabled={decisionBusy}>
                        {decisionBusy ? 'กำลังบันทึก...' : 'บันทึกผลตัดสิน'}
                      </Button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
