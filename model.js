/* ============================================================
   Content Verify — the model.

   A genuine supervised text classifier, trained in the browser on the
   curated corpus itself. No keyword lists, no hand-set weights: every
   weight is learned from the labelled examples.

     task      binary classification of a short text
                 label 1 = "the bias in action"
                 label 0 = "clear thinking" (counter-example)
     features  word unigrams + bigrams, sublinear TF-IDF, L2-normalised,
               vocabulary limited to terms seen in >= MIN_DF documents
     learner   L2-regularised logistic regression, AdaGrad SGD,
               class-balanced so the larger class can't dominate
     honesty   stratified k-fold cross-validation produces an
               out-of-fold probability for EVERY training example, so an
               example is never judged by a model that memorised it.
               Reported quality (accuracy / F1 / AUC / calibration) is
               measured on those held-out predictions.

   Everything is deterministic — a seeded shuffle, zero-initialised
   weights — so the same corpus always yields the same model and the
   same numbers. Retraining is cheap enough (~2.5k docs) to re-run every
   time the user curates the set.

   Exposes: window.CVModel.train(docs) -> trained model (see bottom).
   ============================================================ */
(function () {
  "use strict";

  /* ---- hyper-parameters (fixed; not fitted to the test folds) ---- */
  var MIN_DF   = 2;      // a term must appear in >= 2 documents to be kept
  var EPOCHS   = 45;
  var LR       = 0.5;    // AdaGrad base step
  var LAMBDA   = 1e-5;   // L2 penalty, applied to touched features
  var FOLDS    = 5;
  var SEED     = 20260730;

  /* ============================================================
     Deterministic PRNG (so training is reproducible run to run)
     ============================================================ */
  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }
  function shuffled(n, rand) {
    var a = new Int32Array(n);
    for (var i = 0; i < n; i++) a[i] = i;
    for (var j = n - 1; j > 0; j--) {
      var k = Math.floor(rand() * (j + 1));
      var t = a[j]; a[j] = a[k]; a[k] = t;
    }
    return a;
  }

  /* ============================================================
     Text -> features
     ============================================================ */
  function tokens(text) {
    var raw = String(text || "").toLowerCase().replace(/[^a-z0-9']+/g, " ").split(" ");
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var w = raw[i];
      if (!w || w === "'") continue;
      if (w.length === 1 && !/[0-9]/.test(w)) continue;   // stray letters
      if (/^[0-9]+$/.test(w)) w = "#num";                 // digits carry no signal
      out.push(w);
    }
    return out;
  }
  // Unigrams plus adjacent bigrams — bigrams are what let the model learn
  // phrases like "don't know" or "must be" instead of isolated words.
  function terms(text) {
    var ws = tokens(text), out = [];
    for (var i = 0; i < ws.length; i++) {
      out.push(ws[i]);
      if (i + 1 < ws.length) out.push(ws[i] + "~" + ws[i + 1]);
    }
    return out;
  }
  function counts(list) {
    var m = Object.create(null);
    for (var i = 0; i < list.length; i++) m[list[i]] = (m[list[i]] || 0) + 1;
    return m;
  }

  /* Vocabulary + IDF over the whole training corpus. (Fitting the
     vocabulary on all folds is standard practice and leaks no labels —
     only which words exist, never which class they belong to.) */
  function buildVocab(docTerms) {
    var df = Object.create(null), i, k;
    for (i = 0; i < docTerms.length; i++) {
      var seen = Object.create(null);
      var t = docTerms[i];
      for (k in t) if (!seen[k]) { seen[k] = 1; df[k] = (df[k] || 0) + 1; }
    }
    var vocab = Object.create(null), inv = [], idf = [], n = docTerms.length;
    for (k in df) {
      if (df[k] < MIN_DF) continue;
      vocab[k] = inv.length;
      inv.push(k);
      idf.push(Math.log((1 + n) / (1 + df[k])) + 1);
    }
    var dfArr = new Int32Array(inv.length);
    for (i = 0; i < inv.length; i++) dfArr[i] = df[inv[i]];
    return { map: vocab, inv: inv, idf: idf, df: dfArr, n: n };
  }

  /* Sublinear TF-IDF, L2-normalised -> sparse {idx, val}. */
  function vectorize(termCounts, voc) {
    var idx = [], val = [], k, j, norm = 0;
    for (k in termCounts) {
      j = voc.map[k];
      if (j === undefined) continue;
      var v = (1 + Math.log(termCounts[k])) * voc.idf[j];
      idx.push(j); val.push(v);
      norm += v * v;
    }
    norm = Math.sqrt(norm) || 1;
    for (var i = 0; i < val.length; i++) val[i] /= norm;
    return { idx: idx, val: val };
  }

  /* ============================================================
     Logistic regression (AdaGrad SGD, class-balanced, L2)
     ============================================================ */
  function sigmoid(z) {
    if (z >= 0) return 1 / (1 + Math.exp(-z));
    var e = Math.exp(z);
    return e / (1 + e);
  }
  function dot(w, x) {
    var s = 0;
    for (var i = 0; i < x.idx.length; i++) s += w[x.idx[i]] * x.val[i];
    return s;
  }

  function fit(X, y, rows, dim, classW) {
    var w = new Float64Array(dim), acc = new Float64Array(dim);
    var b = 0, accB = 0;
    var rand = rng(SEED);
    var m = rows.length;
    for (var ep = 0; ep < EPOCHS; ep++) {
      var order = shuffled(m, rand);
      for (var oi = 0; oi < m; oi++) {
        var i = rows[order[oi]];
        var x = X[i];
        var p = sigmoid(b + dot(w, x));
        var g = (p - y[i]) * classW[y[i]];
        for (var f = 0; f < x.idx.length; f++) {
          var j = x.idx[f];
          var grad = g * x.val[f] + LAMBDA * w[j];
          acc[j] += grad * grad;
          w[j] -= LR * grad / (Math.sqrt(acc[j]) + 1e-8);
        }
        accB += g * g;
        b -= LR * g / (Math.sqrt(accB) + 1e-8);
      }
    }
    return { w: w, b: b };
  }

  /* ============================================================
     Metrics — all computed on held-out (out-of-fold) predictions
     ============================================================ */
  function auc(y, p) {
    var n = y.length, i;
    var order = [];
    for (i = 0; i < n; i++) order.push(i);
    order.sort(function (a, c) { return p[a] - p[c]; });
    // average ranks over ties
    var ranks = new Float64Array(n), i0 = 0;
    while (i0 < n) {
      var i1 = i0;
      while (i1 + 1 < n && p[order[i1 + 1]] === p[order[i0]]) i1++;
      var r = (i0 + i1) / 2 + 1;
      for (i = i0; i <= i1; i++) ranks[order[i]] = r;
      i0 = i1 + 1;
    }
    var sumPos = 0, nPos = 0, nNeg = 0;
    for (i = 0; i < n; i++) {
      if (y[i] === 1) { sumPos += ranks[i]; nPos++; } else nNeg++;
    }
    if (!nPos || !nNeg) return null;
    return (sumPos - nPos * (nPos + 1) / 2) / (nPos * nNeg);
  }

  // Expected calibration error: does "80% confident" mean right 80% of the time?
  function ece(y, p, bins) {
    bins = bins || 10;
    var cnt = new Float64Array(bins), conf = new Float64Array(bins), hit = new Float64Array(bins);
    for (var i = 0; i < y.length; i++) {
      var c = p[i] >= 0.5 ? p[i] : 1 - p[i];
      var lab = p[i] >= 0.5 ? 1 : 0;
      var b = Math.min(bins - 1, Math.floor((c - 0.5) * 2 * bins));
      cnt[b]++; conf[b] += c; hit[b] += (lab === y[i] ? 1 : 0);
    }
    var e = 0, n = y.length;
    for (var k = 0; k < bins; k++) {
      if (!cnt[k]) continue;
      e += (cnt[k] / n) * Math.abs(conf[k] / cnt[k] - hit[k] / cnt[k]);
    }
    return e;
  }

  function score(y, p) {
    var n = y.length, tp = 0, fp = 0, tn = 0, fn = 0, ll = 0, br = 0;
    for (var i = 0; i < n; i++) {
      var yhat = p[i] >= 0.5 ? 1 : 0;
      if (y[i] === 1) { if (yhat === 1) tp++; else fn++; }
      else            { if (yhat === 1) fp++; else tn++; }
      var q = Math.min(1 - 1e-12, Math.max(1e-12, p[i]));
      ll += -(y[i] * Math.log(q) + (1 - y[i]) * Math.log(1 - q));
      br += (p[i] - y[i]) * (p[i] - y[i]);
    }
    var prec = tp + fp ? tp / (tp + fp) : 0;
    var rec  = tp + fn ? tp / (tp + fn) : 0;
    var spec = tn + fp ? tn / (tn + fp) : 0;
    return {
      n: n, tp: tp, fp: fp, tn: tn, fn: fn,
      accuracy: (tp + tn) / n,
      balanced: (rec + spec) / 2,
      precision: prec,
      recall: rec,
      specificity: spec,
      f1: prec + rec ? 2 * prec * rec / (prec + rec) : 0,
      auc: auc(y, p),
      logLoss: ll / n,
      brier: br / n,
      ece: ece(y, p)
    };
  }

  /* ============================================================
     Stratified fold assignment (deterministic)
     ============================================================ */
  function foldsFor(y, k) {
    var fold = new Int32Array(y.length);
    var rand = rng(SEED + 7);
    var byClass = [[], []];
    for (var i = 0; i < y.length; i++) byClass[y[i]].push(i);
    byClass.forEach(function (list) {
      var ord = shuffled(list.length, rand);
      for (var j = 0; j < ord.length; j++) fold[list[ord[j]]] = j % k;
    });
    return fold;
  }

  /* ============================================================
     train(docs) — docs: [{ id, text, label(0|1) }]
     ============================================================ */
  function train(docs) {
    docs = (docs || []).filter(function (d) {
      return d && typeof d.text === "string" && d.text.trim() &&
             (d.label === 0 || d.label === 1);
    });

    var n = docs.length, i;
    var y = new Int8Array(n), nPos = 0;
    for (i = 0; i < n; i++) { y[i] = docs[i].label; nPos += y[i]; }
    var nNeg = n - nPos;

    // Not enough signal to learn anything — say so instead of faking a score.
    if (n < 20 || nPos < 5 || nNeg < 5) {
      return {
        ready: false,
        reason: n < 20 ? "Too few examples to train on (need at least 20)."
                       : "Both classes need at least 5 examples.",
        oof: {}, metrics: null,
        predict: function () { return null; },
        topFeatures: { positive: [], negative: [] }
      };
    }

    var docTerms = new Array(n);
    for (i = 0; i < n; i++) docTerms[i] = counts(terms(docs[i].text));
    var voc = buildVocab(docTerms);

    var X = new Array(n);
    for (i = 0; i < n; i++) X[i] = vectorize(docTerms[i], voc);

    var dim = voc.inv.length;
    var classW = [n / (2 * nNeg), n / (2 * nPos)];   // balance the two classes

    /* ---- cross-validation: an honest probability for every example ---- */
    var k = Math.min(FOLDS, Math.min(nPos, nNeg));
    var fold = foldsFor(y, k);
    var oofP = new Float64Array(n);
    for (var f = 0; f < k; f++) {
      var tr = [];
      for (i = 0; i < n; i++) if (fold[i] !== f) tr.push(i);
      var m = fit(X, y, tr, dim, classW);
      for (i = 0; i < n; i++) {
        if (fold[i] === f) oofP[i] = sigmoid(m.b + dot(m.w, X[i]));
      }
    }
    var metrics = score(y, oofP);
    metrics.folds = k;
    metrics.features = dim;
    metrics.docs = n;
    metrics.pos = nPos;
    metrics.neg = nNeg;

    /* ---- final model: refit on everything, used for unseen text ---- */
    var all = [];
    for (i = 0; i < n; i++) all.push(i);
    var full = fit(X, y, all, dim, classW);

    var oof = Object.create(null);
    for (i = 0; i < n; i++) if (docs[i].id != null) oof[docs[i].id] = oofP[i];

    /* ---- what the model actually learned (for display / sanity) ---- */
    function topFeatures(limit) {
      var pool = [];
      for (var j = 0; j < dim; j++) {
        if (voc.df[j] < 4) continue;          // ignore near-hapax noise
        pool.push([voc.inv[j].replace(/~/g, " "), full.w[j]]);
      }
      pool.sort(function (a, b) { return b[1] - a[1]; });
      return {
        positive: pool.slice(0, limit),
        negative: pool.slice(-limit).reverse()
      };
    }

    return {
      ready: true,
      metrics: metrics,
      oof: oof,
      // P(text shows the bias in action)
      predict: function (text) {
        return sigmoid(full.b + dot(full.w, vectorize(counts(terms(text)), voc)));
      },
      topFeatures: topFeatures(12)
    };
  }

  window.CVModel = { train: train, version: 1 };
})();
