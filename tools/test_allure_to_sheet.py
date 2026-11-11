"""Tests for allure_to_sheet.py: every report form gives the same sheet. Run: python3 -m unittest tools/test_allure_to_sheet.py"""
import base64
import csv
import json
import os
import shutil
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import allure_to_sheet as a2s  # noqa: E402

START = 1767225600000  # 2026-01-01T00:00:00Z


def case(uid, name, full, status, msg=None, labels=(), **extra):
    c = {
        'uid': uid, 'name': name, 'fullName': full, 'status': status, 'time': {'start': START + 1000, 'stop': START + 2000},
        'labels': [{'name': n, 'value': v} for n, v in labels], 'parameters': [], 'links': [], 'extra': {},
    }
    if msg is not None:
        c['statusMessage'] = msg
        c['statusTrace'] = 'Traceback (most recent call last): ...'
    c.update(extra)
    return c


CASES = [
    case('a1', 'test_invoice_loads', 'tests.routes.test_invoice.TestLoad#test_invoice_loads', 'passed', labels=[('package', 'tests.routes.test_invoice'), ('route', 'invoice-load')]),
    case('a2', 'test_credit_fails', 'tests.routes.test_credit#test_credit_fails', 'failed', 'AssertionError: expected 3 rows, got 0\nassert 0 == 3'),
    case('a3', 'test_purge[nightly]', 'tests.jobs.test_purge.TestPurge#test_purge', 'broken', 'TimeoutError: no file in /out after 60s', labels=[('route', 'nightly-purge; purge-archive')]),
    case('a4', 'test_skipped', 'tests.jobs.test_purge.TestPurge#test_skipped', 'skipped', 'Skipped: needs SFTP'),
    # an earlier attempt of a2, kept by Allure as a hidden retry
    case('a0', 'test_credit_fails', 'tests.routes.test_credit#test_credit_fails', 'passed', hidden=True),
]
CASES[1]['extra'] = {'retries': [{'uid': 'a0', 'status': 'passed'}]}
SUMMARY = {'reportName': 'Nightly regression', 'time': {'start': START, 'stop': START + 3723000}}
ENV = [{'name': 'ENV', 'values': ['fuludababa5']}, {'name': 'Python', 'values': ['3.12']}]
EXECUTORS = [{'name': 'Jenkins', 'buildName': 'nightly #42', 'buildUrl': 'https://ci/job/42'}]


def write_report(root):
    os.makedirs(os.path.join(root, 'data', 'test-cases'))
    os.makedirs(os.path.join(root, 'widgets'))
    for c in CASES:
        with open(os.path.join(root, 'data', 'test-cases', c['uid'] + '.json'), 'w') as f:
            json.dump(c, f)
    for name, data in (('summary.json', SUMMARY), ('environment.json', ENV), ('executors.json', EXECUTORS)):
        with open(os.path.join(root, 'widgets', name), 'w') as f:
            json.dump(data, f)
    with open(os.path.join(root, 'index.html'), 'w') as f:
        f.write('<!DOCTYPE html><html><body><script src="app.js"></script></body></html>')


def single_file(path):
    """allure generate --single-file: every data file inlined in index.html as d('path','base64')."""
    lines = []
    for c in CASES:
        lines.append(f"d('data/test-cases/{c['uid']}.json','{base64.b64encode(json.dumps(c).encode()).decode()}')")
    for name, data in (('summary.json', SUMMARY), ('environment.json', ENV), ('executors.json', EXECUTORS)):
        lines.append(f"d('widgets/{name}','{base64.b64encode(json.dumps(data).encode()).decode()}')")
    with open(path, 'w') as f:
        f.write('<!DOCTYPE html><html><head><script>function d(n,v){}</script></head><body><script>\n' + '\n'.join(lines) + '\n</script></body></html>')


def table(details_and_rows):
    return details_and_rows


class AllureToSheet(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='a2s-')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def sheet(self, report):
        out = os.path.join(self.tmp, 'out.csv')
        a2s.convert(report, out)
        with open(out, encoding='utf-8-sig') as f:
            rows = list(csv.reader(f))
        blank = rows.index([])
        return dict((r[0], r[1]) for r in rows[:blank]), rows[blank + 1], rows[blank + 2:]

    def check(self, details, header, rows):
        self.assertEqual(header, a2s.COLUMNS)
        self.assertEqual(header[:5], ['Test Name', 'Test File', 'Route Tested', 'Result', 'Failure from script'])
        # failures first; the hidden retry isn't a row
        self.assertEqual([r[0] for r in rows], ['test_credit_fails', 'test_purge[nightly]', 'test_skipped', 'test_invoice_loads'])
        by = {r[0]: r for r in rows}
        self.assertEqual(by['test_credit_fails'][1:5], ['tests/routes/test_credit.py', '', 'Failed', 'AssertionError: expected 3 rows, got 0\nassert 0 == 3'])
        self.assertEqual(by['test_purge[nightly]'][1:5], ['tests/jobs/test_purge.py', 'nightly-purge; purge-archive', 'Broken', 'TimeoutError: no file in /out after 60s'])
        self.assertEqual(by['test_skipped'][3:5], ['Skipped', 'Skipped: needs SFTP'])
        self.assertEqual(by['test_invoice_loads'][1:5], ['tests/routes/test_invoice.py', 'invoice-load', 'Passed', 'N/A'])
        # RCA, Test Script Fix Required, Bug id: for people, N/A for a passed test
        self.assertEqual({r[0]: r[5:] for r in rows}, {
            'test_credit_fails': ['', '', ''],
            'test_purge[nightly]': ['', '', ''],
            'test_skipped': ['', '', ''],
            'test_invoice_loads': ['N/A', 'N/A', 'N/A'],
        })
        self.assertEqual(details['Allure report'], 'Nightly regression')
        self.assertRegex(details['Date ran'], r'^2026-01-0[12] \d\d:\d\d$')  # local time
        self.assertEqual(details['Duration'], '1h 02m 03s')
        self.assertEqual(details['Env: ENV'], 'fuludababa5')
        self.assertEqual(details['Env: Python'], '3.12')
        self.assertEqual(details['Executor'], 'Jenkins · nightly #42 (https://ci/job/42)')
        self.assertEqual(details['Results'], '4 tests: 1 failed, 1 broken, 1 skipped, 1 passed')
        # to fill in by hand: not in this report's environment
        self.assertEqual(details['EAI build branch'], 'TO FILL IN')
        self.assertEqual(details['T1000 branch'], 'TO FILL IN')
        self.assertEqual(details['DB schema'], 'TO FILL IN')

    def test_report_folder(self):
        root = os.path.join(self.tmp, 'allure-report')
        write_report(root)
        self.check(*self.sheet(root))

    def test_zip_of_the_folder(self):
        root = os.path.join(self.tmp, 'allure-report')
        write_report(root)
        z = os.path.join(self.tmp, 'report.zip')
        with zipfile.ZipFile(z, 'w') as zf:
            for base, _, names in os.walk(root):
                for n in names:
                    full = os.path.join(base, n)
                    zf.write(full, os.path.join('nightly', os.path.relpath(full, root)))  # wrapped in a folder
        self.check(*self.sheet(z))

    def test_single_file_report(self):
        html = os.path.join(self.tmp, 'index.html')
        single_file(html)
        self.check(*self.sheet(html))

    def test_allure_results(self):
        root = os.path.join(self.tmp, 'allure-results')
        os.makedirs(root)
        for i, c in enumerate(CASES):
            r = {'name': c['name'], 'fullName': c['fullName'], 'status': c['status'], 'historyId': c['fullName'] + c['name'],
                 'start': START + (0 if c.get('hidden') else 1000 + i), 'stop': START + 2000, 'labels': c['labels']}
            if 'statusMessage' in c:
                r['statusDetails'] = {'message': c['statusMessage'], 'trace': c['statusTrace']}
            with open(os.path.join(root, f'{i}-result.json'), 'w') as f:
                json.dump(r, f)
        with open(os.path.join(root, 'environment.properties'), 'w') as f:
            f.write('ENV=fuludababa5\nPython=3.12\n')
        details, header, rows = self.sheet(root)
        self.assertEqual(len(rows), 4)  # the earlier attempt of test_credit_fails gives way to the latest
        self.assertEqual({r[0]: r[3] for r in rows}['test_credit_fails'], 'Failed')
        self.assertEqual(details['Allure report'], 'allure-results')  # no report name: the folder's
        self.assertEqual(details['Env: ENV'], 'fuludababa5')

    def test_route_from_a_parameter_or_the_description(self):
        def t(**kw):
            base = {'labels': [], 'parameters': [], 'description': ''}
            base.update(kw)
            return base
        self.assertEqual(a2s.routes_of(t(labels=[('route_id', 'credit-load')])), 'credit-load')
        self.assertEqual(a2s.routes_of(t(parameters=[('route_id', 'credit-load')])), 'credit-load')
        self.assertEqual(a2s.routes_of(t(description='Loads a credit file.\n\n- Route id           : common-credit-load-route\n- Trigger : CRN.TXT')), 'common-credit-load-route')
        self.assertEqual(a2s.routes_of(t(description=a2s._text('<p>Route ID: invoice-load</p>'))), 'invoice-load')
        self.assertEqual(a2s.routes_of(t(description='the route is loaded')), '')  # only "route id: x"
        # a label always wins over the description
        self.assertEqual(a2s.routes_of(t(labels=[('route', 'a')], description='Route id: b')), 'a')
        # another label name, given on the command line
        self.assertEqual(a2s.routes_of(t(labels=[('camelRouteName', 'x-route')])), '')
        self.assertEqual(a2s.routes_of(t(labels=[('camelRouteName', 'x-route')]), a2s.ROUTE_LABELS | {'camelroutename'}), 'x-route')

    def test_route_from_a_description_in_the_report(self):
        root = os.path.join(self.tmp, 'allure-report')
        write_report(root)
        path = os.path.join(root, 'data', 'test-cases', 'a2.json')
        with open(path) as f:
            c = json.load(f)
        c['descriptionHtml'] = '<p>Credit load.</p><ul><li>Route id : credit-load</li></ul>'
        with open(path, 'w') as f:
            json.dump(c, f)
        out = os.path.join(self.tmp, 'r.csv')
        self.assertEqual(a2s.convert(root, out)['withRoute'], 3)
        with open(out, encoding='utf-8-sig') as f:
            rows = {r[0]: r for r in csv.reader(f) if r}
        self.assertEqual(rows['test_credit_fails'][2], 'credit-load')

    def test_route_from_the_test_files_docstrings(self):
        tests = os.path.join(self.tmp, 'test-repo', 'tests')
        os.makedirs(os.path.join(tests, 'routes'))
        os.makedirs(os.path.join(tests, 'jobs'))
        with open(os.path.join(tests, 'routes', 'test_credit.py'), 'w') as f:
            f.write('''"""
Credit load route test.

Route details
-------------
- Route id           : common-credit-load-route
- Trigger            : CRN.TXT
"""

def test_credit_fails():
    pass
''')
        with open(os.path.join(tests, 'jobs', 'test_purge.py'), 'w') as f:
            f.write('''"""Purge test — route nightly-purge-route (archive)."""

ROUTE_ID = "should-not-win"

class TestPurge:
    ROUTE_ID = "purge-from-class"

    def test_skipped(self):
        """Skips without SFTP."""
''')
        src = a2s.TestSources(os.path.join(self.tmp, 'test-repo'))  # the repo root: the report's paths start lower
        t = lambda full, name: {'fullName': full, 'name': name, 'labels': []}  # noqa: E731
        self.assertEqual(src.routes(t('tests.routes.test_credit#test_credit_fails', 'test_credit_fails')), ['common-credit-load-route'])
        # no "Route id" line: the class's ROUTE_ID beats the module's and "route x" in a docstring's first line
        self.assertEqual(src.routes(t('tests.jobs.test_purge.TestPurge#test_skipped', 'test_skipped')), ['purge-from-class'])
        self.assertEqual(src.routes(t('tests.unknown#test_x', 'test_x')), [])
        root = os.path.join(self.tmp, 'allure-report')
        write_report(root)
        out = os.path.join(self.tmp, 'r.csv')
        a2s.convert(root, out, tests_dir=os.path.join(self.tmp, 'test-repo'))
        with open(out, encoding='utf-8-sig') as f:
            rows = {r[0]: r for r in csv.reader(f) if r}
        self.assertEqual(rows['test_credit_fails'][2], 'common-credit-load-route')
        self.assertEqual(rows['test_skipped'][2], 'purge-from-class')
        self.assertEqual(rows['test_invoice_loads'][2], 'invoice-load')  # its label wins
        # the summary says which files weren't found under --tests
        res = a2s.convert(root, out, tests_dir=os.path.join(self.tmp, 'test-repo'))
        self.assertEqual(res['diagnose']['py files in --tests'], 2)
        self.assertEqual(res['diagnose']['misses'], {})  # test_invoice's label names its route: its file isn't looked for
        # a folder without the tests: every file the report names is missing, and the summary says so
        other = os.path.join(self.tmp, 'elsewhere')
        os.makedirs(other)
        res = a2s.convert(root, out, tests_dir=other)
        self.assertEqual(res['diagnose']['misses'], {'not found': ['tests/jobs/test_purge.py', 'tests/routes/test_credit.py']})

    def test_no_warnings_from_the_test_files(self):
        import warnings
        repo = os.path.join(self.tmp, 'repo')
        os.makedirs(repo)
        with open(os.path.join(repo, 'test_win.py'), 'w') as f:
            f.write('ROUTE_ID = "win-route"\nPATH = "C:\\config\\in"\n\ndef test_a():\n    pass\n')  # "\c": an invalid escape
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter('always')
            got = a2s.TestSources(repo).routes({'fullName': 'test_win#test_a', 'name': 'test_a', 'labels': []})
        self.assertEqual(got, ['win-route'])
        self.assertEqual([str(w.message) for w in caught], [])

    def test_route_constant_when_no_docstring_says(self):
        tests = os.path.join(self.tmp, 'repo')
        os.makedirs(tests)
        with open(os.path.join(tests, 'test_load.py'), 'w') as f:
            f.write('ROUTE_ID = "load-route"\n\nclass TestLoad:\n    ROUTE_ID = "class-route"\n\n    def test_a(self):\n        pass\n')
        src = a2s.TestSources(tests)
        self.assertEqual(src.routes({'fullName': 'test_load.TestLoad#test_a', 'name': 'test_a', 'labels': []}), ['class-route'])

    def test_route_from_a_class_it_inherits_from_another_file(self):
        # no docstring names the route: a helper class in another file sets ROUTE_ID (via a constant)
        repo = os.path.join(self.tmp, 'repo', 'src')
        os.makedirs(os.path.join(repo, 'route_test', 'helpers'))
        os.makedirs(os.path.join(repo, 'route_test', 'common'))
        with open(os.path.join(repo, 'route_test', 'base.py'), 'w') as f:
            f.write('class RouteTest:\n    ROUTE_ID = None\n')
        with open(os.path.join(repo, 'route_test', 'helpers', 'credit.py'), 'w') as f:
            f.write('from route_test.base import RouteTest\nROUTE_ID = "credit-load-route"\n\nclass _Credit(RouteTest):\n    ROUTE_ID = ROUTE_ID\n')
        with open(os.path.join(repo, 'route_test', 'common', 'test_credit.py'), 'w') as f:
            f.write('DQCredit tests.DQ\nfrom route_test.helpers.credit import _Credit as Base\n\nclass TestCredit(Base):\n    def test_a(self):\n        pass\n'.replace('DQ', '"' * 3))
        src = a2s.TestSources(os.path.join(self.tmp, 'repo'))
        self.assertEqual(src.routes({'fullName': 'route_test.common.test_credit.TestCredit#test_a', 'name': 'test_a', 'labels': []}), ['credit-load-route'])

    def test_routes_from_your_sheet(self):
        sheet = os.path.join(self.tmp, 'mine.csv')
        with open(sheet, 'w', newline='') as f:
            w = csv.writer(f)
            w.writerow(['route_id', 'automated', 'test_files'])
            w.writerow(['credit-load', 'YES', 'test_credit.py'])
            w.writerow(['skip-route', 'YES', 'tests/jobs/test_purge.py; other.py'])
        by = a2s.routes_by_file(sheet)
        self.assertEqual(by['test_credit.py'], ['credit-load'])
        self.assertEqual(by['test_purge'], ['skip-route'])
        root = os.path.join(self.tmp, 'allure-report')
        write_report(root)
        out = os.path.join(self.tmp, 'r.csv')
        self.assertEqual(a2s.convert(root, out, routes_sheet=sheet)['withRoute'], 4)
        with open(out, encoding='utf-8-sig') as f:
            rows = {r[0]: r for r in csv.reader(f) if r}
        self.assertEqual(rows['test_credit_fails'][2], 'credit-load')
        self.assertEqual(rows['test_purge[nightly]'][2], 'nightly-purge; purge-archive')  # its label first
        self.assertEqual(rows['test_skipped'][2], 'skip-route')

    def test_eai_branch_and_db_schema(self):
        root = os.path.join(self.tmp, 'allure-report')
        write_report(root)
        with open(os.path.join(root, 'widgets', 'environment.json'), 'w') as f:
            json.dump(ENV + [{'name': 'EAI_BRANCH', 'values': ['release/26.4']}], f)
        out = os.path.join(self.tmp, 'r.csv')
        res = a2s.convert(root, out, db_schema='PUG_T1154', t1000_branch='feature/x')
        d = dict(res['details'])
        self.assertEqual(d['EAI build branch'], 'release/26.4')  # from the environment
        self.assertEqual(d['T1000 branch'], 'feature/x')  # given
        self.assertEqual(d['DB schema'], 'PUG_T1154')  # given
        keys = [k for k, _ in res['details']]
        self.assertEqual(keys.index('T1000 branch'), keys.index('EAI build branch') + 1)  # right under it
        self.assertLess(keys.index('DB schema'), keys.index('Env: ENV'))

    def test_inspect(self):
        root = os.path.join(self.tmp, 'allure-report')
        write_report(root)
        import contextlib
        import io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(a2s.main([root, '--inspect']), 0)
        text = buf.getvalue()
        self.assertIn('4 tests', text)
        self.assertIn('route ', text)
        self.assertIn('package', text)
        self.assertFalse(os.path.exists(root + '-results.xlsx'))  # nothing written

    def test_command_line(self):
        root = os.path.join(self.tmp, 'allure-report')
        write_report(root)
        out = os.path.join(self.tmp, 'cli.xlsx')
        self.assertEqual(a2s.main([root, '-o', out, '--csv', '--route-label', 'owner']), 0)
        self.assertTrue(os.path.exists(out) and os.path.exists(os.path.join(self.tmp, 'cli.csv')))
        with self.assertRaises(SystemExit):
            a2s.main([root, '--dashboard', 'http://x'])  # no such option: the script reads only the report

    def test_xlsx(self):
        root = os.path.join(self.tmp, 'allure-report')
        write_report(root)
        out = os.path.join(self.tmp, 'r.xlsx')
        res = a2s.convert(root, out, want_csv=True)
        self.assertEqual(res['files'], [out, os.path.join(self.tmp, 'r.csv')])
        with zipfile.ZipFile(out) as z:
            self.assertEqual(z.testzip(), None)
            sheet = z.read('xl/worksheets/sheet1.xml').decode()
        self.assertIn('Failure from script', sheet)
        self.assertIn('<autoFilter ref="A13:H17"/>', sheet)  # 11 detail rows, a blank one, the header, 4 tests
        self.assertIn('s="8"><is><t xml:space="preserve">TO FILL IN</t>', sheet)  # highlighted
        self.assertIn('state="frozen"', sheet)
        self.assertIn('<formula1>"Yes,No,N/A"</formula1>', sheet)

    def test_default_output_name(self):
        root = os.path.join(self.tmp, 'nightly-report')
        write_report(root)
        res = a2s.convert(root)
        self.assertEqual(res['files'], [os.path.join(self.tmp, 'nightly-report-results.xlsx')])

    def test_no_tests(self):
        empty = os.path.join(self.tmp, 'empty')
        os.makedirs(empty)
        with self.assertRaises(SystemExit):
            a2s.convert(empty)


if __name__ == '__main__':
    unittest.main()
