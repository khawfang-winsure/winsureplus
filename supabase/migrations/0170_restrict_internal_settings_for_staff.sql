-- Apply only after the new frontend is Ready and its staff quote flows pass.
-- Restricted policy is required because the old admin FOR ALL policy also
-- grants SELECT; the restrictive policy is ANDed with all permissive policies.
drop policy if exists app_settings_confidential_read on public.app_settings;
create policy app_settings_confidential_read on public.app_settings
  as restrictive for select to authenticated
  using (
    exists (select 1 from public.profiles p
            where p.id = auth.uid() and p.active = true
              and p.role in ('admin', 'executive'))
    or key <> all (array[
      'installment_rate_sets', 'settlement_matrix', 'settlement_tiers',
      'commission_tiers', 'recruit_shop_tiers', 'recruit_bonus',
      'device_return_tiers_v2', 'device_return_commission_rate',
      'device_return_commission_tiers', 'freelancer_commission_rate'
    ]::text[])
  );
