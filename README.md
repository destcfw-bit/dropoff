# Drop Off Online V1

نسخة أولى متصلة بقاعدة Supabase ومجهزة كـ PWA.

## تشغيل محلي
```bash
npm install
npm start
```
ثم افتح http://localhost:3000

## النشر على Railway
- اربط المشروع بمستودع GitHub يحتوي هذه الملفات.
- Start command: `npm start`
- Healthcheck: `/health`
- التطبيق يستمع تلقائياً على `PORT` من Railway.

## أول حساب أدمن
1. أنشئ حساب عادي من شاشة التسجيل.
2. بعد تأكيد البريد وتسجيل الدخول، يتم إنشاء صف في `public.profiles` تلقائياً.
3. يتم ترقية الحساب لأول مرة إلى `admin` من قاعدة البيانات بواسطة مالك المشروع/المشرف.

## بنية النظام
- profiles / stores / store_users / captains
- orders / order_batches / order_events
- store_settlements / captain_handovers
- RLS بحسب الدور
- RPCs للكابتن والتوزيع والصلاحيات
