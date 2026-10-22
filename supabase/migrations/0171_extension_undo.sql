-- 0171: เก็บสำเนาก่อนขยายและให้แอดมินยกเลิกการขยายที่กดผิดอย่างปลอดภัย
alter table public.contract_extensions
  add column if not exists reversed_at timestamptz,
  add column if not exists reversed_by uuid references public.profiles(id),
  add column if not exists reversed_by_name text,
  add column if not exists reversed_reason text;

create table if not exists public.contract_extension_versions (
  contract_id uuid primary key references public.contracts(id) on delete cascade,
  version bigint not null default 0
);
create table if not exists public.contract_extension_snapshots (
  extension_id uuid primary key references public.contract_extensions(id) on delete cascade,
  contract_id uuid not null references public.contracts(id) on delete cascade,
  before_state jsonb not null,
  after_state jsonb not null,
  after_version bigint not null,
  created_at timestamptz not null default now()
);
alter table public.contract_extension_versions enable row level security;
alter table public.contract_extension_snapshots enable row level security;
revoke all on public.contract_extension_versions,public.contract_extension_snapshots from anon,authenticated,service_role;
grant select on public.contract_extension_versions,public.contract_extension_snapshots to service_role;
revoke insert,update,delete on public.contract_extensions from anon,authenticated;

-- Ignore routine daily accrual, but retain manually overridden penalty values.
create or replace function public.extension_normalize_installment(p_row jsonb)
returns jsonb language sql immutable set search_path=public,pg_catalog as $$
  select case when coalesce((p_row->>'penalty_overridden')::boolean,false)
    then p_row - array['status','penalty_days']
    else p_row - array['status','penalty_days','penalty_amount'] end
$$;

-- Every financial mutation first locks the parent contract. Versioning catches even
-- an inserted-then-deleted receipt/fee or a changed-then-restored amount.
create or replace function public.track_extension_contract_activity()
returns trigger language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  old_row jsonb;
  new_row jsonb;
  old_id uuid;
  new_id uuid;
  cid uuid;
begin
  if tg_op<>'INSERT' then old_row:=to_jsonb(old); end if;
  if tg_op<>'DELETE' then new_row:=to_jsonb(new); end if;
  if tg_table_name='contracts' then
    old_id:=(old_row->>'id')::uuid; new_id:=(new_row->>'id')::uuid;
    if tg_op='UPDATE' and old_row-'updated_at'=new_row-'updated_at' then return new; end if;
  else
    old_id:=(old_row->>'contract_id')::uuid; new_id:=(new_row->>'contract_id')::uuid;
    if tg_table_name='installments' and tg_op='UPDATE'
       and public.extension_normalize_installment(old_row)=public.extension_normalize_installment(new_row)
      then return new;
    end if;
  end if;
  -- Contract rows already hold their own row lock on UPDATE/DELETE.
  if tg_table_name='contracts' and tg_op='INSERT' then return new; end if;
  for cid in select id from public.contracts where id in (old_id,new_id) order by id for update loop
    insert into public.contract_extension_versions(contract_id,version) values(cid,1)
      on conflict(contract_id) do update set version=contract_extension_versions.version+1;
  end loop;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['contracts','installments','payment_log','penalty_override_history',
    'other_income','fee_waivers','extra_charges','contract_extensions','contract_transfers',
    'contract_close_events','device_returns','pj_applied_ledger','pj_applied_receipts'] loop
    execute format('drop trigger if exists track_extension_activity on public.%I',t);
    execute format('create trigger track_extension_activity before insert or update or delete on public.%I for each row execute function public.track_extension_contract_activity()',t);
  end loop;
end $$;

create or replace function public.extension_contract_state(p_contract_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare result jsonb; rows_json jsonb; t text;
begin
  select jsonb_build_object('contract',to_jsonb(c)) into result from public.contracts c where id=p_contract_id;
  foreach t in array array['installments','payment_log','penalty_override_history','other_income',
    'fee_waivers','extra_charges','contract_extensions','contract_transfers','contract_close_events',
    'device_returns','pj_applied_ledger','pj_applied_receipts'] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),''[]''::jsonb) from public.%I r where contract_id=$1',t)
      into rows_json using p_contract_id;
    result:=result||jsonb_build_object(t,rows_json);
  end loop;
  return result;
end $$;

create or replace function public.extension_guard_state(p_state jsonb)
returns jsonb language sql immutable set search_path=public,pg_catalog as $$
  select jsonb_set(jsonb_set(p_state,'{contract}',(p_state->'contract')-'updated_at'),'{installments}',
    coalesce((select jsonb_agg(public.extension_normalize_installment(r) order by r->>'id')
      from jsonb_array_elements(p_state->'installments') r),'[]'::jsonb))
$$;

create or replace function public.restructure_contract(
  p_contract_id uuid,p_ext_type text,p_new_due_day int,p_new_term int,p_new_finance numeric,p_note text default null
) returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  c public.contracts%rowtype;
  before_state jsonb;
  eid uuid;
  last_paid int;
  monthly numeric;
  base_date date;
  due_date_new date;
  i int;
begin
  if not exists(select 1 from public.profiles where id=auth.uid() and active=true and role in ('admin','staff')) then
    raise exception 'ไม่มีสิทธิ์ขยายระยะเวลา' using errcode='42501';
  end if;
  if p_ext_type is null or p_ext_type not in ('due_day','months','both')
    or p_new_due_day is null or p_new_due_day not between 1 and 31
    or p_new_term is null or p_new_term not between 1 and 120
    or p_new_finance is null or p_new_finance<0 or p_new_finance::text in ('NaN','Infinity','-Infinity') then
    raise exception 'กรุณาตรวจวันที่ จำนวนงวด และยอดใหม่';
  end if;
  select * into c from public.contracts where id=p_contract_id for update;
  if not found then raise exception 'ไม่พบสัญญานี้'; end if;
  if c.status<>'active' or c.settled_at is not null then raise exception 'ขยายได้เฉพาะสัญญาที่ยังผ่อนอยู่'; end if;
  if exists(select 1 from public.contract_extensions where contract_id=p_contract_id and reversed_at is null
     and ((p_ext_type in ('due_day','both') and ext_type in ('due_day','both'))
       or (p_ext_type in ('months','both') and ext_type in ('months','both')))) then
    raise exception 'สัญญานี้ใช้สิทธิ์ขยายประเภทที่เลือกแล้ว';
  end if;
  if not exists(select 1 from public.installments where contract_id=p_contract_id and paid_at is null) then
    raise exception 'สัญญานี้ผ่อนหมดแล้ว ไม่ต้องขยายระยะเวลา';
  end if;
  if exists(select 1 from public.installments where contract_id=p_contract_id and paid_at is null and paid_amount>0) then
    raise exception 'กรุณาตรวจยอดที่ชำระบางส่วนก่อนขยายระยะเวลา';
  end if;
  if exists(select 1 from public.installments i where i.contract_id=p_contract_id and i.paid_at is null
       and (coalesce(i.settled,false) or exists(select 1 from public.payment_log l where l.installment_id=i.id
         and (l.amount>0 or l.paid_amount_after>0 or coalesce(l.penalty_paid_amount,0)>0)))) then
    raise exception 'งวดที่ยังเปิดมีประวัติรับเงินหรือค่าปรับ กรุณาให้แอดมินตรวจสอบก่อนขยาย';
  end if;
  before_state:=public.extension_contract_state(p_contract_id);
  select coalesce(max(installment_no),0) into last_paid from public.installments where contract_id=p_contract_id and paid_at is not null;
  monthly:=round(p_new_finance/p_new_term);
  delete from public.installments where contract_id=p_contract_id and paid_at is null;
  for i in 1..p_new_term loop
    base_date:=(date_trunc('month',current_date)+make_interval(months=>i))::date;
    due_date_new:=public.due_date_for(extract(year from base_date)::int,extract(month from base_date)::int,p_new_due_day);
    insert into public.installments(contract_id,installment_no,due_date,amount,status)
      values(p_contract_id,last_paid+i,due_date_new,monthly,'pending');
  end loop;
  insert into public.contract_extensions(contract_id,ext_type,old_due_day,new_due_day,old_term,new_term,
    old_finance,new_finance,old_monthly,new_monthly,new_installments,note)
    values(p_contract_id,p_ext_type,c.due_day,p_new_due_day,c.term_months,last_paid+p_new_term,
      c.finance_amount,p_new_finance,c.monthly_payment,monthly,p_new_term,p_note) returning id into eid;
  update public.contracts set due_day=p_new_due_day,monthly_payment=monthly,
    finance_amount=p_new_finance,term_months=last_paid+p_new_term where id=p_contract_id;
  insert into public.contract_extension_snapshots(extension_id,contract_id,before_state,after_state,after_version)
    select eid,p_contract_id,before_state,public.extension_contract_state(p_contract_id),version
      from public.contract_extension_versions where contract_id=p_contract_id;
end $$;

-- Called only after locking the parent; no frontend access to raw snapshots.
create or replace function public.extension_undo_blocked_reason(p_extension_id uuid)
returns text language plpgsql security definer set search_path=public,pg_catalog as $$
declare e public.contract_extensions%rowtype; s public.contract_extension_snapshots%rowtype;
begin
  select * into e from public.contract_extensions where id=p_extension_id;
  if not found then return 'ไม่พบรายการขยายนี้'; end if;
  if e.reversed_at is not null then return 'รายการขยายนี้ยกเลิกแล้ว'; end if;
  select * into s from public.contract_extension_snapshots where extension_id=p_extension_id;
  if not found then return 'รายการเก่านี้ไม่มีสำเนาก่อนขยาย กรุณาให้แอดมินตรวจสอบ'; end if;
  if exists(select 1 from public.contract_extensions where contract_id=e.contract_id and reversed_at is null
      and (created_at,id)>(e.created_at,e.id)) then return 'ยกเลิกได้เฉพาะรายการขยายล่าสุด'; end if;
  if (select version from public.contract_extension_versions where contract_id=e.contract_id) is distinct from s.after_version
     or public.extension_guard_state(public.extension_contract_state(e.contract_id))
       is distinct from public.extension_guard_state(s.after_state) then
    return 'มีการรับเงิน ค่าธรรมเนียม หรือแก้ข้อมูลหลังขยาย กรุณาให้แอดมินตรวจสอบก่อน';
  end if;
  return null;
end $$;

create or replace function public.extension_undo_preview(p_extension_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare cid uuid; s public.contract_extension_snapshots%rowtype; reason text;
begin
  if not exists(select 1 from public.profiles where id=auth.uid() and active=true and role='admin') then
    raise exception 'เฉพาะแอดมินที่ใช้งานอยู่เท่านั้นที่ยกเลิกการขยายได้' using errcode='42501';
  end if;
  select contract_id into cid from public.contract_extensions where id=p_extension_id;
  perform 1 from public.contracts where id=cid for update;
  reason:=public.extension_undo_blocked_reason(p_extension_id);
  select * into s from public.contract_extension_snapshots where extension_id=p_extension_id;
  -- Whitelist only schedule/monetary values; snapshots also contain private history.
  return jsonb_build_object('canUndo',reason is null,'blockedReason',reason,
    'before',case when s.extension_id is null then null else public.extension_schedule_preview(s.before_state) end,
    'after',case when s.extension_id is null then null else public.extension_schedule_preview(s.after_state) end);
end $$;

create or replace function public.extension_schedule_preview(p_state jsonb)
returns jsonb language sql immutable set search_path=public,pg_catalog as $$
  select jsonb_build_object('dueDay',p_state#>'{contract,due_day}','termMonths',p_state#>'{contract,term_months}',
    'financeAmount',p_state#>'{contract,finance_amount}','monthlyPayment',p_state#>'{contract,monthly_payment}',
    'installments',coalesce((select jsonb_agg(jsonb_build_object('id',r->'id','installmentNo',r->'installment_no',
      'dueDate',r->'due_date','amount',r->'amount','paidAmount',r->'paid_amount','paidAt',r->'paid_at')
      order by (r->>'installment_no')::int) from jsonb_array_elements(p_state->'installments') r),'[]'::jsonb))
$$;

create or replace function public.undo_contract_extension(p_extension_id uuid,p_reason text)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  e public.contract_extensions%rowtype;
  s public.contract_extension_snapshots%rowtype;
  c public.contracts%rowtype;
  reason text;
  actor_name text;
begin
  select full_name into actor_name from public.profiles where id=auth.uid() and active=true and role='admin';
  if not found then raise exception 'เฉพาะแอดมินที่ใช้งานอยู่เท่านั้นที่ยกเลิกการขยายได้' using errcode='42501'; end if;
  if p_reason is null or length(btrim(p_reason))<3 or length(btrim(p_reason))>1000 then
    raise exception 'กรุณาระบุเหตุผลการยกเลิก 3–1,000 ตัวอักษร';
  end if;
  select * into e from public.contract_extensions where id=p_extension_id;
  if not found then raise exception 'ไม่พบรายการขยายนี้'; end if;
  perform 1 from public.contracts where id=e.contract_id for update;
  reason:=public.extension_undo_blocked_reason(p_extension_id);
  if reason is not null then raise exception '%',reason; end if;
  select * into strict s from public.contract_extension_snapshots where extension_id=p_extension_id;
  c:=jsonb_populate_record(null::public.contracts,s.before_state->'contract');
  -- Paid rows were never deleted. Restore only original open rows, with original IDs.
  delete from public.installments where contract_id=e.contract_id and paid_at is null;
  insert into public.installments select r.* from jsonb_populate_recordset(null::public.installments,s.before_state->'installments') r
    where r.paid_at is null;
  -- Old logs survive extension with FK set null; restore those links, without replaying money.
  update public.payment_log l set installment_id=r.installment_id
    from jsonb_populate_recordset(null::public.payment_log,s.before_state->'payment_log') r
    where l.id=r.id and l.contract_id=e.contract_id and l.installment_id is distinct from r.installment_id;
  insert into public.penalty_override_history select r.*
    from jsonb_populate_recordset(null::public.penalty_override_history,s.before_state->'penalty_override_history') r
    where not exists(select 1 from public.penalty_override_history h where h.id=r.id);
  -- Recalculate ordinary elapsed penalties for today; preserve manual overrides.
  update public.installments i set penalty_days=a.penalty_days,penalty_amount=a.penalty_amount,
    status=case when i.due_date<current_date then 'late' else 'pending' end
    from (select x.id,p.penalty_days,p.penalty_amount from public.installments x
      cross join lateral public.penalty_accrual_for_installment(x.id) p
      where x.contract_id=e.contract_id and x.paid_at is null and not coalesce(x.penalty_overridden,false)) a
    where i.id=a.id;
  update public.contracts set due_day=c.due_day,term_months=c.term_months,
    finance_amount=c.finance_amount,monthly_payment=c.monthly_payment where id=e.contract_id;
  update public.contract_extensions set reversed_at=now(),reversed_by=auth.uid(),
    reversed_by_name=coalesce(actor_name,''),reversed_reason=btrim(p_reason) where id=p_extension_id;
end $$;

-- Narrowly update existing SQL consumers, retaining their complete deployed bodies.
-- Fail if expected source fragments disappeared; silently missing a consumer is unsafe.
do $$ declare fn record; body text; patched text; begin
  for fn in select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('regen_installments','get_collector_recoveries','staff_settlement_quote') loop
    body:=pg_get_functiondef(fn.oid); patched:=body;
    if fn.proname='regen_installments' then
      patched:=replace(body,'select 1 from contract_extensions where contract_id = p_contract_id',
        'select 1 from contract_extensions where contract_id = p_contract_id and reversed_at is null');
    elsif fn.proname='get_collector_recoveries' then
      patched:=replace(body,'select contract_id from public.contract_extensions',
        'select contract_id from public.contract_extensions where reversed_at is null');
    else
      patched:=replace(body,'where contract_id = p_contract_id and ext_type <> ''due_day''',
        'where contract_id = p_contract_id and reversed_at is null and ext_type <> ''due_day''');
    end if;
    if patched=body and position('reversed_at is null' in body)=0 then
      raise exception 'Unrecognized extension consumer: %',fn.proname;
    end if;
    execute patched;
  end loop;
end $$;

revoke all on function public.extension_normalize_installment(jsonb),public.track_extension_contract_activity(),
  public.extension_contract_state(uuid),public.extension_guard_state(jsonb),public.extension_undo_blocked_reason(uuid),
  public.extension_schedule_preview(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.restructure_contract(uuid,text,int,int,numeric,text),
  public.extension_undo_preview(uuid),public.undo_contract_extension(uuid,text) from public,anon;
grant execute on function public.restructure_contract(uuid,text,int,int,numeric,text),
  public.extension_undo_preview(uuid),public.undo_contract_extension(uuid,text) to authenticated;
