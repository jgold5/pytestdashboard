// Used only to diff the Drizzle schema against hand-written migrations during
// development (`pnpm drizzle-kit generate --out <tmp>`); runtime migrations
// live in src/db/migrations.ts.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
