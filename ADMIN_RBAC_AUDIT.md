# Admin RBAC Audit

Scope: Tzurah-AI backend/admin routes in `gcp-server.js`. Payments are intentionally excluded from production-readiness approval in this phase.

## Role Model

| Role | Intended access |
| --- | --- |
| public | Health, public config, public app data with no secrets |
| authenticated user | Supabase JWT user routes such as Decart client token and credit/session APIs |
| admin | Operational read access and low-risk support actions |
| super_admin | Dangerous production controls and mutation authority |
| internal | Secret-protected backend/local-proxy operations |

## Dangerous Controls

| Endpoint / area | Required role | Dangerous | Status | Notes |
| --- | --- | --- | --- | --- |
| `/admin/api/billing-cutover/flags` | super_admin | Yes | Pass | Backend middleware plus existing inline guard |
| `/admin/api/billing-cutover/test-users` | super_admin | Yes | Pass | Protected billing allowlist |
| `/admin/api/billing-cutover/force-legacy` | super_admin | Yes | Pass | Emergency rollback |
| `/admin/api/gift-credits` | super_admin | Yes | Pass | Credit mutation |
| `/admin/api/deduct-credits` | super_admin | Yes | Pass | Credit mutation |
| `/admin/api/ban-user` | super_admin | Yes | Pass | User status mutation |
| `/admin/api/unban-user` | super_admin | Yes | Pass | User status mutation |
| `/admin/api/users/:id` DELETE | super_admin | Yes | Pass | User deletion |
| `/admin/api/dev-accounts` POST/DELETE | super_admin | Yes | Pass | Dev/test account rollout control |
| `/admin/api/reconciliation/:id/resolve` | super_admin | Yes | Pass | Billing anomaly resolution |
| `/admin/api/reconciliation/resolve-historical-criticals` | super_admin | Yes | Pass | Bulk critical resolution |
| `/admin/api/reconciliation/soak-test` | super_admin | Yes | Pass | Synthetic billing tests |
| `/admin/api/reconciliation/soak-test/cleanup` | super_admin | Yes | Pass | Synthetic row cleanup only |
| `/admin/api/decart-balance` POST | super_admin | Yes | Pass | Decart balance/rate settings |
| `/admin/api/settings/reveal-key` | super_admin | Yes | Pass | Secret reveal |
| `/admin/api/settings/update-key` | super_admin | Yes | Pass | Secret/config mutation |
| `/admin/api/settings/restart` | super_admin | Yes | Pass | Process control |
| `/admin/api/db/action` | super_admin | Yes | Pass | DB maintenance action |
| `/admin/api/sub-admins` mutation routes | super_admin | Yes | Pass | Admin user management |
| `/admin/api/app-flags/:key` scope update | admin/super_admin, global requires super_admin | Conditional | Pass | Dangerous flags and global rollout require super_admin |
| `/admin/api/feature-flags/:key` | super_admin | Yes | Pass | Legacy flag toggle |

## Audit Logging

`logAction()` records admin mutations to `admin_actions` with fallback to the older schema. RBAC denials log `[RBAC DENY]` and record `rbac_denied`.

## Remaining Follow-Up

- Keep frontend buttons aligned with backend permission rules.
- Add an automated route inventory test before public launch.
- Confirm production Supabase has the extended `admin_actions` columns.
