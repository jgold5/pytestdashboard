#!/usr/bin/env python3
"""Search a repo's pull requests, and its merged code, for a word.

For every PR (open by default) it prints where the word appears: file, line number
and the line. Ways to look:

- default: the PR's changes, i.e. the lines it adds or modifies (fast: one API call
  per PR);
- --full: every file on the PR's branch, including code the PR didn't touch (slower:
  downloads the branch);
- --branches core,dev: the merged code, i.e. every file on those branches (with
  --no-prs, only that);
- --state merged: the changes of PRs that were merged;
- --both: merged and not merged at once: the open PRs, plus all merged code on the
  branches they go into (or on --base).

Uses only the Python standard library (3.8+). Needs a token that can read the repo:

    export GITHUB_TOKEN=ghp_...
    python3 tools/search_prs.py your-org/pytest-repo invoice-load
    python3 tools/search_prs.py your-org/pytest-repo invoice-load --base core
    python3 tools/search_prs.py your-org/pytest-repo 'INV_\\d+' --regex --full --glob '*.py'
    python3 tools/search_prs.py your-org/pytest-repo invoice-load --branches main,core,dev
    python3 tools/search_prs.py your-org/pytest-repo invoice-load --branches core --no-prs
    python3 tools/search_prs.py your-org/pytest-repo invoice-load --state merged --base core
    python3 tools/search_prs.py your-org/pytest-repo invoice-load --both --base core

GitHub Enterprise Server: --api https://github.yourcompany.com/api/v3
"""
from __future__ import annotations

import argparse
import fnmatch
import io
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from typing import Dict, Iterator, List, Optional, Tuple

VERSION = "1.2"


class GitHub:
    def __init__(self, api: str, token: str):
        self.api = api.rstrip("/")
        self.token = token

    def _open(self, url: str, accept: str = "application/vnd.github+json"):
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {self.token}",
            "Accept": accept,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "pytest-dashboard-search-prs",
        })
        try:
            return urllib.request.urlopen(req, timeout=120)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:300]
            hint = {
                401: "the token was rejected (expired or wrong?)",
                403: "access refused (token scope, SSO authorization, or rate limit)",
                404: "not found, or the token can't see this repo",
            }.get(e.code, "")
            sys.exit(f"GitHub answered HTTP {e.code} for {url.split('?')[0]}: {hint}\n{body}")
        except urllib.error.URLError as e:
            sys.exit(f"Could not reach {self.api}: {e.reason}")

    def get_json(self, path: str, params: Optional[Dict[str, str]] = None):
        url = f"{self.api}{path}" + (f"?{urllib.parse.urlencode(params)}" if params else "")
        with self._open(url) as res:
            return json.load(res), res.headers.get("Link", "")

    def paged(self, path: str, params: Dict[str, str], cap: int = 3000) -> Iterator[dict]:
        """Follow rel="next" links."""
        data, link = self.get_json(path, {**params, "per_page": "100"})
        count = 0
        while True:
            for item in data:
                yield item
                count += 1
                if count >= cap:
                    return
            nxt = re.search(r'<([^>]+)>;\s*rel="next"', link or "")
            if not nxt or not data:
                return
            with self._open(nxt.group(1)) as res:
                data, link = json.load(res), res.headers.get("Link", "")

    def zipball(self, repo: str, ref: str) -> bytes:
        quoted = "/".join(urllib.parse.quote(p, safe="") for p in ref.split("/"))
        with self._open(f"{self.api}/repos/{repo}/zipball/{quoted}") as res:
            return res.read()


def matcher(word: str, regex: bool, ignore_case: bool):
    flags = re.IGNORECASE if ignore_case else 0
    pattern = re.compile(word if regex else re.escape(word), flags)
    return pattern.search


def search_patch(patch: str, found) -> List[Tuple[int, str]]:
    """Added/changed lines of a unified diff that match, with their line numbers in the new file."""
    hits: List[Tuple[int, str]] = []
    line_no = 0
    for raw in patch.splitlines():
        h = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)", raw)
        if h:
            line_no = int(h.group(1))
            continue
        if raw.startswith("+"):
            if found(raw[1:]):
                hits.append((line_no, raw[1:].strip()))
            line_no += 1
        elif raw.startswith(" "):
            line_no += 1
    return hits


def search_zip(data: bytes, found, glob: Optional[str]) -> Dict[str, List[Tuple[int, str]]]:
    out: Dict[str, List[Tuple[int, str]]] = {}
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for info in z.infolist():
            if info.is_dir() or info.file_size > 5_000_000:
                continue
            path = info.filename.split("/", 1)[1] if "/" in info.filename else info.filename  # strip owner-repo-sha/
            if glob and not fnmatch.fnmatch(path, glob) and not fnmatch.fnmatch(os.path.basename(path), glob):
                continue
            raw = z.read(info)
            if b"\0" in raw[:4096]:
                continue  # binary
            text = raw.decode("utf-8", "replace")
            hits = [(i, l.strip()) for i, l in enumerate(text.splitlines(), 1) if found(l)]
            if hits:
                out[path] = hits
    return out


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Search a repo's pull requests for a word.")
    ap.add_argument("repo", help="owner/name")
    ap.add_argument("word", help="text to look for (a regular expression with --regex)")
    ap.add_argument("--state", choices=["open", "merged", "closed", "all"], default="open", help="which PRs (default: open; merged = closed and merged)")
    ap.add_argument("--base", help="only PRs into this branch, e.g. core")
    ap.add_argument("--full", action="store_true", help="search every file on the PR's branch, not just its changes")
    ap.add_argument("--branches", help="also search all merged code on these branches, comma-separated, e.g. main,core,dev")
    ap.add_argument("--no-prs", action="store_true", help="with --branches: search only the branches, not the PRs")
    ap.add_argument("--both", action="store_true", help="merged and not merged: the open PRs, plus all merged code on the branches they go into (or --base)")
    ap.add_argument("--glob", help="only files matching this pattern, e.g. '*.py' or 'src/route_test/*'")
    ap.add_argument("--regex", action="store_true", help="treat WORD as a regular expression")
    ap.add_argument("-i", "--ignore-case", action="store_true")
    ap.add_argument("--max-lines", type=int, default=5, help="matching lines shown per file (default 5)")
    ap.add_argument("--json", action="store_true", help="print the results as JSON")
    ap.add_argument("--api", default=os.environ.get("GITHUB_API_URL", "https://api.github.com"), help="REST API base URL")
    ap.add_argument("--version", action="version", version=VERSION)
    args = ap.parse_args(argv)

    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        sys.exit("Set GITHUB_TOKEN to a token that can read the repo.")
    if not re.match(r"^[\w.-]+/[\w.-]+$", args.repo):
        sys.exit("repo must be owner/name, not a URL")
    found = matcher(args.word, args.regex, args.ignore_case)
    gh = GitHub(args.api, token)

    progress = (lambda msg: print(f"  {msg}"[:79].ljust(79), end="\r", file=sys.stderr, flush=True)) if sys.stderr.isatty() and not args.json else (lambda msg: None)
    if args.no_prs and not args.branches:
        sys.exit("--no-prs needs --branches")
    if args.both and args.no_prs:
        sys.exit("--both searches PRs too; drop --no-prs")

    # merged code: every file on the given branches
    prs: List[dict] = []
    if not args.no_prs:
        params = {"state": "closed" if args.state == "merged" else args.state, "sort": "updated", "direction": "desc"}
        if args.base:
            params["base"] = args.base
        prs = [p for p in gh.paged(f"/repos/{args.repo}/pulls", params) if args.state != "merged" or p.get("merged_at")]
        if not args.json:
            print(f"{len(prs)} {args.state} PR(s) in {args.repo}{f' into {args.base}' if args.base else ''}; "
                  f"searching {'whole branches' if args.full else 'their changes'} for {args.word!r}", file=sys.stderr)

    # merged code: every file on the given branches; with --both, the branches the PRs go into
    branches = [x.strip() for x in (args.branches or "").split(",") if x.strip()]
    if args.both and not branches:
        branches = [args.base] if args.base else sorted({(p.get("base") or {}).get("ref", "") for p in prs} - {""})
    branch_results = []
    for b in branches:
        progress(f"merged code on {b}…")
        files = search_zip(gh.zipball(args.repo, b), found, args.glob)
        branch_results.append({"branch": b, "files": {p: [{"line": l, "text": t} for l, t in h] for p, h in files.items()}})

    results = []
    for n, pr in enumerate(prs, 1):
        head = pr.get("head") or {}
        ref = head.get("ref", "")
        progress(f"[{n}/{len(prs)}] #{pr['number']} {ref}…")
        files: Dict[str, List[Tuple[int, str]]] = {}
        note = None
        if args.full:
            src = (head.get("repo") or {}).get("full_name") or args.repo
            if src != args.repo:
                note = f"from fork {src}: searched its changes only"
            else:
                files = search_zip(gh.zipball(args.repo, ref), found, args.glob)
        if not args.full or note:
            for f in gh.paged(f"/repos/{args.repo}/pulls/{pr['number']}/files", {}, cap=3000):
                path = f.get("filename", "")
                if args.glob and not fnmatch.fnmatch(path, args.glob) and not fnmatch.fnmatch(os.path.basename(path), args.glob):
                    continue
                hits = search_patch(f.get("patch") or "", found)
                if found(path) and not hits:
                    hits = [(0, "(file name matches)")]
                if hits:
                    files[path] = hits
        if files:
            results.append({
                "number": pr["number"],
                "title": pr.get("title", ""),
                "url": pr.get("html_url", ""),
                "branch": ref,
                "base": (pr.get("base") or {}).get("ref", ""),
                "state": "merged" if pr.get("merged_at") else (pr.get("state") or "open"),
                "note": note,
                "files": {p: [{"line": l, "text": t} for l, t in h] for p, h in files.items()},
            })

    if args.json:
        json.dump({"branches": branch_results, "prs": results}, sys.stdout, indent=2)
        print()
        return 0
    progress("")
    print(file=sys.stderr)
    for b in branch_results:
        n = sum(len(h) for h in b["files"].values())
        print(f"[merged code on {b['branch']}]  {n} line(s) in {len(b['files'])} file(s)")
        for path, hits in b["files"].items():
            print(f"    {path}")
            for h in hits[: args.max_lines]:
                print(f"      {str(h['line']) + ':':>6} {h['text'][:160]}")
            if len(hits) > args.max_lines:
                print(f"      … {len(hits) - args.max_lines} more")
        print()
    if not results and not any(b["files"] for b in branch_results):
        print(f"Nothing mentions {args.word!r}.")
        return 1
    for r in results:
        print(f"#{r['number']}  {r['title']}")
        print(f"    {r['branch']} -> {r['base']}  ({r['state']})  {r['url']}")
        if r["note"]:
            print(f"    note: {r['note']}")
        for path, hits in r["files"].items():
            print(f"    {path}")
            for h in hits[: args.max_lines]:
                where = f"{h['line']}:" if h["line"] else ""
                print(f"      {where:>6} {h['text'][:160]}")
            if len(hits) > args.max_lines:
                print(f"      … {len(hits) - args.max_lines} more")
        print()
    if not args.no_prs:
        total = sum(len(h) for r in results for h in r["files"].values())
        print(f"{len(results)} of {len(prs)} PR(s) mention {args.word!r} ({total} line(s)).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
