# Production Readiness Scorecard: 100-1000 Users

Payments are deferred and not production-ready in this phase.

| Area | Readiness | Notes |
| --- | --- | --- |
| Sessions | Good for 100, needs Redis verified for 1000 | Watchdog and session ping flow exist |
| Redis/admin sessions | Conditional | Production needs Redis env and `REQUIRE_PERSISTENT_SESSION_STORE=true` |
| Admin RBAC | Improved | Dangerous mutations now have backend super_admin gates |
| CORS | Good | Local Electron session route allowance preserved, production routes strict |
| Rate limits | Good for 100, tune with traffic for 1000 | Route-aware limits added |
| Decart token security | Good | Short-lived authenticated client-token flow |
| Billing usage deductions | Stable baseline | Do not change math without rollback plan |
| Protected billing safety | Framework present, not globally enabled | Keep force-legacy rollback available |
| Feature flags | Good | Admin control plane exists, global rollout super_admin-gated |
| Audit logs | Good | Admin action logging with fallback schema |
| Alerts | Partial | Helper exists; production webhook env required |
| DB indexes | Planned | Apply `PRODUCTION_DB_INDEXES.md` in Supabase |
| Backup/recovery | Documented | See `PRODUCTION_RUNBOOK.md` |
| Payments | Deferred / Not production-ready / Next phase | Payment-provider readiness skipped |

## Current Estimate

- 100 users: conditionally ready after Redis, DB indexes, alert webhook, and runbook drill are verified.
- 1000 users: not ready until load testing, Redis production validation, DB indexes, alerting, and backup restore drill are completed.

## Blockers Before 100 Users

- Configure Redis session store in production.
- Apply DB indexes.
- Configure critical alert webhook.
- Complete admin RBAC smoke test against live admin accounts.
- Confirm no unresolved critical reconciliation events.

## Blockers Before 1000 Users

- Load test `/api/app-config`, `/decart/token`, `/session/ping`, `/credits/deduct`, and admin dashboard.
- Verify Redis capacity and persistence.
- Add external uptime/error monitoring.
- Run backup restore drill.
- Complete payment production readiness phase.

## Next Phase

Payment production readiness: provider selection, webhook hardening, test/live separation, payment reconciliation, refund/admin operations, and fraud controls.
