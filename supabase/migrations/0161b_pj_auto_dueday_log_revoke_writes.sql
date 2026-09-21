-- 0161b: ต่อจาก 0161 — default privileges ให้ authenticated INSERT ได้ (RLS กันอยู่แล้วแต่ปิดอีกชั้น)
-- apply ผ่าน MCP 21 ก.ย. 2026 โดยครีม
-- verify: has_table_privilege('authenticated','public.pj_auto_dueday_log','INSERT') = false, SELECT = true

revoke insert, update, delete, truncate, references, trigger on public.pj_auto_dueday_log from authenticated, anon;
revoke all on public.pj_auto_dueday_log from anon;
