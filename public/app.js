import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm'
import QRCode from 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm'
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js'

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY,{
  auth:{
    // Each portal owns its persisted session and cross-tab auth channel.
    storageKey:`dropoff-${new URL(SUPABASE_URL).hostname}-${portal()}-auth`,
    persistSession:true,
    autoRefreshToken:true,
    detectSessionInUrl:false,
    storage:window.localStorage
  }
})
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
const storeCategoryOptions = [
  'ملابس','أحذية وحقائب','ورد وهدايا','مطاعم','حلويات','إلكترونيات',
  'مستحضرات تجميل','صيدلية','مواد غذائية','أثاث ومنزل','مكتبة وقرطاسية','خدمات'
]
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
  document.body.dataset.portal=portal()
  if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{})
  const {data:{session:s}}=await supabase.auth.getSession()
  session=s
  supabase.auth.onAuthStateChange((_event,s2)=>{
    session=s2
    // Run Supabase calls after the auth callback releases its session lock.
    setTimeout(()=>boot().catch(e=>toast(errText(e),'error')),0)
  })
  await boot()
}

async function boot(){
  if(!session){profile=null;renderAuth();return}
  const {data,error}=await supabase.from('profiles').select('*').eq('id',session.user.id).single()
  if(error || !data){await supabase.auth.signOut({scope:'local'});renderAuth();return}
  profile=data
  if(!profile.active){await supabase.auth.signOut({scope:'local'});toast('هذا الحساب موقوف','error');renderAuth();return}
  const p=portal()
  if(!portalMeta[p].roles.includes(profile.role)){
    await supabase.auth.signOut({scope:'local'})
    app.innerHTML=`<div class="auth-wrap"><div class="auth-card"><div class="brand"><div class="logo-shell"><img src="/assets/logo-transparent.png"></div><h1>Drop Off</h1></div><p style="text-align:center">هذا الحساب لا يملك صلاحية الدخول إلى ${portalMeta[p].title}.</p><button id="backLogin" class="btn btn-primary full">رجوع</button></div></div>`
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
  const portalLine=p==='admin'?'تحكم كامل بالطلبات والمحلات والكباتن':p==='captain'?'طلباتك ومسارك وحسابك في شاشة واحدة':'تابع طلبات محلك وحساباتك بسهولة'
  app.innerHTML=`<div class="auth-wrap">
    <div class="auth-glow auth-glow-one"></div><div class="auth-glow auth-glow-two"></div>
    <div class="auth-layout">
      <section class="auth-showcase">
        <div class="auth-logo"><img src="/assets/logo-transparent.png" alt="Drop Off"></div>
        <div class="auth-showcase-copy"><span class="eyebrow">DROP OFF MANAGEMENT</span><h1>توصيل منظم.<br><em>إدارة أسرع.</em></h1><p>${portalLine}</p></div>
        <div class="auth-points"><span>✓ متابعة مباشرة</span><span>✓ حسابات دقيقة</span><span>✓ دخول آمن</span></div>
        <div class="auth-mark">DO <small>DELIVERY SERVICES</small></div>
      </section>
      <section class="auth-card">
        <div class="auth-form-head"><span class="portal-pill">${m.title}</span><h2>أهلاً بعودتك</h2><p>أدخل بيانات حسابك للمتابعة</p></div>
        <form id="loginForm">
          <div class="field auth-field"><label>${lab}</label><div class="input-shell"><span class="field-icon">@</span><input id="loginId" autocomplete="username" required placeholder="${ph}"></div></div>
          <div class="field auth-field"><label>كلمة السر</label><div class="input-shell"><span class="field-icon">●</span><input id="loginPassword" type="password" minlength="6" autocomplete="current-password" required placeholder="••••••••"><button id="togglePassword" class="password-toggle" type="button" aria-label="إظهار كلمة السر">إظهار</button></div></div>
          <div class="session-note"><span class="session-check">✓</span><span>سيبقى حسابك مسجلاً على هذا الجهاز</span></div>
          <button class="btn btn-primary auth-submit full" type="submit"><span>دخول إلى النظام</span><b>←</b></button>
        </form>
        <div class="login-foot"><span>حسابات معتمدة من الإدارة فقط</span><i></i><span>Drop Off © 2026</span></div>
      </section>
    </div>
  </div>`
  qs('#togglePassword').onclick=()=>{
    const input=qs('#loginPassword'),button=qs('#togglePassword'),show=input.type==='password'
    input.type=show?'text':'password';button.textContent=show?'إخفاء':'إظهار';button.setAttribute('aria-label',show?'إخفاء كلمة السر':'إظهار كلمة السر')
  }
  qs('#loginForm').onsubmit=async e=>{
    e.preventDefault()
    const b=qs('#loginForm button[type="submit"]')
    const old=b.innerHTML
    try{
      b.disabled=true;b.textContent='جاري التحقق...'
      await login(qs('#loginId').value,qs('#loginPassword').value)
    }catch(x){
      toast(errText(x),'error');b.disabled=false;b.innerHTML=old
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
    ['home','⌂ الرئيسية'],['stickers','🏷️ طباعة الملصقات'],['add','＋ إضافة أوردرات'],['orders','▦ الأوردرات'],
    ['assign','⇄ التوزيع'],['operations','📦 العمليات'],['stores','🏪 المحلات'],['users','👥 الحسابات'],['accounts','💰 المالية']
  ]
  if(profile.role==='store_owner')return [['store_new','＋ إضافة أوردر'],['owner','▦ طلباتي وحسابي']]
  return [['captain','▦ أوردراتي']]
}
function renderShell(){
  app.innerHTML=`<div class="shell"><aside class="sidebar">
    <div class="side-brand"><img src="/assets/logo-transparent.png"><div><strong>Drop Off</strong><small>${esc(roleLabels[profile.role]||profile.role)}</small></div><span class="live-dot"></span></div>
    <div id="nav" class="nav">${navItems().map(([id,label])=>`<button data-tab="${id}">${label}</button>`).join('')}</div>
    <div class="side-foot"><div class="user-pill">${esc(profile.full_name||profile.username||profile.phone||'مستخدم')}<small>${esc(profile.phone||profile.username||'')}</small></div><button id="logout" class="btn btn-ghost full">تسجيل خروج</button></div>
  </aside><main class="main">
    <div class="topbar"><div class="mobile-brand"><img src="/assets/logo-transparent.png" alt="Drop Off"><span>Drop Off</span></div><div><h2 id="pageTitle">Drop Off</h2><div id="pageSub" class="muted"></div></div><div class="actions"><button id="refresh" class="btn btn-ghost mobile-action" aria-label="تحديث">↻ <span>تحديث</span></button><button id="mobileLogout" class="btn btn-ghost mobile-action mobile-logout" aria-label="تسجيل خروج" title="تسجيل خروج">⇥</button><button id="mobileMenu" class="btn btn-ghost mobile-action mobile-menu" aria-label="فتح القائمة" aria-controls="nav" aria-expanded="false">☰</button></div></div>
    <section id="content"></section>
  </main></div>`
  const menu=qs('#mobileMenu'),nav=qs('#nav')
  const closeMenu=()=>{nav.classList.remove('open');menu.setAttribute('aria-expanded','false');menu.setAttribute('aria-label','فتح القائمة');document.body.classList.remove('menu-open')}
  qsa('#nav button').forEach(b=>b.onclick=()=>{closeMenu();openTab(b.dataset.tab)})
  menu.onclick=()=>{const open=nav.classList.toggle('open');menu.setAttribute('aria-expanded',String(open));menu.setAttribute('aria-label',open?'إغلاق القائمة':'فتح القائمة');document.body.classList.toggle('menu-open',open)}
  qs('#logout').onclick=qs('#mobileLogout').onclick=()=>supabase.auth.signOut({scope:'local'})
  qs('#refresh').onclick=()=>openTab(currentTab,true)
}
async function openTab(tab,force=false){
  currentTab=tab
  qsa('#nav button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab))
  const titles={home:'لوحة الإدارة',stickers:'طباعة ملصقات الطلبات',store_new:'إضافة أوردر',add:'إضافة أوردرات',orders:'إدارة الأوردرات',assign:'توزيع الأوردرات',operations:'العمليات اليومية',stores:'المحلات',users:'الحسابات والصلاحيات',accounts:'الحسابات والتسويات',captain:'أوردرات الكابتن',owner:'حساب المحل'}
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
    if(tab==='operations')return renderOperations()
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
function categoryPicker(prefix,selected=[]){
  const chosen=new Set(selected||[])
  return `<div class="category-picker">${storeCategoryOptions.map((name,i)=>`<label><input class="${prefix}-category" type="checkbox" value="${esc(name)}" ${chosen.has(name)?'checked':''}><span>${esc(name)}</span></label>`).join('')}</div>
    <input id="${prefix}CategoryCustom" placeholder="نوع إضافي، ويمكن فصل أكثر من نوع بفاصلة">`
}
function selectedCategories(prefix){
  const preset=qsa(`.${prefix}-category:checked`).map(x=>x.value.trim())
  const custom=(qs(`#${prefix}CategoryCustom`)?.value||'').split(/[,،]/).map(x=>x.trim()).filter(Boolean)
  return [...new Set([...preset,...custom])].slice(0,12)
}
function categoryBadges(categories){
  return (categories||[]).map(x=>`<span class="badge orange">${esc(x)}</span>`).join(' ') || '<span class="muted">النوع غير محدد</span>'
}

async function renderHome(){
  const {data:o,error}=await supabase.from('orders').select('id,status,amount_to_collect,created_at,promised_at,store_id,delivery_captain_id,payment_type')
  if(error)throw error
  const count=s=>o.filter(x=>x.status===s).length
  const d=new Date();d.setHours(0,0,0,0)
  const today=o.filter(x=>new Date(x.created_at)>=d).length
  const delivered=o.filter(x=>x.status==='delivered'&&x.payment_type!=='prepaid').reduce((a,x)=>a+Number(x.amount_to_collect||0),0)
  const overdue=o.filter(x=>x.promised_at&&new Date(x.promised_at)<new Date()&&!['delivered','returned_store','cancelled'].includes(x.status))
  const weekly=o.filter(x=>new Date(x.created_at)>=new Date(Date.now()-7*86400000))
  const byStore=stores.map(s=>({name:s.name,count:weekly.filter(x=>x.store_id===s.id).length})).sort((a,b)=>b.count-a.count)
  qs('#content').innerHTML=`
    <div class="welcome-card"><div><span class="eyebrow">DROP OFF CONTROL CENTER</span><h3>أهلاً ${esc(profile.full_name||'بالإدارة')} 👋</h3><p>الأوردرات والمخزن والكباتن والحسابات بمكان واحد.</p></div><div class="quick-actions"><button class="btn btn-primary go" data-tab="add">＋ أوردر جديد</button><button class="btn btn-ghost go" data-tab="assign">توزيع الأوردرات</button></div></div>
    <div class="grid stats">${stat('إجمالي الأوردرات',o.length)}${stat('أوردرات اليوم',today)}${stat('بالمخزن',count('in_warehouse'))}${stat('مع الكباتن',count('assigned')+count('out_for_delivery'))}${stat('تم التسليم',count('delivered'))}${stat('متأخرة وتحتاج متابعة',overdue.length)}</div>
    <div class="finance-strip"><span>قيمة التحصيلات المسلّمة</span><strong>${money(delivered)}</strong><span class="mini-status">● النظام متصل</span></div>
    <div class="panel"><div class="panel-head"><h3>آخر الأوردرات</h3><button class="btn btn-ghost go" data-tab="orders">عرض الكل</button></div><div id="latest"></div></div>
    <div class="panel" style="margin-top:14px"><div class="panel-head"><h3>نشاط المحلات آخر 7 أيام</h3></div><div class="cards">${byStore.map(s=>`<div class="card"><h4>${esc(s.name)}</h4><div class="money">${s.count} طلب</div></div>`).join('')||'<div class="empty">لا يوجد محلات</div>'}</div></div>`
  qsa('.go').forEach(b=>b.onclick=()=>openTab(b.dataset.tab))
  const {data}=await supabase.from('orders').select('*').order('created_at',{ascending:false}).limit(10)
  qs('#latest').innerHTML=orderTable(data||[])
}

function orderTable(rows,actions=false){
  if(!rows.length)return '<div class="empty">لا يوجد نتائج.</div>'
  return `<div class="table-wrap"><table class="table"><thead><tr>
    <th>الأوردر</th><th>المحل</th><th>الزبون</th><th>الهاتف</th><th>المنطقة</th><th>المبلغ</th><th>الحالة</th><th>الكابتن</th>${actions?'<th>إجراءات</th>':''}
  </tr></thead><tbody>${rows.map(o=>`<tr>
    <td><b>${esc(o.order_code)}</b>${o.priority==='urgent'?' <span class="badge red">مستعجل</span>':''}<small style="display:block">${o.parcel_count||1} قطعة · ${o.payment_type==='prepaid'?'مدفوع':'تحصيل'}${o.shelf_location?' · رف '+esc(o.shelf_location):''}</small></td><td>${esc(storeName(o.store_id))}</td><td>${esc(o.customer_name)}</td><td>${esc(o.customer_phone)}</td><td>${esc(o.area)}</td><td>${money(o.amount_to_collect)}</td>
    <td><span class="badge ${statusClass(o.status)}">${esc(statusLabels[o.status]||o.status)}</span></td><td>${esc(captainName(o.delivery_captain_id))}</td>
    ${actions===true?`<td><button class="btn btn-sm btn-blue qr-btn" data-id="${o.id}">طباعة QR</button> <button class="btn btn-sm btn-ghost edit-order" data-id="${o.id}">تفاصيل</button></td>`:actions==='store'?`<td><button class="btn btn-sm btn-ghost store-detail" data-id="${o.id}">تفاصيل وQR</button></td>`:''}
  </tr>`).join('')}</tbody></table></div>`
}


async function renderStickers(){
  await loadCommon()
  const {data,error}=await supabase.from('orders').select('*').order('created_at',{ascending:false}).limit(500)
  if(error)throw error
  const orders=data||[]
  qs('#content').innerHTML=`<div class="welcome-card"><div><span class="eyebrow">DROP OFF LABELS</span><h3>ملصقات الطلبات 📦</h3><p>المحل يسجل البيانات؛ هنا اطبع رقم الطلب وQR والتفاصيل، ثم الصق الملصق على الكيس.</p></div></div>
    <div class="panel"><div class="panel-head"><h3>الطلبات الأخيرة</h3><span class="muted">تظهر آخر 500 هنا؛ زر طباعة الكل يجلب جميع الطلبات، ويطبق فلتر المحل والبحث</span></div>
      <div class="toolbar" style="margin-bottom:12px"><select id="labelStore"><option value="">كل المحلات</option>${stores.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select><input id="labelSearch" placeholder="ابحث برقم الطلب أو اسم الزبون أو الهاتف"><button id="printSelected" class="btn btn-blue">طباعة المحدد</button><button id="printAllLabels" class="btn btn-primary">طباعة كل الأكواد دفعة واحدة</button></div>
      <div id="labelOrders"></div>
    </div>`
  const draw=()=>{
    const storeId=qs('#labelStore').value,search=qs('#labelSearch').value.trim().toLowerCase()
    const shown=orders.filter(o=>(!storeId||o.store_id===storeId)&&(!search||[o.order_code,o.customer_name,o.customer_phone].some(v=>String(v||'').toLowerCase().includes(search))))
    qs('#labelOrders').innerHTML=`<div class="table-wrap"><table class="table"><thead><tr><th>تحديد</th><th>رقم الطلب</th><th>المحل</th><th>الزبون</th><th>المنطقة</th><th>الحالة</th><th>طباعة</th></tr></thead><tbody>${shown.map(o=>`<tr><td><input type="checkbox" class="check label-check" value="${o.id}" aria-label="تحديد ${esc(o.order_code)}"></td><td><strong>${esc(o.order_code)}</strong></td><td>${esc(storeName(o.store_id))}</td><td>${esc(o.customer_name)}</td><td>${esc(o.area)}</td><td>${esc(statusLabels[o.status]||o.status)}</td><td><button class="btn btn-sm btn-blue label-print" data-id="${o.id}">طباعة الملصق</button></td></tr>`).join('')||'<tr><td colspan="7">لا توجد طلبات مطابقة</td></tr>'}</tbody></table></div>`
    qsa('.label-print').forEach(b=>b.onclick=()=>printQr(orders.find(o=>o.id===b.dataset.id)))
  }
  qs('#labelStore').onchange=draw
  qs('#labelSearch').oninput=draw
  qs('#printSelected').onclick=()=>{
    const ids=new Set(qsa('.label-check:checked').map(x=>x.value))
    const selected=orders.filter(o=>ids.has(o.id))
    if(!selected.length)return toast('حدد طلباً واحداً على الأقل','error')
    printQrBatch(selected)
  }
  qs('#printAllLabels').onclick=async()=>{
    // Open while the click is active so the browser does not block the print window.
    const w=window.open('','_blank','width=1000,height=800')
    if(!w)return toast('اسمح بفتح النوافذ للطباعة','error')
    w.document.write('<html dir="rtl"><meta charset="utf-8"><body style="font-family:Arial;padding:25px">جاري تجهيز ملصقات الطلبات...</body></html>')
    const b=qs('#printAllLabels'),storeId=qs('#labelStore').value,search=qs('#labelSearch').value.trim().toLowerCase()
    b.disabled=true;b.textContent='جاري تجهيز الملصقات...'
    try{
      const all=[]
      for(let offset=0;;offset+=500){
        let query=supabase.from('orders').select('id,order_code,store_id,customer_name,customer_phone,area,address,amount_to_collect,payment_type,parcel_count,priority,created_at')
          .order('created_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+499)
        if(storeId)query=query.eq('store_id',storeId)
        const {data:page,error:pageError}=await query
        if(pageError)throw pageError
        all.push(...(page||[]).filter(o=>!search||[o.order_code,o.customer_name,o.customer_phone].some(v=>String(v||'').toLowerCase().includes(search))))
        if((page||[]).length<500)break
      }
      if(!all.length){w.close();return toast('لا توجد طلبات مطابقة للطباعة','error')}
      await printQrBatch(all,w)
    }catch(error){w.close();toast(errText(error),'error')}
    finally{b.disabled=false;b.textContent='طباعة كل الأكواد دفعة واحدة'}
  }
  draw()
}

async function renderStoreNew(){
  const {data:links,error}=await supabase.from('store_users').select('store_id,stores(id,name,active)').eq('user_id',profile.id)
  if(error)throw error
  const owned=(links||[]).map(x=>x.stores).filter(s=>s?.active)
  if(!owned.length){qs('#content').innerHTML='<div class="panel"><div class="empty">حسابك غير مربوط بمحل نشط.</div></div>';return}

  qs('#content').innerHTML=`<div class="welcome-card"><div><span class="eyebrow">طلب جديد</span><h3>إضافة أوردر 📦</h3><p>أدخل بيانات الزبون، والنظام يولد رقم الطلب وQR تلقائياً. الإدارة تطبع الملصق وتضعه على الكيس.</p></div></div>
    <div class="panel"><form id="storeOrderForm" class="form-grid two">
      <div class="field"><label for="soStore">المحل</label><select id="soStore" required>${owned.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="soName">اسم الزبون</label><input id="soName" required maxlength="150"></div>
      <div class="field"><label for="soPhone">رقم الهاتف</label><input id="soPhone" required inputmode="tel" maxlength="40"></div>
      <div class="field"><label for="soArea">المنطقة</label><input id="soArea" required maxlength="150"></div>
      <div class="field"><label for="soAddress">العنوان</label><input id="soAddress" required maxlength="500"></div>
      <div class="field"><label for="soAmount">المبلغ المطلوب تحصيله</label><input id="soAmount" type="number" step=".01" min="0" max="100000" value="0" required></div>
      <div class="field"><label for="soPayment">الدفع</label><select id="soPayment"><option value="cod">عند التسليم</option><option value="prepaid">مدفوع مسبقاً</option></select></div>
      <div class="field"><label for="soParcels">عدد القطع</label><input id="soParcels" type="number" min="1" max="100" value="1" required></div>
      <div class="field"><label for="soPriority">الأولوية</label><select id="soPriority"><option value="normal">عادي</option><option value="urgent">مستعجل</option></select></div>
      <div class="field"><label for="soNotes">ملاحظات</label><textarea id="soNotes" maxlength="2000" placeholder="تفاصيل إضافية"></textarea></div>
      <div class="field"><label>&nbsp;</label><button class="btn btn-primary" type="submit">✓ إنشاء الطلب والـQR</button></div>
    </form><div id="storeOrderResult" role="status" aria-live="polite"></div></div>`
  qs('#soPayment').onchange=()=>{const prepaid=qs('#soPayment').value==='prepaid';qs('#soAmount').disabled=prepaid;if(prepaid)qs('#soAmount').value='0'}
  qs('#storeOrderForm').onsubmit=async e=>{
    e.preventDefault()
    const b=qs('#storeOrderForm button[type="submit"]')
    try{
      b.disabled=true;b.textContent='جاري إنشاء الطلب...'
      const {data:order,error:saveError}=await supabase.rpc('store_create_order_auto',{
        p_store_id:qs('#soStore').value,
        p_customer_name:qs('#soName').value.trim(),p_customer_phone:qs('#soPhone').value.trim(),
        p_area:qs('#soArea').value.trim(),p_address:qs('#soAddress').value.trim(),
        p_amount_to_collect:Number(qs('#soAmount').value||0),p_payment_type:qs('#soPayment').value,
        p_parcel_count:Number(qs('#soParcels').value),p_priority:qs('#soPriority').value,
        p_notes:qs('#soNotes').value.trim()||null
      })
      if(saveError)throw saveError
      const o=Array.isArray(order)?order[0]:order
      const qr=await QRCode.toDataURL(o.order_code,{width:180,margin:1})
      qs('#storeOrderResult').innerHTML=`<div class="created-order"><div><span class="badge green">✓ تم إنشاء الطلب</span><h3>${esc(o.order_code)}</h3><p>${esc(o.customer_name)} · ${esc(o.customer_phone)}</p><p>${esc(o.area)} · ${esc(o.address)}</p><p>${o.payment_type==='prepaid'?'مدفوع مسبقاً':money(o.amount_to_collect)} · ${o.parcel_count} قطعة</p><small>الإدارة تستطيع طباعة ملصق هذا الطلب من شاشة «طباعة الملصقات».</small></div><img src="${qr}" alt="QR للطلب ${esc(o.order_code)}"></div>`
      toast(`تم إنشاء ${o.order_code}`)
      const chosen=qs('#soStore').value
      qs('#storeOrderForm').reset();qs('#soStore').value=chosen;qs('#soAmount').disabled=false
    }catch(x){toast(({STORE_NOT_AVAILABLE:'المحل غير متاح',INVALID_ORDER_DETAILS:'أكمل بيانات الطلب بشكل صحيح',INVALID_ORDER_OPTIONS:'تحقق من المبلغ وعدد القطع',STORE_ACCOUNT_REQUIRED:'هذا الحساب غير مخوّل لإنشاء الطلبات'})[x?.message]||errText(x),'error')}
    finally{b.disabled=false;b.textContent='✓ إنشاء الطلب والـQR'}
  }
}

function renderAdd(){
  if(!stores.length){qs('#content').innerHTML='<div class="panel"><div class="empty">أضف محل أولاً.</div></div>';return}
  qs('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>إضافة دفعة أوردرات</h3><span class="muted">اختَر المحل وعدد الأوردرات</span></div>
    <div class="form-grid"><div class="field"><label>المحل</label><select id="batchStore">${stores.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div><div class="field"><label>عدد الأوردرات</label><input id="batchCount" type="number" min="1" max="50" value="5"></div><div class="field"><label>&nbsp;</label><button id="buildRows" class="btn btn-blue">تجهيز الصفوف</button></div></div>
    <div class="field"><label>استيراد Excel أو CSV: الاسم، الهاتف، المنطقة، العنوان، المبلغ، الملاحظات، طريقة الدفع، عدد القطع</label><input id="csvOrders" type="file" accept=".csv,.xlsx,.xls,text/csv"></div>
    <div id="orderRows"></div><button id="saveBatch" class="btn btn-primary">حفظ الأوردرات وإنشاء QR</button>
  </div><div id="createdQr" style="margin-top:14px"></div>`
  qs('#buildRows').onclick=buildRows
  qs('#saveBatch').onclick=saveBatch
  qs('#csvOrders').onchange=async e=>{
    const file=e.target.files[0];if(!file)return
    let rows
    try{
      if(/\.xlsx?$/i.test(file.name)){
        const XLSX=await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs')
        const book=XLSX.read(await file.arrayBuffer())
        rows=XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1,defval:''})
      }else rows=parseCsv(await file.text())
    }catch(error){return toast('تعذر قراءة الملف. تأكد أنه Excel أو CSV صحيح','error')}
    if(rows.length<2||rows.length>51)return toast('الملف يجب أن يحتوي عنوان الأعمدة و1 إلى 50 طلباً','error')
    qs('#batchCount').value=rows.length-1;buildRows()
    qsa('.order-row').forEach((row,i)=>{
      const vals=rows[i+1]
      ;['customer_name','customer_phone','area','address','amount_to_collect','notes','payment_type','parcel_count'].forEach((key,j)=>{
        const el=qs(`[data-f="${key}"]`,row)
        if(el&&vals[j]!==undefined)el.value=vals[j]
      })
    })
  }
  buildRows()
}
function parseCsv(source){
  const rows=[];let row=[],field='',quote=false
  for(let i=0;i<source.length;i++){
    const ch=source[i]
    if(ch==='"'){if(quote&&source[i+1]==='"'){field+='"';i++}else quote=!quote}
    else if(ch===','&&!quote){row.push(field);field=''}
    else if((ch==='\n'||ch==='\r')&&!quote){if(ch==='\r'&&source[i+1]==='\n')i++;row.push(field);if(row.some(x=>x.trim()))rows.push(row);row=[];field=''}
    else field+=ch
  }
  row.push(field);if(row.some(x=>x.trim()))rows.push(row)
  return rows
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
    <select data-f="payment_type"><option value="cod">تحصيل</option><option value="prepaid">مدفوع</option></select>
    <input data-f="parcel_count" type="number" min="1" max="100" value="1" title="عدد القطع">
    <select data-f="priority"><option value="normal">عادي</option><option value="urgent">مستعجل</option></select>
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
      notes:val('notes')||null,status:'in_warehouse',payment_type:val('payment_type'),parcel_count:Number(val('parcel_count')),priority:val('priority'),delivery_fee:Number(s?.delivery_fee||0),
      return_fee:Number(s?.return_fee||0),created_by:profile.id
    }
    if(!item.customer_name||!item.customer_phone||!item.area||!item.address){
      return toast('كمّل البيانات الأساسية لكل الأوردرات','error')
    }
    if(item.payment_type==='prepaid')item.amount_to_collect=0
    if(!Number.isInteger(item.parcel_count)||item.parcel_count<1||item.parcel_count>100)return toast('عدد القطع غير صحيح','error')
    items.push(item)
  }
  const phones=items.map(x=>x.customer_phone)
  if(new Set(phones).size!==phones.length && !confirm('هناك رقم زبون مكرر في الدفعة. هل تريد المتابعة؟'))return
  const {data:recent}=await supabase.from('orders').select('customer_phone').eq('store_id',store_id).gte('created_at',new Date(Date.now()-86400000).toISOString()).in('customer_phone',phones)
  if(recent?.length&&!confirm(`هناك ${recent.length} طلب سابق بنفس الرقم خلال 24 ساعة. هل تريد المتابعة؟`))return
  const {data:batch,error:bErr}=await supabase.from('order_batches').insert({store_id,expected_count:items.length,created_by:profile.id}).select().single()
  if(bErr)return toast(errText(bErr),'error')
  items.forEach(x=>x.batch_id=batch.id)
  const {data,error}=await supabase.from('orders').insert(items).select('*')
  if(error)return toast(errText(error),'error')
  toast(`تم حفظ ${data.length} أوردر`)
  qs('#createdQr').innerHTML=`<div class="panel"><div class="panel-head"><h3>QR للأوردرات الجديدة</h3><button id="printAllQr" class="btn btn-primary">طباعة كل الملصقات</button></div><div class="cards">${data.map(o=>`<div class="card qr-card"><h4>${esc(o.order_code)}</h4><p>${esc(o.customer_name)} — ${money(o.amount_to_collect)}</p><button class="btn btn-blue print-qr" data-id="${o.id}">فتح/طباعة QR</button></div>`).join('')}</div></div>`
  qsa('.print-qr').forEach(b=>b.onclick=()=>printQr(data.find(x=>x.id===b.dataset.id)))
  qs('#printAllQr').onclick=()=>printQrBatch(data)
}

async function printQrBatch(orders,printWindow=null){
  const w=printWindow||window.open('','_blank','width=1000,height=800')
  if(!w)return toast('اسمح بفتح النوافذ للطباعة','error')
  w.document.open()
  w.document.write(`<!doctype html><html dir="rtl"><head><meta charset="utf-8"><title>ملصقات Drop Off · ${orders.length} طلب</title><style>@page{size:A4;margin:8mm}body{font-family:Arial}.sheet{display:grid;grid-template-columns:repeat(3,1fr);gap:5mm}.label{border:1px solid #333;border-radius:8px;padding:8px;display:flex;flex-direction:column;align-items:center;gap:5px;break-inside:avoid;font-size:11px;overflow-wrap:anywhere}.label img{width:35mm;height:35mm}.label b{font-size:13px}</style></head><body><div class="sheet">`)
  for(let i=0;i<orders.length;i+=40){
    const labels=await Promise.all(orders.slice(i,i+40).map(async o=>{
      const qr=await QRCode.toDataURL(o.order_code,{width:220,margin:1})
      return `<div class="label"><b>DROP OFF · ${esc(o.order_code)}</b><img src="${qr}"><b>${esc(storeName(o.store_id))}</b><span>${esc(o.customer_name)} · ${esc(o.customer_phone)}</span><span>${esc(o.area)} · ${esc(o.address)}</span><span>${o.parcel_count||1} قطعة · ${o.priority==='urgent'?'مستعجل':'عادي'}</span><b>${o.payment_type==='prepaid'?'مدفوع مسبقاً':money(o.amount_to_collect)}</b></div>`
    }))
    w.document.write(labels.join(''))
  }
  w.document.write('</div></body></html>')
  w.document.close();setTimeout(()=>w.print(),700)
}

async function printQr(o){
  if(!o)return
  const w=window.open('','_blank','width=450,height=650')
  if(!w)return toast('اسمح بفتح النوافذ للطباعة','error')
  const payload=o.order_code
  const dataUrl=await QRCode.toDataURL(payload,{width:300,margin:1,errorCorrectionLevel:'M'})
  w.document.write(`<html dir="rtl"><head><meta charset="utf-8"><title>${esc(o.order_code)}</title><style>@page{size:100mm 100mm;margin:4mm}body{margin:0;font-family:Arial;display:grid;place-items:center;padding:4mm;color:#111}.label{width:88mm;border:1px solid #222;border-radius:10px;padding:8px;text-align:center;box-sizing:border-box}.label img{width:36mm;height:36mm;object-fit:contain}.brand{font-size:19px;font-weight:900}.price{font-size:17px;font-weight:900}.details{font-size:12px;line-height:1.5;overflow-wrap:anywhere}</style></head><body><div class="label"><div class="brand">DROP OFF</div><strong>${esc(o.order_code)}</strong><br><img src="${dataUrl}" alt="QR"><h3>${esc(storeName(o.store_id))}</h3><div class="details">${esc(o.customer_name)} · ${esc(o.customer_phone)}<br>${esc(o.area)} — ${esc(o.address)}<br>${esc(o.parcel_count||1)} قطعة · ${o.priority==='urgent'?'مستعجل · ':''}${o.payment_type==='prepaid'?'مدفوع':'تحصيل'}${o.notes?`<br>${esc(o.notes)}`:''}</div><div class="price">${o.payment_type==='prepaid'?'مدفوع مسبقاً':money(o.amount_to_collect)}</div></div></body></html>`)
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
  qsa('.edit-order').forEach(b=>b.onclick=()=>editOrder(data.find(x=>x.id===b.dataset.id)))
}

async function editOrder(o){
  const {data:events}=await supabase.from('order_events').select('event_type,old_status,new_status,created_at,actor_id').eq('order_id',o.id).order('created_at',{ascending:false}).limit(30)
  qs('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>${esc(o.order_code)} · ${esc(storeName(o.store_id))}</h3><button id="backOrders" class="btn btn-ghost">رجوع</button></div>
    <form id="orderEdit" class="form-grid two">
      <div class="field"><label>العنوان</label><input id="eoAddress" value="${esc(o.address)}"></div>
      <div class="field"><label>رقم الزبون</label><input id="eoPhone" value="${esc(o.customer_phone)}"></div>
      <div class="field"><label>مبلغ التحصيل</label><input id="eoAmount" type="number" min="0" step=".01" value="${Number(o.amount_to_collect||0)}"></div>
      <div class="field"><label>طريقة الدفع</label><select id="eoPayment"><option value="cod">عند التسليم</option><option value="prepaid">مدفوع مسبقاً</option></select></div>
      <div class="field"><label>عدد القطع</label><input id="eoParcels" type="number" min="1" max="100" value="${o.parcel_count||1}"></div>
      <div class="field"><label>الأولوية</label><select id="eoPriority"><option value="normal">عادي</option><option value="urgent">مستعجل</option></select></div>
      <div class="field"><label>موعد مطلوب</label><input id="eoPromised" type="datetime-local" value="${o.promised_at?new Date(o.promised_at).toISOString().slice(0,16):''}"></div>
      <div class="field"><label>دفعة التوزيع</label><select id="eoRun"><option value="morning">صباحية</option><option value="evening">مسائية</option></select></div>
      <div class="field"><label>رف المخزن</label><input id="eoShelf" value="${esc(o.shelf_location||'')}"></div>
      <div class="field"><label>كابتن التوصيل</label><select id="eoCaptain"><option value="">بدون</option>${captains.filter(c=>c.active&&['delivery','both'].includes(c.captain_type)).map(c=>`<option value="${c.id}">${esc(c.profiles?.full_name||c.id)}</option>`).join('')}</select></div>
      <div class="field"><label>&nbsp;</label><button class="btn btn-primary">حفظ التعديلات</button></div>
    </form>${o.status==='returned_warehouse'?`<div class="quick"><button id="returnToStore" class="btn btn-red">تسليم المرتجع للمحل</button><button id="retryDelivery" class="btn btn-blue">إعادة محاولة التوصيل</button></div>`:''}</div>
    <div class="panel" style="margin-top:14px"><h3>سجل التعديلات</h3><div class="cards">${(events||[]).map(e=>`<div class="card"><b>${esc(e.event_type)}</b><p>${esc(statusLabels[e.old_status]||e.old_status||'—')} ← ${esc(statusLabels[e.new_status]||e.new_status||'—')}</p><small>${new Date(e.created_at).toLocaleString('ar-JO')} · ${esc(profiles.find(p=>p.id===e.actor_id)?.full_name||'النظام')}</small></div>`).join('')||'<div class="empty">لا يوجد تعديلات</div>'}</div></div>`
  qs('#eoPayment').value=o.payment_type||'cod';qs('#eoPriority').value=o.priority||'normal';qs('#eoRun').value=o.delivery_run||'evening';qs('#eoCaptain').value=o.delivery_captain_id||''
  qs('#backOrders').onclick=renderOrders
  if(o.status==='returned_warehouse'){
    qs('#returnToStore').onclick=async()=>{const {error}=await supabase.from('orders').update({status:'returned_store',returned_at:new Date().toISOString()}).eq('id',o.id);if(error)return toast(errText(error),'error');toast('تم تسليم المرتجع للمحل');renderOrders()}
    qs('#retryDelivery').onclick=async()=>{const {error}=await supabase.from('orders').update({status:'in_warehouse',delivery_captain_id:null,assigned_at:null}).eq('id',o.id);if(error)return toast(errText(error),'error');toast('الطلب جاهز لإعادة التوزيع');renderAssign()}
  }
  qs('#orderEdit').onsubmit=async e=>{
    e.preventDefault()
    const captain=qs('#eoCaptain').value
    if(captain && captain!==o.delivery_captain_id){
      const r=await supabase.rpc('staff_assign_order',{p_order_id:o.id,p_captain_id:captain})
      if(r.error)return toast(errText(r.error),'error')
    }
    const body={address:qs('#eoAddress').value.trim(),customer_phone:qs('#eoPhone').value.trim(),amount_to_collect:Number(qs('#eoAmount').value),payment_type:qs('#eoPayment').value,parcel_count:Number(qs('#eoParcels').value),priority:qs('#eoPriority').value,promised_at:qs('#eoPromised').value?new Date(qs('#eoPromised').value).toISOString():null,delivery_run:qs('#eoRun').value,shelf_location:qs('#eoShelf').value.trim()||null}
    const {error}=await supabase.from('orders').update(body).eq('id',o.id)
    if(error)return toast(errText(error),'error')
    toast('تم تحديث الأوردر');renderOrders()
  }
}

async function renderOperations(){
  await loadCommon()
  const [{data:orders,error:oe},{data:issues,error:ie},{data:batches,error:be},{data:rates,error:re},{data:counts,error:ce}]=await Promise.all([
    supabase.from('orders').select('*').order('created_at',{ascending:false}).limit(500),
    supabase.from('order_exceptions').select('*').is('resolved_at',null).order('created_at',{ascending:false}),
    supabase.from('order_batches').select('*').order('created_at',{ascending:false}).limit(30),
    supabase.from('area_rates').select('*').order('area'),
    supabase.from('warehouse_counts').select('*').order('counted_at',{ascending:false}).limit(5)
  ])
  if(oe||ie||be||re||ce)throw oe||ie||be||re||ce
  const warehouse=orders.filter(o=>['new','in_warehouse','returned_warehouse'].includes(o.status))
  const overdue=orders.filter(o=>o.promised_at&&new Date(o.promised_at)<new Date()&&!['delivered','returned_store','cancelled'].includes(o.status))
  const unresolved=orders.filter(o=>['postponed','no_answer','rejected'].includes(o.status))
  qs('#content').innerHTML=`<div class="grid stats">${stat('بالمخزن',warehouse.length)}${stat('مشاكل مفتوحة',issues.length)}${stat('طلبات متأخرة',overdue.length)}${stat('مرتجعات',orders.filter(o=>o.status.startsWith('returned')).length)}</div>
    <div class="panel"><div class="panel-head"><h3>مسح الاستكر ونقل الطلب</h3></div><div class="form-grid two"><div class="field"><label>رقم الأوردر أو الاستكر</label><input id="scanCode" placeholder="DO-000001 أو DO-ST-000001"></div><div class="field"><label>الموقع بالمخزن</label><input id="scanShelf" placeholder="رف A3"></div><div class="field"><label>تسليم إلى كابتن</label><select id="scanCaptain"><option value="">اختر الكابتن</option>${captains.filter(c=>c.active&&c.available_today&&['delivery','both'].includes(c.captain_type)).map(c=>`<option value="${c.id}">${esc(c.profiles?.full_name||c.id)}</option>`).join('')}</select></div><div class="field"><label>&nbsp;</label><button id="scanAssign" class="btn btn-blue">تسليم للكابتن</button></div><div class="field"><label>&nbsp;</label><button id="scanReceive" class="btn btn-primary">استلام للمخزن</button></div><div class="field"><label>&nbsp;</label><button id="scanCamera" class="btn btn-ghost">📷 فتح الكاميرا</button></div></div><video id="scannerVideo" class="hidden" autoplay playsinline style="width:100%;max-width:380px"></video></div>
    <div class="panel" style="margin-top:14px"><div class="panel-head"><h3>مشاكل الطلبات والمرتجعات</h3></div><div class="form-grid two"><div class="field"><label>الأوردر</label><input id="issueOrder" placeholder="رقم الأوردر"></div><div class="field"><label>المشكلة</label><select id="issueReason"><option>رقم خاطئ</option><option>عنوان ناقص</option><option>لا يرد</option><option>تأجيل</option><option>مرتجع</option><option>أخرى</option></select></div><div class="field"><label>الإجراء التالي</label><input id="issueAction" placeholder="الاتصال غداً أو إعادة التوزيع"></div><div class="field"><label>المسؤول</label><select id="issueOwner"><option value="">الإدارة</option>${profiles.filter(p=>p.active).map(p=>`<option value="${p.id}">${esc(p.full_name||p.username||p.phone)}</option>`).join('')}</select></div><div class="field"><label>&nbsp;</label><button id="addIssue" class="btn btn-blue">تسجيل المشكلة</button></div></div><div class="cards">${issues.map(i=>`<div class="card"><b>${esc(orders.find(o=>o.id===i.order_id)?.order_code||'—')}</b><p>${esc(i.reason)} · ${esc(i.next_action||'بدون إجراء')}</p><small>المسؤول: ${esc(profiles.find(p=>p.id===i.owner_id)?.full_name||'الإدارة')}</small><br><button class="btn btn-sm btn-green resolve-issue" data-id="${i.id}" data-order="${i.order_id}">تم الحل</button></div>`).join('')||'<div class="empty">لا توجد مشاكل مفتوحة</div>'}</div></div>
    <div class="panel" style="margin-top:14px"><div class="panel-head"><h3>كشف الاستلام من المحلات</h3></div><div class="cards">${batches.map(b=>`<div class="card"><h4>${esc(storeName(b.store_id))}</h4><p>متوقع: ${b.expected_count} · مستلم: ${b.received_count||0}</p><small>${new Date(b.created_at).toLocaleString('ar-JO')}</small><div class="field"><input class="batch-received" data-id="${b.id}" type="number" min="0" value="${b.received_count||0}"></div><button class="btn btn-sm btn-blue save-received" data-id="${b.id}">حفظ الاستلام</button></div>`).join('')||'<div class="empty">لا توجد دفعات</div>'}</div></div>
    <div class="panel" style="margin-top:14px"><div class="panel-head"><h3>جرد المخزن آخر اليوم</h3></div><p>الطلبات المسجلة بالمخزن: <b>${warehouse.length}</b></p><div class="form-grid two"><div class="field"><label>العدد الفعلي</label><input id="countActual" type="number" min="0"></div><div class="field"><label>ملاحظة الفرق</label><input id="countNote"></div><div class="field"><label>&nbsp;</label><button id="saveCount" class="btn btn-blue">حفظ الجرد</button></div></div><div class="cards">${counts.map(c=>`<div class="card">${new Date(c.counted_at).toLocaleString('ar-JO')} · النظام ${c.expected_count} / الفعلي ${c.actual_count} · الفرق ${c.actual_count-c.expected_count}</div>`).join('')}</div></div>
    <div class="panel" style="margin-top:14px"><div class="panel-head"><h3>تسعيرة المناطق</h3></div><div class="form-grid two"><div class="field"><label>المحل</label><select id="rateStore"><option value="">كل المحلات</option>${stores.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div><div class="field"><label>المنطقة</label><input id="rateArea"></div><div class="field"><label>رسوم التوصيل</label><input id="rateFee" type="number" min="0" step=".01"></div><div class="field"><label>&nbsp;</label><button id="saveRate" class="btn btn-primary">إضافة تسعيرة</button></div></div><div class="cards">${rates.map(r=>`<div class="card">${esc(r.area)} · ${esc(r.store_id?storeName(r.store_id):'كل المحلات')} · ${money(r.delivery_fee)} <button class="btn btn-sm btn-red delete-rate" data-id="${r.id}">حذف</button></div>`).join('')||'<div class="empty">لا توجد تسعيرات خاصة</div>'}</div></div>
    <div class="panel" style="margin-top:14px"><div class="panel-head"><h3>دوام الكباتن والحمولة</h3></div><div class="cards">${captains.map(c=>`<div class="card"><h4>${esc(c.profiles?.full_name||c.id)}</h4><p>اليوم: ${c.available_today?'متاح':'غير متاح'} · الحد ${c.daily_capacity||30} طلب</p><input class="capacity" type="number" min="1" max="500" value="${c.daily_capacity||30}" data-id="${c.id}"><button class="btn btn-sm btn-blue save-capacity" data-id="${c.id}">حفظ</button><button class="btn btn-sm btn-ghost availability" data-id="${c.id}" data-available="${!c.available_today}">${c.available_today?'إيقاف اليوم':'إتاحة اليوم'}</button></div>`).join('')||'<div class="empty">لا يوجد كباتن</div>'}</div></div>
    <div class="panel" style="margin-top:14px"><h3>تنبيهات التشغيل</h3><p>المتأخرة: ${overdue.map(o=>esc(o.order_code)).join('، ')||'لا يوجد'}</p><p>المؤجلة أو لم يرد الزبون: ${unresolved.map(o=>esc(o.order_code)).join('، ')||'لا يوجد'}</p></div>`
  const scannedOrder=async()=>{
    let code=qs('#scanCode').value.trim().toUpperCase()
    if(!code){toast('أدخل رقم الطلب أو امسح الاستكر','error');return null}
    if(code.startsWith('DROP-OFF:')){
      const {data:s,error}=await supabase.from('order_stickers').select('order_id').eq('qr_token',code.slice(9)).maybeSingle()
      if(error||!s?.order_id){toast('الاستكر غير مربوط بطلب','error');return null}
      code=orders.find(o=>o.id===s.order_id)?.order_code||''
    }
    if(code.startsWith('DO-ST-')){
      const {data:s}=await supabase.from('order_stickers').select('order_id').eq('sticker_code',code).maybeSingle()
      code=orders.find(o=>o.id===s?.order_id)?.order_code||''
    }
    const o=orders.find(x=>x.order_code===code)
    if(!o){toast('الطلب غير موجود','error');return null}
    return o
  }
  qs('#scanReceive').onclick=async()=>{
    const o=await scannedOrder();if(!o)return
    if(!['new','in_warehouse','returned_warehouse'].includes(o.status))return toast('الأوردر مع كابتن أو مكتمل','error')
    const {error}=await supabase.from('orders').update({status:'in_warehouse',shelf_location:qs('#scanShelf').value.trim()||o.shelf_location,received_at:new Date().toISOString()}).eq('id',o.id)
    if(error)return toast(errText(error),'error')
    toast(`تم استلام ${o.order_code}`);renderOperations()
  }
  qs('#scanAssign').onclick=async()=>{
    const o=await scannedOrder(),captain_id=qs('#scanCaptain').value
    if(!o||!captain_id)return toast('امسح الطلب واختر الكابتن','error')
    const {data:c}=await supabase.from('captains').select('daily_capacity').eq('id',captain_id).single()
    const {count}=await supabase.from('orders').select('id',{count:'exact',head:true}).eq('delivery_captain_id',captain_id).in('status',['assigned','out_for_delivery','postponed','no_answer'])
    if((count||0)>=(c?.daily_capacity||30))return toast('الكابتن وصل حد الحمولة','error')
    const {error}=await supabase.rpc('staff_assign_order',{p_order_id:o.id,p_captain_id:captain_id})
    if(error)return toast(errText(error),'error')
    toast(`تم تسليم ${o.order_code} للكابتن`);renderOperations()
  }
  qs('#scanCamera').onclick=()=>scanQr(qs('#scanCode'))
  qs('#addIssue').onclick=async()=>{
    const o=orders.find(x=>x.order_code===qs('#issueOrder').value.trim().toUpperCase())
    if(!o)return toast('رقم الأوردر غير موجود','error')
    const reason=qs('#issueReason').value,owner_id=qs('#issueOwner').value||null
    const {error}=await supabase.from('order_exceptions').insert({order_id:o.id,reason,next_action:qs('#issueAction').value.trim()||null,owner_id,created_by:profile.id})
    if(error)return toast(errText(error),'error')
    await supabase.from('orders').update({exception_reason:reason,exception_owner:owner_id,exception_resolved_at:null}).eq('id',o.id)
    toast('تم تسجيل المشكلة');renderOperations()
  }
  qsa('.resolve-issue').forEach(b=>b.onclick=async()=>{
    const {error}=await supabase.from('order_exceptions').update({resolved_at:new Date().toISOString()}).eq('id',b.dataset.id)
    if(error)return toast(errText(error),'error')
    await supabase.from('orders').update({exception_resolved_at:new Date().toISOString()}).eq('id',b.dataset.order)
    renderOperations()
  })
  qsa('.save-received').forEach(b=>b.onclick=async()=>{
    const received_count=Number(qs(`.batch-received[data-id="${b.dataset.id}"]`).value)
    const {error}=await supabase.from('order_batches').update({received_count,received_at:new Date().toISOString()}).eq('id',b.dataset.id)
    if(error)return toast(errText(error),'error');toast('تم حفظ كشف الاستلام');renderOperations()
  })
  qs('#saveCount').onclick=async()=>{
    const actual_count=Number(qs('#countActual').value)
    if(qs('#countActual').value===''||actual_count<0)return toast('أدخل العدد الفعلي','error')
    const {error}=await supabase.from('warehouse_counts').insert({expected_count:warehouse.length,actual_count,note:qs('#countNote').value.trim()||null,created_by:profile.id})
    if(error)return toast(errText(error),'error');toast('تم حفظ الجرد');renderOperations()
  }
  qs('#saveRate').onclick=async()=>{
    const area=qs('#rateArea').value.trim(),fee=Number(qs('#rateFee').value)
    if(!area||qs('#rateFee').value===''||fee<0)return toast('أدخل المنطقة والرسوم','error')
    const {error}=await supabase.from('area_rates').insert({store_id:qs('#rateStore').value||null,area,delivery_fee:fee})
    if(error)return toast(errText(error),'error');renderOperations()
  }
  qsa('.delete-rate').forEach(b=>b.onclick=async()=>{const {error}=await supabase.from('area_rates').delete().eq('id',b.dataset.id);if(error)return toast(errText(error),'error');renderOperations()})
  qsa('.save-capacity').forEach(b=>b.onclick=async()=>{const daily_capacity=Number(qs(`.capacity[data-id="${b.dataset.id}"]`).value);const {error}=await supabase.from('captains').update({daily_capacity}).eq('id',b.dataset.id);if(error)return toast(errText(error),'error');renderOperations()})
  qsa('.availability').forEach(b=>b.onclick=async()=>{const {error}=await supabase.from('captains').update({available_today:b.dataset.available==='true'}).eq('id',b.dataset.id);if(error)return toast(errText(error),'error');renderOperations()})
}

async function scanQr(input){
  if(!('BarcodeDetector' in window))return toast('الكاميرا لا تدعم QR هنا؛ أدخل الرقم يدوياً','error')
  const video=qs('#scannerVideo')
  try{
    const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}})
    video.srcObject=stream;video.classList.remove('hidden')
    const detector=new BarcodeDetector({formats:['qr_code']})
    const poll=async()=>{
      if(!video.isConnected||video.srcObject!==stream){stream.getTracks().forEach(t=>t.stop());return}
      const codes=await detector.detect(video).catch(()=>[])
      if(codes.length){input.value=codes[0].rawValue;stream.getTracks().forEach(t=>t.stop());video.srcObject=null;video.classList.add('hidden');toast('تم قراءة الاستكر');return}
      setTimeout(poll,350)
    }
    poll()
  }catch(e){toast('تعذر فتح الكاميرا؛ أدخل الرقم يدوياً','error')}
}

async function renderAssign(){
  await loadCommon()
  const {data:orders,error}=await supabase.from('orders').select('*').in('status',['in_warehouse','new']).order('created_at',{ascending:true})
  if(error)throw error
  const delivery=captains.filter(c=>c.active && c.available_today && ['delivery','both'].includes(c.captain_type))
  const pickup=captains.filter(c=>c.active && ['pickup','both'].includes(c.captain_type))
  qs('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>توزيع أوردرات التوصيل</h3><span class="muted">${orders.length} أوردر جاهز</span></div>
    <div class="form-grid"><div class="field"><label>كابتن التوصيل</label><select id="deliveryCaptain">${delivery.map(c=>`<option value="${c.id}">${esc(c.profiles?.full_name||c.profiles?.phone||c.id)} (حد ${c.daily_capacity||30})</option>`).join('')}</select></div><div class="field"><label>دفعة التوزيع</label><select id="assignRun"><option value="evening">مسائية</option><option value="morning">صباحية</option></select></div><div class="field"><label>المنطقة</label><select id="assignArea"><option value="">كل المناطق</option>${[...new Set(orders.map(o=>o.area))].sort().map(a=>`<option>${esc(a)}</option>`).join('')}</select></div><div class="field"><label>&nbsp;</label><button id="assignSelected" class="btn btn-primary">توزيع المحدد</button></div></div>
    <div class="table-wrap"><table class="table"><thead><tr><th>تحديد</th><th>الأوردر</th><th>المحل</th><th>المنطقة</th><th>المبلغ</th></tr></thead><tbody>${orders.sort((a,b)=>(b.priority==='urgent')-(a.priority==='urgent')||a.area.localeCompare(b.area)).map(o=>`<tr class="assign-row" data-area="${esc(o.area)}"><td><input class="check assign-check" type="checkbox" value="${o.id}"></td><td>${esc(o.order_code)} ${o.priority==='urgent'?'⚡':''}</td><td>${esc(storeName(o.store_id))}</td><td>${esc(o.area)}</td><td>${money(o.amount_to_collect)}</td></tr>`).join('')||'<tr><td colspan="5">لا يوجد أوردرات جاهزة</td></tr>'}</tbody></table></div>
  </div>
  <div class="panel" style="margin-top:14px"><div class="panel-head"><h3>توزيع جلب من المحلات</h3><span class="muted">اختياري</span></div>
    <div class="form-grid"><div class="field"><label>كابتن الجلب</label><select id="pickupCaptain">${pickup.map(c=>`<option value="${c.id}">${esc(c.profiles?.full_name||c.profiles?.phone||c.id)}</option>`).join('')}</select></div><div class="field"><label>رقم الأوردر</label><input id="pickupOrder" placeholder="DO-000001"></div><div class="field"><label>&nbsp;</label><button id="assignPickup" class="btn btn-blue">تعيين للجلب</button></div></div>
  </div>`
  qs('#assignArea').onchange=()=>qsa('.assign-row').forEach(row=>row.classList.toggle('hidden',!!qs('#assignArea').value&&row.dataset.area!==qs('#assignArea').value))
  qs('#assignSelected').onclick=async()=>{
    const ids=qsa('.assign-check:checked').map(x=>x.value),captain_id=qs('#deliveryCaptain').value
    if(!ids.length)return toast('حدد أوردر واحد على الأقل','error')
    if(!captain_id)return toast('اختر كابتن','error')
    const captain=delivery.find(c=>c.id===captain_id)
    const {count:activeCount,error:countError}=await supabase.from('orders').select('id',{count:'exact',head:true}).eq('delivery_captain_id',captain_id).in('status',['assigned','out_for_delivery','postponed','no_answer'])
    if(countError)return toast(errText(countError),'error')
    if((activeCount||0)+ids.length>(captain.daily_capacity||30))return toast('الحمولة تتجاوز حد الكابتن اليومي','error')
    for(const id of ids){
      const r=await supabase.rpc('staff_assign_order',{p_order_id:id,p_captain_id:captain_id})
      if(r.error)return toast(errText(r.error),'error')
      const {error:runError}=await supabase.from('orders').update({delivery_run:qs('#assignRun').value}).eq('id',id)
      if(runError)return toast(errText(runError),'error')
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
    <div class="field span-2"><label>نوع المحل <small class="muted">يمكن اختيار أكثر من نوع</small></label>${categoryPicker('st')}</div>
    <div class="field"><label>&nbsp;</label><button class="btn btn-primary" type="submit">＋ إضافة المحل</button></div>
  </form></div>
  <div id="storeEditor"></div>
  <div class="panel" style="margin-top:14px"><div class="panel-head"><h3>المحلات</h3><span class="muted">${stores.length} محل</span></div><div class="cards">${stores.map(s=>`<div class="card"><h4>${esc(s.name)}</h4><div class="category-list">${categoryBadges(s.categories)}</div><p>${esc(s.phone||'—')}</p><p>${esc(s.address||'—')}</p><p>توصيل: ${money(s.delivery_fee)} · مرتجع: ${money(s.return_fee)}</p><button class="btn btn-sm btn-blue edit-store" data-id="${s.id}">تعديل بيانات وأنواع المحل</button></div>`).join('')||'<div class="empty">لا يوجد محلات</div>'}</div></div>`
  qs('#storeForm').onsubmit=async e=>{
    e.preventDefault()
    const categories=selectedCategories('st')
    if(!categories.length)return toast('اختر نوع محل واحد على الأقل أو اكتب نوعاً جديداً','error')
    const body={name:qs('#stName').value.trim(),phone:qs('#stPhone').value.trim()||null,address:qs('#stAddress').value.trim()||null,delivery_fee:Number(qs('#stDelivery').value||0),return_fee:Number(qs('#stReturn').value||0),categories,active:true}
    const {error}=await supabase.from('stores').insert(body)
    if(error)return toast(errText(error),'error')
    toast('تمت إضافة المحل');await loadCommon();renderStores()
  }
  qsa('.edit-store').forEach(b=>b.onclick=()=>renderStoreEditor(stores.find(s=>s.id===b.dataset.id)))
}

function renderStoreEditor(store){
  const editor=qs('#storeEditor')
  editor.innerHTML=`<div class="panel store-editor"><div class="panel-head"><h3>تعديل ${esc(store.name)}</h3><button id="closeStoreEditor" class="btn btn-ghost">إغلاق</button></div><form id="storeEditForm" class="form-grid two">
    <div class="field"><label>اسم المحل</label><input id="seName" required value="${esc(store.name)}"></div>
    <div class="field"><label>الهاتف</label><input id="sePhone" value="${esc(store.phone||'')}"></div>
    <div class="field"><label>العنوان</label><input id="seAddress" value="${esc(store.address||'')}"></div>
    <div class="field"><label>رسوم التوصيل</label><input id="seDelivery" type="number" min="0" step=".01" value="${Number(store.delivery_fee||0)}"></div>
    <div class="field"><label>رسوم المرتجع</label><input id="seReturn" type="number" min="0" step=".01" value="${Number(store.return_fee||0)}"></div>
    <div class="field span-2"><label>أنواع المحل <small class="muted">اختر كل الأنواع المناسبة</small></label>${categoryPicker('se',store.categories)}</div>
    <div class="field"><label>&nbsp;</label><button class="btn btn-primary">حفظ التعديلات</button></div>
  </form></div>`
  editor.scrollIntoView({behavior:'smooth',block:'start'})
  qs('#closeStoreEditor').onclick=()=>editor.innerHTML=''
  qs('#storeEditForm').onsubmit=async e=>{
    e.preventDefault()
    const categories=selectedCategories('se')
    if(!categories.length)return toast('اختر نوع محل واحد على الأقل أو اكتب نوعاً جديداً','error')
    const body={name:qs('#seName').value.trim(),phone:qs('#sePhone').value.trim()||null,address:qs('#seAddress').value.trim()||null,delivery_fee:Number(qs('#seDelivery').value||0),return_fee:Number(qs('#seReturn').value||0),categories}
    const {error}=await supabase.from('stores').update(body).eq('id',store.id)
    if(error)return toast(errText(error),'error')
    toast('تم تحديث المحل');await loadCommon();renderStores()
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
      <div class="field hidden" id="uStoreWrap"><label>المحل</label><select id="uStore"><option value="">اختر المحل</option>${stores.map(s=>`<option value="${s.id}">${esc(s.name)}${s.categories?.length?' — '+esc(s.categories.join('، ')):''}</option>`).join('')}</select></div>
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
  qs('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>حسابات المحلات</h3><button id="weeklyStatement" class="btn btn-blue">تنزيل كشف الأسبوع CSV</button></div><div class="cards">${(sb||[]).map(x=>`<div class="card"><h4>${esc(x.store_name)}</h4><p>تم التسليم: ${x.delivered_orders||0} · مرتجع: ${x.returned_orders||0}</p><p>تحصيلات: ${money(x.collections)}</p><p>رسوم: ${money(Number(x.delivery_fees||0)+Number(x.return_fees||0))}</p><p>تم الدفع: ${money(x.paid_out)}</p><div class="money">${money(x.balance_due)}</div><button class="btn btn-sm btn-green settle-store" data-id="${x.store_id}">تسجيل دفعة</button></div>`).join('')||'<div class="empty">لا توجد بيانات</div>'}</div></div>
  <div class="panel" style="margin-top:14px"><div class="panel-head"><h3>عهدة الكباتن</h3></div><div class="cards">${(cb||[]).map(x=>`<div class="card"><h4>${esc(x.full_name||'كابتن')}</h4><p>تحصيل: ${money(x.cash_collected)}</p><p>سلّم: ${money(x.cash_handed_over)}</p><div class="money">${money(x.cash_due)}</div><button class="btn btn-sm btn-blue handover" data-id="${x.captain_id}">تسجيل تسليم كاش</button></div>`).join('')||'<div class="empty">لا يوجد كباتن</div>'}</div></div>`
  const cashPanel=document.createElement('div');cashPanel.className='panel';cashPanel.style.marginTop='14px'
  cashPanel.innerHTML='<div class="panel-head"><h3>مطابقة كاش اليوم</h3></div><div class="form-grid two"><div class="field"><label>التاريخ</label><input type="date" id="cashDate"></div><div class="field"><label>&nbsp;</label><button id="checkCash" class="btn btn-blue">عرض المطابقة</button></div></div><div id="cashResult"></div>'
  qs('#content').append(cashPanel)
  qs('#cashDate').value=new Date().toLocaleDateString('en-CA')
  qs('#checkCash').onclick=async()=>{
    const day=qs('#cashDate').value,start=new Date(`${day}T00:00:00+03:00`),end=new Date(start.getTime()+86400000)
    if(!day||Number.isNaN(start.getTime()))return toast('اختر تاريخاً صحيحاً','error')
    const [{data:cash,error:e1},{data:paid,error:e2}]=await Promise.all([
      supabase.from('orders').select('delivery_captain_id,amount_to_collect').eq('status','delivered').eq('payment_type','cod').gte('delivered_at',start.toISOString()).lt('delivered_at',end.toISOString()),
      supabase.from('captain_handovers').select('captain_id,amount').gte('handed_over_at',start.toISOString()).lt('handed_over_at',end.toISOString())
    ])
    if(e1||e2)return toast(errText(e1||e2),'error')
    qs('#cashResult').innerHTML='<div class="cards">'+(cb||[]).map(c=>{
      const due=(cash||[]).filter(o=>o.delivery_captain_id===c.captain_id).reduce((n,o)=>n+Number(o.amount_to_collect||0),0)
      const delivered=(paid||[]).filter(x=>x.captain_id===c.captain_id).reduce((n,x)=>n+Number(x.amount||0),0)
      return `<div class="card"><h4>${esc(c.full_name||'كابتن')}</h4><p>تحصيل اليوم: ${money(due)} · تسليم اليوم: ${money(delivered)}</p><div class="money">فرق: ${money(due-delivered)}</div></div>`
    }).join('')+'</div>'
  }
  qsa('.settle-store').forEach(b=>b.onclick=()=>amountPrompt('مبلغ الدفعة للمحل',async amount=>supabase.from('store_settlements').insert({store_id:b.dataset.id,amount,created_by:profile.id})))
  qsa('.handover').forEach(b=>b.onclick=()=>amountPrompt('المبلغ الذي سلّمه الكابتن',async amount=>supabase.from('captain_handovers').insert({captain_id:b.dataset.id,amount,created_by:profile.id})))
  qs('#weeklyStatement').onclick=async()=>{
    const since=new Date(Date.now()-7*86400000).toISOString()
    const {data,error}=await supabase.from('orders').select('*').gte('created_at',since).order('created_at',{ascending:false}).limit(5000)
    if(error)return toast(errText(error),'error')
    downloadOrdersCsv(data,`dropoff-week-${new Date().toISOString().slice(0,10)}.csv`)
  }
}
function downloadOrdersCsv(orders,filename){
  const csvCell=v=>{const value=String(v??'');return '"'+(/^[=+@\-\t\r]/.test(value)?"'":'')+value.replaceAll('"','""')+'"'}
  const header=['الطلب','المحل','الزبون','الهاتف','المنطقة','الحالة','الدفع','مبلغ الطلب','رسوم التوصيل','رسوم المرتجع','عدد القطع','الكابتن','التاريخ']
  const rows=orders.map(o=>[o.order_code,storeName(o.store_id),o.customer_name,o.customer_phone,o.area,statusLabels[o.status],o.payment_type==='prepaid'?'مدفوع مسبقاً':'عند التسليم',o.amount_to_collect,o.delivery_fee,o.return_fee,o.parcel_count,captainName(o.delivery_captain_id),o.created_at])
  const blob=new Blob(['\ufeff'+[header,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'})
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
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
    return `<div class="captain-order"><div class="head"><div><h4>${esc(o.order_code)} — ${esc(o.area)} ${o.priority==='urgent'?'⚡':''}</h4><p>${esc(o.customer_name)} | ${esc(o.customer_phone)}</p><p>${esc(o.address)}</p><p>${esc(o.parcel_count||1)} قطعة · ${o.payment_type==='prepaid'?'مدفوع مسبقاً':'تحصيل عند التسليم'} · ${o.delivery_run==='morning'?'صباحي':'مسائي'}</p><p class="muted">${esc(o.notes||'')}</p></div><div class="price">${o.payment_type==='prepaid'?'0.00 د.أ':money(o.amount_to_collect)}</div></div><div class="quick">
      <a class="btn btn-sm btn-blue" href="tel:${esc(o.customer_phone)}">📞 اتصال</a><a class="btn btn-sm btn-green" href="https://wa.me/${wp}" target="_blank">واتساب</a><a class="btn btn-sm btn-ghost" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((o.address||'')+' '+(o.area||''))}" target="_blank">📍 خريطة</a>
      ${pickup?`<button class="btn btn-sm btn-primary pickup-received" data-id="${o.id}">وصل للمخزن</button>`:`<button class="btn btn-sm btn-primary cap-status" data-id="${o.id}" data-st="delivered">تم التسليم</button><button class="btn btn-sm btn-ghost cap-status" data-id="${o.id}" data-st="out_for_delivery">بالطريق</button><button class="btn btn-sm btn-ghost cap-status" data-id="${o.id}" data-st="postponed">مؤجل</button><button class="btn btn-sm btn-ghost cap-status" data-id="${o.id}" data-st="no_answer">لا يرد</button><button class="btn btn-sm btn-red cap-status" data-id="${o.id}" data-st="returned_warehouse">إرجاع للمخزن</button>`}
    </div></div>`}).join('')}</div>`
  qsa('.cap-status').forEach(b=>b.onclick=async()=>{const r=await supabase.rpc('captain_set_order_status',{p_order_id:b.dataset.id,p_status:b.dataset.st,p_note:null});if(r.error)return toast(errText(r.error),'error');toast('تم تحديث الحالة');renderCaptain()})
  qsa('.pickup-received').forEach(b=>b.onclick=async()=>{const r=await supabase.rpc('pickup_confirm_warehouse',{p_order_id:b.dataset.id});if(r.error)return toast(errText(r.error),'error');toast('تم تأكيد وصول الأوردر للمخزن');renderCaptain()})
}

async function renderOwner(){
  const {data:links,error:lerr}=await supabase.from('store_users').select('store_id,stores(id,name,categories)').eq('user_id',profile.id)
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
  const ownedStores=links.map(x=>x.stores).filter(Boolean)
  qs('#content').innerHTML=`<div class="welcome-card"><div><span class="eyebrow">متاجري</span><h3>${ownedStores.map(s=>esc(s.name)).join(' · ')}</h3><div class="category-list">${categoryBadges([...new Set(ownedStores.flatMap(s=>s.categories||[]))])}</div></div></div><div class="owner-summary">${stat('إجمالي الأوردرات',orders.length)}${stat('تم التسليم',orders.filter(o=>o.status==='delivered').length)}${stat('مرتجع',orders.filter(o=>o.status==='returned_store'||o.status==='returned_warehouse').length)}<div class="stat"><span>المبلغ المستحق</span><b>${money(balance)}</b></div></div>
  <div class="finance-strip"><span>التحصيلات</span><strong>${money(collections)}</strong><span>الرسوم ${money(fees)}</span></div>
  <div class="panel"><div class="panel-head"><h3>أوردرات المحل</h3></div>${orderTable(orders,'store')}<div id="storeOrderDetails"></div></div>`
  // Store owners can download only their own visible orders.
  const panel=qs('#content .panel')
  const button=document.createElement('button');button.className='btn btn-blue';button.textContent='تنزيل كشف طلباتي CSV'
  button.onclick=()=>downloadOrdersCsv(orders,`dropoff-store-${new Date().toISOString().slice(0,10)}.csv`)
  panel.querySelector('.panel-head').append(button)
  qsa('.store-detail').forEach(b=>b.onclick=async()=>{
    const o=orders.find(x=>x.id===b.dataset.id)
    if(!o)return
    const qr=await QRCode.toDataURL(o.order_code,{width:180,margin:1})
    qs('#storeOrderDetails').innerHTML=`<div class="created-order"><div><span class="badge ${statusClass(o.status)}">${esc(statusLabels[o.status]||o.status)}</span><h3>${esc(o.order_code)} · ${esc(storeName(o.store_id))}</h3><p>${esc(o.customer_name)} · ${esc(o.customer_phone)}</p><p>${esc(o.area)} · ${esc(o.address)}</p><p>${o.payment_type==='prepaid'?'مدفوع مسبقاً':money(o.amount_to_collect)} · ${esc(o.parcel_count||1)} قطعة</p><p>${esc(o.notes||'')}</p></div><img src="${qr}" alt="QR للطلب ${esc(o.order_code)}"></div>`
    qs('#storeOrderDetails').scrollIntoView({behavior:'smooth',block:'nearest'})
  })
}

init().catch(e=>{
  app.innerHTML=`<div class="auth-wrap"><div class="auth-card"><h2>خطأ تشغيل</h2><p>${esc(errText(e))}</p></div></div>`
})
