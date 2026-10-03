import { useEffect, useMemo, useState } from 'react'
import { getLatestRejectReasons } from './db'

/** contractId -> เหตุผลที่แอดมินตีกลับล่าสุด
 *  - ไม่มี key = ยังโหลดไม่เสร็จ
 *  - null      = โหลดเสร็จแล้วแต่ไม่พบเหตุผล (หรือโหลดไม่สำเร็จ) */
export type RejectReasonMap = Partial<Record<string, string | null>>

/** ดึงเหตุผลตีกลับของเคส needs_fix "ครั้งเดียวต่อชุดเคส" (getLatestRejectReasons = query เดียวต่อ chunk ไม่ยิงทีละสัญญา)
 *  ใช้ร่วมกันที่หน้า "งานที่ต้องแก้" (/review-queue) และ "รอสรุปยอด" (/waiting-summary)
 *  id ที่ไม่มีแถวตีกลับใน DB = null · query พัง = ทุก id เป็น null (หน้าโชว์ "ไม่พบเหตุผลที่บันทึกไว้")
 *  ส่ง [] = ไม่ยิง query เลย */
export function useRejectReasons(contractIds: string[]): RejectReasonMap {
  const [reasons, setReasons] = useState<RejectReasonMap>({})

  // ทำ key จากชุด id (เรียง+ตัดซ้ำ) เพื่อให้ effect ยิงเฉพาะตอนชุดเปลี่ยนจริง ไม่ใช่ทุกครั้งที่ array ถูกสร้างใหม่
  const key = useMemo(() => [...new Set(contractIds)].sort().join(','), [contractIds])

  useEffect(() => {
    if (key === '') return
    const ids = key.split(',')
    let cancelled = false
    getLatestRejectReasons(ids)
      .then((found) => ids.map((id): [string, string | null] => [id, found.get(id)?.reason ?? null]))
      .catch(() => ids.map((id): [string, string | null] => [id, null]))
      .then((entries) => {
        if (cancelled) return
        setReasons(Object.fromEntries(entries))
      })
    return () => {
      cancelled = true
    }
  }, [key])

  return reasons
}
