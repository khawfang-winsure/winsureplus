-- อัปเดตสดของคำขอลงพื้นที่: ลูกค้าจ่าย/นัดจ่าย/ผิดนัด หลังเข้ารอบ + ปิดอัตโนมัติถ้าจ่ายครบก่อนเข้ารอบ + พักคำขอรอนัดจ่าย
-- เพิ่มเฉพาะคอลัมน์/ฟังก์ชันใหม่ ไม่เขียน payment_log/installments/contracts; ยังไม่ตั้ง cron (อยู่ migration 20261118090100)

alter table public.field_visit_requests add column if not exists close_code text;
alter table public.field_visit_requests add column if not exists hold_until date;
alter table public.field_visit_requests add column if not exists parent_request_id uuid references public.field_visit_requests (id);
alter table public.field_visit_requests add column if not exists update_ack_key text;
alter table public.field_visit_requests add column if not exists update_ack_at timestamptz;
alter table public.field_visit_requests add column if not exists update_ack_by uuid;
alter table public.field_visit_requests add column if not exists update_ack_by_name text;

alter table public.field_visit_requests drop constraint if exists field_visit_close_code_valid;
alter table public.field_visit_requests add constraint field_visit_close_code_valid
  check (close_code is null or close_code in ('paid_before_visit','on_hold_promise','cancel_other','auto_paid_before_round'));

-- ---------- helper: ยอดจ่ายตั้งแต่เวลาที่กำหนด (ไม่นับงวดที่ถูกยกเลิกทีหลัง ตามกติกา 0178) ----------
create or replace function public.field_visit_paid_since(p_contract_id uuid, p_since timestamptz)
returns numeric language sql stable security definer set search_path = public, pg_catalog as $$
  select coalesce(sum(pl.amount), 0)
    from public.payment_log pl
   where pl.contract_id = p_contract_id
     and pl.action = 'pay'
     and pl.created_at > coalesce(p_since, '-infinity'::timestamptz)
     and not (
       pl.installment_id is not null
       and exists (
         select 1 from public.payment_log c
          where c.action = 'cancel' and c.installment_id = pl.installment_id and c.created_at > pl.created_at
       )
     );
$$;

-- ---------- สถานะสดของสัญญา (แหล่งความจริงเดียว; today = วันไทย) ----------
-- 1 paid_full  2 promised  3 promise_broken  4 paid_partial  else null
-- แหล่งนัดจ่าย = follow_ups (follow_up_result='promised', วัน = next_follow_up_at ตามเวลาไทย, แถวล่าสุด created_at หลัง p_since)
-- ไม่ใช้ contracts.promise_to_pay_date เพราะถูกล้างทุกครั้งที่มีการจ่าย (0029)
create or replace function public.field_visit_live_state(p_contract_id uuid, p_since timestamptz)
returns table (
  state text, key text, paid_since numeric, latest_promise_date date,
  overdue_amount numeric, days_late integer, penalty_due numeric
) language sql stable security definer set search_path = public, pg_catalog as $$
  with base as (
    select c.status as cstatus,
           coalesce(vs.days_late, 0)::integer as dl,
           coalesce(vs.overdue_amount, 0)::numeric as od,
           coalesce(vs.penalty_due, 0)::numeric as pd
      from public.contracts c
      left join public.v_contract_status vs on vs.contract_id = c.id
     where c.id = p_contract_id
       and p_since is not null  -- ไม่มีเวลาเข้ารอบ = ไม่คำนวณ (คืน 0 แถว)
  ), promise as (
    select (f.next_follow_up_at at time zone 'Asia/Bangkok')::date as pdate
      from public.follow_ups f
     where f.contract_id = p_contract_id
       and f.follow_up_result = 'promised'
       and f.next_follow_up_at is not null
       and f.created_at > coalesce(p_since, '-infinity'::timestamptz)
     order by f.created_at desc
     limit 1
  ), calc as (
    select b.*, public.field_visit_paid_since(p_contract_id, p_since) as paid,
           (select pr.pdate from promise pr) as promise_date,
           (now() at time zone 'Asia/Bangkok')::date as today
      from base b
  ), st as (
    select calc.*,
      case
        when cstatus not in ('active','returned') then null
        when dl = 0 and od = 0 then 'paid_full'
        when promise_date is not null and promise_date >= today then 'promised'
        when promise_date is not null and promise_date < today then 'promise_broken'
        when paid > 0 then 'paid_partial'
        else null
      end as s
    from calc
  )
  select st.s,
         case when st.s is null then null else st.s || ':' || coalesce(st.promise_date::text, '') end,
         st.paid, st.promise_date, st.od, st.dl, st.pd
    from st;
$$;

-- ---------- ยืนยันว่าแอดมินเห็นอัปเดตแล้ว ----------
create or replace function public.ack_field_visit_update(p_id uuid, p_key text)
returns void language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_name text; v_uid uuid; v_status text; v_contract uuid; v_since timestamptz; v_key text;
begin
  select p.id, coalesce(nullif(p.full_name,''), (select u.email from auth.users u where u.id = p.id), '') into v_uid, v_name
    from public.profiles p where p.id = auth.uid() and p.active = true and p.role = 'admin';
  if not found then raise exception 'เฉพาะแอดมินที่ใช้งานอยู่เท่านั้น' using errcode = '42501'; end if;
  select r.status, r.contract_id, rd.dispatched_at into v_status, v_contract, v_since
    from public.field_visit_requests r left join public.field_visit_rounds rd on rd.id = r.round_id
   where r.id = p_id for update of r;
  if not found then raise exception 'ไม่พบคำขอ' using errcode = 'P0002'; end if;
  if v_status <> 'dispatched' then raise exception 'ยืนยันได้เฉพาะคำขอที่เข้ารอบแล้ว' using errcode = 'P0001'; end if;
  select ls.key into v_key from public.field_visit_live_state(v_contract, v_since) ls;
  if v_key is null or v_key is distinct from p_key then
    raise exception 'FIELD_VISIT_UPDATE_CHANGED' using errcode = 'P0001';
  end if;
  update public.field_visit_requests
     set update_ack_key = p_key, update_ack_at = now(), update_ack_by = v_uid, update_ack_by_name = v_name
   where id = p_id;
end $$;

-- ---------- ยกเลิกคำขอที่เข้ารอบแล้ว (ยังไม่มีผล) ----------
create or replace function public.cancel_dispatched_field_visit(p_id uuid, p_code text, p_note text, p_hold_until date)
returns uuid language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_name text; r public.field_visit_requests%rowtype; v_note text; v_new uuid; v_reason text;
  v_today date := (now() at time zone 'Asia/Bangkok')::date;
begin
  select coalesce(nullif(p.full_name,''), (select u.email from auth.users u where u.id = p.id), '') into v_name
    from public.profiles p where p.id = auth.uid() and p.active = true and p.role = 'admin';
  if not found then raise exception 'เฉพาะแอดมินที่ใช้งานอยู่เท่านั้น' using errcode = '42501'; end if;
  if p_code is null or p_code not in ('paid_before_visit','on_hold_promise','cancel_other') then
    raise exception 'เหตุผลยกเลิกไม่ถูกต้อง' using errcode = 'P0001';
  end if;
  v_note := nullif(btrim(coalesce(p_note,'')),'');
  if p_code = 'cancel_other' and v_note is null then
    raise exception 'ยกเลิกด้วยเหตุผลอื่น ต้องใส่หมายเหตุ' using errcode = 'P0001';
  end if;
  if p_code = 'on_hold_promise' and (p_hold_until is null or p_hold_until < v_today) then
    raise exception 'พักรอนัดจ่ายต้องระบุวันที่ตั้งแต่วันนี้เป็นต้นไป' using errcode = 'P0001';
  end if;
  if p_code = 'on_hold_promise' and p_hold_until > v_today + 60 then
    raise exception 'พักรอนัดจ่ายได้ไม่เกิน 60 วันนับจากวันนี้' using errcode = 'P0001';
  end if;
  select * into r from public.field_visit_requests where id = p_id for update;
  if not found then raise exception 'ไม่พบคำขอ' using errcode = 'P0002'; end if;
  if r.status <> 'dispatched' or r.result_code is not null or r.result_at is not null then
    raise exception 'FIELD_VISIT_NOT_CANCELLABLE' using errcode = 'P0001';
  end if;
  v_reason := case p_code
    when 'paid_before_visit' then 'ลูกค้าชำระก่อนลงพื้นที่'
    when 'on_hold_promise' then 'พักไว้รอลูกค้าจ่ายตามนัด ' || p_hold_until::text
    else v_note end;
  if p_code <> 'cancel_other' and v_note is not null then v_reason := v_reason || ' — ' || v_note; end if;
  update public.field_visit_requests
     set status = 'cancelled', close_code = p_code, closed_at = now(), closed_reason = v_reason
   where id = p_id;
  if p_code = 'on_hold_promise' then
    insert into public.field_visit_requests
      (contract_id, reason, note, status, requested_by, requested_by_name, requested_at, hold_until, parent_request_id)
    values (r.contract_id, r.reason, r.note, 'requested', r.requested_by, r.requested_by_name, now(), p_hold_until, r.id)
    returning id into v_new;
    return v_new;
  end if;
  return p_id;
end $$;

-- ---------- ตัวเลขแจ้งเตือน (แอดมิน) ----------
create or replace function public.count_field_visit_attention()
returns jsonb language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_today date := (now() at time zone 'Asia/Bangkok')::date; v_wait int; v_upd int; v_stale jsonb;
begin
  perform 1 from public.profiles p where p.id = auth.uid() and p.active = true and p.role = 'admin';
  if not found then return jsonb_build_object('waiting', 0, 'updates', 0, 'staleRounds', '[]'::jsonb); end if;
  select count(*)::int into v_wait
    from public.field_visit_requests r join public.contracts c on c.id = r.contract_id
   where r.status = 'requested' and c.status not in ('closed','returned_closed')
     and (r.hold_until is null or r.hold_until <= v_today);
  select count(*)::int into v_upd
    from public.field_visit_requests r
    join public.field_visit_rounds rd on rd.id = r.round_id
    cross join lateral public.field_visit_live_state(r.contract_id, rd.dispatched_at) ls
   where r.status = 'dispatched' and ls.key is not null and ls.key is distinct from r.update_ack_key;
  select coalesce(jsonb_agg(jsonb_build_object(
           'roundId', x.id, 'label', x.label, 'dispatchedAt', x.dispatched_at, 'pending', x.pending
         ) order by x.dispatched_at), '[]'::jsonb) into v_stale
    from (
      select rd.id, rd.label, rd.dispatched_at, count(*)::int as pending
        from public.field_visit_rounds rd
        join public.field_visit_requests r on r.round_id = rd.id and r.status = 'dispatched'
       where rd.dispatched_at <= now() - interval '7 days'
       group by rd.id, rd.label, rd.dispatched_at
    ) x;
  return jsonb_build_object('waiting', v_wait, 'updates', v_upd, 'staleRounds', v_stale);
end $$;

-- ---------- ปิดอัตโนมัติ: คำขอ requested ที่ลูกค้าชำระครบแล้ว (cron เท่านั้น) ----------
create or replace function public.auto_close_paid_field_visit_requests()
returns integer language plpgsql security definer set search_path = public, pg_catalog as $$
declare n integer;
begin
  with closed as (
    update public.field_visit_requests r
       set status = 'closed', close_code = 'auto_paid_before_round',
           closed_reason = 'ลูกค้าชำระครบก่อนเข้ารอบ (ระบบปิดอัตโนมัติ)', closed_at = now()
     where r.status = 'requested'
       and exists (
         select 1 from public.v_contract_status vs
          where vs.contract_id = r.contract_id and vs.status in ('active','returned')
            and coalesce(vs.days_late, 0) = 0 and coalesce(vs.overdue_amount, 0) = 0
       )
    returning r.id
  )
  select count(*)::int into n from closed;
  return n;
end $$;

-- ---------- รายการสำหรับหน้าแอดมิน (คงทุกฟิลด์เดิม + ฟิลด์สด) ----------
create or replace function public.list_field_visit_requests(p_days int default 90)
returns jsonb language plpgsql security definer set search_path = public, pg_catalog as $$
declare result jsonb; v_today date := (now() at time zone 'Asia/Bangkok')::date;
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
    'paidSinceRequest', public.field_visit_paid_since(r.contract_id, r.requested_at),
    'liveState', ls.state, 'liveKey', ls.key,
    'ackKey', r.update_ack_key, 'ackAt', r.update_ack_at, 'ackByName', r.update_ack_by_name,
    'paidSinceDispatch', case when r.status = 'dispatched' then coalesce(ls.paid_since, 0) else 0 end,
    'latestPromiseDate', ls.latest_promise_date,
    'penaltyDue', coalesce(vs.penalty_due, 0),
    'closeCode', r.close_code, 'holdUntil', r.hold_until,
    'paidLast3d', public.field_visit_paid_since(r.contract_id, now() - interval '3 days'),
    'activePromiseDate', (
      select pr.d from (
        select (f.next_follow_up_at at time zone 'Asia/Bangkok')::date as d
          from public.follow_ups f
         where f.contract_id = r.contract_id and f.follow_up_result = 'promised' and f.next_follow_up_at is not null
         order by f.created_at desc limit 1
      ) pr where pr.d >= v_today
    )
  ) order by (r.status in ('requested','dispatched')) desc, r.requested_at desc), '[]'::jsonb) into result
  from public.field_visit_requests r
  join public.contracts c on c.id = r.contract_id
  left join public.field_visit_rounds rd on rd.id = r.round_id
  left join public.v_contract_status vs on vs.contract_id = r.contract_id
  left join lateral public.field_visit_live_state(
    r.contract_id, case when r.status = 'dispatched' then rd.dispatched_at end) ls on true
  where r.status in ('requested','dispatched')
     or coalesce(r.closed_at, r.result_at, r.requested_at) >= now() - make_interval(days => greatest(coalesce(p_days,90),0));
  return result;
end $$;

-- ---------- แผนที่ป้ายสถานะ (เพิ่มคำขอที่ปิดเพราะจ่ายครบ/ยกเลิก ภายใน 14 วัน + closeCode) ----------
-- คืนสูงสุด 1 แถวต่อสัญญา (DISTINCT ON); แถว on_hold_promise ไม่ใส่ (มีแถว requested ใหม่แทนอยู่แล้ว)
create or replace function public.get_field_visit_status_map()
returns jsonb language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_role text; result jsonb;
begin
  select p.role into v_role from public.profiles p where p.id = auth.uid() and p.active = true;
  if v_role is null or v_role not in ('admin','staff','freelancer') then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'contractId', x.contract_id, 'requestId', x.id, 'status', x.status, 'reason', x.reason,
    'requestedAt', x.requested_at, 'dispatchedAt', x.dispatched_at,
    'requestedBy', x.requested_by,
    'resultCode', x.result_code, 'promiseDate', x.promise_date,
    'closeCode', x.close_code
  )), '[]'::jsonb) into result
  from (
    -- หนึ่งแถวต่อสัญญา: คำขอที่ยังเปิดก่อน แล้วค่อยเอาแถวที่เคลื่อนไหวล่าสุด
    select distinct on (r.contract_id)
           r.contract_id, r.id, r.status, r.reason, r.requested_at, rd.dispatched_at,
           r.requested_by, r.result_code, r.promise_date, r.close_code
      from public.field_visit_requests r
      join public.contracts c on c.id = r.contract_id
      left join public.field_visit_rounds rd on rd.id = r.round_id
     where (r.status in ('requested','dispatched')
            or (r.status in ('found','not_found') and r.result_at >= now() - interval '14 days')
            or (r.status in ('closed','cancelled') and r.close_code is not null
                and r.close_code <> 'on_hold_promise'
                and r.closed_at >= now() - interval '14 days'))
       and (v_role in ('admin','staff')
            or (c.status = 'active' and c.current_grade is not null and public.freelancer_has_grade(c.current_grade)))
     order by r.contract_id,
              (r.status in ('requested','dispatched')) desc,
              coalesce(r.closed_at, r.result_at, r.requested_at) desc
  ) x;
  return result;
end $$;

-- ---------- สิทธิ์ ----------
-- helper 2 ตัว (paid_since / live_state) ไม่ให้ authenticated เรียกตรง: ไม่เช็ค role และคืนยอดค้างรายสัญญา
-- ฟังก์ชัน security definer ด้านบนเรียกได้อยู่แล้วเพราะรันด้วยสิทธิ์เจ้าของ
revoke all on function public.field_visit_paid_since(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.field_visit_live_state(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.ack_field_visit_update(uuid, text) from public, anon;
revoke all on function public.cancel_dispatched_field_visit(uuid, text, text, date) from public, anon;
revoke all on function public.count_field_visit_attention() from public, anon;
revoke all on function public.auto_close_paid_field_visit_requests() from public, anon, authenticated;
revoke all on function public.list_field_visit_requests(int) from public, anon;
revoke all on function public.get_field_visit_status_map() from public, anon;
grant execute on function public.ack_field_visit_update(uuid, text) to authenticated;
grant execute on function public.cancel_dispatched_field_visit(uuid, text, text, date) to authenticated;
grant execute on function public.count_field_visit_attention() to authenticated;
grant execute on function public.list_field_visit_requests(int) to authenticated;
grant execute on function public.get_field_visit_status_map() to authenticated;

-- ---------- Dry-run (ครีมรันก่อนตั้ง cron): คำขอ requested ที่ auto-close จะปิด ----------
comment on function public.auto_close_paid_field_visit_requests() is $c$
(20261118090000) ปิดคำขอ status='requested' ที่สัญญา active/returned และ days_late=0 และ overdue_amount=0; cron เท่านั้น ไม่ grant authenticated.
Dry-run (SELECT ล้วน รันก่อนตั้ง cron):
select c.customer_name, c.inv_no, vs.days_late, vs.overdue_amount, r.id as request_id, r.requested_at, r.hold_until
  from public.field_visit_requests r
  join public.contracts c on c.id = r.contract_id
  join public.v_contract_status vs on vs.contract_id = r.contract_id
 where r.status = 'requested'
   and vs.status in ('active','returned')
   and coalesce(vs.days_late, 0) = 0
   and coalesce(vs.overdue_amount, 0) = 0
 order by r.requested_at;
$c$;
