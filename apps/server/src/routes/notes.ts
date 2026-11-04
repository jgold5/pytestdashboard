import type { FastifyInstance } from 'fastify';
import { IdParam, NoteBulkCreate, NoteCreate, NoteQuery, NoteUpdate } from '@ptd/shared';
import type { Deps } from '../deps.js';
import { parseWith } from '../errors.js';
import { bulkCreateNotes, createNote, deleteNote, listNotes, updateNote } from '../domain/notes.js';

export function noteRoutes(app: FastifyInstance, { db }: Deps): void {
  app.get('/api/notes', async (req) => listNotes(db, parseWith(NoteQuery, req.query)));

  app.post('/api/notes', async (req, reply) => {
    const input = parseWith(NoteCreate, req.body);
    return reply.status(201).send(db.transaction((tx) => createNote(tx, input)));
  });

  app.post('/api/notes/bulk', async (req) => {
    const input = parseWith(NoteBulkCreate, req.body);
    return { created: db.transaction((tx) => bulkCreateNotes(tx, input)) };
  });

  app.patch('/api/notes/:id', async (req) => {
    const { id } = parseWith(IdParam, req.params);
    const patch = parseWith(NoteUpdate, req.body);
    return db.transaction((tx) => updateNote(tx, id, patch));
  });

  app.delete('/api/notes/:id', async (req, reply) => {
    const { id } = parseWith(IdParam, req.params);
    db.transaction((tx) => deleteNote(tx, id));
    return reply.status(204).send();
  });
}
