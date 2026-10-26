-- 0172: ขอขยายย้อนหลังโดยเก็บวันบันทึกจริง แสดงผลก่อน/หลัง และให้แอดมินอนุมัติ
alter table public.contract_extensions
  add column if not exists customer_requested_at timestamptz,
  add column if not exists effective_date date,
  add column if not exists approval_reason text,
  add column if not exists approved_by uuid references public.profiles(id),
  add column if not exists approved_by_name text;
create table if not exists public.retrospective_extension_requests (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  status text not null default 'pending' check(status in ('pending','approved','rejected')),
  customer_requested_at timestamptz not null,
  effective_date date not null,
  recorded_at timestamptz not null default clock_timestamp(),
  recorded_by uuid not null references public.profiles(id),
  recorded_by_name text,
  reason text not null,
  evidence_ref text not null,
  input jsonb not null,
  before_state jsonb not null,
  before_version bigint not null,
  submitted_preview jsonb not null,
  approved_preview jsonb,
  approval_reason text,
  penalty_adjustment_confirmed boolean not null default false,
  approved_at timestamptz,
  approved_by uuid references public.profiles(id),
  approved_by_name text,
  extension_id uuid references public.contract_extensions(id)
);
create index if not exists retrospective_extension_requests_contract_idx
  on public.retrospective_extension_requests(contract_id,recorded_at desc);
alter table public.retrospective_extension_requests enable row level security;
revoke all on public.retrospective_extension_requests from public,anon,authenticated,service_role;
grant select on public.retrospective_extension_requests to service_role;

-- Evaluate a proposed due date without changing the real installment or its history.
create or replace function public.retrospective_penalty(p_installment_id uuid,p_due_date date)
returns numeric language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  inst public.installments%rowtype;
  per_day numeric;
  max_days int;
  paid numeric:=0;
  frozen numeric;
  owed numeric;
  event record;
begin
  select * into inst from public.installments where id=p_installment_id;
  if not found then return 0; end if;
  if coalesce(inst.penalty_overridden,false) then
    return greatest(0,inst.penalty_amount-public.penalty_paid_for_installment(inst.id));
  end if;
  select value::numeric into per_day from public.app_settings where key='penalty_per_day';
  select value::int into max_days from public.app_settings where key='penalty_max_days';
  if per_day is null or max_days is null then raise exception 'ไม่พบอัตราค่าปรับ ต้องตรวจการตั้งค่าก่อน'; end if;
  for event in select action,coalesce(penalty_paid_amount,0) pen,created_at from public.payment_log
    where installment_id=inst.id and action in ('pay','cancel') order by created_at,id loop
    if event.action='cancel' then paid:=0; frozen:=null; continue; end if;
    paid:=paid+event.pen;
    owed:=least(greatest(0,event.created_at::date-p_due_date),max_days)*per_day;
    if frozen is null and owed>0 and paid>=owed then frozen:=owed; end if;
  end loop;
  return greatest(0,coalesce(frozen,least(greatest(0,current_date-p_due_date),max_days)*per_day)-paid);
end $$;

-- No financial writes: build an explicit itemized schedule, retaining every paid/partial row.
create or replace function public.plan_retrospective_extension(p_contract_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  c public.contracts%rowtype;
  before_state jsonb;
  after_state jsonb;
  reasons text[]:=array[]::text[];
  requested date;
  effective date;
  today date;
  due_day int;
  finance numeric;
  monthly numeric;
  evidence numeric;
  ext_type text;
  schedule jsonb;
  after_rows jsonb;
  row_json jsonb;
  candidate record;
  old_inst public.installments%rowtype;
  target_date date;
  last_paid int;
  original_last int;
  new_last int;
  last_due date;
  count_open int;
  remaining_before numeric;
  remaining_after numeric:=0;
  partial numeric;
  penalty_before numeric:=0;
  penalty_after numeric:=0;
  expected_down numeric;
  orphan_paid numeric;
  latest_balance numeric;
  per_day numeric;
  max_penalty_days int;
begin
  if p_input is null or jsonb_typeof(p_input)<>'object' then raise exception 'ข้อมูลคำขอไม่ถูกต้อง'; end if;
  requested:=(p_input->>'customerRequestedAt')::timestamptz at time zone 'Asia/Bangkok';
  effective:=(p_input->>'effectiveDate')::date;
  today:=timezone('Asia/Bangkok',clock_timestamp())::date;
  due_day:=(p_input->>'newDueDay')::int;
  finance:=(p_input->>'newFinanceAmount')::numeric;
  monthly:=(p_input->>'newMonthlyPayment')::numeric;
  evidence:=(p_input->>'evidenceRemaining')::numeric;
  ext_type:=p_input->>'extType';
  schedule:=p_input->'schedule';
  if requested is null or effective is null or due_day is null or due_day not between 1 and 31
    or finance is null or finance<0 or finance::text in ('NaN','Infinity','-Infinity')
    or monthly is null or monthly<=0 or monthly::text in ('NaN','Infinity','-Infinity')
    or evidence is null or evidence<0 or evidence::text in ('NaN','Infinity','-Infinity')
    or ext_type is null or ext_type not in ('due_day','months','both')
    or coalesce(length(btrim(p_input->>'reason')),0) not between 10 and 2000
    or coalesce(length(btrim(p_input->>'evidenceRef')),0) not between 10 and 2000
    or schedule is null or jsonb_typeof(schedule)<>'array' then
    raise exception 'กรุณาระบุวันที่ เหตุผล หลักฐาน และตารางงวดให้ครบ (เหตุผลและหลักฐานอย่างน้อย 10 ตัวอักษร)';
  end if;
  select * into c from public.contracts where id=p_contract_id;
  if not found then raise exception 'ไม่พบสัญญานี้'; end if;
  before_state:=public.extension_contract_state(p_contract_id);
  if c.status<>'active' or c.settled_at is not null then reasons:=array_append(reasons,'สัญญานี้ไม่ได้อยู่ระหว่างผ่อน'); end if;
  if effective>today or requested>today or requested>effective or effective<c.transaction_date then
    reasons:=array_append(reasons,'วันที่ลูกค้าขอและวันที่ให้มีผลต้องเป็นวันที่เกิดขึ้นจริง ไม่ใช่วันในอนาคต'); end if;
  select coalesce(max(installment_no) filter(where paid_at is not null),0),coalesce(max(installment_no),0),
    count(*) filter(where paid_at is null),coalesce(sum(amount-paid_amount) filter(where paid_at is null),0),
    coalesce(sum(paid_amount) filter(where paid_at is null),0)
    into last_paid,original_last,count_open,remaining_before,partial from public.installments where contract_id=p_contract_id;
  if count_open=0 then reasons:=array_append(reasons,'สัญญานี้ไม่มีงวดค้าง'); end if;
  if requested>(select min(due_date) from public.installments where contract_id=p_contract_id and paid_at is null) then
    reasons:=array_append(reasons,'วันที่ลูกค้าขอต้องไม่เกินวันครบกำหนดเดิม ต้องใช้หลักฐานวันที่ขอจริง'); end if;
  if exists(select 1 from public.installments where contract_id=p_contract_id and installment_no<=last_paid and paid_at is null) then
    reasons:=array_append(reasons,'งวดที่จ่ายแล้วไม่เรียงต่อกัน ต้องตรวจการจับคู่เงินก่อน'); end if;
  if exists(select 1 from public.contract_extensions e where e.contract_id=p_contract_id and e.reversed_at is null
    and ((e.ext_type in ('due_day','both') and p_input->>'extType' in ('due_day','both'))
      or (e.ext_type in ('months','both') and p_input->>'extType' in ('months','both')))) then
    reasons:=array_append(reasons,'สัญญานี้ใช้สิทธิ์ขยายประเภทที่เลือกแล้ว'); end if;
  if exists(select 1 from public.pj_sync_review where matched_contract_id=p_contract_id and status='pending') then
    reasons:=array_append(reasons,'ยังมีเงินหรือข้อมูล PJ รอตรวจ ต้องสะสางให้ตรงก่อนอนุมัติ'); end if;
  if exists(select 1 from public.payment_log p join public.installments i on i.id=p.installment_id
    where i.contract_id=p_contract_id and i.paid_at is null and p.action='cancel') then
    reasons:=array_append(reasons,'มีประวัติรับชำระที่ถูกยกเลิกในงวดค้าง ต้องตรวจเทียบกับ PJ ก่อนอนุมัติ'); end if;
  expected_down:=round(coalesce(c.device_price,0)*coalesce(c.down_percent,0)/100);
  select coalesce(sum(amount),0) into orphan_paid from public.payment_log
    where contract_id=p_contract_id and installment_id is null and action='pay';
  if orphan_paid>0 and orphan_paid<>expected_down then
    reasons:=array_append(reasons,'มีรายการรับเงินที่ยังไม่จับคู่งวดหรือไม่ตรงเงินดาวน์ ต้องตรวจให้ตรงก่อน'); end if;
  if jsonb_array_length(schedule) not between 1 and 120 then raise exception 'ตารางงวดต้องมี 1–120 รายการ'; end if;
  select max((x->>'installmentNo')::int) into new_last from jsonb_array_elements(schedule) x;
  if new_last is null or new_last<original_last or new_last-last_paid<>jsonb_array_length(schedule)
    or (select count(distinct (x->>'installmentNo')::int) from jsonb_array_elements(schedule)x)<>jsonb_array_length(schedule)
    or exists(select 1 from jsonb_array_elements(schedule)x where (x->>'installmentNo')::int is null
      or (x->>'installmentNo')::int<=last_paid or (x->>'installmentNo')::int>new_last) then
    raise exception 'ต้องระบุทุกงวดที่ยังเปิดเรียงต่อกัน ห้ามลบงวดเดิมที่มีประวัติ'; end if;
  after_rows:=coalesce((select jsonb_agg(to_jsonb(i) order by installment_no) from public.installments i
    where contract_id=p_contract_id and paid_at is not null),'[]'::jsonb);
  for candidate in select (x->>'installmentNo')::int no,(x->>'dueDate')::date due,(x->>'amount')::numeric amount
    from jsonb_array_elements(schedule)x order by (x->>'installmentNo')::int loop
    if candidate.due is null or candidate.amount is null or candidate.amount<=0
      or candidate.amount::text in ('NaN','Infinity','-Infinity') or candidate.due<effective
      or candidate.due<>public.due_date_for(extract(year from candidate.due)::int,extract(month from candidate.due)::int,due_day)
      or (last_due is not null and date_trunc('month',candidate.due)<>date_trunc('month',last_due)+interval '1 month') then
      raise exception 'ตรวจจำนวนเงินและวันครบกำหนด: ต้องเรียงทุกเดือนและตรงวันที่เลือก'; end if;
    -- Past-due schedules remain visible as blocked requests; they can never be
    -- approved with a penalty that was absent from the review preview.
    if candidate.due<=today then
      reasons:=array_append(reasons,'งวดใหม่ต้องครบกำหนดในอนาคตเพื่อให้ตรวจค่าปรับก่อนอนุมัติ'); end if;
    last_due:=candidate.due;
    select * into old_inst from public.installments where contract_id=p_contract_id and installment_no=candidate.no;
    if found then
      if old_inst.paid_at is not null or old_inst.paid_amount<0 or candidate.amount<=old_inst.paid_amount or coalesce(old_inst.settled,false) then
        raise exception 'ห้ามแก้งวดที่ปิดแล้ว หรือตั้งยอดต่ำกว่าเงินที่ลูกค้าชำระไว้'; end if;
      select paid_amount_after into latest_balance from public.payment_log where installment_id=old_inst.id
        order by created_at desc,id desc limit 1;
      if (latest_balance is null and old_inst.paid_amount>0) or (latest_balance is not null and latest_balance<>old_inst.paid_amount) then
        reasons:=array_append(reasons,'ยอดรับชำระกับประวัติงวด '||candidate.no||' ไม่ตรง ต้องจับคู่เงินก่อน'); end if;
      penalty_before:=penalty_before+greatest(0,old_inst.penalty_amount-public.penalty_paid_for_installment(old_inst.id));
      penalty_after:=penalty_after+public.retrospective_penalty(old_inst.id,candidate.due);
      row_json:=to_jsonb(old_inst)||jsonb_build_object('due_date',candidate.due,'amount',candidate.amount);
      remaining_after:=remaining_after+candidate.amount-old_inst.paid_amount;
    else
      row_json:=jsonb_build_object('id','new:'||candidate.no,'contract_id',p_contract_id,'installment_no',candidate.no,
        'due_date',candidate.due,'amount',candidate.amount,'paid_amount',0,'paid_at',null);
      remaining_after:=remaining_after+candidate.amount;
      if candidate.due<=today then
        select value::numeric into per_day from public.app_settings where key='penalty_per_day';
        select value::int into max_penalty_days from public.app_settings where key='penalty_max_days';
        if per_day is null or max_penalty_days is null then raise exception 'ไม่พบอัตราค่าปรับ ต้องตรวจการตั้งค่าก่อน'; end if;
        penalty_after:=penalty_after+least(greatest(0,today-candidate.due),max_penalty_days)*per_day;
      end if;
    end if;
    after_rows:=after_rows||jsonb_build_array(row_json);
  end loop;
  if remaining_after<>evidence then reasons:=array_append(reasons,'ยอดคงเหลือในตารางกับหลักฐานต่างกัน '||(remaining_after-evidence)||' บาท ต้องตรวจให้ตรงก่อน'); end if;
  -- Standard gross monthly amount must match each regular row; only an explicitly itemized final adjustment may differ.
  if exists(select 1 from jsonb_array_elements(schedule)x where
      ((x->>'installmentNo')::int<new_last or jsonb_array_length(schedule)=1)
      and (x->>'amount')::numeric<>monthly) then
    reasons:=array_append(reasons,'ค่างวดสรุปต้องตรงกับงวดปกติในตาราง อนุญาตยอดปรับต่างได้เฉพาะงวดสุดท้ายที่ระบุชัดเจน'); end if;
  if p_input->>'extType'='months' and due_day<>c.due_day then
    reasons:=array_append(reasons,'ขยายจำนวนงวดอย่างเดียวต้องคงวันที่ชำระเดิม'); end if;
  if p_input->>'extType' in ('months','both') and new_last<=original_last then
    reasons:=array_append(reasons,'การขยายจำนวนงวดต้องเพิ่มงวดจากสัญญาเดิม'); end if;
  if p_input->>'extType' in ('due_day','both') and due_day=c.due_day then
    reasons:=array_append(reasons,'ประเภทนี้ต้องเปลี่ยนวันชำระจากสัญญาเดิม'); end if;
  if p_input->>'extType'='due_day' and (finance<>c.finance_amount or monthly<>c.monthly_payment or new_last<>original_last or exists(select 1 from jsonb_array_elements(schedule)x
    join public.installments i on i.contract_id=p_contract_id and i.installment_no=(x->>'installmentNo')::int
    where i.amount<>(x->>'amount')::numeric)) then reasons:=array_append(reasons,'เปลี่ยนวันอย่างเดียวต้องคงจำนวนงวดและยอดแต่ละงวดเดิม'); end if;
  after_state:=before_state||jsonb_build_object('contract',(before_state->'contract')||jsonb_build_object(
    'due_day',due_day,'term_months',new_last,'monthly_payment',monthly,'finance_amount',finance),'installments',after_rows);
  return jsonb_build_object('canApprove',cardinality(reasons)=0,'blockedReasons',to_jsonb(reasons),
    'before',public.extension_schedule_preview(before_state),'after',public.extension_schedule_preview(after_state),
    'remainingBefore',remaining_before,'remainingAfter',remaining_after,'evidenceRemaining',evidence,
    'difference',remaining_after-evidence,'penaltyBefore',penalty_before,'penaltyAfter',penalty_after,'partialPaid',partial);
end $$;

create or replace function public.retrospective_extension_request_json(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare r public.retrospective_extension_requests%rowtype; preview jsonb; blocked text[]:=array[]::text[];
begin
  select * into r from public.retrospective_extension_requests where id=p_request_id;
  if not found then raise exception 'ไม่พบคำขอ'; end if;
  if r.status='pending' then
    if coalesce((select version from public.contract_extension_versions where contract_id=r.contract_id),0)<>r.before_version
      or public.extension_guard_state(public.extension_contract_state(r.contract_id)) is distinct from public.extension_guard_state(r.before_state) then
      preview:=r.submitted_preview;
      blocked:=array_append(blocked,'ข้อมูลเปลี่ยนหลังส่งคำขอ ต้องตรวจและส่งคำขอใหม่');
    else
      preview:=public.plan_retrospective_extension(r.contract_id,r.input);
    end if;
  else
    preview:=coalesce(r.approved_preview,r.submitted_preview);
    blocked:=array_append(blocked,'คำขอนี้ไม่ได้รออนุมัติแล้ว');
  end if;
  if cardinality(blocked)>0 then preview:=preview||jsonb_build_object('canApprove',false,
    'blockedReasons',(preview->'blockedReasons')||to_jsonb(blocked)); end if;
  return jsonb_build_object('id',r.id,'contractId',r.contract_id,'status',r.status,
    'customerRequestedAt',to_char(r.customer_requested_at at time zone 'Asia/Bangkok','YYYY-MM-DD'),'effectiveDate',r.effective_date,'recordedAt',r.recorded_at,
    'recordedByName',r.recorded_by_name,'reason',r.reason,'evidenceRef',r.evidence_ref,
    'approvalReason',r.approval_reason,'approvedAt',r.approved_at,'approvedByName',r.approved_by_name,
    'penaltyAdjustmentConfirmed',r.penalty_adjustment_confirmed,
    'extensionId',r.extension_id,'input',r.input,'preview',preview);
end $$;

create or replace function public.create_retrospective_extension_request(p_contract_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare rid uuid; actor_name text; submitted jsonb;
begin
  select full_name into actor_name from public.profiles where id=auth.uid() and active=true and role in ('admin','staff');
  if not found then raise exception 'ไม่มีสิทธิ์ส่งคำขอ' using errcode='42501'; end if;
  perform 1 from public.contracts where id=p_contract_id for update;
  submitted:=public.plan_retrospective_extension(p_contract_id,p_input);
  insert into public.retrospective_extension_requests(contract_id,customer_requested_at,effective_date,recorded_by,
    recorded_by_name,reason,evidence_ref,input,before_state,before_version,submitted_preview)
    values(p_contract_id,(p_input->>'customerRequestedAt')::timestamptz,(p_input->>'effectiveDate')::date,auth.uid(),
      actor_name,btrim(p_input->>'reason'),btrim(p_input->>'evidenceRef'),p_input,
      public.extension_contract_state(p_contract_id),coalesce((select version from public.contract_extension_versions where contract_id=p_contract_id),0),submitted)
    returning id into rid;
  return public.retrospective_extension_request_json(rid);
end $$;

create or replace function public.get_retrospective_extension_requests(p_contract_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
begin
  if not exists(select 1 from public.profiles where id=auth.uid() and active=true and role in ('admin','staff')) then
    raise exception 'ไม่มีสิทธิ์อ่านคำขอ' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(public.retrospective_extension_request_json(id) order by recorded_at desc)
    from public.retrospective_extension_requests where contract_id=p_contract_id),'[]'::jsonb);
end $$;

create or replace function public.preview_retrospective_extension(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare cid uuid;
begin
  if not exists(select 1 from public.profiles where id=auth.uid() and active=true and role in ('admin','staff')) then
    raise exception 'ไม่มีสิทธิ์อ่านคำขอ' using errcode='42501'; end if;
  select contract_id into cid from public.retrospective_extension_requests where id=p_request_id;
  perform 1 from public.contracts where id=cid for update;
  return public.retrospective_extension_request_json(p_request_id)->'preview';
end $$;

create or replace function public.approve_retrospective_extension(p_request_id uuid,p_reason text,p_confirm_penalty_adjustment boolean)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  r public.retrospective_extension_requests%rowtype;
  c public.contracts%rowtype;
  actor_name text;
  preview jsonb;
  before_state jsonb;
  eid uuid;
  candidate record;
  new_term int;
begin
  select full_name into actor_name from public.profiles where id=auth.uid() and active=true and role='admin';
  if not found then raise exception 'เฉพาะแอดมินที่ใช้งานอยู่เท่านั้นที่อนุมัติได้' using errcode='42501'; end if;
  if coalesce(length(btrim(p_reason)),0) not between 10 and 2000 then raise exception 'ระบุเหตุผลอนุมัติอย่างน้อย 10 ตัวอักษร'; end if;
  select * into r from public.retrospective_extension_requests where id=p_request_id;
  if not found then raise exception 'ไม่พบคำขอ'; end if;
  perform 1 from public.contracts where id=r.contract_id for update;
  select * into r from public.retrospective_extension_requests where id=p_request_id for update;
  preview:=public.retrospective_extension_request_json(p_request_id)->'preview';
  if not coalesce((preview->>'canApprove')::boolean,false) then
    raise exception '%',preview->'blockedReasons'; end if;
  if coalesce((preview->>'penaltyBefore')::numeric,0)<>coalesce((preview->>'penaltyAfter')::numeric,0)
    and not coalesce(p_confirm_penalty_adjustment,false) then
    raise exception 'ต้องยืนยันผลการปรับค่าปรับที่แสดงก่อนอนุมัติ'; end if;
  select * into strict c from public.contracts where id=r.contract_id;
  before_state:=public.extension_contract_state(r.contract_id);
  for candidate in select (x->>'installmentNo')::int no,(x->>'dueDate')::date due,(x->>'amount')::numeric amount
    from jsonb_array_elements(r.input->'schedule')x order by (x->>'installmentNo')::int loop
    update public.installments set due_date=candidate.due,amount=candidate.amount,
      status=case when candidate.due<current_date then 'late' else 'pending' end
      where contract_id=r.contract_id and installment_no=candidate.no and paid_at is null;
    if not found then
      insert into public.installments(contract_id,installment_no,due_date,amount,status)
        values(r.contract_id,candidate.no,candidate.due,candidate.amount,case when candidate.due<current_date then 'late' else 'pending' end);
    end if;
    new_term:=candidate.no;
  end loop;
  update public.installments i set penalty_days=a.penalty_days,penalty_amount=a.penalty_amount
    from(select x.id,p.penalty_days,p.penalty_amount from public.installments x
      cross join lateral public.penalty_accrual_for_installment(x.id)p
      where x.contract_id=r.contract_id and x.paid_at is null and not coalesce(x.penalty_overridden,false))a where i.id=a.id;
  insert into public.contract_extensions(contract_id,ext_type,old_due_day,new_due_day,old_term,new_term,
    old_finance,new_finance,old_monthly,new_monthly,new_installments,note,customer_requested_at,effective_date,
    approval_reason,approved_by,approved_by_name)
    values(r.contract_id,r.input->>'extType',c.due_day,(r.input->>'newDueDay')::int,c.term_months,new_term,
      c.finance_amount,(r.input->>'newFinanceAmount')::numeric,c.monthly_payment,(r.input->>'newMonthlyPayment')::numeric,
      jsonb_array_length(r.input->'schedule'),r.reason||E'\nหลักฐาน: '||r.evidence_ref,r.customer_requested_at,r.effective_date,
      btrim(p_reason),auth.uid(),actor_name) returning id into eid;
  update public.contracts set due_day=(r.input->>'newDueDay')::int,term_months=new_term,
    finance_amount=(r.input->>'newFinanceAmount')::numeric,monthly_payment=(r.input->>'newMonthlyPayment')::numeric where id=r.contract_id;
  insert into public.contract_extension_snapshots(extension_id,contract_id,before_state,after_state,after_version)
    select eid,r.contract_id,before_state,public.extension_contract_state(r.contract_id),version
      from public.contract_extension_versions where contract_id=r.contract_id;
  update public.retrospective_extension_requests set status='approved',approval_reason=btrim(p_reason),
    penalty_adjustment_confirmed=coalesce(p_confirm_penalty_adjustment,false),
    approved_at=clock_timestamp(),approved_by=auth.uid(),approved_by_name=actor_name,extension_id=eid,approved_preview=preview where id=r.id;
end $$;

create or replace function public.reject_retrospective_extension(p_request_id uuid,p_reason text)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare actor_name text;
begin
  select full_name into actor_name from public.profiles where id=auth.uid() and active=true and role='admin';
  if not found then raise exception 'เฉพาะแอดมินที่ใช้งานอยู่เท่านั้นที่ตัดสินคำขอได้' using errcode='42501'; end if;
  if coalesce(length(btrim(p_reason)),0) not between 10 and 2000 then raise exception 'ระบุเหตุผลอย่างน้อย 10 ตัวอักษร'; end if;
  update public.retrospective_extension_requests set status='rejected',approval_reason=btrim(p_reason),
    approved_at=clock_timestamp(),approved_by=auth.uid(),approved_by_name=actor_name where id=p_request_id and status='pending';
  if not found then raise exception 'คำขอนี้ไม่ได้รออนุมัติแล้ว'; end if;
end $$;

revoke all on function public.retrospective_penalty(uuid,date),public.plan_retrospective_extension(uuid,jsonb),
  public.retrospective_extension_request_json(uuid) from public,anon,authenticated,service_role;
revoke all on function public.create_retrospective_extension_request(uuid,jsonb),public.get_retrospective_extension_requests(uuid),
  public.preview_retrospective_extension(uuid),public.approve_retrospective_extension(uuid,text,boolean),public.reject_retrospective_extension(uuid,text) from public,anon,service_role;
grant execute on function public.create_retrospective_extension_request(uuid,jsonb),public.get_retrospective_extension_requests(uuid),
  public.preview_retrospective_extension(uuid),public.approve_retrospective_extension(uuid,text,boolean),public.reject_retrospective_extension(uuid,text) to authenticated;
