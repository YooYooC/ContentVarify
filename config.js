/* ============================================================
   Supabase connection settings.

   Fill these in with the values from your Supabase project:
     Dashboard → Project Settings → Data API (or "API")
       • Project URL      → url
       • anon / public key → anonKey

   The anon key is SAFE to ship in client-side code — it only grants
   what your Row Level Security policies allow (only the admin or an
   active member can read/write the shared data). Do NOT put the
   service_role key here — it lives only inside the admin-users Edge
   Function, which Supabase injects at runtime.

   Leave the placeholders as-is and the app runs purely on localStorage
   (no sync). See SUPABASE_SETUP.md for the full walkthrough.
   ============================================================ */
window.CV_SUPABASE = {
  url: "https://oqzmikjtphhhmcmajzvw.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9xem1pa2p0cGhoaG1jbWFqenZ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwNTIwMzIsImV4cCI6MjA5OTYyODAzMn0.fdrpBC0Jx3n8g4emmd0YCzJ8tAot0f7uG_tNzZDoyC8",

  // The only account that can approve/remove/invite. This just controls what
  // the UI shows — real enforcement lives in the is_admin() RLS policy, which
  // hardcodes the same address. Change BOTH if the admin ever changes.
  adminEmail: "yoyotsai2024@gmail.com"
};
