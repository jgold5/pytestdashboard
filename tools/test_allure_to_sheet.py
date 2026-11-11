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
        self.assertEqual(by['test_invoice_loads'][1:5], ['tests/routes/test_invoice.py', 'invoice-load', 'Passed', ''])
        # RCA, Fix Required, Bug id: for people, N/A for a passed test
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
        self.assertIn('<autoFilter ref="A10:H14"/>', sheet)  # 8 detail rows, a blank one, the header, 4 tests
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
