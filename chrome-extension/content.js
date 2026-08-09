(function () {
  "use strict";

  if (window.__biasLensLoaded) return;
  window.__biasLensLoaded = true;

  /* ============================================================
     Bias Lens — the in-page reading layer.

     The page is read, never rewritten in meaning: sentences are located
     inside their real text nodes so a match can be underlined exactly
     where it sits, and a card explains WHY it matched rather than
     announcing a verdict.
     ============================================================ */

  var BLOCK_SELECTOR = "p, li, blockquote, h1, h2, h3, h4, dd, td, figcaption";
  var SKIP_CONTAINER = "script, style, noscript, nav, header, footer, aside, form, " +
    "button, select, textarea, input, code, pre, svg, canvas, iframe, " +
    "[contenteditable='true'], [aria-hidden='true'], .bias-lens-ui";

  var MIN_SENTENCE_CHARS = 45;
  var MIN_SENTENCE_WORDS = 7;
  var MAX_SENTENCE_CHARS = 650;
  var MAX_PASSAGES = 400;

  var MARK_CLASS = "bias-lens-mark";
  var HOST_ID = "bias-lens-ui-root";

  var state = {
    active: false,
    scanning: false,
    marks: [],          // [{ group, nodes: [mark], match }]
    current: -1,
    host: null,
    root: null,
    card: null,
    badge: null
  };

  /* ============================================================
     Reading the page

     Text is collected per block, with every text node's offset into the
     block string recorded. That index is what makes it possible to take
     a sentence the model matched and put the underline back on exactly
     the characters it scored — across <em>, <a> and the rest.
     ============================================================ */
  function isVisible(element) {
    if (!element.isConnected) return false;
    var style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    var rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function blockParts(element) {
    var walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        var parent = node.parentElement;
        if (!parent || parent.closest(SKIP_CONTAINER)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    var parts = [];
    var text = "";
    var node;
    while ((node = walker.nextNode())) {
      parts.push({ node: node, start: text.length, length: node.nodeValue.length });
      text += node.nodeValue;
    }
    return { text: text, parts: parts };
  }

  function collectBlocks() {
    var blocks = [];
    var elements = document.querySelectorAll(BLOCK_SELECTOR);

    for (var i = 0; i < elements.length; i++) {
      var element = elements[i];
      if (element.closest(SKIP_CONTAINER)) continue;
      // Only leaf-ish blocks, so a <li> wrapping a <p> is not read twice.
      if (element.querySelector(BLOCK_SELECTOR)) continue;
      if (!isVisible(element)) continue;

      var collected = blockParts(element);
      if (collected.text.trim().length < MIN_SENTENCE_CHARS) continue;
      blocks.push(collected);
    }
    return blocks;
  }

  function wordCount(text) {
    var clean = text.trim();
    return clean ? clean.split(/\s+/).length : 0;
  }

  /* Sentence spans, each carrying its [start, end) offsets into the block
     string. Splitting on a bare /[.!?]/ cuts "4.2 billion" in half and hands
     the model a fragment starting "2 billion dollars…", so a full stop only
     ends a sentence when whitespace follows it — which leaves abbreviations
     ("Dr. Kahneman", "vol. 3") as the one case needing a guard. */
  var ABBREVIATION = /(?:^|\s)(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|approx|fig|no|vol|dept|inc|ltd|co|al|eds?|pp|ca|cf|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|[a-z])$/i;

  function pushSpan(out, text, from, to) {
    var raw = text.slice(from, to);
    var leading = raw.length - raw.replace(/^\s+/, "").length;
    var trailing = raw.length - raw.replace(/\s+$/, "").length;
    var start = from + leading;
    var end = from + raw.length - trailing;
    if (end <= start) return;

    var slice = text.slice(start, end);
    if (slice.length < MIN_SENTENCE_CHARS) return;
    if (slice.length > MAX_SENTENCE_CHARS) return;
    if (wordCount(slice) < MIN_SENTENCE_WORDS) return;
    out.push({ start: start, end: end, text: slice });
  }

  function sentencesWithOffsets(text) {
    var out = [];
    var terminator = /([.!?]+)(?=\s|$)|\n+/g;
    var cursor = 0;
    var match;

    while ((match = terminator.exec(text)) !== null) {
      if (match[1] && ABBREVIATION.test(text.slice(cursor, match.index))) continue;
      var end = match.index + match[0].length;
      pushSpan(out, text, cursor, end);
      cursor = end;
    }
    pushSpan(out, text, cursor, text.length);
    return out;
  }

  function gatherPassages() {
    var blocks = collectBlocks();
    var passages = [];
    var index = [];

    for (var b = 0; b < blocks.length && passages.length < MAX_PASSAGES; b++) {
      var block = blocks[b];
      var sentences = sentencesWithOffsets(block.text);

      for (var s = 0; s < sentences.length && passages.length < MAX_PASSAGES; s++) {
        var id = "bl-" + b + "-" + s;
        passages.push({ id: id, text: sentences[s].text });
        index.push({ id: id, block: block, start: sentences[s].start, end: sentences[s].end });
      }
    }
    return { passages: passages, index: index };
  }

  /* ============================================================
     Painting the highlight

     A sentence can straddle several text nodes. Each overlapping node
     contributes one <mark>; they share a group id so the whole sentence
     lights up together and opens one card.
     ============================================================ */
  function piecesFor(entry) {
    var pieces = [];
    entry.block.parts.forEach(function (part) {
      var from = Math.max(entry.start, part.start);
      var to = Math.min(entry.end, part.start + part.length);
      if (to > from && part.node.isConnected) {
        pieces.push({ node: part.node, start: from - part.start, end: to - part.start });
      }
    });
    return pieces;
  }

  function tierOf(confidence) {
    if (confidence >= 0.62) return "high";
    if (confidence >= 0.45) return "medium";
    return "low";
  }

  function paint(entry, match, group) {
    var pieces = piecesFor(entry);
    if (!pieces.length) return null;

    // Descending, so splitting a node never invalidates an earlier offset:
    // splitText leaves the head node holding [0, start) at the same offsets.
    pieces.sort(function (a, b) { return b.start - a.start; });

    var created = [];
    pieces.forEach(function (piece) {
      var node = piece.node;
      if (!node.isConnected || piece.end > node.nodeValue.length) return;

      if (piece.end < node.nodeValue.length) node.splitText(piece.end);
      var target = piece.start > 0 ? node.splitText(piece.start) : node;
      if (!target.parentNode) return;

      var mark = document.createElement("mark");
      mark.className = MARK_CLASS + " " + MARK_CLASS + "--" + tierOf(match.confidence);
      mark.setAttribute("data-bias-lens-group", String(group));
      mark.setAttribute("role", "button");
      mark.setAttribute("tabindex", "0");
      mark.setAttribute("aria-label",
        "Possible " + match.name + " pattern. Open explanation.");
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
      created.push(mark);
    });

    return created.length ? created : null;
  }

  function clearHighlights() {
    state.marks.forEach(function (record) {
      record.nodes.forEach(function (mark) {
        var parent = mark.parentNode;
        if (!parent) return;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
        parent.normalize();
      });
    });
    state.marks = [];
    state.current = -1;
  }

  /* ============================================================
     UI — a shadow root, so no page stylesheet can reach the card and
     the card cannot leak styles back into the article.
     ============================================================ */
  function escapeHTML(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function ensureHost() {
    if (state.host && state.host.isConnected) return;

    state.host = document.createElement("div");
    state.host.id = HOST_ID;
    state.host.className = "bias-lens-ui";
    state.root = state.host.attachShadow({ mode: "open" });
    state.root.innerHTML = SHADOW_MARKUP;
    document.documentElement.appendChild(state.host);

    state.card = state.root.getElementById("card");
    state.badge = state.root.getElementById("badge");

    state.root.getElementById("cardClose").addEventListener("click", hideCard);
    state.root.getElementById("badgeClose").addEventListener("click", function () { deactivate(); });
    state.root.getElementById("prev").addEventListener("click", function () { step(-1); });
    state.root.getElementById("next").addEventListener("click", function () { step(1); });
    state.root.getElementById("openPanel").addEventListener("click", function () {
      chrome.runtime.sendMessage({ type: "BIAS_LENS_OPEN_PANEL" });
    });
  }

  var SHADOW_MARKUP = [
    "<style>",
    ":host, * { box-sizing: border-box; }",
    "#badge, #card {",
    "  position: fixed; z-index: 2147483647;",
    "  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;",
    "  color: #10151f; background: #fff;",
    "  border: 1px solid rgba(16,21,31,.14);",
    "  border-radius: 14px;",
    "  box-shadow: 0 18px 48px rgba(16,21,31,.20), 0 2px 6px rgba(16,21,31,.08);",
    "}",
    "#badge {",
    "  right: 20px; bottom: 20px; display: none;",
    "  align-items: center; gap: 10px; padding: 9px 10px 9px 14px;",
    "  font-size: 13px; line-height: 1.3;",
    "}",
    "#badge.show { display: flex; }",
    "#badgeText { font-weight: 600; white-space: nowrap; }",
    "#badgeText small { display: block; font-weight: 400; opacity: .62; font-size: 11px; }",
    ".nav { display: flex; gap: 4px; }",
    "button {",
    "  font: inherit; cursor: pointer; color: inherit;",
    "  background: rgba(16,21,31,.05); border: 0; border-radius: 8px;",
    "  padding: 5px 9px; line-height: 1;",
    "}",
    "button:hover { background: rgba(16,21,31,.11); }",
    "button:focus-visible { outline: 2px solid #3b6cf0; outline-offset: 2px; }",
    "#card {",
    "  display: none; width: 360px; max-width: calc(100vw - 32px);",
    "  padding: 16px 18px 15px; font-size: 13.5px; line-height: 1.5;",
    "}",
    "#card.show { display: block; }",
    ".head { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; }",
    ".name { font-size: 15.5px; font-weight: 650; letter-spacing: -.01em; flex: 1; }",
    ".quad { display: block; font-size: 11px; font-weight: 500; text-transform: uppercase;",
    "  letter-spacing: .06em; opacity: .5; margin-top: 3px; }",
    ".score { font-size: 12px; font-weight: 650; padding: 3px 8px; border-radius: 999px;",
    "  background: #fdeceb; color: #a3231b; white-space: nowrap; }",
    ".score.medium { background: #fdf3e2; color: #93610d; }",
    ".score.low { background: #eef0f4; color: #4a5364; }",
    "#cardClose { padding: 4px 7px; font-size: 15px; opacity: .55; }",
    "p { margin: 0 0 10px; }",
    ".label { font-size: 11px; font-weight: 650; text-transform: uppercase;",
    "  letter-spacing: .06em; opacity: .5; margin: 0 0 3px; }",
    "blockquote { margin: 0 0 10px; padding: 9px 12px; border-left: 3px solid rgba(59,108,240,.45);",
    "  background: rgba(59,108,240,.06); border-radius: 0 8px 8px 0; font-size: 13px; }",
    ".note { font-size: 11.5px; line-height: 1.45; opacity: .62; margin: 0; }",
    ".foot { display: flex; align-items: center; gap: 8px; margin-top: 12px;",
    "  padding-top: 11px; border-top: 1px solid rgba(16,21,31,.09); }",
    ".foot .spacer { flex: 1; }",
    ".counter { font-size: 11.5px; opacity: .55; }",
    "@media (prefers-color-scheme: dark) {",
    "  #badge, #card { background: #171c26; color: #eef1f6; border-color: rgba(255,255,255,.13); }",
    "  button { background: rgba(255,255,255,.09); }",
    "  button:hover { background: rgba(255,255,255,.16); }",
    "  .score { background: rgba(255,120,110,.17); color: #ffb3ac; }",
    "  .score.medium { background: rgba(255,190,80,.15); color: #ffd48a; }",
    "  .score.low { background: rgba(255,255,255,.09); color: #c3cad6; }",
    "  blockquote { background: rgba(120,155,255,.10); border-left-color: rgba(120,155,255,.5); }",
    "  .foot { border-top-color: rgba(255,255,255,.11); }",
    "}",
    "</style>",
    "<div id='badge'>",
    "  <span id='badgeText'></span>",
    "  <span class='nav'>",
    "    <button id='prev' title='Previous passage'>&#8593;</button>",
    "    <button id='next' title='Next passage'>&#8595;</button>",
    "    <button id='badgeClose' title='Turn off Bias Lens'>&#10005;</button>",
    "  </span>",
    "</div>",
    "<div id='card' role='dialog' aria-label='Bias explanation'>",
    "  <div class='head'>",
    "    <span class='name' id='cardName'></span>",
    "    <span class='score' id='cardScore'></span>",
    "    <button id='cardClose' title='Close'>&#10005;</button>",
    "  </div>",
    "  <div id='cardBody'></div>",
    "  <div class='foot'>",
    "    <span class='counter' id='cardCounter'></span>",
    "    <span class='spacer'></span>",
    "    <button id='openPanel'>Full report</button>",
    "  </div>",
    "</div>"
  ].join("\n");

  function setBadge(title, detail) {
    ensureHost();
    state.root.getElementById("badgeText").innerHTML =
      escapeHTML(title) + (detail ? "<small>" + escapeHTML(detail) + "</small>" : "");
    state.badge.classList.add("show");
  }

  function hideCard() {
    if (!state.card) return;
    state.card.classList.remove("show");
    state.marks.forEach(function (record) {
      record.nodes.forEach(function (mark) { mark.removeAttribute("data-bias-lens-active"); });
    });
  }

  function positionCard(anchor) {
    var rect = anchor.getBoundingClientRect();
    var card = state.card;
    var width = card.offsetWidth;
    var height = card.offsetHeight;
    var margin = 12;

    var left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

    var below = rect.bottom + 10;
    var top = below + height + margin <= window.innerHeight
      ? below
      : Math.max(margin, rect.top - height - 10);

    card.style.left = Math.round(left) + "px";
    card.style.top = Math.round(top) + "px";
  }

  function showCard(recordIndex) {
    var record = state.marks[recordIndex];
    if (!record) return;

    ensureHost();
    state.current = recordIndex;
    var match = record.match;

    state.root.getElementById("cardName").innerHTML =
      escapeHTML(match.name) +
      (match.quadrant ? "<span class='quad'>" + escapeHTML(match.quadrant) + "</span>" : "");

    var score = state.root.getElementById("cardScore");
    score.textContent = Math.round(match.confidence * 100) + "%";
    score.className = "score " + tierOf(match.confidence);

    var body = "";
    if (match.definition) {
      body += "<p class='label'>What this pattern is</p><p>" + escapeHTML(match.definition) + "</p>";
    }
    if (match.evidence) {
      body += "<p class='label'>Closest example in the training set</p>" +
        "<blockquote>" + escapeHTML(match.evidence) + "</blockquote>";
    }
    body += "<p class='note'>" + escapeHTML(match.reason) +
      " Based on " + match.support + " supporting example" + (match.support === 1 ? "" : "s") +
      ". This measures resemblance to curated examples — it is not proof the claim is false " +
      "or that the author reasoned badly.</p>";
    state.root.getElementById("cardBody").innerHTML = body;

    state.root.getElementById("cardCounter").textContent =
      (recordIndex + 1) + " of " + state.marks.length;

    state.marks.forEach(function (item) {
      item.nodes.forEach(function (mark) { mark.removeAttribute("data-bias-lens-active"); });
    });
    record.nodes.forEach(function (mark) { mark.setAttribute("data-bias-lens-active", "true"); });

    state.card.classList.add("show");
    positionCard(record.nodes[0]);
  }

  function step(direction) {
    if (!state.marks.length) return;
    var next = state.current + direction;
    if (next < 0) next = state.marks.length - 1;
    if (next >= state.marks.length) next = 0;

    var record = state.marks[next];
    record.nodes[0].scrollIntoView({ behavior: "smooth", block: "center" });
    // Let the smooth scroll settle before anchoring the card to it.
    window.setTimeout(function () { showCard(next); }, 320);
  }

  /* ============================================================
     Scan / activate
     ============================================================ */
  function sendScan(passages) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage({ type: "BIAS_LENS_SCAN", passages: passages }, function (response) {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: "The background model did not answer." });
      });
    });
  }

  async function activate() {
    if (state.scanning) return;
    state.scanning = true;
    state.active = true;

    ensureHost();
    setBadge("Bias Lens", "Reading this page…");
    clearHighlights();
    hideCard();

    try {
      var gathered = gatherPassages();
      if (!gathered.passages.length) {
        setBadge("Bias Lens", "No readable article text found here.");
        return;
      }

      setBadge("Bias Lens", "Checking " + gathered.passages.length + " passages…");
      var response = await sendScan(gathered.passages);

      if (!response.ok) {
        setBadge("Bias Lens unavailable", response.error || "The model could not be prepared.");
        return;
      }

      var byId = Object.create(null);
      response.matches.forEach(function (match) { byId[match.id] = match; });

      gathered.index.forEach(function (entry) {
        var match = byId[entry.id];
        if (!match) return;
        var nodes = paint(entry, match, state.marks.length);
        if (nodes) state.marks.push({ group: state.marks.length, nodes: nodes, match: match });
      });

      if (!state.marks.length) {
        setBadge("Nothing flagged",
          gathered.passages.length + " passages checked · no supported match");
      } else {
        setBadge(
          state.marks.length + (state.marks.length === 1 ? " passage" : " passages") + " to re-read",
          "of " + gathered.passages.length + " checked · click a highlight"
        );
      }
    } finally {
      state.scanning = false;
    }
  }

  function deactivate() {
    state.active = false;
    clearHighlights();
    hideCard();
    if (state.badge) state.badge.classList.remove("show");
  }

  function toggle() {
    if (state.active) deactivate();
    else activate();
  }

  /* ============================================================
     Events
     ============================================================ */
  function markAt(target) {
    if (!target || !target.closest) return -1;
    var mark = target.closest("mark." + MARK_CLASS);
    if (!mark) return -1;
    var group = Number(mark.getAttribute("data-bias-lens-group"));
    return Number.isFinite(group) ? group : -1;
  }

  document.addEventListener("click", function (event) {
    var index = markAt(event.target);
    if (index < 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (index === state.current && state.card && state.card.classList.contains("show")) hideCard();
    else showCard(index);
  }, true);

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && state.card && state.card.classList.contains("show")) {
      hideCard();
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    var index = markAt(event.target);
    if (index < 0) return;
    event.preventDefault();
    showCard(index);
  }, true);

  window.addEventListener("scroll", function () {
    if (!state.card || !state.card.classList.contains("show")) return;
    var record = state.marks[state.current];
    if (record) positionCard(record.nodes[0]);
  }, { passive: true });

  window.addEventListener("resize", function () {
    if (!state.card || !state.card.classList.contains("show")) return;
    var record = state.marks[state.current];
    if (record) positionCard(record.nodes[0]);
  });

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (!message || message.type !== "BIAS_LENS_TOGGLE") return;
    toggle();
    sendResponse({ ok: true, active: state.active });
  });

  // Opt-in auto-scan, off by default: an extension that rewrites every page
  // you open without being asked is not a reading aid.
  chrome.storage.sync.get({ biasLensAutoScan: false }, function (settings) {
    if (settings && settings.biasLensAutoScan) window.setTimeout(activate, 600);
  });
})();
