/* ============================================================
   Content Verify — Encoder.

   Turns text into a vector. That is the ONLY thing it does, and the
   only thing anything else may assume about it.

   The point of this file is the interface, not the implementation. Any
   object with this shape can be dropped in — a sentence-embedding model,
   an API client, something else entirely — and retrieval.js will not
   notice:

     encoder.id                 stable name, recorded with every result
     encoder.kind               "sparse" | "dense"
     encoder.fit(texts)         learn whatever the encoder needs (may be a no-op)
     encoder.encode(text)       -> vector
     encoder.terms(text)        -> the human-readable units it saw
     encoder.known(term)        -> is this unit represented?
     encoder.size()             -> vocabulary / dimensionality

   Vectors are L2-normalised, so a dot product IS cosine similarity.
   Sparse vectors are {idx: [int], val: [float]}; a dense encoder would
   return a Float32Array and retrieval.js handles both through dot().

   Today's implementation is TF-IDF over word unigrams and bigrams. It is
   deliberately the same family the baseline model uses, so switching to
   embeddings later is measured as one change, not two.
   ============================================================ */
(function () {
  "use strict";

  var MIN_DF = 1;   // retrieval keeps every term: a bias with one example
                    // must still be findable by the words in that example.

  function tokens(text) {
    var raw = String(text || "").toLowerCase().replace(/[^a-z0-9']+/g, " ").split(" ");
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var w = raw[i];
      if (!w || w === "'") continue;
      if (w.length === 1 && !/[0-9]/.test(w)) continue;
      if (/^[0-9]+$/.test(w)) w = "#num";
      out.push(w);
    }
    return out;
  }
  function termList(text) {
    var ws = tokens(text), out = [];
    for (var i = 0; i < ws.length; i++) {
      out.push(ws[i]);
      if (i + 1 < ws.length) out.push(ws[i] + "~" + ws[i + 1]);
    }
    return out;
  }
  function countTerms(list) {
    var m = Object.create(null);
    for (var i = 0; i < list.length; i++) m[list[i]] = (m[list[i]] || 0) + 1;
    return m;
  }

  function tfidfEncoder() {
    var map = Object.create(null);   // term -> index
    var inv = [];                    // index -> term
    var idf = [];
    var df  = [];
    var nDocs = 0;

    return {
      id: "tfidf-uni+bi-v1",
      kind: "sparse",
      label: "TF-IDF (words + word pairs)",

      fit: function (texts) {
        var dfMap = Object.create(null), i, k;
        nDocs = texts.length;
        for (i = 0; i < texts.length; i++) {
          var seen = Object.create(null);
          var t = termList(texts[i]);
          for (var j = 0; j < t.length; j++) {
            if (seen[t[j]]) continue;
            seen[t[j]] = 1;
            dfMap[t[j]] = (dfMap[t[j]] || 0) + 1;
          }
        }
        map = Object.create(null); inv = []; idf = []; df = [];
        for (k in dfMap) {
          if (dfMap[k] < MIN_DF) continue;
          map[k] = inv.length;
          inv.push(k);
          idf.push(Math.log((1 + nDocs) / (1 + dfMap[k])) + 1);
          df.push(dfMap[k]);
        }
        return this;
      },

      encode: function (text) {
        var cts = countTerms(termList(text));
        var idx = [], val = [], k, j, norm = 0;
        for (k in cts) {
          j = map[k];
          if (j === undefined) continue;
          var v = (1 + Math.log(cts[k])) * idf[j];
          idx.push(j); val.push(v);
          norm += v * v;
        }
        norm = Math.sqrt(norm) || 1;
        for (var i = 0; i < val.length; i++) val[i] /= norm;
        return { idx: idx, val: val };
      },

      // Human-readable units, used to explain WHY two texts matched.
      terms: termList,
      termOf: function (i) { return inv[i].replace(/~/g, " "); },
      known: function (t) { return map[t] !== undefined; },
      idfOf: function (t) { var j = map[t]; return j === undefined ? 0 : idf[j]; },
      dfOf:  function (t) { var j = map[t]; return j === undefined ? 0 : df[j]; },
      size: function () { return inv.length; }
    };
  }

  window.CVEncoder = {
    tfidf: tfidfEncoder,
    // Registry so the UI can name what produced a result, and so a future
    // encoder is added here rather than wired through the app.
    available: function () { return [{ id: "tfidf-uni+bi-v1", make: tfidfEncoder }]; }
  };
})();
