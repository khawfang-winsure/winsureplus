-- 0037: สร้างตารางโน้ตส่วนตัวต่อสัญญา (แต่ละพนักงานเห็นเฉพาะของตัวเอง, admin เห็นทั้งหมด)

create table if not exists public.contract_private_notes (
  id          uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  content     text not null check (char_length(content) <= 2000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (contract_id, user_id)  -- 1 user 1 note ต่อ contract (upsert แทน insert ใหม่)
);

create index if not exists contract_private_notes_contract_idx
  on public.contract_private_notes(contract_id);

alter table public.contract_private_notes enable row level security;

-- SELECT: เจ้าของโน้ต + admin
drop policy if exists contract_private_notes_read on public.contract_private_notes;
create policy contract_private_notes_read on public.contract_private_notes
  for select to authenticated
  using (
    user_id = auth.uid()
    or is_admin()
  );

-- INSERT: ตัวเอง (user_id ต้องตรงกับ auth.uid())
drop policy if exists contract_private_notes_insert on public.contract_private_notes;
create policy contract_private_notes_insert on public.contract_private_notes
  for insert to authenticated
  with check (user_id = auth.uid());

-- UPDATE: ตัวเอง
drop policy if exists contract_private_notes_update on public.contract_private_notes;
create policy contract_private_notes_update on public.contract_private_notes
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- DELETE: ตัวเอง + admin
drop policy if exists contract_private_notes_delete on public.contract_private_notes;
create policy contract_private_notes_delete on public.contract_private_notes
  for delete to authenticated
  using (user_id = auth.uid() or is_admin());

grant select, insert, update, delete on public.contract_private_notes to authenticated;
grant select, insert, update, delete on public.contract_private_notes to service_role;
