import type { FastifyInstance } from 'fastify';
import { BugCreate, BugQuery, BugUpdate, IdParam } from '@ptd/shared';
import type { Deps } from '../deps.js';
import { parseWith } from '../errors.js';
import { createBug, deleteBug, getBug, getBugStats, listBugs, updateBug } from '../domain/bugs.js';

export function bugRoutes(app: FastifyInstance, { db }: Deps): void {
  app.get('/api/bugs', async (req) => {
    const q = parseWith(BugQuery, req.query);
    const { items, total } = listBugs(db, q);
    return { items, total, page: q.page, pageSize: q.pageSize };
  });
  app.get('/api/bugs/stats', async () => getBugStats(db));
  app.post('/api/bugs', async (req, reply) => {
    const input = parseWith(BugCreate, req.body);
    return reply.status(201).send(db.transaction((tx) => createBug(tx, input)));
  });
  app.get('/api/bugs/:id', async (req) => getBug(db, parseWith(IdParam, req.params).id));
  app.patch('/api/bugs/:id', async (req) => {
    const { id } = parseWith(IdParam, req.params);
    const patch = parseWith(BugUpdate, req.body);
    return db.transaction((tx) => updateBug(tx, id, patch));
  });
  app.delete('/api/bugs/:id', async (req, reply) => {
    db.transaction((tx) => deleteBug(tx, parseWith(IdParam, req.params).id));
    return reply.status(204).send();
  });
}
