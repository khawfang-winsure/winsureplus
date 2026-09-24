#!/usr/bin/env node
// ตรวจว่า supabase/functions/credit-check/creditCheck.ts เป็นสำเนาตรงตัวของ src/lib/creditCheck.ts
//
// เหตุผล: Edge Function (Deno) deploy ผ่าน MCP `deploy_edge_function` ส่งเฉพาะไฟล์ที่ระบุ ไม่ได้ bundle
// จาก src/ ตอน deploy — เอนจิ้นตรวจเครดิต (pure function, ไม่มี import) จึงต้องมี "สำเนา" อยู่ใน
// supabase/functions/credit-check/ ด้วย ถ้าใครแก้กฎที่ src/lib/creditCheck.ts (เช่น แบมแก้เกณฑ์ธุรกิจ)
// แล้วลืมก๊อปมาไฟล์นี้ → ฝั่งร้าน (public form, ใช้ src/lib ตรงๆ ผ่าน Vite bundle) กับฝั่ง server
// (Edge Function, deploy สำเนานี้) จะคำนวณผลไม่ตรงกัน — เงียบๆ ไม่มี error ให้เห็น อันตรายมาก
//
// สคริปต์นี้เทียบไฟล์ตรงตัว (byte-for-byte) ไม่ต้องมี dependency เพิ่ม รันด้วย:
//   node scripts/check-credit-engine-sync.mjs
// exit code 0 = ตรงกัน, 1 = ไม่ตรง (ปริ้น diff แถวแรกที่ต่างให้ดู)
//
// หมายเหตุ: ยังไม่ได้ผูกเข้า `npm run build` (ต้องแก้ package.json — นอกขอบเขตงานนี้ตาม CLAUDE.md กฎ 0
// เรื่องแก้ package.json ต้องมี specialist + ติ๊ก review) — ตอนนี้รันแยกเองหรือผูกเข้า CI ภายหลัง

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

const SOURCE_OF_TRUTH = join(repoRoot, 'src', 'lib', 'creditCheck.ts')
const EDGE_COPY = join(repoRoot, 'supabase', 'functions', 'credit-check', 'creditCheck.ts')

function readOrExit(path, label) {
  try {
    return readFileSync(path, 'utf8')
  } catch (e) {
    console.error(`[check-credit-engine-sync] ไม่พบไฟล์ ${label}: ${path}`)
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}

const a = readOrExit(SOURCE_OF_TRUTH, 'src/lib/creditCheck.ts')
const b = readOrExit(EDGE_COPY, 'supabase/functions/credit-check/creditCheck.ts')

if (a === b) {
  console.log('[check-credit-engine-sync] OK — สองไฟล์ตรงกันทุกตัวอักษร')
  process.exit(0)
}

// หาแถวแรกที่ต่างกัน ช่วยดีบักเร็วขึ้น
const linesA = a.split('\n')
const linesB = b.split('\n')
const maxLen = Math.max(linesA.length, linesB.length)
let firstDiffLine = -1
for (let i = 0; i < maxLen; i++) {
  if (linesA[i] !== linesB[i]) {
    firstDiffLine = i + 1
    break
  }
}

console.error('[check-credit-engine-sync] FAIL — src/lib/creditCheck.ts กับ supabase/functions/credit-check/creditCheck.ts ไม่ตรงกัน')
console.error(`  แก้ไฟล์ต้นทาง (src/lib/creditCheck.ts) แล้วต้องก๊อปทับ supabase/functions/credit-check/creditCheck.ts ด้วยเสมอ`)
if (firstDiffLine > 0) {
  console.error(`  ต่างกันเริ่มที่บรรทัด ${firstDiffLine}:`)
  console.error(`    src/lib:  ${linesA[firstDiffLine - 1] ?? '(ไม่มีบรรทัดนี้)'}`)
  console.error(`    edge fn:  ${linesB[firstDiffLine - 1] ?? '(ไม่มีบรรทัดนี้)'}`)
}
process.exit(1)
