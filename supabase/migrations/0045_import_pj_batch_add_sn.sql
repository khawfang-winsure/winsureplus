-- 0045: import_pj_batch — เพิ่ม sn (serial number) ใน contracts INSERT
-- ============================================================================
-- Bug: RPC เวอร์ชัน 0044 insert imei แต่ลืม sn → ข้อมูล SN จาก CSV หล่นหายตอน import
--      (2,132 แถวเดิม backfill ผ่าน UPDATE ตรงไปแล้ว — อันนี้กัน import อนาคต)
--
-- การแก้: copy RPC body จาก 0044 Part B มาทั้งดุ้น (byte-identical) เปลี่ยนแค่:
--   1) เพิ่มคอลัมน์ `sn` ใน INSERT column list ต่อจาก `imei`
--   2) เพิ่ม value ที่ตรงกันใน VALUES ต่อจากค่า imei:
--      nullif(trim(coalesce(v_contract->>'sn', '')), '')
--
--   ⚠️ ส่วนอื่นเหมือน 0044 ทุกอย่าง (shop_code ladder, term_months=0 workaround,
--      ฟิลด์ใหม่ 0043, payment_log, addresses, ค่าปรับ, admin check, EXCEPTION, GRANT)
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
  v_shop_code           text;             -- NEW (0044)
  v_new_shop_code       text;             -- NEW (0044) — code to use เมื่อสร้างใหม่
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

  -- ฟิลด์เสริมจาก Google Sheet (0043)
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

      -- ---------- หา / สร้าง shop (NEW 0044 ladder) ----------
      v_shop_name := trim(coalesce(v_contract->>'shop_name', ''));
      v_shop_code := nullif(trim(coalesce(v_contract->>'shop_code', '')), '');
      v_shop_id   := null;

      -- 1) ลอง match ด้วย shop_code ก่อน (ถ้า JSON ส่งมา)
      if v_shop_code is not null then
        select id into v_shop_id
        from public.shops
        where code = v_shop_code
        limit 1;
      end if;

      -- 2) fallback match ด้วยชื่อ (lower+trim)
      if v_shop_id is null and v_shop_name <> '' then
        select id into v_shop_id
        from public.shops
        where lower(trim(name)) = lower(v_shop_name)
        limit 1;
      end if;

      -- 3) ยังไม่มี → สร้างใหม่ (ถ้า flag เปิด)
      if v_shop_id is null then
        if p_create_new_shops then
          -- ใช้ shop_code จาก JSON ถ้ามี ไม่งั้น auto-gen
          v_new_shop_code := coalesce(
            v_shop_code,
            'PJ-' || left(upper(regexp_replace(coalesce(v_shop_name, 'UNKNOWN'), '\s+', '', 'g')), 17)
          );
          insert into public.shops (code, name, active)
          values (
            v_new_shop_code,
            coalesce(nullif(v_shop_name, ''), v_new_shop_code),
            true
          )
          returning id into v_shop_id;
        else
          v_errors := v_errors || jsonb_build_object(
            'invoice_no', v_invoice_no,
            'error',      format('shop not found: code="%s" name="%s" — skipped (create_new_shops=false)',
                                  coalesce(v_shop_code, ''), v_shop_name)
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

      -- ---------- resolve ฟิลด์เสริม (เหมือน 0043) ----------
      v_condition_val := nullif(trim(coalesce(v_contract->>'condition', '')), '');
      if v_condition_val is null then
        v_condition_val := case
          when lower(coalesce(v_contract->>'device_condition', '')) like '%ใหม่%' then 'new'
          else 'used'
        end;
      end if;

      v_notes_val := nullif(trim(coalesce(v_contract->>'notes', '')), '');
      if v_notes_val is null then
        v_notes_val := format('นำเข้าจาก PJ batch %s', p_batch_no);
      end if;

      v_operator_val := coalesce(
        nullif(trim(coalesce(v_contract->>'operator', '')), ''),
        'PJ Import'
      );

      v_promotion_val    := nullif(trim(coalesce(v_contract->>'promotion', '')), '');
      v_promo_detail_val := nullif(trim(coalesce(v_contract->>'promotion_detail', '')), '');
      v_occ_proof_val    := nullif(trim(coalesce(v_contract->>'occupation_proof', '')), '');

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
        occupation_proof,
        shop_id,
        model,
        storage,
        condition,
        origin,
        imei,
        sn,
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
        promotion,
        has_promotion,
        promotion_detail
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
        v_occ_proof_val,
        v_shop_id,
        nullif(trim(coalesce(v_contract->>'device_name', '')), ''),
        nullif(trim(coalesce(v_contract->>'device_storage', '')), ''),
        v_condition_val,
        'th',
        nullif(trim(coalesce(v_contract->>'imei', '')), ''),
        nullif(trim(coalesce(v_contract->>'sn', '')), ''),
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
        v_operator_val,
        v_notes_val,
        v_promotion_val,
        v_has_promotion_val,
        v_promo_detail_val
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

-- GRANT (re-affirm)
grant execute on function public.import_pj_batch(jsonb, jsonb, int, boolean)
  to authenticated, service_role;
