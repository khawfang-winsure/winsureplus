-- 0043: ขยาย import_pj_batch รับฟิลด์เพิ่มจาก Google Sheet
-- ============================================================================
-- เพิ่มฟิลด์ที่อ่านจาก p_contracts_json (caller resolve sheet-wins-over-PJ แล้ว
-- — RPC แค่ insert verbatim ไม่ต้อง COALESCE):
--   - promotion           (text)
--   - has_promotion       (boolean)
--   - promotion_detail    (text)
--   - occupation_proof    (text)
--   - notes               (text)  -- เดิม hardcode batch label → ใช้ค่า sheet แทน
--                                    (fallback = batch label ถ้า sheet ว่าง)
--   - condition           (text)  -- เดิม derive จาก device_condition like '%ใหม่%'
--                                    → ใช้ค่า sheet/PJ verbatim ('new'|'used')
--                                    (fallback = legacy derive ถ้า JSON ไม่ส่ง)
--
-- contract_no + operator + notes + condition มีอยู่ใน 0041 แล้ว
--   - contract_no: no-op (รับมาแล้วผ่าน v_invoice_no — 0041 บรรทัด 84,220)
--   - operator: เดิม hardcode 'PJ Import' → ใช้ค่า sheet ถ้ามี (fallback 'PJ Import')
--
-- ⚠️ ไม่แตะ columns บน contracts (ใช้ของเดิม), ไม่แตะ payment_log,
--    ไม่แตะ logic installments/addresses/penalty
-- ============================================================================

create or replace function public.import_pj_batch(
  p_contracts_json     jsonb,
  p_installments_json  jsonb,
  p_batch_no           int,
  p_create_new_shops   boolean
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

  -- NEW (0043): ฟิลด์เสริมจาก Google Sheet
  v_condition_val       text;
  v_notes_val           text;
  v_operator_val        text;
  v_promotion_val       text;
  v_has_promotion_val   boolean;
  v_promo_detail_val    text;
  v_occ_proof_val       text;

  -- counters
  v_contracts_created   int := 0;
  v_installments_created int := 0;
  v_payments_logged     int := 0;
  v_imported            int := 0;
  v_errors              jsonb := '[]'::jsonb;
begin

  -- SECURITY: admin only
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

    begin
      -- Idempotency: skip ถ้า contract_no มีแล้ว
      if exists (
        select 1 from public.contracts where contract_no = v_invoice_no
      ) then
        v_errors := v_errors || jsonb_build_object(
          'invoice_no', v_invoice_no,
          'error',      'duplicate: contract_no already exists — skipped'
        );
        continue;
      end if;

      -- หา / สร้าง shop
      v_shop_name := trim(v_contract->>'shop_name');

      select id into v_shop_id
      from public.shops
      where lower(trim(name)) = lower(v_shop_name)
      limit 1;

      if v_shop_id is null then
        if p_create_new_shops then
          insert into public.shops (code, name, active)
          values (
            'PJ-' || left(upper(regexp_replace(v_shop_name, '\s+', '', 'g')), 17),
            v_shop_name,
            true
          )
          returning id into v_shop_id;
        else
          v_errors := v_errors || jsonb_build_object(
            'invoice_no', v_invoice_no,
            'error',      format('shop not found: "%s" — skipped (create_new_shops=false)', v_shop_name)
          );
          continue;
        end if;
      end if;

      -- ราคา + ดาวน์ %
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

      v_first_due_date := null;
      begin
        v_first_due_date := (v_contract->>'first_due_date')::date;
      exception when others then null;
      end;
      v_due_day := coalesce(extract(day from v_first_due_date)::int, 1);

      v_transaction_date := current_date;
      begin
        v_transaction_date := (v_contract->>'trade_date')::date;
      exception when others then null;
      end;

      v_birth_year := null;
      begin
        v_birth_date := (v_contract->>'birth_date')::date;
        v_birth_year := extract(year from v_birth_date)::int;
      exception when others then null;
      end;

      -- นับ paid/total → is_closed
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

      -- ---------- NEW (0043): resolve ฟิลด์เสริม ----------
      -- condition: ถ้า JSON ส่ง 'condition' มา → ใช้ verbatim
      --            ถ้าไม่ส่ง → fallback legacy derive จาก device_condition
      v_condition_val := nullif(trim(coalesce(v_contract->>'condition', '')), '');
      if v_condition_val is null then
        v_condition_val := case
          when lower(coalesce(v_contract->>'device_condition', '')) like '%ใหม่%' then 'new'
          else 'used'
        end;
      end if;

      -- notes: ถ้า sheet ส่ง notes → ใช้ verbatim
      --        ถ้าไม่ส่ง → fallback batch label เดิม
      v_notes_val := nullif(trim(coalesce(v_contract->>'notes', '')), '');
      if v_notes_val is null then
        v_notes_val := format('นำเข้าจาก PJ batch %s', p_batch_no);
      end if;

      -- operator: ถ้า sheet ส่ง → ใช้ verbatim, fallback 'PJ Import'
      v_operator_val := coalesce(
        nullif(trim(coalesce(v_contract->>'operator', '')), ''),
        'PJ Import'
      );

      -- promotion / has_promotion / promotion_detail / occupation_proof: verbatim
      v_promotion_val    := nullif(trim(coalesce(v_contract->>'promotion', '')), '');
      v_promo_detail_val := nullif(trim(coalesce(v_contract->>'promotion_detail', '')), '');
      v_occ_proof_val    := nullif(trim(coalesce(v_contract->>'occupation_proof', '')), '');

      -- has_promotion: respect JSON boolean explicitly; null if not provided
      v_has_promotion_val := null;
      if (v_contract ? 'has_promotion') and (v_contract->>'has_promotion') is not null then
        begin
          v_has_promotion_val := (v_contract->>'has_promotion')::boolean;
        exception when others then
          v_has_promotion_val := null;
        end;
      end if;

      -- ---------- INSERT contract (term_months=0 กัน trigger) ----------
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
        occupation_proof,           -- NEW (0043)
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
        term_months,
        due_day,
        status,
        transaction_date,
        operator,
        notes,
        promotion,                  -- NEW (0043)
        has_promotion,              -- NEW (0043)
        promotion_detail            -- NEW (0043)
      ) values (
        v_invoice_no,
        v_invoice_no,
        coalesce(nullif(trim(v_contract->>'customer_name'), ''), 'ไม่ระบุ'),
        nullif(trim(coalesce(v_contract->>'national_id', '')), ''),
        nullif(trim(coalesce(v_contract->>'phone', '')), ''),
        nullif(trim(coalesce(v_contract->>'phone_alt1', '')), ''),
        nullif(trim(coalesce(v_contract->>'phone_alt2', '')), ''),
        v_birth_year,
        nullif(trim(coalesce(v_contract->>'occupation', '')), ''),
        v_occ_proof_val,            -- NEW
        v_shop_id,
        nullif(trim(coalesce(v_contract->>'device_name', '')), ''),
        nullif(trim(coalesce(v_contract->>'device_storage', '')), ''),
        v_condition_val,            -- CHANGED: sheet verbatim (fallback legacy)
        'th',
        nullif(trim(coalesce(v_contract->>'imei', '')), ''),
        nullif(trim(coalesce(v_contract->>'device_color', '')), ''),
        v_device_price,
        v_down_percent,
        0,
        0,
        v_finance_amount,
        v_monthly_payment,
        0,
        v_due_day,
        case when v_is_closed then 'closed' else 'active' end,
        v_transaction_date,
        v_operator_val,             -- CHANGED: sheet verbatim (fallback 'PJ Import')
        v_notes_val,                -- CHANGED: sheet verbatim (fallback batch label)
        v_promotion_val,            -- NEW
        v_has_promotion_val,        -- NEW
        v_promo_detail_val          -- NEW
      )
      returning id into v_contract_id;

      v_contracts_created := v_contracts_created + 1;

      -- ---------- customer_addresses (3 ชุด) ----------
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

      -- ---------- payment_log สำหรับเงินดาวน์ ----------
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
          null,
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
      end loop;

      -- ---------- installments (ค่างวด) ----------
      v_inst_no := 0;

      for v_installment in
        select x from jsonb_array_elements(p_installments_json) x
        where x->>'invoice_no' = v_invoice_no
          and x->>'payment_type' = 'ค่างวด'
        order by (x->>'row_no')::int
      loop
        v_inst_no := v_inst_no + 1;

        v_status_val := case
          when v_installment->>'status' = 'Paid' then 'paid'
          when (v_installment->>'due_date')::date < current_date then 'late'
          else 'pending'
        end;

        v_paid_at_val := null;
        if v_installment->>'status' = 'Paid' then
          begin
            v_paid_at_val := coalesce(
              (nullif(trim(v_installment->>'paid_date'), ''))::timestamptz,
              (v_installment->>'due_date')::timestamptz
            );
          exception when others then
            v_paid_at_val := (v_installment->>'due_date')::timestamptz;
          end;
        end if;

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
            created_at
          )
          select
            i.id,
            v_contract_id,
            'pay',
            coalesce((v_installment->>'amount')::numeric, v_monthly_payment),
            coalesce((v_installment->>'amount')::numeric, v_monthly_payment),
            0,
            'PJ Import',
            null,
            v_paid_at_val
          from public.installments i
          where i.contract_id = v_contract_id
            and i.installment_no = v_inst_no;

          v_payments_logged := v_payments_logged + 1;
        end if;

      end loop;

      -- ---------- ค่าปรับ ----------
      for v_installment in
        select x from jsonb_array_elements(p_installments_json) x
        where x->>'invoice_no' = v_invoice_no
          and x->>'payment_type' = 'ค่าปรับ'
      loop
        update public.installments i
           set penalty_amount    = coalesce((v_installment->>'amount')::numeric, 0),
               penalty_overridden = true
         where i.contract_id     = v_contract_id
           and i.due_date        = (v_installment->>'due_date')::date;

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
            created_at
          )
          select
            i.id,
            v_contract_id,
            'pay',
            0,
            coalesce(i.paid_amount, 0),
            coalesce((v_installment->>'paid_amount')::numeric, 0),
            'PJ Import',
            null,
            (v_installment->>'due_date')::timestamptz
          from public.installments i
          where i.contract_id = v_contract_id
            and i.due_date    = (v_installment->>'due_date')::date
          limit 1;

          v_payments_logged := v_payments_logged + 1;
        end if;

      end loop;

      -- UPDATE term_months จริง
      update public.contracts
         set term_months = v_inst_no
       where id = v_contract_id;

      v_imported := v_imported + 1;

    exception when others then
      get stacked diagnostics v_err_msg = message_text;
      v_errors := v_errors || jsonb_build_object(
        'invoice_no', v_invoice_no,
        'batch',      p_batch_no,
        'error',      v_err_msg
      );
    end;

  end loop;

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

-- GRANT (re-affirm; CREATE OR REPLACE keeps grants, แต่ใส่ไว้กัน edge case)
grant execute on function public.import_pj_batch(jsonb, jsonb, int, boolean)
  to authenticated, service_role;

-- ============================================================================
-- Smoke (Cream รันหลัง apply ผ่าน MCP):
-- 1) ตรวจ function signature ไม่เปลี่ยน (ยังเป็น 4 args เดิม):
--    SELECT pg_get_function_identity_arguments(oid)
--      FROM pg_proc WHERE proname='import_pj_batch';
--    -- expected: 'p_contracts_json jsonb, p_installments_json jsonb,
--    --            p_batch_no integer, p_create_new_shops boolean'
--
-- 2) Dry-run row เดียวมีทุกฟิลด์ใหม่ (BEGIN/ROLLBACK):
--    BEGIN;
--      SELECT public.import_pj_batch(
--        '[{"invoice_no":"INV-T-0043","shop_name":"ร้านทดสอบ0043",
--           "customer_name":"ลูกค้าทดสอบ","trade_date":"2025-01-15",
--           "finance_amount":"15000","down_payment":"5000",
--           "monthly_payment":"1000","term_months":"15",
--           "first_due_date":"2025-02-15","device_name":"iPhone 14",
--           "condition":"new","operator":"พี่พิธ","notes":"เคสทดสอบ 0043",
--           "promotion":"PROMO-A","has_promotion":true,
--           "promotion_detail":"ลด 500","occupation_proof":"สเตทเม้นท์"}]'::jsonb,
--        '[{"invoice_no":"INV-T-0043","row_no":"1","payment_type":"ค่างวด",
--           "amount":"1000","paid_amount":"1000","due_date":"2025-02-15",
--           "status":"Paid","paid_date":"2025-02-10"}]'::jsonb,
--        43, true
--      );
--      SELECT contract_no, condition, operator, notes, promotion,
--             has_promotion, promotion_detail, occupation_proof
--        FROM contracts WHERE contract_no='INV-T-0043';
--    ROLLBACK;
