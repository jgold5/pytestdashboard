/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** Dev-only: "1" serves fixture data instead of hitting the backend. Never set in production builds. */
  readonly VITE_MOCK?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
