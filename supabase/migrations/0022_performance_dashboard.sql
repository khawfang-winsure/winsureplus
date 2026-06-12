-- 0022: Performance Dashboard — is_staff helper + fga_read extend + profiles_staff_view + v_freelancer_performance_30d

-- ============================================================================
-- SECTION 0: Helper function is_staff()
-- ใช้ SECURITY DEFINER (เหมือน is_admin + is_freelancer ใน 0001/0018)
-- เพื่อกัน infinite recursion: policy บน profiles ห้าม subquery profiles ตรงๆ
-- ถ้าใช้ EXISTS (SELECT 1 FROM profiles ...) ใน USING clause → Postgres error 42P17
-- SECURITY DEFINER ทำให้ฟังก์ชันรันในฐานะ owner (ข้าม RLS ของ profiles) → ปลอดภัย
-- ============================================================================

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = 'staff' and active = true
  );
$$;

-- ============================================================================
-- SECTION 1: Extend fga_read policy บน freelancer_grade_assignments
-- Pete locked: staff เห็น grade assignments ของ freelancer ทุกคน (ไม่ใช่แค่ตัวเอง)
-- เพื่อให้ getFreelancerPerformance() ดึง assignedGrades ของ freelancer ทุกคนได้
-- ใช้ is_staff() (SECURITY DEFINER) แทน inline exists เพื่อกัน recursion
-- ============================================================================

-- drop old policy ที่อนุญาตเฉพาะ admin + freelancer เห็นแค่ตัวเอง
drop policy if exists fga_read on public.freelancer_grade_assignments;

create policy fga_read on public.freelancer_grade_assignments
  for select to authenticated
  using (
    is_admin()
    OR is_staff()
    OR freelancer_id = auth.uid()
  );

-- ไม่แตะ fga_admin_write — admin เท่านั้น INSERT/UPDATE/DELETE (เหมือนเดิม)

-- ============================================================================
-- SECTION 2: profiles_read_staff_view — staff อ่าน profiles ของ freelancer ได้
-- ปัจจุบัน (0001) profiles_read: id = auth.uid() OR is_admin()
-- → staff ไม่สามารถ list profiles ของ role='freelancer' ได้
-- Performance dashboard ต้องการชื่อ freelancer ทุกคน → ต้องเพิ่ม policy
--
-- Tightest grant: staff อ่าน profiles ของ role='freelancer' เท่านั้น
-- ใช้ is_staff() SECURITY DEFINER — ห้าม subquery profiles ตรงๆ ใน policy
-- (infinite recursion: policy → subquery profiles → policy → loop → error 42P17)
-- ============================================================================

drop policy if exists profiles_read_staff_view on public.profiles;

create policy profiles_read_staff_view on public.profiles
  for select to authenticated
  using (
    id = auth.uid()                -- อ่านของตัวเองได้เสมอ
    OR is_admin()                  -- admin อ่านได้หมด
    OR (is_staff() AND role = 'freelancer')  -- staff อ่าน freelancer rows ได้
  );

-- หมายเหตุ: profiles_read เดิม (0001) = id = auth.uid() OR is_admin()
-- ยังคงอยู่ใน Postgres — Postgres OR-combines permissive policies
-- profiles_read_staff_view เป็น policy เสริม → staff เห็น freelancer rows เพิ่มขึ้น

-- ============================================================================
-- SECTION 3: v_freelancer_performance_30d
-- aggregate follow_ups per (author_id, current_grade) ใน 30 วันล่าสุด
-- security_invoker=on: RLS ของ follow_ups + contracts apply ตาม caller's role
-- admin/staff: เห็น follow_ups ของทุก contract (ตาม follow_ups_read ใน 0018)
-- ============================================================================

drop view if exists public.v_freelancer_performance_30d;

create view public.v_freelancer_performance_30d
  with (security_invoker = on) as
select
  f.author_id,
  c.current_grade,
  count(*)::int                                                                  as total_attempts,
  count(*) filter (
    where f.follow_up_result in ('contacted','promised','paid','returned','other')
  )::int                                                                         as successful_attempts,
  count(*) filter (where f.follow_up_result = 'promised')::int                  as promise_count,
  count(*) filter (
    where f.follow_up_result in ('paid','returned')
  )::int                                                                         as resolution_count,
  count(distinct f.contract_id)::int                                             as unique_contracts,
  max(f.created_at)                                                              as last_activity_at
from public.follow_ups f
join public.contracts c on c.id = f.contract_id
where f.created_at >= now() - interval '30 days'
group by f.author_id, c.current_grade;

-- GRANT: view ใหม่ต้องให้ grant ชัดๆ (default privileges ครอบ base table ไม่ใช่ view)
grant select on public.v_freelancer_performance_30d to authenticated, service_role;

-- ============================================================================
-- SECTION 4: Smoke (Cream รันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 4a) ตรวจ column + view มีอยู่:
-- SELECT has_table_privilege('service_role', 'public.v_freelancer_performance_30d', 'SELECT');
--   expected: true
-- SELECT has_table_privilege('authenticated', 'public.v_freelancer_performance_30d', 'SELECT');
--   expected: true

-- 4b) ตรวจ policy ใหม่ใน fga_read (ควรเห็น policy ที่ include staff check):
-- SELECT policyname, qual FROM pg_policies
--   WHERE tablename = 'freelancer_grade_assignments' AND policyname = 'fga_read';

-- 4c) ตรวจ profiles_read_staff_view มีอยู่:
-- SELECT policyname FROM pg_policies
--   WHERE tablename = 'profiles' AND policyname = 'profiles_read_staff_view';
--   expected: 1 row

-- 4d) ตรวจ view ดึงข้อมูลได้ (admin session):
-- SELECT * FROM public.v_freelancer_performance_30d LIMIT 5;
--   expected: rows ถ้ามี follow_ups ใน 30 วัน / empty ถ้าไม่มี (ไม่ error)
