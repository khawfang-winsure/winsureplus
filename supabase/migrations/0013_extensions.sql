-- ============================================================================
-- 0013 — ขยายระยะเวลา (restructure): เปลี่ยนวันชำระ / ขยายเดือน / ทั้งคู่
-- วิธีใช้: ก๊อปไฟล์นี้ทั้งหมด ไปวางใน Supabase Dashboard > SQL Editor > Run
-- รันซ้ำได้ปลอดภัย (idempotent)
--
-- หลักการ (ยืนยันกับ Pete):
--   - พนักงานกรอก "ยอดจัดไฟแนนซ์ใหม่" + "จำนวนงวดที่จะผ่อนใหม่" เอง → ค่างวด = ยอด/งวด
--   - งวดที่ยังไม่จ่าย (paid_at ว่าง) ถูกลบทิ้ง แล้วยุบรวมยอดเข้ายอดจัดไฟแนนซ์ใหม่ (ไม่ยกค่าปรับเดิมมา)
--   - งวดที่จ่ายแล้วเก็บไว้ → งวดใหม่นับต่อจากเลขงวดที่จ่ายล่าสุด (สมมติจ่ายเรียงงวด)
--   - งวดใหม่งวดแรกครบกำหนด "เดือนถัดจากวันที่ทำรายการ" (เหมือนตอนสร้างสัญญา) + clamp ปลายเดือน
--   - ทำเป็น RPC เดียว = atomic (สำเร็จทั้งหมดหรือไม่สำเร็จเลย) + เก็บ snapshot เก่า→ใหม่ไว้ดูประวัติ
-- ============================================================================

-- ---------- 0) แก้ FK ของ payment_log ให้ "เก็บประวัติไว้แม้งวดถูกลบ" ----------
-- เดิม (0011) installment_id เป็น on delete cascade → ตอนขยายระยะเวลาเราลบงวดที่ยังไม่จ่าย
-- ทิ้ง ทำให้ประวัติการชำระ (จ่ายบางส่วน/ยกเลิก) หายตามไปด้วย. เปลี่ยนเป็น set null = เก็บ log ไว้
alter table public.payment_log alter column installment_id drop not null;
alter table public.payment_log drop constraint if exists payment_log_installment_id_fkey;
alter table public.payment_log
  add constraint payment_log_installment_id_fkey
  foreign key (installment_id) references public.installments (id) on delete set null;

-- ---------- 1) ตารางประวัติการขยายระยะเวลา ----------
create table if not exists public.contract_extensions (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts (id) on delete cascade,
  ext_type text not null check (ext_type in ('due_day', 'months', 'both')),
  old_due_day int,
  new_due_day int,
  old_term int,
  new_term int,
  old_finance numeric,
  new_finance numeric,
  old_monthly numeric,
  new_monthly numeric,
  new_installments int,        -- จำนวนงวดใหม่ที่สร้าง
  note text,
  recorded_by uuid references public.profiles (id),
  recorded_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists contract_extensions_contract_idx on public.contract_extensions (contract_id);
create index if not exists contract_extensions_created_idx on public.contract_extensions (created_at desc);

-- ---------- 2) ประทับตรา "ใครทำรายการ" อัตโนมัติ (ปลอมไม่ได้) ----------
create or replace function public.set_extension_recorder()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.recorded_by is null then
    new.recorded_by := auth.uid();
  end if;
  if new.recorded_by_name is null then
    new.recorded_by_name := (
      select coalesce(nullif(p.full_name, ''), u.email, '')
      from auth.users u
      left join public.profiles p on p.id = u.id
      where u.id = new.recorded_by
    );
  end if;
  return new;
end;
$$;
drop trigger if exists contract_extensions_set_recorder on public.contract_extensions;
create trigger contract_extensions_set_recorder
  before insert on public.contract_extensions
  for each row execute function public.set_extension_recorder();

-- ---------- 3) RPC: ขยายระยะเวลา (atomic) ----------
create or replace function public.restructure_contract(
  p_contract_id uuid,
  p_ext_type text,
  p_new_due_day int,
  p_new_term int,            -- จำนวนงวดที่จะผ่อนใหม่ (งวดที่เหลือ)
  p_new_finance numeric,
  p_note text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_c           contracts%rowtype;
  v_last_paid   int;
  v_monthly     numeric;
  v_base        date;
  v_due         date;
  i             int;
begin
  -- ตรวจอินพุต
  if p_ext_type not in ('due_day', 'months', 'both') then
    raise exception 'ประเภทการขยายไม่ถูกต้อง';
  end if;
  if p_new_due_day is null or p_new_due_day < 1 or p_new_due_day > 31 then
    raise exception 'วันที่ชำระต้องอยู่ระหว่าง 1–31';
  end if;
  if p_new_term is null or p_new_term <= 0 then
    raise exception 'จำนวนงวดต้องมากกว่า 0';
  end if;
  if p_new_finance is null or p_new_finance < 0 then
    raise exception 'ยอดจัดไฟแนนซ์ไม่ถูกต้อง';
  end if;

  select * into v_c from contracts where id = p_contract_id for update;
  if not found then raise exception 'ไม่พบสัญญานี้'; end if;

  -- เลขงวดที่จ่ายล่าสุด (สมมติจ่ายเรียงงวด) — ถ้าไม่เคยจ่าย = 0
  select coalesce(max(installment_no), 0) into v_last_paid
    from installments where contract_id = p_contract_id and paid_at is not null;

  v_monthly := round(p_new_finance / p_new_term);

  -- ลบงวดที่ยังไม่จ่ายทั้งหมด (ยุบรวมเข้ายอดใหม่แล้ว)
  delete from installments where contract_id = p_contract_id and paid_at is null;

  -- สร้างงวดใหม่: งวด i ครบกำหนดเดือน (เดือนปัจจุบัน + i) → งวดแรก = เดือนหน้า
  for i in 1..p_new_term loop
    v_base := (date_trunc('month', current_date) + make_interval(months => i))::date;
    v_due  := due_date_for(
      extract(year from v_base)::int,
      extract(month from v_base)::int,
      p_new_due_day
    );
    insert into installments (contract_id, installment_no, due_date, amount, status)
    values (
      p_contract_id,
      v_last_paid + i,
      v_due,
      v_monthly,
      case when v_due < current_date then 'late' else 'pending' end
    );
  end loop;

  -- บันทึกประวัติ (snapshot เก่า → ใหม่) ก่อนทับค่าในสัญญา
  insert into public.contract_extensions (
    contract_id, ext_type,
    old_due_day, new_due_day,
    old_term, new_term,
    old_finance, new_finance,
    old_monthly, new_monthly,
    new_installments, note
  ) values (
    p_contract_id, p_ext_type,
    v_c.due_day, p_new_due_day,
    v_c.term_months, v_last_paid + p_new_term,
    v_c.finance_amount, p_new_finance,
    v_c.monthly_payment, v_monthly,
    p_new_term, p_note
  );

  -- อัปเดตสัญญา: วันชำระ/ค่างวด/ยอดจัดไฟแนนซ์/จำนวนงวดรวมใหม่
  update contracts set
    due_day = p_new_due_day,
    monthly_payment = v_monthly,
    finance_amount = p_new_finance,
    term_months = v_last_paid + p_new_term
    where id = p_contract_id;
end;
$$;

grant execute on function public.restructure_contract(uuid, text, int, int, numeric, text) to authenticated;

-- ---------- 4) RLS: อ่านประวัติได้ทุกคนที่ล็อกอิน, เขียนผ่าน RPC เท่านั้น ----------
alter table public.contract_extensions enable row level security;
drop policy if exists contract_extensions_read on public.contract_extensions;
create policy contract_extensions_read on public.contract_extensions for select to authenticated using (true);
grant select on public.contract_extensions to authenticated;
