# Production DB Index Plan

This is an additive index plan for 100-1000 user readiness. Apply in Supabase SQL after confirming table names exist. Do not change billing math while applying indexes.

## Recommended Indexes

```sql
create index if not exists idx_sessions_user_id on public.sessions(user_id);
create unique index if not exists idx_sessions_session_id on public.sessions(session_id);
create index if not exists idx_sessions_is_active on public.sessions(is_active);
create index if not exists idx_sessions_updated_at on public.sessions(updated_at);
create index if not exists idx_sessions_user_active on public.sessions(user_id, is_active);
create index if not exists idx_sessions_last_ping_active on public.sessions(is_active, last_ping);

create index if not exists idx_billing_syncs_session_id on public.billing_syncs(session_id);
create index if not exists idx_billing_syncs_user_id on public.billing_syncs(user_id);
create unique index if not exists idx_billing_syncs_sync_id on public.billing_syncs(sync_id);
create index if not exists idx_billing_syncs_created_at on public.billing_syncs(created_at);

create index if not exists idx_billing_recon_status on public.billing_reconciliation_events(resolved);
create index if not exists idx_billing_recon_severity on public.billing_reconciliation_events(severity);
create index if not exists idx_billing_recon_created_at on public.billing_reconciliation_events(created_at);
create index if not exists idx_billing_recon_type on public.billing_reconciliation_events(type);
create index if not exists idx_billing_recon_session_id on public.billing_reconciliation_events(session_id);

create index if not exists idx_decart_deductions_session_id on public.decart_deductions(session_id);
create index if not exists idx_decart_deductions_user_id on public.decart_deductions(user_id);
create index if not exists idx_decart_deductions_created_at on public.decart_deductions(created_at);

create index if not exists idx_profiles_email on public.profiles(email);
create index if not exists idx_profiles_status on public.profiles(status);
create index if not exists idx_purchases_user_id on public.purchases(user_id);
create index if not exists idx_purchases_created_at on public.purchases(created_at);
create index if not exists idx_admin_actions_created_at on public.admin_actions(created_at);
create index if not exists idx_admin_actions_action on public.admin_actions(action);
```

## Existing Cleanup Owners

- Stale active sessions: `gcp-server.js` session watchdog.
- Billing anomaly detection: scheduled `detectSessionAnomalies()`.
- Synthetic soak cleanup: `/admin/api/reconciliation/soak-test/cleanup`, super_admin only.

## Cleanup Rules

- Do not delete billing, reconciliation, purchase, or admin audit history during routine cleanup.
- Test/soak rows may be cleaned only when explicitly marked as synthetic/test data.
- Prefer dry-run SQL before deletes.
- Cleanup jobs must log counts and criteria.
