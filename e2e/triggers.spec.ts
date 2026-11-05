import { expect, test } from '@playwright/test';
import { E2E } from './env.mjs';

const ROUTES = (extra = '') => `<routes xmlns="http://camel.apache.org/schema/spring">
  <route id="e2e-invoice-load"><from uri="file:{{e2e.in.dir}}?include=INV_.*\\.csv"/><to uri="log:x"/></route>
  <route id="e2e-nightly-purge"><from uri="quartz://e2e/purge?cron=0+0+2+*+*+?"/><to uri="log:x"/></route>
  ${extra}
</routes>`;
const PROPS = 'e2e.in.dir=/data/in/invoices\n';
const TESTS = (extra = '') => `import allure


@allure.label("route", "e2e-invoice-load")
def test_invoice_file_is_loaded():
    pass
${extra}`;

test('trigger scope per branch, and a PR branch compared with main', async ({ page }) => {
  const scan = async (branch: string, xml: string, py: string) => {
    const res = await page.request.post('/api/triggers/scan', {
      // as CI does: a bearer token, no browser session
      headers: { authorization: `Bearer ${E2E.editorToken}` },
      multipart: {
        branch,
        'file:src/main/resources/camel': { name: 'routes.xml', mimeType: 'application/xml', buffer: Buffer.from(xml) },
        'file:properties': { name: 'e2e.properties', mimeType: 'text/plain', buffer: Buffer.from(PROPS) },
        'file:tests/routes': { name: 'test_e2e_routes.py', mimeType: 'text/x-python', buffer: Buffer.from(py) },
      },
    });
    expect(res.status(), await res.text()).toBe(201);
  };
  await scan('main', ROUTES(), TESTS());
  await scan(
    'e2e/refunds',
    ROUTES('<route id="e2e-refund-load"><from uri="file:/data/in/refunds?include=RFD_.*\\.csv"/><to uri="log:x"/></route>'),
    TESTS('\n\n@allure.label("route", "e2e-refund-load")\ndef test_refund_file_is_loaded():\n    pass\n'),
  );

  await page.goto('/triggers?branch=main');
  const invoice = page.getByRole('row').filter({ hasText: 'e2e-invoice-load' });
  await expect(invoice).toContainText('INV_.*\\.csv');
  await expect(invoice).toContainText('/data/in/invoices');
  await expect(invoice).toContainText('test_invoice_file_is_loaded');
  await expect(page.getByRole('row').filter({ hasText: 'e2e-nightly-purge' })).toContainText('Not automated');

  await page.goto('/triggers?branch=e2e%2Frefunds&compare=main&status=changes');
  const refund = page.getByRole('row').filter({ hasText: 'e2e-refund-load' });
  await expect(refund).toContainText('New');
  await expect(refund).toContainText('newly automated');
  await expect(page.getByRole('row').filter({ hasText: 'e2e-invoice-load' })).toHaveCount(0);
});
