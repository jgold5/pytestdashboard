import type { FastifyInstance } from 'fastify';
import { IntegrationNameParam, PullRequestQuery } from '@ptd/shared';
import type { Deps } from '../deps.js';
import { parseWith } from '../errors.js';
import { listPullRequests } from '../domain/pullRequests.js';

export function integrationRoutes(app: FastifyInstance, { db, runner }: Deps): void {
  app.get('/api/pull-requests', async (req) => listPullRequests(db, parseWith(PullRequestQuery, req.query)));

  app.get('/api/integrations', async () => runner.list());

  app.post('/api/integrations/:name/sync', async (req, reply) => {
    const { name } = parseWith(IntegrationNameParam, req.params);
    return reply.status(202).send(runner.trigger(name));
  });
}
