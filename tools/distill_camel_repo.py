#!/usr/bin/env python3
"""Distill a Camel + pytest repo into a small, anonymized copy for sharing.

Keeps only what the dashboard's trigger scan reads, and replaces every name and
value with a generic word:

- Camel XML: each <route> with its <from> (and the <endpoint>s they refer to).
  Everything else in the XML (processing steps, beans, comments) is dropped.
- .properties: only the keys the route inputs use, in the same files.
- pytest files: each test's decorators (Allure labels, markers) and its
  allure.dynamic.* calls. Test bodies, fixtures and imports are dropped.

The renaming is consistent across all files: a word becomes the same generic word
everywhere (`invoice-load` -> `alpha-load` in the XML *and* in the test labels),
so which test covers which trigger is preserved. Regex syntax, cron expressions,
Camel option names and file extensions are kept so the patterns still work.
Passwords and user names in endpoint URIs are replaced with REDACTED, and long
digit runs become zeros of the same length.

Usage:
    python3 distill_camel_repo.py /path/to/repo -o distilled --zip

Writes:
    distilled/               the anonymized copy (also uploadable to /api/triggers/scan)
    distilled/distill-report.md   counts and shapes only; safe to share
    distilled.zip            with --zip: the folder above, ready to send
    distilled.map.json       original -> generic words. PRIVATE: keep it, don't send it.

Needs Python 3.9+, no packages.
"""

from __future__ import annotations

import argparse
import ast
import copy
import json
import re
import sys
import zipfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

VERSION = "1.0"

SKIP_DIRS = {
    ".git", "node_modules", "target", "build", "dist", "out", ".venv", "venv", "site-packages",
    "__pycache__", ".idea", ".gradle", ".mvn", ".tox", ".pytest_cache", "allure-results",
}

# Words kept as they are: Camel/pytest/Allure vocabulary and generic terms that
# carry structure, not business names. Everything else is renamed.
KEEP_WORDS = set("""
file files ftp ftps sftp smb quartz quartz2 cron timer scheduler direct seda vm jms activemq amqp kafka
bean log rest http https netty jetty servlet platform mock stub ref uri properties
include exclude antinclude antexclude includeext excludeext filename filter move movefailed premove
delete noop recursive readlock readlockcheckinterval readlocktimeout delay initialdelay period
schedule trigger repeatinterval repeatcount timeunit autostartup startupordering idempotent
idempotentkey donefilename charset binary passivemode stepwise disconnect maxmessagesperpoll
sortby sorter localworkdirectory streamdownload ignorefilenotfoundorpermissionerror
date now name noext onlyname ext header headers exchangeproperty body env sys sysenv
route routes routeid routetemplate camel camelcontext endpoint from to
csv xml txt dat json zip gz tar done err error errors tmp temp bak old archive processed failed
in out inbound outbound incoming outgoing input output data dir path load loader loads job jobs
trigger triggers test tests feature story epic label labels tag tags owner severity critical normal
minor blocker trivial smoke regression sanity api ui e2e suite title link issue testcase description
allure pytest mark marks dynamic parametrize fixture usefixtures skip skipif xfail filterwarnings
self cls true false none null yes no
mon tue wed thu fri sat sun jan feb mar apr may jun jul aug sep oct nov dec
src main resources java kotlin groovy python spring blueprint config conf etc meta inf
dev test qa uat sit prod production stage staging preprod local default common application
com net org www localhost
""".split())

# Camel file-language date patterns (yyyyMMdd, HHmmss…) are formats, not names.
FORMAT_RE = re.compile(r"^[yMdHhmsSaE]+$")
NATO = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliett",
        "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango",
        "uniform", "victor", "whiskey", "xray", "yankee", "zulu"]

SECRET_OPTS = {"password", "passphrase", "username", "privatekey", "privatekeyfile", "privatekeyuri",
               "privatekeypassphrase", "knownhostsfile", "knownhostsuri", "accesskey", "secretkey",
               "sastoken", "token", "clientsecret", "user"}
# Option values that are schedules/numbers, not names: kept (only placeholder keys renamed).
LITERAL_OPTS = {"cron", "schedule", "period", "delay", "initialdelay", "trigger.repeatinterval",
                "trigger.repeatcount", "timeunit", "repeatcount", "fixedrate", "readlocktimeout",
                "readlockcheckinterval", "maxmessagesperpoll", "autostartup"}
REGEX_OPTS = {"include", "exclude"}

PLACEHOLDER = re.compile(r"\{\{([^{}]+)\}\}|\$\{([^{}]+)\}")
CAMEL_LANGUAGE = re.compile(r"^(date|file|header|headers|exchangeProperty|body|bodyAs|in|out|bean|sys|sysenv|env|"
                            r"exchangeId|id|messageTimestamp|camelId|routeId|random|uuid|type|ref|properties|exception)\b")
STANDARD_NS = ("camel.apache.org", "springframework.org", "w3.org", "osgi.org", "aries.apache.org")


class Namer:
    """Consistent original -> generic word mapping."""

    def __init__(self) -> None:
        self.words: Dict[str, str] = {}

    def word(self, w: str) -> str:
        low = w.lower()
        if len(low) <= 2 or low in KEEP_WORDS or FORMAT_RE.match(w):
            return w
        g = self.words.get(low)
        if g is None:
            n = len(self.words)
            g = NATO[n % len(NATO)] + (str(n // len(NATO) + 1) if n >= len(NATO) else "")
            self.words[low] = g
        if w.isupper():
            return g.upper()
        return g.capitalize() if w[0].isupper() else g

    def text(self, s: str, regex: bool = False) -> str:
        """Rename letter runs. In regex mode, escapes (\\d, \\.) and [...] classes are left alone."""
        out: List[str] = []
        i, depth = 0, 0
        while i < len(s):
            c = s[i]
            if regex and c == "\\" and i + 1 < len(s):
                out.append(s[i:i + 2])
                i += 2
                continue
            if regex and c == "[":
                depth += 1
            elif regex and c == "]" and depth:
                depth -= 1
            if c.isalpha():
                j = i
                while j < len(s) and s[j].isalpha():
                    j += 1
                run = s[i:j]
                out.append(run if (regex and depth) else self.word(run))
                i = j
                continue
            if c.isdigit() and not regex:
                j = i
                while j < len(s) and s[j].isdigit():
                    j += 1
                run = s[i:j]
                out.append("0" * len(run) if len(run) >= 4 else run)
                i = j
                continue
            out.append(c)
            i += 1
        result = "".join(out)
        return re.sub(r"\b\d{1,3}(\.\d{1,3}){3}\b", "10.0.0.1", result) if not regex else result

    def placeholders_only(self, s: str) -> str:
        return PLACEHOLDER.sub(lambda m: self.text(m.group(0)), s)

    def uri(self, u: str) -> str:
        m = re.match(r"^(\s*[A-Za-z][\w+.-]*:)(.*)$", u, re.S)
        if not m or m.group(1).startswith(("{{", "${")):
            return self.text(u)
        scheme, rest = m.group(1), m.group(2)
        path, q, query = rest.partition("?")
        path = re.sub(r"//[^/@]*@", "//REDACTED@", path)  # user[:password]@host
        out = scheme + self.text(path)
        if q:
            parts = []
            for p in query.split("&"):
                k, eq, v = p.partition("=")
                kl = k.lower()
                if kl in SECRET_OPTS and v:
                    v = self.text(v) if v.startswith(("{{", "${")) else "REDACTED"
                elif kl in LITERAL_OPTS:
                    v = self.placeholders_only(v)
                elif kl in REGEX_OPTS:
                    v = self.text(v, regex=True)
                else:
                    v = self.text(v)
                parts.append(k + eq + v)
            out += "?" + "&".join(parts)
        return out

    def path(self, rel: str) -> str:
        parts = rel.split("/")
        return "/".join(self.text(p) for p in parts)


# ---------------------------------------------------------------------------
# XML
# ---------------------------------------------------------------------------

TAG = re.compile(r"<\s*(/)?\s*((?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*)((?:[^>\"']|\"[^\"]*\"|'[^']*')*?)(/)?\s*>")
ATTR = re.compile(r"([A-Za-z_][\w:.-]*)\s*=\s*(?:\"([^\"]*)\"|'([^']*)')")
ENTITIES = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'"}


def xml_unescape(s: str) -> str:
    def rep(m: re.Match) -> str:
        e = m.group(1)
        if e.startswith("#x"):
            return chr(int(e[2:], 16))
        if e.startswith("#"):
            return chr(int(e[1:]))
        return ENTITIES.get(e, "")
    return re.sub(r"&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);", rep, s)


def xml_escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")


def local(qname: str) -> str:
    return qname.split(":")[-1]


class XmlItem:
    def __init__(self, path: Tuple[Tuple[str, Tuple[Tuple[str, str], ...]], ...], qname: str, attrs: List[Tuple[str, str]], children: List[Tuple[str, List[Tuple[str, str]]]]):
        self.path, self.qname, self.attrs, self.children = path, qname, attrs, children


def scan_xml(text: str):
    """Routes (with their <from>s) and <endpoint>s, each with its ancestor elements."""
    text = re.sub(r"<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>", " ", text)
    stack: List[Tuple[str, List[Tuple[str, str]]]] = []
    items: List[XmlItem] = []
    route: Optional[XmlItem] = None
    stray_from = 0
    for m in TAG.finditer(text):
        closing, qname, rawattrs, selfclosing = m.group(1), m.group(2), m.group(3) or "", m.group(4)
        attrs = [(a.group(1), xml_unescape(a.group(2) if a.group(2) is not None else a.group(3))) for a in ATTR.finditer(rawattrs)]
        name = local(qname)
        if closing:
            if stack and stack[-1][0] == qname:
                stack.pop()
            if name in ("route", "routeTemplate"):
                route = None
            continue
        ancestors = tuple((q, tuple(a)) for q, a in stack)
        if name in ("route", "routeTemplate"):
            route = XmlItem(ancestors, qname, attrs, [])
            items.append(route)
        elif name == "from":
            if route is not None:
                route.children.append((qname, attrs))
            else:
                stray_from += 1
        elif name == "endpoint":
            items.append(XmlItem(ancestors, qname, attrs, []))
        if not selfclosing:
            stack.append((qname, attrs))
    return items, stray_from


def distill_xml(items: List[XmlItem], namer: Namer) -> str:
    def attrs_out(attrs: List[Tuple[str, str]], keep_only_ns: bool) -> str:
        out = []
        for k, v in attrs:
            if k == "xmlns" or k.startswith("xmlns:") or local(k) == "schemaLocation":
                if any(ns in v for ns in STANDARD_NS):
                    out.append(f' {k}="{xml_escape(v)}"')
                continue
            if keep_only_ns:
                continue
            lk = local(k).lower()
            val = namer.uri(v) if lk == "uri" else namer.text(v)
            out.append(f' {k}="{xml_escape(val)}"')
        return "".join(out)

    # rebuild the nesting: a tree keyed by each ancestor element
    tree: Dict = {}
    for it in items:
        node = tree
        for anc in it.path:
            node = node.setdefault(anc, {})
        node.setdefault("__items__", []).append(it)

    lines = ['<?xml version="1.0" encoding="UTF-8"?>']

    def emit(node: Dict, depth: int) -> None:
        pad = "  " * depth
        for it in node.get("__items__", []):
            if local(it.qname) == "endpoint":
                lines.append(f"{pad}<{it.qname}{attrs_out(it.attrs, False)}/>")
                continue
            lines.append(f"{pad}<{it.qname}{attrs_out(it.attrs, False)}>")
            for cq, ca in it.children:
                lines.append(f"{pad}  <{cq}{attrs_out(ca, False)}/>")
            lines.append(f"{pad}</{it.qname}>")
        for key, child in node.items():
            if key == "__items__":
                continue
            qname, attrs = key
            lines.append(f"{pad}<{qname}{attrs_out(list(attrs), True)}>")
            emit(child, depth + 1)
            lines.append(f"{pad}</{qname}>")

    roots = [k for k in tree if k != "__items__"]
    if len(roots) != 1 or tree.get("__items__"):
        lines.append('<routes xmlns="http://camel.apache.org/schema/spring">')
        emit(tree, 1)
        lines.append("</routes>")
    else:
        emit(tree, 0)
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# .properties
# ---------------------------------------------------------------------------

def parse_properties(text: str) -> List[Tuple[str, str]]:
    out: List[Tuple[str, str]] = []
    lines = text.lstrip("﻿").splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].lstrip()
        i += 1
        if not line or line[0] in "#!":
            continue
        while re.search(r"(^|[^\\])(\\\\)*\\$", line) and i < len(lines):
            line = line[:-1] + lines[i].lstrip()
            i += 1
        k = 0
        while k < len(line):
            if line[k] == "\\":
                k += 2
            elif line[k] in "=:" or line[k].isspace():
                break
            else:
                k += 1
        key = line[:k].replace("\\", "")
        rest = line[k:].lstrip()
        if rest[:1] in ("=", ":"):
            rest = rest[1:].lstrip()
        if key:
            out.append((key, rest))
    return out


def placeholder_keys(s: str) -> List[str]:
    keys = []
    for m in PLACEHOLDER.finditer(s):
        body = (m.group(1) or m.group(2) or "").strip()
        key = body.split(":", 1)[0]
        if m.group(2) is not None and CAMEL_LANGUAGE.match(key) and ":" in body:
            continue
        keys.append(key)
    return keys


# ---------------------------------------------------------------------------
# pytest
# ---------------------------------------------------------------------------

def is_test_file(rel: str) -> bool:
    return bool(re.search(r"(^|/)(test_[^/]*|[^/]*_test)\.py$", rel))


class StringRenamer(ast.NodeTransformer):
    def __init__(self, namer: Namer) -> None:
        self.namer = namer

    def visit_Constant(self, node: ast.Constant):
        if isinstance(node.value, str):
            return ast.copy_location(ast.Constant(self.namer.text(node.value)), node)
        return node

    def visit_JoinedStr(self, node: ast.JoinedStr):  # f-strings: keep the literal parts only
        parts = [v.value for v in node.values if isinstance(v, ast.Constant) and isinstance(v.value, str)]
        return ast.copy_location(ast.Constant(self.namer.text("{}".join(parts))), node)

    def visit_Name(self, node: ast.Name):
        return ast.copy_location(ast.Name(self.namer.text(node.id), node.ctx), node)

    def visit_Attribute(self, node: ast.Attribute):
        self.generic_visit(node)
        node.attr = self.namer.text(node.attr)
        return node


def dotted(node: ast.AST) -> str:
    if isinstance(node, ast.Call):
        return dotted(node.func)
    if isinstance(node, ast.Attribute):
        return f"{dotted(node.value)}.{node.attr}"
    if isinstance(node, ast.Name):
        return node.id
    return "?"


def rename_test(name: str, namer: Namer, prefix: str) -> str:
    if name.startswith(prefix) and not name.startswith(prefix + "_"):
        return prefix + namer.text(name[len(prefix):])
    return namer.text(name)


def distill_tests(source: str, namer: Namer, stats: Counter, decorators: Counter) -> Optional[str]:
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return None
    renamer = StringRenamer(namer)
    out: List[str] = ["import allure", "import pytest", ""]

    def deco_lines(decos: List[ast.expr], pad: str) -> List[str]:
        lines = []
        for d in decos:
            decorators[namer.text(dotted(d))] += 1
            lines.append(f"{pad}@{ast.unparse(renamer.visit(copy.deepcopy(d)))}")
        return lines

    def dynamic_calls(fn: ast.AST) -> List[str]:
        calls = []
        for n in ast.walk(fn):
            if isinstance(n, ast.Call) and dotted(n).startswith("allure.dynamic."):
                calls.append(ast.unparse(renamer.visit(copy.deepcopy(n))))
        stats["allure.dynamic calls"] += len(calls)
        return calls

    def function(fn, pad: str, method: bool) -> List[str]:
        stats["tests"] += 1
        if fn.decorator_list:
            stats["tests with decorators"] += 1
        lines = [""] + deco_lines(fn.decorator_list, pad)
        kw = "async def" if isinstance(fn, ast.AsyncFunctionDef) else "def"
        lines.append(f"{pad}{kw} {rename_test(fn.name, namer, 'test')}({'self' if method else ''}):")
        body = dynamic_calls(fn)
        lines += [f"{pad}    {c}" for c in body] or [f"{pad}    pass"]
        return lines

    def pytestmark(node: ast.stmt, pad: str) -> List[str]:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "pytestmark" for t in node.targets):
            stats["pytestmark assignments"] += 1
            return [f"{pad}pytestmark = {ast.unparse(renamer.visit(copy.deepcopy(node.value)))}"]
        return []

    for node in tree.body:
        out += pytestmark(node, "")
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test"):
            out += function(node, "", False)
        elif isinstance(node, ast.ClassDef) and node.name.startswith("Test"):
            stats["test classes"] += 1
            out += [""] + deco_lines(node.decorator_list, "") + [f"class {rename_test(node.name, namer, 'Test')}:"]
            body: List[str] = []
            for sub in node.body:
                body += pytestmark(sub, "    ")
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)) and sub.name.startswith("test"):
                    body += function(sub, "    ", True)
            out += body or ["    pass"]
    return "\n".join(out).rstrip() + "\n"


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def walk(root: Path):
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root).as_posix()
        if any(part in SKIP_DIRS for part in rel.split("/")[:-1]) or not p.is_file():
            continue
        yield p, rel


def read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        return p.read_text(encoding="latin-1")


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("repo", type=Path, help="repository root")
    ap.add_argument("-o", "--out", type=Path, default=Path("distilled"), help="output folder (default: ./distilled)")
    ap.add_argument("--zip", action="store_true", help="also write <out>.zip, ready to send")
    ap.add_argument("--force", action="store_true", help="write into a non-empty output folder")
    args = ap.parse_args(argv)
    if sys.version_info < (3, 9):
        print("Python 3.9 or newer is needed", file=sys.stderr)
        return 2
    repo, out = args.repo.resolve(), args.out.resolve()
    if not repo.is_dir():
        print(f"{repo} is not a folder", file=sys.stderr)
        return 2
    if out == repo or repo in out.parents and not args.force:
        print("choose an output folder outside the repo (or pass --force)", file=sys.stderr)
        return 2
    if out.exists() and any(out.iterdir()) and not args.force:
        print(f"{out} is not empty (pass --force to write into it)", file=sys.stderr)
        return 2

    namer = Namer()
    stats: Counter = Counter()
    schemes: Counter = Counter()
    shapes: Counter = Counter()
    decorators: Counter = Counter()
    other_dsl: Counter = Counter()
    written: List[Tuple[str, str]] = []
    xml_items: Dict[str, List[XmlItem]] = {}
    prop_files: Dict[str, List[Tuple[str, str]]] = {}
    test_sources: Dict[str, str] = {}

    for p, rel in walk(repo):
        low = rel.lower()
        if low.endswith(".xml"):
            stats["xml files read"] += 1
            items, stray = scan_xml(read(p))
            stats["<from> outside a <route>"] += stray
            if items:
                xml_items[rel] = items
        elif low.endswith(".properties"):
            prop_files[rel] = parse_properties(read(p))
        elif is_test_file(rel):
            test_sources[rel] = read(p)
        elif low.endswith((".java", ".kt", ".groovy")):
            n = len(re.findall(r"\bfrom[F]?\s*\(\s*\"", read(p)))
            if n:
                other_dsl["Java/Kotlin DSL from(\"…\") calls"] += n
        elif low.endswith((".yaml", ".yml")):
            n = len(re.findall(r"^\s*-?\s*from:\s*$", read(p), re.M))
            if n:
                other_dsl["YAML DSL from: entries"] += n

    # which property keys the route inputs use (and keys those values use), with their option context
    used: Dict[str, str] = {}
    endpoint_uris = []
    for items in xml_items.values():
        for it in items:
            if local(it.qname) == "route":
                stats["routes"] += 1
                if not dict(it.attrs).get("id"):
                    stats["routes without an id"] += 1
                shapes[" > ".join(local(q) for q, _ in it.path) + " > " + local(it.qname)] += 1
                for _, ca in it.children:
                    d = dict(ca)
                    if "uri" in d:
                        endpoint_uris.append(d["uri"])
                    elif "ref" in d:
                        stats["<from ref=…>"] += 1
            else:
                stats["<endpoint> elements"] += 1
                if dict(it.attrs).get("uri"):
                    endpoint_uris.append(dict(it.attrs)["uri"])
    all_props: Dict[str, List[str]] = defaultdict(list)
    for entries in prop_files.values():
        for k, v in entries:
            all_props[k].append(v)
    queue: List[Tuple[str, str]] = []
    for u in endpoint_uris:
        if "{{" in u:
            stats["placeholders {{…}}"] += len(re.findall(r"\{\{", u))
        if "${" in u:
            stats["placeholders ${…}"] += len(re.findall(r"\$\{", u))
        m = re.match(r"^\s*([A-Za-z][\w+.-]*):", u)
        schemes[m.group(1).lower() if m and not u.lstrip().startswith(("{{", "${")) else "(from a property)"] += 1
        _, _, query = u.partition("?")
        for part in query.split("&"):
            k, _, v = part.partition("=")
            queue += [(key, k.lower()) for key in placeholder_keys(v)]
        queue += [(key, "") for key in placeholder_keys(u.partition("?")[0])]
    while queue:
        key, ctx = queue.pop()
        if key in used:
            continue
        used[key] = ctx
        for v in all_props.get(key, []):
            queue += [(k2, ctx) for k2 in placeholder_keys(v)]
    stats["property keys used by routes"] = len(used)
    stats["  of which missing from every .properties file"] = sum(1 for k in used if k not in all_props)
    stats["  of which differ between files"] = sum(1 for k in used if len(set(all_props.get(k, []))) > 1)

    # write
    out.mkdir(parents=True, exist_ok=True)

    def write(rel: str, content: str) -> None:
        target = out / namer.path(rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        written.append((rel, target.relative_to(out).as_posix()))

    for rel, items in xml_items.items():
        write(rel, distill_xml(items, namer))
    for rel, entries in prop_files.items():
        keep = [(k, v) for k, v in entries if k in used]
        if not keep:
            continue
        stats["properties files with used keys"] += 1
        lines = []
        for k, v in keep:
            ctx = used[k]
            if re.match(r"^\s*[A-Za-z][\w+.-]*:", v) and not v.lstrip().startswith(("{{", "${")):
                val = namer.uri(v)
            elif ctx in SECRET_OPTS:
                val = "REDACTED"
            elif ctx in LITERAL_OPTS:
                val = namer.placeholders_only(v)
            else:
                val = namer.text(v, regex=ctx in REGEX_OPTS)
            lines.append(f"{namer.text(k)}={val}")
        write(rel, "\n".join(lines) + "\n")
    unparsable = 0
    for rel, src in test_sources.items():
        stats["test files read"] += 1
        distilled = distill_tests(src, namer, stats, decorators)
        if distilled is None:
            unparsable += 1
            continue
        write(rel, distilled)
    if unparsable:
        stats["test files that did not parse (skipped)"] = unparsable

    report = [
        f"# Distill report (distill_camel_repo.py {VERSION})",
        "",
        "Counts and shapes only. Names below are already replaced.",
        "",
        "## Counts",
        "",
        *[f"- {k}: {v}" for k, v in stats.items()],
        "",
        "## Route input schemes",
        "",
        *[f"- {k}: {v}" for k, v in schemes.most_common()],
        "",
        "## Where routes sit in the XML",
        "",
        *[f"- `{k}`: {v}" for k, v in shapes.most_common()],
        "",
        "## Decorators on tests",
        "",
        *[f"- `@{k}`: {v}" for k, v in decorators.most_common(40)],
    ]
    if other_dsl:
        report += ["", "## Routes in other DSLs (not distilled)", "", *[f"- {k}: {v}" for k, v in other_dsl.items()]]
    (out / "distill-report.md").write_text("\n".join(report) + "\n", encoding="utf-8")

    map_path = out.parent / f"{out.name}.map.json"
    map_path.write_text(json.dumps({"words": namer.words, "files": dict(written)}, indent=2, sort_keys=True), encoding="utf-8")

    if args.zip:
        zip_path = out.parent / f"{out.name}.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(out.rglob("*")):
                if f.is_file():
                    z.write(f, f.relative_to(out).as_posix())
        print(f"wrote {zip_path}")

    print(f"distilled {stats['routes']} routes, {len([1 for k in used])} property keys and {stats['tests']} tests into {out}")
    print(f"report: {out / 'distill-report.md'}")
    print(f"PRIVATE word map (do not share): {map_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
