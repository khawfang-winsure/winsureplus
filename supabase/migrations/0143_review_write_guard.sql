-- 0143: ปิดช่องโหว่ RLS ของระบบตรวจเคส (contract_review) — staff เขียน review_status ตรงผ่าน
-- REST/console ได้เอง (RLS เดิมเป็น row-level ไม่ครอบคอลัมน์) แล้วเรียก sendCompanyEmail ต่อได้ทันที
-- ทั้งที่ยังไม่ผ่านแอดมินตรวจจริง — ติ๊กเจอในรีวิวโค้ด (2026-09-08)
-- ปิด 2 ช่อง:
--   1) trigger บน public.contracts บังคับว่า review_status/review_updated_at/review_updated_by
--      เปลี่ยนได้ทาง RPC submit_for_review/approve_review/reject_review (0142) เท่านั้น
--      + ล็อกไม่ให้ staff แก้คอลัมน์อื่นของสัญญาที่ approved แล้ว (ยกเว้น email_sent_at/email_sent_by
--      ที่ canSendEmail ของแบม (src/lib/review.ts) ตั้งใจให้ staff กดส่ง/บันทึกได้ตอน approved)
--   2) contract_media INSERT policy (0136) + storage.objects insert policy ห้าม staff แนบไฟล์เพิ่ม
--      บนสัญญาที่ approved แล้ว (ต้องแอดมินกดยกเลิกตรวจก่อน)
-- Additive/idempotent ทั้งหมด — drop trigger/policy if exists ก่อนสร้างใหม่, create or replace function

-- ============================================================================
-- SECTION 1: trigger guard บน public.contracts
-- ============================================================================

create or replace function public.contracts_review_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- ยกเว้น service_role ทั้งหมด (Edge Function send-company-email ต้อง stamp
  -- email_sent_at/email_sent_by บนสัญญา approved ได้ผ่าน service-role client — ดู 0142/send-company-email)
  -- เช็ค 2 ทาง: current_user (role ที่ต่อ DB จริงตอนใช้ SUPABASE_SERVICE_ROLE_KEY ผ่าน PostgREST)
  -- และ request.jwt.claim.role (GUC ที่ PostgREST/Data API ตั้งจาก JWT role claim) — กันพลาดถ้าฝั่งใดฝั่งหนึ่ง
  -- ไม่ตรงตามที่คาด (เช่น ต่อผ่าน connection pooler ที่ตั้ง role คนละแบบ)
  if current_user = 'service_role'
     or coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
  then
    return new;
  end if;

  -- ยกเว้นทุก request ที่ไม่มี user login (auth.uid() เป็น null) — ครอบคลุม service_role (กันซ้ำจากเช็คด้านบน),
  -- เจ้าของ table (migration/MCP ที่รันเป็น Postgres owner ไม่ใช่ service_role), และ cron/Edge context อื่นๆ
  -- เหตุผล: browser client ของ staff/admin ทุกตัวแนบ JWT เสมอ ดังนั้น auth.uid() ต้อง non-null ทุก request
  -- จากฝั่ง staff จริง — null คือไม่ใช่ threat model ของ guard นี้ (staff เข้าตาราง contracts ไม่ได้เลยถ้าไม่มี JWT
  -- เพราะ RLS policy เดิมของ contracts เองก็ require is_admin()/is_staff() ซึ่ง lookup profiles ผ่าน auth.uid())
  -- ผลคือ: manual SQL fix ที่ครีม/ติ๊กรันผ่าน apply_migration MCP (เป็น owner ไม่ใช่ service_role) แก้คอลัมน์อื่น
  -- ของสัญญา approved แล้วได้ตามปกติ ไม่โดน Guard B บล็อกอีกต่อไป
  if auth.uid() is null then
    return new;
  end if;

  -- Guard A: review_status / review_updated_at / review_updated_by เปลี่ยนได้ทาง RPC เท่านั้น
  -- RPC ทั้ง 3 ตัว (0142) ตั้ง app.review_rpc='1' แบบ transaction-local ก่อน update ทุกครั้ง (SECTION 2)
  if (new.review_status is distinct from old.review_status)
     or (new.review_updated_at is distinct from old.review_updated_at)
     or (new.review_updated_by is distinct from old.review_updated_by)
  then
    if coalesce(current_setting('app.review_rpc', true), '') <> '1' then
      raise exception 'สถานะการตรวจเปลี่ยนได้ผ่านปุ่มในระบบเท่านั้น';
    end if;
  end if;

  -- Guard B: เคส approved แล้ว — staff (ไม่ใช่แอดมิน) แก้คอลัมน์อื่นของสัญญาไม่ได้
  -- ยกเว้น review_* (คุมโดย Guard A ไปแล้ว) และ email_sent_at/email_sent_by (canSendEmail ใน
  -- src/lib/review.ts ตั้งใจให้ staff กดปุ่ม "ส่งเมล/บันทึกว่าส่งเอง" ได้ตอน approved โดยไม่ต้องเป็นแอดมิน —
  -- ถ้าล็อกคอลัมน์นี้ด้วยจะพังฟีเจอร์ที่มีอยู่แล้วที่ WaitingEmail.tsx doMarkSent/markEmailSent)
  if old.review_status = 'approved' and not public.is_admin() then
    if (to_jsonb(new) - array[
          'review_status', 'review_updated_at', 'review_updated_by',
          'email_sent_at', 'email_sent_by'
        ]::text[])
       is distinct from
       (to_jsonb(old) - array[
          'review_status', 'review_updated_at', 'review_updated_by',
          'email_sent_at', 'email_sent_by'
        ]::text[])
    then
      raise exception 'เคสนี้ตรวจผ่านแล้ว แก้ไขไม่ได้ ถ้าต้องแก้ แจ้งแอดมิน';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.contracts_review_guard() is
  '(0143) BEFORE UPDATE guard บน contracts: กัน review_status/review_updated_at/review_updated_by ถูกเขียนตรงนอก RPC 0142 (Guard A) + กัน staff แก้คอลัมน์อื่นของสัญญา approved แล้ว ยกเว้น email_sent_at/by (Guard B) — ยกเว้น service_role ทั้งหมด และยกเว้นทุก request ที่ auth.uid() เป็น null (owner/MCP/cron/Edge — ไม่มี browser JWT)';

drop trigger if exists contracts_review_guard on public.contracts;
create trigger contracts_review_guard
  before update on public.contracts
  for each row execute function public.contracts_review_guard();

-- ============================================================================
-- SECTION 2: create or replace 3 RPC จาก 0142 — เพิ่มแค่ 1 บรรทัดต่อฟังก์ชัน
-- (perform set_config('app.review_rpc', '1', true); ก่อน update บน contracts)
-- ที่เหลือ copy verbatim จาก 0142_contract_review.sql — ไม่แก้ logic/ข้อความ/signature
-- ============================================================================

create or replace function public.submit_for_review(p_contract_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role    text;
  v_active  boolean;
  v_current text;
begin
  select role, active into v_role, v_active from public.profiles where id = auth.uid();
  if v_role is null or v_role not in ('admin', 'staff') or v_active is not true then
    raise exception 'ไม่มีสิทธิ์ส่งตรวจ';
  end if;

  select review_status into v_current from public.contracts where id = p_contract_id for update;
  if not found then
    raise exception 'ไม่พบสัญญา';
  end if;

  if v_current is not null and v_current is distinct from 'needs_fix' then
    raise exception 'ส่งตรวจได้เฉพาะเคสที่ยังไม่ส่งตรวจ หรือถูกตีกลับให้แก้ไขเท่านั้น';
  end if;

  if not public.media_gate_complete(p_contract_id) then
    raise exception 'แนบรูปให้ครบทุกช่องก่อน จึงส่งตรวจได้';
  end if;

  perform set_config('app.review_rpc', '1', true);

  update public.contracts
     set review_status = 'pending_review',
         review_updated_at = now(),
         review_updated_by = auth.uid()
   where id = p_contract_id;

  insert into public.contract_review_log (contract_id, from_status, to_status, action, reason, actor, actor_role)
  values (p_contract_id, v_current, 'pending_review', 'submit', null, auth.uid(), v_role);
end;
$$;

grant execute on function public.submit_for_review(uuid) to authenticated, service_role;

comment on function public.submit_for_review(uuid) is
  '(0142) admin/staff (active) ส่งเคสให้แอดมินตรวจ — จาก null/needs_fix เท่านั้น + ต้องผ่าน media_gate_complete; error ตรงกับ src/lib/review.ts nextStatus(action=submit)';

create or replace function public.approve_review(p_contract_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text;
begin
  select review_status into v_current from public.contracts where id = p_contract_id for update;
  if not found then
    raise exception 'ไม่พบสัญญา';
  end if;

  if not is_admin() then
    raise exception 'เฉพาะแอดมินเท่านั้นที่ตรวจผ่านเคสได้';
  end if;

  if v_current is distinct from 'pending_review' then
    raise exception 'ตรวจผ่านได้เฉพาะเคสที่อยู่ในสถานะรอตรวจ';
  end if;

  perform set_config('app.review_rpc', '1', true);

  update public.contracts
     set review_status = 'approved',
         review_updated_at = now(),
         review_updated_by = auth.uid()
   where id = p_contract_id;

  insert into public.contract_review_log (contract_id, from_status, to_status, action, reason, actor, actor_role)
  values (p_contract_id, v_current, 'approved', 'approve', null, auth.uid(), 'admin');
end;
$$;

grant execute on function public.approve_review(uuid) to authenticated, service_role;

comment on function public.approve_review(uuid) is
  '(0142) admin เท่านั้น ตรวจผ่านเคส — จาก pending_review เท่านั้น -> approved ทันที (ล็อก staff แก้ไม่ได้แม้ยังไม่ส่งเมล); ส่งเมล (approve_and_send) เป็น 2 ก้าวฝั่ง client: เรียกฟังก์ชันนี้ก่อน แล้วค่อยเรียก send-company-email; error ตรงกับ src/lib/review.ts nextStatus(action=approve)';

create or replace function public.reject_review(p_contract_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text;
  v_action  text;
begin
  select review_status into v_current from public.contracts where id = p_contract_id for update;
  if not found then
    raise exception 'ไม่พบสัญญา';
  end if;

  if v_current is distinct from 'pending_review' and v_current is distinct from 'approved' then
    raise exception 'ตีกลับ/ยกเลิกการตรวจได้เฉพาะเคสที่อยู่ในสถานะรอตรวจ หรือตรวจผ่านแล้วเท่านั้น';
  end if;

  if not is_admin() then
    if v_current = 'approved' then
      raise exception 'เฉพาะแอดมินเท่านั้นที่ยกเลิกการตรวจได้';
    else
      raise exception 'เฉพาะแอดมินเท่านั้นที่ตีกลับเคสได้';
    end if;
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    if v_current = 'approved' then
      raise exception 'ต้องกรอกเหตุผลที่ยกเลิกการตรวจ';
    else
      raise exception 'ต้องกรอกเหตุผลที่ต้องแก้ไข';
    end if;
  end if;

  v_action := case when v_current = 'approved' then 'cancel_approval' else 'reject' end;

  perform set_config('app.review_rpc', '1', true);

  update public.contracts
     set review_status = 'needs_fix',
         review_updated_at = now(),
         review_updated_by = auth.uid()
   where id = p_contract_id;

  insert into public.contract_review_log (contract_id, from_status, to_status, action, reason, actor, actor_role)
  values (p_contract_id, v_current, 'needs_fix', v_action, btrim(p_reason), auth.uid(), 'admin');
end;
$$;

grant execute on function public.reject_review(uuid, text) to authenticated, service_role;

comment on function public.reject_review(uuid, text) is
  '(0142) admin เท่านั้น, reason บังคับไม่ว่าง — จาก pending_review -> needs_fix (log action=reject, "ตีกลับ") หรือจาก approved -> needs_fix (log action=cancel_approval, "ยกเลิกการตรวจ" — ไม่แตะ email_sent_at เดิม); error ตรงกับ src/lib/review.ts nextStatus(action=reject/unapprove) ตามสถานะต้นทาง';

-- ============================================================================
-- SECTION 3: contract_media INSERT policy (0136) — ห้าม staff แนบไฟล์เพิ่มบนสัญญา approved แล้ว
-- ============================================================================

drop policy if exists contract_media_insert on public.contract_media;
create policy contract_media_insert
  on public.contract_media
  as permissive
  for insert
  to authenticated
  with check (
    is_admin()
    or (
      is_staff()
      and exists (
        select 1 from public.contracts c
        where c.id = contract_media.contract_id
          and c.review_status is distinct from 'approved'
      )
    )
  );

-- ============================================================================
-- SECTION 4: storage.objects insert policy (contract_media_objects_insert, 0136) — เงื่อนไขเดียวกัน
-- name convention '<contract_id>/<slot_key>/<uuid>.jpg' — เพิ่มฟังก์ชัน safe-cast กัน error ถ้าชื่อไฟล์ผิดรูป
-- (ผิดรูป = ไม่ใช่ uuid ที่ตำแหน่งแรก) ไม่ให้ policy ทั้งบรรทัด error ทิ้งไปเลย (แค่ถือว่าไม่แมตช์เงื่อนไข staff)
-- ============================================================================

create or replace function public.contract_media_safe_contract_id(p_name text)
returns uuid
language plpgsql
stable
as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when others then
  return null;
end;
$$;

comment on function public.contract_media_safe_contract_id(text) is
  '(0143) แปลง path แรกของ storage.objects.name เป็น uuid contract_id แบบปลอดภัย — คืน null ถ้า parse ไม่ได้ (กัน policy error ถ้าชื่อไฟล์ผิดรูป) ใช้ใน contract_media_objects_insert';

grant execute on function public.contract_media_safe_contract_id(text) to authenticated, service_role;

drop policy if exists contract_media_objects_insert on storage.objects;
create policy contract_media_objects_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'contract-media'
    and (
      public.is_admin()
      or (
        public.is_staff()
        and public.contract_media_safe_contract_id(name) is not null
        and exists (
          select 1 from public.contracts c
          where c.id = public.contract_media_safe_contract_id(name)
            and c.review_status is distinct from 'approved'
        )
      )
    )
  );

-- ============================================================================
-- Verify checklist สำหรับครีมรันหลัง apply (MCP) — ไม่รันอัตโนมัติในไฟล์นี้
-- ============================================================================

-- a) trigger มีจริงบน contracts:
-- select tgname from pg_trigger where tgrelid = 'public.contracts'::regclass and tgname = 'contracts_review_guard';
-- expected: 1 row

-- b) staff เขียน review_status ตรง (นอก RPC) ต้องโดนบล็อก — ทดสอบด้วย session staff จริง (JWT):
--   update public.contracts set review_status = 'approved' where id = '<contract_id>';
--   expected: ERROR สถานะการตรวจเปลี่ยนได้ผ่านปุ่มในระบบเท่านั้น

-- c) staff แก้คอลัมน์อื่น (เช่น monthly_payment) บนสัญญาที่ approved แล้ว ต้องโดนบล็อก:
--   update public.contracts set monthly_payment = monthly_payment where id = '<contract_id_approved>';
--   expected: ERROR เคสนี้ตรวจผ่านแล้ว แก้ไขไม่ได้ ถ้าต้องแก้ แจ้งแอดมิน

-- d) staff กด "มาร์คว่าส่งเมลแล้ว" บนสัญญา approved (markEmailSent, WaitingEmail.tsx) ต้องผ่านตามปกติ —
--    ทดสอบ: update public.contracts set email_sent_at = now(), email_sent_by = 'ทดสอบ' where id = '<contract_id_approved>';
--    expected: สำเร็จ (ไม่ error) แม้ session เป็น staff

-- e) service_role อัปเดต email_sent_at บนสัญญา approved ต้องผ่าน (send-company-email ใช้ path นี้):
-- select has_table_privilege('service_role', 'public.contracts', 'UPDATE'); -- expected: true
-- (ทดสอบจริงต้องยิงผ่าน service-role client เพราะ current_user เปลี่ยนเฉพาะตอนต่อด้วย service key จริง)

-- f) 3 RPC ยังทำงานตามเดิมทุกอย่าง (state machine เต็ม — ดู 0142 SECTION "e" เป็นสคริปต์อ้างอิง)

-- g) contract_media_insert / contract_media_objects_insert บล็อก staff แนบไฟล์บนสัญญา approved:
-- select policyname, cmd from pg_policies where tablename = 'contract_media' and policyname = 'contract_media_insert';
-- select policyname, cmd from pg_policies where schemaname = 'storage' and tablename = 'objects'
--   and policyname = 'contract_media_objects_insert';

-- h) owner/MCP อัปเดตคอลัมน์อื่น (ไม่ใช่ review_*/email_sent_*) บนสัญญา approved แล้ว ต้องสำเร็จ (auth.uid() เป็น null):
--   update public.contracts set monthly_payment = monthly_payment where id = '<contract_id_approved>';
--   expected: สำเร็จ (ไม่ error) — รันผ่าน apply_migration MCP/Postgres owner ไม่มี JWT session
