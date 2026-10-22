-- ทดสอบเฉพาะข้อมูลจำลอง แล้ว ROLLBACK ทั้งหมด: ต้องติดตั้ง 0171 ก่อน
-- No permanent helpers, no production-customer mutations, no new auth users.
begin;
set local statement_timeout='30s';
do $$
declare
  cid uuid:=gen_random_uuid();
  aid uuid;
  staff_id uuid;
  iid uuid;
  second_id uuid;
  eid uuid;
  log_id uuid;
  snapshot_before jsonb;
  restored jsonb;
  blocked_state jsonb;
  preview jsonb;
  rejected boolean;
begin
  select id into strict aid from public.profiles where role='admin' and active=true order by id limit 1;
  select id into strict staff_id from public.profiles where role='staff' and active=true order by id limit 1;
  perform set_config('request.jwt.claim.sub',aid::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',aid,'role','authenticated')::text,true);
  insert into public.contracts(id,contract_no,customer_name,transaction_date,due_day,term_months,
    finance_amount,monthly_payment,status)
    values(cid,'TEST-UNDO-'||cid::text,'ทดสอบยกเลิกการขยาย ห้ามใช้จริง',
      (current_date-interval '2 months')::date,15,3,3000,1000,'active');
  if (select count(*) from public.installments where contract_id=cid)<>3 then
    raise exception 'FAIL fixture generation'; end if;
  select id into iid from public.installments where contract_id=cid and installment_no=1;
  select id into second_id from public.installments where contract_id=cid and installment_no=2;
  update public.installments set paid_at=now(),paid_amount=1000,status='paid' where id=iid;
  insert into public.payment_log(contract_id,installment_id,action,amount,paid_amount_after)
    values(cid,iid,'pay',1000,1000);
  -- A zero-value historical cancellation must regain its original FK on undo.
  insert into public.payment_log(contract_id,installment_id,action,amount,paid_amount_after)
    values(cid,second_id,'cancel',0,0) returning id into log_id;
  update public.installments set penalty_overridden=true,penalty_amount=310 where id=second_id;
  insert into public.penalty_override_history(contract_id,installment_id,old_amount,new_amount,reason,by_name)
    values(cid,second_id,0,310,'synthetic override restore test','ทดสอบ');
  -- Partial-payment guard must leave all state untouched.
  begin
    update public.installments set paid_amount=500 where id=second_id;
    rejected:=false;
    begin perform public.restructure_contract(cid,'both',30,4,4000,'test partial');
      exception when others then
        if sqlerrm not like '%ชำระบางส่วน%' then raise; end if;
        rejected:=true;
    end;
    if not rejected then raise exception 'FAIL partial payment was accepted'; end if;
    raise sqlstate 'P7777';
  exception when sqlstate 'P7777' then null; end;
  -- Penalty-only receipts must also block; never detach collected money.
  begin
    insert into public.payment_log(contract_id,installment_id,action,amount,paid_amount_after,penalty_paid_amount)
      values(cid,second_id,'pay',100,0,100);
    rejected:=false;
    begin perform public.restructure_contract(cid,'both',30,4,4000,'test penalty');
      exception when others then
        if sqlerrm not like '%ประวัติรับเงินหรือค่าปรับ%' then raise; end if;
        rejected:=true;
    end;
    if not rejected then raise exception 'FAIL penalty-only receipt was accepted'; end if;
    raise sqlstate 'P7777';
  exception when sqlstate 'P7777' then null; end;
  snapshot_before:=public.extension_contract_state(cid);
  perform public.restructure_contract(cid,'both',30,4,4000,'test reversible');
  select id into strict eid from public.contract_extensions where contract_id=cid and reversed_at is null;
  if (select installment_id from public.payment_log where id=log_id) is not null then
    raise exception 'FAIL fixture FK did not detach'; end if;
  preview:=public.extension_undo_preview(eid);
  if not (preview->>'canUndo')::boolean then raise exception 'FAIL clean undo blocked: %',preview; end if;
  if jsonb_array_length(preview#>'{before,installments}')<>3
    or jsonb_array_length(preview#>'{after,installments}')<>5 then raise exception 'FAIL preview schedules'; end if;
  -- Active once-per-type rule is now enforced at the data boundary.
  rejected:=false;
  begin perform public.restructure_contract(cid,'months',30,2,2000,'duplicate');
    exception when others then
      if sqlerrm not like '%ใช้สิทธิ์%' then raise; end if; rejected:=true;
  end;
  if not rejected then raise exception 'FAIL duplicate extension accepted'; end if;
  -- Staff and unauthenticated users cannot preview or undo.
  perform set_config('request.jwt.claim.sub',staff_id::text,true);
  rejected:=false;
  begin perform public.undo_contract_extension(eid,'staff attempt');
    exception when insufficient_privilege then rejected:=true; end;
  if not rejected then raise exception 'FAIL staff undo accepted'; end if;
  rejected:=false;
  begin perform public.extension_undo_preview(eid);
    exception when insufficient_privilege then rejected:=true; end;
  if not rejected then raise exception 'FAIL staff preview accepted'; end if;
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{}',true);
  rejected:=false;
  begin perform public.undo_contract_extension(eid,'anonymous attempt');
    exception when insufficient_privilege then rejected:=true; end;
  if not rejected then raise exception 'FAIL anonymous undo accepted'; end if;
  perform set_config('request.jwt.claim.sub',aid::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',aid,'role','authenticated')::text,true);
  -- Invalid reason and legacy missing backup.
  rejected:=false;
  begin perform public.undo_contract_extension(eid,' ');
    exception when others then if sqlerrm not like '%เหตุผล%' then raise; end if; rejected:=true; end;
  if not rejected then raise exception 'FAIL blank reason accepted'; end if;
  begin
    delete from public.contract_extension_snapshots where extension_id=eid;
    if public.extension_undo_blocked_reason(eid) not like '%ไม่มีสำเนา%' then raise exception 'FAIL legacy backup guard'; end if;
    raise sqlstate 'P7777';
  exception when sqlstate 'P7777' then null; end;
  -- Subsequent orphan receipt (not linked to any installment) blocks undo.
  begin
    insert into public.payment_log(contract_id,action,amount,paid_amount_after) values(cid,'pay',50,50);
    blocked_state:=public.extension_contract_state(cid);
    rejected:=false;
    begin perform public.undo_contract_extension(eid,'must block new receipt');
      exception when others then if sqlerrm not like '%หลังขยาย%' then raise; end if; rejected:=true; end;
    if not rejected then raise exception 'FAIL orphan receipt guard'; end if;
    if public.extension_contract_state(cid) is distinct from blocked_state then
      raise exception 'FAIL blocked undo modified existing data'; end if;
    raise sqlstate 'P7777';
  exception when sqlstate 'P7777' then null; end;
  -- An inserted then deleted fee still counts as intervening financial activity.
  begin
    insert into public.other_income(contract_id,amount,category,received_at,recorded_by)
      values(cid,500,'ค่าธรรมเนียม',current_date,'ทดสอบ');
    delete from public.other_income where contract_id=cid;
    if public.extension_undo_blocked_reason(eid) is null then raise exception 'FAIL fee history guard'; end if;
    raise sqlstate 'P7777';
  exception when sqlstate 'P7777' then null; end;
  begin
    update public.installments set amount=amount+1 where contract_id=cid and installment_no=2;
    if public.extension_undo_blocked_reason(eid) is null then raise exception 'FAIL installment edit guard'; end if;
    raise sqlstate 'P7777';
  exception when sqlstate 'P7777' then null; end;
  begin
    update public.contracts set status='closed' where id=cid;
    if public.extension_undo_blocked_reason(eid) is null then raise exception 'FAIL status guard'; end if;
    raise sqlstate 'P7777';
  exception when sqlstate 'P7777' then null; end;
  begin
    update public.contracts set finance_amount=finance_amount+1 where id=cid;
    if public.extension_undo_blocked_reason(eid) is null then raise exception 'FAIL contract amount guard'; end if;
    raise sqlstate 'P7777';
  exception when sqlstate 'P7777' then null; end;
  begin
    update public.installments set penalty_overridden=true,penalty_amount=123
      where contract_id=cid and installment_no=2;
    if public.extension_undo_blocked_reason(eid) is null then raise exception 'FAIL manual penalty guard'; end if;
    raise sqlstate 'P7777';
  exception when sqlstate 'P7777' then null; end;
  begin
    insert into public.contract_extensions(contract_id,ext_type,created_at)
      select cid,'months',created_at+interval '1 second' from public.contract_extensions where id=eid;
    if public.extension_undo_blocked_reason(eid) not like '%ล่าสุด%' then raise exception 'FAIL latest active guard'; end if;
    raise sqlstate 'P7777';
  exception when sqlstate 'P7777' then null; end;
  -- Routine nightly status/accrual must not block a clean undo.
  update public.installments set penalty_days=2,penalty_amount=200,status='late'
    where contract_id=cid and paid_at is null;
  if public.extension_undo_blocked_reason(eid) is not null then raise exception 'FAIL daily accrual blocked undo'; end if;
  perform public.undo_contract_extension(eid,'ทดสอบคืนข้อมูลเดิมและประวัติ');
  restored:=public.extension_contract_state(cid);
  if public.extension_guard_state(snapshot_before)->'installments'
     is distinct from public.extension_guard_state(restored)->'installments'
     or snapshot_before->'payment_log' is distinct from restored->'payment_log'
     or snapshot_before->'penalty_override_history' is distinct from restored->'penalty_override_history'
     or (snapshot_before->'contract')-'updated_at' is distinct from (restored->'contract')-'updated_at' then
    raise exception 'FAIL original IDs, amounts, links, overrides or contract not restored';
  end if;
  if not exists(select 1 from public.contract_extensions where id=eid and reversed_at is not null
    and reversed_by=aid and reversed_reason='ทดสอบคืนข้อมูลเดิมและประวัติ') then raise exception 'FAIL missing cancellation audit'; end if;
  rejected:=false;
  begin perform public.undo_contract_extension(eid,'repeat');
    exception when others then if sqlerrm not like '%ยกเลิกแล้ว%' then raise; end if; rejected:=true; end;
  if not rejected then raise exception 'FAIL repeated undo accepted'; end if;
  -- Rights become available again; canceled history is retained.
  perform public.restructure_contract(cid,'months',15,2,2000,'after undo');
  if (select count(*) from public.contract_extensions where contract_id=cid)<>2
    or (select count(*) from public.contract_extensions where contract_id=cid and reversed_at is null)<>1 then
    raise exception 'FAIL canceled rights or history'; end if;
  raise notice 'PASS: snapshot, partial/penalty guards, roles, legacy, receipts, fees, edits, accrual, exact restoration, idempotency, rights';
end $$;
rollback;
