-- 0105: ให้ "สรุปยอด" (ส่งร้าน / ส่งบัญชี) เกาะ "วันที่สรุปที่พนักงานเลือก" แทน now()
-- ────────────────────────────────────────────────────────────────────────────
-- บั๊ก (Pete รายงาน 2026-07-13): พนักงานเลือกวันที่สรุป = 12 แต่กดปุ่มจริงวันที่ 13
--   → /transfers (getDailyTransferByShop group ด้วย summary_accounting_sent_at) เห็นเคสอยู่วันที่ 13
-- Root cause: markSummaryShopSent / markSummaryAccountingSent (db.ts) เดิม stamp now() (เวลากดจริง)
--   ไม่เคยรับ "วันที่สรุปที่เลือก" เข้ามาเลย — date picker บนหน้าเป็นแค่ตัวกรอง/ป้ายข้อความ
--
-- แก้: ทำ 2 RPC ให้ Postgres ประกอบ timestamp = (วันที่เลือก + เวลานาฬิกาปัจจุบัน Bangkok)
--   pattern เดียวกับ 0094 update_contract_transfer_date (คงเวลานาฬิกาปัจจุบัน เปลี่ยนแค่วัน,
--   ผ่าน at time zone 'Asia/Bangkok') — กัน 00:00:00 เพี้ยน + tz off-by-one
-- ถ้า p_date เป็น null → fallback now() (backward compat กับ caller เดิมที่ยังไม่ส่งวัน)
--
-- SECURITY INVOKER (ไม่ใช่ DEFINER): คง permission model เดิมเป๊ะ — เดิม client update ตรง
--   ผ่าน RLS contracts_update (0095: admin OR staff). INVOKER = RLS ยังบังคับตามปกติ
--   ไม่ยกระดับสิทธิ์ ไม่ต้อง manual guard (ต่างจาก 0094 ที่เป็น admin-only DEFINER)
--
-- ผลข้างเคียง (ตั้งใจ): getDailyAudit/timeline อ่าน field เดียวกัน → event ส่งสรุปยอดย้ายวันตามที่เลือก
-- ไม่แตะ: shop_transfer.transfer_date (สลิป — คนละ field), transaction_date (วันขาย — weekly-summary)
-- additive เท่านั้น — เพิ่มแค่ RPC ใหม่ ไม่แตะคอลัมน์/policy เดิม

-- ============================================================================
-- helper (inline): ประกอบ timestamptz จากวันที่เลือก + เวลานาฬิกาปัจจุบัน Bangkok
--   นิยามซ้ำใน 2 ฟังก์ชันเพื่อไม่พึ่ง helper แยก (แต่ละ RPC standalone อ่านง่าย)
-- ============================================================================

-- ── รอบ 1: ส่งร้าน ─────────────────────────────────────────────────────────
-- mirror ทุก field ที่ markSummaryShopSent เดิมตั้ง (summary_shop_*, summary_sent_* mirror,
--   pending_documents=false, documents_confirmed_*) — ให้ทั้งก้อนเกาะวันที่เลือกอย่างสอดคล้อง
create or replace function public.mark_summary_shop_sent(
  p_ids    uuid[],
  p_sender text,
  p_date   date
)
returns void
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_ts timestamptz;
begin
  if p_ids is null or array_length(p_ids, 1) is null then
    return;
  end if;

  -- วันที่เลือก + เวลานาฬิกาปัจจุบัน (Bangkok) → timestamptz; null → now() (backward compat)
  if p_date is null then
    v_ts := now();
  else
    v_ts := (p_date + (now() at time zone 'Asia/Bangkok')::time) at time zone 'Asia/Bangkok';
  end if;

  update public.contracts
     set summary_shop_sent_at    = v_ts,
         summary_shop_sent_by    = p_sender,
         -- mirror สถานะรวมเดิม — audit log อ่าน summary_sent_at
         summary_sent_at         = v_ts,
         summary_sent_by         = p_sender,
         -- auto-clear รอเอกสาร เมื่อยืนยันสรุปยอด (confirm-gate model 0049)
         pending_documents       = false,
         documents_confirmed_at  = v_ts,
         documents_confirmed_by  = p_sender
   where id = any(p_ids);
end;
$$;

grant execute on function public.mark_summary_shop_sent(uuid[], text, date)
  to authenticated, service_role;

-- ── รอบ 2: ส่งบัญชี ────────────────────────────────────────────────────────
-- set summary_accounting_* เท่านั้น (mirror markSummaryAccountingSent เดิม — ไม่แตะ pending_documents)
create or replace function public.mark_summary_accounting_sent(
  p_ids    uuid[],
  p_sender text,
  p_date   date
)
returns void
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_ts timestamptz;
begin
  if p_ids is null or array_length(p_ids, 1) is null then
    return;
  end if;

  if p_date is null then
    v_ts := now();
  else
    v_ts := (p_date + (now() at time zone 'Asia/Bangkok')::time) at time zone 'Asia/Bangkok';
  end if;

  update public.contracts
     set summary_accounting_sent_at = v_ts,
         summary_accounting_sent_by = p_sender
   where id = any(p_ids);
end;
$$;

grant execute on function public.mark_summary_accounting_sent(uuid[], text, date)
  to authenticated, service_role;

-- ============================================================================
-- Verify checklist (รันหลัง apply ผ่าน MCP — ไม่รันในไฟล์นี้)
-- ============================================================================

-- a) RPC สร้างครบ 2 ตัว:
-- select routine_name from information_schema.routines
--  where routine_schema='public'
--    and routine_name in ('mark_summary_shop_sent','mark_summary_accounting_sent');
-- expected: 2 rows

-- b) authenticated execute ได้:
-- select has_function_privilege('authenticated', 'public.mark_summary_accounting_sent(uuid[], text, date)', 'EXECUTE');
-- expected: true

-- c) smoke — ส่งวันที่ย้อนหลัง แล้วเช็ควัน (Bangkok) ตรง เวลานาฬิกาไม่ใช่ 00:00:00:
-- select public.mark_summary_accounting_sent(array['<contract_id>']::uuid[], 'ทดสอบ', '2026-07-01'::date);
-- select (summary_accounting_sent_at at time zone 'Asia/Bangkok')::date as d,
--        (summary_accounting_sent_at at time zone 'Asia/Bangkok')::time as t
--   from public.contracts where id = '<contract_id>';
-- expected: d = 2026-07-01, t = เวลาปัจจุบันตอนรัน (ไม่ใช่ 00:00:00)

-- d) fallback null → now():
-- select public.mark_summary_accounting_sent(array['<contract_id>']::uuid[], 'ทดสอบ', null);
-- expected: summary_accounting_sent_at ≈ now()
