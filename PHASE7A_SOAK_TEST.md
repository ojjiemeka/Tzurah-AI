# Tzurah Live - Phase 7A Shadow Billing Soak Test Plan

## Purpose

Phase 7A proves that protected shadow billing matches the current legacy billing path before any live RPC cutover.

Live billing remains legacy-authoritative during this phase. The protected RPC must stay `shadow_only = true`, and `billing_syncs.credits_deducted` should remain `0.000`.

This soak test is designed to catch financial and session-lifecycle defects before switching real credit deduction to the protected RPC.

## Coding Engine Gate

Before changing Phase 7A billing, sessions, reconciliation, admin kill, or protected RPC behavior, Codex must read `AGENT.md`, `BRAIN.md`, `COMPONENTS.md`, and this file.

Required before edits:
- Declare repo scope and whether Loqii app changes are required.
- Map state owner, request flow, database writes, duplicate-deduction guard, reconciliation feedback, and rollback path.
- Classify the task as high risk or dangerous unless it is documentation-only.
- Preserve legacy-authoritative billing until an explicit cutover task says otherwise.
- Run reconciliation checks after any billing/session code change.

## Success Criteria

- 50-100 completed sessions are captured in the soak window.
- Multiple users are included, with a mix of free, paid, low-credit, and admin-managed accounts.
- 0 critical reconciliation events.
- 0 severe balance drift events.
- 0 duplicate live deductions.
- 0 invalid active-session deductions.
- 0 killed, replaced, stale, or inactive sessions deduct legacy credits after invalidation.
- `missing_final_sync` appears only for true abnormal exits.
- Shadow expected credits match legacy deducted credits within approved rounding tolerance.
- Stop -> Start works repeatedly without token reuse errors.
- App shutdown and admin kill paths stop billing cleanly.

Approved rounding tolerance for Phase 7A:
- Warning: absolute drift >= 0.5 credits.
- Severe: absolute drift >= 2.0 credits.
- Go/no-go review should also inspect repeated small drift patterns, not only single severe rows.

## Test Matrix

Run 50-100 sessions total across the following matrix.

| Scenario | Target Count | Expected Result |
| --- | ---: | --- |
| Short normal sessions, 5-15 seconds | 15-25 | Legacy deduction and shadow expected credits match within tolerance. |
| Medium normal sessions, 30-90 seconds | 15-25 | Multiple interval syncs plus final/manual stop are logged. |
| Stop -> Start loops, same user | 10-15 | New session IDs, increasing sync sequences per session, no stale token error. |
| Low-credit auto-stop | 5-10 | Session stops at zero, no negative balance, no duplicate final deduction. |
| Admin-killed sessions | 5-10 | Future pings/syncs from killed session do not deduct. |
| App window close during active session | 5-10 | Shutdown sync or clean finalization appears; terminal exits in dev mode. |
| Abrupt abnormal exit | 3-5 | `missing_final_sync` appears only when finalization evidence is truly absent. |
| Reconnect/replay duplicate sync | 3-5 | Duplicate is detected and does not live-deduct twice. |
| Multiple users active over same period | 10+ | Session ownership remains per user/session with no cross-user billing. |

## Admin Checks

During the soak, inspect the Admin dashboard after each batch:

- Overview loads without console errors.
- Sessions tab shows active sessions correctly.
- Billing Reconciliation card shows active anomaly counts.
- Reconciliation event list distinguishes active vs resolved events.
- Admin kill stops the client session and blocks future billing syncs.
- Recent Activity does not show malformed rows such as `unknown received gift: Gift`.
- User Profile drawer/modal does not squeeze tablet/mobile layout.

Suggested cadence:

- Check dashboard after every 10 sessions.
- Export/query Supabase after every 25 sessions.
- Review full go/no-go report after 50 sessions.
- Continue to 100 sessions if any warning-level drift needs more evidence.

## Supabase Queries

### Recent Shadow Syncs

```sql
select
  session_id,
  sync_id,
  sync_sequence,
  source,
  duration_secs,
  credits_requested,
  credits_expected,
  credits_deducted,
  status,
  reason,
  shadow_only,
  client_ts,
  created_at
from public.billing_syncs
order by created_at desc
limit 100;
```

Expected:
- `sync_id` uses `session_id:sequence:source` for modern clients.
- `sync_sequence` is numeric and non-null for modern clients.
- `source` is `interval`, `final`, `manual_stop`, `app_shutdown`, or an approved backend source.
- `credits_deducted = 0.000` while shadow mode is active.
- `shadow_only = true`.

### Active Reconciliation Anomalies

```sql
select
  id,
  type,
  severity,
  user_id,
  session_id,
  resolved,
  auto_resolved,
  resolved_reason,
  details,
  created_at
from public.billing_reconciliation_events
where coalesce(resolved, false) = false
order by created_at desc
limit 100;
```

Expected:
- No `critical` rows.
- No severe balance drift rows.
- `missing_final_sync` rows correspond to true abnormal exits only.

### Reconciliation Counts By Type

```sql
select
  type,
  severity,
  count(*) as count
from public.billing_reconciliation_events
where coalesce(resolved, false) = false
group by type, severity
order by count desc, severity desc, type;
```

### Recent Sessions

```sql
select
  user_id,
  email,
  session_id,
  is_active,
  kill_signal,
  kill_reason,
  kill_note,
  started_at,
  last_ping,
  last_sync_at,
  credits_used
from public.sessions
order by started_at desc
limit 100;
```

Expected:
- Only currently running sessions remain `is_active = true`.
- Admin-killed sessions show `kill_signal = true` and a kill reason.
- Replaced/stale sessions no longer accept billing.

### Sessions Without Terminal Sync

```sql
select
  s.user_id,
  s.email,
  s.session_id,
  s.is_active,
  s.kill_signal,
  s.kill_reason,
  s.started_at,
  s.last_ping,
  s.last_sync_at,
  count(bs.id) as sync_count,
  max(bs.created_at) as last_billing_sync,
  bool_or(bs.source in ('final', 'manual_stop', 'app_shutdown')) as has_terminal_sync
from public.sessions s
left join public.billing_syncs bs
  on bs.session_id = s.session_id
 and bs.user_id = s.user_id
where s.started_at > now() - interval '7 days'
group by
  s.user_id,
  s.email,
  s.session_id,
  s.is_active,
  s.kill_signal,
  s.kill_reason,
  s.started_at,
  s.last_ping,
  s.last_sync_at
having count(bs.id) > 0
   and bool_or(bs.source in ('final', 'manual_stop', 'app_shutdown')) is not true
order by s.started_at desc
limit 100;
```

Review each row manually. A missing terminal sync is acceptable only when interval coverage or clean finalization evidence exists, or when the test intentionally simulated an abnormal exit.

### Duplicate Sync Detection

```sql
select
  user_id,
  session_id,
  sync_id,
  count(*) as count,
  min(created_at) as first_seen,
  max(created_at) as last_seen
from public.billing_syncs
group by user_id, session_id, sync_id
having count(*) > 1
order by count desc, last_seen desc;
```

Expected:
- No rows, because the unique index should prevent duplicate stored sync IDs.
- If a duplicate replay is attempted, it should return duplicate-safe behavior without another live deduction.

### Duplicate Sequence Detection

```sql
select
  user_id,
  session_id,
  sync_sequence,
  count(*) as count,
  min(created_at) as first_seen,
  max(created_at) as last_seen
from public.billing_syncs
where sync_sequence is not null
group by user_id, session_id, sync_sequence
having count(*) > 1
order by count desc, last_seen desc;
```

Expected:
- No rows.

### Rounding Drift Review

```sql
select
  user_id,
  session_id,
  sync_id,
  sync_sequence,
  source,
  duration_secs,
  credits_requested,
  credits_expected,
  round(abs(credits_requested - credits_expected), 3) as drift,
  status,
  created_at
from public.billing_syncs
where abs(credits_requested - credits_expected) >= 0.5
order by drift desc, created_at desc
limit 100;
```

Expected:
- Drift >= 0.5 is reviewed.
- Drift >= 2.0 blocks live cutover until explained and fixed.

### Shadow Vs Legacy Session Totals

```sql
with shadow_totals as (
  select
    user_id,
    session_id,
    round(sum(credits_expected), 3) as shadow_expected,
    round(sum(credits_requested), 3) as shadow_requested,
    count(*) as sync_count,
    bool_or(source in ('final', 'manual_stop', 'app_shutdown')) as has_terminal_sync
  from public.billing_syncs
  where created_at > now() - interval '7 days'
  group by user_id, session_id
)
select
  s.user_id,
  s.email,
  s.session_id,
  s.credits_used as legacy_session_credits_used,
  st.shadow_expected,
  st.shadow_requested,
  round(abs(coalesce(s.credits_used, 0) - coalesce(st.shadow_expected, 0)), 3) as expected_drift,
  st.sync_count,
  st.has_terminal_sync,
  s.is_active,
  s.kill_signal,
  s.kill_reason,
  s.started_at,
  s.last_sync_at
from public.sessions s
join shadow_totals st
  on st.user_id = s.user_id
 and st.session_id = s.session_id
order by s.started_at desc
limit 100;
```

Use this as the main per-session comparison. Investigate any rows where expected drift exceeds tolerance or where legacy used credits appear inconsistent with sync totals.

### Balance Drift Signals

```sql
select
  type,
  severity,
  user_id,
  session_id,
  details,
  created_at
from public.billing_reconciliation_events
where type in ('balance_drift_warning', 'balance_drift_severe')
  and coalesce(resolved, false) = false
order by created_at desc
limit 100;
```

Expected:
- No `balance_drift_severe`.
- Warning rows must be explained before cutover.

### Invalid Session Billing Attempts

```sql
select
  type,
  severity,
  user_id,
  session_id,
  details,
  created_at
from public.billing_reconciliation_events
where type in (
  'invalid_billing_session',
  'killed_session_attempted_sync',
  'replaced_session_attempted_sync',
  'stale_session_detected',
  'orphan_active_session'
)
  and coalesce(resolved, false) = false
order by created_at desc
limit 100;
```

Expected:
- Test-created events may exist, but no invalid session should deduct live credits.

### Decart/User Billing Mismatch

```sql
select
  type,
  severity,
  user_id,
  session_id,
  details,
  created_at
from public.billing_reconciliation_events
where type in (
  'decart_billing_mismatch_warning',
  'decart_billing_mismatch_severe'
)
  and coalesce(resolved, false) = false
order by created_at desc
limit 100;
```

Expected:
- No severe mismatch rows.
- Warning rows must be explained before cutover.

## Failure Thresholds

Immediate no-go:
- Any critical reconciliation event.
- Any `balance_drift_severe`.
- Any duplicate live deduction.
- Any invalid, killed, stale, inactive, or replaced session deducts legacy credits.
- Any user balance becomes negative.
- Any session can continue billing after admin kill.
- Any Stop -> Start loop recreates the invalid API key/token lifecycle bug.

Pause and investigate:
- Rounding drift >= 2.0 credits.
- Repeated rounding drift >= 0.5 credits across multiple sessions.
- More than 1 unexpected `missing_final_sync` in a 25-session batch.
- Any duplicate sync replay that is not safely treated as duplicate.
- Any admin dashboard reconciliation error or failed summary endpoint.

Acceptable during soak:
- Warning-level drift that is explained by known `Math.ceil()` legacy rounding behavior.
- `missing_final_sync` for intentionally abnormal exits.
- Resolved historical anomalies that are not counted as active.

## Go/No-Go Rules For Live RPC Cutover

Go only if all are true:

- At least 50 sessions pass, preferably 100 if any warning-level drift was observed.
- No critical active reconciliation events.
- No severe active balance drift events.
- No unexplained Decart/user mismatch.
- No duplicate live deductions.
- No invalid-session live deductions.
- Shadow expected totals match legacy session totals within approved tolerance.
- Admin kill, app shutdown, low-credit auto-stop, and Stop -> Start loops all behave correctly.
- The team has reviewed active and resolved reconciliation rows separately.

No-go if any are true:

- Any financial correctness issue remains unexplained.
- Any active severe or critical anomaly remains unresolved.
- Any missing final sync appears for a normal clean stop/shutdown.
- Any admin-killed session can continue to ping or deduct.
- Any duplicate sync can deduct live credits twice.

## Phase 7A Signoff Checklist

- [ ] 50+ sessions completed.
- [ ] Multiple users tested.
- [ ] Normal short sessions tested.
- [ ] Normal medium sessions tested.
- [ ] Stop -> Start loops tested.
- [ ] Low-credit auto-stop tested.
- [ ] Admin kill tested.
- [ ] App shutdown tested.
- [ ] Abnormal exit tested.
- [ ] Duplicate sync replay tested.
- [ ] Reconciliation active anomalies reviewed.
- [ ] Shadow vs legacy totals reviewed.
- [ ] Balance drift reviewed.
- [ ] Go/no-go decision recorded.
# Coding Engine Checkpoint

Before running or changing soak-test logic, Codex must read `AGENT.md`, `BRAIN.md`, and `COMPONENTS.md`.

Soak-test changes are at least medium risk. If they touch billing, protected billing, reconciliation, session ownership, or database writes, classify them high-risk/dangerous and document rollback plus reconciliation checks before editing.
