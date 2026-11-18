-- hotfix ความเร็ว: หน้าคำขอลงพื้นที่ (list_field_visit_requests) timeout บน prod -> คิดสถานะสดแบบ set-based อ่านตารางสรุปสถานะครั้งเดียวต่อการเรียก
-- สาเหตุ: v_contract_status มี CTE agg ที่รวมทุกงวด (~42k แถว) ไม่มี predicate pushdown -> ทุก query ราคา ~220 ms แม้ขอสัญญาเดียว
--   field_visit_live_state() อ่านวิวนี้ข้างใน และ list/count เรียกมันแบบ LEFT JOIN LATERAL ต่อแถว (34 แถว ~7.5 วินาที) ซ้อนบน join วิวหลักอีกชั้น
-- วิธีแก้: helper บริสุทธิ์ field_visit_state_from() เป็นแหล่งความจริงเดียวของลำดับสถานะ + list/count อ่าน v_contract_status ครั้งเดียว (CTE materialized เฉพาะสัญญาที่ต้องใช้)
-- additive ล้วน: create or replace ฟังก์ชันเท่านั้น ไม่แตะตาราง/ข้อมูล; field_visit_live_state เก็บ signature+ผลลัพธ์เดิม (ใช้ใน ack_field_visit_update)

-- ---------- helper บริสุทธิ์: ลำดับสถานะ ----------
-- 1 paid_full  2 promised  3 promise_broken  4 paid_partial  else null
create or replace function public.field_visit_state_from(
  p_cstatus text, p_dl integer, p_od numeric, p_promise date, p_paid numeric, p_today date
) returns text language sql immutable as $$
  select case
    when p_cstatus is null or p_cstatus not in ('active','returned') then null
    when coalesce(p_dl, 0) = 0 and coalesce(p_od, 0) = 0 then 'paid_full'
    when p_promise is not null and p_promise >= p_today then 'promised'
    when p_promise is not null and p_promise < p_today then 'promise_broken'
    when coalesce(p_paid, 0) > 0 then 'paid_partial'
    else null
  end;
$$;

-- ---------- live_state (เรียกเดี่ยวจาก ack) : ใช้ helper เป็นแหล่งความจริงเดียว ----------
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
       and p_since is not null
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
           public.field_visit_state_from(cstatus, dl, od, promise_date, paid, today) as s
      from calc
  )
  select st.s,
         case when st.s is null then null else st.s || ':' || coalesce(st.promise_date::text, '') end,
         st.paid, st.promise_date, st.od, st.dl, st.pd
    from st;
$$;

-- ---------- ตัวเลขแจ้งเตือน: อ่าน v_contract_status ครั้งเดียว ----------
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

  with disp as materialized (
    select r.id, r.contract_id, r.update_ack_key, rd.dispatched_at, c.status as cstatus
      from public.field_visit_requests r
      join public.field_visit_rounds rd on rd.id = r.round_id
      join public.contracts c on c.id = r.contract_id
     where r.status = 'dispatched' and rd.dispatched_at is not null
  ), vs as materialized (
    select v.contract_id, v.days_late, v.overdue_amount
      from public.v_contract_status v
     where v.contract_id in (select d.contract_id from disp d)
  ), calc as (
    select d.update_ack_key, d.cstatus,
           coalesce(vs.days_late, 0)::integer as dl,
           coalesce(vs.overdue_amount, 0)::numeric as od,
           pr.pdate,
           public.field_visit_paid_since(d.contract_id, d.dispatched_at) as paid
      from disp d
      left join vs on vs.contract_id = d.contract_id
      left join lateral (
        select (f.next_follow_up_at at time zone 'Asia/Bangkok')::date as pdate
          from public.follow_ups f
         where f.contract_id = d.contract_id and f.follow_up_result = 'promised'
           and f.next_follow_up_at is not null and f.created_at > d.dispatched_at
         order by f.created_at desc limit 1
      ) pr on true
  ), st as (
    select calc.*, public.field_visit_state_from(cstatus, dl, od, pdate, paid, v_today) as s from calc
  )
  select count(*)::int into v_upd
    from st
   where st.s is not null
     and (st.s || ':' || coalesce(st.pdate::text, '')) is distinct from st.update_ack_key;

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

-- ---------- รายการหน้าแอดมิน: อ่าน v_contract_status ครั้งเดียว (ฟิลด์/ความหมายเดิมครบ) ----------
create or replace function public.list_field_visit_requests(p_days int default 90)
returns jsonb language plpgsql security definer set search_path = public, pg_catalog as $$
declare result jsonb; v_today date := (now() at time zone 'Asia/Bangkok')::date;
begin
  perform 1 from public.profiles p where p.id = auth.uid() and p.active = true and p.role = 'admin';
  if not found then raise exception 'เฉพาะแอดมินที่ใช้งานอยู่เท่านั้น' using errcode = '42501'; end if;

  with req as materialized (
    select r.*
      from public.field_visit_requests r
     where r.status in ('requested','dispatched')
        or coalesce(r.closed_at, r.result_at, r.requested_at) >= now() - make_interval(days => greatest(coalesce(p_days,90),0))
  ), vs as materialized (
    select v.contract_id, v.shop_name, v.days_late, v.overdue_amount, v.penalty_due
      from public.v_contract_status v
     where v.contract_id in (select q.contract_id from req q)
  ), x as (
    select r, c, rd, vs,
           lv.is_live,
           lv.promise_date as live_promise,
           lv.paid as live_paid,
           public.field_visit_state_from(
             c.status, coalesce(vs.days_late, 0)::integer, coalesce(vs.overdue_amount, 0)::numeric,
             lv.promise_date, lv.paid, v_today) as live_state_v
      from req r
      join public.contracts c on c.id = r.contract_id
      left join public.field_visit_rounds rd on rd.id = r.round_id
      left join vs on vs.contract_id = r.contract_id
      left join lateral (
        select (r.status = 'dispatched' and rd.dispatched_at is not null) as is_live,
               case when r.status = 'dispatched' and rd.dispatched_at is not null then
                 (select (f.next_follow_up_at at time zone 'Asia/Bangkok')::date
                    from public.follow_ups f
                   where f.contract_id = r.contract_id and f.follow_up_result = 'promised'
                     and f.next_follow_up_at is not null and f.created_at > rd.dispatched_at
                   order by f.created_at desc limit 1)
               end as promise_date,
               case when r.status = 'dispatched' and rd.dispatched_at is not null then
                 public.field_visit_paid_since(r.contract_id, rd.dispatched_at)
               end as paid
      ) lv on true
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', (x.r).id, 'contractId', (x.r).contract_id, 'reason', (x.r).reason, 'note', (x.r).note, 'status', (x.r).status,
    'requestedBy', (x.r).requested_by, 'requestedByName', (x.r).requested_by_name, 'requestedAt', (x.r).requested_at,
    'roundId', (x.r).round_id, 'roundLabel', (x.rd).label, 'dispatchedAt', (x.rd).dispatched_at,
    'resultNote', (x.r).result_note, 'resultAt', (x.r).result_at, 'resultByName', (x.r).result_by_name,
    'resultCode', (x.r).result_code, 'promiseDate', (x.r).promise_date,
    'closedAt', (x.r).closed_at, 'closedReason', (x.r).closed_reason,
    'invNo', (x.c).inv_no, 'contractNo', (x.c).contract_no, 'customerName', (x.c).customer_name,
    'shopName', (x.vs).shop_name, 'phone', (x.c).phone, 'phoneAlt1', (x.c).phone_alt1, 'phoneAlt2', (x.c).phone_alt2,
    'model', (x.c).model, 'storage', (x.c).storage, 'contractStatus', (x.c).status, 'currentGrade', (x.c).current_grade,
    'daysLate', coalesce((x.vs).days_late, 0), 'overdueAmount', coalesce((x.vs).overdue_amount, 0),
    'paidSinceRequest', public.field_visit_paid_since((x.r).contract_id, (x.r).requested_at),
    'liveState', case when x.is_live then x.live_state_v end,
    'liveKey', case when x.is_live and x.live_state_v is not null
                    then x.live_state_v || ':' || coalesce(x.live_promise::text, '') end,
    'ackKey', (x.r).update_ack_key, 'ackAt', (x.r).update_ack_at, 'ackByName', (x.r).update_ack_by_name,
    'paidSinceDispatch', case when (x.r).status = 'dispatched' and x.is_live then coalesce(x.live_paid, 0) else 0 end,
    'latestPromiseDate', case when x.is_live then x.live_promise end,
    'penaltyDue', coalesce((x.vs).penalty_due, 0),
    'closeCode', (x.r).close_code, 'holdUntil', (x.r).hold_until,
    'paidLast3d', public.field_visit_paid_since((x.r).contract_id, now() - interval '3 days'),
    'activePromiseDate', (
      select pr.d from (
        select (f.next_follow_up_at at time zone 'Asia/Bangkok')::date as d
          from public.follow_ups f
         where f.contract_id = (x.r).contract_id and f.follow_up_result = 'promised' and f.next_follow_up_at is not null
         order by f.created_at desc limit 1
      ) pr where pr.d >= v_today
    )
  ) order by ((x.r).status in ('requested','dispatched')) desc, (x.r).requested_at desc), '[]'::jsonb) into result
  from x;
  return result;
end $$;

-- ---------- สิทธิ์ (ตั้งซ้ำสำหรับฟังก์ชันที่เขียนใหม่) ----------
revoke all on function public.field_visit_state_from(text, integer, numeric, date, numeric, date) from public, anon, authenticated;
revoke all on function public.field_visit_live_state(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.count_field_visit_attention() from public, anon;
revoke all on function public.list_field_visit_requests(int) from public, anon;
grant execute on function public.count_field_visit_attention() to authenticated;
grant execute on function public.list_field_visit_requests(int) to authenticated;
