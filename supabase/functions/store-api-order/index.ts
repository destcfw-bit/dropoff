import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type,x-api-key','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json; charset=utf-8'}
const reply=(b:any,s=200)=>new Response(JSON.stringify(b),{status:s,headers:cors})
async function hexSha256(v:string){const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v));return Array.from(new Uint8Array(d)).map(b=>b.toString(16).padStart(2,'0')).join('')}
Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors})
  if(req.method!=='POST')return reply({error:'method_not_allowed'},405)
  try{
    const key=String(req.headers.get('x-api-key')||'').trim()
    if(!key.startsWith('do_live_'))return reply({error:'invalid_api_key'},401)
    const url=Deno.env.get('SUPABASE_URL')!,service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}})
    const hash=await hexSha256(key)
    const {data:k}=await admin.from('store_api_keys').select('id,store_id,active').eq('key_hash',hash).maybeSingle()
    if(!k?.active)return reply({error:'invalid_api_key'},401)
    const {data:flag}=await admin.from('feature_flags').select('enabled').eq('key','store_api').or('store_id.eq.'+k.store_id+',store_id.is.null').order('store_id',{ascending:false,nullsFirst:false}).limit(1).maybeSingle()
    if(flag && flag.enabled===false)return reply({error:'feature_disabled'},403)
    const body=await req.json()
    const name=String(body.customer_name||'').trim(),phone=String(body.customer_phone||'').trim(),area=String(body.area||'').trim(),address=String(body.address||'').trim()
    const payment=String(body.payment_type||'cod')
    const parcels=Number(body.parcel_count||1)
    const priority=String(body.priority||'normal')
    const serviceType=String(body.service_type||'standard')
    const packageSize=String(body.package_size||'medium')
    const amount=payment==='prepaid'?0:Number(body.amount_to_collect||0)
    if(!name||!phone||!area||!address||!['cod','prepaid'].includes(payment)||!Number.isInteger(parcels)||parcels<1||parcels>100||!['normal','urgent'].includes(priority)
      ||!['standard','same_day','express','pickup_only','return'].includes(serviceType)||!['small','medium','large','xl'].includes(packageSize))
      return reply({error:'invalid_order'},400)
    const {data:store}=await admin.from('stores').select('id,active,branch_id').eq('id',k.store_id).maybeSingle()
    if(!store?.active)return reply({error:'store_inactive'},403)
    const {data:order,error}=await admin.from('orders').insert({
      store_id:k.store_id,branch_id:store.branch_id,customer_name:name,customer_phone:phone,area,address,
      amount_to_collect:amount,payment_type:payment,parcel_count:parcels,priority,service_type:serviceType,package_size:packageSize,
      notes:String(body.notes||'').trim()||null,status:'in_warehouse'
    }).select('id,order_code,customer_name,customer_phone,area,address,amount_to_collect,delivery_fee,return_fee,payment_type,parcel_count,priority,service_type,package_size,status,created_at').single()
    if(error)return reply({error:error.message},400)
    await admin.from('store_api_keys').update({last_used_at:new Date().toISOString()}).eq('id',k.id)
    return reply({ok:true,order},201)
  }catch(e){console.error(e);return reply({error:'server_error'},500)}
})