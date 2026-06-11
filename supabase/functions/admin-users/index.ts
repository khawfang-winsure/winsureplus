// Edge Function: admin-users
// ใช้ service_role เพื่อสร้าง/แก้รหัสผ่าน user (browser ทำตรงๆ ไม่ได้)
// ทุก action ต้องล็อกอินอยู่และ profile.role = 'admin' เท่านั้น
//
// Endpoints (POST JSON):
//  { action: 'list' }                                 -> Profile[]
//  { action: 'create', email, password, fullName, role }
//  { action: 'update', id, fullName?, role?, password? }
//  { action: 'setActive', id, active }

// @ts-nocheck — Deno runtime (Edge Functions) ไม่ตรงกับ Node TS ของ frontend
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.1'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

  // ตรวจ caller (JWT) เป็น admin จริง
  const authHeader = req.headers.get('Authorization') ?? ''
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: userResp, error: userErr } = await callerClient.auth.getUser()
  if (userErr || !userResp?.user) return json({ error: 'ต้องล็อกอินก่อน' }, 401)

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })

  const { data: callerProfile, error: profileErr } = await adminClient
    .from('profiles')
    .select('role, active')
    .eq('id', userResp.user.id)
    .maybeSingle()
  if (profileErr) return json({ error: profileErr.message }, 500)
  if (!callerProfile || callerProfile.role !== 'admin' || callerProfile.active === false) {
    return json({ error: 'เฉพาะแอดมินเท่านั้น' }, 403)
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid json' }, 400)
  }
  const { action } = body ?? {}

  try {
    if (action === 'list') {
      const { data, error } = await adminClient
        .from('profiles')
        .select('id, full_name, role, active, created_at')
        .order('created_at', { ascending: false })
      if (error) throw error
      // อีเมลดึงจาก auth.users (admin API)
      const { data: usersData, error: lsErr } = await adminClient.auth.admin.listUsers({ page: 1, perPage: 1000 })
      if (lsErr) throw lsErr
      const emailMap = new Map(usersData.users.map((u: any) => [u.id, u.email]))
      const merged = (data ?? []).map((p: any) => ({ ...p, email: emailMap.get(p.id) ?? null }))
      return json({ users: merged })
    }

    if (action === 'create') {
      const { email, password, fullName, role } = body
      if (!email || !password || !fullName) return json({ error: 'email/password/fullName ครบทุกช่อง' }, 400)
      if (role !== 'admin' && role !== 'staff') return json({ error: 'role ต้องเป็น admin หรือ staff' }, 400)

      const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName },
      })
      if (createErr) throw createErr

      // trigger handle_new_user แทรก profile แล้ว แต่ role default = 'staff' — set ทับถ้าจำเป็น
      const newId = created.user!.id
      const { error: upErr } = await adminClient
        .from('profiles')
        .update({ full_name: fullName, role })
        .eq('id', newId)
      if (upErr) throw upErr
      return json({ ok: true, id: newId })
    }

    if (action === 'update') {
      const { id, fullName, role, password } = body
      if (!id) return json({ error: 'id required' }, 400)

      // แก้ profile (ชื่อ/role)
      const patch: any = {}
      if (typeof fullName === 'string') patch.full_name = fullName
      if (role === 'admin' || role === 'staff') patch.role = role
      if (Object.keys(patch).length) {
        const { error } = await adminClient.from('profiles').update(patch).eq('id', id)
        if (error) throw error
      }

      // เปลี่ยนรหัสผ่าน (ผ่าน auth admin)
      if (typeof password === 'string' && password.length > 0) {
        if (password.length < 6) return json({ error: 'รหัสผ่านต้องอย่างน้อย 6 ตัว' }, 400)
        const { error } = await adminClient.auth.admin.updateUserById(id, { password })
        if (error) throw error
      }
      return json({ ok: true })
    }

    if (action === 'setActive') {
      const { id, active } = body
      if (!id || typeof active !== 'boolean') return json({ error: 'id+active(boolean) required' }, 400)
      if (id === userResp.user.id && active === false) {
        return json({ error: 'ปิดบัญชีตัวเองไม่ได้ค่ะ' }, 400)
      }
      const { error } = await adminClient.from('profiles').update({ active }).eq('id', id)
      if (error) throw error
      // (ตัวเลือกเสริม) ถ้าจะบล็อกการล็อกอินจริงๆ อาจ updateUserById ban_duration
      return json({ ok: true })
    }

    return json({ error: 'unknown action' }, 400)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
