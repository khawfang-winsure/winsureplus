-- 0036: สร้างตารางประวัติการแก้ค่าปรับ (audit trail ว่าใครแก้ เมื่อไหร่ เหตุผลอะไร)

create table if not exists public.penalty_override_history (
  id              uuid primary key default gen_random_uuid(),
  installment_id  uuid not null references public.installments(id) on delete cascade,
  contract_id     uuid not null references public.contracts(id) on delete cascade,
  old_amount      numeric(12,2),
  new_amount      numeric(12,2) not null,
  reason          text,
  by_name         text,
  created_at      timestamptz not null default now()
);

create index if not exists penalty_override_history_contract_idx
  on public.penalty_override_history(contract_id, created_at desc);

alter table public.penalty_override_history enable row level security;

-- admin + staff อ่านได้
drop policy if exists penalty_override_history_read on public.penalty_override_history;
create policy penalty_override_history_read on public.penalty_override_history
  for select to authenticated
  using (
    is_admin()
    or (select role from public.profiles where id = auth.uid()) = 'staff'
  );

-- admin INSERT เท่านั้น (แก้ค่าปรับเป็นสิทธิ์ admin)
drop policy if exists penalty_override_history_insert on public.penalty_override_history;
create policy penalty_override_history_insert on public.penalty_override_history
  for insert to authenticated
  with check (is_admin());

grant select, insert on public.penalty_override_history to authenticated;
grant select, insert, update, delete on public.penalty_override_history to service_role;
