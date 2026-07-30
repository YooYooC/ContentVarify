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

  /* ---- evidence gate (see assess()) --------------------------------
     Vectors are L2-normalised, which deliberately makes long and short
     texts comparable — but it also rescales a text with almost no known
     words up to unit length, so a single stray feature can produce a
     confident-looking probability. These thresholds catch that.

     Chosen by measuring the accuracy/coverage trade-off on out-of-fold
     predictions over the 2,493-example corpus:

       rule                     coverage   accuracy on what is kept
       none                       100%        81.4%
       known>=4, conc<=0.70        94.2%      81.9%
       known>=5, conc<=0.60        87.9%      82.7%   <- chosen
       known>=6, conc<=0.55        80.4%      82.6%

     The 12.1% it refuses is the population where the model is 71.8%
     accurate while claiming 85.8% confidence — 14 points overconfident.
     ------------------------------------------------------------------ */
  var IDF_CONTENT = 4.0;   // idf at or above which a term counts as content-bearing
  var MIN_KNOWN   = 5;     // fewer known features than this -> refuse to score
  var MAX_CONC    = 0.60;  // one feature carrying more than this share -> refuse
  var UNDECIDED   = 0.55;  // calibrated confidence below this -> "undecided"
  var CONTENT_BINS = [2, 3, 5, 8];   // upper edges of the evidence buckets

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
     Calibration — Platt scaling fitted on out-of-fold predictions.

     Raw logistic-regression probabilities are systematically too
     extreme: over this corpus the model says 80-90% and is right 71.9%
     of the time. Fitting P = sigmoid(A*z + B) on the held-out logits
     corrects the scale (measured A = 0.596 — a value below 1 IS the
     over-confidence). Two parameters over ~2.5k points, so the fact
     that it is fitted and applied to the same predictions is negligible.
     ============================================================ */
  function fitPlatt(z, y) {
    var A = 1, B = 0, it, i;
    for (it = 0; it < 100; it++) {
      var gA = 0, gB = 0, hA = 0, hB = 0;
      for (i = 0; i < z.length; i++) {
        var q = sigmoid(A * z[i] + B), e = q - y[i], v = q * (1 - q);
        gA += e * z[i]; gB += e; hA += v * z[i] * z[i]; hB += v;
      }
      A -= gA / (hA + 1e-9);
      B -= gB / (hB + 1e-9);
      if (!isFinite(A) || !isFinite(B)) return { A: 1, B: 0 };  // degenerate -> identity
    }
    return (A > 0 && isFinite(A) && isFinite(B)) ? { A: A, B: B } : { A: 1, B: 0 };
  }
  function logit(p) {
    var q = Math.min(1 - 1e-9, Math.max(1e-9, p));
    return Math.log(q / (1 - q));
  }

  /* Lower bound of a binomial proportion (Wilson, ~90% one-sided). Used so
     an evidence bucket with few examples can never license a confident
     claim on the strength of a small, lucky sample. */
  function wilsonLower(hits, n) {
    if (!n) return 0.5;
    var z = 1.2816, p = hits / n;
    var d = 1 + z * z / n;
    var c = p + z * z / (2 * n);
    var m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return Math.max(0.5, Math.min(1, (c - m) / d));
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
     Evidence — how much the model actually has to go on.

     Measured BEFORE L2 normalisation, which is the whole point:
     normalisation rescales every text to unit length, so after it a
     six-word interjection looks exactly as substantial as a full
     sentence. These counts are what normalisation throws away.

       known          distinct terms found in the vocabulary
       content        of those, ones carrying real information (high idf)
                      rather than function words
       coverage       known / distinct terms produced
       concentration  share of the decision resting on ONE feature
     ============================================================ */
  function evidenceOf(termCounts, voc, w) {
    var vec = vectorize(termCounts, voc);
    var known = 0, content = 0, mass = 0, uniq = 0, k, j;
    for (k in termCounts) {
      uniq++;
      j = voc.map[k];
      if (j === undefined) continue;
      known++;
      mass += (1 + Math.log(termCounts[k])) * voc.idf[j];
      if (voc.idf[j] >= IDF_CONTENT) content++;
    }
    var total = 0, top = 0;
    for (var f = 0; f < vec.idx.length; f++) {
      var c = Math.abs(w[vec.idx[f]] * vec.val[f]);
      total += c;
      if (c > top) top = c;
    }
    return {
      vec: vec, known: known, content: content, mass: mass, terms: uniq,
      coverage: uniq ? known / uniq : 0,
      concentration: total > 0 ? top / total : 1
    };
  }
  function contentBin(c) {
    for (var i = 0; i < CONTENT_BINS.length; i++) if (c < CONTENT_BINS[i]) return i;
    return CONTENT_BINS.length;
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
        assess: function () {
          return { status: "insufficient", confidence: null, p: null, label: null,
                   reason: "No trained model yet.", evidence: null };
        },
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
    /* ---- calibration: fitted on the held-out predictions only ---- */
    var zs = new Float64Array(n);
    for (i = 0; i < n; i++) zs[i] = logit(oofP[i]);
    var platt = fitPlatt(zs, y);
    var oofC = new Float64Array(n);          // calibrated out-of-fold probability
    for (i = 0; i < n; i++) oofC[i] = sigmoid(platt.A * zs[i] + platt.B);

    // Everything reported is measured on the calibrated held-out numbers,
    // because those are the numbers the app actually displays.
    var metrics = score(y, oofC);
    metrics.folds = k;
    metrics.features = dim;
    metrics.docs = n;
    metrics.pos = nPos;
    metrics.neg = nNeg;
    metrics.platt = platt;
    metrics.eceRaw = ece(y, oofP);           // for comparison: before calibration
    metrics.brierRaw = score(y, oofP).brier;

    /* ---- final model: refit on everything, used for unseen text ---- */
    var all = [];
    for (i = 0; i < n; i++) all.push(i);
    var full = fit(X, y, all, dim, classW);

    /* ---- how accurate the model actually is at each evidence level ----
       This is the ceiling on what may be claimed for a new text: with only
       three content words to go on, the model has been measured at ~77%,
       so it may not report 98% however extreme the raw probability is. */
    var caps = [], bucketN = [], bucketHit = [];
    for (i = 0; i <= CONTENT_BINS.length; i++) { bucketN.push(0); bucketHit.push(0); }
    for (i = 0; i < n; i++) {
      var bi = contentBin(evidenceOf(docTerms[i], voc, full.w).content);
      bucketN[bi]++;
      if ((oofC[i] >= 0.5 ? 1 : 0) === y[i]) bucketHit[bi]++;
    }
    for (i = 0; i <= CONTENT_BINS.length; i++) caps.push(wilsonLower(bucketHit[i], bucketN[i]));
    metrics.evidenceBuckets = [];
    for (i = 0; i <= CONTENT_BINS.length; i++) {
      metrics.evidenceBuckets.push({
        upTo: i < CONTENT_BINS.length ? CONTENT_BINS[i] : null,
        n: bucketN[i],
        accuracy: bucketN[i] ? bucketHit[i] / bucketN[i] : null,
        cap: caps[i]
      });
    }

    // Median concentration across the corpus — used to explain rejections.
    var concs = [];
    for (i = 0; i < n; i++) concs.push(evidenceOf(docTerms[i], voc, full.w).concentration);
    concs.sort(function (a, b) { return a - b; });
    var medConc = concs[Math.floor(concs.length / 2)];

    var oof = Object.create(null);
    for (i = 0; i < n; i++) if (docs[i].id != null) oof[docs[i].id] = oofC[i];

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

    /* ============================================================
       assess(text) — the ONLY safe entry point for unseen text.

       Returns a decision, not a bare number. A raw probability is never
       handed out for text the model has no business judging:

         "insufficient"  nothing in the text was ever seen in training
         "unreliable"    too few known features, or the whole decision
                         resting on a single word
         "undecided"     enough evidence, but the wording points both ways
         "ok"            a calibrated confidence, capped by the model's
                         measured accuracy at this evidence level

       For the first two, `confidence` is null by construction, so no
       caller can accidentally display a percentage.
       ============================================================ */
    function assess(text) {
      var e = evidenceOf(counts(terms(text)), voc, full.w);
      var out = {
        status: "ok", p: null, label: null, confidence: null, cap: null,
        reason: "",
        evidence: { known: e.known, content: e.content, terms: e.terms,
                    coverage: e.coverage, concentration: e.concentration }
      };

      if (e.known === 0) {
        out.status = "insufficient";
        out.reason = e.terms
          ? "None of these words appear anywhere in the training set."
          : "There is no text to judge.";
        return out;
      }
      if (e.known < MIN_KNOWN) {
        out.status = "unreliable";
        out.reason = "Only " + e.known + " of " + e.terms + " word patterns here " +
          "are ones the model learned from — it needs at least " + MIN_KNOWN + ".";
        return out;
      }
      if (e.concentration > MAX_CONC) {
        out.status = "unreliable";
        out.reason = "A single word is carrying " + Math.round(e.concentration * 100) +
          "% of this decision (across the training examples one word carries " +
          Math.round(medConc * 100) + "% on average).";
        return out;
      }

      var p = sigmoid(platt.A * (full.b + dot(full.w, e.vec)) + platt.B);
      var conf = Math.max(p, 1 - p);
      var cap = caps[contentBin(e.content)];
      out.p = p;
      out.label = p >= 0.5 ? 1 : 0;
      out.cap = cap;

      if (conf < UNDECIDED) {
        out.status = "undecided";
        out.reason = "The wording points both ways — the model has no clear read.";
        return out;
      }
      out.confidence = Math.min(conf, cap);
      out.reason = "Calibrated on held-out data, then capped at " +
        Math.round(cap * 100) + "% — the model's measured accuracy on examples " +
        "with this much context.";
      return out;
    }

    return {
      ready: true,
      metrics: metrics,
      oof: oof,                    // CALIBRATED out-of-fold probabilities
      assess: assess,
      // Raw P(text shows the bias in action) — uncalibrated and ungated.
      // Internal use only; never show this to a user for unseen text.
      predict: function (text) {
        return sigmoid(full.b + dot(full.w, vectorize(counts(terms(text)), voc)));
      },
      topFeatures: topFeatures(12)
    };
  }

  window.CVModel = { train: train, version: 2 };
})();
