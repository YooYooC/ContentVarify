#!/usr/bin/env python3
"""Parse all Cognitive Bias Codex quadrant CSVs into one structured dataset.

The five source spreadsheets use four different layouts, so each is handled by a
format-specific parser, but they all produce the same shape:

    quadrant -> categories -> biases -> {definition, positive[], negative[]}

Every example is verbatim (only encoding artifacts are repaired and list
numbering is stripped) and carries a 0-100 BIAS score used for colouring.
"""
import csv, json, re, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

# Tab order matches the product's top nav.
SOURCES = [
    {"file": "not-enough-meaning.csv",      "quadrant": "Not Enough Meaning",      "format": "two_col"},
    {"file": "too-much-information.csv",     "quadrant": "Too Much Information",     "format": "two_col"},
    {"file": "what-to-remember.csv",         "quadrant": "What to Remember",         "format": "two_col"},
    {"file": "need-to-act-fast.csv",         "quadrant": "Need to Act Fast",         "format": "wide"},
    {"file": "need-to-act-fast-parsed.csv",  "quadrant": "Need to Act Fast Parsed",  "format": "parsed"},
]

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


# Strip leading list markers ("1) ", "1. ", "I. ", "* ") without touching wording.
ENUM_RE = re.compile(r"^\s*(\d+[.)]|[IVX]+\.|\*)\s+")


def strip_enum(line):
    return ENUM_RE.sub("", line, count=1).strip()


URL_RE = re.compile(r"(https?://\S+)\s*$")

# ---------------------------------------------------------------------------
# Scoring (0 = not biased / white, 100 = most biased / dark)
# ---------------------------------------------------------------------------
SEVERITY = [
    "convinced", "certain", "certainty", "insist", "guaranteed", "guarantee",
    "definitely", "refuse", "refused", "ignoring", "ignores", "ignored",
    "dismiss", "no awareness", "fully", "confident", "confidently", "never",
    "impossible", " must ", "always", "every ", " all ", "overwhelming",
    "fabricat", "confabulat", "spontaneously", "vivid",
]
MILDNESS = [
    "think", "thinking", "feel", "feeling", "assum", "might", "slight",
    "minor", "small", "seem", "tend", "a bit", "briefly",
]
RIGOR = [
    "comput", "calculat", "statistic", "bayes", "randomi", "controlled trial",
    "margin of error", "power", "calibrat", "actuarial", "probabilit",
    "base rate", "base-rate", "simulation", "regression", "sample size",
    "meta-analys", "control chart", "runs test", "poisson", "evidence",
    "data ", " data", "peer", "audit", "expected value", "monte carlo",
    "significan", "fault-tree", "metrics", "records",
]
UNCERTAINTY = [
    "don't know", "do not know", "not sure", "not certain", "uncertain",
    "acknowledg", "might be", "can't tell", "cannot tell", "declined",
    "refrain", "i'm not", "honestly can't", "wait", "weak and vague",
    "not enough", "too small", "too short", "too few",
]


def _count(text, words):
    t = " " + text.lower() + " "
    return sum(1 for w in words if w in t)


def score_example(text, kind):
    if kind == "positive":   # the bias in action -> high / dark band
        base = 70
        score = base + 6 * _count(text, SEVERITY) - 4 * _count(text, MILDNESS)
        return max(54, min(92, score))
    else:                    # clear thinking -> low / white band
        base = 26
        score = base - 5 * _count(text, RIGOR) - 4 * _count(text, UNCERTAINTY)
        return max(2, min(42, score))


def make_item(text, kind):
    line = strip_enum(clean(text).strip())
    url = ""
    m = URL_RE.search(line)
    if m:
        url = m.group(1)
        line = line[:m.start()].strip()
    if not line:
        return None
    return {"text": line, "url": url, "score": score_example(line, kind)}


def split_multiline(cell, kind):
    items = []
    for raw in clean(cell).split("\n"):
        if not raw.strip():
            continue
        item = make_item(raw, kind)
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


def parse_two_col(rows, quadrant):
    """col0=category, col1=bias name, col2=def, col3=positive, col4=negative."""
    cats, cur, titles = [], None, title_aliases(quadrant)
    for row in rows:
        row = (row + [""] * 5)[:5]
        c0, c1, c2, c3, c4 = row
        if is_blank(row):
            continue
        if c2.strip().lower() in ("definition",):       # header row
            continue
        if c0.strip() and c0.strip().lower() in titles:  # quadrant title
            continue
        if c1.strip():                                   # bias
            if cur is None:
                cur = {"name": quadrant, "biases": []}
                cats.append(cur)
            cur["biases"].append({
                "name": clean(c1).strip(),
                "definition": clean(c2).strip(),
                "positive": split_multiline(c3, "positive"),
                "negative": split_multiline(c4, "negative"),
            })
        elif c0.strip():                                 # category header
            cur = {"name": clean(c0).strip(), "biases": []}
            cats.append(cur)
    return cats


def parse_wide(rows, quadrant):
    """col0=category, col1=name, col2=def, col3-7=Ex, col8-10=C-Ex (one per cell)."""
    cats, cur, titles = [], None, title_aliases(quadrant)
    for row in rows:
        row = (row + [""] * 11)[:11]
        if is_blank(row):
            continue
        if row[2].strip().lower() == "definition":
            continue
        if row[0].strip() and row[0].strip().lower() in titles:
            continue
        if row[1].strip():                               # bias
            if cur is None:
                cur = {"name": quadrant, "biases": []}
                cats.append(cur)
            pos = [make_item(row[i], "positive") for i in (3, 4, 5, 6, 7) if row[i].strip()]
            neg = [make_item(row[i], "negative") for i in (8, 9, 10) if row[i].strip()]
            cur["biases"].append({
                "name": clean(row[1]).strip(),
                "definition": clean(row[2]).strip(),
                "positive": [p for p in pos if p],
                "negative": [n for n in neg if n],
            })
        elif row[0].strip():                             # category header
            cur = {"name": clean(row[0]).strip(), "biases": []}
            cats.append(cur)
    return cats


def parse_parsed(rows, quadrant):
    """col0=name (or category), col1=def, col2=Ex, col3=C-Ex (multi-line)."""
    cats, cur, titles = [], None, title_aliases(quadrant)
    for row in rows:
        row = (row + [""] * 4)[:4]
        c0, c1, c2, c3 = row
        if is_blank(row):
            continue
        if c1.strip().lower() == "definition":           # sub-header
            continue
        if c0.strip() and c0.strip().lower() in titles:
            continue
        if c0.strip() and c1.strip():                    # bias
            if cur is None:
                cur = {"name": quadrant, "biases": []}
                cats.append(cur)
            cur["biases"].append({
                "name": clean(c0).strip(),
                "definition": clean(c1).strip(),
                "positive": split_multiline(c2, "positive"),
                "negative": split_multiline(c3, "negative"),
            })
        elif c0.strip():                                 # category header
            cur = {"name": clean(c0).strip(), "biases": []}
            cats.append(cur)
    return cats


PARSERS = {"two_col": parse_two_col, "wide": parse_wide, "parsed": parse_parsed}


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def main():
    quadrants = []
    for src in SOURCES:
        path = os.path.join(DATA, src["file"])
        with open(path, newline="", encoding="utf-8") as f:
            rows = list(csv.reader(f))
        cats = PARSERS[src["format"]](rows, src["quadrant"])
        quadrants.append({
            "name": src["quadrant"],
            "id": slug(src["quadrant"]),
            "categories": cats,
        })

    data = {"title": "Content Verify", "quadrants": quadrants}

    with open(os.path.join(DATA, "biases.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    with open(os.path.join(DATA, "biases.js"), "w", encoding="utf-8") as f:
        f.write("window.BIAS_DATA = ")
        json.dump(data, f, ensure_ascii=False)
        f.write(";\n")

    print("Quadrants:")
    for q in quadrants:
        nb = sum(len(c["biases"]) for c in q["categories"])
        print(f"  {q['name']}: {len(q['categories'])} categories, {nb} biases")


if __name__ == "__main__":
    main()
