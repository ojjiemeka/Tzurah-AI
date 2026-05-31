# Security Review For 100-1000 Users

Payments are intentionally excluded from production readiness in this phase.

## Checked

| Area | Status | Notes |
| --- | --- | --- |
| Public config | Pass | `/api/public-config` returns app metadata, Supabase URL/anon key, public flags, auth providers, no secrets |
| App config | Pass | `/api/app-config` resolves flags with optional user JWT, no secrets |
| Decart token endpoint | Pass | `/decart/token` and `/api/decart/client-token` require Supabase JWT and return short-lived client tokens only |
| Permanent Decart keys | Pass | Backend env only; `/internal/decart-key` returns 410 |
| CORS | Pass | Centralized whitelist with `http://localhost:3000` allowed for Electron session routes |
| Session routes | Pass | `/session/ping` and `/session/end` have route-aware limits |
| Admin auth | Pass | Express session with RBAC gates; Redis session store available |
| Admin dangerous routes | Pass | Super-admin middleware applied to dangerous mutations |
| Rate limits | Pass | Login, bootstrap, API, credit, session, and token route limits configured |
| Security headers | Partial | Basic headers set manually; Helmet can be added later if package policy allows |
| Audit logs | Pass | `logAction()` records mutations and RBAC denial attempts |
| Critical alerts | Partial | Env-driven webhook helper exists; production requires `ENABLE_CRITICAL_ALERTS=true` and `ALERT_WEBHOOK_URL` |

## Production Env Checklist

- `TZURAH_ENV=production`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `ADMIN_SECRET`
- `ADMIN_PASSWORD`
- `BOOTSTRAP_SECRET`
- `INTERNAL_SECRET`
- `APP_BASE_URL` non-local
- `DECART_API_KEY_PROD`
- `REDIS_SESSION_URL` or `REDIS_URL`
- `REQUIRE_PERSISTENT_SESSION_STORE=true`
- `ENABLE_CRITICAL_ALERTS=true`
- `ALERT_WEBHOOK_URL`

## Remaining Risks

- `nodemailer` has a high-severity advisory requiring a breaking upgrade path.
- Helmet is not installed; current headers are manual.
- Payment-provider production readiness remains deferred.
- Supabase migrations/indexes must be applied and verified separately.
