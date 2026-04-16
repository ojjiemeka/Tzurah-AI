#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  Tzurah Live — VM One-Time Setup Script
#  Run ONCE on the GCP VM:
#    ssh ojjiemeka@34.39.83.195 "bash -s" < vm-setup.sh
# ═══════════════════════════════════════════════════════════════

set -e

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Tzurah Live — VM Setup"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ── Node.js 20 ────────────────────────────────────────────────────
echo "📦  Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "Node: $(node --version)"
echo "NPM:  $(npm --version)"

# ── PM2 ──────────────────────────────────────────────────────────
echo ""
echo "📦  Installing PM2..."
sudo npm install -g pm2
echo "PM2:  $(pm2 --version)"

# ── Nginx ─────────────────────────────────────────────────────────
echo ""
echo "📦  Installing nginx..."
sudo apt-get install -y nginx

# ── Create server directory ───────────────────────────────────────
echo ""
echo "📁  Creating server directory..."
mkdir -p /home/ojjiemeka/tzurah-server
mkdir -p /home/ojjiemeka/tzurah-server/logs

# ── PM2 startup ───────────────────────────────────────────────────
echo ""
echo "⚙️   Configuring PM2 startup on boot..."
pm2 startup || true
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ojjiemeka --hp /home/ojjiemeka || true

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  ✅  VM setup complete!"
echo "  Node: $(node --version)"
echo "  NPM:  $(npm --version)"
echo "  PM2:  $(pm2 --version)"
echo ""
echo "  NEXT STEPS:"
echo "  1. Run deploy.sh from your local machine"
echo "  2. SSH in and create /home/ojjiemeka/tzurah-server/.env"
echo "  3. Run: cd ~/tzurah-server && pm2 start ecosystem.config.js --env production"
echo "  4. Run nginx-setup.sh on the VM"
echo "═══════════════════════════════════════════════════════════════"
echo ""
