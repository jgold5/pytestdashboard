#!/usr/bin/env python3
"""
Turn a verify-counts comparison of real repos into something safe to send: every disagreement
becomes a small, anonymized repro (just the route's XML file, the properties it uses, and the
test files involved with the conftest.py and modules they import), each one re-checked to still
show the disagreement after renaming.

    pnpm verify-counts --repo /path/to/camel-repo --tests /path/to/test-repo --share
    (or: python3 share.py report.json)

Writes:
    verify-counts-share/            summary.md + repros/*.json   (safe to send)
    verify-counts-share.zip         the folder above, zipped
    verify-counts-share.map.json    original -> generic words. PRIVATE: keep it, don't send it.

The renaming is the distiller's (tools/distill_camel_repo.py), the same everywhere, so a route id
in the XML and the same id in a test still match; camelCase parts are renamed separately so
parseInvoice and parse-invoice still name the same thing. Python keeps its layout (only names,
strings and comments change), so formatting-dependent cases still reproduce. Camel syntax,
regexes, cron expressions, option names and file extensions are kept.
"""
from __future__ import annotations

import builtins
import collections
import io
import json
import keyword
import os
import re
import shutil
import sys
import tokenize
import zipfile
from typing import Dict, List, Optional, Set

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import distill_camel_repo as distill  # noqa: E402

MAX_REPROS = 40
PER_GROUP = 3


CONSONANTS = 'bdfgklmnprstvz'
VOWELS = 'aeiou'
# never generated: words the scanners treat specially (schemes, operators, Python keywords…) stay unambiguous
RESERVED = set(distill.KEEP_WORDS) | set(keyword.kwlist) | {
    'seda', 'vm', 'jms', 'kafka', 'direct', 'rest', 'http', 'https', 'netty', 'jetty', 'servlet', 'undertow', 'amqp', 'sjms',
    'file', 'ftp', 'ftps', 'sftp', 'smb', 'quartz', 'cron', 'timer', 'master', 'ref', 'env', 'sys', 'bean', 'stub', 'log',
    'starts', 'ends', 'with', 'contains', 'regex', 'not', 'and', 'or', 'in', 'test', 'tests', 'self', 'cls', 'param', 'params',
}


# Camel syntax the distiller's list lacks: RAW(…) option values, REST verbs, simple-language operators and functions
SYNTAX_WORDS = {
    'raw', 'get', 'post', 'put', 'patch', 'head', 'options', 'delete', 'lowercase', 'uppercase', 'contextpath',
    'startswith', 'endswith', 'equalsignorecase', 'touppercase', 'tolowercase', 'substring', 'matches',
}


class Namer(distill.Namer):
    """
    The distiller's consistent renaming, changed so a renamed repo counts exactly like the original:
    - a word becomes a made-up word of the same length, letters only (how long a name is and whether it has a
      digit decide how it links);
    - camelCase parts are renamed one by one (parseInvoice → bakeDufo, like parse-invoice → bake-dufo);
    - prefixes are kept: when PAY and PAYMENTS are both words, PAYMENTS is renamed to PAY's new name plus more
      letters (so `starts with 'PAY'` still matches), and no two unrelated words get a common prefix that is a word.
    Use collect() over everything first, then finalize(), then rename: words are assigned shortest first.
    """

    def __init__(self, *a, **kw) -> None:
        super().__init__(*a, **kw)
        self._counter: collections.Counter = collections.Counter()
        self._collecting = False
        self._seen: Set[str] = set()
        self._by_new: Dict[str, str] = {v: k for k, v in self.words.items()}
        # words left as they are (short ones, Camel's) that patterns use: they anchor prefixes too
        self._kept: Set[str] = set()
        self._anchors: Set[str] = set()

    def collect(self) -> None:
        self._collecting = True

    def anchor(self, pattern: str) -> None:
        """A string used as a pattern (starts with '…', include=, fileName=…): its kept words must stay prefixes."""
        for run in re.findall(r'[A-Za-z]+', pattern):
            for part in re.findall(r'[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[A-Z]+', run) + [run]:
                self._anchors.add(part.lower())

    def finalize(self) -> None:
        self._collecting = False
        # only kept words that patterns use anchor prefixes: `/in` in a path must not make `invoice` keep "in"
        self._kept &= self._anchors
        for k in self._kept:
            self._by_new.setdefault(k, k)
        for low in sorted(self._seen, key=lambda w: (len(w), w)):
            self._assign(low)

    def _fresh(self, base: str, length: int) -> str:
        key = (base, length)
        n = self._counter[key]
        self._counter[key] += 1
        letters = []
        for i in range(len(base), length):
            alphabet = CONSONANTS if i % 2 == 0 else VOWELS
            letters.append(alphabet[n % len(alphabet)])
            n //= len(alphabet)
        if n:
            return ''
        return base + ''.join(letters)

    def _assign(self, low: str) -> str:
        got = self.words.get(low)
        if got is not None:
            return got
        # the longest word that is a prefix of this one (renamed, or kept as it is): its new name starts this one's
        base, base_orig = '', ''
        for k in range(len(low) - 1, 0, -1):
            if low[:k] in self.words:
                base, base_orig = self.words[low[:k]], low[:k]
                break
            if low[:k] in self._kept:
                base, base_orig = low[:k], low[:k]
                break
        for _ in range(100000):
            cand = self._fresh(base, len(low))
            if not cand:
                base, base_orig = '', ''  # out of names under this prefix: start afresh (rare)
                continue
            if cand in RESERVED or cand in self._by_new:
                continue
            # a new name may only start with the new name of a word that starts the original too
            if any(cand[:k] in self._by_new and not low.startswith(self._by_new[cand[:k]]) for k in range(1, len(cand))):
                continue
            break
        self.words[low] = cand
        self._by_new[cand] = low
        return cand

    def _one(self, w: str) -> str:
        low = w.lower()
        if len(low) <= 2 or low in distill.KEEP_WORDS or low in SYNTAX_WORDS or distill.FORMAT_RE.match(w):
            if self._collecting:
                self._kept.add(low)
            return w
        if self._collecting:
            self._seen.add(low)
            return w
        g = self._assign(low)
        if w.isupper():
            return g.upper()
        return g.capitalize() if w[0].isupper() else g

    def word(self, w: str) -> str:
        if w.lower() in distill.KEEP_WORDS or w.lower() in SYNTAX_WORDS:  # antInclude, CamelFileName, RAW(…), rest:post:…
            if self._collecting:
                self._kept.add(w.lower())
            return w
        parts = re.findall(r'[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[A-Z]+', w)
        if len(parts) <= 1 or ''.join(parts) != w:
            return self._one(w)
        return ''.join(self._one(p) for p in parts)

    def number(self, run: str) -> str:
        return run if self._collecting else super().number(run)


# ---------------------------------------------------------------------------
# Anonymizers that keep each file's layout
# ---------------------------------------------------------------------------

TAG = re.compile(r'<\s*(/)?\s*((?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*)((?:[^>"\']|"[^"]*"|\'[^\']*\')*?)(/)?\s*>')
ATTR = re.compile(r'([A-Za-z_][\w:.-]*)(\s*=\s*)(?:"([^"]*)"|\'([^\']*)\')')
TECHNICAL_ATTR_VALUE = re.compile(r'camel|file|done|delete|trigger|marker|flag', re.I)
PLACEHOLDER = re.compile(r'\{\{[^{}]+\}\}|\$\{properties:[^}]+\}')


def simple_expr(expr: str, namer: Namer) -> str:
    """
    Camel simple: text outside ${…} is a literal (`${file:parent}/LOADTRIGGER`), and so are quoted values, so
    both are renamed; ${…} functions are syntax and kept (but the key of ${properties:key} is a name);
    operators (starts with, regex, and…) are kept words.
    """
    out, pos = [], 0
    for m in re.finditer(r"\$\{[^{}]*\}|\{\{[^{}]+\}\}|'([^']*)'|\"([^\"]*)\"", expr):
        before = expr[pos:m.start()]
        out.append(namer.text(before))
        tok = m.group(0)
        if tok.startswith('${'):
            prop = re.match(r'^\$\{(\s*properties:)([^}:]+)(.*)\}$', tok)
            if prop:
                out.append('${' + prop.group(1) + namer.text(prop.group(2)) + prop.group(3) + '}')
            else:
                # a function: keep it, but its quoted arguments are values (startsWith('INV_'))
                out.append(re.sub(r"'([^']*)'|\"([^\"]*)\"", lambda q: (q.group(0)[0] + namer.text(q.group(1) if q.group(1) is not None else q.group(2), regex='matches(' in tok[:q.start()]) + q.group(0)[0]), tok))
        elif tok.startswith('{{'):
            out.append(namer.text(tok))
        else:
            lit = m.group(1) if m.group(1) is not None else m.group(2)
            quote = "'" if m.group(1) is not None else '"'
            is_regex = re.search(r'(regex|=~|~~)\s*$', before, re.I) is not None
            out.append(quote + namer.text(lit, regex=is_regex) + quote)
        pos = m.end()
    out.append(namer.text(expr[pos:]))
    return ''.join(out)


PATTERN_OPTION = re.compile(r'(?:^|[?&;])(?:include|antInclude|exclude|antExclude|fileName|doneFileName|includeExt|excludeExt)=([^&"\']*)', re.I)


def register_patterns(xml: str, namer: Namer) -> None:
    """Tell the namer which strings are patterns (prefix relations to keep): file options and quoted <simple>/<constant> values."""
    for m in PATTERN_OPTION.finditer(distill.xml_unescape(xml)):
        namer.anchor(m.group(1))
    for m in re.finditer(r'<\s*(?:\w+:)?(simple|constant)\b[^>]*>([\s\S]*?)<\s*/\s*(?:\w+:)?\1\s*>', xml):
        body = distill.xml_unescape(m.group(2))
        for q in re.finditer(r"'([^']*)'|\"([^\"]*)\"", body):
            namer.anchor(q.group(1) if q.group(1) is not None else q.group(2))
        if m.group(1) == 'constant':
            namer.anchor(body)
        for q in re.finditer(r'\}\s*[/\\]\s*([^\s"\'<>;,()]+)', body):  # ${file:parent}/MARKER
            namer.anchor(q.group(1))


def anonymize_xml(text: str, namer: Namer) -> str:
    """Keep every tag and attribute name; rename values (uri= the distiller's way, keeping options and regexes)."""
    text = re.sub(r'<!--[\s\S]*?-->', lambda m: re.sub(r'[^\n]', ' ', m.group(0)), text)  # comments out, lines kept

    def attrs(raw: str) -> str:
        def one(m: re.Match) -> str:
            name, eq = m.group(1), m.group(2)
            val = m.group(3) if m.group(3) is not None else m.group(4)
            q = '"' if m.group(3) is not None else "'"
            local = name.split(':')[-1]
            if name == 'xmlns' or name.startswith('xmlns:') or local == 'schemaLocation':
                new = val
            elif local == 'uri' or local == 'url':
                new = distill.xml_escape(namer.uri(distill.xml_unescape(val)))
            elif local in ('name', 'headerName', 'propertyName') and TECHNICAL_ATTR_VALUE.search(val):
                new = val
            else:
                new = distill.xml_escape(namer.text(distill.xml_unescape(val)))
            return f'{name}{eq}{q}{new}{q}'
        return ATTR.sub(one, raw)

    out, pos, in_simple = [], 0, False
    for m in TAG.finditer(text):
        between = text[pos:m.start()]
        if between.strip():
            if in_simple:
                cdata = re.match(r'^(\s*<!\[CDATA\[)([\s\S]*)(\]\]>\s*)$', between)
                between = cdata.group(1) + simple_expr(cdata.group(2), namer) + cdata.group(3) if cdata else distill.xml_escape(simple_expr(distill.xml_unescape(between), namer))
            else:
                between = distill.xml_escape(namer.text(distill.xml_unescape(between)))
        out.append(between)
        closing, qname, raw, selfclosing = m.group(1), m.group(2), m.group(3) or '', m.group(4)
        local = qname.split(':')[-1]
        if local == 'simple':
            in_simple = not closing and not selfclosing
        out.append(f"<{'/' if closing else ''}{qname}{attrs(raw)}{'/' if selfclosing else ''}>")
        pos = m.end()
    out.append(text[pos:])
    return ''.join(out)


def anonymize_properties(text: str, namer: Namer, keep_keys: Optional[Set[str]] = None) -> str:
    import oracle  # noqa: E402  (parses .properties exactly as the dashboard does: escapes, continuations)
    lines = []
    for key, value in oracle.parse_properties(text).items():
        if keep_keys is not None and key not in keep_keys:
            continue
        v = namer.uri(value) if re.match(r'^\s*[A-Za-z][\w+.-]*:', value) else namer.text(value)
        lines.append(f"{namer.text(key)}={v.replace(chr(92), chr(92) * 2)}")
    return '\n'.join(lines) + '\n'


KEEP_PY = set(keyword.kwlist) | set(dir(builtins)) | set(
    'pytest allure mark parametrize fixture usefixtures dynamic label labels feature story epic title tag tags link issue '
    'testcase suite severity description id ids param params request scope autouse self cls pytestmark indirect '
    'skip skipif xfail filterwarnings os sys re json time datetime pathlib Path tmp_path monkeypatch capsys caplog '
    'mocker conftest __name__ __file__ __init__ match case'.split()
)


def anonymize_python(source: str, namer: Namer) -> str:
    """Rename names, strings and drop comments, keeping every line and indent as it was."""
    src = source.replace('\r\n', '\n').replace('\r', '\n')
    lines = src.split('\n')
    starts = [0]
    for ln in lines:
        starts.append(starts[-1] + len(ln) + 1)
    at = lambda pos: starts[pos[0] - 1] + pos[1]  # noqa: E731
    edits = []
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        # not valid Python: rename word by word
        return re.sub(r'[A-Za-z_]\w*', lambda m: m.group(0) if m.group(0) in KEEP_PY else namer.text(m.group(0)), src)
    fstring_middle = getattr(tokenize, 'FSTRING_MIDDLE', None)
    for t in toks:
        a, b = at(t.start), at(t.end)
        if t.type == tokenize.COMMENT:
            edits.append((a, b, '#'))
        elif t.type == tokenize.NAME:
            n = t.string
            if n in KEEP_PY:
                continue
            if n.startswith('test') and n != 'test':
                new = 'test' + namer.text(n[4:])
            elif n.startswith('Test') and n != 'Test':
                new = 'Test' + namer.text(n[4:])
            else:
                new = namer.text(n)
            edits.append((a, b, new))
        elif t.type == tokenize.STRING:
            m = re.match(r'^([rRbBuUfF]{0,2})("""|\'\'\'|"|\')([\s\S]*)\2$', t.string)
            if m:
                body = m.group(3)
                new_body = '\n'.join(namer.text(part) for part in body.split('\n'))
                edits.append((a, b, m.group(1) + m.group(2) + new_body + m.group(2)))
        elif fstring_middle is not None and t.type == fstring_middle:
            edits.append((a, b, namer.text(t.string)))
    out = src
    for a, b, new in sorted(edits, reverse=True):
        out = out[:a] + new + out[b:]
    return out


# ---------------------------------------------------------------------------
# Repros
# ---------------------------------------------------------------------------

def read(p: str) -> str:
    with open(p, encoding='utf-8', errors='replace') as f:
        return f.read()


def walk_files(root: str, ext: str) -> List[str]:
    out = []
    for dp, dns, fns in os.walk(root, followlinks=True):
        dns[:] = [d for d in dns if d not in distill.SKIP_DIRS]
        for fn in fns:
            if fn.lower().endswith(ext):
                out.append(os.path.relpath(os.path.join(dp, fn), root).replace(os.sep, '/'))
    return out


class Repo:
    """The real case dir (repo/__routes__, repo/__tests__, pr/__tests__) with lazy indexes."""

    def __init__(self, case_dir: str) -> None:
        self.case = case_dir
        self.root = os.path.join(case_dir, 'repo')
        self._xml: Optional[List[str]] = None
        self._props: Optional[List[str]] = None
        self._py: Dict[str, List[str]] = {}

    def xml_files(self) -> List[str]:
        if self._xml is None:
            self._xml = [p for p in walk_files(self.root, '.xml') if p.startswith('__routes__/')]
        return self._xml

    def prop_files(self) -> List[str]:
        if self._props is None:
            self._props = [p for p in walk_files(self.root, '.properties') if p.startswith('__routes__/')]
        return self._props

    def py_files(self, side: str) -> List[str]:
        if side not in self._py:
            base = os.path.join(self.case, side)
            self._py[side] = [p for p in walk_files(base, '.py') if p.startswith('__tests__/')]
        return self._py[side]

    def text(self, side: str, rel: str) -> str:
        return read(os.path.join(self.case, side, rel))


def placeholder_keys(text: str) -> Set[str]:
    keys = set()
    for m in re.finditer(r'\{\{([^{}:]+)(?::[^{}]*)?\}\}|\$\{([^{}:]+)(?::[^{}]*)?\}|\$\{properties:([^}:]+)', text):
        keys.add((m.group(1) or m.group(2) or m.group(3)).strip())
    return keys


def route_files(repo: Repo, xml_rel: str) -> Dict[str, List]:
    """The route's XML file, files defining <endpoint>s it refers to, and the properties keys they use."""
    files = [xml_rel]
    text = repo.text('repo', xml_rel)
    refs = set(re.findall(r'\bref\s*=\s*["\']([^"\']+)', text)) | set(re.findall(r'uri\s*=\s*["\']ref:(?://)?([^"\'?]+)', text))
    defined = set(re.findall(r'<\s*(?:\w+:)?endpoint\b[^>]*\bid\s*=\s*["\']([^"\']+)', text))
    for ref in refs - defined:
        for other in repo.xml_files():
            if other != xml_rel and re.search(r'<\s*(?:\w+:)?endpoint\b[^>]*\bid\s*=\s*["\']' + re.escape(ref) + '["\']', repo.text('repo', other)):
                files.append(other)
                break
    keys: Set[str] = set()
    for f in files:
        keys |= placeholder_keys(repo.text('repo', f))
    # values may name other keys
    props = {p: dict(distill.parse_properties(repo.text('repo', p))) for p in repo.prop_files()}
    for _ in range(5):
        more = {k2 for d in props.values() for k, v in d.items() if k in keys for k2 in placeholder_keys(v)} - keys
        if not more:
            break
        keys |= more
    used = [p for p, d in props.items() if keys & set(d)]
    return {'xml': files, 'properties': used, 'keys': sorted(keys)}


def test_files(repo: Repo, side: str, test_ids: List[str]) -> List[str]:
    """The test files, the conftest.py files above them and the modules they import (two levels)."""
    all_py = repo.py_files(side)
    by_suffix = collections.defaultdict(list)
    for p in all_py:
        segs = p[:-3].split('/')
        if segs[-1] == '__init__':
            segs = segs[:-1]
        for k in range(1, len(segs) + 1):
            by_suffix['.'.join(segs[-k:])].append(p)
    want = {tid.split('::')[0] for tid in test_ids}
    want = {w for w in want if w in all_py}
    for _ in range(2):
        add = set()
        for f in want:
            d = f.split('/')[:-1]
            for k in range(1, len(d) + 1):
                c = '/'.join(d[:k] + ['conftest.py'])
                if c in all_py:
                    add.add(c)
            src = repo.text(side, f)
            for m in re.finditer(r'^\s*(?:from\s+(\.*)([\w.]*)\s+import|import\s+([\w.]+))', src, re.M):
                mod = m.group(2) or m.group(3) or ''
                if m.group(1):
                    base = d[:len(d) - (len(m.group(1)) - 1)] if len(m.group(1)) > 1 else d
                    rel = '/'.join(base + mod.split('.')) if mod else '/'.join(base)
                    for c in (rel + '.py', rel + '/__init__.py'):
                        if c in all_py:
                            add.add(c)
                elif mod:
                    found = by_suffix.get(mod) or by_suffix.get(mod.rsplit('.', 1)[0], [])
                    if len(found) == 1:
                        add.add(found[0])
        if add <= want:
            break
        want |= add
    return sorted(want)


def tests_of(diff: Dict) -> List[str]:
    ids: List[str] = []
    for k in ('scanner_via', 'oracle_via', 'scanner_only', 'oracle_only'):
        v = diff.get(k)
        if isinstance(v, dict):
            ids += list(v)
        elif isinstance(v, list):
            ids += [x for x in v if isinstance(x, str) and '::' in x]
    return ids


def pr_tests_of(diff: Dict) -> List[str]:
    out = []
    for k in ('scanner_pr_cov', 'oracle_pr_cov'):
        v = diff.get(k)
        if isinstance(v, (list, dict)):
            out += [x for x in v if isinstance(x, str) and '::' in x]
    return out


def build(report_path: str, case_dir: str, out_dir: str) -> Dict:
    with open(report_path) as f:
        report = json.load(f)
    diffs = report.get('diffs', [])
    stats = report.get('stats', {})
    repo = Repo(case_dir)
    namer = Namer()

    # a few of each kind of disagreement, most common first
    groups = collections.defaultdict(list)
    for d in diffs:
        groups[(d['type'], d.get('kind'))].append(d)
    picked = []
    for _, ds in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        picked += ds[:PER_GROUP]
    picked = picked[:MAX_REPROS]

    shutil.rmtree(out_dir, ignore_errors=True)
    os.makedirs(os.path.join(out_dir, 'repros'))
    work = out_dir + '.work'
    shutil.rmtree(work, ignore_errors=True)
    # what each repro holds, in the original: (side, path, text, how to anonymize, properties keys kept)
    plans = []
    for i, d in enumerate(picked, 1):
        sig = d.get('sig')
        items = []
        if sig and sig[0]:
            rf = route_files(repo, sig[0])
            keys = set(rf['keys'])
            items += [('repo', p, repo.text('repo', p), 'xml', None) for p in rf['xml']]
            items += [('repo', p, repo.text('repo', p), 'properties', keys) for p in rf['properties']]
        items += [('repo', p, repo.text('repo', p), 'python', None) for p in test_files(repo, 'repo', tests_of(d))]
        if d['type'] == 'status':
            items += [('pr', p, repo.text('pr', p), 'python', None) for p in test_files(repo, 'pr', pr_tests_of(d))]
        plans.append((i, d, items))

    def anonymize(kind: str, text: str, keys: Optional[Set[str]]) -> str:
        if kind == 'xml':
            return anonymize_xml(text, namer)
        if kind == 'properties':
            return anonymize_properties(text, namer, keys)
        return anonymize_python(text, namer)

    # two passes, so a renamed word keeps its prefixes (starts with 'PAY' still matches PAYMENTS)
    namer.collect()
    for _, d, items in plans:
        sig = d.get('sig')
        if sig:
            namer.path(sig[0] or '')
            namer.text(sig[1] or '')
        for side, p, text, kind, keys in items:
            namer.path(p)
            anonymize(kind, text, keys)
            if kind == 'xml':
                register_patterns(text, namer)
            elif kind == 'properties':
                register_patterns('?' + '&'.join(text.splitlines()), namer)
    namer.finalize()

    repros = []
    for i, d, items in plans:
        sig = d.get('sig')
        case = {'xml': [], 'properties': [], 'tests': [], 'pr_tests': []}
        for side, p, text, kind, keys in items:
            entry = {'path': namer.path(p), 'text': anonymize(kind, text, keys)}
            case['pr_tests' if side == 'pr' else 'tests' if kind == 'python' else kind].append(entry)
        expected = {
            'type': d['type'],
            'kind': d.get('kind'),
            'route': namer.text(sig[1]) if sig and sig[1] else None,
            'file': namer.path(sig[0]) if sig and sig[0] else None,
            'line': sig[3] if sig else None,
            'oracle': d.get('oracle'),
            'scanner': d.get('scanner'),
        }
        # write it as a case and check it still disagrees the same way
        cdir = os.path.join(work, f'r{i}')
        for side, entries in (('repo', case['xml'] + case['properties'] + case['tests']), ('pr', case['pr_tests'])):
            for it in entries:
                path = os.path.join(cdir, side, it['path'])
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, 'w') as f:
                    f.write(it['text'])
        repros.append({'n': i, 'case': case, 'expected': expected, 'dir': cdir})

    # re-check every repro with both implementations
    import compare  # noqa: E402
    if repros:
        scans = compare.run_scanner([r['dir'] for r in repros])
        for r in repros:
            found: List[Dict] = []
            compare.compare_case(r['dir'], scans[r['dir']], collections.Counter(), found)
            r['reproduces'] = any(x['type'] == r['expected']['type'] for x in found)
            r['found'] = sorted({x['type'] for x in found})

    for r in repros:
        name = f"{r['n']:02d}-{r['expected']['type']}{'-' + r['expected']['kind'] if r['expected']['kind'] else ''}.json"
        with open(os.path.join(out_dir, 'repros', name), 'w') as f:
            json.dump({'expected': r['expected'], 'reproduces_after_renaming': r['reproduces'], 'disagreements_found': r['found'],
                       'xml': r['case']['xml'], 'properties': r['case']['properties'], 'tests': r['case']['tests'], 'pr_tests': r['case']['pr_tests']}, f, indent=1)

    by_type = collections.Counter(d['type'] for d in diffs)
    lines = [
        '# verify-counts: dashboard vs independent implementation (anonymized)',
        '',
        f"- triggers: oracle {stats.get('oracle_triggers', 0)}, dashboard {stats.get('scanner_triggers', 0)}, matched {stats.get('matched', 0)}",
        f"- tested: oracle {stats.get('oracle_tested', 0)}, dashboard {stats.get('scanner_tested', 0)}",
        f"- covered agreement: {stats.get('covered_agree', 0)}/{stats.get('matched', 0)}"
        f" (dashboard says tested, oracle not: {stats.get('covered_FP', 0)}; the other way: {stats.get('covered_FN', 0)})",
        f"- triggers only the oracle finds: {stats.get('trigger_missing_in_scanner', 0)}; only the dashboard: {stats.get('trigger_extra_in_scanner', 0)}",
        f"- disagreements by type: {dict(by_type) if by_type else 'none'}",
        '',
    ]
    if repros:
        lines += ['## Repros', '', f'{len(repros)} of {len(diffs)} disagreements (up to {PER_GROUP} of each type), each anonymized and re-checked:', '']
        for r in repros:
            e = r['expected']
            lines.append(f"- {r['n']:02d} {e['type']}{' (' + e['kind'] + ')' if e['kind'] else ''}: route {e['route'] or '—'} in {e['file'] or '—'}"
                         f"{'' if r['reproduces'] else ' — does NOT reproduce after renaming (found: ' + (', '.join(r['found']) or 'nothing') + ')'}")
    else:
        lines += ['No disagreements: the dashboard and the independent implementation agree on every trigger.']
    with open(os.path.join(out_dir, 'summary.md'), 'w') as f:
        f.write('\n'.join(lines) + '\n')

    with open(out_dir + '.map.json', 'w') as f:
        json.dump({'words': namer.words, 'numbers': namer.numbers}, f, indent=1, sort_keys=True)
    zip_path = out_dir + '.zip'
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for dp, _, fns in os.walk(out_dir):
            for fn in fns:
                full = os.path.join(dp, fn)
                z.write(full, os.path.relpath(full, os.path.dirname(out_dir)))
    shutil.rmtree(work, ignore_errors=True)
    return {'repros': len(repros), 'reproducing': sum(1 for r in repros if r.get('reproduces')), 'zip': zip_path, 'map': out_dir + '.map.json'}


def _anonymize_file(rel: str, text: str, namer: Namer) -> Optional[str]:
    low = rel.lower()
    if low.endswith('.xml'):
        return anonymize_xml(text, namer)
    if low.endswith('.properties'):
        return anonymize_properties(text, namer)
    if rel.endswith('.py'):
        return anonymize_python(text, namer)
    return None


def anonymize_tree(src: str, dst: str, namer: Namer) -> None:
    """Every route XML, properties and Python file of a case dir, anonymized to the same layout."""
    files = []
    for dp, dns, fns in os.walk(src, followlinks=True):
        dns[:] = [d for d in dns if d not in distill.SKIP_DIRS]
        for fn in fns:
            full = os.path.join(dp, fn)
            rel = os.path.relpath(full, src).replace(os.sep, '/')
            if fn.lower().endswith(('.xml', '.properties', '.py')):
                files.append((rel, read(full)))
    # two passes: every word first, so prefixes are assigned consistently
    namer.collect()
    for rel, text in files:
        top, _, rest = rel.partition('/')
        namer.path(rest)
        _anonymize_file(rel, text, namer)
        if rel.lower().endswith('.xml'):
            register_patterns(text, namer)
        elif rel.lower().endswith('.properties'):
            register_patterns('?' + '&'.join(text.splitlines()), namer)
    namer.finalize()
    for rel, text in files:
        top, _, rest = rel.partition('/')  # the case's own folders (repo/, pr/) keep their names
        out = _anonymize_file(rel, text, namer)
        if out is None:
            continue
        p = os.path.join(dst, top, namer.path(rest))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w') as f:
            f.write(out)


def selftest(seeds: str, probes: bool, work: str) -> int:
    """Renaming must never change a count: generated repos and their anonymized copies, scanned, must agree trigger for trigger."""
    import compare  # noqa: E402
    import gen  # noqa: E402
    lo, hi = (int(x) for x in seeds.split(':'))
    shutil.rmtree(work, ignore_errors=True)
    pairs = []
    for seed in range(lo, hi):
        orig, anon = os.path.join(work, f'o{seed}'), os.path.join(work, f'a{seed}')
        gen.write(seed, orig, probes)
        anonymize_tree(orig, anon, Namer())
        pairs.append((orig, anon))
    scans = compare.run_scanner([d for p in pairs for d in p])
    bad = 0
    for orig, anon in pairs:
        a, b = scans[orig], scans[anon]
        shape = lambda s: sorted((t['kind'], t['scheme'], t['patternKind'] or '', bool(t['coveredBy']), t['status']) for t in s['triggers'])  # noqa: E731
        if shape(a) != shape(b) or a['otherRoutes'] != b['otherRoutes'] or len(a['tests']) != len(b['tests']):
            bad += 1
            print(f'differs after renaming: {orig}', file=sys.stderr)
    n_trig = sum(len(scans[o]['triggers']) for o, _ in pairs)
    print(f'selftest: {len(pairs)} repros, {n_trig} triggers, {bad} changed by renaming')
    shutil.rmtree(work, ignore_errors=True)
    return 1 if bad else 0


def build_examples(routes_repo: str, tests_repo: str, pairs: List[tuple], out_dir: str) -> Dict:
    """
    Package a few routes with the test files that are meant to test them, renamed like --share, so
    someone can see how those tests exercise a route. `pairs`: (route id, [test file paths or names]).
    """
    import tempfile
    case = tempfile.mkdtemp(prefix='ptd-examples-')
    os.makedirs(os.path.join(case, 'repo'))
    os.symlink(os.path.abspath(routes_repo), os.path.join(case, 'repo', '__routes__'))
    os.symlink(os.path.abspath(tests_repo), os.path.join(case, 'repo', '__tests__'))
    repo = Repo(case)
    namer = Namer()
    all_py = repo.py_files('repo')
    plans = []
    problems = []
    for route_id, files in pairs:
        xml = next((p for p in repo.xml_files() if re.search(r'\bid\s*=\s*["\']' + re.escape(route_id) + '["\']', repo.text('repo', p))), None)
        if not xml:
            problems.append((route_id, 'no route with this id in the routes repo'))
            continue
        tests = []
        for f in files:
            f = f.strip().lstrip('./')
            found = [p for p in all_py if p == f'__tests__/{f}' or p.endswith('/' + f) or p.split('/')[-1] == f.split('/')[-1]]
            if not found:
                problems.append((route_id, f'no test file named {f.split("/")[-1]} in the test repo'))
            tests += found[:1]
        ids = [f'{t}::x' for t in tests]
        rf = route_files(repo, xml)
        items = [('repo', p, repo.text('repo', p), 'xml', None) for p in rf['xml']]
        items += [('repo', p, repo.text('repo', p), 'properties', set(rf['keys'])) for p in rf['properties']]
        items += [('repo', p, repo.text('repo', p), 'python', None) for p in test_files(repo, 'repo', ids)]
        plans.append((route_id, xml, tests, items))

    def anonymize(kind: str, text: str, keys: Optional[Set[str]]) -> str:
        if kind == 'xml':
            return anonymize_xml(text, namer)
        if kind == 'properties':
            return anonymize_properties(text, namer, keys)
        return anonymize_python(text, namer)

    namer.collect()
    for route_id, _, _, items in plans:
        namer.text(route_id)
        for side, p, text, kind, keys in items:
            namer.path(p)
            anonymize(kind, text, keys)
            if kind == 'xml':
                register_patterns(text, namer)
    namer.finalize()

    shutil.rmtree(out_dir, ignore_errors=True)
    os.makedirs(os.path.join(out_dir, 'examples'))
    work = out_dir + '.work'
    shutil.rmtree(work, ignore_errors=True)
    written = []
    for n, (route_id, xml, tests, items) in enumerate(plans, 1):
        files = {'xml': [], 'properties': [], 'tests': []}
        cdir = os.path.join(work, f'e{n}')
        for side, p, text, kind, keys in items:
            entry = {'path': namer.path(p), 'text': anonymize(kind, text, keys)}
            files['tests' if kind == 'python' else kind].append(entry)
            dst = os.path.join(cdir, 'repo', entry['path'])
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, 'w') as f:
                f.write(entry['text'])
        written.append({'n': n, 'route': namer.text(route_id), 'route_file': namer.path(xml), 'test_files': [namer.path(t) for t in tests], 'files': files, 'dir': cdir})

    # what the dashboard makes of each example (on the renamed copy)
    import compare  # noqa: E402
    if written:
        scans = compare.run_scanner([w['dir'] for w in written])
        for w in written:
            sc = scans[w['dir']]
            mine = [t for t in sc['triggers'] if t['routeId'] == w['route']]
            w['dashboard'] = [{'kind': t['kind'], 'pattern': t['filePattern'], 'tested_by': t['via']} for t in mine]
            w['tests_read'] = len(sc['tests'])

    for w in written:
        with open(os.path.join(out_dir, 'examples', f"{w['n']:02d}-{w['route']}.json"), 'w') as f:
            json.dump({k: w[k] for k in ('route', 'route_file', 'test_files', 'dashboard', 'tests_read', 'files')}, f, indent=1)
    with open(os.path.join(out_dir, 'summary.md'), 'w') as f:
        f.write('# Routes and the tests meant to test them (anonymized)\n\n')
        for w in written:
            linked = any(t['tested_by'] for t in w['dashboard'])
            f.write(f"- {w['route']} ({w['route_file']}): {len(w['test_files'])} test file(s), {w['tests_read']} tests read; "
                    f"the dashboard {'links' if linked else 'does not link'} them\n")
        for rid, msg in problems:
            f.write(f'- route {namer.text(rid)}: {msg if "named" not in msg else "a test file named in the command was not found"}\n')
    with open(out_dir + '.map.json', 'w') as f:
        json.dump({'words': namer.words, 'numbers': namer.numbers}, f, indent=1, sort_keys=True)
    zip_path = out_dir + '.zip'
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for dp, _, fns in os.walk(out_dir):
            for fn in fns:
                full = os.path.join(dp, fn)
                z.write(full, os.path.relpath(full, os.path.dirname(out_dir)))
    shutil.rmtree(work, ignore_errors=True)
    shutil.rmtree(case, ignore_errors=True)
    return {'examples': len(written), 'problems': problems, 'zip': zip_path, 'map': out_dir + '.map.json'}


if __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1] == '--examples':
    import argparse
    ap = argparse.ArgumentParser(prog='share.py --examples', description='Package routes with the tests meant to test them, renamed, to send.')
    ap.add_argument('--examples', action='store_true')
    ap.add_argument('--repo', required=True, help='the Camel routes repo')
    ap.add_argument('--tests', required=True, help='the test repo')
    ap.add_argument('--route', action='append', required=True, metavar='ROUTE_ID=test_a.py,test_b.py',
                    help='a route id and its test files (paths in the test repo, or file names); repeat for each route')
    a = ap.parse_args()
    pairs = [(r.split('=', 1)[0], [f for f in (r.split('=', 1)[1] if '=' in r else '').split(',') if f]) for r in a.route]
    res = build_examples(a.repo, a.tests, pairs, os.path.join(os.getcwd(), 'route-test-examples'))
    for rid, msg in res['problems']:
        print(f'warning: route "{rid}": {msg}')
    print(f"{res['examples']} examples → {res['zip']}  (send this)")
    print(f"keep {res['map']} to yourself: it maps the made-up words back to your names")
    sys.exit(0)

if __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1] == '--selftest':
    sys.exit(selftest(sys.argv[2] if len(sys.argv) > 2 else '0:20', '--probes' in sys.argv, os.path.join(HERE, 'cases-selftest')))

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    report = sys.argv[1]
    case = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, 'cases', 'real')
    out = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.getcwd(), 'verify-counts-share')
    res = build(report, case, out)
    print(f"{res['repros']} repros ({res['reproducing']} still disagree after renaming) → {res['zip']}")
    print(f"keep {res['map']} to yourself (it maps the generic words back to your names)")
