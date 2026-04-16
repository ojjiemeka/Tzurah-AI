/**
 * unseed-data.js — Remove all test data from Supabase
 *
 * Usage:
 *   node unseed-data.js
 *
 * Deletes:
 *   - All auth users with @test.com emails
 *   - testviewer@tzurah.ai
 *   - Their profiles, purchases, and usage rows
 *
 * Requires .env with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 */

"use strict";

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL              || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// Emails to remove — extend this list if you added more test users
const TEST_EMAIL_PATTERNS = [
  "@test.com",
  "testviewer@tzurah.ai",
];

function isTestEmail(email) {
  if (!email) return false;
  return TEST_EMAIL_PATTERNS.some(p => email.endsWith(p) || email === p);
}

function log(msg) { console.log("  " + msg); }

async function main() {
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║   Tzurah Live — Unseed (Cleanup)                 ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env");
    process.exit(1);
  }

  // 1. List all auth users and find test accounts
  log("Fetching all auth users...");
  const { data: authData, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) {
    console.error("Failed to list users:", listErr.message);
    process.exit(1);
  }

  const allUsers   = authData?.users || [];
  const testUsers  = allUsers.filter(u => isTestEmail(u.email));

  if (testUsers.length === 0) {
    console.log("  No test users found — nothing to clean up.\n");
    return;
  }

  console.log(`\n  Found ${testUsers.length} test user(s) to remove:\n`);
  testUsers.forEach(u => log(`  • ${u.email} (${u.id})`));
  console.log();

  const testIds = testUsers.map(u => u.id);

  // 2. Delete usage rows for test users
  log("Deleting usage records...");
  const { error: usageErr, count: usageCount } = await supabase
    .from("usage")
    .delete({ count: "exact" })
    .in("user_id", testIds);

  if (usageErr) {
    log(`  ⚠  Usage delete error: ${usageErr.message}`);
  } else {
    log(`  ✓  Deleted usage rows (${usageCount ?? "some"})`);
  }

  // 3. Delete purchase rows for test users
  log("Deleting purchase records...");
  const { error: purchErr, count: purchCount } = await supabase
    .from("purchases")
    .delete({ count: "exact" })
    .in("user_id", testIds);

  if (purchErr) {
    log(`  ⚠  Purchases delete error: ${purchErr.message}`);
  } else {
    log(`  ✓  Deleted purchase rows (${purchCount ?? "some"})`);
  }

  // 4. Delete profile rows for test users
  log("Deleting profile records...");
  const { error: profErr, count: profCount } = await supabase
    .from("profiles")
    .delete({ count: "exact" })
    .in("id", testIds);

  if (profErr) {
    log(`  ⚠  Profiles delete error: ${profErr.message}`);
  } else {
    log(`  ✓  Deleted profile rows (${profCount ?? "some"})`);
  }

  // 5. Delete auth users
  log("Deleting auth users...");
  let deletedCount = 0;
  let failedCount  = 0;

  for (const user of testUsers) {
    const { error: delErr } = await supabase.auth.admin.deleteUser(user.id);
    if (delErr) {
      log(`  ✗  Failed to delete ${user.email}: ${delErr.message}`);
      failedCount++;
    } else {
      deletedCount++;
    }
  }

  console.log(`\n  ✓  Auth users deleted: ${deletedCount}`);
  if (failedCount > 0) {
    console.log(`  ⚠  Auth users failed:  ${failedCount}`);
  }

  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║   Cleanup complete.                              ║");
  console.log("║   Refresh admin dashboard to confirm.            ║");
  console.log("╚══════════════════════════════════════════════════╝\n");
}

main().catch(err => {
  console.error("\nFatal error:", err.message);
  process.exit(1);
});
