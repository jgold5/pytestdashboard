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
    python3 distill_camel_repo.py /path/to/camel-repo /path/to/test-repo -o distilled --zip

Give every repo that matters in one run (routes repo and test repo): the renaming is
shared, so test labels still line up with routes. A later run can reuse the renaming
with --map distilled.map.json.

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

VERSION = "1.4"

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
starts with ends contains regex not and or range is camelfilename camelfilenameonly camelfilepath
camelfileparent camelfilerelativepath onlyname noext choice when otherwise
changed markerfile rename filelock idempotent always never
touppercase tolowercase substring substr startswith endswith equals equalsignorecase matches trim strip length indexof replace replaceall split
ini yaml yml cfg toml json py java kt sh ps1 bat cmd sql feature robot md tsv tox pyproject conftest pytest check checks setup
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

    def __init__(self, words: Optional[Dict[str, str]] = None, numbers: Optional[Dict[str, str]] = None) -> None:
        self.words: Dict[str, str] = dict(words or {})
        # long numbers get a stand-in of the same length, the same one everywhere: ids that differ
        # only by a number stay different, and INV_20260101.csv still matches INV_\d{8}.csv
        self.numbers: Dict[str, str] = dict(numbers or {})
        self._next_number: Counter = Counter(len(v) for v in self.numbers.values())

    def number(self, run: str) -> str:
        if len(run) < 4:
            return run
        got = self.numbers.get(run)
        if got is None:
            self._next_number[len(run)] += 1
            got = str(self._next_number[len(run)]).zfill(len(run))[-len(run):]
            self.numbers[run] = got
        return got

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
                out.append(self.number(run))
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


class Node:
    """A kept element inside a route: <from>, <choice>/<when>/<otherwise>/<filter>, <simple> (with its text), and the first <to> of a branch."""

    def __init__(self, qname: str, attrs: List[Tuple[str, str]]):
        self.qname, self.attrs = qname, attrs
        self.children: List["Node"] = []
        self.text: Optional[str] = None

    def walk(self):
        yield self
        for c in self.children:
            yield from c.walk()


class XmlItem:
    def __init__(self, path: Tuple[Tuple[str, Tuple[Tuple[str, str], ...]], ...], node: Node):
        self.path, self.node = path, node

    @property
    def qname(self) -> str:
        return self.node.qname

    @property
    def attrs(self) -> List[Tuple[str, str]]:
        return self.node.attrs


BRANCHES = ("when", "otherwise", "filter")
FILE_REF = re.compile(r"\$\{\s*(file:(name|onlyname|ext)|(in\.)?headers?(\.|\[\s*['\"]?)CamelFileName)", re.I)


def scan_xml(text: str, stats: Counter):
    """Routes (with their inputs and file-name branches) and <endpoint>s, each with its ancestor elements."""
    original = text
    text = re.sub(r"<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>",
                  lambda m: re.sub(r"[^\n]", " ", m.group(0)), text)
    stack: List[Tuple[str, List[Tuple[str, str]], bool]] = []
    items: List[XmlItem] = []
    route: Optional[Node] = None
    kept: List[Node] = []
    for m in TAG.finditer(text):
        closing, qname, rawattrs, selfclosing = m.group(1), m.group(2), m.group(3) or "", m.group(4)
        attrs = [(a.group(1), xml_unescape(a.group(2) if a.group(2) is not None else a.group(3))) for a in ATTR.finditer(rawattrs)]
        name = local(qname)
        if closing:
            if stack and stack[-1][0] == qname:
                _, _, was_kept = stack.pop()
                if was_kept and kept:
                    kept.pop()
            if name in ("route", "routeTemplate"):
                route, kept = None, []
            continue
        if name in ("route", "routeTemplate") and route is None:
            route = Node(qname, attrs)
            items.append(XmlItem(tuple((q, tuple(a)) for q, a, _ in stack), route))
            if not selfclosing:
                stack.append((qname, attrs, False))
            continue
        if route is None:
            if name == "from":
                stats["<from> outside a <route>"] += 1
            elif name == "endpoint":
                items.append(XmlItem(tuple((q, tuple(a)) for q, a, _ in stack), Node(qname, attrs)))
            if not selfclosing:
                stack.append((qname, attrs, False))
            continue
        parent = kept[-1] if kept else route
        keep = name in ("from", "choice", "simple") + BRANCHES or (
            name in ("to", "toD") and local(parent.qname) in BRANCHES
            and not any(local(c.qname) in ("to", "toD") for c in parent.children))
        if name in ("toD", "recipientList", "routingSlip", "dynamicRouter"):
            body = dict(attrs).get("uri", "")
            if name != "toD":
                end = re.search(r"<\s*/\s*(?:[\w.-]+:)?%s\s*>" % name, text[m.end():])
                body = original[m.end():m.end() + end.start()] if end else ""
            if FILE_REF.search(body):
                stats["dynamic routing on the file name (toD/recipientList…)"] += 1
        if keep:
            node = Node(qname, attrs)
            parent.children.append(node)
            if name == "simple" and not selfclosing:
                end = re.search(r"<\s*/\s*(?:[\w.-]+:)?simple\s*>", text[m.end():])
                if end:
                    raw = original[m.end():m.end() + end.start()]
                    node.text = xml_unescape(re.sub(r"^\s*<!\[CDATA\[|\]\]>\s*$", "", raw)).strip()
        if not selfclosing:
            stack.append((qname, attrs, keep))
            if keep:
                kept.append(node)
    return items


def several_patterns(uri: str) -> bool:
    _, _, query = uri.partition("?")
    for part in query.split("&"):
        k, _, v = part.partition("=")
        k = k.lower()
        v = re.sub(r"^RAW\((.*)\)$", r"\1", v)
        if k == "antinclude" and "," in v:
            return True
        if k == "include" and re.search(r"(^|[^\\])\|", re.sub(r"\[[^\]]*\]", "", v)):
            return True
    return False


def route_shapes(items: List[XmlItem], stats: Counter, operators: Counter) -> None:
    for it in items:
        if local(it.qname) not in ("route", "routeTemplate"):
            continue
        nodes = list(it.node.walk())
        froms = [n for n in nodes if local(n.qname) == "from"]
        if len(froms) > 1:
            stats["routes with several <from>"] += 1
        if any(several_patterns(dict(f.attrs).get("uri", "")) for f in froms):
            stats["<from> listing several file patterns"] += 1
        on_name = 0
        for b in nodes:
            if local(b.qname) not in ("when", "filter"):
                continue
            expr = " ".join(c.text or "" for c in b.children if local(c.qname) == "simple")
            if FILE_REF.search(expr):
                on_name += 1
                for op in re.findall(r"(not\s+)?(starts\s+with|startsWith|ends\s+with|endsWith|contains|regex|=~|==|!=|\bin\b)", expr):
                    operators[(op[0] + op[1]).lower().strip()] += 1
            elif expr:
                stats["<when>/<filter> on something other than the file name"] += 1
            else:
                stats["<when>/<filter> without a <simple> expression"] += 1
        if on_name:
            stats["routes with <choice>/<filter> on the file name"] += 1
            stats["  file-name branches in them"] += on_name


def simple_expr(expr: str, namer: Namer) -> str:
    """Rename a Camel simple expression; quoted values after `regex` keep their regex syntax."""
    out = []
    pos = 0
    for m in re.finditer(r"'([^']*)'|\"([^\"]*)\"", expr):
        before = expr[pos:m.start()]
        out.append(namer.text(before))
        lit = m.group(1) if m.group(1) is not None else m.group(2)
        quote = "'" if m.group(1) is not None else '"'
        is_regex = re.search(r"regex\s*$", before, re.I) is not None
        out.append(quote + namer.text(lit, regex=is_regex) + quote)
        pos = m.end()
    out.append(namer.text(expr[pos:]))
    return "".join(out)


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

    tree: Dict = {}
    for it in items:
        node = tree
        for anc in it.path:
            node = node.setdefault(anc, {})
        node.setdefault("__items__", []).append(it)

    lines = ['<?xml version="1.0" encoding="UTF-8"?>']

    def emit_node(n: Node, pad: str) -> None:
        if local(n.qname) == "simple":
            lines.append(f"{pad}<{n.qname}{attrs_out(n.attrs, False)}>{xml_escape(simple_expr(n.text or '', namer))}</{n.qname}>")
        elif n.children:
            lines.append(f"{pad}<{n.qname}{attrs_out(n.attrs, False)}>")
            for c in n.children:
                emit_node(c, pad + "  ")
            lines.append(f"{pad}</{n.qname}>")
        else:
            lines.append(f"{pad}<{n.qname}{attrs_out(n.attrs, False)}/>")

    def emit(node: Dict, depth: int) -> None:
        pad = "  " * depth
        for it in node.get("__items__", []):
            if local(it.qname) == "endpoint":
                lines.append(f"{pad}<{it.qname}{attrs_out(it.attrs, False)}/>")
            else:
                emit_node(it.node, pad)
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
        if m.group(2) is not None and CAMEL_LANGUAGE.match(key):
            continue  # Camel simple/file language (${file:name}, ${header.CamelFileName}), not a property
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

    def body_strings(fn) -> List[str]:
        """Short string literals in the test body (a trigger file it drops, a route id it starts), renamed."""
        found: List[str] = []
        body = fn.body[1:] if fn.body and isinstance(fn.body[0], ast.Expr) and isinstance(getattr(fn.body[0], "value", None), ast.Constant) else fn.body
        for stmt in body:
            for n in ast.walk(stmt):
                if isinstance(n, ast.Call) and dotted(n).startswith("allure.dynamic."):
                    continue
                if isinstance(n, ast.Constant) and isinstance(n.value, str) and n.value.strip() and len(n.value) <= 120 and "\n" not in n.value:
                    v = namer.text(n.value.strip())
                    if v not in found:
                        found.append(v)
        stats["string literals kept from test bodies"] += len(found)
        return found

    def function(fn, pad: str, method: bool) -> List[str]:
        stats["tests"] += 1
        if fn.decorator_list:
            stats["tests with decorators"] += 1
        lines = [""] + deco_lines(fn.decorator_list, pad)
        kw = "async def" if isinstance(fn, ast.AsyncFunctionDef) else "def"
        lines.append(f"{pad}{kw} {rename_test(fn.name, namer, 'test')}({'self' if method else ''}):")
        body = dynamic_calls(fn)
        refs = body_strings(fn)
        if refs:
            body.append(f"_refs = {refs!r}")
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


# ---------------------------------------------------------------------------
# Where the other repos mention triggers
# ---------------------------------------------------------------------------

SEARCH_EXT = (".py", ".yaml", ".yml", ".json", ".csv", ".tsv", ".txt", ".ini", ".cfg", ".toml", ".feature", ".robot",
              ".xml", ".java", ".kt", ".groovy", ".sql", ".sh", ".ps1", ".bat", ".cmd", ".md", ".properties", ".j2", ".tpl")
PYTEST_CONFIG = ("pytest.ini", "tox.ini", "setup.cfg", "pyproject.toml")
REGEX_META = re.compile(r"[\\^$.|?*+()\[\]{}]")


def pytest_config(text: str) -> Dict[str, List[str]]:
    """python_files / python_functions / python_classes / testpaths / markers from a pytest config file."""
    found: Dict[str, List[str]] = defaultdict(list)
    key = None
    for line in text.splitlines():
        m = re.match(r"^\s*(python_files|python_functions|python_classes|testpaths|markers)\s*[=:]\s*(.*)$", line)
        if m:
            key = m.group(1)
            rest = m.group(2).strip().strip("[]")
        elif key and line[:1] in (" ", "\t") and line.strip():
            rest = line.strip()
        else:
            key = None
            continue
        if key == "markers":
            # one marker per line: "name: description" or "name(arg): description"
            for v in re.findall(r"[\"']([^\"']+)[\"']", rest) or [rest]:
                v = v.split(":")[0].split("(")[0].strip()
                if v:
                    found[key].append(v)
            continue
        for v in re.findall(r"[\"']([^\"']+)[\"']", rest) or rest.replace(",", " ").split():
            found[key].append(v)
    return found


def glob_match(name: str, patterns: List[str]) -> bool:
    import fnmatch
    return any(fnmatch.fnmatch(name, pat) for pat in patterns)


class NameFinder:
    """Finds trigger names (route ids, trigger/data file names, file-name conditions) in arbitrary text."""

    def __init__(self, names: Dict[str, str], prefixes: Dict[str, str]):
        self.names, self.prefixes = names, prefixes
        alts = sorted({re.escape(n) for n in names}, key=len, reverse=True)
        palts = sorted({re.escape(n) for n in prefixes}, key=len, reverse=True)
        self.exact = re.compile(r"(?<![A-Za-z0-9])(" + "|".join(alts) + r")(?![A-Za-z0-9])", re.I) if alts else None
        self.prefix = re.compile(r"(?<![A-Za-z0-9])(" + "|".join(palts) + r")", re.I) if palts else None

    def find(self, line: str) -> List[Tuple[str, str]]:
        hits = []
        for rx, table in ((self.exact, self.names), (self.prefix, self.prefixes)):
            if rx is None:
                continue
            for m in rx.finditer(line):
                key = m.group(1).lower()
                kind = table.get(key)
                if kind:
                    hits.append((m.group(1), kind))
        return hits


def trigger_names(xml_items: Dict[str, List["XmlItem"]], all_props: Dict[str, List[str]]):
    """Names a test could use for a trigger, from the production routes (src/test XML is skipped)."""
    names: Dict[str, str] = {}
    prefixes: Dict[str, str] = {}

    def add(value: str, kind: str, table: Optional[Dict[str, str]] = None) -> None:
        v = value.strip()
        low = v.lower()
        if len(v) < 4 or low in KEEP_WORDS or v.isdigit() or "{{" in v or "${" in v:
            return
        (names if table is None else table).setdefault(low, kind)

    def values(v: str) -> List[str]:
        m = re.fullmatch(r"\s*\{\{([^{}:]+)(?::[^{}]*)?\}\}\s*", v)
        if m:
            return list(dict.fromkeys(all_props.get(m.group(1), [])))
        return [PLACEHOLDER.sub(lambda x: (all_props.get((x.group(1) or x.group(2) or "").split(":")[0]) or [x.group(0)])[0], v)]

    def add_pattern(v: str, kind: str) -> None:
        v = re.sub(r"^RAW\((.*)\)$", r"\1", v.strip())
        for alt in re.split(r"[,|]", v):
            alt = alt.strip().strip("()")
            if not alt:
                continue
            if REGEX_META.search(alt.replace("\\.", "")) is None:
                add(alt.replace("\\.", "."), kind)
            else:
                lit = re.match(r"[A-Za-z0-9_\-]+", alt)
                if lit:
                    add(lit.group(0), kind + " (prefix)", prefixes)

    for rel, items in xml_items.items():
        if re.search(r"(^|/)src/test/", rel):
            continue
        for it in items:
            if local(it.qname) not in ("route", "routeTemplate"):
                continue
            rid = dict(it.attrs).get("id")
            if rid:
                add(rid, "route id")
            for n in it.node.walk():
                if local(n.qname) == "from":
                    _, _, query = dict(n.attrs).get("uri", "").partition("?")
                    for part in query.split("&"):
                        k, _, v = part.partition("=")
                        k = k.lower()
                        if k in ("filename", "donefilename", "include", "antinclude"):
                            kind = {"filename": "data file", "donefilename": "trigger file"}.get(k, "file pattern")
                            for val in values(v):
                                if k in ("filename", "donefilename"):
                                    for chunk in re.split(r"\$\{[^}]*\}", val):
                                        add(chunk, kind) if chunk == val else add(chunk, kind + " (part)", prefixes)
                                else:
                                    add_pattern(val, kind)
                elif local(n.qname) == "simple" and n.text and FILE_REF.search(n.text):
                    for lit in re.findall(r"'([^']*)'|\"([^\"]*)\"", n.text):
                        for val in values(lit[0] or lit[1]):
                            for one in val.split(","):
                                add(one, "file-name condition")
    return names, prefixes


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("repos", type=Path, nargs="+", help="repository root(s): the Camel repo and the test repo")
    ap.add_argument("-o", "--out", type=Path, default=Path("distilled"), help="output folder (default: ./distilled)")
    ap.add_argument("--zip", action="store_true", help="also write <out>.zip, ready to send")
    ap.add_argument("--force", action="store_true", help="write into a non-empty output folder")
    ap.add_argument("--map", type=Path, help="reuse the renaming from an earlier run's .map.json (so a later run lines up with it)")
    args = ap.parse_args(argv)
    if sys.version_info < (3, 9):
        print("Python 3.9 or newer is needed", file=sys.stderr)
        return 2
    repos, out = [r.resolve() for r in args.repos], args.out.resolve()
    for repo in repos:
        if not repo.is_dir():
            print(f"{repo} is not a folder", file=sys.stderr)
            return 2
        if (out == repo or repo in out.parents) and not args.force:
            print("choose an output folder outside the repos (or pass --force)", file=sys.stderr)
            return 2
    if out.exists() and any(out.iterdir()) and not args.force:
        print(f"{out} is not empty (pass --force to write into it)", file=sys.stderr)
        return 2

    previous: Dict = {}
    if args.map:
        try:
            previous = json.loads(args.map.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            print(f"cannot read {args.map}: {e}", file=sys.stderr)
            return 2
    namer = Namer(previous.get("words"), previous.get("numbers"))
    stats: Counter = Counter()
    schemes: Counter = Counter()
    shapes: Counter = Counter()
    decorators: Counter = Counter()
    other_dsl: Counter = Counter()
    written: List[Tuple[str, str]] = []
    xml_items: Dict[str, List[XmlItem]] = {}
    prop_files: Dict[str, List[Tuple[str, str]]] = {}
    test_sources: Dict[str, str] = {}

    # several repos: each goes in its own (renamed) top folder
    prefixes: Dict[Path, str] = {}
    for repo in repos:
        name = repo.name if len(repos) > 1 else ""
        while name and name in prefixes.values():
            name += "_"
        prefixes[repo] = name

    def all_files():
        for repo in repos:
            for p, rel in walk(repo):
                yield p, f"{prefixes[repo]}/{rel}" if prefixes[repo] else rel

    configs: Dict[str, Dict[str, List[str]]] = {}
    for p, rel in all_files():
        if p.name in PYTEST_CONFIG:
            cfg = pytest_config(read(p))
            if cfg:
                configs[rel] = cfg
    python_files = [pat for cfg in configs.values() for pat in cfg.get("python_files", [])]
    for pat in python_files:
        KEEP_WORDS.update(w.lower() for w in re.findall(r"[A-Za-z]+", pat))
    py_inventory: Counter = Counter()

    for p, rel in all_files():
        low = rel.lower()
        if low.endswith(".py"):
            base = p.name
            py_inventory["test_*.py" if base.startswith("test_") else "*_test.py" if base.endswith("_test.py")
                         else "conftest.py" if base == "conftest.py" else "other .py"] += 1
        if low.endswith(".xml"):
            stats["xml files read"] += 1
            items = scan_xml(read(p), stats)
            if items:
                xml_items[rel] = items
        elif low.endswith(".properties"):
            prop_files[rel] = parse_properties(read(p))
        elif is_test_file(rel) or (low.endswith(".py") and python_files and glob_match(p.name, python_files)):
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
    operators: Counter = Counter()
    for items in xml_items.values():
        route_shapes(items, stats, operators)
    for items in xml_items.values():
        for it in items:
            if local(it.qname) == "route":
                stats["routes"] += 1
                if not dict(it.attrs).get("id"):
                    stats["routes without an id"] += 1
                shapes[" > ".join(local(q) for q, _ in it.path) + " > " + local(it.qname)] += 1
                for n in it.node.walk():
                    if local(n.qname) == "from":
                        d = dict(n.attrs)
                        if "uri" in d:
                            endpoint_uris.append(d["uri"])
                        elif "ref" in d:
                            stats["<from ref=…>"] += 1
                    elif local(n.qname) == "simple" and n.text:
                        endpoint_uris.append("simple:?x=" + n.text)
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

    # where do the other files (test repo, Java tests, data files) mention triggers?
    names, prefixes_found = trigger_names(xml_items, all_props)
    finder = NameFinder(names, prefixes_found)
    route_files = {rel for rel in xml_items if not re.search(r"(^|/)src/test/", rel)} | set(prop_files)
    refs = []
    by_ext: Counter = Counter()
    by_folder: Counter = Counter()
    by_context: Counter = Counter()
    by_kind: Counter = Counter()
    mentioned: Set[str] = set()
    for p, rel in all_files():
        if rel in route_files or not rel.lower().endswith(SEARCH_EXT) or p.stat().st_size > 2_000_000:
            continue
        text = read(p)
        hits = []
        current_test = None
        test_indent = -1
        for no, line in enumerate(text.splitlines(), 1):
            if rel.endswith(".py"):
                dm = re.match(r"^(\s*)(?:async\s+)?def\s+(\w+)", line)
                if dm:
                    current_test, test_indent = (dm.group(2), len(dm.group(1))) if dm.group(2).startswith("test") else (None, -1)
                elif current_test and line.strip() and len(line) - len(line.lstrip()) <= test_indent:
                    current_test = None
            found = finder.find(line)
            if not found:
                continue
            stripped = line.strip()
            if not rel.endswith(".py"):
                context = "data/other file"
            elif "parametrize" in stripped:
                context = "parametrize"
            elif stripped.startswith("@") or stripped.startswith("pytestmark"):
                context = "decorator / marker"
            elif current_test:
                context = "inside a test"
            else:
                context = "module level / helper"
            for value, kind in found:
                mentioned.add(value.lower())
                by_kind[kind] += 1
            by_context[context] += 1
            if len(hits) < 200:
                hits.append({"line": no, "context": context, "test": namer.text(current_test) if current_test and rel.endswith(".py") else None,
                             "names": sorted({namer.text(v) for v, _ in found}), "kinds": sorted({k for _, k in found})})
        if hits:
            ext = Path(rel).suffix.lower() or "(none)"
            by_ext[ext] += 1
            by_folder["/".join(namer.text(x) for x in rel.split("/")[:3])] += 1
            refs.append({"file": namer.path(rel), "hits": hits, "mentions": len(hits)})
    refs.sort(key=lambda r: -r["mentions"])
    (out / "trigger-references.json").write_text(json.dumps({"names_known": len(names) + len(prefixes_found),
                                                               "names_mentioned": len(mentioned), "files": refs}, indent=1), encoding="utf-8")

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
        *[f"- {k}: {v}" for k, v in schemes.most_common() if k != "simple"],
        "",
        "## Several triggers in one route",
        "",
        *[f"- {k}: {stats.get(k, 0)}" for k in ("routes with several <from>", "<from> listing several file patterns",
                                                 "routes with <choice>/<filter> on the file name", "  file-name branches in them",
                                                 "dynamic routing on the file name (toD/recipientList…)")],
        *([f"- operators in file-name conditions: " + ", ".join(f"`{k}` {v}" for k, v in operators.most_common())] if operators else []),
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
    report += [
        "",
        "## Python files",
        "",
        *[f"- {k}: {v}" for k, v in py_inventory.most_common()],
        *[f"- pytest config `{namer.path(rel)}`: " + "; ".join(f"{k} = {', '.join(namer.text(v) if k == 'markers' else v for v in vs)}" for k, vs in cfg.items())
          for rel, cfg in configs.items()],
        "",
        "## Where trigger names appear outside the routes",
        "",
        f"- trigger names known from the routes: {len(names) + len(prefixes_found)} (route ids, data/trigger file names, patterns, file-name conditions)",
        f"- of which mentioned somewhere else: {len(mentioned)}",
        f"- files mentioning them: {len(refs)} (details in trigger-references.json)",
        "",
        "By file type:",
        *[f"- `{k}`: {v} files" for k, v in by_ext.most_common()],
        "",
        "By folder:",
        *[f"- `{k}`: {v} files" for k, v in by_folder.most_common(20)],
        "",
        "Where in the file:",
        *[f"- {k}: {v} lines" for k, v in by_context.most_common()],
        "",
        "What is mentioned:",
        *[f"- {k}: {v}" for k, v in by_kind.most_common()],
        "",
        "Files with the most mentions:",
        *[f"- `{r['file']}`: {r['mentions']} lines" for r in refs[:15]],
    ]
    (out / "distill-report.md").write_text("\n".join(report) + "\n", encoding="utf-8")

    map_path = out.parent / f"{out.name}.map.json"
    map_path.write_text(json.dumps({"words": namer.words, "numbers": namer.numbers, "files": {**previous.get("files", {}), **dict(written)}},
                                   indent=2, sort_keys=True), encoding="utf-8")

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
