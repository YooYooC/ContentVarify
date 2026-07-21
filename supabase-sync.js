/* ============================================================
   Content Verify — shared cross-device sync via Supabase.

   • ONE shared dataset. Every device that opens the app reads and
     writes it together, live — no login, no accounts, no admin.
   • Local edits are pushed (debounced); remote edits arrive over
     realtime and repaint the page.

   Degrades to a no-op (pure localStorage) when the Supabase library
   or config is missing, so the app still works offline / from disk.
   ============================================================ */
(function () {
  "use strict";

  var cfg = window.CV_SUPABASE || {};
  var host = document.getElementById("authbar");
  var TABLE = "shared_state";
  var ROW_ID = "main";

  function status(txt) {
    if (host) host.innerHTML = '<span class="auth-status" id="cv-status">' + txt + "</span>";
  }
  function isEmpty(s) {
    if (!s) return true;
    return (!s.items || Object.keys(s.items).length === 0) &&
           (!s.quality || s.quality.length === 0);
  }

  // --- Guard: not configured → local-only, no sync. ---
  var unset = !cfg.url || !cfg.anonKey ||
    cfg.url.indexOf("YOUR-PROJECT") >= 0 || cfg.anonKey.indexOf("YOUR-") >= 0;
  if (!window.supabase || unset) {
    status("Cloud sync off · set your keys in config.js");
    return;
  }

  var sb = window.supabase.createClient(cfg.url, cfg.anonKey);
  var pushTimer = null, pullRetry = null, lastSyncedJson = null, ch = null;

  // Resolves { row } on success (row may be null = no row yet) or { error }.
  // A FAILED pull must never be mistaken for "the cloud is empty", or we'd
  // push our local copy over everyone else's.
  function pull() {
    return sb.from(TABLE).select("state").eq("id", ROW_ID).maybeSingle()
      .then(function (r) {
        if (r.error) { console.error("[sync] pull", r.error); return { error: r.error }; }
        return { row: r.data };
      }, function (e) {
        console.error("[sync] pull", e);
        return { error: e };
      });
  }

  function pushNow(payload) {
    lastSyncedJson = JSON.stringify(payload);
    status("saving…");
    return sb.from(TABLE).upsert({
      id: ROW_ID, state: payload, updated_at: new Date().toISOString()
    }, { onConflict: "id" }).then(function (r) {
      if (r.error) { console.error("[sync] push", r.error); status("sync error"); }
      else status("synced");
    });
  }

  function schedulePush(payload) {
    var json = JSON.stringify(payload);
    if (json === lastSyncedJson) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { pushNow(payload); }, 1000);
  }

  function start() {
    pull().then(function (res) {
      // Couldn't read the shared row. Stay read-only and retry: adopting
      // nothing is recoverable, but pushing over good cloud data is not.
      if (res.error) {
        status("can't reach the shared copy — retrying…");
        clearTimeout(pullRetry);
        pullRetry = setTimeout(start, 5000);
        return;
      }

      var remoteState = res.row && res.row.state;
      var local = window.CVApp ? window.CVApp.getState() : null;
      if (remoteState && !isEmpty(remoteState)) {
        lastSyncedJson = JSON.stringify(remoteState);
        if (window.CVApp) window.CVApp.replaceState(remoteState);
        status("synced");
      } else if (local && !isEmpty(local)) {
        pushNow(local);
      } else {
        lastSyncedJson = JSON.stringify(remoteState || { items: {}, quality: [] });
        status("synced");
      }
      if (window.CVApp) window.CVApp._onSave = function (p) { schedulePush(p); };
      subscribe();
    });
  }

  function subscribe() {
    if (ch) { sb.removeChannel(ch); ch = null; }
    ch = sb.channel("shared_state")
      .on("postgres_changes",
        { event: "*", schema: "public", table: TABLE, filter: "id=eq." + ROW_ID },
        function (msg) {
          var row = msg.new;
          if (!row || !row.state) return;
          var json = JSON.stringify(row.state);
          if (json === lastSyncedJson) return;   // our own echo
          lastSyncedJson = json;
          if (window.CVApp) window.CVApp.replaceState(row.state);
          status("updated on another device");
        })
      .subscribe();
  }

  start();
})();
