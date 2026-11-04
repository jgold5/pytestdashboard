import { defineConfig } from 'tsup';

export default defineConfig({
  // The spreadsheet parser runs in a worker thread from its own file.
  entry: { index: 'src/index.ts', xlsxWorker: 'src/import/spreadsheet/xlsxWorker.mjs' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // The shared contract is TS source in the workspace — bundle it in.
  noExternal: ['@ptd/shared'],
  define: { __PTD_BUNDLED__: 'true' },
});
