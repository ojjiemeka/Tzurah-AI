#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  Run on the GCP VM after nginx.conf has been uploaded:
#    bash nginx-setup.sh
# ═══════════════════════════════════════════════════════════════

set -e

echo "⚙️   Configuring nginx for Tzurah Live..."

# Copy config
sudo cp nginx.conf /etc/nginx/sites-available/tzurah

# Enable site
sudo ln -sf /etc/nginx/sites-available/tzurah /etc/nginx/sites-enabled/tzurah

# Disable default site if present
sudo rm -f /etc/nginx/sites-enabled/default

# Test config
echo "🔍  Testing nginx config..."
sudo nginx -t

# Reload
echo "🔄  Reloading nginx..."
sudo systemctl reload nginx

echo ""
echo "✅  Nginx configured!"
echo "🌐  http://34.39.83.195  →  Node.js on port 4000"
