# Tzurah Live - Coding Rules & Patterns

## THE GOLDEN RULES
These rules exist because this is a stable production build.
Breaking them will break the app. Follow them exactly.

### Rule 1: File Boundary
NEVER push these to git:
  electron.js, preload.js, index.html,
  server.mjs, db.js, florence-worker.js

ALWAYS push these via git-update.sh:
  gcp-server.js, admin.html, admin-login.html

### Rule 2: Supabase v2 Pattern
NEVER chain .catch() on Supabase queries. ALWAYS use:
```javascript
// CORRECT
const { data, error } = await supabaseAdmin
  .from('table')
  .select('*')
  .eq('id', id)
  .maybeSingle()  // use maybeSingle() not single()

if (error) console.warn('Query error:', error.message)
if (!data) return res.status(404).json({ error: 'Not found' })

// WRONG - will crash
supabaseAdmin.from('table').select().catch(err => {})
```

### Rule 3: Profiles Table Has NO Email Column
```javascript
// WRONG - will throw "column profiles.email does not exist"
const { data } = await supabaseAdmin
  .from('profiles')
  .select('id, email, credits')  // no email column

// CORRECT - get email from auth
const { data: profile } = await supabaseAdmin
  .from('profiles')
  .select('id, credits, display_name')

const { data: authData } = await supabaseAdmin
  .auth.admin.getUserById(userId)
const email = authData?.user?.email
```

### Rule 4: Sessions Table Has Email Column Directly
```javascript
// Sessions table HAS email stored directly
const { data } = await supabaseAdmin
  .from('sessions')
  .select('session_id, user_id, email, is_active, started_at')
// No join needed for email on sessions
```

### Rule 5: Never Break Existing Working Features
Before changing any function:
1. Read the entire function first
2. Identify what calls it
3. Only change what's needed
4. Test mentally - will this break any other feature?

### Rule 6: Credit System is Financial
Any change to credit deduction, session timing, or
Decart balance tracking must be treated as financial code.
Always add:
- Null/NaN guards on all numbers
- Max sanity checks (never deduct > 10 min worth)
- Logging for every deduction
- Idempotency (safe to call twice)

### Rule 7: One Mega Prompt Per Session
All related changes go in one prompt to Claude Code.
Never split related changes across multiple prompts -
it causes partial states and breaks the app.

## Coding Patterns

### IPC Pattern (Electron)
```javascript
// electron.js - handler
ipcMain.handle('channel:action', async (event, data) => {
  try {
    const result = await doSomething(data)
    return { success: true, data: result }
  } catch(err) {
    console.error('[IPC] channel:action failed:', err.message)
    return { success: false, error: err.message }
  }
})

// preload.js - expose
contextBridge.exposeInMainWorld('tzurah', {
  actionName: (data) => ipcRenderer.invoke('channel:action', data)
})

// index.html - use
const result = await window.tzurah.actionName(data)
```

### Admin API Pattern (gcp-server.js)
```javascript
app.post('/admin/api/resource', requireAdmin, async (req, res) => {
  // 1. Check permissions
  if (!can(req.session.adminRole, 'permission_name')) {
    await logAction('unauthorized_attempt', ...)
    return res.status(403).json({ error: 'Insufficient permissions' })
  }

  // 2. Validate input
  const { field } = req.body
  if (!field) return res.status(400).json({ error: 'field required' })

  // 3. Do work with try/catch
  try {
    const { data, error } = await supabaseAdmin
      .from('table')
      .update({ field })
      .eq('id', id)
      .select()
      .single()

    if (error) throw new Error(error.message)

    // 4. Log the action
    await logAction('action_name', req.session.adminEmail,
      req.session.adminRole, targetUserId,
      { relevant: 'details' }, req)

    // 5. Return success
    return res.json({ success: true, data })

  } catch(err) {
    console.error('[ENDPOINT] Error:', err.message)
    return res.status(500).json({ error: err.message })
  }
})
```

### Feature Flag Check Pattern
```javascript
// In index.html
const flags = window._featureFlags || {}
if (!flags.enable_recording) {
  recordBtn.style.display = 'none'
}

// In gcp-server.js
const { data: flag } = await supabaseAdmin
  .from('feature_flags')
  .select('enabled')
  .eq('flag_name', 'flag_name')
  .maybeSingle()

if (!flag?.enabled) {
  return res.status(403).json({ error: 'Feature disabled' })
}
```

### Admin Flash Animation Pattern
```javascript
// Flash a table cell after updating it
function flashUserRow(userId, updates, action = 'default') {
  const colors = {
    gift: '#14532d', deduct: '#7c2d12', ban: '#7f1d1d',
    unban: '#14532d', purchase: '#1e3a5f',
    session: '#1e3a5f', default: '#14532d'
  }
  const color = colors[action] || colors.default
  const row = document.querySelector(`tr[data-uid="${userId}"]`)
  if (!row) return
  // Update cells then flash
}
```

### Error Display Pattern (index.html)
```javascript
// For session/streaming errors
addBellAlert('error', 'Error message here')

// For credit events
addBellAlert('credits', 'Credits message')

// For gifts/purchases
addBellAlert('gift', '+X credits added')

// For connection events
addBellAlert('connection', 'Connected/Disconnected')
```

## Admin Role Permissions
```
super_admin: ALL actions
admin:       view/manage users, gift/deduct/ban,
             announcements, packs, email, IP blocks
             CANNOT: delete users, sub-admins,
                     feature flags, settings
support:     view users, gift credits only
analyst:     view revenue/purchases only
```

## Known Gotchas
1. **profiles.email doesn't exist** - use auth.admin.getUserById()
2. **sessions.email exists directly** - no join needed
3. **Supabase .single() throws on 0 rows** - use .maybeSingle()
4. **BroadcastChannel won't work across Electron+OBS** - use WebSocket
5. **npm run electron crashes** - use npm run electron:dev
6. **Token is ek_xxx (session token)** - normal, generated from dct_xxx master key
7. **Bootstrap must succeed before app loads** - server.mjs starts first
8. **Credit sync is every 5s** - max 5s billing gap by design
9. **Decart watermark** - burned into stream, needs commercial plan removal
10. **app_settings table** - stores decart_balance, threshold, cost_per_second

## Testing Checklist Before Any Deploy
- [ ] Does the app start with npm run electron:dev?
- [ ] Can you login with test account?
- [ ] Does a 10s session deduct correct credits?
- [ ] Does admin panel load all tabs?
- [ ] Does git-update.sh only push server files?
- [ ] Are there any console errors on startup?
