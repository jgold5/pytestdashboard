import { ApiError as ApiErrorSchema } from '@ptd/shared';
import { toQueryString } from '../lib/url';

/** Error thrown for any non-2xx API response. `message` is safe to show in the UI. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler = () => {
  const here = window.location.pathname + window.location.search;
  if (!window.location.pathname.startsWith('/login')) {
    window.location.assign(`/login?next=${encodeURIComponent(here)}`);
  }
};

/** The app registers a router-aware handler (navigate to /login without a full reload). */
export function setUnauthorizedHandler(fn: UnauthorizedHandler) {
  onUnauthorized = fn;
}

const STATUS_MESSAGES: Record<number, string> = {
  400: 'The request was invalid.',
  401: 'Your session has expired. Please sign in again.',
  403: 'You do not have permission to do that.',
  404: 'Not found.',
  409: 'That conflicts with existing data.',
  413: 'The upload is too large.',
  415: 'Unsupported file type.',
  429: 'Too many requests — please slow down and try again shortly.',
  500: 'Something went wrong on the server.',
  502: 'The server is unreachable.',
  503: 'The server is unavailable.',
};

/** Turn a status + raw body text into an ApiError (never surfaces HTML/stack traces). */
export function parseApiError(status: number, bodyText: string): ApiError {
  let parsed: unknown = undefined;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    /* non-JSON (proxy error page etc.) */
  }
  const r = ApiErrorSchema.safeParse(parsed);
  if (r.success) return new ApiError(status, r.data.error, r.data.message, r.data.details);
  return new ApiError(status, `http_${status}`, STATUS_MESSAGES[status] ?? `Request failed (${status}).`);
}

function isAuthPath(path: string) {
  return path.startsWith('/api/auth/');
}

export interface RequestOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  signal?: AbortSignal;
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) body = opts.body;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(path + toQueryString(opts.query), {
      method,
      headers,
      body,
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'network_error', 'Could not reach the server. Check your connection.');
  }
  if (res.status === 401 && !isAuthPath(path)) onUnauthorized();
  if (!res.ok) throw parseApiError(res.status, await res.text().catch(() => ''));
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string, query?: Record<string, unknown>, signal?: AbortSignal) =>
    request<T>('GET', path, { query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  delete: <T = void>(path: string) => request<T>('DELETE', path),
};

export interface UploadHandle<T> {
  promise: Promise<T>;
  abort: () => void;
}

/**
 * Multipart upload with progress via XMLHttpRequest (fetch has no upload progress).
 * `onProgress` receives 0..1.
 */
export function uploadWithProgress<T>(
  path: string,
  form: FormData,
  onProgress?: (fraction: number) => void,
): UploadHandle<T> {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open('POST', path);
    xhr.withCredentials = false; // same-origin: cookies are sent anyway
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status === 401) onUnauthorized();
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        try {
          resolve((xhr.responseText ? JSON.parse(xhr.responseText) : undefined) as T);
        } catch {
          reject(new ApiError(xhr.status, 'bad_response', 'The server returned an unreadable response.'));
        }
      } else reject(parseApiError(xhr.status, xhr.responseText));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network_error', 'Upload failed — could not reach the server.'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled.'));
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong.';
}
