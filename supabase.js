/**
 * supabase.js — Shared Supabase client for the Electron main process  (CommonJS)
 *
 * Uses the anon key + manual session management because:
 *   - Electron's main process has no localStorage (Supabase's default store)
 *   - We manage token persistence ourselves via db.js
 *   - autoRefreshToken is disabled; electron.js handles token refresh explicitly
 */

"use strict";

require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.warn(
    "[supabase.js] SUPABASE_URL or SUPABASE_ANON_KEY is not set — " +
    "auth calls will fail. Check your .env file."
  );
}

const supabase = createClient(
  process.env.SUPABASE_URL  || "",
  process.env.SUPABASE_ANON_KEY || "",
  {
    auth: {
      persistSession:   false,   // we persist tokens in SQLite via db.js
      autoRefreshToken: false,   // we refresh manually in electron.js
      detectSessionInUrl: false,
    },
  }
);

module.exports = supabase;
