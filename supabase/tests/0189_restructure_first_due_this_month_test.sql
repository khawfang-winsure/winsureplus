-- ทดสอบ logic วันที่ของ 0189 (รันหลัง apply migration) จบด้วย raise exception เสมอ = rollback ไม่เขียนอะไรลง DB
do $$
declare out text := ''; r record; got date;
begin
  for r in select * from (values
    (date '2026-11-16', 30, 1, date '2026-11-30'),
    (date '2026-11-16', 30, 2, date '2026-12-30'),
    (date '2026-11-16', 30, 3, date '2027-01-30'),
    (date '2026-11-16', 30, 4, date '2027-02-28'),
    (date '2026-11-16', 30, 5, date '2027-03-30'),
    (date '2026-11-16', 30, 9, date '2027-07-30'),
    (date '2026-11-16', 16, 1, date '2026-12-16'),
    (date '2026-11-16',  5, 1, date '2026-12-05'),
    (date '2027-01-31', 31, 1, date '2027-02-28'),
    (date '2026-12-15', 31, 1, date '2026-12-31'),
    (date '2026-12-15', 31, 2, date '2027-01-31'),
    (date '2026-12-15', 10, 1, date '2027-01-10')
  ) t(today, dd, i, expected) loop
    got := public.restructure_due_date(r.today, r.dd, r.i);
    out := out || format(E'\n%s today=%s day=%s i=%s got=%s expected=%s',
      case when got = r.expected then 'PASS' else 'FAIL' end, r.today, r.dd, r.i, got, r.expected);
  end loop;
  raise exception 'RESULT (rollback):%', out;
end $$;
