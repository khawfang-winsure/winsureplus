-- 0048: ผลงานของฉัน — self-only scorecard สำหรับ freelancer (auth.uid() filter, no role guard)
-- copy logic จาก get_collector_scorecard (0046) ปรับ scope เป็น caller เท่านั้น:
--   - last_touch CTE: ไม่เปลี่ยน — winner ต้องแข่งกับ freelancer ทุกคน (global attribution)
--   - collected CTE: เพิ่ม WHERE lt.winner_author_id = auth.uid()
--   - fu_metrics CTE: เพิ่ม AND f.author_id = auth.uid()
--   - final WHERE: drop is_admin()/is_staff() guard — self-filter ทำแทนแล้ว
-- SECURITY DEFINER + auth.uid() → auth.uid() อ่าน JWT claim ของ caller ไม่ใช่ definer
-- additive only: create or replace function

create or replace function public.get_my_collector_scorecard(
  p_start date,
  p_end   date
)
returns table (
  author_id           uuid,
  current_grade       text,
  calls               int,
  unique_contracts    int,
  total_attempts      int,
  successful_attempts int,
  collected_baht      numeric,
  last_activity_at    timestamptz
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with
  -- (a) last-touch GLOBAL — ไม่ใส่ auth.uid() ที่นี่ (winner ต้องแข่งกับทุกคน)
  paid_events as (
    select
      pl.id          as payment_id,
      pl.contract_id,
      pl.amount,
      pl.created_at  as paid_ts
    from public.payment_log pl
    where pl.action = 'pay'
      and (pl.created_at at time zone 'Asia/Bangkok')::date between p_start and p_end
  ),
  last_touch as (
    select distinct on (pe.payment_id)
      pe.payment_id,
      pe.amount,
      pe.contract_id,
      f.author_id    as winner_author_id
    from paid_events pe
    join public.follow_ups f
      on f.contract_id = pe.contract_id
      and f.contact_method = 'phone'
      and f.created_at < pe.paid_ts
      and f.created_at >= pe.paid_ts - interval '7 days'
    join public.profiles pr
      on pr.id = f.author_id
      and pr.role = 'freelancer'
      and pr.active = true
    order by pe.payment_id, f.created_at desc, f.id desc
  ),
  -- collected: กรองเฉพาะก้อนที่ caller เป็น winner
  collected as (
    select
      lt.winner_author_id as author_id,
      c.current_grade,
      sum(lt.amount)      as collected_baht
    from last_touch lt
    join public.contracts c on c.id = lt.contract_id
    where lt.winner_author_id = auth.uid()              -- self-filter: เฉพาะก้อนที่ฉันชนะ
    group by lt.winner_author_id, c.current_grade
  ),
  -- fu_metrics: เฉพาะ follow_ups ของ caller
  fu_metrics as (
    select
      f.author_id,
      c.current_grade,
      count(*) filter (where f.contact_method = 'phone')::int                          as calls,
      count(distinct f.contract_id)::int                                               as unique_contracts,
      count(*)::int                                                                    as total_attempts,
      count(*) filter (
        where f.follow_up_result in ('contacted','promised','paid','returned','other')
      )::int                                                                           as successful_attempts,
      max(f.created_at)                                                                as last_activity_at
    from public.follow_ups f
    join public.contracts c on c.id = f.contract_id
    join public.profiles pr
      on pr.id = f.author_id
      and pr.role = 'freelancer'
      and pr.active = true
    where (f.created_at at time zone 'Asia/Bangkok')::date between p_start and p_end
      and f.author_id = auth.uid()                      -- self-filter: เฉพาะสายของฉัน
    group by f.author_id, c.current_grade
  )
  select
    coalesce(m.author_id, col.author_id)        as author_id,
    coalesce(m.current_grade, col.current_grade) as current_grade,
    coalesce(m.calls, 0)                         as calls,
    coalesce(m.unique_contracts, 0)              as unique_contracts,
    coalesce(m.total_attempts, 0)                as total_attempts,
    coalesce(m.successful_attempts, 0)           as successful_attempts,
    coalesce(col.collected_baht, 0)::numeric     as collected_baht,
    m.last_activity_at                           as last_activity_at
  from fu_metrics m
  full outer join collected col
    on col.author_id = m.author_id
    and col.current_grade is not distinct from m.current_grade
  -- ไม่มี WHERE guard — self-scope มาจาก auth.uid() filter ในแต่ละ CTE แล้ว
$$;

grant execute on function public.get_my_collector_scorecard(date, date)
  to authenticated, service_role;

-- ============================================================================
-- Smoke SQL (ครีมรันหลัง apply ผ่าน MCP)
-- ============================================================================

-- 1) ตรวจ grant:
-- SELECT has_function_privilege('authenticated', 'public.get_my_collector_scorecard(date,date)', 'EXECUTE');  -- true
-- SELECT has_function_privilege('service_role',  'public.get_my_collector_scorecard(date,date)', 'EXECUTE');  -- true

-- 2) รันด้วย service_role (ได้ 0 rows ถ้า service_role ไม่ใช่ freelancer จริง — ปกติ):
-- SELECT * FROM public.get_my_collector_scorecard('2026-05-01','2026-05-31');

-- 3) DISCRIMINATING CHECK — รันด้วย token freelancer X แล้วเปรียบ:
-- get_my_collector_scorecard → collected_baht ต้องตรงกับ row ของ X ใน get_collector_scorecard ต่อ grade เดียวกัน
-- ถ้าต่างกัน → auth.uid() filter ผิด CTE
