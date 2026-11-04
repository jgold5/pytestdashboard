// Shared e2e settings (test-only secrets; never used outside the throwaway e2e server).
export const E2E = {
  port: Number(process.env.E2E_PORT ?? 3211),
  editorToken: 'e2e-editor-token-0123456789abcdef01234567',
  viewerToken: 'e2e-viewer-token-0123456789abcdef01234567',
  sessionSecret: 'e2e-session-secret-0123456789abcdef012345',
};
export const BASE_URL = `http://127.0.0.1:${E2E.port}`;
