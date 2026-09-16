import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm'
import QRCode from 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm'
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js'

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)
const app = document.getElementById('app')
const toastEl = document.getElementById('toast')

let session = null
let profile = null
let stores = []
let captains = []
let profiles = []
let currentTab = 'home'

const roleLabels = {admin:'الإدارة',warehouse:'المخزن',pickup_captain:'كابتن جلب',delivery_captain:'كابتن توصيل',store_owner:'صاحب محل'}
const statusLabels = {new:'جديد',in_warehouse:'بالمخزن',assigned:'مع الكابتن',out_for_delivery:'بالطريق',delivered:'تم التسليم',postponed:'مؤجل',no_answer:'لا يرد',rejected:'مرفوض',returned_warehouse:'مرتجع للمخزن',returned_store:'مرتجع للمحل',cancelled:'ملغي'}
const statusClass = s => s==='delivered'?'green':(['returned_store','returned_warehouse','rejected','cancelled'].includes(s)?'red':(['assigned','out_for_delivery'].includes(s)?'blue':(['postponed','no_answer'].includes(s)?'orange':'purple')))
const money = v => `${Number(v||0).toFixed(2)} د.أ`
function normalizeJordanPhone(v){
  let p=String(v||'').trim().replace(/[\s\-()]/g,'')
  if(p.startsWith('00962')) p='+'+p.slice(2)
  else if(p.startsWith('962')) p='+'+p
  else if(p.startsWith('07')) p='+962'+p.slice(1)
  else if(p.startsWith('7')) p='+962'+p
  return p
}
function validJordanPhone(v){return /^\+9627\d{8}$/.test(v)}
const esc = v => String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))
const qs = (s,root=document)=>root.querySelector(s)
const qsa = (s,root=document)=>[...root.querySelectorAll(s)]

function toast(msg,type='ok'){toastEl.textContent=msg;toastEl.className=`toast show ${type}`;setTimeout(()=>toastEl.className='toast',2600)}
function errText(e){return e?.message || String(e || 'حدث خطأ')}

async function init(){
  if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{})
  const {data:{session:s}} = await supabase.auth.getSession(); session=s
  supabase.auth.onAuthStateChange((_evt,s)=>{session=s;boot()})
  await boot()
}

async function boot(){
  if(!session){profile=null;renderAuth();return}
  const {data,error}=await supabase.from('profiles').select('*').eq('id',session.user.id).single()
  if(error){renderPending('الحساب موجود لكن ملف المستخدم لم يجهز بعد. جرّب تسجيل خروج ودخول.');return}
  profile=data
  await loadCommon()
  renderShell()
  await openTab(defaultTab())
}

function defaultTab(){
  if(profile.role==='delivery_captain' || profile.role==='pickup_captain') return 'captain'
  if(profile.role==='store_owner') return 'owner'
  return 'home'
}

async function loadCommon(){
  if(['admin','warehouse'].includes(profile.role)){
    const [{data:s},{data:c},{data:p}] = await Promise.all([
      supabase.from('stores').select('*').order('name'),
      supabase.from('captains').select('id,captain_type,active,vehicle_label,profiles(full_name,phone)').eq('active',true),
      profile.role==='admin' ? supabase.from('profiles').select('*').order('created_at',{ascending:false}) : Promise.resolve({data:[]})
    ])
    stores=s||[];captains=c||[];profiles=p||[]
  }
}

let otpPhone = ''
let otpName = ''

function renderAuth(){
  app.innerHTML=`<div class="auth-wrap"><div class="auth-card">
    <div class="brand"><img src="/assets/logo.png" alt="Drop Off"><h1>Drop Off</h1><p>دخول آمن برقم الهاتف</p></div>
    <form id="phoneForm">
      <div class="field"><label>رقم الهاتف</label><input id="phone" inputmode="tel" autocomplete="tel" required placeholder="0791234567"></div>
      <div class="field"><label>الاسم <span class="muted">(أول مرة فقط)</span></label><input id="fullName" autocomplete="name" placeholder="الاسم الكامل"></div>
      <button class="btn btn-primary full" type="submit">إرسال رمز الدخول</button>
    </form>
    <div class="muted" style="margin-top:12px;text-align:center">سيصلك رمز من 6 أرقام على هاتفك.</div>
  </div></div>`
  qs('#phoneForm').onsubmit=async e=>{
    e.preventDefault()
    const phone=normalizeJordanPhone(qs('#phone').value)
    const full_name=qs('#fullName').value.trim()
    if(!validJordanPhone(phone)){toast('اكتب رقم أردني صحيح مثل 0791234567','error');return}
    try{
      const btn=qs('#phoneForm button[type="submit"]'); btn.disabled=true; btn.textContent='جاري إرسال الرمز...'
      const {error}=await supabase.auth.signInWithOtp({
        phone,
        options:{shouldCreateUser:true,data:{full_name:full_name||phone}}
      })
      if(error) throw error
      otpPhone=phone; otpName=full_name
      toast('تم إرسال رمز الدخول')
      renderOtp()
    }catch(e){toast(errText(e),'error');renderAuth()}
  }
}

function renderOtp(){
  const masked=otpPhone ? otpPhone.replace(/(\+9627\d{2})\d{4}(\d{2})/,'$1****$2') : ''
  app.innerHTML=`<div class="auth-wrap"><div class="auth-card">
    <div class="brand"><img src="/assets/logo.png" alt="Drop Off"><h1>تأكيد الرقم</h1><p>أدخل رمز الـ 6 أرقام المرسل إلى ${esc(masked)}</p></div>
    <form id="otpForm">
      <div class="field"><label>رمز التحقق</label><input id="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" minlength="6" pattern="[0-9]{6}" required placeholder="••••••" style="text-align:center;font-size:28px;letter-spacing:8px"></div>
      <button class="btn btn-primary full" type="submit">تأكيد ودخول</button>
    </form>
    <div class="auth-switch"><button id="resendOtp">إعادة إرسال الرمز</button> · <button id="changePhone">تغيير الرقم</button></div>
  </div></div>`
  qs('#otp').focus()
  qs('#otpForm').onsubmit=async e=>{
    e.preventDefault()
    const token=qs('#otp').value.trim().replace(/\D/g,'')
    if(token.length!==6){toast('الرمز لازم يكون 6 أرقام','error');return}
    try{
      const btn=qs('#otpForm button[type="submit"]'); btn.disabled=true; btn.textContent='جاري التحقق...'
      const {error}=await supabase.auth.verifyOtp({phone:otpPhone,token,type:'sms'})
      if(error) throw error
      toast('تم التحقق بنجاح')
    }catch(e){toast(errText(e),'error');qs('#otpForm button[type="submit"]').disabled=false;qs('#otpForm button[type="submit"]').textContent='تأكيد ودخول'}
  }
  qs('#resendOtp').onclick=async()=>{
    try{
      const {error}=await supabase.auth.signInWithOtp({phone:otpPhone,options:{shouldCreateUser:true,data:{full_name:otpName||otpPhone}}})
      if(error) throw error
      toast('تم إرسال رمز جديد')
    }catch(e){toast(errText(e),'error')}
  }
  qs('#changePhone').onclick=()=>{otpPhone='';otpName='';renderAuth()}
}

function renderPending(message){
  app.innerHTML=`<div class="auth-wrap"><div class="auth-card"><div class="brand"><img src="/assets/logo.png"><h1>Drop Off</h1></div><p>${esc(message)}</p><button id="logout" class="btn btn-red full">تسجيل خروج</button></div></div>`
  qs('#logout').onclick=()=>supabase.auth.signOut()
}

function navItems(){
  if(profile.role==='admin') return [['home','الرئيسية'],['add','إضافة أوردرات'],['orders','الأوردرات'],['assign','توزيع الأوردرات'],['stores','المحلات'],['users','المستخدمين'],['accounts','الحسابات']]
  if(profile.role==='warehouse') return [['home','الرئيسية'],['add','إضافة أوردرات'],['orders','الأوردرات'],['assign','توزيع الأوردرات'],['accounts','الحسابات']]
  if(profile.role==='store_owner') return [['owner','طلباتي وحسابي']]
  return [['captain','أوردراتي']]
}

function renderShell(){
  app.innerHTML=`<div class="shell"><aside class="sidebar">
    <div class="side-brand"><img src="/assets/logo.png"><div><strong>Drop Off</strong><small>${esc(roleLabels[profile.role]||profile.role)}</small></div></div>
    <div id="nav" class="nav">${navItems().map(([id,label])=>`<button data-tab="${id}">${label}</button>`).join('')}</div>
    <div class="side-foot"><div class="user-pill">${esc(profile.full_name||profile.phone||'مستخدم')}<small>${esc(profile.phone||'')}</small></div><button id="logout" class="btn btn-ghost full">تسجيل خروج</button></div>
  </aside><main class="main"><div class="topbar"><div><h2 id="pageTitle">Drop Off</h2><div class="muted" id="pageSub"></div></div><div class="actions"><button id="refresh" class="btn btn-ghost">↻ تحديث</button><button id="mobileLogout" class="btn btn-red mobile-only">خروج</button></div></div><section id="content"></section></main></div>`
  qsa('#nav button').forEach(b=>b.onclick=()=>openTab(b.dataset.tab))
  qs('#logout').onclick=()=>supabase.auth.signOut(); qs('#mobileLogout').onclick=()=>supabase.auth.signOut()
  qs('#refresh').onclick=()=>openTab(currentTab,true)
}

async function openTab(tab,force=false){
  currentTab=tab
  qsa('#nav button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab))
  const titles={home:'لوحة الإدارة',add:'إضافة أوردرات',orders:'إدارة الأوردرات',assign:'توزيع الأوردرات',stores:'المحلات',users:'المستخدمين والصلاحيات',accounts:'الحسابات والتسويات',captain:'أوردرات الكابتن',owner:'حساب المحل'}
  qs('#pageTitle').textContent=titles[tab]||'Drop Off';qs('#pageSub').textContent=new Date().toLocaleString('ar-JO')
  try{
    if(force) await loadCommon()
    if(tab==='home') return renderHome()
    if(tab==='add') return renderAddOrders()
    if(tab==='orders') return renderOrders()
    if(tab==='assign') return renderAssign()
    if(tab==='stores') return renderStores()
    if(tab==='users') return renderUsers()
    if(tab==='accounts') return renderAccounts()
    if(tab==='captain') return renderCaptain()
    if(tab==='owner') return renderOwner()
  }catch(e){qs('#content').innerHTML=`<div class="panel"><div class="empty">${esc(errText(e))}</div></div>`;toast(errText(e),'error')}
}

async function renderHome(){
  const {data:orders,error}=await supabase.from('orders').select('id,status,amount_to_collect,created_at'); if(error) throw error
  const count=s=>orders.filter(o=>o.status===s).length
  qs('#content').innerHTML=`<div class="grid stats">
    ${stat('إجمالي الأوردرات',orders.length)}${stat('بالمخزن',count('in_warehouse'))}${stat('مع الكباتن',count('assigned')+count('out_for_delivery'))}${stat('تم التسليم',count('delivered'))}${stat('مرتجع',count('returned_warehouse')+count('returned_store'))}
  </div><div class="panel"><div class="panel-head"><h3>آخر الأوردرات</h3></div><div id="latest"></div></div>`
  const ids=orders.slice().sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,10).map(x=>x.id)
  if(!ids.length){qs('#latest').innerHTML='<div class="empty">ما في أوردرات لسا.</div>';return}
  const {data}=await supabase.from('orders').select('id,order_code,status,area,amount_to_collect,store_id,created_at').in('id',ids).order('created_at',{ascending:false})
  qs('#latest').innerHTML=ordersTable(data||[])
}
function stat(label,value){return `<div class="stat"><span>${label}</span><b>${value}</b></div>`}

function storeName(id){return stores.find(s=>s.id===id)?.name||'—'}
function captainName(id){const c=captains.find(x=>x.id===id);return c?.profiles?.full_name||'—'}

function renderAddOrders(){
  if(!stores.length){qs('#content').innerHTML='<div class="panel"><div class="empty">أضف محل أولًا.</div></div>';return}
  qs('#content').innerHTML=`<div class="panel">
    <div class="form-grid"><div class="field"><label>المحل</label><select id="batchStore">${stores.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div><div class="field"><label>عدد الأوردرات</label><input id="batchCount" type="number" min="1" max="50" value="5"></div><div class="field"><label>&nbsp;</label><button id="buildRows" class="btn btn-blue">تجهيز الصفوف</button></div></div>
    <div id="orderRows"></div><div class="actions" style="margin-top:14px"><button id="saveBatch" class="btn btn-primary">حفظ الأوردرات وإنشاء QR</button></div>
  </div><div id="createdLabels" style="margin-top:14px"></div>`
  qs('#buildRows').onclick=buildOrderRows; qs('#saveBatch').onclick=saveBatch; buildOrderRows()
}
function buildOrderRows(){
  const n=Math.max(1,Math.min(50,Number(qs('#batchCount').value||1)))
  qs('#orderRows').innerHTML=`<div class="muted" style="margin:10px 0">أدخل بيانات ${n} أوردرات:</div>`+Array.from({length:n},(_,i)=>`<div class="order-row" data-i="${i}"><div class="idx">${i+1}</div><input data-f="customer_name" placeholder="اسم الزبون" required><input data-f="customer_phone" placeholder="رقم الهاتف" required><input data-f="area" placeholder="المنطقة" required><input data-f="address" placeholder="العنوان" required><input data-f="amount_to_collect" type="number" min="0" step="0.01" placeholder="المبلغ"><input data-f="notes" placeholder="ملاحظات"></div>`).join('')
}
async function saveBatch(){
  const store_id=qs('#batchStore').value; const rows=qsa('.order-row'); if(!rows.length)return
  const items=[]
  for(const row of rows){const get=f=>qs(`[data-f="${f}"]`,row)?.value.trim();const item={store_id,customer_name:get('customer_name'),customer_phone:get('customer_phone'),area:get('area'),address:get('address'),amount_to_collect:Number(get('amount_to_collect')||0),notes:get('notes')||null,status:'in_warehouse',created_by:profile.id};if(!item.customer_name||!item.customer_phone||!item.area||!item.address){toast('كمّل البيانات الأساسية لكل الأوردرات','error');return}items.push(item)}
  try{
    const {data:batch,error:bErr}=await supabase.from('order_batches').insert({store_id,expected_count:items.length,created_by:profile.id}).select().single();if(bErr)throw bErr
    items.forEach(x=>x.batch_id=batch.id)
    const {data,error}=await supabase.from('orders').insert(items).select('id,order_code,qr_token,customer_name,area,amount_to_collect');if(error)throw error
    toast(`تم حفظ ${data.length} أوردر`)
    qs('#createdLabels').innerHTML=`<div class="panel"><div class="panel-head"><h3>QR للأوردرات الجديدة</h3><button id="printAll" class="btn btn-primary">طباعة الكل</button></div><div class="cards">${data.map(o=>`<div class="card"><h4>${o.order_code}</h4><p>${esc(o.customer_name)} — ${esc(o.area)}</p><p>${money(o.amount_to_collect)}</p><button class="btn btn-sm btn-blue print-label" data-id="${o.id}" data-code="${o.order_code}" data-token="${o.qr_token}">طباعة QR</button></div>`).join('')}</div></div>`
    qsa('.print-label').forEach(b=>b.onclick=()=>printLabel({id:b.dataset.id,order_code:b.dataset.code,qr_token:b.dataset.token,store_id,customer_name:'',customer_phone:'',area:'',address:'',amount_to_collect:0}))
    qs('#printAll').onclick=()=>printLabels(data.map(o=>({...o,store_id})))
  }catch(e){toast(errText(e),'error')}
}

async function renderOrders(){
  qs('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>كل الأوردرات</h3><div class="toolbar"><input id="orderSearch" placeholder="بحث رقم أوردر / هاتف / منطقة"><select id="statusFilter"><option value="">كل الحالات</option>${Object.entries(statusLabels).map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select><button id="doSearch" class="btn btn-blue">بحث</button></div></div><div id="ordersTable"></div></div>`
  qs('#doSearch').onclick=loadOrdersTable;qs('#statusFilter').onchange=loadOrdersTable;qs('#orderSearch').onkeydown=e=>{if(e.key==='Enter')loadOrdersTable()};await loadOrdersTable()
}
async function loadOrdersTable(){
  let q=supabase.from('orders').select('*').order('created_at',{ascending:false}).limit(300);const st=qs('#statusFilter').value.trim(),s=qs('#orderSearch').value.trim();if(st)q=q.eq('status',st);if(s){if(s.toUpperCase().startsWith('DO-'))q=q.ilike('order_code',`%${s}%`);else q=q.or(`customer_phone.ilike.%${s}%,area.ilike.%${s}%,customer_name.ilike.%${s}%`)}const {data,error}=await q;if(error)throw error;qs('#ordersTable').innerHTML=ordersTable(data||[],true);bindOrderActions()
}
function ordersTable(data,actions=false){if(!data.length)return '<div class="empty">لا يوجد نتائج.</div>';return `<div class="table-wrap"><table class="table"><thead><tr><th>الأوردر</th><th>المحل</th><th>الزبون</th><th>الهاتف</th><th>المنطقة</th><th>المبلغ</th><th>الحالة</th><th>الكابتن</th>${actions?'<th>إجراءات</th>':''}</tr></thead><tbody>${data.map(o=>`<tr><td><b>${esc(o.order_code)}</b></td><td>${esc(storeName(o.store_id))}</td><td>${esc(o.customer_name||'—')}</td><td>${esc(o.customer_phone||'—')}</td><td>${esc(o.area||'—')}</td><td>${money(o.amount_to_collect)}</td><td><span class="badge ${statusClass(o.status)}">${esc(statusLabels[o.status]||o.status)}</span></td><td>${esc(captainName(o.delivery_captain_id))}</td>${actions?`<td><div class="actions"><button class="btn btn-sm btn-ghost view-order" data-id="${o.id}">تفاصيل</button><button class="btn btn-sm btn-blue qr-order" data-id="${o.id}">QR</button></div></td>`:''}</tr>`).join('')}</tbody></table></div>`}
function bindOrderActions(){qsa('.view-order').forEach(b=>b.onclick=()=>showOrder(b.dataset.id));qsa('.qr-order').forEach(b=>b.onclick=async()=>{const {data}=await supabase.from('orders').select('*').eq('id',b.dataset.id).single();if(data)printLabel(data)})}
async function showOrder(id){const {data:o,error}=await supabase.from('orders').select('*').eq('id',id).single();if(error)throw error;const {data:ev}=await supabase.from('order_events').select('*').eq('order_id',id).order('created_at',{ascending:false});qs('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>${o.order_code}</h3><button id="backOrders" class="btn btn-ghost">رجوع</button></div><div class="cards"><div class="card"><h4>بيانات الزبون</h4><p>${esc(o.customer_name)}</p><p>${esc(o.customer_phone)}</p><p>${esc(o.area)} — ${esc(o.address)}</p></div><div class="card"><h4>الحساب</h4><p class="money">${money(o.amount_to_collect)}</p><p>رسوم التوصيل: ${money(o.delivery_fee)}</p><p>رسوم المرتجع: ${money(o.return_fee)}</p></div><div class="card"><h4>الحالة</h4><span class="badge ${statusClass(o.status)}">${statusLabels[o.status]}</span><p>الكابتن: ${esc(captainName(o.delivery_captain_id))}</p><p>الرف: ${esc(o.shelf_location||'—')}</p></div></div><div class="panel" style="margin-top:14px"><h3>سجل الحركة</h3>${(ev||[]).map(x=>`<p><span class="badge">${new Date(x.created_at).toLocaleString('ar-JO')}</span> ${esc(x.event_type)} ${x.new_status?`→ ${esc(statusLabels[x.new_status]||x.new_status)}`:''} ${x.note?`— ${esc(x.note)}`:''}</p>`).join('')||'<div class="empty">لا يوجد سجل</div>'}</div></div>`;qs('#backOrders').onclick=()=>openTab('orders')}

async function renderAssign(){
  const [{data:orders,error},{data:capData}] = await Promise.all([supabase.from('orders').select('*').eq('status','in_warehouse').order('created_at'),supabase.from('captains').select('id,captain_type,active,profiles(full_name)').eq('active',true)]);if(error)throw error;captains=capData||captains
  qs('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>جاهز للتوزيع (${orders.length})</h3><div class="toolbar"><select id="assignCaptain"><option value="">اختر كابتن توصيل</option>${captains.filter(c=>['delivery','both'].includes(c.captain_type)).map(c=>`<option value="${c.id}">${esc(c.profiles?.full_name||c.id)}</option>`).join('')}</select><button id="assignSelected" class="btn btn-primary">تسليم المحدد للكابتن</button></div></div>${!orders.length?'<div class="empty">ما في أوردرات جاهزة للتوزيع.</div>':`<div class="table-wrap"><table class="table"><thead><tr><th><input id="checkAll" class="check" type="checkbox"></th><th>الأوردر</th><th>المحل</th><th>الزبون</th><th>المنطقة</th><th>المبلغ</th></tr></thead><tbody>${orders.map(o=>`<tr><td><input class="check order-check" type="checkbox" value="${o.id}"></td><td>${o.order_code}</td><td>${esc(storeName(o.store_id))}</td><td>${esc(o.customer_name)}</td><td>${esc(o.area)}</td><td>${money(o.amount_to_collect)}</td></tr>`).join('')}</tbody></table></div>`}</div>`
  if(qs('#checkAll'))qs('#checkAll').onchange=e=>qsa('.order-check').forEach(x=>x.checked=e.target.checked)
  qs('#assignSelected').onclick=async()=>{const captain=qs('#assignCaptain').value,ids=qsa('.order-check:checked').map(x=>x.value);if(!captain)return toast('اختر الكابتن','error');if(!ids.length)return toast('حدد أوردر واحد على الأقل','error');try{for(const id of ids){const {error}=await supabase.rpc('staff_assign_order',{p_order_id:id,p_captain_id:captain});if(error)throw error}toast(`تم تسليم ${ids.length} أوردر للكابتن`);renderAssign()}catch(e){toast(errText(e),'error')}}
}

async function renderStores(){
  if(profile.role!=='admin'){qs('#content').innerHTML='<div class="panel"><div class="empty">إدارة المحلات متاحة للأدمن.</div></div>';return}
  await loadCommon();qs('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>المحلات</h3><button id="newStore" class="btn btn-primary">+ محل جديد</button></div><div class="cards">${stores.map(s=>`<div class="card"><h4>${esc(s.name)}</h4><p>${esc(s.phone||'بدون هاتف')}</p><p>توصيل: ${money(s.delivery_fee)} | مرتجع: ${money(s.return_fee)}</p><button class="btn btn-sm btn-ghost edit-store" data-id="${s.id}">تعديل</button></div>`).join('')||'<div class="empty">لا يوجد محلات</div>'}</div></div>`;qs('#newStore').onclick=()=>storeForm();qsa('.edit-store').forEach(b=>b.onclick=()=>storeForm(stores.find(s=>s.id===b.dataset.id)))
}
function storeForm(s=null){qs('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>${s?'تعديل المحل':'إضافة محل'}</h3><button id="backStores" class="btn btn-ghost">رجوع</button></div><form id="storeForm" class="form-grid two"><div class="field"><label>اسم المحل</label><input id="sName" required value="${esc(s?.name||'')}"></div><div class="field"><label>الهاتف</label><input id="sPhone" value="${esc(s?.phone||'')}"></div><div class="field"><label>العنوان</label><input id="sAddress" value="${esc(s?.address||'')}"></div><div class="field"><label>رسوم التوصيل</label><input id="sDelivery" type="number" step="0.01" min="0" value="${Number(s?.delivery_fee||0)}"></div><div class="field"><label>رسوم المرتجع</label><input id="sReturn" type="number" step="0.01" min="0" value="${Number(s?.return_fee||0)}"></div><div class="field"><label>&nbsp;</label><button class="btn btn-primary" type="submit">حفظ</button></div></form></div>`;qs('#backStores').onclick=()=>renderStores();qs('#storeForm').onsubmit=async e=>{e.preventDefault();const row={name:qs('#sName').value.trim(),phone:qs('#sPhone').value.trim()||null,address:qs('#sAddress').value.trim()||null,delivery_fee:Number(qs('#sDelivery').value||0),return_fee:Number(qs('#sReturn').value||0)};const r=s?await supabase.from('stores').update(row).eq('id',s.id):await supabase.from('stores').insert(row);if(r.error)return toast(errText(r.error),'error');toast('تم حفظ المحل');await loadCommon();renderStores()}}

async function renderUsers(){
  if(profile.role!=='admin'){qs('#content').innerHTML='<div class="panel"><div class="empty">للأدمن فقط.</div></div>';return}
  await loadCommon();qs('#content').innerHTML=`<div class="panel"><h3>الحسابات المسجلة</h3><div class="table-wrap"><table class="table"><thead><tr><th>الاسم</th><th>رقم الهاتف</th><th>الدور</th><th>إجراء</th></tr></thead><tbody>${profiles.map(p=>`<tr><td>${esc(p.full_name||'—')}</td><td>${esc(p.phone||'—')}</td><td><span class="badge">${esc(roleLabels[p.role]||p.role)}</span></td><td><button class="btn btn-sm btn-blue manage-user" data-id="${p.id}">إدارة</button></td></tr>`).join('')}</tbody></table></div></div>`;qsa('.manage-user').forEach(b=>b.onclick=()=>manageUser(profiles.find(p=>p.id===b.dataset.id)))
}
function manageUser(u){qs('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>${esc(u.full_name||u.phone)}</h3><button id="backUsers" class="btn btn-ghost">رجوع</button></div><div class="form-grid two"><div class="field"><label>الدور</label><select id="uRole"><option value="store_owner">صاحب محل</option><option value="delivery_captain">كابتن توصيل</option><option value="pickup_captain">كابتن جلب</option><option value="warehouse">مخزن</option><option value="admin">أدمن</option></select></div><div class="field"><label>نوع الكابتن</label><select id="uCaptain"><option value="delivery">توصيل</option><option value="pickup">جلب</option><option value="both">الاثنين</option></select></div><div class="field"><label>&nbsp;</label><button id="saveRole" class="btn btn-primary">حفظ الصلاحية</button></div><div class="field"><label>ربط بمحل</label><select id="uStore"><option value="">بدون</option>${stores.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div><div class="field"><label>&nbsp;</label><button id="linkStore" class="btn btn-blue">ربط الحساب بالمحل</button></div></div></div>`;qs('#uRole').value=u.role;qs('#backUsers').onclick=()=>renderUsers();qs('#saveRole').onclick=async()=>{const r=await supabase.rpc('admin_set_user_role',{p_user_id:u.id,p_role:qs('#uRole').value,p_captain_type:qs('#uCaptain').value});if(r.error)return toast(errText(r.error),'error');toast('تم تحديث الصلاحية');await loadCommon()};qs('#linkStore').onclick=async()=>{const st=qs('#uStore').value;if(!st)return toast('اختر المحل','error');const r=await supabase.rpc('admin_link_user_to_store',{p_user_id:u.id,p_store_id:st,p_is_owner:true});if(r.error)return toast(errText(r.error),'error');toast('تم ربط الحساب بالمحل')}}

async function renderAccounts(){
  const [{data:sb,error:e1},{data:cb,error:e2}] = await Promise.all([supabase.from('store_balance_summary').select('*').order('store_name'),supabase.from('captain_cash_summary').select('*')]);if(e1)throw e1;if(e2)throw e2
  qs('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>حسابات المحلات</h3></div><div class="cards">${(sb||[]).map(x=>`<div class="card"><h4>${esc(x.store_name)}</h4><p>تم التسليم: ${x.delivered_orders} | مرتجع: ${x.returned_orders}</p><p>تحصيلات: ${money(x.collections)}</p><p>رسوم: ${money(Number(x.delivery_fees)+Number(x.return_fees))}</p><p>تم الدفع: ${money(x.paid_out)}</p><div class="money">${money(x.balance_due)}</div><button class="btn btn-sm btn-green settle-store" data-id="${x.store_id}">تسجيل دفعة للمحل</button></div>`).join('')||'<div class="empty">لا توجد بيانات</div>'}</div></div><div class="panel" style="margin-top:14px"><h3>عهدة الكباتن</h3><div class="cards">${(cb||[]).map(x=>`<div class="card"><h4>${esc(x.full_name||'كابتن')}</h4><p>تحصيل: ${money(x.cash_collected)}</p><p>سلّم: ${money(x.cash_handed_over)}</p><div class="money">${money(x.cash_due)}</div><button class="btn btn-sm btn-blue handover" data-id="${x.captain_id}">تسجيل تسليم كاش</button></div>`).join('')||'<div class="empty">لا يوجد كباتن بعد</div>'}</div></div>`
  qsa('.settle-store').forEach(b=>b.onclick=()=>simpleAmount('مبلغ الدفعة للمحل',async amount=>supabase.from('store_settlements').insert({store_id:b.dataset.id,amount,created_by:profile.id})))
  qsa('.handover').forEach(b=>b.onclick=()=>simpleAmount('المبلغ الذي سلّمه الكابتن',async amount=>supabase.from('captain_handovers').insert({captain_id:b.dataset.id,amount,created_by:profile.id})))
}
function simpleAmount(label,fn){const v=prompt(label);if(v===null)return;const amount=Number(v);if(!(amount>0))return toast('المبلغ غير صحيح','error');fn(amount).then(r=>{if(r.error)toast(errText(r.error),'error');else{toast('تم التسجيل');renderAccounts()}})}

async function renderCaptain(){
  const {data,error}=await supabase.from('orders').select('*').eq('delivery_captain_id',profile.id).not('status','in','("delivered","returned_store","cancelled")').order('assigned_at',{ascending:false});if(error)throw error
  qs('#content').innerHTML=`<div>${!data.length?'<div class="panel"><div class="empty">ما عندك أوردرات حالياً.</div></div>':data.map(o=>`<div class="captain-order"><div class="head"><div><h4>${o.order_code} — ${esc(o.area)}</h4><p>${esc(o.customer_name)} | ${esc(o.customer_phone)}</p><p>${esc(o.address)}</p><p class="muted">${esc(o.notes||'')}</p></div><div class="price">${money(o.amount_to_collect)}</div></div><div class="quick"><a class="btn btn-sm btn-blue" href="tel:${esc(o.customer_phone)}">📞 اتصال</a><a class="btn btn-sm btn-green" href="https://wa.me/962${esc(o.customer_phone).replace(/^0/,'')}" target="_blank">واتساب</a><a class="btn btn-sm btn-ghost" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.address+' '+o.area)}" target="_blank">📍 خريطة</a><button class="btn btn-sm btn-primary cap-status" data-id="${o.id}" data-st="delivered">تم التسليم</button><button class="btn btn-sm btn-ghost cap-status" data-id="${o.id}" data-st="out_for_delivery">بالطريق</button><button class="btn btn-sm btn-ghost cap-status" data-id="${o.id}" data-st="postponed">مؤجل</button><button class="btn btn-sm btn-ghost cap-status" data-id="${o.id}" data-st="no_answer">لا يرد</button><button class="btn btn-sm btn-red cap-status" data-id="${o.id}" data-st="returned_warehouse">إرجاع للمخزن</button></div></div>`).join('')}</div>`
  qsa('.cap-status').forEach(b=>b.onclick=async()=>{const r=await supabase.rpc('captain_set_order_status',{p_order_id:b.dataset.id,p_status:b.dataset.st,p_note:null});if(r.error)return toast(errText(r.error),'error');toast('تم تحديث الحالة');renderCaptain()})
}

async function renderOwner(){
  const {data:links,error:lerr}=await supabase.from('store_users').select('store_id,stores(id,name)').eq('user_id',profile.id);if(lerr)throw lerr
  if(!links?.length){qs('#content').innerHTML='<div class="panel"><div class="empty">حسابك مسجل، لكن الإدارة لسا ما ربطته بمحل. خلي الأدمن يربط حسابك بالمحل.</div></div>';return}
  const storeIds=links.map(x=>x.store_id)
  const [{data:bal},{data:orders,error}] = await Promise.all([supabase.from('store_balance_summary').select('*').in('store_id',storeIds),supabase.from('orders').select('*').in('store_id',storeIds).order('created_at',{ascending:false}).limit(300)]);if(error)throw error
  const b=(bal||[])[0]||{}
  qs('#content').innerHTML=`<div class="owner-summary">${stat('إجمالي الأوردرات',orders.length)}${stat('تم التسليم',orders.filter(o=>o.status==='delivered').length)}${stat('مرتجع',orders.filter(o=>o.status==='returned_store').length)}<div class="stat"><span>المبلغ المستحق لك</span><b>${money(b.balance_due||0)}</b></div></div><div class="panel"><div class="panel-head"><h3>أوردرات المحل</h3><span class="muted">تحصيلات ${money(b.collections||0)} — رسوم ${money(Number(b.delivery_fees||0)+Number(b.return_fees||0))}</span></div>${ordersTable(orders)}</div>`
}

async function printLabel(o){
  const full= o.customer_name ? o : (await supabase.from('orders').select('*').eq('id',o.id).single()).data
  const url=`${location.origin}/?q=${full.qr_token}`;const dataUrl=await QRCode.toDataURL(url,{width:260,margin:1,errorCorrectionLevel:'M'});const w=window.open('','_blank','width=480,height=720');w.document.write(labelHtml(full,dataUrl));w.document.close();setTimeout(()=>w.print(),400)
}
async function printLabels(list){
  const detailed=[];for(const o of list){const {data}=await supabase.from('orders').select('*').eq('id',o.id).single();if(data)detailed.push(data)}const blocks=[];for(const o of detailed){const url=`${location.origin}/?q=${o.qr_token}`;blocks.push(labelHtml(o,await QRCode.toDataURL(url,{width:240,margin:1}),true))}const w=window.open('','_blank');w.document.write(`<html dir="rtl"><head><style>body{font-family:Arial;display:flex;flex-wrap:wrap;gap:10px}.label{width:300px;border:1px dashed #444;padding:12px;text-align:center;break-inside:avoid}.label img{width:170px}.brand{font-weight:bold;font-size:22px}</style></head><body>${blocks.join('')}</body></html>`);w.document.close();setTimeout(()=>w.print(),500)
}
function labelHtml(o,qr,fragment=false){const body=`<div class="label"><div class="brand">DROP OFF</div><div>${esc(o.order_code)}</div><img src="${qr}"><div><b>${esc(storeName(o.store_id))}</b></div><div>${esc(o.customer_name||'')}</div><div>${esc(o.customer_phone||'')}</div><div>${esc(o.area||'')} — ${esc(o.address||'')}</div><div><b>${money(o.amount_to_collect)}</b></div><small>كل طلب ... يوصل لوجهته</small></div>`;if(fragment)return body;return `<html dir="rtl"><head><style>body{font-family:Arial;display:grid;place-items:center}.label{width:300px;border:1px solid #222;padding:14px;text-align:center}.label img{width:190px}.brand{font-weight:bold;font-size:24px}</style></head><body>${body}</body></html>`}

init().catch(e=>{app.innerHTML=`<div class="auth-wrap"><div class="auth-card"><h2>خطأ تشغيل</h2><p>${esc(errText(e))}</p></div></div>`})
