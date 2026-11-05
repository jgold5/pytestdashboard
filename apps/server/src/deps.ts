import type { AppConfig } from './config.js';
import type { Db } from './db/client.js';
import type { UploadStore } from './import/spreadsheet/store.js';
import type { IntegrationRunner } from './integrations/runner.js';

/** Dependencies handed to route modules. */
export interface Deps {
  config: AppConfig;
  db: Db;
  uploads: UploadStore;
  runner: IntegrationRunner;
}
