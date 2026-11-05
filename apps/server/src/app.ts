import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { LIMITS } from '@ptd/shared';
import { triggerRoutes } from './routes/triggers.js';
import { registerAuth, registerRouteAccess } from './auth/plugin.js';
import type { AppConfig } from './config.js';
import { openDatabase, type DbHandle } from './db/client.js';
import type { Deps } from './deps.js';
import { AppError, errorHandler } from './errors.js';
import { UploadStore } from './import/spreadsheet/store.js';
import type { ZipLimits } from './import/zip.js';
import { createProviders, type IntegrationProvider } from './integrations/registry.js';
import { IntegrationRunner } from './integrations/runner.js';
import { bugRoutes } from './routes/bugs.js';
import { importRoutes } from './routes/imports.js';
import { integrationRoutes } from './routes/integrations.js';
import { noteRoutes } from './routes/notes.js';
import { runRoutes } from './routes/runs.js';
import { systemRoutes } from './routes/system.js';
import { testCaseRoutes } from './routes/testCases.js';

export interface BuildOptions {
  config: AppConfig;
  /** Fastify logger option; default derived from config. */
  logger?: FastifyServerOptions['logger'];
  providers?: IntegrationProvider[];
  /** Global rate limit per IP per minute (default 300). */
  rateLimitMax?: number;
  zipLimits?: ZipLimits;
}

export interface BuiltApp {
  app: FastifyInstance;
  dbHandle: DbHandle;
  runner: IntegrationRunner;
}

export function loggerOptions(config: AppConfig): FastifyServerOptions['logger'] {
  const base = {
    level: config.logLevel,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'headers.authorization',
        'headers.cookie',
        '*.token',
        'token',
        '*.password',
      ],
      censor: '[redacted]',
    },
  };
  if (!config.isProduction && config.nodeEnv !== 'test' && process.stdout.isTTY) {
    return { ...base, transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } };
  }
  return base;
}

export async function buildApp(opts: BuildOptions): Promise<BuiltApp> {
  const { config } = opts;
  const app = Fastify({
    logger: opts.logger ?? loggerOptions(config),
    bodyLimit: 1024 * 1024,
    // hop count → trust only the N closest proxies; list → only those IPs/CIDRs
    trustProxy:
      typeof config.trustProxy === 'number'
        ? (_addr: string, hop: number) => hop < (config.trustProxy as number)
        : config.trustProxy,
  });

  // Must precede every route registration (F-01: access is decided per matched route).
  registerRouteAccess(app);
  // Static SPA files (public, non-/api routes) don't count against the per-IP API
  // rate limit: one page load fetches a dozen hashed chunks, and a team behind one
  // NAT would otherwise lock itself out of the UI (blank page on 429 for a JS chunk).
  app.addHook('onRoute', (route) => {
    const cfg = (route.config ?? {}) as { access?: string; rateLimit?: unknown };
    if (cfg.access === 'public' && !route.url.toLowerCase().startsWith('/api') && cfg.rateLimit === undefined) {
      route.config = { ...cfg, rateLimit: false } as typeof route.config;
    }
  });

  const dbHandle = openDatabase(config.dataDir);
  const runner = new IntegrationRunner(dbHandle.db, opts.providers ?? createProviders(config), app.log, config.secrets);
  const deps: Deps = { config, db: dbHandle.db, uploads: new UploadStore(), runner };

  app.setErrorHandler(errorHandler);

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.httpsOnly ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    hsts: config.httpsOnly ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
    // Browsers ignore COOP on untrustworthy (plain-http, non-localhost) origins and log an error.
    crossOriginOpenerPolicy: config.httpsOnly ? { policy: 'same-origin' } : false,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });

  const explicitOrigins = config.allowedOrigins.filter(
    (o) => config.isProduction || !/^http:\/\/(localhost|127\.0\.0\.1):5173$/.test(o),
  );
  if (explicitOrigins.length > 0) {
    await app.register(cors, { origin: explicitOrigins, credentials: true, methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] });
  }

  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: opts.rateLimitMax ?? 300,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, ctx) =>
      new AppError(429, 'rate_limited', `Too many requests — retry in ${Math.ceil(ctx.ttl / 1000)}s`),
  });
  await app.register(multipart, {
    limits: {
      fileSize: LIMITS.uploadMaxBytes,
      files: LIMITS.uploadMaxFiles,
      fields: 20,
      fieldSize: 10 * 1024,
      parts: LIMITS.uploadMaxFiles + 20,
      headerPairs: 200,
    },
  });

  registerAuth(app, config);

  systemRoutes(app, deps);
  testCaseRoutes(app, deps);
  importRoutes(app, deps);
  runRoutes(app, deps, opts.zipLimits);
  noteRoutes(app, deps);
  integrationRoutes(app, deps);
  bugRoutes(app, deps);
  triggerRoutes(app, deps, opts.zipLimits);

  const indexHtml = path.join(config.webDist, 'index.html');
  const serveSpa = config.isProduction && fs.existsSync(indexHtml);
  if (serveSpa) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      // One GET /* route that resolves files at request time, so assets added after
      // startup (a redeploy that swaps the dist folder in place) are served too.
      // Misses fall through to the not-found handler below (SPA fallback / JSON 404).
      wildcard: true,
      index: ['index.html'], // `/` → index.html (no-cache, see below)
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.header('cache-control', 'public, max-age=31536000, immutable');
        } else {
          res.header('cache-control', 'no-cache');
        }
      },
    });
  } else if (config.isProduction) {
    app.log.warn({ webDist: config.webDist }, 'web build not found — serving API only');
  }

  app.setNotFoundHandler((req, reply) => {
    if (serveSpa && (req.method === 'GET' || req.method === 'HEAD') && !isApiPath(req.url)) {
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return reply.status(404).send({ error: 'not_found', message: 'Route not found' });
  });

  app.addHook('onClose', async () => {
    await runner.stop();
    dbHandle.close();
  });

  return { app, dbHandle, runner };
}

/** Decoded, normalised check so `/%61pi`, `//api`, `/API`, `/./api` etc. never get the SPA. */
export function isApiPath(rawUrl: string): boolean {
  let pathname: string;
  if (rawUrl.startsWith('/')) {
    pathname = rawUrl.split(/[?#]/, 1)[0] ?? '';
  } else {
    try {
      pathname = new URL(rawUrl).pathname; // absolute-form request target
    } catch {
      return true;
    }
  }
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  const normalised = path.posix.normalize(pathname.replace(/\\/g, '/').replace(/\/+/g, '/'));
  return normalised.toLowerCase().startsWith('/api');
}
