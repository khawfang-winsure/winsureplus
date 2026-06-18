import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { User, Phone, CreditCard, ChevronRight, History, MessageCircle, MessageSquarePlus } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Loading, PageTitle } from '../components/ui'
import { baht, maskNationalId, statusLabel } from '../lib/format'
import {
  getCustomerAggregate,
  getPaymentLog,
  getFollowUps,
  type CustomerAggregate,
  type CustomerContractItem,
  type PaymentLogEntry,
  type FollowUpEntry,
  type FollowUpResult,
} from '../lib/db'
import { useAuth } from '../lib/auth'
import FollowUpModal from '../components/FollowUpModal'

// ---------- helpers ----------

/** เวลาไทยแบบสั้น (วัน/เดือน/ปี เวลา) — mirror ContractDetail.tsx เพื่อให้ปีเป็น ค.ศ. */
function thaiDateTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const time = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
  return `${dd}/${mm}/${d.getFullYear()} ${time}`
}

const ACTION_LABEL: Record<PaymentLogEntry['action'], string> = {
  pay: 'ยืนยันชำระ',
  edit: 'แก้ไขยอด',
  cancel: 'ยกเลิก',
}
type BadgeTone = 'green' | 'amber' | 'red' | 'neutral'
const ACTION_TONE: Record<PaymentLogEntry['action'], BadgeTone> = {
  pay: 'green',
  edit: 'amber',
  cancel: 'red',
}

const FU_RESULT_LABEL: Record<FollowUpResult, string> = {
  contacted: 'ติดต่อสำเร็จ',
  no_answer: 'ไม่รับสาย',
  promised: 'สัญญาจะจ่าย',
  refused: 'ปฏิเสธ',
  paid: 'จ่ายแล้ว',
  returned: 'คืนเครื่อง',
  line_pending: 'นัดทาง LINE – รอลูกค้า',
  other: 'อื่นๆ',
}
const FU_RESULT_TONE: Record<FollowUpResult, BadgeTone> = {
  contacted: 'green',
  no_answer: 'neutral',
  promised: 'green',
  refused: 'red',
  paid: 'green',
  returned: 'amber',
  line_pending: 'amber',
  other: 'neutral',
}

// ── flattened types สำหรับ Customer 360 ──────────────────────────────────────
interface FlatPayment extends PaymentLogEntry {
  contractId: string
  contractNo: string
}
interface FlatFollowUp extends FollowUpEntry {
  contractNo: string
}

// ป้ายสถานะที่ใช้ bucket inline จาก CustomerContractItem (ไม่ใช่ ContractStatusRow)
function ContractStatusPill({ item }: { item: CustomerContractItem }) {
  if (item.status !== 'active') {
    return <Badge tone="neutral">{statusLabel(item.status)}</Badge>
  }
  if (item.bucket === '91-120' || item.bucket === '120+') {
    return <Badge tone="red">หนี้เสีย</Badge>
  }
  if (item.bucket !== 'normal') {
    return <Badge tone="amber">ล่าช้า {item.daysLate} วัน</Badge>
  }
  return <Badge tone="green">ผ่อนปกติ</Badge>
}

// Card แสดงสัญญา 1 รายการ
function ContractRow({
  item,
  onFollowUp,
  canFollowUp,
}: {
  item: CustomerContractItem
  onFollowUp: (item: CustomerContractItem) => void
  canFollowUp: boolean
}) {
  const progress = `${item.paidInstallments}/${item.termMonths}`
  return (
    <div className="rounded-xl border border-peach bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink">{item.contractNo}</span>
            <ContractStatusPill item={item} />
          </div>
          <p className="mt-0.5 text-sm text-ink-soft">
            {item.deviceModel || '—'}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-soft">
            {item.shopName && <span>ร้าน: {item.shopName}</span>}
            <span>งวด {progress}</span>
            {item.monthlyPayment > 0 && (
              <span>{baht(item.monthlyPayment)} ฿/เดือน</span>
            )}
            {item.status === 'active' && item.outstanding > 0 && (
              <span className="text-red-600">ค้างอยู่ {baht(item.outstanding)} ฿</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {canFollowUp && (
            <Button variant="ghost" onClick={() => onFollowUp(item)}>
              <MessageSquarePlus size={13} /> บันทึกการคุย
            </Button>
          )}
          <Link
            to={`/contract/${item.contractId}`}
            className="inline-flex items-center gap-1 rounded-lg border border-peach px-2.5 py-1.5 text-xs text-ink-soft hover:bg-peach-light"
          >
            ดูรายละเอียด
            <ChevronRight size={13} />
          </Link>
        </div>
      </div>
    </div>
  )
}

export default function CustomerDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { role } = useAuth()
  const canStaff = role === 'admin' || role === 'staff'

  const [agg, setAgg] = useState<CustomerAggregate | null | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [followUpTarget, setFollowUpTarget] = useState<CustomerContractItem | null>(null)

  // ── Customer 360: ประวัติการชำระ + ประวัติการติดตาม ────────────────────────
  const [recentPayments, setRecentPayments] = useState<FlatPayment[]>([])
  const [recentFollowUps, setRecentFollowUps] = useState<FlatFollowUp[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  useEffect(() => {
    if (!id) {
      navigate('/customers', { replace: true })
      return
    }
    let active = true
    setLoading(true)
    setError(null)
    getCustomerAggregate(id)
      .then((result) => {
        if (!active) return
        setAgg(result)

        // เมื่อได้ contracts แล้ว ดึงประวัติแบบขนาน (Approach A: per-contract)
        if (!result || result.contracts.length === 0) return
        const contractList = result.contracts
        const contractNoMap = new Map(contractList.map((c) => [c.contractId, c.contractNo]))

        setHistoryLoading(true)
        Promise.all([
          Promise.all(contractList.map((c) => getPaymentLog(c.contractId)
            .then((entries) => entries.map((e): FlatPayment => ({
              ...e,
              contractId: c.contractId,
              contractNo: contractNoMap.get(c.contractId) ?? c.contractId,
            })))
          )),
          Promise.all(contractList.map((c) => getFollowUps(c.contractId)
            .then((entries) => entries.map((e): FlatFollowUp => ({
              ...e,
              contractNo: contractNoMap.get(c.contractId) ?? c.contractId,
            })))
          )),
        ])
          .then(([payArrays, fuArrays]) => {
            if (!active) return
            const pays = payArrays.flat().sort(
              (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
            )
            const fus = fuArrays.flat().sort(
              (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
            )
            setRecentPayments(pays.slice(0, 10))
            setRecentFollowUps(fus.slice(0, 10))
          })
          .catch(() => {
            // ไม่ block UI หลัก — sections ว่างเงียบๆ แทน
          })
          .finally(() => {
            if (active) setHistoryLoading(false)
          })
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [id, navigate])

  if (loading) return <Loading />

  if (error) {
    return (
      <EmptyState
        title="โหลดข้อมูลไม่สำเร็จ"
        hint={error}
      />
    )
  }

  // null = mock mode หรือหาไม่พบ contract
  if (agg === null || agg === undefined) {
    return (
      <EmptyState
        title="ไม่พบข้อมูลลูกค้า"
        hint="ลองตรวจสอบเลขสัญญา หรือกลับไปที่รายการลูกค้า"
      />
    )
  }

  const altPhones = [agg.phoneAlt1, agg.phoneAlt2].filter((p): p is string => !!p)

  return (
    <div className="space-y-5">
      <PageTitle sub="ดูทุกสัญญาของลูกค้าคนนี้" count={{ shown: agg.totalContracts }}>
        <User size={20} className="mr-2 inline-block align-text-bottom" />
        {agg.customerName}
      </PageTitle>

      {/* Card: ข้อมูลลูกค้า */}
      <Card>
        <h3 className="mb-3 text-sm font-semibold text-ink">ข้อมูลลูกค้า</h3>
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2 text-ink">
            <CreditCard size={14} className="shrink-0 text-ink-soft" />
            <span className="text-ink-soft">บัตรประชาชน:</span>
            <span className="font-medium tabular-nums">
              {maskNationalId(agg.nationalId ?? undefined)}
            </span>
          </div>
          <div className="flex items-center gap-2 text-ink">
            <Phone size={14} className="shrink-0 text-ink-soft" />
            <span className="text-ink-soft">เบอร์โทร:</span>
            <span className="font-medium">{agg.phone ?? '—'}</span>
          </div>
          {altPhones.map((p, i) => (
            <div key={p} className="flex items-center gap-2 text-ink">
              <Phone size={14} className="shrink-0 text-ink-soft opacity-0" />
              <span className="text-ink-soft">เบอร์สำรอง {i + 1}:</span>
              <span className="font-medium">{p}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Card: สรุปรวม */}
      <Card>
        <h3 className="mb-3 text-sm font-semibold text-ink">สรุป</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatBox label="สัญญาทั้งหมด" value={String(agg.totalContracts)} />
          <StatBox label="ที่ผ่อนอยู่" value={String(agg.activeContracts)} highlight={agg.activeContracts > 0} />
          <StatBox label="ปิดแล้ว" value={String(agg.closedContracts)} />
          <StatBox
            label="ยอดค้างรวม"
            value={agg.totalOutstanding > 0 ? `${baht(agg.totalOutstanding)} ฿` : '—'}
            highlight={agg.totalOutstanding > 0}
            red
          />
          <StatBox
            label="ค่าปรับสะสม"
            value={agg.totalPenalty > 0 ? `${baht(agg.totalPenalty)} ฿` : '—'}
            red={agg.totalPenalty > 0}
          />
        </div>
      </Card>

      {/* List: รายการสัญญา */}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-ink">
          รายการสัญญาทั้งหมด ({agg.totalContracts})
        </h3>
        {agg.contracts.length === 0 ? (
          <EmptyState title="ยังไม่มีสัญญาในระบบ" />
        ) : (
          <div className="space-y-3">
            {agg.contracts.map((item) => (
              <ContractRow
                key={item.contractId}
                item={item}
                onFollowUp={(i) => setFollowUpTarget(i)}
                canFollowUp={canStaff}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Customer 360: ประวัติการชำระล่าสุด ──────────────────────────────── */}
      {(historyLoading || recentPayments.length > 0) && (
        <Card>
          <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink">
            <History size={15} />
            ประวัติการชำระล่าสุด
            {recentPayments.length > 0 && (
              <span className="ml-1 text-xs font-normal text-ink-soft">
                (แสดง {recentPayments.length} รายการล่าสุด)
              </span>
            )}
          </h3>
          {historyLoading ? (
            <p className="text-sm text-ink-soft">กำลังโหลด…</p>
          ) : (
            <ul className="divide-y divide-peach">
              {recentPayments.map((p) => (
                <li key={p.id} className="py-2.5 text-sm first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <Badge tone={ACTION_TONE[p.action]}>{ACTION_LABEL[p.action]}</Badge>
                      {p.action !== 'cancel' && (
                        <span className="font-semibold text-ink tabular-nums">
                          {baht(p.amount)} ฿
                        </span>
                      )}
                      {p.byName && (
                        <span className="text-xs text-ink-soft">โดย {p.byName}</span>
                      )}
                    </span>
                    <span className="text-xs text-ink-soft tabular-nums">
                      {thaiDateTime(p.createdAt)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-soft">
                    <Link
                      to={`/contract/${p.contractId}`}
                      className="font-medium text-salmon-deep hover:underline"
                    >
                      {p.contractNo}
                    </Link>
                    {p.note && <span>· {p.note}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {/* FollowUpModal — admin/staff บันทึกการคุย */}
      {followUpTarget && (
        <FollowUpModal
          contract={{
            contractId: followUpTarget.contractId,
            contractNo: followUpTarget.contractNo,
            customerName: agg.customerName,
            phone: agg.phone ?? null,
            shopName: followUpTarget.shopName ?? '',
            daysLate: followUpTarget.daysLate,
          }}
          adminOverride={role === 'admin'}
          onClose={() => setFollowUpTarget(null)}
        />
      )}

      {/* ── Customer 360: ประวัติการติดตามล่าสุด ──────────────────────────────── */}
      {(historyLoading || recentFollowUps.length > 0) && (
        <Card>
          <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink">
            <MessageCircle size={15} />
            ประวัติการติดตามล่าสุด
            {recentFollowUps.length > 0 && (
              <span className="ml-1 text-xs font-normal text-ink-soft">
                (แสดง {recentFollowUps.length} รายการล่าสุด)
              </span>
            )}
          </h3>
          {historyLoading ? (
            <p className="text-sm text-ink-soft">กำลังโหลด…</p>
          ) : (
            <ul className="divide-y divide-peach">
              {recentFollowUps.map((f) => (
                <li key={f.id} className="py-2.5 text-sm first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <Badge tone={FU_RESULT_TONE[f.followUpResult]}>
                        {FU_RESULT_LABEL[f.followUpResult]}
                      </Badge>
                      <span className="font-semibold text-ink">{f.authorName}</span>
                    </span>
                    <span className="text-xs text-ink-soft tabular-nums">
                      {thaiDateTime(f.createdAt)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                    <Link
                      to={`/contract/${f.contractId}`}
                      className="font-medium text-salmon-deep hover:underline"
                    >
                      {f.contractNo}
                    </Link>
                    {f.noteText && <span>· {f.noteText}</span>}
                    {f.followUpResult === 'promised' && f.promisedAmount != null && (
                      <span className="text-green-700">
                        · สัญญาจะจ่าย {baht(f.promisedAmount)} ฿
                      </span>
                    )}
                    {f.nextFollowUpAt && (
                      <span>· นัดติดตาม {thaiDateTime(f.nextFollowUpAt)}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  )
}

function StatBox({
  label,
  value,
  highlight = false,
  red = false,
}: {
  label: string
  value: string
  highlight?: boolean
  red?: boolean
}) {
  return (
    <div className="rounded-xl border border-peach bg-peach-light/30 p-3 text-center">
      <p className="text-xs text-ink-soft">{label}</p>
      <p
        className={`mt-1 text-lg font-bold tabular-nums ${
          red ? 'text-red-600' : highlight ? 'text-salmon-deep' : 'text-ink'
        }`}
      >
        {value}
      </p>
    </div>
  )
}
