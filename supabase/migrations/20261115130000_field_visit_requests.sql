-- คำขอลงพื้นที่: พนักงาน/ฟรีแลนซ์กดขอ -> เข้าคิว (requested) -> แอดมินเลือกเข้ารอบ (dispatched) -> แอดมินลงผลพบตัว/ไม่พบตัว
-- เขียนผ่านฟังก์ชันเท่านั้น (ไม่มี policy เขียน) ไม่มี trigger บน contracts; ป้ายเตือนอย่างเดียว ไม่แตะคิวติดตาม/compliance

create table if not exists public.field_visit_rounds (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  dispatched_at timestamptz not null default now(),
  dispatched_by uuid,
  dispatched_by_name text,
  team_note text
);

create table if not exists public.field_visit_requests (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts (id),
  reason text not null check (reason in ('unreachable_all_phones','answered_uncooperative','defiant','other')),
  note text,
  status text not null default 'requested' check (status in ('requested','dispatched','found','not_found','closed','cancelled')),
  requested_by uuid,
  requested_by_name text,
  requested_at timestamptz not null default now(),
  round_id uuid references public.field_visit_rounds (id),
  result_note text,
  result_at timestamptz,
  result_by_name text,
  closed_at timestamptz,
  closed_reason text,
  constraint field_visit_other_needs_note check (reason <> 'other' or length(btrim(coalesce(note,''))) > 0)
);

create unique index if not exists field_visit_one_open_per_contract
  on public.field_visit_requests (contract_id) where status in ('requested','dispatched');
create index if not exists field_visit_requests_status_idx on public.field_visit_requests (status);
create index if not exists field_visit_requests_contract_idx on public.field_visit_requests (contract_id);

alter table public.field_visit_rounds enable row level security;
alter table public.field_visit_requests enable row level security;

drop policy if exists field_visit_requests_read on public.field_visit_requests;
create policy field_visit_requests_read on public.field_visit_requests for select to authenticated using (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.active = true and p.role in ('admin','staff'))
  or exists (
    select 1 from public.contracts c
    where c.id = field_visit_requests.contract_id
      and public.is_freelancer()
      and c.status = 'active'
      and c.current_grade is not null
      and public.freelancer_has_grade(c.current_grade)
  )
);

drop policy if exists field_visit_rounds_read on public.field_visit_rounds;
create policy field_visit_rounds_read on public.field_visit_rounds for select to authenticated using (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.active = true and p.role in ('admin','staff'))
);

-- service_role (sb_secret_) ต้อง grant ชัด (default privileges ของ 0017/0187 คุมอยู่ แต่ย้ำซ้ำปลอดภัย)
grant select, insert, update, delete on public.field_visit_rounds, public.field_visit_requests to service_role;

-- ---------- ขอลงพื้นที่ ----------
create or replace function public.request_field_visit(p_contract_id uuid, p_reason text, p_note text)
returns uuid language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_role text; v_name text; v_cstatus text; v_grade text; v_id uuid;
begin
  select p.role, coalesce(nullif(p.full_name,''), (select u.email from auth.users u where u.id = p.id), '')
    into v_role, v_name
    from public.profiles p where p.id = auth.uid() and p.active = true;
  if v_role is null or v_role not in ('admin','staff','freelancer') then
    raise exception 'ไม่มีสิทธิ์ขอลงพื้นที่' using errcode = '42501';
  end if;
  select c.status, c.current_grade into v_cstatus, v_grade from public.contracts c where c.id = p_contract_id;
  if not found then raise exception 'ไม่พบสัญญา' using errcode = 'P0002'; end if;
  if v_role = 'freelancer' and not (
       v_cstatus = 'active' and v_grade is not null and public.freelancer_has_grade(v_grade)) then
    raise exception 'ไม่มีสิทธิ์ขอลงพื้นที่กับสัญญานี้' using errcode = '42501';
  end if;
  if v_cstatus in ('closed','returned_closed') then
    raise exception 'สัญญาปิดแล้ว ขอลงพื้นที่ไม่ได้' using errcode = 'P0001';
  end if;
  if p_reason is null or p_reason not in ('unreachable_all_phones','answered_uncooperative','defiant','other') then
    raise exception 'เหตุผลไม่ถูกต้อง' using errcode = 'P0001';
  end if;
  if p_reason = 'other' and length(btrim(coalesce(p_note,''))) = 0 then
    raise exception 'เหตุผลอื่นๆ ต้องใส่หมายเหตุ' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.field_visit_requests where contract_id = p_contract_id and status in ('requested','dispatched')) then
    raise exception 'FIELD_VISIT_ALREADY_OPEN' using errcode = 'P0001';
  end if;
  begin
    insert into public.field_visit_requests (contract_id, reason, note, requested_by, requested_by_name)
    values (p_contract_id, p_reason, nullif(btrim(coalesce(p_note,'')),''), auth.uid(), v_name)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'FIELD_VISIT_ALREADY_OPEN' using errcode = 'P0001';
  end;
  return v_id;
end $$;

-- ---------- ยกเลิกคำขอ (เฉพาะที่ยังเป็น requested) ----------
create or replace function public.cancel_field_visit_request(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_role text; v_by uuid; v_status text;
begin
  select p.role into v_role from public.profiles p where p.id = auth.uid() and p.active = true;
  if v_role is null then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  select r.requested_by, r.status into v_by, v_status from public.field_visit_requests r where r.id = p_id for update;
  if not found then raise exception 'ไม่พบคำขอ' using errcode = 'P0002'; end if;
  if not (v_role = 'admin' or v_by = auth.uid()) then
    raise exception 'ยกเลิกได้เฉพาะคนขอหรือแอดมิน' using errcode = '42501';
  end if;
  if v_status <> 'requested' then raise exception 'FIELD_VISIT_NOT_CANCELLABLE' using errcode = 'P0001'; end if;
  update public.field_visit_requests
     set status = 'cancelled', closed_at = now(), closed_reason = nullif(btrim(coalesce(p_reason,'')),'')
   where id = p_id;
end $$;

-- ---------- แอดมินเลือกเคสเข้ารอบ ----------
create or replace function public.dispatch_field_visit_round(p_ids uuid[], p_label text, p_note text)
returns uuid language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_name text; v_round uuid; v_n int; v_ok int;
begin
  select coalesce(nullif(p.full_name,''), (select u.email from auth.users u where u.id = p.id), '') into v_name
    from public.profiles p where p.id = auth.uid() and p.active = true and p.role = 'admin';
  if not found then raise exception 'เฉพาะแอดมินที่ใช้งานอยู่เท่านั้น' using errcode = '42501'; end if;
  if p_ids is null or coalesce(array_length(p_ids,1),0) = 0 then
    raise exception 'ยังไม่ได้เลือกเคส' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_label,''))) = 0 then
    raise exception 'ต้องตั้งชื่อรอบ' using errcode = 'P0001';
  end if;
  select count(distinct x) into v_n from unnest(p_ids) x;
  perform 1 from public.field_visit_requests where id = any(p_ids) for update;
  select count(*) into v_ok from public.field_visit_requests where id = any(p_ids) and status = 'requested';
  if v_ok <> v_n then
    raise exception 'มีคำขอที่ไม่อยู่ในสถานะรอเข้ารอบ (อาจถูกยกเลิก/จัดรอบไปแล้ว)' using errcode = 'P0001';
  end if;
  insert into public.field_visit_rounds (label, dispatched_by, dispatched_by_name, team_note)
  values (btrim(p_label), auth.uid(), v_name, nullif(btrim(coalesce(p_note,'')),''))
  returning id into v_round;
  update public.field_visit_requests set status = 'dispatched', round_id = v_round where id = any(p_ids);
  return v_round;
end $$;

-- ---------- แอดมินลงผล ----------
create or replace function public.record_field_visit_result(p_id uuid, p_result text, p_note text)
returns void language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_name text; v_status text;
begin
  select coalesce(nullif(p.full_name,''), (select u.email from auth.users u where u.id = p.id), '') into v_name
    from public.profiles p where p.id = auth.uid() and p.active = true and p.role = 'admin';
  if not found then raise exception 'เฉพาะแอดมินที่ใช้งานอยู่เท่านั้น' using errcode = '42501'; end if;
  if p_result is null or p_result not in ('found','not_found') then
    raise exception 'ผลต้องเป็น found หรือ not_found' using errcode = 'P0001';
  end if;
  select status into v_status from public.field_visit_requests where id = p_id for update;
  if not found then raise exception 'ไม่พบคำขอ' using errcode = 'P0002'; end if;
  if v_status <> 'dispatched' then raise exception 'ลงผลได้เฉพาะคำขอที่เข้ารอบแล้ว' using errcode = 'P0001'; end if;
  update public.field_visit_requests
     set status = p_result, result_note = nullif(btrim(coalesce(p_note,'')),''), result_at = now(), result_by_name = v_name
   where id = p_id;
end $$;

-- ---------- แอดมินปิดคำขอ ----------
create or replace function public.close_field_visit_request(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_status text;
begin
  perform 1 from public.profiles p where p.id = auth.uid() and p.active = true and p.role = 'admin';
  if not found then raise exception 'เฉพาะแอดมินที่ใช้งานอยู่เท่านั้น' using errcode = '42501'; end if;
  select status into v_status from public.field_visit_requests where id = p_id for update;
  if not found then raise exception 'ไม่พบคำขอ' using errcode = 'P0002'; end if;
  if v_status not in ('requested','dispatched','found','not_found') then
    raise exception 'คำขอนี้ปิดหรือยกเลิกไปแล้ว' using errcode = 'P0001';
  end if;
  update public.field_visit_requests
     set status = 'closed', closed_at = now(), closed_reason = nullif(btrim(coalesce(p_reason,'')),'')
   where id = p_id;
end $$;

-- ---------- รายการสำหรับหน้าแอดมิน ----------
create or replace function public.list_field_visit_requests(p_days int default 90)
returns jsonb language plpgsql security definer set search_path = public, pg_catalog as $$
declare result jsonb;
begin
  perform 1 from public.profiles p where p.id = auth.uid() and p.active = true and p.role = 'admin';
  if not found then raise exception 'เฉพาะแอดมินที่ใช้งานอยู่เท่านั้น' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'contractId', r.contract_id, 'reason', r.reason, 'note', r.note, 'status', r.status,
    'requestedBy', r.requested_by, 'requestedByName', r.requested_by_name, 'requestedAt', r.requested_at,
    'roundId', r.round_id, 'roundLabel', rd.label, 'dispatchedAt', rd.dispatched_at,
    'resultNote', r.result_note, 'resultAt', r.result_at, 'resultByName', r.result_by_name,
    'closedAt', r.closed_at, 'closedReason', r.closed_reason,
    'invNo', c.inv_no, 'contractNo', c.contract_no, 'customerName', c.customer_name,
    'shopName', vs.shop_name, 'phone', c.phone, 'phoneAlt1', c.phone_alt1, 'phoneAlt2', c.phone_alt2,
    'model', c.model, 'storage', c.storage, 'contractStatus', c.status, 'currentGrade', c.current_grade,
    'daysLate', coalesce(vs.days_late, 0), 'overdueAmount', coalesce(vs.overdue_amount, 0),
    'paidSinceRequest', coalesce((
      select sum(pl.amount) from public.payment_log pl
      where pl.contract_id = r.contract_id and pl.action = 'pay' and pl.created_at > r.requested_at
    ), 0)
  ) order by (r.status in ('requested','dispatched')) desc, r.requested_at desc), '[]'::jsonb) into result
  from public.field_visit_requests r
  join public.contracts c on c.id = r.contract_id
  left join public.field_visit_rounds rd on rd.id = r.round_id
  left join public.v_contract_status vs on vs.contract_id = r.contract_id
  where r.status in ('requested','dispatched')
     or coalesce(r.closed_at, r.result_at, r.requested_at) >= now() - make_interval(days => greatest(coalesce(p_days,90),0));
  return result;
end $$;

-- ---------- เลขแดง ----------
create or replace function public.count_open_field_visit_requests()
returns integer language plpgsql security definer set search_path = public, pg_catalog as $$
declare n integer;
begin
  perform 1 from public.profiles p where p.id = auth.uid() and p.active = true and p.role = 'admin';
  if not found then return 0; end if;
  select count(*)::integer into n
    from public.field_visit_requests r join public.contracts c on c.id = r.contract_id
   where r.status = 'requested' and c.status not in ('closed','returned_closed');
  return n;
end $$;

-- ---------- แผนที่ป้ายสถานะ (ไม่มีชื่อ/เบอร์) ----------
create or replace function public.get_field_visit_status_map()
returns jsonb language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_role text; result jsonb;
begin
  select p.role into v_role from public.profiles p where p.id = auth.uid() and p.active = true;
  if v_role is null or v_role not in ('admin','staff','freelancer') then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'contractId', r.contract_id, 'requestId', r.id, 'status', r.status, 'reason', r.reason,
    'requestedAt', r.requested_at, 'dispatchedAt', rd.dispatched_at
  )), '[]'::jsonb) into result
  from public.field_visit_requests r
  join public.contracts c on c.id = r.contract_id
  left join public.field_visit_rounds rd on rd.id = r.round_id
  where (r.status in ('requested','dispatched')
         or (r.status in ('found','not_found') and r.result_at >= now() - interval '14 days'))
    and (v_role in ('admin','staff')
         or (c.status = 'active' and c.current_grade is not null and public.freelancer_has_grade(c.current_grade)));
  return result;
end $$;

revoke all on function
  public.request_field_visit(uuid,text,text),
  public.cancel_field_visit_request(uuid,text),
  public.dispatch_field_visit_round(uuid[],text,text),
  public.record_field_visit_result(uuid,text,text),
  public.close_field_visit_request(uuid,text),
  public.list_field_visit_requests(int),
  public.count_open_field_visit_requests(),
  public.get_field_visit_status_map()
from public, anon;
grant execute on function
  public.request_field_visit(uuid,text,text),
  public.cancel_field_visit_request(uuid,text),
  public.dispatch_field_visit_round(uuid[],text,text),
  public.record_field_visit_result(uuid,text,text),
  public.close_field_visit_request(uuid,text),
  public.list_field_visit_requests(int),
  public.count_open_field_visit_requests(),
  public.get_field_visit_status_map()
to authenticated;
