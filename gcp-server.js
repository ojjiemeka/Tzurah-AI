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

const express   = require("express");
const basicAuth = require("express-basic-auth");
const cors      = require("cors");
const path      = require("path");
const { createClient } = require("@supabase/supabase-js");

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

// ── Admin auth (express-basic-auth) ───────────────────────────────
const adminAuth = basicAuth({
  authorizer: (username, password) => {
    const adminEmail = process.env.ADMIN_EMAIL    || "admin@tzurah.ai";
    const adminPass  = process.env.ADMIN_PASSWORD || "TzurahAdmin2025!";
    // Constant-time compare to prevent timing attacks
    const userOk = basicAuth.safeCompare(username, adminEmail);
    const passOk = basicAuth.safeCompare(password, adminPass);
    return userOk & passOk;
  },
  challenge:  true,
  realm:      "Tzurah Admin",
});

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

// ── Admin: stats overview ─────────────────────────────────────────
app.get("/admin/api/stats", adminAuth, async (_req, res) => {
  const now   = Date.now();
  const day   = 86_400_000;
  const week  = 7 * day;
  const month = 30 * day;

  try {
    const [profilesRes, purchasesRes, usageRes] = await Promise.all([
      supabaseAdmin.from("profiles")
        .select("id, credits, total_credits_purchased, total_credits_used, created_at, last_seen"),
      supabaseAdmin.from("purchases").select("price_usd, credits_added, pack_name, created_at"),
      supabaseAdmin.from("usage").select("credits_used, session_seconds, created_at"),
    ]);

    const profiles  = profilesRes.data  || [];
    const purchases = purchasesRes.data || [];
    const usages    = usageRes.data     || [];

    const totalUsers      = profiles.length;
    const activeToday     = profiles.filter(p => p.last_seen && (now - new Date(p.last_seen).getTime()) < day).length;
    const newThisWeek     = profiles.filter(p => p.created_at && (now - new Date(p.created_at).getTime()) < week).length;
    const totalRevenue    = purchases.reduce((s, p) => s + (p.price_usd || 0), 0);
    const revenueMonth    = purchases.filter(p => (now - new Date(p.created_at).getTime()) < month)
                                     .reduce((s, p) => s + (p.price_usd || 0), 0);
    const revenueToday    = purchases.filter(p => (now - new Date(p.created_at).getTime()) < day)
                                     .reduce((s, p) => s + (p.price_usd || 0), 0);
    const totalCreditsUsed    = profiles.reduce((s, p) => s + (p.total_credits_used || 0), 0);
    const totalCreditsPurch   = purchases.reduce((s, p) => s + (p.credits_added || 0), 0);
    const totalSecondsUsed    = usages.reduce((s, u) => s + (u.session_seconds || 0), 0);
    // Decart cost estimate: $0.00625 per credit used (rough)
    const estimatedDecartCost = (totalCreditsUsed * 0.00625).toFixed(2);
    const avgCreditsPerUser   = totalUsers ? (totalCreditsUsed / totalUsers).toFixed(1) : "0";

    // Pack breakdown
    const packBreakdown = {};
    purchases.forEach(p => {
      const name = p.pack_name || "Unknown";
      if (!packBreakdown[name]) packBreakdown[name] = { units: 0, revenue: 0, credits: 0 };
      packBreakdown[name].units++;
      packBreakdown[name].revenue += p.price_usd || 0;
      packBreakdown[name].credits += p.credits_added || 0;
    });

    res.json({
      ok: true,
      stats: {
        totalUsers, activeToday, newThisWeek,
        totalRevenue: totalRevenue.toFixed(2),
        revenueMonth: revenueMonth.toFixed(2),
        revenueToday: revenueToday.toFixed(2),
        totalCreditsUsed, totalCreditsPurch, totalSecondsUsed,
        estimatedDecartCost, avgCreditsPerUser,
        packBreakdown,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: users (paginated) ──────────────────────────────────────
app.get("/admin/api/users", adminAuth, async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit  = 20;
  const offset = (page - 1) * limit;
  const search = (req.query.search || "").toLowerCase().trim();

  try {
    const { data: profiles, error, count } = await supabaseAdmin
      .from("profiles")
      .select("id, display_name, credits, total_credits_purchased, total_credits_used, created_at, last_seen", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return res.status(500).json({ error: error.message });

    // Fetch emails from auth.users for this page
    const users = profiles || [];
    for (const u of users) {
      try {
        const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(u.id);
        u.email = authUser?.user?.email || "—";
      } catch { u.email = "—"; }
    }

    const filtered = search
      ? users.filter(u =>
          (u.email || "").toLowerCase().includes(search) ||
          (u.display_name || "").toLowerCase().includes(search)
        )
      : users;

    res.json({
      ok: true,
      users:  filtered,
      total:  count || 0,
      page,
      pages:  Math.ceil((count || 0) / limit),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: revenue chart (last 30 days) ───────────────────────────
app.get("/admin/api/revenue-chart", adminAuth, async (_req, res) => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  try {
    const { data } = await supabaseAdmin
      .from("purchases")
      .select("price_usd, created_at")
      .gte("created_at", thirtyDaysAgo)
      .order("created_at");

    const byDay = {};
    // Seed all 30 days with 0
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000);
      const key = d.toISOString().split("T")[0];
      byDay[key] = 0;
    }
    data?.forEach(p => {
      const day = p.created_at.split("T")[0];
      if (day in byDay) byDay[day] = (byDay[day] || 0) + (p.price_usd || 0);
    });

    res.json({ ok: true, chart: byDay });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: recent purchases ───────────────────────────────────────
app.get("/admin/api/purchases", adminAuth, async (req, res) => {
  const limit = parseInt(req.query.limit || "50", 10);
  try {
    const { data } = await supabaseAdmin
      .from("purchases")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    // Fetch emails
    const purchases = data || [];
    for (const p of purchases.slice(0, 20)) { // only first 20 for speed
      try {
        const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(p.user_id);
        p.email = authUser?.user?.email || "—";
      } catch { p.email = "—"; }
    }

    res.json({ ok: true, purchases });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: gift credits ───────────────────────────────────────────
app.post("/admin/api/gift-credits", adminAuth, async (req, res) => {
  const { user_id, credits, reason } = req.body || {};
  if (!user_id || typeof credits !== "number" || credits < 1) {
    return res.status(400).json({ error: "user_id and credits (≥1) required" });
  }

  try {
    const { data: profile, error: fetchErr } = await supabaseAdmin
      .from("profiles")
      .select("credits, total_credits_purchased")
      .eq("id", user_id)
      .single();

    if (fetchErr || !profile) return res.status(404).json({ error: "User not found" });

    await supabaseAdmin.from("profiles").update({
      credits:                 profile.credits + credits,
      total_credits_purchased: (profile.total_credits_purchased || 0) + credits,
    }).eq("id", user_id);

    await supabaseAdmin.from("purchases").insert({
      user_id,
      pack_name:         `Gift${reason ? ": " + reason : ""}`,
      price_usd:         0,
      credits_added:     credits,
      stripe_payment_id: `gift_${Date.now()}`,
      created_at:        new Date().toISOString(),
    });

    console.log(`[Tzurah] Admin gifted ${credits} credits to ${user_id}${reason ? " ("+reason+")" : ""}`);
    res.json({ ok: true, new_balance: profile.credits + credits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: deduct credits ─────────────────────────────────────────
app.post("/admin/api/deduct-credits", adminAuth, async (req, res) => {
  const { user_id, credits, reason } = req.body || {};
  if (!user_id || typeof credits !== "number" || credits < 1) {
    return res.status(400).json({ error: "user_id and credits (≥1) required" });
  }

  try {
    const { data: profile, error: fetchErr } = await supabaseAdmin
      .from("profiles").select("credits").eq("id", user_id).single();

    if (fetchErr || !profile) return res.status(404).json({ error: "User not found" });

    const newBalance = Math.max(0, profile.credits - credits);
    await supabaseAdmin.from("profiles")
      .update({ credits: newBalance }).eq("id", user_id);

    console.log(`[Tzurah] Admin deducted ${credits} credits from ${user_id}${reason ? " ("+reason+")" : ""}`);
    res.json({ ok: true, new_balance: newBalance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: ban user ───────────────────────────────────────────────
app.post("/admin/api/ban-user", adminAuth, async (req, res) => {
  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: "user_id required" });

  try {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(user_id, {
      ban_duration: "87600h", // ~10 years
    });
    if (error) return res.status(500).json({ error: error.message });

    console.log(`[Tzurah] Admin banned user ${user_id}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: unban user ─────────────────────────────────────────────
app.post("/admin/api/unban-user", adminAuth, async (req, res) => {
  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: "user_id required" });

  try {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(user_id, {
      ban_duration: "none",
    });
    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true });
  } catch (err) {
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
  console.log("  GET  /health                  → Health check");
  console.log("  GET  /decart/token            → Decart token proxy");
  console.log("  POST /credits/deduct          → Deduct credits");
  console.log("  POST /credits/sync            → Bulk usage sync");
  console.log("  POST /stripe/create-checkout  → Stripe checkout");
  console.log("  POST /stripe/webhook          → Stripe fulfillment");
  console.log("  GET  /admin                   → Admin dashboard (Basic Auth)");
  console.log("═══════════════════════════════════════════════════════\n");
});
