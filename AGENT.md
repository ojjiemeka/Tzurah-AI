# Tzurah-AI Server/Admin Agent Instructions

Codex must read `AGENT.md`, `BRAIN.md`, and `COMPONENTS.md` before non-trivial edits in this repo. For billing or reconciliation work, also read `PHASE7A_SOAK_TEST.md`.

## Loqii/Tzurah Coding Engine

Future prompts should begin with this instruction for server/admin work:
`Read AGENT.md, BRAIN.md, COMPONENTS.md, and relevant PHASE docs before editing. Declare repo scope, risk class, topology, tests, rollback path, and sync path.`

### Repo Boundary Gate

Declare one scope before editing:
- `Tzurah-AI only`: backend, admin panel, billing, protected billing, reconciliation, Decart token routing, feature flags, database/API contracts.
- `Loqii only`: Electron app UI, local renderer/main-process UX, OAuth desktop shell, Decart client/session UX, scenes, styles, prompts, and local app components.
- `Both repos required`: allowed only for explicit app/server contract changes. Explain why before editing.

Server/admin changes stay in Tzurah-AI. App changes stay in Loqii.

If both repos are required, explain the contract bridge before editing either side.

### Topology First

Before code, map:
- affected files
- state owner
- request/data flow
- async/timing risks
- admin/UI surfaces affected
- API/database boundaries
- billing/reconciliation impact
- blast radius

State this topology briefly to the user before editing unless the change is trivial.

### Four Invariants

For every non-trivial change, answer:
- Where does state live?
- Where does feedback or observability live?
- What breaks if this changes?
- When does timing or order matter?

### Risk Classification

Classify work as `trivial`, `low risk`, `medium risk`, `high risk`, or `dangerous`.

Billing, protected billing, reconciliation, Decart token routing, Supabase auth, database migrations, admin RBAC, and session lifecycle start at high risk unless the change is purely documentation.

High-risk and dangerous work requires extra mapping, rollback notes, explicit tests, and no broad refactors.

### Server Red Lines

Never expose secrets, service-role keys, bootstrap/internal tokens, OAuth secrets, admin passwords, production credentials, or Decart keys in docs, logs, UI, commits, or final reports.
Never alter billing, protected billing, reconciliation, Decart routing, Supabase auth, Google OAuth, or database schema unless the task explicitly requires it.

Billing/protected billing/reconciliation changes are high-risk or dangerous. If touched:
- explain the exact flow
- preserve rollback and legacy fallback
- prevent duplicate deductions
- run reconciliation checks
- document residual risk

### Admin UI Rules

Do not use native `alert`, `confirm`, or `prompt`.
Do not create one-off modal systems when a shared admin modal exists.
Do not leak debug/admin scaffolding into product-facing app code.
Feature flags must default closed for experimental or diagnostic behavior.

### Dependency Safety

Do not add dependencies unless necessary. Before adding one, document why native code is insufficient, check package age/version, pin the exact version, and update the lockfile intentionally.

Do not install packages published less than 7 days ago unless the user explicitly overrides that risk.

### Test Gate

Run relevant checks before final response:
- `node --check` touched JS
- parse changed inline scripts in admin HTML
- native dialog scan
- mojibake scan
- RBAC/permission route scan when admin changes
- reconciliation checks when billing/reconciliation changes
- `git-update.sh --dry-run` before server/admin sync

### Sync

Never use `git add -A`.
Use `git-update.sh` for server/admin deploy sync.
Do not push Electron app source through this repo.

### Memory And Checkpoints

Update `BRAIN.md` only with durable high-signal lessons. Do not add session logs.

After major successful phases, update `COMPONENTS.md` and relevant PHASE docs. Update app release docs only from the Loqii repo.

### Stop Conditions

Stop and ask before coding if state ownership, API contract, repo boundary, database migration, billing impact, auth/session flow, admin permission model, or user intent is unclear.

### Final Report

Every final report includes:
- files changed
- repo touched
- topology mapped
- risks found
- tests run
- manual QA needed
- sync result
- deferred risks

### Stop Conditions

Stop and ask before coding if state ownership, API contract, repo boundary, database migration, billing impact, auth/session flow, or user intent is unclear.

## What This Project Is
Tzurah Live is a commercial real-time AI face swap desktop
application. Users pay credits to stream their webcam through
Decart AI's Lucy-2 model which transforms their face in real-time
via WebRTC. It is built as an Electron desktop app for Windows.

## Architecture Overview
```
User's Computer (Electron App)
├── electron.js          - Main Electron process, IPC handlers
├── preload.js           - Secure bridge between main/renderer
├── index.html           - Entire app UI (single file, ~4000 lines)
├── server.mjs           - Local Express server (port 3000)
├── db.js                - SQLite local cache
└── florence-worker.js   - Florence-2 AI Web Worker

GCP VM (34.39.83.195:4000)
├── gcp-server.js        - Main backend API server
├── admin.html           - Admin dashboard (single file, ~8000 lines)
└── admin-login.html     - Admin login page

Database: Supabase (PostgreSQL)
Auth: Supabase Auth + Google OAuth
Payments: Paddle (pending) / Mock payments (testing)
Process Manager: PM2
```

## Critical File Boundary - NEVER VIOLATE
```
LOCAL ONLY (never push to git):
  electron.js, preload.js, index.html,
  server.mjs, db.js, florence-worker.js

GIT DEPLOYED (push via git-update.sh):
  gcp-server.js, admin.html, admin-login.html
```

## Deploy Command
```bash
# From Windows machine:
cd C:\Users\Admin\Desktop\RTDF-Decart
bash git-update.sh "commit message"

# On VM after push:
cd ~/tzurah-server && git pull && pm2 restart tzurah-server
```

## Run Command
```bash
cd C:\Users\Admin\Desktop\RTDF-Decart
npm run electron:dev
```

## Technology Stack
- Frontend: Electron + vanilla JS (no framework)
- Backend: Node.js + Express
- Database: Supabase (PostgreSQL)
- Auth: Supabase Auth
- AI: Decart AI Lucy-2 (WebRTC face swap)
- Payments: Mock payments (Paddle/Stripe pending)
- Hosting: GCP VM (migrating to DigitalOcean)
- Process: PM2

## Business Model
- Credit-based one-time purchases (no subscription)
- Burn rate: 2.18 Tzurah credits/second
- Decart cost: 2.0 Decart credits/second
- Users buy credit packs: $35->72cr, $60->132cr, $100->216cr etc.
- New users get 6 free credits on signup
- Margin: ~70-77% after Decart costs

## Supabase Tables
```
profiles          - id, display_name, avatar_url, credits,
                    total_credits_purchased, total_credits_used,
                    created_at, last_seen
purchases         - user_id, pack_name, price_usd, credits_added,
                    stripe_payment_id, created_at
usage             - session logs
sessions          - user_id, session_id, email, is_active,
                    started_at, last_ping, kill_signal,
                    kill_reason, kill_note, last_sync_at,
                    credits_used
admin_notifications - id, title, message, type, created_at
admin_actions     - action, performed_by, performed_by_role,
                    target_user_id, ip_address, user_agent,
                    details, created_at
feature_flags     - flag_name, enabled
credit_packs      - id, name, slug, price_usd, credits, minutes,
                    stripe_price_id, is_active, is_popular,
                    sort_order
announcements     - id, title, message, type, is_active,
                    expires_at, created_at
admin_users       - id, email, role, password_hash,
                    force_password_change, is_suspended
ip_blocks         - ip, reason, expires_at, created_at
sent_emails       - id, subject, recipient_group,
                    recipient_count, status, created_at
app_settings      - key, value, updated_at
decart_deductions - id, session_id, user_id, duration_secs,
                    credits_deducted, balance_before,
                    balance_after, reason, created_at
```

## Admin Panel
Access: admin route on the deployed server.
Admin credentials and bootstrap/internal secrets must stay out of repo docs and commits.

Tabs: Overview, Users, Revenue, Purchases, Sessions,
      Alerts, Announcements, Email, Packs, IP Blocks,
      Sub-admins, Tests, Flags, Settings, Audit Log

Sub-admin roles: super_admin, admin, support, analyst

## Key Variables & Constants
Document variable names and expected shapes, not secret values. Secrets live in environment/config, never in docs or UI.

## What Is Working (Stable)
- Face swap via Decart Lucy-2 SDK
- 5 identity slots (IndexedDB, 512x512 JPEG)
- Credit burn at correct rate (2.18 cr/sec)
- Credit sync every 5 seconds to GCP
- Session ping every 5 seconds
- Auto-stop at 0 credits
- Session watchdog (force-kills stale sessions)
- Decart balance auto-deduction after each session
- Admin dashboard (14 tabs, full RBAC)
- Mock purchase flow (test without Stripe)
- Audit log with all admin actions
- Google OAuth login
- Bootstrap system (no local credentials)
- OBS output via WebSocket
- Session recording with audio
- Kill session from admin
- Announcements system
- Feature flags
- IP blocking
- Sub-admin roles
- Mobile responsive admin

## What Is Pending
- [ ] Watermark removal (contact Decart for commercial plan)
- [ ] Domain: tzurah.ai (Cloudflare ~$50/yr)
- [ ] Landing page (Vercel)
- [ ] Paddle payment integration (needs domain)
- [ ] Email confirmation (Resend.com configured, needs domain)
- [ ] .exe installer (electron-builder)
- [ ] Auto-updater (electron-updater)
- [ ] Florence-2 auto-describe (needs testing)
- [ ] Stage 3: Email + Announcements tab rebuild
- [ ] Migrate GCP to DigitalOcean ($12/mo)
- [ ] Remove dev mode banner from production build
