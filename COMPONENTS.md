# Tzurah Live Component Map

Permanent debugging rule: treat every change as a small Lego module. Find the component boundary first, change the smallest isolated surface, then test that surface before moving outward.

## Loqii/Tzurah Coding Engine

Codex must read `AGENT.md`, `BRAIN.md`, and `COMPONENTS.md` before non-trivial server/admin edits. For billing or reconciliation work, also read `PHASE7A_SOAK_TEST.md`.

Before code, declare:
- Repo scope: `Loqii only`, `Tzurah-AI only`, or `both repos required`.
- Risk class: `trivial`, `low risk`, `medium risk`, `high risk`, or `dangerous`.
- Topology: affected files, state ownership, request/data flow, async/timing risks, admin/UI surfaces, API/database boundaries, billing impact, and blast radius.

Four invariants:
- Where does state live?
- Where does feedback or observability live?
- What breaks if this changes?
- When does timing or order matter?

Stop before coding if repo boundary, state ownership, API contract, database migration, billing impact, auth/session flow, admin permission model, or user intent is unclear.

Server/admin red lines:
- Never expose secrets or production credentials.
- Never touch billing/protected billing/reconciliation unless explicitly requested.
- Preserve legacy billing fallback and rollback paths.
- Prevent duplicate deductions.
- Keep Decart token routing backend-owned.
- Keep feature/debug/admin scaffolding out of normal user app surfaces.
- Never use native `alert`, `confirm`, or `prompt` in admin UI.
- Never use `git add -A`; sync through `git-update.sh`.

Permanent agent entry rule: before non-trivial edits, read `AGENT.md`, `BRAIN.md`, and `COMPONENTS.md`.

## Loqii/Tzurah Coding Engine

Topology-first checklist:
- Identify affected files.
- Identify state ownership.
- Identify request/data flow.
- Identify async/timing risks.
- Identify admin/UI surfaces affected.
- Identify API/database boundaries.
- Identify billing/reconciliation impact.
- Identify blast radius.

Four invariants:
- Where does state live?
- Where does feedback or observability live?
- What breaks if this changes?
- When does timing or order matter?

Repo boundary gate:
- `Tzurah-AI only`: backend/admin, billing, protected billing, reconciliation, Decart token routing, feature flags, database/API contracts.
- `Loqii only`: app UI/UX, Electron, OAuth shell, Decart client/session UX, scenes/styles/prompts, local components.
- `Both repos required`: explain the contract reason before editing either side.

Risk classes:
- `trivial`: typo/copy-only, no behavior.
- `low risk`: isolated docs/admin copy/helper with clear owner.
- `medium risk`: shared admin UI, route handlers, feature flags, auth-adjacent behavior.
- `high risk`: Decart token routing, session ownership, admin RBAC, billing-adjacent changes, deploy/sync scripts.
- `dangerous`: billing/protected billing/reconciliation/database migration/secrets.

High-risk and dangerous work requires topology notes, rollback plan, explicit tests, and no broad refactor.

Billing/protected billing/reconciliation rules:
- Do not touch unless explicitly requested.
- Preserve legacy fallback and rollback.
- Prevent duplicate deductions.
- Keep reconciliation observability intact.
- Run reconciliation checks after changes.

Dependency rules:
- Do not add dependencies unless necessary.
- Explain why native code is insufficient.
- Check package age/version.
- Pin exact version and update lockfile intentionally.

Sync rules:
- Never use `git add -A`.
- Use `git-update.sh`.
- Do not deploy Electron app source through this repo.

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

### App Feature Flag Control Plane

Owner:
- Backend/API: `gcp-server.js`
- Admin UI: `admin.html` Dev tab
- Storage: `app_settings.app_feature_flags_registry` JSON, with legacy `feature_flags` booleans kept for compatibility.

Rules:
- Settings owns stable admin/app configuration only.
- Dev owns app feature flags, dev/test accounts, diagnostics toggles, rollout controls, and test-mode controls.
- Flag resolution is scope-based: `off` is false, `global` is true, `dev_accounts` is true only for users in `dev_test_accounts`, and `allowlist` is true only for selected user IDs.
- Dangerous flags require `super_admin`; non-dangerous app flags may be managed by `admin` or `super_admin`.
- Public app config endpoints return resolved booleans and safe metadata only. They never return secrets.
- Allowlist and dev-account flows must use `UserPicker`; raw UUID entry is only a collapsed advanced fallback.

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
