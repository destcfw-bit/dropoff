import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods':'POST, OPTIONS',
  'Content-Type':'application/json; charset=utf-8'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok',{headers:cors})
  if (req.method !== 'POST') return new Response(JSON.stringify({error:'method_not_allowed'}),{status:405,headers:cors})

  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const token = (req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'')
    if (!token) return new Response(JSON.stringify({error:'unauthorized'}),{status:401,headers:cors})

    const admin = createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}})
    const {data:userData,error:userErr} = await admin.auth.getUser(token)
    if (userErr || !userData?.user) return new Response(JSON.stringify({error:'unauthorized'}),{status:401,headers:cors})

    const {data:caller} = await admin.from('profiles').select('role,active').eq('id',userData.user.id).single()
    if (!caller || caller.role!=='admin' || caller.active!==true) return new Response(JSON.stringify({error:'admin_only'}),{status:403,headers:cors})

    const body = await req.json()
    const user_id = String(body.user_id||'')
    if (!user_id || user_id===userData.user.id) return new Response(JSON.stringify({error:'invalid_user'}),{status:400,headers:cors})

    if (typeof body.active === 'boolean') {
      const {error} = await admin.from('profiles').update({active:body.active}).eq('id',user_id)
      if (error) return new Response(JSON.stringify({error:error.message}),{status:400,headers:cors})
    }

    if (body.password != null) {
      const password = String(body.password||'')
      if (password.length < 6) return new Response(JSON.stringify({error:'password_too_short'}),{status:400,headers:cors})
      const {error} = await admin.auth.admin.updateUserById(user_id,{password})
      if (error) return new Response(JSON.stringify({error:error.message}),{status:400,headers:cors})
    }

    return new Response(JSON.stringify({ok:true}),{headers:cors})
  } catch (e) {
    return new Response(JSON.stringify({error:e instanceof Error?e.message:'server_error'}),{status:500,headers:cors})
  }
})