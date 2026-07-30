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
  var MODEL_VERSION = 1;
  var state = loadState();

  function loadState() {
    var base = { items: {}, quality: [], added: {}, modelVersion: MODEL_VERSION };
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        base.items = p.items || {};
        base.quality = p.quality || [];
        base.added = p.added || {};
        base.modelVersion = p.modelVersion || 0;
      }
    } catch (e) {}
    return migrate(base);
  }

  /* Scores used to be hand-assigned "% biased" numbers stored per item.
     They are now derived from the trained model, so stored scores are
     dropped and the quality history — which tracked a different quantity
     entirely — is cleared. Text edits, exclusions and added examples all
     survive: those are the curation work worth keeping. */
  function migrate(s) {
    if (s.modelVersion === MODEL_VERSION) return s;
    Object.keys(s.items).forEach(function (id) {
      var o = s.items[id];
      if (!o) return;
      delete o.score;
      (o.history || []).forEach(function (h) { delete h.score; });
    });
    Object.keys(s.added).forEach(function (bid) {
      var store = s.added[bid] || {};
      ["positive", "negative"].forEach(function (t) {
        (store[t] || []).forEach(function (rec) { delete rec.score; });
      });
    });
    s.quality = [];
    s.modelVersion = MODEL_VERSION;
    return s;
  }

  function payload() {
    return { items: state.items, quality: state.quality, added: state.added,
             modelVersion: state.modelVersion };
  }
  function persistLocal() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(payload())); }
    catch (e) {}
  }
  function save() {
    persistLocal();
    // Notify the optional cloud-sync layer (supabase-sync.js) so the change
    // propagates to the user's other devices. No-op when sync isn't wired up.
    // Added examples ride along — they are training data like any other.
    if (window.CVApp && typeof CVApp._onSave === "function") {
      try { CVApp._onSave(payload()); }
      catch (e) {}
    }
  }

  /* ------------------------------------------------------------
     Bridge for the optional cloud-sync layer. supabase-sync.js reads
     and writes state through this, so app.js stays backend-agnostic.
     ------------------------------------------------------------ */
  window.CVApp = {
    // Current persisted payload (exactly what save() writes).
    getState: payload,
    // Adopt a copy pulled from the cloud, cache it locally, then repaint.
    // Uses persistLocal() (not save()) so adopting a remote copy never
    // bounces straight back out as a push.
    replaceState: function (incoming) {
      if (!incoming || typeof incoming !== "object") return;
      state.items = incoming.items || {};
      state.quality = incoming.quality || [];
      state.added = incoming.added || {};
      state.modelVersion = incoming.modelVersion || 0;
      migrate(state);
      injectAdded();   // re-materialise user-added examples from the new state
      persistLocal();
      render();
      scheduleTrain(); // the corpus changed → the model must be refitted
    },
    // Set by the sync layer; called after every local save() with the payload.
    _onSave: null,

    // Flattened, fully-computed snapshot for exporting (spreadsheet / doc).
    // Every number is the trained model's, not a stored constant.
    exportData: function () {
      var rows = [];
      var r1 = function (v) { return v == null ? "" : Math.round(v * 10) / 10; };
      QUADRANTS.forEach(function (q) {
        (q.categories || []).forEach(function (c) {
          (c.biases || []).forEach(function (b) {
            var a = avgReliability(b);
            var add = function (list, type) {
              (list || []).forEach(function (it) {
                var rel = reliability(it);
                rows.push({
                  quadrant: q.name, category: c.name, bias: b.name,
                  biasReliability: a == null ? "" : Math.round(a), type: type,
                  text: effText(it),
                  reliability: rel == null ? "" : Math.round(rel),
                  verdict: verdictOf(it),
                  url: it.url || "", excluded: isExcluded(it) ? "yes" : ""
                });
              });
            };
            add(b.positive, "Example");
            add(b.negative, "Counter-example");
          });
        });
      });
      var m = MODEL && MODEL.ready ? MODEL.metrics : null;
      return {
        rows: rows,
        overall: m ? r1(m.balanced * 100) : null,
        model: m ? {
          quality: r1(m.balanced * 100), accuracy: r1(m.accuracy * 100),
          f1: r1(m.f1 * 100), auc: m.auc == null ? null : Math.round(m.auc * 1000) / 1000,
          logLoss: Math.round(m.logLoss * 1000) / 1000,
          calibrationError: r1(m.ece * 100),
          trainedOn: m.docs, features: m.features, folds: m.folds
        } : null
      };
    }
  };

  var view = { q: 0, c: 0 }; // current quadrant / category being shown

  /* ============================================================
     Index every example with a stable id so marks/edits survive
     reloads. id = "qi.ci.bi:p<idx>" (pos) or ":n<idx>" (neg).

     __label is the supervised target the model is trained against:
       1 = an example of the bias in action
       0 = a counter-example (clear thinking)
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
          it.__label = 1;
          ITEMS[id] = { item: it, biasId: biasId };
        });
        (b.negative || []).forEach(function (it, idx) {
          var id = biasId + ":n" + idx;
          it.__id = id;
          it.__label = 0;
          ITEMS[id] = { item: it, biasId: biasId };
        });
      });
    });
  });

  /* ============================================================
     User-added examples. These live in state.added (keyed by biasId,
     with positive/negative arrays of {text, score, url}) so they
     survive reloads and ride along with cloud sync. injectAdded()
     materialises them back into the live bias arrays + ITEMS index,
     giving each a stable id (":pa<n>" / ":na<n>") so marks, edits and
     history work exactly like the built-in examples. It's idempotent —
     safe to re-run whenever state.added changes (e.g. after a sync).
     ============================================================ */
  function injectAdded() {
    // Drop anything previously injected so a re-run never duplicates.
    Object.keys(ITEMS).forEach(function (id) {
      if (id.indexOf(":pa") >= 0 || id.indexOf(":na") >= 0) delete ITEMS[id];
    });
    function fill(recs, arr, biasId, tag) {
      (recs || []).forEach(function (rec, idx) {
        var it = { text: rec.text, url: rec.url || "", __added: true,
                   __label: tag === "pa" ? 1 : 0 };
        var id = biasId + ":" + tag + idx;
        it.__id = id;
        arr.push(it);
        ITEMS[id] = { item: it, biasId: biasId };
      });
    }
    QUADRANTS.forEach(function (q, qi) {
      q.categories.forEach(function (c, ci) {
        c.biases.forEach(function (b, bi) {
          var biasId = qi + "." + ci + "." + bi;
          b.positive = (b.positive || []).filter(function (it) { return !it.__added; });
          b.negative = (b.negative || []).filter(function (it) { return !it.__added; });
          var store = state.added[biasId];
          if (!store) return;
          fill(store.positive, b.positive, biasId, "pa");
          fill(store.negative, b.negative, biasId, "na");
        });
      });
    });
  }
  injectAdded();

  /* ============================================================
     Reliability colour scale (matches the legend gradient)
       0 = white  (model can't place this example)
       1 = dark pink  (model places it correctly and confidently)
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
     Effective accessors — an item's current text honours any stored
     override; otherwise fall back to the original data.
     ============================================================ */
  function ov(id) { return state.items[id]; }
  function effText(item) {
    var o = ov(item.__id);
    return o && o.text != null ? o.text : item.text;
  }
  function isExcluded(item) {
    var o = ov(item.__id);
    return !!(o && o.excluded);
  }
  function histOf(item) {
    var o = ov(item.__id);
    return (o && o.history) || [];
  }
  function mean(arr) {
    if (!arr.length) return null;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  /* ============================================================
     THE MODEL

     Every number in this app comes from here. model.js fits a
     logistic-regression text classifier to the curated corpus —
     examples of a bias (label 1) against counter-examples (label 0) —
     and cross-validates it, so each example also gets an out-of-fold
     prediction from a model that never saw it during training.

     Ticking ✕ takes an example out of the training set; editing or
     adding one changes what the model is fitted to. Either way the
     model is refitted and every score on screen is re-derived.
     ============================================================ */
  var MODEL = null;         // last training run (see CVModel.train)
  var trainState = "idle";  // "idle" | "training" | "ready" | "unavailable"
  var trainTimer = null;

  /* The training set: every example the user hasn't taken out, at its
     current wording. */
  function trainingDocs() {
    var docs = [];
    Object.keys(ITEMS).forEach(function (id) {
      var it = ITEMS[id].item;
      if (isExcluded(it)) return;
      docs.push({ id: id, text: effText(it), label: it.__label });
    });
    return docs;
  }

  function trainNow() {
    trainTimer = null;
    if (!window.CVModel) { trainState = "unavailable"; repaintScores(); return; }
    MODEL = window.CVModel.train(trainingDocs());
    trainState = MODEL.ready ? "ready" : "unavailable";
    recordQuality();
    repaintScores();
  }
  /* Debounced so a burst of clicks costs one fit, and deferred a tick so
     the click that triggered it paints first. */
  function scheduleTrain() {
    trainState = "training";
    updateQualityBadge();
    clearTimeout(trainTimer);
    trainTimer = setTimeout(trainNow, 140);
  }
  function modelReady() { return !!(MODEL && MODEL.ready); }

  /* ------------------------------------------------------------
     Reliability — the score shown on every example.

     P = the model's probability that a text shows the bias in action.
     An example's reliability is the probability the model assigns to
     that example's OWN label, as a percentage:

       100  the model recognises it immediately — a clean, characteristic
            example the model can learn the pattern from
        50  the model is undecided — the example carries no usable signal
         0  the model reads it as the opposite class — ambiguous, or
            filed on the wrong side

     Taken from the out-of-fold prediction wherever one exists, so an
     example is never graded by a model that memorised it.
     ------------------------------------------------------------ */
  function reliabilityFromP(p, label) {
    return p == null ? null : 100 * (label === 1 ? p : 1 - p);
  }
  /* Corpus example: its calibrated out-of-fold probability. An example not
     currently in the training set (taken out, or added since the last fit)
     has no held-out measurement, so it goes through the same gate as any
     unseen text and may legitimately have no score at all. */
  function reliability(item) {
    if (!modelReady()) return null;
    var p = MODEL.oof[item.__id];
    if (p != null) return reliabilityFromP(p, item.__label);
    var a = MODEL.assess(effText(item));
    return reliabilityFromP(a.p, item.__label);
  }
  function assessText(text) {
    return modelReady() && text ? MODEL.assess(text) : null;
  }
  function heldOut(item) { return modelReady() && MODEL.oof[item.__id] != null; }

  /* ------------------------------------------------------------
     Prediction confidence for UNSEEN text — a different quantity from
     reliability, and deliberately rendered differently.

     Reliability is a held-out measurement: the model was fitted without
     that example and we recorded what it said. Text you type has no such
     measurement, so what comes back is a prediction — calibrated against
     the held-out data and capped by the model's measured accuracy at that
     evidence level, and withheld entirely when there is too little to go
     on. model.js returns confidence === null in that case, so there is no
     number here to display by accident.
     ------------------------------------------------------------ */
  function renderPrediction(node, text) {
    node.classList.remove("moved", "reject");
    var a = assessText(text);
    if (!a) {
      node.innerHTML = 'Prediction confidence: <b>—</b>';
      node.title = text ? "No trained model yet."
                        : "Type something for the model to read.";
      return;
    }
    if (a.status === "insufficient" || a.status === "unreliable") {
      node.classList.add("reject");
      node.innerHTML = '<b>' + (a.status === "insufficient"
        ? "Insufficient context" : "Unable to classify reliably") + '</b>';
      node.title = a.reason +
        "\n\nNo percentage is shown because any number here would be guesswork.";
      return;
    }
    if (a.status === "undecided") {
      node.classList.add("reject");
      node.innerHTML = '<b>Model is undecided</b>';
      node.title = a.reason;
      return;
    }
    node.innerHTML = 'Prediction confidence: <b>' +
      Math.round(a.confidence * 100) + '%</b> <span class="pred-dir">' +
      (a.label === 1 ? "example of the bias" : "clear thinking") + '</span>';
    node.title = a.reason;
  }

  /* Plain-language read of what the model made of an example. */
  function verdictOf(item) {
    var r = reliability(item);
    if (r == null) return "";
    if (r >= 85) return "model agrees, confidently";
    if (r >= 65) return "model agrees";
    if (r > 50)  return "model leans agree";
    if (r === 50) return "model undecided";
    if (r > 35)  return "model leans disagree";
    if (r > 15)  return "model disagrees";
    return "model disagrees, confidently";
  }

  /* A bias's score = mean reliability of the examples still in the
     training set, across both lists. */
  function keptReliability(list) {
    var out = [];
    (list || []).forEach(function (it) {
      if (isExcluded(it)) return;
      var r = reliability(it);
      if (r != null) out.push(r);
    });
    return out;
  }
  function avgReliability(b) {
    return mean(keptReliability(b.positive).concat(keptReliability(b.negative)));
  }

  /* Headline model quality: cross-validated balanced accuracy — how often
     the held-out model gets an example right, weighted so the larger
     class can't flatter it. */
  function modelQuality() {
    return modelReady() ? MODEL.metrics.balanced * 100 : null;
  }

  /* ---- model-quality change tracking ---- */
  function recordQuality() {
    var v = modelQuality();
    if (v == null) return;
    var h = state.quality;
    var last = h.length ? h[h.length - 1].value : null;
    if (last == null || Math.abs(v - last) > 1e-9) {
      h.push({ ts: Date.now(), value: v });
      if (h.length > 400) h.shift();
      save();
    }
  }

  /* ============================================================
     Mutations
     ============================================================ */
  function getOv(id) {
    if (!state.items[id]) state.items[id] = {};
    return state.items[id];
  }
  function cleanOv(id) {
    var o = state.items[id];
    if (o && !o.excluded && o.text == null &&
        !(o.history && o.history.length)) {
      delete state.items[id];
    }
  }
  /* Every mutation changes the training set, so every mutation refits the
     model — that is the whole point of the ✓/✕ marks. */
  function afterMutation(id) {
    save();
    rebuildItem(id);
    scheduleTrain();
  }
  function setExcluded(item, val) {
    var o = getOv(item.__id);
    if (val) o.excluded = true; else delete o.excluded;
    cleanOv(item.__id);
    afterMutation(item.__id);
  }
  function applyEdit(item, newText) {
    var curText = effText(item);
    if (newText === curText) return false;
    var o = getOv(item.__id);
    if (!o.history) o.history = [];
    o.history.push({ text: curText, ts: Date.now() });
    o.text = newText;
    afterMutation(item.__id);
    return true;
  }

  /* Add a brand-new example to a bias. `type` is "positive" (example of
     the bias) or "negative" (counter-example). No score is stored: the
     example joins the training set, the model is refitted, and its
     reliability is derived like every other example's. Returns the live
     item so the caller can render it. */
  function addExample(bias, type, text) {
    var biasId = bias.__id;
    if (!state.added[biasId]) state.added[biasId] = { positive: [], negative: [] };
    var store = state.added[biasId];
    if (!store[type]) store[type] = [];
    var idx = store[type].length;
    store[type].push({ text: text, url: "" });

    var it = { text: text, url: "", __added: true,
               __label: type === "positive" ? 1 : 0 };
    var id = biasId + ":" + (type === "positive" ? "pa" : "na") + idx;
    it.__id = id;
    bias[type].push(it);
    ITEMS[id] = { item: it, biasId: biasId };

    save();
    scheduleTrain();
    return it;
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
  /* After a refit every score on screen is stale — repaint them in place
     rather than re-rendering, so open cards and scroll position survive. */
  function repaintScores() {
    if (view.q === OVERVIEW_Q && !searching()) { renderOverview(); updateQualityBadge(); return; }
    Object.keys(itemNodes).forEach(rebuildItem);
    Object.keys(chipRefresh).forEach(refreshBias);
    updateQualityBadge();
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
    var rel = reliability(item);
    var excluded = isExcluded(item);
    var value = rel == null ? 0 : rel / 100;

    var li = document.createElement("li");
    li.className = "ex-item" + (excluded ? " excluded" : "");
    li.dataset.id = id;
    if (!excluded && rel != null) {
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
    badge.className = "score" + (!excluded && rel != null && value > 0.6 ? " on-dark" : "");
    badge.textContent = rel == null
      ? (trainState === "training" ? "…" : "—")
      : Math.round(rel) + "%";
    badge.title = rel == null
      ? (trainState === "training" ? "Refitting the model…"
         : modelReady()
           ? "The model has too little to go on here to give a figure."
           : "No model yet — nothing to report")
      : "Model reliability " + Math.round(rel) + "% — " + verdictOf(item) +
        " that this is " + (item.__label === 1 ? "an example of the bias" :
                            "clear thinking") + ".\n" +
        (heldOut(item)
          ? "Measured out-of-fold — a model fitted without this example said so — " +
            "then calibrated against the held-out data."
          : "Not currently in the training set, so this is a prediction, not a measurement.");

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
    keep.title = "Keep in the training set — the model learns from this example";

    var drop = document.createElement("button");
    drop.type = "button";
    drop.className = "ic drop" + (excluded ? " on" : "");
    drop.textContent = "✕";
    drop.title = "Take out of the training set — the model is refitted without it";

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

    // Superseded wordings are not in the training set, so these are
    // predictions, not held-out measurements — and a wording the model
    // can't judge shows "—" rather than a made-up number.
    var relOf = function (txt) {
      var a = assessText(txt);
      if (!a || a.p == null) return "—";
      return Math.round(reliabilityFromP(a.p, item.__label));
    };
    var scores = hist.map(function (h) { return relOf(h.text); });
    var cur = reliability(item);
    scores.push(cur == null ? "—" : Math.round(cur));
    var traj = document.createElement("div");
    traj.className = "hist-traj";
    traj.textContent = "Model prediction by version:  " + scores.join("  →  ");
    traj.title = "Earlier wordings re-read by the model as it stands now. " +
      "The last figure is the current example's held-out reliability. " +
      "“—” means the model had too little to go on.";
    wrap.appendChild(traj);

    var list = document.createElement("ol");
    list.className = "hist-list";
    for (var i = hist.length - 1; i >= 0; i--) {
      var h = hist[i];
      var liH = document.createElement("li");
      var meta = document.createElement("div");
      meta.className = "hist-meta";
      meta.textContent = "v" + (i + 1) + " · " + relOf(h.text) + "% · " + timeAgo(h.ts);
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
    var baseRel = reliability(item);

    var ta = document.createElement("textarea");
    ta.className = "ex-edit-text";
    ta.value = origText;
    ta.rows = 3;

    var row = document.createElement("div");
    row.className = "ex-edit-row";

    /* Unchanged text still has its held-out measurement, so it keeps the
       "Model reliability" label. The moment you reword it, it becomes
       unseen text and what the model offers is a prediction — named,
       calibrated and gated accordingly. */
    var auto = document.createElement("span");
    auto.className = "ex-edit-auto";
    function refreshAuto() {
      var txt = ta.value.trim();
      if (txt === origText) {
        auto.classList.remove("moved", "reject");
        auto.innerHTML = 'Model reliability: <b>' +
          (baseRel == null ? "—" : Math.round(baseRel) + "%") + '</b>';
        auto.title = "Held-out measurement for this example as it stands: the " +
          "model was fitted without it and this is what it said. Reword it and " +
          "the model gives a prediction instead.";
        return;
      }
      renderPrediction(auto, txt);
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
      // No text change → no refit, no history entry.
      if (nt && nt !== origText && applyEdit(item, nt)) return;
      close();
    });
  }

  function buildList(list) {
    var ul = document.createElement("ul");
    ul.className = "ex-list";
    (list || []).forEach(function (item) { ul.appendChild(makeItem(item)); });
    return ul;
  }

  /* "Add example" affordance shown under each list. Clicking reveals an
     inline editor showing what the model currently makes of the text;
     saving adds it to the training set and refits the model. */
  function buildAdder(bias, type, ul) {
    var wrap = document.createElement("div");
    wrap.className = "add-ex";

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "add-ex-btn";
    btn.textContent = type === "positive"
      ? "+ Add example" : "+ Add counter-example";
    wrap.appendChild(btn);

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (wrap.querySelector(".add-ex-form")) return; // already open

      btn.style.display = "none";
      var form = document.createElement("div");
      form.className = "ex-edit add-ex-form";

      var ta = document.createElement("textarea");
      ta.className = "ex-edit-text";
      ta.rows = 3;
      ta.placeholder = type === "positive"
        ? "New example of the bias…"
        : "New counter-example (clear thinking)…";

      var row = document.createElement("div");
      row.className = "ex-edit-row";

      var auto = document.createElement("span");
      auto.className = "ex-edit-auto";
      function refreshAuto() { renderPrediction(auto, ta.value.trim()); }
      refreshAuto();
      ta.addEventListener("input", refreshAuto);

      var addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "btn save";
      addBtn.textContent = "Add";
      var cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "btn cancel";
      cancelBtn.textContent = "Cancel";

      row.appendChild(auto);
      row.appendChild(addBtn);
      row.appendChild(cancelBtn);
      form.appendChild(ta);
      form.appendChild(row);
      wrap.appendChild(form);
      ta.focus();

      function close() { form.remove(); btn.style.display = ""; }
      cancelBtn.addEventListener("click", function (e) { e.stopPropagation(); close(); });
      addBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        var t = ta.value.trim();
        if (!t) { close(); return; }
        var it = addExample(bias, type, t);
        ul.appendChild(makeItem(it));
        close();
      });
    });

    return wrap;
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
      var a = avgReliability(bias);
      if (a == null) {
        pill.textContent = trainState === "training" ? "…" : "—";
        pill.style.background = "#ececef";
        pill.classList.remove("dark");
        bar.style.background = "#dcdce0";
        pill.title = trainState === "training"
          ? "Refitting the model…"
          : "No examples in the training set for this bias";
        return;
      }
      var col = colorFor(a / 100);
      pill.textContent = Math.round(a);
      pill.style.background = col;
      bar.style.background = col;
      pill.classList.toggle("dark", a / 100 > 0.6);
      pill.title = "Model reliability on this bias = " + a.toFixed(1) + "%" +
        " — mean across its examples and counter-examples in the training set";
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
    var posUl = buildList(bias.positive);
    pos.appendChild(posUl);
    pos.appendChild(buildAdder(bias, "positive", posUl));

    var neg = document.createElement("div");
    neg.className = "list-col neg";
    neg.innerHTML = '<h3><span class="dot"></span>Counter-examples (clear thinking)</h3>';
    var negUl = buildList(bias.negative);
    neg.appendChild(negUl);
    neg.appendChild(buildAdder(bias, "negative", negUl));

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
      " biases · every % is the model's reliability · double-click an " +
      "example to reword it · ✓ keep / ✕ take out of the training set";
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
      wrap.textContent = "One fit so far — curate the training set and the " +
        "model's quality is re-measured here.";
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

  /* One metric tile in the model panel. */
  function metricTile(label, value, hint) {
    var t = document.createElement("div");
    t.className = "mx-tile";
    var l = document.createElement("span");
    l.className = "mx-lab";
    l.textContent = label;
    var v = document.createElement("span");
    v.className = "mx-val";
    v.textContent = value;
    t.appendChild(l);
    t.appendChild(v);
    if (hint) t.title = hint;
    return t;
  }

  function buildModelPanel() {
    var wrap = document.createElement("div");
    wrap.className = "mx-panel";

    if (!modelReady()) {
      var p = document.createElement("p");
      p.className = "ov-note";
      p.textContent = trainState === "training"
        ? "Fitting the model to the training set…"
        : (MODEL && MODEL.reason) ||
          "No model — model.js didn't load, so there is nothing to report.";
      wrap.appendChild(p);
      return wrap;
    }

    var m = MODEL.metrics;
    var tiles = document.createElement("div");
    tiles.className = "mx-tiles";
    tiles.appendChild(metricTile("Accuracy", (m.accuracy * 100).toFixed(1) + "%",
      "Share of held-out examples the model classifies correctly."));
    tiles.appendChild(metricTile("F1", (m.f1 * 100).toFixed(1) + "%",
      "Harmonic mean of precision (" + (m.precision * 100).toFixed(1) +
      "%) and recall (" + (m.recall * 100).toFixed(1) + "%)."));
    tiles.appendChild(metricTile("ROC AUC", m.auc == null ? "—" : m.auc.toFixed(3),
      "Probability the model ranks a random bias example above a random " +
      "counter-example. 0.5 = coin flip, 1.0 = perfect."));
    tiles.appendChild(metricTile("Log loss", m.logLoss.toFixed(3),
      "Penalty for confident mistakes. Lower is better; 0.693 = no better than guessing."));
    tiles.appendChild(metricTile("Calibration error", (m.ece * 100).toFixed(1) + "%",
      "How far the model's stated confidence drifts from how often it is " +
      "actually right. Lower means the % on each example can be taken at face " +
      "value. Was " + (m.eceRaw * 100).toFixed(1) + "% before Platt calibration."));
    tiles.appendChild(metricTile("Training set", m.docs.toLocaleString(),
      m.pos.toLocaleString() + " examples of bias · " + m.neg.toLocaleString() +
      " counter-examples · " + m.features.toLocaleString() + " learned features"));
    wrap.appendChild(tiles);

    var how = document.createElement("p");
    how.className = "ov-note";
    how.textContent =
      "Logistic regression over word and two-word features (TF-IDF), " +
      "class-balanced, measured by " + m.folds + "-fold cross-validation: every " +
      "example is scored by a model fitted without it. Those held-out " +
      "predictions are then Platt-calibrated (A=" + m.platt.A.toFixed(2) +
      "), which is what pulled calibration error from " +
      (m.eceRaw * 100).toFixed(1) + "% down to " + (m.ece * 100).toFixed(1) +
      "%. Quality above is balanced accuracy. Curating the set — ✕ to drop a " +
      "weak example, rewording an unclear one, adding a new one — refits the " +
      "model and moves these numbers.";
    wrap.appendChild(how);

    /* Text you type has no held-out measurement behind it, so the app states
       plainly what it will and won't claim about it. */
    var gate = document.createElement("p");
    gate.className = "ov-note";
    var buckets = m.evidenceBuckets.filter(function (b) { return b.n >= 30; });
    gate.textContent =
      "For text you type in, the model reports a prediction rather than a " +
      "reliability, and refuses outright when there is too little to go on — " +
      "fewer than 5 recognised word patterns, or one word carrying over 60% " +
      "of the decision. On this corpus that rule withholds a score from the " +
      "12% of cases where the model is measurably overconfident. Predictions " +
      "are also capped by measured accuracy at that evidence level: " +
      buckets.map(function (b) {
        return (b.upTo === null ? "8+" : "<" + b.upTo) + " content words → " +
               (b.cap * 100).toFixed(0) + "%";
      }).join(" · ") + ".";
    wrap.appendChild(gate);

    /* What the model actually learned. Worth showing: these weights are
       fitted from the corpus, and they are the reason a score is what it is. */
    var cues = document.createElement("div");
    cues.className = "mx-cues";
    [["Learned cues for bias", MODEL.topFeatures.positive, "pos"],
     ["Learned cues for clear thinking", MODEL.topFeatures.negative, "neg"]
    ].forEach(function (g) {
      var col = document.createElement("div");
      col.className = "mx-cue-col " + g[2];
      var h = document.createElement("h3");
      h.textContent = g[0];
      col.appendChild(h);
      var ul = document.createElement("ul");
      g[1].forEach(function (f) {
        var li = document.createElement("li");
        li.innerHTML = '<span class="mx-term"></span><span class="mx-w">' +
          (f[1] >= 0 ? "+" : "") + f[1].toFixed(2) + "</span>";
        li.querySelector(".mx-term").textContent = f[0];
        li.title = "Learned weight " + f[1].toFixed(3) + " — fitted from the corpus, not hand-written";
        ul.appendChild(li);
      });
      col.appendChild(ul);
      cues.appendChild(col);
    });
    wrap.appendChild(cues);
    return wrap;
  }

  function renderOverview() {
    catTitle.textContent = "The full picture";
    catMeta.textContent =
      "Every number is the model's reliability · click any bias to jump to it";
    if (legend) legend.style.display = "none";
    grid.className = "overview";
    grid.innerHTML = "";

    var oq = modelQuality();
    var head = document.createElement("div");
    head.className = "ov-head";
    var big = document.createElement("div");
    big.className = "ov-quality";
    var num = document.createElement("span");
    num.className = "ov-q-num";
    num.textContent = oq == null ? (trainState === "training" ? "…" : "—")
                                 : oq.toFixed(1);
    if (oq != null) num.style.color = colorFor(oq / 100);
    big.innerHTML = '<span class="ov-q-label">Model quality</span>';
    big.appendChild(num);
    var sub = document.createElement("span");
    sub.className = "ov-q-sub";
    sub.textContent = "cross-validated balanced accuracy";
    big.appendChild(sub);
    head.appendChild(big);
    head.appendChild(buildSparkline(state.quality));
    grid.appendChild(head);

    grid.appendChild(buildModelPanel());

    var note = document.createElement("p");
    note.className = "ov-note";
    note.textContent =
      "The number on each bias is the model's mean reliability across its " +
      "examples — how confidently a model trained without them puts each one " +
      "on its own side. Darker = the model reads that bias reliably. Pale rows " +
      "are where it struggles: ambiguous wording, too few examples, or an " +
      "example on the wrong side.";
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
          var a = avgReliability(b);
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

          var nPos = keptReliability(b.positive).length;
          var nNeg = keptReliability(b.negative).length;
          var dropped = (b.positive || []).length - nPos +
                        ((b.negative || []).length - nNeg);
          var meta = document.createElement("span");
          meta.className = "ov-meta";
          meta.textContent = nPos + " ex · " + nNeg + " counter" +
            (dropped ? " · " + dropped + " out" : "");

          var rnum = document.createElement("span");
          rnum.className = "ov-num";
          rnum.textContent = a == null ? (trainState === "training" ? "…" : "—")
                                       : Math.round(a);
          rnum.title = a == null ? "Nothing in the training set for this bias"
            : "Model reliability " + a.toFixed(1) + "% across this bias's examples";

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
    var v = modelQuality();
    var h = state.quality;
    var delta = h.length >= 2 ? h[h.length - 1].value - h[h.length - 2].value : 0;
    qualityBadge.innerHTML = "";
    qualityBadge.classList.toggle("training", trainState === "training");
    var lab = document.createElement("span");
    lab.className = "q-lab";
    lab.textContent = trainState === "training" ? "Training…" : "Model quality";
    var num = document.createElement("span");
    num.className = "q-num";
    num.textContent = v == null ? (trainState === "training" ? "…" : "—")
                                : v.toFixed(1);
    if (v != null) num.style.color = colorFor(v / 100);
    qualityBadge.title = v == null
      ? "No trained model yet"
      : "Cross-validated balanced accuracy of the model, fitted on " +
        MODEL.metrics.docs + " examples. Click for detail.";
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

    var v = modelQuality();
    var hd = document.createElement("div");
    hd.className = "q-pop-h";
    hd.textContent = "Model quality";
    var bigN = document.createElement("div");
    bigN.className = "q-pop-big";
    bigN.textContent = v == null ? "—" : v.toFixed(1);
    if (v != null) bigN.style.color = colorFor(v / 100);
    qPop.appendChild(hd);
    qPop.appendChild(bigN);

    var sum = document.createElement("div");
    sum.className = "q-pop-sum";
    sum.textContent = modelReady()
      ? "Balanced accuracy, " + MODEL.metrics.folds + "-fold CV · AUC " +
        (MODEL.metrics.auc == null ? "—" : MODEL.metrics.auc.toFixed(3)) +
        " · F1 " + (MODEL.metrics.f1 * 100).toFixed(1) + "% · fitted on " +
        MODEL.metrics.docs + " examples"
      : (trainState === "training" ? "Refitting…" : "No trained model");
    qPop.appendChild(sum);
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
      if (window.confirm("Clear all your marks, edits and history and refit the " +
                         "model on the original set? This cannot be undone.")) {
        state.items = {};
        state.quality = [];
        save();
        closeQPop();
        render();
        scheduleTrain();
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
    // The colour legend explains the per-example reliability shading, which
    // only appears on the example pages — show it by default; the overview
    // hides it and explains its own numbers.
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
  // Queue the first fit before painting, so the first paint already shows the
  // "training…" placeholders rather than a flash of empty scores.
  scheduleTrain();
  render();
})();
