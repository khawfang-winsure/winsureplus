-- Additive quote endpoints. Apply before deploying the frontend that calls them.

-- Only names and available terms reach the staff browser.
create or replace function public.staff_rate_options()
returns jsonb language plpgsql stable security definer
set search_path = '' as $$
declare v_sets jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles
    where id = auth.uid() and active = true and role in ('admin', 'staff')
  ) then raise exception 'Not authorized' using errcode = '42501'; end if;
  select value::jsonb into v_sets from public.app_settings where key = 'installment_rate_sets';
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.item->>'id', 'name', s.item->>'name',
      'terms', (select coalesce(jsonb_agg((t.item->>'term')::int order by (t.item->>'term')::int), '[]'::jsonb)
                from jsonb_array_elements(s.item->'tiers') as t(item))
    )) from jsonb_array_elements(coalesce(v_sets, '[]'::jsonb)) as s(item)
    where coalesce((s.item->>'active')::boolean, false)
  ), '[]'::jsonb);
end $$;

create or replace function public.staff_rate_quote(
  p_principal numeric, p_set_id text, p_term integer
) returns jsonb language plpgsql stable security definer
set search_path = '' as $$
declare v_sets jsonb; v_multiplier numeric; v_finance numeric;
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles
    where id = auth.uid() and active = true and role in ('admin', 'staff')
  ) then raise exception 'Not authorized' using errcode = '42501'; end if;
  if p_principal is null or p_set_id is null or p_term is null
     or p_principal < 0 or p_principal > 10000000 or p_term < 1 or p_term > 120 then
    raise exception 'Invalid quote input' using errcode = '22023';
  end if;
  select value::jsonb into v_sets from public.app_settings where key = 'installment_rate_sets';
  select (tier.item->>'multiplier')::numeric into v_multiplier
    from jsonb_array_elements(coalesce(v_sets, '[]'::jsonb)) as s(item)
    cross join lateral jsonb_array_elements(s.item->'tiers') as tier(item)
    where s.item->>'id' = p_set_id
      and coalesce((s.item->>'active')::boolean, false)
      and (tier.item->>'term')::int = p_term limit 1;
  if v_multiplier is null then raise exception 'Rate unavailable' using errcode = '22023'; end if;
  v_finance := round(p_principal * v_multiplier);
  return jsonb_build_object('financeAmount', v_finance, 'monthlyPayment', round(v_finance / p_term));
end $$;

-- The quote reads the actual contract and installments. The client never sends
-- the confidential discount table or a purported amount to discount.
create or replace function public.staff_settlement_quote(p_contract_id uuid, p_closed_at date)
returns jsonb language plpgsql stable security definer
set search_path = '' as $$
declare
  v_term integer; v_ext_term integer; v_threshold integer; v_row_term integer;
  v_paid_count integer; v_remaining_count integer; v_overdue_count integer;
  v_discountable_count integer; v_remaining numeric; v_overdue numeric;
  v_discountable numeric; v_penalty numeric; v_matrix jsonb; v_percent numeric;
  v_discount numeric; v_matched boolean;
  v_installment record; v_event record; v_penalty_paid numeric;
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles
    where id = auth.uid() and active = true and role in ('admin', 'staff')
  ) then raise exception 'Not authorized' using errcode = '42501'; end if;
  if p_closed_at is null then raise exception 'Closing date required' using errcode = '22023'; end if;
  select term_months into v_term from public.contracts where id = p_contract_id;
  if not found then raise exception 'Contract not found' using errcode = '22023'; end if;
  select new_installments into v_ext_term from public.contract_extensions
    where contract_id = p_contract_id and ext_type <> 'due_day' and new_installments is not null
    order by created_at desc limit 1;
  v_row_term := coalesce(v_ext_term, v_term, 0);
  v_threshold := coalesce(v_term, 0) - coalesce(v_ext_term, 0);

  select count(*) filter (where paid_at is not null and
           (v_ext_term is null or installment_no > v_threshold)),
         count(*) filter (where paid_at is null),
         count(*) filter (where paid_at is null and due_date < p_closed_at),
         count(*) filter (where paid_at is null and due_date >= p_closed_at),
         coalesce(sum(greatest(0, amount - paid_amount)) filter (where paid_at is null), 0),
         coalesce(sum(greatest(0, amount - paid_amount)) filter
           (where paid_at is null and due_date < p_closed_at), 0),
         coalesce(sum(greatest(0, amount - paid_amount)) filter
           (where paid_at is null and due_date >= p_closed_at), 0)
    into v_paid_count, v_remaining_count, v_overdue_count,
         v_discountable_count, v_remaining, v_overdue, v_discountable
    from public.installments where contract_id = p_contract_id;

  -- Match penaltyPaidForInstallment/netPenaltyDue in calc.ts: each cancel
  -- resets that installment's paid penalty; edits do not affect it. Only
  -- unpaid installments contribute, each clamped at zero before summing.
  v_penalty := 0;
  for v_installment in
    select id, penalty_amount from public.installments
    where contract_id = p_contract_id and paid_at is null
  loop
    v_penalty_paid := 0;
    for v_event in
      select action, penalty_paid_amount from public.payment_log
      where installment_id = v_installment.id
      order by created_at asc, id asc
    loop
      if v_event.action = 'cancel' then
        v_penalty_paid := 0;
      elsif v_event.action = 'pay' then
        v_penalty_paid := v_penalty_paid + coalesce(v_event.penalty_paid_amount, 0);
      end if;
    end loop;
    v_penalty := v_penalty + greatest(0, coalesce(v_installment.penalty_amount, 0) - v_penalty_paid);
  end loop;

  select value::jsonb into v_matrix from public.app_settings where key = 'settlement_matrix';
  v_matrix := coalesce(v_matrix, '{}'::jsonb);
  v_matched := v_matrix ? v_row_term::text;
  v_percent := coalesce((v_matrix -> v_row_term::text ->> v_paid_count::text)::numeric, 0);
  v_discount := round(v_discountable * v_percent / 100);
  return jsonb_build_object(
    'remainingPrincipal', v_remaining, 'remainingCount', v_remaining_count,
    'overdueRemaining', v_overdue, 'overdueCount', v_overdue_count,
    'discountableRemaining', v_discountable, 'discountableCount', v_discountable_count,
    'discount', v_discount, 'penaltyDue', v_penalty,
    'customerPays', v_remaining - v_discount + v_penalty,
    'paidCount', v_paid_count, 'rowTerm', v_row_term, 'matched', v_matched
  );
end $$;

revoke all on function public.staff_rate_options() from public, anon;
revoke all on function public.staff_rate_quote(numeric, text, integer) from public, anon;
revoke all on function public.staff_settlement_quote(uuid, date) from public, anon;
grant execute on function public.staff_rate_options() to authenticated;
grant execute on function public.staff_rate_quote(numeric, text, integer) to authenticated;
grant execute on function public.staff_settlement_quote(uuid, date) to authenticated;

-- Preserve the admin sale report without putting its internal commission rate
-- in the browser bundle. The setting can later be edited by an admin.
insert into public.app_settings (key, value, description)
values ('freelancer_commission_rate', '0.05', 'Commission fraction for sold returned devices')
on conflict (key) do nothing;

create or replace function public.admin_sale_freelancer_commissions()
returns table (return_id uuid, amount numeric) language plpgsql stable security definer
set search_path = '' as $$
declare v_rate numeric;
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and active = true
  ) then raise exception 'Not authorized' using errcode = '42501'; end if;
  select value::numeric into v_rate from public.app_settings
    where key = 'freelancer_commission_rate';
  return query select dr.id, round(coalesce(dr.sale_price, 0) * coalesce(v_rate, 0))
    from public.device_returns dr
    where dr.device_status in ('shipped', 'transferred');
end $$;
revoke all on function public.admin_sale_freelancer_commissions() from public, anon;
grant execute on function public.admin_sale_freelancer_commissions() to authenticated;
