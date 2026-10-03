import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
}

const allowedRoles = new Set(['store_owner','owner','admin','manager'])

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: cors })
}

function outputText(payload: any) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim()
  for (const item of payload?.output || []) {
    if (item?.type !== 'message') continue
    for (const part of item?.content || []) {
      if (part?.type === 'output_text' && typeof part?.text === 'string') return part.text.trim()
    }
  }
  return ''
}

function parseJsonText(value: string) {
  let text = String(value || '').trim()
  text = text.replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/,'').trim()
  try { return JSON.parse(text) } catch {}
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) return JSON.parse(text.slice(first, last + 1))
  throw new Error('invalid_ai_json')
}

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    customer_name: { type: ['string','null'] },
    customer_phone: { type: ['string','null'] },
    area: { type: ['string','null'] },
    address: { type: ['string','null'] },
    amount_to_collect: { type: ['number','null'] },
    payment_type: { type: ['string','null'], enum: ['cod','prepaid',null] },
    parcel_count: { type: ['integer','null'], minimum: 1, maximum: 100 },
    priority: { type: ['string','null'], enum: ['normal','urgent',null] },
    notes: { type: ['string','null'] },
    overall_confidence: { type: 'number', minimum: 0, maximum: 1 },
    uncertain_fields: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    raw_text: { type: ['string','null'] },
    confidence: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customer_name: { type: 'number', minimum: 0, maximum: 1 },
        customer_phone: { type: 'number', minimum: 0, maximum: 1 },
        area: { type: 'number', minimum: 0, maximum: 1 },
        address: { type: 'number', minimum: 0, maximum: 1 },
        amount_to_collect: { type: 'number', minimum: 0, maximum: 1 },
        payment_type: { type: 'number', minimum: 0, maximum: 1 },
        parcel_count: { type: 'number', minimum: 0, maximum: 1 },
        priority: { type: 'number', minimum: 0, maximum: 1 },
        notes: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['customer_name','customer_phone','area','address','amount_to_collect','payment_type','parcel_count','priority','notes']
    }
  },
  required: ['customer_name','customer_phone','area','address','amount_to_collect','payment_type','parcel_count','priority','notes','overall_confidence','uncertain_fields','warnings','raw_text','confidence']
}

const instructions = `
أنت محلل صور أوردرات لشركة توصيل أردنية اسمها Drop Off.
اقرأ صورة ورقة واحدة فيها معلومات طلب مكتوبة بخط اليد أو مطبوعة بالعربي أو الإنجليزي.
استخرج البيانات فقط مما يظهر بالصورة، ولا تخمّن أي معلومة غير واضحة.

القواعد:
- customer_name: اسم الزبون فقط.
- customer_phone: رقم الهاتف كما يظهر، وحوّل الأرقام العربية ٠١٢٣٤٥٦٧٨٩ إلى أرقام إنجليزية.
- area: اسم المنطقة/الحي/المدينة القصير.
- address: العنوان التفصيلي بدون تكرار المنطقة إذا أمكن.
- amount_to_collect: مبلغ التحصيل بالدينار الأردني كرقم. إذا مكتوب "مدفوع" أو "prepaid" اجعله 0.
- payment_type: prepaid فقط إذا واضح أن الطلب مدفوع مسبقاً، وإلا cod إذا يوجد تحصيل واضح، وإلا null.
- parcel_count: عدد القطع/الأكياس إذا مذكور، وإلا null.
- priority: urgent فقط إذا يوجد "مستعجل/urgent"، normal إذا واضح أنه عادي، وإلا null.
- notes: أي تعليمات مثل "اتصل قبل الوصول"، الطابق، لون الباب، وقت معين، إلخ.
- raw_text: نسخ مختصر للنص الذي استطعت قراءته.
- ضع confidence من 0 إلى 1 لكل حقل، وضع أي حقل أقل من 0.70 داخل uncertain_fields.
- إذا الرقم أو المبلغ غير واضح، لا تخمّن؛ أعد null وحذّر المستخدم في warnings.
- أعد كائن JSON فقط.
`

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const authHeader = req.headers.get('Authorization') || ''
    const token = authHeader.replace(/^Bearer\s+/i, '')
    if (!token) return json({ error: 'unauthorized' }, 401)

    const admin = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false }
    })

    const { data: userData, error: userErr } = await admin.auth.getUser(token)
    if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401)

    const { data: caller } = await admin.from('profiles').select('role,active').eq('id', userData.user.id).single()
    if (!caller || caller.active !== true || !allowedRoles.has(caller.role)) {
      return json({ error: 'not_allowed' }, 403)
    }

    const body = await req.json()
    const imageDataUrl = String(body?.image_data_url || '')
    const storeId = String(body?.store_id || '')

    if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(imageDataUrl)) {
      return json({ error: 'invalid_image' }, 400)
    }
    if (imageDataUrl.length > 8_500_000) return json({ error: 'image_too_large' }, 413)

    if (caller.role === 'store_owner') {
      if (!storeId) return json({ error: 'store_required' }, 400)
      const { data: membership } = await admin.from('store_users')
        .select('store_id')
        .eq('user_id', userData.user.id)
        .eq('store_id', storeId)
        .maybeSingle()
      if (!membership) return json({ error: 'store_not_allowed' }, 403)
    }

    const [{data:storeInfo},{data:knownRates}] = await Promise.all([
      admin.from('stores').select('name').eq('id',storeId).maybeSingle(),
      admin.from('area_rates').select('area').or(`store_id.eq.${storeId},store_id.is.null`).order('area').limit(200)
    ])
    const knownAreas=[...new Set((knownRates||[]).map((r:any)=>String(r.area||'').trim()).filter(Boolean))]
    const contextualInstructions = instructions + `
سياق إضافي:
- اسم المحل: ${storeInfo?.name||'غير محدد'}.
- المناطق المعروفة في نظام Drop Off لهذا المحل/النظام: ${knownAreas.join('، ')||'لا توجد قائمة'}.
- إذا كانت المنطقة المكتوبة قريبة جداً وواضحة من اسم موجود في القائمة، استخدم الاسم القياسي من القائمة. لا تفعل ذلك إذا كانت القراءة غير مؤكدة.
`

    const apiKey = Deno.env.get('OPENAI_API_KEY')
    if (!apiKey) return json({ error: 'ai_not_configured' }, 503)

    const model = Deno.env.get('OPENAI_ORDER_VISION_MODEL') || 'gpt-6-luna'
    const baseBody: any = {
      model,
      store: false,
      max_output_tokens: 1100,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: contextualInstructions },
          { type: 'input_image', image_url: imageDataUrl, detail: 'high' }
        ]
      }]
    }

    const callOpenAI = async (structured: boolean) => {
      const requestBody = structured ? {
        ...baseBody,
        text: {
          format: {
            type: 'json_schema',
            name: 'dropoff_order_photo',
            strict: true,
            schema
          }
        }
      } : baseBody

      return fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      })
    }

    let aiRes = await callOpenAI(true)
    if (!aiRes.ok && aiRes.status === 400) aiRes = await callOpenAI(false)

    const aiPayload = await aiRes.json().catch(() => ({}))
    if (!aiRes.ok) {
      console.error('OpenAI order photo error', aiRes.status, aiPayload?.error?.code || aiPayload?.error?.message || 'unknown')
      return json({ error: 'ai_analysis_failed' }, 502)
    }

    const text = outputText(aiPayload)
    if (!text) return json({ error: 'empty_ai_result' }, 502)

    const parsed = parseJsonText(text)
    const arabicDigits=(v:any)=>String(v??'').replace(/[٠-٩]/g,(d:string)=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    let parsedArea=parsed.area==null?null:String(parsed.area).trim()
    if(parsedArea){
      const exact=knownAreas.find(a=>a.toLocaleLowerCase('ar')===parsedArea!.toLocaleLowerCase('ar'))
      if(exact)parsedArea=exact
    }
    const safe = {
      customer_name: parsed.customer_name ?? null,
      customer_phone: parsed.customer_phone==null?null:arabicDigits(parsed.customer_phone),
      area: parsedArea,
      address: parsed.address ?? null,
      amount_to_collect: Number.isFinite(Number(parsed.amount_to_collect)) ? Number(parsed.amount_to_collect) : null,
      payment_type: ['cod','prepaid'].includes(parsed.payment_type) ? parsed.payment_type : null,
      parcel_count: Number.isInteger(Number(parsed.parcel_count)) && Number(parsed.parcel_count) >= 1 && Number(parsed.parcel_count) <= 100 ? Number(parsed.parcel_count) : null,
      priority: ['normal','urgent'].includes(parsed.priority) ? parsed.priority : null,
      notes: parsed.notes ?? null,
      overall_confidence: Math.max(0, Math.min(1, Number(parsed.overall_confidence ?? 0))),
      confidence: parsed.confidence || {},
      uncertain_fields: Array.isArray(parsed.uncertain_fields) ? parsed.uncertain_fields.slice(0, 20) : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings.slice(0, 20) : [],
      raw_text: parsed.raw_text ?? null,
      model
    }

    return json({ ok: true, order: safe })
  } catch (e) {
    console.error(e)
    return json({ error: e instanceof Error ? e.message : 'server_error' }, 500)
  }
})
