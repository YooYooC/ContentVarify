/* ============================================================
   Content Verify — Export menu (top-right).

     • Export to Google Sheets — copies the whole table as TSV and opens
       a blank sheet; the user pastes with ⌘V / Ctrl+V. (No OAuth needed;
       a true Sheets API push would require Google Cloud credentials.)
     • Download spreadsheet (.csv) — opens in Sheets / Excel / Numbers.
     • Download document (.doc) — opens in Word / Google Docs, grouped
       by quadrant → category.

   Reads the current, fully-computed data from window.CVApp.exportData(),
   so every edit, score, and exclusion is reflected.
   ============================================================ */
(function () {
  "use strict";

  var btn = document.getElementById("exportBtn");
  var menu = document.getElementById("exportMenu");
  if (!btn || !menu) return;

  // Column order shared by CSV and the Google-Sheets clipboard copy.
  var COLS = [
    ["quadrant", "Quadrant"], ["category", "Category"], ["bias", "Bias"],
    ["biasReliability", "Model reliability % (bias average)"],
    ["type", "Type"], ["text", "Text"],
    ["reliability", "Model reliability % (example)"], ["verdict", "Model verdict"],
    ["url", "URL"], ["excluded", "Excluded"]
  ];

  function data() {
    return (window.CVApp && CVApp.exportData) ? CVApp.exportData() : { rows: [], overall: null };
  }
  function isMac() { return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function stamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      "_" + p(d.getHours()) + p(d.getMinutes());
  }
  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime + ";charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 120);
  }

  /* ---------- format builders ---------- */
  function csvCell(v) {
    v = v == null ? "" : String(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function toCSV(d) {
    var lines = [COLS.map(function (c) { return csvCell(c[1]); }).join(",")];
    d.rows.forEach(function (r) {
      lines.push(COLS.map(function (c) { return csvCell(r[c[0]]); }).join(","));
    });
    // BOM so Excel / Sheets read it as UTF-8; CRLF for maximum compatibility.
    return "﻿" + lines.join("\r\n");
  }
  function tsvCell(v) { return String(v == null ? "" : v).replace(/[\t\n\r]+/g, " ").trim(); }
  function toTSV(d) {
    var lines = [COLS.map(function (c) { return c[1]; }).join("\t")];
    d.rows.forEach(function (r) {
      lines.push(COLS.map(function (c) { return tsvCell(r[c[0]]); }).join("\t"));
    });
    return lines.join("\n");
  }
  function toDoc(d) {
    var h = '<html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
      'xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">' +
      '<head><meta charset="utf-8"><title>Content Verify export</title></head>' +
      '<body style="font-family:Calibri,Arial,sans-serif;color:#1b1b1f;">' +
      '<h1 style="color:#b5174e;">Content Verify — bias library</h1>' +
      '<p style="color:#555;">Exported ' + esc(new Date().toLocaleString()) +
      ' · ' + d.rows.length + ' rows</p>' +
      (d.model
        ? '<p style="color:#555;">Model quality <b>' + esc(d.model.quality) +
          '%</b> (cross-validated balanced accuracy) · accuracy ' +
          esc(d.model.accuracy) + '% · F1 ' + esc(d.model.f1) + '% · AUC ' +
          esc(d.model.auc) + ' · log loss ' + esc(d.model.logLoss) +
          ' · calibration error ' + esc(d.model.calibrationError) +
          '% · fitted on ' + esc(d.model.trainedOn) + ' examples over ' +
          esc(d.model.features) + ' features, ' + esc(d.model.folds) + '-fold CV.<br>' +
          'Every score below is this model\'s reliability on that example — ' +
          'the probability it assigns to the example\'s own label.</p>'
        : '<p style="color:#a00;">No trained model was available at export time.</p>');

    var curQ = null, curC = null, open = false;
    function closeTable() { if (open) { h += '</table>'; open = false; } }
    d.rows.forEach(function (r) {
      if (r.quadrant !== curQ) { closeTable(); curQ = r.quadrant; curC = null; h += '<h2 style="color:#b5174e;margin-top:22px;">' + esc(r.quadrant) + '</h2>'; }
      if (r.category !== curC) { closeTable(); curC = r.category; h += '<h3 style="margin:14px 0 6px;">' + esc(r.category) + '</h3>'; }
      if (!open) {
        h += '<table border="1" cellspacing="0" cellpadding="6" ' +
          'style="border-collapse:collapse;width:100%;font-size:10.5pt;">' +
          '<tr style="background:#f3d6e0;"><th align="left">Bias</th><th align="left">Type</th>' +
          '<th align="left">Text</th><th>Model reliability</th><th align="left">Verdict</th></tr>';
        open = true;
      }
      var strike = r.excluded === "yes" ? 'color:#999;text-decoration:line-through;' : '';
      h += '<tr style="' + strike + '"><td>' + esc(r.bias) + '</td><td>' + esc(r.type) +
        '</td><td>' + esc(r.text) + '</td><td align="center">' +
        (r.reliability === "" ? "—" : esc(r.reliability) + "%") + '</td><td>' +
        esc(r.verdict) + '</td></tr>';
    });
    closeTable();
    return h + '</body></html>';
  }

  /* ---------- clipboard (for the Google Sheets flow) ---------- */
  function fallbackCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed"; ta.style.top = "-1000px"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  /* ---------- toast ---------- */
  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById("export-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "export-toast"; t.className = "export-toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 6000);
  }

  /* ---------- actions ---------- */
  function doCSV() {
    download("content-verify_" + stamp() + ".csv", toCSV(data()), "text/csv");
    toast("Spreadsheet downloaded. Open it in Google Sheets, Excel, or Numbers.");
  }
  function doDoc() {
    download("content-verify_" + stamp() + ".doc", toDoc(data()), "application/msword");
    toast("Document downloaded. Open it in Word or upload to Google Docs.");
  }
  function doSheets() {
    // Open the blank sheet synchronously (inside the click) so pop-up blockers allow it.
    var w = window.open("https://sheets.new", "_blank");
    copy(toTSV(data())).then(function (ok) {
      if (!w) {
        toast("Allow pop-ups for this site, or use “Download spreadsheet (.csv)”.");
        return;
      }
      toast(ok
        ? "Copied ✓  In the new Google Sheet, click cell A1 and press " + (isMac() ? "⌘V" : "Ctrl+V") + " to paste."
        : "Opened Google Sheets, but couldn’t auto-copy. Use “Download spreadsheet (.csv)” → File ▸ Import instead.");
    });
  }

  /* ---------- menu wiring ---------- */
  function openMenu() { menu.classList.remove("hidden"); btn.setAttribute("aria-expanded", "true"); }
  function closeMenu() { menu.classList.add("hidden"); btn.setAttribute("aria-expanded", "false"); }
  function toggle() { menu.classList.contains("hidden") ? openMenu() : closeMenu(); }

  btn.addEventListener("click", function (e) { e.stopPropagation(); toggle(); });
  menu.addEventListener("click", function (e) {
    var item = e.target.closest ? e.target.closest(".export-item") : null;
    if (!item) return;
    var x = item.getAttribute("data-x");
    closeMenu();
    if (x === "csv") doCSV();
    else if (x === "doc") doDoc();
    else if (x === "sheets") doSheets();
  });
  document.addEventListener("click", function (e) {
    if (!menu.classList.contains("hidden") && !menu.contains(e.target) && e.target !== btn) closeMenu();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeMenu(); });
})();
