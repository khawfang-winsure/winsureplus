-- 0146: ให้ staff ลบรูปแนบที่แนบผิด/ซ้ำได้เอง แบบมีเงื่อนไข + บันทึกว่าใครแนบรูป (owner-approved 2026-09-09)
-- ปัญหาจริง: staff (คุณข้าวโพด) แนบรูปผิด/ซ้ำเข้าสัญญา S00018PNQ461 ลบเองไม่ได้ เพราะ policy
-- contract_media_update (0136) เป็น admin-only + UI ซ่อนปุ่มลบจาก staff — ต้องรอแอดมินทุกครั้ง
--
-- กฎที่คุณเตยเคาะ:
--   1) staff ลบรูปได้เฉพาะตอนเคส "ยังไม่ถูกส่งไปตรวจ" คือ contracts.review_status เป็น null
--      (ยังไม่ส่ง) หรือ 'needs_fix' (แอดมินตีกลับให้แก้) เท่านั้น — pending_review/approved ลบไม่ได้
--   2) admin ลบได้ทุกกรณีเหมือนเดิม
--   3) บันทึก uploaded_by ทุกครั้งที่แนบรูปใหม่ (ตอนนี้ 46 แถวเดิมเป็น null ทั้งหมด — ปล่อยไว้ ไม่ backfill มั่ว)
--
-- สถาปัตยกรรม (บทเรียนจาก 0142->0143: RLS เป็น row-level ไม่ครอบ column):
--   - policy contract_media_update (0136) คงเป็น admin-only เหมือนเดิม ห้ามแก้ ไม่เปิด UPDATE ให้ staff ตรงๆ
--     (ไม่งั้น staff ยิง REST แก้ path/sha256/slot_key/deleted_at ของแถวไหนก็ได้ตามใจ)
--   - เปิดทางผ่าน RPC media_soft_delete (SECURITY DEFINER) เท่านั้น — ตรวจสิทธิ์ในตัว RPC เอง,
--     เขียนแค่ deleted_at/deleted_by, ยกเว้น auth.uid() is null (service_role/owner/MCP/cron) ให้ผ่านเสมอ
--     (pattern เดียวกับ contracts_review_guard ใน 0143 — ไม่งั้น data fix ในอนาคต/Edge Function โดนบล็อก)
--
-- Additive/idempotent ทั้งหมด — create or replace function, ไม่แตะ policy/ตารางเดิมนอกจาก
-- alter column ... set default (ปลอดภัย ไม่กระทบแถวเดิม)

-- ============================================================================
-- SECTION 1: uploaded_by default = auth.uid() — กันลืมถาวร
-- (แถว insert จาก service_role/owner ไม่มี auth.uid() จะได้ null ตามเดิม ซึ่งถูกต้อง —
--  ไม่ backfill 46 แถวเก่าที่เป็น null อยู่แล้ว เพราะไม่รู้จริงว่าใครแนบ)
-- ============================================================================

alter table public.contract_media
  alter column uploaded_by set default auth.uid();

comment on column public.contract_media.uploaded_by is
  'คนที่แนบไฟล์ (auth.users.id) — default auth.uid() ตั้งแต่ 0146 (2026-09-09); แถวก่อนหน้านั้น (0136) เป็น null ทั้งหมด เพราะ db.ts ไม่เคยส่งค่านี้มา ไม่ backfill (ไม่รู้จริงว่าใครแนบ)';

-- ============================================================================
-- SECTION 2: RPC media_soft_delete — ทางเดียวที่ soft-delete contract_media ได้
-- (แทนที่ softDeleteMedia ใน db.ts ที่เคย update ตรง — ตอนนี้ policy update ยังเป็น admin-only เหมือนเดิม
--  RPC นี้ทำงานผ่าน SECURITY DEFINER ข้าม RLS ได้ หลังตรวจสิทธิ์เองในฟังก์ชันแล้ว)
-- ============================================================================

create or replace function public.media_soft_delete(p_media_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted_at    timestamptz;
  v_contract_id   uuid;
  v_review_status text;
begin
  select deleted_at, contract_id
    into v_deleted_at, v_contract_id
  from public.contract_media
  where id = p_media_id;

  if not found then
    raise exception 'ไม่พบไฟล์แนบนี้';
  end if;

  -- ลบไปแล้ว — เงียบ ไม่ error ซ้ำ (idempotent จากฝั่ง client ที่อาจกดซ้ำ/สองแท็บ)
  if v_deleted_at is not null then
    return;
  end if;

  -- ยกเว้น request ที่ไม่มี user login เลย (auth.uid() null) — service_role / Postgres owner (MCP/migration)
  -- / cron / Edge Function context — ให้ผ่านเสมอ (บทเรียนเดียวกับ contracts_review_guard ใน 0143:
  -- browser client ของ staff/admin ทุกตัวแนบ JWT เสมอ ดังนั้น auth.uid() null = ไม่ใช่ threat model นี้)
  if auth.uid() is null then
    update public.contract_media
       set deleted_at = now(),
           deleted_by = auth.uid()
     where id = p_media_id;
    return;
  end if;

  if public.is_admin() then
    -- admin ลบได้ทุกกรณี
    null;
  elsif public.is_staff() then
    select review_status into v_review_status
    from public.contracts
    where id = v_contract_id;

    if v_review_status is not null and v_review_status <> 'needs_fix' then
      raise exception 'เคสนี้ส่งให้ตรวจแล้ว ลบรูปไม่ได้ ถ้าต้องแก้ แจ้งแอดมิน';
    end if;
  else
    raise exception 'ไม่มีสิทธิ์ลบไฟล์แนบ';
  end if;

  update public.contract_media
     set deleted_at = now(),
         deleted_by = auth.uid()
   where id = p_media_id;
end;
$$;

comment on function public.media_soft_delete(uuid) is
  '(0146) ทางเดียวที่ soft-delete contract_media ได้ (policy contract_media_update ยังเป็น admin-only เหมือนเดิม — RPC นี้ SECURITY DEFINER ข้าม RLS หลังตรวจสิทธิ์เอง). admin ลบได้ทุกกรณี; staff ลบได้เฉพาะ contracts.review_status เป็น null/needs_fix (ยังไม่ส่งตรวจ/ถูกตีกลับ); auth.uid() null (service_role/owner/cron) ผ่านเสมอ; เขียนแค่ deleted_at/deleted_by เท่านั้น; แถวที่ลบไปแล้วเรียกซ้ำได้เงียบๆ ไม่ error';

grant execute on function public.media_soft_delete(uuid) to authenticated, service_role;

-- ============================================================================
-- Verify checklist สำหรับครีมรันหลัง apply (MCP) — ไม่รันอัตโนมัติในไฟล์นี้
-- ============================================================================

-- a) default ตั้งสำเร็จ:
-- select column_name, column_default from information_schema.columns
--  where table_name = 'contract_media' and column_name = 'uploaded_by';
-- expected: column_default = 'auth.uid()'

-- b) 46 แถวเดิมยัง null เหมือนเดิม (ไม่ backfill):
-- select count(*) from public.contract_media where uploaded_by is null;
-- expected: >= 46 (เท่าจำนวนก่อน apply บวกแถว insert ใหม่จาก service_role ถ้ามี)

-- c) RPC สร้างสำเร็จ + authenticated เรียกได้:
-- select routine_name from information_schema.routines
--  where routine_schema = 'public' and routine_name = 'media_soft_delete';
-- select has_function_privilege('authenticated', 'public.media_soft_delete(uuid)', 'EXECUTE');
-- expected: 1 row / true

-- d) policy contract_media_update ยังเป็น admin-only เหมือนเดิม (ไม่ถูกแก้โดยไฟล์นี้):
-- select policyname, cmd, qual, with_check from pg_policies
--  where tablename = 'contract_media' and policyname = 'contract_media_update';

-- e) trace ทดสอบผ่าน session staff จริง (JWT — service_role ไม่มี auth.uid() ที่ map เป็น profile ได้):
--   -- เคสที่ควรลบได้ (review_status null หรือ needs_fix):
--   select public.media_soft_delete('<media_id_on_contract_review_status_null>'::uuid);
--   -- expected: สำเร็จ, deleted_at ถูกตั้ง
--   -- เคสที่ควรถูกบล็อก (pending_review/approved):
--   select public.media_soft_delete('<media_id_on_contract_pending_review>'::uuid);
--   -- expected: ERROR เคสนี้ส่งให้ตรวจแล้ว ลบรูปไม่ได้ ถ้าต้องแก้ แจ้งแอดมิน
--   -- เรียกซ้ำแถวที่ลบไปแล้ว:
--   select public.media_soft_delete('<media_id_already_deleted>'::uuid);
--   -- expected: สำเร็จเงียบๆ ไม่ error

-- f) session admin ลบได้ทุกสถานะ:
--   select public.media_soft_delete('<media_id_on_contract_approved>'::uuid); -- session admin
--   -- expected: สำเร็จ
