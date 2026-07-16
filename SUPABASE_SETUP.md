# Content Verify — Supabase setup (email + password)

A private collaborative tool. Everyone signs in with **email + password**;
**only the admin** (`yoyotsai2024@gmail.com`) can create, deactivate, delete, or
reset users, from an in-app **Manage members** panel. Public sign-up is off. All
active members edit **one shared dataset** with live realtime sync.

The Supabase **service-role key never appears in the frontend** — user creation
and deletion run inside the `admin-users` Edge Function, where Supabase injects
that key at runtime.

---

## A. One-time dashboard setup

### 1. Disable public sign-up
**Authentication → Providers → Email**:
- **Enable Email provider**: ON
- **Confirm email**: OFF  (the admin creates users pre-confirmed)
- **Allow new users to sign up**: **OFF**  ← important; only the admin makes users
- Save.

### 2. Create your admin account
**Authentication → Users → Add user**:
- Email: `yoyotsai2024@gmail.com`
- Password: (choose one)
- **Auto Confirm User**: ON
- Create. This is the only account with admin powers (matched by email in RLS
  and in the Edge Function).

### 3. Run the SQL
**SQL Editor → New query** → paste all of
[`supabase/schema.sql`](supabase/schema.sql) → **Run**. It creates `members`,
the `is_admin()` / `is_approved()` policies, keeps `shared_state` + realtime, and
removes the old magic-link tables. Safe to re-run; your shared data is preserved.

### 4. Deploy the Edge Function
The function is at [`supabase/functions/admin-users/index.ts`](supabase/functions/admin-users/index.ts).

**Option A — Supabase CLI (recommended):**
```bash
# one-time
brew install supabase/tap/supabase        # or: npm i -g supabase
supabase login
supabase link --project-ref oqzmikjtphhhmcmajzvw

# deploy
supabase functions deploy admin-users
```

**Option B — Dashboard:** **Edge Functions → Create a function** → name it
exactly `admin-users` → paste the contents of `index.ts` → Deploy.

No secrets to configure: Supabase automatically provides `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` to the function. **Never**
put the service-role key in `config.js` or the repo.

### 5. config.js
Already set: your `url`, `anonKey`, and `adminEmail`. Nothing secret here.

---

## B. Serve the app
```bash
python3 -m http.server 8000   # → http://localhost:8000
```
For real use, host the folder on Netlify / Vercel / Cloudflare Pages / GitHub
Pages (static, free). Password auth works on any origin — no Site-URL/redirect or
email delivery needed anymore.

---

## C. Test it end-to-end

### Log in as admin
1. Open the app → white/pink **Sign in** screen.
2. Enter `yoyotsai2024@gmail.com` + the password from step A.2 → **Sign in**.
3. You land in the app with an **Admin** button in the top-right.

### Add a collaborator
4. Click **Admin** → under **Add member**, type their email + a temporary
   password → **Add**. They appear in the Members list marked **active**.

### Log in as that collaborator
5. Open the app in a private/incognito window → sign in with that email +
   temporary password → they see the shared dataset.
6. Edit something in one window → it updates live in the other.

### Reset / deactivate / delete
7. Back in the admin window → **Admin**:
   - **Reset password** → enter a new temporary password for them.
   - **Deactivate** → their window drops to "No access" live, and they can no
     longer read/write the data. **Reactivate** restores it.
   - **Delete** → removes their login permanently (their `members` row is
     cascaded away).

---

## How it fits together
| Piece | Role |
|---|---|
| `index.html` | `#gate` overlay + app DOM |
| `config.js` | URL, anon key, adminEmail (no secrets) |
| `supabase-sync.js` | password sign-in, access gate, admin panel, shared sync |
| `app.js` | unchanged; exposes `window.CVApp` |
| `supabase/schema.sql` | `members`, RLS, `shared_state`, realtime |
| `supabase/functions/admin-users/index.ts` | admin-only user create/delete/deactivate/reset |

## Security notes
- **Admin is enforced twice**: RLS (`is_admin()` on the DB) *and* an email check
  inside the Edge Function. A non-admin calling the function gets `403`.
- **Deactivate is immediate**: RLS (`is_approved`) blocks data access on the next
  request, and the login is banned.
- **Service-role key** never leaves Supabase's servers.
- **Shared data is shared**: any active member can edit or reset it; last save
  wins on simultaneous edits (realtime keeps copies fresh between edits).

## If something errors
Open the browser console (Cmd+Option+J) and watch for `[members]`, `[sync]`, or
admin-panel messages. Common ones:
- *“Forbidden — admin only.”* → you're not signed in as `yoyotsai2024@gmail.com`.
- *Function 404 / not found* → the `admin-users` function isn't deployed (step A.4).
- *Sign-in “Invalid login credentials”* → wrong password, or the user was never
  created / was deleted.
