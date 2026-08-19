/* ============================================================
   Content Verify — Retrieval.

   Answers one question: given a piece of text, which cognitive biases
   does it resemble, why, and is there enough evidence to say so?

   Everything it reports comes from YOUR dataset. It has no knowledge of
   cognitive biases of its own — it cannot name a bias that has no
   example, and it cannot be confident about one whose examples are thin.
   That is the point: it makes curation the thing that moves the answers.

   How a query is answered
     1. encode the text (encoder.js — swappable)
     2. cosine against every example, through an inverted index
     3. keep the K nearest
     4. group them by bias: examples vote for, counter-examples against
     5. decide how much may be claimed

   Confidence is measured, never asserted. build() runs leave-one-out
   over the dataset twice:
     pass 1  calibrates similarity -> observed P(top-1 correct)
     pass 2  replays every example through the SAME decision path a live
             query takes, giving an honest accuracy/coverage curve and
             per-bias accuracy — the curation to-do list.

   Duplicate texts are grouped and hidden together during evaluation.
   Without it, an example retrieves its own copy at similarity 1.0 and
   every score is a lie: top-1 reads 98.9% with the guard disabled
   against 42.2% with it on. The duplicated "Need to Act Fast" quadrant
   that made this urgent is now merged at build time, but the guard stays
   — the sheets are edited by hand and a re-pasted row is a normal event.

   Exposes: window.CVRetrieval.build(docs, encoder) -> index
   ============================================================ */
(function () {
  "use strict";

  var K_NEIGHBOURS = 15;    // how many nearest examples inform an answer
  /* Counter-examples do not vote here any more, and the reason is worth
     stating because 0.7 looked reasonable and was quietly the single most
     expensive number in the file.

     The counter-examples in this corpus are minimal-pair rewrites of the
     examples they sit beside — "A teenager starts listening to a music
     artist ... all of her friends are talking about it" against "A teenager
     who notices her friends all listening to a new artist ...". As prose
     they are almost the same string, so the counter-example is retrieved
     whenever its own example is. Measured: in 60.7% of queries the true
     bias's own counter-example comes back alongside its example and votes
     against it. The guard fired hardest exactly where it was least wanted.

       NEG_WEIGHT   top-1   prose queries   clear thinking named as its bias
          0.7       49.8%       58.4%                30.7%
          0.35      56.9%       67.4%                40.7%
          0         62.9%       74.7%                55.3%

     Targeted variants were tried instead — vetoing only when a counter-
     example is closer than every example (39.4%), soft-vetoing (55.0%),
     damping by the positive's share of the evidence (52.0%) — and all were
     worse than simply not voting.

     That last column is the cost, and it is paid somewhere better. This
     file answers "which bias is this text about", for which a counter-
     example of anchoring is still anchoring material. Whether the bias is
     actually present is a different question, and model.js already answers
     it at 84% with AUC 0.92 — so the app shows that verdict beside these
     candidates rather than smearing it through the similarity scores.
     Counter-examples remain in the index as neighbours the user can read,
     and remain the negative class model.js trains on. */
  var NEG_WEIGHT   = 0;
  var MIN_KNOWN    = 3;     // fewer recognised terms than this -> insufficient
  /* SIM_FLOOR drops a neighbour from the ballot entirely. It was 0.12, which
     silently discarded 28% of all queries as "nothing close enough" — not
     because they were unmatchable, but because cosine against a 30-word
     example is spread thin across its terms and rarely clears 0.12 even when
     the right bias is sitting right there. Measured over the corpus:

       floor  K    top1    no candidate at all
        0.12  15   42.2%      28.0%
        0.08  15   48.5%       4.4%
        0.06  20   50.3%       0.4%   <- chosen
        0.04  25   51.2%       0.0%

     Lowering it does not make the system claim more than it has: decide()
     still forces "unreliable" whenever the best similarity falls below
     CAL_BINS[0] (0.15), and confidence still comes from the measured
     calibration. All the floor was doing was starving the vote of evidence
     before that judgement was ever made. */
  var SIM_FLOOR    = 0.06;
  var CAL_BINS     = [0.15, 0.22, 0.30, 0.40, 0.55];
  /* Where to speak and how firmly. Confidence is conf * share * support,
     and `share` is the top bias's slice of the positive similarity in the
     ballot — so it moves whenever SIM_FLOOR or K change how many biases get
     onto the ballot at all. These two numbers therefore have to be re-read
     off the coverage curve every time those change; the old 0.60/0.30 were
     measured against the 0.12 floor and, left in place after it moved, cut
     the share of queries answered from 36% to 13%.

     Measured now (leave-one-out, held out, K=15, floor 0.06, NEG_WEIGHT 0):

       confidence >=   share of queries   top-1 correct there
            0.12             86.0%              69.8%
            0.15             76.2%              73.8%   <- WEAK_CONF
            0.20             62.4%              80.2%
            0.25             51.0%              84.9%
            0.30             41.4%              88.8%   <- OK_CONF
            0.40             27.2%              92.9%

     So "a likely candidate" is right about three times in four, and the
     confident tier is right about nine times in ten. Read together with the
     NEG_WEIGHT note above: dropping the counter-example vote moved top-1
     from 49.7% to 62.9% and top-3 from 62.5% to 76.1%, and the share of
     queries answered at all from 42.3% to 61.3% — without giving up
     precision, which rose from 76.3% to 78.2%. */
  var OK_CONF      = 0.30;  // present as an answer
  var WEAK_CONF    = 0.15;  // present as a candidate worth looking at
  var MIN_SUPPORT  = 8;     // examples a bias needs before it can be asserted
  var MIN_MARGIN   = 0.12;  // top-1 vs top-2 separation

  function sortSparse(v) {
    var pairs = [], i;
    for (i = 0; i < v.idx.length; i++) pairs.push([v.idx[i], v.val[i]]);
    pairs.sort(function (a, b) { return a[0] - b[0]; });
    var idx = [], val = [];
    for (i = 0; i < pairs.length; i++) { idx.push(pairs[i][0]); val.push(pairs[i][1]); }
    return { idx: idx, val: val };
  }
  function wilsonLower(hits, n) {
    if (!n) return 0;
    var z = 1.2816, p = hits / n, d = 1 + z * z / n;
    var c = p + z * z / (2 * n);
    var m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return Math.max(0, Math.min(1, (c - m) / d));
  }
  function calBin(sim) {
    for (var i = 0; i < CAL_BINS.length; i++) if (sim < CAL_BINS[i]) return i;
    return CAL_BINS.length;
  }
  // A bias with few examples cannot support a confident claim however
  // close the match looks. Saturates at MIN_SUPPORT*2.
  function supportFactor(support) {
    return Math.min(1, Math.sqrt(support / (MIN_SUPPORT * 2)));
  }

  function build(docs, encoder) {
    docs = (docs || []).filter(function (d) {
      return d && typeof d.text === "string" && d.text.trim() && d.biasKey;
    });
    var n = docs.length, i;

    if (n < 5 || !encoder) {
      return {
        ready: false,
        reason: "Not enough examples in the dataset to retrieve against.",
        size: n, encoderId: encoder ? encoder.id : "none",
        perBias: {}, stats: null,
        query: function () {
          return { status: "insufficient", candidates: [], neighbours: [],
                   evidence: { terms: 0, known: 0, coverage: 0, maxSimilarity: 0 },
                   reason: "The dataset is empty." };
        }
      };
    }

    /* What is indexed is the example minus its citation; what is reported
       is the example as curated. Author names are the rarest tokens in the
       corpus and line up exactly with whichever bias cites that paper, so
       indexing them lets a bias be found by its bibliography — an accuracy
       that vanishes the moment a real user pastes text. See the note in
       encoder.js. */
    var strip = (window.CVEncoder && window.CVEncoder.stripCitation) ||
                function (t) { return t; };
    var indexText = docs.map(function (d) { return strip(d.text); });

    encoder.fit(indexText);
    var vecs = indexText.map(function (t) { return sortSparse(encoder.encode(t)); });

    /* inverted index: feature -> [docIdx, weight, ...] */
    var post = Object.create(null);
    for (i = 0; i < n; i++) {
      var v = vecs[i];
      for (var f = 0; f < v.idx.length; f++) {
        var t = v.idx[f];
        if (!post[t]) post[t] = [];
        post[t].push(i, v.val[f]);
      }
    }

    /* duplicate groups — identical text hides together during evaluation */
    var dupGroup = new Array(n);
    (function () {
      var seen = Object.create(null), next = 0;
      for (var j = 0; j < n; j++) {
        // Keyed on the indexed text, so two copies of one example that
        // differ only in the citation attached still hide together.
        var key = indexText[j].toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        if (seen[key] === undefined) seen[key] = next++;
        dupGroup[j] = seen[key];
      }
    })();

    /* per-bias bookkeeping */
    var perBias = Object.create(null);
    docs.forEach(function (d) {
      if (!perBias[d.biasKey]) {
        perBias[d.biasKey] = { key: d.biasKey, name: d.biasName, quad: d.quad,
                               cat: d.cat, pos: 0, neg: 0, correct: 0, tried: 0,
                               answered: 0 };
      }
      if (d.label === 1) perBias[d.biasKey].pos++; else perBias[d.biasKey].neg++;
    });

    function scan(vec, excludeGroup) {
      var acc = Object.create(null);
      for (var f = 0; f < vec.idx.length; f++) {
        var lst = post[vec.idx[f]];
        if (!lst) continue;
        var qv = vec.val[f];
        for (var p = 0; p < lst.length; p += 2) {
          var di = lst[p];
          if (excludeGroup >= 0 && dupGroup[di] === excludeGroup) continue;
          acc[di] = (acc[di] || 0) + qv * lst[p + 1];
        }
      }
      var out = [];
      for (var k in acc) if (acc[k] >= SIM_FLOOR) out.push([+k, acc[k]]);
      out.sort(function (a, b) { return b[1] - a[1]; });
      return out.slice(0, K_NEIGHBOURS);
    }

    function aggregate(near) {
      var byBias = Object.create(null), total = 0, k;
      near.forEach(function (pair) {
        var d = docs[pair[0]], sim = pair[1];
        if (!byBias[d.biasKey]) {
          byBias[d.biasKey] = { key: d.biasKey, name: d.biasName, quad: d.quad,
                                cat: d.cat, score: 0, forSim: 0, against: 0,
                                neighbours: [] };
        }
        var c = byBias[d.biasKey];
        if (d.label === 1) { c.score += sim; c.forSim += sim; total += sim; }
        else               { c.score -= sim * NEG_WEIGHT; c.against += sim; }
        c.neighbours.push({ id: d.id, text: d.text, label: d.label,
                            similarity: sim, biasName: d.biasName });
      });
      var list = [];
      for (k in byBias) {
        var c2 = byBias[k];
        c2.support = perBias[k] ? perBias[k].pos : 0;
        c2.counterSupport = perBias[k] ? perBias[k].neg : 0;
        c2.share = total > 0 ? Math.max(0, c2.score) / total : 0;
        c2.neighbours.sort(function (a, b) { return b.similarity - a.similarity; });
        list.push(c2);
      }
      list.sort(function (a, b) { return b.score - a.score; });
      return list;
    }

    /* ---- the single decision path, shared by evaluation and live queries ---- */
    var calibration = null;   // set after pass 1

    function decide(near) {
      var out = { candidates: [], neighbours: [], status: "unreliable", reason: "" };
      if (!near.length) {
        out.status = "unreliable";
        out.reason = "Nothing in your dataset is close enough to this text to be " +
          "evidence of anything.";
        return out;
      }
      var maxSim = near[0][1];
      out.maxSimilarity = maxSim;
      out.neighbours = near.map(function (p) {
        var d = docs[p[0]];
        return { id: d.id, text: d.text, label: d.label, biasKey: d.biasKey,
                 biasName: d.biasName, similarity: p[1] };
      });

      var cands = aggregate(near).filter(function (c) { return c.score > 0; });
      var cal = calibration ? calibration[calBin(maxSim)] : null;
      var conf = cal ? cal.confidence : 0;
      out.calibration = cal ? { n: cal.n, measured: cal.accuracy } : null;

      if (!cands.length) {
        out.status = "unreliable";
        out.reason = "The closest material in your dataset is counter-examples — " +
          "nothing here points to a specific bias.";
        return out;
      }

      out.candidates = cands.slice(0, 5).map(function (c) {
        return { key: c.key, name: c.name, quad: c.quad, cat: c.cat,
                 share: c.share, score: c.score, support: c.support,
                 counterSupport: c.counterSupport,
                 confidence: conf * c.share * supportFactor(c.support),
                 neighbours: c.neighbours.slice(0, 4),
                 thin: c.support < MIN_SUPPORT };
      });

      var top = out.candidates[0];
      var margin = cands.length > 1
        ? (cands[0].score - cands[1].score) / (cands[0].score || 1) : 1;
      var measured = cal && cal.accuracy != null
        ? " At this similarity the leading guess has been right " +
          Math.round(cal.accuracy * 100) + "% of the time (" + cal.n + " checks)."
        : "";

      if (top.confidence < WEAK_CONF || maxSim < CAL_BINS[0]) {
        out.status = "unreliable";
        out.reason = "Nothing in your dataset is close enough to support a call." +
          measured + " The nearest examples below are context, not a prediction.";
      } else if (top.support < MIN_SUPPORT) {
        out.status = "thin";
        out.reason = "“" + top.name + "” has only " + top.support + " example" +
          (top.support === 1 ? "" : "s") + " in your dataset — too few to be " +
          "confident, however close the match looks. Adding examples of this " +
          "bias is the fastest way to improve this answer.";
      } else if (margin < MIN_MARGIN && out.candidates.length > 1) {
        out.status = "ambiguous";
        out.reason = "Several biases fit about equally well — the nearest " +
          "examples disagree. Listed as candidates rather than an answer.";
      } else if (top.confidence < OK_CONF) {
        out.status = "weak";
        out.reason = "A likely candidate, but not a confident one." + measured +
          " Treat the nearest examples as the actual evidence.";
      } else {
        out.status = "ok";
        out.reason = "Based on the " + out.neighbours.length + " nearest examples " +
          "in your dataset." + measured;
      }
      return out;
    }

    /* ============================================================
       Leave-one-out, two passes
       ============================================================ */
    var positives = [];
    for (i = 0; i < n; i++) if (docs[i].label === 1) positives.push(i);

    // pass 1 — calibrate similarity against observed correctness
    var binHit = [], binN = [];
    for (i = 0; i <= CAL_BINS.length; i++) { binHit.push(0); binN.push(0); }
    var nearCache = new Array(positives.length);
    positives.forEach(function (di, qi) {
      var near = scan(vecs[di], dupGroup[di]);
      nearCache[qi] = near;
      if (!near.length) return;
      var cands = aggregate(near).filter(function (c) { return c.score > 0; });
      if (!cands.length) return;
      var b = calBin(near[0][1]);
      binN[b]++;
      if (cands[0].key === docs[di].biasKey) binHit[b]++;
    });
    calibration = [];
    for (i = 0; i <= CAL_BINS.length; i++) {
      calibration.push({
        upTo: i < CAL_BINS.length ? CAL_BINS[i] : null,
        n: binN[i],
        accuracy: binN[i] ? binHit[i] / binN[i] : null,
        confidence: wilsonLower(binHit[i], binN[i])
      });
    }

    // pass 2 — replay through the real decision path
    var loo = { n: 0, top1: 0, top3: 0, top5: 0, answered: 0, answeredTop1: 0 };
    var byStatus = Object.create(null);
    var curve = [];
    positives.forEach(function (di, qi) {
      var res = decide(nearCache[qi]);
      var truth = docs[di].biasKey;
      loo.n++;
      byStatus[res.status] = (byStatus[res.status] || 0) + 1;
      var rank = -1;
      for (var r = 0; r < res.candidates.length; r++) {
        if (res.candidates[r].key === truth) { rank = r; break; }
      }
      if (rank === 0) loo.top1++;
      if (rank >= 0 && rank < 3) loo.top3++;
      if (rank >= 0 && rank < 5) loo.top5++;

      var pb = perBias[truth];
      pb.tried++;
      if (rank === 0) pb.correct++;

      var presented = res.status === "ok" || res.status === "weak";
      if (presented) {
        loo.answered++;
        if (rank === 0) loo.answeredTop1++;
        pb.answered++;
      }
      if (res.candidates.length) {
        curve.push({ conf: res.candidates[0].confidence, hit: rank === 0 });
      }
    });

    // honest accuracy/coverage trade-off, from held-out predictions
    var coverage = [];
    [0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.25, 0.30, 0.40, 0.50].forEach(function (th) {
      var g = curve.filter(function (x) { return x.conf >= th; });
      coverage.push({
        threshold: th,
        share: loo.n ? g.length / loo.n : 0,
        accuracy: g.length ? g.filter(function (x) { return x.hit; }).length / g.length : null,
        n: g.length
      });
    });

    Object.keys(perBias).forEach(function (k) {
      var p = perBias[k];
      p.accuracy = p.tried ? p.correct / p.tried : null;
    });

    var stats = {
      docs: n,
      positives: positives.length,
      biases: Object.keys(perBias).length,
      encoderId: encoder.id,
      encoderLabel: encoder.label,
      features: encoder.size(),
      k: K_NEIGHBOURS,
      calibration: calibration,
      coverage: coverage,
      statusMix: byStatus,
      loo: {
        n: loo.n,
        top1: loo.n ? loo.top1 / loo.n : 0,
        top3: loo.n ? loo.top3 / loo.n : 0,
        top5: loo.n ? loo.top5 / loo.n : 0,
        presented: loo.n ? loo.answered / loo.n : 0,
        top1WhenPresented: loo.answered ? loo.answeredTop1 / loo.answered : 0
      }
    };

    /* ============================================================
       query(text) — the live path
       ============================================================ */
    function query(text) {
      var raw = String(text || "").trim();
      var seen = Object.create(null), known = 0, uniq = 0;
      encoder.terms(raw).forEach(function (t) {
        if (seen[t]) return;
        seen[t] = 1; uniq++;
        if (encoder.known(t)) known++;
      });

      var base = {
        text: raw, encoderId: encoder.id, candidates: [], neighbours: [],
        evidence: { terms: uniq, known: known,
                    coverage: uniq ? known / uniq : 0, maxSimilarity: 0 }
      };
      if (!raw) {
        base.status = "empty";
        base.reason = "Nothing to analyse yet.";
        return base;
      }
      var issues = window.CVEncoder && window.CVEncoder.textIssues
        ? window.CVEncoder.textIssues(raw) : [];
      if (issues.indexOf("truncated") >= 0) {
        base.status = "incomplete";
        base.reason = "This stops mid-thought — the rest of the sentence could " +
          "change what it means, so it is not being matched against your dataset.";
        return base;
      }
      if (known < MIN_KNOWN) {
        base.status = "insufficient";
        base.reason = known === 0
          ? "None of these words appear anywhere in your dataset."
          : "Only " + known + " of " + uniq + " word patterns here appear in your " +
            "dataset — too little to compare against.";
        return base;
      }

      var res = decide(scan(sortSparse(encoder.encode(raw)), -1));
      base.status = res.status;
      base.reason = res.reason;
      base.candidates = res.candidates;
      base.neighbours = res.neighbours;
      base.calibration = res.calibration;
      base.evidence.maxSimilarity = res.maxSimilarity || 0;
      return base;
    }

    return {
      ready: true,
      size: n,
      encoderId: encoder.id,
      encoderLabel: encoder.label,
      stats: stats,
      perBias: perBias,
      query: query
    };
  }

  window.CVRetrieval = { build: build, version: 1 };
})();
