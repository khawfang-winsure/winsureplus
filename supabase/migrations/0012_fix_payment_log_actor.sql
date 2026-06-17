-- ============================================================================
-- 0012 — แก้บั๊ก payment_log: คอลัมน์ "by" เป็นคำสงวน (reserved word) ใน SQL
-- อาการ: กดรับชำระแล้ว error 42703 'record "new" has no field "by"'
-- ทางแก้: เปลี่ยนชื่อคอลัมน์ by -> acted_by แล้วสร้าง trigger function ใหม่
-- วิธีใช้: ก๊อปไฟล์นี้ทั้งหมด ไปวางใน Supabase Dashboard > SQL Editor > Run
-- รันซ้ำได้ปลอดภัย (idempotent)
-- ============================================================================

-- 1) เปลี่ยนชื่อคอลัมน์ (เฉพาะถ้ายังชื่อ "by" อยู่ — ต้องครอบ quote เพราะเป็นคำสงวน)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payment_log' and column_name = 'by'
  ) then
    alter table public.payment_log rename column "by" to acted_by;
  end if;
end $$;

-- 2) สร้าง trigger function ใหม่ให้ใช้ acted_by (trigger เดิมผูกกับ function นี้อยู่แล้ว ไม่ต้องสร้าง trigger ใหม่)
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
