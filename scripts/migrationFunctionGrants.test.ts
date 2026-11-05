// เทสต์สถิต: migration ใหม่ที่สร้างฟังก์ชัน security definer ต้องมีเช็คสิทธิ์ หรือ revoke authenticated หรือมี allow-definer
// รัน: npx tsx --test scripts/migrationFunctionGrants.test.ts
// ผ่านได้ 1 ใน: เรียก auth.uid()/auth.role()/auth.jwt()/is_admin()/is_staff*() ในเนื้อ
//   · `revoke execute on function <ชื่อ> ... authenticated` ในไฟล์เดียวกัน
//   · comment `-- allow-definer: <เหตุผล>` อยู่บรรทัดก่อนนิยามติดกัน หรือ `-- allow-definer: <ชื่อฟังก์ชัน> ...` ที่ไหนก็ได้ในไฟล์
// ไฟล์ที่ตรวจ: เลข 4 หลัก >= 0187 และไฟล์ชื่อ timestamp ที่ >= 20261105000000 (สร้างหลัง 0187)
//   ไฟล์ timestamp ที่มีอยู่ก่อนหน้า (เช่น 20261027...) ไม่นับ เพราะเป็นของเดิมก่อนกฎนี้
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const TS_CUTOFF = 20261105000000

export function shouldCheck(file: string): boolean {
  if (!file.endsWith('.sql')) return false
  const m4 = /^(\d{4})_/.exec(file)
  if (m4) return Number(m4[1]) >= 187
  const mt = /^(\d{14})_/.exec(file)
  if (mt) return Number(mt[1]) >= TS_CUTOFF
  return false
}

// แทน comment บรรทัด (--) ด้วยช่องว่างความยาวเท่าเดิม เพื่อคง offset ไว้เทียบกับต้นฉบับ
function blankComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, (c) => ' '.repeat(c.length))
}

export function findViolations(file: string, raw: string): string[] {
  const sql = blankComments(raw)
  const bad: string[] = []
  const head = /create\s+(?:or\s+replace\s+)?function\s+(?:"?[a-z_][a-z0-9_]*"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi
  let m: RegExpExecArray | null
  while ((m = head.exec(sql))) {
    const name = m[1]
    const open = /\$([a-z0-9_]*)\$/i.exec(sql.slice(head.lastIndex))
    if (!open) continue
    const openStart = head.lastIndex + open.index
    const bodyStart = openStart + open[0].length
    const closeTok = '$' + open[1] + '$'
    const closeAt = sql.indexOf(closeTok, bodyStart)
    if (closeAt < 0) continue
    const semi = sql.indexOf(';', closeAt + closeTok.length)
    const header = sql.slice(m.index, openStart)
    const body = sql.slice(bodyStart, closeAt)
    const tail = sql.slice(closeAt + closeTok.length, semi < 0 ? undefined : semi)
    if (!/security\s+definer/i.test(header + ' ' + tail)) continue

    const hasAuth = /auth\.(?:uid|role|jwt)\s*\(|\bis_admin\s*\(|\bis_staff\w*\s*\(/i.test(body)
    const hasRevoke = new RegExp(
      String.raw`revoke\s+execute\s+on\s+function\s+(?:"?[a-z_][a-z0-9_]*"?\.)?"?` + name + String.raw`"?\b[^;]*authenticated`,
      'i',
    ).test(sql)
    const before = raw.slice(0, m.index).split('\n')
    while (before.length && before[before.length - 1].trim() === '') before.pop()
    const prevLine = before.length ? before[before.length - 1] : ''
    const allowAdjacent = /^\s*--\s*allow-definer\s*:/i.test(prevLine)
    const allowNamed = new RegExp(String.raw`--\s*allow-definer\s*:\s*` + name + String.raw`\b`, 'i').test(raw)
    if (!hasAuth && !hasRevoke && !allowAdjacent && !allowNamed) bad.push(`${file}: ${name}`)
  }
  return bad
}

test('migration จริง (>= 0187): security definer ต้องมีเช็คสิทธิ์/revoke/allow-definer', () => {
  const dir = join(process.cwd(), 'supabase', 'migrations')
  const bad = readdirSync(dir)
    .filter(shouldCheck)
    .flatMap((f) => findViolations(f, readFileSync(join(dir, f), 'utf8')))
  assert.deepEqual(bad, [], `ฟังก์ชัน security definer ไม่มีเช็คสิทธิ์: ${bad.join(', ')}`)
})

test('ตัวอย่าง: definer ไม่มีเช็ค -> ถูกจับ', () => {
  const sql = `create or replace function public.f() returns int language sql security definer as $$ select 1 $$;`
  assert.deepEqual(findViolations('x.sql', sql), ['x.sql: f'])
})

test('ตัวอย่าง: security definer หลังปิด body -> ถูกจับ', () => {
  const sql = `create function private.g() returns int as $$ begin return 1; end $$ language plpgsql security definer;`
  assert.deepEqual(findViolations('x.sql', sql), ['x.sql: g'])
})

test('ตัวอย่าง: มี revoke authenticated -> ผ่าน', () => {
  const sql = `create function public.h() returns int language sql security definer as $$ select 1 $$;
revoke execute on function public.h() from public, anon, authenticated;`
  assert.deepEqual(findViolations('x.sql', sql), [])
})

test('ตัวอย่าง: มี auth.uid() -> ผ่าน', () => {
  const sql = `create function public.i() returns uuid language sql security definer as $$ select auth.uid() $$;`
  assert.deepEqual(findViolations('x.sql', sql), [])
})

test('ตัวอย่าง: invoker ไม่ถูกจับ', () => {
  const sql = `create function public.j() returns int language sql security invoker as $$ select 1 $$;`
  assert.deepEqual(findViolations('x.sql', sql), [])
})

test('ตัวอย่าง: allow-definer ติดนิยาม/ระบุชื่อ -> ผ่าน แต่ของฟังก์ชันอื่นไม่ช่วย', () => {
  const adj = `-- allow-definer: ตั้งใจให้ cron เรียก\ncreate function public.k() returns int language sql security definer as $$ select 1 $$;`
  assert.deepEqual(findViolations('x.sql', adj), [])
  const other = `-- allow-definer: k ตั้งใจ\ncreate function public.k() returns int language sql security definer as $$ select 1 $$;\ncreate function public.l() returns int language sql security definer as $$ select 1 $$;`
  assert.deepEqual(findViolations('x.sql', other), ['x.sql: l'])
})

test('shouldCheck: 4 หลัก >= 0187 และ timestamp หลัง cutoff เท่านั้น', () => {
  assert.equal(shouldCheck('0186_a.sql'), false)
  assert.equal(shouldCheck('0187_a.sql'), true)
  assert.equal(shouldCheck('20261027053436_staff_extension_request.sql'), false)
  assert.equal(shouldCheck('20261106000000_x.sql'), true)
})
