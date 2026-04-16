# Tzurah Live — API Server

Express API server powering Tzurah Live. Handles Stripe payments, Supabase auth, credit management, and the admin dashboard.

## Setup on GCP VM

### First time

```bash
git clone https://github.com/YOUR_USERNAME/tzurah-server.git ~/tzurah-server
cd ~/tzurah-server
cp .env.example .env
nano .env          # fill in all keys (Supabase, Stripe, Decart, Admin)
npm install --production
pm2 start ecosystem.config.js --env production
pm2 save
```

### Update (manual)

```bash
cd ~/tzurah-server && git pull && npm install --production && pm2 restart tzurah-server
```

### Update (automatic)

Pushes to `main` trigger GitHub Actions → deploys automatically via SSH.

---

## Environment Variables

See [`.env.example`](.env.example) for all required variables. Copy it to `.env` on the server — never commit `.env`.

---

## Admin Dashboard

```
http://YOUR_VM_IP:4000/admin
```

Default credentials (change these before going live):

| Field    | Value               |
|----------|---------------------|
| Username | admin@tzurah.ai     |
| Password | TzurahAdmin2025!    |

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` to override.

---

## API Endpoints

| Method | Path                        | Auth   | Description                  |
|--------|-----------------------------|--------|------------------------------|
| GET    | `/health`                   | None   | Health check                 |
| POST   | `/auth/verify`              | None   | Verify Supabase JWT          |
| POST   | `/stripe/create-checkout`   | JWT    | Create Stripe checkout       |
| POST   | `/stripe/webhook`           | Stripe | Handle payment events        |
| GET    | `/credits/balance`          | JWT    | Get user credit balance      |
| POST   | `/credits/deduct`           | JWT    | Deduct session credits       |
| GET    | `/admin`                    | Basic  | Admin dashboard HTML         |
| GET    | `/admin/api/stats`          | Basic  | Overview stats               |
| GET    | `/admin/api/users`          | Basic  | Paginated user list          |
| GET    | `/admin/api/purchases`      | Basic  | Recent 50 purchases          |
| POST   | `/admin/api/gift-credits`   | Basic  | Gift credits to a user       |
| POST   | `/admin/api/deduct-credits` | Basic  | Deduct credits from a user   |
| POST   | `/admin/api/ban-user`       | Basic  | Ban a user                   |
| POST   | `/admin/api/unban-user`     | Basic  | Unban a user                 |

---

## Process Management (PM2)

```bash
pm2 status                          # check running processes
pm2 logs tzurah-server --lines 100  # tail logs
pm2 restart tzurah-server           # restart after config change
pm2 stop tzurah-server              # stop
```

Logs are written to `./logs/out.log` and `./logs/error.log`.

---

## GitHub Actions (CI/CD)

Automatic deployment is configured in `.github/workflows/deploy.yml`.

**Required GitHub Secret:**

| Secret        | Value                                          |
|---------------|------------------------------------------------|
| `GCP_SSH_KEY` | Private SSH key matching the VM's `authorized_keys` |

To add it: GitHub repo → Settings → Secrets and variables → Actions → New repository secret.

**To generate a deployment key:**

```bash
# On your local machine:
ssh-keygen -t ed25519 -C "github-actions-tzurah" -f ~/.ssh/tzurah_deploy -N ""

# Copy public key to VM:
ssh-copy-id -i ~/.ssh/tzurah_deploy.pub ojjiemeka@34.39.83.195

# Copy private key → paste as GCP_SSH_KEY secret in GitHub:
cat ~/.ssh/tzurah_deploy
```
