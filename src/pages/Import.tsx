// Import.tsx — 4-step PJ CSV import wizard (admin only)

import { useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, ChevronRight, Download, Upload } from 'lucide-react'
import { Badge, Button, Card, Loading, PageTitle } from '../components/ui'
import { getShops, importPjBatch } from '../lib/db'
import {
  buildBatches,
  normalizePJContract,
  normalizePJInstallment,
  parsePJAmount,
  type ImportError,
  type ImportResult,
  type PJContract,
  type PJInstallment,
} from '../lib/pjImport'
import { useAuth } from '../lib/auth'

// ===== CSV Parser (UTF-8 BOM + quoted fields) =====

function stripBOM(text: string): string {
  return text.startsWith('﻿') ? text.slice(1) : text
}

/**
 * Parse a single CSV line respecting double-quote quoting.
 * Returns array of field strings (unquoted, unescaped).
 */
function parseCSVLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
    } else {
      if (ch === '"') {
        inQuotes = true
      } else if (ch === ',') {
        fields.push(current)
        current = ''
      } else {
        current += ch
      }
    }
  }
  fields.push(current)
  return fields
}

/** Parse full CSV text → array of record objects keyed by header row */
function parseCSV(text: string): Record<string, string>[] {
  const cleaned = stripBOM(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = cleaned.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length < 2) return []
  const headers = parseCSVLine(lines[0]).map((h) => h.trim())
  const records: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i])
    const rec: Record<string, string> = {}
    headers.forEach((h, idx) => {
      rec[h] = (values[idx] ?? '').trim()
    })
    records.push(rec)
  }
  return records
}

// ===== Client-side validation =====

interface ValidationResult {
  contractsValid: number
  contractErrors: string[]
  installmentsOrphan: number
  installmentErrors: string[]
  unknownShops: string[]
}

function validate(
  contracts: PJContract[],
  installments: PJInstallment[],
  knownShopNames: Set<string>,
): ValidationResult {
  const VALID_PAYMENT_TYPES = new Set(['เงินดาวน์', 'ค่างวด', 'ค่าปรับ'])
  const contractErrors: string[] = []
  const seenInvoiceNos = new Set<string>()
  let contractsValid = 0

  for (let i = 0; i < contracts.length; i++) {
    const c = contracts[i]
    const rowLabel = `row ${i + 2}`
    const errs: string[] = []

    if (!c.invoice_no) {
      errs.push('invoice_no ว่าง')
    } else if (seenInvoiceNos.has(c.invoice_no)) {
      errs.push(`invoice_no "${c.invoice_no}" ซ้ำในไฟล์`)
    } else {
      seenInvoiceNos.add(c.invoice_no)
    }

    const phoneDigits = c.phone.replace(/\D/g, '')
    if (phoneDigits.length < 9) errs.push('เบอร์โทรน้อยกว่า 9 หลัก')
    if (!parsePJAmount(c.finance_amount)) errs.push('finance_amount ขาด')
    if (!parsePJAmount(c.monthly_payment)) errs.push('monthly_payment ขาด')
    if (!Number(c.term_months)) errs.push('term_months ขาด')

    if (errs.length > 0) {
      contractErrors.push(`${rowLabel} (${c.invoice_no || 'ไม่มีเลข'}): ${errs.join(', ')}`)
    } else {
      contractsValid++
    }
  }

  // Build valid invoice set for orphan check
  const validInvoiceSet = new Set(contracts.map((c) => c.invoice_no).filter(Boolean))
  const installmentErrors: string[] = []
  let installmentsOrphan = 0

  for (let i = 0; i < installments.length; i++) {
    const inst = installments[i]
    const rowLabel = `row ${i + 2}`
    const errs: string[] = []

    if (!validInvoiceSet.has(inst.invoice_no)) {
      installmentsOrphan++
      errs.push(`invoice_no "${inst.invoice_no}" ไม่มีในไฟล์ contracts`)
    }
    if (!VALID_PAYMENT_TYPES.has(inst.payment_type)) {
      errs.push(`payment_type "${inst.payment_type}" ไม่ถูกต้อง`)
    }
    if (parsePJAmount(inst.amount) <= 0) errs.push('amount ต้องมากกว่า 0')

    if (errs.length > 0) {
      installmentErrors.push(`${rowLabel}: ${errs.join(', ')}`)
    }
  }

  // Unknown shop names (not in DB)
  const unknownShops = [
    ...new Set(
      contracts
        .map((c) => c.shop_name)
        .filter((s) => s && !knownShopNames.has(s)),
    ),
  ]

  return { contractsValid, contractErrors, installmentsOrphan, installmentErrors, unknownShops }
}

// ===== CSV Export for failed rows =====

function escCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function buildErrorCSV(errors: ImportError[]): string {
  const header = 'invoiceNo,batch,error'
  const lines = errors.map((e) =>
    [escCell(e.invoiceNo), escCell(e.batch ?? ''), escCell(e.error)].join(','),
  )
  return '﻿' + [header, ...lines].join('\r\n')
}

function triggerDownload(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ===== Step 1 — Upload =====

interface Step1Props {
  onParsed: (contracts: PJContract[], installments: PJInstallment[]) => void
}

function Step1Upload({ onParsed }: Step1Props) {
  const [contractFile, setContractFile] = useState<File | null>(null)
  const [installmentFile, setInstallmentFile] = useState<File | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const contractRef = useRef<HTMLInputElement>(null)
  const installmentRef = useRef<HTMLInputElement>(null)

  function handleParse() {
    if (!contractFile || !installmentFile) return
    setLoading(true)
    setParseError(null)

    const readFile = (file: File): Promise<string> =>
      new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = (e) => resolve(e.target?.result as string)
        reader.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ'))
        reader.readAsText(file, 'UTF-8')
      })

    Promise.all([readFile(contractFile), readFile(installmentFile)])
      .then(([contractText, installmentText]) => {
        const rawContracts = parseCSV(contractText)
        const rawInstallments = parseCSV(installmentText)
        if (rawContracts.length === 0) {
          throw new Error('ไฟล์ contracts ว่างเปล่าหรือไม่มีข้อมูล')
        }
        const contracts = rawContracts.map(normalizePJContract)
        const installments = rawInstallments.map(normalizePJInstallment)
        onParsed(contracts, installments)
      })
      .catch((e: unknown) => {
        setParseError(e instanceof Error ? e.message : 'ไม่สามารถอ่านไฟล์ได้')
      })
      .finally(() => setLoading(false))
  }

  return (
    <Card>
      <h3 className="mb-5 text-base font-bold text-ink">Step 1 — อัปโหลดไฟล์ CSV</h3>
      <div className="space-y-5">
        {/* contracts.csv */}
        <div>
          <p className="mb-2 text-sm font-medium text-ink">
            ไฟล์ contracts.csv{' '}
            <span className="font-normal text-ink-soft">(1 row ต่อสัญญา)</span>
          </p>
          <div
            className="flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed border-peach bg-peach-light/20 px-5 py-4 transition hover:border-salmon/50 hover:bg-peach-light/40"
            onClick={() => contractRef.current?.click()}
          >
            <Upload className="h-5 w-5 shrink-0 text-ink-soft" />
            <span className="text-sm text-ink-soft">
              {contractFile ? contractFile.name : 'คลิกเพื่อเลือกไฟล์'}
            </span>
          </div>
          <input
            ref={contractRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => setContractFile(e.target.files?.[0] ?? null)}
          />
        </div>

        {/* installments.csv */}
        <div>
          <p className="mb-2 text-sm font-medium text-ink">
            ไฟล์ installments.csv{' '}
            <span className="font-normal text-ink-soft">(1 row ต่องวด/ค่าปรับ)</span>
          </p>
          <div
            className="flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed border-peach bg-peach-light/20 px-5 py-4 transition hover:border-salmon/50 hover:bg-peach-light/40"
            onClick={() => installmentRef.current?.click()}
          >
            <Upload className="h-5 w-5 shrink-0 text-ink-soft" />
            <span className="text-sm text-ink-soft">
              {installmentFile ? installmentFile.name : 'คลิกเพื่อเลือกไฟล์'}
            </span>
          </div>
          <input
            ref={installmentRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => setInstallmentFile(e.target.files?.[0] ?? null)}
          />
        </div>

        {parseError && (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {parseError}
          </div>
        )}

        <Button
          variant="primary"
          disabled={!contractFile || !installmentFile || loading}
          onClick={handleParse}
          className="w-full"
        >
          {loading ? 'กำลังอ่านไฟล์...' : 'อ่านและตรวจสอบ'}
          {!loading && <ChevronRight className="h-4 w-4" />}
        </Button>
      </div>
    </Card>
  )
}

// ===== Step 2 — Preview + Validation =====

interface Step2Props {
  contracts: PJContract[]
  installments: PJInstallment[]
  autoCreateShops: boolean
  onAutoCreateShopsChange: (v: boolean) => void
  validation: ValidationResult | null
  loading: boolean
  onConfirm: () => void
  onBack: () => void
}

function Step2Preview({
  contracts,
  installments,
  autoCreateShops,
  onAutoCreateShopsChange,
  validation,
  loading,
  onConfirm,
  onBack,
}: Step2Props) {
  const contractsErrorCount = validation?.contractErrors.length ?? 0
  const installmentsErrorCount = validation?.installmentErrors.length ?? 0
  const canImport =
    validation !== null &&
    validation.contractsValid > 0 &&
    installmentsErrorCount === 0

  return (
    <div className="space-y-5">
      <Card>
        <h3 className="mb-4 text-base font-bold text-ink">Step 2 — ตรวจสอบข้อมูล</h3>

        {loading && <Loading label="กำลังตรวจสอบกับฐานข้อมูล..." />}

        {!loading && validation && (
          <div className="space-y-4">
            {/* Summary counts */}
            <div className="flex flex-wrap gap-3">
              <div className="rounded-xl border border-peach bg-white px-4 py-3">
                <div className="text-xl font-bold text-ink">
                  {validation.contractsValid.toLocaleString('th-TH')}
                </div>
                <div className="mt-0.5 text-xs text-ink-soft">contracts พร้อม import</div>
              </div>
              <div
                className={`rounded-xl border px-4 py-3 ${
                  contractsErrorCount > 0 ? 'border-red-200 bg-red-50' : 'border-peach bg-white'
                }`}
              >
                <div
                  className={`text-xl font-bold ${
                    contractsErrorCount > 0 ? 'text-red-600' : 'text-ink'
                  }`}
                >
                  {contractsErrorCount.toLocaleString('th-TH')}
                </div>
                <div className="mt-0.5 text-xs text-ink-soft">contracts มีข้อผิดพลาด</div>
              </div>
              <div className="rounded-xl border border-peach bg-white px-4 py-3">
                <div className="text-xl font-bold text-ink">
                  {(
                    installments.length -
                    validation.installmentsOrphan -
                    installmentsErrorCount
                  ).toLocaleString('th-TH')}
                </div>
                <div className="mt-0.5 text-xs text-ink-soft">installments พร้อม import</div>
              </div>
              {validation.installmentsOrphan > 0 && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                  <div className="text-xl font-bold text-amber-700">
                    {validation.installmentsOrphan.toLocaleString('th-TH')}
                  </div>
                  <div className="mt-0.5 text-xs text-ink-soft">installments ไม่มีสัญญาคู่</div>
                </div>
              )}
            </div>

            {/* Unknown shops warning */}
            {validation.unknownShops.length > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-700">
                  <AlertTriangle className="h-4 w-4" />
                  ร้านค้าต่อไปนี้ยังไม่มีในระบบ ({validation.unknownShops.length} ร้าน)
                </div>
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {validation.unknownShops.map((s) => (
                    <Badge key={s} tone="amber">
                      {s}
                    </Badge>
                  ))}
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-amber-800">
                  <input
                    type="checkbox"
                    checked={autoCreateShops}
                    onChange={(e) => onAutoCreateShopsChange(e.target.checked)}
                    className="h-4 w-4 accent-amber-600"
                  />
                  สร้างร้านใหม่อัตโนมัติ (จะสร้าง {validation.unknownShops.length} ร้าน)
                </label>
              </div>
            )}

            {/* Contract errors */}
            {contractsErrorCount > 0 && (
              <details className="rounded-xl border border-red-200 bg-red-50">
                <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-red-700">
                  ข้อผิดพลาด contracts ({contractsErrorCount} รายการ) — คลิกเพื่อดู
                </summary>
                <ul className="max-h-48 space-y-1 overflow-y-auto border-t border-red-100 px-4 py-3 text-xs text-red-700">
                  {validation.contractErrors.slice(0, 50).map((err, i) => (
                    <li key={i} className="font-mono">
                      {err}
                    </li>
                  ))}
                  {contractsErrorCount > 50 && (
                    <li className="text-red-400">... และอีก {contractsErrorCount - 50} รายการ</li>
                  )}
                </ul>
              </details>
            )}

            {/* Installment errors */}
            {installmentsErrorCount > 0 && (
              <details className="rounded-xl border border-red-200 bg-red-50">
                <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-red-700">
                  ข้อผิดพลาด installments ({installmentsErrorCount} รายการ) — คลิกเพื่อดู
                </summary>
                <ul className="max-h-48 space-y-1 overflow-y-auto border-t border-red-100 px-4 py-3 text-xs text-red-700">
                  {validation.installmentErrors.slice(0, 50).map((err, i) => (
                    <li key={i} className="font-mono">
                      {err}
                    </li>
                  ))}
                  {installmentsErrorCount > 50 && (
                    <li className="text-red-400">
                      ... และอีก {installmentsErrorCount - 50} รายการ
                    </li>
                  )}
                </ul>
              </details>
            )}
          </div>
        )}
      </Card>

      {/* Preview tables (10 rows each) */}
      <Card>
        <p className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-soft">
          ตัวอย่าง contracts (10 แถวแรก จาก {contracts.length.toLocaleString('th-TH')})
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-peach text-left text-ink-soft">
                {[
                  'invoice_no',
                  'customer_name',
                  'phone',
                  'shop_name',
                  'device_name',
                  'device_color',
                  'สภาพ',
                  'โปรโมชัน',
                  'หลักฐานอาชีพ',
                  'finance_amount',
                  'term_months',
                  'trade_date',
                ].map((h) => (
                  <th key={h} className="pb-2 pr-4 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {contracts.slice(0, 10).map((c, i) => (
                <tr key={i} className="border-b border-peach/30 last:border-0">
                  <td className="py-1.5 pr-4 font-mono">{c.invoice_no || '—'}</td>
                  <td className="py-1.5 pr-4">{c.customer_name || '—'}</td>
                  <td className="py-1.5 pr-4 font-mono">{c.phone || '—'}</td>
                  <td className="py-1.5 pr-4">{c.shop_name || '—'}</td>
                  <td className="py-1.5 pr-4">{c.device_name || '—'}</td>
                  <td className="py-1.5 pr-4">{c.device_color || '—'}</td>
                  <td className="py-1.5 pr-4">{c.condition || '—'}</td>
                  <td className="py-1.5 pr-4">{c.promotion || '—'}</td>
                  <td className="py-1.5 pr-4">{c.occupation_proof || '—'}</td>
                  <td className="py-1.5 pr-4 text-right">{c.finance_amount || '—'}</td>
                  <td className="py-1.5 pr-4 text-right">{c.term_months || '—'}</td>
                  <td className="py-1.5">{c.trade_date || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <p className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-soft">
          ตัวอย่าง installments (10 แถวแรก จาก {installments.length.toLocaleString('th-TH')})
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-peach text-left text-ink-soft">
                {['invoice_no', 'payment_type', 'amount', 'paid_date', 'status'].map((h) => (
                  <th key={h} className="pb-2 pr-4 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {installments.slice(0, 10).map((inst, i) => (
                <tr key={i} className="border-b border-peach/30 last:border-0">
                  <td className="py-1.5 pr-4 font-mono">{inst.invoice_no || '—'}</td>
                  <td className="py-1.5 pr-4">{inst.payment_type || '—'}</td>
                  <td className="py-1.5 pr-4 text-right">{inst.amount || '—'}</td>
                  <td className="py-1.5 pr-4">{inst.paid_date || '—'}</td>
                  <td className="py-1.5">{inst.status || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="flex gap-3">
        <Button variant="ghost" onClick={onBack}>
          ย้อนกลับ
        </Button>
        {!loading && validation && (
          <Button
            variant="primary"
            disabled={
              !canImport || (validation.unknownShops.length > 0 && !autoCreateShops)
            }
            onClick={onConfirm}
            className="flex-1"
          >
            Import {validation.contractsValid.toLocaleString('th-TH')} สัญญา
            {' + '}
            {(installments.length - validation.installmentsOrphan).toLocaleString('th-TH')} งวด
            <ChevronRight className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  )
}

// ===== Step 3 — Importing with progress bar =====

interface Step3Props {
  progress: number
  batchesDone: number
  totalBatches: number
  batchErrors: number
}

function Step3Importing({ progress, batchesDone, totalBatches, batchErrors }: Step3Props) {
  return (
    <Card>
      <h3 className="mb-5 text-base font-bold text-ink">Step 3 — กำลัง Import...</h3>
      <div className="space-y-4">
        <div className="h-3 overflow-hidden rounded-full bg-peach">
          <div
            className="h-3 rounded-full bg-salmon-deep transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
        <p className="text-center text-sm text-ink-soft">
          Batch {batchesDone} / {totalBatches}
          {batchErrors > 0 && (
            <span className="ml-3 text-red-600">({batchErrors} batch ล้มเหลว)</span>
          )}
        </p>
        <p className="text-center text-xs text-ink-soft">กรุณารอสักครู่ อย่าปิดหน้าต่างนี้</p>
      </div>
    </Card>
  )
}

// ===== Step 4 — Report =====

interface Step4Props {
  result: ImportResult
  allErrors: ImportError[]
  onGoToCustomers: () => void
  onStartOver: () => void
}

function Step4Report({ result, allErrors, onGoToCustomers, onStartOver }: Step4Props) {
  const hasErrors = allErrors.length > 0

  function handleDownloadErrors() {
    const today = new Date().toISOString().slice(0, 10)
    triggerDownload(buildErrorCSV(allErrors), `import_errors_${today}.csv`)
  }

  return (
    <Card>
      <div className="mb-6 flex items-center gap-3">
        <CheckCircle2 className="h-8 w-8 text-green-600" />
        <h3 className="text-base font-bold text-ink">Step 4 — Import เสร็จสิ้น</h3>
      </div>

      <div className="mb-6 grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-peach bg-white px-4 py-3 text-center">
          <div className="text-2xl font-bold text-green-700">
            {result.contractsCreated.toLocaleString('th-TH')}
          </div>
          <div className="mt-1 text-xs text-ink-soft">สัญญาที่ import สำเร็จ</div>
        </div>
        <div className="rounded-xl border border-peach bg-white px-4 py-3 text-center">
          <div className="text-2xl font-bold text-green-700">
            {result.installmentsCreated.toLocaleString('th-TH')}
          </div>
          <div className="mt-1 text-xs text-ink-soft">งวดที่ import สำเร็จ</div>
        </div>
        <div className="rounded-xl border border-peach bg-white px-4 py-3 text-center">
          <div className="text-2xl font-bold text-ink">
            {result.paymentsLogged.toLocaleString('th-TH')}
          </div>
          <div className="mt-1 text-xs text-ink-soft">รายการชำระที่บันทึก</div>
        </div>
      </div>

      {hasErrors && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <p className="mb-2 text-sm font-semibold text-red-700">
            มี {allErrors.length.toLocaleString('th-TH')} รายการที่ import ไม่สำเร็จ
          </p>
          <ul className="mb-3 max-h-36 space-y-1 overflow-y-auto text-xs text-red-700">
            {allErrors.slice(0, 20).map((e, i) => (
              <li key={i} className="font-mono">
                ({e.invoiceNo}): {e.error}
              </li>
            ))}
            {allErrors.length > 20 && (
              <li className="text-red-400">... และอีก {allErrors.length - 20} รายการ</li>
            )}
          </ul>
          <Button variant="ghost" onClick={handleDownloadErrors}>
            <Download className="h-4 w-4" />
            ดาวน์โหลด CSV ของ row ที่ fail
          </Button>
        </div>
      )}

      <div className="flex gap-3">
        <Button variant="ghost" onClick={onStartOver}>
          Import ใหม่อีกครั้ง
        </Button>
        <Button variant="primary" onClick={onGoToCustomers} className="flex-1">
          ไปหน้าลูกค้าทั้งหมด
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  )
}

// ===== Step indicator =====

function StepDot({ num, active, done }: { num: number; active: boolean; done: boolean }) {
  const bg = done
    ? 'bg-green-500 text-white'
    : active
      ? 'bg-salmon-deep text-white'
      : 'bg-peach text-ink-soft'
  return (
    <div
      className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${bg}`}
    >
      {done ? <CheckCircle2 className="h-4 w-4" /> : num}
    </div>
  )
}

function StepBar({ step }: { step: number }) {
  const labels = ['อัปโหลด', 'ตรวจสอบ', 'Import', 'รายงาน']
  return (
    <div className="mb-6 flex items-center gap-0">
      {labels.map((label, i) => (
        <div key={i} className="flex items-center">
          <div className="flex flex-col items-center gap-1">
            <StepDot num={i + 1} active={step === i + 1} done={step > i + 1} />
            <span
              className={`text-xs ${step === i + 1 ? 'font-semibold text-ink' : 'text-ink-soft'}`}
            >
              {label}
            </span>
          </div>
          {i < labels.length - 1 && (
            <div
              className={`mb-4 h-0.5 w-16 ${step > i + 1 ? 'bg-green-400' : 'bg-peach'}`}
            />
          )}
        </div>
      ))}
    </div>
  )
}

// ===== Aggregated result shape (across all batches) =====

interface AggregatedResult {
  contractsCreated: number
  installmentsCreated: number
  paymentsLogged: number
  errors: ImportError[]
}

// ===== Main Page =====

type WizardStep = 1 | 2 | 3 | 4

export default function Import() {
  const { role, configured } = useAuth()
  const isAdmin = !configured || role === 'admin'
  const navigate = useNavigate()

  // Admin guard (in-component double-guard)
  if (!isAdmin) return <Navigate to="/" replace />

  const [step, setStep] = useState<WizardStep>(1)
  const [contracts, setContracts] = useState<PJContract[]>([])
  const [installments, setInstallments] = useState<PJInstallment[]>([])
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [validationLoading, setValidationLoading] = useState(false)
  const [autoCreateShops, setAutoCreateShops] = useState(false)

  // Step 3 progress
  const [progress, setProgress] = useState(0)
  const [batchesDone, setBatchesDone] = useState(0)
  const [totalBatches, setTotalBatches] = useState(0)
  const [batchErrors, setBatchErrors] = useState(0)

  // Step 4 aggregated result
  const [aggregated, setAggregated] = useState<AggregatedResult | null>(null)

  // ===== Step 1 → 2 =====
  function handleParsed(parsedContracts: PJContract[], parsedInstallments: PJInstallment[]) {
    setContracts(parsedContracts)
    setInstallments(parsedInstallments)
    setValidation(null)
    setAutoCreateShops(false)
    setStep(2)
    setValidationLoading(true)

    getShops()
      .then((shops) => {
        const knownShopNames = new Set(shops.map((s) => s.name))
        setValidation(validate(parsedContracts, parsedInstallments, knownShopNames))
      })
      .catch(() => {
        setValidation({
          contractsValid: 0,
          contractErrors: ['ไม่สามารถตรวจสอบกับฐานข้อมูลได้ — กรุณาลองใหม่'],
          installmentsOrphan: 0,
          installmentErrors: [],
          unknownShops: [],
        })
      })
      .finally(() => setValidationLoading(false))
  }

  // ===== Step 2 → 3 =====
  async function handleConfirmImport() {
    if (!validation) return
    setStep(3)
    setProgress(0)
    setBatchesDone(0)
    setBatchErrors(0)

    // Filter to valid contracts only (those without client-side errors)
    const errorInvoiceNos = new Set(
      validation.contractErrors
        .map((e) => {
          const m = e.match(/\(([^)]+)\)/)
          return m ? m[1] : ''
        })
        .filter(Boolean),
    )
    const validContracts = contracts.filter((c) => c.invoice_no && !errorInvoiceNos.has(c.invoice_no))
    const validInstallments = installments.filter((inst) => {
      // keep only installments whose invoice_no is in a valid contract
      return validContracts.some((c) => c.invoice_no === inst.invoice_no)
    })

    const batches = buildBatches(validContracts, validInstallments)
    setTotalBatches(batches.length)

    const result: AggregatedResult = {
      contractsCreated: 0,
      installmentsCreated: 0,
      paymentsLogged: 0,
      errors: [],
    }

    let errCount = 0

    for (const batch of batches) {
      try {
        const res = await importPjBatch(
          batch.contracts,
          batch.installments,
          batch.batchNo,
          autoCreateShops,
        )
        result.contractsCreated += res.contractsCreated
        result.installmentsCreated += res.installmentsCreated
        result.paymentsLogged += res.paymentsLogged
        result.errors.push(...res.errors)
        if (res.errors.length > 0) {
          errCount++
          setBatchErrors(errCount)
        }
      } catch (e: unknown) {
        errCount++
        setBatchErrors(errCount)
        // Mark all contracts in this batch as failed
        for (const c of batch.contracts) {
          result.errors.push({
            invoiceNo: c.invoice_no,
            batch: batch.batchNo,
            error: e instanceof Error ? e.message : 'Batch call ล้มเหลว',
          })
        }
      }

      setBatchesDone(batch.batchNo)
      setProgress(Math.round((batch.batchNo / batches.length) * 100))
    }

    setAggregated(result)
    setStep(4)
  }

  function handleStartOver() {
    setStep(1)
    setContracts([])
    setInstallments([])
    setValidation(null)
    setAutoCreateShops(false)
    setProgress(0)
    setBatchesDone(0)
    setTotalBatches(0)
    setBatchErrors(0)
    setAggregated(null)
  }

  // Build a fake ImportResult for Step4Report (it expects the fields)
  const step4Result: ImportResult | null = aggregated
    ? {
        batchNo: totalBatches,
        imported: aggregated.contractsCreated,
        contractsCreated: aggregated.contractsCreated,
        installmentsCreated: aggregated.installmentsCreated,
        paymentsLogged: aggregated.paymentsLogged,
        errors: aggregated.errors,
      }
    : null

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <PageTitle sub="นำเข้าสัญญาและประวัติการชำระจาก PJ (Full history mode)">
        Import / Export
      </PageTitle>

      <StepBar step={step} />

      {step === 1 && <Step1Upload onParsed={handleParsed} />}

      {step === 2 && (
        <Step2Preview
          contracts={contracts}
          installments={installments}
          autoCreateShops={autoCreateShops}
          onAutoCreateShopsChange={setAutoCreateShops}
          validation={validation}
          loading={validationLoading}
          onConfirm={handleConfirmImport}
          onBack={() => setStep(1)}
        />
      )}

      {step === 3 && (
        <Step3Importing
          progress={progress}
          batchesDone={batchesDone}
          totalBatches={totalBatches}
          batchErrors={batchErrors}
        />
      )}

      {step === 4 && step4Result && aggregated && (
        <Step4Report
          result={step4Result}
          allErrors={aggregated.errors}
          onGoToCustomers={() => navigate('/customers')}
          onStartOver={handleStartOver}
        />
      )}
    </div>
  )
}
