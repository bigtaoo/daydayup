"""Fetch CC0 foley from bigsoundbank.com into art/audio/sources/bigsoundbank/.

Why a second source exists at all. The six Kenney packs are a FIXED inventory: you read the
file list and take what is there. That worked while every cue wanted a laser, a glass break or
an interface blip, and it ran out the moment a cue wanted a **whoosh** -- there is no swing,
swoosh or air-movement family anywhere in the six packs (checked by listing all 323 files),
and `swing` is the melee counterpart of `muzzle`, the cue that fires on every sword stroke in
the game. BigSoundBank is a real-world foley library that can be QUERIED, which is what fills
a hole a fixed inventory leaves. The sibling project `funny` reached the same conclusion from
the other end (`tools/audio-pipeline/fetch_freesound.py` there) and its README records the
same finding: a queryable source is the only kind that can answer "does this sound exist".

Three things about this source that are not true of the Kenney packs, all recorded in
`art/audio/packs.json`:

  * **There is no zip and no pack sha256.** Sounds are fetched one at a time, so the integrity
    record is per FILE -- `credits.json` carries a `source_sha256` for every BigSoundBank asset
    and `platform/audioAssets.test.ts` requires it for any pack marked `per_sound`. That is a
    stronger guarantee than the pack-level hash, not a weaker one: it covers the exact bytes
    that were processed rather than the archive they arrived in.
  * **The licence is stated on the page, not shipped in the bundle.** Every sound's page says
    "License CC0 (public domain): Free and royalty-free", answers "Do I have to credit?" with
    "No", and needs no account. `--license` captures that statement verbatim into
    `art/audio/licenses/bigsoundbank-LICENSE.txt` with its source URL and fetch date, so the
    repo holds the same evidence a bundled LICENSE.txt would give it.
  * **OGG is served anonymously.** WAV/FLAC are behind a login; `.ogg` is not, and it is the
    same format the entire Kenney source pool already uses, so this adds no new lossy stage
    that the pipeline was not already accepting.

> **The mistake to not repeat: this search wants ONE noun.** The site's own tips say it, and
> it behaves that way -- `"sword whoosh"` returns nothing while `"whoosh"` returns twelve. It
> fails silently and reads exactly like "this sound does not exist here". `q` is therefore a
> LIST of single-word queries per label, merged by sound id, the same shape `funny`'s freesound
> fetcher landed on for the same reason (there it is freesound ANDing its terms; here it is a
> literal-phrase match). Duration comes back only as `MM:SS`, so it cannot separate a 1.2 s
> take from a 1.8 s one -- the real selection happens in `audit.py` after the fetch, and `need`
> is deliberately larger than any cue's variant count so that selection has something to choose
> between.

Usage:
    ./venv/Scripts/python fetch_bigsoundbank.py [--dry-run] [--only whoosh] [--license]
"""
import argparse, hashlib, json, os, re, sys, urllib.parse, urllib.request

SITE = "https://bigsoundbank.com"
# Repo-relative, resolved from this file rather than from the cwd. The other drivers here take
# their inputs from a scratch working directory and so are cwd-relative on purpose; this one
# writes into the REPO (archived sources and a licence text), and those two paths must not
# depend on which directory the command was typed in.
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DST = os.path.join(ROOT, "art", "audio", "sources", "bigsoundbank")
LICENSE_OUT = os.path.join(ROOT, "art", "audio", "licenses", "bigsoundbank-LICENSE.txt")
UA = {"User-Agent": "daydayup-audio-pipeline (https://github.com/, contact via repo)"}

# One entry per hole the Kenney packs leave, keyed by a short label. `need` is how many
# candidates to keep, not how many ship.
QUERIES = {
    # THE hole. No swing/swoosh/air family exists in any of the six Kenney packs, and the
    # `swing` cue has to fire on every melee stroke whether or not it connects.
    "whoosh": dict(q=["whoosh", "sword"], need=20),
}

STRIP = re.compile(r"<[^>]*>")
H2 = re.compile(r"<h2[^>]*>\s*<a href='/([^']*-s(\d{4})\.html)'>(.*?)</a>", re.S)
DESC = re.compile(r"<div style='text-align:justify;'>(.*?)Length: (\d\d:\d\d)\.", re.S)
LICENSE_LINE = re.compile(r"How to download and/or use these sounds\?\s*(.*?)\s*\(\s*More information", re.S)


def get(url: str, timeout: int = 30) -> bytes:
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()


def clean(s: str) -> str:
    return STRIP.sub("", s).replace("&nbsp;", " ").replace("&#039;", "'").strip()


def search(term: str) -> list[dict]:
    """Parse the server-rendered result list. One request, one noun -- see the module note."""
    html = get(f"{SITE}/search?" + urllib.parse.urlencode({"q": term})).decode("utf-8", "replace")
    hits = []
    # Results are one `resultat_0` block each; the title anchor and the description div both
    # carry the id, so the block boundary is what keeps them paired.
    for block in html.split("class='resultat_0'")[1:]:
        h, d = H2.search(block), DESC.search(block)
        if not h or not d:
            continue
        hits.append({
            "id": h.group(2), "page": f"{SITE}/{h.group(1)}", "title": clean(h.group(3)),
            "description": clean(d.group(1)), "length": d.group(2),
        })
    return hits


def fetch_license(dry_run: bool) -> int:
    """Archive the licence statement from a sound page, verbatim, with its provenance.

    The Kenney packs ship a LICENSE.txt inside the zip; this source states its terms on the
    web page instead. Capturing the sentence itself (rather than writing our own summary of
    it) is what makes `audioAssets.test.ts`'s "every pack's licence text says CC0" mean the
    same thing for both kinds of source.
    """
    page = f"{SITE}/whoosh-1-s0572.html"
    # Strip tags BEFORE matching: the statement is broken across several inline elements on
    # the page, so a regex over the raw HTML matches nothing and looks like "the page changed".
    text = clean(get(page).decode("utf-8", "replace").replace("<", " <"))
    m = LICENSE_LINE.search(text)
    if not m:
        print("could not find the licence statement on %s" % page, file=sys.stderr)
        return 1
    statement = clean(m.group(1))
    body = (
        "BigSoundBank (La Sonotheque) -- licence statement, captured verbatim\n"
        "Author: Joseph SARDIN\n"
        "Source page: %s\n"
        "\n"
        "%s\n"
        "\n"
        "The same page answers its own FAQ:\n"
        "  \"Is this sound free?\"  -> \"Yes, because I intentionally release it under the CC0\n"
        "     license (public-domain equivalent). You can download and use it without paying,\n"
        "     without creating an account, and without asking for permission.\"\n"
        "  \"Is this sound free for commercial use?\" -> \"Yes. You can use this sound in any\n"
        "     project, including commercial ones, anywhere in the world, without paying a\n"
        "     license fee.\"\n"
        "\n"
        "Captured by tools/audio-pipeline/fetch_bigsoundbank.py --license. Unlike the Kenney\n"
        "packs there is no bundled LICENSE.txt to archive, so this file IS the record; re-run\n"
        "the command above to re-capture it from the live page.\n"
    ) % (page, statement)
    print(body)
    if not dry_run:
        os.makedirs(os.path.dirname(LICENSE_OUT), exist_ok=True)
        with open(LICENSE_OUT, "w", encoding="utf-8", newline="\n") as f:
            f.write(body)
        print("wrote %s" % LICENSE_OUT)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="list what would be fetched")
    ap.add_argument("--only", action="append", choices=list(QUERIES),
                    help="restrict to these labels (repeatable)")
    ap.add_argument("--license", action="store_true",
                    help="(re-)capture the licence statement into art/audio/licenses/")
    args = ap.parse_args()

    if args.license:
        return fetch_license(args.dry_run)

    os.makedirs(DST, exist_ok=True)
    record = []
    for label in (args.only or list(QUERIES)):
        spec = QUERIES[label]
        merged: dict[str, dict] = {}
        for term in spec["q"]:
            try:
                for h in search(term):
                    merged.setdefault(h["id"], h)
            except Exception as e:                              # noqa: BLE001 - report, continue
                print("ERROR %s/%s: %s" % (label, term, e), file=sys.stderr)
        hits = sorted(merged.values(), key=lambda h: h["id"])[: spec["need"]]
        for h in hits:
            name = "%s_s%s.ogg" % (label, h["id"])
            path = os.path.join(DST, name)
            print("%-8s %-26s %s  %s" % (label, h["title"][:26], h["length"], name))
            if not args.dry_run and not os.path.exists(path):
                with open(path, "wb") as f:
                    f.write(get("%s/UPLOAD/ogg/%s.ogg" % (SITE, h["id"]), timeout=60))
            if not args.dry_run:
                digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
            else:
                digest = None
            record.append({
                "file": name, "sound_id": h["id"], "title": h["title"],
                "description": h["description"], "author": "Joseph SARDIN",
                "page": h["page"],
                "license": "CC0-1.0", "source_length": h["length"],
                "format": "ogg (the only lossless-source format served without an account)",
                "sha256": digest,
            })
        if len(hits) < spec["need"]:
            print("  note: %s kept %d/%d -- the query returned fewer hits"
                  % (label, len(hits), spec["need"]))

    if not args.dry_run:
        # Merged, not overwritten: --only must not erase the provenance of other labels.
        rec_path = os.path.join(DST, "fetched.json")
        old = json.load(open(rec_path)) if os.path.exists(rec_path) else []
        by_file = {r["file"]: r for r in old}
        by_file.update({r["file"]: r for r in record})
        with open(rec_path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(sorted(by_file.values(), key=lambda r: r["file"]), f, indent=1)
            f.write("\n")
        print("\n%d fetched, %d recorded in %s" % (len(record), len(by_file), rec_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
