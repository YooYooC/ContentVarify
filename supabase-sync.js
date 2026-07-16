/* ============================================================
   Content Verify — email/password auth + shared data + admin panel.

   • Sign in with email + PASSWORD (no magic links / email).
   • Accounts are created only by the admin (public sign-up is disabled),
     through the admin-users Edge Function — the service-role key never
     touches the browser.
   • ONE shared dataset; every ACTIVE member edits it together, live.
   • Admin (config.adminEmail) gets a member-management panel:
       view · add (email + temp password) · reset password ·
       deactivate / reactivate · delete.

   Degrades to a no-op (pure localStorage, no gate) when the library or
   config is missing, so the app still works offline / opened from disk.
   ============================================================ */
(function () {
  "use strict";

  var cfg = window.CV_SUPABASE || {};
  var gate = document.getElementById("gate");
  var host = document.getElementById("authbar");
  var ADMIN_EMAIL = (cfg.adminEmail || "").toLowerCase();
  var TABLE = "shared_state";
  var ROW_ID = "main";
  var FN = "admin-users";

  function bar(html) { if (host) host.innerHTML = html; }
  function status(txt) { var el = document.getElementById("cv-status"); if (el) el.textContent = txt; }
  function showGate() { if (gate) gate.classList.remove("hidden"); }
  function hideGate() { if (gate) { gate.classList.add("hidden"); gate.innerHTML = ""; } }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function isEmpty(s) {
    if (!s) return true;
    return (!s.items || Object.keys(s.items).length === 0) && (!s.quality || s.quality.length === 0);
  }

  // --- Guard: not configured → local-only, no gate. ---
  var unset = !cfg.url || !cfg.anonKey ||
    cfg.url.indexOf("YOUR-PROJECT") >= 0 || cfg.anonKey.indexOf("YOUR-") >= 0;
  if (!window.supabase || unset) {
    hideGate();
    bar('<span class="auth-note">Cloud sync off · set your keys in config.js</span>');
    return;
  }

  var sb = window.supabase.createClient(cfg.url, cfg.anonKey);

  var user = null, isAdmin = false;
  var pushTimer = null, lastSyncedJson = null;
  var sharedCh = null, myMemberCh = null, membersCh = null;
  var dataSyncing = false;

  /* =========================================================
     GATE — sign-in (email + password) and status screens
     ========================================================= */
  function gateShell(inner) {
    var admin = cfg.adminEmail || "the admin";
    showGate();
    gate.innerHTML = '<div class="gate-card">' + inner + "</div>" +
      '<p class="gate-foot">Admin · ' + esc(admin) + "</p>";
  }

  function renderSignin(errMsg) {
    var admin = cfg.adminEmail || "the admin";
    gateShell(
      '<div class="gate-emblem">◎</div>' +
      '<h1 class="gate-title">Content Verify</h1>' +
      '<p class="gate-sub">Sign in to the shared bias library.</p>' +
      '<form id="gate-form" class="gate-form">' +
        '<input id="gate-email" class="gate-input" type="email" placeholder="you@email.com" autocomplete="email" required>' +
        '<input id="gate-pass" class="gate-input" type="password" placeholder="Password" autocomplete="current-password" required>' +
        '<button class="gate-btn" type="submit">Sign in</button>' +
      '</form>' +
      '<p class="gate-error' + (errMsg ? "" : " hidden") + '" id="gate-err">' + esc(errMsg || "") + '</p>' +
      '<p class="gate-note">Accounts are created by the admin. Contact ' + esc(admin) + ' for access.</p>'
    );
    var form = document.getElementById("gate-form");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var email = (document.getElementById("gate-email").value || "").trim();
      var pass = document.getElementById("gate-pass").value || "";
      if (!email || !pass) return;
      var btn = form.querySelector("button");
      btn.disabled = true; btn.textContent = "Signing in…";
      sb.auth.signInWithPassword({ email: email, password: pass }).then(function (r) {
        if (r.error) {
          btn.disabled = false; btn.textContent = "Sign in";
          showErr(r.error.message);
        }
        // success → onAuthStateChange handles it
      });
    });
  }
  function showErr(msg) {
    var el = document.getElementById("gate-err");
    if (el) { el.textContent = msg; el.classList.remove("hidden"); }
  }

  function renderNoAccess() {
    var admin = cfg.adminEmail || "the admin";
    gateShell(
      '<div class="gate-emblem">⛔</div>' +
      '<h1 class="gate-title">No access</h1>' +
      '<p class="gate-sub">Your account isn\'t active. Contact ' + esc(admin) +
        ' if you think this is a mistake.</p>' +
      '<button class="gate-btn secondary" id="gate-signout">Sign out</button>'
    );
    var out = document.getElementById("gate-signout");
    if (out) out.addEventListener("click", function () { sb.auth.signOut(); });
  }

  /* =========================================================
     MEMBERSHIP / ACCESS
     ========================================================= */
  function getMember(uid) {
    return sb.from("members").select("active").eq("user_id", uid).maybeSingle()
      .then(function (r) {
        if (r.error) { console.error("[members] read", r.error); return null; }
        return r.data;
      });
  }

  function handleUser(u) {
    user = u;
    isAdmin = ADMIN_EMAIL && String(u.email).toLowerCase() === ADMIN_EMAIL;
    if (isAdmin) { grantAccess(); return; }
    watchMyMembership();
    getMember(u.id).then(function (row) {
      if (row && row.active) grantAccess();
      else { stopDataSync(); renderNoAccess(); }
    });
  }

  function watchMyMembership() {
    if (myMemberCh) return;
    myMemberCh = sb.channel("me_" + user.id)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "members", filter: "user_id=eq." + user.id },
        function (msg) {
          var row = msg.new || {};
          if (msg.eventType === "DELETE" || row.active === false) {
            stopDataSync(); renderNoAccess();
          } else if (row.active === true) {
            grantAccess();
          }
        })
      .subscribe();
  }

  function grantAccess() {
    hideGate();
    renderAuthbar();
    startDataSync();
    if (isAdmin) subscribeMembers();
  }

  /* =========================================================
     SHARED DATA SYNC (unchanged behaviour)
     ========================================================= */
  function pull() {
    return sb.from(TABLE).select("state, updated_at").eq("id", ROW_ID).maybeSingle()
      .then(function (r) {
        if (r.error) { console.error("[sync] pull", r.error); return null; }
        return r.data;
      });
  }
  function pushNow(payload) {
    if (!user) return Promise.resolve();
    lastSyncedJson = JSON.stringify(payload);
    status("saving…");
    return sb.from(TABLE).upsert({
      id: ROW_ID, state: payload, updated_at: new Date().toISOString(), updated_by: user.id
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
  function startDataSync() {
    if (dataSyncing) return;
    dataSyncing = true;
    pull().then(function (remote) {
      var remoteState = remote && remote.state;
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
      subscribeShared();
    });
  }
  function stopDataSync() {
    dataSyncing = false;
    if (window.CVApp) window.CVApp._onSave = null;
    if (sharedCh) { sb.removeChannel(sharedCh); sharedCh = null; }
  }
  function subscribeShared() {
    if (sharedCh) { sb.removeChannel(sharedCh); sharedCh = null; }
    sharedCh = sb.channel("shared_state")
      .on("postgres_changes",
        { event: "*", schema: "public", table: TABLE, filter: "id=eq." + ROW_ID },
        function (msg) {
          var row = msg.new;
          if (!row || !row.state) return;
          var json = JSON.stringify(row.state);
          if (json === lastSyncedJson) return;
          lastSyncedJson = json;
          if (window.CVApp) window.CVApp.replaceState(row.state);
          status("updated by someone");
        })
      .subscribe();
  }

  /* =========================================================
     AUTH BAR (in-app)
     ========================================================= */
  function renderAuthbar() {
    bar('<span class="auth-status" id="cv-status">synced</span>' +
        (isAdmin ? '<button class="auth-btn ghost" id="cv-admin" type="button">Admin</button>' : "") +
        '<span class="auth-who" title="' + esc(user.email) + '">' + esc(user.email) + '</span>' +
        '<button class="auth-btn ghost" id="cv-signout" type="button">Sign out</button>');
    var so = document.getElementById("cv-signout");
    if (so) so.addEventListener("click", function () { sb.auth.signOut(); });
    var ad = document.getElementById("cv-admin");
    if (ad) ad.addEventListener("click", openAdmin);
  }

  /* =========================================================
     ADMIN PANEL — all mutations via the admin-users function
     ========================================================= */
  var adminOpen = false;

  // Invoke the Edge Function; returns { data } or { error: message }.
  function callAdmin(payload) {
    return sb.functions.invoke(FN, { body: payload }).then(function (res) {
      if (res.error) {
        var msg = res.error.message || "Request failed";
        var ctx = res.error.context;
        if (ctx && typeof ctx.json === "function") {
          return ctx.json().then(function (j) {
            return { error: (j && j.error) || msg };
          }).catch(function () { return { error: msg }; });
        }
        return { error: msg };
      }
      if (res.data && res.data.error) return { error: res.data.error };
      return { data: res.data };
    });
  }

  function subscribeMembers() {
    if (membersCh) return;
    membersCh = sb.channel("members_all")
      .on("postgres_changes", { event: "*", schema: "public", table: "members" },
        function () { if (adminOpen) loadAdmin(); })
      .subscribe();
  }

  function openAdmin() {
    if (document.getElementById("admin-modal")) return;
    var wrap = document.createElement("div");
    wrap.id = "admin-modal";
    wrap.className = "admin-modal";
    wrap.innerHTML =
      '<div class="admin-card">' +
        '<div class="admin-head"><h2>Manage members</h2>' +
          '<button class="admin-x" id="admin-close" type="button">✕</button></div>' +
        '<div class="admin-body" id="admin-body">Loading…</div>' +
      '</div>';
    document.body.appendChild(wrap);
    adminOpen = true;
    wrap.addEventListener("click", function (e) { if (e.target === wrap) closeAdmin(); });
    document.getElementById("admin-close").addEventListener("click", closeAdmin);
    loadAdmin();
  }
  function closeAdmin() {
    var w = document.getElementById("admin-modal");
    if (w) w.remove();
    adminOpen = false;
  }

  function loadAdmin() {
    var body = document.getElementById("admin-body");
    if (!body) return;
    callAdmin({ action: "list" }).then(function (res) {
      if (res.error) { body.innerHTML = '<p class="admin-empty err">' + esc(res.error) + "</p>"; return; }
      var members = (res.data && res.data.members) || [];

      var rows = members.map(function (m) {
        var me = user && m.user_id === user.id;
        var badge = m.active
          ? '<span class="mbadge on">active</span>'
          : '<span class="mbadge off">inactive</span>';
        var actions = me ? '<span class="admin-hint">you (admin)</span>' :
          btn("reset", "Reset password", "") +
          (m.active ? btn("deactivate", "Deactivate", "danger")
                    : btn("reactivate", "Reactivate", "up")) +
          btn("delete", "Delete", "danger");
        return '<div class="admin-row" data-uid="' + esc(m.user_id) + '" data-email="' + esc(m.email) + '">' +
          '<span class="admin-email">' + esc(m.email) + " " + badge + "</span>" +
          '<span class="admin-actions">' + actions + "</span></div>";
      }).join("");

      body.innerHTML =
        section("Add member",
          '<form id="add-form" class="add-form">' +
            '<input id="add-email" class="admin-input" type="email" placeholder="name@email.com" required>' +
            '<input id="add-pass" class="admin-input" type="text" placeholder="temporary password" required>' +
            '<button class="admin-btn up" type="submit">Add</button>' +
          '</form>' +
          '<p class="admin-hint">They sign in with this email + temporary password. ' +
            'You can reset it any time below.</p>') +
        section("Members", rows || empty("No members yet — add one above.")) +
        '<p class="admin-msg" id="admin-msg"></p>';

      wireAdmin(body);
    });
  }

  function section(title, inner) { return '<section class="admin-sec"><h3>' + title + "</h3>" + inner + "</section>"; }
  function empty(t) { return '<p class="admin-empty">' + t + "</p>"; }
  function btn(act, label, cls) {
    return '<button class="admin-btn ' + cls + '" data-act="' + act + '" type="button">' + label + "</button>";
  }
  function msg(text, err) {
    var el = document.getElementById("admin-msg");
    if (el) { el.textContent = text; el.className = "admin-msg" + (err ? " err" : " ok"); }
  }

  function wireAdmin(body) {
    var addForm = document.getElementById("add-form");
    if (addForm) addForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var email = (document.getElementById("add-email").value || "").trim().toLowerCase();
      var pass = (document.getElementById("add-pass").value || "").trim();
      if (!email || !pass) return;
      var b = addForm.querySelector("button"); b.disabled = true; b.textContent = "Adding…";
      callAdmin({ action: "create", email: email, password: pass }).then(function (res) {
        b.disabled = false; b.textContent = "Add";
        if (res.error) msg(res.error, true);
        else { msg("Added " + email + ".", false); loadAdmin(); }
      });
    });

    body.querySelectorAll(".admin-row").forEach(function (row) {
      var uid = row.getAttribute("data-uid");
      var email = row.getAttribute("data-email");
      row.querySelectorAll("button[data-act]").forEach(function (b) {
        b.addEventListener("click", function () {
          var act = b.getAttribute("data-act");
          if (act === "delete") {
            if (!window.confirm("Delete " + email + "? This removes their login permanently.")) return;
            run({ action: "delete", user_id: uid }, "Deleted " + email + ".");
          } else if (act === "deactivate") {
            run({ action: "deactivate", user_id: uid }, email + " deactivated.");
          } else if (act === "reactivate") {
            run({ action: "reactivate", user_id: uid }, email + " reactivated.");
          } else if (act === "reset") {
            var np = window.prompt("New temporary password for " + email + " (6+ characters):");
            if (!np) return;
            run({ action: "reset_password", user_id: uid, password: np }, "Password reset for " + email + ".");
          }
        });
      });
    });
  }
  function run(payload, okText) {
    msg("Working…", false);
    callAdmin(payload).then(function (res) {
      if (res.error) msg(res.error, true);
      else { msg(okText, false); loadAdmin(); }
    });
  }

  /* =========================================================
     BOOTSTRAP
     ========================================================= */
  sb.auth.getSession().then(function (r) {
    var s = r.data && r.data.session;
    if (s && s.user) handleUser(s.user);
    else renderSignin();
  });

  sb.auth.onAuthStateChange(function (event, session) {
    if (session && session.user) {
      if (!user || user.id !== session.user.id) handleUser(session.user);
    } else {
      user = null; isAdmin = false; lastSyncedJson = null;
      stopDataSync();
      if (myMemberCh) { sb.removeChannel(myMemberCh); myMemberCh = null; }
      if (membersCh) { sb.removeChannel(membersCh); membersCh = null; }
      closeAdmin();
      bar("");
      renderSignin();
    }
  });
})();
