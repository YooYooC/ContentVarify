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

  /* ============================================================
     Text quality checks — properties of the text itself, independent of
     any model, so every scorer applies the same rule.

     A sentence cut off mid-thought ("...play with my friends in the")
     still contains plenty of recognisable words, so every similarity or
     probability measure will happily score it. It should not be scored
     at all: the missing half could change the meaning entirely.

     Detection is the dangling-function-word test, GATED ON THE ABSENCE OF
     TERMINAL PUNCTUATION. The gate is the whole trick. A dangling function
     word only means "cut off" when nothing closes the sentence: plenty of
     complete sentences end on one of these words and a full stop —
     "Agreeing with a popular opinion to fit in.", "...more dangerous than
     it is." Ungated, the test flags 86 of the 7,541 curated examples, 67
     of them complete sentences, and it rejected ordinary user queries
     ending in "was" or "it" before they were ever matched. Gated, it
     flags 21, which are examples genuinely missing their full stop.

     Missing terminal punctuation on its own was rejected as a signal: it
     flags 18.6% of the corpus, which are complete sentences whose final
     period was stripped. It is only evidence in combination.
     ============================================================ */
  var DANGLING = {};
  ("the a an and or but of in on at to for with from by as that which who whose " +
   "my his her their our its is was were are be been being i we they he she it " +
   "this these those than then so if when while because about into over under " +
   "after before near upon onto within between during although though whether"
  ).split(" ").forEach(function (w) { DANGLING[w] = 1; });

  function textIssues(text) {
    var t = String(text || "").trim();
    if (!t) return ["empty"];
    var out = [];
    if (/[,;:]$/.test(t)) out.push("truncated");            // trailing comma etc.
    if (/[("'\[‘“]$/.test(t)) out.push("truncated"); // opened, never closed
    // A dangling function word is only evidence of truncation when the
    // sentence is also unterminated. Closing punctuation means the author
    // stopped on purpose.
    if (!/[.!?…]["”’)\]]?$/.test(t)) {
      var m = t.toLowerCase().match(/[a-z']+(?=[^a-z']*$)/);
      if (m && DANGLING[m[0]]) out.push("truncated");
    }
    return out;
  }

  /* ============================================================
     Citation stripping — applied to what is LEARNED FROM, never to what
     is shown.

     Curated examples carry their source in the text: "... per mile
     travelled. (Slovic, Fischhoff & Lichtenstein, 1982)" or "Schacter
     (1999): People vividly recall ...". Those strings are the rarest
     tokens in the corpus and they are perfectly correlated with the bias
     that happens to cite that paper, so indexing them lets a bias be
     recognised by its bibliography. Nothing a user pastes carries a
     bibliography, so that accuracy is not available on the live path.

     Measured on the curated corpus: leaving citations in the indexed text
     reports 51.7% top-1; removing them reports 42.4%. The 9.3-point gap
     was retrieval matching author names to author names. The lower number
     is the one that describes what the product does.

     The citation is still in item.text, and app.js still splits and shows
     it. Only the vector loses it.
     ============================================================ */
  var TRAILING_CITE = /\s*\([^()]*\b(?:1[6-9]|20)\d{2}[a-z]?s?\b[^()]*\)[.\s]*$/;
  var LEADING_CITE =
    /^[A-Z][A-Za-z''’\-]+(?:\s*(?:&|and|,)\s*(?:[A-Z][A-Za-z''’\-]+|colleagues))*\s*(?:et al\.?,?)?\s*\((?:1[6-9]|20)\d{2}[a-z]?s?\b[^()]*\)[^:\n]{0,40}:\s*/;

  function stripCitation(text) {
    var t = String(text || "");
    var prev;
    do { prev = t; t = t.replace(TRAILING_CITE, ""); } while (t !== prev);
    t = t.replace(LEADING_CITE, "");
    // Never hand back nothing: an example that is only a citation keeps it,
    // so it stays findable rather than silently leaving the index.
    return t.trim() || String(text || "").trim();
  }

  window.CVEncoder = {
    tfidf: tfidfEncoder,
    textIssues: textIssues,
    stripCitation: stripCitation,
    // Registry so the UI can name what produced a result, and so a future
    // encoder is added here rather than wired through the app.
    available: function () { return [{ id: "tfidf-uni+bi-v1", make: tfidfEncoder }]; }
  };
})();
