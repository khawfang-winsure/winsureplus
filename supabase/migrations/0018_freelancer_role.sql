-- 0018: เพิ่ม Freelancer role สำหรับทีมติดตามหนี้ (มองเห็นสัญญาตามเกรด A-E + บันทึก follow-up)
-- Locked by Pete 2026-06-12
-- Amended 2026-06-12: ติ๊ก review พบ CRITICAL RPC escalation + Pete เลือก Option B สำหรับ shops
--   Fix 1: guard 4 SECURITY DEFINER RPCs (record_payment/adjust_payment/cancel_payment/restructure_contract)
--   Fix 2: shops_read tightened admin+staff only; shops_basic view (id/code/name/active) for freelancer
--   Fix 3a: follow_ups_insert ให้ author_id = auth.uid() ครอบคลุมทุก role (กัน spoof)
--   Fix 3b: SET statement_timeout แทน SET LOCAL (ใช้งานได้นอก explicit transaction)
-- Scope: build inside WIN SURE PLUS (not external link), by-grade (A-E), view-only + follow-up notes, fixed salary
-- See memory/ for: freelance-role-feature (to be written after deploy)
-- CRITICAL: v_contract_status MUST have security_invoker=on or freelancer reads all contracts via view
--
-- BLOCKER WARNING (reviewed by advisor before writing):
-- 0001 created contracts/installments policies as "contracts_all"/"installments_all" (FOR ALL using(true)).
-- Those must be DROPPED here and replaced with role-aware policies, otherwise the freelancer
-- scope is OR-combined with true and the whole grade restriction becomes dead code.
-- Also: existing using(true) policies on device_returns, payment_log, notifications, collection_letters,
-- customer_addresses, contract_extensions all expose those tables to freelancers
-- unless tightened. Sensitive tables (write-access) are tightened below.
-- shops: tightened in Fix 2 below (shops_read = admin+staff; shops_basic view for freelancer).
-- app_settings/options: read-open to all authenticated (unchanged); no write risk.
-- NOTE: shops RLS tightened in §5h — freelancer uses shops_basic view for id/code/name/active.
-- Fix 4 (micro-fix): §7 v_contract_status JOIN changed shops → shops_basic so
--     freelancer queries via the view resolve shop_name correctly (shops_basic has no RLS,
--     runs as view owner, exposes id/code/name/active only).

-- ============================================================================
-- SECTION 1: Helper function — grade from days_late
-- ============================================================================

create or replace function grade_for_days_late(p_days int)
returns text language sql immutable as $$
  select case
    when p_days is null or p_days <= 0 then null
    when p_days <= 30  then 'A'
    when p_days <= 60  then 'B'
    when p_days <= 90  then 'C'
    when p_days <= 120 then 'D'
    else 'E'
  end;
$$;

-- ============================================================================
-- SECTION 2: Schema additions
-- ============================================================================

-- 2a) Add current_grade column to contracts (NULL = normal / not yet backfilled)
alter table contracts add column if not exists current_grade text
  check (current_grade in ('A','B','C','D','E') or current_grade is null);

-- index for fast grade-scoped queries (partial — only active contracts)
create index if not exists contracts_current_grade_active_idx
  on contracts (current_grade) where status = 'active';

-- 2b) Extend profiles role check to include 'freelancer'
-- NOTE: Drop the old constraint first (safe — only adds a value, no existing data with 'freelancer')
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('admin', 'staff', 'freelancer'));

-- 2c) Assignment table — which freelancer is assigned which grade(s)
create table if not exists freelancer_grade_assignments (
  freelancer_id uuid references profiles(id) on delete cascade,
  grade         text check (grade in ('A','B','C','D','E')),
  assigned_at   timestamptz not null default now(),
  assigned_by   uuid references profiles(id),
  ended_at      timestamptz,
  primary key (freelancer_id, grade)
);
-- fast "is this freelancer currently assigned this grade?" lookup
create index if not exists freelancer_grade_assignments_active_idx
  on freelancer_grade_assignments (freelancer_id, grade) where ended_at is null;

-- 2d) Follow-up notes — append-only audit (mirrors payment_log pattern)
create table if not exists follow_ups (
  id                uuid primary key default gen_random_uuid(),
  contract_id       uuid not null references contracts(id) on delete cascade,
  author_id         uuid not null references profiles(id),
  author_name       text not null,                  -- snapshot at insert (trigger fills it)
  note_text         text not null check (length(note_text) >= 5),
  contact_method    text check (contact_method    in ('phone','line','sms','visit','other')),
  follow_up_result  text check (follow_up_result  in ('contacted','no_answer','promised','refused','paid','returned','other')),
  next_follow_up_at timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists follow_ups_contract_idx on follow_ups (contract_id, created_at desc);
create index if not exists follow_ups_author_idx   on follow_ups (author_id,   created_at desc);

-- ============================================================================
-- SECTION 3: Trigger — snapshot author_name on follow_up insert
-- (server-side; client-supplied author_name is overwritten — cannot be spoofed)
-- ============================================================================

create or replace function set_follow_up_author_name()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_name text;
begin
  -- if client omits author_id, fill from session uid
  if new.author_id is null then
    new.author_id := auth.uid();
  end if;
  select coalesce(full_name, '') into v_name from profiles where id = new.author_id;
  new.author_name := v_name;
  return new;
end;
$$;

drop trigger if exists trg_set_follow_up_author_name on follow_ups;
create trigger trg_set_follow_up_author_name
  before insert on follow_ups
  for each row execute function set_follow_up_author_name();

-- ============================================================================
-- SECTION 4: RLS helper functions
-- ============================================================================

-- is_freelancer: reuses same pattern as is_admin() (security definer, stable)
create or replace function is_freelancer()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = 'freelancer' and active = true
  );
$$;

-- freelancer_has_grade: checks current (non-ended) assignment
create or replace function freelancer_has_grade(p_grade text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from freelancer_grade_assignments
    where freelancer_id = auth.uid()
      and grade = p_grade
      and ended_at is null
  );
$$;

-- ============================================================================
-- SECTION 5: RLS policy rewrites
--
-- CRITICAL: 0001 created "contracts_all" and "installments_all" as FOR ALL using(true).
-- Postgres ORs permissive policies — if those survive, grade scoping is bypassed entirely.
-- Drop them before creating role-scoped replacements.
-- ============================================================================

-- ----- 5a) contracts -----
drop policy if exists contracts_all    on contracts;
drop policy if exists contracts_read   on contracts;
drop policy if exists contracts_write  on contracts;

-- freelancer: read-only, active contracts in their assigned grade(s) only
create policy contracts_read on contracts for select to authenticated using (
  is_admin()
  OR ((select role from profiles where id = auth.uid()) = 'staff')
  OR (
    is_freelancer()
    AND status = 'active'
    AND current_grade is not null
    AND freelancer_has_grade(current_grade)
  )
);

-- writes: admin + staff only (freelancer cannot write contracts)
create policy contracts_write on contracts for all to authenticated
  using    (is_admin() OR ((select role from profiles where id = auth.uid()) = 'staff'))
  with check (is_admin() OR ((select role from profiles where id = auth.uid()) = 'staff'));

-- ----- 5b) installments -----
drop policy if exists installments_all   on installments;
drop policy if exists installments_read  on installments;
drop policy if exists installments_write on installments;

-- freelancer: read-only for installments whose parent contract is in their grade scope
create policy installments_read on installments for select to authenticated using (
  is_admin()
  OR ((select role from profiles where id = auth.uid()) = 'staff')
  OR exists (
    select 1 from contracts c
    where c.id = installments.contract_id
      and c.status = 'active'
      and c.current_grade is not null
      and is_freelancer()
      and freelancer_has_grade(c.current_grade)
  )
);

-- writes: admin + staff only
create policy installments_write on installments for all to authenticated
  using    (is_admin() OR ((select role from profiles where id = auth.uid()) = 'staff'))
  with check (is_admin() OR ((select role from profiles where id = auth.uid()) = 'staff'));

-- ----- 5c) device_returns — tighten: freelancer must NOT write returns -----
-- Old policy: device_returns_all FOR ALL using(true) — exposes write to freelancer
drop policy if exists device_returns_all   on device_returns;
drop policy if exists device_returns_read  on device_returns;
drop policy if exists device_returns_write on device_returns;
-- Freelancer does not need device_returns; admin+staff only
create policy device_returns_staff on device_returns for all to authenticated
  using    (is_admin() OR ((select role from profiles where id = auth.uid()) = 'staff'))
  with check (is_admin() OR ((select role from profiles where id = auth.uid()) = 'staff'));

-- ----- 5d) notifications — tighten: freelancer should not see internal ops alerts -----
drop policy if exists notifications_all   on notifications;
drop policy if exists notifications_read  on notifications;
drop policy if exists notifications_write on notifications;
create policy notifications_staff on notifications for all to authenticated
  using    (is_admin() OR ((select role from profiles where id = auth.uid()) = 'staff'))
  with check (is_admin() OR ((select role from profiles where id = auth.uid()) = 'staff'));

-- ----- 5e) payment_log — keep read-open to staff/admin; freelancer excluded -----
-- Old policy: payment_log_read FOR SELECT using(true) — set by 0011, tightened here
drop policy if exists payment_log_read on payment_log;
create policy payment_log_read on payment_log for select to authenticated
  using (is_admin() OR ((select role from profiles where id = auth.uid()) = 'staff'));

-- ----- 5f) contract_extensions — same: staff/admin only -----
drop policy if exists contract_extensions_read on contract_extensions;
create policy contract_extensions_read on contract_extensions for select to authenticated
  using (is_admin() OR ((select role from profiles where id = auth.uid()) = 'staff'));

-- ----- 5g) collection_letters + customer_addresses — tighten write; freelancer sees nothing -----
-- (letters are internal ops; freelancer uses follow_ups instead)
drop policy if exists customer_addresses_all on customer_addresses;
drop policy if exists collection_letters_all on collection_letters;
create policy customer_addresses_staff on customer_addresses for all to authenticated
  using    (is_admin() OR ((select role from profiles where id = auth.uid()) = 'staff'))
  with check (is_admin() OR ((select role from profiles where id = auth.uid()) = 'staff'));
create policy collection_letters_staff on collection_letters for all to authenticated
  using    (is_admin() OR ((select role from profiles where id = auth.uid()) = 'staff'))
  with check (is_admin() OR ((select role from profiles where id = auth.uid()) = 'staff'));

-- ----- 5h) shops — Pete Option B: tighten shops_read to admin+staff; add shops_basic view -----
-- Freelancer must NOT read shops directly (phone/terms fields exposed).
-- shops_basic view (no security_invoker → runs as owner, bypasses RLS) exposes only safe cols.
-- Frontend uses from('shops_basic') for freelancer flows; admin/staff use from('shops') directly.
-- Fix 4 resolved: §7 v_contract_status now JOINs shops_basic (not shops), so shop_name
--     resolves correctly for freelancers via the view.
drop policy if exists shops_read on shops;
create policy shops_read on shops for select to authenticated using (
  is_admin() OR ((select role from profiles where id = auth.uid()) = 'staff')
);

drop view if exists shops_basic;
create view shops_basic as
  select id, code, name, active from shops;
grant select on shops_basic to authenticated;

-- ----- 5i) app_settings / options — read-open to all authenticated (unchanged); no write risk -----
-- Freelancer reading rate/penalty settings is harmless. No change.

-- ============================================================================
-- SECTION 6: RLS policies for NEW tables
-- ============================================================================

alter table freelancer_grade_assignments enable row level security;
alter table follow_ups                   enable row level security;

-- freelancer_grade_assignments
drop policy if exists fga_read        on freelancer_grade_assignments;
drop policy if exists fga_admin_write on freelancer_grade_assignments;

create policy fga_read on freelancer_grade_assignments for select to authenticated using (
  is_admin() OR freelancer_id = auth.uid()
);
create policy fga_admin_write on freelancer_grade_assignments for all to authenticated
  using    (is_admin())
  with check (is_admin());

-- follow_ups: read — anyone who can see the parent contract can read its notes
drop policy if exists follow_ups_read   on follow_ups;
drop policy if exists follow_ups_insert on follow_ups;

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
);

-- follow_ups: insert — Fix 3a: author_id = auth.uid() required universally (no spoofing for any role)
-- Trigger (§3) runs BEFORE and fills author_id from auth.uid() if null — WITH CHECK sees filled value.
-- The universal author_id = auth.uid() check is safe because trigger fills it before RLS evaluates.
drop policy if exists follow_ups_insert on follow_ups;
create policy follow_ups_insert on follow_ups for insert to authenticated with check (
  author_id = auth.uid()  -- universal anti-spoof: trigger fills if null, then this enforces it
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
  )
);
-- no UPDATE/DELETE policies = append-only audit (nobody can edit/delete follow-ups)

-- ============================================================================
-- SECTION 6.5: SECURITY — RPC escalation guard for SECURITY DEFINER functions
-- ============================================================================
-- These RPCs are GRANTed to authenticated (incl. freelancer).
-- SECURITY DEFINER bypasses RLS. Without internal guards, a freelancer can call
-- supabase.rpc('record_payment', ...) from the JS console and mutate any contract.
-- Fix: prepend explicit role guard to each function body.
-- Functions reproduced verbatim from 0011_payment_audit.sql and 0013_extensions.sql.
-- Using create or replace — preserves existing GRANT EXECUTE (no re-grant needed).
-- Reference: 0011_payment_audit.sql, 0013_extensions.sql

create or replace function public.record_payment(
  p_installment_id uuid,
  p_amount numeric,
  p_note text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_inst installments%rowtype;
  v_new  numeric;
  v_uid  uuid := auth.uid();
  v_name text;
begin
  -- SECURITY GUARD: freelancer role may not call write RPCs
  if not (is_admin() or (select role from profiles where id = auth.uid()) = 'staff') then
    raise exception 'permission denied: this action requires admin or staff role';
  end if;

  select * into v_inst from installments where id = p_installment_id for update;
  if not found then raise exception 'ไม่พบงวดนี้'; end if;

  v_new := coalesce(v_inst.paid_amount, 0) + coalesce(p_amount, 0);
  select coalesce(nullif(p.full_name, ''), u.email, '') into v_name
    from auth.users u left join profiles p on p.id = u.id where u.id = v_uid;

  if v_new >= v_inst.amount and v_inst.amount > 0 then
    -- จ่ายครบ → ปิดงวด
    update installments set
      paid_amount = v_new,
      paid_at = coalesce(paid_at, now()),
      status = 'paid',
      paid_by = v_uid,
      paid_by_name = v_name
      where id = p_installment_id;
  else
    -- จ่ายบางส่วน → งวดยังเปิด
    update installments set
      paid_amount = v_new,
      paid_at = null,
      status = case when due_date < current_date then 'late' else 'pending' end,
      paid_by = null,
      paid_by_name = null
      where id = p_installment_id;
  end if;

  insert into payment_log (installment_id, contract_id, action, amount, paid_amount_after, note)
    values (p_installment_id, v_inst.contract_id, 'pay', coalesce(p_amount, 0), v_new, p_note);
end;
$$;

create or replace function public.adjust_payment(
  p_installment_id uuid,
  p_new_total numeric,
  p_note text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_inst installments%rowtype;
  v_total numeric;
  v_uid  uuid := auth.uid();
  v_name text;
begin
  -- SECURITY GUARD: freelancer role may not call write RPCs
  if not (is_admin() or (select role from profiles where id = auth.uid()) = 'staff') then
    raise exception 'permission denied: this action requires admin or staff role';
  end if;

  select * into v_inst from installments where id = p_installment_id for update;
  if not found then raise exception 'ไม่พบงวดนี้'; end if;

  v_total := greatest(coalesce(p_new_total, 0), 0);
  select coalesce(nullif(p.full_name, ''), u.email, '') into v_name
    from auth.users u left join profiles p on p.id = u.id where u.id = v_uid;

  if v_total >= v_inst.amount and v_inst.amount > 0 then
    update installments set
      paid_amount = v_total,
      paid_at = coalesce(paid_at, now()),
      status = 'paid',
      paid_by = v_uid,
      paid_by_name = v_name
      where id = p_installment_id;
  else
    update installments set
      paid_amount = v_total,
      paid_at = null,
      status = case when due_date < current_date then 'late' else 'pending' end,
      paid_by = null,
      paid_by_name = null
      where id = p_installment_id;
  end if;

  insert into payment_log (installment_id, contract_id, action, amount, paid_amount_after, note)
    values (p_installment_id, v_inst.contract_id, 'edit', v_total, v_total, p_note);
end;
$$;

create or replace function public.cancel_payment(
  p_installment_id uuid,
  p_note text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_inst installments%rowtype;
begin
  -- SECURITY GUARD: freelancer role may not call write RPCs
  if not (is_admin() or (select role from profiles where id = auth.uid()) = 'staff') then
    raise exception 'permission denied: this action requires admin or staff role';
  end if;

  select * into v_inst from installments where id = p_installment_id for update;
  if not found then raise exception 'ไม่พบงวดนี้'; end if;

  update installments set
    paid_amount = 0,
    paid_at = null,
    status = case when due_date < current_date then 'late' else 'pending' end,
    paid_by = null,
    paid_by_name = null
    where id = p_installment_id;

  insert into payment_log (installment_id, contract_id, action, amount, paid_amount_after, note)
    values (p_installment_id, v_inst.contract_id, 'cancel', 0, 0, p_note);
end;
$$;

create or replace function public.restructure_contract(
  p_contract_id uuid,
  p_ext_type text,
  p_new_due_day int,
  p_new_term int,            -- จำนวนงวดที่จะผ่อนใหม่ (งวดที่เหลือ)
  p_new_finance numeric,
  p_note text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_c           contracts%rowtype;
  v_last_paid   int;
  v_monthly     numeric;
  v_base        date;
  v_due         date;
  i             int;
begin
  -- SECURITY GUARD: freelancer role may not call write RPCs
  if not (is_admin() or (select role from profiles where id = auth.uid()) = 'staff') then
    raise exception 'permission denied: this action requires admin or staff role';
  end if;

  -- ตรวจอินพุต
  if p_ext_type not in ('due_day', 'months', 'both') then
    raise exception 'ประเภทการขยายไม่ถูกต้อง';
  end if;
  if p_new_due_day is null or p_new_due_day < 1 or p_new_due_day > 31 then
    raise exception 'วันที่ชำระต้องอยู่ระหว่าง 1–31';
  end if;
  if p_new_term is null or p_new_term <= 0 then
    raise exception 'จำนวนงวดต้องมากกว่า 0';
  end if;
  if p_new_finance is null or p_new_finance < 0 then
    raise exception 'ยอดจัดไฟแนนซ์ไม่ถูกต้อง';
  end if;

  select * into v_c from contracts where id = p_contract_id for update;
  if not found then raise exception 'ไม่พบสัญญานี้'; end if;

  -- เลขงวดที่จ่ายล่าสุด (สมมติจ่ายเรียงงวด) — ถ้าไม่เคยจ่าย = 0
  select coalesce(max(installment_no), 0) into v_last_paid
    from installments where contract_id = p_contract_id and paid_at is not null;

  v_monthly := round(p_new_finance / p_new_term);

  -- ลบงวดที่ยังไม่จ่ายทั้งหมด (ยุบรวมเข้ายอดใหม่แล้ว)
  delete from installments where contract_id = p_contract_id and paid_at is null;

  -- สร้างงวดใหม่: งวด i ครบกำหนดเดือน (เดือนปัจจุบัน + i) → งวดแรก = เดือนหน้า
  for i in 1..p_new_term loop
    v_base := (date_trunc('month', current_date) + make_interval(months => i))::date;
    v_due  := due_date_for(
      extract(year from v_base)::int,
      extract(month from v_base)::int,
      p_new_due_day
    );
    insert into installments (contract_id, installment_no, due_date, amount, status)
    values (
      p_contract_id,
      v_last_paid + i,
      v_due,
      v_monthly,
      case when v_due < current_date then 'late' else 'pending' end
    );
  end loop;

  -- บันทึกประวัติ (snapshot เก่า → ใหม่) ก่อนทับค่าในสัญญา
  insert into public.contract_extensions (
    contract_id, ext_type,
    old_due_day, new_due_day,
    old_term, new_term,
    old_finance, new_finance,
    old_monthly, new_monthly,
    new_installments, note
  ) values (
    p_contract_id, p_ext_type,
    v_c.due_day, p_new_due_day,
    v_c.term_months, v_last_paid + p_new_term,
    v_c.finance_amount, p_new_finance,
    v_c.monthly_payment, v_monthly,
    p_new_term, p_note
  );

  -- อัปเดตสัญญา: วันชำระ/ค่างวด/ยอดจัดไฟแนนซ์/จำนวนงวดรวมใหม่
  update contracts set
    due_day = p_new_due_day,
    monthly_payment = v_monthly,
    finance_amount = p_new_finance,
    term_months = v_last_paid + p_new_term
    where id = p_contract_id;
end;
$$;

-- ============================================================================
-- SECTION 7: v_contract_status — add security_invoker=on + grade column
-- (CRITICAL: without security_invoker, freelancer querying the view bypasses RLS
--  and sees all contracts regardless of grade assignment)
-- Body preserved verbatim from 0004; security_invoker and grade column appended.
-- drop+create required because security_invoker option cannot be added via ALTER VIEW.
-- ============================================================================

drop view if exists v_contract_status;

create view v_contract_status with (security_invoker = on) as
with agg as (
  select
    i.contract_id,
    min(i.due_date) filter (where i.paid_at is null) as next_due,
    coalesce(sum(i.penalty_amount) filter (where i.paid_at is null), 0) as penalty_due,
    count(*) filter (where i.paid_at is null) as remaining_installments
  from installments i
  group by i.contract_id
)
select
  c.id as contract_id,
  c.contract_no,
  c.customer_name,
  c.shop_id,
  s.name as shop_name,
  c.status,
  a.next_due,
  coalesce(a.remaining_installments, 0) as remaining_installments,
  coalesce(a.penalty_due, 0) as penalty_due,
  case
    when c.status <> 'active' or a.next_due is null then 0
    else greatest(0, (current_date - a.next_due))
  end as days_late,
  case
    when c.status <> 'active' or a.next_due is null or current_date <= a.next_due then 'normal'
    when current_date - a.next_due <= 10 then '1-10'
    when current_date - a.next_due <= 30 then '11-30'
    when current_date - a.next_due <= 60 then '31-60'
    when current_date - a.next_due <= 90 then '61-90'
    when current_date - a.next_due <= 120 then '91-120'
    else '120+'
  end as bucket,
  -- computed grade column (matches contracts.current_grade; included for UI / cross-checks)
  -- NOTE: RLS uses contracts.current_grade directly, not this derived column
  grade_for_days_late(
    case
      when c.status <> 'active' or a.next_due is null then 0
      else greatest(0, (current_date - a.next_due))
    end
  ) as grade
from contracts c
left join agg a on a.contract_id = c.id
left join shops_basic s on s.id = c.shop_id;

-- restore view grant (drop+create loses privileges granted in 0005)
grant select on v_contract_status to authenticated;

-- ============================================================================
-- SECTION 8: Extend run_daily_update() to update contracts.current_grade
-- Reproducing all three existing blocks from 0003 verbatim, then appending.
-- (create or replace keeps the existing cron schedule wired — no reschedule needed)
-- ============================================================================

create or replace function run_daily_update()
returns void language plpgsql security definer set search_path = public as $$
declare
  per_day  numeric := (select value::numeric from app_settings where key = 'penalty_per_day');
  max_days int     := (select value::int    from app_settings where key = 'penalty_max_days');
begin
  -- 1) งวดที่ยังไม่จ่ายและเลยกำหนด -> สถานะ late + ค่าปรับ (100/วัน เพดาน 7 วัน)
  update installments i
  set status         = 'late',
      penalty_days   = least(current_date - i.due_date, max_days),
      penalty_amount = least(current_date - i.due_date, max_days) * per_day
  from contracts c
  where i.contract_id = c.id
    and c.status = 'active'
    and i.paid_at is null
    and i.due_date < current_date;

  -- 2) แจ้งเตือน: ครบกำหนดชำระวันนี้ (กันซ้ำในวันเดียว)
  insert into notifications (contract_id, type, message)
  select i.contract_id, 'due_today', 'ครบกำหนดชำระวันนี้'
  from installments i
  join contracts c on c.id = i.contract_id
  where c.status = 'active' and i.paid_at is null and i.due_date = current_date
    and not exists (
      select 1 from notifications n
      where n.contract_id = i.contract_id and n.type = 'due_today'
        and n.created_at::date = current_date
    );

  -- 3) แจ้งเตือน: เพิ่งเลยกำหนด (เลยมา 1 วัน)
  insert into notifications (contract_id, type, message)
  select i.contract_id, 'newly_late', 'เลยกำหนดชำระแล้ว'
  from installments i
  join contracts c on c.id = i.contract_id
  where c.status = 'active' and i.paid_at is null and i.due_date = current_date - 1
    and not exists (
      select 1 from notifications n
      where n.contract_id = i.contract_id and n.type = 'newly_late'
        and n.created_at::date = current_date
    );

  -- 4) [NEW 0018] อัปเดต current_grade ในสัญญา active (sub-select หา due_date เก่าสุดที่ยังไม่จ่าย)
  update contracts c
  set current_grade = grade_for_days_late(
    greatest(
      0,
      (current_date - (
        select min(i.due_date)
        from installments i
        where i.contract_id = c.id and i.paid_at is null
      ))::int
    )
  )
  where c.status = 'active';

end;
$$;

-- ============================================================================
-- SECTION 9: Backfill current_grade for all active contracts immediately
-- (so freelancer workspace is not empty on first login after migration)
-- ~2000 contracts × 1 sub-select each; index on installments(contract_id) covers it.
-- Estimated < 1 second.
-- Fix 3b: SET statement_timeout (not SET LOCAL — SET LOCAL is no-op outside explicit BEGIN/COMMIT)
-- ============================================================================

set statement_timeout = '30s';

update contracts c
set current_grade = grade_for_days_late(
  greatest(
    0,
    (current_date - (
      select min(i.due_date)
      from installments i
      where i.contract_id = c.id and i.paid_at is null
    ))::int
  )
)
where c.status = 'active';

set statement_timeout = '0';

-- ============================================================================
-- SECTION 10: Explicit GRANTs for new tables
-- NOTE: 0005 already set ALTER DEFAULT PRIVILEGES for authenticated + service_role,
--       so new tables in public inherit automatically.  The explicit grants below
--       are belt-and-suspenders for clarity and to match the pattern in 0011/0013.
-- ============================================================================

-- service_role (Edge Functions — already covered by 0017 default privileges, explicit for audit trail)
grant select, insert, update, delete on freelancer_grade_assignments to service_role;
grant select, insert, update, delete on follow_ups                   to service_role;
grant usage, select on all sequences in schema public to service_role;

-- authenticated (already covered by 0005 default privileges; explicit for clarity)
-- RLS policies above define what each role can actually do within these grants.
grant select, insert on follow_ups                   to authenticated;
grant select         on freelancer_grade_assignments to authenticated;

-- ============================================================================
-- SECTION 11: Verify service_role access (run these manually to smoke-test after apply)
-- SELECT has_table_privilege('service_role', 'public.freelancer_grade_assignments', 'SELECT');
-- SELECT has_table_privilege('service_role', 'public.follow_ups', 'SELECT');
-- ============================================================================
