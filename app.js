(function () {
  "use strict";

  var DATA = window.BIAS_DATA;
  var grid = document.getElementById("grid");
  if (!DATA || !grid) {
    if (grid) grid.textContent = "Could not load bias data.";
    return;
  }

  var navbar = document.getElementById("navbar");
  var catTitle = document.getElementById("cat-title");
  var catMeta = document.getElementById("cat-meta");
  var searchInput = document.getElementById("search");
  var searchMeta = document.getElementById("searchMeta");
  var qualityBadge = document.getElementById("qualityBadge");
  var legend = document.querySelector(".legend");

  var QUADRANTS = DATA.quadrants || [];
  var OVERVIEW_Q = QUADRANTS.length; // synthetic "Full Picture" tab index

  /* ============================================================
     Persistence (no backend — everything lives in localStorage)
     ============================================================ */
  var STORE_KEY = "contentVerifyState.v1";
  var state = loadState();

  function loadState() {
    var base = { items: {}, quality: [] };
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        base.items = p.items || {};
        base.quality = p.quality || [];
      }
    } catch (e) {}
    return base;
  }
  function persistLocal() {
    try {
      localStorage.setItem(STORE_KEY,
        JSON.stringify({ items: state.items, quality: state.quality }));
    } catch (e) {}
  }
  function save() {
    persistLocal();
    // Notify the optional cloud-sync layer (supabase-sync.js) so the change
    // propagates to the user's other devices. No-op when sync isn't wired up.
    if (window.CVApp && typeof CVApp._onSave === "function") {
      try { CVApp._onSave({ items: state.items, quality: state.quality }); }
      catch (e) {}
    }
  }

  /* ------------------------------------------------------------
     Bridge for the optional cloud-sync layer. supabase-sync.js reads
     and writes state through this, so app.js stays backend-agnostic.
     ------------------------------------------------------------ */
  window.CVApp = {
    // Current persisted payload (exactly what save() writes).
    getState: function () {
      return { items: state.items, quality: state.quality };
    },
    // Adopt a copy pulled from the cloud, cache it locally, then repaint.
    // Uses persistLocal() (not save()) so adopting a remote copy never
    // bounces straight back out as a push.
    replaceState: function (incoming) {
      if (!incoming || typeof incoming !== "object") return;
      state.items = incoming.items || {};
      state.quality = incoming.quality || [];
      persistLocal();
      render();
      updateQualityBadge();
    },
    // Set by the sync layer; called after every local save() with the payload.
    _onSave: null
  };

  var view = { q: 0, c: 0 }; // current quadrant / category being shown

  /* ============================================================
     Index every example with a stable id so marks/edits survive
     reloads. id = "qi.ci.bi:p<idx>" (pos) or ":n<idx>" (neg).
     ============================================================ */
  var ITEMS = {};
  QUADRANTS.forEach(function (q, qi) {
    q.categories.forEach(function (c, ci) {
      c.biases.forEach(function (b, bi) {
        var biasId = qi + "." + ci + "." + bi;
        b.__id = biasId;
        b.__loc = { qi: qi, ci: ci, bi: bi, quad: q.name, cat: c.name };
        (b.positive || []).forEach(function (it, idx) {
          var id = biasId + ":p" + idx;
          it.__id = id;
          ITEMS[id] = { item: it, biasId: biasId };
        });
        (b.negative || []).forEach(function (it, idx) {
          var id = biasId + ":n" + idx;
          it.__id = id;
          ITEMS[id] = { item: it, biasId: biasId };
        });
      });
    });
  });

  /* ============================================================
     Bias color scale (matches the legend gradient)
       0 = white     (0% biased)        1 = dark pink (100% biased)
     ============================================================ */
  var STOPS = [
    [0.0, [255, 255, 255]],
    [0.25, [248, 204, 219]],
    [0.5, [236, 143, 174]],
    [0.75, [194, 53, 102]],
    [1.0, [122, 13, 52]],
  ];
  function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
  function colorFor(value) {
    value = Math.max(0, Math.min(1, value));
    for (var i = 1; i < STOPS.length; i++) {
      if (value <= STOPS[i][0]) {
        var lo = STOPS[i - 1], hi = STOPS[i];
        var t = (value - lo[0]) / (hi[0] - lo[0]);
        return "rgb(" + lerp(lo[1][0], hi[1][0], t) + "," +
                        lerp(lo[1][1], hi[1][1], t) + "," +
                        lerp(lo[1][2], hi[1][2], t) + ")";
      }
    }
    return "rgb(255,255,255)";
  }

  // Split a trailing "(Author, 1999)" citation off the example text.
  function splitCitation(text) {
    var m = text.match(/\s*(\([^()]*\b\d{4}[^()]*\))\s*$/);
    if (m) return { body: text.slice(0, m.index).trim(), cite: m[1] };
    return { body: text.trim(), cite: "" };
  }

  /* ============================================================
     Effective accessors — an item's current text/score honour any
     stored override; otherwise fall back to the original data.
     ============================================================ */
  function ov(id) { return state.items[id]; }
  function effText(item) {
    var o = ov(item.__id);
    return o && o.text != null ? o.text : item.text;
  }
  function effScore(item) {
    var o = ov(item.__id);
    var s = o && o.score != null ? o.score : item.score;
    return typeof s === "number" ? s : 50;
  }
  function isExcluded(item) {
    var o = ov(item.__id);
    return !!(o && o.excluded);
  }
  function histOf(item) {
    var o = ov(item.__id);
    return (o && o.history) || [];
  }

  /* ============================================================
     Scoring
       Average one single bias = (avg examples + inverse avg
       counter-examples) / 2, where inverse(x) = 100 - x.
       Crossed-out (excluded) items are dropped before averaging.
     ============================================================ */
  function mean(arr) {
    if (!arr.length) return null;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }
  function keptScores(list) {
    var out = [];
    (list || []).forEach(function (it) {
      if (!isExcluded(it)) out.push(effScore(it));
    });
    return out;
  }
  /* ----------------------------------------------------------------
     Algorithmic bias scorer.
     The score (0 = clear thinking … 100 = bias in full force) is
     produced from the text itself — never typed by the user. It is a
     deterministic lexical heuristic: assertive / fabrication / pattern-
     seeking language pushes the score up; hedging / evidence / base-rate
     language pulls it down. Re-run whenever an example is reformulated.
     ---------------------------------------------------------------- */
  var BIAS_UP = [
    ["invent", 12], ["fabricat", 14], ["made up", 12], ["make up", 10],
    ["making up", 10], ["confident", 12], ["obvious", 10], ["always", 8],
    ["never", 8], ["everyone", 8], ["definitely", 10], ["certainly", 9],
    ["clearly", 8], ["plausible", 9], ["assume", 8], ["believe", 7],
    ["imagine", 8], ["story", 6], ["stories", 6], ["false ", 8],
    ["pattern", 5], ["lucky", 6], ["fate", 6], ["meant to", 6],
    ["destined", 7], ["must be", 7], ["proves", 8], ["guarantee", 8]
  ];
  var BIAS_DOWN = [
    ["uncertain", 14], ["admit", 12], ["acknowledg", 12],
    ["don't remember", 14], ["don't know", 12], ["not sure", 12],
    ["check", 10], ["verif", 10], ["evidence", 12], ["data", 10],
    ["probabilit", 12], ["accurate", 12], ["true reason", 12],
    ["correctly", 10], ["rather than", 8], ["avoid", 6], ["notice", 6],
    ["recogniz", 8], ["recognis", 8], ["base rate", 12], ["random", 8],
    ["coincidence", 10], ["sample size", 10], ["actual", 6]
  ];
  function computeBiasScore(text) {
    var t = " " + String(text || "").toLowerCase() + " ";
    var score = 50;
    BIAS_UP.forEach(function (p) { if (t.indexOf(p[0]) >= 0) score += p[1]; });
    BIAS_DOWN.forEach(function (p) { if (t.indexOf(p[0]) >= 0) score -= p[1]; });
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  function avgBias(b) {
    var ex = mean(keptScores(b.positive));
    var ct = mean(keptScores(b.negative));
    if (ex != null && ct != null) return (ex + (100 - ct)) / 2;
    if (ex != null) return ex;          // only examples present
    if (ct != null) return 100 - ct;    // only counter-examples present
    return null;                        // nothing to score
  }
  function overallQuality() {
    var vals = [];
    QUADRANTS.forEach(function (q) {
      q.categories.forEach(function (c) {
        c.biases.forEach(function (b) {
          var a = avgBias(b);
          if (a != null) vals.push(a);
        });
      });
    });
    return mean(vals);
  }

  /* ---- quality change tracking ---- */
  function recordQuality() {
    var v = overallQuality();
    if (v == null) return;
    var h = state.quality;
    var last = h.length ? h[h.length - 1].value : null;
    // Record on any change. With ~240 biases a single edit barely moves the
    // global mean, so a threshold here would make change-tracking look dead.
    if (last == null || Math.abs(v - last) > 1e-9) {
      h.push({ ts: Date.now(), value: v });
      if (h.length > 400) h.shift();
      save();
    }
  }
  if (!state.quality.length) recordQuality();

  /* ============================================================
     Mutations
     ============================================================ */
  function getOv(id) {
    if (!state.items[id]) state.items[id] = {};
    return state.items[id];
  }
  function cleanOv(id) {
    var o = state.items[id];
    if (o && !o.excluded && o.text == null && o.score == null &&
        !(o.history && o.history.length)) {
      delete state.items[id];
    }
  }
  function afterMutation(id) {
    save();
    recordQuality();
    rebuildItem(id);
    refreshBias(ITEMS[id].biasId);
    updateQualityBadge();
    if (view.q === OVERVIEW_Q && !searching()) renderOverview();
  }
  function setExcluded(item, val) {
    var o = getOv(item.__id);
    if (val) o.excluded = true; else delete o.excluded;
    cleanOv(item.__id);
    afterMutation(item.__id);
  }
  function applyEdit(item, newText, newScore) {
    var curText = effText(item), curScore = effScore(item);
    if (newText === curText && newScore === curScore) return false;
    var o = getOv(item.__id);
    if (!o.history) o.history = [];
    o.history.push({ text: curText, score: curScore, ts: Date.now() });
    o.text = newText;
    o.score = newScore;
    afterMutation(item.__id);
    return true;
  }

  /* ============================================================
     Targeted DOM refresh registries (so toggling a mark doesn't
     collapse open cards or lose scroll position).
     ============================================================ */
  var itemNodes = {};   // id -> <li>
  var chipRefresh = {}; // biasId -> [fn,...]

  function rebuildItem(id) {
    var old = itemNodes[id];
    if (!old || !old.parentNode) return;
    var fresh = makeItem(ITEMS[id].item);
    old.parentNode.replaceChild(fresh, old);
  }
  function refreshBias(biasId) {
    var fns = chipRefresh[biasId];
    if (fns) fns.forEach(function (f) { f(); });
  }

  /* ============================================================
     Time helpers
     ============================================================ */
  function timeAgo(ts) {
    var s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return s + "s ago";
    var m = Math.round(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.round(m / 60);
    if (h < 24) return h + "h ago";
    return Math.round(h / 24) + "d ago";
  }

  /* ============================================================
     Example item rendering (text + score + mark + edit + history)
     ============================================================ */
  function makeItem(item) {
    var id = item.__id;
    var score = effScore(item);
    var excluded = isExcluded(item);
    var value = score / 100;

    var li = document.createElement("li");
    li.className = "ex-item" + (excluded ? " excluded" : "");
    li.dataset.id = id;
    if (!excluded) {
      li.style.background = colorFor(value);
      if (value > 0.62) li.classList.add("dark");
    }

    // --- text + citation ---
    var parts = splitCitation(effText(item));
    var txt = document.createElement("span");
    txt.className = "ex-text";
    txt.appendChild(document.createTextNode(parts.body + (parts.cite ? " " : "")));
    if (parts.cite) {
      var c;
      if (item.url) {
        c = document.createElement("a");
        c.href = item.url; c.target = "_blank"; c.rel = "noopener noreferrer";
      } else {
        c = document.createElement("span");
      }
      c.className = "cite";
      c.textContent = parts.cite;
      txt.appendChild(c);
    }

    // --- controls ---
    var ctrls = document.createElement("span");
    ctrls.className = "ex-ctrls";

    var badge = document.createElement("span");
    badge.className = "score" + (!excluded && value > 0.6 ? " on-dark" : "");
    badge.textContent = score + "%";
    badge.title = score + "% biased — 0 = not biased, 100 = most biased";

    var hist = histOf(item);
    var histBtn = null;
    if (hist.length) {
      histBtn = document.createElement("button");
      histBtn.type = "button";
      histBtn.className = "ic hist-btn";
      histBtn.textContent = "✎" + hist.length;
      histBtn.title = hist.length + " edit" + (hist.length === 1 ? "" : "s") +
        " — click to see history";
    }

    var keep = document.createElement("button");
    keep.type = "button";
    keep.className = "ic keep" + (excluded ? "" : " on");
    keep.textContent = "✓";
    keep.title = "Keep in training set";

    var drop = document.createElement("button");
    drop.type = "button";
    drop.className = "ic drop" + (excluded ? " on" : "");
    drop.textContent = "✕";
    drop.title = "Take out of training set (excluded from scores)";

    keep.addEventListener("click", function (e) { e.stopPropagation(); setExcluded(item, false); });
    drop.addEventListener("click", function (e) { e.stopPropagation(); setExcluded(item, true); });

    ctrls.appendChild(badge);
    if (histBtn) ctrls.appendChild(histBtn);
    ctrls.appendChild(keep);
    ctrls.appendChild(drop);

    li.appendChild(txt);
    li.appendChild(ctrls);

    // --- edit history panel ---
    if (hist.length) {
      li.appendChild(buildHistPanel(item));
      histBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        li.classList.toggle("show-hist");
      });
    }

    // --- double-click to edit / reformulate ---
    li.addEventListener("dblclick", function () {
      if (!li.classList.contains("editing")) enterEdit(item, li);
    });

    itemNodes[id] = li;
    return li;
  }

  function buildHistPanel(item) {
    var hist = histOf(item);
    var wrap = document.createElement("div");
    wrap.className = "hist-panel";

    var scores = hist.map(function (h) { return h.score; }).concat([effScore(item)]);
    var traj = document.createElement("div");
    traj.className = "hist-traj";
    traj.textContent = "Score history:  " + scores.join("  →  ");
    wrap.appendChild(traj);

    var list = document.createElement("ol");
    list.className = "hist-list";
    for (var i = hist.length - 1; i >= 0; i--) {
      var h = hist[i];
      var liH = document.createElement("li");
      var meta = document.createElement("div");
      meta.className = "hist-meta";
      meta.textContent = "v" + (i + 1) + " · " + h.score + "% · " + timeAgo(h.ts);
      meta.title = new Date(h.ts).toLocaleString();
      var body = document.createElement("div");
      body.className = "hist-body";
      body.textContent = h.text;
      liH.appendChild(meta);
      liH.appendChild(body);
      list.appendChild(liH);
    }
    wrap.appendChild(list);
    return wrap;
  }

  function enterEdit(item, li) {
    li.classList.add("editing");
    li.innerHTML = "";

    var form = document.createElement("div");
    form.className = "ex-edit";

    var origText = effText(item);
    var baseScore = effScore(item);          // the trusted score we anchor to
    var baseHeur = computeBiasScore(origText); // heuristic reading of the original

    var ta = document.createElement("textarea");
    ta.className = "ex-edit-text";
    ta.value = origText;
    ta.rows = 3;

    var row = document.createElement("div");
    row.className = "ex-edit-row";

    // Score is set by the algorithm — but only as an ADJUSTMENT to the
    // existing score, so unchanged text never moves the number.
    function projectedScore(txt) {
      return Math.max(0, Math.min(100,
        baseScore + (computeBiasScore(txt) - baseHeur)));
    }
    var auto = document.createElement("span");
    auto.className = "ex-edit-auto";
    function refreshAuto() {
      var changed = ta.value.trim() !== origText;
      var s = changed ? projectedScore(ta.value.trim()) : baseScore;
      auto.innerHTML = 'Algorithm score: <b>' + s + '%</b>';
      auto.classList.toggle("moved", changed && s !== baseScore);
      auto.title = changed
        ? "Adjusted automatically from your edit (was " + baseScore + "%)"
        : "Unchanged — edit the text and the algorithm re-scores it";
    }
    refreshAuto();
    ta.addEventListener("input", refreshAuto);

    var saveBtn = document.createElement("button");
    saveBtn.type = "button"; saveBtn.className = "btn save"; saveBtn.textContent = "Save";
    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button"; cancelBtn.className = "btn cancel"; cancelBtn.textContent = "Cancel";

    row.appendChild(auto);
    row.appendChild(saveBtn);
    row.appendChild(cancelBtn);
    form.appendChild(ta);
    form.appendChild(row);
    li.appendChild(form);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    function close() { rebuildItem(item.__id); }
    cancelBtn.addEventListener("click", function (e) { e.stopPropagation(); close(); });
    saveBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var nt = ta.value.trim();
      // No text change → no re-score, no history entry.
      if (nt && nt !== origText && applyEdit(item, nt, projectedScore(nt))) return;
      close();
    });
  }

  function buildList(list) {
    var ul = document.createElement("ul");
    ul.className = "ex-list";
    (list || []).forEach(function (item) { ul.appendChild(makeItem(item)); });
    return ul;
  }

  /* ============================================================
     Bias card — title coloured by its Average one single bias.
     ============================================================ */
  function makeCard(bias) {
    var card = document.createElement("article");
    card.className = "card";
    card.dataset.bias = bias.__id;

    var head = document.createElement("button");
    head.className = "card-head";
    head.type = "button";
    head.setAttribute("aria-expanded", "false");

    var bar = document.createElement("span");
    bar.className = "accent";

    var titleWrap = document.createElement("span");
    titleWrap.className = "card-title";
    var name = document.createElement("span");
    name.className = "name";
    name.textContent = bias.name;
    var def = document.createElement("span");
    def.className = "def";
    def.textContent = bias.definition;
    titleWrap.appendChild(name);
    titleWrap.appendChild(def);

    var pill = document.createElement("span");
    pill.className = "bias-pill";

    var chev = document.createElement("span");
    chev.className = "chev";
    chev.textContent = "▾";

    head.appendChild(bar);
    head.appendChild(titleWrap);
    head.appendChild(pill);
    head.appendChild(chev);

    function refresh() {
      var a = avgBias(bias);
      if (a == null) {
        pill.textContent = "—";
        pill.style.background = "#ececef";
        pill.classList.remove("dark");
        bar.style.background = "#dcdce0";
        pill.title = "No scorable examples";
        return;
      }
      var col = colorFor(a / 100);
      pill.textContent = Math.round(a);
      pill.style.background = col;
      bar.style.background = col;
      pill.classList.toggle("dark", a / 100 > 0.6);
      pill.title = "Average one single bias = " + a.toFixed(1) +
        "  (avg examples + inverse avg counter-examples) / 2";
    }
    refresh();
    (chipRefresh[bias.__id] = chipRefresh[bias.__id] || []).push(refresh);

    var body = document.createElement("div");
    body.className = "card-body";
    var lists = document.createElement("div");
    lists.className = "lists";

    var pos = document.createElement("div");
    pos.className = "list-col pos";
    pos.innerHTML = '<h3><span class="dot"></span>Examples of the bias</h3>';
    pos.appendChild(buildList(bias.positive));

    var neg = document.createElement("div");
    neg.className = "list-col neg";
    neg.innerHTML = '<h3><span class="dot"></span>Counter-examples (clear thinking)</h3>';
    neg.appendChild(buildList(bias.negative));

    lists.appendChild(pos);
    lists.appendChild(neg);
    body.appendChild(lists);

    head.addEventListener("click", function () {
      var open = card.classList.toggle("open");
      head.setAttribute("aria-expanded", open ? "true" : "false");
    });

    card.appendChild(head);
    card.appendChild(body);
    return card;
  }

  /* ============================================================
     Views
     ============================================================ */
  function searching() { return !!(searchInput && searchInput.value.trim()); }

  function renderCategory(quadName, cat) {
    catTitle.textContent = cat.name;
    catMeta.textContent = quadName + " · " + cat.biases.length +
      " biases · double-click an example to edit · ✓ keep / ✕ take out";
    grid.className = "grid";
    grid.innerHTML = "";
    cat.biases.forEach(function (b) { grid.appendChild(makeCard(b)); });
  }

  function renderEmpty(quadName) {
    catTitle.textContent = quadName;
    catMeta.textContent = "";
    grid.className = "grid";
    grid.innerHTML = '<p class="empty">No data loaded for this section yet.</p>';
  }

  function renderSearch(qstr) {
    var q = qstr.toLowerCase();
    var matches = [];
    QUADRANTS.forEach(function (quad) {
      quad.categories.forEach(function (cat) {
        cat.biases.forEach(function (b) {
          var hit = b.name.toLowerCase().indexOf(q) >= 0 ||
                    (b.definition || "").toLowerCase().indexOf(q) >= 0;
          if (!hit) {
            (b.positive || []).concat(b.negative || []).forEach(function (it) {
              if (effText(it).toLowerCase().indexOf(q) >= 0) hit = true;
            });
          }
          if (hit) matches.push(b);
        });
      });
    });

    catTitle.textContent = 'Search: "' + qstr + '"';
    catMeta.textContent = matches.length + " matching bias" +
      (matches.length === 1 ? "" : "es") + " across all tabs";
    if (searchMeta) {
      searchMeta.textContent = matches.length + " result" +
        (matches.length === 1 ? "" : "s");
    }

    grid.className = "grid";
    grid.innerHTML = "";
    if (!matches.length) {
      grid.innerHTML = '<p class="empty">No biases or examples match your search.</p>';
      return;
    }
    matches.forEach(function (b) {
      var card = makeCard(b);
      var loc = document.createElement("div");
      loc.className = "card-loc";
      loc.textContent = b.__loc.quad + " › " + b.__loc.cat;
      card.insertBefore(loc, card.firstChild);
      grid.appendChild(card);
    });
  }

  function buildSparkline(h) {
    var wrap = document.createElement("div");
    wrap.className = "spark";
    if (!h || h.length < 2) {
      wrap.textContent = "No changes tracked yet — mark or edit an example to start.";
      return wrap;
    }
    var vals = h.map(function (e) { return e.value; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var W = 180, H = 38, pad = 4, span = (max - min) || 1;
    var pts = vals.map(function (v, i) {
      var x = pad + (W - 2 * pad) * (vals.length === 1 ? 0 : i / (vals.length - 1));
      var y = pad + (H - 2 * pad) * (1 - (v - min) / span);
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    var first = vals[0], last = vals[vals.length - 1], delta = last - first;
    wrap.innerHTML =
      '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
      '<polyline fill="none" stroke="' + colorFor(last / 100) +
      '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="' +
      pts.join(" ") + '"/></svg>' +
      '<span class="spark-d ' + (delta >= 0 ? "up" : "down") + '">' +
      (delta >= 0 ? "▲" : "▼") + " " + Math.abs(delta).toFixed(1) +
      " since start</span>";
    return wrap;
  }

  function renderOverview() {
    catTitle.textContent = "The full picture";
    catMeta.textContent =
      "Each badge is that bias's example-quality score · " +
      "click any bias to jump to it";
    if (legend) legend.style.display = "none";
    grid.className = "overview";
    grid.innerHTML = "";

    var oq = overallQuality();
    var head = document.createElement("div");
    head.className = "ov-head";
    var big = document.createElement("div");
    big.className = "ov-quality";
    var num = document.createElement("span");
    num.className = "ov-q-num";
    num.textContent = oq == null ? "—" : oq.toFixed(1);
    if (oq != null) num.style.color = colorFor(oq / 100);
    big.innerHTML = '<span class="ov-q-label">Training-set quality</span>';
    big.appendChild(num);
    head.appendChild(big);
    head.appendChild(buildSparkline(state.quality));
    grid.appendChild(head);

    var note = document.createElement("p");
    note.className = "ov-note";
    note.textContent =
      "The number on each bias is its example-quality score (0–100) = " +
      "(avg of examples + inverse of avg counter-examples) / 2. " +
      "Darker = higher quality. The training-set quality above is the average across all biases.";
    grid.appendChild(note);

    QUADRANTS.forEach(function (quad) {
      quad.categories.forEach(function (cat) {
        var sec = document.createElement("section");
        sec.className = "ov-cat";
        var h = document.createElement("h2");
        h.className = "ov-cat-title";
        h.textContent = quad.name + " › " + cat.name;
        sec.appendChild(h);

        var rows = document.createElement("div");
        rows.className = "ov-rows";
        cat.biases.forEach(function (b) {
          var a = avgBias(b);
          var row = document.createElement("button");
          row.type = "button";
          row.className = "ov-row";
          if (a == null) {
            row.classList.add("noscore");
          } else {
            row.style.background = colorFor(a / 100);
            row.classList.add("colored");
            if (a / 100 > 0.5) row.classList.add("dark");
          }

          var nm = document.createElement("span");
          nm.className = "ov-name";
          nm.textContent = b.name;

          var nPos = keptScores(b.positive).length;
          var nNeg = keptScores(b.negative).length;
          var dropped = (b.positive || []).length - nPos +
                        ((b.negative || []).length - nNeg);
          var meta = document.createElement("span");
          meta.className = "ov-meta";
          meta.textContent = nPos + " ex · " + nNeg + " counter" +
            (dropped ? " · " + dropped + " out" : "");

          var rnum = document.createElement("span");
          rnum.className = "ov-num";
          rnum.textContent = a == null ? "—" : Math.round(a);
          rnum.title = a == null ? "No scorable examples"
            : "Example-quality score " + a.toFixed(1) + " / 100";

          row.appendChild(nm);
          row.appendChild(meta);
          row.appendChild(rnum);
          row.addEventListener("click", function () { jumpToBias(b); });
          rows.appendChild(row);
        });
        sec.appendChild(rows);
        grid.appendChild(sec);
      });
    });
  }

  function jumpToBias(b) {
    if (searchInput) searchInput.value = "";
    if (searchMeta) searchMeta.textContent = "";
    view.q = b.__loc.qi;
    view.c = b.__loc.ci;
    render();
    var card = grid.querySelector('.card[data-bias="' + b.__id + '"]');
    if (card) {
      card.classList.add("open");
      var hd = card.querySelector(".card-head");
      if (hd) hd.setAttribute("aria-expanded", "true");
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  /* ============================================================
     Top-right quality badge + history popover
     ============================================================ */
  function updateQualityBadge() {
    if (!qualityBadge) return;
    var v = overallQuality();
    var h = state.quality;
    var delta = h.length >= 2 ? h[h.length - 1].value - h[h.length - 2].value : 0;
    qualityBadge.innerHTML = "";
    var lab = document.createElement("span");
    lab.className = "q-lab";
    lab.textContent = "Quality";
    var num = document.createElement("span");
    num.className = "q-num";
    num.textContent = v == null ? "—" : v.toFixed(1);
    if (v != null) num.style.color = colorFor(v / 100);
    qualityBadge.appendChild(lab);
    qualityBadge.appendChild(num);
    if (Math.abs(delta) >= 0.005) {
      var d = document.createElement("span");
      d.className = "q-d " + (delta > 0 ? "up" : "down");
      d.textContent = (delta > 0 ? "▲" : "▼") + Math.abs(delta).toFixed(2);
      qualityBadge.appendChild(d);
    }
  }

  var qPop = null;
  function closeQPop() { if (qPop) { qPop.remove(); qPop = null; } }
  function toggleQualityPopover() {
    if (qPop) { closeQPop(); return; }
    qPop = document.createElement("div");
    qPop.className = "q-pop";
    qPop.addEventListener("click", function (e) { e.stopPropagation(); });

    var v = overallQuality();
    var hd = document.createElement("div");
    hd.className = "q-pop-h";
    hd.textContent = "Training-set quality";
    var bigN = document.createElement("div");
    bigN.className = "q-pop-big";
    bigN.textContent = v == null ? "—" : v.toFixed(1);
    if (v != null) bigN.style.color = colorFor(v / 100);
    qPop.appendChild(hd);
    qPop.appendChild(bigN);
    qPop.appendChild(buildSparkline(state.quality));

    var ul = document.createElement("ul");
    ul.className = "q-pop-list";
    var recent = state.quality.slice(-8).reverse();
    recent.forEach(function (e) {
      var li = document.createElement("li");
      li.innerHTML = '<b style="color:' + colorFor(e.value / 100) + '">' +
        e.value.toFixed(1) + "</b> · " + timeAgo(e.ts);
      ul.appendChild(li);
    });
    qPop.appendChild(ul);

    var reset = document.createElement("button");
    reset.type = "button";
    reset.className = "q-reset";
    reset.textContent = "Reset all marks & edits";
    reset.addEventListener("click", function () {
      if (window.confirm("Clear all your marks, edits and history? This cannot be undone.")) {
        state.items = {};
        state.quality = [];
        save();
        recordQuality();
        closeQPop();
        render();
      }
    });
    qPop.appendChild(reset);

    document.body.appendChild(qPop);
    var r = qualityBadge.getBoundingClientRect();
    qPop.style.top = (r.bottom + 6) + "px";
    qPop.style.right = Math.max(8, window.innerWidth - r.right) + "px";
  }
  if (qualityBadge) {
    qualityBadge.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleQualityPopover();
    });
  }

  /* ============================================================
     Navigation
     ============================================================ */
  function closeAllMenus() {
    var open = navbar.querySelectorAll(".tab.open");
    Array.prototype.forEach.call(open, function (t) { t.classList.remove("open"); });
  }

  function render() {
    itemNodes = {};
    chipRefresh = {};
    // The color-scheme legend describes bias %, which is meaningful on the
    // example pages but misleading on the quality overview — show it by
    // default; renderOverview() hides it.
    if (legend) legend.style.display = "";

    var tabs = navbar.querySelectorAll(".tab");
    var activeTab = searching() ? -1 : view.q;
    Array.prototype.forEach.call(tabs, function (t, i) {
      t.classList.toggle("active", i === activeTab);
    });

    if (searching()) { renderSearch(searchInput.value.trim()); updateQualityBadge(); return; }
    if (view.q === OVERVIEW_Q) { renderOverview(); updateQualityBadge(); return; }

    var quad = QUADRANTS[view.q];
    var tabEl = tabs[view.q];
    if (tabEl) {
      var items = tabEl.querySelectorAll(".menu-item");
      Array.prototype.forEach.call(items, function (it, i) {
        it.classList.toggle("active", i === view.c);
      });
    }
    if (!quad.categories.length) { renderEmpty(quad.name); updateQualityBadge(); return; }
    renderCategory(quad.name, quad.categories[view.c]);
    updateQualityBadge();
  }

  function buildNav() {
    navbar.innerHTML = "";
    QUADRANTS.forEach(function (quad, qi) {
      var tab = document.createElement("div");
      tab.className = "tab";

      var btn = document.createElement("button");
      btn.className = "tab-btn";
      btn.type = "button";
      var label = document.createElement("span");
      label.textContent = quad.name;
      var caret = document.createElement("span");
      caret.className = "caret";
      caret.textContent = "▾";
      btn.appendChild(label);
      btn.appendChild(caret);

      var menu = document.createElement("div");
      menu.className = "tab-menu";

      if (quad.categories.length) {
        quad.categories.forEach(function (cat, ci) {
          var item = document.createElement("button");
          item.className = "menu-item";
          item.type = "button";
          item.textContent = cat.name;
          item.addEventListener("click", function (e) {
            e.stopPropagation();
            if (searchInput) searchInput.value = "";
            if (searchMeta) searchMeta.textContent = "";
            view.q = qi;
            view.c = ci;
            closeAllMenus();
            render();
          });
          menu.appendChild(item);
        });
      } else {
        var none = document.createElement("div");
        none.className = "menu-item disabled";
        none.textContent = "No data yet";
        menu.appendChild(none);
      }

      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var wasOpen = tab.classList.contains("open");
        closeAllMenus();
        if (!wasOpen) tab.classList.add("open");
      });

      tab.appendChild(btn);
      tab.appendChild(menu);
      navbar.appendChild(tab);
    });

    // 6th tab — the full picture overview
    var otab = document.createElement("div");
    otab.className = "tab overview-tab";
    var obtn = document.createElement("button");
    obtn.className = "tab-btn";
    obtn.type = "button";
    var olabel = document.createElement("span");
    olabel.textContent = "◎ Full Picture";
    obtn.appendChild(olabel);
    obtn.addEventListener("click", function (e) {
      e.stopPropagation();
      closeAllMenus();
      if (searchInput) searchInput.value = "";
      if (searchMeta) searchMeta.textContent = "";
      view.q = OVERVIEW_Q;
      render();
    });
    otab.appendChild(obtn);
    navbar.appendChild(otab);
  }

  /* ============================================================
     Wire up
     ============================================================ */
  if (searchInput) {
    searchInput.addEventListener("input", function () {
      if (!searchInput.value.trim() && searchMeta) searchMeta.textContent = "";
      render();
    });
  }

  document.addEventListener("click", function () {
    closeAllMenus();
    closeQPop();
  });

  buildNav();
  render();
})();
