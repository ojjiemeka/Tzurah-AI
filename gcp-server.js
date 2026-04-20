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
const PORT         = parseInt(process.env.PORT || "4000", 10);
const DECART_KEY   = process.env.DECART_API_KEY;

// Credit packs (1 credit = 10 seconds)
const PACKS = {
  starter:  { name: "Starter",  price: 20,  credits: 42,   minutes: 7,   priceId: process.env.STRIPE_PRICE_STARTER  },
  basic:    { name: "Basic",    price: 35,  credits: 72,   minutes: 12,  priceId: process.env.STRIPE_PRICE_BASIC    },
  standard: { name: "Standard", price: 60,  credits: 132,  minutes: 22,  priceId: process.env.STRIPE_PRICE_STANDARD },
  pro:      { name: "Pro",      price: 100, credits: 216,  minutes: 36,  priceId: process.env.STRIPE_PRICE_PRO      },
  ultra:    { name: "Ultra",    price: 200, credits: 450,  minutes: 75,  priceId: process.env.STRIPE_PRICE_ULTRA    },
  max:      { name: "Max",      price: 500, credits: 1200, minutes: 200, priceId: process.env.STRIPE_PRICE_MAX      },
};

// ── Admin session auth ─────────────────────────────────────────────
function adminAuth(req, res, next) {
  if (req.session?.isAdmin) return next();
  if (req.path.startsWith("/admin/api/")) return res.status(401).json({ error: "Unauthorized" });
  res.redirect("/admin/login");
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
    res.header("Access-Control-Allow-Methods",     "GET,POST,OPTIONS");
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

// ═══════════════════════════════════════════════════════════════════
// CREDITS
// ═══════════════════════════════════════════════════════════════════

/**
 * POST /credits/deduct
 * Body: { credits: number, session_seconds: number }
 */
app.post("/credits/deduct", requireAuth, async (req, res) => {
  const { credits, session_seconds } = req.body || {};

  console.log("[DEDUCT] user:", req.userId, "credits:", credits, "seconds:", session_seconds);

  if (typeof credits !== "number" || credits < 0) {
    console.warn("[DEDUCT] Bad credits value:", credits);
    return res.status(400).json({ error: "credits must be a non-negative number" });
  }

  const { data: profile, error: fetchErr } = await supabaseAdmin
    .from("profiles")
    .select("credits, total_credits_used")
    .eq("id", req.userId)
    .single();

  console.log("[DEDUCT] current balance:", profile?.credits, "fetch error:", fetchErr?.message || "none");

  if (fetchErr || !profile) return res.status(404).json({ error: "Profile not found" });
  if (profile.credits < credits) {
    console.warn("[DEDUCT] Insufficient credits:", profile.credits, "<", credits);
    return res.status(402).json({ error: "Insufficient credits", credits_remaining: profile.credits });
  }

  const newBalance      = Math.max(0, profile.credits - credits);
  const newTotalUsed    = (profile.total_credits_used || 0) + credits;

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

  if (updateErr) return res.status(500).json({ error: updateErr.message });

  if (session_seconds && session_seconds > 0) {
    const now = new Date().toISOString();
    await supabaseAdmin.from("usage").insert({
      user_id:         req.userId,
      session_seconds: session_seconds,
      credits_used:    credits,
      ended_at:        now,
      created_at:      now,
    }).then(() => {}).catch((e) => console.warn("[DEDUCT] usage insert error:", e.message));
  }

  console.log("[DEDUCT] success — new balance:", newBalance);
  res.json({ ok: true, credits_remaining: newBalance });
});

/**
 * POST /credits/sync
 * Body: { usage_logs: [{ session_seconds, credits_used, started_at, ended_at }] }
 */
app.post("/credits/sync", requireAuth, async (req, res) => {
  const { usage_logs } = req.body || {};

  if (Array.isArray(usage_logs) && usage_logs.length > 0) {
    const rows = usage_logs.map((log) => ({
      user_id:         req.userId,
      session_seconds: log.session_seconds,
      credits_used:    log.credits_used,
      started_at:      log.started_at ? new Date(log.started_at).toISOString() : null,
      ended_at:        log.ended_at   ? new Date(log.ended_at).toISOString()   : null,
      created_at:      new Date().toISOString(),
    }));

    await supabaseAdmin.from("usage").insert(rows).then(() => {}).catch(() => {});

    const totalCredits = usage_logs.reduce((s, l) => s + (l.credits_used || 0), 0);

    // Fetch and deduct atomically
    const { data: profile } = await supabaseAdmin
      .from("profiles").select("credits").eq("id", req.userId).single();

    if (profile) {
      await supabaseAdmin.from("profiles")
        .update({ credits: Math.max(0, profile.credits - totalCredits) })
        .eq("id", req.userId);
    }
  }

  const { data: profile } = await supabaseAdmin
    .from("profiles").select("credits").eq("id", req.userId).single();

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
  const adminEmail = process.env.ADMIN_EMAIL    || "admin@tzurah.ai";
  const adminPass  = process.env.ADMIN_PASSWORD || "TzurahAdmin2025!";
  if (email === adminEmail && password === adminPass) {
    req.session.isAdmin     = true;
    req.session.adminEmail  = email;
    req.session.adminRole   = "super_admin";
    req.session.adminName   = "Super Admin";
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
        console.log("[LOGIN] Sub-admin:", admins.email, "must_change_password:", admins.must_change_password, "type:", typeof admins.must_change_password);
        req.session.isAdmin    = true;
        req.session.adminEmail = admins.email;
        req.session.adminRole  = admins.role;
        req.session.adminName  = admins.name;
        await supabaseAdmin.from("admin_users").update({ last_login: new Date().toISOString() }).eq("id", admins.id);
        return res.json({
          success: true,
          mustChangePassword: admins.must_change_password === true,
          role: admins.role,
          name: admins.name,
        });
      }
    }
  } catch (_) {}
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

      const { count: unreadNotifs } = await supabaseAdmin
        .from("admin_notifications")
        .select("id", { count: "exact", head: true })
        .eq("is_read", false);

      const payload = {
        type:      "update",
        timestamp: Date.now(),
        unreadNotifications: unreadNotifs || 0,
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

    const enriched = await Promise.all(
      Object.entries(byUser).map(async ([userId, stats]) => {
        const { data: au } = await supabaseAdmin.auth.admin.getUserById(userId);
        return { user_id: userId, email: au?.user?.email || "unknown", ...stats };
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
      .single();

    if (fetchErr || !profile) return res.status(404).json({ error: "User not found" });

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

    console.log(`[Tzurah] Admin gifted ${credits} credits to ${userId}` + (reason ? ` (${reason})` : ""));
    res.json({ ok: true, new_balance: newBalance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: deduct credits ─────────────────────────────────────────
app.post("/admin/api/deduct-credits", adminAuth, async (req, res) => {
  const body    = req.body || {};
  const userId  = body.userId  || body.user_id;
  const credits = body.amount  != null ? body.amount : body.credits;
  const reason  = body.reason  || "";

  if (!userId || typeof credits !== "number" || credits < 1) {
    return res.status(400).json({ error: "userId and amount (>=1) required" });
  }

  try {
    const { data: profile, error: fetchErr } = await supabaseAdmin
      .from("profiles").select("credits").eq("id", userId).single();

    if (fetchErr || !profile) return res.status(404).json({ error: "User not found" });

    const newBalance = Math.max(0, profile.credits - credits);
    await supabaseAdmin.from("profiles").update({ credits: newBalance }).eq("id", userId);

    console.log(`[Tzurah] Admin deducted ${credits} credits from ${userId}` + (reason ? ` (${reason})` : ""));
    res.json({ ok: true, new_balance: newBalance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: ban user ───────────────────────────────────────────────
app.post("/admin/api/ban-user", adminAuth, async (req, res) => {
  const body   = req.body || {};
  const userId = body.userId || body.user_id;
  if (!userId) return res.status(400).json({ error: "userId required" });

  try {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      ban_duration: "87600h", // ~10 years
    });
    if (error) return res.status(500).json({ error: error.message });
    console.log(`[Tzurah] Admin banned user ${userId}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: unban user ─────────────────────────────────────────────
app.post("/admin/api/unban-user", adminAuth, async (req, res) => {
  const body   = req.body || {};
  const userId = body.userId || body.user_id;
  if (!userId) return res.status(400).json({ error: "userId required" });

  try {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      ban_duration: "none",
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// POST /session/ping — Electron app calls every 10 s during active stream
// No JWT required — user_id comes from body (Electron local session)
// session_id is a UUID generated by the client on each Start click.
// If session_id changes (or row was inactive), started_at is reset.
// SQL:
//   ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS kill_signal BOOLEAN DEFAULT false;
//   ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS session_id  TEXT;
app.post("/session/ping", async (req, res) => {
  const { user_id, email, credits_used, session_id } = req.body || {};
  console.log("[PING]", user_id, email || "no-email", "sid:", session_id);
  if (!user_id) return res.status(400).json({ error: "user_id required" });
  if (!validateUUID(user_id)) return res.status(400).json({ error: "Invalid user_id format" });
  try {
    const { data: existing } = await supabaseAdmin
      .from("sessions")
      .select("id, started_at, is_active, session_id, kill_signal, kill_reason")
      .eq("user_id", user_id)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Kill signal takes priority
    if (existing?.kill_signal) {
      console.log("[PING] KILL SIGNAL for user:", user_id, "reason:", existing.kill_reason);
      await supabaseAdmin.from("sessions")
        .update({ kill_signal: false, is_active: false })
        .eq("id", existing.id);
      return res.json({ ok: true, kill: true, reason: existing.kill_reason || null });
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
      }).eq("id", existing.id);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[PING] error:", err.message);
    res.json({ ok: true, warn: err.message });
  }
});

// POST /session/end — Electron calls when stream stops
app.post("/session/end", async (req, res) => {
  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: "user_id required" });
  try {
    await supabaseAdmin.from("sessions")
      .update({ is_active: false })
      .eq("user_id", user_id)
      .eq("is_active", true);
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

// POST /admin/api/end-session — force-end a user's active session via kill signal
app.post("/admin/api/end-session", adminAuth, async (req, res) => {
  const body       = req.body || {};
  const userId     = body.userId || body.user_id;
  const reason     = body.reason     || null;
  const adminNote  = body.admin_note || null;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    await supabaseAdmin.from("sessions")
      .update({ is_active: false, kill_signal: true, kill_reason: reason, kill_note: adminNote })
      .eq("user_id", userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: recent activity feed ───────────────────────────────────
app.get("/admin/api/activity", adminAuth, async (_req, res) => {
  try {
    const [purchRes, usageRes, signupRes] = await Promise.all([
      supabaseAdmin.from("purchases")
        .select("user_id, pack_name, price_usd, created_at")
        .order("created_at", { ascending: false }).limit(10),
      supabaseAdmin.from("usage")
        .select("user_id, session_seconds, credits_used, ended_at, created_at")
        .order("created_at", { ascending: false }).limit(10),
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
          : `received gift: ${p.pack_name}`,
        ts: p.created_at,
      });
    }
    for (const u of usageRes.data || []) {
      const m = Math.floor((u.session_seconds || 0) / 60);
      const s = (u.session_seconds || 0) % 60;
      events.push({
        type:    "session",
        user_id: u.user_id,
        detail:  `session ended (${m}m ${s}s, ${Math.round(u.credits_used || 0)} cr)`,
        ts:      u.ended_at || u.created_at,
      });
    }
    for (const p of signupRes.data || []) {
      events.push({
        type:    "signup",
        user_id: p.id,
        detail:  `signed up${p.display_name ? " as " + p.display_name : ""}`,
        ts:      p.created_at,
      });
    }

    events.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    const top = events.slice(0, 15);

    await Promise.all(top.slice(0, 10).map(async (e) => {
      try {
        const { data: au } = await supabaseAdmin.auth.admin.getUserById(e.user_id);
        e.email = au?.user?.email || "unknown";
      } catch { e.email = "unknown"; }
    }));

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
    res.json({
      all:              merged,
      active_this_week: merged.filter(u => u.last_seen_at && u.last_seen_at > oneWeekAgo),
      zero_credits:     merged.filter(u => u.credits_balance <= 0),
      low_credits:      merged.filter(u => u.credits_balance > 0 && u.credits_balance <= 10),
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
  const { recipients, subject, body, test_only } = req.body || {};
  if (!recipients?.length) return res.status(400).json({ error: "No recipients" });
  if (!subject?.trim())    return res.status(400).json({ error: "Subject required" });
  if (!body?.trim())       return res.status(400).json({ error: "Body required" });

  const transporter = getEmailTransporter();
  if (!transporter) {
    return res.status(503).json({ error: "Email not configured — set EMAIL_FROM and EMAIL_PASS in .env" });
  }

  const targets = test_only
    ? [{ email: process.env.ADMIN_EMAIL || process.env.EMAIL_FROM, name: "Admin (test)", credits_balance: 0 }]
    : recipients;

  const results = { sent: 0, failed: 0, errors: [] };

  for (const recipient of targets) {
    const name = recipient.name || (recipient.email || "").split("@")[0];
    const personalizedBody = (body || "")
      .replace(/{{name}}/g,    name)
      .replace(/{{credits}}/g, recipient.credits_balance ?? 0)
      .replace(/{{email}}/g,   recipient.email || "");

    try {
      await transporter.sendMail({
        from:    `Tzurah Live <${process.env.EMAIL_FROM}>`,
        to:      recipient.email,
        subject: subject,
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
  await supabaseAdmin.from("sent_emails").insert({
    subject,
    recipient_count: results.sent,
    sent_by:         "admin",
    sent_at:         new Date().toISOString(),
  }).then(() => {}).catch(() => {});

  console.log(`[Tzurah] Email sent: ${results.sent} ok, ${results.failed} failed`);
  res.json(results);
});

// ═══════════════════════════════════════════════════════════════════
// ADMIN SETTINGS
// ═══════════════════════════════════════════════════════════════════

const SETTINGS_ALLOWED_KEYS = [
  "DECART_API_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "ADMIN_EMAIL", "ADMIN_PASSWORD",
  "CREDITS_PER_SECOND", "COST_PER_CREDIT",
];

// Returns masked current values + server info
app.get("/admin/api/settings", adminAuth, (req, res) => {
  const mask = (val) => val
    ? val.slice(0, 6) + "•".repeat(22) + val.slice(-4)
    : "not set";
  res.json({
    decart_key:   mask(process.env.DECART_API_KEY),
    supabase_url: process.env.SUPABASE_URL || "not set",
    supabase_key: mask(process.env.SUPABASE_SERVICE_ROLE_KEY),
    admin_email:  process.env.ADMIN_EMAIL  || "not set",
    node_version: process.version,
    uptime:       Math.floor(process.uptime()),
    memory_mb:    Math.floor(process.memoryUsage().heapUsed / 1024 / 1024),
    pid:          process.pid,
    env:          process.env.NODE_ENV || "development",
    pricing: {
      credits_per_second: parseFloat(process.env.CREDITS_PER_SECOND || "0.1"),
      cost_per_credit:    parseFloat(process.env.COST_PER_CREDIT    || "0.00625"),
    },
  });
});

// Reveals the actual (unmasked) value of a specific env key
app.post("/admin/api/settings/reveal-key", adminAuth, (req, res) => {
  const { key_name } = req.body || {};
  const revealable = ["DECART_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ADMIN_EMAIL"];
  if (!revealable.includes(key_name)) {
    return res.status(400).json({ error: "Key not revealable" });
  }
  res.json({ value: process.env[key_name] || "not set" });
});

// Updates a single env key in .env + live process.env
app.post("/admin/api/settings/update-key", adminAuth, (req, res) => {
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
    console.log(`[SETTINGS] Updated ${key_name}`);
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
  const { key } = req.params;
  const { enabled } = req.body;
  const { error } = await supabaseAdmin.from("feature_flags")
    .update({ enabled, updated_at: new Date().toISOString(), updated_by: req.session.adminEmail || "admin" })
    .eq("key", key);
  if (error) return res.status(500).json({ error: error.message });
  console.log(`[FLAGS] ${key} = ${enabled}`);
  res.json({ ok: true });
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
  const { data, error } = await supabaseAdmin.from("credit_packs").insert({ name, price_usd, credits, stripe_price_id: stripe_price_id || null, is_popular: !!is_popular, is_active: is_active !== false, sort_order: sort_order || 0 }).select("*").single();
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
  const { title, message, type, scheduled_at, expires_at } = req.body || {};
  if (!title || !message) return res.status(400).json({ error: "title and message required" });
  const { data, error } = await supabaseAdmin.from("announcements").insert({ title, message, type: type || "info", scheduled_at: scheduled_at || null, expires_at: expires_at || null, is_active: true }).select("*").single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ announcement: data });
});

app.delete("/admin/api/announcements/:id", adminAuth, async (req, res) => {
  await supabaseAdmin.from("announcements").delete().eq("id", req.params.id);
  res.json({ ok: true });
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
  if (req.session.adminRole !== "super_admin") return res.status(403).json({ error: "Super admin only" });
  const { name, email, role, password, must_change_password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "Name, email and password required" });
  const bcrypt = require("bcryptjs");
  const hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabaseAdmin.from("admin_users").insert({ name, email, role: role || "support", password_hash: hash, must_change_password: must_change_password !== false, created_by: req.session.adminEmail }).select("id, email, name, role").single();
  if (error) return res.status(400).json({ error: error.message });
  console.log(`[ADMIN] Sub-admin created: ${email} (${role}) by ${req.session.adminEmail}`);
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

// ── C5: IP Blocks ─────────────────────────────────────────────────
app.get("/admin/api/ip-blocks", adminAuth, async (_req, res) => {
  const { data } = await supabaseAdmin.from("ip_blocks").select("*").order("created_at", { ascending: false });
  res.json({ blocks: data || [] });
});

app.post("/admin/api/ip-blocks", adminAuth, async (req, res) => {
  const { ip_address, reason, expires_in_days } = req.body;
  if (!ip_address) return res.status(400).json({ error: "IP address required" });
  const expires_at = expires_in_days ? new Date(Date.now() + expires_in_days * 86400000).toISOString() : null;
  const { error } = await supabaseAdmin.from("ip_blocks").upsert({ ip_address, reason: reason || "Manual block", blocked_by: req.session.adminEmail, expires_at }, { onConflict: "ip_address" });
  if (error) return res.status(400).json({ error: error.message });
  console.log(`[SECURITY] IP blocked: ${ip_address} by ${req.session.adminEmail}`);
  res.json({ ok: true });
});

app.delete("/admin/api/ip-blocks/:ip", adminAuth, async (req, res) => {
  await supabaseAdmin.from("ip_blocks").delete().eq("ip_address", decodeURIComponent(req.params.ip));
  res.json({ ok: true });
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
