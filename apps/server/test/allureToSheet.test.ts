/**
 * tools/allure_to_sheet.py (Allure report → Excel/CSV results sheet) is a standalone Python script;
 * its own tests (tools/test_allure_to_sheet.py) run here so CI runs them.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const tools = path.resolve(here, '../../../tools');
const hasPython = spawnSync('python3', ['--version']).status === 0;

describe.skipIf(!hasPython)('allure_to_sheet.py', () => {
  it('turns every form of Allure report into the same sheet', () => {
    const r = spawnSync('python3', ['-m', 'unittest', 'test_allure_to_sheet.py'], { cwd: tools, encoding: 'utf8', timeout: 60_000 });
    expect(r.stderr).toMatch(/\nOK\s*$/);
    expect(r.status).toBe(0);
  });
});
