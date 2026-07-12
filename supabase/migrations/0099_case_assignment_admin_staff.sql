-- 0099: หัวหน้า (admin+staff) มอบหมายเคสติดตามหนี้ให้คนโทร (freelancer) เจาะจงได้ — ข้ามเกรดได้ + reassign/steal ได้
--
-- Pete locked decisions:
--   - admin และ staff มอบหมายได้ (ไม่ใช่แค่ admin)
--   - จ่ายข้ามเกรดได้ (มอบเคสเกรด B ให้คนที่ปกติดูแลเกรด A)
--   - reassign/steal ได้ (ดึงเคสที่คนอื่น claim ไปแล้ว มอบให้คนใหม่ — ต่างจาก claim_case ที่บล็อกถ้ามีคนถืออยู่)
--
-- บริบท: 0086 สร้าง contracts.assigned_to/assigned_at + claim_case/release_case (self-serve, freelancer เอง)
--   ยังไม่มี RPC ให้ "คนอื่น" (admin/staff) สั่ง assign แทนได้ — เพิ่มที่นี่
--
-- ============================================================================
-- SECTION 1: RPC assign_case — admin/staff มอบหมายเคสให้ freelancer เจาะจง (ไม่ผูก grade, reassign ได้)
-- ============================================================================

create or replace function public.assign_case(p_contract_id uuid, p_assignee_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_assignee_ok      boolean;
  v_contract_status  text;
  v_updated_id       uuid;
begin
  -- SECURITY GUARD: เฉพาะ admin/staff เท่านั้นที่มอบหมายเคสได้ (pattern เดียวกับ record_payment 0018)
  if not (is_admin() or is_staff()) then
    raise exception 'permission denied: this action requires admin or staff role';
  end if;

  -- validate ผู้รับมอบหมายต้องเป็น freelancer ที่ active เท่านั้น — กันมอบให้ non-freelancer/บัญชีปิดใช้งานแล้ว
  select exists (
    select 1 from public.profiles
    where id = p_assignee_id and role = 'freelancer' and active = true
  ) into v_assignee_ok;

  if not v_assignee_ok then
    raise exception 'ASSIGNEE_NOT_ACTIVE_FREELANCER';
  end if;

  -- เช็ค contract มีอยู่จริง + ดึง status มาด้วยในทีเดียว
  select status into v_contract_status from public.contracts where id = p_contract_id;

  if v_contract_status is null then
    raise exception 'CONTRACT_NOT_FOUND';
  end if;

  -- กันหัวหน้าเผลอมอบเคสที่ปิดจบแล้ว (closed/returned_closed/online) — ให้ตรงกับ scope เดียวกับที่
  -- RLS clause ใหม่ (SECTION 2) อนุญาต assignee เห็น คือ active/returned เท่านั้น
  if v_contract_status not in ('active', 'returned') then
    raise exception 'CONTRACT_NOT_ASSIGNABLE';
  end if;

  -- ต่างจาก claim_case (0086): ไม่มีเงื่อนไข "assigned_to is null" — รองรับ reassign/steal ตามที่ Pete ล็อก
  update public.contracts
     set assigned_to = p_assignee_id,
         assigned_at = now()
   where id = p_contract_id
  returning id into v_updated_id;

  if v_updated_id is null then
    raise exception 'CONTRACT_NOT_FOUND';
  end if;
end;
$$;

comment on function public.assign_case(uuid, uuid) is
  'มอบหมายเคสให้ freelancer เจาะจง (เรียกได้เฉพาะ admin/staff) — ข้ามเกรดได้ + reassign/steal ได้ (ไม่เช็ค assigned_to is null ต่างจาก claim_case); เคสปิดจบแล้ว (ไม่ active/returned) → raise CONTRACT_NOT_ASSIGNABLE';

grant execute on function public.assign_case(uuid, uuid) to authenticated;

-- ============================================================================
-- SECTION 2: RLS — เพิ่ม clause "assigned_to = auth.uid()" ให้ freelancer ที่ถูกมอบหมายเคสข้ามเกรด
-- มองเห็นข้อมูลที่เกี่ยวข้องได้ (ก็อป body เดิมเป๊ะ เพิ่มแค่ clause นี้)
-- เหตุผลที่ต้องแก้ทีละตาราง: RLS ทุก policy เดิมกรองด้วย freelancer_has_grade(current_grade) เท่านั้น
-- ไม่รู้จัก assigned_to เลย → cross-grade assignee มองไม่เห็นเคสที่ถูกมอบให้แม้ assign_case สำเร็จแล้ว
--
-- status guard (conservative, ตัดสินใจแล้ว): clause ใหม่ทุกจุดเติม status guard ให้ "ตรงกับ grade-scope
-- clause เดิมของ policy เดียวกัน" (ไม่ใช่ค่าคงที่เดียวกันทุกตาราง) — เพื่อไม่ให้ clause ใหม่เปิดกว้างกว่า
-- clause เดิมของตารางนั้นเอง:
--   contracts_read / installments_read / extra_charges_read: grade-scope เดิม (0092) ใช้
--     status in ('active','returned') → clause ใหม่ก็ใช้ชุดเดียวกัน
--   customer_addresses_freelancer_read / follow_ups_read / follow_ups_insert: grade-scope เดิม (0018/0082)
--     ใช้ status = 'active' เท่านั้น (ไม่รวม 'returned') → clause ใหม่ก็ใช้ 'active' เดี่ยวๆ ให้ตรงกัน
--   (ผลคือ assign_case เคส 'returned' ให้ freelancer ข้ามเกรด จะอ่าน contracts/installments/extra_charges
--    ได้ แต่จะยังบันทึก/อ่าน follow_ups หรือที่อยู่ลูกค้าของเคส returned ข้ามเกรดไม่ได้ — เป็น gap เดิมที่
--    มีอยู่แล้วก่อน migration นี้แม้แต่ในเกรดตัวเอง (0092 ไม่เคยแก้ follow_ups/customer_addresses ให้รวม
--    returned) จึงไม่ใช่ regression ใหม่ที่ migration นี้สร้างขึ้น — คงพฤติกรรมเดิมไว้ ไม่ขยายเพิ่มเอง)
-- ============================================================================

-- ----- 2a) contracts_read (เวอร์ชันล่าสุด 0092) — เพิ่ม clause assigned_to=me + status guard เดียวกับ grade-scope -----
drop policy if exists contracts_read on contracts;
create policy contracts_read on contracts for select to authenticated using (
  is_admin()
  OR ((select role from profiles where id = auth.uid()) = 'staff')
  OR (
    is_freelancer()
    AND status in ('active', 'returned')
    AND current_grade is not null
    AND freelancer_has_grade(current_grade)
  )
  OR (
    is_freelancer()
    AND assigned_to = auth.uid()
    AND status in ('active', 'returned')
  )
);

-- ----- 2b) installments_read (เวอร์ชันล่าสุด 0092) — เพิ่ม clause assigned_to=me + status guard เดียวกับ grade-scope -----
drop policy if exists installments_read on installments;
create policy installments_read on installments for select to authenticated using (
  is_admin()
  OR ((select role from profiles where id = auth.uid()) = 'staff')
  OR exists (
    select 1 from contracts c
    where c.id = installments.contract_id
      and c.status in ('active', 'returned')
      and c.current_grade is not null
      and is_freelancer()
      and freelancer_has_grade(c.current_grade)
  )
  OR exists (
    select 1 from contracts c
    where c.id = installments.contract_id
      and is_freelancer()
      and c.assigned_to = auth.uid()
      and c.status in ('active', 'returned')
  )
);

-- ----- 2c) extra_charges_read (เวอร์ชันล่าสุด 0092) — เพิ่ม clause assigned_to=me + status guard เดียวกับ grade-scope -----
drop policy if exists extra_charges_read on public.extra_charges;
create policy extra_charges_read on public.extra_charges
  for select to authenticated
  using (
    is_admin()
    or (select role from public.profiles where id = auth.uid()) = 'staff'
    or (
      is_freelancer()
      and exists (
        select 1 from contracts c
        where c.id = extra_charges.contract_id
          and c.status in ('active', 'returned')
          and c.current_grade is not null
          and freelancer_has_grade(c.current_grade)
      )
    )
    or exists (
      select 1 from contracts c
      where c.id = extra_charges.contract_id
        and is_freelancer()
        and c.assigned_to = auth.uid()
        and c.status in ('active', 'returned')
    )
  );

-- ----- 2d) customer_addresses_freelancer_read (เวอร์ชันล่าสุด 0082) — เพิ่ม exists ที่สอง (assigned_to=me)
-- status guard = 'active' เดี่ยวๆ ให้ตรงกับ grade-scope clause เดิมของ policy นี้ (ไม่รวม 'returned') -----
-- policy นี้ไม่มี is_admin()/staff clause ที่ระดับบนสุด (เป็น permissive OR กับ customer_addresses_staff แยกต่างหาก)
-- จึงเพิ่มเป็น exists(...) OR exists(...) แทนการเติม OR เดี่ยวๆ
drop policy if exists customer_addresses_freelancer_read on public.customer_addresses;
create policy customer_addresses_freelancer_read on public.customer_addresses
  for select to authenticated
  using (
    exists (
      select 1 from public.contracts c
      where c.id = customer_addresses.contract_id
        and c.status = 'active'
        and c.current_grade is not null
        and is_freelancer()
        and freelancer_has_grade(c.current_grade)
    )
    or exists (
      select 1 from public.contracts c
      where c.id = customer_addresses.contract_id
        and is_freelancer()
        and c.assigned_to = auth.uid()
        and c.status = 'active'
    )
  );

-- ----- 2e) follow_ups_read (เวอร์ชันล่าสุด 0018 — ไม่เคยถูก override) — เพิ่ม clause assigned_to=me
-- status guard = 'active' เดี่ยวๆ ให้ตรงกับ grade-scope clause เดิมของ policy นี้ (ไม่รวม 'returned') -----
drop policy if exists follow_ups_read on follow_ups;
create policy follow_ups_read on follow_ups for select to authenticated using (
  is_admin()
  OR ((select role from profiles where id = auth.uid()) = 'staff')
  OR exists (
    select 1 from contracts c
    where c.id = follow_ups.contract_id
      and c.status = 'active'
      and c.current_grade is not null
      and is_freelancer()
      and freelancer_has_grade(c.current_grade)
  )
  OR exists (
    select 1 from contracts c
    where c.id = follow_ups.contract_id
      and is_freelancer()
      and c.assigned_to = auth.uid()
      and c.status = 'active'
  )
);

-- ----- 2f) follow_ups_insert (เวอร์ชันล่าสุด 0018 — ไม่เคยถูก override) — เพิ่ม clause assigned_to=me
-- status guard = 'active' เดี่ยวๆ ให้ตรงกับ grade-scope clause เดิมของ policy นี้ (ไม่รวม 'returned') -----
-- สำคัญ: ไม่แก้จุดนี้ = assignee ข้ามเกรดจะอ่านเคสได้ (2e) แต่บันทึกผลโทรไม่ได้ (follow_ups_insert เดิมยังบล็อก)
drop policy if exists follow_ups_insert on follow_ups;
create policy follow_ups_insert on follow_ups for insert to authenticated with check (
  author_id = auth.uid()  -- universal anti-spoof (0018 Fix 3a) — คงไว้เหมือนเดิมทุกประการ
  AND (
    is_admin()
    OR ((select role from profiles where id = auth.uid()) = 'staff')
    OR (
      is_freelancer()
      AND exists (
        select 1 from contracts c
        where c.id = follow_ups.contract_id
          and c.status = 'active'
          and c.current_grade is not null
          and freelancer_has_grade(c.current_grade)
      )
    )
    OR (
      is_freelancer()
      AND exists (
        select 1 from contracts c
        where c.id = follow_ups.contract_id
          and c.assigned_to = auth.uid()
          and c.status = 'active'
      )
    )
  )
);

-- ============================================================================
-- SECTION 3: Smoke SQL (รันมือหลัง apply ผ่าน MCP)
-- ============================================================================

-- 1) RPC สร้างสำเร็จ + authenticated เรียกได้:
-- select has_function_privilege('authenticated', 'public.assign_case(uuid,uuid)', 'execute'); -- true

-- 2) policy ครบชื่อเดิม ไม่เพิ่ม/ลด (6 ชื่อ):
-- SELECT policyname, tablename FROM pg_policies
--   WHERE policyname IN ('contracts_read','installments_read','extra_charges_read',
--                        'customer_addresses_freelancer_read','follow_ups_read','follow_ups_insert')
--   ORDER BY tablename, policyname;

-- 3) assign_case guard (รันด้วย session freelancer จริง — ต้อง raise permission denied):
-- select public.assign_case('<contract-id>', '<freelancer-id>'); -- expect error ถ้า caller ไม่ใช่ admin/staff

-- 4) assign_case validate assignee (รันด้วย admin/staff, p_assignee_id เป็น staff/admin ไม่ใช่ freelancer):
-- select public.assign_case('<contract-id>', '<non-freelancer-profile-id>'); -- expect ASSIGNEE_NOT_ACTIVE_FREELANCER

-- 4b) assign_case กันมอบเคสปิดจบแล้ว (รันด้วย admin/staff, contract-id เป็นเคส status closed/returned_closed/online):
-- select public.assign_case('<closed-contract-id>', '<active-freelancer-id>'); -- expect CONTRACT_NOT_ASSIGNABLE

-- 5) reassign ทำงานจริง (contract ที่มี assigned_to อยู่แล้ว ต้อง overwrite ได้ ไม่ raise CASE_ALREADY_CLAIMED
--    แบบ claim_case):
-- select public.assign_case('<already-assigned-contract-id>', '<new-freelancer-id>');
-- select assigned_to from public.contracts where id = '<already-assigned-contract-id>'; -- expect = new-freelancer-id

-- 6) smoke จริงสำคัญที่สุด (login เป็น freelancer คนที่ถูก assign ข้ามเกรด ผ่าน browser):
--    เคสเกรด B ที่ถูก assign ให้ freelancer ที่ปกติดูแลเฉพาะเกรด A ต้องโผล่ใน getMyCases()
--    และต้องบันทึก follow_up (บันทึกผลโทร) ได้ผ่าน follow_ups_insert
