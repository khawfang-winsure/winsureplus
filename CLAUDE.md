# CLAUDE.md

ไฟล์นี้บอกแนวทางให้ Claude Code (claude.ai/code) ทำงานในโปรเจกต์นี้ — Pete (เจ้าของ) อ่านได้เพื่อรู้ว่าตอนนี้กฎอะไรล็อกอยู่บ้าง

## โปรเจกต์

**WIN SURE PLUS** — เว็บติดตามลูกค้าผ่อน iPhone ผ่านร้านพาร์ทเนอร์ มาแทน Google Sheets หลายชีต กรอกครั้งเดียวได้ครบ: ข้อมูลลูกค้า, สรุปยอดโอนให้ร้าน, ข้อความอีเมล, ติดตามค่างวด, จัดกลุ่มลูกค้าล่าช้า, รายงานวัดผลร้าน

- เจ้าของ: **พี่พิธ** (non-coder) — เคยให้แฟน **เตย** ดูแลฝั่ง infra
- ตอนนี้ Cream มีสิทธิ์ Supabase + Vercel MCP เต็ม — จัดการ deploy / migration / env / Edge Function ตรงผ่าน MCP เลย **ไม่ต้องสอนพี่ทำ manual**

## 🚨 กฎ 0: ครีมห้ามเขียน source code (locked 2026-06-11)

ครีมต้อง **spawn specialist ทุกครั้ง** ที่จะแก้ไฟล์ source code — แม้แค่ 1-2 บรรทัด แม้เสีย 15 วินาที. ห้ามมี fast-path

**ครีมแก้ตรงได้ (non-code เท่านั้น):**
- `.claude/agents/*.md` (HR), `CLAUDE.md` (HR-ish), `memory/*.md` (โน้ตของครีม)
- `.env` / env vars (ค่าตั้งค่า ไม่ใช่ code)
- คำสั่ง Bash (git / gh / npm / MCP)

**ครีมห้ามแก้ — ต้องส่ง specialist:**
- `src/**/*` → ส่งน้องวิว (UI) / แบม (business logic) / น้องชีส (db.ts)
- `supabase/migrations/*` → น้องชีส
- `supabase/functions/*` → น้องชีส
- `package.json`, `tsconfig.json`, `vite.config.*` → specialist + ติ๊ก review

**ทำไม:** context ของครีมแชร์ทั้ง session ถ้าอ่าน/แก้ code มากๆ จะหลอน + ใช้ Chrome MCP / Supabase MCP ผิด. ให้ specialist รับภาระอ่านไฟล์หนักๆ ครีมสงวน context ไว้ orchestrate. รายละเอียดเต็มที่ [[feedback-no-solo-code]]

## ขออนุมัติ Pete ก่อน push ทุกครั้ง

ก่อน `git push` ทุกรอบ ครีมต้องสรุปสั้นๆ ว่ากำลังจะ deploy อะไร → รอ ✓ จากพี่ → ค่อย push. **ไม่มีการอนุมัติเหมาๆ ล่วงหน้า** หลัง Vercel = Ready ต้อง smoke test บน prod ตาม checklist ด้านล่าง

## Checklist ก่อนถือว่า "เสร็จ" (Deploy)

```
[ ] npm run build clean (TS strict ห้าม warning)
[ ] ติ๊ก review diff (ถ้าแตะ ≥2 ไฟล์ หรือแตะ src/lib/)
[ ] Migration ผ่าน MCP สำเร็จ (ถ้ามี) + verify has_table_privilege ของตารางใหม่
[ ] Edge Function deploy ผ่าน MCP สำเร็จ (ถ้ามี) + curl smoke
[ ] git push → Vercel = success (poll gh api commits/sha/status)
[ ] Chrome MCP smoke test 3 flow ที่กระทบ
[ ] Console clean (ไม่มี error / React warning)
```

## บันทึกเวลา + ขนาน Specialist

- ทุกครั้งที่ specialist ส่งผลกลับมา (task-notification ให้ `duration_ms`) ครีม **เขียน 1 บรรทัด** ลง `velocity/log_<YYYY-MM>.md` (gitignored, รายเดือน). สรุป pattern + size buckets เก็บไว้ที่ [[team-velocity]] (สั้น ~30 บรรทัด)
- งานที่ประเมินว่า > 20 นาที — พิจารณา parallel: **Layer cake** (แบม + น้องชีส + น้องวิว เขียนคนละไฟล์), **Multi-page sweep** (ใช้ Workflow tool `parallel()`), **Read-only review** (ติ๊ก + แป้ง อ่านขนาน). รายละเอียด + anti-pattern ที่ [[parallel-dispatch-patterns]]
- ห้าม parallel: migration apply, Edge Function deploy, แก้ไฟล์เดียวกัน 2 ตัว (เว้นใช้ `isolation: "worktree"`)

## คุณภาพ UI (เฉพาะตอน ship หน้าใหม่/รื้อใหม่)

ครีมรัน axe-core ผ่าน Chrome MCP `javascript_tool` บน preview สด ตั้งเป้า 0 violations + วัด computed style typography (display = bold จริง) + ทดสอบ keyboard / Esc / focus-trap ใน modal. ติ๊กเช็คอีกรอบ. **งานที่แตะแค่ logic/backend ข้ามขั้นนี้ได้**

## คำสั่งใช้บ่อย

```bash
npm install        # ครั้งแรกครั้งเดียว
npm run dev        # local dev ที่ http://localhost:5173 (ใช้ mockData ถ้าไม่มี .env)
npm run build      # tsc -b && vite build — ต้องผ่านก่อน push ทุกครั้ง
```

**ต้อง `npm run build` ก่อน push เสมอ** — TS strict (`noUnusedLocals`) `npm run dev` ข้าม TS check บางอัน ที่ผ่าน dev อาจ fail Vercel production deploy

## Deploy flow

- branch `main` → Production ที่ `winsureplus.vercel.app`
- branch `redesign` → Preview ที่ `winsureplus-git-redesign-winsureplus-projects.vercel.app`
- push GitHub → Vercel auto-deploy. ตรวจสถานะด้วย `gh api repos/khawfang-winsure/winsureplus/commits/<sha>/status --jq '.state'` (poll ด้วย `until` loop ไม่ใช่ sleep ติดกัน)
- **Vite ฝัง env var ตอน build** — เปลี่ยน env บน Vercel ต้อง rebuild ถึงจะมีผล (push empty commit หรือกด Redeploy ที่ปิด cache)
- env บน Vercel แยกตาม environment (Production / Preview / Development) — ติ๊กให้ครบ 3 ทุกตัว ไม่งั้น branch redesign จะไม่เห็น

## สถาปัตยกรรม (สรุปสั้นๆ)

**Pure-function-first** — business logic อยู่ที่ `src/lib/` เป็นฟังก์ชันบริสุทธิ์ (`calc.ts`, `rates.ts`, `messages.ts`, `execDashboard.ts`, `commission.ts`, `letters.ts`). เพิ่ม feature ใหม่ → เขียน pure function ก่อน แล้วค่อย wire เข้า page

**ชั้นข้อมูล `src/lib/db.ts` เป็นช่องทางเดียวไป Supabase** — pages ห้ามเรียก `supabase.from(...)` ตรงๆ ต้องเรียก `getContracts/insertContract/getAllInstallments/...` ใน db.ts. ไฟล์นี้ map row จาก DB → domain type ที่ `src/lib/types.ts`. ถ้าไม่ได้ตั้ง Supabase → `isSupabaseConfigured = false` ระบบใช้ `mockData.ts` แทน dev ได้โดยไม่ต้อง key

**Auth** — `src/lib/auth.tsx` มี `AuthProvider` ครอบทั้งแอป, `useAuth()` คืน `{ session, role: 'admin' | 'staff', name, configured, signIn, signOut }`. role มาจาก `profiles.role` (มี RLS คุม). route สำหรับ admin ต้อง guard 2 ชั้น: ใน `App.tsx` (`isAdmin ? <Page/> : <Navigate />`) **และ** ใน `src/components/nav.ts` (`adminOnly: true`) — Sidebar กรอง 2 ระดับ

**Routing** — `App.tsx` ใช้ `react-router-dom v6`. Settings เป็น nested route เดียว: `/settings/:cat` (cat ∈ shops/device/job/promo/rates/users). page อ่าน `useParams().cat`. NAV ที่ `nav.ts` กำหนดลำดับ icon admin gate submenu. Settings ตั้งใจมีทั้ง sidebar submenu + tab ในหน้า — 2 ทางเขียน URL เดียวกัน อย่ารวมหรือลบทิ้ง

**เรตผ่อน** — สัญญาไม่เก็บตัวคูณ เก็บแค่ผลลัพธ์ (`financeAmount`, `monthlyPayment`, `termMonths`). `app_settings.installment_rate_sets` เก็บชุดเรต/จำนวนงวด. `AddContract.tsx` ให้สลับ manual entry (ข้อมูลเก่าที่ไม่รู้ตัวคูณ) ↔ rate-driven (สัญญาใหม่). ปัดเศษด้วย `Math.round` (0.5 ขึ้นไปขึ้น)

**สถานะ + กลุ่มล่าช้า** — `v_contract_status` view ใน Postgres คำนวณ `daysLate` + `bucket` (`normal | 1-10 | 11-30 | 31-60 | 61-90 | 91-120 | 120+`). page เรียกผ่าน `getAllStatuses()` แล้ว filter ฝั่ง client. ตาราง `payment_log` (Feature A) บันทึก confirm/edit/cancel ทุกครั้ง พร้อมคนทำ — รายได้นับเฉพาะ `action='pay'`

**Edge Function** — `supabase/functions/admin-users/index.ts` deploy ผ่าน Supabase MCP `deploy_edge_function` (ไม่ใช่ CLI) ตั้ง `verify_jwt: false` ที่ gateway. function ตรวจ auth เองด้วย `userClient.auth.getUser()` + ดู profile.role='admin' AND active=true. frontend เรียกผ่าน `supabase.functions.invoke('admin-users', { body })`

## กับดักของ Supabase Key ใหม่ (สำคัญ — แก้ครั้งสุดท้าย 11 มิ.ย. 2026)

Supabase ย้ายจาก legacy `anon`/`service_role` JWT keys → `sb_publishable_xxx` / `sb_secret_xxx` tokens. legacy service_role JWT มี **implicit BYPASS RLS** แต่ `sb_secret_xxx` ใหม่ map เป็น Postgres role `service_role` แบบปกติ — **ต้อง GRANT explicit**. migration `0017_grant_service_role_public.sql` grant SELECT/INSERT/UPDATE/DELETE บนทุก `public.*` table + `ALTER DEFAULT PRIVILEGES` ให้ตารางใหม่ในอนาคต. ไม่ทำอันนี้ → Edge Function ที่ใช้ service_role จะเจอ `permission denied for table profiles (42501)`

ถ้าสร้าง table ใหม่ในโปรเจกต์: ใน `public.*` ใช้ default privileges ของ 0017 ได้ทันที. ใน schema อื่น (ขยายในอนาคต) ต้อง GRANT ใหม่

`VITE_SUPABASE_ANON_KEY` บน Vercel ตอนนี้ใช้ **publishable** key (`sb_publishable_...`) ไม่ใช่ legacy JWT

## Migration

ไฟล์ SQL เลขเรียง `supabase/migrations/0001_init.sql` … `0017_*` ปัจจุบัน. apply ผ่าน `mcp__supabase__apply_migration` (ไม่สอนพี่ใช้ SQL Editor). migration ใหม่ต้องเป็นแบบ additive (`add column if not exists`, `create or replace`, `drop trigger if exists` ก่อนสร้างใหม่) — ห้ามทำ data จริงพัง

`0016_user_management.sql` มี trigger `prevent_self_deactivation` กัน admin ปิดบัญชีตัวเอง — เปลี่ยน user management ต้องเลี่ยง trigger นี้

## Live Testing

Claude-in-Chrome MCP เป็นเครื่องมือหลัก — login admin ใน browser ที่ connect อยู่ครั้งเดียว แล้วใช้ `mcp__Claude_in_Chrome__navigate` + `javascript_tool` driver. ดึง anon (publishable) key จาก JS bundle + access token จาก `localStorage` ไปเช็ค REST / Edge Function ตรงๆ ได้. ระวัง native `alert()`/`confirm()` block renderer ทำ CDP timeout — override `window.alert = () => {}; window.confirm = () => true` ก่อนคลิกปุ่ม save

## Style / Voice

global `~/.claude/CLAUDE.md` ของพี่กำหนด Cream persona (ไทย, ครีม, ตอบไทย, ลงท้าย ค่ะ/คะ, เรียกพี่ "พี่พิธ"). global ทับ default behavior — **ห้าม override จากไฟล์นี้** ไฟล์นี้คือ technical layer เท่านั้น

## รายงาน Pete = ภาษาคนใช้เว็บ (locked 2026-06-13)

Pete เป็น non-coder — รายงาน/สรุปต้องเป็นภาษาที่ "คนทั่วไปที่ใช้เว็บเป็น" อ่านแล้วเข้าใจ ห้ามใช้ศัพท์ technical กับ Pete

**ห้ามใช้คำเหล่านี้กับ Pete:** bundle / chunk / code splitting / TypeScript / RLS / PostgREST / cap / migration ชื่อเลข / view / trigger / cron / Edge Function ชื่อ / commit hash / kebab-case / snake_case / camelCase

**ใช้แทน (mapping):**
- bundle 700 kB → "เว็บโหลดช้า เพราะไฟล์รวมใหญ่"
- PostgREST cap 1000 → "ระบบดึงข้อมูลครั้งละ 1,000 รายการ พอเกินจะดึงไม่ครบ"
- migration 0019 → "ระบบเก็บข้อมูลกฎหมายติดต่อ"
- v_contract_status → "ตารางสรุปสถานะลูกค้า"
- localStorage state → "ระบบจำที่หน้านี้"
- TS strict → "ตรวจโค้ดเข้ม"
- promise_to_pay_date → "วันสัญญาจะจ่าย"

**Mental model Pete:** อ่านเหมือนพี่อ่าน Sheets — ผลกระทบเชิงธุรกิจ + UX + เวลา + ลูกค้า, ไม่ใช่กลไก infra. ครีม/specialists คุยกันเอง = ใช้ technical ได้ แต่ **report กลับ Pete = แปลทุกครั้ง**

รายละเอียดเต็มที่ [[feedback-plain-thai-reports]]

## File hygiene (กฎจำกัดบรรทัด — locked 2026-06-11)

- **CLAUDE.md**: เป้า 150-180 บรรทัด, max 200. เพิ่มของ → ถามตัวเองก่อน: must-know ทุก session ไหม? ถ้าไม่ → ลง memory + index ที่ MEMORY.md
- **memory/*.md**: แต่ละไฟล์ < 100 บรรทัด. ใช้ `[[name]]` link หากันแทนการ expand ทั้งหมดในไฟล์เดียว. หัวข้อโตไม่จำกัด (log, table) → split: summary lean อยู่ memory, raw rolling data ออกไป folder ข้างนอก (เช่น `velocity/`)
- **MEMORY.md** index: 1 บรรทัดต่อ entry, < 150 char. truncate ที่บรรทัด 200 — เก็บให้อ่านได้เร็ว
- ไฟล์ memory ใกล้ 100 บรรทัด → **prune หรือ split** ก่อนใส่เพิ่ม. ดู [[feedback-file-hygiene]]

## เรื่องที่ต้องรู้ไว้ (technical debt + edge cases)

- bundle ~650 kB — code-splitting อยู่ใน backlog ไม่ใช่ priority
- หลาย page query contracts ทั้งหมดด้วย `select('*')` แล้ว filter ฝั่ง client. `national_id` ส่งถึง browser พนักงานทุกคน แต่ render-time mask ด้วย `maskNationalId` ใน `format.ts`. "secure PII ที่ API layer" รู้แล้วแต่ยังไม่ทำ
- ข้อมูลทดสอบ/seed อยู่ใน DB production จริง (สัญญาชื่อ `TESTQ-*` ฯลฯ) — ห้ามลบ verify ก่อน mutate
- `ExtendModal` คิดดอกซ้อน → **Pete locked 2026-06-13: ต้องแก้** ใช้ `principal_remaining` (เงินต้นค้าง ไม่รวมดอก/ค่าปรับสะสม) เป็นต้นคูณเรตใหม่. รายละเอียดที่ [[pete-tactical-fixes-locked]]
