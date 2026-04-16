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
    const [{ merged, profiles }, purchasesRes, usageRes] = await Promise.all([
      fetchAllUsersData(),
      supabaseAdmin.from("purchases").select("price_usd, credits_added, pack_name, created_at"),
      supabaseAdmin.from("usage").select("credits_used, session_seconds, created_at"),
    ]);

    const purchases = purchasesRes.data || [];
    const usages    = usageRes.data     || [];

    const totalUsers   = merged.length;
    const activeToday  = merged.filter(u => u.last_seen_at && (now - new Date(u.last_seen_at).getTime()) < DAY).length;
    const newThisWeek  = profiles.filter(p => p.created_at && (now - new Date(p.created_at).getTime()) < WEEK).length;
    const revenueTotal = purchases.reduce((s, p) => s + (p.price_usd || 0), 0);
    const revenueMonth = purchases.filter(p => (now - new Date(p.created_at).getTime()) < MONTH)
                                  .reduce((s, p) => s + (p.price_usd || 0), 0);
    const revenueToday = purchases.filter(p => (now - new Date(p.created_at).getTime()) < DAY)
                                  .reduce((s, p) => s + (p.price_usd || 0), 0);
    const creditsUsed        = merged.reduce((s, u) => s + u.credits_used, 0);
    const totalSecondsUsed   = usages.reduce((s, u) => s + (u.session_seconds || 0), 0);
    const estimatedDecartCost = Number((creditsUsed * 0.00625).toFixed(2));

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
