/* Evaluate the retrieval system — "which bias is this?" — on the curated
   corpus, mirroring how app.js builds its index (retrievalDocs).

   Retrieval is the question the product actually asks, so its leave-one-out
   numbers matter at least as much as the binary model's.

     node scripts/eval_retrieval.js [path/to/biases.js]
*/
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");

const ROOT = path.dirname(__dirname);
const dataFile = process.argv[2] || path.join(ROOT, "data/biases.js");

const box = { window: {}, console, Math, Date, Object, Array, JSON };
box.self = box.window;
vm.createContext(box);
vm.runInContext(fs.readFileSync(dataFile, "utf8"), box, { filename: dataFile });
for (const f of ["encoder.js", "retrieval.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), box, { filename: f });
}

const BIAS_DATA = box.window.BIAS_DATA;
const biasKeyOf = b => b.name.trim().toLowerCase();

const docs = [];
BIAS_DATA.quadrants.forEach((q, qi) =>
  q.categories.forEach((c, ci) =>
    c.biases.forEach((b, bi) => {
      const common = { biasKey: biasKeyOf(b), biasName: b.name, quad: q.name, cat: c.name };
      (b.positive || []).forEach((it, k) =>
        docs.push(Object.assign({ id: `${qi}.${ci}.${bi}:p${k}`, text: it.text, label: 1 }, common)));
      (b.negative || []).forEach((it, k) =>
        docs.push(Object.assign({ id: `${qi}.${ci}.${bi}:n${k}`, text: it.text, label: 0 }, common)));
    })));

const t0 = Date.now();
const R = box.window.CVRetrieval.build(docs, box.window.CVEncoder.tfidf());
console.log(`${path.basename(path.dirname(dataFile))}/${path.basename(dataFile)}`);
console.log(`  indexed ${docs.length} examples in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (!R.ready) { console.log("  NOT READY"); process.exit(1); }

const pc = x => x == null ? "  -  " : (x * 100).toFixed(1) + "%";
const s = R.stats;
console.log(`  biases indexed: ${s.biases}`);
if (s.loo) {
  const L = s.loo;
  for (const k of Object.keys(L)) {
    const v = L[k];
    if (typeof v === "number") console.log(`  loo.${k}: ${v < 1 && v > 0 ? pc(v) : v}`);
  }
}

/* How many biases now clear the support floor needed to be asserted at all. */
const sup = Object.values(R.perBias).map(p => p.pos || 0).sort((a, b) => a - b);
console.log(`  support per bias: min=${sup[0]} median=${sup[Math.floor(sup.length / 2)]} max=${sup[sup.length - 1]}`);
console.log(`  biases with support >= 8: ${sup.filter(x => x >= 8).length} / ${sup.length}`);

/* Spot-check a few phrasings a user might actually paste. */
const probes = [
  "I only fly when the weather is good because I saw a plane crash on the news last week.",
  "She checked the base rates in the official statistics before deciding how risky it really was.",
  "He kept pouring money into the failing project because he had already spent so much on it.",
  "Most drivers think they are safer and more skilled than the average driver.",
  "the thing",
];
console.log("\n  probes:");
for (const p of probes) {
  const r = R.query(p);
  const top = r.candidates && r.candidates[0];
  console.log(`   "${p.slice(0, 58)}${p.length > 58 ? "…" : ""}"`);
  console.log(`      -> ${r.status}${top ? `  ${top.name} (${pc(top.confidence != null ? top.confidence : top.score)})` : ""}`);
}
