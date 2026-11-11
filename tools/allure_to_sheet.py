#!/usr/bin/env python3
"""
Allure report -> Excel (.xlsx) / CSV results sheet, for failure analysis.

    python3 tools/allure_to_sheet.py REPORT [-o OUT.xlsx] [--csv] [--tests DIR] [--routes-sheet SHEET] [--route-label NAME]
                                            [--eai-branch B] [--t1000-branch B] [--db-schema S] [--inspect]

REPORT is any of:
  - a generated Allure report folder (the one with index.html and data/test-cases/),
  - a .zip of that folder,
  - a single-file report (allure generate --single-file): its index.html,
  - an allure-results folder (or .zip) of *-result.json files.

The sheet starts with the run's details (report name, date ran, duration, EAI build branch, T1000 branch and DB
schema - "TO FILL IN" unless given or in the environment - environment, executor, totals), then one
row per test:

  Test File | Test Name | Route Tested | Result | Failure from script | RCA (after manual analysis) | Test Script Fix Required | Bug id

The first five are filled in; the last three are for you. A passed test says N/A in Failure, RCA,
Test Script Fix Required and Bug id. Failures come first.
  - Test File: the test's module (allure-pytest's `package` label, else its fullName:
    tests.routes.test_x.TestY#test_z -> tests/routes/test_x.py).
  - Route Tested, the first of:
      a `route` / `route_id` label on the test (allure.dynamic.label("route", ...)), or a test
      parameter of that name (--route-label adds another name);
      a "Route id: ..." line in the test's description or a step's name;
      with --tests DIR (your test repo): the test's own .py file - a "Route id: ..." line in the
      test's, its class's or its module's docstring, else ROUTE_ID = "..." set by its class or a class
      it inherits from (in another file too) or its module, else "route <id>" in a docstring's first
      line (a module docstring isn't in the report, so this needs the file);
      with --routes-sheet SHEET: the routes your sheet lists for the test's file.
  - --inspect prints what a report holds per test (label and parameter names, descriptions, steps).

Fully standalone: only the Python standard library; it reads the report and the files you name.
"""
from __future__ import annotations

import argparse
import base64
import csv
import io
import json
import os
import re
import sys
import zipfile
from datetime import datetime
from typing import Any, Iterable, Optional
from xml.sax.saxutils import escape

COLUMNS = ['Test File', 'Test Name', 'Route Tested', 'Result', 'Failure from script', 'RCA (after manual analysis)', 'Test Script Fix Required', 'Bug id']
ROUTE_LABELS = {'route', 'route_id', 'routeid', 'route-id', 'camel_route', 'camel-route', 'camelroute'}
STATUS_ORDER = {'failed': 0, 'broken': 1, 'unknown': 2, 'skipped': 3, 'passed': 4}
MAX_FAILURE_CHARS = 2000  # the message, not the trace: enough to read, short enough for a cell
MAX_FILE_BYTES = 50 * 1024 * 1024


# ---------------------------------------------------------------------------
# Reading the report: every file of it as {relative path: bytes}
# ---------------------------------------------------------------------------

def _wanted(path: str) -> bool:
    p = path.replace('\\', '/').lower()
    return (
        p.endswith('.json') and ('/data/' in f'/{p}' or '/widgets/' in f'/{p}' or p.endswith('-result.json') or p.endswith('executor.json'))
    ) or p.endswith('environment.properties') or p.endswith('index.html')


def read_files(report: str) -> dict[str, bytes]:
    """The report's data files, by path relative to its root (folder, zip or single-file html)."""
    files: dict[str, bytes] = {}
    if os.path.isdir(report):
        for root, _, names in os.walk(report):
            for n in names:
                full = os.path.join(root, n)
                rel = os.path.relpath(full, report).replace(os.sep, '/')
                if _wanted(rel) and os.path.getsize(full) <= MAX_FILE_BYTES:
                    with open(full, 'rb') as f:
                        files[rel] = f.read()
    elif zipfile.is_zipfile(report):
        with zipfile.ZipFile(report) as z:
            for info in z.infolist():
                if not info.is_dir() and _wanted(info.filename) and info.file_size <= MAX_FILE_BYTES:
                    files[info.filename] = z.read(info)
    elif report.lower().endswith(('.html', '.htm')):
        with open(report, 'rb') as f:
            files['index.html'] = f.read()
    else:
        raise SystemExit(f'{report}: not a folder, a .zip or an .html file')
    # a single-file report keeps every data file inside index.html: d('data/test-cases/x.json','<base64>')
    for path, data in list(files.items()):
        if path.lower().endswith('index.html'):
            base = path[: -len('index.html')]
            text = data.decode('utf-8', 'replace')
            for m in re.finditer(r"""\bd\(\s*(['"])([^'"]+\.(?:json|properties))\1\s*,\s*(['"])([A-Za-z0-9+/=\s]*)\3\s*\)""", text):
                try:
                    files.setdefault(base + m.group(2), base64.b64decode(re.sub(r'\s+', '', m.group(4))))
                except ValueError:
                    pass
    return files


def _json(data: bytes) -> Any:
    try:
        return json.loads(data.decode('utf-8-sig'))
    except (ValueError, UnicodeDecodeError):
        return None


def _strip_root(files: dict[str, bytes]) -> dict[str, bytes]:
    """Paths relative to the report root, whatever folder the zip wrapped it in."""
    roots = set()
    for p in files:
        m = re.search(r'(^|/)(data|widgets)/', p)
        if m:
            roots.add(p[: m.start(2)])
    if len(roots) == 1:
        root = roots.pop()
        return {p[len(root):] if p.startswith(root) else p: d for p, d in files.items()}
    return files


# ---------------------------------------------------------------------------
# Tests and run details
# ---------------------------------------------------------------------------

def _labels(raw: Any) -> list[tuple[str, str]]:
    out = []
    for l in raw or []:
        if isinstance(l, dict) and l.get('name') is not None and l.get('value') is not None:
            out.append((str(l['name']), str(l['value'])))
    return out


def _text(v: Any) -> str:
    """A description as plain text (descriptionHtml's tags and entities removed)."""
    if not isinstance(v, str):
        return ''
    t = re.sub(r'<br\s*/?>|</p>|</li>|</div>', '\n', v, flags=re.I)
    t = re.sub(r'<[^>]+>', '', t)
    return t.replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"').replace('&#39;', "'").replace('&amp;', '&')


def _step_names(steps: Any, depth: int = 0) -> list[str]:
    """The names of a test's steps, nested ones too (allure.step(...))."""
    out: list[str] = []
    if not isinstance(steps, list) or depth > 20:
        return out
    for st in steps:
        if isinstance(st, dict):
            if st.get('name'):
                out.append(str(st['name']))
            out.extend(_step_names(st.get('steps'), depth + 1))
    return out[:500]


def load_tests(files: dict[str, bytes]) -> list[dict]:
    """One dict per test: name, fullName, status, message, labels, start."""
    tests: list[dict] = []
    cases = {p: _json(d) for p, d in files.items() if re.search(r'(^|/)data/test-cases/[^/]+\.json$', p)}
    if cases:
        # retried attempts are their own (hidden) files, listed in the last attempt's extra.retries
        retried = set()
        for c in cases.values():
            for r in ((c or {}).get('extra') or {}).get('retries') or []:
                if isinstance(r, dict) and r.get('uid'):
                    retried.add(r['uid'])
        for c in cases.values():
            if not isinstance(c, dict) or c.get('hidden') or c.get('retry') or c.get('uid') in retried:
                continue
            tests.append({
                'name': str(c.get('name') or c.get('fullName') or ''),
                'fullName': c.get('fullName') or '',
                'status': str(c.get('status') or 'unknown').lower(),
                'message': c.get('statusMessage') or '',
                'labels': _labels(c.get('labels')),
                'parameters': _labels(c.get('parameters')),
                'description': _text(c.get('description') or c.get('descriptionHtml')),
                'steps': _step_names((c.get('testStage') or {}).get('steps')),
                'start': ((c.get('time') or {}).get('start')),
            })
        return tests
    # allure-results: *-result.json (one per attempt; the latest attempt of each test wins)
    latest: dict[str, dict] = {}
    for p, d in files.items():
        if not p.lower().endswith('-result.json'):
            continue
        r = _json(d)
        if not isinstance(r, dict):
            continue
        key = r.get('historyId') or r.get('testCaseId') or r.get('fullName') or r.get('name') or p
        t = {
            'name': str(r.get('name') or r.get('fullName') or ''),
            'fullName': r.get('fullName') or '',
            'status': str(r.get('status') or 'unknown').lower(),
            'message': ((r.get('statusDetails') or {}).get('message')) or '',
            'labels': _labels(r.get('labels')),
            'parameters': _labels(r.get('parameters')),
            'description': _text(r.get('description') or r.get('descriptionHtml')),
            'steps': _step_names(r.get('steps')),
            'start': r.get('start'),
        }
        old = latest.get(key)
        if old is None or (t['start'] or 0) >= (old['start'] or 0):
            latest[key] = t
    return list(latest.values())


def _properties(text: str) -> list[tuple[str, str]]:
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line[0] in '#!':
            continue
        m = re.match(r'([^=:\s]+)\s*[=:\s]\s*(.*)$', line)
        if m:
            out.append((m.group(1), m.group(2)))
    return out


PLACEHOLDER = 'TO FILL IN'
# rows of the top section to fill in by hand when the report doesn't say: (label, environment key that gives it)
MANUAL_DETAILS = [
    ('EAI build branch', re.compile(r'(eai.*branch|branch.*eai|build[_ .-]?branch)', re.I)),
    ('T1000 branch', re.compile(r't1000.*branch|branch.*t1000', re.I)),
    ('DB schema', re.compile(r'(db|database).*schema|^schema$', re.I)),
]
# the command-line option for each, for the "fill in" reminder
MANUAL_OPTION = {'EAI build branch': '--eai-branch', 'T1000 branch': '--t1000-branch', 'DB schema': '--db-schema'}


def load_details(files: dict[str, bytes], tests: list[dict], report_path: str, manual: Optional[dict[str, str]] = None) -> list[tuple[str, str]]:
    """The run's details, as label/value rows for the top of the sheet."""
    def find(suffix: str) -> Optional[bytes]:
        for p, d in files.items():
            if p.lower().endswith(suffix):
                return d
        return None

    summary = _json(find('widgets/summary.json') or b'null') or {}
    base = os.path.basename(os.path.normpath(report_path))
    if base.lower() in ('index.html', 'index.htm'):
        base = os.path.basename(os.path.dirname(os.path.abspath(report_path))) or base
    base = re.sub(r'\.(zip|html?)$', '', base, flags=re.I)
    name = summary.get('reportName') if isinstance(summary, dict) else None
    rows: list[tuple[str, str]] = [('Allure report', name if name and name != 'Allure Report' else base)]
    if name and name != 'Allure Report' and base and base != name:
        rows.append(('Report file', base))

    t = (summary.get('time') if isinstance(summary, dict) else None) or {}
    starts = [x['start'] for x in tests if isinstance(x.get('start'), (int, float))]
    start = t.get('start') or (min(starts) if starts else None)
    if start:
        rows.append(('Date ran', datetime.fromtimestamp(start / 1000).strftime('%Y-%m-%d %H:%M')))
        stop = t.get('stop')
        if stop and stop >= start:
            mins, secs = divmod(int((stop - start) / 1000), 60)
            hours, mins = divmod(mins, 60)
            rows.append(('Duration', f'{hours}h {mins:02d}m {secs:02d}s' if hours else f'{mins}m {secs:02d}s'))

    env_rows: list[tuple[str, str]] = []
    env = _json(find('widgets/environment.json') or b'null')
    if isinstance(env, list) and env:
        for e in env:
            if isinstance(e, dict) and e.get('name'):
                vals = e.get('values') or []
                env_rows.append((str(e['name']), ', '.join(str(v) for v in vals) if isinstance(vals, list) else str(vals)))
    else:
        props = find('environment.properties')
        env_rows.extend(_properties(props.decode('utf-8', 'replace')) if props else [])
    # the EAI build branch, T1000 branch and DB schema: given on the command line, else from the environment, else to fill in
    for label, key in MANUAL_DETAILS:
        given = (manual or {}).get(label)
        from_env = next((v for k, v in env_rows if key.search(k) and v.strip()), None)
        rows.append((label, given or from_env or PLACEHOLDER))
    rows.extend((f'Env: {k}', v) for k, v in env_rows)

    execs = _json(find('widgets/executors.json') or b'null')
    if not isinstance(execs, list):
        one = _json(find('executor.json') or b'null')
        execs = [one] if isinstance(one, dict) else []
    for e in execs:
        if isinstance(e, dict):
            parts = [str(e[k]) for k in ('name', 'buildName') if e.get(k)]
            if parts or e.get('buildUrl'):
                rows.append(('Executor', ' · '.join(parts) + (f" ({e['buildUrl']})" if e.get('buildUrl') else '')))

    counts: dict[str, int] = {}
    for x in tests:
        counts[x['status']] = counts.get(x['status'], 0) + 1
    rows.append(('Results', f'{len(tests)} tests: ' + ', '.join(f'{counts[s]} {s}' for s in sorted(counts, key=lambda s: STATUS_ORDER.get(s, 9)))))
    return rows


# ---------------------------------------------------------------------------
# Route Tested
# ---------------------------------------------------------------------------

def _plain_full_name(full: str) -> str:
    """tests.x.test_a.TestB#test_c[param] -> tests.x.test_a.TestB#test_c"""
    return re.sub(r'\[.*\]$', '', full or '').strip()


ROUTE_IN_TEXT = re.compile(r'^[\s*\-•|]*route[\s_-]*id\s*[:=]\s*`{0,2}([A-Za-z0-9][\w.\-/]*)', re.I | re.M)


def routes_of(
    test: dict,
    route_labels: set[str] = ROUTE_LABELS,
    by_file: Optional[dict[str, list[str]]] = None,
    sources: Optional['TestSources'] = None,
) -> str:
    """
    The route(s) the test names: its route labels, else a route parameter, else a "Route id: x" line in
    its description or a step's name, else its source file's docstrings or ROUTE_ID (--tests), else the
    routes your sheet (--routes-sheet) lists for its file.
    """
    found: list[str] = []

    def add(value: str) -> None:
        for part in re.split(r'[,;]\s*', value):
            part = part.strip().strip('\'"`')
            if part and part not in found:
                found.append(part)

    for n, v in test['labels']:
        if n.strip().lower() in route_labels:
            add(v)
    if not found:
        for n, v in test['parameters']:
            if n.strip().lower() in route_labels:
                add(v)
    if not found:
        for text in [test.get('description') or ''] + list(test.get('steps') or []):
            for m in ROUTE_IN_TEXT.finditer(text):
                add(m.group(1))
    if not found and sources is not None:
        for r in sources.routes(test):
            add(r)
    if not found and by_file:
        f = test_file(test)
        for key in (os.path.basename(f).lower(), re.sub(r'\.py$', '', os.path.basename(f).lower())):
            for r in by_file.get(key, []):
                add(r)
    return '; '.join(found)


ROUTE_IN_FIRST_LINE = re.compile(r'\broute\s+`{0,2}([A-Za-z0-9][\w.]*-[\w.\-]*[A-Za-z0-9])', re.I)
ROUTE_CONST = re.compile(r'^(route_?id|route)$', re.I)


class TestSources:
    """
    The test repo (--tests): a test's route from its own .py file, which the report doesn't carry:
    a "Route id: x" line in the test's, its class's or its module's docstring, else ROUTE_ID = "x"
    set by its class or a class it inherits from (in another file too), else by its module, else
    "route x" in a docstring's first line.
    """

    def __init__(self, root: str):
        import ast  # noqa: F401  (stdlib; imported here so the rest runs without it being used)
        self.root = root
        self.by_rel: dict[str, str] = {}
        self.by_base: dict[str, list[str]] = {}
        for dp, dns, fns in os.walk(root):
            dns[:] = [d for d in dns if not d.startswith('.') and d not in ('node_modules', '__pycache__', 'venv', '.venv')]
            for f in fns:
                if f.endswith('.py'):
                    full = os.path.join(dp, f)
                    rel = os.path.relpath(full, root).replace(os.sep, '/')
                    self.by_rel[rel] = full
                    self.by_base.setdefault(f.lower(), []).append(full)
        self.cache: dict[str, Any] = {}
        self.misses: dict[str, list[str]] = {}

    def _file(self, test_path: str) -> Optional[str]:
        if not test_path:
            return None
        # the report's module path may start lower or higher than the folder given: match on the longest tail
        for rel, full in self.by_rel.items():
            if rel == test_path or rel.endswith('/' + test_path) or test_path.endswith('/' + rel):
                return full
        same = self.by_base.get(os.path.basename(test_path).lower(), [])
        return same[0] if len(same) == 1 else None

    def _tree(self, full: str) -> Any:
        if full not in self.cache:
            import ast
            try:
                import warnings
                with open(full, encoding='utf-8-sig', errors='replace') as f:  # -sig: a BOM isn't Python
                    source = f.read()
                # the test repo's own warnings ("\\c" in a Windows path string) aren't this script's to report
                with warnings.catch_warnings():
                    warnings.simplefilter('ignore')
                    self.cache[full] = ast.parse(source, filename=full)
            except (SyntaxError, ValueError, OSError):
                self.cache[full] = None
        return self.cache[full]

    def _module_file(self, module: str, near: str) -> Optional[str]:
        """The .py file of an imported module (`from x.y import C`): matched on its path tail, else next to `near`."""
        tail = module.lstrip('.').replace('.', '/')
        if not tail:
            return None
        hits = [full for rel, full in self.by_rel.items() if rel == f'{tail}.py' or rel.endswith(f'/{tail}.py') or rel.endswith(f'/{tail}/__init__.py')]
        if len(hits) == 1:
            return hits[0]
        local = os.path.join(os.path.dirname(near), tail.split('/')[-1] + '.py')
        return local if os.path.exists(local) else (hits[0] if hits else None)

    def _imports(self, tree: Any, full: str) -> dict[str, tuple[str, str]]:
        """name -> (file, name there) for `from x import Name [as Alias]`."""
        import ast
        out: dict[str, tuple[str, str]] = {}
        for node in tree.body:
            if isinstance(node, ast.ImportFrom) and node.module:
                f = self._module_file(node.module, full)
                if f:
                    for al in node.names:
                        out[al.asname or al.name] = (f, al.name)
        return out

    def _value(self, value: Any, tree: Any, full: str, depth: int = 0) -> Optional[str]:
        """A string constant, or a name standing for one (ROUTE_ID = ROUTE_ID, an imported constant)."""
        import ast
        if isinstance(value, ast.Constant) and isinstance(value.value, str) and value.value.strip():
            return value.value.strip()
        if isinstance(value, ast.Name) and depth < 4:
            for node in tree.body:
                targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, ast.AnnAssign) else []
                if any(isinstance(t, ast.Name) and t.id == value.id for t in targets):
                    return self._value(getattr(node, 'value', None), tree, full, depth + 1)
            imp = self._imports(tree, full).get(value.id)
            if imp:
                other = self._tree(imp[0])
                if other is not None:
                    return self._value(ast.Name(id=imp[1]), other, imp[0], depth + 1)
        return None

    def _const(self, body: list, tree: Any, full: str) -> list[str]:
        """ROUTE_ID / ROUTE = "x" (or = a constant naming it) in a class or module body."""
        import ast
        out = []
        for node in body:
            targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, ast.AnnAssign) else []
            for t in targets:
                if isinstance(t, ast.Name) and ROUTE_CONST.match(t.id):
                    v = self._value(getattr(node, 'value', None), tree, full)
                    if v:
                        out.append(v)
        return out

    def _class_chain(self, cls: Any, tree: Any, full: str, depth: int = 0) -> list[tuple[Any, Any, str]]:
        """The class and its bases, in the same file or imported from another (`from x import Base`), nearest first."""
        import ast
        chain = [(cls, tree, full)]
        if depth >= 6:
            return chain
        imports = self._imports(tree, full)
        for b in cls.bases:
            name = b.id if isinstance(b, ast.Name) else b.attr if isinstance(b, ast.Attribute) else None
            if not name:
                continue
            here = next((n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == name and n is not cls), None)
            if here is not None:
                chain += self._class_chain(here, tree, full, depth + 1)
            elif name in imports:
                f, orig = imports[name]
                other = self._tree(f)
                there = next((n for n in other.body if isinstance(n, ast.ClassDef) and n.name == orig), None) if other is not None else None
                if there is not None:
                    chain += self._class_chain(there, other, f, depth + 1)
        return chain

    def routes(self, test: dict) -> list[str]:
        import ast
        path = test_file(test)
        full = self._file(path)
        tree = self._tree(full) if full else None
        if tree is None:
            # for the summary: which tests' files weren't in --tests, or didn't parse
            self.misses.setdefault('not found' if not full else 'not readable as Python', []).append(path or test['fullName'] or test['name'])
            return []
        mod, _, func = _plain_full_name(test['fullName']).partition('#')
        func = func or re.sub(r'\[.*\]$', '', test['name'])
        classes = [p for p in mod.split('.') if p[:1].isupper()]
        # the test's own nodes: its class(es), then the function
        scopes: list[Any] = []
        body = tree.body
        for cname in classes:
            node = next((n for n in body if isinstance(n, ast.ClassDef) and n.name == cname), None)
            if node is None:
                break
            scopes.append(node)
            body = node.body
        fn = next((n for n in body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == func), None)
        docs = [ast.get_docstring(n) or '' for n in ([fn] if fn else []) + scopes[::-1] + [tree]]
        # 1. a "Route id: x" line in the test's, its class's or its module's docstring
        for d in docs:
            hits = [m.group(1) for m in ROUTE_IN_TEXT.finditer(d)]
            if hits:
                return hits
        # 2. ROUTE_ID set by the test's class or one it inherits from (other files too), else by the module
        for cls in scopes[::-1]:
            for c, t, f in self._class_chain(cls, tree, full):
                hits = self._const(c.body, t, f)
                if hits:
                    return hits
        hits = self._const(tree.body, tree, full)
        if hits:
            return hits
        # 3. "route x" in a docstring's first line
        for d in docs:
            first = d.strip().splitlines()[0] if d.strip() else ''
            m = ROUTE_IN_FIRST_LINE.search(first)
            if m:
                return [m.group(1)]
        return []


def read_sheet(path: str) -> list[list[str]]:
    """Rows of a .csv/.tsv, or of the first sheet of an .xlsx with a route id column (stdlib only)."""
    if not path.lower().endswith(('.xlsx', '.xlsm')):
        with open(path, newline='', encoding='utf-8-sig', errors='replace') as f:
            sample = f.read(4096)
            f.seek(0)
            try:
                dialect = csv.Sniffer().sniff(sample, delimiters=',;\t') if sample else csv.excel
            except csv.Error:
                dialect = csv.excel
            return [row for row in csv.reader(f, dialect)]
    import xml.etree.ElementTree as ET
    ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        shared: list[str] = []
        if 'xl/sharedStrings.xml' in names:
            for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', ns):
                shared.append(''.join(t.text or '' for t in si.iter('{%s}t' % ns['m'])))
        wb = ET.fromstring(z.read('xl/workbook.xml'))
        rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
        target = {r.get('Id'): r.get('Target') or '' for r in rels}
        sheets = []
        for sh in wb.find('m:sheets', ns) or []:
            t = target.get(sh.get('{%s}id' % ns['r']), '')
            sheets.append(t.lstrip('/') if t.lstrip('/').startswith('xl/') else 'xl/' + t)

        def rows_of(sheet_path: str) -> list[list[str]]:
            out: list[list[str]] = []
            for row in ET.fromstring(z.read(sheet_path)).iter('{%s}row' % ns['m']):
                cells: dict[int, str] = {}
                for c in row.findall('m:c', ns):
                    ref = re.match(r'([A-Z]+)', c.get('r', 'A'))
                    col = 0
                    for ch in ref.group(1) if ref else 'A':
                        col = col * 26 + ord(ch) - 64
                    v = c.find('m:v', ns)
                    t = c.get('t')
                    if t == 's' and v is not None and v.text:
                        text = shared[int(v.text)]
                    elif t == 'inlineStr':
                        text = ''.join(x.text or '' for x in c.iter('{%s}t' % ns['m']))
                    else:
                        text = v.text if v is not None and v.text else ''
                    cells[col - 1] = text
                if cells:
                    out.append([cells.get(i, '') for i in range(max(cells) + 1)])
            return out

        for sp in sheets:
            if sp in names:
                rows = rows_of(sp)
                if rows and any(re.sub(r'[^a-z]', '', h.lower()) in ('routeid', 'route') for h in rows[0]):
                    return rows
        return rows_of(sheets[0]) if sheets and sheets[0] in names else []


def routes_by_file(path: str) -> dict[str, list[str]]:
    """Your sheet of routes (a route id column and a test files column) as test file -> route ids."""
    rows = read_sheet(path)
    head = 0
    # the header row: the first with a route id column (a title row may come first)
    for i, r in enumerate(rows[:10]):
        if any(re.sub(r'[^a-z]', '', h.lower()) in ('routeid', 'route') for h in r):
            head = i
            break
    canon = [re.sub(r'[^a-z]', '', h.lower()) for h in (rows[head] if rows else [])]

    def col(*names: str) -> int:
        for n in names:
            if n in canon:
                return canon.index(n)
        return -1

    c_id, c_files = col('routeid', 'route'), col('testfiles', 'testfile', 'tests', 'testname', 'testnames')
    if c_id < 0 or c_files < 0:
        raise SystemExit(f'{path}: needs a route id column and a test files column (found: {", ".join(rows[head]) if rows else "nothing"})')
    out: dict[str, list[str]] = {}
    for r in rows[head + 1:]:
        cell = lambda i: (r[i] if 0 <= i < len(r) else '').strip()  # noqa: E731
        rid = cell(c_id)
        if not rid:
            continue
        for f in re.split(r'[;,\s]+', cell(c_files)):
            base = os.path.basename(f.replace('\\', '/')).lower()
            if base:
                for key in (base, re.sub(r'\.py$', '', base)):
                    if rid not in out.setdefault(key, []):
                        out[key].append(rid)
    return out


# ---------------------------------------------------------------------------
# The table
# ---------------------------------------------------------------------------

def _failure(test: dict) -> str:
    """The failure message on one line (its lines joined with " | "): a line break would make the row tall
    wherever the cell is pasted."""
    if test['status'] == 'passed':
        return 'N/A'
    msg = ' | '.join(x.strip() for x in str(test['message'] or '').splitlines() if x.strip())
    return msg if len(msg) <= MAX_FAILURE_CHARS else msg[: MAX_FAILURE_CHARS - 1] + '…'


def test_file(test: dict) -> str:
    """The test's .py file: allure-pytest's `package` label (dotted module), else the module part of its fullName."""
    pkg = next((v for n, v in test['labels'] if n == 'package' and v.strip()), '')
    if not pkg:
        mod = _plain_full_name(test['fullName']).split('#')[0]
        parts = mod.split('.') if mod else []
        # drop the classes (TestX, and nested ones) at the end: what is left is the module
        while parts and parts[-1][:1].isupper():
            parts.pop()
        pkg = '.'.join(parts)
    pkg = re.sub(r'\.py$', '', pkg.strip())
    return f"{pkg.replace('.', '/')}.py" if pkg else ''


def build_rows(
    tests: list[dict],
    route_labels: set[str] = ROUTE_LABELS,
    by_file: Optional[dict[str, list[str]]] = None,
    sources: Optional[TestSources] = None,
) -> list[list[str]]:
    ordered = sorted(tests, key=lambda t: (STATUS_ORDER.get(t['status'], 9), t['fullName'] or t['name'], t['name']))
    # a passed test needs no analysis: Failure, RCA, Test Script Fix Required and Bug id say N/A; the others are left for people
    return [
        [test_file(t), t['name'], routes_of(t, route_labels, by_file, sources), t['status'].capitalize(), _failure(t)] + (['N/A'] * 3 if t['status'] == 'passed' else ['', '', ''])
        for t in ordered
    ]


# ---------------------------------------------------------------------------
# Writing: CSV, and .xlsx with the standard library (a zip of a few XML parts)
# ---------------------------------------------------------------------------

def write_csv(path: str, details: list[tuple[str, str]], rows: list[list[str]]) -> None:
    with open(path, 'w', newline='', encoding='utf-8-sig') as f:  # the BOM makes Excel read UTF-8
        w = csv.writer(f)
        for k, v in details:
            w.writerow([k, v])
        w.writerow([])
        w.writerow(COLUMNS)
        w.writerows(rows)


_ILLEGAL_XML = re.compile('[\x00-\x08\x0b\x0c\x0e-\x1f]')


def _col(i: int) -> str:
    s = ''
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def _cell(ref: str, value: str, style: int = 0) -> str:
    v = escape(_ILLEGAL_XML.sub('', str(value)))[:32767]
    s = f' s="{style}"' if style else ''
    return f'<c r="{ref}" t="inlineStr"{s}><is><t xml:space="preserve">{v}</t></is></c>' if value != '' else (f'<c r="{ref}"{s}/>' if style else '')


def _empty_text(ref: str, style: int) -> str:
    """A cell that shows nothing but isn't empty (=""), so the failure next to it can't spill into it."""
    return f'<c r="{ref}" s="{style}" t="str"><f>""</f><v></v></c>'


# styles: 0 default, 1 bold, 2 header (bold, grey fill, border), 3 a table cell, 4 failed, 5 broken, 6 passed,
# 7 skipped, 8 to fill in. Nothing wraps and every value is one line, so a row is one line high here and wherever
# it is pasted (Excel sizes pasted rows to wrapped text). A long failure is cut at its cell's edge rather than
# spilling over: the blank RCA / Fix / Bug id cells next to it hold ="" (see _empty_text). The whole text is in
# the cell (the formula bar shows it).
_STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="6"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><color rgb="FFB42318"/><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFB54708"/><sz val="11"/><name val="Calibri"/></font>
<font><color rgb="FF067647"/><sz val="11"/><name val="Calibri"/></font><font><color rgb="FF667085"/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE4E7EC"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFEF0C7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FF98A2B3"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
</cellXfs></styleSheet>"""
_RESULT_STYLE = {'Failed': 4, 'Broken': 5, 'Passed': 6, 'Skipped': 7}
_WIDTHS = [40, 44, 32, 10, 70, 30, 25, 12]
ROW_HEIGHT = 15  # points: one line of Calibri 11, so every row stays thin whatever its text


def write_xlsx(path: str, details: list[tuple[str, str]], rows: list[list[str]]) -> None:
    out = io.StringIO()
    r = 0
    for k, v in details:
        r += 1
        out.write(f'<row r="{r}">{_cell(f"A{r}", k, 1)}{_cell(f"B{r}", v, 8 if v == PLACEHOLDER else 0)}</row>')
    r += 1  # blank row
    head = r + 1
    out.write(f'<row r="{head}" ht="{ROW_HEIGHT + 3}" customHeight="1">' + ''.join(_cell(f'{_col(i)}{head}', c, 2) for i, c in enumerate(COLUMNS)) + '</row>')
    manual = {COLUMNS.index(c) for c in ('RCA (after manual analysis)', 'Test Script Fix Required', 'Bug id')}
    for i, row in enumerate(rows):
        n = head + 1 + i
        cells = []
        for j, v in enumerate(row):
            style = _RESULT_STYLE.get(v, 3) if j == COLUMNS.index('Result') else 3
            cells.append(_empty_text(f'{_col(j)}{n}', style) if j in manual and v == '' else _cell(f'{_col(j)}{n}', v, style))
        out.write(f'<row r="{n}" ht="{ROW_HEIGHT}" customHeight="1">' + ''.join(cells) + '</row>')
    last = head + max(len(rows), 1)
    cols = ''.join(f'<col min="{i + 1}" max="{i + 1}" width="{w}" customWidth="1"/>' for i, w in enumerate(_WIDTHS))
    fix_col = _col(COLUMNS.index('Test Script Fix Required'))
    sheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<sheetViews><sheetView workbookViewId="0"><pane ySplit="{head}" topLeftCell="A{head + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
        f'<sheetFormatPr defaultRowHeight="{ROW_HEIGHT}" customHeight="1"/>'
        f'<cols>{cols}</cols><sheetData>{out.getvalue()}</sheetData>'
        f'<autoFilter ref="A{head}:{_col(len(COLUMNS) - 1)}{last}"/>'
        '<dataValidations count="1">'
        f'<dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="{fix_col}{head + 1}:{fix_col}{max(last, head + 1000)}">'
        '<formula1>"Yes,No,N/A"</formula1></dataValidation></dataValidations>'
        '</worksheet>'
    )
    parts = {
        '[Content_Types].xml': (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            '</Types>'
        ),
        '_rels/.rels': (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>'
        ),
        'xl/workbook.xml': (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets><sheet name="Results" sheetId="1" r:id="rId1"/></sheets>'
            f'<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Results!$A${head}:${_col(len(COLUMNS) - 1)}${last}</definedName></definedNames>'
            '</workbook>'
        ),
        'xl/_rels/workbook.xml.rels': (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            '</Relationships>'
        ),
        'xl/styles.xml': _STYLES,
        'xl/worksheets/sheet1.xml': sheet,
    }
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, text in parts.items():
            z.writestr(name, text)


# ---------------------------------------------------------------------------

def convert(
    report: str,
    out: Optional[str] = None,
    want_csv: bool = False,
    route_labels: Iterable[str] = (),
    routes_sheet: Optional[str] = None,
    eai_branch: Optional[str] = None,
    db_schema: Optional[str] = None,
    tests_dir: Optional[str] = None,
    t1000_branch: Optional[str] = None,
) -> dict:
    files = _strip_root(read_files(report))
    tests = load_tests(files)
    if not tests:
        raise SystemExit(f'{report}: no tests found (expected data/test-cases/*.json, a single-file index.html, or *-result.json)')
    details = load_details(files, tests, report, {k: v for k, v in (('EAI build branch', eai_branch), ('T1000 branch', t1000_branch), ('DB schema', db_schema)) if v})
    by_file = routes_by_file(routes_sheet) if routes_sheet else None
    if tests_dir and not os.path.isdir(tests_dir):
        raise SystemExit(f'{tests_dir}: not a folder')
    sources = TestSources(tests_dir) if tests_dir else None
    rows = build_rows(tests, ROUTE_LABELS | {x.strip().lower() for x in route_labels if x.strip()}, by_file, sources)
    route_col = COLUMNS.index('Route Tested')
    file_col = COLUMNS.index('Test File')
    # why a route is missing, for the summary
    diagnose: dict[str, Any] = {}
    if sources is not None:
        diagnose['py files in --tests'] = len(sources.by_rel)
        diagnose['misses'] = {k: sorted(set(v)) for k, v in sources.misses.items()}
        found = {r[file_col] for r in rows if r[file_col] and sources._file(r[file_col])}
        diagnose['found, no route in it'] = sorted({r[file_col] for r in rows if not r[route_col] and r[file_col] in found})
    if out is None:
        stem = re.sub(r'\.(zip|html?)$', '', os.path.normpath(report), flags=re.I)
        if os.path.basename(stem).lower() == 'index':
            stem = os.path.join(os.path.dirname(stem), os.path.basename(os.path.dirname(os.path.abspath(stem))) or 'allure')
        out = stem.rstrip('/\\') + '-results.xlsx'
    is_csv = out.lower().endswith('.csv')
    stem = re.sub(r'\.(xlsx|csv)$', '', out, flags=re.I)
    exts = ['.csv'] if is_csv else ['.xlsx', '.csv'] if want_csv else ['.xlsx']
    paths = unused_paths(stem, exts)
    for path in paths:
        (write_csv if path.endswith('.csv') else write_xlsx)(path, details, rows)
    written = paths
    return {'files': written, 'tests': len(rows), 'details': details, 'withRoute': sum(1 for r in rows if r[route_col]), 'diagnose': diagnose}


def unused_paths(stem: str, exts: list[str]) -> list[str]:
    """stem + each ext, or, when any of those is already there, stem (2), stem (3), ...: never overwrite a sheet."""
    n = 1
    while True:
        paths = [f'{stem}{"" if n == 1 else f" ({n})"}{ext}' for ext in exts]
        if not any(os.path.exists(x) for x in paths):
            return paths
        n += 1


def main(argv: Optional[Iterable[str]] = None) -> int:
    # Windows: a console or file in cp1252 can't print every character a report holds; never fail on that
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors='replace')  # type: ignore[attr-defined]
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description='Allure report -> Excel/CSV results sheet (Test File, Test Name, Route Tested, Result, Failure, RCA, Test Script Fix Required, Bug id).')
    ap.add_argument('report', help='Allure report folder, .zip of it, single-file index.html, or allure-results folder/.zip')
    ap.add_argument('-o', '--out', help='output .xlsx (default: next to the report, <name>-results.xlsx) or .csv; never overwritten: if it is there, <name> (2).xlsx and so on')
    ap.add_argument('--csv', action='store_true', help='also write a .csv next to the .xlsx')
    ap.add_argument('--tests', metavar='DIR', help="your test repo (or its tests folder): Route Tested from each test's own docstrings or ROUTE_ID")
    ap.add_argument('--routes-sheet', metavar='SHEET', help='your sheet of routes (.xlsx/.csv with a route id and a test files column): Route Tested by test file')
    ap.add_argument('--route-label', action='append', default=[], metavar='NAME', help='another label (or parameter) name that holds the route id; repeatable')
    ap.add_argument('--eai-branch', metavar='BRANCH', help=f'the EAI build branch for the top section (default: from the environment, else "{PLACEHOLDER}")')
    ap.add_argument('--t1000-branch', metavar='BRANCH', help=f'the T1000 branch for the top section (default: from the environment, else "{PLACEHOLDER}")')
    ap.add_argument('--db-schema', metavar='SCHEMA', help=f'the DB schema for the top section (default: from the environment, else "{PLACEHOLDER}")')
    ap.add_argument('--inspect', action='store_true', help='print what the report holds per test (label and parameter names, descriptions, steps) instead of writing a sheet')
    a = ap.parse_args(list(argv) if argv is not None else None)
    if a.inspect:
        inspect(a.report)
        return 0
    res = convert(
        a.report, a.out, a.csv, a.route_label,
        routes_sheet=a.routes_sheet, eai_branch=a.eai_branch, db_schema=a.db_schema, tests_dir=a.tests, t1000_branch=a.t1000_branch,
    )
    print(f"{res['tests']} tests, {res['withRoute']} with a route -> " + ', '.join(res['files']))
    d = res.get('diagnose') or {}
    if d:
        print(f"--tests: {d['py files in --tests']} .py files read under {a.tests}")
        for why, files in (d.get('misses') or {}).items():
            print(f"  {len(files)} test file(s) {why} there, e.g. " + ', '.join(files[:3]))
        if d.get('found, no route in it'):
            nf = d['found, no route in it']
            print(f"  {len(nf)} test file(s) found but naming no route (no 'Route id: ...' docstring line, ROUTE_ID or 'route <id>'), e.g. " + ', '.join(nf[:3]))
    elif res['withRoute'] < res['tests'] and not a.routes_sheet:
        print(f"{res['tests'] - res['withRoute']} test(s) without a route: the report doesn't name it; add --tests <your test repo> to read it from the test files")
    todo = [k for k, v in res['details'] if v == PLACEHOLDER]
    if todo:
        print(f"fill in: {', '.join(todo)} (or pass {' / '.join(MANUAL_OPTION[k] for k in todo)})")
    return 0


def inspect(report: str) -> None:
    """Where a report keeps things: the label and parameter names, how many tests have a description and steps, with examples."""
    tests = load_tests(_strip_root(read_files(report)))
    n = len(tests)
    print(f'{n} tests\n')
    for what, key in (('labels', 'labels'), ('parameters', 'parameters')):
        seen: dict[str, list[str]] = {}
        for t in tests:
            for k, v in t[key]:
                ex = seen.setdefault(k, [])
                if v not in ex and len(ex) < 3:
                    ex.append(v[:60])
        counts = {k: sum(1 for t in tests if any(x == k for x, _ in t[key])) for k in seen}
        print(f'{what}:' if seen else f'{what}: none')
        for k in sorted(seen, key=lambda k: -counts[k]):
            print(f'  {k:<24} on {counts[k]}/{n} tests   e.g. {" | ".join(seen[k])}')
        print()
    with_desc = [t for t in tests if t.get('description')]
    print(f'description: on {len(with_desc)}/{n} tests')
    for t in with_desc[:2]:
        print('  ' + t['description'].strip()[:300].replace('\n', '\n  '))
    with_steps = [t for t in tests if t.get('steps')]
    print(f'\nsteps: on {len(with_steps)}/{n} tests')
    for t in with_steps[:2]:
        print(f"  {t['name']}:")
        for st in t['steps'][:8]:
            print(f'    - {st[:120]}')
    print('\nTest File as worked out for the first tests:')
    for t in tests[:5]:
        print(f"  {t['fullName'] or t['name']}  ->  {test_file(t) or '?'}")


if __name__ == '__main__':
    sys.exit(main())
