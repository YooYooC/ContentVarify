# Content Verify — Supabase setup (shared sync, no login)

Every device that opens the app shares **one dataset** with live realtime
sync. There are **no accounts, no admin, no membership** — anyone with the
app URL can read and edit the shared data.

---

## A. One-time setup

### 1. Run the SQL
**SQL Editor → New query** → paste all of
[`supabase/schema.sql`](supabase/schema.sql) → **Run**.

It creates the `shared_state` table, opens read/write access, enables
realtime, and removes the old auth/admin/membership machinery. Safe to
re-run; your shared data is preserved.

### 2. config.js
Already set: your `url` and `anonKey`. Nothing secret here — the anon key
is meant to ship in the browser.

That's it. No Edge Function, no user creation, no dashboard auth settings.

---

## B. Serve the app
```bash
python3 -m http.server 8000   # → http://localhost:8000
```
For real use, host the folder on Netlify / Vercel / Cloudflare Pages /
GitHub Pages (static, free).

---

## C. Test cross-device sync
1. Open the app on device A → top-right shows **synced**.
2. Open the app on device B (or a second browser).
3. Edit something on A → it appears on B within a second (and vice-versa),
   with a brief **updated on another device** note.

---

## How it fits together
| Piece | Role |
|---|---|
| `index.html` | app DOM |
| `config.js` | Supabase URL + anon key (no secrets) |
| `supabase-sync.js` | pull / push / realtime for the shared dataset |
| `app.js` | unchanged; exposes `window.CVApp` |
| `supabase/schema.sql` | `shared_state` table, open RLS, realtime |

## Notes
- **The data is public to anyone with the app.** There is no login by
  design. If you later want it private, put the app behind a host-level
  password (e.g. Netlify/Cloudflare Access) or add Supabase auth back.
- **Last save wins** on simultaneous edits; realtime keeps every open
  device fresh between edits.

## If something errors
Open the browser console (Cmd+Option+J) and watch for `[sync]` messages.
- *"permission denied for table shared_state"* → the SQL in step A.1 wasn't
  run (or didn't grant `anon`). Re-run it.
- *"can't reach the shared copy — retrying…"* → network/URL issue; check
  `config.js` `url` and that the project is up.
