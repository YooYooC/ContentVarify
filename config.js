/* ============================================================
   Supabase connection settings.

   Fill these in with the values from your Supabase project:
     Dashboard → Project Settings → Data API (or "API")
       • Project URL      → url
       • anon / public key → anonKey

   The anon key is SAFE to ship in client-side code. There is no login:
   every device shares one dataset, so anyone with the app URL can read
   and edit the shared data. Do NOT put a service_role key here.

   Leave the placeholders as-is and the app runs purely on localStorage
   (no sync). See SUPABASE_SETUP.md for the full walkthrough.
   ============================================================ */
window.CV_SUPABASE = {
  url: "https://oqzmikjtphhhmcmajzvw.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9xem1pa2p0cGhoaG1jbWFqenZ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwNTIwMzIsImV4cCI6MjA5OTYyODAzMn0.fdrpBC0Jx3n8g4emmd0YCzJ8tAot0f7uG_tNzZDoyC8"
};
