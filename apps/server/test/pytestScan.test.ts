import { describe, expect, it } from 'vitest';
import { logicalLines, scanPytestFile, scanPytestFiles } from '../src/triggers/pytest.js';

const one = (src: string, file = 'tests/test_x.py') => scanPytestFile(file, src);
const byName = (src: string) => Object.fromEntries(one(src).map((t) => [t.name, t]));

describe('pytest scanning: what each test names', () => {
  it('reads the body of a test whose signature spans several lines (black/ruff style)', () => {
    const t = byName(['def test_invoice_load(', '    sftp_client,', '    tmp_path,', '):', '    allure.dynamic.label("route", "invoice-load")', ''].join('\n'));
    expect(t.test_invoice_load!.strings).toEqual(['route', 'invoice-load']);
    expect(t.test_invoice_load!.labels).toEqual(['route', 'invoice-load']);
  });

  it('keeps each method its own body when signatures span lines in a class', () => {
    const t = byName(
      [
        'class TestLoads:',
        '    def test_invoice(',
        '        self, sftp_client',
        '    ) -> None:',
        '        start("invoice-load")',
        '',
        '    def test_credit(self):',
        '        start("credit-load")',
        '',
      ].join('\n'),
    );
    expect(t.test_invoice!.strings).toEqual(['invoice-load']);
    expect(t.test_credit!.strings).toEqual(['credit-load']);
    expect(t.test_invoice!.id).toBe('tests/test_x.py::TestLoads::test_invoice');
  });

  it('a column-0 comment or a dedented triple-quoted string does not end the body', () => {
    const t = byName(
      [
        'def test_a():',
        '    sql = """',
        'SELECT * FROM t',
        '"""',
        '# a comment at column 0',
        '    start("invoice-load")',
        '',
        'def test_b():',
        '    start("credit-load")',
        '',
      ].join('\n'),
    );
    expect(t.test_a!.strings).toEqual(['invoice-load']);
    expect(t.test_b!.strings).toEqual(['credit-load']);
  });

  it('ignores commented-out code', () => {
    expect(one('def test_a():\n    # start("invoice-load")\n    start("credit-load")  # not "orders-load"\n')[0]!.strings).toEqual(['credit-load']);
  });

  it('reads a one-line test and strings in parameter defaults', () => {
    const t = byName('def test_a(route="orders-load"): start("invoice-load")\n');
    expect(t.test_a!.strings).toEqual(['orders-load', 'invoice-load']);
  });

  it('module constants count only for the tests that use them', () => {
    const t = byName(
      [
        'ROUTES = ["invoice-load", "credit-load"]',
        'OTHER = "orders-load"',
        '',
        '@pytest.mark.parametrize("route", ROUTES)',
        'def test_routes(route):',
        '    start(route)',
        '',
        'def test_other():',
        '    start(OTHER)',
        '',
        'def test_health():',
        '    assert ping() == "ok"',
        '',
      ].join('\n'),
    );
    expect(t.test_routes!.labels).toEqual(['route', 'invoice-load', 'credit-load']);
    expect(t.test_other!.strings).toEqual(['orders-load']);
    expect(t.test_other!.labels).toEqual([]);
    expect(t.test_health!.strings).toEqual(['ok']);
  });

  it('class constants count for the methods that use them (self.X, cls.X, Class.X, X)', () => {
    const t = byName(
      [
        'class TestJobs:',
        '    ROUTE = "invoice-load"',
        '    OTHER = "credit-load"',
        '',
        '    def test_a(self):',
        '        start(self.ROUTE)',
        '',
        '    def test_b(self):',
        '        start(TestJobs.OTHER)',
        '',
        '    def test_c(self):',
        '        start("x")',
        '',
      ].join('\n'),
    );
    expect(t.test_a!.strings).toEqual(['invoice-load']);
    expect(t.test_b!.strings).toEqual(['credit-load']);
    expect(t.test_c!.strings).toEqual(['x']);
  });

  it('resolves constants imported from another file (from … import, import … as, relative)', () => {
    const tests = scanPytestFiles([
      { path: 'tests/common/routes.py', text: 'INVOICE = "invoice-load"\nCREDIT = "credit-load"\nALL = [INVOICE, CREDIT]\n' },
      {
        path: 'tests/billing/test_a.py',
        text: [
          'from common.routes import INVOICE as INV',
          'import common.routes as r',
          'from ..common import routes',
          'from common.routes import ALL',
          '',
          'def test_one():',
          '    start(INV)',
          '',
          'def test_two():',
          '    start(r.CREDIT)',
          '',
          'def test_three():',
          '    start(routes.CREDIT)',
          '',
          '@pytest.mark.parametrize("route", ALL)',
          'def test_all(route):',
          '    start(route)',
          '',
        ].join('\n'),
      },
    ]);
    const t = Object.fromEntries(tests.map((x) => [x.name, x]));
    expect(t.test_one!.strings).toEqual(['invoice-load']);
    expect(t.test_two!.strings).toEqual(['credit-load']);
    expect(t.test_three!.strings).toEqual(['credit-load']);
    expect(t.test_all!.labels).toEqual(['route', 'invoice-load', 'credit-load']);
    // the constants file has no tests of its own
    expect(tests.map((x) => x.file)).toEqual(['tests/billing/test_a.py', 'tests/billing/test_a.py', 'tests/billing/test_a.py', 'tests/billing/test_a.py']);
  });

  it('a test gets the strings of the fixtures it asks for (same file or a conftest.py above it)', () => {
    const tests = scanPytestFiles([
      { path: 'tests/conftest.py', text: '@pytest.fixture\ndef invoice_route():\n    return "invoice-load"\n\n@pytest.fixture\ndef unused():\n    return "orders-load"\n' },
      { path: 'other/conftest.py', text: '@pytest.fixture\ndef invoice_route():\n    return "WRONG"\n' },
      {
        path: 'tests/billing/test_a.py',
        text: '@pytest.fixture\ndef credit(invoice_route):\n    return "credit-load"\n\ndef test_one(invoice_route):\n    start(invoice_route)\n\ndef test_two(credit):\n    pass\n',
      },
    ]);
    const t = Object.fromEntries(tests.map((x) => [x.name, x]));
    expect(t.test_one!.strings).toEqual(['invoice-load']);
    expect(t.test_two!.strings).toEqual(['credit-load', 'invoice-load']);
  });

  it('collects Test* classes nested in Test* classes, not methods of helper classes', () => {
    const tests = one(
      [
        'class Helper:',
        '    def test_not_a_test(self):',
        '        start("invoice-load")',
        '',
        '@pytest.mark.route("outer-route")',
        'class TestOuter:',
        '    class TestInner:',
        '        def test_x(self):',
        '            pass',
        '',
        '    def test_y(self):',
        '        pass',
        '',
      ].join('\n'),
    );
    expect(tests.map((t) => [t.id, t.labels])).toEqual([
      ['tests/test_x.py::TestOuter::TestInner::test_x', ['outer-route', 'route']],
      ['tests/test_x.py::TestOuter::test_y', ['outer-route', 'route']],
    ]);
  });

  it('allure.* calls in the body are labels, other body strings are not', () => {
    const t = one('def test_a():\n    allure.dynamic.label("job", "invoiceJob")\n    send("orders")\n')[0]!;
    expect(t.labels).toEqual(['job', 'invoiceJob']);
    expect(t.strings).toEqual(['job', 'invoiceJob', 'orders']);
  });

  it('keeps Jira keys from comments above, docstrings and comments inside, and the module', () => {
    const t = one('"""Module for ABC-1."""\n# ABC-2\ndef test_a():\n    """Covers ABC-3."""\n    # ABC-4\n    pass\n')[0]!;
    expect(t.keys.sort()).toEqual(['ABC-1', 'ABC-2', 'ABC-3', 'ABC-4']);
  });

  it('tokenizes brackets, continuations and strings into logical lines', () => {
    const lines = logicalLines('x = (1,\n  2)\ny = "a#b" # c\nz = 1 + \\\n  2\n');
    expect(lines.map((l) => [l.line, l.text, l.comments])).toEqual([
      [1, 'x = (1,\n  2)', []],
      [3, 'y = "a#b" ', [' c']],
      [4, 'z = 1 +    2', []],
    ]);
  });
});
