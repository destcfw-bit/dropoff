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
  if(!p?.active||p.role!=='admin')return reply({error:'admin_only'},403)
  const {data:db,error}=await admin.rpc('system_health_status')
  const {data:functions}=await admin.from('ai_daily_summaries').select('generated_at').order('generated_at',{ascending:false}).limit(1)
  return reply({ok:!error,database:db||null,openai_configured:Boolean(Deno.env.get('OPENAI_API_KEY')),edge_runtime:true,last_ai_summary:functions?.[0]?.generated_at||null,timestamp:new Date().toISOString()})
 }catch(e){console.error(e);return reply({error:'server_error'},500)}
})