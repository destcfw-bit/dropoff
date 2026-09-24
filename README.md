# Drop Off V4

**Source of truth:** GitHub
**Hosting/runtime:** Railway (`dropoff-v3`)
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

## Operations extension
- SQL: `sql/20260924_operations.sql`. Already applied to the connected Drop Off Supabase project on 2026-09-24. Do not run it again on that project.
- SQL: `sql/20260924_store_categories.sql`. Already applied to the same project on 2026-09-24.
- Admin: operations dashboard for QR receiving and captain handover, issues, returns, batch reconciliation, warehouse counts, area rates, capacity and shifts; order editing and audit log; daily cash reconciliation and weekly CSV statements; bulk label printing.
- Batch entry accepts CSV and Excel (`.xlsx` / `.xls`); Excel is parsed with a pinned SheetJS browser module.
- Store: parcel count, urgency and payment method when registering an order; own account export.
- Stores can have up to 12 categories, including several preset or custom types, and admins can edit them later.
- Supabase Auth sessions are persisted in local storage and refreshed automatically, so users stay signed in on the same browser until they sign out, clear site data, or their account is disabled.
- Captain: payment and parcel information, priority and morning/evening assignment.
- Excluded: proof of delivery and customer tracking links.

The live Railway service deploys from `destcfw-bit/dropoff` on `main`. The local changes need a GitHub push before they reach the site. The current GitHub integration returns 403 on writes; restore repository Contents write access and then push this commit.
