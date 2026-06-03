# Tzurah-AI Brain

Short, high-signal lessons only. Add durable rules, not session notes.

## Wisdom

- Billing changes require rollback first.
- Truth has one owner.
- Reconciliation is the billing lie detector.
- Duplicate deductions are existential defects.
- Session ownership gates every credit mutation.
- Secrets belong in environment, never docs.
- Repo boundaries are product boundaries.
- Debug belongs behind flags.
- Sync scripts are the release boundary.
- Feature flags are release gates.
- Settings is stable config; Dev is experiment control.
- Production config fails closed before serving traffic.
- Public config is not trust; privileged bootstrap is trust.
- Dev-only flags resolve false for normal users unless a server-side dev account or allowlist says otherwise.
- Admin sessions need a persistent store before broad production; MemoryStore is local/dev fallback only.
- Rate limits must be route-aware; session pings are health traffic, not login traffic.
- Dangerous admin mutations require backend super_admin gates, not hidden buttons.
- Production readiness excludes payments until payment-provider hardening is explicit.
- Payments launch from disabled scaffolds: provider none, configured false, live mode false until webhook verification, idempotency, ledger, and reconciliation are proven.
- Credit pack preview is not checkout; dev/test visibility can be enabled while real payments stay false.
- Admin UI should compose Lego primitives before adding one-off cards, tables, modals, or button states.
- Revenue dashboards count real payments only; mock/dev and gift credit rows stay separated.
- End-session UX is operational control, not billing math; keep it reasoned, RBAC-gated, and observable.
