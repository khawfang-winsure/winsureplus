-- ฟังก์ชันให้แอดมินดูจำนวน/รายการคำขอขยายย้อนหลัง (รออนุมัติ + ตัดสินแล้วล่าสุด) สำหรับหน้ากล่องรับงาน
create or replace function public.count_pending_retrospective_extension_requests()
returns integer language plpgsql security definer set search_path=public,pg_catalog as $$
declare n integer;
begin
  perform 1 from public.profiles where id=auth.uid() and active=true and role='admin';
  if not found then raise exception 'เฉพาะแอดมินที่ใช้งานอยู่เท่านั้น' using errcode='42501'; end if;
  select count(*)::integer into n from public.retrospective_extension_requests where status='pending';
  return n;
end $$;

create or replace function public.list_retrospective_extension_requests(p_days int default 30)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare result jsonb;
begin
  perform 1 from public.profiles where id=auth.uid() and active=true and role='admin';
  if not found then raise exception 'เฉพาะแอดมินที่ใช้งานอยู่เท่านั้น' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',r.id,'contractId',r.contract_id,'status',r.status,
    'contractNo',c.contract_no,'invNo',c.inv_no,'customerName',c.customer_name,
    'extType',r.input->>'extType','customerRequestedAt',r.customer_requested_at,
    'effectiveDate',r.effective_date,'recordedAt',r.recorded_at,'recordedByName',r.recorded_by_name,
    'reason',r.reason,'approvalReason',r.approval_reason,
    'decidedAt',r.approved_at,'decidedByName',r.approved_by_name
  ) order by (r.status='pending') desc, r.recorded_at desc),'[]'::jsonb) into result
  from public.retrospective_extension_requests r
  join public.contracts c on c.id=r.contract_id
  where r.status='pending'
     or (r.status in ('approved','rejected') and r.approved_at >= now() - make_interval(days => greatest(coalesce(p_days,30),0)));
  return result;
end $$;

revoke all on function public.count_pending_retrospective_extension_requests(),public.list_retrospective_extension_requests(int) from public,anon;
grant execute on function public.count_pending_retrospective_extension_requests(),public.list_retrospective_extension_requests(int) to authenticated;
