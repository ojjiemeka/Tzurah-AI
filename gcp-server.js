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

const express = require("express");
const session = require("express-session");
const cors    = require("cors");
const path    = require("path");
const fs      = require("fs");
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

// ── Express setup ─────────────────────────────────────────────────
const app = express();
app.use(cors());

// Raw body for Stripe webhook signature verification (must come before express.json)
app.use("/stripe/webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(session({
  secret:            process.env.ADMIN_SECRET || "tzurah_admin_secret",
  resave:            false,
  saveUninitialized: false,
  cookie:            { secure: false, maxAge: 24 * 60 * 60 * 1000 },
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

  if (typeof credits !== "number" || credits < 0) {
    return res.status(400).json({ error: "credits must be a non-negative number" });
  }

  const { data: profile, error: fetchErr } = await supabaseAdmin
    .from("profiles")
    .select("credits")
    .eq("id", req.userId)
    .single();

  if (fetchErr || !profile) return res.status(404).json({ error: "Profile not found" });
  if (profile.credits < credits) {
    return res.status(402).json({ error: "Insufficient credits", credits_remaining: profile.credits });
  }

  const newBalance = Math.max(0, profile.credits - credits);
  const { error: updateErr } = await supabaseAdmin
    .from("profiles")
    .update({ credits: newBalance })
    .eq("id", req.userId);

  if (updateErr) return res.status(500).json({ error: updateErr.message });

  // Increment total_credits_used (non-fatal)
  await supabaseAdmin.rpc("increment_credits_used", {
    p_user_id: req.userId,
    p_amount:  credits,
  }).then(() => {}).catch(() => {});

  if (session_seconds && session_seconds > 0) {
    const now = new Date().toISOString();
    await supabaseAdmin.from("usage").insert({
      user_id:         req.userId,
      session_seconds: session_seconds,
      credits_used:    credits,
      ended_at:        now,
      created_at:      now,
    });
  }

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
app.post("/admin/login", (req, res) => {
  const { email, password } = req.body || {};
  const adminEmail = process.env.ADMIN_EMAIL    || "admin@tzurah.ai";
  const adminPass  = process.env.ADMIN_PASSWORD || "TzurahAdmin2025!";
  if (email === adminEmail && password === adminPass) {
    req.session.isAdmin     = true;
    req.session.adminEmail  = email;
    return res.json({ success: true });
  }
  res.status(401).json({ error: "Invalid credentials" });
});

// Admin logout
app.post("/admin/logout", (req, res) => {
  req.session.destroy(() => {});
  res.json({ success: true });
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

      const payload = {
        type:      "update",
        timestamp: Date.now(),
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
// started_at is only set on INSERT so duration is calculated correctly.
// Requires `kill_signal BOOLEAN DEFAULT false` column on sessions table:
//   ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS kill_signal BOOLEAN DEFAULT false;
app.post("/session/ping", async (req, res) => {
  const { user_id, email, credits_used } = req.body || {};
  console.log("[PING]", user_id, email || "no-email", new Date().toISOString());
  if (!user_id) return res.status(400).json({ error: "user_id required" });
  try {
    // Query WITHOUT is_active filter — find any existing row, most recent first
    const { data: existing, error: selErr } = await supabaseAdmin
      .from("sessions")
      .select("id, started_at, last_ping, kill_signal")
      .eq("user_id", user_id)
      .order("started_at", { ascending: false })
      .limit(1)
      .single();

    if (selErr && selErr.code !== "PGRST116") {
      console.warn("[PING] select error:", selErr.message);
    }

    if (existing) {
      // Check kill signal before updating
      if (existing.kill_signal) {
        console.log("[PING] KILL SIGNAL for user:", user_id);
        await supabaseAdmin.from("sessions").update({
          kill_signal: false,
          is_active:   false,
        }).eq("id", existing.id);
        return res.json({ ok: true, kill: true });
      }

      // If last_ping is older than 5 minutes, this is a new stream session —
      // reset started_at so the duration counter starts fresh.
      const now          = new Date().toISOString();
      const lastPing     = new Date(existing.last_ping || 0);
      const fiveMinAgo   = new Date(Date.now() - 5 * 60 * 1000);
      const isNewSession = lastPing < fiveMinAgo;

      console.log("[PING]", isNewSession ? "NEW session (reset started_at)" : "UPDATE", user_id);
      await supabaseAdmin.from("sessions").update({
        last_ping:    now,
        credits_used: Number(credits_used) || 0,
        email:        email || "unknown",
        is_active:    true,
        started_at:   isNewSession ? now : existing.started_at,
      }).eq("id", existing.id);
    } else {
      console.log("[PING] INSERT new session for user:", user_id);
      const now = new Date().toISOString();
      await supabaseAdmin.from("sessions").insert({
        user_id,
        email:        email || "unknown",
        started_at:   now,
        last_ping:    now,
        credits_used: Number(credits_used) || 0,
        is_active:    true,
      });
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
  const body   = req.body || {};
  const userId = body.userId || body.user_id;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    await supabaseAdmin.from("sessions")
      .update({ is_active: false, kill_signal: true })
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
