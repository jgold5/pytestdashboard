#!/usr/bin/env python3
"""
Allure report -> Excel (.xlsx) / CSV results sheet, for failure analysis.

    python3 tools/allure_to_sheet.py REPORT [-o OUT.xlsx] [--csv] [--route-label NAME]

REPORT is any of:
  - a generated Allure report folder (the one with index.html and data/test-cases/),
  - a .zip of that folder,
  - a single-file report (allure generate --single-file): its index.html,
  - an allure-results folder (or .zip) of *-result.json files.

The sheet starts with the run's details (report name, date ran, environment, executor, totals),
then one row per test:

  Test Name | Test File | Route Tested | Result | Failure from script | RCA (after manual analysis) | Fix Required | Bug id

The first five are filled in from the report alone; the last three are for you (N/A for passed
tests). Failures come first.
  - Test File: the test's module (allure-pytest's `package` label, else its fullName:
    tests.routes.test_x.TestY#test_z -> tests/routes/test_x.py).
  - Route Tested: a `route` / `route_id` label on the test (allure.dynamic.label("route", ...),
    @allure.label("route", ...)), else a test parameter of that name, else a "Route id: ..." line in
    the test's description (its docstring). --route-label adds another label name to look for.

Fully standalone: only the Python standard library, and it reads nothing but the report.
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

COLUMNS = ['Test Name', 'Test File', 'Route Tested', 'Result', 'Failure from script', 'RCA (after manual analysis)', 'Fix Required', 'Bug id']
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


def load_details(files: dict[str, bytes], tests: list[dict], report_path: str) -> list[tuple[str, str]]:
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

    env = _json(find('widgets/environment.json') or b'null')
    if isinstance(env, list) and env:
        for e in env:
            if isinstance(e, dict) and e.get('name'):
                vals = e.get('values') or []
                rows.append((f"Env: {e['name']}", ', '.join(str(v) for v in vals) if isinstance(vals, list) else str(vals)))
    else:
        props = find('environment.properties')
        for k, v in _properties(props.decode('utf-8', 'replace')) if props else []:
            rows.append((f'Env: {k}', v))

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


def routes_of(test: dict, route_labels: set[str] = ROUTE_LABELS) -> str:
    """The route(s) the test names: its route labels, else a route parameter, else a "Route id: x" line in its description."""
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
        for m in ROUTE_IN_TEXT.finditer(test.get('description') or ''):
            add(m.group(1))
    return '; '.join(found)


# ---------------------------------------------------------------------------
# The table
# ---------------------------------------------------------------------------

def _failure(test: dict) -> str:
    if test['status'] == 'passed':
        return ''
    msg = re.sub(r'\r\n?', '\n', str(test['message'] or '')).strip()
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


def build_rows(tests: list[dict], route_labels: set[str] = ROUTE_LABELS) -> list[list[str]]:
    ordered = sorted(tests, key=lambda t: (STATUS_ORDER.get(t['status'], 9), t['fullName'] or t['name'], t['name']))
    # a passed test needs no analysis: RCA, Fix Required and Bug id say N/A; the others are left for people
    return [
        [t['name'], test_file(t), routes_of(t, route_labels), t['status'].capitalize(), _failure(t)] + (['N/A'] * 3 if t['status'] == 'passed' else ['', '', ''])
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


# styles: 0 default, 1 bold, 2 header (bold, grey fill, border, wrap), 3 wrap (top-aligned), 4 failed, 5 broken, 6 passed, 7 skipped
_STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="6"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><color rgb="FFB42318"/><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFB54708"/><sz val="11"/><name val="Calibri"/></font>
<font><color rgb="FF067647"/><sz val="11"/><name val="Calibri"/></font><font><color rgb="FF667085"/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE4E7EC"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FF98A2B3"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top"/></xf>
</cellXfs></styleSheet>"""
_RESULT_STYLE = {'Failed': 4, 'Broken': 5, 'Passed': 6, 'Skipped': 7}
_WIDTHS = [44, 40, 32, 10, 70, 40, 14, 14]


def write_xlsx(path: str, details: list[tuple[str, str]], rows: list[list[str]]) -> None:
    out = io.StringIO()
    r = 0
    for k, v in details:
        r += 1
        out.write(f'<row r="{r}">{_cell(f"A{r}", k, 1)}{_cell(f"B{r}", v)}</row>')
    r += 1  # blank row
    head = r + 1
    out.write(f'<row r="{head}" ht="30" customHeight="1">' + ''.join(_cell(f'{_col(i)}{head}', c, 2) for i, c in enumerate(COLUMNS)) + '</row>')
    for i, row in enumerate(rows):
        n = head + 1 + i
        cells = []
        for j, v in enumerate(row):
            style = _RESULT_STYLE.get(v, 3) if j == COLUMNS.index('Result') else 3
            cells.append(_cell(f'{_col(j)}{n}', v, style))
        out.write(f'<row r="{n}">' + ''.join(cells) + '</row>')
    last = head + max(len(rows), 1)
    cols = ''.join(f'<col min="{i + 1}" max="{i + 1}" width="{w}" customWidth="1"/>' for i, w in enumerate(_WIDTHS))
    fix_col = _col(COLUMNS.index('Fix Required'))
    sheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<sheetViews><sheetView workbookViewId="0"><pane ySplit="{head}" topLeftCell="A{head + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
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

def convert(report: str, out: Optional[str] = None, want_csv: bool = False, route_labels: Iterable[str] = ()) -> dict:
    files = _strip_root(read_files(report))
    tests = load_tests(files)
    if not tests:
        raise SystemExit(f'{report}: no tests found (expected data/test-cases/*.json, a single-file index.html, or *-result.json)')
    details = load_details(files, tests, report)
    rows = build_rows(tests, ROUTE_LABELS | {x.strip().lower() for x in route_labels if x.strip()})
    if out is None:
        stem = re.sub(r'\.(zip|html?)$', '', os.path.normpath(report), flags=re.I)
        if os.path.basename(stem).lower() == 'index':
            stem = os.path.join(os.path.dirname(stem), os.path.basename(os.path.dirname(os.path.abspath(stem))) or 'allure')
        out = stem.rstrip('/\\') + '-results.xlsx'
    written = []
    if out.lower().endswith('.csv'):
        write_csv(out, details, rows)
        written.append(out)
    else:
        write_xlsx(out, details, rows)
        written.append(out)
        if want_csv:
            c = re.sub(r'\.xlsx$', '', out, flags=re.I) + '.csv'
            write_csv(c, details, rows)
            written.append(c)
    route_col = COLUMNS.index('Route Tested')
    return {'files': written, 'tests': len(rows), 'details': details, 'withRoute': sum(1 for r in rows if r[route_col])}


def main(argv: Optional[Iterable[str]] = None) -> int:
    ap = argparse.ArgumentParser(description='Allure report -> Excel/CSV results sheet (Test Name, Test File, Route Tested, Result, Failure, RCA, Fix Required, Bug id).')
    ap.add_argument('report', help='Allure report folder, .zip of it, single-file index.html, or allure-results folder/.zip')
    ap.add_argument('-o', '--out', help='output .xlsx (default: next to the report, <name>-results.xlsx) or .csv')
    ap.add_argument('--csv', action='store_true', help='also write a .csv next to the .xlsx')
    ap.add_argument('--route-label', action='append', default=[], metavar='NAME', help='another label (or parameter) name that holds the route id; repeatable')
    a = ap.parse_args(list(argv) if argv is not None else None)
    res = convert(a.report, a.out, a.csv, a.route_label)
    print(f"{res['tests']} tests, {res['withRoute']} with a route -> " + ', '.join(res['files']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
