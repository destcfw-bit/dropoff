import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json; charset=utf-8'}
const reply=(b:any,s=200)=>new Response(JSON.stringify(b),{status:s,headers:cors})
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors})
 if(req.method!=='POST')return reply({error:'method_not_allowed'},405)
 try{
  const url=Deno.env.get('SUPABASE_URL')!,service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const token=(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,'')
  const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}})
  const {data:u}=await admin.auth.getUser(token);if(!u?.user)return reply({error:'unauthorized'},401)
  const {data:p}=await admin.from('profiles').select('role,active').eq('id',u.user.id).single()
  if(!p?.active||!['owner','admin'].includes(p.role))return reply({error:'admin_only'},403)
  const [orders,stores,captains,exceptions,backup,closing,flags,functions]=await Promise.all([
    admin.from('orders').select('id',{count:'exact',head:true}),
    admin.from('stores').select('id',{count:'exact',head:true}).eq('active',true),
    admin.from('captains').select('id',{count:'exact',head:true}).eq('active',true),
    admin.from('order_exceptions').select('id',{count:'exact',head:true}).is('resolved_at',null),
    admin.from('backup_snapshots').select('created_at').order('created_at',{ascending:false}).limit(1),
    admin.from('accounting_closures').select('closed_at').order('closed_at',{ascending:false}).limit(1),
    admin.from('feature_flags').select('key,enabled').is('store_id',null),
    admin.from('ai_daily_summaries').select('generated_at').order('generated_at',{ascending:false}).limit(1)
  ])
  const database={
    database:true,orders:orders.count||0,stores:stores.count||0,captains:captains.count||0,
    open_exceptions:exceptions.count||0,last_backup:backup.data?.[0]?.created_at||null,
    last_accounting_close:closing.data?.[0]?.closed_at||null,
    features:Object.fromEntries((flags.data||[]).map((f:any)=>[f.key,f.enabled]))
  }
  const ok=!orders.error&&!stores.error&&!captains.error&&!exceptions.error
  return reply({ok,database,openai_configured:Boolean(Deno.env.get('OPENAI_API_KEY')),edge_runtime:true,last_ai_summary:functions.data?.[0]?.generated_at||null,timestamp:new Date().toISOString()})
 }catch(e){console.error(e);return reply({error:'server_error'},500)}
})