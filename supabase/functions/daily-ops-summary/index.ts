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
  const {data:u}=await admin.auth.getUser(token);if(!u?.user)return reply({error:'unauthorized'},401)
  const {data:p}=await admin.from('profiles').select('role,active').eq('id',u.user.id).single()
  if(!p?.active||!['owner','admin','accountant'].includes(p.role))return reply({error:'not_allowed'},403)
  const {data:flag}=await admin.from('feature_flags').select('enabled').eq('key','ai_daily_summary').is('store_id',null).maybeSingle()
  if(flag?.enabled!==true)return reply({error:'feature_disabled'},403)
  const body=await req.json().catch(()=>({}))
  const d=String(body.date||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman'}).format(new Date()))
  const {data:cached}=await admin.from('ai_daily_summaries').select('*').eq('summary_date',d).maybeSingle()
  if(cached&&!body.force)return reply({ok:true,cached:true,summary:cached})
  if(!openai)return reply({error:'ai_not_configured'},503)
  const start=new Date(d+'T00:00:00+03:00').toISOString(),end=new Date(new Date(d+'T00:00:00+03:00').getTime()+86400000).toISOString()
  const [orders,handovers,expenses,stores,captains,exceptions]=await Promise.all([
    admin.from('orders').select('status,amount_to_collect,delivery_fee,return_fee,payment_type,created_at,delivered_at,returned_at,area,store_id').or(`and(created_at.gte.${start},created_at.lt.${end}),and(delivered_at.gte.${start},delivered_at.lt.${end}),and(returned_at.gte.${start},returned_at.lt.${end})`).limit(10000),
    admin.from('captain_handovers').select('amount,method,handed_over_at').gte('handed_over_at',start).lt('handed_over_at',end).limit(5000),
    admin.from('accounting_expenses').select('amount,category,method,spent_at').gte('spent_at',start).lt('spent_at',end).limit(5000),
    admin.from('store_operational_metrics').select('*').order('orders_30d',{ascending:false}).limit(10),
    admin.from('captain_operational_metrics').select('*').order('delivered_30d',{ascending:false}).limit(10),
    admin.from('order_exceptions').select('reason').is('resolved_at',null).limit(100)
  ])
  const arr=orders.data||[]
  const metrics={
    date:d,created:arr.filter((x:any)=>x.created_at>=start&&x.created_at<end).length,
    delivered:arr.filter((x:any)=>x.status==='delivered'&&x.delivered_at&&x.delivered_at>=start&&x.delivered_at<end).length,
    returned:arr.filter((x:any)=>['returned_store','returned_warehouse','rejected'].includes(x.status)&&x.returned_at&&x.returned_at>=start&&x.returned_at<end).length,
    collections:arr.filter((x:any)=>x.status==='delivered'&&x.payment_type==='cod'&&x.delivered_at>=start&&x.delivered_at<end).reduce((n:number,x:any)=>n+Number(x.amount_to_collect||0),0),
    fees:arr.filter((x:any)=>x.status==='delivered'&&x.delivered_at>=start&&x.delivered_at<end).reduce((n:number,x:any)=>n+Number(x.delivery_fee||0),0),
    handovers:(handovers.data||[]).reduce((n:number,x:any)=>n+Number(x.amount||0),0),
    expenses:(expenses.data||[]).reduce((n:number,x:any)=>n+Number(x.amount||0),0),
    open_exceptions:(exceptions.data||[]).length,
    top_stores:stores.data||[],top_captains:captains.data||[]
  }
  const prompt=`اكتب ملخص تشغيل يومي قصير ومهني لشركة توصيل اسمها Drop Off. اذكر الأرقام الرئيسية، أهم الملاحظات، و3 نقاط تحتاج متابعة غداً. لا تخترع شيئاً. البيانات: ${JSON.stringify(metrics)}`
  const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${openai}`,'Content-Type':'application/json'},body:JSON.stringify({model:Deno.env.get('OPENAI_OPS_MODEL')||'gpt-6-luna',store:false,max_output_tokens:800,input:prompt})})
  const payload=await r.json().catch(()=>({}));if(!r.ok)return reply({error:'ai_failed'},502)
  const summary=outputText(payload).trim()
  const {data:saved,error}=await admin.from('ai_daily_summaries').upsert({summary_date:d,summary,metrics,generated_at:new Date().toISOString(),generated_by:u.user.id}).select().single()
  if(error)return reply({error:error.message},400)
  return reply({ok:true,cached:false,summary:saved})
 }catch(e){console.error(e);return reply({error:'server_error'},500)}
})