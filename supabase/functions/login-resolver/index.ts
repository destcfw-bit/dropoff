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
async function sha256(v: string) {
  const bytes = new TextEncoder().encode(v)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}
function response(body: unknown,status=200){
  return new Response(JSON.stringify(body),{status,headers:cors})
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return response({ error: 'method_not_allowed' },405)

  try {
    const body = await req.json()
    const raw = String(body.identifier || '').trim()
    const password = String(body.password || '')
    if (!raw || password.length < 6) return response({ error: 'invalid_credentials' },401)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || serviceRole
    const admin = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } })

    const looksPhone = /^([+]?\d|0)/.test(raw)
    const normalized = looksPhone ? normalizeJordanPhone(raw) : normalizeUsername(raw)
    const identifierHash = await sha256(normalized)
    const ipRaw = (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    const ipHash = ipRaw ? await sha256(ipRaw) : null

    const {data:settings}=await admin.from('security_settings').select('max_failed_attempts,window_minutes,lock_minutes').eq('id',true).maybeSingle()
    const maxAttempts=Number(settings?.max_failed_attempts||5)
    const windowMinutes=Number(settings?.window_minutes||15)
    const lockMinutes=Number(settings?.lock_minutes||15)
    const since=new Date(Date.now()-windowMinutes*60000).toISOString()

    const {count:idFails}=await admin.from('login_attempts').select('id',{count:'exact',head:true})
      .eq('identifier_hash',identifierHash).eq('successful',false).gte('created_at',since)
    let ipFails=0
    if(ipHash){
      const q=await admin.from('login_attempts').select('id',{count:'exact',head:true})
        .eq('ip_hash',ipHash).eq('successful',false).gte('created_at',since)
      ipFails=Number(q.count||0)
    }
    if(Number(idFails||0)>=maxAttempts || ipFails>=maxAttempts*2){
      await admin.from('security_events').insert({
        event_type:'login_rate_limited',severity:'warning',subject:identifierHash,
        meta:{ip_hash:ipHash,identifier_failures:idFails||0,ip_failures:ipFails,lock_minutes:lockMinutes}
      })
      return response({error:'too_many_attempts',retry_after_minutes:lockMinutes},429)
    }

    let profileQuery = admin.from('profiles').select('id,role,active,phone,username')
    profileQuery = looksPhone ? profileQuery.eq('phone', normalized) : profileQuery.ilike('username', normalized)
    const { data: profile } = await profileQuery.maybeSingle()

    let ok=false
    let signed:any=null
    if(profile && profile.active===true){
      const { data: userData } = await admin.auth.admin.getUserById(profile.id)
      const email = userData?.user?.email
      if(email){
        const authClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
        signed = await authClient.auth.signInWithPassword({ email, password })
        ok=Boolean(!signed.error && signed.data.session)
      }
    }

    await admin.from('login_attempts').insert({
      identifier_hash:identifierHash,ip_hash:ipHash,successful:ok,
      reason:ok?'success':'invalid_credentials',user_id:ok?profile?.id:null
    })

    if(!ok){
      if(Number(idFails||0)+1>=maxAttempts){
        await admin.from('security_events').insert({
          event_type:'repeated_login_failure',severity:'warning',subject:identifierHash,
          meta:{ip_hash:ipHash,attempts:Number(idFails||0)+1}
        })
      }
      return response({ error: 'invalid_credentials' },401)
    }

    return response({
      ok:true,
      access_token:signed.data.session.access_token,
      refresh_token:signed.data.session.refresh_token,
      expires_at:signed.data.session.expires_at,
      role:profile.role
    })
  } catch (e) {
    console.error(e)
    return response({ error: 'invalid_credentials' },401)
  }
})
