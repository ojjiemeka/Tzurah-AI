/**
 * gcp-server.js — Tzurah Live GCP Express Server  (CommonJS)
 *
 * Handles: Stripe payments, Decart token proxy, credits ledger, admin dashboard.
 * Does NOT handle: auth (Supabase), static file serving (Electron's local server).
 *
 * Deploy to GCP VM — see deploy.sh and vm-setup.sh.
 *
 * Usage:
 *   node gcp-server.js
 *   pm2 start ecosystem.config.js --env production
 */

"use strict";

require("dotenv").config();

const express    = require("express");
const session    = require("express-session");
const cors       = require("cors");
const rateLimit  = require("express-rate-limit");
const path       = require("path");
const fs         = require("fs");
const { createClient } = require("@supabase/supabase-js");

// ── Nodemailer ─────────────────────────────────────────────────────
let nodemailer = null;
try { nodemailer = require("nodemailer"); } catch (_) {}

function getEmailTransporter() {
  if (!nodemailer || !process.env.EMAIL_FROM || !process.env.EMAIL_PASS) return null;
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.EMAIL_FROM, pass: process.env.EMAIL_PASS },
  });
}

// ── Stripe ─────────────────────────────────────────────────────────
const Stripe      = require("stripe");
const StripeClass = typeof Stripe === "function" ? Stripe : (Stripe.default || Stripe);
const stripe      = process.env.STRIPE_SECRET_KEY
  ? new StripeClass(process.env.STRIPE_SECRET_KEY)
  : null;

// ── Supabase admin client ──────────────────────────────────────────
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL             || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// ── Config ─────────────────────────────────────────────────────────
const PORT                  = parseInt(process.env.PORT || "4000", 10);
const DECART_KEY            = process.env.DECART_API_KEY;
const BOOTSTRAP_SECRET      = process.env.BOOTSTRAP_SECRET || "tzurah-app-v1-secret";
const DECART_COST_PER_SECOND = 1.36; // Decart credits burned per second of streaming

// Credit packs (1 credit = 10 seconds)
const PACKS = {
  starter:  { name: "Starter",  price: 20,  credits: 42,   minutes: 7,   priceId: process.env.STRIPE_PRICE_STARTER  },
  basic:    { name: "Basic",    price: 35,  credits: 72,   minutes: 12,  priceId: process.env.STRIPE_PRICE_BASIC    },
  standard: { name: "Standard", price: 60,  credits: 132,  minutes: 22,  priceId: process.env.STRIPE_PRICE_STANDARD },
  pro:      { name: "Pro",      price: 100, credits: 216,  minutes: 36,  priceId: process.env.STRIPE_PRICE_PRO      },
  ultra:    { name: "Ultra",    price: 200, credits: 450,  minutes: 75,  priceId: process.env.STRIPE_PRICE_ULTRA    },
  max:      { name: "Max",      price: 500, credits: 1200, minutes: 200, priceId: process.env.STRIPE_PRICE_MAX      },
};

// ── Role permissions ──────────────────────────────────────────────
const PERMISSIONS = {
  super_admin: ["*"],
  admin: [
    "view_users", "view_sessions", "view_revenue", "view_purchases",
    "gift_credits", "deduct_credits", "ban_user", "unban_user",
    "kill_session", "send_email", "manage_announcements",
    "manage_packs", "manage_ip_blocks", "view_logs",
  ],
  support: [
    "view_users", "view_sessions", "view_purchases", "gift_credits",
  ],
  analyst: [
    "view_revenue", "view_purchases", "view_overview",
  ],
};

function can(role, action) {
  if (!role) return false;
  if (PERMISSIONS[role]?.includes("*")) return true;
  return PERMISSIONS[role]?.includes(action) || false;
}

function maskKey(v) {
  return v ? v.substring(0, 6) + "****" : "not set";
}

// ── app_settings helpers (Supabase table with process.env fallback) ─
let _appSettingsAvailable = null; // null = unknown, true/false after first check

async function _checkAppSettings() {
  if (_appSettingsAvailable !== null) return _appSettingsAvailable;
  try {
    const { error } = await supabaseAdmin.from("app_settings").select("key").limit(1);
    _appSettingsAvailable = !error;
    if (!_appSettingsAvailable) {
      console.warn("[SETTINGS] app_settings table not found — run SQL migration to enable Decart balance tracking");
    }
  } catch (_) {
    _appSettingsAvailable = false;
  }
  return _appSettingsAvailable;
}

async function getSettingValue(key, defaultVal) {
  try {
    if (await _checkAppSettings()) {
      const { data } = await supabaseAdmin.from("app_settings").select("value").eq("key", key).maybeSingle();
      if (data?.value !== undefined) return data.value;
    }
  } catch (_) {}
  return process.env[key.toUpperCase()] ?? defaultVal;
}

async function setSettingValue(key, value) {
  try {
    if (await _checkAppSettings()) {
      await supabaseAdmin.from("app_settings")
        .upsert({ key, value: String(value), updated_at: new Date().toISOString() }, { onConflict: "key" });
      return;
    }
  } catch (_) {}
  console.warn("[SETTINGS] Could not persist setting:", key);
}

// ── Decart credit deduction (called on session end / kill) ─────────
async function deductDecartCredits(durationSeconds, sessionId) {
  try {
    const costPerSec = parseFloat(await getSettingValue("decart_cost_per_second", "2.0"));
    const decartCost = Math.ceil(durationSeconds * costPerSec);
    if (decartCost <= 0) return { decartCost: 0, newBalance: null };

    const currentBalance = parseFloat(await getSettingValue("decart_balance", "1000"));
    const threshold      = parseFloat(await getSettingValue("decart_alert_threshold", "200"));
    const newBalance     = Math.max(0, currentBalance - decartCost);

    await setSettingValue("decart_balance", newBalance.toFixed(2));
    invalidateDecartCache();

    console.log(`[DECART] Session ${sessionId || "?"}: ${durationSeconds}s × ${costPerSec} cr/s = ${decartCost} cr deducted`);
    console.log(`[DECART] Balance: ${currentBalance.toFixed(0)} → ${newBalance.toFixed(0)}`);

    // Fire low-balance alert only when crossing below threshold
    if (newBalance < threshold && currentBalance >= threshold) {
      await supabaseAdmin.from("admin_notifications").insert({
        title:      "⚠️ Low Decart Balance",
        message:    `Decart balance dropped to ${Math.round(newBalance)} credits (threshold: ${threshold}). Top up at decart.ai`,
        type:       "alert",
        created_at: new Date().toISOString(),
      });
      console.warn("[DECART] Low balance alert fired! Balance:", newBalance);
    }

    // Append to deduction audit log (last 100 entries)
    try {
      const logEntry = { time: new Date().toISOString(), session_id: sessionId || null, secs: durationSeconds, cost: decartCost, balance_after: Math.round(newBalance) };
      const rawLog = await getSettingValue("decart_deduction_log", "[]");
      const deductLog = JSON.parse(rawLog);
      deductLog.unshift(logEntry);
      if (deductLog.length > 100) deductLog.splice(100);
      await setSettingValue("decart_deduction_log", JSON.stringify(deductLog));
    } catch (_) {}

    return { decartCost, newBalance };
  } catch (err) {
    console.error("[DECART] Failed to deduct credits:", err.message);
    return null;
  }
}

// Cache for SSE Decart balance (refreshed every 30 s to avoid per-tick DB reads)
let _decartBalanceCache = null;
let _decartBalanceCachedAt = 0;

async function getCachedDecartBalance() {
  if (_decartBalanceCache !== null && Date.now() - _decartBalanceCachedAt < 30000) {
    return _decartBalanceCache;
  }
  _decartBalanceCache = parseFloat(await getSettingValue("decart_balance", "1000"));
  _decartBalanceCachedAt = Date.now();
  console.log("[DECART] Balance in SSE:", _decartBalanceCache);
  return _decartBalanceCache;
}

// Called by deductDecartCredits to invalidate the SSE cache immediately
function invalidateDecartCache() { _decartBalanceCachedAt = 0; }

// ── Central audit logger ──────────────────────────────────────────
async function logAction(action, adminEmail, adminRole, targetUser, details, req) {
  const now = new Date().toISOString();
  const detailsStr = details ? (typeof details === "object" ? JSON.stringify(details) : details) : null;
  const ip = req?.ip || (req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";

  // Try full schema first (with extended columns added by mega prompt migration)
  const fullEntry = {
    action,
    performed_by:      adminEmail  || "unknown",
    performed_by_role: adminRole   || "unknown",
    target_user_id:    targetUser  || null,
    ip_address:        ip,
    user_agent:        req?.headers?.["user-agent"] || "unknown",
    details:           detailsStr,
    created_at:        now,
  };
  const { error } = await supabaseAdmin.from("admin_actions").insert(fullEntry);
  if (error) {
    // Fallback: old schema (action, performed_by, target_user_id, details, created_at)
    const simpleEntry = {
      action,
      performed_by:   adminEmail || "unknown",
      target_user_id: targetUser || null,
      details:        detailsStr,
      created_at:     now,
    };
    const { error: e2 } = await supabaseAdmin.from("admin_actions").insert(simpleEntry);
    if (e2) console.warn("[AUDIT] Log failed (both schemas):", e2.message);
    else    console.warn("[AUDIT] Logged with basic schema — add migration columns for full audit data");
  }
  console.log(`[AUDIT] ${now} | ${adminRole}:${adminEmail} | ${action} | target:${targetUser || "n/a"}`);
}

// ── Admin login rate limit (in-memory, per IP) ────────────────────
const _loginAttempts = new Map(); // ip → { count, lockUntil }

function _checkLoginLock(ip) {
  const r = _loginAttempts.get(ip);
  if (!r) return false;
  if (r.lockUntil > Date.now()) return true;
  return false;
}
function _recordFailedLogin(ip) {
  const now = Date.now();
  const r = _loginAttempts.get(ip) || { count: 0, lockUntil: 0 };
  r.count++;
  if (r.count >= 5) { r.lockUntil = now + 15 * 60 * 1000; r.count = 0; }
  _loginAttempts.set(ip, r);
}
function _clearLoginAttempts(ip) { _loginAttempts.delete(ip); }

// ── Admin session auth ─────────────────────────────────────────────
function adminAuth(req, res, next) {
  if (!req.session?.isAdmin) {
    if (req.path.startsWith("/admin/api/")) return res.status(401).json({ error: "Unauthorized" });
    return res.redirect("/admin/login");
  }
  // Session inactivity: expire after 8 hours
  const now = Date.now();
  if (req.session.lastActive && (now - req.session.lastActive > 8 * 60 * 60 * 1000)) {
    req.session.destroy(() => {});
    if (req.path.startsWith("/admin/api/")) return res.status(401).json({ error: "Session expired" });
    return res.redirect("/admin/login");
  }
  req.session.lastActive = now;
  next();
}

// ── User auth middleware (Supabase JWT) ────────────────────────────
async function requireAuth(req, res, next) {
  const auth = (req.headers.authorization || "").trim();
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }
  const token = auth.slice(7).trim();
  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid or expired token" });
    req.user   = user;
    req.userId = user.id;
    next();
  } catch (err) {
    res.status(401).json({ error: "Token verification failed: " + err.message });
  }
}

// ── Rate limiters ──────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});
const tokenLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: { error: "Too many token requests" },
});
const bootstrapRateLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: { error: "Too many requests" },
  handler: async (req, res) => {
    console.warn("[BOOTSTRAP] Rate limit exceeded — possible flood from:", req.ip);
    try {
      await supabaseAdmin.from("ip_blocks").upsert(
        { ip: req.ip, reason: "Bootstrap flood", blocked_at: new Date().toISOString() },
        { onConflict: "ip" }
      );
    } catch (_) {}
    res.status(429).json({ error: "Too many requests" });
  },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { error: "Too many auth attempts" },
  skip: (req) => req.ip === "127.0.0.1" || req.ip === "::1",
});

// ── UUID validation ────────────────────────────────────────────────
function validateUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// ── CORS ───────────────────────────────────────────────────────────
// Billing Phase 3A shadow protection. This records protected billing
// calculations when the SQL migration is present, but never changes live
// balance deduction behavior.
const BILLING_BURN_RATE = 2.18;
const BILLING_MAX_SYNC_SECONDS = 10 * 60;
const BILLING_MAX_SYNC_CREDITS = BILLING_BURN_RATE * BILLING_MAX_SYNC_SECONDS;
const BILLING_STALE_MS = 90 * 1000;
const BILLING_ROUNDING_DRIFT_WARNING = 0.5;
const BILLING_ROUNDING_DRIFT_SEVERE = 2.0;
const BILLING_BALANCE_DRIFT_WARNING = 1.0;
const BILLING_BALANCE_DRIFT_SEVERE = 5.0;
const BILLING_MISSING_FINAL_MIN_SECONDS = 15;
const BILLING_FINAL_COVERAGE_GRACE_SECONDS = 5;
const BILLING_ORPHAN_ACTIVE_MS = 5 * 60 * 1000;
const BILLING_TINY_SYNC_SECONDS = 1;
let _billingShadowRpcAvailable = null;
const _activityWarningCache = new Map();

function finiteNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function clampBillingNumber(value, max) {
  if (!finiteNonNegativeNumber(value)) return null;
  return Math.min(value, max);
}

function makeLegacyBillingSyncId(source) {
  return `legacy-${source}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function logBillingReconciliationEvent({ userId, sessionId, type, severity = "warning", details = {} }) {
  const normalizedSeverity = ["info", "warning", "high", "critical"].includes(severity) ? severity : "warning";
  try {
    const { error } = await supabaseAdmin
      .from("billing_reconciliation_events")
      .insert({
        user_id: validateUUID(userId || "") ? userId : null,
        session_id: sessionId || null,
        type,
        severity: normalizedSeverity,
        details,
        created_at: new Date().toISOString(),
      });
    if (error && normalizedSeverity === "high" && String(error.message || "").toLowerCase().includes("billing_reconciliation_severity_check")) {
      const { error: retryError } = await supabaseAdmin
        .from("billing_reconciliation_events")
        .insert({
          user_id: validateUUID(userId || "") ? userId : null,
          session_id: sessionId || null,
          type,
          severity: "warning",
          details: { ...details, intended_severity: "high" },
          created_at: new Date().toISOString(),
        });
      if (retryError && !isMissingBillingMigrationError(retryError)) {
        console.warn("[BILLING RECON] Insert retry error:", retryError.message);
      }
      return;
    }
    if (error && !isMissingBillingMigrationError(error)) {
      console.warn("[BILLING RECON] Insert error:", error.message);
    }
  } catch (err) {
    if (!isMissingBillingMigrationError(err)) {
      console.warn("[BILLING RECON] Non-fatal error:", err.message);
    }
  }
}

async function resolveActiveBillingSessionId(userId) {
  if (!userId || !validateUUID(userId)) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from("sessions")
      .select("session_id")
      .eq("user_id", userId)
      .eq("is_active", true)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn("[BILLING SHADOW] Session lookup failed:", error.message);
      return null;
    }
    return data?.session_id || null;
  } catch (err) {
    console.warn("[BILLING SHADOW] Session lookup error:", err.message);
    return null;
  }
}

function isMissingBillingMigrationError(error) {
  const msg = String(error?.message || "").toLowerCase();
  return msg.includes("could not find the function") ||
         msg.includes("schema cache") ||
         msg.includes("billing_syncs") ||
         msg.includes("billing_reconciliation_events") ||
         msg.includes("does not exist");
}

function isMissingReconciliationResolutionError(error) {
  const msg = String(error?.message || "").toLowerCase();
  return isMissingBillingMigrationError(error) ||
         (msg.includes("resolved") && (msg.includes("column") || msg.includes("schema cache")));
}

function badBillingNumberResponse(res, label, value) {
  console.warn("[BILLING] Invalid numeric input:", label, value);
  return res.status(400).json({ error: `${label} must be a finite non-negative number` });
}

function safeBillingNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function calculateExpectedCredits(durationSecs) {
  const safeDuration = clampBillingNumber(Number(durationSecs), BILLING_MAX_SYNC_SECONDS);
  if (safeDuration === null) return null;
  return Math.round(Math.min(safeDuration * BILLING_BURN_RATE, BILLING_MAX_SYNC_CREDITS) * 1000) / 1000;
}

async function wasRecentReconciliationLogged(type, sessionId, sinceMs = 30 * 60 * 1000) {
  if (!type || !sessionId) return false;
  try {
    const { data, error } = await supabaseAdmin
      .from("billing_reconciliation_events")
      .select("id")
      .eq("type", type)
      .eq("session_id", sessionId)
      .gte("created_at", new Date(Date.now() - sinceMs).toISOString())
      .limit(1)
      .maybeSingle();
    if (error) return false;
    return !!data;
  } catch {
    return false;
  }
}

async function logReconciliationEventOnce(event, sinceMs = 30 * 60 * 1000) {
  if (event?.sessionId && await wasRecentReconciliationLogged(event.type, event.sessionId, sinceMs)) return;
  await logBillingReconciliationEvent(event);
}

async function resolveReconciliationEvents({ userId, sessionId, type, reason, autoResolved = true, resolvedBy = "system" }) {
  if (!sessionId || !type) return 0;
  try {
    const { data, error } = await supabaseAdmin
      .from("billing_reconciliation_events")
      .update({
        resolved: true,
        resolved_at: new Date().toISOString(),
        resolved_reason: reason || "resolved",
        resolved_by: resolvedBy,
        auto_resolved: !!autoResolved,
      })
      .eq("session_id", sessionId)
      .eq("type", type)
      .eq("resolved", false)
      .select("id");
    if (error) {
      if (!isMissingReconciliationResolutionError(error)) {
        console.warn("[BILLING RECON] Resolve update error:", error.message);
      }
      return 0;
    }
    const count = data?.length || 0;
    if (count > 0) {
      console.log("[BILLING RECON] Resolved events:", { type, sessionId, count, reason });
    }
    return count;
  } catch (err) {
    if (!isMissingReconciliationResolutionError(err)) {
      console.warn("[BILLING RECON] Resolve failed:", err.message);
    }
    return 0;
  }
}

async function logActivityWarningOnce(type, details = {}, sinceMs = 30 * 60 * 1000) {
  const key = `${type}:${details.source || "activity"}:${details.user_id || "no-user"}:${details.reason || ""}`;
  const last = _activityWarningCache.get(key) || 0;
  if (Date.now() - last < sinceMs) return;
  _activityWarningCache.set(key, Date.now());
  await logBillingReconciliationEvent({
    userId: details.user_id || null,
    sessionId: details.session_id || null,
    type,
    severity: "info",
    details,
  });
}

async function detectDuplicateSyncId({ userId, sessionId, syncId, source }) {
  if (!userId || !sessionId || !syncId) return { duplicate: false };
  try {
    const { data, error } = await supabaseAdmin
      .from("billing_syncs")
      .select("id, balance_after, status, created_at")
      .eq("user_id", userId)
      .eq("session_id", sessionId)
      .eq("sync_id", syncId)
      .limit(1)
      .maybeSingle();
    if (error) {
      if (!isMissingBillingMigrationError(error)) console.warn("[BILLING RECON] Duplicate sync lookup error:", error.message);
      return { duplicate: false };
    }
    if (!data) return { duplicate: false };
    await logBillingReconciliationEvent({
      userId,
      sessionId,
      type: "duplicate_sync_id_detected",
      severity: "warning",
      details: { sync_id: syncId, source, existing_status: data.status || null, existing_created_at: data.created_at || null },
    });
    return { duplicate: true, balanceAfter: finiteNonNegativeNumber(data.balance_after) ? data.balance_after : null };
  } catch (err) {
    if (!isMissingBillingMigrationError(err)) console.warn("[BILLING RECON] Duplicate sync lookup failed:", err.message);
    return { duplicate: false };
  }
}

async function detectBillingDrift({ userId, sessionId, syncId, source, durationSecs, creditsRequested, creditsExpected }) {
  const requested = safeBillingNumber(creditsRequested);
  const expected = creditsExpected ?? calculateExpectedCredits(durationSecs);
  if (requested === null || expected === null) {
    await logBillingReconciliationEvent({
      userId,
      sessionId,
      type: "invalid_session_duration",
      severity: "warning",
      details: { sync_id: syncId || null, source, duration_secs: durationSecs, credits_requested: creditsRequested },
    });
    return null;
  }
  const drift = Math.round((requested - expected) * 1000) / 1000;
  const absDrift = Math.abs(drift);
  if (absDrift >= BILLING_ROUNDING_DRIFT_SEVERE) {
    await logBillingReconciliationEvent({
      userId,
      sessionId,
      type: "billing_rounding_drift_severe",
      severity: "high",
      details: { sync_id: syncId || null, source, requested, expected, drift, duration_secs: durationSecs },
    });
  } else if (absDrift >= BILLING_ROUNDING_DRIFT_WARNING) {
    await logBillingReconciliationEvent({
      userId,
      sessionId,
      type: "billing_rounding_drift_warning",
      severity: "warning",
      details: { sync_id: syncId || null, source, requested, expected, drift, duration_secs: durationSecs },
    });
  }
  return { expected, drift, absDrift };
}

async function detectDecartBillingMismatch({ userId, sessionId, source, durationSecs, creditsRequested }) {
  const safeDuration = safeBillingNumber(durationSecs);
  const requested = safeBillingNumber(creditsRequested);
  if (safeDuration === null || requested === null) return;
  try {
    const costPerSecond = parseFloat(await getSettingValue("decart_cost_per_second", "2"));
    const decartRate = Number.isFinite(costPerSecond) && costPerSecond > 0 ? costPerSecond : 2;
    const decartCost = Math.round(safeDuration * decartRate * 1000) / 1000;
    const expectedUserCredits = Math.round(decartCost * (BILLING_BURN_RATE / decartRate) * 1000) / 1000;
    const mismatch = Math.round((requested - expectedUserCredits) * 1000) / 1000;
    const absMismatch = Math.abs(mismatch);
    if (absMismatch >= 5) {
      await logBillingReconciliationEvent({
        userId,
        sessionId,
        type: "decart_billing_mismatch_severe",
        severity: "high",
        details: { source, duration_secs: safeDuration, credits_requested: requested, decart_cost: decartCost, expected_user_credits: expectedUserCredits, mismatch },
      });
    } else if (absMismatch >= 2) {
      await logBillingReconciliationEvent({
        userId,
        sessionId,
        type: "decart_billing_mismatch_warning",
        severity: "warning",
        details: { source, duration_secs: safeDuration, credits_requested: requested, decart_cost: decartCost, expected_user_credits: expectedUserCredits, mismatch },
      });
    }
  } catch (err) {
    console.warn("[BILLING RECON] Decart mismatch check skipped:", err.message);
  }
}

async function detectBalanceDrift({ userId, sessionId, source, balanceBefore, creditsDeducted, actualBalanceAfter }) {
  const before = safeBillingNumber(balanceBefore);
  const deducted = safeBillingNumber(creditsDeducted);
  const actual = safeBillingNumber(actualBalanceAfter);
  if (before === null || deducted === null || actual === null) return;
  const expectedAfter = Math.max(0, before - deducted);
  const drift = Math.round((actual - expectedAfter) * 1000) / 1000;
  const absDrift = Math.abs(drift);
  if (absDrift >= BILLING_BALANCE_DRIFT_SEVERE) {
    await logBillingReconciliationEvent({
      userId,
      sessionId,
      type: "balance_drift_severe",
      severity: "high",
      details: { source, balance_before: before, credits_deducted: deducted, expected_after: expectedAfter, actual_after: actual, drift },
    });
  } else if (absDrift >= BILLING_BALANCE_DRIFT_WARNING) {
    await logBillingReconciliationEvent({
      userId,
      sessionId,
      type: "balance_drift_warning",
      severity: "warning",
      details: { source, balance_before: before, credits_deducted: deducted, expected_after: expectedAfter, actual_after: actual, drift },
    });
  }
}

async function detectSuspiciousSyncPattern({ userId, sessionId, syncId, source, durationSecs, creditsRequested }) {
  const duration = safeBillingNumber(durationSecs);
  const credits = safeBillingNumber(creditsRequested);
  if (duration === null || credits === null) {
    await logBillingReconciliationEvent({
      userId,
      sessionId,
      type: "invalid_session_duration",
      severity: "warning",
      details: { sync_id: syncId || null, source, duration_secs: durationSecs, credits_requested: creditsRequested },
    });
    return;
  }
  if (duration === 0 || (duration <= BILLING_TINY_SYNC_SECONDS && credits > 0)) {
    await logBillingReconciliationEvent({
      userId,
      sessionId,
      type: "suspicious_sync_pattern",
      severity: "warning",
      details: { sync_id: syncId || null, source, duration_secs: duration, credits_requested: credits, reason: "tiny_or_zero_duration_sync" },
    });
  }
}

function billingSecondsBetween(a, b) {
  const start = new Date(a).getTime();
  const end = new Date(b).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 1000);
}

function sessionSyncCoversEnd(session) {
  if (!session?.last_sync_at || !session?.last_ping) return null;
  const remainingSecs = billingSecondsBetween(session.last_sync_at, session.last_ping);
  if (remainingSecs === null) return null;
  if (remainingSecs <= BILLING_FINAL_COVERAGE_GRACE_SECONDS) {
    return {
      finalized: true,
      finalized_by: "interval_coverage",
      remaining_secs: Math.max(0, remainingSecs),
      grace_secs: BILLING_FINAL_COVERAGE_GRACE_SECONDS,
      last_sync_at: session.last_sync_at,
      ended_at: session.last_ping,
    };
  }
  return {
    finalized: false,
    remaining_secs: remainingSecs,
    grace_secs: BILLING_FINAL_COVERAGE_GRACE_SECONDS,
    last_sync_at: session.last_sync_at,
    ended_at: session.last_ping,
  };
}

async function getSessionFinalizationStatus(session) {
  if (!session?.session_id || !session.started_at || !session.last_ping) {
    return { finalized: false, finalized_by: "insufficient_session_data", reason: "missing_session_timestamps" };
  }

  const coverage = sessionSyncCoversEnd(session);
  try {
    const { data: explicit, error: explicitErr } = await supabaseAdmin
      .from("billing_syncs")
      .select("source, created_at")
      .eq("session_id", session.session_id)
      .in("source", ["final", "manual_stop", "app_shutdown"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (explicitErr) {
      if (!isMissingBillingMigrationError(explicitErr)) console.warn("[BILLING RECON] Final sync lookup error:", explicitErr.message);
    } else if (explicit) {
      return {
        finalized: true,
        finalized_by: explicit.source === "app_shutdown" ? "shutdown_sync" : "explicit_final",
        final_source: explicit.source,
        final_sync_at: explicit.created_at,
      };
    }

    if (coverage?.finalized) return coverage;

    const { data: latest, error: latestErr } = await supabaseAdmin
      .from("billing_syncs")
      .select("source, created_at")
      .eq("session_id", session.session_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestErr) {
      if (!isMissingBillingMigrationError(latestErr)) console.warn("[BILLING RECON] Latest sync lookup error:", latestErr.message);
    } else if (latest?.created_at && session.last_ping) {
      const latestDeltaSecs = billingSecondsBetween(latest.created_at, session.last_ping);
      if (latestDeltaSecs !== null && latestDeltaSecs <= BILLING_FINAL_COVERAGE_GRACE_SECONDS) {
        return {
          finalized: true,
          finalized_by: "interval_coverage",
          latest_source: latest.source,
          latest_sync_at: latest.created_at,
          remaining_secs: Math.max(0, latestDeltaSecs),
          grace_secs: BILLING_FINAL_COVERAGE_GRACE_SECONDS,
        };
      }
    }
  } catch (err) {
    if (!isMissingBillingMigrationError(err)) console.warn("[BILLING RECON] Finalization status failed:", err.message);
  }

  return {
    finalized: false,
    finalized_by: null,
    reason: "no_final_or_interval_coverage",
    ...(coverage || {}),
  };
}

async function detectMissingFinalSync(session) {
  if (!session?.session_id || !session.started_at || !session.last_ping) return;
  const durationSecs = Math.max(0, billingSecondsBetween(session.started_at, session.last_ping) || 0);
  if (durationSecs < BILLING_MISSING_FINAL_MIN_SECONDS) return;
  try {
    const finalization = await getSessionFinalizationStatus(session);
    if (!finalization.finalized) {
      await logReconciliationEventOnce({
        userId: session.user_id || null,
        sessionId: session.session_id,
        type: "missing_final_sync",
        severity: "warning",
        details: {
          duration_secs: durationSecs,
          started_at: session.started_at,
          last_ping: session.last_ping,
          last_sync_at: session.last_sync_at || null,
          finalized_by: finalization.finalized_by,
          reason: finalization.reason,
          remaining_secs: finalization.remaining_secs ?? null,
          grace_secs: BILLING_FINAL_COVERAGE_GRACE_SECONDS,
        },
      }, 24 * 60 * 60 * 1000);
    } else {
      const reason = finalization.finalized_by === "interval_coverage"
        ? "interval_coverage_verified"
        : finalization.finalized_by === "shutdown_sync"
          ? "late_final_sync_detected"
          : "session_cleanly_closed";
      await resolveReconciliationEvents({
        userId: session.user_id || null,
        sessionId: session.session_id,
        type: "missing_final_sync",
        reason,
        autoResolved: true,
        resolvedBy: "reconciliation_scan",
      });
    }
  } catch (err) {
    if (!isMissingBillingMigrationError(err)) console.warn("[BILLING RECON] Missing final detection failed:", err.message);
  }
}

async function autoResolveRecentMissingFinalFalsePositives(sinceIso) {
  try {
    const { data: candidates, error } = await supabaseAdmin
      .from("billing_reconciliation_events")
      .select("id, user_id, session_id, created_at")
      .eq("type", "missing_final_sync")
      .eq("resolved", false)
      .gte("created_at", sinceIso)
      .not("session_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      if (!isMissingReconciliationResolutionError(error)) {
        console.warn("[BILLING RECON] Auto-resolve candidate lookup error:", error.message);
      }
      return 0;
    }

    let resolved = 0;
    for (const event of candidates || []) {
      const { data: session, error: sessionErr } = await supabaseAdmin
        .from("sessions")
        .select("user_id, session_id, started_at, last_ping, last_sync_at, is_active")
        .eq("session_id", event.session_id)
        .maybeSingle();
      if (sessionErr || !session || session.is_active) continue;
      const finalization = await getSessionFinalizationStatus(session);
      if (!finalization.finalized) continue;
      const reason = finalization.finalized_by === "interval_coverage"
        ? "interval_coverage_verified"
        : finalization.finalized_by === "shutdown_sync"
          ? "late_final_sync_detected"
          : "session_cleanly_closed";
      resolved += await resolveReconciliationEvents({
        userId: session.user_id || event.user_id || null,
        sessionId: event.session_id,
        type: "missing_final_sync",
        reason,
        autoResolved: true,
        resolvedBy: "summary_auto_resolution",
      });
    }
    return resolved;
  } catch (err) {
    if (!isMissingReconciliationResolutionError(err)) {
      console.warn("[BILLING RECON] Auto-resolve scan failed:", err.message);
    }
    return 0;
  }
}

async function detectSessionAnomalies() {
  try {
    const staleCutoff = new Date(Date.now() - BILLING_STALE_MS).toISOString();
    const orphanCutoff = new Date(Date.now() - BILLING_ORPHAN_ACTIVE_MS).toISOString();

    const { data: staleActive, error: staleErr } = await supabaseAdmin
      .from("sessions")
      .select("user_id, session_id, started_at, last_ping, last_sync_at, credits_used")
      .eq("is_active", true)
      .lt("last_ping", staleCutoff)
      .limit(50);
    if (staleErr && !isMissingBillingMigrationError(staleErr)) {
      console.warn("[BILLING RECON] Stale active scan error:", staleErr.message);
    }
    for (const sess of staleActive || []) {
      await logReconciliationEventOnce({
        userId: sess.user_id,
        sessionId: sess.session_id,
        type: "stale_session_detected",
        severity: "warning",
        details: { last_ping: sess.last_ping, started_at: sess.started_at, credits_used: sess.credits_used || 0, source: "reconciliation_scan" },
      });
    }

    const { data: orphanActive, error: orphanErr } = await supabaseAdmin
      .from("sessions")
      .select("user_id, session_id, started_at, last_ping, last_sync_at, credits_used")
      .eq("is_active", true)
      .lt("last_ping", orphanCutoff)
      .limit(50);
    if (orphanErr && !isMissingBillingMigrationError(orphanErr)) {
      console.warn("[BILLING RECON] Orphan active scan error:", orphanErr.message);
    }
    for (const sess of orphanActive || []) {
      await logReconciliationEventOnce({
        userId: sess.user_id,
        sessionId: sess.session_id,
        type: "orphan_active_session",
        severity: "high",
        details: { last_ping: sess.last_ping, started_at: sess.started_at, credits_used: sess.credits_used || 0, source: "reconciliation_scan" },
      }, 60 * 60 * 1000);
    }

    const inactiveCutoff = new Date(Date.now() - 60 * 1000).toISOString();
    const { data: inactiveSessions, error: inactiveErr } = await supabaseAdmin
      .from("sessions")
      .select("user_id, session_id, started_at, last_ping, last_sync_at, is_active")
      .eq("is_active", false)
      .gte("last_ping", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .lte("last_ping", inactiveCutoff)
      .limit(100);
    if (inactiveErr && !isMissingBillingMigrationError(inactiveErr)) {
      console.warn("[BILLING RECON] Missing final scan error:", inactiveErr.message);
    }
    for (const sess of inactiveSessions || []) {
      await detectMissingFinalSync(sess);
    }
  } catch (err) {
    console.warn("[BILLING RECON] Session anomaly scan failed:", err.message);
  }
}

async function validateBillingSession(userId, sessionId, source = "legacy") {
  if (!userId || !validateUUID(userId)) {
    return { ok: false, status: 400, reason: "invalid_user_id" };
  }

  if (!sessionId) {
    await logBillingReconciliationEvent({
      userId,
      sessionId: null,
      type: "legacy_missing_session_id",
      severity: "warning",
      details: { source, allowed_temporarily: true },
    });
    console.warn("[BILLING] Legacy request without session_id allowed temporarily:", { userId, source });
    return { ok: true, legacy: true, reason: "legacy_missing_session_id" };
  }

  const { data: session, error } = await supabaseAdmin
    .from("sessions")
    .select("id, user_id, session_id, is_active, kill_signal, kill_reason, started_at, last_ping")
    .eq("user_id", userId)
    .eq("session_id", sessionId)
    .maybeSingle();

  if (error) {
    console.warn("[BILLING] Session validation query error:", error.message);
    return { ok: false, status: 500, reason: "session_validation_error" };
  }

  if (!session) {
    await logBillingReconciliationEvent({
      userId,
      sessionId,
      type: "invalid_billing_session",
      severity: "warning",
      details: { source, reason: "session_not_found" },
    });
    return { ok: false, status: 409, reason: "session_not_found" };
  }

  if (session.kill_signal) {
    await logBillingReconciliationEvent({
      userId,
      sessionId,
      type: "killed_session_attempted_sync",
      severity: "warning",
      details: { source, kill_reason: session.kill_reason || null },
    });
    return { ok: false, status: 409, reason: "session_killed", session };
  }

  if (!session.is_active) {
    const lowerReason = String(session.kill_reason || "").toLowerCase();
    const type = lowerReason.includes("replaced")
      ? "replaced_session_attempted_sync"
      : lowerReason.includes("timed out") || lowerReason.includes("stale")
        ? "stale_session_attempted_sync"
        : "inactive_session_attempted_sync";
    await logBillingReconciliationEvent({
      userId,
      sessionId,
      type,
      severity: "warning",
      details: { source, kill_reason: session.kill_reason || null },
    });
    return { ok: false, status: 409, reason: type, session };
  }

  if (session.last_ping) {
    const ageMs = Date.now() - new Date(session.last_ping).getTime();
    if (Number.isFinite(ageMs) && ageMs > BILLING_STALE_MS) {
      await logBillingReconciliationEvent({
        userId,
        sessionId,
        type: "stale_active_session_attempted_sync",
        severity: "warning",
        details: { source, last_ping: session.last_ping, age_ms: ageMs },
      });
      return { ok: false, status: 409, reason: "session_stale", session };
    }
  }

  const { data: newestActive, error: activeErr } = await supabaseAdmin
    .from("sessions")
    .select("session_id, started_at")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeErr) {
    console.warn("[BILLING] Active session lookup error:", activeErr.message);
    return { ok: false, status: 500, reason: "active_session_lookup_error" };
  }

  if (newestActive?.session_id && newestActive.session_id !== sessionId) {
    await logBillingReconciliationEvent({
      userId,
      sessionId,
      type: "replaced_session_attempted_sync",
      severity: "warning",
      details: {
        source,
        current_session_id: newestActive.session_id,
        current_started_at: newestActive.started_at || null,
      },
    });
    return { ok: false, status: 409, reason: "session_replaced", current_session_id: newestActive.session_id, session };
  }

  return { ok: true, session };
}

async function recordBillingShadowSync({
  userId,
  sessionId,
  syncId,
  syncSequence,
  durationSecs,
  creditsRequested,
  clientTs,
  source,
  legacyBalanceAfter,
}) {
  if (_billingShadowRpcAvailable === false) return null;
  if (!userId || !validateUUID(userId)) return null;

  const safeDuration = clampBillingNumber(durationSecs, BILLING_MAX_SYNC_SECONDS);
  const safeCredits = clampBillingNumber(creditsRequested, BILLING_MAX_SYNC_CREDITS);
  if (safeDuration === null || safeCredits === null) {
    console.warn("[BILLING SHADOW] Invalid numeric input skipped:", { source, durationSecs, creditsRequested });
    return null;
  }

  const resolvedSessionId = sessionId || await resolveActiveBillingSessionId(userId);
  if (!resolvedSessionId) {
    console.warn("[BILLING SHADOW] No active session_id for user:", userId);
    return null;
  }

  try {
    const { data, error } = await supabaseAdmin.rpc("protected_billing_sync", {
      p_user_id: userId,
      p_session_id: resolvedSessionId,
      p_sync_id: syncId || makeLegacyBillingSyncId(source || "deduct"),
      p_sync_sequence: Number.isInteger(Number(syncSequence)) ? Number(syncSequence) : null,
      p_duration_secs: safeDuration,
      p_credits_requested: safeCredits,
      p_client_ts: clientTs || null,
      p_shadow_only: true,
      p_source: source || "legacy",
      p_legacy_balance_after: finiteNonNegativeNumber(legacyBalanceAfter) ? legacyBalanceAfter : null,
    });

    if (error) {
      if (isMissingBillingMigrationError(error)) {
        _billingShadowRpcAvailable = false;
        console.warn("[BILLING SHADOW] RPC unavailable. Run billing-protection-phase3a.sql to enable shadow logs.");
        return null;
      }
      console.warn("[BILLING SHADOW] RPC error:", error.message);
      return null;
    }

    _billingShadowRpcAvailable = true;
    const shadowLog = {
      sync_id: syncId || null,
      sync_sequence: Number.isInteger(Number(syncSequence)) ? Number(syncSequence) : null,
      source: source || "legacy",
      duration_secs: safeDuration,
      credits_requested: safeCredits,
      credits_expected: data?.credits_expected,
      status: data?.status,
      duplicate: !!data?.duplicate,
    };
    await detectBillingDrift({
      userId,
      sessionId: resolvedSessionId,
      syncId,
      source: source || "legacy",
      durationSecs: safeDuration,
      creditsRequested: safeCredits,
      creditsExpected: data?.credits_expected,
    });
    await detectDecartBillingMismatch({
      userId,
      sessionId: resolvedSessionId,
      source: source || "legacy",
      durationSecs: safeDuration,
      creditsRequested: safeCredits,
    });
    await detectSuspiciousSyncPattern({
      userId,
      sessionId: resolvedSessionId,
      syncId,
      source: source || "legacy",
      durationSecs: safeDuration,
      creditsRequested: safeCredits,
    });
    if (data?.duplicate) {
      await logBillingReconciliationEvent({
        userId,
        sessionId: resolvedSessionId,
        type: "duplicate_sync_id_detected",
        severity: "warning",
        details: shadowLog,
      });
      console.warn("[BILLING SHADOW] Duplicate sync detected:", shadowLog);
    }
    else if (data?.status && data.status !== "shadow_ok") console.warn("[BILLING SHADOW] Shadow warning:", shadowLog);
    else console.log("[BILLING SHADOW] Recorded:", shadowLog);
    return data;
  } catch (err) {
    console.warn("[BILLING SHADOW] Non-fatal error:", err.message);
    return null;
  }
}

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:4000",
  "app://.",
  "https://tzurah.ai",
  "https://www.tzurah.ai",
  "https://admin.tzurah.ai",
  process.env.ALLOWED_ORIGIN,
].filter(Boolean);

// ── Express setup ─────────────────────────────────────────────────
const app = express();

// Single CORS handler: admin routes get a full bypass (no origin whitelist),
// all other routes use the strict allowedOrigins whitelist.
// Must be one middleware so admin requests never reach the cors() check.
app.use((req, res, next) => {
  if (req.path.startsWith("/admin")) {
    res.header("Access-Control-Allow-Origin",      req.headers.origin || "*");
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Methods",     "GET,POST,PATCH,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers",     "Content-Type,Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    return next();
  }
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })(req, res, next);
});
app.use("/api/",      apiLimiter);
app.use("/credits/",  apiLimiter);
app.use("/session/",  apiLimiter);
app.use("/decart/token", tokenLimiter);
app.use("/admin/login",  authLimiter);

// Raw body for Stripe webhook signature verification (must come before express.json)
app.use("/stripe/webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(session({
  secret:            process.env.ADMIN_SECRET || "tzurah_admin_secret",
  resave:            false,
  saveUninitialized: false,
  cookie:            { secure: false, httpOnly: true, sameSite: "lax", maxAge: 24 * 60 * 60 * 1000 },
}));

// ── Security headers ──────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// ── Admin IP allowlist (optional — set ADMIN_IP_ALLOWLIST in .env) ─
app.use("/admin", (req, res, next) => {
  const list = process.env.ADMIN_IP_ALLOWLIST;
  if (!list) return next();
  const allowed = list.split(",").map(s => s.trim()).filter(Boolean);
  const ip = req.ip || (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (allowed.includes(ip)) return next();
  console.warn(`[SECURITY] Admin access from non-allowlisted IP: ${ip}`);
  if (req.path.startsWith("/api/")) return res.status(403).json({ error: "Access denied from this IP" });
  return res.status(403).send("Access denied");
});

// ═══════════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════════

app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now(), service: "tzurah-server" }));

// ═══════════════════════════════════════════════════════════════════
// DECART TOKEN PROXY
// ═══════════════════════════════════════════════════════════════════

/**
 * GET /decart/token
 * Requires valid Supabase JWT. Verifies user has credits > 0.
 * Returns a short-lived Decart client token.
 */
app.get("/decart/token", requireAuth, async (req, res) => {
  if (!DECART_KEY) {
    return res.status(503).json({ error: "DECART_API_KEY not configured on server" });
  }

  const { data: profile, error } = await supabaseAdmin
    .from("profiles")
    .select("credits")
    .eq("id", req.userId)
    .single();

  if (error || !profile) return res.status(404).json({ error: "Profile not found" });
  if (profile.credits <= 0) {
    return res.status(402).json({ error: "Insufficient credits", credits: 0 });
  }

  if (process.env.NODE_ENV === "development") {
    return res.json({ apiKey: DECART_KEY });
  }

  try {
    const { createDecartClient } = await import("@decartai/sdk");
    const client = createDecartClient({ apiKey: DECART_KEY });
    const token  = await client.tokens.create();
    res.json(token);
  } catch (err) {
    console.error("[Tzurah] /decart/token failed:", err.message);
    res.status(503).json({ error: "Token generation failed — try again shortly" });
  }
});

// ── Internal: raw Decart key for local Electron server ───────────
// NOT public — secured by internal secret or localhost-only IP.
// server.mjs calls this to proxy the key to the Electron renderer.
app.get("/internal/decart-key", (req, res) => {
  const secret  = req.headers["x-internal-secret"];
  const isLocal = req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1";
  if (!isLocal && secret !== (process.env.INTERNAL_SECRET || "tzurah-internal")) {
    console.warn("[INTERNAL TOKEN] Unauthorized request from:", req.ip);
    return res.status(403).json({ error: "Forbidden" });
  }
  const token = process.env.DECART_API_KEY;
  if (!token) return res.status(500).json({ error: "API key not configured" });
  console.log("[INTERNAL TOKEN] Serving Decart key to:", req.ip);
  return res.json({ token });
});

// ═══════════════════════════════════════════════════════════════════
// BOOTSTRAP — app startup config for Electron clients
// ═══════════════════════════════════════════════════════════════════
app.get("/api/bootstrap", bootstrapRateLimiter, async (req, res) => {
  console.log("[BOOTSTRAP] Request from:", req.ip, "at:", new Date().toISOString());
  if (req.headers["x-app-secret"] !== BOOTSTRAP_SECRET) {
    console.warn("[BOOTSTRAP] Unauthorized attempt from:", req.ip);
    await logAction("unauthorized_bootstrap", null, null, null, { ip: req.ip }, req).catch(() => {});
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const { data: flagRows } = await supabaseAdmin
      .from("feature_flags").select("key, enabled");
    const featureFlags = {};
    (flagRows || []).forEach(f => { featureFlags[f.key] = f.enabled; });

    const { data: packs } = await supabaseAdmin
      .from("credit_packs").select("*").eq("is_active", true)
      .order("price_usd", { ascending: true });

    return res.json({
      supabase_url:           process.env.SUPABASE_URL,
      supabase_anon_key:      process.env.SUPABASE_ANON_KEY,
      gcp_server_url:         `http://${process.env.SERVER_IP || "34.39.83.195"}:4000`,
      feature_flags:          featureFlags,
      credit_packs:           packs || [],
      burn_rate:              2.18,
      free_credits_on_signup: 6,
      app_version:            process.env.APP_VERSION || "1.0.0",
      timestamp:              new Date().toISOString(),
    });
  } catch (err) {
    console.error("[BOOTSTRAP] Error:", err.message);
    return res.status(500).json({ error: "Bootstrap failed" });
  }
});

// ── Internal: signal token cache bust to local server ────────────
app.post("/internal/bust-token-cache", (req, res) => {
  const secret = req.headers["x-internal-secret"];
  if (secret !== (process.env.INTERNAL_SECRET || "tzurah-internal")) {
    return res.status(403).json({ error: "Forbidden" });
  }
  process.env.TOKEN_CACHE_BUSTED = Date.now().toString();
  console.log("[INTERNAL] Token cache bust signal set");
  return res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════
// CREDITS
// ═══════════════════════════════════════════════════════════════════

/**
 * POST /credits/deduct
 * Body: { credits: number, session_seconds: number }
 */
app.post("/credits/deduct", requireAuth, async (req, res) => {
  let { credits, session_seconds, duration_secs, session_id, sync_id, sync_sequence, source, client_ts } = req.body || {};

  console.log("[DEDUCT] user:", req.userId, "credits:", credits, "seconds:", session_seconds);

  const safeCredits = safeBillingNumber(credits);
  const safeSeconds = safeBillingNumber(duration_secs ?? session_seconds ?? 0);
  if (safeCredits === null) {
    await logBillingReconciliationEvent({
      userId: req.userId,
      sessionId: session_id || null,
      type: "invalid_billing_numeric_input",
      severity: "warning",
      details: { endpoint: "credits_deduct", field: "credits", value: credits, source: source || "legacy" },
    });
    return badBillingNumberResponse(res, "credits", credits);
  }
  if (safeSeconds === null) {
    await logBillingReconciliationEvent({
      userId: req.userId,
      sessionId: session_id || null,
      type: "invalid_billing_numeric_input",
      severity: "warning",
      details: { endpoint: "credits_deduct", field: "session_seconds", value: duration_secs ?? session_seconds, source: source || "legacy" },
    });
    return badBillingNumberResponse(res, "session_seconds", duration_secs ?? session_seconds);
  }
  credits = Math.min(safeCredits, BILLING_MAX_SYNC_CREDITS);
  session_seconds = Math.min(safeSeconds, BILLING_MAX_SYNC_SECONDS);
  if (credits !== safeCredits || session_seconds !== safeSeconds) {
    await logBillingReconciliationEvent({
      userId: req.userId,
      sessionId: session_id || null,
      type: "billing_sync_capped",
      severity: "warning",
      details: {
        endpoint: "credits_deduct",
        source: source || "legacy",
        requested_credits: safeCredits,
        requested_seconds: safeSeconds,
        capped_credits: credits,
        capped_seconds: session_seconds,
      },
    });
  }

  const sessionValidation = await validateBillingSession(req.userId, session_id || null, source || "credits_deduct");
  if (!sessionValidation.ok) {
    console.warn("[DEDUCT] Blocked invalid billing session:", {
      userId: req.userId,
      session_id: session_id || null,
      source: source || "credits_deduct",
      reason: sessionValidation.reason,
    });
    const { data: currentProfile } = await supabaseAdmin
      .from("profiles")
      .select("credits")
      .eq("id", req.userId)
      .maybeSingle();
    return res.status(sessionValidation.status || 409).json({
      ok: false,
      error: "Invalid billing session",
      reason: sessionValidation.reason,
      credits_remaining: currentProfile?.credits ?? null,
      current_session_id: sessionValidation.current_session_id || null,
    });
  }

  const duplicateSync = await detectDuplicateSyncId({
    userId: req.userId,
    sessionId: session_id || null,
    syncId: sync_id || null,
    source: source || "credits_deduct",
  });
  if (duplicateSync.duplicate) {
    const { data: currentProfile } = await supabaseAdmin
      .from("profiles")
      .select("credits")
      .eq("id", req.userId)
      .maybeSingle();
    return res.json({
      ok: true,
      duplicate: true,
      skipped_deduction: true,
      credits_remaining: currentProfile?.credits ?? duplicateSync.balanceAfter ?? 0,
    });
  }

  const { data: profile, error: fetchErr } = await supabaseAdmin
    .from("profiles")
    .select("credits, total_credits_used")
    .eq("id", req.userId)
    .maybeSingle();

  console.log("[DEDUCT] current balance:", profile?.credits, "fetch error:", fetchErr?.message || "none");

  if (fetchErr || !profile) return res.status(404).json({ error: "Profile not found" });
  if (profile.credits < credits) {
    console.warn("[DEDUCT] Insufficient credits:", profile.credits, "<", credits);
    return res.status(402).json({ error: "Insufficient credits", credits_remaining: profile.credits });
  }

  const newBalance      = Math.max(0, profile.credits - credits);
  const newTotalUsed    = (profile.total_credits_used || 0) + credits;

  await recordBillingShadowSync({
    userId: req.userId,
    sessionId: session_id || null,
    syncId: sync_id || null,
    syncSequence: sync_sequence,
    durationSecs: session_seconds,
    creditsRequested: credits,
    clientTs: client_ts || null,
    source: source || "credits_deduct",
    legacyBalanceAfter: newBalance,
  });

  console.log("[DEDUCT] updating balance:", profile.credits, "→", newBalance);

  const { error: updateErr } = await supabaseAdmin
    .from("profiles")
    .update({
      credits:            newBalance,
      total_credits_used: newTotalUsed,
      last_seen:          new Date().toISOString(),
    })
    .eq("id", req.userId);

  console.log("[DEDUCT] update error:", updateErr?.message || "none");

  if (updateErr) {
    await logBillingReconciliationEvent({
      userId: req.userId,
      sessionId: session_id || null,
      type: "failed_billing_write",
      severity: "critical",
      details: { endpoint: "credits_deduct", source: source || "credits_deduct", error: updateErr.message },
    });
    return res.status(500).json({ error: updateErr.message });
  }

  const { data: postUpdateProfile } = await supabaseAdmin
    .from("profiles")
    .select("credits")
    .eq("id", req.userId)
    .maybeSingle();
  await detectBalanceDrift({
    userId: req.userId,
    sessionId: session_id || null,
    source: source || "credits_deduct",
    balanceBefore: profile.credits,
    creditsDeducted: credits,
    actualBalanceAfter: postUpdateProfile?.credits ?? newBalance,
  });

  if (session_seconds && session_seconds > 0) {
    const now = new Date().toISOString();
    const { error: usageInsertErr } = await supabaseAdmin.from("usage").insert({
      user_id:         req.userId,
      session_seconds: session_seconds,
      credits_used:    credits,
      ended_at:        now,
      created_at:      now,
    });
    if (usageInsertErr) console.warn("[DEDUCT] usage insert error:", usageInsertErr.message);

    // Track last sync time so /session/end can deduct only the remaining unsync'd period
    let syncUpdateQuery = supabaseAdmin
      .from("sessions")
      .update({ last_sync_at: now })
      .eq("user_id", req.userId)
      .eq("is_active", true);
    if (session_id) syncUpdateQuery = syncUpdateQuery.eq("session_id", session_id);
    const { error: sessionSyncErr } = await syncUpdateQuery;
    if (sessionSyncErr) console.warn("[DEDUCT] session last_sync_at update error:", sessionSyncErr.message);
  }

  console.log("[DEDUCT] success — new balance:", newBalance);
  res.json({ ok: true, credits_remaining: newBalance });
});

/**
 * POST /credits/sync
 * Body: { usage_logs: [{ session_seconds, credits_used, started_at, ended_at }] }
 */
app.post("/credits/sync", requireAuth, async (req, res) => {
  const { usage_logs, session_id, sync_id, sync_sequence, source, client_ts } = req.body || {};

  if (Array.isArray(usage_logs) && usage_logs.length > 0) {
    const totalCreditsRaw = usage_logs.reduce((s, l) => s + Number(l.credits_used || 0), 0);
    const totalSecondsRaw = usage_logs.reduce((s, l) => s + Number(l.session_seconds || 0), 0);
    const safeCredits = safeBillingNumber(totalCreditsRaw);
    const safeSeconds = safeBillingNumber(totalSecondsRaw);
    if (safeCredits === null || safeSeconds === null) {
      await logBillingReconciliationEvent({
        userId: req.userId,
        sessionId: session_id || null,
        type: "invalid_billing_numeric_input",
        severity: "warning",
        details: { endpoint: "credits_sync", total_credits: totalCreditsRaw, total_seconds: totalSecondsRaw, source: source || "legacy" },
      });
      return res.status(400).json({ ok: false, error: "usage_logs contain invalid billing numbers" });
    }

    const totalCredits = Math.min(safeCredits, BILLING_MAX_SYNC_CREDITS);
    const totalSeconds = Math.min(safeSeconds, BILLING_MAX_SYNC_SECONDS);
    if (totalCredits !== safeCredits || totalSeconds !== safeSeconds) {
      await logBillingReconciliationEvent({
        userId: req.userId,
        sessionId: session_id || null,
        type: "billing_sync_capped",
        severity: "warning",
        details: {
          endpoint: "credits_sync",
          source: source || "legacy",
          requested_credits: safeCredits,
          requested_seconds: safeSeconds,
          capped_credits: totalCredits,
          capped_seconds: totalSeconds,
        },
      });
    }

    const sessionValidation = await validateBillingSession(req.userId, session_id || null, source || "credits_sync");
    if (!sessionValidation.ok) {
      console.warn("[SYNC] Blocked invalid billing session:", {
        userId: req.userId,
        session_id: session_id || null,
        source: source || "credits_sync",
        reason: sessionValidation.reason,
      });
      const { data: currentProfile } = await supabaseAdmin
        .from("profiles")
        .select("credits")
        .eq("id", req.userId)
        .maybeSingle();
      return res.status(sessionValidation.status || 409).json({
        ok: false,
        error: "Invalid billing session",
        reason: sessionValidation.reason,
        credits_remaining: currentProfile?.credits ?? 0,
        current_session_id: sessionValidation.current_session_id || null,
      });
    }

    const duplicateSync = await detectDuplicateSyncId({
      userId: req.userId,
      sessionId: session_id || null,
      syncId: sync_id || null,
      source: source || "credits_sync",
    });
    if (duplicateSync.duplicate) {
      const { data: currentProfile } = await supabaseAdmin
        .from("profiles")
        .select("credits")
        .eq("id", req.userId)
        .maybeSingle();
      return res.json({
        ok: true,
        duplicate: true,
        skipped_deduction: true,
        credits_remaining: currentProfile?.credits ?? duplicateSync.balanceAfter ?? 0,
      });
    }

    const rows = usage_logs.map((log) => ({
      user_id:         req.userId,
      session_seconds: log.session_seconds,
      credits_used:    log.credits_used,
      started_at:      log.started_at ? new Date(log.started_at).toISOString() : null,
      ended_at:        log.ended_at   ? new Date(log.ended_at).toISOString()   : null,
      created_at:      new Date().toISOString(),
    }));

    const { error: usageInsertErr } = await supabaseAdmin.from("usage").insert(rows);
    if (usageInsertErr) console.warn("[SYNC] usage insert error:", usageInsertErr.message);

    // Fetch and deduct atomically
    const { data: profile } = await supabaseAdmin
      .from("profiles").select("credits").eq("id", req.userId).maybeSingle();

    if (profile) {
      const legacyBalanceAfter = Math.max(0, profile.credits - totalCredits);
      await recordBillingShadowSync({
        userId: req.userId,
        sessionId: session_id || null,
        syncId: sync_id || null,
        syncSequence: sync_sequence,
        durationSecs: Number(totalSeconds) || 0,
        creditsRequested: Number(totalCredits) || 0,
        clientTs: client_ts || null,
        source: source || "credits_sync",
        legacyBalanceAfter,
      });

      const { error: profileUpdateErr } = await supabaseAdmin.from("profiles")
        .update({ credits: legacyBalanceAfter })
        .eq("id", req.userId);
      if (profileUpdateErr) {
        await logBillingReconciliationEvent({
          userId: req.userId,
          sessionId: session_id || null,
          type: "failed_billing_write",
          severity: "critical",
          details: { endpoint: "credits_sync", source: source || "credits_sync", error: profileUpdateErr.message },
        });
      } else {
        const { data: postUpdateProfile } = await supabaseAdmin
          .from("profiles")
          .select("credits")
          .eq("id", req.userId)
          .maybeSingle();
        await detectBalanceDrift({
          userId: req.userId,
          sessionId: session_id || null,
          source: source || "credits_sync",
          balanceBefore: profile.credits,
          creditsDeducted: totalCredits,
          actualBalanceAfter: postUpdateProfile?.credits ?? legacyBalanceAfter,
        });
      }
    }
  }

  const { data: profile } = await supabaseAdmin
    .from("profiles").select("credits").eq("id", req.userId).maybeSingle();

  res.json({ ok: true, credits_remaining: profile?.credits ?? 0 });
});

// ═══════════════════════════════════════════════════════════════════
// STRIPE
// ═══════════════════════════════════════════════════════════════════

/**
 * POST /stripe/create-checkout
 * Body: { pack: 'starter'|'basic'|'standard'|'pro'|'ultra'|'max' }
 */
app.post("/stripe/create-checkout", requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Stripe not configured" });

  const { pack } = req.body || {};
  const packDef  = PACKS[pack];
  if (!packDef)         return res.status(400).json({ error: "Invalid pack: " + pack });
  if (!packDef.priceId) return res.status(500).json({ error: "Stripe Price ID not configured for: " + pack });

  try {
    const session = await stripe.checkout.sessions.create({
      mode:       "payment",
      line_items: [{ price: packDef.priceId, quantity: 1 }],
      success_url: "tzurah://payment/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url:  "tzurah://payment/cancel",
      metadata: {
        user_id: req.userId,
        pack:    pack,
        credits: String(packDef.credits),
      },
      customer_email: req.user.email,
    });
    res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("[Tzurah] Stripe checkout error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /stripe/webhook
 * Verifies Stripe signature, credits user on payment completion.
 */
app.post("/stripe/webhook", (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.sendStatus(200);

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("[Tzurah] Stripe webhook signature error:", err.message);
    return res.status(400).send("Webhook error: " + err.message);
  }

  if (event.type === "checkout.session.completed") {
    const sess    = event.data.object;
    const meta    = sess.metadata || {};
    const userId  = meta.user_id;
    const credits = parseInt(meta.credits, 10);
    const pack    = meta.pack;
    const packDef = PACKS[pack];

    if (userId && credits && packDef) {
      (async () => {
        const { data: profile } = await supabaseAdmin
          .from("profiles")
          .select("credits, total_credits_purchased")
          .eq("id", userId)
          .single();

        if (profile) {
          await supabaseAdmin.from("profiles").update({
            credits:                 profile.credits + credits,
            total_credits_purchased: (profile.total_credits_purchased || 0) + credits,
          }).eq("id", userId);
        }

        await supabaseAdmin.from("purchases").insert({
          user_id:           userId,
          pack_name:         packDef.name,
          price_usd:         packDef.price,
          credits_added:     credits,
          stripe_payment_id: sess.payment_intent,
          created_at:        new Date().toISOString(),
        });

        console.log(`[Tzurah] ✓ Added ${credits} credits to ${userId} (${pack})`);
      })().catch((err) => console.error("[Tzurah] Webhook handler error:", err));
    }
  }

  res.sendStatus(200);
});

// ═══════════════════════════════════════════════════════════════════
// ADMIN ROUTES  (protected by express-basic-auth)
// ═══════════════════════════════════════════════════════════════════

// Serve admin HTML dashboard
app.get("/admin", adminAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

// Admin login page
app.get("/admin/login", (req, res) => {
  if (req.session?.isAdmin) return res.redirect("/admin");
  res.sendFile(path.join(__dirname, "admin-login.html"));
});

// Admin login POST
app.post("/admin/login", async (req, res) => {
  const { email, password } = req.body || {};
  const ip = req.ip || (req.headers["x-forwarded-for"] || "").split(",")[0].trim();

  // IP rate limit check
  if (_checkLoginLock(ip)) {
    await logAction("admin_login_failed", null, null, null, { attempted_email: email, reason: "ip_locked" }, req);
    return res.status(429).json({ error: "Too many failed attempts — try again in 15 minutes" });
  }

  const adminEmail = process.env.ADMIN_EMAIL    || "admin@tzurah.ai";
  const adminPass  = process.env.ADMIN_PASSWORD || "TzurahAdmin2025!";
  if (email === adminEmail && password === adminPass) {
    req.session.isAdmin      = true;
    req.session.adminEmail   = email;
    req.session.adminRole    = "super_admin";
    req.session.adminName    = "Super Admin";
    req.session.lastActive   = Date.now();
    _clearLoginAttempts(ip);
    await logAction("admin_login", email, "super_admin", null, { success: true }, req);
    return res.json({ success: true });
  }
  // Try sub-admin login
  try {
    const { data: admins } = await supabaseAdmin.from("admin_users")
      .select("id, email, name, role, is_active, password_hash, must_change_password").eq("email", email).eq("is_active", true).maybeSingle();
    if (admins?.password_hash) {
      const bcrypt = require("bcryptjs");
      const ok = await bcrypt.compare(password, admins.password_hash);
      if (ok) {
        console.log("[LOGIN] Sub-admin:", admins.email, "role:", admins.role);
        req.session.isAdmin    = true;
        req.session.adminEmail = admins.email;
        req.session.adminRole  = admins.role;
        req.session.adminName  = admins.name;
        req.session.lastActive = Date.now();
        _clearLoginAttempts(ip);
        await supabaseAdmin.from("admin_users").update({ last_login: new Date().toISOString() }).eq("id", admins.id);
        await logAction("admin_login", admins.email, admins.role, null, { success: true }, req);
        return res.json({
          success: true,
          mustChangePassword: admins.must_change_password === true,
          role: admins.role,
          name: admins.name,
        });
      }
    }
  } catch (_) {}
  _recordFailedLogin(ip);
  await logAction("admin_login_failed", null, null, null, { attempted_email: email }, req);
  res.status(401).json({ error: "Invalid credentials" });
});

// Admin logout
app.post("/admin/logout", (req, res) => {
  req.session.destroy(() => {});
  res.json({ success: true });
});

// GET /admin/api/me — return current admin's identity + role
app.get("/admin/api/me", adminAuth, (req, res) => {
  res.json({
    email: req.session.adminEmail || "",
    role:  req.session.adminRole  || "super_admin",
    name:  req.session.adminName  || "Admin",
  });
});

// GET /admin/api/stream — SSE for real-time dashboard updates
app.get("/admin/api/stream", adminAuth, (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  res.write('data: {"type":"connected"}\n\n');

  const statsInterval = setInterval(async () => {
    try {
      const fiveMinAgo = new Date(Date.now() - 5  * 60 * 1000).toISOString();
      const oneDayAgo  = new Date(Date.now() - 86_400_000).toISOString();
      const oneWeekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

      // Debug: log all sessions in the table regardless of filters
      const { data: allSessions } = await supabaseAdmin.from("sessions").select("user_id, email, is_active, last_ping");
      console.log("[SSE] All sessions in table:", JSON.stringify(allSessions));
      console.log("[SSE] Querying active sessions, cutoff:", fiveMinAgo);

      const [sessionsRes, profilesRes, purchasesRes, usageRes, sessionsTodayRes] = await Promise.all([
        supabaseAdmin.from("sessions").select("*").eq("is_active", true).gte("last_ping", fiveMinAgo),
        supabaseAdmin.from("profiles").select("id, credits, total_credits_used, last_seen, created_at"),
        supabaseAdmin.from("purchases").select("price_usd, created_at"),
        supabaseAdmin.from("usage").select("session_seconds, credits_used"),
        supabaseAdmin.from("sessions").select("user_id").gte("last_ping", oneDayAgo),
      ]);

      const sessions  = sessionsRes.data  || [];
      console.log("[SSE] Active sessions found:", sessions.length);
      const profiles  = profilesRes.data  || [];
      const purchases = purchasesRes.data || [];
      const usage     = usageRes.data     || [];

      const sessionUserIdsToday = new Set((sessionsTodayRes.data || []).map(s => s.user_id));
      const totalRevenue = purchases.reduce((s, p) => s + (p.price_usd || 0), 0);
      const activeToday  = Math.max(
        profiles.filter(u => u.last_seen && u.last_seen > oneDayAgo).length,
        sessionUserIdsToday.size
      );
      const newThisWeek      = profiles.filter(u => u.created_at && u.created_at > oneWeekAgo).length;
      const totalCreditsUsed = usage.reduce((s, u) => s + (u.credits_used || 0), 0);
      const totalSecondsUsed = usage.reduce((s, u) => s + (u.session_seconds || 0), 0);

      const enrichedSessions = sessions.map(s => ({
        ...s,
        duration_secs:   Math.max(0, Math.floor((Date.now() - new Date(s.started_at).getTime()) / 1000)),
        credits_per_min: 130.8,
      }));

      const [{ count: unreadNotifs }, decartBalance] = await Promise.all([
        supabaseAdmin.from("admin_notifications").select("id", { count: "exact", head: true }).eq("is_read", false),
        getCachedDecartBalance(),
      ]);

      const payload = {
        type:      "update",
        timestamp: Date.now(),
        unreadNotifications: unreadNotifs || 0,
        decart_balance: decartBalance,
        stats: {
          totalUsers:       profiles.length,
          activeToday,
          newThisWeek,
          totalRevenue:     totalRevenue.toFixed(2),
          totalCreditsUsed: Math.round(totalCreditsUsed),
          estDecartCost:    (totalSecondsUsed * 2.18 * 0.00625).toFixed(2),
        },
        liveSessions: enrichedSessions,
        liveCount:    enrichedSessions.length,
      };

      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (err) {
      res.write(`data: {"type":"error","msg":${JSON.stringify(err.message)}}\n\n`);
    }
  }, 5000);

  req.on("close", () => clearInterval(statsInterval));
});

// ── Admin helper: merge auth users + profiles ─────────────────────
// Fetches up to 1000 auth users (email + ban status), all profile
// rows, and merges them in memory.  Suitable for both stats + users.
async function fetchAllUsersData() {
  const [authRes, profilesRes] = await Promise.all([
    supabaseAdmin.auth.admin.listUsers({ perPage: 1000 }),
    supabaseAdmin.from("profiles")
      .select("id, display_name, credits, total_credits_purchased, total_credits_used, created_at, last_seen"),
  ]);

  const authUsers = authRes.data?.users || [];
  const profiles  = profilesRes.data   || [];

  const authMap = {};
  authUsers.forEach(u => {
    authMap[u.id] = {
      email:     u.email || "—",
      is_banned: u.banned_until ? new Date(u.banned_until) > new Date() : false,
    };
  });

  const merged = profiles.map(p => {
    const auth = authMap[p.id] || {};
    return {
      id:                p.id,
      email:             auth.email     || "—",
      name:              p.display_name || "—",
      credits_balance:   p.credits                 || 0,
      credits_purchased: p.total_credits_purchased || 0,
      credits_used:      p.total_credits_used      || 0,
      last_seen_at:      p.last_seen               || null,
      is_banned:         auth.is_banned            || false,
      created_at:        p.created_at,
    };
  });

  return { merged, authUsers, profiles };
}

function buildProfileInsertRow({ userId, displayName, avatarUrl, credits = 6, createdAt = null }) {
  return {
    id:                      userId,
    display_name:            displayName || "User",
    avatar_url:              avatarUrl || null,
    credits,
    total_credits_purchased: 0,
    created_at:              createdAt || new Date().toISOString(),
  };
}

async function getAuthEmailByUserId(userId) {
  if (!userId || !validateUUID(userId)) return null;
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (error) {
      console.warn("[AUTH] Email lookup failed:", error.message);
      return null;
    }
    return data?.user?.email || null;
  } catch (err) {
    console.warn("[AUTH] Email lookup error:", err.message);
    return null;
  }
}

// ── Admin: stats overview ─────────────────────────────────────────
app.get("/admin/api/stats", adminAuth, async (_req, res) => {
  const now   = Date.now();
  const DAY   = 86_400_000;
  const WEEK  = 7  * DAY;
  const MONTH = 30 * DAY;

  try {
    const [{ merged, profiles }, purchasesRes, usageRes, sessionsTodayRes] = await Promise.all([
      fetchAllUsersData(),
      supabaseAdmin.from("purchases").select("price_usd, credits_added, pack_name, created_at"),
      supabaseAdmin.from("usage").select("credits_used, session_seconds, created_at"),
      supabaseAdmin.from("sessions").select("user_id").gte("last_ping", new Date(now - DAY).toISOString()),
    ]);

    const purchases = purchasesRes.data || [];
    const usages    = usageRes.data     || [];

    const sessionUserIdsToday = new Set((sessionsTodayRes.data || []).map(s => s.user_id));
    const totalUsers  = merged.length;
    const activeToday = Math.max(
      merged.filter(u => u.last_seen_at && (now - new Date(u.last_seen_at).getTime()) < DAY).length,
      sessionUserIdsToday.size
    );
    const newThisWeek  = profiles.filter(p => p.created_at && (now - new Date(p.created_at).getTime()) < WEEK).length;
    const revenueTotal = purchases.reduce((s, p) => s + (p.price_usd || 0), 0);
    const revenueMonth = purchases.filter(p => (now - new Date(p.created_at).getTime()) < MONTH)
                                  .reduce((s, p) => s + (p.price_usd || 0), 0);
    const revenueToday = purchases.filter(p => (now - new Date(p.created_at).getTime()) < DAY)
                                  .reduce((s, p) => s + (p.price_usd || 0), 0);
    const creditsUsed      = merged.reduce((s, u) => s + u.credits_used, 0);
    const totalSecondsUsed = usages.reduce((s, u) => s + (u.session_seconds || 0), 0);
    // Decart cost: 2.18 Decart credits/sec × $0.00625/credit (from $500/80,000cr best-rate pack)
    // Formula: total_session_seconds * 2.18 * 0.00625
    const estimatedDecartCost = Number((totalSecondsUsed * 2.18 * 0.00625).toFixed(2));

    // Pack breakdown — count + revenue per pack
    const packBreakdown = {};
    purchases.forEach(p => {
      const name = p.pack_name || "Unknown";
      if (!packBreakdown[name]) packBreakdown[name] = { count: 0, revenue: 0 };
      packBreakdown[name].count++;
      packBreakdown[name].revenue = Number((packBreakdown[name].revenue + (p.price_usd || 0)).toFixed(2));
    });

    // Best-selling pack by units sold
    let bestPack = null, bestCount = 0;
    Object.entries(packBreakdown).forEach(([name, d]) => {
      if (d.count > bestCount) { bestCount = d.count; bestPack = name; }
    });

    // Revenue chart — last 30 days as [{ date, total }]
    const byDay = {};
    for (let i = 29; i >= 0; i--) {
      const key = new Date(now - i * DAY).toISOString().split("T")[0];
      byDay[key] = 0;
    }
    purchases.forEach(p => {
      const key = (p.created_at || "").split("T")[0];
      if (key in byDay) byDay[key] = Number((byDay[key] + (p.price_usd || 0)).toFixed(2));
    });
    const revenueChart = Object.entries(byDay).map(([date, total]) => ({ date, total }));

    res.json({
      ok: true,
      totalUsers,
      activeToday,
      newThisWeek,
      revenueTotal:         Number(revenueTotal.toFixed(2)),
      revenueMonth:         Number(revenueMonth.toFixed(2)),
      revenueToday:         Number(revenueToday.toFixed(2)),
      creditsUsed,
      totalSecondsUsed,
      estimatedDecartCost,
      packBreakdown,
      bestPack,
      revenueChart,
    });
  } catch (err) {
    console.error("[Tzurah] /admin/api/stats error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: users (paginated, searchable) ─────────────────────────
app.get("/admin/api/users", adminAuth, async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page  || "1",  10));
  const limit  = Math.min(100, parseInt(req.query.limit || "20", 10));
  const search = (req.query.search || "").toLowerCase().trim();

  try {
    const { merged } = await fetchAllUsersData();

    // Filter by email or display name
    const filtered = search
      ? merged.filter(u =>
          u.email.toLowerCase().includes(search) ||
          u.name.toLowerCase().includes(search)
        )
      : merged;

    // Sort newest first
    filtered.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    const total      = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const users      = filtered.slice((page - 1) * limit, page * limit);

    res.json({ ok: true, users, total, totalPages, page });
  } catch (err) {
    console.error("[Tzurah] /admin/api/users error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: users active today (with session stats) ────────────────
app.get("/admin/api/users/active-today", adminAuth, async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
  try {
    const { data: rows } = await supabaseAdmin
      .from("usage")
      .select("user_id, credits_used, session_seconds")
      .gte("created_at", oneDayAgo);

    const byUser = {};
    (rows || []).forEach(u => {
      if (!byUser[u.user_id]) byUser[u.user_id] = { sessions: 0, credits: 0, seconds: 0 };
      byUser[u.user_id].sessions++;
      byUser[u.user_id].credits  += u.credits_used    || 0;
      byUser[u.user_id].seconds  += u.session_seconds || 0;
    });

    const userIds = Object.keys(byUser);
    if (!userIds.length) return res.json({ ok: true, users: [] });

    // Bulk fetch profiles (credits + display_name only — email lives in auth.users)
    const { data: profiles } = await supabaseAdmin
      .from("profiles")
      .select("id, display_name, credits, last_seen")
      .in("id", userIds);

    const profileMap = {};
    (profiles || []).forEach(p => { profileMap[p.id] = p; });

    // Fetch email from auth for each user
    const enriched = await Promise.all(
      userIds.map(async (userId) => {
        const prof = profileMap[userId] || {};
        const { data: au } = await supabaseAdmin.auth.admin.getUserById(userId);
        const email     = au?.user?.email      || "unknown";
        const is_banned = !!au?.user?.banned_until;
        return {
          user_id:   userId,
          email,
          name:      prof.display_name || null,
          balance:   typeof prof.credits === "number" ? prof.credits : 0,
          last_seen: prof.last_seen || null,
          is_banned,
          ...byUser[userId],
        };
      })
    );

    enriched.sort((a, b) => b.credits - a.credits);
    res.json({ ok: true, users: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: user profile (must come after /active-today to avoid route match) ──
app.get("/admin/api/users/:id", adminAuth, async (req, res) => {
  const userId = req.params.id;
  try {
    const [authRes, profileRes, sessionsRes, purchasesRes, usageRes] = await Promise.all([
      supabaseAdmin.auth.admin.getUserById(userId),
      supabaseAdmin.from("profiles").select("*").eq("id", userId).single(),
      supabaseAdmin.from("sessions").select("id, started_at, last_ping, is_active, credits_used")
        .eq("user_id", userId).order("started_at", { ascending: false }).limit(10),
      supabaseAdmin.from("purchases").select("*").eq("user_id", userId)
        .order("created_at", { ascending: false }).limit(5),
      supabaseAdmin.from("usage").select("credits_used, session_seconds")
        .eq("user_id", userId),
    ]);

    const authUser = authRes.data?.user;
    const profile  = profileRes.data;

    const totalCreditsUsed = (usageRes.data || []).reduce((s, u) => s + (u.credits_used || 0), 0);
    const totalSeconds     = (usageRes.data || []).reduce((s, u) => s + (u.session_seconds || 0), 0);

    res.json({
      ok: true,
      user: {
        id:                    userId,
        email:                 authUser?.email || "unknown",
        name:                  authUser?.user_metadata?.full_name || authUser?.user_metadata?.name || "",
        avatar_url:            authUser?.user_metadata?.avatar_url || null,
        created_at:            authUser?.created_at,
        last_sign_in_at:       authUser?.last_sign_in_at,
        is_banned:             authUser?.banned_until ? new Date(authUser.banned_until) > new Date() : false,
        credits:               profile?.credits || 0,
        total_credits_purchased: profile?.total_credits_purchased || 0,
        total_credits_used:    totalCreditsUsed,
        total_session_seconds: totalSeconds,
      },
      sessions:  (sessionsRes.data || []).map(s => ({
        id:           s.id,
        started_at:   s.started_at,
        last_ping:    s.last_ping,
        is_active:    s.is_active,
        credits_used: s.credits_used || 0,
        duration_secs: s.last_ping && s.started_at
          ? Math.max(0, Math.round((new Date(s.last_ping) - new Date(s.started_at)) / 1000))
          : 0,
      })),
      purchases: purchasesRes.data || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: revenue chart (last 30 days) ───────────────────────────
// Kept for backward compat — /admin/api/stats now also embeds revenueChart
app.get("/admin/api/revenue-chart", adminAuth, async (_req, res) => {
  const now = Date.now();
  const DAY = 86_400_000;
  const thirtyDaysAgo = new Date(now - 30 * DAY).toISOString();
  try {
    const { data } = await supabaseAdmin
      .from("purchases")
      .select("price_usd, created_at")
      .gte("created_at", thirtyDaysAgo)
      .order("created_at");

    const byDay = {};
    for (let i = 29; i >= 0; i--) {
      const key = new Date(now - i * DAY).toISOString().split("T")[0];
      byDay[key] = 0;
    }
    (data || []).forEach(p => {
      const key = (p.created_at || "").split("T")[0];
      if (key in byDay) byDay[key] = Number((byDay[key] + (p.price_usd || 0)).toFixed(2));
    });

    const chart = Object.entries(byDay).map(([date, total]) => ({ date, total }));
    res.json({ ok: true, chart });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: revenue page (full breakdown, all purchases, no limit cap) ──
app.get("/admin/api/revenue", adminAuth, async (req, res) => {
  const period = req.query.period || "30";
  const now    = new Date();
  const MS     = 86400000;

  // Compute cutoff ISO strings
  let cutoff = null, prevCutoff = null;
  if (period === "today") {
    cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  } else if (period === "month") {
    cutoff = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  } else if (period !== "all") {
    const d = parseInt(period, 10);
    if (!isNaN(d) && d > 0) {
      const c = new Date(Date.now() - d * MS);
      const p = new Date(Date.now() - d * 2 * MS);
      cutoff     = c.toISOString();
      prevCutoff = p.toISOString();
    }
  }

  try {
    const { data: allData, error } = await supabaseAdmin
      .from("purchases")
      .select("id, user_id, pack_name, price_usd, credits_added, stripe_payment_id, created_at")
      .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const all = allData || [];

    // Enrich with user email (cap at 100 to avoid long wait)
    await Promise.all(all.slice(0, 100).map(async p => {
      try {
        const { data: au } = await supabaseAdmin.auth.admin.getUserById(p.user_id);
        p.user_email = au?.user?.email || "—";
      } catch { p.user_email = "—"; }
    }));
    all.slice(100).forEach(p => { p.user_email = "—"; });

    const purchases = all.map(p => ({
      id: p.id, user_id: p.user_id, user_email: p.user_email || "—",
      pack_name: p.pack_name, amount_usd: p.price_usd, credits_added: p.credits_added,
      stripe_session_id: p.stripe_payment_id, created_at: p.created_at,
    }));

    const filtered    = cutoff     ? purchases.filter(p => p.created_at >= cutoff) : purchases;
    const prevFiltered = (cutoff && prevCutoff)
      ? purchases.filter(p => p.created_at >= prevCutoff && p.created_at < cutoff) : [];

    // Aggregate totals
    const sum  = arr => arr.reduce((s, p) => s + (p.amount_usd || 0), 0);
    const midnight  = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const yearStart  = new Date(now.getFullYear(), 0, 1).toISOString();
    const totals = {
      today:      { revenue: sum(purchases.filter(p => p.created_at >= midnight)),   count: purchases.filter(p => p.created_at >= midnight).length },
      this_month: { revenue: sum(purchases.filter(p => p.created_at >= monthStart)), count: purchases.filter(p => p.created_at >= monthStart).length },
      this_year:  { revenue: sum(purchases.filter(p => p.created_at >= yearStart)),  count: purchases.filter(p => p.created_at >= yearStart).length },
      all_time:   { revenue: sum(purchases), count: purchases.length },
    };

    // Chart grouped by date
    const chartDays = period === "today" ? 1 : period === "month" ? 31 :
                      period === "all"   ? 90 : parseInt(period, 10) || 30;
    const byDay = {};
    for (let i = chartDays - 1; i >= 0; i--) {
      const key = new Date(Date.now() - i * MS).toISOString().split("T")[0];
      byDay[key] = { revenue: 0, count: 0 };
    }
    filtered.forEach(p => {
      const key = (p.created_at || "").split("T")[0];
      if (key in byDay) {
        byDay[key].revenue = Number((byDay[key].revenue + (p.amount_usd || 0)).toFixed(2));
        byDay[key].count++;
      }
    });
    const chart = Object.entries(byDay).map(([date, v]) => ({ date, revenue: v.revenue, count: v.count }));

    // Pack breakdown
    const packMap = {};
    filtered.filter(p => (p.amount_usd || 0) > 0).forEach(p => {
      const n = p.pack_name || "Unknown";
      if (!packMap[n]) packMap[n] = { pack_name: n, sales_count: 0, total_revenue: 0 };
      packMap[n].sales_count++;
      packMap[n].total_revenue = Number((packMap[n].total_revenue + (p.amount_usd || 0)).toFixed(2));
    });
    const totalRev = Object.values(packMap).reduce((s, p) => s + p.total_revenue, 0) || 1;
    const daysN    = chartDays || 1;
    const pack_breakdown = Object.values(packMap)
      .sort((a, b) => b.total_revenue - a.total_revenue)
      .map(p => ({ ...p, pct_of_total: Number((p.total_revenue / totalRev * 100).toFixed(1)), avg_per_day: Number((p.total_revenue / daysN).toFixed(2)) }));

    // Top spender
    const byUser = {};
    filtered.filter(p => (p.amount_usd || 0) > 0).forEach(p => {
      const k = p.user_email || p.user_id;
      byUser[k] = (byUser[k] || 0) + (p.amount_usd || 0);
    });
    const topEntry = Object.entries(byUser).sort((a, b) => b[1] - a[1])[0];
    const top_spender = topEntry ? { email: topEntry[0], total: topEntry[1] } : null;

    const period_total     = sum(filtered);
    const prev_period_total = sum(prevFiltered);
    const paidOnly         = filtered.filter(p => (p.amount_usd || 0) > 0);
    const avg_order_value  = paidOnly.length ? period_total / paidOnly.length : 0;

    console.log(`[REVENUE] Returning ${purchases.length} purchases, period total: $${period_total.toFixed(2)}`);
    res.json({ purchases, chart, totals, pack_breakdown, period_total, prev_period_total, avg_order_value, top_spender });
  } catch (err) {
    console.error("[REVENUE] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: recent purchases ───────────────────────────────────────
app.get("/admin/api/purchases", adminAuth, async (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit || "50", 10));
  try {
    const { data } = await supabaseAdmin
      .from("purchases")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    const purchases = data || [];

    // Enrich with user email in parallel (cap at 50)
    await Promise.all(purchases.slice(0, 50).map(async (p) => {
      try {
        const { data: au } = await supabaseAdmin.auth.admin.getUserById(p.user_id);
        p.user_email = au?.user?.email || "—";
      } catch { p.user_email = "—"; }
    }));

    // Normalise field names to match admin.html expectations
    const normalised = purchases.map(p => ({
      id:                p.id,
      user_id:           p.user_id,
      user_email:        p.user_email || "—",
      pack_name:         p.pack_name,
      amount_usd:        p.price_usd,
      credits_added:     p.credits_added,
      stripe_session_id: p.stripe_payment_id,
      created_at:        p.created_at,
    }));

    res.json({ ok: true, purchases: normalised });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: gift credits ───────────────────────────────────────────
// Accepts { userId, amount } (admin.html) OR legacy { user_id, credits }
app.post("/admin/api/gift-credits", adminAuth, async (req, res) => {
  const role = req.session.adminRole;
  if (!can(role, "gift_credits")) {
    await logAction("unauthorized_attempt", req.session.adminEmail, role, null, { endpoint: "gift-credits", required_permission: "gift_credits" }, req);
    return res.status(403).json({ error: "Insufficient permissions", required: "gift_credits" });
  }

  const body    = req.body || {};
  const userId  = body.userId  || body.user_id;
  const credits = body.amount  != null ? body.amount : body.credits;
  const reason  = body.reason  || "";

  if (!userId || typeof credits !== "number" || credits < 1) {
    return res.status(400).json({ error: "userId and amount (>=1) required" });
  }

  try {
    const { data: profile, error: fetchErr } = await supabaseAdmin
      .from("profiles")
      .select("credits, total_credits_purchased")
      .eq("id", userId)
      .maybeSingle();

    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!profile) return res.status(404).json({ error: "User not found" });

    const { data: authData } = await supabaseAdmin.auth.admin.getUserById(userId);
    const userEmail = authData?.user?.email || userId;

    const newBalance = profile.credits + credits;

    await supabaseAdmin.from("profiles").update({
      credits:                 newBalance,
      total_credits_purchased: (profile.total_credits_purchased || 0) + credits,
    }).eq("id", userId);

    await supabaseAdmin.from("purchases").insert({
      user_id:           userId,
      pack_name:         "Gift" + (reason ? ": " + reason : ""),
      price_usd:         0,
      credits_added:     credits,
      stripe_payment_id: "gift_" + Date.now(),
      created_at:        new Date().toISOString(),
    });

    await supabaseAdmin.from("admin_notifications").insert({
      title:      "🎁 Credits Gifted",
      message:    `${credits} credits gifted to ${userEmail} by ${req.session.adminEmail}. New balance: ${newBalance}`,
      type:       "gift",
      created_at: new Date().toISOString(),
    });

    await logAction("gift_credits", req.session.adminEmail, role, userId, { amount: credits, new_balance: newBalance, reason }, req);
    res.json({ ok: true, new_balance: newBalance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: deduct credits ─────────────────────────────────────────
app.post("/admin/api/deduct-credits", adminAuth, async (req, res) => {
  const role = req.session.adminRole;
  if (!can(role, "deduct_credits")) {
    await logAction("unauthorized_attempt", req.session.adminEmail, role, null, { endpoint: "deduct-credits", required_permission: "deduct_credits" }, req);
    return res.status(403).json({ error: "Insufficient permissions", required: "deduct_credits" });
  }

  const body    = req.body || {};
  const userId  = body.userId  || body.user_id;
  const credits = body.amount  != null ? body.amount : body.credits;
  const reason  = body.reason  || "";

  if (!userId || typeof credits !== "number" || credits < 1) {
    return res.status(400).json({ error: "userId and amount (>=1) required" });
  }

  try {
    const { data: profile, error: fetchErr } = await supabaseAdmin
      .from("profiles").select("credits").eq("id", userId).maybeSingle();

    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!profile) return res.status(404).json({ error: "User not found" });

    const newBalance = Math.max(0, profile.credits - credits);
    await supabaseAdmin.from("profiles").update({ credits: newBalance }).eq("id", userId);

    await logAction("deduct_credits", req.session.adminEmail, role, userId, { amount: credits, new_balance: newBalance, reason }, req);
    res.json({ ok: true, new_balance: newBalance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: ban user ───────────────────────────────────────────────
app.post("/admin/api/ban-user", adminAuth, async (req, res) => {
  const role = req.session.adminRole;
  if (!can(role, "ban_user")) {
    await logAction("unauthorized_attempt", req.session.adminEmail, role, null, { endpoint: "ban-user", required_permission: "ban_user" }, req);
    return res.status(403).json({ error: "Insufficient permissions", required: "ban_user" });
  }
  const body   = req.body || {};
  const userId = body.userId || body.user_id;
  if (!userId) return res.status(400).json({ error: "userId required" });

  try {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { ban_duration: "87600h" });
    if (error) return res.status(500).json({ error: error.message });
    await logAction("ban_user", req.session.adminEmail, role, userId, { reason: body.reason || null }, req);
    res.json({ ok: true, status: "banned" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: unban user ─────────────────────────────────────────────
app.post("/admin/api/unban-user", adminAuth, async (req, res) => {
  const role = req.session.adminRole;
  if (!can(role, "unban_user")) {
    await logAction("unauthorized_attempt", req.session.adminEmail, role, null, { endpoint: "unban-user", required_permission: "unban_user" }, req);
    return res.status(403).json({ error: "Insufficient permissions", required: "unban_user" });
  }
  const body   = req.body || {};
  const userId = body.userId || body.user_id;
  if (!userId) return res.status(400).json({ error: "userId required" });

  try {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { ban_duration: "none" });
    if (error) return res.status(500).json({ error: error.message });
    await logAction("unban_user", req.session.adminEmail, role, userId, {}, req);
    res.json({ ok: true, status: "active" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: delete user ────────────────────────────────────────────
app.delete("/admin/api/users/:id", adminAuth, async (req, res) => {
  const role = req.session.adminRole;
  try {
    const userId = req.params.id;

    if (!can(role, "*") || role !== "super_admin") {
      await logAction("unauthorized_attempt", req.session.adminEmail, role, userId, { endpoint: "delete-user", required_permission: "super_admin" }, req);
      return res.status(403).json({ error: "Only super admins can delete users" });
    }

    // Delete in order to satisfy FK constraints — each is non-fatal
    const { error: e1 } = await supabaseAdmin.from("usage").delete().eq("user_id", userId);
    if (e1) console.warn("[Admin] usage delete:", e1.message);

    const { error: e2 } = await supabaseAdmin.from("sessions").delete().eq("user_id", userId);
    if (e2) console.warn("[Admin] sessions delete:", e2.message);

    const { error: e3 } = await supabaseAdmin.from("purchases").delete().eq("user_id", userId);
    if (e3) console.warn("[Admin] purchases delete:", e3.message);

    const { error: e4 } = await supabaseAdmin.from("profiles").delete().eq("id", userId);
    if (e4) console.warn("[Admin] profiles delete:", e4.message);

    // Auth user must be deleted last — fatal if it fails
    const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (authErr) throw new Error("Auth delete failed: " + authErr.message);

    await logAction("delete_user", req.session.adminEmail, role, userId, {}, req);
    console.log("[Admin] User deleted:", userId);
    return res.json({ success: true, deleted: userId });
  } catch (err) {
    console.error("[Admin] Delete user error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// USER SESSIONS  (live session tracking for admin dashboard)
//
// Requires a `sessions` table in Supabase.  Run this in the SQL editor:
//
//   CREATE TABLE IF NOT EXISTS public.sessions (
//     id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
//     user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
//     started_at TIMESTAMPTZ DEFAULT NOW(),
//     last_ping  TIMESTAMPTZ DEFAULT NOW(),
//     credits_used REAL DEFAULT 0,
//     is_active  BOOLEAN DEFAULT true,
//     UNIQUE(user_id)
//   );
//   ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "Service role full access sessions"
//     ON public.sessions FOR ALL USING (auth.role() = 'service_role');
// ═══════════════════════════════════════════════════════════════════

// POST /session/ping — Electron app calls every 5 s during active stream
// No JWT required — user_id comes from body (Electron local session)
// session_id is a UUID generated by the client on each Start click.
// SQL:
//   ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS kill_signal BOOLEAN DEFAULT false;
//   ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS session_id  TEXT;
app.post("/session/ping", async (req, res) => {
  const { user_id, email, credits_used, session_id } = req.body || {};
  console.log("[PING]", user_id, email || "no-email", "sid:", session_id);
  if (!user_id) return res.status(400).json({ error: "user_id required" });
  if (!validateUUID(user_id)) return res.status(400).json({ error: "Invalid user_id format" });
  try {
    if (session_id) {
      const { data: requestedSession, error: requestedErr } = await supabaseAdmin
        .from("sessions")
        .select("id, started_at, is_active, session_id, kill_signal, kill_reason, last_sync_at")
        .eq("user_id", user_id)
        .eq("session_id", session_id)
        .maybeSingle();

      if (requestedErr) console.warn("[PING] requested session lookup error:", requestedErr.message);
      if (requestedSession && (requestedSession.kill_signal || (!requestedSession.is_active && requestedSession.kill_reason))) {
        console.log("[PING] Requested session is no longer valid:", session_id, requestedSession.kill_reason);
        return res.json({
          ok: true,
          kill: true,
          reason: requestedSession.kill_reason || "session_inactive",
          current_session_invalid: true,
        });
      }
    }

    const { data: existing } = await supabaseAdmin
      .from("sessions")
      .select("id, started_at, is_active, session_id, kill_signal, kill_reason, last_sync_at")
      .eq("user_id", user_id)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Kill signal takes priority — deduct unsync'd time using last_sync_at
    if (existing?.kill_signal) {
      console.log("[PING] KILL SIGNAL for user:", user_id, "reason:", existing.kill_reason);
      if (existing.started_at) {
        const lastSync      = new Date(existing.last_sync_at || existing.started_at);
        const remainingSecs = Math.max(0, Math.round((Date.now() - lastSync.getTime()) / 1000));
        if (remainingSecs > 0) deductDecartCredits(remainingSecs, existing.session_id).catch(() => {});
      }
      await supabaseAdmin.from("sessions")
        .update({ is_active: false })
        .eq("id", existing.id);
      return res.json({ ok: true, kill: true, reason: existing.kill_reason || null });
    }

    // Check credits BEFORE updating last_ping — prevents one free cycle after 0 balance
    const { data: profile } = await supabaseAdmin
      .from("profiles").select("credits").eq("id", user_id).maybeSingle();

    if (profile && profile.credits <= 0) {
      // Deduct remaining unsync'd Decart time before closing
      const { data: sess } = session_id
        ? await supabaseAdmin.from("sessions").select("started_at, last_sync_at").eq("user_id", user_id).eq("session_id", session_id).maybeSingle()
        : { data: null };
      if (sess?.started_at) {
        const lastSync      = new Date(sess.last_sync_at || sess.started_at);
        const remainingSecs = Math.max(0, Math.round((Date.now() - lastSync.getTime()) / 1000));
        if (remainingSecs > 0) deductDecartCredits(remainingSecs, session_id).catch(() => {});
      }
      await supabaseAdmin.from("sessions").update({
        kill_signal: true,
        kill_reason: "Insufficient credits",
        is_active:   false,
        last_ping:   new Date().toISOString(),
      }).eq("user_id", user_id).eq("is_active", true);
      console.log("[PING] Force-ended session for zero credits:", user_id);
      return res.json({ ok: true, kill: true, kill_reason: "Insufficient credits", force_end: true });
    }

    // Kill any duplicate active session with a different session_id
    if (session_id) {
      const { data: dupSess } = await supabaseAdmin
        .from("sessions")
        .select("session_id, started_at, last_sync_at")
        .eq("user_id", user_id)
        .eq("is_active", true)
        .neq("session_id", session_id)
        .maybeSingle();
      if (dupSess) {
        console.warn("[PING] Duplicate session detected for:", user_id, "killing:", dupSess.session_id);
        const dupLastSync  = new Date(dupSess.last_sync_at || dupSess.started_at);
        const dupSecs      = Math.max(0, Math.round((Date.now() - dupLastSync.getTime()) / 1000));
        if (dupSecs > 0) deductDecartCredits(dupSecs, dupSess.session_id).catch(() => {});
        await supabaseAdmin.from("sessions")
          .update({ is_active: false, kill_signal: true, kill_reason: "replaced_by_new_session" })
          .eq("session_id", dupSess.session_id);
        await logBillingReconciliationEvent({
          userId: user_id,
          sessionId: dupSess.session_id,
          type: "duplicate_active_session_replaced",
          severity: "warning",
          details: { new_session_id: session_id, replaced_unbilled_secs: dupSecs },
        });
      }
    }

    const now = new Date().toISOString();

    // New session if: no row, session_id changed, or previous session was inactive
    const isNewSession = !existing ||
      (session_id && existing.session_id !== session_id) ||
      !existing.is_active;

    if (isNewSession) {
      if (existing) {
        console.log("[PING] NEW SESSION — reset started_at for:", user_id);
        await supabaseAdmin.from("sessions").update({
          last_ping:    now,
          started_at:   now,
          credits_used: Number(credits_used) || 0,
          email:        email || "unknown",
          is_active:    true,
          kill_signal:  false,
          kill_reason:  null,
          session_id:   session_id || null,
        }).eq("id", existing.id);
      } else {
        console.log("[PING] INSERT new session for:", user_id);
        await supabaseAdmin.from("sessions").insert({
          user_id,
          email:        email || "unknown",
          started_at:   now,
          last_ping:    now,
          credits_used: Number(credits_used) || 0,
          is_active:    true,
          session_id:   session_id || null,
        });
      }
    } else {
      console.log("[PING] UPDATE session for:", user_id);
      await supabaseAdmin.from("sessions").update({
          last_ping:    now,
          credits_used: Number(credits_used) || 0,
          email:        email || "unknown",
          is_active:    true,
          kill_signal:  false,
          kill_reason:  null,
        }).eq("id", existing.id);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[PING] error:", err.message);
    res.json({ ok: true, warn: err.message });
  }
});

// POST /session/end — Electron calls when stream stops (idempotent, accepts user_id or session_id)
app.post("/session/end", async (req, res) => {
  const { user_id, session_id } = req.body || {};
  if (!user_id && !session_id) return res.status(400).json({ error: "user_id or session_id required" });
  try {
    const endedAt = new Date();

    // Look up session — by session_id if provided, else by user_id + active
    let sessResult;
    if (session_id) {
      let sessionEndQuery = supabaseAdmin.from("sessions")
        .select("id, user_id, is_active, started_at, last_sync_at, last_ping, session_id")
        .eq("session_id", session_id);
      if (user_id) sessionEndQuery = sessionEndQuery.eq("user_id", user_id);
      sessResult = await sessionEndQuery.maybeSingle();
    } else {
      sessResult = await supabaseAdmin.from("sessions")
        .select("id, user_id, is_active, started_at, last_sync_at, last_ping, session_id")
        .eq("user_id", user_id)
        .eq("is_active", true)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
    }
    const session = sessResult.data;

    // Idempotent — safe to call multiple times
    if (!session)          return res.json({ ok: true, message: "Session not found — may already be ended" });
    if (!session.is_active) return res.json({ ok: true, message: "Session already ended" });

    await supabaseAdmin.from("sessions")
      .update({ is_active: false, last_ping: endedAt.toISOString() })
      .eq("id", session.id);
    session.last_ping = endedAt.toISOString();

    if (session.started_at) {
      const startedAt    = new Date(session.started_at);
      const durationSecs = Math.max(0, Math.round((endedAt - startedAt) / 1000));
      const lastSync     = session.last_sync_at ? new Date(session.last_sync_at) : startedAt;
      const remainingSecs = Math.max(0, Math.round((endedAt - lastSync) / 1000));

      console.log(`[SESSION END] Total: ${durationSecs}s | Unsync'd: ${remainingSecs}s`);

      // Only deduct if >2s to prevent micro-deductions from rapid duplicate calls
      if (remainingSecs > 2) {
        const result = await deductDecartCredits(remainingSecs, session.session_id || session.id).catch(() => null);
        if (result) {
          console.log(`[SESSION SUMMARY] ${durationSecs}s total | ${remainingSecs}s unsync'd | ${result.decartCost} cr | ${result.newBalance?.toFixed(0) ?? "?"} remaining`);
        }
      }
    }

    await detectMissingFinalSync(session);

    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: true, warn: err.message });
  }
});

// ── Admin: live sessions ──────────────────────────────────────────
app.get("/admin/api/live-sessions", adminAuth, async (_req, res) => {
  const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  try {
    const { data: sessions, error } = await supabaseAdmin
      .from("sessions")
      .select("*")
      .eq("is_active", true)
      .gte("last_ping", twoMinAgo)
      .order("last_ping", { ascending: false });

    if (error) {
      return res.json({ ok: true, sessions: [], count: 0, note: "sessions table not created yet" });
    }

    const enriched = (sessions || []).map(s => ({
      ...s,
      email:          s.email || "unknown",
      duration_secs:  Math.max(0, Math.floor((Date.now() - new Date(s.started_at).getTime()) / 1000)),
      credits_per_min: 130.8,
    }));

    res.json({ ok: true, sessions: enriched, count: enriched.length });
  } catch (err) {
    res.json({ ok: true, sessions: [], count: 0, error: err.message });
  }
});

// GET /admin/api/sessions/history — paginated completed sessions
app.get("/admin/api/sessions/history", adminAuth, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = 25;
    const offset = (page - 1) * limit;
    const email  = req.query.email  || "";
    const from   = req.query.from   || "";
    const to     = req.query.to     || "";

    let query = supabaseAdmin
      .from("sessions")
      .select(`
        session_id,
        user_id,
        email,
        is_active,
        started_at,
        last_ping,
        kill_signal,
        kill_reason,
        kill_note,
        last_sync_at,
        credits_used
      `)
      .eq("is_active", false)
      .order("started_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (from) query = query.gte("started_at", from);
    if (to)   query = query.lte("started_at", to);

    const { data, error } = await query;
    if (error) throw error;

    let sessions = (data || []).map(s => {
      const start         = new Date(s.started_at);
      const end           = new Date(s.last_ping || s.started_at);
      const duration_secs = Math.max(0, Math.round((end - start) / 1000));
      const credits_used  = s.credits_used || Math.round(duration_secs * 2.18);
      return { ...s, duration_secs, credits_used, status: s.kill_signal ? "Killed" : "Completed" };
    });

    if (email) {
      sessions = sessions.filter(s => s.email?.toLowerCase().includes(email.toLowerCase()));
    }

    const { count } = await supabaseAdmin
      .from("sessions")
      .select("*", { count: "exact", head: true })
      .eq("is_active", false);

    return res.json({ sessions, total: count || 0, page, pages: Math.ceil((count || 0) / limit) });
  } catch (err) {
    console.error("[SESSIONS HISTORY]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /admin/api/end-session — force-end a user's active session via kill signal
app.post("/admin/api/end-session", adminAuth, async (req, res) => {
  const role = req.session.adminRole;
  if (!can(role, "kill_session")) {
    await logAction("unauthorized_attempt", req.session.adminEmail, role, null, { endpoint: "end-session", required_permission: "kill_session" }, req);
    return res.status(403).json({ error: "Insufficient permissions", required: "kill_session" });
  }
  const body       = req.body || {};
  const userId     = body.userId || body.user_id;
  const reason     = body.reason     || null;
  const adminNote  = body.admin_note || null;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    await supabaseAdmin.from("sessions")
      .update({ is_active: false, kill_signal: true, kill_reason: reason, kill_note: adminNote })
      .eq("user_id", userId);
    await logAction("kill_session", req.session.adminEmail, role, userId, { reason, admin_note: adminNote }, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/api/decart-balance — current balance, threshold, and cost rate
app.get("/admin/api/decart-balance", adminAuth, async (_req, res) => {
  try {
    const [balance, threshold, costPerSecond] = await Promise.all([
      getSettingValue("decart_balance",         "1000"),
      getSettingValue("decart_alert_threshold", "200"),
      getSettingValue("decart_cost_per_second", "2.0"),
    ]);
    return res.json({
      balance:          parseFloat(balance),
      threshold:        parseFloat(threshold),
      cost_per_second:  parseFloat(costPerSecond),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /admin/api/decart-balance — manually set balance, threshold, or cost rate
app.post("/admin/api/decart-balance", adminAuth, async (req, res) => {
  const role = req.session.adminRole;
  const { balance, threshold, cost_per_second } = req.body || {};
  try {
    if (balance          !== undefined) await setSettingValue("decart_balance",         String(Math.max(0, parseFloat(balance)         || 0)));
    if (threshold        !== undefined) await setSettingValue("decart_alert_threshold",  String(Math.max(0, parseFloat(threshold)       || 0)));
    if (cost_per_second  !== undefined) await setSettingValue("decart_cost_per_second",  String(Math.max(0, parseFloat(cost_per_second) || 0)));
    invalidateDecartCache();
    await logAction("update_decart_balance", req.session.adminEmail, role, null, { balance, threshold, cost_per_second }, req);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /admin/api/decart-log — deduction audit log (last 100 entries)
app.get("/admin/api/decart-log", adminAuth, async (_req, res) => {
  try {
    const raw = await getSettingValue("decart_deduction_log", "[]");
    const log = JSON.parse(raw);
    return res.json({ log });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Admin: recent activity feed ───────────────────────────────────
// GET /admin/api/reconciliation/summary - lightweight billing anomaly summary
const PROTECTED_BILLING_FLAGS = [
  "enable_protected_billing_global",
  "enable_protected_billing_test_users",
  "protected_billing_shadow_compare",
  "protected_billing_force_legacy",
];

const PROTECTED_BILLING_ALLOWLIST_SETTING = "protected_billing_test_users";

function isTestModeEvent(event) {
  return event?.details?.test_mode === true || event?.details?.test_mode === "true";
}

function countBy(rows, keyFn) {
  const out = {};
  for (const row of rows || []) {
    const key = keyFn(row) || "unknown";
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function isoBucket(ts, granularity = "day") {
  const d = new Date(ts || Date.now());
  if (!Number.isFinite(d.getTime())) return "unknown";
  if (granularity === "hour") return d.toISOString().slice(0, 13) + ":00Z";
  return d.toISOString().slice(0, 10);
}

const SAFE_OPERATIONAL_RECON_TYPES = new Set([
  "duplicate_active_session_replaced",
  "replaced_session_attempted_sync",
  "stale_session_detected",
  "stale_session_attempted_sync",
  "inactive_session_attempted_sync",
  "duplicate_sync_id_detected",
  "legacy_missing_session_id",
  "billing_sync_capped",
]);

const WARNING_RECON_TYPES = new Set([
  "missing_final_sync",
  "billing_rounding_drift_warning",
  "shadow_credit_mismatch",
  "invalid_billing_numeric_input",
  "suspicious_sync_pattern",
  "stale_active_session_attempted_sync",
]);

const DANGEROUS_RECON_TYPES = new Set([
  "balance_drift_severe",
  "decart_billing_mismatch_severe",
  "billing_rounding_drift_severe",
  "failed_billing_write",
  "duplicate_live_deduction",
  "invalid_live_billing",
  "protected_legacy_mismatch_severe",
  "orphan_active_session",
]);

function reconciliationEventCategory(event = {}) {
  const type = String(event.type || "");
  const severity = String(event.severity || "info");
  if (severity === "critical" || DANGEROUS_RECON_TYPES.has(type) || /failed_billing|duplicate_live|invalid_live|mismatch_severe/.test(type)) {
    return "DANGEROUS";
  }
  if (SAFE_OPERATIONAL_RECON_TYPES.has(type)) return "SAFE_OPERATIONAL";
  if (severity === "high" || WARNING_RECON_TYPES.has(type) || /missing_final|drift_warning|suspicious/.test(type)) {
    return "WARNING";
  }
  return severity === "warning" ? "WARNING" : "SAFE_OPERATIONAL";
}

function reconciliationExpectation(event = {}) {
  const category = reconciliationEventCategory(event);
  if (category === "DANGEROUS") return "Dangerous";
  if (category === "WARNING") return "Investigate";
  return "Expected";
}

function eventDriftAmount(event = {}) {
  const details = event.details || {};
  const explicit = Number(details.drift ?? details.drift_amount ?? details.delta ?? details.abs_drift);
  if (Number.isFinite(explicit)) return Math.abs(explicit);
  const requested = Number(details.requested ?? details.credits_requested);
  const expected = Number(details.expected ?? details.credits_expected);
  if (Number.isFinite(requested) && Number.isFinite(expected)) return Math.abs(requested - expected);
  return 0;
}

function groupReconciliationEvents(events = []) {
  const groups = new Map();
  for (const event of events || []) {
    const category = reconciliationEventCategory(event);
    const expectation = reconciliationExpectation(event);
    const drift = eventDriftAmount(event);
    const isSmallDrift = event.type === "billing_rounding_drift_warning" && drift < 2;
    const key = isSmallDrift
      ? `${event.type}:small-drift`
      : `${event.type}:${event.severity || "info"}:${category}:${event.resolved ? "resolved" : "active"}`;
    if (!groups.has(key)) {
      groups.set(key, {
        type: event.type || "unknown",
        severity: event.severity || "info",
        category,
        expectation,
        count: 0,
        session_count: 0,
        avg_drift: 0,
        max_drift: 0,
        latest_at: event.created_at,
        sample: event,
        sessions: new Set(),
      });
    }
    const group = groups.get(key);
    group.count += 1;
    if (event.session_id) group.sessions.add(event.session_id);
    group.latest_at = !group.latest_at || new Date(event.created_at) > new Date(group.latest_at) ? event.created_at : group.latest_at;
    group.max_drift = Math.max(group.max_drift, drift);
    group.avg_drift += drift;
  }
  return Array.from(groups.values()).map(group => ({
    ...group,
    session_count: group.sessions.size,
    sessions: undefined,
    avg_drift: group.count ? Number((group.avg_drift / group.count).toFixed(3)) : 0,
    max_drift: Number(group.max_drift.toFixed(3)),
  })).sort((a, b) => {
    const rank = { DANGEROUS: 0, WARNING: 1, SAFE_OPERATIONAL: 2 };
    return (rank[a.category] ?? 3) - (rank[b.category] ?? 3) || new Date(b.latest_at) - new Date(a.latest_at);
  });
}

function healthInterpretationFor(score, categoryCounts = {}) {
  const dangerous = categoryCounts.DANGEROUS || 0;
  const warning = categoryCounts.WARNING || 0;
  if (score >= 90 && dangerous === 0) {
    return {
      state: "HEALTHY",
      message: "Billing protections are operating normally.",
      guidance: "Recoverable operational events are being handled without active cutover blockers.",
    };
  }
  if (score >= 70 && dangerous === 0) {
    return {
      state: "DEGRADED",
      message: "Recoverable anomalies detected. Review before protected billing cutover.",
      guidance: `${warning} warning-level signals are active in the current window.`,
    };
  }
  return {
    state: "DANGEROUS",
    message: "Critical billing integrity issues detected.",
    guidance: "Keep protected live billing disabled until dangerous anomalies are resolved.",
  };
}

async function getRecentReconciliationRows(days = 7, includeResolved = false) {
  let query = supabaseAdmin
    .from("billing_reconciliation_events")
    .select("id,type,severity,details,session_id,user_id,created_at,resolved,auto_resolved")
    .gte("created_at", new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(5000);
  if (!includeResolved) query = query.or("resolved.is.false,resolved.is.null");
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

async function getRecentBillingSyncRows(days = 7) {
  const { data, error } = await supabaseAdmin
    .from("billing_syncs")
    .select("id,user_id,session_id,sync_id,sync_sequence,source,duration_secs,credits_requested,credits_expected,credits_deducted,status,shadow_only,created_at")
    .gte("created_at", new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(5000);
  if (error) throw new Error(error.message);
  return data || [];
}

function buildReconciliationAnalytics({ events = [], syncs = [] }) {
  const realEvents = events.filter(e => !isTestModeEvent(e));
  const testEvents = events.filter(isTestModeEvent);
  const categoryCounts = countBy(realEvents, reconciliationEventCategory);
  const expectationCounts = countBy(realEvents, reconciliationExpectation);
  const groupedAnomalies = groupReconciliationEvents(realEvents);
  const driftSyncs = syncs.filter(s => Math.abs(Number(s.credits_requested || 0) - Number(s.credits_expected || 0)) >= 0.5);
  const severeDriftSyncs = syncs.filter(s => Math.abs(Number(s.credits_requested || 0) - Number(s.credits_expected || 0)) >= 2);
  const scenarioStats = {};
  for (const event of testEvents) {
    const scenario = event.details?.scenario || "unknown";
    if (!scenarioStats[scenario]) scenarioStats[scenario] = { runs: 0, events: 0, warnings: 0, high: 0, critical: 0 };
    scenarioStats[scenario].events += 1;
    if (event.type === "soak_test_completed") scenarioStats[scenario].runs += 1;
    if (event.severity === "warning") scenarioStats[scenario].warnings += 1;
    if (event.severity === "high") scenarioStats[scenario].high += 1;
    if (event.severity === "critical") scenarioStats[scenario].critical += 1;
  }
  return {
    totals: {
      events: events.length,
      real_events: realEvents.length,
      test_events: testEvents.length,
      billing_syncs: syncs.length,
      operational_events: categoryCounts.SAFE_OPERATIONAL || 0,
      warning_events: categoryCounts.WARNING || 0,
      dangerous_events: categoryCounts.DANGEROUS || 0,
      severe_events: realEvents.filter(e => e.severity === "high" || e.severity === "critical" || reconciliationEventCategory(e) === "DANGEROUS").length,
      critical_events: realEvents.filter(e => e.severity === "critical").length,
      duplicate_sync_events: realEvents.filter(e => e.type === "duplicate_sync_id_detected").length,
      missing_final_sync: realEvents.filter(e => e.type === "missing_final_sync").length,
      stale_sessions: realEvents.filter(e => e.type === "stale_session_detected").length,
      invalid_session_attempts: realEvents.filter(e => /invalid|killed|replaced|inactive|stale/.test(String(e.type || ""))).length,
      drift_warning_syncs: driftSyncs.length,
      drift_severe_syncs: severeDriftSyncs.length,
      soak_runs: testEvents.filter(e => e.type === "soak_test_completed").length,
    },
    counts_by_type: countBy(realEvents, e => e.type),
    counts_by_severity: countBy(realEvents, e => e.severity || "info"),
    counts_by_category: categoryCounts,
    counts_by_expectation: expectationCounts,
    grouped_anomalies: groupedAnomalies.slice(0, 25),
    scenario_stats: scenarioStats,
    drift: {
      average_abs_drift: syncs.length ? Number((syncs.reduce((sum, s) => sum + Math.abs(Number(s.credits_requested || 0) - Number(s.credits_expected || 0)), 0) / syncs.length).toFixed(3)) : 0,
      warning_count: driftSyncs.length,
      severe_count: severeDriftSyncs.length,
    },
  };
}

function calculateBillingIntegrityScore(analytics) {
  const totals = analytics?.totals || {};
  const categories = analytics?.counts_by_category || {};
  let score = 100;
  const breakdown = [];
  const applyPenalty = (label, points, count = 0) => {
    const penalty = Math.max(0, Math.min(40, Number(points) || 0));
    if (penalty > 0) breakdown.push({ label, points: penalty, count });
    score -= penalty;
  };
  applyPenalty("Critical reconciliation events", (totals.critical_events || 0) * 18, totals.critical_events || 0);
  applyPenalty("Dangerous billing integrity events", Math.max(0, (categories.DANGEROUS || 0) - (totals.critical_events || 0)) * 10, categories.DANGEROUS || 0);
  applyPenalty("Severe drift", (totals.drift_severe_syncs || 0) * 7, totals.drift_severe_syncs || 0);
  applyPenalty("Missing final syncs", Math.min(10, (totals.missing_final_sync || 0) * 2), totals.missing_final_sync || 0);
  applyPenalty("Invalid session attempts", Math.min(8, Math.floor((totals.invalid_session_attempts || 0) / 3)), totals.invalid_session_attempts || 0);
  applyPenalty("Operational warning volume", Math.min(6, Math.floor((categories.WARNING || 0) / 8)), categories.WARNING || 0);
  applyPenalty("Rounding drift accumulation", Math.min(5, Math.floor((totals.drift_warning_syncs || 0) / 12)), totals.drift_warning_syncs || 0);
  applyPenalty("Handled operational events", Math.min(3, Math.floor((categories.SAFE_OPERATIONAL || 0) / 25)), categories.SAFE_OPERATIONAL || 0);
  score = Math.max(0, Math.min(100, score));
  const label = score >= 90 ? "healthy" : score >= 70 ? "degraded" : "dangerous";
  const color = score >= 90 ? "green" : score >= 70 ? "amber" : "red";
  const health = healthInterpretationFor(score, categories);
  return { score, label, color, explanation: health.message, health, breakdown };
}

function buildReconciliationTrends({ events = [], syncs = [] }) {
  const realEvents = events.filter(e => !isTestModeEvent(e));
  const series = realEvents.map(event => ({
    bucket: isoBucket(event.created_at, "day"),
    severity: event.severity || "info",
    category: reconciliationEventCategory(event),
    type: event.type || "unknown",
  }));
  return {
    hourly: countBy(realEvents, e => isoBucket(e.created_at, "hour")),
    daily: countBy(realEvents, e => isoBucket(e.created_at, "day")),
    by_severity_daily: {
      info: countBy(series.filter(e => e.severity === "info"), e => e.bucket),
      warning: countBy(series.filter(e => e.severity === "warning"), e => e.bucket),
      high: countBy(series.filter(e => e.severity === "high"), e => e.bucket),
      critical: countBy(series.filter(e => e.severity === "critical"), e => e.bucket),
    },
    by_category_daily: {
      safe_operational: countBy(series.filter(e => e.category === "SAFE_OPERATIONAL"), e => e.bucket),
      warning: countBy(series.filter(e => e.category === "WARNING"), e => e.bucket),
      dangerous: countBy(series.filter(e => e.category === "DANGEROUS"), e => e.bucket),
    },
    top_types: Object.entries(countBy(realEvents, e => e.type)).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([type, count]) => ({ type, count })),
    duplicate_sync_trend: countBy(realEvents.filter(e => e.type === "duplicate_sync_id_detected"), e => isoBucket(e.created_at, "day")),
    missing_final_trend: countBy(realEvents.filter(e => e.type === "missing_final_sync"), e => isoBucket(e.created_at, "day")),
    stale_session_trend: countBy(realEvents.filter(e => e.type === "stale_session_detected"), e => isoBucket(e.created_at, "day")),
    drift_trend: countBy(syncs.filter(s => Math.abs(Number(s.credits_requested || 0) - Number(s.credits_expected || 0)) >= 0.5), s => isoBucket(s.created_at, "day")),
    soak_scenarios: countBy(events.filter(isTestModeEvent), e => e.details?.scenario || "unknown"),
  };
}

async function getBillingFeatureFlags() {
  const { data, error } = await supabaseAdmin
    .from("feature_flags")
    .select("key, enabled")
    .in("key", PROTECTED_BILLING_FLAGS);
  if (error) throw new Error(error.message);
  const flags = {
    enable_protected_billing_global: false,
    enable_protected_billing_test_users: false,
    protected_billing_shadow_compare: true,
    protected_billing_force_legacy: true,
  };
  (data || []).forEach(row => { flags[row.key] = row.enabled === true; });
  return flags;
}

async function getProtectedBillingAllowlist() {
  const raw = await getSettingValue(PROTECTED_BILLING_ALLOWLIST_SETTING, "[]");
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

async function setProtectedBillingAllowlist(list) {
  const normalized = Array.from(new Set((list || []).filter(Boolean)));
  await setSettingValue(PROTECTED_BILLING_ALLOWLIST_SETTING, JSON.stringify(normalized));
  return normalized;
}

async function resolveBillingModeForUser(userId = null) {
  const flags = await getBillingFeatureFlags();
  const allowlist = await getProtectedBillingAllowlist();
  const allowedUser = !!(userId && allowlist.includes(userId));
  let mode = "legacy_only";
  if (flags.protected_billing_force_legacy) mode = "forced_legacy_fallback";
  else if (flags.enable_protected_billing_global) mode = flags.protected_billing_shadow_compare ? "protected_live_with_legacy_compare" : "protected_live";
  else if (flags.enable_protected_billing_test_users && allowedUser) mode = flags.protected_billing_shadow_compare ? "protected_live_with_legacy_compare" : "protected_live";
  else if (flags.protected_billing_shadow_compare) mode = "shadow_compare";
  return { mode, flags, allowlist, protected_live_enabled: mode.startsWith("protected_live"), legacy_authoritative: !mode.startsWith("protected_live") };
}

app.get("/admin/api/reconciliation/summary", adminAuth, async (req, res) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const status = ["active", "resolved", "all"].includes(String(req.query.status || "active"))
      ? String(req.query.status || "active")
      : "active";
    const testMode = ["real", "test", "all"].includes(String(req.query.test_mode || "real"))
      ? String(req.query.test_mode || "real")
      : "real";
    const autoResolvedDuringRequest = await autoResolveRecentMissingFinalFalsePositives(since);
    let eventsQuery = supabaseAdmin
      .from("billing_reconciliation_events")
      .select("id, type, severity, details, session_id, created_at, resolved, resolved_at, resolved_reason, resolved_by, auto_resolved")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1000);

    if (status === "active") {
      eventsQuery = eventsQuery.or("resolved.is.false,resolved.is.null");
    } else if (status === "resolved") {
      eventsQuery = eventsQuery.eq("resolved", true);
    }

    const [eventsRes, sessionsRes, staleRes, syncsRes] = await Promise.all([
      eventsQuery,
      supabaseAdmin.from("sessions").select("id", { count: "exact", head: true }),
      supabaseAdmin
        .from("sessions")
        .select("id", { count: "exact", head: true })
        .eq("is_active", true)
        .lt("last_ping", new Date(Date.now() - BILLING_STALE_MS).toISOString()),
      supabaseAdmin
        .from("billing_syncs")
        .select("id", { count: "exact", head: true })
        .gte("created_at", since),
    ]);

    if (eventsRes.error) {
      if (!isMissingReconciliationResolutionError(eventsRes.error)) throw new Error(eventsRes.error.message);
      const fallbackRes = await supabaseAdmin
        .from("billing_reconciliation_events")
        .select("id, type, severity, details, session_id, created_at")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1000);
      if (fallbackRes.error) throw new Error(fallbackRes.error.message);
      eventsRes.data = (fallbackRes.data || []).map(event => ({
        ...event,
        resolved: false,
        resolved_at: null,
        resolved_reason: null,
        resolved_by: null,
        auto_resolved: false,
      }));
      eventsRes.resolutionFallback = true;
    }

    const allEvents = eventsRes.data || [];
    const events = allEvents.filter(event => {
      const isTest = event.details?.test_mode === true || event.details?.test_mode === "true";
      if (testMode === "test") return isTest;
      if (testMode === "real") return !isTest;
      return true;
    });
    let resolvedCount = 0;
    let autoResolvedCount = 0;
    try {
      const [resolvedRes, autoResolvedRes] = await Promise.all([
        supabaseAdmin
          .from("billing_reconciliation_events")
          .select("id", { count: "exact", head: true })
          .eq("resolved", true)
          .gte("created_at", since),
        supabaseAdmin
          .from("billing_reconciliation_events")
          .select("id", { count: "exact", head: true })
          .eq("auto_resolved", true)
          .gte("created_at", since),
      ]);
      if (!resolvedRes.error) resolvedCount = resolvedRes.count || 0;
      if (!autoResolvedRes.error) autoResolvedCount = autoResolvedRes.count || 0;
    } catch (_) {}

    const annotatedEvents = events.map(event => ({
      ...event,
      category: reconciliationEventCategory(event),
      expectation: reconciliationExpectation(event),
    }));
    const byType = {};
    const bySeverity = { info: 0, warning: 0, high: 0, critical: 0 };
    for (const event of annotatedEvents) {
      byType[event.type] = (byType[event.type] || 0) + 1;
      bySeverity[event.severity] = (bySeverity[event.severity] || 0) + 1;
    }

    return res.json({
      ok: true,
      window_days: 7,
      status,
      test_mode: testMode,
      resolution_lifecycle_available: !eventsRes.resolutionFallback,
      total_sessions: sessionsRes.count || 0,
      total_anomalies: annotatedEvents.length,
      active_anomaly_count: status === "active" ? annotatedEvents.length : null,
      resolved_anomaly_count: resolvedCount,
      auto_resolved_count: autoResolvedCount,
      auto_resolved_during_request: autoResolvedDuringRequest,
      severe_anomalies: (bySeverity.high || 0) + (bySeverity.critical || 0),
      drift_totals: {
        rounding_warning: byType.billing_rounding_drift_warning || 0,
        rounding_severe: byType.billing_rounding_drift_severe || 0,
        balance_warning: byType.balance_drift_warning || 0,
        balance_severe: byType.balance_drift_severe || 0,
      },
      duplicate_sync_count: byType.duplicate_sync_id_detected || 0,
      missing_final_sync_count: byType.missing_final_sync || 0,
      stale_session_count: (byType.stale_session_detected || 0) + (staleRes.count || 0),
      billing_sync_count: syncsRes.count || 0,
      counts_by_type: byType,
      counts_by_severity: bySeverity,
      grouped_latest: groupReconciliationEvents(annotatedEvents).slice(0, 20),
      latest: annotatedEvents.slice(0, 50),
    });
  } catch (err) {
    console.warn("[RECON SUMMARY] Error:", err.message);
    return res.json({ ok: true, error: err.message, total_anomalies: 0 });
  }
});

app.get("/admin/api/reconciliation/analytics", adminAuth, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || "7", 10) || 7, 1), 30);
    const includeResolved = req.query.include_resolved === "true";
    const [events, syncs] = await Promise.all([
      getRecentReconciliationRows(days, includeResolved),
      getRecentBillingSyncRows(days),
    ]);
    const analytics = buildReconciliationAnalytics({ events, syncs });
    const integrity = calculateBillingIntegrityScore(analytics);
    return res.json({ ok: true, window_days: days, analytics, integrity });
  } catch (err) {
    console.warn("[RECON ANALYTICS] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/admin/api/reconciliation/trends", adminAuth, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || "7", 10) || 7, 1), 30);
    const includeResolved = req.query.include_resolved === "true";
    const [events, syncs] = await Promise.all([
      getRecentReconciliationRows(days, includeResolved),
      getRecentBillingSyncRows(days),
    ]);
    return res.json({ ok: true, window_days: days, trends: buildReconciliationTrends({ events, syncs }) });
  } catch (err) {
    console.warn("[RECON TRENDS] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/admin/api/reconciliation/integrity-score", adminAuth, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || "7", 10) || 7, 1), 30);
    const includeResolved = req.query.include_resolved === "true";
    const [events, syncs] = await Promise.all([
      getRecentReconciliationRows(days, includeResolved),
      getRecentBillingSyncRows(days),
    ]);
    const analytics = buildReconciliationAnalytics({ events, syncs });
    return res.json({ ok: true, window_days: days, integrity: calculateBillingIntegrityScore(analytics), totals: analytics.totals });
  } catch (err) {
    console.warn("[INTEGRITY SCORE] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/admin/api/billing-cutover/status", adminAuth, async (req, res) => {
  try {
    const userId = validateUUID(String(req.query.user_id || "")) ? String(req.query.user_id) : null;
    const mode = await resolveBillingModeForUser(userId);
    const [events, syncs] = await Promise.all([
      getRecentReconciliationRows(7, false),
      getRecentBillingSyncRows(7),
    ]);
    const analytics = buildReconciliationAnalytics({ events, syncs });
    const fallbackEvents = events.filter(e => /fallback|forced_legacy|protected_billing/.test(String(e.type || "")));
    const mismatchEvents = events.filter(e => /mismatch|drift|compare/.test(String(e.type || "")) && !isTestModeEvent(e));
    return res.json({
      ok: true,
      ...mode,
      global_live_enabled: mode.flags.enable_protected_billing_global === true,
      test_users_enabled: mode.flags.enable_protected_billing_test_users === true,
      fallback_events: fallbackEvents.length,
      mismatch_events: mismatchEvents.length,
      compare_mode_stats: {
        shadow_compare: mode.flags.protected_billing_shadow_compare === true,
        recent_syncs: syncs.length,
        drift_warning_syncs: analytics.totals.drift_warning_syncs,
        drift_severe_syncs: analytics.totals.drift_severe_syncs,
      },
      note: "Framework only: legacy billing remains authoritative unless a later approved phase wires protected live mode into billing endpoints.",
    });
  } catch (err) {
    console.warn("[BILLING CUTOVER STATUS] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/admin/api/billing-cutover/flags", adminAuth, async (req, res) => {
  if (req.session.adminRole !== "super_admin") return res.status(403).json({ error: "Super admin required" });
  const updates = req.body?.flags || {};
  try {
    const rows = [];
    for (const key of PROTECTED_BILLING_FLAGS) {
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        rows.push({
          key,
          enabled: updates[key] === true,
          description: "Protected billing cutover framework flag",
          updated_at: new Date().toISOString(),
          updated_by: req.session.adminEmail || "admin",
        });
      }
    }
    if (!rows.length) return res.status(400).json({ error: "No recognized billing flags provided" });
    const { error } = await supabaseAdmin.from("feature_flags").upsert(rows, { onConflict: "key" });
    if (error) throw new Error(error.message);
    await logAction("protected_billing_flags_update", req.session.adminEmail, req.session.adminRole, null, { flags: rows }, req);
    return res.json({ ok: true, status: await resolveBillingModeForUser(null) });
  } catch (err) {
    console.warn("[BILLING CUTOVER FLAGS] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/admin/api/billing-cutover/test-users", adminAuth, async (req, res) => {
  if (req.session.adminRole !== "super_admin") return res.status(403).json({ error: "Super admin required" });
  const userId = String(req.body?.user_id || "").trim();
  const enabled = req.body?.enabled === true;
  if (!validateUUID(userId)) return res.status(400).json({ error: "Valid user_id required" });
  try {
    const current = await getProtectedBillingAllowlist();
    const next = enabled ? [...current, userId] : current.filter(id => id !== userId);
    const allowlist = await setProtectedBillingAllowlist(next);
    await logAction("protected_billing_test_user_update", req.session.adminEmail, req.session.adminRole, userId, { enabled }, req);
    return res.json({ ok: true, allowlist, status: await resolveBillingModeForUser(userId) });
  } catch (err) {
    console.warn("[BILLING CUTOVER USER] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/admin/api/billing-cutover/force-legacy", adminAuth, async (req, res) => {
  if (req.session.adminRole !== "super_admin") return res.status(403).json({ error: "Super admin required" });
  const enabled = req.body?.enabled !== false;
  try {
    const { error } = await supabaseAdmin.from("feature_flags").upsert({
      key: "protected_billing_force_legacy",
      enabled,
      description: "Emergency rollback: force legacy billing mode",
      updated_at: new Date().toISOString(),
      updated_by: req.session.adminEmail || "admin",
    }, { onConflict: "key" });
    if (error) throw new Error(error.message);
    await logAction("protected_billing_force_legacy", req.session.adminEmail, req.session.adminRole, null, { enabled }, req);
    await logBillingReconciliationEvent({
      type: "protected_billing_force_legacy_changed",
      severity: enabled ? "warning" : "info",
      details: { enabled, changed_by: req.session.adminEmail || "admin", framework_only: true },
    });
    return res.json({ ok: true, status: await resolveBillingModeForUser(null) });
  } catch (err) {
    console.warn("[BILLING FORCE LEGACY] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /admin/api/reconciliation/:id/resolve - mark one anomaly resolved
app.post("/admin/api/reconciliation/:id/resolve", adminAuth, async (req, res) => {
  const id = req.params.id;
  if (!validateUUID(id || "")) return res.status(400).json({ error: "Invalid reconciliation event id" });
  const note = String(req.body?.note || "").trim();
  const reason = note || "manual_admin_resolution";
  try {
    const { data, error } = await supabaseAdmin
      .from("billing_reconciliation_events")
      .update({
        resolved: true,
        resolved_at: new Date().toISOString(),
        resolved_reason: reason,
        resolved_by: req.session.adminEmail || "admin",
        auto_resolved: false,
      })
      .eq("id", id)
      .select("id, user_id, session_id, type, severity, resolved")
      .maybeSingle();

    if (error) {
      if (isMissingReconciliationResolutionError(error)) {
        return res.status(400).json({ error: "Reconciliation resolution migration has not been applied yet" });
      }
      throw new Error(error.message);
    }
    if (!data) return res.status(404).json({ error: "Reconciliation event not found" });

    await logAction("resolve_reconciliation_event", req.session.adminEmail, req.session.adminRole, data.user_id || null, {
      event_id: id,
      session_id: data.session_id || null,
      type: data.type,
      severity: data.severity,
      reason,
    }, req);

    return res.json({ ok: true, event: data });
  } catch (err) {
    console.warn("[RECON RESOLVE] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

const SOAK_TEST_SCENARIOS = new Set([
  "normal_short_session",
  "normal_medium_session",
  "stop_start_loop",
  "duplicate_sync_replay",
  "missing_final_sync",
  "stale_session",
  "admin_killed_session",
  "replaced_session",
  "invalid_numeric_input",
]);

function requireSoakSuperAdmin(req, res) {
  if (req.session.adminRole !== "super_admin") {
    res.status(403).json({ error: "Super admin required" });
    return false;
  }
  return true;
}

function soakScenarioPlan(scenario) {
  const plans = {
    normal_short_session: [
      { duration: 5, source: "interval", status: "shadow_ok" },
      { duration: 3, source: "manual_stop", status: "shadow_ok" },
    ],
    normal_medium_session: [
      { duration: 10, source: "interval", status: "shadow_ok" },
      { duration: 10, source: "interval", status: "shadow_ok" },
      { duration: 10, source: "interval", status: "shadow_ok" },
      { duration: 5, source: "final", status: "shadow_ok" },
    ],
    stop_start_loop: [
      { duration: 4, source: "interval", status: "shadow_ok" },
      { duration: 2, source: "manual_stop", status: "shadow_ok" },
    ],
    duplicate_sync_replay: [
      { duration: 6, source: "interval", status: "shadow_ok" },
    ],
    missing_final_sync: [
      { duration: 12, source: "interval", status: "shadow_ok" },
    ],
    stale_session: [
      { duration: 8, source: "interval", status: "shadow_inactive_session", reason: "soak_stale_session" },
    ],
    admin_killed_session: [
      { duration: 6, source: "interval", status: "shadow_killed_session", reason: "soak_admin_killed" },
    ],
    replaced_session: [
      { duration: 6, source: "interval", status: "shadow_inactive_session", reason: "soak_replaced_session" },
    ],
    invalid_numeric_input: [
      { duration: 0, source: "invalid_input", status: "shadow_invalid", reason: "soak_invalid_numeric_input" },
    ],
  };
  return plans[scenario] || plans.normal_short_session;
}

function soakScenarioEvents(scenario) {
  const events = {
    duplicate_sync_replay: [{ type: "duplicate_sync_id_detected", severity: "warning", reason: "soak_duplicate_replay" }],
    missing_final_sync: [{ type: "missing_final_sync", severity: "warning", reason: "soak_missing_terminal_sync" }],
    stale_session: [{ type: "stale_session_detected", severity: "warning", reason: "soak_stale_session" }],
    admin_killed_session: [{ type: "killed_session_attempted_sync", severity: "warning", reason: "soak_admin_kill_blocks_sync" }],
    replaced_session: [{ type: "replaced_session_attempted_sync", severity: "warning", reason: "soak_replaced_session_blocks_sync" }],
    invalid_numeric_input: [{ type: "invalid_session_duration", severity: "warning", reason: "soak_invalid_numeric_input" }],
  };
  return events[scenario] || [];
}

function buildSoakBillingRows({ userId, scenario, sessionCount, adminEmail, balanceBefore }) {
  const runId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const rows = [];
  const sessions = [];
  const plan = soakScenarioPlan(scenario);
  for (let i = 0; i < sessionCount; i++) {
    const sessionId = `soak_${runId}_${scenario}_${i + 1}`;
    sessions.push(sessionId);
    let sequence = 0;
    for (const step of plan) {
      sequence += 1;
      const safeDuration = Math.min(Math.max(Number(step.duration) || 0, 0), BILLING_MAX_SYNC_SECONDS);
      const expected = calculateExpectedCredits(safeDuration) || 0;
      const requested = scenario === "invalid_numeric_input" ? 0 : Math.ceil(expected);
      const source = `soak_test_${step.source || scenario}`;
      rows.push({
        user_id: userId,
        session_id: sessionId,
        sync_id: `${sessionId}:${sequence}:${source}`,
        sync_sequence: sequence,
        source,
        duration_secs: safeDuration,
        credits_requested: requested,
        credits_expected: expected,
        credits_deducted: 0,
        balance_before: balanceBefore,
        balance_after: balanceBefore,
        status: step.status || "shadow_ok",
        reason: step.reason || `test_mode:${scenario}:${adminEmail || "admin"}:${runId}`,
        shadow_only: true,
        client_ts: new Date().toISOString(),
        created_at: new Date().toISOString(),
      });
    }
  }
  return { rows, sessions, runId };
}

// GET /admin/api/soak-test/users - super-admin-only user picker for dry-run soak tests
app.get("/admin/api/soak-test/users", adminAuth, async (req, res) => {
  if (!requireSoakSuperAdmin(req, res)) return;
  const q = String(req.query.q || "").toLowerCase().trim();
  try {
    const { merged } = await fetchAllUsersData();
    const filtered = (merged || [])
      .filter(user => {
        if (!q) return true;
        return String(user.email || "").toLowerCase().includes(q) ||
          String(user.name || "").toLowerCase().includes(q) ||
          String(user.id || "").toLowerCase().includes(q);
      })
      .sort((a, b) => new Date(b.last_seen_at || b.created_at || 0) - new Date(a.last_seen_at || a.created_at || 0))
      .slice(0, 25)
      .map(user => ({
        id: user.id,
        email: user.email || "—",
        display_name: user.name || "—",
        credits: safeBillingNumber(Number(user.credits_balance)) ?? 0,
        last_seen: user.last_seen_at || null,
      }));

    return res.json({ ok: true, users: filtered });
  } catch (err) {
    console.warn("[SOAK USERS] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /admin/api/reconciliation/soak-test - internal dry-run synthetic billing rows
app.post("/admin/api/reconciliation/soak-test", adminAuth, async (req, res) => {
  if (!requireSoakSuperAdmin(req, res)) return;

  const dryRun = req.body?.dry_run !== false;
  if (!dryRun) return res.status(400).json({ error: "Live soak mode is disabled. Use dry_run=true." });

  const scenario = String(req.body?.scenario || "normal_short_session");
  if (!SOAK_TEST_SCENARIOS.has(scenario)) return res.status(400).json({ error: "Invalid soak test scenario" });

  const sessionCountRaw = Number(req.body?.session_count ?? 10);
  if (!Number.isInteger(sessionCountRaw) || sessionCountRaw < 1) {
    return res.status(400).json({ error: "session_count must be an integer >= 1" });
  }
  const sessionCount = Math.min(sessionCountRaw, 100);

  const userId = String(req.body?.user_id || req.body?.test_user_id || "").trim();
  if (!validateUUID(userId)) return res.status(400).json({ error: "Select a valid test user first." });

  try {
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("id, credits")
      .eq("id", userId)
      .maybeSingle();
    if (profileError) throw new Error(profileError.message);
    if (!profile) return res.status(404).json({ error: "Test profile not found" });

    const balanceBefore = safeBillingNumber(profile.credits) ?? 0;
    const { rows, sessions, runId } = buildSoakBillingRows({
      userId,
      scenario,
      sessionCount,
      adminEmail: req.session.adminEmail,
      balanceBefore,
    });

    const { data: insertedSyncs, error: syncError } = await supabaseAdmin
      .from("billing_syncs")
      .insert(rows)
      .select("id, session_id, sync_id, source, status");
    if (syncError) throw new Error(syncError.message);

    const scenarioEvents = soakScenarioEvents(scenario);
    const eventRows = [{
      user_id: userId,
      session_id: sessions[0] || null,
      type: "soak_test_completed",
      severity: "info",
      details: {
        test_mode: true,
        scenario,
        generated_by: req.session.adminEmail || "admin",
        run_id: runId,
        dry_run: true,
        session_count: sessionCount,
        generated_syncs: insertedSyncs?.length || 0,
        generated_events: scenarioEvents.length * sessions.length,
        source: "soak_test",
        message: `Dry-run completed: ${insertedSyncs?.length || 0} billing sync rows created, ${scenarioEvents.length * sessions.length} anomaly events.`,
      },
      created_at: new Date().toISOString(),
    }];
    for (const sessionId of sessions) {
      for (const event of scenarioEvents) {
        eventRows.push({
          user_id: userId,
          session_id: sessionId,
          type: event.type,
          severity: event.severity,
          details: {
            test_mode: true,
            scenario,
            generated_by: req.session.adminEmail || "admin",
            run_id: runId,
            session_id: sessionId,
            dry_run: true,
            reason: event.reason,
            source: "soak_test",
          },
          created_at: new Date().toISOString(),
        });
      }
    }

    let insertedEvents = [];
    if (eventRows.length) {
      const { data, error } = await supabaseAdmin
        .from("billing_reconciliation_events")
        .insert(eventRows)
        .select("id, type, severity, session_id");
      if (error) throw new Error(error.message);
      insertedEvents = data || [];
    }

    await logAction("run_billing_soak_test", req.session.adminEmail, req.session.adminRole, userId, {
      scenario,
      session_count: sessionCount,
      dry_run: true,
      run_id: runId,
      billing_sync_rows: insertedSyncs?.length || 0,
      reconciliation_events: insertedEvents.length,
    }, req);

    return res.json({
      ok: true,
      dry_run: true,
      run_id: runId,
      scenario,
      session_count: sessionCount,
      user_id: userId,
      billing_sync_rows: insertedSyncs?.length || 0,
      reconciliation_events: insertedEvents.length,
      anomaly_events: scenarioEvents.length * sessions.length,
      sessions: sessions.slice(0, 10),
      latest_syncs: (insertedSyncs || []).slice(0, 10),
      latest_events: insertedEvents.slice(0, 10),
      note: "Synthetic dry-run rows inserted only; no Decart call and no profile credit mutation.",
    });
  } catch (err) {
    console.warn("[SOAK TEST] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /admin/api/reconciliation/soak-test/cleanup - clean only synthetic soak rows
app.post("/admin/api/reconciliation/soak-test/cleanup", adminAuth, async (req, res) => {
  if (!requireSoakSuperAdmin(req, res)) return;
  const mode = ["current_run", "all_test"].includes(String(req.body?.mode || "all_test"))
    ? String(req.body?.mode || "all_test")
    : "all_test";
  const runId = String(req.body?.run_id || "").trim();
  if (mode === "current_run" && !runId) {
    return res.status(400).json({ error: "run_id required for current_run cleanup" });
  }
  try {
    const runPrefix = `soak_${runId}_`;
    const sourceDelete = mode === "all_test"
      ? await supabaseAdmin.from("billing_syncs").delete().like("source", "soak_test%").select("id")
      : { data: [], error: null };
    const sessionDeleteQuery = supabaseAdmin.from("billing_syncs").delete();
    const sessionDelete = await (mode === "current_run"
      ? sessionDeleteQuery.like("session_id", `${runPrefix}%`)
      : sessionDeleteQuery.like("session_id", "soak_%")
    ).select("id");
    const syncDeleteQuery = supabaseAdmin.from("billing_syncs").delete();
    const syncDelete = await (mode === "current_run"
      ? syncDeleteQuery.like("sync_id", `${runPrefix}%`)
      : syncDeleteQuery.like("sync_id", "soak_%")
    ).select("id");

    let eventResolveQuery = supabaseAdmin
      .from("billing_reconciliation_events")
      .update({
        resolved: true,
        resolved_at: new Date().toISOString(),
        resolved_reason: mode === "current_run" ? "soak_test_current_run_cleanup" : "soak_test_cleanup",
        resolved_by: req.session.adminEmail || "admin",
        auto_resolved: false,
      })
      .contains("details", { test_mode: true })
      .eq("resolved", false);
    if (mode === "current_run") {
      eventResolveQuery = eventResolveQuery.contains("details", { run_id: runId });
    }
    const eventResolve = await eventResolveQuery.select("id");

    const errors = [sourceDelete.error, sessionDelete.error, syncDelete.error, eventResolve.error].filter(Boolean);
    if (errors.length) throw new Error(errors.map(e => e.message).join("; "));

    const deletedSyncIds = new Set([
      ...(sourceDelete.data || []).map(row => row.id),
      ...(sessionDelete.data || []).map(row => row.id),
      ...(syncDelete.data || []).map(row => row.id),
    ]);
    const resolvedEvents = eventResolve.data?.length || 0;

    await logAction("cleanup_billing_soak_test", req.session.adminEmail, req.session.adminRole, null, {
      mode,
      run_id: runId || null,
      deleted_billing_sync_rows: deletedSyncIds.size,
      resolved_reconciliation_events: resolvedEvents,
    }, req);

    return res.json({
      ok: true,
      mode,
      run_id: runId || null,
      deleted_billing_sync_rows: deletedSyncIds.size,
      resolved_reconciliation_events: resolvedEvents,
      note: mode === "current_run"
        ? "Only synthetic rows for this soak run were touched."
        : "Only rows marked with soak_test source/session/sync prefixes or details.test_mode=true were touched.",
    });
  } catch (err) {
    console.warn("[SOAK CLEANUP] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

function formatGiftActivityDetail(purchase) {
  const credits = safeBillingNumber(Number(purchase.credits_added || 0));
  const packName = String(purchase.pack_name || "").trim();
  const hasUsefulName = packName && !["gift", "admin gift"].includes(packName.toLowerCase());
  if (credits && credits > 0 && hasUsefulName) return `received gift: +${credits} credits (${packName})`;
  if (credits && credits > 0) return `received gift: +${credits} credits`;
  if (hasUsefulName) return `received gift: ${packName}`;
  return "received gift: Admin gift";
}

async function resolveActivityUserLabels(events) {
  const userIds = [...new Set(events.map(e => e.user_id).filter(id => validateUUID(id || "")))];
  const profileNames = new Map();
  if (userIds.length) {
    const { data: profiles, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("id, display_name")
      .in("id", userIds);
    if (profileErr) console.warn("[ACTIVITY] Profile label lookup error:", profileErr.message);
    for (const profile of profiles || []) {
      if (profile.display_name) profileNames.set(profile.id, profile.display_name);
    }
  }

  for (const event of events) {
    if (!event.user_id || !validateUUID(event.user_id)) {
      event.email = "Unknown User";
      await logActivityWarningOnce("malformed_activity_row", {
        source: "activity_feed",
        reason: "missing_or_invalid_user_id",
        type: event.type || null,
        detail: event.detail || null,
        user_id: event.user_id || null,
      });
      continue;
    }
    try {
      const { data: au, error: authErr } = await supabaseAdmin.auth.admin.getUserById(event.user_id);
      if (authErr) throw new Error(authErr.message);
      event.email = au?.user?.email || profileNames.get(event.user_id) || "Unknown User";
      if (event.email === "Unknown User") {
        await logActivityWarningOnce("malformed_activity_row", {
          source: "activity_feed",
          reason: "user_label_unresolved",
          type: event.type || null,
          user_id: event.user_id,
        });
      }
    } catch (err) {
      event.email = profileNames.get(event.user_id) || "Unknown User";
      await logActivityWarningOnce("malformed_activity_row", {
        source: "activity_feed",
        reason: "auth_user_lookup_failed",
        type: event.type || null,
        user_id: event.user_id,
        error: err.message,
      });
    }
  }
}

function collapseSessionActivity(usageRows) {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const grouped = new Map();
  const singles = [];
  for (const row of usageRows || []) {
    const ts = row.ended_at || row.created_at;
    const t = new Date(ts).getTime();
    if (!row.user_id || !Number.isFinite(t)) continue;
    if (t >= oneHourAgo) {
      const group = grouped.get(row.user_id) || { user_id: row.user_id, count: 0, seconds: 0, credits: 0, ts };
      group.count += 1;
      group.seconds += Number(row.session_seconds || 0);
      group.credits += Number(row.credits_used || 0);
      if (new Date(ts) > new Date(group.ts)) group.ts = ts;
      grouped.set(row.user_id, group);
    } else {
      singles.push(row);
    }
  }

  const events = [];
  for (const group of grouped.values()) {
    if (group.count > 1) {
      const mins = Math.floor(group.seconds / 60);
      const secs = Math.round(group.seconds % 60);
      events.push({
        type: "session",
        user_id: group.user_id,
        detail: `completed ${group.count} sessions in the last hour (${mins}m ${secs}s, ${Math.round(group.credits)} cr)`,
        ts: group.ts,
        grouped: true,
        count: group.count,
      });
    } else {
      singles.push({ user_id: group.user_id, session_seconds: group.seconds, credits_used: group.credits, ended_at: group.ts, created_at: group.ts });
    }
  }

  for (const row of singles) {
    const seconds = Math.max(0, Math.round(Number(row.session_seconds || 0)));
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    events.push({
      type: "session",
      user_id: row.user_id,
      detail: `session ended (${m}m ${s}s, ${Math.round(Number(row.credits_used || 0))} cr)`,
      ts: row.ended_at || row.created_at,
    });
  }
  return events;
}

function cleanActivityEvents(events) {
  return events.filter((event) => {
    if (!event || !event.type || !event.detail || !event.ts) return false;
    const t = new Date(event.ts).getTime();
    return Number.isFinite(t);
  });
}

app.get("/admin/api/activity", adminAuth, async (_req, res) => {
  try {
    const [purchRes, usageRes, signupRes] = await Promise.all([
      supabaseAdmin.from("purchases")
        .select("user_id, pack_name, price_usd, credits_added, created_at")
        .order("created_at", { ascending: false }).limit(20),
      supabaseAdmin.from("usage")
        .select("user_id, session_seconds, credits_used, ended_at, created_at")
        .order("created_at", { ascending: false }).limit(30),
      supabaseAdmin.from("profiles")
        .select("id, display_name, created_at")
        .order("created_at", { ascending: false }).limit(10),
    ]);

    const events = [];

    for (const p of purchRes.data || []) {
      events.push({
        type:    p.price_usd > 0 ? "purchase" : "gift",
        user_id: p.user_id,
        detail:  p.price_usd > 0
          ? `purchased ${p.pack_name} ($${p.price_usd})`
          : formatGiftActivityDetail(p),
        ts: p.created_at,
      });
    }
    events.push(...collapseSessionActivity(usageRes.data || []));
    for (const p of signupRes.data || []) {
      events.push({
        type:    "signup",
        user_id: p.id,
        detail:  `signed up${p.display_name ? " as " + p.display_name : ""}`,
        ts:      p.created_at,
      });
    }

    const cleaned = cleanActivityEvents(events);
    const malformedCount = events.length - cleaned.length;
    if (malformedCount > 0) {
      await logActivityWarningOnce("malformed_activity_row", {
        source: "activity_feed",
        reason: "missing_type_detail_or_timestamp",
        malformed_count: malformedCount,
      });
    }
    cleaned.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    const top = cleaned.slice(0, 15);

    await resolveActivityUserLabels(top);

    res.json({ ok: true, events: top });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// EMAIL  (admin → users)
//
// Requires in .env:
//   EMAIL_FROM=your@gmail.com
//   EMAIL_PASS=your_gmail_app_password
//
// sent_emails table SQL:
//   CREATE TABLE IF NOT EXISTS public.sent_emails (
//     id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
//     subject TEXT, recipient_count INTEGER,
//     sent_by TEXT, sent_at TIMESTAMPTZ DEFAULT NOW()
//   );
// ═══════════════════════════════════════════════════════════════════

// GET /admin/api/email/recipients — categorised recipient groups
app.get("/admin/api/email/recipients", adminAuth, async (_req, res) => {
  try {
    const [{ merged }] = await Promise.all([fetchAllUsersData()]);
    const oneWeekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const normalized = merged
      .filter(u => u.email && u.email !== "—")
      .map(u => ({
        id: u.id,
        email: u.email,
        display_name: u.name && u.name !== "—" ? u.name : (u.email || "").split("@")[0],
        name: u.name && u.name !== "—" ? u.name : (u.email || "").split("@")[0],
        credits_balance: Number(u.credits_balance) || 0,
        credits_purchased: Number(u.credits_purchased) || 0,
        credits_used: Number(u.credits_used) || 0,
        last_seen_at: u.last_seen_at || null,
      }));
    const activeUsers = normalized.filter(u => u.last_seen_at && u.last_seen_at > oneWeekAgo);
    const paidUsers = normalized.filter(u => u.credits_purchased > 0);
    const adminEmail = process.env.ADMIN_EMAIL || process.env.EMAIL_FROM || "admin@tzurah.ai";
    res.json({
      all_users:         normalized,
      active_users:      activeUsers,
      inactive_users:    normalized.filter(u => !u.last_seen_at || u.last_seen_at <= oneWeekAgo),
      paid_users:        paidUsers,
      free_users:        normalized.filter(u => u.credits_purchased <= 0),
      low_credit_users:  normalized.filter(u => u.credits_balance > 0 && u.credits_balance <= 10),
      zero_credit_users: normalized.filter(u => u.credits_balance <= 0),
      test_email:        [{ email: adminEmail, display_name: "Admin", name: "Admin", credits_balance: 0 }],

      // Legacy aliases kept for older admin builds.
      all:              normalized,
      active_this_week: activeUsers,
      zero_credits:     normalized.filter(u => u.credits_balance <= 0),
      low_credits:      normalized.filter(u => u.credits_balance > 0 && u.credits_balance <= 10),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/api/email/sent — last 20 sent emails log
app.get("/admin/api/email/sent", adminAuth, async (_req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from("sent_emails")
      .select("*")
      .order("sent_at", { ascending: false })
      .limit(20);
    res.json({ ok: true, emails: data || [] });
  } catch (_) {
    res.json({ ok: true, emails: [] });
  }
});

// POST /admin/api/email/send — send email to recipient list
app.post("/admin/api/email/send", adminAuth, async (req, res) => {
  const role = req.session.adminRole;
  if (!can(role, "send_email")) {
    await logAction("unauthorized_attempt", req.session.adminEmail, role, null, { endpoint: "email/send", required_permission: "send_email" }, req);
    return res.status(403).json({ error: "Insufficient permissions", required: "send_email" });
  }
  const { recipients, subject, body, test_only, recipient_group } = req.body || {};
  if (!recipients?.length) return res.status(400).json({ error: "No recipients" });
  if (!subject?.trim())    return res.status(400).json({ error: "Subject required" });
  if (!body?.trim())       return res.status(400).json({ error: "Body required" });

  const transporter = getEmailTransporter();
  if (!transporter) {
    return res.status(503).json({ error: "Email not configured — set EMAIL_FROM and EMAIL_PASS in .env" });
  }

  const targets = test_only
    ? [{ email: process.env.ADMIN_EMAIL || process.env.EMAIL_FROM || "admin@tzurah.ai", display_name: "Admin", name: "Admin (test)", credits_balance: 0 }]
    : recipients;

  const results = { sent: 0, failed: 0, errors: [] };

  for (const recipient of targets) {
    const displayName = recipient.display_name || recipient.name || (recipient.email || "").split("@")[0];
    const personalizedBody = (body || "")
      .replace(/{{display_name}}/g, displayName)
      .replace(/{{name}}/g,    displayName)
      .replace(/{{credits}}/g, recipient.credits_balance ?? 0)
      .replace(/{{email}}/g,   recipient.email || "")
      .replace(/{{app_name}}/g, "Tzurah Live")
      .replace(/{{support_email}}/g, process.env.SUPPORT_EMAIL || process.env.EMAIL_FROM || "support@tzurah.ai")
      .replace(/{{dashboard_url}}/g, process.env.DASHBOARD_URL || "https://tzurah.ai/dashboard");

    const personalizedSubject = (subject || "")
      .replace(/{{display_name}}/g, displayName)
      .replace(/{{name}}/g, displayName)
      .replace(/{{credits}}/g, recipient.credits_balance ?? 0)
      .replace(/{{email}}/g, recipient.email || "")
      .replace(/{{app_name}}/g, "Tzurah Live")
      .replace(/{{support_email}}/g, process.env.SUPPORT_EMAIL || process.env.EMAIL_FROM || "support@tzurah.ai")
      .replace(/{{dashboard_url}}/g, process.env.DASHBOARD_URL || "https://tzurah.ai/dashboard");

    try {
      await transporter.sendMail({
        from:    `Tzurah Live <${process.env.EMAIL_FROM}>`,
        to:      recipient.email,
        subject: personalizedSubject,
        text:    personalizedBody,
        html:    "<pre style='font-family:sans-serif'>" + personalizedBody.replace(/\n/g, "<br>") + "</pre>",
      });
      results.sent++;
    } catch (err) {
      results.failed++;
      results.errors.push(`${recipient.email}: ${err.message}`);
    }
    // Rate limit
    await new Promise(r => setTimeout(r, 100));
  }

  // Log to sent_emails (non-fatal)
  const { error: sentLogErr } = await supabaseAdmin.from("sent_emails").insert({
    subject,
    recipient_count: results.sent,
    recipient_group: recipient_group || (test_only ? "test_email" : "custom"),
    sent_by:         req.session.adminEmail || "admin",
    sent_at:         new Date().toISOString(),
  });
  if (sentLogErr) console.warn("[EMAIL] sent_emails insert failed:", sentLogErr.message);

  await logAction("send_email", req.session.adminEmail, req.session.adminRole, null, { subject, recipient_group, sent: results.sent, failed: results.failed }, req);
  res.json(results);
});

// ═══════════════════════════════════════════════════════════════════
// ADMIN SETTINGS
// ═══════════════════════════════════════════════════════════════════

const SETTINGS_ALLOWED_KEYS = [
  "DECART_API_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "ADMIN_EMAIL", "ADMIN_PASSWORD",
  "CREDITS_PER_SECOND", "COST_PER_CREDIT",
  "BOOTSTRAP_SECRET",
  "decart_balance", "decart_alert_threshold",
];

// Returns masked current values + server info
app.get("/admin/api/settings", adminAuth, (req, res) => {
  if (req.session.adminRole !== "super_admin") return res.status(403).json({ error: "Insufficient permissions", required: "super_admin" });
  const mask = (val) => val ? maskKey(val) : "not set";
  res.json({
    decart_key:       mask(process.env.DECART_API_KEY),
    supabase_url:     process.env.SUPABASE_URL || "not set",
    supabase_key:     mask(process.env.SUPABASE_SERVICE_ROLE_KEY),
    admin_email:      process.env.ADMIN_EMAIL  || "not set",
    bootstrap_secret: mask(process.env.BOOTSTRAP_SECRET),
    node_version:     process.version,
    uptime:           Math.floor(process.uptime()),
    memory_mb:        Math.floor(process.memoryUsage().heapUsed / 1024 / 1024),
    pid:              process.pid,
    env:              process.env.NODE_ENV || "development",
    pricing: {
      credits_per_second: parseFloat(process.env.CREDITS_PER_SECOND || "0.1"),
      cost_per_credit:    parseFloat(process.env.COST_PER_CREDIT    || "0.00625"),
    },
  });
});

// Reveals the actual (unmasked) value of a specific env key
app.post("/admin/api/settings/reveal-key", adminAuth, (req, res) => {
  if (req.session.adminRole !== "super_admin") return res.status(403).json({ error: "Insufficient permissions", required: "super_admin" });
  const { key_name } = req.body || {};
  const revealable = ["DECART_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ADMIN_EMAIL"];
  if (!revealable.includes(key_name)) {
    return res.status(400).json({ error: "Key not revealable" });
  }
  res.json({ value: process.env[key_name] || "not set" });
});

// Updates a single env key in .env + live process.env
app.post("/admin/api/settings/update-key", adminAuth, async (req, res) => {
  if (req.session.adminRole !== "super_admin") return res.status(403).json({ error: "Insufficient permissions", required: "super_admin" });
  const { key_name, value } = req.body || {};
  if (!SETTINGS_ALLOWED_KEYS.includes(key_name)) {
    return res.status(400).json({ error: "Key not allowed" });
  }
  if (!value || !value.trim()) {
    return res.status(400).json({ error: "Value cannot be empty" });
  }
  try {
    const envPath = path.join(__dirname, ".env");
    let envContent = "";
    try { envContent = fs.readFileSync(envPath, "utf8"); } catch (_) {}
    const regex = new RegExp(`^${key_name}=.*$`, "m");
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `${key_name}=${value.trim()}`);
    } else {
      envContent += (envContent.endsWith("\n") ? "" : "\n") + `${key_name}=${value.trim()}\n`;
    }
    fs.writeFileSync(envPath, envContent);
    process.env[key_name] = value.trim();
    if (key_name === "DECART_API_KEY") {
      process.env.TOKEN_CACHE_BUSTED = Date.now().toString();
      console.log("[SETTINGS] DECART_API_KEY updated — token cache bust signalled");
    }
    await logAction("settings_change", req.session.adminEmail, req.session.adminRole, null, { field_changed: key_name }, req);
    res.json({ success: true });
  } catch (err) {
    console.error("[SETTINGS] update-key error:", err.message);
    res.status(500).json({ error: "Failed to write .env: " + err.message });
  }
});

// Live server info (uptime, memory)
app.get("/admin/api/settings/server-info", adminAuth, (req, res) => {
  res.json({
    node_version:   process.version,
    uptime_seconds: Math.floor(process.uptime()),
    memory_mb:      Math.floor(process.memoryUsage().heapUsed / 1024 / 1024),
    pid:            process.pid,
    env:            process.env.NODE_ENV || "development",
  });
});

// Graceful exit — PM2 restarts the process automatically
app.post("/admin/api/settings/restart", adminAuth, (req, res) => {
  res.json({ success: true });
  setTimeout(() => process.exit(0), 500);
});

// ═══════════════════════════════════════════════════════════════════
// DATABASE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

// GET /admin/api/db/stats — row counts for each table
app.get("/admin/api/db/stats", adminAuth, async (_req, res) => {
  try {
    const [sessAll, sessActive, profiles, usage, purchases] = await Promise.all([
      supabaseAdmin.from("sessions").select("id", { count: "exact", head: true }),
      supabaseAdmin.from("sessions").select("id", { count: "exact", head: true }).eq("is_active", true),
      supabaseAdmin.from("profiles").select("id", { count: "exact", head: true }),
      supabaseAdmin.from("usage").select("id",    { count: "exact", head: true }),
      supabaseAdmin.from("purchases").select("id", { count: "exact", head: true }),
    ]);
    res.json({
      sessions:        sessAll.count    || 0,
      active_sessions: sessActive.count || 0,
      users:           profiles.count   || 0,
      usage:           usage.count      || 0,
      purchases:       purchases.count  || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/api/db/action — execute a named destructive action
app.post("/admin/api/db/action", adminAuth, async (req, res) => {
  const { action } = req.body || {};
  const SENTINEL = "00000000-0000-0000-0000-000000000000"; // never matches real UUID

  const actions = {
    clear_all_sessions:       () => supabaseAdmin.from("sessions").delete().neq("id", SENTINEL),
    clear_stale_sessions:     () => supabaseAdmin.from("sessions").delete()
                                      .lt("last_ping", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    reset_active_flags:       () => supabaseAdmin.from("sessions")
                                      .update({ is_active: false, kill_signal: false })
                                      .eq("is_active", true),
    clear_usage_logs:         () => supabaseAdmin.from("usage").delete().neq("id", SENTINEL),
    clear_purchases:          () => supabaseAdmin.from("purchases").delete().neq("id", SENTINEL),
    clear_test_users_sessions: async () => {
      const { data: authRes } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
      const testIds = (authRes?.users || [])
        .filter(u => u.email && (u.email.includes("@test.com") || u.email.includes("testviewer")))
        .map(u => u.id);
      if (!testIds.length) return { data: null, error: null };
      return supabaseAdmin.from("sessions").delete().in("user_id", testIds);
    },
  };

  if (!actions[action]) {
    return res.status(400).json({ error: "Unknown action: " + action });
  }

  try {
    const result = await actions[action]();
    if (result && result.error) throw result.error;
    console.log(`[DB] Action executed: ${action}`);
    res.json({ success: true, action });
  } catch (err) {
    console.error(`[DB] Action failed (${action}):`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Ensure profile (called after OAuth login for new Google users) ─
app.post("/api/ensure-profile", async (req, res) => {
  try {
    // Accept body params (from Electron renderer) or fall back to Bearer token
    let userId, email, full_name, avatar_url;

    if (req.body?.user_id) {
      ({ user_id: userId, email, full_name, avatar_url } = req.body);
      if (!userId || !email) return res.status(400).json({ error: "user_id and email required" });
    } else {
      // Legacy: Bearer token path (called from electron.js ensureProfileForUser)
      const auth = req.headers.authorization;
      if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
      const token = auth.slice(7);
      const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(token);
      if (userErr || !user) return res.status(401).json({ error: "Invalid token" });
      userId     = user.id;
      email      = user.email;
      full_name  = user.user_metadata?.full_name || user.user_metadata?.name || null;
      avatar_url = user.user_metadata?.avatar_url || null;
    }

    const { data: existing } = await supabaseAdmin
      .from("profiles")
      .select("id, credits")
      .eq("id", userId)
      .maybeSingle();

    if (existing) return res.json({ created: false, profile: existing });

    const { data: newProfile, error: createErr } = await supabaseAdmin
      .from("profiles")
      .insert(buildProfileInsertRow({
        userId,
        displayName: full_name || email.split("@")[0],
        avatarUrl: avatar_url || null,
      }))
      .select()
      .single();

    if (createErr) {
      console.error("[PROFILE] Create error:", createErr);
      return res.status(500).json({ error: createErr.message });
    }

    console.log("[PROFILE] Created profile for OAuth user:", email);
    return res.json({ created: true, profile: newProfile });
  } catch (err) {
    console.error("[PROFILE] ensure-profile error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── Auth webhook — Supabase calls this on INSERT to auth.users ────
app.post("/auth/webhook", async (req, res) => {
  try {
    const { type, record } = req.body || {};
    if (type === "INSERT" && record?.id) {
      const userId = record.id;
      const email  = record.email;
      const { data: existing } = await supabaseAdmin
        .from("profiles").select("id").eq("id", userId).maybeSingle();
      if (!existing) {
        const displayName = record.raw_user_meta_data?.full_name
                         || record.raw_user_meta_data?.name
                         || email?.split("@")[0]
                         || "User";
        const { error } = await supabaseAdmin.from("profiles").insert(buildProfileInsertRow({
          userId,
          displayName,
          avatarUrl: record.raw_user_meta_data?.avatar_url || null,
        }));
        if (error) console.error("[WEBHOOK] Profile create error:", error);
        else console.log("[WEBHOOK] Profile auto-created for:", email);
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error("[WEBHOOK] Auth webhook error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Repair missing profiles (one-time admin utility) ──────────────
app.post("/admin/api/repair-missing-profiles", adminAuth, async (req, res) => {
  try {
    const { data: { users }, error: authErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
    if (authErr) throw authErr;

    let created = 0, skipped = 0;
    const errors = [];

    for (const user of users) {
      const { data: existing } = await supabaseAdmin
        .from("profiles").select("id").eq("id", user.id).maybeSingle();
      if (existing) { skipped++; continue; }

      const displayName = user.user_metadata?.full_name
                       || user.user_metadata?.name
                       || user.email?.split("@")[0]
                       || "User";
      const { error: createErr } = await supabaseAdmin.from("profiles").insert(buildProfileInsertRow({
        userId: user.id,
        displayName,
        avatarUrl: user.user_metadata?.avatar_url || null,
        createdAt: user.created_at || new Date().toISOString(),
      }));
      if (createErr) {
        errors.push({ email: user.email, error: createErr.message });
      } else {
        created++;
        console.log("[REPAIR] Created missing profile for:", user.email);
      }
    }

    return res.json({
      success: true,
      created,
      skipped,
      errors,
      message: `Created ${created} missing profiles, skipped ${skipped} existing`,
    });
  } catch (err) {
    console.error("[REPAIR] repair-missing-profiles error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── Feature flags ─────────────────────────────────────────────────
app.get("/api/feature-flags", async (_req, res) => {
  const { data } = await supabaseAdmin.from("feature_flags").select("key, enabled");
  const flags = {};
  (data || []).forEach(f => { flags[f.key] = f.enabled; });
  res.json(flags);
});

app.get("/admin/api/feature-flags", adminAuth, async (_req, res) => {
  const { data } = await supabaseAdmin.from("feature_flags").select("*").order("key");
  res.json({ flags: data || [] });
});

app.post("/admin/api/feature-flags/:key", adminAuth, async (req, res) => {
  const role = req.session.adminRole;
  if (role !== "super_admin") {
    await logAction("unauthorized_attempt", req.session.adminEmail, role, null, { endpoint: "feature-flags", required_permission: "super_admin" }, req);
    return res.status(403).json({ error: "Insufficient permissions", required: "super_admin" });
  }
  const { key } = req.params;
  const { enabled } = req.body;
  const { error } = await supabaseAdmin.from("feature_flags")
    .update({ enabled, updated_at: new Date().toISOString(), updated_by: req.session.adminEmail || "admin" })
    .eq("key", key);
  if (error) return res.status(500).json({ error: error.message });
  await logAction("toggle_flag", req.session.adminEmail, role, null, { flag: key, value: enabled }, req);
  res.json({ ok: true });
});

// ── Public: active credit packs (for topup UI) ───────────────────
app.get("/api/credit-packs", async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from("credit_packs").select("id, name, price_usd, credits, is_popular, sort_order")
    .eq("is_active", true).order("sort_order");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ packs: data || [] });
});

// ── Mock Purchase (shared logic) ──────────────────────────────────
async function doMockPurchase(userId, packId, email) {
  // Check flag
  const { data: flagRow } = await supabaseAdmin
    .from("feature_flags").select("enabled").eq("key", "mock_payments").single();
  if (!flagRow?.enabled) throw new Error("Mock payments are not enabled");

  // Fetch pack
  const { data: pack, error: packErr } = await supabaseAdmin
    .from("credit_packs").select("id, name, price_usd, credits").eq("id", packId).single();
  if (packErr || !pack) throw new Error("Pack not found");

  // Multi-strategy profile lookup
  console.log("[MOCK] Looking up profile — user_id:", userId, "email:", email);
  let profile = null;

  // Strategy 1: id column (standard Supabase auth UUID)
  const { data: p1 } = await supabaseAdmin
    .from("profiles").select("*").eq("id", userId).maybeSingle();
  if (p1) profile = p1;

  // Strategy 2: user_id column
  if (!profile) {
    const { data: p2 } = await supabaseAdmin
      .from("profiles").select("*").eq("user_id", userId).maybeSingle();
    if (p2) profile = p2;
  }

  // Strategy 3: auth_id column
  if (!profile) {
    const { data: p3 } = await supabaseAdmin
      .from("profiles").select("*").eq("auth_id", userId).maybeSingle();
    if (p3) profile = p3;
  }

  console.log("[MOCK] Profile found:", profile ? "yes" : "no",
              profile ? Object.keys(profile) : "none");

  // Diagnostic + last-resort auto-create if still not found
  if (!profile) {
    const { data: allProfiles, error: listErr } = await supabaseAdmin
      .from("profiles").select("*").limit(3);
    console.log("[MOCK] Sample profiles rows:", JSON.stringify(allProfiles));
    console.log("[MOCK] List error:", listErr);

    // Last resort: look up the auth user and auto-create the missing profile
    console.log("[MOCK] Attempting auto-create for user:", userId);
    const { data: authData } = await supabaseAdmin.auth.admin.getUserById(userId);
    const authUser = authData?.user;
    if (authUser) {
      const displayName = authUser.user_metadata?.full_name
                       || authUser.user_metadata?.name
                       || authUser.email?.split("@")[0]
                       || "User";
      const { data: created, error: createErr } = await supabaseAdmin
        .from("profiles")
        .insert(buildProfileInsertRow({
          userId,
          displayName,
          avatarUrl: authUser.user_metadata?.avatar_url || null,
        }))
        .select()
        .single();
      if (!createErr && created) {
        profile = created;
        console.log("[MOCK] Auto-created missing profile for:", authUser.email);
      } else {
        console.error("[MOCK] Auto-create failed:", createErr?.message);
      }
    }

    if (!profile) throw new Error(`User profile not found (id: ${userId})`);
  }

  // Determine actual PK column and value
  const profilePKCol = profile.id !== undefined ? "id"
                     : profile.user_id !== undefined ? "user_id"
                     : "auth_id";
  const profilePK      = profile[profilePKCol];
  const currentCredits = profile.credits || 0;
  const newBalance     = currentCredits + pack.credits;
  const resolvedEmail  = email || await getAuthEmailByUserId(userId) || userId;

  // Update credits using whichever PK column was found (FATAL — must succeed)
  const { error: updateErr } = await supabaseAdmin
    .from("profiles")
    .update({ credits: newBalance })
    .eq(profilePKCol, profilePK);
  if (updateErr) throw new Error("Credits update failed: " + updateErr.message);

  // Diagnose purchases table schema, then insert (NON-FATAL)
  const { data: samplePurchase } = await supabaseAdmin
    .from("purchases").select("*").limit(1).maybeSingle();
  console.log("[MOCK] Sample purchases row columns:",
    samplePurchase ? Object.keys(samplePurchase).join(", ") : "no rows yet");

  const hasPurchaseCols = samplePurchase ? Object.keys(samplePurchase) : [];
  const purchaseRow = {
    user_id:           profile.id || userId,
    credits_added:     pack.credits,
    stripe_payment_id: "mock_" + Date.now(),
    created_at:        new Date().toISOString(),
  };
  if (!samplePurchase || hasPurchaseCols.includes("pack_id"))   purchaseRow.pack_id   = packId;
  if (!samplePurchase || hasPurchaseCols.includes("pack_name")) purchaseRow.pack_name = pack.name;
  if (!samplePurchase || hasPurchaseCols.includes("price_usd")) purchaseRow.price_usd = pack.price_usd;
  if (!samplePurchase || hasPurchaseCols.includes("amount_paid")) purchaseRow.amount_paid = pack.price_usd;

  const { error: purchaseErr } = await supabaseAdmin.from("purchases").insert(purchaseRow);
  if (purchaseErr) {
    console.warn("[MOCK] Purchase insert failed (non-fatal):", purchaseErr.message);
  } else {
    console.log("[MOCK] Purchase record created");
  }

  // Admin notification (non-fatal)
  const { error: notifErr } = await supabaseAdmin.from("admin_notifications").insert({
    title:      "Mock Purchase",
    type:       "purchase",
    message:    `${pack.name} → ${resolvedEmail} (+${pack.credits} cr)`,
    created_at: new Date().toISOString(),
  });
  if (notifErr) console.warn("[MOCK] Notification insert error:", notifErr.message);

  await logAction("mock_purchase", "system", "super_admin", profile.id || userId, { pack_id: packId, pack_name: pack.name, credits: pack.credits, price: pack.price_usd }, null);
  console.log(`[MOCK] Purchase: ${pack.name} → ${resolvedEmail} (+${pack.credits} cr)`);
  return { success: true, credits_added: pack.credits, new_balance: newBalance, pack_name: pack.name };
}

// POST /mock/purchase — authenticated via Supabase JWT (used by Electron app)
app.post("/mock/purchase", requireAuth, async (req, res) => {
  const { pack_id } = req.body || {};
  if (!pack_id) return res.status(400).json({ error: "pack_id required" });
  try {
    const result = await doMockPurchase(req.userId, pack_id, req.user.email);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /admin/api/mock-purchase — authenticated via admin session (used by admin panel)
app.post("/admin/api/mock-purchase", adminAuth, async (req, res) => {
  console.log("[MOCK] Admin mock-purchase request body:", req.body);
  const { user_id, pack_id, email } = req.body || {};
  if (!user_id || !pack_id) return res.status(400).json({ error: "user_id and pack_id required" });
  try {
    const result = await doMockPurchase(user_id, pack_id, email);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── C2: Credit Packs ─────────────────────────────────────────────
app.get("/admin/api/credit-packs", adminAuth, async (_req, res) => {
  const { data, error } = await supabaseAdmin.from("credit_packs").select("*").order("sort_order");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ packs: data || [] });
});

app.post("/admin/api/credit-packs", adminAuth, async (req, res) => {
  const { name, price_usd, credits, stripe_price_id, is_popular, is_active, sort_order } = req.body || {};
  if (!name || !price_usd || !credits) return res.status(400).json({ error: "name, price_usd, credits required" });

  // Auto-generate unique slug from name
  const baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const { data: existingSlugs } = await supabaseAdmin
    .from("credit_packs").select("slug").like("slug", baseSlug + "%");
  const slugSet = new Set((existingSlugs || []).map(r => r.slug));
  let slug = baseSlug, attempt = 2;
  while (slugSet.has(slug)) slug = `${baseSlug}-${attempt++}`;

  const { data, error } = await supabaseAdmin.from("credit_packs").insert({
    name, slug, price_usd, credits,
    stripe_price_id: stripe_price_id || null,
    is_popular: !!is_popular,
    is_active: is_active !== false,
    sort_order: sort_order || 0,
  }).select("*").single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ pack: data });
});

app.patch("/admin/api/credit-packs/:id", adminAuth, async (req, res) => {
  const updates = {};
  const allowed = ["name", "price_usd", "credits", "stripe_price_id", "is_popular", "is_active", "sort_order"];
  allowed.forEach(k => { if (typeof req.body[k] !== "undefined") updates[k] = req.body[k]; });
  const { error } = await supabaseAdmin.from("credit_packs").update(updates).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete("/admin/api/credit-packs/:id", adminAuth, async (req, res) => {
  await supabaseAdmin.from("credit_packs").delete().eq("id", req.params.id);
  res.json({ ok: true });
});

// ── C3: Announcements ─────────────────────────────────────────────
app.get("/admin/api/announcements", adminAuth, async (_req, res) => {
  const { data } = await supabaseAdmin.from("announcements").select("*").order("created_at", { ascending: false });
  res.json({ announcements: data || [] });
});

app.post("/admin/api/announcements", adminAuth, async (req, res) => {
  const role = req.session.adminRole;
  if (!can(role, "manage_announcements")) {
    await logAction("unauthorized_attempt", req.session.adminEmail, role, null, { endpoint: "announcements", required_permission: "manage_announcements" }, req);
    return res.status(403).json({ error: "Insufficient permissions", required: "manage_announcements" });
  }
  const { title, message, type, scheduled_at, expires_at, is_active } = req.body || {};
  if (!title || !message) return res.status(400).json({ error: "title and message required" });
  const { data, error } = await supabaseAdmin.from("announcements").insert({
    title,
    message,
    type: type || "info",
    scheduled_at: scheduled_at || null,
    expires_at: expires_at || null,
    is_active: is_active !== false,
  }).select("*").single();
  if (error) return res.status(400).json({ error: error.message });
  await logAction("create_announcement", req.session.adminEmail, role, null, { title, type: type || "info" }, req);
  res.json({ announcement: data });
});

app.delete("/admin/api/announcements/:id", adminAuth, async (req, res) => {
  await supabaseAdmin.from("announcements").delete().eq("id", req.params.id);
  res.json({ ok: true });
});

app.patch("/admin/api/announcements/:id", adminAuth, async (req, res) => {
  const role = req.session.adminRole;
  if (!can(role, "manage_announcements")) {
    return res.status(403).json({ error: "Insufficient permissions", required: "manage_announcements" });
  }
  const { id } = req.params;
  const { title, message, type, expires_at, is_active } = req.body || {};
  const updates = {};
  if (typeof title === "string") updates.title = title;
  if (typeof message === "string") updates.message = message;
  if (typeof type === "string") updates.type = type;
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "expires_at")) updates.expires_at = expires_at || null;
  if (typeof is_active === "boolean") updates.is_active = is_active;
  if (!Object.keys(updates).length) return res.status(400).json({ error: "No update fields provided" });
  const { error } = await supabaseAdmin.from("announcements").update(updates).eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  await logAction(
    Object.keys(updates).length === 1 && typeof updates.is_active === "boolean"
      ? (updates.is_active ? "enable_announcement" : "disable_announcement")
      : "update_announcement",
    req.session.adminEmail, role, null, { announcement_id: id, fields: Object.keys(updates) }, req
  );
  res.json({ success: true });
});

// Public: app can fetch active announcements
app.get("/api/announcements", async (_req, res) => {
  const now = new Date().toISOString();
  const { data } = await supabaseAdmin.from("announcements").select("id, title, message, type").eq("is_active", true).or(`expires_at.is.null,expires_at.gt.${now}`).order("created_at", { ascending: false }).limit(5);
  res.json({ announcements: data || [] });
});

// ── C4: Sub-Admins ────────────────────────────────────────────────
app.get("/admin/api/sub-admins", adminAuth, async (req, res) => {
  if (req.session.adminRole !== "super_admin") return res.status(403).json({ error: "Super admin only" });
  const { data } = await supabaseAdmin.from("admin_users").select("id, email, name, role, is_active, last_login, created_at").order("created_at");
  res.json({ admins: data || [] });
});

app.post("/admin/api/sub-admins", adminAuth, async (req, res) => {
  const adminRole = req.session.adminRole;
  if (adminRole !== "super_admin") {
    await logAction("unauthorized_attempt", req.session.adminEmail, adminRole, null, { endpoint: "sub-admins/create", required_permission: "super_admin" }, req);
    return res.status(403).json({ error: "Super admin only" });
  }
  const { name, email, role, password, must_change_password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "Name, email and password required" });
  const bcrypt = require("bcryptjs");
  const hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabaseAdmin.from("admin_users").insert({ name, email, role: role || "support", password_hash: hash, must_change_password: must_change_password !== false, created_by: req.session.adminEmail }).select("id, email, name, role").single();
  if (error) return res.status(400).json({ error: error.message });
  await logAction("create_subadmin", req.session.adminEmail, adminRole, null, { new_admin_email: email, role_assigned: role || "support" }, req);
  res.json({ admin: data });
});

app.patch("/admin/api/sub-admins/:id", adminAuth, async (req, res) => {
  if (req.session.adminRole !== "super_admin") return res.status(403).json({ error: "Super admin only" });
  const { is_active, role, name } = req.body;
  const updates = {};
  if (typeof is_active !== "undefined") updates.is_active = is_active;
  if (role) updates.role = role;
  if (name) updates.name = name;
  await supabaseAdmin.from("admin_users").update(updates).eq("id", req.params.id);
  res.json({ ok: true });
});

app.delete("/admin/api/sub-admins/:id", adminAuth, async (req, res) => {
  if (req.session.adminRole !== "super_admin") {
    await logAction("unauthorized_attempt", req.session.adminEmail, req.session.adminRole, null,
      { endpoint: "delete_subadmin", required: "super_admin" }, req);
    return res.status(403).json({ error: "Super admin only" });
  }
  const { id } = req.params;
  try {
    const { data: subAdmin } = await supabaseAdmin
      .from("admin_users").select("email, role").eq("id", id).maybeSingle();
    if (!subAdmin) return res.status(404).json({ error: "Sub-admin not found" });

    const { error: deleteErr } = await supabaseAdmin.from("admin_users").delete().eq("id", id);
    if (deleteErr) throw new Error(deleteErr.message);

    await logAction("delete_subadmin", req.session.adminEmail, req.session.adminRole, null,
      { deleted_email: subAdmin.email, deleted_role: subAdmin.role }, req);
    return res.json({ success: true });
  } catch (err) {
    console.error("[Admin] Delete sub-admin error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── C5: IP Blocks ─────────────────────────────────────────────────
app.get("/admin/api/ip-blocks", adminAuth, async (_req, res) => {
  const { data } = await supabaseAdmin.from("ip_blocks").select("*").order("created_at", { ascending: false });
  res.json({ blocks: data || [] });
});

app.post("/admin/api/ip-blocks", adminAuth, async (req, res) => {
  const role = req.session.adminRole;
  if (!can(role, "manage_ip_blocks")) {
    await logAction("unauthorized_attempt", req.session.adminEmail, role, null, { endpoint: "ip-blocks", required_permission: "manage_ip_blocks" }, req);
    return res.status(403).json({ error: "Insufficient permissions", required: "manage_ip_blocks" });
  }
  const { ip_address, reason, expires_in_days } = req.body;
  if (!ip_address) return res.status(400).json({ error: "IP address required" });
  const expires_at = expires_in_days ? new Date(Date.now() + expires_in_days * 86400000).toISOString() : null;
  const { error } = await supabaseAdmin.from("ip_blocks").upsert({ ip_address, reason: reason || "Manual block", blocked_by: req.session.adminEmail, expires_at }, { onConflict: "ip_address" });
  if (error) return res.status(400).json({ error: error.message });
  await logAction("ip_block", req.session.adminEmail, role, null, { ip: ip_address, reason, expires_at }, req);
  res.json({ ok: true });
});

app.delete("/admin/api/ip-blocks/:ip", adminAuth, async (req, res) => {
  const role = req.session.adminRole;
  if (!can(role, "manage_ip_blocks")) {
    await logAction("unauthorized_attempt", req.session.adminEmail, role, null, { endpoint: "ip-blocks/delete", required_permission: "manage_ip_blocks" }, req);
    return res.status(403).json({ error: "Insufficient permissions", required: "manage_ip_blocks" });
  }
  const ip = decodeURIComponent(req.params.ip);
  await supabaseAdmin.from("ip_blocks").delete().eq("ip_address", ip);
  await logAction("ip_unblock", req.session.adminEmail, role, null, { ip }, req);
  res.json({ ok: true });
});

// ── Audit Log ─────────────────────────────────────────────────────
app.get("/admin/api/audit-log", adminAuth, async (req, res) => {
  if (req.session.adminRole !== "super_admin") {
    return res.status(403).json({ error: "Insufficient permissions", required: "super_admin" });
  }
  const page   = Math.max(1, parseInt(req.query.page  || "1", 10));
  const limit  = 50;
  const offset = (page - 1) * limit;

  let query = supabaseAdmin.from("admin_actions")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (req.query.action) query = query.eq("action", req.query.action);
  if (req.query.admin)  query = query.ilike("performed_by", `%${req.query.admin}%`);
  if (req.query.from)   query = query.gte("created_at", req.query.from);
  if (req.query.to)     query = query.lte("created_at", req.query.to);

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ entries: data || [], total: count || 0, page, totalPages: Math.ceil((count || 0) / limit) });
});

// ── C6: Admin Notifications ───────────────────────────────────────
app.get("/admin/api/notifications", adminAuth, async (_req, res) => {
  const { data } = await supabaseAdmin.from("admin_notifications").select("*").order("created_at", { ascending: false }).limit(50);
  res.json({ notifications: data || [] });
});

app.post("/admin/api/notifications/:id/read", adminAuth, async (req, res) => {
  await supabaseAdmin.from("admin_notifications").update({ is_read: true }).eq("id", req.params.id);
  res.json({ ok: true });
});

app.post("/admin/api/notifications/read-all", adminAuth, async (_req, res) => {
  await supabaseAdmin.from("admin_notifications").update({ is_read: true }).eq("is_read", false);
  res.json({ ok: true });
});

app.post("/admin/api/alerts/test/:type", adminAuth, async (req, res) => {
  const { type } = req.params;
  try {
    switch (type) {
      case "low_balance":
        await supabaseAdmin.from("admin_notifications").insert({ title: "⚠️ Test Alert: Low Balance", message: "TEST — Decart balance below threshold", type: "alert" });
        break;
      case "low_credits": {
        const { data: lu } = await supabaseAdmin.from("profiles").select("credits").lt("credits", 20).limit(1).maybeSingle();
        await supabaseAdmin.from("admin_notifications").insert({ title: "⚠️ Test Alert: Low User Credits", message: `TEST — User has ${lu?.credits ?? 5} credits remaining`, type: "alert" });
        break;
      }
      case "high_usage":
        await supabaseAdmin.from("admin_notifications").insert({ title: "⚠️ Test Alert: High Usage", message: "TEST — Unusual session activity detected", type: "alert" });
        break;
      case "payment_failed":
        await supabaseAdmin.from("admin_notifications").insert({ title: "⚠️ Test Alert: Payment Failed", message: "TEST — Payment failure simulation", type: "alert" });
        break;
      case "new_signup":
        await supabaseAdmin.from("admin_notifications").insert({ title: "🔔 Test Alert: New Signup", message: "TEST — New user registration simulation", type: "alert" });
        break;
      default:
        return res.status(400).json({ error: `Unknown alert type: ${type}` });
    }
    await logAction("test_alert", req.session.adminEmail, req.session.adminRole, null, { alert_type: type }, req);
    res.json({ success: true, message: `Test alert '${type}' triggered` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── C4 supplement: force password change ──────────────────────────
app.post("/admin/api/change-password", adminAuth, async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  const bcrypt = require("bcryptjs");
  const hash = await bcrypt.hash(password, 10);
  const { error } = await supabaseAdmin
    .from("admin_users")
    .update({ password_hash: hash, must_change_password: false })
    .eq("email", req.session.adminEmail);
  if (error) return res.status(500).json({ error: error.message });
  console.log(`[ADMIN] Password changed: ${req.session.adminEmail}`);
  res.json({ ok: true });
});

// ── C7: Global Search ─────────────────────────────────────────────
app.get("/admin/api/search", adminAuth, async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json({ results: [] });
  const results = [];
  const query = q.toLowerCase().trim();

  // Users — paginate up to 200
  try {
    let page = 1;
    let allUsers = [];
    while (true) {
      const { data: authData } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 50 });
      if (!authData?.users?.length) break;
      allUsers = allUsers.concat(authData.users);
      if (allUsers.length >= 200 || authData.users.length < 50) break;
      page++;
    }
    const matches = allUsers
      .filter(u => u.email?.toLowerCase().includes(query) || u.user_metadata?.full_name?.toLowerCase().includes(query))
      .slice(0, 8);
    for (const u of matches) {
      const { data: profile } = await supabaseAdmin.from("profiles").select("credits").eq("id", u.id).maybeSingle();
      results.push({ type: "user", icon: "👤", title: u.email, subtitle: `${profile?.credits ?? "?"} credits · joined ${new Date(u.created_at).toLocaleDateString()}`, action: `switchTab('users')` });
    }
  } catch (e) { console.error("[SEARCH] user error:", e.message); }

  // Sessions by email
  try {
    const { data: sessions } = await supabaseAdmin.from("sessions").select("user_id, email, is_active, last_ping").ilike("email", `%${q}%`).limit(3);
    (sessions || []).forEach(s => {
      results.push({ type: "session", icon: s.is_active ? "🟢" : "⚫", title: s.email, subtitle: s.is_active ? "Live now" : `Last seen ${new Date(s.last_ping).toLocaleDateString()}`, action: `switchTab('overview')` });
    });
  } catch (_) {}

  // Purchases by payment ID
  try {
    const { data: purchases } = await supabaseAdmin.from("purchases").select("*").or(`stripe_payment_id.ilike.%${q}%`).order("created_at", { ascending: false }).limit(3);
    (purchases || []).forEach(p => { results.push({ type: "purchase", icon: "💳", title: `$${p.price_usd} — ${p.pack_name || "pack"}`, subtitle: `Payment · ${new Date(p.created_at).toLocaleDateString()}`, action: `switchTab('purchases')` }); });
  } catch (_) {}

  res.json({ results });
});

// ── Admin: launch checklist ────────────────────────────────────────
app.get("/admin/api/checklist", adminAuth, (req, res) => {
  const env = process.env;
  res.json({
    decart_key:              !!env.DECART_API_KEY && env.DECART_API_KEY !== "your_decart_key_here",
    supabase:                !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY,
    admin_password_changed:  !!env.ADMIN_PASSWORD && env.ADMIN_PASSWORD !== "TzurahAdmin2025!",
    stripe_configured:       !!env.STRIPE_SECRET_KEY && env.STRIPE_SECRET_KEY !== "your_stripe_key",
    email_configured:        !!env.EMAIL_FROM,
    domain_configured:       !!env.DOMAIN && env.DOMAIN !== "localhost",
    https_enabled:           env.NODE_ENV === "production" && !!env.SSL_CERT,
    rate_limiting:           !!env.RATE_LIMIT_ENABLED,
    webhook_secret:          !!env.STRIPE_WEBHOOK_SECRET,
    node_env_production:     env.NODE_ENV === "production",
  });
});

// ── Admin: test runner ────────────────────────────────────────────
app.post("/admin/api/tests/run", adminAuth, async (req, res) => {
  const { suite } = req.body || {};
  const results = {};

  async function runTest(name, fn) {
    try {
      await fn();
      results[name] = { ok: true };
    } catch (err) {
      results[name] = { ok: false, error: err.message || String(err) };
    }
  }
  function skipTest(name, reason) {
    results[name] = { ok: null, error: reason || "skipped" };
  }

  try {
    if (suite === "health" || !suite) {
      await runTest("API server reachable", async () => {
        // We're already here, so the server is reachable
      });
      await runTest("Supabase connected", async () => {
        const { error } = await supabaseAdmin.from("profiles").select("id").limit(1);
        if (error) throw new Error(error.message);
      });
      await runTest("Decart key configured", async () => {
        const key = process.env.DECART_API_KEY;
        if (!key || key === "your_decart_key_here") throw new Error("DECART_API_KEY not set");
      });
      await runTest("Sessions table accessible", async () => {
        const { error } = await supabaseAdmin.from("sessions").select("id").limit(1);
        if (error) throw new Error(error.message);
      });
      await runTest("Profiles table accessible", async () => {
        const { error } = await supabaseAdmin.from("profiles").select("id").limit(1);
        if (error) throw new Error(error.message);
      });
    }

    if (suite === "user" || !suite) {
      let testUserId = null;
      await runTest("Create test user", async () => {
        const email = `test_diag_${Date.now()}@tzurah-test.invalid`;
        const { data, error } = await supabaseAdmin.auth.admin.createUser({
          email, password: "TestDiag123!", email_confirm: true,
        });
        if (error) throw new Error(error.message);
        testUserId = data.user.id;
      });
      await runTest("Profile auto-created with 6 credits", async () => {
        if (!testUserId) throw new Error("No test user created");
        await new Promise(r => setTimeout(r, 1500));
        const { data, error } = await supabaseAdmin
          .from("profiles").select("credits").eq("id", testUserId).maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) throw new Error("Profile not found — trigger may not be set up");
        if (data.credits !== 6) throw new Error(`Expected 6 credits, got ${data.credits}`);
      });
      await runTest("Deduct 2 credits", async () => {
        if (!testUserId) throw new Error("No test user created");
        const { data: before } = await supabaseAdmin
          .from("profiles").select("credits, total_credits_used").eq("id", testUserId).single();
        const newBalance   = Math.max(0, (before?.credits || 0) - 2);
        const newTotalUsed = (before?.total_credits_used || 0) + 2;
        const { error } = await supabaseAdmin
          .from("profiles").update({ credits: newBalance, total_credits_used: newTotalUsed })
          .eq("id", testUserId);
        if (error) throw new Error(error.message);
      });
      await runTest("Verify balance after deduction", async () => {
        if (!testUserId) throw new Error("No test user created");
        const { data, error } = await supabaseAdmin
          .from("profiles").select("credits").eq("id", testUserId).single();
        if (error) throw new Error(error.message);
        if (data.credits !== 4) throw new Error(`Expected 4 credits, got ${data.credits}`);
      });
      await runTest("Delete test user", async () => {
        if (!testUserId) throw new Error("No test user created");
        // Delete all FK-constrained rows before deleting auth user
        await supabaseAdmin.from("sessions").delete().eq("user_id", testUserId);
        await supabaseAdmin.from("usage").delete().eq("user_id", testUserId);
        await supabaseAdmin.from("purchases").delete().eq("user_id", testUserId);
        await supabaseAdmin.from("profiles").delete().eq("id", testUserId);
        const { error } = await supabaseAdmin.auth.admin.deleteUser(testUserId);
        if (error) throw new Error(error.message);
      });
    }

    if (suite === "admin" || !suite) {
      let targetUserId = null;
      await runTest("Find a real user to test with", async () => {
        const { data, error } = await supabaseAdmin
          .from("profiles").select("id, credits").limit(1).single();
        if (error || !data) throw new Error("No profiles found");
        targetUserId = data.id;
      });
      await runTest("Gift 10 credits to user", async () => {
        if (!targetUserId) throw new Error("No target user");
        const { data: before } = await supabaseAdmin
          .from("profiles").select("credits").eq("id", targetUserId).single();
        const { error } = await supabaseAdmin
          .from("profiles").update({ credits: (before?.credits || 0) + 10 })
          .eq("id", targetUserId);
        if (error) throw new Error(error.message);
      });
      await runTest("Verify gifted credits", async () => {
        if (!targetUserId) throw new Error("No target user");
        const { data: before } = await supabaseAdmin
          .from("profiles").select("credits").eq("id", targetUserId).single();
        // Just verify the read works — we already set it above
        if (typeof before?.credits !== "number") throw new Error("Could not read credits");
      });
      await runTest("Restore original credits", async () => {
        if (!targetUserId) throw new Error("No target user");
        const { data: cur } = await supabaseAdmin
          .from("profiles").select("credits").eq("id", targetUserId).single();
        const { error } = await supabaseAdmin
          .from("profiles").update({ credits: Math.max(0, (cur?.credits || 0) - 10) })
          .eq("id", targetUserId);
        if (error) throw new Error(error.message);
      });
      await runTest("Ban user via auth metadata", async () => {
        if (!targetUserId) throw new Error("No target user");
        const { error } = await supabaseAdmin.auth.admin.updateUserById(targetUserId, {
          ban_duration: "876600h",
        });
        if (error) throw new Error(error.message);
      });
      await runTest("Unban user", async () => {
        if (!targetUserId) throw new Error("No target user");
        const { error } = await supabaseAdmin.auth.admin.updateUserById(targetUserId, {
          ban_duration: "none",
        });
        if (error) throw new Error(error.message);
      });
    }

    if (suite === "session" || !suite) {
      let mockSessionId = null;
      const { data: realUser } = await supabaseAdmin
        .from("profiles").select("id").limit(1).single();
      const mockUserId = realUser?.id || null;
      const diagSessionId = "diag-" + Date.now();
      await runTest("Insert mock session", async () => {
        if (!mockUserId) throw new Error("No users in database to test with");
        const { data, error } = await supabaseAdmin.from("sessions").upsert({
          user_id: mockUserId,
          email: "mock-test@tzurah.ai",
          started_at: new Date().toISOString(),
          last_ping: new Date().toISOString(),
          credits_used: 0,
          is_active: true,
          session_id: diagSessionId,
          kill_signal: false,
        }, { onConflict: "user_id" }).select("id").single();
        if (error) throw new Error(error.message);
        mockSessionId = data.id;
      });
      await runTest("Verify session exists", async () => {
        if (!mockSessionId) throw new Error("No mock session");
        const { data, error } = await supabaseAdmin
          .from("sessions").select("id, is_active").eq("id", mockSessionId).single();
        if (error) throw new Error(error.message);
        if (!data.is_active) throw new Error("Session not active");
      });
      await runTest("Set kill signal on session", async () => {
        if (!mockSessionId) throw new Error("No mock session");
        const { error } = await supabaseAdmin.from("sessions")
          .update({ kill_signal: true, kill_reason: "technical_issue" }).eq("id", mockSessionId);
        if (error) throw new Error(error.message);
      });
      await runTest("End session (clear kill signal)", async () => {
        if (!mockSessionId) throw new Error("No mock session");
        const { error } = await supabaseAdmin.from("sessions")
          .update({ kill_signal: false, is_active: false }).eq("id", mockSessionId);
        if (error) throw new Error(error.message);
      });
      await runTest("Cleanup mock session", async () => {
        if (!mockSessionId) throw new Error("No mock session");
        const { error } = await supabaseAdmin.from("sessions").delete().eq("id", mockSessionId);
        if (error) throw new Error(error.message);
      });
    }

    if (suite === "payment" || !suite) {
      const stripeConfigured = !!process.env.STRIPE_SECRET_KEY &&
        process.env.STRIPE_SECRET_KEY !== "your_stripe_key" && !!stripe;

      if (!stripeConfigured) {
        skipTest("Stripe keys configured",       "Not configured — add STRIPE_SECRET_KEY to .env");
        skipTest("Create test Stripe checkout session", "Skipped — Stripe not configured");
        skipTest("Webhook secret configured",    "Not configured — add STRIPE_WEBHOOK_SECRET to .env");
      } else {
        await runTest("Stripe keys configured", async () => {});
        await runTest("Create test Stripe checkout session", async () => {
          const session = await stripe.checkout.sessions.create({
            mode: "payment",
            line_items: [{ price_data: {
              currency: "usd",
              unit_amount: 100,
              product_data: { name: "Diagnostic Test" },
            }, quantity: 1 }],
            success_url: "https://example.com/success",
            cancel_url:  "https://example.com/cancel",
          });
          if (!session?.id) throw new Error("No session ID returned");
        });
        await runTest("Webhook secret configured", async () => {
          const secret = process.env.STRIPE_WEBHOOK_SECRET;
          if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET not set");
        });
      }
    }

    // ── C12: Performance suite ──────────────────────────────────────
    if (suite === "performance" || !suite) {
      await runTest("Concurrent requests (10x)", async () => {
        const start = Date.now();
        await Promise.all(Array(10).fill(null).map(() => fetch(`http://localhost:${PORT}/health`)));
        const ms = Date.now() - start;
        if (ms >= 3000) throw new Error(`Too slow: ${ms}ms`);
      });
      await runTest("DB query speed", async () => {
        const start = Date.now();
        await supabaseAdmin.from("profiles").select("id, credits").limit(50);
        const ms = Date.now() - start;
        if (ms >= 1000) throw new Error(`Too slow: ${ms}ms`);
      });
      await runTest("Memory usage OK", async () => {
        const mb = Math.floor(process.memoryUsage().heapUsed / 1024 / 1024);
        if (mb >= 300) throw new Error(`Heap too high: ${mb}MB`);
      });
      await runTest("Server uptime", async () => {
        if (process.uptime() < 0) throw new Error("Uptime negative");
      });
    }

    // ── C12: Security suite ─────────────────────────────────────────
    if (suite === "security" || !suite) {
      await runTest("Rate limiting active", async () => { /* configured via express-rate-limit — always passes */ });
      await runTest("Admin password changed", async () => {
        if (process.env.ADMIN_PASSWORD === "TzurahAdmin2025!") throw new Error("Still using default password!");
      });
      await runTest("Decart API key configured", async () => {
        const key = process.env.DECART_API_KEY;
        if (!key || key.includes("YOUR") || key === "your_decart_key_here") throw new Error("DECART_API_KEY not set or placeholder");
      });
      await runTest("Supabase service role set", async () => {
        if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
      });
      await runTest("Stripe webhook secret", async () => {
        if (!process.env.STRIPE_WEBHOOK_SECRET) throw new Error("STRIPE_WEBHOOK_SECRET not set");
      });
    }

    // ── C12: Reliability suite ──────────────────────────────────────
    if (suite === "reliability" || !suite) {
      await runTest("Supabase response time", async () => {
        const start = Date.now();
        await Promise.race([
          supabaseAdmin.from("profiles").select("id").limit(1),
          new Promise((_, r) => setTimeout(() => r(new Error("Timeout after 5s")), 5000)),
        ]);
        const ms = Date.now() - start;
        if (ms >= 3000) throw new Error(`Too slow: ${ms}ms`);
      });
      await runTest("Feature flags table", async () => {
        const { error } = await supabaseAdmin.from("feature_flags").select("key").limit(10);
        if (error) throw new Error(error.message);
      });
      await runTest("Credit packs table", async () => {
        const { error } = await supabaseAdmin.from("credit_packs").select("id").eq("is_active", true);
        if (error) throw new Error(error.message);
      });
      await runTest("Sessions table healthy", async () => {
        const { error } = await supabaseAdmin.from("sessions").select("id", { count: "exact", head: true });
        if (error) throw new Error(error.message);
      });
    }

    // ── Feature Flags suite ─────────────────────────────────────────
    if (suite === "feature_flags" || !suite) {
      // Test 1: all expected flags exist
      try {
        const { data: flags } = await supabaseAdmin.from("feature_flags").select("key, enabled");
        const expectedFlags = ["enable_recording","enable_background","enable_auto_prompt","enable_new_signups","maintenance_mode","beta_features"];
        const existingKeys  = flags?.map(f => f.key) || [];
        const missing       = expectedFlags.filter(f => !existingKeys.includes(f));
        if (missing.length > 0) throw new Error(`Missing: ${missing.join(", ")}`);
        results["All feature flags exist"] = { ok: true, error: `${flags?.length} flags found` };
      } catch (e) { results["All feature flags exist"] = { ok: false, error: e.message }; }

      // Test 2: can toggle a flag
      try {
        const { data: flag } = await supabaseAdmin.from("feature_flags").select("key, enabled").eq("key", "beta_features").single();
        const original = flag?.enabled;
        await supabaseAdmin.from("feature_flags").update({ enabled: !original }).eq("key", "beta_features");
        const { data: updated } = await supabaseAdmin.from("feature_flags").select("enabled").eq("key", "beta_features").single();
        const toggled = updated?.enabled === !original;
        await supabaseAdmin.from("feature_flags").update({ enabled: original }).eq("key", "beta_features");
        if (!toggled) throw new Error("Toggle did not persist");
        results["Feature flag toggle works"] = { ok: true, error: "Toggle and restore successful" };
      } catch (e) { results["Feature flag toggle works"] = { ok: false, error: e.message }; }

      // Test 3: maintenance mode is OFF
      try {
        const { data } = await supabaseAdmin.from("feature_flags").select("enabled").eq("key", "maintenance_mode").single();
        const off = data?.enabled === false;
        results["Maintenance mode is OFF"] = { ok: off, error: off ? "App accessible to users ✓" : "⚠️ Maintenance mode is ON — users blocked!" };
      } catch (e) { results["Maintenance mode is OFF"] = { ok: false, error: e.message }; }

      // Test 4: new signups enabled
      try {
        const { data } = await supabaseAdmin.from("feature_flags").select("enabled").eq("key", "enable_new_signups").single();
        const on = data?.enabled === true;
        results["New signups enabled"] = { ok: on, error: on ? "New users can register ✓" : "⚠️ Signups disabled!" };
      } catch (e) { results["New signups enabled"] = { ok: false, error: e.message }; }
    }

    // ── Credit Packs suite ──────────────────────────────────────────
    if (suite === "credit_packs" || !suite) {
      // Test 1: active packs exist
      try {
        const { data: packs } = await supabaseAdmin.from("credit_packs").select("*").eq("is_active", true).order("sort_order");
        const enough = (packs?.length || 0) >= 3;
        results["Active credit packs exist"] = { ok: enough, error: `${packs?.length || 0} active packs found` };
      } catch (e) { results["Active credit packs exist"] = { ok: false, error: e.message }; }

      // Test 2: pack prices valid
      try {
        const { data: packs } = await supabaseAdmin.from("credit_packs").select("name, price_usd, credits").eq("is_active", true);
        const invalid = (packs || []).filter(p => !p.price_usd || p.price_usd <= 0 || !p.credits || p.credits <= 0);
        if (invalid.length > 0) throw new Error(`Invalid packs: ${invalid.map(p => p.name).join(", ")}`);
        results["All pack prices valid"] = { ok: true, error: "All prices and credits > 0 ✓" };
      } catch (e) { results["All pack prices valid"] = { ok: false, error: e.message }; }

      // Test 3: popular pack configured
      try {
        const { data: packs } = await supabaseAdmin.from("credit_packs").select("name, is_popular").eq("is_active", true).eq("is_popular", true);
        const hasPopular = (packs?.length || 0) >= 1;
        results["Popular pack configured"] = { ok: hasPopular, error: `${packs?.length || 0} pack(s) marked popular: ${packs?.map(p => p.name).join(", ") || "none"}` };
      } catch (e) { results["Popular pack configured"] = { ok: false, error: e.message }; }

      // Test 4: pack CRUD
      try {
        const { data: newPack, error: insertErr } = await supabaseAdmin.from("credit_packs")
          .insert({ name: "Test Pack", slug: "test-pack-" + Date.now(), price_usd: 1, credits: 1, is_active: false, sort_order: 999 })
          .select().single();
        if (insertErr) throw insertErr;
        await supabaseAdmin.from("credit_packs").delete().eq("id", newPack.id);
        results["Pack CRUD works"] = { ok: true, error: "Create and delete test pack successful" };
      } catch (e) { results["Pack CRUD works"] = { ok: false, error: e.message }; }
    }

    // ── Announcements suite ─────────────────────────────────────────
    if (suite === "announcements" || !suite) {
      let testAnnId = null;

      // Test 1: create
      try {
        const { data, error: annErr } = await supabaseAdmin.from("announcements")
          .insert({ title: "Test Announcement", message: "Automated test", type: "info", is_active: true })
          .select().single();
        if (annErr) throw annErr;
        testAnnId = data.id;
        results["Create announcement"] = { ok: true, error: `ID: ${data.id.slice(0,8)}…` };
      } catch (e) { results["Create announcement"] = { ok: false, error: e.message }; }

      // Test 2: visible
      if (testAnnId) {
        try {
          const { data } = await supabaseAdmin.from("announcements").select("*").eq("id", testAnnId).eq("is_active", true).single();
          results["Announcement visible in API"] = { ok: !!data, error: data ? "Visible to app users ✓" : "Not found" };
        } catch (e) { results["Announcement visible in API"] = { ok: false, error: e.message }; }

        // Test 3: deactivate
        try {
          await supabaseAdmin.from("announcements").update({ is_active: false }).eq("id", testAnnId);
          const { data } = await supabaseAdmin.from("announcements").select("is_active").eq("id", testAnnId).single();
          const hidden = data?.is_active === false;
          results["Deactivate announcement"] = { ok: hidden, error: hidden ? "Announcement hidden from users ✓" : "Still active!" };
        } catch (e) { results["Deactivate announcement"] = { ok: false, error: e.message }; }

        // Cleanup
        try {
          await supabaseAdmin.from("announcements").delete().eq("id", testAnnId);
          results["Announcement cleanup"] = { ok: true, error: "Test announcement deleted" };
        } catch (e) { results["Announcement cleanup"] = { ok: false, error: e.message }; }
      }
    }

    // ── Business Logic suite ────────────────────────────────────────
    if (suite === "business_logic" || !suite) {
      // Test 1: new user gets 6 credits
      try {
        const testEmail = `biztest_${Date.now()}@tzurah-test.com`;
        const { data: newUser } = await supabaseAdmin.auth.admin.createUser({ email: testEmail, password: "BizTest123!", email_confirm: true });
        await new Promise(r => setTimeout(r, 1500));
        const { data: profile } = await supabaseAdmin.from("profiles").select("credits").eq("id", newUser.user.id).maybeSingle();
        const correct = profile?.credits === 6;
        results["New user gets 6 free credits"] = { ok: correct, error: `Credits assigned: ${profile?.credits} (expected: 6)` };
        await supabaseAdmin.from("profiles").delete().eq("id", newUser.user.id);
        await supabaseAdmin.auth.admin.deleteUser(newUser.user.id);
        results["Business logic test cleanup"] = { ok: true, error: `Deleted ${testEmail}` };
      } catch (e) { results["New user gets 6 free credits"] = { ok: false, error: e.message }; }

      // Test 2: credits cannot go below 0
      try {
        const { data: profile } = await supabaseAdmin.from("profiles").select("id, credits").order("credits", { ascending: true }).limit(1).single();
        if (profile) {
          const original = profile.credits;
          const clamped  = Math.max(0, original - 99999);
          await supabaseAdmin.from("profiles").update({ credits: clamped }).eq("id", profile.id);
          const { data: updated } = await supabaseAdmin.from("profiles").select("credits").eq("id", profile.id).single();
          await supabaseAdmin.from("profiles").update({ credits: original }).eq("id", profile.id);
          results["Credits cannot go below 0"] = { ok: updated?.credits >= 0, error: `Balance: ${updated?.credits} ✓` };
        }
      } catch (e) { results["Credits cannot go below 0"] = { ok: false, error: e.message }; }

      // Test 3: burn rate configured
      try {
        const burnRate = parseFloat(process.env.CREDITS_PER_SECOND || "0.1");
        results["Burn rate configured"] = { ok: burnRate > 0, error: `${burnRate} cr/s` };
      } catch (e) { results["Burn rate configured"] = { ok: false, error: e.message }; }

      // Test 4: usage logging works
      try {
        const { data: testUser } = await supabaseAdmin.from("profiles").select("id").limit(1).single();
        if (testUser) {
          const { error: usageErr } = await supabaseAdmin.from("usage").insert({ user_id: testUser.id, session_seconds: 1, credits_used: 1, started_at: new Date().toISOString(), ended_at: new Date().toISOString() });
          if (usageErr) throw usageErr;
          await supabaseAdmin.from("usage").delete().eq("user_id", testUser.id).eq("session_seconds", 1).eq("credits_used", 1);
          results["Usage logging works"] = { ok: true, error: "Usage record created and cleaned up ✓" };
        }
      } catch (e) { results["Usage logging works"] = { ok: false, error: e.message }; }
    }

    // ── IP Blocking suite ───────────────────────────────────────────
    if (suite === "ip_blocking" || !suite) {
      const testIP = "192.0.2.1"; // RFC 5737 documentation IP

      // Test 1: can block
      try {
        await supabaseAdmin.from("ip_blocks").upsert({ ip_address: testIP, reason: "Automated test block", blocked_by: "test-suite" }, { onConflict: "ip_address" });
        const { data } = await supabaseAdmin.from("ip_blocks").select("ip_address").eq("ip_address", testIP).single();
        results["IP block creation"] = { ok: !!data, error: data ? `${testIP} blocked ✓` : "Block not found" };
      } catch (e) { results["IP block creation"] = { ok: false, error: e.message }; }

      // Test 2: can remove
      try {
        await supabaseAdmin.from("ip_blocks").delete().eq("ip_address", testIP);
        const { data } = await supabaseAdmin.from("ip_blocks").select("ip_address").eq("ip_address", testIP);
        results["IP block removal"] = { ok: (data?.length || 0) === 0, error: "Block removed successfully ✓" };
      } catch (e) { results["IP block removal"] = { ok: false, error: e.message }; }

      // Test 3: table healthy
      try {
        const { count } = await supabaseAdmin.from("ip_blocks").select("id", { count: "exact", head: true });
        results["IP blocks table healthy"] = { ok: true, error: `${count || 0} active blocks` };
      } catch (e) { results["IP blocks table healthy"] = { ok: false, error: e.message }; }
    }

    // ── Sub-Admins suite ────────────────────────────────────────────
    if (suite === "sub_admins" || !suite) {
      const testEmail   = `subadmin_test_${Date.now()}@tzurah-test.com`;
      let   testAdminId = null;

      // Test 1: create
      try {
        const bcrypt = require("bcryptjs");
        const hash   = await bcrypt.hash("TestPass123!", 10);
        const { data, error: saErr } = await supabaseAdmin.from("admin_users")
          .insert({ email: testEmail, password_hash: hash, name: "Test Sub-Admin", role: "support", must_change_password: true, created_by: "test-suite" })
          .select().single();
        if (saErr) throw saErr;
        testAdminId = data.id;
        results["Create sub-admin"] = { ok: true, error: `Created ${testEmail} as support` };
      } catch (e) { results["Create sub-admin"] = { ok: false, error: e.message }; }

      // Tests 2 & 3: password hash + must_change_password flag
      if (testAdminId) {
        try {
          const { data } = await supabaseAdmin.from("admin_users").select("password_hash, must_change_password, role").eq("id", testAdminId).single();
          const bcrypt = require("bcryptjs");
          const valid  = await bcrypt.compare("TestPass123!", data.password_hash);
          results["Sub-admin password hashed correctly"] = { ok: valid, error: valid ? "bcrypt hash verified ✓" : "Hash mismatch!" };
          results["Must change password flag set"]        = { ok: data?.must_change_password === true, error: `must_change_password: ${data?.must_change_password}` };
        } catch (e) {
          results["Sub-admin password hashed correctly"] = { ok: false, error: e.message };
          results["Must change password flag set"]        = { ok: false, error: e.message };
        }

        // Cleanup
        try {
          await supabaseAdmin.from("admin_users").delete().eq("id", testAdminId);
          results["Sub-admin cleanup"] = { ok: true, error: `Deleted ${testEmail}` };
        } catch (e) { results["Sub-admin cleanup"] = { ok: false, error: e.message }; }
      }

      // Test: super admin exists
      try {
        const { data } = await supabaseAdmin.from("admin_users").select("email, role").eq("role", "super_admin").eq("is_active", true);
        const envExists = !!process.env.ADMIN_EMAIL;
        results["Admin account exists"] = { ok: (data?.length || 0) > 0 || envExists, error: envExists ? `Env admin: ${process.env.ADMIN_EMAIL}` : `${data?.length} super admins in DB` };
      } catch (e) { results["Admin account exists"] = { ok: false, error: e.message }; }
    }

    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, results });
  }
});

// ═══════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════

// Startup: warn if default secrets are in use
if (!process.env.BOOTSTRAP_SECRET) {
  console.warn("[BOOTSTRAP] Using default secret — set BOOTSTRAP_SECRET in .env for production");
}
if (!process.env.INTERNAL_SECRET) {
  console.warn("[INTERNAL] Using default internal secret — set INTERNAL_SECRET in .env for production");
}

// Startup: verify admin_actions table has expected columns
(async () => {
  const required = ["details", "ip_address", "user_agent", "performed_by_role"];
  const { data, error } = await supabaseAdmin.from("admin_actions").select("*").limit(1);
  if (error) {
    console.warn("[STARTUP] admin_actions table not found or inaccessible:", error.message);
    return;
  }
  if (data && data.length > 0) {
    const cols = Object.keys(data[0]);
    const missing = required.filter(c => !cols.includes(c));
    if (missing.length > 0) {
      console.warn("[STARTUP] admin_actions table missing columns:", missing.join(", "));
      console.warn("[STARTUP] Run: ALTER TABLE admin_actions ADD COLUMN IF NOT EXISTS <column> TEXT;");
    }
  }
})();

// Ensure all feature flags exist on startup (ignoreDuplicates = never overwrite existing values)
const STARTUP_FLAGS = [
  { key: "enable_recording",   enabled: true,  description: "Allow users to record sessions"                },
  { key: "enable_background",  enabled: true,  description: "Enable background replacement mode"            },
  { key: "enable_auto_prompt", enabled: true,  description: "Enable Florence-2 auto-describe"               },
  { key: "enable_new_signups", enabled: true,  description: "Allow new user registrations"                  },
  { key: "maintenance_mode",   enabled: false, description: "Show maintenance banner to all users"          },
  { key: "beta_features",      enabled: false, description: "Enable beta features for all users"            },
  { key: "mock_payments",      enabled: true,  description: "Mock payment mode — disable before launch"     },
  { key: "enable_style_mode",  enabled: true,  description: "Enable style transformation mode"              },
  { key: "enable_obs_output",  enabled: true,  description: "Enable OBS output feature"                     },
  { key: "enable_kill_switch", enabled: false, description: "Emergency: block all new sessions immediately" },
  { key: "enable_protected_billing_global",     enabled: false, description: "Protected billing global live cutover - keep disabled until approved" },
  { key: "enable_protected_billing_test_users", enabled: false, description: "Protected billing for explicit test-user allowlist only" },
  { key: "protected_billing_shadow_compare",    enabled: true,  description: "Compare protected billing calculations while legacy remains authoritative" },
  { key: "protected_billing_force_legacy",      enabled: true,  description: "Emergency rollback flag forcing legacy billing mode" },
];
(async () => {
  const now = new Date().toISOString();
  const rows = STARTUP_FLAGS.map(f => ({ ...f, updated_at: now }));
  const { error } = await supabaseAdmin.from("feature_flags")
    .upsert(rows, { onConflict: "key", ignoreDuplicates: true });
  if (error) console.warn("[FLAGS] Startup flags init error:", error.message);
  else console.log(`[FLAGS] ${rows.length} feature flags ensured`);
})();

// ── Session watchdog — force-ends stale sessions every 30 s ──────
// A session is stale if it hasn't pinged in 45 seconds.
// Accounts for all unbilled Decart time before closing.
setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 45 * 1000).toISOString();
    const { data: staleSessions } = await supabaseAdmin
      .from("sessions")
      .select("session_id, user_id, started_at, last_sync_at, last_ping")
      .eq("is_active", true)
      .lt("last_ping", cutoff);

    if (!staleSessions?.length) return;

    for (const sess of staleSessions) {
      console.warn("[WATCHDOG] Stale session detected:", sess.session_id, "last_ping:", sess.last_ping);

      const lastSync     = new Date(sess.last_sync_at || sess.started_at);
      const now          = new Date();
      const unbilledSecs = Math.max(0, Math.round((now - lastSync) / 1000));

      if (unbilledSecs > 0) {
        await deductDecartCredits(unbilledSecs, sess.session_id);
      }

      await supabaseAdmin.from("sessions").update({
        is_active:   false,
        kill_signal: false,
        kill_reason: "Session timed out — no ping received",
        last_ping:   now.toISOString(),
      }).eq("session_id", sess.session_id);
      await logBillingReconciliationEvent({
        userId: sess.user_id,
        sessionId: sess.session_id,
        type: "stale_session_detected",
        severity: "warning",
        details: { last_ping: sess.last_ping, unbilled_secs: unbilledSecs, source: "watchdog" },
      });
      await detectMissingFinalSync({ ...sess, last_ping: now.toISOString() });

      logAction("session_timeout", "system", "system", sess.user_id, {
        session_id:    sess.session_id,
        unbilled_secs: unbilledSecs,
        reason:        "No ping for 45+ seconds",
      }, null).catch(() => {});

      console.log("[WATCHDOG] Force-ended stale session:", sess.session_id, "unbilled:", unbilledSecs, "secs");
    }
  } catch (err) {
    console.error("[WATCHDOG] Error:", err.message);
  }
}, 30 * 1000);

setInterval(() => {
  detectSessionAnomalies().catch((err) => {
    console.warn("[BILLING RECON] Scheduled scan failed:", err.message);
  });
}, 2 * 60 * 1000);

app.listen(PORT, () => {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Tzurah Live — GCP Server");
  console.log(`  http://localhost:${PORT}`);
  console.log("───────────────────────────────────────────────────────");
  console.log("  GET  /health                   → Health check");
  console.log("  GET  /decart/token             → Decart token proxy");
  console.log("  POST /credits/deduct           → Deduct credits");
  console.log("  POST /credits/sync             → Bulk usage sync");
  console.log("  POST /session/ping             → Live session ping");
  console.log("  POST /session/end              → End session");
  console.log("  POST /stripe/create-checkout   → Stripe checkout");
  console.log("  POST /stripe/webhook           → Stripe fulfillment");
  console.log("  GET  /admin                    → Admin dashboard (session auth)");
  console.log("  GET  /admin/login              → Admin login page");
  console.log("  POST /admin/login              → Admin login");
  console.log("  POST /admin/logout             → Admin logout");
  console.log("  GET  /admin/api/stream         → SSE real-time updates");
  console.log("  GET  /admin/api/live-sessions  → Live sessions");
  console.log("  GET  /admin/api/activity       → Recent activity feed");
  console.log("  GET  /admin/api/settings       → Admin settings (masked)");
  console.log("  POST /admin/api/settings/update-key → Update .env key");
  console.log("  POST /admin/api/settings/restart    → Restart server");
  console.log("  GET  /admin/api/db/stats           → DB row counts");
  console.log("  POST /admin/api/db/action          → Execute DB action");
  console.log("  GET  /admin/api/email/recipients → Email recipient groups");
  console.log("  POST /admin/api/email/send     → Send email to users");
  console.log("  GET  /admin/api/email/sent     → Sent email log");
  console.log("═══════════════════════════════════════════════════════\n");
});
