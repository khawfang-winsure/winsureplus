import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Card, EmptyState, Loading, PageTitle } from '../components/ui'
import { baht } from '../lib/format'
import {
  getFreelancerQueue,
  getMyAssignedGrades,
  getPublicHolidays,
  type ContractGrade,
  type FreelancerQueueRow,
} from '../lib/db'
import { useAuth } from '../lib/auth'
import { isContactWindowOpen } from '../lib/contactHours'
import FollowUpModal from '../components/FollowUpModal'

// ===== ป้ายกำกับเกรด + สีตาม Badge tone =====
const GRADE_TONE: Record<ContractGrade, 'red' | 'amber' | 'neutral'> = {
  A: 'neutral',
  B: 'neutral',
  C: 'amber',
  D: 'amber',
  E: 'red',
}

// ===== Banner นอกเวลาทวงถาม =====
function OutsideHoursBanner() {
  return (
    <div className="mb-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
      <span className="font-semibold">นอกเวลาทวงถามตามกฎหมาย</span>
      {' '}— การติดต่อลูกค้าอนุญาตเฉพาะ{' '}
      <span className="font-medium">08:00–20:00 (จ–ศ)</span> และ{' '}
      <span className="font-medium">08:00–18:00 (ส–อา+วันหยุดราชการ)</span>
    </div>
  )
}

// ===== Component =====
export default function FreelancerWorkspace() {
  const { role } = useAuth()
  const [assignedGrades, setAssignedGrades] = useState<ContractGrade[]>([])
  const [selectedGrades, setSelectedGrades] = useState<ContractGrade[]>([])
  const [rows, setRows] = useState<FreelancerQueueRow[]>([])
  const [loading, setLoading] = useState(true)
  const [shopFilter, setShopFilter] = useState<string>('')
  const [selectedContract, setSelectedContract] = useState<FreelancerQueueRow | null>(null)
  const [publicHolidays, setPublicHolidays] = useState<Set<string>>(new Set())

  // ตรวจเวลา render-time (ไม่มี ticking — กฎนี้เป็น UX hint เท่านั้น DB trigger บังคับจริง)
  const windowResult = isContactWindowOpen(new Date(), publicHolidays)
  // admin ข้ามกฎเวลา (DB trigger ยกเว้น admin อยู่แล้ว) — freelancer/staff บังคับปกติ
  const outsideHours = role !== 'admin' && !windowResult.ok

  // โหลด public holidays ครั้งเดียวตอน mount
  useEffect(() => {
    getPublicHolidays().then(setPublicHolidays)
  }, [])

  // โหลดเกรดที่ได้รับมอบหมาย
  const loadGrades = useCallback(async () => {
    const grades = await getMyAssignedGrades()
    setAssignedGrades(grades)
    setSelectedGrades(grades) // เลือกทุกเกรดโดยค่าตั้งต้น
    return grades
  }, [])

  // โหลดคิว
  const loadQueue = useCallback(async (grades: ContractGrade[]) => {
    setLoading(true)
    try {
      const data = await getFreelancerQueue(grades)
      setRows(data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadGrades().then((grades) => {
      if (grades.length > 0) void loadQueue(grades)
      else setLoading(false)
    })
  }, [loadGrades, loadQueue])

  // สลับเกรดที่เลือก
  function toggleGrade(grade: ContractGrade) {
    setSelectedGrades((prev) => {
      const next = prev.includes(grade)
        ? prev.filter((g) => g !== grade)
        : [...prev, grade]
      void loadQueue(next)
      return next
    })
  }

  // ดึงรายการร้านไม่ซ้ำจากแถวที่โหลดมา (ไม่ต้องเรียก shops_basic เพิ่ม)
  const shopOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of rows) seen.set(r.shopId, r.shopName)
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [rows])

  // กรองตามร้าน
  const filtered = useMemo(
    () => (shopFilter ? rows.filter((r) => r.shopId === shopFilter) : rows),
    [rows, shopFilter],
  )

  return (
    <div>
      <PageTitle sub="รายการลูกค้าที่ต้องติดตามตามเกรดที่ได้รับมอบหมาย">
        คิวติดตามหนี้ — ผู้ติดตามหนี้
      </PageTitle>

      {/* banner นอกเวลา (แสดงเฉพาะเมื่อนอกเวลากฎหมาย) */}
      {outsideHours && <OutsideHoursBanner />}

      {/* grade filter chips */}
      {assignedGrades.length > 0 && (
        <Card className="mb-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink">เกรด:</span>
            {assignedGrades.map((grade) => {
              const active = selectedGrades.includes(grade)
              return (
                <button
                  key={grade}
                  onClick={() => toggleGrade(grade)}
                  className={`rounded-full border px-4 py-1.5 text-sm font-semibold transition ${
                    active
                      ? 'border-salmon-deep bg-salmon-deep text-white shadow-sm'
                      : 'border-peach bg-white text-ink-soft hover:bg-peach-light'
                  }`}
                >
                  เกรด {grade}
                </button>
              )
            })}

            {/* shop filter */}
            {shopOptions.length > 1 && (
              <select
                value={shopFilter}
                onChange={(e) => setShopFilter(e.target.value)}
                className="ml-2 rounded-xl border border-peach bg-white px-3 py-1.5 text-sm text-ink outline-none transition focus:border-salmon-deep"
              >
                <option value="">ทุกร้าน</option>
                {shopOptions.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </Card>
      )}

      {/* ตารางคิว */}
      {loading ? (
        <Loading />
      ) : assignedGrades.length === 0 ? (
        <EmptyState
          title="ยังไม่ได้รับมอบหมายเกรด"
          hint="กรุณาติดต่อผู้ดูแลระบบเพื่อรับมอบหมายเกรดการติดตามหนี้"
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="ยังไม่มีลูกค้าที่ต้องตามในเกรดที่ได้รับมอบหมาย"
          hint="เมื่อมีลูกค้าค้างชำระในเกรดของคุณ จะปรากฏที่นี่"
        />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-peach bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-peach bg-cream-deep text-left text-xs font-semibold text-ink-soft">
                <th className="px-4 py-3">ลูกค้า</th>
                <th className="px-4 py-3">ร้าน</th>
                <th className="px-4 py-3 text-center">เกรด</th>
                <th className="px-4 py-3 text-right">ค้าง (วัน)</th>
                <th className="px-4 py-3 text-right">ค่างวด</th>
                <th className="px-4 py-3 text-right">ยอดค้าง</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const isBlocked = r.dnc || r.lawyerEngaged
                const disableButton = outsideHours || isBlocked

                // คำอธิบาย tooltip
                let blockReason = ''
                if (outsideHours) blockReason = 'นอกเวลาทวงถามตามกฎหมาย'
                else if (r.dnc) blockReason = 'สัญญานี้อยู่ในสถานะห้ามติดต่อ (DNC)'
                else if (r.lawyerEngaged) blockReason = 'สัญญานี้มีทนายความ กรุณาติดต่อทนายแทน'

                return (
                  <tr
                    key={r.contractId}
                    className="border-b border-peach last:border-0 hover:bg-peach-light/20"
                  >
                    <td className="px-4 py-3">
                      {/* บรรทัดธงสถานะ (ถ้ามี) */}
                      {(r.dnc || r.lawyerEngaged || r.disputed) && (
                        <div className="mb-1 flex flex-wrap gap-1">
                          {r.dnc && <Badge tone="red">⛔ ห้ามติดต่อ (DNC)</Badge>}
                          {r.lawyerEngaged && !r.dnc && <Badge tone="amber">⚖️ มีทนายความ</Badge>}
                          {r.disputed && <Badge tone="amber">📋 โต้แย้งยอด</Badge>}
                        </div>
                      )}
                      <p className={`font-medium ${isBlocked ? 'text-ink-soft' : 'text-ink'}`}>
                        {r.customerName}
                      </p>
                      <p className="text-xs text-ink-soft">{r.contractNo}</p>
                      {r.phone && <p className="text-xs text-ink-soft">{r.phone}</p>}
                    </td>
                    <td className="px-4 py-3 text-ink-soft">{r.shopName}</td>
                    <td className="px-4 py-3 text-center">
                      <Badge tone={GRADE_TONE[r.grade]}>เกรด {r.grade}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-semibold text-red-600">{r.daysLate}</span>
                    </td>
                    <td className="px-4 py-3 text-right text-ink">{baht(r.monthlyPayment)} ฿</td>
                    <td className="px-4 py-3 text-right">
                      {r.outstanding > 0 ? (
                        <span className="font-semibold text-red-600">{baht(r.outstanding)} ฿</span>
                      ) : (
                        <span className="text-ink-soft">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        disabled={disableButton}
                        onClick={() => !disableButton && setSelectedContract(r)}
                        title={blockReason || undefined}
                        className={`whitespace-nowrap rounded-xl border px-3 py-2 text-xs font-semibold transition ${
                          disableButton
                            ? 'cursor-not-allowed border-peach bg-peach-light/40 text-ink-soft opacity-60'
                            : 'border-peach bg-white text-ink hover:bg-peach-light/50'
                        }`}
                      >
                        บันทึกติดตาม
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="px-4 py-2 text-xs text-ink-soft">
            แสดง {filtered.length} รายการ
            {shopFilter && ` (กรองตามร้าน)`}
          </p>
        </div>
      )}

      {/* modal */}
      {selectedContract && (
        <FollowUpModal
          contract={{
            contractId: selectedContract.contractId,
            contractNo: selectedContract.contractNo,
            customerName: selectedContract.customerName,
            phone: selectedContract.phone,
            shopName: selectedContract.shopName,
            daysLate: selectedContract.daysLate,
          }}
          publicHolidays={publicHolidays}
          onClose={() => setSelectedContract(null)}
        />
      )}
    </div>
  )
}
