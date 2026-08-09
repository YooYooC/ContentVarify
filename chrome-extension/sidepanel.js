(function () {
  "use strict";

  var MAX_ARTICLE_CHARS = 30000;
  var MAX_SEGMENTS = 90;
  var MAX_RESULTS = 12;

  var input = document.getElementById("passageInput");
  var analyzeButton = document.getElementById("analyzeButton");
  var selectionButton = document.getElementById("selectionButton");
  var articleButton = document.getElementById("articleButton");
  var clearButton = document.getElementById("clearButton");
  var wordCount = document.getElementById("wordCount");
  var sourceMeta = document.getElementById("sourceMeta");
  var sourceTitle = document.getElementById("sourceTitle");
  var sourceLink = document.getElementById("sourceLink");
  var modelState = document.getElementById("modelState");
  var emptyState = document.getElementById("emptyState");
  var resultsSection = document.getElementById("resultsSection");
  var resultCount = document.getElementById("resultCount");
  var summary = document.getElementById("summary");
  var resultList = document.getElementById("resultList");
  var aboutButton = document.getElementById("aboutButton");
  var aboutDialog = document.getElementById("aboutDialog");

  var retrieval = null;
  var classifier = null;
  var biasByKey = Object.create(null);
  var ready = false;
  var analyzing = false;

  function slug(text) {
    return String(text || "").trim().toLowerCase();
  }

  function flattenDataset() {
    var retrievalDocs = [];
    var trainingDocs = [];
    var serial = 0;
    var quadrants = (window.BIAS_DATA && window.BIAS_DATA.quadrants) || [];

    quadrants.forEach(function (quadrant) {
      (quadrant.categories || []).forEach(function (category) {
        (category.biases || []).forEach(function (bias) {
          var key = slug(bias.name);
          if (!biasByKey[key]) {
            biasByKey[key] = {
              name: bias.name,
              definition: bias.definition || "",
              quadrant: quadrant.name,
              category: category.name
            };
          }

          function add(items, label) {
            (items || []).forEach(function (item) {
              var id = "ext-" + serial++;
              var text = String(item && item.text || "").trim();
              if (!text) return;
              retrievalDocs.push({
                id: id,
                text: text,
                label: label,
                biasKey: key,
                biasName: bias.name,
                quad: quadrant.name,
                cat: category.name
              });
              trainingDocs.push({ id: id, text: text, label: label });
            });
          }

          add(bias.positive, 1);
          add(bias.negative, 0);
        });
      });
    });

    return { retrieval: retrievalDocs, training: trainingDocs };
  }

  function setModelState(kind, title, detail) {
    modelState.className = "model-state " + kind;
    modelState.innerHTML = '<span class="spinner" aria-hidden="true"></span>' +
      "<div><strong>" + escapeHTML(title) + "</strong><small>" + escapeHTML(detail) + "</small></div>";
  }

  function initializeModel() {
    try {
      if (!window.BIAS_DATA || !window.CVEncoder || !window.CVRetrieval || !window.CVModel) {
        throw new Error("One or more model files did not load.");
      }
      var docs = flattenDataset();
      retrieval = window.CVRetrieval.build(docs.retrieval, window.CVEncoder.tfidf());
      classifier = window.CVModel.train(docs.training);
      if (!retrieval.ready || !classifier.ready) {
        throw new Error(retrieval.reason || classifier.reason || "The model could not be prepared.");
      }
      ready = true;
      var accuracy = Math.round(classifier.metrics.accuracy * 100);
      setModelState(
        "ready",
        "Model ready",
        retrieval.stats.biases + " biases · " + retrieval.size.toLocaleString() + " examples · " + accuracy + "% held-out binary accuracy"
      );
      document.getElementById("factBiases").textContent = retrieval.stats.biases;
      document.getElementById("factExamples").textContent = retrieval.size.toLocaleString();
      document.getElementById("factAccuracy").textContent = accuracy + "%";
      updateControls();
    } catch (error) {
      ready = false;
      setModelState("error", "Model unavailable", error && error.message ? error.message : "Unknown setup error");
    }
  }

  function escapeHTML(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function words(text) {
    var clean = String(text || "").trim();
    return clean ? clean.split(/\s+/).length : 0;
  }

  function updateControls() {
    var count = words(input.value);
    wordCount.textContent = count.toLocaleString() + (count === 1 ? " word" : " words");
    analyzeButton.disabled = !ready || analyzing || !input.value.trim();
  }

  function setSource(meta) {
    if (!meta || (!meta.title && !meta.url)) {
      sourceMeta.hidden = true;
      return;
    }
    sourceTitle.textContent = meta.title || "Current page";
    if (meta.url) {
      sourceLink.href = meta.url;
      sourceLink.hidden = false;
    } else {
      sourceLink.hidden = true;
    }
    sourceMeta.hidden = false;
  }

  async function activeTab() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }

  function extractFromPage(mode) {
    var maxArticleChars = 30000;
    var title = document.title || "Current page";
    var url = location.href;
    var selected = String(window.getSelection ? window.getSelection().toString() : "").trim();
    if (mode === "selection") return { text: selected, title: title, url: url };

    function visible(element) {
      var style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    }

    var candidates = Array.prototype.slice.call(document.querySelectorAll("article, main, [role='main']"));
    candidates = candidates.filter(visible);
    candidates.sort(function (a, b) { return (b.innerText || "").length - (a.innerText || "").length; });
    var root = candidates[0] || document.body;
    var clone = root.cloneNode(true);
    var discard = "script, style, noscript, nav, header, footer, aside, form, button, svg, canvas, iframe, .advertisement, .ad, [aria-hidden='true']";
    Array.prototype.forEach.call(clone.querySelectorAll(discard), function (node) { node.remove(); });

    var blocks = Array.prototype.slice.call(clone.querySelectorAll("h1, h2, h3, p, blockquote, li"));
    var pieces = blocks.map(function (node) {
      return String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
    }).filter(function (text) { return text.length >= 30; });

    var text = pieces.join("\n\n");
    if (text.length < 200) text = String(clone.innerText || clone.textContent || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return { text: text.slice(0, maxArticleChars), title: title, url: url };
  }

  async function readPage(mode) {
    try {
      var tab = await activeTab();
      if (!tab || tab.id == null) throw new Error("No active page is available.");
      var output = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractFromPage,
        args: [mode]
      });
      var data = output && output[0] && output[0].result;
      if (!data || !String(data.text || "").trim()) {
        throw new Error(mode === "selection" ? "Highlight some text on the page first." : "I could not find readable article text on this page.");
      }
      input.value = String(data.text).slice(0, MAX_ARTICLE_CHARS);
      setSource(data);
      updateControls();
      input.focus();
      if (mode === "selection") analyze();
    } catch (error) {
      setModelState("error", "Could not read this page", error && error.message ? error.message : "Chrome blocks access to this page.");
      window.setTimeout(function () {
        if (ready) {
          var accuracy = Math.round(classifier.metrics.accuracy * 100);
          setModelState("ready", "Model ready", retrieval.stats.biases + " biases · " + retrieval.size.toLocaleString() + " examples · " + accuracy + "% held-out binary accuracy");
        }
      }, 3200);
    }
  }

  function segmentText(text) {
    var segments = [];
    var regex = /[^.!?\n]+(?:[.!?]+|\n|$)/g;
    var match;
    while ((match = regex.exec(text)) !== null && segments.length < MAX_SEGMENTS) {
      var raw = match[0];
      var clean = raw.replace(/\s+/g, " ").trim();
      if (clean.length < 20 || words(clean) < 4) continue;
      if (clean.length > 650) {
        clean.split(/;|—|:\s/).forEach(function (part) {
          part = part.trim();
          if (part.length >= 20 && segments.length < MAX_SEGMENTS) segments.push(part);
        });
      } else {
        segments.push(clean);
      }
    }
    if (!segments.length && text.trim()) segments.push(text.trim().slice(0, 650));
    return segments;
  }

  function analyzeSegment(text, index) {
    var retrieved = retrieval.query(text);
    var allowed = retrieved.status === "ok" || retrieved.status === "weak" || retrieved.status === "thin";
    if (!allowed || !retrieved.candidates.length) return null;

    var top = retrieved.candidates[0];
    var assessed = classifier.assess(text);
    if (assessed.label === 0 && assessed.confidence != null && assessed.confidence >= 0.60) return null;

    var binaryProbability = assessed.p == null ? 0.5 : assessed.p;
    var combined = top.confidence * 0.78 + binaryProbability * 0.22;
    if (retrieved.status === "thin") combined *= 0.82;
    if (retrieved.status === "weak") combined *= 0.9;
    combined = Math.max(0, Math.min(0.95, combined));

    var positive = null;
    for (var i = 0; i < top.neighbours.length; i++) {
      if (top.neighbours[i].label === 1) { positive = top.neighbours[i]; break; }
    }
    var meta = biasByKey[top.key] || {};
    return {
      id: "result-" + index,
      text: text,
      name: top.name,
      key: top.key,
      definition: meta.definition || "",
      category: top.cat || meta.category || "",
      confidence: combined,
      status: retrieved.status,
      reason: retrieved.reason,
      evidence: positive ? positive.text : "",
      similarity: positive ? positive.similarity : 0,
      support: top.support
    };
  }

  function confidenceClass(score) {
    if (score >= 0.62) return "";
    if (score >= 0.42) return "medium";
    return "low";
  }

  function renderResults(matches, segmentCount) {
    emptyState.hidden = true;
    resultsSection.hidden = false;
    resultList.innerHTML = "";
    resultCount.textContent = matches.length + (matches.length === 1 ? " match" : " matches");

    if (!matches.length) {
      summary.textContent = "No supported bias match was found in " + segmentCount + " passage" + (segmentCount === 1 ? "" : "s") + ". That does not prove the text is unbiased; it means this model lacks enough matching evidence to make a call.";
      resultList.innerHTML = '<div class="no-matches"><strong>No clear pattern found</strong><p>Try a shorter claim or select the most argumentative part of the article.</p></div>';
      return;
    }

    summary.textContent = "The model found " + matches.length + " passage" + (matches.length === 1 ? "" : "s") + " worth a closer look. Scores measure resemblance to the training examples—not whether the author is wrong or acting intentionally.";

    matches.forEach(function (match, rank) {
      var card = document.createElement("details");
      card.className = "result-card";
      if (rank === 0) card.open = true;
      var pct = Math.round(match.confidence * 100);
      var evidence = match.evidence ? '<p class="evidence-label">Closest supporting example</p><blockquote class="evidence-quote">“' + escapeHTML(match.evidence) + '”</blockquote>' : "";
      card.innerHTML =
        "<summary>" +
          '<div class="result-topline"><span class="rank">' + String(rank + 1).padStart(2, "0") + '</span><span class="bias-name">' + escapeHTML(match.name) + '</span><span class="confidence ' + confidenceClass(match.confidence) + '">' + pct + "%</span></div>" +
          '<p class="snippet">“' + escapeHTML(match.text) + '”</p>' +
        "</summary>" +
        '<div class="card-body">' +
          (match.definition ? '<p class="definition"><strong>What it means:</strong> ' + escapeHTML(match.definition) + "</p>" : "") +
          evidence +
          '<p class="card-note">' + escapeHTML(match.reason) + " Based on " + match.support + " supporting examples in this bias category.</p>" +
        "</div>";
      resultList.appendChild(card);
    });
  }

  function analyze() {
    if (!ready || analyzing || !input.value.trim()) return;
    analyzing = true;
    updateControls();
    analyzeButton.querySelector("span:last-child").textContent = "Analyzing…";

    window.setTimeout(function () {
      try {
        var segments = segmentText(input.value);
        var matches = [];
        segments.forEach(function (segment, index) {
          var found = analyzeSegment(segment, index);
          if (found) matches.push(found);
        });
        matches.sort(function (a, b) { return b.confidence - a.confidence; });
        renderResults(matches.slice(0, MAX_RESULTS), segments.length);
        resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
      } finally {
        analyzing = false;
        analyzeButton.querySelector("span:last-child").textContent = "Analyze text";
        updateControls();
      }
    }, 25);
  }

  async function loadPendingSelection() {
    try {
      var stored = await chrome.storage.session.get("biasLensPendingSelection");
      var pending = stored.biasLensPendingSelection;
      if (!pending || !pending.text || Date.now() - pending.createdAt > 120000) return;
      input.value = pending.text.slice(0, MAX_ARTICLE_CHARS);
      setSource(pending);
      await chrome.storage.session.remove("biasLensPendingSelection");
      updateControls();
      var waitUntilReady = window.setInterval(function () {
        if (!ready) return;
        window.clearInterval(waitUntilReady);
        analyze();
      }, 100);
    } catch (_) {}
  }

  input.addEventListener("input", updateControls);
  analyzeButton.addEventListener("click", analyze);
  selectionButton.addEventListener("click", function () { readPage("selection"); });
  articleButton.addEventListener("click", function () { readPage("article"); });
  clearButton.addEventListener("click", function () {
    input.value = "";
    sourceMeta.hidden = true;
    resultsSection.hidden = true;
    emptyState.hidden = false;
    updateControls();
    input.focus();
  });
  aboutButton.addEventListener("click", function () { aboutDialog.showModal(); });
  input.addEventListener("keydown", function (event) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") analyze();
  });

  loadPendingSelection();
  updateControls();
  window.setTimeout(initializeModel, 40);
})();
