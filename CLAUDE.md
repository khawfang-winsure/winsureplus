# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

WIN SURE PLUS — iPhone installment tracker for shop-partner business. Replaces multi-tab Google Sheets with single-form data entry that generates transfer summaries, follow-up emails, due-date tracking, late-fee bucketing, and shop performance reports. Owner is non-coder (พิธ); infra was previously delegated to fiancée (เตย) but Supabase + Vercel MCP write access is now granted to Claude — manage deploys, migrations, env, and Edge Functions directly via MCP rather than walking the user through manual steps.

## Commands

```bash
npm install        # one-time setup
npm run dev        # local dev at http://localhost:5173 — uses mockData if .env missing
npm run build      # tsc -b && vite build — MUST PASS before every push
npm run preview    # preview production build locally
```

**Always run `npm run build` before pushing.** TypeScript is strict (`noUnusedLocals`); `npm run dev` skips full TS checking so unused vars, type mismatches, and bad imports compile fine in dev but fail Vercel production deploy.

## Deploy Flow

- `main` branch → Production at `winsureplus.vercel.app`
- `redesign` branch → Preview at `winsureplus-git-redesign-winsureplus-projects.vercel.app`
- Push to GitHub auto-deploys to Vercel. Verify deploy state with `gh api repos/khawfang-winsure/winsureplus/commits/<sha>/status --jq '.state'` (poll with an `until` loop, not chained sleeps).
- **Vite embeds env vars at build time.** Changing a Vercel env var has no effect until a rebuild — push an empty commit (`git commit --allow-empty`) or use Vercel Redeploy with cache OFF.
- Vercel env vars are scoped per environment (Production / Preview / Development). Setting only Production breaks the redesign preview URL — set all three for shared secrets.

## Architecture

**Pure-function-first.** Business logic lives in `src/lib/` as plain functions (`calc.ts`, `rates.ts`, `messages.ts`, `execDashboard.ts`, `commission.ts`, `letters.ts`). UI files import these for display; tests/REST cross-checks invoke them directly. When adding a feature, write the pure function first, then wire it into a page.

**Data layer (`src/lib/db.ts`)** is the single Supabase boundary. Pages never touch `supabase.from(...)` directly — they call `getContracts/insertContract/updateContract/getAllInstallments/...`. `db.ts` maps DB row shapes to the domain types in `src/lib/types.ts`. When Supabase is not configured, `isSupabaseConfigured = false` and helpers fall back to `mockData.ts` so dev works without keys.

**Auth (`src/lib/auth.tsx`).** `AuthProvider` wraps the app; `useAuth()` returns `{ session, role: 'admin' | 'staff', name, configured, signIn, signOut }`. Role comes from `profiles.role` (RLS-protected). Admin-only routes are guarded in `App.tsx` (`isAdmin ? <Page/> : <Navigate to="/" />`) AND in `src/components/nav.ts` (`adminOnly: true` on the NAV entry or its NavChild — `Sidebar.tsx` filters both levels).

**Routing.** Single `App.tsx` with `react-router-dom v6`. Settings is the only nested route group: `/settings/:cat` where `cat ∈ {shops, device, job, promo, rates, users}`; the page reads `useParams().cat` and renders the right sub-section. NAV in `src/components/nav.ts` defines sidebar order, icons, admin gates, and submenu children. Settings deliberately keeps in-page tab buttons even though the sidebar shows submenu — both write to the same URL; don't "deduplicate" by removing one (sidebar uses hover-expand and is unreachable once the user is on the page).

**Pricing/rate model.** No multiplier is stored on the contract — only the result (`financeAmount`, `monthlyPayment`, `termMonths`). `app_settings.installment_rate_sets` holds reusable rate-set/term tables; `AddContract.tsx` lets the operator toggle between manual entry (for old data with unknown multipliers) and rate-driven calc (for new contracts). Both `Math.round` — half-up rounding for positive amounts. Old contracts with unknown multipliers stay typeable directly.

**Status & buckets.** `v_contract_status` is the Postgres view that computes `daysLate` and `bucket` (`normal | 1-10 | 11-30 | 31-60 | 61-90 | 91-120 | 120+`). Pages query it via `getAllStatuses()` and join client-side for filtering. The `payment_log` table (Feature A — payment audit) records every confirm/edit/cancel with the actor — income calculations sum `action='pay'`.

**Edge Functions.** `supabase/functions/admin-users/index.ts` is deployed via Supabase MCP `deploy_edge_function` (not via CLI) with `verify_jwt: false` at the gateway — the function does its own auth check with `userClient.auth.getUser()` and a `profiles.role='admin' AND active=true` lookup. Frontend calls via `supabase.functions.invoke('admin-users', { body })`; the wrapper auto-attaches the user JWT and apikey.

## Supabase: New API Key Migration Trap

**Critical:** Supabase migrated from legacy `anon`/`service_role` JWT keys to new `sb_publishable_xxx` / `sb_secret_xxx` tokens. The legacy `service_role` JWT had **implicit BYPASS RLS**; the new `sb_secret_xxx` maps to the Postgres `service_role` role normally and **requires explicit GRANTs**. Migration `0017_grant_service_role_public.sql` grants `SELECT/INSERT/UPDATE/DELETE` on all `public.*` tables + `ALTER DEFAULT PRIVILEGES` for future tables. Without it: `permission denied for table profiles (42501)` inside Edge Functions.

For any new table or schema-touching migration, verify the GRANT pattern from 0017 still covers it (it does for `public.*` because of default privileges, but extension schemas need explicit grants).

`VITE_SUPABASE_ANON_KEY` in Vercel now holds the **publishable** key (`sb_publishable_...`). Don't replace it with a legacy JWT.

## Migrations

Numbered SQL files in `supabase/migrations/0001_init.sql` … `0017_*`. Apply via `mcp__supabase__apply_migration` rather than walking the user through SQL Editor. New migrations should be additive (`add column if not exists`, `create or replace`, `drop trigger if exists` before recreate) — production data must not break.

`0016_user_management.sql` adds a `prevent_self_deactivation` BEFORE-UPDATE trigger on `profiles` (admins can't lock themselves out). When changing user-management logic, mind this trigger — it raises `exception` on self-deactivate, propagating as a 500 to the Edge Function.

## Live Testing

The Claude-in-Chrome MCP is the primary verification tool — log in as admin once in the connected browser, then drive the live `redesign` preview URL via `mcp__Claude_in_Chrome__navigate` + `javascript_tool`. Extract the anon (publishable) key from the JS bundle and the access token from `localStorage` for direct REST/Edge-Function checks. Native `alert()`/`confirm()` block the renderer and time out CDP — override `window.alert = () => {}; window.confirm = () => true` before clicking save buttons.

## Style/Voice

The owner's global `~/.claude/CLAUDE.md` defines a Cream persona (Thai, ครีม / responds in Thai, ends with ค่ะ/คะ, calls user "พี่พิธ"). That is global and overrides default behavior — do NOT override it from this project file. This file is the **technical layer** only.

## Things to know

- Bundle is ~650 kB — code-splitting is a known backlog item, not a priority.
- Many pages query the full contracts list with `select('*')` and filter client-side. `national_id` ships to all staff browsers and is masked at render time only (`maskNationalId` in `format.ts`). The "secure PII at the API layer" backlog is acknowledged but not yet planned.
- Seed/test data lives in production DB (test contracts named `TESTQ-*` etc.). Don't delete; verify before mutating.
- `ExtendModal` uses `outstanding` as the principal for rate-based extensions — this can double-count interest on already-interest-bearing balances. Flagged for owner policy decision; don't "fix" without confirmation.
