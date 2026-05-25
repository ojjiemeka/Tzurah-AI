# Tzurah Live Component Map

Permanent debugging rule: treat every change as a small Lego module. Find the component boundary first, change the smallest isolated surface, then test that surface before moving outward.

## Electron App UI

Location: `index.html`

Responsibility:
- Main user workflow: login state, camera/mic controls, identity slots, prompt presets, Decart streaming, OBS output, recording, announcements, and session summaries.

Key functions:
- Start/stop stream flow: `doStart()`, `doStop()`
- Billing sync metadata: credit sync helpers around session timers
- Alerts: `addBellAlert()`, `showModalAlert()`, `showModalConfirm()`, `showModalPrompt()`
- OBS setup: OBS modal and websocket output helpers
- Florence: auto-describe download/worker helpers

Common failure symptoms:
- Start works once but restart fails
- credits do not update or final sync repeats
- modal overlay blocks controls
- OBS output does not connect
- Florence download stalls

Debug checklist:
- Confirm bootstrap config loaded before UI actions.
- Check current session id and sync sequence.
- Verify `doStop()` completed before a new start.
- Test modal helper alone with `window.showModalAlert("test")`.
- Check console for Decart token or WebRTC lifecycle errors.

### Scene And Background Presets

Location: `index.html`

Responsibility:
- Local built-in scene preset model.
- Scene picker UI state and local persistence.
- Prompt routing that preserves the selected identity while changing only the environment/background.

Key functions:
- `buildDecartScenePrompt(identityPrompt, selectedScenePreset)`
- `applyDecartScenePreset(session, preset)`
- `resetDecartScene(session)`

Debug checklist:
- Select a scene before start and confirm it queues for the next session.
- Start a session and confirm the first `set()` includes the selected scene prompt.
- Apply/reset a scene during an active session without interrupting billing/session timers.
- Confirm `window._lastSceneApplication` includes only non-secret environment metadata.

## Admin Dashboard

Location: `admin.html`

Responsibility:
- Admin overview, users, revenue, purchases, sessions, alerts, email, announcements, packs, IP blocks, sub-admins, tests, flags, settings, audit log, and reconciliation diagnostics.

Key functions:
- Tab routing: `switchTab()`
- API helpers: `api()`, `apiPost()`, `adminFetch()`
- Toasts: `toast()`
- Modal component: `showModal()`, `showModalAlert()`, `showModalConfirm()`, `showModalPrompt()`
- Reconciliation UI: `loadReconciliation()`, `renderReconMetrics()`, `renderReconEvents()`
- Email and announcements builders: `loadEmailTab()`, `loadAnnouncements()`

Common failure symptoms:
- A tab renders blank
- confirmation flow does nothing
- reconciliation counts look stale
- a table loads but actions fail

Debug checklist:
- Parse the inline script before deploy.
- Open the tab directly with `switchTab("tabname")`.
- Check whether `adminFetch()` returns a 401 or non-JSON error.
- Test modal helper alone from the console.
- Keep UI fixes scoped to one tab or shared helper.

## Billing And Session Modules

Locations:
- `gcp-server.js`
- `index.html`
- `electron.js`

Responsibility:
- Credit deduction, sync metadata, session pings, session end, ownership validation, stale watchdog handling, admin kill, and shadow billing RPC logging.

Key backend functions:
- `validateBillingSession()`
- `recordBillingShadowSync()`
- `detectDuplicateSyncId()`
- `/credits/deduct`
- `/credits/sync`
- `/session/ping`
- `/session/end`

Common failure symptoms:
- duplicate billing syncs
- killed or old sessions continue billing
- missing final sync warnings
- negative or impossible credit values

Debug checklist:
- Verify `session_id`, `sync_id`, `sync_sequence`, `source`, and `client_ts`.
- Check `sessions.is_active`, `kill_signal`, `last_ping`, and `last_sync_at`.
- Confirm legacy deduction remains authoritative until live RPC switch is approved.
- Never select `profiles.email`.
- Keep numeric guards: finite, non-negative, capped.

## Reconciliation Modules

Location: `gcp-server.js`, UI in `admin.html`

Responsibility:
- Detect billing anomalies, drift, duplicates, stale sessions, missing final syncs, and resolved/an active event lifecycle.

Key functions:
- `logBillingReconciliationEvent()`
- `resolveReconciliationEvents()`
- `getSessionFinalizationStatus()`
- `detectMissingFinalSync()`
- `autoResolveRecentMissingFinalFalsePositives()`
- `/admin/api/reconciliation/summary`
- `/admin/api/reconciliation/:id/resolve`

Common failure symptoms:
- old resolved issues still counted as active
- false-positive `missing_final_sync`
- dashboard shows stale unhealthy status

Debug checklist:
- Query active and resolved rows separately.
- Check whether resolution migration exists.
- Verify `resolved`, `resolved_at`, `resolved_reason`, `auto_resolved`.
- Confirm summary filter is `active`, `resolved`, or `all`.

## Alert And Modal System

Locations:
- `admin.html`
- `index.html`

Responsibility:
- Replace native browser dialogs with reusable dark-theme promise-based modals.

Public API:
- `showModalAlert(message, options)`
- `showModalConfirm(message, options)`
- `showModalPrompt(message, options)`

Behavior:
- Escape cancels cancelable modals.
- Enter confirms unless focus is in a textarea.
- Prompt resolves with a string or `null`.
- Confirm resolves with `true` or `false`.
- Alert resolves when acknowledged.

Common failure symptoms:
- Enter key confirms too early
- modal remains after action
- cancel path does not restore UI

Debug checklist:
- Test the modal API in isolation first.
- Confirm overlay dispatches `modal:closed`.
- Check callbacks are promise-safe.
- Avoid native `alert()`, `confirm()`, and `prompt()`.

## Server And API Modules

Location: `gcp-server.js`

Responsibility:
- Admin auth/RBAC, Supabase admin access, Decart token proxy, payments, credit packs, email, announcements, settings, tests, and audit logs.

Key helpers:
- `adminAuth`
- `can()`
- `logAction()`
- `getSettingValue()`
- Supabase admin client

Common failure symptoms:
- admin route returns 401
- RBAC action hidden or blocked
- endpoint returns table/column missing
- dashboard action appears successful but no audit entry

Debug checklist:
- Run `node --check gcp-server.js`.
- Check route permission with `can(role, permission)`.
- Use Supabase v2 `{ data, error }` style.
- Log admin actions for mutations.

## Local Decart Token Proxy

Location: `server.mjs`

Responsibility:
- Proxy user-authenticated Decart token requests from Electron to the GCP server.
- Preserve non-secret Decart routing metadata for diagnostics.
- Never store or expose Decart API keys beyond the token response needed by the SDK.

Debug checklist:
- Normal users must continue to receive production Decart routing from GCP.
- Dev/test routing decisions remain owned by `gcp-server.js`.
- Renderer may read `decart_environment_used` and `decart_reason`, but never receives raw production/dev keys separately.

## Update And Release Plumbing

Location: `RELEASE_PLAN.md`

Responsibility:
- Define dev, beta, and stable release channels before shipping an installer.
- Keep packaging, code signing, GitHub Releases/update feed, and rollback work explicit.
- Prevent product-facing app updates from being mixed into the deploy-only server sync path.

## File Boundary

Local-only files, never pushed through deploy sync:
- `electron.js`
- `preload.js`
- `index.html`
- `server.mjs`
- `db.js`
- `florence-worker.js`

Deploy-safe files:
- `gcp-server.js`
- `admin.html`
- `admin-login.html`

Project docs:
- `AGENT.md`
- `SKILL.md`
- `COMPONENTS.md`

If docs are added to deploy sync, whitelist only docs explicitly and keep local-only app files blocked.
