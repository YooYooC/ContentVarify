/* Train model.js on the curated corpus outside the browser and report the
   numbers that model.js hard-codes, so those constants stay measured rather
   than inherited.

   The browser builds its training set in app.js (trainingDocs): every example
   the user has not excluded, positive -> label 1, negative -> label 0. With no
   user exclusions that is exactly the whole corpus, which is what this
   reproduces.

     node scripts/eval_model.js            metrics + threshold sweep
     node scripts/eval_model.js --quick    metrics only
*/
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");

const ROOT = path.dirname(__dirname);
const sandbox = { window: {}, console, Math, Date, Object, Array, JSON };
sandbox.self = sandbox.window;
vm.createContext(sandbox);
// encoder.js first: model.js reads CVEncoder.stripCitation off it, and
// without it loaded the eval would train on citation text the browser drops.
for (const f of ["data/biases.js", "encoder.js", "model.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
}

const BIAS_DATA = sandbox.window.BIAS_DATA;
const CVModel = sandbox.window.CVModel;

/* Same flattening app.js does. */
const docs = [];
BIAS_DATA.quadrants.forEach((q, qi) =>
  q.categories.forEach((c, ci) =>
    c.biases.forEach((b, bi) => {
      (b.positive || []).forEach((it, k) =>
        docs.push({ id: `${qi}.${ci}.${bi}:p${k}`, text: it.text, label: 1 }));
      (b.negative || []).forEach((it, k) =>
        docs.push({ id: `${qi}.${ci}.${bi}:n${k}`, text: it.text, label: 0 }));
    })));

console.log(`corpus: ${docs.length} docs  (${docs.filter(d => d.label === 1).length} positive, ` +
            `${docs.filter(d => d.label === 0).length} negative)`);

const t0 = Date.now();
const M = CVModel.train(docs);
console.log(`trained in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
if (!M.ready) { console.log("NOT READY:", M.reason); process.exit(1); }

const m = M.metrics;
const pc = x => (x * 100).toFixed(1) + "%";
console.log("--- held-out (cross-validated, calibrated) ---");
console.log(`  docs ${m.docs}   features ${m.features}   folds ${m.folds}`);
console.log(`  accuracy ${pc(m.accuracy)}   balanced ${pc(m.balanced)}   F1 ${pc(m.f1)}`);
console.log(`  precision ${pc(m.precision)}   recall ${pc(m.recall)}   specificity ${pc(m.specificity)}`);
console.log(`  AUC ${m.auc.toFixed(4)}   logloss ${m.logLoss.toFixed(4)}   brier ${m.brier.toFixed(4)}`);
console.log(`  ECE ${pc(m.ece)}  (before calibration ${pc(m.eceRaw)})`);
console.log(`  Platt A=${m.platt.A.toFixed(3)} B=${m.platt.B.toFixed(3)}`);
console.log("\n--- accuracy by evidence (content-word buckets) ---");
m.evidenceBuckets.forEach((b, i) => {
  const lab = b.upTo === null ? "8+" : `<${b.upTo}`;
  console.log(`  ${lab.padStart(3)}  n=${String(b.n).padStart(5)}  ` +
              `acc ${b.accuracy === null ? "  -  " : pc(b.accuracy).padStart(6)}  ` +
              `cap ${pc(b.cap)}`);
});

console.log("\n--- what the model learned (top weighted terms) ---");
console.log("  bias in action :", M.topFeatures.positive.slice(0, 8).map(f => f[0]).join(", "));
console.log("  clear thinking :", M.topFeatures.negative.slice(0, 8).map(f => f[0]).join(", "));

if (process.argv.includes("--quick")) process.exit(0);

/* ------------------------------------------------------------------
   Threshold sweep. assess() refuses to score a text with too few known
   features, or where one feature carries too much of the decision. The
   published trade-off table has to be re-measured whenever the corpus
   changes, because both the vocabulary and the accuracy move.

   Correctness has to come from the cross-validated prediction (M.oof), not
   from assess(): assess() scores with the model refitted on all the data,
   which has already seen these examples and gets ~100% on them. Only the
   evidence counts are read off assess(), and those depend on the vocabulary
   and weights rather than on the label.
   ------------------------------------------------------------------ */
const scored = docs
  .map(d => ({ y: d.label, p: M.oof[d.id], e: M.assess(d.text).evidence }))
  .filter(r => r.e && r.p !== undefined);
console.log(`\n(gate measured on ${scored.length} out-of-fold predictions)`);

function sweep(minKnown, maxConc) {
  let kept = 0, hit = 0;
  for (const r of scored) {
    if (r.e.known < minKnown || r.e.concentration > maxConc) continue;
    kept++;
    if ((r.p >= 0.5 ? 1 : 0) === r.y) hit++;
  }
  return { coverage: kept / scored.length, accuracy: kept ? hit / kept : 0, kept };
}

console.log("\n--- evidence gate: coverage vs accuracy on what is kept ---");
console.log("  known  conc    coverage   accuracy   n");
const base = sweep(0, 1.01);
console.log(`   none  none     ${pc(base.coverage).padStart(6)}     ${pc(base.accuracy).padStart(6)}   ${base.kept}`);
for (const [k, c] of [[3, 0.80], [4, 0.70], [5, 0.60], [6, 0.55], [7, 0.50], [8, 0.45]]) {
  const s = sweep(k, c);
  console.log(`   >=${k}   <=${c.toFixed(2)}   ${pc(s.coverage).padStart(6)}     ${pc(s.accuracy).padStart(6)}   ${s.kept}`);
}

/* The population the chosen gate refuses: how accurate the model actually is
   there, against how confident it would have sounded had it answered. That
   gap is the reason the gate exists. */
function refusedStats(minKnown, maxConc) {
  let n = 0, hit = 0, conf = 0;
  for (const r of scored) {
    if (r.e.known >= minKnown && r.e.concentration <= maxConc) continue;
    n++;
    if ((r.p >= 0.5 ? 1 : 0) === r.y) hit++;
    conf += Math.max(r.p, 1 - r.p);
  }
  return { n, accuracy: n ? hit / n : 0, confidence: n ? conf / n : 0, share: n / scored.length };
}
for (const [k, c] of [[5, 0.60], [6, 0.55]]) {
  const r = refusedStats(k, c);
  console.log(`\n  refused by known>=${k}, conc<=${c}: ${pc(r.share)} of the corpus`);
  console.log(`    accuracy there ${pc(r.accuracy)}, would have claimed ${pc(r.confidence)} confidence ` +
              `(${((r.confidence - r.accuracy) * 100).toFixed(1)} points overconfident)`);
}

/* Raw (uncalibrated) reliability. The model only exposes calibrated
   out-of-fold probabilities, but Platt scaling is invertible, so the raw
   logit is recoverable exactly: z_raw = (logit(p_cal) - B) / A. This is what
   justifies calibrating at all. */
const { A, B } = m.platt;
const lg = p => Math.log(Math.min(1 - 1e-9, Math.max(1e-9, p)) / (1 - Math.min(1 - 1e-9, Math.max(1e-9, p))));
const sig = z => z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
console.log("\n--- raw vs calibrated reliability (out-of-fold) ---");
console.log("  raw confidence band   n      actually correct");
for (const [lo, hi] of [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]]) {
  let n = 0, hit = 0;
  for (const r of scored) {
    const praw = sig((lg(r.p) - B) / A);
    const c = Math.max(praw, 1 - praw);
    if (c < lo || c >= hi) continue;
    n++;
    if ((praw >= 0.5 ? 1 : 0) === r.y) hit++;
  }
  console.log(`  ${lo.toFixed(2)}-${hi > 1 ? "1.00" : hi.toFixed(2)}            ${String(n).padStart(5)}   ` +
              `${n ? pc(hit / n) : "  -  "}`);
}

/* Median concentration — assess() quotes this when it refuses. */
const concs = scored.map(r => r.e.concentration).sort((a, b) => a - b);
console.log(`\n  median concentration across the corpus: ${pc(concs[Math.floor(concs.length / 2)])}`);
