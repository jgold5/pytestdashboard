import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type z } from 'zod';
import type { ApiError } from '@ptd/shared';

/** An error that is safe to show to API clients. */
export class AppError extends Error {
  override name = 'AppError';
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, details);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'conflict', message, details);
export const forbidden = (message = 'Forbidden') => new AppError(403, 'forbidden', message);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'unauthorized', message);

/** Validate with a shared zod schema; ZodErrors become 400 validation_error. */
export function parseWith<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  return schema.parse(input);
}

function zodDetails(err: ZodError): Array<{ path: string; message: string }> {
  return err.issues.slice(0, 50).map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
}

const STATUS_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  406: 'not_acceptable',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
};

const SAFE_FASTIFY_MESSAGES: Record<string, string> = {
  FST_ERR_CTP_BODY_TOO_LARGE: 'Request body is too large',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'Unsupported content type',
  FST_ERR_CTP_INVALID_JSON_BODY: 'Malformed JSON body',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'Empty JSON body',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'Invalid content length',
  FST_REQ_FILE_TOO_LARGE: 'Uploaded file is too large',
  FST_FILES_LIMIT: 'Too many files in upload',
  FST_FIELDS_LIMIT: 'Too many fields in upload',
  FST_PARTS_LIMIT: 'Too many parts in upload',
  FST_PROTO_VIOLATION: 'Malformed request',
  FST_INVALID_MULTIPART_CONTENT_TYPE: 'Expected multipart/form-data',
};

const LIMIT_CODES = new Set(['FST_REQ_FILE_TOO_LARGE', 'FST_FILES_LIMIT', 'FST_FIELDS_LIMIT', 'FST_PARTS_LIMIT']);

export function toApiError(err: unknown): { status: number; body: ApiError } {
  if (err instanceof AppError) {
    const body: ApiError = { error: err.code, message: err.message };
    if (err.details !== undefined) body.details = err.details;
    return { status: err.statusCode, body };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: { error: 'validation_error', message: 'Request validation failed', details: zodDetails(err) },
    };
  }
  const fe = err as Partial<FastifyError> & { code?: string };
  if (typeof fe.code === 'string' && fe.code.startsWith('SQLITE_CONSTRAINT')) {
    return { status: 409, body: { error: 'conflict', message: 'The change conflicts with existing data' } };
  }
  if (typeof fe.code === 'string' && LIMIT_CODES.has(fe.code)) {
    return { status: 413, body: { error: 'payload_too_large', message: SAFE_FASTIFY_MESSAGES[fe.code] ?? 'Too large' } };
  }
  if (fe.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
    return { status: 415, body: { error: 'unsupported_media_type', message: 'Expected multipart/form-data' } };
  }
  const status = typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 600 ? fe.statusCode : 500;
  if (status < 500) {
    const message =
      (fe.code && SAFE_FASTIFY_MESSAGES[fe.code]) ??
      (status === 429 ? 'Too many requests, please slow down' : 'Bad request');
    return { status, body: { error: STATUS_CODES[status] ?? 'bad_request', message } };
  }
  return { status: 500, body: { error: 'internal_error', message: 'Internal server error' } };
}

export function errorHandler(err: unknown, req: FastifyRequest, reply: FastifyReply): void {
  const { status, body } = toApiError(err);
  if (status >= 500) req.log.error({ err }, 'request failed');
  else req.log.info({ code: body.error, status }, 'request rejected');
  void reply.status(status).type('application/json').send(body);
}
