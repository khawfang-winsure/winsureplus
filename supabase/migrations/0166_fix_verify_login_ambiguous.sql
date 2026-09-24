-- 0166: แก้บั๊ก verify_shop_credit_login คอลัมน์กำกวม (42702) ที่เจอจาก live E2E ของร้านจริง
--
-- บั๊ก: RETURNS TABLE (shop_id uuid, shop_name text, ok boolean) ทำให้ "shop_id" กลายเป็นชื่อตัวแปร
-- OUT parameter ที่มองเห็นได้ทั้งฟังก์ชัน — ใน SECTION 5 ของ 0164 มี query นับ PIN ผิดติดกัน (lockout)
-- ที่เขียน `where shop_id = v_shop_id` (ไม่ qualify ตารางที่มาของคอลัมน์) ทำให้ Postgres งงว่า "shop_id"
-- ฝั่งซ้ายของ `=` หมายถึงคอลัมน์ credit_check_rate_log.shop_id หรือตัวแปร OUT param shop_id ของฟังก์ชันเอง
-- → error 42702 "column reference shop_id is ambiguous" ทุกครั้งที่ login_code มีอยู่จริงในระบบ (โค้ดเดิน
-- มาถึง query นี้) — ตอน smoke test ก่อน apply 0164 ทดสอบด้วย login_code ปลอม (ไม่มีจริง) เท่านั้น จึง
-- ตกไป branch `v_shop_id is null` (ไม่แตะ query ที่พังเลย) ทำให้เทสผ่านหมดทั้งที่ของจริงพังกับร้านที่มีจริง
--
-- แก้: alias ตาราง credit_check_rate_log เป็น `l` แล้ว qualify ทุกคอลัมน์ในนั้น (l.shop_id, l.ip_hash,
-- l.success, l.created_at) — เหลือแค่จุดเดียวที่เคยกำกวมจริง ส่วน INSERT ... (shop_id, ip_hash, success)
-- VALUES (...) ไม่ต้อง qualify เพราะ column list ของ INSERT เป็น target list ตายตัวอยู่แล้ว (Postgres
-- ตีความเป็นชื่อคอลัมน์ของตารางปลายทางเสมอ ไม่มีทางกำกวมกับตัวแปร PL/pgSQL — มาตรฐาน SQL ไม่ให้ qualify
-- คอลัมน์ใน INSERT target list ด้วยซ้ำ) ฟังก์ชันอื่นทำงานเหมือนเดิม 100% เปลี่ยนแค่จุดนี้จุดเดียว
--
-- ทำไมตอนรีวิว 0164 (ติ๊กรีวิว 2 รอบ) ไม่จับ: โฟกัสตอนนั้นอยู่ที่ pgcrypto schema + revoke from public +
-- lockout key (shop_id, ip_hash) คู่กัน — ไม่มีใคร trace ผ่าน "login code ที่มีอยู่จริง" ในสมองเทียบกับ
-- ambiguous column resolution ของ Postgres ตรงๆ จนกว่าจะรันจริงกับร้านที่ setup PIN ไว้แล้ว
--
-- ============================================================================
-- ผลสำรวจฟังก์ชัน RETURNS TABLE อื่นๆ ทั้งหมดใน 0164 (ตามที่ขอให้ sweep) — ตรวจแล้วไม่มีจุดกำกวมจริง
-- ไม่ต้องแก้ (ไม่ CREATE OR REPLACE ในไฟล์นี้ กันสร้าง diff/ความเสี่ยงเปล่าๆ กับฟังก์ชันที่ไม่ได้พัง):
--
-- 1) admin_set_shop_credit_pin(uuid) RETURNS TABLE (login_code text, pin text) — SECTION 3
--    ตัวแปร OUT คือ login_code/pin แต่ทุก query ในฟังก์ชันอ้างคอลัมน์คนละชื่อเสมอ:
--      - `where s.credit_login_code = v_login_code` / `where credit_login_code = v_login_code`
--        คอลัมน์จริงชื่อ credit_login_code (ไม่ใช่ login_code เฉยๆ) ไม่ชนกับ OUT param
--      - insert/on conflict ใช้ shop_id, pin_hash, rotated_at, rotated_by — คนละชื่อกับ OUT param ทั้งคู่
--      - `return query select v_login_code, v_pin;` ใช้ตัวแปร local (v_ prefix) ไม่ใช่ชื่อคอลัมน์ตรงๆ
--    สรุป: ไม่มีคอลัมน์ไหนในตารางที่ query ชื่อ "login_code" หรือ "pin" เป๊ะๆ เลย จึงไม่มีทางกำกวม
--
-- 2) purge_expired_credit_checks(int) RETURNS TABLE (credit_check_id uuid, r2_key text) — SECTION 10
--    ตัวแปร OUT คือ credit_check_id/r2_key — จุดเดียวที่แตะชื่อนี้คือ
--      `delete from public.credit_check_files f ... returning f.credit_check_id, f.r2_key;`
--    ซึ่ง qualify ด้วย alias `f.` อยู่แล้วตั้งแต่ 0164 (RETURNING f.col เป็นการ qualify explicit — ไม่มีทาง
--    กำกวมกับตัวแปร PL/pgSQL เพราะตัวแปรไม่มี "prefix.name" ให้เขียนแบบนั้นได้อยู่แล้ว) ไม่ต้องแก้อะไร
--
-- 3) credit_check_rate_limit_ok(uuid, text, int, int, int) — SECTION 4
--    RETURNS boolean เฉยๆ (ไม่ใช่ RETURNS TABLE) จึงไม่มี OUT parameter ให้ชนตั้งแต่ต้น — พารามิเตอร์
--    input ชื่อ p_shop_id/p_ip_hash (มี prefix p_) ต่างจากคอลัมน์จริง shop_id/ip_hash ของ
--    credit_check_rate_log อยู่แล้ว เขียน `where shop_id = p_shop_id` ได้โดยไม่กำกวม (ไม่มีตัวแปรชื่อ
--    "shop_id" เฉยๆ ในสโคปเลย) ไม่ต้องแก้เช่นกัน
--
-- Edge Function supabase/functions/credit-check/index.ts: ตรวจ RPC call ทั้ง 2 จุดที่เรียก
-- verify_shop_credit_login({p_login_code, p_pin, p_ip_hash}) และอ่านผล (result.shop_id/shop_name/ok)
-- แล้ว — ไม่เปลี่ยน signature/ชื่อคอลัมน์ผลลัพธ์เลย ไฟล์นั้นไม่ต้องแก้/deploy ซ้ำ
-- ============================================================================

create or replace function public.verify_shop_credit_login(
  p_login_code text,
  p_pin        text,
  p_ip_hash    text default null
)
returns table (shop_id uuid, shop_name text, ok boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_shop_id    uuid;
  v_shop_name  text;
  v_hash       text;
  v_active     boolean;
  v_enabled    boolean;
  v_fail_count int;
begin
  select s.id, s.name, s.active, s.credit_check_enabled, p.pin_hash
    into v_shop_id, v_shop_name, v_active, v_enabled, v_hash
  from public.shops s
  join public.shop_credit_pin p on p.shop_id = s.id
  where s.credit_login_code = p_login_code;

  -- lockout: PIN ผิดติดกัน >=5 ครั้งใน 15 นาทีที่ผ่านมา คีย์ด้วย (shop_id, ip_hash) คู่กัน — จุดที่เคย
  -- กำกวม (42702) แก้ด้วยการ alias ตาราง credit_check_rate_log เป็น `l` แล้ว qualify ทุกคอลัมน์ (0166)
  if v_shop_id is not null then
    select count(*) into v_fail_count
    from public.credit_check_rate_log l
    where l.shop_id = v_shop_id
      and l.ip_hash = p_ip_hash
      and l.success = false
      and l.created_at >= now() - interval '15 minutes';

    if v_fail_count >= 5 then
      insert into public.credit_check_rate_log (shop_id, ip_hash, success)
        values (v_shop_id, p_ip_hash, false);
      return query select null::uuid, null::text, false;
      return;
    end if;
  end if;

  if v_shop_id is null or v_active is not true or v_enabled is not true then
    if v_shop_id is not null then
      insert into public.credit_check_rate_log (shop_id, ip_hash, success)
        values (v_shop_id, p_ip_hash, false);
    end if;
    return query select null::uuid, null::text, false;
    return;
  end if;

  if v_hash is null or extensions.crypt(p_pin, v_hash) <> v_hash then
    insert into public.credit_check_rate_log (shop_id, ip_hash, success)
      values (v_shop_id, p_ip_hash, false);
    return query select null::uuid, null::text, false;
    return;
  end if;

  insert into public.credit_check_rate_log (shop_id, ip_hash, success)
    values (v_shop_id, p_ip_hash, true);
  return query select v_shop_id, v_shop_name, true;
end;
$$;

comment on function public.verify_shop_credit_login(text, text, text) is
  '(0164, แก้ 0166) ตรวจ login code + PIN ของร้าน สำหรับ Edge Function credit-check เท่านั้น (service_role)
   — เช็ค active + credit_check_enabled ด้วย ไม่ใช่แค่ PIN ตรง. lockout อัตโนมัติถ้า PIN ผิด >=5 ครั้งใน
   15 นาที คีย์ด้วย (shop_id, ip_hash) คู่กัน (นับจาก credit_check_rate_log.success=false) เป็น sliding
   window — IP อื่นของร้านเดียวกันไม่โดนล็อกไปด้วย ต้องพึ่ง p_ip_hash ที่ Edge Function ส่งมาให้ถูกต้องเสมอ
   (0166) แก้บั๊ก 42702 column reference "shop_id" is ambiguous — alias ตาราง credit_check_rate_log เป็น
   l แล้ว qualify ทุกคอลัมน์ในนั้น เพราะ RETURNS TABLE (shop_id, ...) ทำให้ shop_id ชนกับ OUT parameter';

-- คง grant/revoke เดิมจาก 0164 ไว้เหมือนเดิม (CREATE OR REPLACE ที่ signature ไม่เปลี่ยนไม่ล้าง ACL อยู่แล้ว
-- แต่ restate ซ้ำไว้เป็น defense-in-depth ตาม house style — เผื่อมีใครเคย manual grant ผิดไว้ก่อนหน้า)
revoke all on function public.verify_shop_credit_login(text, text, text) from public, anon, authenticated;
grant execute on function public.verify_shop_credit_login(text, text, text) to service_role;

-- ============================================================================
-- Verify checklist สำหรับครีม (รันหลัง apply — ไม่ได้รันอัตโนมัติในไฟล์นี้)
-- ============================================================================

-- 1) เรียกด้วย login_code จริงที่มี PIN ตั้งไว้แล้ว (เช่น จ่าอั๋นโฟน สาขา 4/2) ต้องไม่เจอ 42702 อีก:
-- SELECT * FROM verify_shop_credit_login('<login_code จริง>', '<pin ผิดตั้งใจ>', 'smoke-test-ip');
-- expected: ไม่ error, คืนแถว (shop_id=null, shop_name=null, ok=false) เหมือนกรณี PIN ผิดปกติ

-- 2) PIN ถูกต้อง ต้องคืน ok=true พร้อม shop_id/shop_name จริง:
-- SELECT * FROM verify_shop_credit_login('<login_code จริง>', '<pin ถูกจริง>', 'smoke-test-ip');

-- 3) lockout ยังทำงานเหมือนเดิม (คีย์คู่ shop_id+ip_hash, >=5 ครั้งผิดใน 15 นาที) — ทำซ้ำ 5 ครั้งด้วย PIN ผิด
-- แล้วลองครั้งที่ 6 ด้วย PIN ถูก ต้องยัง ok=false (ล็อกอยู่) จาก ip เดิม แต่ ip อื่นไม่โดนล็อกไปด้วย:
-- (ดู checklist เต็มที่ 0164 SECTION 11i — พฤติกรรมต้องเหมือนเดิมทุกอย่าง มีแค่ query ไม่ error เพิ่มมา)

-- 4) grant ยังถูกต้อง (ไม่มี regression จาก CREATE OR REPLACE):
-- SELECT has_function_privilege('anon', 'public.verify_shop_credit_login(text,text,text)', 'EXECUTE'); -- expected: false
-- SELECT has_function_privilege('authenticated', 'public.verify_shop_credit_login(text,text,text)', 'EXECUTE'); -- expected: false
-- SELECT has_function_privilege('public', 'public.verify_shop_credit_login(text,text,text)', 'EXECUTE'); -- expected: false
-- SELECT has_function_privilege('service_role', 'public.verify_shop_credit_login(text,text,text)', 'EXECUTE'); -- expected: true
