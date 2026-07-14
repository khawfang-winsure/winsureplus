-- 0110: เปิดสิทธิ์ฟรีแลนซ์บันทึก + ดูประวัติติดตาม เคสสถานะ "คืนเครื่อง" (returned) ได้
-- บั๊กเดิมตั้งแต่ 0018: RLS ของ follow_ups (insert with_check + read using) เงื่อนไข freelancer
-- บังคับ c.status = 'active' เท่านั้น → เคส returned (~84 เคส) หลุด บันทึก/อ่านไม่ได้
-- แก้: เฉพาะ clause ของ freelancer เปลี่ยน c.status = 'active' → c.status IN ('active','returned')
-- ห้ามแตะ clause admin/staff. INSERT ใช้ with_check, SELECT ใช้ using. คง author_id = auth.uid() ใน insert
-- Postgres ไม่มี CREATE OR REPLACE POLICY → DROP IF EXISTS + CREATE ใหม่ทั้งก้อน

-- ---- follow_ups_insert (INSERT / with_check) --------------------------------
drop policy if exists follow_ups_insert on public.follow_ups;

create policy follow_ups_insert
  on public.follow_ups
  as permissive
  for insert
  to authenticated
  with check (
    (author_id = auth.uid())
    and (
      is_admin()
      or (
        (select role from public.profiles where id = auth.uid()) = 'staff'
      )
      or (
        is_freelancer()
        and exists (
          select 1
          from public.contracts c
          where c.id = follow_ups.contract_id
            and c.status in ('active', 'returned')
            and c.current_grade is not null
            and freelancer_has_grade(c.current_grade)
        )
      )
      or (
        is_freelancer()
        and exists (
          select 1
          from public.contracts c
          where c.id = follow_ups.contract_id
            and c.assigned_to = auth.uid()
            and c.status in ('active', 'returned')
        )
      )
    )
  );

-- ---- follow_ups_read (SELECT / using) ---------------------------------------
drop policy if exists follow_ups_read on public.follow_ups;

create policy follow_ups_read
  on public.follow_ups
  as permissive
  for select
  to authenticated
  using (
    is_admin()
    or (
      (select role from public.profiles where id = auth.uid()) = 'staff'
    )
    or exists (
      select 1
      from public.contracts c
      where c.id = follow_ups.contract_id
        and c.status in ('active', 'returned')
        and c.current_grade is not null
        and is_freelancer()
        and freelancer_has_grade(c.current_grade)
    )
    or exists (
      select 1
      from public.contracts c
      where c.id = follow_ups.contract_id
        and is_freelancer()
        and c.assigned_to = auth.uid()
        and c.status in ('active', 'returned')
    )
  );

-- ============================================================================
-- VERIFY (ครีมรันหลัง apply — read-only ไม่แก้อะไร)
-- ============================================================================
-- 1) ดู 2 policy ครบ + freelancer clause มี ('active','returned') ครบ 4 จุด
--    + admin/staff clause ไม่เปลี่ยน:
--
-- select policyname, cmd, roles, qual, with_check
-- from pg_policies
-- where tablename = 'follow_ups'
-- order by policyname;
--
-- คาดหวัง:
--   - follow_ups_insert (cmd=INSERT, with_check มี 'active','returned' 2 จุด, qual=null)
--   - follow_ups_read   (cmd=SELECT, qual มี 'active','returned' 2 จุด, with_check=null)
--   - clause admin/staff คงเดิม (is_admin() / profiles.role = 'staff')
--   - author_id = auth.uid() ยังอยู่ต้นก้อน with_check ของ insert
--
-- 2) จำนวนเคสที่จะได้ประโยชน์ (สถานะ returned):
--
-- select count(*) from public.contracts where status = 'returned';
--   -> คาดหวัง ~84
