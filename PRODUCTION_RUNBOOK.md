# Tzurah-AI Production Runbook

Payments are not production-ready in this phase. Do not enable live payment rollout until the payment readiness phase is complete.

## Deploy Checklist

1. Confirm repo clean: `git status`.
2. Pull latest server repo: `git pull origin main`.
3. Install dependencies: `npm install --omit=dev`.
4. Confirm env vars are present.
5. Run `node --check gcp-server.js`.
6. Start/restart: `pm2 restart tzurah-server`.
7. Check `/health`.
8. Open admin and verify login.
9. Verify Loqii `/api/public-config`, `/api/app-config`, `/session/ping`, `/session/end`.

## Required Env Vars

- `TZURAH_ENV=production`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `ADMIN_SECRET`
- `ADMIN_PASSWORD`
- `BOOTSTRAP_SECRET`
- `INTERNAL_SECRET`
- `APP_BASE_URL`
- `DECART_API_KEY_PROD`
- `REDIS_SESSION_URL` or `REDIS_URL`
- `REQUIRE_PERSISTENT_SESSION_STORE=true`
- Optional alerts: `ENABLE_CRITICAL_ALERTS=true`, `ALERT_WEBHOOK_URL`

## Redis / Session Store

- Local dev may use MemoryStore.
- Production should use Redis.
- With `REQUIRE_PERSISTENT_SESSION_STORE=true`, production fails closed when Redis is missing or unavailable.

## Rollback

```bash
cd ~/tzurah-server
git log --oneline -5
git checkout <known-good-commit>
npm install --omit=dev
pm2 restart tzurah-server
```

## Billing Anomaly Response

1. Do not edit billing math during incident response.
2. Open reconciliation dashboard.
3. Check active events by severity.
4. If live protected billing is involved, force legacy billing from the super_admin control.
5. Preserve audit history and logs.

## Force Legacy Billing

- Use `/admin/api/billing-cutover/force-legacy`.
- Super_admin only.
- Verify event logged in admin actions and reconciliation events.

## Disable Risky Feature Flag

- Open Admin Dev / Feature Flags.
- Set flag scope to `off`.
- Global rollout changes require super_admin.
- Confirm Loqii app refresh receives resolved false.

## Revoke Dev/Test Account

- Remove user from Dev/Test Accounts.
- Verify app config resolves dev flags false on next refresh.

## Inspect Active Sessions

- Admin Live Sessions page.
- Check `sessions.is_active`, `session_id`, `user_id`, `last_ping`, `last_sync_at`, and `kill_signal`.

## Resolve Stale Sessions

- Let watchdog handle stale active sessions.
- Do not manually deduct credits.
- If stale sessions persist, inspect logs and reconciliation events before intervention.

## Verify Decart Token Flow

- Normal user should resolve production Decart env.
- Dev/test user should resolve dev only when admin test env allows it.
- Client receives short-lived token only.
- Permanent Decart keys never appear in app logs/responses.

## Emergency Shutdown

```bash
pm2 stop tzurah-server
```

Then disable risky flags or force legacy billing before restart if needed.

## What Not To Do

- Do not enable production payment mode yet.
- Do not alter billing math during an incident.
- Do not delete audit/reconciliation history.
- Do not expose service-role, Decart, Stripe, or internal secrets.
- Do not deploy Loqii app files through this server repo.
