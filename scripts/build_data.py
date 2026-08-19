#!/usr/bin/env python3
"""Parse all Cognitive Bias Codex quadrant CSVs into one structured dataset.

The five source spreadsheets use four different layouts, so each is handled by a
format-specific parser, but they all produce the same shape:

    quadrant -> categories -> biases -> {definition, positive[], negative[]}

Every example is verbatim — only encoding artifacts are repaired and list
numbering is stripped.

No scores are emitted here. Scores used to be assigned by a keyword table in
this file, which was never trained or validated against anything. They are now
produced by the model in model.js, which is fitted to these examples in the
browser and cross-validated; the labels the model learns from are structural
(positive[] = the bias in action, negative[] = clear thinking), so this file
only has to get the text and the sides right.
"""
import csv, json, re, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

# Tab order matches the product's top nav.
#
# `cols` pins the column each field lives in, because the sheets do not agree
# and have been re-ordered before. Not Enough Meaning gained a "Short"
# definition column between the definition and the examples; Need to Act Fast
# moved its Ex1-Ex5 / C-Ex1-C-Ex3 block right by three to make room for two
# columns of bundled examples. Naming the indices here means a future
# re-order is a one-line change instead of a silent mislabelling.
SOURCES = [
    {"file": "not-enough-meaning.csv",      "quadrant": "Not Enough Meaning",      "format": "two_col",
     "cols": {"cat": 0, "name": 1, "def": 2, "short": 3, "pos": 4, "neg": 5}},
    {"file": "too-much-information.csv",     "quadrant": "Too Much Information",     "format": "two_col",
     "cols": {"cat": 0, "name": 1, "def": 2, "pos": 3, "neg": 4}},
    {"file": "what-to-remember.csv",         "quadrant": "What to Remember",         "format": "two_col",
     "cols": {"cat": 0, "name": 1, "def": 2, "pos": 3, "neg": 4}},
    {"file": "need-to-act-fast.csv",         "quadrant": "Need to Act Fast",         "format": "wide",
     "cols": {"cat": 0, "name": 1, "def": 2, "packed_pos": 4, "packed_neg": 5,
              "pos": [6, 7, 8, 9, 10], "neg": [11, 12, 13]}},
    # Same quadrant as the row above, in a different sheet layout. The two
    # sheets overlap heavily but neither contains the other: the wide sheet
    # carries most of the worked examples, the parsed sheet carries most of
    # the counter-examples plus four biases the wide sheet never got
    # (Defensive attribution hypothesis, Lake Wobegon effect, Hard-easy
    # effect, False consensus effect). Emitting them as two quadrants shipped
    # every shared bias twice under two names, which is why they are given
    # the same quadrant name here and folded together by merge_quadrants().
    {"file": "need-to-act-fast-parsed.csv",  "quadrant": "Need to Act Fast",  "format": "parsed",
     "cols": {"name": 0, "def": 1, "pos": 2, "neg": 3}},
]

# Rows in need-to-act-fast.csv whose two bundled example columns are the wrong
# way round: the first column holds the clear-thinking examples and the second
# holds the bias in action, the opposite of every other row. Verified by
# reading all 51 rows. Feeding these in unswapped would train the model on
# inverted labels for these biases, so they are corrected on the way in.
SWAPPED_PACKED = {
    "actor-observer bias",
    "pseudo certainty effect",
    "disposition effect",
}

# Two rows in the sheets have one example column pasted over the top of the
# other, so the same sentence ends up labelled both "bias in action" and
# "clear thinking". Identical text under opposite labels is worse than no
# example: it teaches nothing and guarantees an error in cross-validation
# whatever the model learns. Each was read to establish which column received
# the stray paste; the value is the side the duplicates are removed from.
#
#   Mood-congruent memory bias  the counter-example cell holds 5 genuine
#                               counter-examples followed by a verbatim copy
#                               of all 20 examples -> drop from negative
#   Absent-mindedness           both cells hold the same text, and its content
#                               ("Intentional focus during task aids memory")
#                               is clear thinking -> drop from positive
#   Levels of processing effect both cells hold the same text bar one typo
#                               ("Amnesic"/"Amnesia"), and its content
#                               ("Implicit test: shallow equals deep") argues
#                               against the effect -> drop from positive. The
#                               citations on the row below supply the real
#                               positive examples.
DUPLICATE_PASTE = {
    "mood-congruent memory bias": "negative",
    "absent-mindedness": "positive",
    "levels of processing effect": "positive",
}

# ---------------------------------------------------------------------------
# Text cleanup
# ---------------------------------------------------------------------------
MOJIBAKE = [
    ("â€™", "'"), ("â€˜", "'"), ("â€œ", '"'), ("â€\x9d", '"'),
    ("â€”", "—"), ("â€“", "–"), ("â€¦", "…"),
    ("Ã©", "é"), ("Ã¨", "è"), ("Ã¯", "ï"), ("Ã¤", "ä"), ("Ã¶", "ö"),
    ("Ã¼", "ü"), ("Ã±", "ñ"), ("Ã§", "ç"), ("Ã¸", "ø"), ("Ã ", "à"),
]


def clean(s):
    if not s:
        return s or ""
    for a, b in MOJIBAKE:
        s = s.replace(a, b)
    s = s.replace("â€", '"')          # any leftover smart-quote shell
    s = re.sub(r"â(?=[A-Za-z])", "'", s)   # apostrophe / opening quote before a letter
    s = re.sub(r"(?<=[A-Za-z])â", "'", s)  # apostrophe / closing quote after a letter
    s = s.replace(" â ", " — ")
    s = s.replace("â", "'")
    return s


# Strip leading list markers ("1) ", "1. ", "I. ", "* ") without touching
# wording. The optional single letter absorbs typos in the sheet such as
# "d5. You update when evidence contradicts you." — it can only ever match one
# stray character directly in front of a number, so real prose is untouched.
ENUM_RE = re.compile(r"^\s*[A-Za-z]?(\d+[.)]|[IVX]+\.|\*)\s+")


def strip_enum(line):
    return ENUM_RE.sub("", line, count=1).strip()


URL_RE = re.compile(r"(https?://\S+)\s*$")
HAS_WORD = re.compile(r"[A-Za-z]{2}")

def make_item(text, kind):
    line = strip_enum(clean(text).strip())
    url = ""
    m = URL_RE.search(line)
    if m:
        url = m.group(1)
        line = line[:m.start()].strip()
    # Leftover punctuation from a split ("." , ";") is not an example.
    if not line or not HAS_WORD.search(line):
        return None
    return {"text": line, "url": url}


# Some cells hold several examples run together on one line instead of one per
# line. Two enumeration styles occur:
#
#   roman   "I. Baumeister et al. (2001): ... domain. II. Feedback ratio: ..."
#           (the research-citation rows in what-to-remember.csv)
#   packed  "1. Drivers text more; 2. Workers in protective gear take ..."
#           (the bundled example columns in need-to-act-fast.csv)
#
# Splitting on the marker rather than on the separator matters: packed items
# contain their own semicolons ("1. You succeeded because of your skill;
# failed because the test was unfair; 2. You won ..."), so splitting on ";"
# would shred them mid-example.
# Split before a marker only when a capital letter or quote follows it, so a
# number inside a sentence ("takes 3. of the sample") can't trigger a split.
INLINE_SPLIT = re.compile(
    r"\s+(?=(?:\d{1,2}|I{1,3}|IV|VI{0,3}|IX|XI{0,3}|V|X)\.\s+[A-Z\"'“‘])")
PACKED_SPLIT = re.compile(r"(?:^|;)\s*\d{1,2}\.\s+")


def split_multiline(cell, kind):
    """One example per line, further splitting any line that runs several
    numbered or roman-numbered examples together."""
    items = []
    for raw in clean(cell).split("\n"):
        if not raw.strip():
            continue
        for part in INLINE_SPLIT.split(raw):
            item = make_item(part, kind)
            if item:
                items.append(item)
    return items


def split_packed(cell, kind):
    """A single cell holding "1. ... ; 2. ... ; 3. ..." -> one item each."""
    items = []
    for part in PACKED_SPLIT.split(clean(cell)):
        part = part.strip().rstrip(";").strip()
        if not part:
            continue
        item = make_item(part, kind)
        if item:
            items.append(item)
    return items


# ---------------------------------------------------------------------------
# Format-specific parsers
# ---------------------------------------------------------------------------
def is_blank(row):
    return not any(c.strip() for c in row)


def title_aliases(quadrant):
    q = quadrant.lower()
    return {q, re.sub(r"\s*parsed$", "", q)}


def cell(row, i):
    return row[i] if i is not None and i < len(row) else ""


def is_header(row, cols):
    """The label row ("Definition" / "Positive Examples" / "Ex1" ...)."""
    d = cell(row, cols.get("def")).strip().lower()
    if d in ("definition", "long definition"):
        return True
    pos = cols.get("pos")
    first = pos[0] if isinstance(pos, list) else pos
    return cell(row, first).strip().lower() in ("ex1", "example", "positive examples")


def parse_two_col(rows, quadrant, cols):
    """One bias per row. A row with no category and no name is a continuation
    of the bias above — what-to-remember.csv puts each bias's research
    citations on such a row, and dropping them lost 18 rows of examples."""
    cats, cur, last, titles = [], None, None, title_aliases(quadrant)
    for row in rows:
        if is_blank(row):
            continue
        c_cat  = cell(row, cols["cat"]).strip()
        c_name = cell(row, cols["name"]).strip()
        if is_header(row, cols):
            continue
        if c_cat and c_cat.lower() in titles:            # quadrant title
            continue
        if c_name:                                       # bias
            if cur is None:
                cur = {"name": quadrant, "biases": []}
                cats.append(cur)
            last = {
                "name": clean(c_name),
                "definition": clean(cell(row, cols["def"])).strip(),
                "positive": split_multiline(cell(row, cols["pos"]), "positive"),
                "negative": split_multiline(cell(row, cols["neg"]), "negative"),
            }
            short = clean(cell(row, cols["short"])).strip() if "short" in cols else ""
            if short:
                last["short"] = short
            cur["biases"].append(last)
        elif c_cat:                                      # category header
            cur = {"name": clean(c_cat), "biases": []}
            cats.append(cur)
        elif last is not None:                           # continuation row
            last["positive"] += split_multiline(cell(row, cols["pos"]), "positive")
            last["negative"] += split_multiline(cell(row, cols["neg"]), "negative")
    return cats


def parse_wide(rows, quadrant, cols):
    """One example per cell across Ex1-Ex5 / C-Ex1-C-Ex3, plus two columns
    holding a further ~10 examples per side bundled into one cell."""
    cats, cur, titles = [], None, title_aliases(quadrant)
    for row in rows:
        if is_blank(row):
            continue
        if is_header(row, cols):
            continue
        c_cat  = cell(row, cols["cat"]).strip()
        c_name = cell(row, cols["name"]).strip()
        if c_cat and c_cat.lower() in titles:
            continue
        if c_name:                                       # bias
            if cur is None:
                cur = {"name": quadrant, "biases": []}
                cats.append(cur)
            pos = [make_item(cell(row, i), "positive") for i in cols["pos"] if cell(row, i).strip()]
            neg = [make_item(cell(row, i), "negative") for i in cols["neg"] if cell(row, i).strip()]
            pos = [p for p in pos if p]
            neg = [n for n in neg if n]

            packed_pos = cell(row, cols["packed_pos"])
            packed_neg = cell(row, cols["packed_neg"])
            if c_name.lower() in SWAPPED_PACKED:         # this row is inverted
                packed_pos, packed_neg = packed_neg, packed_pos
            pos += split_packed(packed_pos, "positive")
            neg += split_packed(packed_neg, "negative")

            cur["biases"].append({
                "name": clean(c_name),
                "definition": clean(cell(row, cols["def"])).strip(),
                "positive": pos,
                "negative": neg,
            })
        elif c_cat:                                      # category header
            cur = {"name": clean(c_cat), "biases": []}
            cats.append(cur)
    return cats


def parse_parsed(rows, quadrant, cols):
    """col0=name (or category), col1=def, col2=Ex, col3=C-Ex (multi-line)."""
    cats, cur, titles = [], None, title_aliases(quadrant)
    for row in rows:
        if is_blank(row):
            continue
        c0 = cell(row, cols["name"]).strip()
        c1 = cell(row, cols["def"]).strip()
        if c1.lower() == "definition":                   # sub-header
            continue
        if c0 and c0.lower() in titles:
            continue
        if c0 and c1:                                    # bias
            if cur is None:
                cur = {"name": quadrant, "biases": []}
                cats.append(cur)
            cur["biases"].append({
                "name": clean(c0),
                "definition": clean(c1),
                "positive": split_multiline(cell(row, cols["pos"]), "positive"),
                "negative": split_multiline(cell(row, cols["neg"]), "negative"),
            })
        elif c0:                                         # category header
            cur = {"name": clean(c0), "biases": []}
            cats.append(cur)
    return cats


PARSERS = {"two_col": parse_two_col, "wide": parse_wide, "parsed": parse_parsed}


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def norm_text(s):
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def merge_quadrants(quadrants):
    """Fold quadrants, categories and biases that share a name into one.

    Two sheets describe the "Need to Act Fast" quadrant. Without this they
    became two quadrants holding 51 and 53 biases, 49 of them the same bias
    under the same name in both — so every one of those biases was indexed
    twice, its examples split across two entries that then competed with each
    other for the top-1 slot. Retrieval keys on the bias NAME, so the split
    also inflated per-bias support counts without adding information.

    Merging is by name at every level, and examples are unioned with exact
    duplicates (ignoring case and punctuation) collapsed, so a bias present in
    both sheets ends up with the union of what each contributed exactly once.
    """
    out, by_name, merged = [], {}, 0

    def merge_items(dst, src):
        nonlocal merged
        seen = {norm_text(i["text"]) for i in dst}
        for it in src:
            k = norm_text(it["text"])
            if k in seen:
                merged += 1
                continue
            seen.add(k)
            dst.append(it)

    for q in quadrants:
        tgt = by_name.get(q["name"])
        if tgt is None:
            # Collapse repeats inside this quadrant too, then keep it.
            by_name[q["name"]] = tgt = {"name": q["name"], "id": q["id"],
                                        "categories": []}
            out.append(tgt)
        cat_by_name = {c["name"]: c for c in tgt["categories"]}
        for c in q["categories"]:
            dc = cat_by_name.get(c["name"])
            if dc is None:
                cat_by_name[c["name"]] = dc = {"name": c["name"], "biases": []}
                tgt["categories"].append(dc)
            bias_by_name = {b["name"].strip().lower(): b for b in dc["biases"]}
            for b in c["biases"]:
                db = bias_by_name.get(b["name"].strip().lower())
                if db is None:
                    bias_by_name[b["name"].strip().lower()] = db = {
                        "name": b["name"], "definition": b["definition"],
                        "positive": [], "negative": []}
                    dc["biases"].append(db)
                elif not db["definition"]:
                    db["definition"] = b["definition"]
                merge_items(db["positive"], b["positive"])
                merge_items(db["negative"], b["negative"])
    return out, merged


def relocate_strays(quadrants):
    """Move a bias to the category the rest of the sheets file it under.

    The parsed sheet has no category column, so parse_parsed() files every
    bias it sees before the first category header under a category named
    after the quadrant. Those biases are not category-less in the other
    sheets; leaving them in a synthetic bucket splits a bias across two
    categories purely by which sheet reached it first.
    """
    moved = 0
    for q in quadrants:
        home = {}
        for c in q["categories"]:
            if c["name"] == q["name"]:
                continue
            for b in c["biases"]:
                home[b["name"].strip().lower()] = c
        for c in [c for c in q["categories"] if c["name"] == q["name"]]:
            keep = []
            for b in c["biases"]:
                dest = home.get(b["name"].strip().lower())
                if dest is None:
                    keep.append(b)
                    continue
                # The destination category already holds this bias, so fold
                # the examples in rather than creating a second entry.
                twin = next((x for x in dest["biases"]
                             if x["name"].strip().lower() == b["name"].strip().lower()), None)
                if twin is None:
                    dest["biases"].append(b)
                else:
                    for side in ("positive", "negative"):
                        seen = {norm_text(i["text"]) for i in twin[side]}
                        twin[side].extend(i for i in b[side]
                                          if norm_text(i["text"]) not in seen
                                          and not seen.add(norm_text(i["text"])))
                moved += 1
            c["biases"] = keep
        q["categories"] = [c for c in q["categories"] if c["biases"]]
    return moved


def dedupe_within_bias(quadrants):
    """Drop repeats of the same example inside one bias.

    A duplicated example is not extra evidence — it is one example given two
    votes in every nearest-neighbour ballot it appears in.
    """
    dropped = 0
    for q in quadrants:
        for c in q["categories"]:
            for b in c["biases"]:
                for side in ("positive", "negative"):
                    seen, keep = set(), []
                    for it in b[side]:
                        k = norm_text(it["text"])
                        if k in seen:
                            dropped += 1
                            continue
                        seen.add(k)
                        keep.append(it)
                    b[side] = keep
    return dropped


def cross_bias_duplicates(quadrants):
    """Report examples filed under more than one bias.

    An example that sits under two names votes for both every time it is
    retrieved, so it teaches that the two biases are the same thing and
    guarantees an error whichever way the ranking falls. Every case found so
    far has been a stray paste in a sheet — a block of one bias's examples
    landing in another's cell — which is invisible in the spreadsheet and
    silent at build time until it is counted.

    Not auto-resolved: which side a shared example belongs to is a judgement
    about the biases, not something the parser can infer. Reported so the
    sheets can be corrected at source.
    """
    where = {}
    for q in quadrants:
        for c in q["categories"]:
            for b in c["biases"]:
                for side in ("positive", "negative"):
                    for it in b[side]:
                        where.setdefault(norm_text(it["text"]), []).append(
                            (b["name"], it["text"]))
    out = {}
    for hits in where.values():
        names = sorted({n for n, _ in hits})
        if len(names) > 1:
            out.setdefault(" || ".join(names), []).append(hits[0][1])
    return out


def dedupe_contradictions(quadrants):
    """Remove any example that carries both labels within the same bias.

    Where the affected bias is one of the two verified above, only the copy on
    the pasted-over side goes and the good side is kept. Anything else is a
    case nobody has looked at, so it is dropped from both sides and reported
    rather than silently resolved in a guessed direction.
    """
    fixed, unverified = 0, []
    for q in quadrants:
        for c in q["categories"]:
            for b in c["biases"]:
                pos = {i["text"] for i in b["positive"]}
                both = pos & {i["text"] for i in b["negative"]}
                if not both:
                    continue
                side = DUPLICATE_PASTE.get(b["name"].strip().lower())
                drop = [side] if side else ["positive", "negative"]
                if not side:
                    unverified.append((q["name"], b["name"], len(both)))
                for s in drop:
                    b[s] = [i for i in b[s] if i["text"] not in both]
                fixed += len(both)
    return fixed, unverified


def main():
    quadrants = []
    for src in SOURCES:
        path = os.path.join(DATA, src["file"])
        with open(path, newline="", encoding="utf-8") as f:
            rows = list(csv.reader(f))
        cats = PARSERS[src["format"]](rows, src["quadrant"], src["cols"])
        quadrants.append({
            "name": src["quadrant"],
            "id": slug(src["quadrant"]),
            "categories": cats,
        })

    quadrants, merged = merge_quadrants(quadrants)
    moved = relocate_strays(quadrants)
    repeats = dedupe_within_bias(quadrants)
    fixed, unverified = dedupe_contradictions(quadrants)

    data = {"title": "Content Verify", "quadrants": quadrants}

    with open(os.path.join(DATA, "biases.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    with open(os.path.join(DATA, "biases.js"), "w", encoding="utf-8") as f:
        f.write("window.BIAS_DATA = ")
        json.dump(data, f, ensure_ascii=False)
        f.write(";\n")

    tb = tp = tn = 0
    print(f"{'quadrant':<26}{'cats':>5}{'biases':>8}{'positive':>10}{'negative':>10}")
    for q in quadrants:
        nb = sum(len(c["biases"]) for c in q["categories"])
        np_ = sum(len(b["positive"]) for c in q["categories"] for b in c["biases"])
        nn = sum(len(b["negative"]) for c in q["categories"] for b in c["biases"])
        tb += nb; tp += np_; tn += nn
        print(f"  {q['name']:<24}{len(q['categories']):>5}{nb:>8}{np_:>10}{nn:>10}")
    print(f"  {'TOTAL':<24}{'':>5}{tb:>8}{tp:>10}{tn:>10}   ({tp + tn} training examples)")

    if merged or moved or repeats:
        print(f"\n  merged {merged} example(s) present in more than one sheet, "
              f"relocated {moved} bias(es) out of a sheet-shaped category, "
              f"dropped {repeats} repeat(s) inside a single bias")
    if fixed:
        print(f"  removed {fixed} example(s) that carried both labels "
              f"(duplicated cell in the source sheet)")
    for qn, bn, k in unverified:
        print(f"    ! {qn} / {bn}: {k} contradictory example(s), side unverified "
              f"-> dropped from both. Check the sheet.")

    shared = cross_bias_duplicates(quadrants)
    if shared:
        n = sum(len(v) for v in shared.values())
        print(f"\n  {n} example(s) filed under more than one bias, in "
              f"{len(shared)} pair(s) — each one teaches that those biases are "
              f"the same thing:")
        for names, texts in sorted(shared.items(), key=lambda kv: -len(kv[1])):
            print(f"    [{len(texts)}] {names}")
            for t in texts[:2]:
                print(f"          {t[:88]}")

    # A bias with nothing on one side teaches the model nothing about that
    # side, and is nearly always a column that moved rather than a gap in the
    # source, so it is worth surfacing every build.
    empty = [(q["name"], b["name"])
             for q in quadrants for c in q["categories"] for b in c["biases"]
             if not b["positive"] or not b["negative"]]
    if empty:
        print(f"\n  {len(empty)} bias(es) missing examples on one side:")
        for qn, bn in empty:
            print(f"    - {qn}: {bn}")


if __name__ == "__main__":
    main()
