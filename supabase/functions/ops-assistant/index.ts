import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json; charset=utf-8'}
const reply=(b:any,s=200)=>new Response(JSON.stringify(b),{status:s,headers:cors})
function outputText(p:any){if(typeof p?.output_text==='string')return p.output_text;for(const i of p?.output||[])for(const c of i?.content||[])if(c?.type==='output_text')return c.text||'';return ''}
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors})
 if(req.method!=='POST')return reply({error:'method_not_allowed'},405)
 try{
  const url=Deno.env.get('SUPABASE_URL')!,service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,openai=Deno.env.get('OPENAI_API_KEY')
  const token=(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,'')
  const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}})
  const {data:u}=await admin.auth.getUser(token); if(!u?.user)return reply({error:'unauthorized'},401)
  const {data:p}=await admin.from('profiles').select('role,active').eq('id',u.user.id).single()
  if(!p?.active||!['owner','admin','accountant'].includes(p.role))return reply({error:'not_allowed'},403)
  const {data:flag}=await admin.from('feature_flags').select('enabled').eq('key','ai_assistant').is('store_id',null).maybeSingle()
  if(flag?.enabled!==true)return reply({error:'feature_disabled'},403)
  if(!openai)return reply({error:'ai_not_configured'},503)
  const body=await req.json(),question=String(body.question||'').trim().slice(0,1500)
  if(question.length<2)return reply({error:'question_required'},400)
  const [daily,exceptions,stores,captains,areas,cash]=await Promise.all([
    admin.from('daily_ops_metrics').select('*').maybeSingle(),
    admin.from('order_exceptions').select('reason,next_action,created_at,orders(order_code,area,status,stores(name))').is('resolved_at',null).order('created_at',{ascending:false}).limit(30),
    admin.from('store_operational_metrics').select('*').order('orders_30d',{ascending:false}).limit(25),
    admin.from('captain_operational_metrics').select('*').order('delivered_30d',{ascending:false}).limit(25),
    admin.from('area_performance_30d').select('*').order('total_orders',{ascending:false}).limit(25),
    admin.from('captain_cash_summary').select('captain_id,full_name,delivered_orders,cash_collected,cash_handed_over,cash_due').limit(50)
  ])
  const context={daily:daily.data||{},exceptions:exceptions.data||[],stores:stores.data||[],captains:captains.data||[],areas:areas.data||[],captain_cash:cash.data||[]}
  const prompt=`أنت مساعد تشغيل داخلي لشركة Drop Off في الأردن. أجب بالعربية بشكل مختصر وعملي اعتماداً فقط على بيانات التشغيل المجمعة التالية. لا تخترع بيانات، وإذا السؤال يحتاج معلومة غير موجودة فقل ذلك. لا تعرض بيانات شخصية غير موجودة في السياق.\n\nDATA:\n${JSON.stringify(context)}\n\nQUESTION:\n${question}`
  const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${openai}`,'Content-Type':'application/json'},body:JSON.stringify({model:Deno.env.get('OPENAI_OPS_MODEL')||'gpt-6-luna',store:false,max_output_tokens:900,input:prompt})})
  const payload=await r.json().catch(()=>({}));if(!r.ok)return reply({error:'ai_failed'},502)
  return reply({ok:true,answer:outputText(payload).trim(),context_updated_at:new Date().toISOString()})
 }catch(e){console.error(e);return reply({error:'server_error'},500)}
})