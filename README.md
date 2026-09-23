# Drop Off V4

**Source of truth:** GitHub  
**Hosting/runtime:** DigitalOcean App Platform  
**Database/Auth:** Supabase

## Portals
- `/admin` — الإدارة
- `/captain` — الكباتن
- `/store` — المحلات
- `/health` — health check

## V4 — Preprinted sticker workflow
- الإدارة تنشئ رول استكرات مسبقة.
- كل استكر له رقم ثابت مثل `DO-ST-100001` وQR فريد.
- يمكن تخصيص الرول لمحل معين.
- صاحب المحل يلصق الاستكر على الطلب ثم يسجل بيانات الزبون ويربط الاستكر بالأوردر.
- الاستكر لا يقبل الاستخدام أكثر من مرة.
- الإدارة تستطيع طباعة الرول مباشرة من لوحة الاستكرات.
- QR لا يعتمد على الدومين؛ هذا يسهّل استخدام نفس الاستكر مستقبلًا داخل تطبيق iPhone/Android.

## DigitalOcean
`.do/app.yaml` مربوط على:
- Repo: `destcfw-bit/dropoff`
- Branch: `main`
- Auto deploy: enabled
- Dockerfile: `Dockerfile`
- Health & liveness: `/health`
- Region: Frankfurt (`fra`)
- Instance starter: `apps-s-1vcpu-1gb`

كل Push على `main` يعمل Deploy تلقائي.
