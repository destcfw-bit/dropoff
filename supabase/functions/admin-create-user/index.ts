import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
}

function normalizeJordanPhone(v: string) {
  let x = String(v || '').replace(/[^0-9+]/g, '')
  if (x.startsWith('00962')) x = '+' + x.slice(2)
  else if (x.startsWith('962')) x = '+' + x
  else if (x.startsWith('0')) x = '+962' + x.slice(1)
  else if (x.startsWith('7')) x = '+962' + x
  return x
}

function normalizeUsername(v: string) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, '')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: cors })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const authHeader = req.headers.get('Authorization') || ''
    const token = authHeader.replace(/^Bearer\s+/i, '')
    if (!token) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: cors })

    const admin = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: userData, error: userErr } = await admin.auth.getUser(token)
    if (userErr || !userData?.user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: cors })

    const { data: caller } = await admin.from('profiles').select('role,active').eq('id', userData.user.id).single()
    if (!caller || caller.role !== 'admin' || caller.active !== true) {
      return new Response(JSON.stringify({ error: 'admin_only' }), { status: 403, headers: cors })
    }

    const body = await req.json()
    const full_name = String(body.full_name || '').trim()
    const role = String(body.role || '')
    const login_type = String(body.login_type || '')
    const login_value = String(body.login_value || '').trim()
    const password = String(body.password || '')
    const allowedRoles = ['warehouse','pickup_captain','delivery_captain','store_owner','accountant']

    if (!full_name || !allowedRoles.includes(role) || !['phone','username'].includes(login_type) || !login_value || password.length < 6) {
      return new Response(JSON.stringify({ error: 'invalid_input' }), { status: 400, headers: cors })
    }

    let phone: string | null = null
    let username: string | null = null
    let internalEmail = ''

    if (login_type === 'phone') {
      phone = normalizeJordanPhone(login_value)
      if (!/^\+9627\d{8}$/.test(phone)) return new Response(JSON.stringify({ error: 'invalid_phone' }), { status: 400, headers: cors })
      const { data: exists } = await admin.from('profiles').select('id').eq('phone', phone).maybeSingle()
      if (exists) return new Response(JSON.stringify({ error: 'login_exists' }), { status: 409, headers: cors })
      internalEmail = 'p' + phone.replace(/\D/g, '') + '@login.dropoff.local'
    } else {
      username = normalizeUsername(login_value)
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) return new Response(JSON.stringify({ error: 'invalid_username' }), { status: 400, headers: cors })
      const { data: exists } = await admin.from('profiles').select('id').ilike('username', username).maybeSingle()
      if (exists) return new Response(JSON.stringify({ error: 'login_exists' }), { status: 409, headers: cors })
      internalEmail = username + '@login.dropoff.local'
    }

    let store_id: string | null = null
    if (role === 'store_owner') {
      store_id = String(body.store_id || '')
      if (!store_id) return new Response(JSON.stringify({ error: 'store_required' }), { status: 400, headers: cors })
      const { data: store } = await admin.from('stores').select('id').eq('id', store_id).maybeSingle()
      if (!store) return new Response(JSON.stringify({ error: 'store_not_found' }), { status: 400, headers: cors })
    }

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: internalEmail,
      password,
      email_confirm: true,
      user_metadata: { full_name, phone, username, login_type }
    })

    if (createErr || !created.user) {
      const msg = createErr?.message || 'create_failed'
      return new Response(JSON.stringify({ error: /already|registered|exists/i.test(msg) ? 'login_exists' : msg }), { status: 400, headers: cors })
    }

    const userId = created.user.id
    const cleanup = async () => { try { await admin.auth.admin.deleteUser(userId) } catch {} }

    const { error: profileErr } = await admin.from('profiles').upsert({
      id: userId,
      full_name,
      phone,
      username,
      login_type,
      role,
      active: true,
      email: internalEmail,
    }, { onConflict: 'id' })

    if (profileErr) {
      await cleanup()
      return new Response(JSON.stringify({ error: profileErr.message }), { status: 400, headers: cors })
    }

    if (role === 'pickup_captain' || role === 'delivery_captain') {
      const captain_type = role === 'pickup_captain' ? 'pickup' : 'delivery'
      const { error } = await admin.from('captains').upsert({ id: userId, captain_type, active: true }, { onConflict: 'id' })
      if (error) {
        await cleanup()
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: cors })
      }
    }

    if (role === 'store_owner' && store_id) {
      const { error } = await admin.from('store_users').upsert({ store_id, user_id: userId, is_owner: true }, { onConflict: 'store_id,user_id' })
      if (error) {
        await cleanup()
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: cors })
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      id: userId,
      login_type,
      login: login_type === 'phone' ? phone : username,
      role
    }), { headers: cors })
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'server_error' }), { status: 500, headers: cors })
  }
})

