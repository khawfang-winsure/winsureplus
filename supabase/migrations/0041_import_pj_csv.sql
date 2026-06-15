-- 0041: RPC นำเข้าข้อมูลจาก PJ scrape (import_pj_batch) — รองรับ Full History Mode 2,130+ สัญญา

-- ============================================================================
-- SECTION 1: ประเภทข้อมูล return (สรุปผลต่อ batch)
-- ============================================================================

-- หมายเหตุการออกแบบ:
--   1. trg_generate_installments (AFTER INSERT contracts, 0002) สร้างงวดอัตโนมัติเมื่อ term_months > 0
--      → INSERT contracts ด้วย term_months = 0 ก่อน แล้วค่อย insert installments จาก PJ
--      → UPDATE contracts SET term_months = N หลัง insert installments (trigger ไม่ fire ซ้ำ)
--   2. auth.uid() = null ใต้ service_role → ตั้ง by_name = 'PJ Import' ตรงๆ กัน actor ว่าง
--   3. Partial status จาก PJ → map เป็น 'late' (ถ้า due_date < today) หรือ 'pending'
--   4. ทุก contract: idempotent — ถ้า contract_no มีแล้ว → skip + log ใน errors
--   5. Per-row EXCEPTION block → batch ไม่ล่มทั้งก้อนเพราะ 1 row ผิด

-- ============================================================================
-- SECTION 2: RPC — import_pj_batch
-- ============================================================================

create or replace function public.import_pj_batch(
  p_contracts_json     jsonb,   -- array ของ contract objects (100 rows/call)
  p_installments_json  jsonb,   -- array ของ installment objects (ทุก row ของ batch นี้)
  p_batch_no           int,     -- หมายเลข batch (เริ่มต้น 1) ใส่ใน error message
  p_create_new_shops   boolean  -- true = สร้างร้านใหม่อัตโนมัติถ้าไม่พบ
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_contract            jsonb;
  v_installment         jsonb;
  v_invoice_no          text;
  v_shop_id             uuid;
  v_contract_id         uuid;
  v_shop_name           text;
  v_down_payment        numeric;
  v_finance_amount      numeric;
  v_device_price        numeric;
  v_down_percent        numeric;
  v_monthly_payment     numeric;
  v_term_months         int;
  v_first_due_date      date;
  v_due_day             int;
  v_transaction_date    date;
  v_birth_date          date;
  v_birth_year          int;
  v_inst_no             int;
  v_status_val          text;
  v_paid_at_val         timestamptz;
  v_paid_amount_val     numeric;
  v_is_closed           boolean;
  v_total_installments  int;
  v_paid_count          int;
  v_err_msg             text;

  -- counters
  v_contracts_created   int := 0;
  v_installments_created int := 0;
  v_payments_logged     int := 0;
  v_imported            int := 0;
  v_errors              jsonb := '[]'::jsonb;
begin

  -- -------------------------------------------------------
  -- SECURITY: ตรวจ caller เป็น admin เท่านั้น
  -- (function SECURITY DEFINER ไม่มี RLS แต่ต้องมี role check)
  -- -------------------------------------------------------
  if not exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role = 'admin'
      and active = true
  ) then
    raise exception 'import_pj_batch: admin role required (403)';
  end if;

  -- =========================================================
  -- LOOP 1: contracts
  -- =========================================================
  for v_contract in select * from jsonb_array_elements(p_contracts_json)
  loop
    v_invoice_no := v_contract->>'invoice_no';

    begin  -- per-row savepoint block

      -- -----------------------------------------------
      -- 1a. Idempotency: skip ถ้า contract_no มีแล้ว
      -- -----------------------------------------------
      if exists (
        select 1 from public.contracts where contract_no = v_invoice_no
      ) then
        v_errors := v_errors || jsonb_build_object(
          'invoice_no', v_invoice_no,
          'error',      'duplicate: contract_no already exists — skipped'
        );
        continue;
      end if;

      -- -----------------------------------------------
      -- 1b. หา / สร้าง shop
      -- -----------------------------------------------
      v_shop_name := trim(v_contract->>'shop_name');

      select id into v_shop_id
      from public.shops
      where lower(trim(name)) = lower(v_shop_name)
      limit 1;

      if v_shop_id is null then
        if p_create_new_shops then
          insert into public.shops (code, name, active)
          values (
            -- code = ย่อชื่อ (ตัดยาวเกิน 20 ตัวอักษร ใส่ prefix PJ-)
            'PJ-' || left(upper(regexp_replace(v_shop_name, '\s+', '', 'g')), 17),
            v_shop_name,
            true
          )
          returning id into v_shop_id;
        else
          -- ไม่อนุญาตสร้างร้านใหม่ → skip contract + log error
          v_errors := v_errors || jsonb_build_object(
            'invoice_no', v_invoice_no,
            'error',      format('shop not found: "%s" — skipped (create_new_shops=false)', v_shop_name)
          );
          continue;
        end if;
      end if;

      -- -----------------------------------------------
      -- 1c. คำนวณราคาเครื่อง + เปอร์เซ็นต์ดาวน์
      -- -----------------------------------------------
      v_down_payment   := coalesce((v_contract->>'down_payment')::numeric, 0);
      v_finance_amount := coalesce((v_contract->>'finance_amount')::numeric, 0);
      v_device_price   := v_down_payment + v_finance_amount;

      if v_device_price > 0 then
        v_down_percent := round((v_down_payment / v_device_price) * 100, 2);
      else
        v_down_percent := 0;
      end if;

      v_monthly_payment := coalesce((v_contract->>'monthly_payment')::numeric, 0);
      v_term_months     := coalesce((v_contract->>'term_months')::int, 0);

      -- parse first_due_date → due_day
      v_first_due_date := null;
      begin
        v_first_due_date := (v_contract->>'first_due_date')::date;
      exception when others then null;
      end;
      v_due_day := coalesce(extract(day from v_first_due_date)::int, 1);

      -- parse trade_date (วันทำสัญญา)
      v_transaction_date := current_date;
      begin
        v_transaction_date := (v_contract->>'trade_date')::date;
      exception when others then null;
      end;

      -- parse birth_date → birth_year
      v_birth_year := null;
      begin
        v_birth_date := (v_contract->>'birth_date')::date;
        v_birth_year := extract(year from v_birth_date)::int;
      exception when others then null;
      end;

      -- -----------------------------------------------
      -- 1d. นับสถานะ: closed ถ้าทุก installment ของ invoice นี้เป็น Paid
      --     (ตรวจจาก p_installments_json เพราะยังไม่ insert จริง)
      -- -----------------------------------------------
      v_paid_count        := (
        select count(*) from jsonb_array_elements(p_installments_json) x
        where x->>'invoice_no' = v_invoice_no
          and x->>'payment_type' = 'ค่างวด'
          and x->>'status' = 'Paid'
      );
      v_total_installments := (
        select count(*) from jsonb_array_elements(p_installments_json) x
        where x->>'invoice_no' = v_invoice_no
          and x->>'payment_type' = 'ค่างวด'
      );
      v_is_closed := (v_total_installments > 0 and v_paid_count = v_total_installments);

      -- -----------------------------------------------
      -- 1e. INSERT contract (term_months = 0 กัน trigger สร้างงวดอัตโนมัติ)
      -- -----------------------------------------------
      insert into public.contracts (
        contract_no,
        inv_no,
        customer_name,
        national_id,
        phone,
        phone_alt1,
        phone_alt2,
        birth_year,
        occupation,
        shop_id,
        model,
        storage,
        condition,
        origin,
        imei,
        color,
        device_price,
        down_percent,
        commission_percent,
        doc_fee,
        finance_amount,
        monthly_payment,
        term_months,          -- 0 ตอนนี้ → update ทีหลัง
        due_day,
        status,
        transaction_date,
        operator,
        notes
      ) values (
        v_invoice_no,
        v_invoice_no,                                         -- inv_no = invoice_no
        coalesce(nullif(trim(v_contract->>'customer_name'), ''), 'ไม่ระบุ'),
        nullif(trim(coalesce(v_contract->>'national_id', '')), ''),
        nullif(trim(coalesce(v_contract->>'phone', '')), ''),
        nullif(trim(coalesce(v_contract->>'phone_alt1', '')), ''),
        nullif(trim(coalesce(v_contract->>'phone_alt2', '')), ''),
        v_birth_year,
        nullif(trim(coalesce(v_contract->>'occupation', '')), ''),
        v_shop_id,
        nullif(trim(coalesce(v_contract->>'device_name', '')), ''),   -- model
        nullif(trim(coalesce(v_contract->>'device_storage', '')), ''), -- storage
        case when lower(coalesce(v_contract->>'device_condition', '')) like '%ใหม่%' then 'new' else 'used' end,
        'th',                                                 -- origin default
        nullif(trim(coalesce(v_contract->>'imei', '')), ''),
        nullif(trim(coalesce(v_contract->>'device_color', '')), ''),
        v_device_price,
        v_down_percent,
        0,                                                    -- commission_percent default
        0,                                                    -- doc_fee = 0 (ข้อมูล PJ ไม่มี)
        v_finance_amount,
        v_monthly_payment,
        0,                                                    -- term_months = 0 กัน trigger
        v_due_day,
        case when v_is_closed then 'closed' else 'active' end,
        v_transaction_date,
        'PJ Import',
        format('นำเข้าจาก PJ batch %s', p_batch_no)
      )
      returning id into v_contract_id;

      v_contracts_created := v_contracts_created + 1;

      -- -----------------------------------------------
      -- 1f. INSERT customer_addresses (3 ชุด)
      -- -----------------------------------------------
      -- addr_card_full
      if (v_contract->>'addr_card_full') is not null
         and trim(v_contract->>'addr_card_full') <> '' then
        insert into public.customer_addresses (
          contract_id, kind,
          house_no, moo, subdistrict, district, province, postal_code
        )
        select
          v_contract_id, 'id_card',
          p.house_no, p.moo, p.subdistrict, p.district, p.province, p.postal_code
        from public.parse_pj_address(v_contract->>'addr_card_full') p
        on conflict (contract_id, kind) do nothing;
      end if;

      -- addr_current_full
      if (v_contract->>'addr_current_full') is not null
         and trim(v_contract->>'addr_current_full') <> '' then
        insert into public.customer_addresses (
          contract_id, kind,
          house_no, moo, subdistrict, district, province, postal_code
        )
        select
          v_contract_id, 'current',
          p.house_no, p.moo, p.subdistrict, p.district, p.province, p.postal_code
        from public.parse_pj_address(v_contract->>'addr_current_full') p
        on conflict (contract_id, kind) do nothing;
      end if;

      -- addr_work_full
      if (v_contract->>'addr_work_full') is not null
         and trim(v_contract->>'addr_work_full') <> '' then
        insert into public.customer_addresses (
          contract_id, kind,
          house_no, moo, subdistrict, district, province, postal_code
        )
        select
          v_contract_id, 'work',
          p.house_no, p.moo, p.subdistrict, p.district, p.province, p.postal_code
        from public.parse_pj_address(v_contract->>'addr_work_full') p
        on conflict (contract_id, kind) do nothing;
      end if;

      -- -----------------------------------------------
      -- 1g. INSERT payment_log สำหรับเงินดาวน์
      --     (ไม่มี installment ผูก — down_payment เก็บที่ contracts.down_percent)
      --     จำเป็นสำหรับ /exec cashflow + รายงานร้านค้า
      -- -----------------------------------------------
      for v_installment in
        select x from jsonb_array_elements(p_installments_json) x
        where x->>'invoice_no' = v_invoice_no
          and x->>'payment_type' = 'เงินดาวน์'
      loop
        insert into public.payment_log (
          installment_id,
          contract_id,
          action,
          amount,
          paid_amount_after,
          penalty_paid_amount,
          by_name,
          acted_by,
          created_at
        ) values (
          null,  -- installment_id nullable (ยืนยันจาก 0011: ไม่มี NOT NULL)
          v_contract_id,
          'pay',
          coalesce((v_installment->>'amount')::numeric, 0),
          coalesce((v_installment->>'amount')::numeric, 0),
          0,
          'PJ Import',
          null,
          coalesce(
            (nullif(trim(v_installment->>'paid_date'), ''))::timestamptz,
            (v_installment->>'due_date')::timestamptz
          )
        );
        v_payments_logged := v_payments_logged + 1;
      end loop;  -- เงินดาวน์ loop

      -- -----------------------------------------------
      -- 1h. INSERT installments จาก PJ (ค่างวด เท่านั้น ตอนนี้)
      -- -----------------------------------------------
      v_inst_no := 0;

      for v_installment in
        select x from jsonb_array_elements(p_installments_json) x
        where x->>'invoice_no' = v_invoice_no
          and x->>'payment_type' = 'ค่างวด'
        order by (x->>'row_no')::int
      loop
        v_inst_no := v_inst_no + 1;

        -- map PJ status → app status
        v_status_val := case
          when v_installment->>'status' = 'Paid' then 'paid'
          when (v_installment->>'due_date')::date < current_date then 'late'
          else 'pending'
        end;

        -- paid_at: ถ้าจ่ายครบ ให้ใช้ paid_date จาก PJ
        --   fallback = due_date (ไม่ใช้ now() — cashflow ต้องกระจายตามเดือนจริง)
        v_paid_at_val := null;
        if v_installment->>'status' = 'Paid' then
          begin
            v_paid_at_val := coalesce(
              (nullif(trim(v_installment->>'paid_date'), ''))::timestamptz,
              (v_installment->>'due_date')::timestamptz    -- FIX: due_date แทน now()
            );
          exception when others then
            v_paid_at_val := (v_installment->>'due_date')::timestamptz;  -- FIX
          end;
        end if;

        -- paid_amount: ถ้า Paid → ใช้ amount เต็ม; ถ้า Partial → ใช้ paid_amount จาก PJ
        v_paid_amount_val := case
          when v_installment->>'status' = 'Paid'
            then coalesce((v_installment->>'amount')::numeric, 0)
          when v_installment->>'status' = 'Partial'
            then coalesce((v_installment->>'paid_amount')::numeric, 0)
          else 0
        end;

        insert into public.installments (
          contract_id,
          installment_no,
          due_date,
          amount,
          paid_amount,
          paid_at,
          paid_by_name,
          status
        ) values (
          v_contract_id,
          v_inst_no,
          (v_installment->>'due_date')::date,
          coalesce((v_installment->>'amount')::numeric, v_monthly_payment),
          v_paid_amount_val,
          v_paid_at_val,
          case when v_installment->>'status' = 'Paid' then 'PJ Import' else null end,
          v_status_val
        )
        on conflict (contract_id, installment_no) do nothing;

        v_installments_created := v_installments_created + 1;

        -- INSERT payment_log สำหรับงวดที่จ่ายแล้ว
        if v_installment->>'status' = 'Paid' then
          insert into public.payment_log (
            installment_id,
            contract_id,
            action,
            amount,
            paid_amount_after,
            penalty_paid_amount,
            by_name,
            acted_by,
            created_at   -- FIX: ระบุตรงๆ กัน default now() บิดเบือน cashflow
          )
          select
            i.id,
            v_contract_id,
            'pay',
            coalesce((v_installment->>'amount')::numeric, v_monthly_payment),
            coalesce((v_installment->>'amount')::numeric, v_monthly_payment),
            0,
            'PJ Import',
            null,  -- service_role context ไม่มี auth.uid() → by_name เพียงพอ
            v_paid_at_val  -- FIX: ใช้วัน paid_date จริง (หรือ due_date เป็น proxy)
          from public.installments i
          where i.contract_id = v_contract_id
            and i.installment_no = v_inst_no;

          v_payments_logged := v_payments_logged + 1;
        end if;

      end loop;  -- installments loop

      -- -----------------------------------------------
      -- 1i. UPDATE ค่าปรับ (ค่าปรับ rows)
      --     link by invoice_no + due_date ตรง
      -- -----------------------------------------------
      for v_installment in
        select x from jsonb_array_elements(p_installments_json) x
        where x->>'invoice_no' = v_invoice_no
          and x->>'payment_type' = 'ค่าปรับ'
      loop
        -- หา installment ที่ due_date ตรงกัน แล้ว update penalty
        update public.installments i
           set penalty_amount    = coalesce((v_installment->>'amount')::numeric, 0),
               penalty_overridden = true
         where i.contract_id     = v_contract_id
           and i.due_date        = (v_installment->>'due_date')::date;

        -- payment_log สำหรับค่าปรับที่จ่ายแล้ว (Paid)
        if v_installment->>'status' = 'Paid'
           and coalesce((v_installment->>'paid_amount')::numeric, 0) > 0 then
          insert into public.payment_log (
            installment_id,
            contract_id,
            action,
            amount,
            paid_amount_after,
            penalty_paid_amount,
            by_name,
            acted_by,
            created_at   -- FIX: ระบุตรงๆ กัน default now() บิดเบือน cashflow
          )
          select
            i.id,
            v_contract_id,
            'pay',
            0,  -- principal = 0 (นี่คือแถวค่าปรับล้วนๆ)
            coalesce(i.paid_amount, 0),
            coalesce((v_installment->>'paid_amount')::numeric, 0),
            'PJ Import',
            null,
            (v_installment->>'due_date')::timestamptz  -- FIX: due_date proxy (paid_date ใน PJ rows ค่าปรับมักว่าง)
          from public.installments i
          where i.contract_id = v_contract_id
            and i.due_date    = (v_installment->>'due_date')::date
          limit 1;

          v_payments_logged := v_payments_logged + 1;
        end if;

      end loop;  -- ค่าปรับ loop

      -- -----------------------------------------------
      -- 1j. UPDATE term_months จริง (trigger จะไม่ fire ซ้ำ — trigger เป็น AFTER INSERT เท่านั้น)
      -- -----------------------------------------------
      update public.contracts
         set term_months = v_inst_no   -- จำนวน installments ที่เพิ่งจริงๆ
       where id = v_contract_id;

      v_imported := v_imported + 1;

    exception when others then
      get stacked diagnostics v_err_msg = message_text;
      v_errors := v_errors || jsonb_build_object(
        'invoice_no', v_invoice_no,
        'batch',      p_batch_no,
        'error',      v_err_msg
      );
    end;  -- per-row savepoint

  end loop;  -- contracts loop

  -- =========================================================
  -- RETURN: สรุปผล batch
  -- =========================================================
  return jsonb_build_object(
    'batch_no',             p_batch_no,
    'imported',             v_imported,
    'contracts_created',    v_contracts_created,
    'installments_created', v_installments_created,
    'payments_logged',      v_payments_logged,
    'errors',               v_errors
  );

end;
$$;

-- ============================================================================
-- SECTION 3: Helper function — parse_pj_address
-- parse "229 หมู่ 10, ตำบล แหลมรัง, อำเภอ บึงนาราง, จังหวัด พิจิตร, 66130"
-- → (house_no, moo, subdistrict, district, province, postal_code)
-- ============================================================================

create or replace function public.parse_pj_address(p_full text)
returns table (
  house_no    text,
  moo         text,
  subdistrict text,
  district    text,
  province    text,
  postal_code text
)
language plpgsql
immutable
set search_path = public, pg_catalog
as $$
declare
  v_parts text[];
  v_part  text;
  v_house text := null;
  v_moo   text := null;
  v_sub   text := null;
  v_dist  text := null;
  v_prov  text := null;
  v_post  text := null;
begin
  if p_full is null or trim(p_full) = '' then
    return;
  end if;

  -- split by comma, trim each part
  v_parts := regexp_split_to_array(p_full, '\s*,\s*');

  foreach v_part in array v_parts loop
    v_part := trim(v_part);
    if v_part = '' then continue; end if;

    if v_part ~ '^\d{5}$' then
      -- รหัสไปรษณีย์ (5 หลัก)
      v_post := v_part;

    elsif v_part ~ '^หมู่' or v_part ~ 'หมู่\s*\d' then
      -- "หมู่ 10" หรือ ถ้ามี house_no อยู่ด้วย → แยก
      -- รูปแบบ: "229 หมู่ 10" → house_no=229, moo=10
      if v_part ~ '^\d' then
        v_house := (regexp_match(v_part, '^(\S+)'))[1];
        v_moo   := trim(regexp_replace(v_part, '^(\S+)\s+หมู่\s*', ''));
      else
        v_moo := trim(regexp_replace(v_part, '^หมู่\s*', ''));
      end if;

    elsif v_part ~* '^(ตำบล|แขวง)\s*' then
      v_sub := trim(regexp_replace(v_part, '^(ตำบล|แขวง)\s*', '', 'i'));

    elsif v_part ~* '^(อำเภอ|เขต)\s*' then
      v_dist := trim(regexp_replace(v_part, '^(อำเภอ|เขต)\s*', '', 'i'));

    elsif v_part ~* '^จังหวัด\s*' then
      v_prov := trim(regexp_replace(v_part, '^จังหวัด\s*', '', 'i'));

    elsif v_house is null and v_part ~ '^\d' then
      -- บ้านเลขที่ (ตัวแรกที่ขึ้นต้นด้วยตัวเลข)
      v_house := v_part;

    end if;
  end loop;

  -- กรณีที่ part แรกมี house + moo รวมกัน: "229 หมู่ 10"
  if v_house is null and v_moo is null and array_length(v_parts, 1) > 0 then
    v_part := trim(v_parts[1]);
    if v_part ~ '^\d' and v_part ~ 'หมู่' then
      v_house := (regexp_match(v_part, '^(\S+)'))[1];
      v_moo   := trim(regexp_replace(v_part, '^\S+\s+หมู่\s*', ''));
    end if;
  end if;

  return query select v_house, v_moo, v_sub, v_dist, v_prov, v_post;
end;
$$;

-- ============================================================================
-- SECTION 4: GRANTs
-- ============================================================================

-- authenticated: เรียก RPC นี้ (จะถูกเรียกผ่าน frontend import wizard)
-- service_role: Edge Function / cron เรียกได้
grant execute on function public.import_pj_batch(jsonb, jsonb, int, boolean)
  to authenticated, service_role;

grant execute on function public.parse_pj_address(text)
  to authenticated, service_role;

-- ============================================================================
-- SECTION 5: Smoke SQL (Cream รันหลัง apply ผ่าน MCP — not executed here)
-- ============================================================================

-- 5a) ตรวจ function มีอยู่:
--   SELECT proname FROM pg_proc
--     WHERE proname IN ('import_pj_batch', 'parse_pj_address');
--   -- expected: 2 rows

-- 5b) ตรวจ parse_pj_address ทำงาน:
--   SELECT * FROM public.parse_pj_address(
--     '229 หมู่ 10, ตำบล แหลมรัง, อำเภอ บึงนาราง, จังหวัด พิจิตร, 66130'
--   );
--   -- expected: house_no='229', moo='10', subdistrict='แหลมรัง',
--   --           district='บึงนาราง', province='พิจิตร', postal_code='66130'

-- 5c) ตรวจ GRANT ถูกต้อง:
--   SELECT has_function_privilege('service_role',
--     'public.import_pj_batch(jsonb,jsonb,int,boolean)', 'execute');
--   -- expected: true

-- 5d) ทดสอบ dry-run: single contract (ล้อมใน BEGIN/ROLLBACK):
--   BEGIN;
--     SELECT public.import_pj_batch(
--       '[{"invoice_no":"INV-TEST-001","shop_name":"ร้านทดสอบ","customer_name":"ลูกค้าทดสอบ",
--          "trade_date":"2025-01-15","finance_amount":"15000","down_payment":"5000",
--          "monthly_payment":"1000","term_months":"15","first_due_date":"2025-02-15",
--          "device_name":"iPhone 14","device_storage":"128GB","device_condition":"ใหม่"}]'::jsonb,
--       '[{"invoice_no":"INV-TEST-001","row_no":"1","payment_type":"ค่างวด",
--          "amount":"1000","paid_amount":"1000","due_date":"2025-02-15","status":"Paid",
--          "paid_date":"2025-02-10"}]'::jsonb,
--       1, true
--     );
--   ROLLBACK;
--   -- expected: {"batch_no":1,"imported":1,"contracts_created":1,
--   --            "installments_created":1,"payments_logged":1,"errors":[]}
