-- 0123: RPC get_collector_ever_held() — ตัวเลขสะสมตลอดกาลของแต่ละคนตามหนี้: เคยถือกี่เคส/มูลค่าเท่าไหร่
--       + subset ที่หลุดมือไปเป็นคืนเครื่อง (ไม่ผูกช่วงวันที่ — ต่างจาก 3 RPC ใน 0120-0122 ที่รับ p_start/p_end)
--
-- อ่านก่อนเขียน (ตามที่ครีมสั่ง):
--   0120 get_collector_ownership / get_unowned_arrears / get_collector_recoveries — pattern guard/grant/comment
--   0090 v_contract_status_include_returned — est_outstanding/overdue_amount/status
--   0018 freelancer_role — follow_ups(author_id, contract_id)
--
-- Spec (ฝ่ายวิเคราะห์ร่าง + ครีม verify ตัวเลขจริงแล้วก่อนสั่งให้เขียนไฟล์นี้):
--   ever_held_cases/baht = distinct สัญญาที่ author (role='freelancer' เท่านั้น — กรองที่ join touches
--     เพื่อสอดคล้องกับกล่องอื่นในหน้า /staff-performance ที่แสดงเฉพาะ freelancer; คุณเบียร์ role='staff'
--     เคยโทร 8 เคส ถูกตัดออกด้วยเงื่อนไขนี้) เคยมี follow_up (all-time) x มูลค่า est_outstanding
--     "ปัจจุบัน" ของเคสนั้น (ไม่ใช่มูลค่าตอนที่ดูแล)
--   lost_cases/baht = subset ของ ever_held ที่ status ตอนนี้ เป็น returned หรือ returned_closed
--     x overdue_amount ปัจจุบัน
--   ไม่ dedupe ข้ามคน — เคสเดียวหลายคนเคยโทร = ทุกคนได้เครดิตเต็ม (เหมือน scope_baht ใน 0120)
--
-- ค่าอ้างอิงที่ครีม verify แล้วก่อนสั่งเขียน (ต้องตรงหลัง apply):
--   คุณเจน: ever_held 100 เคส / 2,623,411฿ · lost 4 / 17,083฿
--   คุณปุ๋ย: ever_held 86 เคส / 2,268,489฿ · lost 13 / 97,715฿
--   รวม distinct (author_id, contract_id) ทั้งฐาน = 186 คู่
--
-- additive only: function ใหม่ 1 ตัว ไม่แตะตาราง/ฟังก์ชันอื่น ไม่มี ALTER ตาราง

create or replace function public.get_collector_ever_held()
returns table (
  author_id       uuid,
  author_name     text,
  ever_held_cases int,
  ever_held_baht  numeric,
  lost_cases      int,
  lost_baht       numeric
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with
  -- 1 แถวต่อคู่ (author, contract) ที่เคยมี follow_up (all-time) — กรอง role='freelancer' เพื่อ
  -- สอดคล้องกับกล่องอื่นในหน้า /staff-performance (คุณเบียร์ role='staff' เคยโทร 8 เคส ถูกตัดออก)
  touches as (
    select distinct f.author_id, f.contract_id
    from public.follow_ups f
    join public.profiles pr on pr.id = f.author_id and pr.role = 'freelancer'
  ),
  enriched as (
    select
      t.author_id,
      t.contract_id,
      c.status,
      vs.est_outstanding,
      vs.overdue_amount
    from touches t
    join public.contracts c          on c.id = t.contract_id
    join public.v_contract_status vs on vs.contract_id = t.contract_id
  )
  select
    e.author_id,
    coalesce(nullif(pr.full_name, ''), au.email, '-') as author_name,
    count(*)::int                                     as ever_held_cases,
    sum(e.est_outstanding)::numeric                   as ever_held_baht,
    count(*) filter (
      where e.status in ('returned', 'returned_closed')
    )::int                                             as lost_cases,
    coalesce(
      sum(e.overdue_amount) filter (
        where e.status in ('returned', 'returned_closed')
      ), 0
    )::numeric                                         as lost_baht
  from enriched e
  left join public.profiles pr on pr.id = e.author_id
  left join auth.users      au on au.id = e.author_id
  where public.is_admin() or public.is_staff() or public.is_executive()  -- guard: freelancer/anon → 0 rows
  group by e.author_id, coalesce(nullif(pr.full_name, ''), au.email, '-');
$$;

grant execute on function public.get_collector_ever_held()
  to authenticated, service_role;

comment on function public.get_collector_ever_held() is
  'สะสมตลอดกาล (ไม่ผูกช่วงวันที่): ever_held = distinct สัญญาที่ author (role=freelancer เท่านั้น ให้สอดคล้องกับกล่องอื่นในหน้า /staff-performance) เคยมี follow_up x มูลค่า est_outstanding ปัจจุบัน (ไม่ใช่ตอนดูแล); lost = subset ที่ status ปัจจุบันเป็น returned/returned_closed x overdue_amount ปัจจุบัน; ไม่ dedupe ข้ามคน (เคสเดียวหลายคนเคยโทร = ทุกคนได้เครดิตเต็ม เหมือน get_collector_ownership); ไม่รวม DEBTFLOW (เฉพาะ follow_ups ในเว็บนี้)';

-- ============================================================================
-- Smoke SQL (ครีมรันหลัง apply ผ่าน MCP — not executed here)
--
-- ⚠️ guard `where public.is_admin() or public.is_staff() or public.is_executive()` เช็ค auth.uid() —
--    รันผ่าน MCP (service role, ไม่มี auth session) auth.uid()=null → เห็น 0 แถวเสมอ (ไม่ใช่บั๊ก)
--    ต้อง replicate CTE เดียวกันแบบ "ไม่มี guard" (ตัด where public.is_admin()... ออก / ใช้ where true)
--    ถึงจะเห็นข้อมูลจริงตอน verify ผ่าน MCP
-- ============================================================================

-- 1) ตรวจ grant:
-- SELECT has_function_privilege('authenticated', 'public.get_collector_ever_held()', 'EXECUTE');  -- true
-- SELECT has_function_privilege('service_role',  'public.get_collector_ever_held()', 'EXECUTE');  -- true

-- 2) จำนวนคู่ (author, contract) ที่เคยมี follow_up ของ freelancer เท่านั้น — คาด 186:
-- SELECT count(distinct (f.author_id, f.contract_id))
-- FROM public.follow_ups f
-- JOIN public.profiles pr ON pr.id = f.author_id AND pr.role = 'freelancer';

-- 3) replicate CTE ไม่มี guard เทียบกับค่าอ้างอิง:
-- WITH touches AS (
--   SELECT DISTINCT f.author_id, f.contract_id
--   FROM public.follow_ups f
--   JOIN public.profiles pr ON pr.id = f.author_id AND pr.role = 'freelancer'
-- ),
-- enriched AS (
--   SELECT t.author_id, t.contract_id, c.status, vs.est_outstanding, vs.overdue_amount
--   FROM touches t
--   JOIN public.contracts c          ON c.id = t.contract_id
--   JOIN public.v_contract_status vs ON vs.contract_id = t.contract_id
-- )
-- SELECT
--   e.author_id,
--   coalesce(nullif(pr.full_name, ''), au.email, '-') AS author_name,
--   count(*)                                            AS ever_held_cases,
--   sum(e.est_outstanding)                              AS ever_held_baht,
--   count(*) filter (where e.status in ('returned','returned_closed'))            AS lost_cases,
--   coalesce(sum(e.overdue_amount) filter (where e.status in ('returned','returned_closed')), 0) AS lost_baht
-- FROM enriched e
-- LEFT JOIN public.profiles pr ON pr.id = e.author_id
-- LEFT JOIN auth.users      au ON au.id = e.author_id
-- GROUP BY e.author_id, coalesce(nullif(pr.full_name, ''), au.email, '-')
-- ORDER BY ever_held_baht DESC;
-- -- expected: คุณเจน 100/2,623,411 lost 4/17,083 · คุณปุ๋ย 86/2,268,489 lost 13/97,715
-- -- ถ้า sum(ever_held_cases) ต่างจาก 186 → touches join role='freelancer' หลุด กรณีขอบ (เช่น profile ถูกลบ)
-- -- รายงานให้ครีมตัดสินใจ ไม่ต้องแก้ query เอง

-- 4) freelancer เรียกแล้วเห็น 0 rows (guard ยังกันอยู่) — ทดสอบด้วย token freelancer ผ่าน REST
