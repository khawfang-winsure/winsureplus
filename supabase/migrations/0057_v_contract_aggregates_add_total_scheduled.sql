-- 0057: เพิ่ม total_scheduled ใน v_contract_aggregates (Σ amount ทุกงวด เพื่อคำนวณพอร์ต dashboard ถูกต้อง)

-- ADDITIVE only — คง field เดิมทุกตัว เพิ่มเฉพาะ total_scheduled
-- re-grant explicit หลัง create or replace (idempotent ปลอดภัย — create or replace ไม่การันตีว่า grant คงอยู่)

create or replace view public.v_contract_aggregates as
select
  c.id                                                                            as contract_id,
  count(i.id)                                                                     as total_installments,
  count(i.id) filter (where i.paid_at is not null)                               as paid_count,
  count(i.id) filter (where i.paid_at is null and i.due_date < current_date)     as overdue_count,
  coalesce(sum(i.paid_amount)   filter (where i.paid_at is not null), 0)         as total_paid,
  coalesce(sum(greatest(i.amount - coalesce(i.paid_amount, 0), 0))
           filter (where i.paid_at is null), 0)                                  as total_outstanding,
  coalesce(sum(i.penalty_amount) filter (where i.paid_at is null), 0)            as total_penalty,
  max(i.paid_at)                                                                  as last_paid_at,
  min(i.due_date) filter (where i.paid_at is null)                               as next_due_date,
  coalesce(sum(i.amount), 0)                                                      as total_scheduled
from public.contracts c
left join public.installments i on i.contract_id = c.id
group by c.id;

-- re-grant หลัง create or replace (view ใหม่ต้อง grant ซ้ำ — 0017 default privileges ไม่ครอบ views)
grant select on public.v_contract_aggregates to authenticated, service_role;

-- verify: sum(total_scheduled) ต้องตรงกับ sum(amount) from installments
-- select sum(total_scheduled) from v_contract_aggregates;
-- select sum(amount)          from installments;
