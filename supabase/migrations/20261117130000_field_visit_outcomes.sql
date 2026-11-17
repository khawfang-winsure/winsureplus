-- ผลลงพื้นที่ละเอียด 7 แบบ (จ่ายแล้ว/นัดจ่าย/คืนเครื่อง/ไม่ให้ความร่วมมือ/เจอญาติ/ไม่พบตัว/ที่อยู่ผิด) + วันนัดจ่าย
-- เพิ่มเฉพาะคอลัมน์และฟังก์ชันใหม่ ไม่แตะเงิน/งวด/สัญญา; record_field_visit_result เดิมคงไว้ (legacy)

alter table public.field_visit_requests add column if not exists result_code text;
alter table public.field_visit_requests add column if not exists promise_date date;

alter table public.field_visit_requests drop constraint if exists field_visit_result_code_valid;
alter table public.field_visit_requests add constraint field_visit_result_code_valid
  check (result_code is null or result_code in ('paid','promised','device_returned','uncooperative','relative_met','not_found','wrong_address'));

alter table public.field_visit_requests drop constraint if exists field_visit_promised_needs_date;
alter table public.field_visit_requests add constraint field_visit_promised_needs_date
  check (result_code is distinct from 'promised' or promise_date is not null);

-- ---------- แอดมินลงผลแบบละเอียด ----------
create or replace function public.record_field_visit_outcome(p_id uuid, p_code text, p_note text, p_promise_date date)
returns void language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_name text; v_status text;
begin
  select coalesce(nullif(p.full_name,''), (select u.email from auth.users u where u.id = p.id), '') into v_name
    from public.profiles p where p.id = auth.uid() and p.active = true and p.role = 'admin';
  if not found then raise exception 'เฉพาะแอดมินที่ใช้งานอยู่เท่านั้น' using errcode = '42501'; end if;
  if p_code is null or p_code not in ('paid','promised','device_returned','uncooperative','relative_met','not_found','wrong_address') then
    raise exception 'ผลลงพื้นที่ไม่ถูกต้อง' using errcode = 'P0001';
  end if;
  if p_code = 'promised' and (p_promise_date is null or p_promise_date < (now() at time zone 'Asia/Bangkok')::date) then
    raise exception 'นัดจ่ายต้องระบุวันที่ตั้งแต่วันนี้เป็นต้นไป' using errcode = 'P0001';
  end if;
  if p_code = 'relative_met' and length(btrim(coalesce(p_note,''))) = 0 then
    raise exception 'เจอญาติ ต้องใส่หมายเหตุ' using errcode = 'P0001';
  end if;
  select status into v_status from public.field_visit_requests where id = p_id for update;
  if not found then raise exception 'ไม่พบคำขอ' using errcode = 'P0002'; end if;
  if v_status <> 'dispatched' then raise exception 'ลงผลได้เฉพาะคำขอที่เข้ารอบแล้ว' using errcode = 'P0001'; end if;
  update public.field_visit_requests
     set status = case when p_code in ('paid','promised','device_returned','uncooperative') then 'found' else 'not_found' end,
         result_code = p_code,
         promise_date = case when p_code = 'promised' then p_promise_date else null end,
         result_note = nullif(btrim(coalesce(p_note,'')),''),
         result_at = now(),
         result_by_name = v_name
   where id = p_id;
end $$;

revoke all on function public.record_field_visit_outcome(uuid,text,text,date) from public, anon;
grant execute on function public.record_field_visit_outcome(uuid,text,text,date) to authenticated;

-- ---------- รายการสำหรับหน้าแอดมิน (เพิ่ม resultCode, promiseDate) ----------
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
    'resultCode', r.result_code, 'promiseDate', r.promise_date,
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

-- ---------- แผนที่ป้ายสถานะ (เพิ่ม resultCode, promiseDate) ----------
create or replace function public.get_field_visit_status_map()
returns jsonb language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_role text; result jsonb;
begin
  select p.role into v_role from public.profiles p where p.id = auth.uid() and p.active = true;
  if v_role is null or v_role not in ('admin','staff','freelancer') then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'contractId', r.contract_id, 'requestId', r.id, 'status', r.status, 'reason', r.reason,
    'requestedAt', r.requested_at, 'dispatchedAt', rd.dispatched_at,
    'requestedBy', r.requested_by,
    'resultCode', r.result_code, 'promiseDate', r.promise_date
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

revoke all on function public.list_field_visit_requests(int), public.get_field_visit_status_map() from public, anon;
grant execute on function public.list_field_visit_requests(int), public.get_field_visit_status_map() to authenticated;
