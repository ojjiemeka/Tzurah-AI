/**
 * seed-data.js — Populate Supabase with realistic test data
 *
 * Usage:
 *   node seed-data.js
 *
 * Requires .env with:
 *   SUPABASE_URL=...
 *   SUPABASE_SERVICE_ROLE_KEY=...
 */

"use strict";

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL             || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// ── Test users ────────────────────────────────────────────────────
const TEST_USERS = [
  { email: "streamer1@test.com",   password: "Test1234!", name: "Jake Rivers",   credits: 216,  pack: "pro",      spent: 100, creditsUsed: 84  },
  { email: "creator2@test.com",    password: "Test1234!", name: "Mia Chen",      credits: 42,   pack: "starter",  spent: 20,  creditsUsed: 0   },
  { email: "gamer3@test.com",      password: "Test1234!", name: "Tyler Okafor",  credits: 132,  pack: "standard", spent: 60,  creditsUsed: 0   },
  { email: "vtuber4@test.com",     password: "Test1234!", name: "Luna Star",     credits: 450,  pack: "ultra",    spent: 200, creditsUsed: 0   },
  { email: "influencer5@test.com", password: "Test1234!", name: "Sofia Reyes",   credits: 72,   pack: "basic",    spent: 35,  creditsUsed: 0   },
  { email: "streamer6@test.com",   password: "Test1234!", name: "Marcus Webb",   credits: 1200, pack: "max",      spent: 500, creditsUsed: 0   },
  { email: "creator7@test.com",    password: "Test1234!", name: "Priya Sharma",  credits: 0,    pack: "starter",  spent: 20,  creditsUsed: 42  },
  { email: "gamer8@test.com",      password: "Test1234!", name: "Alex Novak",    credits: 216,  pack: "pro",      spent: 100, creditsUsed: 0   },
  { email: "vlogger9@test.com",    password: "Test1234!", name: "Zara Mitchell", credits: 132,  pack: "standard", spent: 60,  creditsUsed: 0   },
  { email: "podcaster10@test.com", password: "Test1234!", name: "Ben Torres",    credits: 42,   pack: "starter",  spent: 20,  creditsUsed: 0   },
];

// Test admin viewer — can log in to Electron but has 0 credits
const TEST_VIEWER = {
  email:    "testviewer@tzurah.ai",
  password: "ViewOnly2025!",
  name:     "Test Viewer",
  credits:  0,
  pack:     null,
  spent:    0,
  creditsUsed: 0,
};

// Pack definitions (mirrors gcp-server.js)
const PACKS = {
  starter:  { name: "Starter",  price: 20,  credits: 42   },
  basic:    { name: "Basic",    price: 35,  credits: 72   },
  standard: { name: "Standard", price: 60,  credits: 132  },
  pro:      { name: "Pro",      price: 100, credits: 216  },
  ultra:    { name: "Ultra",    price: 200, credits: 450  },
  max:      { name: "Max",      price: 500, credits: 1200 },
};

// ── Helpers ───────────────────────────────────────────────────────

/** Random ISO timestamp within the last `daysBack` days */
function randomDate(daysBack = 30) {
  const now = Date.now();
  const ago = Math.floor(Math.random() * daysBack * 86_400_000);
  const d   = new Date(now - ago);
  d.setHours(Math.floor(Math.random() * 24));
  d.setMinutes(Math.floor(Math.random() * 60));
  d.setSeconds(Math.floor(Math.random() * 60));
  return d.toISOString();
}

/** Random integer between min and max (inclusive) */
function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Pad console output */
function log(msg) { console.log("  " + msg); }

// ── Seed one user ─────────────────────────────────────────────────
async function seedUser(userData) {
  const { email, password, name, credits, pack, spent, creditsUsed } = userData;
  log(`Seeding ${email}...`);

  // 1. Create auth user
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: name },
  });

  if (createErr) {
    if (createErr.message.includes("already been registered")) {
      log(`  ⚠  Already exists — skipping auth create`);
      // Try to find existing user
      const { data: existing } = await supabase.auth.admin.listUsers({ perPage: 1000 });
      const found = (existing?.users || []).find(u => u.email === email);
      if (!found) { log(`  ✗  Could not find existing user`); return null; }
      return continueSeeding(found.id, userData);
    }
    log(`  ✗  Auth create failed: ${createErr.message}`);
    return null;
  }

  const userId = created.user.id;
  return continueSeeding(userId, userData);
}

async function continueSeeding(userId, userData) {
  const { email, name, credits, pack, spent, creditsUsed } = userData;
  const packDef = pack ? PACKS[pack] : null;

  // 2. Upsert profile row
  // (If a DB trigger already created a profile, this will update it)
  const profileData = {
    id:                      userId,
    display_name:            name,
    credits:                 credits,
    total_credits_purchased: packDef ? packDef.credits : 0,
    total_credits_used:      creditsUsed,
    // Spread signups over last 30 days, recent users in last 7
    created_at:              randomDate(30),
    // Most users have been seen recently
    last_seen:               randomDate(3),
  };

  const { error: profileErr } = await supabase
    .from("profiles")
    .upsert(profileData, { onConflict: "id" });

  if (profileErr) {
    log(`  ✗  Profile upsert failed: ${profileErr.message}`);
  } else {
    log(`  ✓  Profile: ${name} | ${credits} credits`);
  }

  // 3. Insert purchase record (if user bought a pack)
  if (packDef) {
    const purchaseDate = randomDate(28);
    const { error: purchErr } = await supabase.from("purchases").insert({
      user_id:           userId,
      pack_name:         packDef.name,
      price_usd:         packDef.price,
      credits_added:     packDef.credits,
      stripe_payment_id: "test_pi_" + userId.replace(/-/g, "").slice(0, 16),
      created_at:        purchaseDate,
    });

    if (purchErr) {
      log(`  ✗  Purchase insert failed: ${purchErr.message}`);
    } else {
      log(`  ✓  Purchase: ${packDef.name} pack — $${packDef.price}`);
    }
  }

  // 4. Insert 2–5 usage sessions spread over last 14 days
  if (creditsUsed > 0 || Math.random() > 0.3) {
    const sessionCount = rand(2, 5);
    const sessions = [];
    let remainingCredits = creditsUsed > 0 ? creditsUsed : rand(5, 30);

    for (let i = 0; i < sessionCount; i++) {
      const sessionSecs   = rand(30, 300);
      const sessionCredit = Math.round(Math.min(
        sessionSecs * 0.1,
        remainingCredits > 0 ? remainingCredits : sessionSecs * 0.1
      ));
      const endedAt   = randomDate(14);
      const startedAt = new Date(new Date(endedAt).getTime() - sessionSecs * 1000).toISOString();

      sessions.push({
        user_id:         userId,
        session_seconds: sessionSecs,
        credits_used:    sessionCredit,
        started_at:      startedAt,
        ended_at:        endedAt,
        created_at:      endedAt,
      });

      remainingCredits -= sessionCredit;
    }

    const { error: usageErr } = await supabase.from("usage").insert(sessions);
    if (usageErr) {
      log(`  ✗  Usage insert failed: ${usageErr.message}`);
    } else {
      log(`  ✓  Usage: ${sessions.length} sessions`);
    }
  }

  return userId;
}

// ── Add extra historical purchases to spread the revenue chart ────
async function seedHistoricalPurchases(userIds) {
  log("\nSeeding historical purchase spread (30 days)...");

  // Simulate 15-25 additional purchases spread over 30 days
  const extraPurchases = [];
  const packKeys = Object.keys(PACKS);
  const count = rand(15, 25);

  for (let i = 0; i < count; i++) {
    const userId  = userIds[Math.floor(Math.random() * userIds.length)];
    const packKey = packKeys[Math.floor(Math.random() * packKeys.length)];
    const packDef = PACKS[packKey];

    extraPurchases.push({
      user_id:           userId,
      pack_name:         packDef.name,
      price_usd:         packDef.price,
      credits_added:     packDef.credits,
      stripe_payment_id: "test_hist_" + Math.random().toString(36).slice(2, 14),
      created_at:        randomDate(30),
    });
  }

  const { error } = await supabase.from("purchases").insert(extraPurchases);
  if (error) {
    log(`  ✗  Historical purchases failed: ${error.message}`);
  } else {
    log(`  ✓  ${extraPurchases.length} historical purchases across 30 days`);
  }
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║   Tzurah Live — Seed Data                        ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env");
    process.exit(1);
  }

  const userIds = [];

  // Seed 10 test users
  console.log("── Test users ─────────────────────────────────────\n");
  for (const user of TEST_USERS) {
    const id = await seedUser(user);
    if (id) userIds.push(id);
    console.log();
  }

  // Seed test viewer account
  console.log("── Test viewer account ────────────────────────────\n");
  const viewerId = await seedUser(TEST_VIEWER);
  if (viewerId) {
    log(`✓  testviewer@tzurah.ai can log in to Electron (0 credits — tests topup flow)`);
  }
  console.log();

  // Seed historical purchases for chart data
  if (userIds.length > 0) {
    await seedHistoricalPurchases(userIds);
  }

  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║   Done! Open admin dashboard to verify:          ║");
  console.log("║   http://34.39.83.195:4000/admin                 ║");
  console.log("║                                                  ║");
  console.log("║   Expected overview:                             ║");
  console.log("║   • Total Users: 11 (10 test + 1 viewer)        ║");
  console.log("║   • Total Revenue: $1,115+ (test packs)         ║");
  console.log("║   • Revenue chart: spread over 30 days          ║");
  console.log("║   • Pack breakdown: all 6 packs represented     ║");
  console.log("╚══════════════════════════════════════════════════╝\n");
}

main().catch(err => {
  console.error("\nFatal error:", err.message);
  process.exit(1);
});
