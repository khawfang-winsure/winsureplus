-- 0173: evaluate retrospective balances at the effective date and refresh reviews against current data
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
  post_effective_paid numeric:=0;
  historical_remaining_after numeric:=0;
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
  -- Compare evidence with the historical outstanding as of the effective date:
  -- current outstanding plus net principal receipts posted after that date.
  select coalesce(sum(i.paid_amount-coalesce((
    select p.paid_amount_after from public.payment_log p
    where p.installment_id=i.id
      and (p.created_at at time zone 'Asia/Bangkok')::date<=effective
      and (p.action='cancel' or p.amount<>0)
    order by p.created_at desc,p.id desc limit 1
  ),0)),0) into post_effective_paid
  from public.installments i where i.contract_id=p_contract_id;
  historical_remaining_after:=remaining_after+post_effective_paid;
  if exists(select 1 from public.installments i where i.contract_id=p_contract_id
    and i.paid_amount is distinct from coalesce((
      select p.paid_amount_after from public.payment_log p
      where p.installment_id=i.id order by p.created_at desc,p.id desc limit 1
    ),0)) then
    reasons:=array_append(reasons,'ยอดรับชำระกับประวัติเงินรับรวมไม่ตรง ต้องกระทบยอดก่อนอนุมัติ');
  end if;
  if historical_remaining_after<>evidence then
    reasons:=array_append(reasons,'ยอดคงเหลือตามตาราง ณ วันที่มีผลต่างจากหลักฐาน '||(historical_remaining_after-evidence)||' บาท ต้องตรวจให้ตรงก่อน');
  end if;
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
    'remainingBefore',remaining_before,'remainingAfter',remaining_after,'historicalRemainingAfter',historical_remaining_after,'netPaidAfterEffectiveDate',post_effective_paid,'evidenceRemaining',evidence,
    'difference',historical_remaining_after-evidence,'penaltyBefore',penalty_before,'penaltyAfter',penalty_after,'partialPaid',partial);
end $$;


create or replace function public.retrospective_extension_request_json(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare r public.retrospective_extension_requests%rowtype; preview jsonb; blocked text[]:=array[]::text[]; state_changed boolean:=false;
begin
  select * into r from public.retrospective_extension_requests where id=p_request_id;
  if not found then raise exception 'ไม่พบคำขอ'; end if;
  if r.status='pending' then
    state_changed:=coalesce((select version from public.contract_extension_versions where contract_id=r.contract_id),0)<>r.before_version
      or public.extension_guard_state(public.extension_contract_state(r.contract_id)) is distinct from public.extension_guard_state(r.before_state);
    preview:=public.plan_retrospective_extension(r.contract_id,r.input);
    if state_changed then
      preview:=preview||jsonb_build_object('dataChangedSinceSubmission',true);
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
