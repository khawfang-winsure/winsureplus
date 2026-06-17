-- ============================================================================
-- 0011 — ยืนยัน / แก้ไข / ยกเลิกการชำระ + บันทึกประวัติ (audit log)
-- วิธีใช้: ก๊อปไฟล์นี้ทั้งหมด ไปวางใน Supabase Dashboard > SQL Editor > Run
-- รันซ้ำได้ปลอดภัย (idempotent)
--
-- หลักการ:
--   - paid_amount = ยอดที่ "ชำระสะสม" ของงวดนั้น (จ่ายหลายครั้งบวกกันได้)
--   - paid_at จะถูกตั้งก็ต่อเมื่อจ่ายครบ (paid_amount >= amount) เท่านั้น
--       → จ่ายบางส่วน = งวดยังเปิด ยังนับเป็นค้างใน v_contract_status (view ดู paid_at is null)
--   - payment_log = บันทึกทุกการกระทำ (จ่าย/แก้ไข/ยกเลิก) พร้อม "ใครทำ" (auth.uid ปลอมไม่ได้)
-- ============================================================================

-- ---------- 1) คอลัมน์เพิ่มในตารางงวด ----------
alter table public.installments
  add column if not exists paid_amount numeric not null default 0,
  add column if not exists paid_by uuid references public.profiles (id),
  add column if not exists paid_by_name text;

-- งวดเก่าที่ปิดไปแล้ว (paid_at ไม่ null) ให้ถือว่าจ่ายเต็มจำนวน เพื่อให้ยอดสะสมตรงกัน
update public.installments
  set paid_amount = amount
  where paid_at is not null and paid_amount = 0;

-- ---------- 2) ตารางประวัติการชำระ ----------
create table if not exists public.payment_log (
  id uuid primary key default gen_random_uuid(),
  -- set null (ไม่ cascade) เพื่อเก็บประวัติไว้แม้งวดถูกลบตอนขยายระยะเวลา (Feature B)
  installment_id uuid references public.installments (id) on delete set null,
  contract_id uuid not null references public.contracts (id) on delete cascade,
  action text not null check (action in ('pay', 'edit', 'cancel')),
  amount numeric not null default 0,            -- pay=ยอดที่จ่ายครั้งนี้, edit=ยอดสะสมใหม่, cancel=0
  paid_amount_after numeric not null default 0, -- ยอดสะสมหลังทำรายการ (ไว้ตรวจย้อนหลัง)
  note text,
  acted_by uuid references public.profiles (id),
  by_name text,
  created_at timestamptz not null default now()
);
create index if not exists payment_log_installment_idx on public.payment_log (installment_id);
create index if not exists payment_log_contract_idx on public.payment_log (contract_id);

-- ---------- 3) ประทับตรา "ใครทำรายการ" อัตโนมัติ (ปลอมไม่ได้) ----------
create or replace function public.set_payment_log_actor()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.acted_by is null then
    new.acted_by := auth.uid();
  end if;
  if new.by_name is null then
    new.by_name := (
      select coalesce(nullif(p.full_name, ''), u.email, '')
      from auth.users u
      left join public.profiles p on p.id = u.id
      where u.id = new.acted_by
    );
  end if;
  return new;
end;
$$;
drop trigger if exists payment_log_set_actor on public.payment_log;
create trigger payment_log_set_actor
  before insert on public.payment_log
  for each row execute function public.set_payment_log_actor();

-- ---------- 4) RPC: บันทึกชำระ (เพิ่มยอดสะสม — จ่ายบางส่วนได้) ----------
create or replace function public.record_payment(
  p_installment_id uuid,
  p_amount numeric,
  p_note text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_inst installments%rowtype;
  v_new  numeric;
  v_uid  uuid := auth.uid();
  v_name text;
begin
  select * into v_inst from installments where id = p_installment_id for update;
  if not found then raise exception 'ไม่พบงวดนี้'; end if;

  v_new := coalesce(v_inst.paid_amount, 0) + coalesce(p_amount, 0);
  select coalesce(nullif(p.full_name, ''), u.email, '') into v_name
    from auth.users u left join profiles p on p.id = u.id where u.id = v_uid;

  if v_new >= v_inst.amount and v_inst.amount > 0 then
    -- จ่ายครบ → ปิดงวด
    update installments set
      paid_amount = v_new,
      paid_at = coalesce(paid_at, now()),
      status = 'paid',
      paid_by = v_uid,
      paid_by_name = v_name
      where id = p_installment_id;
  else
    -- จ่ายบางส่วน → งวดยังเปิด
    update installments set
      paid_amount = v_new,
      paid_at = null,
      status = case when due_date < current_date then 'late' else 'pending' end,
      paid_by = null,
      paid_by_name = null
      where id = p_installment_id;
  end if;

  insert into payment_log (installment_id, contract_id, action, amount, paid_amount_after, note)
    values (p_installment_id, v_inst.contract_id, 'pay', coalesce(p_amount, 0), v_new, p_note);
end;
$$;

-- ---------- 5) RPC: แก้ไขยอดสะสม (ตั้งค่าใหม่ทั้งก้อน — กรณีกรอกผิด) ----------
create or replace function public.adjust_payment(
  p_installment_id uuid,
  p_new_total numeric,
  p_note text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_inst installments%rowtype;
  v_total numeric;
  v_uid  uuid := auth.uid();
  v_name text;
begin
  select * into v_inst from installments where id = p_installment_id for update;
  if not found then raise exception 'ไม่พบงวดนี้'; end if;

  v_total := greatest(coalesce(p_new_total, 0), 0);
  select coalesce(nullif(p.full_name, ''), u.email, '') into v_name
    from auth.users u left join profiles p on p.id = u.id where u.id = v_uid;

  if v_total >= v_inst.amount and v_inst.amount > 0 then
    update installments set
      paid_amount = v_total,
      paid_at = coalesce(paid_at, now()),
      status = 'paid',
      paid_by = v_uid,
      paid_by_name = v_name
      where id = p_installment_id;
  else
    update installments set
      paid_amount = v_total,
      paid_at = null,
      status = case when due_date < current_date then 'late' else 'pending' end,
      paid_by = null,
      paid_by_name = null
      where id = p_installment_id;
  end if;

  insert into payment_log (installment_id, contract_id, action, amount, paid_amount_after, note)
    values (p_installment_id, v_inst.contract_id, 'edit', v_total, v_total, p_note);
end;
$$;

-- ---------- 6) RPC: ยกเลิกการชำระทั้งงวด (คืนเป็นค้างชำระ) ----------
create or replace function public.cancel_payment(
  p_installment_id uuid,
  p_note text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_inst installments%rowtype;
begin
  select * into v_inst from installments where id = p_installment_id for update;
  if not found then raise exception 'ไม่พบงวดนี้'; end if;

  update installments set
    paid_amount = 0,
    paid_at = null,
    status = case when due_date < current_date then 'late' else 'pending' end,
    paid_by = null,
    paid_by_name = null
    where id = p_installment_id;

  insert into payment_log (installment_id, contract_id, action, amount, paid_amount_after, note)
    values (p_installment_id, v_inst.contract_id, 'cancel', 0, 0, p_note);
end;
$$;

grant execute on function public.record_payment(uuid, numeric, text) to authenticated;
grant execute on function public.adjust_payment(uuid, numeric, text) to authenticated;
grant execute on function public.cancel_payment(uuid, text) to authenticated;

-- ---------- 7) RLS: อ่าน audit log ได้ทุกคนที่ล็อกอิน, เขียนผ่าน RPC เท่านั้น ----------
alter table public.payment_log enable row level security;
drop policy if exists payment_log_read on public.payment_log;
create policy payment_log_read on public.payment_log for select to authenticated using (true);
grant select on public.payment_log to authenticated;
