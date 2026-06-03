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
| Admin revenue/session UI | Improved | Revenue separates real vs mock/gift rows; session end uses bounded confirm flow |
| Alerts | Partial | Helper exists; production webhook env required |
| DB indexes | Planned | Apply `PRODUCTION_DB_INDEXES.md` in Supabase |
| Backup/recovery | Documented | See `PRODUCTION_RUNBOOK.md` |
| Payments | Scaffolded / Disabled | Provider none, configured false, live mode false; see `PAYMENT_PRODUCTION_READINESS.md` |

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

## DB Index Readiness

`PRODUCTION_DB_INDEXES_APPLY.sql` is the actionable Supabase SQL editor script for additive index creation. It uses table/column guards and `CREATE INDEX IF NOT EXISTS` through safe dynamic SQL. Apply manually; do not run remote migrations automatically from this repo.

## Next Phase

Payment production readiness: provider selection, webhook hardening, test/live separation, payment reconciliation, refund/admin operations, and fraud controls.

## Payment Scaffold Checkpoint

Payment readiness docs now exist:

- `CHECKPOINT_PAYMENT_READINESS_SCAFFOLD_2026_05_31.md`
- `PAYMENT_PRODUCTION_READINESS.md`
- `PAYMENT_DB_SCHEMA.md`

The scaffold is intentionally non-live. Enabling payments requires provider selection, verified webhook signatures, idempotent fulfillment, ledger-backed credit grants, and reconciliation.
