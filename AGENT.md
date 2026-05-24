# Tzurah Live - Agent Instructions

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
Access: http://34.39.83.195:4000/admin
Default login: admin@tzurah.ai / TzurahAdmin2025!
WARNING: CHANGE THIS BEFORE LAUNCH

Tabs: Overview, Users, Revenue, Purchases, Sessions,
      Alerts, Announcements, Email, Packs, IP Blocks,
      Sub-admins, Tests, Flags, Settings, Audit Log

Sub-admin roles: super_admin, admin, support, analyst

## Key Variables & Constants
```javascript
// Burn rates
TZURAH_BURN_RATE = 2.18  // cr/sec (user credits)
DECART_BURN_RATE = 2.0   // cr/sec (Decart platform credits)
CREDITS_PER_MINUTE = 130.8

// GCP
GCP_IP = '34.39.83.195'
GCP_PORT = 4000

// Local
LOCAL_PORT = 3000

// Bootstrap
BOOTSTRAP_SECRET = 'tzurah-bootstrap-2025-prod'
INTERNAL_SECRET = 'tzurah-internal-2025-prod'
```

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
