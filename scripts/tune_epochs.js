/* How many passes does the corpus actually need?

   EPOCHS was set when the corpus was ~2.5k examples. It is now ~7.7k, and
   the app refits on the main thread every time the user curates an example,
   so an epoch that buys nothing costs the user real time. This trains the
   real model.js at several settings and reports held-out accuracy against
   wall-clock, so the value is chosen on evidence.

     node scripts/tune_epochs.js [epochs,epochs,...]
*/
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");

const ROOT = path.dirname(__dirname);
const SRC = fs.readFileSync(path.join(ROOT, "model.js"), "utf8");
const DATA = fs.readFileSync(path.join(ROOT, "data/biases.js"), "utf8");

const dataBox = { window: {} };
vm.createContext(dataBox);
vm.runInContext(DATA, dataBox);
const docs = [];
dataBox.window.BIAS_DATA.quadrants.forEach((q, qi) =>
  q.categories.forEach((c, ci) =>
    c.biases.forEach((b, bi) => {
      (b.positive || []).forEach((it, k) => docs.push({ id: `${qi}.${ci}.${bi}:p${k}`, text: it.text, label: 1 }));
      (b.negative || []).forEach((it, k) => docs.push({ id: `${qi}.${ci}.${bi}:n${k}`, text: it.text, label: 0 }));
    })));

function runWith(epochs) {
  const patched = SRC.replace(/var EPOCHS\s*=\s*\d+;/, `var EPOCHS = ${epochs};`);
  if (patched === SRC) throw new Error("could not patch EPOCHS — has the declaration changed?");
  const box = { window: {}, console, Math, Date, Object, Array, JSON };
  vm.createContext(box);
  vm.runInContext(patched, box);
  const t = Date.now();
  const M = box.window.CVModel.train(docs);
  return { secs: (Date.now() - t) / 1000, m: M.metrics };
}

const list = (process.argv[2] || "5,10,15,20,30,45,60").split(",").map(Number);
console.log(`corpus: ${docs.length} docs\n`);
console.log("epochs   time     accuracy   balanced      F1      AUC     ECE");
let best = null;
for (const e of list) {
  const { secs, m } = runWith(e);
  const pc = x => (x * 100).toFixed(1) + "%";
  console.log(`${String(e).padStart(6)}  ${secs.toFixed(1).padStart(5)}s   ` +
              `${pc(m.accuracy).padStart(7)}   ${pc(m.balanced).padStart(7)}  ` +
              `${pc(m.f1).padStart(6)}  ${m.auc.toFixed(4)}  ${pc(m.ece).padStart(5)}`);
  if (!best || m.accuracy > best.acc) best = { e, acc: m.accuracy };
}
console.log(`\nbest accuracy at ${best.e} epochs (${(best.acc * 100).toFixed(1)}%)`);
