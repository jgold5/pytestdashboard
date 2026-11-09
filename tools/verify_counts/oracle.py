#!/usr/bin/env python3
"""
Independent oracle for the pytest dashboard's Camel route trigger counter.

Written from the spec (Camel / Java .properties / pytest semantics), NOT by porting
apps/server/src/triggers/scan.ts. Standard library only (expat for XML, ast for Python).

Usage:
    python3 oracle.py <repo-dir>            # JSON: triggers, otherRoutes, tests
    python3 oracle.py <repo-dir> --summary  # human-readable counts per kind / coverage

Files are classified like an upload: *.xml (not under src/test/) = Camel XML,
*.properties = properties, *.py = pytest files. Paths are repo-relative, '/'-separated,
processed in sorted order (that order decides the "first value" of an ambiguous property).

Where real Camel/pytest semantics and the dashboard's documented rules could differ,
the choice made here is marked "SEMANTICS:".
"""
from __future__ import annotations

import ast
import json
import os
import re
import sys
import xml.parsers.expat
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import unquote_plus

# ---------------------------------------------------------------------------
# Java .properties
# ---------------------------------------------------------------------------

_WS = ' \t\f'


def _java_unescape(s: str) -> str:
    out = []
    i = 0
    while i < len(s):
        c = s[i]
        if c == '\\' and i + 1 < len(s):
            n = s[i + 1]
            if n == 'u' and re.fullmatch(r'[0-9a-fA-F]{4}', s[i + 2:i + 6] or ''):
                out.append(chr(int(s[i + 2:i + 6], 16)))
                i += 6
                continue
            out.append({'t': '\t', 'n': '\n', 'r': '\r', 'f': '\f'}.get(n, n))
            i += 2
            continue
        if c == '\\':  # lone trailing backslash
            i += 1
            continue
        out.append(c)
        i += 1
    return ''.join(out)


def parse_properties(text: str) -> dict[str, str]:
    """java.util.Properties.load semantics (later definitions in one file win)."""
    if text.startswith('﻿'):
        text = text[1:]
    lines = re.split(r'\r\n|\r|\n', text)
    out: dict[str, str] = {}
    i = 0
    while i < len(lines):
        line = lines[i].lstrip(_WS)
        i += 1
        if not line or line[0] in '#!':
            continue
        # logical line: an odd number of trailing backslashes continues it
        while True:
            m = re.search(r'(\\*)$', line)
            if m and len(m.group(1)) % 2 == 1 and i < len(lines):
                line = line[:-1] + lines[i].lstrip(_WS)
                i += 1
            else:
                break
        k = 0
        key_chars = []
        while k < len(line):
            c = line[k]
            if c == '\\' and k + 1 < len(line):
                key_chars.append(line[k:k + 2])
                k += 2
                continue
            if c in '=:' or c in _WS:
                break
            key_chars.append(c)
            k += 1
        key = _java_unescape(''.join(key_chars))
        rest = line[k:].lstrip(_WS)
        if rest[:1] in ('=', ':'):
            rest = rest[1:].lstrip(_WS)
        if key:
            out[key] = _java_unescape(rest)
    return out


def module_of(path: str) -> Optional[str]:
    """SEMANTICS (dashboard doc): the folder directly under `resources/`, else the file's folder."""
    segs = path.split('/')
    if 'resources' in segs:
        r = len(segs) - 1 - segs[::-1].index('resources')
        return segs[r + 1] if r + 2 < len(segs) else None
    return '/'.join(segs[:-1]) if len(segs) > 1 else None


class Properties:
    def __init__(self, files: list[tuple[str, str]]):
        # key -> [(file, value)] in file order
        self.defs: dict[str, list[tuple[str, str]]] = {}
        for path, text in files:
            for k, v in parse_properties(text).items():
                self.defs.setdefault(k, []).append((path, v))

    def values(self, key: str, near: str) -> list[str]:
        """Distinct values that apply to a route file, in file order.

        SEMANTICS: a module's own properties files win; then shared files in an ancestor
        folder of the route file (the deepest one); properties of a *sibling* module never
        apply to another module's routes (Camel/Spring only loads its own context's files).
        Falls back to every definition when none applies (keeps the oracle lenient)."""
        defs = self.defs.get(key)
        if not defs:
            return []
        if len(defs) > 1:
            rmod = module_of(near)
            rdir = near.split('/')[:-1]
            own = [d for d in defs if rmod is not None and module_of(d[0]) == rmod and _under_resources(d[0])]
            if own:
                defs = own
            else:
                anc = []
                for d in defs:
                    pdir = d[0].split('/')[:-1]
                    if rdir[:len(pdir)] == pdir:
                        anc.append((len(pdir), d))
                if anc:
                    best = max(n for n, _ in anc)
                    defs = [d for n, d in anc if n == best]
        seen = []
        for _, v in defs:
            if v not in seen:
                seen.append(v)
        return seen


def _under_resources(path: str) -> bool:
    segs = path.split('/')
    return 'resources' in segs and module_of(path) is not None


PH = re.compile(r'\{\{([^{}]+)\}\}|\$\{([^{}]+)\}')
CAMEL_FUNC_CURLY = ('env:', 'sys:', 'sysenv:', 'bean:', 'ref:', 'service:', 'service.host:', 'service.port:')
# Camel simple/file language inside ${...} (not a property): functions with ':' / '(' arguments,
# header/body/exchangeProperty accessors and bare built-ins
SIMPLE_LANG = re.compile(
    r'^(?:(?:date|date-with-timezone|file|bean|ref|properties|type|random|env|sysenv|sys|bodyAs|mandatoryBodyAs|headerAs|'
    r'exchangePropertyAs|variableAs|messageAs|collate|skip|join|replace|substring|header|headers|exchangeProperty|variable)\s*[:(]'
    r'|(?:header|headers|exchangeProperty|body|sys|sysenv|env|exception|variable|variables|in\.header|in\.headers|in\.body|'
    r'out\.header|out\.headers|out\.body)\s*(?:[.\[(]|$)'
    r'|(?:exchangeId|id|messageTimestamp|camelId|camelContext|routeId|uuid|body|exception|exchange|threadName|threadId|'
    r'hostName|hostname|stepId|routeGroup|fromRouteId|null|empty)\s*$)')


@dataclass
class Res:
    text: str          # only single-valued placeholders filled in
    first: str         # ambiguous ones filled with their first value
    ambiguous: bool


def resolve(s: str, props: Properties, near: str) -> Res:
    amb = [False]

    def fill(t: str, first: bool, depth: int) -> str:
        if depth > 6:
            return t

        def rep(m: re.Match) -> str:
            curly = m.group(1) is not None
            body = (m.group(1) if curly else m.group(2)).strip()
            if curly:
                if body.startswith(CAMEL_FUNC_CURLY):
                    # SEMANTICS: {{env:NAME}}, {{sys:NAME}} … are Camel property *functions*;
                    # the oracle can't know the environment, so only a default fills them.
                    parts = body.split(':', 2)
                    return fill(parts[2], first, depth + 1) if len(parts) == 3 else m.group(0)
                key, sep, default = body.partition(':')
                vals = props.values(key, near)
                if not vals:
                    return fill(default, first, depth + 1) if sep else m.group(0)
            else:
                if SIMPLE_LANG.match(body):
                    return m.group(0)  # Camel simple/file language, not a property
                # SEMANTICS: Spring placeholder ${key} / ${key:default}
                key, sep, default = body.partition(':')
                vals = props.values(key, near)
                if not vals:
                    return fill(default, first, depth + 1) if sep else m.group(0)
            if len(vals) == 1:
                return fill(vals[0], first, depth + 1)
            amb[0] = True
            return fill(vals[0], first, depth + 1) if first else m.group(0)

        return PH.sub(rep, t)

    return Res(fill(s, False, 0), fill(s, True, 0), amb[0])


# ---------------------------------------------------------------------------
# Endpoint URIs
# ---------------------------------------------------------------------------

KIND_BY_SCHEME = {}
for s_ in ('file', 'ftp', 'ftps', 'sftp', 'smb'):
    KIND_BY_SCHEME[s_] = 'file'
for s_ in ('quartz', 'quartz2', 'cron', 'timer', 'scheduler'):
    KIND_BY_SCHEME[s_] = 'schedule'
for s_ in ('direct', 'direct-vm'):
    KIND_BY_SCHEME[s_] = 'direct'
for s_ in ('seda', 'vm', 'jms', 'activemq', 'amqp', 'sjms', 'sjms2'):
    KIND_BY_SCHEME[s_] = 'queue'
KIND_BY_SCHEME['kafka'] = 'kafka'
for s_ in ('rest', 'restlet', 'netty-http', 'netty4-http', 'jetty', 'servlet', 'platform-http', 'undertow', 'http', 'https'):
    KIND_BY_SCHEME[s_] = 'rest'


def kind_of(scheme: str) -> Optional[str]:
    s = scheme.lower()
    if s in KIND_BY_SCHEME:
        return KIND_BY_SCHEME[s]
    if s.startswith('jms'):
        return 'queue'
    return None


@dataclass
class Endpoint:
    scheme: str
    path: str
    params: dict


def _decode_param(v: str) -> str:
    m = re.fullmatch(r'RAW\((.*)\)', v, re.S) or re.fullmatch(r'RAW\{(.*)\}', v, re.S)
    if m:
        return m.group(1)
    # SEMANTICS: Camel URL-decodes option values ('+' becomes a space) unless RAW(...)
    try:
        return unquote_plus(v, errors='strict')
    except Exception:
        return v.replace('+', ' ')


def parse_uri(uri: str) -> Optional[Endpoint]:
    m = re.match(r'\s*([A-Za-z][A-Za-z0-9_+.\-]*):(.*)\Z', uri, re.S)
    if not m:
        return None
    rest = m.group(2)
    if rest.startswith('//'):
        rest = rest[2:]
    path, _, query = rest.partition('?')
    params = {}
    if query:
        for part in query.split('&'):
            if not part:
                continue
            k, eq, v = part.partition('=')
            if k and k not in params:
                params[k] = _decode_param(v) if eq else ''
    return Endpoint(m.group(1).lower(), path, params)


ONLY_PLACEHOLDER = re.compile(r'\s*(?:\{\{([^{}]+)\}\}|\$\{([^{}]+)\})\s*(\?.*)?\Z', re.S)


def guess_scheme_from_key(key: str) -> Optional[str]:
    """SEMANTICS (dashboard doc): the key names the protocol as a word: invoice.sftp.url, invoiceSftpUri, env:SFTP_URL."""
    words = re.split(r'[^a-z0-9]+', re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', key).lower())
    for w in ('sftp', 'ftps', 'ftp', 'smb'):
        if w in words:
            return w
    return None


# ---------------------------------------------------------------------------
# XML (expat, with line numbers)
# ---------------------------------------------------------------------------

@dataclass
class El:
    tag: str
    attrs: dict
    line: int
    children: list = field(default_factory=list)
    text: str = ''
    parent: 'El | None' = None

    def iter(self):
        yield self
        for c in self.children:
            yield from c.iter()


def parse_xml(text: str) -> Optional[El]:
    p = xml.parsers.expat.ParserCreate(namespace_separator='}')
    root = El('#doc', {}, 0)
    stack = [root]

    def local(n: str) -> str:
        n = n.split('}')[-1]
        return n.split(':')[-1]

    def start(name, attrs):
        e = El(local(name), {local(k): v for k, v in attrs.items()}, p.CurrentLineNumber, parent=stack[-1])
        stack[-1].children.append(e)
        stack.append(e)

    def end(name):
        stack.pop()

    def chars(data):
        stack[-1].text += data

    p.StartElementHandler = start
    p.EndElementHandler = end
    p.CharacterDataHandler = chars
    try:
        p.Parse(text.encode('utf-8'), True)
    except xml.parsers.expat.ExpatError as e:
        print(f'oracle: XML parse error: {e}', file=sys.stderr)
        return None
    return root


# ---------------------------------------------------------------------------
# File-name conditions in <when>/<filter> (Camel simple language)
# ---------------------------------------------------------------------------

FILE_REF = (r'\$\{\s*(?P<ref>file:(?:only)?name(?:\.noext)?(?:\.single)?|file:ext(?:\.single)?|file:name\.ext(?:\.single)?|'
            r'(?:in\.)?headers?(?:\.|:|\[\s*[\'"]?)CamelFileName(?:Only)?(?:[\'"]?\s*\])?)\s*\}')
# Camel 2 ("not contains") and Camel 3/4 ("!contains", "~~") operator spellings
OPS = [
    (r'§startsci', 'starts', False, True), (r'§endsci', 'ends', False, True),
    (r'not\s+starts\s+with', 'starts', True, False), (r'!startsWith', 'starts', True, False),
    (r'starts\s+with', 'starts', False, False), (r'startsWith', 'starts', False, False),
    (r'not\s+ends\s+with', 'ends', True, False), (r'!endsWith', 'ends', True, False),
    (r'ends\s+with', 'ends', False, False), (r'endsWith', 'ends', False, False),
    (r'not\s+contains', 'contains', True, False), (r'!contains', 'contains', True, False),
    (r'!~~', 'contains', True, True), (r'~~', 'contains', False, True),
    (r'contains', 'contains', False, False),
    (r'not\s+regex', 'regex', True, False), (r'!regex', 'regex', True, False), (r'regex', 'regex', False, False),
    (r'!=~', 'eq', True, True), (r'=~', 'eq', False, True), (r'==', 'eq', False, False), (r'!=', 'eq', True, False),
    (r'not\s+in', 'in', True, False), (r'!in', 'in', True, False), (r'in', 'in', False, False),
]
ATOM_RE = re.compile(FILE_REF + r'\s*(?P<op>' + '|'.join(o[0] for o in OPS) + r')\s*(?:\'(?P<v1>[^\']*)\'|"(?P<v2>[^"]*)")', re.I)
JAVA_CALL_RE = re.compile(r'\$\{\s*(?P<base>(?:in\.)?headers?(?:\.|\[\s*[\'"]?)CamelFileName(?:Only)?(?:[\'"]?\s*\])?|file:(?:only)?name(?:\.noext)?)'
                          r'(?P<chain>(?:\.\w+\((?:[^()\'"]|\'[^\']*\'|"[^"]*")*\))+)\s*\}', re.I)


@dataclass
class Atom:
    part: str      # name | onlyname | noext | ext
    op: str        # starts | ends | contains | regex | eq | in
    value: str
    negate: bool
    ci: bool


def _part(ref: str) -> str:
    r = ref.lower()
    if r in ('file:ext', 'file:name.ext'):
        return 'ext'
    if r in ('file:ext.single', 'file:name.ext.single'):
        return 'ext1'
    if r.endswith('.noext'):
        return 'noext'
    if r.endswith('.noext.single'):
        return 'noext1'
    if r.startswith('file:onlyname') or r.endswith('fileonly') or r.endswith("fileonly']") or 'camelfilenameonly' in r:
        return 'onlyname'
    return 'name'


def _java_calls(expr: str) -> str:
    """${header.CamelFileName.toUpperCase().endsWith('.GZ')} → an equivalent simple-language atom."""
    def rep(m):
        base = m.group('base')
        ci = False
        sub = False
        for cm in re.finditer(r'\.(\w+)\(((?:[^()\'"]|\'[^\']*\'|"[^"]*")*)\)', m.group('chain')):
            name = cm.group(1).lower()
            arg = re.fullmatch(r'\s*(?:\'([^\']*)\'|"([^"]*)")\s*', cm.group(2))
            val = (arg.group(1) if arg.group(1) is not None else arg.group(2)) if arg else None
            if name in ('touppercase', 'tolowercase'):
                ci = True
            elif name in ('substring', 'substr', 'trim'):
                sub = sub or name != 'trim'
            elif name in ('startswith', 'endswith', 'contains', 'equals', 'equalsignorecase', 'matches') and val is not None:
                op = {'startswith': 'startsWith', 'endswith': 'endsWith', 'contains': 'contains',
                      'equals': '==', 'equalsignorecase': '=~', 'matches': 'regex'}[name]
                if sub and op != 'regex':
                    op = 'contains'
                if ci and op in ('startsWith', 'endsWith', 'contains', '=='):
                    op = {'startsWith': 'startsWith', 'endsWith': 'endsWith', 'contains': '~~', '==': '=~'}[op]
                    # ci on starts/ends: keep op, mark via a sentinel the parser understands
                    if op in ('startsWith', 'endsWith'):
                        return '${%s} %s \'%s\'' % (base, '§startsci' if op == 'startsWith' else '§endsci', val)
                return '${%s} %s \'%s\'' % (base, op, val)
        return '${%s}%s' % (base, ' §substring§' if sub else '')
    out = JAVA_CALL_RE.sub(rep, expr)
    out = re.sub(r'§substring§\s*(==|=~|starts\s+with|startsWith|ends\s+with|endsWith|contains)', 'contains', out, flags=re.I)
    return out.replace('§substring§', '')


def parse_condition(expr: str) -> Optional[list[list[Atom]]]:
    """OR of AND groups of atoms on the file name; None when the expression doesn't test the file name."""
    e = re.sub(r'\$\{\s*properties:([^}:]+)(?::[^}]*)?\}', r"'{{\1}}'", expr)
    e = _java_calls(e)
    groups = []
    for orp in re.split(r'\|\||\s+or\s+', e, flags=re.I):
        atoms = []
        for andp in re.split(r'&&|\s+and\s+', orp, flags=re.I):
            for m in ATOM_RE.finditer(andp):
                raw_op = m.group('op')
                for pat, op, neg, ci in OPS:
                    if re.fullmatch(pat, raw_op, re.I):
                        val = m.group('v1') if m.group('v1') is not None else m.group('v2')
                        atoms.append(Atom(_part(m.group('ref')), op, val, neg, ci))
                        break
        if atoms:
            groups.append(atoms)
    return groups or None


def _name_part(fname: str, part: str) -> str:
    only = fname.rsplit('/', 1)[-1]
    if part == 'ext':
        # SEMANTICS: Camel's file:ext is everything after the first dot of the name
        return only.split('.', 1)[1] if '.' in only[1:] else ''
    if part == 'noext':
        return only.split('.', 1)[0] if '.' in only[1:] else only
    # SEMANTICS: Camel's *.single variants strip/return only the last extension
    if part == 'ext1':
        return only.rsplit('.', 1)[1] if '.' in only[1:] else ''
    if part == 'noext1':
        return only.rsplit('.', 1)[0] if '.' in only[1:] else only
    return only if part == 'onlyname' else fname


def condition_matches(groups: list[list[Atom]], fname: str) -> bool:
    def atom_ok(a: Atom) -> bool:
        v = _name_part(fname, a.part)
        x = a.value
        if a.ci:
            v, x = v.lower(), x.lower()
        if a.op == 'starts':
            hit = v.startswith(x)
        elif a.op == 'ends':
            hit = v.endswith(x)
        elif a.op == 'contains':
            hit = x in v
        elif a.op == 'regex':
            try:
                hit = re.fullmatch(a.value, _name_part(fname, a.part)) is not None
            except re.error:
                hit = False
        elif a.op == 'in':
            hit = v in [y.strip() for y in x.split(',')]
        else:
            hit = v == x
        return hit != a.negate
    return any(all(atom_ok(a) for a in g) for g in groups)


# ---------------------------------------------------------------------------
# File patterns: include= (Java regex), antInclude= (Ant globs), fileName= (file language)
# ---------------------------------------------------------------------------

MAX_ALTS = 20


def _alternatives(re_s: str) -> list[str]:
    """Split on '|' at nesting depth 0 (outside groups and character classes)."""
    parts, cur, depth, in_cls, i = [], '', 0, False, 0
    while i < len(re_s):
        c = re_s[i]
        if c == '\\':
            cur += re_s[i:i + 2]
            i += 2
            continue
        if in_cls:
            if c == ']':
                in_cls = False
        elif c == '[':
            in_cls = True
        elif c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
        elif c == '|' and depth == 0:
            parts.append(cur)
            cur = ''
            i += 1
            continue
        cur += c
        i += 1
    parts.append(cur)
    return parts


def _expand(re_s: str, out: list[str], limit: int) -> bool:
    """Expand top-level alternatives and the first un-quantified flat group (A|B) / (?:A|B). False if over the limit."""
    alts = _alternatives(re_s)
    if len(alts) > 1:
        return all(_expand(a, out, limit) for a in alts)
    i, in_cls = 0, False
    while i < len(re_s):
        c = re_s[i]
        if c == '\\':
            i += 2
            continue
        if in_cls:
            in_cls = c != ']'
            i += 1
            continue
        if c == '[':
            in_cls = True
            i += 1
            continue
        if c == '(' and (not re_s.startswith('(?', i) or re_s.startswith('(?:', i)):
            body_start = i + 3 if re_s.startswith('(?:', i) else i + 1
            j, cls2, flat = body_start, False, True
            while j < len(re_s):
                d = re_s[j]
                if d == '\\':
                    j += 2
                    continue
                if cls2:
                    cls2 = d != ']'
                elif d == '[':
                    cls2 = True
                elif d == '(':
                    flat = False
                    break
                elif d == ')':
                    break
                j += 1
            if flat and j < len(re_s):
                inner = _alternatives(re_s[body_start:j])
                quant = re_s[j + 1:j + 2]
                if len(inner) > 1 and quant not in ('*', '+', '?', '{'):
                    return all(_expand(re_s[:i] + a + re_s[j + 1:], out, limit) for a in inner)
        i += 1
    out.append(re_s)
    return len(out) <= limit * 2


def split_patterns(pattern: str, kind: str) -> list[str]:
    if kind == 'name' or '{{' in pattern or '${' in pattern:
        return [pattern]
    if kind == 'glob':
        parts = [p.strip() for p in pattern.split(',')]
    else:
        parts = []
        if not _expand(pattern, parts, MAX_ALTS):
            return [pattern]
    uniq = []
    for p in parts:
        if p and p not in uniq:
            uniq.append(p)
    return uniq if 1 < len(uniq) <= MAX_ALTS else [pattern]


def _java_regex(p: str, ci: bool):
    try:
        return re.compile(p, re.I if ci else 0)
    except re.error:
        return None


def _ant_regex(glob: str):
    alts = []
    for g in glob.split(','):
        g = g.strip()
        out, i = '', 0
        while i < len(g):
            if g.startswith('**/', i):
                out += '(?:.*/)?'
                i += 3
            elif g.startswith('**', i):
                out += '.*'
                i += 2
            elif g[i] == '*':
                out += '[^/]*'
                i += 1
            elif g[i] == '?':
                out += '[^/]'
                i += 1
            else:
                out += re.escape(g[i])
                i += 1
        alts.append(out)
    # SEMANTICS: Camel's antFilterCaseSensitive defaults to true
    return re.compile('(?:' + '|'.join(alts) + ')')


def _file_language_regex(p: str):
    parts = re.split(r'\$\{[^}]*\}', p)
    try:
        return re.compile('.*'.join(re.escape(x) for x in parts))
    except re.error:
        return None


PROBE_BASES = ['k3j_unrelated', 'RANDOM-NAME', 'notes']
PROBE_EXTS = ['bin', 'DAT', 'txt']


def _probes(texts) -> list[str]:
    """Made-up file names, also with each extension the patterns mention: a tester that accepts
    several of them says nothing specific (include=.*, antInclude=*.csv, ends with '.csv')."""
    exts = set()
    for t in texts:
        plain = (t or '').replace('\\', '')
        exts.update(e.lower() for e in re.findall(r'\.([A-Za-z0-9]{1,8})(?![A-Za-z0-9])', plain))
        for grp in re.findall(r'\.\((?:\?:)?([A-Za-z0-9|]+)\)', plain):
            exts.update(e.lower() for e in grp.split('|') if e)
        exts.update(e.lower() for e in re.findall(r"'\.?([A-Za-z0-9]{1,8})'", plain))
    out = [f'{b}.{e}' for b, e in zip(PROBE_BASES, PROBE_EXTS)]
    for e in sorted(exts):
        out += [f'{b}.{e}' for b in PROBE_BASES]
    return out


def _selective(test, probes) -> bool:
    return sum(1 for p in probes if test(p)) < 2


def distinctive(n: str, kind: str) -> bool:
    """SEMANTICS (dashboard doc): a body string (not a label) links only by a distinctive name: the endpoint
    as written; several words or a number (invoice-load, parseInvoice, api/orders, OSCAR150);
    or, for a route id or file name, at least 8 characters."""
    if kind == 'uri':
        return True
    core = n.strip('/-')
    if len(core) >= 5 and re.search(r'[-\d/:]', core):
        return True
    return kind in ('id', 'file') and len(core) >= 8


FILE_LABEL = re.compile(r'[\w.\-]+\.\w+', re.A)

# ---------------------------------------------------------------------------
# pytest files
# ---------------------------------------------------------------------------

IGNORED_MARKS = {'usefixtures', 'skip', 'skipif', 'xfail', 'filterwarnings', 'timeout', 'flaky', 'order', 'dependency'}


def _dotted(n) -> str:
    if isinstance(n, ast.Name):
        return n.id
    if isinstance(n, ast.Attribute):
        d = _dotted(n.value)
        return f'{d}.{n.attr}' if d else ''
    return ''


def _str_consts(node, max_len=300, single_line=False) -> list[str]:
    out = []
    skip_parts = set()
    for n in ast.walk(node):
        if isinstance(n, ast.JoinedStr):
            for v in n.values:
                skip_parts.add(id(v))
            if all(isinstance(v, ast.Constant) for v in n.values):
                out.append(''.join(v.value for v in n.values))
        elif isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in skip_parts:
            out.append(n.value)
    res = []
    for s in out:
        s = s.strip()
        if not s or len(s) > max_len or (single_line and '\n' in s):
            continue
        res.append(s)
    return res


def _decorator_strings(dec) -> list[str]:
    target = dec.func if isinstance(dec, ast.Call) else dec
    name = _dotted(target)
    if name in ('staticmethod', 'classmethod', 'property') or name.startswith('pytest.fixture'):
        return []
    mark = name[len('pytest.mark.'):].split('.')[0] if name.startswith('pytest.mark.') else None
    if mark in IGNORED_MARKS:
        return []
    out = _str_consts(dec)
    if mark and mark != 'parametrize':
        out.append(mark)
    return out


def _pytestmark_strings(value) -> list[str]:
    out = []
    for n in ast.walk(value):
        call = n if isinstance(n, ast.Call) else None
        target = n.func if call else n
        if not isinstance(target, ast.Attribute):
            continue
        name = _dotted(target)
        if not name.startswith('pytest.mark.') or name.count('.') != 2:
            continue
        mark = name.split('.')[2]
        if mark in IGNORED_MARKS:
            continue
        if call is None and any(isinstance(p, ast.Call) and p.func is n for p in ast.walk(value)):
            continue  # handled as the Call
        out.append(mark)
        if call:
            out += _str_consts(ast.Module(body=[ast.Expr(a) for a in call.args] + [ast.Expr(k.value) for k in call.keywords], type_ignores=[]))
    return out


def _is_pytestmark(stmt) -> bool:
    if isinstance(stmt, ast.Assign):
        return any(isinstance(t, ast.Name) and t.id == 'pytestmark' for t in stmt.targets)
    if isinstance(stmt, ast.AnnAssign):
        return isinstance(stmt.target, ast.Name) and stmt.target.id == 'pytestmark'
    return False


def _refs(node) -> list[str]:
    """Names a piece of code reads: plain names and every prefix of attribute chains (consts.ROUTE, self.ROUTE)."""
    out = []
    for n in ast.walk(node):
        if isinstance(n, ast.Attribute):
            d = _dotted(n)
            if d:
                segs = d.split('.')
                for k in range(2, len(segs) + 1):
                    out.append('.'.join(segs[:k]))
        elif isinstance(n, ast.Name):
            out.append(n.id)
    return list(dict.fromkeys(out))


def _is_fixture(fn) -> bool:
    for d in fn.decorator_list:
        name = _dotted(d.func if isinstance(d, ast.Call) else d)
        if name in ('pytest.fixture', 'fixture'):
            return True
    return False


def _is_allure_stmt(stmt) -> bool:
    """SEMANTICS (dashboard doc): `allure.*` calls in a test body are labels."""
    for n in ast.walk(stmt):
        if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == 'allure':
            return True
    return False


def _stmt_header_nodes(stmt):
    """For a compound statement, the parts on its own line (with-items, if-test…), not its nested body."""
    if isinstance(stmt, (ast.With, ast.AsyncWith)):
        return [i.context_expr for i in stmt.items] + [i.optional_vars for i in stmt.items if i.optional_vars]
    if isinstance(stmt, (ast.If, ast.While)):
        return [stmt.test]
    if isinstance(stmt, (ast.For, ast.AsyncFor)):
        return [stmt.target, stmt.iter]
    if isinstance(stmt, ast.Try):
        return [h.type for h in stmt.handlers if h.type]
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return list(stmt.decorator_list) + [d for d in stmt.args.defaults + stmt.args.kw_defaults if d]
    if isinstance(stmt, ast.ClassDef):
        return list(stmt.decorator_list) + list(stmt.bases)
    return None


def _collect_body(stmts, strong, weak, srefs, wrefs):
    """Statements one by one (like logical lines): allure.* lines are labels, others short strings."""
    for st in stmts:
        header = _stmt_header_nodes(st)
        parts = [st] if header is None else header
        for part in parts:
            m = ast.Module(body=[ast.Expr(part)] if isinstance(part, ast.expr) else [part], type_ignores=[])
            if _is_allure_stmt(m):
                strong += _str_consts(m)
                srefs += _refs(m)
            else:
                weak += _str_consts(m, 120, True)
                wrefs += _refs(m)
        if header is not None:
            for field_ in ('body', 'orelse', 'finalbody', 'handlers'):
                sub = getattr(st, field_, None) or []
                if field_ == 'handlers':
                    for h in sub:
                        _collect_body(h.body, strong, weak, srefs, wrefs)
                else:
                    _collect_body(sub, strong, weak, srefs, wrefs)


class PyFile:
    def __init__(self, path, source):
        self.path = path
        self.consts = {}     # name -> (strings, refs)
        self.imports = {}    # local -> (module, name|None, level)
        self.fixtures = {}   # name -> (strings, refs, params)
        self.tests = {}      # id -> dict (a later def shadows an earlier one, as in pytest)
        self.classes = {}    # top-level class name -> {'bases', 'consts', 'selfrefs', 'code'} (Test* or not)
        self.marks, self.mark_refs = [], []
        try:
            tree = ast.parse(source)
        except SyntaxError:
            self.ok = False
            return
        self.ok = True
        for st in tree.body:
            if _is_pytestmark(st):
                self.marks += _pytestmark_strings(st.value)
                self.mark_refs += [r for r in _refs(st.value) if r != 'pytestmark']
            elif isinstance(st, (ast.Assign, ast.AnnAssign)) and st.value is not None:
                self._assign(st, self.consts)
            elif isinstance(st, ast.ImportFrom):
                for a in st.names:
                    if a.name != '*':
                        self.imports[a.asname or a.name] = (st.module or '', a.name, st.level or 0)
            elif isinstance(st, ast.Import):
                for a in st.names:
                    if a.asname:
                        self.imports[a.asname] = (a.name, None, 0)
                    else:
                        self.imports[a.name.split('.')[0]] = (a.name.split('.')[0], None, 0)
            elif isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._def(st, [])
            elif isinstance(st, ast.ClassDef):
                self._record_class(st)
                if st.name.startswith('Test'):
                    self._class(st, [])

    def _record_class(self, cls):
        """SEMANTICS (dashboard doc): what a test class inherits and runs around its tests. Any top-level class:
        the classes it extends, its attributes, the attributes its setup/helper methods read through self./cls.,
        and the strings and names in those methods (test methods of a Test* class are left out: what one test
        reads counts for that test only)."""
        rec = {'bases': [b for b in (_dotted(x) for x in cls.bases) if b and b != 'object'], 'consts': {}, 'selfrefs': set(),
               'code_strings': [], 'code_refs': []}
        for st in cls.body:
            if isinstance(st, (ast.Assign, ast.AnnAssign)) and st.value is not None:
                self._assign(st, rec['consts'])
            elif isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if cls.name.startswith('Test') and st.name.startswith('test'):
                    continue
                defaults = [d for d in st.args.defaults + st.args.kw_defaults if d is not None]
                strong, weak, srefs, wrefs = [], [], [], []
                _collect_body([ast.Expr(d) for d in defaults] + st.body, strong, weak, srefs, wrefs)
                rec['code_strings'] += strong + weak
                rec['code_refs'] += srefs + wrefs
                for n in ast.walk(st):
                    if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id in ('self', 'cls'):
                        rec['selfrefs'].add(n.attr)
        self.classes[cls.name] = rec

    @staticmethod
    def _assign(st, into):
        targets = st.targets if isinstance(st, ast.Assign) else [st.target]
        for t in targets:
            if isinstance(t, ast.Name):
                into[t.id] = (_str_consts(st.value, 120, True), _refs(st.value))
            elif isinstance(t, (ast.Tuple, ast.List)):
                vals = st.value.elts if isinstance(st.value, (ast.Tuple, ast.List)) and len(st.value.elts) == len(t.elts) else None
                for k, e in enumerate(t.elts):
                    if isinstance(e, ast.Name):
                        v = vals[k] if vals else st.value
                        into[e.id] = (_str_consts(v, 120, True), _refs(v))

    def _class(self, cls, chain):
        strong, srefs = [], []
        if chain:
            strong += chain[-1]['strong']
            srefs += chain[-1]['srefs']
        for d in cls.decorator_list:
            ds = _decorator_strings(d)
            if ds or not self._ignored(d):
                strong += ds
                srefs += _refs(d) if not self._ignored(d) else []
        scope = {'name': cls.name, 'strong': strong, 'srefs': srefs, 'consts': {}}
        chain = chain + [scope]
        for st in cls.body:
            if _is_pytestmark(st):
                strong += _pytestmark_strings(st.value)
                srefs += [r for r in _refs(st.value) if r != 'pytestmark']
            elif isinstance(st, (ast.Assign, ast.AnnAssign)) and st.value is not None:
                self._assign(st, scope['consts'])
        for st in cls.body:
            if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._def(st, chain)
            elif isinstance(st, ast.ClassDef) and st.name.startswith('Test'):
                self._class(st, chain)

    @staticmethod
    def _ignored(d) -> bool:
        name = _dotted(d.func if isinstance(d, ast.Call) else d)
        if name in ('staticmethod', 'classmethod', 'property', 'fixture') or name.startswith('pytest.fixture'):
            return True
        return name.startswith('pytest.mark.') and name.split('.')[2] in IGNORED_MARKS

    def _def(self, fn, chain):
        params = [a.arg for a in fn.args.posonlyargs + fn.args.args + fn.args.kwonlyargs if a.arg not in ('self', 'cls')]
        if fn.args.vararg:
            params.append(fn.args.vararg.arg)
        if fn.args.kwarg:
            params.append(fn.args.kwarg.arg)
        strong, weak, srefs, wrefs = [], [], [], []
        defaults = [d for d in fn.args.defaults + fn.args.kw_defaults if d is not None]
        if _is_fixture(fn):
            _collect_body([ast.Expr(d) for d in defaults] + fn.body, strong, weak, srefs, wrefs)
            # SEMANTICS (pytest): @pytest.fixture(params=[...]) runs each requesting test once per value
            plabels = []
            for d in fn.decorator_list:
                if isinstance(d, ast.Call):
                    for k in d.keywords:
                        if k.arg == 'params':
                            plabels += _str_consts(k.value)
            self.fixtures[fn.name] = (strong + weak, srefs + wrefs, params, plabels)
            return
        if not fn.name.startswith('test'):
            return
        for d in fn.decorator_list:
            if self._ignored(d):
                continue
            strong += _decorator_strings(d)
            srefs += _refs(d)
        if chain:
            strong += chain[-1]['strong']
            srefs += chain[-1]['srefs']
        _collect_body([ast.Expr(d) for d in defaults] + fn.body, strong, weak, srefs, wrefs)
        tid = '::'.join([self.path] + [c['name'] for c in chain] + [fn.name])
        self.tests.pop(tid, None)
        self.tests[tid] = {'id': tid, 'strong': strong, 'weak': weak, 'srefs': srefs, 'wrefs': wrefs,
                           'params': params, 'chain': chain, 'top_class': chain[0]['name'] if chain else None}


def _class_const(chain, ref):
    """self.X / cls.X / Klass.X inside a method. SEMANTICS: a bare X in a method does not see class attributes (Python scoping)."""
    for c in reversed(chain):
        for prefix in ('self.', 'cls.', c['name'] + '.'):
            if ref.startswith(prefix) and ref[len(prefix):] in c['consts']:
                return c['consts'][ref[len(prefix):]]
    return None


def scan_pytest_files(files: list[tuple[str, str]]) -> list[dict]:
    models = [PyFile(p, t) for p, t in files]
    by_path = {m.path: m for m in models}

    def dir_of(p):
        return p.split('/')[:-1]

    def shared(a, b):
        n = 0
        while n < len(a) and n < len(b) and a[n] == b[n]:
            n += 1
        return n

    def dotted_path(m):
        segs = m.path[:-3].split('/') if m.path.endswith('.py') else m.path.split('/')
        if segs[-1] == '__init__':
            segs = segs[:-1]
        return segs

    def module_file(frm, module, level):
        if level > 0:
            base = dir_of(frm.path)
            base = base[:max(0, len(base) - (level - 1))]
            rel = '/'.join(base + [x for x in module.split('.') if x])
            return by_path.get(rel + '.py') or by_path.get(rel + '/__init__.py')
        want = module.split('.')
        found = [m for m in models if dotted_path(m)[-len(want):] == want and len(dotted_path(m)) >= len(want)]
        if not found:
            return None
        here = dir_of(frm.path)
        return max(found, key=lambda m: shared(dir_of(m.path), here))

    def resolve(m, ref, depth=0, seen=None):
        seen = set() if seen is None else seen
        if depth > 5 or (m.path, ref) in seen:
            return []
        seen.add((m.path, ref))
        segs = ref.split('.')
        if len(segs) == 1 and segs[0] in m.consts:
            strs, refs = m.consts[segs[0]]
            return strs + [s for r in refs for s in resolve(m, r, depth + 1, seen)]
        imp = m.imports.get(segs[0])
        if not imp:
            return []
        module, name, level = imp
        rest = segs[1:]
        if name is None:
            parts = module.split('.') + rest
            for k in range(len(parts) - 1, 0, -1):
                t = module_file(m, '.'.join(parts[:k]), level)
                if t:
                    return resolve(t, '.'.join(parts[k:]), depth + 1, seen)
            return []
        t = module_file(m, module, level) if module or level else None
        if t and (name in t.consts or name in t.imports):
            return resolve(t, '.'.join([name] + rest), depth + 1, seen)
        sub = module_file(m, f'{module}.{name}' if module else name, level)
        return resolve(sub, '.'.join(rest), depth + 1, seen) if sub and rest else []

    conftests = [m for m in models if m.path.rsplit('/', 1)[-1] == 'conftest.py']

    def fixture_for(m, name):
        if name in m.fixtures:
            return m, m.fixtures[name]
        here = dir_of(m.path)
        above = sorted((c for c in conftests if dir_of(c.path) == here[:len(dir_of(c.path))]), key=lambda c: -len(dir_of(c.path)))
        for c in above:
            if name in c.fixtures:
                return c, c.fixtures[name]
        imp = m.imports.get(name)
        if imp and imp[1]:
            t = module_file(m, imp[0], imp[2])
            if t and imp[1] in t.fixtures:
                return t, t.fixtures[imp[1]]
        return None

    def fixture_strings(m, params, depth, seen, labels):
        if depth > 2:
            return []
        out = []
        for p in params:
            f = fixture_for(m, p)
            if not f or (f[0].path, p) in seen:
                continue
            seen.add((f[0].path, p))
            owner, (strs, refs, fparams, plabels) = f
            labels += plabels
            out += strs + [s for r in refs for s in resolve(owner, r)]
            out += fixture_strings(owner, fparams, depth + 1, seen, labels)
        return out

    def class_chain(owner, name, depth=0, seen=None):
        """The class and the classes it extends (same file, or imported), the class first."""
        seen = set() if seen is None else seen
        if depth > 6 or (owner.path, name) in seen:
            return []
        seen.add((owner.path, name))
        target = None
        if name in owner.classes:
            target = (owner, owner.classes[name])
        else:
            head, *rest = name.split('.')
            imp = owner.imports.get(head)
            if imp:
                module, iname, level = imp
                if iname is not None and not rest:
                    f = module_file(owner, module, level)
                    if f and iname in f.classes:
                        target = (f, f.classes[iname])
                elif len(rest) == 1:
                    f = module_file(owner, module if iname is None else f'{module}.{iname}', level)
                    if f and rest[0] in f.classes:
                        target = (f, f.classes[rest[0]])
        if not target:
            return []
        return [target] + [x for b in target[1]['bases'] for x in class_chain(target[0], b, depth + 1, seen)]

    out = []
    for m in models:
        if not m.ok:
            continue
        mark = m.marks + [s for r in m.mark_refs for s in resolve(m, r)]
        for t in m.tests.values():
            strong, weak = list(t['strong']), list(t['weak'])
            for kind, into in (('srefs', strong), ('wrefs', weak)):
                for r in t[kind]:
                    v = _class_const(t['chain'], r)
                    if v:
                        into += v[0] + [s for rr in v[1] for s in resolve(m, rr)]
                    else:
                        into += resolve(m, r)
            strong += mark
            weak += fixture_strings(m, t['params'], 0, set(), strong)
            # SEMANTICS (dashboard doc): the code its class runs around it. Attributes read through self./cls. by
            # setup/helper methods anywhere in its class hierarchy (the first class defining one wins, the test's
            # own class first), and the setup/helper code of the classes in its own file.
            if t['top_class']:
                chain = class_chain(m, t['top_class'])
                used = set().union(*(rec['selfrefs'] for _, rec in chain)) if chain else set()
                for attr in used:
                    holder = next(((o, rec) for o, rec in chain if attr in rec['consts']), None)
                    if holder:
                        strs, refs = holder[1]['consts'][attr]
                        weak += strs + [x for r in refs for x in resolve(holder[0], r)]
                for owner, rec in chain:
                    if owner is m:
                        weak += rec['code_strings'] + [x for r in rec['code_refs'] if not r.startswith(('self.', 'cls.')) for x in resolve(m, r)]
            labels = list(dict.fromkeys(x.strip() for x in strong if x.strip()))
            strings = list(dict.fromkeys(labels + [x.strip() for x in weak if x.strip()]))
            out.append({'id': t['id'], 'labels': labels, 'strings': strings})
    return out


# ---------------------------------------------------------------------------
# Triggers
# ---------------------------------------------------------------------------

def norm(s: str) -> str:
    """SEMANTICS (dashboard doc): names compare case-, separator- and camelCase-insensitively."""
    s = re.sub(r'([a-z0-9])([A-Z])', r'\1-\2', s.strip())
    return re.sub(r'[\s_.\-]+', '-', s.lower())


PARENT_FILE = re.compile(r'\$(?:simple)?\{\s*file:parent\s*\}\s*[/\\]\s*([^\s"\'<>;,()]+)')


def _route_marker(route: El) -> Optional[str]:
    """SEMANTICS (dashboard doc): a marker file the load route deletes when done (`${file:parent}/NAME`,
    or a setHeader/setProperty deleteFileName/doneFile… header): its trigger file when the <from> has no doneFileName."""
    cands = []
    for e in route.iter():
        for v in list(e.attrs.values()) + [e.text]:
            for m in PARENT_FILE.finditer(v or ''):
                cands.append((0, m.group(1)))
        if e.tag in ('setHeader', 'setProperty'):
            hname = e.attrs.get('name') or e.attrs.get('headerName') or e.attrs.get('propertyName') or ''
            if re.search('file', hname, re.I) and re.search('(done|delete|trigger|marker|flag)', hname, re.I):
                for c in e.children:
                    if c.tag in ('constant', 'simple'):
                        cands.append((1, c.text.strip()))
    for _, v in sorted(cands, key=lambda x: x[0]):
        name = re.split(r'[/\\]', v.strip())[-1]
        if name and len(name) <= 200 and re.fullmatch(r'[\w.{}$:\-]+', name, re.A) and not re.fullmatch(r'\$\{[^}]*\}', name):
            return name
    return None


def _first_simple_and_target(when: El):
    simple = next((c for c in when.children if c.tag == 'simple'), None)
    target = None

    def walk(e: El):
        nonlocal target
        for c in e.children:
            if target:
                return
            if c.tag in ('when', 'filter'):
                continue
            if c.tag in ('to', 'toD') and c.attrs.get('uri'):
                target = c.attrs['uri']
                return
            walk(c)
    walk(when)
    return simple, target


def _schedule_name(path: str) -> Optional[str]:
    segs = [s for s in path.split('/') if s]
    return segs[-1] if segs else None


def _endpoint_name(path: str) -> Optional[str]:
    segs = [s for s in re.split(r'[/:]', path) if s]
    return segs[-1] if segs else None


def _rest_paths(ep: Endpoint) -> list[str]:
    p = ep.path
    if ep.scheme == 'rest':
        # rest:method:path[:uriTemplate]
        bits = p.split(':', 2)
        if len(bits) >= 2 and bits[0].lower() in ('get', 'post', 'put', 'delete', 'patch', 'head', 'options'):
            bits = bits[1:]
        p = '/'.join(b.strip('/') for b in bits if b.strip('/'))
    else:
        m = re.match(r'[a-z][\w+.\-]*://[^/]*(/[^?#]*)?', p, re.I)
        if m:
            p = m.group(1) or ''
        elif ep.scheme in ('http', 'https', 'jetty', 'netty-http', 'netty4-http', 'undertow', 'restlet'):
            # scheme://host:port/path with the '//' already removed: drop the authority
            p = '/' + p.split('/', 1)[1] if '/' in p else ''
    if ep.params.get('contextPath'):
        p = ep.params['contextPath'].rstrip('/') + '/' + p.lstrip('/')
    p = p.strip()
    p = p.rstrip('/')
    if not p or '{{' in p or '${' in p:
        return []
    p = p if p.startswith('/') else '/' + p
    return [p, p[1:]]


def scan_repository(xml_files, prop_files, test_files) -> dict:
    props = Properties(prop_files)
    parsed = []
    endpoints_by_file: dict[str, dict] = {}
    for path, text in xml_files:
        root = parse_xml(text)
        if root is None:
            continue
        parsed.append((path, root))
        eps = {}
        for e in root.iter():
            if e.tag == 'endpoint' and e.attrs.get('id') and e.attrs.get('uri'):
                eps[e.attrs['id']] = e.attrs['uri']
        endpoints_by_file[path] = eps

    def endpoint_uri(ref: str, file: str) -> Optional[str]:
        # SEMANTICS: endpoint ids are per CamelContext: the same file's; else the only one in the module;
        # else the only one anywhere; several candidates → unknown (no guessing)
        if ref in endpoints_by_file.get(file, {}):
            return endpoints_by_file[file][ref]
        mod = module_of(file)
        same = [eps[ref] for f, eps in endpoints_by_file.items() if module_of(f) == mod and ref in eps]
        if len(same) == 1:
            return same[0]
        anywhere = [eps[ref] for eps in endpoints_by_file.values() if ref in eps]
        return anywhere[0] if len(anywhere) == 1 else None

    seen_ids: dict = {}

    triggers = []
    other_routes = 0
    for path, root in parsed:
        for route in [e for e in root.iter() if e.tag == 'route' and not _in_template(e)]:
            inputs = [e for e in route.iter() if e.tag == 'from' and _nearest_route(e) is route]
            rid = route.attrs.get('id')
            module = module_of(path)
            if rid:
                # SEMANTICS (dashboard doc): one route id per module; a copy whose inputs are the same endpoints as
                # any earlier definition of the id is counted once. A ref resolves per file, so it is compared resolved.
                def resolved_input(i):
                    ref = i.attrs.get('ref')
                    uri = i.attrs.get('uri')
                    if ref is None and uri is not None:
                        m = re.fullmatch(r'\s*ref:(?://)?([^?\s]+)\s*', uri)
                        ref = m.group(1) if m else None
                    return (endpoint_uri(ref, path) if ref else None) or (uri if uri is not None else 'ref:' + (ref or ''))
                sig = tuple(resolved_input(i) for i in inputs)
                if sig in seen_ids.get((module, rid), set()):
                    continue
                seen_ids.setdefault((module, rid), set()).add(sig)
            if not inputs:
                continue
            conds = []
            for w in route.iter():
                if w.tag in ('when', 'filter') and _nearest_route(w) is route:
                    simple, target = _first_simple_and_target(w)
                    if simple is None or not simple.text.strip():
                        continue
                    expr = simple.text.strip()
                    r = resolve(expr, props, path)
                    groups = parse_condition(r.first)
                    if groups:
                        conds.append({'expr': expr, 'line': w.line, 'groups': groups, 'target': target, 'resolved': r.first})
            # SEMANTICS (dashboard doc): a file-name branch is a job only when it sends the file on (a <to>).
            # When some job picks files by name, every job is a trigger, plus the <otherwise> of their
            # <choice> that sends the rest on; when every job only says "not …", they filter files out and
            # the <from>'s own patterns stay the triggers (named by that job's target when there is one).
            jobs = [c for c in conds if c['target']]
            only_not = lambda c: all(all(a.negate for a in g) for g in c['groups'])
            picks = jobs if any(not only_not(c) for c in jobs) else []
            guards = [] if picks else jobs
            pick_exprs = {c['expr'] for c in picks}
            otherwise = []
            for w in route.iter():
                if w.tag == 'otherwise' and _nearest_route(w) is route and w.parent is not None and w.parent.tag == 'choice':
                    _, target = _first_simple_and_target(w)
                    whens = []
                    for c in w.parent.children:
                        if c.tag == 'when':
                            sm = next((x for x in c.children if x.tag == 'simple'), None)
                            if sm is not None and sm.text.strip():
                                whens.append(sm.text.strip())
                    if target and any(e in pick_exprs for e in whens):
                        otherwise.append({'target': target, 'line': w.line})
            marker = _route_marker(route)
            has_trigger = False
            for idx, inp in enumerate(inputs, 1):
                uri = inp.attrs.get('uri')
                if uri is None and inp.attrs.get('ref'):
                    uri = endpoint_uri(inp.attrs['ref'], path)
                if uri is None:
                    continue
                # SEMANTICS: Camel's ref component: from uri="ref:x" is the endpoint with id x
                m_ref = re.fullmatch(r'\s*ref:(?://)?([^?]+)\s*', uri)
                if m_ref and endpoint_uri(m_ref.group(1), path):
                    uri = endpoint_uri(m_ref.group(1), path)
                res = resolve(uri, props, path)
                # SEMANTICS: master:lockName:<endpoint> consumes <endpoint> (on one node)
                res = Res(_unwrap_master(res.text), _unwrap_master(res.first), res.ambiguous)
                ep = parse_uri(res.first)
                kind = kind_of(ep.scheme) if ep else None
                scheme = ep.scheme if ep else None
                if ep is None:
                    only = ONLY_PLACEHOLDER.match(res.first)
                    if not only:
                        continue
                    key = (only.group(1) or only.group(2) or '').strip()
                    if only.group(1) is not None and not key.startswith(CAMEL_FUNC_CURLY):
                        key = key.split(':', 1)[0]
                    g = guess_scheme_from_key(key)
                    kind, scheme = ('file', g) if g else ('property', 'property')
                    ep = Endpoint(scheme, '', {})
                if kind is None:
                    continue
                has_trigger = True
                shown = parse_uri(res.text) or ep
                base = {
                    'file': path, 'routeId': rid, 'module': module, 'input': idx, 'kind': kind, 'scheme': scheme,
                    'line': inp.line, 'sub': None, 'patternKind': None, 'filePattern': None,
                    'names': set(), 'testers': [],
                }
                names = base['names']
                if rid:
                    names.add((rid, 'id'))
                # SEMANTICS (dashboard doc): a URI that differs per environment keeps its placeholders when
                # shown; names come from that shown form only (no guessing a per-environment name)
                named = parse_uri(res.text) or Endpoint(scheme, '', {})
                if kind == 'schedule':
                    n = _schedule_name(named.path)
                    if n and '{{' not in n and '${' not in n:
                        names.add((n, 'name'))
                if kind in ('direct', 'queue', 'kafka') and named.path and not ONLY_PLACEHOLDER.match(named.path):
                    n = _endpoint_name(named.path)
                    if n and '{{' not in n and '${' not in n:
                        names.add((n, 'name'))
                if kind == 'rest' and named.path:
                    names.update((x, 'name') for x in _rest_paths(named))
                # SEMANTICS (dashboard doc): the endpoint as written (seda:orders, direct:invoiceJob) names it too
                if kind not in ('file', 'property') and not ONLY_PLACEHOLDER.match(res.text.split('?')[0] or ' '):
                    names.add((re.sub(r'^([\w+.\-]+)://', r'\1:', res.text.split('?')[0].strip()), 'uri'))
                if kind != 'file':
                    triggers.append(base)
                    continue
                done_text = shown.params.get('doneFileName')
                done_first = ep.params.get('doneFileName')
                if done_text is None and marker:
                    mr = resolve(marker, props, path)
                    done_text, done_first = mr.text, mr.first
                for d in (done_text, done_first):
                    if d:
                        names.add((d, 'file'))
                done_tester = None
                if done_first:
                    rx = _file_language_regex(done_first)
                    if rx:
                        done_tester = lambda f, rx=rx: rx.fullmatch(f) is not None

                def finish(t, main_tester, texts):
                    testers = [x for x in (main_tester, done_tester) if x]
                    probes = _probes(texts + [done_first or ''])
                    t['testers'] = [x for x in testers if _selective(x, probes)]
                    triggers.append(t)

                def add_target(t, target):
                    tp = parse_uri(target)
                    if tp:
                        n = _endpoint_name(tp.path.split('?')[0])
                        if n:
                            t['names'].add((n, 'name'))
                    t['names'].add((target.split('?')[0].strip(), 'uri'))

                which = next((w for w in ('include', 'antInclude', 'fileName') if w in shown.params), None)
                pk = {'include': 'regex', 'antInclude': 'glob', 'fileName': 'name'}.get(which) if which else None

                def pattern_tester(pat):
                    if pk == 'regex':
                        # SEMANTICS: Camel's include= is matched case-insensitively
                        rx = _java_regex(pat, True)
                        return (lambda f, rx=rx: rx.fullmatch(f) is not None) if rx else None
                    if pk == 'glob':
                        rx = _ant_regex(pat)
                        return lambda f, rx=rx: rx.fullmatch(f) is not None
                    rx = _file_language_regex(pat)
                    return (lambda f, rx=rx: rx.fullmatch(f) is not None) if rx else None

                if picks:
                    for o in otherwise:
                        t = dict(base, names=set(names), line=o['line'], patternKind=pk,
                                 filePattern=shown.params[which] if which else None)
                        add_target(t, o['target'])
                        if which:
                            pat = ep.params.get(which, shown.params[which])
                            t['names'].update({(shown.params[which], 'file'), (pat, 'file')})
                            finish(t, pattern_tester(pat), [shown.params[which], pat])
                        else:
                            finish(t, None, [])
                    for c in picks:
                        t = dict(base, names=set(names), sub=('cond', re.sub(r'\s+', ' ', c['expr']), c['line']),
                                 patternKind='condition', line=c['line'])
                        if c['target']:
                            add_target(t, c['target'])
                        groups = c['groups']
                        specific = all(any(not a.negate and len(a.value) >= 3 for a in g) for g in groups)
                        finish(t, (lambda f, g=groups: condition_matches(g, f)) if specific else None, [c['resolved']])
                    continue
                if len(guards) == 1:
                    add_target(base, guards[0]['target'])
                if which is None:
                    finish(base, None, [])
                    continue
                parts = split_patterns(shown.params[which], pk)
                for part in parts:
                    pat = part if len(parts) > 1 else ep.params.get(which, part)
                    t = dict(base, names=set(names), patternKind=pk, filePattern=part,
                             sub=('part', part) if len(parts) > 1 else None)
                    t['names'].update({(part, 'file'), (pat, 'file')})
                    finish(t, pattern_tester(pat), [part, pat])
            if not has_trigger:
                other_routes += 1

    tests = scan_pytest_files(test_files)

    by_name: dict[str, list[tuple[str, str, bool]]] = {}
    file_labels = []
    for t in tests:
        labels = set(t['labels'])
        for s in t['strings']:
            n = norm(s)
            if n:
                by_name.setdefault(n, []).append((t['id'], s, s in labels))
            if FILE_LABEL.fullmatch(s.strip()):
                file_labels.append((t['id'], s.strip()))
    out = []
    for t in triggers:
        cov = {}
        for n, kind in sorted({(norm(x), k) for x, k in t['names'] if x and norm(x)}):
            ok_in_body = distinctive(n, kind)
            for tid, via, is_label in by_name.get(n, []):
                if is_label or ok_in_body:
                    cov.setdefault(tid, via)
        for tid, f in file_labels:
            if tid not in cov and any(x(f) for x in t['testers']):
                cov[tid] = f
        out.append({
            'file': t['file'], 'routeId': t['routeId'], 'module': t['module'], 'input': t['input'],
            'line': t['line'], 'sub': list(t['sub']) if t['sub'] else None, 'kind': t['kind'], 'scheme': t['scheme'],
            'patternKind': t['patternKind'], 'filePattern': t['filePattern'],
            'coveredBy': sorted(cov), 'via': cov,
        })
    return {'triggers': out, 'otherRoutes': other_routes, 'tests': [t['id'] for t in tests]}


def _in_template(e: El) -> bool:
    """A <route> inside <routeTemplate> is a blueprint, started only when instantiated."""
    p = e.parent
    while p is not None:
        if p.tag == 'routeTemplate':
            return True
        p = p.parent
    return False


def _unwrap_master(uri: str) -> str:
    m = re.match(r'\s*master:[^:]*:(.+)\Z', uri, re.S)
    return m.group(1) if m else uri


def _nearest_route(e: El) -> Optional[El]:
    p = e.parent
    while p is not None and p.tag != 'route':
        p = p.parent
    return p


SKIP_DIRS = {'.git', 'node_modules', 'target', 'build', 'dist', 'out', '.venv', 'venv', 'site-packages', '__pycache__', '.idea', '.gradle', '.mvn'}
TEST_SOURCES = re.compile(r'(^|/)src/(test|it|integrationTest|integration-test|intTest|testFixtures|e2e)/')
MAX_FILE_BYTES = 5 * 1024 * 1024


def read_repo(root: str):
    """Files as an upload reads them. A root holding __routes__/ and __tests__/ (a real Camel repo and
    test repo side by side) reads only route XML and properties from the first, only Python from the second."""
    xml_files, prop_files, test_files = [], [], []
    sides = [(os.path.join(root, '__routes__'), 'routes'), (os.path.join(root, '__tests__'), 'tests')]
    if not any(os.path.isdir(d) for d, _ in sides):
        sides = [(root, None)]
    for base, only in sides:
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base, followlinks=True):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for fn in filenames:
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, root).replace(os.sep, '/')
                low = fn.lower()
                kind = 'xml' if low.endswith('.xml') else 'properties' if low.endswith('.properties') else 'tests' if fn.endswith('.py') else None
                if kind is None or (only == 'routes' and kind == 'tests') or (only == 'tests' and kind != 'tests'):
                    continue
                if kind != 'tests' and TEST_SOURCES.search(rel):
                    continue
                try:
                    if os.path.getsize(full) > MAX_FILE_BYTES:
                        continue
                    text = open(full, encoding='utf-8', errors='replace').read()
                except OSError:
                    continue
                (xml_files if kind == 'xml' else prop_files if kind == 'properties' else test_files).append((rel, text.lstrip('\ufeff')))
    key = lambda x: x[0]
    return sorted(xml_files, key=key), sorted(prop_files, key=key), sorted(test_files, key=key)


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    res = scan_repository(*read_repo(argv[1]))
    if '--summary' in argv:
        kinds = {}
        for t in res['triggers']:
            k = kinds.setdefault(t['kind'], [0, 0])
            k[0] += 1
            k[1] += bool(t['coveredBy'])
        total = len(res['triggers'])
        print(f"triggers: {total}  covered: {sum(1 for t in res['triggers'] if t['coveredBy'])}  otherRoutes: {res['otherRoutes']}  tests: {len(res['tests'])}")
        for k, (n, c) in sorted(kinds.items()):
            print(f'  {k:9s} {n:5d}  covered {c}')
        mods = {}
        for t in res['triggers']:
            mods[t['module']] = mods.get(t['module'], 0) + 1
        for m, n in sorted(mods.items(), key=lambda x: str(x[0])):
            print(f'  folder {m}: {n}')
        return 0
    json.dump(res, sys.stdout, indent=1, default=list)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
