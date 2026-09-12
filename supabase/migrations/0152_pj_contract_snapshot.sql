-- 0152: ตารางแคชข้อมูลสัญญาที่ดึงมาจากเว็บ PJ ไว้เทียบกับค่าที่ทีมเราคีย์เอง (เฟส 2 ของแผงตรวจคุณเตย)
-- ────────────────────────────────────────────────────────────────────────────
-- บริบท: PJ (Laravel เดิม) ไม่มี API — ต้อง scrape หน้าใบสัญญาทีละใบ ดึงตอนพนักงานกด "ส่งให้คุณเตยตรวจ"
-- (fire-and-forget) + ดึงใหม่อัตโนมัติถ้าของเก่าเกิน ~12 ชม. + มีปุ่มดึงใหม่มือในแผงตรวจ (งาน Edge Function
-- + wiring หน้า UI เป็นรอบถัดไป — ไฟล์นี้แค่โครง DB)
--
-- 1 แถวต่อ 1 สัญญา เก็บ "ค่าที่ parse ได้จาก PJ" เท่านั้น ไม่ใช่ค่าของเรา (ค่าของเราอยู่ที่ contracts ตามปกติ)
-- เทียบสองค่านี้เป็นงานของ src/lib/pjCompare.ts (แบมเขียนคู่กันอยู่ ไฟล์นี้ไม่ยุ่งกับมัน)
--
-- ทำไม cache pj_invoice_uuid: การหา invoice_no → uuid ในเว็บ PJ ปัจจุบันต้องไล่ DataTable ~5 หน้า (~2,400
-- แถว) ต่อ 1 สัญญา = แพงมากถ้าทำทุกครั้ง — เก็บ uuid ไว้ในแถวนี้ครั้งแรกที่เจอ ครั้งต่อไป (ดึงใหม่เพราะเกิน
-- 12 ชม. หรือกดปุ่มดึงใหม่) ข้ามขั้นตอนไล่หาได้เลย ยิงตรงที่หน้าใบด้วย uuid ที่มีอยู่
--
-- ตัดสินใจไม่ทำ pj_invoice_uuid_map แยก (ที่พี่ดิวเสนอไว้) รอบนี้ — เหตุผล:
--   1) โจทย์ของตารางนี้คือ "ดึงตามสัญญา" (lookup by contract_id) ซึ่ง cache ในแถวเดียวกันตอบพอแล้ว ไม่ต้อง
--      map กลางแยก
--   2) pj-sync mode returned_watch (0125/0134) ไล่ทั้งลิสต์ทุกรอบด้วยรูปแบบ query คนละแบบ (scrape ลิสต์
--      รวมทีเดียว ไม่ใช่ lookup ทีละ invoice) — ยังไม่เห็นโค้ดจริงของงานนั้นว่าจะใช้ map นี้ยังไง ทำตาราง
--      กลางไปก่อนโดยไม่รู้ shape ที่ต้องใช้จริง เสี่ยงออกแบบผิดแล้วต้อง migration ซ้ำ
--   3) ถ้าอนาคตต้องทำจริง ตารางนี้ (pj_invoice_no, pj_invoice_uuid ที่มีค่าแล้ว) เป็น seed ตั้งต้นให้ map
--      กลางได้ทันทีด้วย `select distinct pj_invoice_no, pj_invoice_uuid from pj_contract_snapshot where
--      pj_invoice_uuid is not null` — ไม่เสียของ ไม่ปิดทางทำต่อ
--   สรุป: ข้ามในรอบนี้ ถ้า pj-sync ต้องการจริงให้เปิด migration ใหม่ตอนนั้นพร้อมเห็น shape ที่ใช้จริง
--
-- Additive — สร้างตารางใหม่ล้วนๆ ไม่แตะตาราง/คอลัมน์เดิมใดๆ

-- ============================================================================
-- ตาราง pj_contract_snapshot
-- ============================================================================

create table if not exists public.pj_contract_snapshot (
  -- 1 สัญญา = 1 แถว: ใช้ contract_id เป็น primary key ตรง (ได้ unique + not null มาในตัว, upsert ทับแถวเดิม
  -- ด้วย on conflict (contract_id) โดย Edge Function ได้เลยไม่ต้องมี id แยก)
  contract_id     uuid primary key references public.contracts (id) on delete cascade,

  status          text not null default 'never_fetched',

  -- cache uuid ของใบใน PJ กันไล่ DataTable ซ้ำ (ดู comment หัวไฟล์) — pj_invoice_no คือเลขที่มองเห็นในเว็บ
  -- PJ (เทียบกับ contracts.contract_no ของเรา), pj_invoice_uuid คือ id ภายในของ Laravel ที่ต้องมีไปเปิด
  -- หน้าใบตรง
  pj_invoice_no   text,
  pj_invoice_uuid text,

  -- ค่าที่ parse ได้จากหน้าใบสัญญาใน PJ — ใช้ชื่อคีย์ตาม interface PJContract ใน src/lib/pjImport.ts:8-41
  -- เป๊ะๆ (ไม่ตั้งคีย์ใหม่เอง) เพื่อให้ PJ 2 ทางในระบบ (import CSV เดิม กับ live-fetch ทางนี้) พูดภาษาเดียวกัน
  -- คีย์ที่คาดว่าจะมี (ทั้งหมดเป็น text ยกเว้น has_promotion เป็น boolean ตาม TS interface):
  --   invoice_no, trade_date, shop_code, shop_name, customer_name, birth_date, national_id, occupation,
  --   phone, phone_alt1, phone_alt2, email, device_brand, device_name, device_color, device_storage,
  --   device_condition, imei, sn, down_payment, monthly_payment, term_months, finance_amount,
  --   first_due_date, addr_card_full, addr_current_full, addr_work_full, contract_no, condition,
  --   promotion, has_promotion, promotion_detail
  -- (ไม่รวม occupation_proof/notes/operator — 3 ตัวนั้นเป็น "v8 merged sheet override columns" ของไฟล์
  -- import เดิม ไม่ใช่ค่าที่มีอยู่บนหน้าใบสัญญา PJ ที่ fetch สดตรงนี้)
  data            jsonb,

  -- รายการรูปที่เจอในหน้าใบ PJ — เก็บแค่ชนิด+path บน S3 ห้ามเก็บ presigned URL (หมดอายุ 5 นาที ใช้ไม่ได้
  -- ตอนแผงตรวจโหลดจริง) ตัวอย่างรูปแบบที่คาด: [{"kind": "id_card", "path": "s3://.../xxx.jpg"}, ...]
  -- ⚠️ ห้ามมีคอลัมน์เก็บไฟล์รูปจริง/สำเนารูปบัตรประชาชนในตารางนี้หรือที่ใดในระบบเรา — คุณเตยเคาะแล้ว
  image_refs      jsonb,

  fetched_at      timestamptz,
  error_reason    text,

  created_at      timestamptz not null default now(),
  -- ไม่มี trigger auto-update (โค้ดเบสนี้ไม่ใช้ pattern trigger สำหรับ updated_at ที่ไหนเลย) — Edge Function
  -- ที่ upsert แถวนี้ต้องตั้ง updated_at = now() เองทุกครั้งที่เขียน
  updated_at      timestamptz not null default now()
);

alter table public.pj_contract_snapshot drop constraint if exists pj_contract_snapshot_status_check;
alter table public.pj_contract_snapshot add constraint pj_contract_snapshot_status_check
  check (status in ('never_fetched', 'fetching', 'ok', 'failed', 'not_found_in_pj'));

comment on table public.pj_contract_snapshot is
  '(0152) แคช 1 แถวต่อ 1 สัญญา ของข้อมูลที่ scrape ได้จากหน้าใบสัญญาในเว็บ PJ — ใช้เทียบกับค่าที่ทีมเราคีย์เองในแผงตรวจของคุณเตย (เฟส 2). ดึง/เขียนได้ทาง service_role (Edge Function) เท่านั้น, อ่านได้เฉพาะแอดมิน (มีเลขบัตร+ที่อยู่ซ้ำจาก PJ เป็นข้อมูลอ่อนไหว)';

comment on column public.pj_contract_snapshot.status is
  'never_fetched = ยังไม่เคยดึง (แถวเริ่มต้น/ยังไม่มีสัญญาไปกด "ส่งให้คุณเตยตรวจ"); fetching = Edge Function กำลังดึงอยู่ (กัน trigger ซ้ำถ้ากดปุ่มดึงใหม่ซ้อน); ok = ดึงสำเร็จ มีข้อมูลใน data แล้ว; failed = ดึงแล้ว error (ดู error_reason) เช่น PJ ล่ม/timeout — ไม่ใช่ว่าไม่มีสัญญานี้ใน PJ; not_found_in_pj = ดึงสำเร็จแต่หาใบสัญญานี้ใน PJ ไม่เจอเลย (คนละความหมายกับ failed)';
comment on column public.pj_contract_snapshot.pj_invoice_no is 'เลขที่ใบมองเห็นในเว็บ PJ (เทียบกับ contracts.contract_no ของเรา) — เก็บไว้โชว์ในแผงตรวจ ไม่ใช่ key ที่ใช้ query';
comment on column public.pj_contract_snapshot.pj_invoice_uuid is 'uuid ภายในของ Laravel ที่ใช้เปิดหน้าใบตรง — cache ไว้กันไล่ DataTable ~5 หน้า/2,400 แถวซ้ำทุกครั้งที่ดึงใหม่ (ดู comment หัวไฟล์)';
comment on column public.pj_contract_snapshot.data is 'ค่าที่ parse ได้จากหน้าใบ PJ — โครงสร้างคีย์ตาม PJContract ใน src/lib/pjImport.ts:8-41 (ดู comment ข้างคอลัมน์ในตาราง)';
comment on column public.pj_contract_snapshot.image_refs is 'รายการรูปที่เจอในหน้าใบ PJ: ชนิด+path บน S3 เท่านั้น ห้ามเก็บ presigned URL (หมดอายุ 5 นาที) และห้ามเก็บไฟล์รูปจริง';
comment on column public.pj_contract_snapshot.fetched_at is 'เวลาที่ดึงสำเร็จ/ล้มเหลวล่าสุด — ใช้เทียบ "เกิน 12 ชม." เพื่อ auto-refetch รอบถัดไป';

create index if not exists pj_contract_snapshot_status_idx on public.pj_contract_snapshot (status);

-- ============================================================================
-- RLS — อ่านได้เฉพาะแอดมิน, เขียนได้ทาง service_role (Edge Function) เท่านั้น
-- ============================================================================

alter table public.pj_contract_snapshot enable row level security;

-- grant select ระดับตารางให้ authenticated ก่อน (จำเป็นคู่กับ RLS policy — grant คุมว่า "เข้าคำสั่งนี้ได้
-- ไหม", policy คุมว่า "เห็นแถวไหน") ไม่ grant insert/update/delete ให้ authenticated เลย เพราะไม่มี path ไหน
-- ในระบบที่ตั้งใจให้ staff/แอดมินเขียนตารางนี้ตรง (เขียนได้ทาง Edge Function ที่ใช้ service_role เท่านั้น)
grant select on public.pj_contract_snapshot to authenticated;

drop policy if exists pj_contract_snapshot_admin_select on public.pj_contract_snapshot;
create policy pj_contract_snapshot_admin_select
  on public.pj_contract_snapshot
  for select to authenticated
  using (is_admin());

-- ไม่มี insert/update/delete policy ให้ authenticated เลย (ตั้งใจ) — staff ที่กด "ส่งให้คุณเตยตรวจ" เรียก
-- Edge Function (ยิงด้วย service_role ฝั่งเซิร์ฟเวอร์) ไม่ได้เขียนตารางนี้ตรงจาก browser

-- ============================================================================
-- กับดัก 0017: service_role ต้องมี GRANT explicit ถึงจะอ่าน/เขียนตารางนี้ได้ (sb_secret ไม่ bypass RLS/GRANT
-- อัตโนมัติเหมือน legacy JWT เดิม)
-- ตรวจแล้ว: 0017 มี `alter default privileges in schema public grant select, insert, update, delete on
-- tables to service_role;` ไว้ล่วงหน้า ครอบตารางใหม่ทุกตัวที่ถูกสร้างในสคีมา public โดยอัตโนมัติ (รวมตาราง
-- นี้ด้วย) — ไม่ต้อง grant เพิ่มเองในไฟล์นี้ (ยืนยันด้วย verify checklist ข้อ (a) ด้านล่าง หลัง apply)
-- ============================================================================

-- ============================================================================
-- Verify checklist สำหรับครีมรันหลัง apply (MCP) — ไม่รันอัตโนมัติในไฟล์นี้
-- ============================================================================

-- a) service_role มีสิทธิ์ครบ 4 verb จาก default privileges ของ 0017 (คาดหวัง: true ทั้ง 4 แถว):
-- select
--   has_table_privilege('service_role', 'public.pj_contract_snapshot', 'SELECT') as can_select,
--   has_table_privilege('service_role', 'public.pj_contract_snapshot', 'INSERT') as can_insert,
--   has_table_privilege('service_role', 'public.pj_contract_snapshot', 'UPDATE') as can_update,
--   has_table_privilege('service_role', 'public.pj_contract_snapshot', 'DELETE') as can_delete;

-- b) RLS เปิดจริง:
-- select relrowsecurity from pg_class where oid = 'public.pj_contract_snapshot'::regclass;
-- expected: true

-- c) authenticated มี select policy เดียว ไม่มี insert/update/delete policy เลย (คาดหวัง: 1 แถว action=SELECT):
-- select cmd from pg_policies where tablename = 'pj_contract_snapshot';
-- expected: 1 row, cmd = 'SELECT'

-- d) negative test — staff (ไม่ใช่แอดมิน) ต้อง select ไม่เห็นเลย (คาดหวัง: 0 แถว แม้มีข้อมูลอยู่จริง):
--   หา id staff จริงก่อน: select id, role, active from public.profiles where role = 'staff' and active limit 1;
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<uuid ของ staff>","role":"authenticated"}';
--     select count(*) from public.pj_contract_snapshot;
--     -- expected: 0 (ไม่ว่าตารางจริงมีกี่แถว)
--   rollback;
--
--   เทียบกับ admin จริง 1 คน (คาดหวัง: เห็นแถวทั้งหมดเท่ากับ count จริงในตาราง):
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<uuid ของ admin>","role":"authenticated"}';
--     select count(*) from public.pj_contract_snapshot;
--   rollback;

-- e) check constraint ครอบค่าที่ใช้จริงครบ (never_fetched/fetching/ok/failed/not_found_in_pj):
-- select pg_get_constraintdef(oid) from pg_constraint where conname = 'pj_contract_snapshot_status_check';
-- ลองใส่ค่านอกลิสต์ต้อง error:
--   insert into public.pj_contract_snapshot (contract_id, status)
--   select id, 'bogus_status' from public.contracts limit 1;
--   -- expected: ERROR new row for relation "pj_contract_snapshot" violates check constraint
