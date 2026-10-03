import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods':'POST, OPTIONS',
  'Content-Type':'application/json; charset=utf-8'
}
const reply=(b:any,s=200)=>new Response(JSON.stringify(b),{status:s,headers:cors})
async function hexSha256(v:string){
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v))
  return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('')
}
function randomToken(bytes=32){
  const a=new Uint8Array(bytes);crypto.getRandomValues(a)
  return btoa(String.fromCharCode(...a)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
}
Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors})
  if(req.method!=='POST')return reply({error:'method_not_allowed'},405)
  try{
    const url=Deno.env.get('SUPABASE_URL')!,service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const token=(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,'')
    const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}})
    const {data:u}=await admin.auth.getUser(token)
    if(!u?.user)return reply({error:'unauthorized'},401)
    const {data:p}=await admin.from('profiles').select('role,active').eq('id',u.user.id).single()
    if(!p?.active||p.role!=='admin')return reply({error:'admin_only'},403)
    const body=await req.json()
    const storeId=String(body.store_id||'')
    const label=String(body.label||'API').trim().slice(0,100)
    const {data:store}=await admin.from('stores').select('id,name,active').eq('id',storeId).maybeSingle()
    if(!store?.active)return reply({error:'store_not_found'},400)
    const raw='do_live_'+randomToken(32)
    const hash=await hexSha256(raw)
    const {data:row,error}=await admin.from('store_api_keys').insert({
      store_id:storeId,key_hash:hash,key_prefix:raw.slice(0,14),label,created_by:u.user.id
    }).select('id,store_id,key_prefix,label,created_at').single()
    if(error)return reply({error:error.message},400)
    return reply({ok:true,api_key:raw,key:row,warning:'اعرض هذا المفتاح مرة واحدة فقط'})
  }catch(e){console.error(e);return reply({error:'server_error'},500)}
})