const $=(s,r=document)=>r.querySelector(s)
const $$=(s,r=document)=>[...r.querySelectorAll(s)]
const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt',"'":'&#39;','"':'&quot;'}[c]))
const money=v=>`${Number(v||0).toFixed(2)} د.أ`
const fmt=d=>d?new Date(d).toLocaleString('ar-JO'):'—'
const pct=v=>`${Number(v||0).toFixed(1)}%`

async function edge(ctx,name,body={}){
  const {data:{session}}=await ctx.supabase.auth.getSession()
  if(!session?.access_token)throw new Error('انتهت جلسة الدخول')
  const r=await fetch(`${ctx.supabaseUrl}/functions/v1/${name}`,{
    method:'POST',
    headers:{'content-type':'application/json','apikey':ctx.publishableKey,'authorization':`Bearer ${session.access_token}`},
    body:JSON.stringify(body)
  })
  const d=await r.json().catch(()=>({}))
  if(!r.ok)throw new Error(d?.error||'تعذر تنفيذ العملية')
  return d
}
function button(label,cls='btn btn-ghost',attrs=''){return `<button class="${cls}" type="button" ${attrs}>${label}</button>`}
function kpi(label,value,sub=''){return `<div class="ops-card ops-kpi"><span>${esc(label)}</span><b>${esc(value)}</b>${sub?`<small>${esc(sub)}</small>`:''}</div>`}
function statusChip(v){return v?'<span class="ops-chip good">● شغال</span>':'<span class="ops-chip bad">● متوقف</span>'}
function renderError(el,e){el.innerHTML=`<div class="ops-warning">⚠️ ${esc(e?.message||e)}</div>`}

export async function renderOpsSuite(ctx){
  const root=ctx.content
  if(ctx.profile.role!=='admin'){
    root.innerHTML='<div class="panel"><div class="empty">مركز العمليات متاح للإدارة فقط.</div></div>'
    return
  }
  root.innerHTML=`<div class="ops-wrap">
    <section class="ops-hero">
      <div><span class="eyebrow">DROP OFF OPERATING SYSTEM</span><h3>⚡ مركز العمليات والتطوير</h3><p>المخزن، الاستثناءات، التوزيع الذكي، التحليلات، الصلاحيات، الـAPI، النسخ الاحتياطي والذكاء الاصطناعي في مكان واحد.</p></div>
      <div class="ops-actions">${button('＋ أوردر','btn btn-primary','data-jump="add"')}${button('🏷️ الملصقات','btn btn-ghost','data-jump="stickers"')}${button('💰 الحسابات','btn btn-ghost','data-jump="accounts"')}</div>
    </section>
    <nav class="ops-tabs">
      <button class="active" data-ops-tab="overview">الرئيسية</button>
      <button data-ops-tab="exceptions">الاستثناءات</button>
      <button data-ops-tab="warehouse">المخزن والمسح</button>
      <button data-ops-tab="dispatch">التوزيع الذكي</button>
      <button data-ops-tab="intelligence">الذكاء والتحليلات</button>
      <button data-ops-tab="integrations">الأسعار و API</button>
      <button data-ops-tab="security">الأمان والتدقيق</button>
      <button data-ops-tab="system">النظام والنسخ</button>
      <button data-ops-tab="training">التدريب</button>
    </nav>
    <div id="opsBody"></div>
  </div>`
  $$('[data-jump]',root).forEach(b=>b.onclick=()=>ctx.openTab(b.dataset.jump))
  const buttons=$$('[data-ops-tab]',root)
  const open=async tab=>{
    buttons.forEach(b=>b.classList.toggle('active',b.dataset.opsTab===tab))
    const body=$('#opsBody',root);body.innerHTML='<div class="panel"><div class="empty">جاري التحميل...</div></div>'
    try{
      if(tab==='overview')await renderOverview(ctx,body)
      else if(tab==='exceptions')await renderExceptions(ctx,body)
      else if(tab==='warehouse')await renderWarehouse(ctx,body)
      else if(tab==='dispatch')await renderDispatch(ctx,body)
      else if(tab==='intelligence')await renderIntelligence(ctx,body)
      else if(tab==='integrations')await renderIntegrations(ctx,body)
      else if(tab==='security')await renderSecurity(ctx,body)
      else if(tab==='system')await renderSystem(ctx,body)
      else if(tab==='training')renderTraining(ctx,body)
    }catch(e){renderError(body,e)}
  }
  buttons.forEach(b=>b.onclick=()=>open(b.dataset.opsTab))
  await open('overview')
}

async function renderOverview(ctx,body){
  const [{data:metrics},{count:exceptions},{data:flags},{data:backup},{data:close},{data:cash}]=await Promise.all([
    ctx.supabase.from('daily_ops_metrics').select('*').maybeSingle(),
    ctx.supabase.from('order_exceptions').select('id',{count:'exact',head:true}).is('resolved_at',null),
    ctx.supabase.from('feature_flags').select('key,enabled,description').is('store_id',null).order('key'),
    ctx.supabase.from('backup_snapshots').select('snapshot_date,created_at').order('created_at',{ascending:false}).limit(1),
    ctx.supabase.from('accounting_closures').select('business_date,closed_at,cash_shortage').order('closed_at',{ascending:false}).limit(1),
    ctx.supabase.from('captain_cash_summary').select('captain_id,full_name,cash_collected,cash_handed_over,cash_due').order('cash_due',{ascending:false}).limit(20)
  ])
  const m=metrics||{}
  body.innerHTML=`
    <div class="ops-grid">
      ${kpi('أوردرات اليوم',m.created_today||0)}
      ${kpi('تم التسليم اليوم',m.delivered_today||0)}
      ${kpi('بالمخزن الآن',m.in_warehouse_now||0)}
      ${kpi('استثناءات مفتوحة',exceptions||0)}
      ${kpi('تحصيل اليوم',money(m.collections_today||0))}
      ${kpi('رسوم اليوم',money(m.delivery_fees_today||0))}
      ${kpi('مع الكباتن الآن',m.with_captains_now||0)}
      ${kpi('آخر نسخة منطقية',backup?.[0]?.snapshot_date||'لا يوجد')}
    </div>
    <section class="ops-section ops-ai">
      <div class="ops-section-head"><div><h3>🤖 ملخص اليوم الذكي</h3><p class="muted">يُحفظ مرة واحدة لليوم ويمكن تحديثه يدوياً.</p></div>${button('تحديث الملخص','btn btn-blue','id="refreshDailySummary"')}</div>
      <div id="dailySummary"><div class="ops-empty">جاري تجهيز الملخص...</div></div>
    </section>
    <section class="ops-section">
      <div class="ops-section-head"><div><h3>💵 عهدة الكباتن</h3><p class="muted">الكاش المحصّل، المسلم للمحاسب، والمتبقي على كل كابتن.</p></div><span class="ops-chip">${(cash||[]).filter(x=>Number(x.cash_due||0)>0).length} عليهم عهدة</span></div>
      <div class="ops-list">${(cash||[]).map(x=>`<div class="ops-list-row"><div><strong>${esc(x.full_name||'كابتن')}</strong><small>محصّل ${money(x.cash_collected)} · سلّم ${money(x.cash_handed_over)}</small></div><span class="ops-chip ${Number(x.cash_due||0)>0?'warn':'good'}">المتبقي ${money(x.cash_due)}</span></div>`).join('')||'<div class="ops-empty">لا توجد عهد كباتن.</div>'}</div>
    </section>
    <section class="ops-section">
      <div class="ops-section-head"><h3>حالة المزايا</h3><span class="ops-chip">${flags?.length||0} ميزة</span></div>
      <div class="ops-flags-grid">${(flags||[]).map(f=>`<div class="ops-toggle-row"><label>${esc(f.description||f.key)}<small style="display:block;color:#8192a1">${esc(f.key)}</small></label>${statusChip(f.enabled)}</div>`).join('')}</div>
    </section>
    <section class="ops-section">
      <div class="ops-section-head"><h3>متابعة الإدارة</h3></div>
      <div class="ops-grid">
        <div class="ops-card"><h4>التسكير اليومي</h4><p>آخر تسكير: ${esc(close?.[0]?.business_date||'لم يتم')}</p>${button('فتح الحسابات','btn btn-primary','id="openAccounting"')}</div>
        <div class="ops-card"><h4>الملصقات</h4><p>إدارة الرولات والأكواد الجاهزة للمحلات.</p>${button('إدارة الملصقات','btn btn-blue','id="openStickers"')}</div>
        <div class="ops-card"><h4>الإدخال الذكي</h4><p>يدوي + صورة AI + Excel/CSV + API للمحلات.</p>${button('إضافة أوردر','btn btn-blue','id="openAdd"')}</div>
        <div class="ops-card"><h4>الاستثناءات</h4><p>طلبات متأخرة أو مكررة أو تحتاج تدخل.</p>${button('فتح الاستثناءات','btn btn-ghost','id="openExceptions"')}</div>
      </div>
    </section>`
  $('#openAccounting',body).onclick=()=>ctx.openTab('accounts')
  $('#openStickers',body).onclick=()=>ctx.openTab('stickers')
  $('#openAdd',body).onclick=()=>ctx.openTab('add')
  $('#openExceptions',body).onclick=()=>$$('[data-ops-tab]',ctx.content).find(x=>x.dataset.opsTab==='exceptions')?.click()
  const loadSummary=async force=>{
    const out=$('#dailySummary',body)
    out.innerHTML='<div class="ops-empty">جاري تشغيل الذكاء الاصطناعي...</div>'
    try{
      const d=await edge(ctx,'daily-ops-summary',{force:Boolean(force)})
      out.innerHTML=`<div class="ops-summary">${esc(d.summary?.summary||'لا يوجد ملخص')}</div><small class="muted">آخر تحديث: ${fmt(d.summary?.generated_at)}</small>`
    }catch(e){renderError(out,e)}
  }
  $('#refreshDailySummary',body).onclick=()=>loadSummary(true)
  loadSummary(false)
}

async function renderExceptions(ctx,body){
  body.innerHTML=`<section class="ops-section"><div class="ops-section-head"><div><h3>🚨 Exception Center</h3><p class="muted">يفحص الطلبات العالقة والمكررة تلقائياً.</p></div><div class="ops-actions">${button('فحص الآن','btn btn-primary','id="refreshExceptions"')}${button('تحديث','btn btn-ghost','id="reloadExceptions"')}</div></div><div id="exceptionList"></div></section>`
  const load=async()=>{
    const out=$('#exceptionList',body);out.innerHTML='<div class="ops-empty">جاري التحميل...</div>'
    const {data,error}=await ctx.supabase.from('order_exceptions')
      .select('id,reason,next_action,resolved_at,created_at,order_id,orders(order_code,area,status,customer_phone,stores(name))')
      .is('resolved_at',null).order('created_at',{ascending:false}).limit(200)
    if(error)throw error
    out.innerHTML=data?.length?`<div class="ops-list">${data.map(e=>`<div class="ops-list-row">
      <div><strong>${esc(e.orders?.order_code||'طلب')} · ${esc(e.reason)}</strong><small>${esc(e.orders?.stores?.name||'—')} · ${esc(e.orders?.area||'—')} · ${esc(e.orders?.status||'—')}<br>${esc(e.next_action||'بدون إجراء محدد')} · ${fmt(e.created_at)}</small></div>
      <div class="ops-actions">${button('فتح الطلب','btn btn-sm btn-blue',`data-open-order="${e.orders?.order_code||''}"`)}${button('تم الحل','btn btn-sm btn-green',`data-resolve="${e.id}"`)}</div>
    </div>`).join('')}</div>`:'<div class="ops-empty">✅ ما في استثناءات مفتوحة.</div>'
    $$('[data-resolve]',out).forEach(b=>b.onclick=async()=>{
      const {error}=await ctx.supabase.from('order_exceptions').update({resolved_at:new Date().toISOString()}).eq('id',b.dataset.resolve)
      if(error)return ctx.toast(error.message,'error');ctx.toast('تم إغلاق الاستثناء');load()
    })
    $$('[data-open-order]',out).forEach(b=>b.onclick=()=>{
      history.replaceState(null,'',`${location.pathname}?order=${encodeURIComponent(b.dataset.openOrder)}`)
      ctx.openTab('orders')
    })
  }
  $('#refreshExceptions',body).onclick=async()=>{
    const {data,error}=await ctx.supabase.rpc('refresh_order_exceptions')
    if(error)return ctx.toast(error.message,'error');ctx.toast(`تم الفحص · ${data||0} تنبيه جديد`);load()
  }
  $('#reloadExceptions',body).onclick=load
  await load()
}

async function renderWarehouse(ctx,body){
  const [{data:shelves},{data:branches}]=await Promise.all([
    ctx.supabase.from('warehouse_shelves').select('*,branches(name)').order('code'),
    ctx.supabase.from('branches').select('*').eq('active',true).order('name')
  ])
  body.innerHTML=`
    <section class="ops-section">
      <div class="ops-section-head"><div><h3>📦 وضع المسح السريع</h3><p class="muted">امسح/اكتب رقم الأوردر أو QR ثم اختر الحركة. مناسب للباركود سكانر بدون ماوس.</p></div></div>
      <div class="ops-scan-box">
        <div><label>الكود</label><input id="scanCode" class="ops-input" autofocus placeholder="DO-000001 أو QR"></div>
        <div><label>الحركة</label><select id="scanAction" class="ops-select"><option value="pickup">استلام من المحل</option><option value="warehouse_in">دخول المخزن</option><option value="assign_shelf">تحديد رف</option><option value="warehouse_out">خروج للتوصيل</option><option value="delivery">تم التسليم</option><option value="return_in">دخول مرتجع</option><option value="return_store">تسليم مرتجع للمحل</option></select></div>
        <div><label>الرف</label><select id="scanShelf" class="ops-select"><option value="">بدون رف</option>${(shelves||[]).filter(x=>x.active).map(s=>`<option value="${esc(s.code)}">${esc(s.code)} · ${esc(s.zone||'')}</option>`).join('')}</select></div>
        ${button('تنفيذ','btn btn-primary','id="doScan"')}
      </div>
      <div id="scanResult"></div>
    </section>
    <section class="ops-section">
      <div class="ops-section-head"><h3>🗂️ خريطة الرفوف</h3></div>
      <form id="shelfForm" class="ops-toolbar">
        <select id="shelfBranch" class="ops-select">${(branches||[]).map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select>
        <input id="shelfCode" class="ops-input" required placeholder="مثال A-03-12">
        <input id="shelfZone" class="ops-input" placeholder="المنطقة/الصف">
        <input id="shelfCapacity" class="ops-input" type="number" min="1" placeholder="السعة">
        <button class="btn btn-blue">إضافة رف</button>
      </form>
      <div class="ops-list" style="margin-top:12px">${(shelves||[]).map(s=>`<div class="ops-list-row"><div><strong>${esc(s.code)}</strong><small>${esc(s.branches?.name||'')} · ${esc(s.zone||'بدون منطقة')} · سعة ${esc(s.capacity||'غير محددة')}</small></div><span class="ops-chip ${s.active?'good':'bad'}">${s.active?'فعال':'موقوف'}</span></div>`).join('')||'<div class="ops-empty">لا توجد رفوف بعد.</div>'}</div>
    </section>`
  const doScan=async()=>{
    const code=$('#scanCode',body).value.trim();if(!code)return
    const {data,error}=await ctx.supabase.rpc('scan_order_transition',{p_code:code,p_action:$('#scanAction',body).value,p_shelf_code:$('#scanShelf',body).value||null})
    if(error){ctx.toast(error.message,'error');return}
    $('#scanResult',body).innerHTML=`<div class="ops-scan-result">✓ ${esc(data.order_code)} · الحالة: ${esc(data.status)} · الرف: ${esc(data.shelf_location||'—')}</div>`
    $('#scanCode',body).value='';$('#scanCode',body).focus()
  }
  $('#doScan',body).onclick=doScan
  $('#scanCode',body).onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();doScan()}}
  $('#shelfForm',body).onsubmit=async e=>{
    e.preventDefault()
    const payload={branch_id:$('#shelfBranch',body).value,code:$('#shelfCode',body).value.trim(),zone:$('#shelfZone',body).value.trim()||null,capacity:Number($('#shelfCapacity',body).value)||null}
    const {error}=await ctx.supabase.from('warehouse_shelves').insert(payload)
    if(error)return ctx.toast(error.message,'error');ctx.toast('تمت إضافة الرف');renderWarehouse(ctx,body)
  }
}

async function renderDispatch(ctx,body){
  body.innerHTML=`<section class="ops-section">
    <div class="ops-section-head"><div><h3>🧭 Dispatcher ذكي</h3><p class="muted">يرتب كباتن التوصيل حسب السعة الحالية والخبرة في نفس المنطقة.</p></div></div>
    <div class="ops-toolbar"><input id="dispatchOrder" class="ops-input" placeholder="رقم الأوردر DO-...">${button('اقترح الكباتن','btn btn-primary','id="suggestCaptains"')}</div>
    <div id="dispatchOut" style="margin-top:12px"></div>
  </section>`
  $('#suggestCaptains',body).onclick=async()=>{
    const code=$('#dispatchOrder',body).value.trim(),out=$('#dispatchOut',body)
    if(!code)return
    out.innerHTML='<div class="ops-empty">جاري التحليل...</div>'
    const {data:order,error}=await ctx.supabase.from('orders').select('id,order_code,area,status,delivery_captain_id,stores(name)').eq('order_code',code).maybeSingle()
    if(error||!order){out.innerHTML='<div class="ops-warning">الطلب غير موجود.</div>';return}
    const {data,error:sErr}=await ctx.supabase.rpc('suggest_captains_for_order',{p_order_id:order.id})
    if(sErr)throw sErr
    out.innerHTML=`<div class="ops-warning">الطلب ${esc(order.order_code)} · ${esc(order.stores?.name||'')} · ${esc(order.area)}</div><div class="ops-list" style="margin-top:9px">${(data||[]).map((c,i)=>`<div class="ops-list-row">
      <div><strong>#${i+1} ${esc(c.full_name||'كابتن')} · مؤشر ${esc(c.recommendation_score)}</strong><small>معه الآن ${c.active_orders}/${c.daily_capacity} · نفذ ${c.area_affinity} طلب بنفس المنطقة آخر 30 يوم</small></div>
      ${button('تعيين','btn btn-sm btn-green',`data-assign="${c.captain_id}"`)}
    </div>`).join('')||'<div class="ops-empty">لا يوجد كباتن متاحون.</div>'}</div>`
    $$('[data-assign]',out).forEach(b=>b.onclick=async()=>{
      const {error}=await ctx.supabase.from('orders').update({delivery_captain_id:b.dataset.assign,status:'assigned',assigned_at:new Date().toISOString()}).eq('id',order.id)
      if(error)return ctx.toast(error.message,'error');ctx.toast('تم تعيين الكابتن');$('#suggestCaptains',body).click()
    })
  }
}

async function renderIntelligence(ctx,body){
  const [stores,captains,areas]=await Promise.all([
    ctx.supabase.from('store_operational_metrics').select('*').order('orders_30d',{ascending:false}).limit(50),
    ctx.supabase.from('captain_operational_metrics').select('*').order('delivered_30d',{ascending:false}).limit(50),
    ctx.supabase.from('area_performance_30d').select('*').order('total_orders',{ascending:false}).limit(50)
  ])
  body.innerHTML=`
    <section class="ops-section ops-ai">
      <div class="ops-section-head"><div><h3>🤖 مساعد عمليات Drop Off</h3><p class="muted">اسأله عن التشغيل والأرقام والاستثناءات؛ لا ينفذ تغييرات على البيانات.</p></div></div>
      <textarea id="opsQuestion" class="ops-textarea" placeholder="مثال: شو أهم المشاكل اليوم؟ مين عليه كاش؟ وين أكثر مناطق عندنا؟"></textarea>
      <div class="ops-actions" style="margin-top:8px">${button('اسأل المساعد','btn btn-primary','id="askOps"')}</div>
      <div id="opsAnswer"></div>
    </section>
    <section class="ops-section"><div class="ops-section-head"><h3>🏪 مؤشرات المحلات</h3></div><div class="ops-table-scroll"><table class="ops-metric-table"><thead><tr><th>المحل</th><th>30 يوم</th><th>تسليم</th><th>مشاكل</th><th>نسبة التسليم</th><th>مؤشر تشغيلي</th></tr></thead><tbody>
      ${(stores.data||[]).map(x=>`<tr><td>${esc(x.name)}</td><td>${x.orders_30d}</td><td>${x.delivered_30d}</td><td>${x.problem_30d}</td><td>${pct(x.delivery_rate)}</td><td><div class="ops-meter"><i style="width:${Math.max(0,Math.min(100,Number(x.operational_index||0)))}%"></i></div> ${x.operational_index}</td></tr>`).join('')}
    </tbody></table></div></section>
    <section class="ops-section"><div class="ops-section-head"><h3>🛵 مؤشرات الكباتن</h3></div><div class="ops-table-scroll"><table class="ops-metric-table"><thead><tr><th>الكابتن</th><th>تسليم 30 يوم</th><th>نشط الآن</th><th>نسبة التسليم</th><th>المؤشر</th></tr></thead><tbody>
      ${(captains.data||[]).map(x=>`<tr><td>${esc(x.full_name)}</td><td>${x.delivered_30d}</td><td>${x.active_orders}</td><td>${pct(x.delivery_rate)}</td><td>${x.operational_index}</td></tr>`).join('')}
    </tbody></table></div></section>
    <section class="ops-section"><div class="ops-section-head"><h3>🔥 Heatmap المناطق — 30 يوم</h3></div><div class="ops-list">
      ${(areas.data||[]).map(x=>`<div class="ops-list-row"><div><strong>${esc(x.area)}</strong><small>${x.total_orders} طلب · ${x.delivered_orders} تسليم · ${x.problem_orders} مشاكل · متوسط ${x.avg_delivery_hours||0} ساعة</small></div><span class="ops-chip">${money(x.fees_earned)}</span></div>`).join('')||'<div class="ops-empty">لا توجد بيانات كافية.</div>'}
    </div></section>`
  $('#askOps',body).onclick=async()=>{
    const q=$('#opsQuestion',body).value.trim(),out=$('#opsAnswer',body);if(!q)return
    out.innerHTML='<div class="ops-empty">جاري تحليل بيانات التشغيل...</div>'
    try{const d=await edge(ctx,'ops-assistant',{question:q});out.innerHTML=`<div class="ops-ai-answer">${esc(d.answer||'')}</div>`}catch(e){renderError(out,e)}
  }
}

async function renderIntegrations(ctx,body){
  const [{data:rules},{data:keys},{data:rolls},{data:branches}]=await Promise.all([
    ctx.supabase.from('pricing_rules').select('*,stores(name),branches(name)').order('created_at',{ascending:false}).limit(100),
    ctx.supabase.from('store_api_keys').select('id,store_id,key_prefix,label,active,created_at,last_used_at,stores(name)').order('created_at',{ascending:false}),
    ctx.supabase.from('sticker_rolls').select('id,roll_code,quantity,status,start_serial,end_serial,store_id,stores(name)').order('created_at',{ascending:false}).limit(50),
    ctx.supabase.from('branches').select('*').eq('active',true).order('name')
  ])
  body.innerHTML=`
    <section class="ops-section">
      <div class="ops-section-head"><div><h3>💵 التسعير المرن</h3><p class="muted">حسب المحل/الفرع/المنطقة/نوع الخدمة/الأولوية/عدد القطع. إذا ما في قاعدة، يرجع لسعر المنطقة ثم سعر المحل.</p></div></div>
      <form id="pricingForm" class="ops-toolbar">
        <select id="prStore" class="ops-select"><option value="">كل المحلات</option>${ctx.stores.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
        <select id="prBranch" class="ops-select"><option value="">كل الفروع</option>${(branches||[]).map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select>
        <input id="prArea" class="ops-input" placeholder="المنطقة أو فارغ">
        <select id="prService" class="ops-select"><option value="standard">Standard</option><option value="same_day">Same Day</option><option value="express">Express</option><option value="pickup_only">Pickup Only</option><option value="return">Return</option></select>
        <select id="prSize" class="ops-select"><option value="">كل الأحجام</option><option value="small">صغير</option><option value="medium">متوسط</option><option value="large">كبير</option><option value="xl">XL</option></select>
        <input id="prFee" class="ops-input" type="number" step=".01" min="0" required placeholder="رسم التوصيل">
        <input id="prReturn" class="ops-input" type="number" step=".01" min="0" value="0" placeholder="رسم المرتجع">
        <button class="btn btn-primary">إضافة قاعدة</button>
      </form>
      <div class="ops-list" style="margin-top:12px">${(rules||[]).map(r=>`<div class="ops-list-row"><div><strong>${esc(r.stores?.name||'كل المحلات')} · ${esc(r.area||'كل المناطق')} · ${esc(r.service_type)}</strong><small>${esc(r.branches?.name||'كل الفروع')} · ${r.min_parcels}-${r.max_parcels} قطعة · ${esc(r.package_size||'كل الأحجام')}</small></div><div class="ops-actions"><span class="ops-chip good">${money(r.delivery_fee)}</span>${button('حذف','btn btn-sm btn-red',`data-del-rule="${r.id}"`)}</div></div>`).join('')||'<div class="ops-empty">لا توجد قواعد خاصة.</div>'}</div>
    </section>
    <section class="ops-section">
      <div class="ops-section-head"><div><h3>🔌 API للمحلات الكبيرة</h3><p class="muted">المفتاح يظهر مرة واحدة عند الإنشاء. لا تشاركه علناً.</p></div></div>
      <div class="ops-toolbar"><select id="apiStore" class="ops-select">${ctx.stores.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select><input id="apiLabel" class="ops-input" value="Main API" placeholder="اسم المفتاح">${button('إنشاء API Key','btn btn-blue','id="createApiKey"')}</div>
      <div id="apiKeyOnce"></div>
      <div class="ops-list" style="margin-top:12px">${(keys||[]).map(k=>`<div class="ops-list-row"><div><strong>${esc(k.stores?.name||'')} · ${esc(k.label||'API')}</strong><small>${esc(k.key_prefix)}… · آخر استخدام ${fmt(k.last_used_at)}</small></div><div class="ops-actions"><span class="ops-chip ${k.active?'good':'bad'}">${k.active?'فعال':'موقوف'}</span>${k.active?button('إلغاء','btn btn-sm btn-red',`data-revoke-key="${k.id}"`):''}</div></div>`).join('')||'<div class="ops-empty">لا توجد مفاتيح API.</div>'}</div>
      <div class="ops-code" style="margin-top:10px">POST ${ctx.supabaseUrl}/functions/v1/store-api-order<br>x-api-key: do_live_...<br>{ "customer_name":"Ahmad", "customer_phone":"079...", "area":"خلدا", "address":"...", "amount_to_collect":15, "service_type":"express", "package_size":"medium" }</div>
    </section>
    <section class="ops-section">
      <div class="ops-section-head"><h3>🏷️ مخزون الاستكرات</h3>${button('فتح شاشة الطباعة','btn btn-ghost','id="goStickers"')}</div>
      <div class="ops-list">${(rolls||[]).map(r=>`<div class="ops-list-row"><div><strong>${esc(r.roll_code||('ROLL-'+r.id.slice(0,6)))} · ${esc(r.stores?.name||'غير مخصص')}</strong><small>${r.quantity} استكر · ${r.start_serial||'—'} → ${r.end_serial||'—'}</small></div><span class="ops-chip ${r.status==='ready'?'good':''}">${esc(r.status)}</span></div>`).join('')||'<div class="ops-empty">لا توجد رولات.</div>'}</div>
    </section>`
  $('#pricingForm',body).onsubmit=async e=>{
    e.preventDefault()
    const payload={store_id:$('#prStore',body).value||null,branch_id:$('#prBranch',body).value||null,area:$('#prArea',body).value.trim()||null,service_type:$('#prService',body).value,package_size:$('#prSize',body).value||null,delivery_fee:Number($('#prFee',body).value),return_fee:Number($('#prReturn',body).value||0),created_by:ctx.profile.id}
    const {error}=await ctx.supabase.from('pricing_rules').insert(payload)
    if(error)return ctx.toast(error.message,'error');ctx.toast('تمت إضافة قاعدة التسعير');renderIntegrations(ctx,body)
  }
  $$('[data-del-rule]',body).forEach(b=>b.onclick=async()=>{if(!confirm('حذف قاعدة التسعير؟'))return;const {error}=await ctx.supabase.from('pricing_rules').delete().eq('id',b.dataset.delRule);if(error)return ctx.toast(error.message,'error');renderIntegrations(ctx,body)})
  $('#createApiKey',body).onclick=async()=>{
    try{
      const d=await edge(ctx,'admin-store-api-key',{store_id:$('#apiStore',body).value,label:$('#apiLabel',body).value})
      $('#apiKeyOnce',body).innerHTML=`<div class="ops-warning" style="margin-top:10px"><strong>انسخ المفتاح الآن — لن يظهر مرة ثانية:</strong><div class="ops-api-key">${esc(d.api_key)}</div></div>`
      ctx.toast('تم إنشاء المفتاح')
    }catch(e){ctx.toast(e.message,'error')}
  }
  $$('[data-revoke-key]',body).forEach(b=>b.onclick=async()=>{if(!confirm('إلغاء هذا المفتاح؟'))return;const {error}=await ctx.supabase.from('store_api_keys').update({active:false}).eq('id',b.dataset.revokeKey);if(error)return ctx.toast(error.message,'error');renderIntegrations(ctx,body)})
  $('#goStickers',body).onclick=()=>ctx.openTab('stickers')
}

async function renderSecurity(ctx,body){
  const [{data:audit},{data:events},{data:settings},{data:people},{data:flags}]=await Promise.all([
    ctx.supabase.from('audit_logs').select('*').order('created_at',{ascending:false}).limit(100),
    ctx.supabase.from('security_events').select('*').order('created_at',{ascending:false}).limit(50),
    ctx.supabase.from('security_settings').select('*').eq('id',true).maybeSingle(),
    ctx.supabase.from('profiles').select('id,full_name,username,phone,role,active').order('full_name'),
    ctx.supabase.from('feature_flags').select('*').is('store_id',null).order('key')
  ])
  const perms=['orders.edit','dispatch.manage','warehouse.manage','finance.read','finance.write','exceptions.manage','audit.read','settings.manage']
  body.innerHTML=`
    <section class="ops-section"><div class="ops-section-head"><h3>🔐 حماية الدخول</h3></div>
      <form id="securityForm" class="ops-toolbar"><label>المحاولات <input id="secMax" class="ops-input" type="number" min="2" max="20" value="${settings?.max_failed_attempts||5}"></label><label>نافذة الدقائق <input id="secWindow" class="ops-input" type="number" min="1" max="120" value="${settings?.window_minutes||15}"></label><label>مدة القفل <input id="secLock" class="ops-input" type="number" min="1" max="1440" value="${settings?.lock_minutes||15}"></label><button class="btn btn-primary">حفظ</button></form>
      <div class="ops-list" style="margin-top:12px">${(events||[]).map(e=>`<div class="ops-list-row"><div><strong>${esc(e.event_type)}</strong><small>${fmt(e.created_at)} · ${esc(e.subject||'')}</small></div><span class="ops-chip ${e.severity==='critical'?'bad':e.severity==='warning'?'warn':'good'}">${esc(e.severity)}</span></div>`).join('')||'<div class="ops-empty">لا توجد تنبيهات أمنية.</div>'}</div>
    </section>
    <section class="ops-section"><div class="ops-section-head"><h3>🧩 الصلاحيات الدقيقة</h3></div>
      <div class="ops-toolbar"><select id="permUser" class="ops-select">${(people||[]).filter(p=>p.role!=='admin').map(p=>`<option value="${p.id}">${esc(p.full_name||p.username||p.phone)} · ${esc(p.role)}</option>`).join('')}</select>${button('تحميل الصلاحيات','btn btn-blue','id="loadPerms"')}</div>
      <div id="permGrid" class="ops-perm-grid" style="margin-top:10px">${perms.map(p=>`<div class="ops-toggle-row"><label>${esc(p)}</label><input type="checkbox" data-perm="${p}"></div>`).join('')}</div>
    </section>
    <section class="ops-section"><div class="ops-section-head"><h3>🚩 Feature Flags</h3></div><div class="ops-flags-grid">${(flags||[]).map(f=>`<div class="ops-toggle-row"><label>${esc(f.description||f.key)}<small style="display:block;color:#8192a1">${esc(f.key)}</small></label><input type="checkbox" data-flag="${f.id}" ${f.enabled?'checked':''}></div>`).join('')}</div></section>
    <section class="ops-section"><div class="ops-section-head"><h3>🧾 Audit Log</h3></div><div class="ops-list">${(audit||[]).map(a=>`<div class="ops-list-row"><div><strong>${esc(a.entity_table)} · ${esc(a.action)}</strong><small>${fmt(a.created_at)} · ${esc(a.entity_id||'')}</small></div><span class="ops-chip">${esc(a.actor_id?.slice(0,8)||'system')}</span></div>`).join('')||'<div class="ops-empty">السجل فارغ.</div>'}</div></section>`
  $('#securityForm',body).onsubmit=async e=>{e.preventDefault();const {error}=await ctx.supabase.from('security_settings').update({max_failed_attempts:Number($('#secMax',body).value),window_minutes:Number($('#secWindow',body).value),lock_minutes:Number($('#secLock',body).value),updated_by:ctx.profile.id,updated_at:new Date().toISOString()}).eq('id',true);if(error)return ctx.toast(error.message,'error');ctx.toast('تم حفظ إعدادات الأمان')}
  const loadPerms=async()=>{
    const user=$('#permUser',body).value;if(!user)return
    const {data}=await ctx.supabase.from('profile_permissions').select('permission').eq('user_id',user)
    const set=new Set((data||[]).map(x=>x.permission));$$('[data-perm]',body).forEach(x=>x.checked=set.has(x.dataset.perm))
  }
  $('#loadPerms',body).onclick=loadPerms
  $$('[data-perm]',body).forEach(ch=>ch.onchange=async()=>{
    const user=$('#permUser',body).value;if(!user)return
    if(ch.checked){const {error}=await ctx.supabase.from('profile_permissions').upsert({user_id:user,permission:ch.dataset.perm,granted_by:ctx.profile.id});if(error){ch.checked=false;ctx.toast(error.message,'error')}}
    else{const {error}=await ctx.supabase.from('profile_permissions').delete().eq('user_id',user).eq('permission',ch.dataset.perm);if(error){ch.checked=true;ctx.toast(error.message,'error')}}
  })
  $$('[data-flag]',body).forEach(ch=>ch.onchange=async()=>{const {error}=await ctx.supabase.from('feature_flags').update({enabled:ch.checked,updated_by:ctx.profile.id,updated_at:new Date().toISOString()}).eq('id',ch.dataset.flag);if(error){ch.checked=!ch.checked;ctx.toast(error.message,'error')}})
  loadPerms()
}

async function renderSystem(ctx,body){
  const [{data:branches},{data:backups}]=await Promise.all([
    ctx.supabase.from('branches').select('*').order('created_at'),
    ctx.supabase.from('backup_snapshots').select('id,snapshot_date,created_at').order('created_at',{ascending:false}).limit(15)
  ])
  body.innerHTML=`
    <section class="ops-section">
      <div class="ops-section-head"><h3>❤️ Health Dashboard</h3>${button('فحص الآن','btn btn-primary','id="runHealth"')}</div>
      <div id="healthOut"><div class="ops-empty">اضغط فحص الآن.</div></div>
    </section>
    <section class="ops-section">
      <div class="ops-section-head"><div><h3>🏢 الفروع</h3><p class="muted">النظام صار جاهز لأكثر من فرع بدون إعادة بناء قاعدة البيانات.</p></div></div>
      <form id="branchForm" class="ops-toolbar"><input id="branchCode" class="ops-input" placeholder="CODE مثل ZARQA" required><input id="branchName" class="ops-input" placeholder="اسم الفرع" required><input id="branchCity" class="ops-input" placeholder="المدينة"><button class="btn btn-blue">إضافة فرع</button></form>
      <div class="ops-list" style="margin-top:10px">${(branches||[]).map(b=>`<div class="ops-list-row"><div><strong>${esc(b.name)} · ${esc(b.code)}</strong><small>${esc(b.city||'')} · ${b.is_default?'الفرع الافتراضي':''}</small></div><span class="ops-chip ${b.active?'good':'bad'}">${b.active?'فعال':'موقوف'}</span></div>`).join('')}</div>
      <div class="ops-grid" style="margin-top:12px">
        <div class="ops-card"><h4>تعيين محل لفرع</h4><div class="ops-toolbar"><select id="branchStore" class="ops-select">${ctx.stores.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select><select id="branchStoreTarget" class="ops-select">${(branches||[]).filter(b=>b.active).map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select>${button('حفظ','btn btn-sm btn-blue','id="saveStoreBranch"')}</div></div>
        <div class="ops-card"><h4>تعيين كابتن لفرع</h4><div class="ops-toolbar"><select id="branchCaptain" class="ops-select">${ctx.captains.map(c=>`<option value="${c.id}">${esc(c.profiles?.full_name||c.profiles?.username||c.id)}</option>`).join('')}</select><select id="branchCaptainTarget" class="ops-select">${(branches||[]).filter(b=>b.active).map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select>${button('حفظ','btn btn-sm btn-blue','id="saveCaptainBranch"')}</div></div>
      </div>
    </section>
    <section class="ops-section">
      <div class="ops-section-head"><div><h3>💾 النسخ الاحتياطي والاستعادة</h3><p class="muted">نسخة منطقية يومية داخل Supabase لمدة 14 يوم + تنزيل نسخة JSON عند الطلب. يفضّل أيضاً تفعيل Backup خارجي على مستوى السيرفر/قاعدة البيانات.</p></div><div class="ops-actions">${button('إنشاء وتنزيل نسخة الآن','btn btn-primary','id="downloadBackup"')}</div></div>
      <div class="ops-list">${(backups||[]).map(b=>`<div class="ops-list-row"><div><strong>${esc(b.snapshot_date)}</strong><small>${fmt(b.created_at)}</small></div><span class="ops-chip good">محفوظة</span></div>`).join('')||'<div class="ops-empty">لا توجد نسخ بعد.</div>'}</div>
    </section>
    <section class="ops-section">
      <div class="ops-section-head"><h3>📱 App / PWA</h3></div>
      <div class="ops-grid"><div class="ops-card"><h4>تثبيت كتطبيق</h4><p>الموقع مجهز Manifest + Service Worker ويمكن إضافته للشاشة الرئيسية.</p></div><div class="ops-card"><h4>Offline Queue</h4><p>طلبات المحل يمكن حفظها مؤقتاً على الجهاز عند انقطاع الإنترنت ثم إرسالها بعد عودته.</p></div><div class="ops-card"><h4>الكاميرا</h4><p>تصوير أوردر بالـAI ومسح QR من الهاتف.</p></div><div class="ops-card"><h4>جاهز للتطبيق Native</h4><p>نفس Supabase وAPI يمكن استخدامهم لاحقاً لتطبيق مستقل.</p></div></div>
    </section>`
  $('#runHealth',body).onclick=async()=>{
    const out=$('#healthOut',body);out.innerHTML='<div class="ops-empty">جاري الفحص...</div>'
    try{
      const [edgeHealth,webHealth]=await Promise.all([
        edge(ctx,'system-health',{}),
        fetch('/health',{cache:'no-store'}).then(r=>r.ok?r.json():Promise.reject(new Error('Web health failed'))).catch(()=>null)
      ])
      const db=edgeHealth.database||{}
      out.innerHTML=`<div class="ops-health">
        <div class="ops-card"><i class="ops-dot ${webHealth?'':'bad'}"></i><h4>الموقع / VPS</h4><p>${webHealth?'شغال':'لم يستجب'}</p></div>
        <div class="ops-card"><i class="ops-dot ${db.database?'':'bad'}"></i><h4>Supabase DB</h4><p>${db.database?'شغال':'مشكلة اتصال'}</p></div>
        <div class="ops-card"><i class="ops-dot ${edgeHealth.edge_runtime?'':'bad'}"></i><h4>Edge Functions</h4><p>${edgeHealth.edge_runtime?'شغالة':'مشكلة'}</p></div>
        <div class="ops-card"><i class="ops-dot ${edgeHealth.openai_configured?'':'warn'}"></i><h4>OpenAI</h4><p>${edgeHealth.openai_configured?'المفتاح موجود':'المفتاح غير موجود'}</p></div>
      </div><div class="ops-warning" style="margin-top:10px">أوردرات: ${db.orders||0} · محلات: ${db.stores||0} · كباتن: ${db.captains||0} · استثناءات: ${db.open_exceptions||0} · آخر Backup: ${fmt(db.last_backup)}</div>`
    }catch(e){renderError(out,e)}
  }
  $('#branchForm',body).onsubmit=async e=>{e.preventDefault();const {error}=await ctx.supabase.from('branches').insert({code:$('#branchCode',body).value.trim().toUpperCase(),name:$('#branchName',body).value.trim(),city:$('#branchCity',body).value.trim()||null});if(error)return ctx.toast(error.message,'error');ctx.toast('تمت إضافة الفرع');renderSystem(ctx,body)}
  if($('#branchStore',body)){
    const store=ctx.stores.find(s=>s.id===$('#branchStore',body).value);if(store?.branch_id)$('#branchStoreTarget',body).value=store.branch_id
    $('#branchStore',body).onchange=()=>{const s=ctx.stores.find(x=>x.id===$('#branchStore',body).value);if(s?.branch_id)$('#branchStoreTarget',body).value=s.branch_id}
    $('#saveStoreBranch',body).onclick=async()=>{const id=$('#branchStore',body).value,branch_id=$('#branchStoreTarget',body).value;const {error}=await ctx.supabase.from('stores').update({branch_id}).eq('id',id);if(error)return ctx.toast(error.message,'error');const s=ctx.stores.find(x=>x.id===id);if(s)s.branch_id=branch_id;ctx.toast('تم تعيين المحل للفرع')}
  }
  if($('#branchCaptain',body)){
    const captain=ctx.captains.find(x=>x.id===$('#branchCaptain',body).value);if(captain?.branch_id)$('#branchCaptainTarget',body).value=captain.branch_id
    $('#branchCaptain',body).onchange=()=>{const x=ctx.captains.find(v=>v.id===$('#branchCaptain',body).value);if(x?.branch_id)$('#branchCaptainTarget',body).value=x.branch_id}
    $('#saveCaptainBranch',body).onclick=async()=>{const id=$('#branchCaptain',body).value,branch_id=$('#branchCaptainTarget',body).value;const {error}=await ctx.supabase.from('captains').update({branch_id}).eq('id',id);if(error)return ctx.toast(error.message,'error');const x=ctx.captains.find(v=>v.id===id);if(x)x.branch_id=branch_id;ctx.toast('تم تعيين الكابتن للفرع')}
  }
  $('#downloadBackup',body).onclick=async()=>{
    try{
      const {data:{session}}=await ctx.supabase.auth.getSession()
      const r=await fetch(`${ctx.supabaseUrl}/functions/v1/admin-backup-export`,{method:'POST',headers:{'content-type':'application/json','apikey':ctx.publishableKey,'authorization':`Bearer ${session.access_token}`},body:'{}'})
      if(!r.ok)throw new Error('تعذر إنشاء النسخة')
      const blob=await r.blob(),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`dropoff-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);ctx.toast('تم إنشاء النسخة')
    }catch(e){ctx.toast(e.message,'error')}
  }
}

function renderTraining(ctx,body){
  body.innerHTML=`<section class="ops-section ops-demo">
    <div class="ops-section-head"><div><h3>🎓 وضع التدريب Demo</h3><p class="muted">بيانات وهمية فقط لتدريب الموظف؛ لا يكتب أي شيء في قاعدة البيانات.</p></div><span class="ops-chip warn">DEMO</span></div>
    <div class="ops-demo-flow">
      <div class="ops-demo-step"><b>1</b>المحل ينشئ الطلب</div>
      <div class="ops-demo-step"><b>2</b>كابتن الجلب يستلمه</div>
      <div class="ops-demo-step"><b>3</b>مسح دخول المخزن</div>
      <div class="ops-demo-step"><b>4</b>توزيع على كابتن</div>
      <div class="ops-demo-step"><b>5</b>تسليم + كاش + تسكير</div>
    </div>
    <div class="ops-card" style="margin-top:12px"><h4>طلب تدريبي DO-DEMO-001</h4><p>أحمد · خلدا · 15.00 د.أ · حالة: بالمخزن · رف A-03-12</p><div class="ops-actions">${button('محاكاة مسح المخزن','btn btn-blue','id="demoScan"')}${button('محاكاة التوزيع','btn btn-ghost','id="demoDispatch"')}${button('محاكاة التسليم','btn btn-green','id="demoDeliver"')}</div><div id="demoResult"></div></div>
  </section>`
  const result=$('#demoResult',body)
  $('#demoScan',body).onclick=()=>result.innerHTML='<div class="ops-scan-result">Demo: تم تسجيل دخول الطلب للمخزن بدون تعديل البيانات الحقيقية.</div>'
  $('#demoDispatch',body).onclick=()=>result.innerHTML='<div class="ops-scan-result">Demo: تم اقتراح الكابتن الأقل حملاً.</div>'
  $('#demoDeliver',body).onclick=()=>result.innerHTML='<div class="ops-scan-result">Demo: تم التسليم وإضافة التحصيل لعهدة الكابتن.</div>'
}

export function attachGlobalSearch(ctx,container){
  if(!container||container.querySelector('.ops-global-search'))return
  const wrap=document.createElement('div');wrap.className='ops-global-search'
  wrap.innerHTML='<input id="globalOpsSearch" placeholder="بحث سريع: أوردر / هاتف / محل / كابتن"><div class="ops-search-pop" id="globalOpsResults"></div>'
  container.prepend(wrap)
  const input=$('#globalOpsSearch',wrap),out=$('#globalOpsResults',wrap)
  let timer
  input.oninput=()=>{
    clearTimeout(timer);const q=input.value.trim();if(q.length<2){out.innerHTML='';return}
    timer=setTimeout(async()=>{
      const {data,error}=await ctx.supabase.rpc('ops_command_search',{p_query:q})
      if(error){out.innerHTML='';return}
      const items=[
        ...(data?.orders||[]).map(x=>({type:'order',label:`${x.order_code} · ${x.customer_name||''}`,sub:`${x.customer_phone||''} · ${x.area||''} · ${x.status||''}`,code:x.order_code})),
        ...(data?.stores||[]).map(x=>({type:'store',label:`🏪 ${x.name}`,sub:x.phone||x.address||''})),
        ...(data?.people||[]).map(x=>({type:'person',label:`👤 ${x.full_name||x.username||x.phone}`,sub:`${x.role} · ${x.phone||''}`}))
      ]
      out.innerHTML=items.length?items.map((x,i)=>`<button class="ops-search-item" data-result="${i}"><strong>${esc(x.label)}</strong><small>${esc(x.sub)}</small></button>`).join(''):'<div class="ops-empty">لا توجد نتائج</div>'
      $$('[data-result]',out).forEach(b=>b.onclick=()=>{const x=items[Number(b.dataset.result)];out.innerHTML='';input.value='';if(x.type==='order'){history.replaceState(null,'',`${location.pathname}?order=${encodeURIComponent(x.code)}`);ctx.openTab('orders')}else ctx.openTab(x.type==='store'?'stores':'users')})
    },260)
  }
  input.onkeydown=e=>{if(e.key==='Escape'){out.innerHTML='';input.blur()}}
  document.addEventListener('click',e=>{if(!wrap.contains(e.target))out.innerHTML=''})
}
