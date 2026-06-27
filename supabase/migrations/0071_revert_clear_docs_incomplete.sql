-- 0071: revert_doc_receipt — ตอนตีกลับเอกสาร (item_type='docs') ให้เคลียร์ธง "เอกสารไม่ครบ" ด้วย
-- ปัญหา: 0051 รีเซ็ตแค่ original_docs_received แต่ไม่แตะ docs_incomplete* (เพิ่มใน 0070)
--   → ตีกลับแล้วธง "เอกสารไม่ครบ" ค้างใน DB ทำข้อมูลขัดกัน 2 หน้า
-- แก้: create or replace RPC เดิม (body เหมือน 0051 เป๊ะ) + เพิ่ม clear docs_incomplete*
--   เฉพาะ branch item_type='docs' (branch 'box' ไม่แตะธงนี้)
-- idempotent: create or replace, signature/security/search_path เดิมทุกตัว

create or replace function public.revert_doc_receipt(
  p_contract_id uuid,
  p_item_type   text,   -- 'docs' หรือ 'box'
  p_reason      text,
  p_by          text    -- ชื่อผู้ตีกลับ (useAuth().name ฝั่ง client)
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- SECURITY GUARD: freelancer ห้ามเรียก RPC นี้
  if not (is_admin() or is_staff()) then
    raise exception 'permission denied: revert_doc_receipt requires admin or staff role';
  end if;

  -- Validate item_type
  if p_item_type not in ('docs', 'box') then
    raise exception 'invalid item_type: %. must be ''docs'' or ''box''', p_item_type;
  end if;

  -- UPDATE contracts — reset flag ตาม item_type
  if p_item_type = 'docs' then
    update public.contracts
       set original_docs_received    = false,
           original_docs_received_at = null,
           original_docs_received_by = null,
           -- 0071: เคลียร์ธง "เอกสารไม่ครบ" (0070) ในคำสั่งเดียวกัน กันธงค้าง
           docs_incomplete           = false,
           docs_incomplete_items     = '[]'::jsonb,
           docs_incomplete_at        = null,
           docs_incomplete_by        = null
     where id = p_contract_id;
  else
    -- 'box'
    update public.contracts
       set phone_box_received    = false,
           phone_box_received_at = null,
           phone_box_received_by = null
     where id = p_contract_id;
  end if;

  -- INSERT ประวัติการตีกลับ (ทำหลัง UPDATE กัน log ค้างเมื่อ UPDATE fail)
  insert into public.doc_reject_log (
    contract_id,
    item_type,
    reason,
    rejected_by,
    rejected_at
  ) values (
    p_contract_id,
    p_item_type,
    p_reason,
    p_by,
    now()
  );
end;
$$;

-- Grant execute (idempotent — re-grant ปลอดภัย)
grant execute on function public.revert_doc_receipt(uuid, text, text, text)
  to authenticated, service_role;
