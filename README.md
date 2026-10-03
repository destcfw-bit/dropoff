# Drop Off — Operating System V2

**Source of truth:** GitHub `destcfw-bit/dropoff`  
**Production runtime:** VPS + Coolify  
**Database / Auth / Storage / Edge Functions:** Supabase  
**AI:** OpenAI Responses API through Supabase Edge Functions  
**Production branch:** `main`  
**Staging branch:** `staging`

> Railway is no longer part of the active Drop Off architecture.

## Portals

- `/admin` — الإدارة
- `/management` — المحاسب والإدارة المالية
- `/captain` — الكباتن
- `/store` — المحلات
- `/health` — Web health check

## Order intake

The store and admin workflows support:
- manual order entry,
- AI photo-to-order extraction,
- Excel / CSV imports,
- API order creation for larger stores,
- pre-save duplicate/data-quality warnings,
- service type and package-size dimensions,
- offline local queue for store-created orders.

## Operations control center

Admin has a dedicated **مركز العمليات** with:
- Exception Center for stale/duplicate/problem orders,
- warehouse shelf map and fast scanner workflow,
- scan history across pickup / warehouse / delivery / returns,
- smart captain recommendations based on load and area affinity,
- captain cash custody summary,
- area/store/captain operational analytics,
- global command search,
- flexible pricing rules,
- store API key management,
- sticker-roll inventory shortcut,
- security events, audit log, permissions and feature flags,
- health dashboard,
- branches,
- logical backup snapshots and JSON export,
- AI operations assistant,
- cached AI daily summary,
- no-write training/demo mode.

## AI order photo

Function: `supabase/functions/analyze-order-photo/index.ts`

The image is analyzed server-side using the OpenAI API key stored only in Supabase Secrets. The frontend never receives the secret. The function:
- extracts customer/order details,
- returns confidence per field,
- marks uncertain fields for review,
- normalizes Arabic digits,
- uses known store/area context when available.

Required Supabase secret:

```
OPENAI_API_KEY=...
```

Optional:
```
OPENAI_ORDER_VISION_MODEL=...
OPENAI_OPS_MODEL=...
```

## Store API

Functions:
- `admin-store-api-key` — creates one-time visible `do_live_...` credentials for a store.
- `store-api-order` — accepts order creation with `x-api-key`.

API keys are stored only as SHA-256 hashes in the database.

## Security

- login failure throttling and lock windows,
- hashed identifier/IP attempt logs,
- security event stream,
- generic audit logs for key operational tables,
- row-level security in Supabase,
- private order-attachment bucket,
- fine-grained profile permissions,
- feature flags for gradual rollouts.

## Accounting and workforce

Existing accounting/workforce modules remain active:
- captain cash handovers,
- store settlements,
- daily accounting closing,
- salary and monthly payroll closing,
- attendance and geofence workflow,
- overtime/leave/payroll adjustments,
- captain live location and workforce metrics.

## Warehouse and stickers

- preprinted QR sticker rolls,
- per-order QR/sticker links,
- shelf locations,
- warehouse counts,
- scan transitions,
- return handling,
- batch reconciliation.

## Backups

A logical database snapshot is generated daily by Supabase `pg_cron` and kept for 14 days. Admin can also export a JSON snapshot from the control center.

This logical snapshot is an additional recovery layer and should not replace the VPS/Supabase provider-level or offsite backup strategy.

## PWA / app readiness

The web app has a Manifest + Service Worker and caches the shell for offline fallback. Store order creation has a local offline queue and sends queued orders after connectivity returns. The same Supabase APIs can later be reused by a native iOS/Android app.

## Database migrations

Important current migrations are tracked under `sql/`, including:

- `20261003_operating_system_v2_core.sql`
- `20261003_operating_system_v2_security_backup.sql`
- `20261003_store_order_service_type_v2.sql`
- `20261003_package_size_flexible_pricing.sql`

They have already been applied to the connected production Supabase project. Do not rerun them manually on that same database.

## Deployment

Production should deploy from GitHub `main` through Coolify.  
Use `staging` for a second Coolify application before promoting major changes to production.

Before a risky release:
1. create/download a backup from the admin control center,
2. test the commit on the staging Coolify application,
3. promote the same tested commit to production.
