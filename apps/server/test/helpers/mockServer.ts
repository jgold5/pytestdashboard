import http, { type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface MockReply {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
  /** Take over the raw response (streaming, hanging, socket destroy …). */
  raw?: (res: ServerResponse) => void;
}

export type MockHandler = (req: MockRequest) => MockReply | Promise<MockReply>;

export interface MockServer {
  url: string;
  requests: MockRequest[];
  setHandler(h: MockHandler): void;
  close(): Promise<void>;
}

/** Local HTTP server on 127.0.0.1 with a random port, simulating GitHub/Jira/Xray. */
export async function startMockServer(handler: MockHandler): Promise<MockServer> {
  let current = handler;
  const requests: MockRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text;
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          // keep text
        }
        const mreq: MockRequest = {
          method: req.method ?? 'GET',
          path: url.pathname,
          query: url.searchParams,
          headers: req.headers,
          body,
        };
        requests.push(mreq);
        try {
          const reply = await current(mreq);
          if (reply.raw) return reply.raw(res);
          const payload =
            reply.json !== undefined ? JSON.stringify(reply.json) : (reply.text ?? '');
          res.writeHead(reply.status ?? 200, {
            'content-type': reply.json !== undefined ? 'application/json' : 'text/plain',
            ...reply.headers,
          });
          res.end(payload);
        } catch (err) {
          res.writeHead(599, { 'content-type': 'text/plain' });
          res.end(`mock handler error: ${(err as Error).message}`);
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setHandler: (h) => {
      current = h;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const notFoundReply = (req: MockRequest): MockReply => ({
  status: 404,
  json: { message: `Not Found: ${req.method} ${req.path}` },
});
