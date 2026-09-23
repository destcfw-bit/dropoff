import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm'
import QRCode from 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm'
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js'

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)
const app = document.getElementById('app')
const toastEl = document.getElementById('toast')

let session = null
let profile = null
let stores = []
let profiles = []
let captains = []
let currentTab = 'home'

const roleLabels = {
  admin:'الإدارة', warehouse:'المخزن', pickup_captain:'كابتن جلب',
  delivery_captain:'كابتن توصيل', store_owner:'صاحب محل'
}
const statusLabels = {
  new:'جديد', in_warehouse:'بالمخزن', assigned:'مع الكابتن',
  out_for_delivery:'بالطريق', delivered:'تم التسليم', postponed:'مؤجل',
  no_answer:'لا يرد', rejected:'مرفوض', returned_warehouse:'مرتجع للمخزن',
  returned_store:'مرتجع للمحل', cancelled:'ملغي'
}
const money = v => `${Number(v||0).toFixed(2)} د.أ`
const esc = v => String(v ?? '').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))
const qs = (s,r=document)=>r.querySelector(s)
const qsa = (s,r=document)=>[...r.querySelectorAll(s)]
const statusClass = s => s==='delivered'?'green':(['returned_store','returned_warehouse','rejected','cancelled'].includes(s)?'red':(['assigned','out_for_delivery'].includes(s)?'blue':(['postponed','no_answer'].includes(s)?'orange':'purple')))

function normalizeJordanPhone(v){
  let p=String(v||'').trim().replace(/[\s\-()]/g,'')
  if(p.startsWith('00962')) p='+'+p.slice(2)
  else if(p.startsWith('962')) p='+'+p
  else if(p.startsWith('07')) p='+962'+p.slice(1)
  else if(p.startsWith('7')) p='+962'+p
  return p
}
function identifier(v){
  const raw=String(v||'').trim()
  return /^([+]?\d|0)/.test(raw) ? normalizeJordanPhone(raw) : raw.toLowerCase().replace(/\s+/g,'')
}
function portal(){
  const p=(location.pathname.split('/').filter(Boolean)[0]||'admin').toLowerCase()
  return ['admin','captain','store'].includes(p)?p:'admin'
}
const portalMeta = {
  admin:{title:'لوحة الإدارة',roles:['admin']},
  captain:{title:'بوابة الكباتن',roles:['pickup_captain','delivery_captain']},
  store:{title:'بوابة المحلات',roles:['store_owner']}
}
function toast(msg,type='ok'){
  toastEl.textContent=msg
  toastEl.className=`toast show ${type}`
  setTimeout(()=>toastEl.className='toast',2600)
}
function errText(e){return e?.message || String(e || 'حدث خطأ')}

async function login(id,password){
  const r=await fetch(`${SUPABASE_URL}/functions/v1/login-resolver`,{
    method:'POST',
    headers:{'content-type':'application/json','apikey':SUPABASE_PUBLISHABLE_KEY},
    body:JSON.stringify({identifier:identifier(id),password})
  })
  const d=await r.json().catch(()=>({}))
  if(!r.ok || !d?.access_token || !d?.refresh_token){
    throw new Error(d?.error==='invalid_credentials'?'بيانات الدخول غير صحيحة':(d?.error||'تعذر تسجيل الدخول'))
  }
  const s=await supabase.auth.setSession({access_token:d.access_token,refresh_token:d.refresh_token})
  if(s.error) throw s.error
}

async function init(){
  if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{})
  const {data:{session:s}}=await supabase.auth.getSession()
  session=s
  supabase.auth.onAuthStateChange((_event,s2)=>{session=s2;boot()})
  await boot()
}

async function boot(){
  if(!session){profile=null;renderAuth();return}
  const {data,error}=await supabase.from('profiles').select('*').eq('id',session.user.id).single()
  if(error || !data){await supabase.auth.signOut();renderAuth();return}
  profile=data
  if(!profile.active){await supabase.auth.signOut();toast('هذا الحساب موقوف','error');renderAuth();return}
  const p=portal()
  if(!portalMeta[p].roles.includes(profile.role)){
    await supabase.auth.signOut()
    app.innerHTML=`<div class="auth-wrap"><div class="auth-card"><div class="brand"><div class="logo-shell"><img src="/assets/logo.png"></div><h1>Drop Off</h1></div><p style="text-align:center">هذا الحساب لا يملك صلاحية الدخول إلى ${portalMeta[p].title}.</p><button id="backLogin" class="btn btn-primary full">رجوع</button></div></div>`
    qs('#backLogin').onclick=renderAuth
    return
  }
  await loadCommon()
  renderShell()
  await openTab(defaultTab())
}

function renderAuth(){
  const p=portal(),m=portalMeta[p]
  const lab=p==='admin'?'اسم المستخدم':'رقم الهاتف أو اسم المستخدم'
  const ph=p==='admin'?'dropoff':'0791234567 أو username'
  app.innerHTML=`<div class="auth-wrap"><div class="auth-card">
    <div class="brand"><div class="logo-shell"><img src="/assets/logo.png"></div><span class="eyebrow">DROP OFF DELIVERY</span><h1>${m.title}</h1><p>إدارة أسرع. توصيل أذكى.</p></div>
    <form id="loginForm">
      <div class="field"><label>${lab}</label><input id="loginId" autocomplete="username" required placeholder="${ph}"></div>
      <div class="field"><label>كلمة السر</label><input id="loginPassword" type="password" minlength="6" autocomplete="current-password" required placeholder="••••••••"></div>
      <button class="btn btn-primary full" type="submit">تسجيل الدخول</button>
    </form>
    <div class="login-foot">الحسابات يتم إنشاؤها من الإدارة فقط 🔐</div>
  </div></div>`
  qs('#loginForm').onsubmit=async e=>{
    e.preventDefault()
    const b=qs('#loginForm button')
    try{
      b.disabled=true;b.textContent='جاري التحقق...'
      await login(qs('#loginId').value,qs('#loginPassword').value)
    }catch(x){
      toast(errText(x),'error');b.disabled=false;b.textContent='تسجيل الدخول'
    }
  }
}

async function loadCommon(){
  if(profile?.role==='admin'){
    const [{data:s},{data:p},{data:c}] = await Promise.all([
      supabase.from('stores').select('*').order('name'),
      supabase.from('profiles').select('*').order('created_at',{ascending:false}),
      supabase.from('captains').select('id,captain_type,active,vehicle_label,profiles(full_name,phone,username)').order('created_at',{ascending:false})
    ])
    stores=s||[];profiles=p||[];captains=c||[]
  }else if(profile?.role==='store_owner'){
    const {data:s}=await supabase.from('stores').select('*').order('name')
    stores=s||[]
  }
}

function defaultTab(){
  if(profile.role==='store_owner')return 'owner'
  if(['pickup_captain','delivery_captain'].includes(profile.role))return 'captain'
  return 'home'
}
function navItems(){
  if(profile.role==='admin')return [
    ['home','⌂ الرئيسية'],['stickers','🏷️ الاستكرات'],['add','＋ إضافة أوردرات'],['orders','▦ الأوردرات'],
    ['assign','⇄ التوزيع'],['stores','🏪 المحلات'],['users','👥 الحسابات'],['accounts','💰 المالية']
  ]
  if(profile.role==='store_owner')return [['store_new','＋ إضافة أوردر'],['owner','▦ طلباتي وحسابي']]
  return [['captain','▦ أوردراتي']]
}
function renderShell(){
  app.innerHTML=`<div class="shell"><aside class="sidebar">
    <div class="side-brand"><img src="/assets/logo.png"><div><strong>Drop Off</strong><small>${esc(roleLabels[profile.role]||profile.role)}</small></div><span class="live-dot"></span></div>
    <div id="nav" class="nav">${navItems().map(([id,label])=>`<button data-tab="${id}">${label}</button>`).join('')}</div>
    <div class="side-foot"><div class="user-pill">${esc(profile.full_name||profile.username||profile.phone||'مستخدم')}<small>${esc(profile.phone||profile.username||'')}</small></div><button id="logout" class="btn btn-ghost full">تسجيل خروج</button></div>
  </aside><main class="main">
    <div class="topbar"><div class="mobile-brand"><img src="/assets/logo.png"><span>Drop Off</span></div><div><h2 id="pageTitle">Drop Off</h2><div id="pageSub" class="muted"></div></div><div class="actions"><button id="refresh" class="btn btn-ghost">↻ تحديث</button></div></div>
    <section id="content"></section>
  </main></div>`
  qsa('#nav button').forEach(b=>b.onclick=()=>openTab(b.dataset.tab))
  qs('#logout').onclick=()=>supabase.auth.signOut()
  qs('#refresh').onclick=()=>openTab(currentTab,true)
}
async function openTab(tab,force=false){
  currentTab=tab
  qsa('#nav button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab))
  const titles={home:'لوحة الإدارة',stickers:'إدارة الاستكرات',store_new:'إضافة أوردر',add:'إضافة أوردرات',orders:'إدارة الأوردرات',assign:'توزيع الأوردرات',stores:'المحلات',users:'الحسابات والصلاحيات',accounts:'الحسابات والتسويات',captain:'أوردرات الكابتن',owner:'حساب المحل'}
  qs('#pageTitle').textContent=titles[tab]||'Drop Off'
  qs('#pageSub').textContent=new Date().toLocaleString('ar-JO')
  try{
    if(force)await loadCommon()
    if(tab==='home')return renderHome()
    if(tab==='stickers')return renderStickers()
    if(tab==='store_new')return renderStoreNew()
    if(tab==='add')return renderAdd()
    if(tab==='orders')return renderOrders()
    if(tab==='assign')return renderAssign()
    if(tab==='stores')return renderStores()
    if(tab==='users')return renderUsers()
    if(tab==='accounts')return renderAccounts()
    if(tab==='captain')return renderCaptain()
    if(tab==='owner')return renderOwner()
  }catch(e){
    qs('#content').innerHTML=`<div class="panel"><div class="empty">${esc(errText(e))}</div></div>`
    toast(errText(e),'error')
  }
}
function stat(label,value){return `<div class="stat"><span>${label}</span><b>${value}</b></div>`}
function storeName(id){return stores.find(x=>x.id===id)?.name||'—'}
function captainName(id){
  const c=captains.find(x=>x.id===id)
  return c?.profiles?.full_name || c?.profiles?.username || c?.profiles?.phone || '—'
}

async function renderHome(){
  const {data:o,error}=await supabase.from('orders').select('id,status,amount_to_collect,created_at')
  if(error)throw error
  const count=s=>o.filter(x=>x.status===s).length
  const d=new Date();d.setHours(0,0,0,0)
  const today=o.filter(x=>new Date(x.created_at)>=d).length
  const delivered=o.filter(x=>x.status==='delivered').reduce((a,x)=>a+Number(x.amount_to_collect||0),0)
  qs('#content').innerHTML=`
    <div class="welcome-card"><div><span class="eyebrow">DROP OFF CONTROL CENTER</span><h3>أهلاً ${esc(profile.full_name||'بالإدارة')} 👋</h3><p>الأوردرات والمخزن والكباتن والحسابات بمكان واحد.</p></div><div class="quick-actions"><button class="btn btn-primary go" data-tab="add">＋ أوردر جديد</button><button class="btn btn-ghost go" data-tab="assign">توزيع الأوردرات</button></div></div>
    <div class="grid stats">${stat('إجمالي الأوردرات',o.length)}${stat('أوردرات اليوم',today)}${stat('بالمخزن',count('in_warehouse'))}${stat('مع الكباتن',count('assigned')+count('out_for_delivery'))}${stat('تم التسليم',count('delivered'))}</div>
    <div class="finance-strip"><span>قيمة التحصيلات المسلّمة</span><strong>${money(delivered)}</strong><span class="mini-status">● النظام متصل</span></div>
    <div class="panel"><div class="panel-head"><h3>آخر الأوردرات</h3><button class="btn btn-ghost go" data-tab="orders">عرض الكل</button></div><div id="latest"></div></div>`
  qsa('.go').forEach(b=>b.onclick=()=>openTab(b.dataset.tab))
  const {data}=await supabase.from('orders').select('*').order('created_at',{ascending:false}).limit(10)
  qs('#latest').innerHTML=orderTable(data||[])
}

function orderTable(rows,actions=false){
  if(!rows.length)return '<div class="empty">لا يوجد نتائج.</div>'
  return `<div class="table-wrap"><table class="table"><thead><tr>
    <th>الأوردر</th><th>المحل</th><th>الزبون</th><th>الهاتف</th><th>المنطقة</th><th>المبلغ</th><th>الحالة</th><th>الكابتن</th>${actions?'<th>إجراءات</th>':''}
  </tr></thead><tbody>${rows.map(o=>`<tr>
    <td><b>${esc(o.order_code)}</b></td><td>${esc(storeName(o.store_id))}</td><td>${esc(o.customer_name)}</td><td>${esc(o.customer_phone)}</td><td>${esc(o.area)}</td><td>${money(o.amount_to_collect)}</td>
    <td><span class="badge ${statusClass(o.status)}">${esc(statusLabels[o.status]||o.status)}</span></td><td>${esc(captainName(o.delivery_captain_id))}</td>
    ${actions?`<td><button class="btn btn-sm btn-blue qr-btn" data-id="${o.id}">QR</button></td>`:''}
  </tr>`).join('')}</tbody></table></div>`
}


async function renderStickers(){
  await loadCommon()
  const {data:rolls,error}=await supabase.from('sticker_rolls').select('*').order('created_at',{ascending:false}).limit(200)
  if(error)throw error

  qs('#content').innerHTML=`
    <div class="panel">
      <div class="panel-head">
        <div><h3>رولات الاستكرات الجاهزة</h3><span class="muted">QR ثابت + رقم ظاهر لكل أوردر قبل إنشاء الطلب</span></div>
      </div>
      <form id="rollForm" class="form-grid">
        <div class="field"><label>المحل</label><select id="rollStore"><option value="">بدون تعيين الآن</option>${stores.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
        <div class="field"><label>عدد الاستكرات</label><input id="rollQty" type="number" min="1" max="5000" value="100" required></div>
        <div class="field"><label>ملاحظة</label><input id="rollNote" placeholder="مثال: رول محل الورد - دفعة 1"></div>
        <div class="field"><label>&nbsp;</label><button class="btn btn-primary" type="submit">＋ إنشاء رول</button></div>
      </form>
      <div id="rollResult"></div>
    </div>

    <div class="panel" style="margin-top:14px">
      <div class="panel-head"><h3>الرولات</h3><span class="muted">${rolls?.length||0} رول</span></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>الرول</th><th>المحل</th><th>العدد</th><th>من</th><th>إلى</th><th>الحالة</th><th>إجراء</th></tr></thead>
        <tbody>${(rolls||[]).map(r=>`<tr>
          <td><b>${esc(r.roll_code)}</b></td>
          <td>${esc(storeName(r.store_id))}</td>
          <td>${r.quantity}</td>
          <td>${r.start_serial?`DO-ST-${String(r.start_serial).padStart(6,'0')}`:'—'}</td>
          <td>${r.end_serial?`DO-ST-${String(r.end_serial).padStart(6,'0')}`:'—'}</td>
          <td><span class="badge ${r.status==='assigned'?'green':'purple'}">${esc(r.status)}</span></td>
          <td><button class="btn btn-sm btn-blue print-roll" data-id="${r.id}">طباعة الاستكرات</button></td>
        </tr>`).join('')||'<tr><td colspan="7">لا يوجد رولات بعد</td></tr>'}</tbody>
      </table></div>
    </div>`

  qs('#rollForm').onsubmit=async e=>{
    e.preventDefault()
    const b=qs('#rollForm button')
    try{
      b.disabled=true;b.textContent='جاري الإنشاء...'
      const {data,error}=await supabase.rpc('admin_create_sticker_roll',{
        p_store_id:qs('#rollStore').value||null,
        p_quantity:Number(qs('#rollQty').value||0),
        p_note:qs('#rollNote').value.trim()||null
      })
      if(error)throw error
      const r=Array.isArray(data)?data[0]:data
      qs('#rollResult').innerHTML=`<div class="created-account">✓ تم إنشاء ${r?.sticker_count||0} استكر <strong>${esc(r?.first_sticker||'')} → ${esc(r?.last_sticker||'')}</strong><small>اطبع الرول والصقه على الأوردرات قبل استلامها.</small></div>`
      toast('تم إنشاء الرول')
    }catch(x){toast(errText(x),'error')}
    finally{b.disabled=false;b.textContent='＋ إنشاء رول'}
  }

  qsa('.print-roll').forEach(b=>b.onclick=()=>printStickerRoll(b.dataset.id))
}

async function printStickerRoll(rollId){
  const {data,error}=await supabase.from('order_stickers')
    .select('sticker_code,qr_token,store_id')
    .eq('roll_id',rollId)
    .order('serial_no',{ascending:true})
  if(error)return toast(errText(error),'error')
  if(!data?.length)return toast('لا يوجد استكرات في هذا الرول','error')

  const labels=[]
  for(const s of data){
    const qr=await QRCode.toDataURL(`DROP-OFF:${s.qr_token}`,{width:220,margin:1,errorCorrectionLevel:'M'})
    labels.push(`<div class="label">
      <div class="brandRow"><img src="${location.origin}/assets/logo.png"><div><strong>DROP OFF</strong><small>DELIVERY SERVICES</small></div></div>
      <div class="stickerNo">${esc(s.sticker_code)}</div>
      <img class="qr" src="${qr}">
      <div class="line"><span>الاسم</span></div>
      <div class="line"><span>الهاتف</span></div>
      <div class="line"><span>المنطقة</span></div>
    </div>`)
  }

  const w=window.open('','_blank','width=1000,height=800')
  if(!w)return toast('اسمح بفتح النوافذ للطباعة','error')
  w.document.write(`<!doctype html><html dir="rtl"><head><meta charset="utf-8"><title>Drop Off Stickers</title>
  <style>
    @page{size:A4;margin:7mm}*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;color:#111}
    .sheet{display:grid;grid-template-columns:repeat(3,1fr);gap:5mm}
    .label{break-inside:avoid;border:1.4px solid #111;border-radius:10px;padding:8px;text-align:center;min-height:83mm}
    .brandRow{display:flex;align-items:center;justify-content:center;gap:7px}.brandRow img{width:32px;height:32px;object-fit:contain}.brandRow strong{display:block;font-size:15px}.brandRow small{font-size:8px}
    .stickerNo{font-size:17px;font-weight:900;margin:5px 0}.qr{width:42mm;height:42mm;object-fit:contain}
    .line{height:9mm;border-bottom:1px solid #777;text-align:right;font-size:9px;padding-top:4mm}.line span{background:#fff;padding-left:4px;color:#555}
    @media print{button{display:none}}
  </style></head><body><div class="sheet">${labels.join('')}</div></body></html>`)
  w.document.close()
  setTimeout(()=>w.print(),700)
}

async function renderStoreNew(){
  const {data:links,error:lerr}=await supabase.from('store_users').select('store_id,stores(id,name)').eq('user_id',profile.id)
  if(lerr)throw lerr
  if(!links?.length){qs('#content').innerHTML='<div class="panel"><div class="empty">حسابك غير مربوط بمحل.</div></div>';return}
  const storeIds=links.map(x=>x.store_id)
  const {data:stickers,error:serr}=await supabase.from('order_stickers')
    .select('sticker_code,store_id,status')
    .in('store_id',storeIds)
    .eq('status','available')
    .order('serial_no',{ascending:true})
    .limit(20)
  if(serr)throw serr

  qs('#content').innerHTML=`
    <div class="welcome-card">
      <div><span class="eyebrow">PRE-PRINTED QR FLOW</span><h3>إضافة أوردر جديد 📦</h3><p>الصق الاستكر المطبوع على الطلب، ثم اكتب أو امسح رقمه وسجّل بيانات الزبون.</p></div>
      <div class="badge green">${stickers?.length||0}+ استكر جاهز</div>
    </div>
    <div class="panel">
      <form id="storeOrderForm" class="form-grid two">
        <div class="field"><label>رقم الاستكر</label><input id="soSticker" required placeholder="DO-ST-100001" autocomplete="off"></div>
        <div class="field"><label>اسم الزبون</label><input id="soName" required></div>
        <div class="field"><label>رقم الهاتف</label><input id="soPhone" required inputmode="tel"></div>
        <div class="field"><label>المنطقة</label><input id="soArea" required></div>
        <div class="field"><label>العنوان</label><input id="soAddress" required></div>
        <div class="field"><label>المبلغ المطلوب تحصيله</label><input id="soAmount" type="number" step=".01" min="0" value="0"></div>
        <div class="field"><label>ملاحظات</label><textarea id="soNotes" placeholder="تفاصيل إضافية"></textarea></div>
        <div class="field"><label>&nbsp;</label><button class="btn btn-primary" type="submit">✓ تسجيل الأوردر وربط الاستكر</button></div>
      </form>
      <div id="storeOrderResult"></div>
    </div>
    <div class="panel" style="margin-top:14px">
      <div class="panel-head"><h3>أول استكرات جاهزة عندك</h3><span class="muted">استخدم كل استكر مرة واحدة فقط</span></div>
      <div class="cards">${(stickers||[]).map(s=>`<div class="card"><h4>${esc(s.sticker_code)}</h4><p>${esc(stores.find(x=>x.id===s.store_id)?.name||'محل')}</p></div>`).join('')||'<div class="empty">لا يوجد استكرات متاحة. تواصل مع الإدارة لاستلام رول جديد.</div>'}</div>
    </div>`

  qs('#storeOrderForm').onsubmit=async e=>{
    e.preventDefault()
    const b=qs('#storeOrderForm button')
    try{
      b.disabled=true;b.textContent='جاري الحفظ...'
      const {data,error}=await supabase.rpc('store_create_order_with_sticker',{
        p_sticker_code:qs('#soSticker').value.trim().toUpperCase(),
        p_customer_name:qs('#soName').value.trim(),
        p_customer_phone:qs('#soPhone').value.trim(),
        p_area:qs('#soArea').value.trim(),
        p_address:qs('#soAddress').value.trim(),
        p_amount_to_collect:Number(qs('#soAmount').value||0),
        p_notes:qs('#soNotes').value.trim()||null
      })
      if(error)throw error
      const order=Array.isArray(data)?data[0]:data
      qs('#storeOrderResult').innerHTML=`<div class="created-account">✓ تم تسجيل الأوردر <strong>${esc(order?.order_code||'')}</strong><small>الاستكر صار مربوط بهذا الأوردر ولن يقبل الاستخدام مرة ثانية.</small></div>`
      toast('تمت إضافة الأوردر')
      qs('#storeOrderForm').reset()
    }catch(x){
      const map={sticker_not_found:'رقم الاستكر غير موجود',sticker_already_used:'هذا الاستكر مستخدم مسبقًا',sticker_not_assigned_to_your_store:'هذا الاستكر غير مخصص لمحلك'}
      toast(map[x?.message]||errText(x),'error')
    }finally{b.disabled=false;b.textContent='✓ تسجيل الأوردر وربط الاستكر'}
  }
}


function renderAdd(){
  if(!stores.length){qs('#content').innerHTML='<div class="panel"><div class="empty">أضف محل أولاً.</div></div>';return}
  qs('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>إضافة دفعة أوردرات</h3><span class="muted">اختَر المحل وعدد الأوردرات</span></div>
    <div class="form-grid"><div class="field"><label>المحل</label><select id="batchStore">${stores.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div><div class="field"><label>عدد الأوردرات</label><input id="batchCount" type="number" min="1" max="50" value="5"></div><div class="field"><label>&nbsp;</label><button id="buildRows" class="btn btn-blue">تجهيز الصفوف</button></div></div>
    <div id="orderRows"></div><button id="saveBatch" class="btn btn-primary">حفظ الأوردرات وإنشاء QR</button>
  </div><div id="createdQr" style="margin-top:14px"></div>`
  qs('#buildRows').onclick=buildRows
  qs('#saveBatch').onclick=saveBatch
  buildRows()
}
function buildRows(){
  const n=Math.max(1,Math.min(50,Number(qs('#batchCount').value||1)))
  qs('#orderRows').innerHTML=Array.from({length:n},(_,i)=>`<div class="order-row">
    <div class="idx">${i+1}</div>
    <input data-f="customer_name" placeholder="اسم الزبون">
    <input data-f="customer_phone" placeholder="رقم الهاتف">
    <input data-f="area" placeholder="المنطقة">
    <input data-f="address" placeholder="العنوان">
    <input data-f="amount_to_collect" type="number" min="0" step=".01" placeholder="المبلغ">
    <input data-f="notes" placeholder="ملاحظات">
  </div>`).join('')
}
async function saveBatch(){
  const store_id=qs('#batchStore').value
  const s=stores.find(x=>x.id===store_id)
  const items=[]
  for(const row of qsa('.order-row')){
    const val=f=>qs(`[data-f="${f}"]`,row).value.trim()
    const item={
      store_id,customer_name:val('customer_name'),customer_phone:val('customer_phone'),
      area:val('area'),address:val('address'),amount_to_collect:Number(val('amount_to_collect')||0),
      notes:val('notes')||null,status:'in_warehouse',delivery_fee:Number(s?.delivery_fee||0),
      return_fee:Number(s?.return_fee||0),created_by:profile.id
    }
    if(!item.customer_name||!item.customer_phone||!item.area||!item.address){
      return toast('كمّل البيانات الأساسية لكل الأوردرات','error')
    }
    items.push(item)
  }
  const {data:batch,error:bErr}=await supabase.from('order_batches').insert({store_id,expected_count:items.length,created_by:profile.id}).select().single()
  if(bErr)return toast(errText(bErr),'error')
  items.forEach(x=>x.batch_id=batch.id)
  const {data,error}=await supabase.from('orders').insert(items).select('*')
  if(error)return toast(errText(error),'error')
  toast(`تم حفظ ${data.length} أوردر`)
  qs('#createdQr').innerHTML=`<div class="panel"><div class="panel-head"><h3>QR للأوردرات الجديدة</h3></div><div class="cards">${data.map(o=>`<div class="card qr-card"><h4>${esc(o.order_code)}</h4><p>${esc(o.customer_name)} — ${money(o.amount_to_collect)}</p><button class="btn btn-blue print-qr" data-id="${o.id}">فتح/طباعة QR</button></div>`).join('')}</div></div>`
  qsa('.print-qr').forEach(b=>b.onclick=()=>printQr(data.find(x=>x.id===b.dataset.id)))
}

async function printQr(o){
  const payload=`${location.origin}/admin?order=${encodeURIComponent(o.order_code)}`
  const dataUrl=await QRCode.toDataURL(payload,{width:300,margin:1,errorCorrectionLevel:'M'})
  const w=window.open('','_blank','width=450,height=650')
  w.document.write(`<html dir="rtl"><head><title>${esc(o.order_code)}</title><style>body{font-family:Arial;display:grid;place-items:center;padding:20px}.label{width:320px;border:1px solid #222;border-radius:14px;padding:16px;text-align:center}.label img{width:220px}.brand{font-size:26px;font-weight:900}.price{font-size:22px;font-weight:900}</style></head><body><div class="label"><div class="brand">DROP OFF</div><div>${esc(o.order_code)}</div><img src="${dataUrl}"><h3>${esc(storeName(o.store_id))}</h3><div>${esc(o.customer_name)} · ${esc(o.customer_phone)}</div><div>${esc(o.area)} — ${esc(o.address)}</div><div class="price">${money(o.amount_to_collect)}</div></div></body></html>`)
  w.document.close()
  setTimeout(()=>w.print(),400)
}

async function renderOrders(){
  qs('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>كل الأوردرات</h3><div class="toolbar"><input id="searchOrder" placeholder="بحث رقم أوردر / هاتف / منطقة"><select id="statusFilter"><option value="">كل الحالات</option>${Object.entries(statusLabels).map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select><button id="doSearch" class="btn btn-blue">بحث</button></div></div><div id="ordersOut"></div></div>`
  qs('#doSearch').onclick=loadOrders
  qs('#statusFilter').onchange=loadOrders
  qs('#searchOrder').onkeydown=e=>{if(e.key==='Enter')loadOrders()}
  const incoming=new URLSearchParams(location.search).get('order')
  if(incoming)qs('#searchOrder').value=incoming
  await loadOrders()
}
async function loadOrders(){
  let q=supabase.from('orders').select('*').order('created_at',{ascending:false}).limit(500)
  const st=qs('#statusFilter').value.trim(),s=qs('#searchOrder').value.trim()
  if(st)q=q.eq('status',st)
  if(s){
    if(s.toUpperCase().startsWith('DO-'))q=q.ilike('order_code',`%${s}%`)
    else q=q.or(`customer_phone.ilike.%${s}%,area.ilike.%${s}%,customer_name.ilike.%${s}%`)
  }
  const {data,error}=await q
  if(error)throw error
  qs('#ordersOut').innerHTML=orderTable(data||[],true)
  qsa('.qr-btn').forEach(b=>b.onclick=()=>printQr(data.find(x=>x.id===b.dataset.id)))
}

async function renderAssign(){
  await loadCommon()
  const {data:orders,error}=await supabase.from('orders').select('*').in('status',['in_warehouse','new']).order('created_at',{ascending:true})
  if(error)throw error
  const delivery=captains.filter(c=>c.active && ['delivery','both'].includes(c.captain_type))
  const pickup=captains.filter(c=>c.active && ['pickup','both'].includes(c.captain_type))
  qs('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>توزيع أوردرات التوصيل</h3><span class="muted">${orders.length} أوردر جاهز</span></div>
    <div class="form-grid"><div class="field"><label>كابتن التوصيل</label><select id="deliveryCaptain">${delivery.map(c=>`<option value="${c.id}">${esc(c.profiles?.full_name||c.profiles?.phone||c.id)}</option>`).join('')}</select></div><div class="field"><label>&nbsp;</label><button id="assignSelected" class="btn btn-primary">توزيع المحدد</button></div></div>
    <div class="table-wrap"><table class="table"><thead><tr><th>تحديد</th><th>الأوردر</th><th>المحل</th><th>المنطقة</th><th>المبلغ</th></tr></thead><tbody>${orders.map(o=>`<tr><td><input class="check assign-check" type="checkbox" value="${o.id}"></td><td>${esc(o.order_code)}</td><td>${esc(storeName(o.store_id))}</td><td>${esc(o.area)}</td><td>${money(o.amount_to_collect)}</td></tr>`).join('')||'<tr><td colspan="5">لا يوجد أوردرات جاهزة</td></tr>'}</tbody></table></div>
  </div>
  <div class="panel" style="margin-top:14px"><div class="panel-head"><h3>توزيع جلب من المحلات</h3><span class="muted">اختياري</span></div>
    <div class="form-grid"><div class="field"><label>كابتن الجلب</label><select id="pickupCaptain">${pickup.map(c=>`<option value="${c.id}">${esc(c.profiles?.full_name||c.profiles?.phone||c.id)}</option>`).join('')}</select></div><div class="field"><label>رقم الأوردر</label><input id="pickupOrder" placeholder="DO-000001"></div><div class="field"><label>&nbsp;</label><button id="assignPickup" class="btn btn-blue">تعيين للجلب</button></div></div>
  </div>`
  qs('#assignSelected').onclick=async()=>{
    const ids=qsa('.assign-check:checked').map(x=>x.value),captain_id=qs('#deliveryCaptain').value
    if(!ids.length)return toast('حدد أوردر واحد على الأقل','error')
    if(!captain_id)return toast('اختر كابتن','error')
    for(const id of ids){
      const r=await supabase.rpc('staff_assign_order',{p_order_id:id,p_captain_id:captain_id})
      if(r.error)return toast(errText(r.error),'error')
    }
    toast(`تم توزيع ${ids.length} أوردر`)
    renderAssign()
  }
  qs('#assignPickup').onclick=async()=>{
    const code=qs('#pickupOrder').value.trim(),captain_id=qs('#pickupCaptain').value
    if(!code||!captain_id)return toast('اختر الكابتن واكتب رقم الأوردر','error')
    const {data:o,error}=await supabase.from('orders').select('id').eq('order_code',code).maybeSingle()
    if(error||!o)return toast('الأوردر غير موجود','error')
    const r=await supabase.rpc('staff_assign_pickup_order',{p_order_id:o.id,p_captain_id:captain_id})
    if(r.error)return toast(errText(r.error),'error')
    toast('تم تعيين كابتن الجلب')
  }
}

async function renderStores(){
  await loadCommon()
  qs('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>إضافة محل</h3></div><form id="storeForm" class="form-grid two">
    <div class="field"><label>اسم المحل</label><input id="stName" required></div>
    <div class="field"><label>الهاتف</label><input id="stPhone"></div>
    <div class="field"><label>العنوان</label><input id="stAddress"></div>
    <div class="field"><label>رسوم التوصيل</label><input id="stDelivery" type="number" min="0" step=".01" value="0"></div>
    <div class="field"><label>رسوم المرتجع</label><input id="stReturn" type="number" min="0" step=".01" value="0"></div>
    <div class="field"><label>&nbsp;</label><button class="btn btn-primary" type="submit">＋ إضافة المحل</button></div>
  </form></div>
  <div class="panel" style="margin-top:14px"><div class="panel-head"><h3>المحلات</h3><span class="muted">${stores.length} محل</span></div><div class="cards">${stores.map(s=>`<div class="card"><h4>${esc(s.name)}</h4><p>${esc(s.phone||'—')}</p><p>${esc(s.address||'—')}</p><p>توصيل: ${money(s.delivery_fee)} · مرتجع: ${money(s.return_fee)}</p></div>`).join('')||'<div class="empty">لا يوجد محلات</div>'}</div></div>`
  qs('#storeForm').onsubmit=async e=>{
    e.preventDefault()
    const body={name:qs('#stName').value.trim(),phone:qs('#stPhone').value.trim()||null,address:qs('#stAddress').value.trim()||null,delivery_fee:Number(qs('#stDelivery').value||0),return_fee:Number(qs('#stReturn').value||0),active:true}
    const {error}=await supabase.from('stores').insert(body)
    if(error)return toast(errText(error),'error')
    toast('تمت إضافة المحل');await loadCommon();renderStores()
  }
}

async function renderUsers(){
  await loadCommon()
  const rows=profiles.filter(p=>p.id!==profile.id)
  qs('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>إنشاء حساب جديد</h3><span class="muted">من الإدارة فقط</span></div>
    <form id="userForm" class="form-grid two">
      <div class="field"><label>الاسم الكامل</label><input id="uName" required></div>
      <div class="field"><label>نوع الحساب</label><select id="uRole"><option value="delivery_captain">كابتن توصيل</option><option value="pickup_captain">كابتن جلب</option><option value="store_owner">صاحب محل</option></select></div>
      <div class="field"><label>طريقة الدخول</label><select id="uType"><option value="phone">رقم هاتف</option><option value="username">اسم مستخدم</option></select></div>
      <div class="field"><label id="uLoginLabel">رقم الهاتف</label><input id="uLogin" required placeholder="0791234567"></div>
      <div class="field"><label>كلمة السر</label><input id="uPassword" type="password" minlength="6" required></div>
      <div class="field hidden" id="uStoreWrap"><label>المحل</label><select id="uStore"><option value="">اختر المحل</option>${stores.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
      <div class="field"><label>&nbsp;</label><button class="btn btn-primary" type="submit">＋ إنشاء الحساب</button></div>
    </form><div id="createdUser"></div>
  </div>
  <div class="panel" style="margin-top:14px"><div class="panel-head"><h3>الحسابات الموجودة</h3><span class="muted">${rows.length} حساب</span></div><div class="table-wrap"><table class="table"><thead><tr><th>الاسم</th><th>الدخول</th><th>النوع</th><th>الحالة</th><th>إدارة</th></tr></thead><tbody>${rows.map(p=>`<tr><td><b>${esc(p.full_name||'—')}</b></td><td>${esc(p.phone||p.username||'—')}</td><td>${esc(roleLabels[p.role]||p.role)}</td><td><span class="badge ${p.active?'green':'red'}">${p.active?'فعال':'موقوف'}</span></td><td><button class="btn btn-sm btn-blue manage-user" data-id="${p.id}">إدارة</button></td></tr>`).join('')||'<tr><td colspan="5">لا يوجد حسابات</td></tr>'}</tbody></table></div></div>`
  const role=qs('#uRole'),type=qs('#uType')
  const sync=()=>{qs('#uStoreWrap').classList.toggle('hidden',role.value!=='store_owner');const ph=type.value==='phone';qs('#uLoginLabel').textContent=ph?'رقم الهاتف':'اسم المستخدم';qs('#uLogin').placeholder=ph?'0791234567':'captain01'}
  role.onchange=sync;type.onchange=sync;sync()
  qs('#userForm').onsubmit=async e=>{
    e.preventDefault()
    const b=qs('#userForm button')
    const body={full_name:qs('#uName').value.trim(),role:role.value,login_type:type.value,login_value:qs('#uLogin').value.trim(),password:qs('#uPassword').value,store_id:role.value==='store_owner'?qs('#uStore').value:null}
    if(body.role==='store_owner'&&!body.store_id)return toast('اختر المحل','error')
    try{
      b.disabled=true;b.textContent='جاري الإنشاء...'
      const {data,error}=await supabase.functions.invoke('admin-create-user',{body})
      if(error)throw error
      if(data?.error)throw new Error(data.error==='login_exists'?'رقم الهاتف أو اسم المستخدم مستخدم مسبقًا':data.error)
      qs('#createdUser').innerHTML=`<div class="created-account">✓ تم إنشاء الحساب <strong>${esc(data.login||body.login_value)}</strong><small>كلمة السر هي التي أدخلتها أنت.</small></div>`
      toast('تم إنشاء الحساب');await loadCommon()
    }catch(x){toast(errText(x),'error')}
    finally{b.disabled=false;b.textContent='＋ إنشاء الحساب'}
  }
  qsa('.manage-user').forEach(b=>b.onclick=()=>manageUser(rows.find(x=>x.id===b.dataset.id)))
}
function manageUser(u){
  const login=u.phone||u.username||'—'
  qs('#content').innerHTML=`<div class="panel"><div class="panel-head"><div><h3>${esc(u.full_name||login)}</h3><span class="muted">${esc(login)} · ${esc(roleLabels[u.role]||u.role)}</span></div><button id="backUsers" class="btn btn-ghost">رجوع</button></div><div class="cards">
    <div class="card"><h4>حالة الحساب</h4><p>${u.active?'فعال':'موقوف'}</p><button id="toggleUser" class="btn ${u.active?'btn-red':'btn-green'}">${u.active?'إيقاف الحساب':'تشغيل الحساب'}</button></div>
    <div class="card"><h4>تغيير كلمة السر</h4><div class="field"><input id="newPassword" type="password" minlength="6" placeholder="كلمة سر جديدة"></div><button id="savePassword" class="btn btn-blue">حفظ كلمة السر</button></div>
    <div class="card"><h4>الدخول</h4><p><b>${esc(login)}</b></p><p class="muted">${u.login_type==='phone'?'رقم هاتف':'اسم مستخدم'}</p></div>
  </div></div>`
  qs('#backUsers').onclick=renderUsers
  qs('#toggleUser').onclick=async()=>{
    const {data,error}=await supabase.functions.invoke('admin-update-user',{body:{user_id:u.id,active:!u.active}})
    if(error||data?.error)return toast(errText(error||data?.error),'error')
    toast('تم تحديث الحساب');await loadCommon();renderUsers()
  }
  qs('#savePassword').onclick=async()=>{
    const password=qs('#newPassword').value
    if(password.length<6)return toast('كلمة السر لازم تكون 6 أحرف أو أرقام على الأقل','error')
    const {data,error}=await supabase.functions.invoke('admin-update-user',{body:{user_id:u.id,password}})
    if(error||data?.error)return toast(errText(error||data?.error),'error')
    toast('تم تغيير كلمة السر');qs('#newPassword').value=''
  }
}

async function renderAccounts(){
  const [{data:sb,error:e1},{data:cb,error:e2}] = await Promise.all([
    supabase.from('store_balance_summary').select('*').order('store_name'),
    supabase.from('captain_cash_summary').select('*')
  ])
  if(e1)throw e1;if(e2)throw e2
  qs('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>حسابات المحلات</h3></div><div class="cards">${(sb||[]).map(x=>`<div class="card"><h4>${esc(x.store_name)}</h4><p>تم التسليم: ${x.delivered_orders||0} · مرتجع: ${x.returned_orders||0}</p><p>تحصيلات: ${money(x.collections)}</p><p>رسوم: ${money(Number(x.delivery_fees||0)+Number(x.return_fees||0))}</p><p>تم الدفع: ${money(x.paid_out)}</p><div class="money">${money(x.balance_due)}</div><button class="btn btn-sm btn-green settle-store" data-id="${x.store_id}">تسجيل دفعة</button></div>`).join('')||'<div class="empty">لا توجد بيانات</div>'}</div></div>
  <div class="panel" style="margin-top:14px"><div class="panel-head"><h3>عهدة الكباتن</h3></div><div class="cards">${(cb||[]).map(x=>`<div class="card"><h4>${esc(x.full_name||'كابتن')}</h4><p>تحصيل: ${money(x.cash_collected)}</p><p>سلّم: ${money(x.cash_handed_over)}</p><div class="money">${money(x.cash_due)}</div><button class="btn btn-sm btn-blue handover" data-id="${x.captain_id}">تسجيل تسليم كاش</button></div>`).join('')||'<div class="empty">لا يوجد كباتن</div>'}</div></div>`
  qsa('.settle-store').forEach(b=>b.onclick=()=>amountPrompt('مبلغ الدفعة للمحل',async amount=>supabase.from('store_settlements').insert({store_id:b.dataset.id,amount,created_by:profile.id})))
  qsa('.handover').forEach(b=>b.onclick=()=>amountPrompt('المبلغ الذي سلّمه الكابتن',async amount=>supabase.from('captain_handovers').insert({captain_id:b.dataset.id,amount,created_by:profile.id})))
}
function amountPrompt(label,fn){
  const v=prompt(label);if(v===null)return
  const amount=Number(v);if(!(amount>0))return toast('المبلغ غير صحيح','error')
  fn(amount).then(r=>{if(r.error)toast(errText(r.error),'error');else{toast('تم التسجيل');renderAccounts()}})
}

async function renderCaptain(){
  const pickup=profile.role==='pickup_captain'
  let q=supabase.from('orders').select('*').order('created_at',{ascending:false})
  q=pickup?q.eq('pickup_captain_id',profile.id):q.eq('delivery_captain_id',profile.id)
  if(!pickup)q=q.not('status','in','("delivered","returned_store","cancelled")')
  const {data,error}=await q
  if(error)throw error
  qs('#content').innerHTML=`<div class="captain-header"><div><span class="eyebrow">${pickup?'PICKUP CAPTAIN':'DELIVERY CAPTAIN'}</span><h3>مرحباً ${esc(profile.full_name||'كابتن')} 👋</h3></div><span class="badge blue">${data.length} أوردر</span></div>
  <div>${!data.length?'<div class="panel"><div class="empty fancy-empty">🛵<strong>ما عندك أوردرات حالياً</strong><span>الأوردرات الجديدة تظهر هون.</span></div></div>':data.map(o=>{
    const wp=normalizeJordanPhone(o.customer_phone||'').replace(/\D/g,'')
    return `<div class="captain-order"><div class="head"><div><h4>${esc(o.order_code)} — ${esc(o.area)}</h4><p>${esc(o.customer_name)} | ${esc(o.customer_phone)}</p><p>${esc(o.address)}</p><p class="muted">${esc(o.notes||'')}</p></div><div class="price">${money(o.amount_to_collect)}</div></div><div class="quick">
      <a class="btn btn-sm btn-blue" href="tel:${esc(o.customer_phone)}">📞 اتصال</a><a class="btn btn-sm btn-green" href="https://wa.me/${wp}" target="_blank">واتساب</a><a class="btn btn-sm btn-ghost" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((o.address||'')+' '+(o.area||''))}" target="_blank">📍 خريطة</a>
      ${pickup?`<button class="btn btn-sm btn-primary pickup-received" data-id="${o.id}">وصل للمخزن</button>`:`<button class="btn btn-sm btn-primary cap-status" data-id="${o.id}" data-st="delivered">تم التسليم</button><button class="btn btn-sm btn-ghost cap-status" data-id="${o.id}" data-st="out_for_delivery">بالطريق</button><button class="btn btn-sm btn-ghost cap-status" data-id="${o.id}" data-st="postponed">مؤجل</button><button class="btn btn-sm btn-ghost cap-status" data-id="${o.id}" data-st="no_answer">لا يرد</button><button class="btn btn-sm btn-red cap-status" data-id="${o.id}" data-st="returned_warehouse">إرجاع للمخزن</button>`}
    </div></div>`}).join('')}</div>`
  qsa('.cap-status').forEach(b=>b.onclick=async()=>{const r=await supabase.rpc('captain_set_order_status',{p_order_id:b.dataset.id,p_status:b.dataset.st,p_note:null});if(r.error)return toast(errText(r.error),'error');toast('تم تحديث الحالة');renderCaptain()})
  qsa('.pickup-received').forEach(b=>b.onclick=async()=>{const r=await supabase.rpc('pickup_confirm_warehouse',{p_order_id:b.dataset.id});if(r.error)return toast(errText(r.error),'error');toast('تم تأكيد وصول الأوردر للمخزن');renderCaptain()})
}

async function renderOwner(){
  const {data:links,error:lerr}=await supabase.from('store_users').select('store_id,stores(id,name)').eq('user_id',profile.id)
  if(lerr)throw lerr
  if(!links?.length){qs('#content').innerHTML='<div class="panel"><div class="empty">الحساب غير مربوط بمحل بعد. تواصل مع الإدارة.</div></div>';return}
  const ids=links.map(x=>x.store_id)
  const [{data:bal},{data:orders,error}] = await Promise.all([
    supabase.from('store_balance_summary').select('*').in('store_id',ids),
    supabase.from('orders').select('*').in('store_id',ids).order('created_at',{ascending:false}).limit(500)
  ])
  if(error)throw error
  const collections=(bal||[]).reduce((a,x)=>a+Number(x.collections||0),0)
  const fees=(bal||[]).reduce((a,x)=>a+Number(x.delivery_fees||0)+Number(x.return_fees||0),0)
  const balance=(bal||[]).reduce((a,x)=>a+Number(x.balance_due||0),0)
  qs('#content').innerHTML=`<div class="owner-summary">${stat('إجمالي الأوردرات',orders.length)}${stat('تم التسليم',orders.filter(o=>o.status==='delivered').length)}${stat('مرتجع',orders.filter(o=>o.status==='returned_store'||o.status==='returned_warehouse').length)}<div class="stat"><span>المبلغ المستحق</span><b>${money(balance)}</b></div></div>
  <div class="finance-strip"><span>التحصيلات</span><strong>${money(collections)}</strong><span>الرسوم ${money(fees)}</span></div>
  <div class="panel"><div class="panel-head"><h3>أوردرات المحل</h3></div>${orderTable(orders)}</div>`
}

init().catch(e=>{
  app.innerHTML=`<div class="auth-wrap"><div class="auth-card"><h2>خطأ تشغيل</h2><p>${esc(errText(e))}</p></div></div>`
})
