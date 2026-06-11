-- 0017: Grant explicit privileges to service_role on public schema
-- เหตุผล: Supabase migrate จาก legacy service_role JWT (implicit BYPASS RLS)
-- มาเป็น sb_secret_xxx keys ที่ต้อง explicit Postgres GRANT
-- ไม่ทำอันนี้ → Edge Function ที่ใช้ SUPABASE_SERVICE_ROLE_KEY จะเจอ 42501 "permission denied"
-- ปลอดภัย: GRANT เพิ่มเฉพาะกับ service_role role (ใช้ใน Edge Function เท่านั้น)
--          ไม่กระทบ RLS policies ของ authenticated/anon

grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ตารางใหม่/sequence ใหม่ในอนาคต ให้ inherit เลย
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to service_role;
