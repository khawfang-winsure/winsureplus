-- 0174: คลิปรอบตัวเครื่อง (device_around_video) ส่วนแกน DB — seed setting (ปิดฟีเจอร์), เกท media_gate_complete รู้จัก flag ใหม่, unique 1 คลิป/เคส, purge รวมคลิปใหม่
-- ────────────────────────────────────────────────────────────────────────────
-- ไฟล์นี้ "ยังไม่เพิ่มช่องแนบ" เข้า media_slots (อยู่ใน 0175 แยกตั้งใจ — apply ก่อน push ทันที เพราะแท็บเก่าที่เปิดค้าง
-- จะเห็นช่องใหม่ในทุกเคสตั้งแต่ 2026-09-10 ถ้าเพิ่มช่องก่อนโค้ดใหม่ขึ้น) ไฟล์นี้ apply ก่อนได้ปลอดภัย: ไม่มีช่องใหม่ในรายการ
-- = flag ใหม่ไม่ถูกใช้ + setting ปิดที่ 2099-12-31 → พฤติกรรมทุกเคสเหมือนเดิมทุกอย่าง
--
-- สิ่งที่ทำ:
--   1) seed app_settings: media_around_video_required_from = 2099-12-31 (ปิด), media_video_total_max_mb = 10.5
--   2) media_gate_complete: ก็อปทั้งฟังก์ชันจาก 0154 SECTION 5 (บรรทัด 140-246 — grep ทุก migration แล้ว 0154 คือ
--      นิยามล่าสุด ไม่มีไฟล์หลัง 0154 ที่ create or replace ฟังก์ชันนี้อีก) เพิ่ม flag 'around_video_required'
--      เป็น case ใหม่ ส่วนอื่นเหมือนเดิมทุกตัวอักษร
--   3) unique index contract_media_around_video_unique_live: คลิป device_around_video ที่ยังไม่ลบ/purge ได้ 1 ไฟล์/สัญญา
--      (pattern 0155 SECTION 3 — เช็คซ้ำก่อน ถ้าซ้ำแค่ raise notice ข้าม)
--   4) media_purge_candidates: ก็อปจาก 0155 SECTION 5 (นิยามล่าสุด) เปลี่ยนแค่เงื่อนไข slot_key เป็น
--      in ('lock_test_video','device_around_video') เพื่อให้คลิปใหม่ถูก purge 30 วันเหมือนคลิปเดิม
--
-- กฎ around_video_required (ต้องตรง TS ของแบม + send-company-email เป๊ะ):
--   media_around_video_required_from เป็นวันที่ถูกต้อง AND (contracts.created_at at time zone 'utc')::date >= วันนั้น
--   AND contracts.email_sent_at IS NULL — setting ไม่มี/ว่าง/ผิดรูปแบบ → ไม่บังคับ (ไม่ raise)
--
-- ลำดับ release (ต้องทำตามนี้ ไม่สลับ):
--   1) apply 0174  2) deploy Edge Function ทั้ง 3 ตัว (send-company-email, media-sign, media-purge) แล้วเทียบกับไฟล์ใน repo
--   3) push เว็บ รอ Vercel READY  4) apply 0175  5) hard-reload + smoke test
--   6) เจ้าของตั้ง media_around_video_required_from เป็นวันถัดไป (รูปแบบ YYYY-MM-DD)
--
-- Additive + idempotent ทุกคำสั่ง ไม่แตะ public.contracts ไม่ลบอะไร

-- ============================================================================
-- SECTION 1: seed settings (on conflict do nothing — ไม่ทับค่าที่แก้ไปแล้ว)
-- ============================================================================

insert into app_settings (key, value, description) values
  ('media_around_video_required_from', '2099-12-31', 'วันที่เริ่มบังคับแนบคลิปรอบตัวเครื่อง (device_around_video) เทียบกับวันที่สร้างสัญญา แบบเดียวกับ media_video_required_from — ค่าเริ่มต้นตั้งไกลอนาคต (ปิดฟีเจอร์) จนกว่าคุณเตยจะสั่งเปิด'),
  ('media_video_total_max_mb', '10.5', 'ขนาดรวมสูงสุดของคลิป 2 คลิป (เทสล็อก + รอบตัวเครื่อง) ต่อ 1 สัญญา หน่วย MB — 10.5 + รูปที่ใหญ่สุดเท่าที่เคยเจอ 5.5 = 16 MB เพดานอีเมล (เพดานอีเมลยังเป็น 16 ตามเดิม)')
on conflict (key) do nothing;

-- ============================================================================
-- SECTION 2: media_gate_complete — เพิ่ม flag around_video_required (signature เดิมเป๊ะ grant เดิมคงอยู่)
-- diff เทียบ 0154: เพิ่มตัวแปร 3 ตัว + บล็อกคำนวณ v_around_required + 1 บรรทัด case
-- ============================================================================

create or replace function public.media_gate_complete(p_contract_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_created_at           timestamptz;
  v_condition            text;
  v_origin               text;
  v_credit_flag          boolean;
  v_email_sent_at        timestamptz;
  v_gate_from            text;
  v_override             boolean;
  v_video_required_from  text;
  v_video_gate_from      date;
  v_video_required       boolean := false;
  v_around_required_from text;
  v_around_gate_from     date;
  v_around_required      boolean := false;
  v_slots                jsonb;
  v_counts               jsonb;
  v_slot                 jsonb;
  v_required             boolean;
begin
  select created_at, condition, origin, credit_history_found, email_sent_at
    into v_created_at, v_condition, v_origin, v_credit_flag, v_email_sent_at
  from public.contracts
  where id = p_contract_id;

  if not found then
    -- ไม่พบสัญญา — ให้ caller (RPC ที่เรียกฟังก์ชันนี้) เจอ error "ไม่พบสัญญา" จากขั้นตอนอื่นแทน
    return false;
  end if;

  select value into v_gate_from from public.app_settings where key = 'media_gate_from';
  v_gate_from := coalesce(v_gate_from, '2026-09-09');

  if v_created_at is null or (v_created_at at time zone 'utc')::date < v_gate_from::date then
    return true; -- ไม่ gated (สัญญาเก่ากว่า cutoff หรือไม่มี created_at)
  end if;

  select exists(
    select 1 from public.contract_media_gate_override where contract_id = p_contract_id
  ) into v_override;
  if v_override then
    return true; -- แอดมินกดข้ามการตรวจไฟล์ไว้แล้ว (log_media_gate_bypass, 0137)
  end if;

  -- (0154) video_required: setting เป็นวันที่ถูกต้อง (parse ไม่ผ่าน/ว่าง = ไม่บังคับ ห้าม raise) AND
  -- created_at ของสัญญา (UTC date) >= วันนั้น AND contracts.email_sent_at ยังเป็น null (ดู comment
  -- หัวไฟล์ว่าทำไมใช้ email_sent_at ไม่ใช่ contract_media.emailed_at)
  select value into v_video_required_from from public.app_settings where key = 'media_video_required_from';
  if v_video_required_from is not null and btrim(v_video_required_from) <> '' then
    begin
      v_video_gate_from := v_video_required_from::date;
    exception when others then
      v_video_gate_from := null; -- ค่าผิดรูปแบบ — ไม่บังคับ ไม่ raise (ตามที่ตกลง)
    end;
  end if;

  if v_video_gate_from is not null
     and v_created_at is not null
     and (v_created_at at time zone 'utc')::date >= v_video_gate_from
     and v_email_sent_at is null
  then
    v_video_required := true;
  end if;

  -- (0174) around_video_required: กฎเดียวกับ video_required ทุกประการ แต่อ่านจาก setting แยก
  -- media_around_video_required_from (UTC date เทียบ created_at ของสัญญา, email_sent_at ต้องยังเป็น null,
  -- ค่าว่าง/ผิดรูปแบบ/ไม่มี setting = ไม่บังคับ ไม่ raise)
  select value into v_around_required_from from public.app_settings where key = 'media_around_video_required_from';
  if v_around_required_from is not null and btrim(v_around_required_from) <> '' then
    begin
      v_around_gate_from := v_around_required_from::date;
    exception when others then
      v_around_gate_from := null;
    end;
  end if;

  if v_around_gate_from is not null
     and v_created_at is not null
     and (v_created_at at time zone 'utc')::date >= v_around_gate_from
     and v_email_sent_at is null
  then
    v_around_required := true;
  end if;

  select value::jsonb into v_slots from public.app_settings where key = 'media_slots';
  v_slots := coalesce(v_slots, '[]'::jsonb);

  select coalesce(jsonb_object_agg(s.slot_key, s.cnt), '{}'::jsonb) into v_counts
  from (
    select slot_key, count(*) as cnt
    from public.contract_media
    where contract_id = p_contract_id and deleted_at is null
    group by slot_key
  ) s;
  v_counts := coalesce(v_counts, '{}'::jsonb);

  for v_slot in select * from jsonb_array_elements(v_slots)
  loop
    v_required := case
      when v_slot ->> 'required' = 'always' then true
      when v_slot ->> 'required' = 'never' then false
      when jsonb_typeof(v_slot -> 'required') = 'object' and v_slot -> 'required' ->> 'when' = 'condition'
        then v_condition = (v_slot -> 'required' ->> 'equals')
      when jsonb_typeof(v_slot -> 'required') = 'object' and v_slot -> 'required' ->> 'when' = 'flag'
        -- flag ที่รองรับตอนนี้: credit_history_found (0136/0137 slot 13.1), video_required (0154 —
        -- slot lock_test_video), around_video_required (0174 — slot device_around_video) — เพิ่ม flag ใหม่ในอนาคตเติมใน case นี้ได้ ไม่ต้องแก้โครงฟังก์ชัน
        then case (v_slot -> 'required' ->> 'name')
               when 'credit_history_found' then coalesce(v_credit_flag, false)
               when 'video_required' then v_video_required
               when 'around_video_required' then v_around_required
               else false
             end
      else false
    end;

    if v_required then
      if coalesce((v_counts ->> (v_slot ->> 'key'))::int, 0) < coalesce((v_slot ->> 'min')::int, 0) then
        return false;
      end if;
    end if;
  end loop;

  return true;
end;
$$;
comment on function public.media_gate_complete(uuid) is
  '(0142+0154+0174) true = สัญญานี้ผ่านเกณฑ์รูป/คลิปครบ (หรือไม่ถูก gate / แอดมินข้ามการตรวจไว้แล้ว) — mirror evaluateGate ของ send-company-email/index.ts ใช้เป็น guard ของ submit_for_review. flag: credit_history_found, video_required (0154), around_video_required (0174: media_around_video_required_from เทียบ created_at + contracts.email_sent_at is null) — ค่า default ทุกตัวปิดฟีเจอร์ (2099-12-31) ผลลัพธ์เดิมของสัญญาทุกใบไม่เปลี่ยนจนกว่าคุณเตยสั่งเปิด';

-- ============================================================================
-- SECTION 3: unique index คลิป device_around_video ได้ 1 ไฟล์ที่ยังมีชีวิต/สัญญา (pattern 0155 SECTION 3)
-- ============================================================================

do $$
declare
  v_dupe_count int;
begin
  select count(*) into v_dupe_count
  from (
    select contract_id
    from public.contract_media
    where slot_key = 'device_around_video'
      and deleted_at is null
      and purged_at is null
    group by contract_id
    having count(*) > 1
  ) d;

  if v_dupe_count > 0 then
    raise notice 'พบคลิป device_around_video ซ้ำมากกว่า 1 ไฟล์ (ยังไม่ลบ/purge) ใน % สัญญา — ข้ามการสร้าง unique index รอบนี้', v_dupe_count;
  else
    create unique index if not exists contract_media_around_video_unique_live
      on public.contract_media (contract_id)
      where slot_key = 'device_around_video' and deleted_at is null and purged_at is null;

    execute format(
      'comment on index public.contract_media_around_video_unique_live is %L',
      '(0174) กันอัปคลิป device_around_video เกิน 1 ไฟล์ที่ "ยังมีชีวิต" (ไม่ soft-delete/purge) ต่อสัญญา — ไฟล์ที่ purge ไปแล้วไม่ถูกนับ'
    );

    raise notice 'สร้าง contract_media_around_video_unique_live สำเร็จ (ไม่พบข้อมูลซ้ำ)';
  end if;
end $$;

-- ============================================================================
-- SECTION 4: media_purge_candidates — ก็อปจาก 0155 SECTION 5 (นิยามล่าสุด) เปลี่ยนเฉพาะ slot_key filter
-- signature/security/grants เดิมเป๊ะ (revoke/grant ซ้ำให้ชัวร์ เหมือน 0155)
-- ============================================================================

create or replace function public.media_purge_candidates(
  p_retention_days int,
  p_contract_id     uuid default null,
  p_limit           int  default 50
)
returns table (
  media_id      uuid,
  contract_id   uuid,
  contract_no   text,
  path          text,
  bytes         int,
  emailed_at    timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    cm.id          as media_id,
    cm.contract_id as contract_id,
    c.contract_no  as contract_no,
    cm.path        as path,
    cm.bytes       as bytes,
    cm.emailed_at  as emailed_at
  from public.contract_media cm
  join public.contracts c on c.id = cm.contract_id
  where cm.slot_key in ('lock_test_video', 'device_around_video')
    and cm.storage_provider = 'r2'
    and cm.deleted_at is null
    and cm.purged_at is null
    and cm.emailed_at is not null
    and cm.emailed_at < now() - make_interval(days => greatest(p_retention_days, 7))
    and (c.review_status is null or c.review_status not in ('pending_review', 'needs_fix'))
    and (p_contract_id is null or cm.contract_id = p_contract_id)
  order by cm.emailed_at asc
  limit least(greatest(p_limit, 1), 50)
$$;

revoke all on function public.media_purge_candidates(int, uuid, int) from public, anon, authenticated;
grant execute on function public.media_purge_candidates(int, uuid, int) to service_role;

comment on function public.media_purge_candidates(int, uuid, int) is
  '(0155+0174) เลือกแถวคลิป (lock_test_video + device_around_video) ที่ครบเงื่อนไข purge (retention floor 7 วัน + กรอง review_status pending_review/needs_fix ในฝั่ง DB ก่อนตัด limit) service_role เท่านั้นที่เรียกได้ เพราะคืน path จริงบน R2';

-- ============================================================================
-- Verify checklist สำหรับครีมรันหลัง apply (MCP) — ไม่รันอัตโนมัติในไฟล์นี้
-- ============================================================================

-- a) settings ใหม่ครบ 2 key (ค่า 2099-12-31 และ 10.5):
-- select key, value from app_settings where key in ('media_around_video_required_from','media_video_total_max_mb');

-- b) unique index สร้างแล้ว (ถ้าไม่มีข้อมูลซ้ำ):
-- select indexname, indexdef from pg_indexes
--  where schemaname = 'public' and tablename = 'contract_media' and indexname = 'contract_media_around_video_unique_live';

-- c) grants ยังเหมือนเดิม:
-- select has_function_privilege('service_role',  'public.media_purge_candidates(int, uuid, int)', 'EXECUTE'); -- true
-- select has_function_privilege('authenticated', 'public.media_purge_candidates(int, uuid, int)', 'EXECUTE'); -- false
-- select has_function_privilege('anon',          'public.media_purge_candidates(int, uuid, int)', 'EXECUTE'); -- false
-- select grantee, privilege_type from information_schema.routine_privileges where routine_name = 'media_gate_complete'; -- เทียบก่อน/หลัง apply ต้องเหมือนเดิม

-- d) เช็คข้อมูลซ้ำก่อน apply (ควรได้ 0 แถว เพราะยังไม่มีช่อง):
-- select contract_id, count(*) from public.contract_media
--  where slot_key = 'device_around_video' and deleted_at is null and purged_at is null
--  group by contract_id having count(*) > 1;

-- e) regression ของ media_gate_complete: เก็บผลก่อน apply แล้วเทียบหลัง apply แถวต่อแถว (ต้องเหมือนกันทุกแถว):
-- select id, public.media_gate_complete(id) from public.contracts order by id;

-- f) rollback test: เกท + purge. ทั้งหมดอยู่ใต้ BEGIN..ROLLBACK ไม่ commit. ต้องมีสัญญา TESTQ ที่ email_sent_at is null และสร้าง
-- หลัง media_gate_from. ทดสอบเพิ่มช่องชั่วคราวใน media_slots ภายใน transaction จึงรันได้ทั้งก่อนและหลัง apply 0175
-- (ถ้า 0175 apply แล้ว ช่องมีอยู่ ให้ข้ามขั้น update media_slots):
--
-- begin;
-- do $test$
-- declare
--   v_contract uuid;
--   v_media    uuid;
--   v_before   boolean;
--   v_after    boolean;
--   v_hit      boolean;
--   v_slots    text;
-- begin
--   select id into v_contract from public.contracts
--    where contract_no like 'TESTQ-%' and email_sent_at is null
--      and (created_at at time zone 'utc')::date >= (select value::date from app_settings where key = 'media_gate_from')
--    limit 1;
--   if v_contract is null then
--     raise exception 'ไม่พบสัญญา TESTQ ที่ email_sent_at is null และสร้างหลัง media_gate_from — หาเคสมาใช้แทน';
--   end if;
--   select value into v_slots from app_settings where key = 'media_slots';
--
--   -- (1) setting ปิด (2099) + ใส่ช่องใหม่ชั่วคราว → ผลเกทต้องเท่าก่อนใส่ช่อง
--   v_before := public.media_gate_complete(v_contract);
--   if not exists (select 1 from jsonb_array_elements(v_slots::jsonb) e where e->>'key' = 'device_around_video') then
--     update app_settings set value = (
--       select jsonb_agg(e order by (e->>'sortOrder')::numeric)::text
--       from jsonb_array_elements(v_slots::jsonb || '[{"key":"device_around_video","label":"x","min":1,"max":1,"kind":"video","required":{"when":"flag","name":"around_video_required"},"sortOrder":15.1}]'::jsonb) e
--     ) where key = 'media_slots';
--   end if;
--   v_after := public.media_gate_complete(v_contract);
--   if v_before is distinct from v_after then
--     raise exception 'FAIL เคส 1: setting ปิดอยู่แต่ผลเกทเปลี่ยน % -> %', v_before, v_after;
--   end if;
--
--   -- (2) เปิดฟีเจอร์ (วันเริ่ม 2000-01-01) ไม่มีคลิปรอบตัว → ถ้าเดิมผ่านต้องกลายเป็นไม่ผ่าน
--   update app_settings set value = '2000-01-01' where key = 'media_around_video_required_from';
--   if v_before and public.media_gate_complete(v_contract) then
--     raise exception 'FAIL เคส 2: เปิดฟีเจอร์แล้วไม่มีคลิปรอบตัวแต่เกทยังผ่าน';
--   end if;
--
--   -- (2b) ค่าผิดรูปแบบ → ไม่บังคับ ไม่ raise (ผลเท่าเดิม)
--   update app_settings set value = 'not-a-date' where key = 'media_around_video_required_from';
--   if public.media_gate_complete(v_contract) is distinct from v_before then
--     raise exception 'FAIL เคส 2b: setting ผิดรูปแบบแต่ผลเกทเปลี่ยน';
--   end if;
--   update app_settings set value = '2000-01-01' where key = 'media_around_video_required_from';
--
--   -- (3) ใส่คลิปรอบตัว → เกทกลับเป็นเท่าก่อนเปิด
--   insert into public.contract_media (id, contract_id, slot_key, storage_provider, path, bytes, sha256, deleted_at, purged_at, emailed_at, uploaded_at)
--   values (gen_random_uuid(), v_contract, 'device_around_video', 'r2', 'test/around-ok.mp4', 1000, 'rollbacktest-around', null, null, now() - interval '35 days', now())
--   returning id into v_media;
--   if v_before and not public.media_gate_complete(v_contract) then
--     raise exception 'FAIL เคส 3: มีคลิปรอบตัวแล้วแต่เกทไม่ผ่าน';
--   end if;
--
--   -- (4) purge candidates ต้องเลือกคลิปรอบตัว (emailed_at ย้อน 35 วัน retention 30)
--   select exists(select 1 from public.media_purge_candidates(30, v_contract, 50) where media_id = v_media) into v_hit;
--   if not v_hit then
--     raise exception 'FAIL เคส 4: คลิป device_around_video ที่ครบ 35 วันไม่ถูกเลือกเป็น purge candidate';
--   end if;
--
--   raise notice 'PASS ทุกเคส: flag ใหม่ + purge ครอบคลุมคลิปรอบตัว';
-- end $test$;
-- rollback; -- ต้อง rollback เสมอ (แก้ app_settings + แถวคลิปทดสอบชั่วคราว)
