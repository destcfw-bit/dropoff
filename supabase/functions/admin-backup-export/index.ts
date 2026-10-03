import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json; charset=utf-8'}
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors})
 if(req.method!=='POST')return new Response(JSON.stringify({error:'method_not_allowed'}),{status:405,headers:cors})
 try{
  const url=Deno.env.get('SUPABASE_URL')!,service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const token=(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,'')
  const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}})
  const {data:u}=await admin.auth.getUser(token);if(!u?.user)return new Response(JSON.stringify({error:'unauthorized'}),{status:401,headers:cors})
  const {data:p}=await admin.from('profiles').select('role,active').eq('id',u.user.id).single()
  if(!p?.active||!['owner','admin'].includes(p.role))return new Response(JSON.stringify({error:'admin_only'}),{status:403,headers:cors})
  const {data:id,error}=await admin.rpc('create_daily_snapshot',{p_date:null});if(error)throw error
  const {data:snap,error:e}=await admin.from('backup_snapshots').select('*').eq('id',id).single();if(e)throw e
  return new Response(JSON.stringify(snap.snapshot),{status:200,headers:{...cors,'Content-Disposition':`attachment; filename="dropoff-backup-${snap.snapshot_date}.json"`}})
 }catch(e){console.error(e);return new Response(JSON.stringify({error:'server_error'}),{status:500,headers:cors})}
})