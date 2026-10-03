import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok',{headers:cors})
  if (req.method !== 'POST') return new Response(JSON.stringify({error:'method_not_allowed'}),{status:405,headers:cors})
  try{
    const body = await req.json()
    const token = String(body.qr_token || '')
    if (!/^[0-9a-f-]{36}$/i.test(token)) return new Response(JSON.stringify({error:'not_found'}),{status:404,headers:cors})
    const url = Deno.env.get('SUPABASE_URL')!
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}})
    const {data,error} = await admin.from('orders')
      .select('order_code,status,area,created_at,delivered_at,returned_at,stores(name)')
      .eq('qr_token',token)
      .maybeSingle()
    if(error || !data) return new Response(JSON.stringify({error:'not_found'}),{status:404,headers:cors})
    return new Response(JSON.stringify({ok:true,order:data}),{headers:cors})
  }catch{
    return new Response(JSON.stringify({error:'not_found'}),{status:404,headers:cors})
  }
})
