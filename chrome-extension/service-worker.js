"use strict";

/* ============================================================
   Bias Lens — background engine.

   The corpus (2,493 curated examples), the TF-IDF retrieval index and
   the logistic-regression classifier all live HERE, in the one worker,
   rather than in each tab. Building them costs ~600ms; doing that per
   tab would make every page load pay for it again.

   The model files export onto `window`, which a service worker does not
   have. Aliasing `window` to the worker global is the whole shim — the
   model code touches no DOM beyond that one assignment.
   ============================================================ */
self.window = self;
importScripts(
  "/data/biases.js",
  "/encoder.js",
  "/retrieval.js",
  "/model.js"
);

const MENU_SELECTION = "bias-lens-analyze-selection";
const MENU_PAGE = "bias-lens-scan-page";

/* Highlighting is deliberately stricter than the side panel's list view.
   A list of maybes is useful; sixty yellow marks over an article is not.
   Anything below these bars is dropped rather than shown faintly. */
const MIN_CONFIDENCE = 0.34;
const MAX_HIGHLIGHTS = 60;
const ACCEPTED_STATUS = { ok: 1, weak: 1, thin: 1 };

/* ============================================================
   Lazy, cached model build
   ============================================================ */
let enginePromise = null;

function slug(text) {
  return String(text || "").trim().toLowerCase();
}

function flattenDataset() {
  const retrievalDocs = [];
  const trainingDocs = [];
  const biasByKey = Object.create(null);
  let serial = 0;

  const quadrants = (self.BIAS_DATA && self.BIAS_DATA.quadrants) || [];
  quadrants.forEach((quadrant) => {
    (quadrant.categories || []).forEach((category) => {
      (category.biases || []).forEach((bias) => {
        const key = slug(bias.name);
        if (!biasByKey[key]) {
          biasByKey[key] = {
            name: bias.name,
            definition: bias.definition || "",
            quadrant: quadrant.name,
            category: category.name
          };
        }

        const add = (items, label) => {
          (items || []).forEach((item) => {
            const text = String((item && item.text) || "").trim();
            if (!text) return;
            const id = "bg-" + serial++;
            retrievalDocs.push({
              id, text, label,
              biasKey: key,
              biasName: bias.name,
              quad: quadrant.name,
              cat: category.name
            });
            trainingDocs.push({ id, text, label });
          });
        };

        add(bias.positive, 1);
        add(bias.negative, 0);
      });
    });
  });

  return { retrieval: retrievalDocs, training: trainingDocs, biasByKey };
}

function buildEngine() {
  if (!self.BIAS_DATA || !self.CVEncoder || !self.CVRetrieval || !self.CVModel) {
    throw new Error("The model files did not load.");
  }

  const docs = flattenDataset();
  const retrieval = self.CVRetrieval.build(docs.retrieval, self.CVEncoder.tfidf());
  const classifier = self.CVModel.train(docs.training);

  if (!retrieval.ready) throw new Error(retrieval.reason || "The retrieval index could not be built.");
  if (!classifier.ready) throw new Error(classifier.reason || "The classifier could not be trained.");

  return { retrieval, classifier, biasByKey: docs.biasByKey };
}

function engine() {
  if (!enginePromise) {
    enginePromise = (async () => buildEngine())().catch((error) => {
      enginePromise = null;   // let the next request try again
      throw error;
    });
  }
  return enginePromise;
}

/* ============================================================
   Scoring one passage.

   Two independent signals have to agree before a passage is marked:

     retrieval   which bias the nearest curated examples point to, and
                 how often that pointer has been right at this similarity
     classifier  whether the passage reads like the bias in action at all,
                 as opposed to a clear-thinking counter-example

   The classifier is used mainly as a veto. When it is confident the text
   is a counter-example, no highlight appears however close the nearest
   neighbour looked.
   ============================================================ */
function assessPassage(model, text) {
  const retrieved = model.retrieval.query(text);
  if (!ACCEPTED_STATUS[retrieved.status] || !retrieved.candidates.length) return null;

  const top = retrieved.candidates[0];
  const assessed = model.classifier.assess(text);

  // Confident counter-example -> not a highlight.
  if (assessed.label === 0 && assessed.confidence != null && assessed.confidence >= 0.60) return null;

  const binaryProbability = assessed.p == null ? 0.5 : assessed.p;
  let combined = top.confidence * 0.78 + binaryProbability * 0.22;
  if (retrieved.status === "thin") combined *= 0.82;
  if (retrieved.status === "weak") combined *= 0.9;
  combined = Math.max(0, Math.min(0.95, combined));
  if (combined < MIN_CONFIDENCE) return null;

  let positive = null;
  for (let i = 0; i < top.neighbours.length; i++) {
    if (top.neighbours[i].label === 1) { positive = top.neighbours[i]; break; }
  }

  const meta = model.biasByKey[top.key] || {};
  return {
    name: top.name,
    key: top.key,
    definition: meta.definition || "",
    quadrant: top.quad || meta.quadrant || "",
    category: top.cat || meta.category || "",
    confidence: combined,
    status: retrieved.status,
    reason: retrieved.reason,
    evidence: positive ? positive.text : "",
    similarity: positive ? positive.similarity : 0,
    support: top.support
  };
}

async function scanPassages(passages) {
  const model = await engine();
  const matches = [];

  (passages || []).forEach((passage) => {
    if (!passage || !passage.text) return;
    const found = assessPassage(model, String(passage.text));
    if (found) {
      found.id = passage.id;
      matches.push(found);
    }
  });

  matches.sort((a, b) => b.confidence - a.confidence);

  return {
    matches: matches.slice(0, MAX_HIGHLIGHTS),
    scanned: (passages || []).length,
    dropped: Math.max(0, matches.length - MAX_HIGHLIGHTS)
  };
}

async function modelStatus() {
  const model = await engine();
  return {
    biases: model.retrieval.stats.biases,
    examples: model.retrieval.size,
    accuracy: model.classifier.metrics.accuracy
  };
}

/* ============================================================
   Wiring
   ============================================================ */
async function configureExtension() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_SELECTION,
      title: "Analyze selected text with Bias Lens",
      contexts: ["selection"]
    });
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: "Highlight bias patterns on this page",
      contexts: ["page"]
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  configureExtension().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

async function toggleHighlights(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "BIAS_LENS_TOGGLE" });
  } catch (_) {
    // No content script on this page (chrome://, the Web Store, a PDF viewer).
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id == null) return;

  if (info.menuItemId === MENU_PAGE) {
    await toggleHighlights(tab.id);
    return;
  }

  if (info.menuItemId !== MENU_SELECTION) return;

  const text = String(info.selectionText || "").trim();
  if (!text) return;

  await chrome.storage.session.set({
    biasLensPendingSelection: {
      text,
      title: tab.title || "Selected text",
      url: tab.url || "",
      createdAt: Date.now()
    }
  });

  await chrome.sidePanel.open({ tabId: tab.id });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-highlights") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) await toggleHighlights(tab.id);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === "BIAS_LENS_SCAN") {
    scanPassages(message.passages)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error && error.message ? error.message : "The model could not be prepared." }));
    return true;
  }

  if (message.type === "BIAS_LENS_STATUS") {
    modelStatus()
      .then((status) => sendResponse({ ok: true, ...status }))
      .catch((error) => sendResponse({ ok: false, error: error && error.message ? error.message : "The model could not be prepared." }));
    return true;
  }

  if (message.type === "BIAS_LENS_OPEN_PANEL") {
    const tabId = _sender && _sender.tab && _sender.tab.id;
    if (tabId != null) chrome.sidePanel.open({ tabId }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
});
