-- เพิ่ม requestedBy (uuid คนขอ) ในแผนที่ป้ายสถานะลงพื้นที่ เพื่อให้หน้าเว็บซ่อนลิงก์ "ยกเลิกคำขอ" จากคนที่ไม่ใช่คนขอ/แอดมิน
create or replace function public.get_field_visit_status_map()
returns jsonb language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_role text; result jsonb;
begin
  select p.role into v_role from public.profiles p where p.id = auth.uid() and p.active = true;
  if v_role is null or v_role not in ('admin','staff','freelancer') then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'contractId', r.contract_id, 'requestId', r.id, 'status', r.status, 'reason', r.reason,
    'requestedAt', r.requested_at, 'dispatchedAt', rd.dispatched_at,
    'requestedBy', r.requested_by
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

revoke all on function public.get_field_visit_status_map() from public, anon;
grant execute on function public.get_field_visit_status_map() to authenticated;
