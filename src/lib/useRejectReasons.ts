import { useEffect, useMemo, useState } from 'react'
import { getReviewLog } from './db'
import type { ContractReviewLogEntry } from './types'

/** contractId -> เหตุผลที่แอดมินตีกลับล่าสุด
 *  - ไม่มี key = ยังโหลดไม่เสร็จ
 *  - null      = โหลดเสร็จแล้วแต่ไม่พบเหตุผล (หรือโหลดไม่สำเร็จ) */
export type RejectReasonMap = Partial<Record<string, string | null>>

/** log เรียงล่าสุดก่อน (getReviewLog) — หยิบแถวตีกลับล่าสุด (reject = ตีกลับจากรอตรวจ, cancel_approval = ยกเลิกการตรวจ)
 *  ข้ามแถวอื่น เช่น submit / force_summary_shop_sent ที่อาจเขียนทีหลังแต่ไม่ใช่เหตุผลที่ต้องแก้ */
function latestRejectReason(log: ContractReviewLogEntry[]): string | null {
  const entry = log.find((l) => l.action === 'reject' || l.action === 'cancel_approval')
  const reason = entry?.reason?.trim()
  return reason ? reason : null
}

/** ดึงเหตุผลตีกลับของเคส needs_fix "ครั้งเดียวต่อชุดเคส" (ไม่ยิงทีละแถวตอน render)
 *  ใช้ getReviewLog เดิมของ db.ts — ยิงขนานด้วย Promise.all ครั้งเดียวเมื่อชุด id เปลี่ยน
 *  ใช้ร่วมกันที่หน้า "งานที่ต้องแก้" (/review-queue) และ "รอสรุปยอด" (/waiting-summary)
 *  ส่ง [] = ไม่ยิง query เลย */
export function useRejectReasons(contractIds: string[]): RejectReasonMap {
  const [reasons, setReasons] = useState<RejectReasonMap>({})

  // ทำ key จากชุด id (เรียง+ตัดซ้ำ) เพื่อให้ effect ยิงเฉพาะตอนชุดเปลี่ยนจริง ไม่ใช่ทุกครั้งที่ array ถูกสร้างใหม่
  const key = useMemo(() => [...new Set(contractIds)].sort().join(','), [contractIds])

  useEffect(() => {
    if (key === '') return
    const ids = key.split(',')
    let cancelled = false
    Promise.all(
      ids.map((id) =>
        getReviewLog(id)
          .then(latestRejectReason)
          .catch((): string | null => null),
      ),
    ).then((list) => {
      if (cancelled) return
      setReasons(Object.fromEntries(ids.map((id, i): [string, string | null] => [id, list[i]])))
    })
    return () => {
      cancelled = true
    }
  }, [key])

  return reasons
}
